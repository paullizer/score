import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw, ShieldCheck } from 'lucide-react'
import { type CloudSaveState, type CloudWorkspaceStatus, type WorkspaceContextValue } from './workspace-context'
import { useWorkspaceEngine, type PersistenceResult, type WorkspaceEngine } from './useWorkspaceEngine'
import type { Workspace } from '../domain/types'
import type { CloudUser, CloudWorkspaceSnapshot, WorkspaceSummary } from '../domain/cloud'
import { authLoginUrl, CloudApiError, CloudAuthError, CloudConflictError, fetchSession, loadWorkspaceState, saveWorkspaceState } from '../services/cloudWorkspace'
import { recoverInterrupted, validateWorkspace, WorkspaceValidationError } from '../domain/workspace-validation'
import { Button, InlineError } from '../components/ui'
import type { GradeLeaveProtectionApi } from './grade-navigation-context'
import { workspaceLifecycleTransitionErrors, type LifecycleTarget } from '../domain/lifecycle'
import { WorkspaceSwitcher } from '../components/workspace/WorkspaceSwitcher'
import { LifecycleDialogProvider } from '../components/lifecycle/LifecycleControls'
import { useApplicationNavigation } from './application-navigation-context'

const SAVE_DEBOUNCE_MS = 700

type Result = { ok: true } | { ok: false; message: string; reason?: 'grade-protection' }
type CloudWorkspaceContent = (
  value: Omit<WorkspaceContextValue, 'cloud'>,
  cloud: Omit<CloudWorkspaceStatus, 'realJobs'>,
) => ReactNode
interface SaveStatus { state: CloudSaveState; error: string | null; conflict: { detectedAt: string } | null; authenticationRequired?: boolean }

export interface CloudWorkspaceProviderApi {
  /** Flushes any pending/in-flight save to completion. Used before switching workspaces or signing out. */
  flush: () => Promise<Result>
  prepareToLeave: () => Promise<Result>
  refreshState: () => Promise<Result>
  hasPendingChanges: () => boolean
  discardPendingChanges: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * Cloud-mode workspace provider: fetches a single workspace's document state from Azure, then serves
 * the same simulated import/rubric/analysis engine as the local demo (see useWorkspaceEngine), but
 * persists changes with a debounced, serialized, etag-guarded save queue instead of localStorage.
 *
 * Mounted keyed by workspaceId by CloudApplication, so switching workspaces always starts a fresh
 * instance: no in-flight load/save from a previous workspace can leak into the new one.
 */
export function CloudWorkspaceProvider({
  workspaceId, user, workspaces, apiRef, onAuthError,
  switchWorkspace, createWorkspace, renameWorkspace, onSignedOut, children,
  leaveProtectionRef,
  refreshWorkspaces, getWorkspaceLifecycleImpact, changeWorkspaceLifecycle,
  leaveUnavailableWorkspace,
}: {
  workspaceId: string
  user: CloudUser
  workspaces: WorkspaceSummary[]
  apiRef: { current: CloudWorkspaceProviderApi | null }
  leaveProtectionRef?: { current: GradeLeaveProtectionApi | null }
  onAuthError: (message: string) => void
  switchWorkspace: (id: string) => Promise<Result>
  createWorkspace: (name: string) => Promise<Result>
  renameWorkspace: (id: string, name: string) => Promise<Result>
  /** Called once pending saves have been flushed and it is safe to redirect to /.auth/logout. */
  onSignedOut: () => void
  children: CloudWorkspaceContent
  refreshWorkspaces: CloudWorkspaceStatus['refreshWorkspaces']
  getWorkspaceLifecycleImpact: CloudWorkspaceStatus['getWorkspaceLifecycleImpact']
  changeWorkspaceLifecycle: CloudWorkspaceStatus['changeWorkspaceLifecycle']
  leaveUnavailableWorkspace: CloudWorkspaceStatus['leaveUnavailableWorkspace']
}) {
  const application = useApplicationNavigation()
  const [phase, setPhase] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' }>({ kind: 'loading' })
  const [recoveredNotice, setRecoveredNotice] = useState<string | null>(null)
  const [syncingState, setSyncingState] = useState(false)
  const [snapshotRevision, setSnapshotRevision] = useState(0)
  const aliveRef = useRef(true)
  const etagRef = useRef<string>('')
  const pendingRef = useRef<Workspace | null>(null)
  const savingRef = useRef(false)
  const resolvingRef = useRef(false)
  const engineRef = useRef<WorkspaceEngine | null>(null)
  const debounceRef = useRef<number | null>(null)
  const statusRef = useRef<SaveStatus>({ state: 'saved', error: null, conflict: null })
  const [status, setStatusState] = useState<SaveStatus>(statusRef.current)
  const initialWorkspaceRef = useRef<Workspace | null>(null)
  const metadataRef = useRef(workspaces.find((item) => item.id === workspaceId))
  metadataRef.current = workspaces.find((item) => item.id === workspaceId)
  const metadataStamp = JSON.stringify([metadataRef.current?.archivedAt, metadataRef.current?.deletedAt, metadataRef.current?.lifecycleOperation])
  const appliedMetadataStamp = useRef(metadataStamp)
  const metadataGeneration = useRef({ stamp: metadataStamp, value: 0 })
  if (metadataGeneration.current.stamp !== metadataStamp) {
    metadataGeneration.current = { stamp: metadataStamp, value: metadataGeneration.current.value + 1 }
  }
  const stateRefreshRef = useRef<Promise<Result> | null>(null)

  function setStatus(next: SaveStatus) {
    statusRef.current = next
    setStatusState(next)
  }

  function clearDebounce() {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = null
  }

  async function loadCurrentSnapshot(signal?: AbortSignal): Promise<CloudWorkspaceSnapshot & { metadataGeneration: number }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = metadataGeneration.current.value
      const snapshot = await loadWorkspaceState(workspaceId, signal)
      if (generation === metadataGeneration.current.value) return { ...snapshot, metadataGeneration: generation }
    }
    throw new CloudConflictError('Workspace lifecycle changed repeatedly while loading. Keep this tab open and reload the latest state before continuing.')
  }

  function requireCurrentSnapshot(snapshot: CloudWorkspaceSnapshot & { metadataGeneration: number }) {
    if (snapshot.metadataGeneration !== metadataGeneration.current.value) {
      throw new CloudConflictError('Workspace lifecycle changed before the loaded state could be applied. Reload the latest state; the obsolete snapshot was not installed.')
    }
  }

  function saveFailure(error: unknown): Result {
    clearDebounce()
    if (error instanceof CloudConflictError) {
      setStatus({ state: 'conflict', error: error.message, conflict: { detectedAt: new Date().toISOString() } })
      return { ok: false, message: error.message }
    }
    const message = error instanceof CloudApiError ? error.message : 'Score could not complete the cloud request. Your changes are still in this tab; retry when the connection is available.'
    setStatus({ state: 'error', error: message, conflict: null, authenticationRequired: error instanceof CloudAuthError })
    return { ok: false, message }
  }

  useEffect(() => {
    aliveRef.current = true
    const controller = new AbortController()
    setPhase({ kind: 'loading' })
    setStatus({ state: 'saved', error: null, conflict: null })
    pendingRef.current = null
    savingRef.current = false
    setRecoveredNotice(null)
    loadCurrentSnapshot(controller.signal).then((snapshot) => {
      if (!aliveRef.current || controller.signal.aborted) return
      requireCurrentSnapshot(snapshot)
      let validated: Workspace
      try {
        validated = validateWorkspace(snapshot.workspace)
      } catch (error) {
        const message = error instanceof WorkspaceValidationError ? error.message : 'The saved workspace could not be opened: its data is corrupt or uses an unsupported format.'
        setPhase({ kind: 'error', message })
        return
      }
      // The backend never normalizes interrupted client-side simulations on read. Recover them here,
      // purely in memory: this browser marks them as interrupted so the UI is honest about their
      // state, but it must NOT autosave that change back \u2014 another browser/tab may still be
      // actively working on the same import or analysis, and only its own save (guarded by the real
      // etag) may resolve it.
      const recovered = recoverInterrupted(validated)
      if (JSON.stringify(recovered) !== JSON.stringify(validated)) {
        setRecoveredNotice('Some imports or analyses were interrupted before this workspace was last saved. They are shown as interrupted here only \u2014 another browser or device may still be working on them, and opening this workspace will not overwrite its progress. Retry the affected items when you are ready.')
      }
      etagRef.current = snapshot.etag
      initialWorkspaceRef.current = recovered
      setPhase({ kind: 'ready' })
    }).catch((error: unknown) => {
      if (!aliveRef.current || controller.signal.aborted) return
      if (error instanceof CloudAuthError) { onAuthError(error.message); return }
      const message = error instanceof CloudApiError ? error.message : 'Score could not load this workspace from the cloud. Check your connection and try again.'
      setPhase({ kind: 'error', message })
    })
    return () => {
      aliveRef.current = false
      controller.abort()
      clearDebounce()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!pendingRef.current && !savingRef.current && !resolvingRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  function blockedSave(): Result | null {
    if (resolvingRef.current) return { ok: false, message: 'Wait for the current conflict-resolution request to finish.' }
    if (statusRef.current.authenticationRequired) return { ok: false, message: 'Sign in again before saving or leaving this workspace.' }
    if (statusRef.current.state === 'conflict') return { ok: false, message: 'Resolve the save conflict before continuing.' }
    return null
  }

  async function runSaveLoop(): Promise<Result> {
    const blocked = blockedSave()
    if (blocked) return blocked
    if (savingRef.current) {
      while (savingRef.current) await sleep(50)
      const stopped = blockedSave()
      if (stopped) return stopped
      if (statusRef.current.state === 'error') return { ok: false, message: statusRef.current.error ?? 'This workspace could not be saved.' }
      if (pendingRef.current && aliveRef.current) return runSaveLoop()
      return { ok: true }
    }
    savingRef.current = true
    let outcome: Result = { ok: true }
    while (pendingRef.current && !resolvingRef.current) {
      const snapshot = pendingRef.current
      pendingRef.current = null
      if (!aliveRef.current) break
      setStatus({ state: 'saving', error: null, conflict: null })
      try {
        const result = await saveWorkspaceState(workspaceId, snapshot, etagRef.current)
        if (!aliveRef.current) break
        etagRef.current = result.etag
        if (!pendingRef.current && !resolvingRef.current && statusRef.current.state !== 'conflict') setStatus({ state: 'saved', error: null, conflict: null })
      } catch (error) {
        if (!aliveRef.current) break
        // Edits made while this request was in flight are newer than the failed snapshot.
        pendingRef.current ??= snapshot
        outcome = saveFailure(error)
        break
      }
    }
    savingRef.current = false
    return outcome
  }

  function enqueue(next: Workspace): PersistenceResult {
    pendingRef.current = next
    if (resolvingRef.current || statusRef.current.state === 'conflict' || statusRef.current.state === 'error') return 'queued'
    setStatus({ state: 'saving', error: null, conflict: null })
    clearDebounce()
    debounceRef.current = window.setTimeout(() => { debounceRef.current = null; void runSaveLoop() }, SAVE_DEBOUNCE_MS)
    return 'queued'
  }

  async function flush(): Promise<Result> {
    if (stateRefreshRef.current) {
      const refreshed = await stateRefreshRef.current
      if (!refreshed.ok) return refreshed
    }
    clearDebounce()
    const blocked = blockedSave()
    if (blocked) return blocked
    if (pendingRef.current || savingRef.current) return runSaveLoop()
    if (statusRef.current.state === 'error') return { ok: false, message: statusRef.current.error ?? 'This workspace has unsaved changes that could not be saved.' }
    return { ok: true }
  }

  async function flushSave() {
    const result = await flush()
    if (!result.ok) throw new Error(result.message)
  }

  function refreshState(): Promise<Result> {
    if (stateRefreshRef.current) return stateRefreshRef.current
    if (pendingRef.current || savingRef.current || resolvingRef.current) {
      const message = 'The workspace lifecycle changed in another session. Your unsaved changes are kept in this tab. Reload the latest state before continuing; deleted content cannot be overwritten.'
      setStatus({ state: 'conflict', error: message, conflict: { detectedAt: new Date().toISOString() } })
      return Promise.resolve({ ok: false, message })
    }
    clearDebounce()
    resolvingRef.current = true
    setSyncingState(true)
    engineRef.current?.setExternalArchive(true)
    const request = (async (): Promise<Result> => {
      try {
        const snapshot = await loadCurrentSnapshot()
        if (!aliveRef.current) return { ok: false, message: 'The workspace changed while its state was loading.' }
        requireCurrentSnapshot(snapshot)
        const validated = recoverInterrupted(validateWorkspace(snapshot.workspace))
        etagRef.current = snapshot.etag
        initialWorkspaceRef.current = validated
        engineRef.current?.replaceWorkspace(validated)
        setSnapshotRevision((value) => value + 1)
        setStatus({ state: 'saved', error: null, conflict: null })
        return { ok: true }
      } catch (error) {
        return aliveRef.current ? saveFailure(error) : { ok: false, message: 'The workspace changed while its state was loading.' }
      } finally {
        resolvingRef.current = false
        stateRefreshRef.current = null
        if (aliveRef.current) setSyncingState(false)
      }
    })()
    stateRefreshRef.current = request
    return request
  }

  useEffect(() => {
    if (appliedMetadataStamp.current === metadataStamp) return
    appliedMetadataStamp.current = metadataStamp
    if (!engineRef.current) return
    const metadata = metadataRef.current
    if (!metadata || metadata.deletedAt || (metadata.lifecycleOperation && metadata.lifecycleOperation.status !== 'complete')) {
      clearDebounce()
      if (pendingRef.current || savingRef.current) {
        setStatus({ state: 'conflict', error: 'Workspace lifecycle work is incomplete or this workspace was deleted elsewhere. Unsaved sample changes are kept here, not uploaded over it.', conflict: { detectedAt: new Date().toISOString() } })
      }
      return
    }
    void refreshState()
    // Metadata changes must refresh the sample ETag without remounting unsaved real-grade editors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadataStamp])

  async function prepareToLeave(): Promise<Result> {
    if (leaveProtectionRef?.current && !await leaveProtectionRef.current.confirmLeave(undefined, true)) {
      return { ok: false, reason: 'grade-protection', message: 'Leaving was stopped to preserve unsaved changes or an in-flight request.' }
    }
    engineRef.current?.stopPendingOperations('This browser paused the demo operations while leaving the workspace. Completed results are kept; retry unfinished items later.')
    return flush()
  }

  useEffect(() => {
    apiRef.current = {
      flush, prepareToLeave, refreshState,
      hasPendingChanges: () => Boolean(pendingRef.current || savingRef.current || resolvingRef.current),
      discardPendingChanges: async () => {
        clearDebounce()
        engineRef.current?.setExternalArchive(true)
        while (savingRef.current || resolvingRef.current) await sleep(50)
        pendingRef.current = null
        setStatus({ state: 'saved', error: null, conflict: null })
      },
    }
    return () => { apiRef.current = null }
  })

  async function reloadFromServer() {
    if (resolvingRef.current) return
    resolvingRef.current = true
    clearDebounce()
    engineRef.current?.stopPendingOperations('Demo operations paused while resolving a cloud save conflict.')
    while (savingRef.current) await sleep(50)
    try {
      const snapshot = await loadCurrentSnapshot()
      if (!aliveRef.current) return
      requireCurrentSnapshot(snapshot)
      const validated = recoverInterrupted(validateWorkspace(snapshot.workspace))
      etagRef.current = snapshot.etag
      initialWorkspaceRef.current = validated
      pendingRef.current = null
      setStatus({ state: 'saved', error: null, conflict: null })
      engineRef.current?.replaceWorkspace(validated)
      setSnapshotRevision((value) => value + 1)
    } catch (error) {
      if (!aliveRef.current) return
      if (error instanceof CloudAuthError) { saveFailure(error); return }
      const message = error instanceof CloudApiError ? error.message : 'Score could not reload this workspace from the cloud.'
      setStatus({ ...statusRef.current, error: message })
    } finally {
      resolvingRef.current = false
    }
  }

  async function keepMineAndOverwrite() {
    if (resolvingRef.current) return
    resolvingRef.current = true
    clearDebounce()
    engineRef.current?.stopPendingOperations('Demo operations paused while resolving a cloud save conflict.')
    while (savingRef.current) await sleep(50)
    const toSave = pendingRef.current
    if (!toSave) { resolvingRef.current = false; setStatus({ ...statusRef.current, error: 'There is nothing to overwrite with yet.' }); return }
    try {
      const fresh = await loadCurrentSnapshot()
      if (!aliveRef.current) return
      requireCurrentSnapshot(fresh)
      const serverWorkspace = validateWorkspace(fresh.workspace)
      const metadata = metadataRef.current
      if (!metadata || metadata.deletedAt || metadata.archivedAt || (metadata.lifecycleOperation && metadata.lifecycleOperation.status !== 'complete')) {
        throw new CloudConflictError('This workspace is archived, unavailable, or has an incomplete lifecycle operation. Reload the server state; overwriting cannot restore it.')
      }
      if (serverWorkspace.lifecycle?.archivedAt !== toSave.lifecycle?.archivedAt) {
        throw new CloudConflictError('Workspace archive state changed in another session. Reload the authoritative state; a sample overwrite cannot change its parent archive.')
      }
      const transitionErrors = workspaceLifecycleTransitionErrors(serverWorkspace, toSave)
      if (transitionErrors.length) {
        throw new CloudConflictError(`Keep mine cannot resurrect removed content or overwrite protected evidence. ${transitionErrors[0]} Reload the latest workspace before continuing.`)
      }
      const result = await saveWorkspaceState(workspaceId, toSave, fresh.etag)
      if (!aliveRef.current) return
      etagRef.current = result.etag
      if (pendingRef.current === toSave) {
        // No newer edit arrived while this was in flight.
        pendingRef.current = null
        setStatus({ state: 'saved', error: null, conflict: null })
      } else {
        // A newer edit landed while overwriting; let the normal save loop pick it up with the fresh etag.
        setStatus({ state: 'saving', error: null, conflict: null })
      }
    } catch (error) {
      if (aliveRef.current) saveFailure(error)
    } finally {
      resolvingRef.current = false
    }
    if (aliveRef.current && pendingRef.current && statusRef.current.state === 'saving') await runSaveLoop()
  }

  async function resumeAuthentication() {
    try {
      const refreshed = await fetchSession()
      if (!aliveRef.current) return
      if (refreshed.user.id !== user.id || refreshed.user.tenantId !== user.tenantId) {
        onAuthError("A different account signed in. The previous account's unsaved content was not uploaded; reopen the appropriate account's workspace.")
        return
      }
      setStatus({ state: 'saving', error: null, conflict: null })
      const result = await runSaveLoop()
      if (result.ok && !pendingRef.current) setStatus({ state: 'saved', error: null, conflict: null })
    } catch (error) {
      if (aliveRef.current) {
        const message = error instanceof CloudApiError ? error.message : 'Sign-in could not be confirmed. Keep this tab open and retry.'
        setStatus({ state: 'error', error: message, conflict: null, authenticationRequired: true })
      }
    }
  }

  if (phase.kind === 'loading') return <main className="recovery-page"><div className="panel recovery-card cloud-loading-card">
    <div className="loading-pulse cloud-loading-mark" aria-hidden="true" />
    <h1>Opening your workspace</h1>
    <p>Loading your saved jobs, resumes, rubrics, and analyses from the cloud.</p>
    {application && <Button onClick={() => void application.openWorkspaceHome().catch((caught) => setPhase({ kind: 'error', message: caught instanceof Error ? caught.message : 'Workspace home could not be opened.' }))}>All workspaces</Button>}
  </div></main>

  if (phase.kind === 'error') return <LifecycleDialogProvider><main className="recovery-page"><div className="panel recovery-card">
    <AlertTriangle size={32} /><h1>This workspace could not be opened</h1>
    <InlineError>{phase.message}</InlineError>
    <div className="flex flex-wrap gap-3"><Button variant="primary" icon={RotateCcw} onClick={() => window.location.reload()}>Try again</Button>
      {application && <Button onClick={() => void application.openWorkspaceHome().catch((caught) => setPhase({ kind: 'error', message: caught instanceof Error ? caught.message : 'Workspace home could not be opened.' }))}>All workspaces</Button>}</div>
    <p className="mt-4 text-[12px] text-muted">Choose another workspace, or open the workspace picker to retry an unfinished lifecycle operation. Missing content is never replaced with samples.</p>
    <WorkspaceSwitcher cloud={{ workspaces, currentWorkspaceId: workspaceId, switchWorkspace, createWorkspace, renameWorkspace, refreshWorkspaces, getWorkspaceLifecycleImpact, changeWorkspaceLifecycle }} />
  </div></main></LifecycleDialogProvider>

  async function signOut() {
    const result = await prepareToLeave()
    if (!result.ok) {
      if (result.reason === 'grade-protection') {
        engineRef.current?.notify('Sign-out cancelled. Grade edits and pending requests are kept in this workspace.')
        return
      }
      setStatus({ ...statusRef.current, state: 'error', error: `Sign-out was stopped so nothing is lost: ${result.message}` })
      return
    }
    onSignedOut()
  }

  const initialWorkspace = initialWorkspaceRef.current
  if (!initialWorkspace) throw new Error('The cloud workspace did not finish initialization.')
  return <CloudWorkspaceReady
    initialWorkspace={initialWorkspace}
    persist={enqueue}
    recoveredNotice={recoveredNotice}
    engineRef={engineRef} resumeAuthentication={resumeAuthentication}
    user={user} workspaces={workspaces} workspaceId={workspaceId} status={status} syncingState={syncingState} snapshotRevision={snapshotRevision}
    retrySave={() => { void runSaveLoop() }}
    reloadFromServer={reloadFromServer} keepMineAndOverwrite={keepMineAndOverwrite}
    switchWorkspace={switchWorkspace} createWorkspace={createWorkspace} renameWorkspace={renameWorkspace} signOut={signOut}
    flushSave={flushSave} refreshWorkspaces={refreshWorkspaces} getWorkspaceLifecycleImpact={getWorkspaceLifecycleImpact} changeWorkspaceLifecycle={changeWorkspaceLifecycle}
    leaveUnavailableWorkspace={leaveUnavailableWorkspace}
  >{children}</CloudWorkspaceReady>
}

function CloudWorkspaceReady({
  initialWorkspace, persist, recoveredNotice, user, workspaces, workspaceId, status, retrySave,
  reloadFromServer, keepMineAndOverwrite, switchWorkspace, createWorkspace, renameWorkspace, signOut, children, engineRef, resumeAuthentication,
  flushSave, refreshWorkspaces, getWorkspaceLifecycleImpact, changeWorkspaceLifecycle,
  syncingState,
  snapshotRevision, leaveUnavailableWorkspace,
}: {
  initialWorkspace: Workspace
  persist: (next: Workspace) => PersistenceResult
  engineRef: { current: WorkspaceEngine | null }
  resumeAuthentication: () => Promise<void>
  recoveredNotice: string | null
  user: CloudUser
  workspaces: WorkspaceSummary[]
  workspaceId: string
  status: SaveStatus
  retrySave: () => void
  reloadFromServer: () => Promise<void>
  keepMineAndOverwrite: () => Promise<void>
  switchWorkspace: (id: string) => Promise<Result>
  createWorkspace: (name: string) => Promise<Result>
  renameWorkspace: (id: string, name: string) => Promise<Result>
  signOut: () => Promise<void>
  children: CloudWorkspaceContent
  flushSave: CloudWorkspaceStatus['flushSave']
  refreshWorkspaces: CloudWorkspaceStatus['refreshWorkspaces']
  getWorkspaceLifecycleImpact: CloudWorkspaceStatus['getWorkspaceLifecycleImpact']
  changeWorkspaceLifecycle: CloudWorkspaceStatus['changeWorkspaceLifecycle']
  syncingState: boolean
  snapshotRevision: number
  leaveUnavailableWorkspace: CloudWorkspaceStatus['leaveUnavailableWorkspace']
}) {
  const engine = useWorkspaceEngine(initialWorkspace, persist)
  const pendingLifecycle = useRef(new Set<string>())
  useEffect(() => { pendingLifecycle.current.clear() }, [snapshotRevision])
  const metadata = workspaces.find((item) => item.id === workspaceId)
  const writable = Boolean(metadata && metadata.role !== 'viewer' && !metadata.archivedAt && !metadata.deletedAt && !syncingState && (!metadata.lifecycleOperation || metadata.lifecycleOperation.status === 'complete'))
  const access = useRef({ metadata, writable })
  access.current = { metadata, writable }
  useLayoutEffect(() => {
    engine.setExternalArchive(!writable)
  }, [engine, writable])
  useEffect(() => {
    engineRef.current = engine
    return () => { engineRef.current = null }
  })
  useEffect(() => {
    if (status.authenticationRequired) engineRef.current?.stopPendingOperations('Sign-in is required. Pending demo operations were paused without discarding completed results.')
  }, [status.authenticationRequired, engineRef])
  const notifiedRecovery = useRef(false)
  useEffect(() => {
    if (recoveredNotice && !notifiedRecovery.current) { notifiedRecovery.current = true; engine.notify(recoveredNotice) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveredNotice])

  if (status.authenticationRequired) return <main className="recovery-page"><div className="panel recovery-card">
    <ShieldCheck size={30} /><h1>Sign in again to save your changes</h1>
    <p>Your unsaved workspace is held in this tab, not discarded or written to browser storage. Keep this tab open while signing in with the same account.</p>
    {status.error && <InlineError>{status.error}</InlineError>}
    <div className="flex flex-wrap gap-3">
      <a className="button button-primary button-md" href={authLoginUrl(window.location.pathname + window.location.search)} target="_blank" rel="noopener noreferrer">Sign in in a new tab</a>
      <Button icon={RotateCcw} onClick={() => { void resumeAuthentication() }}>Retry after sign-in</Button>
    </div>
  </div></main>

  if (!engine.workspace) throw new Error('The cloud workspace engine has no document state.')
  const cloud: Omit<CloudWorkspaceStatus, 'realJobs'> = {
    user, workspaces, currentWorkspaceId: workspaceId,
    saveState: status.state, saveError: status.error, conflict: status.conflict, syncingState,
    retrySave, reloadFromServer, keepMineAndOverwrite, switchWorkspace, createWorkspace, renameWorkspace, signOut,
    flushSave, refreshWorkspaces, getWorkspaceLifecycleImpact, changeWorkspaceLifecycle,
    leaveUnavailableWorkspace,
  }
  function assertWritable() {
    if (!access.current.writable) throw new Error('This workspace is read-only. Unarchive it or ask an owner or editor to make changes.')
  }
  function assertLifecyclePermission(target: LifecycleTarget) {
    const current = access.current.metadata
    if (!current || current.deletedAt || current.role === 'viewer' || (target.kind === 'workspace' && current.role !== 'owner')) {
      throw new Error('Your role does not allow this lifecycle change.')
    }
  }
  const workspace: Workspace = {
    ...engine.workspace,
    lifecycle: { entities: engine.workspace.lifecycle?.entities ?? {}, ...engine.workspace.lifecycle, archivedAt: metadata?.archivedAt },
  }
  const value: Omit<WorkspaceContextValue, 'cloud'> = {
    workspace, storageError: null, notice: engine.notice, clearNotice: engine.clearNotice, notify: engine.notify,
    renameEntity: async (target, name) => {
      assertWritable()
      engine.renameEntity(target, name)
      await flushSave()
      engine.notify('Name saved. Source evidence and results are unchanged.')
    },
    addJobs: (...args) => { assertWritable(); return engine.addJobs(...args) },
    addResumes: (...args) => { assertWritable(); return engine.addResumes(...args) },
    cancelJob: (id) => { assertWritable(); return engine.cancelJob(id) },
    retryJob: (id) => { assertWritable(); return engine.retryJob(id) },
    saveRubric: (...args) => { assertWritable(); return engine.saveRubric(...args) },
    startAnalysis: (...args) => { assertWritable(); return engine.startAnalysis(...args) },
    cancelRun: (id) => { assertWritable(); return engine.cancelRun(id) },
    retryRun: (id) => { assertWritable(); return engine.retryRun(id) },
    resetDemo: () => { assertWritable(); engine.resetDemo() }, retrySave,
    getLifecycleImpact: (target) => target.kind === 'workspace' ? getWorkspaceLifecycleImpact(workspaceId) : engine.getLifecycleImpact(target),
    changeLifecycle: async (target, action) => {
      assertLifecyclePermission(target)
      if (target.kind === 'workspace') return changeWorkspaceLifecycle(workspaceId, action)
      const key = `${target.kind}:${target.id}:${action}`
      await flushSave()
      if (!pendingLifecycle.current.has(key)) {
        engine.changeLifecycle(target, action)
        pendingLifecycle.current.add(key)
        engine.clearNotice()
        await flushSave()
      }
      pendingLifecycle.current.delete(key)
      engine.notify(action === 'delete' ? 'Permanent deletion saved.' : action === 'archive' ? 'Archive saved. Owned unfinished work is cancelled.' : 'Unarchive saved. Cancelled work has not restarted.')
    },
  }
  return children(value, cloud)
}
