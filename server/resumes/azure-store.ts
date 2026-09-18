import { CosmosClient } from '@azure/cosmos'
import type { Container, JSONObject, OperationInput, SqlParameter } from '@azure/cosmos'
import { BlobServiceClient } from '@azure/storage-blob'
import type { BlockBlobClient } from '@azure/storage-blob'
import type { TokenCredential } from '@azure/identity'
import type { RealResumeRecord, ResumeEntity, VersionedResumeEntity } from '../../src/domain/real-resumes'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { StoreConflictError, StoreNotFoundError } from '../store'
import { fetchCosmosPage } from '../cosmos-query'
import type { RealResumesConfig, ResumeBlob, ResumeBlobStore, ResumeStore } from './store'
import {
  REAL_RESUME_STATUSES, isResumeUuid, isSafeResumeBlobName, isValidResumeBatchRecordId, isValidResumeId,
  parseResumeEntity, resumeBlobContentType, resumeBlobLimit, resumeContentHash, resumeSha256,
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

const same = (left: unknown, right: unknown) => resumeContentHash(left) === resumeContentHash(right)

function checkReplacement(current: VersionedResumeEntity | undefined, record: ResumeEntity, etag: string): void {
  requireEtag(etag)
  if (!current) throw new StoreNotFoundError('The resume record was not found.')
  if (current.etag !== etag) throw new StoreConflictError('The resume record changed.')
  const previous = current.record
  if (previous.recordType !== record.recordType || previous.id !== record.id ||
    previous.workspaceId !== record.workspaceId || previous.createdAt !== record.createdAt ||
    previous.createdBy !== record.createdBy || previous.batchId !== record.batchId) {
    throw new Error('Resume identity, ownership, batch, and creation metadata are immutable.')
  }
  if (record.updatedAt < previous.updatedAt) throw new Error('Resume update timestamps cannot move backwards.')
  if (previous.recordType === 'resume-batch' && record.recordType === 'resume-batch') {
    if (previous.inputCount !== record.inputCount || previous.items.length > record.items.length ||
      previous.items.some((item, index) => !same(item, record.items[index]))) {
      throw new Error('Batch declarations and accepted items are immutable; admission can only append unique items.')
    }
  }
  if (previous.recordType !== 'resume' || record.recordType !== 'resume') return
  if (previous.idempotencyKey !== record.idempotencyKey || previous.inputFingerprint !== record.inputFingerprint ||
    !same(previous.source, record.source) || previous.resume.documentId !== record.resume.documentId ||
    previous.resume.documentVersion !== record.resume.documentVersion) throw new Error('Captured resume input is immutable.')
  for (const field of ['capture', 'captureManifest', 'extraction', 'profileBlob'] as const) {
    if (previous[field] !== undefined && (record[field] === undefined || !same(previous[field], record[field]))) {
      throw new Error('Captured originals, manifests, extractions, and profiles must be preserved unchanged.')
    }
  }
  if (previous.profileBlob && (['name', 'role', 'location', 'experience'] as const).some(
    field => previous.resume[field] !== record.resume[field],
  )) throw new Error('Captured profile display metadata is immutable.')
  if (previous.resume.status === 'ready' && !same(previous, record)) throw new Error('Completed resume records are immutable.')
  const manualRetry = ['error', 'cancelled'].includes(previous.resume.status) && record.resume.status === 'queued'
  if (manualRetry) {
    if (record.retryCount !== previous.retryCount + 1 || record.attempts !== 0 || record.attemptId || record.lease ||
      record.completedAt || record.cancelledAt || record.error || !record.nextAttemptAt) {
      throw new Error('A manual retry must start a new bounded attempt cycle without discarding captured evidence.')
    }
  } else {
    if (record.retryCount !== previous.retryCount || record.attempts < previous.attempts ||
      record.attempts > previous.attempts + 1) throw new Error('Resume attempts or retry cycle changed unexpectedly.')
    if (['error', 'cancelled'].includes(previous.resume.status) && !same(previous, record)) {
      throw new Error('Failed or cancelled resumes are immutable until an explicit retry cycle.')
    }
  }
  if (record.lease && previous.attemptId !== record.attemptId) {
    if (record.attempts !== previous.attempts + 1 ||
      (previous.lease && record.lease.heartbeatAt < previous.lease.expiresAt)) {
      throw new StoreConflictError('An unexpired resume lease cannot be taken over.')
    }
  } else if (previous.lease && record.lease && (record.lease.owner !== previous.lease.owner ||
    record.lease.heartbeatAt < previous.lease.heartbeatAt || record.lease.expiresAt < previous.lease.expiresAt)) {
    throw new Error('A live resume attempt must retain and extend its own lease.')
  }
}

export function createAzureResumeStore(config: RealResumesConfig, credential: TokenCredential): ResumeStore {
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  return createResumeStoreFromContainer(client.database(config.database).container(config.container))
}

export function createResumeStoreFromContainer(container: Pick<Container, 'item' | 'items'>): ResumeStore {
  const store: ResumeStore = {
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
      try {
        const response = await container.items.create(record)
        if (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)) {
          throw Object.assign(new Error('Cosmos resume creation failed.'), { statusCode: response.statusCode })
        }
        const saved = response.resource ? decode(response.resource, record.workspaceId, record.id) : await store.get(record.workspaceId, record.id)
        if (!saved || saved.record.recordType !== record.recordType) throw new Error('The created resume record could not be confirmed.')
        return { created: true, value: saved as VersionedResumeEntity<T> }
      } catch (error) {
        if (status(error) !== 409) throw error
        const existing = await store.get(record.workspaceId, record.id)
        if (!existing || existing.record.recordType !== record.recordType) throw new Error('Conflicting resume record could not be read.')
        return { created: false, value: existing as VersionedResumeEntity<T> }
      }
    },
    async replace<T extends ResumeEntity>(value: T, etag: string) {
      const record = parseResumeEntity(value)
      checkReplacement(await store.get(record.workspaceId, record.id), record, etag)
      try {
        const response = await container.item(record.id, record.workspaceId).replace(record, {
          accessCondition: { type: 'IfMatch', condition: etag },
        })
        if (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)) {
          throw Object.assign(new Error('Cosmos resume replacement failed.'), { statusCode: response.statusCode })
        }
        const saved = response.resource ? decode(response.resource, record.workspaceId, record.id) : await store.get(record.workspaceId, record.id)
        if (!saved || saved.record.recordType !== record.recordType) throw new Error('The replaced resume record could not be confirmed.')
        return saved as VersionedResumeEntity<T>
      } catch (error) {
        if ([404, 409, 412].includes(status(error) ?? 0)) throw new StoreConflictError('The resume record changed.')
        throw error
      }
    },
    async transact(workspaceId, operations) {
      scope(workspaceId)
      if (!Array.isArray(operations) || !operations.length || operations.length > 100 ||
        new Set(operations.map(operation => operation.record.id)).size !== operations.length) {
        throw new Error('Resume transactions require 1 to 100 uniquely identified operations.')
      }
      const validated = operations.map(operation => {
        if (operation.kind !== 'create' && operation.kind !== 'replace') throw new Error('Invalid resume transaction operation.')
        const record = parseResumeEntity(operation.record)
        if (record.workspaceId !== workspaceId) throw new Error('Resume transactions cannot cross workspace partitions.')
        if (operation.kind === 'replace') requireEtag(operation.etag)
        return { ...operation, record }
      })
      if (Buffer.byteLength(JSON.stringify(validated)) > 1_800_000) throw new Error('Resume transaction exceeds the Cosmos payload budget.')
      await Promise.all(validated.map(async operation => {
        if (operation.kind === 'replace') checkReplacement(await store.get(workspaceId, operation.record.id), operation.record, operation.etag)
      }))
      const batch: OperationInput[] = validated.map(operation => operation.kind === 'create'
        ? { operationType: 'Create', resourceBody: operation.record as unknown as JSONObject }
        : { operationType: 'Replace', id: operation.record.id, resourceBody: operation.record as unknown as JSONObject, ifMatch: operation.etag })
      try {
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
      return response.resources.map(value => {
        const decoded = decode(value)
        const { record } = decoded
        if (record.recordType !== 'resume' ||
          (record.nextAttemptAt !== undefined && record.nextAttemptAt > now) ||
          !(record.resume.status === 'queued' && !record.lease ||
            ['parsing', 'profiling'].includes(record.resume.status) && record.lease && record.lease.expiresAt <= now)) {
          throw new Error('Pending resume query returned terminal, premature, or actively leased work.')
        }
        return decoded as VersionedResumeEntity<RealResumeRecord>
      })
    },
  }
  return store
}

interface ResumeBlobContainer {
  getBlockBlobClient(name: string): {
    download(): Promise<Pick<Awaited<ReturnType<BlockBlobClient['download']>>, 'readableStreamBody' | 'etag' | 'contentType' | 'contentLength'>>
    upload(...args: Parameters<BlockBlobClient['upload']>): Promise<Pick<Awaited<ReturnType<BlockBlobClient['upload']>>, 'etag'>>
  }
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
  return createResumeBlobStoreFromContainer(new BlobServiceClient(config.storageAccountUrl, credential).getContainerClient(config.blobContainer))
}

export function createResumeBlobStoreFromContainer(container: ResumeBlobContainer): ResumeBlobStore {
  async function read(name: string): Promise<ResumeBlob | undefined> {
    if (!isSafeResumeBlobName(name)) throw new Error('Invalid resume blob name.')
    try {
      const response = await container.getBlockBlobClient(name).download()
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
  return {
    read,
    async putImmutable(name, bytes, contentType) {
      if (!isSafeResumeBlobName(name) || contentType !== resumeBlobContentType(name)) throw new Error('Invalid resume blob name or content type.')
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > resumeBlobLimit(name)) {
        throw new Error('Resume blob exceeds its supported size or is empty.')
      }
      const body = Buffer.from(bytes)
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
    },
  }
}
