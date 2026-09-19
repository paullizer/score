import { createContext, useCallback, useContext, useId, useLayoutEffect } from 'react'

export interface GradeLeaveBlocker { label: string; dirty: boolean; pending: boolean }
export interface GradeLeaveProtectionApi {
  confirmLeave: (ids?: readonly string[]) => Promise<boolean>
  releaseForLeave: () => void
}
export interface GradeNavigationContextValue extends GradeLeaveProtectionApi {
  setBlocker: (id: string, blocker: GradeLeaveBlocker | null) => void
  recordLocation: () => void
  runAuthorized: (action: () => void, ids?: readonly string[]) => void
}

export const GradeNavigationContext = createContext<GradeNavigationContextValue | null>(null)

export function useGradeLeaveGuard(dirty: boolean, pending: boolean, label: string) {
  const context = useContext(GradeNavigationContext)
  const setBlocker = context?.setBlocker
  const id = useId()
  useLayoutEffect(() => {
    setBlocker?.(id, dirty || pending ? { dirty, pending, label } : null)
    return () => setBlocker?.(id, null)
  }, [dirty, id, label, pending, setBlocker])
  const release = useCallback(() => setBlocker?.(id, null), [id, setBlocker])
  const hold = useCallback(() => setBlocker?.(id, { dirty, pending: true, label }), [dirty, id, label, setBlocker])
  // A synchronous failure may settle before React ever renders pending=true.
  const settle = useCallback(() => setBlocker?.(id, dirty ? { dirty, pending: false, label } : null), [dirty, id, label, setBlocker])
  const close = useCallback(async (action: () => void) => {
    if (!context) action()
    else if (await context.confirmLeave([id])) context.runAuthorized(action, [id])
  }, [context, id])
  const leave = useCallback(async (action: () => void) => {
    if (!context) action()
    else if (await context.confirmLeave()) context.runAuthorized(action)
  }, [context])
  return { release, close, leave, hold, settle }
}
