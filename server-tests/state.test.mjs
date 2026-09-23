import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALLOWED_OID, APP_ORIGIN, CSRF_HEADER, OTHER_ALLOWED_OID, authHeaders, legacyStateBody,
  membershipFor, seedWorkspace, startTestServer,
} from './helpers.mjs'

const goneBody = {
  error: { code: 'not_found', message: 'This version of Score is out of date. Reload the page.' },
}

async function readJson(response) {
  return { status: response.status, body: await response.json() }
}

test('GET /state returns 410 without touching directory authorization or legacy state storage', async t => {
  const server = await startTestServer()
  t.after(() => server.close())
  const workspace = await seedWorkspace(server)
  server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
  server.state._setRawContent(workspace.id, JSON.stringify({ ...legacyStateBody(), runs: [{ id: 'legacy-sample-run' }] }))
  const before = await server.state.getState(workspace.id)
  server.state._clearOperations()
  const directoryReads = server.directory._metadataReadCount()

  const known = await readJson(await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/state`, {
    headers: authHeaders({ oid: OTHER_ALLOWED_OID }),
  }))
  assert.deepEqual(known, { status: 410, body: goneBody })

  const unknown = await readJson(await fetch(`${server.baseUrl}/api/workspaces/unknown-workspace/state`, {
    headers: authHeaders(),
  }))
  assert.deepEqual(unknown, { status: 410, body: goneBody })
  assert.deepEqual(await server.state.getState(workspace.id), before)
  assert.deepEqual(server.state._operations(), ['getState'])
  assert.equal(server.directory._metadataReadCount(), directoryReads)
})

test('PUT /state returns 410 without touching directory authorization or legacy state storage', async t => {
  const server = await startTestServer()
  t.after(() => server.close())
  const workspace = await seedWorkspace(server)
  server.state._setRawContent(workspace.id, JSON.stringify(legacyStateBody()))
  const before = await server.state.getState(workspace.id)
  server.state._clearOperations()
  const directoryReads = server.directory._metadataReadCount()

  const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/state`, {
    method: 'PUT',
    headers: { ...authHeaders(), Origin: APP_ORIGIN, ...CSRF_HEADER, 'Content-Type': 'application/json', 'If-Match': before.etag },
    body: JSON.stringify({ ...legacyStateBody(), jobs: [{ id: 'must-not-save' }] }),
  })
  assert.deepEqual(await readJson(response), { status: 410, body: goneBody })
  assert.deepEqual(await server.state.getState(workspace.id), before)
  assert.deepEqual(server.state._operations(), ['getState'])
  assert.equal(server.directory._metadataReadCount(), directoryReads)
})

test('state routes still run auth and CSRF before the gone handler', async t => {
  const server = await startTestServer()
  t.after(() => server.close())

  assert.equal((await fetch(`${server.baseUrl}/api/workspaces/anything/state`)).status, 401)

  const put = await fetch(`${server.baseUrl}/api/workspaces/anything/state`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(legacyStateBody()),
  })
  assert.equal(put.status, 403)
  assert.deepEqual(server.state._operations(), [])
  assert.equal(server.directory._metadataReadCount(), 0)
})
