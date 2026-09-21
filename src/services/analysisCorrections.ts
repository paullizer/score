import { z } from 'zod'
import {
  ANALYSIS_CORRECTION_LIMITS, ANALYSIS_CORRECTION_POLICY_VERSION,
  type AnalysisCorrectionHistoryPage, type AnalysisCorrectionInput, type AnalysisCorrectionPreview,
  type AnalysisCorrectionResponse, type AnalysisCorrectionSummary,
} from '../domain/analysis-corrections'
import type { RealAnalysisAssessmentOutput, RealAnalysisResultSummary, RealCriterionResult } from '../domain/real-analyses'
import { cloudJsonRequest } from './cloudWorkspace'

const id = z.string().min(1).max(1024).refine(value => value === value.trim())
const text = z.string().min(1).max(16_000)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const etag = z.string().max(1024).regex(/^"[\x21\x23-\x7e]+"$/)
const timestamp = z.string().datetime({ offset: true })
const count = z.number().int().min(0).max(ANALYSIS_CORRECTION_LIMITS.maxCriteria)
const weight = z.number().min(0).max(100)
const criterionIds = z.array(id).max(ANALYSIS_CORRECTION_LIMITS.maxCriteria)
  .refine(values => new Set(values).size === values.length)
const selectedCriteria = criterionIds.refine(values => values.length > 0)
const savedReason = z.string().min(1).max(1000).refine(value => value.trim().length > 0)
const reason = z.string().min(10).max(1000).refine(value => value === value.trim())
const processingError = z.object({
  code: z.enum(['invalid-input', 'stale-input', 'snapshot-unavailable', 'snapshot-invalid', 'context-limit',
    'invalid-model-output', 'invalid-citation', 'grounding-failed', 'service-unavailable', 'storage-error', 'timeout', 'internal-error']),
  stage: z.enum(['initialization', 'assessment', 'grounding', 'publication']),
  message: text, retryable: z.boolean(),
})
const limitation = z.object({
  code: z.enum(['sparse-source', 'not-assessable', 'context-limit', 'source-quality']),
  message: text, criterionId: id.optional(), qualificationId: id.optional(),
})
const citation = z.object({
  documentId: id, documentVersion: z.number().int().positive(), paragraphId: id,
  page: z.number().int().positive(), heading: z.string().max(16_000), quote: text,
})
const criterionBase = z.object({ criterionId: id, weight, rationale: text, requirementCitations: z.array(citation).max(100) })
const criterionResult: z.ZodType<RealCriterionResult> = z.discriminatedUnion('evidenceStatus', [
  criterionBase.extend({
    evidenceStatus: z.enum(['supported', 'partial']),
    score: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    citations: z.tuple([citation]).rest(citation).refine(values => values.length <= 100),
  }),
  criterionBase.extend({ evidenceStatus: z.literal('missing'), score: z.literal(0), citations: z.tuple([]) }),
  criterionBase.extend({ evidenceStatus: z.literal('not-assessed'), score: z.null(), citations: z.array(citation).max(100), limitation }),
  criterionBase.extend({ evidenceStatus: z.literal('not-applicable'), weight: z.literal(0), score: z.null(), citations: z.tuple([]) }),
])
const originalAssessment: z.ZodType<RealAnalysisAssessmentOutput> = z.object({
  criteria: z.array(criterionResult).min(1).max(ANALYSIS_CORRECTION_LIMITS.maxCriteria),
  qualifications: z.array(z.object({
    qualificationId: id, evidenceStatus: z.enum(['supported', 'partial', 'missing', 'not-assessed']),
    rationale: text, citations: z.array(citation).max(100), requirementCitations: z.array(citation).max(100),
    limitation: limitation.optional(),
  })).max(50),
  summary: text, limitations: z.array(limitation).max(100),
}).refine(value => new Set(value.criteria.map(item => item.criterionId)).size === value.criteria.length &&
  new Set(value.qualifications.map(item => item.qualificationId)).size === value.qualifications.length)
const review = z.object({
  outcome: z.enum(['supported', 'needs-correction', 'unsupported']),
  issues: z.array(z.object({
    code: id, message: text, criterionId: id.optional(), qualificationId: id.optional(),
    citations: z.array(citation).max(100),
  })).max(100),
})
const resultSummary: z.ZodType<RealAnalysisResultSummary> = z.object({
  completion: z.enum(['assessed', 'limited']),
  overall: z.discriminatedUnion('status', [
    z.object({ status: z.literal('available'), score: z.number().min(0).max(100) }),
    z.object({
      status: z.literal('withheld'), score: z.null(),
      reason: z.enum(['unassessed-weighted-criteria', 'no-assessable-weight']), message: text,
    }),
  ]),
  coverage: z.object({
    totalCriteria: count, supported: count, partial: count, missing: count, notAssessed: count, notApplicable: count,
    assessedWeight: weight, totalWeight: weight,
  }),
}).refine(({ completion, overall, coverage }) =>
  coverage.supported + coverage.partial + coverage.missing + coverage.notAssessed + coverage.notApplicable === coverage.totalCriteria &&
  coverage.assessedWeight <= coverage.totalWeight &&
  (overall.status !== 'withheld' || completion === 'limited') &&
  (overall.status !== 'withheld' || (overall.reason === 'no-assessable-weight'
    ? coverage.assessedWeight === 0 : coverage.assessedWeight > 0 && coverage.notAssessed > 0)) &&
  (overall.status !== 'available' || coverage.assessedWeight > 0))
const revision = z.object({
  id, policyVersion: z.literal(ANALYSIS_CORRECTION_POLICY_VERSION),
  originalResultSha256: hash, baseResultSha256: hash, correctedAt: timestamp, criterionIds: selectedCriteria,
})
const correctionSchema: z.ZodType<AnalysisCorrectionSummary> = z.object({
  workspaceId: id, runId: id, comparisonId: id, etag,
  status: z.enum(['queued', 'running', 'ready', 'failed', 'cancelled']),
  requestId: z.uuid(), requestedAt: timestamp, requestedBy: id, reason: savedReason,
  criterionIds: selectedCriteria, attempts: z.number().int().min(0), nextAttemptAt: timestamp.nullable(),
  error: processingError.nullable(), revision: revision.nullable(), hasHistory: z.boolean(),
}).refine(value => (value.status !== 'failed' || value.error !== null) &&
  (value.status !== 'ready' || (value.revision !== null && value.error === null &&
    value.revision.id === value.requestId && sameCriteria(value.revision.criterionIds, value.criterionIds))))
const previewSchema: z.ZodType<AnalysisCorrectionPreview> = z.object({
  dataKind: z.literal('real'), workspaceId: id, runId: id, comparisonId: id, etag,
  resultSha256: hash, originalResultSha256: hash, policyVersion: z.literal(ANALYSIS_CORRECTION_POLICY_VERSION),
  before: resultSummary, after: resultSummary.nullable(), criterionIds,
  criteria: z.array(z.object({
    criterionId: id, label: text, weight, rationale: text, limitation,
    eligible: z.boolean(), blockedReason: text.nullable(),
  })).max(ANALYSIS_CORRECTION_LIMITS.maxCriteria),
  correction: correctionSchema.nullable(),
})
const historySchema: z.ZodType<AnalysisCorrectionHistoryPage> = z.object({
  dataKind: z.literal('real'), workspaceId: id, runId: id, comparisonId: id,
  originalResultSha256: hash, original: resultSummary, originalAssessment, correction: correctionSchema.nullable(),
  entries: z.array(z.object({
    id, createdAt: timestamp, requestId: z.uuid(), outcome: z.enum(['ready', 'failed', 'cancelled']),
    requestedBy: id, reason: savedReason, criterionIds: selectedCriteria, beforeResultSha256: hash,
    after: resultSummary, review: review.nullable(), error: processingError.nullable(), resultSha256: hash.nullable(),
  })).max(ANALYSIS_CORRECTION_LIMITS.historyPageSize),
  continuationToken: z.string().min(1).max(16 * 1024).optional(),
})
const inputSchema: z.ZodType<AnalysisCorrectionInput> = z.object({ resultSha256: hash, criterionIds: selectedCriteria, reason })
const responseSchema = z.object({ requestId: z.uuid(), correction: correctionSchema })

interface Scope { workspaceId: string; runId: string; comparisonId: string }

function path(scope: Scope): string {
  if (!Object.values(scope).every(value => id.safeParse(value).success)) {
    throw new Error('Select one exact saved workspace, analysis, and comparison before reviewing corrections.')
  }
  return `/workspaces/${encodeURIComponent(scope.workspaceId)}/analyses/${encodeURIComponent(scope.runId)}/comparisons/${encodeURIComponent(scope.comparisonId)}/corrections`
}

function sameScope(value: Scope, expected: Scope): boolean {
  return value.workspaceId === expected.workspaceId && value.runId === expected.runId && value.comparisonId === expected.comparisonId
}

function sameCriteria(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}

function checkedCorrection(value: AnalysisCorrectionSummary | null, scope: Scope, originalHash?: string): void {
  if (value && (!sameScope(value, scope) ||
    (originalHash && value.revision && value.revision.originalResultSha256 !== originalHash))) {
    throw new Error('The correction service returned mismatched workspace, analysis, comparison, or original-result information.')
  }
}

function concurrency(value: string): Record<string, string> {
  if (!etag.safeParse(value).success) throw new Error('Reload and review the correction preview before continuing. A saved correction ETag is required.')
  return { 'If-Match': value }
}

export async function getAnalysisCorrectionPreview(
  workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal, expectedOriginalSha256?: string,
): Promise<AnalysisCorrectionPreview> {
  const scope = { workspaceId, runId, comparisonId }
  const payload = await cloudJsonRequest<unknown>(`${path(scope)}/preview`, { method: 'GET', signal })
  signal?.throwIfAborted()
  const parsed = previewSchema.safeParse(payload)
  if (!parsed.success) throw new Error('The correction service returned an invalid preview. No correction has been requested.')
  const value = parsed.data
  checkedCorrection(value.correction, scope, value.originalResultSha256)
  if (!sameScope(value, scope) ||
    (expectedOriginalSha256 !== undefined && value.originalResultSha256 !== expectedOriginalSha256) ||
    (!value.correction?.revision && value.resultSha256 !== value.originalResultSha256) ||
    (value.correction && value.etag !== value.correction.etag) ||
    new Set(value.criteria.map(item => item.criterionId)).size !== value.criteria.length ||
    value.criteria.length !== value.before.coverage.notAssessed ||
    !sameCriteria(value.criterionIds, value.criteria.filter(item => item.eligible).map(item => item.criterionId)) ||
    value.criteria.some(item => item.eligible ? item.blockedReason !== null || item.weight <= 0 ||
      ['source-quality', 'context-limit'].includes(item.limitation.code) : !item.blockedReason) ||
    (value.criterionIds.length > 0) !== (value.after !== null) ||
    (value.after && (value.before.overall.status !== 'withheld' ||
      value.after.coverage.totalCriteria !== value.before.coverage.totalCriteria ||
      value.after.coverage.totalWeight !== value.before.coverage.totalWeight ||
      value.after.coverage.supported !== value.before.coverage.supported ||
      value.after.coverage.partial !== value.before.coverage.partial ||
      value.after.coverage.notApplicable !== value.before.coverage.notApplicable ||
      value.after.coverage.missing !== value.before.coverage.missing + value.criterionIds.length ||
      value.after.coverage.notAssessed !== value.before.coverage.notAssessed - value.criterionIds.length ||
      (value.after.overall.status === 'available' && value.criteria.some(item => !item.eligible && item.weight > 0))))) {
    throw new Error('The correction service returned mismatched preview identities, criteria, ETag, or score coverage. Reload before continuing.')
  }
  return value
}

export async function getAnalysisCorrection(
  workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal, expectedOriginalSha256?: string,
): Promise<AnalysisCorrectionSummary | null> {
  const scope = { workspaceId, runId, comparisonId }
  const payload = await cloudJsonRequest<unknown>(path(scope), { method: 'GET', signal })
  signal?.throwIfAborted()
  const parsed = z.object({ correction: correctionSchema.nullable() }).safeParse(payload)
  if (!parsed.success) throw new Error('The correction service returned an invalid status. Publication has not been confirmed.')
  checkedCorrection(parsed.data.correction, scope, expectedOriginalSha256)
  return parsed.data.correction
}

export async function getAnalysisCorrectionHistory(
  workspaceId: string, runId: string, comparisonId: string, continuationToken?: string, signal?: AbortSignal, expectedOriginalSha256?: string,
): Promise<AnalysisCorrectionHistoryPage> {
  const scope = { workspaceId, runId, comparisonId }
  if (continuationToken !== undefined && (!continuationToken || continuationToken.length > 16 * 1024)) {
    throw new Error('The correction history cursor is invalid. Reopen the latest history.')
  }
  const suffix = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : ''
  const payload = await cloudJsonRequest<unknown>(`${path(scope)}/history${suffix}`, { method: 'GET', signal })
  signal?.throwIfAborted()
  const parsed = historySchema.safeParse(payload)
  if (!parsed.success) throw new Error('The correction service returned invalid private history. No original evidence was substituted.')
  const value = parsed.data
  checkedCorrection(value.correction, scope, value.originalResultSha256)
  if (!sameScope(value, scope) || new Set(value.entries.map(entry => entry.id)).size !== value.entries.length ||
    (expectedOriginalSha256 !== undefined && value.originalResultSha256 !== expectedOriginalSha256) ||
    value.originalAssessment.criteria.length !== value.original.coverage.totalCriteria ||
    value.originalAssessment.criteria.filter(item => item.evidenceStatus === 'not-assessed').length !== value.original.coverage.notAssessed ||
    (continuationToken !== undefined && value.continuationToken === continuationToken) ||
    value.entries.some(entry => entry.criterionIds.some(criterionId =>
      !value.originalAssessment.criteria.some(item => item.criterionId === criterionId && item.evidenceStatus === 'not-assessed' && item.weight > 0))) ||
    value.entries.some(entry => entry.outcome === 'ready'
      ? !entry.resultSha256 || entry.resultSha256 === entry.beforeResultSha256 || entry.review?.outcome !== 'supported' ||
        entry.review.issues.length > 0 || entry.error !== null
      : entry.resultSha256 !== null)) {
    throw new Error('The correction service returned mismatched private history or an unreviewed publication.')
  }
  return value
}

export async function requestAnalysisCorrection(
  workspaceId: string, runId: string, comparisonId: string,
  input: AnalysisCorrectionInput, previewEtag: string, key: string, signal?: AbortSignal,
): Promise<AnalysisCorrectionResponse> {
  const scope = { workspaceId, runId, comparisonId }
  const parsedInput = inputSchema.safeParse(input)
  if (!parsedInput.success) throw new Error('Review the exact saved result hash, selected criteria, and a meaningful correction reason (10–1000 characters).')
  if (!z.uuid().safeParse(key).success) throw new Error('A stable UUID request key is required for each comparison correction.')
  const payload = await cloudJsonRequest<unknown>(path(scope), {
    method: 'POST', signal, headers: { ...concurrency(previewEtag), 'Idempotency-Key': key },
    body: JSON.stringify(parsedInput.data),
  })
  signal?.throwIfAborted()
  const parsed = responseSchema.safeParse(payload)
  if (!parsed.success || parsed.data.requestId !== key || parsed.data.correction.requestId !== key) {
    throw new Error('The correction request was not acknowledged with its original request ID. Check status or retry the same request.')
  }
  const value = parsed.data
  checkedCorrection(value.correction, scope)
  if (!sameCriteria(value.correction.criterionIds, parsedInput.data.criterionIds) ||
    value.correction.reason !== parsedInput.data.reason ||
    (value.correction.status === 'ready' && (value.correction.revision?.baseResultSha256 !== parsedInput.data.resultSha256 ||
      !sameCriteria(value.correction.revision.criterionIds, parsedInput.data.criterionIds)))) {
    throw new Error('The correction acknowledgement does not match the reviewed hash, criteria, or reason. Check status before retrying the same request.')
  }
  return value
}

export async function cancelAnalysisCorrection(
  workspaceId: string, runId: string, comparisonId: string, current: AnalysisCorrectionSummary, signal?: AbortSignal,
): Promise<AnalysisCorrectionResponse> {
  const scope = { workspaceId, runId, comparisonId }
  const checked = correctionSchema.safeParse(current)
  if (!checked.success || !sameScope(checked.data, scope) || checked.data.status === 'ready') {
    throw new Error('Reload a non-published correction for this exact comparison before cancelling.')
  }
  const payload = await cloudJsonRequest<unknown>(`${path(scope)}/cancel`, {
    method: 'POST', signal, headers: concurrency(checked.data.etag), body: JSON.stringify({}),
  })
  signal?.throwIfAborted()
  const parsed = responseSchema.safeParse(payload)
  if (!parsed.success || parsed.data.requestId !== checked.data.requestId ||
    parsed.data.correction.requestId !== checked.data.requestId || !['cancelled', 'failed'].includes(parsed.data.correction.status)) {
    throw new Error('Cancellation was not acknowledged for the current request. Check correction status before trying again.')
  }
  checkedCorrection(parsed.data.correction, scope)
  if (!sameCriteria(parsed.data.correction.criterionIds, checked.data.criterionIds) || parsed.data.correction.reason !== checked.data.reason) {
    throw new Error('Cancellation returned different correction criteria or reason. Check correction status.')
  }
  return parsed.data
}
