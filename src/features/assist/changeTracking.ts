import type { ChangeAuthor, DraftChange, EditSessionAdapter, FieldDescriptor, ItemDescriptor } from './types'

interface DraftIndexes {
  fields: Map<string, FieldDescriptor>
  items: Map<string, ItemDescriptor>
  orderedFields: FieldDescriptor[]
  orderedItems: ItemDescriptor[]
}

const indexCache = new WeakMap<object, WeakMap<EditSessionAdapter<unknown>, DraftIndexes>>()

function comparable(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function sameValue(left: unknown, right: unknown): boolean {
  return comparable(left) === comparable(right)
}

function indexesFor<TDraft>(draft: TDraft, adapter: EditSessionAdapter<TDraft>): DraftIndexes {
  if (draft && typeof draft === 'object') {
    const draftObject = draft as object
    const unknownAdapter = adapter as EditSessionAdapter<unknown>
    let adapterCache = indexCache.get(draftObject)
    const cached = adapterCache?.get(unknownAdapter)
    if (cached) return cached
    const indexes = buildIndexes(draft, adapter)
    adapterCache ??= new WeakMap<EditSessionAdapter<unknown>, DraftIndexes>()
    adapterCache.set(unknownAdapter, indexes)
    indexCache.set(draftObject, adapterCache)
    return indexes
  }
  return buildIndexes(draft, adapter)
}

function buildIndexes<TDraft>(draft: TDraft, adapter: EditSessionAdapter<TDraft>): DraftIndexes {
  const orderedFields = adapter.fields(draft)
  const orderedItems = [...adapter.items(draft)].sort((left, right) => left.index - right.index)
  return {
    fields: new Map(orderedFields.map(field => [field.key, field])),
    items: new Map(orderedItems.map(item => [item.key, item])),
    orderedFields,
    orderedItems,
  }
}

function authorFor(key: string, attribution: ReadonlyMap<string, ChangeAuthor>): ChangeAuthor {
  return attribution.get(key) ?? 'user'
}

export function valueEquals<TDraft>(left: TDraft, right: TDraft, adapter: EditSessionAdapter<TDraft>, key: string): boolean {
  const leftIndexes = indexesFor(left, adapter)
  const rightIndexes = indexesFor(right, adapter)
  if (leftIndexes.items.has(key) || rightIndexes.items.has(key)) {
    return leftIndexes.items.has(key) === rightIndexes.items.has(key)
  }
  return sameValue(leftIndexes.fields.get(key)?.value, rightIndexes.fields.get(key)?.value)
}

export function diffKeys<TDraft>(left: TDraft, right: TDraft, adapter: EditSessionAdapter<TDraft>): string[] {
  const leftIndexes = indexesFor(left, adapter)
  const rightIndexes = indexesFor(right, adapter)
  const keys = new Set<string>()
  for (const item of leftIndexes.orderedItems) if (!rightIndexes.items.has(item.key)) keys.add(item.key)
  for (const item of rightIndexes.orderedItems) if (!leftIndexes.items.has(item.key)) keys.add(item.key)
  for (const field of [...leftIndexes.orderedFields, ...rightIndexes.orderedFields]) {
    if (!keys.has(field.key) && !sameValue(leftIndexes.fields.get(field.key)?.value, rightIndexes.fields.get(field.key)?.value)) {
      keys.add(field.key)
    }
  }
  return [...keys]
}

export function diffDrafts<TDraft>(
  baseline: TDraft,
  draft: TDraft,
  adapter: EditSessionAdapter<TDraft>,
  attribution: ReadonlyMap<string, ChangeAuthor>,
): DraftChange[] {
  const baselineIndexes = indexesFor(baseline, adapter)
  const draftIndexes = indexesFor(draft, adapter)
  const changes: DraftChange[] = []
  const pushed = new Set<string>()

  for (const field of draftIndexes.orderedFields) {
    const previous = baselineIndexes.fields.get(field.key)
    const itemStillExists = !field.itemKey || (baselineIndexes.items.has(field.itemKey) && draftIndexes.items.has(field.itemKey))
    if (previous && itemStillExists && !sameValue(previous.value, field.value)) {
      changes.push({
        kind: 'field',
        key: field.key,
        itemKey: field.itemKey,
        label: field.label,
        groupLabel: field.groupLabel,
        before: previous.display,
        after: field.display,
        author: authorFor(field.key, attribution),
      })
      pushed.add(field.key)
    }
  }

  const removed = baselineIndexes.orderedItems
    .filter(item => !draftIndexes.items.has(item.key))
    .map(item => ({
      kind: 'removed' as const,
      key: item.key,
      label: item.label,
      groupLabel: item.label,
      before: item.label,
      author: authorFor(item.key, attribution),
    }))
  const added = draftIndexes.orderedItems
    .filter(item => !baselineIndexes.items.has(item.key))
    .map(item => ({
      kind: 'added' as const,
      key: item.key,
      label: item.label,
      groupLabel: item.label,
      after: item.label,
      author: authorFor(item.key, attribution),
    }))

  for (const change of [...removed, ...added].sort((left, right) => {
    const leftItem = baselineIndexes.items.get(left.key) ?? draftIndexes.items.get(left.key)
    const rightItem = baselineIndexes.items.get(right.key) ?? draftIndexes.items.get(right.key)
    return (leftItem?.index ?? 0) - (rightItem?.index ?? 0)
  })) {
    if (!pushed.has(change.key)) changes.push(change)
  }

  return changes
}

export function highlightFor<TDraft>(
  key: string,
  baseline: TDraft,
  draft: TDraft,
  adapter: EditSessionAdapter<TDraft>,
  attribution: ReadonlyMap<string, ChangeAuthor>,
): ChangeAuthor | null {
  if (valueEquals(baseline, draft, adapter, key)) return null
  return attribution.get(key) ?? 'user'
}

export function previousDisplay<TDraft>(key: string, baseline: TDraft, _draft: TDraft, adapter: EditSessionAdapter<TDraft>): string | undefined {
  const baselineIndexes = indexesFor(baseline, adapter)
  return baselineIndexes.fields.get(key)?.display ?? baselineIndexes.items.get(key)?.label
}

export function aiChangeCount(changes: readonly DraftChange[]): number {
  return changes.filter(change => change.author === 'ai').length
}

function compactRange(numbers: number[]): string {
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

function criterionNumber(groupLabel: string): number | null {
  const match = /^Criterion\s+(\d+)/i.exec(groupLabel)
  return match ? Number(match[1]) : null
}

export function summarizeChanges(changes: readonly DraftChange[], maxParts = 4): string {
  if (!changes.length) return 'No changes'
  const grouped = new Map<string, { label: string; numbers: number[]; plain: string[] }>()
  for (const change of changes) {
    const label = change.kind === 'added' ? 'Added' : change.kind === 'removed' ? 'Removed' : change.label
    const group = grouped.get(label) ?? { label, numbers: [], plain: [] }
    const number = criterionNumber(change.groupLabel)
    if (number === null) group.plain.push(change.groupLabel)
    else group.numbers.push(number)
    grouped.set(label, group)
  }
  const parts = [...grouped.values()].map(group => {
    const references = [
      ...(group.numbers.length ? [`Criterion ${compactRange(group.numbers)}`] : []),
      ...[...new Set(group.plain)].filter(label => label !== 'Rubric'),
    ]
    return references.length ? `${group.label} · ${references.join(', ')}` : group.label
  })
  if (parts.length <= maxParts) return parts.join('; ')
  return `${parts.slice(0, maxParts).join('; ')}; +${parts.length - maxParts} more`
}
