import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw, ShieldCheck } from 'lucide-react'
import { type CloudSaveState, type CloudWorkspaceStatus, type WorkspaceContextValue } from './workspace-context'
import { useWorkspaceEngine, type PersistenceResult, type WorkspaceEngine } from './useWorkspaceEngine'
import type { Workspace } from '../domain/types'
import type { CloudUser, WorkspaceSummary } from '../domain/cloud'
import { authLoginUrl, CloudApiError, CloudAuthError, CloudConflictError, fetchSession, loadWorkspaceState, saveWorkspaceState } from '../services/cloudWorkspace'
import { recoverInterrupted, validateWorkspace, WorkspaceValidationError } from '../domain/workspace-validation'
import { Button, InlineError } from '../components/ui'
import type { GradeLeaveProtectionApi } from './grade-navigation-context'

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
}) {
  const [phase, setPhase] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' }>({ kind: 'loading' })
  const [generation, setGeneration] = useState(0)
  const [recoveredNotice, setRecoveredNotice] = useState<string | null>(null)
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

  function setStatus(next: SaveStatus) {
    statusRef.current = next
    setStatusState(next)
  }

  function clearDebounce() {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = null
  }

  function saveFailure(error: unknown): Result {
    clearDebounce()
    if (error instanceof CloudConflictError) {
      setStatus({ state: 'conflict', error: null, conflict: { detectedAt: new Date().toISOString() } })
      return { ok: false, message: 'Another session already saved a newer version of this workspace.' }
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
    loadWorkspaceState(workspaceId, controller.signal).then((snapshot) => {
      if (!aliveRef.current || controller.signal.aborted) return
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
        if (!pendingRef.current && !resolvingRef.current) setStatus({ state: 'saved', error: null, conflict: null })
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
    clearDebounce()
    const blocked = blockedSave()
    if (blocked) return blocked
    if (pendingRef.current || savingRef.current) return runSaveLoop()
    if (statusRef.current.state === 'error') return { ok: false, message: statusRef.current.error ?? 'This workspace has unsaved changes that could not be saved.' }
    return { ok: true }
  }

  async function prepareToLeave(): Promise<Result> {
    if (leaveProtectionRef?.current && !await leaveProtectionRef.current.confirmLeave()) {
      return { ok: false, reason: 'grade-protection', message: 'Leaving was stopped to preserve unsaved grade changes or an in-flight grade request.' }
    }
    engineRef.current?.stopPendingOperations('This browser paused the demo operations while leaving the workspace. Completed results are kept; retry unfinished items later.')
    return flush()
  }

  useEffect(() => {
    apiRef.current = { flush, prepareToLeave }
    return () => { apiRef.current = null }
  })

  async function reloadFromServer() {
    if (resolvingRef.current) return
    resolvingRef.current = true
    clearDebounce()
    engineRef.current?.stopPendingOperations('Demo operations paused while resolving a cloud save conflict.')
    while (savingRef.current) await sleep(50)
    try {
      const snapshot = await loadWorkspaceState(workspaceId)
      if (!aliveRef.current) return
      const validated = recoverInterrupted(validateWorkspace(snapshot.workspace))
      etagRef.current = snapshot.etag
      initialWorkspaceRef.current = validated
      pendingRef.current = null
      setStatus({ state: 'saved', error: null, conflict: null })
      setGeneration((value) => value + 1) // remount the engine with the freshly loaded content
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
      const fresh = await loadWorkspaceState(workspaceId) // only to obtain a current, valid etag
      if (!aliveRef.current) return
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
  </div></main>

  if (phase.kind === 'error') return <main className="recovery-page"><div className="panel recovery-card">
    <AlertTriangle size={32} /><h1>This workspace could not be opened</h1>
    <InlineError>{phase.message}</InlineError>
    <div className="flex flex-wrap gap-3"><Button variant="primary" icon={RotateCcw} onClick={() => window.location.reload()}>Try again</Button></div>
  </div></main>

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
    key={generation}
    initialWorkspace={initialWorkspace}
    persist={enqueue}
    recoveredNotice={recoveredNotice}
    engineRef={engineRef} resumeAuthentication={resumeAuthentication}
    user={user} workspaces={workspaces} workspaceId={workspaceId} status={status}
    retrySave={() => { void runSaveLoop() }}
    reloadFromServer={reloadFromServer} keepMineAndOverwrite={keepMineAndOverwrite}
    switchWorkspace={switchWorkspace} createWorkspace={createWorkspace} renameWorkspace={renameWorkspace} signOut={signOut}
  >{children}</CloudWorkspaceReady>
}

function CloudWorkspaceReady({
  initialWorkspace, persist, recoveredNotice, user, workspaces, workspaceId, status, retrySave,
  reloadFromServer, keepMineAndOverwrite, switchWorkspace, createWorkspace, renameWorkspace, signOut, children, engineRef, resumeAuthentication,
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
}) {
  const engine = useWorkspaceEngine(initialWorkspace, persist)
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
    saveState: status.state, saveError: status.error, conflict: status.conflict,
    retrySave, reloadFromServer, keepMineAndOverwrite, switchWorkspace, createWorkspace, renameWorkspace, signOut,
  }
  const value: Omit<WorkspaceContextValue, 'cloud'> = {
    workspace: engine.workspace, storageError: null, notice: engine.notice, clearNotice: engine.clearNotice, notify: engine.notify,
    addJobs: engine.addJobs, addResumes: engine.addResumes, cancelJob: engine.cancelJob, retryJob: engine.retryJob,
    saveRubric: engine.saveRubric, startAnalysis: engine.startAnalysis, cancelRun: engine.cancelRun, retryRun: engine.retryRun,
    resetDemo: engine.resetDemo, retrySave,
  }
  return children(value, cloud)
}
