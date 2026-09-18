import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, FileSearch, FileUp, LoaderCircle, Pencil, RotateCcw } from 'lucide-react'
import type { GradeLadderDetail, ReferenceSourceRecord, SourceDecision } from '../../domain/real-grades'
import { GRADE_LADDER_LIMITS } from '../../domain/real-grades'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { Badge, Button, EmptyState, InlineError, Modal } from '../../components/ui'
import { GradeSourceProvenance, type GradeSourceSelection } from './GradeSourceInspector'
import { GradeSourceUpload } from './GradeSourceUpload'
import { initialSourceDecisions, parseSelectedPages, selectedSourceBudget, sourcePurposeLabels } from './gradeUi'
import { useGradeRequestKey } from './grade-request-hooks'

export function GradeSourcesReview({ detail, onOpen, onDirtyChange }: { detail: GradeLadderDetail; onOpen: (selection: GradeSourceSelection) => void; onDirtyChange: (dirty: boolean) => void }) {
  const api = useGradeLadders()
  const editable = api?.canEdit(detail.ladder.id) ?? false
  const [decisions, setDecisions] = useState(() => initialSourceDecisions(detail))
  const [dirty, setDirty] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [upload, setUpload] = useState(false)
  const [pageSource, setPageSource] = useState<ReferenceSourceRecord | null>(null)
  const baseEtag = useRef(detail.etag)
  const alive = useRef(true)
  const inFlight = useRef(false)
  const guard = useGradeLeaveGuard(dirty, saving, 'Source applicability decisions')
  const keyFor = useGradeRequestKey()
  const limits = api?.features?.gradeLimits ?? GRADE_LADDER_LIMITS
  const budget = selectedSourceBudget(detail.sources, decisions)
  const stale = dirty && baseEtag.current !== detail.etag
  const discovering = detail.workItems.some((work) => work.input.kind === 'discover' && ['queued', 'running'].includes(work.status))
  const busy = saving || api?.mutationPending || !editable
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (!dirty) {
      baseEtag.current = detail.etag
      setDecisions(initialSourceDecisions(detail))
    } else {
      const incoming = initialSourceDecisions(detail)
      setDecisions((current) => incoming.map((decision) => current.find((item) => item.sourceId === decision.sourceId) ?? decision))
    }
  }, [detail, dirty])

  function change(sourceId: string, patch: Partial<SourceDecision>) {
    if (!dirty) baseEtag.current = detail.etag
    setDecisions((current) => current.map((decision) => decision.sourceId === sourceId ? { ...decision, ...patch } : decision))
    setConfirmed(false)
    setDirty(true)
    setError('')
  }

  async function freeze() {
    if (!api || inFlight.current || !editable) return
    setError('')
    if (discovering) { setError('Wait for OPM discovery to finish, or cancel its durable work item before freezing sources.'); return }
    const selected = detail.sources.filter((source) => decisions.some((decision) => decision.sourceId === source.id && decision.selected))
    if (!confirmed) { setError('Confirm that you reviewed the selected captures and unresolved applicability.'); return }
    if (!selected.length || selected.some((source) => source.status !== 'ready')) { setError('Select ready, completely captured source proposals before freezing this set.'); return }
    if (decisions.some((decision) => decision.sourceId !== detail.sources.find((source) => source.origin === 'seed-job')?.id && !decision.reason.trim())) {
      setError('Record an applicability or exclusion reason for every supporting-source decision.'); return
    }
    if (budget.references > limits.maxSources || budget.pdfPages > limits.maxTotalPdfPages || budget.unknownPdfPages) {
      setError('Resolve the advertised reference/page budget before confirming this set.'); return
    }
    if (stale) { setError('Sources changed while you were reviewing. Review the latest source state before confirmation.'); return }
    inFlight.current = true
    setSaving(true)
    try {
      const input = { decisions }
      await api.confirmSources(detail.ladder.id, input, baseEtag.current, keyFor('freeze', [detail.ladder.id, baseEtag.current, input]))
      if (!alive.current) return
      setDirty(false)
      setConfirmed(false)
      guard.release()
    } catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : 'The source set was not confirmed.') }
    finally { inFlight.current = false; if (alive.current) setSaving(false) }
  }

  const selectedNotReady = detail.sources.some((source) => source.status !== 'ready' && decisions.some((decision) => decision.sourceId === source.id && decision.selected))
  return <section className="panel grade-sources" aria-label="Reference source review">
    <div className="section-heading"><div><h2>Review and freeze supporting sources</h2><p>Source decisions are scoped to this context; a checkbox cannot establish an unsupported federal rule.</p></div>
      <Button icon={FileUp} size="sm" disabled={busy} title={!api?.canWrite ? 'Only owners and editors may upload private supporting sources.' : undefined} onClick={() => setUpload(true)}>Add PDF / URL</Button></div>
    <div className="grade-source-budget"><span><strong>{budget.references} / {limits.maxSources}</strong> selected supporting references <small>Seed captured automatically, not counted</small></span>
      <span><strong>{budget.pdfPages} / {limits.maxTotalPdfPages}</strong> selected PDF pages <small>{budget.unknownPdfPages ? 'Some page counts remain pending' : `Up to ${limits.maxPdfPages} selected pages / PDF · 20 MiB / PDF`}</small></span></div>
    {detail.sourceSet && <div className="grade-frozen-summary"><Check size={16} aria-hidden="true" /><div><strong>Frozen source set · revision {detail.sourceSet.revision}</strong><p>{detail.sourceSet.sources.length} captured sources · {detail.sourceSet.createdAt}</p><code>{detail.sourceSet.contentHash}</code></div></div>}
    {!detail.sources.length && <EmptyState icon={LoaderCircle} title="Discovering authoritative source proposals" description="The server follows actual OPM catalog references. You can leave after requests are acknowledged and return to durable progress." />}
    <div className="grade-source-list">{detail.sources.map((source) => {
      const decision = decisions.find((item) => item.sourceId === source.id)
      const seed = source.origin === 'seed-job'
      return <article key={source.id} data-source-id={source.id} className="grade-source-card">
        <div className="grade-source-heading"><label className="check-label"><input type="checkbox" checked={decision?.selected ?? seed} disabled={busy || seed} onChange={(event) => change(source.id, { selected: event.target.checked, ...(event.target.checked ? {} : { applicability: 'excluded' }) })} />
          <span><strong>{source.title}</strong><small>{source.publisher || 'Publisher not yet established'}</small></span></label>
          <Badge tone={source.status === 'ready' ? 'success' : source.status === 'error' ? 'danger' : 'neutral'} dot>{source.status}</Badge></div>
        <div className="flex flex-wrap gap-2"><Badge>{sourcePurposeLabels[source.purpose]}</Badge><Badge>v{source.documentVersion} · {source.authorityStatus}</Badge><Badge tone={source.coverage.state === 'confirmed' ? 'neutral' : 'warning'}>{source.coverage.state} coverage</Badge></div>
        <p className="text-[12px] text-muted">{source.coverage.explanation || 'Series, grade, and functional coverage have not yet been established.'}</p>
        {source.error && <InlineError>{source.error.code}: {source.error.message} {source.error.retryable ? 'Retry the failed extraction from processing progress below.' : 'Add a readable replacement or change the selected pages.'}</InlineError>}
        {!seed && <fieldset disabled={busy} className="grade-source-decision"><label className="field"><span className="field-label">Applicability decision</span>
          <select className="input" aria-label="Applicability decision" value={decision?.applicability ?? 'uncertain'} onChange={(event) => change(source.id, { applicability: event.target.value as SourceDecision['applicability'] })}>
            <option value="uncertain">Uncertain — unresolved</option><option value="applicable">Applicable to this position context</option><option value="background">Background only — not grade authority</option><option value="excluded">Excluded — explain why</option>
          </select></label>
          <label className="field"><span className="field-label">Evidence and scope for this decision</span><textarea className="input" aria-label="Evidence and scope for this decision" rows={2} value={decision?.reason ?? ''} maxLength={2000} onChange={(event) => change(source.id, { reason: event.target.value })} placeholder="Explain applicability, unresolved coverage, or the evidence for exclusion. This cannot waive support gaps." /></label></fieldset>}
        {seed && <p className="text-[11px] text-muted">Automatically captured seed job supplies role context, not independent grading authority. Its original job and rubric version are preserved.</p>}
        <div className="flex flex-wrap gap-2"><Button size="sm" icon={FileSearch} disabled={source.status !== 'ready'} title={source.status !== 'ready' ? 'Wait for extraction before inspecting paragraphs.' : undefined} onClick={() => onOpen({ sourceId: source.id })}>Inspect captured source</Button>
          {!seed && <Button size="sm" icon={Pencil} disabled={busy || (source.originalContentType !== 'application/pdf' && source.status !== 'error')} title="Changing pages captures a new extraction version; frozen old sets stay unchanged." onClick={() => setPageSource(source)}>Select PDF pages</Button>}</div>
        <details><summary className="cursor-pointer text-[11px] font-medium">Provenance, categories, coverage, and version blockers</summary><GradeSourceProvenance source={source} /></details>
      </article>
    })}</div>
    {!!detail.sources.length && <div className="grade-freeze-actions">
      {stale && <InlineError>The server source state changed during your review. Your choices are kept. <Button size="sm" icon={RotateCcw} disabled={busy} onClick={() => { baseEtag.current = detail.etag; setConfirmed(false); setError(''); setDecisions((current) => [...current]) }}>I reviewed the latest source state</Button></InlineError>}
      <label className="check-label"><input type="checkbox" disabled={busy || discovering} checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); if (!dirty) baseEtag.current = detail.etag; setDirty(true) }} />
        <span>I reviewed the selected captures, page coverage, applicability, and unresolved issues. Freeze this exact set for generation; unsupported grades must remain drafts.</span></label>
      <div className="flex flex-wrap items-center gap-3"><Button variant="primary" size="sm" icon={saving ? LoaderCircle : Check} disabled={busy || !confirmed || selectedNotReady || stale || discovering} onClick={() => void freeze()}>{saving ? 'Freezing sources…' : 'Confirm frozen source set'}</Button>
        <span className="text-[11px] text-muted">{!api?.canWrite ? 'Read-only: an owner or editor must confirm sources.' : discovering ? 'Wait for OPM discovery to finish or explicitly cancel it.' : selectedNotReady ? 'Selected sources must finish extraction.' : !confirmed ? 'Review the source set and confirm above.' : stale ? 'Recheck the changed server captures first.' : 'The server validates budgets, ownership, and source versions.'}</span></div>
      {error && <InlineError>{error}</InlineError>}
    </div>}
    {upload && <GradeSourceUpload detail={detail} onClose={() => setUpload(false)} />}
    {pageSource && <GradeSourcePages detail={detail} source={pageSource} onClose={() => setPageSource(null)} />}
  </section>
}

function GradeSourcePages({ detail, source, onClose }: { detail: GradeLadderDetail; source: ReferenceSourceRecord; onClose: () => void }) {
  const api = useGradeLadders()
  const editable = api?.canEdit(detail.ladder.id) ?? false
  const [pages, setPages] = useState(source.selectedPages.join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const etag = useRef(detail.etag)
  const guard = useGradeLeaveGuard(pages !== source.selectedPages.join(', '), saving, `Page selection for ${source.title}`)
  const alive = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!api || inFlight.current || !editable) return
    let selectedPages: number[]
    try {
      selectedPages = parseSelectedPages(pages, api.features?.gradeLimits.maxPdfPages)
      if (source.pageCount && selectedPages.some((page) => page > source.pageCount!)) throw new Error('A selected page is beyond the original PDF page count.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Check page selection.'); return }
    setError('')
    setSaving(true)
    inFlight.current = true
    try {
      await api.updateSource(detail.ladder.id, source.id, { selectedPages }, etag.current)
      if (alive.current) { guard.release(); onClose() }
    } catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : 'The page selection was not changed.') }
    finally { inFlight.current = false; if (alive.current) setSaving(false) }
  }
  const close = () => { void guard.close(onClose) }
  return <Modal open onOpenChange={(open) => { if (!open) close() }} title="Capture a new page selection" description={source.title}
    footer={<><Button onClick={close}>Cancel</Button><Button form="grade-source-pages" type="submit" variant="primary" disabled={saving || !editable}>{saving ? 'Saving…' : 'Capture new extraction version'}</Button></>}>
    <form id="grade-source-pages" onSubmit={save} className="space-y-4">
      <label className="field"><span className="field-label">Original PDF page numbers / ranges</span><input className="input" value={pages} disabled={saving || !editable} onChange={(event) => setPages(event.target.value)} placeholder="1-10, 18-28" /></label>
      <p className="text-[11px] text-muted">Blank requests all pages within the 250-page per-PDF limit. Old source sets retain their exact original page selection and extraction version. Confirm the revised sources before generating new grades.</p>
      {error && <InlineError>{error}</InlineError>}
    </form>
  </Modal>
}
