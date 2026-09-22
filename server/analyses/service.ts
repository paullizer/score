import { z } from 'zod'
import {
  ANALYSIS_LIMITS, type CreateRealAnalysisInput, type RetryRealAnalysisInput,
  type RealAnalysesPage, type RealAnalysisRunSummary, type RealAnalysisRunDetail, type RealAnalysisRunRecord,
  type RealAnalysisComparisonsPage, type RealAnalysisComparisonDetail, type RealAnalysisComparisonSummary,
  type RealAnalysisComparisonRecord, type RealAnalysisInitializationManifest, type RealAnalysisDocumentResponse,
  type VersionedAnalysisEntity, type AnalysisResumeSnapshotReference, type AnalysisTargetSnapshotReference,
} from '../../src/domain/real-analyses'
import { conflict, invalidRequest, notFound, preconditionRequired } from '../errors'
import { isUuid, parseDisplayNameMetadata } from '../jobs/validation'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { StoreConflictError, StoreNotFoundError } from '../store'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import {
  admittedProcessingSettings, newProcessingSettings, resolveAcceptedProcessingSettings,
  assertNewWork, currentProcessingSettings, newWorkProcessingSettings, type ProcessingSettingsProvider,
} from '../jobs/policy'
import { traceOperation } from '../telemetry-operations'
import type { AnalysisTransaction, RealAnalysesDeps } from './store'
import {
  analysisBytesHash, analysisCancellationNeedsRetry, analysisDeterministicId, analysisHash, analysisInputFingerprint,
  assertAnalysis, createAnalysisInputSchema, isAnalysisId, MAX_ANALYSIS_TRANSACTION_BYTES,
  parseAnalysisEntity, parseAnalysisInitializationManifest, retryAnalysisInputSchema,
  reportComparisonIdsSchema,
} from './validation'
import {
  analysisBlobReference, assertComparisonManifestBinding, parseAnalysisJson, putAnalysisJson, readAnalysisBlob,
  readAnalysisManifest, readAnalysisResult, readAnalysisSnapshots,
} from './snapshots'
import { RealAnalysisTargets, resolveAnalysisResume, copyAnalysisTargetEvidence, type AnalysisSourceDeps } from './targets'
import { analysisPageCursor, analysisPageToken, validateAnalysisPage } from './paging'
import { readAnalysisReportComparisons } from './reports'
import type { AnalysisReportCaptures } from './reports'
import type { AnalysisReportFormat, ReportSettingsCapture } from '../../src/domain/analysis-reports'
import type { WorkspaceRole } from '../../src/domain/cloud'
import { generateAnalysisSummaries, readAnalysisNarrativeInventory, readAnalysisSummaries, readAnalysisSummarySubject } from './narratives'
import type { GenerateRealAnalysisSummariesInput } from '../../src/domain/analysis-narratives'
import type { AnalysisSummarySubject, PublishSummaryDraftInput, RestartSummaryInput } from '../../src/domain/analysis-summary-history'
import { readAnalysisSummaryHistory } from './summary-history'
import { publishAnalysisSummaryDraft, restartAnalysisSummary, retryAnalysisSummary } from './summary-actions'
import { prepareAnalysisNarrativeTransitions } from './narrative-scheduling'
import { resolveAnalysisComparison, resolveAnalysisComparisons } from './current-results'
import { AnalysisCorrectionService } from './correction-actions'
import type { AnalysisCorrectionInput } from '../../src/domain/analysis-corrections'
import { readAnalysisFailureDiagnostics } from './diagnostics'
import {
  advanceAnalysisRun, applyAnalysisComparisonTransition, cancelAnalysisComparisonRecord, loadAnalysisComparison,
  loadAnalysisRun, retryAnalysisComparisonRecord,
} from './lifecycle'
import {
  analysisIsRemoved, assertAnalysisRunWritable, assertAnalysisWorkspaceActive, fencedAnalysisBlobs,
} from './guards'

export type { RealAnalysesDeps } from './store'
export { advanceAnalysisRun, applyAnalysisComparisonTransition } from './lifecycle'

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw invalidRequest(parsed.error.issues.slice(0, 12).map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '))
  return parsed.data
}
function requireScope(workspaceId: string, id?: string, kind: 'run' | 'comparison' = 'run'): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId) || (id !== undefined && !isAnalysisId(id, kind))) {
    throw notFound('The requested analysis was not found.')
  }
}
function requireMatch(actual: string, expected: string): void {
  if (!expected) throw preconditionRequired('An If-Match header with the current analysis record ETag is required.')
  if (typeof expected !== 'string' || expected.trim() !== expected || expected === '*' || expected.startsWith('W/') ||
    expected.length > 1024 || /[,\r\n]/.test(expected)) throw invalidRequest('If-Match must contain one exact ETag.')
  if (actual !== expected) throw conflict('This analysis record changed. Reload before retrying the action.')
}
function changeError(error: unknown): never {
  if (error instanceof StoreConflictError || error instanceof StoreNotFoundError) throw conflict('The analysis changed before this action could be saved. Reload and retry.')
  throw error
}
const runSummary = (value: VersionedAnalysisEntity<RealAnalysisRunRecord>): RealAnalysisRunSummary => ({
  run: value.record, etag: value.etag, ...(value.record.lifecycle ? { lifecycle: value.record.lifecycle } : {}),
})
const comparisonSummary = (value: VersionedAnalysisEntity<RealAnalysisComparisonRecord>): RealAnalysisComparisonSummary => ({ comparison: value.record, etag: value.etag })

export class RealAnalysisService {
  private readonly targets: RealAnalysisTargets
  private readonly clock: () => Date
  private readonly corrections: AnalysisCorrectionService

  constructor(
    private readonly deps: RealAnalysesDeps, private readonly sources: AnalysisSourceDeps = {}, now?: () => Date,
    private readonly settings?: ProcessingSettingsProvider,
  ) {
    this.targets = new RealAnalysisTargets(sources)
    this.clock = now ?? (() => new Date())
    this.corrections = new AnalysisCorrectionService(deps, this.clock, settings)
  }
  private now(): string { return this.clock().toISOString() }
  private async run(workspaceId: string, runId: string, recovery = false, signal?: AbortSignal) {
    requireScope(workspaceId, runId)
    const value = await loadAnalysisRun(this.deps.store, workspaceId, runId, signal)
    if (!value || value.record.lifecycle?.deletedAt || (!recovery && analysisIsRemoved(value.record.lifecycle))) {
      throw notFound('The requested analysis run was not found or is being permanently removed.')
    }
    return value
  }
  private async writable(workspaceId: string, run?: RealAnalysisRunRecord): Promise<void> {
    try {
      await assertAnalysisWorkspaceActive(this.deps.store, workspaceId)
      if (run) assertAnalysisRunWritable(run)
    } catch (error) { changeError(error) }
  }
  private async validateSelections(workspaceId: string, request: CreateRealAnalysisInput, runId: string): Promise<void> {
    assertWorkspaceMutationLease(workspaceId)
    const timestamp = this.now()
    for (const [index, selection] of request.resumes.entries()) {
      await resolveAnalysisResume(this.sources.resumes, workspaceId, selection, analysisDeterministicId('snapshot', runId, `resume:${index}`), timestamp)
    }
    for (const selection of request.targets) await this.targets.resolve(workspaceId, selection)
    assertWorkspaceMutationLease(workspaceId)
  }
  private async comparison(workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal) {
    requireScope(workspaceId, runId)
    requireScope(workspaceId, comparisonId, 'comparison')
    const value = await loadAnalysisComparison(this.deps.store, workspaceId, runId, comparisonId, signal)
    if (!value) throw notFound('The requested comparison was not found in this run.')
    return value
  }
  private async commit(workspaceId: string, operations: AnalysisTransaction[]): Promise<void> {
    const parent = operations.find(operation => operation.record.recordType === 'analysis-run')?.record
    assertAnalysis(parent?.recordType === 'analysis-run', 'Analysis action needs its run fence.')
    const transitions = []
    for (const operation of operations) if (operation.record.recordType === 'analysis-comparison' && operation.kind === 'replace') {
      const old = await loadAnalysisComparison(this.deps.store, workspaceId, parent.id, operation.record.id)
      if (!old || old.etag !== operation.etag) throw conflict('The comparison changed before this action could be saved. Reload and retry.')
      transitions.push({ previous: old.record, next: operation.record })
    }
    operations.push(...await prepareAnalysisNarrativeTransitions(this.deps.store, parent, transitions, parent.updatedAt))
    operations.forEach(operation => parseAnalysisEntity(operation.record))
    assertWorkspaceMutationLease(workspaceId)
    try { await this.deps.store.transact(workspaceId, operations) } catch (error) { changeError(error) }
  }
  async listTargets(workspaceId: string, continuationToken?: string, limit = 50) {
    requireScope(workspaceId)
    await this.writable(workspaceId)
    return this.targets.list(workspaceId, continuationToken, limit)
  }

  private winningManifest(
    value: unknown, workspaceId: string, runId: string, fingerprint: string, actor: string,
  ): RealAnalysisInitializationManifest {
    const manifest = parseAnalysisInitializationManifest(value)
    if (manifest.workspaceId !== workspaceId || manifest.runId !== runId ||
      manifest.inputFingerprint !== fingerprint || manifest.createdBy !== actor) {
      throw conflict('This idempotency key was already used for a different analysis request or creator.')
    }
    return manifest
  }
  private async prepare(
    workspaceId: string, runId: string, request: CreateRealAnalysisInput, actor: string, fingerprint: string,
  ) {
    const name = `${workspaceId}/${runId}/manifest.json`
    const blobs = fencedAnalysisBlobs(this.deps, workspaceId, runId)
    let blob = await this.deps.blobs.read(name)
    if (!blob) {
      const processingSettings = await newWorkProcessingSettings(this.settings)
      assertNewWork(processingSettings, 'newAnalyses')
      if (request.resumes.length * request.targets.length > processingSettings.settings.analyses.maxComparisons) {
        throw invalidRequest(`New analysis runs may contain at most ${processingSettings.settings.analyses.maxComparisons} resume/target comparisons.`)
      }
      const createdAt = this.now()
      const resumes: AnalysisResumeSnapshotReference[] = []
      const targets: AnalysisTargetSnapshotReference[] = []
      for (const [index, selection] of request.resumes.entries()) {
        const snapshotId = analysisDeterministicId('snapshot', runId, `resume:${index}`)
        const snapshot = await resolveAnalysisResume(this.sources.resumes, workspaceId, selection, snapshotId, createdAt)
        const hash = analysisBytesHash(Buffer.from(JSON.stringify(snapshot)))
        const reference = await putAnalysisJson(blobs, `${workspaceId}/${runId}/snapshots/${snapshotId}/${hash}.json`, snapshot)
        resumes.push({
          snapshotId, blob: reference, summary: {
            workspaceId, dataKind: 'real', selection, name: snapshot.resume.name, role: snapshot.resume.role,
            ...(snapshot.displayName !== undefined ? { displayName: snapshot.displayName } : {}),
            sourceLabel: snapshot.resume.sourceLabel, capturedAt: snapshot.capture.capturedAt,
          },
        })
      }
      for (const [index, selection] of request.targets.entries()) {
        const snapshotId = analysisDeterministicId('snapshot', runId, `target:${index}`)
        const resolved = await this.targets.resolve(workspaceId, selection)
        const snapshot = await copyAnalysisTargetEvidence(blobs, workspaceId, runId, resolved, snapshotId, createdAt)
        const hash = analysisBytesHash(Buffer.from(JSON.stringify(snapshot)))
        const reference = await putAnalysisJson(blobs, `${workspaceId}/${runId}/snapshots/${snapshotId}/${hash}.json`, snapshot)
        targets.push({ snapshotId, blob: reference, summary: snapshot.summary })
      }
      const manifest = parseAnalysisInitializationManifest({
        schemaVersion: 1, dataKind: 'real', workspaceId, runId, createdAt, createdBy: actor,
        processingSettings: newProcessingSettings(this.settings, processingSettings),
        inputFingerprint: fingerprint, request, resumes, targets,
        comparisons: resumes.flatMap((resume, resumeIndex) => targets.map((target, targetIndex) => {
          const index = resumeIndex * targets.length + targetIndex
          return { id: analysisDeterministicId('comparison', runId, index), index, resumeSnapshotId: resume.snapshotId, targetSnapshotId: target.snapshotId }
        })),
      })
      // The immutable manifest, not the latest source library, wins an ambiguous or competing publish.
      try {
        blob = (await blobs.putImmutable(name, Buffer.from(JSON.stringify(manifest)), 'application/json')).blob
      } catch (error) {
        blob = await this.deps.blobs.read(name)
        if (!blob) throw error
      }
    }
    const manifest = this.winningManifest(parseAnalysisJson(blob), workspaceId, runId, fingerprint, actor)
    return { manifest, reference: analysisBlobReference(name, blob) }
  }

  async create(workspaceId: string, key: string, request: CreateRealAnalysisInput, actor: string): Promise<RealAnalysisRunSummary> {
    requireScope(workspaceId)
    if (typeof key !== 'string' || !isUuid(key) || typeof actor !== 'string' || !actor.trim() || actor.length > 200) {
      throw invalidRequest('A UUID Idempotency-Key and authenticated creator are required.')
    }
    request = input(createAnalysisInputSchema, request)
    key = key.toLowerCase()
    const runId = `analysis-run-${key}`
    const fingerprint = analysisInputFingerprint(request)
    await this.writable(workspaceId)
    const control = await this.deps.store.getControl(workspaceId, runId)
    if (control && control.record.state !== 'active') throw conflict('This analysis key belongs to an archived or permanently removed run.')
    let current = await loadAnalysisRun(this.deps.store, workspaceId, runId)
    if (!current) {
      const prepared = await this.prepare(workspaceId, runId, request, actor, fingerprint)
      // Even an older unpublished manifest needs current intake authorization. It cannot resurrect deleted inputs.
      await this.validateSelections(workspaceId, prepared.manifest.request, runId)
      const timestamp = prepared.manifest.createdAt
      const record: RealAnalysisRunRecord = {
        id: runId, recordType: 'analysis-run', workspaceId, dataKind: 'real', name: prepared.manifest.request.name,
        createdAt: timestamp, updatedAt: timestamp, createdBy: prepared.manifest.createdBy, idempotencyKey: key,
        inputFingerprint: fingerprint, status: 'initializing', manifest: prepared.reference,
        processingSettings: await admittedProcessingSettings(this.settings, prepared.manifest.processingSettings),
        initialization: { nextComparisonIndex: 0 }, attempts: 0, retryCount: 0, nextAttemptAt: timestamp,
        progress: {
          total: prepared.manifest.comparisons.length, initialized: 0, queued: 0, running: 0,
          complete: 0, failed: 0, cancelled: 0, scored: 0, unscored: 0,
        },
      }
      parseAnalysisEntity(record)
      assertWorkspaceMutationLease(workspaceId)
      try { current = (await this.deps.store.create(record)).value } catch (error) {
        current = await loadAnalysisRun(this.deps.store, workspaceId, runId)
        if (!current) throw error
      }
    }
    if (current.record.inputFingerprint !== fingerprint || current.record.createdBy !== actor ||
      current.record.workspaceId !== workspaceId || current.record.id !== runId) {
      throw conflict('This idempotency key was already used for a different analysis request or creator.')
    }
    await this.writable(workspaceId, current.record)
    await readAnalysisManifest(this.deps.blobs, current.record)
    return runSummary(await advanceAnalysisRun(this.deps, workspaceId, runId, { now: this.clock }))
  }

  async list(workspaceId: string, continuationToken?: string, limit = 50): Promise<RealAnalysesPage> {
    requireScope(workspaceId)
    validateAnalysisPage(limit, continuationToken)
    const scope = { workspaceId, kind: 'runs' as const }
    const page = await this.deps.store.list(workspaceId, {
      recordType: 'analysis-run', limit, continuationToken: analysisPageCursor(scope, continuationToken),
    })
    assertAnalysis(page.items.length <= limit, 'Run page exceeds its limit.')
    const runs = await Promise.all(page.items.map(async value => {
      const record = parseAnalysisEntity(value.record)
      assertAnalysis(record.recordType === 'analysis-run' && record.workspaceId === workspaceId && value.etag, 'Run list returned foreign data.')
      const control = await this.deps.store.getControl(workspaceId, record.id)
      return { ...runSummary({ record, etag: value.etag }), ...(control?.record.operation ? { operation: control.record.operation } : {}) }
    }))
    return { runs, ...(page.continuationToken ? { continuationToken: analysisPageToken(scope, page.continuationToken) } : {}) }
  }
  async detail(workspaceId: string, runId: string): Promise<RealAnalysisRunDetail> {
    const value = await this.run(workspaceId, runId, true)
    const control = await this.deps.store.getControl(workspaceId, runId)
    const summary = { ...runSummary(value), ...(control?.record.operation ? { operation: control.record.operation } : {}) }
    if (analysisIsRemoved(value.record.lifecycle)) return { ...summary, resumes: [], targets: [] }
    const manifest = await readAnalysisManifest(this.deps.blobs, value.record)
    return { ...summary, resumes: manifest.resumes.map(item => item.summary), targets: manifest.targets.map(item => item.summary) }
  }
  async updateMetadata(workspaceId: string, runId: string, request: unknown, expected: string): Promise<RealAnalysisRunSummary> {
    const { displayName } = parseDisplayNameMetadata(request)
    const current = await this.run(workspaceId, runId)
    await this.writable(workspaceId, current.record)
    requireMatch(current.etag, expected)
    const record: RealAnalysisRunRecord = {
      ...current.record, displayName, updatedAt: [this.now(), current.record.updatedAt].sort().at(-1)!,
    }
    parseAnalysisEntity(record)
    assertWorkspaceMutationLease(workspaceId)
    try { return runSummary(await this.deps.store.replace(record, expected)) } catch (error) { changeError(error) }
  }
  async comparisons(workspaceId: string, runId: string, continuationToken?: string, limit = 50, signal?: AbortSignal): Promise<RealAnalysisComparisonsPage> {
    const run = await this.run(workspaceId, runId, false, signal)
    validateAnalysisPage(limit, continuationToken)
    const scope = { workspaceId, kind: 'comparisons' as const, runId }
    const [manifest, page] = await Promise.all([
      readAnalysisManifest(this.deps.blobs, run.record, signal),
      this.deps.store.list(workspaceId, { recordType: 'analysis-comparison', runId, limit, continuationToken: analysisPageCursor(scope, continuationToken), signal }),
    ])
    signal?.throwIfAborted()
    assertAnalysis(page.items.length <= limit, 'Comparison page exceeds its limit.')
    const resolved = await resolveAnalysisComparisons(this.deps.store, run.record, page.items, signal)
    const comparisons = resolved.map(value => {
      const record = parseAnalysisEntity(value.record)
      assertAnalysis(record.recordType === 'analysis-comparison' && value.etag, 'Invalid comparison page.')
      assertComparisonManifestBinding(manifest, record)
      return { comparison: record, etag: value.etag }
    })
    return { comparisons, ...(page.continuationToken ? { continuationToken: analysisPageToken(scope, page.continuationToken) } : {}) }
  }
  async comparisonDetail(workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal): Promise<RealAnalysisComparisonDetail> {
    return traceOperation('score.analysis.comparison', { 'score.comparison.count': 1 }, async () => {
      const [run, original] = await Promise.all([
        this.run(workspaceId, runId, false, signal), this.comparison(workspaceId, runId, comparisonId, signal),
      ])
      const comparison = await resolveAnalysisComparison(this.deps.store, run.record, original, signal)
      const snapshots = await traceOperation('score.analysis.snapshot.read', { 'score.comparison.count': 1 },
        () => readAnalysisSnapshots(this.deps.blobs, run.record, comparison.record, signal))
      const result = await traceOperation('score.analysis.result.read', { 'score.read.count': comparison.record.result ? 1 : 0 },
        () => readAnalysisResult(this.deps.blobs, run.record, comparison.record, snapshots, signal))
      await this.run(workspaceId, runId, false, signal)
      signal?.throwIfAborted()
      const workspace = await this.deps.store.getControl(workspaceId, undefined, signal)
      signal?.throwIfAborted()
      if (workspace && ['deleting', 'deleted'].includes(workspace.record.state)) throw notFound('The saved analysis is being removed.')
      return { ...comparisonSummary(comparison), ...snapshots, result }
    })
  }
  summaries(workspaceId: string, runId: string, targetId?: string, signal?: AbortSignal) {
    return readAnalysisSummaries(this.deps, workspaceId, runId, targetId, signal)
  }
  summarySubject(workspaceId: string, runId: string, subject: AnalysisSummarySubject, signal?: AbortSignal, resultRevisionId?: string) {
    return traceOperation(subject.kind === 'candidate' ? 'score.analysis.summary.candidate' : 'score.analysis.summary.target',
      { 'score.summary.kind': subject.kind }, () => readAnalysisSummarySubject(this.deps, workspaceId, runId, subject, signal, resultRevisionId))
  }
  correctionPreview(workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal) {
    return this.corrections.preview(workspaceId, runId, comparisonId, signal)
  }
  correctionState(workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal) {
    return this.corrections.state(workspaceId, runId, comparisonId, signal)
  }
  correctionHistory(workspaceId: string, runId: string, comparisonId: string, continuationToken?: string, signal?: AbortSignal) {
    return this.corrections.history(workspaceId, runId, comparisonId, continuationToken, signal)
  }
  requestCorrection(
    workspaceId: string, runId: string, comparisonId: string, input: AnalysisCorrectionInput, requestId: string, expected: string, actor: string,
  ) {
    return this.corrections.request(workspaceId, runId, comparisonId, input, requestId, expected, actor)
  }
  cancelCorrection(workspaceId: string, runId: string, comparisonId: string, expected: string) {
    return this.corrections.cancel(workspaceId, runId, comparisonId, expected)
  }
  generateSummaries(workspaceId: string, runId: string, input: GenerateRealAnalysisSummariesInput, requestId: string, expected: string, actor: string) {
    return generateAnalysisSummaries(this.deps, workspaceId, runId, input, requestId, expected, actor, this.clock, this.settings)
  }
  summaryHistory(
    workspaceId: string, runId: string, subject: AnalysisSummarySubject, continuationToken?: string,
    signal?: AbortSignal, resultRevisionId?: string, pageSize?: number,
  ) {
    return readAnalysisSummaryHistory(this.deps, workspaceId, runId, subject, continuationToken, signal, resultRevisionId, pageSize)
  }
  publishSummary(
    workspaceId: string, runId: string, subject: AnalysisSummarySubject, input: PublishSummaryDraftInput,
    requestId: string, expected: string, actor: string,
  ) {
    return publishAnalysisSummaryDraft(this.deps, workspaceId, runId, subject, input, requestId, expected, actor, this.clock, this.settings)
  }
  retrySummary(workspaceId: string, runId: string, subject: AnalysisSummarySubject, requestId: string, expected: string, actor: string) {
    return retryAnalysisSummary(this.deps, workspaceId, runId, subject, requestId, expected, actor, this.clock, this.settings)
  }
  restartSummary(
    workspaceId: string, runId: string, subject: AnalysisSummarySubject, input: RestartSummaryInput,
    requestId: string, expected: string, actor: string,
  ) {
    return restartAnalysisSummary(this.deps, workspaceId, runId, subject, input, requestId, expected, actor, this.clock, this.settings)
  }
  async diagnostics(workspaceId: string, runId: string, comparisonId: string, continuationToken?: string, signal?: AbortSignal) {
    const [run, comparison] = await Promise.all([
      this.run(workspaceId, runId, false, signal), this.comparison(workspaceId, runId, comparisonId, signal),
    ])
    const page = await readAnalysisFailureDiagnostics(this.deps.blobs, run.record, comparison.record, continuationToken, signal)
    await this.run(workspaceId, runId, false, signal)
    return page
  }
  async captureReport(
    captures: AnalysisReportCaptures, workspaceId: string, runId: string, actor: string, role: WorkspaceRole,
    format: AnalysisReportFormat, targetId?: string, signal?: AbortSignal,
  ) {
    const run = await this.run(workspaceId, runId, false, signal)
    const manifest = await readAnalysisManifest(this.deps.blobs, run.record, signal)
    const settings = await currentProcessingSettings(this.settings)
    signal?.throwIfAborted()
    return captures.capture(settings, role, actor, run.record, manifest, format, targetId)
  }
  async reportComparisons(
    workspaceId: string, runId: string, comparisonIds: string[], signal?: AbortSignal,
    settings?: ReportSettingsCapture, manifestSha256?: string,
  ) {
    comparisonIds = input(reportComparisonIdsSchema, comparisonIds)
    signal?.throwIfAborted()
    const run = await this.run(workspaceId, runId, false, signal)
    if (manifestSha256 !== undefined && manifestSha256 !== run.record.manifest.sha256) {
      throw conflict('This report capture does not match the saved analysis manifest.')
    }
    const comparisons: VersionedAnalysisEntity<RealAnalysisComparisonRecord>[] = []
    for (const id of comparisonIds) {
      signal?.throwIfAborted()
      comparisons.push(await this.comparison(workspaceId, runId, id, signal))
    }
    const current = await resolveAnalysisComparisons(this.deps.store, run.record, comparisons, signal)
    signal?.throwIfAborted()
    return readAnalysisReportComparisons(this.deps.blobs, run.record, current.map(value => value.record), signal, settings)
  }
  async document(
    workspaceId: string, runId: string, comparisonId: string, documentId: string, version: number, signal?: AbortSignal,
  ): Promise<RealAnalysisDocumentResponse> {
    if (typeof documentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(documentId) ||
      !Number.isInteger(version) || version < 1 || version > 1_000_000) throw invalidRequest('An exact document ID and positive version are required.')
    const [run, comparison] = await Promise.all([
      this.run(workspaceId, runId, false, signal), this.comparison(workspaceId, runId, comparisonId, signal),
    ])
    const { resumeSnapshot, targetSnapshot } = await readAnalysisSnapshots(this.deps.blobs, run.record, comparison.record, signal)
    const targetDocument = targetSnapshot.kind === 'job' ? targetSnapshot.document : targetSnapshot.seed.document
    const local = [resumeSnapshot.document, targetDocument].filter(item => item.id === documentId && item.version === version)
    const reference = targetSnapshot.kind === 'grade'
      ? targetSnapshot.references.find(item => item.document.documentId === documentId && item.document.documentVersion === version)
      : undefined
    // A GS seed and its normalized reference are the same captured source; a resume is not.
    if ((local.length > 1 && new Set(local.map(document => analysisHash(document))).size > 1) ||
      (reference && local.some(document => document !== targetDocument || reference.source.origin !== 'seed-job'))) {
      throw conflict('This document ID and version identify different frozen sources. Inspect the separate originals in the comparison detail.')
    }
    if (local[0]) return { document: local[0] }
    if (reference) {
      const blob = await readAnalysisBlob(this.deps.blobs, reference.document, workspaceId, runId, signal)
      return { document: parseAnalysisJson(blob) as RealAnalysisDocumentResponse['document'] }
    }
    throw notFound('This document version is not evidence for the requested comparison.')
  }

  async cancel(workspaceId: string, runId: string, actor: string, expected: string): Promise<RealAnalysisRunSummary> {
    const current = await this.run(workspaceId, runId)
    await this.writable(workspaceId, current.record)
    requireMatch(current.etag, expected)
    if (!actor.trim() || actor.length > 200) throw invalidRequest('An authenticated cancellation actor is required.')
    const p = current.record.progress
    if (p.initialized === p.total && p.queued + p.running === 0) {
      const inventory = await readAnalysisNarrativeInventory(this.deps, workspaceId, runId)
      const corrections = await Promise.all((['queued', 'running'] as const).map(status => this.deps.store.list(
        workspaceId, { recordType: 'analysis-correction', runId, status, limit: 1 },
      )))
      const active = [...inventory.comparisons, ...inventory.targets].some(item => ['waiting', 'queued', 'running'].includes(item.state.status)) ||
        corrections.some(page => page.items.length > 0)
      if (!active) throw conflict('This run has no active comparisons, corrections, or summaries to cancel. Completed results are immutable.')
      const timestamp = new Date(Math.max(Date.parse(this.now()), Date.parse(current.record.updatedAt))).toISOString()
      const updated = { ...current.record, updatedAt: timestamp, narrativeCancelledAt: timestamp }
      assertWorkspaceMutationLease(workspaceId)
      try { return runSummary(await this.deps.store.replace(updated, expected)) } catch (error) { changeError(error) }
    }
    if (!current.record.cancellation) {
      const timestamp = new Date(Math.max(Date.parse(this.now()), Date.parse(current.record.updatedAt))).toISOString()
      const updated: RealAnalysisRunRecord = {
        ...structuredClone(current.record), updatedAt: timestamp, status: 'cancelled', attempts: 0,
        cancellation: { requestedAt: timestamp, requestedBy: actor, nextComparisonIndex: 0 },
        narrativeCancelledAt: timestamp,
      }
      delete updated.lease
      delete updated.attemptId
      delete updated.nextAttemptAt
      delete updated.error
      parseAnalysisEntity(updated)
      assertWorkspaceMutationLease(workspaceId)
      try { await this.deps.store.replace(updated, expected) } catch (error) { changeError(error) }
    }
    return runSummary(await advanceAnalysisRun(this.deps, workspaceId, runId, { now: this.clock }))
  }

  async retry(workspaceId: string, runId: string, request: RetryRealAnalysisInput, expected: string): Promise<RealAnalysisRunSummary> {
    request = input(retryAnalysisInputSchema, request)
    let current = await this.run(workspaceId, runId)
    await this.writable(workspaceId, current.record)
    requireMatch(current.etag, expected)
    const timestamp = new Date(Math.max(Date.parse(this.now()), Date.parse(current.record.updatedAt))).toISOString()
    if (current.record.cancellation && !current.record.cancellation.completedAt) {
      if (request.comparisonIds || !analysisCancellationNeedsRetry(current.record) ||
        (current.record.lease && current.record.lease.expiresAt > timestamp)) {
        throw conflict('Cancellation is still finishing. Only a paused cancellation can be resumed, without selecting comparisons.')
      }
      const updated: RealAnalysisRunRecord = {
        ...structuredClone(current.record), updatedAt: timestamp, attempts: 0,
        processingSettings: await resolveAcceptedProcessingSettings(this.settings, current.record.processingSettings),
        retryCount: current.record.retryCount + 1, nextAttemptAt: timestamp,
      }
      delete updated.error
      delete updated.lease
      delete updated.attemptId
      parseAnalysisEntity(updated)
      assertWorkspaceMutationLease(workspaceId)
      try { await this.deps.store.replace(updated, expected) } catch (error) { changeError(error) }
      return runSummary(await advanceAnalysisRun(this.deps, workspaceId, runId, { now: this.clock }))
    }
    if (current.record.progress.initialized < current.record.progress.total) {
      if (current.record.status !== 'failed' || request.comparisonIds) throw conflict('Only interrupted initialization can be retried before all comparisons exist.')
      const manifest = await readAnalysisManifest(this.deps.blobs, current.record)
      await this.validateSelections(workspaceId, manifest.request, runId)
      const updated: RealAnalysisRunRecord = {
        ...structuredClone(current.record), status: 'initializing', updatedAt: timestamp, attempts: 0,
        processingSettings: await resolveAcceptedProcessingSettings(this.settings, current.record.processingSettings ?? manifest.processingSettings),
        retryCount: current.record.retryCount + 1, nextAttemptAt: timestamp,
      }
      delete updated.error
      delete updated.lease
      delete updated.completedAt
      assertWorkspaceMutationLease(workspaceId)
      try { await this.deps.store.replace(updated, expected) } catch (error) { changeError(error) }
      return runSummary(await advanceAnalysisRun(this.deps, workspaceId, runId, { now: this.clock }))
    }
    const manifest = await readAnalysisManifest(this.deps.blobs, current.record)
    const all: VersionedAnalysisEntity<RealAnalysisComparisonRecord>[] = []
    for (const pair of manifest.comparisons) {
      const value = await this.comparison(workspaceId, runId, pair.id)
      assertComparisonManifestBinding(manifest, value.record)
      all.push(value)
    }
    const selected = request.comparisonIds
      ? request.comparisonIds.map(id => {
        const value = all.find(item => item.record.id === id)
        if (!value) throw notFound('A requested comparison is not in this run.')
        return value
      })
      : all.filter(item => item.record.status === 'failed' || item.record.status === 'cancelled')
    if (!selected.length || selected.some(item => item.record.status !== 'failed' && item.record.status !== 'cancelled')) {
      throw conflict('Retry selects only failed or cancelled comparisons, never running or completed results.')
    }
    await this.validateSelections(workspaceId, {
      name: current.record.name,
      resumes: [...new Map(selected.map(item => [item.record.resume.snapshotId, item.record.resume.summary.selection])).values()],
      targets: [...new Map(selected.map(item => [item.record.target.snapshotId, item.record.target.summary.selection])).values()],
    }, runId)
    let offset = 0
    while (offset < selected.length) {
      const batchTimestamp = new Date(Math.max(Date.parse(timestamp), Date.parse(current.record.updatedAt))).toISOString()
      let updated = structuredClone(current.record)
      updated.processingSettings = await resolveAcceptedProcessingSettings(this.settings, updated.processingSettings ?? manifest.processingSettings)
      if (updated.cancellation && !updated.cancellation.completedAt) throw conflict('A new cancellation prevented this retry.')
      delete updated.cancellation
      delete updated.error
      delete updated.completedAt
      if (offset === 0) { updated.retryCount++; updated.attempts = 0 }
      const operations: AnalysisTransaction[] = []
      let bytes = 0
      while (offset < selected.length && operations.length < Math.floor(ANALYSIS_LIMITS.initializationChunkSize / 2)) {
        const previous = selected[offset]
        const next = retryAnalysisComparisonRecord({
          ...previous.record, processingSettings: await resolveAcceptedProcessingSettings(this.settings,
            previous.record.processingSettings ?? updated.processingSettings),
        }, batchTimestamp)
        const operation: AnalysisTransaction = { kind: 'replace', record: next, etag: previous.etag }
        const size = Buffer.byteLength(JSON.stringify(operation))
        if (bytes + size + Buffer.byteLength(JSON.stringify(updated)) + 64 * 1024 > MAX_ANALYSIS_TRANSACTION_BYTES) break
        updated = applyAnalysisComparisonTransition(updated, previous.record, next, batchTimestamp)
        operations.push(operation)
        bytes += size
        offset++
      }
      assertAnalysis(operations.length, 'Retry cannot fit the bounded transaction.')
      operations.push({ kind: 'replace', record: updated, etag: current.etag })
      await this.commit(workspaceId, operations)
      current = await this.run(workspaceId, runId)
      if (offset < selected.length && analysisHash(current.record) !== analysisHash(updated)) {
        throw conflict('The run changed during a bounded retry. Already-retried work was retained; reload to retry the remaining unfinished comparisons.')
      }
    }
    return runSummary(current)
  }

  async comparisonAction(
    workspaceId: string, runId: string, comparisonId: string, action: 'retry' | 'cancel', expected: string,
  ): Promise<RealAnalysisComparisonSummary> {
    const [run, comparison] = await Promise.all([this.run(workspaceId, runId), this.comparison(workspaceId, runId, comparisonId)])
    await this.writable(workspaceId, run.record)
    requireMatch(comparison.etag, expected)
    const manifest = await readAnalysisManifest(this.deps.blobs, run.record)
    assertComparisonManifestBinding(manifest, comparison.record)
    const timestamp = new Date(Math.max(Date.parse(this.now()), Date.parse(run.record.updatedAt), Date.parse(comparison.record.updatedAt))).toISOString()
    let parent = structuredClone(run.record)
    let updated: RealAnalysisComparisonRecord
    if (action === 'retry') {
      if (!['failed', 'cancelled'].includes(comparison.record.status) || parent.progress.initialized < parent.progress.total ||
        (parent.cancellation && !parent.cancellation.completedAt)) throw conflict('Only failed or cancelled comparisons in an initialized run can be retried.')
      await this.validateSelections(workspaceId, {
        name: run.record.name, resumes: [comparison.record.resume.summary.selection], targets: [comparison.record.target.summary.selection],
      }, runId)
      delete parent.cancellation
      delete parent.error
      delete parent.completedAt
      parent.retryCount++
      parent.processingSettings = await resolveAcceptedProcessingSettings(this.settings, parent.processingSettings ?? manifest.processingSettings)
      updated = retryAnalysisComparisonRecord({
        ...comparison.record, processingSettings: await resolveAcceptedProcessingSettings(this.settings,
          comparison.record.processingSettings ?? parent.processingSettings),
      }, timestamp)
    } else {
      if (!['queued', 'running'].includes(comparison.record.status)) throw conflict('Only queued or running comparisons can be cancelled. Completed evidence is immutable.')
      updated = cancelAnalysisComparisonRecord(comparison.record, timestamp)
    }
    parent = applyAnalysisComparisonTransition(parent, comparison.record, updated, timestamp)
    await this.commit(workspaceId, [
      { kind: 'replace', record: updated, etag: comparison.etag },
      { kind: 'replace', record: parent, etag: run.etag },
    ])
    return comparisonSummary(await this.comparison(workspaceId, runId, comparisonId))
  }
}
