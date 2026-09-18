import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { UNSAFE_NavigationContext, useLocation } from 'react-router-dom'
import { Button, Modal } from '../components/ui'
import { GradeNavigationContext, type GradeLeaveBlocker, type GradeLeaveProtectionApi } from './grade-navigation-context'

interface HistorySnapshot { url: string; state: { idx?: number } | null }
function snapshot(): HistorySnapshot {
  return { url: window.location.pathname + window.location.search + window.location.hash, state: window.history.state }
}

export function GradeNavigationProtectionProvider({ workspaceId, apiRef, children }: {
  workspaceId: string
  apiRef: { current: GradeLeaveProtectionApi | null }
  children: ReactNode
}) {
  const blockers = useRef(new Map<string, GradeLeaveBlocker>())
  const [visibleBlockers, setVisibleBlockers] = useState<GradeLeaveBlocker[]>([])
  const [open, setOpen] = useState(false)
  const decision = useRef<((allowed: boolean) => void) | null>(null)
  const outgoing = useRef<HistorySnapshot>(snapshot())
  const allowPop = useRef(false)
  const restore = useRef<(() => void) | null>(null)
  const popPending = useRef(false)
  const authorizedAction = useRef<true | readonly string[] | null>(null)
  const decisionIds = useRef<readonly string[] | undefined>(undefined)
  const matchingBlockers = useCallback((ids?: readonly string[]) => [...blockers.current].filter(([id, blocker]) =>
    (!ids || ids.includes(id)) && (blocker.pending || !(authorizedAction.current === true || authorizedAction.current?.includes(id))),
  ).map(([, blocker]) => blocker), [])

  const setBlocker = useCallback((id: string, blocker: GradeLeaveBlocker | null) => {
    if (blocker) blockers.current.set(id, blocker)
    else blockers.current.delete(id)
    setVisibleBlockers(matchingBlockers(decisionIds.current))
  }, [matchingBlockers])

  const confirmLeave = useCallback((ids?: readonly string[]): Promise<boolean> => {
    const relevant = matchingBlockers(ids)
    if (!relevant.length) return Promise.resolve(true)
    if (decision.current) return Promise.resolve(false)
    decisionIds.current = ids
    setVisibleBlockers(relevant)
    setOpen(true)
    return new Promise((resolve) => { decision.current = resolve })
  }, [matchingBlockers])

  function resolveDecision(allowed: boolean) {
    if (allowed && matchingBlockers(decisionIds.current).some((blocker) => blocker.pending)) return
    const resolve = decision.current
    decision.current = null
    setOpen(false)
    resolve?.(allowed)
  }

  const recordLocation = useCallback(() => { outgoing.current = snapshot() }, [])
  const releaseForLeave = useCallback(() => { blockers.current.clear(); setVisibleBlockers([]) }, [])
  const runAuthorized = useCallback((action: () => void, ids?: readonly string[]) => {
    authorizedAction.current = ids ?? true
    try { action() } finally { authorizedAction.current = null }
  }, [])

  useLayoutEffect(() => {
    apiRef.current = { confirmLeave, releaseForLeave }
    return () => { apiRef.current = null; decision.current?.(false); decision.current = null }
  }, [apiRef, confirmLeave, releaseForLeave])

  useLayoutEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!blockers.current.size) return
      event.preventDefault()
      event.returnValue = ''
    }
    const onPop = (event: PopStateEvent) => {
      if (restore.current) {
        event.stopImmediatePropagation()
        const restored = restore.current
        restore.current = null
        restored()
        return
      }
      if (allowPop.current) { allowPop.current = false; return }
      const prefix = `/workspaces/${encodeURIComponent(workspaceId)}/`
      // Cross-workspace navigation is held by CloudApplication before its persistent provider leaves.
      if (!window.location.pathname.startsWith(prefix) || !blockers.current.size) return
      event.stopImmediatePropagation()
      if (popPending.current) return
      popPending.current = true
      const incoming = snapshot()
      const previous = outgoing.current
      const delta = typeof previous.state?.idx === 'number' && typeof incoming.state?.idx === 'number'
        ? previous.state.idx - incoming.state.idx : 0
      const undo = delta
        ? new Promise<void>((resolve) => { restore.current = resolve; window.history.go(delta) })
        : Promise.resolve(window.history.pushState(previous.state, '', previous.url))
      void undo.then(() => confirmLeave()).then((allowed) => {
        popPending.current = false
        if (!allowed) return
        allowPop.current = true
        if (delta) window.history.go(-delta)
        else {
          window.history.replaceState(incoming.state, '', incoming.url)
          window.dispatchEvent(new PopStateEvent('popstate', { state: incoming.state }))
        }
      })
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener('popstate', onPop, { capture: true })
    return () => {
      window.removeEventListener('beforeunload', warn)
      window.removeEventListener('popstate', onPop, { capture: true })
    }
  }, [confirmLeave, workspaceId])

  const value = useMemo(() => ({ confirmLeave, setBlocker, recordLocation, releaseForLeave, runAuthorized }), [confirmLeave, setBlocker, recordLocation, releaseForLeave, runAuthorized])
  const pending = visibleBlockers.some((blocker) => blocker.pending)
  const dirty = visibleBlockers.some((blocker) => blocker.dirty)
  return <GradeNavigationContext.Provider value={value}>
    {children}
    <Modal open={open} onOpenChange={(next) => { if (!next) resolveDecision(false) }}
      title={pending ? 'Wait for the grade request' : dirty ? 'Leave unsaved grade changes?' : 'Continue leaving?'}
      description={pending
        ? 'The request may already be accepted by the server. Keep this workspace open until the response is known.'
        : 'Only saved server versions are durable. Unsaved edits in this tab will be discarded if you leave.'}
      footer={<><Button variant="primary" onClick={() => resolveDecision(false)}>Stay here</Button>
        <Button variant={dirty ? 'danger' : 'secondary'} disabled={pending} onClick={() => resolveDecision(true)}>{dirty ? 'Discard unsaved changes and leave' : 'Continue'}</Button></>}>
      <ul className="list-disc space-y-2 pl-5 text-[12px]">{visibleBlockers.map((blocker, index) => <li key={index}>{blocker.label}{blocker.pending ? ' · awaiting the server' : ' · unsaved'}</li>)}</ul>
      <p className="mt-4 text-[11px] text-muted">Accepted background discovery, extraction, and generation continue on the server after their request is acknowledged. This protection never cancels that work.</p>
    </Modal>
  </GradeNavigationContext.Provider>
}

export function GradeRouterProtection({ children }: { children: ReactNode }) {
  const navigation = useContext(UNSAFE_NavigationContext)
  const protection = useContext(GradeNavigationContext)
  const location = useLocation()
  useLayoutEffect(() => { protection?.recordLocation() }, [location, protection])
  const guarded = useMemo(() => ({
    ...navigation,
    navigator: {
      ...navigation.navigator,
      push: (...args: Parameters<typeof navigation.navigator.push>) => {
        if (!protection) navigation.navigator.push(...args)
        else void protection.confirmLeave().then((allowed) => { if (allowed) navigation.navigator.push(...args) })
      },
      replace: (...args: Parameters<typeof navigation.navigator.replace>) => {
        if (!protection) navigation.navigator.replace(...args)
        else void protection.confirmLeave().then((allowed) => { if (allowed) navigation.navigator.replace(...args) })
      },
    },
  }), [navigation, protection])
  return <UNSAFE_NavigationContext.Provider value={guarded}>{children}</UNSAFE_NavigationContext.Provider>
}
