import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BriefcaseBusiness, Check, Layers3, LoaderCircle, RotateCcw, ShieldCheck, Users } from 'lucide-react'
import { useRealAnalyses } from '../../app/real-analyses-context'
import { useRealResumes } from '../../app/real-resumes-context'
import type { CreateRealAnalysisInput, RealAnalysisRunDetail, RealAnalysisTargetSummary } from '../../domain/real-analyses'
import type { RealResumeSummary } from '../../domain/real-resumes'
import { ANALYSIS_LIMITS } from '../../domain/real-analyses'
import { Badge, Button, EmptyState, InlineError, PageHeader, SearchField, SegmentedControl, StepLabel } from '../../components/ui'
import { readyRealResume, resumeName } from '../resumes/resumeImportUi'
import {
  currentRealTarget, initialRealSelections, newerSavedJobTarget, realResumeSelection, resumeSelectionIssue, targetIdentity, targetSelectionIssue,
  resolveRealAnalysisNavigation, targetVersionLabel, type SelectedRealResume, type SelectedRealTarget,
} from './realAnalysisUi'

export function RealAnalysisSetup() {
  const api = useRealAnalyses()
  const resumes = useRealResumes()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigation = resolveRealAnalysisNavigation(params, location.state, api?.workspaceId)
  const previousId = navigation.error ? null : navigation.params.get('from')
  const previous = previousId ? api?.detail(previousId) : undefined
  const ensure = api?.ensureDetail
  const [prepared, setPrepared] = useState(false)
  const available = !navigation.error && resumes?.phase === 'ready' && api?.phase === 'ready' && api.features?.realAnalyses && api.targets.state === 'ready'
    && (!previousId || previous?.state === 'ready')
  useEffect(() => { if (previousId && api?.phase === 'ready') void ensure?.(previousId) }, [api?.phase, ensure, previous?.state, previousId])
  useEffect(() => { if (available) setPrepared(true) }, [available])
  if (!api || !resumes) return <EmptyState title="Real analyses require a cloud workspace" description="The standalone preview only evaluates fictional fixtures. Real inputs are not sent to the sample scorer." />
  if (navigation.error) return <EmptyState title="Exact selections unavailable in this link" description={navigation.error}
    action={<><Link className="button button-secondary button-md" to="/resumes?data=real">Choose ready resumes again</Link><Link className="button button-secondary button-md" to="/analyses/new?data=real">Start a separate selection</Link></>} />
  if (!prepared && ((api.features && !api.features.realAnalyses) || api.creationError)) return <EmptyState title="New real analyses are currently unavailable"
    description={api.creationError ?? 'New-run source dependencies are not ready. Saved history and frozen evidence have separate availability; no samples are substituted.'}
    action={<><Link className="button button-secondary button-md" to="/analyses?data=real">Open saved analyses</Link><Button onClick={() => { void api.refresh(); void resumes.refresh() }}>Check new-run availability</Button></>} />
  if (!prepared && (api.phase === 'unavailable' || resumes.phase === 'unavailable')) return <EmptyState title="Real analysis inputs are unavailable" description={api.error ?? resumes.error ?? 'This deployment has not enabled real resume and analysis processing. No sample fallback is used.'}
    action={<Button onClick={() => { void api.refresh(); void resumes.refresh() }}>Check availability</Button>} />
  if (previousId && previous?.state === 'error') return <EmptyState title="The saved real run could not be opened" description={previous.error}
    action={<><Button onClick={() => void ensure?.(previousId, true)}>Retry saved inputs</Button><Link className="button button-secondary button-md" to="/analyses/new?data=real">Start a separate selection</Link></>} />
  if (!available && !prepared) return <EmptyState icon={api.error || resumes.error || api.targets.state === 'error' ? Layers3 : LoaderCircle}
    title={api.error || resumes.error || api.targets.state === 'error' ? 'Real selections could not be loaded' : 'Loading ready resumes and eligible real targets'}
    description={api.error ?? resumes.error ?? (api.targets.state === 'error' ? api.targets.error : 'Checking every server page for real job rubrics and exact approved GS versions. No cached-only or sample targets are substituted.')}
    action={<Button onClick={() => { void api.refresh(); void api.refreshTargets(); void resumes.refresh(); if (previousId) void ensure?.(previousId, true) }}>Retry selections</Button>} />
  return <RealAnalysisBuilder previous={previous?.state === 'ready' ? previous.value : undefined} params={navigation.params} fragment={location.hash} transferred={navigation.transferred} />
}

function RealAnalysisBuilder({ previous, params, fragment, transferred }: {
  previous?: RealAnalysisRunDetail; params: URLSearchParams; fragment: string; transferred: boolean
}) {
  const api = useRealAnalyses()!
  const resumeApi = useRealResumes()!
  const navigate = useNavigate()
  const currentTargets = api.targets.state === 'ready' ? api.targets.value : []
  const [draft, setDraft] = useState(() => initialRealSelections(params, resumeApi.summaries, currentTargets, previous, fragment))
  const [resumeSearch, setResumeSearch] = useState('')
  const [targetSearch, setTargetSearch] = useState('')
  const [targetType, setTargetType] = useState<'job' | 'grade'>(() => draft.targets.length && draft.targets.every((target) => target.selection?.kind === 'grade') ? 'grade' : 'job')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState<{ input: CreateRealAnalysisInput; key: string } | null>(null)
  const [starting, setStarting] = useState(false)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const ready = resumeApi.summaries.filter(readyRealResume)
  const shownResumes = resumeApi.summaries.filter((item) => [item.resume.name, item.resume.role, item.resume.sourceLabel].join(' ').toLocaleLowerCase().includes(resumeSearch.trim().toLocaleLowerCase()))
  const shownTargets = currentTargets.filter((target) => target.kind === targetType && `${target.label} ${target.sublabel}`.toLocaleLowerCase().includes(targetSearch.trim().toLocaleLowerCase()))
  const count = draft.resumes.length * draft.targets.length
  const limit = api.features?.analysisLimits.maxComparisons ?? ANALYSIS_LIMITS.maxComparisons
  const duplicateInputs = new Set(draft.resumes.map((item) => item.id)).size !== draft.resumes.length || new Set(draft.targets.map((item) => item.id)).size !== draft.targets.length
  const resumeIssues = draft.resumes.map((item) => resumeSelectionIssue(item, resumeApi.summaries))
  const targetIssues = draft.targets.map((item) => targetSelectionIssue(item, currentTargets))
  const invalid = draft.errors.length > 0 || duplicateInputs || resumeIssues.some(Boolean) || targetIssues.some(Boolean)
  const unavailable = !api.features?.realAnalyses || api.phase !== 'ready' || resumeApi.phase !== 'ready' || api.targets.state !== 'ready' || Boolean(api.targets.error)
  const locked = starting || Boolean(attempt)
  const jobs = draft.targets.filter((target) => target.selection?.kind === 'job').length
  const grades = draft.targets.filter((target) => target.selection?.kind === 'grade').length

  function selectResume(summary: RealResumeSummary, replace = false) {
    if (locked) return
    const choice: SelectedRealResume = { id: summary.resume.id, label: resumeName(summary), selection: realResumeSelection(summary) }
    setDraft((current) => ({ ...current, resumes: current.resumes.some((item) => item.id === choice.id)
      ? replace ? current.resumes.map((item) => item.id === choice.id ? choice : item) : current.resumes.filter((item) => item.id !== choice.id)
      : [...current.resumes, choice] }))
  }

  function selectTarget(target: RealAnalysisTargetSummary, replaceId?: string) {
    if (locked) return
    const choice: SelectedRealTarget = { id: targetIdentity(target.selection), label: target.label, selection: target.selection, summary: target }
    setDraft((current) => ({ ...current, targets: replaceId
      ? current.targets.map((item) => item.id === replaceId ? choice : item)
      : current.targets.some((item) => item.id === choice.id) ? current.targets.filter((item) => item.id !== choice.id) : [...current.targets, choice] }))
  }

  async function run() {
    if (inFlight.current || !api.canWrite || unavailable) return
    setError('')
    let request = attempt
    if (!request) {
      if (invalid || !draft.resumes.length || !draft.targets.length || count > limit) { setError('Review every selected input and the comparison limit before submitting. Nothing will be skipped.'); return }
      const input: CreateRealAnalysisInput = {
        name: name.trim() || 'Resume evidence review',
        resumes: draft.resumes.map((item) => { if (!item.selection) throw new Error('Missing exact resume selection.'); return item.selection }),
        targets: draft.targets.map((item) => { if (!item.selection) throw new Error('Missing exact target selection.'); return item.selection }),
      }
      request = { input, key: api.requestKey(input) }
      setAttempt(request)
    }
    inFlight.current = true
    setStarting(true)
    try {
      const result = await api.create(request.input, request.key)
      if (alive.current) navigate(`/analyses/${encodeURIComponent(result.run.id)}?data=real`)
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : 'The analysis request could not be acknowledged.')
    } finally {
      inFlight.current = false
      if (alive.current) setStarting(false)
    }
  }

  return <>
    <Link className="back-link" to="/analyses?data=real"><ArrowLeft size={14} aria-hidden="true" />Back to real analyses</Link>
    <PageHeader eyebrow="MANUAL, EVIDENCE-LED REVIEW" title="Build a real analysis" description="Select ready real resumes and exact saved job or approved GS targets. Nothing runs until you choose Run analysis."
      actions={<Button icon={RotateCcw} disabled={starting} onClick={() => { void api.refreshTargets(); void resumeApi.refresh() }}>Refresh available inputs</Button>} />
    {transferred && <div className="info-callout mb-5"><Layers3 size={18} aria-hidden="true" /><div><strong>All exact selections were transferred with this navigation.</strong>
      <p>The URL stays short; this history entry carries only IDs, versions, and hashes. A copied URL without that state cannot restore the selection. After you manually create a run, its saved-run link can be reopened normally.</p></div></div>}
    {previous && <div className="info-callout mb-5"><Layers3 size={18} aria-hidden="true" /><div><strong>A new run, with reviewable selections.</strong>
      <p>These are the saved inputs of “{previous.run.name}”, not silently updated versions. Eligible historical job rubrics stay selected; newer saved versions are identified separately below. Changed or unavailable inputs require explicit review. Retry on the old run always reuses its original snapshots.</p></div></div>}
    {unavailable && <div className="mb-5"><InlineError>{api.creationError ?? api.error ?? resumeApi.error ?? (api.targets.state === 'error' || api.targets.state === 'ready' ? api.targets.error : undefined) ?? 'Input availability is not confirmed. Refresh before submitting.'} Your selection has been kept.</InlineError></div>}
    {!api.canWrite && <div className="info-callout mb-5"><p>This workspace is read-only. Only an owner or editor can run, retry, or cancel an analysis.</p></div>}
    {(draft.errors.length > 0 || duplicateInputs) && <div className="mb-5"><InlineError>{draft.errors.map((message) => <p key={message}>{message}</p>)}
      {duplicateInputs && <p>The same resume or target was requested more than once. Remove duplicates explicitly; nothing is silently deduplicated.</p>}
      <Button size="sm" disabled={locked} onClick={() => setDraft({ resumes: [], targets: [], errors: [] })}>Clear requested selections</Button></InlineError></div>}
    <div className="analysis-builder">
      <div className="space-y-5">
        <section className="panel"><div className="section-heading"><div><StepLabel number={1} complete={draft.resumes.length > 0}>Choose ready real resumes</StepLabel><p>Missing profile metadata is not replaced by filenames.</p></div><Badge>{draft.resumes.length} selected</Badge></div>
          <div className="library-toolbar"><SearchField value={resumeSearch} onChange={setResumeSearch} placeholder="Search stated names, roles, or sources…" label="Search analysis resumes" />
            <Button size="sm" variant="ghost" disabled={locked || !shownResumes.some(readyRealResume)} onClick={() => {
              const visible = shownResumes.filter(readyRealResume)
              setDraft((current) => {
                const all = visible.every((item) => current.resumes.some((choice) => choice.id === item.resume.id))
                return { ...current, resumes: all ? current.resumes.filter((choice) => !visible.some((item) => item.resume.id === choice.id))
                  : [...current.resumes, ...visible.filter((item) => !current.resumes.some((choice) => choice.id === item.resume.id))
                    .map((item) => ({ id: item.resume.id, label: resumeName(item), selection: realResumeSelection(item) }))] }
              })
            }}>Toggle ready visible</Button></div>
          <div className="builder-options">
            {shownResumes.map((summary) => <label className="selection-card" key={summary.resume.id}>
              <input type="checkbox" checked={draft.resumes.some((item) => item.id === summary.resume.id)} disabled={locked || !readyRealResume(summary)}
                aria-label={`Include ${resumeName(summary)} from ${summary.source.displayName}`} onChange={() => selectResume(summary)} />
              <Users size={17} className="shrink-0 text-muted" aria-hidden="true" /><div className="min-w-0"><strong className="block text-[12px]">{resumeName(summary)}</strong>
                <span className="row-meta block">{summary.resume.role ?? 'Role not stated'}</span><span className="row-meta block break-all">{summary.source.displayName}</span>
                <div className="mt-2"><Badge tone={readyRealResume(summary) ? 'success' : 'warning'}>{summary.resume.status}{summary.documentRef ? ` · document v${summary.documentRef.documentVersion}` : ''}</Badge></div></div>
            </label>)}
            {!shownResumes.length && <div className="col-span-full"><EmptyState title="No real resumes to show" description="Import actual PDFs or public profile URLs and wait for ready status before selecting them."
              action={<Link className="button button-secondary button-md" to="/resumes?data=real">Open real resumes</Link>} /></div>}
          </div>
          <div className="border-t px-5 py-3 text-[11px] text-muted">{ready.length} ready · public profiles may be sparse · imports do not automatically run analyses</div>
        </section>
        <section className="panel"><div className="section-heading"><div><StepLabel number={2} complete={draft.targets.length > 0}>Choose exact real targets</StepLabel><p>All eligible saved job versions and approved GS targets, not only previously opened rubrics. Each selected version is a separate target.</p></div><Badge>{draft.targets.length} selected</Badge></div>
          <div className="library-toolbar"><SegmentedControl label="Real target type" value={targetType} onChange={setTargetType}
            options={[{ value: 'job', label: 'Real jobs', count: currentTargets.filter((target) => target.kind === 'job').length }, { value: 'grade', label: 'Approved GS versions', count: currentTargets.filter((target) => target.kind === 'grade').length }]} />
            <SearchField value={targetSearch} onChange={setTargetSearch} placeholder="Search eligible targets…" label="Search real analysis targets" /></div>
          <div className="builder-options">{shownTargets.map((target) => <label className="selection-card" key={target.id}>
            <input type="checkbox" checked={draft.targets.some((item) => item.id === targetIdentity(target.selection))} disabled={locked}
              aria-label={`Include ${target.label}, ${targetVersionLabel(target.selection)}`} onChange={() => selectTarget(target)} />
            <span className="target-symbol">{target.kind === 'job' ? <BriefcaseBusiness size={16} aria-hidden="true" /> : <Layers3 size={16} aria-hidden="true" />}</span>
            <div className="min-w-0"><strong className="block text-[12px]">{target.label}</strong><span className="row-meta block">{target.sublabel}</span>
              <div className="mt-2 flex flex-wrap gap-1.5"><Badge>{targetVersionLabel(target.selection)}</Badge><Badge>{target.criterionCount} criteria</Badge>
                {target.kind === 'grade' && target.newerDraftAvailable && <Badge tone="warning">Newer draft exists · not selected</Badge>}</div>
              {target.kind === 'grade' && <p className="mt-2 text-[10px] text-muted">Approved {target.approvedAt} · series {target.context.series} · {target.context.agency || 'Agency not stated'} · {target.context.supervision}. Context belongs to this approved capture, not the newer draft.</p>}
            </div>
          </label>)}
            {!shownTargets.length && <div className="col-span-full"><EmptyState title="No eligible targets in this view" description={targetType === 'grade'
              ? 'Only exact approved, supported GS versions are offered. Unapproved or incomplete drafts remain unavailable. Try another filter or review a real ladder.'
              : 'A real job and its saved rubric must be ready. Import or finish processing a job, then refresh available inputs.'} /></div>}
          </div>
        </section>
        {(draft.resumes.length > 0 || draft.targets.length > 0) && <section className="panel" aria-label="Review exact selected inputs">
          <div className="section-heading"><div><h2>Review your exact selection</h2><p>Unknown, mixed, or changed inputs block submission. Refresh never silently changes these selections.</p></div></div>
          <ul className="divide-y">{draft.resumes.map((choice, index) => {
            const issue = resumeIssues[index]
            const current = resumeApi.summaries.find((item) => item.resume.id === choice.id && readyRealResume(item))
            return <li key={`resume-${index}`} className="space-y-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-[12px]">{choice.label}</strong><Button size="sm" variant="ghost" disabled={locked} onClick={() => setDraft((value) => ({ ...value, resumes: value.resumes.filter((_, itemIndex) => itemIndex !== index) }))}>Remove resume</Button></div>
              <p className="break-all text-[10px] text-muted">{choice.id}{choice.selection ? ` · document v${choice.selection.documentVersion} · SHA-256 ${choice.selection.documentSha256}` : ''}</p>
              {issue ? <InlineError>{issue}{current && <Button className="mt-2" size="sm" disabled={locked} onClick={() => selectResume(current, true)}>Use current saved resume</Button>}</InlineError> : <Badge tone="success">Exact ready source selected</Badge>}
            </li>
          })}{draft.targets.map((choice, index) => {
            const issue = targetIssues[index]
            const current = choice.selection ? currentRealTarget(choice.selection, currentTargets) : undefined
            const newer = choice.selection ? newerSavedJobTarget(choice.selection, currentTargets) : undefined
            const currentAlreadySelected = current && currentTargetsSelectedElsewhere(current)
            const newerAlreadySelected = newer && currentTargetsSelectedElsewhere(newer)
            function currentTargetsSelectedElsewhere(target: RealAnalysisTargetSummary) {
              return draft.targets.some((item, itemIndex) => itemIndex !== index && item.id === targetIdentity(target.selection))
            }
            return <li key={`target-${index}`} className="space-y-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-[12px]">{choice.label}</strong><Button size="sm" variant="ghost" disabled={locked} onClick={() => setDraft((value) => ({ ...value, targets: value.targets.filter((_, itemIndex) => itemIndex !== index) }))}>Remove target</Button></div>
              {choice.selection && <><Badge>{targetVersionLabel(choice.selection)}</Badge><p className="break-all text-[10px] text-muted">{choice.selection.kind === 'job'
                ? `Rubric SHA-256 ${choice.selection.rubricHash} · document ${choice.selection.documentId} v${choice.selection.documentVersion}`
                : `Version ${choice.selection.versionId} · approval ${choice.selection.approvalId} · source set ${choice.selection.sourceSetId}`}</p></>}
              {issue ? <InlineError>{issue}{current && <Button className="mt-2" size="sm" disabled={locked || currentAlreadySelected}
                title={currentAlreadySelected ? 'The eligible replacement is already selected. Remove this unavailable selection explicitly.' : undefined}
                onClick={() => selectTarget(current, choice.id)}>Use current eligible version</Button>}</InlineError> : <Badge tone="success"><Check size={11} aria-hidden="true" />Exact eligible version selected</Badge>}
              {!issue && newer && <div className="space-y-2 text-[11px] text-muted"><p>A newer saved job rubric v{newer.rubricVersion} is available. This selection still uses v{choice.selection?.kind === 'job' ? choice.selection.rubricVersion : ''}; it has not been replaced.</p>
                {newerAlreadySelected ? <p>The newer version is also selected as a separate comparison target.</p>
                  : <Button size="sm" disabled={locked} onClick={() => selectTarget(newer, choice.id)}>Use newer saved version instead</Button>}</div>}
            </li>
          })}</ul>
        </section>}
      </div>
      <aside className="analysis-summary panel" aria-label="Real analysis summary">
        <div className="section-heading"><StepLabel number={3}>Review, then run</StepLabel></div>
        <div className="space-y-5 p-5">
          <label className="field"><span className="field-label">Analysis name (optional)</span><input className="input" value={name} maxLength={160} disabled={locked}
            onChange={(event) => setName(event.target.value)} placeholder="Resume evidence review" /></label>
          <div className="space-y-3 border-y py-4"><div className="metric-line"><span>Real resumes</span><strong>{draft.resumes.length}</strong></div><div className="metric-line"><span>Job rubrics</span><strong>{jobs}</strong></div><div className="metric-line"><span>Approved GS versions</span><strong>{grades}</strong></div></div>
          <div className="comparison-count" aria-live="polite"><strong>{count}</strong><span>individual comparisons<small>Maximum {limit}. No truncation.</small></span></div>
          {count > limit && <InlineError>{count} comparisons exceeds the {limit}-comparison limit. Remove resumes or targets explicitly before running.</InlineError>}
          <p className="text-[11px] text-muted">Each pair is independent. Saved documents, versions, approvals, and source sets are frozen. Criterion assessments use real evidence; limited coverage can withhold the total. There is no cross-job ranking.</p>
          {error && <InlineError>{error}</InlineError>}
          {attempt && !starting && <div className="space-y-3 text-[11px] text-muted"><p>Acceptance was not confirmed. A lost response can still represent a saved run. Retrying sends the same complete request and UUID; it never binds newer input versions.</p>
            <Button size="sm" disabled={starting} onClick={() => { setAttempt(null); setError(''); void api.refresh(); void api.refreshTargets() }}>Review selections before a different request</Button></div>}
          <Button variant="primary" icon={starting ? LoaderCircle : ArrowRight} className="w-full"
            disabled={starting || !api.canWrite || unavailable || (!attempt && (invalid || !draft.resumes.length || !draft.targets.length || count > limit))}
            onClick={() => void run()}>{starting ? 'Awaiting server acceptance…' : attempt ? 'Retry unchanged submission' : 'Run analysis'}</Button>
          <div className="flex items-start gap-2 text-[10px] text-muted"><ShieldCheck size={15} className="shrink-0" aria-hidden="true" /><p>Human review only. Evidence gaps are not proof of missing skills. GS qualifications stay unscored and are not official eligibility decisions.</p></div>
        </div>
      </aside>
    </div>
  </>
}
