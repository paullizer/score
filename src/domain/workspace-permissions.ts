import type { WorkspaceRole, WorkspaceSummary } from './cloud'

export function isWorkspaceRole(role: unknown): role is WorkspaceRole {
  return role === 'owner' || role === 'editor' || role === 'reviewer' || role === 'viewer'
}

export function workspaceCanEdit(role: WorkspaceRole | undefined): boolean {
  return role === 'owner' || role === 'editor'
}

export function workspaceQcRole(workspace: Pick<WorkspaceSummary, 'role' | 'accessSource' | 'membershipRole'> | undefined): WorkspaceRole | undefined {
  return workspace?.accessSource === 'application-admin' ? workspace.membershipRole : workspace?.role
}

export function workspaceCanReview(role: WorkspaceRole | undefined, applicationAdmin = false): boolean {
  return isWorkspaceRole(role) && (workspaceCanEdit(role) || role === 'reviewer' || applicationAdmin)
}

export function workspaceCanCoordinateQc(role: WorkspaceRole | undefined, applicationAdmin = false): boolean {
  return isWorkspaceRole(role) && (workspaceCanEdit(role) || applicationAdmin)
}
