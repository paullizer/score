import type { EditSessionAdapter, FieldDescriptor, ItemDescriptor } from '../assist/types'
import {
  RUBRIC_CRITERION_FIELDS,
  RUBRIC_DESCRIPTION_KEY,
  RUBRIC_NAME_KEY,
  applyRubricAssistOperations,
  criterionFieldKey,
  criterionPresenceKey,
  rubricAssistOperationFieldKeys,
  type RubricAssistOperation,
  type RubricCriterionField,
} from '../../domain/rubric-assist'
import type { Citation, Criterion, Rubric } from '../../domain/types'

function cloneCitation(citation: Citation): Citation {
  return { ...citation }
}

function cloneCriterion(criterion: Criterion): Criterion {
  return {
    ...criterion,
    ...(criterion.sourceCitations ? { sourceCitations: criterion.sourceCitations.map(cloneCitation) } : {}),
  }
}

function criterionGroupLabel(criterion: Criterion, index: number): string {
  return `Criterion ${String(index + 1).padStart(2, '0')} · ${criterion.label.trim() || 'Untitled'}`
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Not set'
  return `${Number(value.toFixed(6))}%`
}

function criterionFieldDisplay(criterion: Criterion, field: RubricCriterionField): { value: unknown; display: string } {
  switch (field) {
    case 'label':
    case 'description':
    case 'guidance':
      return { value: criterion[field], display: criterion[field] || 'Blank' }
    case 'weight':
      return { value: Number.isFinite(criterion.weight) ? criterion.weight : null, display: formatPercent(criterion.weight) }
    case 'requirementType':
      return {
        value: criterion.requirementType ?? null,
        display: criterion.requirementType === 'required' ? 'Required' : criterion.requirementType === 'preferred' ? 'Preferred' : 'Not set',
      }
    case 'citation': {
      const citation = criterion.sourceCitations?.[0]
      return {
        value: citation ? { paragraphId: citation.paragraphId, quote: citation.quote } : null,
        display: citation?.quote || 'No source quote',
      }
    }
  }
}

function fieldLabel(field: RubricCriterionField): string {
  switch (field) {
    case 'label':
      return 'Label'
    case 'description':
      return 'Description'
    case 'guidance':
      return 'Score guidance'
    case 'weight':
      return 'Weight'
    case 'requirementType':
      return 'Requirement type'
    case 'citation':
      return 'Source quote'
  }
}

function replaceCriterion(rubric: Rubric, id: string, recipe: (criterion: Criterion) => Criterion): Rubric {
  return {
    ...rubric,
    criteria: rubric.criteria.map(criterion => criterion.id === id ? recipe(criterion) : criterion),
  }
}

function removeCriterion(rubric: Rubric, id: string): Rubric {
  return { ...rubric, criteria: rubric.criteria.filter(criterion => criterion.id !== id) }
}

function restoreCriterionPresence(draft: Rubric, source: Rubric, key: string): Rubric {
  const id = key.replace(/^criterion:/, '')
  const sourceIndex = source.criteria.findIndex(criterion => criterion.id === id)
  const draftIndex = draft.criteria.findIndex(criterion => criterion.id === id)
  if (sourceIndex < 0) return draftIndex < 0 ? draft : removeCriterion(draft, id)
  const restored = cloneCriterion(source.criteria[sourceIndex]!)
  const criteria = draft.criteria.filter(criterion => criterion.id !== id)
  criteria.splice(Math.min(sourceIndex, criteria.length), 0, restored)
  return { ...draft, criteria }
}

function restoreCriterionField(draft: Rubric, source: Rubric, criterionId: string, field: RubricCriterionField): Rubric {
  const sourceCriterion = source.criteria.find(criterion => criterion.id === criterionId)
  if (!sourceCriterion) return draft
  return replaceCriterion(draft, criterionId, current => {
    switch (field) {
      case 'citation':
        return {
          ...current,
          sourceParagraphId: sourceCriterion.sourceParagraphId,
          sourceCitations: sourceCriterion.sourceCitations?.map(cloneCitation),
        }
      case 'requirementType':
        return { ...current, requirementType: sourceCriterion.requirementType }
      default:
        return { ...current, [field]: sourceCriterion[field] }
    }
  })
}

function parseCriterionFieldKey(key: string): { criterionId: string; field: RubricCriterionField } | null {
  const match = /^criterion:(.+):(label|description|guidance|weight|requirementType|citation)$/.exec(key)
  if (!match) return null
  return { criterionId: match[1]!, field: match[2] as RubricCriterionField }
}

function restoreKeyFrom(draft: Rubric, source: Rubric, key: string): Rubric {
  if (key === RUBRIC_NAME_KEY) return { ...draft, name: source.name }
  if (key === RUBRIC_DESCRIPTION_KEY) return { ...draft, description: source.description }
  const field = parseCriterionFieldKey(key)
  if (field) return restoreCriterionField(draft, source, field.criterionId, field.field)
  if (/^criterion:[^:]+$/.test(key)) return restoreCriterionPresence(draft, source, key)
  return draft
}

export const rubricEditAdapter: EditSessionAdapter<Rubric> = {
  fields(rubric) {
    const fields: FieldDescriptor[] = [
      { key: RUBRIC_NAME_KEY, label: 'Rubric name', groupLabel: 'Rubric', value: rubric.name, display: rubric.name || 'Blank' },
      { key: RUBRIC_DESCRIPTION_KEY, label: 'Description', groupLabel: 'Rubric', value: rubric.description, display: rubric.description || 'Blank' },
    ]
    rubric.criteria.forEach((criterion, index) => {
      const groupLabel = criterionGroupLabel(criterion, index)
      for (const field of RUBRIC_CRITERION_FIELDS) {
        const display = criterionFieldDisplay(criterion, field)
        fields.push({
          key: criterionFieldKey(criterion.id, field),
          itemKey: criterionPresenceKey(criterion.id),
          label: fieldLabel(field),
          groupLabel,
          ...display,
        })
      }
    })
    return fields
  },
  items(rubric): ItemDescriptor[] {
    return rubric.criteria.map((criterion, index) => ({
      key: criterionPresenceKey(criterion.id),
      label: criterionGroupLabel(criterion, index),
      index,
    }))
  },
  revert: restoreKeyFrom,
  restoreKeyFrom,
}

function criterionIndex(rubric: Rubric, id: string): number {
  return rubric.criteria.findIndex(criterion => criterion.id === id)
}

function criterionLabel(rubric: Rubric, id: string): string {
  const index = criterionIndex(rubric, id)
  const criterion = rubric.criteria[index]
  return criterion ? criterionGroupLabel(criterion, index) : 'Criterion'
}

function describeCriterionField(before: Rubric, criterion: Criterion, field: RubricCriterionField, nextValue: unknown): { label: string; detail?: string; quote?: string } {
  const current = criterionFieldDisplay(criterion, field)
  const nextCriterion = { ...criterion }
  if (field === 'citation') {
    const citation = nextValue as Citation | undefined
    nextCriterion.sourceCitations = citation ? [citation] : undefined
  } else {
    ;(nextCriterion as unknown as Record<string, unknown>)[field] = nextValue
  }
  const next = criterionFieldDisplay(nextCriterion, field)
  const group = criterionLabel(before, criterion.id)
  return {
    label: field === 'guidance' ? `Updated score guidance · ${group}` : `${fieldLabel(field)} · ${group}`,
    detail: `${current.display} → ${next.display}`,
    ...(field === 'citation' && typeof next.display === 'string' && next.display !== 'No source quote' ? { quote: next.display } : {}),
  }
}

export function describeRubricAssistOperations(
  operations: readonly RubricAssistOperation[],
  before: Rubric,
): { key: string; label: string; detail?: string; quote?: string }[] {
  const descriptions: { key: string; label: string; detail?: string; quote?: string }[] = []
  let current = before
  for (const operation of operations) {
    switch (operation.type) {
      case 'updateRubric':
        if (operation.name !== undefined) descriptions.push({
          key: RUBRIC_NAME_KEY,
          label: 'Renamed rubric',
          detail: `${current.name || 'Blank'} → ${operation.name}`,
        })
        if (operation.description !== undefined) descriptions.push({
          key: RUBRIC_DESCRIPTION_KEY,
          label: 'Updated description',
          detail: `${current.description || 'Blank'} → ${operation.description}`,
        })
        break
      case 'updateCriterion': {
        const criterion = current.criteria.find(item => item.id === operation.criterionId)
        if (criterion) {
          for (const field of RUBRIC_CRITERION_FIELDS) {
            const value = operation.changes[field]
            if (value !== undefined) {
              descriptions.push({
                key: criterionFieldKey(operation.criterionId, field),
                ...describeCriterionField(current, criterion, field, value),
              })
            }
          }
        }
        break
      }
      case 'addCriterion': {
        const preview = operation.afterCriterionId === null
          ? [...current.criteria, operation.criterion]
          : current.criteria.flatMap(criterion => criterion.id === operation.afterCriterionId ? [criterion, operation.criterion] : [criterion])
        const index = preview.findIndex(criterion => criterion.id === operation.criterion.id)
        descriptions.push({
          key: criterionPresenceKey(operation.criterion.id),
          label: `Added ${criterionGroupLabel(operation.criterion, index)} (${formatPercent(operation.criterion.weight)})`,
          quote: operation.criterion.sourceCitations[0]?.quote,
        })
        break
      }
      case 'removeCriterion':
        descriptions.push({ key: criterionPresenceKey(operation.criterionId), label: `Removed ${criterionLabel(current, operation.criterionId)}` })
        break
    }
    current = applyRubricAssistOperations(current, [operation])
  }
  return descriptions
}

function compactNumbers(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right)
  const parts: string[] = []
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index]
    let end = start
    while (sorted[index + 1] === end + 1) {
      index += 1
      end = sorted[index]
    }
    parts.push(start === end ? String(start).padStart(2, '0') : `${String(start).padStart(2, '0')}–${String(end).padStart(2, '0')}`)
  }
  return parts.join(', ')
}

export function summarizeRubricAssistOperations(operations: readonly RubricAssistOperation[], before: Rubric): string {
  const groups = new Map<string, number[]>()
  let current = before
  let rubricName = false
  let rubricDescription = false
  const addedNumbers: number[] = []
  const removedNumbers: number[] = []
  for (const operation of operations) {
    if (operation.type === 'updateRubric') {
      rubricName ||= operation.name !== undefined
      rubricDescription ||= operation.description !== undefined
    } else if (operation.type === 'updateCriterion') {
      const index = criterionIndex(current, operation.criterionId)
      for (const field of RUBRIC_CRITERION_FIELDS) {
        if (operation.changes[field] !== undefined) {
          const label = field === 'guidance' ? 'Guidance' : field === 'weight' ? 'Weights' : fieldLabel(field)
          groups.set(label, [...(groups.get(label) ?? []), index + 1])
        }
      }
    } else if (operation.type === 'removeCriterion') {
      removedNumbers.push(criterionIndex(current, operation.criterionId) + 1)
    }
    current = applyRubricAssistOperations(current, [operation])
    // Numbered by the draft's position once added, matching the editor's "Criterion 03" legend.
    if (operation.type === 'addCriterion') addedNumbers.push(criterionIndex(current, operation.criterion.id) + 1)
  }
  const parts = [
    ...(rubricName ? ['Renamed rubric'] : []),
    ...(rubricDescription ? ['Updated description'] : []),
    ...[...groups].map(([label, numbers]) => `${label} · Criterion ${compactNumbers(numbers)}`),
    ...(addedNumbers.length ? [`Added Criterion ${compactNumbers(addedNumbers)}`] : []),
    ...(removedNumbers.length ? [`Removed Criterion ${compactNumbers(removedNumbers)}`] : []),
  ]
  return parts.length ? parts.slice(0, 5).join('; ') : 'No changes'
}

export function rubricVersionChangeNote(previous: Rubric | undefined, next: Rubric): string {
  if (!previous || (next.version === 1 && next.provenance?.kind === 'generated')) return 'Generated'
  const added = next.criteria.filter(criterion => !previous.criteria.some(item => item.id === criterion.id)).length
  const removed = previous.criteria.filter(criterion => !next.criteria.some(item => item.id === criterion.id)).length
  let edited = 0
  let weightsChanged = false
  for (const criterion of next.criteria) {
    const before = previous.criteria.find(item => item.id === criterion.id)
    if (!before) continue
    const fieldsChanged = RUBRIC_CRITERION_FIELDS.some(field => {
      const beforeValue = criterionFieldDisplay(before, field).value
      const afterValue = criterionFieldDisplay(criterion, field).value
      return JSON.stringify(beforeValue ?? null) !== JSON.stringify(afterValue ?? null)
    })
    if (fieldsChanged) edited += 1
    weightsChanged ||= before.weight !== criterion.weight
  }
  const parts = [
    ...(previous.name !== next.name && previous.description !== next.description ? ['Name and description edited'] : previous.name !== next.name ? ['Name edited'] : previous.description !== next.description ? ['Description edited'] : []),
    ...(edited ? [`${edited} ${edited === 1 ? 'criterion' : 'criteria'} edited`] : []),
    ...(added ? [`${added} added`] : []),
    ...(removed ? [`${removed} removed`] : []),
    ...(weightsChanged ? ['weights changed'] : []),
  ]
  if (parts.length) return parts.join(' · ')
  return 'No criterion changes'
}

export { rubricAssistOperationFieldKeys }
