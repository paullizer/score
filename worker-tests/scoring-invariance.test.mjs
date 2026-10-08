import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
const { scoringSuiteSchema, evaluationHash, summarizePairedInvariance, prepareResumeJobEvaluation } = await loadWorker('../worker/evals/index.ts')

function fixture() {
  const rubric = {
    id: 'rubric-one', groupId: 'rubric-one', jobId: 'job-one', kind: 'job', dataKind: 'real',
    name: 'Statistics', description: 'Applied statistics.', version: 1, createdAt: '2026-10-07T00:00:00Z',
    criteria: [{
      id: 'criterion-one', key: 'custom', label: 'Statistics', description: 'Applied statistics.',
      weight: 100, requirementType: 'required', guidance: '0: Not documented. 1: Coursework. 2: Applied work.',
      sourceCitations: [{ documentId: 'job-source', documentVersion: 1, paragraphId: 'job-p1', page: 1, heading: 'Work', quote: 'Applied statistics.' }],
    }],
  }
  const inputs = ['original', 'variant'].map(id => ({
    id, input: prepareResumeJobEvaluation(`${id === 'original' ? 'Morgan' : 'Avery'} Example\n\nApplied regression to survey data.`, id, rubric),
  }))
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'invariance', purpose: 'screening', sourceVersion: 'fixture-v1', repetitions: 2,
    configurations: [{ id: 'baseline', settingsSha256: 'a'.repeat(64), algorithmVersion: 'fixture-v1' }],
    cases: ['original', 'variant'].map(id => ({
      id, familyId: 'family-one', jobId: 'job-one', split: 'development',
      inputSha256: evaluationHash(inputs.find(row => row.id === id).input), criterionIds: ['criterion-one'],
    })),
  })
  const observations = [[0, 1], [1, 2]].flatMap((scores, index) => scores.map((score, repetition) => ({
    schemaVersion: 1, suiteSha256: evaluationHash(suite), caseId: suite.cases[index].id,
    configurationId: 'baseline', repetition: repetition + 1, durationMilliseconds: 1,
    result: { status: 'complete', overall: score * 20, criteria: [{ criterionId: 'criterion-one', score }] },
  })))
  const pairs = [{ id: 'identity-pair', baselineCaseId: 'original', variantCaseId: 'variant', kind: 'identity-only' }]
  return { suite, observations, pairs, inputs }
}

test('paired invariance distinguishes systematic shifts from unchanged-input noise and keeps zero scores', () => {
  const { suite, observations, pairs, inputs } = fixture()
  const report = summarizePairedInvariance(suite, observations, pairs, inputs)
  const criterion = report.items[0].criteria[0]
  assert.equal(report.completePanels, 1)
  assert.equal(criterion.baselineScored, 2)
  assert.equal(criterion.crossInput.pairs, 4)
  assert.equal(criterion.crossInput.signedDelta, 1)
  assert.equal(criterion.crossInput.disagreement, 0.75)
  assert.equal(criterion.crossInput.greaterThanOne, 0.25)
  assert.equal(criterion.unchangedBaseline.pairs, 1)
  assert.equal(criterion.unchangedBaseline.meanAbsoluteDelta, 1)
  assert.equal(criterion.unchangedBaseline.greaterThanOne, 0)
  const disagreement = report.noiseFloor[0].metrics.find(row => row.metric === 'disagreement')
  assert.equal(disagreement.familyMeanCrossInput, 0.75)
  assert.equal(disagreement.familyMeanUnchangedNoise, 1)
  assert.equal(disagreement.familyMeanExcess, -0.25)
  assert.equal(disagreement.uncertainty, null)
  assert.equal(disagreement.uncertaintyUnavailable, 'fewer-than-two-complete-families')
  assert.equal(report.eligibleForRelease, false)
  assert.deepEqual(summarizePairedInvariance(suite, [...observations].reverse(), pairs, inputs), report)
})

test('missing, failed and null perturbation scores cannot become evidence of stable zero scoring', () => {
  const { suite, observations, pairs, inputs } = fixture()
  observations[0].result.criteria[0].score = null
  observations[2].result = { status: 'failed', code: 'grounding-failed' }
  observations.pop()
  const report = summarizePairedInvariance(suite, observations, pairs, inputs)
  const panel = report.items[0], criterion = panel.criteria[0]
  assert.equal(report.completePanels, 0)
  assert.equal(panel.variantFailed, 1)
  assert.equal(panel.variantMissing, 1)
  assert.equal(criterion.missingBaseline, 1)
  assert.equal(criterion.missingVariant, 2)
  assert.equal(criterion.crossInput.signedDelta, null)
  assert.equal(criterion.unchangedBaseline.meanAbsoluteDelta, null)
  assert.equal(report.noiseFloor[0].completeCriterionItems, 0)
  assert.equal(report.noiseFloor[0].incompleteCriterionItems, 1)
  assert.equal(report.noiseFloor[0].metrics[0].familyMeanExcess, null)
})

function clusteredFixture() {
  const base = fixture(), cases = [], inputs = [], pairs = [], observations = []
  const configurations = [
    base.suite.configurations[0],
    { ...base.suite.configurations[0], id: 'candidate', settingsSha256: 'b'.repeat(64) },
  ]
  for (let index = 0; index < 4; index++) {
    const familyId = index < 3 ? 'family-one' : 'family-two'
    const ids = [`original-${index}`, `variant-${index}`]
    for (const [side, id] of ids.entries()) {
      const input = structuredClone(base.inputs[side].input)
      cases.push({ ...base.suite.cases[side], id, familyId })
      inputs.push({ id, input })
      for (const configuration of configurations) {
        const scores = configuration.id === 'candidate' ? [0, 0] :
          index < 3 ? side === 0 ? [0, 1] : [1, 2] : side === 0 ? [0, 0] : [2, 2]
        scores.forEach((score, repetition) => observations.push({
          ...base.observations[0], caseId: id, configurationId: configuration.id, repetition: repetition + 1,
          result: { status: 'complete', overall: score * 20, criteria: [{ criterionId: 'criterion-one', score }] },
        }))
      }
    }
    pairs.push({ ...base.pairs[0], id: `pair-${index}`, baselineCaseId: ids[0], variantCaseId: ids[1] })
  }
  const suite = scoringSuiteSchema.parse({ ...base.suite, cases, configurations })
  observations.forEach(row => { row.suiteSha256 = evaluationHash(suite) })
  return { suite, inputs, pairs, observations }
}

test('noise-floor summaries weight families equally and compare configurations on identical complete criterion pairs', () => {
  const data = clusteredFixture()
  const report = summarizePairedInvariance(data.suite, data.observations, data.pairs, data.inputs)
  const baseline = report.noiseFloor.find(row => row.configurationId === 'baseline')
  assert.equal(baseline.completeFamilies, 2)
  assert.equal(baseline.completeCriterionItems, 4)
  const metric = baseline.metrics.find(row => row.metric === 'disagreement')
  assert.equal(metric.familyMeanCrossInput, 0.875)
  assert.equal(metric.familyMeanUnchangedNoise, 0.5)
  assert.equal(metric.familyMeanExcess, 0.375)
  assert.equal(metric.uncertainty.familyMeanDifference, 0.375)
  assert.equal(metric.uncertainty.families, 2)
  assert.equal(metric.uncertainty.resamples, 1000)
  assert.equal(metric.uncertainty.lower95, -0.25)
  assert.equal(metric.uncertainty.upper95, 1)
  const comparison = report.configurationComparisons[0]
  assert.equal(comparison.matchedCompleteCriterionItems, 4)
  assert.equal(comparison.unmatchedCriterionItems, 0)
  assert.equal(comparison.matchedFamilies, 2)
  const changed = comparison.metrics.find(row => row.metric === 'disagreement')
  assert.equal(changed.familyMeanBaseline, 0.375)
  assert.equal(changed.familyMeanCandidate, 0)
  assert.equal(changed.familyMeanDifference, -0.375)
  assert.equal(changed.uncertainty.familyMeanDifference, -0.375)
  assert.deepEqual(summarizePairedInvariance(data.suite, [...data.observations].reverse(), data.pairs, data.inputs), report)
  data.observations.find(row => row.caseId === 'variant-3' && row.configurationId === 'candidate').result =
    { status: 'failed', code: 'timeout' }
  const incomplete = summarizePairedInvariance(data.suite, data.observations, data.pairs, data.inputs)
  const matched = incomplete.configurationComparisons[0]
  assert.equal(matched.matchedCompleteCriterionItems, 3)
  assert.equal(matched.unmatchedCriterionItems, 1)
  assert.equal(matched.matchedFamilies, 1)
  assert.equal(matched.metrics[0].uncertainty, null)
  assert.equal(matched.metrics[0].familyMeanDifference, 0.25)
  assert.equal(incomplete.noiseFloor.find(row => row.configurationId === 'baseline').completeFamilies, 2)
  assert.equal(incomplete.noiseFloor.find(row => row.configurationId === 'candidate').incompleteCriterionItems, 1)
})

test('perturbation report rejects duplicated pairs, mismatched families and observations, and a missing noise floor', () => {
  const { suite, observations, pairs, inputs } = fixture()
  assert.throws(() => summarizePairedInvariance(suite, observations, [...pairs, pairs[0]], inputs), /unique/)
  assert.throws(() => summarizePairedInvariance(suite, [], [{ ...pairs[0], variantCaseId: 'missing' }], inputs), /distinct exact/)
  suite.cases[1].familyId = 'other-family'
  assert.throws(() => summarizePairedInvariance(suite, [], pairs, inputs), /one family/)
  suite.cases[1].familyId = 'family-one'
  assert.throws(() => summarizePairedInvariance(suite, [observations[0], observations[0]], pairs, inputs), /Duplicate observation/)
  suite.repetitions = 1
  assert.throws(() => summarizePairedInvariance(suite, [], pairs, inputs), /noise floor/)
})

test('same criterion IDs do not permit rubric drift, stale sources or missing paired inputs', () => {
  const { suite, pairs, inputs } = fixture()
  assert.throws(() => summarizePairedInvariance(suite, [], pairs, inputs.slice(0, 1)), /Both exact frozen/)
  inputs[1].input.rubric.criteria[0].guidance = '0: Not documented. 1: New stricter requirement.'
  assert.throws(() => summarizePairedInvariance(suite, [], pairs, inputs), /exact saved case/)
  suite.cases[1].inputSha256 = evaluationHash(inputs[1].input)
  assert.throws(() => summarizePairedInvariance(suite, [], pairs, inputs), /cannot change saved rubric/)
})
