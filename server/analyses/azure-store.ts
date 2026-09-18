import { CosmosClient, type Container, type JSONObject, type OperationInput, type SqlParameter } from '@azure/cosmos'
import { BlobServiceClient, type BlockBlobClient, type ContainerClient } from '@azure/storage-blob'
import type { TokenCredential } from '@azure/identity'
import { WORD_DOCUMENT_LIMITS, isWordContentType, storedDocumentContentType } from '../../src/domain/document-formats'
import {
  ANALYSIS_LIMITS, analysisRunCanScore, type AnalysisEntity, type VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import { MAX_MARKDOWN_BYTES } from '../../src/domain/source-files'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { StoreConflictError } from '../store'
import { fetchCosmosPage } from '../cosmos-query'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import type {
  AnalysisBlob, AnalysisBlobStore, AnalysisStore, RealAnalysesConfig, AnalysisTransactionOptions, StoredAnalysisControl,
} from './store'
import {
  ANALYSIS_BLOB_LEASE_SECONDS, ANALYSIS_BLOB_REQUEST_MILLISECONDS,
  analysisControlId, analysisIsRemoved, assertAnalysisRunWritable, parseAnalysisControl, prepareAnalysisGuards,
} from './guards'
import {
  analysisBlobInRun, analysisBytesHash, analysisCancellationNeedsRetry, analysisHash, assertAnalysis, isAnalysisId, isSafeAnalysisBlobName, MAX_ANALYSIS_JSON_BYTES,
  MAX_ANALYSIS_ORIGINAL_BYTES, MAX_ANALYSIS_TRANSACTION_BYTES, parseAnalysisEntity,
} from './validation'

function status(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { code?: unknown; statusCode?: unknown }
  return typeof value.statusCode === 'number' ? value.statusCode : typeof value.code === 'number' ? value.code : undefined
}
function scope(workspaceId: string, id?: string): void {
  assertAnalysis(WORKSPACE_ID_PATTERN.test(workspaceId) &&
    (id === undefined || isAnalysisId(id, 'run') || isAnalysisId(id, 'comparison')), 'Invalid workspace or record identity.')
}
function etag(value: string): void {
  assertAnalysis(typeof value === 'string' && value.trim() && value !== '*' && value.length <= 1024 &&
    !/[,\r\n]/.test(value), 'An exact ETag is required.')
}
function decode(value: unknown, workspaceId?: string, id?: string): VersionedAnalysisEntity {
  assertAnalysis(value && typeof value === 'object' && !Array.isArray(value), 'Stored record must be an object.')
  const data = { ...value } as Record<string, unknown>
  const tag = data._etag
  for (const field of ['_etag', '_rid', '_self', '_attachments', '_ts']) delete data[field]
  const record = parseAnalysisEntity(data)
  assertAnalysis(typeof tag === 'string' && tag && (workspaceId === undefined || record.workspaceId === workspaceId) &&
    (id === undefined || record.id === id), 'Stored ownership or ETag mismatch.')
  return { record, etag: tag }
}
function decodeControl(value: unknown, workspaceId?: string, runId?: string): StoredAnalysisControl {
  assertAnalysis(value && typeof value === 'object' && !Array.isArray(value), 'Stored control must be an object.')
  const data = { ...value } as Record<string, unknown>
  const tag = data._etag
  for (const field of ['_etag', '_rid', '_self', '_attachments', '_ts']) delete data[field]
  const record = parseAnalysisControl(data)
  assertAnalysis(typeof tag === 'string' && tag &&
    (workspaceId === undefined || record.workspaceId === workspaceId) &&
    (runId === undefined || record.runId === runId), 'Stored analysis control ownership or ETag mismatch.')
  return { record, etag: tag }
}

export function assertAnalysisReplacement(previous: AnalysisEntity, next: AnalysisEntity): void {
  assertAnalysis(previous.id === next.id && previous.workspaceId === next.workspaceId && previous.recordType === next.recordType &&
    previous.createdAt === next.createdAt && next.updatedAt >= previous.updatedAt, 'Record identity and creation time are immutable.')
  if (previous.recordType === 'analysis-run' && next.recordType === 'analysis-run') {
    for (const key of ['manifest', 'name', 'createdBy', 'idempotencyKey', 'inputFingerprint'] as const) {
      assertAnalysis(analysisHash(previous[key]) === analysisHash(next[key]), 'Accepted run inputs and manifest are immutable.')
    }
    assertAnalysis(previous.progress.total === next.progress.total &&
      next.initialization.nextComparisonIndex >= previous.initialization.nextComparisonIndex &&
      (!previous.initialization.completedAt || next.initialization.completedAt === previous.initialization.completedAt),
    'Initialization cannot move backwards.')
    if (previous.cancellation && !previous.cancellation.completedAt) {
      assertAnalysis(next.cancellation && next.cancellation.requestedAt === previous.cancellation.requestedAt &&
        next.cancellation.requestedBy === previous.cancellation.requestedBy &&
        next.cancellation.nextComparisonIndex >= previous.cancellation.nextComparisonIndex, 'Unfinished cancellation cannot be cleared.')
    }
  } else if (previous.recordType === 'analysis-comparison' && next.recordType === 'analysis-comparison') {
    assertAnalysis(previous.runId === next.runId && previous.index === next.index &&
      analysisHash(previous.resume) === analysisHash(next.resume) && analysisHash(previous.target) === analysisHash(next.target),
    'Comparison frozen inputs are immutable.')
    assertAnalysis(previous.status !== 'complete' || analysisHash(previous) === analysisHash(next), 'Completed evidence cannot be retried, cancelled, or changed.')
  }
}
function checkReplacement(current: VersionedAnalysisEntity | undefined, record: AnalysisEntity, expected: string): void {
  etag(expected)
  if (!current || current.etag !== expected) throw new StoreConflictError('The analysis changed.')
  assertAnalysisReplacement(current.record, record)
}

export function analysisWorkIsPending(record: AnalysisEntity, now: string): boolean {
  const eligible = record.recordType === 'analysis-run'
    ? !analysisIsRemoved(record.lifecycle) &&
      ((!record.lifecycle?.archivedAt && record.status === 'initializing') || Boolean(record.cancellation && !record.cancellation.completedAt)) &&
      !analysisCancellationNeedsRetry(record)
    : record.status === 'queued' || record.status === 'running'
  return eligible && (!record.nextAttemptAt || record.nextAttemptAt <= now) && (!record.lease || record.lease.expiresAt <= now)
}

export function createAzureAnalysisStore(config: RealAnalysesConfig, credential: TokenCredential): AnalysisStore {
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  return createAnalysisStoreFromContainer(client.database(config.database).container(config.container))
}
export function createAnalysisStoreFromContainer(container: Pick<Container, 'item' | 'items'>): AnalysisStore {
  async function batch(workspaceId: string, operations: OperationInput[], controls: NonNullable<AnalysisTransactionOptions['controls']>) {
    const input: OperationInput[] = [
      ...controls.map<OperationInput>(control => control.etag
        ? { operationType: 'Replace', id: control.record.id, resourceBody: control.record as unknown as JSONObject, ifMatch: control.etag }
        : { operationType: 'Create', resourceBody: control.record as unknown as JSONObject }),
      ...operations,
    ]
    assertAnalysis(input.length <= ANALYSIS_LIMITS.initializationChunkSize + 3 &&
      Buffer.byteLength(JSON.stringify(input)) <= MAX_ANALYSIS_TRANSACTION_BYTES, 'Analysis batch exceeds the Cosmos payload or operation budget.')
    try {
      assertWorkspaceMutationLease(workspaceId)
      const response = await container.items.batch(input, workspaceId)
      const results = response.result ?? []
      if (results.length !== input.length || results.some(result => result.statusCode < 200 || result.statusCode >= 300) ||
        (response.code !== undefined && (response.code < 200 || response.code >= 300))) {
        const code = results.find(result => result.statusCode >= 400 && result.statusCode !== 424)?.statusCode ?? response.code
        if ([404, 409, 412, 424].includes(code ?? 0)) throw new StoreConflictError('The analysis changed before guarded publication.')
        throw new Error('Cosmos analysis transaction did not succeed.')
      }
    } catch (error) {
      if ([404, 409, 412, 424].includes(status(error) ?? 0)) throw new StoreConflictError('The analysis changed before guarded publication.')
      throw error
    }
  }
  const store: AnalysisStore = {
    async get(workspaceId, id) {
      scope(workspaceId, id)
      try {
        const response = await container.item(id, workspaceId).read()
        if (response.statusCode === 404 || !response.resource) return undefined
        return decode(response.resource, workspaceId, id)
      } catch (error) {
        if (status(error) === 404) return undefined
        throw error
      }
    },
    async list<K extends AnalysisEntity['recordType']>(workspaceId: string, options: import('./store').AnalysisListOptions<K>) {
      scope(workspaceId, options.runId)
      const limit = options.limit ?? 50
      assertAnalysis(Number.isInteger(limit) && limit > 0 && limit <= 100 &&
        ['analysis-run', 'analysis-comparison'].includes(options.recordType) &&
        (options.runId === undefined || (options.recordType === 'analysis-comparison' && isAnalysisId(options.runId, 'run'))) &&
        (options.continuationToken === undefined || (typeof options.continuationToken === 'string' &&
          options.continuationToken.length > 0 && options.continuationToken.length <= 12 * 1024)), 'Invalid analysis query options.')
      const allowed = options.recordType === 'analysis-run'
        ? ['initializing', 'queued', 'running', 'complete', 'partial', 'failed', 'cancelled']
        : ['queued', 'running', 'complete', 'failed', 'cancelled']
      assertAnalysis(options.status === undefined || allowed.includes(options.status), 'Invalid status filter.')
      const filters = ['c.workspaceId = @workspaceId', 'c.recordType = @recordType']
      const parameters: SqlParameter[] = [{ name: '@workspaceId', value: workspaceId }, { name: '@recordType', value: options.recordType }]
      for (const key of ['runId', 'status'] as const) if (options[key] !== undefined) {
        filters.push(`c.${key} = @${key}`)
        parameters.push({ name: `@${key}`, value: options[key] })
      }
      const response = await fetchCosmosPage(container.items.query({
        query: `SELECT * FROM c WHERE ${filters.join(' AND ')} ORDER BY c.${options.recordType === 'analysis-comparison' ? 'index ASC' : 'createdAt DESC'}`,
        parameters,
      }, { partitionKey: workspaceId, maxItemCount: limit, continuationToken: options.continuationToken }))
      const items = response.resources.map(value => decode(value, workspaceId))
      assertAnalysis(items.length <= limit && items.every(({ record }) => record.recordType === options.recordType &&
        (options.runId === undefined || (record.recordType === 'analysis-comparison' && record.runId === options.runId)) &&
        (options.status === undefined || record.status === options.status)), 'Analysis query escaped its scope.')
      return {
        items: items as VersionedAnalysisEntity<Extract<AnalysisEntity, { recordType: K }>>[],
        ...(response.continuationToken ? { continuationToken: response.continuationToken } : {}),
      }
    },
    async create<T extends AnalysisEntity>(value: T) {
      const record = parseAnalysisEntity(value)
      assertAnalysis(record.recordType === 'analysis-run', 'Comparisons must be created with a run publication fence.')
      const controls = await prepareAnalysisGuards(store, record.workspaceId, [{ kind: 'create', record }])
      const existing = await store.get(record.workspaceId, record.id)
      if (existing) return { created: false, value: existing as VersionedAnalysisEntity<T> }
      try {
        await batch(record.workspaceId, [{ operationType: 'Create', resourceBody: record as unknown as JSONObject }], controls)
        const current = await store.get(record.workspaceId, record.id)
        assertAnalysis(current, 'Cosmos did not return the created run.')
        return { created: true, value: current as VersionedAnalysisEntity<T> }
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error
        const winner = await store.get(record.workspaceId, record.id)
        if (!winner) throw error
        assertAnalysis(winner.record.recordType === 'analysis-run', 'Conflicting run identity is invalid.')
        assertAnalysisRunWritable(winner.record)
        return { created: false, value: winner as VersionedAnalysisEntity<T> }
      }
    },
    async replace<T extends AnalysisEntity>(value: T, expected: string) {
      const record = parseAnalysisEntity(value)
      assertAnalysis(record.recordType === 'analysis-run', 'Comparison changes require an atomic run publication fence.')
      const current = await store.get(record.workspaceId, record.id)
      checkReplacement(current, record, expected)
      assertAnalysis(current?.record.recordType === 'analysis-run' &&
        analysisHash(current.record.progress) === analysisHash(record.progress) &&
        analysisHash(current.record.initialization) === analysisHash(record.initialization),
      'Run progress must change atomically with its comparisons.')
      const controls = await prepareAnalysisGuards(store, record.workspaceId, [{ kind: 'replace', record, etag: expected }])
      await batch(record.workspaceId, [{
        operationType: 'Replace', id: record.id, resourceBody: record as unknown as JSONObject, ifMatch: expected,
      }], controls)
      const result = await store.get(record.workspaceId, record.id)
      assertAnalysis(result, 'Cosmos did not return the replaced run.')
      return result as VersionedAnalysisEntity<T>
    },
    async transact(workspaceId, operations, options = {}) {
      scope(workspaceId)
      assertAnalysis((operations.length > 0 || options.controls?.length) && operations.length <= ANALYSIS_LIMITS.initializationChunkSize + 1 &&
        new Set(operations.map(item => item.record.id)).size === operations.length, 'Analysis transactions require at most 25 unique pairs and a run fence.')
      const validated = operations.map(operation => {
        assertAnalysis(operation.kind === 'create' || operation.kind === 'replace' ||
          (options.lifecycle && operation.kind === 'delete'), 'Unsupported transaction operation.')
        const record = parseAnalysisEntity(operation.record)
        assertAnalysis(record.workspaceId === workspaceId, 'Transaction cannot cross workspace partitions.')
        if (operation.kind !== 'create') etag(operation.etag)
        return { ...operation, record }
      })
      assertAnalysis(Buffer.byteLength(JSON.stringify(validated)) <= MAX_ANALYSIS_TRANSACTION_BYTES, 'Analysis batch exceeds the Cosmos payload budget.')
      if (!validated.length) {
        const controls = await prepareAnalysisGuards(store, workspaceId, [], options)
        await batch(workspaceId, [], controls)
        return
      }
      const run = validated.find(item => item.record.recordType === 'analysis-run')
      assertAnalysis(run && (run.kind === 'replace' || (options.lifecycle && run.kind === 'delete' && validated.length === 1)) &&
        validated.filter(item => item.record.recordType === 'analysis-run').length === 1 &&
        validated.every(item => item.record.recordType === 'analysis-run' || item.record.runId === run.record.id),
      'Every comparison transaction requires exactly one matching run ETag fence.')
      const previous = new Map<string, AnalysisEntity>()
      await Promise.all(validated.map(async operation => {
        if (operation.kind !== 'create') {
          const current = await store.get(workspaceId, operation.record.id)
          checkReplacement(current, operation.record, operation.etag)
          if (operation.kind === 'delete') assertAnalysis(analysisHash(current!.record) === analysisHash(operation.record),
            'Deletion requires the exact observed analysis record.')
          previous.set(operation.record.id, current!.record)
        }
      }))
      const oldRun = previous.get(run.record.id)
      assertAnalysis(oldRun?.recordType === 'analysis-run' && run.record.recordType === 'analysis-run', 'Missing run publication fence.')
      const progress = { ...oldRun.progress }
      const createdIndexes: number[] = []
      for (const operation of validated) {
        if (operation.record.recordType !== 'analysis-comparison') continue
        if (operation.kind === 'delete') continue
        const next = operation.record
        const old = previous.get(next.id)
        if (old?.recordType === 'analysis-comparison') {
          progress[old.status]--
          if (old.status === 'complete') progress[old.resultSummary!.overall.status === 'available' ? 'scored' : 'unscored']--
        } else {
          assertAnalysis(operation.kind === 'create', 'Missing comparison for replacement.')
          progress.initialized++
          createdIndexes.push(next.index)
        }
        progress[next.status]++
        if (next.status === 'complete') progress[next.resultSummary!.overall.status === 'available' ? 'scored' : 'unscored']++
        assertAnalysis(!oldRun.cancellation || next.status === 'cancelled' ||
          (oldRun.cancellation.completedAt && !run.record.cancellation && next.status === 'queued'),
        'Cancelled run cannot publish scoring work.')
      }
      createdIndexes.sort((a, b) => a - b)
      assertAnalysis(createdIndexes.every((index, offset) => index === oldRun.progress.initialized + offset) &&
        analysisHash(progress) === analysisHash(run.record.progress), 'Run progress does not match its atomic comparison transitions.')
      if (validated.some(item => item.kind === 'delete')) assertAnalysis(validated.every(item =>
        item.kind === 'delete' || (item.record.recordType === 'analysis-run' && item.kind === 'replace')),
      'Deletion cannot mix comparison publication with cleanup.')
      const controls = await prepareAnalysisGuards(store, workspaceId, validated, options)
      if (run.kind === 'delete') {
        assertAnalysis(controls.some(item => item.record.runId === run.record.id && item.record.state === 'deleted'),
          'Run deletion requires a permanent tombstone.')
        const runControl = controls.find(item => item.record.runId === run.record.id)!
        assertAnalysis(!Object.values(runControl.record.writers ?? {}).some(writer => Date.parse(writer.expiresAt) > Date.now()),
          'Analysis source writers have not drained.')
        let token: string | undefined
        const seen = new Set<string>()
        do {
          const page = await store.list(workspaceId, { recordType: 'analysis-comparison', runId: run.record.id, limit: 1, continuationToken: token })
          assertAnalysis(!page.items.length, 'Run still owns comparisons.')
          token = page.continuationToken
          if (token) { assertAnalysis(!seen.has(token), 'Comparison cleanup pagination did not advance.'); seen.add(token) }
        } while (token)
      }
      const pending: OperationInput[] = validated.map(operation => operation.kind === 'create'
        ? { operationType: 'Create', resourceBody: operation.record as unknown as JSONObject }
        : operation.kind === 'delete' ? { operationType: 'Delete', id: operation.record.id, ifMatch: operation.etag }
        : { operationType: 'Replace', id: operation.record.id, resourceBody: operation.record as unknown as JSONObject, ifMatch: operation.etag })
      await batch(workspaceId, pending, controls)
    },
    async getControl(workspaceId, runId) {
      scope(workspaceId, runId)
      try {
        const response = await container.item(analysisControlId(runId), workspaceId).read()
        if (response.statusCode === 404 || !response.resource) return undefined
        const value = decodeControl(response.resource, workspaceId, runId)
        assertAnalysis(value.record.runId === runId, 'Analysis lifecycle scope mismatch.')
        return value
      } catch (error) { if (status(error) === 404) return undefined; throw error }
    },
    async listControls(workspaceId, continuationToken) {
      scope(workspaceId)
      assertAnalysis(continuationToken === undefined || (typeof continuationToken === 'string' &&
        continuationToken.length > 0 && continuationToken.length <= 12 * 1024), 'Invalid lifecycle page token.')
      const page = await fetchCosmosPage(container.items.query({
        query: 'SELECT * FROM c WHERE c.workspaceId = @workspaceId AND c.recordType = @recordType',
        parameters: [{ name: '@workspaceId', value: workspaceId }, { name: '@recordType', value: 'analysis-lifecycle' }],
      }, { partitionKey: workspaceId, maxItemCount: 100, continuationToken }))
      return { items: page.resources.map(value => decodeControl(value, workspaceId)),
        ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}) }
    },
    async pendingLifecycleWorkspaces(limit) {
      assertAnalysis(Number.isInteger(limit) && limit > 0 && limit <= 100, 'Invalid lifecycle discovery limit.')
      const workspaces = new Set<string>()
      const seen = new Set<string>()
      let continuationToken: string | undefined
      do {
        const page = await fetchCosmosPage(container.items.query({
          query: `SELECT * FROM c WHERE c.recordType = @recordType AND
            (c.state = 'deleting' OR (IS_DEFINED(c.operation) AND c.operation.status != 'complete'))`,
          parameters: [{ name: '@recordType', value: 'analysis-lifecycle' }],
        }, { maxItemCount: 100, continuationToken }))
        for (const item of page.resources) {
          const { record } = decodeControl(item)
          if (record.state === 'deleting' || (record.operation && record.operation.status !== 'complete')) workspaces.add(record.workspaceId)
          if (workspaces.size === limit) return [...workspaces]
        }
        continuationToken = page.continuationToken
        if (continuationToken) { assertAnalysis(!seen.has(continuationToken), 'Lifecycle discovery did not advance.'); seen.add(continuationToken) }
      } while (continuationToken)
      return [...workspaces]
    },
    async listPending(now, limit) {
      assertAnalysis(Number.isFinite(Date.parse(now)) && Number.isInteger(limit) && limit > 0 && limit <= 100, 'Invalid pending work query.')
      const records: VersionedAnalysisEntity[] = []
      const parents = new Map<string, boolean>()
      const workspaces = new Map<string, string>()
      // Initialize/cancel first; blocked children must not consume the ready-work limit.
      for (const recordType of ['analysis-run', 'analysis-comparison'] as const) {
        const eligible = recordType === 'analysis-run'
          ? `(c.status = 'initializing' OR (IS_DEFINED(c.cancellation) AND NOT IS_DEFINED(c.cancellation.completedAt)
              AND (NOT IS_DEFINED(c.error) OR (c.error.retryable = true AND c.attempts < @maxAttempts))))`
          : "(c.status = 'queued' OR c.status = 'running')"
        const query = {
          query: `SELECT * FROM c WHERE c.recordType = @recordType AND ${eligible}
            ${recordType === 'analysis-run' ? `AND NOT IS_DEFINED(c.lifecycle.deletingAt) AND NOT IS_DEFINED(c.lifecycle.deletedAt)
              AND (NOT IS_DEFINED(c.lifecycle.archivedAt) OR IS_DEFINED(c.cancellation))` : ''}
            AND (NOT IS_DEFINED(c.nextAttemptAt) OR c.nextAttemptAt <= @now)
            AND (NOT IS_DEFINED(c.lease) OR c.lease.expiresAt <= @now)
            ORDER BY c.createdAt ASC`,
          parameters: [
            { name: '@recordType', value: recordType }, { name: '@now', value: now },
            ...(recordType === 'analysis-run' ? [{ name: '@maxAttempts', value: ANALYSIS_LIMITS.maxAutomaticAttempts }] : []),
          ],
        }
        const seenTokens = new Set<string>()
        let continuationToken: string | undefined
        do {
          const response = await fetchCosmosPage(container.items.query(query, { maxItemCount: 100, continuationToken }))
          const page = response.resources.map(value => decode(value))
          assertAnalysis(page.length <= 100 && page.every(item => item.record.recordType === recordType &&
            analysisWorkIsPending(item.record, now)), 'Pending query returned ineligible work.')
          for (const item of page) {
            const record = item.record
            if (!workspaces.has(record.workspaceId)) {
              workspaces.set(record.workspaceId, (await store.getControl(record.workspaceId))?.record.state ?? 'active')
            }
            const state = workspaces.get(record.workspaceId)
            if (state !== 'active' && !(state === 'archived' && record.recordType === 'analysis-run' &&
              record.cancellation && !record.cancellation.completedAt)) continue
            if (record.recordType === 'analysis-comparison') {
              const key = JSON.stringify([record.workspaceId, record.runId])
              if (!parents.has(key)) {
                const parent = await store.get(record.workspaceId, record.runId)
                assertAnalysis(!parent || parent.record.recordType === 'analysis-run', 'Pending comparison has no valid parent run.')
                parents.set(key, Boolean(parent && parent.record.recordType === 'analysis-run' && analysisRunCanScore(parent.record)))
              }
              if (!parents.get(key)) continue
            }
            records.push(item)
            if (records.length === limit) return records
          }
          continuationToken = response.continuationToken
          if (continuationToken) {
            assertAnalysis(!seenTokens.has(continuationToken), 'Pending query repeated a continuation token.')
            seenTokens.add(continuationToken)
          }
        } while (continuationToken)
      }
      return records
    },
  }
  return store
}

interface AnalysisBlobContainer {
  getBlockBlobClient(name: string): {
    download(): Promise<Pick<Awaited<ReturnType<BlockBlobClient['download']>>, 'readableStreamBody' | 'contentType' | 'contentLength' | 'etag' | 'metadata'>>
    upload(...args: Parameters<BlockBlobClient['upload']>): Promise<Pick<Awaited<ReturnType<BlockBlobClient['upload']>>, 'etag'>>
    getProperties?: BlockBlobClient['getProperties']
    getBlobLeaseClient?: BlockBlobClient['getBlobLeaseClient']
    deleteIfExists?: BlockBlobClient['deleteIfExists']
  }
  listBlobsFlat?: ContainerClient['listBlobsFlat']
}
function mime(name: string): string {
  const contentType = storedDocumentContentType(name)
  assertAnalysis(contentType, 'Unsupported analysis blob content type.')
  return contentType
}
function maximum(name: string): number {
  const contentType = mime(name)
  if (isWordContentType(contentType)) return WORD_DOCUMENT_LIMITS.maxFileBytes
  if (contentType === 'text/markdown') return MAX_MARKDOWN_BYTES
  if (contentType === 'application/pdf') return 10 * 1024 * 1024
  if (contentType === 'text/html') return MAX_ANALYSIS_ORIGINAL_BYTES
  assertAnalysis(contentType === 'application/json', 'Unsupported analysis blob content type.')
  return MAX_ANALYSIS_JSON_BYTES
}
async function readBounded(stream: NodeJS.ReadableStream, length: number | undefined, max: number): Promise<Uint8Array> {
  if (length !== undefined && length > max) {
    if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy()
    throw new Error('Analysis blob exceeds its bounded size.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > max) throw new Error('Analysis blob exceeds its bounded size.')
    chunks.push(bytes)
  }
  assertAnalysis(size > 0 && (length === undefined || size === length), 'Analysis blob is empty or truncated.')
  return Buffer.concat(chunks, size)
}
export function createAzureAnalysisBlobStore(config: RealAnalysesConfig, credential: TokenCredential): AnalysisBlobStore {
  return createAnalysisBlobStoreFromContainer(new BlobServiceClient(config.storageAccountUrl, credential, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: ANALYSIS_BLOB_REQUEST_MILLISECONDS },
  }).getContainerClient(config.blobContainer))
}
export function createAnalysisBlobStoreFromContainer(container: AnalysisBlobContainer): AnalysisBlobStore {
  async function read(name: string): Promise<AnalysisBlob | undefined> {
    assertAnalysis(isSafeAnalysisBlobName(name), 'Invalid analysis blob name.')
    try {
      const response = await container.getBlockBlobClient(name).download()
      if (response.metadata?.scorepreparing === 'true') {
        const stream = response.readableStreamBody
        if (stream && 'destroy' in stream && typeof stream.destroy === 'function') stream.destroy()
        return undefined
      }
      assertAnalysis(response.readableStreamBody && response.etag && typeof response.contentType === 'string' &&
        response.contentType === mime(name), 'Invalid analysis blob content metadata.')
      const bytes = await readBounded(response.readableStreamBody, response.contentLength, maximum(name))
      return { bytes, contentType: response.contentType, sha256: analysisBytesHash(bytes), etag: response.etag }
    } catch (error) {
      if (status(error) === 404) return undefined
      throw error
    }
  }
  return {
    read,
    async putImmutable(name, bytes, contentType) {
      assertAnalysis(isSafeAnalysisBlobName(name) && contentType === mime(name) && bytes.byteLength > 0 &&
        bytes.byteLength <= maximum(name), 'Invalid immutable analysis blob.')
      const body = Buffer.from(bytes)
      try {
        assertWorkspaceMutationLease(name.split('/')[0])
        const response = await container.getBlockBlobClient(name).upload(body, body.byteLength, {
          conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'private, no-store' },
        })
        assertAnalysis(response.etag, 'Blob upload returned no ETag.')
        return { created: true, blob: { bytes: body, contentType, sha256: analysisBytesHash(body), etag: response.etag } }
      } catch (error) {
        if (![409, 412].includes(status(error) ?? 0)) throw error
        const blob = await read(name)
        assertAnalysis(blob, 'Conflicting immutable blob could not be read.')
        return { created: false, blob }
      }
    },
    async putFenced(name, bytes, contentType, fence) {
      assertAnalysis(analysisBlobInRun(name, fence.workspaceId, fence.runId) && fence.blobName === name &&
        isAnalysisId(`analysis-run-${fence.id}`, 'run') && contentType === mime(name) &&
        bytes.byteLength > 0 && bytes.byteLength <= maximum(name), 'Invalid fenced analysis blob.')
      const client = container.getBlockBlobClient(name)
      assertAnalysis(client.getBlobLeaseClient && client.getProperties, 'Analysis Blob lease fencing is unavailable.')
      const assertTime = () => {
        fence.signal?.throwIfAborted()
        if (Date.parse(fence.expiresAt) - Date.now() <= ANALYSIS_BLOB_LEASE_SECONDS * 1000 + 5_000) {
          throw new StoreConflictError('The analysis Blob writer reservation expired before upload.')
        }
      }
      assertTime()
      await fence.assertActive()
      assertTime()
      const timeout = AbortSignal.timeout(ANALYSIS_BLOB_REQUEST_MILLISECONDS)
      const signal = fence.signal ? AbortSignal.any([timeout, fence.signal]) : timeout
      try {
        assertWorkspaceMutationLease(fence.workspaceId)
        await client.upload(Buffer.alloc(0), 0, {
          conditions: { ifNoneMatch: '*' }, metadata: { scorepreparing: 'true' },
          blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' }, abortSignal: signal,
        })
      } catch (error) {
        if (![409, 412].includes(status(error) ?? 0)) throw error
        const existing = await read(name)
        if (existing) { await fence.assertActive(); return { created: false, blob: existing } }
      }
      assertTime()
      const lease = client.getBlobLeaseClient(fence.id)
      await lease.acquireLease(ANALYSIS_BLOB_LEASE_SECONDS, { abortSignal: signal })
      try {
        await fence.assertActive()
        assertTime()
        const properties = await client.getProperties({ abortSignal: signal })
        if (properties.metadata?.scorepreparing !== 'true') {
          const existing = await read(name)
          assertAnalysis(existing, 'The immutable analysis source could not be read.')
          await fence.assertActive()
          return { created: false, blob: existing }
        }
        assertAnalysis(properties.etag, 'Analysis placeholder has no exact ETag.')
        assertTime()
        assertWorkspaceMutationLease(fence.workspaceId)
        const body = Buffer.from(bytes)
        const response = await client.upload(body, body.byteLength, {
          conditions: { ifMatch: properties.etag, leaseId: lease.leaseId }, metadata: {},
          blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'private, no-store' }, abortSignal: signal,
        })
        assertAnalysis(response.etag, 'Blob upload returned no ETag.')
        await fence.assertActive()
        return { created: true, blob: { bytes: body, contentType, sha256: analysisBytesHash(body), etag: response.etag } }
      } finally {
        await lease.releaseLease({ abortSignal: AbortSignal.timeout(ANALYSIS_BLOB_REQUEST_MILLISECONDS) }).catch(() => undefined)
      }
    },
    async list(workspaceId, runId, continuationToken) {
      scope(workspaceId, runId)
      assertAnalysis(runId === undefined || isAnalysisId(runId, 'run'), 'Invalid analysis blob list run.')
      assertAnalysis(continuationToken === undefined || (typeof continuationToken === 'string' &&
        continuationToken.length > 0 && continuationToken.length <= 16 * 1024), 'Invalid analysis Blob continuation token.')
      assertAnalysis(container.listBlobsFlat, 'Analysis Blob enumeration is unavailable.')
      const prefix = runId ? `${workspaceId}/${runId}/` : `${workspaceId}/`
      const page = await container.listBlobsFlat({ prefix }).byPage({ maxPageSize: 100, continuationToken }).next()
      if (page.done) return { items: [] }
      const items = page.value.segment.blobItems.map(item => {
        assertAnalysis(isSafeAnalysisBlobName(item.name) && item.name.startsWith(prefix) && item.properties.etag,
          'Analysis Blob enumeration crossed its ownership or ETag boundary.')
        etag(item.properties.etag)
        return { name: item.name, etag: item.properties.etag }
      })
      return { items, ...(page.value.continuationToken ? { continuationToken: page.value.continuationToken } : {}) }
    },
    async delete(workspaceId, runId, name, expected) {
      assertAnalysis(analysisBlobInRun(name, workspaceId, runId), 'Invalid analysis blob deletion scope.')
      etag(expected)
      const client = container.getBlockBlobClient(name)
      assertAnalysis(client.getBlobLeaseClient && client.deleteIfExists, 'Analysis Blob deletion fencing is unavailable.')
      assertWorkspaceMutationLease(workspaceId)
      try {
        await client.getBlobLeaseClient().breakLease(0, { abortSignal: AbortSignal.timeout(ANALYSIS_BLOB_REQUEST_MILLISECONDS) })
      } catch (error) { if (![404, 409].includes(status(error) ?? 0)) throw error }
      assertWorkspaceMutationLease(workspaceId)
      await client.deleteIfExists({
        conditions: { ifMatch: expected }, deleteSnapshots: 'include',
        abortSignal: AbortSignal.timeout(ANALYSIS_BLOB_REQUEST_MILLISECONDS),
      })
    },
  }
}
