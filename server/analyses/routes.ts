import express, { type Request, type RequestHandler, type Response, type Router } from 'express'
import type { WorkspaceRepository } from '../repository'
import type { RealJobsDeps } from '../jobs/routes'
import type { RealGradesDeps } from '../grades/service'
import type { RealResumesDeps } from '../resumes/store'
import { getPrincipal } from '../request-context'
import { invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { isUuid } from '../jobs/validation'
import type { RealAnalysesDeps } from './store'
import { RealAnalysisService } from './service'
import { AnalysisLibraryLifecycleService } from './library-lifecycle'
import {
  analysisLifecycleInputSchema, createAnalysisInputSchema, emptyAnalysisInputSchema,
  analysisNarrativeTargetIdSchema, generateAnalysisSummariesInputSchema, isAnalysisId, reportComparisonIdsSchema, retryAnalysisInputSchema,
} from './validation'

export type { RealAnalysesDeps } from './store'
export interface RealAnalysesRouterDeps {
  repository: WorkspaceRepository
  analyses?: RealAnalysesDeps
  resumes?: RealResumesDeps
  jobs?: RealJobsDeps
  grades?: RealGradesDeps
  now?: () => Date
}
function param(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string') throw notFound('The requested analysis was not found.')
  return value
}
function recordId(req: Request, kind: 'run' | 'comparison'): string {
  const value = param(req, `${kind}Id`)
  if (!isAnalysisId(value, kind)) throw notFound('The requested analysis record was not found.')
  return value
}
function match(req: Request): string {
  const value = req.header('If-Match')
  if (!value) throw preconditionRequired('An If-Match header containing the current record ETag is required.')
  if (value === '*' || value.length > 1024 || /[,\r\n]/.test(value)) throw invalidRequest('If-Match must contain one exact ETag.')
  return value
}
function key(req: Request): string {
  const value = req.header('Idempotency-Key')
  if (!value || !isUuid(value)) throw invalidRequest('Idempotency-Key must be a UUID.')
  return value.toLowerCase()
}
function query(req: Request, allowed: string[]): void {
  if (Object.keys(req.query).some(name => !allowed.includes(name))) throw invalidRequest('Unsupported analysis query parameter.')
}
function page(req: Request) {
  query(req, ['continuationToken', 'limit'])
  const token = req.query.continuationToken
  if (token !== undefined && (typeof token !== 'string' || !token || token.length > 16 * 1024)) throw invalidRequest('continuationToken must be a single valid token.')
  const limit = req.query.limit
  if (limit !== undefined && (typeof limit !== 'string' || !/^(?:[1-9]\d?|100)$/.test(limit))) throw invalidRequest('limit must be an integer between 1 and 100.')
  return { continuationToken: token as string | undefined, limit: limit === undefined ? 50 : Number(limit) }
}
function body<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw invalidRequest('The analysis request has invalid selections, counts, types, or unsupported fields.')
  return result.data
}
function actionBody(req: Request): unknown {
  if (req.body !== undefined) return req.body
  // An unparsed entity (for example text/plain) is not an empty request.
  const length = req.header('Content-Length')
  if (req.header('Transfer-Encoding') !== undefined || (length !== undefined && !/^0+$/.test(length)) || req.readableLength > 0) {
    throw invalidRequest('Action bodies must be JSON objects, or the request must have no body.')
  }
  return {}
}

/** Mount beneath the central authenticated, same-origin/CSRF-protected /api router. */
export function createRealAnalysesRouter(deps: RealAnalysesRouterDeps): Router {
  const router = express.Router()
  const base = '/workspaces/:workspaceId/analyses'
  const service = deps.analyses ? new RealAnalysisService(deps.analyses, deps, deps.now) : undefined
  const lifecycle = deps.analyses ? new AnalysisLibraryLifecycleService(deps.analyses, deps.now) : undefined
  const requireService = () => {
    if (!service) throw unavailable('Real analysis is not enabled for this deployment.')
    return service
  }
  const authorize: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.locals.analysisWorkspaceRole = await deps.repository.authorizeWorkspace(getPrincipal(req), param(req, 'workspaceId'),
        req.method === 'GET' ? 'read' : req.path.endsWith('/lifecycle') ? 'manage' : 'write')
      requireService()
      next()
    } catch (error) { next(error) }
  }
  const mutate = (access: 'write' | 'manage', callback: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      await deps.repository.withWorkspaceMutation(getPrincipal(req), param(req, 'workspaceId'), access, () => callback(req, res))
    }
  router.use(base, authorize)
  router.get(`${base}/targets`, async (req, res) => {
    const options = page(req)
    res.json(await requireService().listTargets(param(req, 'workspaceId'), options.continuationToken, options.limit))
  })
  router.get(base, async (req, res) => {
    const options = page(req)
    res.json(await requireService().list(param(req, 'workspaceId'), options.continuationToken, options.limit))
  })
  router.post(base, mutate('write', async (req, res) => {
    query(req, [])
    const run = await requireService().create(param(req, 'workspaceId'), key(req), body(createAnalysisInputSchema, req.body), getPrincipal(req).principalKey)
    res.setHeader('ETag', run.etag)
    res.status(202).json({ run })
  }))
  router.get(`${base}/:runId`, async (req, res) => {
    query(req, [])
    const detail = await requireService().detail(param(req, 'workspaceId'), recordId(req, 'run'))
    res.setHeader('ETag', detail.etag)
    res.json(detail)
  })
  router.get(`${base}/:runId/lifecycle`, async (req, res) => {
    query(req, [])
    requireService()
    res.json({ impact: await lifecycle!.impact(param(req, 'workspaceId'), recordId(req, 'run')) })
  })
  router.post(`${base}/:runId/lifecycle`, mutate('manage', async (req, res) => {
    query(req, [])
    const { action } = body(analysisLifecycleInputSchema, req.body)
    const result = await lifecycle!.change(
      param(req, 'workspaceId'), recordId(req, 'run'), action, match(req), getPrincipal(req).principalKey,
    )
    if (result.etag) res.setHeader('ETag', result.etag)
    if (result.pending) {
      res.status(202).json({ operation: result.operation, ...(result.etag ? { etag: result.etag } : {}),
        ...(result.analysis ? { analysis: result.analysis } : {}) })
    } else res.json(result.deleted ? { deleted: true } : { analysis: result.analysis })
  }))
  router.get(`${base}/:runId/comparisons`, async (req, res) => {
    const options = page(req)
    res.json(await requireService().comparisons(param(req, 'workspaceId'), recordId(req, 'run'), options.continuationToken, options.limit))
  })
  router.get(`${base}/:runId/summaries`, async (req, res) => {
    query(req, ['targetId'])
    const targetId = req.query.targetId === undefined ? undefined : body(analysisNarrativeTargetIdSchema, req.query.targetId)
    const summaries = await requireService().summaries(param(req, 'workspaceId'), recordId(req, 'run'), targetId)
    if (res.locals.analysisWorkspaceRole === 'viewer') summaries.capabilities = { canGenerate: false, reason: 'read-only' }
    res.setHeader('ETag', summaries.etag)
    res.json(summaries)
  })
  router.post(`${base}/:runId/summaries`, mutate('write', async (req, res) => {
    query(req, [])
    const result = await requireService().generateSummaries(param(req, 'workspaceId'), recordId(req, 'run'),
      body(generateAnalysisSummariesInputSchema, req.body), key(req), match(req), getPrincipal(req).principalKey)
    res.setHeader('ETag', result.summaries.etag)
    res.status(202).json(result)
  }))
  router.get(`${base}/:runId/report-comparisons`, async (req, res) => {
    query(req, ['comparisonId'])
    body(emptyAnalysisInputSchema, actionBody(req))
    const ids = req.query.comparisonId
    const comparisonIds = body(reportComparisonIdsSchema, typeof ids === 'string' ? [ids] : ids)
    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      if (req.aborted) controller.abort()
      const report = await requireService().reportComparisons(
        param(req, 'workspaceId'), recordId(req, 'run'), comparisonIds, controller.signal,
      )
      controller.signal.throwIfAborted()
      res.json(report)
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
    }
  })
  router.get(`${base}/:runId/comparisons/:comparisonId`, async (req, res) => {
    query(req, [])
    const detail = await requireService().comparisonDetail(param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'))
    res.setHeader('ETag', detail.etag)
    res.json(detail)
  })
  router.get(`${base}/:runId/comparisons/:comparisonId/documents/:documentId`, async (req, res) => {
    query(req, ['version'])
    const version = req.query.version
    if (typeof version !== 'string' || !/^(?:[1-9]\d{0,5}|1000000)$/.test(version)) throw invalidRequest('version must identify one exact document version.')
    res.json(await requireService().document(
      param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), param(req, 'documentId'), Number(version),
    ))
  })
  router.post(`${base}/:runId/retry`, mutate('write', async (req, res) => {
    query(req, [])
    const run = await requireService().retry(param(req, 'workspaceId'), recordId(req, 'run'), body(retryAnalysisInputSchema, actionBody(req)), match(req))
    res.setHeader('ETag', run.etag)
    res.json({ run })
  }))
  router.post(`${base}/:runId/cancel`, mutate('write', async (req, res) => {
    query(req, [])
    body(emptyAnalysisInputSchema, actionBody(req))
    const run = await requireService().cancel(param(req, 'workspaceId'), recordId(req, 'run'), getPrincipal(req).principalKey, match(req))
    res.setHeader('ETag', run.etag)
    res.json({ run })
  }))
  for (const action of ['retry', 'cancel'] as const) {
    router.post(`${base}/:runId/comparisons/:comparisonId/${action}`, mutate('write', async (req, res) => {
      query(req, [])
      body(emptyAnalysisInputSchema, actionBody(req))
      const comparison = await requireService().comparisonAction(
        param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), action, match(req),
      )
      res.setHeader('ETag', comparison.etag)
      res.json({ comparison })
    }))
  }
  return router
}
