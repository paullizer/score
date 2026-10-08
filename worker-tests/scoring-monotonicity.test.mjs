import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { summarizeEvidenceMonotonicity, prepareResumeJobEvaluation, scoringSuiteSchema, evaluationHash } =
  await loadWorker('../worker/evals/index.ts')

function fixture() {
  const rubric = {
    id: 'rubric', groupId: 'rubric', jobId: 'job', kind: 'job', dataKind: 'real',
    name: 'Statistics', description: 'Applied statistics.', version: 1, createdAt: '2026-10-07T00:00:00Z',
    criteria: ['statistics', 'reporting'].map(id => ({
      id, key: 'custom', label: id, description: 'Documented statistical work.',
      weight: 50, requirementType: 'required', guidance: '0: Not documented. 1: Coursework. 2: Applied work.',
      sourceCitations: [{ documentId: 'job-source', documentVersion: 1, paragraphId: 'job-p1', page: 1,
        heading: 'Work', quote: 'Documented statistical work.' }],
    })),
  }
  const fact = 'Applied regression to survey data and documented variance estimates.'
  const input = prepareResumeJobEvaluation('# Simulated profile\n\nOrganized a community garden.', 'family', rubric)
  input.resume.paragraphs.push({ ...input.resume.paragraphs.at(-1), id: 'second-retained', text: 'Edited a gardening newsletter.' })
  const stronger = structuredClone(input)
  stronger.resume.paragraphs.push({
    ...input.resume.paragraphs.at(-1), id: 'added-evidence', text: fact,
  })
  const inputs = [{ id: 'weaker', input }, { id: 'stronger', input: stronger }]
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'monotonicity', purpose: 'screening', sourceVersion: 'fixtures', repetitions: 2,
    configurations: [{ id: 'baseline', settingsSha256: 'a'.repeat(64), algorithmVersion: 'fixture' }],
    cases: inputs.map(row => ({
      id: row.id, familyId: 'family', jobId: 'job', split: 'development', inputSha256: evaluationHash(row.input),
      criterionIds: ['statistics', 'reporting'],
    })),
  })
  const pairs = [{
    id: 'insertion', weakerCaseId: 'weaker', strongerCaseId: 'stronger', expectedCriterionIds: ['statistics'],
    addedFacts: [{ id: 'fact', paragraphId: 'added-evidence', text: fact }],
    origin: 'planted', author: 'fixture', revision: 'v1', independent: true,
    reason: 'The added source paragraph explicitly documents one applied statistical method.',
  }]
  const observations = [[1, 2], [0, 3]].flatMap((scores, caseIndex) => scores.map((score, index) => ({
    schemaVersion: 1, suiteSha256: evaluationHash(suite), caseId: inputs[caseIndex].id,
    configurationId: 'baseline', repetition: index + 1, durationMilliseconds: 1,
    result: { status: 'complete', overall: score * 10,
      criteria: [{ criterionId: 'statistics', score }, { criterionId: 'reporting', score: 0 }] },
  })))
  return { suite, pairs, inputs, observations }
}

test('bound evidence contrasts report directional reversals, unchanged noise and unrelated-criterion spillover without accuracy claims', () => {
  const data = fixture()
  const report = summarizeEvidenceMonotonicity(data.suite, data.observations, data.pairs, data.inputs)
  assert.equal(report.completePanels, 1)
  assert.equal(report.independentCompletePanels, 1)
  const [expected, other] = report.items[0].criteria
  assert.equal(expected.crossPairs, 4)
  assert.equal(expected.meanSignedDelta, 0)
  assert.equal(expected.decreases, 2)
  assert.equal(expected.decreasesGreaterThanOne, 1)
  assert.equal(expected.increases, 2)
  assert.equal(expected.unchanged, 0)
  assert.equal(expected.decreaseRate, 0.5)
  assert.equal(expected.decreaseGreaterThanOneRate, 0.25)
  assert.equal(expected.weakerNoise.pairwiseDisagreement, 1)
  assert.equal(expected.weakerNoise.pairwiseGreaterThanOne, 0)
  assert.equal(expected.strongerNoise.pairwiseGreaterThanOne, 1)
  assert.equal(expected.eligibleForIndependentDiagnostic, true)
  assert.equal(other.expectedSupporting, false)
  assert.equal(other.decreaseRate, 0)
  assert.equal(other.unchanged, 4)
  assert.equal(other.eligibleForIndependentDiagnostic, false)
  assert.equal(report.eligibleForRelease, false)
  assert.deepEqual(summarizeEvidenceMonotonicity(data.suite, [...data.observations].reverse(), data.pairs, data.inputs), report)
  const exposed = summarizeEvidenceMonotonicity(data.suite, data.observations,
    [{ ...data.pairs[0], independent: false }], data.inputs)
  assert.equal(exposed.independentCompletePanels, 0)
  assert.equal(exposed.items[0].criteria[0].eligibleForIndependentDiagnostic, false)
})

test('monotonicity keeps explicit failures, absent reviews and null anchors out of score denominators', () => {
  const data = fixture()
  data.observations[0].result.criteria[0].score = null
  data.observations[2].result = { status: 'failed', code: 'timeout' }
  data.observations.pop()
  const report = summarizeEvidenceMonotonicity(data.suite, data.observations, data.pairs, data.inputs)
  assert.equal(report.completePanels, 0)
  const panel = report.items[0], criterion = panel.criteria[0]
  assert.deepEqual(panel.strongerCoverage, { observed: 1, failed: 1, missing: 1 })
  assert.equal(criterion.crossPairs, 0)
  assert.equal(criterion.decreaseRate, null)
  assert.equal(criterion.meanSignedDelta, null)
  assert.equal(criterion.weakerNoise.missingRepetitions, 1)
  assert.equal(criterion.strongerNoise.missingRepetitions, 2)
  assert.equal(criterion.eligibleForIndependentDiagnostic, false)
})

test('monotonicity rejects changed targets and undeclared source edits even when new hashes are supplied', () => {
  for (const change of ['text', 'heading', 'page', 'order', 'extra', 'target']) {
    const data = fixture(), input = data.inputs[1].input
    if (change === 'text') input.resume.paragraphs[0].text = 'Different retained work.'
    if (change === 'heading') input.resume.paragraphs[0].heading = 'Changed heading'
    if (change === 'page') input.resume.paragraphs[0].page = 2
    if (change === 'order') input.resume.paragraphs.reverse()
    if (change === 'extra') input.resume.paragraphs.push({ ...input.resume.paragraphs.at(-1), id: 'unlisted', text: 'Another new claim.' })
    if (change === 'target') input.rubric.criteria[0].guidance = '0: Not documented. 1: Higher standard.'
    data.suite.cases[1].inputSha256 = evaluationHash(input)
    assert.throws(() => summarizeEvidenceMonotonicity(data.suite, [], data.pairs, data.inputs),
      /frozen scoring target|original paragraph/)
  }
})

test('added facts must identify complete new paragraphs and exact nonexcluded target criteria', () => {
  const data = fixture()
  const report = pairs => summarizeEvidenceMonotonicity(data.suite, [], pairs, data.inputs)
  assert.throws(() => report([{ ...data.pairs[0], addedFacts: [{ ...data.pairs[0].addedFacts[0], text: 'Applied regression' }] }]), /complete newly/)
  assert.throws(() => report([{ ...data.pairs[0], addedFacts: [{ ...data.pairs[0].addedFacts[0], paragraphId: 'absent' }] }]), /complete newly/)
  assert.throws(() => report([{ ...data.pairs[0], expectedCriterionIds: ['unknown'] }]), /scored criteria/)
  assert.throws(() => report([{ ...data.pairs[0], expectedCriterionIds: ['statistics', 'statistics'] }]), /distinct/)
  assert.throws(() => report([data.pairs[0], data.pairs[0]]), /unique/)
  assert.throws(() => report([{ ...data.pairs[0],
    addedFacts: [...data.pairs[0].addedFacts, data.pairs[0].addedFacts[0]] }]), /must be unique/)
  assert.throws(() => summarizeEvidenceMonotonicity(data.suite, [], data.pairs, data.inputs.slice(0, 1)), /distinct exact/)
  const renumbered = structuredClone(data.inputs)
  renumbered[1].input.resume.paragraphs[0].id = 'retained-renumbered'
  data.suite.cases[1].inputSha256 = evaluationHash(renumbered[1].input)
  assert.equal(summarizeEvidenceMonotonicity(data.suite, [], data.pairs, renumbered).completePanels, 0)
  data.suite.repetitions = 1
  assert.throws(() => summarizeEvidenceMonotonicity(data.suite, [], data.pairs, renumbered), /repeated unchanged/)
})

test('monotonicity refuses modified resume metadata, stale sources and out-of-suite observations', () => {
  const data = fixture()
  const source = structuredClone(data.inputs)
  source[1].input.resume.title = 'A new source title'
  assert.throws(() => summarizeEvidenceMonotonicity(data.suite, [], data.pairs, source), /exact saved case/)
  data.suite.cases[1].inputSha256 = evaluationHash(source[1].input)
  assert.throws(() => summarizeEvidenceMonotonicity(data.suite, [], data.pairs, source), /document metadata/)
  const fresh = fixture()
  for (const field of ['suiteSha256', 'caseId', 'configurationId', 'repetition']) {
    const rows = structuredClone(fresh.observations)
    rows[0][field] = field === 'repetition' ? 3 : 'b'.repeat(field === 'suiteSha256' ? 64 : 10)
    assert.throws(() => summarizeEvidenceMonotonicity(fresh.suite, rows, fresh.pairs, fresh.inputs))
  }
  const excluded = fixture()
  excluded.suite.cases.forEach(row => { row.excludedCriterionIds = ['statistics'] })
  assert.throws(() => summarizeEvidenceMonotonicity(excluded.suite, [], excluded.pairs, excluded.inputs),
    /exactly its saved grade exclusions/)
})
