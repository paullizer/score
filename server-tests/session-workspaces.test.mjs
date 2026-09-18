import assert from 'node:assert/strict'
import test from 'node:test'
import { ALLOWED_OID, OTHER_ALLOWED_OID, authHeaders, sampleWorkspaceBody, startTestServer } from './helpers.mjs'

const MUTATING_HEADERS = { origin: 'https://app-score-test.azurewebsites.net', 'X-Score-Request': 'workspace' }

test('GET /api/session bootstraps exactly one default personal workspace for a first-time user', async () => {
  const server = await startTestServer()
  try {
    const first = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.equal(firstBody.workspaces.length, 1)
    assert.equal(firstBody.workspaces[0].kind, 'personal')
    assert.equal(firstBody.workspaces[0].role, 'owner')

    const second = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
    const secondBody = await second.json()
    assert.equal(secondBody.workspaces.length, 1)
    assert.equal(secondBody.workspaces[0].id, firstBody.workspaces[0].id)
    assert.equal(server.directory._workspaceCount(), 1)
  } finally {
    await server.close()
  }
})

test('GET /api/session bootstrap is idempotent under concurrent requests (no duplicate workspaces)', async () => {
  const server = await startTestServer()
  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })),
    )
    const bodies = await Promise.all(responses.map((response) => response.json()))
    for (const body of bodies) assert.equal(body.workspaces.length, 1)
    const ids = new Set(bodies.map((body) => body.workspaces[0].id))
    assert.equal(ids.size, 1, 'all concurrent bootstraps must converge on the same workspace id')
    assert.equal(server.directory._workspaceCount(), 1)
  } finally {
    await server.close()
  }
})

test("GET /api/workspaces only lists the calling principal's own memberships, never a global list", async () => {
  const server = await startTestServer()
  try {
    await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders({ oid: ALLOWED_OID }) })
    await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })

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

test('A workspace is invisible and inaccessible to a principal who is not a member (404, not 403)', async () => {
  const server = await startTestServer()
  try {
    const ownerSession = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders({ oid: ALLOWED_OID }) })
    const ownerId = (await ownerSession.json()).workspaces[0].id

    const strangerState = await fetch(`${server.baseUrl}/api/workspaces/${ownerId}/state`, {
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
  const server = await startTestServer()
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
  const server = await startTestServer()
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
  const server = await startTestServer()
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

test('sampleWorkspaceBody fixture is schema-valid enough to be reused across tests', () => {
  const workspace = sampleWorkspaceBody()
  assert.equal(workspace.schemaVersion, 1)
  assert.deepEqual(workspace.jobs, [])
})
