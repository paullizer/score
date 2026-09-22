import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
  authLoginUrl, authLogoutUrl, CloudAccessChangedError, CloudApiError, CloudAuthError, CloudConflictError, workspaceAccessStamp,
  createWorkspace as createWorkspaceApi, fetchSession, fetchSessionIdentity, setCloudSessionAccess, CLOUD_ACCESS_REFRESH_EVENT,
  readLastWorkspaceId, renameWorkspace as renameWorkspaceApi, safeSameOriginPath,
  validateWorkspaceName, writeLastWorkspaceId,
  clearLastWorkspaceId, getWorkspaceLifecycleImpact as getWorkspaceLifecycleImpactApi, changeWorkspaceLifecycle as changeWorkspaceLifecycleApi, LifecycleOperationError,
} from '../services/cloudWorkspace'
import type { CloudSession, WorkspaceSummary } from '../domain/cloud'
import type { LifecycleAction } from '../domain/lifecycle'
import { Button } from '../components/ui'
import { WorkspaceSwitcher } from '../components/workspace/WorkspaceSwitcher'
import { LifecycleDialogProvider } from '../components/lifecycle/LifecycleControls'
import { PublicSettingsProvider } from './PublicSettingsProvider'
import { usePublicSettings } from './public-settings-context'
import { ApplicationNavigationContext } from './application-navigation-context'
import { AdminSettingsPage } from '../features/admin/AdminSettingsPage'
import { AdminUsersPage } from '../features/admin/AdminUsersPage'
import { AccessSuspendedContext } from './access-suspended-context'
import { defaultApplicationPage } from '../services/publicSettings'
import '../styles/admin-settings.css'
import '../styles/workspace-access.css'

type Result = { ok: true } | { ok: false; message: string }

type Phase =
  | { kind: 'loading' }
  | { kind: 'sign-in'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'workspace-unavailable'; requestedId: string }
  | { kind: 'empty' }
  | { kind: 'admin'; view: 'settings' | 'users' }
  | { kind: 'ready'; workspaceId: string }

const WORKSPACE_PATH = /^\/workspaces\/([^/]+)(?:\/|$)/
function adminViewFromPath(path: string): 'settings' | 'users' | null {
  const view = /^\/admin\/(settings|users)\/?$/.exec(path)?.[1]
  return view === 'settings' || view === 'users' ? view : null
}

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
 *    user's last-used, or first, accessible workspace),
 *  - the actual BrowserRouter + CloudWorkspaceProvider, both remounted (via `key={workspaceId}`)
 *    whenever the active workspace changes so no stale controller/request can write into the wrong
 *    workspace,
 *  - workspace list/create/rename/switch and the flush-then-redirect sign-out flow.
 */
export function CloudApplication() {
  return <PublicSettingsProvider><CloudApplicationContent /></PublicSettingsProvider>
}

function CloudApplicationContent() {
  const policy = usePublicSettings()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [session, setSession] = useState<CloudSession | null>(null)
  const [accessError, setAccessError] = useState('')
  const providerApiRef = useRef<CloudWorkspaceProviderApi | null>(null)
  const gradeLeaveRef = useRef<GradeLeaveProtectionApi | null>(null)
  const adminLeaveRef = useRef<GradeLeaveProtectionApi | null>(null)
  const aliveRef = useRef(true)
  const lastPathRef = useRef(window.location.pathname + window.location.search + window.location.hash)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const metadataSequence = useRef(0)
  const lifecyclePending = useRef(false)
  const refreshing = useRef<Promise<void> | null>(null)
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const adminMounted = useRef(false)
  const lastHistoryStateRef = useRef<unknown>(window.history.state)
  const policyRef = useRef(policy)
  policyRef.current = policy
  const initializationReady = adminViewFromPath(window.location.pathname) !== null || policy.phase !== 'loading'

  const publishSession = useCallback((value: CloudSession) => {
    setCloudSessionAccess(value)
    sessionRef.current = value
    setSession(value)
  }, [])

  const homePath = useCallback((id: string) => {
    const host = new URLSearchParams(window.location.search).get('scoutTheme')
    return `/workspaces/${encodeURIComponent(id)}${defaultApplicationPage(policyRef.current.settings)}${host === 'light' || host === 'dark' ? `?scoutTheme=${host}` : ''}`
  }, [])

  useEffect(() => {
    if (!initializationReady) return
    aliveRef.current = true
    const controller = new AbortController()
    const directAdmin = adminViewFromPath(window.location.pathname)
    const sessionRequest: Promise<CloudSession> = directAdmin
      ? fetchSessionIdentity(controller.signal).then(identity => ({ ...identity, workspaces: [] }))
      : fetchSession(controller.signal)
    sessionRequest.then((value) => {
      if (!aliveRef.current || controller.signal.aborted) return
      publishSession(value)
      if (directAdmin) { setPhase({ kind: 'admin', view: directAdmin }); return }
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
      window.history.replaceState(null, '', homePath(target))
      writeLastWorkspaceId(value.user.tenantId, value.user.id, target)
      setPhase({ kind: 'ready', workspaceId: target })
    }).catch((error: unknown) => {
      if (!aliveRef.current || controller.signal.aborted) return
      if (error instanceof CloudAuthError || (error instanceof CloudApiError && error.status === 403)) { setPhase({ kind: 'sign-in', message: error.message }); return }
      const message = error instanceof CloudApiError ? error.message : "Score's cloud service is unavailable right now. Check your connection and try again."
      setPhase({ kind: 'unavailable', message })
    })
    return () => { aliveRef.current = false; controller.abort(); setCloudSessionAccess(null) }
  }, [homePath, initializationReady, publishSession])

  async function openAdminView(view: 'settings' | 'users') {
    if (sessionRef.current?.capabilities?.applicationAdmin !== true) return
    if (phaseRef.current.kind === 'admin' && phaseRef.current.view === view) return
    const prepared = phaseRef.current.kind === 'admin'
      ? { ok: await adminLeaveRef.current?.confirmLeave(undefined, true) ?? true }
      : await providerApiRef.current?.prepareToLeave() ?? { ok: await gradeLeaveRef.current?.confirmLeave(undefined, true) ?? true }
    if (!prepared.ok) return
    adminLeaveRef.current?.releaseForLeave()
    const host = new URLSearchParams(window.location.search).get('scoutTheme')
    const path = `/admin/${view}${host === 'light' || host === 'dark' ? `?scoutTheme=${host}` : ''}`
    window.history.pushState(null, '', path)
    lastPathRef.current = path
    lastHistoryStateRef.current = window.history.state
    setPhase({ kind: 'admin', view })
  }
  const openAdminSettings = () => openAdminView('settings')
  const openAdminUsers = () => openAdminView('users')

  async function switchWorkspace(id: string, availableSession = session, alreadyPrepared = false): Promise<Result> {
    if (!availableSession) return { ok: false, message: 'Your session is still loading. Try again in a moment.' }
    if (!availableSession.workspaces.some((item) => item.id === id && !item.deletedAt)) return { ok: false, message: 'That workspace is not available to your account.' }
    if (phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === id) return { ok: true }
    const flushed = alreadyPrepared ? { ok: true as const } : await providerApiRef.current?.prepareToLeave() ??
      (await gradeLeaveRef.current?.confirmLeave(undefined, true) === false ? { ok: false as const, message: 'Leaving was cancelled to preserve an access change.' } : { ok: true as const })
    if (!flushed.ok) return flushed
    if (!sessionRef.current?.workspaces.some(item => item.id === id && !item.deletedAt)) return { ok: false, message: 'Access to that workspace changed while preparing to leave. Refresh the workspace list before selecting it again.' }
    writeLastWorkspaceId(availableSession.user.tenantId, availableSession.user.id, id)
    window.history.pushState(null, '', homePath(id))
    setPhase({ kind: 'ready', workspaceId: id })
    return { ok: true }
  }

  // Intercept cross-workspace history before BrowserRouter unmounts its old basename/provider.
  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      if (!session) return
      const requested = resolveRequestedWorkspaceId()
      const adminRequested = adminViewFromPath(window.location.pathname)
      if (phase.kind === 'admin' && phase.view === adminRequested) return
      if (phase.kind === 'ready' && phase.workspaceId === requested) return
      event.stopImmediatePropagation()
      const incoming = window.location.pathname + window.location.search + window.location.hash
      const outgoing = lastPathRef.current
      const outgoingState = lastHistoryStateRef.current
      const leave = phase.kind === 'admin'
        ? (adminLeaveRef.current?.confirmLeave() ?? Promise.resolve(true)).then(ok => ({ ok }))
        : providerApiRef.current?.prepareToLeave() ?? Promise.resolve({ ok: true as const })
      void leave.then((result) => {
        if (!aliveRef.current) return
        if (!result.ok) {
          window.history.pushState(outgoingState, '', outgoing)
          window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
          return
        }
        if (adminRequested) {
          lastPathRef.current = incoming; lastHistoryStateRef.current = event.state
          adminLeaveRef.current?.releaseForLeave()
          setPhase({ kind: 'admin', view: adminRequested })
          return
        }
        if (phase.kind === 'admin') {
          adminLeaveRef.current?.releaseForLeave()
          window.location.assign(incoming)
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
    try {
      const next = await fetchSession()
      if (!aliveRef.current || sequence !== metadataSequence.current) return
      const currentSession = sessionRef.current
      if (!currentSession) return
      if (next.user.id !== currentSession.user.id || next.user.tenantId !== currentSession.user.tenantId) {
        publishSession({ ...currentSession, capabilities: { applicationAdmin: false, canCreateWorkspaces: false }, workspaces: [] })
        throw new Error('A different account is now signed in. Previous drafts are retained in this tab and will not be uploaded. Sign back in with the original account, or explicitly discard them before leaving.')
      }
      const currentId = phaseRef.current.kind === 'ready' ? phaseRef.current.workspaceId : undefined
      if (currentId && !next.workspaces.some(item => item.id === currentId && !item.deletedAt)) {
        clearLastWorkspaceId(currentSession.user.tenantId, currentSession.user.id)
      }
      publishSession(next)
      setAccessError('')
      const currentPhase = phaseRef.current
      if (currentPhase.kind === 'workspace-unavailable' && next.workspaces.some(item => item.id === currentPhase.requestedId && !item.deletedAt)) {
        const requested = currentPhase.requestedId
        writeLastWorkspaceId(next.user.tenantId, next.user.id, requested)
        setPhase({ kind: 'ready', workspaceId: requested })
      }
    } catch (caught) {
      if (!aliveRef.current || sequence !== metadataSequence.current) return
      if (caught instanceof CloudAuthError || (caught instanceof CloudApiError && [401, 403].includes(caught.status))) {
        const current = sessionRef.current
        if (current) publishSession({ ...current, capabilities: { applicationAdmin: false, canCreateWorkspaces: false }, workspaces: [] })
      }
      const message = caught instanceof Error ? caught.message : 'Current workspace access could not be refreshed. Keep this tab open and try again.'
      setAccessError(message)
      throw caught
    }
  }
  refreshRef.current = refreshWorkspaces

  useEffect(() => {
    const refresh = () => {
      if (!sessionRef.current || refreshing.current) return
      refreshing.current = refreshRef.current().catch(caught => {
        console.warn('Score could not refresh current access:', caught instanceof Error ? caught.message : caught)
      }).finally(() => { refreshing.current = null })
    }
    window.addEventListener('focus', refresh)
    window.addEventListener(CLOUD_ACCESS_REFRESH_EVENT, refresh)
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener(CLOUD_ACCESS_REFRESH_EVENT, refresh) }
  }, [])

  async function changeWorkspaceLifecycle(id: string, action: LifecycleAction) {
    if (lifecyclePending.current) throw new Error('Wait for the current workspace lifecycle request.')
    const currentSession = sessionRef.current
    const existing = currentSession?.workspaces.find((item) => item.id === id)
    if (!currentSession || !existing || existing.deletedAt) throw new Error('This workspace is no longer available.')
    if (existing.role !== 'owner') throw new Error('Only the workspace owner can archive, unarchive, or delete a workspace.')
    const accessStarted = workspaceAccessStamp(existing)
    const currentTarget = phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === id
    const prepared = await (currentTarget ? providerApiRef.current?.prepareToLeave() : providerApiRef.current?.flush()) ?? { ok: true as const }
    if (!prepared.ok) throw new Error(prepared.message)
    lifecyclePending.current = true
    ++metadataSequence.current
    try {
      const result = await changeWorkspaceLifecycleApi(id, action, existing.etag)
      if (!aliveRef.current) return
      if (workspaceAccessStamp(sessionRef.current?.workspaces.find(item => item.id === id)) !== accessStarted) throw new CloudAccessChangedError()
      ++metadataSequence.current
      const updated = result.workspace
      const operation = result.operation ?? updated?.lifecycleOperation
      const next = {
        ...sessionRef.current!,
        workspaces: result.deleted
          ? sessionRef.current!.workspaces.filter((item) => item.id !== id)
          : sessionRef.current!.workspaces.map((item) => item.id === id ? updated ?? { ...item, ...(operation ? { lifecycleOperation: operation } : {}) } : item),
      }
      publishSession(next)
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
    if (gradeLeaveRef.current && !await gradeLeaveRef.current.confirmLeave(undefined, true)) return { ok: false, message: 'Leaving was stopped to preserve unsaved changes or a pending request.' }
    await providerApiRef.current?.discardPendingChanges()
    if (sessionRef.current) clearLastWorkspaceId(sessionRef.current.user.tenantId, sessionRef.current.user.id)
    window.history.replaceState(null, '', '/')
    lastPathRef.current = '/'
    setPhase({ kind: 'empty' })
    return { ok: true }
  }

  async function createWorkspace(name: string): Promise<Result> {
    const current = sessionRef.current
    if (!current) return { ok: false, message: 'Your session is still loading. Try again in a moment.' }
    if (current.capabilities?.canCreateWorkspaces !== true) return { ok: false, message: 'Ask an application administrator for permission to create workspaces. Existing ownership does not grant creation permission.' }
    if (policyRef.current.phase !== 'ready' || policyRef.current.settings?.workspaces.allowCreation === false) {
      return { ok: false, message: policyRef.current.error ?? 'New workspace creation is disabled by application policy.' }
    }
    const invalid = validateWorkspaceName(name)
    if (invalid) return { ok: false, message: invalid }
    const flushed = await providerApiRef.current?.prepareToLeave() ?? { ok: true as const }
    if (!flushed.ok) return flushed
    try {
      const created = await createWorkspaceApi(name.trim())
      ++metadataSequence.current
      const latest = sessionRef.current ?? current
      const updatedSession = { ...latest, workspaces: [...latest.workspaces.filter((item) => item.id !== created.id), created] }
      publishSession(updatedSession)
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
    const accessStarted = workspaceAccessStamp(existing)
    try {
      const updated = await renameWorkspaceApi(id, name.trim(), existing.etag)
      if (workspaceAccessStamp(sessionRef.current?.workspaces.find(item => item.id === id)) !== accessStarted) throw new CloudAccessChangedError()
      ++metadataSequence.current
      const latest = sessionRef.current
      if (latest) publishSession({ ...latest, workspaces: latest.workspaces.map(item => item.id === id ? updated : item) })
      return { ok: true }
    } catch (error) {
      if (error instanceof CloudAuthError) { setPhase({ kind: 'sign-in', message: error.message }); return { ok: false, message: error.message } }
      if (error instanceof CloudConflictError) {
        try {
          await refreshWorkspaces()
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

  const refreshAccess = () => {
    void refreshWorkspaces().catch(caught => console.warn('Access refresh failed:', caught instanceof Error ? caught.message : caught))
  }
  const accessNotice = accessError && <div className="storage-banner" role="alert"><span>Access refresh: {accessError}</span><Button size="sm" onClick={refreshAccess}>Refresh access</Button></div>

  if (phase.kind === 'loading') return <CloudGateShell><p>Connecting to Score in the cloud…</p></CloudGateShell>

  if (phase.kind === 'admin' && session) {
    const authorized = session.capabilities?.applicationAdmin === true
    if (authorized) adminMounted.current = true
    const denial = <CloudGateShell tone="error">
      <ShieldCheck size={30} /><h1>Application administrator access required</h1>
      <p>Your signed-in account is not designated as an application administrator. Owning a workspace does not grant access to application settings or user access.</p>
      {adminMounted.current && <p>Unsaved administration choices are retained in this tab, but cannot be saved without administrator access.</p>}
      {accessNotice}<Button onClick={refreshAccess}>Refresh access</Button>
      <Button onClick={() => {
        void (adminLeaveRef.current?.confirmLeave(undefined, true) ?? Promise.resolve(true)).then(allowed => {
          if (allowed) { adminLeaveRef.current?.releaseForLeave(); window.location.assign('/') }
        })
      }}>Back to workspaces</Button>
    </CloudGateShell>
    if (!authorized && !adminMounted.current) return denial
    const onLeave = () => { adminLeaveRef.current?.releaseForLeave(); window.location.assign('/') }
    return <GradeNavigationProtectionProvider key={phase.view} workspaceId={`application-${phase.view}`} routePrefix={`/admin/${phase.view}`} apiRef={adminLeaveRef}>
      {!authorized ? denial : accessNotice}
      <AccessSuspendedContext.Provider value={!authorized}><div className="access-suspended" hidden={!authorized}>
        {phase.view === 'users' ? <AdminUsersPage onLeave={onLeave} onOpenSettings={openAdminSettings} onAccessChanged={refreshWorkspaces} />
          : <AdminSettingsPage onLeave={onLeave} onOpenUsers={openAdminUsers} />}
      </div></AccessSuspendedContext.Provider>
    </GradeNavigationProtectionProvider>
  }
  adminMounted.current = false

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
    <p>The workspace in this link doesn't exist, or your account no longer has access to it. Ask a workspace owner or application administrator for access, then refresh. Nothing was changed.</p>
    {accessNotice}<Button onClick={refreshAccess}>Refresh access</Button>
    <Button variant="primary" onClick={() => { window.history.replaceState(null, '', '/'); window.location.reload() }}>Go to my workspaces</Button>
    {session?.capabilities?.applicationAdmin === true && <Button onClick={() => void openAdminSettings()}>Application settings</Button>}
    {session?.capabilities?.applicationAdmin === true && <Button onClick={() => void openAdminUsers()}>Users / user access</Button>}
  </CloudGateShell>

  if (phase.kind === 'empty' && session) return <GradeNavigationProtectionProvider workspaceId="workspace-directory" routePrefix="/" apiRef={gradeLeaveRef}><CloudGateShell>
    <h1>My workspaces</h1><p>{session.workspaces.some(item => !item.deletedAt)
      ? 'No active workspace is selected. Open an archived workspace to read its content; Owners and application administrators can restore it.'
      : session.capabilities?.canCreateWorkspaces
        ? policy.settings?.workspaces.allowCreation === false
          ? 'No workspaces are assigned to your account. You have creation permission, but the application-wide creation policy is disabled. Ask an owner to share an existing workspace.'
          : 'No workspaces yet. Create one to get started, or ask an owner to share an existing workspace.'
        : 'No workspaces are assigned to your account. Ask a workspace owner to share one, or an application administrator for permission to create a workspace.'} Nothing is created automatically.</p>
    {accessNotice}
    <WorkspaceSwitcher empty cloud={{ workspaces: session.workspaces, currentWorkspaceId: '', switchWorkspace, createWorkspace, renameWorkspace,
      canCreateWorkspaces: session.capabilities?.canCreateWorkspaces === true, refreshWorkspaces, getWorkspaceLifecycleImpact, changeWorkspaceLifecycle }} />
    {policy.settings?.workspaces.allowCreation === false && <p>Creating new workspaces is disabled by application policy. Existing workspace history is unchanged.</p>}
    {session.capabilities?.applicationAdmin === true && <Button onClick={() => void openAdminSettings()}>Application settings</Button>}
    {session.capabilities?.applicationAdmin === true && <Button onClick={() => void openAdminUsers()}>Users / user access</Button>}
    <Button onClick={() => { void (gradeLeaveRef.current?.confirmLeave(undefined, true) ?? Promise.resolve(true)).then(allowed => { if (allowed) onSignedOut() }) }}>Sign out</Button>
  </CloudGateShell></GradeNavigationProtectionProvider>

  if (phase.kind !== 'ready') return null
  const workspaceId = phase.workspaceId
  const activeSession = session
  if (!activeSession) throw new Error('The cloud session is missing after initialization.')
  const viewScope = JSON.stringify([activeSession.user.tenantId, activeSession.user.id, workspaceId])
  // Keep pending saves above the router when browser history temporarily crosses its basename.
  return <ApplicationNavigationContext.Provider value={{ applicationAdmin: activeSession.capabilities?.applicationAdmin === true, openAdminSettings, openAdminUsers }}>{accessNotice}<LibraryViewStateProvider scopeKey={viewScope}><GradeNavigationProtectionProvider key={workspaceId} workspaceId={workspaceId} apiRef={gradeLeaveRef}><CloudWorkspaceProvider
        key={workspaceId}
        workspaceId={workspaceId}
        user={activeSession.user}
        workspaces={activeSession.workspaces}
        canCreateWorkspaces={activeSession.capabilities?.canCreateWorkspaces === true}
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
  </CloudWorkspaceProvider></GradeNavigationProtectionProvider></LibraryViewStateProvider></ApplicationNavigationContext.Provider>
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
  const { settings } = usePublicSettings()
  return <LifecycleDialogProvider><main className="recovery-page">
    <div className={`panel recovery-card cloud-gate-card ${tone === 'error' ? 'is-error' : ''}`}>
      <span className="cloud-gate-brand"><Layers3 size={20} strokeWidth={2} />{settings?.appearance.applicationTitle ?? 'Score'}</span>
      {children}
    </div>
  </main></LifecycleDialogProvider>
}
