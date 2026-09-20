import { createContext, useContext } from 'react'
import type { ImportCandidate, Rubric, SourceKind, Workspace } from '../domain/types'
import type { CloudUser, WorkspaceSummary } from '../domain/cloud'
import type { JobProcessingFeatures, RealJobDetail, RealJobSource, RealJobSummary } from '../domain/real-jobs'
import type { LifecycleAction, LifecycleImpact, LifecycleOperation, LifecycleTarget } from '../domain/lifecycle'

export interface PendingLifecycleChange {
  target: LifecycleTarget
  name: string
  operation: LifecycleOperation
}

export interface RenameEntityTarget {
  kind: 'analysis' | 'job' | 'resume'
  id: string
}

/** Cloud-only save status for the currently open workspace's document state. */
export type CloudSaveState = 'saving' | 'saved' | 'error' | 'conflict'
export type RealJobDetailLoadState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; value: RealJobDetail }
  | { state: 'error'; error: string }

export interface CloudWorkspaceStatus {
  user: CloudUser
  /** Personal workspaces this user can switch between (group workspaces are not supported yet). */
  workspaces: WorkspaceSummary[]
  currentWorkspaceId: string
  saveState: CloudSaveState
  syncingState?: boolean
  /** Present when saveState is 'error': a human explanation for the retry banner. */
  saveError: string | null
  /** Present when saveState is 'conflict': another session already saved a newer version. */
  conflict: { detectedAt: string } | null
  retrySave: () => void
  reloadFromServer: () => Promise<void>
  keepMineAndOverwrite: () => Promise<void>
  switchWorkspace: (id: string) => Promise<{ ok: true } | { ok: false; message: string }>
  createWorkspace: (name: string) => Promise<{ ok: true } | { ok: false; message: string }>
  renameWorkspace: (id: string, name: string) => Promise<{ ok: true } | { ok: false; message: string }>
  refreshWorkspaces: () => Promise<void>
  getWorkspaceLifecycleImpact: (id: string) => Promise<LifecycleImpact>
  changeWorkspaceLifecycle: (id: string, action: LifecycleAction) => Promise<void>
  flushSave: () => Promise<void>
  leaveUnavailableWorkspace: () => Promise<{ ok: true } | { ok: false; message: string }>
  signOut: () => Promise<void>
  realJobs: {
    phase: 'loading' | 'ready' | 'unavailable' | 'error'
    features: JobProcessingFeatures | null
    summaries: RealJobSummary[]
    error: string | null
    detail: (jobId: string) => RealJobDetailLoadState
    source: (jobId: string) => RealJobSource | undefined
    ensureDetail: (jobId: string, force?: boolean) => Promise<void>
    refresh: () => Promise<void>
    importPdf: (file: File, idempotencyKey: string, batchId?: string) => Promise<RealJobSummary>
    importMarkdown: (file: File, idempotencyKey: string, batchId?: string) => Promise<RealJobSummary>
    importFile: (file: File, idempotencyKey: string, batchId?: string) => Promise<RealJobSummary>
    importUrl: (url: string, idempotencyKey: string, batchId?: string) => Promise<RealJobSummary>
    originalUrl: (jobId: string) => string
  }
}

export interface WorkspaceContextValue {
  workspace: Workspace
  storageError: string | null
  notice: string | null
  clearNotice: () => void
  notify: (message: string) => void
  renameEntity: (target: RenameEntityTarget, displayName: string, etag?: string) => void | Promise<void>
  addJobs: (items: ImportCandidate[], source: SourceKind, fail?: 'parsing' | 'rubric') => string[]
  addResumes: (items: ImportCandidate[]) => Promise<string[]>
  cancelJob: (id: string) => void | Promise<void>
  retryJob: (id: string) => void | Promise<void>
  saveRubric: (rubric: Rubric, duplicate?: boolean) => string | Promise<string>
  startAnalysis: (resumeIds: string[], rubricIds: string[], name?: string, failFirst?: boolean) => string
  cancelRun: (id: string) => void
  retryRun: (id: string) => void
  resetDemo: () => void
  retrySave: () => void
  getLifecycleImpact: (target: LifecycleTarget) => LifecycleImpact | Promise<LifecycleImpact>
  changeLifecycle: (target: LifecycleTarget, action: LifecycleAction) => void | Promise<void>
  lifecycleOperations?: PendingLifecycleChange[]
  /** Present only in cloud mode; undefined in the local browser demo. */
  cloud?: CloudWorkspaceStatus
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext)
  if (!context) throw new Error('The workspace is not available. Wrap this view in WorkspaceProvider.')
  return context
}
