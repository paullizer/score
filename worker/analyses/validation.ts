import {
  analysisAssessmentHash, analysisHash, analysisRequirementEvidenceForInput, describeAnalysisSummary,
  calculateAnalysisSummary as summarizeValidatedAnalysis,
} from '../../server/analyses/deterministic'
import { analysisAssessmentOutputSchema, citationMatchesDocument } from '../../server/analyses/validation'
import type {
  AnalysisLimitation, AnalysisProcessingErrorCode, RealAnalysisAssessmentInput, RealAnalysisAssessmentOutput,
  RealAnalysisGroundingReviewOutput, RealAnalysisResultSummary, RealCriterionResult, RealQualificationAssessment,
} from '../../src/domain/real-analyses'
import type { AnalysisDiagnosticReason, AnalysisSchemaDiagnostics } from '../../src/domain/analysis-diagnostics'
import { isPersonalTraitCriterion } from '../../src/domain/analysis-evidence-policy'
import { RESUME_IMPORT_LIMITS } from '../../src/domain/real-resumes'
import type { Citation } from '../../src/domain/types'
import {
  assessmentInputSchema, assessmentSchemaForInput, groundingSchemaForInput,
  assessmentSelectionSchemaForInput, groundingSelectionSchemaForInput,
  type ModelResumeQuote,
} from './model-schema'
import {
  analysisOutputCitationDiagnostics, analysisResumeCitationDiagnostics, analysisSelectionCitationDiagnostics, describeAnalysisCitationFailure,
  type AnalysisCitationDiagnostics, type AnalysisModelStage,
} from './citation-diagnostics'
import {
  AnalysisEvidenceBindingError, createAnalysisPassageResolver, type AnalysisEvidenceCatalog,
} from './evidence-passages'
import { analysisSchemaDiagnostics } from './diagnostics'
import type { ModelRetryMetadata } from '../errors'

export type { AnalysisModelStage } from './citation-diagnostics'
export { describeAnalysisSummary as describeAnalysisAssessment } from '../../server/analyses/deterministic'

export interface AnalysisModelErrorOptions extends ModelRetryMetadata {
  retryable?: boolean
  stage?: AnalysisModelStage
  correctable?: boolean
  cancelled?: boolean
  citationDiagnostics?: AnalysisCitationDiagnostics
  schemaDiagnostics?: AnalysisSchemaDiagnostics
  reason?: AnalysisDiagnosticReason
}

export class AnalysisModelError extends Error {
  readonly code: AnalysisProcessingErrorCode
  readonly retryable: boolean
  readonly stage: AnalysisModelStage
  readonly correctable: boolean
  readonly cancelled: boolean
  readonly citationDiagnostics?: AnalysisCitationDiagnostics
  readonly schemaDiagnostics?: AnalysisSchemaDiagnostics
  readonly reason?: AnalysisDiagnosticReason
  readonly httpStatus?: number
  readonly retryAt?: string

  constructor(code: AnalysisProcessingErrorCode, message: string, options: AnalysisModelErrorOptions = {}) {
    super(message)
    this.name = options.cancelled ? 'AbortError' : 'AnalysisModelError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.stage = options.stage ?? 'assessment'
    this.correctable = options.correctable ?? false
    this.cancelled = options.cancelled ?? false
    this.citationDiagnostics = options.citationDiagnostics
    this.schemaDiagnostics = options.schemaDiagnostics
    this.reason = options.reason
    this.httpStatus = options.httpStatus
    this.retryAt = options.retryAt
  }
}

export const ANALYSIS_WEIGHT_TOLERANCE = 0.000001
export const ANALYSIS_CALCULATION_VERSION = 'weighted-0-100-v1' as const

function invalidInput(message: string): never {
  throw new AnalysisModelError('invalid-input', message, { reason: 'input-contract' })
}

function invalidOutput(
  message: string, stage: AnalysisModelStage = 'assessment', citation = false,
  reason: AnalysisDiagnosticReason = 'assessment-contract',
): never {
  throw new AnalysisModelError(citation ? 'invalid-citation' : 'invalid-model-output', message, {
    stage, correctable: true, reason: citation ? 'citation-mismatch' : reason,
  })
}

function invalidSchema(
  message: string, issues: Parameters<typeof analysisSchemaDiagnostics>[0],
  stage: AnalysisModelStage = 'assessment', citation = false,
): never {
  throw new AnalysisModelError(citation ? 'invalid-citation' : 'invalid-model-output', message, {
    stage, correctable: true, reason: 'schema-mismatch', schemaDiagnostics: analysisSchemaDiagnostics(issues),
  })
}

function invalidCitations(diagnostics: AnalysisCitationDiagnostics, stage: AnalysisModelStage): never {
  throw new AnalysisModelError('invalid-citation', describeAnalysisCitationFailure(diagnostics, stage), {
    stage, correctable: true, citationDiagnostics: diagnostics, reason: 'citation-mismatch',
  })
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length
}

function notApplicable(rubric: RealAnalysisAssessmentInput['rubric'], criterionId: string): boolean {
  return rubric.kind === 'grade' && rubric.criteria.some(value => value.id === criterionId && value.support === 'not-applicable')
}

function validateWeights(rubric: RealAnalysisAssessmentInput['rubric']): void {
  if (!rubric || rubric.dataKind !== 'real' || !['job', 'grade'].includes(rubric.kind) ||
    !Array.isArray(rubric.criteria) || !rubric.criteria.length ||
    !unique(rubric.criteria.map(value => value?.id)) ||
    rubric.criteria.some(value => !value || typeof value.id !== 'string' || !value.id.trim() ||
      !Number.isFinite(value.weight) || value.weight < 0 || value.weight > 100)) {
    invalidInput('Analysis requires a real saved rubric with unique criteria and finite unchanged percentage weights.')
  }
  for (const criterion of rubric.criteria) {
    if (notApplicable(rubric, criterion.id) && criterion.weight !== 0) {
      invalidInput('An excluded grade criterion must retain its saved zero weight.')
    }
  }
  const total = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  if (!Number.isFinite(total) || Math.abs(total - 100) > ANALYSIS_WEIGHT_TOLERANCE) {
    invalidInput('The saved analysis rubric weights must total 100; analysis never normalizes or substitutes weights.')
  }
}

/** This boundary validates model inputs; authorization, approval, and snapshot hashes belong to the resolver. */
export function validateAnalysisAssessmentInput(value: unknown): RealAnalysisAssessmentInput {
  const parsed = assessmentInputSchema.safeParse(value)
  if (!parsed.success) throw new AnalysisModelError('invalid-input',
    'Analysis requires a complete real resume, saved rubric, and bounded frozen requirement evidence.', {
      reason: 'input-contract', schemaDiagnostics: analysisSchemaDiagnostics(parsed.error.issues),
    })
  const input: RealAnalysisAssessmentInput = parsed.data
  if (!unique(input.resume.paragraphs.map(paragraph => paragraph.id)) ||
    !unique(input.qualifications.map(qualification => qualification.id)) ||
    !Number.isFinite(Date.parse(input.rubric.createdAt))) {
    invalidInput('Analysis source paragraphs and qualifications need unique identities and a valid saved rubric version.')
  }
  if (input.resume.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0) > RESUME_IMPORT_LIMITS.maxSourceCharacters) {
    throw new AnalysisModelError('context-limit', 'The complete resume exceeds the supported analysis source limit; no sections were omitted.', {
      reason: 'source-limit',
    })
  }
  validateWeights(input.rubric)
  if (input.rubric.kind === 'job' && input.qualifications.length) {
    invalidInput('Only saved grade targets may supply separate unscored grade qualifications.')
  }
  if (input.rubric.kind === 'grade' && (input.rubric.criteria.some(criterion => criterion.support === 'gap') ||
    input.qualifications.some(qualification => qualification.support === 'gap'))) {
    invalidInput('Analysis cannot use an unresolved grade rubric or qualification support gap.')
  }
  if (input.rubric.kind === 'grade' && input.rubric.criteria.some(
    criterion => criterion.support === 'not-applicable' && criterion.gradeBasis.length,
  )) {
    invalidInput('An excluded grade criterion cannot contain scored grade-basis evidence.')
  }
  const expectedEvidence = analysisRequirementEvidenceForInput(input)
  if (expectedEvidence.some(item => !item.citations.length)) {
    invalidInput('Every analysis criterion and qualification requires exact frozen saved requirement citations.')
  }
  if (input.requirementEvidence.some(item => item.citations.some(citation => citation.documentId === input.resume.id))) {
    invalidInput('Frozen requirement evidence must be separate from the resume document.')
  }
  if (analysisHash(input.requirementEvidence) !== analysisHash(expectedEvidence)) {
    invalidInput('Frozen requirement evidence must preserve the exact saved requirements, deduplication, and citation order.')
  }
  return input
}

/** Code-resolved quotations still require an exact paragraph and untouched literal text. */
export function buildAnalysisResumeCitations(
  quotes: ModelResumeQuote[], input: RealAnalysisAssessmentInput, stage: AnalysisModelStage = 'assessment',
): Citation[] {
  const diagnostics = analysisResumeCitationDiagnostics(quotes, input)
  if (diagnostics) invalidCitations(diagnostics, stage)
  const paragraphs = new Map(input.resume.paragraphs.map(paragraph => [paragraph.id, paragraph]))
  return quotes.map(value => {
    const paragraph = paragraphs.get(value.paragraphId)
    if (!paragraph) invalidOutput('The cited paragraph is not in the saved resume.', stage, true)
    return {
      documentId: input.resume.id,
      documentVersion: input.resume.version,
      paragraphId: paragraph.id,
      page: paragraph.page,
      heading: paragraph.heading,
      quote: value.quote,
    }
  })
}

function requirementCitations(input: RealAnalysisAssessmentInput, kind: 'criterion' | 'qualification', id: string): Citation[] {
  const evidence = input.requirementEvidence.find(value =>
    value.kind === 'criterion' ? kind === 'criterion' && value.criterionId === id : kind === 'qualification' && value.qualificationId === id)
  if (!evidence) invalidInput('The frozen requirement evidence needed by this analysis is unavailable.')
  return evidence.citations.map(citation => ({ ...citation }))
}

function checkAssessmentLanguage(value: string): void {
  if (/\b(?:context (?:window|limit)|token (?:budget|limit)|model refus(?:ed|al)|service unavailable|processing failed)\b/i.test(value)) {
    invalidOutput('A model or processing failure must not be reported as a completed document-evidence assessment.')
  }
  if (/\b(?:recommend|recommendation)\b.{0,60}\b(?:hiring|hire|reject|shortlist)\b/i.test(value) ||
    /\b(?:hire|reject|shortlist)\s+(?:this|the)\s+(?:candidate|applicant|person)\b/i.test(value) ||
    /\b(?:candidate|applicant|person|they|he|she)\s+(?:lacks?|cannot|can't|is unable|is incapable)\b/i.test(value) ||
    /\b(?:candidate|applicant|person|they|he|she)\s+(?:is|are|meets?)\s+(?:(?:officially|all|the|minimum)\s+)*(?:eligible|ineligible|qualified|unqualified|qualifications|eligibility)\b/i.test(value)) {
    invalidOutput('Analysis must describe document evidence, not personal ability, a hiring recommendation, or official eligibility.',
      'assessment', false, 'policy-language')
  }
}

function withPassageSelections<T>(
  value: unknown, input: RealAnalysisAssessmentInput, catalog: AnalysisEvidenceCatalog, stage: AnalysisModelStage,
  validate: (resolve: (passageId: number) => ModelResumeQuote) => T,
): T {
  try {
    const diagnostics = analysisSelectionCitationDiagnostics(value, input, catalog, stage)
    if (diagnostics) invalidCitations(diagnostics, stage)
    return validate(createAnalysisPassageResolver(catalog, input.resume))
  } catch (error) {
    if (error instanceof AnalysisEvidenceBindingError) {
      throw new AnalysisModelError('internal-error',
        'The saved source-passage binding failed integrity validation. No generated evidence or score was published.', { stage })
    }
    throw error
  }
}

export function validateAnalysisAssessmentSelections(
  value: unknown, input: RealAnalysisAssessmentInput, catalog: AnalysisEvidenceCatalog,
): RealAnalysisAssessmentOutput {
  return withPassageSelections(value, input, catalog, 'assessment', resolve => {
    const parsed = assessmentSelectionSchemaForInput(input, catalog.passages.length).safeParse(value)
    if (!parsed.success) {
      invalidSchema('The analysis model output does not match the exact bounded passage-selection schema or allowed identities.', parsed.error.issues)
    }
    for (const row of parsed.data.criteria) {
      if (row.evidenceStatus === 'not-assessed') {
        if (row.score !== null || !row.limitation) {
          invalidOutput('An unassessed criterion requires a null score and an explicit unusable-source, ambiguous-guidance, or restricted-personal-characteristic blocker. A usable resume with no supporting evidence requires missing, score 0, and no limitation.')
        }
      } else if (row.limitation !== null) {
        invalidOutput('Only a genuinely blocked, not-assessed criterion may carry a limitation; missing evidence requires score 0, no citations, and no limitation.')
      }
      const criterion = input.rubric.criteria.find(criterion => criterion.id === row.criterionId)!
      const personalTrait = isPersonalTraitCriterion(criterion.label, criterion.description)
      if (personalTrait && !notApplicable(input.rubric, criterion.id) &&
        (row.evidenceStatus !== 'not-assessed' || row.limitation?.code !== 'restricted-personal-characteristic')) {
        invalidOutput('A personal-characteristic requirement must remain unscored with a restricted-personal-characteristic blocker for human review.', 'assessment', false, 'policy-language')
      }
    }
    return validateAnalysisAssessment({
      ...parsed.data,
      criteria: parsed.data.criteria.map(row => ({
        ...row, citations: row.citations.map(item => resolve(item.passageId)),
        limitation: row.limitation ? {
          code: row.limitation.code === 'unusable-source' ? 'source-quality' : 'not-assessable',
          message: row.limitation.message,
        } : null,
      })),
      qualifications: parsed.data.qualifications.map(row => ({ ...row, citations: row.citations.map(item => resolve(item.passageId)) })),
    }, input)
  })
}

/** Validate a saved proposal without regenerating its summary, reordering rows, or narrowing legacy limitations. */
export function validateAnalysisAssessmentForReview(
  value: unknown, input: RealAnalysisAssessmentInput,
): RealAnalysisAssessmentOutput {
  const invalid = (message: string): never => {
    throw new AnalysisModelError('invalid-input', message, { stage: 'grounding', reason: 'input-contract' })
  }
  const parsed = analysisAssessmentOutputSchema.safeParse(value)
  if (!parsed.success) {
    throw new AnalysisModelError('invalid-input', 'Grounding review requires an exact bounded saved assessment proposal.', {
      stage: 'grounding', reason: 'input-contract', schemaDiagnostics: analysisSchemaDiagnostics(parsed.error.issues),
    })
  }
  const assessment = parsed.data as RealAnalysisAssessmentOutput
  try {
    calculateAnalysisSummary(input.rubric, assessment)
  } catch (error) {
    if (error instanceof AnalysisModelError) invalid('The proposed assessment must preserve the saved criterion identities, weights, scores, and exclusions.')
    throw error
  }
  if (assessment.qualifications.length !== input.qualifications.length ||
    input.qualifications.some(row => !assessment.qualifications.some(item => item.qualificationId === row.id))) {
    invalid('The proposed assessment must preserve every separate saved qualification.')
  }
  for (const row of [...assessment.criteria, ...assessment.qualifications]) {
    const isCriterion = 'criterionId' in row
    const kind = isCriterion ? 'criterion' : 'qualification'
    const id = isCriterion ? row.criterionId : row.qualificationId
    if (analysisHash(row.requirementCitations) !== analysisHash(requirementCitations(input, kind, id))) {
      invalid('The proposed assessment must preserve the exact ordered frozen requirement citations.')
    }
    if (!unique(row.citations.map(citation => analysisHash(citation))) ||
      row.citations.some(citation => !citationMatchesDocument(citation, input.resume))) {
      throw new AnalysisModelError('invalid-citation', 'The proposed assessment contains duplicate or foreign resume evidence; grounding cannot repair a saved proposal.', {
        stage: 'grounding', reason: 'citation-mismatch',
      })
    }
    const limitation = 'limitation' in row ? row.limitation : undefined
    if (row.evidenceStatus === 'not-assessed') {
      if (!limitation || (isCriterion
        ? limitation.criterionId !== id || limitation.qualificationId !== undefined
        : limitation.qualificationId !== id || limitation.criterionId !== undefined)) {
        invalid('Every unassessed proposal row must retain an explicit limitation scoped only to that requirement.')
      }
    } else if (limitation) {
      invalid('Only an unassessed proposal row may carry a limitation.')
    }
    if (!isCriterion && (row.evidenceStatus === 'missing' && row.citations.length ||
      ['supported', 'partial'].includes(row.evidenceStatus) && !row.citations.length)) {
      invalid('Proposed qualification evidence statuses must agree with their saved citations.')
    }
  }
  const rowLimitations = [...assessment.criteria, ...assessment.qualifications].flatMap(row =>
    'limitation' in row && row.limitation ? [row.limitation] : [])
  if (rowLimitations.some(limitation => !assessment.limitations.some(item => analysisHash(item) === analysisHash(limitation))) ||
    assessment.limitations.some(limitation =>
      limitation.criterionId && limitation.qualificationId ||
      limitation.criterionId && !assessment.criteria.some(row => row.evidenceStatus === 'not-assessed' &&
        row.criterionId === limitation.criterionId && analysisHash(row.limitation) === analysisHash(limitation)) ||
      limitation.qualificationId && !assessment.qualifications.some(row => row.evidenceStatus === 'not-assessed' &&
        row.qualificationId === limitation.qualificationId && analysisHash(row.limitation) === analysisHash(limitation)))) {
    invalid('The proposed assessment must preserve its unassessed row limitations without stale or mismatched requirement scopes.')
  }
  return assessment
}

export function validateAnalysisGroundingSelections(
  value: unknown, input: RealAnalysisAssessmentInput, catalog: AnalysisEvidenceCatalog,
): RealAnalysisGroundingReviewOutput {
  return withPassageSelections(value, input, catalog, 'grounding', resolve => {
    const parsed = groundingSelectionSchemaForInput(input, catalog.passages.length).safeParse(value)
    if (!parsed.success) {
      invalidSchema('The analysis grounding review does not match its exact bounded passage-selection schema or allowed identities.',
        parsed.error.issues, 'grounding')
    }
    return validateAnalysisGroundingReview({
      ...parsed.data,
      issues: parsed.data.issues.map(row => ({ ...row, citations: row.citations.map(item => resolve(item.passageId)) })),
    }, input)
  })
}

export function validateAnalysisAssessment(value: unknown, input: RealAnalysisAssessmentInput): RealAnalysisAssessmentOutput {
  const diagnostics = analysisOutputCitationDiagnostics(value, input, 'assessment')
  if (diagnostics) invalidCitations(diagnostics, 'assessment')
  const parsed = assessmentSchemaForInput(input).safeParse(value)
  if (!parsed.success) {
    const citation = parsed.error.issues.some(issue => issue.path.includes('citations'))
    invalidSchema('The analysis model output does not match the exact bounded assessment schema or allowed identities.',
      parsed.error.issues, 'assessment', citation)
  }
  const result = parsed.data
  if (!unique(result.criteria.map(item => item.criterionId)) || !unique(result.qualifications.map(item => item.qualificationId))) {
    invalidOutput('Analysis must contain exactly one result for each saved criterion and qualification.')
  }
  const criteria: RealCriterionResult[] = input.rubric.criteria.map(criterion => {
    const item = result.criteria.find(row => row.criterionId === criterion.id)
    if (!item) invalidOutput('Analysis is missing a saved criterion.')
    checkAssessmentLanguage(item.rationale)
    if (item.limitation) checkAssessmentLanguage(item.limitation.message)
    const citations = buildAnalysisResumeCitations(item.citations, input)
    const base = {
      criterionId: criterion.id, weight: criterion.weight, rationale: item.rationale,
      requirementCitations: requirementCitations(input, 'criterion', criterion.id),
    }
    if (notApplicable(input.rubric, criterion.id)) {
      if (item.evidenceStatus !== 'not-applicable' || item.score !== null || citations.length || item.limitation !== null) {
        invalidOutput('An excluded grade row must remain not-applicable, unscored, and without resume citations or a limitation.')
      }
      return { ...base, weight: 0, evidenceStatus: 'not-applicable', score: null, citations: [] }
    }
    if (item.evidenceStatus === 'not-applicable') {
      invalidOutput('The model cannot exclude an applicable saved criterion.')
    }
    if (isPersonalTraitCriterion(criterion.label, criterion.description) && item.evidenceStatus !== 'not-assessed') {
      invalidOutput('A personal-characteristic requirement must remain unassessed for human review, never a scored or inferred personal attribute.')
    }
    if (item.evidenceStatus === 'not-assessed') {
      if (item.score !== null || !item.limitation) invalidOutput('An unassessed criterion needs a null score and an explicit document-evidence limitation.')
      return {
        ...base, evidenceStatus: 'not-assessed', score: null, citations,
        limitation: { ...item.limitation, criterionId: criterion.id },
      }
    }
    if (item.limitation !== null) invalidOutput('A scored criterion cannot also carry an unassessed limitation.')
    if (item.evidenceStatus === 'missing') {
      if (item.score !== 0 || citations.length) invalidOutput('Missing document evidence requires a zero score and no purported supporting quotations.')
      return { ...base, evidenceStatus: 'missing', score: 0, citations: [] }
    }
    if (item.score === null || !citations.length) invalidOutput('A supported or partial criterion requires an integer score and exact resume evidence.')
    return {
      ...base, evidenceStatus: item.evidenceStatus, score: item.score as 0 | 1 | 2 | 3 | 4 | 5,
      citations: citations as [Citation, ...Citation[]],
    }
  })
  const qualifications: RealQualificationAssessment[] = input.qualifications.map(qualification => {
    const item = result.qualifications.find(row => row.qualificationId === qualification.id)
    if (!item) invalidOutput('Analysis is missing a saved grade qualification.')
    checkAssessmentLanguage(item.rationale)
    if (item.limitation) checkAssessmentLanguage(item.limitation.message)
    const citations = buildAnalysisResumeCitations(item.citations, input)
    if (item.evidenceStatus === 'not-assessed' ? !item.limitation : item.limitation !== null) {
      invalidOutput('A qualification limitation is required only for an unassessed human-review note.')
    }
    if (item.evidenceStatus === 'missing' && citations.length ||
      ['supported', 'partial'].includes(item.evidenceStatus) && !citations.length) {
      invalidOutput('Qualification evidence status must agree with its exact resume quotations.')
    }
    return {
      qualificationId: qualification.id, evidenceStatus: item.evidenceStatus, rationale: item.rationale,
      citations, requirementCitations: requirementCitations(input, 'qualification', qualification.id),
      ...(item.limitation ? { limitation: { ...item.limitation, qualificationId: qualification.id } } : {}),
    }
  })
  const limitations: AnalysisLimitation[] = [
    ...criteria.flatMap(item => item.evidenceStatus === 'not-assessed' ? [item.limitation] : []),
    ...qualifications.flatMap(item => item.limitation ? [item.limitation] : []),
  ]
  const output: RealAnalysisAssessmentOutput = { criteria, qualifications, summary: '', limitations }
  output.summary = describeAnalysisSummary(calculateAnalysisSummary(input.rubric, output), qualifications.length)
  return output
}

export function calculateAnalysisSummary(
  rubric: RealAnalysisAssessmentInput['rubric'],
  assessment: Pick<RealAnalysisAssessmentOutput, 'criteria' | 'qualifications' | 'limitations'>,
): RealAnalysisResultSummary {
  validateWeights(rubric)
  if (!assessment || !Array.isArray(assessment.criteria) || !Array.isArray(assessment.qualifications) ||
    !Array.isArray(assessment.limitations) || assessment.criteria.length !== rubric.criteria.length ||
    assessment.criteria.some(value => !value || typeof value.criterionId !== 'string') ||
    assessment.qualifications.some(value => !value || typeof value.qualificationId !== 'string' ||
      !['supported', 'partial', 'missing', 'not-assessed'].includes(value.evidenceStatus)) ||
    !unique(assessment.criteria.map(value => value.criterionId)) ||
    !unique(assessment.qualifications.map(value => value.qualificationId))) {
    invalidOutput('A deterministic analysis total requires exactly one validated result per saved criterion.')
  }
  const ordered: RealCriterionResult[] = []
  for (const criterion of rubric.criteria) {
    const item = assessment.criteria.find(value => value.criterionId === criterion.id)
    if (!item || item.weight !== criterion.weight || !Array.isArray(item.citations)) {
      invalidOutput('Analysis totals must use the exact saved criterion identities and unchanged weights.')
    }
    ordered.push(item)
    if (notApplicable(rubric, criterion.id)) {
      if (item.evidenceStatus !== 'not-applicable' || item.score !== null || item.citations.length) {
        invalidOutput('An excluded grade row cannot contribute a score or resume evidence.')
      }
      continue
    }
    if (item.evidenceStatus === 'not-assessed') {
      if (item.score !== null || !item.limitation?.message?.trim()) invalidOutput('Unassessed criteria require a null score and a limitation.')
      continue
    }
    if (!['supported', 'partial', 'missing'].includes(item.evidenceStatus) ||
      !Number.isInteger(item.score) || item.score === null || item.score < 0 || item.score > 5 ||
      item.evidenceStatus === 'missing' && (item.score !== 0 || item.citations.length !== 0) ||
      (item.evidenceStatus === 'supported' || item.evidenceStatus === 'partial') && !item.citations.length) {
      invalidOutput('Analysis totals require consistent evidence statuses and integer scores from zero through five.')
    }
  }
  return summarizeValidatedAnalysis(ordered, assessment.qualifications, assessment.limitations)
}

export function validateAnalysisGroundingReview(
  value: unknown, input: RealAnalysisAssessmentInput,
): RealAnalysisGroundingReviewOutput {
  const diagnostics = analysisOutputCitationDiagnostics(value, input, 'grounding')
  if (diagnostics) invalidCitations(diagnostics, 'grounding')
  const parsed = groundingSchemaForInput(input).safeParse(value)
  if (!parsed.success) {
    const citation = parsed.error.issues.some(issue => issue.path.includes('citations'))
    invalidSchema('The analysis grounding review does not match its exact bounded schema or allowed identities.',
      parsed.error.issues, 'grounding', citation)
  }
  const review = parsed.data
  if (review.outcome === 'supported' ? review.issues.length !== 0 : review.issues.length === 0) {
    invalidOutput('A supported grounding review must have no issues; a non-supported review must explain its findings.', 'grounding')
  }
  const seen = new Set<string>()
  const issues = review.issues.map(item => {
    const key = JSON.stringify([item.code, item.criterionId, item.qualificationId])
    if (seen.has(key) || item.criterionId !== null && item.qualificationId !== null) {
      invalidOutput('Grounding issues must have unique, unambiguous criterion or qualification scopes.', 'grounding')
    }
    seen.add(key)
    return {
      code: item.code, message: item.message,
      ...(item.criterionId !== null ? { criterionId: item.criterionId } : {}),
      ...(item.qualificationId !== null ? { qualificationId: item.qualificationId } : {}),
      citations: buildAnalysisResumeCitations(item.citations, input, 'grounding'),
    }
  })
  return { outcome: review.outcome, issues }
}

export function hashAnalysisAssessment(assessment: RealAnalysisAssessmentOutput): string {
  return analysisAssessmentHash(assessment)
}
