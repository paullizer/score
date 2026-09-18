import { createHash } from 'node:crypto'
import { CosmosClient, ErrorResponse } from '@azure/cosmos'
import type { Container, JSONObject } from '@azure/cosmos'
import { BlobServiceClient, RestError } from '@azure/storage-blob'
import type { BlockBlobClient } from '@azure/storage-blob'
import type { TokenCredential } from '@azure/identity'
import { JOB_IMPORT_LIMITS } from '../../src/domain/real-jobs'
import type { RealJobRecord, VersionedRealJob } from '../../src/domain/real-jobs'
import type { Rubric } from '../../src/domain/types'
import { StoreConflictError } from '../store'
import { fetchCosmosPage } from '../cosmos-query'
import type { JobBlob, JobBlobStore, RealJobsConfig, RealJobStore } from './store'
import {
  isSafeJobBlobName,
  jobBlobContentType,
  validateRealJobRecord,
  validateStoredRealRubric,
} from './validation'

type CosmosDoc<T> = T & { _etag?: string }

interface RubricVersionRecord {
  id: string
  workspaceId: string
  recordType: 'rubric-version'
  jobId: string
  rubricId: string
  version: number
  rubric: Rubric
}

const LIST_PAGE_SIZE = 50
const MAX_HTML_BYTES = 24 * 1024 * 1024
const MAX_DOCUMENT_BYTES = JOB_IMPORT_LIMITS.maxSourceCharacters * 8

function maxBlobBytes(blobName: string): number {
  switch (jobBlobContentType(blobName)) {
    case 'application/pdf': return JOB_IMPORT_LIMITS.maxPdfBytes
    case 'text/markdown': return JOB_IMPORT_LIMITS.maxMarkdownBytes
    case 'text/html': return MAX_HTML_BYTES
    case 'application/json': return MAX_DOCUMENT_BYTES
  }
}

function cosmosStatus(error: unknown): number | undefined {
  return error instanceof ErrorResponse && typeof error.code === 'number' ? error.code : undefined
}

function blobStatus(error: unknown): number | undefined {
  return error instanceof RestError ? error.statusCode : undefined
}

function omitCosmosFields<T extends object>(value: CosmosDoc<T>): T {
  const result: Record<string, unknown> = { ...value }
  for (const key of Object.keys(result)) {
    if (key.startsWith('_')) delete result[key]
  }
  return result as T
}

function decodeJob(value: CosmosDoc<RealJobRecord>, expectedWorkspaceId?: string, expectedJobId?: string): VersionedRealJob {
  if (typeof value._etag !== 'string') throw new Error('Stored job record is missing an etag.')
  const record = omitCosmosFields(value)
  if (!validateRealJobRecord(record) ||
    (expectedWorkspaceId !== undefined && record.workspaceId !== expectedWorkspaceId) ||
    (expectedJobId !== undefined && record.id !== expectedJobId)) {
    throw new Error('Stored job record has an invalid ownership or data shape.')
  }
  return { record, etag: value._etag }
}

function rubricRecordId(rubric: Rubric): string {
  return `rubric-version:${rubric.id}:${rubric.version}`
}

function decodeRubricRecord(value: unknown, workspaceId: string, jobId?: string, rubricId?: string): RubricVersionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Stored rubric record has an invalid shape.')
  const record = omitCosmosFields(value as CosmosDoc<RubricVersionRecord>)
  if (record.recordType !== 'rubric-version' || record.workspaceId !== workspaceId ||
    (jobId !== undefined && record.jobId !== jobId) ||
    (rubricId !== undefined && record.rubricId !== rubricId) ||
    record.id !== rubricRecordId(record.rubric) || record.jobId !== record.rubric.jobId ||
    record.rubricId !== record.rubric.id || record.version !== record.rubric.version ||
    !validateStoredRealRubric(record.rubric)) {
    throw new Error('Stored rubric record has an invalid ownership or data shape.')
  }
  return record
}

function validateWriteRecord(record: RealJobRecord): void {
  if (!validateRealJobRecord(record)) throw new Error('Refusing to write an invalid real job record.')
}

function validateWriteRubric(record: RealJobRecord, rubric: Rubric): void {
  if (!validateStoredRealRubric(rubric) || rubric.jobId !== record.id || record.job.rubricId !== rubric.id) {
    throw new Error('Refusing to publish an invalid or mismatched real rubric.')
  }
}

export function createAzureJobStore(config: RealJobsConfig, credential: TokenCredential): RealJobStore {
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  const container: Container = client.database(config.database).container(config.container)

  return {
    async get(workspaceId, jobId) {
      try {
        const response = await container.item(jobId, workspaceId).read<CosmosDoc<RealJobRecord>>()
        if (response.statusCode === 404 || !response.resource) return undefined
        return decodeJob(response.resource, workspaceId, jobId)
      } catch (error) {
        if (cosmosStatus(error) === 404) return undefined
        throw error
      }
    },

    async list(workspaceId, continuationToken) {
      const iterator = container.items.query<CosmosDoc<RealJobRecord>>(
        {
          query: 'SELECT * FROM c WHERE c.recordType = @recordType ORDER BY c.updatedAt DESC',
          parameters: [{ name: '@recordType', value: 'job' }],
        },
        { partitionKey: workspaceId, maxItemCount: LIST_PAGE_SIZE, continuationToken },
      )
      const response = await fetchCosmosPage(iterator)
      const jobs = response.resources.map((resource) => decodeJob(resource, workspaceId))
      return {
        jobs,
        ...(response.continuationToken ? { continuationToken: response.continuationToken } : {}),
      }
    },

    async create(record) {
      validateWriteRecord(record)
      try {
        const response = await container.items.create<CosmosDoc<RealJobRecord>>(record)
        if (!response.resource) throw new Error('Cosmos did not return the created job record.')
        return { created: true, value: decodeJob(response.resource, record.workspaceId, record.id) }
      } catch (error) {
        if (cosmosStatus(error) !== 409) throw error
        const existing = await this.get(record.workspaceId, record.id)
        if (!existing) throw new Error('Cosmos reported a duplicate job record that could not be read.')
        return { created: false, value: existing }
      }
    },

    async replace(record, expectedEtag) {
      validateWriteRecord(record)
      try {
        const response = await container.item(record.id, record.workspaceId).replace<CosmosDoc<RealJobRecord>>(
          record,
          { accessCondition: { type: 'IfMatch', condition: expectedEtag } },
        )
        if (!response.resource) throw new Error('Cosmos did not return the replaced job record.')
        return decodeJob(response.resource, record.workspaceId, record.id)
      } catch (error) {
        if ([404, 409, 412].includes(cosmosStatus(error) ?? 0)) {
          throw new StoreConflictError('The job changed since it was last loaded.')
        }
        throw error
      }
    },

    async listPending(now, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Pending job limit must be between 1 and 100.')
      const response = await container.items.query<CosmosDoc<RealJobRecord>>({
        query: `SELECT TOP @limit * FROM c
          WHERE c.recordType = @recordType
          AND ARRAY_CONTAINS(@statuses, c.job.status)
          AND (NOT IS_DEFINED(c.nextAttemptAt) OR c.nextAttemptAt <= @now)
          AND (NOT IS_DEFINED(c.lease) OR c.lease.expiresAt <= @now)
          ORDER BY c.job.createdAt ASC`,
        parameters: [
          { name: '@limit', value: limit },
          { name: '@recordType', value: 'job' },
          { name: '@statuses', value: ['queued', 'parsing', 'generating'] },
          { name: '@now', value: now },
        ],
      }).fetchAll()
      return response.resources.map((resource) => decodeJob(resource))
    },

    async getRubric(workspaceId, rubricId) {
      const response = await container.items.query<CosmosDoc<RubricVersionRecord>>(
        {
          query: `SELECT TOP 1 * FROM c
            WHERE c.recordType = @recordType AND c.rubricId = @rubricId
            ORDER BY c.version DESC`,
          parameters: [
            { name: '@recordType', value: 'rubric-version' },
            { name: '@rubricId', value: rubricId },
          ],
        },
        { partitionKey: workspaceId },
      ).fetchAll()
      const value = response.resources[0]
      return value ? decodeRubricRecord(value, workspaceId, undefined, rubricId).rubric : undefined
    },

    async listRubrics(workspaceId, jobId) {
      const response = await container.items.query<CosmosDoc<RubricVersionRecord>>(
        {
          query: `SELECT * FROM c
            WHERE c.recordType = @recordType AND c.jobId = @jobId
            ORDER BY c.version ASC`,
          parameters: [
            { name: '@recordType', value: 'rubric-version' },
            { name: '@jobId', value: jobId },
          ],
        },
        { partitionKey: workspaceId },
      ).fetchAll()
      return response.resources.map((value) => decodeRubricRecord(value, workspaceId, jobId).rubric)
    },

    async publish(record, expectedEtag, rubric) {
      validateWriteRecord(record)
      validateWriteRubric(record, rubric)
      const rubricRecord: RubricVersionRecord = {
        id: rubricRecordId(rubric),
        workspaceId: record.workspaceId,
        recordType: 'rubric-version',
        jobId: record.id,
        rubricId: rubric.id,
        version: rubric.version,
        rubric,
      }
      let response
      try {
        response = await container.items.batch(
          [
            { operationType: 'Create', resourceBody: rubricRecord as unknown as JSONObject },
            { operationType: 'Replace', id: record.id, resourceBody: record as unknown as JSONObject, ifMatch: expectedEtag },
          ],
          record.workspaceId,
        )
      } catch (error) {
        if ([404, 409, 412, 424].includes(cosmosStatus(error) ?? 0)) {
          throw new StoreConflictError('The job or rubric version changed before publication.')
        }
        throw error
      }
      const results = response.result ?? []
      if (results.length !== 2 || results.some((result) => result.statusCode < 200 || result.statusCode >= 300)) {
        const status = results.find((result) => result.statusCode >= 400)?.statusCode ?? response.code
        if ([404, 409, 412, 424].includes(status ?? 0)) {
          throw new StoreConflictError('The job or rubric version changed before publication.')
        }
        throw new Error(`Cosmos rubric publication did not succeed (batch status ${status ?? 'unknown'}).`)
      }
      const etag = results[1]?.eTag
      if (typeof etag !== 'string') throw new Error('Cosmos did not return the published job etag.')
      return { record, etag }
    },
  }
}

interface JobBlobContainer {
  getBlockBlobClient(path: string): {
    download(): Promise<Pick<Awaited<ReturnType<BlockBlobClient['download']>>,
      'readableStreamBody' | 'etag' | 'contentType' | 'contentLength'>>
    upload(...args: Parameters<BlockBlobClient['upload']>): Promise<Pick<Awaited<ReturnType<BlockBlobClient['upload']>>, 'etag'>>
  }
}

async function readBounded(
  stream: NodeJS.ReadableStream,
  declaredLength: number | undefined,
  maximumBytes: number,
): Promise<Uint8Array> {
  const destroy = () => { if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy() }
  if (declaredLength !== undefined && (!Number.isInteger(declaredLength) || declaredLength < 1 || declaredLength > maximumBytes)) {
    destroy()
    throw new Error('Stored job blob exceeds the supported size or is empty.')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.byteLength
    if (length > maximumBytes) {
      destroy()
      throw new Error('Stored job blob exceeds the supported size.')
    }
    chunks.push(buffer)
  }
  if (!length || (declaredLength !== undefined && length !== declaredLength)) throw new Error('Stored job blob length is invalid.')
  return Buffer.concat(chunks, length)
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function createAzureJobBlobStore(config: RealJobsConfig, credential: TokenCredential): JobBlobStore {
  const service = new BlobServiceClient(config.storageAccountUrl, credential)
  return createJobBlobStoreFromContainer(service.getContainerClient(config.blobContainer))
}

export function createJobBlobStoreFromContainer(container: JobBlobContainer): JobBlobStore {
  async function read(blobName: string): Promise<JobBlob | undefined> {
    if (!isSafeJobBlobName(blobName)) throw new Error('Invalid job blob name.')
    try {
      const response = await container.getBlockBlobClient(blobName).download()
      if (!response.readableStreamBody) throw new Error('Blob download returned no content stream.')
      if (typeof response.etag !== 'string' || !response.etag.trim() || response.contentType !== jobBlobContentType(blobName)) {
        throw new Error('Blob download did not return required metadata.')
      }
      const bytes = await readBounded(response.readableStreamBody, response.contentLength, maxBlobBytes(blobName))
      return { bytes, contentType: response.contentType, sha256: hash(bytes), etag: response.etag }
    } catch (error) {
      if (blobStatus(error) === 404) return undefined
      throw error
    }
  }

  async function putImmutable(blobName: string, bytes: Uint8Array, contentType: string) {
    if (!isSafeJobBlobName(blobName)) throw new Error('Invalid job blob name.')
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maxBlobBytes(blobName)) {
      throw new Error('Job blob exceeds the supported size or is empty.')
    }
    if (contentType !== jobBlobContentType(blobName)) throw new Error('Unsupported job blob content type for its namespace.')
    const body = Buffer.from(bytes)
    try {
      const response = await container.getBlockBlobClient(blobName).upload(body, body.byteLength, {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'private, no-store' },
      })
      if (typeof response.etag !== 'string' || !response.etag.trim()) throw new Error('Blob upload did not return an etag.')
      return {
        created: true,
        blob: { bytes: body, contentType, sha256: hash(body), etag: response.etag },
      }
    } catch (error) {
      if (![409, 412].includes(blobStatus(error) ?? 0)) throw error
      const existing = await read(blobName)
      if (!existing) throw new Error('Blob reported an immutable-write conflict but could not be read.')
      return { created: false, blob: existing }
    }
  }

  return { read, putImmutable }
}
