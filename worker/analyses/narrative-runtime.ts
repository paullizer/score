import { randomUUID } from 'node:crypto'
import {
  ANALYSIS_NARRATIVE_LIMITS, analysisNarrativeIsCurrent, analysisTargetNarrativeCanGenerate,
  type AnalysisCandidateNarrativeModelInput, type AnalysisNarrativeProcessingError, type AnalysisTargetNarrativeModelInput,
  type RealAnalysisNarrativeArtifact, type RealAnalysisNarrativeRecord, type RealAnalysisTargetNarrativeRecord,
} from '../../src/domain/analysis-narratives'
import { AnalysisNarrativeValidationError } from '../../src/domain/analysis-narrative-validation'
import {
  ANALYSIS_LIMITS, type RealAnalysisAssessmentInput, type RealAnalysisRunRecord, type VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import type { ImmutableJsonBlobReference } from '../../src/domain/real-resumes'
import { StoreConflictError } from '../../server/store'
import { HttpError } from '../../server/errors'
import { fencedAnalysisBlobs } from '../../server/analyses/guards'
import { loadAnalysisRun } from '../../server/analyses/lifecycle'
import {
  parseAnalysisNarrativeArtifact, readAnalysisNarrativePublication, validateAnalysisNarrativeArtifactInput,
} from '../../server/analyses/narrative-artifacts'
import {
  analysisNarrativeCanWork, narrativePublicationVersion, narrativeTimestamp, newCandidateNarrative, newTargetNarrative,
} from '../../server/analyses/narrative-records'
import {
  advanceAnalysisNarrativeRequest, loadAnalysisNarrative, readAnalysisNarrativeInventory, type AnalysisNarrativeInventory,
} from '../../server/analyses/narratives'
import {
  analysisBlobReference, createAnalysisSnapshotReader, parseAnalysisJson, putAnalysisJson, readAnalysisBlob,
} from '../../server/analyses/snapshots'
import type { AnalysisTransaction } from '../../server/analyses/store'
import {
  analysisHash, analysisNarrativeBlobName, analysisNarrativeId, assertAnalysis, MAX_ANALYSIS_TRANSACTION_BYTES, parseAnalysisEntity,
} from '../../server/analyses/validation'
import { systemClock, type Clock } from '../runtime'
import { generateCandidateNarrative, generateTargetNarrative, NarrativeModelError } from './narrative-model'
import type { AnalysisWorkerDependencies } from './runtime'

const LEASE_MS = 90_000
const HEARTBEAT_MS = 25_000
const BACKOFF_MS = 30_000
const RUN_BUDGET_MS = 660_000
const INPUT_BYTES = 128 * 1024 * 1024
type Narrative = VersionedAnalysisEntity<RealAnalysisNarrativeRecord>
type Run = VersionedAnalysisEntity<RealAnalysisRunRecord>
type Stage = AnalysisNarrativeProcessingError['stage']

export interface AnalysisNarrativeTelemetryEvent {
  event: 'narrative-outcome'
  workspaceId: string
  runId: string
  targetId: string
  comparisonId?: string
  generationId: string
  attemptId?: string
  stage: Stage
  outcome: 'ready' | 'failed' | 'queued' | 'abandoned'
  code?: AnalysisNarrativeProcessingError['code']
  retryable?: boolean
  durationMilliseconds: number
}

class LostNarrativeWork extends Error {
  constructor() { super('This narrative generation or attempt is no longer owned by the worker.') }
}
class NarrativeWorkFailure extends Error {
  constructor(readonly failure: AnalysisNarrativeProcessingError) { super(failure.message) }
}
function isConflict(error: unknown): boolean {
  return error instanceof StoreConflictError || error instanceof Error && error.name === 'StoreConflictError'
}
function due(record: RealAnalysisNarrativeRecord, now: string): boolean {
  return (!record.nextAttemptAt || record.nextAttemptAt <= now) && (!record.lease || record.lease.expiresAt <= now)
}
async function workspaceActive(deps: AnalysisWorkerDependencies, workspaceId: string): Promise<boolean> {
  return ((await deps.store.getControl(workspaceId))?.record.state ?? 'active') === 'active'
}
function failureFor(error: unknown, stage: Stage, inputs: boolean): AnalysisNarrativeProcessingError {
  if (error instanceof NarrativeWorkFailure) return error.failure
  if (error instanceof NarrativeModelError) return { code: error.code, stage: error.stage, message: error.message, retryable: error.retryable }
  if (error instanceof AnalysisNarrativeValidationError) return { code: error.code, stage, message: error.message, retryable: false }
  if (inputs && error instanceof HttpError && error.code === 'invalid_request') return {
    code: 'context-limit', stage, retryable: false,
    message: 'The complete saved evidence exceeds the bounded summary read budget. No comparisons or source evidence were omitted.',
  }
  if (error instanceof Error && (error.name === 'ZodError' || error.message.startsWith('Invalid analysis data:'))) {
    return {
      code: inputs ? 'snapshot-invalid' : 'invalid-model-output', stage, retryable: false,
      message: inputs ? 'The saved narrative inputs failed integrity validation. No live documents or replacement scores were used.'
        : 'The narrative failed publication validation. The previous published text and all scores were retained.',
    }
  }
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) return {
    code: 'internal-error', stage, retryable: false, message: 'The narrative could not be safely generated. The saved assessment was not changed.',
  }
  return {
    code: 'storage-error', stage, retryable: true,
    message: 'The private summary stores could not finish this operation. Retry preserves the saved assessment and previous narrative.',
  }
}

class NarrativeDeadline {
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly timer: NodeJS.Timeout
  private readonly onAbort: () => void
  constructor(private readonly clock: Clock, private readonly deadline: number, private readonly parent?: AbortSignal) {
    this.onAbort = () => this.abort(new NarrativeWorkFailure({
      code: 'timeout', stage: 'publication', retryable: true,
      message: 'The narrative processing window ended. A bounded retry uses the same saved evidence.',
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

function owns(record: RealAnalysisNarrativeRecord, claimed: RealAnalysisNarrativeRecord, now: string): boolean {
  return record.status === 'running' && record.generationId === claimed.generationId && record.attemptId === claimed.attemptId &&
    record.inputFingerprint === claimed.inputFingerprint && record.attempts === claimed.attempts && record.retryCount === claimed.retryCount &&
    record.lease?.owner === claimed.lease?.owner && Boolean(record.lease && record.lease.expiresAt > now)
}
class NarrativeLease {
  readonly control: NarrativeDeadline
  private queue: Promise<unknown> = Promise.resolve()
  private readonly heartbeat: NodeJS.Timeout
  constructor(
    readonly claimed: Narrative, private readonly deps: AnalysisWorkerDependencies, private readonly clock: Clock,
    deadline: number, signal?: AbortSignal,
  ) {
    this.control = new NarrativeDeadline(clock, deadline, signal)
    this.heartbeat = setInterval(() => {
      void this.atomic((record, timestamp) => ({
        ...record, updatedAt: timestamp,
        lease: { owner: claimed.record.lease!.owner, heartbeatAt: timestamp, expiresAt: new Date(Date.parse(timestamp) + LEASE_MS).toISOString() },
      })).catch(error => this.control.abort(error instanceof LostNarrativeWork ? error : new NarrativeWorkFailure({
        code: 'storage-error', stage: 'publication', retryable: true,
        message: 'The narrative lease could not be renewed. No late replacement was published.',
      })))
    }, HEARTBEAT_MS)
    this.heartbeat.unref()
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async current(allowAborted = false): Promise<{ run: Run; narrative: Narrative }> {
    if (!allowAborted) this.control.check()
    const claimed = this.claimed.record
    const [run, narrative] = await Promise.all([
      loadAnalysisRun(this.deps.store, claimed.workspaceId, claimed.runId),
      loadAnalysisNarrative(this.deps.store, claimed.workspaceId, claimed.id),
    ])
    if (!run || !narrative || run.record.narrativeRequestId || !analysisNarrativeCanWork(run.record, narrative.record) ||
      !owns(narrative.record, claimed, this.clock.now().toISOString()) || !await workspaceActive(this.deps, claimed.workspaceId)) {
      throw new LostNarrativeWork()
    }
    if (!allowAborted) this.control.check()
    return { run, narrative }
  }
  check(): Promise<{ run: Run; narrative: Narrative }> { return this.exclusive(() => this.current()) }
  async atomic(
    change: (record: RealAnalysisNarrativeRecord, timestamp: string) => RealAnalysisNarrativeRecord,
    allowAborted = false, fingerprint?: string,
  ): Promise<void> {
    return this.exclusive(async () => {
      for (let race = 0; race < 8; race++) {
        const { run, narrative } = await this.current(allowAborted)
        if (fingerprint) {
          const inventory = await readAnalysisNarrativeInventory(this.deps, run.record.workspaceId, run.record.id, narrative.record.targetId)
          if (inventory.run.etag !== run.etag) continue
          const comparisonId = narrative.record.recordType === 'analysis-candidate-narrative' ? narrative.record.comparisonId : undefined
          const binding = comparisonId ? inventory.comparisons.find(pair => pair.id === comparisonId)?.binding : inventory.targets[0]?.binding
          if (!binding || analysisHash(binding) !== fingerprint) throw new LostNarrativeWork()
        }
        const timestamp = narrativeTimestamp(run.record, this.clock.now().toISOString())
        const record = change(structuredClone(narrative.record), timestamp)
        parseAnalysisEntity(record)
        const parent = { ...run.record, updatedAt: timestamp }
        if (!allowAborted) this.control.check()
        try {
          await this.deps.store.transact(record.workspaceId, [
            { kind: 'replace', record, etag: narrative.etag }, { kind: 'replace', record: parent, etag: run.etag },
          ])
          return
        } catch (error) {
          const latest = await loadAnalysisNarrative(this.deps.store, record.workspaceId, record.id)
          if (latest && analysisHash(latest.record) === analysisHash(record)) return
          if (!isConflict(error)) throw error
        }
      }
      throw new StoreConflictError('Narrative publication changed too often; the leased attempt remains recoverable.')
    })
  }
  async stop(): Promise<void> { clearInterval(this.heartbeat); this.control.stop(); await this.queue }
}

function targetSource(snapshots: Awaited<ReturnType<ReturnType<typeof createAnalysisSnapshotReader>['snapshots']>>): Omit<RealAnalysisAssessmentInput, 'resume'> {
  const target = snapshots.targetSnapshot
  return {
    rubric: target.kind === 'job' ? target.rubric : target.version.rubric,
    qualifications: target.kind === 'grade' ? target.version.qualifications : [],
    requirementEvidence: target.requirementEvidence,
  }
}
function snapshotReader(deps: AnalysisWorkerDependencies, run: RealAnalysisRunRecord, maxComparisons: number, signal: AbortSignal) {
  return createAnalysisSnapshotReader({
    async read(name) {
      const blob = await deps.blobs.read(name)
      if (!blob) throw new NarrativeWorkFailure({
        code: 'snapshot-unavailable', stage: 'dependencies', retryable: true,
        message: 'A saved narrative input is temporarily unavailable. No live source or replacement score was substituted.',
      })
      return blob
    },
  }, run, { maxComparisons, maxBytes: INPUT_BYTES, signal })
}
async function candidateInput(
  deps: AnalysisWorkerDependencies, inventory: AnalysisNarrativeInventory, comparisonId: string, signal: AbortSignal,
): Promise<AnalysisCandidateNarrativeModelInput> {
  const pair = inventory.comparisons.find(item => item.id === comparisonId)
  assertAnalysis(pair?.comparison?.status === 'complete' && pair.binding, 'Candidate generation requires its exact completed result.')
  const reader = snapshotReader(deps, inventory.run.record, 1, signal)
  const snapshots = await reader.snapshots(pair.comparison)
  const result = await reader.result(pair.comparison, snapshots)
  assertAnalysis(result, 'Candidate generation has no saved result.')
  return {
    binding: pair.binding, inputFingerprint: analysisHash(pair.binding),
    source: { resume: snapshots.resumeSnapshot.document, ...targetSource(snapshots) }, result,
  }
}
async function targetInput(
  deps: AnalysisWorkerDependencies, inventory: AnalysisNarrativeInventory, signal: AbortSignal,
): Promise<AnalysisTargetNarrativeModelInput> {
  const selected = inventory.targets[0]
  assertAnalysis(inventory.targets.length === 1 && analysisTargetNarrativeCanGenerate(selected.binding, inventory.comparisons.map(pair => pair.id)),
    'Target generation requires every settled pair and current candidate narrative.')
  const reader = snapshotReader(deps, inventory.run.record, ANALYSIS_LIMITS.maxComparisons, signal)
  const candidates: AnalysisTargetNarrativeModelInput['candidates'] = []
  let target: AnalysisTargetNarrativeModelInput['target'] | undefined
  for (const pair of inventory.comparisons) {
    signal.throwIfAborted()
    if (pair.status !== 'complete') continue
    assertAnalysis(pair.comparison && pair.binding && pair.narrative?.published &&
      analysisNarrativeIsCurrent(pair.state, analysisHash(pair.binding)), 'A target prerequisite changed or is missing.')
    const snapshots = await reader.snapshots(pair.comparison)
    const result = await reader.result(pair.comparison, snapshots)
    const artifact = await readAnalysisNarrativePublication(deps.blobs, pair.narrative)
    assertAnalysis(result && artifact?.kind === 'candidate', 'A current candidate publication could not be read.')
    target ??= targetSource(snapshots)
    candidates.push({
      binding: pair.binding, result, narrative: {
        dataKind: 'real', ...narrativePublicationVersion(pair.narrative.published), text: artifact.text, overview: artifact.overview,
      },
    })
  }
  assertAnalysis(target && candidates.length > 0, 'A target with no completed comparisons does not require a model overview.')
  return { binding: selected.binding, inputFingerprint: analysisHash(selected.binding), target, candidates }
}

async function reconcileTarget(
  deps: AnalysisWorkerDependencies, candidate: Narrative, clock: Clock,
): Promise<{ worked: boolean; ready: boolean }> {
  const record = candidate.record
  if (record.recordType !== 'analysis-target-narrative') return { worked: false, ready: true }
  for (let race = 0; race < 8; race++) {
    const inventory = await readAnalysisNarrativeInventory(deps, record.workspaceId, record.runId, record.targetId)
    const current = await loadAnalysisNarrative(deps.store, record.workspaceId, record.id)
    if (!current || current.record.recordType !== 'analysis-target-narrative' || current.record.generationId !== record.generationId ||
      !['waiting', 'queued', 'running'].includes(current.record.status) || !due(current.record, clock.now().toISOString()) ||
      inventory.run.record.narrativeRequestId || !analysisNarrativeCanWork(inventory.run.record, current.record) ||
      !await workspaceActive(deps, record.workspaceId)) return { worked: false, ready: false }
    const target = inventory.targets[0]
    const fingerprint = analysisHash(target.binding)
    if (current.record.inputFingerprint === fingerprint && current.record.status !== 'waiting') return { worked: false, ready: true }
    const timestamp = narrativeTimestamp(inventory.run.record, clock.now().toISOString())
    const operations: AnalysisTransaction[] = []
    let next: RealAnalysisTargetNarrativeRecord = current.record.inputFingerprint
      ? newTargetNarrative(inventory.run.record, target.target, {
        requestId: randomUUID(), requestedAt: timestamp, requestedBy: null, reason: 'comparison-changed',
      }, current.record)
      : { ...current.record, updatedAt: timestamp }
    const pendingScoring = inventory.comparisons.some(pair => !pair.comparison || pair.status === 'queued' || pair.status === 'running')
    let bytes = Buffer.byteLength(JSON.stringify(next)) + Buffer.byteLength(JSON.stringify(inventory.run.record)) + 8192
    for (const pair of inventory.comparisons) {
      if (!pair.comparison || !pair.binding || !['missing', 'stale', 'cancelled'].includes(pair.state.status)) continue
      if (operations.length === ANALYSIS_LIMITS.initializationChunkSize - 1) break
      const previous = await loadAnalysisNarrative(deps.store, record.workspaceId, analysisNarrativeId('candidate', record.runId, pair.id))
      assertAnalysis(!previous || previous.record.recordType === 'analysis-candidate-narrative', 'Candidate prerequisite identity is invalid.')
      const child = newCandidateNarrative(inventory.run.record, pair.comparison, {
        requestId: next.requestId, requestedAt: timestamp, requestedBy: next.requestedBy, reason: next.reason,
      }, previous?.record.recordType === 'analysis-candidate-narrative' ? previous.record : undefined)
      const operation: AnalysisTransaction = previous ? { kind: 'replace', record: child, etag: previous.etag } : { kind: 'create', record: child }
      const size = Buffer.byteLength(JSON.stringify(operation))
      if (bytes + size > MAX_ANALYSIS_TRANSACTION_BYTES) break
      operations.push(operation)
      bytes += size
    }
    let ready = false
    if (!operations.length && !pendingScoring && inventory.comparisons.some(pair => pair.status === 'complete' && pair.state.status === 'failed')) {
      next = {
        ...next, status: 'failed', error: {
          code: 'dependency-failed', stage: 'dependencies', retryable: false,
          message: 'A completed candidate summary failed. Generate missing summaries to retry those summaries and this overview; scores are unchanged.',
        },
      }
      delete next.waitingFor
      delete next.nextAttemptAt
    } else if (!operations.length && !pendingScoring &&
      analysisTargetNarrativeCanGenerate(target.binding, inventory.comparisons.map(pair => pair.id))) {
      next = { ...next, status: 'queued', inputFingerprint: fingerprint, nextAttemptAt: timestamp }
      delete next.waitingFor
      delete next.error
      ready = true
    } else {
      next = {
        ...next, status: 'waiting', inputFingerprint: null, waitingFor: pendingScoring ? 'scoring' : 'candidate-narratives',
        nextAttemptAt: new Date(Date.parse(timestamp) + (operations.length ? 0 : BACKOFF_MS)).toISOString(),
      }
    }
    operations.push(
      { kind: 'replace', record: next, etag: current.etag },
      { kind: 'replace', record: { ...inventory.run.record, updatedAt: timestamp }, etag: inventory.run.etag },
    )
    try { await deps.store.transact(record.workspaceId, operations); return { worked: true, ready } } catch (error) {
      const latest = await loadAnalysisNarrative(deps.store, record.workspaceId, record.id)
      if (latest && analysisHash(latest.record) === analysisHash(next)) return { worked: true, ready }
      if (!isConflict(error)) throw error
    }
  }
  throw new StoreConflictError('The target prerequisites changed too often; the target remains durably scheduled.')
}

async function claim(
  deps: AnalysisWorkerDependencies, candidate: Narrative, clock: Clock, owner: string, deadline: number, signal?: AbortSignal,
): Promise<(Narrative & { attemptLimitReached: boolean }) | undefined> {
  const attemptId = randomUUID()
  for (let race = 0; race < 8; race++) {
    if (signal?.aborted || clock.now().getTime() >= deadline) return
    const [run, current] = await Promise.all([
      loadAnalysisRun(deps.store, candidate.record.workspaceId, candidate.record.runId),
      loadAnalysisNarrative(deps.store, candidate.record.workspaceId, candidate.record.id),
    ])
    if (!run || !current || current.record.generationId !== candidate.record.generationId ||
      !['queued', 'running'].includes(current.record.status) || !current.record.inputFingerprint ||
      !due(current.record, clock.now().toISOString()) || run.record.narrativeRequestId ||
      !analysisNarrativeCanWork(run.record, current.record) || !await workspaceActive(deps, run.record.workspaceId)) return
    const attemptLimitReached = current.record.attempts >= ANALYSIS_NARRATIVE_LIMITS.maxAutomaticAttempts
    const timestamp = narrativeTimestamp(run.record, clock.now().toISOString())
    const record: RealAnalysisNarrativeRecord = {
      ...current.record, status: 'running', updatedAt: timestamp, attemptId,
      attempts: Math.min(current.record.attempts + 1, ANALYSIS_NARRATIVE_LIMITS.maxAutomaticAttempts),
      lease: { owner, heartbeatAt: timestamp, expiresAt: new Date(Date.parse(timestamp) + LEASE_MS).toISOString() },
    }
    delete record.error
    delete record.nextAttemptAt
    delete record.waitingFor
    parseAnalysisEntity(record)
    try {
      await deps.store.transact(record.workspaceId, [
        { kind: 'replace', record, etag: current.etag },
        { kind: 'replace', record: { ...run.record, updatedAt: timestamp }, etag: run.etag },
      ])
    } catch (error) {
      const latest = await loadAnalysisNarrative(deps.store, record.workspaceId, record.id)
      if (latest && owns(latest.record, record, clock.now().toISOString())) return { ...latest, attemptLimitReached }
      if (!isConflict(error)) throw error
      continue
    }
    const latest = await loadAnalysisNarrative(deps.store, record.workspaceId, record.id)
    if (latest && owns(latest.record, record, clock.now().toISOString())) return { ...latest, attemptLimitReached }
    return
  }
}

function validateSaved(artifact: RealAnalysisNarrativeArtifact, input: AnalysisCandidateNarrativeModelInput | AnalysisTargetNarrativeModelInput): void {
  if (artifact.kind === 'candidate' && 'source' in input) validateAnalysisNarrativeArtifactInput(artifact, input)
  else if (artifact.kind === 'target' && 'candidates' in input) validateAnalysisNarrativeArtifactInput(artifact, input)
  else assertAnalysis(false, 'Narrative artifact kind changed after generation.')
}
export async function processClaimedNarrative(
  claimed: Narrative, deps: AnalysisWorkerDependencies,
  options: { deadline?: number; signal?: AbortSignal; attemptLimitReached?: boolean } = {},
): Promise<boolean> {
  if (deps.owner && deps.owner !== claimed.record.lease?.owner) return false
  const clock = deps.clock ?? systemClock
  const started = clock.now().getTime()
  const lease = new NarrativeLease(claimed, deps, clock, options.deadline ?? started + RUN_BUDGET_MS, options.signal)
  let stage: Stage = claimed.record.recordType === 'analysis-candidate-narrative' ? 'candidate-generation' : 'target-generation'
  let inputs = true
  let reference: ImmutableJsonBlobReference | undefined
  const emit = (outcome: AnalysisNarrativeTelemetryEvent['outcome'], failure?: AnalysisNarrativeProcessingError) => {
    const record = claimed.record
    const event: AnalysisNarrativeTelemetryEvent = {
      event: 'narrative-outcome', workspaceId: record.workspaceId, runId: record.runId, targetId: record.targetId,
      ...(record.recordType === 'analysis-candidate-narrative' ? { comparisonId: record.comparisonId } : {}),
      generationId: record.generationId, attemptId: record.attemptId, stage: failure?.stage ?? stage, outcome,
      ...(failure ? { code: failure.code, retryable: failure.retryable } : {}),
      durationMilliseconds: Math.max(0, clock.now().getTime() - started),
    }
    try {
      if (deps.onNarrativeEvent) deps.onNarrativeEvent(event)
      else console.log(JSON.stringify({ component: 'score-analysis-narrative', ...event }))
    } catch { console.error('Analysis narrative telemetry failed:', { code: 'analysis-narrative-telemetry-failed' }) }
  }
  try {
    const { run, narrative } = await lease.check()
    if (options.attemptLimitReached) throw new NarrativeWorkFailure({
      code: 'timeout', stage, retryable: true,
      message: 'Summary generation stopped after three attempts. Generate missing summaries to retry without changing the assessment.',
    })
    const inventory = await lease.control.wait(() => readAnalysisNarrativeInventory(deps, run.record.workspaceId, run.record.id, narrative.record.targetId))
    const comparisonId = narrative.record.recordType === 'analysis-candidate-narrative' ? narrative.record.comparisonId : undefined
    const input = comparisonId
      ? await lease.control.wait(() => candidateInput(deps, inventory, comparisonId, lease.control.signal))
      : await lease.control.wait(() => targetInput(deps, inventory, lease.control.signal))
    if (input.inputFingerprint !== narrative.record.inputFingerprint) throw new LostNarrativeWork()
    inputs = false
    await lease.check()
    const modelOptions = { model: deps.model, clock, signal: lease.control.signal, attemptId: narrative.record.attemptId! }
    const generated = 'source' in input
      ? await lease.control.wait(() => generateCandidateNarrative(input, modelOptions))
      : await lease.control.wait(() => generateTargetNarrative(input, modelOptions))
    stage = 'publication'
    const current = await lease.check()
    const artifact = parseAnalysisNarrativeArtifact({
      schemaVersion: 1, dataKind: 'real', kind: input.binding.kind, binding: input.binding,
      ...generated.output, provenance: generated.provenance, inputFingerprint: input.inputFingerprint,
      createdAt: narrativeTimestamp(current.run.record, clock.now().toISOString()), humanReviewRequired: true,
      generationId: narrative.record.generationId, requestId: narrative.record.requestId,
      ...(narrative.record.published ? { previousPublication: narrative.record.published } : {}),
    })
    validateSaved(artifact, input)
    const subject = narrative.record.recordType === 'analysis-candidate-narrative' ? narrative.record.comparisonId : narrative.record.targetId
    const name = analysisNarrativeBlobName(run.record.workspaceId, run.record.id, input.binding.kind, subject,
      narrative.record.generationId, narrative.record.attemptId!)
    const blobs = fencedAnalysisBlobs(deps, run.record.workspaceId, run.record.id, lease.control.signal, () => lease.check())
    try { reference = await lease.control.wait(() => putAnalysisJson(blobs, name, artifact)) } catch (error) {
      await lease.check()
      const winner = await lease.control.wait(() => deps.blobs.read(name))
      if (!winner) throw error
      reference = analysisBlobReference(name, winner)
    }
    const saved = parseAnalysisNarrativeArtifact(parseAnalysisJson(await lease.control.wait(() =>
      readAnalysisBlob(deps.blobs, reference!, run.record.workspaceId, run.record.id))))
    validateSaved(saved, input)
    assertAnalysis(saved.generationId === narrative.record.generationId && saved.requestId === narrative.record.requestId &&
      saved.provenance.attemptId === narrative.record.attemptId &&
      analysisHash(saved.previousPublication ?? null) === analysisHash(narrative.record.published ?? null),
    'Saved narrative version does not match its publication attempt.')
    const published = {
      blob: reference, revision: reference.sha256, inputFingerprint: saved.inputFingerprint,
      generationId: saved.generationId, publishedAt: saved.createdAt,
    }
    await lease.atomic((record, timestamp) => {
      const next = { ...record, status: 'ready' as const, updatedAt: timestamp, published }
      delete next.lease
      delete next.nextAttemptAt
      delete next.error
      return next
    }, false, input.inputFingerprint)
    emit('ready')
    return true
  } catch (caught) {
    const error = lease.control.signal.aborted ? lease.control.signal.reason : caught
    const latest = await loadAnalysisNarrative(deps.store, claimed.record.workspaceId, claimed.record.id)
    if (reference && latest?.record.status === 'ready' && latest.record.generationId === claimed.record.generationId &&
      latest.record.attemptId === claimed.record.attemptId && latest.record.published?.revision === reference.sha256) {
      emit('ready')
      return true
    }
    if (error instanceof LostNarrativeWork) { emit('abandoned'); return false }
    const failure = failureFor(error, stage, inputs)
    try {
      let outcome: 'queued' | 'failed' = 'failed'
      await lease.atomic((record, timestamp) => {
        const retry = failure.retryable && record.attempts < ANALYSIS_NARRATIVE_LIMITS.maxAutomaticAttempts
        outcome = retry ? 'queued' : 'failed'
        const next = { ...record, status: outcome, updatedAt: timestamp, error: failure }
        delete next.lease
        delete next.nextAttemptAt
        if (retry) next.nextAttemptAt = new Date(Date.parse(timestamp) + BACKOFF_MS * 2 ** Math.max(0, record.attempts - 1)).toISOString()
        return next
      }, true)
      emit(outcome, failure)
    } catch (failure) {
      if (!(failure instanceof LostNarrativeWork)) throw failure
      emit('abandoned')
    }
    return false
  } finally { await lease.stop() }
}

export async function runAnalysisNarrativeWork(
  deps: AnalysisWorkerDependencies, candidate: VersionedAnalysisEntity,
  options: { deadline: number; signal?: AbortSignal },
): Promise<boolean> {
  const clock = deps.clock ?? systemClock
  const record = parseAnalysisEntity(candidate.record)
  if (record.recordType === 'analysis-narrative-request') {
    let worked = false
    for (let chunk = 0; chunk < ANALYSIS_LIMITS.maxComparisons * 2 && clock.now().getTime() < options.deadline && !options.signal?.aborted; chunk++) {
      if (!await advanceAnalysisNarrativeRequest(deps, record.workspaceId, record.runId, record.requestId, () => clock.now())) break
      worked = true
    }
    return worked
  }
  assertAnalysis(record.recordType === 'analysis-candidate-narrative' || record.recordType === 'analysis-target-narrative', 'Invalid narrative worker record.')
  const prepared = await reconcileTarget(deps, { record, etag: candidate.etag }, clock)
  if (!prepared.ready) return prepared.worked
  const current = await loadAnalysisNarrative(deps.store, record.workspaceId, record.id)
  if (!current) return prepared.worked
  const claimed = await claim(deps, current, clock, deps.owner ?? `analysis-narrative-worker-${randomUUID()}`, options.deadline, options.signal)
  if (!claimed) return prepared.worked
  await processClaimedNarrative(claimed, deps, { ...options, attemptLimitReached: claimed.attemptLimitReached })
  return true
}
