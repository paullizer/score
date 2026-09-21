import { randomUUID } from 'node:crypto'
import {
  ANALYSIS_CORRECTION_POLICY_VERSION, type AnalysisCorrectionHistoryEntry, type AnalysisCorrectionHistoryReference,
  type AnalysisCorrectionProposal, type RealAnalysisCorrectionRecord,
} from '../../src/domain/analysis-corrections'
import {
  ANALYSIS_LIMITS, type AnalysisProcessingError, type RealAnalysisAssessmentInput, type RealAnalysisComparisonRecord,
  type RealAnalysisGroundingReview, type RealAnalysisResult, type RealAnalysisRunRecord, type VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import type { ImmutableJsonBlobReference } from '../../src/domain/real-resumes'
import { StoreConflictError } from '../../server/store'
import {
  analysisCorrectionCanWork, loadAnalysisCorrection, projectAnalysisComparison, publishAnalysisCorrection, readAnalysisCorrectionProposal,
} from '../../server/analyses/corrections'
import { assertEvidenceCorrectionAssessment, parseAnalysisCorrectionHistoryEntry } from '../../server/analyses/correction-validation'
import { analysisAssessmentHash } from '../../server/analyses/deterministic'
import { fencedAnalysisBlobs } from '../../server/analyses/guards'
import { loadAnalysisComparison, loadAnalysisRun } from '../../server/analyses/lifecycle'
import {
  analysisBlobReference, parseAnalysisJson, putAnalysisJson, readAnalysisBlob, readAnalysisResult, readAnalysisSnapshots,
  type AnalysisSnapshots,
} from '../../server/analyses/snapshots'
import type { AnalysisBlobStore, AnalysisStore } from '../../server/analyses/store'
import {
  analysisCorrectionHistoryBlobName, analysisHash, analysisResultBlobName, assertAnalysis, assertAnalysisResultBinding,
  citationMatchesDocument, parseAnalysisEntity, parseAnalysisResult, validateAnalysisAssessment,
} from '../../server/analyses/validation'
import { systemClock, type Clock } from '../runtime'
import { operationSettings, retryBackoff, RuntimeSettingsError, safeSettingsMetadata } from '../settings'
import { AnalysisModelError, reviewAnalysisAssessment } from './model'
import type { AnalysisWorkerDependencies } from './runtime'
import { emitAnalysisTelemetry } from './telemetry'

const LEASE_MS = 90_000
const HEARTBEAT_MS = 25_000
const RUN_BUDGET_MS = 660_000
const FAILURE_BUDGET_MS = 10_000
const FENCE_ATTEMPTS = 8
type Correction = VersionedAnalysisEntity<RealAnalysisCorrectionRecord>
type Run = VersionedAnalysisEntity<RealAnalysisRunRecord>
type Comparison = VersionedAnalysisEntity<RealAnalysisComparisonRecord>
type Stage = AnalysisProcessingError['stage']

class LostCorrectionWork extends Error {
  constructor() { super('This result correction request or attempt is no longer owned by the worker.') }
}
class CorrectionWorkFailure extends Error {
  constructor(readonly failure: AnalysisProcessingError) { super(failure.message) }
}
function isConflict(error: unknown): boolean {
  return error instanceof StoreConflictError || error instanceof Error && error.name === 'StoreConflictError'
}
async function workspaceActive(store: AnalysisStore, workspaceId: string): Promise<boolean> {
  return ((await store.getControl(workspaceId))?.record.state ?? 'active') === 'active'
}
function timestamp(clock: Clock, ...records: { updatedAt: string }[]): string {
  return new Date(Math.max(clock.now().getTime(), ...records.map(record => Date.parse(record.updatedAt)))).toISOString()
}
function due(record: RealAnalysisCorrectionRecord, now: string): boolean {
  return (!record.nextAttemptAt || record.nextAttemptAt <= now) && (!record.lease || record.lease.expiresAt <= now)
}
function requestBinding(record: RealAnalysisCorrectionRecord): string {
  return analysisHash({
    id: record.id, workspaceId: record.workspaceId, runId: record.runId, comparisonId: record.comparisonId,
    requestId: record.requestId, requestFingerprint: record.requestFingerprint, proposal: record.proposal,
    manifestSha256: record.manifestSha256, originalResult: record.originalResult,
    baseResult: record.baseResult, baseAttemptId: record.baseAttemptId, baseRevision: record.baseRevision,
    resumeSnapshot: record.resumeSnapshot, targetSnapshot: record.targetSnapshot, policyVersion: record.policyVersion,
    criterionIds: record.criterionIds, requestedAt: record.requestedAt, requestedBy: record.requestedBy, reason: record.reason,
    processingSettings: record.processingSettings ?? null,
  })
}
function owns(record: RealAnalysisCorrectionRecord, claimed: RealAnalysisCorrectionRecord, now: string): boolean {
  return record.status === 'running' && requestBinding(record) === requestBinding(claimed) &&
    Boolean(record.attemptId && record.attemptId === claimed.attemptId) &&
    record.attempts === claimed.attempts && record.retryCount === claimed.retryCount &&
    record.lease?.owner === claimed.lease?.owner && Boolean(record.lease && record.lease.expiresAt > now)
}
function failureFor(error: unknown, stage: Stage, inputs = false): AnalysisProcessingError {
  if (error instanceof CorrectionWorkFailure) return error.failure
  if (error instanceof AnalysisModelError) return {
    code: error.code, stage: error.stage, retryable: error.retryable,
    message: 'The independent grounding review could not complete safely. The previous result was retained.',
  }
  if (error instanceof RuntimeSettingsError) return {
    code: error.code === 'model-context-limit' ? 'context-limit' : 'snapshot-invalid',
    stage, retryable: false, message: error.message,
  }
  if (error instanceof Error && (error.name === 'ZodError' || error.message.startsWith('Invalid analysis data:'))) return {
    code: inputs ? 'snapshot-invalid' : 'invalid-model-output', stage, retryable: false,
    message: inputs ? 'The correction proposal or its frozen inputs failed integrity validation. No replacement evidence or score was used.'
      : 'The corrected result failed publication validation. The previous result was retained.',
  }
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) return {
    code: 'internal-error', stage, retryable: false,
    message: 'The correction could not be safely completed. No result was substituted.',
  }
  return {
    code: 'storage-error', stage, retryable: true,
    message: 'The private correction stores could not complete this operation. Retry preserves the exact proposal and previous result.',
  }
}
function logFailure(record: RealAnalysisCorrectionRecord, failure: AnalysisProcessingError, history = false): void {
  console.error(history ? 'Analysis correction history could not be saved:' : 'Analysis correction could not be published:', {
    code: failure.code, stage: failure.stage, retryable: failure.retryable,
    workspaceId: record.workspaceId, runId: record.runId, comparisonId: record.comparisonId,
    requestId: record.requestId, attemptId: record.attemptId,
  })
}

class CorrectionDeadline {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly timer: NodeJS.Timeout
  private readonly onAbort: () => void
  constructor(private readonly clock: Clock, private readonly deadline: number, private readonly parent?: AbortSignal) {
    this.onAbort = () => this.abort(new CorrectionWorkFailure({
      code: 'timeout', stage: 'grounding', retryable: true,
      message: 'The correction processing window ended. A bounded retry uses the same proposal and frozen evidence.',
    }))
    this.timer = setTimeout(this.onAbort, Math.max(1, deadline - clock.now().getTime()))
    this.timer.unref()
    if (parent?.aborted) this.onAbort()
    else parent?.addEventListener('abort', this.onAbort, { once: true })
  }
  abort(error: unknown): void { if (!this.signal.aborted) this.controller.abort(error) }
  check(): void {
    if (this.clock.now().getTime() >= this.deadline) this.onAbort()
    this.signal.throwIfAborted()
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
    } finally { if (onAbort) this.signal.removeEventListener('abort', onAbort) }
  }
  stop(): void { clearTimeout(this.timer); this.parent?.removeEventListener('abort', this.onAbort) }
}

class CorrectionLease {
  readonly control: CorrectionDeadline
  private queue: Promise<unknown> = Promise.resolve()
  private readonly heartbeat: NodeJS.Timeout
  constructor(
    readonly claimed: Correction, private readonly deps: AnalysisWorkerDependencies, private readonly clock: Clock,
    deadline: number, signal?: AbortSignal,
  ) {
    this.control = new CorrectionDeadline(clock, deadline, signal)
    this.heartbeat = setInterval(() => {
      void this.atomic((record, now) => ({
        ...record, updatedAt: now,
        lease: { owner: claimed.record.lease!.owner, heartbeatAt: now, expiresAt: new Date(Date.parse(now) + LEASE_MS).toISOString() },
      })).catch(error => this.control.abort(error instanceof LostCorrectionWork ? error : new CorrectionWorkFailure({
        code: 'storage-error', stage: 'publication', retryable: true,
        message: 'The correction lease could not be renewed. No late result was published.',
      })))
    }, HEARTBEAT_MS)
    this.heartbeat.unref()
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation)
    this.queue = pending.catch(() => undefined)
    return pending
  }
  private async current(allowAborted = false): Promise<{ run: Run; correction: Correction; original: Comparison }> {
    if (!allowAborted) this.control.check()
    const record = this.claimed.record
    const [run, correction, original] = await Promise.all([
      loadAnalysisRun(this.deps.store, record.workspaceId, record.runId),
      loadAnalysisCorrection(this.deps.store, record.workspaceId, record.runId, record.comparisonId),
      loadAnalysisComparison(this.deps.store, record.workspaceId, record.runId, record.comparisonId),
    ])
    if (!run || !correction || !original || original.record.status !== 'complete' || !analysisCorrectionCanWork(run.record, correction.record) ||
      !owns(correction.record, record, this.clock.now().toISOString()) ||
      !await workspaceActive(this.deps.store, record.workspaceId)) throw new LostCorrectionWork()
    if (!allowAborted) this.control.check()
    return { run, correction, original }
  }
  check(allowAborted = false): Promise<{ run: Run; correction: Correction; original: Comparison }> {
    return this.exclusive(() => this.current(allowAborted))
  }
  async atomic(
    change: (record: RealAnalysisCorrectionRecord, now: string) => RealAnalysisCorrectionRecord,
    allowAborted = false, cleanup?: CorrectionDeadline,
  ): Promise<void> {
    return this.exclusive(async () => {
      for (let race = 0; race < FENCE_ATTEMPTS; race++) {
        cleanup?.check()
        const { run, correction } = await this.current(allowAborted)
        const now = timestamp(this.clock, run.record, correction.record)
        const next = change(structuredClone(correction.record), now)
        const parent = { ...run.record, updatedAt: now }
        parseAnalysisEntity(next)
        parseAnalysisEntity(parent)
        cleanup?.check()
        if (!allowAborted) this.control.check()
        try {
          await this.deps.store.transact(next.workspaceId, [
            { kind: 'replace', record: next, etag: correction.etag },
            { kind: 'replace', record: parent, etag: run.etag },
          ])
          return
        } catch (error) {
          const latest = await loadAnalysisCorrection(this.deps.store, next.workspaceId, next.runId, next.comparisonId)
          if (latest && analysisHash(latest.record) === analysisHash(next)) return
          if (!isConflict(error)) throw error
        }
      }
      throw new StoreConflictError('Correction progress changed too often; this leased attempt remains recoverable.')
    })
  }
  async publish(result: RealAnalysisResult, reference: ImmutableJsonBlobReference, history: AnalysisCorrectionHistoryReference): Promise<void> {
    return this.exclusive(async () => {
      const { correction } = await this.current()
      const store = this.deps.store
      const guarded: AnalysisStore = {
        get: (workspaceId, id) => store.get(workspaceId, id),
        list: (workspaceId, options) => store.list(workspaceId, options),
        create: record => store.create(record),
        replace: (record, etag) => store.replace(record, etag),
        listPending: (now, limit) => store.listPending(now, limit),
        getControl: (workspaceId, runId) => store.getControl(workspaceId, runId),
        listControls: (workspaceId, token) => store.listControls(workspaceId, token),
        pendingLifecycleWorkspaces: limit => store.pendingLifecycleWorkspaces(limit),
        transact: async (workspaceId, operations, options) => {
          await this.current()
          this.control.check()
          return store.transact(workspaceId, operations, options)
        },
      }
      await publishAnalysisCorrection({ store: guarded, blobs: this.deps.blobs },
        correction.record, result, reference, history, this.clock.now(), this.control.signal)
    })
  }
  async stop(): Promise<void> { clearInterval(this.heartbeat); this.control.stop(); await this.queue }
}

async function claim(
  deps: AnalysisWorkerDependencies, candidate: Correction, clock: Clock, owner: string, deadline: number, signal?: AbortSignal,
): Promise<(Correction & { attemptLimitReached: boolean }) | undefined> {
  const attemptId = randomUUID()
  for (let race = 0; race < FENCE_ATTEMPTS; race++) {
    if (signal?.aborted || clock.now().getTime() >= deadline) return
    const [run, current, original] = await Promise.all([
      loadAnalysisRun(deps.store, candidate.record.workspaceId, candidate.record.runId),
      loadAnalysisCorrection(deps.store, candidate.record.workspaceId, candidate.record.runId, candidate.record.comparisonId),
      loadAnalysisComparison(deps.store, candidate.record.workspaceId, candidate.record.runId, candidate.record.comparisonId),
    ])
    if (!run || !current || !original || original.record.status !== 'complete' || !analysisCorrectionCanWork(run.record, current.record) ||
      requestBinding(current.record) !== requestBinding(candidate.record) || !['queued', 'running'].includes(current.record.status) ||
      !due(current.record, clock.now().toISOString()) || !await workspaceActive(deps.store, run.record.workspaceId)) return
    const snapshot = operationSettings(current.record, deps)
    const attemptLimitReached = current.record.attempts >= snapshot.settings.processing.analyses.maxAutomaticAttempts
    const now = timestamp(clock, run.record, current.record)
    const record: RealAnalysisCorrectionRecord = {
      ...structuredClone(current.record), status: 'running', attemptId, updatedAt: now,
      attempts: Math.min(current.record.attempts + 1, ANALYSIS_LIMITS.maxAutomaticAttempts),
      lease: { owner, heartbeatAt: now, expiresAt: new Date(Date.parse(now) + LEASE_MS).toISOString() },
      ...(current.record.processingSettings || deps.settings ? { processingSettings: snapshot } : {}),
    }
    delete record.error
    delete record.nextAttemptAt
    const parent = { ...run.record, updatedAt: now }
    parseAnalysisEntity(record)
    parseAnalysisEntity(parent)
    if (signal?.aborted || clock.now().getTime() >= deadline) return
    try {
      await deps.store.transact(record.workspaceId, [
        { kind: 'replace', record, etag: current.etag },
        { kind: 'replace', record: parent, etag: run.etag },
      ])
    } catch (error) {
      const latest = await loadAnalysisCorrection(deps.store, record.workspaceId, record.runId, record.comparisonId)
      if (latest && owns(latest.record, record, clock.now().toISOString())) return { ...latest, attemptLimitReached }
      if (!isConflict(error)) throw error
      continue
    }
    const latest = await loadAnalysisCorrection(deps.store, record.workspaceId, record.runId, record.comparisonId)
    if (latest && owns(latest.record, record, clock.now().toISOString())) return { ...latest, attemptLimitReached }
    return
  }
}

function inputBlobs(blobs: AnalysisBlobStore): Pick<AnalysisBlobStore, 'read'> {
  return {
    async read(name) {
      const blob = await blobs.read(name)
      if (!blob) throw new CorrectionWorkFailure({
        code: 'snapshot-unavailable', stage: 'grounding', retryable: true,
        message: 'An exact saved correction input is temporarily unavailable. No live source or substitute result was used.',
      })
      return blob
    },
  }
}

function assertProposal(
  proposal: AnalysisCorrectionProposal, record: RealAnalysisCorrectionRecord, run: RealAnalysisRunRecord,
  original: RealAnalysisComparisonRecord, base: RealAnalysisResult, snapshots: AnalysisSnapshots,
): void {
  assertAnalysis(original.status === 'complete' && !original.resultRevision &&
    analysisHash(original.result) === analysisHash(record.originalResult) &&
    record.manifestSha256 === run.manifest.sha256 &&
    record.resumeSnapshot.snapshotId === original.resume.snapshotId && record.resumeSnapshot.sha256 === original.resume.blob.sha256 &&
    record.targetSnapshot.snapshotId === original.target.snapshotId && record.targetSnapshot.sha256 === original.target.blob.sha256,
  'Correction does not bind the original comparison and frozen manifest.')
  const provenance = proposal.provenance
  assertAnalysis(provenance.policyVersion === ANALYSIS_CORRECTION_POLICY_VERSION &&
    provenance.requestId === record.requestId && provenance.originalResultSha256 === original.result!.sha256 &&
    provenance.baseResultSha256 === record.baseResult.sha256 && provenance.baseAssessmentSha256 === base.provenance.assessmentSha256 &&
    provenance.requestedAt === record.requestedAt && provenance.requestedBy === record.requestedBy && provenance.reason === record.reason &&
    analysisHash(provenance.criterionIds) === analysisHash(record.criterionIds),
  'Correction provenance does not bind the exact approved base assessment and selection.')
  assertEvidenceCorrectionAssessment(proposal, base, snapshots.targetSnapshot)
  assertAnalysis(validateAnalysisAssessment(proposal.assessment, snapshots.resumeSnapshot.document, snapshots.targetSnapshot).length === 0,
    'The correction assessment does not match its exact frozen evidence.')
}

function assertReview(review: RealAnalysisGroundingReview, proposal: AnalysisCorrectionProposal, snapshots: AnalysisSnapshots): void {
  assertAnalysis(review.assessmentSha256 === analysisAssessmentHash(proposal.assessment) &&
    review.resumeSnapshotSha256 === proposal.resumeSnapshot.sha256 && review.targetSnapshotSha256 === proposal.targetSnapshot.sha256 &&
    (review.outcome === 'supported' ? review.issues.length === 0 : review.issues.length > 0),
  'The independent correction review does not bind this exact proposal.')
  for (const issue of review.issues) assertAnalysis(!(issue.criterionId && issue.qualificationId) &&
    (!issue.criterionId || proposal.assessment.criteria.some(row => row.criterionId === issue.criterionId)) &&
    (!issue.qualificationId || proposal.assessment.qualifications.some(row => row.qualificationId === issue.qualificationId)) &&
    issue.citations.every(citation => citationMatchesDocument(citation, snapshots.resumeSnapshot.document)),
  'The independent correction review cites foreign evidence or requirements.')
}

async function saveJson(
  deps: AnalysisWorkerDependencies, lease: CorrectionLease, control: CorrectionDeadline, name: string, value: unknown, allowAborted = false,
): Promise<ImmutableJsonBlobReference> {
  const record = lease.claimed.record
  const blobs = fencedAnalysisBlobs(deps, record.workspaceId, record.runId, control.signal, () => lease.check(allowAborted))
  let reference: ImmutableJsonBlobReference
  try { reference = await control.wait(() => putAnalysisJson(blobs, name, value)) } catch (error) {
    await lease.check(allowAborted)
    const winner = await control.wait(() => deps.blobs.read(name))
    if (!winner || analysisHash(parseAnalysisJson(winner)) !== analysisHash(value)) throw error
    reference = analysisBlobReference(name, winner)
  }
  const saved = parseAnalysisJson(await control.wait(() => readAnalysisBlob(deps.blobs, reference, record.workspaceId, record.runId)))
  assertAnalysis(analysisHash(saved) === analysisHash(value), 'An immutable correction artifact contains different attempt content.')
  await lease.check(allowAborted)
  return reference
}

async function saveHistory(
  deps: AnalysisWorkerDependencies, lease: CorrectionLease, clock: Clock, control: CorrectionDeadline,
  details: Pick<AnalysisCorrectionHistoryEntry, 'outcome' | 'review' | 'error' | 'result'>,
  allowAborted = false,
): Promise<AnalysisCorrectionHistoryReference> {
  const { run, correction } = await lease.check(allowAborted)
  const record = correction.record
  const entry = parseAnalysisCorrectionHistoryEntry({
    ...details, schemaVersion: 1, dataKind: 'real', id: randomUUID(),
    workspaceId: record.workspaceId, runId: record.runId, comparisonId: record.comparisonId,
    createdAt: timestamp(clock, run.record, record), requestId: record.requestId, attemptId: record.attemptId!,
    proposal: record.proposal, ...(record.history ? { previous: record.history } : {}),
  } satisfies AnalysisCorrectionHistoryEntry)
  const name = analysisCorrectionHistoryBlobName(record.workspaceId, record.runId, record.comparisonId, record.requestId, entry.id)
  const blob = await saveJson(deps, lease, control, name, entry, allowAborted)
  return { id: entry.id, createdAt: entry.createdAt, blob }
}

export async function processClaimedCorrection(
  claimed: Correction, deps: AnalysisWorkerDependencies,
  options: { deadline?: number; signal?: AbortSignal; attemptLimitReached?: boolean } = {},
): Promise<boolean> {
  if (deps.correctionsEnabled !== true || deps.owner && deps.owner !== claimed.record.lease?.owner) return false
  const pinned = claimed.record.processingSettings ?? deps.settings?.legacy
  const snapshot = operationSettings({ processingSettings: pinned }, deps)
  deps = { ...deps, model: { ...deps.model, ...(pinned ? { processingSettings: snapshot } : {}) } }
  if (pinned) console.info('Score operation settings:', safeSettingsMetadata(snapshot, 'assessmentReview'))
  const maxAttempts = snapshot.settings.processing.analyses.maxAutomaticAttempts
  const clock = deps.clock ?? systemClock
  const lease = new CorrectionLease(claimed, deps, clock, options.deadline ?? clock.now().getTime() + RUN_BUDGET_MS, options.signal)
  let stage: Stage = 'grounding'
  let inputs = true
  let review: RealAnalysisGroundingReview | undefined
  let reference: ImmutableJsonBlobReference | undefined
  try {
    const { run, correction, original } = await lease.check()
    if (options.attemptLimitReached) throw new CorrectionWorkFailure({
      code: 'timeout', stage, retryable: true,
      message: `Correction review stopped after ${maxAttempts} attempts. A manual retry preserves the same saved evidence.`,
    })
    const reader = inputBlobs(deps.blobs)
    const snapshots = await lease.control.wait(() => readAnalysisSnapshots(reader, run.record, original.record))
    const proposal = await lease.control.wait(() => readAnalysisCorrectionProposal(reader, run.record, correction.record))
    const effective = projectAnalysisComparison(original.record, correction.record)
    assertAnalysis(analysisHash(effective.result) === analysisHash(proposal.baseResult) &&
      effective.attemptId === proposal.baseAttemptId &&
      analysisHash(effective.resultRevision ?? null) === analysisHash(proposal.baseRevision ?? null),
    'The current comparison result no longer matches the exact correction base.')
    const base = await lease.control.wait(() => readAnalysisResult(reader, run.record, effective, snapshots))
    assertAnalysis(base, 'The exact base result is required for correction review.')
    assertProposal(proposal, correction.record, run.record, original.record, base, snapshots)
    const target = snapshots.targetSnapshot
    const input: RealAnalysisAssessmentInput = {
      resume: snapshots.resumeSnapshot.document, rubric: target.kind === 'job' ? target.rubric : target.version.rubric,
      qualifications: target.kind === 'grade' ? target.version.qualifications : [], requirementEvidence: target.requirementEvidence,
    }
    inputs = false
    await lease.check()
    const reviewed = await lease.control.wait(() => reviewAnalysisAssessment(input, proposal.assessment, {
      model: deps.model, clock, signal: lease.control.signal,
      resumeSnapshotSha256: correction.record.resumeSnapshot.sha256, targetSnapshotSha256: correction.record.targetSnapshot.sha256,
      onEvent: event => emitAnalysisTelemetry(deps.onEvent, {
        ...event, workspaceId: correction.record.workspaceId, runId: correction.record.runId,
        comparisonId: correction.record.comparisonId, attemptId: correction.record.attemptId,
      }),
    }))
    assertReview(reviewed.review, proposal, snapshots)
    assertAnalysis(reviewed.assessmentSha256 === analysisAssessmentHash(proposal.assessment),
      'Independent review changed the immutable correction proposal.')
    review = reviewed.review
    if (review.outcome !== 'supported') throw new CorrectionWorkFailure({
      code: 'grounding-failed', stage: 'grounding', retryable: false,
      message: 'The independent review did not support this exact correction. The previous result was not changed.',
    })
    stage = 'publication'
    const current = await lease.check()
    const result = parseAnalysisResult({
      ...proposal.assessment, ...proposal.summary, schemaVersion: 1, dataKind: 'real',
      workspaceId: run.record.workspaceId, runId: run.record.id, comparisonId: original.record.id,
      createdAt: timestamp(clock, current.run.record, current.correction.record), humanReviewRequired: true,
      provenance: {
        attemptId: correction.record.attemptId!, manifestSha256: run.record.manifest.sha256,
        resumeSnapshot: correction.record.resumeSnapshot, targetSnapshot: correction.record.targetSnapshot,
        assessment: base.provenance.assessment, assessmentSha256: reviewed.assessmentSha256, groundingReviews: [review],
        correctionCount: reviewed.correctionCount, calculationVersion: 'weighted-0-100-v1', correction: proposal.provenance,
      },
    } satisfies RealAnalysisResult)
    const proposed: RealAnalysisComparisonRecord = {
      ...original.record, attemptId: correction.record.attemptId, updatedAt: result.createdAt, completedAt: result.createdAt,
      resultSummary: proposal.summary, resultRevision: {
        id: correction.record.requestId, policyVersion: correction.record.policyVersion,
        originalResultSha256: correction.record.originalResult.sha256, baseResultSha256: correction.record.baseResult.sha256,
        correctedAt: result.createdAt, criterionIds: correction.record.criterionIds,
      },
    }
    assertAnalysisResultBinding(result, current.run.record, proposed, snapshots.resumeSnapshot, target)
    const name = analysisResultBlobName(run.record.workspaceId, run.record.id, original.record.id, correction.record.attemptId!)
    reference = await saveJson(deps, lease, lease.control, name, result)
    await lease.control.wait(() => readAnalysisResult(reader, current.run.record, { ...proposed, result: reference }, snapshots))
    const history = await saveHistory(deps, lease, clock, lease.control, { outcome: 'ready', review, result: reference })
    await lease.publish(result, reference, history)
    return true
  } catch (caught) {
    const error = lease.control.signal.aborted ? lease.control.signal.reason : caught
    const latest = await loadAnalysisCorrection(deps.store, claimed.record.workspaceId, claimed.record.runId, claimed.record.comparisonId)
    if (reference && latest?.record.published && latest.record.published.attemptId === claimed.record.attemptId &&
      analysisHash(latest.record.published.result) === analysisHash(reference)) return true
    if (error instanceof LostCorrectionWork) return false
    let failure = failureFor(error, stage, inputs)
    let history: AnalysisCorrectionHistoryReference | undefined
    const cleanup = new CorrectionDeadline(clock, clock.now().getTime() + FAILURE_BUDGET_MS)
    try {
      await cleanup.wait(() => lease.check(true))
      try {
        history = await saveHistory(deps, lease, clock, cleanup, {
          outcome: 'failed', error: failure, ...(review ? { review } : {}),
        }, true)
      } catch (historyError) {
        if (historyError instanceof LostCorrectionWork) return false
        const captureFailure = failureFor(historyError, 'publication')
        logFailure(claimed.record, captureFailure, true)
        if (failure.code !== 'grounding-failed') failure = captureFailure
      }
      await lease.atomic((record, now) => {
        const retry = failure.retryable && record.attempts < maxAttempts
        const next: RealAnalysisCorrectionRecord = {
          ...record, status: retry ? 'queued' : 'failed', updatedAt: now, error: failure,
          ...(history ? { history } : {}),
        }
        delete next.lease
        delete next.nextAttemptAt
        if (retry) next.nextAttemptAt = new Date(Date.parse(now) + retryBackoff(snapshot, 'analyses', record.attempts)).toISOString()
        return next
      }, true, cleanup)
      logFailure(claimed.record, failure)
    } catch (failure) {
      if (!(failure instanceof LostCorrectionWork)) throw failure
    } finally { cleanup.stop() }
    return false
  } finally { await lease.stop() }
}

/** Corrections publish a separate result revision; they never restart completed comparison scoring. */
export async function runAnalysisCorrectionWork(
  deps: AnalysisWorkerDependencies, candidate: Correction, options: { deadline: number; signal?: AbortSignal },
): Promise<boolean> {
  if (deps.correctionsEnabled !== true) return false
  const clock = deps.clock ?? systemClock
  const claimed = await claim(deps, candidate, clock, deps.owner ?? `analysis-correction-worker-${randomUUID()}`, options.deadline, options.signal)
  if (!claimed) return false
  await processClaimedCorrection(claimed, deps, { ...options, attemptLimitReached: claimed.attemptLimitReached })
  return true
}
