import { createContext, useCallback, useContext, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'

interface LibraryViewStore {
  values: Map<string, unknown>
  subscribe: (listener: () => void) => () => void
  set: (key: string, value: unknown) => void
}

export function createLibraryViewStore(): LibraryViewStore {
  const values = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  return {
    values,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (key, value) => {
      if (values.has(key) && Object.is(values.get(key), value)) return
      values.set(key, value)
      listeners.forEach((listener) => listener())
    },
  }
}

export const LibraryViewStateContext = createContext<LibraryViewStore | null>(null)
const subscribeNothing = () => () => {}

/**
 * Tab-only search/filter/sort state. Keys name the library and control, e.g. jobs:query.
 * Source records and selected IDs belong in their existing providers or component state.
 */
export function useLibraryViewState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(LibraryViewStateContext)
  const [localValue, setLocalValue] = useState(initial)
  const getSnapshot = useCallback(() => store?.values.has(key) ? store.values.get(key) as T : localValue, [key, localValue, store])
  const value = useSyncExternalStore(store?.subscribe ?? subscribeNothing, getSnapshot, getSnapshot)
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    if (!store) { setLocalValue(next); return }
    store.set(key, typeof next === 'function' ? (next as (previous: T) => T)(getSnapshot()) : next)
  }, [getSnapshot, key, store])
  return [value, setValue]
}
