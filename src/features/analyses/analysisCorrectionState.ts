import type { AnalysisCorrectionInput, AnalysisCorrectionPreview, AnalysisCorrectionSummary } from '../../domain/analysis-corrections'
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
    if (preview.comparisonId !== comparisonId || !preview.after || !preview.criterionIds.length || correctionIsActive(preview.correction)) {
      throw new Error('Load and review a fresh selectable preview for this exact comparison before requesting a correction.')
    }
    const request = {
      key: crypto.randomUUID(), etag: preview.etag, originalResultSha256: preview.originalResultSha256,
      input: { resultSha256: preview.resultSha256, criterionIds: [...preview.criterionIds], reason: reason.trim() },
    }
    this.requests.set(comparisonId, request)
    return request
  }

  acknowledge(comparisonId: string, correction: AnalysisCorrectionSummary | null): void {
    const request = this.get(comparisonId)
    if (request && correction?.comparisonId === comparisonId && correction.requestId === request.key) {
      if (correction.reason !== request.input.reason ||
        correction.criterionIds.length !== request.input.criterionIds.length ||
        correction.criterionIds.some(id => !request.input.criterionIds.includes(id)) ||
        (correction.status === 'ready' && (correction.revision?.baseResultSha256 !== request.input.resultSha256 ||
          correction.revision.originalResultSha256 !== request.originalResultSha256))) {
        throw new Error('Correction status does not match the retained request reason, criteria, or result hashes. The original request key has been retained.')
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
