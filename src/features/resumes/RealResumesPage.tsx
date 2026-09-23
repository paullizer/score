import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Download, FileText, LoaderCircle, Plus, RotateCcw, ShieldCheck, Users, X } from 'lucide-react'
import { useRealResumes } from '../../app/real-resumes-context'
import { useRealAnalyses } from '../../app/real-analyses-context'
import type { RealResumeSummary } from '../../domain/real-resumes'
import type { RealAnalysisResumeSelection } from '../../domain/real-analyses'
import { dateLabel } from '../../domain/selectors'
import { sortTableRows, type TableSort } from '../../domain/tableSorting'
import { Badge, Button, EmptyState, ExternalSource, InlineError, PageHeader, SearchField } from '../../components/ui'
import { SortableHeader, TableSortSelect, type TableSortOption } from '../../components/ui/TableSorting'
import { PrivateDocumentViewer } from '../../components/documents/PrivateDocumentViewer'
import { UPLOAD_CONTENT_TYPES, supportedUploadFormats } from '../../domain/document-formats'
import { uploadFormatNames } from '../../services/documentUploads'
import { realAnalysisLink, realResumeSelection } from '../analyses/realAnalysisUi'
import { readyRealResume, resumeErrorMessage, resumeName, resumeStatedName, resumeWorkActive } from './resumeImportUi'
import { RealAddResumesDialog } from './RealAddResumesDialog'
import { useWorkspace } from '../../app/workspace-context'
import { clientAdmissionReason, originalDownloadReason, usePublicSettings } from '../../app/public-settings-context'
import { effectiveFormats } from '../../services/publicSettings'
import { useLibraryViewState } from '../../app/library-view-state'
import { isEntityArchived, isEntityRemoved, matchesArchiveFilter, type ArchiveFilter } from '../../domain/lifecycle'
import { ArchivedBadge, ArchiveStateFilter, EntityLifecycleActions, LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { RenameEntityButton, RenameEntityProvider } from '../../components/ui/RenameEntityButton'

type RealResumeSortKey = 'name' | 'source' | 'status' | 'added' | 'actions'
const realResumeSortOptions: Record<RealResumeSortKey, TableSortOption<RealResumeSortKey>> = {
  name: { key: 'name', label: 'Resume label / stated name', ascendingLabel: 'A–Z', descendingLabel: 'Z–A' },
  source: { key: 'source', label: 'Source label', ascendingLabel: 'A–Z', descendingLabel: 'Z–A' },
  status: { key: 'status', label: 'Processing status', ascendingLabel: 'Needs attention first', descendingLabel: 'Complete first' },
  added: { key: 'added', label: 'Added date', ascendingLabel: 'Oldest first', descendingLabel: 'Newest first', initialDirection: 'desc' },
  actions: { key: 'actions', label: 'Status / actions', ascendingLabel: 'Needs attention first', descendingLabel: 'Complete first', title: 'Sort by processing status, not the action label.' },
}
const resumeStatusOrder = { error: 0, cancelled: 0, queued: 1, parsing: 1, profiling: 1, ready: 2 }

export function RealResumeStatus({ summary }: { summary: RealResumeSummary }) {
  if (summary.lifecycle?.deletingAt) return <Badge tone="warning">Deletion pending</Badge>
  const labels = { queued: 'Queued', parsing: 'Reading source', profiling: 'Extracting profile', ready: 'Ready', error: 'Could not process', cancelled: 'Cancelled' }
  return <Badge dot tone={summary.resume.status === 'ready' ? 'success' : summary.resume.status === 'error' ? 'danger' : 'neutral'}>{labels[summary.resume.status]}</Badge>
}

export function RealResumeActions({ summary }: { summary: RealResumeSummary }) {
  const api = useRealResumes()
  const { canEdit } = useLifecycleAccess({ kind: 'resume', id: summary.resume.id })
  const [error, setError] = useState('')
  const busy = api?.pending(summary.resume.id)
  const active = resumeWorkActive(summary)
  const canRetry = summary.resume.status === 'cancelled' || summary.resume.status === 'error'
  async function act(kind: 'retry' | 'cancel') {
    if (!api || busy || !canEdit) return
    setError('')
    try { await api[kind](summary.resume.id, summary.etag) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'This resume request could not be acknowledged.') }
  }
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      {active && <Button size="sm" icon={X} disabled={!canEdit || !api?.canWrite || busy || api.phase !== 'ready'} aria-label={`Cancel processing ${summary.source.displayName}`} onClick={() => void act('cancel')}>Cancel processing</Button>}
      {canRetry && <Button size="sm" icon={RotateCcw} disabled={!canEdit || !api?.canWrite || busy || api.phase !== 'ready'}
        title={summary.capture ? 'Retry processing the saved capture. Captured URLs are not fetched again.' : 'Explicitly retry this source. A URL must now be publicly accessible without sign-in.'}
        aria-label={`Retry processing ${summary.source.displayName}`} onClick={() => void act('retry')}>Retry processing</Button>}
    </div>
    <div className="flex flex-wrap gap-2"><RenameEntityButton target={{ kind: 'resume', id: summary.resume.id }} name={resumeName(summary)} etag={summary.etag}
      disabled={!api?.canWrite || api.phase !== 'ready' || !summary.etag || busy} />
      <EntityLifecycleActions target={{ kind: 'resume', id: summary.resume.id }} name={resumeName(summary)} /></div>
    {error && <InlineError>{error}</InlineError>}
  </div>
}

export function RealResumesPage({ id }: { id?: string }) {
  const api = useRealResumes()
  if (!api) return <EmptyState title="Real resumes require a cloud workspace" description="Open this page from an authenticated workspace. Resume files, documents, and analysis results are never stored in your browser." />
  return <RenameEntityProvider key={`${api.workspaceId}:${id ?? 'library'}`}><RealResumesView id={id} /></RenameEntityProvider>
}

function RealResumesView({ id }: { id?: string }) {
  const api = useRealResumes()!
  if (api.phase === 'unavailable') return <EmptyState title="Real resume imports are not enabled" description={api.error ?? 'Saved records are unchanged while real processing is unavailable.'} action={<Button onClick={() => void api.refresh()}>Check availability</Button>} />
  return id ? <RealResumeDetail id={id} /> : <RealResumesLibrary />
}

function RealResumesLibrary() {
  const api = useRealResumes()!
  const policy = usePublicSettings()
  const importReason = clientAdmissionReason(policy, 'resumeImports')
  const importsUnavailable = !api.features?.realResumeImports || Boolean(importReason)
  const { workspace } = useWorkspace()
  const { canEdit } = useLifecycleAccess()
  const analyses = useRealAnalyses()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useLibraryViewState('resumes:query', '')
  const [sort, setSort] = useLibraryViewState<TableSort<RealResumeSortKey> | null>('resumes:sort', null)
  const [selected, setSelected] = useState<RealAnalysisResumeSelection[]>([])
  const [adding, setAdding] = useState(false)
  const [archiveFilter, setArchiveFilter] = useLibraryViewState<ArchiveFilter>('resumes:archive', 'default')
  const query = search.trim().toLocaleLowerCase()
  const selectable = (item: RealResumeSummary) => canEdit && readyRealResume(item) && !isEntityArchived(workspace, { kind: 'resume', id: item.resume.id }) && !isEntityRemoved(workspace, { kind: 'resume', id: item.resume.id })
  const visible = sortTableRows(api.summaries.filter((item) => !item.lifecycle?.deletedAt && matchesArchiveFilter(isEntityArchived(workspace, { kind: 'resume', id: item.resume.id }), search, archiveFilter) &&
    [item.displayName, item.resume.name, item.resume.role, item.resume.location, item.resume.experience, item.resume.sourceLabel, item.source.displayName].join(' ').toLocaleLowerCase().includes(query)),
    sort, (summary, key) => {
      switch (key) {
        case 'name': return summary.displayName ?? summary.resume.name
        case 'source': return summary.source.displayName
        case 'status': case 'actions': return resumeStatusOrder[summary.resume.status]
        case 'added': return Date.parse(summary.resume.createdAt)
      }
    })
  const readyVisible = visible.filter(selectable)
  const invalidSelection = selected.some((choice) => !api.summaries.some((item) => item.resume.id === choice.resumeId && selectable(item)))
  const allVisibleSelected = readyVisible.length > 0 && readyVisible.every((item) => selected.some((choice) => choice.resumeId === item.resume.id))
  const hidden = selected.filter((choice) => !visible.some((item) => item.resume.id === choice.resumeId)).length
  const importsOpen = adding || params.get('imports') === 'open'
  const formats = effectiveFormats(supportedUploadFormats({ markdownResumeImports: api.features?.markdownResumeImports, wordDocumentImports: api.features?.wordDocumentImports }), policy.settings, 'resumes')

  function openImports(open: boolean) {
    setAdding(open)
    if (!open && params.has('imports')) { const next = new URLSearchParams(params); next.delete('imports'); setParams(next, { replace: true }) }
  }
  function toggle(summary: RealResumeSummary) {
    setSelected((current) => current.some((item) => item.resumeId === summary.resume.id)
      ? current.filter((item) => item.resumeId !== summary.resume.id) : [...current, realResumeSelection(summary)])
  }

  return <>
    <PageHeader eyebrow="REAL SOURCES, SEPARATE REVIEW" title="Resumes" description="Import actual documents, inspect the captured evidence, then manually select ready resumes for an analysis."
      actions={<><Button icon={ArrowRight} disabled={!canEdit || !selected.length || invalidSelection || !analyses?.canWrite || analyses.phase !== 'ready' || !analyses.features?.realAnalyses}
        onClick={() => {
          const link = realAnalysisLink({ resumes: selected }, api.workspaceId)
          navigate(link.to, { state: link.state })
        }}>Build analysis{selected.length ? ` (${selected.length})` : ''}</Button>
        <Button variant="primary" icon={Plus} disabled={!canEdit || !api.canWrite || api.phase !== 'ready' || importsUnavailable} title={importReason ?? undefined} onClick={() => setAdding(true)}>Add resumes</Button></>} />
    {importsUnavailable && <p className="mb-4 text-[12px] text-muted" role="status">{importReason ?? 'New resume imports are unavailable.'} Saved resumes and evidence remain available.</p>}
    {invalidSelection && <InlineError>A selected resume is archived, removed, or no longer ready. Clear it or explicitly choose active inputs; nothing will be silently skipped.</InlineError>}
    {api.error && <div className="mb-5"><InlineError>{api.error} <Button size="sm" onClick={() => void api.refresh()}>Retry resume service</Button></InlineError></div>}
    {!api.canWrite && <p className="mb-5 text-[12px] text-muted">Read-only workspace. You can inspect private resumes and sources; an owner or editor can import or analyze them.</p>}
    {analyses && (analyses.phase !== 'ready' || !analyses.features?.realAnalyses) && <p className="mb-5 text-[11px] text-muted">{analyses.creationError ?? analyses.error ?? 'Checking new analysis availability…'} Resume imports and saved analysis history have separate availability.</p>}
    <section className="panel" aria-label="Real resume library">
      <div className="library-toolbar"><div className="flex items-center gap-2"><Users size={16} className="text-muted" aria-hidden="true" /><h2 className="text-[12px] font-semibold">Private real resumes</h2><Badge>{api.summaries.filter((item) => !isEntityArchived(workspace, { kind: 'resume', id: item.resume.id }) && !isEntityRemoved(workspace, { kind: 'resume', id: item.resume.id })).length}</Badge></div>
        <div className="toolbar"><SearchField value={search} onChange={setSearch} placeholder="Search labels, stated names, or sources…" label="Search real resumes" />
          <ArchiveStateFilter value={archiveFilter} onChange={setArchiveFilter} label="Real resume archive state" />
          <TableSortSelect options={[realResumeSortOptions.name, realResumeSortOptions.source, realResumeSortOptions.status, realResumeSortOptions.added]}
            sort={sort?.key === 'actions' ? { ...sort, key: 'status' } : sort} onChange={setSort} label="Sort real resumes" />
          <Button size="sm" icon={RotateCcw} onClick={() => void api.refresh()}>Refresh</Button></div></div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <p className="text-[11px] text-muted" role="status">{selected.length ? `${selected.length} selected${hidden ? ` · ${hidden} hidden by search` : ''}` : 'Only ready sources can be selected. Unknown profile fields remain “Not stated”.'}</p>
        <div className="flex flex-wrap gap-4">{selected.length > 0 && <button className="text-link" onClick={() => setSelected([])}>Clear selection</button>}
          {readyVisible.length > 0 && <button className="text-link" onClick={() => setSelected((current) => allVisibleSelected
            ? current.filter((choice) => !readyVisible.some((item) => item.resume.id === choice.resumeId))
            : [...current, ...readyVisible.filter((item) => !current.some((choice) => choice.resumeId === item.resume.id)).map(realResumeSelection)])}>{allVisibleSelected ? 'Deselect ready visible' : 'Select ready visible'}</button>}</div>
      </div>
      {visible.length ? <div className="table-wrap"><table className="data-table">
        <caption className="sr-only">Real resume processing status. Select ready sources for a separate manually started analysis.</caption>
        <thead><tr><th scope="col"><span className="sr-only">Select ready resume</span></th>
          <SortableHeader option={realResumeSortOptions.name} sort={sort} onChange={setSort}>Resume / source profile</SortableHeader>
          <SortableHeader option={realResumeSortOptions.status} sort={sort} onChange={setSort}>Source / progress</SortableHeader>
          <SortableHeader option={realResumeSortOptions.actions} sort={sort} onChange={setSort} /></tr></thead>
        <tbody>{visible.map((summary) => {
          const checked = selected.some((item) => item.resumeId === summary.resume.id)
          const ready = selectable(summary)
          const message = resumeErrorMessage(summary)
          return <tr key={summary.resume.id} className={checked ? 'row-selected' : ''}>
            <td className="checkbox-cell"><input type="checkbox" checked={checked} disabled={!ready && !checked}
              aria-label={`Select ${resumeName(summary)} from ${summary.source.displayName}`} onChange={() => toggle(summary)} /></td>
            <td className="min-w-[180px]"><Link className="row-title" to={`/resumes/${encodeURIComponent(summary.resume.id)}`}>{resumeName(summary)}</Link>
              <ArchivedBadge target={{ kind: 'resume', id: summary.resume.id }} />
              {summary.displayName && <p className="row-meta">Source name: {resumeStatedName(summary)}</p>}
              <p className="row-meta">{summary.resume.role ?? 'Role not stated'}</p><p className="row-meta">{summary.resume.location ?? 'Location not stated'} · {summary.resume.experience ?? 'Experience not stated'}</p></td>
            <td className="min-w-[230px] max-w-[440px]"><RealResumeStatus summary={summary} />
              <p className="mt-2 break-all text-[11px] text-muted">{summary.source.displayName}</p>
              <p className="mt-1 text-[10px] text-muted">{summary.source.kind === 'url' ? 'Public URL' : summary.source.kind === 'doc' ? 'Word DOC (97–2003)' : uploadFormatNames([summary.source.kind])} · added {dateLabel(summary.resume.createdAt)} · attempt {summary.attempts}</p>
              {summary.nextAttemptAt && <p className="mt-1 text-[10px] text-muted">Automatic retry scheduled: {dateLabel(summary.nextAttemptAt)}</p>}
              {message && <p className="mt-2 text-[11px] text-[var(--cp-danger)]">{message}</p>}
              {summary.duplicates.map((warning, index) => <p key={index} className="mt-2 text-[11px] text-muted">{warning.message} Records remain separate.</p>)}
              {summary.warnings.map((warning, index) => <p key={index} className="mt-2 text-[11px] text-muted">{warning}</p>)}
            </td>
            <td><div className="space-y-3"><Link className="text-link" to={`/resumes/${encodeURIComponent(summary.resume.id)}`}>Inspect source <ArrowRight size={13} aria-hidden="true" /></Link><RealResumeActions summary={summary} /></div></td>
          </tr>
        })}</tbody>
      </table></div> : <EmptyState icon={api.phase === 'loading' ? LoaderCircle : Users}
        title={api.phase === 'loading' ? 'Loading private resumes' : api.phase === 'error' ? 'Resume service unavailable' : search ? 'No matching real resumes' : importsUnavailable ? 'No saved real resumes' : 'Import your first real resume'}
        description={api.phase === 'loading' ? 'Loading every page of authorized resume summaries.' : api.phase === 'error' ? 'Retry the service when available.'
          : search ? 'Try a stated name, role, or source label. Hidden selections are retained.' : importsUnavailable ? 'This real library is empty. New imports are unavailable under current policy or deployment support.'
            : `Choose actual ${uploadFormatNames(formats)} files or public HTML/PDF URLs. Inaccessible inputs get individual errors; successful imports remain available.`}
        action={search || api.summaries.length ? <Button onClick={() => { setSearch(''); setArchiveFilter('all') }}>Show active and archived</Button> : <Button disabled={!canEdit || !api.canWrite || api.phase !== 'ready' || importsUnavailable} title={importReason ?? undefined} icon={Plus} onClick={() => setAdding(true)}>Add real resumes</Button>} />}
      <div className="table-bottom"><span>{visible.length} of {api.summaries.length} real sources</span><span>Private server records</span></div>
    </section>
    <div className="info-callout mt-5"><ShieldCheck size={18} aria-hidden="true" /><div><strong>Evidence about a document, not a judgment about a person.</strong>
      <p>Public profiles may contain less evidence than full resumes. Importing never starts scoring.</p></div></div>
    <RealAddResumesDialog open={importsOpen} onOpenChange={openImports} />
  </>
}

function RealResumeDetail({ id }: { id: string }) {
  const api = useRealResumes()!
  const policy = usePublicSettings()
  const { cloud } = useWorkspace()
  const downloadReason = originalDownloadReason(policy, cloud?.workspaces.find(item => item.id === cloud.currentWorkspaceId)?.role)
  const analyses = useRealAnalyses()
  const navigate = useNavigate()
  const entry = api.detail(id)
  const { canEdit, deleting, removed } = useLifecycleAccess({ kind: 'resume', id })
  const ensure = api.ensureDetail
  useEffect(() => { if (api.phase === 'ready') void ensure(id) }, [api.phase, ensure, entry.state, id])
  const back = <Link className="back-link" to="/resumes"><ArrowLeft size={14} aria-hidden="true" />Back to real resumes</Link>
  if (deleting || (removed && entry.state === 'ready')) return <>{back}<LifecycleBanner target={{ kind: 'resume', id }} /><EmptyState title="Resume cleanup or removal" description="Only recovery metadata remains available. Cached documents and original downloads are hidden. Retry the lifecycle operation above if cleanup is incomplete." /></>
  if (entry.state !== 'ready') return <>{back}<EmptyState icon={entry.state === 'error' || api.phase === 'error' ? FileText : LoaderCircle}
    title={entry.state === 'error' || api.phase === 'error' ? 'This real resume could not be opened' : 'Opening private resume'}
    description={entry.state === 'error' ? entry.error : api.error ?? 'Loading the actual captured source and evidence-derived profile.'}
    action={<Button onClick={() => { void api.refresh(); void ensure(id, true) }}>Retry loading</Button>} /></>
  const detail = entry.value
  const summary = api.summaries.find((item) => item.resume.id === id) ?? detail
  const message = resumeErrorMessage(summary)
  const ready = readyRealResume(detail)
  return <>{back}
    <PageHeader eyebrow="REAL RESUME · PRIVATE SOURCE" title={resumeName(summary)} description={detail.resume.role ?? 'Role not stated in the captured source'}
      actions={<><RealResumeActions summary={summary} /><Button variant="primary" icon={ArrowRight} disabled={!canEdit || !ready || !analyses?.canWrite || analyses.phase !== 'ready' || !analyses.features?.realAnalyses}
        onClick={() => {
          const link = realAnalysisLink({ resumes: [realResumeSelection(detail)] }, api.workspaceId)
          navigate(link.to, { state: link.state })
        }}>Build analysis</Button></>} />
    {summary.displayName && <p className="mb-4 break-words text-[12px] text-muted">Source name: {resumeStatedName(summary)} · Original source: {summary.source.displayName}</p>}
    <LifecycleBanner target={{ kind: 'resume', id }} />
    <div className="detail-metadata"><RealResumeStatus summary={summary} /><ArchivedBadge target={{ kind: 'resume', id }} /><span>{detail.resume.location ?? 'Location not stated'}</span><span>{detail.resume.experience ?? 'Experience not stated'}</span><span>Added {dateLabel(detail.resume.createdAt)}</span></div>
    {(entry.error || api.error) && <div className="mb-5"><InlineError>{entry.error ?? api.error} The last acknowledged source is shown. <Button size="sm" onClick={() => void ensure(id, true)}>Reload source</Button></InlineError></div>}
    {message && <div className="mb-5"><InlineError>{message}{summary.error?.retryable === false && <p>Automatic retries are stopped for this error; you can still explicitly retry processing. {summary.capture
      ? 'The saved capture is preserved and will be reused, not fetched again. Import a new source separately if its content needs to change.'
      : summary.source.kind === 'url' ? 'No source has been captured yet. A manual retry can succeed if this URL has become publicly accessible; Score will not sign in or bypass restrictions.' : 'The same submitted file is reused; choose a new import if you need to supply a different file.'}</p>}</InlineError></div>}
    {(detail.source.kind === 'url' || summary.warnings.length > 0) && <div className="info-callout mb-5"><FileText size={18} aria-hidden="true" /><div><strong>Source limitations</strong>
      {detail.source.kind === 'url' && <p>A public profile may be sparse. Missing names, roles, experience, or evidence are never inferred from a URL or filename.</p>}
      {summary.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
    {summary.duplicates.map((warning, index) => <div className="info-callout mb-5" key={index}><p>{warning.message} <Link className="text-link" to={`/resumes/${encodeURIComponent(warning.resumeId)}`}>Inspect the other source</Link>. No profiles were merged or overwritten.</p></div>)}
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className="detail-panel" aria-label="Actual resume source">
        <div className="section-heading"><div><h2>Inspect the captured evidence</h2><p>Normalized text from this private capture</p></div></div>
        {detail.document ? <PrivateDocumentViewer document={detail.document} originalUrl={api.originalUrl(id)} pagination={detail.extraction?.pagination}
          original={detail.capture?.original ?? { contentType: detail.source.kind === 'url' ? undefined : UPLOAD_CONTENT_TYPES[detail.source.kind] }} />
          : <EmptyState icon={resumeWorkActive(summary) ? LoaderCircle : FileText} title="No normalized source is available yet"
            description={resumeWorkActive(summary) ? 'The server is processing this source. Accepted work continues independently after the browser closes.' : 'Processing did not produce a readable document. Review the item error; no document or profile was invented.'} />}
        <div className="source-footer"><span className="break-all">{detail.source.displayName}</span><span>{detail.source.kind === 'url' ? 'Public source capture' : `Uploaded ${uploadFormatNames([detail.source.kind])}`}</span></div>
      </section>
      <aside className="space-y-5" aria-label="Resume profile and capture provenance">
        <section className="detail-panel"><div className="section-heading"><h2>Source-backed profile</h2></div>
          <dl className="space-y-4 p-5 text-[11px]">{([['Name', detail.resume.name], ['Role', detail.resume.role], ['Location', detail.resume.location], ['Experience', detail.resume.experience]] as const).map(([label, value]) =>
            <div key={label}><dt className="mb-1 text-muted">{label}</dt><dd>{value ?? 'Not stated'}</dd></div>)}</dl>
        </section>
        <section className="detail-panel"><div className="section-heading"><h2>Capture provenance</h2></div>
          <div className="space-y-4 p-5 text-[11px]">
            {detail.source.kind === 'url' && <div><p className="text-muted">Requested source</p><ExternalSource url={detail.source.url}>{detail.source.url}</ExternalSource></div>}
            {detail.capture?.finalUrl && <div><p className="text-muted">Captured URL</p><ExternalSource url={detail.capture.finalUrl}>{detail.capture.finalUrl}</ExternalSource></div>}
            <p>{detail.capture ? `Captured ${dateLabel(detail.capture.capturedAt)} · ${detail.capture.original.contentType} · ${detail.capture.original.bytes.toLocaleString()} bytes` : 'No source capture has been acknowledged yet.'}</p>
            {detail.capture && <><code className="block break-all text-[10px]">Original SHA-256 {detail.capture.original.sha256}</code>
              {downloadReason ? <p className="text-muted" role="status">{downloadReason}</p>
                : <a className="button button-secondary button-sm" download href={api.originalUrl(id)}><Download size={14} aria-hidden="true" />Download captured original</a>}</>}
            {detail.extraction && <p>{detail.extraction.method} · parser {detail.extraction.version} · {detail.extraction.pagination === 'pdf-pages' ? `${detail.extraction.pageCount ?? 'Unknown'} PDF pages` : detail.extraction.pagination === 'markdown-sections' ? 'Markdown sections, not PDF pages' : detail.extraction.pagination === 'captured-sections' ? 'Captured source sections, not printed pages' : 'Captured HTML sections, not PDF pages'}</p>}
            {detail.documentRef && <div><p>Saved document v{detail.documentRef.documentVersion}</p><code className="block break-all text-[10px]">{detail.documentRef.documentId}<br />SHA-256 {detail.documentRef.sha256}</code></div>}
            <p>Processing attempt {summary.attempts} · {summary.retryCount} manual retries</p>
            {detail.profile && <p>Profile extraction: {detail.profile.provenance.model} · {detail.profile.provenance.promptVersion} · {detail.profile.provenance.schemaVersion}</p>}
            <p className="border-t pt-4 text-muted">A retry reuses saved evidence when available.</p>
          </div>
        </section>
      </aside>
    </div>
  </>
}
