import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
const { evidenceDetectionStatistics, pairedFamilyBootstrap, fixedJudgeStatistics } = await loadWorker('../worker/evals/index.ts')

test('evidence metrics do not treat unknown passages as annotated truth', () => {
  const stats = evidenceDetectionStatistics([{
    id: 'case-1', expectedSupportingFacts: ['a', 'b'],
    knownNonSupportingFacts: ['adjacent'], retrievedFacts: ['a', 'adjacent', 'unknown'],
  }])
  assert.equal(stats.precisionOnAnnotatedFacts, 0.5)
  assert.equal(stats.recallOnExpectedFacts, 0.5)
  assert.equal(stats.unknownRetrieved, 1)
  assert.equal(evidenceDetectionStatistics([]).precisionOnAnnotatedFacts, null)
  assert.throws(() => evidenceDetectionStatistics([{
    id: 'case-1', expectedSupportingFacts: ['a'], knownNonSupportingFacts: ['a'], retrievedFacts: [],
  }]), /disjoint/)
})

test('paired bootstrap groups shared family items and remains seeded and order-invariant', () => {
  const pairs = [
    { id: 'a1', familyId: 'a', baseline: 2, candidate: 1 },
    { id: 'a2', familyId: 'a', baseline: 3, candidate: 2 },
    { id: 'b1', familyId: 'b', baseline: 1, candidate: 2 },
  ]
  const result = pairedFamilyBootstrap(pairs, { seed: 'fixed', repetitions: 1000 })
  assert.equal(result.familyMeanDifference, 0)
  assert.equal(result.families, 2)
  assert.equal(result.items, 3)
  assert.deepEqual(pairedFamilyBootstrap([...pairs].reverse(), { seed: 'fixed', repetitions: 1000 }), result)
  assert.ok(result.lower95 <= 0 && result.upper95 >= 0)
  assert.throws(() => pairedFamilyBootstrap(pairs.slice(0, 2), { seed: 'fixed', repetitions: 1000 }), /two independent/)
  assert.throws(() => pairedFamilyBootstrap(pairs, { seed: 'fixed', repetitions: 2 }), /resamples/)
})

test('fixed judge metrics distinguish missed defects, false corrections and failed reviews with symmetric defect strata', () => {
  const trials = [
    { id: 'valid-rejected', expectedIssue: 'none', result: { status: 'complete', issueFound: true } },
    { id: 'valid-supported', expectedIssue: 'none', result: { status: 'complete', issueFound: false } },
    { id: 'over-credit', expectedIssue: 'over-credit', result: { status: 'complete', issueFound: true } },
    { id: 'under-credit', expectedIssue: 'under-credit', result: { status: 'complete', issueFound: false } },
    { id: 'failed', expectedIssue: 'unsupported-fact', result: { status: 'failed', code: 'model-outage' } },
  ].map(row => ({ ...row, familyId: 'family-one' }))
  const report = fixedJudgeStatistics(trials)
  assert.equal(report.all.expected, 5)
  assert.equal(report.all.completed, 4)
  assert.equal(report.all.failed, 1)
  assert.equal(report.all.precision, 0.5)
  assert.equal(report.all.recallOnCompleted, 0.5)
  assert.equal(report.all.falseCorrectionRateOnCompletedValid, 0.5)
  assert.equal(report.byExpectedIssue['under-credit'].falseNegative, 1)
  assert.equal(report.byExpectedIssue['over-credit'].truePositive, 1)
  assert.equal(report.byExpectedIssue['unsupported-fact'].recallOnCompleted, null)
  assert.equal(report.failures[0].result.code, 'model-outage')
  assert.throws(() => fixedJudgeStatistics([...trials, trials[0]]), /unique/)
})
