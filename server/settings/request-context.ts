import type { NextFunction, Request, Response } from 'express'
import type { AdminSettings, ProcessingSettingsSnapshot, RuntimeSettingsReadiness } from '../../src/domain/admin-settings'
import {
  captureProcessingSettings, createDefaultAdminSettings, LEGACY_SETTINGS_CAPTURED_AT, LEGACY_SETTINGS_REVISION,
  processingSettingsSnapshotSchema, runtimeSettingsReadiness,
} from '../../src/domain/admin-settings'
import type { Config } from '../config'
import { unavailable } from '../errors'
import type { AdminSettingsService } from './service'

interface SettingsRequest extends Request {
  applicationSettings?: {
    config: Config
    service?: AdminSettingsService
    admission?: Promise<ProcessingSettingsSnapshot>
  }
}

/** Attaches dependencies only; no configuration I/O on GET/history/cancellation/cleanup. */
export function attachSettingsContext(config: Config, service?: AdminSettingsService) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    ;(req as SettingsRequest).applicationSettings = { config, service }
    next()
  }
}

/** Current action policy, independent of rollout activation. One request resolves one saved revision. */
export function getAdmissionSettings(req: Request): Promise<ProcessingSettingsSnapshot> {
  const context = (req as SettingsRequest).applicationSettings
  if (!context) throw new Error('Settings context must be attached after authentication.')
  context.admission ??= (async () => {
    if (context.service) return context.service.capture()
    if (context.config.settings) throw unavailable('Current application policy is unavailable; no bootstrap defaults were substituted.')
    return captureProcessingSettings(createDefaultAdminSettings(), LEGACY_SETTINGS_REVISION, LEGACY_SETTINGS_CAPTURED_AT)
  })()
  return context.admission
}

export async function getCurrentSettings(req: Request): Promise<AdminSettings> {
  return (await getAdmissionSettings(req)).settings
}

/** Deployment rollout readiness only; synchronous, immutable, and independent of settings-store health. */
export function getRuntimeSettingsReadiness(req: Request): Readonly<RuntimeSettingsReadiness> {
  const context = (req as SettingsRequest).applicationSettings
  if (!context) throw new Error('Settings context must be attached after authentication.')
  return Object.freeze(runtimeSettingsReadiness(
    context.config.settings?.runtimeEnabled === true, Boolean(context.config.settings || context.service),
  ))
}

export function assertNewProcessingAllowed(req: Request): void {
  const readiness = getRuntimeSettingsReadiness(req)
  if (!readiness.newProcessingAllowed) throw unavailable(readiness.message ?? 'New processing is temporarily unavailable.')
}

/** Invoke only after detecting idempotent accepted work, never for reads, cleanup or accepted retries. */
export async function getProcessingAdmissionSettings(req: Request): Promise<ProcessingSettingsSnapshot> {
  assertNewProcessingAllowed(req)
  return getAdmissionSettings(req)
}

/** Undefined means truly unconfigured legacy mode, not a bypass of a configured rollout gate. */
export async function getPinnedAdmissionSettings(req: Request): Promise<ProcessingSettingsSnapshot | undefined> {
  assertNewProcessingAllowed(req)
  return runtimeSettingsEnabled(req) ? getAdmissionSettings(req) : undefined
}

export async function getSettingsForAcceptedWork(
  req: Request, pinned?: ProcessingSettingsSnapshot,
): Promise<ProcessingSettingsSnapshot> {
  if (pinned !== undefined) {
    const parsed = processingSettingsSnapshotSchema.safeParse(pinned)
    if (!parsed.success) throw unavailable('The saved processing settings cannot be read; no model or policy substitution was made.')
    return captureProcessingSettings(parsed.data.settings, parsed.data.revision, parsed.data.capturedAt)
  }
  const context = (req as SettingsRequest).applicationSettings
  if (!context) throw new Error('Settings context must be attached after authentication.')
  if (context.service) return context.service.captureLegacy()
  if (context.config.settings) throw unavailable('The immutable compatibility baseline is unavailable for this accepted work.')
  return captureProcessingSettings(createDefaultAdminSettings(), LEGACY_SETTINGS_REVISION, LEGACY_SETTINGS_CAPTURED_AT)
}

export function runtimeSettingsEnabled(req: Request): boolean {
  const context = (req as SettingsRequest).applicationSettings
  if (!context) throw new Error('Settings context must be attached after authentication.')
  return context.config.settings?.runtimeEnabled === true
}
