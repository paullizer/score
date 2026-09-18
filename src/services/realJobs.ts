import type { Rubric } from '../domain/types'
import {
  JOB_IMPORT_LIMITS,
  type JobProcessingFeatures,
  type RealJobDetail,
  type RealJobsPage,
  type RealJobSummary,
} from '../domain/real-jobs'
import { cloudJsonRequest } from './cloudWorkspace'
import { UPLOAD_CONTENT_TYPES, type UploadFormat } from '../domain/document-formats'
import { requireUploadFile } from './documentUploads'

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
    wordDocumentImports: features.wordDocumentImports === true,
    limits: {
      ...JOB_IMPORT_LIMITS,
      ...features.limits,
      maxFileBytes: features.limits?.maxFileBytes ?? features.limits?.maxPdfBytes ?? JOB_IMPORT_LIMITS.maxFileBytes,
    },
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
  requireUploadFile(file, ['pdf'])
  return importFile(workspaceId, file, 'pdf', idempotencyKey, batchId, signal)
}

export async function importRealJobFile(
  workspaceId: string,
  file: File,
  idempotencyKey: string,
  batchId?: string,
  signal?: AbortSignal,
): Promise<RealJobSummary> {
  return importFile(workspaceId, file, requireUploadFile(file), idempotencyKey, batchId, signal)
}

async function importFile(
  workspaceId: string,
  file: File,
  format: UploadFormat,
  idempotencyKey: string,
  batchId?: string,
  signal?: AbortSignal,
): Promise<RealJobSummary> {
  const headers = new Headers({
    'Content-Type': UPLOAD_CONTENT_TYPES[format],
    'X-File-Name': encodeURIComponent(file.name),
    'Idempotency-Key': idempotencyKey,
  })
  if (batchId) headers.set('X-Import-Batch', batchId)
  signal?.throwIfAborted()
  const bytes = await file.arrayBuffer()
  signal?.throwIfAborted()
  const response = await cloudJsonRequest<{ job: RealJobWireSummary }>(`${jobsPath(workspaceId)}/${format === 'pdf' ? 'pdf' : 'file'}`, {
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
