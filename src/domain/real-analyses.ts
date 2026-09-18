import type {
  FrozenReferenceSource,
  GradeApprovalRecord,
  GradeContext,
  GradeQualification,
  GradeReviewRecord,
  GradeRubric,
  GradeRubricVersionRecord,
  GradeSeedSnapshot,
  GradeSourceSetRecord,
  ReferenceDocument,
} from './real-grades'
import type { RealJobSource } from './real-jobs'
import type { OriginalContentType } from './document-formats'
import type {
  ImmutableBlobReference,
  ImmutableDocumentReference,
  ImmutableJsonBlobReference,
  RealResume,
  RealResumeDocument,
  RealResumeProfile,
  RealResumeSource,
  ResumeExtractionProvenance,
  ResumeSourceCapture,
} from './real-resumes'
import type { Citation, Job, Rubric, SourceDocument } from './types'
import type { LifecycleMetadata, LifecycleOperation } from './lifecycle'

export const ANALYSIS_LIMITS = {
  maxComparisons: 500,
  initializationChunkSize: 25,
  maxAutomaticAttempts: 3,
  maxOutputCorrections: 1,
} as const

export interface RealAnalysisResumeSelection {
  resumeId: string
  documentId: string
  documentVersion: number
  documentSha256: string
}

export interface RealJobTargetSelection {
  kind: 'job'
  jobId: string
  rubricId: string
  rubricVersion: number
  rubricHash: string
  documentId: string
  documentVersion: number
  documentSha256: string
}

export interface RealGradeTargetSelection {
  kind: 'grade'
  ladderId: string
  grade: number
  versionId: string
  version: number
  versionHash: string
  approvalId: string
  reviewId: string
  sourceSetId: string
  sourceSetHash: string
}

export type RealAnalysisTargetSelection = RealJobTargetSelection | RealGradeTargetSelection

export interface RealAnalysisTargetSummaryBase {
  id: string
  workspaceId: string
  dataKind: 'real'
  label: string
  sublabel: string
  rubricId: string
  rubricVersion: number
  criterionCount: number
}

export interface RealJobTargetSummary extends RealAnalysisTargetSummaryBase {
  kind: 'job'
  selection: RealJobTargetSelection
}

export interface RealGradeTargetSummary extends RealAnalysisTargetSummaryBase {
  kind: 'grade'
  selection: RealGradeTargetSelection
  // From the approved version's frozen source set, never the current ladder draft.
  context: GradeContext
  approvedAt: string
  newerDraftAvailable: boolean
}

export type RealAnalysisTargetSummary = RealJobTargetSummary | RealGradeTargetSummary

export interface RealAnalysisTargetsPage {
  targets: RealAnalysisTargetSummary[]
  continuationToken?: string
}

export interface RealAnalysisResumeSummary {
  workspaceId: string
  dataKind: 'real'
  selection: RealAnalysisResumeSelection
  name: string | null
  role: string | null
  sourceLabel: string
  capturedAt: string
}

export interface FrozenRealResumeSnapshot {
  schemaVersion: 1
  snapshotId: string
  workspaceId: string
  dataKind: 'real'
  frozenAt: string
  selection: RealAnalysisResumeSelection
  resume: RealResume & { status: 'ready' }
  source: RealResumeSource
  // These retain resume-source provenance; scoring reads the embedded immutable document.
  capture: ResumeSourceCapture
  extraction: ResumeExtractionProvenance
  profile: RealResumeProfile
  document: RealResumeDocument
}

export type FrozenRequirementEvidence =
  | { kind: 'criterion'; criterionId: string; citations: Citation[] }
  | { kind: 'qualification'; qualificationId: string; citations: Citation[] }

export type RealJobDocument = SourceDocument & { kind: 'job'; sample: false }
export type RealJobRubric = Rubric & { kind: 'job'; dataKind: 'real' }

export interface FrozenAnalysisTargetBase {
  schemaVersion: 1
  snapshotId: string
  workspaceId: string
  dataKind: 'real'
  frozenAt: string
  requirementEvidence: FrozenRequirementEvidence[]
}

export interface FrozenJobTargetSnapshot extends FrozenAnalysisTargetBase {
  kind: 'job'
  selection: RealJobTargetSelection
  summary: RealJobTargetSummary
  job: Job & { dataKind: 'real'; status: 'ready' }
  rubric: RealJobRubric
  document: RealJobDocument
  source: RealJobSource
  // Immutable original copied into analysis-sources.
  original: ImmutableBlobReference & { contentType: OriginalContentType }
}

export interface FrozenAnalysisReference {
  source: FrozenReferenceSource
  // The normalized reference is copied to analysis-sources, independent of mutable grade heads.
  document: ImmutableDocumentReference
}

export interface FrozenGradeTargetSnapshot extends FrozenAnalysisTargetBase {
  kind: 'grade'
  selection: RealGradeTargetSelection
  summary: RealGradeTargetSummary
  version: GradeRubricVersionRecord
  approval: GradeApprovalRecord
  review: GradeReviewRecord & { outcome: 'supported' }
  sourceSet: GradeSourceSetRecord
  seed: GradeSeedSnapshot & { rubric: RealJobRubric; document: RealJobDocument }
  references: FrozenAnalysisReference[]
}

export type FrozenRealAnalysisTargetSnapshot = FrozenJobTargetSnapshot | FrozenGradeTargetSnapshot

export interface AnalysisSnapshotReference {
  snapshotId: string
  // Snapshot, manifest, result and copied reference blobs belong to analysis-sources.
  blob: ImmutableJsonBlobReference
}

export interface AnalysisResumeSnapshotReference extends AnalysisSnapshotReference {
  summary: RealAnalysisResumeSummary
}

export interface AnalysisTargetSnapshotReference extends AnalysisSnapshotReference {
  summary: RealAnalysisTargetSummary
}

export interface AnalysisComparisonPlan {
  id: string
  index: number
  resumeSnapshotId: string
  targetSnapshotId: string
}

// Blob-only: the run record keeps a reference and a cursor, not source text or work-item arrays.
export interface RealAnalysisInitializationManifest {
  schemaVersion: 1
  dataKind: 'real'
  workspaceId: string
  runId: string
  createdAt: string
  createdBy: string
  inputFingerprint: string
  request: CreateRealAnalysisInput
  resumes: AnalysisResumeSnapshotReference[]
  targets: AnalysisTargetSnapshotReference[]
  comparisons: AnalysisComparisonPlan[]
}

export type RealAnalysisRunStatus = 'initializing' | 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled'
export type RealAnalysisComparisonStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'

export type AnalysisProcessingErrorCode =
  | 'invalid-input' | 'stale-input' | 'snapshot-unavailable' | 'snapshot-invalid'
  | 'context-limit' | 'invalid-model-output' | 'invalid-citation' | 'grounding-failed'
  | 'service-unavailable' | 'storage-error' | 'timeout' | 'internal-error'

export interface AnalysisProcessingError {
  code: AnalysisProcessingErrorCode
  stage: 'initialization' | 'assessment' | 'grounding' | 'publication'
  message: string
  retryable: boolean
}

export interface AnalysisEntityBase {
  id: string
  workspaceId: string
  dataKind: 'real'
  createdAt: string
  updatedAt: string
}

export interface AnalysisWorkState {
  // Automatic attempts in the current retry cycle; manual retries increment retryCount.
  attempts: number
  retryCount: number
  attemptId?: string
  nextAttemptAt?: string
  lease?: { owner: string; expiresAt: string; heartbeatAt: string }
  error?: AnalysisProcessingError
}

export interface RealAnalysisProgress {
  total: number
  initialized: number
  queued: number
  running: number
  complete: number
  failed: number
  cancelled: number
  scored: number
  unscored: number
}

export interface RealAnalysisRunRecord extends AnalysisEntityBase, AnalysisWorkState {
  recordType: 'analysis-run'
  lifecycle?: LifecycleMetadata
  name: string
  createdBy: string
  idempotencyKey: string
  inputFingerprint: string
  status: RealAnalysisRunStatus
  manifest: ImmutableJsonBlobReference
  initialization: { nextComparisonIndex: number; completedAt?: string }
  progress: RealAnalysisProgress
  completedAt?: string
  cancellation?: { requestedAt: string; requestedBy: string; nextComparisonIndex: number; completedAt?: string }
}

export type AnalysisCriterionScore = 0 | 1 | 2 | 3 | 4 | 5

export interface AnalysisLimitation {
  code: 'sparse-source' | 'not-assessable' | 'context-limit' | 'source-quality'
  message: string
  criterionId?: string
  qualificationId?: string
}

export interface RealCriterionResultBase {
  criterionId: string
  weight: number
  rationale: string
  requirementCitations: Citation[]
}

export type RealCriterionResult = RealCriterionResultBase & (
  | { evidenceStatus: 'supported' | 'partial'; score: AnalysisCriterionScore; citations: [Citation, ...Citation[]] }
  | { evidenceStatus: 'missing'; score: 0; citations: [] }
  | { evidenceStatus: 'not-assessed'; score: null; citations: Citation[]; limitation: AnalysisLimitation }
  | { evidenceStatus: 'not-applicable'; weight: 0; score: null; citations: [] }
)

export interface RealQualificationAssessment {
  qualificationId: string
  evidenceStatus: 'supported' | 'partial' | 'missing' | 'not-assessed'
  rationale: string
  citations: Citation[]
  requirementCitations: Citation[]
  limitation?: AnalysisLimitation
}

export interface RealAnalysisEvidenceCoverage {
  totalCriteria: number
  supported: number
  partial: number
  missing: number
  notAssessed: number
  notApplicable: number
  assessedWeight: number
  totalWeight: number
}

export type RealAnalysisOverallScore =
  | { status: 'available'; score: number }
  | { status: 'withheld'; score: null; reason: 'unassessed-weighted-criteria' | 'no-assessable-weight'; message: string }

export interface RealAnalysisResultSummary {
  completion: 'assessed' | 'limited'
  overall: RealAnalysisOverallScore
  coverage: RealAnalysisEvidenceCoverage
}

// The model sees the complete resume, rubric and bounded exact requirement evidence, not a reference library.
export interface RealAnalysisAssessmentInput {
  resume: RealResumeDocument
  rubric: RealJobRubric | GradeRubric
  qualifications: GradeQualification[]
  requirementEvidence: FrozenRequirementEvidence[]
}

export interface RealAnalysisAssessmentOutput {
  criteria: RealCriterionResult[]
  qualifications: RealQualificationAssessment[]
  summary: string
  limitations: AnalysisLimitation[]
}

export interface RealAnalysisGroundingReviewInput extends RealAnalysisAssessmentInput {
  assessment: RealAnalysisAssessmentOutput
}

export interface AnalysisModelProvenance {
  model: string
  deployment: string
  promptVersion: string
  schemaVersion: string
  startedAt: string
  completedAt: string
  inputCharacters: number
}

export interface AnalysisGroundingIssue {
  code: string
  message: string
  criterionId?: string
  qualificationId?: string
  citations: Citation[]
}

export interface RealAnalysisGroundingReviewOutput {
  outcome: 'supported' | 'needs-correction' | 'unsupported'
  issues: AnalysisGroundingIssue[]
}

export interface RealAnalysisGroundingReview extends RealAnalysisGroundingReviewOutput {
  id: string
  assessmentSha256: string
  resumeSnapshotSha256: string
  targetSnapshotSha256: string
  provenance: AnalysisModelProvenance
}

export interface RealAnalysisResultProvenance {
  attemptId: string
  manifestSha256: string
  resumeSnapshot: { snapshotId: string; sha256: string }
  targetSnapshot: { snapshotId: string; sha256: string }
  assessmentSha256: string
  assessment: AnalysisModelProvenance
  groundingReviews: RealAnalysisGroundingReview[]
  correctionCount: number
  calculationVersion: 'weighted-0-100-v1'
}

export interface RealAnalysisResult extends RealAnalysisAssessmentOutput, RealAnalysisResultSummary {
  schemaVersion: 1
  dataKind: 'real'
  workspaceId: string
  runId: string
  comparisonId: string
  createdAt: string
  humanReviewRequired: true
  provenance: RealAnalysisResultProvenance
}

export interface RealAnalysisComparisonRecord extends AnalysisEntityBase, AnalysisWorkState {
  recordType: 'analysis-comparison'
  runId: string
  index: number
  status: RealAnalysisComparisonStatus
  resume: AnalysisResumeSnapshotReference
  target: AnalysisTargetSnapshotReference
  result?: ImmutableJsonBlobReference
  resultSummary?: RealAnalysisResultSummary
  completedAt?: string
  cancelledAt?: string
}

export type AnalysisEntity = RealAnalysisRunRecord | RealAnalysisComparisonRecord

export interface VersionedAnalysisEntity<T extends AnalysisEntity = AnalysisEntity> {
  record: T
  etag: string
}

export interface RealAnalysisRunSummary {
  run: RealAnalysisRunRecord
  etag: string
  lifecycle?: LifecycleMetadata
  operation?: LifecycleOperation
}

export interface RealAnalysisRunDetail extends RealAnalysisRunSummary {
  resumes: RealAnalysisResumeSummary[]
  targets: RealAnalysisTargetSummary[]
}

export type RealAnalysisDetail = RealAnalysisRunDetail

export interface RealAnalysesPage {
  runs: RealAnalysisRunSummary[]
  continuationToken?: string
}

export interface RealAnalysisComparisonSummary {
  comparison: RealAnalysisComparisonRecord
  etag: string
}

export interface RealAnalysisComparisonDetail extends RealAnalysisComparisonSummary {
  resumeSnapshot: FrozenRealResumeSnapshot
  targetSnapshot: FrozenRealAnalysisTargetSnapshot
  result: RealAnalysisResult | null
}

export interface RealAnalysisComparisonsPage {
  comparisons: RealAnalysisComparisonSummary[]
  continuationToken?: string
}

export interface RealAnalysisDocumentResponse {
  document: RealResumeDocument | RealJobDocument | ReferenceDocument
}

export interface RealAnalysisDocumentQuery {
  version: number
}

export interface AnalysisProcessingFeatures {
  realAnalyses: boolean
  analysisLimits: typeof ANALYSIS_LIMITS
}

export interface CreateRealAnalysisInput {
  name: string
  resumes: RealAnalysisResumeSelection[]
  targets: RealAnalysisTargetSelection[]
}

export interface CreateRealAnalysisHeaders {
  'Idempotency-Key': string
}

export interface AnalysisActionHeaders {
  'If-Match': string
}

export interface RetryRealAnalysisInput {
  // Omitted means all failed/cancelled comparisons (or interrupted initialization), never completed results.
  comparisonIds?: string[]
}

// GET details are unwrapped; POST actions return a versioned summary in these wrappers.
export interface RealAnalysisMutationResponse {
  run: RealAnalysisRunSummary
}

export interface RealComparisonMutationResponse {
  comparison: RealAnalysisComparisonSummary
}

export function analysisRecordIs<K extends AnalysisEntity['recordType']>(
  value: AnalysisEntity,
  recordType: K,
): value is Extract<AnalysisEntity, { recordType: K }> {
  return value.recordType === recordType
}

export function analysisRunCanScore(run: RealAnalysisRunRecord): boolean {
  return !run.lifecycle?.archivedAt && !run.lifecycle?.deletingAt && !run.lifecycle?.deletedAt &&
    !run.cancellation && run.progress.initialized === run.progress.total &&
    Boolean(run.initialization.completedAt) && (run.status === 'queued' || run.status === 'running')
}

export function analysisCancellationNeedsRetry(run: RealAnalysisRunRecord): boolean {
  return Boolean(run.cancellation && !run.cancellation.completedAt && run.error &&
    (!run.error.retryable || run.attempts >= ANALYSIS_LIMITS.maxAutomaticAttempts))
}
