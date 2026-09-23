import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  correctionFixture, correctionPreview, correctionSummary, correctionHistory, correctionReason,
  correctionPolicy, correctionLegacyPolicy, correctionGapReview, correctionEvidence, reassessmentPolicy,
} from './analysisCorrections.synthetic.test-support.mjs'
import { summarySubjectResponse, summaryHistoryFixture } from './analysisSummaries.test-support.mjs'

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
      export { getRealAnalysisSummarySubject, getRealAnalysisSummaryHistory } from './src/services/realAnalyses'
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

test('historical summary reads bind the selected result revision and reject current or writable-history substitutions', async () => {
  const subject = { kind: 'candidate', subjectId: comparisonId }
  const selected = { ...summarySubjectResponse(fixture, subject, { candidateStatus: 'ready' }), resultRevisionId: 'original' }
  selected.narrative.resultSha256 = fixture.details[0].comparison.result.sha256
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return Response.json(selected, { headers: { ETag: selected.etag } })
  }
  const value = await client.getRealAnalysisSummarySubject(workspaceId, runId, subject, undefined, 'original')
  assert.equal(value.narrative.resultSha256, selected.narrative.resultSha256)
  assert.match(requests[0].url, /\/summaries\/candidate\/synthetic-comparison-1\?resultRevisionId=original$/)
  assert.equal(requests[0].init.method, 'GET')
  for (const mutate of [
    value => { delete value.resultRevisionId },
    value => { value.resultRevisionId = randomUUID() },
    value => { delete value.narrative.resultSha256 },
    value => { value.narrative.resultSha256 = 'invalid' },
  ]) {
    const invalid = structuredClone(selected)
    mutate(invalid)
    globalThis.fetch = async () => Response.json(invalid, { headers: { ETag: invalid.etag } })
    await assert.rejects(client.getRealAnalysisSummarySubject(workspaceId, runId, subject, undefined, 'original'))
  }
  const history = { ...summaryHistoryFixture(fixture, { subjectId: comparisonId }), resultRevisionId: 'original',
    capabilities: { canPublish: false, canRetry: false } }
  globalThis.fetch = async () => Response.json(history)
  assert.equal((await client.getRealAnalysisSummaryHistory(workspaceId, runId, subject, undefined, undefined, 'original')).entries.length, 6)
  await assert.rejects(client.getRealAnalysisSummaryHistory(workspaceId, runId, subject), /does not match/)
  globalThis.fetch = async () => Response.json({ ...history, capabilities: { canPublish: true, canRetry: false } })
  await assert.rejects(client.getRealAnalysisSummaryHistory(workspaceId, runId, subject, undefined, undefined, 'original'), /does not match/)
})

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

test('re-score previews bind eligibility to the withheld weighted criteria and the journal sends only the full-reassessment policy', async () => {
  const source = correctionPreview(fixture, comparisonId, { blocked: true, policyVersion: correctionPolicy })
  globalThis.fetch = async () => Response.json(source)
  const value = await client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId)
  assert.deepEqual(value.reassessment, { policyVersion: reassessmentPolicy, eligible: true, blockedReason: null, criterionIds: ['criterion-one'] })
  assert.equal(state.correctionActionAvailable(value, 'missing-evidence'), false)
  assert.equal(state.correctionActionAvailable(value, 'reassess'), true)
  assert.throws(() => new state.CorrectionRequestJournal().prepare(comparisonId, value, correctionReason), /fresh selectable preview/)
  const journal = new state.CorrectionRequestJournal()
  const saved = journal.prepare(comparisonId, value, `  ${state.reassessmentPolicyReason}  `, 'reassess')
  assert.deepEqual(saved.input, {
    policyVersion: reassessmentPolicy, resultSha256: value.resultSha256, criterionIds: ['criterion-one'], reason: state.reassessmentPolicyReason,
  })
  assert.equal(journal.prepare(comparisonId, value, 'A replay keeps the retained re-score input.', 'missing-evidence'), saved)
  assert.throws(() => journal.acknowledge(comparisonId, correctionSummary(fixture, comparisonId, {
    requestId: saved.key, reason: saved.input.reason, policyVersion: correctionPolicy,
  })), /retained request policy/)
  assert.equal(journal.get(comparisonId), saved)
  journal.acknowledge(comparisonId, correctionSummary(fixture, comparisonId, {
    requestId: saved.key, reason: saved.input.reason, policyVersion: reassessmentPolicy,
  }))
  assert.equal(journal.get(comparisonId), undefined)

  const numericId = fixture.details[1].comparison.id
  globalThis.fetch = async () => Response.json(correctionPreview(fixture, numericId))
  const numeric = await client.getAnalysisCorrectionPreview(workspaceId, runId, numericId)
  assert.equal(numeric.reassessment.eligible, false)
  assert.match(numeric.reassessment.blockedReason, /withheld/)
  assert.equal(state.correctionActionAvailable(numeric, 'reassess'), false)
  assert.throws(() => new state.CorrectionRequestJournal().prepare(numericId, numeric, state.reassessmentPolicyReason, 'reassess'), /fresh selectable preview/)

  for (const edit of [
    preview => { delete preview.reassessment },
    preview => { preview.reassessment.policyVersion = correctionPolicy },
    preview => { preview.reassessment.blockedReason = 'Eligible but blocked.' },
    preview => { preview.reassessment.criterionIds = [] },
    preview => { preview.reassessment.criterionIds = ['unrelated'] },
    preview => { preview.reassessment.criterionIds.push('criterion-one') },
    preview => { preview.reassessment.eligible = false },
    preview => { preview.reassessment = { ...preview.reassessment, eligible: false, blockedReason: 'Blocked.' } },
  ]) {
    const invalid = correctionPreview(fixture, comparisonId)
    edit(invalid)
    globalThis.fetch = async () => Response.json(invalid)
    await assert.rejects(client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId), /invalid|mismatched/)
  }
  const promoted = correctionPreview(fixture, numericId, { reassessment: {
    policyVersion: reassessmentPolicy, eligible: true, blockedReason: null, criterionIds: ['criterion-one'],
  } })
  globalThis.fetch = async () => Response.json(promoted)
  await assert.rejects(client.getAnalysisCorrectionPreview(workspaceId, runId, numericId), /invalid|mismatched/)
})

test('re-score history has no deterministic proposal until it publishes, and a published re-score must show its reviewed total', async () => {
  const failed = correctionHistory(fixture, comparisonId, { policyVersion: reassessmentPolicy })
  globalThis.fetch = async () => Response.json(failed)
  const page = await client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId)
  assert.equal(page.entries[0].policyVersion, reassessmentPolicy)
  assert.equal(page.entries[0].after, null)
  assert.equal(page.entries[0].review.scope, undefined)
  const published = correctionHistory(fixture, comparisonId, { status: 'ready', policyVersion: reassessmentPolicy })
  globalThis.fetch = async () => Response.json(published)
  assert.equal((await client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId)).entries[0].after.overall.score, 0)
  for (const [history, edit] of [
    [published, entry => { entry.after = null }],
    [failed, entry => { entry.after = structuredClone(published.entries[0].after) }],
    [failed, entry => { entry.policyVersion = correctionPolicy }],
    [correctionHistory(fixture, comparisonId, { policyVersion: correctionPolicy }), entry => { entry.after = null }],
    [correctionHistory(fixture, comparisonId), entry => { entry.after = null }],
    [failed, entry => { delete entry.policyVersion }],
  ]) {
    const invalid = structuredClone(history)
    edit(invalid.entries[0])
    globalThis.fetch = async () => Response.json(invalid)
    await assert.rejects(client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId), /invalid|mismatched/)
  }
})

test('both policy versions remain readable and unusable-source blockers never become selectable missing evidence', async () => {
  for (const policyVersion of [correctionLegacyPolicy, correctionPolicy]) {
    const preview = correctionPreview(fixture, comparisonId, { policyVersion })
    globalThis.fetch = async () => Response.json(preview)
    assert.equal((await client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId)).policyVersion, policyVersion)
    for (const status of ['queued', 'running', 'ready', 'failed', 'cancelled']) {
      const correction = correctionSummary(fixture, comparisonId, { status, policyVersion })
      globalThis.fetch = async () => Response.json({ correction })
      assert.deepEqual(await client.getAnalysisCorrection(workspaceId, runId, comparisonId), correction)
    }
  }
  for (const policyVersion of [undefined, 'missing-evidence-zero-v3']) {
    globalThis.fetch = async () => Response.json({ ...correctionPreview(fixture, comparisonId), policyVersion })
    await assert.rejects(client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId), /invalid preview/)
  }
  const blocked = correctionPreview(fixture, comparisonId, { blocked: true, policyVersion: correctionPolicy })
  blocked.criteria[0].limitation.code = 'not-assessable'
  blocked.criteria[0].limitation.blockerCode = 'ambiguous-guidance'
  globalThis.fetch = async () => Response.json(blocked)
  assert.equal((await client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId)).criteria[0].limitation.blockerCode, 'ambiguous-guidance')
  for (const blockerCode of ['unusable-source', 'unknown']) {
    const invalid = correctionPreview(fixture, comparisonId, { policyVersion: correctionPolicy })
    invalid.criteria[0].limitation.blockerCode = blockerCode
    globalThis.fetch = async () => Response.json(invalid)
    await assert.rejects(client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId), /invalid|mismatched/)
  }
})

test('v2 may independently verify a legacy row-level source-quality label, but v1 and hard source-processing blockers stay unselectable', async () => {
  for (const policyVersion of [correctionLegacyPolicy, correctionPolicy]) {
    for (const code of ['source-quality', 'context-limit']) {
      for (const blockerCode of [undefined, 'unusable-source', 'ambiguous-guidance']) {
        const preview = correctionPreview(fixture, comparisonId, { policyVersion })
        preview.criteria[0].limitation = { ...preview.criteria[0].limitation, code, ...(blockerCode ? { blockerCode } : {}) }
        globalThis.fetch = async () => Response.json(preview)
        if (policyVersion === correctionPolicy && code === 'source-quality' && blockerCode !== 'unusable-source') {
          const value = await client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId)
          assert.deepEqual(value.criteria[0], preview.criteria[0])
          assert.equal(value.criteria[0].eligible, true)
          assert.equal(value.after.overall.score, 0)
          assert.equal(value.before.overall.status, 'withheld')
          assert.equal(value.correction, null)
        } else {
          await assert.rejects(client.getAnalysisCorrectionPreview(workspaceId, runId, comparisonId), /mismatched preview/)
        }
      }
    }
  }
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

test('v2 requests bind the reviewed policy and reject policy-switched acknowledgements without altering their replay key', async () => {
  const journal = new state.CorrectionRequestJournal()
  const preview = correctionPreview(fixture, comparisonId, { policyVersion: correctionPolicy })
  const saved = journal.prepare(comparisonId, preview, correctionReason)
  const requests = []
  let acknowledgedPolicy = correctionLegacyPolicy
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return Response.json({ requestId: saved.key, correction: correctionSummary(fixture, comparisonId, {
      requestId: saved.key, policyVersion: acknowledgedPolicy,
    }) }, { status: 202 })
  }
  assert.equal(saved.input.policyVersion, correctionPolicy)
  assert.equal(journal.prepare(comparisonId, { ...preview, policyVersion: correctionLegacyPolicy }, 'Do not replace the retained input.'), saved)
  await assert.rejects(client.requestAnalysisCorrection(workspaceId, runId, comparisonId, saved.input, saved.etag, saved.key), /reviewed policy/)
  assert.equal(journal.get(comparisonId), saved)
  assert.throws(() => journal.acknowledge(comparisonId, correctionSummary(fixture, comparisonId, {
    requestId: saved.key, policyVersion: correctionLegacyPolicy,
  })), /retained request policy/)
  assert.equal(journal.get(comparisonId), saved)
  acknowledgedPolicy = correctionPolicy
  const response = await client.requestAnalysisCorrection(workspaceId, runId, comparisonId, saved.input, saved.etag, saved.key)
  journal.acknowledge(comparisonId, response.correction)
  assert.equal(journal.get(comparisonId), undefined)
  for (const { init } of requests) {
    assert.equal(init.headers.get('Idempotency-Key'), saved.key)
    assert.equal(init.headers.get('If-Match'), preview.etag)
    assert.deepEqual(JSON.parse(init.body), { policyVersion: correctionPolicy, resultSha256: preview.resultSha256,
      criterionIds: preview.criterionIds, reason: correctionReason })
  }
  await assert.rejects(client.requestAnalysisCorrection(workspaceId, runId, comparisonId,
    { ...saved.input, policyVersion: 'missing-evidence-zero-v3' }, saved.etag, saved.key), /Review the exact saved policy version/)
  assert.equal(requests.length, 2)
})

test('unversioned legacy requests replay without being silently upgraded by new previews or acknowledgements', async () => {
  const journal = new state.CorrectionRequestJournal()
  const preview = correctionPreview(fixture, comparisonId)
  const retained = journal.prepare(comparisonId, preview, correctionReason)
  delete retained.input.policyVersion
  assert.equal(journal.prepare(comparisonId, { ...preview, policyVersion: correctionPolicy }, 'New text cannot replace a legacy request.'), retained)
  let lastBody
  let policyVersion = correctionPolicy
  globalThis.fetch = async (_url, init) => {
    lastBody = JSON.parse(init.body)
    return Response.json({ requestId: retained.key, correction: correctionSummary(fixture, comparisonId, {
      requestId: retained.key, policyVersion,
    }) })
  }
  await assert.rejects(client.requestAnalysisCorrection(workspaceId, runId, comparisonId,
    retained.input, retained.etag, retained.key), /reviewed policy/)
  assert.equal(Object.hasOwn(lastBody, 'policyVersion'), false)
  assert.throws(() => journal.acknowledge(comparisonId, correctionSummary(fixture, comparisonId, {
    requestId: retained.key, policyVersion: correctionPolicy,
  })), /retained request policy/)
  policyVersion = correctionLegacyPolicy
  const legacy = await client.requestAnalysisCorrection(workspaceId, runId, comparisonId, retained.input, retained.etag, retained.key)
  journal.acknowledge(comparisonId, legacy.correction)
  assert.equal(journal.get(comparisonId), undefined)
  assert.equal(Object.hasOwn(lastBody, 'policyVersion'), false)
  assert.throws(() => journal.prepare(comparisonId, { ...preview, policyVersion: undefined }, correctionReason), /fresh selectable preview/)
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

test('scoped history preserves each selected decision, citations and genuine blocker while legacy whole-review history stays readable', async () => {
  const decisions = [
    { criterionId: 'criterion-one', outcome: 'evidence-found', message: 'A saved passage supports the selected requirement.', citations: [correctionEvidence] },
    ...['unusable-source', 'ambiguous-guidance', 'restricted-personal-characteristic'].map(blockerCode => ({
      criterionId: 'criterion-one', outcome: 'blocked', blockerCode, message: `The saved criterion is blocked by ${blockerCode}.`, citations: [],
    })),
  ]
  for (const decision of decisions) {
    const history = correctionHistory(fixture, comparisonId, { policyVersion: correctionPolicy, decisions: [decision] })
    history.originalAssessment.criteria[0].limitation.blockerCode = 'ambiguous-guidance'
    globalThis.fetch = async () => Response.json(history)
    const value = await client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId)
    assert.deepEqual(value.entries[0].review.scope.decisions, [decision])
    assert.deepEqual(value.entries[0].review.issues, correctionGapReview([decision]).issues)
    assert.equal(value.originalAssessment.criteria[0].limitation.blockerCode, 'ambiguous-guidance')
    assert.equal(value.entries[0].resultSha256, null)
  }
  for (const policyVersion of [undefined, correctionLegacyPolicy, correctionPolicy]) {
    const published = correctionHistory(fixture, comparisonId, { status: 'ready', policyVersion })
    globalThis.fetch = async () => Response.json(published)
    const saved = await client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId)
    assert.equal(saved.entries[0].outcome, 'ready')
    assert.equal(Boolean(saved.entries[0].review.scope), policyVersion === correctionPolicy)
  }
})

test('scoped history rejects missing fields, duplicate or foreign decisions, unsupported zeros and inconsistent issue summaries', async () => {
  const found = { criterionId: 'criterion-one', outcome: 'evidence-found', message: 'Supporting professional evidence exists.', citations: [correctionEvidence] }
  const blocked = { criterionId: 'criterion-one', outcome: 'blocked', blockerCode: 'ambiguous-guidance', message: 'The saved requirement has contradictory guidance.', citations: [] }
  const edits = [
    value => { delete value.entries[0].review.scope },
    value => { delete value.correction.policyVersion; delete value.entries[0].review.scope },
    value => { value.entries[0].review.scope.kind = 'full-assessment' },
    value => { delete value.entries[0].review.scope.baseAssessmentSha256 },
    value => { value.entries[0].review.scope.baseAssessmentSha256 = 'not-a-hash' },
    value => { value.entries[0].review.scope.criterionIds = [] },
    value => { value.entries[0].review.scope.criterionIds.push('criterion-one') },
    value => { value.entries[0].review.scope.criterionIds = ['foreign-criterion'] },
    value => { value.entries[0].review.scope.decisions = [] },
    value => { value.entries[0].review.scope.decisions.push(value.entries[0].review.scope.decisions[0]) },
    value => { value.entries[0].review.scope.decisions[0].criterionId = 'foreign-criterion' },
    value => { delete value.entries[0].review.scope.decisions[0].outcome },
    value => { delete value.entries[0].review.scope.decisions[0].message },
    value => { delete value.entries[0].review.scope.decisions[0].citations },
    value => { value.entries[0].review.scope.decisions[0].citations = [correctionEvidence] },
    value => { value.entries[0].review.scope.decisions[0].blockerCode = 'ambiguous-guidance' },
    value => { value.entries[0].review.outcome = 'unsupported' },
    value => { value.entries[0].review = correctionGapReview([found]) },
    value => { value.entries[0].review = correctionGapReview([blocked]) },
  ]
  for (const edit of edits) {
    const invalid = correctionHistory(fixture, comparisonId, { status: 'ready', policyVersion: correctionPolicy })
    edit(invalid)
    globalThis.fetch = async () => Response.json(invalid)
    await assert.rejects(client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId), /history|publication/)
  }
  for (const edit of [
    review => { review.scope.decisions[0].citations = [] },
    review => { review.outcome = 'supported' },
    review => { review.issues = [] },
    review => { review.issues[0].criterionId = 'unchanged-numeric-criterion' },
    review => { review.issues[0].message = 'A different unsupported reason.' },
    review => { review.issues[0].citations = [] },
    review => { review.issues.push(review.issues[0]) },
    review => { review.scope.decisions[0] = { ...blocked, blockerCode: 'unknown' } },
    review => { review.scope.decisions[0] = { ...blocked, blockerCode: undefined } },
    review => {
      review.scope.criterionIds = ['unselected-criterion']
      review.scope.decisions[0].criterionId = 'unselected-criterion'
      review.issues[0].criterionId = 'unselected-criterion'
    },
  ]) {
    const invalid = correctionHistory(fixture, comparisonId, { policyVersion: correctionPolicy, decisions: [found] })
    edit(invalid.entries[0].review)
    globalThis.fetch = async () => Response.json(invalid)
    await assert.rejects(client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId), /history|publication/)
  }
})

test('multi-criterion scope must cover the exact selection once, irrespective of decision order', async () => {
  const history = correctionHistory(fixture, comparisonId, { policyVersion: correctionPolicy })
  const original = history.originalAssessment.criteria[0]
  original.weight = 40
  history.originalAssessment.criteria.push({
    ...structuredClone(original), criterionId: 'criterion-two', weight: 60,
    limitation: { ...original.limitation, criterionId: 'criterion-two' },
  })
  history.original.coverage.totalCriteria = 2
  history.original.coverage.notAssessed = 2
  history.correction.criterionIds = ['criterion-one', 'criterion-two']
  const entry = history.entries[0]
  entry.criterionIds = ['criterion-one', 'criterion-two']
  entry.after.coverage.totalCriteria = 2
  entry.after.coverage.missing = 2
  entry.review = correctionGapReview([
    { criterionId: 'criterion-two', outcome: 'blocked', blockerCode: 'ambiguous-guidance',
      message: 'The second selected requirement has conflicting saved guidance.', citations: [] },
    { criterionId: 'criterion-one', outcome: 'confirmed-missing', message: 'No supporting evidence exists for the first selected criterion.', citations: [] },
  ])
  entry.review.scope.criterionIds.reverse()
  globalThis.fetch = async () => Response.json(history)
  assert.deepEqual((await client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId)).entries[0].review, entry.review)
  for (const edit of [
    value => { value.entries[0].review.scope.decisions.pop() },
    value => { value.entries[0].review.scope.decisions.push(value.entries[0].review.scope.decisions[0]) },
    value => {
      value.entries[0].review.scope.decisions[1].criterionId = 'criterion-two'
    },
    value => {
      value.entries[0].review.scope.criterionIds = ['criterion-one']
      value.entries[0].review = correctionGapReview([value.entries[0].review.scope.decisions[1]])
    },
  ]) {
    const invalid = structuredClone(history)
    edit(invalid)
    globalThis.fetch = async () => Response.json(invalid)
    await assert.rejects(client.getAnalysisCorrectionHistory(workspaceId, runId, comparisonId), /history|publication/)
  }
})

test('failure selection uses only the latest checkpoint of the exact failed request and never substitutes unrelated history', () => {
  const history = correctionHistory(fixture, comparisonId, { policyVersion: correctionPolicy })
  const latest = history.entries[0]
  const older = { ...structuredClone(latest), id: randomUUID(), createdAt: '2026-09-19T14:00:00.000Z' }
  older.review = correctionGapReview([{ criterionId: 'criterion-one', outcome: 'evidence-found',
    message: 'An older checkpoint must not replace the latest blocker.', citations: [correctionEvidence] }])
  const unrelated = { ...structuredClone(latest), id: randomUUID(), requestId: randomUUID(), createdAt: '2026-09-19T16:00:00.000Z' }
  history.entries = [older, unrelated, latest]
  assert.equal(state.latestCorrectionFailure(history, history.correction), latest)
  assert.equal(state.latestCorrectionFailure({ ...history, entries: [unrelated] }, history.correction), null)
  for (const edit of [
    value => { value.correction.requestId = randomUUID() },
    value => { value.correction.status = 'running' },
    value => { value.workspaceId = 'foreign' },
    value => { value.entries[2].reason = 'This belongs to a different retained reason.' },
    value => { value.entries[2].criterionIds = ['foreign-criterion'] },
    value => { value.entries[2].outcome = 'ready' },
  ]) {
    const invalid = structuredClone(history)
    edit(invalid)
    assert.throws(() => state.latestCorrectionFailure(invalid, history.correction), /request|criteria/)
  }
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
  assert.equal(first.input.policyVersion, correctionLegacyPolicy)
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
