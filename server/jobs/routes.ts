import { createHash } from 'node:crypto'
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express'
import ipaddr from 'ipaddr.js'
import type { RealJobDetail, RealJobRecord, RealJobSummary } from '../../src/domain/real-jobs'
import { JOB_IMPORT_LIMITS } from '../../src/domain/real-jobs'
import type { Job, Rubric, SourceDocument } from '../../src/domain/types'
import type { AuthenticatedPrincipal } from '../auth'
import { conflict, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { getPrincipal } from '../request-context'
import type { WorkspaceRepository } from '../repository'
import { StoreConflictError } from '../store'
import type { JobBlobStore, RealJobStore } from './store'
import {
  isValidJobId,
  isUuid,
  originalBlobName,
  validateRealRubric,
  validateRealSourceDocument,
} from './validation'

export interface RealJobsDeps {
  readonly store: RealJobStore
  readonly blobs: JobBlobStore
}

interface RealJobsRouterDeps {
  readonly repository: WorkspaceRepository
  readonly jobs?: RealJobsDeps
  readonly now?: () => Date
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

function inputFingerprint(kind: 'pdf' | 'url', values: readonly string[]): string {
  return hash([kind, ...values].join('\0'))
}

function decodeFilename(value: string | undefined): string {
  if (!value) throw invalidRequest('X-File-Name is required.')
  let filename: string
  try {
    filename = decodeURIComponent(value)
  } catch {
    throw invalidRequest('X-File-Name is not valid percent-encoding.')
  }
  const unsafeCharacter = [...filename].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 || character === '/' || character === '\\'
  })
  if (!filename || filename.length > MAX_FILENAME_LENGTH || filename === '.' || filename === '..' ||
    unsafeCharacter || !/\.pdf$/i.test(filename)) {
    throw invalidRequest('X-File-Name must be a safe PDF basename.')
  }
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
  source: 'pdf' | 'url',
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

async function summary(store: RealJobStore, value: Awaited<ReturnType<RealJobStore['get']>>): Promise<RealJobSummary> {
  if (!value) throw notFound('The requested job was not found.')
  const rubric = value.record.job.rubricId
    ? await store.getRubric(value.record.workspaceId, value.record.job.rubricId)
    : undefined
  return {
    job: value.record.job,
    source: value.record.source,
    rubric: rubric ?? null,
    etag: value.etag,
    updatedAt: value.record.updatedAt,
    attempts: value.record.attempts,
    ...(value.record.error ? { error: value.record.error } : {}),
    warnings: value.record.warnings,
  }
}

async function readDocument(blobs: JobBlobStore, record: RealJobRecord): Promise<SourceDocument | null> {
  if (!record.extractedBlobName) return null
  const blob = await blobs.read(record.extractedBlobName)
  if (!blob) throw unavailable('The extracted job document is temporarily unavailable.')
  if (blob.contentType !== 'application/json') throw unavailable('The extracted job document has invalid metadata.')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(blob.bytes).toString('utf8'))
  } catch {
    throw unavailable('The extracted job document could not be read.')
  }
  const errors = validateRealSourceDocument(parsed)
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
    jobs.store.listRubrics(value.record.workspaceId, value.record.id),
  ])
  return { ...base, document, rubricVersions }
}

function authorize(repository: WorkspaceRepository, access: 'read' | 'write'): RequestHandler {
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
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next)
  }
}

export function createRealJobsRouter(deps: RealJobsRouterDeps): Router {
  const router = express.Router()
  const clock = deps.now ?? (() => new Date())

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

  router.post(
    `${base}/pdf`,
    authorize(deps.repository, 'write'),
    available(deps.jobs),
    express.raw({ type: 'application/pdf', limit: JOB_IMPORT_LIMITS.maxPdfBytes }),
    asyncHandler(async (req, res) => {
      const jobs = requireJobs(deps.jobs)
      if (!req.is('application/pdf') || !Buffer.isBuffer(req.body)) throw invalidRequest('Content-Type must be application/pdf.')
      const filename = decodeFilename(req.header('x-file-name'))
      const key = requireUuidHeader(req, 'Idempotency-Key')
      const batchId = optionalUuid(req.header('x-import-batch'), 'X-Import-Batch')
      const bytes = req.body as Buffer
      if (bytes.byteLength === 0) throw invalidRequest('PDF body must not be empty.')
      if (bytes.subarray(0, Math.min(bytes.byteLength, 1024)).indexOf(PDF_MAGIC) < 0) {
        throw invalidRequest('The uploaded file does not have a valid PDF header.')
      }

      const workspaceId = pathParam(req, 'workspaceId')
      const jobId = `job-${key}`
      const documentId = `document-${key}`
      const blobName = originalBlobName(workspaceId, jobId, 'pdf')
      const batch = batchId ?? ''
      const fingerprint = inputFingerprint('pdf', [filename, batch, hash(bytes)])
      const sourceBlob = await jobs.blobs.putImmutable(blobName, bytes, 'application/pdf')
      if (sourceBlob.blob.sha256 !== hash(bytes) || sourceBlob.blob.contentType !== 'application/pdf') {
        throw conflict('This idempotency key was already used for different input.')
      }

      const timestamp = clock().toISOString()
      const principal = (req as AuthorizedRequest).authorizedPrincipal
      const record: RealJobRecord = {
        id: jobId,
        workspaceId,
        recordType: 'job',
        job: emptyJob(jobId, documentId, filename, 'pdf', filename, batchId, timestamp),
        source: {
          kind: 'pdf',
          displayName: filename,
          originalBlobName: blobName,
          originalContentType: 'application/pdf',
          sha256: sourceBlob.blob.sha256,
          bytes: sourceBlob.blob.bytes.byteLength,
        },
        inputFingerprint: fingerprint,
        createdBy: principal.principalKey,
        updatedAt: timestamp,
        attempts: 0,
        nextAttemptAt: timestamp,
        warnings: [],
      }
      const created = await jobs.store.create(record)
      if (!created.created && created.value.record.inputFingerprint !== fingerprint) {
        throw conflict('This idempotency key was already used for different input.')
      }
      res.status(created.created ? 202 : 200).json({ job: await summary(jobs.store, created.value) })
    }),
  )

  router.post(`${base}/url`, authorize(deps.repository, 'write'), asyncHandler(async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const body = bodyRecord(req.body, ['url', 'batchId'])
    const url = validatePublicUrl(body.url)
    const key = requireUuidHeader(req, 'Idempotency-Key')
    const batchId = optionalUuid(body.batchId, 'batchId')
    const fingerprint = inputFingerprint('url', [url, batchId ?? ''])
    const workspaceId = pathParam(req, 'workspaceId')
    const jobId = `job-${key}`
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
    }
    const created = await jobs.store.create(record)
    if (!created.created && created.value.record.inputFingerprint !== fingerprint) {
      throw conflict('This idempotency key was already used for different input.')
    }
    res.status(created.created ? 202 : 200).json({ job: await summary(jobs.store, created.value) })
  }))

  router.post(`${base}/:jobId/retry`, authorize(deps.repository, 'write'), asyncHandler(async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const current = await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))
    if (!current) throw notFound('The requested job was not found.')
    if (current.record.job.status !== 'error' && current.record.job.status !== 'cancelled') {
      throw conflict('Only failed or cancelled jobs can be retried.')
    }
    const timestamp = clock().toISOString()
    const replacement: RealJobRecord = {
      ...current.record,
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

  router.post(`${base}/:jobId/cancel`, authorize(deps.repository, 'write'), asyncHandler(async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const current = await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))
    if (!current) throw notFound('The requested job was not found.')
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

  router.put(`${base}/:jobId/rubric`, authorize(deps.repository, 'write'), asyncHandler(async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const expectedEtag = req.header('if-match')
    if (!expectedEtag) throw preconditionRequired()
    if (expectedEtag === '*') throw invalidRequest('Wildcard If-Match is not accepted; provide the current job etag.')
    const body = bodyRecord(req.body, ['rubric'])
    if (typeof body.rubric !== 'object' || body.rubric === null || Array.isArray(body.rubric)) {
      throw invalidRequest('rubric must be an object.')
    }
    const current = await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))
    if (!current) throw notFound('The requested job was not found.')
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
    const errors = validateRealRubric(rubric, document)
    if (errors.length) throw invalidRequest(errors.join(' '))
    const replacement: RealJobRecord = { ...current.record, updatedAt: timestamp }
    let updated
    try {
      updated = await jobs.store.publish(replacement, expectedEtag, rubric)
    } catch (error) {
      if (error instanceof StoreConflictError) throw conflict('This job or rubric changed since you last loaded it.')
      throw error
    }
    res.json({ job: await detail(jobs, updated) })
  }))

  router.get(`${base}/:jobId/original`, authorize(deps.repository, 'read'), asyncHandler(async (req, res) => {
    const jobs = requireJobs(deps.jobs)
    const current = await jobs.store.get(pathParam(req, 'workspaceId'), jobParam(req))
    if (!current) throw notFound('The requested job was not found.')
    const blobName = current.record.source.originalBlobName
    if (!blobName) throw notFound('The original source is not available yet.')
    const blob = await jobs.blobs.read(blobName)
    if (!blob) throw notFound('The original source is not available.')
    const expectedContentType = current.record.source.originalContentType
    if (!expectedContentType || blob.contentType !== expectedContentType) {
      throw unavailable('The original source has invalid stored metadata.')
    }
    const sourceHost = new URL(
      current.record.source.finalUrl ?? current.record.source.url ?? 'https://source.invalid',
    ).hostname
    const filename = expectedContentType === 'application/pdf'
      ? current.record.source.kind === 'pdf' ? current.record.source.displayName : `${sourceHost}.pdf`
      : `${sourceHost}.html`
    res.setHeader('Content-Type', expectedContentType)
    res.setHeader('Content-Disposition', attachmentHeader(filename))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(Buffer.from(blob.bytes))
  }))

  return router
}
