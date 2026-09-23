import { useCallback, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ClipboardCheck, LoaderCircle, Plus, RefreshCw, Save, Send } from 'lucide-react'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { Badge, Button, EmptyState, InlineError, PageHeader } from '../../components/ui'
import {
  QC_ISSUE_KINDS, QC_LIMITS, qcFeedbackSchema, qcReviewReady, qcScopeKey,
  type QcCapabilities, type QcComparisonContext, type QcComparisonRef, type QcCriterionFeedback,
  type QcReviewSubmission, type VersionedQc, type QcReviewHead,
} from '../../domain/quality-control'
import { getDisplayName } from '../../domain/displayNames'
import { listAllRealAnalyses, listAllRealAnalysisComparisons } from '../../services/realAnalyses'
import {
  createQcBatch, getQcContext, getQcPeers, getQcReviewHistory, listQcBatches, saveQcReview,
} from '../../services/qualityControl'
import { RealComparisonReview } from '../analyses/RealComparisonReview'
import { qcReviewLink, useQcPolling, useQcRequest, useQcResource } from './qc-ui'
import { QcRequestError } from './QcPrivacyBoundary'

export interface QcPageProps { workspaceId: string; capabilities: QcCapabilities }
const issueLabels = {
  scoring: 'Scoring interpretation', evidence: 'Evidence use', 'rubric-anchors': 'Ambiguous rubric anchors', 'criterion-scope': 'Criterion scope',
}
export function QcResultPin({ scope }: { scope: QcComparisonRef }) {
  return <details className="qc-pin"><summary>Exact result · {scope.resultRevision}</summary>
    <dl><dt>Run</dt><dd>{scope.runId}</dd><dt>Comparison</dt><dd>{scope.comparisonId}</dd>
      <dt>Result SHA-256</dt><dd>{scope.resultSha256}</dd></dl></details>
}

export function QcScopePicker({ workspaceId, onChoose, selected = [], limit = QC_LIMITS.planCases, requirePeerAccess = false, disabled = false, includeBatches = false }: {
  workspaceId: string; onChoose?: (context: QcComparisonContext) => void; selected?: string[]; limit?: number
  requirePeerAccess?: boolean; disabled?: boolean; includeBatches?: boolean
}) {
  const [runId, setRunId] = useState('')
  const [offset, setOffset] = useState(0)
  const loadRuns = useCallback((signal: AbortSignal) => listAllRealAnalyses(workspaceId, signal), [workspaceId])
  const runs = useQcResource(loadRuns)
  const loadComparisons = useCallback((signal: AbortSignal) => runId
    ? listAllRealAnalysisComparisons(workspaceId, runId, signal) : Promise.resolve([]), [runId, workspaceId])
  const comparisons = useQcResource(loadComparisons)
  const complete = comparisons.value?.filter(item => item.comparison.status === 'complete' && item.comparison.result) ?? []
  return <section className="qc-stack" aria-label="Completed comparison picker">
    <div className="qc-toolbar"><label className="qc-field"><span>Saved real analysis</span><select aria-label="Saved real analysis" value={runId} disabled={disabled || runs.loading}
      onChange={event => { setRunId(event.target.value); setOffset(0) }}>
      <option value="">Choose an analysis</option>
      {runs.value?.map(({ run }) => <option key={run.id} value={run.id}>
        {getDisplayName(run, run.name)} · {run.status} · {run.progress.complete} completed
      </option>)}
    </select></label><Button size="sm" icon={RefreshCw} disabled={disabled || runs.loading} onClick={() => { runs.reload(); comparisons.reload() }}>Refresh analyses</Button></div>
    {runs.error && <InlineError>{runs.error}</InlineError>}
    {runs.value?.length === 0 && <EmptyState title="No saved real analyses" description="Complete at least one real comparison in normal mode first." />}
    {runId && <><p className="qc-muted">{complete.length} completed comparisons in this run. Other comparisons may still be running or failed; they do not block review.</p>
      {comparisons.loading && <p role="status">Loading saved comparisons…</p>}
      {comparisons.error && <InlineError>{comparisons.error} <Button onClick={comparisons.reload}>Retry comparisons</Button></InlineError>}
      {comparisons.value && !complete.length && <EmptyState title="No completed comparisons in this run yet" description="QC starts only from an accepted saved result, never an unaccepted model draft." />}
      <div className="qc-queue">{complete.slice(offset, offset + 15).map(({ comparison }) =>
        <QcQueueRow key={comparison.id} workspaceId={workspaceId} runId={runId} comparisonId={comparison.id}
          onChoose={onChoose} selected={selected} limit={limit} disabled={disabled} requirePeerAccess={requirePeerAccess} />)}</div>
      {complete.length > 15 && <div className="qc-toolbar"><Button size="sm" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 15))}>Previous comparisons</Button>
        <span>{offset + 1}–{Math.min(offset + 15, complete.length)} of {complete.length}</span>
        <Button size="sm" disabled={offset + 15 >= complete.length} onClick={() => setOffset(value => value + 15)}>Next comparisons</Button></div>}
    </>}
    {includeBatches && onChoose && <QcBatchCasePicker workspaceId={workspaceId} selected={selected} limit={limit} requirePeerAccess={requirePeerAccess}
      disabled={disabled} onChoose={onChoose} />}
  </section>
}

function QcBatchCasePicker({ workspaceId, onChoose, selected, limit, requirePeerAccess, disabled }: {
  workspaceId: string; onChoose: (context: QcComparisonContext) => void; selected: string[]; limit: number
  requirePeerAccess: boolean; disabled: boolean
}) {
  const [cursor, setCursor] = useState<string>()
  const [batchId, setBatchId] = useState('')
  const [offset, setOffset] = useState(0)
  const load = useCallback((signal: AbortSignal) => listQcBatches(workspaceId, cursor, signal), [cursor, workspaceId])
  const resource = useQcResource(load)
  const batch = resource.value?.items.find(item => item.record.id === batchId)?.record
  return <details className="qc-card"><summary>Select exact historical results from an optional batch</summary>
    <div className="qc-stack"><p className="qc-muted">Batches retain result revisions and hashes even after newer scores are published. Selecting a batch never loads peer opinions or selects every case automatically.</p>
      <label className="qc-field"><span>Saved pinned review batch</span><select aria-label="Saved pinned review batch" value={batchId} disabled={disabled || resource.loading}
        onChange={event => { setBatchId(event.target.value); setOffset(0) }}><option value="">Choose an optional named batch</option>
        {resource.value?.items.map(({ record }) => <option key={record.id} value={record.id}>{record.name} · {record.comparisons.length} exact results</option>)}</select></label>
      {resource.error && <InlineError>{resource.error} <Button size="sm" onClick={resource.reload}>Reload pinned batches</Button></InlineError>}
      <div className="qc-toolbar">{cursor && <Button size="sm" disabled={disabled} onClick={() => { setCursor(undefined); setBatchId(''); setOffset(0) }}>First pinned batches</Button>}
        {resource.value?.continuationToken && <Button size="sm" disabled={disabled} onClick={() => { setCursor(resource.value?.continuationToken); setBatchId(''); setOffset(0) }}>More pinned batches</Button>}</div>
      {batch && <><p>{batch.name} · {batch.comparisons.length} pinned comparisons. Select only the exact results you want to curate.</p>
        <div className="qc-queue">{batch.comparisons.slice(offset, offset + 15).map(scope => <QcQueueRow key={qcScopeKey(scope)} workspaceId={workspaceId}
          runId={scope.runId} comparisonId={scope.comparisonId} pinned={scope} selected={selected} limit={limit} disabled={disabled} requirePeerAccess={requirePeerAccess} onChoose={onChoose} />)}</div>
        {batch.comparisons.length > 15 && <div className="qc-toolbar"><Button size="sm" disabled={disabled || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 15))}>Previous pinned results</Button>
          <span>{offset + 1}–{Math.min(offset + 15, batch.comparisons.length)} of {batch.comparisons.length}</span>
          <Button size="sm" disabled={disabled || offset + 15 >= batch.comparisons.length} onClick={() => setOffset(value => value + 15)}>Next pinned results</Button></div>}</>}
    </div>
  </details>
}

function QcQueueRow({ workspaceId, runId, comparisonId, onChoose, selected, limit, requirePeerAccess, disabled, pinned }: {
  workspaceId: string; runId: string; comparisonId: string; onChoose?: (context: QcComparisonContext) => void
  selected: string[]; limit: number; requirePeerAccess: boolean; disabled: boolean; pinned?: QcComparisonRef
}) {
  const revision = pinned?.resultRevision, hash = pinned?.resultSha256
  const load = useCallback((signal: AbortSignal) => getQcContext(workspaceId, runId, comparisonId, revision, signal, hash),
    [comparisonId, hash, revision, runId, workspaceId])
  const resource = useQcResource(load)
  const context = resource.value
  if (!context) return <article className="qc-card"><p>{resource.loading ? 'Reading saved QC status…' : 'QC status unavailable'}</p>
    {resource.error && <InlineError>{resource.error} <Button size="sm" onClick={resource.reload}>Retry QC status</Button></InlineError>}</article>
  const key = qcScopeKey(context.scope)
  const checked = selected.includes(key)
  const comparison = context.analysis.comparison
  const own = context.myReview?.record
  const canChoose = context.writable && (!requirePeerAccess || context.canSeePeers || context.isCoordinator)
  return <article className="qc-card">
    <div className="qc-toolbar"><div className="qc-grow"><h3><Link to={qcReviewLink(context.scope)}>
      {getDisplayName(comparison.resume.summary, comparison.resume.summary.name ?? 'Name not stated')} → {getDisplayName(comparison.target.summary, comparison.target.summary.label)}
    </Link></h3><p className="qc-muted">Saved rubric v{comparison.target.summary.rubricVersion} · {context.scope.resultRevision}</p></div>
      {onChoose && <label className="qc-check"><input type="checkbox" checked={checked}
        disabled={disabled || !canChoose || (!checked && selected.length >= limit)} onChange={() => onChoose(context)} />Select exact result</label>}</div>
    <div className="qc-toolbar"><Badge tone={own?.submittedId ? 'success' : own ? 'warning' : 'neutral'}>
      {own?.submittedId ? `My submission ${own.submissionNumber} · saved working copy` : own ? `My draft · ${own.feedback.length} responses` : 'Not reviewed by me'}
    </Badge><Badge>{context.submissionCount} submitted reviewer{context.submissionCount === 1 ? '' : 's'}</Badge>
      {own && <Badge>{own.feedback.filter(row => row.decision === 'disagree').length} of my responses disagree</Badge>}
      <span className="qc-muted">{context.diagnostics.status === 'recorded' ? 'Model diagnostics recorded' : 'Confidence: Not recorded'}</span></div>
    {context.submissionCount === 1 && <p className="qc-muted">One submitted opinion, not a consensus.</p>}
    {!context.canSeePeers && !context.isCoordinator && <p className="qc-muted">Peer feedback and disagreement details are hidden until you submit this exact result.</p>}
    {!context.writable && <p className="qc-notice">This result is read-only and cannot be selected for a new batch or plan.</p>}
    {requirePeerAccess && context.writable && !canChoose && <p className="qc-notice">Submit your own review first to collect this case’s feedback.</p>}
  </article>
}

export function QcReviews({ workspaceId, capabilities }: QcPageProps) {
  const [selected, setSelected] = useState<QcComparisonRef[]>([])
  const [name, setName] = useState('')
  const [cursor, setCursor] = useState<string>()
  const load = useCallback((signal: AbortSignal) => listQcBatches(workspaceId, cursor, signal), [cursor, workspaceId])
  const batches = useQcResource(load)
  const request = useQcRequest()
  useGradeLeaveGuard(Boolean(name || selected.length) || request.unresolved, request.pending, 'QC batch selection')
  const canBatch = capabilities.coordinator && capabilities.writable && capabilities.admissionEnabled
  const disabled = request.pending || request.unresolved
  return <>
    <PageHeader eyebrow="QUALITY CONTROL" title="Reviews" description="Review any completed comparison. Independent human feedback never edits its published score or gates normal work."
      actions={<Link className="button button-secondary button-md" to="/qc/improvements">Quality improvement</Link>} />
    <QcScopePicker workspaceId={workspaceId} selected={selected.map(qcScopeKey)} limit={QC_LIMITS.batchComparisons} disabled={disabled}
      onChoose={canBatch ? context => setSelected(current => current.some(item => qcScopeKey(item) === qcScopeKey(context.scope))
        ? current.filter(item => qcScopeKey(item) !== qcScopeKey(context.scope)) : [...current, context.scope]) : undefined} />
    {canBatch && <section className="qc-card qc-stack"><h2>Optional named review batch</h2>
      <p>A batch organizes exact results; it is not an assignment, quorum, or mandatory review gate.</p>
      <p>{selected.length} / {QC_LIMITS.batchComparisons} comparisons selected across analyses.</p>
      {selected.map(scope => <div className="qc-toolbar" key={qcScopeKey(scope)}><Link to={qcReviewLink(scope)}>{scope.runId} / {scope.comparisonId} · {scope.resultRevision}</Link>
        <Button size="sm" disabled={disabled} onClick={() => setSelected(current => current.filter(item => qcScopeKey(item) !== qcScopeKey(scope)))}>Remove result</Button></div>)}
      <label className="qc-field"><span>Batch name</span><input value={name} maxLength={160} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
      <QcRequestError request={request} />
      <Button icon={Plus} disabled={disabled || !name.trim() || !selected.length} onClick={() => {
        const input = { name: name.trim(), comparisons: selected }
        void request.run(JSON.stringify(input), (key, signal) => createQcBatch(workspaceId, input, key, signal),
          () => { setName(''); setSelected([]); if (cursor) setCursor(undefined); else batches.reload() })
      }}>Save named batch</Button>
    </section>}
    <section className="qc-stack"><h2>Saved review batches</h2>
      {batches.error && <InlineError>{batches.error} <Button size="sm" onClick={batches.reload}>Reload batches</Button></InlineError>}
      {batches.loading && <p role="status">Loading batches…</p>}
      {batches.value?.items.length === 0 && <p className="qc-muted">No saved batches. Ad hoc reviews are available without one.</p>}
      {batches.value?.items.map(({ record }) => <details className="qc-card" key={record.id}><summary>{record.name} · {record.comparisons.length} exact results</summary>
        <p className="qc-muted">Created by {record.createdBy.name} · {record.createdAt}</p>
        <ul className="qc-list">{record.comparisons.map(scope => <li key={qcScopeKey(scope)}><Link to={qcReviewLink(scope)}>
          {scope.runId} / {scope.comparisonId} · {scope.resultRevision}</Link><QcResultPin scope={scope} /></li>)}</ul></details>)}
      <div className="qc-toolbar">{cursor && <Button size="sm" onClick={() => setCursor(undefined)}>First batches</Button>}
        {batches.value?.continuationToken && <Button size="sm" onClick={() => setCursor(batches.value?.continuationToken)}>More batches</Button>}</div>
    </section>
  </>
}

export function QcComparisonReview({ workspaceId, capabilities }: QcPageProps) {
  const { runId = '', comparisonId = '' } = useParams()
  const [search] = useSearchParams()
  const revision = search.get('resultRevision') ?? undefined
  const hash = search.get('resultSha256') ?? undefined
  const load = useCallback((signal: AbortSignal) => getQcContext(workspaceId, runId, comparisonId, revision, signal, hash),
    [comparisonId, hash, revision, runId, workspaceId])
  const resource = useQcResource(load)
  if (!resource.value) return <><EmptyState icon={resource.loading ? LoaderCircle : ClipboardCheck}
    title={resource.loading ? 'Opening the pinned assessment' : 'This QC result could not be opened'}
    description="Only real, completed assessments and their exact saved evidence can be reviewed."
    action={<Button onClick={resource.reload}>Reload saved result</Button>} />{resource.error && <InlineError>{resource.error}</InlineError>}</>
  return <ReviewEditor key={qcScopeKey(resource.value.scope)} initial={resource.value} capabilities={capabilities} />
}

function ReviewEditor({ initial, capabilities }: { initial: QcComparisonContext; capabilities: QcCapabilities }) {
  const [context, setContext] = useState(initial)
  const [head, setHead] = useState(initial.myReview)
  const latestHead = useRef(initial.myReview)
  const [feedback, setFeedback] = useState<QcCriterionFeedback[]>(initial.myReview?.record.feedback ?? [])
  const [saved, setSaved] = useState(JSON.stringify(feedback))
  const [editing, setEditing] = useState(!initial.myReview?.record.submittedId)
  const [exposed, setExposed] = useState(Boolean(initial.myReview?.record.peerExposedAt) || initial.isCoordinator)
  const [message, setMessage] = useState('')
  const [latest, setLatest] = useState<QcComparisonContext | null>(null)
  const [conflict, setConflict] = useState<QcComparisonContext | null>(null)
  const request = useQcRequest()
  const check = useQcRequest()
  const peerMetadata = useQcRequest()
  const syncingPeers = peerMetadata.pending || peerMetadata.unresolved
  const { scope, workspaceId } = context
  const rubric = context.analysis.targetSnapshot.kind === 'job' ? context.analysis.targetSnapshot.rubric : context.analysis.targetSnapshot.version.rubric
  const criterionIds = rubric.criteria.map(row => row.id)
  const dirty = JSON.stringify(feedback) !== saved
  useGradeLeaveGuard(dirty || request.unresolved || peerMetadata.unresolved, request.pending || check.pending || peerMetadata.pending, 'QC review draft')
  const writable = context.writable && capabilities.writable && capabilities.admissionEnabled
  const disabled = !editing || !writable || request.pending || request.unresolved || check.pending || syncingPeers
  const ready = qcReviewReady(feedback, criterionIds)
  const completeCount = feedback.filter(row => qcFeedbackSchema.safeParse(row).success).length
  const currentError = useQcPolling(editing && !request.pending && !request.unresolved && !check.pending && !syncingPeers,
    signal => getQcContext(workspaceId, scope.runId, scope.comparisonId, undefined, signal), value => {
      setLatest(value)
      if (qcScopeKey(value.scope) === qcScopeKey(scope) && value.myReview?.etag !== head?.etag) setConflict(value)
    }, 15000)
  function adoptHead(value: VersionedQc<QcReviewHead> | null) {
    latestHead.current = value
    setHead(value)
  }
  function acknowledge(value: VersionedQc<QcReviewHead>, submit: boolean) {
    adoptHead(value); setFeedback(value.record.feedback); setSaved(JSON.stringify(value.record.feedback))
    setContext(current => ({ ...current, myReview: value, canSeePeers: current.canSeePeers || submit }))
    if (submit) setEditing(false)
    setMessage(submit ? `Submission ${value.record.submissionNumber} is saved. Your opinion remains separate from published scores.` : 'Draft saved on the server. Incomplete rows remain incomplete.')
  }
  function refreshAfterPeers() {
    setExposed(true)
    void peerMetadata.run(`peer-head:${qcScopeKey(scope)}`, async (_key, signal) => {
      const value = await getQcContext(workspaceId, scope.runId, scope.comparisonId, scope.resultRevision, signal, scope.resultSha256)
      if (!value.myReview?.record.peerExposedAt) throw new Error('Peer exposure was recorded, but its saved draft version could not be refreshed. Keep your fields and retry.')
      return value
    }, value => {
      const before = latestHead.current, after = value.myReview
      const metadataOnly = before
        ? Boolean(after && before.record.id === after.record.id && before.record.lastRequestId &&
          before.record.lastRequestId === after.record.lastRequestId && before.record.lastRequestHash === after.record.lastRequestHash &&
          before.record.submittedId === after.record.submittedId && before.record.submissionNumber === after.record.submissionNumber &&
          JSON.stringify(before.record.feedback) === JSON.stringify(after.record.feedback))
        : Boolean(after && !after.record.submittedId && after.record.submissionNumber === 0 && after.record.feedback.length === 0)
      setContext(current => ({ ...current, writable: value.writable, canSeePeers: value.canSeePeers }))
      if (metadataOnly) {
        adoptHead(after)
        setMessage('Peer exposure and the saved draft version were refreshed. Your feedback fields have not been replaced.')
      } else if (after?.etag !== before?.etag) setConflict(value)
    })
  }
  function save(submit: boolean) {
    const input = { scope, feedback }
    const etag = head?.etag ?? null
    void request.run(JSON.stringify({ input, etag, submit }), (key, signal) => saveQcReview(workspaceId, input, etag, key, submit, signal),
      value => acknowledge(value, submit))
  }
  function update(criterionId: string, row: QcCriterionFeedback | null) {
    setMessage('')
    setFeedback(current => row ? current.some(item => item.criterionId === criterionId)
      ? current.map(item => item.criterionId === criterionId ? row : item) : [...current, row]
      : current.filter(item => item.criterionId !== criterionId))
  }
  return <div className="qc-stack">
    <PageHeader eyebrow="INDEPENDENT HUMAN REVIEW" title="Review this saved comparison"
      description="Explicitly respond to every criterion to submit this comparison. Untouched rows never count as agreement; no other comparison is required."
      actions={<Link className="button button-secondary button-md" to="/qc">All reviews</Link>} />
    <section className="qc-card qc-stack"><QcResultPin scope={scope} />
      <p className="qc-muted">Confidence below is the model’s recorded judgment about applying this rubric, not a probability, evidence-coverage estimate, or statement about a person.</p>
      {context.diagnostics.status !== 'recorded' && <p className="qc-notice">Confidence: Not recorded. {context.diagnostics.message ?? 'This historical result has no diagnostic sidecar for this exact revision.'}</p>}
      <div className="qc-toolbar"><Badge>{completeCount} / {criterionIds.length} complete responses</Badge>
        <Badge tone={head?.record.submittedId ? 'success' : 'neutral'}>{head?.record.submittedId ? `Submitted revision ${head.record.submissionNumber}` : 'Not submitted'}</Badge>
        <span className="qc-muted">{dirty ? 'Unsaved changes in this tab' : head ? 'Saved working copy' : 'No draft saved'}</span></div>
      {exposed ? <p className="qc-notice">Coordinator or peer-exposed revision: do not describe this feedback as peer-independent.</p>
        : <p className="qc-muted">Peer responses are not loaded when you open this page.</p>}
      {!writable && <p className="qc-notice">This result is read-only. You can inspect saved feedback, but cannot save changes.</p>}
      <div className="qc-toolbar">
        {!editing && writable && <Button onClick={() => { setEditing(true); setMessage('Editing your working copy. Your previous immutable submission remains in history.') }}>Revise my feedback</Button>}
        {editing && <><Button icon={Save} disabled={disabled} onClick={() => save(false)}>Save incomplete draft</Button>
          <Button variant="primary" icon={Send} disabled={disabled || !ready} onClick={() => save(true)}>Submit complete comparison</Button></>}
        <Button size="sm" disabled={request.pending || request.unresolved || check.pending || syncingPeers} onClick={() => void check.run(`check:${qcScopeKey(scope)}`,
          async (_key, signal) => {
            const [current, exact] = await Promise.all([
              getQcContext(workspaceId, scope.runId, scope.comparisonId, undefined, signal),
              getQcContext(workspaceId, scope.runId, scope.comparisonId, scope.resultRevision, signal, scope.resultSha256),
            ])
            return { current, exact }
          }, value => { setLatest(value.current); if (value.exact.myReview?.etag !== head?.etag) setConflict(value.exact) })}>Check current result and draft version</Button>
      </div>
      {editing && !ready && <p className="qc-muted">Submit becomes available after every row has an explicit decision and all required reasons/recommendations are complete.</p>}
      {message && <p role="status">{message}</p>}
      <QcRequestError request={request} /><QcRequestError request={check} /><QcRequestError request={peerMetadata} />
      {peerMetadata.pending && <p role="status">Refreshing the saved draft version after peer exposure…</p>}
      {currentError && <InlineError>Current-result status could not be refreshed. Your fields still target the pinned result above. {currentError}</InlineError>}
      {latest && qcScopeKey(latest.scope) !== qcScopeKey(scope) && <div className="qc-notice"><strong>You are reviewing a historical result.</strong>
        <p>The published result has changed. Your draft still targets the exact revision above. Nothing was applied to the new score.</p>
        <Link to={qcReviewLink(latest.scope)}>Explicitly open the current result instead</Link></div>}
      {latest && qcScopeKey(latest.scope) === qcScopeKey(scope) && !conflict && <p role="status">This exact result and draft version are current.</p>}
      {conflict && <div className="qc-notice"><h3>A newer saved draft exists</h3><p>Your unsaved fields have been kept. Inspect the server copy before deciding; nothing is merged or overwritten automatically.</p>
        <FeedbackRows feedback={conflict.myReview?.record.feedback ?? []} labels={rubric.criteria} />
        <Button disabled={request.pending || syncingPeers} onClick={() => { adoptHead(conflict.myReview); setContext(conflict); setConflict(null); setMessage('New ETag selected. Your local fields are still unsaved; save explicitly to replace the working copy.') }}>Keep my fields against this reviewed version</Button>
        <Button disabled={request.pending || syncingPeers} onClick={() => { const rows = conflict.myReview?.record.feedback ?? []; adoptHead(conflict.myReview); setFeedback(rows); setSaved(JSON.stringify(rows)); setContext(conflict); setConflict(null) }}>Replace my fields with the saved draft</Button>
      </div>}
    </section>
    <RealComparisonReview detail={context.analysis} qc={{ renderCriterion: criterionId => <CriterionFeedback
      criterionId={criterionId} label={rubric.criteria.find(row => row.id === criterionId)?.label ?? criterionId}
      value={feedback.find(row => row.criterionId === criterionId)}
      excluded={context.analysis.result?.criteria.find(row => row.criterionId === criterionId)?.evidenceStatus === 'not-applicable'}
      diagnostic={context.diagnostics.status === 'recorded' ? context.diagnostics.criteria.find(row => row.criterionId === criterionId) : undefined}
      evidence={context.analysis.result?.criteria.find(row => row.criterionId === criterionId)?.citations.map(item => ({ id: item.paragraphId, label: item.heading })) ?? []}
      disabled={disabled} onChange={row => update(criterionId, row)} /> }} />
    {editing && <section className="qc-card qc-toolbar" aria-label="Review completion controls"><span className="qc-grow">{completeCount} / {criterionIds.length} complete responses · {dirty ? 'Unsaved' : 'Saved working copy'}</span>
      <Button icon={Save} disabled={disabled} onClick={() => save(false)}>Save review draft</Button>
      <Button variant="primary" icon={Send} disabled={disabled || !ready} onClick={() => save(true)}>Submit reviewed comparison</Button></section>}
    <ReviewHistory key={head?.record.submissionNumber ?? 0} workspaceId={workspaceId} scope={scope} labels={rubric.criteria} revision={head?.record.submissionNumber ?? 0} />
    <PeerReviews workspaceId={workspaceId} scope={scope} labels={rubric.criteria} allowed={context.canSeePeers || context.isCoordinator}
      coordinator={context.isCoordinator} disabled={request.pending || request.unresolved || check.pending || syncingPeers} onExposed={refreshAfterPeers} />
  </div>
}

function CriterionFeedback({ criterionId, label, value, diagnostic, evidence, excluded, disabled, onChange }: {
  criterionId: string; label: string; value?: QcCriterionFeedback; diagnostic?: QcComparisonContext['diagnostics']['criteria'][number]
  evidence: { id: string; label: string }[]; excluded: boolean; disabled: boolean; onChange: (row: QcCriterionFeedback | null) => void
}) {
  const recommendation = value?.recommendation
  const recommendationValue = recommendation?.kind === 'score' ? String(recommendation.score) : recommendation?.kind ?? ''
  return <section className="qc-criterion" aria-label={`QC feedback for ${label}`}>
    <div className="qc-diagnostic"><h4>Model-reported confidence: <Badge tone={diagnostic?.confidence === 'low' ? 'warning' : 'neutral'}>
      {diagnostic?.confidence ?? 'Not recorded'}</Badge></h4>
      {diagnostic?.explanation && <p>{diagnostic.explanation}</p>}
      {diagnostic?.ambiguities.map((item, index) => <p key={index}><strong>{item.kind}: </strong>{item.message}</p>)}
      {Boolean(diagnostic?.alternativeScores.length) && <p>Recorded alternative defensible ratings: {diagnostic?.alternativeScores.join(', ')} / 5. Model judgments, not a statistical interval.</p>}
    </div>
    <fieldset disabled={disabled} className="qc-stack"><legend>Your explicit response · {label}</legend>
      <label className="qc-field"><span>Decision for {label}</span><select aria-label={`Decision for ${label}`} value={value?.decision ?? ''} onChange={event => {
        const decision = event.target.value as QcCriterionFeedback['decision'] | ''
        onChange(decision ? { criterionId, decision, reason: value?.reason ?? '', recommendation: decision === 'disagree' ? value?.recommendation ?? null : null,
          issues: value?.issues ?? [], evidenceParagraphIds: value?.evidenceParagraphIds ?? [] } : null)
      }}><option value="">Not reviewed — choose a response</option><option value="agree">Agree</option>
        <option value="disagree">Disagree</option><option value="unable-to-judge">Unable to judge</option></select></label>
      {value && <>
        <label className="qc-field"><span>{value.decision === 'agree' ? 'Optional comment' : 'Required explanation'} for {label}</span>
          <textarea aria-label={`${value.decision === 'agree' ? 'Optional comment' : 'Required explanation'} for ${label}`} rows={3} maxLength={QC_LIMITS.reasonCharacters} value={value.reason} required={value.decision !== 'agree'}
            onChange={event => onChange({ ...value, reason: event.target.value })} /></label>
        {value.decision === 'disagree' && <><label className="qc-field"><span>Recommended rating or unscored disposition for {label}</span>
          <select aria-label={`Recommended rating or unscored disposition for ${label}`} required value={recommendationValue} onChange={event => {
            const selected = event.target.value
            onChange({ ...value, recommendation: selected === '' ? null : selected === 'not-assessed' || selected === 'not-applicable'
              ? { kind: selected } : { kind: 'score', score: Number(selected) } })
          }}><option value="">Choose a recommendation</option>{[0, 1, 2, 3, 4, 5].map(score => <option key={score} value={score} disabled={excluded}>{score} / 5</option>)}
            <option value="not-assessed">Not assessed — unscored</option><option value="not-applicable" disabled={!excluded}>Not applicable — unscored / excluded</option></select></label>
          <p className="qc-muted">The same numeric rating is valid if you disagree with its rationale or evidence. Zero is a rating; unscored is distinct.</p></>}
        {excluded && <p className="qc-muted">This saved zero-weight exclusion remains unscored. Explain any scope disagreement without inventing a numeric rating.</p>}
        <fieldset className="qc-issues"><legend>Optional issue categories</legend>{QC_ISSUE_KINDS.map(issue => <label className="qc-check" key={issue}>
          <input type="checkbox" checked={value.issues.includes(issue)} onChange={event => onChange({ ...value,
            issues: event.target.checked ? [...value.issues, issue] : value.issues.filter(item => item !== issue) })} />{issueLabels[issue]}</label>)}</fieldset>
        {evidence.length > 0 && <fieldset className="qc-issues"><legend>Optional links to cited frozen evidence (up to 8)</legend>
          {[...new Map(evidence.map(item => [item.id, item])).values()].map(item => <label key={item.id} className="qc-check"><input type="checkbox"
            checked={value.evidenceParagraphIds.includes(item.id)} disabled={!value.evidenceParagraphIds.includes(item.id) && value.evidenceParagraphIds.length >= 8}
            onChange={event => onChange({ ...value, evidenceParagraphIds: event.target.checked ? [...value.evidenceParagraphIds, item.id] : value.evidenceParagraphIds.filter(id => id !== item.id) })} />
            {item.label} · {item.id}</label>)}</fieldset>}
      </>}
    </fieldset>
  </section>
}

export function FeedbackRows({ feedback, labels = [] }: { feedback: QcCriterionFeedback[]; labels?: { id: string; label: string }[] }) {
  return <ul className="qc-feedback-list">{feedback.map(row => <li key={row.criterionId}><strong>{labels.find(item => item.id === row.criterionId)?.label ?? row.criterionId}</strong>
    {' · '}<Badge tone={row.decision === 'disagree' ? 'warning' : 'neutral'}>{row.decision}</Badge>
    {row.recommendation && <span> · Recommended: {row.recommendation.kind === 'score' ? `${row.recommendation.score} / 5` : `${row.recommendation.kind} (unscored)`}</span>}
    {row.reason && <p className="qc-prose">{row.reason}</p>}
    {row.issues.length > 0 && <p className="qc-muted">{row.issues.map(issue => issueLabels[issue]).join(' · ')}</p>}
    {row.evidenceParagraphIds.length > 0 && <p className="qc-muted">Frozen evidence links: {row.evidenceParagraphIds.join(', ')}</p>}</li>)}</ul>
}

function Submission({ review, labels }: { review: QcReviewSubmission; labels: { id: string; label: string }[] }) {
  return <details className="qc-card"><summary>{review.author.name} · submission {review.submissionNumber} · {review.createdAt}</summary>
    <p className="qc-muted">{review.peerIndependent ? 'Submitted before peer exposure' : 'Peer-exposed or coordinator feedback; not peer-independent'} · <code>{review.id}</code></p>
    <p className="qc-muted">Reviewer identity: {review.author.principalId}</p>
    <FeedbackRows feedback={review.feedback} labels={labels} /></details>
}
function ReviewHistory({ workspaceId, scope, labels, revision }: { workspaceId: string; scope: QcComparisonRef; labels: { id: string; label: string }[]; revision: number }) {
  const [cursor, setCursor] = useState<string>()
  const load = useCallback((signal: AbortSignal) => {
    void revision
    return getQcReviewHistory(workspaceId, scope, cursor, signal)
  }, [cursor, revision, scope, workspaceId])
  const history = useQcResource(load)
  return <section className="qc-stack"><h2>My immutable submission history</h2>
    {history.error && <InlineError>{history.error} <Button size="sm" onClick={history.reload}>Reload my history</Button></InlineError>}
    {history.loading && <p role="status">Loading your submission history…</p>}
    {history.value?.items.length === 0 && <p className="qc-muted">No submission yet. Saved drafts are not votes.</p>}
    {history.value?.items.map(({ record }) => <Submission key={record.id} review={record} labels={labels} />)}
    <div className="qc-toolbar">{cursor && <Button onClick={() => setCursor(undefined)}>Latest submissions</Button>}
      {history.value?.continuationToken && <Button onClick={() => setCursor(history.value?.continuationToken)}>Older submissions</Button>}</div>
  </section>
}
function PeerReviews({ workspaceId, scope, labels, allowed, coordinator, disabled, onExposed }: {
  workspaceId: string; scope: QcComparisonRef; labels: { id: string; label: string }[]; allowed: boolean; coordinator: boolean; disabled: boolean; onExposed: () => void
}) {
  const [reviews, setReviews] = useState<QcReviewSubmission[]>([])
  const [cursor, setCursor] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const request = useQcRequest()
  function load(more = false) {
    const next = more ? cursor : undefined
    void request.run(JSON.stringify({ scope, next }), (key, signal) => getQcPeers(workspaceId, scope, key, next, signal), value => {
      setReviews(current => more ? [...current, ...value.submissions.filter(row => !current.some(item => item.id === row.id))] : value.submissions)
      setCursor(value.continuationToken); setLoaded(true); onExposed()
    })
  }
  return <section className="qc-stack"><h2>{coordinator ? 'Coordinator aggregation view' : 'Peer feedback'}</h2>
    <p>{allowed ? 'Load deliberately. Peer exposure is recorded, and any later revision must not be described as independent. Each person’s submitted opinion is preserved.'
      : 'Hidden until you submit your own review of this exact result. There is no peer fetch before that submission.'}</p>
    {coordinator && <p className="qc-notice">Coordinator access deliberately bypasses peer blinding. Reading these opinions before reviewing makes subsequent feedback non-independent.</p>}
    <Button disabled={disabled || !allowed || request.pending || request.unresolved} onClick={() => load()}>{loaded ? 'Refresh peer feedback' : 'Load authorized peer feedback'}</Button>
    <QcRequestError request={request} />
    {loaded && <p className="qc-muted">{reviews.length} submitted opinions loaded · {reviews.reduce((count, row) => count + row.feedback.filter(item => item.decision === 'disagree').length, 0)} criterion disagreements.
      {' '}Drafts are excluded; submitted edits do not create additional reviewers. {cursor && 'This is a partial page; load more before interpreting coverage.'}</p>}
    {reviews.map(review => <Submission key={review.id} review={review} labels={labels} />)}
    {cursor && <Button disabled={disabled || request.pending || request.unresolved} onClick={() => load(true)}>Load more peer feedback</Button>}
  </section>
}
