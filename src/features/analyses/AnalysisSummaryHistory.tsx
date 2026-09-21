import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { History, LoaderCircle, RotateCcw } from 'lucide-react'
import { useRealAnalyses } from '../../app/real-analyses-context'
import { Badge, Button, InlineError } from '../../components/ui'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { getRealAnalysisSummaryHistory, getRealAnalysisSummarySubject } from '../../services/realAnalyses'
import type { RealAnalysisCandidateNarrativeSummary, RealAnalysisTargetNarrativeSummary } from '../../domain/analysis-narratives'
import {
  SUMMARY_LIMITS, summaryIssueDisclosures,
  type AnalysisSummaryHistoryEntry, type AnalysisSummaryHistoryPage, type AnalysisSummaryIssue,
  type AnalysisSummaryPublicationMetadata,
} from '../../domain/analysis-summary-history'

type Summary = RealAnalysisCandidateNarrativeSummary | RealAnalysisTargetNarrativeSummary
interface Props { runId: string; narrative: Summary; label: string; resultRevisionId?: string }

export function SummaryApprovalDisclosure({ publication }: { publication: AnalysisSummaryPublicationMetadata }) {
  const disclosures = summaryIssueDisclosures(publication)
  if (!disclosures.length) return null
  return <aside className="space-y-2 rounded-lg border p-3 text-[12px]" aria-label="Manual summary approval">
    <Badge tone="warning">Manually approved</Badge>
    {disclosures.map((text, index) => <p className="whitespace-pre-wrap break-words" key={index}>{text}</p>)}
    <p>This is human approval, not an automated pass.</p>
  </aside>
}

export function SummaryHistoryControl(props: Props) {
  const api = useRealAnalyses()
  if (!api?.canReviewSummaries) return null
  const subjectId = props.narrative.kind === 'candidate' ? props.narrative.comparisonId : props.narrative.targetId
  return <HistoryDisclosure key={`${api.workspaceId}:${props.runId}:${props.narrative.kind}:${subjectId}:${props.resultRevisionId ?? 'current'}`} {...props} />
}

export function HistoricalCandidateNarrative({ runId, comparisonId, resultRevisionId, resultSha256, label }: {
  runId: string; comparisonId: string; resultRevisionId: string; resultSha256: string; label: string
}) {
  const api = useRealAnalyses()
  const [open, setOpen] = useState(false)
  const [reload, setReload] = useState(0)
  const [narrative, setNarrative] = useState<RealAnalysisCandidateNarrativeSummary | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || !api?.canReviewSummaries) return
    const controller = new AbortController()
    setNarrative(null)
    setError('')
    void getRealAnalysisSummarySubject(api.workspaceId, runId, { kind: 'candidate', subjectId: comparisonId }, controller.signal, resultRevisionId)
      .then(value => {
        if (controller.signal.aborted) return
        if (value.kind !== 'candidate' || value.narrative.resultSha256 !== resultSha256) {
          throw new Error('The historical summary does not match this exact saved assessment hash.')
        }
        setNarrative(value.narrative)
      }).catch(caught => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'The historical summary could not be loaded.')
      })
    return () => controller.abort()
  }, [api?.canReviewSummaries, api?.workspaceId, comparisonId, open, reload, resultRevisionId, resultSha256, runId])
  if (!api?.canReviewSummaries) return null
  return <div className="space-y-3">
    <Button size="sm" icon={History} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? 'Hide' : 'View'} {label}
    </Button>
    {open && <section className="space-y-3 rounded-lg border p-3" aria-label={label}>
      <Badge tone="warning">Historical assessment revision - read only</Badge>
      <p>Saved narrative and review history for this assessment only. It is not substituted into the current result or exports.</p>
      {narrative?.published ? <>
        <SummaryApprovalDisclosure publication={narrative.published} />
        <p className="whitespace-pre-wrap break-words">{narrative.published.text}</p>
        <p>Published {narrative.published.publishedAt}</p>
      </> : narrative && <p>No narrative was published for this assessment revision. Its saved attempt history is retained.</p>}
      {narrative && <SummaryHistoryControl runId={runId} narrative={narrative} label={label} resultRevisionId={resultRevisionId} />}
      {!narrative && !error && <p role="status">Loading historical summary...</p>}
      {error && <InlineError>{error} <Button size="sm" onClick={() => setReload(value => value + 1)}>Retry historical summary</Button></InlineError>}
    </section>}
  </div>
}

function HistoryDisclosure(props: Props) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return <div className="space-y-3">
    <Button size="sm" icon={History} className="max-w-full whitespace-normal text-left [overflow-wrap:anywhere]"
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {open ? 'Close history' : 'History'}: {props.label}
    </Button>
    {open && <section id={id} className="space-y-4 rounded-xl border p-4 text-[12px]" aria-label={`Summary history: ${props.label}`}>
      <SummaryHistory {...props} />
    </section>}
  </div>
}

function KnownIssues({ issues }: { issues: AnalysisSummaryIssue[] }) {
  return issues.length ? <ul className="space-y-2">
    {issues.map((issue, index) => <li key={index} className="whitespace-pre-wrap break-words">
      <strong>Known issue ({issue.code}; {issue.field}{issue.paragraphIndex === null ? '' : ` ${issue.paragraphIndex + 1}`}): </strong>{issue.message}
    </li>)}
  </ul> : <p>No known issues were recorded. That alone does not publish or approve this draft.</p>
}

function matchingPublished(entry: AnalysisSummaryHistoryEntry, narrative: Summary): boolean {
  const published = narrative.published
  if (!published || entry.scopeId !== 'final' || entry.inputFingerprint !== published.inputFingerprint ||
    (published.approval?.kind !== 'manual' && entry.generationId !== published.generationId)) return false
  return narrative.kind === 'candidate' && entry.draft?.kind === 'candidate'
    ? entry.draft.text === narrative.published?.text && entry.draft.overview === narrative.published?.overview
    : narrative.kind === 'target' && entry.draft?.kind === 'target' &&
      JSON.stringify(entry.draft.paragraphs) === JSON.stringify(narrative.published?.paragraphs)
}

function SummaryHistory({ runId, narrative, label, resultRevisionId }: Props) {
  const api = useRealAnalyses()
  const lifecycle = useLifecycleAccess({ kind: 'analysis', id: runId })
  const subject = { kind: narrative.kind, subjectId: narrative.kind === 'candidate' ? narrative.comparisonId : narrative.targetId }
  const context = useRef({ api, runId, subject, resultRevisionId })
  context.current = { api, runId, subject, resultRevisionId }
  const controller = useRef<AbortController | null>(null)
  const lifetime = useRef(0)
  const submittingRef = useRef(false)
  const cursors = useRef(new Set<string>())
  const seen = useRef(new Set<string>())
  const [page, setPage] = useState<AnalysisSummaryHistoryPage | null>(null)
  const [entries, setEntries] = useState<AnalysisSummaryHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<{ message: string; cursor?: string } | null>(null)
  const [mutationError, setMutationError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const confirmation = useRef<HTMLElement | null>(null)
  const selectionTrigger = useRef<HTMLButtonElement | null>(null)
  const refreshTrigger = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(false)
  const selected = entries.find(entry => entry.id === selectedId)
  const latestReview = (entry: AnalysisSummaryHistoryEntry) => entries.find(item =>
    item.generationId === entry.generationId && item.scopeId === entry.scopeId && item.round === entry.round &&
    item.outputSha256 === entry.outputSha256 && item.review)?.review
  const pending = submitting || Boolean(api?.pending(runId))
  const writable = Boolean(!resultRevisionId && api?.canWrite && api.canReviewSummaries && lifecycle.canEdit &&
    !lifecycle.archived && !lifecycle.inherited && !lifecycle.deleting && !lifecycle.removed)
  const allowed = Boolean(writable && page && !pending && !loading && !loadError)

  const load = useCallback(async (cursor?: string) => {
    if (controller.current) return
    const request = new AbortController()
    controller.current = request
    setLoading(true)
    setLoadError(null)
    setSelectedId(null)
    try {
      const { api: service, runId, subject, resultRevisionId } = context.current
      if (!service?.canReviewSummaries) throw new Error('Private summary history requires a workspace owner or editor.')
      if (cursor && cursors.current.has(cursor)) throw new Error('The summary history cursor was repeated. Refresh the latest history.')
      const next = resultRevisionId
        ? await getRealAnalysisSummaryHistory(service.workspaceId, runId, subject, cursor, request.signal, resultRevisionId)
        : await service.summaryHistory(runId, subject, cursor, request.signal)
      request.signal.throwIfAborted()
      if (controller.current !== request) return
      if (cursor && (next.entries.some(entry => seen.current.has(entry.id)) ||
        (next.continuationToken && cursors.current.has(next.continuationToken)))) {
        throw new Error('The summary service repeated a checkpoint or page. Refresh the latest history.')
      }
      if (!cursor) { cursors.current.clear(); seen.current.clear() }
      else cursors.current.add(cursor)
      next.entries.forEach(entry => seen.current.add(entry.id))
      setPage(next)
      setEntries(current => cursor ? [...current, ...next.entries] : next.entries)
    } catch (caught) {
      if (!request.signal.aborted && controller.current === request) setLoadError({
        message: caught instanceof Error ? caught.message : 'Private summary history could not be loaded.', cursor,
      })
    } finally {
      if (controller.current === request) { controller.current = null; setLoading(false) }
    }
  }, [])

  useEffect(() => {
    const stamp = ++lifetime.current
    void load()
    return () => { lifetime.current = stamp + 1; controller.current?.abort(); controller.current = null }
  }, [load])
  useEffect(() => { if (selectedId) confirmation.current?.focus() }, [selectedId])
  useEffect(() => {
    if (restoreFocus.current && !submitting && !loading) {
      refreshTrigger.current?.focus()
      restoreFocus.current = false
    }
  }, [loading, submitting])

  function selectable(entry: AnalysisSummaryHistoryEntry): boolean {
    // Matching published text can be an accepted request whose acknowledgement was interrupted.
    return Boolean(page?.capabilities.canPublish && entry.scopeId === 'final' && entry.draft?.kind === subject.kind &&
      entry.outputSha256 && entry.inputFingerprint === page.inputFingerprint)
  }

  async function change(action: 'publish' | 'retry') {
    if (!api || !page || !allowed || submittingRef.current ||
      (action === 'publish' ? !selected || !selectable(selected) : !page.capabilities.canRetry)) return
    const stamp = lifetime.current
    submittingRef.current = true
    setSubmitting(true)
    setMutationError('')
    setSuccess('')
    try {
      if (action === 'publish' && selected?.outputSha256) {
        await api.publishSummaryDraft(runId, subject, {
          generationId: selected.generationId, round: selected.round, outputSha256: selected.outputSha256,
        }, page.etag)
      } else await api.retrySummary(runId, subject, page.etag)
      if (stamp !== lifetime.current) return
      restoreFocus.current = true
      setSelectedId(null)
      setSuccess(action === 'publish'
        ? 'Manual publication acknowledged. Known issues remain disclosed; saved scores and evidence are unchanged.'
        : 'Retry acknowledged for this summary only. Up to three rounds will run; scoring was not retried.')
      void load()
    } catch (caught) {
      if (stamp === lifetime.current) setMutationError(caught instanceof Error ? caught.message : 'This summary action could not be acknowledged.')
    } finally {
      if (stamp === lifetime.current) { submittingRef.current = false; setSubmitting(false) }
    }
  }

  return <>
    <h3 className="font-semibold">Private summary history · {label}</h3>
    <p className="text-muted">Owners and editors only. Opening history does not generate model work. Drafts and reviewer findings are not accepted summaries.</p>
    {resultRevisionId && <p>This assessment revision is read-only. Its drafts cannot replace the current assessment summary.</p>}
    {narrative.published && <p>{resultRevisionId ? 'Historical published version' : narrative.status === 'ready' ? 'Current published version' : 'Previous published version'}: {narrative.published.publishedAt}
      {' · '}{narrative.published.approval?.kind === 'manual' ? 'Manually approved' : narrative.published.approval?.kind === 'automatic'
        ? 'Automatically reviewed' : 'Legacy publication · approval metadata was not recorded.'}</p>}
    {narrative.published?.approval?.kind === 'manual' && <p className="break-words text-muted">
      Manual approver: {narrative.published.approval.approvedBy} · {narrative.published.approval.approvedAt}
    </p>}
    {narrative.published && <SummaryApprovalDisclosure publication={narrative.published} />}
    {narrative.summaryRound !== undefined && <p>Summary progress: round {narrative.summaryRound} of {SUMMARY_LIMITS.rounds}.</p>}
    {loading && <p role="status" className="flex items-center gap-2"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />Loading private summary history...</p>}
    {loadError && <InlineError>{loadError.message} <Button size="sm" disabled={pending || loading} onClick={() => void load(loadError.cursor)}>Retry loading history</Button></InlineError>}
    {page && !entries.length && <p>History was not recorded for this summary. Older discarded drafts cannot be recovered; this does not mean an automated review passed.</p>}
    {entries.map(entry => {
      const authoritativeReview = latestReview(entry)
      const review = entry.review ?? authoritativeReview
      const published = matchingPublished(entry, narrative)
      return <article key={entry.id} className="space-y-3 rounded-lg border p-3" aria-label={`Summary checkpoint ${entry.id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-semibold">Round {entry.round} of {SUMMARY_LIMITS.rounds} · {entry.phase}</h4>
          <Badge tone={published && narrative.status === 'ready' ? 'success' : 'warning'}>
            {published ? narrative.status === 'ready' ? 'Matches current published text' : 'Previous published text' : entry.draft ? 'Unpublished draft' : 'No usable draft recorded'}
          </Badge>
          {entry.generationId !== narrative.generationId && <Badge tone="neutral">Historical generation</Badge>}
        </div>
        {entry.scopeId !== 'final' && <p className="font-semibold">Supporting reduction only · cannot be selected as a final summary.</p>}
        {entry.draft?.kind === 'candidate' ? <div className="space-y-2">
          <h5 className="font-semibold">Full candidate draft</h5><p className="whitespace-pre-wrap break-words">{entry.draft.text}</p>
          <h5 className="font-semibold">Overview draft</h5><p className="whitespace-pre-wrap break-words">{entry.draft.overview}</p>
        </div> : entry.draft && <div className="space-y-2">
          <h5 className="font-semibold">Full {entry.draft.kind === 'reduction' ? 'supporting reduction' : 'overview'} draft</h5>
          {entry.draft.paragraphs.map((paragraph, index) => <p key={index} className="whitespace-pre-wrap break-words">{paragraph}</p>)}
        </div>}
        {review ? <section className="space-y-2" aria-label={`Factual review for round ${entry.round}`}>
          <h5 className="font-semibold">Recorded factual review: {review.outcome}</h5>
          <KnownIssues issues={review.issues} />
          {entry.review?.id !== review.id && <p className="text-muted">Showing the latest recorded review for this exact draft, including checkpoints loaded above.</p>}
          {entry.review && authoritativeReview?.id !== entry.review.id &&
            <p className="text-muted">This checkpoint retains an earlier review. Manual publication uses the latest known review for this exact draft.</p>}
        </section> : entry.draft && <p>No factual review was recorded for this draft. It is not an automated pass.</p>}
        {entry.error && <InlineError>{entry.error.stage} · {entry.error.code}: {entry.error.message}</InlineError>}
        <details>
          <summary className="cursor-pointer font-semibold">Generation, model and checkpoint details</summary>
          <dl className="mt-2 space-y-2 break-words text-[11px]">
            <div><dt>Generation / attempt</dt><dd className="break-all">{entry.generationId} · {entry.attemptId}</dd></div>
            <div><dt>Recorded at / scope</dt><dd>{entry.createdAt} · {entry.scopeId}</dd></div>
            <div><dt>Input / output SHA-256</dt><dd className="break-all">{entry.inputFingerprint} / {entry.outputSha256 ?? 'No usable output'}</dd></div>
            {entry.modelCallId && <div><dt>Generation model call</dt><dd className="break-all">{entry.modelCallId}</dd></div>}
            {entry.generation && <>
              <div><dt>Generation model / deployment</dt><dd>{entry.generation.model} / {entry.generation.deployment}</dd></div>
              <div><dt>Generation prompt / schema</dt><dd>{entry.generation.promptVersion} / {entry.generation.schemaVersion}</dd></div>
              <div><dt>Generation started / completed</dt><dd>{entry.generation.startedAt} / {entry.generation.completedAt}</dd></div>
            </>}
            {review && <>
              <div><dt>Review model / deployment</dt><dd>{review.provenance.model} / {review.provenance.deployment}</dd></div>
              <div><dt>Review prompt / schema</dt><dd>{review.provenance.promptVersion} / {review.provenance.schemaVersion}</dd></div>
              <div><dt>Review started / completed</dt><dd>{review.provenance.startedAt} / {review.provenance.completedAt}</dd></div>
              <div><dt>Review / model call</dt><dd className="break-all">{review.id} / {review.modelCallId}</dd></div>
            </>}
          </dl>
        </details>
        {selectable(entry) && <Button size="sm" disabled={!allowed} onClick={event => {
          selectionTrigger.current = event.currentTarget
          setSelectedId(entry.id); setMutationError(''); setSuccess('')
        }}>Use this draft</Button>}
        {entry.draft && entry.scopeId === 'final' && entry.inputFingerprint !== page?.inputFingerprint &&
          <p className="text-muted">Historical saved inputs differ from the current summary. This draft cannot be published for the current input.</p>}
      </article>
    })}
    {selected && <section ref={confirmation} tabIndex={-1} className="space-y-3 rounded-lg border p-4" aria-label="Confirm manual summary publication">
      <h4 className="font-semibold">Use this draft from round {selected.round}?</h4>
      <p>This records human/manual approval, not an automated pass. The exact saved draft becomes the current summary, with known issues disclosed in the app and PDF, Word, and PowerPoint reports. Scores and frozen evidence do not change.</p>
      <p>Automated review: {latestReview(selected)?.outcome ?? 'not-reviewed'}.</p>
      <KnownIssues issues={latestReview(selected)?.issues ?? []} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={() => { setSelectedId(null); selectionTrigger.current?.focus() }}>Keep unpublished</Button>
        <Button size="sm" variant="primary" disabled={!allowed || !selectable(selected)} onClick={() => void change('publish')}>Confirm manual publication</Button>
      </div>
    </section>}
    {mutationError && <InlineError>{mutationError}<p className="mt-2">If acknowledgement was interrupted, repeating this exact action reuses its request key and original ETag. Refresh history if the summary changed.</p></InlineError>}
    {success && <p role="status">{success}</p>}
    {!writable && <p className="text-muted">History remains readable. Unarchive this analysis and workspace, and finish any cleanup, before changing summaries.</p>}
    <div className="flex flex-wrap gap-2">
      <Button ref={refreshTrigger} size="sm" icon={RotateCcw} disabled={pending || loading} onClick={() => void load()}>Refresh summary history</Button>
      {page?.continuationToken && <Button size="sm" disabled={pending || loading} onClick={() => void load(page.continuationToken)}>Load earlier summary history</Button>}
      <Button size="sm" disabled={!allowed || !page?.capabilities.canRetry} onClick={() => void change('retry')}>Retry this summary</Button>
    </div>
    <p className="text-muted">Retry starts up to three rounds for this summary only, not scoring. A changed candidate publication also refreshes its dependent job / grade overview.</p>
  </>
}
