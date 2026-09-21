import { createHash } from 'node:crypto'
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express'
import ipaddr from 'ipaddr.js'
import { PDFDocument } from 'pdf-lib'
import type { RealJobDetail, RealJobRecord, RealJobSummary, VersionedRealJob } from '../../src/domain/real-jobs'
import { JOB_IMPORT_LIMITS } from '../../src/domain/real-jobs'
import { isOriginalContentType, isSafeUploadedFilename } from '../../src/domain/source-files'
import type { Job, Rubric, SourceDocument } from '../../src/domain/types'
import { originalExtension, UPLOAD_CONTENT_TYPES, uploadFormatFromContentType, type UploadFormat } from '../../src/domain/document-formats'
import { validateWordUpload } from '../documents/upload'
import type { AuthenticatedPrincipal } from '../auth'
import { decodeMarkdown, MarkdownInputError } from '../documents/markdown'
import { conflict, HttpError, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { getPrincipal, getRequestSettings } from '../request-context'
import type { WorkspaceRepository } from '../repository'
import type { LifecycleDependencies } from '../lifecycle/contracts'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { StoreConflictError } from '../store'
import type { JobBlobStore, JobLifecycleScope, RealJobStore } from './store'
import { assertJobWritable, putJobBlob } from './guards'
import {
  assertImportPolicy, assertOriginalDownload, newProcessingSettings, newWorkProcessingSettings,
  requestProcessingSettings, resolveAcceptedProcessingSettings,
} from './policy'
import { JobCleanupPendingError, jobLifecycleImpact, purgeJob, purgeJobRubric, requireJobLifecycle } from './lifecycle'
import {
  isValidJobId,
  isUuid,
  originalBlobName,
  parseDisplayNameMetadata,
  validateRealJobRecord,
  validateRealRubric,
  validateRealSourceDocument,
} from './validation'

export interface RealJobsDeps {
  readonly store: RealJobStore
  readonly blobs: JobBlobStore
}

export interface RealJobsRouterDeps {
  readonly repository: WorkspaceRepository
  readonly jobs?: RealJobsDeps
  readonly now?: () => Date
  readonly lifecycle?: LifecycleDependencies
  readonly wordDocumentImports?: boolean
}

interface AuthorizedRequest extends Request {
  authorizedPrincipal: AuthenticatedPrincipal
}

const ACTIVE_STATUSES = new Set(['queued', 'parsing', 'generating'])
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii')
const MAX_FILENAME_LENGTH = 255

function bodyRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidRequest('Request body must be a JSON object.')
  const body = value as Record<string, unknown>
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unexpected.length) throw invalidRequest(`Request body has unexpected field(s): ${unexpected.join(', ')}.`)
  return body
}

function requireUuidHeader(req: Request, name: string): string {
  const value = req.header(name)
  if (!value || !isUuid(value)) throw invalidRequest(`${name} must be a UUID.`)
  return value.toLowerCase()
}

function pathParam(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string') throw notFound()
  return value
}

function jobParam(req: Request): string {
  const value = pathParam(req, 'jobId')
  if (!isValidJobId(value)) throw notFound('The requested job was not found.')
  return value
}

function continuationToken(req: Request): string | undefined {
  const value = req.query.continuationToken
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) {
    throw invalidRequest('continuationToken must be a single valid continuation token.')
  }
  return value
}

function optionalUuid(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !isUuid(value)) throw invalidRequest(`${name} must be a UUID.`)
  return value.toLowerCase()
}

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function inputFingerprint(kind: UploadFormat | 'url', values: readonly string[]): string {
  return hash([kind, ...values].join('\0'))
}

function decodeFilename(value: string | undefined, kind: UploadFormat): string {
  if (!value) throw invalidRequest('X-File-Name is required.')
  const label = kind === 'markdown' ? 'Markdown' : kind.toUpperCase()
  if (kind !== 'pdf' &&
    (value.length > MAX_FILENAME_LENGTH * 12 || !/^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/.test(value))) {
    throw invalidRequest(`X-File-Name must contain a percent-encoded safe ${label} basename.`)
  }
  let filename: string
  try {
    filename = decodeURIComponent(value)
  } catch {
    throw invalidRequest('X-File-Name is not valid percent-encoding.')
  }
  if (kind === 'pdf') {
    // Existing PDF keys bind these legacy basenames; Markdown uses the stricter upload policy.
    const unsafeCharacter = [...filename].some(character => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 || character === '/' || character === '\\'
    })
    if (!filename || filename.length > MAX_FILENAME_LENGTH || filename === '.' || filename === '..' ||
      unsafeCharacter || !/\.pdf$/i.test(filename)) {
      throw invalidRequest('X-File-Name must be a safe PDF basename.')
    }
  } else if (!isSafeUploadedFilename(filename, kind)) throw invalidRequest(`X-File-Name must be a safe ${label} basename.`)
  return filename
}

function isPublicLiteral(host: string): boolean {
  let address: ipaddr.IPv4 | ipaddr.IPv6
  try {
    address = ipaddr.parse(host.replace(/^\[|\]$/g, ''))
  } catch {
    return true
  }
  if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
    address = (address as ipaddr.IPv6).toIPv4Address()
  }
  if (address.kind() === 'ipv4') {
    const bytes = address.toByteArray()
    if (bytes[0] === 168 && bytes[1] === 63 && bytes[2] === 129 && bytes[3] === 16) return false
    if (bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127) return false
    if (bytes[0] === 169 && bytes[1] === 254) return false
  }
  return address.range() === 'unicast'
}

function validatePublicUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > JOB_IMPORT_LIMITS.maxUrlLength) {
    throw invalidRequest(`URL must be between 1 and ${JOB_IMPORT_LIMITS.maxUrlLength} characters.`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidRequest('URL must be a valid absolute HTTP(S) URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw invalidRequest('URL must be a public HTTP(S) URL without credentials.')
  }
  if ((url.protocol === 'http:' && url.port && url.port !== '80') ||
    (url.protocol === 'https:' && url.port && url.port !== '443')) {
    throw invalidRequest('URL must use the standard HTTP or HTTPS port.')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw invalidRequest('URL host must be public.')
  }
  if (!isPublicLiteral(host)) throw invalidRequest('URL host must be public.')
  return url.toString()
}

function emptyJob(
  jobId: string,
  documentId: string,
  title: string,
  source: UploadFormat | 'url',
  sourceLabel: string,
  batchId: string | undefined,
  createdAt: string,
): Job & { dataKind: 'real' } {
  return {
    id: jobId,
    title,
    organization: '',
    location: '',
    arrangement: '',
    employmentType: '',
    grade: '',
    series: '',
    source,
    sourceLabel,
    ...(batchId ? { batchId } : {}),
    documentId,
    rubricId: null,
    status: 'queued',
    createdAt,
    dataKind: 'real',
  }
}

function requireJobs(jobs: RealJobsDeps | undefined): RealJobsDeps {
  if (!jobs) throw unavailable('Real job imports are not enabled for this deployment.')
  return jobs
}

function requireEtag(req: Request): string {
  const etag = req.header('if-match')
  if (!etag) throw preconditionRequired()
  if (etag.trim() !== etag || etag === '*' || etag.startsWith('W/') || /[,\r\n]/.test(etag) || etag.length > 1024) {
    throw invalidRequest('If-Match must be exactly the current job etag.')
  }
  return etag
}

function lifecycleScope(value: unknown): JobLifecycleScope {
  if (value !== 'job' && value !== 'rubric') throw invalidRequest('scope must be job or rubric.')
  return value
}

async function requireMutableWorkspace(store: RealJobStore, workspaceId: string): Promise<void> {
  if (!store.getWorkspaceLifecycle) throw unavailable('Job workspace lifecycle fencing is unavailable.')
  if ((await store.getWorkspaceLifecycle(workspaceId)).state !== 'active') {
    throw conflict('This workspace is archived or removed.')
  }
}

function summaryMetadata(value: VersionedRealJob, rubric: Rubric | null = null): RealJobSummary {
  return {
    ...(value.record.displayName !== undefined ? { displayName: value.record.displayName } : {}),
    job: value.record.job,
    source: value.record.source,
    rubric,
    etag: value.etag,
    updatedAt: value.record.updatedAt,
    attempts: value.record.attempts,
    ...(value.record.error ? { error: value.record.error } : {}),
    warnings: value.record.warnings,
    ...(value.record.lifecycle ? { lifecycle: value.record.lifecycle } : {}),
    ...(value.record.rubricLifecycle ? { rubricLifecycle: value.record.rubricLifecycle } : {}),
  }
}

async function summary(store: RealJobStore, value: Awaited<ReturnType<RealJobStore['get']>>): Promise<RealJobSummary> {
  if (!value) throw notFound('The requested job was not found.')
  const rubric = value.record.job.rubricId && !value.record.lifecycle?.deletingAt && !value.record.lifecycle?.deletedAt &&
    !value.record.rubricLifecycle?.deletingAt && !value.record.rubricLifecycle?.deletedAt
    ? await store.getRubric(value.record.workspaceId, value.record.job.rubricId)
    : undefined
  return summaryMetadata(value, rubric ?? null)
}

async function readDocument(blobs: JobBlobStore, record: RealJobRecord): Promise<SourceDocument | null> {
  if (!record.extractedBlobName || record.lifecycle?.deletingAt || record.lifecycle?.deletedAt) return null
  const blob = await blobs.read(record.extractedBlobName)
  if (!blob) throw unavailable('The extracted job document is temporarily unavailable.')
  if (blob.contentType !== 'application/json') throw unavailable('The extracted job document has invalid metadata.')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(blob.bytes).toString('utf8'))
  } catch {
    throw unavailable('The extracted job document could not be read.')
  }
  const errors = validateRealSourceDocument(parsed, record.source.originalContentType)
  if (errors.length || (parsed as SourceDocument).id !== record.job.documentId) {
    throw unavailable('The extracted job document has an invalid stored shape.')
  }
  return parsed as SourceDocument
}

async function detail(jobs: RealJobsDeps, value: Awaited<ReturnType<RealJobStore['get']>>): Promise<RealJobDetail> {
  if (!value) throw notFound('The requested job was not found.')
  const [base, document, rubricVersions] = await Promise.all([
    summary(jobs.store, value),
    readDocument(jobs.blobs, value.record),
    value.record.lifecycle?.deletingAt || value.record.rubricLifecycle?.deletingAt || value.record.rubricLifecycle?.deletedAt
      ? Promise.resolve([]) : jobs.store.listRubrics(value.record.workspaceId, value.record.id),
  ])
  return { ...base, document, rubricVersions }
}

function authorize(repository: WorkspaceRepository, access: 'read' | 'write' | 'manage'): RequestHandler {
  return async (req, _res, next) => {
    try {
      await repository.authorizeWorkspace(getPrincipal(req), pathParam(req, 'workspaceId'), access)
      ;(req as AuthorizedRequest).authorizedPrincipal = getPrincipal(req)
      next()
    } catch (error) {
      next(error)
    }
  }
}

function available(jobs: RealJobsDeps | undefined): RequestHandler {
  return (_req, _res, next) => {
    try {
      requireJobs(jobs)
      next()
    } catch (error) {
      next(error)
    }
  }
}

async function replaceOrConflict(store: RealJobStore, record: RealJobRecord, etag: string) {
  try {
    assertWorkspaceMutationLease(record.workspaceId)
    return await store.replace(record, etag)
  } catch (error) {
    if (error instanceof StoreConflictError) throw conflict('This job changed since you last loaded it.')
    throw error
  }
}

function withoutJobError(job: Job & { dataKind: 'real' }): Job & { dataKind: 'real' } {
  const result = { ...job }
  delete result.error
  delete result.errorStage
  return result
}

function attachmentHeader(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'source'
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

type AsyncJobHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>

function asyncHandler(handler: AsyncJobHandler): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(error => {
      next(error instanceof StoreConflictError ? conflict(error.message) : error)
    })
  }
}

export function createRealJobsRouter(deps: RealJobsRouterDeps): Router {
  const router = express.Router()
  const clock = deps.now ?? (() => new Date())
  const mutation = (access: 'write' | 'manage', handler: AsyncJobHandler): RequestHandler => asyncHandler(
    (req, res, next) => deps.repository.withWorkspaceMutation(
      getPrincipal(req), pathParam(req, 'workspaceId'), access, () => handler(req, res, next),
    ),
  )

  const base = '/workspaces/:workspaceId/jobs'

  router.get(base, authorize(deps.repository, 'read'), asyncHandler(async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const page = await jobs.store.list(pathParam(req, 'workspaceId'), continuationToken(req))
    const summaries = await Promise.all(page.jobs.map((value) => summary(jobs.store, value)))
    res.json({ jobs: summaries, ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}) })
  }))

  router.get(`${base}/:jobId`, authorize(deps.repository, 'read'), asyncHandler(async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    res.json(await detail(jobs, await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))))
  }))

  router.patch(`${base}/:jobId/metadata`, authorize(deps.repository, 'write'), available(deps.jobs),
    (req, _res, next) => {
      try {
        jobParam(req); requireEtag(req)
        if (Object.keys(req.query).length) throw invalidRequest('Metadata requests do not accept query parameters.')
        if (!req.is('application/json')) throw invalidRequest('Content-Type must be application/json.')
        next()
      } catch (error) { next(error) }
    },
    express.json({ limit: '4kb', inflate: false }),
    mutation('write', async (req, res) => {
      const { displayName } = parseDisplayNameMetadata(req.body)
      const jobs = requireJobs(deps.jobs)
      const workspaceId = pathParam(req, 'workspaceId')
      const current = await jobs.store.get(workspaceId, jobParam(req))
      if (!current) throw notFound('The requested job was not found.')
      await requireMutableWorkspace(jobs.store, workspaceId)
      assertJobWritable(current.record)
      const expected = requireEtag(req)
      if (current.etag !== expected) throw conflict('This job changed since you last loaded it.')
      const record: RealJobRecord = {
        ...current.record, displayName, updatedAt: [clock().toISOString(), current.record.updatedAt].sort().at(-1)!,
      }
      const job = await summary(jobs.store, await replaceOrConflict(jobs.store, record, expected))
      res.setHeader('ETag', job.etag)
      res.json({ job })
    }),
  )

  router.get(`${base}/:jobId/lifecycle`, authorize(deps.repository, 'manage'), asyncHandler(async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const scope = lifecycleScope(req.query.scope ?? 'job')
    const current = await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))
    if (!current) throw notFound('The requested job was not found.')
    res.json({ impact: await jobLifecycleImpact(jobs, current, scope, deps.lifecycle) })
  }))

  router.post(`${base}/:jobId/lifecycle`, authorize(deps.repository, 'manage'), mutation('manage', async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    requireJobLifecycle(jobs)
    const expectedEtag = requireEtag(req)
    const body = bodyRecord(req.body, ['action', 'scope'])
    const scope = lifecycleScope(body.scope)
    const action = body.action
    if (action !== 'archive' && action !== 'unarchive' && action !== 'delete') {
      throw invalidRequest('action must be archive, unarchive, or delete.')
    }
    const workspaceId = pathParam(req, 'workspaceId')
    const jobId = jobParam(req)
    const current = await jobs.store.get(workspaceId, jobId)
    if (!current) throw notFound('The requested job was not found.')
    if (current.etag !== expectedEtag) throw conflict('This job changed since you last loaded it.')
    if (action === 'delete') {
      const impact = await jobLifecycleImpact(jobs, current, scope, deps.lifecycle)
      if (impact.blockers.length) {
        res.status(409).json({
          error: { code: 'conflict', message: 'Delete the linked analyses or seed ladders before deleting this item.' },
          impact,
        })
        return
      }
      if (scope === 'rubric' && current.record.rubricLifecycle?.deletedAt) {
        res.json({ job: await detail(jobs, current) })
        return
      }
    }
    const timestamp = clock().toISOString()
    assertWorkspaceMutationLease(workspaceId)
    const updated = await jobs.store.transitionLifecycle(workspaceId, jobId, expectedEtag, scope, action, timestamp)
    if (action !== 'delete') {
      res.json({ job: await detail(jobs, updated) })
      return
    }
    try {
      if (scope === 'job') {
        await purgeJob(jobs, updated, timestamp)
        res.json({ deleted: true })
      } else {
        res.json({ job: await detail(jobs, await purgeJobRubric(jobs, updated, timestamp)) })
      }
    } catch (error) {
      const pending = error instanceof JobCleanupPendingError
      if (!pending) console.error('Job lifecycle cleanup incomplete:', {
        workspaceId, jobId, scope, name: error instanceof Error ? error.name : 'UnknownError',
      })
      const latest = await jobs.store.get(workspaceId, jobId).catch(() => updated) ?? updated
      const responseJob = await detail(jobs, latest).catch(() => ({
        ...summaryMetadata(latest), document: null, rubricVersions: [],
      }))
      const operation = {
        id: `${scope}-delete:${jobId}`,
        action: 'delete',
        status: pending ? 'pending' : 'failed',
        updatedAt: timestamp,
        error: pending ? error.message : 'Cleanup did not complete. This item remains locked; retry deletion to finish it.',
        ...(pending ? { retryAt: error.retryAt } : {}),
      }
      if (pending) res.setHeader('Retry-After', Math.max(1, Math.ceil((Date.parse(error.retryAt) - Date.now()) / 1000)))
      res.status(202).json({
        job: responseJob,
        operation,
        ...(!pending ? { error: { code: 'unavailable', message: operation.error } } : {}),
      })
    }
  }))

  for (const route of ['pdf', 'markdown', 'file'] as const) {
    const fileKind = (req: Request): UploadFormat => {
      const kind = route === 'file' ? uploadFormatFromContentType(req.header('Content-Type') ?? '') : route
      if (!kind) throw invalidRequest('Content-Type must match a supported PDF, Markdown, DOCX, or DOC file.')
      return kind
    }
    router.post(
      `${base}/${route}`,
      authorize(deps.repository, 'write'),
      available(deps.jobs),
      (req: Request, _res: Response, next: NextFunction) => {
        try {
          for (const name of ['content-type', 'content-encoding', 'x-file-name', 'idempotency-key', 'x-import-batch']) {
            if (req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === name).length > 1) {
              throw invalidRequest(`${name} must be supplied only once.`)
            }
          }
          const kind = fileKind(req)
          const contentType = UPLOAD_CONTENT_TYPES[kind]
          if ((kind === 'docx' || kind === 'doc') && !deps.wordDocumentImports) {
            throw unavailable('Word document imports are not enabled for this deployment.')
          }
          decodeFilename(req.header('X-File-Name'), kind)
          requireUuidHeader(req, 'Idempotency-Key')
          optionalUuid(req.header('X-Import-Batch'), 'X-Import-Batch')
          if (!req.is(contentType)) throw invalidRequest(`Content-Type must be ${contentType}.`)
          if (kind === 'markdown' && !/^text\/markdown(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(req.header('Content-Type') ?? '')) {
            throw invalidRequest('Content-Type must be text/markdown with no charset or charset=utf-8.')
          }
          if (kind !== 'pdf' && req.header('Content-Encoding') && req.header('Content-Encoding')?.toLowerCase() !== 'identity') {
            const label = kind === 'markdown' ? 'Markdown' : kind.toUpperCase()
            throw invalidRequest(`Compressed ${label} uploads are not supported. Upload the original ${label} bytes.`)
          }
          next()
        } catch (error) { next(error) }
      },
      express.raw({
        type: route === 'file' ? Object.values(UPLOAD_CONTENT_TYPES) : UPLOAD_CONTENT_TYPES[route],
        limit: route === 'markdown' ? JOB_IMPORT_LIMITS.maxMarkdownBytes : JOB_IMPORT_LIMITS.maxFileBytes,
        inflate: route === 'pdf',
      }),
      mutation('write', async (req, res) => {
        const jobs = requireJobs(deps.jobs)
        const workspaceId = pathParam(req, 'workspaceId')
        await requireMutableWorkspace(jobs.store, workspaceId)
        const kind = fileKind(req)
        const contentType = UPLOAD_CONTENT_TYPES[kind]
        if (!Buffer.isBuffer(req.body)) throw invalidRequest('The request must contain raw document bytes.')
        const filename = decodeFilename(req.header('X-File-Name'), kind)
        const key = requireUuidHeader(req, 'Idempotency-Key')
        const batchId = optionalUuid(req.header('X-Import-Batch'), 'X-Import-Batch')
        const bytes = req.body as Buffer
        if (kind === 'pdf') {
          if (bytes.byteLength === 0) throw invalidRequest('PDF body must not be empty.')
          if (bytes.subarray(0, Math.min(bytes.byteLength, 1024)).indexOf(PDF_MAGIC) < 0) {
            throw invalidRequest('The uploaded file does not have a valid PDF header.')
          }
        } else if (kind === 'markdown') {
          try { decodeMarkdown(bytes, JOB_IMPORT_LIMITS.maxMarkdownBytes) } catch (error) {
            if (error instanceof MarkdownInputError) {
              throw new HttpError(error.code === 'markdown-too-large' ? 413 : 400, 'invalid_request', error.message)
            }
            throw error
          }
        } else await validateWordUpload(bytes, kind)

        const jobId = `job-${key}`
        const documentId = `document-${key}`
        const blobName = originalBlobName(workspaceId, jobId, kind)
        const digest = hash(bytes)
        const fingerprint = inputFingerprint(kind, [filename, batchId ?? '', digest])
        const existing = await jobs.store.get(workspaceId, jobId)
        if (existing) {
          assertJobWritable(existing.record)
          if (existing.record.inputFingerprint !== fingerprint) throw conflict('This idempotency key was already used for different input.')
          res.status(200).json({ job: await summary(jobs.store, existing) })
          return
        }
        const settings = requestProcessingSettings(req)
        const processingSettings = await newWorkProcessingSettings(settings)
        assertImportPolicy(processingSettings, 'jobs', kind, { bytes: bytes.byteLength })
        if (kind === 'pdf' && processingSettings.settings.imports.jobs.maxPdfPages < JOB_IMPORT_LIMITS.maxPdfPages) {
          let pages: number
          try {
            const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true })
            if (pdf.isEncrypted) throw new Error('Encrypted PDF')
            pages = pdf.getPageCount()
          } catch { throw invalidRequest('The PDF cannot be read. Upload an unencrypted, structurally valid PDF.') }
          assertImportPolicy(processingSettings, 'jobs', kind, { pages })
        }
        const sourceBlob = await putJobBlob(jobs.store, jobs.blobs, workspaceId, jobId, blobName, bytes, contentType)
        if (sourceBlob.blob.sha256 !== digest || sourceBlob.blob.contentType !== contentType ||
          sourceBlob.blob.bytes.byteLength !== bytes.byteLength) {
          throw conflict('This idempotency key was already used for different input.')
        }

        const timestamp = clock().toISOString()
        const principal = (req as AuthorizedRequest).authorizedPrincipal
        const record: RealJobRecord = {
          id: jobId,
          workspaceId,
          recordType: 'job',
          job: emptyJob(jobId, documentId, filename, kind, filename, batchId, timestamp),
          source: {
            kind,
            displayName: filename,
            originalBlobName: blobName,
            originalContentType: contentType,
            sha256: sourceBlob.blob.sha256,
            bytes: sourceBlob.blob.bytes.byteLength,
          },
          inputFingerprint: fingerprint,
          createdBy: principal.principalKey,
          updatedAt: timestamp,
          attempts: 0,
          nextAttemptAt: timestamp,
          warnings: [],
          processingSettings: newProcessingSettings(settings, processingSettings),
        }
        assertWorkspaceMutationLease(workspaceId)
        const created = await jobs.store.create(record)
        if (!created.created && created.value.record.inputFingerprint !== fingerprint) {
          throw conflict('This idempotency key was already used for different input.')
        }
        res.status(created.created ? 202 : 200).json({ job: await summary(jobs.store, created.value) })
      }),
      (error: unknown, _req: Request, _res: Response, next: NextFunction) => {
        if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
          next(new HttpError(413, 'invalid_request', 'Uploaded files may not exceed 10 MiB.'))
        } else next(error)
      },
    )
  }

  router.post(`${base}/url`, authorize(deps.repository, 'write'), mutation('write', async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const body = bodyRecord(req.body, ['url', 'batchId'])
    const url = validatePublicUrl(body.url)
    const key = requireUuidHeader(req, 'Idempotency-Key')
    const batchId = optionalUuid(body.batchId, 'batchId')
    const fingerprint = inputFingerprint('url', [url, batchId ?? ''])
    const workspaceId = pathParam(req, 'workspaceId')
    const jobId = `job-${key}`
    await requireMutableWorkspace(jobs.store, workspaceId)
    const existing = await jobs.store.get(workspaceId, jobId)
    if (existing) {
      assertJobWritable(existing.record)
      if (existing.record.inputFingerprint !== fingerprint) throw conflict('This idempotency key was already used for different input.')
      res.status(200).json({ job: await summary(jobs.store, existing) })
      return
    }
    const settings = requestProcessingSettings(req)
    const processingSettings = await newWorkProcessingSettings(settings)
    assertImportPolicy(processingSettings, 'jobs', 'url', { url })
    const timestamp = clock().toISOString()
    const principal = (req as AuthorizedRequest).authorizedPrincipal
    const record: RealJobRecord = {
      id: jobId,
      workspaceId,
      recordType: 'job',
      job: emptyJob(jobId, `document-${key}`, new URL(url).hostname, 'url', url, batchId, timestamp),
      source: { kind: 'url', displayName: url, url },
      inputFingerprint: fingerprint,
      createdBy: principal.principalKey,
      updatedAt: timestamp,
      attempts: 0,
      nextAttemptAt: timestamp,
      warnings: [],
      processingSettings: newProcessingSettings(settings, processingSettings),
    }
    assertWorkspaceMutationLease(workspaceId)
    const created = await jobs.store.create(record)
    if (!created.created && created.value.record.inputFingerprint !== fingerprint) {
      throw conflict('This idempotency key was already used for different input.')
    }
    res.status(created.created ? 202 : 200).json({ job: await summary(jobs.store, created.value) })
  }))

  router.post(`${base}/:jobId/retry`, authorize(deps.repository, 'write'), mutation('write', async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const current = await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))
    if (!current) throw notFound('The requested job was not found.')
    await requireMutableWorkspace(jobs.store, current.record.workspaceId)
    assertJobWritable(current.record)
    if (current.record.job.status !== 'error' && current.record.job.status !== 'cancelled') {
      throw conflict('Only failed or cancelled jobs can be retried.')
    }
    const timestamp = clock().toISOString()
    const replacement: RealJobRecord = {
      ...current.record,
      processingSettings: await resolveAcceptedProcessingSettings(requestProcessingSettings(req), current.record.processingSettings),
      job: { ...withoutJobError(current.record.job), status: 'queued' },
      updatedAt: timestamp,
      attempts: 0,
      nextAttemptAt: timestamp,
      error: undefined,
      lease: undefined,
    }
    const updated = await replaceOrConflict(jobs.store, replacement, current.etag)
    res.json({ job: await summary(jobs.store, updated) })
  }))

  router.post(`${base}/:jobId/cancel`, authorize(deps.repository, 'write'), mutation('write', async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const current = await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))
    if (!current) throw notFound('The requested job was not found.')
    await requireMutableWorkspace(jobs.store, current.record.workspaceId)
    assertJobWritable(current.record)
    if (current.record.job.status === 'cancelled') {
      res.json({ job: await summary(jobs.store, current) })
      return
    }
    if (!ACTIVE_STATUSES.has(current.record.job.status)) throw conflict('This job is not currently cancellable.')
    const timestamp = clock().toISOString()
    const replacement: RealJobRecord = {
      ...current.record,
      job: { ...withoutJobError(current.record.job), status: 'cancelled', error: 'Cancelled by user.' },
      updatedAt: timestamp,
      nextAttemptAt: undefined,
      lease: undefined,
      error: { code: 'cancelled', message: 'Cancelled by user.', retryable: false },
    }
    const updated = await replaceOrConflict(jobs.store, replacement, current.etag)
    res.json({ job: await summary(jobs.store, updated) })
  }))

  router.put(`${base}/:jobId/rubric`, authorize(deps.repository, 'write'), mutation('write', async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const expectedEtag = requireEtag(req)
    const body = bodyRecord(req.body, ['rubric'])
    if (typeof body.rubric !== 'object' || body.rubric === null || Array.isArray(body.rubric)) {
      throw invalidRequest('rubric must be an object.')
    }
    const current = await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))
    if (!current) throw notFound('The requested job was not found.')
    await requireMutableWorkspace(jobs.store, current.record.workspaceId)
    assertJobWritable(current.record)
    if (current.etag !== expectedEtag) throw conflict('This job changed since you last loaded it.')
    if (current.record.job.status !== 'ready' || !current.record.job.rubricId) {
      throw conflict('Only ready jobs have an editable rubric.')
    }
    const submitted = body.rubric as Rubric
    if (submitted.id !== current.record.job.rubricId) throw conflict('The submitted rubric is not the current job rubric.')
    const document = await readDocument(jobs.blobs, current.record)
    if (!document) throw conflict('The job has no extracted source document.')
    const versions = await jobs.store.listRubrics(pathParam(req, 'workspaceId'), jobParam(req))
    const latest = versions.at(-1)
    if (!latest || latest.id !== current.record.job.rubricId) throw conflict('The current rubric version could not be loaded.')
    if (Array.isArray(submitted.criteria) && submitted.criteria.some(criterion =>
      !latest.criteria.some(previous => previous.id === criterion.id))) {
      const policy = (await getRequestSettings(req)).settings.rubrics.jobs
      if (submitted.criteria.length > policy.maxCriteria) {
        throw invalidRequest(`New rubric criteria may not exceed the current ${policy.maxCriteria}-criterion limit.`)
      }
    }

    const timestamp = clock().toISOString()
    const rubric: Rubric = {
      id: latest.id,
      groupId: latest.groupId,
      kind: 'job',
      jobId: current.record.id,
      name: submitted.name,
      description: submitted.description,
      version: latest.version + 1,
      criteria: submitted.criteria,
      createdAt: timestamp,
      dataKind: 'real',
      provenance: {
        kind: 'edited',
        model: latest.provenance?.model ?? '',
        promptVersion: latest.provenance?.promptVersion ?? '',
      },
    }
    const errors = validateRealRubric(rubric, document, current.record.source.originalContentType)
    if (errors.length) throw invalidRequest(errors.join(' '))
    const replacement: RealJobRecord = { ...current.record, updatedAt: timestamp }
    let updated
    try {
      assertWorkspaceMutationLease(current.record.workspaceId)
      updated = await jobs.store.publish(replacement, expectedEtag, rubric)
    } catch (error) {
      if (error instanceof StoreConflictError) throw conflict('This job or rubric changed since you last loaded it.')
      throw error
    }
    res.json({ job: await detail(jobs, updated) })
  }))

  router.get(`${base}/:jobId/original`, authorize(deps.repository, 'read'), asyncHandler(async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const role = await deps.repository.authorizeWorkspace(getPrincipal(req), pathParam(req, 'workspaceId'), 'read')
    assertOriginalDownload(await getRequestSettings(req), role, req.query.preview === 'formatted')
    const current = await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))
    if (!current) throw notFound('The requested job was not found.')
    if (current.record.lifecycle?.deletingAt || current.record.lifecycle?.deletedAt) throw notFound('This job source has been removed.')
    if (!validateRealJobRecord(current.record)) throw unavailable('The original source has invalid stored metadata.')
    const blobName = current.record.source.originalBlobName
    if (!blobName) throw notFound('The original source is not available yet.')
    const blob = await jobs.blobs.read(blobName)
    if (!blob) throw notFound('The original source is not available.')
    const expectedContentType = current.record.source.originalContentType
    if (!expectedContentType || !isOriginalContentType(expectedContentType) || blob.contentType !== expectedContentType ||
      (current.record.source.sha256 !== undefined && (blob.sha256 !== current.record.source.sha256 || hash(blob.bytes) !== current.record.source.sha256)) ||
      (current.record.source.bytes !== undefined && blob.bytes.byteLength !== current.record.source.bytes)) {
      throw unavailable('The original source has invalid stored metadata.')
    }
    const sourceHost = new URL(
      current.record.source.finalUrl ?? current.record.source.url ?? 'https://source.invalid',
    ).hostname
    const filename = current.record.source.kind !== 'url'
      ? current.record.source.displayName : `${sourceHost}.${originalExtension(expectedContentType)}`
    res.setHeader('Content-Type', expectedContentType)
    res.setHeader('Content-Disposition', attachmentHeader(filename))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'")
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (expectedContentType === 'text/markdown') res.setHeader('Cache-Control', 'private, no-store')
    res.send(Buffer.from(blob.bytes))
  }))

  return router
}
