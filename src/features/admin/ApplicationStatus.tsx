import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAiTerminology, usePublicSettings } from '../../app/public-settings-context'
import { Button, InlineError } from '../../components/ui'
import { finishDeploymentUpdate, readPromptRelease, type PromptReleaseStatus } from '../../services/adminSettings'

export function ApplicationStatus() {
  const policy = usePublicSettings()
  const terms = useAiTerminology()
  const [release, setRelease] = useState<PromptReleaseStatus | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const live = useRef(true)
  const busy = useRef(false)
  useEffect(() => {
    live.current = true
    const controller = new AbortController()
    void readPromptRelease(controller.signal).then(value => {
      if (!controller.signal.aborted) setRelease(value)
    }, caught => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Update status could not be loaded. Try checking again.')
    }).finally(() => { if (!controller.signal.aborted) setPending(false) })
    return () => { live.current = false; controller.abort() }
  }, [])

  async function check(finish = false) {
    if (busy.current) return
    busy.current = true; setPending(true); setError(''); setMessage('')
    try {
      if (finish) {
        if (!release?.etag) throw new Error('Check update status before retrying.')
        const result = await finishDeploymentUpdate(release.etag)
        if (!live.current) return
        setRelease(result)
        setMessage(result.supported ? 'The update is complete. Your settings and approved QC guidance are unchanged.' : 'The update is not complete. Check the details below.')
      } else {
        const result = await readPromptRelease()
        if (!live.current) return
        setRelease(result); setMessage(result.supported ? 'Update status checked. AI instructions are up to date.' : 'Update status checked. The update still needs attention.')
      }
      await policy.refresh()
    } catch (caught) {
      if (live.current) setError(caught instanceof Error ? caught.message : 'The update could not be confirmed. Check status before retrying.')
    } finally { busy.current = false; if (live.current) setPending(false) }
  }

  return <section id="application-status" className="panel settings-section" aria-labelledby="application-status-heading" aria-busy={pending}>
    <h2 id="application-status-heading">Application status</h2>
    {pending && <p role="status">Checking the application update...</p>}
    {release && <><p><strong>{terms.text(release.supported && release.deploymentVerified !== false ? 'AI instructions are up to date' : 'AI processing is paused while an update finishes')}</strong></p>
      <p>{release.message ? terms.text(release.message) : release.message}</p>
      {release.pending && <p>You can still create workspaces and read saved work. Ordinary deployments need no approval here; evaluated changes are approved separately in Quality Control.</p>}
      <details><summary>Technical update details</summary><dl className="settings-facts">
        <dt>Installed generation</dt><dd><code>{release.generation}</code></dd>
        <dt>Active instructions</dt><dd><code>{release.activeBundleId ?? 'Not initialized'}</code></dd>
        <dt>Active SHA-256</dt><dd><code>{release.activeBundleSha256 ?? 'Not initialized'}</code></dd>
      </dl></details></>}
    {error && <InlineError>{error}</InlineError>}
    {policy.phase === 'error' && <InlineError>Score could not reload application settings. Saved work is unchanged. {policy.error}</InlineError>}
    {message && <p role="status">{terms.text(message)}</p>}
    <div className="flex flex-wrap gap-2">
      {release?.retryAllowed && release.etag && <Button variant="primary" disabled={pending} onClick={() => void check(true)}>Retry finishing update</Button>}
      <Button icon={RefreshCw} disabled={pending} onClick={() => void check()}>Check update status</Button>
    </div>
    {policy.settings?.maintenance.pauseNewWork && <p>New processing is also paused in Operations. Finishing the update will not change that setting.</p>}
    {policy.settings?.runtimeReadiness.reason === 'worker-verification-required' && policy.settings.runtimeReadiness.message && <p>{terms.text(policy.settings.runtimeReadiness.message)}</p>}
  </section>
}
