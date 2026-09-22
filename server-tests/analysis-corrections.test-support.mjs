import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { api, clone, LATER } from './real-analyses.test-support.mjs'

export async function reviewedCorrection(context, mutate) {
  const { f, runId, comparisonId } = context
  const run = await api.loadAnalysisRun(f.analysis.store, f.workspaceId, runId)
  const head = await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId)
  assert.ok(head)
  const attemptId = randomUUID()
  const record = { ...head.record, status: 'running', attempts: head.record.attempts + 1, attemptId,
    lease: { owner: 'synthetic-correction-reviewer', heartbeatAt: f.now, expiresAt: LATER } }
  delete record.nextAttemptAt
  delete record.error
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record, etag: head.etag }, { kind: 'replace', record: run.record, etag: run.etag },
  ])
  const proposal = await api.readAnalysisCorrectionProposal(f.analysis.blobs, run.record, record)
  const original = (await f.analysis.store.get(f.workspaceId, comparisonId)).record
  const baseComparison = api.projectAnalysisComparison(original, record)
  const base = await api.readAnalysisResult(f.analysis.blobs, run.record, baseComparison)
  const assessment = clone(proposal.assessment)
  mutate?.(assessment)
  const hash = api.analysisAssessmentHash(assessment)
  const review = {
    id: `review-${randomUUID()}`, outcome: 'supported', issues: [], assessmentSha256: hash,
    resumeSnapshotSha256: record.resumeSnapshot.sha256, targetSnapshotSha256: record.targetSnapshot.sha256,
    provenance: { ...base.provenance.assessment, model: 'synthetic-independent-review', startedAt: f.now, completedAt: f.now },
    ...(record.policyVersion === api.ANALYSIS_CORRECTION_POLICY_VERSION ? { scope: {
      kind: 'evidence-gaps', baseAssessmentSha256: base.provenance.assessmentSha256,
      criterionIds: record.criterionIds,
      decisions: record.criterionIds.map(criterionId => ({
        criterionId, outcome: 'confirmed-missing', message: 'No supporting professional evidence occurs in the complete source.', citations: [],
      })),
    } } : {}),
  }
  const result = api.parseAnalysisResult({
    ...base, ...assessment, ...api.calculateAnalysisSummary(assessment.criteria, assessment.qualifications, assessment.limitations),
    createdAt: f.now, provenance: {
      ...base.provenance, attemptId, assessmentSha256: hash, groundingReviews: [review], correctionCount: 0,
      correction: proposal.provenance,
    },
  })
  const assertActive = async () => {
    const current = await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId)
    assert.equal(current.record.attemptId, attemptId)
    assert.equal(current.record.status, 'running')
  }
  const blobs = api.fencedAnalysisBlobs(f.analysis, f.workspaceId, runId, undefined, assertActive)
  const reference = await api.putAnalysisJson(blobs, api.analysisResultBlobName(f.workspaceId, runId, comparisonId, attemptId), result)
  const entry = {
    schemaVersion: 1, dataKind: 'real', id: attemptId, workspaceId: f.workspaceId, runId, comparisonId,
    requestId: record.requestId, attemptId, createdAt: f.now, outcome: 'ready', proposal: record.proposal, review, result: reference,
    ...(record.history ? { previous: record.history } : {}),
  }
  const historyBlob = await api.putAnalysisJson(blobs, api.analysisCorrectionHistoryBlobName(f.workspaceId, runId, comparisonId, record.requestId, attemptId), entry)
  const history = { id: attemptId, createdAt: f.now, blob: historyBlob }
  return {
    record, proposal, result, reference, history,
    publish: () => api.publishAnalysisCorrection(f.analysis, record, result, reference, history, new Date(f.now)),
  }
}
