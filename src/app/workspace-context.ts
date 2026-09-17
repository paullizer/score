import { createContext, useContext } from 'react'
import type { ImportCandidate, Rubric, SourceKind, Workspace } from '../domain/types'

export interface WorkspaceContextValue {
  workspace: Workspace
  storageError: string | null
  notice: string | null
  clearNotice: () => void
  notify: (message: string) => void
  addJobs: (items: ImportCandidate[], source: SourceKind, fail?: 'parsing' | 'rubric') => string[]
  addResumes: (items: ImportCandidate[]) => Promise<string[]>
  cancelJob: (id: string) => void
  retryJob: (id: string) => void
  saveRubric: (rubric: Rubric, duplicate?: boolean) => string
  startAnalysis: (resumeIds: string[], rubricIds: string[], name?: string, failFirst?: boolean) => string
  cancelRun: (id: string) => void
  retryRun: (id: string) => void
  resetDemo: () => void
  retrySave: () => void
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext)
  if (!context) throw new Error('The workspace is not available. Wrap this view in WorkspaceProvider.')
  return context
}
