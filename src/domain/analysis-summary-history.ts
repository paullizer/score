import { z } from 'zod'
import type { AnalysisModelProvenance } from './real-analyses'
import { ANALYSIS_DIAGNOSTIC_REASONS } from './analysis-diagnostics'
import { processingSettingsSnapshotSchema } from './admin-settings-schema'
import { MODEL_TASK_IDS } from './admin-settings-tasks'

export const SUMMARY_PIPELINE_VERSION = 'score-analysis-summaries-v2'
export const SUMMARY_LIMITS = {
  rounds: 3,
  textCharacters: 16_000,
  overviewCharacters: 4_000,
  paragraphs: 16,
  totalCharacters: 100_000,
  issues: 16,
  historyPageSize: 12,
  checkpointBytes: 4 * 1024 * 1024,
} as const

const id = z.string().min(1).max(200)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.iso.datetime()
const nonempty = (limit: number) => z.string().min(1).max(limit).refine(value => Boolean(value.trim()))

// These are resource bounds, not a prescribed sentence count or writing style.
export const summaryCandidateContentSchema = z.strictObject({
  text: nonempty(SUMMARY_LIMITS.textCharacters),
  overview: nonempty(SUMMARY_LIMITS.overviewCharacters),
})
export const summaryTargetContentSchema = z.strictObject({
  paragraphs: z.array(nonempty(SUMMARY_LIMITS.textCharacters)).min(1).max(SUMMARY_LIMITS.paragraphs)
    .refine(value => value.join('\n\n').length <= SUMMARY_LIMITS.totalCharacters,
      'The complete summary exceeds its technical storage bound.'),
})
export const summaryIssueSchema = z.strictObject({
  code: z.enum(['unsupported-claim', 'unsupported-number', 'misleading-status', 'prohibited-judgment']),
  message: nonempty(2_400),
  field: z.enum(['text', 'overview', 'paragraphs', 'summary']),
  paragraphIndex: z.number().int().min(0).max(SUMMARY_LIMITS.paragraphs - 1).nullable(),
})
export const summaryReviewOutputSchema = z.strictObject({
  outcome: z.enum(['supported', 'needs-correction', 'unsupported']),
  issues: z.array(summaryIssueSchema).max(SUMMARY_LIMITS.issues),
})
export const summaryApprovalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('automatic') }),
  z.strictObject({
    kind: z.literal('manual'), approvedAt: timestamp, approvedBy: id,
    reviewOutcome: z.enum(['supported', 'needs-correction', 'unsupported', 'not-reviewed']),
    issues: z.array(summaryIssueSchema).max(SUMMARY_LIMITS.issues),
  }),
])
export const summaryDraftSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('candidate'), ...summaryCandidateContentSchema.shape }),
  z.strictObject({ kind: z.literal('target'), ...summaryTargetContentSchema.shape }),
  z.strictObject({ kind: z.literal('reduction'), ...summaryTargetContentSchema.shape }),
])
export const summaryModelProvenanceSchema = z.strictObject({
  model: id, deployment: id, promptVersion: id, schemaVersion: id,
  startedAt: timestamp, completedAt: timestamp, inputCharacters: z.number().int().min(0),
  settingsRevision: id.optional(), task: z.enum(MODEL_TASK_IDS).optional(),
})
export const summaryReviewSchema = summaryReviewOutputSchema.extend({
  id: z.string().uuid(), modelCallId: z.string().uuid(),
  inputFingerprint: hash, outputSha256: hash, provenance: summaryModelProvenanceSchema,
})
export const summaryHistoryReferenceSchema = z.strictObject({
  id: z.string().uuid(), generationId: z.string().uuid(), createdAt: timestamp,
  blob: z.strictObject({
    blobName: z.string().min(1).max(700), contentType: z.literal('application/json'),
    sha256: hash, bytes: z.number().int().min(1).max(SUMMARY_LIMITS.checkpointBytes),
  }),
})
export const summaryStepSchema = z.strictObject({
  scopeId: z.string().regex(/^(?:final|reduction-[a-f0-9]{64})$/),
  sourceFingerprint: hash,
  round: z.number().int().min(1).max(SUMMARY_LIMITS.rounds),
  phase: z.enum(['started', 'generated', 'reviewed', 'failed']),
  draft: summaryDraftSchema.optional(),
  outputSha256: hash.optional(),
  modelCallId: z.string().uuid().optional(),
  generation: summaryModelProvenanceSchema.optional(),
  review: summaryReviewSchema.optional(),
  error: z.strictObject({
    code: z.enum(['invalid-input', 'stale-input', 'snapshot-unavailable', 'snapshot-invalid', 'context-limit',
      'invalid-model-output', 'invalid-citation', 'grounding-failed', 'service-unavailable', 'storage-error',
      'timeout', 'internal-error', 'dependency-failed']),
    stage: z.enum(['dependencies', 'candidate-generation', 'target-generation', 'grounding', 'publication']),
    message: nonempty(2_000), retryable: z.boolean(),
  }).optional(),
})
export const summaryHistoryEntrySchema = summaryStepSchema.extend({
  schemaVersion: z.literal(1), dataKind: z.literal('real'),
  id: z.string().uuid(), workspaceId: id, runId: id, targetId: id,
  kind: z.enum(['candidate', 'target']), subjectId: id,
  generationId: z.string().uuid(), attemptId: z.string().uuid(),
  inputFingerprint: hash, manifestSha256: hash, createdAt: timestamp,
  previous: summaryHistoryReferenceSchema.optional(),
  processingSettings: processingSettingsSnapshotSchema.optional(),
})
export const summaryHistoryPageSchema = z.strictObject({
  schemaVersion: z.literal(1), workspaceId: id, runId: id,
  kind: z.enum(['candidate', 'target']), subjectId: id,
  etag: z.string().min(1).max(1_024), inputFingerprint: hash.nullable(),
  entries: z.array(summaryHistoryEntrySchema).max(SUMMARY_LIMITS.historyPageSize),
  continuationToken: z.string().min(1).max(16 * 1024).optional(),
  capabilities: z.strictObject({ canPublish: z.boolean(), canRetry: z.boolean() }),
})
export const publishSummaryDraftInputSchema = z.strictObject({
  generationId: z.string().uuid(),
  round: z.number().int().min(1).max(SUMMARY_LIMITS.rounds),
  outputSha256: hash,
})
export const summaryDiagnosticSchema = z.strictObject({
  reason: z.enum([...ANALYSIS_DIAGNOSTIC_REASONS, 'factual-review', 'history-write-failed']).optional(),
  round: z.number().int().min(1).max(SUMMARY_LIMITS.rounds).optional(),
  modelCallId: z.string().uuid().optional(),
  issueCount: z.number().int().min(0).max(SUMMARY_LIMITS.issues).optional(),
})

export type AnalysisSummaryIssue = z.infer<typeof summaryIssueSchema>
export type AnalysisSummaryApproval = z.infer<typeof summaryApprovalSchema>
export type AnalysisSummaryDraft = z.infer<typeof summaryDraftSchema>
export type AnalysisSummaryReview = z.infer<typeof summaryReviewSchema>
export type AnalysisSummaryStep = z.infer<typeof summaryStepSchema>
export type AnalysisSummaryHistoryReference = z.infer<typeof summaryHistoryReferenceSchema>
export type AnalysisSummaryHistoryEntry = z.infer<typeof summaryHistoryEntrySchema>
export type AnalysisSummaryHistoryPage = z.infer<typeof summaryHistoryPageSchema>
export type PublishSummaryDraftInput = z.infer<typeof publishSummaryDraftInputSchema>
export type AnalysisSummarySubject = { kind: 'candidate' | 'target'; subjectId: string }
export type AnalysisSummaryDiagnostic = z.infer<typeof summaryDiagnosticSchema>

export interface AnalysisSummaryPublicationMetadata {
  summaryVersion?: 2
  approval?: AnalysisSummaryApproval
}

export function summaryDraftCharacters(draft: AnalysisSummaryDraft): number {
  return draft.kind === 'candidate' ? draft.text.length + draft.overview.length : draft.paragraphs.join('\n\n').length
}

export function summaryIssueMatchesDraft(issue: AnalysisSummaryIssue, draft: AnalysisSummaryDraft): boolean {
  if (issue.field === 'summary') return issue.paragraphIndex === null
  if (draft.kind === 'candidate') {
    return (issue.field === 'text' || issue.field === 'overview') && issue.paragraphIndex === null
  }
  return issue.field === 'paragraphs' &&
    (issue.paragraphIndex === null || issue.paragraphIndex < draft.paragraphs.length)
}

export function summaryIssueDisclosures(value: AnalysisSummaryPublicationMetadata): string[] {
  return value.approval?.kind === 'manual'
    ? [`Manually approved summary. Automated review: ${value.approval.reviewOutcome}.`,
      ...value.approval.issues.map(issue => `Known issue: ${issue.message}`)]
    : []
}

export interface AnalysisSummaryGenerated {
  draft: AnalysisSummaryDraft
  generation: AnalysisModelProvenance
  outputSha256: string
  reviews: AnalysisSummaryReview[]
  round: number
}
