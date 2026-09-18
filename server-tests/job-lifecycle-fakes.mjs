import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { StoreConflictError } from '../dist-server/app.mjs'

const clone = value => structuredClone(value)
const keyFor = (workspaceId, jobId) => `${workspaceId}/${jobId}`
const locked = value => Boolean(value?.archivedAt || value?.deletingAt || value?.deletedAt)
const readOnly = record => locked(record.lifecycle) || locked(record.rubricLifecycle) || record.job.rubricDeletedAt
const contentTypes = {
  'original.pdf': 'application/pdf',
  'original.md': 'text/markdown',
  'original.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'original.doc': 'application/msword',
  'original.html': 'text/html',
  'source-document.json': 'application/json',
}

function assertBlobScope(name, workspaceId, jobId) {
  const parts = name.split('/')
  assert.equal(parts.length, 3)
  assert.ok(contentTypes[parts[2]], 'only canonical original/extraction files can be written')
  if (workspaceId !== undefined) assert.equal(parts[0], workspaceId)
  if (jobId !== undefined) assert.equal(parts[1], jobId)
}

function assertLifecycleUnchanged(record, current) {
  if (JSON.stringify(record.lifecycle) !== JSON.stringify(current.lifecycle) ||
    JSON.stringify(record.rubricLifecycle) !== JSON.stringify(current.rubricLifecycle) ||
    record.job.rubricDeletedAt !== current.job.rubricDeletedAt) {
    throw new StoreConflictError('Lifecycle metadata must be changed through lifecycle management.')
  }
}

function cancel(record, timestamp) {
  return {
    ...record, updatedAt: timestamp, lease: undefined, nextAttemptAt: undefined,
    ...(['queued', 'parsing', 'generating'].includes(record.job.status) ? {
      job: { ...record.job, status: 'cancelled', error: 'Cancelled by lifecycle change.', errorStage: undefined },
      error: { code: 'cancelled', message: 'Cancelled by lifecycle change.', retryable: false },
    } : {}),
  }
}

export function createFakeRealJobs() {
  const records = new Map()
  const rubrics = new Map()
  const blobs = new Map()
  const tombstones = new Set()
  const controls = new Map()
  const writers = new Map()
  const publicationEvents = []
  let etagCounter = 0
  let failNextReplace = false
  let failDelete = false
  const nextEtag = () => `"job-etag-${++etagCounter}"`
  const control = workspaceId => controls.get(workspaceId) ?? { state: 'active', updatedAt: new Date().toISOString() }
  function writable(workspaceId, record) {
    if (control(workspaceId).state !== 'active' || (record && readOnly(record))) throw new StoreConflictError('Archived or removed.')
  }
  function current(workspaceId, jobId, etag) {
    const value = records.get(keyFor(workspaceId, jobId))
    if (!value || (etag !== undefined && value.etag !== etag)) throw new StoreConflictError()
    return clone(value)
  }
  function save(record) {
    const value = { record: clone(record), etag: nextEtag() }
    records.set(keyFor(record.workspaceId, record.id), value)
    return clone(value)
  }
  function assertCleanup(workspaceId, jobId, rubricOnly = false) {
    if (['deleting', 'deleted'].includes(control(workspaceId).state)) return
    if (tombstones.has(keyFor(workspaceId, jobId))) return
    const value = current(workspaceId, jobId).record
    if (!value.lifecycle?.deletingAt && !(rubricOnly && value.rubricLifecycle?.deletingAt)) throw new StoreConflictError()
  }
  const store = {
    async get(workspaceId, jobId) {
      const value = records.get(keyFor(workspaceId, jobId))
      return value ? clone(value) : undefined
    },
    async list(workspaceId, continuationToken) {
      const offset = continuationToken ? Number(continuationToken) : 0
      const values = [...records.values()].filter(value => value.record.workspaceId === workspaceId)
        .sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt))
      return { jobs: values.slice(offset, offset + 50).map(clone), ...(offset + 50 < values.length ? { continuationToken: String(offset + 50) } : {}) }
    },
    async create(record) {
      writable(record.workspaceId, record)
      const key = keyFor(record.workspaceId, record.id)
      if (tombstones.has(key)) throw new StoreConflictError('Deleted import key.')
      const existing = records.get(key)
      if (existing) {
        writable(record.workspaceId, existing.record)
        return { created: false, value: clone(existing) }
      }
      assert.ok(record.source.kind === 'url' || blobs.has(record.source.originalBlobName), 'source bytes must precede record publication')
      const value = save(record)
      publicationEvents.push({ type: 'job', key })
      return { created: true, value }
    },
    async replace(record, expectedEtag) {
      const value = current(record.workspaceId, record.id, expectedEtag)
      writable(record.workspaceId, value.record)
      writable(record.workspaceId, record)
      if (failNextReplace) {
        failNextReplace = false
        throw new StoreConflictError()
      }
      assertLifecycleUnchanged(record, value.record)
      return save(record)
    },
    async listPending(now, limit) {
      assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 100)
      return [...records.values()].filter(({ record }) =>
        control(record.workspaceId).state === 'active' && !readOnly(record) &&
        ['queued', 'parsing', 'generating'].includes(record.job.status) &&
        (!record.nextAttemptAt || record.nextAttemptAt <= now) && (!record.lease || record.lease.expiresAt <= now))
        .slice(0, limit).map(clone)
    },
    async pendingLifecycleWorkspaces(limit) {
      assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 100)
      return [...new Set([...records.values()].filter(({ record }) =>
        record.lifecycle?.deletingAt || record.rubricLifecycle?.deletingAt).map(({ record }) => record.workspaceId))].slice(0, limit)
    },
    async listLifecyclePending(workspaceId, continuationToken) {
      const offset = Number(continuationToken ?? 0)
      const pending = [...records.values()].filter(({ record }) => record.workspaceId === workspaceId &&
        (record.lifecycle?.deletingAt || record.rubricLifecycle?.deletingAt)).sort((a, b) => a.record.id.localeCompare(b.record.id))
      return {
        jobs: pending.slice(offset, offset + 50).map(clone),
        ...(offset + 50 < pending.length ? { continuationToken: String(offset + 50) } : {}),
      }
    },
    async getRubric(workspaceId, rubricId) {
      return [...rubrics.entries()].filter(([key]) => key.startsWith(`${workspaceId}/`))
        .flatMap(([, values]) => values).filter(rubric => {
          const owner = records.get(keyFor(workspaceId, rubric.jobId))?.record
          return rubric.id === rubricId && owner && !owner.lifecycle?.deletingAt && !owner.lifecycle?.deletedAt &&
            !owner.rubricLifecycle?.deletingAt && !owner.rubricLifecycle?.deletedAt
        }).sort((a, b) => b.version - a.version).map(clone)[0]
    },
    async listRubrics(workspaceId, jobId) {
      const owner = records.get(keyFor(workspaceId, jobId))?.record
      if (!owner || owner.lifecycle?.deletedAt || owner.rubricLifecycle?.deletedAt) return []
      return (rubrics.get(keyFor(workspaceId, jobId)) ?? []).slice().sort((a, b) => a.version - b.version).map(clone)
    },
    async publish(record, etag, rubric) {
      const value = current(record.workspaceId, record.id, etag)
      writable(record.workspaceId, value.record)
      writable(record.workspaceId, record)
      assertLifecycleUnchanged(record, value.record)
      const key = keyFor(record.workspaceId, record.id)
      const versions = rubrics.get(key) ?? []
      if (versions.some(value => value.id === rubric.id && value.version === rubric.version)) throw new StoreConflictError()
      rubrics.set(key, [...versions, clone(rubric)])
      return save(record)
    },
    async getWorkspaceLifecycle(workspaceId) { return clone(control(workspaceId)) },
    async setWorkspaceLifecycle(workspaceId, state, timestamp) {
      const previous = control(workspaceId).state
      if (previous === 'deleted' && state !== 'deleted') throw new StoreConflictError()
      if (previous === 'deleting' && !['deleting', 'deleted'].includes(state)) throw new StoreConflictError()
      controls.set(workspaceId, { state, updatedAt: timestamp })
    },
    async cancelWorkspace(workspaceId, timestamp) {
      if (control(workspaceId).state === 'active') throw new StoreConflictError()
      for (const value of records.values()) if (value.record.workspaceId === workspaceId) save(cancel(value.record, timestamp))
    },
    async transitionLifecycle(workspaceId, jobId, etag, scope, action, timestamp) {
      const state = control(workspaceId).state
      if (state === 'deleted' || (state === 'deleting' && action !== 'delete')) throw new StoreConflictError()
      const value = current(workspaceId, jobId, etag)
      const key = scope === 'job' ? 'lifecycle' : 'rubricLifecycle'
      const metadata = { ...value.record[key], ...(scope === 'rubric' ? { parentKey: `job:${jobId}` } : {}) }
      if (metadata.deletedAt || (metadata.deletingAt && action !== 'delete') ||
        (scope === 'rubric' && value.record.lifecycle?.deletingAt)) throw new StoreConflictError()
      if (metadata.deletingAt) return value
      if (action === 'archive') metadata.archivedAt = timestamp
      else if (action === 'unarchive') delete metadata.archivedAt
      else metadata.deletingAt = timestamp
      return save({ ...(action === 'unarchive' ? value.record : cancel(value.record, timestamp)), [key]: metadata, updatedAt: timestamp })
    },
    async completeRubricDeletion(workspaceId, jobId, etag, timestamp) {
      const value = current(workspaceId, jobId, etag)
      if (!value.record.rubricLifecycle?.deletingAt || (rubrics.get(keyFor(workspaceId, jobId)) ?? []).length) throw new StoreConflictError()
      return save({
        ...cancel(value.record, timestamp), error: undefined,
        job: { ...value.record.job, status: 'ready', rubricId: null, rubricDeletedAt: timestamp, error: undefined, errorStage: undefined },
        rubricLifecycle: { parentKey: `job:${jobId}`, deletedAt: timestamp },
      })
    },
    async purgeRubrics(workspaceId, jobId) {
      assertCleanup(workspaceId, jobId, true)
      rubrics.delete(keyFor(workspaceId, jobId))
    },
    async purgeJobRecords(workspaceId, jobId) {
      assertCleanup(workspaceId, jobId)
      if ([...writers.values()].some(writer => writer.workspaceId === workspaceId && writer.jobId === jobId && Date.parse(writer.expiresAt) > Date.now())) throw new StoreConflictError()
      rubrics.delete(keyFor(workspaceId, jobId))
      records.delete(keyFor(workspaceId, jobId))
      tombstones.add(keyFor(workspaceId, jobId))
      for (const [id, writer] of writers) if (writer.workspaceId === workspaceId && writer.jobId === jobId) writers.delete(id)
    },
    async purgeWorkspaceRecords(workspaceId) {
      if (!['deleting', 'deleted'].includes(control(workspaceId).state)) throw new StoreConflictError()
      if ([...writers.values()].some(writer => writer.workspaceId === workspaceId && Date.parse(writer.expiresAt) > Date.now())) {
        throw new StoreConflictError('Job Blob writers have not drained.')
      }
      for (const value of [...records.values()]) if (value.record.workspaceId === workspaceId) await store.purgeJobRecords(workspaceId, value.record.id)
      for (const key of [...rubrics.keys()]) if (key.startsWith(`${workspaceId}/`)) rubrics.delete(key)
      for (const [id, writer] of writers) if (writer.workspaceId === workspaceId) writers.delete(id)
    },
    async beginBlobWrite(workspaceId, jobId, blobName, owner) {
      assertBlobScope(blobName, workspaceId, jobId)
      const value = records.get(keyFor(workspaceId, jobId))
      writable(workspaceId, value?.record)
      if (tombstones.has(keyFor(workspaceId, jobId)) || (owner &&
        (value?.record.lease?.owner !== owner || Date.parse(value.record.lease.expiresAt) <= Date.now()))) throw new StoreConflictError()
      const writer = { id: `job-blob-writer:${randomUUID()}`, workspaceId, jobId, blobName, owner, expiresAt: new Date(Date.now() + 120_000).toISOString() }
      writers.set(writer.id, clone(writer))
      return writer
    },
    async assertBlobWrite(writer) {
      const value = records.get(keyFor(writer.workspaceId, writer.jobId))
      const stored = writers.get(writer.id)
      writable(writer.workspaceId, value?.record)
      if (!stored || stored.workspaceId !== writer.workspaceId || stored.jobId !== writer.jobId ||
        stored.blobName !== writer.blobName || stored.expiresAt !== writer.expiresAt || stored.owner !== writer.owner ||
        Date.parse(writer.expiresAt) <= Date.now() || tombstones.has(keyFor(writer.workspaceId, writer.jobId)) ||
        (writer.owner && (value?.record.lease?.owner !== writer.owner ||
          Date.parse(value.record.lease.expiresAt) <= Date.now()))) throw new StoreConflictError()
    },
    async finishBlobWrite(writer) { writers.delete(writer.id) },
    async listBlobWriters(workspaceId, jobId) {
      return [...writers.values()].filter(writer => writer.workspaceId === workspaceId && (jobId === undefined || writer.jobId === jobId)).map(clone)
    },
    _failNextReplace() { failNextReplace = true },
    _expireWriters() { for (const value of writers.values()) value.expiresAt = new Date(0).toISOString() },
    _records: records,
    _rubrics: rubrics,
    _tombstones: tombstones,
  }
  const blobStore = {
    async read(name) { return blobs.has(name) ? clone(blobs.get(name)) : undefined },
    async putImmutable(name, bytes, contentType, fence) {
      assertBlobScope(name)
      assert.equal(contentType, contentTypes[name.split('/')[2]])
      const maxBytes = contentType === 'text/html' ? 24 * 1024 * 1024
        : contentType === 'application/json' ? 180_000 * 8 : 10 * 1024 * 1024
      assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= maxBytes)
      if (fence) await fence.assertActive()
      const existing = blobs.get(name)
      if (existing) return { created: false, blob: clone(existing) }
      const body = Uint8Array.from(bytes)
      const blob = { bytes: body, contentType, sha256: createHash('sha256').update(body).digest('hex'), etag: `"blob-${blobs.size + 1}"` }
      blobs.set(name, blob)
      publicationEvents.push({ type: 'blob', key: name })
      return { created: true, blob: clone(blob) }
    },
    async putFenced(name, bytes, contentType, fence) {
      assertBlobScope(name, fence.writer.workspaceId, fence.writer.jobId)
      assert.equal(name, fence.writer.blobName)
      await fence.assertActive()
      return this.putImmutable(name, bytes, contentType, fence)
    },
    async list(workspaceId, jobId, continuationToken) {
      const prefix = jobId ? `${workspaceId}/${jobId}/` : `${workspaceId}/`
      const names = [...blobs.keys()].filter(name => name.startsWith(prefix)).sort()
      const offset = Number(continuationToken ?? 0)
      return { names: names.slice(offset, offset + 30), ...(offset + 30 < names.length ? { continuationToken: String(offset + 30) } : {}) }
    },
    async delete(workspaceId, jobId, name) {
      assert.ok(name.startsWith(`${workspaceId}/${jobId}/`))
      if (failDelete) throw new Error('Blob unavailable')
      blobs.delete(name)
    },
    _failDelete(value) { failDelete = value },
    _values: blobs,
  }
  return { store, blobs: blobStore, publicationEvents }
}
