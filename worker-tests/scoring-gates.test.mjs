import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const {
  scoringSuiteSchema, evaluationHash, evaluateScoringEngineeringGates, joinAttemptCosts,
  SCORING_ENGINEERING_TARGETS, SCORING_ENGINEERING_TARGETS_V2, SCORING_ENGINEERING_TARGET_SETS,
  scoringEngineeringTargets, scoringTargetsV2Schema,
} = await loadWorker('../worker/evals/index.ts')

function fixture() {
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'six-repeat-panel', purpose: 'stability', sourceVersion: 'fixtures-v1', repetitions: 6,
    configurations: ['baseline', 'candidate'].map(id => ({
      id, settingsSha256: 'a'.repeat(64), algorithmVersion: 'fixtures-v1',
    })),
    cases: Array.from({ length: 20 }, (_, index) => ['gs-7-9', 'gs-11', 'gs-12', 'gs-13'].map(jobId => ({
      id: `${jobId}-family-${index}`, familyId: `family-${index}`, jobId, split: index < 15 ? 'development' : 'calibration',
      inputSha256: 'b'.repeat(64), criterionIds: ['criterion-1'],
    }))).flat(),
  })
  const observations = suite.cases.flatMap(item => suite.configurations.flatMap(config =>
    Array.from({ length: 6 }, (_, index) => ({
      schemaVersion: 1, suiteSha256: evaluationHash(suite), caseId: item.id,
      configurationId: config.id, repetition: index + 1, durationMilliseconds: 1,
      result: { status: 'complete', overall: 40, criteria: [{ criterionId: 'criterion-1', score: 2 }] },
    }))))
  const references = suite.cases.slice(0, 30).map(item => ({
    schemaVersion: 1, id: `human-${item.id}`, caseId: item.id, criterionId: 'criterion-1', inputSha256: item.inputSha256,
    origin: 'human-reviewed', author: 'human-reviewer', independent: true, score: 2,
    reason: 'Blind fixture reference.', evidenceFactIds: [], inclusionProbability: null,
  }))
  return { suite, observations, references }
}

test('engineering targets can pass on sufficient fixtures but never authorize production or certify fairness', () => {
  const { suite, observations, references } = fixture()
  const report = evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate')
  assert.equal(report.measuredTargetsMet, true)
  assert.equal(report.eligibleForRelease, false)
  assert.ok(report.requiredExternalGates.length)
  assert.equal(report.humanErrorDifference.familyMeanDifference, 0)
  assert.equal(report.byJob.length, 4)
  assert.ok(report.checks.every(row => row.status === 'passed'))
})

test('self-produced silver labels and incomplete/null repetitions cannot pass blind-reference or stability gates', () => {
  const { suite, observations, references } = fixture()
  const silver = references.map(row => ({ ...row, origin: 'model-assisted', independent: false }))
  const changed = structuredClone(observations)
  changed.find(row => row.configurationId === 'candidate').result.criteria[0].score = null
  const report = evaluateScoringEngineeringGates(suite, changed, silver, 'baseline', 'candidate')
  assert.equal(report.measuredTargetsMet, false)
  assert.equal(report.checks.find(row => row.id === 'blind-determinate-human-items').status, 'insufficient')
  assert.equal(report.checks.find(row => row.id === 'incomplete-criterion-items').status, 'failed')
  assert.equal(report.humanErrorDifference, null)
  const incomplete = evaluateScoringEngineeringGates(suite, observations.slice(1), references, 'baseline', 'candidate')
  assert.equal(incomplete.checks.find(row => row.id === 'paired-human-items').status, 'insufficient')
  assert.throws(() => evaluateScoringEngineeringGates(suite, observations, references, 'candidate', 'candidate'), /distinct/)
})

test('repeatable but wrong candidates fail the human-error gate and report clustered paired regression', () => {
  const { suite, observations, references } = fixture()
  const changed = observations.map(row => row.configurationId === 'candidate' ? {
    ...row, result: { status: 'complete', overall: 80, criteria: [{ criterionId: 'criterion-1', score: 4 }] },
  } : row)
  const report = evaluateScoringEngineeringGates(suite, changed, references, 'baseline', 'candidate')
  assert.equal(report.checks.find(row => row.id === 'criterion-pairwise-disagreement').status, 'passed')
  assert.equal(report.checks.find(row => row.id === 'human-anchor-mae').status, 'failed')
  assert.equal(report.checks.find(row => row.id === 'human-error-increase-upper95').status, 'failed')
  assert.equal(report.humanErrorDifference.familyMeanDifference, 2)
})

const V2 = 'score-engineering-targets-v2'
const JOB_TARGETS = ['gs-7-9', 'gs-11', 'gs-12', 'gs-13']
const GRADE_TARGETS = ['gs-7-grade', 'gs-9-grade', 'gs-11-grade', 'gs-12-grade']
const tally = (truePositive, falseNegative = 0, falsePositive = 0, trueNegative = 0, failed = 0) =>
  ({ failed, truePositive, falseNegative, falsePositive, trueNegative })

function v2Fixture() {
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'v2-panel', purpose: 'stability', sourceVersion: 'fixtures-v2', repetitions: 6,
    configurations: ['baseline', 'candidate', 'candidate-luna'].map(id => ({
      id, settingsSha256: 'a'.repeat(64), algorithmVersion: 'fixtures-v2',
    })),
    cases: Array.from({ length: 20 }, (_, index) => [
      ...JOB_TARGETS.map(jobId => ({ jobId })), ...GRADE_TARGETS.map(jobId => ({ jobId, targetKind: 'grade' })),
    ].map(({ jobId, targetKind }) => ({
      id: `${jobId}-family-${index}`, familyId: `family-${index}`, jobId, split: index < 15 ? 'development' : 'calibration',
      ...(targetKind ? { targetKind } : {}), inputSha256: 'b'.repeat(64), criterionIds: ['criterion-1'],
    }))).flat(),
  })
  const observations = suite.cases.flatMap(item => suite.configurations.flatMap(config =>
    Array.from({ length: 6 }, (_, index) => ({
      schemaVersion: 1, suiteSha256: evaluationHash(suite), caseId: item.id,
      configurationId: config.id, repetition: index + 1, durationMilliseconds: 1,
      result: { status: 'complete', overall: 40, criteria: [{ criterionId: 'criterion-1', score: 2 }] },
    }))))
  const references = suite.cases.filter(item => !item.targetKind).slice(0, 30).map(item => ({
    schemaVersion: 1, id: `human-${item.id}`, caseId: item.id, criterionId: 'criterion-1', inputSha256: item.inputSha256,
    origin: 'human-reviewed', author: 'human-reviewer', independent: true, score: 2,
    reason: 'Blind fixture reference.', evidenceFactIds: [], inclusionProbability: null,
  }))
  const empty = tally(0)
  const panels = {
    rubricGeneration: ['job', 'grade'].map(targetKind => ({
      targetKind, configurationId: 'generator',
      report: {
        schemaVersion: 1, cells: ['a', 'b', 'c', 'd'].map(source => ({
          sourceId: `${targetKind}-${source}`, configurationId: 'generator', expected: 6, completed: 6, failed: 0, missing: 0,
        })),
      },
    })),
    fixedJudge: {
      configurationId: 'reviewer', report: {
        schemaVersion: 1,
        reports: [
          { configurationId: 'reviewer', origin: 'planted', statistics: { all: tally(24), byExpectedIssue: {
            none: empty, 'over-credit': tally(8), 'under-credit': tally(8), 'unsupported-fact': tally(8),
          } } },
          { configurationId: 'reviewer', origin: 'human-reviewed', statistics: { all: tally(0, 0, 1, 9), byExpectedIssue: {
            none: tally(0, 0, 1, 9), 'over-credit': empty, 'under-credit': empty, 'unsupported-fact': empty,
          } } },
        ],
        verdictStability: Array.from({ length: 4 }, () => ({
          configurationId: 'reviewer', complete: true, pairs: 15, issueDisagreements: 1, outcomeDisagreements: 2,
        })),
      },
    },
    monotonicity: {
      configurationId: 'candidate', report: {
        schemaVersion: 1, items: [{
          configurationId: 'candidate', complete: true, independent: true, criteria: [
            { eligibleForIndependentDiagnostic: true, meanSignedDelta: 1.5, decreasesGreaterThanOne: 0 },
            // Spillover on criteria without expected support is reported elsewhere, not gated.
            { eligibleForIndependentDiagnostic: false, meanSignedDelta: -0.4, decreasesGreaterThanOne: 1 },
          ],
        }],
      },
    },
    invariance: {
      configurationId: 'candidate', report: {
        schemaVersion: 1, noiseFloor: ['identity-only', 'format', 'irrelevant-detail', 'paraphrase'].map(kind => ({
          configurationId: 'candidate', kind, completePanels: 3, metrics: [
            { metric: 'disagreement', familyMeanExcess: kind === 'paraphrase' ? 0.4 : 0.01 },
            { metric: 'greaterThanOne', familyMeanExcess: 0 },
          ],
        })),
      },
    },
    crossModel: { leftConfigurationId: 'candidate', rightConfigurationId: 'candidate-luna' },
    attemptCosts: observations.filter(row => row.configurationId === 'candidate').flatMap(row => [600, 400].map(amountUsdMicros => ({
      caseId: row.caseId, configurationId: 'candidate', repetition: row.repetition, amountUsdMicros,
    }))),
  }
  return { suite, observations, references, panels }
}

function frozenTargets() {
  const targets = structuredClone(SCORING_ENGINEERING_TARGETS_V2)
  return {
    ...targets, status: 'frozen',
    reviewer: { ...targets.reviewer, maximumDirectionGap: 0.1 },
    invariance: { ...targets.invariance, maximumExcessDisagreement: 0.05 },
    crossModel: { maximumMeanCriterionGap: 0.25, maximumMeanOverallGap: 3 },
    costLatency: { maximumMeanUsdMicrosPerAnalysis: 5000, maximumP95AnalysisMilliseconds: 600000 },
  }
}

test('target sets are versioned: v1 stays the unchanged default and v2 is a registered draft', () => {
  assert.deepEqual(Object.keys(SCORING_ENGINEERING_TARGET_SETS), ['score-engineering-targets-v1', V2])
  assert.equal(scoringEngineeringTargets('score-engineering-targets-v1'), SCORING_ENGINEERING_TARGETS)
  assert.equal(scoringEngineeringTargets(V2), SCORING_ENGINEERING_TARGETS_V2)
  assert.throws(() => scoringEngineeringTargets('score-engineering-targets-v9'), /Unknown/)
  assert.equal(SCORING_ENGINEERING_TARGETS_V2.status, 'draft')
  assert.deepEqual(SCORING_ENGINEERING_TARGETS_V2.targetKinds, ['job', 'grade'])
  assert.equal(SCORING_ENGINEERING_TARGETS_V2.reviewer.maximumVerdictFlipRate, 0.1)
  assert.equal(SCORING_ENGINEERING_TARGETS_V2.rubricGeneration.validRate, 1)
  assert.ok(Object.isFrozen(SCORING_ENGINEERING_TARGETS_V2.reviewer))
  for (const key of Object.keys(SCORING_ENGINEERING_TARGETS)) {
    if (key !== 'version') assert.equal(SCORING_ENGINEERING_TARGETS_V2[key], SCORING_ENGINEERING_TARGETS[key], key)
  }
  assert.doesNotThrow(() => scoringTargetsV2Schema.parse(SCORING_ENGINEERING_TARGETS_V2))
  assert.throws(() => scoringTargetsV2Schema.parse({ ...structuredClone(SCORING_ENGINEERING_TARGETS_V2), status: 'frozen' }), /unset/)
  const { suite, observations, references } = fixture()
  const report = evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate')
  assert.deepEqual(report, evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate', {
    targetsVersion: 'score-engineering-targets-v1',
  }))
  assert.equal(report.schemaVersion, 1)
  assert.ok(report.checks.every(row => !('note' in row)))
  assert.throws(() => evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate', { panels: {} }), /v2/)
})

test('a draft v2 report measures every panel per rubric kind but leaves baseline-set thresholds undecided', () => {
  const { suite, observations, references, panels } = v2Fixture()
  const report = evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate', { targetsVersion: V2, panels })
  const check = id => report.checks.find(row => row.id === id)
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.targetsStatus, 'draft')
  assert.equal(report.targetsRegistered, true)
  assert.equal(report.measuredTargetsMet, false)
  assert.equal(report.eligibleForRelease, false)
  assert.deepEqual(report.byTargetKind.map(row => [row.targetKind, row.cases, row.targets, row.families]), [
    ['job', 80, 4, 20], ['grade', 80, 4, 20],
  ])
  for (const id of [
    'criterion-pairwise-disagreement:grade', 'completion-failure-rate:job', 'p95-overall-range:grade', 'rubric-generation-valid-rate:job',
    'rubric-generation-valid-rate:grade', 'reviewer-verdict-flip-rate', 'reviewer-planted-recall',
    'monotonicity-negative-mean-criteria', 'monotonicity-large-decreases', 'human-anchor-mae',
  ]) assert.equal(check(id).status, 'passed', id)
  assert.equal(check('reviewer-verdict-flip-rate').actual, 4 / 60)
  for (const id of [
    'reviewer-direction-gap', 'invariance-excess-disagreement', 'cross-model-criterion-gap', 'cross-model-overall-gap',
    'analysis-p95-milliseconds', 'analysis-mean-usd-micros',
  ]) {
    assert.equal(check(id).status, 'insufficient', id)
    assert.equal(check(id).note, 'target-not-frozen', id)
  }
  // Paraphrase isn't a v2 invariance kind, so its larger excess doesn't count.
  assert.equal(check('invariance-excess-disagreement').actual, 0.01)
  assert.equal(check('cross-model-criterion-gap').actual, 0)
  assert.equal(check('analysis-mean-usd-micros').actual, 1000)
  assert.equal(report.reportedMetrics.find(row => row.id === 'reviewer-false-correction-rate').value, 0.1)
  assert.ok(report.checks.every(row => row.status === 'passed' || row.note === 'target-not-frozen'))
})

test('frozen v2 thresholds fail reviewer flips, missed or one-sided defect detection, falling evidence scores and invalid rubrics', () => {
  const { suite, observations, references, panels } = v2Fixture()
  const evaluate = changed => evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate', {
    targetsVersion: V2, targets: frozenTargets(), panels: changed,
  })
  const passing = evaluate(panels)
  assert.deepEqual(passing.checks.filter(row => row.status !== 'passed'), [])
  // What-if thresholds can describe a run but never qualify it.
  assert.equal(passing.targetsRegistered, false)
  assert.equal(passing.measuredTargetsMet, false)
  const changed = structuredClone(panels)
  changed.fixedJudge.report.verdictStability[0].issueDisagreements = 9
  changed.fixedJudge.report.reports[0].statistics.all = tally(23, 1)
  changed.fixedJudge.report.reports[0].statistics.byExpectedIssue['under-credit'] = tally(6, 2)
  changed.monotonicity.report.items[0].criteria[0] = { eligibleForIndependentDiagnostic: true, meanSignedDelta: -0.2, decreasesGreaterThanOne: 2 }
  changed.rubricGeneration[1].report.cells[0] = { ...changed.rubricGeneration[1].report.cells[0], completed: 5, failed: 1 }
  const failing = evaluate(changed)
  const status = id => failing.checks.find(row => row.id === id).status
  for (const id of [
    'reviewer-verdict-flip-rate', 'reviewer-planted-recall', 'reviewer-direction-gap', 'monotonicity-negative-mean-criteria',
    'monotonicity-large-decreases', 'rubric-generation-valid-rate:grade',
  ]) assert.equal(status(id), 'failed', id)
  assert.equal(status('rubric-generation-valid-rate:job'), 'passed')
  assert.throws(() => evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate', {
    targetsVersion: V2, targets: { ...frozenTargets(), crossModel: { maximumMeanCriterionGap: null, maximumMeanOverallGap: 3 } },
  }), /unset/)
})

test('v2 keeps absent panels, missing grade targets and unpriced attempts insufficient instead of passing them', () => {
  const { suite, observations, references, panels } = v2Fixture()
  const jobOnly = scoringSuiteSchema.parse({ ...suite, cases: suite.cases.filter(item => !item.targetKind) })
  const jobObservations = observations.filter(row => !row.caseId.includes('grade'))
    .map(row => ({ ...row, suiteSha256: evaluationHash(jobOnly) }))
  const report = evaluateScoringEngineeringGates(jobOnly, jobObservations, references, 'baseline', 'candidate', {
    targetsVersion: V2, targets: frozenTargets(), panels: { attemptCosts: [{ ...panels.attemptCosts[0], amountUsdMicros: null }] },
  })
  const check = id => report.checks.find(row => row.id === id)
  assert.equal(check('target-cases:grade').status, 'insufficient')
  assert.equal(check('incomplete-criterion-items:grade').status, 'insufficient')
  assert.equal(check('criterion-pairwise-disagreement:job').status, 'passed')
  for (const id of [
    'rubric-generation-valid-rate:job', 'reviewer-verdict-flip-rate', 'monotonicity-large-decreases',
    'invariance-excess-disagreement', 'cross-model-criterion-gap',
  ]) {
    assert.equal(check(id).status, 'insufficient', id)
    assert.equal(check(id).note, 'panel-not-supplied', id)
  }
  assert.equal(check('analysis-mean-usd-micros').status, 'insufficient')
  assert.equal(check('analysis-mean-usd-micros').note, 'unpriced-or-unmatched-analyses')
  assert.equal(report.costs.unpriced, 1)
  assert.equal(report.costs.withoutAttempts, jobObservations.filter(row => row.configurationId === 'candidate').length - 1)
  assert.throws(() => evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate', {
    targetsVersion: V2, panels: { crossModel: { leftConfigurationId: 'candidate', rightConfigurationId: 'candidate' } },
  }), /distinct/)
  assert.throws(() => evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate', {
    targetsVersion: V2, panels: { judge: panels.fixedJudge },
  }))
  assert.throws(() => evaluateScoringEngineeringGates(suite, observations, references, 'baseline', 'candidate', {
    targetsVersion: V2, panels: { fixedJudge: { ...panels.fixedJudge, configurationId: 'other-reviewer' } },
  }), /lacks/)
})

test('attempt costs join the runner attempt log to its ledger entry and refuse unledgered or repeated attempts', () => {
  const entry = (id, amountUsdMicros) => ({
    schemaVersion: 1, id, costItemId: id, suiteId: 'v2-panel', category: 'inference', mode: 'estimate',
    amountUsdMicros, priceVersion: 'prices-v1', usage: null,
  })
  const attempt = id => ({
    id, taskId: 'assessment', deployment: 'deployment', actualModel: null,
    evaluation: { suiteSha256: 'c'.repeat(64), caseId: 'case-1', configurationId: 'candidate', repetition: 1 },
  })
  assert.deepEqual(joinAttemptCosts([attempt('a-1'), attempt('a-2')], [entry('a-1', 300), entry('a-2', null), entry('other', 9)]), [
    { caseId: 'case-1', configurationId: 'candidate', repetition: 1, amountUsdMicros: 300 },
    { caseId: 'case-1', configurationId: 'candidate', repetition: 1, amountUsdMicros: null },
  ])
  assert.throws(() => joinAttemptCosts([attempt('a-3')], [entry('a-1', 300)]), /ledger/)
  assert.throws(() => joinAttemptCosts([attempt('a-1'), attempt('a-1')], [entry('a-1', 300)]), /ledger/)
  assert.throws(() => joinAttemptCosts([attempt('a-1')], [entry('a-1', 300), entry('a-1', 300)]), /unique/)
})
