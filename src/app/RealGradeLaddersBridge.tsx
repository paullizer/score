import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { GradeLadderDetail, GradeLadderSummary, GradeProcessingFeatures, GradeRubricVersionRecord } from '../domain/real-grades'
import * as api from '../services/gradeLadders'
import { CloudApiError, CloudConflictError, LifecycleOperationError } from '../services/cloudWorkspace'
import { gradeSummaryStamp, gradeWorkActive, projectRealGrades } from '../features/grade-ladders/gradeUi'
import { GradeLaddersContext, type GradeLaddersContextValue, type GradeLoadState } from './grade-ladders-context'
import { useGradeLeaveGuard } from './grade-navigation-context'
import { useWorkspace, WorkspaceContext, type PendingLifecycleChange } from './workspace-context'
import { gradeHeadId } from '../domain/real-grades'
import { isEntityArchived, lifecycleIsRemoved, type LifecycleAction, type LifecycleTarget } from '../domain/lifecycle'

type PendingGradeLifecycle = PendingLifecycleChange & { ladderId: string; grade?: number; etag?: string }

export function RealGradeLaddersBridge({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const parent = useWorkspace()
  const location = useLocation()
  const alive = useRef(true)
  const epoch = useRef(0)
  const readSequence = useRef(0)
  const acceptedSequence = useRef(new Map<string, number>())
  const authoritativeSequence = useRef(0)
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
  const [pendingLifecycle, setPendingLifecycleState] = useState<PendingGradeLifecycle[]>([])
  const pendingLifecycleRef = useRef(pendingLifecycle)
  const setPendingLifecycle = useCallback((update: (current: PendingGradeLifecycle[]) => PendingGradeLifecycle[]) => {
    const next = update(pendingLifecycleRef.current)
    pendingLifecycleRef.current = next
    setPendingLifecycleState(next)
  }, [])
  const summariesRef = useRef(summaries)
  summariesRef.current = summaries
  const metadata = parent.cloud?.workspaces.find((workspace) => workspace.id === workspaceId)
  const canManage = Boolean(metadata && metadata.role !== 'viewer' && !metadata.deletedAt)
  const canWrite = canManage && !metadata?.archivedAt && (!metadata?.lifecycleOperation || metadata.lifecycleOperation.status === 'complete')
  const mutationGuard = useGradeLeaveGuard(false, pending, 'A grade-ladder change')

  useEffect(() => {
    setPendingLifecycle((current) => {
      const next = [...current]
      for (const family of summaries) {
        if (family.ladder.lifecycle?.deletingAt && !next.some((item) => item.ladderId === family.ladder.id && item.grade === undefined)) {
          next.push({ target: { kind: 'ladder', id: family.ladder.id }, name: family.ladder.name, ladderId: family.ladder.id, etag: family.etag,
            operation: { id: family.ladder.id, action: 'delete', status: 'pending', updatedAt: family.ladder.lifecycle.deletingAt } })
        }
        for (const level of family.levels) if (level.head.lifecycle?.deletingAt && !next.some((item) => item.ladderId === family.ladder.id && item.grade === level.head.grade)) {
          next.push({ target: { kind: 'rubric', id: level.head.id }, name: `${family.ladder.name} · GS-${level.head.grade}`, ladderId: family.ladder.id, grade: level.head.grade, etag: level.etag,
            operation: { id: level.head.id, action: 'delete', status: 'pending', updatedAt: level.head.lifecycle.deletingAt } })
        }
      }
      return next
    })
  }, [setPendingLifecycle, summaries])

  const putDetail = useCallback((id: string, entry: GradeLoadState<GradeLadderDetail>) => {
    detailRef.current = { ...detailRef.current, [id]: entry }
    setDetails(detailRef.current)
  }, [])
  const remember = useCallback((detail: GradeLadderDetail, sequence: number) => {
    if ((acceptedSequence.current.get(detail.ladder.id) ?? authoritativeSequence.current) > sequence) return false
    acceptedSequence.current.set(detail.ladder.id, sequence)
    putDetail(detail.ladder.id, { state: 'ready', value: detail })
    setHistoryVersions((current) => current.filter((version) => version.ladderId !== detail.ladder.id || detail.levels.some((level) => level.head.grade === version.grade && !lifecycleIsRemoved(level.head.lifecycle))))
    setSummaries((current) => [detail, ...current.filter((item) => item.ladder.id !== detail.ladder.id)].sort((a, b) => b.ladder.updatedAt.localeCompare(a.ladder.updatedAt)))
    return true
  }, [putDetail])

  const ensureDetail = useCallback(async (id: string, force = false) => {
    if (!featuresRef.current?.realGradeLadders) return
    if (!force && ((detailRef.current[id] && detailRef.current[id].state !== 'idle') || reads.current.has(id))) return
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
      if (!remember(detail, sequence) && detailRef.current[id]?.state === 'loading' && reads.current.get(id) === controller) putDetail(id, { state: 'idle' })
    } catch (caught) {
      if (!alive.current || controller.signal.aborted || started !== epoch.current) return
      if ((acceptedSequence.current.get(id) ?? authoritativeSequence.current) > sequence) return
      const message = caught instanceof Error ? caught.message : 'The grade ladder could not be loaded.'
      if (caught instanceof CloudApiError && caught.status === 404) {
        acceptedSequence.current.set(id, sequence)
        setSummaries((current) => current.filter((item) => item.ladder.id !== id))
        setHistoryVersions((current) => current.filter((item) => item.ladderId !== id))
        putDetail(id, { state: 'error', error: message })
      } else putDetail(id, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
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
        authoritativeSequence.current = sequence
        const present = new Set(items.map((item) => item.ladder.id))
        const fresh = items.filter((item) => (acceptedSequence.current.get(item.ladder.id) ?? 0) <= sequence)
        for (const item of fresh) acceptedSequence.current.set(item.ladder.id, sequence)
        for (const item of summariesRef.current) if (!present.has(item.ladder.id) && (acceptedSequence.current.get(item.ladder.id) ?? 0) <= sequence) {
          acceptedSequence.current.set(item.ladder.id, sequence)
          reads.current.get(item.ladder.id)?.abort(); reads.current.delete(item.ladder.id)
        }
        setSummaries((current) => [...fresh, ...current.filter((item) => (acceptedSequence.current.get(item.ladder.id) ?? 0) > sequence)].sort((a, b) => b.ladder.updatedAt.localeCompare(a.ladder.updatedAt)))
        const nextDetails = { ...detailRef.current }
        for (const id of Object.keys(nextDetails)) if (!present.has(id) && (acceptedSequence.current.get(id) ?? 0) <= sequence) nextDetails[id] = { state: 'error', error: 'This grade ladder was deleted or is no longer available in this workspace.' }
        detailRef.current = nextDetails; setDetails(nextDetails)
        setHistoryVersions((current) => current.filter((version) => (acceptedSequence.current.get(version.ladderId) ?? 0) > sequence || items.some((item) => item.ladder.id === version.ladderId && item.levels.some((level) => level.head.grade === version.grade && !lifecycleIsRemoved(level.head.lifecycle)))))
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

  async function mutate(operation: () => Promise<GradeLadderDetail>, id?: string, grade?: number): Promise<GradeLadderDetail> {
    if (!canWrite) throw new Error('This workspace is read-only. An owner or editor must make grade-ladder changes.')
    if (id && !canEdit(id, grade)) throw new Error('Archived or removed content cannot be edited or processed. Unarchive the parent and grade first.')
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
      if (alive.current) { setPending(false); mutationGuard.release(); void parent.cloud?.refreshWorkspaces().catch(() => undefined) }
    }
  }

  const versions = useMemo(() => {
    const all = new Map(historyVersions.map((version) => [version.id, version]))
    for (const detail of Object.values(details)) if (detail.state === 'ready') for (const level of detail.value.levels) if (level.version) all.set(level.version.id, level.version)
    return [...all.values()].filter((version) => !pendingLifecycle.some((item) => item.operation.action === 'delete' && item.ladderId === version.ladderId && (item.grade === undefined || item.grade === version.grade)) &&
      summaries.some((family) => family.ladder.id === version.ladderId && !lifecycleIsRemoved(family.ladder.lifecycle) &&
        family.levels.some((level) => level.head.grade === version.grade && !lifecycleIsRemoved(level.head.lifecycle))))
  }, [details, historyVersions, summaries, pendingLifecycle])
  const workspace = useMemo(() => {
    const projected = projectRealGrades(parent.workspace, versions, summaries)
    const entities = { ...projected.lifecycle?.entities }
    for (const operation of pendingLifecycle) {
      const key = `${operation.target.kind}:${operation.target.id}`
      entities[key] = {
        ...entities[key],
        ...(operation.grade === undefined ? {} : { parentKey: `ladder:${operation.ladderId}` }),
        ...(operation.operation.action === 'delete' ? { deletingAt: operation.operation.updatedAt } : { archivedAt: operation.operation.updatedAt }),
      }
    }
    return { ...projected, lifecycle: { ...projected.lifecycle, entities } }
  }, [parent.workspace, versions, summaries, pendingLifecycle])
  function canEdit(id: string, grade?: number) {
    const summary = summaries.find((item) => item.ladder.id === id)
    if (!canWrite || !summary || lifecycleIsRemoved(summary.ladder.lifecycle)) return false
    if (pendingLifecycleRef.current.some((item) => item.ladderId === id && (item.grade === undefined || item.grade === grade))) return false
    return !isEntityArchived(workspace, grade === undefined ? { kind: 'ladder', id } : { kind: 'rubric', id: gradeHeadId(id, grade) }) &&
      (grade === undefined || !lifecycleIsRemoved(summary.levels.find((level) => level.head.grade === grade)?.head.lifecycle))
  }
  function locateTarget(target: LifecycleTarget) {
    if (target.kind === 'ladder') {
      const family = summaries.find((item) => item.ladder.id === target.id)
      return family ? { family, grade: undefined } : undefined
    }
    if (target.kind !== 'rubric') return undefined
    const version = versions.find((item) => item.id === target.id || item.rubric.id === target.id)
    const groupId = version ? gradeHeadId(version.ladderId, version.grade) : workspace.rubrics.find((rubric) => rubric.id === target.id)?.groupId ?? target.id
    for (const family of summaries) {
      const level = family.levels.find((item) => item.head.id === groupId)
      if (level) return { family, grade: level.head.grade }
    }
    return undefined
  }
  async function changeLifecycle(target: LifecycleTarget, action: LifecycleAction) {
    const match = locateTarget(target)
    const previousOperation = pendingLifecycleRef.current.find((item) => item.target.kind === target.kind && item.target.id === target.id)
    if (!match && !previousOperation) return parent.changeLifecycle(target, action)
    if (!canManage) throw new Error('Only owners and editors can manage grade lifecycle.')
    if (mutating.current) throw new Error('Wait for the current grade request.')
    if (previousOperation && action !== previousOperation.operation.action) throw new Error('Finish the incomplete lifecycle operation before choosing another action.')
    let authorized = false
    await mutationGuard.leave(() => { authorized = true })
    if (!authorized) throw new Error('Lifecycle change cancelled to preserve unsaved grade changes.')
    await parent.cloud?.flushSave()
    const id = previousOperation?.ladderId ?? match!.family.ladder.id
    const grade = previousOperation ? previousOperation.grade : match!.grade
    const name = previousOperation?.name ?? (grade === undefined ? match!.family.ladder.name : `${match!.family.ladder.name} · GS-${grade}`)
    let etag = previousOperation?.etag ?? (grade === undefined ? match?.family.etag : match?.family.levels.find((level) => level.head.grade === grade)?.etag)
    if (previousOperation) {
      try {
        const current = await api.getGradeLifecycleState(workspaceId, id, grade)
        etag = current.etag ?? etag
      } catch (caught) {
        if (caught instanceof CloudApiError && caught.status === 404 && action === 'delete') {
          throw new CloudApiError('not_found', 'This cleanup target is no longer readable. It may have been removed or access may have changed; completion has not been confirmed.', 404)
        }
        if (!(caught instanceof CloudApiError) || caught.code !== 'unavailable' || !etag) throw caught
        console.warn('Score could not refresh pending grade cleanup. Retrying the confirmed operation with its last acknowledged ETag.', { error: caught.name, status: caught.status })
      }
    }
    if (!etag) throw new Error('The current lifecycle ETag is unavailable. Refresh this operation before retrying.')
    mutating.current = true; mutationGuard.hold(); setPending(true); epoch.current++
    const sequence = ++readSequence.current
    reads.current.forEach((controller) => controller.abort()); reads.current.clear(); listPromise.current = null
    try {
      const result = await api.changeGradeLifecycle(workspaceId, id, action, etag, grade)
      if (!alive.current) throw new Error('The workspace changed before the lifecycle response. Reopen it to verify the result.')
      if (result.pending || (result.operation && result.operation.status !== 'complete')) {
        const operation = result.operation ?? { id: target.id, action, status: 'pending' as const, updatedAt: new Date().toISOString() }
        setPendingLifecycle((current) => [...current.filter((item) => !(item.ladderId === id && item.grade === grade)), {
          target, name, ladderId: id, grade, etag: result.etag ?? etag, operation,
        }])
        if (result.ladder) remember(result.ladder, sequence)
        throw new LifecycleOperationError(operation)
      }
      if (result.ladder) remember(result.ladder, sequence)
      else if (result.deleted && grade !== undefined) {
        const deletedAt = new Date().toISOString()
        const cached = detailRef.current[id]
        const removeLevel = (level: GradeLadderSummary['levels'][number]) => ({
          ...level, head: { ...level.head, lifecycle: { deletedAt }, latestVersionId: undefined, latestReviewId: undefined, approvedVersionId: undefined },
        })
        if (cached?.state === 'ready') remember({
          ...cached.value,
          levels: cached.value.levels.map((level) => level.head.grade === grade ? { ...removeLevel(level), version: null, review: null, approval: null } : level),
        }, sequence)
        else setSummaries((current) => current.map((family) => family.ladder.id === id ? { ...family, levels: family.levels.map((level) => level.head.grade === grade ? removeLevel(level) : level) } : family))
      }
      if (action === 'delete' && (result.ladder || result.deleted)) {
        setHistoryVersions((current) => current.filter((version) => version.ladderId !== id || (grade !== undefined && version.grade !== grade)))
        if (grade === undefined) {
          acceptedSequence.current.set(id, sequence)
          setSummaries((current) => current.filter((item) => item.ladder.id !== id))
          const next = { ...detailRef.current, [id]: { state: 'error' as const, error: 'This grade ladder was permanently deleted.' } }; detailRef.current = next; setDetails(next)
        }
      }
      if (!result.ladder && !result.deleted) throw new Error('The grade service has not acknowledged the lifecycle change. Refresh before retrying.')
      setPendingLifecycle((current) => current.filter((item) => !(item.ladderId === id && (grade === undefined || item.grade === grade))))
      parent.notify(action === 'delete' ? 'Permanent deletion acknowledged by the grade service.' : action === 'archive' ? 'Archive acknowledged. Owned unfinished work is cancelled.' : 'Unarchive acknowledged. Cancelled work has not restarted.')
    } catch (caught) {
      if (caught instanceof CloudConflictError) {
        mutating.current = false
        await ensureDetail(id, true)
      }
      throw caught
    } finally {
      mutating.current = false
      if (alive.current) {
        setPending(false); mutationGuard.release()
        void refresh(); void parent.cloud?.refreshWorkspaces().catch(() => undefined)
      }
    }
  }
  async function guardedRead<T>(id: string, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const started = epoch.current
    const sequence = ++readSequence.current
    const result = await load()
    if (!alive.current || signal?.aborted || started !== epoch.current || (acceptedSequence.current.get(id) ?? authoritativeSequence.current) > sequence) {
      throw new Error('This source changed or was removed while loading. Reopen the current ladder to inspect retained content.')
    }
    return result
  }

  function workGrade(id: string, workId?: string): number | undefined {
    const entry = detailRef.current[id]
    const work = entry?.state === 'ready' ? entry.value.workItems.find((item) => item.id === workId) : undefined
    return work && 'grade' in work.input ? work.input.grade : undefined
  }

  const value: GradeLaddersContextValue = {
    workspaceId, canWrite, canEdit, phase, features, error, summaries, mutationPending: pending,
    detail: (id) => details[id] ?? { state: 'idle' }, ensureDetail, refresh,
    create: (input, key) => {
      const job = workspace.jobs.find((item) => item.id === input.jobId)
      const rubric = workspace.rubrics.find((item) => item.id === input.rubricId && item.jobId === input.jobId)
      if (!job || job.dataKind !== 'real' || job.status !== 'ready' || job.rubricDeletedAt || !rubric || rubric.dataKind !== 'real' ||
        isEntityArchived(workspace, { kind: 'job', id: job.id }) || isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId })) {
        return Promise.reject(new Error('A ladder requires an active, ready real job and an active saved rubric. Archived or removed seeds are not accepted.'))
      }
      return mutate(() => api.createGradeLadder(workspaceId, input, key))
    },
    update: (id, input, etag) => mutate(() => api.updateGradeLadder(workspaceId, id, input, etag), id),
    discover: (id, etag, key) => mutate(() => api.discoverGradeSources(workspaceId, id, etag, key), id),
    uploadPdf: (id, file, key, pages) => mutate(() => api.uploadGradeSourcePdf(workspaceId, id, file, key, pages), id),
    addUrl: (id, input, key) => mutate(() => api.addGradeSourceUrl(workspaceId, id, input, key), id),
    updateSource: (id, sourceId, input, etag) => mutate(() => api.updateGradeSource(workspaceId, id, sourceId, input, etag), id),
    confirmSources: (id, input, etag, key) => mutate(() => api.confirmGradeSources(workspaceId, id, input, etag, key), id),
    generate: (id, etag, key) => mutate(() => api.generateGradeLadder(workspaceId, id, etag, key), id),
    retry: (id, input, etag) => mutate(() => api.retryGradeWork(workspaceId, id, input, etag), id, input.grade ?? workGrade(id, input.workId)),
    cancel: (id, input, etag) => mutate(() => api.cancelGradeWork(workspaceId, id, input, etag), id, input.grade ?? workGrade(id, input.workId)),
    saveDraft: (id, grade, input, etag) => mutate(() => api.saveGradeDraft(workspaceId, id, grade, input, etag), id, grade),
    approve: (id, grade, input, etag) => mutate(() => api.approveGrade(workspaceId, id, grade, input, etag), id, grade),
    versions: async (id, grade, signal) => {
      const started = epoch.current
      const sequence = ++readSequence.current
      const records = await api.listAllGradeVersions(workspaceId, id, grade, signal)
      if (!alive.current || signal?.aborted || started !== epoch.current || (acceptedSequence.current.get(id) ?? authoritativeSequence.current) > sequence) throw new Error('Grade history changed during loading. Reopen the current history.')
      setHistoryVersions((current) => [...current.filter((record) => record.ladderId !== id || record.grade !== grade), ...records])
      return records
    },
    sourceSet: (id, sourceSetId, signal) => guardedRead(id, () => api.getGradeSourceSet(workspaceId, id, sourceSetId, signal), signal),
    document: (id, sourceId, sourceSetId, signal) => guardedRead(id, () => api.getGradeSourceDocument(workspaceId, id, sourceId, sourceSetId, signal), signal),
    originalUrl: (id, sourceId, sourceSetId) => api.gradeSourceOriginalUrl(workspaceId, id, sourceId, sourceSetId),
    locateRubric: (rubricId) => versions.filter((version) => version.rubric.id === rubricId).sort((a, b) => b.version - a.version)[0],
  }
  return <GradeLaddersContext.Provider value={value}><WorkspaceContext.Provider value={{
    ...parent,
    workspace,
    getLifecycleImpact: (target) => {
      const operation = pendingLifecycleRef.current.find((item) => item.target.kind === target.kind && item.target.id === target.id)
      if (operation) return api.getGradeLifecycleImpact(workspaceId, operation.ladderId, operation.grade)
      const match = locateTarget(target)
      return match ? api.getGradeLifecycleImpact(workspaceId, match.family.ladder.id, match.grade) : parent.getLifecycleImpact(target)
    },
    changeLifecycle,
    lifecycleOperations: [...(parent.lifecycleOperations ?? []), ...pendingLifecycle],
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
