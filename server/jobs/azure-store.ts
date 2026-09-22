import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { preservesProcessingSettings } from './policy'
import { CosmosClient, ErrorResponse } from '@azure/cosmos'
import type { Container, JSONObject, OperationInput, OperationResponse } from '@azure/cosmos'
import { BlobServiceClient, RestError } from '@azure/storage-blob'
import type { BlockBlobClient, ContainerClient } from '@azure/storage-blob'
import type { TokenCredential } from '@azure/identity'
import { JOB_IMPORT_LIMITS } from '../../src/domain/real-jobs'
import type { RealJobRecord, VersionedRealJob } from '../../src/domain/real-jobs'
import type { Rubric } from '../../src/domain/types'
import { UPLOAD_CONTENT_TYPES } from '../../src/domain/document-formats'
import type { WorkspaceLifecycleControl } from '../lifecycle/contracts'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { isValidWorkspaceId } from '../ids'
import { StoreConflictError } from '../store'
import type { JobBlob, JobBlobStore, JobBlobWriter, JobBlobWriteFence, RealJobsConfig, RealJobStore } from './store'
import { assertJobWritable, cancelJobWork, isJobReadOnly } from './guards'
import { fetchCosmosCount, fetchCosmosPage } from '../cosmos-query'
import {
  isBlobInJobPrefix,
  isJobBlobInScope,
  isSafeJobBlobName,
  isValidJobId,
  isUuid,
  jobBlobPrefix,
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

interface WorkspaceGuard extends WorkspaceLifecycleControl {
  id: 'job-workspace-lifecycle'
  workspaceId: string
  recordType: 'workspace-lifecycle'
}

interface JobTombstone {
  id: string
  workspaceId: string
  recordType: 'job-tombstone'
  deletedAt: string
}

interface BlobWriterRecord extends JobBlobWriter {
  recordType: 'blob-writer'
}

interface JobBatchAdmission {
  id: string
  workspaceId: string
  recordType: 'job-batch'
  batchId: string
  createdBy: string
  maxItems: number
  jobIds: string[]
}

const LIST_PAGE_SIZE = 50
const GUARD_ID = 'job-workspace-lifecycle'
const WRITER_MILLISECONDS = 120_000
const BLOB_LEASE_SECONDS = 60
const BLOB_REQUEST_MILLISECONDS = 30_000
const MAX_HTML_BYTES = 24 * 1024 * 1024
const MAX_DOCUMENT_BYTES = JOB_IMPORT_LIMITS.maxSourceCharacters * 8

function maxBlobBytes(blobName: string): number {
  switch (jobBlobContentType(blobName)) {
    case 'application/pdf': return JOB_IMPORT_LIMITS.maxPdfBytes
    case UPLOAD_CONTENT_TYPES.docx: case UPLOAD_CONTENT_TYPES.doc: return JOB_IMPORT_LIMITS.maxFileBytes
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
  return createJobStoreFromContainer(container)
}

export function createJobStoreFromContainer(container: Pick<Container, 'items' | 'item'>): RealJobStore {
  async function read<T extends object>(workspaceId: string, id: string): Promise<CosmosDoc<T> | undefined> {
    if (!isValidWorkspaceId(workspaceId)) throw new Error('Invalid job workspace.')
    try {
      const response = await container.item(id, workspaceId).read<CosmosDoc<T>>()
      if (response.statusCode === 404 || !response.resource) return undefined
      return response.resource
    } catch (error) {
      if (cosmosStatus(error) === 404) return undefined
      throw error
    }
  }

  async function rawJob(workspaceId: string, jobId: string) {
    if (!isValidJobId(jobId)) throw new Error('Invalid job id.')
    const value = await read<RealJobRecord | JobTombstone>(workspaceId, jobId)
    if (value?.recordType === 'job-tombstone') {
      if (value.id !== jobId || value.workspaceId !== workspaceId || !Number.isFinite(Date.parse(value.deletedAt))) {
        throw new Error('Invalid job tombstone.')
      }
    }
    return value
  }

  async function guard(workspaceId: string): Promise<{ record: WorkspaceGuard; etag: string }> {
    let value = await read<WorkspaceGuard>(workspaceId, GUARD_ID)
    if (!value) {
      const initial: WorkspaceGuard = {
        id: GUARD_ID, workspaceId, recordType: 'workspace-lifecycle',
        state: 'active', updatedAt: new Date().toISOString(),
      }
      try {
        assertWorkspaceMutationLease(workspaceId)
        value = (await container.items.create<CosmosDoc<WorkspaceGuard>>(initial)).resource
      } catch (error) {
        if (cosmosStatus(error) !== 409) throw error
        value = await read<WorkspaceGuard>(workspaceId, GUARD_ID)
      }
    }
    if (!value || value.id !== GUARD_ID || value.workspaceId !== workspaceId ||
      value.recordType !== 'workspace-lifecycle' || typeof value._etag !== 'string' ||
      !['active', 'archived', 'deleting', 'deleted'].includes(value.state) ||
      !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid job workspace lifecycle guard.')
    return { record: omitCosmosFields(value), etag: value._etag }
  }

  async function guarded<T>(
    workspaceId: string,
    ordinary: boolean,
    prepare: (control: WorkspaceGuard) => Promise<{
      operations: OperationInput[]
      result: (results: OperationResponse[]) => T
      touch?: boolean
    }>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await guard(workspaceId)
      if (ordinary && current.record.state !== 'active') {
        throw new StoreConflictError('This workspace is archived or removed.')
      }
      const pending = await prepare(current.record)
      if (pending.operations.length === 0 && !pending.touch) return pending.result([])
      const operations: OperationInput[] = [
        { operationType: 'Replace', id: GUARD_ID, resourceBody: current.record as unknown as JSONObject, ifMatch: current.etag },
        ...pending.operations,
      ]
      let response
      try {
        assertWorkspaceMutationLease(workspaceId)
        response = await container.items.batch(operations, workspaceId)
      } catch (error) {
        if ([404, 409, 412, 424].includes(cosmosStatus(error) ?? 0)) {
          throw new StoreConflictError('The job changed before its guarded write.')
        }
        throw error
      }
      const results = response.result ?? []
      if (results[0]?.statusCode === 412) continue
      if (results.length !== operations.length || results.some(result => result.statusCode < 200 || result.statusCode >= 300)) {
        const status = results.find(result => result.statusCode >= 400 && result.statusCode !== 424)?.statusCode ?? response.code
        if ([404, 409, 412, 424].includes(status ?? 0)) throw new StoreConflictError('The job or rubric changed before its guarded write.')
        throw new Error(`Guarded job transaction failed (${status ?? 'unknown'}).`)
      }
      return pending.result(results.slice(1))
    }
    throw new StoreConflictError('The workspace changed during the job write. Retry with its current state.')
  }

  async function currentJob(workspaceId: string, jobId: string, expectedEtag?: string): Promise<VersionedRealJob> {
    const value = await rawJob(workspaceId, jobId)
    if (!value || value.recordType === 'job-tombstone') throw new StoreConflictError('The job has been removed.')
    const current = decodeJob(value, workspaceId, jobId)
    if (expectedEtag !== undefined && current.etag !== expectedEtag) throw new StoreConflictError('The job changed since it was last loaded.')
    return current
  }

  function validateBatch(stored: CosmosDoc<JobBatchAdmission>, workspaceId: string, batchId = stored.batchId): void {
    if (!isUuid(batchId) || stored.id !== `job-batch-${batchId}` || stored.workspaceId !== workspaceId ||
      stored.recordType !== 'job-batch' || stored.batchId !== batchId || typeof stored._etag !== 'string' || !stored.createdBy ||
      !Number.isInteger(stored.maxItems) || stored.maxItems < 1 || stored.maxItems > JOB_IMPORT_LIMITS.maxBatchFiles ||
      !Array.isArray(stored.jobIds) || stored.jobIds.length > stored.maxItems ||
      new Set(stored.jobIds).size !== stored.jobIds.length || stored.jobIds.some(id => !isValidJobId(id))) {
      throw new Error('Stored job import batch has invalid admission metadata.')
    }
  }

  async function batchAdmission(record: RealJobRecord): Promise<OperationInput[]> {
    const batchId = record.job.batchId
    if (!batchId) return []
    if (!isUuid(batchId)) throw new Error('Invalid job import batch identity.')
    const id = `job-batch-${batchId}`
    const stored = await read<JobBatchAdmission>(record.workspaceId, id)
    const limit = record.processingSettings?.settings.imports.jobs.maxBatchItems ?? JOB_IMPORT_LIMITS.maxBatchFiles
    if (stored) validateBatch(stored, record.workspaceId, batchId)
    if (stored && stored.createdBy !== record.createdBy) {
      throw new StoreConflictError('Every item in a job import batch must belong to the same importing user.')
    }
    if (stored?.jobIds.includes(record.id)) throw new StoreConflictError('This job batch slot was already consumed and cannot be reused.')
    const maxItems = Math.min(stored?.maxItems ?? limit, limit)
    if ((stored?.jobIds.length ?? 0) >= maxItems) {
      throw new StoreConflictError(`This job import batch has reached its ${maxItems}-item limit. Start a new batch.`)
    }
    const next: JobBatchAdmission = {
      id, workspaceId: record.workspaceId, recordType: 'job-batch', batchId, createdBy: record.createdBy,
      maxItems: stored?.maxItems ?? limit, jobIds: [...(stored?.jobIds ?? []), record.id],
    }
    return [stored
      ? { operationType: 'Replace', id, resourceBody: next as unknown as JSONObject, ifMatch: stored._etag }
      : { operationType: 'Create', resourceBody: next as unknown as JSONObject }]
  }

  function replacement(record: RealJobRecord, etag: string): OperationInput {
    validateWriteRecord(record)
    return { operationType: 'Replace', id: record.id, resourceBody: record as unknown as JSONObject, ifMatch: etag }
  }

  function written(record: RealJobRecord, results: OperationResponse[], index = 0): VersionedRealJob {
    const etag = results[index]?.eTag
    if (typeof etag !== 'string') throw new Error('Cosmos did not return the written job etag.')
    return { record, etag }
  }

  function writerRecord(value: CosmosDoc<BlobWriterRecord>, workspaceId: string, jobId?: string): BlobWriterRecord {
    if (value.recordType !== 'blob-writer' || value.workspaceId !== workspaceId ||
      (jobId !== undefined && value.jobId !== jobId) || !/^job-blob-writer:[0-9a-f-]{36}$/.test(value.id) ||
      !isBlobInJobPrefix(value.blobName, workspaceId, value.jobId) || !Number.isFinite(Date.parse(value.expiresAt)) ||
      (value.owner !== undefined && (typeof value.owner !== 'string' || !value.owner))) {
      throw new Error('Invalid job Blob writer reservation.')
    }
    return omitCosmosFields(value)
  }

  async function cleanupAllowed(workspaceId: string, jobId: string | undefined, control: WorkspaceGuard, rubricOnly = false) {
    if (control.state === 'deleting' || control.state === 'deleted') return
    if (jobId === undefined) throw new StoreConflictError('Workspace cleanup requires a deletion fence.')
    const raw = await rawJob(workspaceId, jobId)
    if (raw?.recordType === 'job-tombstone') return
    if (!raw) throw new StoreConflictError('Job cleanup requires a deletion fence.')
    const current = decodeJob(raw, workspaceId, jobId)
    if (!current.record.lifecycle?.deletingAt &&
      !(rubricOnly && current.record.rubricLifecycle?.deletingAt)) {
      throw new StoreConflictError('Job cleanup requires a deletion fence.')
    }
  }

  function recordsQuery(workspaceId: string, types: string[], jobId?: string, continuationToken?: string) {
    return container.items.query<CosmosDoc<RubricVersionRecord | BlobWriterRecord | RealJobRecord | JobBatchAdmission>>({
      query: `SELECT * FROM c WHERE ARRAY_CONTAINS(@types, c.recordType)
        ${jobId === undefined ? '' : 'AND c.jobId = @jobId'} ORDER BY c.id ASC`,
      parameters: [
        { name: '@types', value: types },
        ...(jobId === undefined ? [] : [{ name: '@jobId', value: jobId }]),
      ],
    }, { partitionKey: workspaceId, maxItemCount: LIST_PAGE_SIZE, continuationToken })
  }

  async function cleanupPage(workspaceId: string, types: string[], jobId?: string) {
    let continuationToken: string | undefined
    const tokens = new Set<string>()
    for (;;) {
      assertWorkspaceMutationLease(workspaceId)
      const page = await fetchCosmosPage(recordsQuery(workspaceId, types, jobId, continuationToken))
      const resources = page.resources
      if (resources.length || !page.continuationToken) return resources
      if (tokens.has(page.continuationToken)) throw new Error('Job cleanup pagination did not advance.')
      tokens.add(page.continuationToken)
      continuationToken = page.continuationToken
    }
  }

  async function deleteRecords(workspaceId: string, types: string[], jobId?: string) {
    for (;;) {
      const removed = await guarded(workspaceId, false, async control => {
        await cleanupAllowed(workspaceId, jobId, control, types.every(type => type === 'rubric-version'))
        const resources = await cleanupPage(workspaceId, types, jobId)
        for (const value of resources) {
          if (value.recordType === 'rubric-version') decodeRubricRecord(value, workspaceId, jobId)
          else if (value.recordType === 'blob-writer') {
            const writer = writerRecord(value, workspaceId, jobId)
            if (Date.parse(writer.expiresAt) > Date.now()) throw new StoreConflictError('Job Blob writers have not drained.')
          } else if (value.recordType === 'job-batch' && jobId === undefined) validateBatch(value, workspaceId)
          else throw new Error('Refusing to purge an unexpected job record.')
        }
        return {
          operations: resources.map(value => ({ operationType: 'Delete' as const, id: value.id })),
          result: () => resources.length,
        }
      })
      if (removed === 0) return
    }
  }

  const store: RealJobStore = {
    async get(workspaceId, jobId) {
      const value = await rawJob(workspaceId, jobId)
      return value && value.recordType !== 'job-tombstone' ? decodeJob(value, workspaceId, jobId) : undefined
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

    async countActive(workspaceId) {
      if (!isValidWorkspaceId(workspaceId)) throw new Error('Invalid job workspace.')
      const blocked = await fetchCosmosCount(container.items.query({
        query: `SELECT VALUE COUNT(1) FROM c WHERE c.workspaceId = @workspaceId
          AND c.recordType = @recordType AND c.state != 'active'`,
        parameters: [{ name: '@workspaceId', value: workspaceId }, { name: '@recordType', value: 'workspace-lifecycle' }],
      }, { partitionKey: workspaceId }))
      if (blocked) throw new StoreConflictError('Job workspace lifecycle is not active.')
      return fetchCosmosCount(container.items.query({
        query: `SELECT VALUE COUNT(1) FROM c WHERE c.workspaceId = @workspaceId
          AND c.recordType = @recordType AND c.job.dataKind = 'real'
          AND NOT IS_DEFINED(c.lifecycle.archivedAt)
          AND NOT IS_DEFINED(c.lifecycle.deletingAt) AND NOT IS_DEFINED(c.lifecycle.deletedAt)`,
        parameters: [{ name: '@workspaceId', value: workspaceId }, { name: '@recordType', value: 'job' }],
      }, { partitionKey: workspaceId }))
    },

    async create(record) {
      validateWriteRecord(record)
      assertJobWritable(record)
      return guarded<{ created: boolean; value: VersionedRealJob }>(record.workspaceId, true, async () => {
        const existing = await rawJob(record.workspaceId, record.id)
        if (existing?.recordType === 'job-tombstone') throw new StoreConflictError('This import idempotency key belongs to a deleted job.')
        if (existing) {
          const value = decodeJob(existing, record.workspaceId, record.id)
          assertJobWritable(value.record)
          return { operations: [], result: () => ({ created: false, value }) }
        }
        const admissions = await batchAdmission(record)
        return {
          operations: [{ operationType: 'Create', resourceBody: record as unknown as JSONObject }, ...admissions],
          result: results => ({ created: true, value: written(record, results) }),
        }
      })
    },

    async replace(record, expectedEtag) {
      validateWriteRecord(record)
      return guarded(record.workspaceId, true, async () => {
        const current = await currentJob(record.workspaceId, record.id, expectedEtag)
        assertJobWritable(current.record)
        assertJobWritable(record)
        if (!preservesProcessingSettings(current.record.processingSettings, record.processingSettings)) {
          throw new StoreConflictError('Accepted job processing settings are immutable.')
        }
        if (JSON.stringify(record.lifecycle) !== JSON.stringify(current.record.lifecycle) ||
          JSON.stringify(record.rubricLifecycle) !== JSON.stringify(current.record.rubricLifecycle) ||
          record.job.rubricDeletedAt !== current.record.job.rubricDeletedAt) {
          throw new StoreConflictError('Lifecycle metadata must be changed through lifecycle management.')
        }
        if (record.displayName !== current.record.displayName &&
          !isDeepStrictEqual({ ...current.record, displayName: record.displayName, updatedAt: record.updatedAt }, record)) {
          throw new StoreConflictError('Display-name edits cannot change job sources, evidence, or processing state.')
        }
        if (record.updatedAt < current.record.updatedAt) throw new StoreConflictError('Job update timestamps cannot move backwards.')
        return { operations: [replacement(record, expectedEtag)], result: results => written(record, results) }
      })
    },

    async listPending(now, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Pending job limit must be between 1 and 100.')
      const result: VersionedRealJob[] = []
      const controls = new Map<string, WorkspaceLifecycleControl>()
      let continuationToken: string | undefined
      const tokens = new Set<string>()
      do {
        const response = await fetchCosmosPage(container.items.query<CosmosDoc<RealJobRecord>>({
          query: `SELECT * FROM c
          WHERE c.recordType = @recordType
          AND ARRAY_CONTAINS(@statuses, c.job.status)
          AND NOT IS_DEFINED(c.lifecycle.archivedAt) AND NOT IS_DEFINED(c.lifecycle.deletingAt) AND NOT IS_DEFINED(c.lifecycle.deletedAt)
          AND NOT IS_DEFINED(c.rubricLifecycle.archivedAt) AND NOT IS_DEFINED(c.rubricLifecycle.deletingAt) AND NOT IS_DEFINED(c.rubricLifecycle.deletedAt)
          AND NOT IS_DEFINED(c.job.rubricDeletedAt)
          AND (NOT IS_DEFINED(c.nextAttemptAt) OR c.nextAttemptAt <= @now)
          AND (NOT IS_DEFINED(c.lease) OR c.lease.expiresAt <= @now)
          ORDER BY c.job.createdAt ASC`,
          parameters: [
            { name: '@recordType', value: 'job' },
            { name: '@statuses', value: ['queued', 'parsing', 'generating'] },
            { name: '@now', value: now },
          ],
        }, { maxItemCount: limit, continuationToken }))
        for (const resource of response.resources) {
          const value = decodeJob(resource)
          let control = controls.get(value.record.workspaceId)
          if (!control) {
            control = await store.getWorkspaceLifecycle(value.record.workspaceId)
            controls.set(value.record.workspaceId, control)
          }
          if (control.state === 'active' && !isJobReadOnly(value.record)) result.push(value)
          if (result.length === limit) return result
        }
        continuationToken = response.continuationToken || undefined
        if (continuationToken) {
          if (tokens.has(continuationToken)) throw new Error('Pending job pagination did not advance.')
          tokens.add(continuationToken)
        }
      } while (continuationToken)
      return result
    },

    async pendingLifecycleWorkspaces(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Lifecycle workspace limit must be between 1 and 100.')
      const response = await container.items.query<string>({
        query: `SELECT DISTINCT TOP @limit VALUE c.workspaceId FROM c
          WHERE c.recordType = @recordType
          AND (IS_DEFINED(c.lifecycle.deletingAt) OR IS_DEFINED(c.rubricLifecycle.deletingAt))`,
        parameters: [{ name: '@limit', value: limit }, { name: '@recordType', value: 'job' }],
      }).fetchAll()
      const workspaceIds = [...new Set(response.resources)]
      if (workspaceIds.length > limit || workspaceIds.some(id => typeof id !== 'string' || !isValidWorkspaceId(id))) {
        throw new Error('Pending job cleanup returned invalid workspace scopes.')
      }
      return workspaceIds
    },

    async listLifecyclePending(workspaceId, continuationToken) {
      if (!isValidWorkspaceId(workspaceId)) throw new Error('Invalid job workspace.')
      const response = await fetchCosmosPage(container.items.query<CosmosDoc<RealJobRecord>>({
        query: `SELECT * FROM c WHERE c.recordType = @recordType
          AND (IS_DEFINED(c.lifecycle.deletingAt) OR IS_DEFINED(c.rubricLifecycle.deletingAt))
          ORDER BY c.id ASC`,
        parameters: [{ name: '@recordType', value: 'job' }],
      }, { partitionKey: workspaceId, maxItemCount: LIST_PAGE_SIZE, continuationToken }))
      return {
        jobs: response.resources.map(raw => decodeJob(raw, workspaceId)),
        ...(response.continuationToken ? { continuationToken: response.continuationToken } : {}),
      }
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
      if (!value) return undefined
      const decoded = decodeRubricRecord(value, workspaceId, undefined, rubricId)
      const owner = await store.get(workspaceId, decoded.jobId)
      if (!owner || owner.record.lifecycle?.deletingAt || owner.record.lifecycle?.deletedAt ||
        owner.record.rubricLifecycle?.deletingAt || owner.record.rubricLifecycle?.deletedAt) return undefined
      return decoded.rubric
    },

    async listRubrics(workspaceId, jobId) {
      const owner = await store.get(workspaceId, jobId)
      if (!owner || owner.record.lifecycle?.deletedAt || owner.record.rubricLifecycle?.deletedAt) return []
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
      return guarded(record.workspaceId, true, async () => {
        const current = await currentJob(record.workspaceId, record.id, expectedEtag)
        assertJobWritable(current.record)
        assertJobWritable(record)
        if (!preservesProcessingSettings(current.record.processingSettings, record.processingSettings)) {
          throw new StoreConflictError('Accepted job processing settings are immutable.')
        }
        if (JSON.stringify(record.lifecycle) !== JSON.stringify(current.record.lifecycle) ||
          JSON.stringify(record.rubricLifecycle) !== JSON.stringify(current.record.rubricLifecycle) ||
          record.job.rubricDeletedAt !== current.record.job.rubricDeletedAt ||
          record.displayName !== current.record.displayName) {
          throw new StoreConflictError('Publication cannot change lifecycle or display-name metadata.')
        }
        return {
          operations: [
            { operationType: 'Create', resourceBody: rubricRecord as unknown as JSONObject },
            replacement(record, expectedEtag),
          ],
          result: results => written(record, results, 1),
        }
      })
    },

    async getWorkspaceLifecycle(workspaceId) {
      const current = await guard(workspaceId)
      return { state: current.record.state, updatedAt: current.record.updatedAt }
    },

    async setWorkspaceLifecycle(workspaceId, state, timestamp) {
      await guarded(workspaceId, false, async current => {
        if ((current.state === 'deleted' && state !== 'deleted') ||
          (current.state === 'deleting' && !['deleting', 'deleted'].includes(state))) {
          throw new StoreConflictError('A removed workspace cannot be restored.')
        }
        // The guard is already the first batch write; mutate that exact replacement.
        current.state = state
        current.updatedAt = timestamp
        return {
          operations: [],
          touch: true,
          result: () => undefined,
        }
      })
    },

    async cancelWorkspace(workspaceId, timestamp) {
      const control = await store.getWorkspaceLifecycle(workspaceId)
      if (control.state === 'active') throw new StoreConflictError('Workspace cancellation requires a lifecycle fence.')
      let continuationToken: string | undefined
      const tokens = new Set<string>()
      do {
        const page = await fetchCosmosPage(recordsQuery(workspaceId, ['job'], undefined, continuationToken))
        for (const raw of page.resources) {
          const value = decodeJob(raw as CosmosDoc<RealJobRecord>, workspaceId)
          await guarded(workspaceId, false, async currentControl => {
            if (currentControl.state === 'active') throw new StoreConflictError('Workspace cancellation lost its fence.')
            const current = await currentJob(workspaceId, value.record.id)
            const record = cancelJobWork(current.record, timestamp)
            return { operations: [replacement(record, current.etag)], result: () => undefined }
          })
        }
        continuationToken = page.continuationToken || undefined
        if (continuationToken) {
          if (tokens.has(continuationToken)) throw new Error('Job cancellation pagination did not advance.')
          tokens.add(continuationToken)
        }
      } while (continuationToken)
    },

    async transitionLifecycle(workspaceId, jobId, expectedEtag, scope, action, timestamp) {
      return guarded(workspaceId, false, async control => {
        if (control.state === 'deleted' || (control.state === 'deleting' && action !== 'delete')) {
          throw new StoreConflictError('This workspace is being removed.')
        }
        const current = await currentJob(workspaceId, jobId, expectedEtag)
        const key = scope === 'job' ? 'lifecycle' : 'rubricLifecycle'
        const metadata = current.record[key] ?? {}
        if (metadata.deletedAt || (metadata.deletingAt && action !== 'delete') ||
          (scope === 'rubric' && current.record.lifecycle?.deletingAt)) {
          throw new StoreConflictError('A removed item cannot be restored or edited.')
        }
        if (action === 'delete' && metadata.deletingAt) return { operations: [], result: () => current }
        const updated = { ...metadata, ...(scope === 'rubric' ? { parentKey: `job:${jobId}` } : {}) }
        if (action === 'archive') updated.archivedAt = timestamp
        else if (action === 'unarchive') delete updated.archivedAt
        else updated.deletingAt = timestamp
        const record: RealJobRecord = {
          ...(action === 'unarchive' ? current.record : cancelJobWork(current.record, timestamp)),
          [key]: updated,
          updatedAt: timestamp,
        }
        return { operations: [replacement(record, current.etag)], result: results => written(record, results) }
      })
    },

    async completeRubricDeletion(workspaceId, jobId, expectedEtag, timestamp) {
      return guarded(workspaceId, false, async () => {
        const current = await currentJob(workspaceId, jobId, expectedEtag)
        if (!current.record.rubricLifecycle?.deletingAt) throw new StoreConflictError('Rubric deletion is not pending.')
        const remaining = await cleanupPage(workspaceId, ['rubric-version'], jobId)
        if (remaining.length) throw new StoreConflictError('Rubric cleanup has not completed.')
        const record: RealJobRecord = {
          ...cancelJobWork(current.record, timestamp),
          job: { ...current.record.job, status: 'ready', rubricId: null, rubricDeletedAt: timestamp, error: undefined, errorStage: undefined },
          error: undefined,
          rubricLifecycle: { parentKey: `job:${jobId}`, deletedAt: timestamp },
        }
        return { operations: [replacement(record, current.etag)], result: results => written(record, results) }
      })
    },

    async purgeRubrics(workspaceId, jobId) {
      await deleteRecords(workspaceId, ['rubric-version'], jobId)
    },

    async purgeJobRecords(workspaceId, jobId, timestamp) {
      await deleteRecords(workspaceId, ['rubric-version', 'blob-writer'], jobId)
      await guarded(workspaceId, false, async control => {
        await cleanupAllowed(workspaceId, jobId, control)
        const remaining = await cleanupPage(workspaceId, ['rubric-version', 'blob-writer'], jobId)
        if (remaining.length) throw new StoreConflictError('Job cleanup has not completed.')
        const raw = await rawJob(workspaceId, jobId)
        if (raw?.recordType === 'job-tombstone') return { operations: [], result: () => undefined }
        const current = await currentJob(workspaceId, jobId)
        const tombstone: JobTombstone = { id: jobId, workspaceId, recordType: 'job-tombstone', deletedAt: timestamp }
        return {
          operations: [{ operationType: 'Replace', id: jobId, resourceBody: tombstone as unknown as JSONObject, ifMatch: current.etag }],
          result: () => undefined,
        }
      })
    },

    async purgeWorkspaceRecords(workspaceId, timestamp) {
      await deleteRecords(workspaceId, ['rubric-version', 'blob-writer', 'job-batch'])
      for (;;) {
        const removed = await guarded(workspaceId, false, async control => {
          await cleanupAllowed(workspaceId, undefined, control)
          const remaining = await cleanupPage(workspaceId, ['rubric-version', 'blob-writer', 'job-batch'])
          if (remaining.length) throw new StoreConflictError('Workspace job cleanup has not completed.')
          const records = await cleanupPage(workspaceId, ['job'])
          const operations: OperationInput[] = records.map(raw => {
            const current = decodeJob(raw as CosmosDoc<RealJobRecord>, workspaceId)
            const tombstone: JobTombstone = {
              id: current.record.id, workspaceId, recordType: 'job-tombstone', deletedAt: timestamp,
            }
            return { operationType: 'Replace', id: tombstone.id, resourceBody: tombstone as unknown as JSONObject, ifMatch: current.etag }
          })
          return { operations, result: () => operations.length }
        })
        if (!removed) return
      }
    },

    async beginBlobWrite(workspaceId, jobId, blobName, owner) {
      if (!isBlobInJobPrefix(blobName, workspaceId, jobId)) throw new Error('Invalid job Blob writer scope.')
      return guarded(workspaceId, true, async () => {
        const raw = await rawJob(workspaceId, jobId)
        if (raw?.recordType === 'job-tombstone') throw new StoreConflictError('This job has been removed.')
        if (raw) {
          const current = decodeJob(raw, workspaceId, jobId)
          assertJobWritable(current.record)
          if (owner && (current.record.lease?.owner !== owner || Date.parse(current.record.lease.expiresAt) <= Date.now())) {
            throw new StoreConflictError('The source writer no longer owns this job.')
          }
        } else if (owner) throw new StoreConflictError('The source writer job has been removed.')
        const writer: BlobWriterRecord = {
          id: `job-blob-writer:${randomUUID()}`, workspaceId, jobId, blobName,
          expiresAt: new Date(Date.now() + WRITER_MILLISECONDS).toISOString(), recordType: 'blob-writer',
          ...(owner ? { owner } : {}),
        }
        return {
          operations: [{ operationType: 'Create', resourceBody: writer as unknown as JSONObject }],
          result: () => writer,
        }
      })
    },

    async assertBlobWrite(writer) {
      const control = await store.getWorkspaceLifecycle(writer.workspaceId)
      if (control.state !== 'active' || Date.parse(writer.expiresAt) <= Date.now()) {
        throw new StoreConflictError('The job Blob writer has been fenced.')
      }
      const raw = await read<BlobWriterRecord>(writer.workspaceId, writer.id)
      const stored = raw ? writerRecord(raw, writer.workspaceId, writer.jobId) : undefined
      if (!stored || stored.blobName !== writer.blobName || stored.expiresAt !== writer.expiresAt ||
        stored.owner !== writer.owner) {
        throw new StoreConflictError('The job Blob writer reservation is no longer current.')
      }
      const job = await rawJob(writer.workspaceId, writer.jobId)
      if (job?.recordType === 'job-tombstone') throw new StoreConflictError('The job has been removed.')
      if (job) {
        const current = decodeJob(job, writer.workspaceId, writer.jobId)
        assertJobWritable(current.record)
        if (writer.owner && (current.record.lease?.owner !== writer.owner ||
          Date.parse(current.record.lease.expiresAt) <= Date.now())) {
          throw new StoreConflictError('The source writer no longer owns this job.')
        }
      } else if (writer.owner) throw new StoreConflictError('The source writer job was removed.')
    },

    async finishBlobWrite(writer) {
      const raw = await read<BlobWriterRecord>(writer.workspaceId, writer.id)
      if (!raw) return
      const stored = writerRecord(raw, writer.workspaceId, writer.jobId)
      if (stored.blobName !== writer.blobName || stored.expiresAt !== writer.expiresAt) {
        throw new Error('Refusing to release a different job Blob writer.')
      }
      try {
        await container.item(writer.id, writer.workspaceId).delete()
      } catch (error) {
        if (cosmosStatus(error) !== 404) throw error
      }
    },

    async listBlobWriters(workspaceId, jobId) {
      const writers: JobBlobWriter[] = []
      let continuationToken: string | undefined
      const tokens = new Set<string>()
      do {
        const page = await fetchCosmosPage(recordsQuery(workspaceId, ['blob-writer'], jobId, continuationToken))
        for (const raw of page.resources) writers.push(writerRecord(raw as CosmosDoc<BlobWriterRecord>, workspaceId, jobId))
        continuationToken = page.continuationToken || undefined
        if (continuationToken) {
          if (tokens.has(continuationToken)) throw new Error('Job Blob writer pagination did not advance.')
          tokens.add(continuationToken)
        }
      } while (continuationToken)
      return writers
    },
  }
  return store
}

interface JobBlobContainer {
  getBlockBlobClient(path: string): {
    download(): Promise<Pick<Awaited<ReturnType<BlockBlobClient['download']>>,
      'readableStreamBody' | 'etag' | 'contentType' | 'contentLength' | 'metadata'>>
    upload(...args: Parameters<BlockBlobClient['upload']>): Promise<Pick<Awaited<ReturnType<BlockBlobClient['upload']>>, 'etag'>>
    getProperties?: BlockBlobClient['getProperties']
    getBlobLeaseClient?: BlockBlobClient['getBlobLeaseClient']
    deleteIfExists?: BlockBlobClient['deleteIfExists']
  }
  listBlobsFlat?: ContainerClient['listBlobsFlat']
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
  const service = new BlobServiceClient(config.storageAccountUrl, credential, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: BLOB_REQUEST_MILLISECONDS },
  })
  return createJobBlobStoreFromContainer(service.getContainerClient(config.blobContainer))
}

export function createJobBlobStoreFromContainer(container: JobBlobContainer): JobBlobStore {
  async function read(blobName: string): Promise<JobBlob | undefined> {
    if (!isSafeJobBlobName(blobName)) throw new Error('Invalid job blob name.')
    try {
      const response = await container.getBlockBlobClient(blobName).download()
      if (response.metadata?.scorepreparing === 'true') return undefined
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

  async function putImmutable(blobName: string, bytes: Uint8Array, contentType: string, fence?: JobBlobWriteFence) {
    if (!isSafeJobBlobName(blobName)) throw new Error('Invalid job blob name.')
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maxBlobBytes(blobName)) {
      throw new Error('Job blob exceeds the supported size or is empty.')
    }
    if (contentType !== jobBlobContentType(blobName)) throw new Error('Unsupported job blob content type for its namespace.')
    const body = Buffer.from(bytes)
    if (fence) {
      const client = container.getBlockBlobClient(blobName)
      if (!client.getBlobLeaseClient || !client.getProperties) throw new Error('Job Blob lease fencing is unavailable.')
      if (fence.writer.blobName !== blobName ||
        !isBlobInJobPrefix(blobName, fence.writer.workspaceId, fence.writer.jobId)) throw new Error('Invalid job Blob writer scope.')
      const remaining = () => Date.parse(fence.writer.expiresAt) - Date.now()
      const assertTime = () => {
        if (remaining() <= BLOB_LEASE_SECONDS * 1000 + 5_000) {
          throw new StoreConflictError('The job Blob writer reservation expired before upload.')
        }
      }
      assertTime()
      await fence.assertActive()
      const timeout = AbortSignal.timeout(BLOB_REQUEST_MILLISECONDS)
      const signal = fence.signal ? AbortSignal.any([timeout, fence.signal]) : timeout
      try {
        // The only unfenced create contains no source data. A finite lease fences the content PUT itself.
        await client.upload(Buffer.alloc(0), 0, {
          conditions: { ifNoneMatch: '*' },
          metadata: { scorepreparing: 'true' },
          blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
          abortSignal: signal,
        })
      } catch (error) {
        if (![409, 412].includes(blobStatus(error) ?? 0)) throw error
        const existing = await read(blobName)
        if (existing) {
          await fence.assertActive()
          return { created: false, blob: existing }
        }
      }
      assertTime()
      const lease = client.getBlobLeaseClient(fence.writer.id.replace(/^job-blob-writer:/, ''))
      await lease.acquireLease(BLOB_LEASE_SECONDS, { abortSignal: signal })
      try {
        await fence.assertActive()
        assertTime()
        const properties = await client.getProperties({ abortSignal: signal })
        if (properties.metadata?.scorepreparing !== 'true') {
          const existing = await read(blobName)
          if (!existing) throw new Error('The immutable job source could not be read.')
          return { created: false, blob: existing }
        }
        const response = await client.upload(body, body.byteLength, {
          conditions: { ifMatch: properties.etag, leaseId: lease.leaseId },
          metadata: {},
          blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'private, no-store' },
          abortSignal: signal,
        })
        if (typeof response.etag !== 'string' || !response.etag.trim()) throw new Error('Blob upload did not return an etag.')
        await fence.assertActive()
        return { created: true, blob: { bytes: body, contentType, sha256: hash(body), etag: response.etag } }
      } finally {
        await lease.releaseLease({ abortSignal: AbortSignal.timeout(BLOB_REQUEST_MILLISECONDS) }).catch(() => undefined)
      }
    }
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

  return {
    read,
    putImmutable,
    async putFenced(blobName, bytes, contentType, fence) {
      if (!fence?.writer || typeof fence.assertActive !== 'function') throw new Error('A job Blob write fence is required.')
      return putImmutable(blobName, bytes, contentType, fence)
    },
    async list(workspaceId, jobId, continuationToken) {
      const prefix = jobBlobPrefix(workspaceId, jobId)
      if (!container.listBlobsFlat) throw new Error('Job Blob enumeration is unavailable.')
      const pages = container.listBlobsFlat({ prefix }).byPage({ continuationToken, maxPageSize: LIST_PAGE_SIZE })
      const page = await pages.next()
      if (page.done) return { names: [] }
      const names = page.value.segment.blobItems.map(item => item.name)
      if (names.some(name => !isJobBlobInScope(name, workspaceId, jobId))) {
        throw new Error('Job Blob enumeration returned an item outside its validated scope.')
      }
      return {
        names,
        ...(page.value.continuationToken ? { continuationToken: page.value.continuationToken } : {}),
      }
    },
    async delete(workspaceId, jobId, blobName) {
      if (!isJobBlobInScope(blobName, workspaceId, jobId)) throw new Error('Invalid job Blob deletion scope.')
      const client = container.getBlockBlobClient(blobName)
      if (!client.deleteIfExists || !client.getBlobLeaseClient) throw new Error('Job Blob deletion and fencing are unavailable.')
      try {
        await client.getBlobLeaseClient().breakLease(0, { abortSignal: AbortSignal.timeout(BLOB_REQUEST_MILLISECONDS) })
      } catch (error) {
        if (![404, 409].includes(blobStatus(error) ?? 0)) throw error
      }
      await client.deleteIfExists({ deleteSnapshots: 'include', abortSignal: AbortSignal.timeout(BLOB_REQUEST_MILLISECONDS) })
    },
  }
}
