import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { loadWorker } from './shared-model-loader.mjs'

export const modelApi = await loadWorker('../worker/analyses/narrative-model.ts')
export const validators = await loadWorker('../src/domain/analysis-narrative-validation.ts')
export const inputApi = await loadWorker('../worker/analyses/narrative-model-input.ts')
export const deterministic = await loadWorker('../server/analyses/deterministic.ts')
const assessmentApi = await loadWorker('../worker/analyses/validation.ts')

export const NOW = '2026-09-19T18:00:00.000Z'
export const ACTUAL_MODEL = 'actual-configured-model-2026-09-19'
export const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const guidance = '0: No document support; 1: Identifies the work; 2: Applies the work with review; 3: Independently applies the work; 4: Resolves unusual work problems with outcomes; 5: Repeatedly validates complex work with outcomes.'

function requirement(index, quote) {
  return { documentId: 'saved-job-document', documentVersion: 3, paragraphId: `job-${index}`, page: 1, heading: 'Work', quote }
}

export function candidateFixture(index = 1, { grade = false, limited = false, strong = false } = {}) {
  const source = {
    resume: {
      id: `resume-document-${index}`, version: 2, kind: 'resume', sample: false, title: 'Captured professional work',
      paragraphs: [
        { id: 'resume-calibration', page: 1, heading: 'Calibration', text: 'Resolved unusual calibration drift, validated the method, and reduced measurement variance by 12 percent.' },
        { id: 'resume-telemetry', page: 1, heading: 'Delivery', text: 'Built a telemetry pipeline under regular technical review and documented its operating procedures.' },
        { id: 'resume-communication', page: 2, heading: 'Communication', text: 'Prepared a laboratory work log for internal use.' },
        { id: 'resume-education', page: 2, heading: 'Education', text: 'Completed a graduate research program in environmental measurement.' },
      ],
    },
    rubric: {
      id: 'rubric-measurement', groupId: 'rubric-group', jobId: 'job-measurement', kind: 'job', dataKind: 'real',
      name: 'Measurement specialist', description: 'Saved professional measurement requirements.', version: 3, createdAt: NOW,
      criteria: [
        { id: 'calibration', key: 'custom', label: 'Method calibration', description: 'Validate measurement calibration methods.', weight: 50, guidance },
        { id: 'telemetry', key: 'custom', label: 'Telemetry delivery', description: 'Deliver telemetry pipelines independently.', weight: 30, guidance },
        { id: 'communication', key: 'custom', label: 'Method review', description: 'Explain experimental limits to technical reviewers.', weight: 20, guidance },
      ].map((criterion, row) => ({ ...criterion, sourceCitations: [requirement(row, criterion.description)] })),
    },
    qualifications: [],
    requirementEvidence: [],
  }
  if (grade) {
    source.rubric.kind = 'grade'
    source.rubric.grade = 'GS-11'
    source.rubric.ladder = 'Measurement ladder'
    source.rubric.criteria = source.rubric.criteria.map(criterion => ({
      ...criterion, competencyId: criterion.id, support: 'direct',
      gradeBasis: criterion.sourceCitations, interpretation: 'The saved work-level requirement remains subject to human review.',
    }))
    source.rubric.criteria.push({
      id: 'excluded-awards', key: 'custom', label: 'Award authority', description: 'Contract awards are outside the approved scope.',
      weight: 0, guidance: 'This saved exclusion has no score.', competencyId: 'excluded-awards', support: 'not-applicable',
      sourceCitations: [requirement(4, 'Contract awards are outside the approved scope.')],
      gradeBasis: [], interpretation: 'The saved scope excludes contract awards.',
    })
    source.qualifications = [{
      id: 'graduate-or-experience', text: 'Graduate education OR specialized experience may document the requirement.',
      interpretation: 'Review the alternatives separately without declaring eligibility.', support: 'direct',
      citations: [requirement(5, 'Graduate education OR specialized experience may document the requirement.')],
    }]
  }
  source.requirementEvidence = deterministic.analysisRequirementEvidenceForInput(source)
  const assessed = assessmentApi.validateAnalysisAssessment({
    criteria: source.rubric.criteria.map((criterion, row) => criterion.support === 'not-applicable' ? {
      criterionId: criterion.id, evidenceStatus: 'not-applicable', score: null,
      rationale: 'The saved rubric excludes award authority from assessment.', citations: [], limitation: null,
    } : limited && row === 1 ? {
      criterionId: criterion.id, evidenceStatus: 'not-assessed', score: null,
      rationale: 'The submitted document leaves telemetry responsibility scope uncertain.', citations: [],
      limitation: { code: 'not-assessable', message: 'Telemetry responsibility scope needs human review.' },
    } : !strong && row === 2 ? {
      criterionId: criterion.id, evidenceStatus: 'missing', score: 0,
      rationale: 'The submitted document does not establish communication of experimental limits.', citations: [], limitation: null,
    } : {
      criterionId: criterion.id, evidenceStatus: !strong && row === 1 ? 'partial' : 'supported', score: row === 0 ? 4 : 2,
      rationale: row === 0 ? 'The cited work validates calibration and documents a measurement outcome.'
        : row === 1 ? 'The document describes telemetry delivery under regular review, not independent operation.'
          : 'The document describes a laboratory work log supporting bounded internal communication.',
      citations: [{ paragraphId: source.resume.paragraphs[row].id, quote: source.resume.paragraphs[row].text }], limitation: null,
    }),
    qualifications: source.qualifications.map(qualification => ({
      qualificationId: qualification.id, evidenceStatus: 'partial',
      rationale: 'Graduate research is documented but does not settle all saved education or specialized-experience alternatives.',
      citations: [{ paragraphId: source.resume.paragraphs[3].id, quote: source.resume.paragraphs[3].text }], limitation: null,
    })),
  }, source)
  const binding = {
    kind: 'candidate', workspaceId: 'narrative-test-workspace', runId: `analysis-run-${uuid(9999)}`,
    manifestSha256: 'a'.repeat(64), targetId: `target-${'b'.repeat(48)}`,
    targetSnapshot: { snapshotId: `analysis-snapshot-${uuid(9998)}`, sha256: 'c'.repeat(64) },
    comparisonId: `analysis-comparison-${uuid(index)}`,
    resumeSnapshot: { snapshotId: `analysis-snapshot-${uuid(index)}`, sha256: deterministic.analysisHash(source.resume) },
    resultSha256: 'd'.repeat(64),
  }
  const assessmentHash = deterministic.analysisAssessmentHash(assessed)
  const provenance = {
    model: 'saved-assessment-model', deployment: 'configured-analysis-deployment',
    promptVersion: 'score-analysis-assessment-v3', schemaVersion: 'score-analysis-assessment-v2',
    startedAt: NOW, completedAt: NOW, inputCharacters: 10_000,
  }
  const result = {
    schemaVersion: 1, dataKind: 'real', workspaceId: binding.workspaceId, runId: binding.runId, comparisonId: binding.comparisonId,
    createdAt: NOW, humanReviewRequired: true, ...assessed,
    ...deterministic.calculateAnalysisSummary(assessed.criteria, assessed.qualifications, assessed.limitations),
    provenance: {
      attemptId: uuid(9001), manifestSha256: binding.manifestSha256, resumeSnapshot: binding.resumeSnapshot,
      targetSnapshot: binding.targetSnapshot, assessmentSha256: assessmentHash, assessment: provenance,
      groundingReviews: [{
        id: `analysis-grounding-${uuid(index)}`, outcome: 'supported', issues: [], assessmentSha256: assessmentHash,
        resumeSnapshotSha256: binding.resumeSnapshot.sha256, targetSnapshotSha256: binding.targetSnapshot.sha256,
        provenance: { ...provenance, promptVersion: 'score-analysis-grounding-v3', schemaVersion: 'score-analysis-grounding-v2' },
      }],
      correctionCount: 0, calculationVersion: 'weighted-0-100-v1',
    },
  }
  return refreshCandidate({ binding, source, result, inputFingerprint: '' })
}

export function refreshCandidate(input) {
  Object.assign(input.result, deterministic.calculateAnalysisSummary(input.result.criteria, input.result.qualifications, input.result.limitations))
  input.result.provenance.assessmentSha256 = deterministic.analysisAssessmentHash(input.result)
  input.result.provenance.groundingReviews.at(-1).assessmentSha256 = input.result.provenance.assessmentSha256
  input.binding.resultSha256 = createHash('sha256').update(JSON.stringify(input.result)).digest('hex')
  input.inputFingerprint = deterministic.analysisHash(input.binding)
  return input
}

export const ref = (input, kind, key) => ({
  kind, comparisonId: input.binding.comparisonId,
  ...(kind === 'criterion' ? { criterionId: key } : kind === 'qualification' ? { qualificationId: key }
    : kind === 'limitation' ? { limitationIndex: key } : {}),
})

export function candidateOutput(input, { grade = input.source.rubric.kind === 'grade', limited = input.result.overall.status === 'withheld' } = {}) {
  const sentences = [
    "The document describes validated calibration work that addresses the role's measurement requirements.",
    limited ? 'Telemetry responsibility remains unassessed because its scope is unclear, and the total is withheld.'
      : 'Telemetry procedures show delivery experience, although the documented work remained under regular technical review.',
    'The submitted evidence does not establish communication of experimental limits, so that aspect needs human review.',
  ]
  const references = [
    [ref(input, 'criterion', 'calibration')],
    [ref(input, 'criterion', 'telemetry'), ...(limited ? [ref(input, 'limitation', 0), ref(input, 'overall')] : [])],
    [ref(input, 'criterion', 'communication')],
  ]
  if (grade) {
    sentences.push('The saved rubric excludes award authority, while graduate research leaves education or experience qualification alternatives unresolved for separate unscored review.')
    references.push([ref(input, 'criterion', 'excluded-awards'), ref(input, 'qualification', 'graduate-or-experience')])
  }
  const overview = grade
    ? 'Calibration validation is documented, but telemetry scope, communication evidence, and separate unscored qualification alternatives require review.'
    : 'Validated calibration work is documented, while telemetry independence and communication of experimental limits remain incompletely evidenced.'
  return {
    text: sentences.join(' '), overview,
    claims: [
      ...sentences.map((_, sentenceIndex) => ({
        id: `text-${sentenceIndex}`, location: { field: 'text', sentenceIndex }, references: references[sentenceIndex],
      })),
      { id: 'overview-0', location: { field: 'overview', sentenceIndex: 0 }, references: references.flat() },
    ],
  }
}

export function selectOutput(output, catalog) {
  const byKey = new Map(catalog.entries.map(entry => [validators.narrativeReferenceKey(entry.reference), entry.id]))
  return {
    ...output,
    claims: output.claims.map(({ references, ...claim }) => ({
      ...claim, referenceIds: references.map(reference => {
        const id = byKey.get(validators.narrativeReferenceKey(reference))
        assert.notEqual(id, undefined)
        return id
      }),
    })),
  }
}

export function candidateSelection(input, output = candidateOutput(input)) {
  return selectOutput(output, inputApi.createNarrativeEvidenceCatalog(input))
}

export function targetFixture(count = 2, { terminal = [], lateGap = false, strong = false, grade = false } = {}) {
  const inputs = Array.from({ length: count }, (_, index) => candidateFixture(index + 1, { strong, grade }))
  if (lateGap && count) {
    inputs.at(-1).result.criteria[1].rationale += ' The late record also leaves offshore safety validation undocumented.'
    inputs.at(-1).result.limitations.push({ code: 'source-quality', message: 'Offshore safety validation is undocumented in the late record.', criterionId: 'telemetry' })
    refreshCandidate(inputs.at(-1))
  }
  const first = inputs[0] ?? candidateFixture()
  const { resume: _resume, ...target } = first.source
  const { kind: _kind, comparisonId: _comparison, resultSha256: _result, resumeSnapshot: _snapshot, ...base } = first.binding
  const candidates = inputs.map((input, index) => ({
    binding: input.binding, result: input.result,
    narrative: {
      dataKind: 'real', text: candidateOutput(input).text, overview: candidateOutput(input).overview,
      generationId: uuid(10_000 + index), inputFingerprint: input.inputFingerprint,
      revision: deterministic.analysisHash({ text: candidateOutput(input).text, id: index }), publishedAt: NOW,
    },
  }))
  const comparisons = candidates.map(candidate => ({
    comparisonId: candidate.binding.comparisonId, status: 'complete', resumeSnapshot: candidate.binding.resumeSnapshot,
    resultSha256: candidate.binding.resultSha256, candidateInputFingerprint: candidate.narrative.inputFingerprint,
    narrative: {
      status: 'ready', generationId: candidate.narrative.generationId, inputFingerprint: candidate.narrative.inputFingerprint,
      published: {
        generationId: candidate.narrative.generationId, inputFingerprint: candidate.narrative.inputFingerprint,
        revision: candidate.narrative.revision, publishedAt: NOW,
      },
    },
  }))
  for (const [index, status] of terminal.entries()) comparisons.push({
    comparisonId: `analysis-comparison-${uuid(count + index + 1)}`, status,
    resumeSnapshot: { snapshotId: `analysis-snapshot-${uuid(count + index + 1)}`, sha256: 'f'.repeat(64) },
    resultSha256: null, candidateInputFingerprint: null, narrative: null,
  })
  const binding = { ...base, kind: 'target', comparisons }
  return { binding, inputFingerprint: deterministic.analysisHash(binding), target, candidates }
}

export function targetOutput(input, { omitLateGap = false } = {}) {
  const rows = input.candidates
  const completed = rows.map(candidate => ({ binding: candidate.binding }))
  const sentences = []
  const refs = []
  if (rows.length) {
    sentences.push('The reviewed documents describe calibration validation work relevant to the saved measurement requirements.')
    refs.push(completed.map(input => ref(input, 'criterion', 'calibration')))
    sentences.push('Telemetry delivery is documented under regular review, leaving independent operating responsibility uncertain.')
    refs.push(completed.map(input => ref(input, 'criterion', 'telemetry')))
    sentences.push('Communication of experimental limits remains undocumented in the submitted evidence and needs human review.')
    refs.push(completed.map(input => ref(input, 'criterion', 'communication')))
    if (input.target.rubric.kind === 'grade') {
      sentences.push('The saved rubric excludes contract award authority rather than treating it as missing evidence.')
      refs.push(completed.map(input => ref(input, 'criterion', 'excluded-awards')))
      sentences.push('Graduate research does not settle the separate education or experience qualification alternatives, which require unscored human review.')
      refs.push(completed.map(input => ref(input, 'qualification', 'graduate-or-experience')))
    }
    const late = rows.at(-1)
    if (late.result.limitations.length) {
      sentences.push(omitLateGap ? 'The reviewed evidence needs careful interpretation for this exact target.'
        : 'Offshore safety validation remains undocumented in the late record and requires human review.')
      refs.push(late.result.limitations.map((_, index) => ref(late, 'limitation', index)))
    }
  }
  const terminal = input.binding.comparisons.filter(comparison => comparison.status !== 'complete')
  if (terminal.length) {
    sentences.push('Failed or cancelled reviews remain unassessed and provide no evidence about the people or their work.')
    refs.push(terminal.map(comparison => ({ kind: 'status', comparisonId: comparison.comparisonId })))
  }
  return {
    paragraphs: [sentences.join(' ')],
    claims: sentences.map((_, sentenceIndex) => ({
      id: `target-${sentenceIndex}`, location: { field: 'paragraphs', paragraphIndex: 0, sentenceIndex }, references: refs[sentenceIndex],
    })),
  }
}

export function reductionOutput(source) {
  const grouped = new Map()
  const add = (text, ids) => grouped.set(text, [...new Set([...(grouped.get(text) ?? []), ...ids])])
  if (source.mode === 'saved-assessments') {
    for (const record of source.records) {
      if (!record.assessment) {
        add('These terminal reviews remain unassessed and supply no document evidence.', [record.statusReferenceId])
        continue
      }
      add('The reviewed documents support a saved evidence assessment with the recorded coverage and overall availability.', [
        record.statusReferenceId, record.assessment.coverage.referenceId, record.assessment.overall.referenceId,
      ])
      for (const row of record.assessment.criteria) add(
        row.evidenceStatus === 'not-applicable' ? 'Contract award authority is excluded by the saved rubric rather than treated as missing evidence.'
          : row.criterionId === 'calibration' ? 'The documents describe calibration validation and a recorded measurement outcome.'
          : row.criterionId === 'telemetry' ? 'Telemetry delivery is documented under review and does not establish independent operating responsibility.'
            : 'Communication of experimental limits remains undocumented and needs human review.',
        [row.referenceId],
      )
      for (const limitation of record.assessment.limitations) add(
        'Offshore safety validation remains undocumented in the late record and requires human review.', [limitation.referenceId],
      )
      for (const qualification of record.assessment.qualifications) add(
        'The separate qualification alternatives remain unresolved and require unscored human review.', [qualification.referenceId],
      )
    }
  } else {
    for (const node of source.nodes) for (const finding of node.output.findings) add(finding.text, finding.referenceIds)
  }
  const findings = []
  for (const [text, references] of grouped) {
    for (let offset = 0; offset < references.length; offset += 500) {
      findings.push({ id: `finding-${findings.length}`, text, referenceIds: references.slice(offset, offset + 500) })
    }
  }
  return { members: [...source.members], findings }
}

export function response(value, overrides = {}) {
  return Response.json({
    model: ACTUAL_MODEL, choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }],
    ...overrides,
  })
}

export function mockModel(values) {
  const calls = []
  const sleeps = []
  let now = Date.parse(NOW)
  let tokens = 0
  const clock = { now: () => new Date(now += 1), sleep: async (milliseconds, signal) => {
    if (signal?.aborted) throw signal.reason
    sleeps.push(milliseconds)
  } }
  const model = {
    endpoint: 'https://narrative-configured.example/', deployment: 'configured-analysis-deployment',
    modelName: 'configured-fallback-must-not-be-used', reasoningEffort: 'low',
    getToken: async scope => { tokens++; assert.equal(scope, 'https://cognitiveservices.azure.com/.default'); return 'test-token' },
    fetch: async (url, init) => {
      const request = JSON.parse(init.body)
      const body = JSON.parse(request.messages[1].content)
      const kind = request.response_format.json_schema.name
      calls.push({ kind, body, request, url, signal: init.signal, bytes: Buffer.byteLength(init.body) })
      const value = typeof values === 'function'
        ? await values({ call: calls.length, kind, body, request, signal: init.signal })
        : values[calls.length - 1]
      assert.notEqual(value, undefined, 'Unexpected extra inference call')
      return value instanceof Response ? value : response(value, { model: `${ACTUAL_MODEL}-${calls.length}` })
    },
  }
  return { calls, sleeps, model, clock, tokenCalls: () => tokens, options: { model, clock, attemptId: uuid(999) } }
}

export const supportedReview = () => ({ outcome: 'supported', issues: [] })

export function unsupportedReview(referenceIds, overrides = {}) {
  return {
    outcome: 'needs-correction',
    issues: [{
      code: 'unsupported-claim', message: 'The stated independent delivery work is not supported by the referenced reviewed evidence.',
      claimId: null, referenceIds, ...overrides,
    }],
  }
}

export function rejectsCode(code, stage, retryable) {
  return error => {
    assert.ok(error instanceof modelApi.NarrativeModelError)
    assert.equal(error.code, code)
    if (stage) assert.equal(error.stage, stage)
    if (retryable !== undefined) assert.equal(error.retryable, retryable)
    assert.doesNotMatch(error.message, /PRIVATE-SENTINEL|private@example|secret\.invalid/)
    assert.equal(error.cause, undefined)
    return true
  }
}

export function assertStrictSchema(schema) {
  if (!schema || typeof schema !== 'object') return
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort())
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach(assertStrictSchema)
    else assertStrictSchema(value)
  }
}

export function expandReviewedOutput(body) {
  if (!body.referenceEncoding) return body.output
  const encoding = body.referenceEncoding
  assert.equal(encoding.kind, 'lossless-reference-catalog-v1')
  const references = new Map(encoding.references.map(([id, comparisonIndex, kindIndex, detailIndex]) => {
    const kind = encoding.kinds[kindIndex]
    const comparisonId = encoding.comparisons[comparisonIndex]
    return [id, {
      kind, comparisonId,
      ...(kind === 'criterion' ? { criterionId: encoding.criterionIds[detailIndex] }
        : kind === 'qualification' ? { qualificationId: encoding.qualificationIds[detailIndex] }
          : kind === 'limitation' ? { limitationIndex: detailIndex } : {}),
    }]
  }))
  assert.equal(references.size, encoding.references.length)
  return {
    paragraphs: body.output.paragraphs,
    claims: body.output.claims.map(({ referenceIds, ...claim }) => ({
      ...claim, references: referenceIds.map(id => {
        assert.ok(references.has(id))
        return references.get(id)
      }),
    })),
  }
}
