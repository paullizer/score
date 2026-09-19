import { createHash } from 'node:crypto'

export const privateReviewReason = 'The quoted passage does not establish the requested scope. <b>Private fixture review reason</b>'

export function diagnosticFixture(detail, attemptId = 'fixture-failed-attempt', promptVersion = 'fixture-assessment-v3') {
  const { result, comparison } = detail
  const assessment = {
    criteria: structuredClone(result.criteria), qualifications: structuredClone(result.qualifications),
    summary: 'Private unpublished fixture draft; proposed judgments were not accepted.',
    limitations: structuredClone(result.limitations),
  }
  const assessmentSha256 = createHash('sha256').update(JSON.stringify(assessment)).digest('hex')
  const provenance = { ...result.provenance.assessment, promptVersion, schemaVersion: 'fixture-assessment-schema-v3' }
  const resumeSnapshot = { snapshotId: comparison.resume.snapshotId, sha256: comparison.resume.blob.sha256 }
  const targetSnapshot = { snapshotId: comparison.target.snapshotId, sha256: comparison.target.blob.sha256 }
  return {
    schemaVersion: 1, dataKind: 'real', workspaceId: comparison.workspaceId, runId: comparison.runId, comparisonId: comparison.id,
    attemptId, createdAt: result.createdAt, pipelineVersion: 'fixture-analysis-diagnostics-v1',
    manifestSha256: result.provenance.manifestSha256, resumeSnapshot, targetSnapshot,
    processingAttempt: 1, retryCount: 0, correctionCount: 2,
    error: { code: 'grounding-failed', stage: 'grounding', message: 'The independent grounding review did not accept the draft after two corrections.', retryable: false },
    reason: 'grounding-disagreement',
    events: [{ event: 'comparison-outcome', timestamp: result.createdAt, stage: 'grounding', attemptId, outcome: 'failed' }],
    omittedEvents: 0,
    assessments: Array.from({ length: 3 }, (_, correctionCount) => ({
      modelCallId: `fixture-call-${attemptId}-${correctionCount}`, correctionCount, assessmentSha256,
      assessment: structuredClone(assessment), provenance: structuredClone(provenance),
      review: {
        id: `fixture-review-${attemptId}-${correctionCount}`, assessmentSha256,
        resumeSnapshotSha256: resumeSnapshot.sha256, targetSnapshotSha256: targetSnapshot.sha256,
        provenance: { ...provenance, promptVersion: 'fixture-grounding-v3' }, outcome: 'needs-correction',
        issues: [
          { code: 'unsupported-rationale', message: privateReviewReason, criterionId: assessment.criteria[0].criterionId,
            citations: structuredClone(assessment.criteria[0].citations) },
          ...(assessment.qualifications[0] ? [{
            code: 'qualification-judgment', message: 'The draft qualification judgment is not supported by the saved passage.',
            qualificationId: assessment.qualifications[0].qualificationId, citations: [],
          }] : []),
        ],
      },
    })),
  }
}

export function diagnosticReference(diagnostic) {
  const json = JSON.stringify(diagnostic)
  return {
    attemptId: diagnostic.attemptId, createdAt: diagnostic.createdAt,
    blob: {
      blobName: `fixture/${diagnostic.runId}/${diagnostic.comparisonId}/${diagnostic.attemptId}.json`,
      contentType: 'application/json', bytes: Buffer.byteLength(json),
      sha256: createHash('sha256').update(json).digest('hex'),
    },
  }
}

export function failedComparisonFixture(detail, diagnostic = diagnosticFixture(detail)) {
  const failed = structuredClone(detail)
  failed.result = null
  delete failed.comparison.result
  delete failed.comparison.resultSummary
  delete failed.comparison.completedAt
  Object.assign(failed.comparison, {
    status: 'failed', attemptId: diagnostic.attemptId, attempts: diagnostic.processingAttempt, retryCount: diagnostic.retryCount,
    error: structuredClone(diagnostic.error), failureDiagnostic: diagnosticReference(diagnostic),
    diagnosticCapture: { attemptId: diagnostic.attemptId, status: 'saved', pipelineVersion: diagnostic.pipelineVersion },
  })
  failed.etag = '"fixture-failed-comparison"'
  return failed
}
