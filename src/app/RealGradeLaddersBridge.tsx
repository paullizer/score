import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { GradeLadderDetail, GradeLadderSummary, GradeProcessingFeatures, GradeRubricVersionRecord } from '../domain/real-grades'
import * as api from '../services/gradeLadders'
import { CloudConflictError } from '../services/cloudWorkspace'
import { gradeSummaryStamp, gradeWorkActive, projectRealGrades } from '../features/grade-ladders/gradeUi'
import { GradeLaddersContext, type GradeLaddersContextValue, type GradeLoadState } from './grade-ladders-context'
import { useGradeLeaveGuard } from './grade-navigation-context'
import { useWorkspace, WorkspaceContext } from './workspace-context'

export function RealGradeLaddersBridge({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const parent = useWorkspace()
  const location = useLocation()
  const alive = useRef(true)
  const epoch = useRef(0)
  const readSequence = useRef(0)
  const acceptedSequence = useRef(new Map<string, number>())
  const mutating = useRef(false)
  const [pending, setPending] = useState(false)
  const [features, setFeatures] = useState<GradeProcessingFeatures | null>(null)
  const featuresRef = useRef<GradeProcessingFeatures | null>(null)
  const [phase, setPhase] = useState<GradeLaddersContextValue['phase']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<GradeLadderSummary[]>([])
  const [details, setDetails] = useState<Record<string, GradeLoadState<GradeLadderDetail>>>({})
  const detailRef = useRef(details)
  const reads = useRef(new Map<string, AbortController>())
  const listPromise = useRef<Promise<void> | null>(null)
  const [historyVersions, setHistoryVersions] = useState<GradeRubricVersionRecord[]>([])
  const canWrite = parent.cloud?.workspaces.some((workspace) => workspace.id === workspaceId && workspace.role !== 'viewer') ?? false
  const mutationGuard = useGradeLeaveGuard(false, pending, 'A grade-ladder change')

  const putDetail = useCallback((id: string, entry: GradeLoadState<GradeLadderDetail>) => {
    detailRef.current = { ...detailRef.current, [id]: entry }
    setDetails(detailRef.current)
  }, [])
  const remember = useCallback((detail: GradeLadderDetail, sequence: number) => {
    if ((acceptedSequence.current.get(detail.ladder.id) ?? 0) > sequence) return
    acceptedSequence.current.set(detail.ladder.id, sequence)
    putDetail(detail.ladder.id, { state: 'ready', value: detail })
    setSummaries((current) => [detail, ...current.filter((item) => item.ladder.id !== detail.ladder.id)].sort((a, b) => b.ladder.updatedAt.localeCompare(a.ladder.updatedAt)))
  }, [putDetail])

  const ensureDetail = useCallback(async (id: string, force = false) => {
    if (!featuresRef.current?.realGradeLadders) return
    if (!force && (detailRef.current[id] || reads.current.has(id))) return
    if (mutating.current) return
    reads.current.get(id)?.abort()
    const controller = new AbortController()
    reads.current.set(id, controller)
    const started = epoch.current
    const sequence = ++readSequence.current
    const previous = detailRef.current[id]
    if (previous?.state !== 'ready') putDetail(id, { state: 'loading' })
    try {
      const detail = await api.getGradeLadder(workspaceId, id, controller.signal)
      if (!alive.current || controller.signal.aborted || started !== epoch.current) return
      remember(detail, sequence)
    } catch (caught) {
      if (!alive.current || controller.signal.aborted || started !== epoch.current) return
      const message = caught instanceof Error ? caught.message : 'The grade ladder could not be loaded.'
      putDetail(id, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
    } finally {
      if (reads.current.get(id) === controller) reads.current.delete(id)
    }
  }, [putDetail, remember, workspaceId])

  const refresh = useCallback(async () => {
    if (listPromise.current) return listPromise.current
    if (mutating.current) return
    const started = epoch.current
    const sequence = ++readSequence.current
    const controller = new AbortController()
    reads.current.set('$list', controller)
    const request = (async () => {
      try {
        const available = await api.fetchGradeProcessingFeatures(controller.signal)
        if (!alive.current || controller.signal.aborted || started !== epoch.current) return
        setFeatures(available)
        featuresRef.current = available
        if (!available.realGradeLadders) {
          setPhase('unavailable')
          setError('Real GS ladders are not enabled in this deployment. No samples are substituted.')
          return
        }
        const items = await api.listAllGradeLadders(workspaceId, controller.signal)
        if (!alive.current || controller.signal.aborted || started !== epoch.current) return
        const fresh = items.filter((item) => (acceptedSequence.current.get(item.ladder.id) ?? 0) <= sequence)
        setSummaries((current) => {
          const merged = new Map(current.map((item) => [item.ladder.id, item]))
          for (const item of fresh) merged.set(item.ladder.id, item)
          return [...merged.values()].sort((a, b) => b.ladder.updatedAt.localeCompare(a.ladder.updatedAt))
        })
        setPhase('ready')
        setError(null)
        for (const item of fresh) {
          const cached = detailRef.current[item.ladder.id]
          if (cached?.state === 'ready' && gradeSummaryStamp(cached.value) !== gradeSummaryStamp(item)) void ensureDetail(item.ladder.id, true)
        }
      } catch (caught) {
        if (!alive.current || controller.signal.aborted || started !== epoch.current) return
        setPhase('error')
        setError(caught instanceof Error ? caught.message : 'The real grade library is unavailable.')
      } finally {
        if (reads.current.get('$list') === controller) {
          reads.current.delete('$list')
          listPromise.current = null
        }
      }
    })()
    listPromise.current = request
    return request
  }, [ensureDetail, workspaceId])

  useEffect(() => {
    alive.current = true
    const controllers = reads.current
    void refresh()
    return () => {
      alive.current = false
      controllers.forEach((controller) => controller.abort())
      controllers.clear()
      listPromise.current = null
    }
  }, [refresh])

  useEffect(() => {
    const detailIsActive = Object.values(details).some((entry) => entry.state === 'ready' && !entry.error && gradeWorkActive(entry.value))
    if (phase !== 'ready' || (!summaries.some(gradeWorkActive) && !detailIsActive)) return
    const timer = window.setInterval(() => {
      void refresh()
      for (const [id, entry] of Object.entries(detailRef.current)) {
        if (entry.state === 'ready' && !entry.error && gradeWorkActive(entry.value) && !reads.current.has(id)) void ensureDetail(id, true)
      }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [details, ensureDetail, phase, refresh, summaries])

  useEffect(() => {
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [refresh])

  useEffect(() => {
    if (!features?.realGradeLadders) return
    const parts = location.pathname.split('/').filter(Boolean)
    const id = parts[0] === 'grade-ladders' && parts[1] !== 'new' ? parts[1] : new URLSearchParams(location.search).get('ladder')
    if (id) void ensureDetail(id)
  }, [ensureDetail, features?.realGradeLadders, location.pathname, location.search])

  async function mutate(operation: () => Promise<GradeLadderDetail>, id?: string): Promise<GradeLadderDetail> {
    if (!canWrite) throw new Error('This workspace is read-only. An owner or editor must make grade-ladder changes.')
    if (!features?.realGradeLadders) throw new Error('Real grade ladders are not available in this deployment.')
    if (mutating.current) throw new Error('Wait for the current grade request before making another change.')
    mutating.current = true
    mutationGuard.hold()
    epoch.current++
    const sequence = ++readSequence.current
    setPending(true)
    reads.current.forEach((controller) => controller.abort())
    reads.current.clear()
    listPromise.current = null
    for (const [key, entry] of Object.entries(detailRef.current)) {
      if (entry.state === 'loading') {
        const next = { ...detailRef.current }
        delete next[key]
        detailRef.current = next
        setDetails(next)
      }
    }
    try {
      // Mutations intentionally have no unmount AbortSignal: acceptance may precede navigation.
      const detail = await operation()
      if (!alive.current) throw new Error('The workspace changed before the server response arrived. Reopen this ladder to check its saved state.')
      remember(detail, sequence)
      return detail
    } catch (caught) {
      if (alive.current && caught instanceof CloudConflictError && id) {
        mutating.current = false
        await ensureDetail(id, true)
        throw new Error('Another session changed this record. Your unsaved draft is kept; inspect the latest server version before retrying. Nothing was overwritten.')
      }
      throw caught
    } finally {
      mutating.current = false
      if (alive.current) { setPending(false); mutationGuard.release() }
    }
  }

  const versions = useMemo(() => {
    const all = new Map(historyVersions.map((version) => [version.id, version]))
    for (const detail of Object.values(details)) if (detail.state === 'ready') for (const level of detail.value.levels) if (level.version) all.set(level.version.id, level.version)
    return [...all.values()]
  }, [details, historyVersions])
  const workspace = useMemo(() => projectRealGrades(parent.workspace, versions), [parent.workspace, versions])

  const value: GradeLaddersContextValue = {
    workspaceId, canWrite, phase, features, error, summaries, mutationPending: pending,
    detail: (id) => details[id] ?? { state: 'idle' }, ensureDetail, refresh,
    create: (input, key) => mutate(() => api.createGradeLadder(workspaceId, input, key)),
    update: (id, input, etag) => mutate(() => api.updateGradeLadder(workspaceId, id, input, etag), id),
    discover: (id, etag, key) => mutate(() => api.discoverGradeSources(workspaceId, id, etag, key), id),
    uploadPdf: (id, file, key, pages) => mutate(() => api.uploadGradeSourcePdf(workspaceId, id, file, key, pages), id),
    addUrl: (id, input, key) => mutate(() => api.addGradeSourceUrl(workspaceId, id, input, key), id),
    updateSource: (id, sourceId, input, etag) => mutate(() => api.updateGradeSource(workspaceId, id, sourceId, input, etag), id),
    confirmSources: (id, input, etag, key) => mutate(() => api.confirmGradeSources(workspaceId, id, input, etag, key), id),
    generate: (id, etag, key) => mutate(() => api.generateGradeLadder(workspaceId, id, etag, key), id),
    retry: (id, input, etag) => mutate(() => api.retryGradeWork(workspaceId, id, input, etag), id),
    cancel: (id, input, etag) => mutate(() => api.cancelGradeWork(workspaceId, id, input, etag), id),
    saveDraft: (id, grade, input, etag) => mutate(() => api.saveGradeDraft(workspaceId, id, grade, input, etag), id),
    approve: (id, grade, input, etag) => mutate(() => api.approveGrade(workspaceId, id, grade, input, etag), id),
    versions: async (id, grade, signal) => {
      const records = await api.listAllGradeVersions(workspaceId, id, grade, signal)
      if (alive.current && !signal?.aborted) {
        setHistoryVersions((current) => [...new Map([...current, ...records].map((record) => [record.id, record])).values()])
      }
      return records
    },
    sourceSet: (id, sourceSetId, signal) => api.getGradeSourceSet(workspaceId, id, sourceSetId, signal),
    document: (id, sourceId, sourceSetId, signal) => api.getGradeSourceDocument(workspaceId, id, sourceId, sourceSetId, signal),
    originalUrl: (id, sourceId, sourceSetId) => api.gradeSourceOriginalUrl(workspaceId, id, sourceId, sourceSetId),
    locateRubric: (rubricId) => versions.filter((version) => version.rubric.id === rubricId).sort((a, b) => b.version - a.version)[0],
  }
  return <GradeLaddersContext.Provider value={value}><WorkspaceContext.Provider value={{
    ...parent,
    workspace,
    saveRubric: (rubric, duplicate) => {
      if (rubric.kind === 'grade' && (rubric.dataKind === 'real' || versions.some((version) => version.rubric.id === rubric.id))) {
        throw new Error('Edit real grades in their ladder. They cannot be saved or duplicated into sample content.')
      }
      return parent.saveRubric(rubric, duplicate)
    },
    startAnalysis: (resumeIds, rubricIds, name, failFirst) => {
      if (rubricIds.some((id) => workspace.rubrics.find((rubric) => rubric.id === id)?.dataKind === 'real')) {
        throw new Error('Real job and GS grade rubrics cannot use demo scoring, including mixed or directly preselected inputs.')
      }
      return parent.startAnalysis(resumeIds, rubricIds, name, failFirst)
    },
    resetDemo: () => {
      parent.resetDemo()
      parent.notify('Only samples were reset. Real resumes, analyses, jobs, grade ladders, captured sources, and saved versions are unchanged.')
    },
  }}>{children}</WorkspaceContext.Provider></GradeLaddersContext.Provider>
}
