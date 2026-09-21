import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  correctionFixture, correctionPreview, correctionSummary, correctionHistory, correctionReason,
} from './analysisCorrections.synthetic.test-support.mjs'

const output = resolve(`.correction-service-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
const fixture = correctionFixture()
const workspaceId = fixture.workspaceId
const runId = fixture.summary.run.id
const comparisonId = fixture.details[0].comparison.id
const root = `/api/workspaces/${workspaceId}/analyses/${runId}/comparisons/${comparisonId}/corrections`
let client, state, CloudApiError
before(async () => {
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      export * from './src/services/analysisCorrections'
      export * as state from './src/features/analyses/analysisCorrectionState'
      export { CloudApiError } from './src/services/cloudWorkspace'
    ` }, outfile: join(output, 'client.mjs'), bundle: true, packages: 'external', format: 'esm',
    platform: 'node', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' },
  })
  client = await import(pathToFileURL(join(output, 'client.mjs')).href)
  state = client.state
  CloudApiError = client.CloudApiError
})
afterEach(() => { globalThis.fetch = originalFetch })
after(async () => { await rm(output, { recursive: true, force: true }) })

test('correction preview is an exact, abortable, read-only request and preserves a server-calculated zero', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return Response.json(correctionPreview(fixture, comparisonId)) }
  const preview = await client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId)
  assert.equal(preview.before.overall.score, null)
  assert.equal(preview.after.overall.score, 0)
  assert.equal(preview.after.coverage.assessedWeight, 100)
  assert.equal(requests[0].url, `${root}/preview`)
  assert.equal(requests[0].init.method, 'GET')
  assert.equal(requests[0].init.body, undefined)
  assert.equal(requests[0].init.credentials, 'include')
  assert.equal(requests[0].init.cache, 'no-store')
  assert.equal(requests[0].init.headers.get('X-Score-Request'), 'workspace')
  const controller = new AbortController()
  globalThis.fetch = async () => { controller.abort(); return Response.json(preview) }
  await assert.rejects(client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId, controller.signal), { name: 'AbortError' })
})

test('preview guards reject foreign ownership, incorrect score shapes, incomplete blockers, ETags and hashes', async () => {
  const edits = [
    value => { value.workspaceId = 'foreign' },
    value => { value.runId = 'foreign' },
    value => { value.comparisonId = 'foreign' },
    value => { value.dataKind = 'sample' },
    value => { value.resultSha256 = 'invalid-hash' },
    value => { value.originalResultSha256 = 'invalid-hash' },
    value => { value.originalResultSha256 = 'f'.repeat(64) },
    value => { value.etag = 'not-quoted' },
    value => { value.before.overall.score = 0 },
    value => { value.after.overall.score = null },
    value => { value.after.overall.score = 101 },
    value => { value.after.coverage.supported = 1 },
    value => { value.after.coverage.totalWeight = 90 },
    value => { value.criteria[0].eligible = false },
    value => { value.criteria[0].blockedReason = 'Blocked but selectable' },
    value => { value.criteria[0].limitation.code = 'source-quality' },
    value => { value.criteria[0].criterionId = 'unrelated' },
    value => { value.criterionIds.push(value.criterionIds[0]) },
    value => { value.criteria.push(value.criteria[0]) },
    value => { value.after = null },
    value => { value.correction = correctionSummary(fixture, comparisonId) },
    value => {
      value.correction = correctionSummary(fixture, comparisonId, { status: 'ready', originalHash: 'f'.repeat(64) })
      value.etag = value.correction.etag
    },
  ]
  for (const edit of edits) {
    const value = correctionPreview(fixture, comparisonId)
    edit(value)
    globalThis.fetch = async () => Response.json(value)
    await assert.rejects(client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId), /invalid|mismatched/)
  }
  const blocked = correctionPreview(fixture, comparisonId, { blocked: true })
  globalThis.fetch = async () => Response.json(blocked)
  assert.equal((await client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId)).after, null)
  await assert.rejects(client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId, undefined, 'f'.repeat(64)), /mismatched/)
  blocked.criteria[0].blockedReason = null
  await assert.rejects(client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId), /mismatched/)
})

test('each correction sends only a reviewed hash, criteria and reason with its stable key and original If-Match', async () => {
  const key = randomUUID()
  const preview = correctionPreview(fixture, comparisonId)
  const input = { resultSha256: preview.resultSha256, criterionIds: preview.criterionIds, reason: correctionReason, score: 100, workspaceId: 'foreign' }
  const requests = []
  let fail = true
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (fail) throw new TypeError('Synthetic ambiguous network interruption.')
    return Response.json({ requestId: key, correction: correctionSummary(fixture, comparisonId, { requestId: key }) }, { status: 202 })
  }
  await assert.rejects(client.requestAnalysisCorrection(workspaceId, runId, comparisonId, input, preview.etag, key), /interruption/)
  fail = false
  const response = await client.requestAnalysisCorrection(workspaceId, runId, comparisonId, input, preview.etag, key)
  assert.equal(response.requestId, key)
  for (const { url, init } of requests) {
    assert.equal(url, root)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.get('If-Match'), preview.etag)
    assert.equal(init.headers.get('Idempotency-Key'), key)
    assert.deepEqual(JSON.parse(init.body), { resultSha256: preview.resultSha256, criterionIds: preview.criterionIds, reason: correctionReason })
  }
  await assert.rejects(client.requestAnalysisCorrection(workspaceId, runId, comparisonId, input, '', key), /ETag/)
  await assert.rejects(client.requestAnalysisCorrection(workspaceId, runId, comparisonId, input, preview.etag, 'unstable'), /stable UUID/)
  await assert.rejects(client.requestAnalysisCorrection(workspaceId, runId, comparisonId, { ...input, reason: 'yes' }, preview.etag, key), /meaningful/)
  assert.equal(requests.length, 2)
})

test('unacknowledged IDs, foreign corrections and altered request/hash/criteria bindings do not become successes', async () => {
  const key = randomUUID()
  const preview = correctionPreview(fixture, comparisonId)
  const input = { resultSha256: preview.resultSha256, criterionIds: preview.criterionIds, reason: correctionReason }
  for (const edit of [
    value => { value.requestId = randomUUID() },
    value => { value.correction.requestId = randomUUID() },
    value => { value.correction.workspaceId = 'foreign' },
    value => { value.correction.runId = 'foreign' },
    value => { value.correction.comparisonId = 'foreign' },
    value => { value.correction.status = 'complete' },
    value => { value.correction.reason = 'Different meaningful reason.' },
    value => { value.correction.criterionIds = ['unselected'] },
    value => { value.correction.revision.baseResultSha256 = 'f'.repeat(64) },
    value => { value.correction.revision.criterionIds = ['unselected'] },
    value => { value.correction.revision.id = randomUUID() },
    value => { value.correction.revision = null },
  ]) {
    const response = { requestId: key, correction: correctionSummary(fixture, comparisonId, { requestId: key, status: 'ready' }) }
    edit(response)
    globalThis.fetch = async () => Response.json(response)
    await assert.rejects(client.requestAnalysisCorrection(workspaceId, runId, comparisonId, input, preview.etag, key), /acknowledged|mismatched|acknowledgement/)
  }
})

test('point-read status validates current states and cancellation binds the exact current ETag and request', async () => {
  const correction = correctionSummary(fixture, comparisonId)
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return Response.json(init.method === 'GET' ? { correction } : {
      requestId: correction.requestId, correction: { ...correction, etag: '"cancelled-head"', status: 'cancelled' },
    })
  }
  assert.deepEqual(await client.getAnalysisCorrection(workspaceId, runId, comparisonId), correction)
  assert.equal((await client.cancelAnalysisCorrection(workspaceId, runId, comparisonId, correction)).correction.status, 'cancelled')
  assert.deepEqual(requests.map(value => value.url), [root, `${root}/cancel`])
  assert.equal(requests[1].init.headers.get('If-Match'), correction.etag)
  assert.equal(requests[1].init.headers.has('Idempotency-Key'), false)
  assert.equal(requests[1].init.body, '{}')
  globalThis.fetch = async () => Response.json({ correction: { ...correction, status: 'ready' } })
  await assert.rejects(client.getAnalysisCorrection(workspaceId, runId, comparisonId), /invalid status/)
  globalThis.fetch = async () => Response.json({ requestId: randomUUID(), correction: { ...correction, status: 'cancelled' } })
  await assert.rejects(client.cancelAnalysisCorrection(workspaceId, runId, comparisonId, correction), /Cancellation was not acknowledged/)
  globalThis.fetch = async () => Response.json({ correction: null })
  assert.equal(await client.getAnalysisCorrection(workspaceId, runId, comparisonId), null)
  globalThis.fetch = async () => Response.json({ correction: correctionSummary(fixture, comparisonId, { status: 'ready' }) })
  await assert.rejects(client.getAnalysisCorrection(workspaceId, runId, comparisonId, undefined, 'f'.repeat(64)), /mismatched/)
})

test('cancellation preserves a retained terminal failure and safely acknowledges repeated cancellation without hiding publication conflicts', async () => {
  const queued = correctionSummary(fixture, comparisonId)
  const failed = correctionSummary(fixture, comparisonId, { requestId: queued.requestId, status: 'failed' })
  const cancelled = correctionSummary(fixture, comparisonId, { requestId: queued.requestId, status: 'cancelled' })
  const requests = []
  let terminal = failed
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return Response.json({ requestId: terminal.requestId, correction: terminal })
  }
  const raced = await client.cancelAnalysisCorrection(workspaceId, runId, comparisonId, queued)
  assert.equal(raced.correction.status, 'failed')
  assert.deepEqual(raced.correction.error, failed.error)
  assert.equal(requests[0].init.headers.get('If-Match'), queued.etag)
  assert.deepEqual((await client.cancelAnalysisCorrection(workspaceId, runId, comparisonId, failed)).correction, failed)
  assert.equal(requests[1].init.headers.get('If-Match'), failed.etag)
  terminal = cancelled
  assert.deepEqual((await client.cancelAnalysisCorrection(workspaceId, runId, comparisonId, cancelled)).correction, cancelled)
  assert.equal(requests[2].init.headers.get('If-Match'), cancelled.etag)
  const published = correctionSummary(fixture, comparisonId, { requestId: queued.requestId, status: 'ready' })
  await assert.rejects(client.cancelAnalysisCorrection(workspaceId, runId, comparisonId, published), /non-published correction/)
  assert.equal(requests.length, 3)
  globalThis.fetch = async () => Response.json({
    error: { code: 'conflict', message: 'This correction was published and cannot be cancelled.' },
  }, { status: 409 })
  await assert.rejects(client.cancelAnalysisCorrection(workspaceId, runId, comparisonId, queued), /published and cannot be cancelled/)
})

test('history keeps the immutable original, proposed zero and failed review distinct from publication, with bounded safe pages', async () => {
  const history = correctionHistory(fixture, comparisonId)
  let lastUrl
  globalThis.fetch = async url => { lastUrl = url; return Response.json({ ...history, blobName: 'must-not-leak' }) }
  const value = await client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId, 'scoped+cursor/')
  assert.equal(lastUrl, `${root}/history?continuationToken=scoped%2Bcursor%2F`)
  assert.deepEqual(value, history)
  assert.equal(value.entries[0].after.overall.score, 0)
  assert.equal(value.entries[0].resultSha256, null)
  assert.equal(value.entries[0].review.outcome, 'needs-correction')
  for (const edit of [
    item => { item.workspaceId = 'foreign' },
    item => { item.comparisonId = 'foreign' },
    item => { item.runId = 'foreign' },
    item => { item.entries[0].resultSha256 = 'f'.repeat(64) },
    item => { item.entries[0].after.overall.score = -1 },
    item => { item.entries[0].requestId = 'not-a-uuid' },
    item => { item.originalAssessment.criteria[0].score = 0 },
    item => { item.originalAssessment.criteria[0].criterionId = 'foreign-original-row' },
    item => { item.originalAssessment.criteria.push(item.originalAssessment.criteria[0]) },
    item => { delete item.originalAssessment },
    item => { item.entries[0].outcome = 'ready' },
    item => { item.entries.push(item.entries[0]) },
    item => { item.entries = Array(13).fill(item.entries[0]) },
    item => { item.continuationToken = 'repeat' },
  ]) {
    const invalid = structuredClone(history)
    edit(invalid)
    globalThis.fetch = async () => Response.json(invalid)
    await assert.rejects(client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId, 'repeat'), /history|publication/)
  }
  const published = correctionHistory(fixture, comparisonId, { status: 'ready' })
  globalThis.fetch = async () => Response.json(published)
  assert.equal((await client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId)).entries[0].outcome, 'ready')
  await assert.rejects(client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId, undefined, undefined, 'f'.repeat(64)), /mismatched/)
})

test('request journal replays immutable input after ambiguity; known rejection or terminal acknowledgement needs a fresh request', () => {
  const journal = new state.CorrectionRequestJournal()
  const preview = correctionPreview(fixture, comparisonId)
  const first = journal.prepare(comparisonId, preview, correctionReason)
  const edited = { ...preview, resultSha256: 'b'.repeat(64), etag: '"different"' }
  assert.equal(journal.reject(comparisonId, new TypeError('No acknowledgement.')), false)
  assert.equal(journal.reject(comparisonId, new CloudApiError('unavailable', 'Busy.', 503)), false)
  assert.equal(journal.prepare(comparisonId, edited, 'Edited reason must not replace pending input.'), first)
  assert.equal(first.input.resultSha256, preview.resultSha256)
  assert.equal(first.etag, preview.etag)
  journal.acknowledge(comparisonId, correctionSummary(fixture, comparisonId))
  assert.equal(journal.get(comparisonId), first)
  assert.throws(() => journal.acknowledge(comparisonId, correctionSummary(fixture, comparisonId, {
    requestId: first.key, reason: 'This is a different request reason.',
  })), /does not match/)
  assert.equal(journal.get(comparisonId), first)
  const failed = correctionSummary(fixture, comparisonId, { requestId: first.key, status: 'failed' })
  journal.acknowledge(comparisonId, failed)
  assert.equal(journal.get(comparisonId), undefined)
  const next = journal.prepare(comparisonId, { ...preview, etag: failed.etag, correction: failed }, correctionReason)
  assert.notEqual(next.key, first.key)
  assert.equal(next.etag, failed.etag)
  assert.equal(journal.reject(comparisonId, new CloudApiError('conflict', 'Stale preview.', 409)), true)
  assert.equal(journal.get(comparisonId), undefined)
  assert.throws(() => journal.prepare(comparisonId, { ...preview, correction: correctionSummary(fixture, comparisonId) }, correctionReason), /fresh selectable preview/)
})

test('run selection preserves all 388 numeric results and all existing zero scores, while bounded work does not truncate beyond 25', async () => {
  const bulk = correctionFixture({ withheld: 24, numeric: 388, failed: 0 })
  const before = structuredClone(bulk.details)
  const selected = state.availableWithheldComparisons(bulk.details)
  assert.equal(selected.length, 24)
  assert.deepEqual(bulk.details, before)
  assert.equal(bulk.details[24].comparison.resultSummary.overall.score, 0)
  const larger = correctionFixture({ withheld: 31, numeric: 2, failed: 2 })
  const ids = state.availableWithheldComparisons(larger.details).map(item => item.comparison.id)
  const completed = []
  let active = 0, maximum = 0
  await state.boundedCorrectionWork(ids, async id => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    completed.push(id)
    active--
  }, new AbortController().signal)
  assert.equal(maximum, 2)
  assert.deepEqual(completed.sort(), [...ids].sort())
  assert.equal(completed.length, 31)
  const controller = new AbortController()
  const stopped = []
  await state.boundedCorrectionWork(ids, async id => { stopped.push(id); controller.abort() }, controller.signal)
  assert.equal(stopped.length, 1)
})
