import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, ChevronDown, FileText, Layers3, LoaderCircle, Quote, RotateCcw, ScanLine, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import type { AnalysisRun, Citation, Comparison } from '../../domain/types'
import { dateLabel, runStatus } from '../../domain/selectors'
import { Avatar, Badge, Button, DemoNote, EmptyState, PageHeader, Score, SearchField, SegmentedControl } from '../../components/ui'
import { SortableHeader, TableSortSelect } from '../../components/ui/TableSorting'
import type { TableSort } from '../../domain/tableSorting'
import { DocumentViewer } from '../../components/documents/DocumentViewer'
import { ArchivedBadge, EntityLifecycleActions, LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { analysisDataMode, sampleDataLink } from '../../app/real-data-mode'
import {
  distinctTargetLabels, matrixSortExplanation, sampleComparisonDefaultSort, sampleComparisonSortOptions, sampleComparisonTargetLabel,
  selectSampleComparisons, type SampleComparisonSortKey,
} from './analysisTableBrowsing'
import { RealAnalysisDetail } from './RealAnalysisDetail'
import { AnalysisReportExport } from './AnalysisReportExport'

function ComparisonValue({ comparison }: { comparison: Comparison | undefined }) {
  if (!comparison) return <Badge tone="warning">Unavailable</Badge>
  if (comparison.status === 'complete') return <Score value={comparison.score} />
  return <span className="comparison-state">{comparison.status === 'running' && <LoaderCircle size={13} className="animate-spin" />}
    {comparison.status === 'failed' ? 'Needs retry' : comparison.status === 'cancelled' ? 'Cancelled' : comparison.status === 'running' ? 'Assessing...' : 'Queued'}
  </span>
}

export function AnalysisDetail() {
  const { id } = useParams()
  const { workspace, cloud } = useWorkspace()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const mode = analysisDataMode(params, Boolean(cloud), workspace, id)
  if (mode === 'invalid') return <EmptyState title="Unknown analysis mode" description="Choose real analyses or the explicitly fictional Samples history." action={<Button onClick={() => navigate('/analyses')}>Open analyses</Button>} />
  if (mode === 'real' && id) return <RealAnalysisDetail id={id} />
  const run = workspace.runs.find((item) => item.id === id)
  if (!run) return <EmptyState title="This analysis is no longer here" description="A demo reset may have replaced it. Open the analysis library to find your saved comparisons." action={<Button onClick={() => navigate(sampleDataLink('/analyses', Boolean(cloud)))}>Back to analyses</Button>} />
  if (run.targets.some((target) => target.rubric.dataKind === 'real' || target.job?.dataKind === 'real') || run.resumes.some((snapshot) => snapshot.resume.sample !== true || snapshot.document.sample !== true)) return <EmptyState title="Real inputs cannot have demo scores" description="This run contains real inputs, possibly mixed with samples. Its simulated results are not shown or retried. Use the separate real analysis workflow." action={<Button onClick={() => navigate('/analyses?data=real')}>Open real analyses</Button>} />
  return <RunView key={`${cloud?.currentWorkspaceId ?? 'standalone'}:${run.id}`} run={run} />
}

function RunView({ run }: { run: AnalysisRun }) {
  const { cancelRun, retryRun, cloud } = useWorkspace()
  const { canEdit, deleting, removed } = useLifecycleAccess({ kind: 'analysis', id: run.id })
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [targetId, setTargetId] = useState('')
  const [sort, setSort] = useState<TableSort<SampleComparisonSortKey> | null>(() => sampleComparisonDefaultSort(run))
  const selectedId = params.get('result')
  const selected = run.comparisons.find((comparison) => comparison.id === selectedId)
  const status = runStatus(run)
  const working = status === 'Running'
  const needsRetry = run.comparisons.some((comparison) => comparison.status === 'failed' || comparison.status === 'cancelled')
  const finished = run.comparisons.filter((comparison) => comparison.status !== 'queued' && comparison.status !== 'running').length
  const complete = run.comparisons.filter((comparison) => comparison.status === 'complete').length
  const browsing = selectSampleComparisons(run, { query, targetId, sort })
  const targetLabels = distinctTargetLabels(browsing.targets, sampleComparisonTargetLabel)
  const sortOptions = sampleComparisonSortOptions.map((option) => ({
    ...option, disabled: option.key !== 'name' && !browsing.selectedTarget,
    title: option.key !== 'name' && !browsing.selectedTarget ? matrixSortExplanation : undefined,
  }))
  function changeSort(next: TableSort<SampleComparisonSortKey> | null) { setSort(next ?? sampleComparisonDefaultSort(run)) }
  function chooseTarget(next: string) {
    setTargetId(next)
    if (!next && run.targets.length > 1 && sort?.key !== 'name') setSort(null)
  }
  function openResult(id: string) { const next = new URLSearchParams(params); next.set('result', id); if (cloud) next.set('data', 'samples'); setParams(next) }

  return <>
    <Link className="back-link" to={sampleDataLink(selectedId ? `/analyses/${run.id}` : '/analyses', Boolean(cloud))}><ArrowLeft size={14} />{selectedId ? 'All comparisons' : 'Back to analyses'}</Link>
    <PageHeader eyebrow="EVIDENCE-LED REVIEW" title={run.name} description="A clear view of the match, and the passages behind it."
      actions={<><EntityLifecycleActions target={{ kind: 'analysis', id: run.id }} name={run.name} onComplete={(action) => { if (action === 'delete') navigate(sampleDataLink('/analyses', Boolean(cloud))) }} />{working && <Button icon={X} disabled={!canEdit} onClick={() => cancelRun(run.id)}>Cancel pending</Button>}{needsRetry && !working && <Button icon={RotateCcw} disabled={!canEdit} onClick={() => retryRun(run.id)}>Retry unfinished</Button>}
        <AnalysisReportExport source={{ kind: 'sample', run, available: !deleting && !removed }} />
        <Button icon={Sparkles} disabled={!canEdit} onClick={() => navigate(sampleDataLink(`/analyses/new?from=${run.id}`, Boolean(cloud)))}>New run with these inputs</Button></>} />
    <LifecycleBanner target={{ kind: 'analysis', id: run.id }} />
    <ArchivedBadge target={{ kind: 'analysis', id: run.id }} />
    <div className="analysis-meta"><Badge tone="accent">Simulated scoring</Badge><Badge tone={status === 'Complete' ? 'success' : status === 'Needs attention' ? 'warning' : 'neutral'} dot>{status}</Badge><span>{run.resumes.length} {run.resumes.length === 1 ? 'resume' : 'resumes'}</span><span>{run.targets.length} separate {run.targets.length === 1 ? 'rubric' : 'rubrics'}</span><span>{dateLabel(run.createdAt)}</span><span className="ml-auto flex items-center gap-1.5"><ShieldCheck size={12} />Saved version snapshots</span></div>
    {working && <div className="run-progress panel" aria-live="polite"><div><span className="flex items-center gap-2"><LoaderCircle size={15} className="animate-spin" />Preparing evidence-backed sample results</span><span>{finished} / {run.comparisons.length}</span></div>
      <progress max={run.comparisons.length} value={finished} aria-label="Analysis progress" /><p>Every comparison is independent. Completed results are available below.</p></div>}
    {selectedId && !selected ? <EmptyState title="This result could not be found" description="Choose a comparison from this analysis instead." action={<Button onClick={() => setParams(cloud ? { data: 'samples' } : {})}>View all comparisons</Button>} />
      : selected ? <ResultReview key={selected.id} run={run} comparison={selected} />
        : <section className="panel">
          <div className="section-heading"><div><h2>{run.targets.length === 1 ? 'Applicant comparison' : run.resumes.length === 1 ? 'Your target comparisons' : 'The comparison workspace'}</h2><p>Separate scores. Consistent criteria. Select any result to see its evidence.</p></div></div>
          <div className="library-toolbar">
            <SearchField label="Search comparisons" value={query} onChange={setQuery} placeholder="Find a candidate, document, or target…" />
            <label className="table-sort-select"><span>Target</span><select className="filter-select" aria-label="Comparison target" value={targetId} onChange={(event) => chooseTarget(event.target.value)}>
              <option value="">All targets</option>{browsing.targets.map((target, index) => <option key={target.id} value={target.id}>{targetLabels[index]}</option>)}
            </select></label>
            <TableSortSelect label="Sort comparisons" defaultLabel={run.targets.length === 1 ? 'Default order (score: high to low)' : 'Saved order'}
              options={sortOptions} sort={browsing.sort} onChange={changeSort} />
          </div>
          {!browsing.selectedTarget && <p className="px-4 pb-4 text-[11px] text-muted">{matrixSortExplanation}</p>}
          {browsing.rows.length === 0 ? <EmptyState title={run.resumes.length ? 'No matching comparisons' : 'No saved comparisons'}
            description={run.resumes.length ? 'Try a different candidate, document, or target. Only saved summary metadata is searched.' : 'This sample run has no saved resume rows. No results are fabricated.'}
            action={run.resumes.length ? <Button onClick={() => { setQuery(''); chooseTarget('') }}>Clear comparison filters</Button> : undefined} />
            : browsing.selectedTarget ? <div className="table-wrap"><table className="data-table comparison-table">
            <thead><tr>{sortOptions.map((option) => <SortableHeader key={option.key} option={option} sort={browsing.sort} onChange={changeSort} />)}</tr></thead>
            <tbody>{browsing.rows.map(({ snapshot: { resume }, comparisons }) => {
              const comparison = comparisons.get(browsing.selectedTarget!.id)
              const supported = comparison?.criteria.filter((criterion) => criterion.citations.length > 0).length ?? 0
              return <tr key={resume.id}><td><div className="flex min-w-[220px] items-center gap-3"><Avatar initials={resume.initials} /><div><button className="row-title text-left" onClick={() => comparison && openResult(comparison.id)} disabled={!comparison}>{resume.name}</button><p className="row-meta">{resume.role}</p><p className="row-meta">{resume.sourceLabel}</p></div></div></td>
                <td><ComparisonValue comparison={comparison} />{comparison?.score !== null && comparison?.score !== undefined && <div className="score-bar"><span style={{ width: `${comparison.score}%` }} /></div>}</td>
                <td><span className="text-[11px] text-muted">{comparison?.status === 'complete' ? `${supported} of ${browsing.selectedTarget!.rubric.criteria.length} criteria with citations` : 'Evidence not assessed yet'}</span></td>
                <td><div className="space-y-2"><div><Badge dot tone={comparison?.status === 'complete' ? 'success' : !comparison || ['failed', 'cancelled'].includes(comparison.status) ? 'warning' : 'neutral'}>
                  {comparison ? { queued: 'Queued', running: 'Running', complete: 'Complete', failed: 'Failed', cancelled: 'Cancelled' }[comparison.status] : 'Unavailable'}</Badge></div>
                  <Button size="sm" variant="ghost" icon={ArrowUpRight} onClick={() => comparison && openResult(comparison.id)} disabled={!comparison}>Review</Button></div></td></tr>
            })}</tbody>
          </table></div> : <div className="table-wrap"><table className="data-table matrix-table">
            <thead><tr><SortableHeader className="matrix-person" option={sortOptions[0]} sort={browsing.sort} onChange={changeSort}>Resume / target</SortableHeader>
              {browsing.displayedTargets.map((target) => <th scope="col" key={target.id}><Badge tone={target.kind === 'grade' ? 'accent' : 'neutral'}>{target.kind === 'job' ? 'Job rubric' : 'Grade rubric'}</Badge><strong>{target.label}</strong><span>{target.sublabel}</span><span>Rubric v{target.rubric.version}</span></th>)}</tr></thead>
            <tbody>{browsing.rows.map(({ snapshot: { resume }, comparisons }) => <tr key={resume.id}><td className="matrix-person"><div className="flex items-center gap-3"><Avatar initials={resume.initials} small /><div><strong className="block text-[12px] font-semibold">{resume.name}</strong><span className="row-meta block">{resume.role}</span></div></div></td>
              {browsing.displayedTargets.map((target) => {
                const comparison = comparisons.get(target.id)
                return <td key={target.id}>{comparison ? <button className="matrix-cell" onClick={() => openResult(comparison.id)} aria-label={`Review ${resume.name} against ${target.label}`}>
                  <ComparisonValue comparison={comparison} /><ArrowUpRight size={13} />
                  {comparison.score !== null && <div className="score-bar"><span style={{ width: `${comparison.score}%` }} /></div>}
                </button> : <Badge tone="warning">Unavailable</Badge>}</td>
              })}</tr>)}</tbody>
          </table></div>}
          <div className="table-bottom"><span>{browsing.rows.length} of {run.resumes.length} resumes shown · {browsing.comparisonCount} of {run.comparisons.length} saved comparisons shown</span>
            <span>{complete} of {run.comparisons.length} comparisons assessed · Overall scores out of 100 / not a combined ranking</span></div>
        </section>}
    <div className="mt-5"><DemoNote>These are simulated evidence matches, not hiring decisions. Missing resume evidence does not establish that a person lacks a skill.</DemoNote></div>
  </>
}

function ResultReview({ run, comparison }: { run: AnalysisRun; comparison: Comparison }) {
  const { retryRun } = useWorkspace()
  const { canEdit } = useLifecycleAccess({ kind: 'analysis', id: run.id })
  const target = run.targets.find((item) => item.id === comparison.targetId)
  const snapshot = run.resumes.find((item) => item.resume.id === comparison.resumeId)
  const [expanded, setExpanded] = useState<string[]>(target ? [target.rubric.criteria[0]?.id].filter((id): id is string => Boolean(id)) : [])
  const [activeCitation, setActiveCitation] = useState<Citation>()
  const [jobParagraph, setJobParagraph] = useState<string>()
  const [documentMode, setDocumentMode] = useState<'resume' | 'job'>('resume')
  const [pane, setPane] = useState<'criteria' | 'evidence'>('criteria')
  if (!target || !snapshot) return <EmptyState title="The saved input is unavailable" description="This comparison cannot be reviewed because its source snapshot is missing." />
  if (comparison.status !== 'complete') return <div className="panel"><EmptyState icon={comparison.status === 'running' ? LoaderCircle : ScanLine}
    title={comparison.status === 'failed' ? 'This comparison needs another try' : comparison.status === 'cancelled' ? 'No assessment was made' : 'The evidence is on its way'}
    description={comparison.error ?? 'This simulated comparison is still being prepared. A score will appear only when the assessment is complete.'}
    action={(comparison.status === 'failed' || comparison.status === 'cancelled') && runStatus(run) !== 'Running' ? <Button icon={RotateCcw} disabled={!canEdit} onClick={() => retryRun(run.id)}>Retry unfinished comparisons</Button> : undefined} /></div>
  const selectedDocument = documentMode === 'job' ? target.document : snapshot.document
  const evidenceCount = comparison.criteria.reduce((sum, criterion) => sum + criterion.citations.length, 0)
  function showCitation(citation: Citation) {
    setActiveCitation(citation)
    setDocumentMode('resume')
    setPane('evidence')
  }
  return <>
    <section className="result-overview panel">
      <div className="result-identity"><Avatar initials={snapshot.resume.initials} /><div><div className="eyebrow">RESUME</div><h2>{snapshot.resume.name}</h2><p>{snapshot.resume.role}</p></div></div>
      <div className="result-target"><div className="eyebrow">{target.kind === 'grade' ? 'GRADE-LEVEL RUBRIC' : 'JOB RUBRIC'}</div><h3>{target.label}</h3><p>{target.sublabel}</p><div className="mt-2 flex flex-wrap gap-1.5"><Badge>Rubric v{target.rubric.version}</Badge><Badge>{evidenceCount} citations</Badge></div></div>
      <div className="overall-score"><div className="eyebrow">OVERALL EVIDENCE MATCH</div><Score value={comparison.score} large /><span>Weighted criterion scores</span></div>
      <div className="result-summary"><Sparkles size={16} /><div><h3>Why this score</h3><p>{comparison.summary}</p></div></div>
    </section>
    <div className="pane-switcher mt-5"><SegmentedControl label="Result review view" value={pane} onChange={setPane} options={[{ value: 'criteria', label: 'Criterion breakdown' }, { value: 'evidence', label: 'Source evidence' }]} /></div>
    <div className="evidence-layout">
      <section className={`detail-panel ${pane !== 'criteria' ? 'mobile-pane-hidden' : ''}`} aria-label="Criterion scores">
        <div className="section-heading"><div><h2>The match, criterion by criterion</h2><p>Scored 0-5 against rubric version {target.rubric.version}</p></div><Layers3 size={16} className="text-muted" /></div>
        <div className="criterion-results">{target.rubric.criteria.map((criterion, index) => {
          const result = comparison.criteria.find((item) => item.criterionId === criterion.id)
          const isOpen = expanded.includes(criterion.id)
          const hasEvidence = Boolean(result?.citations.length)
          return <div className={`criterion-result ${isOpen ? 'is-open' : ''}`} key={criterion.id}>
            <button className="criterion-toggle" aria-expanded={isOpen} aria-controls={`criterion-${comparison.id}-${criterion.id}`} onClick={() => setExpanded(expanded.includes(criterion.id) ? expanded.filter((id) => id !== criterion.id) : [...expanded, criterion.id])}>
              <span className="criterion-number">{String(index + 1).padStart(2, '0')}</span><span className="criterion-title"><strong>{criterion.label}</strong><span>{criterion.weight}% weight{!result || result.evidenceStatus === 'not-assessed' ? ' / not assessed' : !hasEvidence ? ' / no cited evidence' : ''}</span></span>
              <span className="criterion-score">{result?.score === null || result?.score === undefined ? 'Not assessed' : <><strong>{result.score}</strong><span>/ 5</span></>}</span><ChevronDown size={14} className={isOpen ? 'rotate-180' : ''} />
            </button>
            {isOpen && <div className="criterion-content" id={`criterion-${comparison.id}-${criterion.id}`}>
              <p className="criterion-description">{criterion.description}</p>
              <div className="rationale"><strong>Assessment</strong><p>{result?.rationale ?? 'This criterion has not been assessed. No score or supporting evidence is available.'}</p></div>
              {result && result.citations.length > 0 ? <div className="citation-list"><div className="citation-heading"><span>SUPPORTING RESUME EVIDENCE</span><Badge tone={result.evidenceStatus === 'supported' ? 'success' : 'neutral'} dot>{result.evidenceStatus === 'supported' ? 'Supported' : 'Partial support'}</Badge></div>
                {result.citations.map((citation, citationIndex) => <button key={`${citation.paragraphId}-${citationIndex}`} className={`citation-button ${activeCitation?.paragraphId === citation.paragraphId && documentMode === 'resume' ? 'is-active' : ''}`} onClick={() => showCitation(citation)} aria-label={`View resume evidence for ${criterion.label}, page ${citation.page}`}>
                  <Quote size={15} /><span><q>{citation.quote}</q><small><FileText size={11} />Page {citation.page} / {citation.heading}<ArrowUpRight size={12} /></small></span>
                </button>)}
              </div> : <div className="evidence-gap"><ScanLine size={17} /><div><strong>{result?.evidenceStatus === 'not-assessed' ? 'Not assessed in this demo' : 'No cited evidence'}</strong><p>{result?.evidenceStatus === 'not-assessed' ? 'Custom criteria need a real assessment service. An overall score is intentionally withheld.' : 'No supporting passage was located in this sample. That is an evidence gap, not a conclusion about the person.'}</p></div></div>}
              <div className="criterion-bottom"><span>Weight: {criterion.weight}% of this rubric</span>{criterion.sourceParagraphId && target.document && <button className="text-link" onClick={() => { setJobParagraph(criterion.sourceParagraphId); setDocumentMode('job'); setPane('evidence') }}>View job requirement <ArrowUpRight size={11} /></button>}</div>
            </div>}
          </div>
        })}</div>
        <div className="score-legend"><span>0 / no cited support</span><span>3 / substantive support</span><span>5 / strongest sample support</span></div>
      </section>
      <section className={`detail-panel evidence-panel ${pane !== 'evidence' ? 'mobile-pane-hidden' : ''}`} aria-label="Source evidence viewer">
        <div className="section-heading"><div><h2>Go straight to the source</h2><p>{activeCitation && documentMode === 'resume' ? 'The selected supporting passage is highlighted.' : 'Select a quotation to locate the exact passage.'}</p></div><ScanLine size={17} className="text-accent" /></div>
        <div className="border-b px-4 py-3"><SegmentedControl label="Evidence source" value={documentMode} onChange={setDocumentMode}
          options={target.document ? [{ value: 'resume', label: 'Resume evidence' }, { value: 'job', label: 'Job description' }] : [{ value: 'resume', label: 'Resume evidence' }]} /></div>
        {selectedDocument ? <DocumentViewer document={selectedDocument} highlightedId={documentMode === 'resume' ? activeCitation?.paragraphId : jobParagraph} quote={documentMode === 'resume' ? activeCitation?.quote : undefined} compact />
          : <EmptyState title="Source unavailable" description="This target has no associated source document." />}
        <div className="source-footer"><span>Original analysis snapshot</span><span>Document v{selectedDocument?.version ?? 'unavailable'}</span></div>
      </section>
    </div>
  </>
}
