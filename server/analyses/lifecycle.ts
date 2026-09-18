import {
  ANALYSIS_LIMITS, type RealAnalysisRunRecord, type RealAnalysisComparisonRecord,
  type RealAnalysisInitializationManifest, type VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import { StoreConflictError } from '../store'
import type { AnalysisStore, AnalysisTransaction, RealAnalysesDeps } from './store'
import { assertComparisonManifestBinding, readAnalysisManifest } from './snapshots'
import { analysisCancellationNeedsRetry, analysisHash, assertAnalysis, MAX_ANALYSIS_TRANSACTION_BYTES, parseAnalysisEntity } from './validation'

export async function loadAnalysisRun(
  store: AnalysisStore, workspaceId: string, runId: string,
): Promise<VersionedAnalysisEntity<RealAnalysisRunRecord> | undefined> {
  const value = await store.get(workspaceId, runId)
  if (!value) return undefined
  const record = parseAnalysisEntity(value.record)
  if (record.recordType !== 'analysis-run' || record.workspaceId !== workspaceId || record.id !== runId) return undefined
  assertAnalysis(value.etag, 'Run lookup returned no ETag.')
  return { record, etag: value.etag }
}
export async function loadAnalysisComparison(
  store: AnalysisStore, workspaceId: string, runId: string, comparisonId: string,
): Promise<VersionedAnalysisEntity<RealAnalysisComparisonRecord> | undefined> {
  const value = await store.get(workspaceId, comparisonId)
  if (!value) return undefined
  const record = parseAnalysisEntity(value.record)
  if (record.recordType !== 'analysis-comparison' || record.workspaceId !== workspaceId || record.id !== comparisonId || record.runId !== runId) return undefined
  assertAnalysis(value.etag, 'Comparison lookup returned no ETag.')
  return { record, etag: value.etag }
}
export function analysisRunStatus(run: RealAnalysisRunRecord): RealAnalysisRunRecord['status'] {
  const p = run.progress
  if (run.cancellation) return 'cancelled'
  if (p.initialized < p.total) return 'initializing'
  if (p.running > 0) return 'running'
  if (p.queued > 0) return 'queued'
  if (p.complete === p.total) return 'complete'
  if (p.complete > 0) return 'partial'
  if (p.failed > 0) return 'failed'
  return 'cancelled'
}

/** Include the returned run and the comparison in ONE transaction, fenced by BOTH current ETags. */
export function applyAnalysisComparisonTransition(
  run: RealAnalysisRunRecord, previous: RealAnalysisComparisonRecord | undefined,
  next: RealAnalysisComparisonRecord, timestamp: string,
): RealAnalysisRunRecord {
  assertAnalysis(next.workspaceId === run.workspaceId && next.runId === run.id &&
    (!previous || (previous.id === next.id && previous.runId === run.id && previous.index === next.index &&
      analysisHash(previous.resume) === analysisHash(next.resume) && analysisHash(previous.target) === analysisHash(next.target))),
  'Comparison transition changed its input identity.')
  assertAnalysis(!previous || previous.status !== 'complete' || analysisHash(previous) === analysisHash(next), 'Completed evidence is immutable.')
  assertAnalysis(!run.cancellation || next.status === 'cancelled' || next.status === previous?.status, 'Cancellation fences late comparison publication.')
  assertAnalysis(run.progress.initialized === run.progress.total || !['running', 'complete'].includes(next.status),
    'Scoring must wait until initialization completes.')
  const updated = structuredClone(run)
  const p = updated.progress
  if (previous) {
    p[previous.status]--
    if (previous.status === 'complete') p[previous.resultSummary!.overall.status === 'available' ? 'scored' : 'unscored']--
  } else {
    assertAnalysis(next.index === p.initialized, 'New comparisons must initialize in manifest order.')
    p.initialized++
    updated.initialization.nextComparisonIndex = p.initialized
    if (p.initialized === p.total) updated.initialization.completedAt = timestamp
  }
  p[next.status]++
  if (next.status === 'complete') p[next.resultSummary!.overall.status === 'available' ? 'scored' : 'unscored']++
  updated.updatedAt = timestamp
  updated.status = analysisRunStatus(updated)
  if (p.initialized === p.total) {
    delete updated.lease
    delete updated.nextAttemptAt
  }
  if (['complete', 'partial', 'failed', 'cancelled'].includes(updated.status) && p.initialized === p.total && p.queued + p.running === 0) {
    updated.completedAt ??= timestamp
  } else delete updated.completedAt
  return updated
}

export function analysisComparisonFromPlan(
  manifest: RealAnalysisInitializationManifest, index: number, timestamp: string, cancelled = false,
): RealAnalysisComparisonRecord {
  const pair = manifest.comparisons[index]
  assertAnalysis(pair, 'Comparison index is not in the manifest.')
  const resume = manifest.resumes.find(item => item.snapshotId === pair.resumeSnapshotId)
  const target = manifest.targets.find(item => item.snapshotId === pair.targetSnapshotId)
  assertAnalysis(resume && target, 'Manifest snapshot references are missing.')
  return {
    id: pair.id, recordType: 'analysis-comparison', workspaceId: manifest.workspaceId, dataKind: 'real',
    createdAt: manifest.createdAt, updatedAt: timestamp, runId: manifest.runId, index,
    status: cancelled ? 'cancelled' : 'queued', resume, target, attempts: 0, retryCount: 0,
    ...(cancelled ? { cancelledAt: timestamp } : { nextAttemptAt: timestamp }),
  }
}
export function cancelAnalysisComparisonRecord(record: RealAnalysisComparisonRecord, timestamp: string): RealAnalysisComparisonRecord {
  assertAnalysis(record.status === 'queued' || record.status === 'running', 'Only active comparisons can be cancelled.')
  const updated: RealAnalysisComparisonRecord = { ...structuredClone(record), status: 'cancelled', updatedAt: timestamp, cancelledAt: timestamp }
  delete updated.lease
  delete updated.nextAttemptAt
  delete updated.error
  return updated
}
export function retryAnalysisComparisonRecord(record: RealAnalysisComparisonRecord, timestamp: string): RealAnalysisComparisonRecord {
  assertAnalysis(record.status === 'failed' || record.status === 'cancelled', 'Only failed or cancelled comparisons can be retried.')
  const updated: RealAnalysisComparisonRecord = {
    ...structuredClone(record), status: 'queued', updatedAt: timestamp, attempts: 0,
    retryCount: record.retryCount + 1, nextAttemptAt: timestamp,
  }
  delete updated.lease
  delete updated.attemptId
  delete updated.error
  delete updated.cancelledAt
  delete updated.completedAt
  return updated
}

export interface AdvanceAnalysisRunOptions {
  now?: () => Date
  maxChunks?: number
  // A worker that already claimed a run can advance its own live initialization lease.
  leaseOwner?: string
  // Owner labels can be reused; an older attempt must not adopt a newer claim.
  expectedAttemptId?: string
}

/** Bounded recovery uses only the analysis stores; it never resolves mutable source libraries. */
export async function advanceAnalysisRun(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, options: AdvanceAnalysisRunOptions = {},
): Promise<VersionedAnalysisEntity<RealAnalysisRunRecord>> {
  const maxChunks = options.maxChunks ?? 1
  assertAnalysis(Number.isInteger(maxChunks) && maxChunks > 0 && maxChunks <= 4, 'maxChunks must be between 1 and 4.')
  let chunks = 0
  let races = 0
  let current = await loadAnalysisRun(deps.store, workspaceId, runId)
  assertAnalysis(current, 'Run was not found.')
  while (chunks < maxChunks) {
    const timestamp = (options.now ?? (() => new Date()))().toISOString()
    const run = current.record
    if (options.expectedAttemptId !== undefined && run.attemptId !== options.expectedAttemptId) return current
    const cancelling = Boolean(run.cancellation && !run.cancellation.completedAt)
    if (run.status !== 'initializing' && !cancelling) return current
    if (analysisCancellationNeedsRetry(run)) return current
    if ((run.nextAttemptAt && run.nextAttemptAt > timestamp) ||
      (run.lease && run.lease.expiresAt > timestamp && run.lease.owner !== options.leaseOwner)) return current
    const manifest = await readAnalysisManifest(deps.blobs, run)
    const start = cancelling ? run.cancellation!.nextComparisonIndex : run.initialization.nextComparisonIndex
    const end = Math.min(start + ANALYSIS_LIMITS.initializationChunkSize, run.progress.total)
    let updated = structuredClone(run)
    const operations: AnalysisTransaction[] = []
    let cursor = start
    let bytes = 0
    for (; cursor < end; cursor++) {
      const pair = manifest.comparisons[cursor]
      const existing = await loadAnalysisComparison(deps.store, workspaceId, runId, pair.id)
      let operation: AnalysisTransaction | undefined
      let candidate = updated
      if (existing) {
        assertComparisonManifestBinding(manifest, existing.record)
        assertAnalysis(cancelling && existing.record.index < run.progress.initialized,
          'An initialized comparison is ahead of the durable cursor.')
        if (existing.record.status === 'queued' || existing.record.status === 'running') {
          const cancelled = cancelAnalysisComparisonRecord(existing.record, timestamp)
          candidate = applyAnalysisComparisonTransition(updated, existing.record, cancelled, timestamp)
          operation = { kind: 'replace', record: cancelled, etag: existing.etag }
        }
      } else {
        assertAnalysis(cursor >= run.progress.initialized, 'A previously initialized comparison is missing.')
        const comparison = analysisComparisonFromPlan(manifest, cursor, timestamp, cancelling)
        candidate = applyAnalysisComparisonTransition(updated, undefined, comparison, timestamp)
        operation = { kind: 'create', record: comparison }
      }
      const operationBytes = operation ? Buffer.byteLength(JSON.stringify(operation)) : 0
      if (bytes + operationBytes + Buffer.byteLength(JSON.stringify(candidate)) + 4096 > MAX_ANALYSIS_TRANSACTION_BYTES) break
      updated = candidate
      if (operation) { parseAnalysisEntity(operation.record); operations.push(operation); bytes += operationBytes }
    }
    assertAnalysis(cursor > start || start === run.progress.total, 'A comparison cannot fit the bounded initialization transaction.')
    updated.updatedAt = timestamp
    if (cancelling) {
      updated.cancellation!.nextComparisonIndex = cursor
      updated.status = 'cancelled'
      if (cursor === run.progress.total) {
        updated.cancellation!.completedAt = timestamp
        updated.completedAt = timestamp
        delete updated.lease
        delete updated.nextAttemptAt
      }
    } else if (cursor === run.progress.total) {
      updated.initialization.completedAt ??= timestamp
      updated.status = analysisRunStatus(updated)
      delete updated.lease
      delete updated.nextAttemptAt
      delete updated.error
    }
    parseAnalysisEntity(updated)
    operations.push({ kind: 'replace', record: updated, etag: current.etag })
    try {
      await deps.store.transact(workspaceId, operations)
      chunks++
    } catch (error) {
      const latest = await loadAnalysisRun(deps.store, workspaceId, runId)
      assertAnalysis(latest, 'Run disappeared during initialization.')
      const committed = analysisHash(latest.record) === analysisHash(updated) ||
        (latest.record.initialization.nextComparisonIndex > run.initialization.nextComparisonIndex &&
          latest.record.manifest.sha256 === run.manifest.sha256) ||
        (cancelling && (latest.record.cancellation?.nextComparisonIndex ?? -1) > start)
      if (!committed && !(error instanceof StoreConflictError)) throw error
      if (++races > 8) throw new StoreConflictError('Analysis initialization changed too often; retry later.')
      current = latest
      if (committed) chunks++
      continue
    }
    current = await loadAnalysisRun(deps.store, workspaceId, runId)
    assertAnalysis(current, 'Published run could not be read.')
  }
  return current
}
