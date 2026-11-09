import type { RealAnalysisComparisonSummary, RealAnalysisTargetSelection } from '../../domain/real-analyses'
import { sameTargetSelection, targetIdentity } from './realAnalysisUi'

export interface ScoreDistributionBin {
  lower: number
  upper: number
  count: number
}

export interface ScoreDistributionStatistics {
  mean: number
  median: number
  minimum: number
  maximum: number
  lowerQuartile: number
  upperQuartile: number
}

export interface ScoreDistribution {
  planned: number
  counts: {
    scored: number
    withheld: number
    withoutScore: number
    queued: number
    running: number
    failed: number
    cancelled: number
    invalid: number
    uninitialized: number
    corrections: number
  }
  statistics: ScoreDistributionStatistics | null
  bins: readonly ScoreDistributionBin[]
  markers: readonly { score: number; count: number }[]
  errors: readonly string[]
}

function median(values: readonly number[]): number {
  const middle = Math.floor(values.length / 2)
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
}

export function scoreDistributionBinLabel({ lower, upper }: ScoreDistributionBin): string {
  return upper === 100 ? `${lower} to ${upper} (inclusive)` : `${lower} to under ${upper}`
}

export function calculateScoreDistribution(
  comparisons: readonly RealAnalysisComparisonSummary[], target: RealAnalysisTargetSelection, planned: number,
): ScoreDistribution {
  const identity = targetIdentity(target)
  const scoped = comparisons.filter(({ comparison }) => targetIdentity(comparison.target.summary.selection) === identity)
  const counts: ScoreDistribution['counts'] = {
    scored: 0, withheld: 0, withoutScore: 0, queued: 0, running: 0, failed: 0, cancelled: 0,
    invalid: 0, uninitialized: Math.max(0, planned - scoped.length), corrections: 0,
  }
  const bins: ScoreDistributionBin[] = Array.from({ length: 10 }, (_, index) => ({
    lower: index * 10, upper: (index + 1) * 10, count: 0,
  }))
  const scores: number[] = []
  let mismatchedTargets = 0
  for (const { comparison, activeCorrection } of scoped) {
    if (!sameTargetSelection(comparison.target.summary.selection, target)) {
      counts.invalid++
      mismatchedTargets++
      continue
    }
    if (activeCorrection) counts.corrections++
    switch (comparison.status) {
      case 'queued':
      case 'running':
      case 'failed':
      case 'cancelled':
        counts[comparison.status]++
        break
      case 'complete': {
        const overall = comparison.resultSummary?.overall
        if (!overall) counts.withoutScore++
        else if (overall.status === 'withheld') counts.withheld++
        else if (overall.status === 'available' && typeof overall.score === 'number' &&
          Number.isFinite(overall.score) && overall.score >= 0 && overall.score <= 100) {
          scores.push(overall.score)
          bins[Math.min(9, Math.floor(overall.score / 10))].count++
        } else counts.invalid++
        break
      }
      default:
        counts.invalid++
    }
  }
  scores.sort((left, right) => left - right)
  counts.scored = scores.length
  const frequencies = new Map<number, number>()
  for (const score of scores) frequencies.set(score, (frequencies.get(score) ?? 0) + 1)
  // Odd-sized groups exclude the central value from both middle-half calculations.
  const statistics = scores.length ? {
    mean: scores.reduce((total, score) => total + score, 0) / scores.length,
    median: median(scores),
    minimum: scores[0],
    maximum: scores[scores.length - 1],
    lowerQuartile: scores.length === 1 ? scores[0] : median(scores.slice(0, Math.floor(scores.length / 2))),
    upperQuartile: scores.length === 1 ? scores[0] : median(scores.slice(Math.ceil(scores.length / 2))),
  } : null
  const errors: string[] = []
  if (mismatchedTargets) errors.push(
    `${mismatchedTargets} saved ${mismatchedTargets === 1 ? 'comparison has' : 'comparisons have'} a different target hash or source binding. Those results are not pooled with this exact target.`,
  )
  const invalidScores = counts.invalid - mismatchedTargets
  if (invalidScores) errors.push(
    `${invalidScores} saved ${invalidScores === 1 ? 'comparison has' : 'comparisons have'} an invalid score or state. No value was clipped or replaced.`,
  )
  if (scoped.length > planned) errors.push(
    'The loaded comparisons exceed this target\'s frozen resume count. Reload the analysis before relying on this distribution.',
  )
  return {
    planned, counts, statistics, bins, errors,
    markers: [...frequencies].map(([score, count]) => ({ score, count })),
  }
}
