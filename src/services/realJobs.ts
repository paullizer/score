import type { Rubric } from '../domain/types'
import {
  JOB_IMPORT_LIMITS,
  type JobProcessingFeatures,
  type RealJobDetail,
  type RealJobsPage,
  type RealJobSummary,
} from '../domain/real-jobs'
import { isSafeUploadedFilename, uploadedFileKind, type UploadedSourceKind } from '../domain/source-files'
import { cloudJsonRequest } from './cloudWorkspace'

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
  const features = await cloudJsonRequest<Partial<JobProcessingFeatures>>('/features', { method: 'GET', signal })
  return {
    realJobImports: features.realJobImports === true,
    markdownJobImports: features.realJobImports === true && features.markdownJobImports === true,
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

async function importRealJobUpload(
  workspaceId: string,
  file: File,
  kind: UploadedSourceKind,
  idempotencyKey: string,
  batchId?: string,
  signal?: AbortSignal,
): Promise<RealJobSummary> {
  const label = kind === 'markdown' ? 'Markdown' : 'PDF'
  // Job PDFs retain their legacy server-owned filename validation.
  if (uploadedFileKind(file) !== kind || (kind === 'markdown' && !isSafeUploadedFilename(file.name, kind))) {
    throw new Error(`Choose a ${label} file with a safe ${kind === 'markdown' ? '.md or .markdown' : '.pdf'} filename.`)
  }
  const maxBytes = kind === 'markdown' ? JOB_IMPORT_LIMITS.maxMarkdownBytes : JOB_IMPORT_LIMITS.maxPdfBytes
  if (!file.size || file.size > maxBytes) throw new Error(`Choose a nonempty ${label} file no larger than ${maxBytes / 1024 / 1024} MiB.`)
  const headers = new Headers({
    'Content-Type': kind === 'markdown' ? 'text/markdown' : 'application/pdf',
    'X-File-Name': encodeURIComponent(file.name),
    'Idempotency-Key': idempotencyKey,
  })
  if (batchId) headers.set('X-Import-Batch', batchId)
  const bytes = await file.arrayBuffer()
  const response = await cloudJsonRequest<{ job: RealJobWireSummary }>(`${jobsPath(workspaceId)}/${kind}`, {
    method: 'POST',
    headers,
    body: bytes,
    signal,
  })
  return normalizeSummary(response.job)
}

export function importRealJobPdf(
  workspaceId: string, file: File, idempotencyKey: string, batchId?: string, signal?: AbortSignal,
): Promise<RealJobSummary> {
  return importRealJobUpload(workspaceId, file, 'pdf', idempotencyKey, batchId, signal)
}

export function importRealJobMarkdown(
  workspaceId: string, file: File, idempotencyKey: string, batchId?: string, signal?: AbortSignal,
): Promise<RealJobSummary> {
  return importRealJobUpload(workspaceId, file, 'markdown', idempotencyKey, batchId, signal)
}

export async function importRealJobFile(
  workspaceId: string, file: File, idempotencyKey: string, batchId?: string, signal?: AbortSignal,
): Promise<RealJobSummary> {
  const kind = uploadedFileKind(file)
  if (!kind) throw new Error('Choose a PDF (.pdf) or Markdown (.md or .markdown) file. Other file types are not supported.')
  return importRealJobUpload(workspaceId, file, kind, idempotencyKey, batchId, signal)
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
