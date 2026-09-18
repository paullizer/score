import type { Workspace } from './types'
import type { LifecycleOperation } from './lifecycle'

export interface CloudUser {
  id: string
  tenantId: string
  name: string
  email: string
}

export type WorkspaceRole = 'owner' | 'editor' | 'viewer'
export type WorkspaceKind = 'personal' | 'group'

export interface WorkspaceSummary {
  id: string
  name: string
  kind: WorkspaceKind
  role: WorkspaceRole
  createdAt: string
  updatedAt: string
  etag: string
  archivedAt?: string
  deletedAt?: string
  lifecycleOperation?: LifecycleOperation
}

export interface CloudSession {
  mode: 'cloud'
  user: CloudUser
  workspaces: WorkspaceSummary[]
}

export interface CloudWorkspaceSnapshot {
  workspace: Workspace
  etag: string
}

export interface CloudApiError {
  error: {
    code: 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'precondition_required' | 'invalid_request' | 'unavailable'
    message: string
  }
}
