import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { JobProcessingFeatures, RealJobDetail, RealJobSummary } from '../domain/real-jobs'
import { CloudApiError, CloudConflictError, LifecycleOperationError } from '../services/cloudWorkspace'
import {
  cancelRealJob,
  fetchJobProcessingFeatures,
  getRealJob,
  importRealJobFile,
  importRealJobMarkdown,
  importRealJobPdf,
  importRealJobUrl,
  listAllRealJobs,
  realJobOriginalUrl,
  renameRealJob,
  retryRealJob,
  saveRealJobRubric,
  getRealJobLifecycleImpact, changeRealJobLifecycle,
} from '../services/realJobs'
import type { Rubric } from '../domain/types'
import { WorkspaceContext, type CloudWorkspaceStatus, type PendingLifecycleChange, type RenameEntityTarget, type WorkspaceContextValue } from './workspace-context'
import { getDisplayName } from '../domain/displayNames'
import { uploadedFileKind } from '../domain/source-files'
import { projectRealJobs } from './realJobsProjection'
import { isEntityArchived, isEntityRemoved, type LifecycleAction, type LifecycleTarget } from '../domain/lifecycle'
import { assertClientAdmission, clientAdmissionReason, usePublicSettings } from './public-settings-context'
import { boundedPollingInterval, jobFeaturesWithPolicy } from '../services/publicSettings'

const ACTIVE_STATUSES = new Set(['queued', 'parsing', 'generating'])

type DetailEntry =
  | { state: 'loading' }
  | { state: 'ready'; value: RealJobDetail }
  | { state: 'error'; error: string }

type PendingJobLifecycle = PendingLifecycleChange & { jobId: string; scope: 'job' | 'rubric' }

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
  const policy = usePublicSettings()
  const pollingInterval = boundedPollingInterval(policy.settings, true)
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
  const epoch = useRef(0)
  const sequence = useRef(0)
  const accepted = useRef(new Map<string, number>())
  const authoritativeSequence = useRef(0)
  const mutating = useRef(0)
  const summariesRef = useRef(summaries)
  summariesRef.current = summaries
  const currentCloud = useRef(cloud)
  currentCloud.current = cloud
  const [pendingLifecycle, setPendingLifecycleState] = useState<PendingJobLifecycle[]>([])
  const pendingLifecycleRef = useRef(pendingLifecycle)
  const setPendingLifecycle = useCallback((update: (current: PendingJobLifecycle[]) => PendingJobLifecycle[]) => {
    const next = update(pendingLifecycleRef.current)
    pendingLifecycleRef.current = next
    setPendingLifecycleState(next)
  }, [])

  useEffect(() => {
    setPendingLifecycle((current) => {
      const next = [...current]
      for (const summary of summaries) for (const scope of ['job', 'rubric'] as const) {
        const metadata = scope === 'job' ? summary.lifecycle : summary.rubricLifecycle
        if (!metadata?.deletingAt || metadata.deletedAt || next.some((item) => item.jobId === summary.job.id && item.scope === scope)) continue
        next.push({
          jobId: summary.job.id, scope,
          target: { kind: scope, id: scope === 'job' ? summary.job.id : summary.rubric?.groupId ?? summary.job.rubricId ?? `rubric-${summary.job.id}` },
          name: scope === 'job' ? getDisplayName(summary, summary.job.title) : summary.rubric?.name ?? `${getDisplayName(summary, summary.job.title)} rubric`,
          operation: { id: `${scope}-delete:${summary.job.id}`, action: 'delete', status: 'pending', updatedAt: metadata.deletingAt },
        })
      }
      return next
    })
  }, [setPendingLifecycle, summaries])

  const upsertSummary = useCallback((summary: RealJobSummary, requestSequence: number) => {
    if ((accepted.current.get(summary.job.id) ?? authoritativeSequence.current) > requestSequence) return false
    accepted.current.set(summary.job.id, requestSequence)
    setSummaries((current) => latestSummaryById([...current, summary]))
    return true
  }, [])

  const refresh = useCallback(async () => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current
    if (mutating.current) return
    const controller = new AbortController()
    const started = epoch.current
    const readSequence = ++sequence.current
    listControllerRef.current?.abort()
    listControllerRef.current = controller
    const request = Promise.all([
      listAllRealJobs(workspaceId, controller.signal),
      fetchJobProcessingFeatures(controller.signal).catch(() => null),
    ]).then(([items, available]) => {
      if (!aliveRef.current || controller.signal.aborted || started !== epoch.current) return
      setFeatures(available)
      authoritativeSequence.current = readSequence
      const present = new Set(items.map((item) => item.job.id))
      const fresh = items.filter((item) => (accepted.current.get(item.job.id) ?? 0) <= readSequence)
      fresh.forEach((item) => accepted.current.set(item.job.id, readSequence))
      for (const item of summariesRef.current) if (!present.has(item.job.id) && (accepted.current.get(item.job.id) ?? 0) <= readSequence) {
        accepted.current.set(item.job.id, readSequence)
        detailControllersRef.current.get(item.job.id)?.abort()
        detailControllersRef.current.delete(item.job.id)
      }
      setSummaries((current) => latestSummaryById([...fresh, ...current.filter((item) => (accepted.current.get(item.job.id) ?? 0) > readSequence)]))
      setDetails((current) => {
        const next = { ...current }
        for (const id of Object.keys(next)) if (!present.has(id) && (accepted.current.get(id) ?? 0) <= readSequence) delete next[id]
        for (const summary of fresh) {
          const cached = next[summary.job.id]
          if (cached?.state === 'ready' && cached.value.etag !== summary.etag) delete next[summary.job.id]
        }
        return next
      })
      setListError(null)
      setPhase('ready')
    }).catch((error: unknown) => {
      if (!aliveRef.current || controller.signal.aborted || started !== epoch.current) return
      setListError(errorMessage(error, 'Score could not load real jobs from the service.'))
      setPhase('error')
    }).finally(() => {
      if (listControllerRef.current === controller) { listControllerRef.current = null; refreshPromiseRef.current = null }
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
    void refresh()
    return () => {
      aliveRef.current = false
      controller.abort()
      listControllerRef.current?.abort()
      listControllerRef.current = null
      refreshPromiseRef.current = null
      detailControllers.forEach((item) => item.abort())
      detailControllers.clear()
    }
  }, [refresh, workspaceId])

  useEffect(() => {
    if (phase !== 'ready' || !summaries.some((item) => ACTIVE_STATUSES.has(item.job.status))) return
    const timer = window.setInterval(() => { void refresh() }, pollingInterval)
    return () => window.clearInterval(timer)
  }, [phase, pollingInterval, refresh, summaries])

  useEffect(() => { void refresh() }, [policy.settings?.revision, refresh])

  useEffect(() => {
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const ensureDetail = useCallback(async (jobId: string, force = false) => {
    if (mutating.current) return
    if (!force && detailControllersRef.current.has(jobId)) return
    const current = details[jobId]
    if (!force && current) return
    detailControllersRef.current.get(jobId)?.abort()
    const controller = new AbortController()
    const started = epoch.current
    const readSequence = ++sequence.current
    detailControllersRef.current.set(jobId, controller)
    setDetails((value) => ({ ...value, [jobId]: { state: 'loading' } }))
    try {
      const detail = await getRealJob(workspaceId, jobId, controller.signal)
      if (!aliveRef.current || controller.signal.aborted || started !== epoch.current) return
      if (upsertSummary(detail, readSequence)) setDetails((value) => ({ ...value, [jobId]: { state: 'ready', value: detail } }))
      else if (detailControllersRef.current.get(jobId) === controller) setDetails((value) => {
        if (value[jobId]?.state !== 'loading') return value
        const next = { ...value }; delete next[jobId]; return next
      })
    } catch (error) {
      if (!aliveRef.current || controller.signal.aborted || started !== epoch.current || (accepted.current.get(jobId) ?? authoritativeSequence.current) > readSequence) return
      if (error instanceof CloudApiError && error.status === 404) {
        accepted.current.set(jobId, readSequence)
        setSummaries((current) => current.filter((item) => item.job.id !== jobId))
      }
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

  function requirePermission(target?: LifecycleTarget, lifecycle = false) {
    const state = currentCloud.current
    const metadata = state.workspaces.find((item) => item.id === workspaceId)
    if (!metadata || metadata.role === 'viewer' || metadata.deletedAt) throw new Error('This workspace is read-only or unavailable.')
    if (!lifecycle && (metadata.archivedAt || (metadata.lifecycleOperation && metadata.lifecycleOperation.status !== 'complete') || (target && (isEntityArchived(workspace, target) || isEntityRemoved(workspace, target))))) {
      throw new Error('Archived content is read-only. Unarchive its parent and the item before editing or starting work.')
    }
  }

  async function mutate<T>(operation: () => Promise<T>, accept: (result: T, stamp: number) => void, target?: LifecycleTarget, lifecycle = false): Promise<T> {
    requirePermission(target, lifecycle)
    if (lifecycle) await currentCloud.current.flushSave()
    const stamp = ++sequence.current
    ++epoch.current; mutating.current++
    listControllerRef.current?.abort(); listControllerRef.current = null; refreshPromiseRef.current = null
    detailControllersRef.current.forEach((controller) => controller.abort()); detailControllersRef.current.clear()
    setDetails((entries) => Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.state !== 'loading')))
    try {
      const result = await operation()
      if (!aliveRef.current) throw new Error('The workspace changed before the response arrived. Reopen the item to verify its saved state.')
      accept(result, stamp)
      return result
    } finally {
      mutating.current--
      if (aliveRef.current) {
        void refresh()
        void currentCloud.current.refreshWorkspaces().catch(() => undefined)
      }
    }
  }

  const remember = (result: RealJobSummary | RealJobDetail, stamp: number) => {
    if (!upsertSummary(result, stamp)) return
    setDetails((current) => {
      const next = { ...current }
      if ('rubricVersions' in result) next[result.job.id] = { state: 'ready', value: result }
      else delete next[result.job.id]
      return next
    })
  }

  function importPdf(file: File, idempotencyKey: string, batchId?: string) {
    assertNewImports()
    return mutate(() => importRealJobPdf(workspaceId, file, idempotencyKey, batchId, undefined, policy.settings), remember)
  }

  function importUrl(url: string, idempotencyKey: string, batchId?: string) {
    assertNewImports()
    return mutate(() => importRealJobUrl(workspaceId, url, idempotencyKey, batchId, undefined, policy.settings), remember)
  }

  function assertNewImports() {
    assertClientAdmission(policy, 'jobImports')
    if (!features?.realJobImports || phase !== 'ready') throw new Error('New job imports are unavailable. Saved jobs and evidence remain readable.')
  }

  function assertMarkdownAvailable() {
    if (!features?.realJobImports || !features.markdownJobImports) {
      throw new Error('Markdown job imports are not enabled in this deployment. PDF and direct URL imports are unchanged.')
    }
  }

  async function importMarkdown(file: File, idempotencyKey: string, batchId?: string) {
    assertNewImports()
    assertMarkdownAvailable()
    return mutate(() => importRealJobMarkdown(workspaceId, file, idempotencyKey, batchId, undefined, policy.settings), remember)
  }

  async function importFile(file: File, idempotencyKey: string, batchId?: string) {
    assertNewImports()
    if (uploadedFileKind(file) === 'markdown') assertMarkdownAvailable()
    if (['docx', 'doc'].includes(uploadedFileKind(file) ?? '') && (!features?.realJobImports || !features.wordDocumentImports)) {
      throw new Error('Word document imports are not enabled in this deployment.')
    }
    return mutate(() => importRealJobFile(workspaceId, file, idempotencyKey, batchId, undefined, policy.settings), remember)
  }

  async function cancelJob(id: string) {
    const job = workspace.jobs.find((item) => item.id === id)
    if (job?.dataKind !== 'real') return legacyValue.cancelJob(id)
    try {
      await mutate(() => cancelRealJob(workspaceId, id), remember, { kind: 'job', id })
    } catch (error) {
      if (aliveRef.current) legacyValue.notify(errorMessage(error, 'Score could not cancel this job. Its server processing may still continue.'))
    }
  }

  async function retryJob(id: string) {
    const job = workspace.jobs.find((item) => item.id === id)
    if (job?.dataKind !== 'real') return legacyValue.retryJob(id)
    try {
      if (job.rubricDeletedAt) throw new Error('This job has no rubric because it was permanently deleted. Retrying an import cannot restore it.')
      const rubric = workspace.rubrics.find((item) => item.jobId === id)
      if (rubric && isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId })) throw new Error('Unarchive this job’s logical rubric before retrying processing.')
      await mutate(() => retryRealJob(workspaceId, id), remember, { kind: 'job', id })
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
    const maximum = Math.min(20, policy.settings?.rubrics.jobs.maxCriteria ?? features?.limits.maxCriteria ?? 20)
    if (rubric.criteria.length > maximum && rubric.criteria.some(criterion => !summary.rubric?.criteria.some(previous => previous.id === criterion.id))) {
      throw new Error(`Application policy allows at most ${maximum} criteria when adding new criteria. Existing saved criteria can still be reviewed and edited.`)
    }
    if (summary.job.rubricDeletedAt || summary.rubricLifecycle?.deletingAt || summary.rubricLifecycle?.deletedAt) throw new Error('This logical rubric was permanently removed or is awaiting cleanup. Saving an older draft cannot restore it.')
    try {
      const detail = await mutate(() => saveRealJobRubric(workspaceId, jobId, rubric, summary.etag), remember, { kind: 'rubric', id: rubric.groupId })
      if (!detail.rubric || detail.job.rubricDeletedAt) throw new Error('The service did not acknowledge a current rubric. No older version was substituted.')
      legacyValue.notify(`${detail.rubric?.name ?? rubric.name} saved as reviewer-edited version ${detail.rubric?.version ?? rubric.version + 1}.`)
      return detail.rubric.id
    } catch (error) {
      if (error instanceof CloudConflictError) {
        await Promise.all([refresh(), ensureDetail(jobId, true)])
        throw new Error('This rubric changed in another session. The latest server version is now shown; review it before saving a new version.')
      }
      throw error
    }
  }

  async function renameEntity(target: RenameEntityTarget, name: string, etag?: string) {
    if (target.kind !== 'job' || !workspace.jobs.some((job) => job.id === target.id && job.dataKind === 'real')) {
      return legacyValue.renameEntity(target, name, etag)
    }
    if (!etag) throw new Error('Reload this job before editing its display title.')
    if (phase !== 'ready') throw new Error('The job service is unavailable. Refresh it before editing the title.')
    try {
      await mutate(() => renameRealJob(workspaceId, target.id, name, etag), (summary, stamp) => {
        if (!upsertSummary(summary, stamp)) return
        setDetails((current) => {
          const cached = current[target.id]
          if (cached?.state === 'ready' && cached.value.etag === etag) {
            return { ...current, [target.id]: { state: 'ready', value: { ...cached.value, ...summary } } }
          }
          const next = { ...current }; delete next[target.id]; return next
        })
      }, target)
      legacyValue.notify('Job display title saved. The original job and rubric are unchanged.')
    } catch (error) {
      if (error instanceof CloudConflictError) throw new Error('This job changed. Reload its current title before trying again; your edit has not overwritten it.')
      throw error
    }
  }

  function startAnalysis(resumeIds: string[], rubricIds: string[], name?: string, failFirst?: boolean): string {
    if (rubricIds.some((id) => workspace.rubrics.find((rubric) => rubric.id === id)?.dataKind === 'real')) {
      throw new Error('Real job rubrics cannot use the demo scorer. Use the separate real analysis workflow with ready real resumes.')
    }
    return legacyValue.startAnalysis(resumeIds, rubricIds, name, failFirst)
  }

  function realTarget(target: LifecycleTarget) {
    if (target.kind === 'job') return summariesRef.current.find((item) => item.job.id === target.id)
    if (target.kind !== 'rubric') return undefined
    const rubric = workspace.rubrics.find((item) => (item.id === target.id || item.groupId === target.id) && item.dataKind === 'real' && item.kind === 'job')
    return rubric ? summariesRef.current.find((item) => item.job.id === rubric.jobId) : undefined
  }

  async function changeLifecycle(target: LifecycleTarget, action: LifecycleAction) {
    const pending = pendingLifecycleRef.current.find((item) => item.target.kind === target.kind && item.target.id === target.id)
    let summary = realTarget(target)
    if (pending) {
      if (action !== pending.operation.action) throw new Error('Finish the incomplete lifecycle operation before choosing another action.')
      try { summary = await getRealJob(workspaceId, pending.jobId) } catch (error) {
        if (error instanceof CloudApiError && error.status === 404 && action === 'delete') {
          throw new CloudApiError('not_found', 'This cleanup target is no longer readable. It may have been removed or access may have changed; completion has not been confirmed.', 404)
        }
        const retained = summariesRef.current.find((item) => item.job.id === pending.jobId)
        if (!(error instanceof CloudApiError) || error.code !== 'unavailable' || !retained?.etag) throw error
        console.warn('Score could not refresh pending job cleanup. Retrying the confirmed operation with its last acknowledged ETag.', { error: error.name, status: error.status })
        summary = retained
      }
    }
    if (!summary) return legacyValue.changeLifecycle(target, action)
    const currentSummary = summary
    const scope = pending?.scope ?? (target.kind === 'job' ? 'job' : 'rubric')
    const result = await mutate(() => changeRealJobLifecycle(workspaceId, currentSummary.job.id, scope, action, currentSummary.etag), (response, stamp) => {
      if (response.job) remember(response.job, stamp)
      else if (response.deleted && scope === 'job') {
        accepted.current.set(currentSummary.job.id, stamp)
        setSummaries((items) => items.filter((item) => item.job.id !== currentSummary.job.id))
        setDetails((entries) => { const next = { ...entries }; delete next[currentSummary.job.id]; return next })
      } else if (response.deleted && scope === 'rubric') {
        const removedAt = new Date().toISOString()
        remember({ ...currentSummary, rubric: null, rubricLifecycle: { deletedAt: removedAt }, job: { ...currentSummary.job, rubricId: null, rubricDeletedAt: removedAt } }, stamp)
      }
    }, target, true)
    if (result.operation && result.operation.status !== 'complete') {
      setPendingLifecycle((current) => [...current.filter((item) => !(item.jobId === currentSummary.job.id && item.scope === scope)), {
        target, jobId: currentSummary.job.id, scope,
        name: pending?.name ?? (scope === 'job' ? getDisplayName(currentSummary, currentSummary.job.title) : currentSummary.rubric?.name ?? `${getDisplayName(currentSummary, currentSummary.job.title)} rubric`),
        operation: result.operation!,
      }])
      throw new LifecycleOperationError(result.operation)
    }
    if (!result.job && !result.deleted) throw new Error('The service has not acknowledged this lifecycle change. Refresh and retry.')
    setPendingLifecycle((current) => current.filter((item) => !(item.jobId === currentSummary.job.id && item.scope === scope)))
    legacyValue.notify(action === 'delete' ? 'Permanent deletion acknowledged by the job service.' : action === 'archive' ? 'Archive acknowledged. Owned unfinished processing was cancelled.' : 'Unarchive acknowledged. Processing has not restarted.')
  }

  const realJobs: CloudWorkspaceStatus['realJobs'] = {
    phase,
    features: features ? { ...jobFeaturesWithPolicy(features, policy.settings), realJobImports: features.realJobImports && !clientAdmissionReason(policy, 'jobImports') } : null,
    summaries,
    error: listError,
    detail: (jobId) => details[jobId] ?? { state: 'idle' },
    source: (jobId) => summaries.find((item) => item.job.id === jobId)?.source,
    ensureDetail,
    refresh,
    importPdf,
    importMarkdown,
    importFile,
    importUrl,
    originalUrl: (jobId) => realJobOriginalUrl(workspaceId, jobId),
  }
  const value: WorkspaceContextValue = {
    ...legacyValue,
    workspace,
    cancelJob,
    retryJob,
    saveRubric,
    renameEntity,
    startAnalysis,
    getLifecycleImpact: (target) => {
      const pending = pendingLifecycleRef.current.find((item) => item.target.kind === target.kind && item.target.id === target.id)
      if (pending) return getRealJobLifecycleImpact(workspaceId, pending.jobId, pending.scope)
      const summary = realTarget(target)
      return summary ? getRealJobLifecycleImpact(workspaceId, summary.job.id, target.kind === 'job' ? 'job' : 'rubric') : legacyValue.getLifecycleImpact(target)
    },
    changeLifecycle,
    lifecycleOperations: [...(legacyValue.lifecycleOperations ?? []), ...pendingLifecycle],
    resetDemo: () => {
      legacyValue.resetDemo()
      legacyValue.notify('Sample content was reset. Server-owned real resumes, analyses, jobs, and rubric versions were not changed.')
    },
    cloud: { ...cloud, realJobs },
  }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
