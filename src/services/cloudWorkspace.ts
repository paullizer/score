import type { Workspace } from '../domain/types'
import type { CloudSession, CloudSessionIdentity, CloudWorkspaceSnapshot, WorkspaceReviewerAccess, WorkspaceSummary } from '../domain/cloud'
import type { LifecycleAction, LifecycleImpact, LifecycleOperation } from '../domain/lifecycle'
import { workspaceCanEdit, workspaceCanReview, workspaceQcRole } from '../domain/workspace-permissions'

/**
 * True when this build is deployed against the real Azure-hosted API (Docker/production build sets
 * VITE_DEPLOYMENT_MODE=cloud). Undefined/any other value keeps the original standalone local demo.
 */
export const CLOUD_MODE = import.meta.env.VITE_DEPLOYMENT_MODE === 'cloud'

export type CloudErrorCode =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'precondition_required' | 'invalid_request' | 'unavailable'

/** Base error for any failed cloud API call. `status` is the HTTP status code when known. */
export class CloudApiError extends Error {
  readonly code: CloudErrorCode
  readonly status: number
  constructor(code: CloudErrorCode, message: string, status: number) {
    super(message)
    this.name = 'CloudApiError'
    this.code = code
    this.status = status
  }
}

/**
 * Thrown whenever a response indicates the user must (re)authenticate: an explicit 401/403, a
 * redirect back to a sign-in page, or a non-JSON (typically HTML) body where an API response was
 * expected. Callers must treat this as a hard sign-in/access failure and never fall back to fixtures.
 */
export class CloudAuthError extends CloudApiError {
  constructor(message: string, code: 'unauthorized' | 'forbidden' = 'unauthorized') {
    super(code, message, code === 'forbidden' ? 403 : 401)
    this.name = 'CloudAuthError'
  }
}

/** A PUT/PATCH was rejected because the resource changed since the etag we sent (HTTP 409). */
export class CloudConflictError extends CloudApiError {
  constructor(message: string) {
    super('conflict', message, 409)
    this.name = 'CloudConflictError'
  }
}

/** A mutating request was missing its required If-Match etag (HTTP 428). */
export class CloudPreconditionError extends CloudApiError {
  constructor(message: string) {
    super('precondition_required', message, 428)
    this.name = 'CloudPreconditionError'
  }
}

export class CloudTimeoutError extends CloudApiError {
  readonly acknowledgementUnknown: boolean
  constructor(mutating: boolean) {
    super('unavailable', mutating
      ? 'The request timed out after 30 seconds before Score received an acknowledgement. The change may still have been accepted. Refresh its status before explicitly retrying the same action; do not assume it was saved.'
      : 'The request timed out after 30 seconds. Try again to load the saved data. This read did not change your saved scores or evidence.', 408)
    this.name = 'CloudTimeoutError'
    this.acknowledgementUnknown = mutating
  }
}

export class CloudAccessChangedError extends CloudApiError {
  constructor() {
    super('forbidden', 'Workspace access changed while this request was in progress. Its result was not applied to this tab. A submitted change may already have been accepted; refresh saved access and content before explicitly retrying.', 403)
    this.name = 'CloudAccessChangedError'
  }
}

export const CLOUD_ACCESS_REFRESH_EVENT = 'score-cloud-access-refresh'

export function workspaceAccessStamp(workspace?: WorkspaceSummary): string {
  return JSON.stringify([workspace?.id, workspace?.role, workspace?.accessSource, workspace?.membershipRole, workspace?.archivedAt, workspace?.deletedAt, workspace?.lifecycleOperation])
}

type AccessEntry = { workspace: WorkspaceSummary; stamp: string; controller: AbortController }
let sessionAccess: { identity: string; applicationAdmin: boolean; canCreateWorkspaces: boolean } | null = null
let capabilityController = new AbortController()
let workspaceAccess = new Map<string, AccessEntry>()
const accessRefreshRequired = new Set<string>()

/** Installed only by the authenticated app. Local samples and isolated service consumers are unchanged. */
export function setCloudSessionAccess(session: CloudSession | null): void {
  const identity = session ? JSON.stringify([session.user.tenantId, session.user.id]) : ''
  const sameIdentity = sessionAccess?.identity === identity
  if (!sameIdentity || sessionAccess?.applicationAdmin !== (session?.capabilities?.applicationAdmin === true) ||
    sessionAccess?.canCreateWorkspaces !== (session?.capabilities?.canCreateWorkspaces === true)) {
    capabilityController.abort(new CloudAccessChangedError())
    capabilityController = new AbortController()
  }
  const next = new Map<string, AccessEntry>()
  for (const workspace of session?.workspaces ?? []) {
    if (workspace.deletedAt) continue
    const existing = sameIdentity ? workspaceAccess.get(workspace.id) : undefined
    const stamp = workspaceAccessStamp(workspace)
    next.set(workspace.id, existing?.stamp === stamp ? existing : { workspace, stamp, controller: new AbortController() })
  }
  for (const [id, entry] of workspaceAccess) {
    if (next.get(id) !== entry) entry.controller.abort(new CloudAccessChangedError())
  }
  workspaceAccess = next
  accessRefreshRequired.clear()
  sessionAccess = session ? {
    identity, applicationAdmin: session.capabilities?.applicationAdmin === true,
    canCreateWorkspaces: session.capabilities?.canCreateWorkspaces === true,
  } : null
}

export function cloudAccessRequestSignal(path: string, init: RequestInit = {}): AbortSignal | undefined {
  if (!sessionAccess) return
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())
  if (path.startsWith('/admin/') && !sessionAccess.applicationAdmin) throw new CloudApiError('forbidden', 'Application administrator access is required. Workspace ownership does not grant application administration.', 403)
  if (path === '/workspaces' && mutating && !sessionAccess.canCreateWorkspaces) throw new CloudApiError('forbidden', 'An application administrator must grant you permission to create workspaces. Existing workspace access is unchanged.', 403)
  if (path.startsWith('/admin/') || (path === '/workspaces' && mutating)) return capabilityController.signal
  const match = /^\/workspaces\/([^/?]+)(\/[^?]*)?(?:\?|$)/.exec(path)
  if (!match) return
  const id = decodeURIComponent(match[1])
  const entry = workspaceAccess.get(id)
  if (!entry) throw new CloudApiError('not_found', 'This workspace is no longer available to your account. Refresh access or contact a workspace owner or application administrator.', 404)
  const qc = /^\/qc(?:\/|$)/.test(match[2] ?? '')
  if (qc && !workspaceCanReview(workspaceQcRole(entry.workspace), sessionAccess.applicationAdmin)) {
    throw new CloudApiError('forbidden', 'QC requires an explicit workspace membership and a reviewer, editor, owner, or application-admin role.', 403)
  }
  if (/^\/reviewers(?:\/|$)/.test(match[2] ?? '') && workspaceQcRole(entry.workspace) !== 'owner') {
    throw new CloudApiError('forbidden', 'Only an explicit workspace Owner can use reviewer-only access management.', 403)
  }
  const ownerOnly = /^\/(?:members|share-candidates)(?:\/|$)/.test(match[2] ?? '') ||
    (mutating && (!match[2] || match[2] === '/lifecycle'))
  if (ownerOnly && entry.workspace.role !== 'owner') throw new CloudApiError('forbidden', 'Only a workspace Owner or application administrator can manage workspace access and lifecycle.', 403)
  if (mutating && ((!qc && !workspaceCanEdit(entry.workspace.role)) || accessRefreshRequired.has(id))) {
    throw new CloudApiError('forbidden', 'Workspace changes are paused. Reader and Reviewer access cannot save ordinary edits; refresh current access before continuing. Unsaved drafts remain in this tab.', 403)
  }
  return entry.controller.signal
}

export function reportCloudAccessFailure(path: string, error: unknown) {
  if (!sessionAccess || !(error instanceof CloudApiError) || error instanceof CloudAccessChangedError || ![401, 403, 404].includes(error.status)) return
  const match = /^\/workspaces\/([^/?]+)/.exec(path)
  if (!match && !(path.startsWith('/admin/') && error.status !== 404)) return
  if (match && error.status !== 404) accessRefreshRequired.add(decodeURIComponent(match[1]))
  if (typeof window !== 'undefined') window.dispatchEvent(new window.Event(CLOUD_ACCESS_REFRESH_EVENT))
}

export class LifecycleOperationError extends Error {
  readonly operation: LifecycleOperation
  constructor(operation: LifecycleOperation) {
    super(operation.error ?? (operation.status === 'failed'
      ? 'The lifecycle operation did not finish. Retry to resume it; completed cleanup will not be repeated.'
      : 'The lifecycle operation is still in progress. Refresh its status or retry to resume; it is not complete yet.'))
    this.name = 'LifecycleOperationError'
    this.operation = operation
  }
}

export interface WorkspaceLifecycleResponse {
  workspace?: WorkspaceSummary
  deleted?: true
  operation?: LifecycleOperation
}

export async function getWorkspaceLifecycleImpact(id: string, signal?: AbortSignal): Promise<LifecycleImpact> {
  const result = await cloudJsonRequest<{ impact: LifecycleImpact }>(`/workspaces/${encodeURIComponent(id)}/lifecycle`, { signal })
  return result.impact
}

export function changeWorkspaceLifecycle(id: string, action: LifecycleAction, etag: string): Promise<WorkspaceLifecycleResponse> {
  return cloudLifecycleRequest<WorkspaceLifecycleResponse>(`/workspaces/${encodeURIComponent(id)}/lifecycle`, {
    method: 'POST', headers: { 'If-Match': etag }, body: JSON.stringify({ action }),
  }).then((result) => result.value)
}

const SCORE_REQUEST_HEADER = 'X-Score-Request'

function isCloudErrorCode(value: unknown): value is CloudErrorCode {
  return typeof value === 'string' && ['unauthorized', 'forbidden', 'not_found', 'conflict', 'precondition_required', 'invalid_request', 'unavailable'].includes(value)
}

async function readErrorEnvelope(response: Response): Promise<{ code: CloudErrorCode; message: string } | null> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) return null
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error
      if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
        const code = error.code
        const message = error.message
        if (isCloudErrorCode(code) && typeof message === 'string') return { code, message }
      }
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  return null
}

async function unwrap<T>(response: Response): Promise<T> {
  // A same-origin fetch that was redirected (e.g. Easy Auth bouncing to a login page) is always a
  // sign-in failure here, never data we can use.
  if (response.redirected || response.type === 'opaqueredirect') {
    throw new CloudAuthError('Your Score session ended and the request was redirected to sign-in. Sign in again to continue.')
  }
  if (response.status === 401) {
    const envelope = await readErrorEnvelope(response)
    throw new CloudAuthError(envelope?.message ?? 'Sign in to use Score in the cloud.')
  }
  if (response.status === 403) {
    const envelope = await readErrorEnvelope(response)
    if (envelope) throw new CloudApiError(envelope.code, envelope.message, 403)
    throw new CloudAuthError('Your account does not have access to this workspace.', 'forbidden')
  }
  if (!response.ok) {
    const envelope = await readErrorEnvelope(response)
    if (!envelope) {
      throw new CloudApiError('unavailable', `The cloud service returned HTTP ${response.status} instead of API data. Your changes have not been acknowledged; retry when the service is available.`, response.status)
    }
    if (response.status === 409) throw new CloudConflictError(envelope.message)
    if (response.status === 428) throw new CloudPreconditionError(envelope.message)
    throw new CloudApiError(envelope.code, envelope.message, response.status)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new CloudAuthError('Score received an unexpected non-API response. Sign in again, or try again shortly.')
  }
  return response.json() as Promise<T>
}

async function cloudRequest<T>(path: string, init: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
  const accessSignal = cloudAccessRequestSignal(path, init)
  const headers = new Headers(init.headers)
  headers.set(SCORE_REQUEST_HEADER, 'workspace')
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const deadline = AbortSignal.timeout(30000)
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), ...(accessSignal ? [accessSignal] : []), deadline])
  try {
    signal.throwIfAborted()
    const response = await fetch(`/api${path}`, {
      ...init, signal, redirect: 'manual', credentials: 'include', cache: 'no-store', headers,
    })
    const value = await read(response)
    signal.throwIfAborted()
    return value
  } catch (caught) {
    // Body streams may reject with AbortError even when the deadline's reason is TimeoutError.
    const reason: unknown = signal.aborted ? signal.reason : caught
    if (reason instanceof Error && reason.name === 'TimeoutError') {
      throw new CloudTimeoutError(!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase()))
    }
    if (accessSignal?.aborted) throw accessSignal.reason
    if (init.signal?.aborted && signal.reason === init.signal.reason) throw init.signal.reason
    reportCloudAccessFailure(path, caught)
    throw caught
  }
}

export function cloudJsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return cloudRequest(path, init, unwrap<T>)
}

export function cloudJsonResponse<T>(path: string, init: RequestInit = {}): Promise<{ value: T; etag?: string }> {
  return cloudRequest(path, init, async (response) => ({
    value: await unwrap<T>(response), etag: response.headers.get('ETag') ?? undefined,
  }))
}

export function cloudLifecycleRequest<T>(path: string, init: RequestInit = {}): Promise<{ value: T; etag?: string }> {
  return cloudRequest(path, init, async (response) => {
    const etag = response.headers.get('ETag') ?? undefined
    if (response.status === 503 && !response.redirected && response.type !== 'opaqueredirect' && response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      const body: unknown = await response.clone().json().catch((error: unknown) => {
        if (!(error instanceof SyntaxError)) throw error
        return null
      })
      if (body && typeof body === 'object' && 'operation' in body) {
        const operation = body.operation
        if (operation && typeof operation === 'object' && 'status' in operation && operation.status === 'failed' && 'id' in operation && typeof operation.id === 'string' &&
          'action' in operation && ['archive', 'unarchive', 'delete'].includes(String(operation.action))) {
          return { value: body as T, etag }
        }
      }
    }
    const value = await unwrap<T>(response)
    if (response.status === 202) {
      const operation = value && typeof value === 'object' && 'operation' in value ? value.operation : undefined
      const pending = value && typeof value === 'object' && 'pending' in value && value.pending === true
      if (!pending && (!operation || typeof operation !== 'object' || !('status' in operation) || !['pending', 'running', 'failed'].includes(String(operation.status)))) {
        throw new CloudApiError('unavailable', 'The service has not acknowledged a completed lifecycle change or returned a recoverable operation. Refresh status before retrying.', 202)
      }
    }
    return { value, etag }
  })
}

export async function fetchSession(signal?: AbortSignal): Promise<CloudSession> {
  return cloudJsonRequest<CloudSession>('/session', { method: 'GET', signal })
}

export function fetchSessionIdentity(signal?: AbortSignal): Promise<CloudSessionIdentity> {
  return cloudJsonRequest<CloudSessionIdentity>('/session/identity', { method: 'GET', signal })
}

export async function listWorkspaces(signal?: AbortSignal): Promise<WorkspaceSummary[]> {
  const body = await cloudJsonRequest<{ workspaces: WorkspaceSummary[] }>('/workspaces', { method: 'GET', signal })
  return body.workspaces
}

export async function createWorkspace(name: string, signal?: AbortSignal): Promise<WorkspaceSummary> {
  const body = await cloudJsonRequest<{ workspace: WorkspaceSummary }>('/workspaces', {
    method: 'POST', body: JSON.stringify({ name }), signal,
  })
  return body.workspace
}

export async function renameWorkspace(id: string, name: string, etag: string, signal?: AbortSignal): Promise<WorkspaceSummary> {
  const headers = new Headers({ 'If-Match': etag })
  const body = await cloudJsonRequest<{ workspace: WorkspaceSummary }>(`/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ name }), headers, signal,
  })
  return body.workspace
}

export function listWorkspaceReviewers(id: string, signal?: AbortSignal): Promise<WorkspaceReviewerAccess> {
  return cloudJsonRequest(`/workspaces/${encodeURIComponent(id)}/reviewers`, { signal })
}

export function addWorkspaceReviewer(
  id: string, reviewer: { objectId: string; label?: string }, etag: string, signal?: AbortSignal,
): Promise<WorkspaceReviewerAccess> {
  return cloudJsonRequest(`/workspaces/${encodeURIComponent(id)}/reviewers`, {
    method: 'POST', body: JSON.stringify(reviewer), headers: { 'If-Match': etag }, signal,
  })
}

export function removeWorkspaceReviewer(id: string, objectId: string, etag: string, signal?: AbortSignal): Promise<WorkspaceReviewerAccess> {
  return cloudJsonRequest(`/workspaces/${encodeURIComponent(id)}/reviewers/${encodeURIComponent(objectId)}`, {
    method: 'DELETE', headers: { 'If-Match': etag }, signal,
  })
}

export async function loadWorkspaceState(id: string, signal?: AbortSignal): Promise<CloudWorkspaceSnapshot> {
  return cloudJsonRequest<CloudWorkspaceSnapshot>(`/workspaces/${encodeURIComponent(id)}/state`, { method: 'GET', signal })
}

export async function saveWorkspaceState(id: string, workspace: Workspace, etag: string, signal?: AbortSignal): Promise<{ etag: string }> {
  const headers = new Headers({ 'If-Match': etag })
  return cloudJsonRequest<{ etag: string }>(`/workspaces/${encodeURIComponent(id)}/state`, {
    method: 'PUT', body: JSON.stringify(workspace), headers, signal,
  })
}

/** Restricts a redirect target to a safe same-origin absolute path (never an external or protocol-relative URL). */
export function safeSameOriginPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/'
  return path
}

export function authLoginUrl(redirectPath: string): string {
  return `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(safeSameOriginPath(redirectPath))}`
}

export function authLogoutUrl(redirectPath: string): string {
  return `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(safeSameOriginPath(redirectPath))}`
}

export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.length < 1) return 'Enter a workspace name.'
  if (trimmed.length > 80) return 'Workspace names must be 80 characters or fewer.'
  return null
}

/**
 * Legacy selection preference, read only as an untimed seed for workspaceRecents.
 * Cloud preferences contain appearance and account-scoped workspace IDs/times, never document state.
 */
function lastWorkspaceKey(tenantId: string, userId: string): string {
  return `score-cloud-last-workspace:${tenantId}:${userId}`
}

export function readLastWorkspaceId(tenantId: string, userId: string): string | null {
  try {
    return localStorage.getItem(lastWorkspaceKey(tenantId, userId))
  } catch (error) {
    if (!(error instanceof DOMException)) throw error
    console.warn('Score could not read the last-selected workspace preference.', error.name)
    return null
  }
}

export function writeLastWorkspaceId(tenantId: string, userId: string, workspaceId: string): void {
  try {
    localStorage.setItem(lastWorkspaceKey(tenantId, userId), workspaceId)
  } catch (error) {
    if (!(error instanceof DOMException)) throw error
    console.warn('Score could not remember the workspace selection. Cloud content is unaffected.', error.name)
  }
}

export function clearLastWorkspaceId(tenantId: string, userId: string): void {
  try { localStorage.removeItem(lastWorkspaceKey(tenantId, userId)) } catch (error) {
    if (!(error instanceof DOMException)) throw error
  }
}
