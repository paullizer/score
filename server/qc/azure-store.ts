import { randomUUID } from 'node:crypto'
import { CosmosClient, type Container, type JSONObject, type OperationInput, type SqlParameter } from '@azure/cosmos'
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import type { TokenCredential } from '@azure/identity'
import { QC_LIMITS, type VersionedQc } from '../../src/domain/quality-control'
import type { QcWorkRecord } from '../../src/domain/quality-improvement'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { fetchCosmosPage } from '../cosmos-query'
import { StoreConflictError } from '../store'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import type { QcBlobStore, QcBlobWriter, QcConfig, QcRecord, QcStore, QcTransaction } from './store'
import { qcAcceptedControlFences } from './fences'
import {
  assertQcReplacement, parseQcRecord, qcAssert, qcBlobScope, qcBytesHash, qcControlId, qcEtag,
  qcId, qcListOptions, qcOwnerPrefix, qcPageCursor, qcPageToken, qcRecordMatches, qcRunIds,
  QC_BLOB_WRITE_MILLISECONDS, QC_LEASE_MILLISECONDS, QC_TRANSACTION_BYTES, QC_TRANSACTION_OPERATIONS,
} from './validation'

function status(error: unknown): number | undefined {
  const value = error as { code?: unknown; statusCode?: unknown } | null
  return typeof value?.statusCode === 'number' ? value.statusCode : typeof value?.code === 'number' ? value.code : undefined
}
function scope(workspaceId: string): void { qcAssert(WORKSPACE_ID_PATTERN.test(workspaceId), 'Invalid QC partition.') }
function decode(value: unknown, workspaceId?: string, id?: string): VersionedQc<QcRecord> {
  qcAssert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid stored QC object.')
  const data = { ...value } as Record<string, unknown>
  const etag = data._etag
  for (const key of ['_etag', '_rid', '_self', '_attachments', '_ts']) delete data[key]
  const record = parseQcRecord(data)
  qcEtag(etag)
  qcAssert((workspaceId === undefined || record.workspaceId === workspaceId) && (id === undefined || record.id === id),
    'QC record escaped its ownership boundary.')
  return { record, etag }
}
export function qcWorkPending(record: QcWorkRecord, now: string): boolean {
  return ['queued', 'running'].includes(record.status) && (!record.lease || record.lease.expiresAt <= now) &&
    (!record.nextAttemptAt || record.nextAttemptAt <= now)
}

/** The control replacements join the same Cosmos transaction as every publication, including workers. */
export async function prepareQcTransaction(
  store: Pick<QcStore, 'get'>, workspaceId: string, operations: QcTransaction[], lifecycle = false, exposure = false,
): Promise<QcTransaction[]> {
  scope(workspaceId)
  qcAssert(operations.length > 0 && operations.length <= QC_TRANSACTION_OPERATIONS &&
    new Set(operations.map(operation => operation.record.id)).size === operations.length, 'Invalid QC transaction size.')
  const runs = new Set<string>()
  const acceptedGenerations = new Map<string, number>()
  for (const operation of operations) {
    const record = parseQcRecord(operation.record)
    qcAssert(record.workspaceId === workspaceId, 'QC transactions cannot cross workspaces.')
    if (operation.kind !== 'create') qcEtag(operation.etag)
    if (!lifecycle) {
      qcAssert(operation.kind !== 'delete' || record.recordType === 'qc-writer', 'Evidence deletion requires lifecycle fencing.')
      qcAssert(record.recordType !== 'qc-control', 'QC controls are lifecycle-owned.')
    }
    const previous = await store.get(workspaceId, record.id)
    if (operation.kind === 'create' ? Boolean(previous) : !previous || previous.etag !== operation.etag) {
      throw new StoreConflictError('QC changed before publication.')
    }
    if (previous && operation.kind !== 'delete') assertQcReplacement(previous.record, record, lifecycle)
    if (exposure) {
      qcAssert(operation.kind !== 'delete' && (record.recordType === 'qc-request' && record.action === 'peers' ||
        record.recordType === 'qc-review' && Boolean(record.peerExposedAt) &&
        (previous?.record.recordType === 'qc-review'
          ? JSON.stringify({ ...previous.record, peerExposedAt: record.peerExposedAt, updatedAt: record.updatedAt }) === JSON.stringify(record)
          : record.feedback.length === 0 && record.submittedId === null)), 'Exposure cannot change feedback or other QC data.')
    }
    if (operation.kind === 'delete' && previous) qcAssert(JSON.stringify(previous.record) === JSON.stringify(record))
    for (const runId of qcRunIds(record)) runs.add(runId)
    if (record.recordType === 'qc-work' || record.recordType === 'qc-writer') {
      const planId = record.recordType === 'qc-work' ? record.planId : record.ownerId
      const parent = operations.find(item => item.record.id === planId)?.record ??
        (await store.get(workspaceId, planId))?.record
      if (record.recordType === 'qc-work') qcAssert(parent?.recordType === 'qc-plan' &&
        (lifecycle || parent.workId === record.id && (parent.revision === record.planRevision ||
          record.kind === 'plan' && record.status === 'complete' && parent.status === 'draft' && parent.revision === record.planRevision + 1)),
      'QC work needs its exact plan publication fence.')
      if (parent?.recordType === 'qc-plan') {
        for (const runId of qcRunIds(parent)) runs.add(runId)
        if (!lifecycle && record.recordType === 'qc-work' && record.status !== 'cancelled') {
          for (const fence of await qcAcceptedControlFences(store, record, qcRunIds(parent), operations)) {
            if (acceptedGenerations.has(fence.controlId) && acceptedGenerations.get(fence.controlId) !== fence.generation) {
              throw new StoreConflictError('QC work was accepted against different lifecycle generations.')
            }
            acceptedGenerations.set(fence.controlId, fence.generation)
          }
        }
        if (!lifecycle && ['invalidated', 'activated'].includes(parent.status)) throw new StoreConflictError('This QC plan is closed.')
        if (record.recordType === 'qc-work' && !operations.some(item => item.record.id === parent.id)) {
          const current = await store.get(workspaceId, parent.id)
          qcAssert(current, 'QC work parent disappeared.')
          operations = [...operations, { kind: 'replace', record: current.record, etag: current.etag }]
        }
      }
    }
  }
  const result = [...operations]
  for (const id of [qcControlId(), ...[...runs].map(qcControlId)]) {
    if (result.some(item => item.record.id === id)) continue
    const current = await store.get(workspaceId, id)
    if (current) {
      qcAssert(current.record.recordType === 'qc-control')
      if (!lifecycle && (current.record.state !== 'active' && !(exposure && current.record.state === 'archived') ||
        !exposure && (current.record.cleanupPending || current.record.cancellationPending))) {
        throw new StoreConflictError('This QC scope is read-only or being removed.')
      }
      if (!lifecycle && acceptedGenerations.has(id) && acceptedGenerations.get(id) !== (current.record.generation ?? 0)) {
        throw new StoreConflictError('QC work cannot cross a lifecycle transition after acceptance.')
      }
      result.push({ kind: 'replace', record: current.record, etag: current.etag })
    } else {
      if (acceptedGenerations.has(id)) throw new StoreConflictError('An accepted QC lifecycle fence disappeared.')
      const timestamp = new Date().toISOString()
      const runId = [...runs].find(value => qcControlId(value) === id)
      result.push({
        kind: 'create', record: {
          id, recordType: 'qc-control', workspaceId, createdAt: timestamp, updatedAt: timestamp, state: 'active', generation: 0,
          ...(runId ? { runId } : {}),
        },
      })
    }
  }
  qcAssert(result.length <= 100 && Buffer.byteLength(JSON.stringify(result)) <= QC_TRANSACTION_BYTES,
    'QC transaction exceeds its atomic publication bound.')
  return result
}

export function createAzureQcStore(config: QcConfig, credential: TokenCredential): QcStore {
  qcAssert(config.container === 'qc-records', 'QC requires its dedicated records container.')
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  return createQcStoreFromContainer(client.database(config.database).container(config.container))
}
export function createQcStoreFromContainer(container: Pick<Container, 'item' | 'items'>): QcStore {
  const store: QcStore = {
    async get(workspaceId, id) {
      scope(workspaceId)
      qcAssert(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(id))
      try {
        const response = await container.item(id, workspaceId).read()
        return response.resource ? decode(response.resource, workspaceId, id) : undefined
      } catch (error) { if (status(error) === 404) return undefined; throw error }
    },
    async list(workspaceId, input) {
      scope(workspaceId)
      const options = qcListOptions(input), limit = options.limit ?? QC_LIMITS.pageSize
      const filters = ['c.workspaceId = @workspaceId']
      const parameters: SqlParameter[] = [{ name: '@workspaceId', value: workspaceId }]
      const add = (field: string, value: string | undefined, expression: string) => {
        if (value === undefined) return
        filters.push(expression)
        parameters.push({ name: `@${field}`, value })
      }
      add('recordType', options.recordType, 'c.recordType = @recordType')
      add('runId', options.runId, '(c.scope.runId = @runId OR c.runId = @runId OR ARRAY_CONTAINS(c.runIds, @runId) OR ' +
        'EXISTS(SELECT VALUE s FROM s IN c.cases WHERE s.scope.runId = @runId) OR ' +
        'EXISTS(SELECT VALUE s FROM s IN c.comparisons WHERE s.runId = @runId) OR ' +
        'EXISTS(SELECT VALUE s FROM s IN c.value.cases WHERE s.scope.runId = @runId))')
      add('comparisonId', options.comparisonId, 'c.scope.comparisonId = @comparisonId')
      add('resultSha256', options.resultSha256, 'c.scope.resultSha256 = @resultSha256')
      add('resultRevision', options.resultRevision, 'c.scope.resultRevision = @resultRevision')
      add('planId', options.planId, 'c.planId = @planId')
      add('ownerId', options.ownerId, 'c.ownerId = @ownerId')
      add('authorId', options.authorId, '(c.author.principalId = @authorId OR c.createdBy.principalId = @authorId)')
      const response = await fetchCosmosPage(container.items.query({
        query: `SELECT * FROM c WHERE ${filters.join(' AND ')} ORDER BY c.id ASC`, parameters,
      }, { partitionKey: workspaceId, maxItemCount: limit, continuationToken: qcPageCursor(workspaceId, options) }))
      const items = response.resources.map(value => decode(value, workspaceId))
      qcAssert(items.length <= limit && items.every(item => qcRecordMatches(item.record, workspaceId, options)),
        'QC page escaped its authorized scope.')
      const continuationToken = qcPageToken(workspaceId, options, response.continuationToken)
      return { items, ...(continuationToken ? { continuationToken } : {}) }
    },
    async transact(workspaceId, operations, options = {}) {
      const prepared = await prepareQcTransaction(store, workspaceId, operations, options.lifecycle, options.exposure)
      const input = prepared.map<OperationInput>(operation => operation.kind === 'create'
        ? { operationType: 'Create', resourceBody: operation.record as unknown as JSONObject }
        : operation.kind === 'replace'
          ? { operationType: 'Replace', id: operation.record.id, resourceBody: operation.record as unknown as JSONObject, ifMatch: operation.etag }
          : { operationType: 'Delete', id: operation.record.id, ifMatch: operation.etag })
      try {
        options.assertActive?.()
        assertWorkspaceMutationLease(workspaceId)
        const response = await container.items.batch(input, workspaceId)
        const failures = response.result?.filter(item => item.statusCode < 200 || item.statusCode >= 300) ?? []
        if (response.result?.length !== input.length || failures.length || response.code && (response.code < 200 || response.code >= 300)) {
          const code = failures.find(item => item.statusCode !== 424)?.statusCode ?? response.code
          if ([404, 409, 412, 424].includes(code ?? 0)) throw new StoreConflictError('QC changed before atomic publication.')
          throw new Error('QC transaction was not acknowledged.')
        }
      } catch (error) {
        if ([404, 409, 412, 424].includes(status(error) ?? 0)) throw new StoreConflictError('QC changed before atomic publication.')
        throw error
      }
    },
    async pending(now, limit) {
      qcAssert(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isFinite(Date.parse(now)))
      const page = await fetchCosmosPage(container.items.query({
        query: 'SELECT * FROM c WHERE c.recordType = "qc-work" AND (c.status = "queued" OR c.status = "running") ' +
          'AND (IS_NULL(c.nextAttemptAt) OR c.nextAttemptAt <= @now) AND (IS_NULL(c.lease) OR c.lease.expiresAt <= @now) ORDER BY c.updatedAt ASC',
        parameters: [{ name: '@now', value: now }],
      }, { maxItemCount: limit }))
      const values = page.resources.map(value => decode(value))
      qcAssert(values.length <= limit && values.every(item => item.record.recordType === 'qc-work' && qcWorkPending(item.record, now)))
      return values as VersionedQc<QcWorkRecord>[]
    },
    async pendingLifecycle(limit) {
      qcAssert(Number.isInteger(limit) && limit >= 1 && limit <= 100)
      const page = await fetchCosmosPage(container.items.query({
        query: 'SELECT * FROM c WHERE c.recordType = "qc-control" AND (c.cleanupPending = true OR c.cancellationPending = true)',
      }, { maxItemCount: limit }))
      return [...new Set(page.resources.map(value => {
        const { record } = decode(value)
        qcAssert(record.recordType === 'qc-control' && (record.cleanupPending || record.cancellationPending))
        return record.workspaceId
      }))]
    },
  }
  return store
}

export function createAzureQcBlobStore(config: QcConfig, credential: TokenCredential, store: QcStore): QcBlobStore {
  qcAssert(config.blobContainer === 'qc-sources', 'QC requires its dedicated private artifact container.')
  const client = new BlobServiceClient(config.storageAccountUrl, credential, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: QC_BLOB_WRITE_MILLISECONDS },
  })
  return createQcBlobStoreFromContainer(client.getContainerClient(config.blobContainer), store)
}
export function createQcBlobStoreFromContainer(
  container: Pick<ContainerClient, 'getBlockBlobClient' | 'listBlobsFlat'>, store: QcStore,
): QcBlobStore {
  const blobs: QcBlobStore = {
    async read(reference) {
      qcBlobScope(reference, reference.name.split('/')[0])
      const response = await container.getBlockBlobClient(reference.name).download(0, undefined, {
        abortSignal: AbortSignal.timeout(QC_BLOB_WRITE_MILLISECONDS),
      })
      const stream = response.readableStreamBody
      qcAssert(stream, 'QC artifact is unavailable.')
      try {
        qcAssert(response.contentType === 'application/json' && response.contentLength === reference.bytes &&
          response.metadata?.scorepreparing !== 'true', 'QC artifact metadata is inconsistent.')
        const buffers: Buffer[] = []
        let total = 0
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk)
          total += bytes.length
          qcAssert(total <= reference.bytes && total <= QC_LIMITS.artifactBytes, 'QC artifact exceeds its budget.')
          buffers.push(bytes)
        }
        const result = Buffer.concat(buffers)
        qcAssert(result.length === reference.bytes && qcBytesHash(result) === reference.sha256, 'QC artifact digest changed.')
        return result
      } finally {
        if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy()
      }
    },
    async put(workspaceId, ownerId, bytes, fence) {
      scope(workspaceId)
      qcAssert(fence && bytes.byteLength > 0 && bytes.byteLength <= QC_LIMITS.artifactBytes, 'QC artifact publication requires a bounded lifecycle fence.')
      const body = Buffer.from(bytes), sha256 = qcBytesHash(body)
      const reference = { name: `${qcOwnerPrefix(workspaceId, ownerId)}${sha256}.json`, sha256, bytes: body.length }
      qcBlobScope(reference, workspaceId, ownerId)
      const timestamp = new Date().toISOString()
      const writer: QcBlobWriter = {
        id: qcId('writer', randomUUID()), workspaceId, recordType: 'qc-writer', ownerId,
        createdAt: timestamp, updatedAt: timestamp, runIds: [...new Set(fence.runIds)],
        expiresAt: new Date(Date.now() + QC_LEASE_MILLISECONDS).toISOString(),
      }
      await fence.assertActive()
      const ownerKey = qcId('artifacts', ownerId)
      const owner = await store.get(workspaceId, ownerKey)
      qcAssert(!owner || owner.record.recordType === 'qc-artifacts' && owner.record.ownerId === ownerId &&
        JSON.stringify([...owner.record.runIds].sort()) === JSON.stringify([...writer.runIds].sort()),
      'QC artifact ownership cannot change.')
      await store.transact(workspaceId, [
        ...(!owner ? [{ kind: 'create' as const, record: {
          id: ownerKey, recordType: 'qc-artifacts' as const, workspaceId, ownerId, runIds: writer.runIds,
          createdAt: timestamp, updatedAt: timestamp,
        } }] : []),
        { kind: 'create', record: writer },
      ])
      const client = container.getBlockBlobClient(reference.name)
      let lease: ReturnType<typeof client.getBlobLeaseClient> | undefined
      try {
        const signal = AbortSignal.timeout(QC_BLOB_WRITE_MILLISECONDS)
        try {
          await client.upload(Buffer.alloc(0), 0, {
            conditions: { ifNoneMatch: '*' }, metadata: { scorepreparing: 'true' }, abortSignal: signal,
            blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'private, no-store' },
          })
        } catch (error) { if (![409, 412].includes(status(error) ?? 0)) throw error }
        let properties = await client.getProperties({ abortSignal: signal })
        if (properties.metadata?.scorepreparing !== 'true') {
          await blobs.read(reference)
          await fence.assertActive()
          return reference
        }
        lease = client.getBlobLeaseClient(randomUUID())
        await lease.acquireLease(60, { abortSignal: signal })
        properties = await client.getProperties({ abortSignal: signal })
        qcAssert(properties.metadata?.scorepreparing === 'true' && properties.etag)
        await fence.assertActive()
        if (Date.parse(writer.expiresAt) - Date.now() < 60_000) throw new StoreConflictError('QC artifact write reservation expired.')
        assertWorkspaceMutationLease(workspaceId)
        await client.upload(body, body.length, {
          conditions: { ifMatch: properties.etag, leaseId: lease.leaseId }, abortSignal: signal, metadata: {},
          blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'private, no-store' },
        })
        await fence.assertActive()
        return reference
      } finally {
        let released = !lease
        try { if (lease) { await lease.releaseLease({ abortSignal: AbortSignal.timeout(5000) }); released = true } } catch {
          console.warn(JSON.stringify({ component: 'score-qc-storage', event: 'cleanup-deferred', code: 'qc-blob-lease-release' }))
        }
        const current = released ? await store.get(workspaceId, writer.id) : undefined
        if (current) {
          try { await store.transact(workspaceId, [{ kind: 'delete', record: current.record, etag: current.etag }], { lifecycle: true }) } catch {
            console.warn(JSON.stringify({ component: 'score-qc-storage', event: 'cleanup-deferred', code: 'qc-writer-reservation-release' }))
          }
        }
      }
    },
    async list(workspaceId, ownerId, token) {
      const prefix = qcOwnerPrefix(workspaceId, ownerId)
      qcAssert(token === undefined || token.length <= 16 * 1024)
      const pages = container.listBlobsFlat({ prefix }).byPage({ maxPageSize: 50, continuationToken: token })
      const response = await pages.next()
      if (response.done) return { items: [] }
      const items = response.value.segment.blobItems.map(item => {
        qcAssert(item.name.startsWith(prefix) && item.properties.etag, 'QC blob listing escaped scope.')
        return { name: item.name, etag: item.properties.etag }
      })
      return { items, ...(response.value.continuationToken ? { continuationToken: response.value.continuationToken } : {}) }
    },
    async delete(workspaceId, name, etag) {
      qcAssert(name.startsWith(qcOwnerPrefix(workspaceId)) && !name.includes('..') &&
        /^[A-Za-z0-9._-]+\/[A-Za-z0-9:._-]+\/[a-f0-9]{64}\.json$/.test(name))
      qcEtag(etag)
      assertWorkspaceMutationLease(workspaceId)
      try { await container.getBlockBlobClient(name).delete({ conditions: { ifMatch: etag } }) } catch (error) {
        if (status(error) !== 404) throw error
      }
    },
  }
  return blobs
}
