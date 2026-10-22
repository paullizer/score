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

/** Lightweight summary of stored QA checks for a rubric version, included on job summaries. */
export interface RubricQaSummary {
  rubricId: string
  version: number
  rubricHash: string
  blockerCount: number
  warningCount: number
  summary: string
  findings: RubricQaFinding[]
  checkedAt: string
}

export function summarizeRubricQa(record: RubricQaRecord): RubricQaSummary {
  const findings = [...record.checks, ...record.review.findings]
  return {
    rubricId: record.rubricId,
    version: record.version,
    rubricHash: record.rubricHash,
    blockerCount: findings.filter((item) => item.severity === 'blocker').length,
    warningCount: findings.filter((item) => item.severity === 'warning').length,
    summary: record.review.summary,
    findings,
    checkedAt: record.createdAt,
  }
}

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

export function rubricApprovalPresentation(
  rubric: { id: string; version: number },
  approval: RubricApprovalPointer | undefined,
  required: boolean,
  qaSummary?: RubricQaSummary,
) {
  const status = rubricVersionStatus(rubric, approval)
  const matchedQa = qaSummary && qaSummary.rubricId === rubric.id && qaSummary.version === rubric.version ? qaSummary : undefined
  const blockerCount = matchedQa ? matchedQa.blockerCount : null
  const warningCount = matchedQa ? matchedQa.warningCount : null
  const issueCount = matchedQa ? matchedQa.blockerCount + matchedQa.warningCount : null
  const cleanReady = status === 'draft' && issueCount === 0
  const label = status === 'approved' ? 'Approved'
    : status === 'superseded' ? 'Superseded'
      : !required ? 'Draft · approval optional'
        : approval ? 'Changes need approval' : 'Needs approval'
  const badgeLabel = status === 'approved' ? 'Approved'
    : status === 'superseded' ? 'Superseded'
      : !required ? 'Draft · approval optional'
        : issueCount !== null && issueCount > 0 ? `Draft · ${issueCount} to review`
          : 'Draft'
  const actionLabel = cleanReady ? 'Ready to approve'
    : issueCount !== null && issueCount > 0 ? `Review for approval (${issueCount})`
      : 'Check and approve'
  const message = status === 'approved' ? `Version ${rubric.version} is approved for new analyses.`
    : status === 'superseded' ? `Approved version ${approval!.version} is used for new work.`
      : !required ? 'Approval is optional under current Admin settings. Analysis availability is checked separately.'
        : approval ? `This draft is not approved. Approved version ${approval.version} stays in use.`
          : issueCount !== null && issueCount > 0
            ? `Draft needs review before approval (${issueCount} ${issueCount === 1 ? 'item' : 'items'} flagged).`
            : cleanReady
              ? 'Draft passed rubric checks with no overlapping criteria and is ready for approval.'
              : 'Approve this rubric before using it in a new analysis or grade ladder.'
  return {
    status,
    label,
    badgeLabel,
    actionLabel,
    message,
    issueCount,
    blockerCount,
    warningCount,
    cleanReady,
    qaSummary: matchedQa,
  }
}

const FINDING_CATEGORY_LABELS: Record<RubricQaFinding['code'], string> = {
  'same-capability': 'Overlapping criteria',
  'shared-source-text': 'Shared job quote',
  'similar-requirement': 'Similar requirement',
  'similar-label': 'Similar criterion name',
  'not-observable': 'Not observable on résumé',
  'unobservable-wording': 'Not observable on résumé',
  'scale-mismatch': 'Scale mismatch',
  'scale-structure': 'Scale structure issue',
  'unsupported-by-source': 'Unsupported by job text',
}

export function findingCategoryLabel(code: RubricQaFinding['code']): string {
  return FINDING_CATEGORY_LABELS[code] ?? 'Review item'
}

export function criterionNames(
  rubric: { criteria: readonly { id: string; label: string }[] },
  finding: RubricQaFinding,
): string {
  return finding.criterionIds.map((id) => {
    const index = rubric.criteria.findIndex((criterion) => criterion.id === id)
    return index < 0 ? id : `${String(index + 1).padStart(2, '0')} ${rubric.criteria[index].label}`
  }).join(' · ')
}

/**
 * Builds a bounded plain-text instruction for the rubric AI assistant to resolve one or more QA findings
 * while keeping source grounding and 100% total weight.
 */
export function buildRubricFixInstruction(
  rubric: { criteria: readonly { id: string; label: string }[] },
  findings: readonly RubricQaFinding[],
): string {
  const refForId = (id: string) => {
    const index = rubric.criteria.findIndex((criterion) => criterion.id === id)
    return index < 0 ? id : `C${index + 1} (${rubric.criteria[index].label})`
  }
  const lines = findings.slice(0, 8).map((finding, index) => {
    const refs = finding.criterionIds.map(refForId).join(' & ')
    const prefix = refs ? `${refs}: ` : ''
    return `${index + 1}. ${prefix}${finding.message.replace(/\s+/g, ' ').trim()}`
  })
  const header = 'Resolve these rubric review findings so no résumé evidence is counted twice and every criterion has distinct, observable 1-5 scale examples grounded in exact source passages. Merge overlapping criteria or separate their scope and cited passages, and rebalance weights to total 100%:'
  const full = [header, ...lines].join('\n')
  return full.length <= 1_900 ? full : `${full.slice(0, 1_897).trimEnd()}...`
}

export function rubricQaRecordId(rubricId: string, version: number): string {
  return `rubric-qa:${rubricId}:${version}:${RUBRIC_QA_VERSION}`
}
