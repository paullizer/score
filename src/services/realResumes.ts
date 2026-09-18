import {
  RESUME_IMPORT_LIMITS,
  type RealResumeDetail,
  type RealResumeSummary,
  type RealResumesPage,
  type ResumeMutationResponse,
  type ResumeProcessingFeatures,
} from '../domain/real-resumes'
import { cloudJsonRequest } from './cloudWorkspace'
import { UPLOAD_CONTENT_TYPES, type UploadFormat } from '../domain/document-formats'
import { requireUploadFile } from './documentUploads'

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
    wordDocumentImports: features.wordDocumentImports === true,
    resumeLimits: {
      ...RESUME_IMPORT_LIMITS,
      ...features.resumeLimits,
      maxFileBytes: features.resumeLimits?.maxFileBytes ?? features.resumeLimits?.maxPdfBytes ?? RESUME_IMPORT_LIMITS.maxFileBytes,
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

export async function importRealResumePdf(
  workspaceId: string, file: File, key: string, batchId: string, inputCount: number, signal?: AbortSignal,
): Promise<RealResumeSummary> {
  requireUploadFile(file, ['pdf'])
  return importFile(workspaceId, file, 'pdf', key, batchId, inputCount, signal)
}

export async function importRealResumeFile(
  workspaceId: string, file: File, key: string, batchId: string, inputCount: number, signal?: AbortSignal,
): Promise<RealResumeSummary> {
  return importFile(workspaceId, file, requireUploadFile(file), key, batchId, inputCount, signal)
}

async function importFile(
  workspaceId: string, file: File, format: UploadFormat, key: string, batchId: string, inputCount: number, signal?: AbortSignal,
): Promise<RealResumeSummary> {
  const headers = { ...importHeaders(key, batchId, inputCount), 'Content-Type': UPLOAD_CONTENT_TYPES[format], 'X-File-Name': encodeURIComponent(file.name) }
  signal?.throwIfAborted()
  const bytes = await file.arrayBuffer()
  signal?.throwIfAborted()
  const result = await cloudJsonRequest<ResumeMutationResponse>(`${base(workspaceId)}/${format === 'pdf' ? 'pdf' : 'file'}`, { method: 'POST', headers, body: bytes, signal })
  return checked(result.resume, workspaceId)
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
