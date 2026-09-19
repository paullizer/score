import { useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BriefcaseBusiness, Check, Layers3, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { latestRubrics } from '../../domain/selectors'
import { Avatar, Badge, Button, DemoNote, EmptyState, InlineError, PageHeader, SearchField, SegmentedControl, StepLabel } from '../../components/ui'
import { isEntityArchived, matchesArchiveFilter, type ArchiveFilter } from '../../domain/lifecycle'
import { ArchivedBadge, ArchiveStateFilter, LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { analysisDataMode, sampleDataLink } from '../../app/real-data-mode'
import { RealAnalysisSetup } from './RealAnalysisSetup'
import { DISPLAY_NAME_MAX_LENGTH, defaultAnalysisName, getDisplayName, normalizeDisplayName } from '../../domain/displayNames'
import type { Rubric } from '../../domain/types'

function ids(value: string | null): string[] {
  return [...new Set((value ?? '').split(',').filter(Boolean))]
}

export function AnalysisSetup() {
  const { workspace, cloud } = useWorkspace()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const mode = analysisDataMode(params, Boolean(cloud), workspace)
  if (mode === 'invalid') return <EmptyState title="Unknown analysis mode" description="Choose real analysis or the explicitly fictional Samples workflow." action={<Button onClick={() => navigate('/analyses/new')}>Start a new selection</Button>} />
  return <>
    {cloud && <div className="library-kind-switcher mb-5 rounded-xl border"><SegmentedControl label="Choose real analysis or samples" value={mode}
      onChange={(value) => navigate(`/analyses/new?data=${value}`)} options={[{ value: 'real', label: 'Real analysis' }, { value: 'samples', label: 'Samples' }]} />
      <span>Real and sample inputs never mix. Changing this mode starts a separate selection.</span></div>}
    {mode === 'real' ? <RealAnalysisSetup key={`${location.key}:${location.search}:${location.hash}`} /> : <SampleAnalysisSetup />}
  </>
}

function SampleAnalysisSetup() {
  const { workspace, startAnalysis, cloud } = useWorkspace()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const rubrics = latestRubrics(workspace)
  const previous = workspace.runs.find((run) => run.id === params.get('from'))
  const [resumes, setResumes] = useState(() => previous ? previous.resumes.map(({ resume }) => resume.id) : ids(params.get('resumes')))
  const [targets, setTargets] = useState(() => previous ? previous.targets.map((target) => rubrics.find((rubric) => rubric.groupId === target.rubric.groupId)?.id ?? target.id) : ids(params.get('rubrics')))
  const [targetType, setTargetType] = useState<'job' | 'grade'>(() => targets.length && targets.every((id) => rubrics.find((rubric) => rubric.id === id)?.kind === 'grade') ? 'grade' : 'job')
  const [resumeSearch, setResumeSearch] = useState('')
  const [targetSearch, setTargetSearch] = useState('')
  const [name, setName] = useState('')
  const [failFirst, setFailFirst] = useState(false)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [resumeArchiveFilter, setResumeArchiveFilter] = useState<ArchiveFilter>('default')
  const [targetArchiveFilter, setTargetArchiveFilter] = useState<ArchiveFilter>('default')
  const { canEdit } = useLifecycleAccess()
  const selectedRubrics = rubrics.filter((rubric) => targets.includes(rubric.id))
  function targetLabel(rubric: Rubric) {
    const job = rubric.kind === 'job' ? workspace.jobs.find((item) => item.id === rubric.jobId) : undefined
    return job ? getDisplayName(job, job.title) : rubric.name
  }
  const suggestedName = defaultAnalysisName(resumes.length, selectedRubrics.map(targetLabel))
  const ready = (id: string) => {
    const rubric = rubrics.find((item) => item.id === id)
    return canEdit && rubric && rubric.dataKind !== 'real' && !isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId }) &&
      (rubric.kind === 'grade' || workspace.jobs.some((job) => job.rubricId === id && job.status === 'ready' && !job.rubricDeletedAt && job.dataKind !== 'real' && !isEntityArchived(workspace, { kind: 'job', id: job.id })))
  }
  const resumeReady = (id: string) => canEdit && workspace.resumes.some((resume) => resume.id === id) && !isEntityArchived(workspace, { kind: 'resume', id })
  const invalidResumes = resumes.filter((id) => !resumeReady(id))
  const invalidTargets = targets.filter((id) => !ready(id))
  const realTargets = targets.filter((id) => id.startsWith('grade-version-') || workspace.rubrics.some((rubric) => rubric.id === id && rubric.dataKind === 'real'))
  const realPreselection = ['resumeSelections', 'targetSelections', 'selectionTransfer', 'selectionTransport', 'jobs', 'job', 'targets', 'ladder'].some((key) => params.has(key))
  const hasInvalid = invalidResumes.length > 0 || invalidTargets.length > 0 || realPreselection
  const shownResumes = workspace.resumes.filter((resume) => matchesArchiveFilter(isEntityArchived(workspace, { kind: 'resume', id: resume.id }), resumeSearch, resumeArchiveFilter) && `${getDisplayName(resume, resume.name)} ${resume.name} ${resume.role} ${resume.sourceLabel}`.toLowerCase().includes(resumeSearch.trim().toLowerCase()))
  const eligibleResumes = shownResumes.filter((resume) => resumeReady(resume.id))
  const shownTargets = rubrics.filter((rubric) => matchesArchiveFilter(isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId }), targetSearch, targetArchiveFilter) && rubric.kind === targetType && `${targetLabel(rubric)} ${rubric.name} ${workspace.jobs.find((job) => job.id === rubric.jobId)?.title ?? ''} ${rubric.ladder ?? ''} ${rubric.grade ?? ''}`.toLowerCase().includes(targetSearch.trim().toLowerCase()))
  const jobCount = selectedRubrics.filter((rubric) => rubric.kind === 'job').length
  const gradeCount = selectedRubrics.filter((rubric) => rubric.kind === 'grade').length
  const comparisonCount = resumes.length * targets.length
  function toggle(value: string, selected: string[], set: (value: string[]) => void) { set(selected.includes(value) ? selected.filter((id) => id !== value) : [...selected, value]) }
  function run() {
    if (!canEdit || hasInvalid || (previous && isEntityArchived(workspace, { kind: 'analysis', id: previous.id }))) { setError('Archived or unavailable inputs cannot start a new analysis. Choose active inputs in an active workspace.'); return }
    setStarting(true)
    setError('')
    try {
      const id = startAnalysis(resumes, targets, name.trim() ? normalizeDisplayName(name) : suggestedName, failFirst)
      navigate(sampleDataLink(`/analyses/${id}`, Boolean(cloud)))
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught
      setError(caught.message)
      setStarting(false)
    }
  }
  return <>
    <Link className="back-link" to={sampleDataLink('/analyses', Boolean(cloud))}><ArrowLeft size={14} />Back to analyses</Link>
    <PageHeader eyebrow="FROM CRITERIA TO CLARITY" title="Build an analysis" description="Choose who to compare, and what a great match means." />
    <LifecycleBanner />
    {previous && isEntityArchived(workspace, { kind: 'analysis', id: previous.id }) && <InlineError>This archived analysis is read-only. Unarchive it before creating a run from its selections, or choose active inputs in a fresh analysis.</InlineError>}
    {previous && <div className="info-callout mb-5"><Layers3 size={18} /><div><strong>A new run, not a rewrite.</strong><p>Selections from "{getDisplayName(previous, previous.name)}" use the latest available rubric versions. The previous results stay exactly as they were.</p></div></div>}
    {params.get('from') && !previous && <div className="mb-5"><InlineError>The previous analysis is no longer available. Select fresh inputs below.</InlineError></div>}
    {hasInvalid && <div className="mb-5"><InlineError>{realTargets.length || realPreselection ? 'Real inputs were directly requested. Real-only and mixed real/sample selections cannot use the demo scorer. No inputs will be silently skipped.' : 'Some requested inputs are archived, missing, outdated, or not ready. They will not be silently skipped.'} <button className="ml-1 underline" onClick={() => {
      if (realPreselection) navigate(sampleDataLink('/analyses/new', Boolean(cloud)))
      else { setResumes(resumes.filter((id) => !invalidResumes.includes(id))); setTargets(targets.filter((id) => !invalidTargets.includes(id))) }
    }}>Remove unavailable selections</button></InlineError></div>}
    <div className="analysis-builder">
      <div className="space-y-5">
        <section className="panel">
          <div className="section-heading"><div><StepLabel number={1} complete={resumes.length > 0}>Choose your resumes</StepLabel><p>One person exploring roles, or a whole applicant pool.</p></div><Badge tone={resumes.length ? 'accent' : 'neutral'}>{resumes.length} selected</Badge></div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3"><SearchField value={resumeSearch} onChange={setResumeSearch} placeholder="Search people or experience..." />
            <ArchiveStateFilter value={resumeArchiveFilter} onChange={setResumeArchiveFilter} label="Resume input archive state" />
            <button className="text-link" disabled={!eligibleResumes.length} onClick={() => {
              const all = eligibleResumes.length > 0 && eligibleResumes.every((resume) => resumes.includes(resume.id))
              setResumes(all ? resumes.filter((id) => !eligibleResumes.some((resume) => resume.id === id)) : [...new Set([...resumes, ...eligibleResumes.map((resume) => resume.id)])])
            }}>{eligibleResumes.length > 0 && eligibleResumes.every((resume) => resumes.includes(resume.id)) ? 'Deselect visible' : 'Select visible'}</button></div>
          <div className="builder-options">
            {shownResumes.map((resume) => <label className="selection-card" key={resume.id}><input type="checkbox" checked={resumes.includes(resume.id)} disabled={!resumeReady(resume.id)} onChange={() => toggle(resume.id, resumes, setResumes)} aria-label={`Include ${getDisplayName(resume, resume.name)}`} /><Avatar initials={resume.initials} small /><div className="min-w-0"><strong className="block break-words text-[12px] font-semibold">{getDisplayName(resume, resume.name)}</strong>{resume.displayName && <span className="row-meta block">Source name: {resume.name}</span>}<ArchivedBadge target={{ kind: 'resume', id: resume.id }} /><span className="mt-1 block text-[10px] text-muted">{resume.role}</span><span className="row-meta block break-words">{resume.sourceLabel}</span><span className="mt-1.5 block text-[9px] text-muted">{resume.experience} / fictional profile</span></div></label>)}
            {!shownResumes.length && <div className="col-span-full"><EmptyState title="No resumes to show" description="Adjust the search, or add sample resumes from the library." action={<Button onClick={() => navigate(sampleDataLink('/resumes', Boolean(cloud)))}>Open resumes</Button>} /></div>}
          </div>
        </section>
        <section className="panel">
          <div className="section-heading"><div><StepLabel number={2} complete={targets.length > 0}>Choose your criteria</StepLabel><p>Job rubrics, independent GS grades, or both.</p></div><Badge tone={targets.length ? 'accent' : 'neutral'}>{targets.length} selected</Badge></div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
            <SegmentedControl label="Target type" value={targetType} onChange={setTargetType} options={[{ value: 'job', label: 'Job rubrics', count: jobCount }, { value: 'grade', label: 'GS / grade rubrics', count: gradeCount }]} />
            <SearchField value={targetSearch} onChange={setTargetSearch} placeholder="Find a rubric..." />
            <ArchiveStateFilter value={targetArchiveFilter} onChange={setTargetArchiveFilter} label="Rubric input archive state" />
          </div>
          <div className="builder-options">
            {shownTargets.map((rubric) => {
              const available = ready(rubric.id)
              const job = workspace.jobs.find((item) => item.id === rubric.jobId)
              return <label className="selection-card" key={rubric.id} title={available ? undefined : rubric.dataKind === 'real' ? 'Real job and GS grade rubrics cannot use the fixture scorer.' : 'Finish this job import before analysis.'}>
                <input type="checkbox" disabled={!available} checked={targets.includes(rubric.id)} onChange={() => toggle(rubric.id, targets, setTargets)} aria-label={`Include ${targetLabel(rubric)}`} />
                <span className="target-symbol">{rubric.kind === 'job' ? <BriefcaseBusiness size={16} /> : <Layers3 size={16} />}</span>
                <div className="min-w-0"><strong className="block break-words text-[12px] font-semibold">{targetLabel(rubric)}</strong>{job?.displayName && <span className="row-meta block">Source title: {job.title} · {job.sourceLabel}</span>}<span className="mt-1 block text-[10px] text-muted">{rubric.kind === 'job' ? job?.organization : rubric.ladder}</span>
                  <div className="mt-2 flex flex-wrap gap-1.5"><Badge>{rubric.grade ?? job?.grade ?? 'Job-specific'}</Badge><ArchivedBadge target={{ kind: 'rubric', id: rubric.groupId }} /><Badge>{rubric.criteria.length} criteria / v{rubric.version}</Badge>{rubric.dataKind === 'real' ? <Badge tone="warning">Demo scoring disabled</Badge> : !available && <Badge tone="warning">Not ready</Badge>}</div></div>
              </label>
            })}
            {!shownTargets.length && <div className="col-span-full"><EmptyState title="No matching rubrics" description="Try another search or view the other target type." /></div>}
          </div>
          {targetType === 'grade' && <div className="border-t px-5 py-3"><DemoNote>Only fictional sample grade rubrics can be selected here. Use Real analysis for ready real resumes and approved GS versions; real-only and mixed inputs cannot use the sample scorer. Samples are not official OPM eligibility assessments.</DemoNote></div>}
          {targetType === 'job' && shownTargets.some((rubric) => rubric.dataKind === 'real') && <div className="border-t px-5 py-3"><DemoNote>Real job rubrics are shown for transparency but cannot be selected. This analysis uses only fictional fixture scoring.</DemoNote></div>}
        </section>
      </div>
      <aside className="analysis-summary panel" aria-label="Analysis summary">
        <div className="section-heading"><StepLabel number={3}>Your analysis</StepLabel><Sparkles size={15} className="text-accent" /></div>
        <div className="space-y-5 p-5">
          <label className="field"><span className="field-label">Give it a name <span className="text-[10px] font-normal text-muted">(optional)</span></span><input className="input" value={name} maxLength={DISPLAY_NAME_MAX_LENGTH} disabled={starting || !canEdit} onChange={(event) => setName(event.target.value)} placeholder={suggestedName} /></label>
          <p className="break-words text-[11px] text-muted">Leave blank to use “{suggestedName}”. Your own name will not change when selections change.</p>
          <div className="space-y-3 border-y py-4"><div className="metric-line"><span className="flex items-center gap-2 text-muted"><Users size={14} />Resumes</span><strong>{resumes.length}</strong></div><div className="metric-line"><span className="flex items-center gap-2 text-muted"><BriefcaseBusiness size={14} />Job rubrics</span><strong>{jobCount}</strong></div><div className="metric-line"><span className="flex items-center gap-2 text-muted"><Layers3 size={14} />Grade rubrics</span><strong>{gradeCount}</strong></div></div>
          {selectedRubrics.length > 0 && <div><span className="field-label text-[10px] uppercase tracking-wider text-muted">Selected targets</span><div className="max-h-40 space-y-2 overflow-y-auto">{selectedRubrics.map((rubric) => <div key={rubric.id} className="flex items-center justify-between gap-2 text-[10px]"><span className="flex min-w-0 items-center gap-2 break-words"><Check size={12} className="shrink-0 text-accent" />{targetLabel(rubric)}</span><button className="text-muted hover:text-accent" aria-label={`Remove ${targetLabel(rubric)}`} onClick={() => setTargets(targets.filter((id) => id !== rubric.id))}>Remove</button></div>)}</div></div>}
          <div className="comparison-count"><strong>{comparisonCount}</strong><span>individual {comparisonCount === 1 ? 'comparison' : 'comparisons'}<small>One result per resume and rubric.</small></span></div>
          <p className="text-[11px] text-muted">Each criterion is scored from 0-5, with a weighted overall score out of 100. Different jobs and grades stay separate.</p>
          <details className="text-[10px] text-muted"><summary className="cursor-pointer">Demo scenario</summary><label className="check-label mt-3 text-[11px]"><input type="checkbox" checked={failFirst} onChange={(event) => setFailFirst(event.target.checked)} />Simulate one interrupted comparison</label></details>
          {error && <InlineError>{error}</InlineError>}
          <Button variant="primary" icon={ArrowRight} className="w-full" disabled={!canEdit || !resumes.length || !targets.length || hasInvalid || starting || Boolean(previous && isEntityArchived(workspace, { kind: 'analysis', id: previous.id }))} onClick={run}>{starting ? 'Starting...' : 'Run sample analysis'}</Button>
          {(!resumes.length || !targets.length) && <p className="text-center text-[10px] text-muted">Select at least one resume and one rubric.</p>}
          <div className="flex items-start gap-2 text-[10px] text-muted"><ShieldCheck size={14} className="mt-0.5 shrink-0" /><p>Fictional content. Simulated scoring. {cloud ? 'Your selections are saved to this cloud workspace.' : 'Your selections stay on this device.'}</p></div>
        </div>
      </aside>
    </div>
  </>
}
