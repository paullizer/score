import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, EmptyState, InlineError } from '../../components/ui'
import { qcError, QcPrivacyContext, type useQcRequest } from './qc-ui'

export function QcPrivacyBoundary({ children, onAccessLost }: { children: ReactNode; onAccessLost?: () => Promise<void> }) {
  const [controller, setController] = useState(() => new AbortController())
  const [revoked, setRevoked] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const refresh = useRef(onAccessLost)
  refresh.current = onAccessLost
  const revoke = useCallback(() => { controller.abort(); setRevoked(true) }, [controller])
  useEffect(() => {
    if (controller.signal.aborted) setController(new AbortController())
    return () => controller.abort()
  }, [controller])
  useEffect(() => {
    if (!revoked) return
    let active = true
    void Promise.resolve().then(() => refresh.current?.()).catch(error => {
      if (active) setRefreshError(qcError(error))
    })
    return () => { active = false }
  }, [revoked])
  return revoked ? <><EmptyState title="QC access is no longer available"
    description="Private evidence, feedback, and unsaved fields have been cleared from this view. Return to your workspace and check your membership before reopening QC." />
    {refreshError && <InlineError>Workspace access could not be refreshed. Private QC data remains cleared. {refreshError}</InlineError>}</>
    : <QcPrivacyContext.Provider value={{ signal: controller.signal, revoke }}>{children}</QcPrivacyContext.Provider>
}

export function QcRequestError({ request }: { request: ReturnType<typeof useQcRequest> }) {
  if (!request.error) return null
  return <InlineError>{request.error}{request.unresolved && <div className="qc-stack">
    <p>The server may have accepted this action. Your fields are retained in this tab. Retrying sends the same payload, version, and request key; it does not deliberately create another job.</p>
    <Button disabled={request.pending} onClick={() => void request.retry()}>Retry unacknowledged request</Button>
  </div>}</InlineError>
}
