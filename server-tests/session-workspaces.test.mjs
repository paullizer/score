import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALLOWED_OID, OTHER_ALLOWED_OID, authHeaders, createFakeAccessStore, createFakeDirectoryStore,
  createFakeStateStore, defaultPersonalWorkspaceId, membershipFor, principalKeyFor, legacyStateBody,
  seedWorkspace, startTestServer, TENANT_ID,
} from './helpers.mjs'

const MUTATING_HEADERS = { origin: 'https://app-score-test.azurewebsites.net', 'X-Score-Request': 'workspace' }

test('GET /api/session leaves a first-time user with no workspace or implicit creation grant', async () => {
  const server = await startTestServer()
  try {
    const first = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.deepEqual(firstBody.workspaces, [])
    assert.deepEqual(firstBody.capabilities, { applicationAdmin: false, canCreateWorkspaces: false })

    const second = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    const secondBody = await second.json()
    assert.deepEqual(secondBody.workspaces, [])
    assert.equal(server.directory._workspaceCount(), 0)
    assert.deepEqual(server.accessStore._audits(), [])
  } finally {
    await server.close()
  }
})

test('concurrent first sessions and workspace lists are pure even for admins or creation-granted users', async () => {
  const directory = createFakeDirectoryStore(), state = createFakeStateStore()
  let writes = 0
  const unexpectedWrite = async () => { writes++; throw new Error('Session reads must never write') }
  directory.createWorkspace = unexpectedWrite
  directory.replaceMetadata = unexpectedWrite
  directory.changeMembership = unexpectedWrite
  state.deleteState = unexpectedWrite
  const server = await startTestServer({ directory, state, accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) => fetch(`${server.baseUrl}/api/${index % 3 === 0 ? 'workspaces' : 'session'}`, {
        headers: authHeaders({ roles: index % 2 ? ['Score.Admin'] : ['Score.User'] }),
      })),
    )
    const bodies = await Promise.all(responses.map((response) => response.json()))
    for (const response of responses) assert.equal(response.status, 200)
    for (const body of bodies) assert.deepEqual(body.workspaces, [])
    assert.equal(writes, 0)
    assert.equal(server.directory._workspaceCount(), 0)
    assert.deepEqual(server.accessStore._audits(), [])
  } finally {
    await server.close()
  }
})

test("GET /api/workspaces only lists the calling principal's own memberships, never a global list", async () => {
  const server = await startTestServer()
  try {
    await seedWorkspace(server, { oid: ALLOWED_OID })
    await seedWorkspace(server, { oid: OTHER_ALLOWED_OID })

    const ownResponse = await fetch(`${server.baseUrl}/api/workspaces`, { headers: authHeaders({ oid: ALLOWED_OID }) })
    const ownBody = await ownResponse.json()
    assert.equal(ownBody.workspaces.length, 1)

    const otherResponse = await fetch(`${server.baseUrl}/api/workspaces`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })
    const otherBody = await otherResponse.json()
    assert.equal(otherBody.workspaces.length, 1)

    assert.notEqual(ownBody.workspaces[0].id, otherBody.workspaces[0].id)
  } finally {
    await server.close()
  }
})

test('legacy deterministic personal workspaces remain accessible without rewriting metadata, repairing state, or granting creation', async t => {
  const server = await startTestServer()
  t.after(() => server.close())
  const principalId = principalKeyFor(TENANT_ID, ALLOWED_OID)
  const id = defaultPersonalWorkspaceId(principalId)
  const metadata = {
    id: 'workspace', workspaceId: id, name: 'Existing personal workspace', kind: 'personal',
    ownerId: principalId, tenantId: TENANT_ID, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  }
  server.state._setRawContent(id, JSON.stringify(legacyStateBody()))
  await server.directory.createWorkspace(metadata, membershipFor(id, { oid: ALLOWED_OID, role: 'owner' }))
  const before = await server.directory.getMetadata(id)
  const state = await server.state.getState(id)
  const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
  assert.equal(response.status, 200)
  const session = await response.json()
  assert.deepEqual(session.workspaces.map(item => [item.id, item.role]), [[id, 'owner']])
  assert.equal(session.capabilities.canCreateWorkspaces, false)
  assert.deepEqual(await server.directory.getMetadata(id), before)
  assert.deepEqual(await server.state.getState(id), state)
  await server.state.deleteState(id, state.etag)
  const missing = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
  assert.equal((await missing.json()).workspaces[0].id, id)
  assert.equal(await server.state.getState(id), undefined)
  assert.equal((await fetch(`${server.baseUrl}/api/workspaces/${id}/lifecycle`, { headers: authHeaders() })).status, 200)
  assert.deepEqual(await server.directory.getMetadata(id), before)
})

test('A workspace is invisible and inaccessible to a principal who is not a member (404, not 403)', async () => {
  const server = await startTestServer({ seedWorkspace: true })
  try {
    const ownerSession = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders({ oid: ALLOWED_OID }) })
    const ownerId = (await ownerSession.json()).workspaces[0].id

    const strangerState = await fetch(`${server.baseUrl}/api/workspaces/${ownerId}/lifecycle`, {
      headers: authHeaders({ oid: OTHER_ALLOWED_OID }),
    })
    assert.equal(strangerState.status, 404)

    const strangerList = await fetch(`${server.baseUrl}/api/workspaces`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })
    const strangerBody = await strangerList.json()
    assert.ok(!strangerBody.workspaces.some((workspace) => workspace.id === ownerId))
  } finally {
    await server.close()
  }
})

test('POST /api/workspaces creates a personal workspace with a trimmed name', async () => {
  const server = await startTestServer({ accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...authHeaders(), ...MUTATING_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  My new workspace  ' }),
    })
    assert.equal(response.status, 201)
    const body = await response.json()
    assert.equal(body.workspace.name, 'My new workspace')
    assert.equal(body.workspace.kind, 'personal')
    assert.equal(body.workspace.role, 'owner')
  } finally {
    await server.close()
  }
})

test('POST /api/workspaces rejects a name outside 1..80 characters', async () => {
  const server = await startTestServer({ accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  const headers = { ...authHeaders(), ...MUTATING_HEADERS, 'content-type': 'application/json' }
  try {
    const empty = await fetch(`${server.baseUrl}/api/workspaces`, { method: 'POST', headers, body: JSON.stringify({ name: '   ' }) })
    assert.equal(empty.status, 400)

    const tooLong = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'x'.repeat(81) }),
    })
    assert.equal(tooLong.status, 400)
  } finally {
    await server.close()
  }
})

test('POST /api/workspaces rejects forged ownership/type fields instead of silently ignoring them', async () => {
  const server = await startTestServer({ accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  const headers = { ...authHeaders(), ...MUTATING_HEADERS, 'content-type': 'application/json' }
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Sneaky', kind: 'group', ownerId: 'someone-else', role: 'owner' }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'invalid_request')
  } finally {
    await server.close()
  }
})

test('A request body over 10MB is rejected with an explicit 413, before any auth is evaluated', async () => {
  const server = await startTestServer()
  try {
    const oversized = 'a'.repeat(11 * 1024 * 1024)
    const response = await fetch(`${server.baseUrl}/api/workspaces/anything/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: oversized }),
    })
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.error.code, 'invalid_request')
  } finally {
    await server.close()
  }
})

test('Malformed JSON bodies are rejected with 400, not a 500', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...authHeaders(), ...MUTATING_HEADERS, 'content-type': 'application/json' },
      body: '{not valid json',
    })
    assert.equal(response.status, 400)
  } finally {
    await server.close()
  }
})

test('legacyStateBody fixture represents the deleted state.json shape', () => {
  const workspace = legacyStateBody()
  assert.equal(workspace.schemaVersion, 1)
  assert.deepEqual(workspace.jobs, [])
})
