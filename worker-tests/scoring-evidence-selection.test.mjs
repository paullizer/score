import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { prepareResumeJobEvaluation, scoringSuiteSchema, evaluationHash, summarizeEvidenceSelections } =
  await loadWorker('../worker/evals/index.ts')
const { validateAnalysisAssessmentSelections, hashAnalysisAssessment } = await loadWorker('../worker/analyses/model.ts')
const { createAnalysisEvidenceCatalog } = await loadWorker('../worker/analyses/evidence-passages.ts')

function fixture() {
  const input = prepareResumeJobEvaluation('Applied regression to survey data.', 'family', {
    id: 'rubric', groupId: 'rubric', jobId: 'job', kind: 'job', dataKind: 'real',
    name: 'Statistics', description: 'Applied statistics.', version: 1, createdAt: '2026-10-07T00:00:00Z',
    criteria: [{
      id: 'statistics', key: 'custom', label: 'Statistics', description: 'Applied statistical work.', weight: 100,
      requirementType: 'required', guidance: '0: Not documented. 1: Coursework. 2: One applied example.',
      sourceCitations: [{ documentId: 'job-source', documentVersion: 1, paragraphId: 'job-p1',
        page: 1, heading: 'Work', quote: 'Applied statistical work.' }],
    }],
  })
  input.resume.paragraphs = [
    'Applied regression to survey data. Organized a community garden.',
    'I did not lead survey design.',
    'Published a gardening newsletter.',
    'Prepared a statistical report.',
    'Used regression in an applied survey project.',
  ].map((text, index) => ({ id: `p${index + 1}`, page: 1, heading: 'Work', text }))
  const assessment = validateAnalysisAssessmentSelections({
    criteria: [{
      criterionId: 'statistics', evidenceStatus: 'supported', score: 2, limitation: null,
      rationale: 'One applied regression example is documented.',
      citations: [{ passageId: 1 }, { passageId: 2 }, { passageId: 3 }],
    }], qualifications: [],
  }, input, createAnalysisEvidenceCatalog(input.resume))
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'evidence-selection', sourceVersion: 'fixtures', purpose: 'screening', repetitions: 2,
    configurations: [{ id: 'baseline', settingsSha256: 'a'.repeat(64), algorithmVersion: 'fixture' }],
    cases: [{ id: 'case', familyId: 'family', jobId: 'job', split: 'development',
      inputSha256: evaluationHash(input), criterionIds: ['statistics'] }],
  })
  const observations = [1, 2].map(repetition => ({
    schemaVersion: 1, suiteSha256: evaluationHash(suite), caseId: 'case', configurationId: 'baseline', repetition,
    durationMilliseconds: 1, result: { status: 'complete', assessmentSha256: hashAnalysisAssessment(assessment),
      overall: 40, criteria: [{ criterionId: 'statistics', score: 2 }] },
  }))
  const artifacts = observations.map(row => ({
    caseId: row.caseId, configurationId: row.configurationId, repetition: row.repetition,
    assessmentSha256: hashAnalysisAssessment(assessment), assessment,
  }))
  const annotations = [{
    caseId: 'case', criterionId: 'statistics', inputSha256: evaluationHash(input),
    origin: 'planted', author: 'fixture', revision: 'v1', independent: true,
    reason: 'Controlled literal source facts with criterion-specific relevance annotations.',
    facts: [
      { id: 'regression', role: 'supporting', alternatives: [
        { paragraphId: 'p1', text: 'Applied regression to survey data.' },
        { paragraphId: 'p5', text: 'Used regression in an applied survey project.' },
      ] },
      { id: 'report', role: 'supporting', alternatives: [{ paragraphId: 'p4', text: 'Prepared a statistical report.' }] },
      { id: 'garden', role: 'non-supporting', alternatives: [{ paragraphId: 'p1', text: 'Organized a community garden.' }] },
      { id: 'limited-role', role: 'contrary', alternatives: [{ paragraphId: 'p2', text: 'I did not lead survey design.' }] },
    ],
  }]
  return { suite, observations, inputs: [{ id: 'case', input }], annotations, artifacts }
}

const report = data => summarizeEvidenceSelections(data.suite, data.observations, data.inputs, data.annotations, data.artifacts)

test('literal final-citation measurement counts fact groups once and separates contrary and unannotated context', () => {
  const data = fixture(), measured = report(data)
  const item = measured.items[0]
  assert.equal(item.status, 'available')
  assert.equal(item.score, 2)
  assert.equal(item.evidenceStatus, 'supported')
  assert.equal(item.bindingStatus, 'assessment-hash-bound')
  assert.deepEqual(item.selectedFactIds, ['regression', 'garden', 'limited-role'])
  assert.equal(item.contraryExpected, 1)
  assert.equal(item.contrarySelected, 1)
  assert.equal(item.unannotatedCitations, 1)
  assert.equal(item.statistics.precisionOnAnnotatedFacts, 0.5)
  assert.equal(item.statistics.recallOnExpectedFacts, 0.5)
  assert.equal(item.statistics.missedSupporting, 1)
  const stratum = measured.reports.find(row => row.expected > 0 && row.repetition === 1)
  assert.equal(stratum.expected, 1)
  assert.equal(stratum.available, 1)
  assert.equal(stratum.hashBoundAssessments, 1)
  assert.equal(stratum.statistics.truePositive, 1)
  assert.equal(stratum.contrarySelected, 1)
  assert.equal(measured.eligibleForRelease, false)
  data.annotations[0].independent = false
  const exposed = report(data).reports.find(row => row.expected > 0)
  assert.equal(exposed.independent, false)
})

test('completed scores without private evidence are missing artifacts, not zero recall; failures and absent observations stay separate', () => {
  const data = fixture()
  data.artifacts = []
  let measured = report(data)
  assert.equal(measured.items[0].status, 'missing-assessment')
  assert.equal(measured.items[0].selectedFactIds, null)
  assert.equal(measured.items[0].statistics, null)
  assert.equal(measured.reports.find(row => row.expected > 0).missingAssessments, 1)
  data.observations[0].result = { status: 'failed', code: 'timeout' }
  data.observations.pop()
  measured = report(data)
  assert.equal(measured.items[0].status, 'processing-failed')
  assert.equal(measured.items[0].failureCode, 'timeout')
  assert.equal(measured.items[1].status, 'missing-observation')
  assert.equal(measured.reports.find(row => row.expected > 0 && row.repetition === 2).missingObservations, 1)
})

test('bound evidence annotations reject stale inputs, wrong paragraphs, unknown criteria and contradictory duplicate spans', () => {
  for (const change of ['hash', 'paragraph', 'text', 'criterion', 'duplicate-span', 'duplicate-label', 'duplicate-input']) {
    const data = fixture()
    if (change === 'hash') data.annotations[0].inputSha256 = 'b'.repeat(64)
    if (change === 'paragraph') data.annotations[0].facts[0].alternatives[0].paragraphId = 'p3'
    if (change === 'text') data.annotations[0].facts[0].alternatives[0].text = 'Invented source fact.'
    if (change === 'criterion') data.annotations[0].criterionId = 'unknown'
    if (change === 'duplicate-span') data.annotations[0].facts[1].alternatives.push(data.annotations[0].facts[0].alternatives[0])
    if (change === 'duplicate-label') data.annotations.push(data.annotations[0])
    if (change === 'duplicate-input') data.inputs.push(data.inputs[0])
    assert.throws(() => report(data), /source-bound|literal text|exact frozen suite/)
  }
})

test('final evidence artifacts must preserve canonical assessment, literal citations and exact observed scores', () => {
  for (const change of ['hash', 'score', 'total', 'quote', 'duplicate', 'failed', 'identity']) {
    const data = fixture()
    if (change === 'hash') data.artifacts[0].assessmentSha256 = 'b'.repeat(64)
    if (change === 'score') data.observations[0].result.criteria[0].score = 3
    if (change === 'total') data.observations[0].result.overall = 41
    if (change === 'quote') data.artifacts[0].assessment.criteria[0].citations[0].quote = 'Invented quote.'
    if (change === 'duplicate') data.artifacts.push(data.artifacts[0])
    if (change === 'failed') data.observations[0].result = { status: 'failed', code: 'timeout' }
    if (change === 'identity') data.artifacts[0].configurationId = 'unknown'
    assert.throws(() => report(data))
  }
})

test('source-present facts not fully quoted remain unmatched without treating rationale prose as selected evidence', () => {
  const data = fixture()
  const assessment = data.artifacts[0].assessment
  assessment.criteria[0].citations[0].quote = 'Applied regression'
  assessment.criteria[0].rationale = 'Applied regression to survey data. Prepared a statistical report.'
  data.artifacts.forEach(row => { row.assessmentSha256 = hashAnalysisAssessment(assessment) })
  data.observations.forEach(row => { row.result.assessmentSha256 = hashAnalysisAssessment(assessment) })
  const item = report(data).items[0]
  assert.equal(item.statistics.truePositive, 0)
  assert.equal(item.statistics.recallOnExpectedFacts, 0)
  assert.equal(item.statistics.falsePositive, 0)
  assert.equal(item.statistics.precisionOnAnnotatedFacts, null)
  assert.equal(item.contrarySelected, 1)
  assert.equal(item.unannotatedCitations, 2)
})

test('available zero and unscored results keep separate numeric dispositions without losing citation evidence', () => {
  const zero = fixture()
  const input = zero.inputs[0].input
  const assessment = validateAnalysisAssessmentSelections({
    criteria: [{
      criterionId: 'statistics', evidenceStatus: 'missing', score: 0, limitation: null,
      rationale: 'No supporting statistical work was selected in this controlled test.', citations: [],
    }], qualifications: [],
  }, input, createAnalysisEvidenceCatalog(input.resume))
  zero.artifacts.forEach(row => {
    row.assessment = assessment
    row.assessmentSha256 = hashAnalysisAssessment(assessment)
  })
  zero.observations.forEach(row => {
    row.result.overall = 0
    row.result.criteria[0].score = 0
    row.result.assessmentSha256 = hashAnalysisAssessment(assessment)
  })
  const zeroItem = report(zero).items[0]
  assert.equal(zeroItem.status, 'available')
  assert.equal(zeroItem.score, 0)
  assert.deepEqual(zeroItem.selectedFactIds, [])
  assert.equal(zeroItem.statistics.recallOnExpectedFacts, 0)
  const unscored = fixture()
  const unscoredAssessment = unscored.artifacts[0].assessment
  unscoredAssessment.criteria[0].score = null
  unscoredAssessment.criteria[0].evidenceStatus = 'not-assessed'
  unscoredAssessment.limitations = [{
    code: 'source-quality', criterionId: 'statistics',
    message: 'The controlled source lacks clear attribution of responsibility.',
  }]
  unscoredAssessment.criteria[0].limitation = unscoredAssessment.limitations[0]
  unscored.artifacts.forEach(row => { row.assessmentSha256 = hashAnalysisAssessment(unscoredAssessment) })
  unscored.observations.forEach(row => {
    row.result.overall = null
    row.result.criteria[0].score = null
    row.result.assessmentSha256 = hashAnalysisAssessment(unscoredAssessment)
  })
  const measured = report(unscored)
  assert.equal(measured.items[0].status, 'available')
  assert.equal(measured.items[0].score, null)
  assert.equal(measured.items[0].statistics.truePositive, 1)
  assert.equal(measured.reports.find(row => row.expected > 0).unscoredCriteria, 1)
})

test('final-assessment hashes detect same-score content replacement and legacy rows remain explicitly score-only', () => {
  const data = fixture()
  data.artifacts[0].assessment.criteria[0].rationale = 'A different explanation with identical numeric scores.'
  data.artifacts.forEach(row => { row.assessmentSha256 = hashAnalysisAssessment(row.assessment) })
  assert.throws(() => report(data), /exact final assessment hash/)
  data.observations.forEach(row => { delete row.result.assessmentSha256 })
  const originalLegacyBytes = JSON.stringify(data.observations)
  const measured = report(data)
  assert.equal(measured.items[0].bindingStatus, 'legacy-score-only')
  assert.equal(measured.reports.find(row => row.expected > 0).hashBoundAssessments, 0)
  assert.equal(measured.reports.find(row => row.expected > 0).legacyScoreOnlyAssessments, 1)
  assert.equal(measured.eligibleForRelease, false)
  assert.equal(JSON.stringify(data.observations), originalLegacyBytes)
})
