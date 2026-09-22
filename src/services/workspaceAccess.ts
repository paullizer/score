import type { CreationAccess, EligibleUserPage, WorkspaceMembers } from '../domain/access'
import type { WorkspaceRole } from '../domain/cloud'
import { cloudJsonRequest, CloudApiError, CloudTimeoutError } from './cloudWorkspace'

function peopleQuery(query: string, continuation?: string): string {
  const parameters = new URLSearchParams()
  if (query.trim()) parameters.set('query', query.trim())
  if (continuation) parameters.set('continuation', continuation)
  const value = parameters.toString()
  return value ? `?${value}` : ''
}

export function listEligibleUsers(query: string, continuation?: string, signal?: AbortSignal): Promise<EligibleUserPage> {
  return cloudJsonRequest(`/admin/users${peopleQuery(query, continuation)}`, { signal })
}

export function getCreationAccess(userId: string, signal?: AbortSignal): Promise<CreationAccess> {
  return cloudJsonRequest(`/admin/users/${encodeURIComponent(userId)}/workspace-creation`, { signal })
}

export function setCreationAccess(userId: string, canCreateWorkspaces: boolean, etag: string): Promise<CreationAccess> {
  return cloudJsonRequest(`/admin/users/${encodeURIComponent(userId)}/workspace-creation`, {
    method: 'PUT', headers: { 'If-Match': etag }, body: JSON.stringify({ canCreateWorkspaces }),
  })
}

export function listShareCandidates(workspaceId: string, query: string, continuation?: string, signal?: AbortSignal): Promise<EligibleUserPage> {
  return cloudJsonRequest(`/workspaces/${encodeURIComponent(workspaceId)}/share-candidates${peopleQuery(query, continuation)}`, { signal })
}

export function getWorkspaceMembers(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceMembers> {
  return cloudJsonRequest(`/workspaces/${encodeURIComponent(workspaceId)}/members`, { signal })
}

export function setWorkspaceMember(workspaceId: string, userId: string, role: WorkspaceRole, etag: string): Promise<WorkspaceMembers> {
  return cloudJsonRequest(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, {
    method: 'PUT', headers: { 'If-Match': etag }, body: JSON.stringify({ role }),
  })
}

export function removeWorkspaceMember(workspaceId: string, userId: string, etag: string): Promise<WorkspaceMembers> {
  return cloudJsonRequest(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE', headers: { 'If-Match': etag },
  })
}

export function accessChangeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The access change was not acknowledged.'
  if (error instanceof CloudApiError && [409, 412, 428].includes(error.status)) {
    return `${message} Refresh current access and review it before explicitly retrying. Nothing was automatically resent.`
  }
  if (!(error instanceof CloudApiError) || error instanceof CloudTimeoutError || error.status >= 500 || error.status === 408) {
    return `${message} The change may already have been accepted. Refresh current access to check the saved result before making another change.`
  }
  return message
}
