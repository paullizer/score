import { useState } from 'react'
import { Button } from '../components/ui'
import { useAiTerminology, usePublicSettings } from './public-settings-context'

export function ApplicationPolicyBanners({ onOpenSettings }: { onOpenSettings?: () => Promise<void> }) {
  const policy = usePublicSettings()
  const terms = useAiTerminology()
  const [navigationError, setNavigationError] = useState('')
  const readiness = policy.settings?.runtimeReadiness
  return <>
    {policy.settings?.appearance.announcement.enabled && <aside className={`application-announcement ${policy.settings.appearance.announcement.tone === 'warning' ? 'is-warning' : ''}`} role="status">{policy.settings.appearance.announcement.text}</aside>}
    {policy.settings?.maintenance.pauseNewWork && <aside className="application-announcement is-warning" role="status">New work is paused. {policy.settings.maintenance.explanation} Saved records remain available.</aside>}
    {policy.phase === 'error' && <div className="storage-banner" role="alert"><span>Score couldn't load application settings. New actions are unavailable; your saved work is unchanged.
      {policy.error && <span className="block">{policy.error}</span>}</span>
      <Button size="sm" disabled={policy.refreshing} onClick={() => void policy.refresh()}>{policy.refreshing ? 'Checking settings...' : 'Check settings again'}</Button></div>}
    {policy.phase === 'ready' && readiness?.newProcessingAllowed === false && <div className="storage-banner" role="status">
      <span>{readiness.message ? terms.text(readiness.message) : readiness.message}</span>
      {onOpenSettings && <Button size="sm" onClick={() => { setNavigationError(''); void onOpenSettings().catch(caught => {
        setNavigationError(caught instanceof Error ? caught.message : 'Application settings could not be opened.')
      }) }}>View update details</Button>}
      <Button size="sm" disabled={policy.refreshing} onClick={() => void policy.refresh()}>{policy.refreshing ? 'Checking update...' : 'Check update status'}</Button>
    </div>}
    {navigationError && <div className="storage-banner" role="alert">{navigationError}</div>}
  </>
}
