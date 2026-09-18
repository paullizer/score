import { CosmosClient } from '@azure/cosmos'
import type { Container, JSONObject, OperationInput, SqlParameter } from '@azure/cosmos'
import { BlobServiceClient } from '@azure/storage-blob'
import type { BlockBlobClient, ContainerClient } from '@azure/storage-blob'
import type { TokenCredential } from '@azure/identity'
import type { RealResumeRecord, ResumeEntity, VersionedResumeEntity } from '../../src/domain/real-resumes'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { StoreConflictError } from '../store'
import { fetchCosmosPage } from '../cosmos-query'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import type { RealResumesConfig, ResumeBlob, ResumeBlobStore, ResumeBlobWriteFence, ResumeStore, StoredResumeControl } from './store'
import {
  assertResumeWritable, checkResumeReplacement, parseResumeControl, prepareResumeTransaction, resumeControlId,
  resumeIsLocked, RESUME_BLOB_LEASE_SECONDS, RESUME_BLOB_REQUEST_MS,
} from './guards'
import {
  REAL_RESUME_STATUSES, isResumeUuid, isSafeResumeBlobName, isValidResumeBatchRecordId, isValidResumeId,
  isBlobInResumePrefix, parseResumeEntity, resumeBlobContentType, resumeBlobLimit, resumeSha256,
} from './validation'

function status(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = error as { code?: unknown; statusCode?: unknown }
  return typeof value.statusCode === 'number' ? value.statusCode : typeof value.code === 'number' ? value.code : undefined
}

function scope(workspaceId: string, id?: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error('Invalid resume workspace ID.')
  if (id !== undefined && !isValidResumeId(id) && !isValidResumeBatchRecordId(id)) throw new Error('Invalid resume entity ID.')
}

function requireEtag(etag: string): void {
  if (typeof etag !== 'string' || !etag || etag.trim() !== etag || etag === '*' ||
    etag.startsWith('W/') || etag.includes(',') || etag.length > 1024 || /[\r\n]/.test(etag)) {
    throw new Error('One exact resume ETag is required.')
  }
}

function decode(value: unknown, workspaceId?: string, id?: string): VersionedResumeEntity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored resume record.')
  const data = { ...value } as Record<string, unknown>
  const etag = data._etag
  for (const key of ['_etag', '_rid', '_self', '_attachments', '_ts']) delete data[key]
  const record = parseResumeEntity(data)
  if (typeof etag !== 'string') throw new Error('Invalid stored resume ETag.')
  requireEtag(etag)
  if ((workspaceId !== undefined && record.workspaceId !== workspaceId) || (id !== undefined && record.id !== id)) {
    throw new Error('Invalid stored resume ownership.')
  }
  return { record, etag }
}

export function createAzureResumeStore(config: RealResumesConfig, credential: TokenCredential): ResumeStore {
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  return createResumeStoreFromContainer(client.database(config.database).container(config.container))
}

export function createResumeStoreFromContainer(container: Pick<Container, 'item' | 'items'>): ResumeStore {
  function decodeControl(value: unknown, workspaceId?: string): StoredResumeControl {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored resume lifecycle control.')
    const data = { ...value } as Record<string, unknown>
    const etag = data._etag
    for (const key of ['_etag', '_rid', '_self', '_attachments', '_ts']) delete data[key]
    const record = parseResumeControl(data)
    if (typeof etag !== 'string' || (workspaceId !== undefined && record.workspaceId !== workspaceId)) {
      throw new Error('Invalid resume control ownership or ETag.')
    }
    requireEtag(etag)
    return { record, etag }
  }
  const store: ResumeStore = {
    async getControl(workspaceId, resumeId) {
      scope(workspaceId, resumeId)
      if (resumeId !== undefined && !isValidResumeId(resumeId)) throw new Error('Invalid resume lifecycle scope.')
      const id = resumeControlId(resumeId)
      try {
        const response = await container.item(id, workspaceId).read()
        if (response.statusCode === 404) return undefined
        if (!response.resource || (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300))) {
          throw new Error('Cosmos did not return the requested resume lifecycle control.')
        }
        const current = decodeControl(response.resource, workspaceId)
        if (current.record.id !== id) throw new Error('Invalid resume lifecycle identity.')
        return current
      } catch (error) {
        if (status(error) === 404) return undefined
        throw error
      }
    },
    async listControls(workspaceId, continuationToken) {
      scope(workspaceId)
      if (continuationToken !== undefined && (!continuationToken || continuationToken.length > 16 * 1024)) {
        throw new Error('Invalid resume lifecycle continuation token.')
      }
      const page = await fetchCosmosPage(container.items.query({
        query: 'SELECT * FROM c WHERE c.workspaceId = @workspaceId AND c.recordType = @recordType ORDER BY c.id',
        parameters: [{ name: '@workspaceId', value: workspaceId }, { name: '@recordType', value: 'resume-lifecycle' }],
      }, { partitionKey: workspaceId, maxItemCount: 100, continuationToken }))
      return { items: page.resources.map(value => decodeControl(value, workspaceId)),
        ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}) }
    },
    async pendingLifecycleWorkspaces(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid resume recovery limit.')
      const response = await container.items.query({
        query: `SELECT DISTINCT TOP @limit VALUE c.workspaceId FROM c WHERE c.recordType = @recordType AND
          (c.state = 'deleting' OR (IS_DEFINED(c.operation) AND c.operation.status != 'complete')
            OR c.preparation.expiresAt <= @now)`,
        parameters: [{ name: '@limit', value: limit }, { name: '@recordType', value: 'resume-lifecycle' },
          { name: '@now', value: new Date().toISOString() }],
      }).fetchAll()
      const values: unknown[] = response.resources
      if (values.length > limit || values.some(value => typeof value !== 'string' || !WORKSPACE_ID_PATTERN.test(value))) {
        throw new Error('Resume lifecycle recovery returned an invalid workspace scope.')
      }
      return [...new Set(values as string[])]
    },
    async get(workspaceId, id) {
      scope(workspaceId, id)
      try {
        const response = await container.item(id, workspaceId).read()
        if (response.statusCode === 404) return undefined
        if ((response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)) || !response.resource) {
          throw new Error('Cosmos did not return the requested resume record.')
        }
        return decode(response.resource, workspaceId, id)
      } catch (error) {
        if (status(error) === 404) return undefined
        throw error
      }
    },
    async list<K extends ResumeEntity['recordType']>(
      workspaceId: string, options: Parameters<ResumeStore['list']>[1] & { recordType: K },
    ) {
      scope(workspaceId)
      const limit = options.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Resume list limit must be between 1 and 100.')
      if (!['resume', 'resume-batch'].includes(options.recordType)) throw new Error('Invalid resume record type.')
      if (options.continuationToken !== undefined && (!options.continuationToken || options.continuationToken.length > 16 * 1024)) {
        throw new Error('Invalid resume continuation token.')
      }
      if (options.batchId !== undefined && !isResumeUuid(options.batchId)) throw new Error('Invalid resume batch ID.')
      if (options.status !== undefined && (options.recordType !== 'resume' || !REAL_RESUME_STATUSES.includes(options.status))) {
        throw new Error('Invalid resume status filter.')
      }
      const filters = ['c.workspaceId = @workspaceId', 'c.recordType = @recordType']
      const parameters: SqlParameter[] = [
        { name: '@workspaceId', value: workspaceId }, { name: '@recordType', value: options.recordType },
      ]
      if (options.batchId !== undefined) {
        filters.push('c.batchId = @batchId')
        parameters.push({ name: '@batchId', value: options.batchId })
      }
      if (options.status !== undefined) {
        filters.push('c.resume.status = @status')
        parameters.push({ name: '@status', value: options.status })
      }
      const response = await fetchCosmosPage(container.items.query({
        query: `SELECT * FROM c WHERE ${filters.join(' AND ')} ORDER BY c.createdAt DESC`, parameters,
      }, { partitionKey: workspaceId, maxItemCount: limit, continuationToken: options.continuationToken }))
      if (response.resources.length > limit) throw new Error('Resume query exceeded its requested page size.')
      const items = response.resources.map(value => decode(value, workspaceId))
      if (items.some(({ record }) => record.recordType !== options.recordType ||
        (options.batchId !== undefined && record.batchId !== options.batchId) ||
        (options.status !== undefined && (record.recordType !== 'resume' || record.resume.status !== options.status)))) {
        throw new Error('Resume query returned a record outside its requested scope.')
      }
      return {
        items: items as VersionedResumeEntity<Extract<ResumeEntity, { recordType: K }>>[],
        ...(response.continuationToken ? { continuationToken: response.continuationToken } : {}),
      }
    },
    async create<T extends ResumeEntity>(value: T) {
      const record = parseResumeEntity(value)
      const current = await store.get(record.workspaceId, record.id)
      if (current) {
        await prepareResumeTransaction(store, record.workspaceId, [{ kind: 'create', record }])
        if (current.record.recordType !== record.recordType) throw new Error('Conflicting resume identity.')
        return { created: false, value: current as VersionedResumeEntity<T> }
      }
      try {
        await store.transact(record.workspaceId, [{ kind: 'create', record }])
        const saved = await store.get(record.workspaceId, record.id)
        if (!saved || saved.record.recordType !== record.recordType) throw new Error('The created resume record could not be confirmed.')
        return { created: true, value: saved as VersionedResumeEntity<T> }
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error
        const existing = await store.get(record.workspaceId, record.id)
        if (!existing || existing.record.recordType !== record.recordType) throw error
        await prepareResumeTransaction(store, record.workspaceId, [{ kind: 'create', record }])
        return { created: false, value: existing as VersionedResumeEntity<T> }
      }
    },
    async replace<T extends ResumeEntity>(value: T, etag: string) {
      const record = parseResumeEntity(value)
      requireEtag(etag)
      checkResumeReplacement(await store.get(record.workspaceId, record.id), record, etag)
      await store.transact(record.workspaceId, [{ kind: 'replace', record, etag }])
      const saved = await store.get(record.workspaceId, record.id)
      if (!saved || saved.record.recordType !== record.recordType) throw new StoreConflictError('The replaced resume record was removed.')
      return saved as VersionedResumeEntity<T>
    },
    async transact(workspaceId, operations, options) {
      scope(workspaceId)
      if (!Array.isArray(operations) || (!operations.length && !options?.controls?.length) || operations.length > 100 ||
        new Set(operations.map(operation => operation.record.id)).size !== operations.length) {
        throw new Error('Resume transactions require 1 to 100 uniquely identified operations.')
      }
      const validated = operations.map(operation => {
        if (!['create', 'replace', 'delete'].includes(operation.kind)) throw new Error('Invalid resume transaction operation.')
        const record = parseResumeEntity(operation.record)
        if (record.workspaceId !== workspaceId) throw new Error('Resume transactions cannot cross workspace partitions.')
        if (operation.kind !== 'create') requireEtag(operation.etag)
        return { ...operation, record }
      })
      if (Buffer.byteLength(JSON.stringify(validated)) > 1_800_000) throw new Error('Resume transaction exceeds the Cosmos payload budget.')
      const controls = await prepareResumeTransaction(store, workspaceId, validated, options)
      const batch: OperationInput[] = validated.map(operation => operation.kind === 'create'
        ? { operationType: 'Create', resourceBody: operation.record as unknown as JSONObject }
        : operation.kind === 'delete' ? { operationType: 'Delete', id: operation.record.id, ifMatch: operation.etag }
          : { operationType: 'Replace', id: operation.record.id, resourceBody: operation.record as unknown as JSONObject, ifMatch: operation.etag })
      for (const control of controls) batch.push(control.etag
        ? { operationType: 'Replace', id: control.record.id, resourceBody: control.record as unknown as JSONObject, ifMatch: control.etag }
        : { operationType: 'Create', resourceBody: control.record as unknown as JSONObject })
      if (batch.length > 100 || Buffer.byteLength(JSON.stringify(batch)) > 1_800_000) {
        throw new Error('Guarded resume transaction exceeds the Cosmos operation or payload budget.')
      }
      try {
        assertWorkspaceMutationLease(workspaceId)
        const response = await container.items.batch(batch, workspaceId, { contentResponseOnWriteEnabled: false })
        const results = response.result ?? []
        if (results.length !== batch.length || results.some(result =>
          !Number.isInteger(result.statusCode) || result.statusCode < 200 || result.statusCode >= 300) ||
          (response.code !== undefined && (!Number.isInteger(response.code) || response.code < 200 || response.code >= 300))) {
          const code = results.find(result => result.statusCode >= 400 && result.statusCode !== 424)?.statusCode ??
            (response.code !== undefined && response.code >= 400 ? response.code : undefined) ??
            results.find(result => result.statusCode >= 400)?.statusCode
          if ([404, 409, 412, 424].includes(code ?? 0)) throw new StoreConflictError('The resume batch changed before publication.')
          throw new Error('Cosmos resume transaction did not succeed.')
        }
      } catch (error) {
        if ([404, 409, 412, 424].includes(status(error) ?? 0)) throw new StoreConflictError('The resume batch changed before publication.')
        throw error
      }
    },
    async listPending(now, limit) {
      if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now ||
        !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid pending resume timestamp or limit.')
      const response = await container.items.query({
        query: `SELECT TOP @limit * FROM c WHERE c.recordType = @recordType
          AND NOT IS_DEFINED(c.lifecycle.archivedAt) AND NOT IS_DEFINED(c.lifecycle.deletingAt) AND NOT IS_DEFINED(c.lifecycle.deletedAt)
          AND ((c.resume.status = 'queued' AND NOT IS_DEFINED(c.lease))
            OR ((c.resume.status = 'parsing' OR c.resume.status = 'profiling')
              AND IS_DEFINED(c.lease) AND c.lease.expiresAt <= @now))
          AND (NOT IS_DEFINED(c.nextAttemptAt) OR c.nextAttemptAt <= @now)
          ORDER BY c.createdAt ASC`,
        parameters: [
          { name: '@limit', value: limit }, { name: '@recordType', value: 'resume' }, { name: '@now', value: now },
        ],
      }, { maxItemCount: limit }).fetchAll()
      if (response.resources.length > limit) throw new Error('Pending resume query exceeded its requested work limit.')
      const candidates = response.resources.map(value => {
        const decoded = decode(value)
        const { record } = decoded
        if (record.recordType !== 'resume' || resumeIsLocked(record.lifecycle) ||
          (record.nextAttemptAt !== undefined && record.nextAttemptAt > now) ||
          !(record.resume.status === 'queued' && !record.lease ||
            ['parsing', 'profiling'].includes(record.resume.status) && record.lease && record.lease.expiresAt <= now)) {
          throw new Error('Pending resume query returned terminal, premature, or actively leased work.')
        }
        return decoded as VersionedResumeEntity<RealResumeRecord>
      })
      const pending: VersionedResumeEntity<RealResumeRecord>[] = []
      for (const candidate of candidates) {
        try {
          await assertResumeWritable(store, candidate.record.workspaceId, candidate.record.id)
          pending.push(candidate)
        } catch (error) {
          if (!(error instanceof StoreConflictError)) throw error
        }
      }
      return pending
    },
  }
  return store
}

interface ResumeBlobContainer {
  getBlockBlobClient(name: string): {
    download(): Promise<Pick<Awaited<ReturnType<BlockBlobClient['download']>>, 'readableStreamBody' | 'etag' | 'contentType' | 'contentLength' | 'metadata'>>
    upload(...args: Parameters<BlockBlobClient['upload']>): Promise<Pick<Awaited<ReturnType<BlockBlobClient['upload']>>, 'etag'>>
    getProperties?: BlockBlobClient['getProperties']
    getBlobLeaseClient?: BlockBlobClient['getBlobLeaseClient']
    deleteIfExists?: BlockBlobClient['deleteIfExists']
  }
  listBlobsFlat?: ContainerClient['listBlobsFlat']
}

async function readBounded(stream: NodeJS.ReadableStream, length: number | undefined, maximum: number): Promise<Uint8Array> {
  const destroy = () => { if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy() }
  if (length !== undefined && (!Number.isInteger(length) || length < 1 || length > maximum)) {
    destroy()
    throw new Error('Stored resume blob exceeds its supported size or is empty.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maximum) {
      destroy()
      throw new Error('Stored resume blob exceeds its supported size.')
    }
    chunks.push(bytes)
  }
  if (!size || (length !== undefined && size !== length)) throw new Error('Stored resume blob length is invalid.')
  return Buffer.concat(chunks, size)
}

export function createAzureResumeBlobStore(config: RealResumesConfig, credential: TokenCredential): ResumeBlobStore {
  return createResumeBlobStoreFromContainer(new BlobServiceClient(config.storageAccountUrl, credential, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: RESUME_BLOB_REQUEST_MS },
  }).getContainerClient(config.blobContainer))
}

export function createResumeBlobStoreFromContainer(container: ResumeBlobContainer): ResumeBlobStore {
  async function read(name: string): Promise<ResumeBlob | undefined> {
    if (!isSafeResumeBlobName(name)) throw new Error('Invalid resume blob name.')
    try {
      const response = await container.getBlockBlobClient(name).download()
      if (response.metadata?.scorepreparing === 'true') return undefined
      if (!response.readableStreamBody || typeof response.etag !== 'string' || !response.etag.trim() ||
        response.contentType !== resumeBlobContentType(name)) {
        throw new Error('Resume blob has invalid stored content metadata.')
      }
      const bytes = await readBounded(response.readableStreamBody, response.contentLength, resumeBlobLimit(name))
      return { bytes, sha256: resumeSha256(bytes), contentType: response.contentType, etag: response.etag }
    } catch (error) {
      if (status(error) === 404) return undefined
      throw error
    }
  }
  async function putImmutable(name: string, bytes: Uint8Array, contentType: string, fence?: ResumeBlobWriteFence) {
      if (!isSafeResumeBlobName(name) || contentType !== resumeBlobContentType(name)) throw new Error('Invalid resume blob name or content type.')
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > resumeBlobLimit(name)) {
        throw new Error('Resume blob exceeds its supported size or is empty.')
      }
      const body = Buffer.from(bytes)
      if (fence) {
        const client = container.getBlockBlobClient(name)
        if (!client.getBlobLeaseClient || !client.getProperties) throw new Error('Resume Blob lease fencing is unavailable.')
        if (fence.writer.blobName !== name || !isResumeUuid(fence.writer.id) ||
          !isBlobInResumePrefix(name, fence.writer.workspaceId, fence.writer.resumeId)) throw new Error('Invalid resume Blob writer scope.')
        const assertTime = () => {
          if (Date.parse(fence.writer.expiresAt) - Date.now() <= RESUME_BLOB_LEASE_SECONDS * 1000 + 5_000) {
            throw new StoreConflictError('The resume Blob writer reservation expired before upload.')
          }
        }
        assertTime()
        await fence.assertActive()
        const timeout = AbortSignal.timeout(RESUME_BLOB_REQUEST_MS)
        const signal = fence.signal ? AbortSignal.any([timeout, fence.signal]) : timeout
        try {
          // A late create can contain only a noncontent placeholder; source PUTs need a finite Blob lease.
          await client.upload(Buffer.alloc(0), 0, {
            conditions: { ifNoneMatch: '*' }, metadata: { scorepreparing: 'true' },
            blobHTTPHeaders: { blobContentType: 'application/octet-stream', blobCacheControl: 'private, no-store' },
            abortSignal: signal,
          })
        } catch (error) {
          if (![409, 412].includes(status(error) ?? 0)) throw error
          const existing = await read(name)
          if (existing) {
            await fence.assertActive()
            return { created: false, blob: existing }
          }
        }
        assertTime()
        const lease = client.getBlobLeaseClient(fence.writer.id)
        await lease.acquireLease(RESUME_BLOB_LEASE_SECONDS, { abortSignal: signal })
        try {
          await fence.assertActive()
          assertTime()
          const properties = await client.getProperties({ abortSignal: signal })
          if (properties.metadata?.scorepreparing !== 'true') {
            const existing = await read(name)
            if (!existing) throw new Error('The immutable resume source could not be read.')
            await fence.assertActive()
            return { created: false, blob: existing }
          }
          await fence.assertActive()
          assertTime()
          const response = await client.upload(body, body.byteLength, {
            conditions: { ifMatch: properties.etag, leaseId: lease.leaseId }, metadata: {},
            blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'private, no-store' }, abortSignal: signal,
          })
          if (typeof response.etag !== 'string' || !response.etag.trim()) throw new Error('Resume blob upload returned no ETag.')
          await fence.assertActive()
          return { created: true, blob: { bytes: body, contentType, sha256: resumeSha256(body), etag: response.etag } }
        } finally {
          await lease.releaseLease({ abortSignal: AbortSignal.timeout(RESUME_BLOB_REQUEST_MS) }).catch(() => undefined)
        }
      }
      try {
        const response = await container.getBlockBlobClient(name).upload(body, body.byteLength, {
          conditions: { ifNoneMatch: '*' },
          blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'private, no-store' },
        })
        if (typeof response.etag !== 'string' || !response.etag.trim()) throw new Error('Resume blob upload returned no ETag.')
        return { created: true, blob: { bytes: body, contentType, sha256: resumeSha256(body), etag: response.etag } }
      } catch (error) {
        if (![409, 412].includes(status(error) ?? 0)) throw error
        const existing = await read(name)
        if (!existing) throw new Error('The winning immutable resume blob could not be read.')
        return { created: false, blob: existing }
      }
  }
  async function page(workspaceId: string, resumeId?: string, continuationToken?: string): Promise<{ names: string[]; continuationToken?: string }> {
    scope(workspaceId, resumeId)
    if (resumeId !== undefined && !isValidResumeId(resumeId)) throw new Error('Invalid resume blob cleanup scope.')
    if (continuationToken !== undefined && (!continuationToken || continuationToken.length > 16 * 1024)) {
      throw new Error('Invalid resume blob continuation token.')
    }
    if (!container.listBlobsFlat) throw new Error('Resume Blob inventory is unavailable.')
    const prefix = `${workspaceId}/${resumeId ? `${resumeId}/` : ''}`
    const result = await container.listBlobsFlat({ prefix }).byPage({ maxPageSize: 100, continuationToken }).next()
    const names: string[] = result.value?.segment.blobItems.map((blob: { name: string }) => blob.name) ?? []
    if (names.some((name: string) => !isSafeResumeBlobName(name) || !name.startsWith(prefix))) {
      throw new Error('Resume Blob inventory crossed its ownership boundary.')
    }
    return { names, ...(result.value?.continuationToken ? { continuationToken: result.value.continuationToken } : {}) }
  }
  return {
    read, putImmutable,
    putFenced: (name, bytes, contentType, fence) => putImmutable(name, bytes, contentType, fence),
    listPage: (workspaceId, resumeId, token) => page(workspaceId, resumeId, token),
    async listFamilies(workspaceId, token) {
      const result = await page(workspaceId, undefined, token)
      return { resumeIds: [...new Set(result.names.map((name: string) => name.split('/')[1]))],
        ...(result.continuationToken ? { continuationToken: result.continuationToken } : {}) }
    },
    async delete(name) {
      if (!isSafeResumeBlobName(name)) throw new Error('Invalid resume blob cleanup name.')
      assertWorkspaceMutationLease(name.split('/')[0])
      const client = container.getBlockBlobClient(name)
      if (!client.deleteIfExists) throw new Error('Resume Blob deletion is unavailable.')
      await client.deleteIfExists({ deleteSnapshots: 'include', abortSignal: AbortSignal.timeout(RESUME_BLOB_REQUEST_MS) })
    },
  }
}
