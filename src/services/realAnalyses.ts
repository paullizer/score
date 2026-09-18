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

export async function fetchAnalysisProcessingFeatures(signal?: AbortSignal): Promise<AnalysisProcessingFeatures> {
  // realAnalyses indicates new-run readiness; historical reads have their own authorized endpoints.
  const result = await cloudJsonRequest<Partial<AnalysisProcessingFeatures>>('/features', { method: 'GET', signal })
  return { realAnalyses: result.realAnalyses === true, analysisLimits: result.analysisLimits ?? ANALYSIS_LIMITS }
}

async function collect<T>(path: string, field: 'runs' | 'targets' | 'comparisons', signal?: AbortSignal): Promise<T[]> {
  const items: T[] = []
  const seen = new Set<string>()
  let continuationToken: string | undefined
  do {
    const query = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : ''
    const page = await cloudJsonRequest<RealAnalysesPage | RealAnalysisTargetsPage | RealAnalysisComparisonsPage>(`${path}${query}`, { method: 'GET', signal })
    const values = field === 'runs' && 'runs' in page ? page.runs : field === 'targets' && 'targets' in page ? page.targets
      : field === 'comparisons' && 'comparisons' in page ? page.comparisons : null
    if (!Array.isArray(values)) throw new Error(`The analysis service returned an invalid ${field} page.`)
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

export async function listAllRealAnalysisComparisons(workspaceId: string, runId: string, signal?: AbortSignal): Promise<RealAnalysisComparisonSummary[]> {
  return (await collect<RealAnalysisComparisonSummary>(pairs(workspaceId, runId), 'comparisons', signal))
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
