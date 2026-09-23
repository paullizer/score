import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { FileText, History, Plus, Save, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { usePublicSettings } from '../../app/public-settings-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { Badge, Button, InlineError, Modal } from '../../components/ui'
import { DocumentViewer } from '../../components/documents/DocumentViewer'
import type { Criterion, Rubric } from '../../domain/types'
import { validateRubric } from '../../domain/rubric-validation'
import { LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { documentPagination, isUploadFormat, UPLOAD_CONTENT_TYPES } from '../../domain/document-formats'
import { dateLabel } from '../../domain/selectors'
import {
  RUBRIC_DESCRIPTION_KEY,
  RUBRIC_NAME_KEY,
  applyRubricAssistOperations,
  criterionFieldKey,
  criterionPresenceKey,
  rubricAssistOperationFieldKeys,
  toRubricAssistDraft,
  type RubricAssistResponse,
} from '../../domain/rubric-assist'
import { AssistedEditorShell, type AssistedEditorPanel } from '../assist/AssistedEditorShell'
import { AssistConversation } from '../assist/AssistConversation'
import { useAssistConversation } from '../assist/useAssistConversation'
import { ChangeHistoryPanel, type SavedAssistVersion } from '../assist/ChangeHistoryPanel'
import { ChangedField, RemovedItemRow } from '../assist/ChangedField'
import { useEditSession } from '../assist/useEditSession'
import { describeRubricAssistOperations, rubricEditAdapter, rubricVersionChangeNote, summarizeRubricAssistOperations } from './rubricAssist'
import '../../styles/assisted-editing.css'

export function RubricEditor({ rubric, onClose, onSaved, initialPanel = null, initialFocusCriterionId = null }: {
  rubric: Rubric
  onClose: () => void
  onSaved: (id: string) => void
  initialPanel?: 'assist' | 'source' | 'changes' | null
  initialFocusCriterionId?: string | null
}) {
  const { workspace, saveRubric, cloud } = useWorkspace()
  const { settings } = usePublicSettings()
  const { canEdit } = useLifecycleAccess({ kind: 'rubric', id: rubric.groupId })
  const session = useEditSession({ baseline: rubric, adapter: rubricEditAdapter })
  const draftRef = useRef(session.draft)
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmingAiSave, setConfirmingAiSave] = useState(false)
  const [activePanel, setActivePanel] = useState<string | null>(initialPanel)
  const [focusCriterionId, setFocusCriterionId] = useState<string | null>(initialFocusCriterionId)
  const [sourceHighlight, setSourceHighlight] = useState<{ paragraphId?: string; quote?: string }>({})
  const [liveMessage, setLiveMessage] = useState('')
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null)
  const submitting = useRef(false)
  const feedback = useRef<HTMLDivElement>(null)
  const formId = useId()
  const errorsId = useId()
  const weightHintId = useId()
  const job = workspace.jobs.find((item) => item.id === rubric.jobId)
  const detail = job ? cloud.realJobs.detail(job.id) : undefined
  const detailDocument = detail?.state === 'ready' ? detail.value.document : undefined
  const document = detailDocument ?? workspace.documents.find((item) => item.id === job?.documentId)
  const source = job ? cloud.realJobs.source(job.id) : undefined
  const pagination = documentPagination(source?.originalContentType ?? (job && isUploadFormat(job.source) ? UPLOAD_CONTENT_TYPES[job.source] : undefined))
  const assistantAvailable = Boolean(job && document && detail?.state === 'ready' && cloud.realJobs.features?.rubricAssistant && canEdit)
  const assistantUnavailableReason = job && canEdit && !assistantAvailable
    ? detail?.state !== 'ready' ? 'Load this real job before asking AI assist.'
    : !cloud.realJobs.features?.rubricAssistant ? 'AI assist is not available for this workspace right now.'
    : !document ? 'Load the job posting before asking AI assist.' : null
    : null
  const maxCriteria = Math.min(20, settings?.rubrics.jobs.maxCriteria ?? cloud.realJobs.features?.limits.maxCriteria ?? 20)

  function versionId(version: Rubric): string {
    return `${version.id}:${version.version}`
  }

  function savedVersionRubrics(): Rubric[] {
    const versions = detail?.state === 'ready' ? detail.value.rubricVersions : workspace.rubrics.filter((item) => item.groupId === rubric.groupId)
    return [...versions].sort((left, right) => right.version - left.version)
  }

  const savedRubrics = useMemo(savedVersionRubrics, [detail, rubric.groupId, workspace.rubrics])
  const previewRubric = savedRubrics.find((item) => versionId(item) === previewVersionId) ?? null
  const savedVersions: SavedAssistVersion[] = savedRubrics.map((version, index, versions) => {
    const previous = versions.find((item) => item.version === version.version - 1)
    return {
      id: versionId(version),
      label: `Version ${version.version}`,
      detail: `${version.provenance?.kind === 'generated' ? 'Generated' : 'Reviewer edited'} · ${dateLabel(version.createdAt)}`,
      note: rubricVersionChangeNote(previous, version),
      opened: version.id === rubric.id && version.version === rubric.version,
      latest: index === 0,
    }
  })

  useEffect(() => { draftRef.current = session.draft }, [session.draft])
  useEffect(() => {
    if (!focusCriterionId) return
    const criterion = session.draft.criteria.find((item) => item.id === focusCriterionId)
    const citation = criterion?.sourceCitations?.[0]
    setSourceHighlight({ paragraphId: citation?.paragraphId ?? criterion?.sourceParagraphId, quote: citation?.quote })
  }, [focusCriterionId, session.draft])

  const conversation = useAssistConversation<RubricAssistResponse>({
    send: ({ instruction, focusId, conversation, signal }) => {
      if (!job) throw new Error('The rubric assistant is not available for this workspace.')
      return cloud.realJobs.assistRubric(job.id, {
        submissionId: crypto.randomUUID(),
        base: { rubricId: rubric.id, version: rubric.version },
        instruction,
        conversation,
        focusCriterionId: focusId,
        draft: toRubricAssistDraft(draftRef.current),
      }, signal)
    },
    onResponse: (response, turn) => {
      if (response.outcome !== 'changed') {
        return { outcome: response.outcome, reply: response.reply, changes: [], warnings: response.warnings ?? [], replaySummary: '' }
      }
      const before = draftRef.current
      const next = applyRubricAssistOperations(before, response.operations)
      const keys = [...new Set(response.operations.flatMap(rubricAssistOperationFieldKeys))]
      const summary = summarizeRubricAssistOperations(response.operations, before)
      const changes = describeRubricAssistOperations(response.operations, before)
      session.applyAssist(next, { keys, note: summary, turnId: turn.id })
      draftRef.current = next
      const criteriaCount = new Set(keys.map((key) => /^criterion:([^:]+)/.exec(key)?.[1]).filter(Boolean)).size
      setLiveMessage(`AI assist made ${changes.length} ${changes.length === 1 ? 'change' : 'changes'}${criteriaCount ? ` across ${criteriaCount} ${criteriaCount === 1 ? 'criterion' : 'criteria'}` : ''}. Review the highlighted fields.`)
      setConfirmingAiSave(false)
      return { outcome: response.outcome, reply: response.reply, changes, warnings: response.warnings ?? [], replaySummary: summary }
    },
    describeError: (caught) => {
      const value = caught && typeof caught === 'object' ? caught as { kind?: unknown; status?: unknown; message?: unknown; retryAfterSeconds?: unknown; name?: unknown } : {}
      const kind = typeof value.kind === 'string' ? value.kind : undefined
      const status = typeof value.status === 'number' ? value.status : undefined
      if (kind === 'conflict' || status === 409 || value.name === 'CloudConflictError') return {
        message: 'A newer version of this rubric was saved. Your draft is unchanged; close and reopen the rubric to continue from the latest version.',
        retryable: false,
      }
      if (kind === 'rate-limited' || status === 429) return {
        message: typeof value.message === 'string' && value.message ? value.message : 'AI assist is rate limited. Your draft is unchanged.',
        retryable: true,
        retryAfterSeconds: typeof value.retryAfterSeconds === 'number' ? value.retryAfterSeconds : undefined,
      }
      if (kind === 'timeout') return { message: 'The assistant took too long to respond. Your draft is unchanged.', retryable: true }
      return {
        message: typeof value.message === 'string' && value.message ? value.message : 'AI assist is unavailable. Your draft is unchanged.',
        retryable: kind === 'unavailable' || status === 502 || status === 503,
      }
    },
  })

  // Only saves are "pending" writes; an in-flight assistant request is read-only and is cancelled if the editor closes.
  const guard = useGradeLeaveGuard(session.dirty || conversation.turns.length > 0, saving, `Rubric: ${rubric.name}${conversation.turns.length > 0 ? ' (and assistant conversation)' : ''}`)
  const locked = saving || conversation.pending || !canEdit
  const realErrors = session.draft.criteria.flatMap((criterion, index) => {
    const label = `Criterion ${index + 1}`
    const result: string[] = []
    if (!criterion.requirementType) result.push(`${label} must be marked required or preferred.`)
    if (!criterion.sourceCitations?.length) result.push(`${label} needs an exact source quotation.`)
    for (const citation of criterion.sourceCitations ?? []) {
      const paragraph = document?.paragraphs.find((item) => item.id === citation.paragraphId)
      if (!citation.quote.trim()) result.push(`${label} needs an exact source quotation.`)
      else if (!paragraph || citation.documentId !== document?.id || citation.documentVersion !== document.version) result.push(`${label} must reference a paragraph in this source version.`)
      else if (!paragraph.text.includes(citation.quote.trim())) result.push(`${label}'s quotation must exactly match text in the selected source paragraph.`)
    }
    return result
  })
  if (session.draft.criteria.length > maxCriteria && session.draft.criteria.some(criterion => !rubric.criteria.some(previous => previous.id === criterion.id))) realErrors.push(`Adding new criteria is limited to ${maxCriteria}. Existing saved criteria remain editable.`)
  const errors = [...validateRubric(session.draft), ...realErrors]
  const total = session.draft.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  const balanced = Number.isFinite(total) && Math.abs(total - 100) <= 0.000001

  function edit(keys: string[], note: string, recipe: (draft: Rubric) => Rubric) {
    session.edit(recipe, { keys, note, groupKey: keys[0] })
    setError('')
    setConfirmingAiSave(false)
  }

  function updateCriterion(id: string, patch: Partial<Criterion>, keys: string[], note: string) {
    edit(keys, note, draft => ({ ...draft, criteria: draft.criteria.map((criterion) => criterion.id === id ? { ...criterion, ...patch } : criterion) }))
  }

  function addCriterion() {
    if (session.draft.criteria.length >= maxCriteria) {
      setError(`Real job rubrics may contain no more than ${maxCriteria} criteria.`)
      return
    }
    const id = crypto.randomUUID()
    edit([criterionPresenceKey(id)], 'Added criterion', draft => ({
      ...draft,
      criteria: [...draft.criteria, { id, key: 'custom', label: '', description: '', guidance: '', weight: 0, requirementType: 'required' as const, sourceCitations: [] }],
    }))
  }

  function removeCriterion(id: string) {
    edit([criterionPresenceKey(id)], 'Removed criterion', draft => ({ ...draft, criteria: draft.criteria.filter((item) => item.id !== id) }))
  }

  function citationPatch(criterion: Criterion, paragraphId: string | undefined, quote?: string): Partial<Criterion> {
    const existing = criterion.sourceCitations ?? []
    const paragraph = document?.paragraphs.find((item) => item.id === paragraphId)
    if (!paragraph) return { sourceParagraphId: undefined, sourceCitations: [] }
    return {
      sourceParagraphId: paragraph.id,
      sourceCitations: [{
        documentId: document!.id,
        documentVersion: document!.version,
        paragraphId: paragraph.id,
        page: paragraph.page,
        heading: paragraph.heading,
        quote: quote ?? (existing[0]?.paragraphId === paragraph.id ? existing[0].quote : ''),
      }, ...existing.slice(1)],
    }
  }

  function jumpTo(key: string) {
    setPreviewVersionId(null)
    requestAnimationFrame(() => {
      const element = globalThis.document.querySelector<HTMLElement>(`[data-change-key="${CSS.escape(key)}"]`)
      element?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      const focusable = element?.querySelector<HTMLElement>('input, textarea, select, button, [tabindex]:not([tabindex="-1"])') ?? element
      focusable?.focus({ preventScroll: true })
    })
  }

  function nextChange() {
    if (!session.changes.length) return
    const keys = session.changes.map((change) => change.key)
    const active = globalThis.document.activeElement?.closest<HTMLElement>('[data-change-key]')?.dataset.changeKey
    jumpTo(keys[((active ? keys.indexOf(active) : -1) + 1) % keys.length]!)
  }

  function showSourceForKey(key: string) {
    const id = /^criterion:([^:]+)/.exec(key)?.[1]
    const criterion = session.draft.criteria.find((item) => item.id === id) ?? rubric.criteria.find((item) => item.id === id)
    const citation = criterion?.sourceCitations?.[0]
    if (!citation) return
    setSourceHighlight({ paragraphId: citation.paragraphId, quote: citation.quote })
    setActivePanel('source')
  }

  function close() {
    void guard.close(() => {
      conversation.cancel()
      onClose()
    })
  }

  async function runSave() {
    if (submitting.current || !canEdit) return
    setAttempted(true)
    setError('')
    if (errors.length) {
      requestAnimationFrame(() => feedback.current?.focus())
      return
    }
    submitting.current = true
    guard.hold()
    setSaving(true)
    try {
      const id = await saveRubric({
        ...session.draft,
        ...(session.draft.provenance ? { provenance: { ...session.draft.provenance, kind: 'edited' as const } } : {}),
        name: session.draft.name.trim(),
        description: session.draft.description.trim(),
        criteria: session.draft.criteria.map((criterion) => ({
          ...criterion,
          label: criterion.label.trim(),
          description: criterion.description.trim(),
          guidance: criterion.guidance.trim(),
          sourceParagraphId: criterion.sourceCitations?.[0]?.paragraphId,
          sourceCitations: criterion.sourceCitations?.map((citation) => ({ ...citation, quote: citation.quote.trim() })),
        })),
      })
      guard.release()
      onSaved(id)
    } catch (caught) {
      guard.settle()
      setError(caught instanceof Error ? caught.message : 'The rubric could not be saved. Your edits are still here; try again.')
      submitting.current = false
      setSaving(false)
      requestAnimationFrame(() => feedback.current?.focus())
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (session.aiChangeCount > 0 && !confirmingAiSave) {
      setConfirmingAiSave(true)
      setActivePanel('changes')
      return
    }
    void runSave()
  }

  function changedField(key: string, label: string, children: (describedBy: string | undefined) => ReactNode, isNew = false) {
    return <div data-change-key={key}><ChangedField highlight={session.highlight(key)} previous={session.previous(key)} fieldLabel={label} onRevert={() => session.revert(key)} revertDisabled={locked} isNew={isNew}>{children}</ChangedField></div>
  }

  function renderCriterion(criterion: Criterion, index: number) {
    const presenceKey = criterionPresenceKey(criterion.id)
    const addedBy = session.highlight(presenceKey)
    const changed = session.changes.some((change) => change.key === presenceKey || change.itemKey === presenceKey)
    const labelKey = criterionFieldKey(criterion.id, 'label')
    const weightKey = criterionFieldKey(criterion.id, 'weight')
    const descriptionKey = criterionFieldKey(criterion.id, 'description')
    const guidanceKey = criterionFieldKey(criterion.id, 'guidance')
    const requirementKey = criterionFieldKey(criterion.id, 'requirementType')
    const citationKey = criterionFieldKey(criterion.id, 'citation')
    return <fieldset className={`criterion-card min-w-0 ${changed ? 'rubric-criterion-changed' : ''}`} key={criterion.id} data-change-key={presenceKey}>
      <legend className="px-1 text-[11px] font-semibold text-muted">Criterion {String(index + 1).padStart(2, '0')}</legend>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {addedBy && <Badge tone={addedBy === 'ai' ? 'accent' : 'neutral'}>New · {addedBy === 'ai' ? 'AI assist' : 'You'}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {assistantAvailable && <Button icon={Sparkles} size="sm" variant="ghost" aria-label={`Ask AI about criterion ${index + 1}`} onClick={() => { setFocusCriterionId(criterion.id); setActivePanel('assist') }}>Ask AI</Button>}
          <Button icon={Trash2} size="sm" variant="ghost" disabled={session.draft.criteria.length === 1 || locked} aria-label={`Remove criterion ${index + 1}${criterion.label ? `, ${criterion.label}` : ''}`} title={session.draft.criteria.length === 1 ? 'Keep at least one criterion.' : undefined} onClick={() => removeCriterion(criterion.id)}>Remove</Button>
        </div>
      </div>
      {addedBy && assistantAvailable && !criterion.label.trim() && !criterion.description.trim() && !criterion.guidance.trim() && <DraftWithAi disabled={locked} onDraft={(text) => {
        setFocusCriterionId(criterion.id)
        setActivePanel('assist')
        void conversation.send(`Draft criterion ${String(index + 1).padStart(2, '0')} to assess: ${text || 'a missing requirement from the posting'}. Fill the label, description, 0–5 score guidance, requirement type, exact source quote and weight, rebalancing other weights to total 100.`, criterion.id)
      }} />}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_108px]">
        {changedField(labelKey, 'Label', describedBy => <label className="field"><span className="field-label">Label</span><input className="input" value={criterion.label} onBlur={session.endGroup} onChange={(event) => updateCriterion(criterion.id, { label: event.target.value }, [labelKey], 'Edited criterion label')} placeholder="What are you looking for?" required aria-describedby={describedBy} aria-invalid={attempted && !criterion.label.trim()} /></label>, Boolean(addedBy))}
        {changedField(weightKey, 'Weight', describedBy => <label className="block"><span className="field-label">Weight (%)</span><input className="input" type="number" min={0} max={100} step="any" value={Number.isFinite(criterion.weight) ? criterion.weight : ''} onBlur={session.endGroup} onChange={(event) => updateCriterion(criterion.id, { weight: event.target.valueAsNumber }, [weightKey], 'Edited criterion weight')} aria-describedby={[weightHintId, describedBy].filter(Boolean).join(' ') || undefined} aria-invalid={attempted && (!Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 100)} required /></label>, Boolean(addedBy))}
      </div>
      {changedField(descriptionKey, 'Description', describedBy => <label className="field mt-4"><span className="field-label">Description</span><textarea className="input" rows={2} value={criterion.description} onBlur={session.endGroup} onChange={(event) => updateCriterion(criterion.id, { description: event.target.value }, [descriptionKey], 'Edited criterion description')} placeholder="Describe the experience or evidence to consider." required aria-describedby={describedBy} aria-invalid={attempted && !criterion.description.trim()} /></label>, Boolean(addedBy))}
      {changedField(guidanceKey, 'Score guidance', describedBy => <label className="field"><span className="field-label">Score guidance</span><textarea className="input" rows={3} value={criterion.guidance} onBlur={session.endGroup} onChange={(event) => updateCriterion(criterion.id, { guidance: event.target.value }, [guidanceKey], 'Edited score guidance')} placeholder="Explain what evidence supports different scores from 0 to 5." required aria-describedby={describedBy} aria-invalid={attempted && !criterion.guidance.trim()} /></label>, Boolean(addedBy))}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {changedField(requirementKey, 'Requirement type', describedBy => <label className="field"><span className="field-label">Requirement type</span><select className="input" value={criterion.requirementType ?? ''} required aria-describedby={describedBy} onChange={(event) => updateCriterion(criterion.id, { requirementType: event.target.value === 'preferred' ? 'preferred' : 'required' }, [requirementKey], 'Edited requirement type')}><option value="required">Required</option><option value="preferred">Preferred</option></select></label>, Boolean(addedBy))}
        {changedField(citationKey, 'Source quote', describedBy => <label className="field"><span className="field-label">Source paragraph</span><select className="input" value={criterion.sourceCitations?.[0]?.paragraphId ?? ''} required aria-describedby={describedBy} aria-invalid={attempted && !criterion.sourceCitations?.[0]?.paragraphId} onChange={(event) => updateCriterion(criterion.id, citationPatch(criterion, event.target.value || undefined), [citationKey], 'Edited source quote')}><option value="">Choose a paragraph</option>{document?.paragraphs.map((paragraph) => <option key={paragraph.id} value={paragraph.id}>Page {paragraph.page} / {paragraph.heading}</option>)}</select></label>, Boolean(addedBy))}
      </div>
      <div data-change-key={citationKey} className="mt-4"><label className="field"><span className="field-label">Exact source quote</span><textarea className="input" rows={3} required value={criterion.sourceCitations?.[0]?.quote ?? ''} onBlur={session.endGroup} aria-invalid={attempted && !criterion.sourceCitations?.[0]?.quote.trim()} onFocus={() => setSourceHighlight({ paragraphId: criterion.sourceCitations?.[0]?.paragraphId, quote: criterion.sourceCitations?.[0]?.quote })} onChange={(event) => updateCriterion(criterion.id, citationPatch(criterion, criterion.sourceCitations?.[0]?.paragraphId, event.target.value), [citationKey], 'Edited source quote')} placeholder={criterion.sourceCitations?.[0] ? 'Paste an exact quotation from the selected paragraph.' : 'Choose a source paragraph first.'} disabled={!criterion.sourceCitations?.[0]} /><span className="field-hint">The server verifies this quote against the exact parsed paragraph.       It cannot be a summary or invented page reference.</span></label></div>
    </fieldset>
  }

  const removedChanges = session.changes.filter((change) => change.kind === 'removed')
  const mainForm = <form id={formId} onSubmit={save} noValidate aria-describedby={(attempted && errors.length > 0) || error ? errorsId : undefined}>
    <fieldset disabled={locked} className="space-y-5">
      {assistantAvailable && <div className="flex justify-end"><Button size="sm" variant="ghost" icon={Sparkles} onClick={() => setActivePanel('assist')}>AI assist</Button></div>}
      {changedField(RUBRIC_NAME_KEY, 'Rubric name', describedBy => <label className="field"><span className="field-label">Rubric name</span><input className="input" value={session.draft.name} onBlur={session.endGroup} onChange={(event) => edit([RUBRIC_NAME_KEY], 'Edited rubric name', draft => ({ ...draft, name: event.target.value }))} required aria-describedby={describedBy} aria-invalid={attempted && !session.draft.name.trim()} /></label>)}
      {changedField(RUBRIC_DESCRIPTION_KEY, 'Description', describedBy => <label className="field"><span className="field-label">Description</span><textarea className="input" value={session.draft.description} onBlur={session.endGroup} onChange={(event) => edit([RUBRIC_DESCRIPTION_KEY], 'Edited description', draft => ({ ...draft, description: event.target.value }))} rows={3} required aria-describedby={describedBy} aria-invalid={attempted && !session.draft.description.trim()} /></label>)}
      <div className="flex flex-wrap items-center justify-between gap-3 border-y py-4"><div><h3 className="text-[13px] font-semibold">Evaluation criteria</h3><p id={weightHintId} className="mt-1 text-[11px] text-muted">Rebalance weights after adding or removing a criterion.</p></div><span role="status" aria-live="polite"><Badge tone={balanced ? 'success' : 'warning'} dot>{Number.isFinite(total) ? `${Number(total.toFixed(6))}% / 100%` : 'Invalid weight'}</Badge></span></div>
      <div className="space-y-4">
        {removedChanges.map((change) => <div key={change.key} data-change-key={change.key}><RemovedItemRow label={change.before ?? change.label} author={change.author} onRestore={() => session.revert(change.key)} disabled={locked} /></div>)}
        {session.draft.criteria.map((criterion, index) => renderCriterion(criterion, index))}
      </div>
      <div><Button icon={Plus} size="sm" onClick={addCriterion} disabled={locked || session.draft.criteria.length >= maxCriteria}>Add criterion</Button><p className="mt-2 text-[11px] text-muted">{`New criteria require a required/preferred classification and an exact quotation from this source. Maximum ${maxCriteria} when adding criteria; larger saved versions remain readable and editable without additions.`}</p></div>
      <p className="library-note-text"><ShieldCheck size={16} aria-hidden="true" /><span>Saving appends an immutable reviewer-edited server version. Existing generated and edited versions remain available.</span></p>
      {((attempted && errors.length > 0) || error) && <div id={errorsId} ref={feedback} tabIndex={-1} className="space-y-3">{attempted && errors.length > 0 && <InlineError><p className="mb-1 font-medium">Review the rubric before saving.</p><ul className="list-disc space-y-1 pl-4">{errors.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul></InlineError>}{error && <InlineError>{error}</InlineError>}</div>}
    </fieldset>
  </form>

  const panels: AssistedEditorPanel[] = [
    ...(assistantAvailable || conversation.turns.length > 0 ? [{ id: 'assist', label: 'Ask AI', icon: Sparkles, content: <AssistConversation turns={conversation.turns} pending={conversation.pending} elapsedSeconds={conversation.elapsedSeconds} disabledReason={assistantAvailable ? null : assistantUnavailableReason ?? 'AI assist is not available right now.'} focus={focusCriterionId ? { label: focusLabel(session.draft, focusCriterionId), onClear: () => setFocusCriterionId(null) } : null} quickActions={quickActions(focusCriterionId)} onSend={(instruction) => void conversation.send(instruction, focusCriterionId)} onCancel={conversation.cancel} onRetry={conversation.retry} onUndoTurn={(turnId) => conversation.markUndone(turnId, session.undoTurn(turnId))} onJump={jumpTo} onQuote={(change) => showSourceForKey(change.key)} /> }] as AssistedEditorPanel[] : []),
    ...(document ? [{ id: 'source', label: 'Job posting', icon: FileText, content: <DocumentViewer document={document} highlightedId={sourceHighlight.paragraphId} quote={sourceHighlight.quote} pagination={pagination} compact /> }] as AssistedEditorPanel[] : []),
    { id: 'changes', label: 'Changes', icon: History, badge: session.changes.length || undefined, content: <ChangeHistoryPanel changes={session.changes} entries={session.entries} cursor={session.cursor} evictedEntries={session.evictedEntries} onJump={jumpTo} onRevert={session.revert} onRestore={session.restoreTo} disabled={locked} savedVersions={savedVersions} previewingVersionId={previewVersionId} onPreviewVersion={setPreviewVersionId} onUseVersion={(id) => { const version = savedRubrics.find((item) => versionId(item) === id); if (!version) return; setPreviewVersionId(null); session.loadVersion({ ...session.draft, name: version.name, description: version.description, criteria: structuredClone(version.criteria) }, `Loaded version ${version.version} as a starting point`) }} /> },
  ]

  return <Modal open onOpenChange={(open) => { if (!open) close() }} title="Edit rubric" description={`Save a new version of this rubric. Version ${rubric.version} and its existing analysis results will not change.`} fullscreen footer={<>
    <span className="mr-auto text-[11px] text-muted">Weights must total 100%.</span>
    {confirmingAiSave && <div className="rubric-save-confirm" role="status"><span>Save version {rubric.version + 1} with {session.changes.length} changes ({session.aiChangeCount} from AI assist)?</span><Button size="sm" variant="ghost" onClick={() => setConfirmingAiSave(false)}>Keep reviewing</Button><Button size="sm" variant="primary" icon={Save} onClick={() => void runSave()} disabled={saving || !canEdit}>Confirm and save version {rubric.version + 1}</Button></div>}
    <Button onClick={close} disabled={saving}>Cancel</Button>
    <Button type="submit" form={formId} icon={Save} variant="primary" disabled={saving || !canEdit || confirmingAiSave}>{saving ? 'Saving…' : `Save version ${rubric.version + 1}`}</Button>
  </>}>
    <LifecycleBanner target={{ kind: 'rubric', id: rubric.groupId }} />
    <div className="assist-visually-hidden" aria-live="polite">{liveMessage}</div>
    <AssistedEditorShell activePanel={activePanel} onActivePanelChange={setActivePanel} sideLabel="Rubric editing tools" busy={saving || conversation.pending} history={{ canUndo: session.canUndo, canRedo: session.canRedo, undoLabel: session.undoLabel, redoLabel: session.redoLabel, onUndo: session.undo, onRedo: session.redo, disabled: saving || conversation.pending }} summary={{ total: session.changes.length, ai: session.aiChangeCount, onReview: () => setActivePanel('changes'), onNext: nextChange }} main={<>{previewRubric && <RubricVersionPreview rubric={previewRubric} onBack={() => setPreviewVersionId(null)} />}<div hidden={Boolean(previewRubric)}>{mainForm}</div></>} panels={panels} />
  </Modal>
}

function focusLabel(rubric: Rubric, id: string): string {
  const index = rubric.criteria.findIndex((item) => item.id === id)
  const criterion = rubric.criteria[index]
  return `Criterion ${String(index + 1).padStart(2, '0')} · ${criterion?.label || 'Untitled'}`
}

function quickActions(focusId: string | null) {
  const suffix = focusId ? ' for the focused criterion' : ''
  return [
    { id: 'draft-guidance', label: 'Draft score guidance', instruction: `Draft clearer 0–5 score guidance${suffix}, grounded in the posting.` },
    { id: 'tighten', label: 'Tighten wording', instruction: `Tighten the wording${suffix} without changing the meaning.` },
    { id: 'rebalance', label: 'Rebalance weights', instruction: 'Rebalance the criterion weights so they total 100 while preserving the relative importance implied by the posting.' },
    { id: 'missing', label: 'Suggest missing requirements from the posting', instruction: 'Suggest missing requirements from the posting and add supported criteria with exact quotes if appropriate.' },
    { id: 'consistency', label: 'Check consistency across criteria', instruction: 'Check consistency across criteria, including labels, descriptions, guidance, requirement types, citations and weights.' },
    { id: 'rebuild', label: 'Rebuild from the posting', instruction: 'Rebuild the rubric from the posting, preserving only criteria still strongly supported by exact source quotes and rebalancing weights to total 100.' },
  ]
}

function DraftWithAi({ onDraft, disabled }: { onDraft: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState('')
  return <div className="rubric-draft-with-ai"><label className="field"><span className="field-label">What should this criterion assess?</span><input className="input" value={text} onChange={(event) => setText(event.target.value)} placeholder="Example: stakeholder communication" /></label><Button size="sm" icon={Sparkles} onClick={() => onDraft(text.trim())} disabled={disabled}>Draft with AI</Button></div>
}

function RubricVersionPreview({ rubric, onBack }: { rubric: Rubric; onBack: () => void }) {
  return <div className="rubric-version-preview"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><Badge tone="accent">Previewing Version {rubric.version}</Badge><h3 className="mt-2 text-[15px] font-semibold">{rubric.name}</h3></div><Button size="sm" variant="ghost" onClick={onBack}>Back to draft</Button></div><p className="text-[12px] text-muted">{rubric.description}</p><div className="mt-4 space-y-3">{rubric.criteria.map((criterion, index) => <article className="criterion-card" key={criterion.id}><div className="flex items-start justify-between gap-3"><h4 className="text-[12px] font-semibold">{String(index + 1).padStart(2, '0')} · {criterion.label}</h4><strong>{criterion.weight}%</strong></div><p className="mt-2 text-[11px] text-muted">{criterion.description}</p><p className="mt-2 whitespace-pre-line text-[11px] text-muted">{criterion.guidance}</p>{criterion.sourceCitations?.[0] && <blockquote className="source-quote mt-3">“{criterion.sourceCitations[0].quote}”</blockquote>}</article>)}</div></div>
}
