import type { RealAnalysisCorrectionRecord } from '../../src/domain/analysis-corrections'
import {
  ANALYSIS_LIMITS, type RealAnalysisComparisonRecord, type RealAnalysisRunRecord, type VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import type { AnalysisStore } from './store'
import { analysisCorrectionId, analysisHash, assertAnalysis, parseAnalysisEntity } from './validation'

export function analysisCorrectionCanWork(run: RealAnalysisRunRecord, record?: RealAnalysisCorrectionRecord): boolean {
  return !run.lifecycle?.archivedAt && !run.lifecycle?.deletingAt && !run.lifecycle?.deletedAt &&
    (!run.cancellation || Boolean(run.cancellation.completedAt)) && !run.narrativeRequestId &&
    (!record || !run.narrativeCancelledAt || record.requestedAt > run.narrativeCancelledAt)
}

export async function loadAnalysisCorrection(
  store: AnalysisStore, workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal,
): Promise<VersionedAnalysisEntity<RealAnalysisCorrectionRecord> | undefined> {
  const id = analysisCorrectionId(runId, comparisonId)
  signal?.throwIfAborted()
  const value = await store.get(workspaceId, id, signal)
  signal?.throwIfAborted()
  if (!value) return undefined
  const record = parseAnalysisEntity(value.record)
  assertAnalysis(record.recordType === 'analysis-correction' && record.workspaceId === workspaceId &&
    record.runId === runId && record.comparisonId === comparisonId && record.id === id && value.etag,
  'Correction lookup returned foreign metadata.')
  return { record, etag: value.etag }
}

export function projectAnalysisComparison(
  original: RealAnalysisComparisonRecord, correction?: RealAnalysisCorrectionRecord,
): RealAnalysisComparisonRecord {
  assertAnalysis(!original.resultRevision, 'Current results must resolve from the original persisted comparison.')
  if (!correction) return original
  parseAnalysisEntity(correction)
  assertAnalysis(original.status === 'complete' && original.result && correction.workspaceId === original.workspaceId &&
    correction.runId === original.runId && correction.comparisonId === original.id &&
    analysisHash(correction.originalResult) === analysisHash(original.result) &&
    correction.resumeSnapshot.snapshotId === original.resume.snapshotId &&
    correction.resumeSnapshot.sha256 === original.resume.blob.sha256 &&
    correction.targetSnapshot.snapshotId === original.target.snapshotId &&
    correction.targetSnapshot.sha256 === original.target.blob.sha256,
  'Correction is not bound to this immutable completed comparison.')
  if (!correction.published) return original
  const { result, summary, revision, attemptId } = correction.published
  const projected: RealAnalysisComparisonRecord = {
    ...original, result, resultSummary: summary, attemptId, completedAt: revision.correctedAt,
    updatedAt: revision.correctedAt, resultRevision: revision,
  }
  parseAnalysisEntity(projected)
  return projected
}

export async function resolveAnalysisComparison(
  store: AnalysisStore, run: RealAnalysisRunRecord, original: VersionedAnalysisEntity<RealAnalysisComparisonRecord>, signal?: AbortSignal,
): Promise<VersionedAnalysisEntity<RealAnalysisComparisonRecord>> {
  signal?.throwIfAborted()
  if (original.record.status !== 'complete') return original
  const correction = await loadAnalysisCorrection(store, run.workspaceId, run.id, original.record.id, signal)
  assertAnalysis(!correction || correction.record.manifestSha256 === run.manifest.sha256,
    'Correction belongs to another frozen manifest.')
  return {
    record: projectAnalysisComparison(original.record, correction?.record),
    etag: correction?.record.published ? `"${analysisHash({ original: original.etag, revision: correction.record.published })}"` : original.etag,
  }
}

export async function resolveAnalysisComparisons(
  store: AnalysisStore, run: RealAnalysisRunRecord, originals: VersionedAnalysisEntity<RealAnalysisComparisonRecord>[], signal?: AbortSignal,
): Promise<VersionedAnalysisEntity<RealAnalysisComparisonRecord>[]> {
  signal?.throwIfAborted()
  if (!originals.some(value => value.record.status === 'complete')) return originals
  const heads = new Map<string, RealAnalysisCorrectionRecord>()
  const tokens = new Set<string>()
  let continuationToken: string | undefined
  do {
    signal?.throwIfAborted()
    const page = await store.list(run.workspaceId, { recordType: 'analysis-correction', runId: run.id, limit: 100, continuationToken, signal })
    signal?.throwIfAborted()
    for (const value of page.items) {
      const record = parseAnalysisEntity(value.record)
      assertAnalysis(record.recordType === 'analysis-correction' && record.workspaceId === run.workspaceId &&
        record.runId === run.id && record.manifestSha256 === run.manifest.sha256 && !heads.has(record.comparisonId),
      'Current-result inventory contains foreign or duplicate correction heads.')
      heads.set(record.comparisonId, record)
    }
    assertAnalysis(heads.size <= ANALYSIS_LIMITS.maxComparisons, 'Correction heads exceed the frozen comparison bound.')
    continuationToken = page.continuationToken
    if (continuationToken) {
      assertAnalysis(!tokens.has(continuationToken), 'Correction inventory did not advance.')
      tokens.add(continuationToken)
    }
  } while (continuationToken)
  return originals.map(original => {
    const correction = heads.get(original.record.id)
    return {
      record: projectAnalysisComparison(original.record, correction),
      etag: correction?.published ? `"${analysisHash({ original: original.etag, revision: correction.published })}"` : original.etag,
    }
  })
}
