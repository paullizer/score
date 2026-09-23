import { useState } from 'react'

export const SIDEBAR_COLLAPSED_KEY = 'score-sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch (error) {
    if (!(error instanceof DOMException)) throw error
    console.warn('The navigation preference could not be loaded.', error)
    return false
  }
}

// Read synchronously on first render so a collapsed rail never flashes open.
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  function toggle() {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next)) } catch (error) {
      if (!(error instanceof DOMException)) throw error
      console.warn('The navigation preference applies to this visit only; it could not be saved.', error)
    }
  }
  return [collapsed, toggle] as const
}
