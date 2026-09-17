import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useWorkspace } from './workspace-context'

type Theme = 'light' | 'dark' | 'system'

export function ThemeControl() {
  const { notify } = useWorkspace()
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const value = localStorage.getItem('score-theme')
      return value === 'dark' || value === 'light' ? value : 'system'
    } catch (error) {
      if (!(error instanceof DOMException)) throw error
      console.warn('The theme preference could not be loaded.', error)
      return 'system'
    }
  })
  const host = new URLSearchParams(location.search).get('scoutTheme')
  const hostTheme = host === 'dark' || host === 'light' ? host : null
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.setAttribute('data-theme', hostTheme ?? (theme === 'system' ? (media.matches ? 'dark' : 'light') : theme))
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme, hostTheme])
  function change(next: Theme) {
    setTheme(next)
    try { localStorage.setItem('score-theme', next) } catch (error) {
      if (!(error instanceof DOMException)) throw error
      notify('Theme changed for this visit, but the preference could not be saved.')
    }
  }
  return <div className="theme-control" role="group" aria-label="Appearance">
    {([{ value: 'light', icon: Sun }, { value: 'dark', icon: Moon }, { value: 'system', icon: Monitor }] as const).map(({ value, icon: Icon }) =>
      <button key={value} type="button" aria-label={`Use ${value} theme`} title={hostTheme ? 'Theme is controlled by the host preview' : `${value[0].toUpperCase()}${value.slice(1)} theme`}
        aria-pressed={(hostTheme ?? theme) === value} disabled={Boolean(hostTheme)} onClick={() => change(value)}><Icon size={15} /></button>)}
  </div>
}
