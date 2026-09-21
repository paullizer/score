import { isDeepStrictEqual } from 'node:util'
import type { Request } from 'express'
import type { AdminSettings, ProcessingSettingsSnapshot } from '../../src/domain/admin-settings'
import type { WorkspaceRole } from '../../src/domain/cloud'
import type { UploadFormat } from '../../src/domain/document-formats'
import {
  createDefaultAdminSettings, LEGACY_SETTINGS_CAPTURED_AT, LEGACY_SETTINGS_REVISION,
} from '../../src/domain/admin-settings-defaults'
import { captureProcessingSettings, urlAllowedBySettings } from '../../src/domain/admin-settings-resolver'
import { forbidden, HttpError, invalidRequest, unavailable } from '../errors'
import {
  getAdmissionSettings, getProcessingAdmissionSettings, getRuntimeSettingsReadiness,
  getSettingsForAcceptedWork, runtimeSettingsEnabled,
} from '../settings/request-context'

export type ProcessingSettingsProvider = (() => Promise<ProcessingSettingsSnapshot>) & {
  accepted?: (snapshot?: ProcessingSettingsSnapshot) => Promise<ProcessingSettingsSnapshot>
  admission?: () => Promise<ProcessingSettingsSnapshot>
  newProcessingAllowed?: () => boolean
  pinNewAdmissions?: boolean
}

export function requestProcessingSettings(req: Request): ProcessingSettingsProvider {
  let legacy: Promise<ProcessingSettingsSnapshot> | undefined
  return Object.assign(() => getAdmissionSettings(req), {
    admission: () => getProcessingAdmissionSettings(req),
    newProcessingAllowed: () => getRuntimeSettingsReadiness(req).newProcessingAllowed,
    pinNewAdmissions: runtimeSettingsEnabled(req),
    accepted: (snapshot?: ProcessingSettingsSnapshot) => snapshot
      ? getSettingsForAcceptedWork(req, snapshot) : legacy ??= getSettingsForAcceptedWork(req),
  })
}

export function newProcessingSettings(
  provider: ProcessingSettingsProvider | undefined, snapshot: ProcessingSettingsSnapshot,
): ProcessingSettingsSnapshot | undefined {
  return provider?.pinNewAdmissions === false ? undefined : snapshot
}

export async function admittedProcessingSettings(
  provider: ProcessingSettingsProvider | undefined, snapshot?: ProcessingSettingsSnapshot,
): Promise<ProcessingSettingsSnapshot | undefined> {
  return !snapshot && provider?.pinNewAdmissions === false ? undefined : resolveAcceptedProcessingSettings(provider, snapshot)
}

const compatibilitySettings = captureProcessingSettings(
  createDefaultAdminSettings(), LEGACY_SETTINGS_REVISION, LEGACY_SETTINGS_CAPTURED_AT,
)

export function acceptedProcessingSettings(snapshot?: ProcessingSettingsSnapshot): ProcessingSettingsSnapshot {
  return snapshot ?? compatibilitySettings
}

export async function resolveAcceptedProcessingSettings(
  provider: ProcessingSettingsProvider | undefined, snapshot?: ProcessingSettingsSnapshot,
): Promise<ProcessingSettingsSnapshot> {
  return provider?.accepted ? provider.accepted(snapshot) : acceptedProcessingSettings(snapshot)
}

export function preservesProcessingSettings(
  previous: ProcessingSettingsSnapshot | undefined, next: ProcessingSettingsSnapshot | undefined,
): boolean {
  return previous ? isDeepStrictEqual(previous, next) : !next || next.revision === LEGACY_SETTINGS_REVISION
}

export async function currentProcessingSettings(provider?: ProcessingSettingsProvider): Promise<ProcessingSettingsSnapshot> {
  return provider ? provider() : compatibilitySettings
}

export async function newWorkProcessingSettings(provider?: ProcessingSettingsProvider): Promise<ProcessingSettingsSnapshot> {
  return provider?.admission ? provider.admission() : currentProcessingSettings(provider)
}

export function newProcessingAllowed(provider?: ProcessingSettingsProvider): boolean {
  return provider?.newProcessingAllowed?.() ?? true
}

export function assertNewWork(snapshot: ProcessingSettingsSnapshot, feature: keyof AdminSettings['features']): void {
  if (snapshot.settings.maintenance.pauseNewWork) {
    throw unavailable(snapshot.settings.maintenance.explanation || 'New work is temporarily paused by application policy.')
  }
  if (!snapshot.settings.features[feature]) throw unavailable('New work of this type is disabled by application policy.')
}

export function assertImportPolicy(
  snapshot: ProcessingSettingsSnapshot, scope: 'jobs' | 'resumes', source: UploadFormat | 'url',
  input: { bytes?: number; pages?: number; characters?: number; url?: string; count?: number } = {},
): void {
  assertNewWork(snapshot, scope === 'jobs' ? 'jobImports' : 'resumeImports')
  const policy = snapshot.settings.imports[scope]
  if (source === 'url') {
    if (!policy.allowUrls) throw forbidden('Public URL imports are disabled by application policy.')
    if (!input.url || !urlAllowedBySettings(input.url, snapshot.settings, scope)) {
      throw invalidRequest('This URL is not allowed by the current HTTPS and hostname policy.')
    }
  } else if (!policy.allowedFormats.includes(source)) {
    throw forbidden('This file format is disabled by application policy.')
  }
  if (input.bytes !== undefined && input.bytes > policy.maxFileBytes) {
    throw new HttpError(413, 'invalid_request', `The file exceeds the current ${policy.maxFileBytes}-byte import limit.`)
  }
  if (source === 'pdf' && input.pages !== undefined && input.pages > policy.maxPdfPages) {
    throw invalidRequest(`PDFs may contain at most ${policy.maxPdfPages} pages under the current import policy.`)
  }
  if (input.characters !== undefined && input.characters > policy.maxSourceCharacters) {
    throw invalidRequest(`The source exceeds the current ${policy.maxSourceCharacters}-character import limit. Nothing was truncated.`)
  }
  if (input.count !== undefined && input.count > policy.maxBatchItems) {
    throw invalidRequest(`Import batches may contain at most ${policy.maxBatchItems} items under the current policy.`)
  }
}

export function assertOriginalDownload(snapshot: ProcessingSettingsSnapshot, role: WorkspaceRole, preview = false): void {
  if (!snapshot.settings.documents.originalDownloadRoles.includes(role)) {
    throw forbidden('Application policy does not allow your workspace role to download original source bytes.')
  }
  if (preview && !snapshot.settings.documents.formattedDocxPreviewEnabled) {
    throw forbidden('Formatted original-document previews are disabled by application policy.')
  }
}

export function canUseSummaryRole(policy: 'owner' | 'owner-and-editor', role: WorkspaceRole): boolean {
  return role === 'owner' || policy === 'owner-and-editor' && role === 'editor'
}
