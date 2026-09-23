import express, { type Request, type RequestHandler, type Response, type Router } from 'express'
import type { WorkspaceRepository } from '../repository'
import type { RealJobsDeps } from '../jobs/routes'
import type { RealGradesDeps } from '../grades/service'
import type { RealResumesDeps } from '../resumes/store'
import { getPrincipal, getRequestSettings, runtimeSettingsEnabled } from '../request-context'
import { canUseSummaryRole, requestProcessingSettings } from '../jobs/policy'
import { traceOperation } from '../telemetry-operations'
import { forbidden, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { isUuid } from '../jobs/validation'
import type { RealAnalysesDeps } from './store'
import { RealAnalysisService } from './service'
import { AnalysisLibraryLifecycleService } from './library-lifecycle'
import { AnalysisReportCaptures } from './reports'
import { REPORT_FORMATS, type AnalysisReportFormat } from '../../src/domain/analysis-reports'
import { workspaceCanEdit } from '../../src/domain/workspace-permissions'
import { analysisCorrectionInputSchema } from './correction-validation'
import { publishSummaryDraftInputSchema, restartSummaryInputSchema, type AnalysisSummarySubject } from '../../src/domain/analysis-summary-history'
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
function summaryResultRevision(req: Request, res: Response): string | undefined {
  const revision = req.query.resultRevisionId
  if (revision === undefined) return undefined
  if (!workspaceCanEdit(res.locals.analysisWorkspaceRole)) throw forbidden('Only owners and editors may inspect historical result summaries.')
  if (param(req, 'kind') !== 'candidate' || typeof revision !== 'string' || revision !== 'original' && !isUuid(revision)) {
    throw invalidRequest('resultRevisionId must identify the original or one published candidate correction.')
  }
  return revision
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
  const reportCaptures = new AnalysisReportCaptures(deps.now)
  const requireService = (req?: Request) => {
    if (!service) throw unavailable('Real analysis is not enabled for this deployment.')
    return req ? new RealAnalysisService(deps.analyses!, deps, deps.now, requestProcessingSettings(req)) : service
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
    const run = await requireService(req).create(param(req, 'workspaceId'), key(req), body(createAnalysisInputSchema, req.body), getPrincipal(req).principalKey)
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
    if (!workspaceCanEdit(res.locals.analysisWorkspaceRole)) summaries.capabilities = { canGenerate: false, reason: 'read-only' }
    res.setHeader('ETag', summaries.etag)
    res.json(summaries)
  }))
  router.post(`${base}/:runId/summaries`, mutate('write', async (req, res) => {
    query(req, [])
    const result = await requireService(req).generateSummaries(param(req, 'workspaceId'), recordId(req, 'run'),
      body(generateAnalysisSummariesInputSchema, req.body), key(req), match(req), getPrincipal(req).principalKey)
    res.setHeader('ETag', result.summaries.etag)
    res.status(202).json(result)
  }))
  const summaryBase = `${base}/:runId/summaries/:kind/:subjectId`
  router.get(summaryBase, read(async (req, res, signal) => {
    query(req, ['resultRevisionId'])
    const summary = await requireService().summarySubject(param(req, 'workspaceId'), recordId(req, 'run'), summarySubject(req), signal, summaryResultRevision(req, res))
    signal.throwIfAborted()
    res.setHeader('ETag', summary.etag)
    res.json(summary)
  }))
  router.get(`${summaryBase}/history`, read(async (req, res, signal) => {
    if (!workspaceCanEdit(res.locals.analysisWorkspaceRole)) {
      throw forbidden('Only workspace owners and editors may inspect unpublished summary history.')
    }
    const policy = (await getRequestSettings(req)).settings.summaries
    if (!canUseSummaryRole(policy.historyRoles, res.locals.analysisWorkspaceRole)) {
      throw forbidden('Application policy restricts unpublished summary history to workspace owners.')
    }
    query(req, ['continuationToken', 'resultRevisionId'])
    const token = req.query.continuationToken
    if (token !== undefined && (typeof token !== 'string' || !token || token.length > 16 * 1024)) {
      throw invalidRequest('continuationToken must be a single valid summary history token.')
    }
    const history = await requireService().summaryHistory(param(req, 'workspaceId'), recordId(req, 'run'), summarySubject(req), token,
      signal, summaryResultRevision(req, res), policy.historyPageSize)
    signal.throwIfAborted()
    history.capabilities.canPublish &&= policy.allowManualPublication &&
      canUseSummaryRole(policy.manualPublicationRoles, res.locals.analysisWorkspaceRole)
    res.setHeader('ETag', history.etag)
    res.json(history)
  }))
  router.post(`${summaryBase}/publish`, mutate('write', async (req, res) => {
    query(req, [])
    const policy = (await getRequestSettings(req)).settings.summaries
    if (!policy.allowManualPublication || !canUseSummaryRole(policy.manualPublicationRoles, res.locals.analysisWorkspaceRole)) {
      throw forbidden('Application policy does not allow your workspace role to manually publish summaries.')
    }
    const result = await requireService(req).publishSummary(param(req, 'workspaceId'), recordId(req, 'run'), summarySubject(req),
      body(publishSummaryDraftInputSchema, req.body), key(req), match(req), getPrincipal(req).principalKey)
    res.setHeader('ETag', result.summaries.etag)
    res.json(result)
  }))
  router.post(`${summaryBase}/retry`, mutate('write', async (req, res) => {
    query(req, [])
    body(emptyAnalysisInputSchema, actionBody(req))
    const result = await requireService(req).retrySummary(param(req, 'workspaceId'), recordId(req, 'run'), summarySubject(req),
      key(req), match(req), getPrincipal(req).principalKey)
    res.setHeader('ETag', result.summaries.etag)
    res.status(202).json(result)
  }))
  router.post(`${summaryBase}/restart`, mutate('write', async (req, res) => {
    query(req, [])
    const result = await requireService(req).restartSummary(param(req, 'workspaceId'), recordId(req, 'run'), summarySubject(req),
      body(restartSummaryInputSchema, req.body), key(req), match(req), getPrincipal(req).principalKey)
    res.setHeader('ETag', result.summaries.etag)
    res.status(202).json(result)
  }))
  router.get(`${base}/:runId/report-capture`, read(async (req, res, signal) => {
    query(req, ['format', 'targetId'])
    if (typeof req.query.format !== 'string' || !Object.hasOwn(REPORT_FORMATS, req.query.format)) {
      throw invalidRequest('Choose a supported report format.')
    }
    const targetId = req.query.targetId === undefined ? undefined : body(analysisNarrativeTargetIdSchema, req.query.targetId)
    const capture = await requireService(req).captureReport(
      reportCaptures, param(req, 'workspaceId'), recordId(req, 'run'), getPrincipal(req).principalKey,
      res.locals.analysisWorkspaceRole, req.query.format as AnalysisReportFormat, targetId, signal,
    )
    signal.throwIfAborted()
    res.json(capture)
  }))
  router.get(`${base}/:runId/report-comparisons`, read(async (req, res, signal) => {
    query(req, ['comparisonId', 'format', 'settingsRevision', 'targetId', 'captureToken'])
    body(emptyAnalysisInputSchema, actionBody(req))
    const ids = req.query.comparisonId
    const comparisonIds = body(reportComparisonIdsSchema, typeof ids === 'string' ? [ids] : ids)
    for (const name of ['format', 'settingsRevision', 'targetId', 'captureToken']) {
      if (req.query[name] !== undefined && typeof req.query[name] !== 'string') throw invalidRequest('Report capture parameters must be single values.')
    }
    let captureToken = req.query.captureToken as string | undefined
    if (!captureToken) {
      if (runtimeSettingsEnabled(req)) throw invalidRequest('Capture the current report policy before requesting official export data.')
      const compatibility = await requireService(req).captureReport(
        reportCaptures, param(req, 'workspaceId'), recordId(req, 'run'), getPrincipal(req).principalKey,
        res.locals.analysisWorkspaceRole, 'csv', undefined, signal,
      )
      captureToken = compatibility.captureToken
    }
    const capture = reportCaptures.begin(
      captureToken, param(req, 'workspaceId'), recordId(req, 'run'), getPrincipal(req).principalKey,
      res.locals.analysisWorkspaceRole, comparisonIds, {
        format: req.query.format as string | undefined, settingsRevision: req.query.settingsRevision as string | undefined,
        targetId: req.query.targetId as string | undefined,
      },
    )
    try {
      const report = await requireService().reportComparisons(
        param(req, 'workspaceId'), recordId(req, 'run'), comparisonIds, signal,
        capture.settings, capture.manifestSha256,
      )
      signal.throwIfAborted()
      capture.finish(report)
      res.json(report)
    } finally {
      capture.finish()
    }
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
    if (!workspaceCanEdit(res.locals.analysisWorkspaceRole)) {
      throw forbidden('Only workspace owners and editors may review correction proposals and history.')
    }
  }
  router.get(correctionBase, read(async (req, res, signal) => {
    query(req, [])
    correctionRead(res)
    const state = await requireService().correctionState(param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), signal)
    signal.throwIfAborted()
    res.json(state)
  }))
  router.get(`${correctionBase}/preview`, read(async (req, res, signal) => {
    query(req, [])
    correctionRead(res)
    const preview = await requireService().correctionPreview(param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), signal)
    signal.throwIfAborted()
    res.setHeader('ETag', preview.etag)
    res.json(preview)
  }))
  router.get(`${correctionBase}/history`, read(async (req, res, signal) => {
    query(req, ['continuationToken'])
    correctionRead(res)
    const token = req.query.continuationToken
    if (token !== undefined && (typeof token !== 'string' || !token || token.length > 2048)) throw invalidRequest('Invalid correction history token.')
    const history = await requireService().correctionHistory(param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), token, signal)
    signal.throwIfAborted()
    res.json(history)
  }))
  router.post(correctionBase, mutate('write', async (req, res) => {
    query(req, [])
    const result = await requireService(req).requestCorrection(
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
    const run = await requireService(req).retry(param(req, 'workspaceId'), recordId(req, 'run'), body(retryAnalysisInputSchema, actionBody(req)), match(req))
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
      const comparison = await requireService(req).comparisonAction(
        param(req, 'workspaceId'), recordId(req, 'run'), recordId(req, 'comparison'), action, match(req),
      )
      res.setHeader('ETag', comparison.etag)
      res.json({ comparison })
    }))
  }
  return router
}
