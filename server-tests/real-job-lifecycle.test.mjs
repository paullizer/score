import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { applySampleLifecycle, createAnalysisRun, createApp, StoreConflictError, WorkspaceRepository } from '../dist-server/app.mjs'
import { ALLOWED_OID, OTHER_ALLOWED_OID, APP_ORIGIN, authHeaders, baseConfig, createFakeDirectoryStore, createFakeStateStore, membershipFor } from './helpers.mjs'
import { createFakeRealJobs } from './job-lifecycle-fakes.mjs'

const timestamp = '2026-09-18T12:00:00.000Z'
const headers = (extra = {}, oid = ALLOWED_OID) => ({
  ...authHeaders({ oid }), origin: APP_ORIGIN, 'x-score-request': 'workspace', 'content-type': 'application/json', ...extra,
})

async function fixture({ grades } = {}) {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  const jobs = createFakeRealJobs()
  const app = createApp({
    directory, state, jobs, grades, config: baseConfig({ realJobs: {} }), now: () => new Date(timestamp),
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const session = await fetch(`${base}/session`, { headers: authHeaders() })
  assert.equal(session.status, 200)
  const workspaceId = (await session.json()).workspaces[0].id
  const importKey = randomUUID()
  const imported = await fetch(`${base}/workspaces/${workspaceId}/jobs/pdf`, {
    method: 'POST', headers: headers({ 'content-type': 'application/pdf', 'x-file-name': 'Role.pdf', 'idempotency-key': importKey }),
    body: Buffer.from('%PDF-1.7\nrole source'),
  })
  assert.equal(imported.status, 202)
  const initial = (await imported.json()).job
  const jobId = initial.job.id
  return {
    app, base, directory, state, jobs, workspaceId, jobId, importKey, initial,
    async close() { await new Promise(resolve => server.close(resolve)) },
    async lifecycle(action, scope, etag, extra = {}) {
      return fetch(`${base}/workspaces/${workspaceId}/jobs/${jobId}/lifecycle`, {
        method: 'POST', headers: headers(etag ? { 'if-match': etag } : {}, extra.oid),
        body: JSON.stringify({ action, scope }),
      })
    },
  }
}

async function ready(f, versions = 2) {
  let value = await f.jobs.store.get(f.workspaceId, f.jobId)
  const document = {
    id: value.record.job.documentId, title: 'Role', kind: 'job', version: 1, sample: false,
    paragraphs: [{ id: 'p1', page: 1, heading: '', text: 'Experience required.' }],
  }
  const extractedBlobName = `${f.workspaceId}/${f.jobId}/source-document.json`
  await f.jobs.blobs.putImmutable(extractedBlobName, Buffer.from(JSON.stringify(document)), 'application/json')
  for (let version = 1; version <= versions; version += 1) {
    const rubric = {
      id: `rubric-${f.jobId}`, groupId: `rubric-${f.jobId}`, jobId: f.jobId, kind: 'job',
      name: 'Role rubric', description: 'Source grounded.', version, createdAt: timestamp, dataKind: 'real',
      provenance: { kind: 'generated', model: 'test', promptVersion: 'v1' },
      criteria: [{
        id: 'c1', key: 'custom', label: 'Experience', description: 'Experience required.', weight: 100,
        guidance: 'Evidence required.', requirementType: 'required',
        sourceCitations: [{ documentId: document.id, documentVersion: 1, paragraphId: 'p1', page: 1, heading: '', quote: 'Experience required.' }],
      }],
    }
    value = await f.jobs.store.publish({
      ...value.record, extractedBlobName, job: { ...value.record.job, status: 'ready', rubricId: rubric.id },
      lease: undefined, nextAttemptAt: undefined,
    }, value.etag, rubric)
  }
  return value
}

test('job lifecycle requires exact ETags and editor rights, cancels owned work, and restores without restart', async () => {
  const f = await fixture()
  try {
    const value = await f.jobs.store.get(f.workspaceId, f.jobId)
    const leased = await f.jobs.store.replace({ ...value.record, lease: { owner: 'worker', expiresAt: '2099-01-01T00:00:00.000Z' } }, value.etag)
    assert.equal((await f.lifecycle('archive', 'job')).status, 428)
    assert.equal((await f.lifecycle('archive', 'job', '*')).status, 400)
    assert.equal((await f.lifecycle('archive', 'job', value.etag)).status, 409)
    assert.equal((await f.lifecycle('archive', 'job', leased.etag, { oid: OTHER_ALLOWED_OID })).status, 404)
    f.directory._addMembership(f.workspaceId, membershipFor(f.workspaceId, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
    assert.equal((await f.lifecycle('archive', 'job', leased.etag, { oid: OTHER_ALLOWED_OID })).status, 403)
    const response = await f.lifecycle('archive', 'job', leased.etag)
    assert.equal(response.status, 200)
    const archived = (await response.json()).job
    assert.equal(archived.lifecycle.archivedAt, timestamp)
    assert.equal(archived.job.status, 'cancelled')
    assert.equal((await f.jobs.store.get(f.workspaceId, f.jobId)).record.lease, undefined)
    assert.ok(await f.jobs.blobs.read(`${f.workspaceId}/${f.jobId}/original.pdf`))
    const retry = await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/${f.jobId}/retry`, { method: 'POST', headers: headers() })
    assert.equal(retry.status, 409)
    const restoredResponse = await f.lifecycle('unarchive', 'job', archived.etag)
    assert.equal(restoredResponse.status, 200)
    const restored = (await restoredResponse.json()).job
    assert.equal(restored.lifecycle.archivedAt, undefined)
    assert.equal(restored.job.status, 'cancelled')
    assert.deepEqual(await f.jobs.store.listPending(timestamp, 50), [])
  } finally { await f.close() }
})

test('rubric archive leaves immutable versions and sources intact; deletion removes every version and retains No rubric', async () => {
  const f = await fixture()
  try {
    const value = await ready(f, 125)
    const before = await f.jobs.store.listRubrics(f.workspaceId, f.jobId)
    const archivedResponse = await f.lifecycle('archive', 'rubric', value.etag)
    assert.equal(archivedResponse.status, 200)
    const archived = (await archivedResponse.json()).job
    assert.equal(archived.rubricLifecycle.archivedAt, timestamp)
    assert.deepEqual(await f.jobs.store.listRubrics(f.workspaceId, f.jobId), before)
    const deleted = await f.lifecycle('delete', 'rubric', archived.etag)
    assert.equal(deleted.status, 200)
    const result = (await deleted.json()).job
    assert.equal(result.job.status, 'ready')
    assert.equal(result.job.rubricId, null)
    assert.equal(result.job.rubricDeletedAt, timestamp)
    assert.equal(result.rubricLifecycle.deletedAt, timestamp)
    assert.equal(result.rubric, null)
    assert.deepEqual(result.rubricVersions, [])
    assert.ok(result.document)
    assert.ok(await f.jobs.blobs.read(`${f.workspaceId}/${f.jobId}/original.pdf`))
    assert.deepEqual(await f.jobs.store.listRubrics(f.workspaceId, f.jobId), [])
    assert.equal((await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/${f.jobId}/retry`, { method: 'POST', headers: headers() })).status, 409)
    assert.equal((await f.lifecycle('unarchive', 'rubric', result.etag)).status, 409)
    const importReplay = await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/pdf`, {
      method: 'POST', headers: headers({ 'content-type': 'application/pdf', 'x-file-name': 'Role.pdf', 'idempotency-key': f.importKey }),
      body: Buffer.from('%PDF-1.7\nrole source'),
    })
    assert.equal(importReplay.status, 409)
    assert.equal((await f.jobs.store.get(f.workspaceId, f.jobId)).etag, result.etag)
    assert.equal((await f.jobs.store.get(f.workspaceId, f.jobId)).record.job.rubricId, null)
    await assert.rejects(f.jobs.store.publish(value.record, value.etag, { ...before[0], version: 126 }), /changed|conflict|Archived|removed/i)
  } finally { await f.close() }
})

test('job purge pages originals, extraction and preparation leftovers without crossing prefixes or replaying imports', async () => {
  const f = await fixture()
  try {
    const value = await ready(f, 4)
    for (let i = 0; i < 135; i += 1) {
      await f.jobs.blobs.putImmutable(`${f.workspaceId}/${f.jobId}/preparation/part-${i}.json`, Buffer.from('{}'), 'application/json')
    }
    const otherWorkspace = `${f.workspaceId}-other`
    const otherName = `${otherWorkspace}/${f.jobId}/original.pdf`
    await f.jobs.blobs.putImmutable(otherName, Buffer.from('%PDF-other'), 'application/pdf')
    const response = await f.lifecycle('delete', 'job', value.etag)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deleted: true })
    assert.equal(await f.jobs.store.get(f.workspaceId, f.jobId), undefined)
    assert.deepEqual((await f.jobs.blobs.list(f.workspaceId, f.jobId)).names, [])
    assert.ok(await f.jobs.blobs.read(otherName))
    const replay = await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/pdf`, {
      method: 'POST', headers: headers({ 'content-type': 'application/pdf', 'x-file-name': 'Role.pdf', 'idempotency-key': f.importKey }),
      body: Buffer.from('%PDF-1.7\nrole source'),
    })
    assert.equal(replay.status, 409)
    assert.deepEqual((await f.jobs.blobs.list(f.workspaceId, f.jobId)).names, [])
    assert.ok(f.jobs.store._tombstones.has(`${f.workspaceId}/${f.jobId}`))
  } finally { await f.close() }
})

test('delete remains durably pending for a live writer and resumably failed for a cleanup outage', async () => {
  const f = await fixture()
  try {
    const writer = await f.jobs.store.beginBlobWrite(f.workspaceId, f.jobId, `${f.workspaceId}/${f.jobId}/source-document.json`)
    const pendingResponse = await f.lifecycle('delete', 'job', f.initial.etag)
    assert.equal(pendingResponse.status, 202)
    const pending = await pendingResponse.json()
    assert.equal(pending.deleted, undefined)
    assert.equal(pending.operation.status, 'pending')
    assert.equal(pending.job.lifecycle.deletingAt, timestamp)
    await assert.rejects(f.jobs.store.assertBlobWrite(writer))
    f.jobs.store._expireWriters()
    f.jobs.blobs._failDelete(true)
    const failedResponse = await f.lifecycle('delete', 'job', pending.job.etag)
    assert.equal(failedResponse.status, 202)
    const failed = await failedResponse.json()
    assert.equal(failed.operation.status, 'failed')
    assert.equal(failed.deleted, undefined)
    assert.equal(failed.error.code, 'unavailable')
    assert.ok(failed.job.lifecycle.deletingAt)
    assert.ok(await f.jobs.store.get(f.workspaceId, f.jobId))
    f.jobs.blobs._failDelete(false)
    const completed = await f.lifecycle('delete', 'job', failed.job.etag)
    assert.equal(completed.status, 200)
    assert.deepEqual(await completed.json(), { deleted: true })
  } finally { await f.close() }
})

for (const scope of ['job', 'rubric']) {
  test(`${scope} cleanup outages preserve the durable operation and ETag even when refresh reads fail`, async () => {
    const f = await fixture()
    try {
      const value = await ready(f)
      const transition = f.jobs.store.transitionLifecycle.bind(f.jobs.store)
      f.jobs.store.transitionLifecycle = async (...args) => {
        const updated = await transition(...args)
        f.jobs.store.get = async () => { throw new Error('Cosmos read outage') }
        f.jobs.blobs.read = async () => { throw new Error('Blob read outage') }
        return updated
      }
      const cleanup = scope === 'job' ? 'purgeJobRecords' : 'purgeRubrics'
      f.jobs.store[cleanup] = async () => { throw new Error('Injected cleanup outage') }
      const response = await f.lifecycle('delete', scope, value.etag)
      assert.equal(response.status, 202)
      const failed = await response.json()
      assert.equal(failed.operation.status, 'failed')
      assert.equal(failed.deleted, undefined)
      assert.ok(failed.job[scope === 'job' ? 'lifecycle' : 'rubricLifecycle'].deletingAt)
      assert.equal(failed.job.etag, f.jobs.store._records.get(`${f.workspaceId}/${f.jobId}`).etag)
      assert.equal(failed.job.document, null)
    } finally { await f.close() }
  })
}

test('workspace archive fences future imports and preserves separately archived rubric state after restore', async () => {
  const f = await fixture()
  try {
    const archivedRubric = await f.lifecycle('archive', 'rubric', f.initial.etag)
    assert.equal(archivedRubric.status, 200)
    const currentWorkspace = (await (await fetch(`${f.base}/session`, { headers: authHeaders() })).json()).workspaces[0]
    const workspaceChange = (action, etag) => fetch(`${f.base}/workspaces/${f.workspaceId}/lifecycle`, {
      method: 'POST', headers: headers({ 'if-match': etag }), body: JSON.stringify({ action }),
    })
    const response = await workspaceChange('archive', currentWorkspace.etag)
    assert.equal(response.status, 200)
    const archivedWorkspace = await response.json()
    assert.equal(archivedWorkspace.operation?.status ?? 'complete', 'complete')
    const current = await f.jobs.store.get(f.workspaceId, f.jobId)
    assert.equal(current.record.lifecycle, undefined)
    assert.equal(current.record.rubricLifecycle.archivedAt, timestamp)
    assert.equal((await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/url`, {
      method: 'POST', headers: headers({ 'idempotency-key': randomUUID() }), body: JSON.stringify({ url: 'https://example.com/role' }),
    })).status, 409)
    const restored = await workspaceChange('unarchive', archivedWorkspace.workspace.etag)
    assert.equal(restored.status, 200)
    assert.equal((await f.jobs.store.get(f.workspaceId, f.jobId)).record.rubricLifecycle.archivedAt, timestamp)
    assert.deepEqual(await f.jobs.store.listPending(timestamp, 50), [])
  } finally { await f.close() }
})

test('missing job lifecycle capabilities cannot report successful cleanup', async () => {
  const f = await fixture()
  try {
    delete f.jobs.blobs.delete
    const response = await f.lifecycle('delete', 'job', f.initial.etag)
    assert.equal(response.status, 503)
    assert.ok(await f.jobs.store.get(f.workspaceId, f.jobId))
    assert.equal((await f.jobs.store.get(f.workspaceId, f.jobId)).record.lifecycle, undefined)
  } finally { await f.close() }
})

test('archived seed ladders on later pages block both job and logical rubric deletion', async () => {
  const ladders = []
  let pages = 0
  const grades = {
    store: {
      async list(workspaceId, options) {
        pages += 1
        const offset = Number(options.continuationToken ?? 0)
        return {
          items: ladders.slice(offset, offset + 100).map(record => ({ record: { ...record, workspaceId }, etag: '"ladder"' })),
          ...(offset + 100 < ladders.length ? { continuationToken: String(offset + 100) } : {}),
        }
      },
    },
    blobs: {},
  }
  const f = await fixture({ grades })
  try {
    const value = await ready(f, 3)
    for (let index = 0; index < 100; index += 1) {
      ladders.push({ id: `other-ladder-${index}`, recordType: 'grade-ladder', name: 'Other ladder', seedJobId: 'other-job', seedRubricId: 'other-rubric', seedRubricVersion: 1 })
    }
    ladders.push({
      id: 'retained-ladder', recordType: 'grade-ladder', name: 'Archived seed ladder', seedJobId: f.jobId,
      seedRubricId: `rubric-${f.jobId}`, seedRubricVersion: 1, lifecycle: { archivedAt: timestamp },
    })
    for (const scope of ['job', 'rubric']) {
      const preview = await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/${f.jobId}/lifecycle?scope=${scope}`, { headers: authHeaders() })
      assert.equal(preview.status, 200)
      const { impact } = await preview.json()
      assert.equal(impact.blockers.length, 1)
      assert.equal(impact.blockers[0].id, 'retained-ladder')
      assert.match(impact.blockers[0].href, /grade-ladders/)
      const response = await f.lifecycle('delete', scope, value.etag)
      assert.equal(response.status, 409)
      assert.equal((await response.json()).impact.blockers[0].name, 'Archived seed ladder')
    }
    assert.ok(pages >= 8, 'preview and mutation both recheck every dependency page')
    assert.equal((await f.jobs.store.get(f.workspaceId, f.jobId)).etag, value.etag)
    assert.equal((await f.jobs.store.listRubrics(f.workspaceId, f.jobId)).length, 3)
    ladders.pop()
    assert.equal((await f.lifecycle('delete', 'job', value.etag)).status, 200)
  } finally { await f.close() }
})

test('archived analyses retain historical job and rubric dependencies until explicitly removed', async () => {
  const f = await fixture()
  try {
    const value = await ready(f)
    const entry = await f.state.getState(f.workspaceId)
    let workspace = JSON.parse(entry.content)
    const sampleRubric = workspace.rubrics.find(rubric => rubric.kind === 'job')
    const run = createAnalysisRun(workspace, [workspace.resumes[0].id], [sampleRubric.id], 'Archived historical comparison')
    run.targets[0].job.id = f.jobId
    run.targets[0].rubric.jobId = f.jobId
    run.targets[0].rubric.groupId = `rubric-${f.jobId}`
    workspace = { ...workspace, runs: [...workspace.runs, run] }
    workspace = applySampleLifecycle(workspace, { kind: 'analysis', id: run.id }, 'archive', timestamp)
    await f.state.putState(f.workspaceId, JSON.stringify(workspace), entry.etag)
    for (const scope of ['job', 'rubric']) {
      const response = await f.lifecycle('delete', scope, value.etag)
      assert.equal(response.status, 409)
      const body = await response.json()
      assert.ok(body.impact.blockers.some(blocker => blocker.kind === 'analysis' && blocker.id === run.id))
    }
    assert.equal((await f.jobs.store.get(f.workspaceId, f.jobId)).etag, value.etag)
  } finally { await f.close() }
})

test('every job mutator executes its complete handler under the appropriate workspace lease', async () => {
  const f = await fixture()
  const originalMutation = WorkspaceRepository.prototype.withWorkspaceMutation
  const calls = []
  try {
    const readyJob = await ready(f)
    const originalAcquire = f.state.acquireMutationLease.bind(f.state)
    let held = false
    let released = 0
    f.state.acquireMutationLease = async workspaceId => {
      const lease = await originalAcquire(workspaceId)
      held = true
      return {
        renew: () => lease.renew(),
        async release() { await lease.release(); held = false; released += 1 },
      }
    }
    WorkspaceRepository.prototype.withWorkspaceMutation = function(principal, workspaceId, access, operation, ...rest) {
      calls.push(access)
      return originalMutation.call(this, principal, workspaceId, access, operation, ...rest)
    }
    for (const name of ['create', 'replace', 'publish', 'transitionLifecycle']) {
      const original = f.jobs.store[name].bind(f.jobs.store)
      f.jobs.store[name] = async (...args) => {
        assert.equal(held, true, `${name} must remain within the mutation lease`)
        return original(...args)
      }
    }
    const originalPut = f.jobs.blobs.putFenced.bind(f.jobs.blobs)
    f.jobs.blobs.putFenced = async (...args) => {
      assert.equal(held, true, 'source persistence must remain within the mutation lease')
      return originalPut(...args)
    }
    const urlImport = await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/url`, {
      method: 'POST', headers: headers({ 'idempotency-key': randomUUID() }), body: JSON.stringify({ url: 'https://jobs.example/queued' }),
    })
    assert.equal(urlImport.status, 202)
    const queuedId = (await urlImport.json()).job.job.id
    for (const action of ['cancel', 'retry']) {
      assert.equal((await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/${queuedId}/${action}`, {
        method: 'POST', headers: headers(),
      })).status, 200)
    }
    assert.equal((await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/pdf`, {
      method: 'POST', headers: headers({ 'content-type': 'application/pdf', 'x-file-name': 'Other.pdf', 'idempotency-key': randomUUID() }),
      body: Buffer.from('%PDF-1.7\nother source'),
    })).status, 202)
    const rubric = (await f.jobs.store.listRubrics(f.workspaceId, f.jobId)).at(-1)
    const edited = await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/${f.jobId}/rubric`, {
      method: 'PUT', headers: headers({ 'if-match': readyJob.etag }),
      body: JSON.stringify({ rubric: { ...rubric, name: 'Edited while leased' } }),
    })
    assert.equal(edited.status, 200)
    const etag = (await edited.json()).job.etag
    assert.equal((await f.lifecycle('archive', 'job', etag)).status, 200)
    assert.deepEqual(calls, ['write', 'write', 'write', 'write', 'write', 'manage'])
    assert.equal(released, 6)
    assert.equal(held, false)
  } finally {
    WorkspaceRepository.prototype.withWorkspaceMutation = originalMutation
    await f.close()
  }
})

test('job writes reauthorize after acquiring the workspace lease', async () => {
  const f = await fixture()
  try {
    const originalAcquire = f.state.acquireMutationLease.bind(f.state)
    f.state.acquireMutationLease = async workspaceId => {
      const lease = await originalAcquire(workspaceId)
      const entry = await f.directory.getMetadata(workspaceId)
      await f.directory.replaceMetadata({ ...entry.metadata, archivedAt: timestamp }, entry.etag)
      return lease
    }
    const key = randomUUID()
    const response = await fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/url`, {
      method: 'POST', headers: headers({ 'idempotency-key': key }), body: JSON.stringify({ url: 'https://jobs.example/race' }),
    })
    assert.equal(response.status, 409)
    assert.equal(await f.jobs.store.get(f.workspaceId, `job-${key}`), undefined)
    const released = await originalAcquire(f.workspaceId)
    await released.release()
  } finally { await f.close() }
})

test('disconnecting a lifecycle request does not release its workspace lease before cleanup settles', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const released = Promise.withResolvers()
  let request
  try {
    const originalAcquire = f.state.acquireMutationLease.bind(f.state)
    f.state.acquireMutationLease = async workspaceId => {
      const lease = await originalAcquire(workspaceId)
      return {
        renew: () => lease.renew(),
        async release() { await lease.release(); released.resolve() },
      }
    }
    const originalRead = f.state.getState.bind(f.state)
    f.state.getState = async workspaceId => {
      entered.resolve()
      await resume.promise
      return originalRead(workspaceId)
    }
    const controller = new AbortController()
    request = fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/${f.jobId}/lifecycle`, {
      method: 'POST', headers: headers({ 'if-match': f.initial.etag }),
      body: JSON.stringify({ action: 'delete', scope: 'job' }), signal: controller.signal,
    }).catch(error => error)
    await entered.promise
    await assert.rejects(originalAcquire(f.workspaceId), /change is in progress/)
    controller.abort()
    await request
    await new Promise(resolve => setTimeout(resolve, 20))
    await assert.rejects(originalAcquire(f.workspaceId), /change is in progress/)
    resume.resolve()
    await released.promise
    assert.equal(await f.jobs.store.get(f.workspaceId, f.jobId), undefined)
    const lease = await originalAcquire(f.workspaceId)
    await lease.release()
  } finally {
    resume.resolve()
    await request
    await f.close()
  }
})

test('a failed workspace lease renewal fences final job publication', async t => {
  const f = await fixture()
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  let request
  try {
    const originalAcquire = f.state.acquireMutationLease.bind(f.state)
    f.state.acquireMutationLease = async workspaceId => {
      const lease = await originalAcquire(workspaceId)
      return {
        async renew() { throw new StoreConflictError('Injected workspace lease loss.') },
        release: () => lease.release(),
      }
    }
    const originalRead = f.jobs.store.getWorkspaceLifecycle.bind(f.jobs.store)
    f.jobs.store.getWorkspaceLifecycle = async workspaceId => {
      const result = await originalRead(workspaceId)
      entered.resolve()
      await resume.promise
      return result
    }
    t.mock.timers.enable({ apis: ['setInterval'] })
    const key = randomUUID()
    request = fetch(`${f.base}/workspaces/${f.workspaceId}/jobs/url`, {
      method: 'POST', headers: headers({ 'idempotency-key': key }), body: JSON.stringify({ url: 'https://jobs.example/lease-loss' }),
    })
    await entered.promise
    t.mock.timers.tick(20_000)
    await new Promise(resolve => setImmediate(resolve))
    resume.resolve()
    const response = await request
    assert.equal(response.status, 409)
    assert.equal(await f.jobs.store.get(f.workspaceId, `job-${key}`), undefined)
  } finally {
    resume.resolve()
    await request
    t.mock.timers.reset()
    await f.close()
  }
})

for (const scope of ['job', 'rubric']) {
  test(`web reconciliation resumes a failed ${scope} deletion from its durable marker`, async () => {
    const f = await fixture()
    try {
      const value = await ready(f)
      const method = scope === 'job' ? 'purgeJobRecords' : 'purgeRubrics'
      const original = f.jobs.store[method].bind(f.jobs.store)
      f.jobs.store[method] = async () => { throw new Error('Interrupted cleanup') }
      const failed = await f.lifecycle('delete', scope, value.etag)
      assert.equal(failed.status, 202)
      assert.equal((await failed.json()).operation.status, 'failed')
      assert.deepEqual(await f.jobs.store.pendingLifecycleWorkspaces(20), [f.workspaceId])
      f.jobs.store[method] = original
      await f.app.locals.reconcileLifecycle()
      const current = await f.jobs.store.get(f.workspaceId, f.jobId)
      if (scope === 'job') assert.equal(current, undefined)
      else {
        assert.equal(current.record.job.rubricId, null)
        assert.equal(current.record.job.rubricDeletedAt, timestamp)
      }
      assert.deepEqual(await f.jobs.store.pendingLifecycleWorkspaces(20), [])
    } finally { await f.close() }
  })
}
