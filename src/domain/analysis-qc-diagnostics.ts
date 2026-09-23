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
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (row.assessedScore === null ? row.confidence !== null || row.alternativeScores.length > 0 : row.confidence === null) {
    issue('Numeric ratings require confidence; unscored rows require null confidence and no numeric alternatives.')
  }
  if ((row.assessedScore === null) !== ['not-assessed', 'not-applicable'].includes(row.assessedEvidenceStatus) ||
    row.assessedEvidenceStatus === 'missing' && row.assessedScore !== 0) issue('Diagnostic rating and evidence disposition disagree.')
  if (new Set(row.alternativeScores).size !== row.alternativeScores.length ||
    row.alternativeScores.includes(row.assessedScore as number)) issue('Alternative ratings must be distinct and exclude the chosen rating.')
  if (row.alternativeScores.length && !row.ambiguity.length) issue('Alternative ratings require a specific ambiguity explanation.')
  if (new Set(row.ambiguity.map(item => item.category)).size !== row.ambiguity.length) issue('Ambiguity categories must not repeat.')
})
export type CriterionQcDiagnostic = z.infer<typeof criterionQcDiagnosticSchema>
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
  | { criterionId: string; status: 'not-recorded'; reason: 'not-captured' | 'different-result' | 'rating-normalized' }
export type AnalysisQcDiagnosticsContext =
  | { status: 'not-recorded'; label: 'Not recorded'; resultSha256: string; criteria: CriterionQcDiagnosticContext[] }
  | { status: 'recorded'; resultSha256: string; sidecar: AnalysisQcDiagnosticsSidecar; criteria: CriterionQcDiagnosticContext[] }
