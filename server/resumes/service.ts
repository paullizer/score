import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import {
  RESUME_IMPORT_LIMITS as LIMITS,
  type ImmutableBlobReference, type ImmutableJsonBlobReference, type RealResumeDetail, type RealResumeDocument,
  type RealResumeProfile, type RealResumeRecord, type RealResumeSource, type RealResumeSummary, type RealResumesPage,
  type ResumeCaptureManifest, type ResumeDuplicateWarning, type ResumeEntity, type ResumeImportBatchRecord,
  type VersionedResumeEntity,
} from '../../src/domain/real-resumes'
import { decodeMarkdown, MarkdownInputError } from '../documents/markdown'
import { conflict, HttpError, invalidRequest, notFound, unavailable } from '../errors'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { StoreConflictError, StoreNotFoundError } from '../store'
import { originalExtension, UPLOAD_CONTENT_TYPES, uploadFormatFromFilename, type UploadContentType, type UploadFormat } from '../../src/domain/document-formats'
import { validateWordUpload } from '../documents/upload'
import type { RealResumesDeps, ResumeBlob, ResumeTransaction } from './store'
import {
  isResumeUuid, isSafeResumeFilename, isValidResumeId, normalizeResumePublicUrl, parseRealResumeProfile,
  parseResumeCaptureManifest, parseResumeEntity, resumeBatchRecordId, resumeBlobReference, resumeCaptureBlobName,
  resumeContentHash, resumeDocumentId, resumeIdForKey, resumeImportReceiptBlobName, resumeOriginalBlobName,
  resumeSha256, validateRealResumeProfile, validateResumeDocumentBinding,
} from './validation'

export type { RealResumesDeps } from './store'

export interface ResumeImportRequest {
  idempotencyKey: string
  batchId: string
  inputCount: number
  createdBy: string
}

export interface ResumeImportResult {
  created: boolean
  resume: RealResumeSummary
}

interface ImportReceipt extends ResumeImportRequest {
  schemaVersion: 1 | 2
  dataKind: 'real'
  workspaceId: string
  resumeId: string
  createdAt: string
  source: RealResumeSource
  inputFingerprint: string
  pdfSha256?: string
  fileSha256?: string
  markdownSha256?: string
}

const receiptShape = {
  dataKind: z.literal('real'),
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN), resumeId: z.string().refine(isValidResumeId),
  idempotencyKey: z.string().refine(isResumeUuid), batchId: z.string().refine(isResumeUuid),
  inputCount: z.number().int().min(1).max(LIMITS.maxBatchItems), createdBy: z.string().min(1).max(200),
  createdAt: z.iso.datetime({ precision: 3 }), source: z.unknown(),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}
const receiptSchema = z.discriminatedUnion('schemaVersion', [
  z.strictObject({
    ...receiptShape, schemaVersion: z.literal(1),
    pdfSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    markdownSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }),
  z.strictObject({ ...receiptShape, schemaVersion: z.literal(2), fileSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
])
const same = (left: unknown, right: unknown) => resumeContentHash(left) === resumeContentHash(right)
const active = new Set(['queued', 'parsing', 'profiling'])

function parseJson(blob: ResumeBlob): unknown {
  if (blob.contentType !== 'application/json') throw unavailable('Saved resume data has invalid content metadata.')
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(blob.bytes)) } catch {
    throw unavailable('Saved resume data could not be read. Nothing has been replaced.')
  }
}

function jsonReference(name: string, blob: ResumeBlob): ImmutableJsonBlobReference {
  const reference = resumeBlobReference(name, blob)
  if (reference.contentType !== 'application/json') throw unavailable('Saved resume data has invalid content metadata.')
  return { ...reference, contentType: 'application/json' }
}

function summary(value: VersionedResumeEntity<RealResumeRecord>): RealResumeSummary {
  const { record, etag } = value
  return {
    resume: record.resume, workspaceId: record.workspaceId, source: record.source, capture: record.capture ?? null,
    documentRef: record.extraction?.document ?? null, etag, updatedAt: record.updatedAt, attempts: record.attempts,
    retryCount: record.retryCount, ...(record.nextAttemptAt ? { nextAttemptAt: record.nextAttemptAt } : {}),
    ...(record.error ? { error: record.error } : {}), warnings: record.warnings, duplicates: record.duplicates,
  }
}

function validEtag(value: string): boolean {
  return Boolean(value && value.trim() === value && value !== '*' && !value.startsWith('W/') &&
    !value.includes(',') && !/[\r\n]/.test(value) && value.length <= 1024)
}

function validateRequest(workspaceId: string, input: ResumeImportRequest): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw notFound()
  if (!isResumeUuid(input.idempotencyKey) || !isResumeUuid(input.batchId)) throw invalidRequest('Import keys and batch IDs must be UUIDs.')
  if (!Number.isInteger(input.inputCount) || input.inputCount < 1 || input.inputCount > LIMITS.maxBatchItems) {
    throw invalidRequest(`An import batch must declare between 1 and ${LIMITS.maxBatchItems} inputs.`)
  }
  if (!input.createdBy || input.createdBy.trim() !== input.createdBy || input.createdBy.length > 200) throw new Error('Invalid import actor.')
}

async function validatePdf(bytes: Uint8Array): Promise<void> {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw invalidRequest('The PDF body must not be empty.')
  if (bytes.byteLength > LIMITS.maxPdfBytes) throw new HttpError(413, 'invalid_request', 'Resume PDFs may not exceed 10 MiB.')
  if (Buffer.from(bytes.subarray(0, 1024)).indexOf(Buffer.from('%PDF-')) < 0) {
    throw invalidRequest('The uploaded body is not a PDF. Upload an unencrypted, structurally valid PDF.')
  }
  let pages: number
  try {
    const document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true })
    if (document.isEncrypted || document.context.trailerInfo.Encrypt !== undefined) throw new Error('Encrypted PDF')
    pages = document.getPageCount()
  } catch {
    throw invalidRequest('The PDF cannot be read. Remove password protection or export a new, structurally valid PDF and try again.')
  }
  if (!pages) throw invalidRequest('The PDF has no readable pages. Export a PDF containing at least one page.')
  if (pages > LIMITS.maxPdfPages) throw invalidRequest(`Resume PDFs may contain at most ${LIMITS.maxPdfPages} pages. Upload a shorter PDF.`)
}

export class RealResumeService {
  private readonly store: RealResumesDeps['store']
  private readonly blobs: RealResumesDeps['blobs']
  private readonly clock: () => Date

  constructor(resumes: RealResumesDeps, now?: () => Date) {
    this.store = resumes.store
    this.blobs = resumes.blobs
    this.clock = now ?? (() => new Date())
  }

  private now(): string { return this.clock().toISOString() }

  private decode<K extends ResumeEntity['recordType']>(
    value: VersionedResumeEntity, workspaceId: string, kind: K, id?: string,
  ): VersionedResumeEntity<Extract<ResumeEntity, { recordType: K }>> {
    let record: ResumeEntity
    try { record = parseResumeEntity(value.record) } catch {
      throw unavailable('Saved resume metadata is invalid. Nothing has been changed.')
    }
    if (record.workspaceId !== workspaceId || record.recordType !== kind || (id !== undefined && record.id !== id)) {
      throw unavailable('Saved resume metadata does not match its requested workspace and identity.')
    }
    if (!validEtag(value.etag)) throw unavailable('Saved resume metadata has an invalid version.')
    return { record, etag: value.etag } as VersionedResumeEntity<Extract<ResumeEntity, { recordType: K }>>
  }

  private async optionalResume(workspaceId: string, id: string): Promise<VersionedResumeEntity<RealResumeRecord> | undefined> {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId) || !isValidResumeId(id)) throw notFound('The requested resume was not found.')
    const value = await this.store.get(workspaceId, id)
    return value ? this.decode(value, workspaceId, 'resume', id) : undefined
  }

  private async getResume(workspaceId: string, id: string): Promise<VersionedResumeEntity<RealResumeRecord>> {
    const value = await this.optionalResume(workspaceId, id)
    if (!value) throw notFound('The requested resume was not found.')
    return value
  }

  private async batch(workspaceId: string, batchId: string): Promise<VersionedResumeEntity<ResumeImportBatchRecord> | undefined> {
    const id = resumeBatchRecordId(batchId)
    const value = await this.store.get(workspaceId, id)
    return value ? this.decode(value, workspaceId, 'resume-batch', id) : undefined
  }

  private checkBatch(batch: ResumeImportBatchRecord, receipt: Pick<ImportReceipt, 'inputCount' | 'createdBy'>): void {
    if (batch.inputCount !== receipt.inputCount || batch.createdBy !== receipt.createdBy) {
      throw conflict('Every item in this batch must use the same declared input count and importing user. Start a new batch for different inputs.')
    }
  }

  private async accepted(receipt: ImportReceipt): Promise<VersionedResumeEntity<RealResumeRecord> | undefined> {
    const current = await this.optionalResume(receipt.workspaceId, receipt.resumeId)
    if (!current) return undefined
    if (current.record.inputFingerprint !== receipt.inputFingerprint) {
      throw conflict('This idempotency key was already used for different input. Use a new key for a new input.')
    }
    const batch = await this.batch(receipt.workspaceId, receipt.batchId)
    if (!batch) throw unavailable('This resume import has no valid batch admission record.')
    this.checkBatch(batch.record, receipt)
    const admission = batch.record.items.find(item => item.idempotencyKey === receipt.idempotencyKey)
    if (!admission || admission.resumeId !== current.record.id || admission.inputFingerprint !== receipt.inputFingerprint ||
      current.record.batchId !== receipt.batchId || current.record.createdBy !== receipt.createdBy ||
      !same(current.record.source, receipt.source)) throw unavailable('This resume import has inconsistent admission metadata.')
    return current
  }

  private async readReference(reference: ImmutableBlobReference): Promise<ResumeBlob> {
    const blob = await this.blobs.read(reference.blobName)
    if (!blob) throw unavailable('The saved resume source is temporarily unavailable. Retry without importing a replacement.')
    let actual: ImmutableBlobReference
    try { actual = resumeBlobReference(reference.blobName, blob) } catch {
      throw unavailable('The saved resume source has invalid content metadata.')
    }
    if (actual.contentType !== reference.contentType || actual.sha256 !== reference.sha256 || actual.bytes !== reference.bytes) {
      throw unavailable('The saved resume source does not match its immutable capture.')
    }
    return blob
  }

  private async capturedOriginal(record: RealResumeRecord): Promise<ResumeBlob | undefined> {
    if (!record.capture || !record.captureManifest) return undefined
    let manifest: ResumeCaptureManifest
    try { manifest = parseResumeCaptureManifest(parseJson(await this.readReference(record.captureManifest))) } catch {
      throw unavailable('The saved resume capture manifest is unavailable or invalid.')
    }
    if (manifest.workspaceId !== record.workspaceId || manifest.resumeId !== record.id ||
      manifest.inputFingerprint !== record.inputFingerprint || !same(manifest.source, record.source) || !same(manifest.capture, record.capture)) {
      throw unavailable('The saved resume capture manifest does not match this import.')
    }
    return this.readReference(record.capture.original)
  }

  private async document(record: RealResumeRecord): Promise<RealResumeDocument | null> {
    if (!record.extraction) return null
    const document = parseJson(await this.readReference(record.extraction.document)) as RealResumeDocument
    if (validateResumeDocumentBinding(document, record).length) throw unavailable('The saved resume document or extraction provenance is invalid.')
    return document
  }

  private async profile(record: RealResumeRecord, document: RealResumeDocument | null): Promise<RealResumeProfile | null> {
    if (!record.profileBlob) return null
    if (!document || !record.extraction) throw unavailable('The saved resume profile has no source document.')
    let profile: RealResumeProfile
    try { profile = parseRealResumeProfile(parseJson(await this.readReference(record.profileBlob))) } catch {
      throw unavailable('The saved resume profile is unavailable or invalid.')
    }
    if (validateRealResumeProfile(profile, document, {
      workspaceId: record.workspaceId, resumeId: record.id, documentSha256: record.extraction.document.sha256,
    }).length || profile.provenance.extractedAt < record.extraction.extractedAt ||
      (['name', 'role', 'location', 'experience'] as const).some(field => profile[field].value !== record.resume[field])) {
      throw unavailable('The saved resume profile does not match its captured evidence and display metadata.')
    }
    return profile
  }

  async list(workspaceId: string, continuationToken?: string, limit = 50): Promise<RealResumesPage> {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw notFound()
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (continuationToken !== undefined && (!continuationToken || continuationToken.length > 16 * 1024))) {
      throw invalidRequest('The resume page size or continuation token is invalid.')
    }
    const page = await this.store.list(workspaceId, { recordType: 'resume', continuationToken, limit })
    const values = page.items.map(value => this.decode(value, workspaceId, 'resume'))
    const duplicates = await this.duplicateWarnings(values.map(value => value.record))
    return {
      resumes: values.map(value => ({ ...summary(value), duplicates: duplicates.get(value.record.id) ?? [] })),
      ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}),
    }
  }

  async detail(workspaceId: string, resumeId: string): Promise<RealResumeDetail> {
    const current = await this.getResume(workspaceId, resumeId)
    const [document, , duplicates] = await Promise.all([
      this.document(current.record), this.capturedOriginal(current.record), this.duplicates(current.record),
    ])
    const profile = await this.profile(current.record, document)
    return { ...summary(current), duplicates, document, profile, extraction: current.record.extraction ?? null }
  }

  async original(workspaceId: string, resumeId: string): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
    const { record } = await this.getResume(workspaceId, resumeId)
    const original = await this.capturedOriginal(record)
    if (!original) throw notFound('The original source has not been captured yet.')
    const filename = record.source.kind !== 'url' ? record.source.fileName
      : `${record.id}.${originalExtension(record.capture!.original.contentType)}`
    return { bytes: original.bytes, contentType: original.contentType, filename }
  }

  private async duplicates(record: RealResumeRecord): Promise<ResumeDuplicateWarning[]> {
    return (await this.duplicateWarnings([record])).get(record.id) ?? []
  }

  private async duplicateWarnings(records: readonly RealResumeRecord[]): Promise<Map<string, ResumeDuplicateWarning[]>> {
    const duplicates = new Map(records.map(record => [record.id, [] as ResumeDuplicateWarning[]]))
    if (!records.length) return duplicates
    const byId = new Map(records.map(record => [record.id, record]))
    const byHash = new Map<string, Set<string>>()
    const byUrl = new Map<string, Set<string>>()
    const add = (index: Map<string, Set<string>>, value: string, id: string) => {
      const ids = index.get(value) ?? new Set<string>()
      ids.add(id)
      index.set(value, ids)
    }
    for (const record of records) {
      if (record.capture) add(byHash, record.capture.original.sha256, record.id)
      if (record.source.kind === 'url') add(byUrl, record.source.url, record.id)
    }
    const workspaceId = records[0].workspaceId
    const seen = new Set<string>()
    let continuationToken: string | undefined
    do {
      const page = await this.store.list(workspaceId, { recordType: 'resume', limit: 100, continuationToken })
      for (const value of page.items) {
        const other = this.decode(value, workspaceId, 'resume').record
        const matches = new Set([
          ...(other.capture ? byHash.get(other.capture.original.sha256) ?? [] : []),
          ...(other.source.kind === 'url' ? byUrl.get(other.source.url) ?? [] : []),
        ])
        for (const id of matches) {
          const warnings = duplicates.get(id)!
          if (other.id === id || warnings.length >= 100 || warnings.some(warning => warning.resumeId === other.id)) continue
          const record = byId.get(id)!
          warnings.push(record.capture && other.capture && record.capture.original.sha256 === other.capture.original.sha256
            ? { kind: 'exact-content', resumeId: other.id, message: 'The same original content is already imported in this workspace. Both resumes remain separate.' }
            : { kind: 'same-source', resumeId: other.id, message: 'This public URL is already imported in this workspace. Each import keeps its own captured source.' })
        }
      }
      if ([...duplicates.values()].every(warnings => warnings.length >= 100)) return duplicates
      continuationToken = page.continuationToken
      if (continuationToken) {
        if (seen.has(continuationToken)) throw unavailable('The resume library could not be paged safely.')
        seen.add(continuationToken)
      }
    } while (continuationToken)
    return duplicates
  }

  private async receipt(candidate: ImportReceipt): Promise<ImportReceipt> {
    const name = resumeImportReceiptBlobName(candidate.workspaceId, candidate.resumeId)
    const result = await this.blobs.putImmutable(name, Buffer.from(JSON.stringify(candidate)), 'application/json')
    jsonReference(name, result.blob)
    let stored: z.infer<typeof receiptSchema>
    try { stored = receiptSchema.parse(parseJson(result.blob)) } catch { throw unavailable('The saved resume import receipt is invalid.') }
    if (stored.inputFingerprint !== candidate.inputFingerprint) {
      throw conflict('This idempotency key was already used for different input. Use a new key for a new input.')
    }
    if (stored.workspaceId !== candidate.workspaceId || stored.resumeId !== candidate.resumeId ||
      stored.batchId !== candidate.batchId || stored.idempotencyKey !== candidate.idempotencyKey ||
      stored.createdBy !== candidate.createdBy || stored.inputCount !== candidate.inputCount ||
      stored.schemaVersion !== candidate.schemaVersion ||
      (stored.schemaVersion === 1 ? stored.pdfSha256 !== candidate.pdfSha256 || stored.markdownSha256 !== candidate.markdownSha256
        : stored.fileSha256 !== candidate.fileSha256) ||
      !same(stored.source, candidate.source)) {
      throw unavailable('The saved resume import receipt does not match its immutable request binding.')
    }
    return { ...candidate, createdAt: stored.createdAt }
  }

  private async import(
    workspaceId: string, input: ResumeImportRequest, source: RealResumeSource, file?: Uint8Array,
  ): Promise<ResumeImportResult> {
    const word = source.kind === 'docx' || source.kind === 'doc'
    const fileHash = file ? resumeSha256(file) : undefined
    // Preserve each format's original receipt and fingerprint fields on replay.
    const hashFields = word ? { fileSha256: fileHash }
      : source.kind === 'markdown' ? { markdownSha256: fileHash } : { pdfSha256: fileHash }
    const inputFingerprint = resumeContentHash({ source, batchId: input.batchId, inputCount: input.inputCount, createdBy: input.createdBy, ...hashFields })
    const candidate: ImportReceipt = {
      ...input, schemaVersion: word ? 2 : 1, dataKind: 'real', workspaceId, resumeId: resumeIdForKey(input.idempotencyKey),
      createdAt: this.now(), source, inputFingerprint, ...(fileHash ? hashFields : {}),
    }
    const existing = await this.accepted(candidate)
    if (existing) return { created: false, resume: summary(existing) }
    const currentBatch = await this.batch(workspaceId, input.batchId)
    if (currentBatch) {
      this.checkBatch(currentBatch.record, input)
      if (currentBatch.record.items.length >= input.inputCount) throw conflict('This import batch has already accepted its declared number of inputs. Start a new batch.')
    }
    const receipt = await this.receipt(candidate)
    const timestamp = [this.now(), receipt.createdAt].sort().at(-1)!
    const record: RealResumeRecord = {
      id: receipt.resumeId, recordType: 'resume', dataKind: 'real', workspaceId, createdAt: receipt.createdAt, updatedAt: timestamp,
      resume: {
        id: receipt.resumeId, dataKind: 'real', name: null, role: null, location: null, experience: null,
        documentId: resumeDocumentId(receipt.resumeId), documentVersion: 1, sourceLabel: source.displayName,
        batchId: input.batchId, status: 'queued', createdAt: receipt.createdAt,
      },
      source, batchId: input.batchId, idempotencyKey: input.idempotencyKey, inputFingerprint, createdBy: receipt.createdBy,
      attempts: 0, retryCount: 0, nextAttemptAt: timestamp, warnings: [], duplicates: [],
    }
    if (file) {
      if (source.kind === 'url') throw invalidRequest('URL inputs cannot contain uploaded bytes.')
      const contentType = UPLOAD_CONTENT_TYPES[source.kind]
      const name = resumeOriginalBlobName(workspaceId, record.id, source.kind)
      const result = await this.blobs.putImmutable(name, file, contentType)
      const original = resumeBlobReference(name, result.blob)
      const expectedHash = word ? receipt.fileSha256 : source.kind === 'markdown' ? receipt.markdownSha256 : receipt.pdfSha256
      if (original.sha256 !== expectedHash ||
        original.bytes !== file.byteLength || original.contentType !== contentType) {
        throw conflict('The original saved under this idempotency key is different. Nothing has been overwritten.')
      }
      const manifest: ResumeCaptureManifest = {
        schemaVersion: 1, dataKind: 'real', workspaceId, resumeId: record.id, inputFingerprint, source,
        capture: { original: { ...original, contentType }, capturedAt: receipt.createdAt, redirects: [] },
      }
      const manifestName = resumeCaptureBlobName(workspaceId, record.id)
      const captured = await this.blobs.putImmutable(manifestName, Buffer.from(JSON.stringify(manifest)), 'application/json')
      const reference = jsonReference(manifestName, captured.blob)
      let saved: ResumeCaptureManifest
      try { saved = parseResumeCaptureManifest(parseJson(captured.blob)) } catch { throw unavailable('The saved resume capture manifest is invalid.') }
      if (!same(saved, manifest)) throw unavailable('The winning resume capture does not match its immutable import receipt.')
      record.capture = saved.capture
      record.captureManifest = reference
    }
    // Only the same-partition transaction admits an item and publishes eligible work. Immutable
    // receipts/originals deliberately survive failures, including a lost successful response.
    for (let attempt = 0; attempt < 32; attempt++) {
      const accepted = await this.accepted(receipt)
      if (accepted) return { created: false, resume: summary(accepted) }
      const batch = await this.batch(workspaceId, receipt.batchId)
      if (batch) {
        this.checkBatch(batch.record, receipt)
        if (batch.record.items.some(item => item.idempotencyKey === receipt.idempotencyKey)) {
          throw unavailable('An admitted resume item is missing its published record. Nothing has been replaced.')
        }
        if (batch.record.items.length >= receipt.inputCount) throw conflict('This import batch has already accepted its declared number of inputs. Start a new batch.')
      }
      const admittedAt = [this.now(), record.createdAt, batch?.record.updatedAt ?? ''].sort().at(-1)!
      const admission = {
        idempotencyKey: receipt.idempotencyKey, inputFingerprint, resumeId: record.id, acceptedAt: admittedAt,
      }
      const nextBatch: ResumeImportBatchRecord = batch ? {
        ...batch.record, updatedAt: admittedAt, items: [...batch.record.items, admission],
      } : {
        id: resumeBatchRecordId(receipt.batchId), recordType: 'resume-batch', dataKind: 'real',
        workspaceId, createdAt: admittedAt, updatedAt: admittedAt, batchId: receipt.batchId,
        createdBy: receipt.createdBy, inputCount: receipt.inputCount, items: [admission],
      }
      const nextRecord = { ...record, updatedAt: admittedAt, duplicates: await this.duplicates(record) }
      parseResumeEntity(nextRecord)
      parseResumeEntity(nextBatch)
      const operations: ResumeTransaction[] = [
        batch ? { kind: 'replace', record: nextBatch, etag: batch.etag } : { kind: 'create', record: nextBatch },
        { kind: 'create', record: nextRecord },
      ]
      try {
        await this.store.transact(workspaceId, operations)
      } catch (error) {
        let confirmed: VersionedResumeEntity<RealResumeRecord> | undefined
        try { confirmed = await this.accepted(receipt) } catch (readError) {
          if (readError instanceof HttpError && readError.status === 409) throw readError
        }
        if (confirmed) return { created: false, resume: summary(confirmed) }
        if (error instanceof StoreConflictError || error instanceof StoreNotFoundError) continue
        throw unavailable('Import acceptance could not be confirmed. Retry this item with the same idempotency key and batch headers; do not create a replacement.')
      }
      const saved = await this.accepted(receipt)
      if (!saved) throw unavailable('Import acceptance could not be confirmed. Retry this item with the same idempotency key and batch headers.')
      return { created: true, resume: summary(saved) }
    }
    throw conflict('This import batch is busy. Retry this item with the same idempotency key and batch headers.')
  }

  private async importUploadedFile(
    workspaceId: string, input: ResumeImportRequest, kind: UploadFormat, filename: string, bytes: Uint8Array,
  ): Promise<ResumeImportResult> {
    validateRequest(workspaceId, input)
    const label = kind === 'markdown' ? 'Markdown' : kind.toUpperCase()
    if (!isSafeResumeFilename(filename, kind)) throw invalidRequest(`X-File-Name must be a safe ${label} basename.`)
    if (!(bytes instanceof Uint8Array)) throw invalidRequest(`The request must contain raw ${label} bytes.`)
    const body = Buffer.from(bytes)
    if (kind === 'pdf') await validatePdf(body)
    else if (kind === 'markdown') {
      try { decodeMarkdown(body, LIMITS.maxMarkdownBytes) } catch (error) {
        if (error instanceof MarkdownInputError) {
          throw new HttpError(error.code === 'markdown-too-large' ? 413 : 400, 'invalid_request', error.message)
        }
        throw error
      }
    } else {
      if (body.byteLength > LIMITS.maxFileBytes) throw new HttpError(413, 'invalid_request', 'Resume files may not exceed 10 MiB.')
      await validateWordUpload(body, kind)
    }
    return this.import(workspaceId, input, { kind, displayName: filename, fileName: filename }, body)
  }

  async importPdf(workspaceId: string, input: ResumeImportRequest, filename: string, bytes: Uint8Array): Promise<ResumeImportResult> {
    return this.importUploadedFile(workspaceId, input, 'pdf', filename, bytes)
  }

  async importMarkdown(workspaceId: string, input: ResumeImportRequest, filename: string, bytes: Uint8Array): Promise<ResumeImportResult> {
    return this.importUploadedFile(workspaceId, input, 'markdown', filename, bytes)
  }

  async importFile(
    workspaceId: string, input: ResumeImportRequest, filename: string, bytes: Uint8Array, contentType: UploadContentType,
  ): Promise<ResumeImportResult> {
    validateRequest(workspaceId, input)
    const format = uploadFormatFromFilename(filename)
    if (!format || UPLOAD_CONTENT_TYPES[format] !== contentType) {
      throw invalidRequest('The upload filename and Content-Type must match a supported PDF, Markdown, DOCX, or DOC file.')
    }
    return this.importUploadedFile(workspaceId, input, format, filename, bytes)
  }

  async importUrl(workspaceId: string, input: ResumeImportRequest, value: unknown): Promise<ResumeImportResult> {
    validateRequest(workspaceId, input)
    const url = normalizeResumePublicUrl(value)
    return this.import(workspaceId, input, { kind: 'url', displayName: url, url })
  }

  private async replace(current: VersionedResumeEntity<RealResumeRecord>, record: RealResumeRecord): Promise<RealResumeSummary> {
    parseResumeEntity(record)
    try { return summary(this.decode(await this.store.replace(record, current.etag), record.workspaceId, 'resume', record.id)) } catch (error) {
      if (error instanceof StoreConflictError || error instanceof StoreNotFoundError) throw conflict('This resume changed since you last loaded it. Reload before retrying the action.')
      throw error
    }
  }

  async retry(workspaceId: string, resumeId: string, expectedEtag: string): Promise<RealResumeSummary> {
    if (!validEtag(expectedEtag)) throw invalidRequest('If-Match must contain one exact resume ETag.')
    const current = await this.getResume(workspaceId, resumeId)
    if (current.etag !== expectedEtag) throw conflict('This resume changed since you last loaded it.')
    if (!['error', 'cancelled'].includes(current.record.resume.status)) throw conflict('Only failed or cancelled resumes can be retried.')
    const timestamp = this.now()
    const record: RealResumeRecord = {
      ...current.record, resume: { ...current.record.resume, status: 'queued' }, updatedAt: timestamp,
      attempts: 0, retryCount: current.record.retryCount + 1, nextAttemptAt: timestamp,
    }
    delete record.lease
    delete record.attemptId
    delete record.completedAt
    delete record.cancelledAt
    delete record.error
    return this.replace(current, record)
  }

  async cancel(workspaceId: string, resumeId: string, expectedEtag: string): Promise<RealResumeSummary> {
    if (!validEtag(expectedEtag)) throw invalidRequest('If-Match must contain one exact resume ETag.')
    const current = await this.getResume(workspaceId, resumeId)
    if (current.etag !== expectedEtag) throw conflict('This resume changed since you last loaded it.')
    if (current.record.resume.status === 'cancelled') return summary(current)
    if (!active.has(current.record.resume.status)) throw conflict('Only queued or processing resumes can be cancelled.')
    const timestamp = this.now()
    const record: RealResumeRecord = {
      ...current.record, resume: { ...current.record.resume, status: 'cancelled' }, updatedAt: timestamp, cancelledAt: timestamp,
    }
    delete record.lease
    delete record.attemptId
    delete record.nextAttemptAt
    delete record.completedAt
    delete record.error
    return this.replace(current, record)
  }
}
