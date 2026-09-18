import assert from 'node:assert/strict'
import { ErrorResponse } from '@azure/cosmos'

const clone = value => structuredClone(value)

function cosmosError(status) {
  const error = new ErrorResponse(`Cosmos ${status}`)
  error.code = status
  return error
}

export function fakeJobCosmos() {
  const records = new Map()
  const batches = []
  let counter = 0
  let beforeBatch
  let queryPage
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  const write = doc => {
    const saved = { ...clone(doc), _etag: `"cosmos-${++counter}"` }
    records.set(key(doc.workspaceId, doc.id), saved)
    return saved
  }
  function queryRows(spec, options = {}) {
    const params = Object.fromEntries((spec.parameters ?? []).map(p => [p.name, p.value]))
    let rows = [...records.values()].filter(value => !options.partitionKey || value.workspaceId === options.partitionKey)
    if (params['@recordType']) rows = rows.filter(value => value.recordType === params['@recordType'])
    if (params['@types']) rows = rows.filter(value => params['@types'].includes(value.recordType))
    if (params['@jobId']) rows = rows.filter(value => value.jobId === params['@jobId'])
    if (params['@rubricId']) rows = rows.filter(value => value.rubricId === params['@rubricId'])
    if (params['@statuses']) {
      rows = rows.filter(value => params['@statuses'].includes(value.job?.status) &&
        (!value.nextAttemptAt || value.nextAttemptAt <= params['@now']) &&
        (!value.lease || value.lease.expiresAt <= params['@now']))
    }
    if (spec.query.includes('OR IS_DEFINED(c.rubricLifecycle.deletingAt)')) {
      rows = rows.filter(value => value.lifecycle?.deletingAt || value.rubricLifecycle?.deletingAt)
    }
    if (spec.query.includes('NOT IS_DEFINED(c.lifecycle.archivedAt)')) {
      rows = rows.filter(value => !value.lifecycle?.archivedAt && !value.lifecycle?.deletingAt && !value.lifecycle?.deletedAt &&
        !value.rubricLifecycle?.archivedAt && !value.rubricLifecycle?.deletingAt && !value.rubricLifecycle?.deletedAt &&
        !value.job.rubricDeletedAt)
    }
    if (spec.query.includes('ORDER BY c.id ASC')) rows.sort((a, b) => a.id.localeCompare(b.id))
    else if (spec.query.includes('ORDER BY c.updatedAt DESC')) rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    else if (spec.query.includes('ORDER BY c.version')) rows.sort((a, b) => (a.version - b.version) * (spec.query.includes('DESC') ? -1 : 1))
    if (spec.query.startsWith('SELECT DISTINCT')) rows = [...new Set(rows.map(value => value.workspaceId))]
    if (params['@limit']) rows = rows.slice(0, params['@limit'])
    if (spec.query.includes('TOP 1 ')) rows = rows.slice(0, 1)
    return rows
  }
  const container = {
    item(id, workspaceId) {
      return {
        async read() {
          const value = records.get(key(workspaceId, id))
          return value ? { resource: clone(value), statusCode: 200 } : { statusCode: 404 }
        },
        async delete() {
          if (!records.delete(key(workspaceId, id))) throw cosmosError(404)
          return { statusCode: 204 }
        },
      }
    },
    items: {
      async create(doc) {
        if (records.has(key(doc.workspaceId, doc.id))) throw cosmosError(409)
        return { resource: clone(write(doc)), statusCode: 201 }
      },
      query(spec, options) {
        let continuationToken = options?.continuationToken
        let fetchCount = 0
        return {
          async fetchAll() { return { resources: queryRows(spec, options).map(clone) } },
          async fetchNext() {
            const readPage = (token = continuationToken) => {
              const rows = queryRows(spec, options)
              const offset = Number(token ?? 0)
              const size = options?.maxItemCount ?? 50
              return {
                resources: rows.slice(offset, offset + size).map(clone),
                ...(offset + size < rows.length ? { continuationToken: String(offset + size) } : {}),
              }
            }
            const page = queryPage ? await queryPage(spec, { ...options, continuationToken }, readPage, fetchCount++) : readPage()
            if (Array.isArray(page.resources) &&
              !(page.resources.length === 0 && page.hasMoreResults === true && !page.continuationToken)) {
              continuationToken = page.continuationToken
            }
            return page
          },
        }
      },
      async batch(operations, workspaceId) {
        assert.ok(operations.length <= 100)
        assert.ok(Buffer.byteLength(JSON.stringify(operations)) < 1_800_000)
        if (beforeBatch) {
          const callback = beforeBatch
          beforeBatch = undefined
          await callback(operations)
        }
        batches.push(clone(operations))
        const snapshot = new Map([...records].map(([key, value]) => [key, clone(value)]))
        const result = []
        for (const [index, op] of operations.entries()) {
          const id = op.id ?? op.resourceBody.id
          const itemKey = key(workspaceId, id)
          const existing = snapshot.get(itemKey)
          let status
          if (op.operationType === 'Create' && existing) status = 409
          else if (op.operationType !== 'Create' && !existing) status = 404
          else if (op.ifMatch && existing?._etag !== op.ifMatch) status = 412
          if (status) return { code: status, result: operations.map((_, i) => ({ statusCode: i === index ? status : 424 })) }
          if (op.resourceBody) assert.equal(op.resourceBody.workspaceId, workspaceId)
          if (op.operationType === 'Delete') snapshot.delete(itemKey)
          else if (op.operationType !== 'Read') snapshot.set(itemKey, { ...clone(op.resourceBody), _etag: `"cosmos-${++counter}"` })
          result.push({ statusCode: op.operationType === 'Create' ? 201 : op.operationType === 'Delete' ? 204 : 200, eTag: snapshot.get(itemKey)?._etag })
        }
        records.clear()
        for (const [key, value] of snapshot) records.set(key, value)
        return { code: 200, result }
      },
    },
  }
  return {
    container, records, batches, write,
    beforeBatch(callback) { beforeBatch = callback },
    queryPages(callback) { queryPage = callback },
  }
}

export const JOB_TEST_WORKSPACE = 'workspace-one'
export const JOB_TEST_ID = 'job-123e4567-e89b-42d3-a456-426614174000'
export const JOB_TEST_TIME = '2026-09-18T12:00:00.000Z'

export function realJobRecord(workspaceId = JOB_TEST_WORKSPACE, jobId = JOB_TEST_ID) {
  return {
    id: jobId, workspaceId, recordType: 'job',
    job: {
      id: jobId, title: 'Test role', organization: '', location: '', arrangement: '', employmentType: '',
      grade: '', series: '', source: 'url', sourceLabel: 'https://jobs.example/role', documentId: `document-${jobId.slice(4)}`,
      rubricId: null, status: 'queued', createdAt: JOB_TEST_TIME, dataKind: 'real',
    },
    source: { kind: 'url', displayName: 'https://jobs.example/role', url: 'https://jobs.example/role' },
    inputFingerprint: 'fingerprint', createdBy: 'user', updatedAt: JOB_TEST_TIME, attempts: 0,
    nextAttemptAt: JOB_TEST_TIME, warnings: [],
  }
}

export function realJobRubric(record, version = 1) {
  return {
    id: `rubric-${record.id}`, groupId: `logical-${record.id}`, kind: 'job', jobId: record.id,
    name: 'Test rubric', description: 'Grounded role criteria.', version, createdAt: JOB_TEST_TIME, dataKind: 'real',
    provenance: { kind: 'generated', model: 'test', promptVersion: 'test-v1' },
    criteria: [{
      id: 'criterion-1', key: 'custom', label: 'Experience', description: 'Demonstrated experience.', weight: 100,
      guidance: 'Look for evidence.', requirementType: 'required',
      sourceCitations: [{ documentId: record.job.documentId, documentVersion: 1, paragraphId: 'p1', page: 1, heading: '', quote: 'Experience required.' }],
    }],
  }
}
