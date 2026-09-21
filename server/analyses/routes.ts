import express, { type Request, type RequestHandler, type Response, type Router } from 'express'
import type { WorkspaceRepository } from '../repository'
import type { RealJobsDeps } from '../jobs/routes'
import type { RealGradesDeps } from '../grades/service'
import type { RealResumesDeps } from '../resumes/store'
import { getPrincipal } from '../request-context'
import { traceOperation } from '../telemetry-operations'
import { forbidden, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { isUuid } from '../jobs/validation'
import type { RealAnalysesDeps } from './store'
import { RealAnalysisService } from './service'
import { AnalysisLibraryLifecycleService } from './library-lifecycle'
import { analysisCorrectionInputSchema } from './correction-validation'
import { publishSummaryDraftInputSchema, type AnalysisSummarySubject } from '../../src/domain/analysis-summary-history'
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
function summarySubject(req: Request): AnalysisSummarySubject {
  const kind = param(req, 'kind'), subjectId = param(req, 'subjectId')
  if (kind !== 'candidate' && kind !== 'target' ||
    (kind === 'candidate' ? !isAnalysisId(subjectId, 'comparison') : !analysisNarrativeTargetIdSchema.safeParse(subjectId).success)) {
    throw notFound('The exact saved summary was not found.')
  }
  return { kind, subjectId }
}
function match(req: Request): string {
  const value = req.header('If-Match')
  if (!value) throw preconditionRequired('An If-Match header containing the current record ETag is required.')
  if (value.trim() !== value || value === '*' || value.startsWith('W/') ||
    value.length > 1024 || /[,\r\n]/.test(value)) throw invalidRequest('If-Match must contain one exact ETag.')
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

function read(callback: (req: Request, res: Response, signal: AbortSignal) => Promise<void>): RequestHandler {
  return async (req, res) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const deadline = setTimeout(() => controller.abort(new DOMException('Analysis read deadline exceeded.', 'TimeoutError')), 30_000)
    deadline.unref()
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      if (req.aborted || res.destroyed) controller.abort()
      controller.signal.throwIfAborted()
      await callback(req, res, controller.signal)
    } catch (error) {
      if (req.aborted || res.destroyed) return
      if (controller.signal.aborted && controller.signal.reason?.name === 'TimeoutError') {
        throw unavailable('The saved analysis read timed out. Retry the read; no saved work was changed.')
      }
      throw error
    } finally {
      clearTimeout(deadline)
      req.off('aborted', abort)
      res.off('close', abort)
    }
  }
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
      res.locals.analysisWorkspaceRole = await traceOperation('score.analysis.authorize', {}, () =>
        deps.repository.authorizeWorkspace(getPrincipal(req), param(req, 'workspaceId'),
          req.method === 'GET' ? 'read' : req.path.endsWith('/lifecycle') ? 'manage' : 'write'))
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
  router.patch(`${base}/:runId/metadata`, mutate('write', async (req, res) => {
    query(req, [])
    if (!req.is('application/json')) throw invalidRequest('Content-Type must be application/json.')
    const run = await requireService().updateMetadata(param(req, 'workspaceId'), recordId(req, 'run'), req.body, match(req))
    res.setHeader('ETag', run.etag)
    res.json({ run })
  }))
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
  router.get(`${base}/:runId/comparisons`, read(async (req, res, signal) => {
    const options = page(req)
    const comparisons = await requireService().comparisons(param(req, 'workspaceId'), recordId(req, 'run'), options.continuationToken, options.limit, signal)
    signal.throwIfAborted()
    res.json(comparisons)
  }))
  router.get(`${base}/:runId/summaries`, read(async (req, res, signal) => {
    query(req, ['targetId'])
    const targetId = req.query.targetId === undefined ? undefined : body(analysisNarrativeTargetIdSchema, req.query.targetId)
    const summaries = await requireService().summaries(param(req, 'workspaceId'), recordId(req, 'run'), targetId, signal)
    signal.throwIfAborted()
    if (res.locals.analysisWorkspaceRole === 'viewer') summaries.capabilities = { canGenerate: false, reason: 'read-only' }
    res.setHeader('ETag', summaries.etag)
    res.json(summaries)
  }))
  router.post(`${base}/:runId/summaries`, mutate('write', async (req, res) => {
    query(req, [])
    const result = await requireService().generateSummaries(param(req, 'workspaceId'), recordId(req, 'run'),
      body(generateAnalysisSummariesInputSchema, req.body), key(req), match(req), getPrincipal(req).principalKey)
    res.setHeader('ETag', result.summaries.etag)
    res.status(202).json(result)
  }))
  const summaryBase = `${base}/:runId/summaries/:kind/:subjectId`
  router.get(summaryBase, read(async (req, res, signal) => {
    query(req, [])
    const summary = await requireService().summarySubject(param(req, 'workspaceId'), recordId(req, 'run'), summarySubject(req), signal)
    signal.throwIfAborted()
    res.setHeader('ETag', summary.etag)
    res.json(summary)
  }))
  router.get(`${summaryBase}/history`, read(async (req, res, signal) => {
    if (!['owner', 'editor'].includes(res.locals.analysisWorkspaceRole)) {
      throw forbidden('Only workspace owners and editors may inspect unpublished summary history.')
    }
    query(req, ['continuationToken'])
    const token = req.query.continuationToken
    if (token !== undefined && (typeof token !== 'string' || !token || token.length > 16 * 1024)) {
      throw invalidRequest('continuationToken must be a single valid summary history token.')
    }
    const history = await requireService().summaryHistory(param(req, 'workspaceId'), recordId(req, 'run'), summarySubject(req), token, signal)
    signal.throwIfAborted()
    res.setHeader('ETag', history.etag)
    res.json(history)
  }))
  router.post(`${summaryBase}/publish`, mutate('write', async (req, res) => {
    query(req, [])
    const result = await requireService().publishSummary(param(req, 'workspaceId'), recordId(req, 'run'), summarySubject(req),
      body(publishSummaryDraftInputSchema, req.body), key(req), match(req), getPrincipal(req).principalKey)
    res.setHeader('ETag', result.summaries.etag)
    res.json(result)
  }))
  router.post(`${summaryBase}/retry`, mutate('write', async (req, res) => {
    query(req, [])
    body(emptyAnalysisInputSchema, actionBody(req))
    const result = await requireService().retrySummary(param(req, 'workspaceId'), recordId(req, 'run'), summarySubject(req),
      key(req), match(req), getPrincipal(req).principalKey)
    res.setHeader('ETag', result.summaries.etag)
    res.status(202).json(result)
  }))
  router.get(`${base}/:runId/report-comparisons`, read(async (req, res, signal) => {
    query(req, ['comparisonId'])
    body(emptyAnalysisInputSchema, actionBody(req))
    const ids = req.query.comparisonId
    const comparisonIds = body(reportComparisonIdsSchema, typeof ids === 'string' ? [ids] : ids)
    const report = await requireService().reportComparisons(
      param(req, 'workspaceId'), recordId(req, 'run'), comparisonIds, signal,
    )
    signal.throwIfAborted()
    res.json(report)
  }))
  router.get(`${base}/:runId/comparisons/:comparisonId`, read(async (req, res, signal) => {
    query(req, [])
    const detail = await requireService().comparisonDetail(param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), signal)
    signal.throwIfAborted()
    res.setHeader('ETag', detail.etag)
    res.json(detail)
  }))
  router.get(`${base}/:runId/comparisons/:comparisonId/diagnostics`, read(async (req, res, signal) => {
    query(req, ['continuationToken'])
    const token = req.query.continuationToken
    if (token !== undefined && (typeof token !== 'string' || !token || token.length > 16 * 1024)) {
      throw invalidRequest('continuationToken must be a single valid diagnostic history token.')
    }
    const diagnostics = await requireService().diagnostics(
      param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), token, signal,
    )
    signal.throwIfAborted()
    res.json(diagnostics)
  }))
  const correctionBase = `${base}/:runId/comparisons/:comparisonId/corrections`
  const correctionRead = (res: Response) => {
    if (!['owner', 'editor'].includes(res.locals.analysisWorkspaceRole)) {
      throw forbidden('Only workspace owners and editors may review correction proposals and history.')
    }
  }
  router.get(correctionBase, async (req, res) => {
    query(req, [])
    correctionRead(res)
    res.json(await requireService().correctionState(param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison')))
  })
  router.get(`${correctionBase}/preview`, async (req, res) => {
    query(req, [])
    correctionRead(res)
    const preview = await requireService().correctionPreview(param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'))
    res.setHeader('ETag', preview.etag)
    res.json(preview)
  })
  router.get(`${correctionBase}/history`, async (req, res) => {
    query(req, ['continuationToken'])
    correctionRead(res)
    const token = req.query.continuationToken
    if (token !== undefined && (typeof token !== 'string' || !token || token.length > 2048)) throw invalidRequest('Invalid correction history token.')
    res.json(await requireService().correctionHistory(param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), token))
  })
  router.post(correctionBase, mutate('write', async (req, res) => {
    query(req, [])
    const result = await requireService().requestCorrection(
      param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'),
      body(analysisCorrectionInputSchema, req.body), key(req), match(req), getPrincipal(req).principalKey,
    )
    res.setHeader('ETag', result.correction.etag)
    res.status(202).json(result)
  }))
  router.post(`${correctionBase}/cancel`, mutate('write', async (req, res) => {
    query(req, [])
    body(emptyAnalysisInputSchema, actionBody(req))
    const result = await requireService().cancelCorrection(
      param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), match(req),
    )
    res.setHeader('ETag', result.correction.etag)
    res.json(result)
  }))
  router.get(`${base}/:runId/comparisons/:comparisonId/documents/:documentId`, read(async (req, res, signal) => {
    query(req, ['version'])
    const version = req.query.version
    if (typeof version !== 'string' || !/^(?:[1-9]\d{0,5}|1000000)$/.test(version)) throw invalidRequest('version must identify one exact document version.')
    const document = await requireService().document(
      param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), param(req, 'documentId'), Number(version), signal,
    )
    signal.throwIfAborted()
    res.json(document)
  }))
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
