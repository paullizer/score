import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, ArrowUpRight, BarChart3, BriefcaseBusiness, Building2, ChevronRight, Download, FileText, Globe2, Layers3, Link2, LoaderCircle, MapPin, Plus, RotateCcw, ScanLine, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import type { Citation, Criterion, Job, SourceKind } from '../../domain/types'
import { documentPagination } from '../../domain/source-files'
import { dateLabel } from '../../domain/selectors'
import { sortTableRows, type TableSort } from '../../domain/tableSorting'
import { Badge, Button, DemoNote, EmptyState, ExternalSource, InlineError, PageHeader, SearchField, SegmentedControl, StatusBadge } from '../../components/ui'
import { SortableHeader, TableSortSelect, type TableSortOption } from '../../components/ui/TableSorting'
import { DocumentViewer } from '../../components/documents/DocumentViewer'
import { PrivateDocumentViewer } from '../../components/documents/PrivateDocumentViewer'
import { UPLOAD_CONTENT_TYPES, supportedUploadFormats } from '../../domain/document-formats'
import { uploadFormatNames } from '../../services/documentUploads'
import { RubricPanel } from '../rubrics/RubricPanel'
import { JobImport } from './JobImport'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { getEntityLifecycle, isEntityArchived, isEntityRemoved, matchesArchiveFilter, type ArchiveFilter } from '../../domain/lifecycle'
import { ArchivedBadge, ArchiveStateFilter, EntityLifecycleActions, LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { useRealAnalyses } from '../../app/real-analyses-context'
import { sampleDataLink } from '../../app/real-data-mode'
import { realAnalysisLink } from '../analyses/realAnalysisUi'
import type { RealAnalysisTargetSelection } from '../../domain/real-analyses'

const sourceNames = { pdf: 'PDF document', markdown: 'Markdown document', docx: 'Word DOCX', doc: 'Word DOC (97–2003)', url: 'Direct URL', website: 'Website' }
const sourceIcons = { pdf: FileText, markdown: FileText, docx: FileText, doc: FileText, url: Link2, website: Globe2 }
type JobSortKey = 'title' | 'source' | 'status' | 'added' | 'actions'
const jobSortOptions: Record<JobSortKey, TableSortOption<JobSortKey>> = {
  title: { key: 'title', label: 'Job title', ascendingLabel: 'A–Z', descendingLabel: 'Z–A' },
  source: { key: 'source', label: 'Source type', ascendingLabel: 'A–Z', descendingLabel: 'Z–A' },
  status: { key: 'status', label: 'Processing status', ascendingLabel: 'Needs attention first', descendingLabel: 'Complete first' },
  added: { key: 'added', label: 'Added date', ascendingLabel: 'Oldest first', descendingLabel: 'Newest first', initialDirection: 'desc' },
  actions: { key: 'actions', label: 'Status / actions', ascendingLabel: 'Needs attention first', descendingLabel: 'Complete first', title: 'Sort by processing status, not the action label.' },
}
const jobStatusOrder = { error: 0, cancelled: 0, queued: 1, parsing: 1, generating: 1, ready: 2 }
const defaultJobSort: TableSort<JobSortKey> = { key: 'added', direction: 'desc' }

export function JobsPage() {
  const { cloud } = useWorkspace()
  const [libraryKind, setLibraryKind] = useState<'real' | 'samples'>(() => cloud ? 'real' : 'samples')
  return <JobsLibrary key={`${cloud?.currentWorkspaceId ?? 'local'}:${libraryKind}`} libraryKind={libraryKind} onLibraryKindChange={setLibraryKind} />
}

function JobsLibrary({ libraryKind, onLibraryKindChange }: {
  libraryKind: 'real' | 'samples'; onLibraryKindChange: (kind: 'real' | 'samples') => void
}) {
  const { workspace, cancelJob, retryJob, cloud } = useWorkspace()
  const navigate = useNavigate()
  const analyses = useRealAnalyses()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'ready' | 'attention'>('all')
  const [source, setSource] = useState<'all' | SourceKind>('all')
  const [sort, setSort] = useState<TableSort<JobSortKey> | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [selectedRealTargets, setSelectedRealTargets] = useState<Record<string, RealAnalysisTargetSelection>>({})
  const [importOpen, setImportOpen] = useState(false)
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('default')
  const { canEdit } = useLifecycleAccess()
  const activeSort = sort ?? defaultJobSort
  const libraryJobs = workspace.jobs.filter((job) => libraryKind === 'real' ? job.dataKind === 'real' : job.dataKind !== 'real')
  const wordFilters = libraryKind === 'real' && (cloud?.realJobs.features?.wordDocumentImports || libraryJobs.some((job) => job.source === 'docx' || job.source === 'doc'))
  const markdownFilter = libraryKind === 'real' && (cloud?.realJobs.features?.markdownJobImports || libraryJobs.some((job) => job.source === 'markdown'))
  const formats = supportedUploadFormats({ markdownJobImports: cloud?.realJobs.features?.markdownJobImports, wordDocumentImports: cloud?.realJobs.features?.wordDocumentImports })
  const activeJobs = libraryJobs.filter((job) => !isEntityArchived(workspace, { kind: 'job', id: job.id }) && !isEntityRemoved(workspace, { kind: 'job', id: job.id }))
  const scopedCount = libraryJobs.filter((job) => matchesArchiveFilter(isEntityArchived(workspace, { kind: 'job', id: job.id }), query, archiveFilter)).length
  const previewRun = workspace.runs.find((run) => !isEntityArchived(workspace, { kind: 'analysis', id: run.id }))
  const readyCount = activeJobs.filter((job) => job.status === 'ready' && !job.rubricDeletedAt && workspace.rubrics.some((rubric) => rubric.id === job.rubricId)).length
  const attentionCount = activeJobs.filter((job) => !job.rubricDeletedAt && (job.status === 'error' || job.status === 'cancelled')).length
  const realTargets = analyses?.targets.state === 'ready' && !analyses.targets.error ? analyses.targets.value : []
  const canSelectReal = canEdit && analyses?.canWrite && analyses.phase === 'ready' && analyses.features?.realAnalyses
  function selectable(job: Job) {
    const rubric = workspace.rubrics.find((item) => item.id === job.rubricId)
    return canEdit && job.status === 'ready' && !job.rubricDeletedAt && Boolean(rubric) &&
      !isEntityArchived(workspace, { kind: 'job', id: job.id }) && !isEntityRemoved(workspace, { kind: 'job', id: job.id }) &&
      !isEntityArchived(workspace, { kind: 'rubric', id: rubric!.groupId }) && !isEntityRemoved(workspace, { kind: 'rubric', id: rubric!.groupId }) &&
      (job.dataKind !== 'real' || Boolean(canSelectReal && targetForJob(job.id)))
  }
  const filtered = sortTableRows(libraryJobs.filter((job) => {
    const matchesQuery = `${job.title} ${job.organization} ${job.grade} ${job.location}`.toLowerCase().includes(query.trim().toLowerCase())
    const deleting = Boolean(getEntityLifecycle(workspace, { kind: 'job', id: job.id })?.deletingAt)
    return matchesQuery && matchesArchiveFilter(isEntityArchived(workspace, { kind: 'job', id: job.id }), query, archiveFilter) && (source === 'all' || job.source === source) &&
      (deleting || filter === 'all' || (filter === 'ready' ? job.status === 'ready' && !job.rubricDeletedAt && workspace.rubrics.some((rubric) => rubric.id === job.rubricId) : !job.rubricDeletedAt && (job.status === 'error' || job.status === 'cancelled')))
  }), activeSort, (job, key) => {
    switch (key) {
      case 'title': return job.title
      case 'source': return sourceNames[job.source]
      case 'status': case 'actions': return jobStatusOrder[job.status]
      case 'added': return Date.parse(job.createdAt)
    }
  })
  const visibleReady = filtered.filter(selectable).map((job) => job.id)
  const selectedJobs = libraryJobs.filter((job) => selected.includes(job.id))
  const allVisible = visibleReady.length > 0 && visibleReady.every((id) => selected.includes(id))
  function targetForJob(id: string) {
    const job = workspace.jobs.find((item) => item.id === id)
    const rubric = workspace.rubrics.find((item) => item.id === job?.rubricId)
    return realTargets.find((target) => target.kind === 'job' && target.selection.jobId === id
      && target.selection.rubricId === rubric?.id && target.selection.rubricVersion === rubric?.version)
  }
  function selectJobs(ids: string[]) {
    setSelected(ids)
    setSelectedRealTargets((current) => Object.fromEntries(ids.flatMap((id) => {
      const selection = current[id] ?? targetForJob(id)?.selection
      return selection ? [[id, selection]] : []
    })))
  }
  function toggle(id: string) { selectJobs(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]) }

  return <>
    <PageHeader eyebrow="A CLEARER STARTING POINT" title="Your jobs" description="Bring the roles together. Define what a great match looks like."
      actions={<><Button icon={Layers3} onClick={() => navigate('/rubrics')}>Rubric library</Button><Button variant="primary" icon={Plus} disabled={!canEdit} onClick={() => setImportOpen(true)}>Add jobs</Button></>} />
    <div className="welcome-panel">
      <div className="flex items-center"><span className="welcome-symbol"><ScanLine size={25} strokeWidth={1.4} /></span><div><h2>Good matches start with clear criteria.</h2><p>Every job gets its own rubric. Every score leads back to evidence. Nothing important stays a black box.</p></div></div>
      <div className="welcome-action"><div className="mini-path" aria-hidden="true"><span><BriefcaseBusiness size={16} /></span><ChevronRight size={11} /><span><Layers3 size={16} /></span><ChevronRight size={11} /><span><BarChart3 size={16} /></span></div>
        <Button size="sm" icon={ArrowUpRight} disabled={!cloud && !previewRun && !canEdit} onClick={() => navigate(cloud ? '/analyses?data=real' : previewRun ? `/analyses/${previewRun.id}` : '/analyses/new')}>{cloud ? 'Review analyses' : 'See it in action'}</Button>
      </div>
    </div>
    <section className="panel" aria-label="Job library">
      {cloud && <div className="library-kind-switcher"><SegmentedControl label="Choose real jobs or samples" value={libraryKind} onChange={onLibraryKindChange} options={[
        { value: 'real', label: 'Real jobs', count: workspace.jobs.filter((job) => job.dataKind === 'real' && !isEntityArchived(workspace, { kind: 'job', id: job.id }) && !isEntityRemoved(workspace, { kind: 'job', id: job.id })).length },
        { value: 'samples', label: 'Samples', count: workspace.jobs.filter((job) => job.dataKind !== 'real' && !isEntityArchived(workspace, { kind: 'job', id: job.id }) && !isEntityRemoved(workspace, { kind: 'job', id: job.id })).length },
      ]} /><span>{libraryKind === 'real' ? 'Private source imports and generated rubrics' : 'Fictional examples for the simulated preview'}</span></div>}
      <div className="library-toolbar">
        <SegmentedControl label="Filter jobs by status" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All jobs', count: activeJobs.length }, { value: 'ready', label: 'Ready', count: readyCount }, { value: 'attention', label: 'Needs attention', count: attentionCount },
        ]} />
        <div className="toolbar"><SearchField value={query} onChange={setQuery} placeholder="Search jobs, organizations..." />
          <ArchiveStateFilter value={archiveFilter} onChange={setArchiveFilter} label="Job archive state" />
          <select aria-label="Filter by source" className="filter-select" value={source} onChange={(event) => {
            const value = event.target.value
            if (value === 'all' || value === 'pdf' || value === 'markdown' || value === 'docx' || value === 'doc' || value === 'url' || value === 'website') setSource(value)
          }}><option value="all">All sources</option><option value="pdf">PDF files</option>{markdownFilter && <option value="markdown">Markdown files</option>}{wordFilters && <><option value="docx">Word DOCX files</option><option value="doc">Word DOC files</option></>}<option value="url">Direct URLs</option><option value="website">Websites</option></select>
          <TableSortSelect options={[jobSortOptions.title, jobSortOptions.source, jobSortOptions.status, jobSortOptions.added]}
            sort={sort?.key === 'actions' ? { ...sort, key: 'status' } : sort} onChange={setSort} label="Sort jobs" defaultLabel="Newest first (default)" />
        </div>
      </div>
      {selectedJobs.length > 0 && <div className="selection-bar"><span><strong>{selectedJobs.length}</strong> {selectedJobs.length === 1 ? 'job' : 'jobs'} selected{selectedJobs.some((job) => !filtered.includes(job)) && ' (including hidden rows)'}</span>
        <div className="flex items-center gap-2"><Button variant="ghost" size="sm" onClick={() => selectJobs([])}>Clear</Button><Button size="sm" variant="primary" icon={Sparkles}
          disabled={selectedJobs.length !== selected.length || selectedJobs.some((job) => !selectable(job)) || (libraryKind === 'real' && (!canSelectReal || selected.some((id) => !selectedRealTargets[id])))}
          onClick={() => {
          if (selectedJobs.some((job) => !selectable(job))) return
          if (libraryKind === 'real') {
            if (!analyses) return
            const link = realAnalysisLink({ targets: selected.map((id) => selectedRealTargets[id]) }, analyses.workspaceId)
            navigate(link.to, { state: link.state })
          } else navigate(sampleDataLink(`/analyses/new?rubrics=${selectedJobs.map((job) => job.rubricId).join(',')}`, Boolean(cloud)))
        }}>Analyze selected</Button></div>
      </div>}
      {filtered.length ? <div className="table-wrap"><table className="data-table">
        <thead><tr><th className="checkbox-cell"><input type="checkbox" aria-label="Select all visible ready jobs" checked={allVisible} disabled={!visibleReady.length} onChange={() => selectJobs(allVisible ? selected.filter((id) => !visibleReady.includes(id)) : [...new Set([...selected, ...visibleReady])])} /></th>
          <SortableHeader option={jobSortOptions.title} sort={activeSort} onChange={setSort}>Job / organization</SortableHeader>
          <SortableHeader option={jobSortOptions.source} sort={activeSort} onChange={setSort} className="mobile-hide">Source</SortableHeader>
          <SortableHeader option={jobSortOptions.status} sort={activeSort} onChange={setSort} className="mobile-hide">Rubric</SortableHeader>
          <SortableHeader option={jobSortOptions.added} sort={activeSort} onChange={setSort} className="mobile-hide">Added</SortableHeader>
          <SortableHeader option={jobSortOptions.actions} sort={activeSort} onChange={setSort} /></tr></thead>
        <tbody>{filtered.map((job) => {
          const Icon = sourceIcons[job.source]
          const rubric = workspace.rubrics.find((item) => item.id === job.rubricId)
          const rubricRemoving = cloud?.realJobs.summaries.find((item) => item.job.id === job.id)?.rubricLifecycle?.deletingAt
          const deleting = Boolean(getEntityLifecycle(workspace, { kind: 'job', id: job.id })?.deletingAt)
          const editable = canEdit && !isEntityArchived(workspace, { kind: 'job', id: job.id }) && !isEntityRemoved(workspace, { kind: 'job', id: job.id })
          const canRetry = editable && !rubricRemoving && !job.rubricDeletedAt && (!rubric || !isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId }))
          const processing = job.status === 'queued' || job.status === 'parsing' || job.status === 'generating'
          const statusBadge = deleting ? <Badge tone="warning">Deletion pending</Badge> : rubricRemoving ? <Badge tone="warning">Rubric deletion pending</Badge> : job.rubricDeletedAt ? <Badge>No rubric</Badge> : <StatusBadge status={job.status} />
          return <tr key={job.id} className={selected.includes(job.id) ? 'row-selected' : ''}>
            <td className="checkbox-cell"><input type="checkbox" aria-label={`Select ${job.title}`} disabled={!selectable(job) && !selected.includes(job.id)} checked={selected.includes(job.id)} title={!editable ? 'Archived content and viewer access are read-only.' : job.dataKind === 'real' ? 'Select this exact saved real target for manual analysis with ready real resumes.' : 'An active, ready rubric is required.'} onChange={() => toggle(job.id)} /></td>
            <td><div className="job-cell"><span className="job-monogram"><Building2 size={19} strokeWidth={1.4} /></span><div><Link to={`/jobs/${job.id}`} className="row-title">{job.title}</Link> <ArchivedBadge target={{ kind: 'job', id: job.id }} /><div className="row-meta">{job.organization}</div>{(job.grade || job.arrangement) && <div className="job-submeta">{[job.grade, job.arrangement].filter(Boolean).join(' / ')}</div>}<div className="job-mobile-status">{statusBadge}<span className="source-type"><Icon size={12} />{sourceNames[job.source]}</span></div></div></div></td>
            <td className="mobile-hide"><span className="source-type"><Icon size={13} />{sourceNames[job.source]}</span><div className="row-meta">{job.dataKind === 'real' ? 'Private source' : job.batchId ? 'Batch import' : 'Sample source'}</div></td>
            <td className="mobile-hide">{statusBadge}{rubric && <ArchivedBadge target={{ kind: 'rubric', id: rubric.groupId }} />}<div className="row-meta">{deleting || rubricRemoving ? 'Cleanup is incomplete · retry the lifecycle operation' : job.rubricDeletedAt ? 'Permanently removed · source retained' : rubric ? `${rubric.criteria.length} criteria / v${rubric.version}` : job.status === 'error' ? `${job.errorStage === 'rubric' ? 'Rubric' : 'Document'} needs a retry` : processing ? job.dataKind === 'real' ? 'Server processing in progress' : 'Simulated import in progress' : 'Not yet assessed'}</div></td>
            <td className="mobile-hide"><span className="text-[11px] text-muted">{dateLabel(job.createdAt)}</span></td>
            <td><div className="flex flex-wrap items-center gap-1">{deleting ? <Link to={`/jobs/${job.id}`} className="button button-ghost button-sm">View cleanup</Link> : processing ? <Button size="sm" variant="ghost" disabled={!editable} aria-label={`Cancel ${job.title} import`} icon={X} onClick={() => void cancelJob(job.id)}>Cancel</Button>
              : !job.rubricDeletedAt && (job.status === 'error' || job.status === 'cancelled') ? <Button size="sm" disabled={!canRetry} icon={RotateCcw} onClick={() => void retryJob(job.id)}>Retry</Button>
                : <Link to={`/jobs/${job.id}`} className="button button-ghost icon-button" aria-label={`Open ${job.title}`}><ArrowUpRight size={16} /></Link>}
              <EntityLifecycleActions target={{ kind: 'job', id: job.id }} name={job.title} compact /></div></td>
          </tr>
        })}</tbody>
      </table></div> : libraryKind === 'real' && cloud?.realJobs.phase === 'loading'
        ? <EmptyState icon={LoaderCircle} title="Loading real jobs" description="Score is retrieving every page of server-owned job records for this workspace." />
        : libraryKind === 'real' && cloud && cloud.realJobs.phase !== 'ready'
          ? <EmptyState icon={BriefcaseBusiness} title="Real job imports are unavailable" description={cloud.realJobs.error ?? 'This deployment does not have real job processing enabled. Samples remain available in their separate view.'} action={<Button onClick={() => onLibraryKindChange('samples')}>View samples</Button>} />
          : <EmptyState icon={BriefcaseBusiness} title={libraryJobs.length ? 'No jobs match these filters' : libraryKind === 'real' ? 'Import your first real job' : cloud ? 'Explore the sample jobs' : 'Your next great match starts here'} description={libraryJobs.length ? 'Try another search or choose All jobs to see the rest of your library.' : libraryKind === 'real' ? `Upload an actual ${uploadFormatNames(formats)} file or enter a direct HTML/PDF posting URL. Score will create a durable queued job and source-grounded rubric.` : cloud ? 'Fictional examples remain available for the simulated workflow.' : 'Add a PDF, a job URL, or a collection of roles from a website.'}
            action={<>{libraryJobs.length > 0 && <Button onClick={() => { setQuery(''); setFilter('all'); setSource('all'); setArchiveFilter('default') }}>Clear filters</Button>}
              <Button disabled={!canEdit && !libraryJobs.length && libraryKind === 'real'} onClick={() => { if (!libraryJobs.length && libraryKind === 'real') setImportOpen(true); else { setQuery(''); setFilter('all'); setSource('all'); setArchiveFilter('all') } }}>{libraryJobs.length ? 'Show active and archived' : libraryKind === 'real' ? 'Import a real job' : 'Show all samples'}</Button></>} />}
      <div className="table-bottom"><span>Showing {filtered.length} of {scopedCount} {libraryKind === 'real' ? 'real' : 'sample'} jobs in this archive view</span></div>
    </section>
    <div className="library-note"><DemoNote>{libraryKind === 'real' ? 'Real sources are private. Select ready real resumes in the separate analysis builder, review exact target versions, then explicitly run evidence assessment. Samples alone use simulated scoring.' : cloud ? 'Sample jobs and rubrics are fictional and remain separate from real imports.' : 'Example jobs and rubrics are fictional. Add a source to explore the import workflow.'}</DemoNote><Link className="text-link shrink-0 mobile-hide" to="/rubrics">How rubrics work <ArrowRight size={12} /></Link></div>
    {importOpen && <JobImport onClose={() => setImportOpen(false)} />}
  </>
}

export function JobDetail() {
  const { id } = useParams()
  const { workspace, retryJob, cancelJob, notify, cloud } = useWorkspace()
  const navigate = useNavigate()
  const gradeLadders = useGradeLadders()
  const analyses = useRealAnalyses()
  const [highlighted, setHighlighted] = useState<{ id: string; quote?: string }>()
  const [pane, setPane] = useState<'document' | 'rubric'>('document')
  const job = workspace.jobs.find((item) => item.id === id)
  const { canEdit, deleting } = useLifecycleAccess({ kind: 'job', id: id ?? '' })
  const real = job?.dataKind === 'real'
  const detail = real && id && cloud ? cloud.realJobs.detail(id) : undefined
  const savedRubricVersion = workspace.rubrics.find((item) => item.id === job?.rubricId)?.version
  const refreshTargets = analyses?.refreshTargets
  useEffect(() => {
    if (real && id && cloud) void cloud.realJobs.ensureDetail(id)
  }, [cloud, id, real])
  useEffect(() => {
    if (real && job?.status === 'ready') void refreshTargets?.()
  }, [job?.id, job?.status, real, refreshTargets, savedRubricVersion])
  if (!job && cloud && id?.startsWith('job-') && cloud.realJobs.phase === 'loading') {
    return <EmptyState icon={LoaderCircle} title="Loading the real job" description="Retrieving this workspace's server-owned job records." />
  }
  if (!job && cloud && id?.startsWith('job-') && cloud.realJobs.phase === 'error') {
    return <EmptyState title="The job service is unavailable" description={cloud.realJobs.error ?? 'The job could not be loaded.'} action={<Button onClick={() => void cloud.realJobs.refresh()}>Retry loading</Button>} />
  }
  if (!job) return <EmptyState title="This job is not in your workspace" description="Your other jobs are available in the library." action={<Button onClick={() => navigate('/jobs')}>Back to jobs</Button>} />
  const document = workspace.documents.find((item) => item.id === job.documentId)
  const rubric = workspace.rubrics.find((item) => item.id === job.rubricId)
  const target = analyses?.targets.state === 'ready' ? analyses.targets.value.find((item) => item.kind === 'job' && item.selection.jobId === job.id && item.selection.rubricId === rubric?.id && item.selection.rubricVersion === rubric?.version) : undefined
  const analysisReady = canEdit && job.status === 'ready' && !job.rubricDeletedAt && rubric && !isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId }) && !isEntityRemoved(workspace, { kind: 'rubric', id: rubric.groupId }) && (!real || (target && analyses?.phase === 'ready' && analyses.canWrite && analyses.features?.realAnalyses && analyses.targets.state === 'ready' && !analyses.targets.error))
  const processing = job.status === 'queued' || job.status === 'parsing' || job.status === 'generating'
  const source = real && cloud ? cloud.realJobs.source(job.id) : undefined
  const summary = real && cloud ? cloud.realJobs.summaries.find((item) => item.job.id === job.id) : undefined
  const rubricRemoving = summary?.rubricLifecycle?.deletingAt
  const rubricArchived = rubric && isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId })
  const canRetry = canEdit && !rubricRemoving && !rubricArchived && !job.rubricDeletedAt && (job.status === 'error' || job.status === 'cancelled')
  const ready = canEdit && job.status === 'ready' && rubric && !rubricArchived && !job.rubricDeletedAt
  const statusBadge = deleting ? <Badge tone="warning">Deletion pending</Badge> : rubricRemoving ? <Badge tone="warning">Rubric deletion pending</Badge> : job.rubricDeletedAt ? <Badge>No rubric</Badge> : <StatusBadge status={job.status} />
  function selectCriterion(criterion: Criterion, selectedCitation?: Citation) {
    const citation = selectedCitation ?? criterion.sourceCitations?.[0]
    const paragraphId = citation?.paragraphId ?? criterion.sourceParagraphId
    if (!paragraphId) { notify('This criterion has no linked source passage. Add an exact source quotation in the rubric editor.'); return }
    setHighlighted({ id: paragraphId, quote: citation?.quote })
    setPane('document')
  }
  return <>
    <Link className="back-link" to="/jobs"><ArrowLeft size={14} />Back to jobs</Link>
    <PageHeader eyebrow="JOB WORKSPACE" title={job.title} description={job.organization}
      actions={<><EntityLifecycleActions target={{ kind: 'job', id: job.id }} name={job.title} onComplete={(action) => { if (action === 'delete') navigate('/jobs') }} />{real && <Button icon={Layers3} disabled={!ready || !gradeLadders?.canWrite || gradeLadders.phase !== 'ready'}
        title={!gradeLadders?.canWrite ? 'An owner or editor in a grade-enabled workspace can create a ladder.' : job.status !== 'ready' || !rubric ? 'Wait for the real job and saved rubric to be ready.' : gradeLadders.phase !== 'ready' ? 'Real grade processing is not currently available.' : 'Capture this real job and exact saved rubric version as a new grade family.'}
        onClick={() => navigate(`/grade-ladders/new?${new URLSearchParams({ job: job.id, rubric: rubric!.id, rubricVersion: String(rubric!.version) })}`)}>Create grade ladder</Button>}
        <Button variant="primary" icon={Sparkles} disabled={!analysisReady} title={real ? 'Requires an eligible saved real target and write access to real analyses.' : undefined}
          onClick={() => {
            if (real) {
              if (target && analyses) {
                const link = realAnalysisLink({ targets: [target.selection] }, analyses.workspaceId)
                navigate(link.to, { state: link.state })
              }
            }
            else navigate(sampleDataLink(`/analyses/new?rubrics=${job.rubricId}`, Boolean(cloud)))
          }}>Analyze applicants</Button></>} />
    <LifecycleBanner target={{ kind: 'job', id: job.id }} />
    <div className="detail-metadata">{job.location && <span><MapPin size={13} />{job.location}</span>}{(job.arrangement || job.employmentType) && <span><BriefcaseBusiness size={13} />{[job.arrangement, job.employmentType].filter(Boolean).join(' / ')}</span>}{job.grade && <Badge>{job.grade}</Badge>}{job.series && <Badge>Series {job.series}</Badge>}{statusBadge}<ArchivedBadge target={{ kind: 'job', id: job.id }} /></div>
    {real && <div className="info-callout mb-5"><ShieldCheck size={18} /><div><strong>Generated from the private source</strong><p>This job and rubric are server-owned. Analyze applicants opens a separate, manual real analysis with this exact saved version; fictional samples cannot be mixed in.</p></div></div>}
    {job.error && !job.rubricDeletedAt && !rubricRemoving && <div className="mb-5"><InlineError>
      <strong>{job.errorStage === 'rubric' ? 'The job is preserved; its rubric needs attention. ' : summary?.error?.code ? `${summary.error.code}: ` : ''}</strong>
      {job.error}
      {canRetry
        ? <button className="ml-2 underline" onClick={() => void retryJob(job.id)}>Retry import</button>
        : canEdit && summary?.error?.retryable && <span className="ml-2">The server will retry automatically; this durable job remains queued.</span>}
    </InlineError></div>}
    {summary?.warnings.length ? <div className="mb-5 info-callout"><FileText size={18} /><div><strong>Processing warnings</strong><ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] text-muted">{summary.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div></div> : null}
    {detail?.state === 'error' && <div className="mb-5"><InlineError>{detail.error} <button className="ml-2 underline" onClick={() => cloud && void cloud.realJobs.ensureDetail(job.id, true)}>Retry loading</button></InlineError></div>}
    <div className="pane-switcher"><SegmentedControl label="Job detail view" value={pane} onChange={setPane} options={[{ value: 'document', label: 'Job description' }, { value: 'rubric', label: 'Associated rubric' }]} /></div>
    <div className="split-layout">
      <section className={`detail-panel ${pane !== 'document' ? 'mobile-pane-hidden' : ''}`} aria-label="Job description">
        <div className="section-heading"><div><h2>The role, in its own words</h2><p>Source context for every criterion</p></div><FileText size={17} className="text-muted" /></div>
        {deleting ? <EmptyState title="Job deletion pending" description="Only recovery metadata remains available while cleanup finishes. Retry the lifecycle operation above; this source cannot be edited or reused." />
          : document ? real && source && cloud
          ? <PrivateDocumentViewer document={document} originalUrl={cloud.realJobs.originalUrl(job.id)} highlighted={highlighted}
            original={{ contentType: source.originalContentType ?? (source.kind === 'url' ? undefined : UPLOAD_CONTENT_TYPES[source.kind]), bytes: source.bytes, sha256: source.sha256 }} />
          : <DocumentViewer document={document} highlightedId={highlighted?.id} quote={highlighted?.quote} pagination={real ? documentPagination(source?.originalContentType) : 'pdf-pages'} /> : real && (detail?.state === 'idle' || detail?.state === 'loading')
          ? <EmptyState icon={LoaderCircle} title="Loading the parsed source" description="Score is retrieving the private source document and exact paragraph references." />
          : processing ? <EmptyState icon={LoaderCircle} title="Source processing is not complete" description="The worker is reading this source asynchronously. This page will refresh while the durable job remains queued." />
            : <EmptyState title="Source document unavailable" description={job.rubricDeletedAt ? 'The job and its original source are retained, but no parsed source was returned. Its deliberately removed rubric cannot be restored by retry.' : real ? 'The server has not returned a parsed source document. Review the job error or retry the import.' : 'This sample could not be opened. Add a fresh sample in an active workspace.'} />}
        <div className="source-footer"><span className="min-w-0">{source?.kind === 'url' && (source.finalUrl || source.url) ? <ExternalSource url={source.finalUrl ?? source.url!}>{source.displayName}</ExternalSource> : <span className="source-label">{source?.displayName ?? job.sourceLabel}</span>}</span><span>{real ? 'Private source' : 'Demo'} / {sourceNames[job.source]}</span></div>
        {real && source && !deleting && <div className="source-provenance">
          <div><strong>Source provenance</strong><span>{source.capturedAt ? `Captured ${dateLabel(source.capturedAt)}` : `Added ${dateLabel(job.createdAt)}`}</span>{source.bytes !== undefined && <span>{new Intl.NumberFormat('en', { style: 'unit', unit: 'byte', notation: 'compact' }).format(source.bytes)}</span>}{source.sha256 && <code title={source.sha256}>SHA-256 {source.sha256.slice(0, 12)}…</code>}{summary && <span>{summary.attempts} processing {summary.attempts === 1 ? 'attempt' : 'attempts'}</span>}</div>
          <a className="button button-secondary button-sm" href={cloud?.realJobs.originalUrl(job.id)} download={source.displayName}><Download size={14} />View original</a>
        </div>}
      </section>
      <section className={`detail-panel ${pane !== 'rubric' ? 'mobile-pane-hidden' : ''}`} aria-label="Associated job rubric">
        {deleting ? <EmptyState title="Cleanup is incomplete" description="Job and rubric deletion has not been acknowledged as complete. Use the explicit lifecycle retry above; unarchive and import retries remain locked." />
          : rubric ? <RubricPanel rubric={rubric} onSelectCriterion={selectCriterion} /> : <div className="p-6">
          <div className="mb-5 flex items-center justify-between"><h2 className="font-semibold">Your job rubric</h2>{statusBadge}</div>
          {rubricRemoving ? <EmptyState icon={Layers3} title="Rubric deletion pending" description="The logical rubric is locked while cleanup finishes. Use Retry lifecycle operation above; an import retry cannot finish or undo this deletion." />
            : job.rubricDeletedAt ? <EmptyState icon={Layers3} title="No rubric" description="This job’s rubric and all its versions were permanently deleted. The job and its original source are preserved. It cannot be used for analysis or as a ladder seed; retry will not restore the rubric." />
            : processing ? <><div className="loading-pulse space-y-4" aria-hidden="true">{[1, 2, 3].map((key) => <div key={key} className="h-20 rounded-xl border bg-soft" />)}</div><p role="status" className="mt-5 text-[12px] text-muted">{real ? 'The server is extracting source paragraphs and generating grounded criteria. Scheduled work may take a minute to start.' : 'Preparing sample criteria and linking them to this job...'}</p><Button size="sm" className="mt-4" disabled={!canEdit} onClick={() => void cancelJob(job.id)}>Cancel import</Button></>
            : <EmptyState icon={Layers3} title="The rubric is not ready" description={real ? 'The uploaded source is preserved. An active job may be explicitly retried.' : 'Finish the simulated import before using this job in an analysis.'} action={<Button icon={RotateCcw} disabled={!canRetry} onClick={() => void retryJob(job.id)}>Retry import</Button>} />}
        </div>}
      </section>
    </div>
    <div className="mt-5"><DemoNote>{real ? 'This rubric was generated from the displayed source. Select a citation to locate its exact paragraph. Real analysis uses frozen sources and requires human review; the sample scorer never receives these inputs.' : 'The job text and criteria are illustrative. Select a rubric requirement to locate its source passage.'}</DemoNote></div>
  </>
}
