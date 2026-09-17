import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, ArrowUpRight, BarChart3, BriefcaseBusiness, Building2, ChevronRight, FileText, Globe2, Layers3, Link2, MapPin, Plus, RotateCcw, ScanLine, Sparkles, X } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import type { Criterion, SourceKind } from '../../domain/types'
import { dateLabel } from '../../domain/selectors'
import { Badge, Button, DemoNote, EmptyState, ExternalSource, InlineError, PageHeader, SearchField, SegmentedControl, StatusBadge } from '../../components/ui'
import { DocumentViewer } from '../../components/documents/DocumentViewer'
import { RubricPanel } from '../rubrics/RubricPanel'
import { JobImport } from './JobImport'

const sourceNames = { pdf: 'PDF document', url: 'Direct URL', website: 'Website' }
const sourceIcons = { pdf: FileText, url: Link2, website: Globe2 }

export function JobsPage() {
  const { workspace, cancelJob, retryJob } = useWorkspace()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'ready' | 'attention'>('all')
  const [source, setSource] = useState<'all' | SourceKind>('all')
  const [sort, setSort] = useState('newest')
  const [selected, setSelected] = useState<string[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const readyCount = workspace.jobs.filter((job) => job.status === 'ready').length
  const attentionCount = workspace.jobs.filter((job) => job.status === 'error' || job.status === 'cancelled').length
  const filtered = workspace.jobs.filter((job) => {
    const matchesQuery = `${job.title} ${job.organization} ${job.grade} ${job.location}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery && (source === 'all' || job.source === source) &&
      (filter === 'all' || (filter === 'ready' ? job.status === 'ready' : job.status === 'error' || job.status === 'cancelled'))
  }).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : b.createdAt.localeCompare(a.createdAt))
  const visibleReady = filtered.filter((job) => job.status === 'ready').map((job) => job.id)
  const selectedJobs = workspace.jobs.filter((job) => selected.includes(job.id))
  const allVisible = visibleReady.length > 0 && visibleReady.every((id) => selected.includes(id))
  function toggle(id: string) { setSelected((values) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id]) }

  return <>
    <PageHeader eyebrow="A CLEARER STARTING POINT" title="Your jobs" description="Bring the roles together. Define what a great match looks like."
      actions={<><Button icon={Layers3} onClick={() => navigate('/rubrics')}>Rubric library</Button><Button variant="primary" icon={Plus} onClick={() => setImportOpen(true)}>Add jobs</Button></>} />
    <div className="welcome-panel">
      <div className="flex items-center"><span className="welcome-symbol"><ScanLine size={25} strokeWidth={1.4} /></span><div><h2>Good matches start with clear criteria.</h2><p>Every job gets its own rubric. Every score leads back to evidence. Nothing important stays a black box.</p></div></div>
      <div className="welcome-action"><div className="mini-path" aria-hidden="true"><span><BriefcaseBusiness size={16} /></span><ChevronRight size={11} /><span><Layers3 size={16} /></span><ChevronRight size={11} /><span><BarChart3 size={16} /></span></div>
        <Button size="sm" icon={ArrowUpRight} onClick={() => navigate(workspace.runs.length ? `/analyses/${workspace.runs[0].id}` : '/analyses/new')}>See it in action</Button>
      </div>
    </div>
    <section className="panel" aria-label="Job library">
      <div className="library-toolbar">
        <SegmentedControl label="Filter jobs by status" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All jobs', count: workspace.jobs.length }, { value: 'ready', label: 'Ready', count: readyCount }, { value: 'attention', label: 'Needs attention', count: attentionCount },
        ]} />
        <div className="toolbar"><SearchField value={query} onChange={setQuery} placeholder="Search jobs, organizations..." />
          <select aria-label="Filter by source" className="filter-select" value={source} onChange={(event) => {
            const value = event.target.value
            if (value === 'all' || value === 'pdf' || value === 'url' || value === 'website') setSource(value)
          }}><option value="all">All sources</option><option value="pdf">PDF files</option><option value="url">Direct URLs</option><option value="website">Websites</option></select>
        </div>
      </div>
      {selectedJobs.length > 0 && <div className="selection-bar"><span><strong>{selectedJobs.length}</strong> {selectedJobs.length === 1 ? 'job' : 'jobs'} selected{selectedJobs.some((job) => !filtered.includes(job)) && ' (including hidden rows)'}</span>
        <div className="flex items-center gap-2"><Button variant="ghost" size="sm" onClick={() => setSelected([])}>Clear</Button><Button size="sm" variant="primary" icon={Sparkles} onClick={() => {
          navigate(`/analyses/new?rubrics=${selectedJobs.map((job) => job.rubricId).filter(Boolean).join(',')}`)
        }}>Analyze selected</Button></div>
      </div>}
      {filtered.length ? <div className="table-wrap"><table className="data-table">
        <thead><tr><th className="checkbox-cell"><input type="checkbox" aria-label="Select all visible ready jobs" checked={allVisible} disabled={!visibleReady.length} onChange={() => setSelected((values) => allVisible ? values.filter((id) => !visibleReady.includes(id)) : [...new Set([...values, ...visibleReady])])} /></th>
          <th>Job / organization</th><th className="mobile-hide">Source</th><th className="mobile-hide">Rubric</th><th className="mobile-hide">Added</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{filtered.map((job) => {
          const Icon = sourceIcons[job.source]
          const rubric = workspace.rubrics.find((item) => item.id === job.rubricId)
          const processing = job.status === 'parsing' || job.status === 'generating'
          return <tr key={job.id} className={selected.includes(job.id) ? 'row-selected' : ''}>
            <td className="checkbox-cell"><input type="checkbox" aria-label={`Select ${job.title}`} disabled={job.status !== 'ready'} checked={selected.includes(job.id)} title={job.status === 'ready' ? 'Select for analysis' : 'The rubric must be ready before analysis'} onChange={() => toggle(job.id)} /></td>
            <td><div className="job-cell"><span className="job-monogram"><Building2 size={19} strokeWidth={1.4} /></span><div><Link to={`/jobs/${job.id}`} className="row-title">{job.title}</Link><div className="row-meta">{job.organization}</div><div className="job-submeta"><span>{job.grade}</span><span>/</span><span>{job.arrangement}</span></div><div className="job-mobile-status"><StatusBadge status={job.status} /><span className="source-type"><Icon size={12} />{sourceNames[job.source]}</span></div></div></div></td>
            <td className="mobile-hide"><span className="source-type"><Icon size={13} />{sourceNames[job.source]}</span><div className="row-meta">{job.batchId ? 'Batch import' : 'Sample source'}</div></td>
            <td className="mobile-hide"><StatusBadge status={job.status} /><div className="row-meta">{rubric ? `${rubric.criteria.length} criteria / v${rubric.version}` : job.status === 'error' ? `${job.errorStage === 'rubric' ? 'Rubric' : 'Document'} needs a retry` : processing ? 'Simulated import in progress' : 'Not yet assessed'}</div></td>
            <td className="mobile-hide"><span className="text-[11px] text-muted">{dateLabel(job.createdAt)}</span></td>
            <td>{processing ? <Button size="sm" variant="ghost" aria-label={`Cancel ${job.title} import`} icon={X} onClick={() => cancelJob(job.id)}>Cancel</Button>
              : job.status === 'error' || job.status === 'cancelled' ? <Button size="sm" icon={RotateCcw} onClick={() => retryJob(job.id)}>Retry</Button>
                : <Link to={`/jobs/${job.id}`} className="button button-ghost icon-button" aria-label={`Open ${job.title}`}><ArrowUpRight size={16} /></Link>}</td>
          </tr>
        })}</tbody>
      </table></div> : <EmptyState icon={BriefcaseBusiness} title={workspace.jobs.length ? 'No jobs match these filters' : 'Your next great match starts here'} description={workspace.jobs.length ? 'Try another search or choose All jobs to see the rest of your library.' : 'Add a PDF, a job URL, or a collection of roles from a website.'}
        action={<Button onClick={() => { if (!workspace.jobs.length) setImportOpen(true); else { setQuery(''); setFilter('all'); setSource('all') } }}>{workspace.jobs.length ? 'Clear filters' : 'Add your first jobs'}</Button>} />}
      <div className="table-bottom"><span>Showing {filtered.length} of {workspace.jobs.length} jobs</span><label className="flex items-center gap-2">Sort by<select className="bg-transparent text-[10px] outline-offset-2" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort jobs"><option value="newest">Newest first</option><option value="title">Job title</option></select></label></div>
    </section>
    <div className="library-note"><DemoNote>Example jobs and rubrics are fictional. Add a source to explore the import workflow.</DemoNote><Link className="text-link shrink-0 mobile-hide" to="/rubrics">How rubrics work <ArrowRight size={12} /></Link></div>
    {importOpen && <JobImport onClose={() => setImportOpen(false)} />}
  </>
}

export function JobDetail() {
  const { id } = useParams()
  const { workspace, retryJob, cancelJob, notify } = useWorkspace()
  const navigate = useNavigate()
  const [highlighted, setHighlighted] = useState<string>()
  const [pane, setPane] = useState<'document' | 'rubric'>('document')
  const job = workspace.jobs.find((item) => item.id === id)
  if (!job) return <EmptyState title="This job is not in your workspace" description="It may have been removed by a demo reset. Your other jobs are in the library." action={<Button onClick={() => navigate('/jobs')}>Back to jobs</Button>} />
  const document = workspace.documents.find((item) => item.id === job.documentId)
  const rubric = workspace.rubrics.find((item) => item.id === job.rubricId)
  const processing = job.status === 'parsing' || job.status === 'generating'
  function selectCriterion(criterion: Criterion) {
    if (!criterion.sourceParagraphId) { notify('This criterion has no linked job passage. Custom criteria can be reviewed in the rubric editor.'); return }
    setHighlighted(criterion.sourceParagraphId)
    setPane('document')
  }
  return <>
    <Link className="back-link" to="/jobs"><ArrowLeft size={14} />Back to jobs</Link>
    <PageHeader eyebrow="JOB WORKSPACE" title={job.title} description={job.organization}
      actions={<Button variant="primary" icon={Sparkles} disabled={job.status !== 'ready'} onClick={() => navigate(`/analyses/new?rubrics=${job.rubricId}`)}>Analyze applicants</Button>} />
    <div className="detail-metadata"><span><MapPin size={13} />{job.location}</span><span><BriefcaseBusiness size={13} />{job.arrangement} / {job.employmentType}</span><Badge>{job.grade}</Badge><Badge>Series {job.series}</Badge><StatusBadge status={job.status} /></div>
    {job.error && <div className="mb-5"><InlineError><strong>{job.errorStage === 'rubric' ? 'The job is preserved; its rubric needs attention. ' : ''}</strong>{job.error} <button className="ml-2 underline" onClick={() => retryJob(job.id)}>Retry import</button></InlineError></div>}
    <div className="pane-switcher"><SegmentedControl label="Job detail view" value={pane} onChange={setPane} options={[{ value: 'document', label: 'Job description' }, { value: 'rubric', label: 'Associated rubric' }]} /></div>
    <div className="split-layout">
      <section className={`detail-panel ${pane !== 'document' ? 'mobile-pane-hidden' : ''}`} aria-label="Job description">
        <div className="section-heading"><div><h2>The role, in its own words</h2><p>Source context for every criterion</p></div><FileText size={17} className="text-muted" /></div>
        {document ? <DocumentViewer document={document} highlightedId={highlighted} /> : <EmptyState title="Source document unavailable" description="This sample could not be opened. Reset the demo to restore the original document." />}
        <div className="source-footer"><ExternalSource url={job.sourceLabel}>{job.sourceLabel}</ExternalSource><span>Demo / {sourceNames[job.source]}</span></div>
      </section>
      <section className={`detail-panel ${pane !== 'rubric' ? 'mobile-pane-hidden' : ''}`} aria-label="Associated job rubric">
        {rubric ? <RubricPanel rubric={rubric} onSelectCriterion={selectCriterion} /> : <div className="p-6">
          <div className="mb-5 flex items-center justify-between"><h2 className="font-semibold">Your job rubric</h2><StatusBadge status={job.status} /></div>
          {processing ? <><div className="loading-pulse space-y-4" aria-hidden="true">{[1, 2, 3].map((key) => <div key={key} className="h-20 rounded-xl border bg-soft" />)}</div><p role="status" className="mt-5 text-[12px] text-muted">Preparing sample criteria and linking them to this job...</p><Button size="sm" className="mt-4" onClick={() => cancelJob(job.id)}>Cancel import</Button></>
            : <EmptyState icon={Layers3} title="The rubric is not ready" description="Finish the simulated import before using this job in an analysis." action={<Button icon={RotateCcw} onClick={() => retryJob(job.id)}>Retry import</Button>} />}
        </div>}
      </section>
    </div>
    <div className="mt-5"><DemoNote>The job text and criteria are illustrative. Select a rubric requirement to locate its source passage.</DemoNote></div>
  </>
}
