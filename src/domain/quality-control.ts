import { z } from 'zod'
import { PROMPT_REGISTRY_LIMITS } from './prompt-versions'
import type { RealAnalysisComparisonDetail } from './real-analyses'

export const QC_LIMITS = {
  criteria: 20,
  reasonCharacters: 2000,
  pageSize: 50,
  batchComparisons: 500,
  planCases: 25,
  selectedReviews: 100,
  guidanceCharacters: PROMPT_REGISTRY_LIMITS.guidanceCharacters,
  activationReasonCharacters: PROMPT_REGISTRY_LIMITS.reasonCharacters,
  artifactBytes: 16 * 1024 * 1024,
} as const

export const qcIdentifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/)
export const qcHash = z.string().regex(/^[a-f0-9]{64}$/)
export const qcComparisonRefSchema = z.strictObject({
  runId: qcIdentifier,
  comparisonId: qcIdentifier,
  resultRevision: qcIdentifier,
  resultSha256: qcHash,
})
export type QcComparisonRef = z.infer<typeof qcComparisonRefSchema>

export const QC_ISSUE_KINDS = ['scoring', 'evidence', 'rubric-anchors', 'criterion-scope'] as const
const reason = z.string().max(QC_LIMITS.reasonCharacters)
const recommendation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('score'), score: z.number().int().min(0).max(5) }),
  z.strictObject({ kind: z.enum(['not-assessed', 'not-applicable']) }),
])
export const qcFeedbackDraftSchema = z.strictObject({
  criterionId: qcIdentifier,
  decision: z.enum(['agree', 'disagree', 'unable-to-judge']),
  reason,
  recommendation: recommendation.nullable(),
  issues: z.array(z.enum(QC_ISSUE_KINDS)).max(QC_ISSUE_KINDS.length)
    .refine(values => new Set(values).size === values.length, 'Select each issue only once.'),
  evidenceParagraphIds: z.array(qcIdentifier).max(8)
    .refine(values => new Set(values).size === values.length, 'Select each evidence paragraph only once.'),
})
export const qcFeedbackSchema = qcFeedbackDraftSchema.superRefine((value, context) => {
  if (value.decision !== 'agree' && !value.reason.trim()) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Explain the disagreement or why you cannot judge.' })
  }
  if (value.decision === 'disagree' && value.recommendation === null) {
    context.addIssue({ code: 'custom', path: ['recommendation'], message: 'Propose a rating or an explicit unscored disposition.' })
  }
  if (value.decision !== 'disagree' && value.recommendation !== null) {
    context.addIssue({ code: 'custom', path: ['recommendation'], message: 'Only disagreements carry a replacement recommendation.' })
  }
})
export type QcCriterionFeedback = z.infer<typeof qcFeedbackSchema>

export const qcReviewDraftInputSchema = z.strictObject({
  scope: qcComparisonRefSchema,
  feedback: z.array(qcFeedbackDraftSchema).max(QC_LIMITS.criteria)
    .refine(values => new Set(values.map(value => value.criterionId)).size === values.length, 'Each criterion may be reviewed once.'),
})
export const qcReviewInputSchema = qcReviewDraftInputSchema.extend({
  feedback: z.array(qcFeedbackSchema).max(QC_LIMITS.criteria)
    .refine(values => new Set(values.map(value => value.criterionId)).size === values.length, 'Each criterion may be reviewed once.'),
})
export type QcReviewInput = z.infer<typeof qcReviewInputSchema>

export interface QcActor {
  principalId: string
  name: string
}
export interface QcRecordBase {
  id: string
  workspaceId: string
  createdAt: string
  updatedAt: string
}
export interface QcReviewHead extends QcRecordBase {
  recordType: 'qc-review'
  scope: QcComparisonRef
  author: QcActor
  feedback: QcCriterionFeedback[]
  submittedId: string | null
  submissionNumber: number
  peerExposedAt: string | null
  lastRequestId: string
  lastRequestHash: string
}
export interface QcReviewSubmission extends QcRecordBase {
  recordType: 'qc-submission'
  headId: string
  scope: QcComparisonRef
  author: QcActor
  feedback: QcCriterionFeedback[]
  submissionNumber: number
  peerIndependent: boolean
  peerExposedAt: string | null
  requestId: string
  requestHash: string
}
export interface QcBatchRecord extends QcRecordBase {
  recordType: 'qc-batch'
  name: string
  createdBy: QcActor
  comparisons: QcComparisonRef[]
}
export interface QcControl extends QcRecordBase {
  recordType: 'qc-control'
  runId?: string
  state: 'active' | 'archived' | 'deleting' | 'deleted'
}
export interface VersionedQc<T> { record: T; etag: string }
export interface QcPage<T> { items: VersionedQc<T>[]; continuationToken?: string }
export interface QcBlobReference { name: string; sha256: string; bytes: number }

export interface QcCriterionDiagnostic {
  criterionId: string
  confidence: 'low' | 'medium' | 'high' | null
  explanation: string
  ambiguities: { kind: string; message: string }[]
  alternativeScores: number[]
}
export interface QcComparisonContext {
  workspaceId: string
  scope: QcComparisonRef
  analysis: RealAnalysisComparisonDetail
  writable: boolean
  isCoordinator: boolean
  canSeePeers: boolean
  myReview: VersionedQc<QcReviewHead> | null
  submissionCount: number
  diagnostics: {
    status: 'recorded' | 'not-recorded' | 'historical'
    message: string | null
    criteria: QcCriterionDiagnostic[]
  }
}
export interface QcPeerFeedback {
  scope: QcComparisonRef
  submissions: QcReviewSubmission[]
  continuationToken?: string
  coordinatorView: boolean
}
export interface QcCapabilities {
  reviews: boolean
  improvements: boolean
  /** Gates new QC mutations, not saved reads or cancellation of accepted work. */
  admissionEnabled: boolean
  applicationAdmin: boolean
  coordinator: boolean
  writable: boolean
  message: string | null
}
export const qcBatchInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  comparisons: z.array(qcComparisonRefSchema).min(1).max(QC_LIMITS.batchComparisons)
    .refine(values => new Set(values.map(qcScopeKey)).size === values.length, 'A comparison result may appear only once.'),
})

export function qcScopeKey(scope: QcComparisonRef): string {
  return `${scope.runId}:${scope.comparisonId}:${scope.resultRevision}:${scope.resultSha256}`
}

export function qcReviewReady(feedback: QcCriterionFeedback[], criterionIds: readonly string[]): boolean {
  return feedback.length === criterionIds.length && new Set(feedback.map(row => row.criterionId)).size === feedback.length &&
    feedback.every(row => criterionIds.includes(row.criterionId) && qcFeedbackSchema.safeParse(row).success)
}
