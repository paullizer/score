import { randomUUID } from 'node:crypto'
import type { ProcessingSettingsSnapshot } from '../../src/domain/admin-settings'
import { captureQcProcessingSettings, processingSettingsSnapshotSchema } from '../../src/domain/admin-settings'
import type { VersionedQc } from '../../src/domain/quality-control'
import type { QcCasePack, QcEvaluation, QcPlanProposal, QcPlanRecord, QcPromptFamily, QcWorkRecord } from '../../src/domain/quality-improvement'
import { StoreConflictError } from '../../server/store'
import type { QcDeps, QcRecord, QcTransaction } from '../../server/qc/store'
import {
  parseQcRecord, qcAssert, qcBytesHash, qcCandidateGuidance, qcPlanHash, qcRunIds, qcSettingsHash, qcValueHash,
  QC_LEASE_MILLISECONDS,
} from '../../server/qc/validation'
import {
  assertQcEvaluationCoverage, parseQcEvaluationArtifact, parseQcPlanCheckpoint, putQcJson, qcCheckpointBinding, qcPlannedTrials,
  qcTrialModelsMatch, readQcCasePack, readQcJson, type QcEvaluationArtifact, type QcEvaluationCheckpoint, type QcPlannerProvenance,
} from '../../server/qc/artifacts'
import { qcPlanRevision } from '../../server/qc/plans'
import { qcWorkPending } from '../../server/qc/azure-store'
import { qcAcceptedControlFences } from '../../server/qc/fences'
import { validatePromptSnapshot } from '../../server/settings/prompt-integrity'
import { systemClock, type Clock } from '../clock'
import type { RubricModelOptions } from '../runtime'
import type { WorkerSettingsReader } from '../settings'
import { validateProcessingSettings } from '../settings'
import {
  draftQcPlan, qcDraftingInput, qcPlannerContract, runQcTrial, validateQcDraftProposal,
  type QcModelDependencies, type QcTrialOutcome,
} from './model'

export { RUNTIME_SETTINGS_VERSION } from '../../src/domain/admin-settings'
export { PROMPT_RUNTIME_VERSION } from '../../src/domain/prompt-versions'
export const QC_RUNTIME_VERSION = 'score-qc-worker-v1'
export const QC_WORKER_VERSION = QC_RUNTIME_VERSION
const HEARTBEAT_MILLISECONDS = 15_000
const SAFE_ERROR = 'QC work failed or exceeded its bounded execution budget. No production result, rubric, or active prompt was changed.'
export function retryableQcFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('retryable' in error && typeof error.retryable === 'boolean') return error.retryable
  if (error instanceof StoreConflictError) return true
  const failure = error as { code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown }
  const status = Number(failure.statusCode ?? failure.status ?? failure.code)
  return [408, 429, 500, 502, 503, 504].includes(status) || failure.name === 'AbortError' ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(failure.code))
}
interface QcPolicy {
  maxAutomaticAttempts: number
  retryBackoff: { baseMilliseconds: number; maxMilliseconds: number }
}
function policy(snapshot: ProcessingSettingsSnapshot): QcPolicy {
  const current = snapshot.settings.processing.qc
  qcAssert(current && snapshot.tasks.qcPlan, 'Accepted QC work must capture its dedicated task and processing policy.')
  return current
}
export interface QcWorkerDependencies extends QcDeps, QcModelDependencies {
  settings?: WorkerSettingsReader
  owner?: string
  trial?: (
    entry: QcCasePack['cases'][number], family: QcPromptFamily, settings: ProcessingSettingsSnapshot,
    deps: QcModelDependencies, signal: AbortSignal,
  ) => Promise<QcTrialOutcome>
}
export interface QcWorkerOptions { maxItems?: number; budgetMilliseconds?: number; signal?: AbortSignal }
type Work = VersionedQc<QcWorkRecord>
type Plan = VersionedQc<QcPlanRecord>
async function workAndPlan(deps: QcDeps, workspaceId: string, id: string): Promise<{ work: Work; plan: Plan }> {
  const work = await deps.store.get(workspaceId, id)
  if (!work) throw new StoreConflictError('QC work disappeared during lifecycle cleanup.')
  qcAssert(work?.record.recordType === 'qc-work' && work.record.workspaceId === workspaceId && work.record.id === id)
  parseQcRecord(work.record)
  const plan = await deps.store.get(workspaceId, work.record.planId)
  if (!plan) throw new StoreConflictError('QC work parent disappeared during lifecycle cleanup.')
  qcAssert(plan?.record.recordType === 'qc-plan' && plan.record.workspaceId === workspaceId && plan.record.id === work.record.planId)
  parseQcRecord(plan.record)
  return { work: work as Work, plan: plan as Plan }
}
async function active(deps: QcDeps, plan: QcPlanRecord, work: QcWorkRecord): Promise<void> {
  for (const fence of await qcAcceptedControlFences(deps.store, work, qcRunIds(plan))) {
    const value = await deps.store.get(plan.workspaceId, fence.controlId)
    // API acceptance creates every control atomically. Missing controls are not an active default for workers.
    if (!value || value.record.recordType !== 'qc-control' || value.record.state !== 'active' ||
      value.record.cleanupPending || value.record.cancellationPending || (value.record.generation ?? 0) !== fence.generation) {
      throw new StoreConflictError('QC lifecycle changed.')
    }
  }
}
function eligible(work: QcWorkRecord, plan: QcPlanRecord): boolean {
  return plan.workId === work.id && plan.revision === work.planRevision &&
    plan.status === (work.kind === 'plan' ? 'planning' : 'evaluating')
}
export async function claimQcWork(deps: QcWorkerDependencies, candidate: Work, owner: string): Promise<Work | null> {
  const clock = deps.clock ?? systemClock
  let latest: Awaited<ReturnType<typeof workAndPlan>>
  try { latest = await workAndPlan(deps, candidate.record.workspaceId, candidate.record.id) } catch (error) {
    if (error instanceof StoreConflictError) return null
    throw error
  }
  if (!eligible(latest.work.record, latest.plan.record) || !qcWorkPending(latest.work.record, clock.now().toISOString())) return null
  const snapshot = validateProcessingSettings(latest.plan.record.processingSettings)
  const timestamp = clock.now().toISOString()
  try {
    await active(deps, latest.plan.record, latest.work.record)
    if (latest.work.record.attempts >= policy(snapshot).maxAutomaticAttempts) {
      await deps.store.transact(latest.work.record.workspaceId, [
        { kind: 'replace', record: { ...latest.work.record, status: 'failed', lease: null, nextAttemptAt: null, error: SAFE_ERROR, updatedAt: timestamp }, etag: latest.work.etag },
        { kind: 'replace', record: { ...latest.plan.record, status: 'failed', error: SAFE_ERROR, updatedAt: timestamp }, etag: latest.plan.etag },
      ])
      return null
    }
    const next: QcWorkRecord = {
      ...latest.work.record, status: 'running', attempts: latest.work.record.attempts + 1, error: null, nextAttemptAt: null,
      updatedAt: timestamp, lease: { id: `${owner}:${randomUUID()}`, expiresAt: new Date(clock.now().getTime() + QC_LEASE_MILLISECONDS).toISOString() },
    }
    await deps.store.transact(next.workspaceId, [
      { kind: 'replace', record: next, etag: latest.work.etag },
      { kind: 'replace', record: { ...latest.plan.record, updatedAt: timestamp }, etag: latest.plan.etag },
    ])
    const saved = await workAndPlan(deps, next.workspaceId, next.id)
    return saved.work.record.lease?.id === next.lease!.id ? saved.work : null
  } catch (error) { if (error instanceof StoreConflictError) return null; throw error }
}

class QcLease {
  private readonly controller = new AbortController()
  private tail: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private deadlineTimer?: ReturnType<typeof setTimeout>
  private readonly abort = () => this.controller.abort()
  readonly signal: AbortSignal
  readonly leaseId: string
  constructor(
    private readonly deps: QcWorkerDependencies, readonly claimed: Work,
    private readonly deadline: number, private readonly parentSignal?: AbortSignal,
  ) {
    this.leaseId = claimed.record.lease!.id
    this.signal = this.controller.signal
    parentSignal?.addEventListener('abort', this.abort, { once: true })
    if (parentSignal?.aborted) this.abort()
  }
  start() {
    this.timer = setInterval(() => { void this.change({}).catch(() => this.controller.abort()) }, HEARTBEAT_MILLISECONDS)
    this.timer.unref()
    this.deadlineTimer = setTimeout(this.abort, Math.max(1, this.deadline - this.deps.clock.now().getTime()))
    this.deadlineTimer.unref()
  }
  private assertActive(work: QcWorkRecord, allowAborted: boolean) {
    if (!allowAborted) {
      if (this.deps.clock.now().getTime() >= this.deadline) this.controller.abort()
      this.signal.throwIfAborted()
    }
    if (work.lease?.id !== this.leaseId || Date.parse(work.lease.expiresAt) <= this.deps.clock.now().getTime()) {
      throw new StoreConflictError('QC work lost its lease before publication.')
    }
  }
  async check(allowAborted = false) {
    if (!allowAborted) {
      this.signal.throwIfAborted()
      if (this.deps.clock.now().getTime() >= this.deadline) { this.controller.abort(); this.signal.throwIfAborted() }
    }
    const latest = await workAndPlan(this.deps, this.claimed.record.workspaceId, this.claimed.record.id)
    if (latest.work.record.status !== 'running' || latest.work.record.lease?.id !== this.leaseId ||
      Date.parse(latest.work.record.lease.expiresAt) <= this.deps.clock.now().getTime() ||
      !eligible(latest.work.record, latest.plan.record)) throw new StoreConflictError('QC work was cancelled, superseded, or lost its lease.')
    await active(this.deps, latest.plan.record, latest.work.record)
    this.assertActive(latest.work.record, allowAborted)
    return latest
  }
  async change(
    workChange: Partial<QcWorkRecord>, planChange: Partial<QcPlanRecord> = {},
    extra: QcTransaction[] = [], allowAborted = false,
  ) {
    const next = this.tail.then(async () => {
      const current = await this.check(allowAborted)
      const timestamp = this.deps.clock.now().toISOString()
      const work: QcWorkRecord = {
        ...current.work.record, updatedAt: timestamp,
        lease: { id: this.leaseId, expiresAt: new Date(this.deps.clock.now().getTime() + QC_LEASE_MILLISECONDS).toISOString() },
        ...workChange,
      }
      const plan: QcPlanRecord = { ...current.plan.record, updatedAt: timestamp, ...planChange }
      await this.deps.store.transact(work.workspaceId, [
        { kind: 'replace', record: work, etag: current.work.etag },
        { kind: 'replace', record: plan, etag: current.plan.etag }, ...extra,
      ], { assertActive: () => this.assertActive(current.work.record, allowAborted) })
      return { work, plan }
    })
    this.tail = next.catch(() => undefined)
    return next
  }
  async checkpoint(value: unknown) {
    const current = await this.check()
    const reference = await putQcJson(this.deps.blobs, current.plan.record.workspaceId, current.plan.record.id, value, {
      runIds: qcRunIds(current.plan.record), assertActive: async () => { await this.check() },
    })
    await this.change({ checkpoint: reference })
  }
  async stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.parentSignal?.removeEventListener('abort', this.abort)
    await this.tail
  }
}
function evaluation(plan: QcPlanRecord, checkpoint: QcEvaluationCheckpoint, now: string): QcEvaluation {
  const complete = checkpoint.cases.every(entry => entry.baseline.status === 'complete' && entry.candidate.status === 'complete')
  const stableModels = checkpoint.executions.every(qcTrialModelsMatch)
  return {
    schemaVersion: 1, workspaceId: plan.workspaceId, planId: plan.id, planRevision: plan.revision,
    planHash: qcPlanHash(plan), baselineRevision: plan.baseline.revision, settingsHash: qcSettingsHash(plan.processingSettings),
    candidateHash: qcValueHash(qcCandidateGuidance(plan)), createdAt: checkpoint.startedAt, completedAt: now,
    cases: checkpoint.cases, eligible: complete && stableModels,
    limitations: [
      'Curated cases are not a representative benchmark. These diagnostics do not establish generalization or hiring validity.',
      'Only explicit numeric curator references on unchanged criteria enter agreement/error denominators; unresolved reviewer opinions are preserved, not labeled consensus.',
      'Rubric-generation trials validate drafts, citations, weights, qualifications and grounding; changed criterion meanings have no numeric agreement metric.',
      'Holdout feedback and curator reference decisions were withheld from the planner and every model under trial.',
      ...(!complete ? ['At least one baseline or candidate trial failed validation. Activation is blocked.'] : []),
      ...(!stableModels ? ['Observed model versions differed or could not be verified. Activation is blocked.'] : []),
      ...(!plan.cases.some(entry => entry.purpose === 'holdout') ? ['No holdout cases were selected.'] : []),
    ],
  }
}
async function evaluatePlan(deps: QcWorkerDependencies, lease: QcLease, plan: QcPlanRecord, pack: QcCasePack) {
  const { work } = await lease.check()
  qcAssert(work.record.checkpoint && plan.processingSettings.promptBundle, 'The API must capture an immutable candidate before queuing paid evaluation.')
  const checkpoint = await readQcJson(deps.blobs, work.record.checkpoint, plan.workspaceId, plan.id) as QcEvaluationCheckpoint
  qcCheckpointBinding(checkpoint, plan, work.record.id)
  const candidate = validatePromptSnapshot(checkpoint.candidate)
  const baselineSettings = validateProcessingSettings(plan.processingSettings)
  const candidateSettings = processingSettingsSnapshotSchema.parse({ ...baselineSettings, schemaVersion: 2, promptBundle: candidate })
  const pending = qcPlannedTrials(plan, pack)
  qcAssert(pending.length > 0 && pending.length <= 100 && checkpoint.cases.length <= pending.length)
  const outcome = deps.trial ?? runQcTrial
  for (let index = 0; index < pending.length; index++) {
    const { entry, familyId } = pending[index]
    const scopeHash = qcValueHash(entry.selection.scope)
    if (index < checkpoint.cases.length) {
      const finished = checkpoint.cases[index]
      qcAssert(finished.familyId === familyId && qcValueHash(finished.scope) === scopeHash, 'Checkpoint trial ordering changed.')
      continue
    }
    await lease.check()
    let baseline: QcTrialOutcome
    if (checkpoint.pendingTrial) {
      qcAssert(checkpoint.pendingTrial.scopeHash === scopeHash && checkpoint.pendingTrial.familyId === familyId,
        'Checkpoint baseline belongs to another trial.')
      baseline = { trial: checkpoint.pendingTrial.baseline, models: checkpoint.pendingTrial.models }
    } else {
      baseline = await outcome(entry, familyId, baselineSettings, deps, lease.signal)
      checkpoint.pendingTrial = { scopeHash, familyId, baseline: baseline.trial, models: baseline.models }
      await lease.checkpoint(checkpoint)
    }
    await lease.check()
    const trial = await outcome(entry, familyId, candidateSettings, deps, lease.signal)
    checkpoint.cases.push({
      scope: entry.selection.scope, purpose: entry.selection.purpose, familyId, baseline: baseline.trial, candidate: trial.trial,
    })
    checkpoint.executions.push({ scopeHash, familyId, baselineModels: baseline.models, candidateModels: trial.models })
    delete checkpoint.pendingTrial
    await lease.checkpoint(checkpoint)
  }
  const result = evaluation(plan, checkpoint, deps.clock.now().toISOString())
  assertQcEvaluationCoverage(result, plan, pack)
  const artifact: QcEvaluationArtifact = { schemaVersion: 1, evaluation: result, candidate, executions: checkpoint.executions }
  parseQcEvaluationArtifact(artifact, plan, pack)
  const saved = await putQcJson(deps.blobs, plan.workspaceId, plan.id, artifact, {
    runIds: qcRunIds(plan), assertActive: async () => { await lease.check() },
  })
  await lease.change({ status: 'complete', lease: null, nextAttemptAt: null, error: null }, {
    status: result.eligible ? 'ready' : 'failed', evaluation: saved,
    error: result.eligible ? null : 'The evaluation completed but failed the activation checks. Inspect the isolated trial outcomes.',
  })
}
export async function processQcWork(
  deps: QcWorkerDependencies, claimed: Work, deadline: number, signal?: AbortSignal,
): Promise<'complete' | 'deferred' | 'stopped'> {
  const lease = new QcLease(deps, claimed, deadline, signal)
  lease.start()
  try {
    const { plan, work } = await lease.check()
    const pack = await readQcCasePack(deps.blobs, plan.record)
    if (work.record.kind === 'plan') {
      let proposal: QcPlanProposal
      if (work.record.checkpoint) {
        const checkpoint = parseQcPlanCheckpoint(await readQcJson(deps.blobs, work.record.checkpoint,
          plan.record.workspaceId, plan.record.id), plan.record, work.record.id)
        qcAssert(Object.entries(qcPlannerContract()).every(([key, value]) =>
          checkpoint.provenance[key as keyof QcPlannerProvenance] === value) &&
          checkpoint.provenance.inputSha256 === qcBytesHash(Buffer.from(JSON.stringify(qcDraftingInput(plan.record, pack)))),
        'The planner contract or authorized input changed after acceptance.')
        proposal = checkpoint.proposal
      } else {
        let provenance: QcPlannerProvenance | undefined
        proposal = await draftQcPlan(plan.record, pack, {
          ...deps, onQcPlannerProvenance: value => { provenance = value },
        }, lease.signal)
        qcAssert(provenance, 'QC drafting must preserve its exact model and instruction provenance.')
        await lease.checkpoint({ schemaVersion: 1, workId: work.record.id, planHash: qcPlanHash(plan.record), proposal, provenance })
      }
      validateQcDraftProposal(proposal, plan.record, pack)
      const next: QcPlanRecord = {
        ...plan.record, proposal, revision: plan.record.revision + 1, status: 'draft', evaluation: null,
        updatedAt: deps.clock.now().toISOString(), error: null,
      }
      parseQcRecord(next)
      await lease.change({ status: 'complete', lease: null, nextAttemptAt: null, error: null },
        { proposal, revision: next.revision, status: 'draft', evaluation: null, error: null },
        [{ kind: 'create', record: qcPlanRevision(next) }])
    } else await evaluatePlan(deps, lease, plan.record, pack)
    return 'complete'
  } catch (error) {
    try {
      const current = await lease.check(true)
      const captured = policy(current.plan.record.processingSettings)
      const retryable = lease.signal.aborted || retryableQcFailure(error)
      const retry = retryable && current.work.record.attempts < captured.maxAutomaticAttempts
      const backoff = Math.min(captured.retryBackoff.maxMilliseconds,
        captured.retryBackoff.baseMilliseconds * 2 ** Math.max(0, current.work.record.attempts - 1))
      await lease.change({
        status: retry ? 'queued' : 'failed', lease: null, error: SAFE_ERROR,
        nextAttemptAt: retry ? new Date(deps.clock.now().getTime() + backoff).toISOString() : null,
      }, {
        status: retry ? current.plan.record.status : 'failed', error: SAFE_ERROR,
      }, [], true)
      return retry ? 'deferred' : 'stopped'
    } catch { return 'stopped' }
  } finally { await lease.stop() }
}
export async function runQcWorker(
  dependencies: Omit<QcWorkerDependencies, 'clock'> & { clock?: Clock }, options: QcWorkerOptions = {},
): Promise<{ claimed: number; completed: number; deferred: number; stopped: number }> {
  const deps: QcWorkerDependencies = { ...dependencies, clock: dependencies.clock ?? systemClock }
  const result = { claimed: 0, completed: 0, deferred: 0, stopped: 0 }
  if (!deps.workerEnabled || options.signal?.aborted) return result
  let maxItems = options.maxItems ?? 2, budget = options.budgetMilliseconds ?? 660_000
  qcAssert(Number.isInteger(maxItems) && maxItems >= 1 && maxItems <= 10 &&
    Number.isInteger(budget) && budget >= 1000 && budget <= 660_000, 'QC execution limits are invalid.')
  if (deps.settings) {
    const settings = captureQcProcessingSettings(validateProcessingSettings(await deps.settings.current()))
    const policy = settings.settings.workers.qc!
    if (policy.pauseClaiming) return result
    maxItems = Math.min(maxItems, policy.maxItemsPerExecution)
    budget = Math.min(budget, policy.budgetMilliseconds)
  }
  const deadline = deps.clock.now().getTime() + budget
  const candidates = await deps.store.pending(deps.clock.now().toISOString(), Math.min(100, maxItems * 3))
  const owner = deps.owner ?? `qc-worker-${randomUUID()}`
  for (const candidate of candidates) {
    if (result.claimed >= maxItems || deps.clock.now().getTime() >= deadline || options.signal?.aborted) break
    const work = await claimQcWork(deps, candidate, owner)
    if (!work) continue
    result.claimed++
    const outcome = await processQcWork(deps, work, deadline, options.signal)
    if (outcome === 'complete') result.completed++
    else if (outcome === 'deferred') result.deferred++
    else result.stopped++
  }
  return result
}
export type { RubricModelOptions, QcRecord }
