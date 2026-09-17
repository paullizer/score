import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BriefcaseBusiness, Check, Layers3, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { latestRubrics } from '../../domain/selectors'
import { Avatar, Badge, Button, DemoNote, EmptyState, InlineError, PageHeader, SearchField, SegmentedControl, StepLabel } from '../../components/ui'

function ids(value: string | null): string[] {
  return [...new Set((value ?? '').split(',').filter(Boolean))]
}

export function AnalysisSetup() {
  const { workspace, startAnalysis } = useWorkspace()
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
  const selectedRubrics = rubrics.filter((rubric) => targets.includes(rubric.id))
  const ready = (id: string) => {
    const rubric = rubrics.find((item) => item.id === id)
    return rubric && (rubric.kind === 'grade' || workspace.jobs.some((job) => job.rubricId === id && job.status === 'ready'))
  }
  const invalidResumes = resumes.filter((id) => !workspace.resumes.some((resume) => resume.id === id))
  const invalidTargets = targets.filter((id) => !ready(id))
  const hasInvalid = invalidResumes.length > 0 || invalidTargets.length > 0
  const shownResumes = workspace.resumes.filter((resume) => `${resume.name} ${resume.role}`.toLowerCase().includes(resumeSearch.toLowerCase()))
  const shownTargets = rubrics.filter((rubric) => rubric.kind === targetType && `${rubric.name} ${rubric.ladder ?? ''} ${rubric.grade ?? ''}`.toLowerCase().includes(targetSearch.toLowerCase()))
  const jobCount = selectedRubrics.filter((rubric) => rubric.kind === 'job').length
  const gradeCount = selectedRubrics.filter((rubric) => rubric.kind === 'grade').length
  const comparisonCount = resumes.length * targets.length
  function toggle(value: string, selected: string[], set: (value: string[]) => void) { set(selected.includes(value) ? selected.filter((id) => id !== value) : [...selected, value]) }
  function run() {
    setStarting(true)
    setError('')
    try {
      const id = startAnalysis(resumes, targets, name.trim() || undefined, failFirst)
      navigate(`/analyses/${id}`)
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught
      setError(caught.message)
      setStarting(false)
    }
  }
  return <>
    <Link className="back-link" to="/analyses"><ArrowLeft size={14} />Back to analyses</Link>
    <PageHeader eyebrow="FROM CRITERIA TO CLARITY" title="Build an analysis" description="Choose who to compare, and what a great match means." />
    {previous && <div className="info-callout mb-5"><Layers3 size={18} /><div><strong>A new run, not a rewrite.</strong><p>Selections from "{previous.name}" use the latest available rubric versions. The previous results stay exactly as they were.</p></div></div>}
    {params.get('from') && !previous && <div className="mb-5"><InlineError>The previous analysis is no longer available. Select fresh inputs below.</InlineError></div>}
    {hasInvalid && <div className="mb-5"><InlineError>Some requested inputs are missing, outdated, or not ready. They will not be silently skipped. <button className="ml-1 underline" onClick={() => { setResumes(resumes.filter((id) => !invalidResumes.includes(id))); setTargets(targets.filter((id) => !invalidTargets.includes(id))) }}>Remove unavailable selections</button></InlineError></div>}
    <div className="analysis-builder">
      <div className="space-y-5">
        <section className="panel">
          <div className="section-heading"><div><StepLabel number={1} complete={resumes.length > 0}>Choose your resumes</StepLabel><p>One person exploring roles, or a whole applicant pool.</p></div><Badge tone={resumes.length ? 'accent' : 'neutral'}>{resumes.length} selected</Badge></div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3"><SearchField value={resumeSearch} onChange={setResumeSearch} placeholder="Search people or experience..." />
            <button className="text-link" onClick={() => {
              const all = shownResumes.length > 0 && shownResumes.every((resume) => resumes.includes(resume.id))
              setResumes(all ? resumes.filter((id) => !shownResumes.some((resume) => resume.id === id)) : [...new Set([...resumes, ...shownResumes.map((resume) => resume.id)])])
            }}>{shownResumes.length > 0 && shownResumes.every((resume) => resumes.includes(resume.id)) ? 'Deselect visible' : 'Select visible'}</button></div>
          <div className="builder-options">
            {shownResumes.map((resume) => <label className="selection-card" key={resume.id}><input type="checkbox" checked={resumes.includes(resume.id)} onChange={() => toggle(resume.id, resumes, setResumes)} aria-label={`Include ${resume.name}`} /><Avatar initials={resume.initials} small /><div className="min-w-0"><strong className="block text-[12px] font-semibold">{resume.name}</strong><span className="mt-1 block text-[10px] text-muted">{resume.role}</span><span className="mt-1.5 block text-[9px] text-muted">{resume.experience} / fictional profile</span></div></label>)}
            {!shownResumes.length && <div className="col-span-full"><EmptyState title="No resumes to show" description="Adjust the search, or add sample resumes from the library." action={<Button onClick={() => navigate('/resumes')}>Open resumes</Button>} /></div>}
          </div>
        </section>
        <section className="panel">
          <div className="section-heading"><div><StepLabel number={2} complete={targets.length > 0}>Choose your criteria</StepLabel><p>Job rubrics, independent GS grades, or both.</p></div><Badge tone={targets.length ? 'accent' : 'neutral'}>{targets.length} selected</Badge></div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
            <SegmentedControl label="Target type" value={targetType} onChange={setTargetType} options={[{ value: 'job', label: 'Job rubrics', count: jobCount }, { value: 'grade', label: 'GS / grade rubrics', count: gradeCount }]} />
            <SearchField value={targetSearch} onChange={setTargetSearch} placeholder="Find a rubric..." />
          </div>
          <div className="builder-options">
            {shownTargets.map((rubric) => {
              const available = ready(rubric.id)
              const job = workspace.jobs.find((item) => item.id === rubric.jobId)
              return <label className="selection-card" key={rubric.id} title={available ? undefined : 'Finish this job import before analysis.'}>
                <input type="checkbox" disabled={!available} checked={targets.includes(rubric.id)} onChange={() => toggle(rubric.id, targets, setTargets)} aria-label={`Include ${rubric.name}`} />
                <span className="target-symbol">{rubric.kind === 'job' ? <BriefcaseBusiness size={16} /> : <Layers3 size={16} />}</span>
                <div className="min-w-0"><strong className="block text-[12px] font-semibold">{rubric.kind === 'job' ? job?.title ?? rubric.name : rubric.name}</strong><span className="mt-1 block text-[10px] text-muted">{rubric.kind === 'job' ? job?.organization : rubric.ladder}</span>
                  <div className="mt-2 flex flex-wrap gap-1.5"><Badge>{rubric.grade ?? job?.grade ?? 'Job-specific'}</Badge><Badge>{rubric.criteria.length} criteria / v{rubric.version}</Badge>{!available && <Badge tone="warning">Not ready</Badge>}</div></div>
              </label>
            })}
            {!shownTargets.length && <div className="col-span-full"><EmptyState title="No matching rubrics" description="Try another search or view the other target type." /></div>}
          </div>
          {targetType === 'grade' && <div className="border-t px-5 py-3"><DemoNote>These are reusable illustrative grade rubrics, not official OPM eligibility assessments. No job selection is required.</DemoNote></div>}
        </section>
      </div>
      <aside className="analysis-summary panel" aria-label="Analysis summary">
        <div className="section-heading"><StepLabel number={3}>Your analysis</StepLabel><Sparkles size={15} className="text-accent" /></div>
        <div className="space-y-5 p-5">
          <label className="field"><span className="field-label">Give it a name <span className="text-[10px] font-normal text-muted">(optional)</span></span><input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Program analyst review" /></label>
          <div className="space-y-3 border-y py-4"><div className="metric-line"><span className="flex items-center gap-2 text-muted"><Users size={14} />Resumes</span><strong>{resumes.length}</strong></div><div className="metric-line"><span className="flex items-center gap-2 text-muted"><BriefcaseBusiness size={14} />Job rubrics</span><strong>{jobCount}</strong></div><div className="metric-line"><span className="flex items-center gap-2 text-muted"><Layers3 size={14} />Grade rubrics</span><strong>{gradeCount}</strong></div></div>
          {selectedRubrics.length > 0 && <div><span className="field-label text-[10px] uppercase tracking-wider text-muted">Selected targets</span><div className="max-h-40 space-y-2 overflow-y-auto">{selectedRubrics.map((rubric) => <div key={rubric.id} className="flex items-center justify-between gap-2 text-[10px]"><span className="flex items-center gap-2"><Check size={12} className="shrink-0 text-accent" />{rubric.name}</span><button className="text-muted hover:text-accent" aria-label={`Remove ${rubric.name}`} onClick={() => setTargets(targets.filter((id) => id !== rubric.id))}>Remove</button></div>)}</div></div>}
          <div className="comparison-count"><strong>{comparisonCount}</strong><span>individual {comparisonCount === 1 ? 'comparison' : 'comparisons'}<small>One result per resume and rubric.</small></span></div>
          <p className="text-[11px] text-muted">Each criterion is scored from 0-5, with a weighted overall score out of 100. Different jobs and grades stay separate.</p>
          <details className="text-[10px] text-muted"><summary className="cursor-pointer">Demo scenario</summary><label className="check-label mt-3 text-[11px]"><input type="checkbox" checked={failFirst} onChange={(event) => setFailFirst(event.target.checked)} />Simulate one interrupted comparison</label></details>
          {error && <InlineError>{error}</InlineError>}
          <Button variant="primary" icon={ArrowRight} className="w-full" disabled={!resumes.length || !targets.length || hasInvalid || starting} onClick={run}>{starting ? 'Starting...' : 'Run sample analysis'}</Button>
          {(!resumes.length || !targets.length) && <p className="text-center text-[10px] text-muted">Select at least one resume and one rubric.</p>}
          <div className="flex items-start gap-2 text-[10px] text-muted"><ShieldCheck size={14} className="mt-0.5 shrink-0" /><p>Fictional content. Simulated scoring. Your selections stay on this device.</p></div>
        </div>
      </aside>
    </div>
  </>
}
