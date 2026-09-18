import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportCandidate, Rubric, SourceKind, Workspace } from '../domain/types'
import { createFreshInitialWorkspace } from '../data/fixtures'
import {
  applySampleLifecycle, assertEntityWritable, getEntityLifecycle, getSampleLifecycleImpact, isEntityArchived, isEntityRemoved,
  withSampleResetTombstones, type LifecycleAction, type LifecycleImpact, type LifecycleTarget,
} from '../domain/lifecycle'
import { createAnalysisRun, createJobImport, createResumeImport, evaluateComparison, validateRubric } from '../services/mockWorkspace'
import { validateWorkspace } from '../domain/workspace-validation'

export type PersistenceResult = 'saved' | 'queued' | 'failed'

export interface WorkspaceEngine {
  workspace: Workspace | null
  notice: string | null
  clearNotice: () => void
  notify: (message: string) => void
  addJobs: (items: ImportCandidate[], source: SourceKind, fail?: 'parsing' | 'rubric') => string[]
  addResumes: (items: ImportCandidate[]) => Promise<string[]>
  cancelJob: (id: string) => void
  retryJob: (id: string) => void
  saveRubric: (rubric: Rubric, duplicate?: boolean) => string
  startAnalysis: (resumeIds: string[], rubricIds: string[], name?: string, failFirst?: boolean) => string
  cancelRun: (id: string) => void
  retryRun: (id: string) => void
  getLifecycleImpact: (target: LifecycleTarget) => LifecycleImpact
  changeLifecycle: (target: LifecycleTarget, action: LifecycleAction) => void
  resetDemo: () => void
  stopPendingOperations: (reason: string) => void
  /** Fences cloud-authoritative archive changes without persisting an old sample snapshot. */
  setExternalArchive: (archived: boolean) => void
  /** Replaces an authoritative sample snapshot without autosave; callers must protect unsaved edits. */
  replaceWorkspace: (next: Workspace) => void
  /** Re-persist whatever is currently in memory (used by "retry saving" affordances). */
  retryPersist: () => PersistenceResult
}

function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return }
    const cancel = () => { window.clearTimeout(timer); resolve(false) }
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(true) }, ms)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export function useWorkspaceEngine(initialWorkspace: Workspace | null, persist: (next: Workspace) => PersistenceResult): WorkspaceEngine {
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const current = useRef(workspace)
  const [notice, setNotice] = useState<string | null>(null)
  const jobTasks = useRef(new Map<string, AbortController>())
  const runTasks = useRef(new Map<string, AbortController>())
  const resumeTasks = useRef(new Set<AbortController>())
  const externallyArchived = useRef(false)

  function availableWorkspace(): Workspace {
    if (!current.current) throw new Error('Reset or recover the workspace before making changes.')
    return current.current
  }

  function writable(target: LifecycleTarget = { kind: 'workspace', id: 'sample' }): Workspace {
    const state = availableWorkspace()
    if (externallyArchived.current) throw new Error('This workspace is archived. Unarchive it before editing or starting new processing.')
    assertEntityWritable(state, target)
    return state
  }

  function writableJob(id: string): Workspace {
    const state = writable({ kind: 'job', id })
    if (state.jobs.some((job) => job.id === id && job.dataKind === 'real')) {
      throw new Error('Real jobs must use their server-owned operations, not sample processing.')
    }
    return state
  }

  const update = useCallback((transform: (value: Workspace) => Workspace) => {
    if (!current.current) throw new Error('Reset or recover the workspace before making changes.')
    const next = transform(current.current)
    current.current = next
    setWorkspace(next)
    return persist(next)
  }, [persist])

  useEffect(() => {
    const jobs = jobTasks.current
    const runs = runTasks.current
    const resumes = resumeTasks.current
    return () => {
      jobs.forEach((controller) => controller.abort())
      runs.forEach((controller) => controller.abort())
      resumes.forEach((controller) => controller.abort())
    }
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5500)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function processJob(id: string, rubricId: string, fail?: 'parsing' | 'rubric') {
    jobTasks.current.get(id)?.abort()
    const controller = new AbortController()
    jobTasks.current.set(id, controller)
    const mayPublish = () => {
      const state = current.current
      const job = state?.jobs.find((item) => item.id === id)
      const rubric = state?.rubrics.find((item) => item.id === rubricId && item.jobId === id)
      return Boolean(state && job && rubric && !job.rubricDeletedAt && !externallyArchived.current &&
        (job.status === 'parsing' || job.status === 'generating') &&
        !controller.signal.aborted && jobTasks.current.get(id) === controller &&
        !isEntityArchived(state, { kind: 'job', id }) && !isEntityRemoved(state, { kind: 'job', id }) &&
        !isEntityArchived(state, { kind: 'rubric', id: rubricId }) && !isEntityRemoved(state, { kind: 'rubric', id: rubricId }))
    }
    const change = (patch: Partial<Workspace['jobs'][number]>) => {
      if (!mayPublish()) return
      update((state) => ({
        ...state, jobs: state.jobs.map((job) => job.id === id ? { ...job, ...patch } : job),
      }))
    }
    try {
      if (!await pause(650, controller.signal) || !mayPublish()) return
      if (fail === 'parsing') {
        change({ status: 'error', errorStage: 'parsing', error: 'Simulated document-reading failure. Retry to continue with sample content.' })
        return
      }
      change({ status: 'generating', error: undefined, errorStage: undefined })
      if (!await pause(1000, controller.signal) || !mayPublish()) return
      if (fail === 'rubric') {
        change({ status: 'error', errorStage: 'rubric', error: 'Simulated rubric-generation failure. The sample job is preserved; retry to finish its rubric.' })
      } else {
        change({ status: 'ready', rubricId, error: undefined, errorStage: undefined })
      }
    } finally {
      if (jobTasks.current.get(id) === controller) jobTasks.current.delete(id)
    }
  }

  function addJobs(items: ImportCandidate[], source: SourceKind, fail?: 'parsing' | 'rubric'): string[] {
    writable()
    if (!items.length) throw new Error('Select at least one job to import.')
    if (new Set(items.map((item) => item.label)).size !== items.length) throw new Error('Remove duplicate sources before importing.')
    if (current.current?.jobs.some((job) => items.some((item) => item.label === job.sourceLabel && source === job.source))) {
      throw new Error('A selected source is already in this workspace. Remove the duplicate before importing.')
    }
    const batchId = `batch-${crypto.randomUUID()}`
    const created = items.map((item) => createJobImport(item, source, batchId))
    update((state) => ({
      ...state,
      jobs: [...created.map(({ job }) => ({ ...job, status: 'parsing' as const, rubricId: null })), ...state.jobs],
      documents: [...state.documents, ...created.map((item) => item.document)],
      rubrics: [...state.rubrics, ...created.map((item) => item.rubric)],
    }))
    created.forEach(({ job, rubric }, index) => { void processJob(job.id, rubric.id, index === 0 ? fail : undefined) })
    setNotice(`${created.length} sample ${created.length === 1 ? 'job is' : 'jobs are'} being prepared. No source content was uploaded or fetched.`)
    return created.map((item) => item.job.id)
  }

  async function addResumes(items: ImportCandidate[]): Promise<string[]> {
    writable()
    if (!items.length) throw new Error('Select at least one resume.')
    const created = items.map(createResumeImport)
    const controller = new AbortController()
    resumeTasks.current.add(controller)
    const completed = await pause(650, controller.signal)
    resumeTasks.current.delete(controller)
    const state = current.current
    if (!completed || controller.signal.aborted || externallyArchived.current || !state || isEntityArchived(state, { kind: 'workspace', id: 'sample' }) ||
      isEntityRemoved(state, { kind: 'workspace', id: 'sample' })) return []
    update((state) => ({
      ...state, resumes: [...created.map((item) => item.resume), ...state.resumes],
      documents: [...state.documents, ...created.map((item) => item.document)],
    }))
    setNotice(`${created.length} fictional ${created.length === 1 ? 'resume' : 'resumes'} added. Selected PDF contents were not read.`)
    return created.map((item) => item.resume.id)
  }

  function cancelJob(id: string) {
    const state = writableJob(id)
    const job = state.jobs.find((item) => item.id === id)!
    if (job.status !== 'parsing' && job.status !== 'generating' && job.status !== 'queued') return
    jobTasks.current.get(id)?.abort()
    jobTasks.current.delete(id)
    update((state) => ({ ...state, jobs: state.jobs.map((job) => job.id === id
      ? { ...job, status: 'cancelled', error: 'Import cancelled. Retry when you are ready.' } : job) }))
  }

  function retryJob(id: string) {
    const state = writableJob(id)
    const job = state.jobs.find((item) => item.id === id)!
    if (job.rubricDeletedAt) throw new Error('This job intentionally has No rubric. Retrying an import cannot restore a permanently deleted rubric.')
    if (job.status !== 'error' && job.status !== 'cancelled') {
      setNotice('Only a failed or cancelled import needs retrying.')
      return
    }
    const rubric = state.rubrics.filter((item) => item.jobId === id).sort((a, b) => b.version - a.version)[0]
    if (!rubric) { setNotice('This job has no recoverable sample rubric. Reset the demo to restore its fixtures.'); return }
    assertEntityWritable(state, { kind: 'rubric', id: rubric.groupId })
    update((state) => ({ ...state, jobs: state.jobs.map((job) => job.id === id
      ? { ...job, status: 'parsing', error: undefined, errorStage: undefined } : job) }))
    void processJob(id, rubric.id)
  }

  function saveRubric(rubric: Rubric, duplicate = false): string {
    const state = writable({ kind: 'rubric', id: rubric.groupId })
    if (rubric.dataKind === 'real') throw new Error('Server-owned real rubrics cannot be saved or duplicated into sample persistence.')
    const errors = validateRubric(rubric)
    if (errors.length) throw new Error(errors.join(' '))
    const latest = state.rubrics.filter((item) => item.groupId === rubric.groupId).sort((a, b) => b.version - a.version)[0]
    if (!latest) throw new Error('This rubric no longer exists. Reopen it from the library.')
    if (latest.kind !== rubric.kind || latest.jobId !== rubric.jobId || latest.ladder !== rubric.ladder || latest.grade !== rubric.grade) {
      throw new Error('A saved rubric cannot be moved to another source or ladder. Reopen its original record.')
    }
    if (!duplicate && latest.id !== rubric.id) throw new Error('A newer version is available. Reopen the rubric before editing.')
    if (duplicate && rubric.kind === 'job') throw new Error('Job rubrics belong to their job. Duplicate a grade rubric to create a reusable template.')
    if (rubric.kind === 'job') {
      assertEntityWritable(state, { kind: 'job', id: rubric.jobId ?? '' })
      if (!state.jobs.some((job) => job.id === rubric.jobId && job.status === 'ready' && !job.rubricDeletedAt)) {
        throw new Error("Finish this job's import before editing its rubric.")
      }
    }
    const next: Rubric = {
      ...structuredClone(rubric), id: `rubric-${crypto.randomUUID()}`,
      groupId: duplicate ? `group-${crypto.randomUUID()}` : rubric.groupId,
      version: duplicate ? 1 : latest.version + 1,
      createdAt: new Date().toISOString(),
    }
    const saved = update((state) => ({
      ...state, rubrics: [...state.rubrics, next],
      jobs: state.jobs.map((job) => next.jobId === job.id ? { ...job, rubricId: next.id } : job),
      ...(duplicate && next.kind === 'grade' ? {
        lifecycle: {
          ...state.lifecycle,
          entities: {
            ...state.lifecycle?.entities,
            [`rubric:${next.groupId}`]: {
              parentKey: getEntityLifecycle(state, { kind: 'rubric', id: rubric.groupId })?.parentKey ?? `ladder:${rubric.ladder}`,
            },
          },
        },
      } : {}),
    }))
    setNotice(saved === 'queued'
      ? `${next.name} updated to version ${next.version}. Changes are queued for saving; existing results are unchanged.`
      : saved === 'saved'
      ? `${next.name} saved as version ${next.version}. Existing results are unchanged.`
      : `Rubric updated to version ${next.version} for this visit, but not saved. Retry saving in the warning above.`)
    return next.id
  }

  async function processRun(id: string, failFirst = false) {
    runTasks.current.get(id)?.abort()
    const controller = new AbortController()
    runTasks.current.set(id, controller)
    const queued = current.current?.runs.find((run) => run.id === id)?.comparisons.filter((item) => item.status === 'queued') ?? []
    const mayPublish = () => {
      const state = current.current
      return Boolean(state && !externallyArchived.current && !controller.signal.aborted && runTasks.current.get(id) === controller &&
        state.runs.some((run) => run.id === id) &&
        !isEntityArchived(state, { kind: 'analysis', id }) && !isEntityRemoved(state, { kind: 'analysis', id }))
    }
    try {
      for (const [index, item] of queued.entries()) {
        if (!mayPublish()) return
        update((state) => ({ ...state, runs: state.runs.map((run) => run.id === id
          ? { ...run, comparisons: run.comparisons.map((comparison) => comparison.id === item.id && comparison.status === 'queued'
            ? { ...comparison, status: 'running' } : comparison) } : run) }))
        if (!await pause(420, controller.signal) || !mayPublish()) return
        const snapshot = current.current?.runs.find((run) => run.id === id)
        if (!snapshot || snapshot.comparisons.find((comparison) => comparison.id === item.id)?.status !== 'running') return
        let result
        try {
          if (failFirst && index === 0) throw new Error('Simulated analysis interruption. Retry this comparison to finish.')
          result = evaluateComparison(snapshot, item.id)
        } catch (error) {
          if (!(error instanceof Error)) throw error
          result = { ...item, status: 'failed' as const, error: error.message }
        }
        if (!mayPublish()) return
        update((state) => ({ ...state, runs: state.runs.map((run) => run.id === id
          ? { ...run, comparisons: run.comparisons.map((comparison) => comparison.id === item.id ? result : comparison) } : run) }))
      }
      if (mayPublish()) setNotice('Analysis simulation finished. Open a result to review its cited evidence.')
    } finally {
      if (runTasks.current.get(id) === controller) runTasks.current.delete(id)
    }
  }

  function startAnalysis(resumeIds: string[], rubricIds: string[], name?: string, failFirst = false): string {
    const run = createAnalysisRun(writable(), resumeIds, rubricIds, name)
    update((state) => ({ ...state, runs: [run, ...state.runs] }))
    void processRun(run.id, failFirst)
    return run.id
  }

  function cancelRun(id: string) {
    writable({ kind: 'analysis', id })
    runTasks.current.get(id)?.abort()
    runTasks.current.delete(id)
    update((state) => ({ ...state, runs: state.runs.map((run) => run.id === id ? {
      ...run, comparisons: run.comparisons.map((item) => item.status === 'queued' || item.status === 'running'
        ? { ...item, status: 'cancelled', error: 'Cancelled before assessment. No score was assigned.' } : item),
    } : run) }))
  }

  function retryRun(id: string) {
    const run = writable({ kind: 'analysis', id }).runs.find((item) => item.id === id)
    if (!run) { setNotice('This analysis is no longer available. Open another run from the library.'); return }
    if (run.comparisons.some((item) => item.status === 'queued' || item.status === 'running')) {
      setNotice('Let the current comparisons finish, or cancel pending work before retrying.')
      return
    }
    update((state) => ({ ...state, runs: state.runs.map((run) => run.id === id ? {
      ...run, comparisons: run.comparisons.map((item) => item.status === 'failed' || item.status === 'cancelled'
        ? { ...item, status: 'queued', error: undefined } : item),
    } : run) }))
    void processRun(id)
  }

  function getLifecycleImpact(target: LifecycleTarget): LifecycleImpact {
    return getSampleLifecycleImpact(availableWorkspace(), target)
  }

  function changeLifecycle(target: LifecycleTarget, action: LifecycleAction) {
    const state = availableWorkspace()
    const impact = getSampleLifecycleImpact(state, target)
    const next = applySampleLifecycle(state, target, action, new Date().toISOString())
    const reason = new Error(`Processing stopped by ${action}. Unarchiving never restarts unfinished work.`)
    for (const [id, controller] of jobTasks.current) {
      const job = next.jobs.find((item) => item.id === id)
      if (!job || job.status === 'cancelled' || job.rubricDeletedAt || isEntityArchived(next, { kind: 'job', id })) {
        controller.abort(reason)
        jobTasks.current.delete(id)
      }
    }
    for (const [id, controller] of runTasks.current) {
      if (!next.runs.some((run) => run.id === id) || isEntityArchived(next, { kind: 'analysis', id })) {
        controller.abort(reason)
        runTasks.current.delete(id)
      }
    }
    if (isEntityArchived(next, { kind: 'workspace', id: 'sample' }) || isEntityRemoved(next, { kind: 'workspace', id: 'sample' })) {
      resumeTasks.current.forEach((controller) => controller.abort(reason))
      resumeTasks.current.clear()
    }
    const saved = update(() => next)
    const verb = action === 'delete' ? 'deleted' : action === 'archive' ? 'archived' : 'unarchived'
    setNotice(saved === 'saved' ? `${impact.name} ${verb}.`
      : saved === 'queued' ? `${impact.name}: ${action} is pending cloud save.`
      : `${impact.name}: ${action} is not saved. Retry saving before leaving this tab.`)
  }

  function abortPendingOperations(reason: string) {
    jobTasks.current.forEach((controller) => controller.abort(new Error(reason)))
    runTasks.current.forEach((controller) => controller.abort(new Error(reason)))
    resumeTasks.current.forEach((controller) => controller.abort(new Error(reason)))
    jobTasks.current.clear()
    runTasks.current.clear()
    resumeTasks.current.clear()
  }

  function cancelPendingOperations(reason: string, save: boolean) {
    abortPendingOperations(reason)
    const active = current.current?.jobs.some((job) => job.status === 'parsing' || job.status === 'generating') ||
      current.current?.runs.some((run) => run.comparisons.some((item) => item.status === 'queued' || item.status === 'running'))
    if (!active || !current.current) return
    const cancel = (state: Workspace): Workspace => ({
      ...state,
      jobs: state.jobs.map((job) => job.status === 'parsing' || job.status === 'generating'
        ? { ...job, status: 'cancelled', error: reason } : job),
      runs: state.runs.map((run) => ({
        ...run,
        comparisons: run.comparisons.map((item) => item.status === 'queued' || item.status === 'running'
          ? { ...item, status: 'cancelled', score: null, criteria: [], error: reason, summary: reason } : item),
      })),
    })
    if (save) update(cancel)
    else {
      const next = cancel(current.current)
      current.current = next
      setWorkspace(next)
    }
  }

  function stopPendingOperations(reason: string) {
    cancelPendingOperations(reason, true)
  }

  function setExternalArchive(archived: boolean) {
    const changed = externallyArchived.current !== archived
    externallyArchived.current = archived
    if (archived && changed) {
      cancelPendingOperations('This workspace was archived. Unfinished sample processing stopped; completed results are preserved. Unarchive does not restart it.', false)
    }
  }

  function replaceWorkspace(next: Workspace) {
    const validated = validateWorkspace(next)
    abortPendingOperations('The authoritative sample workspace was reloaded. Previous processing cannot publish into the new state.')
    current.current = validated
    setWorkspace(validated)
    setNotice(null)
  }

  function resetDemo() {
    if (externallyArchived.current) throw new Error('This workspace is archived. Unarchive it before resetting its sample data.')
    const recreate = Boolean(current.current && isEntityRemoved(current.current, { kind: 'workspace', id: 'sample' }))
    if (current.current && !recreate) writable()
    abortPendingOperations('The workspace was reset.')
    const fresh = createFreshInitialWorkspace()
    const next = current.current ? withSampleResetTombstones(current.current, fresh, new Date().toISOString(), recreate ? crypto.randomUUID() : undefined) : fresh
    current.current = next
    setWorkspace(next)
    const saved = persist(next)
    const action = recreate ? 'New demo workspace created' : 'Demo workspace reset'
    setNotice(saved === 'queued' ? `${action} in this tab. Check the cloud save status above.`
      : saved === 'saved' ? `${action}. Your theme preference has been kept.` : `${action} for this visit only. Changes cannot be saved yet.`)
  }

  return {
    workspace, notice, clearNotice: () => setNotice(null), notify: setNotice,
    addJobs, addResumes, cancelJob, retryJob, saveRubric, startAnalysis, cancelRun, retryRun,
    getLifecycleImpact, changeLifecycle, resetDemo, stopPendingOperations, setExternalArchive, replaceWorkspace,
    retryPersist: () => current.current ? persist(current.current) : 'failed',
  }
}
