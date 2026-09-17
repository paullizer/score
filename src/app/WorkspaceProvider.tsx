import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { WorkspaceContext, type WorkspaceContextValue } from './workspace-context'
import type { ImportCandidate, Rubric, SourceKind, Workspace } from '../domain/types'
import { createInitialWorkspace } from '../data/fixtures'
import { createAnalysisRun, createJobImport, createResumeImport, evaluateComparison, validateRubric } from '../services/mockWorkspace'
import { loadWorkspace, saveWorkspace } from '../services/persistence'
import { Button, InlineError, Modal } from '../components/ui'

function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return }
    const cancel = () => { window.clearTimeout(timer); resolve(false) }
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(true) }, ms)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [loaded] = useState(loadWorkspace)
  const [workspace, setWorkspace] = useState(loaded.workspace)
  const current = useRef(workspace)
  const [storageError, setStorageError] = useState(loaded.error)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmRecovery, setConfirmRecovery] = useState(false)
  const jobTasks = useRef(new Map<string, AbortController>())
  const runTasks = useRef(new Map<string, AbortController>())
  const resumeTasks = useRef(new Set<AbortController>())

  const persist = useCallback((next: Workspace) => {
    try {
      saveWorkspace(next)
      setStorageError(null)
      return true
    } catch (error) {
      if (!(error instanceof DOMException)) throw error
      setStorageError('Changes are not saved on this device. Browser storage may be unavailable or full. Free some space, then retry saving.')
      console.warn('Score could not save the demo workspace.', error)
      return false
    }
  }, [])

  const update = useCallback((transform: (value: Workspace) => Workspace) => {
    if (!current.current) throw new Error('Reset or recover the workspace before making changes.')
    const next = transform(current.current)
    current.current = next
    setWorkspace(next)
    return persist(next)
  }, [persist])

  useEffect(() => {
    if (current.current) persist(current.current)
    const jobs = jobTasks.current
    const runs = runTasks.current
    const resumes = resumeTasks.current
    return () => {
      jobs.forEach((controller) => controller.abort())
      runs.forEach((controller) => controller.abort())
      resumes.forEach((controller) => controller.abort())
    }
  }, [persist])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5500)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function processJob(id: string, rubricId: string, fail?: 'parsing' | 'rubric') {
    jobTasks.current.get(id)?.abort()
    const controller = new AbortController()
    jobTasks.current.set(id, controller)
    const change = (patch: Partial<Workspace['jobs'][number]>) => update((state) => ({
      ...state, jobs: state.jobs.map((job) => job.id === id ? { ...job, ...patch } : job),
    }))
    if (!await pause(650, controller.signal)) return
    if (fail === 'parsing') {
      change({ status: 'error', errorStage: 'parsing', error: 'Simulated document-reading failure. Retry to continue with sample content.' })
      jobTasks.current.delete(id)
      return
    }
    change({ status: 'generating', error: undefined, errorStage: undefined })
    if (!await pause(1000, controller.signal)) return
    if (fail === 'rubric') {
      change({ status: 'error', errorStage: 'rubric', error: 'Simulated rubric-generation failure. The sample job is preserved; retry to finish its rubric.' })
    } else {
      change({ status: 'ready', rubricId, error: undefined, errorStage: undefined })
    }
    jobTasks.current.delete(id)
  }

  function addJobs(items: ImportCandidate[], source: SourceKind, fail?: 'parsing' | 'rubric'): string[] {
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
    if (!items.length) throw new Error('Select at least one resume.')
    const created = items.map(createResumeImport)
    const controller = new AbortController()
    resumeTasks.current.add(controller)
    const completed = await pause(650, controller.signal)
    resumeTasks.current.delete(controller)
    if (!completed) throw new Error('The sample import was cancelled because the workspace was reset.')
    update((state) => ({
      ...state, resumes: [...created.map((item) => item.resume), ...state.resumes],
      documents: [...state.documents, ...created.map((item) => item.document)],
    }))
    setNotice(`${created.length} fictional ${created.length === 1 ? 'resume' : 'resumes'} added. Selected PDF contents were not read.`)
    return created.map((item) => item.resume.id)
  }

  function cancelJob(id: string) {
    jobTasks.current.get(id)?.abort()
    jobTasks.current.delete(id)
    update((state) => ({ ...state, jobs: state.jobs.map((job) => job.id === id
      ? { ...job, status: 'cancelled', error: 'Import cancelled. Retry when you are ready.' } : job) }))
  }

  function retryJob(id: string) {
    const rubric = current.current?.rubrics.filter((item) => item.jobId === id).sort((a, b) => b.version - a.version)[0]
    if (!rubric) { setNotice('This job has no recoverable sample rubric. Reset the demo to restore its fixtures.'); return }
    update((state) => ({ ...state, jobs: state.jobs.map((job) => job.id === id
      ? { ...job, status: 'parsing', error: undefined, errorStage: undefined } : job) }))
    void processJob(id, rubric.id)
  }

  function saveRubric(rubric: Rubric, duplicate = false): string {
    const errors = validateRubric(rubric)
    if (errors.length) throw new Error(errors.join(' '))
    const latest = current.current?.rubrics.filter((item) => item.groupId === rubric.groupId).sort((a, b) => b.version - a.version)[0]
    if (!latest) throw new Error('This rubric no longer exists. Reopen it from the library.')
    if (!duplicate && latest.id !== rubric.id) throw new Error('A newer version is available. Reopen the rubric before editing.')
    if (duplicate && rubric.kind === 'job') throw new Error('Job rubrics belong to their job. Duplicate a grade rubric to create a reusable template.')
    if (rubric.kind === 'job' && !current.current?.jobs.some((job) => job.id === rubric.jobId && job.status === 'ready')) {
      throw new Error("Finish this job's import before editing its rubric.")
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
    }))
    setNotice(saved
      ? `${next.name} saved as version ${next.version}. Existing results are unchanged.`
      : `Rubric updated to version ${next.version} for this visit, but not saved. Retry saving in the warning above.`)
    return next.id
  }

  async function processRun(id: string, failFirst = false) {
    runTasks.current.get(id)?.abort()
    const controller = new AbortController()
    runTasks.current.set(id, controller)
    const queued = current.current?.runs.find((run) => run.id === id)?.comparisons.filter((item) => item.status === 'queued') ?? []
    for (const [index, item] of queued.entries()) {
      if (controller.signal.aborted) return
      update((state) => ({ ...state, runs: state.runs.map((run) => run.id === id
        ? { ...run, comparisons: run.comparisons.map((comparison) => comparison.id === item.id ? { ...comparison, status: 'running' } : comparison) } : run) }))
      if (!await pause(420, controller.signal)) return
      const snapshot = current.current?.runs.find((run) => run.id === id)
      if (!snapshot) throw new Error('The active analysis snapshot is missing.')
      let result
      try {
        if (failFirst && index === 0) throw new Error('Simulated analysis interruption. Retry this comparison to finish.')
        result = evaluateComparison(snapshot, item.id)
      } catch (error) {
        if (!(error instanceof Error)) throw error
        result = { ...item, status: 'failed' as const, error: error.message }
      }
      update((state) => ({ ...state, runs: state.runs.map((run) => run.id === id
        ? { ...run, comparisons: run.comparisons.map((comparison) => comparison.id === item.id ? result : comparison) } : run) }))
    }
    runTasks.current.delete(id)
    setNotice('Analysis simulation finished. Open a result to review its cited evidence.')
  }

  function startAnalysis(resumeIds: string[], rubricIds: string[], name?: string, failFirst = false): string {
    if (!current.current) throw new Error('The workspace is not available.')
    const run = createAnalysisRun(current.current, resumeIds, rubricIds, name)
    update((state) => ({ ...state, runs: [run, ...state.runs] }))
    void processRun(run.id, failFirst)
    return run.id
  }

  function cancelRun(id: string) {
    runTasks.current.get(id)?.abort()
    runTasks.current.delete(id)
    update((state) => ({ ...state, runs: state.runs.map((run) => run.id === id ? {
      ...run, comparisons: run.comparisons.map((item) => item.status === 'queued' || item.status === 'running'
        ? { ...item, status: 'cancelled', error: 'Cancelled before assessment. No score was assigned.' } : item),
    } : run) }))
  }

  function retryRun(id: string) {
    const run = current.current?.runs.find((item) => item.id === id)
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

  function resetDemo() {
    jobTasks.current.forEach((controller) => controller.abort())
    runTasks.current.forEach((controller) => controller.abort())
    resumeTasks.current.forEach((controller) => controller.abort())
    jobTasks.current.clear()
    runTasks.current.clear()
    resumeTasks.current.clear()
    const next = createInitialWorkspace()
    current.current = next
    setWorkspace(next)
    const saved = persist(next)
    setNotice(saved ? 'Demo workspace reset. Your theme preference has been kept.' : 'Demo reset for this visit only. Changes cannot be saved yet.')
  }

  if (!workspace) return <main className="recovery-page"><div className="panel recovery-card">
    <AlertTriangle size={32} /><h1>Your demo needs attention</h1>
    <p>The saved workspace could not be opened. Your browser data has not been replaced.</p>
    <InlineError>{storageError}</InlineError>
    <div className="flex flex-wrap gap-3"><Button onClick={() => window.location.reload()}>Try again</Button>
      <Button variant="primary" icon={RotateCcw} onClick={() => setConfirmRecovery(true)}>Reset demo</Button></div>
    <Modal open={confirmRecovery} onOpenChange={setConfirmRecovery} title="Reset the saved demo?" description="This replaces only Score's demo records. Other browser data is untouched."
      footer={<><Button onClick={() => setConfirmRecovery(false)}>Keep data</Button><Button variant="danger" onClick={() => { resetDemo(); setConfirmRecovery(false) }}>Reset demo</Button></>}>
      <p>Demo imports, rubric edits, and analysis history will be replaced with the original fictional workspace.</p>
    </Modal>
  </div></main>

  const value: WorkspaceContextValue = {
    workspace, storageError, notice, clearNotice: () => setNotice(null), notify: setNotice,
    addJobs, addResumes, cancelJob, retryJob, saveRubric, startAnalysis, cancelRun, retryRun,
    resetDemo, retrySave: () => { if (current.current) persist(current.current) },
  }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
