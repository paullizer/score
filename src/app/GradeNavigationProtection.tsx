import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { UNSAFE_NavigationContext, useLocation } from 'react-router-dom'
import { Button, Modal } from '../components/ui'
import { GradeNavigationContext, type GradeLeaveBlocker, type GradeLeaveProtectionApi } from './grade-navigation-context'

interface HistorySnapshot { url: string; state: { idx?: number } | null }
function snapshot(): HistorySnapshot {
  return { url: window.location.pathname + window.location.search + window.location.hash, state: window.history.state }
}

export function GradeNavigationProtectionProvider({ workspaceId, routePrefix = `/workspaces/${encodeURIComponent(workspaceId)}`, apiRef, children }: {
  workspaceId: string
  routePrefix?: string
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
  const decisionIncludesWorkspace = useRef(false)
  const matchingBlockers = useCallback((ids?: readonly string[], includeWorkspaceDrafts = false) => [...blockers.current].filter(([id, blocker]) =>
    (!ids || ids.includes(id)) && (!blocker.workspaceOnly || includeWorkspaceDrafts || ids?.includes(id) || blocker.pending) &&
    (blocker.pending || !(authorizedAction.current === true || authorizedAction.current?.includes(id))),
  ).map(([, blocker]) => blocker), [])

  const setBlocker = useCallback((id: string, blocker: GradeLeaveBlocker | null) => {
    if (blocker) blockers.current.set(id, blocker)
    else blockers.current.delete(id)
    setVisibleBlockers(matchingBlockers(decisionIds.current, decisionIncludesWorkspace.current))
  }, [matchingBlockers])

  const confirmLeave = useCallback((ids?: readonly string[], includeWorkspaceDrafts = false): Promise<boolean> => {
    const relevant = matchingBlockers(ids, includeWorkspaceDrafts)
    if (!relevant.length) return Promise.resolve(true)
    if (decision.current) return Promise.resolve(false)
    decisionIds.current = ids
    decisionIncludesWorkspace.current = includeWorkspaceDrafts
    setVisibleBlockers(relevant)
    setOpen(true)
    return new Promise((resolve) => { decision.current = resolve })
  }, [matchingBlockers])

  function resolveDecision(allowed: boolean) {
    if (allowed && matchingBlockers(decisionIds.current, decisionIncludesWorkspace.current).some((blocker) => blocker.pending)) return
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
      const prefix = routePrefix.endsWith('/') ? routePrefix : `${routePrefix}/`
      // Cross-workspace navigation is held by CloudApplication before its persistent provider leaves.
      if (!(window.location.pathname === routePrefix || window.location.pathname.startsWith(prefix)) || !matchingBlockers().length) return
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
  }, [confirmLeave, matchingBlockers, routePrefix])

  const value = useMemo(() => ({ confirmLeave, setBlocker, recordLocation, releaseForLeave, runAuthorized }), [confirmLeave, setBlocker, recordLocation, releaseForLeave, runAuthorized])
  const pending = visibleBlockers.some((blocker) => blocker.pending)
  const dirty = visibleBlockers.some((blocker) => blocker.dirty)
  return <GradeNavigationContext.Provider value={value}>
    {children}
    <Modal open={open} onOpenChange={(next) => { if (!next) resolveDecision(false) }}
      title={pending ? 'Request in progress' : dirty ? 'Unsaved changes' : 'Continue leaving?'}
      description={pending
        ? 'Keep this workspace open until the request outcome is known. It may already have been accepted.'
        : 'Unsaved edits in this tab will be discarded if you leave. Stay here to continue editing.'}
      footer={<><Button variant="primary" onClick={() => resolveDecision(false)}>Stay here</Button>
        <Button variant={dirty ? 'danger' : 'secondary'} disabled={pending} onClick={() => resolveDecision(true)}>{dirty ? 'Discard unsaved changes and leave' : 'Continue'}</Button></>}>
      <ul className="list-disc space-y-2 pl-5 text-[12px]">{visibleBlockers.map((blocker, index) => <li key={index}>{blocker.label}{blocker.pending ? ' · awaiting acknowledgement' : ' · unsaved'}</li>)}</ul>
      <p className="mt-4 text-[11px] text-muted">Already accepted background work continues on the server after you leave. This protection never cancels that work.</p>
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
