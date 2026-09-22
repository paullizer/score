import { createContext, useContext } from 'react'

export interface ApplicationNavigation {
  applicationAdmin: boolean
  openAdminSettings: () => Promise<void>
  openWorkspaceHome: () => Promise<void>
  workspaceHomePath: string
  directoryError: string | null
}

export const ApplicationNavigationContext = createContext<ApplicationNavigation | null>(null)
export function useApplicationNavigation() { return useContext(ApplicationNavigationContext) }
