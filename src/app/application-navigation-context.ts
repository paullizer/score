import { createContext, useContext } from 'react'

export interface ApplicationNavigation {
  applicationAdmin: boolean
  openAdminSettings: () => Promise<void>
}

export const ApplicationNavigationContext = createContext<ApplicationNavigation | null>(null)
export function useApplicationNavigation() { return useContext(ApplicationNavigationContext) }
