import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const {
  executeFixedJudgeEvaluation, validateFixedJudgeEvaluation, FIXED_JUDGE_VERSION,
  prepareResumeJobEvaluation, createEvaluationSettings, evaluationHash, executeFixedJudgeSuite,
  validateFixedJudgeProposals, validateFixedJudgeObservations, scoringSuiteSchema,
  summarizeFixedJudgeSuite,
} = await loadWorker('../worker/evals/index.ts')
const { validateAnalysisAssessmentSelections, hashAnalysisAssessment } = await loadWorker('../worker/analyses/model.ts')
const { createAnalysisEvidenceCatalog } = await loadWorker('../worker/analyses/evidence-passages.ts')

function fixture() {
  const input = prepareResumeJobEvaluation('Applied regression to survey data and documented uncertainty estimates.', 'family-one', {
    id: 'rubric-one', groupId: 'rubric-one', jobId: 'job-one', kind: 'job', dataKind: 'real',
    name: 'Statistical work', description: 'Applied statistical analysis.', version: 1, createdAt: '2026-10-07T00:00:00Z',
    criteria: [{
      id: 'statistics', key: 'custom', label: 'Statistics', description: 'Applied statistical analysis.',
      weight: 100, requirementType: 'required',
      guidance: '0: No document evidence. 1: Coursework. 2: One applied example. 3: Sustained work. 4: Led a team. 5: Led multiple programs.',
      sourceCitations: [{ documentId: 'job-source', documentVersion: 1, paragraphId: 'job-p1', page: 1, heading: 'Work', quote: 'Applied statistical analysis.' }],
    }],
  })
  const assessment = validateAnalysisAssessmentSelections({
    criteria: [{
      criterionId: 'statistics', evidenceStatus: 'supported', score: 2, limitation: null,
      rationale: 'The document describes one applied regression example with uncertainty estimates.', citations: [{ passageId: 1 }],
    }], qualifications: [],
  }, input, createAnalysisEvidenceCatalog(input.resume))
  const binding = { deploymentName: 'test-mini', modelName: 'gpt-5-mini', modelVersion: '2025-08-07', reasoningEffort: 'low' }
  const snapshot = createEvaluationSettings({
    revision: 'fixture-v1', capturedAt: '2026-10-07T00:00:00Z', assessor: binding, reviewer: binding,
  })
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'fixed-judge', purpose: 'smoke', sourceVersion: 'fixture-v1', repetitions: 2,
    configurations: [{ id: 'mini-low', algorithmVersion: FIXED_JUDGE_VERSION, settingsSha256: evaluationHash(snapshot) }],
    cases: [{
      id: 'valid-proposal', familyId: 'family-one', jobId: 'job-one', split: 'development',
      inputSha256: evaluationHash(input), criterionIds: ['statistics'],
    }],
  })
  const proposal = { id: 'valid-proposal', assessment, assessmentSha256: hashAnalysisAssessment(assessment) }
  return {
    suite, proposal, input, snapshot,
    prices: { 'test-mini': { version: 'fixture-prices', currency: 'USD', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 } },
    job: { suiteSha256: evaluationHash(suite), case: suite.cases[0], configuration: suite.configurations[0], repetition: 1 },
  }
}

function mock(data, outputs) {
  const requests = [], attempts = [], reviews = []
  let admitted = 0
  return {
    requests, attempts, reviews, admitted: () => admitted,
    options: {
      input: data.input, ...data.proposal, processingSettings: data.snapshot, prices: data.prices,
      model: {
        endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini',
        getToken: async () => 'test-token',
        fetch: async (_url, init) => {
          requests.push(JSON.parse(init.body))
          const output = outputs.shift()
          assert.ok(output, 'No scoring or repeat-until-supported inference is allowed.')
          return Response.json({
            model: 'gpt-5-mini-2025-08-07',
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
          })
        },
      },
      admitPaidWork: async () => { admitted++ },
      recordAttempt: async (attempt, amount) => { attempts.push({ attempt, amount }) },
      recordPrivateReview: async result => { reviews.push(result) },
    },
  }
}

test('fixed judge reviews one immutable proposal with no scorer, reference truth or automatic score correction', async () => {
  const data = fixture()
  const rejected = {
    outcome: 'needs-correction', issues: [{
      code: 'unsupported-score', criterionId: 'statistics', qualificationId: null,
      message: 'The cited source does not establish the claimed anchor.', citations: [{ passageId: 1 }],
    }],
  }
  const model = mock(data, [rejected])
  const before = structuredClone(data.proposal)
  const result = await executeFixedJudgeEvaluation(data.job, model.options)
  assert.equal(result.status, 'complete')
  assert.equal(result.issueFound, true)
  assert.equal(result.outcome, 'needs-correction')
  assert.equal(model.requests.length, 1)
  assert.equal(model.admitted(), 1)
  assert.equal(model.attempts[0].attempt.taskId, 'assessmentReview')
  assert.equal(model.attempts[0].amount, 200)
  assert.equal(model.reviews[0].review.assessmentSha256, data.proposal.assessmentSha256)
  assert.deepEqual(data.proposal, before)
  assert.equal('overall' in result, false)
  assert.equal('criteria' in result, false)
  assert.doesNotMatch(JSON.stringify(model.requests), /expectedIssue|labelOrigin|human-reviewed/)
  assert.match(JSON.stringify(model.requests), /Applied regression to survey data/)
})

test('stale proposal hashes, citations, weights and algorithms fail before paid admission', () => {
  const data = fixture(), model = mock(data, [])
  assert.throws(() => validateFixedJudgeEvaluation(data.job, { ...model.options, assessmentSha256: 'a'.repeat(64) }), /frozen assessment/)
  assert.throws(() => validateFixedJudgeEvaluation({
    ...data.job, configuration: { ...data.job.configuration, algorithmVersion: 'score-production-v1' },
  }, model.options), /impersonate/)
  const altered = structuredClone(data.proposal.assessment)
  altered.criteria[0].weight = 90
  assert.throws(() => validateFixedJudgeEvaluation(data.job, { ...model.options, assessment: altered }), /identities, weights/)
  altered.criteria[0].weight = 100
  altered.criteria[0].citations[0].quote = 'Fabricated passage.'
  assert.throws(() => validateFixedJudgeEvaluation(data.job, { ...model.options, assessment: altered }), /foreign resume evidence/)
  assert.equal(model.admitted(), 0)
  assert.equal(model.requests.length, 0)
})

test('truncated fixed-review responses stay indeterminate and retain billable attempts, never approvals', async () => {
  const data = fixture(), model = mock(data, [])
  let calls = 0
  const failures = []
  model.options.recordPrivateFailure = async failure => { failures.push(failure) }
  model.options.model.fetch = async () => {
    calls++
    return Response.json({
      model: 'gpt-5-mini-2025-08-07', choices: [{ finish_reason: 'length', message: { content: '{}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
    })
  }
  const result = await executeFixedJudgeEvaluation(data.job, model.options)
  assert.equal(result.status, 'failed')
  assert.equal(typeof result.code, 'string')
  assert.equal('issueFound' in result, false)
  assert.equal(calls, 1)
  assert.equal(model.reviews.length, 0)
  assert.equal(model.attempts.length, 1)
  assert.equal(model.attempts[0].amount, 200)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].code, 'context-limit')
  assert.equal(failures[0].reason, 'completion-token-limit')
  assert.equal(failures[0].stage, 'grounding')
  assert.equal('message' in failures[0], false)
  model.options.recordPrivateFailure = async () => { throw new Error('Failure storage unavailable') }
  await assert.rejects(executeFixedJudgeEvaluation(data.job, model.options), /Failure storage unavailable/)
})

test('fixed judge retains ledger and private review failures, and rejects late completion without buying again', async () => {
  const data = fixture()
  for (const kind of ['ledger', 'review', 'cancel']) {
    const model = mock(data, [{ outcome: 'supported', issues: [] }])
    const controller = new AbortController()
    if (kind === 'ledger') model.options.recordAttempt = async () => { throw new Error('Ledger unavailable') }
    if (kind === 'review') model.options.recordPrivateReview = async () => { throw new Error('Private review unavailable') }
    if (kind === 'cancel') model.options.recordPrivateReview = async () => controller.abort(new Error('Cancelled during publication'))
    await assert.rejects(executeFixedJudgeEvaluation(data.job, model.options, controller.signal), /unavailable|Cancelled/)
    assert.equal(model.requests.length, 1)
  }
})

test('fixed judge executor checkpoints verdicts rather than scores and validates exact proposal-bound resumes', async () => {
  const data = fixture()
  const observations = []
  const output = await executeFixedJudgeSuite(data.suite, {
    proposals: [data.proposal], concurrency: 1,
    execute: async () => ({
      status: 'complete', issueFound: false, outcome: 'supported', assessmentSha256: data.proposal.assessmentSha256,
    }),
    checkpoint: async row => { observations.push(row) },
  })

  assert.equal(output.length, 2)
  assert.equal(observations[0].assessmentSha256, data.proposal.assessmentSha256)
  const resumed = await executeFixedJudgeSuite(data.suite, {
    proposals: [data.proposal], concurrency: 1, priorObservations: output,
    execute: async () => assert.fail('Exact resume must not buy another review.'), checkpoint: async () => assert.fail(),
  })
  assert.deepEqual(resumed, output)
  const proposals = validateFixedJudgeProposals(data.suite, [data.proposal])
  assert.throws(() => validateFixedJudgeProposals(data.suite, []))
  assert.throws(() => validateFixedJudgeObservations(data.suite, proposals, [output[0], output[0]]), /Duplicate/)
  const altered = structuredClone(output[0])
  altered.result.issueFound = true
  assert.throws(() => validateFixedJudgeObservations(data.suite, proposals, [altered]), /verdict/)
  altered.result.issueFound = false
  altered.assessmentSha256 = 'b'.repeat(64)
  assert.throws(() => validateFixedJudgeObservations(data.suite, proposals, [altered]), /frozen suite/)
})

test('judge reports bind independent labels and separate origins, exposure, missing work and repeated measurements', async () => {
  const data = fixture()
  const observations = await executeFixedJudgeSuite(data.suite, {
    proposals: [data.proposal], concurrency: 1,
    execute: async () => ({
      status: 'complete', issueFound: true, outcome: 'needs-correction', assessmentSha256: data.proposal.assessmentSha256,
    }), checkpoint: async () => {},
  })
  const label = {
    caseId: data.job.case.id, inputSha256: data.job.case.inputSha256,
    assessmentSha256: data.proposal.assessmentSha256, origin: 'planted',
    author: 'fixture', revision: 'v1', independent: true, expectedIssue: 'none',
    reason: 'The source explicitly matches the saved one-example anchor.',
  }
  const report = summarizeFixedJudgeSuite(data.suite, [data.proposal], observations.slice(0, 1), [label])
  const first = report.reports.find(row => row.split === 'development' && row.origin === 'planted' && row.repetition === 1)
  const second = report.reports.find(row => row.split === 'development' && row.origin === 'planted' && row.repetition === 2)
  assert.equal(first.statistics.all.falsePositive, 1)
  assert.equal(first.statistics.all.falseCorrectionRateOnCompletedValid, 1)
  assert.equal(second.missing, 1)
  assert.equal(second.processingFailed, 0)
  assert.equal(second.statistics.all.trueNegative, 0)
  assert.equal(second.statistics.all.failed, 1)
  assert.equal(report.eligibleForRelease, false)
  const exposed = summarizeFixedJudgeSuite(data.suite, [data.proposal], observations, [{ ...label, independent: false }])
  assert.equal(exposed.reports.find(row => row.split === 'development' && row.origin === 'planted').statistics, null)
  assert.equal(exposed.reports.find(row => row.split === 'development' && row.origin === 'planted').excludedExposedLabels, 1)
  assert.throws(() => summarizeFixedJudgeSuite(data.suite, [data.proposal], observations, [label, label]), /one effective/)
  assert.throws(() => summarizeFixedJudgeSuite(data.suite, [data.proposal], observations, [{ ...label, assessmentSha256: 'a'.repeat(64) }]), /frozen source/)
  const changedProposal = structuredClone(data.proposal)
  changedProposal.assessment.criteria[0].rationale = 'A different proposed rationale.'
  assert.throws(() => summarizeFixedJudgeSuite(data.suite, [changedProposal], observations, [label]), /proposal contents/)
  assert.throws(() => validateFixedJudgeProposals(data.suite, [{ ...data.proposal, assessment: {} }]))
})

test('label-free fixed verdict reports separate binary and categorical disagreement from missing and failed reviews', () => {
  const data = fixture()
  data.suite.repetitions = 3
  data.suite.configurations.push({ ...data.suite.configurations[0], id: 'other-effort' })
  const observation = (configurationId, repetition, outcome) => ({
    schemaVersion: 1, suiteSha256: evaluationHash(data.suite),
    caseId: data.job.case.id, configurationId, repetition,
    assessmentSha256: data.proposal.assessmentSha256, durationMilliseconds: 1,
    result: outcome === 'failed' ? { status: 'failed', code: 'timeout' } : {
      status: 'complete', issueFound: outcome !== 'supported', outcome,
      assessmentSha256: data.proposal.assessmentSha256,
    },
  })
  const report = summarizeFixedJudgeSuite(data.suite, [data.proposal], [
    observation('mini-low', 1, 'supported'), observation('mini-low', 2, 'needs-correction'),
    observation('mini-low', 3, 'failed'),
    observation('other-effort', 1, 'supported'), observation('other-effort', 2, 'unsupported'),
  ], [])
  assert(report.reports.every(row => row.statistics === null && row.referenceItems === 0))
  const baseline = report.verdictStability.find(row => row.configurationId === 'mini-low')
  assert.equal(baseline.completed, 2)
  assert.equal(baseline.processingFailed, 1)
  assert.equal(baseline.missing, 0)
  assert.equal(baseline.complete, false)
  assert.equal(baseline.pairs, 1)
  assert.equal(baseline.issueDisagreementRate, 1)
  assert.equal(baseline.outcomeDisagreementRate, 1)
  const candidate = report.verdictStability.find(row => row.configurationId === 'other-effort')
  assert.equal(candidate.processingFailed, 0)
  assert.equal(candidate.missing, 1)
  const paired = report.configurationComparisons[0]
  assert.equal(paired.pairedReviews, 2)
  assert.equal(paired.unpairedReviews, 1)
  assert.equal(paired.complete, false)
  assert.equal(paired.issueDisagreementRate, 0)
  assert.equal(paired.outcomeDisagreementRate, 0.5)
  assert.equal(paired.assessmentSha256, data.proposal.assessmentSha256)
  const empty = summarizeFixedJudgeSuite(data.suite, [data.proposal], [], [])
  assert(empty.verdictStability.every(row => row.pairs === 0 && row.issueDisagreementRate === null &&
    row.outcomeDisagreementRate === null && row.missing === 3 && row.processingFailed === 0 && !row.complete))
  assert.equal(empty.configurationComparisons[0].pairedReviews, 0)
  assert.equal(empty.configurationComparisons[0].issueDisagreementRate, null)
  assert.equal(empty.configurationComparisons[0].outcomeDisagreementRate, null)
  assert.equal(empty.eligibleForRelease, false)
})
