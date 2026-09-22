import { z } from 'zod'
import { processingSettingsSnapshotSchema } from '../../src/domain/admin-settings-schema'
import {
  admittedProcessingSettings, newProcessingSettings, preservesProcessingSettings,
  assertNewWork, newWorkProcessingSettings, type ProcessingSettingsProvider,
} from '../jobs/policy'
import {
  ANALYSIS_NARRATIVE_SCHEMA_VERSION, analysisNarrativeIsCurrent, analysisTargetNarrativeCanGenerate, type AnalysisCandidateNarrativeInputBinding,
  type AnalysisNarrativeCounts, type AnalysisNarrativeCurrentState, type AnalysisNarrativeWaitReason,
  type AnalysisTargetNarrativeInputBinding, type GenerateRealAnalysisSummariesInput,
  type RealAnalysisCandidateNarrativeRecord, type RealAnalysisCandidateNarrativeSummary, type RealAnalysisNarrativeRecord,
  type RealAnalysisSummariesMutationResponse, type RealAnalysisSummariesResponse, type RealAnalysisTargetNarrativeRecord,
  type RealAnalysisTargetNarrativeSummary, type RealAnalysisSummarySubjectResponse,
} from '../../src/domain/analysis-narratives'
import type { AnalysisSummarySubject } from '../../src/domain/analysis-summary-history'
import { deriveAnalysisNarrativeWorkHealth } from '../../src/domain/analysis-narrative-work-health'
import {
  ANALYSIS_LIMITS, type AnalysisEntity, type AnalysisTargetSnapshotReference, type RealAnalysisComparisonRecord,
  type RealAnalysisInitializationManifest, type RealAnalysisNarrativeRequestRecord, type RealAnalysisRunRecord, type VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import { conflict, invalidRequest, notFound, preconditionRequired } from '../errors'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { isUuid } from '../jobs/validation'
import { StoreConflictError } from '../store'
import { traceOperation } from '../telemetry-operations'
import { analysisIsRemoved, assertAnalysisRunWritable, assertAnalysisWorkspaceActive, fencedAnalysisBlobs } from './guards'
import { loadAnalysisComparison, loadAnalysisRun } from './lifecycle'
import {
  analysisCorrectionCanWork, loadAnalysisCorrection, projectAnalysisComparison,
  resolveAnalysisComparison, resolveAnalysisComparisonRevision,
} from './current-results'
import { ANALYSIS_CORRECTION_LIMITS, type RealAnalysisCorrectionRecord } from '../../src/domain/analysis-corrections'
import { readAnalysisNarrativePublication } from './narrative-artifacts'
import {
  analysisNarrativeCanWork, analysisNarrativeRequestCanAdvance, analysisNarrativeRequestCancelled,
  candidateNarrativeBinding, narrativeCurrentState, narrativePublicationVersion,
  narrativeTimestamp, newCandidateNarrative, newTargetNarrative, type NarrativeRequestIdentity,
} from './narrative-records'
import {
  analysisBlobReference, assertComparisonManifestBinding, createAnalysisImmutableBlobReader,
  parseAnalysisJson, readAnalysisBlob, readAnalysisManifest,
} from './snapshots'
import type { AnalysisBlobStore, AnalysisStore, AnalysisTransaction, RealAnalysesDeps } from './store'
import {
  analysisHash, analysisNarrativeId, analysisNarrativeRequestBlobName, analysisNarrativeTargetIdSchema, assertAnalysis,
  analysisSummaryActionBlobName, generateAnalysisSummariesInputSchema, isAnalysisId, MAX_ANALYSIS_TRANSACTION_BYTES, parseAnalysisEntity,
} from './validation'

type Run = VersionedAnalysisEntity<RealAnalysisRunRecord>
type Narrative = VersionedAnalysisEntity<RealAnalysisNarrativeRecord>
type RequestReceipt = VersionedAnalysisEntity<RealAnalysisNarrativeRequestRecord>
export interface AnalysisNarrativeInventoryComparison {
  comparison: RealAnalysisComparisonRecord | undefined
  id: string
  index: number
  status: RealAnalysisComparisonRecord['status']
  target: AnalysisTargetSnapshotReference
  resumeSnapshot: { snapshotId: string; sha256: string }
  binding: AnalysisCandidateNarrativeInputBinding | null
  correctionPending: boolean
  narrative?: RealAnalysisCandidateNarrativeRecord
  state: AnalysisNarrativeCurrentState
}
export interface AnalysisNarrativeInventory {
  run: Run
  manifest: RealAnalysisInitializationManifest
  comparisons: AnalysisNarrativeInventoryComparison[]
  targets: {
    target: AnalysisTargetSnapshotReference
    binding: AnalysisTargetNarrativeInputBinding
    narrative?: RealAnalysisTargetNarrativeRecord
    state: AnalysisNarrativeCurrentState
    waitingFor: AnalysisNarrativeWaitReason | null
  }[]
  revision: string
  scope: { targetId: string | null }
}

const requestPlanSchema = z.strictObject({
  schemaVersion: z.literal(1), workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  runId: z.string().refine(value => isAnalysisId(value, 'run')), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid(), requestedBy: z.string().min(1).max(200), createdAt: z.iso.datetime({ precision: 3 }),
  mode: z.enum(['missing', 'all']), targetId: analysisNarrativeTargetIdSchema.nullable(), scopeRevision: z.string().regex(/^[a-f0-9]{64}$/),
  comparisonIds: z.array(z.string().refine(value => isAnalysisId(value, 'comparison'))).max(ANALYSIS_LIMITS.maxComparisons),
  targetIds: z.array(analysisNarrativeTargetIdSchema).max(ANALYSIS_LIMITS.maxComparisons),
  processingSettings: processingSettingsSnapshotSchema.optional(),
})
type RequestPlan = z.infer<typeof requestPlanSchema>
function assertPlanScope(plan: RequestPlan, manifest: RealAnalysisInitializationManifest): void {
  const targets = new Map(manifest.targets.map(target => [target.snapshotId, target.summary.id]))
  assertAnalysis(plan.targetIds.every(id => [...targets.values()].includes(id) && (plan.targetId === null || plan.targetId === id)) &&
    plan.comparisonIds.every(id => {
      const pair = manifest.comparisons.find(item => item.id === id)
      return pair && (plan.targetId === null || targets.get(pair.targetSnapshotId) === plan.targetId)
    }), 'Narrative request contains work outside its exact frozen scope.')
}

function isConflict(error: unknown): boolean {
  return error instanceof StoreConflictError || error instanceof Error && error.name === 'StoreConflictError'
}
function requireScope(workspaceId: string, runId: string, targetId?: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId) || !isAnalysisId(runId, 'run')) throw notFound('The saved analysis was not found.')
  if (targetId !== undefined && !analysisNarrativeTargetIdSchema.safeParse(targetId).success) {
    throw invalidRequest('targetId must identify one exact saved analysis target, not a label.')
  }
}
export async function loadAnalysisNarrative(
  store: AnalysisStore, workspaceId: string, id: string, signal?: AbortSignal,
): Promise<Narrative | undefined> {
  signal?.throwIfAborted()
  const value = await store.get(workspaceId, id, signal)
  signal?.throwIfAborted()
  if (!value) return undefined
  const record = parseAnalysisEntity(value.record)
  assertAnalysis((record.recordType === 'analysis-candidate-narrative' || record.recordType === 'analysis-target-narrative') &&
    record.workspaceId === workspaceId && record.id === id && value.etag, 'Narrative lookup returned foreign metadata.')
  return { record, etag: value.etag }
}
async function receipt(
  store: AnalysisStore, workspaceId: string, runId: string, requestId: string, signal?: AbortSignal,
): Promise<RequestReceipt | undefined> {
  signal?.throwIfAborted()
  const id = analysisNarrativeId('request', runId, requestId)
  const value = await store.get(workspaceId, id, signal)
  signal?.throwIfAborted()
  if (!value) return undefined
  const record = parseAnalysisEntity(value.record)
  assertAnalysis(record.recordType === 'analysis-narrative-request' && record.workspaceId === workspaceId &&
    record.runId === runId && record.id === id && value.etag, 'Narrative request lookup returned foreign metadata.')
  return { record, etag: value.etag }
}
async function planFor(
  deps: RealAnalysesDeps, run: RealAnalysisRunRecord, request: RealAnalysisNarrativeRequestRecord, signal?: AbortSignal,
): Promise<RequestPlan> {
  const plan = requestPlanSchema.parse(parseAnalysisJson(await readAnalysisBlob(deps.blobs, request.plan, run.workspaceId, run.id, signal)))
  assertAnalysis(plan.workspaceId === run.workspaceId && plan.runId === run.id && plan.manifestSha256 === run.manifest.sha256 &&
    request.manifestSha256 === run.manifest.sha256 &&
    plan.requestId === request.requestId && plan.requestedBy === request.requestedBy && plan.mode === request.mode &&
    plan.targetId === request.targetId && plan.scopeRevision === request.scopeRevision && plan.createdAt === request.createdAt &&
    plan.comparisonIds.length === request.scheduled.candidates && plan.targetIds.length === request.scheduled.targets &&
    preservesProcessingSettings(plan.processingSettings, request.processingSettings) &&
    new Set(plan.comparisonIds).size === plan.comparisonIds.length && new Set(plan.targetIds).size === plan.targetIds.length,
  'Narrative scheduling plan does not match its durable receipt.')
  return plan
}

async function records<K extends AnalysisEntity['recordType']>(
  store: AnalysisStore, workspaceId: string, runId: string, recordType: K, targetId?: string, signal?: AbortSignal,
): Promise<VersionedAnalysisEntity<Extract<AnalysisEntity, { recordType: K }>>[]> {
  const result: VersionedAnalysisEntity<Extract<AnalysisEntity, { recordType: K }>>[] = []
  const ids = new Set<string>(), tokens = new Set<string>()
  let continuationToken: string | undefined
  do {
    signal?.throwIfAborted()
    const page = await traceOperation('score.storage.query', { 'score.read.count': 1, 'score.storage.kind': 'cosmos' },
      () => store.list(workspaceId, { recordType, runId, targetId, limit: 100, continuationToken, signal }))
    signal?.throwIfAborted()
    for (const value of page.items) {
      const record = parseAnalysisEntity(value.record)
      assertAnalysis(record.recordType === recordType && record.recordType !== 'analysis-run' &&
        record.workspaceId === workspaceId && record.runId === runId && value.etag && !ids.has(record.id) &&
        (targetId === undefined || (record.recordType === 'analysis-comparison' ? record.target.summary.id === targetId
          : 'targetId' in record && record.targetId === targetId)), 'Narrative inventory escaped its run or exact target.')
      ids.add(record.id)
      result.push(value)
    }
    const maximum = ANALYSIS_LIMITS.maxComparisons *
      (recordType === 'analysis-candidate-narrative' ? ANALYSIS_CORRECTION_LIMITS.maxCriteria + 1 : 1)
    assertAnalysis(result.length <= maximum, 'Narrative inventory exceeded its bounded result-revision limit.')
    continuationToken = page.continuationToken
    if (continuationToken) { assertAnalysis(!tokens.has(continuationToken), 'Narrative inventory pagination did not advance.'); tokens.add(continuationToken) }
  } while (continuationToken)
  return result
}

function assertNarrativeBinding(run: RealAnalysisRunRecord, target: AnalysisTargetSnapshotReference, record: RealAnalysisNarrativeRecord): void {
  assertAnalysis(record.workspaceId === run.workspaceId && record.runId === run.id && record.manifestSha256 === run.manifest.sha256 &&
    record.targetId === target.summary.id && record.targetSnapshot.snapshotId === target.snapshotId &&
    record.targetSnapshot.sha256 === target.blob.sha256, 'Narrative does not match its exact frozen target.')
}

interface PendingNarratives {
  plan?: RequestPlan
  cancelled: boolean
  identity?: NarrativeRequestIdentity
}
async function pendingNarratives(
  deps: RealAnalysesDeps, run: RealAnalysisRunRecord, manifest: RealAnalysisInitializationManifest, signal?: AbortSignal,
): Promise<PendingNarratives> {
  if (!run.narrativeRequestId) return { cancelled: false }
  const current = await receipt(deps.store, run.workspaceId, run.id, run.narrativeRequestId, signal)
  assertAnalysis(current && current.record.status === 'queued', 'Pending narrative coordinator is missing.')
  const plan = await planFor(deps, run, current.record, signal)
  assertPlanScope(plan, manifest)
  return {
    plan, cancelled: analysisNarrativeRequestCancelled(run, current.record),
    identity: {
      requestId: plan.requestId, requestedAt: plan.createdAt, requestedBy: plan.requestedBy, reason: plan.mode,
      processingSettings: plan.processingSettings,
    },
  }
}

function inventoryComparison(
  run: RealAnalysisRunRecord, manifest: RealAnalysisInitializationManifest,
  pair: RealAnalysisInitializationManifest['comparisons'][number], target: AnalysisTargetSnapshotReference,
  comparison: RealAnalysisComparisonRecord | undefined, narrative: RealAnalysisCandidateNarrativeRecord | undefined,
  pending: PendingNarratives, correction?: RealAnalysisCorrectionRecord,
): AnalysisNarrativeInventoryComparison {
  assertAnalysis(comparison || pair.index >= run.progress.initialized, 'An initialized comparison is missing.')
  if (comparison) assertComparisonManifestBinding(manifest, comparison)
  const resume = manifest.resumes.find(item => item.snapshotId === pair.resumeSnapshotId)!
  const binding = comparison?.status === 'complete' ? candidateNarrativeBinding(run, comparison) : null
  if (narrative) {
    assertNarrativeBinding(run, target, narrative)
    assertAnalysis(narrative.comparisonId === pair.id && binding && narrative.inputFingerprint === analysisHash(binding) &&
      narrative.resultSha256 === binding.resultSha256 && analysisHash(narrative.resumeSnapshot) === analysisHash(binding.resumeSnapshot),
    'Candidate sidecar differs from the immutable comparison result.')
  }
  if (pending.plan?.comparisonIds.includes(pair.id) && pending.identity && comparison &&
    (!pending.cancelled || !narrative || narrative.requestedAt <= run.narrativeCancelledAt!)) {
    const desired = newCandidateNarrative(run, comparison, pending.identity, narrative)
    if (narrative?.generationId !== desired.generationId) narrative = desired
  }
  return {
    comparison, id: pair.id, index: pair.index, status: comparison?.status ?? 'queued', target,
    correctionPending: Boolean(correction && ['queued', 'running'].includes(correction.status) && analysisCorrectionCanWork(run, correction)),
    resumeSnapshot: { snapshotId: resume.snapshotId, sha256: resume.blob.sha256 }, binding, narrative,
    state: binding ? narrativeCurrentState(run, narrative, analysisHash(binding))
      : { status: 'not-required', generationId: null, inputFingerprint: null, published: null },
  }
}
function inventoryTarget(
  run: RealAnalysisRunRecord, target: AnalysisTargetSnapshotReference, selected: AnalysisNarrativeInventoryComparison[],
  narrative: RealAnalysisTargetNarrativeRecord | undefined, pending: PendingNarratives,
): AnalysisNarrativeInventory['targets'][number] {
  const binding: AnalysisTargetNarrativeInputBinding = {
    kind: 'target', workspaceId: run.workspaceId, runId: run.id, manifestSha256: run.manifest.sha256,
    targetId: target.summary.id, targetSnapshot: { snapshotId: target.snapshotId, sha256: target.blob.sha256 },
    comparisons: selected.map(pair => ({
      comparisonId: pair.id, status: pair.status, resumeSnapshot: pair.resumeSnapshot,
      resultSha256: pair.binding?.resultSha256 ?? null, candidateInputFingerprint: pair.binding ? analysisHash(pair.binding) : null,
      narrative: pair.binding ? pair.state : null,
    })).sort((left, right) => left.comparisonId.localeCompare(right.comparisonId)),
  }
  if (narrative) assertNarrativeBinding(run, target, narrative)
  if (pending.plan?.targetIds.includes(target.summary.id) && pending.identity &&
    (!pending.cancelled || !narrative || narrative.requestedAt <= run.narrativeCancelledAt!)) {
    const desired = newTargetNarrative(run, target, pending.identity, narrative)
    if (narrative?.generationId !== desired.generationId) narrative = desired
  }
  const waitingFor = selected.some(pair => pair.status === 'queued' || pair.status === 'running' || pair.correctionPending) ? 'scoring'
    : analysisTargetNarrativeCanGenerate(binding, selected.map(pair => pair.id)) ? null : 'candidate-narratives'
  return { target, binding, narrative, waitingFor, state: selected.some(pair => pair.status === 'complete')
    ? narrativeCurrentState(run, narrative, analysisHash(binding))
    : { status: 'not-required', generationId: null, inputFingerprint: null, published: null } }
}
function comparisonRevision(pair: AnalysisNarrativeInventoryComparison) {
  return {
    comparisonId: pair.id, initialized: Boolean(pair.comparison), status: pair.status,
    binding: pair.binding, resumeSnapshot: pair.resumeSnapshot, targetId: pair.target.summary.id, narrative: pair.state,
  }
}
async function readableRun(deps: RealAnalysesDeps, workspaceId: string, runId: string, signal?: AbortSignal): Promise<Run> {
  const run = await loadAnalysisRun(deps.store, workspaceId, runId, signal)
  if (!run || analysisIsRemoved(run.record.lifecycle)) throw notFound('The saved analysis is not available or is being removed.')
  return run
}
async function readableWorkspace(deps: RealAnalysesDeps, workspaceId: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const workspace = await deps.store.getControl(workspaceId, undefined, signal)
  signal?.throwIfAborted()
  if (workspace && ['deleting', 'deleted'].includes(workspace.record.state)) throw notFound('The saved analysis is being removed.')
  return workspace
}
async function captureNarrativeMetadata<T>(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, read: (run: RealAnalysisRunRecord) => Promise<T>, signal?: AbortSignal,
): Promise<{ run: Run; value: T }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const run = await readableRun(deps, workspaceId, runId, signal)
    try {
      const value = await read(run.record)
      const latest = await readableRun(deps, workspaceId, runId, signal)
      if (latest.etag === run.etag) return { run, value }
    } catch (error) {
      signal?.throwIfAborted()
      // A coordinator may finish or a publication may change between reads. Only a changed run
      // fence permits a retry; stable invalid metadata is never silently repaired or accepted.
      const latest = await readableRun(deps, workspaceId, runId, signal)
      if (latest.etag === run.etag) throw error
    }
  }
  throw conflict('The selected summary inputs changed during capture. Reload the saved analysis and retry.')
}

/** Exhaustive metadata only; reads never repair old runs or enqueue a prerequisite. */
export async function readAnalysisNarrativeInventory(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, targetId?: string, signal?: AbortSignal,
): Promise<AnalysisNarrativeInventory> {
  requireScope(workspaceId, runId, targetId)
  const captured = await traceOperation('score.analysis.summary.inventory', {}, () =>
    captureNarrativeMetadata(deps, workspaceId, runId, async run => {
      const [manifest, pairs, candidates, overviews, corrections] = await Promise.all([
        readAnalysisManifest(deps.blobs, run, signal),
        records(deps.store, workspaceId, runId, 'analysis-comparison', targetId, signal),
        records(deps.store, workspaceId, runId, 'analysis-candidate-narrative', targetId, signal),
        targetId === undefined ? records(deps.store, workspaceId, runId, 'analysis-target-narrative', undefined, signal)
          : loadAnalysisNarrative(deps.store, workspaceId, analysisNarrativeId('target', runId, targetId), signal).then(value => {
            assertAnalysis(!value || value.record.recordType === 'analysis-target-narrative', 'Target lookup returned a different kind.')
            return value ? [value as VersionedAnalysisEntity<RealAnalysisTargetNarrativeRecord>] : []
          }),
        records(deps.store, workspaceId, runId, 'analysis-correction', undefined, signal),
      ])
      const selectedTargets = manifest.targets.filter(item => targetId === undefined || item.summary.id === targetId)
      if (!selectedTargets.length) throw notFound('This exact saved target is not part of the analysis.')
      const targetMap = new Map(selectedTargets.map(item => [item.snapshotId, item]))
      const correctionMap = new Map(corrections.map(value => [value.record.comparisonId, value.record]))
      assertAnalysis(corrections.every(value => value.record.manifestSha256 === run.manifest.sha256 &&
        manifest.comparisons.some(pair => pair.id === value.record.comparisonId &&
          pair.resumeSnapshotId === value.record.resumeSnapshot.snapshotId && pair.targetSnapshotId === value.record.targetSnapshot.snapshotId)),
      'Correction inventory contains foreign frozen results.')
      const pairMap = new Map(pairs.map(value => [value.record.id, projectAnalysisComparison(value.record, correctionMap.get(value.record.id))]))
      for (const pair of pairs) assertComparisonManifestBinding(manifest, pair.record)
      const candidateMap = new Map(candidates.map(value => [value.record.id, value.record]))
      const targetRecords = new Map(overviews.map(value => [value.record.targetId, value.record]))
      const pending = await pendingNarratives(deps, run, manifest, signal)
      const comparisons: AnalysisNarrativeInventoryComparison[] = []
      for (const pair of manifest.comparisons) {
        const target = targetMap.get(pair.targetSnapshotId)
        if (!target) continue
        const comparison = pairMap.get(pair.id)
        const narrative = candidateMap.get(analysisNarrativeId('candidate', runId, pair.id, comparison?.resultRevision?.id))
        comparisons.push(inventoryComparison(run, manifest, pair, target, comparison, narrative, pending, correctionMap.get(pair.id)))
      }
      const targets = selectedTargets.map(target => inventoryTarget(run, target,
        comparisons.filter(pair => pair.target.snapshotId === target.snapshotId), targetRecords.get(target.summary.id), pending))
      const scope = { targetId: targetId ?? null }
      const revision = analysisHash({
        schemaVersion: ANALYSIS_NARRATIVE_SCHEMA_VERSION, workspaceId, runId, manifestSha256: run.manifest.sha256, scope,
        comparisons: comparisons.map(comparisonRevision),
        targets: targets.map(target => ({ binding: target.binding, narrative: target.state })),
      })
      return { manifest, comparisons, targets, revision, scope }
    }, signal))
  return { run: captured.run, ...captured.value }
}

function counts(states: readonly AnalysisNarrativeCurrentState[]): AnalysisNarrativeCounts {
  const result: AnalysisNarrativeCounts = {
    total: states.length, missing: 0, waiting: 0, queued: 0, running: 0, ready: 0, stale: 0, failed: 0, cancelled: 0, notRequired: 0,
  }
  for (const state of states) result[state.status === 'not-required' ? 'notRequired' : state.status]++
  return result
}
function workSummary(record: RealAnalysisNarrativeRecord | undefined, state: AnalysisNarrativeCurrentState) {
  const pending = ['queued', 'running', 'waiting'].includes(state.status)
  return {
    waitingFor: state.status === 'waiting' ? record?.waitingFor ?? null : null, attempts: record?.attempts ?? 0, retryCount: record?.retryCount ?? 0,
    nextAttemptAt: pending ? record?.nextAttemptAt ?? null : null, updatedAt: record?.updatedAt ?? null, error: record?.error ?? null,
    hasHistory: Boolean(record?.history), ...(record?.summaryRound ? { summaryRound: record.summaryRound } : {}),
  }
}
async function candidateSummary(
  blobs: Pick<AnalysisBlobStore, 'read'>, pair: AnalysisNarrativeInventoryComparison, now: string, signal?: AbortSignal,
): Promise<RealAnalysisCandidateNarrativeSummary> {
  const record = pair.narrative
  const artifact = record?.published ? await traceOperation('score.analysis.publication.read', {
    'score.summary.kind': 'candidate', 'score.publication.count': 1, 'score.operation.bytes': record.published.blob.bytes,
  }, () => readAnalysisNarrativePublication(blobs, record, undefined, signal)) : undefined
  assertAnalysis(!artifact || artifact.kind === 'candidate', 'Candidate summary has the wrong artifact kind.')
  return {
    kind: 'candidate', comparisonId: pair.id, comparisonStatus: pair.status, targetId: pair.target.summary.id,
    resultSha256: pair.binding?.resultSha256 ?? null,
    ...pair.state, ...workSummary(pair.narrative, pair.state),
    ...(record ? { workHealth: deriveAnalysisNarrativeWorkHealth(record, pair.state.status, now) } : {}),
    published: artifact?.kind === 'candidate' && pair.narrative?.published ? {
      ...narrativePublicationVersion(pair.narrative.published), dataKind: 'real', text: artifact.text, overview: artifact.overview,
      ...(artifact.schemaVersion === 2 ? { summaryVersion: 2 as const, approval: artifact.approval } : {}),
    } : null,
  }
}
async function targetSummary(
  blobs: Pick<AnalysisBlobStore, 'read'>, target: AnalysisNarrativeInventory['targets'][number], now: string, signal?: AbortSignal,
): Promise<RealAnalysisTargetNarrativeSummary> {
  const record = target.narrative
  const artifact = record?.published ? await traceOperation('score.analysis.publication.read', {
    'score.summary.kind': 'target', 'score.publication.count': 1, 'score.operation.bytes': record.published.blob.bytes,
  }, () => readAnalysisNarrativePublication(blobs, record, undefined, signal)) : undefined
  assertAnalysis(!artifact || artifact.kind === 'target', 'Target overview has the wrong artifact kind.')
  return {
    kind: 'target', targetId: target.target.summary.id, ...target.state, ...workSummary(target.narrative, target.state),
    waitingFor: target.state.status === 'waiting' ? target.waitingFor : null,
    ...(record ? { workHealth: deriveAnalysisNarrativeWorkHealth(record, target.state.status, now, target.waitingFor) } : {}),
    published: artifact?.kind === 'target' && target.narrative?.published ? {
      ...narrativePublicationVersion(target.narrative.published), dataKind: 'real', paragraphs: artifact.paragraphs,
      ...(artifact.schemaVersion === 2 ? { summaryVersion: 2 as const, approval: artifact.approval } : {}),
    } : null,
  }
}

function workRevision(summaries: readonly (RealAnalysisCandidateNarrativeSummary | RealAnalysisTargetNarrativeSummary)[]): string {
  return analysisHash(summaries.map(item => ({
    kind: item.kind, subjectId: item.kind === 'candidate' ? item.comparisonId : item.targetId,
    waitingFor: item.waitingFor, attempts: item.attempts, retryCount: item.retryCount, nextAttemptAt: item.nextAttemptAt,
    error: item.error, hasHistory: item.hasHistory, summaryRound: item.summaryRound ?? null,
    // Heartbeats remain visible metadata without invalidating stable content or resetting poll backoff.
    health: item.workHealth ? {
      state: item.workHealth.state, requestedAt: item.workHealth.requestedAt,
      nextEligibleAt: item.workHealth.nextEligibleAt, capturedSettings: item.workHealth.capturedSettings,
    } : null,
  })))
}

async function readPublicationPool<T>(reads: ((signal: AbortSignal) => Promise<T>)[], signal?: AbortSignal): Promise<T[]> {
  const controller = new AbortController()
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const result: T[] = new Array(reads.length)
  let next = 0
  const reader = async () => {
    while (next < reads.length) {
      activeSignal.throwIfAborted()
      const index = next++
      try {
        result[index] = await reads[index](activeSignal)
      } catch (error) {
        controller.abort(error)
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, reads.length) }, reader))
  activeSignal.throwIfAborted()
  return result
}

function immutableReadDeps(deps: RealAnalysesDeps): RealAnalysesDeps {
  return { ...deps, blobs: { ...deps.blobs, ...createAnalysisImmutableBlobReader(deps.blobs) } }
}
type SubjectInventory = { run: Run; revision: string } & (
  | { kind: 'candidate'; selected: AnalysisNarrativeInventoryComparison }
  | { kind: 'target'; selected: AnalysisNarrativeInventory['targets'][number] }
)
function subjectRevision(
  subject: AnalysisSummarySubject, run: RealAnalysisRunRecord,
  selected: AnalysisNarrativeInventoryComparison | AnalysisNarrativeInventory['targets'][number],
): string {
  const work = workSummary(selected.narrative, selected.state)
  return analysisHash({
    schemaVersion: ANALYSIS_NARRATIVE_SCHEMA_VERSION, workspaceId: run.workspaceId, runId: run.id,
    manifestSha256: run.manifest.sha256, ...subject,
    inputs: 'comparison' in selected ? comparisonRevision(selected) : { binding: selected.binding, narrative: selected.state },
    work: {
      waitingFor: work.waitingFor, attempts: work.attempts, retryCount: work.retryCount, nextAttemptAt: work.nextAttemptAt,
      error: work.error, hasHistory: work.hasHistory, summaryRound: work.summaryRound ?? null,
    },
  })
}
async function readSubjectInventory(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, subject: AnalysisSummarySubject, signal?: AbortSignal, resultRevisionId?: string,
): Promise<SubjectInventory> {
  if (subject.kind === 'target') {
    const inventory = await readAnalysisNarrativeInventory(deps, workspaceId, runId, subject.subjectId, signal)
    const selected = inventory.targets[0]
    return { kind: 'target', run: inventory.run, selected, revision: subjectRevision(subject, inventory.run.record, selected) }
  }
  const { run, value: selected } = await captureNarrativeMetadata(deps, workspaceId, runId, async run => {
    const [manifest, original, correction] = await Promise.all([
      readAnalysisManifest(deps.blobs, run, signal),
      loadAnalysisComparison(deps.store, workspaceId, runId, subject.subjectId, signal),
      resultRevisionId ? undefined : loadAnalysisCorrection(deps.store, workspaceId, runId, subject.subjectId, signal),
    ])
    const pair = manifest.comparisons.find(pair => pair.id === subject.subjectId)
    if (!pair) throw notFound('This exact saved comparison is not part of the analysis.')
    assertAnalysis(!correction || original && correction.record.manifestSha256 === run.manifest.sha256,
      'Correction lookup is not bound to this frozen manifest and comparison.')
    const comparison = original ? resultRevisionId
      ? (await resolveAnalysisComparisonRevision(deps, run, original, resultRevisionId, signal)).record
      : projectAnalysisComparison(original.record, correction?.record) : undefined
    if (resultRevisionId && !comparison) throw notFound('This comparison has no completed assessment history.')
    const narrative = await loadAnalysisNarrative(deps.store, workspaceId,
      analysisNarrativeId('candidate', runId, subject.subjectId, comparison?.resultRevision?.id), signal)
    assertAnalysis(!narrative || narrative.record.recordType === 'analysis-candidate-narrative', 'Candidate lookup returned a different kind.')
    const target = manifest.targets.find(target => target.snapshotId === pair.targetSnapshotId)!
    return inventoryComparison(run, manifest, pair, target, comparison,
      narrative?.record as RealAnalysisCandidateNarrativeRecord | undefined,
      resultRevisionId ? { cancelled: false } : await pendingNarratives(deps, run, manifest, signal), correction?.record)
  }, signal)
  return { kind: 'candidate', run, selected, revision: subjectRevision(subject, run.record, selected) }
}

/** Read only the requested publication; candidate metadata uses point reads, never a run inventory. */
export async function readAnalysisSummarySubject(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, subject: AnalysisSummarySubject, signal?: AbortSignal, resultRevisionId?: string,
): Promise<RealAnalysisSummarySubjectResponse> {
  requireScope(workspaceId, runId)
  if (subject.kind !== 'candidate' && subject.kind !== 'target' ||
    (subject.kind === 'candidate' ? !isAnalysisId(subject.subjectId, 'comparison')
      : !analysisNarrativeTargetIdSchema.safeParse(subject.subjectId).success)) throw notFound('The exact saved summary was not found.')
  if (resultRevisionId !== undefined && (subject.kind !== 'candidate' || resultRevisionId !== 'original' && !isUuid(resultRevisionId))) {
    throw invalidRequest('Historical summary reads require one original or published candidate result revision.')
  }
  deps = immutableReadDeps(deps)
  for (let attempt = 0; attempt < 4; attempt++) {
    const inventory = await readSubjectInventory(deps, workspaceId, runId, subject, signal, resultRevisionId)
    try {
      const now = new Date().toISOString()
      const narrative = inventory.kind === 'candidate' ? await candidateSummary(deps.blobs, inventory.selected, now, signal)
        : await targetSummary(deps.blobs, inventory.selected, now, signal)
      const latest = await readableRun(deps, workspaceId, runId, signal)
      if (latest.etag !== inventory.run.etag) {
        const current = await readSubjectInventory(deps, workspaceId, runId, subject, signal, resultRevisionId)
        if (current.revision !== inventory.revision) continue
      }
      await readableWorkspace(deps, workspaceId, signal)
      const response = {
        schemaVersion: ANALYSIS_NARRATIVE_SCHEMA_VERSION, dataKind: 'real' as const, workspaceId, runId,
        subjectId: subject.subjectId, revision: inventory.revision, etag: `"${inventory.revision}"`,
        workRevision: workRevision([narrative]),
        ...(resultRevisionId ? { resultRevisionId } : {}),
      }
      return narrative.kind === 'candidate' ? { ...response, kind: 'candidate', narrative } : { ...response, kind: 'target', narrative }
    } catch (error) {
      signal?.throwIfAborted()
      const latest = await readableRun(deps, workspaceId, runId, signal)
      if (latest.etag === inventory.run.etag) throw error
    }
  }
  throw conflict('The selected narrative changed while its published text was being read. Reload and retry.')
}

export async function readAnalysisSummaries(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, targetId?: string, signal?: AbortSignal,
): Promise<RealAnalysisSummariesResponse> {
  deps = immutableReadDeps(deps)
  for (let attempt = 0; attempt < 4; attempt++) {
    const inventory = await readAnalysisNarrativeInventory(deps, workspaceId, runId, targetId, signal)
    const now = new Date().toISOString()
    let summaries: (RealAnalysisCandidateNarrativeSummary | RealAnalysisTargetNarrativeSummary)[]
    try {
      summaries = await readPublicationPool<RealAnalysisCandidateNarrativeSummary | RealAnalysisTargetNarrativeSummary>([
        ...inventory.comparisons.map(pair => (signal: AbortSignal) => candidateSummary(deps.blobs, pair, now, signal)),
        ...inventory.targets.map(target => (signal: AbortSignal) => targetSummary(deps.blobs, target, now, signal)),
      ], signal)
    } catch (error) {
      signal?.throwIfAborted()
      const latest = await readableRun(deps, workspaceId, runId, signal)
      if (latest.etag !== inventory.run.etag) continue
      throw error
    }
    const comparisons = summaries.filter((value): value is RealAnalysisCandidateNarrativeSummary => value.kind === 'candidate')
    const targets = summaries.filter((value): value is RealAnalysisTargetNarrativeSummary => value.kind === 'target')
    const latest = await readableRun(deps, workspaceId, runId, signal)
    if (latest.etag !== inventory.run.etag) {
      const current = await readAnalysisNarrativeInventory(deps, workspaceId, runId, targetId, signal)
      if (current.revision !== inventory.revision) continue
      inventory.run = current.run
    }
    const scoring = { total: comparisons.length, initialized: 0, queued: 0, running: 0, complete: 0, failed: 0, cancelled: 0 }
    for (const pair of inventory.comparisons) {
      if (pair.comparison) scoring.initialized++
      scoring[pair.status]++
    }
    const ready = scoring.initialized === scoring.total && scoring.queued + scoring.running === 0 &&
      [...comparisons, ...targets].every(item => item.status === 'ready' || item.status === 'not-required')
    const workspace = await readableWorkspace(deps, workspaceId, signal)
    const run = inventory.run.record
    const reason = analysisIsRemoved(run.lifecycle) || ['deleting', 'deleted'].includes(workspace?.record.state ?? '') ? 'deleting'
      : run.lifecycle?.archivedAt || workspace?.record.state === 'archived' ? 'archived'
        : run.cancellation && !run.cancellation.completedAt ? 'cancelling' : null
    const pin = (state: RealAnalysisCandidateNarrativeSummary | RealAnalysisTargetNarrativeSummary) =>
      state.status === 'ready' && state.published
        ? { revision: state.published.revision, inputFingerprint: state.published.inputFingerprint } : null
    return {
      schemaVersion: ANALYSIS_NARRATIVE_SCHEMA_VERSION, dataKind: 'real', workspaceId, runId,
      scope: inventory.scope, revision: inventory.revision, etag: `"${inventory.revision}"`, ready,
      workRevision: workRevision(summaries),
      scoring, counts: { candidates: counts(comparisons), targets: counts(targets) },
      capabilities: { canGenerate: reason === null, reason }, comparisons, targets,
      capture: {
        dataKind: 'real', scope: inventory.scope, revision: inventory.revision, ready,
        comparisons: comparisons.map((pair, index) => ({
          comparisonId: pair.comparisonId, targetId: pair.targetId, status: pair.comparisonStatus,
          resultSha256: inventory.comparisons[index].binding?.resultSha256 ?? null, narrative: pin(pair),
        })),
        targets: targets.map(target => ({ targetId: target.targetId, narrative: pin(target) })),
      },
    }
  }
  throw conflict('The selected narratives changed while their published text was being read. Reload and retry.')
}

function active(state: AnalysisNarrativeCurrentState): boolean {
  return ['queued', 'running', 'waiting'].includes(state.status)
}
function selectedForGeneration(inventory: AnalysisNarrativeInventory, mode: 'missing' | 'all') {
  const comparisonIds = inventory.comparisons.filter(pair => pair.status === 'complete' &&
    (mode === 'all' || !analysisNarrativeIsCurrent(pair.state, pair.binding ? analysisHash(pair.binding) : null) && !active(pair.state))).map(pair => pair.id)
  const targetIds = inventory.targets.filter(target => target.binding.comparisons.some(pair => pair.status === 'complete') &&
    (mode === 'all' || comparisonIds.some(id => target.binding.comparisons.some(pair => pair.comparisonId === id)) ||
      !analysisNarrativeIsCurrent(target.state, analysisHash(target.binding)) && !active(target.state))).map(target => target.target.summary.id)
  return { comparisonIds, targetIds }
}
function verifyRequest(request: RealAnalysisNarrativeRequestRecord, input: GenerateRealAnalysisSummariesInput, actor: string, expected: string): void {
  if (request.mode !== input.mode || request.targetId !== (input.targetId ?? null) || request.requestedBy !== actor ||
    `"${request.scopeRevision}"` !== expected) throw conflict('This Idempotency-Key already identifies a different summary request or selected revision.')
}

export async function generateAnalysisSummaries(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, input: GenerateRealAnalysisSummariesInput,
  requestId: string, expected: string, actor: string, now: () => Date = () => new Date(),
  settings?: ProcessingSettingsProvider,
): Promise<RealAnalysisSummariesMutationResponse> {
  requireScope(workspaceId, runId, input.targetId)
  const parsed = generateAnalysisSummariesInputSchema.safeParse(input)
  if (!parsed.success || !isUuid(requestId) || !actor.trim() || actor.length > 200) throw invalidRequest('An exact summary mode, UUID request key, and authenticated actor are required.')
  if (!expected) throw preconditionRequired('If-Match must contain the current selected summary scope ETag.')
  if (!/^"[a-f0-9]{64}"$/.test(expected)) throw invalidRequest('If-Match must contain one exact quoted summary scope revision, not a run ETag.')
  requestId = requestId.toLowerCase()
  input = parsed.data
  if (await deps.blobs.read(analysisSummaryActionBlobName(workspaceId, runId, requestId))) {
    throw conflict('This Idempotency-Key already identifies a single-summary publication or retry.')
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    await assertAnalysisWorkspaceActive(deps.store, workspaceId)
    const existing = await receipt(deps.store, workspaceId, runId, requestId)
    const inventory = await readAnalysisNarrativeInventory(deps, workspaceId, runId, input.targetId)
    assertAnalysisRunWritable(inventory.run.record)
    if (!analysisNarrativeCanWork(inventory.run.record)) throw conflict('Finish cancelling the saved analysis before generating summaries.')
    if (existing) {
      verifyRequest(existing.record, input, actor, expected)
      return { requestId, scheduled: existing.record.scheduled, summaries: await readAnalysisSummaries(deps, workspaceId, runId, input.targetId) }
    }
    const name = analysisNarrativeRequestBlobName(workspaceId, runId, requestId)
    let winning = await deps.blobs.read(name)
    const processingSettings = winning ? undefined : await newWorkProcessingSettings(settings)
    if (processingSettings) assertNewWork(processingSettings, 'summaryGeneration')
    if (`"${inventory.revision}"` !== expected) throw conflict('The selected summary scope changed. Reload its summaries before starting a new request.')
    const selected = selectedForGeneration(inventory, input.mode)
    if (inventory.run.record.narrativeRequestId && selected.comparisonIds.length + selected.targetIds.length > 0) {
      const pending = await receipt(deps.store, workspaceId, runId, inventory.run.record.narrativeRequestId)
      if (pending && analysisNarrativeRequestCancelled(inventory.run.record, pending.record)) {
        await advanceAnalysisNarrativeRequest(deps, workspaceId, runId, pending.record.requestId, now)
        continue
      }
      throw conflict('An accepted summary request is still scheduling. Retry after its progress is visible.')
    }
    const timestamp = narrativeTimestamp(inventory.run.record, now().toISOString())
    const plan: RequestPlan = {
      schemaVersion: 1, workspaceId, runId, manifestSha256: inventory.run.record.manifest.sha256,
      requestId, requestedBy: actor, mode: input.mode, targetId: input.targetId ?? null,
      scopeRevision: inventory.revision, createdAt: timestamp, ...selected,
      processingSettings: processingSettings ? newProcessingSettings(settings, processingSettings) : undefined,
    }
    if (!winning) {
      try {
        winning = (await fencedAnalysisBlobs(deps, workspaceId, runId).putImmutable(name, Buffer.from(JSON.stringify(plan)), 'application/json')).blob
      } catch (error) {
        winning = await deps.blobs.read(name)
        if (!winning) throw error
      }
    }
    const winner = requestPlanSchema.parse(parseAnalysisJson(winning))
    if (winner.workspaceId !== workspaceId || winner.runId !== runId || winner.requestedBy !== actor ||
      winner.manifestSha256 !== plan.manifestSha256 || winner.requestId !== requestId ||
      winner.mode !== input.mode || winner.targetId !== (input.targetId ?? null) || winner.scopeRevision !== inventory.revision ||
      analysisHash(winner.comparisonIds) !== analysisHash(selected.comparisonIds) || analysisHash(winner.targetIds) !== analysisHash(selected.targetIds)) {
      throw conflict('This Idempotency-Key already reserved a different summary request.')
    }
    if (inventory.run.record.narrativeCancelledAt && winner.createdAt <= inventory.run.record.narrativeCancelledAt) {
      throw conflict('This reserved request predates cancellation. Reload the summaries and use a new request key.')
    }
    const reference = analysisBlobReference(name, winning)
    Object.assign(plan, winner)
    plan.processingSettings = winner.processingSettings
    const scheduled = { candidates: plan.comparisonIds.length, targets: plan.targetIds.length }
    const complete = scheduled.candidates + scheduled.targets === 0
    const record: RealAnalysisNarrativeRequestRecord = {
      id: analysisNarrativeId('request', runId, requestId), recordType: 'analysis-narrative-request',
      workspaceId, runId, dataKind: 'real', createdAt: plan.createdAt, updatedAt: plan.createdAt,
      manifestSha256: plan.manifestSha256, requestId, requestedBy: actor, mode: input.mode, targetId: input.targetId ?? null,
      scopeRevision: plan.scopeRevision, plan: reference, status: complete ? 'complete' : 'queued',
      nextIndex: 0, scheduled, attempts: 0, retryCount: 0,
      processingSettings: await admittedProcessingSettings(settings, plan.processingSettings),
    }
    const parent = { ...inventory.run.record, updatedAt: timestamp > plan.createdAt ? timestamp : plan.createdAt,
      ...(complete ? {} : { narrativeRequestId: requestId }) }
    try {
      await deps.store.transact(workspaceId, [
        { kind: 'create', record }, { kind: 'replace', record: parent, etag: inventory.run.etag },
      ])
      return { requestId, scheduled, summaries: await readAnalysisSummaries(deps, workspaceId, runId, input.targetId) }
    } catch (error) {
      const winning = await receipt(deps.store, workspaceId, runId, requestId)
      if (winning) {
        verifyRequest(winning.record, input, actor, expected)
        return { requestId, scheduled: winning.record.scheduled, summaries: await readAnalysisSummaries(deps, workspaceId, runId, input.targetId) }
      }
      if (!isConflict(error)) throw error
    }
  }
  throw conflict('The summary scope changed too often to accept this request. Reload and retry with the same request key.')
}

/** Materialize queued or cancelled generations in bounded transactions; never replay a finished receipt. */
export async function advanceAnalysisNarrativeRequest(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, requestId: string, now: () => Date = () => new Date(),
): Promise<boolean> {
  for (let race = 0; race < 8; race++) {
    const [run, current] = await Promise.all([
      loadAnalysisRun(deps.store, workspaceId, runId), receipt(deps.store, workspaceId, runId, requestId),
    ])
    if (!run || !current || !analysisNarrativeRequestCanAdvance(run.record, current.record)) return false
    const cancelled = analysisNarrativeRequestCancelled(run.record, current.record)
    const plan = await planFor(deps, run.record, current.record)
    const manifest = await readAnalysisManifest(deps.blobs, run.record)
    assertPlanScope(plan, manifest)
    const entries = [...plan.comparisonIds.map(id => ({ kind: 'candidate' as const, id })),
      ...plan.targetIds.map(id => ({ kind: 'target' as const, id }))]
    const timestamp = narrativeTimestamp(run.record, now().toISOString())
    const request = {
      requestId, requestedAt: timestamp, requestedBy: plan.requestedBy, reason: plan.mode,
      processingSettings: current.record.processingSettings ?? plan.processingSettings,
    }
    const operations: AnalysisTransaction[] = []
    let cursor = current.record.nextIndex
    let bytes = Buffer.byteLength(JSON.stringify(run.record)) + Buffer.byteLength(JSON.stringify(current.record)) + 8192
    for (; cursor < entries.length && operations.length < ANALYSIS_LIMITS.initializationChunkSize - 1; cursor++) {
      const entry = entries[cursor]
      let comparison: RealAnalysisComparisonRecord | undefined
      if (entry.kind === 'candidate') {
        const value = await deps.store.get(workspaceId, entry.id)
        assertAnalysis(value?.record.recordType === 'analysis-comparison' && value.record.status === 'complete',
          'Accepted candidate summary no longer has its immutable completed comparison.')
        comparison = (await resolveAnalysisComparison(deps.store, run.record, { record: value.record, etag: value.etag })).record
        assertComparisonManifestBinding(manifest, comparison)
      }
      const id = analysisNarrativeId(entry.kind, runId, entry.id, comparison?.resultRevision?.id)
      const previous = await loadAnalysisNarrative(deps.store, workspaceId, id)
      if (cancelled && previous && previous.record.requestedAt > run.record.narrativeCancelledAt!) continue
      let record: RealAnalysisNarrativeRecord
      if (entry.kind === 'candidate') {
        assertAnalysis(comparison, 'Candidate summary has no current comparison.')
        assertAnalysis(!previous || previous.record.recordType === 'analysis-candidate-narrative', 'Candidate work identity was replaced.')
        record = newCandidateNarrative(run.record, comparison, request,
          previous?.record.recordType === 'analysis-candidate-narrative' ? previous.record : undefined)
      } else {
        const target = manifest.targets.find(item => item.summary.id === entry.id)
        assertAnalysis(target && (!previous || previous.record.recordType === 'analysis-target-narrative'), 'Target work identity is not in the frozen manifest.')
        record = newTargetNarrative(run.record, target, request,
          previous?.record.recordType === 'analysis-target-narrative' ? previous.record : undefined)
      }
      if (previous?.record.generationId === record.generationId) continue
      if (cancelled) {
        record.status = 'cancelled'
        delete record.nextAttemptAt
        delete record.waitingFor
      }
      const operation: AnalysisTransaction = previous ? { kind: 'replace', record, etag: previous.etag } : { kind: 'create', record }
      const size = Buffer.byteLength(JSON.stringify(operation))
      if (bytes + size > MAX_ANALYSIS_TRANSACTION_BYTES) break
      operations.push(operation)
      bytes += size
    }
    assertAnalysis(cursor > current.record.nextIndex, 'Narrative scheduling cannot fit its bounded transaction.')
    const complete = cursor === entries.length
    const parent = { ...run.record, updatedAt: timestamp }
    if (complete) delete parent.narrativeRequestId
    operations.push(
      { kind: 'replace', record: { ...current.record, updatedAt: timestamp, nextIndex: cursor,
        status: complete ? cancelled ? 'cancelled' : 'complete' : 'queued' }, etag: current.etag },
      { kind: 'replace', record: parent, etag: run.etag },
    )
    try { await deps.store.transact(workspaceId, operations); return true } catch (error) {
      const saved = await receipt(deps.store, workspaceId, runId, requestId)
      if (saved && saved.record.nextIndex >= cursor) return true
      if (!isConflict(error)) throw error
    }
  }
  throw new StoreConflictError('Narrative scheduling changed too often; its durable cursor remains recoverable.')
}
