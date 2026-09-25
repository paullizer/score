import { z } from 'zod'
import type { AnalysisModelProvenance } from './real-analyses'
import type { PromptExecutionProvenance } from './prompt-versions'
import { promptHashSchema } from './prompt-versions'

export const ANALYSIS_QC_DIAGNOSTICS_VERSION = 'score-analysis-qc-diagnostics-v1' as const
export const ANALYSIS_QC_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const
export const ANALYSIS_QC_AMBIGUITY_CATEGORIES = [
  'rubric-anchors', 'evidence-scope', 'contradictory-evidence', 'source-clarity', 'criterion-scope',
] as const
export const ANALYSIS_QC_DIAGNOSTIC_LIMITS = {
  maxCriteria: 20, explanationCharacters: 1_200, ambiguityCharacters: 800, maxAmbiguities: 5, maxAlternativeScores: 5,
} as const
const text = (max: number) => z.string().min(1).max(max).regex(/\S/)
const identifier = text(200)
export const qcScoreSchema = z.number().int().min(0).max(5)
export const modelCriterionQcDiagnosticSchema = z.strictObject({
  criterionId: identifier,
  confidence: z.enum(ANALYSIS_QC_CONFIDENCE_LEVELS).nullable(),
  explanation: text(ANALYSIS_QC_DIAGNOSTIC_LIMITS.explanationCharacters),
  ambiguity: z.array(z.strictObject({
    category: z.enum(ANALYSIS_QC_AMBIGUITY_CATEGORIES),
    explanation: text(ANALYSIS_QC_DIAGNOSTIC_LIMITS.ambiguityCharacters),
  })).max(ANALYSIS_QC_DIAGNOSTIC_LIMITS.maxAmbiguities),
  alternativeScores: z.array(qcScoreSchema).max(ANALYSIS_QC_DIAGNOSTIC_LIMITS.maxAlternativeScores),
})
export type ModelCriterionQcDiagnostic = z.infer<typeof modelCriterionQcDiagnosticSchema>
export const criterionQcDiagnosticSchema = modelCriterionQcDiagnosticSchema.extend({
  /** Confidence describes this model-produced rating, never a later normalized/corrected rating. */
  assessedScore: qcScoreSchema.nullable(),
  assessedEvidenceStatus: z.enum(['supported', 'partial', 'missing', 'not-assessed', 'not-applicable']),
}).superRefine((row, ctx) => {
  const issue = (message: string, field?: 'confidence' | 'alternativeScores' | 'ambiguity') =>
    ctx.addIssue({ code: 'custom', message, ...(field ? { path: [field] } : {}) })
  if (row.assessedScore === null ? row.confidence !== null || row.alternativeScores.length > 0 : row.confidence === null) {
    issue('Numeric ratings require confidence; unscored rows require null confidence and no numeric alternatives.', 'confidence')
  }
  if ((row.assessedScore === null) !== ['not-assessed', 'not-applicable'].includes(row.assessedEvidenceStatus) ||
    row.assessedEvidenceStatus === 'missing' && row.assessedScore !== 0) issue('Diagnostic rating and evidence disposition disagree.')
  if (new Set(row.alternativeScores).size !== row.alternativeScores.length ||
    row.alternativeScores.includes(row.assessedScore as number)) issue('Alternative ratings must be distinct and exclude the chosen rating.', 'alternativeScores')
  if (row.alternativeScores.length && !row.ambiguity.length) issue('Alternative ratings require a specific ambiguity explanation.', 'alternativeScores')
  if (new Set(row.ambiguity.map(item => item.category)).size !== row.ambiguity.length) issue('Ambiguity categories must not repeat.', 'ambiguity')
})
export type CriterionQcDiagnostic = z.infer<typeof criterionQcDiagnosticSchema>

/** Fields reported when a model diagnostic row cannot be recorded; all are bounded analysis diagnostic fields. */
export type AnalysisQcDiagnosticField = 'qcDiagnostics' | 'criterionId' | 'confidence' | 'explanation' | 'ambiguity' | 'category' | 'alternativeScores'
export interface AssessedQcRating {
  criterionId: string
  score: number | null
  evidenceStatus: CriterionQcDiagnostic['assessedEvidenceStatus']
}
export interface QcDiagnosticsAcceptance {
  /** Recordable diagnostics for the assessed criteria, in their order. Criteria without a row are Not recorded. */
  criteria: CriterionQcDiagnostic[]
  /** Recorded rows whose formatting was repaired without changing what the model stated. */
  cleanedCriteria: number
  /** Model rows that were not recorded, by zero-based model row index and the first failing field. */
  omitted: { index?: number; field: AnalysisQcDiagnosticField }[]
}

const QC_ROW_FIELDS: readonly AnalysisQcDiagnosticField[] = ['criterionId', 'confidence', 'explanation', 'ambiguity', 'alternativeScores']

function failingField(issues: readonly { path: readonly PropertyKey[] }[]): AnalysisQcDiagnosticField {
  const field = issues[0]?.path[0]
  return QC_ROW_FIELDS.find(value => value === field) ?? 'qcDiagnostics'
}

/**
 * QC diagnostics describe an accepted assessment; they never decide whether its score is published. Code repairs
 * only formatting that cannot change the model's statement: repeated or chosen alternative scores, confidence or
 * alternatives on an unscored row, and repeated ambiguity categories whose explanations still fit when joined. Any
 * other nonconforming row is left unrecorded rather than inventing confidence, ambiguity or alternatives.
 */
export function acceptModelQcDiagnostics(
  value: unknown, assessed: readonly AssessedQcRating[], allowedText: (text: string) => boolean = () => true,
): QcDiagnosticsAcceptance {
  const rows = typeof value === 'object' && value !== null && 'criteria' in value && Array.isArray(value.criteria)
    ? value.criteria as unknown[] : undefined
  if (!rows) return { criteria: [], cleanedCriteria: 0, omitted: [{ field: 'qcDiagnostics' }] }
  const ids = rows.map(row => typeof row === 'object' && row !== null && 'criterionId' in row &&
    typeof row.criterionId === 'string' ? row.criterionId : undefined)
  const accepted = new Map<string, { diagnostic: CriterionQcDiagnostic; cleaned: boolean }>()
  const omitted: QcDiagnosticsAcceptance['omitted'] = []
  rows.forEach((row, index) => {
    const omit = (field: AnalysisQcDiagnosticField) => { omitted.push({ index, field }) }
    const rating = assessed.find(item => item.criterionId === ids[index])
    if (!rating || ids.filter(id => id === rating.criterionId).length !== 1) return omit('criterionId')
    const parsed = modelCriterionQcDiagnosticSchema.safeParse(row)
    if (!parsed.success) return omit(failingField(parsed.error.issues))
    const model = parsed.data
    const unscored = rating.score === null
    const alternativeScores = unscored ? [] : [...new Set(model.alternativeScores)].filter(score => score !== rating.score)
    const confidence = unscored ? null : model.confidence
    const categories = new Map<ModelCriterionQcDiagnostic['ambiguity'][number]['category'], string[]>()
    for (const item of model.ambiguity) categories.set(item.category, [...(categories.get(item.category) ?? []), item.explanation])
    const ambiguity = [...categories].map(([category, explanations]) => ({ category, explanation: explanations.join(' ') }))
    if (ambiguity.some(item => item.explanation.length > ANALYSIS_QC_DIAGNOSTIC_LIMITS.ambiguityCharacters)) return omit('category')
    if (!allowedText(model.explanation)) return omit('explanation')
    if (!ambiguity.every(item => allowedText(item.explanation))) return omit('ambiguity')
    const diagnostic = criterionQcDiagnosticSchema.safeParse({
      ...model, confidence, ambiguity, alternativeScores,
      assessedScore: rating.score, assessedEvidenceStatus: rating.evidenceStatus,
    })
    if (!diagnostic.success) return omit(failingField(diagnostic.error.issues))
    accepted.set(rating.criterionId, {
      diagnostic: diagnostic.data,
      cleaned: confidence !== model.confidence || ambiguity.length !== model.ambiguity.length ||
        alternativeScores.length !== model.alternativeScores.length,
    })
  })
  const recorded = assessed.flatMap(item => {
    const row = accepted.get(item.criterionId)
    return row ? [row] : []
  })
  return {
    criteria: recorded.map(row => row.diagnostic),
    cleanedCriteria: recorded.filter(row => row.cleaned).length,
    omitted,
  }
}

export interface AcceptedAssessmentQcDiagnostics {
  modelCallId: string
  /** The exact model assessment before any code-owned evidence-gap normalization. */
  modelAssessmentSha256: string
  criteria: CriterionQcDiagnostic[]
}
export const analysisQcDiagnosticsReferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  attemptId: z.uuid(),
  modelCallId: z.uuid(),
  resultSha256: promptHashSchema,
  assessmentSha256: promptHashSchema,
  blob: z.strictObject({
    blobName: text(900), contentType: z.literal('application/json'), sha256: promptHashSchema,
    bytes: z.number().int().min(1).max(2 * 1024 * 1024),
  }),
})
export type AnalysisQcDiagnosticsReference = z.infer<typeof analysisQcDiagnosticsReferenceSchema>
export interface AnalysisQcDiagnosticsSidecar {
  schemaVersion: 1
  version: typeof ANALYSIS_QC_DIAGNOSTICS_VERSION
  dataKind: 'real'
  workspaceId: string
  runId: string
  comparisonId: string
  attemptId: string
  createdAt: string
  resultSha256: string
  assessmentSha256: string
  modelAssessmentSha256: string
  manifestSha256: string
  resumeSnapshot: { snapshotId: string; sha256: string }
  targetSnapshot: { snapshotId: string; sha256: string }
  rubric: { id: string; version: number; sha256: string }
  assessmentProvenance: AnalysisModelProvenance & { prompt: PromptExecutionProvenance; modelCallId: string }
  criteria: CriterionQcDiagnostic[]
}
export type CriterionQcDiagnosticContext =
  | { criterionId: string; status: 'recorded' | 'unscored'; diagnostic: CriterionQcDiagnostic }
  | { criterionId: string; status: 'not-recorded'; reason: 'not-captured' | 'different-result' | 'rating-normalized' | 'invalid-diagnostic' }
export type AnalysisQcDiagnosticsContext =
  | { status: 'not-recorded'; label: 'Not recorded'; resultSha256: string; criteria: CriterionQcDiagnosticContext[] }
  | { status: 'recorded'; resultSha256: string; sidecar: AnalysisQcDiagnosticsSidecar; criteria: CriterionQcDiagnosticContext[] }
