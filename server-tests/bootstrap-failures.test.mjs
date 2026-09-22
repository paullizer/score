import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALLOWED_OID, TENANT_ID, authHeaders, createFakeAccessStore, createFakeDirectoryStore, createFakeStateStore,
  defaultPersonalWorkspaceId, membershipFor, principalKeyFor, sampleWorkspaceBody, startTestServer,
} from './helpers.mjs'

const defaultId = defaultPersonalWorkspaceId(principalKeyFor(TENANT_ID, ALLOWED_OID))
const requestHeaders = { ...authHeaders(), origin: 'https://app-score-test.azurewebsites.net', 'X-Score-Request': 'workspace', 'content-type': 'application/json' }

test('first-session reads do not attempt initial Blob writes even when writes are unavailable', async () => {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  state.createState = async () => { throw new Error('State write failed') }
  const server = await startTestServer({ directory, state })
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).workspaces, [])
    assert.equal(directory._workspaceCount(), 0)
    assert.deepEqual(await directory.listMembershipsForPrincipal(principalKeyFor(TENANT_ID, ALLOWED_OID)), [])
  } finally { await server.close() }
})

test('overlapping explicit creations cannot publish a workspace before its own Blob exists', async () => {
  const state = createFakeStateStore()
  const originalCreate = state.createState.bind(state)
  let release
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let first = true, failedId
  state.createState = async (...args) => {
    if (first) {
      first = false
      failedId = args[0]
      markStarted()
      await gate
      throw new Error('First initializer failed')
    }
    return originalCreate(...args)
  }
  const server = await startTestServer({ state, accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  const create = name => fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST', headers: requestHeaders, body: JSON.stringify({ name }),
  })
  try {
    const pending = create('Blocked creation')
    await started
    assert.equal(server.directory._workspaceCount(), 0)
    const winner = await create('Independent creation')
    assert.equal(winner.status, 201)
    const id = (await winner.json()).workspace.id
    assert.ok(await state.getState(id))
    assert.ok(await server.directory.getMetadata(id))
    assert.equal(await server.directory.getMetadata(failedId), undefined)
    release()
    assert.equal((await pending).status, 503)
    assert.equal(await state.getState(failedId), undefined)
    assert.equal(server.directory._workspaceCount(), 1)
    const saved = await fetch(`${server.baseUrl}/api/workspaces/${id}/state`, { headers: authHeaders() })
    assert.equal(saved.status, 200)
  } finally { release(); await server.close() }
})

test('session reads leave legacy orphan memberships and prepared state untouched rather than repairing them', async () => {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  directory._addMembership(defaultId, membershipFor(defaultId, { oid: ALLOWED_OID, role: 'owner' }))
  const preserved = JSON.stringify(sampleWorkspaceBody())
  const created = await state.createState(defaultId, preserved)
  const server = await startTestServer({ directory, state })
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).workspaces, [])
    assert.deepEqual(await state.getState(defaultId), { content: preserved, etag: created.etag })
    assert.equal(await directory.getMetadata(defaultId), undefined)
    assert.equal(directory._workspaceCount(), 0)
    assert.equal((await directory.listMembershipsForPrincipal(principalKeyFor(TENANT_ID, ALLOWED_OID))).length, 1)
  } finally { await server.close() }
})

test('a failed explicit publication preserves prepared bytes without session-based repair or duplicate membership', async () => {
  const directory = createFakeDirectoryStore()
  const originalCreate = directory.createWorkspace.bind(directory)
  let fail = true, failedId
  directory.createWorkspace = async (...args) => {
    if (fail) { failedId = args[0].workspaceId; throw new Error('Directory temporarily unavailable') }
    return originalCreate(...args)
  }
  const server = await startTestServer({ directory, accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ name: 'Publication fails' }),
    })
    assert.equal(response.status, 503)
    const prepared = await server.state.getState(failedId)
    assert.ok(prepared)
    assert.equal(directory._workspaceCount(), 0)
    fail = false
    const session = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(session.status, 200)
    assert.deepEqual((await session.json()).workspaces, [])
    const retried = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ name: 'Explicit retry' }),
    })
    assert.equal(retried.status, 201)
    assert.notEqual((await retried.json()).workspace.id, failedId)
    assert.equal(await directory.getMetadata(failedId), undefined)
    assert.deepEqual(await server.state.getState(failedId), prepared)
    assert.equal((await directory.listMembershipsForPrincipal(principalKeyFor(TENANT_ID, ALLOWED_OID))).length, 1)
  } finally { await server.close() }
})

test('unpublished membership alone cannot authorize reading or writing a Blob', async () => {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  const id = '11111111-1111-4111-8111-111111111111'
  directory._addMembership(id, membershipFor(id, { oid: ALLOWED_OID, role: 'owner' }))
  const prepared = await state.createState(id, JSON.stringify(sampleWorkspaceBody()))
  const server = await startTestServer({ directory, state })
  try {
    const read = await fetch(`${server.baseUrl}/api/workspaces/${id}/state`, { headers: authHeaders() })
    assert.equal(read.status, 404)
    const write = await fetch(`${server.baseUrl}/api/workspaces/${id}/state`, {
      method: 'PUT', headers: { ...requestHeaders, 'If-Match': prepared.etag }, body: JSON.stringify(sampleWorkspaceBody()),
    })
    assert.equal(write.status, 404)
  } finally { await server.close() }
})

test('explicit workspace creation does not publish metadata if initial state fails', async () => {
  const state = createFakeStateStore()
  state.createState = async () => { throw new Error('Blob unavailable') }
  const server = await startTestServer({ state, accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ name: 'Must not be published' }),
    })
    assert.equal(response.status, 503)
    assert.equal(server.directory._workspaceCount(), 0)
  } finally { await server.close() }
})
