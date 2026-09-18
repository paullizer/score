import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { JobProcessingFeatures, RealJobDetail, RealJobSummary } from '../domain/real-jobs'
import { CloudConflictError } from '../services/cloudWorkspace'
import {
  cancelRealJob,
  fetchJobProcessingFeatures,
  getRealJob,
  importRealJobPdf,
  importRealJobUrl,
  listAllRealJobs,
  realJobOriginalUrl,
  retryRealJob,
  saveRealJobRubric,
} from '../services/realJobs'
import type { Rubric } from '../domain/types'
import { WorkspaceContext, type CloudWorkspaceStatus, type WorkspaceContextValue } from './workspace-context'
import { projectRealJobs } from './realJobsProjection'

const POLL_INTERVAL_MS = 2000
const ACTIVE_STATUSES = new Set(['queued', 'parsing', 'generating'])

type DetailEntry =
  | { state: 'loading' }
  | { state: 'ready'; value: RealJobDetail }
  | { state: 'error'; error: string }

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function latestSummaryById(items: RealJobSummary[]): RealJobSummary[] {
  const summaries = new Map<string, RealJobSummary>()
  for (const item of items) {
    const current = summaries.get(item.job.id)
    if (!current || current.updatedAt <= item.updatedAt) summaries.set(item.job.id, item)
  }
  return [...summaries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function RealJobsBridge({
  workspaceId,
  legacyValue,
  cloud,
  children,
}: {
  workspaceId: string
  legacyValue: Omit<WorkspaceContextValue, 'cloud'>
  cloud: Omit<CloudWorkspaceStatus, 'realJobs'>
  children: ReactNode
}) {
  const location = useLocation()
  const aliveRef = useRef(true)
  const listControllerRef = useRef<AbortController | null>(null)
  const detailControllersRef = useRef(new Map<string, AbortController>())
  const refreshPromiseRef = useRef<Promise<void> | null>(null)
  const [features, setFeatures] = useState<JobProcessingFeatures | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<RealJobSummary[]>([])
  const [details, setDetails] = useState<Record<string, DetailEntry>>({})

  const upsertSummary = useCallback((summary: RealJobSummary) => {
    setSummaries((current) => latestSummaryById([...current, summary]))
  }, [])

  const refresh = useCallback(async () => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current
    const controller = new AbortController()
    listControllerRef.current?.abort()
    listControllerRef.current = controller
    const request = listAllRealJobs(workspaceId, controller.signal).then((items) => {
      if (!aliveRef.current || controller.signal.aborted) return
      setSummaries((current) => latestSummaryById([...items, ...current]))
      setDetails((current) => {
        const next = { ...current }
        for (const summary of items) {
          const cached = next[summary.job.id]
          if (cached?.state === 'ready' && cached.value.updatedAt < summary.updatedAt) delete next[summary.job.id]
        }
        return next
      })
      setListError(null)
      setPhase('ready')
    }).catch((error: unknown) => {
      if (!aliveRef.current || controller.signal.aborted) return
      setListError(errorMessage(error, 'Score could not load real jobs from the service.'))
      setPhase('error')
    }).finally(() => {
      if (listControllerRef.current === controller) listControllerRef.current = null
      refreshPromiseRef.current = null
    })
    refreshPromiseRef.current = request
    return request
  }, [workspaceId])

  useEffect(() => {
    aliveRef.current = true
    const controller = new AbortController()
    const detailControllers = detailControllersRef.current
    setPhase('loading')
    setFeatures(null)
    setSummaries([])
    setDetails({})
    void fetchJobProcessingFeatures(controller.signal).then((value) => {
      if (!aliveRef.current || controller.signal.aborted) return
      setFeatures(value)
      if (!value.realJobImports) {
        setPhase('unavailable')
        setListError('Real PDF and direct URL imports are not available in this deployment.')
        return
      }
      void refresh()
    }).catch((error: unknown) => {
      if (!aliveRef.current || controller.signal.aborted) return
      setListError(errorMessage(error, 'Score could not check whether real job imports are available.'))
      setPhase('error')
    })
    return () => {
      aliveRef.current = false
      controller.abort()
      listControllerRef.current?.abort()
      detailControllers.forEach((item) => item.abort())
      detailControllers.clear()
    }
  }, [refresh, workspaceId])

  useEffect(() => {
    if (phase !== 'ready' || !summaries.some((item) => ACTIVE_STATUSES.has(item.job.status))) return
    const timer = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [phase, refresh, summaries])

  useEffect(() => {
    const onFocus = () => {
      if (features?.realJobImports) void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [features?.realJobImports, refresh])

  const ensureDetail = useCallback(async (jobId: string, force = false) => {
    if (!force && detailControllersRef.current.has(jobId)) return
    const current = details[jobId]
    if (!force && current) return
    detailControllersRef.current.get(jobId)?.abort()
    const controller = new AbortController()
    detailControllersRef.current.set(jobId, controller)
    setDetails((value) => ({ ...value, [jobId]: { state: 'loading' } }))
    try {
      const detail = await getRealJob(workspaceId, jobId, controller.signal)
      if (!aliveRef.current || controller.signal.aborted) return
      setDetails((value) => ({ ...value, [jobId]: { state: 'ready', value: detail } }))
      upsertSummary(detail)
    } catch (error) {
      if (!aliveRef.current || controller.signal.aborted) return
      setDetails((value) => ({
        ...value,
        [jobId]: { state: 'error', error: errorMessage(error, 'Score could not load this job and its rubric.') },
      }))
    } finally {
      if (detailControllersRef.current.get(jobId) === controller) detailControllersRef.current.delete(jobId)
    }
  }, [details, upsertSummary, workspaceId])

  useEffect(() => {
    const parts = location.pathname.split('/').filter(Boolean)
    if (parts[0] === 'jobs' && parts[1] && summaries.some((item) => item.job.id === parts[1])) {
      void ensureDetail(parts[1])
      return
    }
    if (parts[0] !== 'rubrics' || !parts[1]) return
    const requestedJobId = new URLSearchParams(location.search).get('job')
      ?? summaries.find((item) => item.rubric?.id === parts[1])?.job.id
    if (requestedJobId) void ensureDetail(requestedJobId)
  }, [ensureDetail, location.pathname, location.search, summaries])

  const readyDetails = useMemo(() => Object.values(details).flatMap((entry) => entry.state === 'ready' ? [entry.value] : []), [details])
  const workspace = useMemo(
    () => projectRealJobs(legacyValue.workspace, summaries, readyDetails),
    [legacyValue.workspace, readyDetails, summaries],
  )

  async function importPdf(file: File, idempotencyKey: string, batchId?: string) {
    const summary = await importRealJobPdf(workspaceId, file, idempotencyKey, batchId)
    if (aliveRef.current) upsertSummary(summary)
    return summary
  }

  async function importUrl(url: string, idempotencyKey: string, batchId?: string) {
    const summary = await importRealJobUrl(workspaceId, url, idempotencyKey, batchId)
    if (aliveRef.current) upsertSummary(summary)
    return summary
  }

  async function cancelJob(id: string) {
    const job = workspace.jobs.find((item) => item.id === id)
    if (job?.dataKind !== 'real') return legacyValue.cancelJob(id)
    try {
      const summary = await cancelRealJob(workspaceId, id)
      if (aliveRef.current) upsertSummary(summary)
    } catch (error) {
      if (aliveRef.current) legacyValue.notify(errorMessage(error, 'Score could not cancel this job. Its server processing may still continue.'))
    }
  }

  async function retryJob(id: string) {
    const job = workspace.jobs.find((item) => item.id === id)
    if (job?.dataKind !== 'real') return legacyValue.retryJob(id)
    try {
      const summary = await retryRealJob(workspaceId, id)
      if (aliveRef.current) upsertSummary(summary)
    } catch (error) {
      if (aliveRef.current) legacyValue.notify(errorMessage(error, 'Score could not retry this job.'))
    }
  }

  async function saveRubric(rubric: Rubric, duplicate = false): Promise<string> {
    if (rubric.dataKind !== 'real') return legacyValue.saveRubric(rubric, duplicate)
    if (duplicate) throw new Error('Real job rubrics remain attached to their source job and cannot be duplicated.')
    const jobId = rubric.jobId
    if (!jobId) throw new Error('This real rubric is missing its linked job.')
    const summary = summaries.find((item) => item.job.id === jobId)
    if (!summary) throw new Error('Refresh this job before saving its rubric.')
    try {
      const detail = await saveRealJobRubric(workspaceId, jobId, rubric, summary.etag)
      if (!aliveRef.current) throw new Error('The workspace changed before this rubric save response was received.')
      setDetails((value) => ({ ...value, [jobId]: { state: 'ready', value: detail } }))
      upsertSummary(detail)
      legacyValue.notify(`${detail.rubric?.name ?? rubric.name} saved as reviewer-edited version ${detail.rubric?.version ?? rubric.version + 1}.`)
      return detail.rubric?.id ?? detail.rubricVersions.at(-1)?.id ?? rubric.id
    } catch (error) {
      if (error instanceof CloudConflictError) {
        await Promise.all([refresh(), ensureDetail(jobId, true)])
        throw new Error('This rubric changed in another session. The latest server version is now shown; review it before saving a new version.')
      }
      throw error
    }
  }

  function startAnalysis(resumeIds: string[], rubricIds: string[], name?: string, failFirst?: boolean): string {
    if (rubricIds.some((id) => workspace.rubrics.find((rubric) => rubric.id === id)?.dataKind === 'real')) {
      throw new Error('Real job rubrics cannot use the demo scorer. Use the separate real analysis workflow with ready real resumes.')
    }
    return legacyValue.startAnalysis(resumeIds, rubricIds, name, failFirst)
  }

  const realJobs: CloudWorkspaceStatus['realJobs'] = {
    phase,
    features,
    summaries,
    error: listError,
    detail: (jobId) => details[jobId] ?? { state: 'idle' },
    source: (jobId) => summaries.find((item) => item.job.id === jobId)?.source,
    ensureDetail,
    refresh,
    importPdf,
    importUrl,
    originalUrl: (jobId) => realJobOriginalUrl(workspaceId, jobId),
  }
  const value: WorkspaceContextValue = {
    ...legacyValue,
    workspace,
    cancelJob,
    retryJob,
    saveRubric,
    startAnalysis,
    resetDemo: () => {
      legacyValue.resetDemo()
      legacyValue.notify('Sample content was reset. Server-owned real resumes, analyses, jobs, and rubric versions were not changed.')
    },
    cloud: { ...cloud, realJobs },
  }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
