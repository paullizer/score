import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { api, citation, clone, LATER } from './real-analyses.test-support.mjs'

async function claimCorrection(context) {
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
  return { record, attemptId, proposal, base }
}

async function saveReviewedResult(context, { record, attemptId, proposal }, result) {
  const { f, runId, comparisonId } = context
  const review = result.provenance.groundingReviews.at(-1)
  const assertActive = async () => {
    const current = await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId)
    assert.equal(current.record.attemptId, attemptId)
    assert.equal(current.record.status, 'running')
  }
  const blobs = api.fencedAnalysisBlobs(f.analysis, f.workspaceId, runId, undefined, assertActive)
  const reference = await api.putAnalysisJson(blobs, api.analysisResultBlobName(f.workspaceId, runId, comparisonId, attemptId), result)
  const entry = {
    schemaVersion: 1, dataKind: 'real', id: attemptId, workspaceId: f.workspaceId, runId, comparisonId,
    requestId: record.requestId, attemptId, createdAt: result.createdAt, outcome: 'ready', proposal: record.proposal, review, result: reference,
    ...(record.history ? { previous: record.history } : {}),
  }
  const historyBlob = await api.putAnalysisJson(blobs, api.analysisCorrectionHistoryBlobName(f.workspaceId, runId, comparisonId, record.requestId, attemptId), entry)
  const history = { id: attemptId, createdAt: result.createdAt, blob: historyBlob }
  return {
    record, proposal, result, reference, history,
    publish: () => api.publishAnalysisCorrection(f.analysis, record, result, reference, history, new Date(f.now)),
  }
}

export async function reviewedCorrection(context, mutate) {
  const { f } = context
  const claimed = await claimCorrection(context)
  const { record, attemptId, proposal, base } = claimed
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
  return saveReviewedResult(context, claimed, result)
}

/**
 * Simulates the worker's full re-score: a fresh assessment of the same frozen inputs, reviewed after the request.
 * By default every previously unassessed criterion becomes partial 3/5 evidence (citing the frozen resume when the row had
 * no citation); `configure` may change the new assessment and `mutate` the unparsed result, e.g. to prove a stale or scoped
 * result cannot publish.
 */
export async function reassessedCorrection(context, { configure, mutate } = {}) {
  const { f, runId, comparisonId } = context
  const claimed = await claimCorrection(context)
  const { record, attemptId, proposal, base } = claimed
  assert.equal(record.policyVersion, api.ANALYSIS_REASSESSMENT_POLICY_VERSION)
  assert.equal(proposal.assessment, undefined)
  assert.equal(proposal.summary, undefined)
  const run = await api.loadAnalysisRun(f.analysis.store, f.workspaceId, runId)
  const comparison = (await f.analysis.store.get(f.workspaceId, comparisonId)).record
  const { resumeSnapshot } = await api.readAnalysisSnapshots(f.analysis.blobs, run.record, comparison)
  const at = [f.now, proposal.createdAt].sort().at(-1)
  const assessment = {
    criteria: base.criteria.map(row => {
      if (row.evidenceStatus !== 'not-assessed') return clone(row)
      const { limitation: _limitation, ...scored } = clone(row)
      return { ...scored, evidenceStatus: 'partial', score: 3,
        citations: scored.citations.length ? scored.citations : [citation(resumeSnapshot.document)],
        rationale: 'The full re-score found partial professional support for this requirement in the frozen source.' }
    }),
    qualifications: clone(base.qualifications), limitations: [],
    summary: 'A full re-score of the same frozen resume and target under the current processing rules.',
  }
  configure?.(assessment)
  const hash = api.analysisAssessmentHash(assessment)
  const assessmentProvenance = { ...base.provenance.assessment, promptVersion: 'synthetic-current-assessment', startedAt: at, completedAt: at }
  const review = {
    id: `review-${randomUUID()}`, outcome: 'supported', issues: [], assessmentSha256: hash,
    resumeSnapshotSha256: record.resumeSnapshot.sha256, targetSnapshotSha256: record.targetSnapshot.sha256,
    provenance: { ...assessmentProvenance, model: 'synthetic-independent-review', promptVersion: 'synthetic-current-grounding' },
  }
  const result = {
    ...base, ...assessment, ...api.calculateAnalysisSummary(assessment.criteria, assessment.qualifications, assessment.limitations),
    createdAt: at, provenance: {
      ...base.provenance, attemptId, assessment: assessmentProvenance, assessmentSha256: hash, groundingReviews: [review],
      correctionCount: 0, correction: proposal.provenance,
    },
  }
  mutate?.(result, base)
  return saveReviewedResult(context, claimed, api.parseAnalysisResult(result))
}
