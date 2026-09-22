import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { analysisSummaryFixture, summaryHistoryFixture, summaryResponse, summarySubjectResponse, summaryRunId, summaryTimestamp, summaryWorkspaceId } from './analysisSummaries.test-support.mjs'

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

test('subject reads request only one exact candidate or target and retain legacy and approved v2 publications', async () => {
  const requests = []
  for (const subject of [
    { kind: 'candidate', subjectId: fixture.details[0].comparison.id },
    { kind: 'target', subjectId: fixture.targets[1].id },
  ]) {
    for (const summaryVersion of [undefined, 2]) {
      const approval = { kind: 'manual', approvedAt: summaryTimestamp, approvedBy: 'workspace-editor',
        reviewOutcome: 'needs-correction', issues: summaryHistoryFixture(fixture, subject).entries[0].review.issues }
      const value = summarySubjectResponse(fixture, subject, { candidateStatus: 'ready', targetStatus: 'ready', summaryVersion, approval })
      globalThis.fetch = async (url, init) => {
        requests.push({ url, init })
        return Response.json(value, { headers: { ETag: value.etag } })
      }
      const result = await client.getRealAnalysisSummarySubject(summaryWorkspaceId, summaryRunId, subject)
      assert.deepEqual(result, value)
      assert.equal(result.narrative.published.summaryVersion, summaryVersion)
      assert.equal(result.comparisons, undefined, 'A subject response contains no unrelated candidate text.')
      const request = requests.at(-1)
      assert.equal(request.url, `/api/workspaces/${summaryWorkspaceId}/analyses/${summaryRunId}/summaries/${subject.kind}/${subject.subjectId}`)
      assert.equal(request.init.method, 'GET')
      assert.equal(request.init.cache, 'no-store')
      assert.equal(request.init.body, undefined)
    }
  }
  assert.equal(requests.length, 4)
})

test('subject reads reject mismatched identities, kinds, exact revisions, header ETags and false current publications', async () => {
  const subject = { kind: 'candidate', subjectId: fixture.details[0].comparison.id }
  const ready = summarySubjectResponse(fixture, subject, { candidateStatus: 'ready' })
  for (const edit of [
    value => { value.workspaceId = 'foreign' },
    value => { value.runId = 'foreign' },
    value => { value.kind = 'target' },
    value => { value.subjectId = 'comparison-2' },
    value => { value.narrative.comparisonId = 'comparison-2' },
    value => { value.narrative.kind = 'target' },
    value => { value.etag = '"foreign"' },
    value => { value.revision = 'b'.repeat(64) },
    value => { value.narrative.published.dataKind = 'sample' },
    value => { value.narrative.published.inputFingerprint = 'b'.repeat(64) },
    value => { value.narrative.published.generationId = 'older' },
    value => { value.narrative.comparisonStatus = 'failed' },
    value => { value.narrative.published = null },
    value => { value.narrative.published.summaryVersion = 2 },
  ]) {
    const invalid = structuredClone(ready)
    edit(invalid)
    globalThis.fetch = async () => Response.json(invalid, { headers: { ETag: invalid.etag } })
    await assert.rejects(client.getRealAnalysisSummarySubject(summaryWorkspaceId, summaryRunId, subject), /invalid saved-summary|mismatched/)
  }
  for (const etag of [undefined, '"different-revision"']) {
    globalThis.fetch = async () => Response.json(ready, { headers: etag ? { ETag: etag } : {} })
    await assert.rejects(client.getRealAnalysisSummarySubject(summaryWorkspaceId, summaryRunId, subject), /mismatched/)
  }
  const target = { kind: 'target', subjectId: fixture.targets[0].id }
  const invalidTarget = summarySubjectResponse(fixture, target, { targetStatus: 'ready' })
  invalidTarget.narrative.targetId = fixture.targets[1].id
  globalThis.fetch = async () => Response.json(invalidTarget, { headers: { ETag: invalidTarget.etag } })
  await assert.rejects(client.getRealAnalysisSummarySubject(summaryWorkspaceId, summaryRunId, target), /mismatched/)
  for (const status of ['running', 'failed', 'stale', 'cancelled']) {
    const value = summarySubjectResponse(fixture, subject, { candidateStatus: status, previous: true })
    globalThis.fetch = async () => Response.json(value, { headers: { ETag: value.etag } })
    assert.equal((await client.getRealAnalysisSummarySubject(summaryWorkspaceId, summaryRunId, subject)).narrative.status, status,
      'Prior publications remain readable, with their real status rather than fabricated readiness.')
  }
  const controller = new AbortController()
  globalThis.fetch = async () => { controller.abort(); return Response.json(ready, { headers: { ETag: ready.etag } }) }
  await assert.rejects(client.getRealAnalysisSummarySubject(summaryWorkspaceId, summaryRunId, subject, controller.signal), { name: 'AbortError' })
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
    (value) => { value.comparisons[0].resultSha256 = 'f'.repeat(64) },
    (value) => { value.comparisons[0].resultSha256 = null },
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

test('v2 summaries preserve manual approval, long two-sentence numerical prose and private-history progress metadata', async () => {
  const history = summaryHistoryFixture(fixture)
  const approval = { kind: 'manual', approvedAt: summaryTimestamp, approvedBy: 'workspace-editor',
    reviewOutcome: 'needs-correction', issues: history.entries[0].review.issues }
  const text = `The Ph.D. engineer's saved assessment records 1,000 as 1000, 12.0 as 12, 60/100, and a rated 480-volt system, ${'with documented applied methods, '.repeat(50)}without rescoring. Its limits remain recorded.`
  const value = summaryResponse(fixture, { candidateStatus: 'ready', targetStatus: 'ready',
    text, paragraphs: Array(5).fill(text), summaryVersion: 2, approval, hasHistory: true, summaryRound: 3 })
  globalThis.fetch = async () => json(value)
  const result = await client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId)
  assert.equal(result.comparisons[0].published.text, text)
  assert.deepEqual(result.comparisons[0].published.approval, approval)
  assert.equal(result.comparisons[0].published.summaryVersion, 2)
  assert.deepEqual(result.targets[0].published.paragraphs, Array(5).fill(text))
  assert.equal(result.comparisons[0].hasHistory, true)
  assert.equal(result.comparisons[0].summaryRound, 3)
  const failure = summaryResponse(fixture, { candidateStatus: 'failed', states: { 'comparison-1': {
    diagnostic: { reason: 'factual-review', round: 3, modelCallId: randomUUID(), issueCount: 1 },
  } } })
  globalThis.fetch = async () => json(failure)
  assert.deepEqual((await client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId)).comparisons[0].error.diagnostic,
    failure.comparisons[0].error.diagnostic)
  for (const edit of [
    item => { delete item.summaryVersion },
    item => { delete item.approval },
    item => { item.summaryVersion = 3 },
    item => { item.text = ' ' },
    item => { item.text = 'x'.repeat(16_001) },
    item => { item.approval.issues[0].field = 'foreign' },
  ]) {
    const invalid = structuredClone(value)
    edit(invalid.comparisons[0].published)
    globalThis.fetch = async () => json(invalid)
    await assert.rejects(client.getRealAnalysisSummaries(summaryWorkspaceId, summaryRunId), /invalid saved-summary envelope/)
  }
})

test('private summary history GET validates subject identity and keeps complete draft/review checkpoints', async () => {
  const history = summaryHistoryFixture(fixture)
  const subject = { kind: 'candidate', subjectId: 'comparison-1' }
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json(history) }
  const read = await client.getRealAnalysisSummaryHistory(summaryWorkspaceId, summaryRunId, subject, 'opaque+scoped/cursor')
  assert.deepEqual(read, history)
  assert.equal(requests[0].url, `/api/workspaces/${summaryWorkspaceId}/analyses/${summaryRunId}/summaries/candidate/comparison-1/history?continuationToken=opaque%2Bscoped%2Fcursor`)
  assert.equal(requests[0].init.method, 'GET')
  assert.equal(requests[0].init.cache, 'no-store')
  assert.equal(requests[0].init.body, undefined)
  for (const edit of [
    page => { page.workspaceId = 'foreign' },
    page => { page.subjectId = 'comparison-2' },
    page => { page.entries[0].kind = 'target' },
    page => { page.entries[0].runId = 'foreign' },
    page => { page.entries[0].draft.kind = 'reduction' },
    page => { page.entries[0].review.outputSha256 = 'f'.repeat(64) },
    page => { page.entries.push(page.entries[0]) },
    page => { page.continuationToken = 'same' },
  ]) {
    const invalid = structuredClone(history)
    edit(invalid)
    globalThis.fetch = async () => json(invalid)
    await assert.rejects(client.getRealAnalysisSummaryHistory(summaryWorkspaceId, summaryRunId, subject, 'same'), /private (?:summary )?history/)
  }
  const controller = new AbortController()
  globalThis.fetch = async () => { controller.abort(); return json(history) }
  await assert.rejects(client.getRealAnalysisSummaryHistory(summaryWorkspaceId, summaryRunId, subject, undefined, controller.signal), { name: 'AbortError' })
})

test('publication, resume and confirmed restart send exact intent, original ETag and stable UUID only', async () => {
  const history = summaryHistoryFixture(fixture)
  const draft = history.entries[0]
  const subject = { kind: history.kind, subjectId: history.subjectId }
  const input = { generationId: draft.generationId, round: draft.round, outputSha256: draft.outputSha256 }
  const summaries = summaryResponse(fixture, { targetId: draft.targetId })
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ summaries }) }
  const key = randomUUID()
  for (let replay = 0; replay < 2; replay++) {
    await client.publishRealAnalysisSummaryDraft(summaryWorkspaceId, summaryRunId, subject, input, history.etag, key, draft.targetId)
  }
  await client.retryRealAnalysisSummary(summaryWorkspaceId, summaryRunId, subject, history.etag, key, draft.targetId)
  await client.restartRealAnalysisSummary(summaryWorkspaceId, summaryRunId, subject, history.etag, key, draft.targetId)
  assert.deepEqual(requests.map(item => JSON.parse(item.init.body)), [input, input, {}, { confirmRestart: true }])
  assert.ok(requests.every(item => item.init.headers.get('If-Match') === history.etag &&
    item.init.headers.get('Idempotency-Key') === key && item.init.method === 'POST'))
  assert.deepEqual(requests.map(item => item.url.split('/').slice(-4).join('/')), [
    'summaries/candidate/comparison-1/publish', 'summaries/candidate/comparison-1/publish', 'summaries/candidate/comparison-1/retry',
    'summaries/candidate/comparison-1/restart',
  ])
  globalThis.fetch = async () => json({ summaries: summaryResponse(fixture) })
  await assert.rejects(client.retryRealAnalysisSummary(summaryWorkspaceId, summaryRunId, subject, history.etag, key, draft.targetId), /mismatched/)
  await assert.rejects(client.restartRealAnalysisSummary(summaryWorkspaceId, summaryRunId, subject, history.etag, key, draft.targetId), /mismatched/)
  globalThis.fetch = async () => json({ summaries: { ...summaries, workspaceId: 'foreign' } })
  await assert.rejects(client.publishRealAnalysisSummaryDraft(summaryWorkspaceId, summaryRunId, subject, input, history.etag, key, draft.targetId), /mismatched/)
})

test('historical summary pages cannot advertise resume or restart capabilities', async () => {
  const resultRevisionId = randomUUID()
  const subject = { kind: 'candidate', subjectId: 'comparison-1' }
  const history = { ...summaryHistoryFixture(fixture), resultRevisionId,
    capabilities: { canPublish: false, canRetry: false, canResume: false, canRestart: false } }
  globalThis.fetch = async () => json(history)
  await client.getRealAnalysisSummaryHistory(summaryWorkspaceId, summaryRunId, subject, undefined, undefined, resultRevisionId)
  for (const capability of ['canResume', 'canRestart']) {
    const invalid = structuredClone(history)
    invalid.capabilities[capability] = true
    globalThis.fetch = async () => json(invalid)
    await assert.rejects(
      client.getRealAnalysisSummaryHistory(summaryWorkspaceId, summaryRunId, subject, undefined, undefined, resultRevisionId),
      /private (?:summary )?history/,
    )
  }
})
