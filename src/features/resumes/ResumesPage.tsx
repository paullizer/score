import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BriefcaseBusiness, FileText, MapPin, Plus, Users, X } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { DocumentViewer } from '../../components/documents/DocumentViewer'
import { Avatar, Badge, Button, DemoNote, EmptyState, InlineError, PageHeader, SearchField, SegmentedControl } from '../../components/ui'
import { dateLabel, runStatus } from '../../domain/selectors'
import { AddResumesDialog } from './AddResumesDialog'
import { RealResumesPage } from './RealResumesPage'
import { useRealResumes } from '../../app/real-resumes-context'
import { dataMode, sampleDataLink } from '../../app/real-data-mode'

function analysisLink(ids: string[], cloud: boolean): string {
  return sampleDataLink(`/analyses/new?${new URLSearchParams({ resumes: ids.join(',') }).toString()}`, cloud)
}

function ResumesLibrary() {
  const { workspace, cloud } = useWorkspace()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [importError, setImportError] = useState('')
  const query = search.trim().toLocaleLowerCase()
  const visible = workspace.resumes.filter((resume) => [resume.name, resume.role, resume.location, resume.experience, resume.sourceLabel].join(' ').toLocaleLowerCase().includes(query))
  const selected = workspace.resumes.filter((resume) => selection.includes(resume.id))
  const allVisibleSelected = visible.length > 0 && visible.every((resume) => selection.includes(resume.id))
  const someVisibleSelected = visible.some((resume) => selection.includes(resume.id))
  const hiddenCount = selected.filter((resume) => !visible.some((item) => item.id === resume.id)).length

  function toggle(id: string) {
    setSelection((value) => value.includes(id) ? value.filter((item) => item !== id) : [...value, id])
  }

  function toggleVisible() {
    setSelection((value) => allVisibleSelected
      ? value.filter((id) => !visible.some((resume) => resume.id === id))
      : [...new Set([...value, ...visible.map((resume) => resume.id)])])
  }

  function openImport() {
    setImportError('')
    setAdding(true)
  }

  return <>
    <PageHeader
      eyebrow="EXPERIENCE, IN CONTEXT"
      title="Resumes"
      description="Get to know the people behind the profiles. Compare one resume, or bring a whole batch."
      actions={<>
        <Button icon={ArrowRight} disabled={!selected.length} onClick={() => navigate(analysisLink(selected.map((resume) => resume.id), Boolean(cloud)))}>Match to jobs{selected.length ? ` (${selected.length})` : ''}</Button>
        <Button variant="primary" icon={Plus} onClick={openImport}>Add resumes</Button>
      </>}
    />

    {importError && !adding && <div className="mb-5"><InlineError>
      <div className="flex items-start gap-3"><span>{importError}</span><button type="button" aria-label="Dismiss resume import error" onClick={() => setImportError('')}><X size={15} aria-hidden="true" /></button></div>
    </InlineError></div>}
    <section className="panel">
      <div className="library-toolbar">
        <div className="flex items-center gap-2.5"><Users size={16} className="text-muted" aria-hidden="true" /><h2 className="text-[12px] font-semibold">Your resume library</h2><Badge>{workspace.resumes.length}</Badge></div>
        <SearchField value={search} onChange={setSearch} placeholder="Search people, roles, or filenames…" label="Search resume library" />
      </div>
      <div className={`flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3 ${selected.length ? 'bg-accent-soft' : ''}`}>
        <p className="text-[11px] text-muted" role="status" aria-live="polite">
          {selected.length
            ? <><strong className="font-semibold text-accent">{selected.length} selected</strong>{hiddenCount > 0 && ` · ${hiddenCount} hidden by search`}</>
            : 'Select resumes to compare against jobs or independent grade rubrics.'}
        </p>
        <div className="flex items-center gap-4">
          {selected.length > 0 && <button type="button" className="link-button text-[11px]" onClick={() => setSelection([])}>Clear selection</button>}
          {visible.length > 0 && <button type="button" className="link-button text-[11px]" onClick={toggleVisible}>{allVisibleSelected ? 'Deselect visible' : 'Select visible'}</button>}
        </div>
      </div>

      {visible.length > 0 ? <>
        <div className="table-wrap hidden md:block">
          <table className="data-table">
            <caption className="sr-only">Fictional resumes available for comparison. Select one or more profiles, then choose Match to jobs.</caption>
            <thead><tr>
              <th scope="col" className="checkbox-cell"><input
                type="checkbox"
                checked={allVisibleSelected}
                ref={(element) => { if (element) element.indeterminate = someVisibleSelected && !allVisibleSelected }}
                onChange={toggleVisible}
                aria-label="Select all visible resumes"
              /></th>
              <th scope="col">Candidate</th>
              <th scope="col">Location</th>
              <th scope="col">Experience</th>
              <th scope="col">Document label</th>
              <th scope="col"><span className="sr-only">View profile</span></th>
            </tr></thead>
            <tbody>{visible.map((resume) => <tr key={resume.id} className={selection.includes(resume.id) ? 'row-selected' : ''}>
              <td className="checkbox-cell"><input type="checkbox" checked={selection.includes(resume.id)} onChange={() => toggle(resume.id)} aria-label={`Select ${resume.name}`} /></td>
              <td>
                <div className="flex min-w-[200px] items-center gap-3">
                  <Avatar initials={resume.initials} />
                  <div className="min-w-0"><Link to={sampleDataLink(`/resumes/${resume.id}`, Boolean(cloud))} className="row-title">{resume.name}</Link><p className="row-meta">{resume.role}</p></div>
                </div>
              </td>
              <td><span className="text-[11px] text-muted">{resume.location}</span></td>
              <td><span className="whitespace-nowrap text-[11px]">{resume.experience}</span></td>
              <td><div className="flex items-start gap-2 text-[11px] text-muted"><FileText size={14} className="mt-0.5 shrink-0" aria-hidden="true" /><div className="min-w-0 max-w-[210px]"><p className="break-words">{resume.sourceLabel}</p><p className="mt-1 text-[9px]">Fictional content · {dateLabel(resume.createdAt)}</p></div></div></td>
              <td><Link to={sampleDataLink(`/resumes/${resume.id}`, Boolean(cloud))} className="inline-flex rounded-lg p-2 text-muted hover:bg-soft hover:text-accent" aria-label={`View ${resume.name}'s resume`}><ArrowRight size={16} aria-hidden="true" /></Link></td>
            </tr>)}</tbody>
          </table>
        </div>

        <div className="space-y-3 p-4 md:hidden">
          {visible.map((resume) => <article className={`resume-card ${selection.includes(resume.id) ? 'border-accent bg-accent-soft' : ''}`} key={resume.id}>
            <div className="flex items-start gap-3">
              <input type="checkbox" className="mt-3" checked={selection.includes(resume.id)} onChange={() => toggle(resume.id)} aria-label={`Select ${resume.name}`} />
              <Avatar initials={resume.initials} />
              <div className="min-w-0 flex-1"><h3><Link to={sampleDataLink(`/resumes/${resume.id}`, Boolean(cloud))} className="row-title text-[13px]">{resume.name}</Link></h3><p className="mt-1 text-[11px] text-muted">{resume.role}</p></div>
            </div>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[10px] text-muted">
              <span className="inline-flex items-center gap-1.5"><MapPin size={12} aria-hidden="true" />{resume.location}</span>
              <span className="inline-flex items-center gap-1.5"><BriefcaseBusiness size={12} aria-hidden="true" />{resume.experience}</span>
            </div>
            <div className="mt-3 border-t pt-3"><p className="break-words text-[10px] text-muted">{resume.sourceLabel}</p><div className="mt-3 flex items-center justify-between gap-2"><Badge>Fictional profile</Badge><Link to={sampleDataLink(`/resumes/${resume.id}`, Boolean(cloud))} className="text-link text-[11px]">View resume <ArrowRight size={12} aria-hidden="true" /></Link></div></div>
          </article>)}
        </div>
      </> : <EmptyState
        icon={Users}
        title={query ? 'No matching resumes' : 'A fresh page for your next review'}
        description={query ? 'Try another name, role, location, or filename. Resumes selected outside this search stay selected.' : 'Add PDF filenames or load a sample batch to explore fictional profiles and their supporting experience.'}
        action={query ? <Button onClick={() => setSearch('')}>Clear search</Button> : <Button icon={Plus} onClick={openImport}>Add sample resumes</Button>}
      />}
      <div className="table-bottom"><span>Showing {visible.length} of {workspace.resumes.length} fictional profiles</span><span>PDF filenames only · Sample document content</span></div>
    </section>
    <div className="mt-5"><DemoNote>Every candidate is fictional. Added PDFs are represented by replacement sample documents; no file contents are read, uploaded, or stored.</DemoNote></div>

    <AddResumesDialog
      mode="samples"
      open={adding}
      onOpenChange={setAdding}
      onError={setImportError}
      onAdded={(ids) => {
        setSelection((value) => [...new Set([...value, ...ids])])
        setSearch('')
        setImportError('')
      }}
    />
  </>
}

function ResumeDetail({ id }: { id: string }) {
  const { workspace, cloud } = useWorkspace()
  const navigate = useNavigate()
  const resume = workspace.resumes.find((item) => item.id === id)
  const document = workspace.documents.find((item) => item.id === resume?.documentId)

  if (!resume) return <>
    <Link className="back-link" to={sampleDataLink('/resumes', Boolean(cloud))}><ArrowLeft size={14} aria-hidden="true" />Back to resumes</Link>
    <PageHeader title="Resume unavailable" description="This profile could not be found in the current workspace." />
    <section className="panel"><EmptyState icon={Users} title="This resume is no longer here" description="It may belong to a workspace that was reset. Return to the library to choose another fictional profile." action={<Button onClick={() => navigate(sampleDataLink('/resumes', Boolean(cloud)))}>Open resume library</Button>} /></section>
  </>

  const recentRuns = workspace.runs.filter((run) => run.resumes.some((snapshot) => snapshot.resume.id === resume.id)).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 5)
  const available = Boolean(document?.paragraphs.length)

  return <>
    <Link className="back-link" to={sampleDataLink('/resumes', Boolean(cloud))}><ArrowLeft size={14} aria-hidden="true" />Back to resumes</Link>
    <PageHeader
      eyebrow="FICTIONAL CANDIDATE PROFILE"
      title={resume.name}
      description={resume.role}
      actions={<Button icon={ArrowRight} variant="primary" disabled={!available} onClick={() => navigate(analysisLink([resume.id], Boolean(cloud)))}>Match to jobs</Button>}
    />
    <div className="detail-metadata">
      <Badge tone="accent">Fictional profile</Badge>
      <span><MapPin size={13} aria-hidden="true" />{resume.location}</span>
      <span><BriefcaseBusiness size={13} aria-hidden="true" />{resume.experience}</span>
      <span>Added {dateLabel(resume.createdAt)}</span>
    </div>
    {!available && <div className="mb-5"><InlineError>The sample source document is missing or empty. This resume cannot be analyzed until its sample content is restored. Choose another profile or add a fresh sample batch.</InlineError></div>}

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section className="detail-panel" aria-label={`${resume.name}'s sample resume`}>
        <div className="section-heading"><div><h2>The experience behind the profile</h2><p>Original sample paragraphs, ready to inspect</p></div><FileText size={16} className="text-muted" aria-hidden="true" /></div>
        {document && available
          ? <DocumentViewer document={document} />
          : <EmptyState icon={FileText} title="Source document unavailable" description="No replacement source text is available for this profile. Open another resume from the library." action={<Button onClick={() => navigate(sampleDataLink('/resumes', Boolean(cloud)))}>Choose another resume</Button>} />}
        <div className="source-footer"><span className="min-w-0 break-words">{resume.sourceLabel}</span><span>Fictional replacement · not PDF content</span></div>
      </section>

      <aside className="space-y-5" aria-label="Candidate context and analysis history">
        <section className="detail-panel">
          <div className="section-heading"><h2>Profile at a glance</h2></div>
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-3"><Avatar initials={resume.initials} /><div className="min-w-0"><p className="text-[12px] font-semibold">{resume.name}</p><p className="mt-1 text-[10px] text-muted">{resume.role}</p></div></div>
            <dl className="space-y-4 text-[11px]">
              <div><dt className="mb-1 text-[10px] text-muted">Location</dt><dd>{resume.location}</dd></div>
              <div><dt className="mb-1 text-[10px] text-muted">Experience</dt><dd>{resume.experience}</dd></div>
              <div><dt className="mb-1 text-[10px] text-muted">Document label</dt><dd className="break-words">{resume.sourceLabel}</dd></div>
            </dl>
            <div className="border-t pt-4"><DemoNote>This profile and its experience are fictional. The document label is not a claim that Score read a real resume.</DemoNote></div>
            <p className="text-[10px] text-muted">Match to jobs opens a new analysis with this resume selected. You can also choose reusable grade rubrics without a job.</p>
          </div>
        </section>

        <section className="detail-panel">
          <div className="section-heading"><div><h2>Recent analyses</h2><p>Runs that include this profile</p></div></div>
          {recentRuns.length > 0 ? <ul className="divide-y">
            {recentRuns.map((run) => {
              const status = runStatus(run)
              const comparisons = run.comparisons.filter((comparison) => comparison.resumeId === resume.id).length
              return <li key={run.id} className="p-4">
                <Link to={sampleDataLink(`/analyses/${run.id}`, Boolean(cloud))} className="row-title inline-flex items-start gap-2"><span>{run.name}</span><ArrowRight size={13} className="mt-0.5 shrink-0" aria-hidden="true" /></Link>
                <div className="mt-2 flex flex-wrap items-center gap-2"><Badge tone={status === 'Needs attention' ? 'warning' : status === 'Complete' ? 'success' : 'neutral'} dot>{status}</Badge><span className="text-[10px] text-muted">{dateLabel(run.createdAt)}</span></div>
                <p className="mt-2 text-[10px] text-muted">{comparisons} {comparisons === 1 ? 'comparison' : 'comparisons'} for this resume · saved input versions</p>
              </li>
            })}
          </ul> : <div className="p-5"><p className="text-[12px] font-medium">No comparisons yet.</p><p className="mt-2 text-[11px] text-muted">Start with one job or an independent grade rubric. The resulting evidence will appear here.</p><Button className="mt-4" size="sm" icon={ArrowRight} disabled={!available} onClick={() => navigate(analysisLink([resume.id], Boolean(cloud)))}>Start an analysis</Button></div>}
        </section>
      </aside>
    </div>
  </>
}

export function ResumesPage() {
  const { id } = useParams<{ id: string }>()
  const { workspace, cloud } = useWorkspace()
  const real = useRealResumes()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const mode = dataMode(params, Boolean(cloud), Boolean(id && workspace.resumes.some((resume) => resume.id === id)))
  if (mode === 'invalid') return <EmptyState title="Unknown resume mode" description="Choose real resumes or the explicitly fictional Samples view." action={<Button onClick={() => navigate('/resumes')}>Open resume library</Button>} />
  return <>
    {cloud && !id && <div className="library-kind-switcher mb-5 rounded-xl border"><SegmentedControl label="Choose real resumes or samples" value={mode}
      onChange={(value) => navigate(`/resumes?data=${value}`)} options={[{ value: 'real', label: 'Real resumes', count: real?.summaries.length ?? 0 }, { value: 'samples', label: 'Samples', count: workspace.resumes.length }]} />
      <span>{mode === 'real' ? 'Actual private sources · manual analysis' : 'Fictional profiles · filenames only · simulated scoring'}</span></div>}
    {mode === 'real' ? <RealResumesPage id={id} /> : id ? <ResumeDetail key={id} id={id} /> : <ResumesLibrary />}
  </>
}
