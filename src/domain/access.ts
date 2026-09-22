import type { WorkspaceRole } from './cloud'

export type ApplicationRole = 'Score.User' | 'Score.Admin'

export interface EligibleUser {
  id: string
  name: string
  email: string
  applicationRoles: ApplicationRole[]
}

export interface EligibleUserPage {
  users: EligibleUser[]
  continuation?: string
}

export interface CreationAccess {
  userId: string
  canCreateWorkspaces: boolean
  etag: string
}

export interface WorkspaceMember {
  id: string
  name: string
  email: string
  role: WorkspaceRole
}

export interface WorkspaceMembers {
  members: WorkspaceMember[]
  etag: string
}

export function workspaceRoleLabel(role: WorkspaceRole): string {
  return role === 'viewer' ? 'Reader' : role === 'editor' ? 'Editor' : 'Owner'
}
