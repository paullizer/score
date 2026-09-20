import { useEffect, useId, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react'
import { useRealAnalyses } from '../../app/real-analyses-context'
import type {
  AnalysisNarrativeCounts, AnalysisNarrativeGenerationMode, RealAnalysisCandidateNarrativeSummary,
  RealAnalysisSummariesResponse, RealAnalysisTargetNarrativeSummary,
} from '../../domain/analysis-narratives'
import type { RealAnalysisRunDetail, RealAnalysisTargetSummary } from '../../domain/real-analyses'
import { dateLabel } from '../../domain/selectors'
import { getDisplayName } from '../../domain/displayNames'
import { Badge, Button, InlineError, Modal } from '../../components/ui'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { targetVersionLabel } from './realAnalysisUi'

function useSavedSummaries(runId: string, targetId?: string, enabled = true) {
  const api = useRealAnalyses()
  const entry = api?.narratives?.(runId, targetId)
  const ensure = api?.ensureNarratives
  useEffect(() => {
    if (enabled && api?.phase === 'ready') void ensure?.(runId, targetId)
  }, [api?.phase, enabled, ensure, entry?.state, runId, targetId])
  return entry
}

function SummaryCounts({ label, counts }: { label: string; counts: AnalysisNarrativeCounts }) {
  const required = counts.total - counts.notRequired
  return <section aria-label={label} className="space-y-2">
    <h3 className="text-[12px] font-semibold">{label}: {counts.ready} / {required} current and ready</h3>
    <progress className="summary-progress" max={Math.max(1, required)} value={counts.ready} aria-label={`${label} ready`} />
    <p className="text-[11px] text-muted">{counts.missing} missing · {counts.waiting} waiting · {counts.queued + counts.running} generating
      {' '}({counts.queued} queued, {counts.running} running) · {counts.stale} outdated · {counts.failed} failed · {counts.cancelled} cancelled</p>
    {counts.notRequired > 0 && <p className="text-[11px] text-muted">{counts.notRequired} not required because no completed assessment is available.</p>}
  </section>
}

export function AnalysisSummaryStatus({ summaries }: { summaries: RealAnalysisSummariesResponse }) {
  const scoring = summaries.scoring
  const pending = scoring.queued + scoring.running
  const uninitialized = scoring.total - scoring.initialized
  return <div className="space-y-4" aria-label="Summary readiness" aria-live="polite">
    <SummaryCounts label="Candidate summaries" counts={summaries.counts.candidates} />
    <SummaryCounts label="Job / grade overviews" counts={summaries.counts.targets} />
    {pending > 0 && <p className="text-[12px] text-muted">{pending} {pending === 1 ? 'comparison is' : 'comparisons are'} still awaiting or undergoing scoring in this scope. Overviews wait for selected scoring and candidate summaries to finish.</p>}
    {uninitialized > 0 && <p className="text-[11px] text-muted">Not initialized yet: {uninitialized} (included in the waiting count).</p>}
    {(scoring.failed > 0 || scoring.cancelled > 0) && <p className="text-[11px] text-muted">{scoring.failed} failed and {scoring.cancelled} cancelled comparisons remain unassessed, not unsuccessful candidates.</p>}
  </div>
}

const capabilityReasons: Record<NonNullable<RealAnalysisSummariesResponse['capabilities']['reason']>, string> = {
  'read-only': 'This workspace is read-only. An owner or editor must generate summaries; current summaries remain readable and exportable.',
  archived: 'Unarchive this analysis and its workspace before generating missing or replacement summaries. Current ready summaries remain readable and exportable.',
  deleting: 'This analysis or workspace is being deleted. Summary generation and downloads are unavailable.',
  cancelling: 'Wait for the saved run cancellation to finish before generating summaries. Completed scores remain unchanged.',
  'service-unavailable': 'The summary generation service is unavailable. Saved scores and frozen evidence are unchanged.',
}

export function ManageAnalysisSummaries({ detail, open, initialTargetId, onOpenChange }: {
  detail: RealAnalysisRunDetail; open: boolean; initialTargetId?: string; onOpenChange: (open: boolean) => void
}) {
  const api = useRealAnalyses()
  const { canEdit, archived, inherited, deleting, removed } = useLifecycleAccess({ kind: 'analysis', id: detail.run.id })
  const fieldId = useId()
  const [targetId, setTargetId] = useState(initialTargetId ?? '')
  const [confirmAll, setConfirmAll] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const lifetime = useRef(0)
  const submittingRef = useRef(false)
  const entry = useSavedSummaries(detail.run.id, targetId || undefined, open)
  const summaries = entry?.state === 'ready' ? entry.value : null
  const pending = submitting || Boolean(api?.pending(detail.run.id))
  const loadingError = entry?.state === 'error' || entry?.state === 'ready' ? entry.error : undefined
  const generating = summaries ? [summaries.counts.candidates, summaries.counts.targets].some((count) => count.queued + count.running > 0) : false
  const needsSummaries = summaries ? [summaries.counts.candidates, summaries.counts.targets]
    .some((count) => count.missing + count.stale + count.failed + count.cancelled > 0) : false
  const waiting = summaries ? [summaries.counts.candidates, summaries.counts.targets].some((count) => count.waiting > 0) : false
  const permission = deleting || removed ? capabilityReasons.deleting
    : archived || inherited ? capabilityReasons.archived
    : !api?.canWrite || !canEdit ? capabilityReasons['read-only']
    : api.features?.analysisSummaryGeneration !== true ? capabilityReasons['service-unavailable']
    : summaries?.capabilities.reason ? capabilityReasons[summaries.capabilities.reason] : ''
  const allowed = Boolean(api?.phase === 'ready' && summaries?.capabilities.canGenerate && canEdit && api.canWrite &&
    !loadingError && !permission && !pending && !generating && summaries.scoring.complete > 0)
  useEffect(() => {
    if (!open) return
    setTargetId(initialTargetId ?? '')
    setConfirmAll(false)
    setError('')
    setSuccess('')
  }, [initialTargetId, open])
  useEffect(() => () => { lifetime.current++ }, [])

  async function generate(mode: AnalysisNarrativeGenerationMode) {
    if (!allowed || !summaries || !api || submittingRef.current || (mode === 'all' && !confirmAll)) return
    const currentLifetime = lifetime.current
    submittingRef.current = true
    setSubmitting(true)
    setError('')
    setSuccess('')
    try {
      const result = await api.generateSummaries(detail.run.id, { mode, ...(targetId ? { targetId } : {}) }, summaries.etag)
      if (lifetime.current !== currentLifetime) return
      setConfirmAll(false)
      setSuccess(`Summary request acknowledged: ${result.scheduled.candidates} candidate summaries and ${result.scheduled.targets} job / grade overviews scheduled. Work continues on the server if you close this dialog or browser.`)
    } catch (caught) {
      if (lifetime.current !== currentLifetime) return
      setError(caught instanceof Error ? caught.message : 'The summary request could not be acknowledged. Refresh status before retrying.')
    } finally {
      if (lifetime.current === currentLifetime) { submittingRef.current = false; setSubmitting(false) }
    }
  }

  const targetNames = new Map(detail.targets.map((target) => [target.id, getDisplayName(target, target.label)]))
  const labels = detail.targets.map((target) => `${targetNames.get(target.id)} / ${targetVersionLabel(target.selection)}`)
  return <Modal open={open} onOpenChange={onOpenChange} title="Manage summaries"
    description="Update narrative text for this saved analysis, without rerunning scoring or changing frozen evidence."
    footer={<>
      <Button onClick={() => onOpenChange(false)}>Close</Button>
      <Button variant="primary" icon={pending ? LoaderCircle : RefreshCw}
        disabled={!allowed || !needsSummaries || confirmAll} onClick={() => void generate('missing')}>Generate missing summaries</Button>
    </>}>
    <div className="space-y-5">
      <div><label className="mb-2 block text-[12px] font-semibold" htmlFor={`${fieldId}-scope`}>Summary scope</label>
        <select id={`${fieldId}-scope`} className="filter-select w-full" value={targetId} disabled={pending} onChange={(event) => {
          setTargetId(event.target.value); setConfirmAll(false); setError(''); setSuccess('')
        }}>
          <option value="">Entire saved analysis - all jobs and grades</option>
          {detail.targets.map((target, index) => <option key={target.id} value={target.id}>{labels[index]}
            {labels.filter((label) => label === labels[index]).length > 1 ? ` [${target.id}]` : ''}</option>)}
        </select>
        <p className="mt-2 text-[11px] text-muted">Only this saved run or one exact job / grade is included. Candidate searches and table filters do not limit summary generation.</p>
      </div>
      <p className="text-[12px]">Only narratives change. Scores, criteria, citations, and frozen documents never change. Generate missing preserves current candidate versions, fills missing or failed summaries, and updates outdated dependent overviews. Missing includes any summary without a current usable version.</p>
      {summaries ? <AnalysisSummaryStatus summaries={summaries} /> : !loadingError && <p className="flex items-center gap-2 text-[12px]" role="status">
        <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />Loading saved summary status...</p>}
      {permission && <p className="text-[12px]" role="status">{permission}</p>}
      {(generating || waiting) && <p className="text-[12px]" role="status">{generating ? 'Summaries are generating' : 'Summaries are waiting for prerequisites'}. Progress updates independently of scoring. Server work continues after the browser closes.</p>}
      {summaries?.ready && !loadingError && <p className="text-[12px]" role="status">All required summaries in this scope are current and ready.</p>}
      {(loadingError || error) && <InlineError>{error || loadingError}
        <p className="mt-2">If acknowledgement was interrupted, repeating the same action reuses its request key rather than starting a duplicate generation.</p>
      </InlineError>}
      {summaries && [...summaries.comparisons, ...summaries.targets].some((item) => item.error) && <div className="space-y-3">
        {[...summaries.comparisons, ...summaries.targets].filter((item) => item.error).map((item) => <InlineError key={item.kind === 'candidate' ? item.comparisonId : item.targetId}>
          {item.kind === 'candidate' ? `Candidate summary (${item.comparisonId})` : `Overview (${targetNames.get(item.targetId) ?? item.targetId})`}: {item.error?.message}
          {' '}Use Generate missing summaries to retry summary work, not scoring.
        </InlineError>)}
      </div>}
      {success && <p className="text-[12px]" role="status">{success}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={RotateCcw} disabled={pending || api?.phase !== 'ready'}
          onClick={() => void api?.ensureNarratives?.(detail.run.id, targetId || undefined, true)}>Refresh summary status</Button>
        {!confirmAll && <Button size="sm" disabled={!allowed || (waiting && !needsSummaries)}
          onClick={() => { setConfirmAll(true); setError(''); setSuccess('') }}>Regenerate all summaries</Button>}
      </div>
      {confirmAll && <section className="space-y-3 rounded-xl border p-4" aria-label="Confirm summary regeneration">
        <h3 className="text-[13px] font-semibold">Regenerate all summaries?</h3>
        <p className="text-[12px]">Recreate all {summaries?.scoring.complete ?? 0} completed candidate summaries and their job / grade overviews in this selected scope. Previous text stays readable but is marked updating or outdated until the replacement is ready. PDF, Word, and PowerPoint downloads wait for current versions.</p>
        <p className="text-[12px]">This does not change scores or any saved source evidence.</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={pending} onClick={() => setConfirmAll(false)}>Keep current summaries</Button>
          <Button size="sm" disabled={!allowed} onClick={() => void generate('all')}>Confirm regenerate all</Button></div>
      </section>}
    </div>
  </Modal>
}

function NarrativeContent({ narrative, loadError }: {
  narrative: RealAnalysisCandidateNarrativeSummary | RealAnalysisTargetNarrativeSummary; loadError?: string
}) {
  const updating = ['waiting', 'queued', 'running'].includes(narrative.status)
  const ready = narrative.status === 'ready' && !loadError
  const label = loadError ? 'Current status unavailable' : ({
    missing: 'Missing summary', waiting: 'Waiting', queued: 'Queued', running: 'Generating', ready: 'Current summary',
    stale: 'Outdated', failed: 'Summary failed', cancelled: 'Summary cancelled', 'not-required': 'No completed assessment',
  })[narrative.status]
  return <div className="space-y-3">
    <Badge tone={ready ? 'success' : narrative.status === 'failed' ? 'danger' : 'warning'}>{label}</Badge>
    {narrative.published ? <>
      {!ready && <p className="text-[12px] font-semibold" role="status">Previous published summary - {updating && !loadError ? 'updating' : 'outdated'}. It is not current for PDF, Word, or PowerPoint export.</p>}
      {narrative.kind === 'candidate' ? <p className="whitespace-pre-line text-[13px] leading-relaxed">{narrative.published.text}</p>
        : narrative.published.paragraphs.map((paragraph, index) => <p key={index} className="whitespace-pre-line text-[13px] leading-relaxed">{paragraph}</p>)}
      <p className="text-[10px] text-muted">Published {dateLabel(narrative.published.publishedAt)}. Narrative only; saved scores and evidence are unchanged.</p>
    </> : <p className="text-[12px] text-muted">{narrative.status === 'not-required'
      ? 'No completed assessment is available to summarize.'
      : 'No published summary is available. Use Manage summaries above to generate narratives from the saved evidence without rescoring.'}</p>}
    {narrative.waitingFor && <p className="text-[11px] text-muted">{narrative.waitingFor === 'scoring'
      ? 'Waiting for this target’s scoring to finish.' : 'Waiting for this target’s completed candidate summaries.'}</p>}
    {narrative.nextAttemptAt && <p className="text-[11px] text-muted">Automatic summary retry {dateLabel(narrative.nextAttemptAt)}</p>}
    {narrative.error && <InlineError>{narrative.error.message} Previous published text, if any, is retained. Retry summary work in Manage summaries.</InlineError>}
  </div>
}

export function RealTargetNarrative({ runId, target }: { runId: string; target: RealAnalysisTargetSummary }) {
  const api = useRealAnalyses()
  const entry = useSavedSummaries(runId, target.id)
  if (!api?.narratives) return null
  const narrative = entry?.state === 'ready' ? entry.value.targets.find((item) => item.targetId === target.id) : undefined
  const error = entry?.state === 'error' || entry?.state === 'ready' ? entry.error : undefined
  return <section className="panel mt-5 space-y-3 p-5" aria-label="Saved job or grade overview">
    <h2 className="text-[15px] font-semibold">{target.kind === 'grade' ? 'Grade' : 'Job'} overview</h2>
    <p className="text-[11px] text-muted">{getDisplayName(target, target.label)} · {targetVersionLabel(target.selection)}. This exact target only, across all its saved comparisons.</p>
    {target.displayName !== undefined && <p className="text-[11px] text-muted">Source title: {target.label}</p>}
    {narrative ? <NarrativeContent narrative={narrative} loadError={error} /> : !error && <p className="text-[12px]" role="status">Loading saved overview...</p>}
    {error && <InlineError>{error}</InlineError>}
  </section>
}

export function RealCandidateNarrative({ runId, comparisonId, targetId }: { runId: string; comparisonId: string; targetId: string }) {
  const api = useRealAnalyses()
  const entry = useSavedSummaries(runId, targetId)
  if (!api?.narratives) return null
  const narrative = entry?.state === 'ready' ? entry.value.comparisons.find((item) => item.comparisonId === comparisonId) : undefined
  const error = entry?.state === 'error' || entry?.state === 'ready'
    ? entry.error ?? (entry.state === 'ready' && !narrative ? 'The summary response omitted this saved comparison. Refresh summaries before continuing.' : undefined)
    : undefined
  return <section className="panel mt-5 space-y-3 p-5" aria-label="Saved candidate assessment summary">
    <h2 className="text-[15px] font-semibold">Candidate assessment summary</h2>
    {narrative ? <NarrativeContent narrative={narrative} loadError={error} /> : !error && <p className="text-[12px]" role="status">Loading saved candidate summary...</p>}
    {error && <InlineError>{error}</InlineError>}
  </section>
}
