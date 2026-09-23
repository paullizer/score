import type { Workspace } from './types'
import type { LifecycleOperation } from './lifecycle'

export interface CloudUser {
  id: string
  tenantId: string
  name: string
  email: string
}

export type WorkspaceRole = 'owner' | 'editor' | 'reviewer' | 'viewer'
export type WorkspaceKind = 'personal' | 'group'

export interface WorkspaceReviewer {
  objectId: string
  role: 'reviewer'
  /** An owner-supplied display label, never an identity or authorization claim. */
  label?: string
}

export interface WorkspaceReviewerAccess {
  workspaceId: string
  tenantId: string
  /** The directory ETag fences the entire membership list and workspace lifecycle. */
  etag: string
  reviewers: WorkspaceReviewer[]
}

export interface WorkspaceSummary {
  id: string
  name: string
  kind: WorkspaceKind
  role: WorkspaceRole
  accessSource?: 'membership' | 'application-admin'
  /** Explicit membership for administrators whose ordinary access is tenant-wide. */
  membershipRole?: WorkspaceRole
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
  capabilities?: CloudCapabilities
}

export interface CloudCapabilities {
  applicationAdmin: boolean
  canCreateWorkspaces: boolean
}

export interface CloudSessionIdentity {
  mode: 'cloud'
  user: CloudUser
  capabilities: CloudCapabilities
}

export interface CloudWorkspaceSnapshot {
  workspace: Workspace
  etag: string
}

export interface CloudApiError {
  error: {
    code: 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'precondition_required' | 'invalid_request' | 'unavailable'
    message: string
    fields?: { path: string; message: string }[]
  }
}
