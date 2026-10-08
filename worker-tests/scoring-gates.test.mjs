import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { scoringSuiteSchema, evaluationHash, evaluateScoringEngineeringGates } = await loadWorker('../worker/evals/index.ts')

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
