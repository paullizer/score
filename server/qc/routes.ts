import express, { type Request, type RequestHandler, type Response, type Router } from 'express'
import { z } from 'zod'
import { QC_LIMITS, qcComparisonRefSchema, qcIdentifier } from '../../src/domain/quality-control'
import type { QcPlanDetail } from '../../src/domain/quality-improvement'
import { workspaceCanReview } from '../../src/domain/workspace-permissions'
import type { WorkspaceRepository } from '../repository'
import { isApplicationAdmin } from '../auth'
import type { Config } from '../config'
import { conflict, forbidden, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { getPrincipal } from '../request-context'
import type { StateStore } from '../store'
import { StoreConflictError } from '../store'
import { withWorkspaceMutationLease } from '../lifecycle/lease'
import type { RealAnalysesDeps } from '../analyses/store'
import type { PromptRegistryService } from '../settings/prompts'
import { requestProcessingSettings } from '../jobs/policy'
import type { QcDeps } from './store'
import { QcService, type QcCaller } from './service'
import { QcPlanService, qcReasonInputSchema, qcRestoreInputSchema } from './plans'
import { qcEtag, qcInput, qcRequestKey } from './validation'

export interface QcRouterDeps {
  repository: WorkspaceRepository
  state: StateStore
  config: Config
  qc?: QcDeps
  analyses?: RealAnalysesDeps
  prompts?: PromptRegistryService
  now?: () => Date
}
function param(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string' || !qcIdentifier.safeParse(value).success) throw notFound('The requested QC scope was not found.')
  return value
}
function query(req: Request, allowed: string[]): void {
  if (Object.keys(req.query).some(key => !allowed.includes(key))) throw invalidRequest('Unsupported QC query parameter.')
}
function stringQuery(req: Request, name: string, required = true): string | undefined {
  const value = req.query[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value) throw invalidRequest(`QC ${name} must be one nonempty value.`)
  return value
}
function page(req: Request) {
  const text = stringQuery(req, 'limit', false), token = stringQuery(req, 'continuationToken', false)
  const limit = text === undefined ? QC_LIMITS.pageSize : Number(text)
  if (text !== undefined && !/^[1-9]\d?$/.test(text) || !Number.isInteger(limit) || limit > QC_LIMITS.pageSize) {
    throw invalidRequest('QC limit must be an integer between 1 and 50.')
  }
  if (token && token.length > 24 * 1024) throw invalidRequest('The QC continuation token exceeds its bound.')
  return { limit, ...(token ? { continuationToken: token } : {}) }
}
function body(req: Request): unknown {
  if (req.body !== undefined) {
    if (!req.is('application/json')) throw invalidRequest('QC mutation bodies must use application/json.')
    return req.body
  }
  const length = req.header('Content-Length')
  if (req.header('Transfer-Encoding') !== undefined || length !== undefined && !/^0+$/.test(length) || req.readableLength > 0) {
    throw invalidRequest('QC action bodies must be JSON objects.')
  }
  return {}
}
function exactMatch(req: Request, required = true): string | undefined {
  const match = req.header('If-Match'), create = req.header('If-None-Match')
  if (create !== undefined && create !== '*' || match && create) throw invalidRequest('Use one exact If-Match, or If-None-Match: * for initial creation.')
  if (!match && required) throw preconditionRequired('Supply the latest QC record ETag in If-Match.')
  if (match !== undefined) qcEtag(match)
  return match
}
function send(res: Response, value: unknown, status = 200): void {
  if (value && typeof value === 'object' && 'etag' in value && typeof value.etag === 'string') res.setHeader('ETag', value.etag)
  res.status(status).json(value)
}

/** Mount only below the app's authentication, admission, JSON and same-origin CSRF middleware. */
export function createQcRouter(deps: QcRouterDeps): Router {
  const router = express.Router(), base = '/workspaces/:workspaceId/qc'
  const admissionEnabled = () => deps.config.qcEnabled === true
  const assertAdmission = () => {
    if (!admissionEnabled()) throw unavailable('New QC reviews and improvement changes are disabled. Saved QC remains readable and accepted work can still be cancelled.')
  }
  const planDetail = async (result: Promise<QcPlanDetail>): Promise<QcPlanDetail> => {
    const detail = await result
    return admissionEnabled() ? detail : { ...detail, canEdit: false, canActivate: false }
  }
  const service = (req: Request) => {
    if (!deps.qc || !deps.analyses) throw unavailable('Private QC stores and saved real analyses are not enabled for this deployment.')
    return new QcService({ qc: deps.qc, analyses: deps.analyses, now: deps.now, settings: requestProcessingSettings(req) })
  }
  const plans = (req: Request) => {
    if (!deps.prompts) throw unavailable('The immutable prompt registry is not enabled for this deployment.')
    return new QcPlanService(service(req), deps.prompts)
  }
  async function authorize(req: Request, write = false): Promise<{ caller: QcCaller; writable: boolean }> {
    const principal = getPrincipal(req), workspaceId = param(req, 'workspaceId')
    const role = await deps.repository.authorizeWorkspaceMembership(principal, workspaceId)
    const applicationAdmin = isApplicationAdmin(principal, deps.config)
    if (!workspaceCanReview(role, applicationAdmin)) throw forbidden('Your workspace role does not grant QC access.')
    const { metadata } = await deps.repository.getWorkspaceMetadata(principal, workspaceId)
    const pending = metadata.lifecycleOperation && metadata.lifecycleOperation.status !== 'complete'
    if (metadata.deletedAt || pending && metadata.lifecycleOperation!.action === 'delete') throw notFound('This workspace is being removed.')
    const writable = !metadata.archivedAt && !pending
    if (write && !writable) throw conflict('This workspace is archived or has a pending lifecycle action. QC is read-only.')
    return {
      caller: { workspaceId, actor: { principalId: principal.principalKey, name: principal.name.slice(0, 300) }, role, applicationAdmin },
      writable,
    }
  }
  async function authorizePublication(req: Request): Promise<void> {
    const access = await authorize(req, true)
    assertAdmission()
    if (!access.caller.applicationAdmin) throw forbidden('Application-administrator access is required to publish prompt changes.')
  }
  const middleware: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store')
    try {
      // Reading a plan can record peer exposure. Cross-site navigations must not create false independence audits.
      if (req.header('Sec-Fetch-Site') === 'cross-site' || req.header('Origin') && req.header('Origin') !== deps.config.appOrigin) {
        throw forbidden('QC evidence is available only from this application origin.')
      }
      await authorize(req)
      next()
    } catch (error) { next(error) }
  }
  const read = (callback: (req: Request, caller: QcCaller, writable: boolean) => Promise<unknown>): RequestHandler =>
    async (req, res) => {
      const access = await authorize(req)
      const value = await callback(req, access.caller, access.writable)
      await authorize(req)
      if (!req.aborted && !res.destroyed) send(res, value)
    }
  const lease = (
    write: boolean, callback: (req: Request, caller: QcCaller) => Promise<unknown>, status = 200, admit = write,
  ): RequestHandler => async (req, res) => {
    await authorize(req, write)
    if (admit) assertAdmission()
    try {
      const value = await withWorkspaceMutationLease(deps.state, param(req, 'workspaceId'), async () => {
        const access = await authorize(req, write)
        if (admit) assertAdmission()
        const result = await callback(req, access.caller)
        await authorize(req, write)
        return result
      })
      if (!req.aborted && !res.destroyed) send(res, value, status)
    } catch (error) {
      if (error instanceof StoreConflictError) throw conflict('QC changed or its workspace lease expired. Reload and retry the same request key.')
      throw error
    }
  }
  const key = (req: Request) => qcRequestKey(req.header('Idempotency-Key'))
  const empty = (req: Request) => qcInput(z.strictObject({}), body(req))
  const noQuery = (req: Request) => query(req, [])
  router.use(base, middleware)
  router.get(`${base}/capabilities`, read(async (req, caller, writable) => {
    noQuery(req)
    if (!deps.qc || !deps.analyses) return {
      reviews: false, improvements: false, admissionEnabled: false, applicationAdmin: caller.applicationAdmin,
      coordinator: caller.role === 'owner' || caller.role === 'editor' || caller.applicationAdmin,
      writable: false, message: 'QC is not enabled for this deployment.',
    }
    return service(req).capabilities(caller, writable, admissionEnabled())
  }))
  router.get(`${base}/context`, read(async (req, caller, writable) => {
    query(req, ['runId', 'comparisonId', 'resultRevision'])
    const result = await service(req).context(caller, stringQuery(req, 'runId')!, stringQuery(req, 'comparisonId')!,
      stringQuery(req, 'resultRevision', false))
    return { ...result, writable: writable && result.writable }
  }))
  for (const submit of [false, true]) {
    const handler = lease(true, async (req, caller) => {
      noQuery(req)
      return service(req).saveReview(caller, body(req), key(req), exactMatch(req, false), submit, req.header('If-None-Match') === '*')
    })
    if (submit) router.post(`${base}/reviews/submit`, handler)
    else router.put(`${base}/reviews`, handler)
  }
  router.get(`${base}/reviews/history`, read(async (req, caller) => {
    query(req, ['runId', 'comparisonId', 'resultRevision', 'resultSha256', 'limit', 'continuationToken'])
    const scope = qcInput(qcComparisonRefSchema, {
      runId: stringQuery(req, 'runId'), comparisonId: stringQuery(req, 'comparisonId'),
      resultRevision: stringQuery(req, 'resultRevision'), resultSha256: stringQuery(req, 'resultSha256'),
    })
    return service(req).reviewHistory(caller, scope, page(req))
  }))
  router.post(`${base}/peers`, lease(false, async (req, caller) => {
    query(req, ['limit', 'continuationToken'])
    return service(req).peers(caller, body(req), key(req), page(req))
  }))
  router.get(`${base}/batches`, read(async (req, caller) => {
    query(req, ['limit', 'continuationToken'])
    return service(req).batches(caller, page(req))
  }))
  router.post(`${base}/batches`, lease(true, async (req, caller) => {
    noQuery(req)
    exactMatch(req, false)
    return service(req).createBatch(caller, body(req), key(req))
  }))
  router.get(`${base}/prompts`, read(async (req, caller) => { noQuery(req); return plans(req).promptSet(caller) }))
  router.get(`${base}/prompts/history`, read(async (req, caller) => {
    query(req, ['limit', 'continuationToken'])
    const options = page(req)
    return plans(req).promptHistory(caller, options.limit, options.continuationToken)
  }))
  router.post(`${base}/prompts/restore`, lease(true, async (req, caller) => {
    noQuery(req)
    return plans(req).restore(caller, getPrincipal(req), qcInput(qcRestoreInputSchema, body(req)), key(req), exactMatch(req),
      () => authorizePublication(req))
  }))
  router.get(`${base}/plans`, lease(false, async (req, caller) => {
    query(req, ['limit', 'continuationToken'])
    return plans(req).list(caller, page(req))
  }))
  router.post(`${base}/plans`, lease(true, async (req, caller) => {
    noQuery(req)
    exactMatch(req, false)
    return plans(req).create(caller, body(req), key(req))
  }))
  router.get(`${base}/plans/:id`, lease(false, async (req, caller) => {
    noQuery(req)
    return planDetail(plans(req).detail(caller, param(req, 'id')))
  }))
  router.get(`${base}/plans/:id/history`, lease(false, async (req, caller) => {
    query(req, ['limit', 'continuationToken'])
    return plans(req).history(caller, param(req, 'id'), page(req))
  }))
  router.put(`${base}/plans/:id`, lease(true, async (req, caller) => {
    noQuery(req)
    return plans(req).edit(caller, param(req, 'id'), body(req), key(req), exactMatch(req))
  }))
  router.post(`${base}/plans/:id/draft`, lease(true, async (req, caller) => {
    noQuery(req); empty(req)
    return plans(req).request(caller, param(req, 'id'), 'plan', key(req), exactMatch(req))
  }, 202))
  router.post(`${base}/plans/:id/evaluate`, lease(true, async (req, caller) => {
    noQuery(req); qcInput(z.strictObject({ confirmPaidWork: z.literal(true) }), body(req))
    return plans(req).request(caller, param(req, 'id'), 'evaluation', key(req), exactMatch(req))
  }, 202))
  for (const action of ['cancel', 'retry'] as const) router.post(`${base}/plans/:id/${action}`, lease(true, async (req, caller) => {
    noQuery(req); empty(req)
    return planDetail(plans(req)[action](caller, param(req, 'id'), key(req), exactMatch(req)))
  }, 200, action !== 'cancel'))
  router.post(`${base}/plans/:id/activate`, lease(true, async (req, caller) => {
    noQuery(req)
    return plans(req).activate(caller, getPrincipal(req), param(req, 'id'), qcInput(qcReasonInputSchema, body(req)), key(req), exactMatch(req),
      () => authorizePublication(req))
  }))
  return router
}
