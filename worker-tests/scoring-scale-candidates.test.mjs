import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { loadWorker } from './shared-model-loader.mjs'
import { fixture, b1, b2, invocation, keys, supported, disputed } from './scale-candidate-support.mjs'

const {
  deriveScaleCandidate, assessScaleCandidate, SCALE_CANDIDATE_ALGORITHMS, SCALE_CHECKLIST,
  scaleCandidateAlgorithm, validateProductionEvaluation, executeProductionEvaluation, evaluationHash,
  scoringSuiteSchema, validateObservations,
} = await loadWorker('../worker/evals/index.ts')
const { AnalysisModelError, validateAnalysisAssessmentInput, hashAnalysisAssessment } = await loadWorker('../worker/analyses/model.ts')
const { EVIDENCE_SCALE_V1 } = await loadWorker('../src/domain/evidence-scale.ts')
const { processingSettingsSnapshotSchema } = await loadWorker('../src/domain/admin-settings-schema.ts')
const { analysisHash } = await loadWorker('../server/analyses/deterministic.ts')

for (const [candidate, choice] of [['B1', b1], ['B2', b2]]) {
  for (let level = 0; level <= 5; level++) {
    test(`${candidate} derives exact level ${level}, status, literal source ownership and untouched requirements`, () => {
      const { input } = fixture()
      const before = JSON.stringify(input)
      const result = deriveScaleCandidate(input, choice(level), candidate)
      const row = result.assessment.criteria[0]
      assert.equal(row.score, level)
      assert.equal(row.evidenceStatus, level === 0 ? 'missing' : level <= 2 ? 'partial' : 'supported')
      assert.equal(row.weight, 100)
      assert.deepEqual(row.requirementCitations, input.requirementEvidence[0].citations)
      assert.equal(result.derivedCriteria[0].level, level)
      for (const citation of row.citations) {
        const paragraph = input.resume.paragraphs.find(row => row.id === citation.paragraphId)
        assert.equal(citation.documentId, input.resume.id)
        assert.equal(citation.documentVersion, input.resume.version)
        assert.equal(citation.quote, paragraph.text)
        assert.equal(citation.page, paragraph.page)
        assert.equal(citation.heading, paragraph.heading)
      }
      assert.equal(JSON.stringify(input), before)
    })
  }
  test(`${candidate} rejects unknown fields, duplicate/missing criteria, wrong IDs and invalid passage selections`, () => {
    const { input } = fixture()
    const changes = [
      value => { value.extra = true },
      value => { value.criteria[0].score = 5 },
      value => { value.criteria.push(structuredClone(value.criteria[0])) },
      value => { value.criteria = [] },
      value => { value.criteria[0].criterionId = 'foreign' },
      value => { value.criteria[0].completeSourceReviewed = false },
    ]
    for (const change of changes) {
      const value = choice(2)
      change(value)
      assert.throws(() => deriveScaleCandidate(input, value, candidate), { code: 'invalid-model-output' })
    }
    const evidenceOf = value => candidate === 'B1' ? value.criteria[0].evidence : value.criteria[0].checklist.appliedExample.evidence
    for (const passageId of [0, -1, 5, 1.5, '2']) {
      const value = choice(2)
      evidenceOf(value)[0].passageId = passageId
      assert.throws(() => deriveScaleCandidate(input, value, candidate), { code: 'invalid-model-output' })
    }
    const duplicate = choice(2)
    evidenceOf(duplicate).push(structuredClone(evidenceOf(duplicate)[0]))
    assert.throws(() => deriveScaleCandidate(input, duplicate, candidate), /duplicate/i)
  })

  test(`${candidate} blocked rows remain null and are never successful zeros or processing failure fallbacks`, () => {
    const { input } = fixture()
    const value = choice(0)
    Object.assign(value.criteria[0], {
      outcome: 'blocked', completeSourceReviewed: false,
      rationale: 'A genuine unreadable source section prevents document assessment.',
      limitation: { code: 'unusable-source', message: 'A genuine unreadable source section prevents document assessment.' },
      blockerCitations: [{ passageId: 3 }],
      ...(candidate === 'B1' ? { level: null } : { checklist: null }),
    })
    const result = deriveScaleCandidate(input, value, candidate)
    assert.equal(result.assessment.criteria[0].score, null)
    assert.equal(result.assessment.criteria[0].limitation.blockerCode, 'unusable-source')
    assert.equal(result.assessment.criteria[0].evidenceStatus, 'not-assessed')
    assert.equal(result.assessment.limitations.length, 1)
    assert.equal(result.assessment.criteria[0].citations[0].quote, input.resume.paragraphs[2].text)
    assert.equal(result.assessment.criteria[0].citations[0].documentId, input.resume.id)
    const bad = structuredClone(value)
    bad.criteria[0].limitation = null
    assert.throws(() => deriveScaleCandidate(input, bad, candidate), /blocker/)
    for (const message of ['Processing failed.', 'Token limit reached.', 'The candidate is qualified.', 'Recommend hiring the candidate.']) {
      const bad = structuredClone(value)
      bad.criteria[0].rationale = message
      assert.throws(() => deriveScaleCandidate(input, bad, candidate), { code: 'invalid-model-output' })
    }
    for (const code of ['ambiguous-guidance', 'restricted-personal-characteristic']) {
      const changed = structuredClone(value)
      changed.criteria[0].limitation.code = code
      assert.equal(deriveScaleCandidate(input, changed, candidate).assessment.criteria[0].limitation.blockerCode, code)
    }
    const duplicates = structuredClone(value)
    duplicates.criteria[0].blockerCitations.push({ passageId: 3 })
    assert.throws(() => deriveScaleCandidate(input, duplicates, candidate), { code: 'invalid-citation' })
  })

  test(`${candidate} legacy input is refused while baseline reader preserves its exact history`, () => {
    const { input } = fixture()
    delete input.rubric.scaleVersion
    delete input.rubric.criteria[0].levels
    input.rubric.criteria[0].guidance = '0: No document evidence. 1: Mention. 2: Applied work.'
    const legacy = validateAnalysisAssessmentInput(input)
    const before = JSON.stringify(legacy)
    assert.throws(() => deriveScaleCandidate(legacy, choice(), candidate), /legacy unscaled/)
    assert.equal(JSON.stringify(validateAnalysisAssessmentInput(legacy)), before)
    assert.equal(Object.hasOwn(legacy.rubric, 'scaleVersion'), false)
  })
}

test('B1 validates fixed integer choice and mention/applied consistency rather than rounding', () => {
  const { input } = fixture()
  for (const level of [-1, 6, 2.5, null]) {
    const value = b1()
    value.criteria[0].level = level
    assert.throws(() => deriveScaleCandidate(input, value, 'B1'), { code: 'invalid-model-output' })
  }
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const value = b1(level)
    value.criteria[0].evidence = [{ passageId: 1, kind: level <= 1 ? 'applied-example' : 'mention' }]
    assert.throws(() => deriveScaleCandidate(input, value, 'B1'), /consistency|requires an applied/)
  }
  const mixed = b1(2)
  mixed.criteria[0].evidence.push({ passageId: 1, kind: 'mention' })
  assert.equal(deriveScaleCandidate(input, mixed, 'B1').assessment.criteria[0].score, 2)
})

test('B2 table uses authoritative OR scope signals and explicit lower-level boundary fallbacks', () => {
  const { input } = fixture()
  assert.equal(SCALE_CHECKLIST.broadOrComplex, EVIDENCE_SCALE_V1.levels[4].description)
  assert.equal(SCALE_CHECKLIST.repeatedOrOngoing, EVIDENCE_SCALE_V1.levels[3].description)
  assert.match(SCALE_CHECKLIST.outcomesOrOrganizationalScale, /OR organizational scale/)
  const leadingWithoutScope = b2(5)
  leadingWithoutScope.criteria[0].checklist.outcomesOrOrganizationalScale = { answer: 'no', evidence: [] }
  assert.equal(deriveScaleCandidate(input, leadingWithoutScope, 'B2').assessment.criteria[0].score, 4)
  leadingWithoutScope.criteria[0].checklist.broadOrComplex = { answer: 'no', evidence: [] }
  assert.equal(deriveScaleCandidate(input, leadingWithoutScope, 'B2').assessment.criteria[0].score, 3)
  leadingWithoutScope.criteria[0].checklist.repeatedOrOngoing = { answer: 'no', evidence: [] }
  assert.equal(deriveScaleCandidate(input, leadingWithoutScope, 'B2').assessment.criteria[0].score, 2)
  const singleBroad = b2(4)
  singleBroad.criteria[0].checklist.repeatedOrOngoing = { answer: 'no', evidence: [] }
  assert.equal(deriveScaleCandidate(input, singleBroad, 'B2').assessment.criteria[0].score, 4)
  const singleLeading = b2(5)
  for (const key of ['repeatedOrOngoing', 'broadOrComplex']) singleLeading.criteria[0].checklist[key] = { answer: 'no', evidence: [] }
  assert.equal(deriveScaleCandidate(input, singleLeading, 'B2').assessment.criteria[0].score, 5)
})

test('B2 rejects contradictory predicates, incomplete scope, unrelated outcomes and inconsistent passage kinds', () => {
  const { input } = fixture()
  for (const key of keys) {
    const value = b2(5)
    value.criteria[0].checklist[key].answer = 'uncertain'
    assert.throws(() => deriveScaleCandidate(input, value, 'B2'), /uncertain|incomplete/)
    delete value.criteria[0].checklist[key]
    assert.throws(() => deriveScaleCandidate(input, value, 'B2'), /schema/)
  }
  for (const key of ['relevantEvidence', 'appliedExample', 'leadingOrOriginating']) {
    const value = b2(5)
    value.criteria[0].checklist[key] = { answer: 'no', evidence: [] }
    assert.throws(() => deriveScaleCandidate(input, value, 'B2'), /Contradictory|Higher-scale/)
  }
  const scope = b2(5)
  scope.criteria[0].checklist.outcomesOrOrganizationalScale.evidence[0].passageId = 2
  assert.throws(() => deriveScaleCandidate(input, scope, 'B2'), /tied to/)
  const kinds = b2(2)
  kinds.criteria[0].checklist.relevantEvidence.evidence[0].passageId = 2
  assert.throws(() => deriveScaleCandidate(input, kinds, 'B2'), /both mention-only/)
  const applied = b2(2)
  applied.criteria[0].checklist.appliedExample.evidence[0].kind = 'mention'
  assert.throws(() => deriveScaleCandidate(input, applied, 'B2'), /applied-example/)
  const noWithSupport = b2(2)
  noWithSupport.criteria[0].checklist.broadOrComplex.evidence = [{ passageId: 3, kind: 'applied-example' }]
  assert.throws(() => deriveScaleCandidate(input, noWithSupport, 'B2'), /no answers/)
})

test('candidate catalog retains long paragraphs and literal ownership instead of shortening evidence', () => {
  const { input } = fixture()
  input.resume.paragraphs = [{
    id: 'long-work', page: 8, heading: 'Long source',
    text: `${'Context text. '.repeat(350)}Applied regression in the final source section.`,
  }]
  for (const candidate of ['B1', 'B2']) {
    const value = candidate === 'B1' ? b1(2) : b2(2)
    const evidence = candidate === 'B1' ? value.criteria[0].evidence : value.criteria[0].checklist.appliedExample.evidence
    evidence[0].passageId = 2
    const result = deriveScaleCandidate(input, value, candidate)
    assert(result.assessment.criteria[0].citations.some(row => row.quote.includes('final source section')))
    for (const citation of result.assessment.criteria[0].citations) {
      assert(input.resume.paragraphs[0].text.includes(citation.quote))
      assert.equal(citation.paragraphId, 'long-work')
      assert.equal(citation.page, 8)
      assert.equal(citation.documentVersion, 7)
    }
  }
})

test('B2 enforces the combined criterion citation bound, not only individual question limits', () => {
  const { input } = fixture()
  input.resume.paragraphs = Array.from({ length: 10 }, (_, index) => ({
    id: `work-${index}`, page: 1, heading: 'Work', text: `Applied regression in study ${index}.`,
  }))
  const value = b2(4)
  value.criteria[0].checklist.appliedExample.evidence = Array.from({ length: 8 }, (_, index) => ({
    passageId: index + 2, kind: 'applied-example',
  }))
  assert.throws(() => deriveScaleCandidate(input, value, 'B2'), /full criterion citation limit/)
})

function gradeFixture() {
  const data = fixture()
  const rubric = data.input.rubric
  rubric.kind = 'grade'
  delete rubric.jobId
  rubric.ladder = 'Synthetic grade ladder'
  rubric.grade = 'GS-13'
  Object.assign(rubric.criteria[0], {
    competencyId: 'statistical-competency', support: 'direct', gradeBasis: rubric.criteria[0].sourceCitations,
    interpretation: 'The source supports this professional criterion.',
  })
  const excluded = structuredClone(rubric.criteria[0])
  Object.assign(excluded, { id: 'excluded', weight: 0, support: 'not-applicable', gradeBasis: [], guidance: 'Saved exclusion.' })
  delete excluded.levels
  rubric.criteria.push(excluded)
  data.input.qualifications = [{
    id: 'qualification', text: 'Documented education OR substituted work experience, with saved exceptions.',
    citations: rubric.criteria[0].sourceCitations, interpretation: 'Separate unscored document note.', support: 'direct',
  }]
  data.input.requirementEvidence.push({ kind: 'qualification', qualificationId: 'qualification', citations: rubric.criteria[0].sourceCitations })
  data.input.requirementEvidence.splice(1, 0, { kind: 'criterion', criterionId: 'excluded', citations: excluded.sourceCitations })
  return { ...data, input: validateAnalysisAssessmentInput(data.input) }
}

for (const [candidate, choice] of [['B1', b1], ['B2', b2]]) {
  test(`${candidate} preserves grade exclusions, unscored qualification alternatives and every qualification status`, () => {
    const { input } = gradeFixture()
    const value = choice(2)
    const exclusion = structuredClone(value.criteria[0])
    Object.assign(exclusion, {
      criterionId: 'excluded', outcome: 'excluded', completeSourceReviewed: false,
      ...(candidate === 'B1' ? { level: null, evidence: [] } : { checklist: null }),
    })
    value.criteria.push(exclusion)
    for (const status of ['supported', 'partial', 'missing', 'not-assessed']) {
      value.qualifications = [{
        qualificationId: 'qualification', evidenceStatus: status,
        rationale: 'The submitted document is compared with the saved alternatives and exceptions only.',
        citations: ['supported', 'partial'].includes(status) ? [{ passageId: 1 }] : [],
        limitation: status === 'not-assessed' ? { code: 'not-assessable', message: 'This administrative requirement needs human document review.' } : null,
      }]
      const row = deriveScaleCandidate(input, value, candidate).assessment
      assert.equal(row.criteria[1].score, null)
      assert.equal(row.criteria[1].evidenceStatus, 'not-applicable')
      assert.equal(row.criteria[1].weight, 0)
      assert.deepEqual(row.criteria[1].citations, [])
      assert.equal(row.qualifications[0].evidenceStatus, status)
      assert.equal(Object.hasOwn(row.qualifications[0], 'score'), false)
      assert.deepEqual(row.qualifications[0].requirementCitations, input.qualifications[0].citations)
    }
    const scoredExclusion = structuredClone(value)
    scoredExclusion.criteria[1] = { ...choice(1).criteria[0], criterionId: 'excluded' }
    assert.throws(() => deriveScaleCandidate(input, scoredExclusion, candidate), /applicable/)
    const doubleQualification = structuredClone(value)
    doubleQualification.qualifications.push(structuredClone(doubleQualification.qualifications[0]))
    assert.throws(() => deriveScaleCandidate(input, doubleQualification, candidate), /schema/)
    for (const change of [
      row => { row.qualifications = [] },
      row => { row.qualifications[0].qualificationId = 'foreign' },
      row => { row.qualifications[0].score = 5 },
    ]) {
      const invalid = structuredClone(value)
      change(invalid)
      assert.throws(() => deriveScaleCandidate(input, invalid, candidate), /schema/)
    }
    const duplicateCriteria = structuredClone(value)
    duplicateCriteria.criteria[1] = structuredClone(duplicateCriteria.criteria[0])
    assert.throws(() => deriveScaleCandidate(input, duplicateCriteria, candidate), /exactly once/)
    const eligibility = structuredClone(value)
    eligibility.qualifications[0].rationale = 'The candidate is eligible.'
    assert.throws(() => deriveScaleCandidate(input, eligibility, candidate), /eligibility/)
    const gap = structuredClone(input)
    gap.rubric.criteria[0].support = 'gap'
    delete gap.rubric.criteria[0].levels
    assert.throws(() => deriveScaleCandidate(gap, value, candidate), { code: 'invalid-input' })
    const qualificationGap = structuredClone(input)
    qualificationGap.qualifications[0].support = 'gap'
    assert.throws(() => deriveScaleCandidate(qualificationGap, value, candidate), /support gap/)
  })

  test(`${candidate} protected-trait criterion cannot be scored or zeroed`, () => {
    const { input } = fixture()
    Object.assign(input.rubric.criteria[0], { label: 'Citizenship', description: 'Assess citizenship.' })
    for (const level of [0, 2]) assert.throws(() => deriveScaleCandidate(input, choice(level), candidate), /personal-characteristic/)
    const blocked = choice(0)
    Object.assign(blocked.criteria[0], {
      outcome: 'blocked', limitation: { code: 'restricted-personal-characteristic', message: 'This requirement concerns a protected personal trait.' },
      ...(candidate === 'B1' ? { level: null } : { checklist: null }),
    })
    assert.equal(deriveScaleCandidate(input, blocked, candidate).assessment.criteria[0].score, null)
  })
}

for (const [version, algorithm] of Object.entries(SCALE_CANDIDATE_ALGORITHMS)) {
  test(`${version} runs through real transport mocks with isolated reviewer selector and immutable provenance`, async () => {
    const data = fixture(version)
    const choice = algorithm.candidate === 'B1' ? b1 : b2
    const responses = [choice(2), ...(algorithm.reviewMode === 'current-reviewer' ? [supported] : [])]
    const mock = invocation(data, responses)
    const inputBefore = JSON.stringify(data.input), settingsBefore = JSON.stringify(data.snapshot)
    const result = await assessScaleCandidate(data.input, mock.options, version, async row => {
      mock.artifacts.push(structuredClone(row))
      row.derived.assessment.criteria[0].score = 5
      row.rubricSha256 = 'mutation'
    })
    assert.equal(mock.calls.length, responses.length)
    assert.equal(result.assessment.criteria[0].score, 2)
    assert.equal(result.assessmentProvenance.promptVersion, version)
    assert.equal(result.assessmentProvenance.schemaVersion, version)
    assert.equal(result.assessmentSha256, hashAnalysisAssessment(result.assessment))
    assert.equal(mock.artifacts[0].rubricSha256, analysisHash(data.input.rubric))
    assert.equal(mock.artifacts[0].inputSha256, data.job.case.inputSha256)
    assert.equal(mock.artifacts[0].rawContentSha256, createHash('sha256').update(mock.artifacts[0].rawContent).digest('hex'))
    assert.equal(mock.artifacts[0].promptSha256, createHash('sha256').update(mock.calls[0].request.messages[0].content).digest('hex'))
    assert.equal(mock.artifacts[0].schemaSha256, evaluationHash(mock.calls[0].request.response_format.json_schema.schema))
    assert.equal(mock.artifacts[0].derived.derivedCriteria[0].level, 2)
    assert.equal(result.scaleCandidate.algorithmVersion, version)
    assert.equal(result.groundingReviews.length, responses.length - 1)
    assert.equal(JSON.stringify(data.input), inputBefore)
    assert.equal(JSON.stringify(data.snapshot), settingsBefore)
    assert.deepEqual(processingSettingsSnapshotSchema.parse(data.snapshot), data.snapshot)
    assert.equal(mock.calls[0].request.model, 'assessor')
    if (responses.length > 1) {
      assert.equal(mock.calls[1].request.model, 'reviewer')
      assert.equal(result.groundingReviews[0].assessmentSha256, result.assessmentSha256)
      assert.equal(result.groundingReviews[0].provenance.promptVersion, data.snapshot.promptBundle.revisions.assessmentGrounding.revisionId)
    }
  })

  test(`${version} publishes adapter observations and retains candidate artifacts separately`, async () => {
    const data = fixture(version)
    const choice = algorithm.candidate === 'B1' ? b1 : b2
    const mock = invocation(data, [choice(2), ...(algorithm.reviewMode === 'current-reviewer' ? [supported] : [])])
    const result = await executeProductionEvaluation(data.job, mock.executionOptions)
    assert.equal(result.status, 'complete')
    assert.equal(result.criteria[0].score, 2)
    assert.equal(result.overall, 40)
    assert.equal(mock.artifacts.length, 1)
    assert.equal(mock.attempts.length, mock.calls.length)
    assert.equal(mock.artifacts[0].provenance.promptVersion, version)
  })

  test(`${version} preserves grade exclusions and unscored qualification notes end-to-end`, async () => {
    const data = gradeFixture()
    data.job.configuration.algorithmVersion = version
    data.job.case = {
      ...data.job.case, targetKind: 'grade', inputSha256: evaluationHash(data.input),
      criterionIds: ['statistics', 'excluded'], excludedCriterionIds: ['excluded'],
    }
    const value = algorithm.candidate === 'B1' ? b1(2) : b2(2)
    value.criteria.push({
      ...value.criteria[0], criterionId: 'excluded', outcome: 'excluded', completeSourceReviewed: false,
      ...(algorithm.candidate === 'B1' ? { level: null, evidence: [] } : { checklist: null }),
    })
    value.qualifications = [{
      qualificationId: 'qualification', evidenceStatus: 'missing', rationale: 'No supporting evidence for the saved alternatives is present in this document.',
      citations: [], limitation: null,
    }]
    const mock = invocation(data, [value, ...(algorithm.reviewMode === 'current-reviewer' ? [supported] : [])])
    const result = await executeProductionEvaluation(data.job, mock.executionOptions)
    assert.equal(result.status, 'complete')
    assert.equal(result.overall, 40)
    assert.deepEqual(result.criteria, [{ criterionId: 'statistics', score: 2 }, { criterionId: 'excluded', score: null }])
    const derived = mock.artifacts[0].derived.assessment
    assert.equal(derived.qualifications[0].evidenceStatus, 'missing')
    assert.deepEqual(mock.calls[0].data.input.qualifications, data.input.qualifications)
    assert.equal(Object.hasOwn(derived.qualifications[0], 'score'), false)
  })
}

test('candidate selectors fail closed; preflight separates assessor-only prices and exact sources/exclusions', () => {
  const data = fixture()
  assert.equal(scaleCandidateAlgorithm('score-production-v1'), undefined)
  assert.equal(scaleCandidateAlgorithm('toString'), undefined)
  assert.equal(scaleCandidateAlgorithm('score-scale-b1-v1'), undefined)
  assert.throws(() => { SCALE_CANDIDATE_ALGORITHMS['score-scale-b1-assessor-v1'].reviewMode = 'current-reviewer' }, TypeError)
  assert.equal(scaleCandidateAlgorithm('score-scale-b1-assessor-v1').reviewMode, 'assessor-only')
  const opts = { input: data.input, processingSettings: data.snapshot, prices: { assessor: data.prices.assessor } }
  assert.doesNotThrow(() => validateProductionEvaluation(data.job, opts))
  const reviewerJob = structuredClone(data.job)
  reviewerJob.configuration.algorithmVersion = 'score-scale-b1-reviewer-v1'
  assert.throws(() => validateProductionEvaluation(reviewerJob, opts), /prices/)
  const stale = structuredClone(data.job)
  stale.case.inputSha256 = 'b'.repeat(64)
  assert.throws(() => validateProductionEvaluation(stale, opts), /exact saved case/)
  const unknown = structuredClone(data.job)
  unknown.configuration.algorithmVersion = 'score-scale-b1-v2'
  assert.throws(() => validateProductionEvaluation(unknown, opts), /impersonate/)
  const grade = gradeFixture()
  grade.job.case = { ...grade.job.case, inputSha256: evaluationHash(grade.input), criterionIds: ['statistics', 'excluded'] }
  assert.throws(() => validateProductionEvaluation(grade.job, { ...opts, input: grade.input }), /exactly its saved grade exclusions/)
})

test('candidate versions are suite identities, never interchangeable on resume', () => {
  const data = fixture()
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'selector', purpose: 'smoke', sourceVersion: 'synthetic-v1', repetitions: 1,
    cases: [data.job.case], configurations: [data.job.configuration],
  })
  const previousHash = evaluationHash(suite)
  suite.configurations[0].algorithmVersion = 'score-scale-b1-reviewer-v1'
  assert.notEqual(evaluationHash(suite), previousHash)
  assert.throws(() => validateObservations(suite, [{
    schemaVersion: 1, suiteSha256: previousHash, caseId: 'case', configurationId: 'candidate',
    repetition: 1, durationMilliseconds: 1, result: { status: 'failed', code: 'grounding-failed' },
  }]), /frozen suite/)
})

for (const [candidate, choice] of [['B1', b1], ['B2', b2]]) {
  test(`${candidate} shares format repairs, semantic reassessment and reviewer repairs in one bounded budget`, async () => {
    const version = `score-scale-${candidate.toLowerCase()}-reviewer-v1`
    const data = fixture(version, 2)
    const mock = invocation(data, ['invalid json', choice(2), disputed, choice(3), supported])
    const result = await assessScaleCandidate(data.input, mock.options, version)
    assert.equal(result.correctionCount, 2)
    assert.equal(result.assessment.criteria[0].score, 3)
    assert.equal(mock.calls.length, 5)
    assert.equal(result.scaleCandidate.artifacts.length, 3)
    assert.equal(result.scaleCandidate.artifacts[0].accepted, false)
    assert.equal(result.groundingReviews.length, 2)
    assert.equal(mock.calls[3].data.correction.previousAssessment.criteria[0].score, 2)
    const exhausted = invocation(data, ['invalid json', choice(2), 'invalid review json', disputed])
    await assert.rejects(assessScaleCandidate(data.input, exhausted.options, version), { code: 'grounding-failed' })
    assert.equal(exhausted.calls.length, 4)
    const reviewRepair = invocation(data, [choice(2), 'invalid review json', supported])
    const repaired = await assessScaleCandidate(data.input, reviewRepair.options, version)
    assert.equal(repaired.correctionCount, 1)
    assert.equal(reviewRepair.calls.length, 3)
  })

  test(`${candidate} typed validation/refusal/truncation failures do not publish zero or hide failed processing`, async () => {
    const data = fixture(`score-scale-${candidate.toLowerCase()}-assessor-v1`, 0)
    for (const response of [
      'invalid json',
      Response.json({ model: 'gpt-5-mini-2025-08-07', choices: [{ finish_reason: 'length', message: { content: JSON.stringify(choice(0)) } }] }),
      Response.json({ model: 'gpt-5-mini-2025-08-07', choices: [{ finish_reason: 'stop', message: { refusal: 'Synthetic refusal' } }] }),
    ]) {
      const mock = invocation(data, [response])
      mock.executionOptions.recordPrivateResult = async () => assert.fail('Failed processing cannot publish.')
      const result = await executeProductionEvaluation(data.job, mock.executionOptions)
      assert.equal(result.status, 'failed')
      assert.equal(Object.hasOwn(result, 'overall'), false)
      assert.equal(Object.hasOwn(result, 'criteria'), false)
      assert.equal(mock.calls.length, 1)
    }
    const mock = invocation(data, [choice(2)])
    mock.executionOptions.recordPrivateScaleArtifact = async () => { throw new Error('Artifact store unavailable') }
    await assert.rejects(executeProductionEvaluation(data.job, mock.executionOptions), /Artifact store unavailable/)
    assert.equal(mock.calls.length, 1)
    const typedStorageFailure = invocation(data, [choice(2)])
    typedStorageFailure.executionOptions.recordPrivateScaleArtifact = async () => { throw new AnalysisModelError('internal-error', 'Typed artifact storage failure') }
    await assert.rejects(executeProductionEvaluation(data.job, typedStorageFailure.executionOptions), /Typed artifact storage failure/)
  })

  test(`${candidate} reviewer reassessment can lower a level without averaging or replacing the saved rubric`, async () => {
    const version = `score-scale-${candidate.toLowerCase()}-reviewer-v1`
    const data = fixture(version)
    const mock = invocation(data, [choice(5), disputed, choice(2), supported])
    const result = await assessScaleCandidate(data.input, mock.options, version)
    assert.equal(result.assessment.criteria[0].score, 2)
    assert.equal(result.correctionCount, 1)
    assert.equal(result.groundingReviews[0].assessmentSha256, hashAnalysisAssessment(result.scaleCandidate.artifacts[0].derived.assessment))
    assert.equal(result.groundingReviews[1].assessmentSha256, result.assessmentSha256)
    assert.equal(result.scaleCandidate.artifacts[0].rubricSha256, result.scaleCandidate.artifacts[1].rubricSha256)
  })

  test(`${candidate} genuinely blocked weighted criteria withhold totals end-to-end`, async () => {
    const version = `score-scale-${candidate.toLowerCase()}-assessor-v1`
    const data = fixture(version)
    const value = choice(0)
    Object.assign(value.criteria[0], {
      outcome: 'blocked', completeSourceReviewed: false,
      limitation: { code: 'unusable-source', message: 'An unreadable source section prevents assessment.' },
      ...(candidate === 'B1' ? { level: null } : { checklist: null }),
    })
    const mock = invocation(data, [value])
    const result = await executeProductionEvaluation(data.job, mock.executionOptions)
    assert.equal(result.status, 'complete')
    assert.equal(result.overall, null)
    assert.equal(result.criteria[0].score, null)
    assert.equal(mock.artifacts[0].derived.assessment.criteria[0].evidenceStatus, 'not-assessed')
  })
}

test('candidate hash mismatch, legacy input, unknown version and cancellation stop before any model request', async () => {
  const data = fixture()
  const mock = invocation(data, [])
  await assert.rejects(assessScaleCandidate(data.input, { ...mock.options, targetSnapshotSha256: 'c'.repeat(64) }, data.job.configuration.algorithmVersion), /exact immutable/)
  await assert.rejects(assessScaleCandidate(data.input, mock.options, 'unknown'), /Unknown/)
  const legacy = structuredClone(data.input)
  delete legacy.rubric.scaleVersion
  delete legacy.rubric.criteria[0].levels
  await assert.rejects(assessScaleCandidate(legacy, mock.options, data.job.configuration.algorithmVersion), /legacy unscaled/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(assessScaleCandidate(data.input, { ...mock.options, signal: controller.signal }, data.job.configuration.algorithmVersion))
  assert.equal(mock.calls.length, 0)
})

test('cancellation after a raw choice checkpoint cannot publish a score or start the reviewer', async () => {
  const version = 'score-scale-b1-reviewer-v1'
  const data = fixture(version)
  const mock = invocation(data, [b1(2)])
  const controller = new AbortController()
  await assert.rejects(assessScaleCandidate(data.input, { ...mock.options, signal: controller.signal }, version, async () => {
    controller.abort()
  }))
  assert.equal(mock.calls.length, 1)
})
