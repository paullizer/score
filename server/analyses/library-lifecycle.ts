import { randomUUID } from 'node:crypto'
import { gradeHeadId } from '../../src/domain/real-grades'
import { getDisplayName } from '../../src/domain/displayNames'
import type { LifecycleAction, LifecycleBlocker, LifecycleImpact, LifecycleOperation, LifecycleTarget } from '../../src/domain/lifecycle'
import type { RealAnalysisDetail, RealAnalysisRunRecord, VersionedAnalysisEntity } from '../../src/domain/real-analyses'
import type { WorkspaceLifecycleParticipant } from '../lifecycle/contracts'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { conflict, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { StoreConflictError } from '../store'
import { WORKSPACE_ID_PATTERN } from '../ids'
import type { AnalysisLifecycleControl, AnalysisTransaction, RealAnalysesDeps, StoredAnalysisControl } from './store'
import { advanceAnalysisRun, loadAnalysisRun } from './lifecycle'
import { analysisIsRemoved, newAnalysisControl, updateAnalysisControl } from './guards'
import { parseAnalysisJson, readAnalysisBlob, readAnalysisManifest } from './snapshots'
import {
  analysisBlobInRun, analysisCancellationNeedsRetry, analysisHash, assertAnalysis, isAnalysisId, MAX_ANALYSIS_TRANSACTION_BYTES,
  parseAnalysisEntity, parseFrozenTargetSnapshot,
} from './validation'

type Run = VersionedAnalysisEntity<RealAnalysisRunRecord>
const MAINTENANCE_CHUNKS = 4
const CLEANUP_ERROR = 'Cleanup is incomplete. Retry this lifecycle action; the analysis remains fenced.'

export interface AnalysisLibraryLifecycleResult {
  deleted?: true
  pending?: true
  operation?: LifecycleOperation
  etag?: string
  analysis?: RealAnalysisDetail
}

function scope(workspaceId: string, runId?: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId) || (runId !== undefined && !isAnalysisId(runId, 'run'))) {
    throw notFound('The requested analysis was not found.')
  }
}
function pageToken(token: string | undefined, seen: Set<string>): void {
  if (token && (seen.has(token) || seen.size >= 10_000)) throw unavailable('Analysis lifecycle pagination did not advance.')
  if (token) seen.add(token)
}
async function runs(analyses: RealAnalysesDeps, workspaceId: string): Promise<Run[]> {
  scope(workspaceId)
  const values: Run[] = []
  const ids = new Set<string>()
  const seen = new Set<string>()
  let continuationToken: string | undefined
  do {
    const page = await analyses.store.list(workspaceId, { recordType: 'analysis-run', limit: 100, continuationToken })
    for (const value of page.items) {
      const record = parseAnalysisEntity(value.record)
      assertAnalysis(record.recordType === 'analysis-run' && record.workspaceId === workspaceId && value.etag &&
        !ids.has(record.id), 'Analysis lifecycle listing returned foreign or duplicate runs.')
      ids.add(record.id)
      values.push({ record, etag: value.etag })
    }
    continuationToken = page.continuationToken
    pageToken(continuationToken, seen)
  } while (continuationToken)
  return values
}
async function controls(analyses: RealAnalysesDeps, workspaceId: string): Promise<StoredAnalysisControl[]> {
  const values: StoredAnalysisControl[] = []
  const seen = new Set<string>()
  let continuationToken: string | undefined
  do {
    const page = await analyses.store.listControls(workspaceId, continuationToken)
    for (const value of page.items) {
      assertAnalysis(value.record.workspaceId === workspaceId && value.etag, 'Analysis lifecycle control escaped its workspace.')
      values.push(value)
    }
    continuationToken = page.continuationToken
    pageToken(continuationToken, seen)
  } while (continuationToken)
  return values
}

/** Only immutable evidence determines historical references; live source heads are not required. */
async function dependencyTargets(analyses: RealAnalysesDeps, run: RealAnalysisRunRecord): Promise<LifecycleTarget[]> {
  const control = await analyses.store.getControl(run.workspaceId, run.id)
  if (analysisIsRemoved(run.lifecycle) && control?.record.dependencies) {
    assertAnalysis(control.record.state === 'deleting' && control.record.dependencies.manifestSha256 === run.manifest.sha256,
      'Analysis dependency recovery does not match its immutable manifest.')
    return control.record.dependencies.targets
  }
  const manifest = await readAnalysisManifest(analyses.blobs, run)
  const targets = new Map<string, LifecycleTarget>()
  const add = (kind: LifecycleTarget['kind'], id: string) => { targets.set(`${kind}:${id}`, { kind, id }) }
  for (const ref of manifest.resumes) add('resume', ref.summary.selection.resumeId)
  for (const ref of manifest.targets) {
    const snapshot = parseFrozenTargetSnapshot(parseAnalysisJson(await readAnalysisBlob(
      analyses.blobs, ref.blob, run.workspaceId, run.id,
    )))
    assertAnalysis(snapshot.workspaceId === run.workspaceId && snapshot.snapshotId === ref.snapshotId &&
      snapshot.frozenAt === manifest.createdAt && analysisHash(snapshot.summary) === analysisHash(ref.summary),
    'Dependency snapshot does not match the accepted manifest.')
    if (snapshot.kind === 'job') {
      assertAnalysis(analysisBlobInRun(snapshot.original.blobName, run.workspaceId, run.id), 'Dependency original belongs to another run.')
      add('job', snapshot.selection.jobId)
      add('rubric', snapshot.rubric.groupId)
      add('rubric', snapshot.rubric.id)
    } else {
      assertAnalysis(snapshot.references.every(item => analysisBlobInRun(item.document.blobName, run.workspaceId, run.id)),
        'Dependency reference belongs to another run.')
      add('ladder', snapshot.selection.ladderId)
      add('rubric', gradeHeadId(snapshot.selection.ladderId, snapshot.selection.grade))
      add('rubric', snapshot.version.rubric.groupId)
      add('rubric', snapshot.version.rubric.id)
      add('job', snapshot.seed.job.id)
      add('rubric', snapshot.seed.rubric.groupId)
      add('rubric', snapshot.seed.rubric.id)
    }
  }
  return [...targets.values()]
}

export async function realAnalysisDependencyBlockers(
  analyses: RealAnalysesDeps, workspaceId: string, target: LifecycleTarget,
): Promise<LifecycleBlocker[]> {
  scope(workspaceId)
  if (target.kind === 'analysis') return []
  try {
    const blockers: LifecycleBlocker[] = []
    for (const { record } of await runs(analyses, workspaceId)) {
      if (target.kind !== 'workspace' && !(await dependencyTargets(analyses, record))
        .some(value => value.kind === target.kind && value.id === target.id)) continue
      blockers.push({ kind: 'analysis', id: record.id, name: getDisplayName(record, record.name), href: `/analyses/${encodeURIComponent(record.id)}?data=real` })
    }
    return blockers
  } catch {
    throw unavailable('Retained real analysis dependencies could not be verified. Source deletion is blocked until their storage is readable.')
  }
}

function timestampAfter(timestamp: string, run: RealAnalysisRunRecord): string {
  return timestamp < run.updatedAt ? run.updatedAt : timestamp
}
function needsCancellation(run: RealAnalysisRunRecord): boolean {
  return Boolean(run.cancellation && !run.cancellation.completedAt) ||
    run.progress.initialized < run.progress.total || run.progress.queued + run.progress.running > 0
}
function cancelled(run: RealAnalysisRunRecord, timestamp: string, actor: string): RealAnalysisRunRecord {
  const next = structuredClone(run)
  if (!needsCancellation(next)) return next
  next.status = 'cancelled'
  next.cancellation ??= { requestedAt: timestamp, requestedBy: actor, nextComparisonIndex: 0 }
  next.attempts = 0
  delete next.error
  delete next.lease
  delete next.attemptId
  delete next.nextAttemptAt
  return next
}
async function managed(analyses: RealAnalysesDeps, workspaceId: string, runId: string): Promise<Run> {
  scope(workspaceId, runId)
  const run = await loadAnalysisRun(analyses.store, workspaceId, runId)
  if (!run || run.record.lifecycle?.deletedAt) throw notFound('The requested analysis was not found.')
  return run
}
async function recoveryDetail(analyses: RealAnalysesDeps, run: Run, minimal = false): Promise<RealAnalysisDetail> {
  const control = await analyses.store.getControl(run.record.workspaceId, run.record.id)
  const base = {
    run: run.record, etag: run.etag, ...(run.record.lifecycle ? { lifecycle: run.record.lifecycle } : {}),
    ...(control?.record.operation ? { operation: control.record.operation } : {}),
  }
  if (minimal || analysisIsRemoved(run.record.lifecycle)) return { ...base, resumes: [], targets: [] }
  const manifest = await readAnalysisManifest(analyses.blobs, run.record)
  return { ...base, resumes: manifest.resumes.map(item => item.summary), targets: manifest.targets.map(item => item.summary) }
}

async function startOperation(
  analyses: RealAnalysesDeps, current: Run, action: LifecycleAction, timestamp: string, actor: string, parent = false,
  requestedOperation?: LifecycleOperation,
): Promise<LifecycleOperation> {
  const { workspaceId, id } = current.record
  const control = await analyses.store.getControl(workspaceId, id)
  const operation = requestedOperation ?? (control?.record.operation?.action === action && control.record.operation.status !== 'complete'
    ? { ...control.record.operation, status: 'running' as const, updatedAt: timestamp, error: undefined }
    : { id: randomUUID(), action, status: 'running' as const, updatedAt: timestamp })
  const now = timestampAfter(timestamp, current.record)
  const record = cancelled(current.record, now, actor)
  record.updatedAt = now
  record.narrativeCancelledAt = now
  if (action === 'delete') delete record.narrativeRequestId
  if (!parent && action === 'archive') record.lifecycle = { ...record.lifecycle, archivedAt: record.lifecycle?.archivedAt ?? now }
  if (action === 'delete') record.lifecycle = { ...record.lifecycle, deletingAt: record.lifecycle?.deletingAt ?? now }
  const next: AnalysisLifecycleControl = {
    ...(control?.record ?? newAnalysisControl(workspaceId, now, id)), updatedAt: now, operation,
    state: record.lifecycle?.deletingAt ? 'deleting' : record.lifecycle?.archivedAt ? 'archived' : 'active',
    ...(action === 'delete' ? {
      dependencies: { manifestSha256: record.manifest.sha256, targets: await dependencyTargets(analyses, current.record) },
    } : {}),
  }
  assertWorkspaceMutationLease(workspaceId)
  await analyses.store.transact(workspaceId, [{ kind: 'replace', record, etag: current.etag }], {
    lifecycle: true, controls: [{ record: next, etag: control?.etag }],
  })
  return operation
}

async function purgeComparisons(
  analyses: RealAnalysesDeps, workspaceId: string, runId: string, timestamp: string,
  recordType: 'analysis-comparison' | 'analysis-candidate-narrative' | 'analysis-target-narrative' | 'analysis-narrative-request',
): Promise<boolean> {
  let continuationToken: string | undefined
  const seen = new Set<string>()
  let chunks = 0
  while (chunks < MAINTENANCE_CHUNKS) {
    const page = await analyses.store.list(workspaceId, { recordType, runId, limit: 25, continuationToken })
    if (!page.items.length) {
      continuationToken = page.continuationToken
      pageToken(continuationToken, seen)
      if (!continuationToken) return true
      continue
    }
    const current = await managed(analyses, workspaceId, runId)
    const control = await analyses.store.getControl(workspaceId, runId)
    let bytes = Buffer.byteLength(JSON.stringify(current.record)) + Buffer.byteLength(JSON.stringify(control?.record ?? {})) + 4096
    const operations: AnalysisTransaction[] = []
    for (const value of page.items) {
      const record = parseAnalysisEntity(value.record)
      assertAnalysis(record.recordType === recordType && record.workspaceId === workspaceId && record.runId === runId &&
        value.etag, 'Analysis cleanup attempted to remove an unrelated comparison.')
      const operation: AnalysisTransaction = { kind: 'delete', record, etag: value.etag }
      const size = Buffer.byteLength(JSON.stringify(operation))
      if (bytes + size > MAX_ANALYSIS_TRANSACTION_BYTES) break
      operations.push(operation)
      bytes += size
    }
    assertAnalysis(operations.length, 'Analysis cleanup cannot fit its bounded transaction.')
    operations.push({ kind: 'replace', record: { ...current.record, updatedAt: timestampAfter(timestamp, current.record) }, etag: current.etag })
    assertWorkspaceMutationLease(workspaceId)
    await analyses.store.transact(workspaceId, operations, { lifecycle: true })
    if (operations.length === page.items.length + 1 && !page.continuationToken) return true
    // Deletion changes offsets. Start over, but never stop at an empty page that has a continuation.
    continuationToken = undefined
    seen.clear()
    chunks++
  }
  return false
}
async function purgeBlobs(analyses: RealAnalysesDeps, workspaceId: string, runId: string): Promise<boolean> {
  const control = await analyses.store.getControl(workspaceId, runId)
  if (!control || !['deleting', 'deleted'].includes(control.record.state)) throw new StoreConflictError('Analysis cleanup is not fenced.')
  if (Object.values(control.record.writers ?? {}).some(writer => Date.parse(writer.expiresAt) > Date.now())) return false
  let continuationToken: string | undefined
  const seen = new Set<string>()
  let chunks = 0
  while (chunks < MAINTENANCE_CHUNKS) {
    const page = await analyses.blobs.list(workspaceId, runId, continuationToken)
    for (const item of page.items) {
      assertAnalysis(analysisBlobInRun(item.name, workspaceId, runId) && item.etag, 'Analysis cleanup crossed its private source prefix.')
      assertWorkspaceMutationLease(workspaceId)
      await analyses.blobs.delete(workspaceId, runId, item.name, item.etag)
    }
    // Writers are drained and new writes are fenced, so an exhausted page proves cleanup is complete.
    if (!page.continuationToken) return true
    if (page.items.length) {
      continuationToken = undefined
      seen.clear()
      chunks++
    } else {
      continuationToken = page.continuationToken
      pageToken(continuationToken, seen)
    }
  }
  return false
}
async function finishOperation(analyses: RealAnalysesDeps, workspaceId: string, runId: string, timestamp: string): Promise<boolean> {
  let current = await managed(analyses, workspaceId, runId)
  let control = await analyses.store.getControl(workspaceId, runId)
  const operation = control?.record.operation
  if (!operation || !control) throw unavailable('The durable analysis lifecycle operation is unavailable.')
  if (operation.status === 'complete') return true
  if (needsCancellation(current.record)) {
    if (analysisCancellationNeedsRetry(current.record)) {
      throw unavailable('Analysis cancellation is paused. Retry the lifecycle action explicitly to resume cleanup.')
    }
    if (!current.record.cancellation) {
      const record = cancelled(current.record, timestampAfter(timestamp, current.record), 'analysis-lifecycle')
      record.updatedAt = timestampAfter(timestamp, current.record)
      assertWorkspaceMutationLease(workspaceId)
      await analyses.store.transact(workspaceId, [{ kind: 'replace', record, etag: current.etag }], { lifecycle: true })
    }
    current = await advanceAnalysisRun(analyses, workspaceId, runId, {
      now: () => new Date(timestampAfter(timestamp, current.record)), maxChunks: MAINTENANCE_CHUNKS, lifecycle: true,
    })
    if (needsCancellation(current.record)) return false
  }
  if (operation.action === 'delete') {
    for (const type of ['analysis-candidate-narrative', 'analysis-target-narrative', 'analysis-narrative-request', 'analysis-comparison'] as const) {
      if (!await purgeComparisons(analyses, workspaceId, runId, timestamp, type)) return false
    }
    if (!await purgeBlobs(analyses, workspaceId, runId)) return false
    current = await managed(analyses, workspaceId, runId)
    control = await analyses.store.getControl(workspaceId, runId)
    assertAnalysis(control?.record.state === 'deleting' && control.record.dependencies, 'Analysis deletion recovery was lost.')
    const tombstone = {
      ...newAnalysisControl(workspaceId, timestampAfter(timestamp, current.record), runId), state: 'deleted' as const,
    }
    assertWorkspaceMutationLease(workspaceId)
    await analyses.store.transact(workspaceId, [{ kind: 'delete', record: current.record, etag: current.etag }], {
      lifecycle: true, controls: [{ record: tombstone, etag: control.etag }],
    })
    return true
  }
  current = await managed(analyses, workspaceId, runId)
  control = await analyses.store.getControl(workspaceId, runId)
  assertAnalysis(control?.record.operation?.id === operation.id && !analysisIsRemoved(current.record.lifecycle),
    'The analysis lifecycle operation changed before completion.')
  const record = structuredClone(current.record)
  if (record.cancellation?.completedAt) delete record.error
  if (operation.action === 'unarchive' && record.lifecycle) {
    delete record.lifecycle.archivedAt
    if (!Object.keys(record.lifecycle).length) delete record.lifecycle
  }
  record.updatedAt = timestampAfter(timestamp, current.record)
  assertWorkspaceMutationLease(workspaceId)
  await analyses.store.transact(workspaceId, [{ kind: 'replace', record, etag: current.etag }], {
    lifecycle: true, controls: [{
      record: { ...control.record, state: record.lifecycle?.archivedAt ? 'archived' : 'active',
        operation: { ...operation, status: 'complete', updatedAt: record.updatedAt, error: undefined }, updatedAt: record.updatedAt },
      etag: control.etag,
    }],
  })
  return true
}
async function markPending(
  analyses: RealAnalysesDeps, workspaceId: string, runId: string, operation: LifecycleOperation,
  timestamp: string, failed: boolean,
): Promise<LifecycleOperation> {
  const pending: LifecycleOperation = {
    ...operation, status: failed ? 'failed' : 'pending', updatedAt: timestamp, ...(failed ? { error: CLEANUP_ERROR } : {}),
  }
  await updateAnalysisControl(analyses.store, workspaceId, runId, record => {
    if (record.state === 'deleted' || record.operation?.id !== operation.id) throw new StoreConflictError('Analysis cleanup has already changed.')
    return { ...record, operation: pending, updatedAt: timestamp }
  })
  return pending
}
async function operationCompleted(
  analyses: RealAnalysesDeps, workspaceId: string, runId: string, operation: LifecycleOperation,
): Promise<boolean> {
  const control = await analyses.store.getControl(workspaceId, runId)
  return Boolean(control && (operation.action === 'delete' && control.record.state === 'deleted' ||
    control.record.operation?.id === operation.id && control.record.operation.status === 'complete'))
}

export class AnalysisLibraryLifecycleService {
  constructor(private readonly analyses: RealAnalysesDeps, private readonly now: () => Date = () => new Date()) {}

  async impact(workspaceId: string, runId: string): Promise<LifecycleImpact> {
    const run = await managed(this.analyses, workspaceId, runId)
    return {
      target: { kind: 'analysis', id: runId }, name: getDisplayName(run.record, run.record.name),
      counts: { analyses: 1, analysisComparisons: run.record.progress.total,
        completedResults: run.record.progress.complete }, blockers: [],
    }
  }
  async change(workspaceId: string, runId: string, action: LifecycleAction, expected: string, actor: string): Promise<AnalysisLibraryLifecycleResult> {
    if (!['archive', 'unarchive', 'delete'].includes(action)) throw invalidRequest('Unsupported analysis lifecycle action.')
    const current = await managed(this.analyses, workspaceId, runId)
    if (!expected) throw preconditionRequired('An exact run If-Match ETag is required.')
    if (!expected.trim() || expected === '*' || expected.length > 1024 || /[,\r\n]/.test(expected)) throw invalidRequest('An exact run If-Match ETag is required.')
    if (current.etag !== expected) throw conflict('This analysis changed. Reload its current run ETag before changing its lifecycle.')
    if (!actor.trim() || actor.length > 200) throw invalidRequest('An authenticated lifecycle actor is required.')
    if (action !== 'delete' && analysisIsRemoved(current.record.lifecycle)) throw conflict('Finish permanent analysis deletion before changing archive state.')
    if (action === 'unarchive' && !current.record.lifecycle?.archivedAt) {
      return { analysis: await recoveryDetail(this.analyses, current), etag: current.etag }
    }
    const timestamp = timestampAfter(this.now().toISOString(), current.record)
    let operation: LifecycleOperation = { id: randomUUID(), action, status: 'running', updatedAt: timestamp }
    try { await startOperation(this.analyses, current, action, timestamp, actor, false, operation) } catch (error) {
      const persisted = await this.analyses.store.getControl(workspaceId, runId)
      if (persisted?.record.operation?.id !== operation.id) {
        if (error instanceof StoreConflictError) throw conflict('The analysis changed before its lifecycle transition.')
        throw error
      }
    }
    let failed = false
    try {
      if (await finishOperation(this.analyses, workspaceId, runId, timestamp)) {
        if (action === 'delete') return { deleted: true }
        const analysis = await recoveryDetail(this.analyses, await managed(this.analyses, workspaceId, runId))
        return { analysis, etag: analysis.etag }
      }
    } catch { failed = true }
    // An ambiguous final commit can be acknowledged from its permanent, minimal tombstone.
    let latest: Run | undefined
    try {
      latest = await loadAnalysisRun(this.analyses.store, workspaceId, runId)
      if (!latest && (await this.analyses.store.getControl(workspaceId, runId))?.record.state === 'deleted') return { deleted: true }
      if (latest && action !== 'delete' && await operationCompleted(this.analyses, workspaceId, runId, operation)) {
        const analysis = await recoveryDetail(this.analyses, latest)
        return { analysis, etag: analysis.etag }
      }
    } catch { failed = true }
    try { operation = await markPending(this.analyses, workspaceId, runId, operation, timestamp, failed) } catch {
      operation = { ...operation, status: 'failed', error: CLEANUP_ERROR }
    }
    return {
      pending: true, operation, ...(latest ? { etag: latest.etag, analysis: {
        run: latest.record, etag: latest.etag, lifecycle: latest.record.lifecycle, operation, resumes: [], targets: [],
      } } : {}),
    }
  }
}

export function createAnalysisLifecycleParticipant(analyses: RealAnalysesDeps): WorkspaceLifecycleParticipant {
  const participant: WorkspaceLifecycleParticipant = {
    pendingWorkspaces: limit => analyses.store.pendingLifecycleWorkspaces(limit),
    async setState(workspaceId, state, timestamp) {
      scope(workspaceId)
      await updateAnalysisControl(analyses.store, workspaceId, undefined, control => ({
        ...control, state: control.state === 'deleted' && state === 'deleting' ? 'deleted' : state, updatedAt: timestamp,
      }))
    },
    async cancel(workspaceId, timestamp) {
      let pending = false
      for (const current of await runs(analyses, workspaceId)) {
        if (analysisIsRemoved(current.record.lifecycle)) continue
        const previous = (await analyses.store.getControl(workspaceId, current.record.id))?.record.operation
        const operation = previous?.action === 'archive' && previous.status !== 'complete'
          ? previous : await startOperation(analyses, current, 'archive', timestamp, 'workspace-lifecycle', true)
        try {
          if (!await finishOperation(analyses, workspaceId, current.record.id, timestamp)) {
            pending = true
            await markPending(analyses, workspaceId, current.record.id, operation, timestamp, false)
          }
        } catch {
          if (await operationCompleted(analyses, workspaceId, current.record.id, operation)) continue
          pending = true
          await markPending(analyses, workspaceId, current.record.id, operation, timestamp, true)
        }
      }
      if (pending) throw unavailable('Workspace analysis cancellation is still completing.')
    },
    async purge(workspaceId, timestamp) {
      const workspace = await analyses.store.getControl(workspaceId)
      if (!workspace || !['deleting', 'deleted'].includes(workspace.record.state)) throw new StoreConflictError('Workspace analysis deletion is not fenced.')
      // Workspace deletion is never an implicit cascade of retained runs, including archived runs.
      if ((await runs(analyses, workspaceId)).length) throw new StoreConflictError('Delete retained real analyses before deleting this workspace.')
      const families = new Set((await controls(analyses, workspaceId)).flatMap(value => value.record.runId ? [value.record.runId] : []))
      const seen = new Set<string>()
      let continuationToken: string | undefined
      do {
        const page = await analyses.blobs.list(workspaceId, undefined, continuationToken)
        for (const item of page.items) {
          const runId = item.name.split('/')[1]
          assertAnalysis(analysisBlobInRun(item.name, workspaceId, runId), 'Workspace analysis cleanup crossed its ownership scope.')
          families.add(runId)
        }
        continuationToken = page.continuationToken
        pageToken(continuationToken, seen)
      } while (continuationToken)
      for (const runId of families) {
        await updateAnalysisControl(analyses.store, workspaceId, runId, control => ({
          ...control, state: control.state === 'deleted' ? 'deleted' : 'deleting', updatedAt: timestamp,
        }))
        if (!await purgeBlobs(analyses, workspaceId, runId)) throw unavailable('Unpublished analysis sources are still draining.')
        await updateAnalysisControl(analyses.store, workspaceId, runId, () => ({
          ...newAnalysisControl(workspaceId, timestamp, runId), state: 'deleted',
        }))
      }
      await participant.setState(workspaceId, 'deleted', timestamp)
    },
    async counts(workspaceId) {
      const retained = await runs(analyses, workspaceId)
      return { analyses: retained.length, analysisComparisons: retained.reduce((total, run) => total + run.record.progress.initialized, 0) }
    },
    async resume(workspaceId, timestamp) {
      const workspace = await analyses.store.getControl(workspaceId)
      if (workspace && ['deleting', 'deleted'].includes(workspace.record.state)) {
        await participant.purge(workspaceId, timestamp)
        return
      }
      let pending = false
      for (const value of await controls(analyses, workspaceId)) {
        const { record } = value
        if (!record.runId || !record.operation || record.operation.status === 'complete') continue
        try {
          if (!await finishOperation(analyses, workspaceId, record.runId, timestamp)) {
            pending = true
            await markPending(analyses, workspaceId, record.runId, record.operation, timestamp, false)
          }
        } catch {
          if (await operationCompleted(analyses, workspaceId, record.runId, record.operation)) continue
          pending = true
          await markPending(analyses, workspaceId, record.runId, record.operation, timestamp, true)
        }
      }
      if (pending) throw unavailable('Analysis lifecycle cleanup is still completing.')
    },
  }
  return participant
}
