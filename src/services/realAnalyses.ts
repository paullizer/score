import { z } from 'zod'
import {
  ANALYSIS_LIMITS,
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
  type RealAnalysisSummariesQuery, type RealAnalysisSummariesResponse,
} from '../domain/analysis-narratives'
import { cloudJsonRequest, cloudLifecycleRequest } from './cloudWorkspace'
import type { LifecycleAction, LifecycleImpact, LifecycleOperation } from '../domain/lifecycle'

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
    throw new Error('The analysis service did not return a real run for this workspace. No sample was substituted.')
  }
  return value
}

function checkedComparison(value: RealAnalysisComparisonSummary, workspaceId: string, runId: string): RealAnalysisComparisonSummary {
  if (!value?.comparison?.id || value.comparison.dataKind !== 'real' || value.comparison.workspaceId !== workspaceId
    || value.comparison.runId !== runId || !value.etag) {
    throw new Error('The analysis service did not return a real comparison for the requested run.')
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
  error: z.object({
    code: z.enum(['invalid-input', 'stale-input', 'snapshot-unavailable', 'snapshot-invalid', 'context-limit', 'invalid-model-output',
      'invalid-citation', 'grounding-failed', 'service-unavailable', 'storage-error', 'timeout', 'internal-error', 'dependency-failed']),
    stage: z.enum(['dependencies', 'candidate-generation', 'target-generation', 'grounding', 'publication']),
    message: z.string().min(1).max(16_000), retryable: z.boolean(),
  }).nullable(),
})
const summariesEnvelope: z.ZodType<RealAnalysisSummariesResponse> = z.object({
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId: narrativeId, runId: narrativeId,
  scope: narrativeScope, revision: narrativeHash, etag: narrativeId, ready: z.boolean(),
  scoring: z.object({
    total: narrativeCount, initialized: narrativeCount, queued: narrativeCount, running: narrativeCount,
    complete: narrativeCount, failed: narrativeCount, cancelled: narrativeCount,
  }),
  counts: z.object({ candidates: narrativeCounts, targets: narrativeCounts }),
  capabilities: z.object({
    canGenerate: z.boolean(), reason: z.enum(['read-only', 'archived', 'deleting', 'cancelling', 'service-unavailable']).nullable(),
  }),
  comparisons: z.array(narrativeState.extend({
    kind: z.literal('candidate'), comparisonId: narrativeId, comparisonStatus,
    published: narrativePublication.extend({
      text: z.string().min(1).max(ANALYSIS_NARRATIVE_LIMITS.candidateMaxCharacters),
      overview: z.string().min(1).max(ANALYSIS_NARRATIVE_LIMITS.overviewMaxCharacters),
    }).nullable(),
  })).max(ANALYSIS_LIMITS.maxComparisons),
  targets: z.array(narrativeState.extend({
    kind: z.literal('target'), published: narrativePublication.extend({
      paragraphs: z.array(z.string().min(1).max(ANALYSIS_NARRATIVE_LIMITS.targetParagraphMaxCharacters))
        .min(1).max(ANALYSIS_NARRATIVE_LIMITS.targetMaxParagraphs),
    }).nullable(),
  })).max(ANALYSIS_LIMITS.maxComparisons),
  capture: z.object({
    dataKind: z.literal('real'), scope: narrativeScope, revision: narrativeHash, ready: z.boolean(),
    comparisons: z.array(z.object({
      comparisonId: narrativeId, targetId: narrativeId, status: comparisonStatus,
      resultSha256: narrativeHash.nullable(), narrative: narrativeRevision.nullable(),
    })).max(ANALYSIS_LIMITS.maxComparisons),
    targets: z.array(z.object({ targetId: narrativeId, narrative: narrativeRevision.nullable() })).max(ANALYSIS_LIMITS.maxComparisons),
  }),
})

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
    value.comparisons.some((item) => !targets.has(item.targetId)) ||
    value.counts.candidates.total !== value.comparisons.length || value.counts.targets.total !== value.targets.length ||
    new Set(capture.targets.map((item) => item.targetId)).size !== targets.size ||
    capture.targets.length !== targets.size || capture.targets.some((item) => !targets.has(item.targetId)) ||
    capture.comparisons.length !== comparisons.size || new Set(capture.comparisons.map((item) => item.comparisonId)).size !== comparisons.size ||
    capture.comparisons.some((item) => {
      const comparison = comparisons.get(item.comparisonId)
      return !comparison || comparison.targetId !== item.targetId || comparison.comparisonStatus !== item.status ||
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

export async function fetchAnalysisProcessingFeatures(signal?: AbortSignal): Promise<AnalysisProcessingFeatures> {
  // realAnalyses indicates new-run readiness; historical reads have their own authorized endpoints.
  const result = await cloudJsonRequest<Partial<AnalysisProcessingFeatures>>('/features', { method: 'GET', signal })
  return { realAnalyses: result.realAnalyses === true, analysisLimits: result.analysisLimits ?? ANALYSIS_LIMITS,
    analysisSummaryGeneration: result.analysisSummaryGeneration === true }
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
    throw new Error('The service did not return the exact saved document. No live or sample source is substituted.')
  }
  return result.document
}

export async function createRealAnalysis(workspaceId: string, input: CreateRealAnalysisInput, key: string): Promise<RealAnalysisRunSummary> {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(key)) throw new Error('A stable UUID idempotency key is required for an analysis.')
  if (!input.resumes.length || !input.targets.length) throw new Error('Select at least one ready real resume and one eligible real target.')
  if (input.resumes.length * input.targets.length > ANALYSIS_LIMITS.maxComparisons) {
    throw new Error(`An analysis can contain at most ${ANALYSIS_LIMITS.maxComparisons} comparisons. Nothing was truncated.`)
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
  const result = await cloudJsonRequest<RealAnalysisMutationResponse>(base(workspaceId), {
    method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ name: input.name, resumes, targets }),
  })
  return checkedRun(result.run, workspaceId)
}

export async function retryRealAnalysis(workspaceId: string, runId: string, input: RetryRealAnalysisInput, etag: string): Promise<RealAnalysisRunSummary> {
  const result = await cloudJsonRequest<RealAnalysisMutationResponse>(`${base(workspaceId, runId)}/retry`, {
    method: 'POST', headers: concurrency(etag), body: JSON.stringify(input),
  })
  return checkedRun(result.run, workspaceId)
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
