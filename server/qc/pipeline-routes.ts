import { Router, type Request } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { QC_LIMITS, qcIdentifier } from '../../src/domain/quality-control'
import { isApplicationAdmin } from '../auth'
import { forbidden, invalidRequest, notFound, unavailable } from '../errors'
import { userRateLimitOptions } from '../rate-limit'
import { getPrincipal } from '../request-context'
import type { QcRouterDeps } from './routes'
import { QcService, type QcCaller } from './service'
import { QualityPipelineService } from './pipeline'
import { qcInput } from './validation'

const pageSchema = z.strictObject({
  limit: z.string().regex(/^[1-9]\d?$/).transform(Number).pipe(z.number().max(QC_LIMITS.pageSize)).optional(),
  continuationToken: z.string().min(1).max(24 * 1024).optional(),
})

export function createQualityPipelineRouter(deps: Pick<QcRouterDeps, 'repository' | 'config' | 'qc' | 'analyses' | 'now'>) {
  const router = Router()
  const base = '/admin/quality-pipeline/workspaces/:workspaceId/plans'
  router.use('/admin/quality-pipeline', (req, res, next) => {
    if (!isApplicationAdmin(getPrincipal(req), deps.config)) throw forbidden('Application administrator access is required for the quality pipeline.')
    res.setHeader('Cache-Control', 'private, no-store')
    if (req.header('Sec-Fetch-Site') === 'cross-site' || req.header('Origin') && req.header('Origin') !== deps.config.appOrigin) {
      throw forbidden('The quality pipeline is available only from this application origin.')
    }
    next()
  })
  router.use('/admin/quality-pipeline', rateLimit(userRateLimitOptions({
    limit: 300, windowMilliseconds: 60_000, message: 'Quality pipeline request limit reached.',
  })))

  function param(req: Request, key: string): string {
    const parsed = qcIdentifier.safeParse(req.params[key])
    if (!parsed.success) throw notFound('The requested quality pipeline scope was not found.')
    return parsed.data
  }
  async function authorize(req: Request): Promise<QcCaller> {
    const principal = getPrincipal(req)
    if (!isApplicationAdmin(principal, deps.config)) throw forbidden('Application administrator access is required for the quality pipeline.')
    const workspaceId = param(req, 'workspaceId')
    const role = await deps.repository.authorizeWorkspaceMembership(principal, workspaceId)
    const { metadata } = await deps.repository.getWorkspaceMetadata(principal, workspaceId)
    if (metadata.deletedAt || metadata.lifecycleOperation?.action === 'delete' && metadata.lifecycleOperation.status !== 'complete') {
      throw notFound('This workspace is being removed.')
    }
    return { workspaceId, role, applicationAdmin: true, actor: { principalId: principal.principalKey, name: principal.name.slice(0, 300) } }
  }
  function service(): QualityPipelineService {
    if (!deps.qc || !deps.analyses) throw unavailable('The private QC and analysis stores are not available. The explanatory map is still available.')
    return new QualityPipelineService(new QcService({ qc: deps.qc, analyses: deps.analyses, now: deps.now }))
  }
  router.get(base, async (req, res) => {
    const caller = await authorize(req)
    const options = qcInput(pageSchema, req.query)
    const value = await service().list(caller, { ...options, limit: options.limit ?? QC_LIMITS.pageSize })
    await authorize(req)
    res.json(value)
  })
  router.get(`${base}/:planId`, async (req, res) => {
    const caller = await authorize(req)
    if (Object.keys(req.query).length) throw invalidRequest('The selected quality pipeline plan does not accept query parameters.')
    const value = await service().detail(caller, param(req, 'planId'))
    await authorize(req)
    res.json(value)
  })
  return router
}
