import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Layers3, LoaderCircle, Pencil, Play, RotateCcw, X } from 'lucide-react'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import type { GradeLadderDetail, GradeLevelDetail, GradeWorkRecord } from '../../domain/real-grades'
import { Badge, Button, EmptyState, InlineError, PageHeader, SegmentedControl } from '../../components/ui'
import { GradeContextEditor } from './GradeContextEditor'
import { GradeDraftEditor } from './GradeDraftEditor'
import { GradeDisclaimer, GradeIssues } from './GradeShared'
import { GradeSourceInspector, type GradeSourceSelection } from './GradeSourceInspector'
import { GradeSourcesReview } from './GradeSourcesReview'
import { GradeMatrix } from './GradeMatrix'
import { GradeVersionHistory } from './GradeVersionHistory'
import { gradeApprovalBlockers, gradeWorkActive } from './gradeUi'
import { useGradeRequestKey } from './grade-request-hooks'
import { ArchivedBadge, EntityLifecycleActions, LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'

export function GradeLadderPage({ ladderId: givenId }: { ladderId?: string }) {
  const { id } = useParams()
  const ladderId = givenId ?? id
  const api = useGradeLadders()
  const ensure = api?.ensureDetail
  const detailState = ladderId && api ? api.detail(ladderId).state : 'idle'
  const { deleting } = useLifecycleAccess({ kind: 'ladder', id: ladderId ?? '' })
  useEffect(() => { if (ladderId && !deleting) void ensure?.(ladderId) }, [ensure, ladderId, detailState, api?.phase, deleting])
  if (!api) return <EmptyState icon={Layers3} title="Real ladders require a cloud workspace" description="Samples remain a separate fictional preview. No real grade data is stored in browser persistence." />
  if (!ladderId) return <EmptyState title="No grade ladder selected" description="Open a real grade family from Rubrics." />
  const entry = api.detail(ladderId)
  if (deleting) return <>
    <Link className="back-link" to="/rubrics?kind=grade&data=real"><ArrowLeft size={14} aria-hidden="true" />Back to real grade families</Link>
    <PageHeader title={entry.state === 'ready' ? entry.value.ladder.name : api.summaries.find((item) => item.ladder.id === ladderId)?.ladder.name ?? 'Grade ladder cleanup'}
      description="Permanent deletion is incomplete. Only recovery status is available." />
    <LifecycleBanner target={{ kind: 'ladder', id: ladderId }} />
    <section className="panel"><EmptyState icon={LoaderCircle} title="Cleanup is incomplete"
      description="Sources and grade content are not shown during permanent deletion. Use the lifecycle retry controls above or open My workspaces for workspace-level recovery." /></section>
  </>
  if (api.phase === 'unavailable') return <EmptyState title="Grade processing is not enabled" description={api.error ?? 'This deployment does not have real grade storage and processing configured.'} action={<Button onClick={() => void api.refresh()}>Check availability</Button>} />
  if (api.phase === 'error' && entry.state !== 'ready') return <EmptyState title="The grade service is unavailable" description={api.error ?? 'Score could not confirm access to the grade service.'} action={<Button onClick={() => void api.refresh()}>Retry grade service</Button>} />
  if (entry.state === 'error') return <EmptyState title="This ladder could not be opened" description={entry.error} action={<Button onClick={() => void api.ensureDetail(ladderId, true)}>Retry ladder</Button>} />
  if (entry.state !== 'ready') return <EmptyState icon={LoaderCircle} title="Loading private grade ladder" description="Opening the durable family, source captures, independent grade heads, and work progress." />
  return <GradeLadderWorkspace key={ladderId} detail={entry.value} loadError={entry.error ?? api.error ?? undefined} />
}

function GradeLadderWorkspace({ detail, loadError }: { detail: GradeLadderDetail; loadError?: string }) {
  const api = useGradeLadders()!
  const navigate = useNavigate()
  const editable = api.canEdit(detail.ladder.id)
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<'sources' | 'matrix' | 'history'>(() => params.get('version') ? 'history' : detail.levels.some((level) => level.version) ? 'matrix' : 'sources')
  const [grade, setGrade] = useState(Number(params.get('grade')) || detail.ladder.grades[0] || 1)
  const [source, setSource] = useState<GradeSourceSelection | null>(() => params.get('source') ? { sourceId: params.get('source')!, sourceSetId: params.get('sourceSetId') ?? undefined, paragraphId: params.get('paragraph') ?? undefined } : null)
  const [contextEditor, setContextEditor] = useState(false)
  const [draft, setDraft] = useState<GradeLevelDetail | null>(null)
  const [sourceDirty, setSourceDirty] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [completion, setCompletion] = useState('')
  const inFlight = useRef(false)
  const alive = useRef(true)
  const keyFor = useGradeRequestKey()
  const guard = useGradeLeaveGuard(false, working, 'Grade generation or approval request')
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (params.get('version')) setView('history')
    if (params.get('grade')) setGrade(Number(params.get('grade')))
  }, [params])

  const busy = working || api.mutationPending
  const active = gradeWorkActive(detail)
  async function run(operation: () => Promise<GradeLadderDetail>, message: string) {
    if (inFlight.current) throw new Error('Wait for the active grade request.')
    inFlight.current = true
    setWorking(true)
    setError('')
    setCompletion('')
    try {
      await operation()
      if (alive.current) setCompletion(message)
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : 'The grade request could not be completed.')
      throw caught
    } finally {
      inFlight.current = false
      if (alive.current) { setWorking(false); guard.release() }
    }
  }
  const execute = (operation: () => Promise<GradeLadderDetail>, message: string) => { void run(operation, message).catch(() => undefined) }
  async function selectView(next: 'sources' | 'matrix' | 'history') {
    if (next === view) return
    await guard.leave(() => {
      if (next !== 'sources') setSourceDirty(false)
      setView(next)
      if (params.has('version')) { const nextParams = new URLSearchParams(params); nextParams.delete('version'); setParams(nextParams, { replace: true }) }
    })
  }
  function openHistory(nextGrade: number) {
    void guard.leave(() => { setGrade(nextGrade); setView('history') })
  }
  function approve(level: GradeLevelDetail) {
    if (!api.canEdit(detail.ladder.id, level.head.grade) || !level.version || !level.review || gradeApprovalBlockers(detail, level).length || sourceDirty) return Promise.reject(new Error('The latest grade version is archived, read-only, or not supported for approval.'))
    return run(() => api.approve(detail.ladder.id, level.head.grade, { versionId: level.version!.id, reviewId: level.review!.id }, level.etag), `GS-${level.head.grade} version ${level.version.version} was reviewer approved. Its captured evidence remains immutable.`)
  }
  const generationBlocked = !editable ? 'Archived or read-only ladder: unarchive it and its workspace before generation.' : sourceDirty ? 'Confirm or discard unsaved source decisions first.' : !detail.sourceSet || detail.sourceSet.id !== detail.ladder.sourceSetId ? 'Review sources and confirm a current frozen source set first.' : active ? 'Wait for current discovery, extraction, generation, or review to finish, or cancel that work.' : ''

  return <>
    <Link className="back-link" to="/rubrics?kind=grade&data=real"><ArrowLeft size={14} aria-hidden="true" />Back to real grade families</Link>
    <PageHeader eyebrow="REAL GS GRADE LADDER" title={detail.ladder.name} description={`Series ${detail.ladder.context.series} · ${detail.ladder.context.agency || 'Agency unresolved'} · Seed rubric v${detail.ladder.seedRubricVersion}`}
      actions={<><EntityLifecycleActions target={{ kind: 'ladder', id: detail.ladder.id }} name={detail.ladder.name} onComplete={(action) => { if (action === 'delete') navigate('/rubrics?kind=grade&data=real') }} /><Button icon={Pencil} disabled={!editable || busy || sourceDirty} title={sourceDirty ? 'Finish source decisions first.' : !editable ? 'Archived content and viewer access are read-only.' : undefined} onClick={() => setContextEditor(true)}>Context / add grades</Button>
        <Button icon={Play} variant="primary" disabled={busy || Boolean(generationBlocked)} title={generationBlocked || undefined}
          onClick={() => execute(() => api.generate(detail.ladder.id, detail.etag, keyFor('generate', [detail.ladder.id, detail.etag, detail.ladder.sourceSetId])), 'Generation accepted. Each grade is processed independently; closing the browser after acknowledgement does not stop durable work.')}>{detail.ladder.generationId ? 'Generate new revision' : 'Generate grade drafts'}</Button></>} />
    <LifecycleBanner target={{ kind: 'ladder', id: detail.ladder.id }} />
    <div className="detail-metadata"><Badge tone="accent">Real · private server records</Badge><ArchivedBadge target={{ kind: 'ladder', id: detail.ladder.id }} /><Badge>{detail.ladder.status.replaceAll('-', ' ')}</Badge><span>{detail.ladder.grades.map((item) => `GS-${item}`).join(' / ')}</span><span>{detail.ladder.context.supervision}</span><span>Seed: {detail.ladder.seedJobTitle}</span></div>
    {detail.ladder.discovery && <div className="grade-discovery-context"><strong>{detail.ladder.discovery.seriesTitle || `Series ${detail.ladder.context.series}`}</strong><Badge tone={detail.ladder.discovery.seriesStatus === 'listed' ? 'neutral' : 'warning'}>{detail.ladder.discovery.seriesStatus} in discovered catalog</Badge><span>Catalog / adapter {detail.ladder.discovery.catalogVersion} · captured {detail.ladder.discovery.capturedAt}</span></div>}
    {generationBlocked && <p className="mb-4 text-[11px] text-muted">{generationBlocked}</p>}
    <GradeDisclaimer />
    {!api.canWrite && <div className="info-callout mb-5"><p>This workspace is read-only. You can inspect captured evidence, grade drafts, and immutable history; only owners and editors can change or approve them.</p></div>}
    {loadError && <InlineError>{loadError} The last acknowledged detail is retained. <Button size="sm" onClick={() => void api.ensureDetail(detail.ladder.id, true)}>Reload from server</Button></InlineError>}
    {error && <div className="mb-5"><InlineError>{error}<p className="mt-1">A lost response does not prove the request failed. Reload the server state before changing an uncertain request; unchanged idempotent requests reuse their key.</p></InlineError></div>}
    {completion && <p role="status" className="grade-operation-notice">{completion}</p>}
    <GradeIssues issues={detail.ladder.issues} />
    <div className="grade-workspace-toolbar"><SegmentedControl label="Grade ladder view" value={view} onChange={(next) => void selectView(next)} options={[{ value: 'sources', label: 'Sources & applicability', count: detail.sources.filter((item) => item.origin !== 'seed-job').length }, { value: 'matrix', label: 'Grade matrix', count: detail.levels.length }, { value: 'history', label: 'Immutable history' }]} />
      <Button size="sm" icon={RotateCcw} disabled={busy} onClick={() => void api.ensureDetail(detail.ladder.id, true)}>Refresh status</Button></div>
    {view === 'sources' && <GradeSourcesReview detail={detail} onOpen={setSource} onDirtyChange={setSourceDirty} />}
    {view === 'matrix' && <GradeMatrix detail={detail} selectedGrade={grade} onGrade={setGrade} canWrite={editable} pending={busy} unsavedSources={sourceDirty} onSource={setSource} onEdit={setDraft} onHistory={openHistory} onApprove={approve} />}
    {view === 'history' && <><label className="field mb-4"><span className="field-label">Grade history</span><select className="input grade-history-select" value={grade} onChange={(event) => {
      const next = Number(event.target.value); setGrade(next)
      const nextParams = new URLSearchParams(params); nextParams.set('grade', String(next)); nextParams.delete('version'); setParams(nextParams, { replace: true })
    }}>{[...new Set([...detail.ladder.grades, ...detail.levels.map((level) => level.head.grade)])].sort((a, b) => a - b).map((item) => <option key={item} value={item}>GS-{item}</option>)}</select></label>
      <GradeVersionHistory detail={detail} grade={grade} requestedVersion={params.get('version') ?? undefined} onSource={setSource} /></>}
    <section className="panel grade-work-items"><div className="section-heading"><div><h2>Durable processing progress</h2><p>Background work survives browser close after request acknowledgement. Failures are separate from evidence gaps.</p></div>
      <Button size="sm" icon={RotateCcw} disabled={!editable || busy || sourceDirty || active} title={sourceDirty ? 'Finish source decisions first.' : active ? 'Wait for or cancel current work before rediscovery.' : 'Discover a new source proposal without overwriting historical captures.'}
        onClick={() => execute(() => api.discover(detail.ladder.id, detail.etag, keyFor('discover', [detail.ladder.id, detail.etag])), 'OPM discovery accepted. New proposals will preserve all earlier captured source versions.')}>Rediscover OPM sources</Button></div>
      <div className="grade-work-list">{detail.workItems.length ? [...detail.workItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((work) => <article key={work.id}>
        <div><strong>{workLabel(work)}</strong><span>{work.status} · attempt {work.attempts}{work.nextAttemptAt ? ` · next ${work.nextAttemptAt}` : ''}</span>{work.error && <p>{work.error.code}: {work.error.message}</p>}</div>
        <div className="flex flex-wrap gap-2"><Badge tone={work.status === 'failed' ? 'danger' : work.status === 'succeeded' ? 'success' : 'neutral'} dot>{work.status}</Badge>
          {['failed', 'cancelled'].includes(work.status) && <Button size="sm" disabled={!api.canEdit(detail.ladder.id, 'grade' in work.input ? work.input.grade : undefined) || busy || sourceDirty || work.error?.retryable === false} title={work.error?.retryable === false ? 'This failure is not retryable. Correct sources or context before starting new work.' : undefined}
            onClick={() => execute(() => api.retry(detail.ladder.id, { workId: work.id }, detail.etag), 'Retry accepted; already completed grade versions remain preserved.')}>Retry stage</Button>}
          {['queued', 'running'].includes(work.status) && <Button size="sm" variant="ghost" icon={X} disabled={!api.canEdit(detail.ladder.id, 'grade' in work.input ? work.input.grade : undefined) || busy || sourceDirty} onClick={() => execute(() => api.cancel(detail.ladder.id, { workId: work.id }, detail.etag), 'Cancellation requested. Published versions and completed source captures remain retained.')}>Cancel stage</Button>}</div>
      </article>) : <p className="p-5 text-[12px] text-muted">No background work has been recorded yet.</p>}</div>
      {active && <div className="p-4 text-[11px] text-muted" role="status">The service is processing this ladder. Scheduled workers may take a minute to begin. Other adequately supported grades can finish independently.</div>}
    </section>
    {contextEditor && <GradeContextEditor detail={detail} onClose={() => setContextEditor(false)} />}
    {draft && <GradeDraftEditor ladderId={detail.ladder.id} level={draft} onClose={() => setDraft(null)} />}
    {source && <GradeSourceInspector ladderId={detail.ladder.id} selection={source} onClose={() => setSource(null)} />}
  </>
}

function workLabel(work: GradeWorkRecord): string {
  switch (work.input.kind) {
    case 'discover': return 'Discover OPM references'
    case 'extract-source': return `Capture source ${work.input.sourceId}`
    case 'plan-competencies': return 'Align common competencies'
    case 'generate-grade': return `Generate GS-${work.input.grade} draft`
    case 'review-grade': return `Grounding review · GS-${work.input.grade}`
  }
}
