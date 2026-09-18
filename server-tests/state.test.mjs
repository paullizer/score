import assert from 'node:assert/strict'
import test from 'node:test'
import { ALLOWED_OID, OTHER_ALLOWED_OID, authHeaders, membershipFor, sampleWorkspaceBody, startTestServer } from './helpers.mjs'

const MUTATING_HEADERS = { origin: 'https://app-score-test.azurewebsites.net', 'X-Score-Request': 'workspace', 'content-type': 'application/json' }

async function bootstrapWorkspace(server, oid = ALLOWED_OID) {
  const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders({ oid }) })
  const body = await response.json()
  return body.workspaces[0]
}

async function getState(server, workspaceId, oid = ALLOWED_OID) {
  return fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/state`, { headers: authHeaders({ oid }) })
}

function putState(server, workspaceId, body, etag, oid = ALLOWED_OID) {
  const headers = { ...authHeaders({ oid }), ...MUTATING_HEADERS }
  if (etag !== undefined) headers['if-match'] = etag
  return fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  })
}

function workspaceWithParsingJob() {
  const document = {
    id: 'doc-1', title: 'Doc', kind: 'job', version: 1,
    paragraphs: [{ id: 'p1', page: 1, heading: 'Intro', text: 'Some text.' }], sample: true,
  }
  const job = {
    id: 'job-1', title: 'Analyst', organization: 'Org', location: 'Somewhere', arrangement: 'Hybrid',
    employmentType: 'Full-time', grade: 'GS-12', series: '0343', source: 'pdf', sourceLabel: 'doc.pdf',
    documentId: document.id, rubricId: null, status: 'parsing', createdAt: new Date().toISOString(),
  }
  return { schemaVersion: 1, jobs: [job], resumes: [], documents: [document], rubrics: [], runs: [] }
}

test('GET state returns the bootstrapped workspace content, with a self-consistent ETag header and body etag', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const response = await getState(server, workspace.id)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(response.headers.get('etag'), body.etag)
    assert.equal(body.workspace.schemaVersion, 1)
    assert.ok(Array.isArray(body.workspace.jobs))
  } finally {
    await server.close()
  }
})

test('PUT state requires an If-Match header (428 when missing)', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const response = await putState(server, workspace.id, sampleWorkspaceBody(), undefined)
    assert.equal(response.status, 428)
  } finally {
    await server.close()
  }
})

test('PUT state rejects a wildcard If-Match', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const response = await putState(server, workspace.id, sampleWorkspaceBody(), '*')
    assert.equal(response.status, 400)
  } finally {
    await server.close()
  }
})

test('PUT state rejects a stale etag with 409 and does not overwrite the stored state', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const before = await (await getState(server, workspace.id)).json()

    const stale = await putState(server, workspace.id, sampleWorkspaceBody(), '"definitely-stale"')
    assert.equal(stale.status, 409)

    const after = await (await getState(server, workspace.id)).json()
    assert.deepEqual(after.workspace, before.workspace)
    assert.equal(after.etag, before.etag)
  } finally {
    await server.close()
  }
})

test('PUT state succeeds with the current etag, returns a new etag, and GET reflects the new content', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const initial = await (await getState(server, workspace.id)).json()

    const edited = structuredClone(initial.workspace)
    edited.jobs[0].title = 'Saved title change'
    const response = await putState(server, workspace.id, edited, initial.etag)
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.notEqual(result.etag, initial.etag)
    assert.equal(response.headers.get('etag'), result.etag)

    const after = await (await getState(server, workspace.id)).json()
    assert.deepEqual(after.workspace, edited)
    assert.equal(after.etag, result.etag)
  } finally {
    await server.close()
  }
})

test('PUT state validates the full workspace and rejects invalid state without touching the stored copy', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const before = await (await getState(server, workspace.id)).json()

    const invalid = await putState(server, workspace.id, { schemaVersion: 1, jobs: 'not-an-array', resumes: [], documents: [], rubrics: [], runs: [] }, before.etag)
    assert.equal(invalid.status, 400)
    const invalidBody = await invalid.json()
    assert.equal(invalidBody.error.code, 'invalid_request')

    const unexpectedField = await putState(server, workspace.id, { ...sampleWorkspaceBody(), extraField: true }, before.etag)
    assert.equal(unexpectedField.status, 400)

    const after = await (await getState(server, workspace.id)).json()
    assert.deepEqual(after.workspace, before.workspace)
    assert.equal(after.etag, before.etag, 'a rejected PUT must not advance the stored etag')
  } finally {
    await server.close()
  }
})

test('The server never auto-recovers interrupted work on a plain GET (that is a client display decision)', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const before = await (await getState(server, workspace.id)).json()

    const incoming = workspaceWithParsingJob()
    const next = { ...before.workspace, jobs: [...incoming.jobs, ...before.workspace.jobs],
      documents: [...before.workspace.documents, ...incoming.documents] }
    const put = await putState(server, workspace.id, next, before.etag)
    assert.equal(put.status, 200)

    const after = await (await getState(server, workspace.id)).json()
    assert.equal(after.workspace.jobs[0].status, 'parsing', 'GET must return the raw stored status, not a cancelled/recovered one')
  } finally {
    await server.close()
  }
})

test('Viewers can read state but cannot write it; editors can do both', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server, ALLOWED_OID)
    server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))

    const viewerGet = await getState(server, workspace.id, OTHER_ALLOWED_OID)
    assert.equal(viewerGet.status, 200)
    const viewerBody = await viewerGet.json()

    const viewerPut = await putState(server, workspace.id, sampleWorkspaceBody(), viewerBody.etag, OTHER_ALLOWED_OID)
    assert.equal(viewerPut.status, 403)

    // Promote to editor and confirm write access now works.
    server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'editor' }))
    const editorPut = await putState(server, workspace.id, viewerBody.workspace, viewerBody.etag, OTHER_ALLOWED_OID)
    assert.equal(editorPut.status, 200)
  } finally {
    await server.close()
  }
})

test('whole-state saves cannot silently remove library records without lifecycle deletion bookkeeping', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)
    const before = await (await getState(server, workspace.id)).json()
    assert.equal((await putState(server, workspace.id, sampleWorkspaceBody(), before.etag)).status, 409)
    assert.deepEqual((await (await getState(server, workspace.id)).json()).workspace, before.workspace)
  } finally { await server.close() }
})

test('Corrupt or missing stored state surfaces as unavailable, never fabricated sample data', async () => {
  const server = await startTestServer()
  try {
    const workspace = await bootstrapWorkspace(server)

    server.state._setRawContent(workspace.id, 'not valid json {{{')
    const corrupt = await getState(server, workspace.id)
    assert.equal(corrupt.status, 503)
    const corruptBody = await corrupt.json()
    assert.equal(corruptBody.error.code, 'unavailable')

    await server.state.deleteState(workspace.id)
    const missing = await getState(server, workspace.id)
    assert.equal(missing.status, 503)
    const missingBody = await missing.json()
    assert.equal(missingBody.error.code, 'unavailable')
  } finally {
    await server.close()
  }
})

test('GET/PUT state on an unknown workspace id returns 404', async () => {
  const server = await startTestServer()
  try {
    const response = await getState(server, 'this-workspace-does-not-exist')
    assert.equal(response.status, 404)
  } finally {
    await server.close()
  }
})
