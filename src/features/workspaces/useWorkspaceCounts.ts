import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceSummary } from '../../domain/cloud'
import type { WorkspaceCounts } from '../../domain/workspace-summary'
import { CloudAuthError, workspaceAccessStamp } from '../../services/cloudWorkspace'
import { isActiveWorkspace } from '../../services/workspaceRecents'
import { fetchWorkspaceCounts } from '../../services/workspaceSummaries'

export type WorkspaceCountsState =
  | { status: 'loading' }
  | { status: 'ready'; value: WorkspaceCounts }
  | { status: 'error'; message: string }

export function useWorkspaceCounts(scope: string, workspaces: WorkspaceSummary[], visibleIds: string[], revision: number, onAuthError: (message: string) => void) {
  const [states, setStates] = useState<Record<string, WorkspaceCountsState>>({})
  const [retry, setRetry] = useState(0)
  const cache = useRef(new Map<string, { key: string; state: WorkspaceCountsState }>())
  const authError = useRef(onAuthError)
  authError.current = onAuthError
  const visible = useMemo(() => {
    const ids = new Set(visibleIds)
    return workspaces.filter((item) => ids.has(item.id) && isActiveWorkspace(item))
  }, [visibleIds, workspaces])

  useEffect(() => {
    const controller = new AbortController()
    const initial: Record<string, WorkspaceCountsState> = {}
    const pending: { id: string; key: string }[] = []
    const accessible = new Set(workspaces.filter(isActiveWorkspace).map(item => item.id))
    for (const id of cache.current.keys()) if (!accessible.has(id)) cache.current.delete(id)
    for (const item of visible) {
      const key = JSON.stringify([scope, revision, item.etag, workspaceAccessStamp(item)])
      const saved = cache.current.get(item.id)
      if (saved?.key === key) initial[item.id] = saved.state
      else { initial[item.id] = { status: 'loading' }; pending.push({ id: item.id, key }) }
    }
    setStates(initial)
    let next = 0
    async function consume() {
      while (!controller.signal.aborted && next < pending.length) {
        const { id, key } = pending[next++]
        let state: WorkspaceCountsState
        try {
          state = { status: 'ready', value: await fetchWorkspaceCounts(id, controller.signal) }
        } catch (caught) {
          if (controller.signal.aborted) return
          if (caught instanceof CloudAuthError) { authError.current(caught.message); return }
          state = { status: 'error', message: caught instanceof Error ? caught.message : 'Workspace counts could not be loaded. Try again.' }
        }
        if (controller.signal.aborted) return
        cache.current.set(id, { key, state })
        setStates((current) => ({ ...current, [id]: state }))
      }
    }
    for (let index = 0; index < Math.min(4, pending.length); index++) void consume()
    return () => controller.abort()
  }, [revision, retry, scope, visible, workspaces])

  const retryCounts = useCallback((id: string) => {
    cache.current.delete(id)
    setRetry((value) => value + 1)
  }, [])
  return { states, retryCounts }
}
