import { ANALYSIS_LIMITS } from './real-analyses'
import type { ProcessingSettingsSnapshot, ReasoningEffort } from './admin-settings'
import type {
  AnalysisEntityBase,
  AnalysisModelProvenance,
  AnalysisProcessingErrorCode,
  AnalysisWorkState,
  RealAnalysisAssessmentInput,
  RealAnalysisComparisonStatus,
  RealAnalysisResult,
} from './real-analyses'
import type { ImmutableJsonBlobReference } from './real-resumes'
import type {
  AnalysisSummaryApproval, AnalysisSummaryDiagnostic, AnalysisSummaryHistoryReference, AnalysisSummaryPublicationMetadata,
} from './analysis-summary-history'

export const ANALYSIS_NARRATIVE_SCHEMA_VERSION = 1 as const

export const ANALYSIS_NARRATIVE_PROMPT_VERSIONS = {
  candidate: 'score-analysis-candidate-narrative-v1',
  target: 'score-analysis-target-narrative-v1',
  grounding: 'score-analysis-narrative-grounding-v1',
} as const

export const ANALYSIS_NARRATIVE_MODEL_SCHEMA_VERSIONS = {
  candidate: 'analysis-candidate-narrative-v1',
  target: 'analysis-target-narrative-v1',
  grounding: 'analysis-narrative-grounding-v1',
} as const

// Validate/repair at generation time; renderers must not clip prose or append ellipses.
export const ANALYSIS_NARRATIVE_LIMITS = {
  maxComparisons: ANALYSIS_LIMITS.maxComparisons,
  maxAutomaticAttempts: ANALYSIS_LIMITS.maxAutomaticAttempts,
  maxOutputCorrections: ANALYSIS_LIMITS.maxOutputCorrections,
  candidateMinSentences: 3,
  candidateMaxSentences: 4,
  candidateMaxCharacters: 900,
  overviewSentences: 1,
  overviewMaxCharacters: 220,
  targetMinParagraphs: 1,
  targetMaxParagraphs: 3,
  targetParagraphMaxCharacters: 900,
  targetMaxCharacters: 2400,
  maxClaims: 32,
  maxReferencesPerClaim: ANALYSIS_LIMITS.maxComparisons,
} as const

export type AnalysisNarrativeWorkStatus = 'waiting' | 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'
export type AnalysisNarrativeStatus = AnalysisNarrativeWorkStatus | 'missing' | 'stale' | 'not-required'
export type AnalysisNarrativeWaitReason = 'scoring' | 'candidate-narratives'
export type AnalysisNarrativeGenerationMode = 'missing' | 'all'
export type AnalysisNarrativeGenerationReason = AnalysisNarrativeGenerationMode | 'comparison-completed' | 'comparison-changed'

export type AnalysisNarrativeWorkHealthState =
  | 'waiting-prerequisites' | 'awaiting-worker' | 'retry-scheduled' | 'throttled'
  | 'running' | 'interrupted' | 'failed' | 'inactive'

// Read-only work observations, never persisted statuses or publication/readiness inputs.
export interface AnalysisNarrativeWorkHealth {
  state: AnalysisNarrativeWorkHealthState
  requestedAt: string
  lastActivityAt: string
  leaseExpiresAt: string | null
  attempt: number
  nextEligibleAt: string | null
  capturedSettings: {
    revision: string
    // The accepted generation binding, not a claim about the model used by a completed call.
    modelName: string | null
    reasoningEffort: ReasoningEffort | null
  }
}

export interface AnalysisNarrativeSnapshotIdentity {
  snapshotId: string
  sha256: string
}

export interface AnalysisNarrativeRevision {
  // Real revisions are immutable artifact byte hashes.
  revision: string
  inputFingerprint: string
}

export interface AnalysisNarrativePublishedVersion extends AnalysisNarrativeRevision {
  generationId: string
  publishedAt: string
}

export interface AnalysisCandidateNarrativeContent extends AnalysisSummaryPublicationMetadata {
  // Three or four complete sentences; scores remain in the unchanged scoring result.
  text: string
  // One complete sentence generated and independently reviewed together with text.
  overview: string
}

export interface AnalysisTargetNarrativeContent extends AnalysisSummaryPublicationMetadata {
  paragraphs: string[]
}

export interface RealAnalysisCandidateNarrative extends AnalysisCandidateNarrativeContent, AnalysisNarrativePublishedVersion {
  dataKind: 'real'
}

export interface RealAnalysisTargetNarrative extends AnalysisTargetNarrativeContent, AnalysisNarrativePublishedVersion {
  dataKind: 'real'
}

export type ReadyAnalysisCandidateNarrative = RealAnalysisCandidateNarrative
export type ReadyAnalysisTargetNarrative = RealAnalysisTargetNarrative

export interface AnalysisNarrativeCurrentState {
  status: AnalysisNarrativeStatus
  generationId: string | null
  inputFingerprint: string | null
  published?: AnalysisNarrativePublishedVersion | null
}

export interface AnalysisNarrativeInputBindingBase {
  workspaceId: string
  runId: string
  manifestSha256: string
  targetId: string
  targetSnapshot: AnalysisNarrativeSnapshotIdentity
}

export interface AnalysisCandidateNarrativeInputBinding extends AnalysisNarrativeInputBindingBase {
  kind: 'candidate'
  comparisonId: string
  resumeSnapshot: AnalysisNarrativeSnapshotIdentity
  resultSha256: string
}

export interface AnalysisTargetNarrativeComparisonBinding {
  comparisonId: string
  status: RealAnalysisComparisonStatus
  resumeSnapshot: AnalysisNarrativeSnapshotIdentity
  resultSha256: string | null
  // Expected candidate fingerprint computed from the exact saved candidate input binding.
  candidateInputFingerprint: string | null
  narrative: AnalysisNarrativeCurrentState | null
}

export interface AnalysisTargetNarrativeInputBinding extends AnalysisNarrativeInputBindingBase {
  kind: 'target'
  // ALL manifest comparisons for this target, sorted by comparisonId, including non-complete pairs.
  // Hash the entire binding, including desired generations and prior published revisions, never top-N.
  comparisons: AnalysisTargetNarrativeComparisonBinding[]
}

export type AnalysisNarrativeInputBinding = AnalysisCandidateNarrativeInputBinding | AnalysisTargetNarrativeInputBinding

export type AnalysisNarrativeEvidenceReference =
  | { kind: 'criterion'; comparisonId: string; criterionId: string }
  | { kind: 'qualification'; comparisonId: string; qualificationId: string }
  | { kind: 'limitation'; comparisonId: string; limitationIndex: number }
  | { kind: 'coverage' | 'overall' | 'status'; comparisonId: string }

export type AnalysisNarrativeClaimLocation =
  | { field: 'text' | 'overview'; sentenceIndex: number }
  | { field: 'paragraphs'; paragraphIndex: number; sentenceIndex: number }

export interface AnalysisNarrativeClaim {
  id: string
  location: AnalysisNarrativeClaimLocation
  references: AnalysisNarrativeEvidenceReference[]
}

// All source, assessment and prior narrative text is untrusted data, never model instructions.
// Prose must not invent scores, recite score fractions, rank across targets, recommend hiring,
// infer protected traits, or claim official eligibility. Material limitations must survive synthesis.
export interface AnalysisCandidateNarrativeModelInput {
  binding: AnalysisCandidateNarrativeInputBinding
  inputFingerprint: string
  source: RealAnalysisAssessmentInput
  result: RealAnalysisResult
}

export interface AnalysisTargetNarrativeCandidateInput {
  binding: AnalysisCandidateNarrativeInputBinding
  result: RealAnalysisResult
  narrative: RealAnalysisCandidateNarrative
}

export interface AnalysisTargetNarrativeModelInput {
  binding: AnalysisTargetNarrativeInputBinding
  inputFingerprint: string
  target: Omit<RealAnalysisAssessmentInput, 'resume'>
  // Every completed comparison, not just featured candidates. Use byte-budgeted reduction if needed.
  candidates: AnalysisTargetNarrativeCandidateInput[]
}

export interface AnalysisCandidateNarrativeModelOutput extends AnalysisCandidateNarrativeContent {
  claims: AnalysisNarrativeClaim[]
}

export interface AnalysisTargetNarrativeModelOutput extends AnalysisTargetNarrativeContent {
  claims: AnalysisNarrativeClaim[]
}

export type AnalysisNarrativeGroundingReviewInput =
  | { kind: 'candidate'; input: AnalysisCandidateNarrativeModelInput; output: AnalysisCandidateNarrativeModelOutput }
  | { kind: 'target'; input: AnalysisTargetNarrativeModelInput; output: AnalysisTargetNarrativeModelOutput }

export interface AnalysisNarrativeGroundingIssue {
  code: string
  message: string
  claimId?: string
  references: AnalysisNarrativeEvidenceReference[]
}

export interface AnalysisNarrativeGroundingReviewOutput {
  outcome: 'supported' | 'needs-correction' | 'unsupported'
  issues: AnalysisNarrativeGroundingIssue[]
}

export interface AnalysisNarrativeGroundingReview extends AnalysisNarrativeGroundingReviewOutput {
  id: string
  inputFingerprint: string
  outputSha256: string
  provenance: AnalysisModelProvenance
}

export interface AnalysisNarrativeSynthesisStep {
  comparisonIds: string[]
  inputFingerprint: string
  outputSha256: string
  provenance: AnalysisModelProvenance
}

export interface AnalysisNarrativeProvenance {
  attemptId: string
  outputSha256: string
  generation: AnalysisModelProvenance
  // Automated publication requires exact-output support; v2 manual approval retains the original verdict.
  groundingReviews: AnalysisNarrativeGroundingReview[]
  correctionCount: number
  synthesis?: AnalysisNarrativeSynthesisStep[]
}

// Private store metadata only. revision must equal blob.sha256; never return blob names in read DTOs.
export interface AnalysisNarrativePublicationReference extends AnalysisNarrativePublishedVersion {
  blob: ImmutableJsonBlobReference
}

export interface AnalysisNarrativeArtifactBase {
  schemaVersion: typeof ANALYSIS_NARRATIVE_SCHEMA_VERSION | 2
  dataKind: 'real'
  createdAt: string
  generationId: string
  requestId: string
  inputFingerprint: string
  humanReviewRequired: true
  provenance: AnalysisNarrativeProvenance
  // Older immutable versions remain reachable without an unbounded history array in a work record.
  previousPublication?: AnalysisNarrativePublicationReference
  approval?: AnalysisSummaryApproval
  history?: AnalysisSummaryHistoryReference
  processingSettings?: ProcessingSettingsSnapshot
}

export interface RealAnalysisCandidateNarrativeArtifact extends AnalysisNarrativeArtifactBase, AnalysisCandidateNarrativeModelOutput {
  kind: 'candidate'
  binding: AnalysisCandidateNarrativeInputBinding
}

export interface RealAnalysisTargetNarrativeArtifact extends AnalysisNarrativeArtifactBase, AnalysisTargetNarrativeModelOutput {
  kind: 'target'
  binding: AnalysisTargetNarrativeInputBinding
}

export type RealAnalysisNarrativeArtifact = RealAnalysisCandidateNarrativeArtifact | RealAnalysisTargetNarrativeArtifact

export interface AnalysisNarrativeProcessingError {
  code: AnalysisProcessingErrorCode | 'dependency-failed'
  stage: 'dependencies' | 'candidate-generation' | 'target-generation' | 'grounding' | 'publication'
  // Safe, actionable text only; exclude source excerpts, private URLs and raw model responses.
  message: string
  retryable: boolean
  diagnostic?: AnalysisSummaryDiagnostic
}

export interface AnalysisNarrativeWorkState extends Omit<AnalysisWorkState, 'error'> {
  error?: AnalysisNarrativeProcessingError
}

export interface AnalysisNarrativeRecordBase extends AnalysisEntityBase, AnalysisNarrativeWorkState {
  schemaVersion: typeof ANALYSIS_NARRATIVE_SCHEMA_VERSION
  runId: string
  manifestSha256: string
  targetId: string
  targetSnapshot: AnalysisNarrativeSnapshotIdentity
  status: AnalysisNarrativeWorkStatus
  generationId: string
  // Explicit requests use the stable Idempotency-Key; automatic requests use a durable internal ID.
  requestId: string
  requestedAt: string
  requestedBy: string | null
  reason: AnalysisNarrativeGenerationReason
  // Null while a target waits for scoring/prerequisites. Non-null before claiming model work.
  inputFingerprint: string | null
  waitingFor?: AnalysisNarrativeWaitReason
  // Retain during regeneration, failure and cancellation; it does not make a pending generation ready.
  published?: AnalysisNarrativePublicationReference
  history?: AnalysisSummaryHistoryReference
  summaryRound?: number
  retryRequestId?: string
}

export interface RealAnalysisCandidateNarrativeRecord extends AnalysisNarrativeRecordBase {
  // id: analysis-candidate-narrative:<runId>:<comparisonId>
  recordType: 'analysis-candidate-narrative'
  comparisonId: string
  resumeSnapshot: AnalysisNarrativeSnapshotIdentity
  resultSha256: string
  inputFingerprint: string
  resultRevisionId?: string
}

export interface RealAnalysisTargetNarrativeRecord extends AnalysisNarrativeRecordBase {
  // id: analysis-target-narrative:<runId>:<targetId>
  recordType: 'analysis-target-narrative'
}

// Deliberately not part of AnalysisEntity until persistence validators/guards support these records.
export type RealAnalysisNarrativeRecord = RealAnalysisCandidateNarrativeRecord | RealAnalysisTargetNarrativeRecord

export interface AnalysisNarrativePublicationFence {
  recordId: string
  etag: string
  generationId: string
  attemptId: string
  leaseOwner: string
  inputFingerprint: string
}

export interface AnalysisNarrativeSummaryBase extends AnalysisNarrativeCurrentState {
  targetId: string
  waitingFor: AnalysisNarrativeWaitReason | null
  attempts: number
  retryCount: number
  nextAttemptAt: string | null
  updatedAt: string | null
  error: AnalysisNarrativeProcessingError | null
  summaryRound?: number
  hasHistory?: boolean
  workHealth?: AnalysisNarrativeWorkHealth
}

export interface RealAnalysisCandidateNarrativeSummary extends AnalysisNarrativeSummaryBase {
  kind: 'candidate'
  comparisonId: string
  comparisonStatus: RealAnalysisComparisonStatus
  resultSha256?: string | null
  published: RealAnalysisCandidateNarrative | null
}

export interface RealAnalysisTargetNarrativeSummary extends AnalysisNarrativeSummaryBase {
  kind: 'target'
  published: RealAnalysisTargetNarrative | null
}

export interface AnalysisNarrativeCounts {
  total: number
  missing: number
  waiting: number
  queued: number
  running: number
  ready: number
  stale: number
  failed: number
  cancelled: number
  notRequired: number
}

export interface AnalysisSummaryScoringCounts {
  total: number
  initialized: number
  queued: number
  running: number
  complete: number
  failed: number
  cancelled: number
}

export interface AnalysisNarrativeScope {
  // Null means this saved run, never the workspace or a candidate search-filter subset.
  targetId: string | null
}

export interface AnalysisNarrativeScopeRevision {
  scope: AnalysisNarrativeScope
  // Stable hash of selected exact inputs, statuses, generations and publications; exclude leases,
  // heartbeat timestamps and unrelated targets. Not the immutable comparison ETag or run ETag.
  revision: string
}

export interface RealAnalysisSummariesResponse extends AnalysisNarrativeScopeRevision {
  schemaVersion: typeof ANALYSIS_NARRATIVE_SCHEMA_VERSION
  dataKind: 'real'
  workspaceId: string
  runId: string
  // Quoted scope revision for POST If-Match, independent of the comparison ETag.
  // Reads are no-store: this concurrency token is not a timed display cache validator.
  etag: string
  // Display/polling revision only. Time-based health transitions never change the scope ETag.
  // Lease renewals and last-activity timestamps alone do not change this revision.
  workRevision?: string
  ready: boolean
  capture: RealAnalysisNarrativeReportCapture
  scoring: AnalysisSummaryScoringCounts
  counts: { candidates: AnalysisNarrativeCounts; targets: AnalysisNarrativeCounts }
  capabilities: {
    canGenerate: boolean
    reason: 'read-only' | 'archived' | 'deleting' | 'cancelling' | 'service-unavailable' | null
  }
  comparisons: RealAnalysisCandidateNarrativeSummary[]
  targets: RealAnalysisTargetNarrativeSummary[]
}

// The run's captured policy for automatic summary work, as applied when each comparison finishes scoring.
export type AnalysisSummaryGeneration = 'automatic' | 'on-demand' | 'disabled'

export function analysisSummaryGeneration(
  settings: Pick<ProcessingSettingsSnapshot['settings'], 'features' | 'summaries'>,
): AnalysisSummaryGeneration {
  if (!settings.features.summaryGeneration) return 'disabled'
  return settings.summaries.generationMode === 'automatic' ? 'automatic' : 'on-demand'
}

export interface RealAnalysisSummaryStatusComparison {
  comparisonId: string
  targetId: string
  comparisonStatus: RealAnalysisComparisonStatus
  // The current scored result this summary state belongs to; null until the comparison completes.
  resultSha256: string | null
  correctionPending: boolean
  status: AnalysisNarrativeStatus
}

export interface RealAnalysisSummaryStatusTarget {
  targetId: string
  status: AnalysisNarrativeStatus
  waitingFor: AnalysisNarrativeWaitReason | null
}

// GET /api/workspaces/:workspaceId/analyses/:runId/summary-status reads work metadata only. It never reads
// published text or enqueues work, so pages can poll it while summaries generate.
export interface RealAnalysisSummaryStatusResponse extends AnalysisNarrativeScopeRevision {
  schemaVersion: typeof ANALYSIS_NARRATIVE_SCHEMA_VERSION
  dataKind: 'real'
  workspaceId: string
  runId: string
  // Changes when pending corrections or overview prerequisites change without a summary input or status change.
  workRevision: string
  generation: AnalysisSummaryGeneration
  // The same whole-run readiness that GET /summaries reports and PDF, Word and PowerPoint exports require.
  ready: boolean
  scoring: AnalysisSummaryScoringCounts
  corrections: { pending: number }
  counts: { candidates: AnalysisNarrativeCounts; targets: AnalysisNarrativeCounts }
  // Per-comparison and per-target states, present only for ?items=true.
  comparisons?: RealAnalysisSummaryStatusComparison[]
  targets?: RealAnalysisSummaryStatusTarget[]
}

export interface RealAnalysisSummaryStatusQuery {
  items?: boolean
}

export type RealAnalysisSummarySubjectResponse = {
  schemaVersion: typeof ANALYSIS_NARRATIVE_SCHEMA_VERSION
  dataKind: 'real'
  workspaceId: string
  runId: string
  subjectId: string
  // This subject's revision is not the management/export scope revision used for mutations.
  revision: string
  etag: string
  workRevision?: string
  resultRevisionId?: string
} & (
  | { kind: 'candidate'; narrative: RealAnalysisCandidateNarrativeSummary }
  | { kind: 'target'; narrative: RealAnalysisTargetNarrativeSummary }
)

// GET /api/workspaces/:workspaceId/analyses/:runId/summaries is read-only and never enqueues work.
export interface RealAnalysisSummariesQuery {
  targetId?: string
}

export interface GenerateRealAnalysisSummariesInput extends RealAnalysisSummariesQuery {
  // missing preserves usable current candidates and coalesces active work; all replaces generations.
  mode: AnalysisNarrativeGenerationMode
}

export interface GenerateRealAnalysisSummariesHeaders {
  'If-Match': string
  'Idempotency-Key': string
}

export interface RealAnalysisSummariesMutationResponse {
  requestId: string
  scheduled: { candidates: number; targets: number }
  summaries: RealAnalysisSummariesResponse
}

export interface AnalysisNarrativeComparisonCapture {
  comparisonId: string
  targetId: string
  status: RealAnalysisComparisonStatus
  resultSha256: string | null
  narrative: AnalysisNarrativeRevision | null
}

export interface AnalysisNarrativeTargetCapture {
  targetId: string
  narrative: AnalysisNarrativeRevision | null
}

export interface RealAnalysisNarrativeReportCapture extends AnalysisNarrativeScopeRevision {
  dataKind: 'real'
  ready: boolean
  // Exhaustive selected scope pins, checked across report batches and again before download.
  comparisons: AnalysisNarrativeComparisonCapture[]
  targets: AnalysisNarrativeTargetCapture[]
}

export type AnalysisNarrativeReportCapture = RealAnalysisNarrativeReportCapture

// This checks freshness of validated metadata, not artifact bytes, text shape or grounding.
export function analysisNarrativeIsCurrent(
  state: AnalysisNarrativeCurrentState,
  expectedInputFingerprint: string | null,
): boolean {
  const published = state.published
  return state.status === 'ready' && Boolean(state.generationId && expectedInputFingerprint && published?.revision) &&
    state.inputFingerprint === expectedInputFingerprint && published?.inputFingerprint === expectedInputFingerprint &&
    published.generationId === state.generationId
}

// expectedComparisonIds comes from the frozen run manifest, never a paged/top-N model input.
export function analysisTargetNarrativeCanGenerate(
  binding: AnalysisTargetNarrativeInputBinding,
  expectedComparisonIds: readonly string[],
): boolean {
  const comparisons = binding.comparisons
  const expected = new Set(expectedComparisonIds)
  if (expected.size === 0 || expected.size > ANALYSIS_NARRATIVE_LIMITS.maxComparisons ||
    expected.size !== expectedComparisonIds.length || comparisons.length !== expected.size) return false

  const seen = new Set<string>()
  for (const comparison of comparisons) {
    if (!expected.has(comparison.comparisonId) || seen.has(comparison.comparisonId)) return false
    seen.add(comparison.comparisonId)
    if (comparison.status === 'queued' || comparison.status === 'running') return false
    if (comparison.status === 'complete') {
      if (!comparison.resultSha256 || !comparison.narrative ||
        !analysisNarrativeIsCurrent(comparison.narrative, comparison.candidateInputFingerprint)) return false
    } else if ((comparison.status !== 'failed' && comparison.status !== 'cancelled') ||
      comparison.resultSha256 !== null || comparison.candidateInputFingerprint !== null || comparison.narrative !== null) {
      return false
    }
  }
  return true
}
