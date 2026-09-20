import { useState, type ReactNode } from 'react'
import { createLibraryViewStore, LibraryViewStateContext } from './library-view-state'

export function LibraryViewStateProvider({ scopeKey, children }: { scopeKey: string; children: ReactNode }) {
  return <ScopedLibraryViewState key={scopeKey}>{children}</ScopedLibraryViewState>
}

function ScopedLibraryViewState({ children }: { children: ReactNode }) {
  const [store] = useState(createLibraryViewStore)
  return <LibraryViewStateContext.Provider value={store}>{children}</LibraryViewStateContext.Provider>
}
