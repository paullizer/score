import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, Layers3, LoaderCircle, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { useRealAnalyses } from '../../app/real-analyses-context'
import type { RealAnalysisComparisonSummary, RealAnalysisRunSummary } from '../../domain/real-analyses'
import { dateLabel } from '../../domain/selectors'
import { Badge, Button, EmptyState, InlineError, PageHeader, Score, SearchField } from '../../components/ui'
import { SortableHeader, TableSortSelect } from '../../components/ui/TableSorting'
import type { TableSort } from '../../domain/tableSorting'
import { RealAnalysisStatus } from './RealAnalysesPage'
import { realAnalysisCancellationPaused, realAnalysisCancellationPending, realAnalysisLink, targetIdentity, targetVersionLabel } from './realAnalysisUi'
import {
  distinctTargetLabels, realComparisonSortOptions, realComparisonTargetLabel, selectRealComparisons, targetScoreSortExplanation, type RealComparisonSortKey,
} from './analysisTableBrowsing'
import { RealComparisonReview } from './RealComparisonReview'
import { AnalysisReportExport } from './AnalysisReportExport'
import { ArchivedBadge, EntityLifecycleActions, LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'

export function RealComparisonValue({ summary }: { summary: RealAnalysisComparisonSummary }) {
  const { comparison } = summary
  const result = comparison.resultSummary
  if (comparison.status !== 'complete') return <Badge tone={comparison.status === 'failed' ? 'danger' : 'neutral'}>{comparison.status === 'running' ? 'Assessing evidence' : comparison.status}</Badge>
  return <div className="space-y-2">{result?.overall.status === 'available' ? <Score value={result.overall.score} /> : <span className="text-[12px] font-semibold">No overall score</span>}
    <div><Badge tone={result?.completion === 'limited' ? 'warning' : 'success'}>{result?.completion === 'limited' ? 'Complete · limited assessment' : 'Complete'}</Badge></div>
    {result?.overall.status === 'withheld' && <p className="max-w-xs text-[10px] text-muted">{result.overall.message}</p>}
  </div>
}

export function RealComparisonActions({ summary }: { summary: RealAnalysisComparisonSummary }) {
  const api = useRealAnalyses()
  const { canEdit } = useLifecycleAccess({ kind: 'analysis', id: summary.comparison.runId })
  const [error, setError] = useState('')
  const pair = summary.comparison
  const run = api?.summaries.find((item) => item.run.id === pair.runId)
  const cancelling = Boolean(run && realAnalysisCancellationPending(run))
  const paused = Boolean(run && realAnalysisCancellationPaused(run))
  const active = ['queued', 'running'].includes(pair.status)
  const canRetry = pair.status === 'cancelled' || pair.status === 'failed'
  async function act(action: 'retryComparison' | 'cancelComparison') {
    if (!api || !canEdit || api.pending(pair.runId) || cancelling) return
    setError('')
    try { await api[action](pair.runId, pair.id, summary.etag) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The comparison request could not be acknowledged.') }
  }
  return <div className="space-y-2"><div className="flex flex-wrap gap-2">
    {active && <Button size="sm" variant="ghost" icon={X} disabled={!canEdit || !api?.canWrite || api.pending(pair.runId) || api.phase !== 'ready' || cancelling}
      aria-label={`Cancel comparison ${pair.index + 1}`} onClick={() => void act('cancelComparison')}>Cancel pair</Button>}
    {canRetry && <Button size="sm" icon={RotateCcw} disabled={!canEdit || !api?.canWrite || api.pending(pair.runId) || api.phase !== 'ready' || cancelling}
      title={cancelling ? 'Wait for the server to finish cancelling the run before retrying a saved pair.' : 'Explicitly retry this comparison with the same frozen inputs, even when automatic retries have stopped.'}
      aria-label={`Retry comparison ${pair.index + 1} with saved inputs`} onClick={() => void act('retryComparison')}>Retry saved pair</Button>}
  </div>{cancelling && <p className="text-[10px] text-muted">{paused ? 'Resume the paused run cancellation before retrying individual pairs.' : 'Run cancellation is still being finalized.'}</p>}{error && <InlineError>{error}</InlineError>}</div>
}

function RealRunActions({ summary }: { summary: RealAnalysisRunSummary }) {
  const api = useRealAnalyses()!
  const { canEdit } = useLifecycleAccess({ kind: 'analysis', id: summary.run.id })
  const [error, setError] = useState('')
  const run = summary.run
  const cancelling = realAnalysisCancellationPending(summary)
  const paused = realAnalysisCancellationPaused(summary)
  const active = ['initializing', 'queued', 'running'].includes(run.status)
  const canRetry = run.progress.failed > 0 || run.progress.cancelled > 0 || ['failed', 'cancelled'].includes(run.status)
  async function act(action: 'retry' | 'cancel') {
    if (!canEdit || api.pending(run.id) || (cancelling && (!paused || action !== 'retry'))) return
    setError('')
    try {
      if (action === 'retry') await api.retry(run.id, {}, summary.etag)
      else await api.cancel(run.id, summary.etag)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'This run request could not be acknowledged.') }
  }
  return <div className="space-y-2"><div className="flex flex-wrap gap-2">
    {active && <Button icon={X} disabled={!canEdit || !api.canWrite || api.pending(run.id) || api.phase !== 'ready'} onClick={() => void act('cancel')}>Cancel unfinished</Button>}
    {paused ? <Button icon={RotateCcw} disabled={!canEdit || !api.canWrite || api.pending(run.id) || api.phase !== 'ready'}
      title="Resume only the saved cancellation cleanup. This does not restart scoring or change completed results."
      onClick={() => void act('retry')}>Resume cancellation</Button> : canRetry && <Button icon={RotateCcw} disabled={!canEdit || !api.canWrite || api.pending(run.id) || api.phase !== 'ready' || cancelling}
      title={cancelling ? 'Cancellation must finish before a saved run can be retried.' : 'Explicitly retry failed or cancelled comparisons with their saved inputs. Completed results are unchanged.'}
      onClick={() => void act('retry')}>Retry failed / cancelled</Button>}
  </div>{cancelling && <p className="text-[11px] text-muted" role="status">{paused
    ? 'Cancellation stopped after a processing error. Resume the saved cleanup explicitly; scoring will remain stopped and completed results will stay unchanged.'
    : 'Cancellation accepted. The server is still marking unfinished comparisons; retry becomes available when that work finishes.'}</p>}{error && <InlineError>{error}</InlineError>}</div>
}

export function RealAnalysisDetail({ id }: { id: string }) {
  const api = useRealAnalyses()
  return <RealAnalysisView key={`${api?.workspaceId ?? 'unavailable'}:${id}`} id={id} />
}

function RealAnalysisView({ id }: { id: string }) {
  const api = useRealAnalyses()
  const navigate = useNavigate()
  const { canEdit, deleting, removed } = useLifecycleAccess({ kind: 'analysis', id })
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [targetId, setTargetId] = useState('')
  const [sort, setSort] = useState<TableSort<RealComparisonSortKey> | null>(null)
  const entry = api?.detail(id)
  const pairs = api?.comparisons(id)
  const ensure = api?.ensureDetail
  const ensurePairs = api?.ensureComparisons
  const selectedId = params.get('result')
  useEffect(() => {
    if (api?.phase !== 'ready') return
    void ensure?.(id)
    void ensurePairs?.(id)
  }, [api?.phase, ensure, ensurePairs, entry?.state, id, pairs?.state])
  if (!api) return <EmptyState title="Real analyses require a cloud workspace" description="A real analysis cannot be read from sample storage." />
  const back = <Link className="back-link" to={selectedId ? `/analyses/${encodeURIComponent(id)}?data=real` : '/analyses?data=real'}><ArrowLeft size={14} aria-hidden="true" />{selectedId ? 'All saved comparisons' : 'Back to real analyses'}</Link>
  if (deleting || (removed && entry?.state === 'ready')) return <>{back}<LifecycleBanner target={{ kind: 'analysis', id }} /><EmptyState title="Analysis cleanup or removal" description="Cached comparisons, snapshots, and downloads are no longer available. Retry the lifecycle operation above if permanent cleanup is incomplete." /></>
  if (api.phase === 'unavailable') return <>{back}<EmptyState title="Saved real analysis history is unavailable" description={api.error ?? 'The private history service is unavailable; no samples are substituted.'} action={<Button onClick={() => void api.refresh()}>Check service</Button>} /></>
  if (entry?.state !== 'ready') return <>{back}<EmptyState icon={entry?.state === 'error' || api.phase === 'error' ? Layers3 : LoaderCircle}
    title={entry?.state === 'error' || api.phase === 'error' ? 'This real analysis could not be opened' : 'Opening saved real analysis'}
    description={entry?.state === 'error' ? entry.error : api.error ?? 'Loading the authorized run and immutable input manifest, not the current live documents.'}
    action={<Button onClick={() => { void api.refresh(); void api.ensureDetail(id, true) }}>Retry analysis</Button>} /></>
  const detail = entry.value
  const summary = api.summaries.find((item) => item.run.id === id) ?? detail
  const run = summary.run
  const finished = run.progress.complete + run.progress.failed + run.progress.cancelled
  const savedPairs = pairs?.state === 'ready' ? pairs.value : []
  const browsing = selectRealComparisons(savedPairs, detail.targets, { query, targetId, sort }, summary)
  const targetLabels = distinctTargetLabels(browsing.targets, realComparisonTargetLabel)
  const sortOptions = realComparisonSortOptions.map((option) => ({
    ...option, disabled: option.key === 'score' && !browsing.scoreEnabled,
    title: option.key === 'score' && !browsing.scoreEnabled ? targetScoreSortExplanation : undefined,
  }))
  const listError = pairs?.state === 'error' || (pairs?.state === 'ready' && pairs.error) || api.phase === 'error'
  function chooseTarget(next: string) {
    setTargetId(next)
    if (!next && browsing.targets.length > 1 && sort?.key === 'score') setSort(null)
  }
  function openPair(pairId: string) {
    const next = new URLSearchParams(params)
    next.set('data', 'real')
    next.set('result', pairId)
    setParams(next)
  }
  return <>{back}
    <PageHeader eyebrow="REAL EVIDENCE · FROZEN INPUTS" title={run.name} description="Review each saved resume/target pair independently. Completion, coverage, and overall-score availability are separate."
      actions={<><EntityLifecycleActions target={{ kind: 'analysis', id }} name={run.name} onComplete={(action) => { if (action === 'delete') navigate('/analyses?data=real') }} /><RealRunActions summary={summary} /><AnalysisReportExport source={{
        kind: 'real', workspaceId: api.workspaceId, detail: { ...detail, ...summary },
        comparisons: pairs?.state === 'ready' ? pairs.value : null, available: api.phase === 'ready',
      }} />{canEdit && api.canWrite && api.features?.realAnalyses
        ? <Link className="button button-secondary button-md" {...realAnalysisLink({ from: id }, api.workspaceId)}><Layers3 size={15} aria-hidden="true" />New run with these inputs</Link>
        : <Button icon={Layers3} disabled title={!canEdit ? 'Unarchive this analysis and its workspace before creating another run.' : api.creationError ?? 'New-run readiness has not been confirmed.'}>New run with these inputs</Button>}</>} />
    <LifecycleBanner target={{ kind: 'analysis', id }} />
    <div className="analysis-meta"><Badge tone="accent">Real evidence assessment</Badge><RealAnalysisStatus summary={summary} /><ArchivedBadge target={{ kind: 'analysis', id }} /><span>{detail.resumes.length} resumes</span><span>{detail.targets.length} separate targets</span><span>{dateLabel(run.createdAt)}</span><span className="flex items-center gap-1.5"><ShieldCheck size={13} aria-hidden="true" />Immutable snapshots</span></div>
    {(entry.error || api.error) && <div className="mb-5"><InlineError>{entry.error ?? api.error} The last acknowledged run is shown. <Button size="sm" onClick={() => { void api.refresh(); void api.ensureDetail(id, true) }}>Reload progress</Button></InlineError></div>}
    {!api.features?.realAnalyses && <p className="mb-5 text-[11px] text-muted">{api.creationError ?? 'Checking new-run readiness.'} This saved run and its frozen evidence are independent of new-run readiness.</p>}
    {run.error && <div className="mb-5"><InlineError>{run.error.code}: {run.error.message} Processing failures are not zero scores.</InlineError></div>}
    <section className="run-progress panel" aria-label="Real analysis progress" aria-live="polite"><div><span>{finished} / {run.progress.total} comparisons finished</span><span>{run.progress.initialized} initialized</span></div>
      <progress max={Math.max(1, run.progress.total)} value={finished} aria-label="Finished comparisons" />
      <p>{run.progress.complete} complete · {run.progress.running} assessing · {run.progress.queued} queued · {run.progress.failed} failed · {run.progress.cancelled} cancelled</p>
      <p>{run.progress.scored} with a server-calculated score · {run.progress.unscored} completed without an overall score. Saved results are never overwritten when other pairs retry.</p>
      {realAnalysisCancellationPending(summary) && <p>Cancellation is progressing in bounded batches. This view keeps polling until the server confirms completion.</p>}
    </section>
    {selectedId ? <SelectedRealComparison runId={id} comparisonId={selectedId} /> : <section className="panel mt-5" aria-label="Real comparisons">
      <div className="section-heading"><div><h2>Separate comparisons, not a cross-job ranking</h2><p>Open a result for the complete criterion breakdown and exact source quotations.</p></div>
        <Button size="sm" icon={RotateCcw} onClick={() => { void api.ensureDetail(id, true); void api.ensureComparisons(id, true) }}>Refresh pairs</Button></div>
      <div className="library-toolbar">
        <SearchField label="Search comparisons" value={query} onChange={setQuery} placeholder="Find a candidate, document, or target…" />
        <label className="table-sort-select"><span>Target</span><select className="filter-select" aria-label="Comparison target" value={targetId} onChange={(event) => chooseTarget(event.target.value)}>
          <option value="">All targets</option>{browsing.targets.map((target, index) => <option key={targetIdentity(target.selection)} value={targetIdentity(target.selection)}>{targetLabels[index]}</option>)}
        </select></label>
        <TableSortSelect label="Sort comparisons" defaultLabel="Saved order" options={sortOptions} sort={browsing.sort} onChange={setSort} />
      </div>
      {!browsing.scoreEnabled && <p className="px-4 pb-4 text-[11px] text-muted">{targetScoreSortExplanation}</p>}
      {(pairs?.state === 'error' || (pairs?.state === 'ready' && pairs.error)) && <div className="p-4"><InlineError>{pairs.error} <Button size="sm" onClick={() => void api.ensureComparisons(id, true)}>Retry comparison list</Button></InlineError></div>}
      {browsing.rows.length > 0 ? <div className="table-wrap"><table className="data-table comparison-table">
        <thead><tr>{sortOptions.map((option) => <SortableHeader key={option.key} option={option} sort={browsing.sort} onChange={setSort} />)}</tr></thead>
        <tbody>{browsing.rows.map((pair) => {
          const comparison = pair.comparison
          const resume = comparison.resume.summary
          const target = comparison.target.summary
          return <tr key={comparison.id}><td className="min-w-[180px]"><button className="row-title text-left" onClick={() => openPair(comparison.id)}>{resume.name ?? 'Name not stated'}</button>
            <p className="row-meta">{resume.role ?? 'Role not stated'}</p><p className="row-meta break-all">{resume.sourceLabel}</p><p className="row-meta">Document v{resume.selection.documentVersion}</p></td>
            <td className="min-w-[210px]"><strong className="block text-[12px]">{target.label}</strong><p className="row-meta">{target.sublabel}</p><div className="mt-2"><Badge>{targetVersionLabel(target.selection)}</Badge></div>
              {target.kind === 'grade' && target.newerDraftAvailable && <p className="row-meta">An unapproved newer draft was not used.</p>}</td>
            <td><RealComparisonValue summary={pair} />{comparison.error && <p className="mt-2 max-w-xs text-[11px] text-[var(--cp-danger)]">{comparison.error.code}: {comparison.error.message}</p>}
              {comparison.nextAttemptAt && <p className="row-meta">Automatic retry {dateLabel(comparison.nextAttemptAt)}</p>}<p className="row-meta">Attempt {comparison.attempts} · manual retries {comparison.retryCount}</p></td>
            <td><div className="space-y-3"><div><Badge dot tone={comparison.status === 'complete' ? 'success' : ['failed', 'cancelled'].includes(comparison.status) ? 'warning' : 'neutral'}>
              {{ queued: 'Queued', running: 'Running', complete: 'Complete', failed: 'Failed', cancelled: 'Cancelled' }[comparison.status]}</Badge></div>
              <Button size="sm" variant="ghost" icon={ArrowUpRight} aria-label={`Review comparison ${comparison.index + 1}: ${resume.name ?? 'Name not stated'} against ${target.label}`}
              onClick={() => openPair(comparison.id)}>Review saved pair</Button><RealComparisonActions summary={pair} /></div></td>
          </tr>
        })}</tbody>
      </table></div> : savedPairs.length ? <EmptyState title="No matching comparisons" description="Try a different candidate, document, or target. Only saved summary metadata is searched."
        action={<Button onClick={() => { setQuery(''); chooseTarget('') }}>Clear comparison filters</Button>} />
        : <EmptyState icon={listError ? Layers3 : LoaderCircle} title={listError ? 'The comparison list could not be loaded' : pairs?.state === 'ready' ? 'Comparison initialization is still pending' : 'Loading independent comparisons'}
          description={listError ? 'Retry the real comparison service. No sample rows or scores are substituted.' : 'The server materializes the frozen comparison plan in bounded batches. No scores or source snapshots are fabricated while work is pending.'} />}
      <div className="table-bottom"><span>Showing {browsing.rows.length} of {savedPairs.length} saved comparison records / {run.progress.total} planned</span><span>Retries reuse saved inputs, not current live sources.</span></div>
    </section>}
    <div className="info-callout mt-5"><ShieldCheck size={18} aria-hidden="true" /><p>Human review only. Scores describe evidence in the submitted document, not a person’s intrinsic ability. Missing evidence is not proof of missing skills; GS assessments are not official qualification or eligibility determinations.</p></div>
  </>
}

function SelectedRealComparison({ runId, comparisonId }: { runId: string; comparisonId: string }) {
  const api = useRealAnalyses()!
  const entry = api.comparison(runId, comparisonId)
  const ensure = api.ensureComparison
  useEffect(() => { if (api.phase === 'ready') void ensure(runId, comparisonId) }, [api.phase, comparisonId, ensure, entry.state, runId])
  if (entry.state !== 'ready') return <section className="panel mt-5"><EmptyState icon={entry.state === 'error' ? Layers3 : LoaderCircle}
    title={entry.state === 'error' ? 'This comparison could not be opened' : 'Opening exact saved snapshots'}
    description={entry.state === 'error' ? entry.error : 'Retrieving the immutable resume, target, and result. No live versions are substituted.'}
    action={<Button onClick={() => void ensure(runId, comparisonId, true)}>Retry saved comparison</Button>} /></section>
  return <div className="mt-5">{entry.error && <div className="mb-5"><InlineError>{entry.error} <Button size="sm" onClick={() => void ensure(runId, comparisonId, true)}>Reload saved comparison</Button></InlineError></div>}
    <RealComparisonReview key={comparisonId} detail={entry.value} actions={<RealComparisonActions summary={entry.value} />} />
  </div>
}
