import { z } from 'zod'
import type { PublicSettings } from '../domain/admin-settings'
import { analysisFeaturesWithPolicy, fetchPublicFeatures, requireAdmission } from './publicSettings'
import {
  ANALYSIS_LIMITS,
  ANALYSIS_SUBMISSION_WAIT,
  type AnalysisModelProvenance,
  type AnalysisProcessingFeatures,
  type CreateRealAnalysisInput,
  type RealAnalysesPage,
  type RealAnalysisComparisonDetail,
  type RealAnalysisComparisonSummary,
  type RealAnalysisComparisonsPage,
  type RealAnalysisDocumentResponse,
  type RealAnalysisMutationResponse,
  type RealAnalysisRunDetail,
  type RealAnalysisRunSummary,
  type RealAnalysisTargetSelection,
  type RealAnalysisTargetsPage,
  type RealAnalysisTargetSummary,
  type RealComparisonMutationResponse,
  type RetryRealAnalysisInput,
} from '../domain/real-analyses'
import {
  ANALYSIS_NARRATIVE_LIMITS, analysisNarrativeIsCurrent,
  type GenerateRealAnalysisSummariesInput, type RealAnalysisSummariesMutationResponse,
  type RealAnalysisSummariesQuery, type RealAnalysisSummariesResponse, type RealAnalysisSummarySubjectResponse,
  type RealAnalysisSummaryStatusQuery, type RealAnalysisSummaryStatusResponse,
} from '../domain/analysis-narratives'
import { analysisNarrativeWorkHealthSchema } from '../domain/analysis-narrative-validation'
import { ANALYSIS_CORRECTION_POLICY_VERSIONS } from '../domain/analysis-corrections'
import {
  ANALYSIS_DIAGNOSTIC_LIMITS, ANALYSIS_DIAGNOSTIC_REASONS,
  type AnalysisFailureDiagnostic, type RealAnalysisDiagnosticsPage,
} from '../domain/analysis-diagnostics'
import {
  SUMMARY_LIMITS, publishSummaryDraftInputSchema, summaryApprovalSchema, summaryCandidateContentSchema,
  summaryDiagnosticSchema, summaryHistoryPageSchema, summaryTargetContentSchema,
  type AnalysisSummaryHistoryPage, type AnalysisSummarySubject, type PublishSummaryDraftInput, type RestartSummaryInput,
} from '../domain/analysis-summary-history'
import type { Citation } from '../domain/types'
import { cloudIdempotentJsonRequest, cloudJsonRequest, cloudJsonResponse, cloudLifecycleRequest } from './cloudWorkspace'
import type { LifecycleAction, LifecycleImpact, LifecycleOperation } from '../domain/lifecycle'
import { normalizeDisplayName } from '../domain/displayNames'

function base(workspaceId: string, runId?: string): string {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/analyses`
  return runId === undefined ? path : `${path}/${encodeURIComponent(runId)}`
}

function pairs(workspaceId: string, runId: string, comparisonId?: string): string {
  const path = `${base(workspaceId, runId)}/comparisons`
  return comparisonId === undefined ? path : `${path}/${encodeURIComponent(comparisonId)}`
}

function concurrency(etag: string): Record<string, string> {
  if (!etag) throw new Error('Reload and review the saved analysis state before retrying or cancelling.')
  return { 'If-Match': etag }
}

function checkedRun(value: RealAnalysisRunSummary, workspaceId: string): RealAnalysisRunSummary {
  if (!value?.run?.id || value.run.dataKind !== 'real' || value.run.workspaceId !== workspaceId || !value.etag) {
    throw new Error('The analysis service did not return a real run for this workspace.')
  }
  return value
}

const activeCorrection = z.object({
  status: z.enum(['queued', 'running']), policyVersion: z.enum(ANALYSIS_CORRECTION_POLICY_VERSIONS),
  requestedAt: z.string().datetime({ offset: true }),
})

function checkedComparison(value: RealAnalysisComparisonSummary, workspaceId: string, runId: string): RealAnalysisComparisonSummary {
  if (!value?.comparison?.id || value.comparison.dataKind !== 'real' || value.comparison.workspaceId !== workspaceId
    || value.comparison.runId !== runId || !value.etag) {
    throw new Error('The analysis service did not return a real comparison for the requested run.')
  }
  if (value.activeCorrection !== undefined &&
    (value.comparison.status !== 'complete' || !activeCorrection.safeParse(value.activeCorrection).success)) {
    throw new Error('The analysis service returned an invalid re-score status for a saved comparison. Nothing was substituted.')
  }
  return value
}

const narrativeId = z.string().min(1).max(1024).refine((value) => value === value.trim())
const narrativeHash = z.string().regex(/^[a-f0-9]{64}$/)
const narrativeCount = z.number().int().min(0).max(ANALYSIS_LIMITS.maxComparisons)
const narrativeStatus = z.enum(['waiting', 'queued', 'running', 'ready', 'failed', 'cancelled', 'missing', 'stale', 'not-required'])
const comparisonStatus = z.enum(['queued', 'running', 'complete', 'failed', 'cancelled'])
const narrativeRevision = z.object({ revision: narrativeHash, inputFingerprint: narrativeHash })
const narrativePublication = narrativeRevision.extend({ dataKind: z.literal('real'), generationId: narrativeId, publishedAt: narrativeId })
const legacyPublication = narrativePublication.extend({ summaryVersion: z.never().optional(), approval: z.never().optional() })
const summaryPublication = narrativePublication.extend({ summaryVersion: z.literal(2), approval: summaryApprovalSchema })
const candidatePublication = z.union([
  summaryPublication.extend(summaryCandidateContentSchema.shape),
  legacyPublication.extend({
    text: z.string().min(1).max(ANALYSIS_NARRATIVE_LIMITS.candidateMaxCharacters),
    overview: z.string().min(1).max(ANALYSIS_NARRATIVE_LIMITS.overviewMaxCharacters),
  }),
])
const targetPublication = z.union([
  summaryPublication.extend(summaryTargetContentSchema.shape).refine(value =>
    value.paragraphs.join('\n\n').length <= SUMMARY_LIMITS.totalCharacters),
  legacyPublication.extend({
    paragraphs: z.array(z.string().min(1).max(ANALYSIS_NARRATIVE_LIMITS.targetParagraphMaxCharacters))
      .min(1).max(ANALYSIS_NARRATIVE_LIMITS.targetMaxParagraphs),
  }),
])
const narrativeCounts = z.object({
  total: narrativeCount, missing: narrativeCount, waiting: narrativeCount, queued: narrativeCount, running: narrativeCount,
  ready: narrativeCount, stale: narrativeCount, failed: narrativeCount, cancelled: narrativeCount, notRequired: narrativeCount,
}).refine(({ total, ...counts }) => Object.values(counts).reduce((sum, count) => sum + count, 0) === total)
const narrativeScope = z.object({ targetId: narrativeId.nullable() })
const narrativeState = z.object({
  targetId: narrativeId, status: narrativeStatus, generationId: narrativeId.nullable(), inputFingerprint: narrativeHash.nullable(),
  waitingFor: z.enum(['scoring', 'candidate-narratives']).nullable(),
  attempts: z.number().int().min(0), retryCount: z.number().int().min(0),
  nextAttemptAt: narrativeId.nullable(), updatedAt: narrativeId.nullable(),
  hasHistory: z.boolean().optional(), summaryRound: z.number().int().min(1).max(SUMMARY_LIMITS.rounds).optional(),
  workHealth: analysisNarrativeWorkHealthSchema.optional(),
  error: z.object({
    code: z.enum(['invalid-input', 'stale-input', 'snapshot-unavailable', 'snapshot-invalid', 'context-limit', 'invalid-model-output',
      'invalid-citation', 'grounding-failed', 'service-unavailable', 'storage-error', 'timeout', 'internal-error', 'dependency-failed']),
    stage: z.enum(['dependencies', 'candidate-generation', 'target-generation', 'grounding', 'publication']),
    message: z.string().min(1).max(16_000), retryable: z.boolean(),
    diagnostic: summaryDiagnosticSchema.optional(),
  }).nullable(),
})
const candidateSummary = narrativeState.extend({
  kind: z.literal('candidate'), comparisonId: narrativeId, comparisonStatus,
  resultSha256: narrativeHash.nullable().optional(),
  published: candidatePublication.nullable(),
})
const targetSummary = narrativeState.extend({
  kind: z.literal('target'), published: targetPublication.nullable(),
})
const summarySubjectBase = z.object({
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId: narrativeId, runId: narrativeId,
  subjectId: narrativeId, revision: narrativeHash, etag: narrativeId,
  workRevision: narrativeHash.optional(),
  resultRevisionId: z.union([z.literal('original'), z.string().uuid()]).optional(),
})
const summarySubjectEnvelope: z.ZodType<RealAnalysisSummarySubjectResponse> = z.discriminatedUnion('kind', [
  summarySubjectBase.extend({ kind: z.literal('candidate'), narrative: candidateSummary }),
  summarySubjectBase.extend({ kind: z.literal('target'), narrative: targetSummary }),
])
const summariesEnvelope: z.ZodType<RealAnalysisSummariesResponse> = z.object({
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId: narrativeId, runId: narrativeId,
  scope: narrativeScope, revision: narrativeHash, etag: narrativeId, ready: z.boolean(),
  workRevision: narrativeHash.optional(),
  scoring: z.object({
    total: narrativeCount, initialized: narrativeCount, queued: narrativeCount, running: narrativeCount,
    complete: narrativeCount, failed: narrativeCount, cancelled: narrativeCount,
  }),
  counts: z.object({ candidates: narrativeCounts, targets: narrativeCounts }),
  capabilities: z.object({
    canGenerate: z.boolean(), reason: z.enum(['read-only', 'archived', 'deleting', 'cancelling', 'service-unavailable']).nullable(),
  }),
  comparisons: z.array(candidateSummary).max(ANALYSIS_LIMITS.maxComparisons),
  targets: z.array(targetSummary).max(ANALYSIS_LIMITS.maxComparisons),
  capture: z.object({
    dataKind: z.literal('real'), scope: narrativeScope, revision: narrativeHash, ready: z.boolean(),
    comparisons: z.array(z.object({
      comparisonId: narrativeId, targetId: narrativeId, status: comparisonStatus,
      resultSha256: narrativeHash.nullable(), narrative: narrativeRevision.nullable(),
    })).max(ANALYSIS_LIMITS.maxComparisons),
    targets: z.array(z.object({ targetId: narrativeId, narrative: narrativeRevision.nullable() })).max(ANALYSIS_LIMITS.maxComparisons),
  }),
})

function validCurrentSummary(item: RealAnalysisSummarySubjectResponse['narrative']): boolean {
  return item.status !== 'ready' || (analysisNarrativeIsCurrent(item, item.inputFingerprint) &&
    (item.kind !== 'candidate' || item.comparisonStatus === 'complete'))
}

function checkedSummaryScope(workspaceId: string, runId: string, query: RealAnalysisSummariesQuery): string | null {
  if (!narrativeId.safeParse(workspaceId).success || !narrativeId.safeParse(runId).success ||
    (query.targetId !== undefined && !narrativeId.safeParse(query.targetId).success)) {
    throw new Error('Select a saved workspace, analysis, and optional exact job or grade before requesting summaries.')
  }
  return query.targetId ?? null
}

function checkedSummaries(payload: unknown, workspaceId: string, runId: string, targetId: string | null): RealAnalysisSummariesResponse {
  const parsed = summariesEnvelope.safeParse(payload)
  if (!parsed.success) throw new Error('The summary service returned an invalid saved-summary envelope. Reload summaries before continuing.')
  const value = parsed.data
  const { capture, scoring } = value
  const targets = new Set(value.targets.map((item) => item.targetId))
  const comparisons = new Map(value.comparisons.map((item) => [item.comparisonId, item]))
  if (value.workspaceId !== workspaceId || value.runId !== runId || value.scope.targetId !== targetId ||
    capture.scope.targetId !== targetId || capture.revision !== value.revision || capture.ready !== value.ready ||
    value.etag !== `"${value.revision}"` || targets.size !== value.targets.length || comparisons.size !== value.comparisons.length ||
    (targetId !== null && (targets.size !== 1 || !targets.has(targetId))) ||
    [...value.comparisons, ...value.targets].some((item) => !validCurrentSummary(item)) ||
    value.comparisons.some((item) => !targets.has(item.targetId)) ||
    value.counts.candidates.total !== value.comparisons.length || value.counts.targets.total !== value.targets.length ||
    new Set(capture.targets.map((item) => item.targetId)).size !== targets.size ||
    capture.targets.length !== targets.size || capture.targets.some((item) => !targets.has(item.targetId)) ||
    capture.comparisons.length !== comparisons.size || new Set(capture.comparisons.map((item) => item.comparisonId)).size !== comparisons.size ||
    capture.comparisons.some((item) => {
      const comparison = comparisons.get(item.comparisonId)
      return !comparison || comparison.targetId !== item.targetId || comparison.comparisonStatus !== item.status ||
        (comparison.resultSha256 !== undefined && comparison.resultSha256 !== item.resultSha256) ||
        (value.ready && item.status === 'complete' && (!item.resultSha256 || !item.narrative ||
          item.narrative.revision !== comparison.published?.revision || item.narrative.inputFingerprint !== comparison.published.inputFingerprint))
    }) || scoring.total !== comparisons.size || scoring.initialized > scoring.total ||
    scoring.queued + scoring.running + scoring.complete + scoring.failed + scoring.cancelled !== scoring.total ||
    scoring.running + scoring.complete + scoring.failed + scoring.cancelled > scoring.initialized ||
    (value.ready && (scoring.total !== scoring.initialized || scoring.queued > 0 || scoring.running > 0 ||
      value.comparisons.some((item) => item.comparisonStatus === 'complete' && !analysisNarrativeIsCurrent(item, item.inputFingerprint)) ||
      value.targets.some((item) => {
        const pinned = capture.targets.find((target) => target.targetId === item.targetId)?.narrative
        return item.status !== 'not-required' && (!analysisNarrativeIsCurrent(item, item.inputFingerprint) ||
          !pinned || pinned.revision !== item.published?.revision || pinned.inputFingerprint !== item.published.inputFingerprint)
      })))) {
    throw new Error('The summary service returned mismatched workspace, analysis, scope, or readiness information. Nothing was substituted.')
  }
  return value
}

export async function getRealAnalysisSummaries(
  workspaceId: string, runId: string, query: RealAnalysisSummariesQuery = {}, signal?: AbortSignal,
): Promise<RealAnalysisSummariesResponse> {
  const targetId = checkedSummaryScope(workspaceId, runId, query)
  const suffix = targetId === null ? '' : `?targetId=${encodeURIComponent(targetId)}`
  const result = await cloudJsonRequest<unknown>(`${base(workspaceId, runId)}/summaries${suffix}`, { method: 'GET', signal })
  signal?.throwIfAborted()
  return checkedSummaries(result, workspaceId, runId, targetId)
}

const scoringCounts = z.object({
  total: narrativeCount, initialized: narrativeCount, queued: narrativeCount, running: narrativeCount,
  complete: narrativeCount, failed: narrativeCount, cancelled: narrativeCount,
})
const summaryStatusEnvelope: z.ZodType<RealAnalysisSummaryStatusResponse> = z.object({
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId: narrativeId, runId: narrativeId,
  scope: narrativeScope, revision: narrativeHash, workRevision: narrativeHash,
  generation: z.enum(['automatic', 'on-demand', 'disabled']), ready: z.boolean(),
  scoring: scoringCounts, corrections: z.object({ pending: narrativeCount }),
  counts: z.object({ candidates: narrativeCounts, targets: narrativeCounts }),
  comparisons: z.array(z.object({
    comparisonId: narrativeId, targetId: narrativeId, comparisonStatus, resultSha256: narrativeHash.nullable(),
    correctionPending: z.boolean(), status: narrativeStatus,
  })).max(ANALYSIS_LIMITS.maxComparisons).optional(),
  targets: z.array(z.object({
    targetId: narrativeId, status: narrativeStatus, waitingFor: z.enum(['scoring', 'candidate-narratives']).nullable(),
  })).max(ANALYSIS_LIMITS.maxComparisons).optional(),
})

function checkedSummaryStatus(payload: unknown, workspaceId: string, runId: string, items: boolean): RealAnalysisSummaryStatusResponse {
  const parsed = summaryStatusEnvelope.safeParse(payload)
  if (!parsed.success) throw new Error('The summary service returned an invalid summary status. Reload the saved analysis before continuing.')
  const value = parsed.data
  const { scoring, counts } = value
  const comparisons = value.comparisons, targets = value.targets
  const targetIds = new Set(targets?.map((item) => item.targetId))
  if (value.workspaceId !== workspaceId || value.runId !== runId || value.scope.targetId !== null ||
    (comparisons === undefined) !== (targets === undefined) || (items && !comparisons) ||
    counts.candidates.total !== scoring.total || scoring.initialized > scoring.total ||
    scoring.queued + scoring.running + scoring.complete + scoring.failed + scoring.cancelled !== scoring.total ||
    scoring.running + scoring.complete + scoring.failed + scoring.cancelled > scoring.initialized ||
    value.corrections.pending > scoring.complete ||
    (value.ready && (scoring.initialized !== scoring.total || scoring.queued + scoring.running > 0 ||
      [counts.candidates, counts.targets].some((count) => count.ready + count.notRequired !== count.total))) ||
    (comparisons && (comparisons.length !== counts.candidates.total ||
      new Set(comparisons.map((item) => item.comparisonId)).size !== comparisons.length ||
      comparisons.some((item) => !targetIds.has(item.targetId) || (item.comparisonStatus === 'complete') !== (item.resultSha256 !== null) ||
        (item.correctionPending && item.comparisonStatus !== 'complete')) ||
      comparisons.filter((item) => item.correctionPending).length !== value.corrections.pending)) ||
    (targets && (targets.length !== counts.targets.total || targetIds.size !== targets.length ||
      targets.some((item) => (item.waitingFor !== null) && item.status !== 'waiting')))) {
    throw new Error('The summary service returned mismatched workspace, analysis, or summary status information. Nothing was substituted.')
  }
  return value
}

/** Work metadata only. The status never includes published text, so pages can poll it while summaries generate. */
export async function getRealAnalysisSummaryStatus(
  workspaceId: string, runId: string, query: RealAnalysisSummaryStatusQuery = {}, signal?: AbortSignal,
): Promise<RealAnalysisSummaryStatusResponse> {
  checkedSummaryScope(workspaceId, runId, {})
  const items = query.items === true
  const result = await cloudJsonRequest<unknown>(`${base(workspaceId, runId)}/summary-status${items ? '?items=true' : ''}`, { method: 'GET', signal })
  signal?.throwIfAborted()
  return checkedSummaryStatus(result, workspaceId, runId, items)
}

export async function generateRealAnalysisSummaries(
  workspaceId: string, runId: string, input: GenerateRealAnalysisSummariesInput, etag: string, key: string,
): Promise<RealAnalysisSummariesMutationResponse> {
  const targetId = checkedSummaryScope(workspaceId, runId, input)
  if (input.mode !== 'missing' && input.mode !== 'all') throw new Error('Choose Generate missing summaries or Regenerate all summaries.')
  if (!/^"[a-f0-9]{64}"$/.test(etag)) throw new Error('Reload the selected summary scope before generating. A summary ETag, not a scoring ETag, is required.')
  if (!z.uuid().safeParse(key).success) throw new Error('A stable UUID idempotency key is required for summary generation.')
  const result = await cloudJsonRequest<unknown>(`${base(workspaceId, runId)}/summaries`, {
    method: 'POST', headers: { 'If-Match': etag, 'Idempotency-Key': key },
    body: JSON.stringify({ mode: input.mode, ...(targetId === null ? {} : { targetId }) }),
  })
  const parsed = z.object({
    requestId: z.string().uuid(), scheduled: z.object({ candidates: narrativeCount, targets: narrativeCount }), summaries: z.unknown(),
  }).safeParse(result)
  if (!parsed.success || parsed.data.requestId !== key) throw new Error('The summary request was not acknowledged with its original request ID. Refresh status before retrying the same request.')
  return { ...parsed.data, summaries: checkedSummaries(parsed.data.summaries, workspaceId, runId, targetId) }
}

function summarySubjectPath(workspaceId: string, runId: string, subject: AnalysisSummarySubject): string {
  checkedSummaryScope(workspaceId, runId, {})
  if (!['candidate', 'target'].includes(subject.kind) || !narrativeId.safeParse(subject.subjectId).success) {
    throw new Error('Select one exact saved candidate summary or job / grade overview.')
  }
  return `${base(workspaceId, runId)}/summaries/${subject.kind}/${encodeURIComponent(subject.subjectId)}`
}

function summaryResultRevision(params: URLSearchParams, subject: AnalysisSummarySubject, revisionId?: string): void {
  if (revisionId === undefined) return
  if (subject.kind !== 'candidate' || revisionId !== 'original' && !z.uuid().safeParse(revisionId).success) {
    throw new Error('Choose the original assessment or one exact published correction revision.')
  }
  params.set('resultRevisionId', revisionId)
}

export async function getRealAnalysisSummarySubject(
  workspaceId: string, runId: string, subject: AnalysisSummarySubject, signal?: AbortSignal, resultRevisionId?: string,
): Promise<RealAnalysisSummarySubjectResponse> {
  const params = new URLSearchParams()
  summaryResultRevision(params, subject, resultRevisionId)
  const path = summarySubjectPath(workspaceId, runId, subject)
  const result = await cloudJsonResponse<unknown>(`${path}${params.size ? `?${params}` : ''}`, { method: 'GET', signal })
  signal?.throwIfAborted()
  const parsed = summarySubjectEnvelope.safeParse(result.value)
  if (!parsed.success) throw new Error('The summary service returned an invalid saved-summary envelope. Retry this summary; scores and frozen evidence are unchanged.')
  const value = parsed.data
  const item = value.narrative
  if (value.workspaceId !== workspaceId || value.runId !== runId || value.kind !== subject.kind ||
    value.resultRevisionId !== resultRevisionId ||
    Boolean(resultRevisionId && item.kind === 'candidate' && !item.resultSha256) ||
    value.subjectId !== subject.subjectId || item.kind !== subject.kind ||
    (item.kind === 'candidate' ? item.comparisonId : item.targetId) !== subject.subjectId ||
    value.etag !== `"${value.revision}"` || result.etag !== value.etag || !validCurrentSummary(item)) {
    throw new Error('The summary service returned mismatched workspace, analysis, subject, or revision information. Nothing was substituted.')
  }
  return value
}

export async function getRealAnalysisSummaryHistory(
  workspaceId: string, runId: string, subject: AnalysisSummarySubject, continuationToken?: string, signal?: AbortSignal,
  resultRevisionId?: string,
): Promise<AnalysisSummaryHistoryPage> {
  const path = summarySubjectPath(workspaceId, runId, subject)
  if (continuationToken !== undefined && (!continuationToken || continuationToken.length > 16 * 1024)) {
    throw new Error('The summary history cursor is invalid. Reopen the latest history.')
  }
  const params = new URLSearchParams()
  summaryResultRevision(params, subject, resultRevisionId)
  if (continuationToken) params.set('continuationToken', continuationToken)
  const suffix = params.size ? `?${params}` : ''
  const result = await cloudJsonRequest<unknown>(`${path}/history${suffix}`, { method: 'GET', signal })
  signal?.throwIfAborted()
  const parsed = summaryHistoryPageSchema.safeParse(result)
  if (!parsed.success) throw new Error('The summary service returned invalid private history. No draft was substituted.')
  const page = parsed.data
  if (page.workspaceId !== workspaceId || page.runId !== runId || page.kind !== subject.kind || page.subjectId !== subject.subjectId ||
    page.resultRevisionId !== resultRevisionId || Boolean(resultRevisionId &&
      (page.capabilities.canPublish || page.capabilities.canRetry || page.capabilities.canResume || page.capabilities.canRestart)) ||
    new Set(page.entries.map(entry => entry.id)).size !== page.entries.length ||
    new Set(page.entries.map(entry => entry.targetId)).size > 1 ||
    page.entries.some(entry => entry.workspaceId !== workspaceId || entry.runId !== runId || entry.kind !== subject.kind ||
      entry.subjectId !== subject.subjectId || (subject.kind === 'target' && entry.targetId !== subject.subjectId) ||
      (entry.draft && (entry.scopeId === 'final' ? entry.draft.kind !== subject.kind : entry.draft.kind !== 'reduction')) ||
      (entry.review && entry.review.outputSha256 !== entry.outputSha256)) ||
    (page.continuationToken !== undefined && page.continuationToken === continuationToken)) {
    throw new Error('The private summary history does not match this saved subject or repeats a checkpoint. Reopen history.')
  }
  return page
}

async function mutateSummarySubject(
  workspaceId: string, runId: string, subject: AnalysisSummarySubject, action: 'publish' | 'retry' | 'restart',
  input: PublishSummaryDraftInput | RestartSummaryInput | Record<string, never>, etag: string, key: string, targetId: string,
): Promise<RealAnalysisSummariesResponse> {
  const path = summarySubjectPath(workspaceId, runId, subject)
  checkedSummaryScope(workspaceId, runId, { targetId })
  if (subject.kind === 'target' && targetId !== subject.subjectId) throw new Error('The overview action must retain its exact target scope.')
  if (!etag || etag.length > 1_024) throw new Error('Refresh this summary history before making a change.')
  if (!z.uuid().safeParse(key).success) throw new Error('A stable UUID idempotency key is required for this summary action.')
  const result = await cloudJsonRequest<unknown>(`${path}/${action}`, {
    method: 'POST', headers: { 'If-Match': etag, 'Idempotency-Key': key }, body: JSON.stringify(input),
  })
  const parsed = z.object({ summaries: z.unknown() }).safeParse(result)
  if (!parsed.success) throw new Error('The summary action was not acknowledged. Refresh status before repeating the same action.')
  const summaries = checkedSummaries(parsed.data.summaries, workspaceId, runId, targetId)
  if (subject.kind === 'candidate' && !summaries.comparisons.some(item => item.comparisonId === subject.subjectId)) {
    throw new Error('The summary acknowledgement omitted the selected candidate. Refresh before repeating the same action.')
  }
  return summaries
}

export function publishRealAnalysisSummaryDraft(
  workspaceId: string, runId: string, subject: AnalysisSummarySubject, input: PublishSummaryDraftInput,
  etag: string, key: string, targetId: string,
): Promise<RealAnalysisSummariesResponse> {
  const parsed = publishSummaryDraftInputSchema.safeParse(input)
  if (!parsed.success) throw new Error('Choose an exact recorded final draft before publishing.')
  return mutateSummarySubject(workspaceId, runId, subject, 'publish', parsed.data, etag, key, targetId)
}

export function retryRealAnalysisSummary(
  workspaceId: string, runId: string, subject: AnalysisSummarySubject, etag: string, key: string, targetId: string,
): Promise<RealAnalysisSummariesResponse> {
  return mutateSummarySubject(workspaceId, runId, subject, 'retry', {}, etag, key, targetId)
}

export function restartRealAnalysisSummary(
  workspaceId: string, runId: string, subject: AnalysisSummarySubject, etag: string, key: string, targetId: string,
): Promise<RealAnalysisSummariesResponse> {
  return mutateSummarySubject(workspaceId, runId, subject, 'restart', { confirmRestart: true }, etag, key, targetId)
}

export async function fetchAnalysisProcessingFeatures(signal?: AbortSignal): Promise<AnalysisProcessingFeatures> {
  // realAnalyses indicates new-run readiness; historical reads have their own authorized endpoints.
  const result = await fetchPublicFeatures(signal)
  return analysisFeaturesWithPolicy({ realAnalyses: result.realAnalyses === true, analysisLimits: result.analysisLimits ?? ANALYSIS_LIMITS,
    analysisSummaryGeneration: result.analysisSummaryGeneration === true,
    analysisEvidenceCorrections: result.analysisEvidenceCorrections === true }, result.publicSettings)
}

export interface RealAnalysisCollectionLimits {
  maxItems: number
  maxPages: number
  maxBytes: number
}

async function collect<T>(
  path: string, field: 'runs' | 'targets' | 'comparisons', signal?: AbortSignal, limits?: RealAnalysisCollectionLimits,
): Promise<T[]> {
  const items: T[] = []
  const seen = new Set<string>()
  const itemIds = new Set<string>()
  let pages = 0
  let bytes = 0
  let continuationToken: string | undefined
  do {
    signal?.throwIfAborted()
    if (limits && ++pages > limits.maxPages) throw new Error('The saved analysis inventory exceeds the page budget. Nothing was omitted; retry or narrow the report.')
    const query = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : ''
    const page = await cloudJsonRequest<RealAnalysesPage | RealAnalysisTargetsPage | RealAnalysisComparisonsPage>(`${path}${query}`, { method: 'GET', signal })
    signal?.throwIfAborted()
    const values = field === 'runs' && 'runs' in page ? page.runs : field === 'targets' && 'targets' in page ? page.targets
      : field === 'comparisons' && 'comparisons' in page ? page.comparisons : null
    if (!Array.isArray(values)) throw new Error(`The analysis service returned an invalid ${field} page.`)
    if (limits) {
      bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength
      if (items.length + values.length > limits.maxItems || bytes > limits.maxBytes) {
        throw new Error('The saved analysis inventory exceeds the report item or byte budget. Narrow the export; no comparisons were silently omitted.')
      }
      if (values.length > 100 ||
        (page.continuationToken !== undefined && (typeof page.continuationToken !== 'string' ||
          !page.continuationToken || page.continuationToken.length > 16 * 1024))) {
        throw new Error('The analysis service returned a malformed inventory page.')
      }
      if (field === 'comparisons') for (const value of values as RealAnalysisComparisonSummary[]) {
        const id = value?.comparison?.id
        if (typeof id !== 'string' || !id) throw new Error('The analysis service returned an inventory comparison without an ID.')
        if (itemIds.has(id)) throw new Error('The analysis service returned a repeated comparison ID or inventory page.')
        itemIds.add(id)
      }
    }
    items.push(...values as T[])
    continuationToken = page.continuationToken
    if (continuationToken) {
      if (seen.has(continuationToken)) throw new Error('The analysis service returned a repeated continuation token.')
      seen.add(continuationToken)
    }
  } while (continuationToken)
  return items
}

export async function listAllRealAnalyses(workspaceId: string, signal?: AbortSignal): Promise<RealAnalysisRunSummary[]> {
  return (await collect<RealAnalysisRunSummary>(base(workspaceId), 'runs', signal)).map((value) => checkedRun(value, workspaceId))
}

export async function listAllRealAnalysisTargets(workspaceId: string, signal?: AbortSignal): Promise<RealAnalysisTargetSummary[]> {
  const targets = await collect<RealAnalysisTargetSummary>(`${base(workspaceId)}/targets`, 'targets', signal)
  if (targets.some((target) => target.dataKind !== 'real' || target.workspaceId !== workspaceId
    || !target.selection || target.kind !== target.selection.kind)) {
    throw new Error('The eligible-target service returned invalid or mixed-workspace inputs. No targets were substituted.')
  }
  return targets
}

export async function getRealAnalysis(workspaceId: string, runId: string, signal?: AbortSignal): Promise<RealAnalysisRunDetail> {
  const detail = await cloudJsonRequest<RealAnalysisRunDetail>(base(workspaceId, runId), { method: 'GET', signal })
  checkedRun(detail, workspaceId)
  if (detail.run.id !== runId || !Array.isArray(detail.resumes) || !Array.isArray(detail.targets)) {
    throw new Error('The analysis service returned an invalid saved-input manifest.')
  }
  if (detail.resumes.some((item) => item.dataKind !== 'real' || item.workspaceId !== workspaceId)
    || detail.targets.some((item) => item.dataKind !== 'real' || item.workspaceId !== workspaceId)) {
    throw new Error('The saved analysis manifest contains mixed or foreign-workspace inputs.')
  }
  return detail
}

export async function listAllRealAnalysisComparisons(
  workspaceId: string, runId: string, signal?: AbortSignal, limits?: RealAnalysisCollectionLimits,
): Promise<RealAnalysisComparisonSummary[]> {
  return (await collect<RealAnalysisComparisonSummary>(pairs(workspaceId, runId), 'comparisons', signal, limits))
    .map((value) => checkedComparison(value, workspaceId, runId))
}

export async function getRealAnalysisComparison(workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal): Promise<RealAnalysisComparisonDetail> {
  const detail = await cloudJsonRequest<RealAnalysisComparisonDetail>(pairs(workspaceId, runId, comparisonId), { method: 'GET', signal })
  checkedComparison(detail, workspaceId, runId)
  if (detail.comparison.id !== comparisonId || detail.resumeSnapshot?.dataKind !== 'real' || detail.targetSnapshot?.dataKind !== 'real'
    || detail.resumeSnapshot.workspaceId !== workspaceId || detail.targetSnapshot.workspaceId !== workspaceId
    || detail.resumeSnapshot.document?.sample !== false || detail.resumeSnapshot.document.kind !== 'resume'
    || (detail.targetSnapshot.kind === 'job' ? detail.targetSnapshot.document?.sample !== false || detail.targetSnapshot.rubric?.dataKind !== 'real'
      : detail.targetSnapshot.kind !== 'grade' || detail.targetSnapshot.version?.rubric?.dataKind !== 'real' || detail.targetSnapshot.seed?.document?.sample !== false)
    || (detail.result && (detail.result.dataKind !== 'real' || detail.result.workspaceId !== workspaceId || detail.result.runId !== runId || detail.result.comparisonId !== comparisonId))) {
    throw new Error('The saved comparison snapshots or result do not match this real analysis.')
  }
  return detail
}

export async function getRealAnalysisDocument(workspaceId: string, runId: string, comparisonId: string, documentId: string, version: number, signal?: AbortSignal): Promise<RealAnalysisDocumentResponse['document']> {
  if (!comparisonId?.trim()) throw new Error('An exact saved comparison is required to open its evidence.')
  if (!Number.isInteger(version) || version < 1) throw new Error('An exact saved document version is required.')
  const result = await cloudJsonRequest<RealAnalysisDocumentResponse>(
    `${pairs(workspaceId, runId, comparisonId)}/documents/${encodeURIComponent(documentId)}?version=${version}`, { method: 'GET', signal },
  )
  if (result.document?.sample !== false || result.document.id !== documentId || result.document.version !== version) {
    throw new Error('The service did not return the exact saved document. No live source is substituted.')
  }
  return result.document
}

function diagnosticText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function diagnosticCount(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function diagnosticHash(value: unknown): boolean { return typeof value === 'string' && /^[\da-f]{64}$/i.test(value) }
function diagnosticCursor(value: unknown): value is string { return diagnosticText(value) && value.length <= 16 * 1024 }

function diagnosticProvenance(value: AnalysisModelProvenance): boolean {
  return Boolean(value && diagnosticText(value.model) && diagnosticText(value.deployment) && diagnosticText(value.promptVersion)
    && diagnosticText(value.schemaVersion) && diagnosticText(value.startedAt) && diagnosticText(value.completedAt)
    && diagnosticCount(value.inputCharacters))
}

function diagnosticCitations(values: Citation[]): boolean {
  return Array.isArray(values) && values.every((value) => value && diagnosticText(value.documentId)
    && diagnosticCount(value.documentVersion) && value.documentVersion > 0 && diagnosticText(value.paragraphId)
    && diagnosticCount(value.page) && value.page > 0 && typeof value.heading === 'string' && diagnosticText(value.quote))
}

function checkedDiagnostic(value: AnalysisFailureDiagnostic, workspaceId: string, runId: string, comparisonId: string) {
  if (!value || value.schemaVersion !== 1 || value.dataKind !== 'real' || value.workspaceId !== workspaceId
    || value.runId !== runId || value.comparisonId !== comparisonId || !diagnosticText(value.attemptId)
    || !diagnosticText(value.createdAt) || !diagnosticText(value.pipelineVersion) || !diagnosticHash(value.manifestSha256)
    || !diagnosticText(value.resumeSnapshot?.snapshotId) || !diagnosticHash(value.resumeSnapshot?.sha256)
    || !diagnosticText(value.targetSnapshot?.snapshotId) || !diagnosticHash(value.targetSnapshot?.sha256)) {
    throw new Error('The diagnostic service did not return an exact saved attempt for this workspace, run, and comparison.')
  }
  if (!diagnosticCount(value.processingAttempt) || value.processingAttempt < 1 || !diagnosticCount(value.retryCount)
    || !diagnosticCount(value.correctionCount) || value.correctionCount > ANALYSIS_LIMITS.maxOutputCorrections
    || !value.error || !['initialization', 'assessment', 'grounding', 'publication'].includes(value.error.stage)
    || !['invalid-input', 'stale-input', 'snapshot-unavailable', 'snapshot-invalid', 'context-limit', 'invalid-model-output',
      'invalid-citation', 'grounding-failed', 'service-unavailable', 'storage-error', 'timeout', 'internal-error'].includes(value.error.code)
    || !diagnosticText(value.error.message) || typeof value.error.retryable !== 'boolean'
    || (value.reason !== undefined && !ANALYSIS_DIAGNOSTIC_REASONS.includes(value.reason))
    || !Array.isArray(value.events) || value.events.length > ANALYSIS_DIAGNOSTIC_LIMITS.maxEvents || !diagnosticCount(value.omittedEvents)
    || !Array.isArray(value.assessments) || value.assessments.length > ANALYSIS_LIMITS.maxOutputCorrections + 1
    || value.assessments.some((cycle) => !cycle || !diagnosticText(cycle.modelCallId) || !diagnosticHash(cycle.assessmentSha256)
      || !diagnosticCount(cycle.correctionCount) || cycle.correctionCount > value.correctionCount || !diagnosticProvenance(cycle.provenance)
      || !cycle.assessment || typeof cycle.assessment.summary !== 'string'
      || !Array.isArray(cycle.assessment.criteria) || !Array.isArray(cycle.assessment.qualifications)
      || !Array.isArray(cycle.assessment.limitations) || cycle.assessment.limitations.some((item) => !item || !diagnosticText(item.message))
      || cycle.assessment.criteria.some((item) => !item || !diagnosticText(item.criterionId) || !diagnosticText(item.rationale))
      || cycle.assessment.qualifications.some((item) => !item || !diagnosticText(item.qualificationId) || !diagnosticText(item.rationale))
      || (cycle.review !== undefined && (!cycle.review || !diagnosticText(cycle.review.id) || !diagnosticProvenance(cycle.review.provenance)
        || cycle.review.assessmentSha256 !== cycle.assessmentSha256 || cycle.review.resumeSnapshotSha256 !== value.resumeSnapshot.sha256
        || cycle.review.targetSnapshotSha256 !== value.targetSnapshot.sha256
        || !['supported', 'needs-correction', 'unsupported'].includes(cycle.review.outcome)
        || !Array.isArray(cycle.review.issues)
        || cycle.review.issues.some((issue) => !issue || !diagnosticText(issue.code) || !diagnosticText(issue.message)
          || (issue.criterionId !== undefined && !diagnosticText(issue.criterionId))
          || (issue.qualificationId !== undefined && !diagnosticText(issue.qualificationId))
          || !diagnosticCitations(issue.citations)))))) {
    throw new Error('The diagnostic service returned an invalid or unbounded saved diagnostic. No draft was shown.')
  }
  const citations = value.citationDiagnostics
  const schema = value.schemaDiagnostics
  if ((citations && (!Array.isArray(citations.findings) || citations.findings.length > ANALYSIS_DIAGNOSTIC_LIMITS.maxFindings
    || !diagnosticCount(citations.omittedFindings) || citations.findings.some((finding) => !finding || !diagnosticText(finding.reason)
      || (finding.criterionId !== undefined && !diagnosticText(finding.criterionId))
      || (finding.qualificationId !== undefined && !diagnosticText(finding.qualificationId))
      || (finding.paragraphId !== undefined && !diagnosticText(finding.paragraphId))
      || (finding.passageId !== undefined && !diagnosticCount(finding.passageId))
      || (finding.citationIndex !== undefined && !diagnosticCount(finding.citationIndex)))))
    || (schema && (!Array.isArray(schema.findings) || schema.findings.length > ANALYSIS_DIAGNOSTIC_LIMITS.maxFindings
      || !diagnosticCount(schema.omittedFindings) || schema.findings.some((finding) => !finding || !diagnosticText(finding.code)
        || !Array.isArray(finding.path) || finding.path.length > ANALYSIS_DIAGNOSTIC_LIMITS.maxPathSegments
        || finding.path.some((segment) => !diagnosticText(segment) && !diagnosticCount(segment)))))) {
    throw new Error('The diagnostic service returned malformed validation findings. No diagnostic was shown.')
  }
}

export async function getRealAnalysisDiagnostics(
  workspaceId: string, runId: string, comparisonId: string, continuationToken?: string, signal?: AbortSignal,
): Promise<RealAnalysisDiagnosticsPage> {
  signal?.throwIfAborted()
  if (![workspaceId, runId, comparisonId].every(diagnosticText)) throw new Error('An exact workspace, run, and comparison are required to open private diagnostics.')
  if (continuationToken !== undefined && !diagnosticCursor(continuationToken)) throw new Error('The saved diagnostic continuation is invalid. Reopen the latest attempt.')
  const query = continuationToken === undefined ? '' : `?continuationToken=${encodeURIComponent(continuationToken)}`
  const page = await cloudJsonRequest<RealAnalysisDiagnosticsPage>(`${pairs(workspaceId, runId, comparisonId)}/diagnostics${query}`, { method: 'GET', signal })
  signal?.throwIfAborted()
  if (!page || !Array.isArray(page.attempts) || page.attempts.length > 1
    || (page.continuationToken !== undefined && (!diagnosticCursor(page.continuationToken) || page.attempts.length !== 1))) {
    throw new Error('The diagnostic service returned an invalid history page. Only one saved attempt may be loaded at a time.')
  }
  if (page.continuationToken !== undefined && page.continuationToken === continuationToken) {
    throw new Error('The diagnostic service returned a repeated continuation token. Reopen the latest attempt.')
  }
  for (const attempt of page.attempts) checkedDiagnostic(attempt, workspaceId, runId, comparisonId)
  return page
}

export interface RealAnalysisSubmission {
  readonly result: Promise<RealAnalysisRunSummary>
  readonly retry: () => Promise<RealAnalysisRunSummary>
}

export async function createRealAnalysis(workspaceId: string, input: CreateRealAnalysisInput, key: string, settings?: PublicSettings | null): Promise<RealAnalysisRunSummary> {
  return startRealAnalysisSubmission(workspaceId, input, key, settings).result
}

export function startRealAnalysisSubmission(workspaceId: string, input: CreateRealAnalysisInput, key: string, settings?: PublicSettings | null): RealAnalysisSubmission {
  requireAdmission(settings, 'newAnalyses')
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(key)) throw new Error('A stable UUID idempotency key is required for an analysis.')
  if (!input.resumes.length || !input.targets.length) throw new Error('Select at least one ready real resume and one eligible real target.')
  const maximum = Math.min(ANALYSIS_LIMITS.maxComparisons, settings?.analyses.maxComparisons ?? ANALYSIS_LIMITS.maxComparisons)
  if (input.resumes.length * input.targets.length > maximum) {
    throw new Error(`An analysis can contain at most ${maximum} comparisons. Nothing was truncated.`)
  }
  const hash = (value: string) => /^[\da-f]{64}$/i.test(value)
  const positive = (value: number) => Number.isInteger(value) && value > 0
  const resumes = input.resumes.map((item) => {
    if (!item.resumeId || !item.documentId || !positive(item.documentVersion) || !hash(item.documentSha256)) throw new Error('Select an exact ready resume document ID, version, and hash.')
    return { resumeId: item.resumeId, documentId: item.documentId, documentVersion: item.documentVersion, documentSha256: item.documentSha256 }
  })
  const targets = input.targets.map((item): RealAnalysisTargetSelection => {
    if (item.kind === 'job') {
      if (!item.jobId || !item.rubricId || !positive(item.rubricVersion) || !hash(item.rubricHash) || !item.documentId || !positive(item.documentVersion) || !hash(item.documentSha256)) {
        throw new Error('Select an exact saved real job rubric and source version.')
      }
      return { kind: 'job', jobId: item.jobId, rubricId: item.rubricId, rubricVersion: item.rubricVersion, rubricHash: item.rubricHash,
        documentId: item.documentId, documentVersion: item.documentVersion, documentSha256: item.documentSha256 }
    }
    if (item.kind !== 'grade' || !item.ladderId || !positive(item.grade) || item.grade > 15 || !item.versionId || !positive(item.version)
      || !hash(item.versionHash) || !item.approvalId || !item.reviewId || !item.sourceSetId || !hash(item.sourceSetHash)) {
      throw new Error('Select an exact approved GS version, review, and frozen source set.')
    }
    return { kind: 'grade', ladderId: item.ladderId, grade: item.grade, versionId: item.versionId, version: item.version,
      versionHash: item.versionHash, approvalId: item.approvalId, reviewId: item.reviewId, sourceSetId: item.sourceSetId, sourceSetHash: item.sourceSetHash }
  })
  if (new Set(resumes.map((item) => item.resumeId)).size !== resumes.length
    || new Set(targets.map((item) => item.kind === 'job' ? `job:${item.jobId}:${item.rubricId}:${item.rubricVersion}`
      : `grade:${item.ladderId}:${item.grade}:${item.versionId}:${item.version}`)).size !== targets.length) {
    throw new Error('Select each real resume and target only once. Duplicates were not silently removed.')
  }
  const body = JSON.stringify({ name: input.name, resumes, targets })
  // Setting up a large run can outlast one try; unanswered tries resend the same bytes and key.
  const send = async () => {
    const result = await cloudIdempotentJsonRequest<RealAnalysisMutationResponse>(base(workspaceId), {
      method: 'POST', headers: { 'Idempotency-Key': key }, body,
    }, {
      ...ANALYSIS_SUBMISSION_WAIT,
      pendingMessage: 'Score still hasn’t confirmed that this analysis started. It may still be starting.',
    })
    return checkedRun(result.run, workspaceId)
  }
  // Only a started, validated request exposes recovery; the server decides whether it was already accepted.
  return { result: send(), retry: send }
}

export async function retryRealAnalysis(workspaceId: string, runId: string, input: RetryRealAnalysisInput, etag: string): Promise<RealAnalysisRunSummary> {
  const result = await cloudJsonRequest<RealAnalysisMutationResponse>(`${base(workspaceId, runId)}/retry`, {
    method: 'POST', headers: concurrency(etag), body: JSON.stringify(input),
  })
  return checkedRun(result.run, workspaceId)
}

export async function renameRealAnalysis(workspaceId: string, runId: string, name: string, etag: string): Promise<RealAnalysisRunSummary> {
  const displayName = normalizeDisplayName(name)
  if (!etag) throw new Error('Reload the analysis before editing its name.')
  const result = await cloudJsonRequest<RealAnalysisMutationResponse>(`${base(workspaceId, runId)}/metadata`, {
    method: 'PATCH', headers: concurrency(etag), body: JSON.stringify({ displayName }),
  })
  const summary = checkedRun(result.run, workspaceId)
  if (summary.run.id !== runId || summary.run.displayName !== displayName) throw new Error('The service did not acknowledge the requested analysis name. Reload before trying again.')
  return summary
}

export async function cancelRealAnalysis(workspaceId: string, runId: string, etag: string): Promise<RealAnalysisRunSummary> {
  const result = await cloudJsonRequest<RealAnalysisMutationResponse>(`${base(workspaceId, runId)}/cancel`, { method: 'POST', headers: concurrency(etag) })
  return checkedRun(result.run, workspaceId)
}

async function comparisonAction(workspaceId: string, runId: string, comparisonId: string, action: 'retry' | 'cancel', etag: string): Promise<RealAnalysisComparisonSummary> {
  const result = await cloudJsonRequest<RealComparisonMutationResponse>(`${pairs(workspaceId, runId, comparisonId)}/${action}`, {
    method: 'POST', headers: concurrency(etag),
  })
  return checkedComparison(result.comparison, workspaceId, runId)
}

export function retryRealAnalysisComparison(workspaceId: string, runId: string, comparisonId: string, etag: string): Promise<RealAnalysisComparisonSummary> {
  return comparisonAction(workspaceId, runId, comparisonId, 'retry', etag)
}

export function cancelRealAnalysisComparison(workspaceId: string, runId: string, comparisonId: string, etag: string): Promise<RealAnalysisComparisonSummary> {
  return comparisonAction(workspaceId, runId, comparisonId, 'cancel', etag)
}

export interface RealAnalysisLifecycleResponse {
  analysis?: RealAnalysisRunDetail
  deleted?: true
  operation?: LifecycleOperation
  etag?: string
}

export async function getRealAnalysisLifecycleImpact(workspaceId: string, runId: string, signal?: AbortSignal): Promise<LifecycleImpact> {
  const result = await cloudJsonRequest<{ impact: LifecycleImpact }>(`${base(workspaceId, runId)}/lifecycle`, { signal })
  return result.impact
}

export async function changeRealAnalysisLifecycle(workspaceId: string, runId: string, action: LifecycleAction, etag: string): Promise<RealAnalysisLifecycleResponse> {
  if (!etag) throw new Error('Reload the exact run version before changing its lifecycle.')
  const result = await cloudLifecycleRequest<RealAnalysisLifecycleResponse>(`${base(workspaceId, runId)}/lifecycle`, {
    method: 'POST', headers: { 'If-Match': etag }, body: JSON.stringify({ action }),
  })
  if (result.value.analysis) {
    checkedRun(result.value.analysis, workspaceId)
    if (result.value.analysis.run.id !== runId) throw new Error('The lifecycle response belongs to another analysis.')
  }
  return { ...result.value, etag: result.value.etag ?? result.etag }
}
