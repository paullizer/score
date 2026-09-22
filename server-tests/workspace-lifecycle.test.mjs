import assert from 'node:assert/strict'
import test from 'node:test'
import { applySampleLifecycle, createAnalysisRun, WorkspaceLifecycleService, WorkspaceRepository } from '../dist-server/app.mjs'
import { createFakeRealJobs } from './job-lifecycle-fakes.mjs'
import {
  ALLOWED_OID, APP_ORIGIN, OTHER_ALLOWED_OID, TENANT_ID, authHeaders, createFakeAccessStore, createFakeDirectoryStore,
  createFakeStateStore, membershipFor, principalKeyFor, sampleWorkspaceBody, seedWorkspace, startTestServer,
} from './helpers.mjs'

const timestamp = '2026-09-18T15:00:00.000Z'
const headers = { ...authHeaders(), Origin: APP_ORIGIN, 'X-Score-Request': 'workspace', 'Content-Type': 'application/json' }
async function session(server) {
  const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
  assert.equal(response.status, 200)
  return response.json()
}
async function snapshot(server, id) {
  const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/state`, { headers: authHeaders() })
  assert.equal(response.status, 200)
  return response.json()
}
async function change(server, workspace, action, extraHeaders = {}) {
  return fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/lifecycle`, {
    method: 'POST', headers: { ...headers, 'If-Match': workspace.etag, ...extraHeaders }, body: JSON.stringify({ action }),
  })
}
async function save(server, id, value, etag) {
  return fetch(`${server.baseUrl}/api/workspaces/${id}/state`, {
    method: 'PUT', headers: { ...headers, 'If-Match': etag }, body: JSON.stringify(value),
  })
}
function seedRun(server, id, workspace) {
  const rubric = workspace.rubrics.find(item => item.kind === 'job' &&
    workspace.jobs.some(job => job.rubricId === item.id && job.status === 'ready'))
  assert.ok(rubric)
  const run = createAnalysisRun(workspace, [workspace.resumes[0].id], [rubric.id], 'Protected analysis')
  const next = { ...workspace, runs: [...workspace.runs, run] }
  server.state._setRawContent(id, JSON.stringify(next))
  return { next, run }
}

test('workspace archive is inherited, cancels owned work, remains searchable, and restore keeps individual flags', async t => {
  const server = await startTestServer({ seedWorkspace: true })
  t.after(() => server.close())
  const workspace = (await session(server)).workspaces[0]
  const initial = await snapshot(server, workspace.id)
  const { next, run } = seedRun(server, workspace.id, initial.workspace)
  const individuallyArchived = applySampleLifecycle(next, { kind: 'job', id: next.jobs[0].id }, 'archive', timestamp)
  server.state._setRawContent(workspace.id, JSON.stringify(individuallyArchived))

  const archivedResponse = await change(server, workspace, 'archive')
  assert.equal(archivedResponse.status, 200)
  const archived = (await archivedResponse.json()).workspace
  assert.ok(archived.archivedAt)
  assert.equal((await session(server)).workspaces[0].archivedAt, archived.archivedAt)
  const archivedState = await snapshot(server, workspace.id)
  assert.equal(archivedState.workspace.lifecycle.archivedAt, archived.archivedAt)
  assert.ok(archivedState.workspace.runs.find(item => item.id === run.id).comparisons.every(item => item.status === 'cancelled'))
  const edited = structuredClone(archivedState.workspace)
  edited.jobs[0].title = 'Must not be editable'
  assert.equal((await save(server, workspace.id, edited, archivedState.etag)).status, 409)

  const restoredResponse = await change(server, archived, 'unarchive')
  assert.equal(restoredResponse.status, 200)
  const restored = (await restoredResponse.json()).workspace
  assert.equal(restored.archivedAt, undefined)
  const restoredState = (await snapshot(server, workspace.id)).workspace
  assert.equal(restoredState.lifecycle.archivedAt, undefined)
  assert.equal(restoredState.lifecycle.entities[`job:${next.jobs[0].id}`].archivedAt, timestamp)
  assert.ok(restoredState.runs.find(item => item.id === run.id).comparisons.every(item => item.status === 'cancelled'))
})

test('archived analyses block workspace deletion until explicitly deleted, including while the workspace is archived', async t => {
  const server = await startTestServer({ seedWorkspace: true })
  t.after(() => server.close())
  let workspace = (await session(server)).workspaces[0]
  const { next, run } = seedRun(server, workspace.id, (await snapshot(server, workspace.id)).workspace)
  server.state._setRawContent(workspace.id, JSON.stringify(applySampleLifecycle(next, { kind: 'analysis', id: run.id }, 'archive', timestamp)))
  workspace = (await (await change(server, workspace, 'archive')).json()).workspace
  assert.equal((await change(server, workspace, 'delete')).status, 409)
  const impactResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/lifecycle`, { headers: authHeaders() })
  const impact = (await impactResponse.json()).impact
  assert.ok(impact.blockers.some(item => item.id === run.id && item.href === `/analyses/${run.id}`))

  const current = await snapshot(server, workspace.id)
  let cleared = current.workspace
  for (const analysis of current.workspace.runs) cleared = applySampleLifecycle(cleared, { kind: 'analysis', id: analysis.id }, 'delete', timestamp)
  assert.equal((await save(server, workspace.id, cleared, current.etag)).status, 200)
  const deleted = await change(server, workspace, 'delete')
  assert.equal(deleted.status, 200)
  assert.equal((await deleted.json()).deleted, true)
})

test('deleting the last fixture workspace does not recreate it at sign-in and a granted owner can explicitly create another', async t => {
  const server = await startTestServer({ seedWorkspace: true, accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  t.after(() => server.close())
  const workspace = (await session(server)).workspaces[0]
  server.state._setRawContent(workspace.id, JSON.stringify(sampleWorkspaceBody()))
  assert.equal((await change(server, workspace, 'delete')).status, 200)
  assert.equal(await server.state.getState(workspace.id), undefined)
  assert.ok((await server.directory.getMetadata(workspace.id)).metadata.deletedAt)
  assert.deepEqual((await session(server)).workspaces, [])
  assert.deepEqual((await session(server)).workspaces, [])
  assert.equal((await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/state`, { headers: authHeaders() })).status, 404)
  const created = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'Explicit new workspace' }),
  })
  assert.equal(created.status, 201)
  const newWorkspace = (await created.json()).workspace
  assert.notEqual(newWorkspace.id, workspace.id)
  assert.deepEqual((await session(server)).workspaces.map(item => item.id), [newWorkspace.id])
})

test('workspace lifecycle requires ownership, CSRF, an exact current ETag, and valid fields', async t => {
  const server = await startTestServer({ seedWorkspace: true })
  t.after(() => server.close())
  const workspace = (await session(server)).workspaces[0]
  const base = `${server.baseUrl}/api/workspaces/${workspace.id}/lifecycle`
  assert.equal((await fetch(base, { method: 'POST', headers, body: JSON.stringify({ action: 'archive' }) })).status, 428)
  assert.equal((await change(server, workspace, 'archive', { 'If-Match': '*' })).status, 400)
  assert.equal((await change(server, workspace, 'archive', { 'If-Match': '"stale"' })).status, 409)
  assert.equal((await change(server, workspace, 'unknown')).status, 400)
  assert.equal((await fetch(base, { method: 'POST', headers: { ...headers, 'If-Match': workspace.etag },
    body: JSON.stringify({ action: 'archive', ownerId: 'forged' }) })).status, 400)
  assert.equal((await fetch(base, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json', 'If-Match': workspace.etag },
    body: JSON.stringify({ action: 'archive' }) })).status, 403)
  for (const role of ['editor', 'viewer']) {
    server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role }))
    assert.equal((await change(server, workspace, 'archive', authHeaders({ oid: OTHER_ALLOWED_OID }))).status, 403)
  }
  assert.equal((await server.directory.getMetadata(workspace.id)).metadata.archivedAt, undefined)
})

test('partial cleanup is durable, blocks stale writes, and resumes explicitly without a success-shaped response', async t => {
  const server = await startTestServer({ seedWorkspace: true })
  t.after(() => server.close())
  const workspace = (await session(server)).workspaces[0]
  server.state._setRawContent(workspace.id, JSON.stringify(sampleWorkspaceBody()))
  const old = await snapshot(server, workspace.id)
  const remove = server.state.deleteState
  let unavailable = true
  server.state.deleteState = async (...args) => {
    if (unavailable) throw new Error('Injected storage outage')
    return remove(...args)
  }
  const response = await change(server, workspace, 'delete')
  assert.equal(response.status, 202)
  const failed = await response.json()
  assert.equal(failed.deleted, undefined)
  assert.equal(failed.operation.status, 'failed')
  assert.match(failed.operation.error, /incomplete/i)
  assert.equal((await save(server, workspace.id, old.workspace, old.etag)).status, 409)
  unavailable = false
  assert.equal((await change(server, failed.workspace, 'delete')).status, 200)
  assert.deepEqual((await session(server)).workspaces, [])
})

test('failed finalization preserves owner recovery access and reconciliation atomically retires the workspace', async t => {
  let now = new Date(timestamp)
  const server = await startTestServer({ seedWorkspace: true, now: () => now })
  t.after(() => server.close())
  const workspace = (await session(server)).workspaces[0]
  server.state._setRawContent(workspace.id, JSON.stringify(sampleWorkspaceBody()))
  const replace = server.directory.replaceMetadata
  let fail = true
  server.directory.replaceMetadata = async (metadata, etag) => {
    if (fail && metadata.deletedAt) { fail = false; throw new Error('Injected final publication interruption') }
    return replace(metadata, etag)
  }
  const response = await change(server, workspace, 'delete')
  assert.equal(response.status, 202)
  assert.equal(await server.state.getState(workspace.id), undefined)
  const recovering = (await session(server)).workspaces
  assert.equal(recovering.length, 1)
  assert.equal(recovering[0].id, workspace.id)
  assert.equal(recovering[0].lifecycleOperation.status, 'failed')
  now = new Date(now.getTime() + 60_000)
  await server.app.locals.reconcileLifecycle()
  assert.ok((await server.directory.getMetadata(workspace.id)).metadata.deletedAt)
  assert.deepEqual((await session(server)).workspaces, [])
})

test('retry after sample cleanup failure preserves terminal real-store deletion fences', async t => {
  const jobs = createFakeRealJobs()
  const server = await startTestServer({ seedWorkspace: true, jobs })
  t.after(() => server.close())
  const workspace = (await session(server)).workspaces[0]
  server.state._setRawContent(workspace.id, JSON.stringify(sampleWorkspaceBody()))
  const remove = server.state.deleteState
  let fail = true
  server.state.deleteState = async (...args) => {
    if (fail) throw new Error('Injected sample cleanup failure after real-store deletion')
    return remove(...args)
  }
  const response = await change(server, workspace, 'delete')
  assert.equal(response.status, 202)
  const pending = await response.json()
  assert.equal((await jobs.store.getWorkspaceLifecycle(workspace.id)).state, 'deleted')
  fail = false
  const retry = await change(server, pending.workspace, 'delete')
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).deleted, true)
  assert.equal((await jobs.store.getWorkspaceLifecycle(workspace.id)).state, 'deleted')
  assert.deepEqual((await session(server)).workspaces, [])
})

test('workspace coordinator fences every store before cancellation and purges ladders before seed jobs', async () => {
  const directory = createFakeDirectoryStore(), state = createFakeStateStore()
  const principal = { tenantId: TENANT_ID, oid: ALLOWED_OID, principalKey: principalKeyFor(TENANT_ID, ALLOWED_OID), name: 'Owner', email: 'owner@example.test', applicationRoles: ['Score.User'] }
  const repository = new WorkspaceRepository({ directory, state })
  const workspace = await repository.createWorkspace(principal, 'Lifecycle fixture')
  state._setRawContent(workspace.id, JSON.stringify(sampleWorkspaceBody()))
  const calls = []
  const participant = name => ({
    async setState(id, value) { assert.equal(id, workspace.id); calls.push(`${name}:${value}`) },
    async cancel() { calls.push(`${name}:cancel`) },
    async purge() { calls.push(`${name}:purge`) },
    async counts() { return { [name]: 2 } },
    async pendingWorkspaces() { return [] },
    async resume() {},
  })
  const service = new WorkspaceLifecycleService({ repository, directory, state, participants: [participant('grades'), participant('jobs')] })
  assert.equal((await service.change(principal, workspace.id, 'delete', workspace.etag)).deleted, true)
  assert.deepEqual(calls, ['grades:deleting', 'jobs:deleting', 'grades:cancel', 'jobs:cancel', 'grades:purge', 'jobs:purge', 'grades:deleted', 'jobs:deleted'])
})

test('a held workspace mutation lease rejects another mutation without changing metadata', async t => {
  const server = await startTestServer({ seedWorkspace: true })
  t.after(() => server.close())
  const workspace = (await session(server)).workspaces[0]
  const lease = await server.state.acquireMutationLease(workspace.id)
  try { assert.equal((await change(server, workspace, 'archive')).status, 409) }
  finally { await lease.release() }
  assert.equal((await server.directory.getMetadata(workspace.id)).etag, workspace.etag)
})

test('sample autosave cannot forge owner-only root archive or deletion metadata', async t => {
  const server = await startTestServer({ seedWorkspace: true })
  t.after(() => server.close())
  const workspace = (await session(server)).workspaces[0]
  const before = await snapshot(server, workspace.id)
  for (const lifecycle of [
    { archivedAt: timestamp, entities: {} },
    { entities: { [`workspace:${workspace.id}`]: { deletedAt: timestamp } } },
  ]) {
    const response = await save(server, workspace.id, { ...before.workspace, lifecycle }, before.etag)
    assert.equal(response.status, 400)
    assert.deepEqual((await snapshot(server, workspace.id)).workspace, before.workspace)
  }
})

test('a session waiting on membership lookup cannot recreate a workspace deleted by another tab', async t => {
  const directory = createFakeDirectoryStore(), state = createFakeStateStore()
  await seedWorkspace({ directory, state })
  const read = directory.listMembershipsForPrincipal
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const waiting = new Promise(resolve => { started = resolve })
  let firstRead = true, creations = 0
  directory.listMembershipsForPrincipal = async id => {
    if (firstRead) {
      firstRead = false
      started()
      await gate
    }
    return read(id)
  }
  const create = state.createState
  state.createState = async (...args) => { creations++; return create(...args) }
  const server = await startTestServer({ directory, state })
  t.after(() => { release(); return server.close() })
  const stale = session(server)
  await waiting
  const workspace = (await session(server)).workspaces[0]
  state._setRawContent(workspace.id, JSON.stringify(sampleWorkspaceBody()))
  assert.equal((await change(server, workspace, 'delete')).status, 200)
  release()
  assert.deepEqual((await stale).workspaces, [])
  assert.equal(await state.getState(workspace.id), undefined)
  assert.equal(creations, 0)
})

test('individual cleanup is resumed under the workspace lease even without a workspace operation', async () => {
  const directory = createFakeDirectoryStore(), state = createFakeStateStore()
  const principal = { tenantId: TENANT_ID, oid: ALLOWED_OID, principalKey: principalKeyFor(TENANT_ID, ALLOWED_OID), name: 'Owner', email: 'owner@example.test', applicationRoles: ['Score.User'] }
  const repository = new WorkspaceRepository({ directory, state })
  const workspace = await repository.createWorkspace(principal, 'Lifecycle fixture')
  let pending = true, resumed = 0
  const participant = {
    async setState() { assert.fail('Individual recovery must not change workspace archive state') },
    async cancel() { assert.fail('Individual recovery must not cancel unrelated workspace work') },
    async purge() { assert.fail('An active workspace must not be purged') },
    async counts() { return {} },
    async pendingWorkspaces(limit) { assert.equal(limit, 20); return pending ? [workspace.id] : [] },
    async resume(id) {
      assert.equal(id, workspace.id)
      await assert.rejects(state.acquireMutationLease(id), /in progress/)
      resumed++
      pending = false
    },
  }
  const service = new WorkspaceLifecycleService({ repository, directory, state, participants: [participant] })
  await service.reconcile()
  await service.reconcile()
  assert.equal(resumed, 1)
  assert.equal((await directory.getMetadata(workspace.id)).metadata.archivedAt, undefined)
  assert.ok(await state.getState(workspace.id))
})

test('real analyses block workspace deletion before any store is fenced or purged', async () => {
  const directory = createFakeDirectoryStore(), state = createFakeStateStore()
  const principal = { tenantId: TENANT_ID, oid: ALLOWED_OID, principalKey: principalKeyFor(TENANT_ID, ALLOWED_OID), name: 'Owner', email: 'owner@example.test', applicationRoles: ['Score.User'] }
  const repository = new WorkspaceRepository({ directory, state })
  const workspace = await repository.createWorkspace(principal, 'Lifecycle fixture')
  state._setRawContent(workspace.id, JSON.stringify(sampleWorkspaceBody()))
  const untouched = async () => { assert.fail('A retained real analysis must block cleanup before mutation') }
  const participant = {
    setState: untouched, cancel: untouched, purge: untouched, resume: untouched,
    async counts() { return { analyses: 1 } }, async pendingWorkspaces() { return [] },
  }
  const blockers = [{ kind: 'analysis', id: 'analysis-real-retained', name: 'Archived real analysis',
    href: '/analyses/analysis-real-retained?data=real' }]
  const service = new WorkspaceLifecycleService({
    repository, directory, state, participants: [participant],
    lifecycle: { async impact(id, target) {
      assert.equal(id, workspace.id)
      assert.deepEqual(target, { kind: 'workspace', id: workspace.id })
      return blockers
    } },
  })
  const preview = await service.impact(principal, workspace.id)
  assert.equal(preview.impact.counts.analyses, 1)
  assert.deepEqual(preview.impact.blockers, blockers)
  await assert.rejects(service.change(principal, workspace.id, 'delete', workspace.etag), error => error.status === 409)
  const missingDependencies = new WorkspaceLifecycleService({ repository, directory, state, participants: [participant] })
  await assert.rejects(missingDependencies.change(principal, workspace.id, 'delete', workspace.etag), error => error.status === 503)
  assert.equal((await directory.getMetadata(workspace.id)).etag, workspace.etag)
  assert.ok(await state.getState(workspace.id))
})
