import type {
  AnalysisEntityBase, AnalysisLimitation, AnalysisProcessingError, AnalysisWorkState,
  RealAnalysisAssessmentOutput, RealAnalysisGroundingReview, RealAnalysisResultSummary,
} from './real-analyses'
import type { ImmutableJsonBlobReference } from './real-resumes'
import type { ProcessingSettingsSnapshot } from './admin-settings'

export const ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION = 'missing-evidence-zero-v1' as const
export const ANALYSIS_CORRECTION_POLICY_VERSION = 'missing-evidence-zero-v2' as const
export const ANALYSIS_CORRECTION_POLICY_VERSIONS = [
  ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION, ANALYSIS_CORRECTION_POLICY_VERSION,
] as const
export type AnalysisCorrectionPolicyVersion = typeof ANALYSIS_CORRECTION_POLICY_VERSIONS[number]
export const ANALYSIS_CORRECTION_LIMITS = { maxCriteria: 20, historyPageSize: 12, maxHistoryEntries: 1000 } as const

export interface AnalysisResultRevision {
  id: string
  policyVersion: AnalysisCorrectionPolicyVersion
  originalResultSha256: string
  baseResultSha256: string
  correctedAt: string
  criterionIds: string[]
}

export interface AnalysisCorrectionProvenance {
  requestId: string
  policyVersion: AnalysisCorrectionPolicyVersion
  originalResultSha256: string
  baseResultSha256: string
  baseAssessmentSha256: string
  criterionIds: string[]
  requestedBy: string
  requestedAt: string
  reason: string
}

export interface AnalysisCorrectionHistoryReference {
  id: string
  createdAt: string
  blob: ImmutableJsonBlobReference
}

export interface AnalysisCorrectionPublication {
  revision: AnalysisResultRevision
  result: ImmutableJsonBlobReference
  summary: RealAnalysisResultSummary
  attemptId: string
}

export interface RealAnalysisCorrectionRecord extends AnalysisEntityBase, AnalysisWorkState {
  recordType: 'analysis-correction'
  runId: string
  comparisonId: string
  manifestSha256: string
  originalResult: ImmutableJsonBlobReference
  resumeSnapshot: { snapshotId: string; sha256: string }
  targetSnapshot: { snapshotId: string; sha256: string }
  status: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'
  requestId: string
  requestFingerprint: string
  requestedAt: string
  requestedBy: string
  reason: string
  policyVersion: AnalysisCorrectionPolicyVersion
  criterionIds: string[]
  baseResult: ImmutableJsonBlobReference
  baseAttemptId: string
  baseRevision?: AnalysisResultRevision
  proposal: ImmutableJsonBlobReference
  published?: AnalysisCorrectionPublication
  history?: AnalysisCorrectionHistoryReference
}

export interface AnalysisCorrectionProposal {
  schemaVersion: 1
  processingSettings?: ProcessingSettingsSnapshot
  dataKind: 'real'
  workspaceId: string
  runId: string
  comparisonId: string
  createdAt: string
  requestId: string
  requestFingerprint: string
  manifestSha256: string
  expectedEtag: string
  originalResultSha256: string
  baseResult: ImmutableJsonBlobReference
  baseAttemptId: string
  baseRevision?: AnalysisResultRevision
  resumeSnapshot: { snapshotId: string; sha256: string }
  targetSnapshot: { snapshotId: string; sha256: string }
  provenance: AnalysisCorrectionProvenance
  assessment: RealAnalysisAssessmentOutput
  summary: RealAnalysisResultSummary
}

export interface AnalysisCorrectionHistoryEntry {
  schemaVersion: 1
  dataKind: 'real'
  id: string
  workspaceId: string
  runId: string
  comparisonId: string
  createdAt: string
  requestId: string
  attemptId?: string
  outcome: 'ready' | 'failed' | 'cancelled'
  proposal: ImmutableJsonBlobReference
  review?: RealAnalysisGroundingReview
  result?: ImmutableJsonBlobReference
  error?: AnalysisProcessingError
  previous?: AnalysisCorrectionHistoryReference
}

export interface AnalysisCorrectionInput {
  policyVersion?: AnalysisCorrectionPolicyVersion
  resultSha256: string
  criterionIds: string[]
  reason: string
}

export interface AnalysisCorrectionSummary {
  workspaceId: string
  runId: string
  comparisonId: string
  etag: string
  status: RealAnalysisCorrectionRecord['status']
  requestId: string
  requestedAt: string
  requestedBy: string
  reason: string
  criterionIds: string[]
  attempts: number
  nextAttemptAt: string | null
  error: AnalysisProcessingError | null
  revision: AnalysisResultRevision | null
  hasHistory: boolean
  policyVersion?: AnalysisCorrectionPolicyVersion
}

export interface AnalysisCorrectionPreview {
  dataKind: 'real'
  workspaceId: string
  runId: string
  comparisonId: string
  etag: string
  resultSha256: string
  originalResultSha256: string
  policyVersion: AnalysisCorrectionPolicyVersion
  before: RealAnalysisResultSummary
  after: RealAnalysisResultSummary | null
  criterionIds: string[]
  criteria: {
    criterionId: string
    label: string
    weight: number
    rationale: string
    limitation: AnalysisLimitation
    eligible: boolean
    blockedReason: string | null
  }[]
  correction: AnalysisCorrectionSummary | null
}

export interface AnalysisCorrectionHistoryPage {
  dataKind: 'real'
  workspaceId: string
  runId: string
  comparisonId: string
  originalResultSha256: string
  original: RealAnalysisResultSummary
  originalAssessment: RealAnalysisAssessmentOutput
  correction: AnalysisCorrectionSummary | null
  entries: {
    id: string
    createdAt: string
    requestId: string
    outcome: AnalysisCorrectionHistoryEntry['outcome']
    requestedBy: string
    reason: string
    criterionIds: string[]
    beforeResultSha256: string
    after: RealAnalysisResultSummary
    review: Pick<RealAnalysisGroundingReview, 'outcome' | 'issues' | 'scope'> | null
    error: AnalysisProcessingError | null
    resultSha256: string | null
  }[]
  continuationToken?: string
}

export interface AnalysisCorrectionResponse {
  requestId: string
  correction: AnalysisCorrectionSummary
}
