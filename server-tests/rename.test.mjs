import assert from 'node:assert/strict'
import test from 'node:test'
import { ALLOWED_OID, OTHER_ALLOWED_OID, authHeaders, membershipFor, startTestServer } from './helpers.mjs'

const MUTATING_HEADERS = { origin: 'https://app-score-test.azurewebsites.net', 'X-Score-Request': 'workspace', 'content-type': 'application/json' }

async function bootstrapWorkspace(server, oid = ALLOWED_OID) {
  const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders({ oid }) })
  const body = await response.json()
  return body.workspaces[0]
}

test('PATCH rename requires an If-Match header (428 when missing)', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), ...MUTATING_HEADERS },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    assert.equal(response.status, 428)
    const body = await response.json()
    assert.equal(body.error.code, 'precondition_required')
  } finally {
    await server.close()
  }
})

test('PATCH rename rejects a wildcard If-Match', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), ...MUTATING_HEADERS, 'if-match': '*' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    assert.equal(response.status, 400)
  } finally {
    await server.close()
  }
})

test('PATCH rename rejects a stale If-Match with 409, and succeeds with the current etag', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)

    const stale = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), ...MUTATING_HEADERS, 'if-match': '"not-the-real-etag"' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    assert.equal(stale.status, 409)

    const ok = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), ...MUTATING_HEADERS, 'if-match': workspace.etag },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.equal(body.workspace.name, 'Renamed')
    assert.notEqual(body.workspace.etag, workspace.etag)

    // Reusing the etag that was current *before* the successful rename must now be stale too.
    const nowStale = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), ...MUTATING_HEADERS, 'if-match': workspace.etag },
      body: JSON.stringify({ name: 'Renamed again' }),
    })
    assert.equal(nowStale.status, 409)
  } finally {
    await server.close()
  }
})

test('PATCH rename is owner-only: an editor member is forbidden from renaming', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server, ALLOWED_OID)
    server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'editor' }))

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders({ oid: OTHER_ALLOWED_OID }), ...MUTATING_HEADERS, 'if-match': workspace.etag },
      body: JSON.stringify({ name: 'Hijacked' }),
    })
    assert.equal(response.status, 403)
  } finally {
    await server.close()
  }
})

test('PATCH rename on a workspace the caller is not a member of returns 404, not 403', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server, ALLOWED_OID)
    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders({ oid: OTHER_ALLOWED_OID }), ...MUTATING_HEADERS, 'if-match': workspace.etag },
      body: JSON.stringify({ name: 'Hijacked' }),
    })
    assert.equal(response.status, 404)
  } finally {
    await server.close()
  }
})

test('PATCH rename on an unknown/invalid workspace id returns 404', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces/${encodeURIComponent('../etc/passwd')}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), ...MUTATING_HEADERS, 'if-match': '"whatever"' },
      body: JSON.stringify({ name: 'x' }),
    })
    assert.equal(response.status, 404)
  } finally {
    await server.close()
  }
})
