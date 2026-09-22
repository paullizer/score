import type {
  AdminSettings, AdminSettingsPatch, AdminSettingsResponse, DeploymentInventory, ModelConfigurationTestRequest, ModelTaskId, ModelTestResult,
  SettingsExport, SettingsFieldError, SettingsHistoryResponse, SettingsImportPreview, SettingsRevision,
} from '../domain/admin-settings'
import { cloudAccessRequestSignal, CloudApiError, CloudAuthError, reportCloudAccessFailure } from './cloudWorkspace'

export class SettingsRequestError extends CloudApiError {
  readonly fields: SettingsFieldError[]
  constructor(status: number, message: string, fields: SettingsFieldError[] = []) {
    super(status === 409 || status === 412 ? 'conflict' : status === 403 ? 'forbidden' : status === 400 || status === 422 ? 'invalid_request' : 'unavailable', message, status)
    this.name = 'SettingsRequestError'
    this.fields = fields
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const accessSignal = cloudAccessRequestSignal(path, init)
  const headers = new Headers(init.headers)
  headers.set('X-Score-Request', 'workspace')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), ...(accessSignal ? [accessSignal] : []), AbortSignal.timeout(90_000)])
  try {
    signal.throwIfAborted()
    const response = await fetch(`/api${path}`, {
      ...init, headers, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'manual', signal,
    })
    if (response.redirected || response.type === 'opaqueredirect' || response.status === 401) throw new CloudAuthError('Sign in again to manage application settings. Your draft has not been discarded.')
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new SettingsRequestError(response.status, 'The settings service did not return API data. No changes have been acknowledged.')
    const body = await response.json()
    signal.throwIfAborted()
    if (!response.ok) throw new SettingsRequestError(response.status, body?.error?.message ?? `Settings request failed (HTTP ${response.status}).`, Array.isArray(body?.error?.fields) ? body.error.fields : [])
    return body as T
  } catch (caught) {
    if (accessSignal?.aborted) throw accessSignal.reason
    reportCloudAccessFailure(path, caught)
    throw caught
  }
}

export function readAdminSettings(signal?: AbortSignal): Promise<AdminSettingsResponse> {
  return request('/admin/settings', { signal })
}
export function saveAdminSettings(patch: AdminSettingsPatch, etag: string): Promise<AdminSettingsResponse> {
  return request('/admin/settings', { method: 'PATCH', headers: { 'If-Match': etag }, body: JSON.stringify(patch) })
}
export function readSettingsHistory(before?: string, signal?: AbortSignal): Promise<SettingsHistoryResponse> {
  return request(`/admin/settings/history?limit=20${before ? `&before=${encodeURIComponent(before)}` : ''}`, { signal })
}
export function readSettingsRevision(revision: string, signal?: AbortSignal): Promise<SettingsRevision> {
  return request(`/admin/settings/revisions/${encodeURIComponent(revision)}`, { signal })
}
export function restoreAdminSettings(revision: string, etag: string): Promise<AdminSettingsResponse> {
  return request('/admin/settings/restore', { method: 'POST', headers: { 'If-Match': etag }, body: JSON.stringify({ revision }) })
}
export function exportAdminSettings(): Promise<SettingsExport> { return request('/admin/settings/export') }
export function previewSettingsImport(document: unknown, etag: string): Promise<SettingsImportPreview> {
  return request('/admin/settings/import-preview', { method: 'POST', headers: { 'If-Match': etag }, body: JSON.stringify({ document }) })
}
export function importAdminSettings(document: unknown, etag: string): Promise<AdminSettingsResponse> {
  return request('/admin/settings/import-apply', { method: 'POST', headers: { 'If-Match': etag }, body: JSON.stringify({ document, confirm: true }) })
}
export function refreshDeploymentInventory(): Promise<DeploymentInventory> {
  return request('/admin/deployments/refresh', { method: 'POST', body: '{}' })
}
export function testModelConfiguration(input: {
  kind: ModelConfigurationTestRequest['kind']; deploymentId: string; taskId?: ModelTaskId; settings: AdminSettings; acknowledgeCost: boolean
}): Promise<ModelTestResult> {
  if (input.kind !== 'connection' && !input.acknowledgeCost) throw new Error('Explicitly acknowledge possible inference charges before running this synthetic test.')
  const { settings, acknowledgeCost, ...selection } = input
  const body: ModelConfigurationTestRequest = { ...selection, draft: settings, confirmPaidProbe: acknowledgeCost }
  return request('/admin/deployments/test', { method: 'POST', body: JSON.stringify(body) })
}
