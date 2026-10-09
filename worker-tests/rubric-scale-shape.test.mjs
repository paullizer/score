import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { EVIDENCE_SCALE_VERSION, criterionLevelsSchema, renderEvidenceGuidance, rubricScaleErrors } = await loadWorker('../src/domain/evidence-scale.ts')
const { validateRealRubric, validateStoredRealRubric } = await loadWorker('../server/jobs/validation.ts')
const { prepareResumeJobEvaluation } = await loadWorker('../worker/evals/index.ts')

const jobId = 'job-0b6f3f1e-7a2c-4d5e-9f10-1a2b3c4d5e6f'
const document = {
  id: 'document-0b6f3f1e-7a2c-4d5e-9f10-1a2b3c4d5e70', title: 'Survey Statistician', kind: 'job', version: 1, sample: false,
  paragraphs: [{ id: 'p-0001', page: 1, heading: 'Duties', text: 'Designs sample surveys and selects statistical methods for data collection programs.' }],
}
const levels = [
  'Lists survey sampling in coursework or training.',
  'Describes one survey sample the applicant designed.',
  'Describes designing samples for several surveys or as an ongoing duty.',
  'Describes choosing or adapting sampling methods for large or complex surveys.',
  'Describes leading a sampling redesign with stated precision outcomes.',
].map((examples, index) => ({ level: index + 1, examples }))

function scaledRubric() {
  return {
    id: `rubric-${jobId}`, groupId: `rubric-${jobId}`, kind: 'job', jobId, dataKind: 'real',
    name: 'Survey Statistician rubric', description: 'Survey statistics duties.', version: 1, createdAt: '2026-10-08T00:00:00.000Z',
    provenance: { kind: 'generated', model: 'gpt-5-mini-2025-08-07', promptVersion: 'pr-baseline-jobRubric-v1' },
    scaleVersion: EVIDENCE_SCALE_VERSION,
    criteria: [{
      id: 'criterion-01', key: 'custom', label: 'Survey sampling', description: 'Designs sample surveys.', weight: 100,
      requirementType: 'required', sourceParagraphId: 'p-0001', levels: structuredClone(levels), guidance: renderEvidenceGuidance(levels),
      sourceCitations: [{ documentId: document.id, documentVersion: 1, paragraphId: 'p-0001', page: 1, heading: 'Duties', quote: 'Designs sample surveys' }],
    }],
  }
}

function legacyRubric() {
  const rubric = scaledRubric()
  delete rubric.scaleVersion
  delete rubric.criteria[0].levels
  rubric.criteria[0].guidance = '0: Not documented. 1: Coursework. 2: One example. 3: Recurring work. 4: Complex work. 5: Led the work.'
  return rubric
}

const resume = '# Profile\n\nDesigned stratified samples for three national surveys.'

test('a rubric on the evidence scale passes every job reader and the analysis input boundary', () => {
  const rubric = scaledRubric()
  assert.deepEqual(rubricScaleErrors(rubric), [])
  assert.deepEqual(validateRealRubric(rubric, document, 'application/pdf'), [])
  assert.equal(validateStoredRealRubric(rubric), true)
  const input = prepareResumeJobEvaluation(resume, 'family-1', rubric)
  assert.deepEqual(input.rubric.criteria[0].levels, levels)
  assert.equal(input.rubric.scaleVersion, EVIDENCE_SCALE_VERSION)
  assert.match(input.rubric.criteria[0].guidance, /^0: No relevant evidence\./)
})

test('rubrics created before the scale keep free-text guidance and stay valid everywhere', () => {
  const rubric = legacyRubric()
  assert.deepEqual(rubricScaleErrors(rubric), [])
  assert.deepEqual(validateRealRubric(rubric, document, 'application/pdf'), [])
  assert.equal(validateStoredRealRubric(rubric), true)
  assert.equal(prepareResumeJobEvaluation(resume, 'family-1', rubric).rubric.scaleVersion, undefined)
})

test('level examples and guidance must agree with the named scale in every reader', () => {
  const cases = {
    'levels without a scale version': rubric => { delete rubric.scaleVersion },
    'guidance edited away from its levels': rubric => { rubric.criteria[0].guidance += ' Extra unscaled anchor.' },
    'missing levels on a scaled rubric': rubric => { delete rubric.criteria[0].levels },
    'examples that are not normalized': rubric => {
      rubric.criteria[0].levels[1] = { level: 2, examples: '  Describes one   survey sample the applicant designed. ' }
    },
    'levels out of order': rubric => {
      rubric.criteria[0].levels = [levels[1], levels[0], ...levels.slice(2)]
    },
  }
  for (const [label, mutate] of Object.entries(cases)) {
    const rubric = scaledRubric()
    mutate(rubric)
    assert.ok(rubricScaleErrors(rubric).length, label)
    assert.ok(validateRealRubric(rubric, document, 'application/pdf').length, label)
    assert.equal(validateStoredRealRubric(rubric), false, label)
    assert.throws(() => prepareResumeJobEvaluation(resume, 'family-1', rubric), label)
  }
  const unknown = { ...scaledRubric(), scaleVersion: 'score-evidence-ladder-v9' }
  assert.deepEqual(rubricScaleErrors(unknown), ['Unknown evidence scale version "score-evidence-ladder-v9".'])
  assert.ok(validateRealRubric(unknown, document, 'application/pdf').some(error => error.includes('Unknown evidence scale')))
  assert.equal(validateStoredRealRubric(unknown), false)
  assert.throws(() => prepareResumeJobEvaluation(resume, 'family-1', unknown))
  const extra = scaledRubric()
  extra.criteria[0].scaleNotes = 'unexpected'
  assert.ok(validateRealRubric(extra, document, 'application/pdf').some(error => error.includes('unsupported fields')))
})

test('GS grade gaps and exclusions stay unscored on the scale, while scored rows need level examples', () => {
  const guidance = renderEvidenceGuidance(levels)
  const rubric = {
    scaleVersion: EVIDENCE_SCALE_VERSION,
    criteria: [
      { label: 'Program analysis', support: 'direct', levels, guidance },
      { label: 'Contract award', support: 'not-applicable', guidance: 'Unscored: outside the covered work.' },
      { label: 'Field operations', support: 'gap', guidance: 'Unscored until grading sources are added.' },
    ],
  }
  assert.deepEqual(rubricScaleErrors(rubric), [])
  const withExcludedLevels = structuredClone(rubric)
  withExcludedLevels.criteria[1].levels = levels
  assert.deepEqual(rubricScaleErrors(withExcludedLevels), ['Criterion "Contract award" is unscored, so it can\'t have level examples.'])
  const unscaledDirect = structuredClone(rubric)
  delete unscaledDirect.criteria[0].levels
  assert.ok(rubricScaleErrors(unscaledDirect)[0].startsWith('Criterion "Program analysis":'))
})

test('the persisted level schema accepts exactly levels one to five and rejects unknown keys', () => {
  assert.deepEqual(criterionLevelsSchema.parse(levels), levels)
  assert.throws(() => criterionLevelsSchema.parse(levels.slice(1)))
  assert.throws(() => criterionLevelsSchema.parse([...levels.slice(0, 4), { level: 6, examples: 'Six.' }]))
  assert.throws(() => criterionLevelsSchema.parse([{ ...levels[0], note: 'extra' }, ...levels.slice(1)]))
  assert.throws(() => criterionLevelsSchema.parse([{ ...levels[0], examples: 'x'.repeat(601) }, ...levels.slice(1)]))
})
