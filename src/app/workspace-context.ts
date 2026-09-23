import { createContext, useContext } from 'react'
import type { Rubric, Workspace } from '../domain/types'
import type { CloudUser, WorkspaceSummary } from '../domain/cloud'
import type { JobProcessingFeatures, RealJobDetail, RealJobSource, RealJobSummary } from '../domain/real-jobs'
import type { RubricAssistRequest, RubricAssistResponse } from '../domain/rubric-assist'
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

export type RealJobDetailLoadState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; value: RealJobDetail }
  | { state: 'error'; error: string }

export interface CloudWorkspaceStatus {
  user: CloudUser
  /** Workspaces accessible through individual membership or application administration. */
  workspaces: WorkspaceSummary[]
  currentWorkspaceId: string
  canCreateWorkspaces: boolean
  switchWorkspace: (id: string) => Promise<{ ok: true } | { ok: false; message: string }>
  createWorkspace: (name: string) => Promise<{ ok: true } | { ok: false; message: string }>
  renameWorkspace: (id: string, name: string) => Promise<{ ok: true } | { ok: false; message: string }>
  refreshWorkspaces: () => Promise<void>
  getWorkspaceLifecycleImpact: (id: string) => Promise<LifecycleImpact>
  changeWorkspaceLifecycle: (id: string, action: LifecycleAction) => Promise<void>
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
    assistRubric: (jobId: string, request: RubricAssistRequest, signal?: AbortSignal) => Promise<RubricAssistResponse>
    originalUrl: (jobId: string) => string
  }
}

export interface WorkspaceContextValue {
  /** In-memory projection of the server-owned jobs, documents, rubrics, and lifecycle state. */
  workspace: Workspace
  notice: string | null
  clearNotice: () => void
  notify: (message: string) => void
  renameEntity: (target: RenameEntityTarget, displayName: string, etag?: string) => void | Promise<void>
  cancelJob: (id: string) => void | Promise<void>
  retryJob: (id: string) => void | Promise<void>
  saveRubric: (rubric: Rubric, duplicate?: boolean) => string | Promise<string>
  getLifecycleImpact: (target: LifecycleTarget) => LifecycleImpact | Promise<LifecycleImpact>
  changeLifecycle: (target: LifecycleTarget, action: LifecycleAction) => void | Promise<void>
  lifecycleOperations?: PendingLifecycleChange[]
  cloud: CloudWorkspaceStatus
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext)
  if (!context) throw new Error('The workspace is not available. Wrap this view in CloudWorkspaceProvider.')
  return context
}