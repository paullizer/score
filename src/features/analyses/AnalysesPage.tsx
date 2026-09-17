import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowUpRight, BarChart3, Clock3, Plus } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { dateLabel, runStatus } from '../../domain/selectors'
import { Avatar, Badge, Button, DemoNote, EmptyState, PageHeader, SearchField, SegmentedControl } from '../../components/ui'

export { AnalysisSetup } from './AnalysisSetup'
export { AnalysisDetail } from './AnalysisDetail'

export function AnalysesPage() {
  const { workspace } = useWorkspace()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'complete' | 'attention'>('all')
  const runs = workspace.runs.filter((run) => run.name.toLowerCase().includes(query.toLowerCase()) &&
    (filter === 'all' || (filter === 'complete' ? runStatus(run) === 'Complete' : runStatus(run) !== 'Complete')))
  return <>
    <PageHeader eyebrow="THE FULL PICTURE" title="Your analyses" description="Every comparison, with the reasoning kept intact."
      actions={<Button variant="primary" icon={Plus} onClick={() => navigate('/analyses/new')}>New analysis</Button>} />
    <section className="panel" aria-label="Analysis history">
      <div className="library-toolbar"><SegmentedControl label="Filter analyses" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All analyses', count: workspace.runs.length }, { value: 'complete', label: 'Complete' }, { value: 'attention', label: 'In progress / attention' }]} />
        <SearchField value={query} onChange={setQuery} placeholder="Find an analysis..." /></div>
      {runs.length ? <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Analysis</th><th>Resumes</th><th>Targets</th><th>Status</th><th className="mobile-hide">Created</th><th><span className="sr-only">Open analysis</span></th></tr></thead>
        <tbody>{runs.map((run) => {
          const status = runStatus(run)
          const jobs = run.targets.filter((target) => target.kind === 'job').length
          const grades = run.targets.length - jobs
          return <tr key={run.id}>
            <td><div className="flex min-w-[220px] items-center gap-3"><span className="job-monogram"><BarChart3 size={19} strokeWidth={1.5} /></span><div><Link to={`/analyses/${run.id}`} className="row-title">{run.name}</Link><div className="row-meta">{run.comparisons.length} separate comparisons / saved snapshots</div></div></div></td>
            <td><div className="flex items-center gap-2"><div className="avatar-stack">{run.resumes.slice(0, 3).map(({ resume }) => <Avatar key={resume.id} initials={resume.initials} small />)}</div><span className="text-[11px] text-muted">{run.resumes.length}</span></div></td>
            <td><div className="flex flex-wrap gap-1.5">{jobs > 0 && <Badge>{jobs} {jobs === 1 ? 'job' : 'jobs'}</Badge>}{grades > 0 && <Badge tone="accent">{grades} {grades === 1 ? 'grade' : 'grades'}</Badge>}</div></td>
            <td><Badge tone={status === 'Complete' ? 'success' : status === 'Needs attention' ? 'warning' : 'neutral'} dot>{status}</Badge></td>
            <td className="mobile-hide"><span className="text-[11px] text-muted">{dateLabel(run.createdAt)}</span></td>
            <td><Link to={`/analyses/${run.id}`} className="button button-ghost icon-button" aria-label={`Open ${run.name}`}><ArrowUpRight size={16} /></Link></td>
          </tr>
        })}</tbody>
      </table></div> : <EmptyState icon={Clock3} title={workspace.runs.length ? 'No matching analyses' : 'A place for every comparison'} description={workspace.runs.length ? 'Try a different search or filter.' : 'Choose your resumes and criteria. The evidence will take it from there.'} action={<Button onClick={() => { if (!workspace.runs.length) navigate('/analyses/new'); else { setQuery(''); setFilter('all') } }}>{workspace.runs.length ? 'Clear filters' : 'Create an analysis'}</Button>} />}
      <div className="table-bottom"><span>{runs.length} {runs.length === 1 ? 'analysis' : 'analyses'}</span><span>Previous results stay unchanged when a rubric is edited.</span></div>
    </section>
    <div className="mt-5"><DemoNote>Scores are simulated evidence matches, not hiring recommendations. Review the underlying citations before drawing conclusions.</DemoNote></div>
  </>
}
