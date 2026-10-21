import { useEffect, useRef, useState } from 'react'
import { LogIn, ShieldCheck } from 'lucide-react'
import { Button, InlineError, Modal } from '../components/ui'
import { createSessionRecoveryAttempt, notifySessionRecoveryComplete, sessionRecoveryAttemptId } from '../services/sessionRecovery'

export function SessionRecovery({ message, verify, leave }: { message: string; verify: () => Promise<void>; leave: () => Promise<void> }) {
  const attempt = useRef<ReturnType<typeof createSessionRecoveryAttempt> | null>(null)
  const alive = useRef(true)
  const checking = useRef(false)
  const [waiting, setWaiting] = useState(false)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; attempt.current?.dispose(); attempt.current = null }
  }, [])

  async function checkAccess() {
    if (checking.current) return
    checking.current = true
    setBusy(true); setError('')
    try { await verify() } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : 'Current access could not be checked. Keep this tab open and try again.')
    } finally {
      checking.current = false
      if (alive.current) setBusy(false)
    }
  }

  function startSignIn() {
    if (attempt.current || checking.current) return
    setError('')
    try {
      const current = createSessionRecoveryAttempt(() => {
        attempt.current = null
        setWaiting(false)
        setNotice('Sign-in returned. Checking your original account and current access...')
        void checkAccess()
      }, () => {
        attempt.current = null
        setWaiting(false)
        setNotice('Sign-in has not been confirmed. Check access if you finished signing in, or start sign-in again. Your drafts remain in this tab.')
      })
      attempt.current = current
      setLoginUrl(current.loginUrl)
      setWaiting(true)
      setNotice(current.open()
        ? 'Finish Microsoft sign-in in the separate window, then return here. If you closed it, stop waiting to start again.'
        : 'Your browser blocked the sign-in window. Open the sign-in link below, then return here and check access.')
      if (current.notificationError) setError(`Automatic sign-in notification is unavailable: ${current.notificationError}. After signing in, return here and choose Check access.`)
    } catch (caught) {
      attempt.current?.dispose(); attempt.current = null
      setWaiting(false)
      setError(caught instanceof Error ? caught.message : 'The sign-in window could not be opened. Keep this tab open and try again.')
    }
  }

  return <main className="recovery-page"><div className="panel recovery-card">
    <ShieldCheck size={30} aria-hidden="true" /><h1>Sign in again to restore access</h1>
    <p>{message}</p>
    <p>Workspace content and changes are paused until your account and permissions can be checked. This does not mean your workspace membership was removed.</p>
    <p>Keep this tab open. Unsaved drafts remain in memory here and will not be uploaded automatically. Sign in with the same Microsoft account in the separate window.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <InlineError>{error}</InlineError>}
    <div className="flex flex-wrap gap-3">
      <Button variant="primary" icon={LogIn} disabled={waiting || busy} onClick={startSignIn}>Refresh access</Button>
      <Button disabled={busy} onClick={() => void checkAccess()}>{busy ? 'Checking access...' : 'Check access'}</Button>
      {waiting && <Button disabled={busy} onClick={() => {
        attempt.current?.dispose(); attempt.current = null
        setWaiting(false); setLoginUrl(null)
        setNotice('Stopped waiting for sign-in. Your drafts are still here. You can start sign-in again when ready.')
      }}>Stop waiting</Button>}
      {waiting && loginUrl && <a className="button button-secondary button-md" href={loginUrl} target="_blank" rel="noopener noreferrer">Open sign-in link</a>}
      <Button disabled={busy} onClick={() => setConfirmLeave(true)}>Discard drafts and leave</Button>
    </div>
    <Modal open={confirmLeave} onOpenChange={setConfirmLeave} dismissDisabled={busy} title="Discard unsaved drafts and reload?"
      description="This leaves the original session and discards drafts held only in this tab. Already accepted server work is unchanged. Existing draft protection may ask for confirmation too."
      footer={<><Button disabled={busy} onClick={() => setConfirmLeave(false)}>Keep this tab</Button><Button variant="danger" disabled={busy} onClick={() => {
        setBusy(true); setError('')
        void leave().catch(caught => {
          if (alive.current) { setConfirmLeave(false); setError(caught instanceof Error ? caught.message : 'Leaving could not be completed. Your drafts are still here.') }
        }).finally(() => { if (alive.current) setBusy(false) })
      }}>Discard drafts and reload</Button></>}>
      <p>Score will reopen My workspaces and check the account currently signed in. No drafts will be uploaded.</p>
    </Modal>
  </div></main>
}

export function SessionRecoveryComplete() {
  const [error, setError] = useState('')
  useEffect(() => {
    const id = sessionRecoveryAttemptId(new URL(window.location.href))
    if (!id) { setError('This sign-in recovery link is invalid or incomplete. Return to your original Score tab and start sign-in again.'); return }
    try { notifySessionRecoveryComplete(id) } catch (caught) {
      setError(caught instanceof Error ? `Score could not notify the original tab: ${caught.message}` : 'Score could not notify the original tab.')
    }
  }, [])
  return <main className="recovery-page"><div className="panel recovery-card">
    <ShieldCheck size={30} aria-hidden="true" /><h1>Return to your original Score tab</h1>
    <p>Microsoft sign-in returned to Score. Your original tab will check that the same account still has access before restoring your work.</p>
    <p>If it has not updated, choose Check access there. You can close this sign-in window; keep the original tab open to retain unsaved drafts.</p>
    {error && <InlineError>{error}</InlineError>}
    <Button onClick={() => window.close()}>Close sign-in window</Button>
  </div></main>
}
