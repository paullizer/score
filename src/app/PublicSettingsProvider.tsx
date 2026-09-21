import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { fetchPublicFeatures } from '../services/publicSettings'
import { PublicSettingsContext, type PublicSettingsContextValue } from './public-settings-context'

export function PublicSettingsProvider({ children }: { children: ReactNode }) {
  const [hostTheme] = useState<'light' | 'dark' | null>(() => {
    const value = new URLSearchParams(window.location.search).get('scoutTheme')
    return value === 'light' || value === 'dark' ? value : null
  })
  const [state, setState] = useState<Omit<PublicSettingsContextValue, 'refresh' | 'cloud'>>({ settings: null, phase: 'loading', error: null })
  const controller = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    try {
      const response = await fetchPublicFeatures(current.signal)
      if (current.signal.aborted) return
      if (!response.publicSettings) throw new Error('The cloud service did not provide effective application policy. New actions are unavailable until policy can be refreshed.')
      setState({ settings: response.publicSettings, phase: 'ready', error: null })
    } catch (caught) {
      if (current.signal.aborted) return
      setState(previous => ({ ...previous, phase: 'error', error: caught instanceof Error ? caught.message : 'Current application policy could not be checked. New actions are disabled until it is refreshed.' }))
    }
  }, [])
  useEffect(() => {
    void refresh()
    const focus = () => { void refresh() }
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visible)
    return () => {
      controller.current?.abort()
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])
  useEffect(() => { document.title = state.settings?.appearance.applicationTitle ?? 'Score' }, [state.settings?.appearance.applicationTitle])
  return <PublicSettingsContext.Provider value={{ ...state, hostTheme, cloud: true, refresh }}>{children}</PublicSettingsContext.Provider>
}
