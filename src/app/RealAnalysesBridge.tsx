import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type {
  AnalysisProcessingFeatures, RealAnalysisComparisonDetail, RealAnalysisComparisonSummary, RealAnalysisRunDetail,
  RealAnalysisRunSummary, RealAnalysisTargetSummary,
} from '../domain/real-analyses'
import * as api from '../services/realAnalyses'
import { CloudApiError, CloudConflictError } from '../services/cloudWorkspace'
import { useWorkspace } from './workspace-context'
import { useGradeLeaveGuard } from './grade-navigation-context'
import { RealAnalysesContext, type RealAnalysesContextValue } from './real-analyses-context'
import { RealRequestScope, realRequestError, type RealLoadState } from './real-request-scope'
import { realAnalysisWorkActive as active } from '../features/analyses/realAnalysisUi'

const pairKey = (runId: string, id: string) => `${runId}/${id}`

export function RealAnalysesBridge({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return <RealAnalysesProvider key={workspaceId} workspaceId={workspaceId}>{children}</RealAnalysesProvider>
}

function RealAnalysesProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const { cloud } = useWorkspace()
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
  const [targets, setTargets] = useState<RealLoadState<RealAnalysisTargetSummary[]>>({ state: 'idle' })
  const targetsRef = useRef(targets)
  const [details, setDetails] = useState<Record<string, RealLoadState<RealAnalysisRunDetail>>>({})
  const detailRef = useRef(details)
  const [comparisons, setComparisons] = useState<Record<string, RealLoadState<RealAnalysisComparisonSummary[]>>>({})
  const comparisonsRef = useRef(comparisons)
  const [results, setResults] = useState<Record<string, RealLoadState<RealAnalysisComparisonDetail>>>({})
  const resultsRef = useRef(results)
  const pairSummaries = useRef(new Map<string, RealAnalysisComparisonSummary>())
  const createKeys = useRef(new Map<string, string>())
  const [pendingCount, setPendingCount] = useState(0)
  const canWrite = cloud?.workspaces.some((item) => item.id === workspaceId && item.role !== 'viewer') ?? false
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

  const rememberRun = useCallback((summary: RealAnalysisRunSummary, sequence: number) => {
    if (!scope.accept(`run:${summary.run.id}`, sequence)) return false
    summariesRef.current = [summary, ...summariesRef.current.filter((item) => item.run.id !== summary.run.id)]
      .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
    setSummaries(summariesRef.current)
    const cached = detailRef.current[summary.run.id]
    if (cached?.state === 'ready' && cached.value.etag !== summary.etag) {
      // The input manifest is immutable; only the acknowledged control/progress summary changes.
      putDetail(summary.run.id, { state: 'ready', value: { ...cached.value, ...summary } })
    }
    return true
  }, [putDetail, scope])

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
    const previous = detailRef.current[id]
    if (!force && previous && !['idle', 'loading'].includes(previous.state)) return
    const ticket = scope.read(`detail:${id}`)
    if (!ticket) return
    let superseded = false
    if (previous?.state !== 'ready') putDetail(id, { state: 'loading' })
    try {
      const value = await api.getRealAnalysis(workspaceId, id, ticket.controller.signal)
      if (!scope.current(ticket)) return
      if (rememberRun(value, ticket.sequence) || summariesRef.current.find((item) => item.run.id === id)?.etag === value.etag) putDetail(id, { state: 'ready', value })
      else superseded = true
    } catch (caught) {
      if (!scope.current(ticket)) return
      const message = realRequestError(caught, 'The saved real analysis could not be opened.')
      putDetail(id, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
    } finally {
      scope.finish(ticket)
      if (superseded) void loadDetail(id, true)
    }
  }, [putDetail, rememberRun, scope, workspaceId])

  const ensureComparisons = useCallback(async (id: string, force = false) => {
    if (!historyAvailable.current) return
    const previous = comparisonsRef.current[id]
    if (!force && previous && !['idle', 'loading'].includes(previous.state)) return
    const ticket = scope.read(`pairs:${id}`)
    if (!ticket) return
    if (previous?.state !== 'ready') putComparisons(id, { state: 'loading' })
    try {
      const values = await api.listAllRealAnalysisComparisons(workspaceId, id, ticket.controller.signal)
      if (!scope.current(ticket)) return
      for (const summary of values) rememberPair(summary, ticket.sequence)
      const merged = new Map((previous?.state === 'ready' ? previous.value : []).map((item) => [item.comparison.id, item]))
      for (const summary of values) merged.set(summary.comparison.id, pairSummaries.current.get(pairKey(id, summary.comparison.id)) ?? summary)
      putComparisons(id, { state: 'ready', value: [...merged.values()].sort((a, b) => a.comparison.index - b.comparison.index) })
    } catch (caught) {
      if (!scope.current(ticket)) return
      const message = realRequestError(caught, 'The real comparisons could not be loaded.')
      putComparisons(id, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
    } finally { scope.finish(ticket) }
  }, [putComparisons, rememberPair, scope, workspaceId])

  const ensureComparison = useCallback(async function loadComparison(runId: string, id: string, force = false): Promise<void> {
    if (!historyAvailable.current) return
    const key = pairKey(runId, id)
    const previous = resultsRef.current[key]
    if (!force && previous && !['idle', 'loading'].includes(previous.state)) return
    const ticket = scope.read(`result:${key}`)
    if (!ticket) return
    let superseded = false
    if (previous?.state !== 'ready') putResult(key, { state: 'loading' })
    try {
      const value = await api.getRealAnalysisComparison(workspaceId, runId, id, ticket.controller.signal)
      if (!scope.current(ticket)) return
      if (rememberPair(value, ticket.sequence) || pairSummaries.current.get(key)?.etag === value.etag) putResult(key, { state: 'ready', value })
      else superseded = true
    } catch (caught) {
      if (!scope.current(ticket)) return
      const message = realRequestError(caught, 'This saved comparison could not be opened.')
      putResult(key, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
    } finally {
      scope.finish(ticket)
      if (superseded) void loadComparison(runId, id, true)
    }
  }, [putResult, rememberPair, scope, workspaceId])

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
        historyAvailable.current = false
        setPhase(caught instanceof CloudApiError && [404, 503].includes(caught.status) ? 'unavailable' : 'error')
        setError(realRequestError(caught, 'The saved real analysis history is unavailable.'))
      } finally { scope.finish(ticket) }
    }
    await Promise.all([checkCreation(), readHistory()])
  }, [ensureComparisons, ensureDetail, refreshTargets, rememberRun, scope, workspaceId])

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

  useEffect(() => {
    const focus = () => { void refresh(); void refreshTargets() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [refresh, refreshTargets])

  async function mutate<T>(runId: string | undefined, operation: () => Promise<T>, commit: (value: T, sequence: number) => void): Promise<T> {
    if (!canWrite) throw new Error('This workspace is read-only. An owner or editor must create, retry, or cancel analyses.')
    if (!historyAvailable.current || phase !== 'ready') throw new Error('The saved analysis service is unavailable. Refresh before submitting.')
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
          if (runId) { void ensureDetail(runId, true); void ensureComparisons(runId, true) }
        }
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
    workspaceId, canWrite, phase, features, error, creationError, summaries, targets, refresh, refreshTargets, ensureDetail, ensureComparisons, ensureComparison,
    detail: (id) => details[id] ?? { state: 'idle' },
    comparisons: (id) => comparisons[id] ?? { state: 'idle' },
    comparison: (runId, id) => results[pairKey(runId, id)] ?? { state: 'idle' },
    pending: (id) => scope.pending(id ? `run:${id}` : '$create'),
    requestKey: (input) => {
      const fingerprint = JSON.stringify(input)
      const key = createKeys.current.get(fingerprint) ?? crypto.randomUUID()
      createKeys.current.set(fingerprint, key)
      return key
    },
    create: async (input, key) => {
      if (!featuresRef.current?.realAnalyses) throw new Error(creationError ?? 'New analyses are unavailable. Restore source readiness before creating a run; saved runs are unchanged.')
      const result = await mutate(undefined, () => api.createRealAnalysis(workspaceId, input, key), rememberRun)
      if (createKeys.current.get(JSON.stringify(input)) === key) createKeys.current.delete(JSON.stringify(input))
      return result
    },
    retry: (id, input, etag) => mutate(id, () => api.retryRealAnalysis(workspaceId, id, input, etag), rememberRun),
    cancel: (id, etag) => mutate(id, () => api.cancelRealAnalysis(workspaceId, id, etag), rememberRun),
    retryComparison: (runId, id, etag) => mutate(runId, () => api.retryRealAnalysisComparison(workspaceId, runId, id, etag), commitPair),
    cancelComparison: (runId, id, etag) => mutate(runId, () => api.cancelRealAnalysisComparison(workspaceId, runId, id, etag), commitPair),
    document: async (runId, comparisonId, id, version, signal) => {
      if (!historyAvailable.current) throw new Error('The saved analysis document service is unavailable.')
      const ticket = scope.read(`document:${crypto.randomUUID()}`)
      if (!ticket) throw new Error('Wait for the pending analysis request, then retry opening its saved evidence.')
      try {
        const document = await api.getRealAnalysisDocument(workspaceId, runId, comparisonId, id, version,
          signal ? AbortSignal.any([signal, ticket.controller.signal]) : ticket.controller.signal)
        if (!scope.current(ticket) || signal?.aborted) throw new DOMException('The saved source request was cancelled.', 'AbortError')
        return document
      } finally { scope.finish(ticket) }
    },
  }
  return <RealAnalysesContext.Provider value={value}>{children}</RealAnalysesContext.Provider>
}
