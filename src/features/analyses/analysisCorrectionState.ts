import {
  ANALYSIS_CORRECTION_POLICY_VERSIONS, ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION,
  type AnalysisCorrectionHistoryPage, type AnalysisCorrectionInput, type AnalysisCorrectionPreview, type AnalysisCorrectionSummary,
} from '../../domain/analysis-corrections'
import type { RealAnalysisComparisonSummary } from '../../domain/real-analyses'
import { CloudApiError } from '../../services/cloudWorkspace'

export const correctionPolicyReason = 'Apply the missing-evidence policy: an applicable professional criterion without supporting evidence in a successfully reviewed source is 0/5. Preserve existing numeric scores, weights, frozen evidence, and original history; retain genuine assessment blockers for human review.'
export const correctionConcurrency = 2

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

  prepare(comparisonId: string, preview: AnalysisCorrectionPreview, reason: string): ReviewedCorrectionRequest {
    const previous = this.get(comparisonId)
    if (previous) return previous
    if (preview.comparisonId !== comparisonId || !preview.after || !preview.criterionIds.length ||
      !ANALYSIS_CORRECTION_POLICY_VERSIONS.includes(preview.policyVersion) || correctionIsActive(preview.correction)) {
      throw new Error('Load and review a fresh selectable preview for this exact comparison before requesting a correction.')
    }
    const request = {
      key: crypto.randomUUID(), etag: preview.etag, originalResultSha256: preview.originalResultSha256,
      input: {
        policyVersion: preview.policyVersion, resultSha256: preview.resultSha256,
        criterionIds: [...preview.criterionIds], reason: reason.trim(),
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
