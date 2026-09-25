import type { AnalysisEntity } from '../../src/domain/real-analyses'

export type AnalysisWorkLane = 'scoring' | 'summaries'

/**
 * Pending child work in the order each lane reads it. Run initialization and cancellation are in
 * neither lane: they always go first, because blocked children can't advance without them.
 */
export const ANALYSIS_WORK_LANES = {
  scoring: ['analysis-comparison', 'analysis-correction'],
  summaries: ['analysis-narrative-request', 'analysis-candidate-narrative', 'analysis-target-narrative'],
} as const satisfies Record<AnalysisWorkLane, readonly Exclude<AnalysisEntity['recordType'], 'analysis-run'>[]>

export interface AnalysisPendingOptions {
  /** The lane that gets the first slot after run work. Defaults to scoring. */
  firstLane?: AnalysisWorkLane
}

/**
 * Workers start with scoring on even clock minutes and with summaries on odd ones, so executions
 * that claim one item still take turns between the lanes.
 */
export function firstAnalysisWorkLane(now: Date): AnalysisWorkLane {
  return Math.floor(now.getTime() / 60_000) % 2 === 0 ? 'scoring' : 'summaries'
}

/**
 * Takes one item from each lane in turn, starting with `firstLane`, and fills the rest from the
 * other lane once one runs out. Lanes are read lazily, so nothing past `limit` is read or checked.
 */
export async function mergeAnalysisWorkLanes<T>(
  lanes: Readonly<Record<AnalysisWorkLane, AsyncIterable<T> | Iterable<T>>>, firstLane: AnalysisWorkLane, limit: number,
): Promise<T[]> {
  const order: AnalysisWorkLane[] = firstLane === 'summaries' ? ['summaries', 'scoring'] : ['scoring', 'summaries']
  const iterators = order.map(lane => {
    const source = lanes[lane]
    return Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]()
  })
  const open = iterators.map(() => true)
  const items: T[] = []
  try {
    for (let turn = 0; items.length < limit && open.some(Boolean); turn = (turn + 1) % iterators.length) {
      if (!open[turn]) continue
      const next = await iterators[turn].next()
      if (next.done) open[turn] = false
      else items.push(next.value)
    }
  } finally {
    await Promise.all(iterators.map((iterator, index) => open[index] ? iterator.return?.() : undefined))
  }
  return items
}
