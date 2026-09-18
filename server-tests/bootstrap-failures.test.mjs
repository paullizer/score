import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALLOWED_OID, TENANT_ID, authHeaders, createFakeDirectoryStore, createFakeStateStore,
  defaultPersonalWorkspaceId, membershipFor, principalKeyFor, sampleWorkspaceBody, startTestServer,
} from './helpers.mjs'

const defaultId = defaultPersonalWorkspaceId(principalKeyFor(TENANT_ID, ALLOWED_OID))
const requestHeaders = { ...authHeaders(), origin: 'https://app-score-test.azurewebsites.net', 'X-Score-Request': 'workspace', 'content-type': 'application/json' }

test('a failed initial Blob write never publishes Cosmos metadata or membership', async () => {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  state.createState = async () => { throw new Error('State write failed') }
  const server = await startTestServer({ directory, state })
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(response.status, 503)
    assert.equal(directory._workspaceCount(), 0)
    assert.deepEqual(await directory.listMembershipsForPrincipal(principalKeyFor(TENANT_ID, ALLOWED_OID)), [])
  } finally { await server.close() }
})

test('overlapping default initializers cannot publish a workspace before its Blob exists', async () => {
  const state = createFakeStateStore()
  const originalCreate = state.createState.bind(state)
  let release
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let first = true
  state.createState = async (...args) => {
    if (first) {
      first = false
      markStarted()
      await gate
      throw new Error('First initializer failed')
    }
    return originalCreate(...args)
  }
  const server = await startTestServer({ state })
  try {
    const pending = fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    await started
    assert.equal(server.directory._workspaceCount(), 0)
    const winner = fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    release()
    assert.equal((await pending).status, 503)
    assert.equal((await winner).status, 200)
    assert.ok(await state.getState(defaultId))
    assert.ok(await server.directory.getMetadata(defaultId))
    const saved = await fetch(`${server.baseUrl}/api/workspaces/${defaultId}/state`, { headers: authHeaders() })
    assert.equal(saved.status, 200)
  } finally { release(); await server.close() }
})

test('an orphan owner membership is repaired without replacing already prepared state', async () => {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  directory._addMembership(defaultId, membershipFor(defaultId, { oid: ALLOWED_OID, role: 'owner' }))
  const preserved = JSON.stringify(sampleWorkspaceBody())
  await state.createState(defaultId, preserved)
  const server = await startTestServer({ directory, state })
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).workspaces.length, 1)
    assert.equal((await state.getState(defaultId)).content, preserved)
    assert.ok(await directory.getMetadata(defaultId))
  } finally { await server.close() }
})

test('a directory publication failure preserves prepared state for a safe retry', async () => {
  const directory = createFakeDirectoryStore()
  const originalCreate = directory.createWorkspace.bind(directory)
  let fail = true
  directory.createWorkspace = async (...args) => {
    if (fail) throw new Error('Directory temporarily unavailable')
    return originalCreate(...args)
  }
  const server = await startTestServer({ directory })
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(response.status, 503)
    const prepared = await server.state.getState(defaultId)
    assert.ok(prepared)
    assert.equal(directory._workspaceCount(), 0)
    fail = false
    const retried = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(retried.status, 200)
    assert.deepEqual(await server.state.getState(defaultId), prepared)
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
  const server = await startTestServer({ state })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ name: 'Must not be published' }),
    })
    assert.equal(response.status, 503)
    assert.equal(server.directory._workspaceCount(), 0)
  } finally { await server.close() }
})
