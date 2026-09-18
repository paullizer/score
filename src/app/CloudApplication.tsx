import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BrowserRouter, useLocation } from 'react-router-dom'
import { AlertTriangle, Layers3, LogIn, ShieldCheck } from 'lucide-react'
import { CloudWorkspaceProvider, type CloudWorkspaceProviderApi } from './CloudWorkspaceProvider'
import { App } from './App'
import { RealJobsBridge } from './RealJobsBridge'
import { RealGradeLaddersBridge } from './RealGradeLaddersBridge'
import { RealResumesBridge } from './RealResumesBridge'
import { RealAnalysesBridge } from './RealAnalysesBridge'
import { GradeNavigationProtectionProvider, GradeRouterProtection } from './GradeNavigationProtection'
import type { GradeLeaveProtectionApi } from './grade-navigation-context'
import {
  authLoginUrl, authLogoutUrl, CloudApiError, CloudAuthError, CloudConflictError,
  createWorkspace as createWorkspaceApi, fetchSession, listWorkspaces as listWorkspacesApi,
  readLastWorkspaceId, renameWorkspace as renameWorkspaceApi, safeSameOriginPath,
  validateWorkspaceName, writeLastWorkspaceId,
} from '../services/cloudWorkspace'
import type { CloudSession } from '../domain/cloud'
import { Button } from '../components/ui'

type Result = { ok: true } | { ok: false; message: string }

type Phase =
  | { kind: 'loading' }
  | { kind: 'sign-in'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'workspace-unavailable'; requestedId: string }
  | { kind: 'ready'; workspaceId: string }

const WORKSPACE_PATH = /^\/workspaces\/([^/]+)(?:\/|$)/

function resolveRequestedWorkspaceId(): string | null {
  const match = WORKSPACE_PATH.exec(window.location.pathname)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch (error) {
    if (!(error instanceof URIError)) throw error
    return match[1]
  }
}

/**
 * Top-level cloud-mode gate, mounted instead of a plain BrowserRouter (see src/main.tsx). It owns:
 *  - authenticating the session (GET /api/session) and showing an explicit sign-in/unavailable view
 *    on failure \u2014 never a silent fallback to fixtures,
 *  - resolving `/workspaces/:workspaceId/...` from the URL (or redirecting a bare cloud visit to the
 *    user's last-used, or first, personal workspace),
 *  - the actual BrowserRouter + CloudWorkspaceProvider, both remounted (via `key={workspaceId}`)
 *    whenever the active workspace changes so no stale controller/request can write into the wrong
 *    workspace,
 *  - workspace list/create/rename/switch and the flush-then-redirect sign-out flow.
 */
export function CloudApplication() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [session, setSession] = useState<CloudSession | null>(null)
  const providerApiRef = useRef<CloudWorkspaceProviderApi | null>(null)
  const gradeLeaveRef = useRef<GradeLeaveProtectionApi | null>(null)
  const aliveRef = useRef(true)
  const lastPathRef = useRef(window.location.pathname + window.location.search + window.location.hash)
  const lastHistoryStateRef = useRef<unknown>(window.history.state)

  useEffect(() => {
    aliveRef.current = true
    const controller = new AbortController()
    fetchSession(controller.signal).then((value) => {
      if (!aliveRef.current || controller.signal.aborted) return
      setSession(value)
      const requested = resolveRequestedWorkspaceId()
      if (requested !== null) {
        if (!value.workspaces.some((item) => item.id === requested)) {
          setPhase({ kind: 'workspace-unavailable', requestedId: requested })
          return
        }
        writeLastWorkspaceId(value.user.tenantId, value.user.id, requested)
        setPhase({ kind: 'ready', workspaceId: requested })
        return
      }
      const remembered = readLastWorkspaceId(value.user.tenantId, value.user.id)
      const target = (remembered && value.workspaces.some((item) => item.id === remembered)) ? remembered : value.workspaces[0]?.id
      if (!target) { setPhase({ kind: 'unavailable', message: 'No workspace is available for your account yet. Try signing in again shortly.' }); return }
      window.history.replaceState(null, '', `/workspaces/${encodeURIComponent(target)}/jobs`)
      writeLastWorkspaceId(value.user.tenantId, value.user.id, target)
      setPhase({ kind: 'ready', workspaceId: target })
    }).catch((error: unknown) => {
      if (!aliveRef.current || controller.signal.aborted) return
      if (error instanceof CloudAuthError || (error instanceof CloudApiError && error.status === 403)) { setPhase({ kind: 'sign-in', message: error.message }); return }
      const message = error instanceof CloudApiError ? error.message : "Score's cloud service is unavailable right now. Check your connection and try again."
      setPhase({ kind: 'unavailable', message })
    })
    return () => { aliveRef.current = false; controller.abort() }
  }, [])

  async function switchWorkspace(id: string, availableSession = session, alreadyPrepared = false): Promise<Result> {
    if (!availableSession) return { ok: false, message: 'Your session is still loading. Try again in a moment.' }
    if (!availableSession.workspaces.some((item) => item.id === id)) return { ok: false, message: 'That workspace is not available to your account.' }
    if (phase.kind === 'ready' && phase.workspaceId === id) return { ok: true }
    const flushed = alreadyPrepared ? { ok: true as const } : await providerApiRef.current?.prepareToLeave() ?? { ok: true as const }
    if (!flushed.ok) return flushed
    writeLastWorkspaceId(availableSession.user.tenantId, availableSession.user.id, id)
    window.history.pushState(null, '', `/workspaces/${encodeURIComponent(id)}/jobs`)
    setPhase({ kind: 'ready', workspaceId: id })
    return { ok: true }
  }

  // Intercept cross-workspace history before BrowserRouter unmounts its old basename/provider.
  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      if (!session) return
      const requested = resolveRequestedWorkspaceId()
      if (phase.kind === 'ready' && phase.workspaceId === requested) return
      event.stopImmediatePropagation()
      const incoming = window.location.pathname + window.location.search + window.location.hash
      const outgoing = lastPathRef.current
      const outgoingState = lastHistoryStateRef.current
      void (providerApiRef.current?.prepareToLeave() ?? Promise.resolve({ ok: true as const })).then((result) => {
        if (!aliveRef.current) return
        if (!result.ok) {
          window.history.pushState(outgoingState, '', outgoing)
          window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
          return
        }
        if (requested === null) {
          window.location.assign('/')
          return
        }
        if (!session.workspaces.some((item) => item.id === requested)) {
          setPhase({ kind: 'workspace-unavailable', requestedId: requested })
          return
        }
        window.history.replaceState(event.state, '', incoming)
        writeLastWorkspaceId(session.user.tenantId, session.user.id, requested)
        setPhase({ kind: 'ready', workspaceId: requested })
      })
    }
    window.addEventListener('popstate', onPopState, { capture: true })
    return () => window.removeEventListener('popstate', onPopState, { capture: true })
  }, [session, phase])

  async function createWorkspace(name: string): Promise<Result> {
    if (!session) return { ok: false, message: 'Your session is still loading. Try again in a moment.' }
    const invalid = validateWorkspaceName(name)
    if (invalid) return { ok: false, message: invalid }
    const flushed = await providerApiRef.current?.prepareToLeave() ?? { ok: true as const }
    if (!flushed.ok) return flushed
    try {
      const created = await createWorkspaceApi(name.trim())
      const updatedSession = { ...session, workspaces: [...session.workspaces, created] }
      setSession(updatedSession)
      const switched = await switchWorkspace(created.id, updatedSession, true)
      return switched.ok ? switched : { ok: false, message: `The workspace was created, but switching was stopped: ${switched.message}` }
    } catch (error) {
      if (error instanceof CloudAuthError) { setPhase({ kind: 'sign-in', message: error.message }); return { ok: false, message: error.message } }
      const message = error instanceof CloudApiError ? error.message : 'Score could not create a new workspace. Try again.'
      return { ok: false, message }
    }
  }

  async function renameWorkspace(id: string, name: string): Promise<Result> {
    if (!session) return { ok: false, message: 'Your session is still loading. Try again in a moment.' }
    const invalid = validateWorkspaceName(name)
    if (invalid) return { ok: false, message: invalid }
    const existing = session.workspaces.find((item) => item.id === id)
    if (!existing) return { ok: false, message: 'That workspace is not available to your account.' }
    try {
      const updated = await renameWorkspaceApi(id, name.trim(), existing.etag)
      setSession((value) => value ? { ...value, workspaces: value.workspaces.map((item) => item.id === id ? updated : item) } : value)
      return { ok: true }
    } catch (error) {
      if (error instanceof CloudAuthError) { setPhase({ kind: 'sign-in', message: error.message }); return { ok: false, message: error.message } }
      if (error instanceof CloudConflictError) {
        try {
          const fresh = await listWorkspacesApi()
          setSession((value) => value ? { ...value, workspaces: fresh } : value)
        } catch (refreshError) {
          const message = refreshError instanceof CloudApiError ? refreshError.message : 'The current workspace list could not be loaded.'
          return { ok: false, message: `The name changed in another session, and refreshing the list failed: ${message}` }
        }
        return { ok: false, message: 'This workspace was renamed elsewhere. Its latest name is now shown \u2014 try again if you still want to change it.' }
      }
      const message = error instanceof CloudApiError ? error.message : 'Score could not rename this workspace. Try again.'
      return { ok: false, message }
    }
  }

  function onAuthError(message: string) {
    setPhase({ kind: 'sign-in', message })
  }

  function onSignedOut() {
    gradeLeaveRef.current?.releaseForLeave()
    window.location.assign(authLogoutUrl('/'))
  }

  if (phase.kind === 'loading') return <CloudGateShell><p>Connecting to Score in the cloud…</p></CloudGateShell>

  if (phase.kind === 'sign-in') return <CloudGateShell>
    <ShieldCheck size={30} className="mb-1" />
    <h1>Sign in to Score</h1>
    <p>{phase.message}</p>
    <Button variant="primary" icon={LogIn} onClick={() => window.location.assign(authLoginUrl(safeSameOriginPath(window.location.pathname + window.location.search)))}>
      Sign in with Microsoft Entra ID
    </Button>
  </CloudGateShell>

  if (phase.kind === 'unavailable') return <CloudGateShell tone="error">
    <AlertTriangle size={30} className="mb-1" />
    <h1>Score's cloud service is unavailable</h1>
    <p>{phase.message}</p>
    <Button variant="primary" onClick={() => window.location.reload()}>Try again</Button>
  </CloudGateShell>

  if (phase.kind === 'workspace-unavailable') return <CloudGateShell tone="error">
    <AlertTriangle size={30} className="mb-1" />
    <h1>This workspace is unavailable</h1>
    <p>The workspace in this link doesn't exist, or your account no longer has access to it. Nothing was changed.</p>
    <Button variant="primary" onClick={() => { window.history.replaceState(null, '', '/'); window.location.reload() }}>Go to my workspaces</Button>
  </CloudGateShell>

  const workspaceId = phase.workspaceId
  const activeSession = session
  if (!activeSession) throw new Error('The cloud session is missing after initialization.')
  // Keep pending saves above the router when browser history temporarily crosses its basename.
  return <GradeNavigationProtectionProvider key={workspaceId} workspaceId={workspaceId} apiRef={gradeLeaveRef}><CloudWorkspaceProvider
        key={workspaceId}
        workspaceId={workspaceId}
        user={activeSession.user}
        workspaces={activeSession.workspaces}
        apiRef={providerApiRef}
        leaveProtectionRef={gradeLeaveRef}
        onAuthError={onAuthError}
        switchWorkspace={switchWorkspace}
        createWorkspace={createWorkspace}
        renameWorkspace={renameWorkspace}
        onSignedOut={onSignedOut}
      >
    {(legacyValue, cloud) => <BrowserRouter key={workspaceId} basename={`/workspaces/${encodeURIComponent(workspaceId)}`}>
      <GradeRouterProtection><RealJobsBridge workspaceId={workspaceId} legacyValue={legacyValue} cloud={cloud}><RealGradeLaddersBridge workspaceId={workspaceId}><RealResumesBridge workspaceId={workspaceId}><RealAnalysesBridge workspaceId={workspaceId}>
        <TrackCloudPath pathRef={lastPathRef} stateRef={lastHistoryStateRef} basename={`/workspaces/${encodeURIComponent(workspaceId)}`} />
        <App />
      </RealAnalysesBridge></RealResumesBridge></RealGradeLaddersBridge></RealJobsBridge></GradeRouterProtection>
    </BrowserRouter>}
  </CloudWorkspaceProvider></GradeNavigationProtectionProvider>
}

function TrackCloudPath({ pathRef, stateRef, basename }: { pathRef: { current: string }; stateRef: { current: unknown }; basename: string }) {
  const location = useLocation()
  useEffect(() => {
    pathRef.current = basename + location.pathname + location.search + location.hash
    stateRef.current = window.history.state
  }, [location, basename, pathRef, stateRef])
  return null
}

function CloudGateShell({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'error' }) {
  return <main className="recovery-page">
    <div className={`panel recovery-card cloud-gate-card ${tone === 'error' ? 'is-error' : ''}`}>
      <span className="cloud-gate-brand"><Layers3 size={20} strokeWidth={2} /> score<span className="brand-period">.</span></span>
      {children}
    </div>
  </main>
}
