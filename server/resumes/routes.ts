import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express'
import { RESUME_IMPORT_LIMITS } from '../../src/domain/real-resumes'
import { UPLOAD_CONTENT_TYPES, uploadFormatFromContentType, uploadFormatFromFilename, type UploadFormat } from '../../src/domain/document-formats'
import { HttpError, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import type { WorkspaceRepository } from '../repository'
import { getPrincipal } from '../request-context'
import { RealResumeService, type ResumeImportRequest } from './service'
import type { RealResumesDeps } from './store'
import { isResumeUuid, isSafeResumeFilename, isValidResumeId } from './validation'

export type { RealResumesDeps } from './store'

interface RealResumesRouterDeps {
  repository: WorkspaceRepository
  resumes?: RealResumesDeps
  now?: () => Date
  wordDocumentImports?: boolean
}

function param(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string') throw notFound()
  return value
}

function resumeId(req: Request): string {
  const value = param(req, 'resumeId')
  if (!isValidResumeId(value)) throw notFound('The requested resume was not found.')
  return value
}

function uuidHeader(req: Request, name: string): string {
  const value = req.header(name)?.toLowerCase()
  if (!value || !isResumeUuid(value)) throw invalidRequest(`${name} must contain one UUID.`)
  return value
}

function importRequest(req: Request): ResumeImportRequest {
  const count = req.header('X-Import-Count')
  if (!count || !/^(?:[1-9]|10)$/.test(count)) {
    throw invalidRequest(`X-Import-Count must be a decimal integer between 1 and ${RESUME_IMPORT_LIMITS.maxBatchItems}, identical for every item in this batch.`)
  }
  return {
    idempotencyKey: uuidHeader(req, 'Idempotency-Key'), batchId: uuidHeader(req, 'X-Import-Batch'),
    inputCount: Number(count), createdBy: getPrincipal(req).principalKey,
  }
}

function filename(req: Request, format: UploadFormat = 'pdf'): string {
  const header = req.header('X-File-Name')
  if (!header || header.length > 255 * 12 || !/^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/.test(header)) {
    throw invalidRequest('X-File-Name must contain a percent-encoded safe document basename.')
  }
  let value: string
  try { value = decodeURIComponent(header) } catch { throw invalidRequest('X-File-Name must use valid percent encoding.') }
  if (!isSafeResumeFilename(value) || uploadFormatFromFilename(value) !== format) throw invalidRequest(`X-File-Name must be a safe ${format.toUpperCase()} basename.`)
  return value
}

function etag(req: Request): string {
  const value = req.header('If-Match')
  if (!value) throw preconditionRequired('An If-Match header containing the current resume ETag is required.')
  if (value.trim() !== value || value === '*' || value.startsWith('W/') || value.includes(',') || value.length > 1024) {
    throw invalidRequest('If-Match must contain one exact resume ETag.')
  }
  return value
}

function page(req: Request): { continuationToken?: string; limit: number } {
  const token = req.query.continuationToken
  if (token !== undefined && (typeof token !== 'string' || !token || token.length > 16 * 1024)) {
    throw invalidRequest('continuationToken must be a single valid continuation token.')
  }
  const limit = req.query.limit
  if (limit !== undefined && (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) {
    throw invalidRequest('limit must be an integer between 1 and 100.')
  }
  return { continuationToken: token as string | undefined, limit: limit === undefined ? 50 : Number(limit) }
}

function emptyBody(value: unknown): void {
  if (value === undefined || (Buffer.isBuffer(value) && value.length === 0)) return
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value) &&
    Object.keys(value).length === 0) return
  throw invalidRequest('Resume actions require an empty body; source content and processing fields cannot be submitted.')
}

function attachmentHeader(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export function createRealResumesRouter(deps: RealResumesRouterDeps): Router {
  const router = express.Router()
  const base = '/workspaces/:workspaceId/resumes'
  const service = deps.resumes ? new RealResumeService(deps.resumes, deps.now) : undefined
  const requireService = () => {
    if (!service) throw unavailable('Real resume imports are not enabled for this deployment.')
    return service
  }
  const authorize: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store')
    try {
      await deps.repository.authorizeWorkspace(getPrincipal(req), param(req, 'workspaceId'), req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write')
      requireService()
      next()
    } catch (error) { next(error) }
  }
  // The application mounts this router after its authentication and same-origin CSRF middleware.
  // Workspace authorization and header checks also precede the raw PDF/body parsers below.
  router.use(base, authorize)

  router.get(base, async (req, res) => {
    const options = page(req)
    res.json(await requireService().list(param(req, 'workspaceId'), options.continuationToken, options.limit))
  })
  router.get(`${base}/:resumeId`, async (req, res) => {
    const detail = await requireService().detail(param(req, 'workspaceId'), resumeId(req))
    res.setHeader('ETag', detail.etag)
    res.json(detail)
  })
  router.get(`${base}/:resumeId/original`, async (req, res) => {
    const original = await requireService().original(param(req, 'workspaceId'), resumeId(req))
    res.setHeader('Content-Type', original.contentType)
    res.setHeader('Content-Disposition', attachmentHeader(original.filename))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'")
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.send(Buffer.from(original.bytes))
  })
  router.post([`${base}/pdf`, `${base}/file`],
    (req: Request, _res: Response, next: NextFunction) => {
      try {
        importRequest(req)
        const format = uploadFormatFromContentType(req.header('Content-Type') ?? '')
        if (!format || (req.path.endsWith('/pdf') && format !== 'pdf')) throw invalidRequest('Content-Type must match a supported PDF, DOCX, or DOC file.')
        if (format !== 'pdf' && !deps.wordDocumentImports) throw unavailable('Word document imports are not enabled for this deployment.')
        filename(req, format)
        if (req.header('Content-Encoding') && req.header('Content-Encoding')?.toLowerCase() !== 'identity') {
          throw invalidRequest('Compressed uploads are not supported. Upload the original document bytes.')
        }
        next()
      } catch (error) { next(error) }
    },
    express.raw({ type: Object.values(UPLOAD_CONTENT_TYPES), limit: RESUME_IMPORT_LIMITS.maxFileBytes, inflate: false }),
    async (req: Request, res: Response) => {
      const format = uploadFormatFromContentType(req.header('Content-Type') ?? '')
      if (!format || !Buffer.isBuffer(req.body)) throw invalidRequest('The request must contain raw document bytes.')
      const result = await requireService().importFile(param(req, 'workspaceId'), importRequest(req), filename(req, format), req.body, UPLOAD_CONTENT_TYPES[format])
      res.setHeader('ETag', result.resume.etag)
      res.status(result.created ? 202 : 200).json({ resume: result.resume })
    },
    (error: unknown, _req: Request, _res: Response, next: NextFunction) => {
      if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
        next(new HttpError(413, 'invalid_request', 'Resume files may not exceed 10 MiB.'))
      } else next(error)
    },
  )
  router.post(`${base}/url`,
    (req, _res, next) => {
      try {
        importRequest(req)
        if (!req.is('application/json')) throw invalidRequest('Content-Type must be application/json.')
        next()
      } catch (error) { next(error) }
    },
    express.json({ limit: '32kb', inflate: false }),
    async (req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'url')) {
        throw invalidRequest('A URL import body must contain only a url field.')
      }
      const result = await requireService().importUrl(param(req, 'workspaceId'), importRequest(req), req.body.url)
      res.setHeader('ETag', result.resume.etag)
      res.status(result.created ? 202 : 200).json({ resume: result.resume })
    },
  )
  for (const action of ['retry', 'cancel'] as const) {
    router.post(`${base}/:resumeId/${action}`,
      (req, _res, next) => {
        try { resumeId(req); etag(req); next() } catch (error) { next(error) }
      },
      express.raw({ type: () => true, limit: '1kb', inflate: false }),
      async (req, res) => {
        emptyBody(req.body)
        const value = await requireService()[action](param(req, 'workspaceId'), resumeId(req), etag(req))
        res.setHeader('ETag', value.etag)
        res.json({ resume: value })
      },
    )
  }
  return router
}
