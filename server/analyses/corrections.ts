import type {
  AnalysisCorrectionHistoryReference, AnalysisCorrectionProposal, AnalysisCorrectionSummary, RealAnalysisCorrectionRecord,
} from '../../src/domain/analysis-corrections'
import type {
  RealAnalysisComparisonRecord, RealAnalysisResult, RealAnalysisRunRecord, VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import type { ImmutableJsonBlobReference } from '../../src/domain/real-resumes'
import { StoreConflictError } from '../store'
import { assertAnalysisRunWritable, assertAnalysisWorkspaceActive } from './guards'
import { loadAnalysisComparison, loadAnalysisRun } from './lifecycle'
import { prepareAnalysisNarrativeTransitions } from './narrative-scheduling'
import { narrativeTimestamp } from './narrative-records'
import type { AnalysisBlobStore, RealAnalysesDeps } from './store'
import {
  analysisHash, assertAnalysis, assertAnalysisResultBinding, parseAnalysisEntity, parseAnalysisResult,
} from './validation'
import { parseAnalysisJson, readAnalysisBlob, readAnalysisResult, readAnalysisSnapshots } from './snapshots'
import {
  assertAnalysisCorrectionProposalBinding, assertEvidenceCorrectionAssessment,
  parseAnalysisCorrectionHistoryEntry, parseAnalysisCorrectionProposal,
} from './correction-validation'
import { analysisCorrectionCanWork, loadAnalysisCorrection, projectAnalysisComparison } from './current-results'

export { analysisCorrectionCanWork, loadAnalysisCorrection, projectAnalysisComparison, resolveAnalysisComparison } from './current-results'

function isConflict(error: unknown): boolean {
  return error instanceof StoreConflictError || error instanceof Error && error.name === 'StoreConflictError'
}

export function analysisCorrectionSummary(
  value: VersionedAnalysisEntity<RealAnalysisCorrectionRecord>, run?: RealAnalysisRunRecord,
): AnalysisCorrectionSummary {
  const { record, etag } = value
  const stopped = run && ['queued', 'running'].includes(record.status) &&
    (run.lifecycle?.archivedAt || run.lifecycle?.deletingAt || run.lifecycle?.deletedAt ||
      run.narrativeCancelledAt && record.requestedAt <= run.narrativeCancelledAt ||
      run.cancellation && !run.cancellation.completedAt)
  return {
    workspaceId: record.workspaceId, runId: record.runId, comparisonId: record.comparisonId, etag,
    status: stopped ? 'cancelled' : record.status, requestId: record.requestId,
    requestedAt: record.requestedAt, requestedBy: record.requestedBy, reason: record.reason,
    criterionIds: record.criterionIds, attempts: record.attempts,
    nextAttemptAt: stopped ? null : record.nextAttemptAt ?? null, error: record.error ?? null,
    revision: record.published?.revision ?? null, hasHistory: Boolean(record.history),
  }
}

export async function readAnalysisCorrectionProposal(
  blobs: Pick<AnalysisBlobStore, 'read'>, run: RealAnalysisRunRecord, record: RealAnalysisCorrectionRecord,
): Promise<AnalysisCorrectionProposal> {
  assertAnalysis(record.workspaceId === run.workspaceId && record.runId === run.id &&
    record.manifestSha256 === run.manifest.sha256, 'Correction proposal belongs to another run.')
  const proposal = parseAnalysisCorrectionProposal(parseAnalysisJson(await readAnalysisBlob(
    blobs, record.proposal, run.workspaceId, run.id,
  )))
  assertAnalysisCorrectionProposalBinding(proposal, record)
  return proposal
}

export function correctionBaseComparison(
  original: RealAnalysisComparisonRecord, proposal: AnalysisCorrectionProposal, base: RealAnalysisResult,
): RealAnalysisComparisonRecord {
  const comparison = { ...original }
  delete comparison.resultRevision
  return {
    ...comparison, result: proposal.baseResult, attemptId: proposal.baseAttemptId,
    completedAt: base.createdAt, updatedAt: base.createdAt,
    resultSummary: { completion: base.completion, overall: base.overall, coverage: base.coverage },
    ...(proposal.baseRevision ? { resultRevision: proposal.baseRevision } : {}),
  }
}

export async function publishAnalysisCorrection(
  deps: RealAnalysesDeps, claimed: RealAnalysisCorrectionRecord, result: RealAnalysisResult,
  reference: ImmutableJsonBlobReference, history: AnalysisCorrectionHistoryReference, now: Date, signal?: AbortSignal,
): Promise<void> {
  const started = performance.now()
  const activeNow = () => new Date(now.getTime() + performance.now() - started)
  signal?.throwIfAborted()
  parseAnalysisResult(result)
  const sameClaim = (record: RealAnalysisCorrectionRecord) => record.requestId === claimed.requestId &&
    record.requestFingerprint === claimed.requestFingerprint && record.attemptId === claimed.attemptId &&
    record.attempts === claimed.attempts && record.retryCount === claimed.retryCount
  for (let race = 0; race < 8; race++) {
    signal?.throwIfAborted()
    const [run, work, original] = await Promise.all([
      loadAnalysisRun(deps.store, claimed.workspaceId, claimed.runId),
      loadAnalysisCorrection(deps.store, claimed.workspaceId, claimed.runId, claimed.comparisonId),
      loadAnalysisComparison(deps.store, claimed.workspaceId, claimed.runId, claimed.comparisonId),
    ])
    if (!run || !work || !original || !sameClaim(work.record)) throw new StoreConflictError('This correction attempt was superseded.')
    if (work.record.status === 'ready' && work.record.published?.result.sha256 === reference.sha256 &&
      analysisHash(work.record.history) === analysisHash(history)) return
    if (!analysisCorrectionCanWork(run.record, work.record) || work.record.status !== 'running' ||
      !work.record.lease || work.record.lease.owner !== claimed.lease?.owner || work.record.lease.expiresAt <= activeNow().toISOString()) {
      throw new StoreConflictError('This correction no longer owns an active publication lease.')
    }
    await assertAnalysisWorkspaceActive(deps.store, claimed.workspaceId)
    assertAnalysisRunWritable(run.record)
    const before = projectAnalysisComparison(original.record, work.record)
    assertAnalysis(before.result?.sha256 === work.record.baseResult.sha256, 'Correction base is no longer the current result.')
    const proposal = await readAnalysisCorrectionProposal(deps.blobs, run.record, work.record)
    const snapshots = await readAnalysisSnapshots(deps.blobs, run.record, original.record)
    const base = await readAnalysisResult(deps.blobs, run.record, before, snapshots)
    assertAnalysis(base, 'Correction base result is unavailable.')
    assertEvidenceCorrectionAssessment(proposal, base, snapshots.targetSnapshot)
    assertAnalysis(analysisHash(result.provenance.assessment) === analysisHash(base.provenance.assessment) &&
      result.provenance.groundingReviews.every(review => review.provenance.startedAt >= claimed.requestedAt &&
        review.provenance.completedAt <= result.createdAt && !base.provenance.groundingReviews.some(old => old.id === review.id)),
    'A correction must retain original assessment attribution and obtain a fresh review after its explicit request.')
    assertAnalysis(analysisHash(result.provenance.correction) === analysisHash(proposal.provenance) &&
      analysisHash({ criteria: result.criteria, qualifications: result.qualifications, summary: result.summary, limitations: result.limitations }) ===
        analysisHash(proposal.assessment) &&
      result.provenance.attemptId === claimed.attemptId &&
      analysisHash({ completion: result.completion, overall: result.overall, coverage: result.coverage }) === analysisHash(proposal.summary),
    'Reviewed result differs from the accepted deterministic proposal.')
    const saved = parseAnalysisResult(parseAnalysisJson(await readAnalysisBlob(deps.blobs, reference, run.record.workspaceId, run.record.id)))
    assertAnalysis(analysisHash(saved) === analysisHash(result), 'Correction result bytes differ from the reviewed result.')
    const entry = parseAnalysisCorrectionHistoryEntry(parseAnalysisJson(await readAnalysisBlob(
      deps.blobs, history.blob, run.record.workspaceId, run.record.id,
    )))
    assertAnalysis(entry.id === history.id && entry.createdAt === history.createdAt &&
      entry.workspaceId === claimed.workspaceId && entry.runId === claimed.runId && entry.comparisonId === claimed.comparisonId &&
      entry.requestId === claimed.requestId && entry.attemptId === claimed.attemptId && entry.outcome === 'ready' &&
      entry.createdAt >= result.createdAt &&
      analysisHash(entry.result) === analysisHash(reference) && analysisHash(entry.proposal) === analysisHash(work.record.proposal) &&
      analysisHash(entry.review) === analysisHash(result.provenance.groundingReviews.at(-1)) &&
      analysisHash(entry.previous ?? null) === analysisHash(work.record.history ?? null),
    'Correction publication has no matching immutable review checkpoint.')
    const timestamp = narrativeTimestamp(run.record, [now.toISOString(), work.record.updatedAt, result.createdAt, history.createdAt].sort().at(-1)!)
    const record: RealAnalysisCorrectionRecord = {
      ...work.record, status: 'ready', updatedAt: timestamp, history,
      published: {
        result: reference, summary: proposal.summary, attemptId: result.provenance.attemptId,
        revision: {
          id: claimed.requestId, policyVersion: claimed.policyVersion, originalResultSha256: claimed.originalResult.sha256,
          baseResultSha256: claimed.baseResult.sha256, correctedAt: result.createdAt, criterionIds: claimed.criterionIds,
        },
      },
    }
    delete record.lease
    delete record.error
    delete record.nextAttemptAt
    const after = projectAnalysisComparison(original.record, record)
    assertAnalysisResultBinding(result, run.record, after, snapshots.resumeSnapshot, snapshots.targetSnapshot)
    const progress = { ...run.record.progress }
    progress[before.resultSummary!.overall.status === 'available' ? 'scored' : 'unscored']--
    progress[after.resultSummary!.overall.status === 'available' ? 'scored' : 'unscored']++
    const parent = { ...run.record, progress, updatedAt: timestamp }
    const narratives = await prepareAnalysisNarrativeTransitions(deps.store, parent, [{ previous: before, next: after }], timestamp)
    parseAnalysisEntity(record)
    parseAnalysisEntity(parent)
    signal?.throwIfAborted()
    if (work.record.lease.expiresAt <= activeNow().toISOString()) throw new StoreConflictError('The correction publication lease expired.')
    try {
      await deps.store.transact(claimed.workspaceId, [
        { kind: 'replace', record, etag: work.etag }, ...narratives,
        { kind: 'replace', record: parent, etag: run.etag },
      ])
      return
    } catch (error) {
      const latest = await loadAnalysisCorrection(deps.store, claimed.workspaceId, claimed.runId, claimed.comparisonId)
      if (latest && sameClaim(latest.record) && latest.record.status === 'ready' &&
        latest.record.published?.result.sha256 === reference.sha256 && analysisHash(latest.record.history) === analysisHash(history)) return
      if (!isConflict(error)) throw error
    }
  }
  throw new StoreConflictError('The run changed too often; the correction attempt remains recoverable.')
}
