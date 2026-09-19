import type { TableSortOption } from '../../components/ui/TableSorting'
import type { RealAnalysisComparisonSummary, RealAnalysisRunSummary, RealAnalysisTargetSummary } from '../../domain/real-analyses'
import { runStatus } from '../../domain/selectors'
import { matchesTableSearch, sortTableRows, type TableSort } from '../../domain/tableSorting'
import type { AnalysisRun, AnalysisTarget, Comparison, ResumeSnapshot } from '../../domain/types'
import { realAnalysisCancellationPaused, realAnalysisCancellationPending, targetIdentity, targetVersionLabel } from './realAnalysisUi'
import { getDisplayName } from '../../domain/displayNames'

export type AnalysisHistoryFilter = 'all' | 'complete' | 'attention'
export type SampleAnalysisSortKey = 'name' | 'resumes' | 'targets' | 'status' | 'created'
export type RealAnalysisSortKey = 'name' | 'status' | 'comparisons' | 'created'
export type RealComparisonSortKey = 'name' | 'target' | 'score' | 'status'
export type SampleComparisonSortKey = 'name' | 'score' | 'coverage' | 'status'

const nameOption = { key: 'name', label: 'Analysis', ascendingLabel: 'A to Z', descendingLabel: 'Z to A' } as const
const statusOption = { key: 'status', label: 'Status', ascendingLabel: 'needs attention first', descendingLabel: 'complete first' } as const
const createdOption = { key: 'created', label: 'Created', ascendingLabel: 'oldest first', descendingLabel: 'newest first', initialDirection: 'desc' } as const
const scoreOption = { key: 'score', label: 'Evidence match', ascendingLabel: 'low to high', descendingLabel: 'high to low', initialDirection: 'desc' } as const

export const sampleAnalysisSortOptions: readonly TableSortOption<SampleAnalysisSortKey>[] = [
  nameOption,
  { key: 'resumes', label: 'Resumes', ascendingLabel: 'fewest first', descendingLabel: 'most first' },
  { key: 'targets', label: 'Targets', ascendingLabel: 'fewest first', descendingLabel: 'most first' },
  statusOption, createdOption,
]

export const realAnalysisSortOptions: readonly TableSortOption<RealAnalysisSortKey>[] = [
  nameOption, statusOption,
  { key: 'comparisons', label: 'Independent comparisons', ascendingLabel: 'fewest first', descendingLabel: 'most first' },
  createdOption,
]

export const realComparisonSortOptions: readonly TableSortOption<RealComparisonSortKey>[] = [
  { ...nameOption, label: 'Saved resume' },
  { key: 'target', label: 'Exact target', ascendingLabel: 'A to Z', descendingLabel: 'Z to A' },
  { ...scoreOption, label: 'Assessment / evidence match' },
  { ...statusOption, label: 'Status / actions' },
]

export const sampleComparisonSortOptions: readonly TableSortOption<SampleComparisonSortKey>[] = [
  { ...nameOption, label: 'Resume' }, scoreOption,
  { key: 'coverage', label: 'Evidence coverage', ascendingLabel: 'fewest cited criteria first', descendingLabel: 'most cited criteria first' },
  { ...statusOption, label: 'Status / actions' },
]

export const targetScoreSortExplanation = 'Select one exact job or grade to sort scores. Scores across different targets are not a combined ranking.'
export const matrixSortExplanation = 'Select one exact job or grade to sort scores, citation coverage, or processing status. The matrix has no combined score or status.'

export function analysisProcessingRank(status: string | undefined): number | null {
  if (!status) return null
  if (status.toLowerCase() === 'complete') return 2
  return ['initializing', 'queued', 'running', 'parsing', 'generating', 'profiling'].includes(status.toLowerCase()) ? 1 : 0
}

export function realAnalysisProcessingRank(summary: RealAnalysisRunSummary): number | null {
  if (realAnalysisCancellationPaused(summary)) return 0
  if (realAnalysisCancellationPending(summary)) return 1
  return analysisProcessingRank(summary.run.status)
}

export function realComparisonProcessingRank(summary: RealAnalysisComparisonSummary, run?: RealAnalysisRunSummary): number | null {
  if (summary.comparison.status === 'complete') return 2
  if (run && realAnalysisCancellationPaused(run)) return 0
  if (run && realAnalysisCancellationPending(run)) return 1
  return analysisProcessingRank(summary.comparison.status)
}

export function selectSampleAnalysisRuns(
  runs: readonly AnalysisRun[], query: string, filter: AnalysisHistoryFilter, sort: TableSort<SampleAnalysisSortKey> | null,
): AnalysisRun[] {
  return sortTableRows(runs.filter((run) => matchesTableSearch(query, [getDisplayName(run, run.name)])
    && (filter === 'all' || (filter === 'complete' ? runStatus(run) === 'Complete' : runStatus(run) !== 'Complete'))), sort, (run, key) => {
    switch (key) {
      case 'name': return getDisplayName(run, run.name)
      case 'resumes': return run.resumes.length
      case 'targets': return run.targets.length
      case 'status': return analysisProcessingRank(runStatus(run))
      case 'created': return Date.parse(run.createdAt)
    }
  })
}

export function selectRealAnalysisRuns(
  runs: readonly RealAnalysisRunSummary[], query: string, filter: AnalysisHistoryFilter, sort: TableSort<RealAnalysisSortKey> | null,
): RealAnalysisRunSummary[] {
  return sortTableRows(runs.filter((summary) => matchesTableSearch(query, [getDisplayName(summary.run, summary.run.name)])
    && (filter === 'all' || (filter === 'complete' ? summary.run.status === 'complete' : summary.run.status !== 'complete'))), sort, (summary, key) => {
    switch (key) {
      case 'name': return getDisplayName(summary.run, summary.run.name)
      case 'status': return realAnalysisProcessingRank(summary)
      case 'comparisons': return summary.run.progress.total
      case 'created': return Date.parse(summary.run.createdAt)
    }
  })
}

export interface ComparisonBrowsing<Key extends string> {
  query: string
  targetId: string
  sort: TableSort<Key> | null
}

export function realComparisonTargetLabel(target: RealAnalysisTargetSummary): string {
  return `${getDisplayName(target, target.label)} · ${target.sublabel} · ${targetVersionLabel(target.selection)}`
}

export function sampleComparisonTargetLabel(target: AnalysisTarget): string {
  return `${getDisplayName(target, target.label)} · ${target.sublabel} · ${target.kind === 'job' ? 'Job' : 'Grade'} rubric v${target.rubric.version}${target.document ? ` · source v${target.document.version}` : ''}`
}

export function distinctTargetLabels<T extends { id: string }>(targets: readonly T[], label: (target: T) => string): string[] {
  const labels = targets.map(label)
  return labels.map((value, index) => labels.indexOf(value) !== labels.lastIndexOf(value) ? `${value} · ${targets[index].id}` : value)
}

export function selectRealComparisons(
  pairs: readonly RealAnalysisComparisonSummary[], manifestTargets: readonly RealAnalysisTargetSummary[],
  browsing: ComparisonBrowsing<RealComparisonSortKey>, run?: RealAnalysisRunSummary,
) {
  const targets = [...new Map([...manifestTargets, ...pairs.map((pair) => pair.comparison.target.summary)]
    .map((target) => [targetIdentity(target.selection), target])).values()]
  const selectedTarget = targets.find((target) => targetIdentity(target.selection) === browsing.targetId)
  const scoreEnabled = Boolean(selectedTarget) || targets.length === 1
  const sort = browsing.sort?.key === 'score' && !scoreEnabled ? null : browsing.sort
  const saved = sortTableRows(pairs, { key: 'index', direction: 'asc' }, (pair) => pair.comparison.index)
  const matches = saved.filter(({ comparison }) => {
    const resume = comparison.resume.summary
    const target = comparison.target.summary
    return (!browsing.targetId || targetIdentity(target.selection) === browsing.targetId)
      && matchesTableSearch(browsing.query, [resume.displayName, resume.name, resume.role, resume.sourceLabel, target.displayName, target.label, target.sublabel])
  })
  const rows = sortTableRows(matches, sort, (pair, key) => {
    const comparison = pair.comparison
    switch (key) {
      case 'name': return comparison.resume.summary.displayName ?? comparison.resume.summary.name
      case 'target': return getDisplayName(comparison.target.summary, comparison.target.summary.label).trim() ? realComparisonTargetLabel(comparison.target.summary) : null
      case 'status': return realComparisonProcessingRank(pair, run)
      case 'score': return comparison.status === 'complete' && comparison.resultSummary?.overall.status === 'available'
        ? comparison.resultSummary.overall.score : null
    }
  })
  return { rows, targets, selectedTarget, scoreEnabled, sort }
}

export interface SampleComparisonRow {
  snapshot: ResumeSnapshot
  comparisons: Map<string, Comparison>
}

export function sampleComparisonDefaultSort(run: AnalysisRun): TableSort<SampleComparisonSortKey> | null {
  return run.targets.length === 1 ? { key: 'score', direction: 'desc' } : null
}

export function selectSampleComparisons(run: AnalysisRun, browsing: ComparisonBrowsing<SampleComparisonSortKey>) {
  const targets = [...run.targets].sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'job' ? -1 : 1)
  const selectedTarget = targets.find((target) => target.id === browsing.targetId) ?? (targets.length === 1 ? targets[0] : undefined)
  const displayedTargets = selectedTarget ? [selectedTarget] : targets
  const sort = !selectedTarget && browsing.sort?.key !== 'name' ? null : browsing.sort
  const byResume = new Map<string, Map<string, Comparison>>()
  for (const comparison of run.comparisons) {
    const comparisons = byResume.get(comparison.resumeId) ?? new Map<string, Comparison>()
    comparisons.set(comparison.targetId, comparison)
    byResume.set(comparison.resumeId, comparisons)
  }
  const targetMatches = matchesTableSearch(browsing.query, displayedTargets.flatMap((target) => [target.displayName, target.label, target.sublabel]))
  const matches: SampleComparisonRow[] = run.resumes.filter(({ resume, document }) => targetMatches
    || matchesTableSearch(browsing.query, [resume.displayName, resume.name, resume.role, resume.sourceLabel, document.title]))
    .map((snapshot) => ({ snapshot, comparisons: byResume.get(snapshot.resume.id) ?? new Map<string, Comparison>() }))
  const rows = sortTableRows(matches, sort, (row, key) => {
    const comparison = selectedTarget ? row.comparisons.get(selectedTarget.id) : undefined
    switch (key) {
      case 'name': return getDisplayName(row.snapshot.resume, row.snapshot.resume.name)
      case 'score': return comparison?.status === 'complete' ? comparison.score : null
      case 'coverage': return comparison?.status === 'complete' ? comparison.criteria.filter((criterion) => criterion.citations.length > 0).length : null
      case 'status': return analysisProcessingRank(comparison?.status)
    }
  })
  const comparisonCount = rows.reduce((count, row) => count + displayedTargets.filter((target) => row.comparisons.has(target.id)).length, 0)
  return { rows, targets, selectedTarget, displayedTargets, sort, comparisonCount }
}
