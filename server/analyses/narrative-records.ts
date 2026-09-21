import type {
  AnalysisCandidateNarrativeInputBinding, AnalysisNarrativeCurrentState, AnalysisNarrativeGenerationReason,
  AnalysisNarrativePublicationReference, RealAnalysisCandidateNarrativeRecord, RealAnalysisNarrativeRecord,
  RealAnalysisTargetNarrativeRecord,
} from '../../src/domain/analysis-narratives'
import { analysisNarrativeIsCurrent } from '../../src/domain/analysis-narratives'
import type {
  AnalysisTargetSnapshotReference, RealAnalysisComparisonRecord, RealAnalysisNarrativeRequestRecord, RealAnalysisRunRecord,
} from '../../src/domain/real-analyses'
import { analysisHash, analysisNarrativeId, assertAnalysis } from './validation'

export function analysisNarrativeCanWork(
  run: RealAnalysisRunRecord, record?: RealAnalysisNarrativeRecord | RealAnalysisNarrativeRequestRecord,
): boolean {
  return !run.lifecycle?.archivedAt && !run.lifecycle?.deletingAt && !run.lifecycle?.deletedAt &&
    (!run.cancellation || Boolean(run.cancellation.completedAt)) &&
    (!record || !run.narrativeCancelledAt ||
      (record.recordType === 'analysis-narrative-request' ? record.createdAt : record.requestedAt) > run.narrativeCancelledAt)
}

export function analysisNarrativeRequestCancelled(run: RealAnalysisRunRecord, record: RealAnalysisNarrativeRequestRecord): boolean {
  return Boolean(run.narrativeCancelledAt && record.createdAt <= run.narrativeCancelledAt)
}

export function analysisNarrativeRequestCanAdvance(run: RealAnalysisRunRecord, record: RealAnalysisNarrativeRequestRecord): boolean {
  return !run.lifecycle?.deletingAt && !run.lifecycle?.deletedAt && record.status === 'queued' &&
    run.narrativeRequestId === record.requestId &&
    (analysisNarrativeCanWork(run, record) || analysisNarrativeRequestCancelled(run, record))
}

export function narrativeTimestamp(run: RealAnalysisRunRecord, now: string): string {
  return new Date(Math.max(Date.parse(now), Date.parse(run.updatedAt),
    run.narrativeCancelledAt ? Date.parse(run.narrativeCancelledAt) + 1 : 0)).toISOString()
}

export function narrativeGenerationId(requestId: string, recordId: string): string {
  const hex = analysisHash({ requestId, recordId }).slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function candidateNarrativeBinding(
  run: RealAnalysisRunRecord, comparison: RealAnalysisComparisonRecord,
): AnalysisCandidateNarrativeInputBinding {
  assertAnalysis(comparison.status === 'complete' && comparison.result &&
    comparison.workspaceId === run.workspaceId && comparison.runId === run.id, 'Candidate narrative requires this exact completed result.')
  return {
    kind: 'candidate', workspaceId: run.workspaceId, runId: run.id, manifestSha256: run.manifest.sha256,
    targetId: comparison.target.summary.id,
    targetSnapshot: { snapshotId: comparison.target.snapshotId, sha256: comparison.target.blob.sha256 },
    comparisonId: comparison.id,
    resumeSnapshot: { snapshotId: comparison.resume.snapshotId, sha256: comparison.resume.blob.sha256 },
    resultSha256: comparison.result.sha256,
  }
}

export function narrativePublicationVersion(publication: AnalysisNarrativePublicationReference) {
  return {
    revision: publication.revision, inputFingerprint: publication.inputFingerprint,
    generationId: publication.generationId, publishedAt: publication.publishedAt,
  }
}

export function narrativeCurrentState(
  run: RealAnalysisRunRecord, record: RealAnalysisNarrativeRecord | undefined, expected: string | null,
): AnalysisNarrativeCurrentState {
  if (!record) return { status: 'missing', generationId: null, inputFingerprint: expected, published: null }
  const state: AnalysisNarrativeCurrentState = {
    status: record.status, generationId: record.generationId, inputFingerprint: record.inputFingerprint,
    published: record.published ? narrativePublicationVersion(record.published) : null,
  }
  if (record.status === 'ready' && !analysisNarrativeIsCurrent(state, expected)) state.status = 'stale'
  else if (['queued', 'running', 'waiting'].includes(record.status) &&
    (run.narrativeCancelledAt && record.requestedAt <= run.narrativeCancelledAt ||
      run.lifecycle?.archivedAt || run.lifecycle?.deletingAt || run.lifecycle?.deletedAt ||
      run.cancellation && !run.cancellation.completedAt)) state.status = 'cancelled'
  else if (record.inputFingerprint !== null && record.inputFingerprint !== expected &&
    !['failed', 'cancelled'].includes(record.status)) state.status = 'stale'
  return state
}

export interface NarrativeRequestIdentity {
  requestId: string
  requestedAt: string
  requestedBy: string | null
  reason: AnalysisNarrativeGenerationReason
}

export function newCandidateNarrative(
  run: RealAnalysisRunRecord, comparison: RealAnalysisComparisonRecord, request: NarrativeRequestIdentity,
  previous?: RealAnalysisCandidateNarrativeRecord,
): RealAnalysisCandidateNarrativeRecord {
  request = { ...request, requestedAt: request.requestedAt < (previous?.updatedAt ?? '') ? previous!.updatedAt : request.requestedAt }
  const binding = candidateNarrativeBinding(run, comparison)
  const id = analysisNarrativeId('candidate', run.id, comparison.id, comparison.resultRevision?.id)
  assertAnalysis(!previous || previous.id === id && previous.resultSha256 === comparison.result?.sha256,
    'A new result revision requires its own narrative history.')
  return {
    workspaceId: binding.workspaceId, runId: binding.runId, manifestSha256: binding.manifestSha256,
    targetId: binding.targetId, targetSnapshot: binding.targetSnapshot, comparisonId: binding.comparisonId,
    resumeSnapshot: binding.resumeSnapshot, resultSha256: binding.resultSha256,
    ...(comparison.resultRevision ? { resultRevisionId: comparison.resultRevision.id } : {}),
    id, recordType: 'analysis-candidate-narrative', schemaVersion: 1, dataKind: 'real',
    createdAt: previous?.createdAt ?? request.requestedAt, updatedAt: request.requestedAt,
    ...request, generationId: narrativeGenerationId(request.requestId, id), status: 'queued',
    inputFingerprint: analysisHash(binding), attempts: 0, retryCount: previous ? previous.retryCount + 1 : 0,
    nextAttemptAt: request.requestedAt, ...(previous?.published ? { published: previous.published } : {}),
    ...(previous?.history ? { history: previous.history } : {}),
  }
}

export function newTargetNarrative(
  run: RealAnalysisRunRecord, target: AnalysisTargetSnapshotReference, request: NarrativeRequestIdentity,
  previous?: RealAnalysisTargetNarrativeRecord,
): RealAnalysisTargetNarrativeRecord {
  request = { ...request, requestedAt: request.requestedAt < (previous?.updatedAt ?? '') ? previous!.updatedAt : request.requestedAt }
  const id = analysisNarrativeId('target', run.id, target.summary.id)
  return {
    id, recordType: 'analysis-target-narrative', schemaVersion: 1, dataKind: 'real', workspaceId: run.workspaceId,
    runId: run.id, manifestSha256: run.manifest.sha256, targetId: target.summary.id,
    targetSnapshot: { snapshotId: target.snapshotId, sha256: target.blob.sha256 },
    createdAt: previous?.createdAt ?? request.requestedAt, updatedAt: request.requestedAt,
    ...request, generationId: narrativeGenerationId(request.requestId, id),
    status: 'waiting', inputFingerprint: null, waitingFor: 'scoring', attempts: 0,
    retryCount: previous ? previous.retryCount + 1 : 0, nextAttemptAt: request.requestedAt,
    ...(previous?.published ? { published: previous.published } : {}),
    ...(previous?.history ? { history: previous.history } : {}),
  }
}
