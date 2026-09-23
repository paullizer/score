import type { AdminSettings, SettingsChange, SettingsFieldMetadata } from '../../domain/admin-settings'
import { workspaceRoleLabel } from '../../domain/access'
import { isWorkspaceRole } from '../../domain/workspace-permissions'

export function settingValue(settings: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, settings)
}

export function updateSetting(settings: AdminSettings, path: string, value: unknown): AdminSettings {
  const copy = structuredClone(settings)
  const keys = path.split('.')
  let current: Record<string, unknown> = copy as unknown as Record<string, unknown>
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>
  current[keys[keys.length - 1]] = value
  return copy
}

function parentOf(settings: unknown, path: string): { parent?: Record<string, unknown>; key: string } {
  const keys = path.split('.')
  const parent = keys.length > 1 ? settingValue(settings, keys.slice(0, -1).join('.')) : settings
  return { parent: parent && typeof parent === 'object' ? parent as Record<string, unknown> : undefined, key: keys[keys.length - 1] }
}

/**
 * Optional switches are absent from revisions saved before they existed, and absence means the field default.
 * Choosing that default again keeps the key absent, so the draft stays clean and no redundant revision is published.
 */
export function changeSetting(draft: AdminSettings, saved: AdminSettings, path: string, value: unknown, defaultValue: unknown): AdminSettings {
  const { parent: savedParent, key } = parentOf(saved, path)
  const unsavedDefault = defaultValue !== undefined && savedParent !== undefined && !Object.hasOwn(savedParent, key)
    && JSON.stringify(value) === JSON.stringify(defaultValue)
  if (!unsavedDefault) return updateSetting(draft, path, value)
  const copy = structuredClone(draft)
  const { parent } = parentOf(copy, path)
  if (parent) delete parent[key]
  return copy
}

/** Compiled defaults omit optional switches and a PATCH keeps keys it does not mention, so pin saved switches back to their default. */
export function defaultsCandidate(defaults: AdminSettings, saved: AdminSettings, fields: SettingsFieldMetadata[]): AdminSettings {
  return fields.reduce((candidate, field) => field.defaultValue !== undefined && settingValue(defaults, field.path) === undefined
    && settingValue(saved, field.path) !== undefined ? updateSetting(candidate, field.path, structuredClone(field.defaultValue)) : candidate, structuredClone(defaults))
}

export function describeChangeValue(path: string, value: unknown, fields: SettingsFieldMetadata[]): string {
  if (value !== undefined) return describeSettingValue(path, value)
  const fallback = fields.find(field => field.path === path)?.defaultValue
  return fallback === undefined ? 'Not saved' : `Not saved (default: ${describeSettingValue(path, fallback)})`
}

export function describeValue(value: unknown): string {
  if (value === null) return 'Not set / inherit where supported'
  if (value === '') return '(blank)'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

export function describeSettingValue(path: string, value: unknown): string {
  if (['reports.allowedRoles', 'documents.originalDownloadRoles', 'summaries.manualPublicationRoles', 'summaries.historyRoles'].includes(path)) {
    const label = (role: unknown) => isWorkspaceRole(role) ? workspaceRoleLabel(role)
      : role === 'owner-and-editor' ? 'Owners and Editors' : String(role)
    return Array.isArray(value) ? value.map(label).join(', ') || 'No roles' : label(value)
  }
  return describeValue(value)
}

export function rebaseSettingsDraft(latest: AdminSettings, changes: SettingsChange[]): AdminSettings {
  return changes.reduce((settings, change) => updateSetting(settings, change.path, change.after), latest)
}
