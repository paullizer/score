import { createHash } from 'node:crypto'
import ipaddr from 'ipaddr.js'
import { z } from 'zod'
import {
  RESUME_IMPORT_LIMITS as LIMITS,
  type ImmutableBlobReference, type RealResumeDocument, type RealResumeProfile, type RealResumeRecord,
  type ResumeCaptureManifest, type ResumeEntity, type ResumeSourceCapture,
} from '../../src/domain/real-resumes'
import { isSafeUploadedFilename } from '../../src/domain/source-files'
import { invalidRequest } from '../errors'
import { WORKSPACE_ID_PATTERN } from '../ids'
import type { ResumeBlob } from './store'
import {
  DOCUMENT_BLOB_CONTENT_TYPES, ORIGINAL_CONTENT_TYPES, UPLOAD_CONTENT_TYPES, UPLOAD_FORMATS,
  isOriginalContentType, isUploadFormat, originalExtension, storedDocumentContentType,
  uploadFormatFromFilename, type OriginalContentType, type UploadFormat,
} from '../../src/domain/document-formats'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const UUID_PATTERN = new RegExp(`^${UUID}$`)
const RESUME_ID_PATTERN = new RegExp(`^resume-${UUID}$`)
const DOCUMENT_ID_PATTERN = new RegExp(`^document-${UUID}$`)
const BATCH_ID_PATTERN = new RegExp(`^resume-batch-${UUID}$`)
const VERSION = '(?:[1-9][0-9]{0,5}|1000000)'
const BLOB_FILE = new RegExp(`^(?:original\\.(?:pdf|docx|doc|html|md)|capture\\.json|import-receipt\\.json|(?:source-document|profile)-v${VERSION}\\.json)$`)

export const RESUME_BLOB_LIMITS = {
  maxHtmlBytes: 24 * 1024 * 1024,
  maxJsonBytes: LIMITS.maxSourceCharacters * 8 + 4 * 1024 * 1024,
} as const
export const MAX_RESUME_RECORD_BYTES = 256 * 1024
export const REAL_RESUME_STATUSES = ['queued', 'parsing', 'profiling', 'ready', 'error', 'cancelled'] as const

export function isResumeUuid(value: string): boolean { return UUID_PATTERN.test(value) }
export function isValidResumeId(value: string): boolean { return RESUME_ID_PATTERN.test(value) }
export function isValidResumeDocumentId(value: string): boolean { return DOCUMENT_ID_PATTERN.test(value) }
export function isValidResumeBatchRecordId(value: string): boolean { return BATCH_ID_PATTERN.test(value) }

export function resumeIdForKey(key: string): string {
  if (!isResumeUuid(key)) throw new Error('Invalid resume idempotency key.')
  return `resume-${key}`
}

export function resumeDocumentId(resumeId: string): string {
  if (!isValidResumeId(resumeId)) throw new Error('Invalid resume ID.')
  return `document-${resumeId.slice('resume-'.length)}`
}

export function resumeBatchRecordId(batchId: string): string {
  if (!isResumeUuid(batchId)) throw new Error('Invalid resume batch ID.')
  return `resume-batch-${batchId}`
}

function prefix(workspaceId: string, resumeId: string): string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId) || !isValidResumeId(resumeId)) {
    throw new Error('Invalid resume blob ownership.')
  }
  return `${workspaceId}/${resumeId}/`
}

function versionNumber(version: number): number {
  if (!Number.isInteger(version) || version < 1 || version > 1_000_000) throw new Error('Invalid resume document version.')
  return version
}

export function resumeOriginalBlobName(
  workspaceId: string, resumeId: string, kind: UploadFormat | 'html' | OriginalContentType,
): string {
  const contentType = isOriginalContentType(kind) ? kind : kind === 'html' ? 'text/html' : isUploadFormat(kind) ? UPLOAD_CONTENT_TYPES[kind] : undefined
  if (!contentType) throw new Error('Invalid resume original type.')
  return `${prefix(workspaceId, resumeId)}original.${originalExtension(contentType)}`
}
export function resumeCaptureBlobName(workspaceId: string, resumeId: string): string {
  return `${prefix(workspaceId, resumeId)}capture.json`
}
export function resumeImportReceiptBlobName(workspaceId: string, resumeId: string): string {
  return `${prefix(workspaceId, resumeId)}import-receipt.json`
}
export function resumeDocumentBlobName(workspaceId: string, resumeId: string, version = 1): string {
  return `${prefix(workspaceId, resumeId)}source-document-v${versionNumber(version)}.json`
}
export function resumeProfileBlobName(workspaceId: string, resumeId: string, version = 1): string {
  return `${prefix(workspaceId, resumeId)}profile-v${versionNumber(version)}.json`
}

export function isSafeResumeBlobName(value: string): boolean {
  const parts = value.split('/')
  return parts.length === 3 && WORKSPACE_ID_PATTERN.test(parts[0]) &&
    isValidResumeId(parts[1]) && BLOB_FILE.test(parts[2])
}

export function isBlobInResumePrefix(value: string, workspaceId: string, resumeId: string): boolean {
  return isSafeResumeBlobName(value) && value.startsWith(`${workspaceId}/${resumeId}/`)
}

export function resumeBlobContentType(name: string): OriginalContentType | 'application/json' {
  if (!isSafeResumeBlobName(name)) throw new Error('Invalid resume blob name.')
  const contentType = storedDocumentContentType(name)
  if (!contentType) throw new Error('Invalid resume blob type.')
  return contentType
}

export function resumeBlobLimit(name: string): number {
  switch (resumeBlobContentType(name)) {
    case 'application/pdf': return LIMITS.maxPdfBytes
    case UPLOAD_CONTENT_TYPES.docx: case UPLOAD_CONTENT_TYPES.doc: return LIMITS.maxFileBytes
    case 'text/markdown': return LIMITS.maxMarkdownBytes
    case 'text/html': return RESUME_BLOB_LIMITS.maxHtmlBytes
    case 'application/json': return RESUME_BLOB_LIMITS.maxJsonBytes
  }
}

export function resumeSha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Resume content must be JSON serializable.')
  return encoded
}

export function resumeContentHash(value: unknown): string { return resumeSha256(canonicalJson(value)) }

export function resumeBlobReference(blobName: string, blob: ResumeBlob): ImmutableBlobReference {
  if (blob.contentType !== resumeBlobContentType(blobName) || !blob.bytes.byteLength ||
    blob.bytes.byteLength > resumeBlobLimit(blobName) || resumeSha256(blob.bytes) !== blob.sha256 ||
    typeof blob.etag !== 'string' || !blob.etag.trim()) {
    throw new Error('Invalid immutable resume blob content or metadata.')
  }
  return { blobName, contentType: blob.contentType, sha256: blob.sha256, bytes: blob.bytes.byteLength }
}

export function isSafeResumeFilename(value: string, kind: UploadFormat = 'pdf'): boolean {
  return isSafeUploadedFilename(value, kind)
}

export function normalizeResumePublicUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > LIMITS.maxUrlLength ||
    value.trim() !== value || [...value].some(character => {
      const code = character.charCodeAt(0)
      return code <= 32 || (code >= 127 && code <= 159) || character === '\\'
    })) {
    throw invalidRequest(`URL must be an absolute public HTTP(S) URL of at most ${LIMITS.maxUrlLength} characters.`)
  }
  let url: URL
  try { url = new URL(value) } catch { throw invalidRequest('URL must be a valid absolute HTTP(S) URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw invalidRequest('URL must be a public HTTP(S) URL without credentials.')
  }
  if (url.port) throw invalidRequest('URL must use the standard HTTP or HTTPS port.')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  let address: ipaddr.IPv4 | ipaddr.IPv6 | undefined
  try { address = ipaddr.parse(host.replace(/^\[|\]$/g, '')) } catch { /* The worker also checks and pins DNS before each request. */ }
  if (host === 'localhost' || /\.(?:localhost|local|internal|localdomain|home\.arpa)$/.test(host) ||
    (!address && !host.includes('.'))) throw invalidRequest('URL host must be public.')
  if (address) {
    if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) address = (address as ipaddr.IPv6).toIPv4Address()
    if (address.range() !== 'unicast' || address.toString() === '168.63.129.16') throw invalidRequest('URL host must be public.')
  }
  url.hostname = host
  url.hash = ''
  const normalized = url.toString()
  if (normalized.length > LIMITS.maxUrlLength) throw invalidRequest(`URL may not exceed ${LIMITS.maxUrlLength} characters.`)
  return normalized
}

const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Must not be blank.')
const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/)
const uuid = z.string().regex(UUID_PATTERN)
const resumeId = z.string().regex(RESUME_ID_PATTERN)
const documentId = z.string().regex(DOCUMENT_ID_PATTERN)
const workspaceId = z.string().regex(WORKSPACE_ID_PATTERN)
const timestamp = z.iso.datetime({ precision: 3 })
const version = z.number().int().min(1).max(1_000_000)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const page = z.number().int().min(1).max(100_000)
const url = z.string().max(LIMITS.maxUrlLength).refine(value => {
  try { return normalizeResumePublicUrl(value) === value } catch { return false }
}, 'Must be a normalized public HTTP(S) URL without credentials.')
const filename = z.string().refine(value => {
  const kind = uploadFormatFromFilename(value)
  return kind !== undefined && isSafeResumeFilename(value, kind)
}, 'Must be a safe PDF, Markdown, DOCX, or DOC basename.')
const source = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(UPLOAD_FORMATS), displayName: filename, fileName: filename })
    .refine(value => value.displayName === value.fileName && uploadFormatFromFilename(value.fileName) === value.kind,
      'Upload display name and format must match its original filename.'),
  z.strictObject({ kind: z.literal('url'), displayName: url, url })
    .refine(value => value.displayName === value.url, 'URL display name must match its requested URL.'),
])
const blobShape = {
  blobName: z.string().max(400).refine(isSafeResumeBlobName, 'Invalid resume blob namespace.'),
  contentType: z.enum(DOCUMENT_BLOB_CONTENT_TYPES),
  sha256, bytes: z.number().int().min(1).max(RESUME_BLOB_LIMITS.maxHtmlBytes),
}
const jsonBlob = z.strictObject({ ...blobShape, contentType: z.literal('application/json') })
const documentBlob = z.strictObject({
  ...blobShape, contentType: z.literal('application/json'), documentId, documentVersion: version,
})
const capture = z.strictObject({
  original: z.strictObject({ ...blobShape, contentType: z.enum(ORIGINAL_CONTENT_TYPES) }),
  capturedAt: timestamp, finalUrl: url.optional(), redirects: z.array(url).max(20),
})
const extraction = z.strictObject({
  method: z.enum(['document-intelligence', 'html', 'browser', 'markdown', 'legacy-word']), version: text(200), extractedAt: timestamp,
  pagination: z.enum(['pdf-pages', 'html-sections', 'markdown-sections', 'captured-sections']), pageCount: z.number().int().min(1).max(LIMITS.maxPdfPages).nullable(),
  normalizedCharacters: z.number().int().min(1).max(LIMITS.maxSourceCharacters), document: documentBlob,
})
const processingError = z.strictObject({
  code: z.enum([
    'access-blocked', 'not-found', 'network-error', 'unsupported-content', 'unreadable-document', 'pdf-too-large', 'file-too-large',
    'pdf-too-many-pages', 'source-too-large', 'multiple-profiles', 'not-a-profile', 'invalid-profile', 'invalid-source',
    'invalid-model-output', 'service-unavailable', 'storage-error', 'timeout', 'internal-error',
  ]),
  stage: z.enum(['download', 'parsing', 'profiling', 'publication']), message: text(2000), retryable: z.boolean(),
})
const duplicate = z.strictObject({
  kind: z.enum(['exact-content', 'same-source']), resumeId, message: text(1000),
})
const base = { workspaceId, dataKind: z.literal('real'), createdAt: timestamp, updatedAt: timestamp }
const resumeRecord = z.strictObject({
  ...base, id: resumeId, recordType: z.literal('resume'),
  resume: z.strictObject({
    id: resumeId, dataKind: z.literal('real'),
    name: text(2000).nullable(), role: text(2000).nullable(), location: text(2000).nullable(), experience: text(2000).nullable(),
    documentId, documentVersion: version, sourceLabel: text(LIMITS.maxUrlLength), batchId: uuid,
    status: z.enum(REAL_RESUME_STATUSES), createdAt: timestamp,
  }),
  source, batchId: uuid, idempotencyKey: uuid, inputFingerprint: sha256, createdBy: text(200),
  capture: capture.optional(), captureManifest: jsonBlob.optional(), extraction: extraction.optional(), profileBlob: jsonBlob.optional(),
  attempts: z.number().int().min(0).max(LIMITS.maxAutomaticAttempts),
  retryCount: z.number().int().min(0).max(1_000_000), attemptId: uuid.optional(),
  nextAttemptAt: timestamp.optional(),
  lease: z.strictObject({ owner: text(200), expiresAt: timestamp, heartbeatAt: timestamp }).optional(),
  completedAt: timestamp.optional(), cancelledAt: timestamp.optional(), error: processingError.optional(),
  warnings: z.array(text(2000)).max(100), duplicates: z.array(duplicate).max(100),
})
const batchRecord = z.strictObject({
  ...base, id: z.string().regex(BATCH_ID_PATTERN), recordType: z.literal('resume-batch'), batchId: uuid,
  createdBy: text(200), inputCount: z.number().int().min(1).max(LIMITS.maxBatchItems),
  items: z.array(z.strictObject({ idempotencyKey: uuid, inputFingerprint: sha256, resumeId, acceptedAt: timestamp }))
    .min(1).max(LIMITS.maxBatchItems),
})
const entity = z.discriminatedUnion('recordType', [resumeRecord, batchRecord])

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid resume record: ${message}`)
}

function checkReference(reference: ImmutableBlobReference, name: string): void {
  assert(reference.blobName === name, 'Blob ownership, kind, or version mismatch.')
  assert(reference.contentType === resumeBlobContentType(name) && reference.bytes <= resumeBlobLimit(name),
    'Blob content metadata does not match its namespace or byte limit.')
}

function checkCapture(value: ResumeSourceCapture, workspace: string, id: string, input: ResumeCaptureManifest['source']): void {
  checkReference(value.original, resumeOriginalBlobName(workspace, id, value.original.contentType))
  if (input.kind !== 'url') {
    assert(value.original.contentType === UPLOAD_CONTENT_TYPES[input.kind] && value.finalUrl === undefined && !value.redirects.length,
      'Uploaded capture must match its file type and cannot contain URL provenance.')
  } else {
    assert(value.finalUrl && ['application/pdf', 'text/html'].includes(value.original.contentType),
      'A URL capture must identify its final public URL and contain only PDF or HTML.')
  }
}

export function parseResumeEntity(value: unknown): ResumeEntity {
  assert(Buffer.byteLength(JSON.stringify(value) ?? '') <= MAX_RESUME_RECORD_BYTES, 'Cosmos payload is too large.')
  const record = entity.parse(value) as ResumeEntity
  assert(record.updatedAt >= record.createdAt, 'updatedAt precedes createdAt.')
  if (record.recordType === 'resume-batch') {
    assert(record.id === resumeBatchRecordId(record.batchId), 'Batch identity mismatch.')
    assert(record.items.length <= record.inputCount, 'Batch exceeds its declared input count.')
    assert(new Set(record.items.map(item => item.idempotencyKey)).size === record.items.length &&
      new Set(record.items.map(item => item.resumeId)).size === record.items.length, 'Batch items must have unique keys and IDs.')
    for (const item of record.items) {
      assert(item.resumeId === resumeIdForKey(item.idempotencyKey), 'Batch item identity mismatch.')
      assert(item.acceptedAt >= record.createdAt && item.acceptedAt <= record.updatedAt, 'Batch admission timestamp is invalid.')
    }
    return record
  }
  const { resume } = record
  assert(record.id === resumeIdForKey(record.idempotencyKey) && resume.id === record.id &&
    resume.documentId === resumeDocumentId(record.id) && resume.batchId === record.batchId &&
    resume.createdAt === record.createdAt && resume.sourceLabel === record.source.displayName, 'Resume identity or source binding mismatch.')
  if (record.capture) {
    checkCapture(record.capture, record.workspaceId, record.id, record.source)
    assert(record.capture.capturedAt >= record.createdAt, 'Capture predates the imported input.')
  }
  assert(Boolean(record.capture) === Boolean(record.captureManifest), 'Captured originals must have an immutable manifest.')
  if (record.captureManifest) checkReference(record.captureManifest, resumeCaptureBlobName(record.workspaceId, record.id))
  if (record.source.kind !== 'url') assert(record.capture, 'Upload records require their original capture before publication.')
  if (record.extraction) {
    assert(record.capture, 'Extraction requires a captured original.')
    const extracted = record.extraction
    checkReference(extracted.document, resumeDocumentBlobName(record.workspaceId, record.id, resume.documentVersion))
    assert(extracted.document.documentId === resume.documentId && extracted.document.documentVersion === resume.documentVersion,
      'Extraction does not match the stable source document identity.')
    assert(extracted.extractedAt >= record.capture.capturedAt, 'Extraction predates its capture.')
    let matchesContent: boolean
    switch (record.capture.original.contentType) {
      case 'application/pdf':
        matchesContent = extracted.method === 'document-intelligence' && extracted.pagination === 'pdf-pages' && extracted.pageCount !== null
        break
      case 'text/html':
        matchesContent = ['html', 'browser'].includes(extracted.method) && extracted.pagination === 'html-sections' && extracted.pageCount === null
        break
      case 'text/markdown':
        matchesContent = extracted.method === 'markdown' && extracted.pagination === 'markdown-sections' && extracted.pageCount === null
        break
      case UPLOAD_CONTENT_TYPES.docx: case UPLOAD_CONTENT_TYPES.doc:
        matchesContent = extracted.method === (record.capture.original.contentType === UPLOAD_CONTENT_TYPES.doc ? 'legacy-word' : 'document-intelligence') &&
          extracted.pagination === 'captured-sections' && extracted.pageCount === null
        break
    }
    assert(matchesContent, 'Extraction method, pagination, and page count do not match the original content.')
  }
  if (record.profileBlob) {
    assert(record.extraction, 'A profile requires the captured source document.')
    checkReference(record.profileBlob, resumeProfileBlobName(record.workspaceId, record.id, resume.documentVersion))
  } else {
    assert([resume.name, resume.role, resume.location, resume.experience].every(field => field === null),
      'Display metadata must remain null until a profile is captured.')
  }
  assert(new Set(record.duplicates.map(item => `${item.kind}:${item.resumeId}`)).size === record.duplicates.length &&
    record.duplicates.every(item => item.resumeId !== record.id), 'Duplicate warnings cannot repeat or refer to themselves.')
  const active = resume.status === 'parsing' || resume.status === 'profiling'
  if (active) assert(record.lease && record.attemptId && record.attempts > 0, 'Active processing requires an identified leased attempt.')
  if (record.lease) {
    assert(active && record.lease.expiresAt > record.lease.heartbeatAt && record.lease.heartbeatAt >= record.createdAt,
      'Processing lease is invalid for this state.')
  }
  if (resume.status === 'profiling') assert(record.extraction, 'Profiling requires a preserved extraction.')
  if (['ready', 'error', 'cancelled'].includes(resume.status)) {
    assert(!record.lease && !record.nextAttemptAt, 'Terminal records cannot remain eligible for work.')
  }
  if (resume.status === 'ready') {
    assert(record.capture && record.captureManifest && record.extraction && record.profileBlob && record.completedAt && !record.error,
      'Ready resumes require a complete captured source, extraction, profile, and completion timestamp.')
  }
  if (resume.status === 'error') assert(record.error, 'Failed resumes need an actionable processing error.')
  if (resume.status === 'cancelled') assert(record.cancelledAt && !record.error, 'Cancelled resumes require cancellation metadata.')
  if (record.cancelledAt) assert(resume.status === 'cancelled' && record.cancelledAt >= record.createdAt, 'Invalid cancellation timestamp.')
  if (record.completedAt) assert(['ready', 'error'].includes(resume.status) && record.completedAt >= record.createdAt, 'Invalid completion timestamp.')
  return record
}

const documentSchema = z.strictObject({
  id: documentId, title: text(500), kind: z.literal('resume'), version, sample: z.literal(false),
  paragraphs: z.array(z.strictObject({ id: identifier, page, heading: z.string().max(2000), text: text(LIMITS.maxSourceCharacters) }))
    .min(1).max(20_000),
})

export function validateRealResumeDocument(value: unknown): string[] {
  const result = documentSchema.safeParse(value)
  if (!result.success) return result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
  const document = result.data
  const errors: string[] = []
  if (new Set(document.paragraphs.map(paragraph => paragraph.id)).size !== document.paragraphs.length) {
    errors.push('Resume paragraph IDs must be unique.')
  }
  if (document.paragraphs.reduce((sum, paragraph) => sum + paragraph.heading.length + paragraph.text.length, 0) > LIMITS.maxSourceCharacters) {
    errors.push(`Resume source exceeds ${LIMITS.maxSourceCharacters} normalized characters.`)
  }
  return errors
}

const citation = z.strictObject({
  documentId, documentVersion: version, paragraphId: identifier, page, heading: z.string().max(2000), quote: text(32_000),
})
const profileField = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), value: text(2000), citations: z.array(citation).min(1).max(30) }),
  z.strictObject({ status: z.literal('unavailable'), value: z.null(), citations: z.tuple([]) }),
])
const profileSchema = z.strictObject({
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId, resumeId, documentId,
  documentVersion: version, documentSha256: sha256,
  name: profileField, role: profileField, location: profileField, experience: profileField,
  provenance: z.strictObject({ model: text(300), promptVersion: text(200), schemaVersion: text(200), extractedAt: timestamp }),
})

export function parseRealResumeProfile(value: unknown): RealResumeProfile {
  const profile = profileSchema.parse(value) as RealResumeProfile
  assert(profile.documentId === resumeDocumentId(profile.resumeId), 'Profile source identity mismatch.')
  for (const field of [profile.name, profile.role, profile.location, profile.experience]) {
    for (const quote of field.citations) {
      assert(quote.documentId === profile.documentId && quote.documentVersion === profile.documentVersion,
        'Profile citation belongs to a different source document or version.')
    }
    if (field.status === 'available') {
      assert(field.citations.some(quote => quote.quote.includes(field.value)), 'Profile values must be quoted from their cited evidence.')
    }
  }
  return profile
}

export function validateRealResumeProfile(
  value: unknown,
  document: RealResumeDocument,
  expected?: { workspaceId: string; resumeId: string; documentSha256: string },
): string[] {
  const errors = validateRealResumeDocument(document)
  let profile: RealResumeProfile
  try { profile = parseRealResumeProfile(value) } catch { return [...errors, 'The resume profile or its evidence bindings are invalid.'] }
  if (errors.length) return errors
  if (profile.documentId !== document.id || profile.documentVersion !== document.version ||
    (expected && (profile.workspaceId !== expected.workspaceId || profile.resumeId !== expected.resumeId ||
      profile.documentSha256 !== expected.documentSha256))) errors.push('Profile ownership or captured source hash does not match.')
  const paragraphs = new Map(document.paragraphs.map(paragraph => [paragraph.id, paragraph]))
  for (const field of [profile.name, profile.role, profile.location, profile.experience]) {
    for (const quote of field.citations) {
      const paragraph = paragraphs.get(quote.paragraphId)
      if (!paragraph || quote.page !== paragraph.page || quote.heading !== paragraph.heading || !paragraph.text.includes(quote.quote)) {
        errors.push('A profile quotation does not exactly match the saved resume paragraph.')
      }
    }
  }
  return errors
}

const captureManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId, resumeId, inputFingerprint: sha256, source, capture,
})

export function parseResumeCaptureManifest(value: unknown): ResumeCaptureManifest {
  const manifest = captureManifestSchema.parse(value) as ResumeCaptureManifest
  checkCapture(manifest.capture, manifest.workspaceId, manifest.resumeId, manifest.source)
  return manifest
}

export function validateResumeDocumentBinding(document: RealResumeDocument, record: RealResumeRecord): string[] {
  const errors = validateRealResumeDocument(document)
  if (errors.length) return errors
  if (!record.extraction || document.id !== record.resume.documentId || document.version !== record.resume.documentVersion) {
    return ['The normalized document does not match this resume extraction.']
  }
  if (record.extraction.normalizedCharacters !== document.paragraphs.reduce(
    (sum, paragraph) => sum + paragraph.heading.length + paragraph.text.length, 0,
  )) errors.push('The normalized source character count does not match its extraction provenance.')
  if (record.extraction.pageCount !== null && document.paragraphs.some(paragraph => paragraph.page > record.extraction!.pageCount!)) {
    errors.push('A resume paragraph exceeds the captured PDF page count.')
  }
  return errors
}
