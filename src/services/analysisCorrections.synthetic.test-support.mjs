import { createHash, randomUUID } from 'node:crypto'
import { analysisSummaryFixture, summaryTimestamp } from './analysisSummaries.test-support.mjs'

export const correctionTime = summaryTimestamp
export const correctionReason = 'Apply the reviewed missing-evidence policy without changing existing numeric scores or source evidence.'
export const correctionHash = value => createHash('sha256').update(value).digest('hex')
export const correctionLegacyPolicy = 'missing-evidence-zero-v1'
export const correctionPolicy = 'missing-evidence-zero-v2'
export const reassessmentPolicy = 'full-reassessment-v1'
export const correctionEvidence = {
  documentId: 'resume-document', documentVersion: 1, paragraphId: 'resume-p1',
  page: 1, heading: 'Experience', quote: 'Applied engineering methods independently.',
}
export const correctionBefore = {
  completion: 'limited',
  overall: { status: 'withheld', score: null, reason: 'no-assessable-weight', message: 'The professional criterion was not assessed in this synthetic result.' },
  coverage: { totalCriteria: 1, supported: 0, partial: 0, missing: 0, notAssessed: 1, notApplicable: 0, assessedWeight: 0, totalWeight: 100 },
}
export const correctionAfter = {
  completion: 'assessed', overall: { status: 'available', score: 0 },
  coverage: { totalCriteria: 1, supported: 0, partial: 0, missing: 1, notAssessed: 0, notApplicable: 0, assessedWeight: 100, totalWeight: 100 },
}

export function correctionFixture({ withheld = 1, numeric = 1, failed = 1, archived = false } = {}) {
  const base = analysisSummaryFixture({ archived })
  const template = base.details[0]
  const targets = [base.targets[0]]
  const details = Array.from({ length: withheld + numeric + failed }, (_, index) => {
    const detail = structuredClone(template)
    const pair = detail.comparison
    pair.id = `synthetic-comparison-${index + 1}`
    pair.index = index
    pair.resume.summary.name = `Synthetic source ${index + 1}`
    pair.resume.summary.sourceLabel = `synthetic-source-${index + 1}.pdf`
    pair.result.sha256 = correctionHash(`${pair.id}:original`)
    detail.etag = `"synthetic-original-${index + 1}"`
    detail.result.comparisonId = pair.id
    const withheldResult = index < withheld
    const summary = structuredClone(withheldResult ? correctionBefore : correctionAfter)
    Object.assign(detail.result, summary)
    pair.resultSummary = structuredClone(summary)
    detail.result.criteria[0] = {
      ...detail.result.criteria[0], evidenceStatus: withheldResult ? 'not-assessed' : 'missing',
      score: withheldResult ? null : 0, citations: [], rationale: 'The reviewed synthetic source does not document the required professional practice.',
      ...(withheldResult ? { limitation: {
        code: 'sparse-source', message: 'The reviewed source contains no evidence of the required professional practice.', criterionId: 'criterion-one',
      } } : {}),
    }
    detail.result.limitations = withheldResult ? [detail.result.criteria[0].limitation] : []
    if (index >= withheld + numeric) {
      pair.status = 'failed'
      pair.error = { code: 'snapshot-invalid', stage: 'assessment', message: 'Synthetic unreadable source.', retryable: false }
      delete pair.result
      delete pair.resultSummary
      detail.result = null
    }
    return detail
  })
  const progress = {
    total: details.length, initialized: details.length, queued: 0, running: 0, complete: withheld + numeric,
    failed, cancelled: 0, scored: numeric, unscored: withheld,
  }
  const summary = structuredClone(base.summary)
  summary.run.name = 'Synthetic correction review'
  summary.run.progress = progress
  summary.run.initialization.nextComparisonIndex = details.length
  return { ...base, targets, details, summary, detail: { ...summary, targets, resumes: details.map(item => item.comparison.resume.summary) } }
}

export function correctionSummary(fixture, comparisonId, options = {}) {
  const pair = fixture.details.find(item => item.comparison.id === comparisonId).comparison
  const status = options.status ?? 'queued'
  const requestId = options.requestId ?? randomUUID()
  return {
    workspaceId: pair.workspaceId, runId: pair.runId, comparisonId, etag: `"correction-${requestId}-${status}"`,
    status, requestId, requestedAt: correctionTime, requestedBy: 'synthetic-editor',
    reason: options.reason ?? correctionReason, criterionIds: ['criterion-one'],
    ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }),
    attempts: status === 'queued' ? 0 : 1, nextAttemptAt: null,
    error: status === 'failed' ? {
      code: 'grounding-failed', stage: 'grounding', message: 'Synthetic independent reviewer retained a genuine interpretation blocker.', retryable: false,
    } : null,
    revision: status === 'ready' ? {
      id: requestId, policyVersion: options.policyVersion ?? correctionLegacyPolicy,
      originalResultSha256: options.originalHash ?? pair.result.sha256,
      baseResultSha256: options.baseHash ?? pair.result.sha256,
      correctedAt: correctionTime, criterionIds: ['criterion-one'],
    } : null,
    hasHistory: ['ready', 'failed', 'cancelled'].includes(status),
  }
}

export function correctionPreview(fixture, comparisonId, {
  correction = null, blocked = false, policyVersion = correctionLegacyPolicy, reassessment,
} = {}) {
  const detail = fixture.details.find(item => item.comparison.id === comparisonId)
  const withheld = detail.comparison.resultSummary.overall.status === 'withheld'
  return {
    dataKind: 'real', workspaceId: fixture.workspaceId, runId: detail.comparison.runId, comparisonId,
    etag: correction?.etag ?? detail.etag, resultSha256: detail.comparison.result.sha256,
    originalResultSha256: correction?.revision?.originalResultSha256 ?? detail.comparison.result.sha256,
    policyVersion,
    before: structuredClone(detail.comparison.resultSummary), after: blocked || !withheld ? null : structuredClone(correctionAfter),
    criterionIds: blocked || !withheld ? [] : ['criterion-one'],
    criteria: withheld ? [{
      criterionId: 'criterion-one', label: 'Synthetic professional practice', weight: 100,
      rationale: 'No supporting professional evidence was located in the readable synthetic source.',
      limitation: { code: blocked ? 'source-quality' : 'sparse-source', message: blocked ? 'Synthetic unreadable passage.' : 'Supporting evidence was absent.', criterionId: 'criterion-one' },
      eligible: !blocked, blockedReason: blocked ? 'A genuine source-quality blocker must remain unscored.' : null,
    }] : [],
    reassessment: reassessment ?? (withheld
      ? { policyVersion: reassessmentPolicy, eligible: true, blockedReason: null, criterionIds: ['criterion-one'] }
      : { policyVersion: reassessmentPolicy, eligible: false, blockedReason: 'Only a comparison whose total is withheld can be re-scored in place.', criterionIds: [] }),
    correction,
  }
}

export function correctionGapReview(decisions = [{
  criterionId: 'criterion-one', outcome: 'blocked', blockerCode: 'ambiguous-guidance',
  message: 'The synthetic requirement needs human interpretation.', citations: [],
}]) {
  const issues = decisions.filter(decision => decision.outcome !== 'confirmed-missing').map(decision => ({
    code: decision.outcome === 'evidence-found' ? 'omitted-evidence'
      : decision.blockerCode === 'restricted-personal-characteristic' ? 'prohibited-inference' : 'insufficient-context',
    criterionId: decision.criterionId, message: decision.message, citations: structuredClone(decision.citations),
  }))
  return {
    outcome: issues.length ? 'needs-correction' : 'supported', issues,
    scope: {
      kind: 'evidence-gaps', baseAssessmentSha256: correctionHash('synthetic-base-assessment'),
      criterionIds: decisions.map(decision => decision.criterionId), decisions: structuredClone(decisions),
    },
  }
}

export function correctionHistory(fixture, comparisonId, {
  status = 'failed', correction, requestId = randomUUID(), policyVersion, decisions,
} = {}) {
  const detail = fixture.details.find(item => item.comparison.id === comparisonId)
  const summary = correction ?? correctionSummary(fixture, comparisonId, { status, requestId, policyVersion })
  const policy = summary.policyVersion ?? summary.revision?.policyVersion ?? correctionLegacyPolicy
  const scoped = policy === correctionPolicy
  const reassessed = policy === reassessmentPolicy
  const ready = summary.status === 'ready'
  return {
    dataKind: 'real', workspaceId: fixture.workspaceId, runId: detail.comparison.runId, comparisonId,
    originalResultSha256: summary.revision?.originalResultSha256 ?? detail.comparison.result.sha256,
    original: structuredClone(correctionBefore),
    originalAssessment: {
      criteria: structuredClone(detail.result.criteria),
      qualifications: structuredClone(detail.result.qualifications),
      summary: detail.result.summary, limitations: structuredClone(detail.result.limitations),
    },
    correction: summary,
    entries: [{
      id: randomUUID(), createdAt: correctionTime, requestId: summary.requestId, outcome: summary.status, policyVersion: policy,
      requestedBy: summary.requestedBy, reason: summary.reason, criterionIds: ['criterion-one'],
      beforeResultSha256: summary.revision?.baseResultSha256 ?? detail.comparison.result.sha256,
      after: reassessed && !ready ? null : structuredClone(correctionAfter),
      review: scoped ? correctionGapReview(decisions ?? (ready ? [{
        criterionId: 'criterion-one', outcome: 'confirmed-missing',
        message: 'The selected criterion has no supporting professional evidence in the readable saved source.', citations: [],
      }] : undefined)) : {
        outcome: ready ? 'supported' : 'needs-correction',
        issues: ready ? [] : [{
          code: 'interpretation-blocker', message: 'The synthetic requirement needs human interpretation.', criterionId: 'criterion-one', citations: [],
        }],
      },
      error: summary.error, resultSha256: ready ? correctionHash(`${comparisonId}:published`) : null,
    }],
  }
}

export function publishCorrectionFixture(fixture, correction) {
  const detail = fixture.details.find(item => item.comparison.id === correction.comparisonId)
  const result = detail.result
  const previous = result.criteria[0]
  const { limitation: _limitation, ...criterion } = previous
  result.criteria[0] = { ...criterion, evidenceStatus: 'missing', score: 0, citations: [], rationale: 'No supporting evidence in the reviewed source. This is not a claim about personal ability.' }
  Object.assign(result, structuredClone(correctionAfter))
  result.limitations = []
  result.provenance.correction = {
    requestId: correction.requestId, policyVersion: correction.revision.policyVersion,
    originalResultSha256: correction.revision.originalResultSha256, baseResultSha256: correction.revision.baseResultSha256,
    baseAssessmentSha256: correctionHash('synthetic-base-assessment'), criterionIds: ['criterion-one'],
    requestedBy: correction.requestedBy, requestedAt: correction.requestedAt, reason: correction.reason,
  }
  if (correction.revision.policyVersion === correctionPolicy) result.provenance.groundingReviews.push({
    ...correctionGapReview([{
      criterionId: 'criterion-one', outcome: 'confirmed-missing',
      message: 'The selected criterion has no supporting professional evidence in the readable saved source.', citations: [],
    }]),
    id: `gap-review-${correction.requestId}`, assessmentSha256: result.provenance.assessmentSha256,
    resumeSnapshotSha256: result.provenance.resumeSnapshot.sha256,
    targetSnapshotSha256: result.provenance.targetSnapshot.sha256,
    provenance: { ...result.provenance.assessment, promptVersion: 'synthetic-evidence-gap-review-v2' },
  })
  detail.comparison.resultSummary = structuredClone(correctionAfter)
  detail.comparison.resultRevision = structuredClone(correction.revision)
  detail.comparison.result.sha256 = correctionHash(`${correction.comparisonId}:published`)
  detail.etag = `"current-${correction.requestId}"`
  fixture.summary.etag = `"run-${correction.requestId}"`
  fixture.summary.run.progress.scored++
  fixture.summary.run.progress.unscored--
}
