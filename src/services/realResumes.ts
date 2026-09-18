import {
  RESUME_IMPORT_LIMITS,
  type RealResumeDetail,
  type RealResumeSummary,
  type RealResumesPage,
  type ResumeMutationResponse,
  type ResumeProcessingFeatures,
} from '../domain/real-resumes'
import { isSafeUploadedFilename, uploadedFileKind } from '../domain/source-files'
import { cloudJsonRequest, cloudLifecycleRequest } from './cloudWorkspace'
import type { LifecycleAction, LifecycleImpact, LifecycleOperation } from '../domain/lifecycle'
import { UPLOAD_CONTENT_TYPES, type UploadFormat } from '../domain/document-formats'
import { requireUploadFile, uploadFileByteLimit } from './documentUploads'

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

function base(workspaceId: string, resumeId?: string): string {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/resumes`
  return resumeId === undefined ? path : `${path}/${encodeURIComponent(resumeId)}`
}

function checked(summary: RealResumeSummary, workspaceId: string): RealResumeSummary {
  if (!summary?.resume?.id || summary.resume.dataKind !== 'real' || summary.workspaceId !== workspaceId || !summary.etag) {
    throw new Error('The resume service did not return a real record for this workspace. No sample was substituted.')
  }
  return summary
}

function importHeaders(key: string, batchId: string, inputCount: number): Record<string, string> {
  if (!uuid.test(key) || !uuid.test(batchId)) throw new Error('Resume imports need stable UUID request and batch keys.')
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > RESUME_IMPORT_LIMITS.maxBatchItems) {
    throw new Error(`Declare between 1 and ${RESUME_IMPORT_LIMITS.maxBatchItems} inputs for this batch. Nothing was truncated.`)
  }
  return { 'Idempotency-Key': key, 'X-Import-Batch': batchId, 'X-Import-Count': String(inputCount) }
}

export async function fetchResumeProcessingFeatures(signal?: AbortSignal): Promise<ResumeProcessingFeatures> {
  const features = await cloudJsonRequest<Partial<ResumeProcessingFeatures>>('/features', { method: 'GET', signal })
  return {
    realResumeImports: features.realResumeImports === true,
    markdownResumeImports: features.realResumeImports === true && features.markdownResumeImports === true,
    wordDocumentImports: features.realResumeImports === true && features.wordDocumentImports === true,
    resumeLimits: {
      ...RESUME_IMPORT_LIMITS,
      ...features.resumeLimits,
      maxFileBytes: Math.min(features.resumeLimits?.maxFileBytes ?? RESUME_IMPORT_LIMITS.maxFileBytes, RESUME_IMPORT_LIMITS.maxFileBytes),
    },
  }
}

export async function listAllRealResumes(workspaceId: string, signal?: AbortSignal): Promise<RealResumeSummary[]> {
  const items: RealResumeSummary[] = []
  const seen = new Set<string>()
  let continuationToken: string | undefined
  do {
    const query = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : ''
    const page = await cloudJsonRequest<RealResumesPage>(`${base(workspaceId)}${query}`, { method: 'GET', signal })
    if (!Array.isArray(page.resumes)) throw new Error('The resume service returned an invalid library page.')
    items.push(...page.resumes.map((item) => checked(item, workspaceId)))
    continuationToken = page.continuationToken
    if (continuationToken) {
      if (seen.has(continuationToken)) throw new Error('The resume service returned a repeated continuation token.')
      seen.add(continuationToken)
    }
  } while (continuationToken)
  return items
}

export async function getRealResume(workspaceId: string, resumeId: string, signal?: AbortSignal): Promise<RealResumeDetail> {
  const detail = await cloudJsonRequest<RealResumeDetail>(base(workspaceId, resumeId), { method: 'GET', signal })
  checked(detail, workspaceId)
  if (detail.resume.id !== resumeId || (detail.document && (detail.document.sample !== false || detail.document.kind !== 'resume'
    || detail.document.id !== detail.documentRef?.documentId || detail.document.version !== detail.documentRef?.documentVersion))) {
    throw new Error('The resume service did not return the requested saved source. No alternate document is shown.')
  }
  return detail
}

async function importRealResumeUpload(
  workspaceId: string, file: File, kind: UploadFormat, key: string, batchId: string, inputCount: number, signal?: AbortSignal,
): Promise<RealResumeSummary> {
  const label = kind === 'markdown' ? 'Markdown' : kind.toUpperCase()
  if (uploadedFileKind(file) !== kind || !isSafeUploadedFilename(file.name, kind)) {
    throw new Error(`${uploadedFileKind(file)?.toUpperCase() ?? 'Unsupported'} uploads are not enabled for this method. Choose a ${label} file with a safe ${kind === 'markdown' ? '.md or .markdown' : `.${kind}`} filename.`)
  }
  const maxBytes = uploadFileByteLimit(kind, RESUME_IMPORT_LIMITS)
  if (!file.size || file.size > maxBytes) throw new Error(`Choose a nonempty ${label} file no larger than ${maxBytes / 1024 / 1024} MiB.`)
  if (kind === 'docx' || kind === 'doc') requireUploadFile(file, [kind])
  const headers = {
    ...importHeaders(key, batchId, inputCount),
    'Content-Type': UPLOAD_CONTENT_TYPES[kind],
    'X-File-Name': encodeURIComponent(file.name),
  }
  signal?.throwIfAborted()
  const bytes = await file.arrayBuffer()
  signal?.throwIfAborted()
  const result = await cloudJsonRequest<ResumeMutationResponse>(`${base(workspaceId)}/${kind === 'pdf' || kind === 'markdown' ? kind : 'file'}`, { method: 'POST', headers, body: bytes, signal })
  return checked(result.resume, workspaceId)
}

export function importRealResumePdf(
  workspaceId: string, file: File, key: string, batchId: string, inputCount: number, signal?: AbortSignal,
): Promise<RealResumeSummary> {
  return importRealResumeUpload(workspaceId, file, 'pdf', key, batchId, inputCount, signal)
}

export function importRealResumeMarkdown(
  workspaceId: string, file: File, key: string, batchId: string, inputCount: number, signal?: AbortSignal,
): Promise<RealResumeSummary> {
  return importRealResumeUpload(workspaceId, file, 'markdown', key, batchId, inputCount, signal)
}

export async function importRealResumeFile(
  workspaceId: string, file: File, key: string, batchId: string, inputCount: number, signal?: AbortSignal,
): Promise<RealResumeSummary> {
  const kind = uploadedFileKind(file)
  if (!kind) throw new Error('Choose a supported file: PDF, Markdown (.md or .markdown), DOCX or DOC. Other file types are not supported.')
  return importRealResumeUpload(workspaceId, file, kind, key, batchId, inputCount, signal)
}

export async function importRealResumeUrl(
  workspaceId: string, url: string, key: string, batchId: string, inputCount: number, signal?: AbortSignal,
): Promise<RealResumeSummary> {
  const result = await cloudJsonRequest<ResumeMutationResponse>(`${base(workspaceId)}/url`, {
    method: 'POST', headers: importHeaders(key, batchId, inputCount), body: JSON.stringify({ url }), signal,
  })
  return checked(result.resume, workspaceId)
}

async function action(workspaceId: string, resumeId: string, name: 'retry' | 'cancel', etag: string): Promise<RealResumeSummary> {
  if (!etag) throw new Error('Reload and review the current resume state before retrying or cancelling.')
  const result = await cloudJsonRequest<ResumeMutationResponse>(`${base(workspaceId, resumeId)}/${name}`, {
    method: 'POST', headers: { 'If-Match': etag },
  })
  return checked(result.resume, workspaceId)
}

export function retryRealResume(workspaceId: string, resumeId: string, etag: string): Promise<RealResumeSummary> {
  return action(workspaceId, resumeId, 'retry', etag)
}

export function cancelRealResume(workspaceId: string, resumeId: string, etag: string): Promise<RealResumeSummary> {
  return action(workspaceId, resumeId, 'cancel', etag)
}

export function realResumeOriginalUrl(workspaceId: string, resumeId: string): string {
  return `/api${base(workspaceId, resumeId)}/original`
}

export interface RealResumeLifecycleResponse {
  resume?: RealResumeDetail
  deleted?: true
  operation?: LifecycleOperation
  etag?: string
}

export async function getRealResumeLifecycleImpact(workspaceId: string, resumeId: string, signal?: AbortSignal): Promise<LifecycleImpact> {
  const result = await cloudJsonRequest<{ impact: LifecycleImpact }>(`${base(workspaceId, resumeId)}/lifecycle`, { signal })
  return result.impact
}

export async function changeRealResumeLifecycle(workspaceId: string, resumeId: string, action: LifecycleAction, etag: string): Promise<RealResumeLifecycleResponse> {
  if (!etag) throw new Error('Reload the exact resume version before changing its lifecycle.')
  const result = await cloudLifecycleRequest<RealResumeLifecycleResponse>(`${base(workspaceId, resumeId)}/lifecycle`, {
    method: 'POST', headers: { 'If-Match': etag }, body: JSON.stringify({ action }),
  })
  if (result.value.resume) {
    checked(result.value.resume, workspaceId)
    if (result.value.resume.resume.id !== resumeId) throw new Error('The lifecycle response belongs to another resume.')
  }
  return { ...result.value, etag: result.value.etag ?? result.etag }
}
