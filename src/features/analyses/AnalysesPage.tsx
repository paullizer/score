import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowUpRight, BarChart3, Clock3, Plus } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { dateLabel, runStatus } from '../../domain/selectors'
import { Avatar, Badge, Button, DemoNote, EmptyState, PageHeader, SearchField, SegmentedControl } from '../../components/ui'
import { isEntityArchived, matchesArchiveFilter, type ArchiveFilter } from '../../domain/lifecycle'
import { ArchivedBadge, ArchiveStateFilter, EntityLifecycleActions } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { useRealAnalyses } from '../../app/real-analyses-context'
import { dataMode, sampleDataLink } from '../../app/real-data-mode'
import { SortableHeader, TableSortSelect } from '../../components/ui/TableSorting'
import type { TableSort } from '../../domain/tableSorting'
import { sampleAnalysisSortOptions, selectSampleAnalysisRuns, type SampleAnalysisSortKey } from './analysisTableBrowsing'
import { RealAnalysesPage } from './RealAnalysesPage'

export { AnalysisSetup } from './AnalysisSetup'
export { AnalysisDetail } from './AnalysisDetail'

export function AnalysesPage() {
  const { workspace, cloud } = useWorkspace()
  const real = useRealAnalyses()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const mode = dataMode(params, Boolean(cloud))
  if (mode === 'invalid') return <EmptyState title="Unknown analysis mode" description="Choose real analyses or the explicitly fictional Samples history." action={<Button onClick={() => navigate('/analyses')}>Open analyses</Button>} />
  return <>
    {cloud && <div className="library-kind-switcher mb-5 rounded-xl border"><SegmentedControl label="Choose real analyses or samples" value={mode}
      onChange={(value) => navigate(`/analyses?data=${value}`)} options={[{ value: 'real', label: 'Real analyses', count: real?.summaries.length ?? 0 }, { value: 'samples', label: 'Samples', count: workspace.runs.length }]} />
      <span>{mode === 'real' ? 'Durable private results · real evidence' : 'Fictional inputs · simulated scoring'}</span></div>}
    {mode === 'real' ? <RealAnalysesPage /> : <SampleAnalysesPage key={cloud?.currentWorkspaceId ?? 'standalone'} />}
  </>
}

function SampleAnalysesPage() {
  const { workspace, cloud } = useWorkspace()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'complete' | 'attention'>('all')
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('default')
  const { canEdit } = useLifecycleAccess()
  const [sort, setSort] = useState<TableSort<SampleAnalysisSortKey> | null>(null)
  const runs = selectSampleAnalysisRuns(workspace.runs, query, filter, sort)
    .filter((run) => matchesArchiveFilter(isEntityArchived(workspace, { kind: 'analysis', id: run.id }), query, archiveFilter))
  return <>
    <PageHeader eyebrow="THE FULL PICTURE" title="Your analyses" description="Every comparison, with the reasoning kept intact."
      actions={<Button variant="primary" icon={Plus} disabled={!canEdit} onClick={() => navigate(sampleDataLink('/analyses/new', Boolean(cloud)))}>New analysis</Button>} />
    <section className="panel" aria-label="Analysis history">
      <div className="library-toolbar"><SegmentedControl label="Filter analyses" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All analyses', count: workspace.runs.filter((run) => !isEntityArchived(workspace, { kind: 'analysis', id: run.id })).length }, { value: 'complete', label: 'Complete' }, { value: 'attention', label: 'In progress / attention' }]} />
        <SearchField value={query} onChange={setQuery} placeholder="Find an analysis..." />
        <ArchiveStateFilter value={archiveFilter} onChange={setArchiveFilter} label="Analysis archive state" />
        <TableSortSelect label="Sort analyses" options={sampleAnalysisSortOptions} sort={sort} onChange={setSort} /></div>
      {runs.length ? <div className="table-wrap"><table className="data-table">
        <thead><tr>{sampleAnalysisSortOptions.map((option) => <SortableHeader key={option.key} option={option} sort={sort} onChange={setSort}
          className={option.key === 'created' ? 'mobile-hide' : undefined} />)}<th scope="col"><span className="sr-only">Open analysis</span></th></tr></thead>
        <tbody>{runs.map((run) => {
          const status = runStatus(run)
          const jobs = run.targets.filter((target) => target.kind === 'job').length
          const grades = run.targets.length - jobs
          return <tr key={run.id}>
            <td><div className="flex min-w-[220px] items-center gap-3"><span className="job-monogram"><BarChart3 size={19} strokeWidth={1.5} /></span><div><Link to={sampleDataLink(`/analyses/${run.id}`, Boolean(cloud))} className="row-title">{run.name}</Link> <ArchivedBadge target={{ kind: 'analysis', id: run.id }} /><div className="row-meta">{run.comparisons.length} separate comparisons / saved snapshots</div><div className="mt-1"><Badge tone="accent">Simulated scoring</Badge></div></div></div></td>
            <td><div className="flex items-center gap-2"><div className="avatar-stack">{run.resumes.slice(0, 3).map(({ resume }) => <Avatar key={resume.id} initials={resume.initials} small />)}</div><span className="text-[11px] text-muted">{run.resumes.length}</span></div></td>
            <td><div className="flex flex-wrap gap-1.5">{jobs > 0 && <Badge>{jobs} {jobs === 1 ? 'job' : 'jobs'}</Badge>}{grades > 0 && <Badge tone="accent">{grades} {grades === 1 ? 'grade' : 'grades'}</Badge>}</div></td>
            <td><Badge tone={status === 'Complete' ? 'success' : status === 'Needs attention' ? 'warning' : 'neutral'} dot>{status}</Badge></td>
            <td className="mobile-hide"><span className="text-[11px] text-muted">{dateLabel(run.createdAt)}</span></td>
            <td><div className="flex items-center gap-1"><Link to={sampleDataLink(`/analyses/${run.id}`, Boolean(cloud))} className="button button-ghost icon-button" aria-label={`Open ${run.name}`}><ArrowUpRight size={16} /></Link><EntityLifecycleActions target={{ kind: 'analysis', id: run.id }} name={run.name} compact /></div></td>
          </tr>
        })}</tbody>
      </table></div> : <EmptyState icon={Clock3} title={workspace.runs.length ? 'No matching analyses' : 'A place for every comparison'} description={workspace.runs.length ? 'Try a different search or archive filter.' : 'Choose your resumes and criteria. The evidence will take it from there.'} action={<>
        {workspace.runs.length > 0 && <Button onClick={() => { setQuery(''); setFilter('all'); setArchiveFilter('default') }}>Clear filters</Button>}
        <Button disabled={!canEdit && !workspace.runs.length} onClick={() => { if (!workspace.runs.length) navigate(sampleDataLink('/analyses/new', Boolean(cloud))); else { setQuery(''); setFilter('all'); setArchiveFilter('all') } }}>{workspace.runs.length ? 'Show active and archived' : 'Create an analysis'}</Button>
      </>} />}
      <div className="table-bottom"><span>{runs.length} {runs.length === 1 ? 'analysis' : 'analyses'}</span><span>Previous results stay unchanged when a rubric is edited.</span></div>
    </section>
    <div className="mt-5"><DemoNote>Scores are simulated evidence matches, not hiring recommendations. Review the underlying citations before drawing conclusions.</DemoNote></div>
  </>
}
