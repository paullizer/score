import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsSnapshot } from './runtime-settings-test-support.mjs'

const { executeProductionEvaluation, validateProductionEvaluation, evaluationHash, createEvaluationSettings, assessEvidenceFirst, exportScorerDerivedReferences, scoringSuiteSchema, assessSourceOnlyReference, exportSourceOnlyReferences, SOURCE_REFERENCE_VERSION } = await loadWorker('../worker/evals/index.ts')
const { validateAnalysisAssessmentInput, hashAnalysisAssessment } = await loadWorker('../worker/analyses/model.ts')
const { createCompiledPromptBaseline } = await loadWorker('../server/settings/prompts.ts')
const { captureProcessingSettings } = await loadWorker('../src/domain/admin-settings.ts')

function fixture(maxOutputCorrections) {
  const citation = { documentId: 'job-document', documentVersion: 1, paragraphId: 'job-p1', page: 1, heading: 'Work', quote: 'Documented statistical analysis.' }
  const input = validateAnalysisAssessmentInput({
    resume: {
      id: 'resume-document', version: 1, kind: 'resume', sample: false, title: 'Simulated resume',
      paragraphs: [{ id: 'resume-p1', page: 1, heading: 'Work', text: 'Applied regression models to survey data and documented uncertainty estimates.' }],
    },
    rubric: {
      id: 'job-rubric', groupId: 'job-rubric', jobId: 'job-1', kind: 'job', dataKind: 'real',
      name: 'Statistical work', description: 'Documented statistical analysis.', version: 1,
      createdAt: '2026-10-07T00:00:00Z',
      criteria: [{
        id: 'statistical-analysis', key: 'custom', label: 'Statistical analysis', description: 'Documented statistical analysis.',
        weight: 100, requirementType: 'required',
        guidance: '0: No document evidence. 1: Coursework. 2: One applied example. 3: Sustained work. 4: Coordinated work. 5: Led complex work.',
        sourceCitations: [citation],
      }],
    },
    qualifications: [],
    requirementEvidence: [{ kind: 'criterion', criterionId: 'statistical-analysis', citations: [citation] }],
  })
  const base = settingsSnapshot(settings => {
    for (const deployment of settings.ai.deployments) deployment.modelVersion = '2025-08-07'
  })
  const settings = maxOutputCorrections === undefined ? base.settings : {
    ...base.settings, analyses: { ...base.settings.analyses, maxOutputCorrections },
  }
  const snapshot = captureProcessingSettings(settings, base.revision, base.capturedAt, createCompiledPromptBaseline())
  const job = {
    suiteSha256: 'a'.repeat(64),
    case: { id: 'case-1', familyId: 'family-1', jobId: 'gs-13', split: 'development', inputSha256: evaluationHash(input), criterionIds: ['statistical-analysis'] },
    configuration: { id: 'baseline', settingsSha256: evaluationHash(snapshot), algorithmVersion: 'score-production-v1' },
    repetition: 1,
  }
  const price = { version: 'test-rates', currency: 'USD', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 }
  const prices = Object.fromEntries(['assessment', 'assessmentReview'].map(task => [snapshot.tasks[task].deploymentName, price]))
  return { job, input, snapshot, prices }
}

const assessment = {
  criteria: [{
    criterionId: 'statistical-analysis', evidenceStatus: 'supported', score: 2, limitation: null,
    rationale: 'The document describes one applied regression example and uncertainty estimates.',
    citations: [{ passageId: 1 }],
  }],
  qualifications: [],
  qcDiagnostics: { criteria: [{
    criterionId: 'statistical-analysis', confidence: 'high', explanation: 'One applied example matches the saved anchor.',
    ambiguity: [], alternativeScores: [],
  }] },
}
const review = { outcome: 'supported', issues: [] }

test('production adapter binds frozen inputs/settings, keeps exact citations and captures both model calls', async () => {
  const fixtureData = fixture()
  const attempts = [], results = []
  let calls = 0, admitted = 0
  const output = await executeProductionEvaluation(fixtureData.job, {
    input: fixtureData.input, processingSettings: fixtureData.snapshot, prices: fixtureData.prices,
    model: {
      endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini',
      getToken: async () => 'test-token',
      fetch: async () => Response.json({
        model: 'gpt-5-mini-2025-08-07', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls++ ? review : assessment) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 20 } },
      }),
    },
    admitPaidWork: async () => { admitted++ },
    recordAttempt: async (record, amount) => { attempts.push({ record, amount }) },
    recordPrivateResult: async result => {
      results.push(structuredClone(result))
      result.assessment.criteria[0].score = 5
      result.assessment.criteria[0].rationale = 'OBSERVER-MUTATION'
    },
  })
  assert.equal(admitted, 1)
  assert.equal(calls, 2)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].amount, 200)
  assert.equal(output.overall, 40)
  assert.equal(output.criteria[0].score, 2)
  assert.equal(output.assessmentSha256, hashAnalysisAssessment(results[0].assessment))
  assert.equal(results[0].assessment.criteria[0].citations[0].quote, fixtureData.input.resume.paragraphs[0].text)
})

test('preflight rejects missing prices, stale sources and unknown algorithms before paid admission', () => {
  const fixtureData = fixture()
  const options = { input: fixtureData.input, processingSettings: fixtureData.snapshot, prices: fixtureData.prices }
  assert.throws(() => validateProductionEvaluation(fixtureData.job, { ...options, prices: {} }), /prices/)
  assert.throws(() => validateProductionEvaluation({
    ...fixtureData.job, case: { ...fixtureData.job.case, inputSha256: 'c'.repeat(64) },
  }, options), /exact saved case/)
  assert.throws(() => validateProductionEvaluation({
    ...fixtureData.job, configuration: { ...fixtureData.job.configuration, algorithmVersion: 'unverified' },
  }, options), /impersonate/)
  const unpinned = settingsSnapshot()
  assert.throws(() => validateProductionEvaluation({
    ...fixtureData.job,
    configuration: { ...fixtureData.job.configuration, settingsSha256: evaluationHash(unpinned) },
  }, { ...options, processingSettings: unpinned }), /explicit frozen model version/)
})

test('evaluation settings reuse one deployment for two tasks while retaining separate reasoning efforts', () => {
  const binding = { deploymentName: 'job-rubric', modelName: 'gpt-5-mini', modelVersion: '2025-08-07', reasoningEffort: 'low' }
  const snapshot = createEvaluationSettings({
    revision: 'evaluation-v1', capturedAt: '2026-10-07T00:00:00.000Z',
    assessor: binding, reviewer: { ...binding, reasoningEffort: 'high' },
  })
  assert.equal(snapshot.settings.ai.deployments.length, 1)
  assert.equal(snapshot.tasks.assessment.reasoningEffort, 'low')
  assert.equal(snapshot.tasks.assessmentReview.reasoningEffort, 'high')
  assert.throws(() => createEvaluationSettings({
    revision: 'evaluation-v1', capturedAt: '2026-10-07T00:00:00.000Z',
    assessor: binding, reviewer: { ...binding, modelName: 'gpt-6-luna', modelVersion: '2026-09-22' },
  }), /two different/)
})

test('cost-recording failure remains an infrastructure exception, not a completed or reusable failed score', async () => {
  const fixtureData = fixture()
  await assert.rejects(executeProductionEvaluation(fixtureData.job, {
    input: fixtureData.input, processingSettings: fixtureData.snapshot, prices: fixtureData.prices,
    model: {
      endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini',
      getToken: async () => 'test-token',
      fetch: async () => Response.json({
        model: 'gpt-5-mini-2025-08-07', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(assessment) } }],
      }),
    },
    admitPaidWork: async () => {},
    recordAttempt: async () => { throw new Error('Ledger unavailable') },
    recordPrivateResult: async () => assert.fail('No publication after failed ledger write.'),
  }), /Ledger unavailable/)
})

test('typed scoring failure retains stage/reason and storage failure cannot become a reusable failed observation', async () => {
  const data = fixture(), failures = []
  const options = {
    input: data.input, processingSettings: data.snapshot, prices: data.prices,
    model: {
      endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini',
      getToken: async () => 'test-token',
      fetch: async () => Response.json({
        model: 'gpt-5-mini-2025-08-07',
        choices: [{ finish_reason: 'length', message: { content: '{}' } }],
      }),
    },
    admitPaidWork: async () => {}, recordAttempt: async () => {},
    recordPrivateResult: async () => assert.fail('No result for a truncated assessment.'),
    recordPrivateFailure: async row => { failures.push(row) },
  }
  const result = await executeProductionEvaluation(data.job, options)
  assert.equal(result.status, 'failed')
  assert.deepEqual(failures, [{ code: 'context-limit', stage: 'assessment', reason: 'completion-token-limit' }])
  options.recordPrivateFailure = async () => { throw new Error('Failure store unavailable') }
  await assert.rejects(executeProductionEvaluation(data.job, options), /Failure store unavailable/)
})

for (const actualModel of ['gpt-5-mini-2099-01-01', null]) {
test(`a changed or missing provider model (${actualModel}) cannot publish under the frozen identity`, async () => {
  const data = fixture()
  const attempts = []
  let calls = 0
  await assert.rejects(executeProductionEvaluation(data.job, {
    input: data.input, processingSettings: data.snapshot, prices: data.prices,
    model: {
      endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini',
      getToken: async () => 'test-token',
      fetch: async () => {
        calls++
        return Response.json({
          model: actualModel,
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(assessment) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
        })
      },
    },
    admitPaidWork: async () => {},
    recordAttempt: async (attempt, amount) => { attempts.push({ attempt, amount }) },
    recordPrivateResult: async () => assert.fail('A different model cannot publish under the old configuration.'),
  }), /differs from the frozen/)
  assert.equal(calls, 1)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].amount, null)
  assert.equal(attempts[0].attempt.actualModel, actualModel)
})
}

function candidateOptions(fixtureData, outputs) {
  const calls = []
  return {
    calls,
    options: {
      resumeSnapshotSha256: evaluationHash(fixtureData.input.resume),
      targetSnapshotSha256: evaluationHash(fixtureData.input.rubric),
      model: {
        endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini',
        processingSettings: fixtureData.snapshot, getToken: async () => 'test-token',
        fetch: async (_url, init) => {
          calls.push(JSON.parse(init.body))
          const output = outputs.shift()
          assert.ok(output, 'No unexpected model calls or retry-until-accepted loop.')
          return Response.json({
            model: 'gpt-5-mini-2025-08-07',
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
          })
        },
      },
    },
  }
}

test('scorer-derived references preserve zero, pending/failure nulls and non-independent producer provenance', () => {
    const { job, snapshot } = fixture()
    const suite = scoringSuiteSchema.parse({
      schemaVersion: 1, id: 'reference-fixture', purpose: 'smoke', sourceVersion: 'fixtures-v1', repetitions: 1,
      configurations: [job.configuration],
      cases: ['zero', 'failure', 'pending'].map(id => ({ ...job.case, id, familyId: id })),
    })
    const targets = suite.cases.map(item => ({
      id: `target-${item.id}`, caseId: item.id, criterionId: 'statistical-analysis',
      inputSha256: item.inputSha256, inclusionProbability: 0.5,
    }))
    const observations = [
      { caseId: 'zero', result: { status: 'complete', overall: 0, criteria: [{ criterionId: 'statistical-analysis', score: 0 }] } },
      { caseId: 'failure', result: { status: 'failed', code: 'grounding-failed' } },
    ].map(row => ({
      schemaVersion: 1, suiteSha256: evaluationHash(suite), configurationId: job.configuration.id,
      repetition: 1, durationMilliseconds: 10, ...row,
    }))
    const output = exportScorerDerivedReferences(suite, targets, observations, job.configuration.id, 1, snapshot)
    assert.deepEqual(output.references.map(row => row.score), [0, null, null])
    assert.ok(output.references.every(row => row.independent === false && row.origin === 'model-assisted' && row.evidenceFactIds.length === 0))
    assert.equal(output.provenance.exposure, 'scorer-output-derived')
    assert.deepEqual(output.provenance.taskBindings.assessment, snapshot.tasks.assessment)
    assert.equal(output.provenance.items[2].observationSha256, null)
    assert.match(output.references[1].reason, /grounding-failed/)
    assert.throws(() => exportScorerDerivedReferences(suite, targets, observations, 'invented', 1, snapshot), /producer/)
    assert.throws(() => exportScorerDerivedReferences(suite, targets, observations, job.configuration.id, 2, snapshot), /producer/)
    assert.throws(() => exportScorerDerivedReferences(suite, [...targets, targets[0]], observations, job.configuration.id, 1, snapshot), /unique/)
    assert.throws(() => exportScorerDerivedReferences(
      suite, targets.map(row => ({ ...row, inputSha256: 'b'.repeat(64) })), observations, job.configuration.id, 1, snapshot,
    ), /exact frozen/)
})

const mappedEvidence = {
  criteria: [{
    criterionId: 'statistical-analysis', supportingPassageIds: [1], contradictoryPassageIds: [],
    interpretationUncertain: true, explanation: 'Applied regression and uncertainty evidence may span two anchors.',
  }],
}

test('independent source-reference call sees full source and saved anchors but no scorer outputs or correction/review loop', async () => {
  const data = fixture()
  const initial = structuredClone(assessment)
  delete initial.qcDiagnostics
  const mock = candidateOptions(data, [initial])
  const result = await assessSourceOnlyReference(data.input, mock.options)
  assert.equal(mock.calls.length, 1)
  const body = JSON.parse(mock.calls[0].messages[1].content)
  assert.deepEqual(Object.keys(body), ['input'])
  assert.equal(body.input.resume.paragraphs[0].passages[0].text, data.input.resume.paragraphs[0].text)
  assert.match(mock.calls[0].messages[0].content, /No other model scores/)
  assert.equal(result.referenceExposure.inputSha256, evaluationHash(data.input))
  assert.equal(result.referenceExposure.modelOpinionsSupplied, false)
  assert.equal(result.groundingReviews.length, 0)
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'reference-source-fixture', purpose: 'smoke', sourceVersion: 'fixtures-v1', repetitions: 1,
    configurations: [{ ...data.job.configuration, algorithmVersion: SOURCE_REFERENCE_VERSION }], cases: [data.job.case],
  })
  const targets = [{
    id: 'target-one', caseId: data.job.case.id, criterionId: 'statistical-analysis',
    inputSha256: data.job.case.inputSha256, inclusionProbability: 0.5,
  }]
  const output = exportSourceOnlyReferences(suite, targets, 'baseline', [{ caseId: data.job.case.id, result }])
  assert.equal(output.references[0].independent, true)
  assert.equal(output.references[0].score, 2)
  assert.equal(output.provenance[0].actualModel, 'gpt-5-mini-2025-08-07')
  const unresolved = exportSourceOnlyReferences(suite, targets, 'baseline', [])
  assert.equal(unresolved.references[0].score, null)
  assert.throws(() => exportSourceOnlyReferences(suite, targets, 'baseline', [{
    caseId: data.job.case.id, result: { ...result, referenceExposure: { ...result.referenceExposure, modelOpinionsSupplied: true } },
  }]))
  assert.throws(() => exportSourceOnlyReferences(suite, targets, 'baseline', [{
    caseId: data.job.case.id, result: { ...result, referenceExposure: { ...result.referenceExposure, inputSha256: 'b'.repeat(64) } },
  }]), /exact frozen/)
})

test('experimental evidence-first resolver can raise a score and returns no user disagreement action', async () => {
  const fixtureData = fixture()
  const corrected = structuredClone(assessment)
  delete corrected.qcDiagnostics
  corrected.criteria[0].score = 3
  corrected.criteria[0].rationale = 'The complete passage also describes uncertainty estimation under this saved anchor.'
  const initial = structuredClone(assessment)
  delete initial.qcDiagnostics
  const mock = candidateOptions(fixtureData, [
    mappedEvidence, initial,
    { outcome: 'needs-correction', issues: [{
      code: 'omitted-evidence', criterionId: 'statistical-analysis', qualificationId: null,
      message: 'Consider documented uncertainty estimation as well as the regression example.', citations: [{ passageId: 1 }],
    }] },
    corrected,
  ])
  const diagnostics = []
  mock.options.onDiagnostic = row => {
    diagnostics.push(structuredClone(row))
    row.assessment.criteria[0].rationale = 'OBSERVER-MUTATION'
  }
  const result = await assessEvidenceFirst(fixtureData.input, mock.options)
  assert.equal(result.summary.overall.score, 60)
  assert.equal(result.automaticallyResolved, true)
  assert.equal(result.verificationSelected, true)
  assert.equal(result.correctionCount, 1)
  assert.equal(mock.calls.length, 4)
  assert.match(mock.calls[3].messages[0].content, /does not require a lower score/)
  assert.equal('userActionRequired' in result, false)
  assert.equal(result.groundingReviews[0].outcome, 'needs-correction')
  assert.equal(result.initialAssessment.criteria[0].score, 2)
  assert.equal(result.initialAssessmentProvenance.model, 'gpt-5-mini-2025-08-07')
  assert.equal(diagnostics.length, 3)
  assert.equal(diagnostics[1].assessmentSha256, result.groundingReviews[0].assessmentSha256)
  assert.doesNotMatch(JSON.stringify(result), /OBSERVER-MUTATION/)
  assert.doesNotMatch(JSON.stringify(mock.calls), /OBSERVER-MUTATION/)
  for (const call of mock.calls) {
    const body = JSON.parse(call.messages[1].content)
    assert.equal(body.input.resume.paragraphs[0].passages[0].text, fixtureData.input.resume.paragraphs[0].text)
  }
})

test('private diagnostic storage failures prevent reusable completion without hiding already captured scores or rebuying calls', async () => {
  const data = fixture()
  let calls = 0
  const diagnostics = []
  await assert.rejects(executeProductionEvaluation(data.job, {
    input: data.input, processingSettings: data.snapshot, prices: data.prices,
    model: {
      endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini',
      getToken: async () => 'test-token',
      fetch: async () => Response.json({
        model: 'gpt-5-mini-2025-08-07',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls++ ? review : assessment) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
      }),
    },
    admitPaidWork: async () => {},
    recordAttempt: async () => {},
    recordPrivateResult: async () => {},
    recordPrivateDiagnostics: async rows => { diagnostics.push(...rows); throw new Error('Private diagnostics unavailable') },
  }), /Private diagnostics unavailable/)
  assert.equal(calls, 2)
  assert.equal(diagnostics.length, 2)
  assert.equal(diagnostics[0].assessment.criteria[0].score, 2)
  assert.equal(diagnostics[1].review.outcome, 'supported')
})

test('cancellation during private publication cannot become a reusable completed comparison', async () => {
  const data = fixture()
  const controller = new AbortController()
  let calls = 0, costs = 0
  await assert.rejects(executeProductionEvaluation(data.job, {
    input: data.input, processingSettings: data.snapshot, prices: data.prices,
    model: {
      endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini',
      getToken: async () => 'test-token',
      fetch: async () => Response.json({
        model: 'gpt-5-mini-2025-08-07',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls++ ? review : assessment) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
      }),
    },
    admitPaidWork: async () => {},
    recordAttempt: async () => { costs++ },
    recordPrivateResult: async () => {},
    recordPrivateDiagnostics: async () => { controller.abort(new Error('Publication deadline reached')) },
  }, controller.signal), /Publication deadline reached/)
  assert.equal(calls, 2)
  assert.equal(costs, 2)
})

test('experimental mapping cannot silently drop, duplicate or invent source assignments', async () => {
  const fixtureData = fixture()
  for (const invalid of [
    { criteria: [] },
    { criteria: [{ ...mappedEvidence.criteria[0], supportingPassageIds: [2] }] },
    { criteria: [{ ...mappedEvidence.criteria[0], supportingPassageIds: [1, 1] }] },
    { criteria: [{ ...mappedEvidence.criteria[0], contradictoryPassageIds: [1, 1] }] },
  ]) {
    const mock = candidateOptions(fixtureData, [invalid])
    await assert.rejects(assessEvidenceFirst(fixtureData.input, mock.options))
    assert.equal(mock.calls.length, 1)
  }
})

test('experimental selective verification skips ordinary matches outside its fixed audit sample', async () => {
  const fixtureData = fixture()
  for (let index = 0; index < 10; index++) {
    fixtureData.input.resume.title = `Simulated resume ${index}`
    if (Number.parseInt(evaluationHash([fixtureData.input.resume, fixtureData.input.rubric]).slice(0, 8), 16) % 5 !== 0) break
  }
  const output = structuredClone(assessment)
  delete output.qcDiagnostics
  const mock = candidateOptions(fixtureData, [
    { criteria: [{ ...mappedEvidence.criteria[0], interpretationUncertain: false }] }, output,
  ])
  const result = await assessEvidenceFirst(fixtureData.input, mock.options)
  assert.equal(result.summary.overall.score, 40)
  assert.equal(result.verificationSelected, false)
  assert.equal(result.automaticallyResolved, false)
  assert.equal(mock.calls.length, 2)
  assert.deepEqual(result.groundingReviews, [])
})

test('experimental format repair and semantic resolution share one captured budget without resetting stages', async () => {
  const data = fixture(1)
  const valid = structuredClone(assessment)
  delete valid.qcDiagnostics
  const invalid = { ...valid, criteria: [] }
  const rejected = {
    outcome: 'needs-correction', issues: [{
      code: 'omitted-evidence', criterionId: 'statistical-analysis', qualificationId: null,
      message: 'Check the uncertainty evidence against the saved anchor.', citations: [{ passageId: 1 }],
    }],
  }
  const mock = candidateOptions(data, [mappedEvidence, invalid, valid, rejected])
  await assert.rejects(assessEvidenceFirst(data.input, mock.options), error => error.code === 'grounding-failed')
  assert.equal(mock.calls.length, 4)
  assert.match(mock.calls[2].messages[0].content, /complete source/)
})

test('zero captured corrections prevent rebuying invalid candidate output and cancellation prevents publication', async () => {
  const data = fixture(0)
  const invalid = structuredClone(assessment)
  delete invalid.qcDiagnostics
  invalid.criteria[0].score = 6
  const mock = candidateOptions(data, [mappedEvidence, invalid])
  await assert.rejects(assessEvidenceFirst(data.input, mock.options))
  assert.equal(mock.calls.length, 2)
  const cancelled = candidateOptions(data, [mappedEvidence])
  cancelled.options.signal = AbortSignal.abort(new Error('Cancelled trial'))
  await assert.rejects(assessEvidenceFirst(data.input, cancelled.options))
  assert.equal(cancelled.calls.length, 0)
})
