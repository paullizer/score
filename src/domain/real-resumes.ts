import type { Citation, SourceDocument } from './types'
import type { DocumentPagination, OriginalContentType, UploadContentType, UploadFormat, WordImportFeatures } from './document-formats'
import { MAX_MARKDOWN_BYTES } from './source-files'

export const RESUME_IMPORT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxPdfBytes: 10 * 1024 * 1024,
  maxMarkdownBytes: MAX_MARKDOWN_BYTES,
  maxPdfPages: 50,
  maxSourceCharacters: 180_000,
  maxBatchItems: 10,
  maxUrlLength: 4096,
  maxAutomaticAttempts: 3,
} as const

export interface ImmutableBlobReference {
  blobName: string
  contentType: string
  sha256: string
  bytes: number
}

export interface ImmutableJsonBlobReference extends ImmutableBlobReference {
  contentType: 'application/json'
}

export interface ImmutableDocumentReference extends ImmutableJsonBlobReference {
  documentId: string
  documentVersion: number
}

export type RealResumeDocument = SourceDocument & { kind: 'resume'; sample: false }
export type RealResumeStatus = 'queued' | 'parsing' | 'profiling' | 'ready' | 'error' | 'cancelled'

export type ResumeProcessingErrorCode =
  | 'access-blocked' | 'not-found' | 'network-error' | 'unsupported-content'
  | 'unreadable-document' | 'pdf-too-large' | 'file-too-large' | 'pdf-too-many-pages' | 'source-too-large'
  | 'multiple-profiles' | 'not-a-profile' | 'invalid-profile' | 'invalid-source'
  | 'invalid-model-output' | 'service-unavailable' | 'storage-error' | 'timeout' | 'internal-error'

export interface ResumeProcessingError {
  code: ResumeProcessingErrorCode
  stage: 'download' | 'parsing' | 'profiling' | 'publication'
  message: string
  retryable: boolean
}

export type RealResumeSource =
  | { kind: UploadFormat; displayName: string; fileName: string }
  | { kind: 'url'; displayName: string; url: string }

export interface ResumeSourceCapture {
  original: ImmutableBlobReference & { contentType: OriginalContentType }
  capturedAt: string
  finalUrl?: string
  redirects: string[]
}

export interface ResumeCaptureManifest {
  schemaVersion: 1
  dataKind: 'real'
  workspaceId: string
  resumeId: string
  inputFingerprint: string
  source: RealResumeSource
  capture: ResumeSourceCapture
}

export interface ResumeExtractionProvenance {
  method: 'document-intelligence' | 'html' | 'browser' | 'markdown' | 'legacy-word'
  version: string
  extractedAt: string
  pagination: DocumentPagination
  pageCount: number | null
  normalizedCharacters: number
  document: ImmutableDocumentReference
}

export type ResumeProfileField =
  | { status: 'available'; value: string; citations: [Citation, ...Citation[]] }
  | { status: 'unavailable'; value: null; citations: [] }

export interface ResumeProfileProvenance {
  model: string
  promptVersion: string
  schemaVersion: string
  extractedAt: string
}

export interface RealResumeProfile {
  schemaVersion: 1
  dataKind: 'real'
  workspaceId: string
  resumeId: string
  documentId: string
  documentVersion: number
  documentSha256: string
  name: ResumeProfileField
  role: ResumeProfileField
  location: ResumeProfileField
  experience: ResumeProfileField
  provenance: ResumeProfileProvenance
}

// Display metadata is derived only from the profile; a filename is never a person's name.
export interface RealResume {
  id: string
  dataKind: 'real'
  name: string | null
  role: string | null
  location: string | null
  experience: string | null
  documentId: string
  documentVersion: number
  sourceLabel: string
  batchId: string
  status: RealResumeStatus
  createdAt: string
}

export interface ResumeDuplicateWarning {
  kind: 'exact-content' | 'same-source'
  resumeId: string
  message: string
}

export interface ResumeEntityBase {
  id: string
  workspaceId: string
  dataKind: 'real'
  createdAt: string
  updatedAt: string
}

export interface RealResumeRecord extends ResumeEntityBase {
  recordType: 'resume'
  resume: RealResume
  source: RealResumeSource
  batchId: string
  idempotencyKey: string
  inputFingerprint: string
  createdBy: string
  capture?: ResumeSourceCapture
  captureManifest?: ImmutableJsonBlobReference
  extraction?: ResumeExtractionProvenance
  profileBlob?: ImmutableJsonBlobReference
  // Automatic attempts in the current retry cycle; manual retries increment retryCount.
  attempts: number
  retryCount: number
  attemptId?: string
  nextAttemptAt?: string
  lease?: { owner: string; expiresAt: string; heartbeatAt: string }
  completedAt?: string
  cancelledAt?: string
  error?: ResumeProcessingError
  warnings: string[]
  duplicates: ResumeDuplicateWarning[]
}

export interface ResumeBatchItem {
  idempotencyKey: string
  inputFingerprint: string
  resumeId: string
  acceptedAt: string
}

// Unique keys/IDs and the declared 1–10 input count are enforced in the admission transaction.
export interface ResumeImportBatchRecord extends ResumeEntityBase {
  recordType: 'resume-batch'
  batchId: string
  createdBy: string
  inputCount: number
  items: ResumeBatchItem[]
}

export type ResumeEntity = RealResumeRecord | ResumeImportBatchRecord

export interface VersionedResumeEntity<T extends ResumeEntity = ResumeEntity> {
  record: T
  etag: string
}

export interface RealResumeSummary {
  resume: RealResume
  workspaceId: string
  source: RealResumeSource
  capture: ResumeSourceCapture | null
  documentRef: ImmutableDocumentReference | null
  etag: string
  updatedAt: string
  attempts: number
  retryCount: number
  nextAttemptAt?: string
  error?: ResumeProcessingError
  warnings: string[]
  duplicates: ResumeDuplicateWarning[]
}

export interface RealResumeDetail extends RealResumeSummary {
  document: RealResumeDocument | null
  profile: RealResumeProfile | null
  extraction: ResumeExtractionProvenance | null
}

export interface RealResumesPage {
  resumes: RealResumeSummary[]
  continuationToken?: string
}

export interface ResumeProcessingFeatures extends WordImportFeatures {
  realResumeImports: boolean
  markdownResumeImports: boolean
  resumeLimits: typeof RESUME_IMPORT_LIMITS
}

// Both import routes require UUID keys and the same declared count for every item in a batch.
export interface ResumeImportHeaders {
  'Idempotency-Key': string
  'X-Import-Batch': string
  'X-Import-Count': string
}

export interface ResumePdfImportHeaders extends ResumeImportHeaders {
  'Content-Type': 'application/pdf'
  // Percent-encoded safe basename, for display only.
  'X-File-Name': string
}

export interface ResumeFileImportHeaders extends ResumeImportHeaders {
  'Content-Type': UploadContentType
  'X-File-Name': string
}

export interface ResumeMarkdownImportHeaders extends ResumeImportHeaders {
  'Content-Type': 'text/markdown'
  'X-File-Name': string
}

export interface ImportResumeUrlInput {
  url: string
}

export interface ResumeActionHeaders {
  'If-Match': string
}

// GET details are unwrapped; import/retry/cancel POSTs return this wrapper.
export interface ResumeMutationResponse {
  resume: RealResumeSummary
}

export function resumeRecordIs<K extends ResumeEntity['recordType']>(
  value: ResumeEntity,
  recordType: K,
): value is Extract<ResumeEntity, { recordType: K }> {
  return value.recordType === recordType
}
