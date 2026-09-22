import assert from 'node:assert/strict'
import test from 'node:test'
import { OTHER_ALLOWED_OID, authHeaders, baseConfig, startTestServer } from './helpers.mjs'

async function start(t, overrides = {}) {
  const server = await startTestServer(overrides)
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

test('configured but unavailable QC storage blocks cleanup even with QC admission disabled', async t => {
  const server = await start(t, {
    config: baseConfig({
      qcEnabled: false,
      qc: { container: 'qc-records', blobContainer: 'qc-sources', workerEnabled: false },
    }),
  })
  const read = await fetch(`${server.workspaceUrl}/state`, { headers: authHeaders() })
  assert.equal(read.status, 200, 'ordinary saved workspace reads do not depend on QC readiness')
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
