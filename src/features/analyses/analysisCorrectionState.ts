import {
  ANALYSIS_CORRECTION_POLICY_VERSION, ANALYSIS_CORRECTION_POLICY_VERSIONS, ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION,
  isAnalysisReassessmentPolicy,
  type AnalysisActiveCorrection, type AnalysisCorrectionHistoryPage, type AnalysisCorrectionInput,
  type AnalysisCorrectionPolicyVersion, type AnalysisCorrectionPreview, type AnalysisCorrectionSummary,
} from '../../domain/analysis-corrections'
import type { RealAnalysisComparisonSummary } from '../../domain/real-analyses'
import { dateLabel } from '../../domain/selectors'
import { CloudApiError } from '../../services/cloudWorkspace'

export const correctionPolicyReason = 'Apply the missing-evidence policy: an applicable professional criterion without supporting evidence in a successfully reviewed source is 0/5. Preserve existing numeric scores, weights, frozen evidence, and original history; retain genuine assessment blockers for human review.'
export const reassessmentPolicyReason = 'Re-score this withheld comparison with the current processing rules: rerun the assessment, evidence-gap review, and independent grounding review against the same frozen resume and rubric. Keep the original result and its history.'
export const correctionConcurrency = 2

/** Which policy a reviewer applies to the selected withheld comparisons. */
export type CorrectionAction = 'reassess' | 'missing-evidence'

export function correctionActionAvailable(preview: AnalysisCorrectionPreview | null | undefined, action: CorrectionAction): boolean {
  if (!preview) return false
  return action === 'reassess' ? preview.reassessment.eligible && preview.reassessment.criterionIds.length > 0
    : Boolean(preview.after) && preview.criterionIds.length > 0
}

export interface ReviewedCorrectionRequest {
  key: string
  etag: string
  originalResultSha256: string
  input: AnalysisCorrectionInput
}

export function availableWithheldComparisons(comparisons: RealAnalysisComparisonSummary[]): RealAnalysisComparisonSummary[] {
  return comparisons.filter(({ comparison }) => comparison.status === 'complete' && comparison.resultSummary?.overall.status === 'withheld')
}

export function correctionIsActive(correction: AnalysisCorrectionSummary | null | undefined): boolean {
  return correction?.status === 'queued' || correction?.status === 'running'
}

/** One label for correction work, wherever it appears: the review dialog, the comparison table, or the comparison view. */
export function correctionStatusLabel(
  status: AnalysisCorrectionSummary['status'], policy: AnalysisCorrectionPolicyVersion | undefined,
): string {
  if (isAnalysisReassessmentPolicy(policy)) {
    return { queued: 'Re-score queued', running: 'Re-score running', ready: 'Re-score published',
      failed: 'Re-score failed — not published', cancelled: 'Re-score cancelled — not published' }[status]
  }
  return { queued: 'Correction queued',
    running: policy === ANALYSIS_CORRECTION_POLICY_VERSION ? 'Evidence-gap verification running' : 'Full-assessment grounding review running',
    ready: 'Correction published', failed: 'Correction failed — not published', cancelled: 'Correction cancelled — not published' }[status]
}

export function activeCorrectionNote(active: AnalysisActiveCorrection): string {
  const work = isAnalysisReassessmentPolicy(active.policyVersion) ? 're-score' : 'correction'
  return `Requested ${dateLabel(active.requestedAt)}. Showing the current result until the ${work} finishes.`
}

/** The run progress line for accepted re-score or correction work, or null when none is in progress. */
export function activeCorrectionProgress(comparisons: readonly RealAnalysisComparisonSummary[]): string | null {
  const active = comparisons.flatMap(({ activeCorrection }) => activeCorrection ? [activeCorrection] : [])
  if (!active.length) return null
  const rescores = active.filter(item => isAnalysisReassessmentPolicy(item.policyVersion)).length
  const one = active.length === 1
  const work = rescores === active.length ? one ? 're-score' : 're-scores'
    : rescores === 0 ? one ? 'correction' : 'corrections' : 're-scores and corrections'
  const queued = active.filter(item => item.status === 'queued').length
  return `${active.length} ${work} in progress · ${queued} queued · ${active.length - queued} running. Each comparison keeps its current result until its work finishes.`
}

export function latestCorrectionFailure(
  page: AnalysisCorrectionHistoryPage, correction: AnalysisCorrectionSummary,
): AnalysisCorrectionHistoryPage['entries'][number] | null {
  if (correction.status !== 'failed' || page.workspaceId !== correction.workspaceId ||
    page.runId !== correction.runId || page.comparisonId !== correction.comparisonId ||
    page.correction?.requestId !== correction.requestId || page.correction.status !== 'failed' ||
    (page.correction.policyVersion !== undefined &&
      page.correction.policyVersion !== (correction.policyVersion ?? ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION))) {
    throw new Error('The current correction request changed while loading findings. Check correction status, then open findings for the latest failed request.')
  }
  const entry = page.entries.filter(item => item.requestId === correction.requestId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
  if (!entry) return null
  if (entry.outcome !== 'failed' || entry.reason !== correction.reason || entry.requestedBy !== correction.requestedBy ||
    entry.criterionIds.length !== correction.criterionIds.length ||
    entry.criterionIds.some(id => !correction.criterionIds.includes(id))) {
    throw new Error('The saved failure findings do not match this exact request and its selected criteria. Check correction status before trying again.')
  }
  return entry
}

export async function boundedCorrectionWork<T>(
  items: readonly T[], work: (item: T) => Promise<void>, signal: AbortSignal,
): Promise<void> {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(correctionConcurrency, items.length) }, async () => {
    while (!signal.aborted) {
      const itemIndex = index++
      if (itemIndex >= items.length) return
      await work(items[itemIndex])
    }
  }))
}

export class CorrectionRequestJournal {
  private requests = new Map<string, ReviewedCorrectionRequest>()

  get(comparisonId: string): ReviewedCorrectionRequest | undefined { return this.requests.get(comparisonId) }

  prepare(
    comparisonId: string, preview: AnalysisCorrectionPreview, reason: string, action: CorrectionAction = 'missing-evidence',
  ): ReviewedCorrectionRequest {
    const previous = this.get(comparisonId)
    if (previous) return previous
    const reassess = action === 'reassess'
    if (preview.comparisonId !== comparisonId || !correctionActionAvailable(preview, action) ||
      (!reassess && !ANALYSIS_CORRECTION_POLICY_VERSIONS.includes(preview.policyVersion)) || correctionIsActive(preview.correction)) {
      throw new Error('Load and review a fresh selectable preview for this exact comparison before requesting a correction.')
    }
    const request = {
      key: crypto.randomUUID(), etag: preview.etag, originalResultSha256: preview.originalResultSha256,
      input: {
        policyVersion: reassess ? preview.reassessment.policyVersion : preview.policyVersion, resultSha256: preview.resultSha256,
        criterionIds: [...(reassess ? preview.reassessment.criterionIds : preview.criterionIds)], reason: reason.trim(),
      },
    }
    this.requests.set(comparisonId, request)
    return request
  }

  acknowledge(comparisonId: string, correction: AnalysisCorrectionSummary | null): void {
    const request = this.get(comparisonId)
    if (request && correction?.comparisonId === comparisonId && correction.requestId === request.key) {
      const policy = request.input.policyVersion ?? ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION
      if (correction.reason !== request.input.reason ||
        (correction.policyVersion !== undefined && correction.policyVersion !== policy) ||
        correction.criterionIds.length !== request.input.criterionIds.length ||
        correction.criterionIds.some(id => !request.input.criterionIds.includes(id)) ||
        (correction.status === 'ready' && (correction.revision?.baseResultSha256 !== request.input.resultSha256 ||
          correction.revision.policyVersion !== policy ||
          correction.revision.originalResultSha256 !== request.originalResultSha256))) {
        throw new Error('Correction status does not match the retained request policy, reason, criteria, or result hashes. The original request key has been retained.')
      }
      this.requests.delete(comparisonId)
    }
  }

  reject(comparisonId: string, error: unknown): boolean {
    const rejected = error instanceof CloudApiError && error.status >= 400 && error.status < 500 &&
      ![408, 429].includes(error.status)
    if (rejected) this.requests.delete(comparisonId)
    return rejected
  }
}
