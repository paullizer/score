import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type {
  AnalysisProcessingFeatures, RealAnalysisComparisonDetail, RealAnalysisComparisonSummary, RealAnalysisRunDetail,
  RealAnalysisRunSummary, RealAnalysisTargetSummary,
} from '../domain/real-analyses'
import type { RealAnalysisSummariesResponse } from '../domain/analysis-narratives'
import * as api from '../services/realAnalyses'
import { CloudApiError, CloudConflictError, LifecycleOperationError } from '../services/cloudWorkspace'
import { lifecycleIsRemoved, isEntityArchived, isEntityRemoved, type LifecycleAction, type LifecycleTarget } from '../domain/lifecycle'
import { WorkspaceContext, useWorkspace, type PendingLifecycleChange, type RenameEntityTarget } from './workspace-context'
import { getDisplayName } from '../domain/displayNames'
import { useGradeLeaveGuard } from './grade-navigation-context'
import { RealAnalysesContext, type RealAnalysesContextValue } from './real-analyses-context'
import { RealRequestScope, realRequestError, type RealLoadState } from './real-request-scope'
import { realAnalysisWorkActive as active, realTargetAvailable } from '../features/analyses/realAnalysisUi'
import { assertRealLifecyclePermission, discoveredLifecycle, projectRealLifecycle, realWorkspaceWritable, reconcileLifecycleOperations } from './real-lifecycle'

const pairKey = (runId: string, id: string) => `${runId}/${id}`
const narrativeKey = (runId: string, targetId?: string) => JSON.stringify([runId, targetId ?? null])
const narrativeWorkActive = (value: RealAnalysisSummariesResponse) =>
  value.scoring.initialized < value.scoring.total || value.scoring.queued > 0 || value.scoring.running > 0 ||
  [value.counts.candidates, value.counts.targets].some((count) => count.waiting + count.queued + count.running > 0)

export function RealAnalysesBridge({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return <RealAnalysesProvider key={workspaceId} workspaceId={workspaceId}>{children}</RealAnalysesProvider>
}

function RealAnalysesProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const parent = useWorkspace()
  const parentRef = useRef(parent)
  parentRef.current = parent
  const location = useLocation()
  const [scope] = useState(() => new RealRequestScope())
  const [features, setFeatures] = useState<AnalysisProcessingFeatures | null>(null)
  const featuresRef = useRef(features)
  const historyAvailable = useRef(false)
  const [phase, setPhase] = useState<RealAnalysesContextValue['phase']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<RealAnalysisRunSummary[]>([])
  const summariesRef = useRef(summaries)
  const knownIds = useRef(new Set<string>())
  const [targets, setTargets] = useState<RealLoadState<RealAnalysisTargetSummary[]>>({ state: 'idle' })
  const targetsRef = useRef(targets)
  const [details, setDetails] = useState<Record<string, RealLoadState<RealAnalysisRunDetail>>>({})
  const detailRef = useRef(details)
  const [comparisons, setComparisons] = useState<Record<string, RealLoadState<RealAnalysisComparisonSummary[]>>>({})
  const comparisonsRef = useRef(comparisons)
  const [results, setResults] = useState<Record<string, RealLoadState<RealAnalysisComparisonDetail>>>({})
  const resultsRef = useRef(results)
  const [narratives, setNarratives] = useState<Record<string, RealLoadState<RealAnalysisSummariesResponse>>>({})
  const narrativesRef = useRef(narratives)
  const narrativeScopes = useRef(new Map<string, { runId: string; targetId?: string }>())
  const narrativeRequests = useRef(new Map<string, { key: string; etag: string; runId: string }>())
  const pairSummaries = useRef(new Map<string, RealAnalysisComparisonSummary>())
  const createKeys = useRef(new Map<string, string>())
  const [pendingCount, setPendingCount] = useState(0)
  const [pendingLifecycle, setPendingLifecycleState] = useState<PendingLifecycleChange[]>([])
  const pendingLifecycleRef = useRef(pendingLifecycle)
  const setPendingLifecycle = useCallback((next: PendingLifecycleChange[]) => {
    pendingLifecycleRef.current = next
    setPendingLifecycleState(next)
  }, [])
  const canWrite = realWorkspaceWritable(parent, workspaceId)
  const leaveGuard = useGradeLeaveGuard(false, pendingCount > 0, 'Analysis request (not yet acknowledged)')

  const putDetail = useCallback((id: string, entry: RealLoadState<RealAnalysisRunDetail>) => {
    detailRef.current = { ...detailRef.current, [id]: entry }
    setDetails(detailRef.current)
  }, [])
  const putComparisons = useCallback((id: string, entry: RealLoadState<RealAnalysisComparisonSummary[]>) => {
    comparisonsRef.current = { ...comparisonsRef.current, [id]: entry }
    setComparisons(comparisonsRef.current)
  }, [])
  const putResult = useCallback((key: string, entry: RealLoadState<RealAnalysisComparisonDetail>) => {
    resultsRef.current = { ...resultsRef.current, [key]: entry }
    setResults(resultsRef.current)
  }, [])
  const putNarratives = useCallback((key: string, entry: RealLoadState<RealAnalysisSummariesResponse>) => {
    narrativesRef.current = { ...narrativesRef.current, [key]: entry }
    setNarratives(narrativesRef.current)
  }, [])

  const clearRunContent = useCallback((id: string) => {
    const removedScopes = new Set([...narrativeScopes.current].filter(([, item]) => item.runId === id).map(([key]) => key))
    scope.cancelReads((key) => key === `detail:${id}` || key === `pairs:${id}` || key.startsWith(`result:${id}/`) ||
      key.startsWith(`document:${id}/`) || key.startsWith(`diagnostics:${id}/`) ||
      [...removedScopes].some((item) => key === `narratives:${item}`))
    putDetail(id, { state: 'error', error: 'This analysis was removed or is awaiting permanent cleanup. Cached inputs and results are no longer available.' })
    const next = { ...comparisonsRef.current }; delete next[id]
    comparisonsRef.current = next; setComparisons(next)
    resultsRef.current = Object.fromEntries(Object.entries(resultsRef.current).filter(([key]) => !key.startsWith(`${id}/`)))
    setResults(resultsRef.current)
    narrativesRef.current = Object.fromEntries(Object.entries(narrativesRef.current).filter(([key]) => !removedScopes.has(key)))
    setNarratives(narrativesRef.current)
    for (const key of removedScopes) narrativeScopes.current.delete(key)
    for (const [key, request] of narrativeRequests.current) if (request.runId === id) narrativeRequests.current.delete(key)
    for (const key of pairSummaries.current.keys()) if (key.startsWith(`${id}/`)) pairSummaries.current.delete(key)
  }, [putDetail, scope])

  const removeRun = useCallback((id: string, sequence: number) => {
    if (!scope.accept(`run:${id}`, sequence)) return
    summariesRef.current = summariesRef.current.filter((item) => item.run.id !== id)
    setSummaries(summariesRef.current)
    clearRunContent(id)
  }, [clearRunContent, scope])

  const rememberRun = useCallback((summary: RealAnalysisRunSummary, sequence: number) => {
    if (!scope.accept(`run:${summary.run.id}`, sequence)) return false
    knownIds.current.add(summary.run.id)
    summariesRef.current = [summary, ...summariesRef.current.filter((item) => item.run.id !== summary.run.id)]
      .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
    setSummaries(summariesRef.current)
    const cached = detailRef.current[summary.run.id]
    if (lifecycleIsRemoved(summary.lifecycle ?? summary.run.lifecycle)) clearRunContent(summary.run.id)
    else if (cached?.state === 'ready' && cached.value.etag !== summary.etag) {
      // The input manifest is immutable; only the acknowledged control/progress summary changes.
      putDetail(summary.run.id, { state: 'ready', value: { ...cached.value, ...summary } })
    }
    return true
  }, [clearRunContent, putDetail, scope])

  useEffect(() => {
    setPendingLifecycle(reconcileLifecycleOperations(pendingLifecycleRef.current, summaries.map((summary) =>
      discoveredLifecycle({ kind: 'analysis', id: summary.run.id }, getDisplayName(summary.run, summary.run.name), summary.lifecycle ?? summary.run.lifecycle, summary.operation))))
  }, [setPendingLifecycle, summaries])

  const readableRun = useCallback((id: string) => {
    const summary = summariesRef.current.find((item) => item.run.id === id)
    if (!summary && knownIds.current.has(id)) return false
    return !lifecycleIsRemoved(summary?.lifecycle ?? summary?.run.lifecycle)
      && !pendingLifecycleRef.current.some((item) => item.target.id === id && item.operation.action === 'delete')
  }, [])

  const rememberPair = useCallback((summary: RealAnalysisComparisonSummary, sequence: number) => {
    const { runId, id } = summary.comparison
    const key = pairKey(runId, id)
    if (!scope.accept(`pair:${key}`, sequence)) return false
    pairSummaries.current.set(key, summary)
    const cached = resultsRef.current[key]
    if (cached?.state === 'ready' && cached.value.etag !== summary.etag) putResult(key, { state: 'idle' })
    return true
  }, [putResult, scope])

  const ensureDetail = useCallback(async function loadDetail(id: string, force = false): Promise<void> {
    if (!historyAvailable.current) return
    if (!readableRun(id)) return
    const previous = detailRef.current[id]
    if (!force && previous && !['idle', 'loading'].includes(previous.state)) return
    const ticket = scope.read(`detail:${id}`)
    if (!ticket) return
    let superseded = false
    if (previous?.state !== 'ready') putDetail(id, { state: 'loading' })
    try {
      const value = await api.getRealAnalysis(workspaceId, id, ticket.controller.signal)
      if (!scope.current(ticket)) return
      if (lifecycleIsRemoved(value.lifecycle ?? value.run.lifecycle)) { superseded = !rememberRun(value, ticket.sequence); return }
      if (rememberRun(value, ticket.sequence) || summariesRef.current.find((item) => item.run.id === id)?.etag === value.etag) putDetail(id, { state: 'ready', value })
      else superseded = true
    } catch (caught) {
      if (!scope.current(ticket)) return
      if (!scope.canAccept(`run:${id}`, ticket.sequence)) { superseded = true; return }
      if (caught instanceof CloudApiError && [403, 404].includes(caught.status)) { removeRun(id, ticket.sequence); return }
      const message = realRequestError(caught, 'The saved real analysis could not be opened.')
      putDetail(id, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
    } finally {
      scope.finish(ticket)
      if (superseded) void loadDetail(id, true)
    }
  }, [putDetail, readableRun, rememberRun, removeRun, scope, workspaceId])

  const ensureComparisons = useCallback(async (id: string, force = false) => {
    if (!historyAvailable.current || !readableRun(id)) return
    const previous = comparisonsRef.current[id]
    if (!force && previous && !['idle', 'loading'].includes(previous.state)) return
    const ticket = scope.read(`pairs:${id}`)
    if (!ticket) return
    if (previous?.state !== 'ready') putComparisons(id, { state: 'loading' })
    try {
      const values = await api.listAllRealAnalysisComparisons(workspaceId, id, ticket.controller.signal)
      if (!scope.current(ticket) || !readableRun(id)) return
      for (const summary of values) rememberPair(summary, ticket.sequence)
      const merged = new Map<string, RealAnalysisComparisonSummary>()
      for (const summary of values) merged.set(summary.comparison.id, pairSummaries.current.get(pairKey(id, summary.comparison.id)) ?? summary)
      putComparisons(id, { state: 'ready', value: [...merged.values()].sort((a, b) => a.comparison.index - b.comparison.index) })
    } catch (caught) {
      if (!scope.current(ticket)) return
      if (caught instanceof CloudApiError && [403, 404].includes(caught.status)) { removeRun(id, ticket.sequence); return }
      const message = realRequestError(caught, 'The real comparisons could not be loaded.')
      putComparisons(id, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
    } finally { scope.finish(ticket) }
  }, [putComparisons, readableRun, rememberPair, removeRun, scope, workspaceId])

  const ensureComparison = useCallback(async function loadComparison(runId: string, id: string, force = false): Promise<void> {
    if (!historyAvailable.current || !readableRun(runId)) return
    const key = pairKey(runId, id)
    const previous = resultsRef.current[key]
    if (!force && previous && !['idle', 'loading'].includes(previous.state)) return
    const ticket = scope.read(`result:${key}`)
    if (!ticket) return
    let superseded = false
    if (previous?.state !== 'ready') putResult(key, { state: 'loading' })
    try {
      const value = await api.getRealAnalysisComparison(workspaceId, runId, id, ticket.controller.signal)
      if (!scope.current(ticket) || !readableRun(runId)) return
      if (rememberPair(value, ticket.sequence) || pairSummaries.current.get(key)?.etag === value.etag) putResult(key, { state: 'ready', value })
      else superseded = true
    } catch (caught) {
      if (!scope.current(ticket)) return
      if (!scope.canAccept(`pair:${key}`, ticket.sequence)) { superseded = true; return }
      if (caught instanceof CloudApiError && [403, 404].includes(caught.status)) {
        scope.cancelReads((request) => request === `diagnostics:${key}`)
        pairSummaries.current.delete(key)
        putResult(key, { state: 'error', error: 'This saved comparison is no longer available. Cached source snapshots have been cleared.' })
        return
      }
      const message = realRequestError(caught, 'This saved comparison could not be opened.')
      putResult(key, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
    } finally {
      scope.finish(ticket)
      if (superseded) void loadComparison(runId, id, true)
    }
  }, [putResult, readableRun, rememberPair, scope, workspaceId])

  const rememberNarratives = useCallback((value: RealAnalysisSummariesResponse, sequence: number) => {
    const key = narrativeKey(value.runId, value.scope.targetId ?? undefined)
    if (!readableRun(value.runId) || !scope.accept(`narrative:${key}`, sequence)) return
    narrativeScopes.current.set(key, { runId: value.runId, ...(value.scope.targetId ? { targetId: value.scope.targetId } : {}) })
    putNarratives(key, { state: 'ready', value })
  }, [putNarratives, readableRun, scope])

  const ensureNarratives = useCallback(async (runId: string, targetId?: string, force = false) => {
    if (!historyAvailable.current || !readableRun(runId)) return
    const key = narrativeKey(runId, targetId)
    narrativeScopes.current.set(key, { runId, targetId })
    const previous = narrativesRef.current[key]
    if (!force && previous && !['idle', 'loading'].includes(previous.state)) return
    const ticket = scope.read(`narratives:${key}`)
    if (!ticket) return
    if (previous?.state !== 'ready') putNarratives(key, { state: 'loading' })
    try {
      const value = await api.getRealAnalysisSummaries(workspaceId, runId, targetId ? { targetId } : {}, ticket.controller.signal)
      if (!scope.current(ticket) || !readableRun(runId)) return
      rememberNarratives(value, ticket.sequence)
    } catch (caught) {
      if (!scope.current(ticket) || !readableRun(runId) || !scope.canAccept(`narrative:${key}`, ticket.sequence)) return
      const inaccessible = caught instanceof CloudApiError && [401, 403, 404].includes(caught.status)
      const message = realRequestError(caught, 'Saved summaries could not be loaded. Scores and frozen evidence are unchanged.')
      putNarratives(key, previous?.state === 'ready' && !inaccessible
        ? { ...previous, error: message } : { state: 'error', error: message })
      if (inaccessible) void ensureDetail(runId, true)
    } finally { scope.finish(ticket) }
  }, [ensureDetail, putNarratives, readableRun, rememberNarratives, scope, workspaceId])

  const invalidateNarratives = useCallback((runId: string, targetId?: string) => {
    for (const [key, selected] of narrativeScopes.current) {
      if (selected.runId !== runId || (targetId && selected.targetId && selected.targetId !== targetId)) continue
      const previous = narrativesRef.current[key]
      if (previous?.state === 'ready') putNarratives(key, { ...previous, error: 'Summary state changed. Refreshing its current revision; previous text is not current for export.' })
      else putNarratives(key, { state: 'idle' })
    }
  }, [putNarratives])

  const refreshTargets = useCallback(async () => {
    if (!featuresRef.current?.realAnalyses) return
    const ticket = scope.read('$targets')
    if (!ticket) return
    const previous = targetsRef.current
    if (previous.state !== 'ready') { targetsRef.current = { state: 'loading' }; setTargets(targetsRef.current) }
    try {
      const value = await api.listAllRealAnalysisTargets(workspaceId, ticket.controller.signal)
      if (!scope.current(ticket) || !featuresRef.current?.realAnalyses) return
      targetsRef.current = { state: 'ready', value }
      setTargets(targetsRef.current)
    } catch (caught) {
      if (!scope.current(ticket) || !featuresRef.current?.realAnalyses) return
      const message = realRequestError(caught, 'Eligible real job and approved GS targets could not be loaded.')
      targetsRef.current = previous.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message }
      setTargets(targetsRef.current)
    } finally { scope.finish(ticket) }
  }, [scope, workspaceId])

  const refresh = useCallback(async () => {
    const creationTicket = scope.read('$features')
    const ticket = scope.read('$list')
    if (!creationTicket && !ticket) return
    const checkCreation = async () => {
      if (!creationTicket) return
      try {
        const available = await api.fetchAnalysisProcessingFeatures(creationTicket.controller.signal)
        if (!scope.current(creationTicket)) return
        featuresRef.current = available
        setFeatures(available)
        if (available.realAnalyses) {
          setCreationError(null)
          if (targetsRef.current.state !== 'ready') void refreshTargets()
        } else {
          const message = 'New analyses are unavailable because their source or processing dependencies are not enabled. Saved history and frozen evidence remain separate; no samples are substituted.'
          setCreationError(message)
          targetsRef.current = { state: 'error', error: message }
          setTargets(targetsRef.current)
        }
      } catch (caught) {
        if (!scope.current(creationTicket)) return
        const message = realRequestError(caught, 'New-run readiness could not be checked. Creation remains disabled.')
        featuresRef.current = null
        setFeatures(null)
        setCreationError(message)
        targetsRef.current = { state: 'error', error: message }
        setTargets(targetsRef.current)
      } finally { scope.finish(creationTicket) }
    }
    const readHistory = async () => {
      if (!ticket) return
      try {
        // Creation readiness is not historical availability; existing runs own their frozen inputs.
        const values = await api.listAllRealAnalyses(workspaceId, ticket.controller.signal)
        if (!scope.current(ticket)) return
        historyAvailable.current = true
        scope.reconcile('run:', ticket.sequence)
        const present = new Set(values.map((item) => item.run.id))
        const cachedIds = new Set([...summariesRef.current.map((item) => item.run.id), ...Object.keys(detailRef.current), ...Object.keys(comparisonsRef.current)])
        for (const id of cachedIds) if (!present.has(id)) removeRun(id, ticket.sequence)
        for (const summary of values) rememberRun(summary, ticket.sequence)
        setPhase('ready')
        setError(null)
        for (const [id, entry] of Object.entries(detailRef.current)) {
          if (entry.state === 'idle' || entry.state === 'loading') void ensureDetail(id, true)
        }
        for (const [id, entry] of Object.entries(comparisonsRef.current)) {
          if (entry.state === 'idle' || entry.state === 'loading') void ensureComparisons(id, true)
        }
      } catch (caught) {
        if (!scope.current(ticket)) return
        if (caught instanceof CloudApiError && [401, 403].includes(caught.status)) {
          scope.reconcile('run:', ticket.sequence)
          for (const item of summariesRef.current) removeRun(item.run.id, ticket.sequence)
        }
        historyAvailable.current = false
        setPhase(caught instanceof CloudApiError && [404, 503].includes(caught.status) ? 'unavailable' : 'error')
        setError(realRequestError(caught, 'The saved real analysis history is unavailable.'))
      } finally { scope.finish(ticket) }
    }
    await Promise.all([checkCreation(), readHistory()])
  }, [ensureComparisons, ensureDetail, refreshTargets, rememberRun, removeRun, scope, workspaceId])

  useEffect(() => {
    scope.activate()
    void refresh()
    return () => scope.close()
  }, [refresh, scope])

  useEffect(() => {
    void refreshTargets()
  }, [location.key, features?.realAnalyses, refreshTargets])

  useEffect(() => {
    if (phase !== 'ready' || (!summaries.some(active) && !Object.values(comparisons).some((entry) => entry.state === 'ready'
      && entry.value.some((item) => ['queued', 'running'].includes(item.comparison.status))))) return
    const timer = window.setInterval(() => {
      void refresh()
      for (const [id, entry] of Object.entries(detailRef.current)) {
        if (entry.state === 'idle' || entry.state === 'loading' || (entry.state === 'ready' && active(entry.value))) {
          void ensureDetail(id, true)
          if (comparisonsRef.current[id]?.state !== 'error') void ensureComparisons(id, true)
        }
      }
      for (const [id, entry] of Object.entries(comparisonsRef.current)) {
        if (entry.state === 'idle' || entry.state === 'loading' || (entry.state === 'ready' && entry.value.some((item) => ['queued', 'running'].includes(item.comparison.status)))) void ensureComparisons(id, true)
      }
      for (const [key, entry] of Object.entries(resultsRef.current)) {
        if (entry.state === 'ready' && ['queued', 'running'].includes(entry.value.comparison.status)) {
          void ensureComparison(entry.value.comparison.runId, entry.value.comparison.id, true)
        } else if (entry.state === 'idle' || entry.state === 'loading') {
          const summary = pairSummaries.current.get(key)
          if (summary) void ensureComparison(summary.comparison.runId, summary.comparison.id, true)
        }
      }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [comparisons, ensureComparison, ensureComparisons, ensureDetail, phase, refresh, summaries])

  const scoringRevision = summaries.map((item) => `${item.run.id}:${item.etag}`).join('|')
  useEffect(() => {
    if (phase !== 'ready') return
    for (const selected of narrativeScopes.current.values()) void ensureNarratives(selected.runId, selected.targetId, true)
  }, [ensureNarratives, phase, scoringRevision])

  useEffect(() => {
    if (phase !== 'ready' || !Object.values(narratives).some((entry) => entry.state === 'idle' || entry.state === 'loading' ||
      (entry.state === 'ready' && (entry.error || narrativeWorkActive(entry.value))))) return
    const timer = window.setInterval(() => {
      for (const [key, selected] of narrativeScopes.current) {
        const entry = narrativesRef.current[key]
        if (entry?.state === 'idle' || entry?.state === 'loading' || (entry?.state === 'ready' && (entry.error || narrativeWorkActive(entry.value)))) {
          void ensureNarratives(selected.runId, selected.targetId, true)
        }
      }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [ensureNarratives, narratives, phase])

  useEffect(() => {
    const focus = () => {
      void refresh(); void refreshTargets()
      for (const selected of narrativeScopes.current.values()) void ensureNarratives(selected.runId, selected.targetId, true)
    }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [ensureNarratives, refresh, refreshTargets])

  async function mutate<T>(runId: string | undefined, operation: () => Promise<T>, commit: (value: T, sequence: number) => void, lifecycle = false, summariesOnly = false): Promise<T> {
    if (lifecycle) {
      assertRealLifecyclePermission(parentRef.current, workspaceId)
      await parentRef.current.cloud?.flushSave()
      assertRealLifecyclePermission(parentRef.current, workspaceId)
    } else {
      if (!realWorkspaceWritable(parentRef.current, workspaceId)) throw new Error('This workspace is archived, read-only, or unavailable. An owner or editor must make changes to analyses.')
      if (!historyAvailable.current || phase !== 'ready') throw new Error('The saved analysis service is unavailable. Refresh before submitting.')
      if (runId) {
        const summary = summariesRef.current.find((item) => item.run.id === runId)
        const metadata = summary?.lifecycle ?? summary?.run.lifecycle
        if (!summary || metadata?.archivedAt || lifecycleIsRemoved(metadata) || pendingLifecycleRef.current.some((item) => item.target.id === runId)) {
          throw new Error('This analysis is archived, removed, or has incomplete cleanup. Unarchive the run before editing it or starting new processing.')
        }
      }
    }
    const ticket = scope.mutate(runId ? `run:${runId}` : '$create')
    leaveGuard.hold()
    setPendingCount((value) => value + 1)
    try {
      const value = await operation()
      if (!scope.mutationCurrent(ticket)) throw new Error('The workspace changed before acknowledgement. Reopen the original workspace to check the saved analysis.')
      commit(value, ticket.sequence)
      return value
    } catch (caught) {
      if (caught instanceof CloudConflictError) {
        if (summariesOnly) throw new Error('The selected summary scope changed. Refresh summaries and review the scope before submitting again. Scores and frozen evidence were not changed.')
        throw new Error('The saved inputs or processing state changed. Reload and review before trying again. Score did not substitute newer versions or resend an action with a new ETag.')
      }
      throw caught
    } finally {
      const current = scope.mutationCurrent(ticket)
      scope.finishMutation(ticket)
      if (current) {
        setPendingCount((value) => value - 1)
        if (!scope.busy) {
          leaveGuard.release()
          void refresh()
          if (runId) {
            if (!summariesOnly) { void ensureDetail(runId, true); void ensureComparisons(runId, true) }
            for (const selected of narrativeScopes.current.values()) {
              if (selected.runId === runId) void ensureNarratives(runId, selected.targetId, true)
            }
          }
        }
        void parentRef.current.cloud?.refreshWorkspaces().catch(() => undefined)
      }
    }
  }

  function commitPair(summary: RealAnalysisComparisonSummary, sequence: number) {
    rememberPair(summary, sequence)
    const current = comparisonsRef.current[summary.comparison.runId]
    if (current?.state === 'ready') putComparisons(summary.comparison.runId, {
      state: 'ready', value: current.value.map((item) => item.comparison.id === summary.comparison.id ? summary : item),
    })
  }

  const value: RealAnalysesContextValue = {
    workspaceId, canWrite, phase, features, error, creationError, summaries, targets, refresh, refreshTargets, ensureDetail, ensureComparisons, ensureComparison, ensureNarratives,
    detail: (id) => details[id] ?? { state: 'idle' },
    comparisons: (id) => comparisons[id] ?? { state: 'idle' },
    comparison: (runId, id) => results[pairKey(runId, id)] ?? { state: 'idle' },
    narratives: (runId, targetId) => narratives[narrativeKey(runId, targetId)] ?? { state: 'idle' },
    generateSummaries: async (runId, input, etag) => {
      if (featuresRef.current?.analysisSummaryGeneration !== true) throw new Error('Summary generation is unavailable. Saved summaries, scores, and frozen evidence remain separate from new-run readiness.')
      const cached = narrativesRef.current[narrativeKey(runId, input.targetId)]
      if (cached?.state !== 'ready' || cached.error || cached.value.etag !== etag) throw new Error('Refresh the selected summary scope before generating summaries.')
      if (!cached.value.capabilities.canGenerate) throw new Error('Summary generation is not permitted for this saved analysis. Check its access and lifecycle status.')
      if ([cached.value.counts.candidates, cached.value.counts.targets].some((count) => count.queued + count.running > 0)) {
        throw new Error('Summaries in this scope are already generating. Wait for the acknowledged work to finish.')
      }
      const fingerprint = JSON.stringify([runId, input.targetId ?? null, input.mode])
      const request = narrativeRequests.current.get(fingerprint) ?? { key: crypto.randomUUID(), etag, runId }
      narrativeRequests.current.set(fingerprint, request)
      const result = await mutate(runId, async () => {
        try { return await api.generateRealAnalysisSummaries(workspaceId, runId, input, request.etag, request.key) }
        catch (caught) {
          if (caught instanceof CloudApiError && caught.status >= 400 && caught.status < 500 && ![408, 429].includes(caught.status)) {
            narrativeRequests.current.delete(fingerprint)
          }
          throw caught
        }
      }, (response, sequence) => {
        invalidateNarratives(runId, input.targetId)
        rememberNarratives(response.summaries, sequence)
      }, false, true)
      narrativeRequests.current.delete(fingerprint)
      return result
    },
    pending: (id) => scope.pending(id ? `run:${id}` : '$create'),
    requestKey: (input) => {
      const fingerprint = JSON.stringify(input)
      const key = createKeys.current.get(fingerprint) ?? crypto.randomUUID()
      createKeys.current.set(fingerprint, key)
      return key
    },
    create: async (input, key) => {
      if (!featuresRef.current?.realAnalyses) throw new Error(creationError ?? 'New analyses are unavailable. Restore source readiness before creating a run; saved runs are unchanged.')
      const workspace = parentRef.current.workspace
      if (input.resumes.some((item) => isEntityArchived(workspace, { kind: 'resume', id: item.resumeId }) || isEntityRemoved(workspace, { kind: 'resume', id: item.resumeId }))
        || input.targets.some((item) => !realTargetAvailable(workspace, item))) throw new Error('Archived or removed inputs cannot start a new analysis. Review all selections; nothing was skipped.')
      const result = await mutate(undefined, () => api.createRealAnalysis(workspaceId, input, key), rememberRun)
      if (createKeys.current.get(JSON.stringify(input)) === key) createKeys.current.delete(JSON.stringify(input))
      return result
    },
    retry: (id, input, etag) => mutate(id, () => api.retryRealAnalysis(workspaceId, id, input, etag), (summary, sequence) => { invalidateNarratives(id); rememberRun(summary, sequence) }),
    cancel: (id, etag) => mutate(id, () => api.cancelRealAnalysis(workspaceId, id, etag), (summary, sequence) => { invalidateNarratives(id); rememberRun(summary, sequence) }),
    retryComparison: (runId, id, etag) => mutate(runId, () => api.retryRealAnalysisComparison(workspaceId, runId, id, etag), (summary, sequence) => { invalidateNarratives(runId, summary.comparison.target.summary.id); commitPair(summary, sequence) }),
    cancelComparison: (runId, id, etag) => mutate(runId, () => api.cancelRealAnalysisComparison(workspaceId, runId, id, etag), (summary, sequence) => { invalidateNarratives(runId, summary.comparison.target.summary.id); commitPair(summary, sequence) }),
    document: async (runId, comparisonId, id, version, signal) => {
      if (!historyAvailable.current || !readableRun(runId)) throw new Error('The saved analysis document service is unavailable or this analysis is being deleted.')
      const ticket = scope.read(`document:${runId}/${crypto.randomUUID()}`)
      if (!ticket) throw new Error('Wait for the pending analysis request, then retry opening its saved evidence.')
      try {
        const document = await api.getRealAnalysisDocument(workspaceId, runId, comparisonId, id, version,
          signal ? AbortSignal.any([signal, ticket.controller.signal]) : ticket.controller.signal)
        if (!scope.current(ticket) || !readableRun(runId) || signal?.aborted) throw new DOMException('The saved source request was cancelled.', 'AbortError')
        return document
      } finally { scope.finish(ticket) }
    },
    diagnostics: async (runId, comparisonId, continuationToken, signal) => {
      signal?.throwIfAborted()
      if (!historyAvailable.current || !readableRun(runId)) throw new Error('The private diagnostic service is unavailable or this analysis is being deleted.')
      const ticket = scope.read(`diagnostics:${pairKey(runId, comparisonId)}`)
      if (!ticket) throw new Error('Wait for the pending analysis request, then retry opening its private diagnostics.')
      const cancel = () => { ticket.controller.abort(); scope.finish(ticket) }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const page = await api.getRealAnalysisDiagnostics(workspaceId, runId, comparisonId, continuationToken,
          signal ? AbortSignal.any([signal, ticket.controller.signal]) : ticket.controller.signal)
        if (!scope.current(ticket) || !readableRun(runId) || signal?.aborted) throw new DOMException('The private diagnostic request was cancelled.', 'AbortError')
        const run = summariesRef.current.find((item) => item.run.id === runId)?.run
        if (run && page.attempts.some((attempt) => attempt.manifestSha256 !== run.manifest.sha256)) {
          throw new Error('The private diagnostic does not match this run’s frozen input manifest. Reload the saved comparison.')
        }
        return page
      } finally { signal?.removeEventListener('abort', cancel); scope.finish(ticket) }
    },
  }
  function owns(target: LifecycleTarget) {
    return target.kind === 'analysis' && (knownIds.current.has(target.id) || pendingLifecycleRef.current.some((item) => item.target.id === target.id))
  }

  async function renameEntity(target: RenameEntityTarget, name: string, etag?: string) {
    if (!owns(target)) return parentRef.current.renameEntity(target, name, etag)
    if (!etag) throw new Error('Reload this analysis before editing its name.')
    await mutate(target.id, () => api.renameRealAnalysis(workspaceId, target.id, name, etag), rememberRun)
    parentRef.current.notify('Analysis name saved. Source evidence and results are unchanged.')
  }

  async function changeLifecycle(target: LifecycleTarget, action: LifecycleAction) {
    if (!owns(target)) return parentRef.current.changeLifecycle(target, action)
    const pending = pendingLifecycleRef.current.find((item) => item.target.id === target.id)
    if (pending && pending.operation.action !== action) throw new Error('Finish the incomplete analysis lifecycle operation before choosing another action.')
    const result = await mutate(target.id, async () => {
      const fresh = await api.getRealAnalysis(workspaceId, target.id)
      return api.changeRealAnalysisLifecycle(workspaceId, target.id, action, fresh.etag)
    }, (response, sequence) => {
      if (response.analysis) {
        rememberRun(response.analysis, sequence)
        if (!lifecycleIsRemoved(response.analysis.lifecycle ?? response.analysis.run.lifecycle)) putDetail(target.id, { state: 'ready', value: response.analysis })
      }
      if (response.operation && response.operation.status !== 'complete') {
        const summary = summariesRef.current.find((item) => item.run.id === target.id)
        setPendingLifecycle(reconcileLifecycleOperations(pendingLifecycleRef.current, [{
          target, name: summary ? getDisplayName(summary.run, summary.run.name) : pending?.name ?? 'Real analysis', operation: response.operation,
        }]))
        if (action === 'delete') clearRunContent(target.id)
      } else if (response.deleted) removeRun(target.id, sequence)
    }, true)
    if (result.operation && result.operation.status !== 'complete') throw new LifecycleOperationError(result.operation)
    if (!result.analysis && !result.deleted) throw new Error('The analysis service has not acknowledged a completed lifecycle change. Refresh status before retrying.')
    setPendingLifecycle(pendingLifecycleRef.current.filter((item) => item.target.id !== target.id))
    parentRef.current.notify(action === 'delete' ? 'Permanent analysis deletion acknowledged.' : action === 'archive' ? 'Analysis archived. Its own unfinished comparisons were stopped; completed evidence is preserved.' : 'Analysis unarchived. Scoring has not restarted.')
  }

  const workspace = useMemo(() => projectRealLifecycle(parent.workspace, 'analysis', summaries.map((item) => ({
    id: item.run.id, lifecycle: item.lifecycle ?? item.run.lifecycle,
  }))), [parent.workspace, summaries])
  const projected = {
    ...parent, workspace, changeLifecycle, renameEntity,
    getLifecycleImpact: (target: LifecycleTarget) => owns(target) ? api.getRealAnalysisLifecycleImpact(workspaceId, target.id) : parentRef.current.getLifecycleImpact(target),
    lifecycleOperations: [...(parent.lifecycleOperations ?? []), ...pendingLifecycle],
  }
  return <WorkspaceContext.Provider value={projected}><RealAnalysesContext.Provider value={value}>{children}</RealAnalysesContext.Provider></WorkspaceContext.Provider>
}
