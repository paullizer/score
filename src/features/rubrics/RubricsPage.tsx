import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BriefcaseBusiness, FileSearch, Layers3, LoaderCircle } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { DocumentViewer } from '../../components/documents/DocumentViewer'
import { Badge, Button, DemoNote, EmptyState, InlineError, Modal, PageHeader, SearchField, SegmentedControl } from '../../components/ui'
import { dateLabel, latestRubrics } from '../../domain/selectors'
import type { Citation, Criterion, Rubric, Workspace } from '../../domain/types'
import { RubricPanel } from './RubricPanel'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { GradeLadderLibrary } from '../grade-ladders/GradeLadderLibrary'
import { gradeLadderLink } from '../grade-ladders/gradeUi'
import { useRealAnalyses } from '../../app/real-analyses-context'
import { sampleDataLink } from '../../app/real-data-mode'
import { realAnalysisLink } from '../analyses/realAnalysisUi'
import type { RealAnalysisTargetSelection, RealAnalysisTargetSummary } from '../../domain/real-analyses'

function analysisLink(ids: string[], cloud: boolean): string {
  return sampleDataLink(`/analyses/new?${new URLSearchParams({ rubrics: ids.join(',') }).toString()}`, cloud)
}

function rubricReady(rubric: Rubric, workspace: Workspace, targets: RealAnalysisTargetSummary[] = []): boolean {
  if (rubric.dataKind === 'real') return targets.some((target) => target.rubricId === rubric.id && target.rubricVersion === rubric.version)
  return rubric.kind === 'grade' || workspace.jobs.some((job) => job.id === rubric.jobId && job.rubricId === rubric.id && job.status === 'ready')
}

function rubricLink(rubric: Rubric): string {
  const query = rubric.dataKind === 'real' && rubric.jobId ? `?job=${encodeURIComponent(rubric.jobId)}` : ''
  return `/rubrics/${rubric.id}${query}`
}

function RubricsLibrary() {
  const { workspace, cloud, notify } = useWorkspace()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const gradeLadders = useGradeLadders()
  const analyses = useRealAnalyses()
  const eligible = analyses?.canWrite && analyses.phase === 'ready' && analyses.features?.realAnalyses && analyses.targets.state === 'ready' && !analyses.targets.error ? analyses.targets.value : []
  const kind = params.get('kind') === 'grade' ? 'grade' : 'job'
  const libraryKind = cloud && params.get('data') !== 'samples' ? 'real' : 'samples'
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<string[]>([])
  const [exactTargets, setExactTargets] = useState<Record<string, RealAnalysisTargetSelection>>({})
  const rubrics = latestRubrics(workspace).filter((rubric) => libraryKind === 'real' ? rubric.dataKind === 'real' : rubric.dataKind !== 'real')
  const query = search.trim().toLocaleLowerCase()
  const visible = rubrics.filter((rubric) => {
    const job = workspace.jobs.find((item) => item.id === rubric.jobId)
    return rubric.kind === kind && [
      rubric.name, rubric.description, rubric.ladder, rubric.grade, job?.title, job?.organization,
      ...rubric.criteria.map((criterion) => criterion.label),
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)
  })
  const selected = rubrics.filter((rubric) => selection.includes(rubric.id))
  const hiddenCount = selected.filter((rubric) => !visible.some((item) => item.id === rubric.id)).length
  const groups = new Map<string, Rubric[]>()
  for (const rubric of visible) {
    const group = kind === 'grade' ? rubric.ladder || 'General Schedule' : 'Linked to your jobs'
    groups.set(group, [...(groups.get(group) ?? []), rubric])
  }
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
  const readyVisible = visible.filter((rubric) => rubricReady(rubric, workspace, eligible))
  const allVisibleSelected = readyVisible.length > 0 && readyVisible.every((rubric) => selection.includes(rubric.id))

  function toggle(id: string) {
    choose(selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id])
  }

  function choose(ids: string[]) {
    setSelection(ids)
    setExactTargets((current) => Object.fromEntries(ids.flatMap((id) => {
      const shownVersion = rubrics.find((item) => item.id === id)?.version
      const target = current[id] ?? eligible.find((item) => item.rubricId === id && item.rubricVersion === shownVersion)?.selection
      return target ? [[id, target]] : []
    })))
  }

  function analyze(items: Rubric[], preserveSelection = false) {
    if (libraryKind !== 'real') { navigate(analysisLink(items.map((item) => item.id), Boolean(cloud))); return }
    if (!analyses) { notify('Real analysis selection transfer is unavailable in this workspace.'); return }
    const targets = items.map((rubric) => (preserveSelection ? exactTargets[rubric.id] : undefined)
      ?? eligible.find((item) => item.rubricId === rubric.id && item.rubricVersion === rubric.version)?.selection)
    if (targets.some((item) => !item)) { notify('An exact real target is unavailable. Refresh the eligible targets and review your selection. Nothing was skipped.'); return }
    const link = realAnalysisLink({ targets: targets as RealAnalysisTargetSelection[] }, analyses.workspaceId)
    navigate(link.to, { state: link.state })
  }

  function selectVisible() {
    choose(allVisibleSelected
      ? selection.filter((id) => !readyVisible.some((rubric) => rubric.id === id))
      : [...new Set([...selection, ...readyVisible.map((rubric) => rubric.id)])])
  }

  return <>
    <PageHeader
      eyebrow="THE STANDARD, MADE VISIBLE"
      title="Rubrics"
      description="Inspect the criteria before the comparison. Reuse a grade standard, or work from a specific job."
      actions={<Button
        icon={ArrowRight}
        variant="primary"
        disabled={!selected.length || selected.length !== selection.length || (libraryKind === 'real' && (!analyses?.canWrite || analyses.phase !== 'ready' || !analyses.features?.realAnalyses))}
        onClick={() => analyze(selected, true)}
      >Analyze selected{selected.length ? ` (${selected.length})` : ''}</Button>}
    />

    <section className="panel">
      {cloud && <div className="library-kind-switcher"><SegmentedControl label="Choose real rubrics or samples" value={libraryKind}
        onChange={(value) => { choose([]); setParams({ kind, data: value }, { replace: true }) }} options={[{ value: 'real', label: 'Real rubrics' }, { value: 'samples', label: 'Samples' }]} />
        <span>{libraryKind === 'real' ? 'Private evidence · exact saved versions for real analysis' : 'Fictional job and grade fixtures for demo analysis only.'}</span></div>}
      <div className="library-toolbar">
        <SegmentedControl<'job' | 'grade'>
          label="Rubric type"
          value={kind}
          onChange={(value) => { choose([]); setParams({ kind: value, data: libraryKind }, { replace: true }) }}
          options={[
            { value: 'job', label: 'Job rubrics', count: rubrics.filter((rubric) => rubric.kind === 'job').length },
            { value: 'grade', label: 'GS / grade rubrics', count: libraryKind === 'real' ? gradeLadders?.summaries.reduce((count, family) => count + family.levels.length, 0) ?? 0 : rubrics.filter((rubric) => rubric.kind === 'grade').length },
          ]}
        />
        <SearchField value={search} onChange={setSearch} placeholder="Search rubrics, criteria, or grades…" label="Search rubric library" />
      </div>

      {!(kind === 'grade' && libraryKind === 'real') && <><div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <p className="text-[11px] text-muted" role="status" aria-live="polite">
          {selected.length > 0
            ? <><strong className="font-semibold text-accent">{selected.length} selected</strong>{hiddenCount > 0 && ` · ${hiddenCount} outside this view`}</>
            : libraryKind === 'real' ? 'Select eligible real job rubrics for manual analysis, or inspect approved GS versions in their grade families.' : 'Choose one or more sample rubrics to prefill a demo analysis.'}
        </p>
        <div className="flex items-center gap-4">
          {selected.length > 0 && <button type="button" className="link-button text-[11px]" onClick={() => choose([])}>Clear selection</button>}
          {readyVisible.length > 0 && <button type="button" className="link-button text-[11px]" onClick={selectVisible}>
            {allVisibleSelected ? 'Deselect visible' : 'Select visible'}
          </button>}
        </div>
      </div>

      {kind === 'grade' && <div className="flex items-start gap-3 border-b px-5 py-4">
        <Layers3 size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <div>
          <h2 className="text-[12px] font-semibold">Explore a grade, not just a vacancy.</h2>
          <p className="mt-1 text-[11px] text-muted">Select grades within a family to compare a resume across levels. No job is required. These are illustrative standards, not official qualification guidance.</p>
        </div>
      </div>}

      {visible.length > 0 ? <div className="space-y-7 p-5">
        {orderedGroups.map(([family, familyRubrics]) => <section key={family} aria-label={family}>
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-semibold">{family}</h2>
            <span className="text-[10px] text-muted">
              {kind === 'grade' ? 'Reusable grade family' : 'Each rubric stays attached to its source job'}
            </span>
          </div>
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {[...familyRubrics].sort((left, right) => (left.grade ?? left.name).localeCompare(right.grade ?? right.name, undefined, { numeric: true })).map((rubric) => {
              const job = workspace.jobs.find((item) => item.id === rubric.jobId)
              const ready = rubricReady(rubric, workspace, eligible)
              const checked = selected.some((item) => item.id === rubric.id)
              return <article className={`rubric-card flex min-w-0 flex-col ${checked ? 'border-accent bg-accent-soft' : ''}`} key={rubric.id}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {rubric.kind === 'grade'
                      ? <Layers3 size={16} className="text-muted" aria-hidden="true" />
                      : <BriefcaseBusiness size={16} className="text-muted" aria-hidden="true" />}
                    <Badge>{rubric.grade ?? job?.grade ?? 'Job-specific'}</Badge>
                    <span className="text-[10px] text-muted">v{rubric.version}</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(rubric.id)}
                    disabled={!ready}
                    aria-label={`Select ${rubric.name}`}
                    title={ready ? `Select ${rubric.name}, version ${rubric.version}` : rubric.dataKind === 'real' ? 'Real analysis requires an eligible saved target, available processing, and write access.' : 'Finish the linked job import before analysis.'}
                  />
                </div>
                <h3><Link to={rubricLink(rubric)} className="row-title text-[14px] leading-5">{rubric.name}</Link></h3>
                {job && <p className="row-meta">{job.organization}</p>}
                <p className="mt-2 line-clamp-2 text-[11px] text-muted">{rubric.description}</p>
                <div className="my-4 border-y py-3">
                  <p className="mb-2 text-[10px] font-medium text-muted">{rubric.criteria.length} weighted criteria</p>
                  <ol className="space-y-1.5">
                    {rubric.criteria.slice(0, 3).map((criterion, index) => <li className="flex items-baseline gap-2 text-[11px]" key={criterion.id}>
                      <span className="font-mono text-[9px] text-muted">{String(index + 1).padStart(2, '0')}</span>
                      <span className="min-w-0 flex-1 truncate">{criterion.label}</span>
                      <span className="text-[10px] tabular-nums text-muted">{criterion.weight}%</span>
                    </li>)}
                  </ol>
                  {rubric.criteria.length > 3 && <p className="mt-2 text-[10px] text-muted">+ {rubric.criteria.length - 3} more to inspect</p>}
                </div>
                {!ready && <p className="mb-3 text-[10px] text-muted">{rubric.dataKind === 'real' ? 'This exact real version is not currently eligible, or analysis processing/write access is unavailable. The sample scorer cannot use it.' : 'The linked job must finish importing before this rubric can be used.'}</p>}
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                  <Link to={rubricLink(rubric)} className="text-link text-[11px]">Inspect rubric <ArrowRight size={13} aria-hidden="true" /></Link>
                  <Button size="sm" variant="ghost" disabled={!ready} onClick={() => analyze([rubric])}>Use rubric</Button>
                </div>
              </article>
            })}
          </div>
        </section>)}
      </div> : <EmptyState
        icon={Layers3}
        title={query ? 'No matching rubrics' : kind === 'job' ? 'No job rubrics yet' : 'No grade rubrics available'}
        description={query
          ? 'Try a different name, criterion, family, or grade. Selections outside this view are kept.'
          : kind === 'job'
            ? cloud ? 'Import a real job or inspect the separate sample jobs to prepare a linked rubric.' : 'Add a sample job to prepare its linked rubric, or explore reusable grade standards.'
            : 'This workspace has no reusable grade standards. Job rubrics are still available in the other view.'}
        action={query
          ? <Button onClick={() => setSearch('')}>Clear search</Button>
          : kind === 'job'
            ? <Button onClick={() => navigate('/jobs')}>Open jobs</Button>
            : <Button onClick={() => setParams({ kind: 'job', data: libraryKind }, { replace: true })}>View job rubrics</Button>}
      />}
      <div className="table-bottom"><span>{visible.length} {visible.length === 1 ? 'rubric' : 'rubrics'} in this view</span><span>Latest versions only · Previous versions are preserved</span></div>
      </>}
      {kind === 'grade' && libraryKind === 'real' && <GradeLadderLibrary search={search} />}
    </section>
    <div className="mt-5"><DemoNote>{cloud ? 'Real job and grade rubrics are private, source-grounded, and excluded from demo scoring. Samples remain fictional. Reset samples never changes real ladders or captured source history.' : 'Generated job rubrics and grade templates use fictional demo content. Every saved version remains inspectable, including the version used by a past analysis.'}</DemoNote></div>
  </>
}

function RubricDetail({ id }: { id: string }) {
  const { workspace, cloud } = useWorkspace()
  const navigate = useNavigate()
  const gradeLadders = useGradeLadders()
  const analyses = useRealAnalyses()
  const eligible = analyses?.canWrite && analyses.phase === 'ready' && analyses.features?.realAnalyses && analyses.targets.state === 'ready' && !analyses.targets.error ? analyses.targets.value : []
  const [params] = useSearchParams()
  const [sourceSelection, setSourceSelection] = useState<{ criterion: Criterion; citation?: Citation } | null>(null)
  const rubric = workspace.rubrics.find((item) => item.id === id)
  const job = workspace.jobs.find((item) => item.id === rubric?.jobId)
  const document = workspace.documents.find((item) => item.id === job?.documentId)
  const requestedJobId = params.get('job') ?? job?.id
  const realDetail = requestedJobId && cloud ? cloud.realJobs.detail(requestedJobId) : undefined

  useEffect(() => {
    if (requestedJobId && cloud) void cloud.realJobs.ensureDetail(requestedJobId)
  }, [cloud, requestedJobId])

  if (!rubric && requestedJobId && (realDetail?.state === 'idle' || realDetail?.state === 'loading')) return <>
    <Link className="back-link" to="/rubrics"><ArrowLeft size={14} aria-hidden="true" />Back to rubrics</Link>
    <PageHeader title="Loading rubric" description="Retrieving the server-authoritative source and immutable version history." />
    <section className="panel"><EmptyState icon={LoaderCircle} title="Loading rubric versions" description="Score is opening the real job detail without substituting sample content." /></section>
  </>

  if (!rubric) return <>
    <Link className="back-link" to="/rubrics"><ArrowLeft size={14} aria-hidden="true" />Back to rubrics</Link>
    <PageHeader title="Rubric unavailable" description="This rubric version could not be found in the current workspace." />
    <section className="panel"><EmptyState icon={Layers3} title="This rubric is no longer here" description="It may belong to a workspace that was reset. Open the library to inspect an available version." action={<Button onClick={() => navigate('/rubrics')}>Open rubric library</Button>} /></section>
  </>

  const versions = [...(rubric.dataKind === 'real' && realDetail?.state === 'ready'
    ? realDetail.value.rubricVersions
    : workspace.rubrics.filter((item) => item.groupId === rubric.groupId)
  )].sort((left, right) => right.version - left.version)
  const current = versions[0] ?? rubric
  const historic = rubric.id !== current.id || rubric.version !== current.version
  const selectedVersion = rubric.dataKind === 'real' ? rubric : current
  const realTarget = eligible.find((target) => target.rubricId === selectedVersion.id && target.rubricVersion === selectedVersion.version)
  const ready = rubricReady(selectedVersion, workspace, eligible)

  return <>
    <Link className="back-link" to={`/rubrics?kind=${rubric.kind}`}><ArrowLeft size={14} aria-hidden="true" />Back to rubrics</Link>
    <PageHeader
      eyebrow={rubric.kind === 'grade' ? 'REUSABLE GRADE STANDARD' : 'JOB-LINKED STANDARD'}
      title={rubric.name}
      description={rubric.kind === 'grade'
        ? 'A reusable set of expectations. Compare directly to this grade, with or without a job.'
        : 'A job-specific standard, with traceable source references and preserved version history.'}
      actions={<>{rubric.kind === 'job' && rubric.dataKind === 'real' && <Button icon={Layers3} disabled={!gradeLadders?.canWrite || gradeLadders.phase !== 'ready' || job?.status !== 'ready'}
        title={!gradeLadders?.canWrite ? 'Only an owner or editor in a grade-enabled workspace can create a ladder.' : 'Capture this exact saved job rubric version as a new GS family.'}
        onClick={() => navigate(`/grade-ladders/new?${new URLSearchParams({ job: job!.id, rubric: rubric.id, rubricVersion: String(rubric.version) })}`)}>Create grade ladder</Button>}
        <Button variant="primary" icon={ArrowRight} disabled={!ready} title={rubric.dataKind === 'real' ? 'Use this exact saved version in a separate real analysis; no newer version is substituted.' : undefined} onClick={() => {
          if (rubric.dataKind === 'real') {
            if (realTarget && analyses) {
              const link = realAnalysisLink({ targets: [realTarget.selection] }, analyses.workspaceId)
              navigate(link.to, { state: link.state })
            }
          }
          else navigate(analysisLink([current.id], Boolean(cloud)))
        }}>
        {historic && rubric.dataKind !== 'real' ? `Analyze with latest (v${current.version})` : 'Analyze with this rubric'}
      </Button></>}
    />
    <div className="detail-metadata">
      <Badge tone="accent">{rubric.kind === 'grade' ? 'Grade rubric' : 'Job rubric'}</Badge>
      {rubric.ladder && <span>{rubric.ladder}</span>}
      {(rubric.grade ?? job?.grade) && <span>{rubric.grade ?? job?.grade}</span>}
      <span>Version {rubric.version}</span>
      <span>Saved {dateLabel(rubric.createdAt)}</span>
    </div>
    {historic && <div className="info-callout mb-5">
      <Layers3 size={18} aria-hidden="true" />
      <div><strong>You’re inspecting a preserved version.</strong><p>Past results keep this version unchanged. To edit the rubric or start a new analysis, use <Link className="link-button" to={`/rubrics/${current.id}`}>version {current.version}</Link>.</p></div>
    </div>}
    {!ready && <div className="info-callout mb-5"><BriefcaseBusiness size={18} aria-hidden="true" /><div><strong>{rubric.dataKind === 'real' ? 'This exact version is not available for real analysis.' : 'This job rubric is not ready for analysis.'}</strong><p>{rubric.dataKind === 'real' ? 'Confirm real analysis availability and write access, or review the current eligible version. No newer version or sample score will be silently substituted.' : job ? 'Finish or retry the sample job import before starting a comparison.' : 'Its linked job is unavailable. Choose another rubric from the library.'}</p></div></div>}
    {rubric.dataKind === 'real' && realDetail?.state === 'error' && <div className="mb-5"><InlineError>{realDetail.error} <button className="ml-2 underline" onClick={() => requestedJobId && cloud && void cloud.realJobs.ensureDetail(requestedJobId, true)}>Retry loading</button></InlineError></div>}

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
      <section className="detail-panel">
        <RubricPanel
          key={rubric.id}
          rubric={rubric}
          readOnly={historic}
          onSelectCriterion={(criterion, citation) => setSourceSelection({ criterion, citation })}
          onVersionSaved={(savedId) => navigate(`/rubrics/${savedId}${job ? `?job=${encodeURIComponent(job.id)}` : ''}`)}
        />
      </section>
      <aside className="space-y-5" aria-label="Rubric context and versions">
        <section className="detail-panel">
          <div className="section-heading"><h2>Source &amp; context</h2><FileSearch size={16} className="text-muted" aria-hidden="true" /></div>
          <div className="space-y-4 p-5 text-[11px]">
            <dl className="space-y-4">
              <div><dt className="mb-1 text-[10px] text-muted">Type</dt><dd>{rubric.dataKind === 'real' ? rubric.provenance?.kind === 'edited' ? 'Reviewer edited · linked to a real job' : 'Generated from source · linked to a real job' : rubric.kind === 'grade' ? 'Reusable, independent grade rubric' : 'Generated demo · linked to a job'}</dd></div>
              {rubric.kind === 'grade' ? <>
                <div><dt className="mb-1 text-[10px] text-muted">Grade family</dt><dd>{rubric.ladder || 'Not specified'}</dd></div>
                <div><dt className="mb-1 text-[10px] text-muted">Grade</dt><dd>{rubric.grade || 'Not specified'}</dd></div>
              </> : <>
                <div><dt className="mb-1 text-[10px] text-muted">Linked job</dt><dd>{job ? <Link to={`/jobs/${job.id}`} className="link-button">{job.title}</Link> : 'Job unavailable'}</dd></div>
                <div><dt className="mb-1 text-[10px] text-muted">Source label</dt><dd className="break-words">{job?.sourceLabel || 'Source label unavailable'}</dd></div>
                <div><dt className="mb-1 text-[10px] text-muted">Reference content</dt><dd>{document ? document.sample ? 'Fictional sample document' : 'Actual private source document' : rubric.dataKind === 'real' && realDetail?.state === 'loading' ? 'Loading private source' : 'Source document unavailable'}</dd></div>
              </>}
            </dl>
            <div className="border-t pt-4"><DemoNote>{rubric.kind === 'grade'
              ? 'Compare resumes to this grade without selecting a job. Guidance is illustrative, not official qualification or eligibility advice.'
              : rubric.dataKind === 'real'
                ? 'Every criterion must cite an exact quotation from this parsed source. Saving appends a reviewer-edited version; it never overwrites prior versions.'
                : 'A source label does not mean its content was read. All source references lead to the fictional sample document.'}</DemoNote></div>
          </div>
        </section>
        <section className="detail-panel">
          <div className="section-heading"><div><h2>Version history</h2><p>Every save creates a new version</p></div></div>
          <nav className="max-h-64 overflow-y-auto p-3" aria-label="Rubric versions">
            {versions.map((version) => <Link
              key={version.id}
              to={rubricLink(version)}
              aria-current={version.id === rubric.id ? 'page' : undefined}
              className={`flex items-center justify-between gap-3 rounded-lg px-3 py-3 text-[11px] ${version.id === rubric.id ? 'bg-accent-soft text-accent' : 'hover:bg-soft'}`}
            >
              <span className="flex items-center gap-2"><span className="font-medium">Version {version.version}</span>{version.id === current.id && <Badge>Latest</Badge>}</span>
              <span className="text-[10px] text-muted">{dateLabel(version.createdAt)}</span>
            </Link>)}
          </nav>
          <p className="border-t px-5 py-3 text-[10px] text-muted">Edits never rewrite prior analysis results.</p>
        </section>
      </aside>
    </div>

    <Modal
      open={sourceSelection !== null}
      onOpenChange={(open) => { if (!open) setSourceSelection(null) }}
      title="Criterion source"
      description={rubric.dataKind === 'real' ? `Exact source evidence for ${sourceSelection?.criterion.label ?? 'this criterion'}.` : `Fictional job evidence for ${sourceSelection?.criterion.label ?? 'this criterion'}. This is sample text, not content extracted from the selected source.`}
      wide
      footer={<><Button onClick={() => setSourceSelection(null)}>Close source</Button>{job && <Button onClick={() => navigate(`/jobs/${job.id}`)}>Open linked job</Button>}</>}
    >
      {document
        ? <DocumentViewer document={document} highlightedId={sourceSelection?.citation?.paragraphId ?? sourceSelection?.criterion.sourceCitations?.[0]?.paragraphId ?? sourceSelection?.criterion.sourceParagraphId} quote={sourceSelection?.citation?.quote ?? sourceSelection?.criterion.sourceCitations?.[0]?.quote}
          pagination={realDetail?.state === 'ready' && realDetail.value.source.originalContentType === 'text/html' ? 'html-sections' : 'pdf-pages'} />
        : rubric.dataKind === 'real' && (realDetail?.state === 'idle' || realDetail?.state === 'loading')
          ? <EmptyState icon={LoaderCircle} title="Loading source document" description="Score is retrieving the parsed source and exact quotations." />
          : <EmptyState icon={FileSearch} title="Source document unavailable" description={rubric.dataKind === 'real' ? 'The server did not return the parsed source. Refresh this real job and try again.' : 'This sample document is missing from the workspace. Open another rubric to inspect its source.'} />}
    </Modal>
  </>
}

export function RubricsPage() {
  const { id } = useParams<{ id: string }>()
  const gradeLadders = useGradeLadders()
  const [params] = useSearchParams()
  const gradeVersion = id ? gradeLadders?.locateRubric(id) : undefined
  const gradeFamily = id ? gradeLadders?.summaries.find((family) => family.levels.some((level) => level.head.latestVersionId === id || level.head.approvedVersionId === id)) : undefined
  const gradeLevel = gradeFamily?.levels.find((level) => level.head.latestVersionId === id || level.head.approvedVersionId === id)
  const ladderId = gradeVersion?.ladderId ?? params.get('ladder') ?? gradeFamily?.ladder.id
  if (id && ladderId) return <Navigate replace to={gradeLadderLink(ladderId, gradeVersion?.grade ?? gradeLevel?.head.grade ?? (Number(params.get('grade')) || undefined), gradeVersion?.id ?? id)} />
  if (id?.startsWith('grade-version-') && gradeLadders?.phase === 'loading') return <EmptyState icon={LoaderCircle} title="Loading real grade identity" description="Resolving this immutable rubric version through its private grade family." />
  return id ? <RubricDetail key={id} id={id} /> : <RubricsLibrary />
}
