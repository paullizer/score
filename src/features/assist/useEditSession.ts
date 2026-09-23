import { useCallback, useMemo, useReducer, useRef } from 'react'
import { ASSIST_LIMITS } from '../../domain/assist'
import {
  aiChangeCount as countAiChanges,
  diffDrafts,
  diffKeys,
  highlightFor,
  previousDisplay,
  summarizeChanges,
  valueEquals,
} from './changeTracking'
import type { ChangeAuthor, EditSession, EditSessionAdapter, HistoryEntry, HistoryOrigin } from './types'

interface EditSessionState<TDraft> {
  baseline: TDraft
  draft: TDraft
  attribution: ReadonlyMap<string, ChangeAuthor>
  entries: readonly HistoryEntry<TDraft>[]
  cursor: number
  evictedEntries: number
  openGroupKey?: string
}

type EditSessionAction<TDraft> =
  | { type: 'edit'; recipe: (draft: TDraft) => TDraft; keys: readonly string[]; note: string; groupKey?: string; id: string; at: number; adapter: EditSessionAdapter<TDraft>; maxEntries: number }
  | { type: 'endGroup' }
  | { type: 'entry'; origin: HistoryOrigin; draft: TDraft; keys: readonly string[]; note: string; id: string; at: number; turnId?: string; attribution?: ReadonlyMap<string, ChangeAuthor>; adapter: EditSessionAdapter<TDraft>; maxEntries: number }
  | { type: 'loadVersion'; draft: TDraft; note: string; id: string; at: number; adapter: EditSessionAdapter<TDraft>; maxEntries: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'restoreTo'; entryId: string; id: string; at: number; adapter: EditSessionAdapter<TDraft>; maxEntries: number }
  | { type: 'revert'; key: string; id: string; at: number; adapter: EditSessionAdapter<TDraft>; maxEntries: number }
  | { type: 'undoTurn'; turnId: string; id: string; at: number; adapter: EditSessionAdapter<TDraft>; maxEntries: number }
  | { type: 'reset'; baseline: TDraft }

export interface EditSessionReducerResult<TDraft> {
  state: EditSessionState<TDraft>
  undoTurnResult?: { reverted: number; skipped: number }
}

export function createEditSessionState<TDraft>(baseline: TDraft): EditSessionState<TDraft> {
  return { baseline, draft: baseline, attribution: new Map(), entries: [], cursor: -1, evictedEntries: 0 }
}

function currentAttribution<TDraft>(state: EditSessionState<TDraft>, cursor = state.cursor): ReadonlyMap<string, ChangeAuthor> {
  return cursor >= 0 ? state.entries[cursor]?.attribution ?? new Map() : new Map()
}

function currentDraft<TDraft>(state: EditSessionState<TDraft>, cursor = state.cursor): TDraft {
  return cursor >= 0 ? state.entries[cursor]?.draft ?? state.baseline : state.baseline
}

function appendEntry<TDraft>(
  state: EditSessionState<TDraft>,
  entry: HistoryEntry<TDraft>,
  maxEntries: number,
  openGroupKey?: string,
): EditSessionState<TDraft> {
  let entries = [...state.entries.slice(0, state.cursor + 1), entry]
  let evictedEntries = state.evictedEntries
  while (entries.length > maxEntries) {
    entries = entries.slice(1)
    evictedEntries += 1
  }
  return { ...state, draft: entry.draft, attribution: entry.attribution, entries, cursor: entries.length - 1, evictedEntries, openGroupKey }
}

function noteFor(keys: readonly string[], fallback: string): string {
  return keys.length ? fallback : 'No changes'
}

function attributionWith(keys: readonly string[], source: ReadonlyMap<string, ChangeAuthor>, author: ChangeAuthor): Map<string, ChangeAuthor> {
  const next = new Map(source)
  for (const key of keys) next.set(key, author)
  return next
}

function changedAttribution<TDraft>(
  baseline: TDraft,
  draft: TDraft,
  adapter: EditSessionAdapter<TDraft>,
  author: ChangeAuthor,
): Map<string, ChangeAuthor> {
  return attributionWith(diffKeys(baseline, draft, adapter), new Map(), author)
}

function makeEntry<TDraft>(
  origin: HistoryOrigin,
  draft: TDraft,
  attribution: ReadonlyMap<string, ChangeAuthor>,
  keys: readonly string[],
  note: string,
  id: string,
  at: number,
  turnId?: string,
): HistoryEntry<TDraft> {
  return { id, origin, note: noteFor(keys, note), at, draft, attribution: new Map(attribution), keys: [...new Set(keys)], ...(turnId ? { turnId } : {}) }
}

function restoreKey<TDraft>(adapter: EditSessionAdapter<TDraft>, draft: TDraft, source: TDraft, key: string): TDraft {
  return adapter.restoreKeyFrom ? adapter.restoreKeyFrom(draft, source, key) : adapter.revert(draft, source, key)
}

function reducerResult<TDraft>(state: EditSessionState<TDraft>, undoTurnResult?: { reverted: number; skipped: number }): EditSessionReducerResult<TDraft> {
  return undoTurnResult ? { state, undoTurnResult } : { state }
}

export function editSessionReducer<TDraft>(
  state: EditSessionState<TDraft>,
  action: EditSessionAction<TDraft>,
): EditSessionReducerResult<TDraft> {
  switch (action.type) {
    case 'edit': {
      // Recipes run against the reducer's current draft so back-to-back edits never read a stale render.
      const draft = action.recipe(state.draft)
      if (Object.is(draft, state.draft)) return reducerResult(state)
      const coalesce = action.groupKey && state.openGroupKey === action.groupKey && state.cursor === state.entries.length - 1 && state.cursor >= 0
      const nextAttribution = attributionWith(action.keys, state.attribution, 'user')
      if (coalesce) {
        const entries = [...state.entries]
        const previous = entries[state.cursor]
        entries[state.cursor] = makeEntry('user', draft, nextAttribution, [...previous.keys, ...action.keys], previous.note, previous.id, previous.at)
        return reducerResult({ ...state, draft, attribution: nextAttribution, entries })
      }
      return reducerResult(appendEntry(
        state,
        makeEntry('user', draft, nextAttribution, action.keys, action.note, action.id, action.at),
        action.maxEntries,
        action.groupKey,
      ))
    }
    case 'endGroup':
      return reducerResult({ ...state, openGroupKey: undefined })
    case 'entry': {
      if (Object.is(action.draft, state.draft)) return reducerResult({ ...state, openGroupKey: undefined })
      const attribution = action.attribution ?? (action.origin === 'ai'
        ? attributionWith(action.keys, state.attribution, 'ai')
        : action.origin === 'user'
        ? attributionWith(action.keys, state.attribution, 'user')
        : state.attribution)
      return reducerResult(appendEntry(
        { ...state, openGroupKey: undefined },
        makeEntry(action.origin, action.draft, attribution, action.keys, action.note, action.id, action.at, action.turnId),
        action.maxEntries,
      ))
    }
    case 'loadVersion': {
      const keys = diffKeys(state.draft, action.draft, action.adapter)
      if (!keys.length) return reducerResult({ ...state, openGroupKey: undefined })
      return reducerResult(appendEntry(
        { ...state, openGroupKey: undefined },
        makeEntry('restore', action.draft, changedAttribution(state.baseline, action.draft, action.adapter, 'user'), keys, action.note, action.id, action.at),
        action.maxEntries,
      ))
    }
    case 'undo': {
      if (state.cursor < 0) return reducerResult(state)
      const cursor = state.cursor - 1
      return reducerResult({ ...state, cursor, draft: currentDraft(state, cursor), attribution: currentAttribution(state, cursor), openGroupKey: undefined })
    }
    case 'redo': {
      if (state.cursor >= state.entries.length - 1) return reducerResult(state)
      const cursor = state.cursor + 1
      return reducerResult({ ...state, cursor, draft: currentDraft(state, cursor), attribution: currentAttribution(state, cursor), openGroupKey: undefined })
    }
    case 'restoreTo': {
      const source = action.entryId === 'baseline' ? undefined : state.entries.find(entry => entry.id === action.entryId)
      if (action.entryId !== 'baseline' && !source) return reducerResult(state)
      const draft = source?.draft ?? state.baseline
      const attribution = source?.attribution ?? new Map<string, ChangeAuthor>()
      const keys = diffKeys(state.draft, draft, action.adapter)
      if (!keys.length) return reducerResult({ ...state, openGroupKey: undefined })
      return reducerResult(appendEntry(
        { ...state, openGroupKey: undefined },
        makeEntry('restore', draft, attribution, keys, source ? `Restored: ${source.note}` : 'Restored opened version', action.id, action.at),
        action.maxEntries,
      ))
    }
    case 'revert': {
      const draft = action.adapter.revert(state.draft, state.baseline, action.key)
      if (Object.is(draft, state.draft) || valueEquals(state.draft, draft, action.adapter, action.key)) return reducerResult({ ...state, openGroupKey: undefined })
      const attribution = new Map(state.attribution)
      attribution.delete(action.key)
      return reducerResult(appendEntry(
        { ...state, openGroupKey: undefined },
        makeEntry('user', draft, attribution, [action.key], 'Reverted to opened value', action.id, action.at),
        action.maxEntries,
      ))
    }
    case 'undoTurn': {
      const entryIndex = state.entries.findIndex(entry => entry.origin === 'ai' && entry.turnId === action.turnId)
      const entry = state.entries[entryIndex]
      if (!entry) return reducerResult(state, { reverted: 0, skipped: 0 })
      const beforeDraft = entryIndex > 0 ? state.entries[entryIndex - 1]!.draft : state.baseline
      const beforeAttribution = entryIndex > 0 ? state.entries[entryIndex - 1]!.attribution : new Map<string, ChangeAuthor>()
      let draft = state.draft
      const attribution = new Map(state.attribution)
      let reverted = 0
      let skipped = 0
      const revertedKeys: string[] = []
      for (const key of entry.keys) {
        if (!valueEquals(state.draft, entry.draft, action.adapter, key)) {
          skipped += 1
          continue
        }
        const nextDraft = restoreKey(action.adapter, draft, beforeDraft, key)
        if (!valueEquals(draft, nextDraft, action.adapter, key)) {
          draft = nextDraft
          reverted += 1
          revertedKeys.push(key)
          const beforeAuthor = beforeAttribution.get(key)
          if (beforeAuthor) attribution.set(key, beforeAuthor)
          else attribution.delete(key)
        }
      }
      if (!reverted) return reducerResult({ ...state, openGroupKey: undefined }, { reverted, skipped })
      const changes = diffDrafts(beforeDraft, entry.draft, action.adapter, entry.attribution).filter(change => revertedKeys.includes(change.key))
      const note = `Undid AI change: ${summarizeChanges(changes)}`
      return reducerResult(appendEntry(
        { ...state, openGroupKey: undefined },
        makeEntry('user', draft, attribution, revertedKeys, note, action.id, action.at),
        action.maxEntries,
      ), { reverted, skipped })
    }
    case 'reset':
      return reducerResult(createEditSessionState(action.baseline))
  }
}

function reduce<TDraft>(state: EditSessionState<TDraft>, action: EditSessionAction<TDraft>): EditSessionState<TDraft> {
  return editSessionReducer(state, action).state
}

function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

export function useEditSession<TDraft>({
  baseline,
  adapter,
  maxEntries = ASSIST_LIMITS.maxHistoryEntries,
  now = () => Date.now(),
  newId = () => crypto.randomUUID(),
}: {
  baseline: TDraft
  adapter: EditSessionAdapter<TDraft>
  maxEntries?: number
  now?: () => number
  newId?: () => string
}): EditSession<TDraft> {
  const [state, dispatch] = useReducer(reduce<TDraft>, baseline, createEditSessionState)
  const adapterRef = useLatest(adapter)
  const maxEntriesRef = useLatest(maxEntries)
  const nowRef = useLatest(now)
  const newIdRef = useLatest(newId)
  const lastUndoTurnResult = useRef({ reverted: 0, skipped: 0 })

  const actionBase = useCallback(() => ({
    id: newIdRef.current(),
    at: nowRef.current(),
    adapter: adapterRef.current,
    maxEntries: maxEntriesRef.current,
  }), [adapterRef, maxEntriesRef, newIdRef, nowRef])

  const edit = useCallback<EditSession<TDraft>['edit']>((recipe, options) => {
    dispatch({ type: 'edit', recipe, ...options, ...actionBase() })
  }, [actionBase])

  const endGroup = useCallback(() => dispatch({ type: 'endGroup' }), [])

  const applyAssist = useCallback<EditSession<TDraft>['applyAssist']>((next, options) => {
    dispatch({ type: 'entry', origin: 'ai', draft: next, ...options, ...actionBase() })
  }, [actionBase])

  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])
  const restoreTo = useCallback((entryId: string) => dispatch({ type: 'restoreTo', entryId, ...actionBase() }), [actionBase])
  const revert = useCallback((key: string) => dispatch({ type: 'revert', key, ...actionBase() }), [actionBase])
  const undoTurn = useCallback((turnId: string) => {
    const result = editSessionReducer(state, { type: 'undoTurn', turnId, ...actionBase() })
    lastUndoTurnResult.current = result.undoTurnResult ?? { reverted: 0, skipped: 0 }
    dispatch({ type: 'undoTurn', turnId, ...actionBase() })
    return lastUndoTurnResult.current
  }, [actionBase, state])
  const loadVersion = useCallback((next: TDraft, note: string) => {
    dispatch({ type: 'loadVersion', draft: next, note, ...actionBase() })
  }, [actionBase])
  const reset = useCallback((newBaseline: TDraft) => dispatch({ type: 'reset', baseline: newBaseline }), [])

  const changes = useMemo(() => diffDrafts(state.baseline, state.draft, adapter, state.attribution), [adapter, state.attribution, state.baseline, state.draft])
  const canUndo = state.cursor >= 0
  const canRedo = state.cursor < state.entries.length - 1
  const undoEntry = canUndo ? state.entries[state.cursor] : undefined
  const redoEntry = canRedo ? state.entries[state.cursor + 1] : undefined

  return {
    baseline: state.baseline,
    draft: state.draft,
    changes,
    dirty: changes.length > 0,
    aiChangeCount: countAiChanges(changes),
    entries: state.entries,
    cursor: state.cursor,
    canUndo,
    canRedo,
    undoLabel: undoEntry ? `Undo ${undoEntry.origin === 'ai' ? 'AI change' : undoEntry.origin === 'restore' ? 'restore' : 'change'}: ${undoEntry.note}` : 'Undo',
    redoLabel: redoEntry ? `Redo ${redoEntry.origin === 'ai' ? 'AI change' : redoEntry.origin === 'restore' ? 'restore' : 'change'}: ${redoEntry.note}` : 'Redo',
    evictedEntries: state.evictedEntries,
    highlight: useCallback((key: string) => highlightFor(key, state.baseline, state.draft, adapterRef.current, state.attribution), [adapterRef, state.attribution, state.baseline, state.draft]),
    previous: useCallback((key: string) => previousDisplay(key, state.baseline, state.draft, adapterRef.current), [adapterRef, state.baseline, state.draft]),
    edit,
    endGroup,
    applyAssist,
    undo,
    redo,
    restoreTo,
    revert,
    undoTurn,
    loadVersion,
    reset,
  }
}
