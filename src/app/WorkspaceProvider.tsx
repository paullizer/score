import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { WorkspaceContext, type WorkspaceContextValue } from './workspace-context'
import type { Workspace } from '../domain/types'
import { useWorkspaceEngine, type PersistenceResult } from './useWorkspaceEngine'
import { loadWorkspace, saveWorkspace } from '../services/persistence'
import { Button, InlineError, Modal } from '../components/ui'

/**
 * Standalone local-demo workspace: fully synchronous browser-storage load/save, unchanged from the
 * original behaviour. The import/rubric/analysis simulations themselves live in useWorkspaceEngine,
 * shared with CloudWorkspaceProvider so cloud mode does not duplicate that logic.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [loaded] = useState(loadWorkspace)
  const [storageError, setStorageError] = useState(loaded.error)
  const mountedOnce = useRef(false)

  const persist = useCallback((next: Workspace): PersistenceResult => {
    try {
      saveWorkspace(next)
      setStorageError(null)
      return 'saved'
    } catch (error) {
      if (!(error instanceof Error)) throw error
      setStorageError(error instanceof DOMException
        ? 'Changes are not saved on this device. Browser storage may be unavailable or full. Free some space, then retry saving.'
        : `Changes are not saved on this device. ${error.message}`)
      console.warn('Score could not save the demo workspace.', error)
      return 'failed'
    }
  }, [])

  const engine = useWorkspaceEngine(loaded.workspace, persist)
  const [confirmRecovery, setConfirmRecovery] = useState(false)

  // Mirrors the original behaviour: immediately re-persist once on mount so a workspace that was
  // recovered from an interrupted session (see recoverInterrupted in services/persistence.ts) is
  // locked in on this device right away.
  useEffect(() => {
    if (mountedOnce.current) return
    mountedOnce.current = true
    if (engine.workspace) persist(engine.workspace)
  }, [engine.workspace, persist])

  if (!engine.workspace) return <main className="recovery-page"><div className="panel recovery-card">
    <AlertTriangle size={32} /><h1>Your demo needs attention</h1>
    <p>The saved workspace could not be opened. Your browser data has not been replaced.</p>
    <InlineError>{storageError}</InlineError>
    <div className="flex flex-wrap gap-3"><Button onClick={() => window.location.reload()}>Try again</Button>
      <Button variant="primary" icon={RotateCcw} onClick={() => setConfirmRecovery(true)}>Reset demo</Button></div>
    <Modal open={confirmRecovery} onOpenChange={setConfirmRecovery} title="Reset the saved demo?" description="This replaces only Score's demo records. Other browser data is untouched."
      footer={<><Button onClick={() => setConfirmRecovery(false)}>Keep data</Button><Button variant="danger" onClick={() => { engine.resetDemo(); setConfirmRecovery(false) }}>Reset demo</Button></>}>
      <p>Demo imports, rubric edits, and analysis history will be replaced with the original fictional workspace.</p>
    </Modal>
  </div></main>

  const value: WorkspaceContextValue = {
    workspace: engine.workspace, storageError, notice: engine.notice, clearNotice: engine.clearNotice, notify: engine.notify,
    renameEntity: engine.renameEntity,
    addJobs: engine.addJobs, addResumes: engine.addResumes, cancelJob: engine.cancelJob, retryJob: engine.retryJob,
    saveRubric: engine.saveRubric, startAnalysis: engine.startAnalysis, cancelRun: engine.cancelRun, retryRun: engine.retryRun,
    getLifecycleImpact: engine.getLifecycleImpact, changeLifecycle: engine.changeLifecycle,
    resetDemo: engine.resetDemo, retrySave: () => { engine.retryPersist() },
  }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
