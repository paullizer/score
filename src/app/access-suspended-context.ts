import { createContext } from 'react'

// Keep draft-owning components mounted while hiding their content and portalled dialogs after revocation.
export const AccessSuspendedContext = createContext(false)
