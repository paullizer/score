import type { EvidenceScaleVersion } from './evidence-scale'
import { RUBRIC_QA_VERSION, type RubricQaFinding } from './rubric-qa'

/**
 * Code-owned prompt for the one-pass job rubric review that runs before approval. Changing it, or the model-free
 * checks, needs a new RUBRIC_QA_VERSION so earlier results are not reused for approval.
 */
export const RUBRIC_REVIEW_PROMPT_VERSION = 'score-job-rubric-review-v1' as const

export const RUBRIC_REVIEW_LIMITS = Object.freeze({ maxFindings: 12, maxMessageCharacters: 600, maxSummaryCharacters: 1000 } as const)

/**
 * The job record's pointer to its approved rubric version. Only the approve route changes it; saving an edit
 * creates a new draft version and leaves the approved version in force until a newer one is approved.
 */
export interface RubricApprovalPointer {
  approvalId: string
  rubricId: string
  version: number
  rubricHash: string
  approvedBy: string
  approvedAt: string
}

/** Results of the rubric checks for one exact saved version. Create-only, bound to the version's hash. */
export interface RubricQaRecord {
  id: string
  workspaceId: string
  recordType: 'rubric-qa'
  jobId: string
  rubricId: string
  version: number
  rubricHash: string
  qaVersion: typeof RUBRIC_QA_VERSION
  /** Model-free checks. Blockers prevent approval. */
  checks: RubricQaFinding[]
  /** One model pass. Its findings are warnings for the approver. */
  review: { promptVersion: typeof RUBRIC_REVIEW_PROMPT_VERSION; model: string; summary: string; findings: RubricQaFinding[] }
  createdBy: string
  createdAt: string
}

/** Create-only audit record of one approval. Approving a newer version supersedes the previous approval. */
export interface RubricApprovalRecord {
  id: string
  workspaceId: string
  recordType: 'rubric-approval'
  jobId: string
  rubricId: string
  version: number
  rubricHash: string
  scaleVersion: EvidenceScaleVersion
  qa: { id: string; sha256: string }
  /** The extracted job document the rubric cites, so a shared rubric library can match it later. */
  document: { id: string; version: number; sha256: string }
  approvedBy: string
  approvedAt: string
  supersedes?: string
}

export type RubricVersionStatus = 'approved' | 'draft' | 'superseded'

/** What the rubric page needs to show the checks and approve one exact saved version. */
export interface RubricCheckState {
  rubricId: string
  version: number
  /** Send this back when approving, so the approval covers exactly the version that was reviewed. */
  rubricHash: string
  status: RubricVersionStatus
  /** Why an owner can't approve this version, apart from checks that haven't run yet. Empty once it's approved. */
  blockers: string[]
  /** Null until the rubric checks have run on this version. */
  checks: RubricQaRecord | null
}

/** Versions older than the approved one are superseded; newer ones are drafts until a workspace owner approves them. */
export function rubricVersionStatus(
  rubric: { id: string; version: number }, approval: Pick<RubricApprovalPointer, 'rubricId' | 'version'> | null | undefined,
): RubricVersionStatus {
  if (!approval || approval.rubricId !== rubric.id) return 'draft'
  if (rubric.version === approval.version) return 'approved'
  return rubric.version < approval.version ? 'superseded' : 'draft'
}

export function rubricQaRecordId(rubricId: string, version: number): string {
  return `rubric-qa:${rubricId}:${version}:${RUBRIC_QA_VERSION}`
}
