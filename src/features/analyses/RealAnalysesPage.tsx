import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowUpRight, BarChart3, LoaderCircle, Plus, RotateCcw, ShieldCheck } from 'lucide-react'
import { useRealAnalyses } from '../../app/real-analyses-context'
import type { RealAnalysisRunSummary } from '../../domain/real-analyses'
import { dateLabel } from '../../domain/selectors'
import { Badge, Button, EmptyState, InlineError, PageHeader, SearchField, SegmentedControl } from '../../components/ui'
import { SortableHeader, TableSortSelect } from '../../components/ui/TableSorting'
import type { TableSort } from '../../domain/tableSorting'
import { realAnalysisSortOptions, selectRealAnalysisRuns, type RealAnalysisSortKey } from './analysisTableBrowsing'
import { realAnalysisCancellationPaused, realAnalysisCancellationPending } from './realAnalysisUi'

export function RealAnalysisStatus({ summary }: { summary: RealAnalysisRunSummary }) {
  const { run } = summary
  const paused = realAnalysisCancellationPaused(summary)
  const labels = { initializing: 'Freezing inputs', queued: 'Queued', running: 'Running', complete: 'Complete', partial: 'Partial / needs attention', failed: 'Failed', cancelled: 'Cancelled' }
  return <Badge dot tone={paused || ['partial', 'failed'].includes(run.status) ? 'warning' : run.status === 'complete' ? 'success' : 'neutral'}>{paused ? 'Cancellation paused' : realAnalysisCancellationPending(summary) ? 'Cancelling unfinished work' : labels[run.status]}</Badge>
}

export function RealAnalysesPage() {
  const api = useRealAnalyses()
  return <RealAnalysesHistory key={api?.workspaceId ?? 'unavailable'} />
}

function RealAnalysesHistory() {
  const api = useRealAnalyses()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'complete' | 'attention'>('all')
  const [sort, setSort] = useState<TableSort<RealAnalysisSortKey> | null>(null)
  if (!api) return <EmptyState title="Real analyses require a cloud workspace" description="Standalone mode only contains explicitly fictional analyses. No sample results replace unavailable real results." />
  if (api.phase === 'unavailable') return <EmptyState title="Saved real analyses are unavailable" description={api.error ?? 'The private analysis history service is not available. No samples are substituted.'}
    action={<Button onClick={() => void api.refresh()}>Check availability</Button>} />
  const runs = selectRealAnalysisRuns(api.summaries, query, filter, sort)
  return <>
    <PageHeader eyebrow="SAVED REAL EVIDENCE" title="Your analyses" description="Durable runs with frozen inputs, independent comparisons, and inspectable evidence."
      actions={<><Button icon={RotateCcw} onClick={() => void api.refresh()}>Refresh</Button><Button icon={Plus} variant="primary" disabled={!api.canWrite || api.phase !== 'ready' || !api.features?.realAnalyses} onClick={() => navigate('/analyses/new?data=real')}>New analysis</Button></>} />
    {api.error && <div className="mb-5"><InlineError>{api.error} The last acknowledged summaries are retained; no samples are substituted.</InlineError></div>}
    {api.phase === 'ready' && !api.features?.realAnalyses && <div className="info-callout mb-5"><ShieldCheck size={18} aria-hidden="true" /><div><strong>Saved history remains available.</strong>
      <p>{api.creationError ?? 'Checking availability for new analyses…'} Existing runs use their frozen inputs, not current source stores.</p></div></div>}
    {!api.canWrite && <p className="mb-5 text-[12px] text-muted">Read-only workspace. Saved results and source evidence remain available for review.</p>}
    <section className="panel" aria-label="Real analysis history">
      <div className="library-toolbar"><SegmentedControl label="Filter real analyses" value={filter} onChange={setFilter}
        options={[{ value: 'all', label: 'All real analyses', count: api.summaries.length }, { value: 'complete', label: 'Complete' }, { value: 'attention', label: 'In progress / attention' }]} />
        <SearchField value={query} onChange={setQuery} placeholder="Find a real analysis…" />
        <TableSortSelect label="Sort real analyses" options={realAnalysisSortOptions} sort={sort} onChange={setSort} /></div>
      {runs.length ? <div className="table-wrap"><table className="data-table">
        <caption className="sr-only">Saved real analysis runs. Progress and score availability are separate; there is no combined ranking.</caption>
        <thead><tr>{realAnalysisSortOptions.map((option) => <SortableHeader key={option.key} option={option} sort={sort} onChange={setSort} />)}
          <th scope="col"><span className="sr-only">Open analysis</span></th></tr></thead>
        <tbody>{runs.map((summary) => <tr key={summary.run.id}>
          <td><div className="flex min-w-[200px] items-center gap-3"><span className="job-monogram"><BarChart3 size={18} aria-hidden="true" /></span><div>
            <Link className="row-title" to={`/analyses/${encodeURIComponent(summary.run.id)}?data=real`}>{summary.run.name}</Link><p className="row-meta">Real evidence · immutable input snapshots</p></div></div></td>
          <td><RealAnalysisStatus summary={summary} /></td>
          <td><p className="text-[11px]">{summary.run.progress.complete} complete / {summary.run.progress.total} total</p><p className="row-meta">{summary.run.progress.scored} scored · {summary.run.progress.unscored} without an overall score</p>
            <p className="row-meta">{summary.run.progress.failed} failed · {summary.run.progress.cancelled} cancelled</p>{summary.run.error && <p className="mt-2 text-[11px] text-[var(--cp-danger)]">{summary.run.error.message}</p>}</td>
          <td className="text-[11px] text-muted">{dateLabel(summary.run.createdAt)}</td>
          <td><Link className="button button-ghost icon-button" to={`/analyses/${encodeURIComponent(summary.run.id)}?data=real`} aria-label={`Open real analysis ${summary.run.name}`}><ArrowUpRight size={17} aria-hidden="true" /></Link></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState icon={api.phase === 'loading' ? LoaderCircle : BarChart3}
        title={api.phase === 'loading' ? 'Loading real analysis history' : api.phase === 'error' ? 'The analysis service is unavailable' : api.summaries.length ? 'No matching analyses' : 'No real analyses yet'}
        description={api.phase === 'loading' ? 'Reading every authorized history page.' : api.phase === 'error' ? 'Retry the real service; fictional results are never substituted.'
          : api.summaries.length ? 'Try a different name or status filter.' : 'Import real resumes, select ready inputs and exact targets, then explicitly run an analysis.'}
        action={<Button disabled={api.phase !== 'ready' || (!api.summaries.length && (!api.canWrite || !api.features?.realAnalyses))} onClick={() => { if (api.summaries.length) { setQuery(''); setFilter('all') } else navigate('/analyses/new?data=real') }}>{api.summaries.length ? 'Clear filters' : 'Build an analysis'}</Button>} />}
      <div className="table-bottom"><span>{runs.length} real {runs.length === 1 ? 'analysis' : 'analyses'}</span><span>Later source and rubric edits do not rewrite results.</span></div>
    </section>
    <div className="info-callout mt-5"><ShieldCheck size={18} aria-hidden="true" /><div><strong>Human review remains essential.</strong><p>Scores measure evidence in the submitted document, not intrinsic ability, official GS eligibility, or a hiring decision. Different job and grade totals stay separate.</p></div></div>
  </>
}
