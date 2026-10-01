import assert from 'node:assert/strict'
import test from 'node:test'
import { OTHER_ALLOWED_OID, authHeaders, baseConfig, membershipFor, startTestServer } from './helpers.mjs'

async function start(t, overrides = {}) {
  const server = await startTestServer({ seedWorkspace: true, ...overrides })
  t.after(() => server.close())
  const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
  assert.equal(response.status, 200)
  const workspace = (await response.json()).workspaces[0]
  return { ...server, workspace, workspaceUrl: `${server.baseUrl}/api/workspaces/${workspace.id}` }
}

test('the mounted QC router is authenticated, workspace scoped, and explicitly unavailable without stores', async t => {
  const server = await start(t)
  const url = `${server.workspaceUrl}/qc/capabilities`
  assert.equal((await fetch(url)).status, 401)
  assert.ok([403, 404].includes((await fetch(url, {
    headers: authHeaders({ oid: OTHER_ALLOWED_OID }),
  })).status))
  const response = await fetch(url, { headers: authHeaders() })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control'), /no-store/)
  const capabilities = await response.json()
  assert.equal(capabilities.reviews, false)
  assert.equal(capabilities.improvements, false)
  assert.equal(capabilities.admissionEnabled, false)
  assert.equal(capabilities.writable, false)
  assert.match(capabilities.message, /not enabled/)
  assert.equal((await fetch(url, {
    headers: { ...authHeaders(), 'Sec-Fetch-Site': 'cross-site' },
  })).status, 403)
})

test('QC routes share one per-user request limit, checked after the same-origin check', async t => {
  const server = await start(t)
  server.directory._addMembership(server.workspace.id, membershipFor(server.workspace.id, { oid: OTHER_ALLOWED_OID, role: 'reviewer' }))
  const url = `${server.workspaceUrl}/qc/capabilities`
  for (let attempt = 1; attempt <= 300; attempt += 1) {
    const response = await fetch(url, { headers: authHeaders() })
    assert.equal(response.status, 200, `request ${attempt} stays under the limit`)
    await response.arrayBuffer()
  }

  const limited = await fetch(`${server.workspaceUrl}/qc/batches`, { headers: authHeaders() })
  assert.equal(limited.status, 429, 'every QC route shares one budget')
  assert.match(limited.headers.get('retry-after'), /^[1-9]\d*$/)
  assert.match(limited.headers.get('cache-control'), /no-store/)
  const body = await limited.json()
  assert.equal(body.error.code, 'unavailable')
  assert.match(body.error.message, /^QC request limit reached\. Try again in about \d+ seconds?\.$/)
  const crossSite = await fetch(url, { headers: { ...authHeaders(), 'Sec-Fetch-Site': 'cross-site' } })
  assert.equal(crossSite.status, 403, 'cross-site requests are refused before they reach the limiter')
  await crossSite.arrayBuffer()

  const other = await fetch(url, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })
  assert.equal(other.status, 200, 'another workspace member has a separate quota')
  await other.arrayBuffer()
  const members = await fetch(`${server.workspaceUrl}/members`, { headers: authHeaders() })
  assert.equal(members.status, 200, 'limiting QC requests does not block other workspace routes')
  await members.arrayBuffer()
})

test('configured but unavailable QC storage blocks cleanup even with QC admission disabled', async t => {
  const server = await start(t, {
    config: baseConfig({
      qcEnabled: false,
      qc: { container: 'qc-records', blobContainer: 'qc-sources', workerEnabled: false },
    }),
  })
  const read = await fetch(`${server.workspaceUrl}/members`, { headers: authHeaders() })
  assert.equal(read.status, 200, 'ordinary workspace access reads do not depend on QC readiness')
  const impact = await fetch(`${server.workspaceUrl}/lifecycle`, { headers: authHeaders() })
  assert.equal(impact.status, 503)
  assert.match(JSON.stringify(await impact.json()), /QC storage.*cannot skip/)
})

test('startup awaits immutable prompt initialization instead of advertising partial readiness', async t => {
  let release
  const ready = new Promise(resolve => { release = resolve })
  let calls = 0
  const server = await start(t, { prompts: { async current() { calls++; await ready; return {} } } })
  let completed = false
  const bootstrap = server.app.locals.bootstrapSettings().then(value => { completed = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(completed, false)
  release()
  assert.equal(await bootstrap, undefined)
  assert.equal(completed, true)
})

test('unavailable configured prompt initialization propagates to the startup retry path', async t => {
  const server = await start(t, { prompts: {
    async current() { throw new Error('Prompt storage is unavailable') },
  } })
  await assert.rejects(server.app.locals.bootstrapSettings(), /Prompt storage is unavailable/)
})
