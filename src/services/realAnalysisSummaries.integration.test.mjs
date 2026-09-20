import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { analysisSummaryFixture, summaryResponse, summaryRunId, summaryWorkspaceId } from './analysisSummaries.test-support.mjs'

const output = resolve(`.summary-service-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
let client
const fixture = analysisSummaryFixture()
const json = (body, status = 200) => Response.json(body, { status })
before(async () => {
  await mkdir(output)
  await build({ entryPoints: [join('src', 'services', 'realAnalyses.ts')], outfile: join(output, 'client.mjs'),
    bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent',
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } })
  client = await import(pathToFileURL(join(output, 'client.mjs')).href)
})
afterEach(() => { globalThis.fetch = originalFetch })
after(async () => { await rm(output, { recursive: true, force: true }) })

test('the independent analysisSummaryGeneration feature controls generation without enabling new scoring runs', async () => {
  globalThis.fetch = async () => json({ realAnalyses: false, analysisSummaryGeneration: true })
  const features = await client.fetchAnalysisProcessingFeatures()
  assert.equal(features.realAnalyses, false)
  assert.equal(features.analysisSummaryGeneration, true)
  for (const value of [undefined, false, 'true']) {
    globalThis.fetch = async () => json({ realAnalyses: true, analysisSummaryGeneration: value })
    assert.equal((await client.fetchAnalysisProcessingFeatures()).analysisSummaryGeneration, false)
  }
})

test('summary GET is read-only, explicitly scoped, no-store and independent of scoring or source readiness', async () => {
  const requests = []
  const targetId = fixture.targets[1].id
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json(summaryResponse(fixture, { targetId: new URL(url, 'https://score.test').searchParams.get('targetId') }))
  }
  const whole = await client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId)
  assert.equal(whole.scope.targetId, null)
  const target = await client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, { targetId, search: 'not a scope' })
  assert.equal(target.scope.targetId, targetId)
  assert.equal(target.targets.length, 1)
  assert.deepEqual(requests.map(({ url }) => url), [
    `/api/workspaces/${summaryWorkspaceId}/analyses/${summaryRunId}/summaries`,
    `/api/workspaces/${summaryWorkspaceId}/analyses/${summaryRunId}/summaries?targetId=${targetId}`,
  ])
  for (const { init } of requests) {
    assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    assert.equal(init.cache, 'no-store')
    assert.equal(init.credentials, 'include')
    assert.equal(init.headers.get('X-Score-Request'), 'workspace')
  }
})

test('initializing summary scopes include every queued manifest pair without treating uninitialized records as invalid', async () => {
  const initializing = analysisSummaryFixture({ firstStatus: 'queued', secondStatus: 'queued' })
  for (const targetId of [null, initializing.targets[1].id]) {
    const value = summaryResponse(initializing, { targetId, targetStatus: 'waiting', uninitializedIds: ['comparison-1', 'comparison-2'] })
    globalThis.fetch = async () => json(value)
    const result = await client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, targetId ? { targetId } : {})
    assert.equal(result.ready, false)
    assert.equal(result.scoring.initialized, 0)
    assert.equal(result.scoring.queued, targetId ? 1 : 2)
    assert.equal(result.capture.comparisons.length, result.scoring.total)
  }
  const malformed = summaryResponse(initializing, { targetStatus: 'waiting', uninitializedIds: ['comparison-1', 'comparison-2'] })
  malformed.scoring.queued--
  malformed.scoring.running++
  globalThis.fetch = async () => json(malformed)
  await assert.rejects(client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId), /mismatched/,
    'A running comparison must already have an initialized work record.')
})

test('summary envelopes reject foreign identities, implicit scopes, malformed counts, missing capture and false readiness', async () => {
  const ready = summaryResponse(fixture, { candidateStatus: 'ready', targetStatus: 'ready' })
  const edits = [
    (value) => { value.workspaceId = 'other-workspace' },
    (value) => { value.runId = 'other-run' },
    (value) => { value.scope.targetId = fixture.targets[0].id },
    (value) => { delete value.capture },
    (value) => { value.capture.revision = 'b'.repeat(64) },
    (value) => { value.capture.comparisons[0].comparisonId = 'foreign-comparison' },
    (value) => { value.capture.comparisons[0].narrative = null },
    (value) => { value.capture.targets[0].narrative.revision = 'c'.repeat(64) },
    (value) => { value.comparisons[0].targetId = 'foreign-target' },
    (value) => { value.etag = '"comparison-etag"' },
    (value) => { value.counts.candidates.ready = -1 },
    (value) => { value.comparisons[0].published.dataKind = 'sample' },
    (value) => { value.comparisons[0].status = 'stale' },
    (value) => { value.targets[0].published.generationId = 'old-generation' },
    (value) => { value.scoring.initialized-- },
  ]
  for (const edit of edits) {
    const body = structuredClone(ready)
    edit(body)
    globalThis.fetch = async () => json(body)
    await assert.rejects(client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId), /summary service returned (an invalid|mismatched)/)
  }
  globalThis.fetch = async () => json(ready)
  await assert.rejects(client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, { targetId: fixture.targets[0].id }), /mismatched/)
  await assert.rejects(client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, { targetId: '' }), /optional exact job or grade/)
  await assert.rejects(client.getRealAnalysisSummaries('', summaryRunId), /saved workspace/)
})

test('summary generation sends only exact scope and mode with the caller summary ETag and stable request key', async () => {
  const requests = []
  const key = randomUUID()
  const targetId = fixture.targets[0].id
  const value = summaryResponse(fixture, { targetId })
  let fail = true
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (fail) return json({ error: { code: 'unavailable', message: 'Acknowledgement interrupted.' } }, 503)
    return json({ requestId: key, scheduled: { candidates: 1, targets: 1 }, summaries: value }, 202)
  }
  const input = { mode: 'missing', targetId, candidateIds: ['filtered-person'], search: 'implicit filter', score: 100 }
  await assert.rejects(client.generateRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, input, value.etag, key), /Acknowledgement interrupted/)
  fail = false
  const result = await client.generateRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, input, value.etag, key)
  assert.equal(result.requestId, key)
  for (const { url, init } of requests) {
    assert.equal(url, `/api/workspaces/${summaryWorkspaceId}/analyses/${summaryRunId}/summaries`)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.get('If-Match'), value.etag)
    assert.equal(init.headers.get('Idempotency-Key'), key)
    assert.deepEqual(JSON.parse(init.body), { mode: 'missing', targetId })
  }
  await assert.rejects(client.generateRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, input, '"pair-etag"', key), /summary ETag/)
  await assert.rejects(client.generateRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, { mode: 'scoring' }, value.etag, key), /Generate missing/)
  await assert.rejects(client.generateRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, input, value.etag, 'new-key'), /stable UUID/)
  assert.equal(requests.length, 2)
})

test('unacknowledged request IDs, foreign mutation scope and aborted reads fail instead of fabricating success', async () => {
  const key = randomUUID()
  const value = summaryResponse(fixture)
  globalThis.fetch = async () => json({ requestId: randomUUID(), scheduled: { candidates: 2, targets: 2 }, summaries: value })
  await assert.rejects(client.generateRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, { mode: 'all' }, value.etag, key), /original request ID/)
  globalThis.fetch = async () => json({ requestId: key, scheduled: { candidates: 2, targets: 2 }, summaries: { ...value, workspaceId: 'foreign' } })
  await assert.rejects(client.generateRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, { mode: 'all' }, value.etag, key), /mismatched/)
  const controller = new AbortController()
  globalThis.fetch = async () => { controller.abort(); return json(value) }
  await assert.rejects(client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId, {}, controller.signal), { name: 'AbortError' })
})
