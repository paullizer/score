import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALLOWED_OID, TENANT_ID, authHeaders, createFakeAccessStore, createFakeDirectoryStore,
  createFakeStateStore, principalKeyFor, startTestServer,
} from './helpers.mjs'

const requestHeaders = { ...authHeaders(), origin: 'https://app-score-test.azurewebsites.net', 'X-Score-Request': 'workspace', 'content-type': 'application/json' }

test('first-session reads do not attempt workspace or state writes when no workspace exists', async () => {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  let writes = 0
  directory.createWorkspace = async () => { writes += 1; throw new Error('must not create') }
  directory.replaceMetadata = async () => { writes += 1; throw new Error('must not replace') }
  state.deleteState = async () => { writes += 1; throw new Error('must not delete') }
  const server = await startTestServer({ directory, state })
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).workspaces, [])
    assert.equal(writes, 0)
    assert.equal(directory._workspaceCount(), 0)
    assert.deepEqual(await directory.listMembershipsForPrincipal(principalKeyFor(TENANT_ID, ALLOWED_OID)), [])
    assert.deepEqual(state._operations(), [])
  } finally { await server.close() }
})

test('explicit workspace creation publishes directory metadata without creating a state blob', async () => {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  const server = await startTestServer({ directory, state, accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ name: 'No state seed' }),
    })
    assert.equal(response.status, 201)
    const workspace = (await response.json()).workspace
    assert.ok(await directory.getMetadata(workspace.id))
    assert.equal(await state.getState(workspace.id), undefined)
    assert.deepEqual(state._operations(), ['getState'])
  } finally { await server.close() }
})

test('directory id collisions return 409 and do not publish another workspace or state blob', async () => {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  directory.createWorkspace = async () => ({ created: false })
  const server = await startTestServer({ directory, state, accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ name: 'Collision' }),
    })
    assert.equal(response.status, 409)
    assert.match(JSON.stringify(await response.json()), /already in use/)
    assert.equal(directory._workspaceCount(), 0)
    assert.deepEqual(state._operations(), [])
  } finally { await server.close() }
})
