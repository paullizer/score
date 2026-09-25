import {
  analysisSummaryGeneration, type AnalysisNarrativeCounts, type AnalysisNarrativeStatus, type AnalysisSummaryGeneration,
  type RealAnalysisSummaryStatusComparison, type RealAnalysisSummaryStatusResponse,
} from '../../domain/analysis-narratives'
import type { RealAnalysisComparisonSummary, RealAnalysisRunSummary } from '../../domain/real-analyses'
import { realAnalysisCancellationPaused, realAnalysisCancellationPending } from './realAnalysisUi'

// 'complete': scoring and every summary this run generates automatically have finished.
// 'scored': scoring finished, but summary progress is not known yet. Filters and sorting treat it as the scoring status.
export type RealCompletionPhase = 'complete' | 'scored' | 'active' | 'attention'
export type RealCompletionTone = 'neutral' | 'success' | 'warning'
export interface RealCompletionStage {
  label: string
  tone: RealCompletionTone
  phase: RealCompletionPhase
}

const toneFor = (phase: RealCompletionPhase): RealCompletionTone =>
  phase === 'complete' ? 'success' : phase === 'attention' ? 'warning' : 'neutral'
const stage = (label: string, phase: RealCompletionPhase, tone = toneFor(phase)): RealCompletionStage => ({ label, tone, phase })

export const summaryWorkPending = (status: AnalysisNarrativeStatus) => status === 'waiting' || status === 'queued' || status === 'running'
const pending = (count: AnalysisNarrativeCounts) => count.waiting + count.queued + count.running
const unfinished = (count: AnalysisNarrativeCounts) => count.failed + count.missing + count.stale + count.cancelled

/** Summary or correction work is still queued or running, so the status changes without a run update. */
export function summaryStatusWorkActive(status: Pick<RealAnalysisSummaryStatusResponse, 'scoring' | 'corrections' | 'counts'>): boolean {
  const { scoring, counts } = status
  return scoring.initialized < scoring.total || scoring.queued + scoring.running > 0 || status.corrections.pending > 0 ||
    pending(counts.candidates) + pending(counts.targets) > 0
}

/** The run's captured summary policy. The server's status is authoritative once it has been read. */
export function realSummaryGeneration(summary: RealAnalysisRunSummary, status?: RealAnalysisSummaryStatusResponse): AnalysisSummaryGeneration {
  if (status?.runId === summary.run.id) return status.generation
  const captured = summary.run.processingSettings
  if (!captured) return 'automatic'
  try { return analysisSummaryGeneration(captured.settings) } catch { return 'automatic' }
}

/** False when the status is for another run or was read before this run's scoring finished. */
export function realSummaryStatusCurrent(
  summary: RealAnalysisRunSummary, status: RealAnalysisSummaryStatusResponse | undefined,
): status is RealAnalysisSummaryStatusResponse {
  if (!status || status.runId !== summary.run.id) return false
  const { scoring } = status
  return summary.run.status !== 'complete' || (scoring.initialized === scoring.total && scoring.queued + scoring.running === 0)
}

export function realSummaryItems(status: RealAnalysisSummaryStatusResponse | undefined): Map<string, RealAnalysisSummaryStatusComparison> {
  return new Map(status?.comparisons?.map((item) => [item.comparisonId, item]) ?? [])
}

/** The item describes this comparison's current scored result, not an earlier result or a pending re-score. */
export function realSummaryItemCurrent(pair: RealAnalysisComparisonSummary, item: RealAnalysisSummaryStatusComparison | undefined): item is RealAnalysisSummaryStatusComparison {
  const { comparison } = pair
  return Boolean(item && item.comparisonId === comparison.id && item.comparisonStatus === 'complete' && comparison.status === 'complete' &&
    !item.correctionPending && !pair.activeCorrection && (!comparison.result || item.resultSha256 === comparison.result.sha256))
}

export function realComparisonStage(
  pair: RealAnalysisComparisonSummary, generation: AnalysisSummaryGeneration, item?: RealAnalysisSummaryStatusComparison,
): RealCompletionStage {
  switch (pair.comparison.status) {
    case 'queued': return stage('Queued for analysis', 'active')
    case 'running': return stage('Analyzing', 'active')
    case 'failed': return stage('Failed', 'attention')
    case 'cancelled': return stage('Cancelled', 'attention')
  }
  if (pair.activeCorrection) return stage(pair.activeCorrection.status === 'queued' ? 'Re-score queued' : 'Re-scoring', 'active')
  if (!realSummaryItemCurrent(pair, item)) {
    return generation === 'automatic' ? stage('Analysis complete', 'scored') : stage('Complete', 'complete')
  }
  if (item.status === 'waiting' || item.status === 'queued') return stage('Queued for summary generation', 'active')
  if (item.status === 'running') return stage('Generating summary', 'active')
  if (generation !== 'automatic') return stage('Complete', 'complete')
  switch (item.status) {
    case 'failed': return stage('Summary failed', 'attention')
    case 'missing': case 'cancelled': return stage('Summary not generated', 'attention')
    case 'stale': return stage('Summary out of date', 'attention')
    default: return stage('Complete', 'complete')
  }
}

function completedRunStage(summary: RealAnalysisRunSummary, status?: RealAnalysisSummaryStatusResponse): RealCompletionStage {
  const generation = realSummaryGeneration(summary, status)
  if (!realSummaryStatusCurrent(summary, status)) return generation === 'automatic' ? stage('Analysis complete', 'scored') : stage('Complete', 'complete')
  const { candidates, targets } = status.counts
  if (status.corrections.pending > 0) return stage('Analyzing', 'active')
  if (pending(candidates) + pending(targets) > 0) {
    return candidates.running + targets.running + candidates.ready + targets.ready > 0
      ? stage('Generating summaries', 'active') : stage('Queued for summary generation', 'active')
  }
  if (generation === 'automatic' && unfinished(candidates) + unfinished(targets) > 0) return stage('Summaries need attention', 'attention')
  return stage('Complete', 'complete')
}

/** Scoring finished and automatic summary work stopped, but some summaries failed, went missing or are out of date. */
export function realSummariesNeedAttention(summary: RealAnalysisRunSummary, status?: RealAnalysisSummaryStatusResponse): boolean {
  return summary.run.status === 'complete' && realSummaryStatusCurrent(summary, status) && completedRunStage(summary, status).phase === 'attention'
}

export function realAnalysisRunStage(summary: RealAnalysisRunSummary, status?: RealAnalysisSummaryStatusResponse): RealCompletionStage {
  if ((summary.lifecycle ?? summary.run.lifecycle)?.deletingAt) return stage('Deletion pending', 'attention')
  if (realAnalysisCancellationPaused(summary)) return stage('Cancellation paused', 'attention')
  if (realAnalysisCancellationPending(summary)) return stage('Cancelling unfinished work', 'active')
  switch (summary.run.status) {
    case 'initializing': return stage('Freezing inputs', 'active')
    case 'queued': return stage('Queued for analysis', 'active')
    case 'running': return stage('Analyzing', 'active')
    case 'partial': return stage('Partial / needs attention', 'attention')
    case 'failed': return stage('Failed', 'attention')
    case 'cancelled': return stage('Cancelled', 'attention', 'neutral')
    case 'complete': return completedRunStage(summary, status)
  }
}

const phaseRank = (phase: RealCompletionPhase) => phase === 'complete' || phase === 'scored' ? 2 : phase === 'active' ? 1 : 0
const cancellationUnfinished = (summary: RealAnalysisRunSummary) => realAnalysisCancellationPaused(summary) || realAnalysisCancellationPending(summary)

/** A completed run's rank follows its summaries once their status is known. Null means callers use the scoring rank. */
export function realAnalysisCompletionRank(summary: RealAnalysisRunSummary, status?: RealAnalysisSummaryStatusResponse): number | null {
  if (summary.run.status !== 'complete' || cancellationUnfinished(summary) || (summary.lifecycle ?? summary.run.lifecycle)?.deletingAt ||
    !realSummaryStatusCurrent(summary, status)) return null
  return phaseRank(completedRunStage(summary, status).phase)
}

/** Complete for the history filter: scoring finished and so did its summaries, or their status is not known yet. */
export function realAnalysisFullyComplete(summary: RealAnalysisRunSummary, status?: RealAnalysisSummaryStatusResponse): boolean {
  if (summary.run.status !== 'complete' || cancellationUnfinished(summary)) return false
  return phaseRank(completedRunStage(summary, status).phase) === 2
}

export function realComparisonCompletionRank(
  pair: RealAnalysisComparisonSummary, generation: AnalysisSummaryGeneration, item?: RealAnalysisSummaryStatusComparison,
): number {
  return phaseRank(realComparisonStage(pair, generation, item).phase)
}

export interface RealSummaryTally {
  // Summaries the finished report needs, including those for comparisons that are still being scored.
  required: number
  ready: number
  // Waiting for a score, an earlier summary or an available worker.
  queued: number
  running: number
  // Failed, missing, out of date or cancelled.
  unfinished: number
}
export interface RealCompletionProgress {
  // Each comparison counts once, when both its score and its candidate summary are finished. Each expected overview counts once.
  total: number
  finished: number
  comparisons: { total: number; finished: number }
  candidates: RealSummaryTally
  overviews: RealSummaryTally
}

const tally = (statuses: readonly AnalysisNarrativeStatus[]): RealSummaryTally => ({
  required: statuses.length,
  ready: statuses.filter((status) => status === 'ready').length,
  queued: statuses.filter((status) => status === 'waiting' || status === 'queued').length,
  running: statuses.filter((status) => status === 'running').length,
  unfinished: statuses.filter((status) => status === 'failed' || status === 'missing' || status === 'stale' || status === 'cancelled').length,
})
const counted = (count: AnalysisNarrativeCounts): RealSummaryTally => ({
  required: count.total - count.notRequired, ready: count.ready, queued: count.waiting + count.queued, running: count.running, unfinished: unfinished(count),
})

/**
 * One combined measure of scoring and summaries. Failed or skipped summaries count as finished work; the stage flags them.
 * Null until the per-comparison status has been read.
 */
export function realAnalysisCompletionProgress(summary: RealAnalysisRunSummary, status?: RealAnalysisSummaryStatusResponse): RealCompletionProgress | null {
  if (status?.runId !== summary.run.id || !status.comparisons || !status.targets) return null
  const comparisons = status.comparisons
  const settled = (item: RealAnalysisSummaryStatusComparison) => item.comparisonStatus === 'failed' || item.comparisonStatus === 'cancelled'
  const live = comparisons.filter((item) => !settled(item))
  const pairsFinished = comparisons.filter((item) => settled(item) ||
    (item.comparisonStatus === 'complete' && !item.correctionPending && !summaryWorkPending(item.status))).length
  // A job or grade needs an overview once any of its comparisons can still produce a score.
  const expected = new Set(live.map((item) => item.targetId))
  const overviews = status.targets.filter((target) => expected.has(target.targetId))
  const overviewsFinished = overviews.filter((target) => target.status !== 'not-required' && !summaryWorkPending(target.status)).length
  return {
    total: comparisons.length + overviews.length,
    finished: pairsFinished + overviewsFinished,
    comparisons: { total: comparisons.length, finished: pairsFinished },
    candidates: tally(live.map((item) => item.status)),
    overviews: tally(overviews.map((target) => target.status)),
  }
}

/** Summary counts for the history list, from a status read after scoring finished. Null until a status is known. */
export function realSummaryCounts(summary: RealAnalysisRunSummary, status?: RealAnalysisSummaryStatusResponse): RealSummaryTally | null {
  if (!realSummaryStatusCurrent(summary, status)) return null
  const candidates = counted(status.counts.candidates)
  const targets = counted(status.counts.targets)
  return {
    required: candidates.required + targets.required, ready: candidates.ready + targets.ready,
    queued: candidates.queued + targets.queued, running: candidates.running + targets.running, unfinished: candidates.unfinished + targets.unfinished,
  }
}
