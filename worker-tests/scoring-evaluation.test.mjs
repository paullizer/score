import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const {
  scoringSuiteSchema, scoringObservationSchema, validateReferenceSet, evaluationHash, validateObservations,
  ordinalRepeatStatistics, summarizeScoringSuite, estimateModelUsdMicros, summarizeCosts,
  advanceCostMilestones, acknowledgeCostMilestones, executeScoringSuite,
} = await loadWorker('../worker/evals/index.ts')

function suite(change = {}) {
  return scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'frozen-suite', purpose: 'stability', sourceVersion: 'corpus-v1', repetitions: 6,
    configurations: [{ id: 'baseline', settingsSha256: 'a'.repeat(64), algorithmVersion: 'production-v1' }],
    cases: [{
      id: 'case-1', familyId: 'resume-1', jobId: 'gs-13', split: 'development',
      inputSha256: 'b'.repeat(64), criterionIds: ['criterion-1'],
    }],
    ...change,
  })
}

function observation(plan, repetition, score = 0, overrides = {}) {
  return {
    schemaVersion: 1, suiteSha256: evaluationHash(plan), caseId: 'case-1', configurationId: 'baseline',
    repetition, durationMilliseconds: 20,
    result: { status: 'complete', overall: score === null ? null : score * 20, criteria: [{ criterionId: 'criterion-1', score }] },
    ...overrides,
  }
}

function reference(plan, origin, score, overrides = {}) {
  return {
    schemaVersion: 1, id: origin, caseId: 'case-1', criterionId: 'criterion-1',
    inputSha256: plan.cases[0].inputSha256, origin, author: 'reviewer-1', independent: true, score,
    reason: 'Evidence supports the stated saved anchor.', evidenceFactIds: [], inclusionProbability: null,
    ...overrides,
  }
}

function entry(id, amountUsdMicros, overrides = {}) {
  return {
    schemaVersion: 1, id, costItemId: id, suiteId: 'suite-1', category: 'inference', mode: 'estimate',
    amountUsdMicros, priceVersion: 'rates-v1', usage: null, ...overrides,
  }
}

test('suite contracts reject family leakage, duplicate cases and invalid repeat counts', () => {
  const plan = suite()
  assert.throws(() => suite({ repetitions: 3 }), /six repetitions/)
  assert.throws(() => suite({ cases: [...plan.cases, plan.cases[0]] }), /unique/)
  assert.throws(() => suite({
    cases: [...plan.cases, { ...plan.cases[0], id: 'case-2', split: 'holdout' }],
  }), /cross dataset splits/)
  assert.throws(() => scoringSuiteSchema.parse({ ...plan, untrustedSetting: true }), /Unrecognized/)
})

test('pairwise ordinal disagreement is not any-change across repeats', () => {
  const stats = ordinalRepeatStatistics([2, 2, 2, 2, 2, 3])
  assert.equal(stats.pairs, 15)
  assert.equal(stats.disagreements, 5)
  assert.equal(stats.pairwiseDisagreement, 1 / 3)
  assert.equal(stats.anyChange, true)
  assert.equal(stats.pairwiseGreaterThanOne, 0)
  const ordinal = ordinalRepeatStatistics([0, 1, 2, 2, 2, 2])
  assert.equal(ordinal.disagreements, 9)
  assert.equal(ordinal.greaterThanOne, 4)
})

test('zero scores remain scores; null and absent repetitions never become zero', () => {
  assert.equal(ordinalRepeatStatistics([0, 0, null]).pairwiseDisagreement, 0)
  assert.equal(ordinalRepeatStatistics([null, null]).pairwiseDisagreement, null)
  assert.equal(ordinalRepeatStatistics([4]).anyChange, null)
  assert.throws(() => ordinalRepeatStatistics([0.5]), /integer anchors/)
  const plan = suite()
  const rows = [
    observation(plan, 1, 0), observation(plan, 2, null),
    observation(plan, 3, 0, { result: { status: 'failed', code: 'service-unavailable' } }),
  ]
  const report = summarizeScoringSuite(plan, rows).reports[0]
  assert.equal(report.complete, 2)
  assert.equal(report.failed, 1)
  assert.equal(report.missing, 3)
  assert.equal(report.completionRate, 2 / 6)
  assert.equal(report.items[0].scoredRepetitions, 1)
  assert.equal(report.items[0].missingRepetitions, 5)
  assert.equal(report.pairwiseDisagreement, null)
})

test('observations bind exact suite, configuration, repetition and full criterion coverage', () => {
  const plan = suite()
  const row = observation(plan, 1)
  assert.throws(() => validateObservations(plan, [row, row]), /Duplicate observation/)
  assert.throws(() => validateObservations(plan, [{ ...row, suiteSha256: 'c'.repeat(64) }]), /frozen suite/)
  assert.throws(() => validateObservations(plan, [{ ...row, repetition: 7 }]), /frozen suite/)
  assert.throws(() => validateObservations(plan, [{
    ...row, result: { ...row.result, criteria: [{ criterionId: 'unknown-criterion', score: 1 }] },
  }]), /exact saved criterion/)
  assert.throws(() => validateObservations(plan, [{
    ...row, result: { ...row.result, criteria: [...row.result.criteria, ...row.result.criteria] },
  }]), /exact saved criterion/)
  assert.throws(() => scoringObservationSchema.parse({
    ...row, result: { status: 'failed', code: 'failure', overall: 0 },
  }), /Unrecognized/)
})

test('explicit saved exclusions remain null without masquerading as missing scored repetitions', () => {
  const base = suite()
  const plan = suite({ cases: [{ ...base.cases[0], criterionIds: ['criterion-1', 'excluded'], excludedCriterionIds: ['excluded'] }] })
  const observations = Array.from({ length: 6 }, (_, index) => {
    const row = observation(plan, index + 1, 2)
    row.result.criteria.push({ criterionId: 'excluded', score: null })
    return row
  })
  const report = summarizeScoringSuite(plan, observations).reports[0]
  assert.equal(report.excludedItems, 1)
  assert.equal(report.incompleteItems, 0)
  assert.equal(report.pairwiseDisagreement, 0)
  assert.throws(() => validateObservations(plan, [{
    ...observations[0], result: { ...observations[0].result, criteria: [
      { criterionId: 'criterion-1', score: 2 }, { criterionId: 'excluded', score: 0 },
    ] },
  }]), /remain unscored/)
  assert.throws(() => validateReferenceSet(plan, [reference(plan, 'human-reviewed', 1, { criterionId: 'excluded' })]), /exclusions/)
  assert.throws(() => suite({ cases: [{ ...base.cases[0], excludedCriterionIds: ['unknown'] }] }), /exact case/)
  assert.equal(Object.hasOwn(base.cases[0], 'excludedCriterionIds'), false)
})

test('reference provenance stays separate and strict; stale reference hashes fail', () => {
  const plan = suite()
  const rows = Array.from({ length: 6 }, (_, i) => observation(plan, i + 1, 0))
  const labels = [reference(plan, 'human-reviewed', 0), reference(plan, 'model-assisted', 3)]
  const report = summarizeScoringSuite(plan, rows, labels)
  assert.equal(report.eligibleForRelease, false)
  const references = report.reports[0].references
  assert.equal(references.find(row => row.origin === 'human-reviewed').meanAbsoluteError, 0)
  assert.equal(references.find(row => row.origin === 'model-assisted').meanAbsoluteError, 3)
  assert.equal(references.find(row => row.origin === 'human-reviewed').scoredItems, 1)
  assert.throws(() => validateReferenceSet(plan, [{
    ...labels[0], inputSha256: 'c'.repeat(64),
  }]), /exact frozen case/)
  assert.throws(() => validateReferenceSet(plan, [labels[0], { ...labels[0], id: 'second-review' }]), /one effective reference/)
})

test('ordinal reference quality uses equal item weight and distinguishes perfect, reversed and degenerate agreement', () => {
  const base = suite()
  const plan = suite({ cases: [base.cases[0], { ...base.cases[0], id: 'case-2', familyId: 'resume-2' }] })
  const labels = [
    reference(plan, 'human-reviewed', 0),
    reference(plan, 'human-reviewed', 5, { id: 'human-second', caseId: 'case-2' }),
  ]
  const rows = Array.from({ length: 6 }, (_, index) => observation(plan, index + 1, 0))
  rows.push(observation(plan, 1, 5, { caseId: 'case-2' }))
  const quality = summarizeScoringSuite(plan, rows, labels).reports[0].references.find(row => row.origin === 'human-reviewed')
  assert.equal(quality.exactAgreement, 1)
  assert.equal(quality.withinOneAgreement, 1)
  assert.equal(quality.quadraticWeightedKappa, 1)
  const reversed = rows.map(row => ({
    ...row, result: { ...row.result, overall: 100 - row.result.overall,
      criteria: row.result.criteria.map(criterion => ({ ...criterion, score: 5 - criterion.score })) },
  }))
  const reversedQuality = summarizeScoringSuite(plan, reversed, labels).reports[0].references.find(row => row.origin === 'human-reviewed')
  assert.equal(reversedQuality.exactAgreement, 0)
  assert.equal(reversedQuality.quadraticWeightedKappa, -1)
  const degenerate = summarizeScoringSuite(base, [observation(base, 1, 0)], [reference(base, 'human-reviewed', 0)])
    .reports[0].references.find(row => row.origin === 'human-reviewed')
  assert.equal(degenerate.exactAgreement, 1)
  assert.equal(degenerate.quadraticWeightedKappa, null)
})

test('development and holdout reports retain isolated reference denominators', () => {
  const initial = suite()
  const plan = suite({ cases: [
    ...initial.cases, { ...initial.cases[0], id: 'case-2', familyId: 'resume-2', split: 'holdout' },
  ] })
  const rows = [
    observation(plan, 1, 2),
    { ...observation(plan, 1, 4), caseId: 'case-2' },
  ]
  const labels = [
    reference(plan, 'human-reviewed', 2),
    reference(plan, 'human-reviewed', 0, { id: 'holdout-label', caseId: 'case-2' }),
  ]
  const report = summarizeScoringSuite(plan, rows, labels)
  const dev = report.reports.find(row => row.split === 'development')
  const holdout = report.reports.find(row => row.split === 'holdout')
  assert.equal(dev.references[0].meanAbsoluteError, 0)
  assert.equal(holdout.references[0].meanAbsoluteError, 4)
  assert.equal(report.reports.find(row => row.split === 'calibration').completionRate, null)
})

test('model costs charge cached input separately and include reasoning only once', () => {
  const prices = { version: 'rates-v1', currency: 'USD', inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 8 }
  assert.equal(estimateModelUsdMicros({
    inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 0, outputTokens: 500, reasoningTokens: 450,
  }, prices), 5400)
  assert.equal(estimateModelUsdMicros(null, prices), null)
  assert.throws(() => estimateModelUsdMicros({
    inputTokens: 2, cachedInputTokens: 3, outputTokens: 1, reasoningTokens: 0,
  }, prices), /included/)
  assert.throws(() => estimateModelUsdMicros({
    inputTokens: 2, cachedInputTokens: 1, outputTokens: 1, reasoningTokens: 2,
  }, prices), /included/)
  assert.throws(() => estimateModelUsdMicros(null, { ...prices, currency: 'EUR' }))
  assert.equal(estimateModelUsdMicros({
    inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 200, outputTokens: 500, reasoningTokens: null,
  }, { ...prices, cacheWriteUsdPerMillion: 2.5 }), 5500)
  assert.equal(estimateModelUsdMicros({
    inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 200, outputTokens: 500, reasoningTokens: null,
  }, prices), null)
  assert.equal(estimateModelUsdMicros({
    inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: null, outputTokens: 500, reasoningTokens: null,
  }, prices), null)
  assert.equal(estimateModelUsdMicros({
    inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500, reasoningTokens: null,
  }, prices), null)
  assert.throws(() => estimateModelUsdMicros({
    inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 601, outputTokens: 500, reasoningTokens: null,
  }, { ...prices, cacheWriteUsdPerMillion: 2.5 }), /included/)
  const inputIncluded = { ...prices, cacheWriteBilling: 'included-in-input' }
  assert.equal(estimateModelUsdMicros({
    inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: null, outputTokens: 500, reasoningTokens: null,
  }, inputIncluded), 5400)
  assert.equal(estimateModelUsdMicros({
    inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 200, outputTokens: 500, reasoningTokens: null,
  }, inputIncluded), 5400)
  assert.throws(() => estimateModelUsdMicros(null, {
    ...inputIncluded, cacheWriteUsdPerMillion: 2.5,
  }), /different separate write tariff/)
})

test('actual settlements replace estimates without double counting or changing attribution', () => {
  const estimate = entry('estimated-call', 120_000_000, { costItemId: 'call-1' })
  const actual = entry('billed-call', 100_000_000, { costItemId: 'call-1', mode: 'actual' })
  const summary = summarizeCosts([estimate, actual, entry('missing-usage', null), entry('cpu', 15_000_000, { category: 'compute' })])
  assert.equal(summary.totalUsdMicros, 115_000_000)
  assert.equal(summary.actualUsdMicros, 100_000_000)
  assert.equal(summary.unbilledEstimateUsdMicros, 15_000_000)
  assert.equal(summary.unknownCostItems, 1)
  assert.throws(() => summarizeCosts([estimate, { ...estimate, id: 'second-estimate' }]), /Duplicate estimate/)
  assert.throws(() => summarizeCosts([estimate, { ...actual, suiteId: 'another-suite' }]), /attribution/)
  assert.equal(summarizeCosts([estimate, { ...actual, amountUsdMicros: null }]).unknownCostItems, 1)
})

test('$100 milestone outbox survives recalculation, large batches and billing reconciliation', () => {
  const initial = { schemaVersion: 1, programId: 'score-quality', reportedThroughUsdMicros: 0, pending: [] }
  const costs = [entry('batch', 350_000_000)]
  const advanced = advanceCostMilestones(initial, costs)
  assert.deepEqual(advanced.state.pending.map(row => row.thresholdUsdMicros), [100_000_000, 200_000_000, 300_000_000])
  assert.deepEqual(advanceCostMilestones(advanced.state, costs).state, advanced.state)
  const delivered = { ...advanced.state, pending: [] }
  assert.equal(advanceCostMilestones(delivered, [entry('batch', 150_000_000)]).state.pending.length, 0)
  assert.equal(advanceCostMilestones(delivered, [entry('batch', 450_000_000)]).state.pending.length, 1)
  const largeLifetime = { ...initial, reportedThroughUsdMicros: 1_000_000_000_000 }
  assert.equal(advanceCostMilestones(largeLifetime, [entry('lifetime', 1_000_100_000_000)]).state.pending.length, 1)
  assert.throws(() => advanceCostMilestones({
    ...initial, reportedThroughUsdMicros: 100_000_000,
    pending: [{ id: 'not-the-receipt-id', thresholdUsdMicros: 100_000_000 }],
  }, []), /inconsistent/)
})

test('delivery acknowledgments preserve high-water mark and require exact archived receipts for idempotent replay', () => {
  const initial = { schemaVersion: 1, programId: 'score-quality', reportedThroughUsdMicros: 0, pending: [] }
  const generated = advanceCostMilestones(initial, [entry('batch', 350_000_000)]).state
  const receipt = {
    schemaVersion: 1, programId: 'score-quality', deliveredAt: '2026-10-07T12:00:00Z',
    channel: 'copilot-session', deliveryReference: 'session-message-1',
    milestones: [generated.pending[0], generated.pending[2]],
  }
  const acknowledged = acknowledgeCostMilestones(generated, receipt)
  assert.equal(acknowledged.state.reportedThroughUsdMicros, 300_000_000)
  assert.deepEqual(acknowledged.state.pending, [generated.pending[1]])
  assert.deepEqual(acknowledgeCostMilestones(acknowledged.state, receipt, receipt), acknowledged)
  assert.throws(() => acknowledgeCostMilestones(acknowledged.state, receipt), /generated pending/)
  assert.throws(() => acknowledgeCostMilestones(generated, {
    ...receipt, programId: 'another-program', milestones: [{ id: 'another-program-100000000', thresholdUsdMicros: 100_000_000 }],
  }), /program/)
  assert.throws(() => acknowledgeCostMilestones(generated, receipt, { ...receipt, deliveryReference: 'changed-message' }), /archived/)
  assert.throws(() => acknowledgeCostMilestones(generated, {
    ...receipt, milestones: [{ id: 'score-quality-400000000', thresholdUsdMicros: 400_000_000 }],
  }), /generated pending/)
  assert.throws(() => acknowledgeCostMilestones(generated, {
    ...receipt, milestones: [receipt.milestones[0], receipt.milestones[0]],
  }), /duplicate/)
  assert.throws(() => acknowledgeCostMilestones(generated, {
    ...receipt, milestones: [{ id: 'score-quality-100000000', thresholdUsdMicros: 200_000_000 }],
  }), /identities/)
  assert.throws(() => acknowledgeCostMilestones(generated, { ...receipt, milestones: [] }))
  assert.throws(() => acknowledgeCostMilestones(generated, { ...receipt, deliveryReference: ' ' }))
  assert.deepEqual(generated.pending.map(row => row.thresholdUsdMicros), [100_000_000, 200_000_000, 300_000_000])
  assert.equal(advanceCostMilestones(acknowledged.state, [entry('batch', 350_000_000)]).state.pending.length, 1)
  assert.deepEqual(advanceCostMilestones(acknowledged.state, [entry('batch', 450_000_000)]).state.pending
    .map(row => row.thresholdUsdMicros), [200_000_000, 400_000_000])
})

test('executor checkpoints each repetition, respects concurrency and resumes the exact saved prefix', async () => {
  const plan = suite()
  let active = 0, maximum = 0, calls = 0
  const saved = [observation(plan, 1, 0)]
  const rows = await executeScoringSuite(plan, {
    concurrency: 2, priorObservations: saved,
    execute: async job => {
      active++; maximum = Math.max(maximum, active); calls++
      await new Promise(resolve => setImmediate(resolve))
      active--
      return observation(plan, job.repetition, 1).result
    },
    checkpoint: async row => { saved.push(row) },
  })
  assert.equal(calls, 5)
  assert.equal(maximum, 2)
  assert.equal(rows.length, 6)
  assert.equal(saved.length, 6)
  await executeScoringSuite(plan, {
    concurrency: 2, priorObservations: saved,
    execute: async () => { throw new Error('Completed repetitions must not be rebought.') },
    checkpoint: async () => { throw new Error('Completed repetitions must not be rewritten.') },
  })
})

test('executor propagates cancellation and checkpoint failures without claiming completion', async () => {
  const plan = suite()
  const controller = new AbortController()
  controller.abort()
  let called = false
  await assert.rejects(executeScoringSuite(plan, {
    concurrency: 1, signal: controller.signal,
    execute: async () => { called = true; return observation(plan, 1).result },
    checkpoint: async () => {},
  }), /abort/i)
  assert.equal(called, false)
  await assert.rejects(executeScoringSuite(plan, {
    concurrency: 1,
    execute: async () => observation(plan, 1).result,
    checkpoint: async () => { throw new Error('Disk full') },
  }), /Disk full/)
})

test('executor drains in-flight work after a failure and starts no later jobs', async () => {
  const plan = suite()
  let calls = 0, drained = false
  await assert.rejects(executeScoringSuite(plan, {
    concurrency: 2,
    execute: async () => {
      const call = ++calls
      await new Promise(resolve => setImmediate(resolve))
      if (call === 1) throw new Error('Transport failed')
      drained = true
      return observation(plan, 1).result
    },
    checkpoint: async () => {},
  }), /Transport failed/)
  assert.equal(calls, 2)
  assert.equal(drained, true)
})
