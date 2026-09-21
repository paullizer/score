import assert from 'node:assert/strict'
import test from 'node:test'
import { candidateFixture, targetFixture, mockModel, supportedReview, refreshCandidate, deterministic, NOW } from './narrative-model-test-support.mjs'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsSnapshot } from './runtime-settings-test-support.mjs'

const { generateCandidateSummary, generateTargetSummary } = await loadWorker('../worker/analyses/summary-model.ts')
const { emitSummaryTelemetry } = await loadWorker('../worker/analyses/summary-telemetry.ts')
const { summaryTargetContentSchema, summaryDraftSchema } = await loadWorker('../src/domain/analysis-summary-history.ts')

test('candidate, target, reduction and mandatory summary review use four independent captured tasks', async () => {
  const snapshot = settingsSnapshot()
  const candidate = mockModel([draft(), supportedReview()])
  candidate.model.processingSettings = snapshot
  const candidateResult = await generateCandidateSummary(candidateFixture(), candidate.options)
  assert.deepEqual(candidate.calls.map(call => call.request.model), ['deployment-candidateSummary', 'deployment-summaryReview'])
  assert.equal(candidateResult.provenance.generation.task, 'candidateSummary')
  assert.equal(candidateResult.provenance.groundingReviews[0].provenance.task, 'summaryReview')
  assert.equal(candidateResult.provenance.generation.settingsRevision, snapshot.revision)
  assert.equal(candidateResult.provenance.groundingReviews[0].provenance.settingsRevision, snapshot.revision)
  const target = mockModel(({ kind }) => kind === 'analysis_narrative_grounding_review'
    ? supportedReview() : { paragraphs: ['The captured analyses document calibration work with incomplete telemetry evidence.'] })
  target.model.processingSettings = snapshot
  const targetHistory = capture(target)
  const targetResult = await generateTargetSummary(targetFixture(120, { grade: true }), targetHistory.options)
  assert.equal(targetResult.provenance.generation.task, 'targetSummary')
  assert.equal(targetResult.provenance.generation.settingsRevision, snapshot.revision)
  const reductions = targetHistory.steps.filter(step => step.scopeId !== 'final' && step.phase === 'generated')
  assert.ok(reductions.length > 0)
  assert.ok(reductions.every(step => step.generation.task === 'summaryReduction' && step.generation.settingsRevision === snapshot.revision))
  assert.ok(target.calls.some(call => call.request.model === 'deployment-summaryReduction'))
  assert.ok(target.calls.some(call => call.request.model === 'deployment-targetSummary'))
  assert.ok(target.calls.some(call => call.request.model === 'deployment-summaryReview'))
  assert.ok(target.calls.every(call => snapshot.tasks[
    call.kind === 'analysis_narrative_grounding_review' ? 'summaryReview'
      : call.kind === 'analysis_narrative_synthesis' ? 'summaryReduction' : 'targetSummary'
  ].completionTokenLimit === call.request.max_completion_tokens))
})

test('a captured one-round summary budget remains consumed after a durable retry', async () => {
  const snapshot = settingsSnapshot(settings => { settings.summaries.maxRounds = 1 })
  const first = mockModel([draft(), finding()])
  first.model.processingSettings = snapshot
  const history = capture(first)
  await assert.rejects(generateCandidateSummary(candidateFixture(), history.options), error => error.code === 'grounding-failed')
  assert.equal(first.calls.length, 2)
  const retry = mockModel([])
  retry.model.processingSettings = snapshot
  await assert.rejects(generateCandidateSummary(candidateFixture(), { ...retry.options, steps: history.steps.toReversed() }),
    error => error.code === 'grounding-failed')
  assert.equal(retry.calls.length, 0)
})

test('all summary generation and grounding calls share the captured operation deadline', async () => {
  let time = Date.parse(NOW)
  const mock = mockModel(() => { time += 2000; return draft() })
  mock.clock.now = () => new Date(time)
  mock.model.processingSettings = settingsSnapshot(settings => {
    settings.summaries.operationTimeoutMilliseconds = 1000
    settings.ai.requestTimeoutMilliseconds = 1000
  })
  await assert.rejects(generateCandidateSummary(candidateFixture(), mock.options), error => error.code === 'timeout')
  assert.equal(mock.calls.length, 1)
})
const draft = (suffix = '') => ({
  text: `The analysis documents calibration work, with telemetry scope remaining partial. ${suffix}`.trim(),
  overview: 'Calibration work is documented; other evidence remains limited.',
})
const finding = (message = 'Independent telemetry delivery is not established by the saved analysis.') => ({
  outcome: 'needs-correction',
  issues: [{ code: 'unsupported-claim', message, field: 'text', paragraphIndex: null }],
})
function capture(mock, steps = []) {
  const events = []
  return {
    steps, events,
    options: {
      ...mock.options,
      onCheckpoint: async step => { steps.push(structuredClone(step)) },
      onEvent: event => events.push(structuredClone(event)),
    },
  }
}

test('v2 summarizes the saved analysis without rigid sentence, number, score-word or coverage gates', async () => {
  const input = candidateFixture()
  input.result.criteria[0].rationale += ' A Ph.D. project measured 1,000 locations at 12.0 points on rated 480-volt equipment.'
  refreshCandidate(input)
  const before = structuredClone(input)
  const output = {
    text: 'The Ph.D. project measured 1000 locations at 12 points on rated 480-volt equipment.',
    overview: 'Documented calibration work. Telemetry scope remains partial.',
  }
  const mock = mockModel([output, supportedReview()])
  const history = capture(mock)
  const result = await generateCandidateSummary(input, history.options)
  assert.deepEqual(result.output, { ...output, claims: [] })
  assert.deepEqual(input, before)
  assert.equal(mock.calls.length, 2)
  const source = mock.calls[0].body.source
  assert.equal(source.analysis.criteria.length, input.result.criteria.length)
  assert.equal(source.analysis.criteria[0].score, input.result.criteria[0].score)
  assert.equal(source.resume, undefined)
  assert.equal(source.frozen, undefined)
  assert.equal(source.requiredReferenceIds, undefined)
  assert.deepEqual(mock.calls[1].body.source, source)
  assert.equal(mock.calls[1].body.outputSha256, deterministic.analysisHash({ kind: 'candidate', ...output }))
  assert.deepEqual(history.steps.map(step => step.phase), ['started', 'generated', 'reviewed'])
  assert.equal(result.provenance.correctionCount, 0)
  assert.equal(result.provenance.generation.schemaVersion, 'analysis-summary-v2')
})

test('accepted text can exceed previous prose guidance without being clipped', async () => {
  const output = { text: 'Documented calibration work remains relevant. '.repeat(25).trim(), overview: 'Saved evidence remains limited. '.repeat(10).trim() }
  const mock = mockModel([output, supportedReview()])
  const result = await generateCandidateSummary(candidateFixture(), mock.options)
  assert.ok(output.text.length > 900)
  assert.ok(output.overview.length > 220)
  assert.equal(result.output.text, output.text)
  assert.equal(result.output.overview, output.overview)
})

test('shared target and reduction readers enforce the exact total technical bound, including paragraph breaks', () => {
  const paragraphs = [...Array.from({ length: 6 }, () => 'x'.repeat(16_000)), 'x'.repeat(3_988)]
  assert.equal(paragraphs.join('\n\n').length, 100_000)
  assert.equal(summaryTargetContentSchema.safeParse({ paragraphs }).success, true)
  for (const kind of ['target', 'reduction']) {
    assert.equal(summaryDraftSchema.safeParse({ kind, paragraphs }).success, true)
    assert.equal(summaryDraftSchema.safeParse({ kind, paragraphs: [...paragraphs.slice(0, -1), `${paragraphs.at(-1)}x`] }).success, false)
  }
  paragraphs[6] += 'x'
  assert.equal(summaryTargetContentSchema.safeParse({ paragraphs }).success, false)
})

test('three rounds carry the prior draft and all earlier factual findings forward', async () => {
  const first = draft('The first draft overstates independence.')
  const second = draft('The second draft changes the measurement.')
  const third = draft()
  const firstReview = finding()
  const secondReview = finding('The measurement must retain the saved 12 percent result.')
  const mock = mockModel([first, firstReview, second, secondReview, third, supportedReview()])
  const history = capture(mock)
  const result = await generateCandidateSummary(candidateFixture(), history.options)
  assert.equal(mock.calls.length, 6)
  assert.deepEqual(mock.calls[2].body.feedback.previousDraft, { kind: 'candidate', ...first })
  assert.deepEqual(mock.calls[2].body.feedback.earlierFindings, firstReview.issues)
  assert.deepEqual(mock.calls[4].body.feedback.previousDraft, { kind: 'candidate', ...second })
  assert.deepEqual(mock.calls[4].body.feedback.earlierFindings, [...firstReview.issues, ...secondReview.issues])
  assert.equal(result.provenance.correctionCount, 2)
  assert.equal(result.provenance.groundingReviews.length, 3)
  assert.deepEqual(history.steps.filter(step => step.phase === 'reviewed').map(step => step.round), [1, 2, 3])
  assert.ok(mock.calls.every(call => !call.kind.startsWith('resume_')))
})

test('persistent factual disagreement stops at three final drafts with complete private history', async () => {
  const mock = mockModel([draft('First.'), finding(), draft('Second.'), finding(), draft('Third.'), finding()])
  const history = capture(mock)
  await assert.rejects(generateCandidateSummary(candidateFixture(), history.options),
    error => error.code === 'grounding-failed' && error.diagnostic.round === 3)
  assert.equal(mock.calls.length, 6)
  const reviewed = history.steps.filter(step => step.phase === 'reviewed')
  assert.equal(reviewed.length, 3)
  assert.equal(new Set(reviewed.map(step => step.outputSha256)).size, 3)
  assert.ok(reviewed.every(step => step.draft.text && step.review.issues.length))
  assert.equal(history.events.filter(event => event.event === 'summary-reviewed').length, 3)
  assert.doesNotMatch(JSON.stringify(history.events), /First\.|Second\.|Third\.|Independent telemetry|test-token/)
})

test('restart after a persisted draft resumes its review without generating another draft', async () => {
  const interrupted = mockModel([draft()])
  const saved = []
  await assert.rejects(generateCandidateSummary(candidateFixture(), {
    ...interrupted.options,
    onCheckpoint: async step => {
      saved.push(structuredClone(step))
      if (step.phase === 'generated') throw new Error('simulated process interruption after persistence')
    },
  }), /simulated process interruption/)
  const resumed = mockModel([supportedReview()])
  const history = capture(resumed)
  const result = await generateCandidateSummary(candidateFixture(), {
    ...history.options, steps: saved.toReversed(),
  })
  assert.deepEqual(resumed.calls.map(call => call.kind), ['analysis_narrative_grounding_review'])
  assert.equal(result.provenance.correctionCount, 0)
  assert.equal(result.provenance.generation.model, saved.find(step => step.phase === 'generated').generation.model)
})

test('restart after an unsupported review advances to round two and does not reset the budget', async () => {
  const saved = []
  const first = mockModel([draft('Earlier incorrect detail.'), finding()])
  await assert.rejects(generateCandidateSummary(candidateFixture(), {
    ...first.options, onCheckpoint: async step => {
      saved.push(structuredClone(step))
      if (step.phase === 'reviewed') throw new Error('stopped after saved review')
    },
  }), /stopped after saved review/)
  const resumed = mockModel([draft('Second.'), finding(), draft('Third.'), finding()])
  const history = capture(resumed)
  await assert.rejects(generateCandidateSummary(candidateFixture(), {
    ...history.options, steps: saved.toReversed(),
  }), error => error.code === 'grounding-failed')
  assert.equal(resumed.calls.length, 4)
  assert.equal(resumed.calls[0].body.feedback.earlierFindings.length, 1)
  assert.deepEqual(history.steps.filter(step => step.phase === 'generated').map(step => step.round), [2, 3])
})

test('explicit retry receives earlier findings without consuming its new three-round budget', async () => {
  const first = mockModel([draft(), finding(), draft(), finding(), draft(), finding()])
  const saved = capture(first)
  await assert.rejects(generateCandidateSummary(candidateFixture(), saved.options))
  const retry = mockModel([draft('Corrected from earlier feedback.'), supportedReview()])
  const result = await generateCandidateSummary(candidateFixture(), { ...retry.options, seed: saved.steps.at(-1) })
  assert.equal(result.provenance.correctionCount, 0)
  assert.equal(retry.calls[0].body.feedback.earlierFindings.length, 1)
  assert.deepEqual(retry.calls[0].body.feedback.previousDraft, saved.steps.at(-1).draft)
})

test('malformed generations use at most three slots and never become invented successful summaries', async () => {
  const mock = mockModel(['{bad PRIVATE-RESPONSE', {}, { text: '', overview: '' }])
  const history = capture(mock)
  await assert.rejects(generateCandidateSummary(candidateFixture(), history.options), error => error.code === 'invalid-model-output')
  assert.equal(mock.calls.length, 3)
  assert.equal(history.steps.filter(step => step.phase === 'failed').length, 3)
  assert.ok(history.steps.every(step => !step.draft))
  assert.equal(mock.calls[1].body.feedback.technicalFeedback.code, 'invalid-model-output')
  assert.equal(mock.calls[2].body.feedback.technicalFeedback.code, 'invalid-model-output')
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE-RESPONSE/)
})

test('malformed review repair reviews the same exact draft without resetting generation rounds', async () => {
  const mock = mockModel([draft(), { outcome: 'supported', issues: finding().issues }, supportedReview()])
  const history = capture(mock)
  const result = await generateCandidateSummary(candidateFixture(), history.options)
  assert.equal(mock.calls.length, 3)
  assert.equal(mock.calls.filter(call => call.kind === 'analysis_candidate_narrative').length, 1)
  assert.equal(mock.calls[1].body.outputSha256, mock.calls[2].body.outputSha256)
  assert.equal(result.provenance.correctionCount, 0)
})

test('target generation includes the entire cohort but does not treat manually approved prose as evidence', async () => {
  const input = targetFixture(120, { grade: true, lateGap: true, terminal: ['failed'] })
  for (const candidate of input.candidates) {
    candidate.narrative.summaryVersion = 2
    candidate.narrative.approval = {
      kind: 'manual', approvedAt: NOW, approvedBy: 'workspace-owner',
      reviewOutcome: 'needs-correction', issues: finding().issues,
    }
    candidate.narrative.text = 'PRIVATE-PRIOR-NARRATIVE A manually edited interpretation is not an assessment fact.'
    candidate.narrative.overview = 'PRIVATE-PRIOR-NARRATIVE'
  }
  const seen = new Set()
  const mock = mockModel(({ kind, body }) => {
    assert.doesNotMatch(JSON.stringify(body.source), /PRIVATE-PRIOR-NARRATIVE/)
    for (const unit of body.source.records) for (const id of unit.members) seen.add(id)
    return kind === 'analysis_narrative_grounding_review' ? supportedReview()
      : { paragraphs: ['The saved analyses document calibration work with differing evidence limitations.'] }
  })
  const history = capture(mock)
  const result = await generateTargetSummary(input, history.options)
  assert.equal(seen.size, input.binding.comparisons.length)
  assert.ok(mock.calls.some(call => call.kind === 'analysis_narrative_synthesis'))
  assert.ok(history.steps.some(step => step.scopeId.startsWith('reduction-') && step.phase === 'reviewed'))
  assert.deepEqual(result.output.claims, [])
  assert.ok(mock.calls.every(call => call.bytes <= 288_000))
})

test('transport telemetry distinguishes throttling from factual review without private payloads', async () => {
  const mock = mockModel([new Response('PRIVATE-UPSTREAM', { status: 429 }), draft('PRIVATE-DRAFT'), supportedReview()])
  const history = capture(mock)
  await generateCandidateSummary(candidateFixture(), history.options)
  const responses = history.events.filter(event => event.event === 'model-response')
  assert.deepEqual(responses.map(event => event.httpStatus), [429, 200, 200])
  assert.equal(responses[0].modelCallId, responses[1].modelCallId)
  assert.ok(responses.every(event => event.round === 1 && event.requestBytes > 0))
  assert.doesNotMatch(JSON.stringify(history.events), /PRIVATE|test-token|originalResume|rationale|"quote":|"text":/)
})

test('truncated completion records its technical limit and call identity without publishing partial text', async () => {
  const mock = mockModel([Response.json({
    model: 'actual-summary-model',
    choices: [{ finish_reason: 'length', message: { content: JSON.stringify(draft('PRIVATE-PARTIAL')) } }],
  })])
  const history = capture(mock)
  await assert.rejects(generateCandidateSummary(candidateFixture(), history.options), error => {
    assert.equal(error.code, 'context-limit')
    assert.equal(error.diagnostic.round, 1)
    assert.ok(error.diagnostic.modelCallId)
    return true
  })
  assert.equal(mock.calls.length, 1)
  const response = history.events.find(event => event.event === 'model-response')
  assert.equal(response.finishReason, 'length')
  assert.equal(response.httpStatus, 200)
  assert.ok(response.modelCallId)
  assert.equal(history.steps.at(-1).phase, 'failed')
  assert.equal(history.steps.at(-1).draft, undefined)
  assert.doesNotMatch(JSON.stringify(history.events), /PRIVATE-PARTIAL|test-token/)
})

test('summary telemetry allowlists nested data and failure of a sink never masks processing', t => {
  const events = [], errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args))
  const value = {
    event: 'summary-reviewed', timestamp: new Date().toISOString(), stage: 'grounding', round: 1,
    reviewOutcome: 'needs-correction', reviewIssueCount: 1, issueCodes: ['unsupported-claim', 'PRIVATE-CODE'],
    draft: 'PRIVATE-DRAFT', issues: [{ message: 'PRIVATE-REVIEW' }], source: { text: 'PRIVATE-SOURCE' },
    authorization: 'PRIVATE-TOKEN',
  }
  emitSummaryTelemetry(event => events.push(event), value)
  assert.deepEqual(events[0].issueCodes, ['unsupported-claim'])
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/)
  emitSummaryTelemetry(() => { throw new Error('PRIVATE-SINK') }, value)
  assert.equal(errors.length, 1)
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE/)
})
