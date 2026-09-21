import type { Workspace } from '../domain/types'
import type { CloudSession, CloudWorkspaceSnapshot, WorkspaceSummary } from '../domain/cloud'
import type { LifecycleAction, LifecycleImpact, LifecycleOperation } from '../domain/lifecycle'

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
  const headers = new Headers(init.headers)
  headers.set(SCORE_REQUEST_HEADER, 'workspace')
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const deadline = AbortSignal.timeout(30000)
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
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
    if (init.signal?.aborted && signal.reason === init.signal.reason) throw init.signal.reason
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
 * The only two things Score ever keeps in localStorage for cloud mode: the appearance theme (shared,
 * already handled by ThemeControl) and the last-selected workspace id, namespaced per tenant/user so
 * signing in as someone else never leaks or reuses a previous person's workspace choice.
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
