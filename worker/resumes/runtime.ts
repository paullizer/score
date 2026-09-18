import { randomUUID } from 'node:crypto'
import { MIMEType } from 'node:util'
import { JSDOM } from 'jsdom'
import { PDFDocument } from 'pdf-lib'
import type {
  ImmutableBlobReference, ImmutableJsonBlobReference, RealResumeDocument, RealResumeProfile, RealResumeRecord,
  ResumeCaptureManifest, ResumeDuplicateWarning, ResumeExtractionProvenance, ResumeProcessingError,
  ResumeProcessingErrorCode, ResumeSourceCapture, VersionedResumeEntity,
} from '../../src/domain/real-resumes'
import { RESUME_IMPORT_LIMITS as LIMITS } from '../../src/domain/real-resumes'
import { documentPagination, isWordContentType, UPLOAD_CONTENT_TYPES } from '../../src/domain/document-formats'
import { hasOleSignature, hasZipSignature } from '../../server/documents/word'
import type { ResumeBlob, ResumeBlobStore, ResumeStore } from '../../server/resumes/store'
import { assertResumeWritable, putResumeBlob, resumeIsLocked, resumeIsRemoved } from '../../server/resumes/guards'
import {
  normalizeResumePublicUrl, parseRealResumeProfile, parseResumeCaptureManifest, parseResumeEntity,
  resumeBlobReference, resumeCaptureBlobName, resumeContentHash, resumeDocumentBlobName, resumeDocumentId,
  resumeOriginalBlobName, resumeProfileBlobName, resumeSha256, validateRealResumeDocument,
  validateRealResumeProfile, validateResumeDocumentBinding,
} from '../../server/resumes/validation'
import {
  analyzePdf, extractMarkdown, extractWordDocument, nodePinnedTransport, normalizeText, safeFetch, systemClock, WorkerError,
  WORD_EXTRACTION_VERSION, wordSourceWarnings,
  type BrowserRenderer, type Clock, type DocumentIntelligenceClientOptions, type RubricModelOptions,
  type SafeFetchOptions,
} from '../runtime'
import {
  documentIntelligenceResumeParagraphs, extractResumeHtml, ResumeExtractionError, ResumeHtmlShellError,
  RESUME_PARAGRAPH_OPTIONS, RESUME_SECTIONS,
} from './extraction'
import { extractResumeProfile, ResumeProfileError } from './model'
import { MARKDOWN_EXTRACTION_VERSION } from '../markdown'

const LEASE_MILLISECONDS = 90_000
const HEARTBEAT_MILLISECONDS = 25_000
const RUN_BUDGET_MILLISECONDS = 660_000
const MAX_HTTP_BYTES = 12 * 1024 * 1024
const EXTRACTION_VERSION = 'score-resume-extraction-v1'
const UNREADABLE_PDF_MESSAGE = 'The PDF could not be read. Remove password protection or export a readable PDF and try again.'
const PROFILE_FIELDS = ['name', 'role', 'location', 'experience'] as const
const ACTIVE = new Set(['parsing', 'profiling'])
const same = (left: unknown, right: unknown): boolean => resumeContentHash(left) === resumeContentHash(right)

export interface ResumeWorkerDependencies {
  store: ResumeStore
  blobs: ResumeBlobStore
  documentIntelligence: Omit<DocumentIntelligenceClientOptions, 'signal'>
  model: RubricModelOptions
  browser?: BrowserRenderer
  safeFetchOptions?: Omit<SafeFetchOptions, 'signal'>
  clock?: Clock
  owner?: string
}

export interface RunResumeWorkerOptions {
  maxItems?: number
  budgetMilliseconds?: number
  pendingLimit?: number
  signal?: AbortSignal
}

export class ResumeWorkerError extends Error {
  constructor(
    readonly code: ResumeProcessingErrorCode,
    message: string,
    readonly retryable = false,
    readonly stage: ResumeProcessingError['stage'] = 'publication',
  ) {
    super(message)
    this.name = 'ResumeWorkerError'
  }
}

class LostResumeWork extends Error {
  constructor() { super('The resume attempt is no longer owned by this worker.'); this.name = 'AbortError' }
}

class ResumeEncodingError extends ResumeWorkerError {
  constructor(reason: 'unsupported' | 'invalid' | 'unretained') {
    super(
      reason === 'invalid' ? 'unreadable-document' : 'unsupported-content',
      reason === 'unsupported'
        ? 'The HTML source declares an unsupported character encoding. Use a UTF-8 page or a PDF.'
        : reason === 'invalid'
          ? 'The HTML source contains invalid character encoding. No source text was replaced. Use a correctly encoded page or a PDF.'
          : 'The HTML character encoding cannot be preserved without the secure renderer. Use a UTF-8 page or a PDF.',
      false, 'parsing',
    )
  }
}

const MESSAGES: Record<ResumeProcessingErrorCode, string> = {
  'access-blocked': 'This URL is not publicly accessible and could not be processed.',
  'not-found': 'The public resume URL could not be found. Check the URL and import it again.',
  'network-error': 'The public resume source could not be retrieved because of a network error. Please retry.',
  'unsupported-content': 'Use a PDF, Markdown, DOCX, or DOC upload, or a public PDF/HTML profile URL. Markdown and Word documents must be uploaded as files, not imported by URL.',
  'unreadable-document': 'This public page did not provide readable resume text. Try another publicly accessible profile URL.',
  'pdf-too-large': 'Resume PDFs may not exceed 10 MiB.',
  'file-too-large': 'Resume files may not exceed 10 MiB.',
  'pdf-too-many-pages': 'Resume PDFs may contain at most 50 pages.',
  'source-too-large': 'The resume source exceeds its supported size or the 180,000-character extracted source limit. No content was truncated.',
  'multiple-profiles': 'This source contains multiple people or a profile directory. Import one person’s profile per item.',
  'not-a-profile': 'This source does not contain one readable professional resume or profile.',
  'invalid-profile': 'A source-grounded professional profile could not be extracted. No profile was created.',
  'invalid-source': 'The resume source or its captured provenance is invalid. Nothing has been replaced.',
  'invalid-model-output': 'The profile service returned an invalid or unsupported result. No profile was created.',
  'service-unavailable': 'A resume processing service is unavailable. Please retry when the service is available.',
  'storage-error': 'The saved resume evidence could not be stored or verified. Nothing has been replaced.',
  'timeout': 'Resume processing reached its time limit. Please retry.',
  'internal-error': 'Resume processing could not complete. Please retry.',
}

function failure(code: ResumeProcessingErrorCode, retryable = false, stage: ResumeProcessingError['stage'] = 'publication'): ResumeWorkerError {
  return new ResumeWorkerError(code, MESSAGES[code], retryable, stage)
}

function processingError(
  error: unknown, stage: ResumeProcessingError['stage'], contentType?: ResumeSourceCapture['original']['contentType'],
): ResumeProcessingError {
  const message = (code: ResumeProcessingErrorCode): string =>
    code === 'unreadable-document' && contentType === 'application/pdf' ? UNREADABLE_PDF_MESSAGE
      : code === 'unreadable-document' && isWordContentType(contentType)
        ? 'The Word document did not provide readable text. Remove protection or save a new DOCX. For content in images, export a PDF for OCR.'
      : code === 'unreadable-document' && contentType === 'text/markdown'
        ? 'The Markdown file did not contain readable resume text. Upload a UTF-8 Markdown resume.'
        : MESSAGES[code]
  if (error instanceof ResumeEncodingError) {
    return { code: error.code, stage: error.stage, retryable: false, message: error.message }
  }
  if (error instanceof ResumeWorkerError || error instanceof ResumeExtractionError || error instanceof ResumeProfileError) {
    return { code: error.code, stage: error.stage, retryable: error.retryable, message: message(error.code) }
  }
  if (error instanceof WorkerError) {
    if (error.code === 'invalid-markdown' || error.code === 'markdown-too-large') {
      return {
        code: error.code === 'markdown-too-large' ? 'source-too-large' : 'unreadable-document',
        stage: 'parsing', message: error.message, retryable: false,
      }
    }
    let code: ResumeProcessingErrorCode
    switch (error.code) {
      case 'source-access-denied': code = 'access-blocked'; break
      case 'dns-failed': code = 'network-error'; break
      case 'source-fetch-failed':
        code = /^The source returned HTTP (?:404|410)\.$/.test(error.message) ? 'not-found'
          : error.message === 'Remote request timed out.' ? 'timeout' : 'network-error'
        break
      case 'invalid-url': case 'unsafe-url': case 'invalid-redirect': case 'too-many-redirects':
        code = 'invalid-source'; break
      case 'source-too-large': case 'source-too-long': code = 'source-too-large'; break
      case 'pdf-too-large': code = 'pdf-too-large'; break
      case 'word-too-large': code = 'file-too-large'; break
      case 'word-expansion-limit': code = 'source-too-large'; break
      case 'word-timeout': code = 'timeout'; break
      case 'invalid-word': case 'encrypted-word': code = 'unreadable-document'; break
      case 'pdf-too-many-pages': code = 'pdf-too-many-pages'; break
      case 'password-protected-pdf': case 'invalid-pdf': case 'ocr-failed': case 'ocr-rejected':
      case 'ocr-invalid-page': case 'empty-source':
        code = error.retryable ? 'service-unavailable' : 'unreadable-document'; break
      case 'request-timeout': case 'ocr-timeout': code = 'timeout'; break
      default: code = 'service-unavailable'
    }
    return {
      code, stage, message: ['word-too-large', 'word-expansion-limit', 'word-timeout', 'invalid-word', 'encrypted-word'].includes(error.code)
        ? error.message : message(code), retryable: error.retryable,
    }
  }
  if (error instanceof Response) {
    return {
      code: 'service-unavailable', stage, message: MESSAGES['service-unavailable'],
      retryable: error.status === 429 || error.status >= 500,
    }
  }
  return { code: 'internal-error', stage, message: MESSAGES['internal-error'], retryable: true }
}

function conflict(error: unknown): boolean {
  if (error instanceof Error && ['StoreConflictError', 'StoreNotFoundError'].includes(error.name)) return true
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; statusCode?: unknown }
  return [404, 409, 412].includes(Number(value.statusCode ?? value.code))
}

function decodeRecord(value: VersionedResumeEntity): VersionedResumeEntity<RealResumeRecord> {
  try {
    const record = parseResumeEntity(value.record)
    if (record.recordType !== 'resume' || !value.etag || value.etag === '*' || value.etag.startsWith('W/') ||
      /[\r\n,]/.test(value.etag)) throw new Error()
    return { record, etag: value.etag }
  } catch { throw failure('storage-error') }
}

function updatedAt(record: RealResumeRecord, clock: Clock): string {
  return [record.updatedAt, clock.now().toISOString()].sort().at(-1)!
}

class ResumeLease {
  private readonly controller = new AbortController()
  private queue: Promise<unknown> = Promise.resolve()
  private heartbeat?: NodeJS.Timeout
  private deadlineTimer?: NodeJS.Timeout
  private lost = false
  private published = false
  private readonly onStop = () => {
    if (!this.published) this.controller.abort(failure('timeout', true, this.stage))
  }
  stage: ResumeProcessingError['stage']
  contentType?: ResumeSourceCapture['original']['contentType']
  readonly signal = this.controller.signal

  constructor(
    readonly claimed: VersionedResumeEntity<RealResumeRecord>,
    private readonly dependencies: ResumeWorkerDependencies,
    readonly owner: string,
    readonly clock: Clock,
    private readonly deadline?: number,
    private readonly stopping?: AbortSignal,
  ) {
    this.stage = claimed.record.resume.status === 'profiling' ? 'profiling' : 'parsing'
    this.contentType = claimed.record.capture?.original.contentType ??
      (claimed.record.source.kind !== 'url' ? UPLOAD_CONTENT_TYPES[claimed.record.source.kind] : undefined)
  }

  start(): void {
    this.heartbeat = setInterval(() => {
      void this.update(record => {
        const time = updatedAt(record, this.clock)
        const expiresAt = new Date(Date.parse(time) + LEASE_MILLISECONDS).toISOString()
        return { ...record, updatedAt: time, nextAttemptAt: expiresAt, lease: { owner: this.owner, expiresAt, heartbeatAt: time } }
      }).catch(() => {
        if (this.published || this.signal.aborted) return
        this.lost = true
        this.controller.abort(new LostResumeWork())
      })
    }, HEARTBEAT_MILLISECONDS)
    this.heartbeat.unref()
    if (this.deadline !== undefined) {
      this.deadlineTimer = setTimeout(this.onStop, Math.max(1, this.deadline - this.clock.now().getTime()))
      this.deadlineTimer.unref()
    }
    this.stopping?.addEventListener('abort', this.onStop, { once: true })
    if (this.stopping?.aborted) this.onStop()
  }

  private markLost(): never {
    if (!this.published) {
      this.lost = true
      this.controller.abort(new LostResumeWork())
    }
    throw new LostResumeWork()
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private checkSignal(allowAborted: boolean): void {
    if (this.lost) throw new LostResumeWork()
    if (!allowAborted && this.deadline !== undefined && this.clock.now().getTime() >= this.deadline) this.onStop()
    if (!allowAborted && this.signal.aborted) throw this.signal.reason
  }

  private async owned(allowAborted = false): Promise<VersionedResumeEntity<RealResumeRecord>> {
    this.checkSignal(allowAborted)
    const initial = this.claimed.record
    try { await assertResumeWritable(this.dependencies.store, initial.workspaceId, initial.id) } catch (error) {
      if (conflict(error)) return this.markLost()
      throw error
    }
    const value = await this.dependencies.store.get(initial.workspaceId, initial.id)
    this.checkSignal(allowAborted)
    if (!value) return this.markLost()
    const live = decodeRecord(value)
    const record = live.record
    if (record.workspaceId !== initial.workspaceId || record.id !== initial.id ||
      record.inputFingerprint !== initial.inputFingerprint || record.retryCount !== initial.retryCount ||
      record.attempts !== initial.attempts ||
      record.attemptId !== initial.attemptId || !ACTIVE.has(record.resume.status) || resumeIsLocked(record.lifecycle) ||
      record.lease?.owner !== this.owner || Date.parse(record.lease.expiresAt) <= this.clock.now().getTime()) {
      return this.markLost()
    }
    return live
  }

  check(): Promise<VersionedResumeEntity<RealResumeRecord>> {
    return this.exclusive(() => this.owned())
  }

  async putBlob(blobs: ResumeBlobStore, name: string, bytes: Uint8Array, contentType: string) {
    return putResumeBlob(this.dependencies.store, blobs, name, bytes, contentType, {
      signal: this.signal, assertActive: () => this.check(),
    })
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.checkSignal(false)
    let onAbort: () => void = () => undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason)
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
    try { return await Promise.race([operation(), cancelled]) } finally {
      this.signal.removeEventListener('abort', onAbort)
    }
  }

  update(
    mutate: (record: RealResumeRecord) => RealResumeRecord,
    allowAborted = false,
  ): Promise<VersionedResumeEntity<RealResumeRecord>> {
    return this.exclusive(async () => {
      const live = await this.owned(allowAborted)
      const next = mutate(live.record)
      parseResumeEntity(next)
      this.checkSignal(allowAborted)
      const saved = (value: VersionedResumeEntity): VersionedResumeEntity<RealResumeRecord> => {
        const decoded = decodeRecord(value)
        if (!same(decoded.record, next)) throw failure('storage-error')
        if (decoded.record.resume.status === 'ready') {
          this.published = true
          if (this.heartbeat) clearInterval(this.heartbeat)
          if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
        }
        return decoded
      }
      try {
        return saved(await this.dependencies.store.replace(next, live.etag))
      } catch (error) {
        if (conflict(error)) return this.markLost()
        // A lost response may follow a successful conditional write, including publication.
        const current = await this.dependencies.store.get(next.workspaceId, next.id).catch(() => undefined)
        if (current && same(current.record, next)) return saved(current)
        throw failure('storage-error', true)
      }
    })
  }

  get completed(): boolean { return this.published }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.stopping?.removeEventListener('abort', this.onStop)
    await this.queue.catch(() => undefined)
  }
}

function reference(name: string, blob: ResumeBlob, expected?: ImmutableBlobReference): ImmutableBlobReference {
  let actual: ImmutableBlobReference
  try { actual = resumeBlobReference(name, blob) } catch { throw failure('storage-error') }
  if (expected && (actual.blobName !== expected.blobName || actual.contentType !== expected.contentType ||
    actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)) throw failure('storage-error')
  return actual
}

function jsonReference(name: string, blob: ResumeBlob, expected?: ImmutableBlobReference): ImmutableJsonBlobReference {
  const value = reference(name, blob, expected)
  if (value.contentType !== 'application/json') throw failure('storage-error')
  return { ...value, contentType: 'application/json' }
}

async function readBlob(blobs: ResumeBlobStore, name: string, expected?: ImmutableBlobReference): Promise<ResumeBlob | undefined> {
  let blob: ResumeBlob | undefined
  try { blob = await blobs.read(name) } catch { throw failure('storage-error', true) }
  if (blob) reference(name, blob, expected)
  return blob
}

function json(blob: ResumeBlob): unknown {
  try { return JSON.parse(Buffer.from(blob.bytes).toString('utf8')) } catch { throw failure('storage-error') }
}

async function saveBlob(
  lease: ResumeLease, blobs: ResumeBlobStore, name: string, bytes: Uint8Array, contentType: string,
): Promise<ResumeBlob> {
  await lease.check()
  let blob: ResumeBlob
  try { blob = (await lease.putBlob(blobs, name, bytes, contentType)).blob } catch {
    await lease.check()
    const winner = await readBlob(blobs, name)
    if (!winner) throw failure('storage-error', true)
    blob = winner
  }
  await lease.check()
  reference(name, blob)
  return blob
}

function publicUrl(value: string): string {
  try { return normalizeResumePublicUrl(value) } catch { throw failure('invalid-source', false, 'download') }
}

function pdfSignature(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).indexOf(Buffer.from('%PDF-')) >= 0
}

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  if (bytes.byteLength > LIMITS.maxPdfBytes) throw failure('pdf-too-large', false, 'parsing')
  if (!pdfSignature(bytes)) throw failure('unreadable-document', false, 'parsing')
  let count: number
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true })
    if (pdf.isEncrypted || pdf.context.trailerInfo.Encrypt !== undefined) throw new Error()
    count = pdf.getPageCount()
  } catch { throw failure('unreadable-document', false, 'parsing') }
  if (count < 1) throw failure('unreadable-document', false, 'parsing')
  if (count > LIMITS.maxPdfPages) throw failure('pdf-too-many-pages', false, 'parsing')
  return count
}

function sourceOptions(dependencies: ResumeWorkerDependencies, signal: AbortSignal): SafeFetchOptions {
  const options = dependencies.safeFetchOptions ?? {}
  const transport = options.transport ?? nodePinnedTransport
  const limit = (value: number | undefined, maximum: number, minimum = 1): number => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) throw failure('invalid-source', false, 'download')
    return Math.min(value ?? maximum, maximum)
  }
  return {
    ...options, signal, method: 'GET', body: undefined, followRedirects: true,
    transport: request => {
      publicUrl(request.url.href)
      return transport(request)
    },
    maxBytes: limit(options.maxBytes, MAX_HTTP_BYTES),
    maxRedirects: limit(options.maxRedirects, 5, 0),
    timeoutMilliseconds: limit(options.timeoutMilliseconds, 30_000),
    headers: { accept: 'text/html,application/xhtml+xml,application/pdf', 'user-agent': 'ScoreResumeImporter/1.0' },
  }
}

interface DownloadedSource {
  bytes: Uint8Array
  contentType: 'application/pdf' | 'text/html'
  finalUrl: string
  redirects: string[]
  method: ResumeExtractionProvenance['method']
}

function charset(contentType?: string): string | undefined {
  if (contentType === undefined) return undefined
  try { return new MIMEType(contentType).params.get('charset') ?? undefined } catch {
    throw new ResumeEncodingError('unsupported')
  }
}

function decoder(label: string): TextDecoder {
  try { return new TextDecoder(label, { fatal: true }) } catch { throw new ResumeEncodingError('unsupported') }
}

function declaredHtmlEncoding(bytes: Uint8Array): string | undefined {
  const prefix = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  const xml = /^<\?xml\s[^?]*\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')[^?]*\?>/i.exec(prefix)
  if (xml) return xml[1] ?? xml[2]
  const fragment = JSDOM.fragment(prefix)
  const labels = new Set<string>()
  for (const meta of fragment.querySelectorAll('meta[charset],meta[http-equiv]')) {
    const label = meta.hasAttribute('charset') ? meta.getAttribute('charset')!
      : meta.getAttribute('http-equiv')?.trim().toLowerCase() === 'content-type'
        ? charset(meta.getAttribute('content') ?? '') : undefined
    if (label === undefined) continue
    let encoding = decoder(label).encoding
    // HTML meta declarations cannot select UTF-16; a real UTF-16 source needs a BOM or transport declaration.
    if (encoding === 'utf-16le' || encoding === 'utf-16be') encoding = 'utf-8'
    labels.add(encoding)
  }
  if (labels.size > 1) throw new ResumeEncodingError('invalid')
  return labels.values().next().value
}

function decodeHtml(bytes: Uint8Array, contentType?: string): string {
  let bom: string | undefined
  if ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) ||
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)) {
    throw new ResumeEncodingError('unsupported')
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom = 'utf-8'
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) bom = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) bom = 'utf-16be'
  const selected = decoder(bom ?? charset(contentType) ?? declaredHtmlEncoding(bytes) ?? 'utf-8')
  try {
    const html = selected.decode(bytes)
    if (html.includes('\0')) throw new Error()
    return html
  } catch { throw new ResumeEncodingError('invalid') }
}

function renderedHtmlBytes(html: string): Uint8Array {
  const bytes = Buffer.from(html, 'utf8')
  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== html || html.includes('\0')) {
    throw new ResumeEncodingError('invalid')
  }
  // Renderer strings are already Unicode. A BOM makes their stored UTF-8 bytes unambiguous
  // even when the serialized DOM retains an old meta charset from the fetched page.
  const captured = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? bytes : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
  if (captured.byteLength > LIMITS.maxPdfBytes) throw failure('source-too-large', false, 'download')
  return captured
}

function unrelatedShell(html: string): boolean {
  const fragment = JSDOM.fragment(html)
  return /\b(?:shop|products|news|article|blog|directory|search results|our team)\b/i.test(
    fragment.querySelector('title')?.textContent ?? '',
  )
}

async function downloadSource(
  record: RealResumeRecord, dependencies: ResumeWorkerDependencies, lease: ResumeLease,
): Promise<DownloadedSource> {
  if (record.source.kind !== 'url') throw failure('invalid-source', false, 'download')
  const options = sourceOptions(dependencies, lease.signal)
  await lease.check()
  let response: Awaited<ReturnType<typeof safeFetch>>
  try { response = await safeFetch(publicUrl(record.source.url), options) } catch (error) {
    if (lease.signal.aborted) throw lease.signal.reason
    if (error instanceof ResumeWorkerError) throw error
    const mapped = error instanceof WorkerError ? processingError(error, 'download')
      : { code: 'network-error' as const, retryable: true }
    throw failure(mapped.code, mapped.retryable, 'download')
  }
  await lease.check()
  const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1]
  const type = contentType?.split(';', 1)[0].trim().toLowerCase()
  const finalUrl = publicUrl(response.url)
  const redirects = (response.redirects ?? []).map(publicUrl)
  if (isWordContentType(type) || hasOleSignature(response.body) || hasZipSignature(response.body)) {
    throw failure('unsupported-content', false, 'download')
  }
  if (type === 'application/pdf' || pdfSignature(response.body)) {
    lease.contentType = 'application/pdf'
    await pdfPageCount(response.body)
    return { bytes: response.body, contentType: 'application/pdf', finalUrl, redirects, method: 'document-intelligence' }
  }
  if (!['text/html', 'application/xhtml+xml'].includes(type ?? '')) throw failure('unsupported-content', false, 'download')
  lease.contentType = 'text/html'
  const html = decodeHtml(response.body, contentType)
  // Immutable captures retain raw bytes but not transient HTTP headers. Require replayable
  // decoding, or preserve the isolated renderer's Unicode output as a UTF-8 snapshot.
  let replayable = false
  try { replayable = decodeHtml(response.body) === html } catch (error) {
    if (!(error instanceof ResumeEncodingError)) throw error
  }
  let extracted: ReturnType<typeof extractResumeHtml> | undefined
  try { extracted = extractResumeHtml(html, finalUrl) } catch (error) {
    // A rejected populated page or access wall is never a reason to browse around the rejection.
    if (!(error instanceof ResumeHtmlShellError)) throw error
    if (unrelatedShell(html)) throw failure('not-a-profile', false, 'parsing')
  }
  if (!extracted && !dependencies.browser) throw failure('service-unavailable', true, 'download')
  if (!replayable && !dependencies.browser) throw new ResumeEncodingError('unretained')
  if ((!extracted || extracted.thin || !replayable) && dependencies.browser) {
    let rendered: Awaited<ReturnType<BrowserRenderer['render']>>
    try { rendered = await dependencies.browser.render(finalUrl, options) } catch (error) {
      if (lease.signal.aborted) throw lease.signal.reason
      const mapped = processingError(error, 'download')
      throw failure(mapped.code === 'internal-error' ? 'service-unavailable' : mapped.code, mapped.retryable, 'download')
    }
    await lease.check()
    const renderedUrl = publicUrl(rendered.finalUrl)
    const renderedBytes = renderedHtmlBytes(rendered.html)
    extractResumeHtml(rendered.html, renderedUrl)
    return {
      bytes: renderedBytes, contentType: 'text/html', finalUrl: renderedUrl, redirects,
      method: 'browser',
    }
  }
  return { bytes: response.body, contentType: 'text/html', finalUrl, redirects, method: 'html' }
}

function captureManifest(blob: ResumeBlob, record: RealResumeRecord): ResumeCaptureManifest {
  let manifest: ResumeCaptureManifest
  try { manifest = parseResumeCaptureManifest(json(blob)) } catch { throw failure('storage-error') }
  if (manifest.workspaceId !== record.workspaceId || manifest.resumeId !== record.id ||
    manifest.inputFingerprint !== record.inputFingerprint || !same(manifest.source, record.source) ||
    manifest.capture.capturedAt < record.createdAt || (record.capture && !same(manifest.capture, record.capture))) {
    throw failure('invalid-source', false, 'download')
  }
  return manifest
}

interface CapturedSource {
  blob: ResumeBlob
  capture: ResumeSourceCapture
  method: ResumeExtractionProvenance['method']
}

async function captureSource(dependencies: ResumeWorkerDependencies, lease: ResumeLease): Promise<CapturedSource> {
  const { record } = await lease.check()
  const name = resumeCaptureBlobName(record.workspaceId, record.id)
  let savedManifest = await readBlob(dependencies.blobs, name, record.captureManifest)
  let downloaded: DownloadedSource | undefined
  if (!savedManifest) {
    if (record.capture || record.captureManifest || record.source.kind !== 'url') throw failure('storage-error', true)
    for (const type of ['pdf', 'html'] as const) {
      const orphan = await readBlob(dependencies.blobs, resumeOriginalBlobName(record.workspaceId, record.id, type))
      // Without a manifest there is no trustworthy final URL for an orphaned original.
      if (orphan) throw failure('invalid-source', false, 'download')
    }
    downloaded = await downloadSource(record, dependencies, lease)
    const originalName = resumeOriginalBlobName(record.workspaceId, record.id, downloaded.contentType)
    const original = reference(originalName, {
      bytes: downloaded.bytes, contentType: downloaded.contentType, sha256: resumeSha256(downloaded.bytes), etag: 'unpublished',
    })
    const candidate: ResumeCaptureManifest = {
      schemaVersion: 1, dataKind: 'real', workspaceId: record.workspaceId, resumeId: record.id,
      inputFingerprint: record.inputFingerprint, source: record.source,
      capture: {
        original: { ...original, contentType: downloaded.contentType }, capturedAt: updatedAt(record, lease.clock),
        finalUrl: downloaded.finalUrl, redirects: downloaded.redirects,
      },
    }
    parseResumeCaptureManifest(candidate)
    // Reserve provenance before bytes: a loser can never relabel winning bytes with its final URL.
    savedManifest = await saveBlob(lease, dependencies.blobs, name, Buffer.from(JSON.stringify(candidate)), 'application/json')
  }
  const manifest = captureManifest(savedManifest, record)
  lease.contentType = manifest.capture.original.contentType
  let original = await readBlob(dependencies.blobs, manifest.capture.original.blobName, manifest.capture.original)
  if (!original) {
    if (record.source.kind !== 'url') throw failure('storage-error', true)
    downloaded ??= await downloadSource(record, dependencies, lease)
    if (resumeSha256(downloaded.bytes) !== manifest.capture.original.sha256 ||
      downloaded.contentType !== manifest.capture.original.contentType ||
      downloaded.bytes.byteLength !== manifest.capture.original.bytes) {
      throw failure('invalid-source', false, 'download')
    }
    original = await saveBlob(
      lease, dependencies.blobs, manifest.capture.original.blobName, downloaded.bytes, downloaded.contentType,
    )
    reference(manifest.capture.original.blobName, original, manifest.capture.original)
  }
  const duplicates = await duplicateWarnings(dependencies, lease, { ...record, capture: manifest.capture })
  await lease.update(live => ({
    ...live, capture: manifest.capture, captureManifest: jsonReference(name, savedManifest!), duplicates,
    updatedAt: updatedAt(live, lease.clock),
  }))
  const matchingDownload = downloaded && resumeSha256(downloaded.bytes) === original.sha256 &&
    downloaded.finalUrl === manifest.capture.finalUrl
  return {
    blob: original, capture: manifest.capture,
    method: manifest.capture.original.contentType === UPLOAD_CONTENT_TYPES.doc ? 'legacy-word'
      : manifest.capture.original.contentType === 'application/pdf' || manifest.capture.original.contentType === UPLOAD_CONTENT_TYPES.docx ? 'document-intelligence'
      : manifest.capture.original.contentType === 'text/markdown' ? 'markdown'
        : matchingDownload ? downloaded!.method : 'html',
  }
}

function documentFromBlob(blob: ResumeBlob, record: RealResumeRecord): RealResumeDocument {
  const value = json(blob)
  if (validateRealResumeDocument(value).length) throw failure('invalid-source', false, 'parsing')
  const document = value as RealResumeDocument
  if (document.id !== resumeDocumentId(record.id) || document.version !== record.resume.documentVersion) {
    throw failure('invalid-source', false, 'parsing')
  }
  return document
}

function characterCount(document: RealResumeDocument): number {
  return document.paragraphs.reduce((total, paragraph) => total + paragraph.heading.length + paragraph.text.length, 0)
}

function warnings(...values: string[][]): string[] {
  return [...new Set(values.flat())].slice(0, 100)
}

async function duplicateWarnings(
  dependencies: ResumeWorkerDependencies, lease: ResumeLease, record: RealResumeRecord,
): Promise<ResumeDuplicateWarning[]> {
  const result: ResumeDuplicateWarning[] = []
  const seen = new Set<string>()
  let continuationToken: string | undefined
  do {
    await lease.check()
    const page = await dependencies.store.list(record.workspaceId, { recordType: 'resume', limit: 100, continuationToken })
    for (const value of page.items) {
      const other = decodeRecord(value).record
      if (other.workspaceId !== record.workspaceId) throw failure('storage-error')
      if (other.id === record.id || resumeIsRemoved(other.lifecycle) || result.some(item => item.resumeId === other.id)) continue
      if (record.capture && other.capture && record.capture.original.sha256 === other.capture.original.sha256) {
        result.push({
          kind: 'exact-content', resumeId: other.id,
          message: 'The same original content is already imported in this workspace. Both resumes remain separate.',
        })
      } else if (record.source.kind === 'url' && other.source.kind === 'url' && record.source.url === other.source.url) {
        result.push({
          kind: 'same-source', resumeId: other.id,
          message: 'This public URL is already imported in this workspace. Each import keeps its own captured source.',
        })
      }
      if (result.length >= 100) return result
    }
    continuationToken = page.continuationToken
    if (continuationToken) {
      if (seen.has(continuationToken)) throw failure('storage-error')
      seen.add(continuationToken)
    }
  } while (continuationToken)
  return result
}

async function extractSource(
  dependencies: ResumeWorkerDependencies, lease: ResumeLease, original: CapturedSource,
): Promise<RealResumeDocument> {
  const { record } = await lease.check()
  const pdf = original.blob.contentType === 'application/pdf'
  const word = isWordContentType(original.blob.contentType)
  const wordFormat = original.blob.contentType === UPLOAD_CONTENT_TYPES.doc ? 'doc' : 'docx'
  const markdown = original.blob.contentType === 'text/markdown'
  const pageCount = pdf ? await pdfPageCount(original.blob.bytes) : null
  const name = resumeDocumentBlobName(record.workspaceId, record.id, record.resume.documentVersion)
  let blob = await readBlob(dependencies.blobs, name, record.extraction?.document)
  let sourceWarnings: string[] = word ? wordSourceWarnings(wordFormat) : []
  if (!blob) {
    if (record.extraction) throw failure('storage-error', true)
    let document: RealResumeDocument
    if (pdf) {
      let analysis: Awaited<ReturnType<typeof analyzePdf>>
      try {
        analysis = await analyzePdf(original.blob.bytes, {
          ...dependencies.documentIntelligence, clock: dependencies.documentIntelligence.clock ?? lease.clock, signal: lease.signal,
          allowPdfHeaderPrefix: true,
        })
      } catch (error) {
        if (lease.signal.aborted) throw lease.signal.reason
        const mapped = processingError(error, 'parsing')
        throw failure(mapped.code, mapped.retryable, 'parsing')
      }
      await lease.check()
      const pages = analysis.analyzeResult?.pages
      if (!pages || pages.length !== pageCount || new Set(pages.map(page => page.pageNumber)).size !== pageCount ||
        pages.some(page => !Number.isInteger(page.pageNumber) || page.pageNumber! < 1 || page.pageNumber! > pageCount!)) {
        throw failure('service-unavailable', true, 'parsing')
      }
      document = {
        id: resumeDocumentId(record.id), kind: 'resume', sample: false, version: record.resume.documentVersion,
        title: record.source.kind !== 'url' ? record.source.fileName : 'Imported resume',
        paragraphs: documentIntelligenceResumeParagraphs(analysis),
      }
    } else if (word) {
      const extracted = await extractWordDocument(original.blob.bytes, wordFormat, {
        ...dependencies.documentIntelligence, clock: dependencies.documentIntelligence.clock ?? lease.clock, signal: lease.signal,
      }, { ...RESUME_PARAGRAPH_OPTIONS, sectionHeadingPattern: RESUME_SECTIONS })
      await lease.check()
      sourceWarnings = extracted.warnings
      document = {
        id: resumeDocumentId(record.id), kind: 'resume', sample: false, version: record.resume.documentVersion,
        title: record.source.kind !== 'url' ? record.source.fileName : 'Imported resume',
        paragraphs: extracted.paragraphs,
      }
    } else if (markdown) {
      const extracted = extractMarkdown(original.blob.bytes, {
        defaultHeading: 'Resume', maxCharacters: LIMITS.maxSourceCharacters,
        emptySourceMessage: 'The Markdown file did not contain readable resume text.',
      })
      document = {
        id: resumeDocumentId(record.id), kind: 'resume', sample: false, version: record.resume.documentVersion,
        title: extracted.title?.slice(0, 500) ?? record.source.displayName, paragraphs: extracted.paragraphs,
      }
    } else {
      const extracted = extractResumeHtml(decodeHtml(original.blob.bytes), original.capture.finalUrl!)
      sourceWarnings = extracted.warnings
      document = {
        id: resumeDocumentId(record.id), kind: 'resume', sample: false, version: record.resume.documentVersion,
        title: normalizeText(extracted.title).slice(0, 500) || 'Imported resume', paragraphs: extracted.paragraphs,
      }
    }
    if (characterCount(document) > LIMITS.maxSourceCharacters) throw failure('source-too-large', false, 'parsing')
    if (validateRealResumeDocument(document).length) throw failure('invalid-source', false, 'parsing')
    blob = await saveBlob(lease, dependencies.blobs, name, Buffer.from(JSON.stringify(document)), 'application/json')
  } else if (original.blob.contentType === 'text/html') {
    // Re-check retained HTML, including access walls, rather than trusting a cache to legitimize it.
    sourceWarnings = extractResumeHtml(decodeHtml(original.blob.bytes), original.capture.finalUrl!).warnings
  }
  const document = documentFromBlob(blob, record)
  const extraction: ResumeExtractionProvenance = record.extraction ?? {
    method: original.method, version: word ? WORD_EXTRACTION_VERSION : markdown ? MARKDOWN_EXTRACTION_VERSION : EXTRACTION_VERSION, extractedAt: updatedAt(record, lease.clock),
    pagination: documentPagination(original.capture.original.contentType), pageCount, normalizedCharacters: characterCount(document),
    document: {
      ...jsonReference(name, blob), documentId: document.id, documentVersion: document.version,
    },
  }
  if (extraction.pageCount !== pageCount || validateResumeDocumentBinding(document, { ...record, extraction }).length) {
    throw failure('invalid-source', false, 'parsing')
  }
  await lease.update(live => ({
    ...live, extraction, warnings: warnings(live.warnings, sourceWarnings),
    updatedAt: updatedAt(live, lease.clock), resume: { ...live.resume, status: 'profiling' },
  }))
  lease.stage = 'profiling'
  return document
}

function profileFromBlob(blob: ResumeBlob, document: RealResumeDocument, record: RealResumeRecord): RealResumeProfile {
  let profile: RealResumeProfile
  try { profile = parseRealResumeProfile(json(blob)) } catch { throw failure('invalid-profile', false, 'profiling') }
  if (!record.extraction || validateRealResumeProfile(profile, document, {
    workspaceId: record.workspaceId, resumeId: record.id, documentSha256: record.extraction.document.sha256,
  }).length || profile.provenance.extractedAt < record.extraction.extractedAt ||
    (record.profileBlob && PROFILE_FIELDS.some(field => record.resume[field] !== profile[field].value))) {
    throw failure('invalid-profile', false, 'profiling')
  }
  return profile
}

async function profileSource(dependencies: ResumeWorkerDependencies, lease: ResumeLease, document: RealResumeDocument): Promise<void> {
  const { record } = await lease.check()
  const name = resumeProfileBlobName(record.workspaceId, record.id, document.version)
  let blob = await readBlob(dependencies.blobs, name, record.profileBlob)
  if (!blob) {
    if (record.profileBlob) throw failure('storage-error', true)
    const result = await extractResumeProfile(document, {
      workspaceId: record.workspaceId, resumeId: record.id, documentSha256: record.extraction!.document.sha256,
      model: { ...dependencies.model, clock: dependencies.model.clock ?? lease.clock },
      clock: lease.clock, signal: lease.signal,
    })
    await lease.check()
    const profileBytes = Buffer.from(JSON.stringify(result.profile))
    profileFromBlob({
      bytes: profileBytes, sha256: resumeSha256(profileBytes), contentType: 'application/json', etag: 'unpublished',
    }, document, record)
    await lease.update(live => ({
      ...live, updatedAt: updatedAt(live, lease.clock), warnings: warnings(live.warnings, result.warnings),
    }))
    blob = await saveBlob(lease, dependencies.blobs, name, profileBytes, 'application/json')
  }
  const profile = profileFromBlob(blob, document, record)
  const profileBlob = jsonReference(name, blob, record.profileBlob)
  await lease.update(live => ({
    ...live, profileBlob, completedAt: updatedAt(live, lease.clock), updatedAt: updatedAt(live, lease.clock),
    error: undefined, lease: undefined, nextAttemptAt: undefined,
    warnings: warnings(live.warnings, PROFILE_FIELDS.filter(field => profile[field].status === 'unavailable')
      .map(field => `The source does not explicitly support the ${field} field; it remains unavailable.`)),
    resume: {
      ...live.resume, status: 'ready', name: profile.name.value, role: profile.role.value,
      location: profile.location.value, experience: profile.experience.value,
    },
  }))
}

async function recordFailure(lease: ResumeLease, error: unknown): Promise<void> {
  if (error instanceof LostResumeWork) return
  const problem = processingError(error, lease.stage, lease.contentType)
  try {
    await lease.update(record => {
      const retry = problem.retryable && record.attempts < LIMITS.maxAutomaticAttempts
      const time = updatedAt(record, lease.clock)
      return {
        ...record, updatedAt: time, lease: undefined,
        nextAttemptAt: retry ? new Date(Date.parse(time) + 15_000 * 2 ** (record.attempts - 1)).toISOString() : undefined,
        completedAt: retry ? undefined : time,
        error: {
          ...problem, message: problem.retryable && !retry ? `${problem.message} Automatic retry limit reached.` : problem.message,
        },
        resume: { ...record.resume, status: retry ? 'queued' : 'error' },
      }
    }, true)
  } catch {
    // Cancellation, a changed attempt, or an expired lease always beats late failure publication.
  }
}

async function claim(
  dependencies: ResumeWorkerDependencies, candidate: VersionedResumeEntity<RealResumeRecord>, owner: string, clock: Clock,
): Promise<VersionedResumeEntity<RealResumeRecord> | undefined> {
  const { record, etag } = decodeRecord(candidate)
  if (resumeIsLocked(record.lifecycle)) return undefined
  try { await assertResumeWritable(dependencies.store, record.workspaceId, record.id) } catch (error) {
    if (conflict(error)) return undefined
    throw error
  }
  const time = clock.now()
  if (['ready', 'cancelled', 'error'].includes(record.resume.status) ||
    (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > time.getTime()) ||
    (record.lease && Date.parse(record.lease.expiresAt) > time.getTime())) return undefined
  const timestamp = updatedAt(record, clock)
  const exhausted = record.attempts >= LIMITS.maxAutomaticAttempts
  const expiresAt = new Date(Date.parse(timestamp) + LEASE_MILLISECONDS).toISOString()
  const next: RealResumeRecord = exhausted ? {
    ...record, updatedAt: timestamp, lease: undefined, nextAttemptAt: undefined, completedAt: timestamp,
    error: {
      code: 'timeout', retryable: true, stage: record.extraction ? 'profiling' : 'parsing',
      message: 'Resume processing stopped after three automatic attempts. Retry to start a new attempt cycle.',
    },
    resume: { ...record.resume, status: 'error' },
  } : {
    ...record, attempts: record.attempts + 1, attemptId: randomUUID(), updatedAt: timestamp,
    nextAttemptAt: expiresAt, error: undefined, completedAt: undefined,
    lease: { owner, expiresAt, heartbeatAt: timestamp },
    resume: { ...record.resume, status: record.extraction ? 'profiling' : 'parsing' },
  }
  parseResumeEntity(next)
  try {
    const claimed = decodeRecord(await dependencies.store.replace(next, etag))
    return exhausted ? undefined : claimed
  } catch (error) {
    if (conflict(error)) return undefined
    const live = await dependencies.store.get(record.workspaceId, record.id).catch(() => undefined)
    if (!exhausted && live && same(live.record, next)) return decodeRecord(live)
    throw failure('storage-error', true)
  }
}

/** Returns true only when a validated profile was durably published as ready. */
export async function processClaimedResume(
  claimed: VersionedResumeEntity<RealResumeRecord>,
  dependencies: ResumeWorkerDependencies,
  owner: string,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const lease = new ResumeLease(claimed, dependencies, owner, dependencies.clock ?? systemClock, deadlineAt, signal)
  lease.start()
  try {
    await lease.run(async () => {
      const original = await captureSource(dependencies, lease)
      const document = await extractSource(dependencies, lease, original)
      await profileSource(dependencies, lease, document)
    })
    return true
  } catch (error) {
    await recordFailure(lease, lease.signal.aborted ? lease.signal.reason : error)
    return lease.completed
  } finally {
    await lease.stop()
  }
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid resume worker execution limits.')
  return value
}

export async function runResumeWorker(
  dependencies: ResumeWorkerDependencies, options: RunResumeWorkerOptions = {},
): Promise<{ claimed: number; completed: number }> {
  const clock = dependencies.clock ?? systemClock
  const owner = dependencies.owner ?? `resume-worker-${randomUUID()}`
  if (!owner.trim() || owner.length > 200) throw new Error('Invalid resume worker lease owner.')
  const maxItems = bounded(options.maxItems ?? 5, 1, 20)
  const budget = bounded(options.budgetMilliseconds ?? RUN_BUDGET_MILLISECONDS, 1, RUN_BUDGET_MILLISECONDS)
  const pendingLimit = bounded(options.pendingLimit ?? maxItems * 3, 1, 100)
  const deadline = clock.now().getTime() + budget
  if (options.signal?.aborted) return { claimed: 0, completed: 0 }
  const candidates = await dependencies.store.listPending(clock.now().toISOString(), pendingLimit)
  let claimed = 0
  let completed = 0
  for (const candidate of candidates.slice(0, pendingLimit)) {
    if (claimed >= maxItems || clock.now().getTime() >= deadline || options.signal?.aborted) break
    let owned: VersionedResumeEntity<RealResumeRecord> | undefined
    try { owned = await claim(dependencies, candidate, owner, clock) } catch { continue }
    if (!owned) continue
    claimed += 1
    if (await processClaimedResume(owned, dependencies, owner, deadline, options.signal)) completed += 1
  }
  return { claimed, completed }
}

export const resumeWorkerConstants = {
  leaseMilliseconds: LEASE_MILLISECONDS, heartbeatMilliseconds: HEARTBEAT_MILLISECONDS,
  runBudgetMilliseconds: RUN_BUDGET_MILLISECONDS, extractionVersion: EXTRACTION_VERSION,
}
