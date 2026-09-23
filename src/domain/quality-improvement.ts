import { z } from 'zod'
import type { ProcessingSettingsSnapshot } from './admin-settings'
import type { RealAnalysisComparisonDetail, RealAnalysisAssessmentOutput, RealAnalysisResultSummary } from './real-analyses'
import type { GradeCriterion, GradeIssue, GradeQualification, ReferenceDocument } from './real-grades'
import type { Citation } from './types'
import { promptGuidanceSchema } from './prompt-versions'
import type { QcActor, QcBlobReference, QcComparisonRef, QcRecordBase, QcReviewSubmission } from './quality-control'
import { QC_LIMITS, qcComparisonRefSchema, qcIdentifier } from './quality-control'

export const QC_PROMPT_FAMILIES = ['jobRubric', 'gradeCompetencies', 'gradeDraft', 'assessment'] as const
export type QcPromptFamily = typeof QC_PROMPT_FAMILIES[number]
export const qcPromptChangeSchema = z.strictObject({
  familyId: z.enum(QC_PROMPT_FAMILIES),
  guidance: promptGuidanceSchema.trim(),
  reason: z.string().trim().min(1).max(QC_LIMITS.reasonCharacters),
})
export type QcPromptChange = z.infer<typeof qcPromptChangeSchema>
export const qcPromptActivationReasonSchema = z.string().trim().min(1, 'Provide an administrator rationale.')
  .max(QC_LIMITS.activationReasonCharacters, `Use at most ${QC_LIMITS.activationReasonCharacters} characters for an activation or restore rationale.`)
export interface QcPromptSet {
  revision: string
  etag: string
  guidance: Record<QcPromptFamily, string>
}

export const qcCaseSelectionSchema = z.strictObject({
  scope: qcComparisonRefSchema,
  reviewIds: z.array(qcIdentifier).max(QC_LIMITS.selectedReviews)
    .refine(values => new Set(values).size === values.length),
  purpose: z.enum(['drafting', 'holdout']),
  note: z.string().max(QC_LIMITS.reasonCharacters),
  referenceDecisions: z.array(z.strictObject({
    criterionId: qcIdentifier,
    score: z.number().int().min(0).max(5).nullable(),
    reason: z.string().trim().min(1).max(QC_LIMITS.reasonCharacters),
  })).max(QC_LIMITS.criteria),
})
export type QcCaseSelection = z.infer<typeof qcCaseSelectionSchema>
export const qcPlanInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(4000),
  cases: z.array(qcCaseSelectionSchema).min(1).max(QC_LIMITS.planCases),
  excludedFeedback: z.array(z.strictObject({
    reviewId: qcIdentifier, reason: z.string().trim().min(1).max(QC_LIMITS.reasonCharacters),
  })).max(QC_LIMITS.selectedReviews),
}).superRefine((value, context) => {
  const scopes = value.cases.map(item => `${item.scope.comparisonId}:${item.scope.resultSha256}`)
  if (new Set(scopes).size !== scopes.length) context.addIssue({ code: 'custom', path: ['cases'], message: 'Select each exact result only once.' })
  if (value.cases.reduce((count, item) => count + item.reviewIds.length, 0) > QC_LIMITS.selectedReviews) {
    context.addIssue({ code: 'custom', path: ['cases'], message: `Select at most ${QC_LIMITS.selectedReviews} submitted reviews.` })
  }
  if (!value.cases.some(item => item.purpose === 'drafting' && item.reviewIds.length > 0)) {
    context.addIssue({ code: 'custom', path: ['cases'], message: 'Select submitted feedback for at least one drafting case.' })
  }
})
export type QcPlanInput = z.infer<typeof qcPlanInputSchema>
export const qcPlanProposalSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  findings: z.array(z.strictObject({
    description: z.string().trim().min(1).max(2000),
    reviewIds: z.array(qcIdentifier).min(1).max(QC_LIMITS.selectedReviews),
  })).min(1).max(30),
  disagreements: z.array(z.string().trim().min(1).max(2000)).max(30),
  changes: z.array(qcPromptChangeSchema).min(1).max(QC_PROMPT_FAMILIES.length)
    .refine(values => new Set(values.map(value => value.familyId)).size === values.length),
  expectedEffects: z.string().trim().min(1).max(4000),
  risks: z.string().trim().min(1).max(4000),
})
export type QcPlanProposal = z.infer<typeof qcPlanProposalSchema>
export interface QcPlanRecord extends QcRecordBase {
  recordType: 'qc-plan'
  name: string
  objective: string
  createdBy: QcActor
  revision: number
  cases: QcCaseSelection[]
  excludedFeedback: QcPlanInput['excludedFeedback']
  casePack: QcBlobReference
  baseline: QcPromptSet
  processingSettings: ProcessingSettingsSnapshot
  proposal: QcPlanProposal | null
  status: 'draft' | 'planning' | 'evaluating' | 'ready' | 'failed' | 'cancelled' | 'activated' | 'invalidated'
  workId: string | null
  evaluation: QcBlobReference | null
  activatedRevision: string | null
  error: string | null
  lastRequestId: string
  lastRequestHash: string
}
export interface QcPlanRevision extends QcRecordBase {
  recordType: 'qc-plan-revision'
  planId: string
  revision: number
  value: QcPlanRecord
}
export interface QcCasePack {
  schemaVersion: 1
  workspaceId: string
  planId: string
  createdBy: QcActor
  createdAt: string
  cases: {
    selection: QcCaseSelection
    analysis: RealAnalysisComparisonDetail
    reviews: QcReviewSubmission[]
    references: ReferenceDocument[]
  }[]
}
export interface QcTrialResult {
  status: 'complete' | 'failed'
  error: string | null
  assessment?: RealAnalysisAssessmentOutput
  summary?: RealAnalysisResultSummary
  rubric?: {
    criteria: {
      id: string
      label: string
      description: string
      weight: number
      guidance: string
      sourceCitations?: Citation[]
      gradeBasis?: Citation[]
      competencyId?: string
      support?: GradeCriterion['support']
      interpretation?: string
    }[]
    description: string
    qualifications?: GradeQualification[]
    issues?: GradeIssue[]
    warnings?: string[]
  }
  findings: string[]
  reviewedCriteria: number
  exactAgreements: number
  absoluteDifference: number
}
export interface QcEvaluation {
  schemaVersion: 1
  workspaceId: string
  planId: string
  planRevision: number
  planHash: string
  baselineRevision: string
  settingsHash: string
  candidateHash: string
  createdAt: string
  completedAt: string
  cases: {
    scope: QcComparisonRef
    purpose: 'drafting' | 'holdout'
    familyId: QcPromptFamily
    baseline: QcTrialResult
    candidate: QcTrialResult
  }[]
  eligible: boolean
  limitations: string[]
}
export interface QcWorkRecord extends QcRecordBase {
  recordType: 'qc-work'
  planId: string
  planRevision: number
  kind: 'plan' | 'evaluation'
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'
  requestedBy: QcActor
  requestId: string
  requestHash: string
  attempts: number
  lease: { id: string; expiresAt: string } | null
  nextAttemptAt: string | null
  checkpoint: QcBlobReference | null
  error: string | null
}
export interface QcTrialScope {
  pairs: Pick<QcEvaluation['cases'][number], 'scope' | 'purpose' | 'familyId'>[]
  baselineTrials: number
  candidateTrials: number
  unsupportedFamilies: QcPromptFamily[]
}
export interface QcPlanDetail {
  plan: QcPlanRecord
  etag: string
  evaluation: QcEvaluation | null
  trialScope?: QcTrialScope
  canEdit: boolean
  canCancel?: boolean
  canActivate: boolean
  work: QcWorkRecord | null
}
export interface QcPromptHistoryEntry {
  revision: string
  createdAt: string
  actor: string
  reason: string
  guidance: Record<QcPromptFamily, string>
}
