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
  authLoginUrl, authLogoutUrl, CloudApiError, CloudAuthError, CloudConflictError,
  createWorkspace as createWorkspaceApi, fetchSession, fetchSessionIdentity, listWorkspaces as listWorkspacesApi,
  renameWorkspace as renameWorkspaceApi, safeSameOriginPath,
  validateWorkspaceName,
  getWorkspaceLifecycleImpact as getWorkspaceLifecycleImpactApi, changeWorkspaceLifecycle as changeWorkspaceLifecycleApi, LifecycleOperationError,
} from '../services/cloudWorkspace'
import type { CloudSession, CloudUser, WorkspaceSummary } from '../domain/cloud'
import type { LifecycleAction } from '../domain/lifecycle'
import { Button } from '../components/ui'
import { LifecycleDialogProvider } from '../components/lifecycle/LifecycleControls'
import { PublicSettingsProvider } from './PublicSettingsProvider'
import { usePublicSettings } from './public-settings-context'
import { ApplicationNavigationContext } from './application-navigation-context'
import { AdminSettingsPage } from '../features/admin/AdminSettingsPage'
import { defaultApplicationPage } from '../services/publicSettings'
import { WorkspaceHomePage } from '../features/workspaces/WorkspaceHomePage'
import { pruneRecentWorkspaces, readRecentWorkspaces, recordWorkspaceVisit, writeRecentWorkspaces, type RecentWorkspace } from '../services/workspaceRecents'
import '../styles/admin-settings.css'

type Result = { ok: true } | { ok: false; message: string }

type Phase =
  | { kind: 'loading' }
  | { kind: 'sign-in'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'workspace-unavailable'; requestedId: string }
  | { kind: 'home' }
  | { kind: 'admin' }
  | { kind: 'ready'; workspaceId: string }

const WORKSPACE_PATH = /^\/workspaces\/([^/]+)(?:\/|$)/
function isAdminSettingsPath(path: string): boolean { return /^\/admin\/settings\/?$/.test(path) }

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
 *  - resolving explicit `/workspaces/:workspaceId/...` links while keeping bare cloud visits on
 *    the workspace home, outside any workspace-specific provider,
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
  const [recents, setRecents] = useState<RecentWorkspace[]>([])
  const [directoryRevision, setDirectoryRevision] = useState(0)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [directoryReady, setDirectoryReady] = useState(false)
  const recentsRef = useRef(recents)
  const recentsOwnerRef = useRef<string | null>(null)
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
  const navigationPending = useRef(false)
  const lastHistoryStateRef = useRef<unknown>(window.history.state)
  const policyRef = useRef(policy)
  policyRef.current = policy
  const initializationReady = isAdminSettingsPath(window.location.pathname) || policy.phase !== 'loading'

  const workspacePath = useCallback((id: string) => {
    const host = new URLSearchParams(window.location.search).get('scoutTheme') ?? policyRef.current.hostTheme
    return `/workspaces/${encodeURIComponent(id)}${defaultApplicationPage(policyRef.current.settings)}${host === 'light' || host === 'dark' ? `?scoutTheme=${host}` : ''}`
  }, [])
  const homePath = useCallback(() => {
    const host = new URLSearchParams(window.location.search).get('scoutTheme') ?? policyRef.current.hostTheme
    return `/${host === 'light' || host === 'dark' ? `?scoutTheme=${host}` : ''}`
  }, [])

  const syncRecentDirectory = useCallback((user: CloudUser, items: WorkspaceSummary[]) => {
    const owner = JSON.stringify([user.tenantId, user.id])
    const current = recentsOwnerRef.current === owner ? recentsRef.current : readRecentWorkspaces(user.tenantId, user.id)
    const next = pruneRecentWorkspaces(current, items)
    recentsOwnerRef.current = owner
    recentsRef.current = next; setRecents(next)
    writeRecentWorkspaces(user.tenantId, user.id, next)
  }, [])

  const onWorkspaceOpened = useCallback((id: string) => {
    const current = sessionRef.current
    if (!current || !current.workspaces.some((item) => item.id === id && !item.deletedAt)) return
    const next = recordWorkspaceVisit(recentsRef.current, id)
    recentsRef.current = next; setRecents(next)
    writeRecentWorkspaces(current.user.tenantId, current.user.id, next)
  }, [])

  const enterHome = useCallback((replace = false) => {
    const path = homePath()
    if (replace) window.history.replaceState(null, '', path)
    else window.history.pushState(null, '', path)
    lastPathRef.current = path
    lastHistoryStateRef.current = window.history.state
    setPhase({ kind: 'home' })
  }, [homePath])

  useEffect(() => {
    if (!initializationReady) return
    aliveRef.current = true
    const controller = new AbortController()
    const directAdmin = isAdminSettingsPath(window.location.pathname)
    const sessionRequest: Promise<CloudSession> = directAdmin
      ? fetchSessionIdentity(controller.signal).then(identity => ({ ...identity, workspaces: [] }))
      : fetchSession(controller.signal)
    sessionRequest.then((value) => {
      if (!aliveRef.current || controller.signal.aborted) return
      sessionRef.current = value; setSession(value)
      if (directAdmin) { setPhase({ kind: 'admin' }); return }
      setDirectoryReady(true)
      syncRecentDirectory(value.user, value.workspaces)
      const requested = resolveRequestedWorkspaceId()
      if (requested !== null) {
        if (!value.workspaces.some((item) => item.id === requested && !item.deletedAt)) {
          setPhase({ kind: 'workspace-unavailable', requestedId: requested })
          return
        }
        setPhase({ kind: 'ready', workspaceId: requested })
        return
      }
      enterHome(true)
    }).catch((error: unknown) => {
      if (!aliveRef.current || controller.signal.aborted) return
      if (error instanceof CloudAuthError || (error instanceof CloudApiError && error.status === 403)) { setPhase({ kind: 'sign-in', message: error.message }); return }
      const message = error instanceof CloudApiError ? error.message : "Score's cloud service is unavailable right now. Check your connection and try again."
      setPhase({ kind: 'unavailable', message })
    })
    return () => { aliveRef.current = false; controller.abort() }
  }, [enterHome, initializationReady, syncRecentDirectory])

  async function openWorkspaceHome() {
    if (navigationPending.current || lifecyclePending.current || phaseRef.current.kind === 'home') return
    navigationPending.current = true
    try {
      const prepared = phaseRef.current.kind === 'admin'
        ? { ok: await adminLeaveRef.current?.confirmLeave() ?? true }
        : await providerApiRef.current?.prepareToLeave() ?? { ok: true as const }
      if (!prepared.ok || !aliveRef.current) return
      adminLeaveRef.current?.releaseForLeave()
      enterHome()
    } finally { navigationPending.current = false }
  }

  async function openAdminSettings() {
    if (sessionRef.current?.capabilities?.applicationAdmin !== true || navigationPending.current || lifecyclePending.current) return
    navigationPending.current = true
    try {
      const prepared = await providerApiRef.current?.prepareToLeave() ?? { ok: true as const }
      if (!prepared.ok || !aliveRef.current) return
      const host = new URLSearchParams(window.location.search).get('scoutTheme') ?? policyRef.current.hostTheme
      const path = `/admin/settings${host === 'light' || host === 'dark' ? `?scoutTheme=${host}` : ''}`
      window.history.pushState(null, '', path)
      lastPathRef.current = path
      lastHistoryStateRef.current = window.history.state
      setPhase({ kind: 'admin' })
    } finally { navigationPending.current = false }
  }

  async function switchWorkspace(id: string, availableSession = session, alreadyPrepared = false): Promise<Result> {
    if (!availableSession) return { ok: false, message: 'Your session is still loading. Try again in a moment.' }
    if (!availableSession.workspaces.some((item) => item.id === id && !item.deletedAt)) return { ok: false, message: 'That workspace is not available to your account.' }
    if (phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === id) return { ok: true }
    if (!alreadyPrepared && (navigationPending.current || lifecyclePending.current)) return { ok: false, message: 'Wait for the current workspace request to finish.' }
    if (!alreadyPrepared) navigationPending.current = true
    try {
      const flushed = alreadyPrepared ? { ok: true as const } : await providerApiRef.current?.prepareToLeave() ?? { ok: true as const }
      if (!flushed.ok) return flushed
      if (!aliveRef.current) return { ok: false, message: 'The application session changed before the workspace could be opened.' }
      const latest = sessionRef.current
      if (!latest || latest.user.id !== availableSession.user.id || latest.user.tenantId !== availableSession.user.tenantId ||
        !latest.workspaces.some((item) => item.id === id && !item.deletedAt)) {
        return { ok: false, message: 'That workspace is no longer available to your account. Refresh the workspace list.' }
      }
      const path = workspacePath(id)
      window.history.pushState(null, '', path)
      lastPathRef.current = path
      lastHistoryStateRef.current = window.history.state
      setPhase({ kind: 'ready', workspaceId: id })
      return { ok: true }
    } finally { if (!alreadyPrepared) navigationPending.current = false }
  }

  // Intercept cross-workspace history before BrowserRouter unmounts its old basename/provider.
  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      if (!session) return
      const requested = resolveRequestedWorkspaceId()
      const adminRequested = isAdminSettingsPath(window.location.pathname)
      if (phase.kind === 'admin' && adminRequested) return
      if (phase.kind === 'ready' && phase.workspaceId === requested) return
      if (phase.kind === 'home' && requested === null && !adminRequested) {
        lastPathRef.current = window.location.pathname + window.location.search + window.location.hash
        lastHistoryStateRef.current = event.state
        return
      }
      event.stopImmediatePropagation()
      const incoming = window.location.pathname + window.location.search + window.location.hash
      const outgoing = lastPathRef.current
      const outgoingState = lastHistoryStateRef.current
      if (navigationPending.current || lifecyclePending.current) {
        window.history.pushState(outgoingState, '', outgoing)
        return
      }
      navigationPending.current = true
      const leave = phase.kind === 'admin'
        ? (adminLeaveRef.current?.confirmLeave() ?? Promise.resolve(true)).then(ok => ({ ok }))
        : providerApiRef.current?.prepareToLeave() ?? Promise.resolve({ ok: true as const })
      void leave.then((result) => {
        if (!aliveRef.current) return
        if (!result.ok) {
          // The workspace router never saw this cross-scope pop; replaying it would ask twice.
          window.history.pushState(outgoingState, '', outgoing)
          return
        }
        if (adminRequested) {
          lastPathRef.current = incoming; lastHistoryStateRef.current = event.state
          setPhase({ kind: 'admin' })
          return
        }
        if (phase.kind === 'admin') adminLeaveRef.current?.releaseForLeave()
        if (requested === null) {
          window.history.replaceState(event.state, '', incoming)
          lastPathRef.current = incoming; lastHistoryStateRef.current = event.state
          setPhase({ kind: 'home' })
          return
        }
        // Direct admin entry loaded identity only, so verify a historical workspace before mounting it.
        if (phase.kind === 'admin' && !session.workspaces.some((item) => item.id === requested && !item.deletedAt)) {
          window.location.assign(incoming)
          return
        }
        if (!session.workspaces.some((item) => item.id === requested && !item.deletedAt)) {
          setPhase({ kind: 'workspace-unavailable', requestedId: requested })
          return
        }
        window.history.replaceState(event.state, '', incoming)
        lastPathRef.current = incoming; lastHistoryStateRef.current = event.state
        setPhase({ kind: 'ready', workspaceId: requested })
      }).catch((error: unknown) => {
        window.history.pushState(outgoingState, '', outgoing)
        setDirectoryError(error instanceof Error ? error.message : 'Navigation could not be completed. Your current workspace has been kept.')
      }).finally(() => { navigationPending.current = false })
    }
    const warn = (event: BeforeUnloadEvent) => {
      if (!navigationPending.current && !lifecyclePending.current) return
      event.preventDefault(); event.returnValue = ''
    }
    window.addEventListener('popstate', onPopState, { capture: true })
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('popstate', onPopState, { capture: true })
      window.removeEventListener('beforeunload', warn)
    }
  }, [session, phase])

  const refreshWorkspaces = useCallback(async () => {
    const sequence = ++metadataSequence.current
    let items: WorkspaceSummary[]
    try { items = await listWorkspacesApi() } catch (caught) {
      if (aliveRef.current && sequence === metadataSequence.current) {
        setDirectoryError(caught instanceof Error ? caught.message : 'The workspace directory could not be refreshed.')
        if (caught instanceof CloudAuthError) setPhase({ kind: 'sign-in', message: caught.message })
      }
      throw caught
    }
    if (!aliveRef.current || sequence !== metadataSequence.current) return
    const currentSession = sessionRef.current
    if (!currentSession) return
    const currentId = phaseRef.current.kind === 'ready' ? phaseRef.current.workspaceId : undefined
    const removed = currentId && !items.some((item) => item.id === currentId && !item.deletedAt)
    if (removed && !lifecyclePending.current) {
      const preserveDraft = providerApiRef.current?.hasPendingChanges() ||
        (gradeLeaveRef.current && !await gradeLeaveRef.current.confirmLeave(undefined, true))
      if (!aliveRef.current || sequence !== metadataSequence.current) return
      if (phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === currentId) {
        if (preserveDraft) {
          const previous = currentSession.workspaces.find((item) => item.id === currentId)
          if (previous) items.push({ ...previous, deletedAt: new Date().toISOString() })
        } else setPhase({ kind: 'workspace-unavailable', requestedId: currentId })
      }
    }
    const next = { ...currentSession, workspaces: items }
    sessionRef.current = next
    setSession(next)
    syncRecentDirectory(next.user, items)
    setDirectoryError(null)
    setDirectoryReady(true)
    setDirectoryRevision((value) => value + 1)
  }, [syncRecentDirectory])

  useEffect(() => {
    const refresh = () => {
      if (sessionRef.current && phaseRef.current.kind !== 'admin') void refreshWorkspaces().catch((error: unknown) => {
        console.warn('Score could not refresh the workspace directory.', error instanceof Error ? error.name : 'UnknownError')
      })
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refreshWorkspaces])

  useEffect(() => {
    if (phase.kind !== 'home') return
    void refreshWorkspaces().catch((error: unknown) => {
      console.warn('Score could not refresh workspace home.', error instanceof Error ? error.name : 'UnknownError')
    })
  }, [phase.kind, refreshWorkspaces])

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
      syncRecentDirectory(next.user, next.workspaces)
      setDirectoryRevision((value) => value + 1)
      if (operation && operation.status !== 'complete') throw new LifecycleOperationError(operation)
      if (!result.deleted && !updated) throw new Error('The service did not acknowledge a completed workspace change. Refresh status before retrying.')
      if (phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === id && action === 'unarchive') {
        const refreshed = await providerApiRef.current?.refreshState()
        if (refreshed && !refreshed.ok) throw new Error(`Unarchive completed, but refreshing the saved content failed: ${refreshed.message}`)
      }
      if (phaseRef.current.kind === 'ready' && phaseRef.current.workspaceId === id && action !== 'unarchive') {
        enterHome(true)
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
    enterHome(true)
    return { ok: true }
  }

  async function createWorkspace(name: string): Promise<Result> {
    if (!session) return { ok: false, message: 'Your session is still loading. Try again in a moment.' }
    if (policyRef.current.phase !== 'ready' || policyRef.current.settings?.workspaces.allowCreation === false) {
      return { ok: false, message: policyRef.current.error ?? 'New workspace creation is disabled by application policy.' }
    }
    const invalid = validateWorkspaceName(name)
    if (invalid) return { ok: false, message: invalid }
    if (navigationPending.current || lifecyclePending.current) return { ok: false, message: 'Wait for the current workspace request to finish.' }
    navigationPending.current = true
    try {
      const flushed = await providerApiRef.current?.prepareToLeave() ?? { ok: true as const }
      if (!flushed.ok) return flushed
      const created = await createWorkspaceApi(name.trim())
      if (!aliveRef.current) return { ok: false, message: 'The workspace was created, but this session is no longer active. Refresh the workspace directory before creating another.' }
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
    } finally { navigationPending.current = false }
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
      const latest = sessionRef.current
      if (latest) {
        const next = { ...latest, workspaces: latest.workspaces.map((item) => item.id === id ? updated : item) }
        sessionRef.current = next; setSession(next)
      }
      return { ok: true }
    } catch (error) {
      if (error instanceof CloudAuthError) { setPhase({ kind: 'sign-in', message: error.message }); return { ok: false, message: error.message } }
      if (error instanceof CloudConflictError) {
        try {
          const fresh = await listWorkspacesApi()
          const latest = sessionRef.current
          if (latest) {
            const next = { ...latest, workspaces: fresh }
            sessionRef.current = next; setSession(next)
            syncRecentDirectory(next.user, fresh)
          }
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

  async function signOutFromHome() {
    if (navigationPending.current || lifecyclePending.current) throw new Error('Wait for the current workspace request to be acknowledged before signing out.')
    onSignedOut()
  }

  if (phase.kind === 'loading') return <CloudGateShell><p>Connecting to Score in the cloud…</p></CloudGateShell>

  if (phase.kind === 'admin' && session) {
    if (session.capabilities?.applicationAdmin !== true) return <CloudGateShell tone="error">
      <ShieldCheck size={30} /><h1>Application administrator access required</h1>
      <p>Your signed-in account is not designated as an application administrator. Owning a workspace does not grant access to application settings.</p>
      <Button onClick={() => void openWorkspaceHome()}>Back to workspaces</Button>
    </CloudGateShell>
    return <GradeNavigationProtectionProvider workspaceId="application-settings" routePrefix="/admin/settings" apiRef={adminLeaveRef}>
      <AdminSettingsPage onLeave={() => { adminLeaveRef.current?.releaseForLeave(); enterHome() }} />
    </GradeNavigationProtectionProvider>
  }

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
    <Button variant="primary" onClick={() => enterHome(true)}>Go to my workspaces</Button>
    {session?.capabilities?.applicationAdmin === true && <Button onClick={() => void openAdminSettings()}>Application settings</Button>}
  </CloudGateShell>

  if (phase.kind === 'home' && session) return <WorkspaceHomePage key={JSON.stringify([session.user.tenantId, session.user.id])}
    user={session.user} directory={{ workspaces: session.workspaces, currentWorkspaceId: '', switchWorkspace, createWorkspace, renameWorkspace,
      refreshWorkspaces, getWorkspaceLifecycleImpact, changeWorkspaceLifecycle }}
    recents={recents} directoryRevision={directoryRevision} directoryError={directoryError} directoryReady={directoryReady} applicationAdmin={session.capabilities?.applicationAdmin === true}
    openAdminSettings={openAdminSettings} signOut={signOutFromHome} onAuthError={onAuthError} />

  if (phase.kind !== 'ready') return null
  const workspaceId = phase.workspaceId
  const activeSession = session
  if (!activeSession) throw new Error('The cloud session is missing after initialization.')
  const viewScope = JSON.stringify([activeSession.user.tenantId, activeSession.user.id, workspaceId])
  // Keep pending saves above the router when browser history temporarily crosses its basename.
  return <ApplicationNavigationContext.Provider value={{ applicationAdmin: activeSession.capabilities?.applicationAdmin === true, openAdminSettings, openWorkspaceHome, workspaceHomePath: homePath(), directoryError }}><LibraryViewStateProvider scopeKey={viewScope}><GradeNavigationProtectionProvider key={workspaceId} workspaceId={workspaceId} apiRef={gradeLeaveRef}><CloudWorkspaceProvider
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
        <TrackCloudPath pathRef={lastPathRef} stateRef={lastHistoryStateRef} basename={`/workspaces/${encodeURIComponent(workspaceId)}`} workspaceId={workspaceId} onOpened={onWorkspaceOpened} />
        <App />
      </RealAnalysesBridge></RealResumesBridge></RealGradeLaddersBridge></RealJobsBridge></GradeRouterProtection>
    </BrowserRouter>}
  </CloudWorkspaceProvider></GradeNavigationProtectionProvider></LibraryViewStateProvider></ApplicationNavigationContext.Provider>
}

function TrackCloudPath({ pathRef, stateRef, basename, workspaceId, onOpened }: {
  pathRef: { current: string }; stateRef: { current: unknown }; basename: string
  workspaceId: string; onOpened: (id: string) => void
}) {
  const location = useLocation()
  const opened = useRef(false)
  useEffect(() => {
    if (!opened.current) { opened.current = true; onOpened(workspaceId) }
  }, [onOpened, workspaceId])
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
