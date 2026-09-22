import {
  ANALYSIS_CORRECTION_LIMITS, type AnalysisCorrectionPublication, type RealAnalysisCorrectionRecord,
} from '../../src/domain/analysis-corrections'
import {
  ANALYSIS_LIMITS, type RealAnalysisComparisonRecord, type RealAnalysisRunRecord, type VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import { invalidRequest, notFound } from '../errors'
import { isUuid } from '../jobs/validation'
import { readAnalysisCorrectionHistoryEntry } from './correction-artifacts'
import { assertCorrectionReviewBinding, parseAnalysisCorrectionProposal } from './correction-validation'
import { parseAnalysisJson, readAnalysisBlob } from './snapshots'
import type { AnalysisStore, RealAnalysesDeps } from './store'
import { analysisCorrectionId, analysisHash, assertAnalysis, parseAnalysisEntity, parseAnalysisResult } from './validation'

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
  return comparisonWithPublication(original, correction.published)
}

function comparisonWithPublication(
  original: RealAnalysisComparisonRecord, publication: AnalysisCorrectionPublication,
): RealAnalysisComparisonRecord {
  const { result, summary, revision, attemptId } = publication
  const projected: RealAnalysisComparisonRecord = {
    ...original, result, resultSummary: summary, attemptId, completedAt: revision.correctedAt,
    updatedAt: revision.correctedAt, resultRevision: revision,
  }
  parseAnalysisEntity(projected)
  return projected
}

export async function resolveAnalysisComparisonRevision(
  deps: RealAnalysesDeps, run: RealAnalysisRunRecord, original: VersionedAnalysisEntity<RealAnalysisComparisonRecord>,
  revisionId: string, signal?: AbortSignal,
): Promise<VersionedAnalysisEntity<RealAnalysisComparisonRecord>> {
  signal?.throwIfAborted()
  if (revisionId !== 'original' && !isUuid(revisionId)) throw invalidRequest('Select the original result or one exact published correction revision.')
  if (original.record.status !== 'complete' || !original.record.result) throw notFound('This comparison has no completed assessment history.')
  if (revisionId === 'original') return original
  const head = await loadAnalysisCorrection(deps.store, run.workspaceId, run.id, original.record.id, signal)
  if (!head) throw notFound('The requested published correction revision was not found.')
  assertAnalysis(head.record.manifestSha256 === run.manifest.sha256, 'Correction belongs to another frozen manifest.')
  projectAnalysisComparison(original.record, head.record)
  const version = (publication: AnalysisCorrectionPublication) => ({
    record: comparisonWithPublication(original.record, publication),
    etag: `"${analysisHash({ original: original.etag, revision: publication })}"`,
  })
  if (head.record.published?.revision.id === revisionId) return version(head.record.published)
  let reference = head.record.history, bytes = 0
  const seen = new Set<string>()
  while (reference) {
    signal?.throwIfAborted()
    assertAnalysis(!seen.has(reference.id) && seen.size < ANALYSIS_CORRECTION_LIMITS.maxHistoryEntries &&
      (bytes += reference.blob.bytes) <= 128 * 1024 * 1024, 'Published correction history exceeds its bounded read.')
    seen.add(reference.id)
    const entry = await readAnalysisCorrectionHistoryEntry(deps.blobs, run.workspaceId, run.id, original.record.id, reference, signal)
    reference = entry.previous
    if (entry.outcome !== 'ready' || entry.requestId !== revisionId) continue
    assertAnalysis(entry.result && entry.attemptId && entry.review?.outcome === 'supported', 'Published correction history has no reviewed result.')
    assertAnalysis(bytes + entry.result.bytes + entry.proposal.bytes <= 128 * 1024 * 1024, 'Historical result exceeds its bounded read.')
    const [proposalBytes, resultBytes] = await Promise.all([
      readAnalysisBlob(deps.blobs, entry.proposal, run.workspaceId, run.id, signal),
      readAnalysisBlob(deps.blobs, entry.result, run.workspaceId, run.id, signal),
    ])
    const proposal = parseAnalysisCorrectionProposal(parseAnalysisJson(proposalBytes))
    const result = parseAnalysisResult(parseAnalysisJson(resultBytes))
    assertCorrectionReviewBinding(entry.review, proposal)
    assertAnalysis(proposal.workspaceId === run.workspaceId && proposal.runId === run.id &&
      proposal.comparisonId === original.record.id && proposal.requestId === revisionId &&
      proposal.manifestSha256 === run.manifest.sha256 && proposal.originalResultSha256 === original.record.result.sha256 &&
      analysisHash(proposal.resumeSnapshot) === analysisHash(head.record.resumeSnapshot) &&
      analysisHash(proposal.targetSnapshot) === analysisHash(head.record.targetSnapshot) &&
      result.workspaceId === run.workspaceId && result.runId === run.id && result.comparisonId === original.record.id &&
      result.provenance.attemptId === entry.attemptId && result.provenance.manifestSha256 === run.manifest.sha256 &&
      analysisHash(result.provenance.resumeSnapshot) === analysisHash(proposal.resumeSnapshot) &&
      analysisHash(result.provenance.targetSnapshot) === analysisHash(proposal.targetSnapshot) &&
      analysisHash(result.provenance.correction) === analysisHash(proposal.provenance) &&
      analysisHash(result.provenance.groundingReviews.at(-1)) === analysisHash(entry.review) &&
      analysisHash({ criteria: result.criteria, qualifications: result.qualifications, summary: result.summary, limitations: result.limitations }) ===
        analysisHash(proposal.assessment) &&
      analysisHash({ completion: result.completion, overall: result.overall, coverage: result.coverage }) === analysisHash(proposal.summary),
    'Historical correction result is not bound to its reviewed proposal and original frozen inputs.')
    return version({
      result: entry.result, summary: proposal.summary, attemptId: entry.attemptId,
      revision: {
        id: revisionId, policyVersion: proposal.provenance.policyVersion, originalResultSha256: proposal.originalResultSha256,
        baseResultSha256: proposal.baseResult.sha256, correctedAt: result.createdAt, criterionIds: proposal.provenance.criterionIds,
      },
    })
  }
  throw notFound('The requested correction did not publish an assessment revision.')
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
