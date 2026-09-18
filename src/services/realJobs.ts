import type { Rubric } from '../domain/types'
import {
  JOB_IMPORT_LIMITS,
  type JobProcessingFeatures,
  type RealJobDetail,
  type RealJobsPage,
  type RealJobSummary,
} from '../domain/real-jobs'
import { cloudJsonRequest, cloudLifecycleRequest } from './cloudWorkspace'
import type { LifecycleAction, LifecycleImpact, LifecycleOperation } from '../domain/lifecycle'

type RealJobWireSummary = RealJobSummary

interface RealJobWireDetail extends RealJobWireSummary {
  document: RealJobDetail['document']
  rubricVersions: Rubric[]
}

function jobsPath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/jobs`
}

function normalizeSummary(summary: RealJobWireSummary): RealJobSummary {
  return summary
}

export async function fetchJobProcessingFeatures(signal?: AbortSignal): Promise<JobProcessingFeatures> {
  const features = await cloudJsonRequest<JobProcessingFeatures>('/features', { method: 'GET', signal })
  return {
    realJobImports: features.realJobImports === true,
    limits: features.limits ?? JOB_IMPORT_LIMITS,
  }
}

export async function listAllRealJobs(workspaceId: string, signal?: AbortSignal): Promise<RealJobSummary[]> {
  const jobs: RealJobSummary[] = []
  const seenTokens = new Set<string>()
  let continuationToken: string | undefined
  do {
    const query = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : ''
    const page = await cloudJsonRequest<Omit<RealJobsPage, 'jobs'> & { jobs: RealJobWireSummary[] }>(
      `${jobsPath(workspaceId)}${query}`,
      { method: 'GET', signal },
    )
    jobs.push(...page.jobs.map(normalizeSummary))
    continuationToken = page.continuationToken
    if (continuationToken) {
      if (seenTokens.has(continuationToken)) throw new Error('The jobs service returned a repeated continuation token.')
      seenTokens.add(continuationToken)
    }
  } while (continuationToken)
  return jobs
}

export async function getRealJob(workspaceId: string, jobId: string, signal?: AbortSignal): Promise<RealJobDetail> {
  const detail = await cloudJsonRequest<RealJobWireDetail>(
    `${jobsPath(workspaceId)}/${encodeURIComponent(jobId)}`,
    { method: 'GET', signal },
  )
  return { ...normalizeSummary(detail), document: detail.document, rubricVersions: detail.rubricVersions }
}

export async function importRealJobPdf(
  workspaceId: string,
  file: File,
  idempotencyKey: string,
  batchId?: string,
  signal?: AbortSignal,
): Promise<RealJobSummary> {
  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'X-File-Name': encodeURIComponent(file.name),
    'Idempotency-Key': idempotencyKey,
  })
  if (batchId) headers.set('X-Import-Batch', batchId)
  const bytes = await file.arrayBuffer()
  const response = await cloudJsonRequest<{ job: RealJobWireSummary }>(`${jobsPath(workspaceId)}/pdf`, {
    method: 'POST',
    headers,
    body: bytes,
    signal,
  })
  return normalizeSummary(response.job)
}

export async function importRealJobUrl(
  workspaceId: string,
  url: string,
  idempotencyKey: string,
  batchId?: string,
  signal?: AbortSignal,
): Promise<RealJobSummary> {
  const headers = new Headers({ 'Idempotency-Key': idempotencyKey })
  const response = await cloudJsonRequest<{ job: RealJobWireSummary }>(`${jobsPath(workspaceId)}/url`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url, ...(batchId ? { batchId } : {}) }),
    signal,
  })
  return normalizeSummary(response.job)
}

export async function retryRealJob(workspaceId: string, jobId: string, signal?: AbortSignal): Promise<RealJobSummary> {
  const response = await cloudJsonRequest<{ job: RealJobWireSummary }>(
    `${jobsPath(workspaceId)}/${encodeURIComponent(jobId)}/retry`,
    { method: 'POST', signal },
  )
  return normalizeSummary(response.job)
}

export async function cancelRealJob(workspaceId: string, jobId: string, signal?: AbortSignal): Promise<RealJobSummary> {
  const response = await cloudJsonRequest<{ job: RealJobWireSummary }>(
    `${jobsPath(workspaceId)}/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST', signal },
  )
  return normalizeSummary(response.job)
}

export async function saveRealJobRubric(
  workspaceId: string,
  jobId: string,
  rubric: Rubric,
  etag: string,
  signal?: AbortSignal,
): Promise<RealJobDetail> {
  const headers = new Headers({ 'If-Match': etag })
  const response = await cloudJsonRequest<{ job: RealJobWireDetail }>(
    `${jobsPath(workspaceId)}/${encodeURIComponent(jobId)}/rubric`,
    { method: 'PUT', headers, body: JSON.stringify({ rubric }), signal },
  )
  const detail = response.job
  return { ...normalizeSummary(detail), document: detail.document, rubricVersions: detail.rubricVersions }
}

export function realJobOriginalUrl(workspaceId: string, jobId: string): string {
  return `/api${jobsPath(workspaceId)}/${encodeURIComponent(jobId)}/original`
}

export async function getRealJobLifecycleImpact(workspaceId: string, jobId: string, scope: 'job' | 'rubric', signal?: AbortSignal): Promise<LifecycleImpact> {
  const result = await cloudJsonRequest<{ impact: LifecycleImpact }>(`${jobsPath(workspaceId)}/${encodeURIComponent(jobId)}/lifecycle?scope=${scope}`, { signal })
  return result.impact
}

export async function changeRealJobLifecycle(workspaceId: string, jobId: string, scope: 'job' | 'rubric', action: LifecycleAction, etag: string): Promise<{ job?: RealJobDetail; deleted?: true; operation?: LifecycleOperation }> {
  const result = await cloudLifecycleRequest<{ job?: RealJobDetail; deleted?: true; operation?: LifecycleOperation }>(`${jobsPath(workspaceId)}/${encodeURIComponent(jobId)}/lifecycle`, {
    method: 'POST', headers: { 'If-Match': etag }, body: JSON.stringify({ action, scope }),
  })
  return result.value
}
