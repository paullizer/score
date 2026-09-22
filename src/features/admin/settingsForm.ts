import type { AdminSettings, SettingsChange } from '../../domain/admin-settings'
import { workspaceRoleLabel } from '../../domain/access'

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

export function describeValue(value: unknown): string {
  if (value === null) return 'Not set / inherit where supported'
  if (value === '') return '(blank)'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

export function describeSettingValue(path: string, value: unknown): string {
  if (['reports.allowedRoles', 'documents.originalDownloadRoles', 'summaries.manualPublicationRoles', 'summaries.historyRoles'].includes(path)) {
    const label = (role: unknown) => role === 'viewer' || role === 'owner' || role === 'editor' ? workspaceRoleLabel(role)
      : role === 'owner-and-editor' ? 'Owners and Editors' : String(role)
    return Array.isArray(value) ? value.map(label).join(', ') || 'No roles' : label(value)
  }
  return describeValue(value)
}

export function rebaseSettingsDraft(latest: AdminSettings, changes: SettingsChange[]): AdminSettings {
  return changes.reduce((settings, change) => updateSetting(settings, change.path, change.after), latest)
}
