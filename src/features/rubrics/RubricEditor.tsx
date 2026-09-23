import { useId, useRef, useState, type FormEvent } from 'react'
import { Plus, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { usePublicSettings } from '../../app/public-settings-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { Badge, Button, InlineError, Modal } from '../../components/ui'
import type { Criterion, Rubric } from '../../domain/types'
import { validateRubric } from '../../domain/rubric-validation'
import { LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'

export function RubricEditor({ rubric, onClose, onSaved }: {
  rubric: Rubric
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const { workspace, saveRubric, cloud } = useWorkspace()
  const { settings } = usePublicSettings()
  const { canEdit } = useLifecycleAccess({ kind: 'rubric', id: rubric.groupId })
  const [draft, setDraft] = useState<Rubric>(() => structuredClone(rubric))
  const [initialDraft] = useState(() => JSON.stringify(rubric))
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const guard = useGradeLeaveGuard(JSON.stringify(draft) !== initialDraft, saving, `Rubric: ${rubric.name}`)
  const submitting = useRef(false)
  const feedback = useRef<HTMLDivElement>(null)
  const formId = useId()
  const errorsId = useId()
  const weightHintId = useId()
  const job = workspace.jobs.find((item) => item.id === rubric.jobId)
  const document = workspace.documents.find((item) => item.id === job?.documentId)
  const maxCriteria = Math.min(20, settings?.rubrics.jobs.maxCriteria ?? cloud.realJobs.features?.limits.maxCriteria ?? 20)
  const realErrors = draft.criteria.flatMap((criterion, index) => {
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
  if (draft.criteria.length > maxCriteria && draft.criteria.some(criterion => !rubric.criteria.some(previous => previous.id === criterion.id))) realErrors.push(`Adding new criteria is limited to ${maxCriteria}. Existing saved criteria remain editable.`)
  const errors = [...validateRubric(draft), ...realErrors]
  const total = draft.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  const balanced = Number.isFinite(total) && Math.abs(total - 100) <= 0.000001
  const close = () => { void guard.close(onClose) }

  function updateCriterion(id: string, patch: Partial<Criterion>) {
    setDraft((value) => ({
      ...value,
      criteria: value.criteria.map((criterion) => criterion.id === id ? { ...criterion, ...patch } : criterion),
    }))
    setError('')
  }

  function addCriterion() {
    if (draft.criteria.length >= maxCriteria) {
      setError(`Real job rubrics may contain no more than ${maxCriteria} criteria.`)
      return
    }
    setDraft((value) => ({
      ...value,
      criteria: [...value.criteria, {
        id: crypto.randomUUID(),
        key: 'custom',
        label: '',
        description: '',
        guidance: '',
        weight: 0,
        requirementType: 'required' as const,
        sourceCitations: [],
      }],
    }))
    setError('')
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
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
        ...draft,
        ...(draft.provenance ? { provenance: { ...draft.provenance, kind: 'edited' as const } } : {}),
        name: draft.name.trim(),
        description: draft.description.trim(),
        criteria: draft.criteria.map((criterion) => ({
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

  return <Modal
    open
    onOpenChange={(open) => { if (!open) close() }}
    title="Edit rubric"
    description={`Save a new version of this rubric. Version ${rubric.version} and its existing analysis results will not change.`}
    wide
    footer={<>
      <span className="mr-auto text-[11px] text-muted">Weights must total 100%.</span>
      <Button onClick={close} disabled={saving}>Cancel</Button>
      <Button type="submit" form={formId} icon={Save} variant="primary" disabled={saving || !canEdit}>
        {saving ? 'Saving…' : `Save version ${rubric.version + 1}`}
      </Button>
    </>}
  >
    <LifecycleBanner target={{ kind: 'rubric', id: rubric.groupId }} />
    <form id={formId} onSubmit={save} noValidate aria-describedby={(attempted && errors.length > 0) || error ? errorsId : undefined}>
      <fieldset disabled={saving || !canEdit} className="space-y-5">
        <label className="field">
          <span className="field-label">Rubric name</span>
          <input
            className="input"
            value={draft.name}
            onChange={(event) => { setDraft({ ...draft, name: event.target.value }); setError('') }}
            required
            aria-invalid={attempted && !draft.name.trim()}
          />
        </label>
        <label className="field">
          <span className="field-label">Description</span>
          <textarea
            className="input"
            value={draft.description}
            onChange={(event) => { setDraft({ ...draft, description: event.target.value }); setError('') }}
            rows={3}
            required
            aria-invalid={attempted && !draft.description.trim()}
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3 border-y py-4">
          <div>
            <h3 className="text-[13px] font-semibold">Evaluation criteria</h3>
            <p id={weightHintId} className="mt-1 text-[11px] text-muted">
              Rebalance weights after adding or removing a criterion.
            </p>
          </div>
          <span role="status" aria-live="polite">
            <Badge tone={balanced ? 'success' : 'warning'} dot>
              {Number.isFinite(total) ? `${Number(total.toFixed(6))}% / 100%` : 'Invalid weight'}
            </Badge>
          </span>
        </div>

        <div>
          {draft.criteria.map((criterion, index) => <fieldset className="criterion-card min-w-0" key={criterion.id}>
            <legend className="px-1 text-[11px] font-semibold text-muted">Criterion {String(index + 1).padStart(2, '0')}</legend>
            <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
              <Button
                icon={Trash2}
                size="sm"
                variant="ghost"
                disabled={draft.criteria.length === 1}
                aria-label={`Remove criterion ${index + 1}${criterion.label ? `, ${criterion.label}` : ''}`}
                title={draft.criteria.length === 1 ? 'Keep at least one criterion.' : undefined}
                onClick={() => {
                  setDraft((value) => ({ ...value, criteria: value.criteria.filter((item) => item.id !== criterion.id) }))
                  setError('')
                }}
              >Remove</Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_108px]">
              <label className="field">
                <span className="field-label">Label</span>
                <input
                  className="input"
                  value={criterion.label}
                  onChange={(event) => updateCriterion(criterion.id, { label: event.target.value })}
                  placeholder="What are you looking for?"
                  required
                  aria-invalid={attempted && !criterion.label.trim()}
                />
              </label>
              <label className="block">
                <span className="field-label">Weight (%)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  value={Number.isFinite(criterion.weight) ? criterion.weight : ''}
                  onChange={(event) => updateCriterion(criterion.id, { weight: event.target.valueAsNumber })}
                  aria-describedby={weightHintId}
                  aria-invalid={attempted && (!Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 100)}
                  required
                />
              </label>
            </div>
            <label className="field mt-4">
              <span className="field-label">Description</span>
              <textarea
                className="input"
                rows={2}
                value={criterion.description}
                onChange={(event) => updateCriterion(criterion.id, { description: event.target.value })}
                placeholder="Describe the experience or evidence to consider."
                required
                aria-invalid={attempted && !criterion.description.trim()}
              />
            </label>
            <label className="field">
              <span className="field-label">Score guidance</span>
              <textarea
                className="input"
                rows={3}
                value={criterion.guidance}
                onChange={(event) => updateCriterion(criterion.id, { guidance: event.target.value })}
                placeholder="Explain what evidence supports different scores from 0 to 5."
                required
                aria-invalid={attempted && !criterion.guidance.trim()}
              />
            </label>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="field">
                <span className="field-label">Requirement type</span>
                <select className="input" value={criterion.requirementType ?? ''} required
                  onChange={(event) => updateCriterion(criterion.id, { requirementType: event.target.value === 'preferred' ? 'preferred' : 'required' })}>
                  <option value="required">Required</option>
                  <option value="preferred">Preferred</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Source paragraph</span>
                <select className="input" value={criterion.sourceCitations?.[0]?.paragraphId ?? ''} required
                  aria-invalid={attempted && !criterion.sourceCitations?.[0]?.paragraphId}
                  onChange={(event) => {
                    const paragraph = document?.paragraphs.find((item) => item.id === event.target.value)
                    const existing = criterion.sourceCitations ?? []
                    updateCriterion(criterion.id, {
                      sourceParagraphId: paragraph?.id,
                      sourceCitations: paragraph ? [{
                        documentId: document!.id,
                        documentVersion: document!.version,
                        paragraphId: paragraph.id,
                        page: paragraph.page,
                        heading: paragraph.heading,
                        quote: existing[0]?.paragraphId === paragraph.id ? existing[0].quote : '',
                      }, ...existing.slice(1)] : [],
                    })
                  }}>
                  <option value="">Choose a paragraph</option>
                  {document?.paragraphs.map((paragraph) => <option key={paragraph.id} value={paragraph.id}>Page {paragraph.page} / {paragraph.heading}</option>)}
                </select>
              </label>
            </div>
            <label className="field mt-4">
              <span className="field-label">Exact source quote</span>
              <textarea className="input" rows={3} required value={criterion.sourceCitations?.[0]?.quote ?? ''}
                aria-invalid={attempted && !criterion.sourceCitations?.[0]?.quote.trim()}
                onChange={(event) => {
                  const citation = criterion.sourceCitations?.[0]
                  if (citation) updateCriterion(criterion.id, { sourceCitations: [{ ...citation, quote: event.target.value }, ...(criterion.sourceCitations?.slice(1) ?? [])] })
                }}
                placeholder={criterion.sourceCitations?.[0] ? 'Paste an exact quotation from the selected paragraph.' : 'Choose a source paragraph first.'}
                disabled={!criterion.sourceCitations?.[0]} />
              <span className="field-hint">The server verifies this quote against the exact parsed paragraph. It cannot be a summary or invented page reference.</span>
            </label>
          </fieldset>)}
        </div>

        <div>
          <Button icon={Plus} size="sm" onClick={addCriterion} disabled={draft.criteria.length >= maxCriteria}>Add criterion</Button>
          <p className="mt-2 text-[11px] text-muted">
            {`New criteria require a required/preferred classification and an exact quotation from this source. Maximum ${maxCriteria} when adding criteria; larger saved versions remain readable and editable without additions.`}
          </p>
        </div>

        <p className="library-note-text"><ShieldCheck size={16} aria-hidden="true" /><span>Saving appends an immutable reviewer-edited server version. Existing generated and edited versions remain available.</span></p>
        {((attempted && errors.length > 0) || error) && <div id={errorsId} ref={feedback} tabIndex={-1} className="space-y-3">
          {attempted && errors.length > 0 && <InlineError>
            <p className="mb-1 font-medium">Review the rubric before saving.</p>
            <ul className="list-disc space-y-1 pl-4">{errors.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul>
          </InlineError>}
          {error && <InlineError>{error}</InlineError>}
        </div>}
      </fieldset>
    </form>
  </Modal>
}
