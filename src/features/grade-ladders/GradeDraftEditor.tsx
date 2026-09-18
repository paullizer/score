import { useEffect, useRef, useState, type FormEvent } from 'react'
import { FileSearch, Save, X } from 'lucide-react'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import type { Citation } from '../../domain/types'
import type { EditGradeDraftInput, GradeCriterion, GradeLevelDetail, GradeQualification, GradeSourceSetRecord } from '../../domain/real-grades'
import { Badge, Button, InlineError, Modal } from '../../components/ui'
import { GradeCitationPicker } from './GradeCitationPicker'
import { gradeDraftWeightState } from './gradeUi'

type CitationTarget = { kind: 'criterion'; id: string; field: 'gradeBasis' | 'sourceCitations' } | { kind: 'qualification'; id: string }

export function GradeDraftEditor({ ladderId, level, onClose }: { ladderId: string; level: GradeLevelDetail; onClose: () => void }) {
  const api = useGradeLadders()
  const service = useRef(api)
  service.current = api
  const version = level.version
  const [draft, setDraft] = useState<EditGradeDraftInput | null>(() => version ? structuredClone({ rubric: version.rubric, qualifications: version.qualifications }) : null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [sourceSet, setSourceSet] = useState<GradeSourceSetRecord | null>(null)
  const [citationTarget, setCitationTarget] = useState<CitationTarget | null>(null)
  const [reloadSources, setReloadSources] = useState(0)
  const headEtag = useRef(level.etag)
  const inFlight = useRef(false)
  const live = useRef(true)
  const guard = useGradeLeaveGuard(dirty, saving, `GS-${level.head.grade} draft edits`)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    if (version?.sourceSetId) void service.current?.sourceSet(ladderId, version.sourceSetId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setSourceSet(value)
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'The frozen sources could not be loaded.') })
    return () => controller.abort()
  }, [ladderId, reloadSources, version?.sourceSetId])
  if (!draft || !version) return null
  const editedDraft = draft
  const weights = gradeDraftWeightState(draft.rubric.criteria)
  const close = () => { void guard.close(onClose) }
  function criterion(id: string, patch: Partial<GradeCriterion>) {
    setDraft((current) => current ? { ...current, rubric: { ...current.rubric, criteria: current.rubric.criteria.map((item) => item.id === id ? { ...item, ...patch } : item) } } : current)
    setDirty(true)
  }
  function qualification(id: string, patch: Partial<GradeQualification>) {
    setDraft((current) => current ? { ...current, qualifications: current.qualifications.map((item) => item.id === id ? { ...item, ...patch } : item) } : current)
    setDirty(true)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!api || inFlight.current || !api.canWrite) return
    if (!editedDraft.rubric.name.trim() || !editedDraft.rubric.description.trim() ||
        editedDraft.rubric.criteria.some((item) => !item.label.trim() || !item.description.trim() || !item.guidance.trim()) ||
        editedDraft.qualifications.some((item) => !item.text.trim())) {
      setError('Complete the name, description, expectations, guidance, and qualification text. Evidence gaps still remain drafts.'); return
    }
    if (weights.errors.length) { setError(weights.errors.join(' ')); return }
    inFlight.current = true
    setSaving(true)
    setError('')
    try {
      const input = structuredClone(editedDraft)
      delete input.rubric.provenance
      await api.saveDraft(ladderId, level.head.grade, input, headEtag.current)
      if (live.current) { guard.release(); onClose() }
    } catch (caught) { if (live.current) setError(caught instanceof Error ? caught.message : 'This draft was not saved.') }
    finally { inFlight.current = false; if (live.current) setSaving(false) }
  }
  function citationList(citations: Citation[], remove: (index: number) => void) {
    return <ul className="grade-editor-quotes">{citations.map((citation, index) => <li key={`${citation.paragraphId}-${index}`}><div><blockquote>“{citation.quote}”</blockquote><span>Captured v{citation.documentVersion} · p. {citation.page} · {citation.heading}</span></div>
      <Button className="icon-button" size="sm" variant="ghost" icon={X} aria-label={`Remove quotation ${index + 1}`} disabled={saving || !api?.canWrite} onClick={() => remove(index)} /></li>)}</ul>
  }
  return <Modal open onOpenChange={(open) => { if (!open) close() }} wide title={`Edit GS-${level.head.grade} draft`} description={`Saving appends version ${version.version + 1} and requests a new independent grounding review. It never changes the saved version or approves new claims.`}
    footer={<><span className="mr-auto text-[11px] text-muted">Unsaved changes stay only in this tab.</span><Button onClick={close}>Close draft</Button><Button type="submit" form="grade-draft-editor" icon={Save} variant="primary" disabled={saving || !dirty || !sourceSet || !api?.canWrite}>{saving ? 'Saving and requesting review…' : 'Save draft and request review'}</Button></>}>
    <form id="grade-draft-editor" onSubmit={save} noValidate className="space-y-5">
      <div className="info-callout"><div><strong>Support is reviewed, not self-certified</strong><p>Keep interpretations separate from quotations. Common competency IDs and support verdicts cannot be manually relabeled to bypass gaps. Add sources and regenerate when a frozen set lacks the evidence.</p></div></div>
      <fieldset disabled={saving || !api?.canWrite} className="space-y-4">
        <label className="field"><span className="field-label">Grade rubric name</span><input className="input" value={draft.rubric.name} maxLength={240} onChange={(event) => { setDraft({ ...draft, rubric: { ...draft.rubric, name: event.target.value } }); setDirty(true) }} /></label>
        <label className="field"><span className="field-label">Description</span><textarea className="input" value={draft.rubric.description} onChange={(event) => { setDraft({ ...draft, rubric: { ...draft.rubric, description: event.target.value } }); setDirty(true) }} /></label>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-[14px] font-semibold">Weighted work-level expectations</h3><Badge tone={weights.errors.length ? 'danger' : weights.fullySupported ? 'success' : 'warning'} dot>{Number.isFinite(weights.total) ? `${Number(weights.total.toFixed(6))}% allocated / 100%` : 'Invalid allocated weight'}</Badge></div>
      <p className="text-[11px] text-muted">Incomplete drafts may leave review weight unallocated. Gap and not-applicable rows stay at 0%; direct and derived expectations need positive weights. When there is supported work and no evidence gap, its weights must total 100%. Saving never resolves support gaps or grants approval.</p>
      {draft.rubric.criteria.map((item, index) => <fieldset key={item.id} disabled={saving || !api?.canWrite} className="grade-editor-criterion">
        <legend>{index + 1}. {item.label}</legend><Badge tone={item.support === 'gap' ? 'warning' : 'neutral'}>{item.support} support · immutable competency alignment</Badge>
        <div className="grade-form-grid"><label className="field"><span className="field-label">Competency label</span><input className="input" value={item.label} onChange={(event) => criterion(item.id, { label: event.target.value })} /></label>
          <label className="field"><span className="field-label">Review weight (%)</span><input className="input" type="number" min={0} max={item.support === 'gap' || item.support === 'not-applicable' ? 0 : 100} step="any" value={Number.isFinite(item.weight) ? item.weight : ''} onChange={(event) => criterion(item.id, { weight: event.target.valueAsNumber })} /></label></div>
        <label className="field"><span className="field-label">Expected work at this grade</span><textarea className="input" rows={3} value={item.description} onChange={(event) => criterion(item.id, { description: event.target.value })} /></label>
        <label className="field"><span className="field-label">Evaluation guidance</span><textarea className="input" rows={3} value={item.guidance} onChange={(event) => criterion(item.id, { guidance: event.target.value })} /></label>
        <label className="field"><span className="field-label">Interpretation / supported grade distinction (not quotation)</span><textarea className="input" rows={3} value={item.interpretation} onChange={(event) => criterion(item.id, { interpretation: event.target.value })} /></label>
        <div><h4 className="grade-field-kicker">Grade-basis quotations</h4>{citationList(item.gradeBasis, (index) => criterion(item.id, { gradeBasis: item.gradeBasis.filter((_, position) => position !== index) }))}
          <Button size="sm" icon={FileSearch} disabled={!sourceSet} onClick={() => setCitationTarget({ kind: 'criterion', id: item.id, field: 'gradeBasis' })}>Cite captured grading evidence</Button></div>
        <div><h4 className="grade-field-kicker">Supporting role / source quotations</h4>{citationList(item.sourceCitations ?? [], (index) => criterion(item.id, { sourceCitations: item.sourceCitations?.filter((_, position) => position !== index) }))}
          <Button size="sm" icon={FileSearch} disabled={!sourceSet} onClick={() => setCitationTarget({ kind: 'criterion', id: item.id, field: 'sourceCitations' })}>Cite captured supporting evidence</Button></div>
      </fieldset>)}
      <section className="grade-qualifications"><h3>Minimum qualifications · unscored</h3><p>A weighted work score cannot offset a required qualification. Preserve alternatives, table conditions, and exclusions.</p>
        {draft.qualifications.map((item, index) => <fieldset key={item.id} disabled={saving || !api?.canWrite} className="grade-editor-criterion"><legend>Qualification {index + 1} · {item.support}</legend>
          <label className="field"><span className="field-label">Qualification requirement</span><textarea className="input" value={item.text} onChange={(event) => qualification(item.id, { text: event.target.value })} /></label>
          <label className="field"><span className="field-label">Interpretation / applicability (not quotation)</span><textarea className="input" value={item.interpretation} onChange={(event) => qualification(item.id, { interpretation: event.target.value })} /></label>
          {citationList(item.citations, (index) => qualification(item.id, { citations: item.citations.filter((_, position) => position !== index) }))}
          <Button size="sm" icon={FileSearch} disabled={!sourceSet} onClick={() => setCitationTarget({ kind: 'qualification', id: item.id })}>Cite captured qualification evidence</Button>
        </fieldset>)}
        {!draft.qualifications.length && <p>No qualification requirements were captured in this draft. This is not a determination of eligibility.</p>}
      </section>
      {!sourceSet && <p className="text-[11px] text-muted">Frozen source loading is required before saving. <button className="text-link" type="button" onClick={() => setReloadSources((value) => value + 1)}>Retry source set</button></p>}
      {error && <InlineError>{error}</InlineError>}
    </form>
    {citationTarget && sourceSet && <GradeCitationPicker ladderId={ladderId} sourceSet={sourceSet} onClose={() => setCitationTarget(null)} onAdd={(citation) => {
      if (citationTarget.kind === 'criterion') {
        const item = draft.rubric.criteria.find((item) => item.id === citationTarget.id)
        if (item) criterion(item.id, { [citationTarget.field]: [...(item[citationTarget.field] ?? []), citation] })
      } else {
        const item = draft.qualifications.find((item) => item.id === citationTarget.id)
        if (item) qualification(item.id, { citations: [...item.citations, citation] })
      }
    }} />}
  </Modal>
}
