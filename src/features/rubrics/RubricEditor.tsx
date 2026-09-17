import { useId, useRef, useState, type FormEvent } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { Badge, Button, DemoNote, InlineError, Modal } from '../../components/ui'
import type { Criterion, Rubric } from '../../domain/types'
import { validateRubric } from '../../services/mockWorkspace'

export function RubricEditor({ rubric, onClose, onSaved }: {
  rubric: Rubric
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const { saveRubric } = useWorkspace()
  const [draft, setDraft] = useState<Rubric>(() => structuredClone(rubric))
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submitting = useRef(false)
  const feedback = useRef<HTMLDivElement>(null)
  const formId = useId()
  const errorsId = useId()
  const weightHintId = useId()
  const errors = validateRubric(draft)
  const total = draft.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  const balanced = Number.isFinite(total) && Math.abs(total - 100) <= 0.000001

  function updateCriterion(id: string, patch: Partial<Criterion>) {
    setDraft((value) => ({
      ...value,
      criteria: value.criteria.map((criterion) => criterion.id === id ? { ...criterion, ...patch } : criterion),
    }))
    setError('')
  }

  function addCriterion() {
    setDraft((value) => ({
      ...value,
      criteria: [...value.criteria, {
        id: crypto.randomUUID(),
        key: 'custom',
        label: '',
        description: '',
        guidance: '',
        weight: 0,
      }],
    }))
    setError('')
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    setAttempted(true)
    setError('')
    if (errors.length) {
      requestAnimationFrame(() => feedback.current?.focus())
      return
    }
    submitting.current = true
    setSaving(true)
    try {
      const id = saveRubric({
        ...draft,
        name: draft.name.trim(),
        description: draft.description.trim(),
        criteria: draft.criteria.map((criterion) => ({
          ...criterion,
          label: criterion.label.trim(),
          description: criterion.description.trim(),
          guidance: criterion.guidance.trim(),
        })),
      })
      onSaved(id)
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught
      setError(caught.message)
      submitting.current = false
      setSaving(false)
      requestAnimationFrame(() => feedback.current?.focus())
    }
  }

  return <Modal
    open
    onOpenChange={(open) => { if (!open && !submitting.current) onClose() }}
    title="Edit rubric"
    description={`Save a new version of this rubric. Version ${rubric.version} and its existing analysis results will not change.`}
    wide
    footer={<>
      <span className="mr-auto text-[11px] text-muted">Weights must total 100%.</span>
      <Button onClick={onClose} disabled={saving}>Cancel</Button>
      <Button type="submit" form={formId} icon={Save} variant="primary" disabled={saving}>
        {saving ? 'Saving…' : `Save version ${rubric.version + 1}`}
      </Button>
    </>}
  >
    <form id={formId} onSubmit={save} noValidate aria-describedby={(attempted && errors.length > 0) || error ? errorsId : undefined}>
      <div className="space-y-5">
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
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              {criterion.key === 'custom'
                ? <Badge tone="warning">Custom · not assessed in demo</Badge>
                : <Badge>Sample scoring: {criterion.key}</Badge>}
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
          </fieldset>)}
        </div>

        <div>
          <Button icon={Plus} size="sm" onClick={addCriterion}>Add criterion</Button>
          <p className="mt-2 text-[11px] text-muted">
            New criteria are custom. The demo cannot assess them and will not invent supporting evidence.
          </p>
        </div>

        <DemoNote>
          {rubric.kind === 'grade'
            ? 'Grade guidance is illustrative, not an official qualification or eligibility standard. Edits change the rubric; demo scores still use fictional evidence.'
            : 'Edits stay linked to this job. The demo uses fictional source text and fixed sample evidence, not a language model.'}
        </DemoNote>
        {((attempted && errors.length > 0) || error) && <div id={errorsId} ref={feedback} tabIndex={-1} className="space-y-3">
          {attempted && errors.length > 0 && <InlineError>
            <p className="mb-1 font-medium">Review the rubric before saving.</p>
            <ul className="list-disc space-y-1 pl-4">{errors.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul>
          </InlineError>}
          {error && <InlineError>{error}</InlineError>}
        </div>}
      </div>
    </form>
  </Modal>
}
