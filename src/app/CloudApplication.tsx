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
import { LibraryViewStateProvider } from './LibraryViewStateProvider'
import {
  authLoginUrl, authLogoutUrl, CloudApiError, CloudAuthError, CloudConflictError,
  createWorkspace as createWorkspaceApi, fetchSession, listWorkspaces as listWorkspacesApi,
  readLastWorkspaceId, renameWorkspace as renameWorkspaceApi, safeSameOriginPath,
  validateWorkspaceName, writeLastWorkspaceId,
  clearLastWorkspaceId, getWorkspaceLifecycleImpact as getWorkspaceLifecycleImpactApi, changeWorkspaceLifecycle as changeWorkspaceLifecycleApi, LifecycleOperationError,
} from '../services/cloudWorkspace'
import type { CloudSession, WorkspaceSummary } from '../domain/cloud'
import type { LifecycleAction } from '../domain/lifecycle'
import { Button } from '../components/ui'
import { WorkspaceSwitcher } from '../components/workspace/WorkspaceSwitcher'
import { LifecycleDialogProvider } from '../components/lifecycle/LifecycleControls'

type Result = { ok: true } | { ok: false; message: string }

type Phase =
  | { kind: 'loading' }
  | { kind: 'sign-in'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'workspace-unavailable'; requestedId: string }
  | { kind: 'empty' }
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
  const sessionRef = useRef(session)
  sessionRef.current = session
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const metadataSequence = useRef(0)
  const lifecyclePending = useRef(false)
  const lastHistoryStateRef = useRef<unknown>(window.history.state)

  useEffect(() => {
    aliveRef.current = true
    const controller = new AbortController()
    fetchSession(controller.signal).then((value) => {
      if (!aliveRef.current || controller.signal.aborted) return
      setSession(value)
      const requested = resolveRequestedWorkspaceId()
      if (requested !== null) {
        if (!value.workspaces.some((item) => item.id === requested && !item.deletedAt)) {
          setPhase({ kind: 'workspace-unavailable', requestedId: requested })
          return
        }
        writeLastWorkspaceId(value.user.tenantId, value.user.id, requested)
        setPhase({ kind: 'ready', workspaceId: requested })
        return
      }
      const remembered = readLastWorkspaceId(value.user.tenantId, value.user.id)
      const active = value.workspaces.filter(isActiveWorkspace)
      const target = (remembered && active.some((item) => item.id === remembered)) ? remembered : active[0]?.id
      if (!target) { clearLastWorkspaceId(value.user.tenantId, value.user.id); setPhase({ kind: 'empty' }); return }
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
    if (!availableSession.workspaces.some((item) => item.id === id && !item.deletedAt)) return { ok: false, message: 'That workspace is not available to your account.' }
    if (phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === id) return { ok: true }
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
        if (!session.workspaces.some((item) => item.id === requested && !item.deletedAt)) {
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

  async function refreshWorkspaces() {
    const sequence = ++metadataSequence.current
    const items = await listWorkspacesApi()
    if (!aliveRef.current || sequence !== metadataSequence.current) return
    const currentSession = sessionRef.current
    if (!currentSession) return
    const currentId = phaseRef.current.kind === 'ready' ? phaseRef.current.workspaceId : undefined
    const removed = currentId && !items.some((item) => item.id === currentId && !item.deletedAt)
    if (removed && !lifecyclePending.current && (providerApiRef.current?.hasPendingChanges() || (gradeLeaveRef.current && !await gradeLeaveRef.current.confirmLeave()))) {
      const previous = currentSession.workspaces.find((item) => item.id === currentId)
      if (previous) items.push({ ...previous, deletedAt: new Date().toISOString() })
    } else if (removed && !lifecyclePending.current) {
      clearLastWorkspaceId(currentSession.user.tenantId, currentSession.user.id)
      setPhase({ kind: 'workspace-unavailable', requestedId: currentId })
    }
    const next = { ...currentSession, workspaces: items }
    sessionRef.current = next
    setSession(next)
  }

  useEffect(() => {
    const refresh = () => { if (sessionRef.current) void refreshWorkspaces().catch(() => undefined) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  async function changeWorkspaceLifecycle(id: string, action: LifecycleAction) {
    if (lifecyclePending.current) throw new Error('Wait for the current workspace lifecycle request.')
    const currentSession = sessionRef.current
    const existing = currentSession?.workspaces.find((item) => item.id === id)
    if (!currentSession || !existing || existing.deletedAt) throw new Error('This workspace is no longer available.')
    if (existing.role !== 'owner') throw new Error('Only the workspace owner can archive, unarchive, or delete a workspace.')
    const currentTarget = phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === id
    const prepared = await (currentTarget ? providerApiRef.current?.prepareToLeave() : providerApiRef.current?.flush()) ?? { ok: true as const }
    if (!prepared.ok) throw new Error(prepared.message)
    lifecyclePending.current = true
    ++metadataSequence.current
    try {
      const result = await changeWorkspaceLifecycleApi(id, action, existing.etag)
      if (!aliveRef.current) return
      ++metadataSequence.current
      const updated = result.workspace
      const operation = result.operation ?? updated?.lifecycleOperation
      const next = {
        ...sessionRef.current!,
        workspaces: result.deleted
          ? sessionRef.current!.workspaces.filter((item) => item.id !== id)
          : sessionRef.current!.workspaces.map((item) => item.id === id ? updated ?? { ...item, ...(operation ? { lifecycleOperation: operation } : {}) } : item),
      }
      sessionRef.current = next; setSession(next)
      if (operation && operation.status !== 'complete') throw new LifecycleOperationError(operation)
      if (!result.deleted && !updated) throw new Error('The service did not acknowledge a completed workspace change. Refresh status before retrying.')
      if (phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === id && action === 'unarchive') {
        const refreshed = await providerApiRef.current?.refreshState()
        if (refreshed && !refreshed.ok) throw new Error(`Unarchive completed, but refreshing the saved content failed: ${refreshed.message}`)
      }
      if (phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === id && action !== 'unarchive') {
        clearLastWorkspaceId(currentSession.user.tenantId, currentSession.user.id)
        const fallback = next.workspaces.find(isActiveWorkspace)
        if (fallback) {
          const switched = await switchWorkspace(fallback.id, next, true)
          if (!switched.ok) throw new Error(switched.message)
        } else {
          window.history.replaceState(null, '', '/')
          lastPathRef.current = '/'
          setPhase({ kind: 'empty' })
        }
      }
    } catch (error) {
      try { await refreshWorkspaces() } catch (refreshError) {
        console.error('Workspace lifecycle status refresh failed:', refreshError instanceof Error ? refreshError.message : refreshError)
      }
      throw error
    } finally { lifecyclePending.current = false }
  }

  async function getWorkspaceLifecycleImpact(id: string) {
    const impact = await getWorkspaceLifecycleImpactApi(id)
    return { ...impact, blockers: impact.blockers.map((blocker) => ({
      ...blocker, href: blocker.href.startsWith('/workspaces/') ? blocker.href : `/workspaces/${encodeURIComponent(id)}${blocker.href}`,
    })) }
  }

  async function leaveUnavailableWorkspace(): Promise<Result> {
    if (gradeLeaveRef.current && !await gradeLeaveRef.current.confirmLeave()) return { ok: false, message: 'Leaving was stopped to preserve unsaved changes or a pending request.' }
    await providerApiRef.current?.discardPendingChanges()
    if (sessionRef.current) clearLastWorkspaceId(sessionRef.current.user.tenantId, sessionRef.current.user.id)
    window.history.replaceState(null, '', '/')
    lastPathRef.current = '/'
    setPhase({ kind: 'empty' })
    return { ok: true }
  }

  async function createWorkspace(name: string): Promise<Result> {
    if (!session) return { ok: false, message: 'Your session is still loading. Try again in a moment.' }
    const invalid = validateWorkspaceName(name)
    if (invalid) return { ok: false, message: invalid }
    const flushed = await providerApiRef.current?.prepareToLeave() ?? { ok: true as const }
    if (!flushed.ok) return flushed
    try {
      const created = await createWorkspaceApi(name.trim())
      ++metadataSequence.current
      const latest = sessionRef.current ?? session
      const updatedSession = { ...latest, workspaces: [...latest.workspaces.filter((item) => item.id !== created.id), created] }
      sessionRef.current = updatedSession
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
    if (existing.role !== 'owner' || existing.archivedAt || existing.deletedAt || (existing.lifecycleOperation && existing.lifecycleOperation.status !== 'complete')) return { ok: false, message: 'Only an owner can rename an active workspace.' }
    try {
      const updated = await renameWorkspaceApi(id, name.trim(), existing.etag)
      ++metadataSequence.current
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

  if (phase.kind === 'empty' && session) return <CloudGateShell>
    <h1>My workspaces</h1><p>No active workspace is selected. Create a workspace or unarchive one below. Deleted samples are never recreated automatically.</p>
    <WorkspaceSwitcher empty cloud={{ workspaces: session.workspaces, currentWorkspaceId: '', switchWorkspace, createWorkspace, renameWorkspace,
      refreshWorkspaces, getWorkspaceLifecycleImpact, changeWorkspaceLifecycle }} />
    <Button onClick={onSignedOut}>Sign out</Button>
  </CloudGateShell>

  if (phase.kind !== 'ready') return null
  const workspaceId = phase.workspaceId
  const activeSession = session
  if (!activeSession) throw new Error('The cloud session is missing after initialization.')
  const viewScope = JSON.stringify([activeSession.user.tenantId, activeSession.user.id, workspaceId])
  // Keep pending saves above the router when browser history temporarily crosses its basename.
  return <LibraryViewStateProvider scopeKey={viewScope}><GradeNavigationProtectionProvider key={workspaceId} workspaceId={workspaceId} apiRef={gradeLeaveRef}><CloudWorkspaceProvider
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
        refreshWorkspaces={refreshWorkspaces}
        getWorkspaceLifecycleImpact={getWorkspaceLifecycleImpact}
        changeWorkspaceLifecycle={changeWorkspaceLifecycle}
        leaveUnavailableWorkspace={leaveUnavailableWorkspace}
        onSignedOut={onSignedOut}
      >
    {(legacyValue, cloud) => <BrowserRouter key={workspaceId} basename={`/workspaces/${encodeURIComponent(workspaceId)}`}>
      <GradeRouterProtection><RealJobsBridge workspaceId={workspaceId} legacyValue={legacyValue} cloud={cloud}><RealGradeLaddersBridge workspaceId={workspaceId}><RealResumesBridge workspaceId={workspaceId}><RealAnalysesBridge workspaceId={workspaceId}>
        <TrackCloudPath pathRef={lastPathRef} stateRef={lastHistoryStateRef} basename={`/workspaces/${encodeURIComponent(workspaceId)}`} />
        <App />
      </RealAnalysesBridge></RealResumesBridge></RealGradeLaddersBridge></RealJobsBridge></GradeRouterProtection>
    </BrowserRouter>}
  </CloudWorkspaceProvider></GradeNavigationProtectionProvider></LibraryViewStateProvider>
}

function isActiveWorkspace(workspace: WorkspaceSummary): boolean {
  return !workspace.archivedAt && !workspace.deletedAt && (!workspace.lifecycleOperation || workspace.lifecycleOperation.status === 'complete')
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
  return <LifecycleDialogProvider><main className="recovery-page">
    <div className={`panel recovery-card cloud-gate-card ${tone === 'error' ? 'is-error' : ''}`}>
      <span className="cloud-gate-brand"><Layers3 size={20} strokeWidth={2} /> score<span className="brand-period">.</span></span>
      {children}
    </div>
  </main></LifecycleDialogProvider>
}
