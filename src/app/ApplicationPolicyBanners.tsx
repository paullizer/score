import { Button } from '../components/ui'
import { usePublicSettings } from './public-settings-context'

export function ApplicationPolicyBanners() {
  const policy = usePublicSettings()
  return <>
    {policy.settings?.appearance.announcement.enabled && <aside className={`application-announcement ${policy.settings.appearance.announcement.tone === 'warning' ? 'is-warning' : ''}`} role="status">{policy.settings.appearance.announcement.text}</aside>}
    {policy.settings?.maintenance.pauseNewWork && <aside className="application-announcement is-warning" role="status">New work is paused. {policy.settings.maintenance.explanation} Saved records remain available.</aside>}
    {policy.phase === 'error' && <div className="storage-banner" role="alert"><span>Current application policy could not be checked. New actions are disabled; saved evidence is unchanged.</span><Button size="sm" onClick={() => void policy.refresh()}>Refresh application policy</Button></div>}
  </>
}
