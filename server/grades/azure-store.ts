import { createHash } from 'node:crypto'
import { CosmosClient } from '@azure/cosmos'
import type { Container, JSONObject, OperationInput, SqlParameter } from '@azure/cosmos'
import { BlobServiceClient } from '@azure/storage-blob'
import type { BlockBlobClient } from '@azure/storage-blob'
import type { TokenCredential } from '@azure/identity'
import { GRADE_LADDER_LIMITS, type GradeEntity, type GradeWorkRecord, type VersionedGradeEntity } from '../../src/domain/real-grades'
import { MAX_MARKDOWN_BYTES } from '../../src/domain/source-files'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { StoreConflictError, StoreNotFoundError } from '../store'
import { fetchCosmosPage } from '../cosmos-query'
import type { GradeBlob, GradeBlobStore, GradeStore, RealGradesConfig } from './store'
import { gradeContentHash, isGradeId, isSafeGradeBlobName, MUTABLE_GRADE_TYPES, parseGradeEntity } from './validation'

function status(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = error as { code?: unknown; statusCode?: unknown }
  return typeof value.statusCode === 'number' ? value.statusCode : typeof value.code === 'number' ? value.code : undefined
}

function scope(workspaceId: string, id?: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error('Invalid grade workspace ID.')
  if (id !== undefined && ![
    'ladder', 'source', 'source-set', 'grade-work', 'grade-version', 'grade-review', 'grade-approval', 'competency-plan',
  ].some(prefix => isGradeId(id, prefix)) &&
    !/^grade-head-[0-9a-f-]{36}-(?:[1-9]|1[0-5])$/.test(id)) throw new Error('Invalid grade entity ID.')
}

function decode(value: unknown, workspaceId?: string, id?: string): VersionedGradeEntity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored grade record.')
  const data = { ...value } as Record<string, unknown>
  const etag = data._etag
  for (const key of ['_etag', '_rid', '_self', '_attachments', '_ts']) delete data[key]
  const record = parseGradeEntity(data)
  if (typeof etag !== 'string' || !etag || (workspaceId !== undefined && workspaceId !== record.workspaceId) ||
    (id !== undefined && id !== record.id)) throw new Error('Invalid stored grade ownership or ETag.')
  return { record, etag }
}

function requireEtag(etag: string): void {
  if (typeof etag !== 'string' || !etag.trim() || etag === '*' || etag.length > 1024) {
    throw new Error('An exact grade ETag is required.')
  }
}

function checkReplacement(current: VersionedGradeEntity | undefined, record: GradeEntity, etag: string): void {
  requireEtag(etag)
  if (!MUTABLE_GRADE_TYPES.has(record.recordType)) throw new Error('Immutable grade records cannot be replaced.')
  if (!current) throw new StoreNotFoundError('Grade record was not found.')
  if (current.etag !== etag) throw new StoreConflictError('The grade record changed.')
  const old = current.record
  if (old.recordType !== record.recordType || old.workspaceId !== record.workspaceId || old.id !== record.id ||
    old.createdAt !== record.createdAt || ('ladderId' in old && (!('ladderId' in record) || old.ladderId !== record.ladderId))) {
    throw new Error('Grade record identity and ownership are immutable.')
  }
  if (old.recordType === 'grade-ladder' && record.recordType === 'grade-ladder') {
    for (const field of ['seedJobId', 'seedRubricId', 'seedRubricVersion', 'seedJobTitle', 'seedBlobName', 'createdBy', 'inputFingerprint'] as const) {
      if (old[field] !== record[field]) throw new Error('The captured ladder seed is immutable.')
    }
    if (record.sourceRevision < old.sourceRevision) throw new Error('Source revisions cannot move backwards.')
  }
  if (old.recordType === 'grade-source' && record.recordType === 'grade-source') {
    for (const field of ['origin', 'purpose', 'documentId', 'inputFingerprint', 'requestedUrl'] as const) {
      if (old[field] !== record[field]) throw new Error('Captured source identity is immutable.')
    }
    for (const field of ['originalBlobName', 'originalContentType', 'sha256', 'bytes', 'capturedAt', 'finalUrl'] as const) {
      if (old[field] !== undefined && old[field] !== record[field]) throw new Error('Captured source originals are immutable; use a new source.')
    }
    if (record.documentVersion < old.documentVersion) throw new Error('Source document versions cannot move backwards.')
    if (old.documentBlobName && record.documentVersion === old.documentVersion &&
      (record.documentBlobName !== old.documentBlobName || gradeContentHash(record.selectedPages) !== gradeContentHash(old.selectedPages))) {
      throw new Error('Re-extraction must create a new document version.')
    }
  }
  if (old.recordType === 'grade-head' && record.recordType === 'grade-head' && old.grade !== record.grade) {
    throw new Error('Grade head identity is immutable.')
  }
  if (old.recordType === 'grade-work' && record.recordType === 'grade-work' &&
    (gradeContentHash(old.input) !== gradeContentHash(record.input) || old.requestFingerprint !== record.requestFingerprint)) {
    throw new Error('Grade work input is immutable.')
  }
}

export function createAzureGradeStore(config: RealGradesConfig, credential: TokenCredential): GradeStore {
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  return createGradeStoreFromContainer(client.database(config.database).container(config.container))
}

export function createGradeStoreFromContainer(container: Pick<Container, 'item' | 'items'>): GradeStore {
  const store: GradeStore = {
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
    async list(workspaceId, options) {
      scope(workspaceId)
      const limit = options.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Grade list limit must be between 1 and 100.')
      if (options.continuationToken !== undefined && (!options.continuationToken || options.continuationToken.length > 16 * 1024)) {
        throw new Error('Invalid grade continuation token.')
      }
      if (options.ladderId !== undefined && !isGradeId(options.ladderId, 'ladder')) throw new Error('Invalid ladder ID.')
      const filters = ['c.workspaceId = @workspaceId', 'c.recordType = @recordType']
      const parameters: SqlParameter[] = [
        { name: '@workspaceId', value: workspaceId }, { name: '@recordType', value: options.recordType },
      ]
      for (const field of ['ladderId', 'grade', 'generationId', 'status'] as const) {
        if (options[field] !== undefined) {
          filters.push(`c.${field} = @${field}`)
          parameters.push({ name: `@${field}`, value: options[field] })
        }
      }
      const response = await fetchCosmosPage(container.items.query({
        query: `SELECT * FROM c WHERE ${filters.join(' AND ')} ORDER BY c.createdAt DESC`, parameters,
      }, { partitionKey: workspaceId, maxItemCount: limit, continuationToken: options.continuationToken }))
      const items = response.resources.map(value => decode(value, workspaceId))
      if (items.some(({ record }) => record.recordType !== options.recordType ||
        (options.ladderId !== undefined && (!('ladderId' in record) || record.ladderId !== options.ladderId)) ||
        (options.grade !== undefined && (!('grade' in record) || record.grade !== options.grade)) ||
        (options.generationId !== undefined && (!('generationId' in record) || record.generationId !== options.generationId)) ||
        (options.status !== undefined && (!('status' in record) || record.status !== options.status)))) {
        throw new Error('Grade query returned a record outside its requested scope.')
      }
      return { items, ...(response.continuationToken ? { continuationToken: response.continuationToken } : {}) }
    },
    async create(value) {
      const record = parseGradeEntity(value)
      try {
        const response = await container.items.create(record)
        if (!response.resource) throw new Error('Cosmos did not return the created grade record.')
        return { created: true, value: decode(response.resource, record.workspaceId, record.id) }
      } catch (error) {
        if (status(error) !== 409) throw error
        const existing = await store.get(record.workspaceId, record.id)
        if (!existing) throw new Error('Conflicting grade record could not be read.')
        return { created: false, value: existing }
      }
    },
    async replace(value, etag) {
      const record = parseGradeEntity(value)
      if (!MUTABLE_GRADE_TYPES.has(record.recordType)) throw new Error('Immutable grade records cannot be replaced.')
      checkReplacement(await store.get(record.workspaceId, record.id), record, etag)
      try {
        const response = await container.item(record.id, record.workspaceId).replace(record, {
          accessCondition: { type: 'IfMatch', condition: etag },
        })
        if (!response.resource) throw new Error('Cosmos did not return the replaced grade record.')
        return decode(response.resource, record.workspaceId, record.id)
      } catch (error) {
        if ([404, 409, 412].includes(status(error) ?? 0)) throw new StoreConflictError('The grade record changed.')
        throw error
      }
    },
    async transact(workspaceId, operations) {
      scope(workspaceId)
      if (!operations.length || operations.length > 100 ||
        new Set(operations.map(operation => operation.record.id)).size !== operations.length) {
        throw new Error('Grade transactions require 1 to 100 uniquely identified operations.')
      }
      const validated = operations.map(operation => {
        if (operation.kind !== 'create' && operation.kind !== 'replace') throw new Error('Unsupported grade transaction operation.')
        const record = parseGradeEntity(operation.record)
        if (record.workspaceId !== workspaceId) throw new Error('Grade transactions cannot cross workspace partitions.')
        if (operation.kind === 'replace') {
          if (!MUTABLE_GRADE_TYPES.has(record.recordType)) throw new Error('Immutable grade records cannot be replaced.')
          requireEtag(operation.etag)
        }
        return { ...operation, record }
      })
      if (Buffer.byteLength(JSON.stringify(validated)) > 1_800_000) throw new Error('Grade transaction exceeds the Cosmos payload budget.')
      await Promise.all(validated.map(async operation => {
        if (operation.kind === 'replace') checkReplacement(
          await store.get(workspaceId, operation.record.id), operation.record, operation.etag,
        )
      }))
      const batch: OperationInput[] = validated.map(operation => operation.kind === 'create'
        ? { operationType: 'Create', resourceBody: operation.record as unknown as JSONObject }
        : { operationType: 'Replace', id: operation.record.id, resourceBody: operation.record as unknown as JSONObject, ifMatch: operation.etag })
      try {
        const response = await container.items.batch(batch, workspaceId)
        const results = response.result ?? []
        if (results.length !== batch.length || results.some(result => result.statusCode < 200 || result.statusCode >= 300) ||
          (response.code !== undefined && (response.code < 200 || response.code >= 300))) {
          const code = results.find(result => result.statusCode >= 400 && result.statusCode !== 424)?.statusCode ?? response.code
          if ([404, 409, 412, 424].includes(code ?? 0)) throw new StoreConflictError('The grade workflow changed before publication.')
          throw new Error('Cosmos grade transaction did not succeed.')
        }
      } catch (error) {
        if ([404, 409, 412, 424].includes(status(error) ?? 0)) throw new StoreConflictError('The grade workflow changed before publication.')
        throw error
      }
    },
    async listPending(now, limit) {
      if (!Number.isFinite(Date.parse(now)) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Invalid pending grade-work timestamp or limit.')
      }
      const response = await container.items.query({
        query: `SELECT TOP @limit * FROM c WHERE c.recordType = @recordType
          AND (c.status = 'queued' OR c.status = 'running')
          AND (NOT IS_DEFINED(c.nextAttemptAt) OR c.nextAttemptAt <= @now)
          AND (NOT IS_DEFINED(c.lease) OR NOT IS_DEFINED(c.lease.expiresAt) OR c.lease.expiresAt <= @now)
          ORDER BY c.createdAt ASC`,
        parameters: [
          { name: '@limit', value: limit }, { name: '@recordType', value: 'grade-work' }, { name: '@now', value: now },
        ],
      }).fetchAll()
      return response.resources.map(value => {
        const decoded = decode(value)
        if (decoded.record.recordType !== 'grade-work') throw new Error('Pending query returned a non-work record.')
        return decoded as VersionedGradeEntity<GradeWorkRecord>
      })
    },
  }
  return store
}

interface GradeBlobContainer {
  getBlockBlobClient(name: string): {
    download(): Promise<Pick<Awaited<ReturnType<BlockBlobClient['download']>>, 'readableStreamBody' | 'etag' | 'contentType' | 'contentLength'>>
    upload(...args: Parameters<BlockBlobClient['upload']>): Promise<Pick<Awaited<ReturnType<BlockBlobClient['upload']>>, 'etag'>>
  }
}

function blobLimit(name: string): number {
  if (name.endsWith('.pdf')) return GRADE_LADDER_LIMITS.maxPdfBytes
  if (name.endsWith('.md')) return MAX_MARKDOWN_BYTES
  if (name.endsWith('.html')) return 24 * 1024 * 1024
  return GRADE_LADDER_LIMITS.maxSourceCharacters * 8 + 4 * 1024 * 1024
}

function mime(name: string): string {
  return name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.html') ? 'text/html'
    : name.endsWith('.md') ? 'text/markdown' : 'application/json'
}

async function readBounded(stream: NodeJS.ReadableStream, length: number | undefined, maximum: number): Promise<Uint8Array> {
  if (length !== undefined && length > maximum) {
    if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy()
    throw new Error('Stored grade blob exceeds the supported size.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maximum) throw new Error('Stored grade blob exceeds the supported size.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

export function createAzureGradeBlobStore(config: RealGradesConfig, credential: TokenCredential): GradeBlobStore {
  return createGradeBlobStoreFromContainer(new BlobServiceClient(config.storageAccountUrl, credential).getContainerClient(config.blobContainer))
}

export function createGradeBlobStoreFromContainer(container: GradeBlobContainer): GradeBlobStore {
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  async function read(name: string): Promise<GradeBlob | undefined> {
    if (!isSafeGradeBlobName(name)) throw new Error('Invalid grade blob name.')
    try {
      const response = await container.getBlockBlobClient(name).download()
      if (!response.readableStreamBody || !response.etag || response.contentType !== mime(name)) {
        throw new Error('Grade blob has invalid stored content metadata.')
      }
      const bytes = await readBounded(response.readableStreamBody, response.contentLength, blobLimit(name))
      return { bytes, sha256: digest(bytes), contentType: response.contentType, etag: response.etag }
    } catch (error) {
      if (status(error) === 404) return undefined
      throw error
    }
  }
  return {
    read,
    async putImmutable(name, bytes, contentType) {
      if (!isSafeGradeBlobName(name)) throw new Error('Invalid grade blob name.')
      if (contentType !== mime(name)) throw new Error('Invalid grade blob content type.')
      if (!bytes.byteLength || bytes.byteLength > blobLimit(name)) throw new Error('Grade blob exceeds the supported size or is empty.')
      const body = Buffer.from(bytes)
      try {
        const response = await container.getBlockBlobClient(name).upload(body, body.byteLength, {
          conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: contentType },
        })
        if (!response.etag) throw new Error('Grade blob upload returned no ETag.')
        return { created: true, blob: { bytes: body, contentType, sha256: digest(body), etag: response.etag } }
      } catch (error) {
        if (![409, 412].includes(status(error) ?? 0)) throw error
        const existing = await read(name)
        if (!existing) throw new Error('Conflicting immutable grade blob could not be read.')
        return { created: false, blob: existing }
      }
    },
  }
}
