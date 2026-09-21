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
import { isSafeUploadedFilename, uploadedFileKind } from '../domain/source-files'
import { UPLOAD_CONTENT_TYPES, type UploadFormat } from '../domain/document-formats'
import { requireUploadFile, uploadFileByteLimit } from './documentUploads'
import { normalizeDisplayName } from '../domain/displayNames'
import type { PublicSettings } from '../domain/admin-settings'
import { fetchPublicFeatures, jobFeaturesWithPolicy, requireImportFile, requireImportUrl } from './publicSettings'

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
  const features = await fetchPublicFeatures(signal)
  return jobFeaturesWithPolicy({
    realJobImports: features.realJobImports === true,
    markdownJobImports: features.realJobImports === true && features.markdownJobImports === true,
    wordDocumentImports: features.realJobImports === true && features.wordDocumentImports === true,
    limits: {
      ...JOB_IMPORT_LIMITS,
      ...features.limits,
      maxFileBytes: Math.min(features.limits?.maxFileBytes ?? JOB_IMPORT_LIMITS.maxFileBytes, JOB_IMPORT_LIMITS.maxFileBytes),
    },
  }, features.publicSettings)
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
  kind: UploadFormat,
  idempotencyKey: string,
  batchId?: string,
  signal?: AbortSignal,
  settings?: PublicSettings | null,
): Promise<RealJobSummary> {
  requireImportFile(file, 'jobs', settings)
  const label = kind === 'markdown' ? 'Markdown' : kind.toUpperCase()
  const actualKind = uploadedFileKind(file)
  // Only legacy job PDF calls leave malformed PDF basenames to the server.
  if (actualKind !== kind && !(kind === 'pdf' && actualKind === undefined && file.type === 'application/pdf')) {
    throw new Error(`${actualKind?.toUpperCase() ?? 'Unsupported'} uploads are not enabled for this method. Choose a ${label} file with a safe ${kind === 'markdown' ? '.md or .markdown' : `.${kind}`} filename.`)
  }
  if (kind !== 'pdf' && !isSafeUploadedFilename(file.name, kind)) throw new Error(`Choose a ${label} file with a safe ${kind === 'markdown' ? '.md or .markdown' : `.${kind}`} filename.`)
  const maxBytes = uploadFileByteLimit(kind, JOB_IMPORT_LIMITS)
  if (!file.size || file.size > maxBytes) throw new Error(`Choose a nonempty ${label} file no larger than ${maxBytes / 1024 / 1024} MiB.`)
  if (kind === 'docx' || kind === 'doc') requireUploadFile(file, [kind])
  const headers = new Headers({
    'Content-Type': UPLOAD_CONTENT_TYPES[kind],
    'X-File-Name': encodeURIComponent(file.name),
    'Idempotency-Key': idempotencyKey,
  })
  if (batchId) headers.set('X-Import-Batch', batchId)
  signal?.throwIfAborted()
  const bytes = await file.arrayBuffer()
  signal?.throwIfAborted()
  const response = await cloudJsonRequest<{ job: RealJobWireSummary }>(`${jobsPath(workspaceId)}/${kind === 'pdf' || kind === 'markdown' ? kind : 'file'}`, {
    method: 'POST',
    headers,
    body: bytes,
    signal,
  })
  return normalizeSummary(response.job)
}

export function importRealJobPdf(
  workspaceId: string, file: File, idempotencyKey: string, batchId?: string, signal?: AbortSignal, settings?: PublicSettings | null,
): Promise<RealJobSummary> {
  return importRealJobUpload(workspaceId, file, 'pdf', idempotencyKey, batchId, signal, settings)
}

export function importRealJobMarkdown(
  workspaceId: string, file: File, idempotencyKey: string, batchId?: string, signal?: AbortSignal, settings?: PublicSettings | null,
): Promise<RealJobSummary> {
  return importRealJobUpload(workspaceId, file, 'markdown', idempotencyKey, batchId, signal, settings)
}

export async function importRealJobFile(
  workspaceId: string, file: File, idempotencyKey: string, batchId?: string, signal?: AbortSignal, settings?: PublicSettings | null,
): Promise<RealJobSummary> {
  const kind = uploadedFileKind(file) ?? (file.type === 'application/pdf' ? 'pdf' : undefined)
  if (!kind) throw new Error('Choose a supported file: PDF, Markdown (.md or .markdown), DOCX or DOC. Other formats are not supported.')
  return importRealJobUpload(workspaceId, file, kind, idempotencyKey, batchId, signal, settings)
}

export async function importRealJobUrl(
  workspaceId: string,
  url: string,
  idempotencyKey: string,
  batchId?: string,
  signal?: AbortSignal,
  settings?: PublicSettings | null,
): Promise<RealJobSummary> {
  requireImportUrl(url, 'jobs', settings)
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

export async function renameRealJob(workspaceId: string, jobId: string, name: string, etag: string): Promise<RealJobSummary> {
  const displayName = normalizeDisplayName(name)
  if (!etag) throw new Error('Reload the job before editing its display title.')
  const response = await cloudJsonRequest<{ job: RealJobWireSummary }>(
    `${jobsPath(workspaceId)}/${encodeURIComponent(jobId)}/metadata`,
    { method: 'PATCH', headers: { 'If-Match': etag }, body: JSON.stringify({ displayName }) },
  )
  const summary = response.job
  if (summary?.job?.id !== jobId || summary.job.dataKind !== 'real' || !summary.etag || summary.displayName !== displayName) {
    throw new Error('The service did not acknowledge the requested job title. Reload before trying again.')
  }
  return normalizeSummary(summary)
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
