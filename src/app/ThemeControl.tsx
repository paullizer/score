import { useContext, useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { WorkspaceContext } from './workspace-context'
import { usePublicSettings } from './public-settings-context'
import { resolveTheme, type Theme } from './theme'

export function ThemeControl() {
  const workspace = useContext(WorkspaceContext)
  const { settings, hostTheme: applicationHostTheme } = usePublicSettings()
  const [saveError, setSaveError] = useState('')
  const [savedTheme, setTheme] = useState<Theme | null>(() => {
    try {
      const value = localStorage.getItem('score-theme')
      return value === 'dark' || value === 'light' || value === 'system' ? value : null
    } catch (error) {
      if (!(error instanceof DOMException)) throw error
      console.warn('The theme preference could not be loaded.', error)
      return null
    }
  })
  const host = new URLSearchParams(location.search).get('scoutTheme')
  const [initialHostTheme] = useState(() => host === 'dark' || host === 'light' ? host : null)
  const hostTheme = host === 'dark' || host === 'light' ? host : applicationHostTheme ?? initialHostTheme
  const theme = resolveTheme(savedTheme, settings?.appearance.defaultTheme, hostTheme)
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.setAttribute('data-theme', hostTheme ?? (theme === 'system' ? (media.matches ? 'dark' : 'light') : theme))
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme, hostTheme])
  function change(next: Theme) {
    setTheme(next)
    try { localStorage.setItem('score-theme', next); setSaveError('') } catch (error) {
      if (!(error instanceof DOMException)) throw error
      const message = 'Theme changed for this visit, but the preference could not be saved.'
      setSaveError(message)
      workspace?.notify(message)
    }
  }
  return <div className="theme-control" role="group" aria-label="Appearance">
    {([{ value: 'light', icon: Sun }, { value: 'dark', icon: Moon }, { value: 'system', icon: Monitor }] as const).map(({ value, icon: Icon }) =>
      <button key={value} type="button" aria-label={`Use ${value} theme`} title={hostTheme ? 'Theme is controlled by the host preview' : `${value[0].toUpperCase()}${value.slice(1)} theme`}
        aria-pressed={(hostTheme ?? theme) === value} disabled={Boolean(hostTheme)} onClick={() => change(value)}><Icon size={15} /></button>)}
    {saveError && <span className="sr-only" role="status">{saveError}</span>}
  </div>
}
