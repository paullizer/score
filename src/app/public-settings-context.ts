import { createContext, useContext } from 'react'
import type { PublicSettings } from '../domain/admin-settings'
import { admissionReason, type NewWorkKind } from '../services/publicSettings'

export interface PublicSettingsContextValue {
  settings: PublicSettings | null
  phase: 'loading' | 'ready' | 'error'
  error: string | null
  cloud: boolean
  hostTheme?: 'light' | 'dark' | null
  refresh: () => Promise<void>
}

export const PublicSettingsContext = createContext<PublicSettingsContextValue>({
  settings: null, phase: 'ready', error: null, cloud: false, refresh: async () => {},
})

export function usePublicSettings() { return useContext(PublicSettingsContext) }

export function originalDownloadReason(policy: PublicSettingsContextValue, role?: PublicSettings['documents']['originalDownloadRoles'][number]): string | null {
  if (policy.cloud && (policy.phase !== 'ready' || !policy.settings)) {
    return 'Original downloads are unavailable until current application policy can be checked. Extracted evidence remains readable.'
  }
  if (policy.settings && (!role || !policy.settings.documents.originalDownloadRoles.includes(role))) {
    return 'Your current workspace role cannot download original files. Extracted evidence remains readable.'
  }
  return null
}

export function clientAdmissionReason(policy: PublicSettingsContextValue, kind?: NewWorkKind): string | null {
  if (policy.cloud && policy.phase !== 'ready') return policy.error ?? 'Checking current application policy before starting new work.'
  return admissionReason(policy.settings, kind)
}

export function assertClientAdmission(policy: PublicSettingsContextValue, kind: NewWorkKind) {
  const reason = clientAdmissionReason(policy, kind)
  if (reason) throw new Error(reason)
}
