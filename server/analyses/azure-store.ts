import { CosmosClient, type Container, type JSONObject, type OperationInput, type SqlParameter } from '@azure/cosmos'
import { BlobServiceClient, type BlockBlobClient } from '@azure/storage-blob'
import type { TokenCredential } from '@azure/identity'
import { WORD_DOCUMENT_LIMITS, isWordContentType, storedDocumentContentType } from '../../src/domain/document-formats'
import {
  ANALYSIS_LIMITS, analysisRunCanScore, type AnalysisEntity, type VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { StoreConflictError } from '../store'
import { fetchCosmosPage } from '../cosmos-query'
import type { AnalysisBlob, AnalysisBlobStore, AnalysisStore, RealAnalysesConfig } from './store'
import {
  analysisBytesHash, analysisCancellationNeedsRetry, analysisHash, assertAnalysis, isAnalysisId, isSafeAnalysisBlobName, MAX_ANALYSIS_JSON_BYTES,
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
    ? (record.status === 'initializing' || Boolean(record.cancellation && !record.cancellation.completedAt)) &&
      !analysisCancellationNeedsRetry(record)
    : record.status === 'queued' || record.status === 'running'
  return eligible && (!record.nextAttemptAt || record.nextAttemptAt <= now) && (!record.lease || record.lease.expiresAt <= now)
}

export function createAzureAnalysisStore(config: RealAnalysesConfig, credential: TokenCredential): AnalysisStore {
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  return createAnalysisStoreFromContainer(client.database(config.database).container(config.container))
}
export function createAnalysisStoreFromContainer(container: Pick<Container, 'item' | 'items'>): AnalysisStore {
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
      try {
        const response = await container.items.create(record)
        assertAnalysis(response.resource, 'Cosmos did not return the created run.')
        return { created: true, value: decode(response.resource, record.workspaceId, record.id) as VersionedAnalysisEntity<T> }
      } catch (error) {
        if (status(error) !== 409) throw error
        const existing = await store.get(record.workspaceId, record.id)
        assertAnalysis(existing, 'Conflicting run could not be read.')
        return { created: false, value: existing as VersionedAnalysisEntity<T> }
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
      try {
        const response = await container.item(record.id, record.workspaceId).replace(record, {
          accessCondition: { type: 'IfMatch', condition: expected },
        })
        assertAnalysis(response.resource, 'Cosmos did not return the replaced run.')
        return decode(response.resource, record.workspaceId, record.id) as VersionedAnalysisEntity<T>
      } catch (error) {
        if ([404, 409, 412].includes(status(error) ?? 0)) throw new StoreConflictError('The analysis changed.')
        throw error
      }
    },
    async transact(workspaceId, operations) {
      scope(workspaceId)
      assertAnalysis(operations.length > 0 && operations.length <= ANALYSIS_LIMITS.initializationChunkSize + 1 &&
        new Set(operations.map(item => item.record.id)).size === operations.length, 'Analysis transactions require at most 25 unique pairs and a run fence.')
      const validated = operations.map(operation => {
        assertAnalysis(operation.kind === 'create' || operation.kind === 'replace', 'Unsupported transaction operation.')
        const record = parseAnalysisEntity(operation.record)
        assertAnalysis(record.workspaceId === workspaceId, 'Transaction cannot cross workspace partitions.')
        if (operation.kind === 'replace') etag(operation.etag)
        return { ...operation, record }
      })
      assertAnalysis(Buffer.byteLength(JSON.stringify(validated)) <= MAX_ANALYSIS_TRANSACTION_BYTES, 'Analysis batch exceeds the Cosmos payload budget.')
      const run = validated.find(item => item.record.recordType === 'analysis-run')
      assertAnalysis(run?.kind === 'replace' && validated.filter(item => item.record.recordType === 'analysis-run').length === 1 &&
        validated.every(item => item.record.recordType === 'analysis-run' || item.record.runId === run.record.id),
      'Every comparison transaction requires exactly one matching run ETag fence.')
      const previous = new Map<string, AnalysisEntity>()
      await Promise.all(validated.map(async operation => {
        if (operation.kind === 'replace') {
          const current = await store.get(workspaceId, operation.record.id)
          checkReplacement(current, operation.record, operation.etag)
          previous.set(operation.record.id, current!.record)
        }
      }))
      const oldRun = previous.get(run.record.id)
      assertAnalysis(oldRun?.recordType === 'analysis-run' && run.record.recordType === 'analysis-run', 'Missing run publication fence.')
      const progress = { ...oldRun.progress }
      const createdIndexes: number[] = []
      for (const operation of validated) {
        if (operation.record.recordType !== 'analysis-comparison') continue
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
      const batch: OperationInput[] = validated.map(operation => operation.kind === 'create'
        ? { operationType: 'Create', resourceBody: operation.record as unknown as JSONObject }
        : { operationType: 'Replace', id: operation.record.id, resourceBody: operation.record as unknown as JSONObject, ifMatch: operation.etag })
      try {
        const response = await container.items.batch(batch, workspaceId)
        const results = response.result ?? []
        if (results.length !== batch.length || results.some(result => result.statusCode < 200 || result.statusCode >= 300) ||
          (response.code !== undefined && (response.code < 200 || response.code >= 300))) {
          const code = results.find(result => result.statusCode >= 400 && result.statusCode !== 424)?.statusCode ?? response.code
          if ([404, 409, 412, 424].includes(code ?? 0)) throw new StoreConflictError('The analysis changed before publication.')
          throw new Error('Cosmos analysis transaction did not succeed.')
        }
      } catch (error) {
        if ([404, 409, 412, 424].includes(status(error) ?? 0)) throw new StoreConflictError('The analysis changed before publication.')
        throw error
      }
    },
    async listPending(now, limit) {
      assertAnalysis(Number.isFinite(Date.parse(now)) && Number.isInteger(limit) && limit > 0 && limit <= 100, 'Invalid pending work query.')
      const records: VersionedAnalysisEntity[] = []
      const parents = new Map<string, boolean>()
      // Initialize/cancel first; blocked children must not consume the ready-work limit.
      for (const recordType of ['analysis-run', 'analysis-comparison'] as const) {
        const eligible = recordType === 'analysis-run'
          ? `(c.status = 'initializing' OR (IS_DEFINED(c.cancellation) AND NOT IS_DEFINED(c.cancellation.completedAt)
              AND (NOT IS_DEFINED(c.error) OR (c.error.retryable = true AND c.attempts < @maxAttempts))))`
          : "(c.status = 'queued' OR c.status = 'running')"
        const query = {
          query: `SELECT * FROM c WHERE c.recordType = @recordType AND ${eligible}
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
            if (record.recordType === 'analysis-comparison') {
              const key = JSON.stringify([record.workspaceId, record.runId])
              if (!parents.has(key)) {
                const parent = await store.get(record.workspaceId, record.runId)
                assertAnalysis(parent?.record.recordType === 'analysis-run', 'Pending comparison has no valid parent run.')
                parents.set(key, analysisRunCanScore(parent.record))
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
    download(): Promise<Pick<Awaited<ReturnType<BlockBlobClient['download']>>, 'readableStreamBody' | 'contentType' | 'contentLength' | 'etag'>>
    upload(...args: Parameters<BlockBlobClient['upload']>): Promise<Pick<Awaited<ReturnType<BlockBlobClient['upload']>>, 'etag'>>
  }
}
function mime(name: string): string {
  const contentType = storedDocumentContentType(name)
  assertAnalysis(contentType, 'Unsupported analysis blob content type.')
  return contentType
}
function maximum(name: string): number {
  const contentType = mime(name)
  if (isWordContentType(contentType)) return WORD_DOCUMENT_LIMITS.maxFileBytes
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
  return createAnalysisBlobStoreFromContainer(new BlobServiceClient(config.storageAccountUrl, credential).getContainerClient(config.blobContainer))
}
export function createAnalysisBlobStoreFromContainer(container: AnalysisBlobContainer): AnalysisBlobStore {
  async function read(name: string): Promise<AnalysisBlob | undefined> {
    assertAnalysis(isSafeAnalysisBlobName(name), 'Invalid analysis blob name.')
    try {
      const response = await container.getBlockBlobClient(name).download()
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
        const response = await container.getBlockBlobClient(name).upload(body, body.byteLength, {
          conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: contentType },
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
  }
}
