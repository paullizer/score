import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RealResumeDetail, RealResumeSummary } from '../domain/real-resumes'
import { supportedUploadFormats } from '../domain/document-formats'
import * as api from '../services/realResumes'
import { assertClientAdmission, clientAdmissionReason, usePublicSettings } from './public-settings-context'
import { boundedPollingInterval, effectiveFormats, requireImportBatch, resumeFeaturesWithPolicy } from '../services/publicSettings'
import { CloudApiError, CloudConflictError, LifecycleOperationError, workspaceAccessStamp } from '../services/cloudWorkspace'
import { lifecycleIsRemoved, type LifecycleAction, type LifecycleTarget } from '../domain/lifecycle'
import { appendResumeInputs, resumeWorkActive, type RealResumeImportBatch, type RealResumeImportSource } from '../features/resumes/resumeImportUi'
import { WorkspaceContext, useWorkspace, type PendingLifecycleChange, type RenameEntityTarget } from './workspace-context'
import { getDisplayName } from '../domain/displayNames'
import { useGradeLeaveGuard } from './grade-navigation-context'
import { RealResumesContext, type RealResumesContextValue } from './real-resumes-context'
import { RealRequestScope, realRequestError, type RealLoadState } from './real-request-scope'
import { assertRealLifecyclePermission, discoveredLifecycle, projectRealLifecycle, realWorkspaceWritable, reconcileLifecycleOperations } from './real-lifecycle'

export function RealResumesBridge({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return <RealResumesProvider key={workspaceId} workspaceId={workspaceId}>{children}</RealResumesProvider>
}

function RealResumesProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const policy = usePublicSettings()
  const pollingInterval = boundedPollingInterval(policy.settings)
  const parent = useWorkspace()
  const parentRef = useRef(parent)
  parentRef.current = parent
  const [scope] = useState(() => new RealRequestScope())
  const metadata = parent.cloud?.workspaces.find(item => item.id === workspaceId)
  const accessStamp = workspaceAccessStamp(metadata)
  scope.updateAccess(accessStamp, Boolean(metadata && !metadata.deletedAt))
  const [features, setFeatures] = useState<api.ResumeServiceFeatures | null>(null)
  const featuresRef = useRef(features)
  const [phase, setPhase] = useState<RealResumesContextValue['phase']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<RealResumeSummary[]>([])
  const summariesRef = useRef(summaries)
  const knownIds = useRef(new Set<string>())
  const [details, setDetails] = useState<Record<string, RealLoadState<RealResumeDetail>>>({})
  const detailsRef = useRef(details)
  const [pendingCount, setPendingCount] = useState(0)
  const [batches, setBatches] = useState<RealResumeImportBatch[]>([])
  const batchesRef = useRef(batches)
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null)
  const currentBatchRef = useRef(currentBatchId)
  const [pendingLifecycle, setPendingLifecycleState] = useState<PendingLifecycleChange[]>([])
  const pendingLifecycleRef = useRef(pendingLifecycle)
  const setPendingLifecycle = useCallback((next: PendingLifecycleChange[]) => {
    pendingLifecycleRef.current = next
    setPendingLifecycleState(next)
  }, [])
  const canWrite = realWorkspaceWritable(parent, workspaceId)
  const hasUnsubmittedInputs = batches.some(batch => batch.items.some(item => item.state !== 'accepted'))
  const leaveGuard = useGradeLeaveGuard(hasUnsubmittedInputs, pendingCount > 0, 'Resume inputs awaiting upload or acknowledgement', 'workspace')

  const putDetail = useCallback((id: string, entry: RealLoadState<RealResumeDetail>) => {
    detailsRef.current = { ...detailsRef.current, [id]: entry }
    setDetails(detailsRef.current)
  }, [])

  const removeResume = useCallback((id: string, sequence: number) => {
    if (!scope.accept(`resume:${id}`, sequence)) return
    scope.cancelReads((key) => key === `detail:${id}`)
    summariesRef.current = summariesRef.current.filter((item) => item.resume.id !== id)
    setSummaries(summariesRef.current)
    putDetail(id, { state: 'error', error: 'This resume was removed or is no longer available in this workspace. Its cached source has been cleared.' })
  }, [putDetail, scope])

  const remember = useCallback((summary: RealResumeSummary, sequence: number) => {
    if (!scope.accept(`resume:${summary.resume.id}`, sequence)) return false
    knownIds.current.add(summary.resume.id)
    summariesRef.current = [summary, ...summariesRef.current.filter((item) => item.resume.id !== summary.resume.id)]
      .sort((a, b) => b.resume.createdAt.localeCompare(a.resume.createdAt))
    setSummaries(summariesRef.current)
    const cached = detailsRef.current[summary.resume.id]
    if (lifecycleIsRemoved(summary.lifecycle)) putDetail(summary.resume.id, { state: 'error', error: 'Resume cleanup is incomplete. Only lifecycle recovery metadata is available until deletion is acknowledged.' })
    else if (cached?.state === 'ready' && cached.value.etag !== summary.etag) putDetail(summary.resume.id, { state: 'idle' })
    return true
  }, [putDetail, scope])

  useEffect(() => {
    setPendingLifecycle(reconcileLifecycleOperations(pendingLifecycleRef.current, summaries.map((summary) =>
      discoveredLifecycle({ kind: 'resume', id: summary.resume.id }, getDisplayName(summary, summary.resume.name ?? summary.source.displayName), summary.lifecycle, summary.lifecycleOperation))))
  }, [setPendingLifecycle, summaries])

  const ensureDetail = useCallback(async function loadDetail(id: string, force = false): Promise<void> {
    if (lifecycleIsRemoved(summariesRef.current.find((item) => item.resume.id === id)?.lifecycle)) return
    const previous = detailsRef.current[id]
    if (!force && previous && !['idle', 'loading'].includes(previous.state)) return
    const ticket = scope.read(`detail:${id}`)
    if (!ticket) return
    let superseded = false
    if (previous?.state !== 'ready') putDetail(id, { state: 'loading' })
    try {
      const detail = await api.getRealResume(workspaceId, id, ticket.controller.signal)
      if (!scope.current(ticket)) return
      if (lifecycleIsRemoved(detail.lifecycle)) { superseded = !remember(detail, ticket.sequence); return }
      if (remember(detail, ticket.sequence) || summariesRef.current.find((item) => item.resume.id === id)?.etag === detail.etag) putDetail(id, { state: 'ready', value: detail })
      else superseded = true
    } catch (caught) {
      if (!scope.current(ticket)) return
      if (!scope.canAccept(`resume:${id}`, ticket.sequence)) { superseded = true; return }
      if (caught instanceof CloudApiError && [403, 404].includes(caught.status)) { removeResume(id, ticket.sequence); return }
      const message = realRequestError(caught, 'The private resume could not be loaded.')
      putDetail(id, previous?.state === 'ready' ? { ...previous, error: message } : { state: 'error', error: message })
    } finally {
      scope.finish(ticket)
      if (superseded) void loadDetail(id, true)
    }
  }, [putDetail, remember, removeResume, scope, workspaceId])

  const refresh = useCallback(async () => {
    const ticket = scope.read('$list')
    if (!ticket) return
    try {
      let readinessError: string | null = null
      const available = await api.fetchResumeProcessingFeatures(ticket.controller.signal).catch((caught: unknown) => {
        readinessError = realRequestError(caught, 'New resume import readiness could not be checked.')
        return null
      })
      if (!scope.current(ticket)) return
      featuresRef.current = available
      setFeatures(available)
      if (available?.deploymentCapabilities?.realResumeImports === false) {
        setPhase('unavailable')
        setError('The real resume service is not configured in this deployment. Saved records have not been deleted, and no samples are substituted.')
        return
      }
      const items = await api.listAllRealResumes(workspaceId, ticket.controller.signal)
      if (!scope.current(ticket)) return
      scope.reconcile('resume:', ticket.sequence)
      const present = new Set(items.map((item) => item.resume.id))
      const cachedIds = new Set([...summariesRef.current.map((item) => item.resume.id), ...Object.keys(detailsRef.current)])
      for (const id of cachedIds) if (!present.has(id)) removeResume(id, ticket.sequence)
      for (const item of items) remember(item, ticket.sequence)
      setPhase('ready')
      setError(readinessError)
      for (const [id, entry] of Object.entries(detailsRef.current)) {
        if (entry.state === 'idle' || entry.state === 'loading') void ensureDetail(id, true)
      }
    } catch (caught) {
      if (!scope.current(ticket)) return
      if (caught instanceof CloudApiError && [401, 403].includes(caught.status)) {
        scope.reconcile('resume:', ticket.sequence)
        for (const item of summariesRef.current) removeResume(item.resume.id, ticket.sequence)
      }
      setPhase('error')
      setError(realRequestError(caught, 'The real resume service is unavailable.'))
    } finally { scope.finish(ticket) }
  }, [ensureDetail, remember, removeResume, scope, workspaceId])

  useEffect(() => {
    scope.activate()
    void refresh()
    return () => scope.close()
  }, [refresh, scope])

  useEffect(() => {
    if (phase !== 'ready' || !summaries.some(resumeWorkActive)) return
    const timer = window.setInterval(() => {
      void refresh()
      for (const [id, entry] of Object.entries(detailsRef.current)) {
        if (entry.state === 'ready' && resumeWorkActive(entry.value)) void ensureDetail(id, true)
      }
    }, pollingInterval)
    return () => window.clearInterval(timer)
  }, [ensureDetail, phase, pollingInterval, refresh, summaries])

  useEffect(() => { void refresh() }, [policy.settings, policy.phase, refresh])
  useEffect(() => { void refresh() }, [accessStamp, refresh])

  useEffect(() => {
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [refresh])

  function assertWritable(id?: string) {
    if (!realWorkspaceWritable(parentRef.current, workspaceId)) throw new Error('This workspace is archived, read-only, or unavailable. An owner or editor must import, retry, or cancel resumes.')
    if (phase !== 'ready') throw new Error('The saved resume service is unavailable. Refresh before submitting.')
    if (id) {
      const summary = summariesRef.current.find((item) => item.resume.id === id)
      if (!summary || summary.lifecycle?.archivedAt || lifecycleIsRemoved(summary.lifecycle) || pendingLifecycleRef.current.some((item) => item.target.id === id)) {
        throw new Error('This resume is archived, removed, or has incomplete cleanup. Unarchive it before starting new processing.')
      }
    }
  }

  async function mutate<T>(key: string, operation: () => Promise<T>, commit: (value: T, sequence: number) => void, lifecycle = false, resumeId?: string): Promise<T> {
    if (lifecycle) {
      assertRealLifecyclePermission(parentRef.current, workspaceId)
      await parentRef.current.cloud?.flushSave()
      assertRealLifecyclePermission(parentRef.current, workspaceId)
    } else assertWritable(resumeId)
    const ticket = scope.mutate(key)
    leaveGuard.hold()
    setPendingCount((value) => value + 1)
    try {
      const summary = await operation()
      if (!scope.mutationCurrent(ticket)) throw new Error('The workspace changed before acknowledgement. Reopen the original workspace to check the server state.')
      commit(summary, ticket.sequence)
      return summary
    } catch (caught) {
      if (caught instanceof CloudConflictError) {
        throw new Error('This resume changed in another session. Reload and inspect its current state before retrying. No action was automatically resent with a new version.')
      }
      throw caught
    } finally {
      const current = scope.mutationOwned(ticket)
      scope.finishMutation(ticket)
      if (current) {
        setPendingCount((value) => value - 1)
        if (!scope.busy) { leaveGuard.release(); void refresh() }
        void parentRef.current.cloud?.refreshWorkspaces().catch(caught => setError(`Workspace access refresh failed: ${realRequestError(caught, 'Try refreshing access again.')}`))
      }
    }
  }

  function putBatches(next: RealResumeImportBatch[]) {
    batchesRef.current = next
    setBatches(next)
  }

  function newBatch(): string {
    assertWritable()
    assertNewImports()
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
    assertNewImports()
    if (!inputs.length) throw new Error('Choose supported files or enter at least one public URL, one per line.')
    const id = currentBatchRef.current ?? newBatch()
    const batch = batchesRef.current.find((item) => item.id === id)!
    const features = featuresRef.current ? resumeFeaturesWithPolicy(featuresRef.current, policy.settings) : null
    const next = appendResumeInputs(batch, inputs, features?.resumeLimits, effectiveFormats(supportedUploadFormats({
      markdownResumeImports: featuresRef.current?.markdownResumeImports, wordDocumentImports: featuresRef.current?.wordDocumentImports,
    }), policy.settings, 'resumes'), policy.settings)
    putBatches(batchesRef.current.map((item) => item.id === id ? next : item))
  }

  function updateItem(batchId: string, key: string, update: Partial<RealResumeImportBatch['items'][number]>) {
    putBatches(batchesRef.current.map((batch) => batch.id === batchId
      ? { ...batch, items: batch.items.map((item) => item.key === key ? { ...item, ...update } : item) } : batch))
  }

  async function submitBatch(batchId: string, keys?: string[]) {
    assertWritable()
    assertNewImports()
    const batch = batchesRef.current.find((item) => item.id === batchId)
    if (!batch) throw new Error('This batch is no longer open. Check the real library for acknowledged imports.')
    if (keys?.some((key) => !batch.items.some((item) => item.key === key))) throw new Error('The requested import item is not part of this batch.')
    if (batch.items.some((item) => item.state === 'uploading')) throw new Error('This batch is still uploading. Wait for acknowledgement before retrying.')
    const selected = batch.items.filter((item) => (!keys || keys.includes(item.key)) && ['pending', 'unconfirmed'].includes(item.state))
    if (!selected.length) throw new Error('No valid, unacknowledged inputs remain in this batch. Invalid entries were not submitted.')
    const inputCount = batch.inputCount ?? batch.items.length
    requireImportBatch(inputCount, 'resumes', policy.settings)
    putBatches(batchesRef.current.map((item) => item.id === batchId
      ? { ...item, inputCount, items: item.items.map((input) => selected.some((candidate) => candidate.key === input.key) ? { ...input, state: 'uploading', error: undefined } : input) } : item))
    await Promise.all(selected.map(async (item) => {
      try {
        const summary = await mutate(`import:${item.key}`, () => {
          if (item.source.kind === 'url') return api.importRealResumeUrl(workspaceId, item.source.url, item.key, batchId, inputCount, undefined, policy.settings)
          if (item.source.kind === 'unsupported') throw new Error('This file type is not supported. It has not been sent.')
          if (!item.source.file) throw new Error('The accepted file is now server-owned. Inspect its saved record instead of resending it.')
          if (item.source.kind === 'markdown' && !featuresRef.current?.markdownResumeImports) {
            throw new Error('Markdown resume imports are not enabled in this deployment. PDFs and public URLs are still supported.')
          }
          if ((item.source.kind === 'docx' || item.source.kind === 'doc') && !featuresRef.current?.wordDocumentImports) {
            throw new Error('Word document imports are not enabled in this deployment.')
          }
          return api.importRealResumeFile(workspaceId, item.source.file, item.key, batchId, inputCount, undefined, policy.settings)
        }, remember)
        updateItem(batchId, item.key, {
          state: 'accepted', resumeId: summary.resume.id, error: undefined,
          source: item.source.kind === 'url' || item.source.kind === 'unsupported' ? item.source : { kind: item.source.kind, file: null },
        })
      } catch (caught) {
        // A request can be accepted even when its response is lost. Retrying preserves both keys and bytes.
        if (scope.isOpen && batchesRef.current.some((entry) => entry.id === batchId)) {
          updateItem(batchId, item.key, { state: 'unconfirmed', error: realRequestError(caught, 'Acceptance could not be confirmed. Retry this unchanged input with its original request key.') })
        }
      }
    }))
  }

  function assertNewImports() {
    assertClientAdmission(policy, 'resumeImports')
    if (!featuresRef.current?.realResumeImports) throw new Error('New resume imports are unavailable. Saved history remains readable.')
  }

  const value: RealResumesContextValue = {
    workspaceId, canWrite, phase, features: features ? { ...resumeFeaturesWithPolicy(features, policy.settings), realResumeImports: features.realResumeImports && !clientAdmissionReason(policy, 'resumeImports') } : null, error, summaries, refresh, ensureDetail,
    detail: (id) => details[id] ?? { state: 'idle' },
    pending: (id) => scope.pending(`resume:${id}`),
    retry: (id, etag) => mutate(`resume:${id}`, () => api.retryRealResume(workspaceId, id, etag), remember, false, id),
    cancel: (id, etag) => mutate(`resume:${id}`, () => api.cancelRealResume(workspaceId, id, etag), remember, false, id),
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
  function owns(target: LifecycleTarget) {
    return target.kind === 'resume' && (knownIds.current.has(target.id) || pendingLifecycleRef.current.some((item) => item.target.id === target.id))
  }

  async function renameEntity(target: RenameEntityTarget, name: string, etag?: string) {
    if (!owns(target)) return parentRef.current.renameEntity(target, name, etag)
    if (!etag) throw new Error('Reload this resume before editing its display label.')
    await mutate(`resume:${target.id}`, () => api.renameRealResume(workspaceId, target.id, name, etag), (summary, sequence) => {
      const cached = detailsRef.current[target.id]
      if (remember(summary, sequence) && cached?.state === 'ready' && cached.value.etag === etag) {
        putDetail(target.id, { state: 'ready', value: { ...cached.value, ...summary } })
      }
    }, false, target.id)
    parentRef.current.notify('Resume label saved. The stated name and original source are unchanged.')
  }

  async function changeLifecycle(target: LifecycleTarget, action: LifecycleAction) {
    if (!owns(target)) return parentRef.current.changeLifecycle(target, action)
    const pending = pendingLifecycleRef.current.find((item) => item.target.id === target.id)
    if (pending && pending.operation.action !== action) throw new Error('Finish the incomplete resume lifecycle operation before choosing another action.')
    const result = await mutate(`resume:${target.id}`, async () => {
      const fresh = await api.getRealResume(workspaceId, target.id)
      assertRealLifecyclePermission(parentRef.current, workspaceId)
      return api.changeRealResumeLifecycle(workspaceId, target.id, action, fresh.etag)
    }, (response, sequence) => {
      if (response.resume) {
        remember(response.resume, sequence)
        if (!lifecycleIsRemoved(response.resume.lifecycle)) putDetail(target.id, { state: 'ready', value: response.resume })
      }
      if (response.operation && response.operation.status !== 'complete') {
        const summary = summariesRef.current.find((item) => item.resume.id === target.id)
        setPendingLifecycle(reconcileLifecycleOperations(pendingLifecycleRef.current, [{
          target, name: summary ? getDisplayName(summary, summary.resume.name ?? summary.source.displayName) : pending?.name ?? 'Real resume', operation: response.operation,
        }]))
        if (action === 'delete') putDetail(target.id, { state: 'error', error: 'Deletion is still incomplete. Retry the lifecycle operation; cached source content has been cleared.' })
      } else if (response.deleted) removeResume(target.id, sequence)
    }, true)
    if (result.operation && result.operation.status !== 'complete') throw new LifecycleOperationError(result.operation)
    if (!result.resume && !result.deleted) throw new Error('The resume service has not acknowledged a completed lifecycle change. Refresh status before retrying.')
    setPendingLifecycle(pendingLifecycleRef.current.filter((item) => item.target.id !== target.id))
    parentRef.current.notify(action === 'delete' ? 'Permanent resume deletion acknowledged.' : action === 'archive' ? 'Resume archived. Its unfinished processing was stopped; saved analyses are unchanged.' : 'Resume unarchived. Processing has not restarted.')
  }

  const workspace = useMemo(() => projectRealLifecycle(parent.workspace, 'resume', summaries.map((item) => ({
    id: item.resume.id, lifecycle: item.lifecycle,
  }))), [parent.workspace, summaries])
  const projected = {
    ...parent, workspace, changeLifecycle, renameEntity,
    getLifecycleImpact: (target: LifecycleTarget) => owns(target) ? api.getRealResumeLifecycleImpact(workspaceId, target.id) : parentRef.current.getLifecycleImpact(target),
    lifecycleOperations: [...(parent.lifecycleOperations ?? []), ...pendingLifecycle],
  }
  return <WorkspaceContext.Provider value={projected}><RealResumesContext.Provider value={value}>{children}</RealResumesContext.Provider></WorkspaceContext.Provider>
}
