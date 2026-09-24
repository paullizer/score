import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { History, LoaderCircle, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { useRealAnalyses, type RealAnalysesContextValue } from '../../app/real-analyses-context'
import { useWorkspace } from '../../app/workspace-context'
import { usePublicSettings } from '../../app/public-settings-context'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { Badge, Button, InlineError, Modal, Score } from '../../components/ui'
import {
  ANALYSIS_CORRECTION_LIMITS, ANALYSIS_CORRECTION_POLICY_VERSION, ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION,
  ANALYSIS_REASSESSMENT_POLICY_VERSION, isAnalysisReassessmentPolicy,
  type AnalysisActiveCorrection, type AnalysisCorrectionHistoryPage, type AnalysisCorrectionPolicyVersion, type AnalysisCorrectionPreview,
  type AnalysisCorrectionSummary,
} from '../../domain/analysis-corrections'
import type { RealAnalysisComparisonDetail, RealAnalysisComparisonSummary, RealAnalysisResultSummary } from '../../domain/real-analyses'
import type { Citation } from '../../domain/types'
import { getDisplayName } from '../../domain/displayNames'
import { dateLabel } from '../../domain/selectors'
import { workspaceCanEdit } from '../../domain/workspace-permissions'
import {
  cancelAnalysisCorrection, getAnalysisCorrection, getAnalysisCorrectionHistory,
  getAnalysisCorrectionPreview, requestAnalysisCorrection,
} from '../../services/analysisCorrections'
import { CloudApiError } from '../../services/cloudWorkspace'
import { boundedPollingInterval } from '../../services/publicSettings'
import { realAnalysisCancellationPending, targetVersionLabel } from './realAnalysisUi'
import { HistoricalCandidateNarrative } from './AnalysisSummaryHistory'
import {
  activeCorrectionNote, availableWithheldComparisons, boundedCorrectionWork, correctionActionAvailable, correctionIsActive,
  correctionPolicyReason, correctionStatusLabel, CorrectionRequestJournal, latestCorrectionFailure, reassessmentPolicyReason,
  type CorrectionAction,
} from './analysisCorrectionState'

// The bridge callback scopes in-memory replay keys to this authenticated workspace lifetime, not browser storage.
const journals = new WeakMap<RealAnalysesContextValue['ensureComparison'], Map<string, CorrectionRequestJournal>>()

function useCorrectionAccess(runId: string) {
  const api = useRealAnalyses()
  const { cloud, notify } = useWorkspace()
  const lifecycle = useLifecycleAccess({ kind: 'analysis', id: runId })
  const role = cloud?.workspaces.find(item => item.id === api?.workspaceId)?.role
  const identity = JSON.stringify([api?.workspaceId, cloud?.user.tenantId, cloud?.user.id, runId])
  const bridge = api?.ensureComparison
  const journal = useMemo(() => {
    if (!bridge) return new CorrectionRequestJournal()
    const scopes = journals.get(bridge) ?? new Map<string, CorrectionRequestJournal>()
    journals.set(bridge, scopes)
    const value = scopes.get(identity) ?? new CorrectionRequestJournal()
    scopes.set(identity, value)
    return value
  }, [bridge, identity])
  const readable = Boolean(api?.phase === 'ready' && cloud?.currentWorkspaceId === api.workspaceId && !lifecycle.deleting && !lifecycle.removed)
  const reviewer = readable && workspaceCanEdit(role)
  const run = api?.summaries.find(item => item.run.id === runId)
  const mutationReason = !readable ? 'The saved analysis is unavailable or being removed.'
    : !reviewer ? 'Only a workspace owner or editor can request or cancel evidence-gap corrections.'
    : lifecycle.archived || lifecycle.inherited ? 'Unarchive this analysis and its workspace before requesting or cancelling corrections.'
    : !lifecycle.canEdit || !api?.canWrite ? 'The workspace is read-only or a lifecycle change is in progress.'
    : run && realAnalysisCancellationPending(run) ? 'Wait for the run cancellation to finish before changing corrections.'
    : api.pending(runId) ? 'Wait for the current analysis request to finish.'
    : ''
  const reason = mutationReason || (api?.features?.analysisEvidenceCorrections !== true
    ? 'New evidence-gap correction requests are not enabled. Existing status, authorized cancellation, and history remain available.' : '')
  return { api, identity, readable, reviewer, writable: !reason, cancellable: !mutationReason,
    reason, cancellationReason: mutationReason, journal, notify }
}

type Access = ReturnType<typeof useCorrectionAccess>
interface CorrectionState { correction: AnalysisCorrectionSummary | null; loading: boolean; error: string }

function originalResultHash(summary: RealAnalysisComparisonSummary | undefined): string | undefined {
  return summary?.comparison.resultRevision?.originalResultSha256 ?? summary?.comparison.result?.sha256
}

function correctionError(caught: unknown, fallback: string, access: Access, runId: string): string {
  if (caught instanceof CloudApiError && [401, 403, 404].includes(caught.status)) void access.api?.ensureDetail(runId, true)
  return caught instanceof Error ? caught.message : fallback
}

function useCorrectionMonitor(access: Access, runId: string, comparisons: RealAnalysisComparisonSummary[], initialRead = false) {
  const pollingInterval = boundedPollingInterval(usePublicSettings().settings)
  const current = useRef({ access, runId, comparisons })
  current.current = { access, runId, comparisons }
  const [states, setStates] = useState<Record<string, CorrectionState>>({})
  const stateRef = useRef(states)
  const [paused, setPaused] = useState(false)
  const rounds = useRef(0)
  const lifetime = useRef<AbortController | null>(null)
  const readers = useRef(new Map<string, AbortController>())
  const busy = useRef(new Set<string>())
  const epochs = useRef(new Map<string, number>())
  const observed = useRef(new Map<string, string>())
  const publicationReads = useRef(new Map<string, symbol>())

  const update = useCallback((values: Record<string, CorrectionState>) => {
    stateRef.current = { ...stateRef.current, ...values }
    setStates(stateRef.current)
  }, [])

  const refreshPublications = useCallback(async (values: AnalysisCorrectionSummary[], signal: AbortSignal) => {
    const { access, runId, comparisons } = current.current
    if (!access.api || !access.readable || signal.aborted) return
    const changed = values.filter(value => {
      const revision = value.revision?.id
      if (!revision || publicationReads.current.has(value.comparisonId)) return false
      return comparisons.find(item => item.comparison.id === value.comparisonId)?.comparison.resultRevision?.id !== revision
    })
    if (!changed.length) return
    const api = access.api
    const opened = changed.filter(value => api.comparison(runId, value.comparisonId).state === 'ready')
    const reader = Symbol()
    for (const value of changed) publicationReads.current.set(value.comparisonId, reader)
    try {
      await Promise.all([api.ensureDetail(runId, true), api.ensureComparisons(runId, true)])
      if (signal.aborted || !current.current.access.readable) return
      const latest = current.current.access.api
      for (const view of [latest?.detail(runId), latest?.comparisons(runId)]) {
        if (view && 'error' in view && view.error) throw new Error(view.error)
      }
      await boundedCorrectionWork(opened, async value => {
        if (current.current.access.readable) await api.ensureComparison(runId, value.comparisonId, true)
      }, signal)
      if (signal.aborted) return
      const announced = changed.filter(value => observed.current.get(value.comparisonId) !== value.revision!.id)
      for (const value of announced) observed.current.set(value.comparisonId, value.revision!.id)
      if (announced.length) access.notify(`${announced.length} reviewed correction ${announced.length === 1 ? 'revision is' : 'revisions are'} published. Original results and history are retained.`)
    } catch (caught) {
      if (!signal.aborted) {
        const error = `Correction publication is confirmed, but the current score view could not refresh. Check correction status to retry. ${correctionError(caught, 'Saved results could not be reloaded.', access, runId)}`
        update(Object.fromEntries(changed.filter(value => stateRef.current[value.comparisonId]?.correction?.revision?.id === value.revision?.id)
          .map(value => [value.comparisonId, { ...stateRef.current[value.comparisonId], loading: false, error }])))
      }
    } finally {
      for (const value of changed) if (publicationReads.current.get(value.comparisonId) === reader) publicationReads.current.delete(value.comparisonId)
    }
  }, [update])

  const hold = useCallback((id: string) => {
    epochs.current.set(id, (epochs.current.get(id) ?? 0) + 1)
    readers.current.get(id)?.abort()
    readers.current.delete(id)
    busy.current.add(id)
    const previous = stateRef.current[id]
    if (previous?.loading) update({ [id]: { ...previous, loading: false } })
    return () => { busy.current.delete(id) }
  }, [update])

  const remember = useCallback((id: string, correction: AnalysisCorrectionSummary | null) => {
    epochs.current.set(id, (epochs.current.get(id) ?? 0) + 1)
    readers.current.get(id)?.abort()
    readers.current.delete(id)
    current.current.access.journal.acknowledge(id, correction)
    update({ [id]: { correction, loading: false, error: '' } })
    const signal = lifetime.current?.signal
    if (correction && signal && !signal.aborted) void refreshPublications([correction], signal)
  }, [refreshPublications, update])

  const load = useCallback(async (ids: string[]) => {
    const { access, runId } = current.current
    const life = lifetime.current
    if (!access.api || !access.readable || !life || life.signal.aborted) return
    const values: { id: string; epoch: number; value: CorrectionState }[] = []
    await boundedCorrectionWork(ids, async id => {
      if (busy.current.has(id) || readers.current.has(id)) return
      const request = new AbortController()
      const epoch = epochs.current.get(id) ?? 0
      readers.current.set(id, request)
      const signal = AbortSignal.any([life.signal, request.signal])
      update({ [id]: { correction: stateRef.current[id]?.correction ?? null, loading: true, error: '' } })
      try {
        const correction = await getAnalysisCorrection(access.api!.workspaceId, runId, id, signal,
          originalResultHash(current.current.comparisons.find(item => item.comparison.id === id)))
        signal.throwIfAborted()
        values.push({ id, epoch, value: { correction, loading: false, error: '' } })
      } catch (caught) {
        if (!signal.aborted) values.push({ id, epoch, value: {
          correction: stateRef.current[id]?.correction ?? null, loading: false,
          error: correctionError(caught, 'Correction status could not be checked. Publication is not confirmed.', access, runId),
        } })
      } finally {
        if (readers.current.get(id) === request) readers.current.delete(id)
      }
    }, life.signal)
    if (life.signal.aborted) return
    const accepted = values.filter(value => value.epoch === (epochs.current.get(value.id) ?? 0))
    for (const item of accepted) if (!item.value.error) {
      try { access.journal.acknowledge(item.id, item.value.correction) }
      catch (caught) {
        item.value = { correction: stateRef.current[item.id]?.correction ?? null, loading: false,
          error: correctionError(caught, 'Correction status did not acknowledge the reviewed request.', access, runId) }
      }
    }
    update(Object.fromEntries(accepted.map(value => [value.id, value.value])))
    await refreshPublications(accepted.flatMap(({ value }) => !value.error && value.correction ? [value.correction] : []), life.signal)
  }, [refreshPublications, update])

  const check = useCallback(async (ids: string[]) => {
    rounds.current = 0
    setPaused(false)
    await load(ids)
  }, [load])

  useEffect(() => {
    const life = new AbortController()
    lifetime.current = life
    const activeReaders = readers.current
    let timer: ReturnType<typeof setTimeout> | undefined
    async function tick() {
      if (life.signal.aborted || !current.current.access.readable) return
      const ids = current.current.comparisons.map(item => item.comparison.id).filter(id => {
        const entry = stateRef.current[id]
        return entry && !entry.error && !busy.current.has(id) &&
          (correctionIsActive(entry.correction) || current.current.access.journal.get(id))
      })
      if (ids.length && rounds.current < 40) {
        rounds.current++
        await load(ids)
      } else if (ids.length) setPaused(true)
      if (!life.signal.aborted) timer = setTimeout(() => void tick(), pollingInterval)
    }
    if (access.readable) {
      if (initialRead) void load(current.current.comparisons.map(item => item.comparison.id))
      timer = setTimeout(() => void tick(), pollingInterval)
    }
    return () => {
      life.abort()
      if (timer) clearTimeout(timer)
      activeReaders.forEach(request => request.abort())
      activeReaders.clear()
    }
  }, [access.identity, access.readable, initialRead, load, pollingInterval])

  return { states, paused, check, remember, hold }
}

function SummaryValue({ summary }: { summary: RealAnalysisResultSummary }) {
  return summary.overall.status === 'available' ? <Score value={summary.overall.score} /> : <span>
    <strong>Score withheld</strong><span className="mt-1 block text-[11px] text-muted">{summary.overall.message}</span>
  </span>
}

function reassessmentCriterionLabel(preview: AnalysisCorrectionPreview, criterionId: string): string {
  if (!preview.reassessment.eligible) return 'Not assessed'
  return preview.reassessment.criterionIds.includes(criterionId)
    ? 'Not assessed — the re-score assesses it again with every other criterion'
    : 'Not assessed — carries no weight in the total'
}

function correctionPolicy(correction: AnalysisCorrectionSummary): AnalysisCorrectionPolicyVersion | undefined {
  return correction.policyVersion ?? (correction.status === 'ready' ? correction.revision?.policyVersion : undefined)
}

function CorrectionStatus({ correction }: { correction: AnalysisCorrectionSummary }) {
  const policy = correctionPolicy(correction)
  const reassessment = isAnalysisReassessmentPolicy(policy)
  const scoped = policy === ANALYSIS_CORRECTION_POLICY_VERSION
  const status = correctionStatusLabel(correction.status, policy)
  return <div className="space-y-2 text-[12px]">
    <Badge tone={correction.status === 'ready' ? 'success' : correction.status === 'failed' ? 'danger' : 'warning'}>{status}</Badge>
    <p>Requested {dateLabel(correction.requestedAt)} · processing attempts {correction.attempts}</p>
    <p>{reassessment ? 'Full re-score with the current rules: the assessment, evidence-gap review, and independent grounding review run again against the same frozen resume and rubric. The server publishes the new result only after it passes grounding review, even when its total is still withheld.'
      : scoped ? 'Selected evidence gaps only: unchanged numeric scores are not re-reviewed. The server publishes automatically only after every selected gap is verified as missing.'
      : 'Legacy full-assessment grounding review: the entire proposal, including unchanged scores, must pass before publication.'}</p>
    {correction.nextAttemptAt && <p className="text-muted">Next server attempt: {dateLabel(correction.nextAttemptAt)}</p>}
    {correction.error && <InlineError>{correction.error.stage} · {correction.error.code}: {correction.error.message}</InlineError>}
    {['failed', 'cancelled'].includes(correction.status) && <p>The original or last published result remains current. Load a fresh preview before requesting another review.</p>}
    <details><summary className="cursor-pointer font-semibold">{reassessment ? 'Re-score request details' : 'Correction request details'}</summary>
      <dl className="mt-2 space-y-2 break-words text-[11px]">
        <div><dt>Request ID</dt><dd className="break-all">{correction.requestId}</dd></div>
        <div><dt>Requested by</dt><dd>{correction.requestedBy}</dd></div>
        <div><dt>Reason</dt><dd>{correction.reason}</dd></div>
        <div><dt>Request policy</dt><dd>{policy ?? `${ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION} (legacy record)`}</dd></div>
        <div><dt>{reassessment ? 'Weighted criteria that were not assessed' : 'Selected criteria'}</dt><dd>{correction.criterionIds.join(', ')}</dd></div>
      </dl>
    </details>
  </div>
}

/** Status-only view of accepted work that every reader may see; its audited request details stay with owners and editors. */
export function ActiveCorrectionStatus({ active, table = false }: { active: AnalysisActiveCorrection; table?: boolean }) {
  const label = correctionStatusLabel(active.status, active.policyVersion)
  if (table) return <div><Badge dot tone="neutral">{label}</Badge><p className="row-meta max-w-xs">{activeCorrectionNote(active)}</p></div>
  return <div className="space-y-2 text-[12px]" role="status">
    <Badge tone="warning">{label}</Badge>
    <p>{activeCorrectionNote(active)}</p>
    <p className="text-[11px] text-muted">Workspace owners and editors can see its request details.</p>
  </div>
}

export function ReviewWithheldScores({ runId, comparisons, available }: {
  runId: string; comparisons: RealAnalysisComparisonSummary[]; available: boolean
}) {
  const access = useCorrectionAccess(runId)
  const [selection, setSelection] = useState<RealAnalysisComparisonSummary[] | null>(null)
  const withheld = availableWithheldComparisons(comparisons)
  return <>
    <Button icon={ShieldCheck} disabled={!available || !access.writable || withheld.length === 0}
      title={access.reason || 'Review every currently available completed comparison with a withheld score. Table filters do not change this scope.'}
      onClick={() => setSelection([...withheld])}>Review withheld scores ({withheld.length})</Button>
    {selection && access.reviewer && <CorrectionReviewDialog key={access.identity} runId={runId} comparisons={selection}
      onClose={() => setSelection(null)} />}
  </>
}

interface ReviewRow {
  summary: RealAnalysisComparisonSummary
  preview: AnalysisCorrectionPreview | null
  selected: boolean
  loading: boolean
  phase: 'review' | 'submitting' | 'ambiguous' | 'rejected' | 'accepted'
  error: string
  requestId?: string
}

function CorrectionReviewDialog({ runId, comparisons, initialCorrection, onClose }: {
  runId: string; comparisons: RealAnalysisComparisonSummary[]; initialCorrection?: AnalysisCorrectionSummary | null; onClose: () => void
}) {
  const access = useCorrectionAccess(runId)
  const accessRef = useRef(access)
  accessRef.current = access
  const monitor = useCorrectionMonitor(access, runId, comparisons)
  const monitorRef = useRef(monitor)
  monitorRef.current = monitor
  const fieldId = useId()
  const [rows, setRows] = useState<ReviewRow[]>(() => comparisons.map(summary => ({
    summary, preview: null, selected: false, loading: true, phase: 'review', error: '',
  })))
  const rowsRef = useRef(rows)
  const [action, setAction] = useState<CorrectionAction>('reassess')
  const actionRef = useRef<CorrectionAction>('reassess')
  const [reason, setReason] = useState(reassessmentPolicyReason)
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const batch = useRef(false)
  const [message, setMessage] = useState('')
  const [findingsKey, setFindingsKey] = useState<string | null>(null)
  const lifetime = useRef<AbortController | null>(null)
  const operations = useRef(new Map<string, AbortController>())
  // The comparison table follows accepted work through the saved list, so refresh it once when a review that sent anything closes.
  const sent = useRef({ changed: false })
  const refreshComparisons = access.api?.ensureComparisons
  useEffect(() => {
    const session = sent.current
    return () => { if (session.changed) void refreshComparisons?.(runId, true) }
  }, [refreshComparisons, runId])

  const remember = monitor.remember
  useEffect(() => {
    if (initialCorrection) remember(initialCorrection.comparisonId, initialCorrection)
  }, [initialCorrection, remember])

  const patchRow = useCallback((id: string, patch: Partial<ReviewRow>) => {
    rowsRef.current = rowsRef.current.map(row => row.summary.comparison.id === id ? { ...row, ...patch } : row)
    setRows(rowsRef.current)
  }, [])

  const preview = useCallback(async (id: string) => {
    const access = accessRef.current
    const life = lifetime.current
    if (!access.api || !access.reviewer || !life || life.signal.aborted || operations.current.has(id)) return
    const request = new AbortController()
    operations.current.set(id, request)
    const release = monitorRef.current.hold(id)
    const signal = AbortSignal.any([life.signal, request.signal])
    patchRow(id, { loading: true, selected: false, error: '' })
    setConfirmed(false)
    try {
      const value = await getAnalysisCorrectionPreview(access.api.workspaceId, runId, id, signal,
        originalResultHash(rowsRef.current.find(row => row.summary.comparison.id === id)?.summary))
      signal.throwIfAborted()
      const pending = access.journal.get(id)
      const acknowledged = Boolean(pending && value.correction?.requestId === pending.key)
      monitorRef.current.remember(id, value.correction)
      patchRow(id, {
        preview: value, loading: false, phase: acknowledged ? 'accepted' : pending ? 'ambiguous' : 'review',
        requestId: pending?.key,
        selected: !pending && correctionActionAvailable(value, actionRef.current) && !correctionIsActive(value.correction),
      })
    } catch (caught) {
      if (!signal.aborted) patchRow(id, { loading: false, preview: null, error: correctionError(caught, 'This comparison preview could not be loaded.', access, runId) })
    } finally {
      operations.current.delete(id)
      release()
    }
  }, [patchRow, runId])

  useEffect(() => {
    const life = new AbortController()
    lifetime.current = life
    const active = operations.current
    void boundedCorrectionWork(rowsRef.current.map(row => row.summary.comparison.id), preview, life.signal)
    return () => {
      life.abort()
      active.forEach(request => request.abort())
      active.clear()
    }
  }, [access.identity, preview])

  useEffect(() => {
    for (const row of rowsRef.current) {
      const id = row.summary.comparison.id
      const state = monitor.states[id]
      if (row.phase === 'ambiguous' && row.requestId && state && !state.error &&
        state.correction?.requestId === row.requestId && !access.journal.get(id)) {
        patchRow(id, { phase: 'accepted', error: '', selected: false })
      }
    }
  }, [access.journal, monitor.states, patchRow])

  function selectable(row: ReviewRow): boolean {
    const correction = monitor.states[row.summary.comparison.id]?.correction ?? row.preview?.correction
    return row.phase === 'review' && !row.loading && !row.error && correctionActionAvailable(row.preview, action) &&
      correction?.etag === row.preview?.correction?.etag &&
      !correctionIsActive(correction) && !access.journal.get(row.summary.comparison.id)
  }
  function choose(next: CorrectionAction) {
    if (next === actionRef.current || submitting) return
    const previousDefault = actionRef.current === 'reassess' ? reassessmentPolicyReason : correctionPolicyReason
    actionRef.current = next
    setAction(next)
    setConfirmed(false)
    setReason(value => value.trim() === previousDefault ? next === 'reassess' ? reassessmentPolicyReason : correctionPolicyReason : value)
    rowsRef.current = rowsRef.current.map(row => ({
      ...row, selected: row.phase === 'review' && !row.loading && !row.error && !access.journal.get(row.summary.comparison.id) &&
        correctionActionAvailable(row.preview, next) && !correctionIsActive(row.preview?.correction),
    }))
    setRows(rowsRef.current)
  }
  const reassess = action === 'reassess'
  const selected = rows.filter(row => row.selected && selectable(row))
  const awaitingPreview = rows.filter(row => row.loading).length
  const rejected = rows.filter(row => row.error || monitor.states[row.summary.comparison.id]?.error).length
  const acknowledged = rows.filter(row => row.requestId && !access.journal.get(row.summary.comparison.id) &&
    monitor.states[row.summary.comparison.id]?.correction?.requestId === row.requestId).length
  const ambiguous = rows.filter(row => access.journal.get(row.summary.comparison.id)).length
  const blocked = rows.filter(row => row.preview && !correctionActionAvailable(row.preview, action)).length
  const savedStatuses = rows.map(row => (monitor.states[row.summary.comparison.id]?.correction ?? row.preview?.correction)?.status)
  const scopedSelection = !reassess && selected.some(row => row.preview?.policyVersion === ANALYSIS_CORRECTION_POLICY_VERSION)
  const legacySelection = !reassess && selected.some(row => row.preview?.policyVersion === ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION)
  const canSubmit = access.writable && !submitting && !awaitingPreview && selected.length > 0 && confirmed &&
    reason.trim().length >= 10 && reason.trim().length <= 1000

  async function send(row: ReviewRow, replay = false): Promise<boolean> {
    const access = accessRef.current
    const id = row.summary.comparison.id
    const life = lifetime.current
    if (!access.api || !access.writable || !life || life.signal.aborted || operations.current.has(id) || (!row.preview && !replay)) return false
    const saved = replay ? access.journal.get(id) : row.preview ? access.journal.prepare(id, row.preview, reason, actionRef.current) : undefined
    if (!saved) return false
    const request = new AbortController()
    operations.current.set(id, request)
    const release = monitorRef.current.hold(id)
    const signal = AbortSignal.any([life.signal, request.signal])
    patchRow(id, { phase: 'submitting', selected: false, error: '', requestId: saved.key })
    sent.current.changed = true
    try {
      const response = await requestAnalysisCorrection(access.api.workspaceId, runId, id, saved.input, saved.etag, saved.key, signal)
      signal.throwIfAborted()
      monitorRef.current.remember(id, response.correction)
      patchRow(id, { phase: 'accepted' })
      return true
    } catch (caught) {
      if (!signal.aborted) {
        const definitive = access.journal.reject(id, caught)
        patchRow(id, { phase: definitive ? 'rejected' : 'ambiguous',
          error: correctionError(caught, 'The correction request was not acknowledged.', access, runId) })
      }
      return false
    } finally {
      operations.current.delete(id)
      release()
    }
  }

  async function submit() {
    if (!canSubmit || batch.current || !lifetime.current) return
    batch.current = true
    setSubmitting(true)
    setConfirmed(false)
    setMessage('')
    const chosen = [...selected]
    let accepted = 0
    await boundedCorrectionWork(chosen, async row => { if (await send(row)) accepted++ }, lifetime.current.signal)
    if (lifetime.current.signal.aborted) return
    setMessage(`Submission receipt: ${accepted} of ${chosen.length} selected ${reassess ? 're-score' : 'correction'} requests acknowledged. ${chosen.length - accepted} not acknowledged; inspect each outcome below. An acknowledgement schedules ${reassess ? 'the re-score' : 'review'}, not publication.`)
    batch.current = false
    setSubmitting(false)
  }

  async function cancel(id: string) {
    const access = accessRef.current
    const correction = monitorRef.current.states[id]?.correction
    const life = lifetime.current
    if (!access.api || !access.cancellable || !correction || !correctionIsActive(correction) || !life || life.signal.aborted || operations.current.has(id)) return
    const request = new AbortController()
    operations.current.set(id, request)
    const release = monitorRef.current.hold(id)
    const signal = AbortSignal.any([life.signal, request.signal])
    patchRow(id, { phase: 'submitting', error: '' })
    sent.current.changed = true
    try {
      const response = await cancelAnalysisCorrection(access.api.workspaceId, runId, id, correction, signal)
      signal.throwIfAborted()
      monitorRef.current.remember(id, response.correction)
      patchRow(id, { phase: 'accepted', selected: false })
    } catch (caught) {
      if (!signal.aborted) patchRow(id, { phase: 'accepted', error: correctionError(caught, 'Cancellation could not be acknowledged. Check status before trying again.', access, runId) })
    } finally { operations.current.delete(id); release() }
  }

  return <Modal open onOpenChange={open => { if (!open) onClose() }} wide title="Review withheld scores"
    description="Choose how to resolve each withheld total, review the read-only server preview, then authorize the policy shown for each comparison."
    footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" icon={submitting ? LoaderCircle : ShieldCheck}
      disabled={!canSubmit} onClick={() => void submit()}>{reassess ? 'Re-score' : 'Confirm review for'} {selected.length} {selected.length === 1 ? 'comparison' : 'comparisons'}</Button></>}>
    <div className="space-y-5">
      <p className="text-[13px]"><strong>Exact scope: {comparisons.length} currently available withheld {comparisons.length === 1 ? 'comparison' : 'comparisons'}.</strong>
        {' '}This saved selection does not follow table search or target filters. Numeric results and processing failures are excluded; retry failed comparisons from the run actions. Every selected comparison has its own request; no 25-item truncation is applied.</p>
      <fieldset className="space-y-2 text-[12px]" disabled={submitting}>
        <legend className="mb-1 font-semibold">How should the selected withheld scores be resolved?</legend>
        <label className="flex items-start gap-3"><input type="radio" className="mt-1" name={`${fieldId}-action`} checked={reassess}
          onChange={() => choose('reassess')} />
          <span><strong>Re-score with the current rules (recommended)</strong><span className="mt-1 block text-muted">
            Runs the whole assessment again — assessment, evidence-gap review, and independent grounding review — with the current prompts and models against the same frozen resume and rubric. Any criterion score can change. The server publishes the new result only after it passes grounding review.
          </span></span></label>
        <label className="flex items-start gap-3"><input type="radio" className="mt-1" name={`${fieldId}-action`} checked={!reassess}
          onChange={() => choose('missing-evidence')} />
          <span><strong>Record verified missing evidence as 0 / 5</strong><span className="mt-1 block text-muted">
            Keeps the saved assessment and existing numeric scores. AI verifies only the selected evidence gaps; each confirmed gap becomes 0 / 5 at its original weight.
          </span></span></label>
      </fieldset>
      {reassess ? <p className="text-[12px]">Opening this preview applies nothing, and no total can be predicted before the AI runs.
        {' '}Under {ANALYSIS_REASSESSMENT_POLICY_VERSION}, only this comparison moves to the current rules; the other comparisons in this run keep the rules they were scored with.
        {' '}A re-score can still withhold the total when the evidence genuinely cannot be assessed. Unreadable sources, protected traits, and failed processing are never scored as zeros.
        {' '}If the re-score fails or does not pass grounding review, the current result stays in place. The original scores, rationale, source evidence, and history are retained.</p>
        : <><p className="text-[12px]">Only missing professional evidence in a successfully reviewed source may become <strong>0 / 5</strong>.
          {' '}Unreadable sources, protected traits, failed processing, and genuine interpretation blockers must remain unscored. Existing numeric scores and weights are unchanged.</p>
        <p className="text-[12px]">Opening this preview applies nothing. The original scores, rationale, source evidence, and history are retained.
          {' '}For {ANALYSIS_CORRECTION_POLICY_VERSION}, AI verifies <strong>only the selected evidence gaps</strong>, not the whole assessment or unchanged numeric scores.
          {' '}Once every selected gap is confirmed missing, the server automatically publishes zeros at their original weights.
          {' '}Supporting evidence, genuine blockers, or processing and publication failures still prevent publication. Legacy requests retain full-assessment grounding review.</p></>}
      <p className="text-[11px] text-muted">Summary failures are separate and are not repaired by substituting scores. Private failure findings load only when opened, one comparison at a time.</p>
      <div className="space-y-2 text-[12px]" role="status" aria-live="polite">
        <p>{selected.length} selected · {awaitingPreview} loading previews · {blocked} {reassess ? 'not eligible for a re-score' : 'without selectable criteria'} · {rejected} with errors</p>
        <p>{acknowledged} requests acknowledged in this review · {ambiguous} awaiting acknowledgement. Server work continues after this dialog closes.</p>
        <p>Saved server status: {savedStatuses.filter(status => status === 'queued').length} queued · {savedStatuses.filter(status => status === 'running').length} running · {savedStatuses.filter(status => status === 'ready').length} published · {savedStatuses.filter(status => status === 'failed').length} failed · {savedStatuses.filter(status => status === 'cancelled').length} cancelled.</p>
        {message && <p>{message}</p>}
        {monitor.paused && <p>Automatic status checks are paused after 40 bounded checks. Use Check correction status to continue; no request will be retried automatically.</p>}
      </div>
      {!access.writable && <InlineError>{access.reason}</InlineError>}
      <div><label htmlFor={`${fieldId}-reason`} className="mb-2 block text-[12px] font-semibold">Reason recorded in the audit history</label>
        <textarea id={`${fieldId}-reason`} className="w-full rounded-lg border bg-[var(--cp-surface)] p-3 text-[12px] text-[var(--cp-text)]"
          rows={4} minLength={10} maxLength={1000} value={reason} disabled={submitting}
          onChange={event => { setReason(event.target.value); setConfirmed(false) }} />
        <p className="mt-1 text-[11px] text-muted">10–1000 characters. An interrupted request keeps its original policy version, reason, result hash, ETag, criteria, and key.</p>
      </div>
      <div className="space-y-4">{rows.map(row => {
        const pair = row.summary.comparison
        const state = monitor.states[pair.id]
        const correction = state?.correction ?? row.preview?.correction
        const pending = access.journal.get(pair.id)
        const source = getDisplayName(pair.resume.summary, pair.resume.summary.name?.trim() || 'Name not stated')
        const target = getDisplayName(pair.target.summary, pair.target.summary.label)
        const busy = row.loading || row.phase === 'submitting'
        const failureKey = correction ? JSON.stringify([pair.id, correction.requestId]) : null
        return <section key={pair.id} className="space-y-3 rounded-xl border p-4 text-[12px]" aria-label={`Correction review: ${source} against ${target}`}>
          <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={row.selected && selectable(row)}
            disabled={!selectable(row) || submitting || !access.writable}
            onChange={event => { patchRow(pair.id, { selected: event.target.checked }); setConfirmed(false) }} />
            <span><strong>{source} → {target}</strong><span className="mt-1 block text-[11px] text-muted">
              {pair.resume.summary.sourceLabel} · resume document v{pair.resume.summary.selection.documentVersion} · {targetVersionLabel(pair.target.summary.selection)}
            </span><span className="mt-1 block break-all text-[10px] text-muted">Comparison: {pair.id}</span></span>
          </label>
          {row.loading && <p role="status" className="flex items-center gap-2"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />Loading read-only preview…</p>}
          {row.preview && <>
            {reassess ? <p><strong>Re-score policy: {row.preview.reassessment.policyVersion}.</strong>{' '}
              {row.preview.reassessment.eligible
                ? 'Confirming authorizes a full re-score of this comparison with the current rules, then automatic server publication only if the new result passes grounding review.'
                : `Not eligible: ${row.preview.reassessment.blockedReason}`}</p>
              : <p><strong>Preview policy: {row.preview.policyVersion}.</strong>{' '}
                {row.preview.policyVersion === ANALYSIS_CORRECTION_POLICY_VERSION
                  ? 'Confirming authorizes selected-gap AI verification, then automatic server publication if every gap is confirmed missing. Existing numeric scores are not reapproved.'
                  : 'This legacy proposal requires a fresh full-assessment grounding review before it can publish.'}</p>}
            <div className="grid gap-4 sm:grid-cols-2"><div><h3 className="mb-2 font-semibold">Current saved result before this request</h3><SummaryValue summary={row.preview.before} /></div>
              <div><h3 className="mb-2 font-semibold">{reassess ? 'After the re-score' : 'Server preview — not published'}</h3>{reassess
                ? <p>{row.preview.reassessment.eligible ? 'Determined by the re-score. No total is predicted before the AI runs.' : 'No re-score is available for this comparison.'}</p>
                : row.preview.after ? <SummaryValue summary={row.preview.after} /> : <p>No selectable missing-evidence correction.</p>}</div></div>
            <ul className="space-y-3">{row.preview.criteria.map(criterion => <li key={criterion.criterionId} className="rounded-lg border p-3">
              <h4 className="font-semibold">{criterion.label} · {criterion.weight}% weight</h4>
              <p className="mt-1">{reassess ? reassessmentCriterionLabel(row.preview!, criterion.criterionId)
                : criterion.eligible ? 'Proposed: not assessed → missing evidence, 0 / 5' : 'Not assessed — blocked; no zero proposed'}</p>
              <p className="mt-1 whitespace-pre-wrap">{criterion.rationale}</p>
              <p className="mt-1 text-muted">Saved limitation: {criterion.limitation.message}</p>
              {!reassess && criterion.blockedReason && <p className="mt-2 font-semibold">Blocked: {criterion.blockedReason}</p>}
            </li>)}</ul>
            <details><summary className="cursor-pointer font-semibold">Immutable original and reviewed result hashes</summary>
              <p className="mt-2 break-all">Original SHA-256: {row.preview.originalResultSha256}</p>
              <p className="mt-2 break-all">Reviewed base SHA-256: {row.preview.resultSha256}</p>
            </details>
          </>}
          {correction && <CorrectionStatus correction={correction} />}
          {correction?.status === 'failed' && access.reviewer && <>
            <Button size="sm" icon={History} aria-expanded={findingsKey === failureKey}
              onClick={() => setFindingsKey(findingsKey === failureKey ? null : failureKey)}>
              {findingsKey === failureKey ? 'Hide failure findings' : 'View failure findings'}
            </Button>
            {findingsKey === failureKey && <CorrectionFailureFindings key={failureKey} access={access} runId={runId}
              correction={correction} originalSha256={originalResultHash(row.summary)}
              criterionLabels={Object.fromEntries(row.preview?.criteria.map(item => [item.criterionId, item.label]) ?? [])}
              onClose={() => setFindingsKey(null)} />}
          </>}
          {row.phase === 'submitting' && <p role="status">Waiting for acknowledgement…</p>}
          {(row.error || state?.error) && <InlineError>{row.error || state?.error}</InlineError>}
          {pending && row.phase !== 'submitting' && <div className="space-y-2">
            <p>Publication is not confirmed. Check status or explicitly replay this same request; a new key will not be created.</p>
            <p className="break-all text-[11px]">Retained request: {pending.key}</p><p className="text-[11px]">Retained reason: {pending.input.reason}</p>
            <p className="text-[11px]">Retained policy: {pending.input.policyVersion ?? `${ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION} (unversioned legacy request)`}.
              {' '}{isAnalysisReassessmentPolicy(pending.input.policyVersion) ? 'Full re-score with the current rules.'
                : pending.input.policyVersion === ANALYSIS_CORRECTION_POLICY_VERSION ? 'Selected evidence-gap verification only.' : 'Full-assessment grounding review.'}</p>
            <Button size="sm" disabled={!access.writable || submitting || busy} onClick={() => void send(row, true)}>Retry same request</Button>
          </div>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={RotateCcw} disabled={submitting || busy || !access.reviewer || Boolean(pending)}
              onClick={() => void preview(pair.id)}>Load fresh preview</Button>
            {(correction || pending || state?.error) && <Button size="sm" disabled={busy || state?.loading || !access.readable}
              onClick={() => void monitor.check([pair.id])}>Check correction status</Button>}
            {correctionIsActive(correction) && <Button size="sm" icon={X} disabled={!access.cancellable || submitting || busy}
              title={access.cancellationReason || 'Cancel this existing request without scheduling a new correction.'}
              onClick={() => void cancel(pair.id)}>Cancel correction</Button>}
          </div>
        </section>
      })}</div>
      <label className="flex items-start gap-3 text-[12px]"><input id={`${fieldId}-confirm`} type="checkbox" className="mt-1"
        checked={confirmed} disabled={!access.writable || submitting || awaitingPreview > 0 || selected.length === 0}
        onChange={event => setConfirmed(event.target.checked)} />
        <span>I reviewed all {selected.length} selected comparisons, {reassess ? 'their eligibility, and their current saved totals' : 'their affected criteria, blocked reasons, and server preview totals'}.
          {reassess && selected.length > 0 && <> I authorize a full AI re-score of each selected comparison with the current rules and automatic server publication of any new result that passes grounding review, even if it changes existing numeric scores or still withholds the total.</>}
          {scopedSelection && <> I authorize AI verification of only the selected evidence gaps and automatic server publication after every selected gap is confirmed missing, at original weights and without changing existing numeric scores.</>}
          {legacySelection && <> For selected legacy proposals, I authorize full-assessment grounding review; only a supported full review may publish.</>}
          {' '}Original source evidence and history must be retained. Confirmation or acknowledgement alone is not publication.</span>
      </label>
    </div>
  </Modal>
}

export function AnalysisCorrectionDetails({ detail }: { detail: RealAnalysisComparisonDetail }) {
  const access = useCorrectionAccess(detail.comparison.runId)
  if (!access.readable) return null
  return <ComparisonCorrectionDetails key={`${access.identity}:${detail.comparison.id}`} detail={detail} />
}

function ComparisonCorrectionDetails({ detail }: { detail: RealAnalysisComparisonDetail }) {
  const { comparison } = detail
  const access = useCorrectionAccess(comparison.runId)
  const [reviewOpen, setReviewOpen] = useState(false)
  // Private request status is owner/editor-only; other readers see the status-only projection on the comparison itself.
  const monitor = useCorrectionMonitor({ ...access, readable: access.readable && access.reviewer && !reviewOpen }, comparison.runId, [detail], true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [failureRequestId, setFailureRequestId] = useState<string | null>(null)
  const historyId = useId()
  const state = monitor.states[comparison.id]
  const revision = comparison.resultRevision
  const historyRevision = state?.correction?.hasHistory
    ? `${state.correction.requestId}:${correctionIsActive(state.correction) ? 'pending' : state.correction.status}:${state.correction.revision?.id ?? 'none'}`
    : 'original'
  const withheld = comparison.status === 'complete' && comparison.resultSummary?.overall.status === 'withheld'
  const existingWork = correctionIsActive(state?.correction) || Boolean(access.journal.get(comparison.id))
  return <section className="panel mt-5 space-y-4 p-5" aria-label="Re-scores, evidence-gap corrections, and revision history">
    <h2 className="text-[15px] font-semibold">Result revisions, re-scores, and evidence-gap corrections</h2>
    {revision ? isAnalysisReassessmentPolicy(revision.policyVersion) ? <div className="space-y-2 text-[12px]">
      <Badge tone="accent">Current re-scored revision</Badge>
      <p>Published {dateLabel(revision.correctedAt)} under policy {revision.policyVersion}. The whole comparison was re-scored with the rules that were current when it was requested, against the same frozen resume and rubric; criterion scores can differ from the original.</p>
      <p>The new result passed an independent grounding review before publication.</p>
      <p className="break-all text-[11px]">Revision: {revision.id}</p>
      <p className="break-all text-[11px]">Original result SHA-256: {revision.originalResultSha256}</p>
      <p className="break-all text-[11px]">Reviewed base SHA-256: {revision.baseResultSha256}</p>
    </div> : <div className="space-y-2 text-[12px]">
      <Badge tone="accent">Current reviewed correction revision</Badge>
      <p>Published {dateLabel(revision.correctedAt)} under policy {revision.policyVersion}. Only the selected missing-evidence criteria changed; existing numeric scores, weights, and frozen sources are retained.</p>
      <p>{revision.policyVersion === ANALYSIS_CORRECTION_POLICY_VERSION
        ? 'This revision verified selected evidence gaps only. It did not independently reapprove unchanged numeric scores or the full assessment.'
        : 'This legacy revision passed a full-assessment grounding review before publication.'}</p>
      <p className="break-all text-[11px]">Revision: {revision.id}</p>
      <p className="break-all text-[11px]">Original result SHA-256: {revision.originalResultSha256}</p>
      <p className="break-all text-[11px]">Reviewed base SHA-256: {revision.baseResultSha256}</p>
    </div> : <p className="text-[12px]">The original saved result is shown. A re-score or reviewed correction publishes a separate current revision; it never overwrites the original result or source evidence.</p>}
    <p className="text-[11px] text-muted">Missing professional evidence in a successfully reviewed source can be 0/5. Processing failures, unreadable sources, protected traits, and genuine assessment blockers are not zeros. Narrative-summary failures are separate from score withholding.</p>
    {state?.correction && <CorrectionStatus correction={state.correction} />}
    {!access.reviewer && detail.activeCorrection && <ActiveCorrectionStatus active={detail.activeCorrection} />}
    {state?.correction?.status === 'failed' && access.reviewer && <div className="space-y-3">
      <Button size="sm" icon={History} aria-expanded={failureRequestId === state.correction.requestId}
        onClick={() => setFailureRequestId(failureRequestId === state.correction!.requestId ? null : state.correction!.requestId)}>
        {failureRequestId === state.correction.requestId ? 'Hide failure findings' : 'View failure findings'}
      </Button>
      {failureRequestId === state.correction.requestId && <CorrectionFailureFindings key={state.correction.requestId}
        access={access} runId={comparison.runId} correction={state.correction} originalSha256={originalResultHash(detail)}
        criterionLabels={Object.fromEntries((detail.targetSnapshot.kind === 'job' ? detail.targetSnapshot.rubric : detail.targetSnapshot.version.rubric)
          .criteria.map(item => [item.id, item.label]))} onClose={() => setFailureRequestId(null)} />}
    </div>}
    {state?.loading && <p className="text-[12px]" role="status">Checking saved correction status…</p>}
    {state?.error && <InlineError>{state.error}</InlineError>}
    {monitor.paused && <p className="text-[12px]" role="status">Automatic status checks paused. Check correction status to resume bounded polling.</p>}
    <div className="flex flex-wrap gap-2">
      {(withheld || existingWork) && <Button disabled={existingWork ? !access.reviewer : !access.writable}
        title={existingWork ? 'Inspect existing correction work. Authorized cancellation remains available even when new requests are disabled.'
          : access.reason || 'Preview this exact comparison; no changes are applied on opening.'}
        onClick={() => setReviewOpen(true)}>{existingWork ? 'Manage current correction' : 'Review this withheld score'}</Button>}
      {access.reviewer && <Button size="sm" icon={RotateCcw} disabled={!access.readable || state?.loading}
        onClick={() => void monitor.check([comparison.id])}>Check correction status</Button>}
      {access.reviewer && <Button size="sm" icon={History} aria-expanded={historyOpen} aria-controls={historyId}
        onClick={() => setHistoryOpen(value => !value)}>{historyOpen ? 'Close correction history' : 'Original result and correction history'}</Button>}
    </div>
    {withheld && !access.writable && <p className="text-[11px] text-muted">{access.reason}</p>}
    {historyOpen && access.reviewer && <div id={historyId}><CorrectionHistory key={historyRevision}
      runId={comparison.runId} comparisonId={comparison.id} originalSha256={originalResultHash(detail)} criterionLabels={Object.fromEntries(
        (detail.targetSnapshot.kind === 'job' ? detail.targetSnapshot.rubric : detail.targetSnapshot.version.rubric)
          .criteria.map(criterion => [criterion.id, criterion.label]),
      )} /></div>}
    {reviewOpen && access.reviewer && <CorrectionReviewDialog runId={comparison.runId} comparisons={[detail]}
      initialCorrection={state?.correction} onClose={() => {
      setReviewOpen(false)
      void monitor.check([comparison.id])
    }} />}
  </section>
}

function HistoricalCitations({ citations, label }: { citations: Citation[]; label: string }) {
  return <div className="space-y-2"><h5 className="font-semibold">{label}</h5>{citations.length
    ? citations.map((citation, index) => <blockquote key={index} className="border-l pl-3">
      <q>{citation.quote}</q><p className="mt-1 text-[11px] text-muted">{citation.heading} · document v{citation.documentVersion} · page {citation.page}</p>
    </blockquote>) : <p className="text-muted">No quotation was saved for this row.</p>}</div>
}

function CorrectionReviewFindings({ review, policyVersion, criterionLabels }: {
  review: NonNullable<AnalysisCorrectionHistoryPage['entries'][number]['review']>; policyVersion: AnalysisCorrectionPolicyVersion
  criterionLabels: Record<string, string>
}) {
  const scope = review.scope
  const reassessed = isAnalysisReassessmentPolicy(policyVersion)
  return <div className="space-y-3">
    <h4 className="font-semibold">{scope ? 'Selected evidence-gap verification' : reassessed ? 'Re-score grounding review' : 'Legacy full-assessment grounding review'}: {review.outcome}</h4>
    {scope ? <>
      <p>Only these selected gaps were verified. Unchanged numeric scores and the full assessment were not independently reapproved.</p>
      <ul className="space-y-3">{scope.decisions.map(decision => <li key={decision.criterionId} className="space-y-2 rounded-lg border p-3">
        <h5 className="font-semibold">{criterionLabels[decision.criterionId] ?? decision.criterionId} · {decision.criterionId}</h5>
        <p><strong>{decision.outcome === 'confirmed-missing' ? 'Missing evidence confirmed'
          : decision.outcome === 'evidence-found' ? 'Supporting evidence found — proposed zero not approved'
            : `Blocked — ${decision.blockerCode}`}</strong></p>
        <p className="whitespace-pre-wrap">{decision.message}</p>
        {decision.citations.length > 0 && <HistoricalCitations citations={decision.citations} label="Saved verification evidence" />}
      </li>)}</ul>
      <details><summary className="cursor-pointer font-semibold">Verification scope and base assessment</summary>
        <p className="mt-2">Selected criterion IDs: {scope.criterionIds.join(', ')}</p>
        <p className="mt-2 break-all">Base assessment SHA-256: {scope.baseAssessmentSha256}</p>
      </details>
    </> : <>
      <p>{reassessed
        ? 'This independent grounding review checked the complete re-scored assessment, including every criterion score and separate qualification, against the same frozen resume and rubric.'
        : 'This legacy review checked the whole proposal, including unchanged scores and separate qualifications; its findings are not limited to the selected gaps.'}</p>
      {review.issues.length ? <ul className="list-disc space-y-3 pl-5">{review.issues.map((issue, index) =>
        <li key={index}><strong>{issue.code}{issue.criterionId ? ` · ${criterionLabels[issue.criterionId] ?? issue.criterionId} (${issue.criterionId})` : ''}{issue.qualificationId ? ` · qualification ${issue.qualificationId}` : ''}: </strong>{issue.message}
          {issue.citations.length > 0 && <HistoricalCitations citations={issue.citations} label="Saved review evidence" />}
        </li>)}</ul> : <p>No reviewer issues were recorded. Publication is a separate status.</p>}
    </>}
  </div>
}

function CorrectionFailureFindings({ access, runId, correction, originalSha256, criterionLabels, onClose }: {
  access: Access; runId: string; correction: AnalysisCorrectionSummary; originalSha256?: string
  criterionLabels: Record<string, string>; onClose: () => void
}) {
  const current = useRef({ access, correction })
  current.current = { access, correction }
  const [entry, setEntry] = useState<AnalysisCorrectionHistoryPage['entries'][number] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const comparisonId = correction.comparisonId
  const requestId = correction.requestId
  const accessIdentity = access.identity

  const load = useCallback(async () => {
    const { access, correction } = current.current
    if (!access.api || !access.reviewer || access.identity !== accessIdentity || controller.current) return
    const request = new AbortController()
    controller.current = request
    setLoading(true)
    setEntry(null)
    setError('')
    try {
      const page = await getAnalysisCorrectionHistory(access.api.workspaceId, runId, comparisonId, undefined, request.signal, originalSha256)
      request.signal.throwIfAborted()
      if (!current.current.access.reviewer || current.current.access.identity !== accessIdentity ||
        current.current.correction.requestId !== requestId) return
      setEntry(latestCorrectionFailure(page, correction))
    } catch (caught) {
      if (!request.signal.aborted) setError(caught instanceof CloudApiError && [401, 403].includes(caught.status)
        ? 'Access to private correction findings was denied. Only an authorized workspace owner or editor can read them. No findings or approval are inferred.'
        : caught instanceof Error ? caught.message : 'Private failure findings could not be loaded. No findings or approval are inferred.')
    } finally {
      if (controller.current === request) { controller.current = null; setLoading(false) }
    }
  }, [accessIdentity, comparisonId, originalSha256, requestId, runId])

  useEffect(() => {
    void load()
    return () => { controller.current?.abort(); controller.current = null }
  }, [load])

  return <section className="space-y-3 rounded-xl border p-4 text-[12px]" aria-label="Private correction failure findings">
    <h3 className="font-semibold">Latest saved findings for this failed request · not published</h3>
    <p className="break-all text-[11px]">Request ID: {requestId}</p>
    <p>Selected criteria: {correction.criterionIds.map(id => `${criterionLabels[id] ?? id} (${id})`).join(', ')}</p>
    {loading && <><p role="status">Loading private correction findings…</p>
      <Button size="sm" onClick={onClose}>Cancel loading findings</Button></>}
    {error && <InlineError>{error}<div className="mt-2"><Button size="sm" disabled={loading} onClick={() => void load()}>Retry loading failure findings</Button></div></InlineError>}
    {!loading && !error && !entry && <p>No checkpoint for this exact request was found on the latest history page.
      {' '}No approval is implied. The saved processing error above remains the failure reason; check correction status before requesting another review.</p>}
    {entry && <>
      <p>Checkpoint saved {dateLabel(entry.createdAt)} · {entry.id}</p>
      {entry.review ? <CorrectionReviewFindings review={entry.review} policyVersion={entry.policyVersion} criterionLabels={criterionLabels} />
        : <p>No AI review findings were saved for this request. Processing stopped without a recorded review; this is not an approval.</p>}
      {entry.error && <InlineError>{entry.error.stage} · {entry.error.code}: {entry.error.message}</InlineError>}
    </>}
    <p className="text-[11px] text-muted">Only the latest bounded history page was read. This view does not retry, rescore, or publish anything.</p>
  </section>
}

function CorrectionHistory({ runId, comparisonId, criterionLabels, originalSha256 }: {
  runId: string; comparisonId: string; criterionLabels: Record<string, string>; originalSha256?: string
}) {
  const access = useCorrectionAccess(runId)
  const current = useRef(access)
  current.current = access
  const [page, setPage] = useState<AnalysisCorrectionHistoryPage | null>(null)
  const [entries, setEntries] = useState<AnalysisCorrectionHistoryPage['entries']>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ message: string; cursor?: string } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const cursors = useRef(new Set<string>())
  const seen = useRef(new Set<string>())
  const original = useRef<string | null>(null)

  const load = useCallback(async (cursor?: string) => {
    const access = current.current
    if (!access.api || !access.reviewer || controller.current) return
    const request = new AbortController()
    controller.current = request
    setLoading(true)
    setError(null)
    try {
      if (cursor && cursors.current.has(cursor)) throw new Error('This correction history page was already loaded. Refresh the latest history.')
      const next = await getAnalysisCorrectionHistory(access.api.workspaceId, runId, comparisonId, cursor, request.signal, originalSha256)
      request.signal.throwIfAborted()
      if (!current.current.reviewer) return
      if (cursor && (next.originalResultSha256 !== original.current ||
        next.entries.some(entry => seen.current.has(entry.id)) ||
        (next.continuationToken && cursors.current.has(next.continuationToken)))) {
        throw new Error('Correction history repeated or changed its immutable original. Refresh the latest history.')
      }
      if (seen.current.size + next.entries.length > ANALYSIS_CORRECTION_LIMITS.maxHistoryEntries && cursor) {
        throw new Error('The bounded history limit was reached. Refresh the latest history rather than loading more entries.')
      }
      if (!cursor) { cursors.current.clear(); seen.current.clear() }
      else cursors.current.add(cursor)
      original.current = next.originalResultSha256
      next.entries.forEach(entry => seen.current.add(entry.id))
      setPage(next)
      setEntries(previous => cursor ? [...previous, ...next.entries] : next.entries)
    } catch (caught) {
      if (!request.signal.aborted) setError({ message: correctionError(caught, 'Private correction history could not be loaded.', access, runId), cursor })
    } finally {
      if (controller.current === request) { controller.current = null; setLoading(false) }
    }
  }, [comparisonId, originalSha256, runId])

  useEffect(() => {
    void load()
    return () => { controller.current?.abort(); controller.current = null }
  }, [load])

  return <section className="space-y-4 rounded-xl border p-4 text-[12px]" aria-label="Private original result and correction history">
    <h3 className="font-semibold">Immutable original and correction history · owners and editors</h3>
    <p>Proposals and failed reviews are not published results. Opening this history does not request scoring or summary work.</p>
    {page && <div className="space-y-2"><h4 className="font-semibold">Original saved score</h4><SummaryValue summary={page.original} />
      <p className="break-all text-[11px]">Original result SHA-256: {page.originalResultSha256}</p>
      <p className="text-[11px] text-muted">Original assessment coverage: {page.original.coverage.supported} supported · {page.original.coverage.partial} partial · {page.original.coverage.missing} missing · {page.original.coverage.notAssessed} not assessed.</p>
      <details className="space-y-3"><summary className="cursor-pointer font-semibold">Full original rationale and saved evidence</summary>
        <p className="whitespace-pre-wrap">{page.originalAssessment.summary}</p>
        {page.originalAssessment.limitations.length > 0 && <ul className="list-disc space-y-2 pl-5">
          {page.originalAssessment.limitations.map((limitation, index) => <li key={index}>{limitation.message}</li>)}
        </ul>}
        {page.originalAssessment.criteria.map(criterion => <article key={criterion.criterionId} className="space-y-3 rounded-lg border p-3">
          <h4 className="font-semibold">{criterionLabels[criterion.criterionId] ?? criterion.criterionId} · original {criterion.weight}% weight</h4>
          <p><strong>{criterion.score === null ? criterion.evidenceStatus === 'not-applicable' ? 'Not applicable — unscored' : 'Not assessed'
            : `${criterion.score} / 5`}</strong> · {criterion.evidenceStatus}</p>
          <p className="whitespace-pre-wrap">{criterion.rationale}</p>
          {criterion.evidenceStatus === 'not-assessed' && <p>Original limitation: {criterion.limitation.message}</p>}
          <HistoricalCitations citations={criterion.citations} label="Original resume evidence" />
          <HistoricalCitations citations={criterion.requirementCitations} label="Original requirement evidence — not applicant evidence" />
        </article>)}
        {page.originalAssessment.qualifications.map(qualification => <article key={qualification.qualificationId} className="space-y-3 rounded-lg border p-3">
          <h4 className="font-semibold">Original separate qualification · {qualification.qualificationId} · unscored</h4>
          <p>{qualification.evidenceStatus}</p><p className="whitespace-pre-wrap">{qualification.rationale}</p>
          {qualification.limitation && <p>{qualification.limitation.message}</p>}
          <HistoricalCitations citations={qualification.citations} label="Original qualification resume evidence" />
          <HistoricalCitations citations={qualification.requirementCitations} label="Original qualification requirement evidence" />
        </article>)}
      </details>
      <HistoricalCandidateNarrative runId={runId} comparisonId={comparisonId} resultRevisionId="original"
        resultSha256={page.originalResultSha256} label="original assessment narrative" />
    </div>}
    {page && entries.length === 0 && <p>No correction attempts are recorded. The original result remains unchanged.</p>}
    {entries.map(entry => {
      const reassessed = isAnalysisReassessmentPolicy(entry.policyVersion)
      return <article key={entry.id} className="space-y-3 rounded-lg border p-3" aria-label={`Correction checkpoint ${entry.id}`}>
        <Badge tone={entry.outcome === 'ready' ? 'success' : 'warning'}>{entry.outcome === 'ready'
          ? reassessed ? 'Published re-scored revision' : 'Published reviewed revision'
          : entry.outcome === 'failed' ? entry.error?.stage === 'publication' ? 'Publication failed — not published'
            : reassessed ? 'Failed re-score — not published' : 'Failed proposal / review — not published'
            : reassessed ? 'Cancelled re-score — not published' : 'Cancelled proposal — not published'}</Badge>
        <p>{dateLabel(entry.createdAt)} · requested by {entry.requestedBy} · policy {entry.policyVersion}</p><p>{entry.reason}</p>
        <p>{reassessed ? 'Weighted criteria that were not assessed' : 'Selected criteria'}: {entry.criterionIds.join(', ')}</p>
        <div><h4 className="mb-2 font-semibold">{entry.outcome === 'ready' ? 'Published server total'
          : reassessed ? 'Re-score total — not published' : 'Proposed server total — never published by this attempt'}</h4>
          {entry.after ? <SummaryValue summary={entry.after} />
            : <p>No total was saved for this attempt. A re-score total comes only from a completed, independently reviewed assessment; the current result is unchanged.</p>}</div>
        {entry.review ? <CorrectionReviewFindings review={entry.review} policyVersion={entry.policyVersion} criterionLabels={criterionLabels} />
          : <p>{reassessed
            ? 'No independent grounding review was saved for this re-score. The saved processing error explains why it stopped; this is not an approval.'
            : 'No AI verification or grounding review was recorded for this proposal. This is not an approval.'}</p>}
        {entry.error && <InlineError>{entry.error.stage} · {entry.error.code}: {entry.error.message}</InlineError>}
        {entry.outcome === 'ready' && entry.resultSha256 && <HistoricalCandidateNarrative runId={runId} comparisonId={comparisonId}
          resultRevisionId={entry.requestId} resultSha256={entry.resultSha256} label={reassessed ? 're-score revision narrative' : 'correction revision narrative'} />}
        <details><summary className="cursor-pointer font-semibold">Audit identities and immutable hashes</summary>
          <dl className="mt-2 space-y-2 break-all text-[11px]">
            <div><dt>Checkpoint / request</dt><dd>{entry.id} / {entry.requestId}</dd></div>
            <div><dt>Before result SHA-256</dt><dd>{entry.beforeResultSha256}</dd></div>
            <div><dt>Published result SHA-256</dt><dd>{entry.resultSha256 ?? 'None — not published'}</dd></div>
          </dl>
        </details>
      </article>
    })}
    {loading && <p role="status">Loading correction history…</p>}
    {error && <InlineError>{error.message}<div className="mt-2"><Button size="sm" disabled={loading} onClick={() => void load(error.cursor)}>Retry loading history</Button></div></InlineError>}
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={loading} onClick={() => void load()}>Refresh correction history</Button>
      {page?.continuationToken && !error && <Button size="sm" disabled={loading} onClick={() => void load(page.continuationToken)}>Load older correction attempts</Button>}</div>
  </section>
}
