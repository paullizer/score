import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ClipboardCheck, GitBranch, History, Layers3, LayoutGrid, RefreshCw, Settings } from 'lucide-react'
import type { CloudUser, WorkspaceSummary } from '../../../domain/cloud'
import { QC_PROMPT_FAMILIES } from '../../../domain/quality-improvement'
import { qcIdentifier } from '../../../domain/quality-control'
import type { PipelineDetail } from '../../../domain/quality-pipeline'
import { workspaceCanReview, workspaceQcRole } from '../../../domain/workspace-permissions'
import { AccessSuspendedContext } from '../../../app/access-suspended-context'
import { ThemeControl } from '../../../app/ThemeControl'
import { useAiTerminology, usePublicSettings } from '../../../app/public-settings-context'
import { Badge, Button, InlineError } from '../../../components/ui'
import { workspaceAccessStamp } from '../../../services/cloudWorkspace'
import { readPromptRelease, type PromptReleaseStatus } from '../../../services/adminSettings'
import { listPipelinePlans, readPipelinePlan } from '../../../services/qualityPipeline'
import { qcAccessLost, qcError, qcReviewLink } from '../../qc/qc-ui'
import { RelationshipMap } from './RelationshipMap'
import { isPipelineNode, PIPELINE_NODES, pipelineNextStep, savedPipelineEdges, TASK_LABELS, type PipelineNodeId } from './pipeline-map'
import '../../../styles/quality-pipeline.css'

interface PipelineLocation {
  workspaceId: string
  planId: string
  node: PipelineNodeId | null
  focused: boolean
  error: string
}
function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}
function readLocation(): PipelineLocation {
  const query = new URLSearchParams(window.location.search)
  const workspaceId = query.get('workspace') ?? '', planId = query.get('plan') ?? '', node = query.get('node')
  const valid = (!workspaceId || qcIdentifier.safeParse(workspaceId).success) && (!planId || qcIdentifier.safeParse(planId).success) &&
    (!node || isPipelineNode(node))
  return {
    workspaceId: valid ? workspaceId : '', planId: valid ? planId : '', node: isPipelineNode(node) ? node : null,
    focused: query.get('focus') === '1', error: valid ? '' : 'This pipeline link contains an invalid scope. Choose a workspace and saved plan below.',
  }
}

function usePipelineRead<T>(scope: string, load: ((signal: AbortSignal) => Promise<T>) | null, revision: number, revoke: (message: string) => void) {
  const [state, setState] = useState<{ scope: string; value: T | null; loading: boolean; error: string; loadedAt: string | null }>({
    scope, value: null, loading: Boolean(load), error: '', loadedAt: null,
  })
  useEffect(() => {
    if (!load) return
    const controller = new AbortController()
    setState(previous => ({
      scope, value: previous.scope === scope ? previous.value : null, loading: true, error: '',
      loadedAt: previous.scope === scope ? previous.loadedAt : null,
    }))
    void load(controller.signal).then(value => {
      if (!controller.signal.aborted) setState({ scope, value, loading: false, error: '', loadedAt: new Date().toISOString() })
    }, caught => {
      if (controller.signal.aborted) return
      const lost = qcAccessLost(caught), error = qcError(caught)
      setState(previous => ({ ...previous, scope, value: lost ? null : previous.value, loading: false, error }))
      if (lost) revoke(error)
    })
    return () => controller.abort()
  }, [scope, load, revision, revoke])
  return load && state.scope === scope ? state : { value: null, loading: Boolean(load), error: '', loadedAt: null }
}

export function QualityPipelinePage({ user, workspaces, directoryReady, directoryError, onRefreshDirectory, onLeave, onOpenSettings }: {
  user: CloudUser; workspaces: WorkspaceSummary[]; directoryReady: boolean; directoryError: string | null
  onRefreshDirectory: () => Promise<void>; onLeave: () => void; onOpenSettings: () => Promise<void>
}) {
  const suspended = useContext(AccessSuspendedContext)
  const policy = usePublicSettings()
  const [location, setLocation] = useState(readLocation)
  const [navigationError, setNavigationError] = useState('')
  useEffect(() => {
    const update = () => setLocation(readLocation())
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  function change(patch: Partial<PipelineLocation>) {
    const next = { ...location, ...patch, error: '' }
    const query = new URLSearchParams()
    const theme = new URLSearchParams(window.location.search).get('scoutTheme')
    if (theme === 'light' || theme === 'dark') query.set('scoutTheme', theme)
    if (next.workspaceId) query.set('workspace', next.workspaceId)
    if (next.planId) query.set('plan', next.planId)
    if (next.node) query.set('node', next.node)
    if (next.focused) query.set('focus', '1')
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query.size ? `?${query}` : ''}`)
    setLocation(next)
  }
  const workspace = workspaces.find(item => item.id === location.workspaceId && !item.deletedAt)
  return <div className="pipeline-app">
    <a className="skip-link" href="#pipeline-main">Skip to quality pipeline</a>
    <aside className="pipeline-sidebar">
      <a href="/" className="brand" onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onLeave() } }}>
        <span className="brand-mark"><Layers3 size={22} /></span><span>{policy.settings?.appearance.applicationTitle ?? 'Score'}</span>
      </a>
      <nav aria-label="Application administration">
        <Button variant="ghost" icon={LayoutGrid} onClick={onLeave}>All workspaces</Button>
        <Button variant="ghost" icon={Settings} onClick={() => void onOpenSettings().catch(error => setNavigationError(qcError(error)))}>Application settings</Button>
        <span className="nav-item is-active" aria-current="page"><GitBranch size={18} />Quality pipeline</span>
      </nav>
      {workspace && <nav aria-label="Workspace quality control">
        <a className="nav-item" href={workspaceLink(workspace.id, '/qc')}><ClipboardCheck size={18} />Reviews</a>
        <a className="nav-item" href={workspaceLink(workspace.id, '/qc/improvements')}><GitBranch size={18} />Quality improvement</a>
        <a className="nav-item" href={workspaceLink(workspace.id, '/qc/prompts')}><History size={18} />Prompt versions</a>
      </nav>}
      <div className="mt-8"><ThemeControl /></div>
    </aside>
    <main id="pipeline-main" className="pipeline-main">
      <div className="pipeline-mobile-home"><Button icon={ArrowLeft} onClick={onLeave}>All workspaces</Button><ThemeControl /></div>
      <header><h1>Quality pipeline</h1><p>Follow saved evidence and human QC to evaluated guidance and future tasks.</p></header>
      {navigationError && <InlineError>{navigationError}</InlineError>}
      {location.error && <InlineError>{location.error}</InlineError>}
      <div className="pipeline-controls"><label>Workspace
        <select aria-label="Pipeline workspace" value={location.workspaceId} disabled={!directoryReady || suspended}
          onChange={event => change({ workspaceId: event.target.value, planId: '', focused: false })}>
          <option value="">{directoryReady ? 'Choose a workspace' : 'Loading workspace access...'}</option>
          {location.workspaceId && !workspace && <option value={location.workspaceId}>Workspace unavailable</option>}
          {workspaces.filter(item => !item.deletedAt).map(item => <option key={item.id} value={item.id}>{item.name}{item.archivedAt ? ' (archived)' : ''}</option>)}
        </select>
      </label></div>
      {directoryError && <InlineError>{directoryError}</InlineError>}
      {directoryReady && location.workspaceId && !workspace && <InlineError>This workspace is unavailable to your account. Choose another workspace or refresh access.</InlineError>}
      {!suspended && <PipelineWorkspace key={JSON.stringify([user.tenantId, user.id, workspaceAccessStamp(workspace)])}
        workspace={workspace} location={location} change={change} refreshAccess={onRefreshDirectory} />}
    </main>
  </div>
}

function PipelineWorkspace({ workspace, location, change, refreshAccess }: {
  workspace?: WorkspaceSummary; location: PipelineLocation; change: (patch: Partial<PipelineLocation>) => void
  refreshAccess: () => Promise<void>
}) {
  const terms = useAiTerminology()
  const policy = usePublicSettings()
  const [revision, setRevision] = useState(0)
  const [cursor, setCursor] = useState<string>()
  const [accessError, setAccessError] = useState('')
  const revoke = useCallback((message: string) => setAccessError(message), [])
  const canRead = Boolean(workspace && workspaceCanReview(workspaceQcRole(workspace), true) && !accessError)
  const loadPlans = useCallback((signal: AbortSignal) => listPipelinePlans(workspace!.id, cursor, signal), [workspace, cursor])
  const loadDetail = useCallback((signal: AbortSignal) => readPipelinePlan(workspace!.id, location.planId, signal), [workspace, location.planId])
  const loadRelease = useCallback((signal: AbortSignal) => readPromptRelease(signal), [])
  const plans = usePipelineRead(`plans:${workspace?.id}:${cursor ?? ''}`, canRead ? loadPlans : null, revision, revoke)
  const selected = usePipelineRead(`plan:${workspace?.id}:${location.planId}`, canRead && location.planId ? loadDetail : null, revision, revoke)
  const release = usePipelineRead('current-prompts', accessError ? null : loadRelease, revision, revoke)
  const detail = selected.value
  const busy = plans.loading || selected.loading || release.loading
  const savedEdges = useMemo(() => savedPipelineEdges(detail, release.value?.activeBundleId), [detail, release.value])
  const metadata = useMemo<Partial<Record<PipelineNodeId, string>>>(() => {
    const current = release.value
    if (!detail) return current ? { active: current.activeBundleId ? 'Current pointer recorded' : 'Not initialized' } : {}
    return {
      results: counted(detail.cases.length, 'pinned result'),
      feedback: counted(detail.cases.reduce((count, item) => count + item.includedReviews, 0), 'included review'),
      curate: `Saved plan revision ${detail.plan.revision}`, pack: 'Immutable capture',
      candidate: detail.candidate ? 'Evaluated snapshot recorded' : detail.changedFamilies.length ? 'Proposal saved; not active' : 'No proposal saved',
      tasks: counted(detail.changedFamilies.length, 'changed family', 'changed families'),
      settings: 'Accepted settings captured',
      holdout: counted(detail.cases.filter(item => item.purpose === 'holdout').length, 'selected case'),
      evaluation: detail.evaluation ? counted(detail.evaluation.trials, 'saved trial pair') : detail.work?.kind === 'evaluation' ? detail.work.status : 'No completed evaluation recorded',
      checks: 'Not editable through QC',
      activate: detail.activatedBundleId ? 'Activation recorded' : 'No activation recorded',
      active: current ? current.activeBundleId ? detail.activatedBundleId === current.activeBundleId ? 'Selected publication is current' : 'Current pointer is separate' : 'Not initialized' : 'Current status unavailable',
      future: 'Defaults only; no automatic work',
    }
  }, [detail, release.value])
  async function checkAccess() {
    try { await refreshAccess(); setAccessError(''); setRevision(value => value + 1) }
    catch (error) { setAccessError(qcError(error)) }
  }
  const errors = [plans.error, selected.error, release.error].filter(Boolean)
  return <>
    {workspace && !workspaceCanReview(workspaceQcRole(workspace), true) && <InlineError>QC metadata requires explicit membership in this workspace. Application-admin access alone does not grant private QC access.</InlineError>}
    {accessError && <InlineError>{accessError} Saved metadata has been cleared.</InlineError>}
    <div className="pipeline-controls">
      <label className="pipeline-plan-picker">Follow an improvement plan
        <select aria-label="Follow an improvement plan" value={location.planId} disabled={!canRead || plans.loading}
          onChange={event => change({ planId: event.target.value, focused: false })}>
          <option value="">No plan selected</option>
          {location.planId && !plans.value?.items.some(item => item.id === location.planId) &&
            <option value={location.planId}>{detail?.plan.name ?? 'Selected saved plan'}</option>}
          {plans.value?.items.map(plan => <option key={plan.id} value={plan.id}>{plan.name} (revision {plan.revision} / {plan.status})</option>)}
        </select>
      </label>
      <Button icon={RefreshCw} disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh pipeline</Button>
      <Button disabled={busy} onClick={() => void checkAccess()}>Refresh access</Button>
      {cursor && <Button disabled={busy} onClick={() => setCursor(undefined)}>First plans</Button>}
      {plans.value?.continuationToken && <Button disabled={busy} onClick={() => setCursor(plans.value?.continuationToken)}>More plans</Button>}
    </div>
    {busy && <p role="status">Reading saved pipeline metadata. No model work is started.</p>}
    {errors.length > 0 && <InlineError>{errors.join(' ')} {detail && 'Showing the last successful saved path; it may be out of date.'} Use Refresh pipeline to retry.</InlineError>}
    {canRead && plans.value?.items.length === 0 && <p>No visible plans on this page.{plans.value.continuationToken ? ' More plans may be available on the next page.' : ' Create an improvement plan from submitted QC in the existing Quality improvement screen.'}</p>}
    <section aria-labelledby="pipeline-map-heading">
      <div className="pipeline-heading"><h2 id="pipeline-map-heading">Evidence-to-release map</h2>
        <Button icon={GitBranch} disabled={!detail} aria-pressed={location.focused && Boolean(detail)}
          onClick={() => change({ focused: !location.focused })}>{location.focused ? 'Show full map' : 'Focus selected path'}</Button></div>
      <RelationshipMap selected={location.node} focused={location.focused && Boolean(detail)} savedEdges={savedEdges}
        metadata={metadata} onSelect={node => change({ node })} />
    </section>
    <section className="pipeline-context" aria-label="Selected change and next action">
      <div><h2>What you are following</h2><p>{detail ? `${detail.plan.name} / revision ${detail.plan.revision}` : 'Choose a saved improvement plan.'}</p>
        {detail && <Badge tone={detail.plan.status === 'failed' ? 'danger' : 'neutral'}>Saved state: {detail.plan.status}</Badge>}</div>
      <div><h2>Next owner and action</h2><p>{pipelineNextStep(detail)}</p></div>
      <div><h2>Change boundary</h2><p>Evaluation is not activation. Existing scores and accepted work keep their saved versions.</p></div>
    </section>
    {policy.settings?.maintenance.pauseNewWork && <p className="pipeline-boundary">New work is paused. The map and authorized saved history remain readable; native actions enforce current policy.</p>}
    <PipelineNodeDetails node={location.node} detail={detail} current={release.value}
      workspaceId={workspace?.id} stale={Boolean(selected.error)} />
    <p className="pipeline-boundary">{terms.text('Shared knowledge contains the nonsensitive app guide only. Private workspace evidence is not indexed. Nothing learns or activates automatically.')}</p>
    {selected.loadedAt && <p className="pipeline-caption">Saved path last read: <time dateTime={selected.loadedAt}>{new Date(selected.loadedAt).toLocaleString()}</time>. Refresh reads saved records, not live worker health.</p>}
  </>
}

function workspaceLink(workspaceId: string, path: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}${path}`
}

function PipelineNodeDetails({ node, detail, current, workspaceId, stale }: {
  node: PipelineNodeId | null; detail: PipelineDetail | null; current: PromptReleaseStatus | null; workspaceId?: string; stale: boolean
}) {
  const terms = useAiTerminology()
  const definition = PIPELINE_NODES.find(item => item.id === node)
  const planLink = workspaceId && detail ? workspaceLink(workspaceId, `/qc/improvements/${encodeURIComponent(detail.plan.id)}`) : null
  function backToMap() {
    const target = document.querySelector<HTMLButtonElement>(`[data-pipeline-node="${node ?? 'results'}"]`)
    target?.focus(); target?.scrollIntoView({ block: 'center' })
  }
  return <section id="pipeline-node-details" className="pipeline-detail" aria-labelledby="pipeline-detail-heading">
    <div className="pipeline-heading"><h2 id="pipeline-detail-heading">{terms.text(definition?.title ?? 'How evidence becomes guidance')}</h2>
      <Button size="sm" onClick={backToMap}>Back to map</Button></div>
    <p>{definition?.detail ?? 'Choose any map node to understand its role. Follow a saved improvement plan to inspect recorded version pins and its next decision. Opening this map starts no work.'}</p>
    {stale && <p role="status">This is the last successful metadata read, not a fresh activation check.</p>}
    {node === 'tasks' && <ul className="pipeline-task-list" aria-label="Task guidance impact">{QC_PROMPT_FAMILIES.map(family => {
      const binding = detail?.tasks.find(task => task.family === family)
      return <li key={family}><div><strong>{TASK_LABELS[family]}</strong>{binding && <small>Captured deployment: {binding.deployment} / {binding.model}{binding.modelVersion ? ` / ${binding.modelVersion}` : ' / model version not recorded'}</small>}</div>
        <Badge tone={detail?.changedFamilies.includes(family) ? 'accent' : 'neutral'}>{!detail ? 'No plan selected' : detail.changedFamilies.includes(family) ? 'Proposed change' : 'Unchanged'}</Badge></li>
    })}</ul>}
    {(detail || current) && <div className="pipeline-current">
      <span>Current bundle: <code>{current ? current.activeBundleId ?? 'Not initialized' : 'Status unavailable'}</code></span>
      {detail?.candidate && <span>Evaluated candidate: <code>{detail.candidate.id}</code></span>}
    </div>}
    {detail && <details className="pipeline-pins"><summary>Exact saved version pins</summary><dl>
      <dt>Saved plan</dt><dd>{detail.plan.id} / revision {detail.plan.revision}</dd>
      {(node === 'pack' || node === 'curate' || node === 'results' || node === 'feedback' || node === 'sources' || !node) &&
        <><dt>Case pack SHA-256</dt><dd><code>{detail.casePackSha256}</code></dd>
          <dt>Selected cases</dt><dd>{detail.cases.filter(item => item.purpose === 'drafting').length} drafting / {detail.cases.filter(item => item.purpose === 'holdout').length} holdout</dd>
          <dt>Review selection</dt><dd>{detail.cases.reduce((sum, item) => sum + item.includedReviews, 0)} included / {detail.excludedReviews} explicitly excluded</dd></>}
      <dt>Captured settings</dt><dd>{detail.settings.revision} / {detail.settings.capturedAt}</dd>
      <dt>Saved baseline</dt><dd><code>{detail.baseline.id}</code>{detail.baseline.sha256 ? <><br /><code>{detail.baseline.sha256}</code></> : ' / Hash not recorded'}</dd>
      <dt>Evaluated candidate</dt><dd>{detail.candidate ? <><code>{detail.candidate.id}</code><br /><code>{detail.candidate.sha256 ?? 'Hash not recorded'}</code></> : 'Not recorded in a completed evaluation. A proposal is not an active bundle.'}</dd>
      <dt>Current bundle</dt><dd>{current ? current.activeBundleId ?? 'Not initialized' : 'Current status unavailable'}</dd>
      <dt>Selected activation</dt><dd>{detail.activatedBundleId
        ? current?.activeBundleId === detail.activatedBundleId ? 'Recorded and currently selected by the application pointer' : 'Recorded; not confirmed as the current application pointer'
        : 'No activation recorded'}</dd>
    </dl></details>}
    {node === 'evaluation' && detail && <div>
      {detail.evaluation ? <><p>{detail.evaluation.trials} saved baseline/candidate pairs / {detail.evaluation.holdoutTrials} holdout pairs.
        {' '}{detail.evaluation.failedBaselineTrials} failed baseline trials / {detail.evaluation.failedCandidateTrials} failed candidate trials.</p>
        <p>Saved eligibility at completion: <strong>{detail.evaluation.eligibleAtCompletion ? 'Eligible then; current gates must be rechecked' : 'Not eligible'}</strong>.</p>
        <p>Evaluation SHA-256: <code>{detail.evaluation.sha256}</code></p></> : <p>No completed evaluation artifact is recorded for this revision.</p>}
      {detail.work && <p>Saved {detail.work.kind} execution: {detail.work.status} / {detail.work.attempts} attempts{detail.work.nextAttemptAt ? ` / next attempt ${detail.work.nextAttemptAt}` : ''}.</p>}
    </div>}
    {current && (node === 'active' || node === 'activate' || node === 'future') && <p>{current.message}</p>}
    {detail && current?.activeBundleId && detail.baseline.id !== current.activeBundleId && detail.activatedBundleId !== current.activeBundleId &&
      <p className="pipeline-boundary">The active bundle differs from this plan's baseline. Saved trial completion is not current activation eligibility; inspect the native plan.</p>}
    {detail && workspaceId && (node === 'results' || node === 'feedback' || node === 'curate' || node === 'holdout') &&
      <ul className="pipeline-case-list" aria-label="Exact selected results">{detail.cases.map(item => <li key={`${item.scope.runId}:${item.scope.comparisonId}`}>
        <strong>{item.purpose === 'holdout' ? 'Holdout' : 'Drafting'} case</strong> / {item.includedReviews} included review revisions<br />
        <a href={workspaceLink(workspaceId, qcReviewLink(item.scope))}>Open exact QC review</a><br />
        <code>Result {item.scope.resultRevision} / {item.scope.resultSha256}</code>
      </li>)}</ul>}
    <div className="pipeline-controls">
      {planLink && <a className="button button-primary button-md" href={planLink}>Open improvement plan</a>}
      {planLink && detail?.evaluation && <a className="button button-secondary button-md" href={`${planLink}#evaluation`}>Open exact evaluation</a>}
      {workspaceId && <a className="button button-secondary button-md" href={workspaceLink(workspaceId, '/qc/prompts')}>View prompt history</a>}
    </div>
    <p className="pipeline-caption">Opening private QC screens uses their existing membership checks and peer-exposure auditing. Map metadata reads do not expose reviewer opinions.</p>
  </section>
}
