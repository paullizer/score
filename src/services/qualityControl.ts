import { z } from 'zod'
import {
  QC_LIMITS, qcBatchInputSchema, qcComparisonRefSchema, qcIdentifier, qcReviewDraftInputSchema, qcReviewInputSchema, qcScopeKey,
  type QcBatchRecord, type QcCapabilities, type QcComparisonContext, type QcComparisonRef,
  type QcPage, type QcPeerFeedback, type QcReviewHead, type QcReviewInput, type QcReviewSubmission, type VersionedQc,
} from '../domain/quality-control'
import {
  qcPlanInputSchema, qcPlanProposalSchema, qcPromptActivationReasonSchema, QC_PROMPT_FAMILIES,
  type QcPlanDetail, type QcPlanInput, type QcPlanProposal, type QcPlanRecord, type QcPlanRevision,
  type QcPromptHistoryEntry, type QcPromptSet,
} from '../domain/quality-improvement'
import { CloudConflictError, cloudJsonRequest } from './cloudWorkspace'

const capabilities = z.strictObject({
  reviews: z.boolean(), improvements: z.boolean(), admissionEnabled: z.boolean(), applicationAdmin: z.boolean(),
  coordinator: z.boolean(), writable: z.boolean(), message: z.string().nullable(),
})
const promptSet = z.object({
  revision: qcIdentifier, etag: z.string().min(1),
  guidance: z.record(z.enum(QC_PROMPT_FAMILIES), z.string()),
})
const trialScope = z.object({
  pairs: z.array(z.object({
    scope: qcComparisonRefSchema, purpose: z.enum(['drafting', 'holdout']), familyId: z.enum(QC_PROMPT_FAMILIES),
  })).max(QC_LIMITS.planCases * QC_PROMPT_FAMILIES.length),
  baselineTrials: z.number().int().min(0), candidateTrials: z.number().int().min(0),
  unsupportedFamilies: z.array(z.enum(QC_PROMPT_FAMILIES)).max(QC_PROMPT_FAMILIES.length),
})
const diagnostics = z.object({
  status: z.enum(['recorded', 'not-recorded', 'historical']), message: z.string().nullable(),
  criteria: z.array(z.object({
    criterionId: qcIdentifier, confidence: z.enum(['low', 'medium', 'high']).nullable(), explanation: z.string(),
    ambiguities: z.array(z.object({ kind: z.string(), message: z.string() })),
    alternativeScores: z.array(z.number().int().min(0).max(5)).max(6),
  })).max(QC_LIMITS.criteria),
})
function base(workspaceId: string): string {
  qcIdentifier.parse(workspaceId)
  return `/workspaces/${encodeURIComponent(workspaceId)}/qc`
}
function params(scope: QcComparisonRef): URLSearchParams {
  return new URLSearchParams(qcComparisonRefSchema.parse(scope))
}
function headers(key: string, etag?: string | null): Record<string, string> {
  z.uuid().parse(key)
  if (etag !== undefined && etag !== null && (!etag || etag === '*' || etag.startsWith('W/'))) {
    throw new Error('Reload the QC record and review its current version before saving.')
  }
  return { 'Idempotency-Key': key, ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) }
}
function checked<T extends { id: string; workspaceId: string }>(value: VersionedQc<T>, workspaceId: string): VersionedQc<T> {
  if (!value?.record?.id || !qcIdentifier.safeParse(value.record.id).success || value.record.workspaceId !== workspaceId ||
    typeof value.etag !== 'string' || !/^"[^"\r\n]+"$/.test(value.etag)) {
    throw new Error('The QC service returned an invalid or foreign record. Nothing was substituted.')
  }
  return value
}
function page<T extends { id: string; workspaceId: string }>(value: QcPage<T>, workspaceId: string): QcPage<T> {
  if (!Array.isArray(value?.items) || value.items.length > QC_LIMITS.pageSize) throw new Error('The QC service did not return a bounded saved page.')
  value.items.forEach(item => checked(item, workspaceId))
  return value
}
function planRecord(value: QcPlanRecord): void {
  qcPlanInputSchema.parse({ name: value.name, objective: value.objective, cases: value.cases, excludedFeedback: value.excludedFeedback })
  promptSet.parse(value.baseline)
  if (value.proposal) qcPlanProposalSchema.parse(value.proposal)
}
function plan(value: QcPlanDetail, workspaceId: string, planId?: string): QcPlanDetail {
  checked({ record: value?.plan, etag: value?.etag }, workspaceId)
  if (planId !== undefined && value.plan.id !== planId) throw new Error('The returned plan does not match the requested saved plan.')
  planRecord(value.plan)
  if (value.evaluation && (value.evaluation.workspaceId !== workspaceId || value.evaluation.planId !== value.plan.id)) {
    throw new Error('The evaluation does not belong to this improvement plan.')
  }
  if (value.work && (value.work.workspaceId !== workspaceId || value.work.planId !== value.plan.id)) {
    throw new Error('The saved work does not belong to this improvement plan.')
  }
  if (value.trialScope !== undefined) {
    const scope = trialScope.parse(value.trialScope)
    const selected = new Map(value.plan.cases.map(item => [qcScopeKey(item.scope), item.purpose]))
    const changed = new Set(value.plan.proposal?.changes.map(item => item.familyId))
    const paired = new Set(scope.pairs.map(item => `${qcScopeKey(item.scope)}:${item.familyId}`))
    const supported = new Set(scope.pairs.map(item => item.familyId))
    const unsupported = new Set(scope.unsupportedFamilies)
    if (!value.plan.proposal || scope.baselineTrials !== scope.pairs.length || scope.candidateTrials !== scope.pairs.length ||
      paired.size !== scope.pairs.length || unsupported.size !== scope.unsupportedFamilies.length ||
      scope.pairs.some(item => selected.get(qcScopeKey(item.scope)) !== item.purpose || !changed.has(item.familyId)) ||
      scope.unsupportedFamilies.some(family => !changed.has(family) || supported.has(family)) ||
      [...changed].some(family => !supported.has(family) && !unsupported.has(family))) {
      throw new Error('The trial-scope projection does not match this exact saved plan.')
    }
  }
  return value
}
function cursor(path: string, continuationToken?: string): string {
  return continuationToken ? `${path}?${new URLSearchParams({ continuationToken })}` : path
}

export async function getQcCapabilities(workspaceId: string, signal?: AbortSignal): Promise<QcCapabilities> {
  return capabilities.parse(await cloudJsonRequest(`${base(workspaceId)}/capabilities`, { signal }))
}
export async function getQcContext(
  workspaceId: string, runId: string, comparisonId: string, resultRevision?: string, signal?: AbortSignal, resultSha256?: string,
): Promise<QcComparisonContext> {
  const query = new URLSearchParams({ runId: qcIdentifier.parse(runId), comparisonId: qcIdentifier.parse(comparisonId) })
  if (resultRevision) query.set('resultRevision', qcIdentifier.parse(resultRevision))
  const value = await cloudJsonRequest<QcComparisonContext>(`${base(workspaceId)}/context?${query}`, { signal })
  qcComparisonRefSchema.parse(value.scope)
  if (value.workspaceId !== workspaceId || value.scope.runId !== runId || value.scope.comparisonId !== comparisonId ||
    (resultRevision !== undefined && value.scope.resultRevision !== resultRevision) ||
    (resultSha256 !== undefined && value.scope.resultSha256 !== resultSha256) ||
    value.analysis?.comparison?.workspaceId !== workspaceId || value.analysis.comparison.runId !== runId ||
    value.analysis.comparison.id !== comparisonId || value.analysis.comparison.dataKind !== 'real' ||
    value.analysis.comparison.status !== 'complete' || value.analysis.comparison.result?.sha256 !== value.scope.resultSha256 ||
    !value.analysis.result || value.analysis.result.workspaceId !== workspaceId || value.analysis.result.runId !== runId ||
    value.analysis.result.comparisonId !== comparisonId || value.analysis.result.dataKind !== 'real' ||
    !Array.isArray(value.analysis.result.criteria) || !Array.isArray(value.diagnostics?.criteria)) {
    throw new Error('The QC context is not bound to the requested saved comparison.')
  }
  diagnostics.parse(value.diagnostics)
  const criteria = new Map(value.analysis.result.criteria.map(row => [row.criterionId, row]))
  const diagnosticIds = new Set(value.diagnostics.criteria.map(row => row.criterionId))
  if (diagnosticIds.size !== value.diagnostics.criteria.length ||
    value.diagnostics.criteria.some(row => !criteria.has(row.criterionId) || (row.confidence !== null && criteria.get(row.criterionId)?.score === null)) ||
    (value.diagnostics.status === 'recorded' && diagnosticIds.size !== criteria.size)) {
    throw new Error('Recorded diagnostics do not match this exact saved criterion set.')
  }
  if (value.myReview) {
    checked(value.myReview, workspaceId)
    if (qcScopeKey(value.myReview.record.scope) !== qcScopeKey(value.scope)) throw new Error('This draft belongs to a different result revision.')
    qcReviewDraftInputSchema.parse({ scope: value.myReview.record.scope, feedback: value.myReview.record.feedback })
  }
  return value
}
export async function saveQcReview(
  workspaceId: string, input: QcReviewInput, etag: string | null, key: string, submit = false, signal?: AbortSignal,
): Promise<VersionedQc<QcReviewHead>> {
  const value = await cloudJsonRequest<VersionedQc<QcReviewHead>>(`${base(workspaceId)}/reviews${submit ? '/submit' : ''}`, {
    method: submit ? 'POST' : 'PUT', headers: headers(key, etag), body: JSON.stringify((submit ? qcReviewInputSchema : qcReviewDraftInputSchema).parse(input)), signal,
  })
  checked(value, workspaceId)
  if (qcScopeKey(value.record.scope) !== qcScopeKey(input.scope)) throw new Error('The acknowledged review does not belong to this exact result.')
  qcReviewDraftInputSchema.parse({ scope: value.record.scope, feedback: value.record.feedback })
  if (value.record.lastRequestId !== key) {
    throw new CloudConflictError('The saved working copy was changed by another request. Your fields were retained; inspect the current draft version before saving again.')
  }
  return value
}
export async function getQcReviewHistory(
  workspaceId: string, scope: QcComparisonRef, continuationToken?: string, signal?: AbortSignal,
): Promise<QcPage<QcReviewSubmission>> {
  const query = params(scope)
  if (continuationToken) query.set('continuationToken', continuationToken)
  const value = page(await cloudJsonRequest<QcPage<QcReviewSubmission>>(`${base(workspaceId)}/reviews/history?${query}`, { signal }), workspaceId)
  for (const { record } of value.items) {
    if (qcScopeKey(record.scope) !== qcScopeKey(scope)) throw new Error('Review history belongs to a different result revision.')
    qcReviewInputSchema.parse({ scope: record.scope, feedback: record.feedback })
  }
  return value
}
export async function getQcPeers(workspaceId: string, scope: QcComparisonRef, key: string, continuationToken?: string, signal?: AbortSignal): Promise<QcPeerFeedback> {
  const value = await cloudJsonRequest<QcPeerFeedback>(cursor(`${base(workspaceId)}/peers`, continuationToken), {
    method: 'POST', headers: headers(key), body: JSON.stringify(qcComparisonRefSchema.parse(scope)), signal,
  })
  if (!Array.isArray(value?.submissions) || value.submissions.length > QC_LIMITS.pageSize || qcScopeKey(value.scope) !== qcScopeKey(scope) ||
    value.submissions.some(item => item.workspaceId !== workspaceId || qcScopeKey(item.scope) !== qcScopeKey(scope))) {
    throw new Error('Peer feedback was not returned for this exact saved result.')
  }
  value.submissions.forEach(item => qcReviewInputSchema.parse({ scope: item.scope, feedback: item.feedback }))
  return value
}
export async function listQcBatches(workspaceId: string, continuationToken?: string, signal?: AbortSignal): Promise<QcPage<QcBatchRecord>> {
  return page(await cloudJsonRequest<QcPage<QcBatchRecord>>(cursor(`${base(workspaceId)}/batches`, continuationToken), { signal }), workspaceId)
}
export async function createQcBatch(workspaceId: string, input: z.infer<typeof qcBatchInputSchema>, key: string, signal?: AbortSignal): Promise<VersionedQc<QcBatchRecord>> {
  return checked(await cloudJsonRequest<VersionedQc<QcBatchRecord>>(`${base(workspaceId)}/batches`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(qcBatchInputSchema.parse(input)), signal,
  }), workspaceId)
}
export async function getQcPrompts(workspaceId: string, signal?: AbortSignal): Promise<QcPromptSet> {
  return promptSet.parse(await cloudJsonRequest(`${base(workspaceId)}/prompts`, { signal }))
}
export async function listQcPlans(workspaceId: string, continuationToken?: string, signal?: AbortSignal): Promise<QcPage<QcPlanRecord>> {
  const value = page(await cloudJsonRequest<QcPage<QcPlanRecord>>(cursor(`${base(workspaceId)}/plans`, continuationToken), { signal }), workspaceId)
  value.items.forEach(item => planRecord(item.record))
  return value
}
export async function createQcPlan(workspaceId: string, input: QcPlanInput, key: string, signal?: AbortSignal): Promise<QcPlanDetail> {
  return plan(await cloudJsonRequest<QcPlanDetail>(`${base(workspaceId)}/plans`, {
    method: 'POST', headers: headers(key), body: JSON.stringify(qcPlanInputSchema.parse(input)), signal,
  }), workspaceId)
}
export async function getQcPlan(workspaceId: string, planId: string, signal?: AbortSignal): Promise<QcPlanDetail> {
  return plan(await cloudJsonRequest<QcPlanDetail>(`${base(workspaceId)}/plans/${encodeURIComponent(qcIdentifier.parse(planId))}`, { signal }), workspaceId, planId)
}
export async function updateQcPlan(workspaceId: string, detail: QcPlanDetail, proposal: QcPlanProposal, key: string, signal?: AbortSignal): Promise<QcPlanDetail> {
  const value = plan(await cloudJsonRequest<QcPlanDetail>(`${base(workspaceId)}/plans/${encodeURIComponent(detail.plan.id)}`, {
    method: 'PUT', headers: headers(key, detail.etag), body: JSON.stringify({ proposal: qcPlanProposalSchema.parse(proposal) }), signal,
  }), workspaceId, detail.plan.id)
  if (value.plan.lastRequestId !== key) {
    throw new CloudConflictError('The plan was changed by another request. Your edits were retained; inspect the latest saved revision before saving again.')
  }
  return value
}
export type QcPlanAction = 'draft' | 'evaluate' | 'cancel' | 'retry' | 'activate'
export async function actOnQcPlan(
  workspaceId: string, detail: QcPlanDetail, action: QcPlanAction, key: string, reason?: string, signal?: AbortSignal,
): Promise<QcPlanDetail> {
  const body = action === 'evaluate' ? { confirmPaidWork: true }
    : action === 'activate' ? { reason: qcPromptActivationReasonSchema.parse(reason), confirm: true } : {}
  return plan(await cloudJsonRequest<QcPlanDetail>(`${base(workspaceId)}/plans/${encodeURIComponent(detail.plan.id)}/${action}`, {
    method: 'POST', headers: headers(key, detail.etag), body: JSON.stringify(body), signal,
  }), workspaceId, detail.plan.id)
}
export async function getQcPlanHistory(workspaceId: string, planId: string, continuationToken?: string, signal?: AbortSignal): Promise<QcPage<QcPlanRevision>> {
  const value = page(await cloudJsonRequest<QcPage<QcPlanRevision>>(cursor(`${base(workspaceId)}/plans/${encodeURIComponent(qcIdentifier.parse(planId))}/history`, continuationToken), { signal }), workspaceId)
  for (const item of value.items) {
    if (item.record.planId !== planId || item.record.value?.id !== planId || item.record.value.workspaceId !== workspaceId) {
      throw new Error('Plan history belongs to another saved plan.')
    }
    planRecord(item.record.value)
  }
  return value
}
export async function getQcPromptHistory(workspaceId: string, continuationToken?: string, signal?: AbortSignal): Promise<{ items: QcPromptHistoryEntry[]; continuationToken?: string }> {
  const value = await cloudJsonRequest<{ items: QcPromptHistoryEntry[]; continuationToken?: string }>(cursor(`${base(workspaceId)}/prompts/history`, continuationToken), { signal })
  if (!Array.isArray(value?.items) || value.items.length > QC_LIMITS.pageSize) throw new Error('Prompt history could not be read.')
  value.items.forEach(item => promptSet.parse({ revision: item.revision, etag: 'history', guidance: item.guidance }))
  return value
}
export async function restoreQcPrompts(workspaceId: string, revision: string, etag: string, reason: string, key: string, signal?: AbortSignal): Promise<QcPromptSet> {
  return promptSet.parse(await cloudJsonRequest(`${base(workspaceId)}/prompts/restore`, {
    method: 'POST', headers: headers(key, etag), body: JSON.stringify({ revision, reason: qcPromptActivationReasonSchema.parse(reason), confirm: true }), signal,
  }))
}
