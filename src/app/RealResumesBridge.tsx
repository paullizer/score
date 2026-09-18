import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RealResumeDetail, RealResumeSummary, ResumeProcessingFeatures } from '../domain/real-resumes'
import { supportedUploadFormats } from '../domain/document-formats'
import * as api from '../services/realResumes'
import { CloudConflictError } from '../services/cloudWorkspace'
import { appendResumeInputs, resumeWorkActive, type RealResumeImportBatch, type RealResumeImportSource } from '../features/resumes/resumeImportUi'
import { useWorkspace } from './workspace-context'
import { useGradeLeaveGuard } from './grade-navigation-context'
import { RealResumesContext, type RealResumesContextValue } from './real-resumes-context'
import { RealRequestScope, realRequestError, type RealLoadState } from './real-request-scope'

export function RealResumesBridge({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return <RealResumesProvider key={workspaceId} workspaceId={workspaceId}>{children}</RealResumesProvider>
}

function RealResumesProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const { cloud } = useWorkspace()
  const [scope] = useState(() => new RealRequestScope())
  const [features, setFeatures] = useState<ResumeProcessingFeatures | null>(null)
  const featuresRef = useRef(features)
  const [phase, setPhase] = useState<RealResumesContextValue['phase']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<RealResumeSummary[]>([])
  const summariesRef = useRef(summaries)
  const [details, setDetails] = useState<Record<string, RealLoadState<RealResumeDetail>>>({})
  const detailsRef = useRef(details)
  const [pendingCount, setPendingCount] = useState(0)
  const [batches, setBatches] = useState<RealResumeImportBatch[]>([])
  const batchesRef = useRef(batches)
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null)
  const currentBatchRef = useRef(currentBatchId)
  const canWrite = cloud?.workspaces.some((item) => item.id === workspaceId && item.role !== 'viewer') ?? false
  const leaveGuard = useGradeLeaveGuard(false, pendingCount > 0, 'Resume upload or processing request (not yet acknowledged)')

  const putDetail = useCallback((id: string, entry: RealLoadState<RealResumeDetail>) => {
    detailsRef.current = { ...detailsRef.current, [id]: entry }
    setDetails(detailsRef.current)
  }, [])

  const remember = useCallback((summary: RealResumeSummary, sequence: number) => {
    if (!scope.accept(summary.resume.id, sequence)) return false
    summariesRef.current = [summary, ...summariesRef.current.filter((item) => item.resume.id !== summary.resume.id)]
      .sort((a, b) => b.resume.createdAt.localeCompare(a.resume.createdAt))
    setSummaries(summariesRef.current)
    const cached = detailsRef.current[summary.resume.id]
    if (cached?.state === 'ready' && cached.value.etag !== summary.etag) putDetail(summary.resume.id, { state: 'idle' })
    return true
  }, [putDetail, scope])

  const ensureDetail = useCallback(async function loadDetail(id: string, force = false): Promise<void> {
    if (!featuresRef.current?.realResumeImports) return
    const previous = detailsRef.current[id]
    if (!force && previous && !['idle', 'loading'].includes(previous.state)) return
    const ticket = scope.read(`detail:${id}`)
    if (!ticket) return
    let superseded = false
    if (previous?.state !== 'ready') putDetail(id, { state: 'loading' })
    try {
      const detail = await api.getRealResume(workspaceId, id, ticket.controller.signal)
      if (!scope.current(ticket)) return
      if (remember(detail, ticket.sequence) || summariesRef.current.find((item) => item.resume.id === id)?.etag === detail.etag) putDetail(id, { state: 'ready', value: detail })
      else superseded = true
    } catch (caught) {
      if (!scope.current(ticket)) return
      const message = realRequestError(caught, 'The private resume could not be loaded.')
      putDetail(id, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
    } finally {
      scope.finish(ticket)
      if (superseded) void loadDetail(id, true)
    }
  }, [putDetail, remember, scope, workspaceId])

  const refresh = useCallback(async () => {
    const ticket = scope.read('$list')
    if (!ticket) return
    try {
      const available = await api.fetchResumeProcessingFeatures(ticket.controller.signal)
      if (!scope.current(ticket)) return
      featuresRef.current = available
      setFeatures(available)
      if (!available.realResumeImports) {
        setPhase('unavailable')
        setError('Real resume imports are not enabled in this deployment. No samples are substituted.')
        return
      }
      const items = await api.listAllRealResumes(workspaceId, ticket.controller.signal)
      if (!scope.current(ticket)) return
      for (const item of items) remember(item, ticket.sequence)
      setPhase('ready')
      setError(null)
      for (const [id, entry] of Object.entries(detailsRef.current)) {
        if (entry.state === 'idle' || entry.state === 'loading') void ensureDetail(id, true)
      }
    } catch (caught) {
      if (!scope.current(ticket)) return
      setPhase('error')
      setError(realRequestError(caught, 'The real resume service is unavailable.'))
    } finally { scope.finish(ticket) }
  }, [ensureDetail, remember, scope, workspaceId])

  useEffect(() => {
    scope.activate()
    void refresh()
    return () => scope.close()
  }, [refresh, scope])

  useEffect(() => {
    if (!features?.realResumeImports || !summaries.some(resumeWorkActive)) return
    const timer = window.setInterval(() => {
      void refresh()
      for (const [id, entry] of Object.entries(detailsRef.current)) {
        if (entry.state === 'ready' && resumeWorkActive(entry.value)) void ensureDetail(id, true)
      }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [ensureDetail, features?.realResumeImports, refresh, summaries])

  useEffect(() => {
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [refresh])

  function assertWritable() {
    if (!canWrite) throw new Error('This workspace is read-only. An owner or editor must import, retry, or cancel resumes.')
    if (!featuresRef.current?.realResumeImports || phase !== 'ready') throw new Error('Real resume imports are unavailable. Check the service before submitting.')
  }

  async function mutate(key: string, operation: () => Promise<RealResumeSummary>): Promise<RealResumeSummary> {
    assertWritable()
    const ticket = scope.mutate(key)
    leaveGuard.hold()
    setPendingCount((value) => value + 1)
    try {
      const summary = await operation()
      if (!scope.mutationCurrent(ticket)) throw new Error('The workspace changed before acknowledgement. Reopen the original workspace to check the server state.')
      remember(summary, ticket.sequence)
      return summary
    } catch (caught) {
      if (caught instanceof CloudConflictError) {
        throw new Error('This resume changed in another session. Reload and inspect its current state before retrying. No action was automatically resent with a new version.')
      }
      throw caught
    } finally {
      const current = scope.mutationCurrent(ticket)
      scope.finishMutation(ticket)
      if (current) {
        setPendingCount((value) => value - 1)
        if (!scope.busy) { leaveGuard.release(); void refresh() }
      }
    }
  }

  function putBatches(next: RealResumeImportBatch[]) {
    batchesRef.current = next
    setBatches(next)
  }

  function newBatch(): string {
    assertWritable()
    if (batchesRef.current.some((batch) => batch.items.some((item) => item.state === 'uploading'))) {
      throw new Error('Wait for uploads to be acknowledged before starting another batch. The active batch has not been replaced.')
    }
    const current = batchesRef.current.find((batch) => batch.id === currentBatchRef.current)
    if (current && current.inputCount === null) return current.id
    const batch: RealResumeImportBatch = { id: crypto.randomUUID(), inputCount: null, items: [] }
    putBatches([...batchesRef.current, batch])
    currentBatchRef.current = batch.id
    setCurrentBatchId(batch.id)
    return batch.id
  }

  function stage(inputs: RealResumeImportSource[]) {
    assertWritable()
    if (!inputs.length) throw new Error('Choose supported files or enter at least one public URL, one per line.')
    const id = currentBatchRef.current ?? newBatch()
    const batch = batchesRef.current.find((item) => item.id === id)!
    const next = appendResumeInputs(batch, inputs, featuresRef.current?.resumeLimits, supportedUploadFormats(featuresRef.current))
    putBatches(batchesRef.current.map((item) => item.id === id ? next : item))
  }

  function updateItem(batchId: string, key: string, update: Partial<RealResumeImportBatch['items'][number]>) {
    putBatches(batchesRef.current.map((batch) => batch.id === batchId
      ? { ...batch, items: batch.items.map((item) => item.key === key ? { ...item, ...update } : item) } : batch))
  }

  async function submitBatch(batchId: string, keys?: string[]) {
    assertWritable()
    const batch = batchesRef.current.find((item) => item.id === batchId)
    if (!batch) throw new Error('This batch is no longer open. Check the real library for acknowledged imports.')
    if (keys?.some((key) => !batch.items.some((item) => item.key === key))) throw new Error('The requested import item is not part of this batch.')
    if (batch.items.some((item) => item.state === 'uploading')) throw new Error('This batch is still uploading. Wait for acknowledgement before retrying.')
    const selected = batch.items.filter((item) => (!keys || keys.includes(item.key)) && ['pending', 'unconfirmed'].includes(item.state))
    if (!selected.length) throw new Error('No valid, unacknowledged inputs remain in this batch. Invalid entries were not submitted.')
    const inputCount = batch.inputCount ?? batch.items.length
    putBatches(batchesRef.current.map((item) => item.id === batchId
      ? { ...item, inputCount, items: item.items.map((input) => selected.some((candidate) => candidate.key === input.key) ? { ...input, state: 'uploading', error: undefined } : input) } : item))
    await Promise.all(selected.map(async (item) => {
      try {
        const summary = await mutate(`import:${item.key}`, () => {
          if (item.source.kind === 'url') return api.importRealResumeUrl(workspaceId, item.source.url, item.key, batchId, inputCount)
          if (!item.source.file) throw new Error('The accepted file is now server-owned. Inspect its saved record instead of resending it.')
          return api.importRealResumeFile(workspaceId, item.source.file, item.key, batchId, inputCount)
        })
        updateItem(batchId, item.key, {
          state: 'accepted', resumeId: summary.resume.id, error: undefined,
          source: item.source.kind === 'url' ? item.source : { kind: item.source.kind, file: null },
        })
      } catch (caught) {
        // A request can be accepted even when its response is lost. Retrying preserves both keys and bytes.
        if (scope.isOpen && batchesRef.current.some((entry) => entry.id === batchId)) {
          updateItem(batchId, item.key, { state: 'unconfirmed', error: realRequestError(caught, 'Acceptance could not be confirmed. Retry this unchanged input with its original request key.') })
        }
      }
    }))
  }

  const value: RealResumesContextValue = {
    workspaceId, canWrite, phase, features, error, summaries, refresh, ensureDetail,
    detail: (id) => details[id] ?? { state: 'idle' },
    pending: (id) => scope.pending(`resume:${id}`),
    retry: (id, etag) => mutate(`resume:${id}`, () => api.retryRealResume(workspaceId, id, etag)),
    cancel: (id, etag) => mutate(`resume:${id}`, () => api.cancelRealResume(workspaceId, id, etag)),
    originalUrl: (id) => api.realResumeOriginalUrl(workspaceId, id),
    batches, currentBatchId, newBatch, stage, submitBatch,
    selectBatch: (id) => {
      if (!batchesRef.current.some((batch) => batch.id === id)) throw new Error('This batch is not available.')
      if (batchesRef.current.some((batch) => batch.items.some((item) => item.state === 'uploading'))) throw new Error('Wait for the active uploads before switching batches.')
      currentBatchRef.current = id
      setCurrentBatchId(id)
    },
    removeItem: (key) => {
      const batch = batchesRef.current.find((item) => item.id === currentBatchRef.current)
      if (!batch || batch.inputCount !== null) throw new Error('Submitted batch identities are locked. Start a separate batch to change an input.')
      putBatches(batchesRef.current.map((item) => item.id === batch.id ? { ...item, items: item.items.filter((input) => input.key !== key) } : item))
    },
  }
  return <RealResumesContext.Provider value={value}>{children}</RealResumesContext.Provider>
}
