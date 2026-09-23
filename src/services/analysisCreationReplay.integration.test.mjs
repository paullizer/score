import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, afterEach, before, test } from 'node:test'
import { build } from 'esbuild'
import { api, fixture, seedResume, seedJob, startHttp, NOW } from '../../server-tests/real-analyses.test-support.mjs'

const directory = resolve(`.analysis-creation-replay-${randomUUID()}`)
const nativeFetch = globalThis.fetch
let client

before(async () => {
  await mkdir(directory)
  const output = join(directory, 'client.mjs')
  await build({
    entryPoints: [join('src', 'services', 'realAnalyses.ts')], outfile: output, bundle: true, packages: 'external',
    format: 'esm', platform: 'node', logLevel: 'silent',
  })
  client = await import(pathToFileURL(output).href)
})
afterEach(() => { globalThis.fetch = nativeFetch })
after(async () => { await rm(directory, { recursive: true, force: true }) })

function policyStore() {
  return {
    value: api.createDefaultAdminSettings(), revision: 'original-accepted-policy', unavailable: false, reads: 0,
    async capture() {
      this.reads++
      if (this.unavailable) throw api.unavailable('Current application policy is unavailable.')
      return api.captureProcessingSettings(this.value, this.revision, NOW)
    },
  }
}

function installClientTransport(http, requests, role = () => 'owner') {
  const endpoint = new URL(http.base)
  globalThis.fetch = (url, init = {}) => {
    if (typeof url === 'string' && url.startsWith('/')) {
      assert.equal(url, endpoint.pathname, 'Creation recovery does not consult current features or input catalogs')
      requests.push({ body: init.body, key: init.headers.get('Idempotency-Key') })
      return http.request('', init.method, undefined, {
        role: role(), rawBody: init.body, headers: Object.fromEntries(init.headers),
      })
    }
    assert.equal(new URL(url).origin, endpoint.origin, 'Only the local fixture may receive test traffic')
    return nativeFetch(url, init)
  }
}

for (const change of ['disabled analyses', 'inactive rollout', 'lower comparison limit', 'unavailable policy']) {
  test(`client recovers an actual interrupted immutable manifest after ${change} without reading current settings`, async (t) => {
    const state = fixture(), policy = policyStore()
    const resumes = await Promise.all([seedResume(state, 'First captured resume'), seedResume(state, 'Second captured resume')])
    const job = await seedJob(state)
    const input = { name: 'Original interrupted admission', resumes: resumes.map(value => value.selection), targets: [job.selection] }
    const requestKey = randomUUID()
    const runId = `analysis-run-${requestKey}`
    const http = await startHttp(state, true, policy)
    t.after(() => http.close())
    const requests = []
    let role = 'owner'
    installClientTransport(http, requests, () => role)
    state.analysis.store._beforeCreate(() => { throw new Error('Interrupted after manifest persistence, before run record creation.') })
    const initial = api.projectPublicSettings(api.captureProcessingSettings(policy.value, policy.revision, NOW), true, true)
    const submission = client.startRealAnalysisSubmission(state.workspaceId, input, requestKey, initial)
    await assert.rejects(submission.result, error => error.status === 503)
    assert.equal(await state.analysis.store.get(state.workspaceId, runId), undefined)
    const captured = state.analysis.blobs.values.get(`${state.workspaceId}/${runId}/manifest.json`)
    assert.ok(captured, 'The real server saved its immutable manifest before the interrupted run write')
    const manifest = JSON.parse(Buffer.from(captured.bytes).toString())
    assert.equal(manifest.processingSettings.revision, 'original-accepted-policy')
    state.analysis.store._beforeCreate(undefined)

    policy.revision = 'new-policy'
    if (change === 'disabled analyses') policy.value.features.newAnalyses = false
    if (change === 'inactive rollout') http.config.settings.runtimeEnabled = false
    if (change === 'lower comparison limit') policy.value.analyses.maxComparisons = 1
    if (change === 'unavailable policy') policy.unavailable = true
    const freshKey = randomUUID()
    const fresh = await http.request('', 'POST', input, { headers: { 'idempotency-key': freshKey } })
    assert.equal(fresh.status, change === 'lower comparison limit' ? 400 : 503, await fresh.clone().text())
    assert.equal(await state.analysis.store.get(state.workspaceId, `analysis-run-${freshKey}`), undefined, 'A different request cannot bypass current admission policy')

    const reads = policy.reads
    role = 'viewer'
    await assert.rejects(submission.retry(), error => error.status === 403)
    assert.equal(await state.analysis.store.get(state.workspaceId, runId), undefined, 'Retained request identity does not grant write permission')
    role = 'owner'
    const recovered = await submission.retry()
    assert.equal(policy.reads, reads, 'Accepted recovery and role rejection do not read current settings')
    assert.deepEqual(recovered.run.processingSettings, manifest.processingSettings)
    assert.equal(recovered.run.progress.total, 2)
    assert.equal(recovered.run.id, runId)
    assert.equal(requests.length, 3)
    assert.ok(requests.every(request => request.key === requestKey && request.body === requests[0].body), 'Every recovery keeps identical original bytes and key')
  })
}

test('a retained client request with no accepted manifest remains subject to authoritative new-admission policy', async (t) => {
  const state = fixture(), policy = policyStore()
  const resume = await seedResume(state), job = await seedJob(state)
  const input = { name: 'Never accepted', resumes: [resume.selection], targets: [job.selection] }
  const requestKey = randomUUID()
  const runId = `analysis-run-${requestKey}`
  const initial = api.projectPublicSettings(api.captureProcessingSettings(policy.value, policy.revision, NOW), true, true)
  const http = await startHttp(state, true, policy)
  t.after(() => http.close())
  const requests = []
  installClientTransport(http, requests)
  policy.unavailable = true
  const submission = client.startRealAnalysisSubmission(state.workspaceId, input, requestKey, initial)
  await assert.rejects(submission.result, error => error.status === 503)
  assert.equal(state.analysis.blobs.values.has(`${state.workspaceId}/${runId}/manifest.json`), false)
  policy.unavailable = false
  policy.value.features.newAnalyses = false
  await assert.rejects(submission.retry(), error => error.status === 503)
  assert.equal(await state.analysis.store.get(state.workspaceId, runId), undefined)
  assert.equal(state.analysis.blobs.values.has(`${state.workspaceId}/${runId}/manifest.json`), false)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1], requests[0])
})
