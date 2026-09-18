import { randomUUID } from 'node:crypto'
import {
  ANALYSIS_LIMITS, analysisRunCanScore as canScore, type AnalysisProcessingError, type AnalysisProcessingErrorCode,
  type RealAnalysisComparisonRecord, type RealAnalysisResult, type RealAnalysisResultSummary,
  type RealAnalysisRunRecord, type VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import type { ImmutableJsonBlobReference } from '../../src/domain/real-resumes'
import { StoreConflictError } from '../../server/store'
import {
  advanceAnalysisRun, applyAnalysisComparisonTransition, loadAnalysisComparison, loadAnalysisRun,
} from '../../server/analyses/lifecycle'
import {
  analysisBlobReference, parseAnalysisJson, putAnalysisJson, readAnalysisBlob,
  readAnalysisResult, readAnalysisSnapshots, type AnalysisSnapshots,
} from '../../server/analyses/snapshots'
import {
  analysisHash, analysisResultBlobName, assertAnalysisResultBinding, parseAnalysisEntity, parseAnalysisResult,
} from '../../server/analyses/validation'
import type { AnalysisBlobStore, AnalysisStore } from '../../server/analyses/store'
import { systemClock, type Clock, type RubricModelOptions } from '../runtime'
import { AnalysisModelError, assessResumeAgainstTarget } from './model'
import { emitAnalysisTelemetry, type AnalysisTelemetrySink } from './telemetry'

const LEASE_MS = 90_000
const HEARTBEAT_MS = 25_000
const BACKOFF_MS = 30_000
const RUN_BUDGET_MS = 660_000
const FENCE_ATTEMPTS = 8

export interface AnalysisWorkerDependencies {
  store: AnalysisStore
  blobs: AnalysisBlobStore
  model: RubricModelOptions
  clock?: Clock
  owner?: string
  onEvent?: AnalysisTelemetrySink
}

export interface AnalysisWorkerOptions {
  maxItems?: number
  budgetMilliseconds?: number
  pendingLimit?: number
  signal?: AbortSignal
}

type Run = VersionedAnalysisEntity<RealAnalysisRunRecord>
type Comparison = VersionedAnalysisEntity<RealAnalysisComparisonRecord>
type Claimed<T> = T & { attemptLimitReached: boolean }
type Stage = AnalysisProcessingError['stage']

class LostAnalysisWork extends Error {
  constructor() { super('The analysis attempt is no longer owned by this worker.') }
}

class AnalysisWorkFailure extends Error {
  readonly failure: AnalysisProcessingError
  constructor(code: AnalysisProcessingErrorCode, stage: Stage, message: string, retryable: boolean) {
    super(message)
    this.failure = { code, stage, message, retryable }
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof StoreConflictError || error instanceof Error && error.name === 'StoreConflictError'
}

function isInvalidData(error: unknown): boolean {
  return error instanceof Error && (error.name === 'ZodError' || error.message.startsWith('Invalid analysis data:'))
}

function failureFor(error: unknown, stage: Stage, snapshots = false): AnalysisProcessingError {
  if (error instanceof AnalysisWorkFailure) return error.failure
  if (error instanceof AnalysisModelError) {
    return { code: error.code, stage: error.stage, message: error.message, retryable: error.retryable }
  }
  if (isInvalidData(error)) {
    return {
      code: snapshots ? 'snapshot-invalid' : 'invalid-model-output', stage, retryable: false,
      message: snapshots
        ? 'The frozen analysis inputs failed integrity validation. No replacement source or score was used.'
        : 'The analysis result failed publication validation. No score was published.',
    }
  }
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
    return { code: 'internal-error', stage, retryable: false, message: 'Analysis processing could not be safely completed. No result was substituted.' }
  }
  return {
    code: 'storage-error', stage, retryable: true,
    message: 'The private analysis stores could not complete this operation. Retry uses the same frozen inputs.',
  }
}

function inputBlobs(blobs: AnalysisBlobStore, stage: Stage): AnalysisBlobStore {
  return {
    async read(name) {
      const blob = await blobs.read(name)
      if (!blob) throw new AnalysisWorkFailure('snapshot-unavailable', stage,
        'A frozen analysis input is temporarily unavailable. No live source was substituted.', true)
      return blob
    },
    putImmutable: (name, bytes, contentType) => blobs.putImmutable(name, bytes, contentType),
  }
}

function due(record: RealAnalysisRunRecord | RealAnalysisComparisonRecord, timestamp: string): boolean {
  return (!record.nextAttemptAt || record.nextAttemptAt <= timestamp) &&
    (!record.lease || record.lease.expiresAt <= timestamp)
}

function runNeedsWork(run: RealAnalysisRunRecord): boolean {
  return run.status === 'initializing' || Boolean(run.cancellation && !run.cancellation.completedAt)
}

function timeAfter(clock: Clock, ...records: { updatedAt: string }[]): string {
  return new Date(Math.max(clock.now().getTime(), ...records.map(record => Date.parse(record.updatedAt)))).toISOString()
}

function liveLease(record: RealAnalysisRunRecord | RealAnalysisComparisonRecord, claimed: Run | Comparison, now: string): boolean {
  return Boolean(record.attemptId && record.attemptId === claimed.record.attemptId &&
    record.attempts === claimed.record.attempts && record.retryCount === claimed.record.retryCount &&
    record.lease?.owner === claimed.record.lease?.owner && record.lease && record.lease.expiresAt > now)
}

function retryAt(clock: Clock, attempts: number): string {
  return new Date(clock.now().getTime() + BACKOFF_MS * 2 ** Math.max(0, attempts - 1)).toISOString()
}

class WorkDeadline {
  private readonly controller = new AbortController()
  private readonly timer: NodeJS.Timeout
  private readonly onParentAbort: () => void
  readonly signal: AbortSignal

  constructor(private readonly clock: Clock, private readonly deadline: number, private readonly stage: Stage, private readonly parent?: AbortSignal) {
    this.signal = this.controller.signal
    this.onParentAbort = () => this.abort(this.timeout())
    this.timer = setTimeout(this.onParentAbort, Math.max(1, deadline - clock.now().getTime()))
    if (parent?.aborted) this.onParentAbort()
    else parent?.addEventListener('abort', this.onParentAbort, { once: true })
  }

  private timeout(): AnalysisWorkFailure {
    return new AnalysisWorkFailure('timeout', this.stage, 'The worker processing window ended. The comparison can resume from its frozen inputs.', true)
  }

  abort(reason: unknown): void { if (!this.signal.aborted) this.controller.abort(reason) }

  check(): void {
    if (this.clock.now().getTime() >= this.deadline) this.abort(this.timeout())
    if (this.signal.aborted) throw this.signal.reason
  }

  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.check()
    let onAbort: (() => void) | undefined
    try {
      return await new Promise<T>((resolve, reject) => {
        onAbort = () => reject(this.signal.reason)
        this.signal.addEventListener('abort', onAbort, { once: true })
        if (this.signal.aborted) { onAbort(); return }
        Promise.resolve().then(() => { this.check(); return operation() }).then(resolve, reject)
      })
    } finally {
      if (onAbort) this.signal.removeEventListener('abort', onAbort)
    }
  }

  stop(): void {
    clearTimeout(this.timer)
    this.parent?.removeEventListener('abort', this.onParentAbort)
  }
}

class ComparisonLease {
  readonly control: WorkDeadline
  private queue: Promise<unknown> = Promise.resolve()
  private readonly heartbeat: NodeJS.Timeout

  constructor(readonly claimed: Comparison, private readonly store: AnalysisStore, private readonly clock: Clock, deadline: number, signal?: AbortSignal) {
    this.control = new WorkDeadline(clock, deadline, 'assessment', signal)
    this.heartbeat = setInterval(() => {
      void this.atomic((record, timestamp) => ({
        ...record, updatedAt: timestamp,
        lease: { owner: claimed.record.lease!.owner, heartbeatAt: timestamp, expiresAt: new Date(Date.parse(timestamp) + LEASE_MS).toISOString() },
      })).catch(error => this.control.abort(error instanceof LostAnalysisWork ? error :
        new AnalysisWorkFailure('storage-error', 'assessment', 'The analysis lease could not be renewed. No late result was published.', true)))
    }, HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async current(allowAborted = false): Promise<{ run: Run; comparison: Comparison }> {
    if (!allowAborted) this.control.check()
    const record = this.claimed.record
    const [run, comparison] = await Promise.all([
      loadAnalysisRun(this.store, record.workspaceId, record.runId),
      loadAnalysisComparison(this.store, record.workspaceId, record.runId, record.id),
    ])
    if (!run || !comparison || !canScore(run.record) || comparison.record.status !== 'running' ||
      !liveLease(comparison.record, this.claimed, this.clock.now().toISOString())) throw new LostAnalysisWork()
    if (!allowAborted) this.control.check()
    return { run, comparison }
  }

  check(): Promise<{ run: Run; comparison: Comparison }> {
    return this.exclusive(() => this.current())
  }

  async atomic(
    change: (record: RealAnalysisComparisonRecord, timestamp: string, run: RealAnalysisRunRecord) => RealAnalysisComparisonRecord,
    allowAborted = false,
  ): Promise<void> {
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < FENCE_ATTEMPTS; attempt++) {
        const { run, comparison } = await this.current(allowAborted)
        const timestamp = timeAfter(this.clock, comparison.record, run.record)
        const next = change(structuredClone(comparison.record), timestamp, run.record)
        const parent = applyAnalysisComparisonTransition(run.record, comparison.record, next, timestamp)
        parseAnalysisEntity(next)
        parseAnalysisEntity(parent)
        if (!allowAborted) this.control.check()
        try {
          await this.store.transact(next.workspaceId, [
            { kind: 'replace', record: next, etag: comparison.etag },
            { kind: 'replace', record: parent, etag: run.etag },
          ])
          return
        } catch (error) {
          // Another comparison may update the parent without invalidating this attempt.
          const latest = await loadAnalysisComparison(this.store, next.workspaceId, next.runId, next.id)
          if (latest && analysisHash(latest.record) === analysisHash(next)) return
          if (!isConflict(error)) throw error
        }
      }
      throw new AnalysisWorkFailure('storage-error', 'publication', 'Analysis progress changed too often to save this attempt. Retry uses the same frozen inputs.', true)
    })
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat)
    this.control.stop()
    await this.queue
  }
}

async function claimComparison(
  deps: AnalysisWorkerDependencies, candidate: Comparison, owner: string, clock: Clock, deadline: number, signal?: AbortSignal,
): Promise<Claimed<Comparison> | undefined> {
  const attemptId = randomUUID()
  for (let race = 0; race < FENCE_ATTEMPTS; race++) {
    const [run, current] = await Promise.all([
      loadAnalysisRun(deps.store, candidate.record.workspaceId, candidate.record.runId),
      loadAnalysisComparison(deps.store, candidate.record.workspaceId, candidate.record.runId, candidate.record.id),
    ])
    const now = clock.now().toISOString()
    if (signal?.aborted || clock.now().getTime() >= deadline) return
    if (!run || !current || !canScore(run.record) || !['queued', 'running'].includes(current.record.status) || !due(current.record, now)) return
    const attemptLimitReached = current.record.attempts >= ANALYSIS_LIMITS.maxAutomaticAttempts
    const timestamp = timeAfter(clock, run.record, current.record)
    const record: RealAnalysisComparisonRecord = {
      ...structuredClone(current.record), status: 'running', attemptId,
      attempts: Math.min(ANALYSIS_LIMITS.maxAutomaticAttempts, current.record.attempts + 1), updatedAt: timestamp,
      lease: { owner, heartbeatAt: timestamp, expiresAt: new Date(Date.parse(timestamp) + LEASE_MS).toISOString() },
    }
    delete record.nextAttemptAt
    delete record.error
    const parent = applyAnalysisComparisonTransition(run.record, current.record, record, timestamp)
    parseAnalysisEntity(record)
    parseAnalysisEntity(parent)
    try {
      await deps.store.transact(record.workspaceId, [
        { kind: 'replace', record, etag: current.etag },
        { kind: 'replace', record: parent, etag: run.etag },
      ])
    } catch (error) {
      const latest = await loadAnalysisComparison(deps.store, record.workspaceId, record.runId, record.id)
      if (latest?.record.attemptId === attemptId && liveLease(latest.record, { record, etag: '' }, clock.now().toISOString())) {
        return { ...latest, attemptLimitReached }
      }
      if (isConflict(error)) continue
      throw error
    }
    const latest = await loadAnalysisComparison(deps.store, record.workspaceId, record.runId, record.id)
    if (latest?.record.status === 'running' && latest.record.attemptId === attemptId &&
      liveLease(latest.record, { record, etag: '' }, clock.now().toISOString())) return { ...latest, attemptLimitReached }
    return
  }
}

function resultSummary(result: RealAnalysisResult): RealAnalysisResultSummary {
  return { completion: result.completion, overall: result.overall, coverage: result.coverage }
}

function completedComparison(
  record: RealAnalysisComparisonRecord, reference: ImmutableJsonBlobReference, summary: RealAnalysisResultSummary, timestamp: string,
): RealAnalysisComparisonRecord {
  const next: RealAnalysisComparisonRecord = {
    ...record, status: 'complete', updatedAt: timestamp, completedAt: timestamp, result: reference, resultSummary: summary,
  }
  delete next.lease
  delete next.nextAttemptAt
  delete next.error
  delete next.cancelledAt
  return next
}

async function storeResult(
  deps: AnalysisWorkerDependencies, lease: ComparisonLease, snapshots: AnalysisSnapshots, result: RealAnalysisResult,
): Promise<{ reference: ImmutableJsonBlobReference; result: RealAnalysisResult }> {
  const { run, comparison } = await lease.check()
  const name = analysisResultBlobName(run.record.workspaceId, run.record.id, comparison.record.id, comparison.record.attemptId!)
  let reference: ImmutableJsonBlobReference
  try { reference = await lease.control.wait(() => putAnalysisJson(deps.blobs, name, result)) } catch (error) {
    lease.control.check()
    const winning = await lease.control.wait(() => deps.blobs.read(name))
    if (!winning) throw error
    reference = analysisBlobReference(name, winning)
  }
  const winning = parseAnalysisResult(parseAnalysisJson(await lease.control.wait(() =>
    readAnalysisBlob(deps.blobs, reference, run.record.workspaceId, run.record.id))))
  assertAnalysisResultBinding(winning, run.record, comparison.record, snapshots.resumeSnapshot, snapshots.targetSnapshot)
  const completed = completedComparison(comparison.record, reference, resultSummary(winning), winning.createdAt)
  await lease.control.wait(() => readAnalysisResult(deps.blobs, run.record, completed, snapshots))
  return { reference, result: winning }
}

export async function processClaimedComparison(
  claimed: Comparison, deps: AnalysisWorkerDependencies,
  options: { deadline?: number; signal?: AbortSignal; attemptLimitReached?: boolean } = {},
): Promise<boolean> {
  if (deps.owner && deps.owner !== claimed.record.lease?.owner) return false
  const clock = deps.clock ?? systemClock
  const lease = new ComparisonLease(claimed, deps.store, clock, options.deadline ?? clock.now().getTime() + RUN_BUDGET_MS, options.signal)
  const startedAt = clock.now().getTime()
  const context = {
    workspaceId: claimed.record.workspaceId, runId: claimed.record.runId,
    comparisonId: claimed.record.id, attemptId: claimed.record.attemptId,
  }
  let stage: Stage = 'assessment'
  let correctionCount = 0
  const onEvent: AnalysisTelemetrySink = event => {
    stage = event.stage
    correctionCount = event.correctionCount ?? correctionCount
    emitAnalysisTelemetry(deps.onEvent, { ...event, ...context })
  }
  const outcome = (status: 'complete' | 'failed' | 'queued' | 'abandoned', failure?: AnalysisProcessingError) => {
    const timestamp = clock.now().toISOString()
    emitAnalysisTelemetry(deps.onEvent, {
      ...context, event: 'comparison-outcome', timestamp, stage: failure?.stage ?? stage, outcome: status,
      correctionCount, code: failure?.code, retryable: failure?.retryable,
      durationMilliseconds: Math.max(0, Date.parse(timestamp) - startedAt),
    })
  }
  let readingInputs = true
  let published: ImmutableJsonBlobReference | undefined
  try {
    const { run, comparison } = await lease.check()
    if (options.attemptLimitReached) throw new AnalysisWorkFailure('timeout', stage,
      'Analysis stopped after three processing attempts. A manual retry preserves the original inputs.', true)
    const snapshots = await lease.control.wait(() => readAnalysisSnapshots(inputBlobs(deps.blobs, stage), run.record, comparison.record))
    readingInputs = false
    await lease.check()
    const target = snapshots.targetSnapshot
    const assessed = await assessResumeAgainstTarget({
      resume: snapshots.resumeSnapshot.document,
      rubric: target.kind === 'job' ? target.rubric : target.version.rubric,
      qualifications: target.kind === 'grade' ? target.version.qualifications : [],
      requirementEvidence: target.requirementEvidence,
    }, {
      model: deps.model, clock, signal: lease.control.signal, onEvent,
      resumeSnapshotSha256: comparison.record.resume.blob.sha256,
      targetSnapshotSha256: comparison.record.target.blob.sha256,
    })
    stage = 'publication'
    const current = await lease.check()
    const result = parseAnalysisResult({
      ...assessed.assessment, ...assessed.summary, schemaVersion: 1, dataKind: 'real',
      workspaceId: run.record.workspaceId, runId: run.record.id, comparisonId: comparison.record.id,
      createdAt: timeAfter(clock, current.run.record, current.comparison.record), humanReviewRequired: true,
      provenance: {
        attemptId: comparison.record.attemptId!, manifestSha256: run.record.manifest.sha256,
        resumeSnapshot: { snapshotId: comparison.record.resume.snapshotId, sha256: comparison.record.resume.blob.sha256 },
        targetSnapshot: { snapshotId: comparison.record.target.snapshotId, sha256: comparison.record.target.blob.sha256 },
        assessmentSha256: assessed.assessmentSha256, assessment: assessed.assessmentProvenance,
        groundingReviews: assessed.groundingReviews, correctionCount: assessed.correctionCount,
        calculationVersion: 'weighted-0-100-v1',
      },
    } satisfies RealAnalysisResult)
    assertAnalysisResultBinding(result, current.run.record, current.comparison.record, snapshots.resumeSnapshot, target)
    const saved = await storeResult(deps, lease, snapshots, result)
    correctionCount = saved.result.provenance.correctionCount
    published = saved.reference
    await lease.atomic((record, timestamp, liveRun) => {
      assertAnalysisResultBinding(saved.result, liveRun, record, snapshots.resumeSnapshot, target)
      return completedComparison(record, saved.reference, resultSummary(saved.result), timestamp)
    })
    outcome('complete')
    return true
  } catch (caught) {
    const error = lease.control.signal.aborted ? lease.control.signal.reason : caught
    const latest = await loadAnalysisComparison(deps.store, claimed.record.workspaceId, claimed.record.runId, claimed.record.id)
    if (published && latest?.record.status === 'complete' && latest.record.attemptId === claimed.record.attemptId &&
      analysisHash(latest.record.result) === analysisHash(published)) {
      outcome('complete')
      return true
    }
    if (error instanceof LostAnalysisWork) { outcome('abandoned'); return false }
    const failure = failureFor(error, stage, readingInputs)
    try {
      let status: 'queued' | 'failed' = 'failed'
      await lease.atomic((record, timestamp) => {
        const retry = failure.retryable && record.attempts < ANALYSIS_LIMITS.maxAutomaticAttempts
        status = retry ? 'queued' : 'failed'
        const next: RealAnalysisComparisonRecord = {
          ...record, status, updatedAt: timestamp, error: failure,
        }
        delete next.lease
        delete next.nextAttemptAt
        if (retry) next.nextAttemptAt = retryAt(clock, record.attempts)
        return next
      }, true)
      outcome(status, failure)
    } catch (failure) {
      if (!(failure instanceof LostAnalysisWork)) throw failure
      outcome('abandoned')
    }
    return false
  } finally {
    await lease.stop()
  }
}

async function claimRun(
  deps: AnalysisWorkerDependencies, candidate: Run, owner: string, clock: Clock, deadline: number, signal?: AbortSignal,
): Promise<Claimed<Run> | undefined> {
  const attemptId = randomUUID()
  for (let race = 0; race < FENCE_ATTEMPTS; race++) {
    const current = await loadAnalysisRun(deps.store, candidate.record.workspaceId, candidate.record.id)
    if (signal?.aborted || clock.now().getTime() >= deadline) return
    if (!current || !runNeedsWork(current.record) || !due(current.record, clock.now().toISOString())) return
    if (current.record.cancellation && current.record.error &&
      (!current.record.error.retryable || current.record.attempts >= ANALYSIS_LIMITS.maxAutomaticAttempts)) return
    // A new cancellation is a different work cycle from the completed initializer.
    const previousAttempts = current.record.cancellation && !current.record.lease && !current.record.error ? 0 : current.record.attempts
    const attemptLimitReached = previousAttempts >= ANALYSIS_LIMITS.maxAutomaticAttempts
    const timestamp = timeAfter(clock, current.record)
    const record: RealAnalysisRunRecord = {
      ...structuredClone(current.record), updatedAt: timestamp, attemptId,
      attempts: Math.min(ANALYSIS_LIMITS.maxAutomaticAttempts, previousAttempts + 1),
      lease: { owner, heartbeatAt: timestamp, expiresAt: new Date(Date.parse(timestamp) + LEASE_MS).toISOString() },
    }
    delete record.nextAttemptAt
    delete record.error
    parseAnalysisEntity(record)
    try { return { ...await deps.store.replace(record, current.etag), attemptLimitReached } } catch (error) {
      const latest = await loadAnalysisRun(deps.store, record.workspaceId, record.id)
      if (latest?.record.attemptId === attemptId && liveLease(latest.record, { record, etag: '' }, clock.now().toISOString())) {
        return { ...latest, attemptLimitReached }
      }
      if (!isConflict(error)) throw error
    }
  }
}

async function runChange(
  deps: AnalysisWorkerDependencies, claimed: Run, clock: Clock,
  change: (record: RealAnalysisRunRecord, timestamp: string) => RealAnalysisRunRecord,
): Promise<Run> {
  for (let race = 0; race < FENCE_ATTEMPTS; race++) {
    const current = await loadAnalysisRun(deps.store, claimed.record.workspaceId, claimed.record.id)
    if (!current || !runNeedsWork(current.record) || !liveLease(current.record, claimed, clock.now().toISOString())) throw new LostAnalysisWork()
    const record = change(structuredClone(current.record), timeAfter(clock, current.record))
    parseAnalysisEntity(record)
    try { return await deps.store.replace(record, current.etag) } catch (error) {
      const latest = await loadAnalysisRun(deps.store, record.workspaceId, record.id)
      if (latest && analysisHash(latest.record) === analysisHash(record)) return latest
      if (!isConflict(error)) throw error
    }
  }
  throw new AnalysisWorkFailure('storage-error', 'initialization', 'Analysis initialization changed too often to save this attempt.', true)
}

async function processRun(
  deps: AnalysisWorkerDependencies, claimed: Run, clock: Clock, deadline: number, signal?: AbortSignal, attemptLimitReached = false,
): Promise<void> {
  const control = new WorkDeadline(clock, deadline, 'initialization', signal)
  // The helper owns batching/progress. This adapter adds the worker's attempt/deadline fence,
  // including when the helper retries after a competing initializer or cancellation.
  const store: AnalysisStore = {
    get: (workspaceId, id) => deps.store.get(workspaceId, id),
    list: (workspaceId, options) => deps.store.list(workspaceId, options),
    create: record => deps.store.create(record),
    replace: (record, etag) => deps.store.replace(record, etag),
    listPending: (now, limit) => deps.store.listPending(now, limit),
    async transact(workspaceId, operations) {
      control.check()
      const current = await loadAnalysisRun(deps.store, claimed.record.workspaceId, claimed.record.id)
      const parent = operations.find(operation => operation.record.recordType === 'analysis-run')
      if (!current || !liveLease(current.record, claimed, clock.now().toISOString()) ||
        parent?.record.attemptId !== claimed.record.attemptId) throw new LostAnalysisWork()
      control.check()
      // Comparison transitions release an initialized parent's lease. A canceller still
      // owns subsequent chunks until the separate cancellation cursor reaches the end.
      const fenced = operations.map(operation => operation === parent && operation.record.recordType === 'analysis-run' &&
        runNeedsWork(operation.record) && !operation.record.lease
        ? { ...operation, record: { ...operation.record, lease: current.record.lease } } : operation)
      await deps.store.transact(workspaceId, fenced)
    },
  }
  try {
    if (attemptLimitReached) throw new AnalysisWorkFailure('timeout', 'initialization',
      'Analysis initialization stopped after three processing attempts. Retry preserves the accepted manifest.', true)
    for (let chunk = 0; chunk < ANALYSIS_LIMITS.maxComparisons; chunk++) {
      control.check()
      await control.wait(() => runChange(deps, claimed, clock, (record, timestamp) => {
        control.check()
        return {
          ...record, updatedAt: timestamp,
          lease: { owner: claimed.record.lease!.owner, heartbeatAt: timestamp, expiresAt: new Date(Date.parse(timestamp) + LEASE_MS).toISOString() },
        }
      }))
      const current = await control.wait(() => advanceAnalysisRun({ store, blobs: inputBlobs(deps.blobs, 'initialization') },
        claimed.record.workspaceId, claimed.record.id, {
          now: () => clock.now(), maxChunks: 1, leaseOwner: claimed.record.lease!.owner,
          expectedAttemptId: claimed.record.attemptId,
        }))
      if (!runNeedsWork(current.record)) return
      if (!liveLease(current.record, claimed, clock.now().toISOString())) throw new LostAnalysisWork()
    }
    throw new AnalysisWorkFailure('internal-error', 'initialization', 'The bounded initialization cursor could not finish. No comparisons were scored.', false)
  } catch (caught) {
    const error = control.signal.aborted ? control.signal.reason : caught
    if (error instanceof LostAnalysisWork) return
    const failure = failureFor(error, 'initialization', true)
    try {
      await runChange(deps, claimed, clock, (record, timestamp) => {
        const retry = failure.retryable && record.attempts < ANALYSIS_LIMITS.maxAutomaticAttempts
        const next = { ...record, updatedAt: timestamp, error: failure }
        delete next.lease
        delete next.nextAttemptAt
        if (retry) next.nextAttemptAt = retryAt(clock, record.attempts)
        else if (!record.cancellation) next.status = 'failed'
        return next
      })
    } catch (failure) {
      if (!(failure instanceof LostAnalysisWork)) throw failure
    }
  } finally {
    control.stop()
  }
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}.`)
  return value
}

/** completed counts immutable comparison results, not initialization or cancellation maintenance. */
export async function runAnalysisWorker(
  dependencies: AnalysisWorkerDependencies, options: AnalysisWorkerOptions = {},
): Promise<{ claimed: number; completed: number }> {
  const maxItems = boundedInteger(options.maxItems ?? 2, 1, 100, 'Analysis worker maxItems')
  const pendingLimit = boundedInteger(options.pendingLimit ?? 100, 1, 100, 'Analysis worker pendingLimit')
  const budget = boundedInteger(options.budgetMilliseconds ?? RUN_BUDGET_MS, 1, RUN_BUDGET_MS, 'Analysis worker budgetMilliseconds')
  const clock = dependencies.clock ?? systemClock
  const owner = dependencies.owner ?? `analysis-worker-${randomUUID()}`
  if (!owner.trim() || owner.length > 200) throw new Error('The analysis worker owner must be a bounded nonempty identifier.')
  const deps = { ...dependencies, clock, owner }
  const deadline = clock.now().getTime() + budget
  const result = { claimed: 0, completed: 0 }
  const visited = new Set<string>()
  while (result.claimed < maxItems && clock.now().getTime() < deadline && !options.signal?.aborted) {
    const pending = await deps.store.listPending(clock.now().toISOString(), pendingLimit)
    const candidates = pending.filter(item => !visited.has(`${item.record.workspaceId}:${item.record.id}`))
      .sort((a, b) => Number(b.record.recordType === 'analysis-run') - Number(a.record.recordType === 'analysis-run'))
    if (!candidates.length) break
    for (const candidate of candidates) {
      if (result.claimed >= maxItems || clock.now().getTime() >= deadline || options.signal?.aborted) break
      visited.add(`${candidate.record.workspaceId}:${candidate.record.id}`)
      try {
        const record = parseAnalysisEntity(candidate.record)
        if (record.recordType === 'analysis-run') {
          const claimed = await claimRun(deps, { record, etag: candidate.etag }, owner, clock, deadline, options.signal)
          if (!claimed) continue
          result.claimed++
          await processRun(deps, claimed, clock, deadline, options.signal, claimed.attemptLimitReached)
        } else {
          const claimed = await claimComparison(deps, { record, etag: candidate.etag }, owner, clock, deadline, options.signal)
          if (!claimed) continue
          result.claimed++
          if (await processClaimedComparison(claimed, deps, {
            deadline, signal: options.signal, attemptLimitReached: claimed.attemptLimitReached,
          })) result.completed++
        }
      } catch {
        // Store outages leave leased work recoverable; never log source text or SDK/model responses.
        console.error('Analysis work could not be advanced:', { code: 'analysis-work-storage-error' })
      }
    }
  }
  return result
}
