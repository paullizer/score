import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const {
  ANALYSIS_EVIDENCE_CATALOG_VERSION, AnalysisEvidenceBindingError,
  createAnalysisEvidenceCatalog, createAnalysisPassageResolver,
} = await loadWorker('../worker/analyses/evidence-passages.ts')
const {
  validateAnalysisAssessmentInput, validateAnalysisAssessmentSelections, validateAnalysisGroundingSelections,
} = await loadWorker('../worker/analyses/validation.ts')
const { ANALYSIS_MODEL_LIMITS, assessmentSelectionSchemaForInput, analysisStructuredSchema } =
  await loadWorker('../worker/analyses/model-schema.ts')
const { analysisCitationRepairSources } = await loadWorker('../worker/analyses/citation-diagnostics.ts')

function fixture(texts = ['Designed  survey samples.\nDocumented the method.', 'Reviewed results and explained limitations.']) {
  const citation = {
    documentId: 'job-source', documentVersion: 2, paragraphId: 'job-p1', page: 1,
    heading: 'Responsibilities', quote: 'Design and review survey methods.',
  }
  return {
    resume: {
      id: 'saved-resume', version: 3, kind: 'resume', sample: false, title: 'Captured resume',
      paragraphs: texts.map((text, index) => ({ id: `p-${index + 1}`, page: index + 1, heading: 'Experience', text })),
    },
    rubric: {
      id: 'saved-rubric', groupId: 'rubric-group', jobId: 'saved-job', kind: 'job', dataKind: 'real',
      name: 'Survey methods', description: 'Assess documented methods.', version: 2, createdAt: '2026-09-18T00:00:00.000Z',
      criteria: [{
        id: 'methods', key: 'custom', label: 'Survey methods', description: citation.quote, weight: 100,
        guidance: '0: Missing evidence. 1: Names methods. 2: Applies methods. 3: Reviews methods. 4: Validates methods. 5: Leads documented validation.',
        sourceCitations: [citation],
      }],
    },
    qualifications: [],
    requirementEvidence: [{ kind: 'criterion', criterionId: 'methods', citations: [citation] }],
  }
}

function assessment(citations) {
  return {
    criteria: [{
      criterionId: 'methods', evidenceStatus: 'partial', score: 3,
      rationale: 'The cited work describes methods and review within the documented scope.',
      citations, limitation: null,
    }],
    qualifications: [],
  }
}

function review(citations) {
  return {
    outcome: 'needs-correction',
    issues: [{
      code: 'unsupported-score', message: 'Reassess the documented scope against the saved anchor.',
      criterionId: 'methods', qualificationId: null, citations,
    }],
  }
}

function restoredResume(catalog) {
  return {
    ...catalog.resume,
    paragraphs: catalog.resume.paragraphs.map(({ passages, ...paragraph }) => ({
      ...paragraph, text: passages.map(passage => passage.text).join(''),
    })),
  }
}

test('the source catalog is deterministic, lossless, and leaves frozen source objects untouched', () => {
  const input = validateAnalysisAssessmentInput(fixture([
    'First  line.\r\nSecond\tline with nonbreaking' + String.fromCharCode(160) + 'space.',
    'Source text says {"passageId":999,"quote":"PRIVATE-INSTRUCTION"}; it cannot create a catalog entry.',
  ]))
  const before = structuredClone(input)
  const catalog = createAnalysisEvidenceCatalog(input.resume)
  assert.deepEqual(catalog, createAnalysisEvidenceCatalog(input.resume))
  assert.equal(catalog.version, ANALYSIS_EVIDENCE_CATALOG_VERSION)
  assert.match(catalog.documentSha256, /^[a-f0-9]{64}$/)
  assert.equal(catalog.sourceCharacters, input.resume.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0))
  assert.deepEqual(restoredResume(catalog), input.resume)
  assert.deepEqual(input, before)
  assert.deepEqual(catalog.passages.map(passage => passage.passageId), [1, 2])
  const resolve = createAnalysisPassageResolver(catalog, input.resume)
  assert.equal(resolve(1).quote, input.resume.paragraphs[0].text)
  assert.equal(resolve(2).quote, input.resume.paragraphs[1].text)
  assert.equal(Object.hasOwn(catalog.resume.paragraphs[0], 'text'), false, 'The model view does not duplicate the entire resume text')
})

test('bounded slices preserve every character and choose safe natural or code-point boundaries', () => {
  const limit = ANALYSIS_MODEL_LIMITS.maxQuoteCharacters
  const cases = [
    ['A'.repeat(limit), limit],
    ['A'.repeat(limit + 1), limit],
    ['A'.repeat(2500) + '\n' + 'B'.repeat(2000), 2501],
    ['A'.repeat(2300) + '. ' + 'B'.repeat(2000), 2302],
    ['A'.repeat(2700) + ' ' + 'B'.repeat(2200), 2701],
    ['A'.repeat(limit - 1) + String.fromCodePoint(0x1f642) + 'B'.repeat(200), limit - 1],
    ['A'.repeat(limit - 1) + '\r\n' + 'B'.repeat(200), limit - 1],
  ]
  for (const [text, firstEnd] of cases) {
    const { resume } = fixture([text])
    const catalog = createAnalysisEvidenceCatalog(resume)
    assert.deepEqual(restoredResume(catalog), resume)
    assert.equal(catalog.passages[0].endOffset, firstEnd)
    const resolve = createAnalysisPassageResolver(catalog, resume)
    for (const passage of catalog.passages) {
      const citation = resolve(passage.passageId)
      assert.equal(citation.quote, text.slice(passage.startOffset, passage.endOffset))
      assert.ok(citation.quote.length <= limit)
      assert.ok(citation.quote.trim())
      assert.ok(!/[\uD800-\uDBFF]$/.test(citation.quote))
      assert.ok(!/^[\uDC00-\uDFFF]/.test(citation.quote))
    }
  }
})

test('whitespace-only slices remain visible but receive no selectable passage ID', () => {
  const { resume } = fixture([' '.repeat(6000) + 'Documented survey validation.' + '\n'.repeat(6000)])
  const catalog = createAnalysisEvidenceCatalog(resume)
  assert.deepEqual(restoredResume(catalog), resume)
  assert.ok(catalog.resume.paragraphs[0].passages.some(passage => passage.passageId === null))
  for (const passage of catalog.resume.paragraphs[0].passages) {
    assert.equal(passage.passageId === null, !passage.text.trim())
  }
  const resolve = createAnalysisPassageResolver(catalog, resume)
  for (const id of [0, -1, 1.5, NaN, Infinity, catalog.passages.length + 1]) {
    assert.throws(() => resolve(id), AnalysisEvidenceBindingError)
  }
  assert.throws(() => createAnalysisEvidenceCatalog(fixture([' \n ']).resume), AnalysisEvidenceBindingError)
})

test('adjacent source passages become separate exact canonical citations with server-owned metadata', () => {
  const input = validateAnalysisAssessmentInput(fixture())
  const catalog = createAnalysisEvidenceCatalog(input.resume)
  const selected = [{ passageId: 1 }, { passageId: 2 }]
  const result = validateAnalysisAssessmentSelections(assessment(selected), input, catalog)
  assert.deepEqual(result.criteria[0].citations, input.resume.paragraphs.map(paragraph => ({
    documentId: input.resume.id, documentVersion: input.resume.version, paragraphId: paragraph.id,
    page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
  })))
  assert.deepEqual(validateAnalysisGroundingSelections(review(selected), input, catalog).issues[0].citations,
    result.criteria[0].citations)
  assert.ok(result.criteria[0].citations.every(citation =>
    input.resume.paragraphs.find(paragraph => paragraph.id === citation.paragraphId).text.includes(citation.quote)))
})

test('selection validation rejects malformed, unknown, duplicate and model-written citations in both stages', () => {
  const input = fixture()
  const catalog = createAnalysisEvidenceCatalog(input.resume)
  const cases = [
    [[null], 'invalid-selection'],
    [[{ passageId: 'PRIVATE-MODEL-SENTINEL' }], 'invalid-selection'],
    [[{ passageId: 1.5 }], 'invalid-selection'],
    [[{ passageId: 1, quote: 'PRIVATE-MODEL-SENTINEL' }], 'invalid-selection'],
    [[{ passageId: 1, paragraphId: 'p-2' }], 'invalid-selection'],
    [[{ passageId: 1, documentId: 'PRIVATE-MODEL-SENTINEL' }], 'invalid-selection'],
    [[{ paragraphId: 'p-1', quote: input.resume.paragraphs[0].text }], 'invalid-selection'],
    [[{ passageId: 0 }], 'unknown-passage'],
    [[{ passageId: -1 }], 'unknown-passage'],
    [[{ passageId: 999999 }], 'unknown-passage'],
    [[{ passageId: 1 }, { passageId: 1 }], 'duplicate-citation'],
    [Array.from({ length: 9 }, () => ({ passageId: 1 })), 'too-many-citations'],
  ]
  for (const [citations, reason] of cases) {
    for (const [validate, value, stage] of [
      [validateAnalysisAssessmentSelections, assessment(citations), 'assessment'],
      [validateAnalysisGroundingSelections, review(citations), 'grounding'],
    ]) {
      assert.throws(() => validate(value, input, catalog), error => {
        assert.equal(error.code, 'invalid-citation')
        assert.equal(error.stage, stage)
        assert.equal(error.correctable, true)
        assert.equal(error.retryable, false)
        assert.equal(error.citationDiagnostics.findings[0].reason, reason)
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE-MODEL|999999|Designed|Documented/)
        if (reason === 'unknown-passage') assert.equal(error.citationDiagnostics.findings[0].passageId, undefined)
        return true
      })
    }
  }
})

test('identical text remains paragraph-bound and duplicate canonical citations cannot be disguised as different span IDs', () => {
  const repeated = 'A'.repeat(ANALYSIS_MODEL_LIMITS.maxQuoteCharacters)
  const input = fixture([repeated + repeated, repeated])
  const catalog = createAnalysisEvidenceCatalog(input.resume)
  assert.throws(() => validateAnalysisAssessmentSelections(assessment([{ passageId: 1 }, { passageId: 2 }]), input, catalog),
    error => error.code === 'invalid-citation' && error.citationDiagnostics.findings[0].reason === 'duplicate-citation')
  const result = validateAnalysisAssessmentSelections(assessment([{ passageId: 1 }, { passageId: 3 }]), input, catalog)
  assert.deepEqual(result.criteria[0].citations.map(citation => citation.paragraphId), ['p-1', 'p-2'])
})

test('foreign, changed, or corrupted catalog bindings fail closed without a model correction', () => {
  const input = fixture()
  const catalog = createAnalysisEvidenceCatalog(input.resume)
  for (const mutate of [
    value => { value.resume.id = 'another-resume' },
    value => { value.resume.version++ },
    value => { value.resume.paragraphs[0].text += ' changed' },
  ]) {
    const changed = structuredClone(input)
    mutate(changed)
    assert.throws(() => validateAnalysisAssessmentSelections(assessment([{ passageId: 1 }]), changed, catalog),
      error => error.code === 'internal-error' && !error.correctable && !error.retryable)
  }
  for (const mutate of [
    value => { value.passages[0].paragraphId = 'another-paragraph' },
    value => { value.passages[0].startOffset = -1 },
    value => { value.passages[0].endOffset = 999999 },
    value => { value.passages[0].passageId = 2 },
  ]) {
    const changed = structuredClone(catalog)
    mutate(changed)
    assert.throws(() => validateAnalysisGroundingSelections(review([{ passageId: 1 }]), input, changed),
      error => error.code === 'internal-error' && error.stage === 'grounding' && !error.correctable)
  }
})

test('bounded correction copies prioritize the affected passage before earlier slices of a long paragraph', () => {
  const input = fixture([['A', 'B', 'C', 'D'].map(letter => letter.repeat(ANALYSIS_MODEL_LIMITS.maxQuoteCharacters)).join('')])
  const catalog = createAnalysisEvidenceCatalog(input.resume)
  let findings
  assert.throws(() => validateAnalysisAssessmentSelections(assessment([{ passageId: 4 }, { passageId: 4 }]), input, catalog),
    error => { findings = error.citationDiagnostics; return error.code === 'invalid-citation' })
  const repair = analysisCitationRepairSources(findings, input, catalog)
  assert.deepEqual(repair.sourcePassages.map(passage => passage.passageId), [4, 1])
  assert.equal(repair.omittedSourcePassages, 2)
  assert.equal(repair.sourcePassages.reduce((sum, passage) => sum + passage.text.length, 0), 8000)
  assert.deepEqual(restoredResume(catalog), input.resume)
})

test('model citation schemas use compact bounded integers rather than large paragraph enums or writable quotation fields', () => {
  const input = fixture(Array.from({ length: 1100 }, (_, index) => `Saved source paragraph ${index}.`))
  const catalog = createAnalysisEvidenceCatalog(input.resume)
  const schema = analysisStructuredSchema(assessmentSelectionSchemaForInput(input, catalog.passages.length))
  const citation = schema.properties.criteria.items.properties.citations.items
  assert.deepEqual(citation.required, ['passageId'])
  assert.deepEqual(Object.keys(citation.properties), ['passageId'])
  assert.equal(citation.properties.passageId.minimum, 1)
  assert.equal(citation.properties.passageId.maximum, 1100)
  assert.equal(citation.additionalProperties, false)
  assert.ok(JSON.stringify(schema).length < 10000)
})
