export type ChangeAuthor = 'ai' | 'user'
export type HistoryOrigin = 'ai' | 'user' | 'restore'

export interface FieldDescriptor {
  key: string
  /** Presence key of the owning item, when the field belongs to a repeatable item. */
  itemKey?: string
  label: string
  groupLabel: string
  /** JSON-comparable value used for exact change detection. */
  value: unknown
  /** Plain-text before/after rendering for review UI. */
  display: string
}

export interface ItemDescriptor {
  /** Presence key for the item. */
  key: string
  label: string
  index: number
}

export interface DraftChange {
  kind: 'field' | 'added' | 'removed'
  key: string
  itemKey?: string
  label: string
  groupLabel: string
  before?: string
  after?: string
  author: ChangeAuthor
}

export interface HistoryEntry<TDraft> {
  id: string
  origin: HistoryOrigin
  note: string
  at: number
  draft: TDraft
  attribution: ReadonlyMap<string, ChangeAuthor>
  keys: readonly string[]
  turnId?: string
}

export interface EditSessionAdapter<TDraft> {
  fields(draft: TDraft): FieldDescriptor[]
  items(draft: TDraft): ItemDescriptor[]
  /** Restores one field or item presence to its baseline value/position. */
  revert(draft: TDraft, baseline: TDraft, key: string): TDraft
  /** Copies one key's value/presence from another snapshot, used for per-turn undo. */
  restoreKeyFrom?(draft: TDraft, source: TDraft, key: string): TDraft
}

export interface EditSession<TDraft> {
  baseline: TDraft
  draft: TDraft
  changes: DraftChange[]
  dirty: boolean
  aiChangeCount: number
  /** Action entries only, oldest first. The opened state can be restored with restoreTo('baseline'). */
  entries: readonly HistoryEntry<TDraft>[]
  /** Index of the current action entry, or -1 for the opened baseline. */
  cursor: number
  canUndo: boolean
  canRedo: boolean
  undoLabel: string
  redoLabel: string
  evictedEntries: number
  highlight(key: string): ChangeAuthor | null
  previous(key: string): string | undefined
  edit(recipe: (draft: TDraft) => TDraft, options: { keys: string[]; note: string; groupKey?: string }): void
  endGroup(): void
  applyAssist(next: TDraft, options: { keys: string[]; note: string; turnId: string }): void
  undo(): void
  redo(): void
  restoreTo(entryId: string): void
  revert(key: string): void
  undoTurn(turnId: string): { reverted: number; skipped: number }
  loadVersion(next: TDraft, note: string): void
  reset(newBaseline: TDraft): void
}
