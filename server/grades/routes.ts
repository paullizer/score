import express, { type Request, type RequestHandler, type Router } from 'express'
import ipaddr from 'ipaddr.js'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { GRADE_LADDER_LIMITS } from '../../src/domain/real-grades'
import { isOriginalContentType, originalExtension } from '../../src/domain/document-formats'
import { HttpError, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import type { RealJobsDeps } from '../jobs/routes'
import { isUuid } from '../jobs/validation'
import type { WorkspaceRepository } from '../repository'
import { getPrincipal } from '../request-context'
import { GradeService, requireGradePathId, type RealGradesDeps } from './service'
import type { LifecycleDependencies } from '../lifecycle/contracts'
import { GradeLifecycleService } from './lifecycle'
import {
  addGradeUrlInputSchema, approveGradeInputSchema, confirmGradeInputSchema, createGradeInputSchema,
  editGradeInputSchema, emptyGradeInputSchema, gradeActionInputSchema, gradeLifecycleInputSchema, updateGradeInputSchema, updateGradeSourceInputSchema,
} from './validation'

export type { RealGradesDeps } from './service'

interface GradeRouterDeps {
  repository: WorkspaceRepository
  grades?: RealGradesDeps
  jobs?: RealJobsDeps
  lifecycle?: LifecycleDependencies
  now?: () => Date
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw invalidRequest(result.error.issues.slice(0, 12).map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '))
  return result.data
}

function param(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string') throw notFound()
  return value
}
const ladderId = (req: Request) => requireGradePathId(param(req, 'ladderId'), 'ladder')
const sourceId = (req: Request) => requireGradePathId(param(req, 'sourceId'), 'source')
const workspaceId = (req: Request) => param(req, 'workspaceId')
const actor = (req: Request) => getPrincipal(req).principalKey

function grade(req: Request): number {
  const value = param(req, 'grade')
  if (!/^(?:[1-9]|1[0-5])$/.test(value)) throw notFound('The requested GS grade was not found.')
  return Number(value)
}

function key(req: Request): string {
  const value = req.header('Idempotency-Key')
  if (!value || !isUuid(value)) throw invalidRequest('Idempotency-Key must be a UUID.')
  return value.toLowerCase()
}

function etag(req: Request): string {
  const value = req.header('If-Match')
  if (!value) throw preconditionRequired('An If-Match header containing the current ladder or grade-head ETag is required.')
  if (value === '*' || value.length > 1024 || value.includes(',')) throw invalidRequest('If-Match must contain one exact ETag.')
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

function historicalSourceSet(req: Request): string | undefined {
  return req.query.sourceSetId === undefined ? undefined : requireGradePathId(req.query.sourceSetId, 'source-set')
}

function filename(header: string | undefined): string {
  if (!header) throw invalidRequest('X-File-Name is required.')
  let value: string
  try { value = decodeURIComponent(header) } catch { throw invalidRequest('X-File-Name must use valid percent encoding.') }
  if (!value || value.length > 255 || !/\.pdf$/i.test(value) ||
    [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || '/\\'.includes(character)) ||
    /[:*?"<>|]/.test(value)) throw invalidRequest('X-File-Name must be a safe PDF basename.')
  return value
}

function pagesHeader(header: string | undefined): number[] {
  if (header === undefined || header === '') return []
  if (header.length > 3000) throw invalidRequest('X-Source-Pages is too long.')
  const pages: number[] = []
  for (const value of header.split(',')) {
    const match = /^(\d{1,6})(?:\s*-\s*(\d{1,6}))?$/.exec(value.trim())
    if (!match) throw invalidRequest('X-Source-Pages must contain comma-separated page numbers or ranges.')
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (start < 1 || end < start || end > 100_000 || end - start + 1 + pages.length > GRADE_LADDER_LIMITS.maxPdfPages) {
      throw invalidRequest('The selected pages are outside the supported page budget.')
    }
    for (let page = start; page <= end; page++) pages.push(page)
  }
  if (new Set(pages).size !== pages.length) throw invalidRequest('Selected PDF pages must not repeat.')
  return pages.sort((a, b) => a - b)
}

export function validateGradePublicUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw invalidRequest('URL must be an absolute public HTTP(S) URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
    url.port || value.length > GRADE_LADDER_LIMITS.maxUrlLength) {
    throw invalidRequest('URL must use public HTTP(S), standard ports, and no credentials.')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  let address: ipaddr.IPv4 | ipaddr.IPv6 | undefined
  try { address = ipaddr.parse(host.replace(/^\[|\]$/g, '')) } catch { /* DNS is revalidated and pinned by the reference worker. */ }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || (!address && !host.includes('.'))) throw invalidRequest('URL host must be public.')
  if (address) {
    if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) address = (address as ipaddr.IPv6).toIPv4Address()
    if (address.range() !== 'unicast' || address.toString() === '168.63.129.16') throw invalidRequest('URL host must be public.')
  }
  return url.toString()
}

export function createRealGradesRouter(deps: GradeRouterDeps): Router {
  const router = express.Router()
  const base = '/workspaces/:workspaceId/grade-ladders'
  const service = deps.grades ? new GradeService(deps.grades, deps.jobs, deps.now) : undefined
  const lifecycle = deps.grades ? new GradeLifecycleService(deps.grades, deps.lifecycle, deps.now) : undefined
  const requireService = () => {
    if (!service) throw unavailable('Real grade ladders are not enabled for this deployment.')
    return service
  }
  const authorize: RequestHandler = async (req, _res, next) => {
    try {
      await deps.repository.authorizeWorkspace(getPrincipal(req), workspaceId(req),
        /\/lifecycle\/?$/.test(req.path) ? 'manage' : req.method === 'GET' ? 'read' : 'write')
      requireService()
      next()
    } catch (error) { next(error) }
  }
  router.use(base, authorize)
  const mutating = (
    access: 'write' | 'manage', callback: (req: Request, res: express.Response) => Promise<void>,
  ): RequestHandler => async (req, res, next) => {
    try {
      await deps.repository.withWorkspaceMutation(getPrincipal(req), workspaceId(req), access, () => callback(req, res))
    } catch (error) { next(error) }
  }
  const mutation = (
    callback: (service: GradeService, req: Request) => ReturnType<GradeService['detail']>, status = 200,
  ): RequestHandler => mutating('write', async (req, res) => {
    const detail = await callback(requireService(), req)
    res.setHeader('ETag', detail.etag)
    res.status(status).json({ ladder: detail })
  })

  router.get(base, async (req, res) => {
    const options = page(req)
    res.json(await requireService().list(workspaceId(req), options.continuationToken, options.limit))
  })
  router.post(base, mutation((service, req) => {
    const input = parse(createGradeInputSchema, req.body)
    input.grades.sort((a, b) => a - b)
    return service.create(workspaceId(req), key(req), input, actor(req))
  }, 202))
  router.get(`${base}/:ladderId`, async (req, res) => {
    const detail = await requireService().detail(workspaceId(req), ladderId(req))
    res.setHeader('ETag', detail.etag)
    res.json(detail)
  })
  router.get(`${base}/:ladderId/lifecycle`, async (req, res) => {
    const value = req.query.grade
    if (value !== undefined && (typeof value !== 'string' || !/^(?:[1-9]|1[0-5])$/.test(value))) {
      throw invalidRequest('grade must be an integer between 1 and 15.')
    }
    const selected = value === undefined ? undefined : Number(value)
    const [impact, currentEtag] = await Promise.all([
      lifecycle!.impact(workspaceId(req), ladderId(req), selected), lifecycle!.etag(workspaceId(req), ladderId(req), selected),
    ])
    res.setHeader('ETag', currentEtag)
    res.json({ impact })
  })
  router.post(`${base}/:ladderId/lifecycle`, mutating('manage', async (req, res) => {
    const input = parse(gradeLifecycleInputSchema, req.body)
    const result = await lifecycle!.change(workspaceId(req), ladderId(req), input.action, etag(req), input.grade)
    if (result.pending) {
      if (result.etag) res.setHeader('ETag', result.etag)
      res.status(202).json(result)
    } else if (result.deleted) res.json({ deleted: true })
    else {
      const detail = await requireService().detail(workspaceId(req), ladderId(req))
      const targetEtag = input.grade === undefined ? detail.etag :
        detail.levels.find(level => level.head.grade === input.grade)?.etag ??
          await lifecycle!.etag(workspaceId(req), ladderId(req), input.grade)
      res.setHeader('ETag', targetEtag)
      res.json({ ladder: detail })
    }
  }))
  router.patch(`${base}/:ladderId`, mutation((service, req) => {
    const input = parse(updateGradeInputSchema, req.body)
    input.grades?.sort((a, b) => a - b)
    return service.update(workspaceId(req), ladderId(req), input, etag(req))
  }))
  router.post(`${base}/:ladderId/discover`, mutation((service, req) => {
    parse(emptyGradeInputSchema, req.body)
    return service.discover(workspaceId(req), ladderId(req), key(req), actor(req), etag(req))
  }))
  router.post(`${base}/:ladderId/sources/pdf`,
    (req: Request, _res: express.Response, next: express.NextFunction) => {
      try {
        ladderId(req)
        key(req)
        filename(req.header('X-File-Name'))
        if (!req.is('application/pdf')) throw invalidRequest('Content-Type must be application/pdf.')
        if (req.header('Content-Encoding') && req.header('Content-Encoding') !== 'identity') {
          throw invalidRequest('Compressed PDF uploads are not supported.')
        }
        next()
      } catch (error) { next(error) }
    },
    express.raw({ type: 'application/pdf', limit: GRADE_LADDER_LIMITS.maxPdfBytes, inflate: false }),
    mutation(async (service, req) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length || req.body.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) < 0) {
        throw invalidRequest('The uploaded body must be a valid, nonempty PDF.')
      }
      const pages = pagesHeader(req.header('X-Source-Pages'))
      let pageCount: number
      try {
        const pdf = await PDFDocument.load(req.body, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true })
        if (pdf.isEncrypted) throw new Error('Encrypted PDF')
        pageCount = pdf.getPageCount()
      } catch { throw invalidRequest('The PDF cannot be read. Upload an unencrypted, structurally valid PDF.') }
      if (!pageCount || pageCount > 100_000 || pages.some(page => page > pageCount) ||
        (!pages.length && pageCount > GRADE_LADDER_LIMITS.maxPdfPages)) {
        throw invalidRequest(`Select up to ${GRADE_LADDER_LIMITS.maxPdfPages} pages within the PDF's original page count.`)
      }
      return service.addPdf(workspaceId(req), ladderId(req), key(req), actor(req), filename(req.header('X-File-Name')), req.body, pages, pageCount)
    }),
    (error: unknown, _req: Request, _res: express.Response, next: express.NextFunction) => {
      if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
        next(new HttpError(413, 'invalid_request', 'Reference PDFs may not exceed 20 MiB.'))
      } else next(error)
    },
  )
  router.post(`${base}/:ladderId/sources/url`, mutation((service, req) => {
    const input = parse(addGradeUrlInputSchema, req.body)
    input.url = validateGradePublicUrl(input.url)
    input.selectedPages?.sort((a, b) => a - b)
    return service.addUrl(workspaceId(req), ladderId(req), key(req), actor(req), input)
  }))
  router.patch(`${base}/:ladderId/sources/:sourceId`, mutation((service, req) => {
    const input = parse(updateGradeSourceInputSchema, req.body)
    input.selectedPages.sort((a, b) => a - b)
    return service.selectPages(workspaceId(req), ladderId(req), sourceId(req), input.selectedPages, etag(req))
  }))
  router.post(`${base}/:ladderId/source-set`, mutation((service, req) => service.confirm(
    workspaceId(req), ladderId(req), key(req), actor(req), parse(confirmGradeInputSchema, req.body), etag(req),
  )))
  router.post(`${base}/:ladderId/generate`, mutation((service, req) => {
    parse(emptyGradeInputSchema, req.body)
    return service.generate(workspaceId(req), ladderId(req), key(req), actor(req), etag(req))
  }))
  for (const action of ['cancel', 'retry'] as const) {
    router.post(`${base}/:ladderId/${action}`, mutation((service, req) => service.action(
      workspaceId(req), ladderId(req), parse(gradeActionInputSchema, req.body), action, etag(req),
    )))
  }
  router.put(`${base}/:ladderId/grades/:grade/draft`, mutation((service, req) => service.edit(
    workspaceId(req), ladderId(req), grade(req), parse(editGradeInputSchema, req.body), actor(req), etag(req),
  )))
  router.post(`${base}/:ladderId/grades/:grade/approve`, mutation((service, req) => service.approve(
    workspaceId(req), ladderId(req), grade(req), parse(approveGradeInputSchema, req.body), actor(req), etag(req),
  )))
  router.get(`${base}/:ladderId/grades/:grade/versions`, async (req, res) => {
    const options = page(req)
    res.json(await requireService().versions(workspaceId(req), ladderId(req), grade(req), options.continuationToken, options.limit))
  })
  router.get(`${base}/:ladderId/source-sets/:sourceSetId`, async (req, res) => {
    res.json(await requireService().sourceSet(workspaceId(req), ladderId(req), requireGradePathId(param(req, 'sourceSetId'), 'source-set')))
  })
  router.get(`${base}/:ladderId/sources/:sourceId/document`, async (req, res) => {
    res.json(await requireService().document(workspaceId(req), ladderId(req), sourceId(req), historicalSourceSet(req)))
  })
  router.get(`${base}/:ladderId/sources/:sourceId/original`, async (req, res) => {
    const blob = await requireService().original(workspaceId(req), ladderId(req), sourceId(req), historicalSourceSet(req))
    if (!isOriginalContentType(blob.contentType)) throw unavailable('The source original has invalid content metadata.')
    res.setHeader('Content-Type', blob.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${sourceId(req)}.${originalExtension(blob.contentType)}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
    res.setHeader('ETag', blob.etag)
    res.send(Buffer.from(blob.bytes))
  })
  return router
}
