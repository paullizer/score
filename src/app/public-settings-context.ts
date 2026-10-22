import { createContext, useContext } from 'react'
import type { PublicSettings } from '../domain/admin-settings'
import { aiTerminology, type AiTerminology } from '../domain/ai-terminology'
import { admissionReason, type NewWorkKind } from '../services/publicSettings'
import { WorkspaceContext } from './workspace-context'

export interface PublicSettingsContextValue {
  settings: PublicSettings | null
  phase: 'loading' | 'ready' | 'error'
  error: string | null
  cloud: boolean
  refreshing?: boolean
  hostTheme?: 'light' | 'dark' | null
  refresh: () => Promise<void>
}

export const PublicSettingsContext = createContext<PublicSettingsContextValue>({
  settings: null, phase: 'ready', error: null, cloud: false, refresh: async () => {},
})

export function usePublicSettings() { return useContext(PublicSettingsContext) }

export function useAiTerminology(override?: boolean | { features?: { siTerminology?: boolean } } | null): AiTerminology {
  const { settings } = usePublicSettings()
  const workspace = useContext(WorkspaceContext)
  if (override !== undefined) return aiTerminology(override)
  if (settings) return aiTerminology(settings)
  return aiTerminology(workspace?.cloud?.realJobs?.features?.siTerminology === true)
}

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
  if (policy.cloud && policy.phase !== 'ready') return policy.error ?? 'Checking application settings before starting new work.'
  return admissionReason(policy.settings, kind)
}

export function assertClientAdmission(policy: PublicSettingsContextValue, kind: NewWorkKind) {
  const reason = clientAdmissionReason(policy, kind)
  if (reason) throw new Error(reason)
}
