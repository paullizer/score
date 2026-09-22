import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { HttpError, forbidden, invalidRequest, notFound, toCloudApiError, unavailable } from './errors'
import { createHealthCheck } from './health'
import { createAuthMiddleware, createCsrfMiddleware } from './middleware'
import { getPrincipal } from './request-context'
import { WorkspaceRepository } from './repository'
import { mountStaticSpa } from './static'
import type { Config } from './config'
import { createRealJobsRouter, type RealJobsDeps } from './jobs/routes'
import { createRealGradesRouter, type RealGradesDeps } from './grades/routes'
import { createRealResumesRouter } from './resumes/routes'
import { createRealAnalysesRouter } from './analyses/routes'
import type { RealResumesDeps } from './resumes/store'
import type { RealAnalysesDeps } from './analyses/store'
import { isApplicationAdmin } from './auth'
import { createAdminSettingsRouter } from './settings/routes'
import type { AdminSettingsService } from './settings/service'
import { attachSettingsContext, getAdmissionSettings, getCurrentSettings } from './settings/request-context'
import { effectiveFeatures } from './settings/features'
import type { DirectoryStore, StateStore } from './store'
import { createLifecycleDependencies } from './lifecycle/dependencies'
import { WorkspaceLifecycleService } from './lifecycle/service'
import type { WorkspaceLifecycleParticipant } from './lifecycle/contracts'
import { createJobLifecycleParticipant } from './jobs/lifecycle'
import { createGradeLifecycleParticipant } from './grades/lifecycle'
import { createResumeLifecycleParticipant } from './resumes/lifecycle'
import { createAnalysisLifecycleParticipant } from './analyses/library-lifecycle'
import { recordRequestError, telemetryMiddleware, telemetryRequests } from './telemetry-http'
import { errorCategory, safeMethod, safeRoute } from './telemetry-schema'
import { createAccessRouter } from './access/routes'
import { CreationAccessService, WorkspaceAccessService } from './access/service'
import type { AccessStore } from './access/store'
import type { EligibleUserDirectory } from './access/directory'
export { WorkspaceRepository } from './repository'
export { WorkspaceLifecycleService } from './lifecycle/service'
export { createLifecycleDependencies } from './lifecycle/dependencies'
export { applySampleLifecycle } from '../src/domain/lifecycle'
export { createAnalysisRun } from '../src/services/mockWorkspace'
export { StoreConflictError, StoreNotFoundError } from './store'
export { createStateStoreFromContainer } from './azure-state-store'
export { createDirectoryStoreFromContainer } from './azure-directory-store'
export { createJobBlobStoreFromContainer } from './jobs/azure-store'
export {
  createAzureGradeStore, createAzureGradeBlobStore, createGradeStoreFromContainer, createGradeBlobStoreFromContainer,
} from './grades/azure-store'
export {
  parseGradeEntity, validateReferenceDocument, validateGradeVersion, validateGradeApproval,
  gradeContentHash, gradeVersionHash, gradeSourceSetHash, gradeRecordHash, gradeIssuesFor, parseGradeSeedSnapshot,
} from './grades/validation'
export { createRealResumesRouter, createRealAnalysesRouter }
export * from './resumes/azure-store'
export * from './resumes/validation'
export { RealResumeService } from './resumes/service'
export * from './analyses/azure-store'
export * from './analyses/validation'
export * from './analyses/lifecycle'
export * from './analyses/snapshots'
export { RealAnalysisTargets } from './analyses/targets'
export { RealAnalysisService } from './analyses/service'
export { ConfigError, loadConfig } from './config'
export { defaultPersonalWorkspaceId, isValidWorkspaceId, membershipIdFor, principalKeyFor } from './ids'
export { isApplicationAdmin } from './auth'
export { CreationAccessService, WorkspaceAccessService } from './access/service'
export { createAccessStoreFromContainer } from './access/azure-store'
export { AdminSettingsService } from './settings/service'
export { createSettingsStoreFromContainer, createAzureSettingsStore, createSettingsReaderFromContainer, createAzureSettingsReader } from './settings/azure-store'
export { createAzureSettingsModelAdapter } from './settings/models'
export {
  attachSettingsContext, getAdmissionSettings, getCurrentSettings, getPinnedAdmissionSettings,
  getSettingsForAcceptedWork, runtimeSettingsEnabled, assertNewProcessingAllowed, getProcessingAdmissionSettings,
  getRuntimeSettingsReadiness,
} from './settings/request-context'
export { getRequestSettings } from './request-context'
export { effectiveFeatures } from './settings/features'
export * from '../src/domain/admin-settings'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST_DIR = path.join(currentDir, '..', 'dist')
const MAX_JSON_BODY = '10mb'
const RAW_SOURCE_UPLOAD_PATH = /^\/api\/workspaces\/[^/]+\/(?:jobs|resumes)\/(?:pdf|markdown|file)\/?$/i

export interface AppDeps {
  readonly config: Config
  readonly directory: DirectoryStore
  readonly state: StateStore
  readonly jobs?: RealJobsDeps
  readonly grades?: RealGradesDeps
  readonly resumes?: RealResumesDeps
  readonly analyses?: RealAnalysesDeps
  readonly settings?: AdminSettingsService
  readonly accessStore?: AccessStore
  readonly eligibleUsers?: EligibleUserDirectory
  /** Overridable so tests don't depend on a real build of dist/. */
  readonly distDir?: string
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date
}

interface BodyParserError {
  readonly type?: string
  readonly status?: number
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return typeof error === 'object' && error !== null && 'type' in error
}

function readIfMatch(req: Request): string | undefined {
  const header = req.header('if-match')
  return header === undefined || header === '' ? undefined : header
}

/** Rejects any JSON body field outside an explicit allow-list, so clients cannot smuggle in ownership/type overrides. */
function pickAllowedField(body: unknown, field: string, allowedFields: readonly string[]): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidRequest('Request body must be a JSON object.')
  const record = body as Record<string, unknown>
  const unexpected = Object.keys(record).filter((key) => !allowedFields.includes(key))
  if (unexpected.length > 0) throw invalidRequest(`Request body has unexpected field(s): ${unexpected.join(', ')}.`)
  return record[field]
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store')
  next()
}

function unavailableParticipant(name: string): WorkspaceLifecycleParticipant {
  const fail = async (): Promise<never> => { throw unavailable(`${name} storage is unavailable. Workspace lifecycle cleanup cannot skip it.`) }
  return { setState: fail, cancel: fail, purge: fail, counts: fail, pendingWorkspaces: fail, resume: fail }
}

/**
 * Builds the Express app: static SPA serving plus the fixed cloud API. Does not call `listen` —
 * that is server/index.ts's job — so tests can exercise the app in-process or against an ephemeral
 * local server without binding the production port.
 */
export function createApp(deps: AppDeps): Express {
  const { config, directory, state } = deps
  // Defense in depth: even though loadConfig() already refuses to produce a dev-header config in
  // production/App Service, createApp re-checks so this invariant holds regardless of caller.
  if (config.authMode === 'dev-header' && (config.isProduction || config.isAppService)) {
    throw new Error('SCORE_AUTH_MODE=dev-header is prohibited in production or on App Service.')
  }
  const distDir = deps.distDir ?? DEFAULT_DIST_DIR
  const repository = new WorkspaceRepository({ directory, state, now: deps.now })
  const creationAccess = new CreationAccessService(deps.accessStore, deps.eligibleUsers, deps.now)
  const workspaceAccess = new WorkspaceAccessService(repository, directory, deps.eligibleUsers, deps.now)
  const participants: WorkspaceLifecycleParticipant[] = []
  if (deps.analyses) participants.push(createAnalysisLifecycleParticipant(deps.analyses))
  else if (config.realAnalyses || config.analysisLifecycleStore) participants.push(unavailableParticipant('Analysis'))
  if (deps.resumes) participants.push(createResumeLifecycleParticipant(deps.resumes))
  else if (config.realResumes || config.resumeLifecycleStore) participants.push(unavailableParticipant('Resume'))
  if (deps.grades) participants.push(createGradeLifecycleParticipant(deps.grades))
  else if (config.realGrades || config.gradeLifecycleStore) participants.push(unavailableParticipant('Grade'))
  if (deps.jobs) participants.push(createJobLifecycleParticipant(deps.jobs))
  else if (config.realJobs || config.jobLifecycleStore) participants.push(unavailableParticipant('Job'))
  const lifecycle = createLifecycleDependencies(state, deps.jobs, deps.grades, Boolean(config.realGrades || config.gradeLifecycleStore),
    deps.analyses, Boolean(config.realAnalyses || config.analysisLifecycleStore))
  const workspaceLifecycle = new WorkspaceLifecycleService({ repository, directory, state, participants, lifecycle, now: deps.now })
  const checkHealth = createHealthCheck({ directory, state })
  const jobs = config.realJobs && deps.jobs?.store && deps.jobs.blobs ? deps.jobs : undefined
  const grades = config.realGrades && deps.grades?.store && deps.grades.blobs ? deps.grades : undefined
  const resumes = config.realResumes && deps.resumes?.store && deps.resumes.blobs ? deps.resumes : undefined
  const analyses = config.realAnalyses && deps.analyses?.store && deps.analyses.blobs
    ? { ...deps.analyses, evidenceCorrectionsEnabled: config.realAnalyses.evidenceCorrectionsEnabled === true } : undefined
  const canCreateAnalyses = Boolean(analyses && resumes && (jobs || grades))
  const wordDocumentImports = config.wordDocumentImports === true

  const app = express()
  app.locals.reconcileLifecycle = () => workspaceLifecycle.reconcile()
  app.locals.bootstrapSettings = async () => deps.settings?.current()
  app.disable('x-powered-by')
  app.use(telemetryRequests)
  const parseJson = express.json({ limit: MAX_JSON_BODY })
  app.use((req, res, next) => {
    // Even a mislabeled JSON upload must reach authorization before body parsing.
    if (req.method === 'POST' && RAW_SOURCE_UPLOAD_PATH.test(req.path)) next()
    else parseJson(req, res, next)
  })

  app.get('/healthz', noStore, async (_req, res) => {
    const status = await checkHealth()
    if (config.authMode === 'easyauth') res.setHeader('X-Score-Access-Control', 'entra-roles-v1')
    res.status(status === 'ready' ? 200 : 503).json({ status })
  })

  const api = express.Router()
  api.use(noStore)
  api.use(telemetryMiddleware('score.auth', createAuthMiddleware(config)))
  api.use(telemetryMiddleware('score.csrf', createCsrfMiddleware(config)))
  api.use(attachSettingsContext(config, deps.settings))
  api.use(createAdminSettingsRouter(config, deps.settings))
  api.use(createAccessRouter(creationAccess, workspaceAccess, deps.eligibleUsers))
  api.get('/features', async (req, res) => {
    const snapshot = await getAdmissionSettings(req)
    res.json(effectiveFeatures({
      realJobImports: Boolean(jobs), realGradeLadders: Boolean(grades), realResumeImports: Boolean(resumes),
      realAnalyses: canCreateAnalyses, analysisSummaryGeneration: Boolean(analyses),
      analysisEvidenceCorrections: Boolean(analyses?.evidenceCorrectionsEnabled),
      wordDocumentImports: wordDocumentImports && Boolean(jobs || resumes),
    }, snapshot, config.settings?.runtimeEnabled === true, Boolean(config.settings || deps.settings)))
  })
  api.use(createRealJobsRouter({ repository, jobs, lifecycle, now: deps.now, wordDocumentImports }))
  api.use(createRealGradesRouter({ repository, grades, jobs, lifecycle, now: deps.now }))
  api.use(createRealResumesRouter({ repository, resumes, lifecycle, now: deps.now, wordDocumentImports }))
  api.use(createRealAnalysesRouter({ repository, analyses, resumes, jobs, grades, now: deps.now }))

  api.get('/session/identity', async (req, res) => {
    const principal = getPrincipal(req)
    res.json({
      mode: 'cloud',
      user: { id: principal.oid, tenantId: principal.tenantId, name: principal.name, email: principal.email },
      capabilities: {
        applicationAdmin: isApplicationAdmin(principal, config),
        canCreateWorkspaces: await creationAccess.canCreate(principal),
      },
    })
  })
  api.get('/session', async (req, res) => {
    const principal = getPrincipal(req)
    const session = await repository.getSession(principal)
    res.json({ ...session, capabilities: {
      applicationAdmin: isApplicationAdmin(principal, config),
      canCreateWorkspaces: await creationAccess.canCreate(principal),
    } })
  })

  api.get('/workspaces', async (req, res) => {
    res.json({ workspaces: await repository.listWorkspaces(getPrincipal(req)) })
  })

  api.post('/workspaces', async (req, res) => {
    const name = pickAllowedField(req.body, 'name', ['name'])
    if (!(await getCurrentSettings(req)).workspaces.allowCreation) throw forbidden('New workspace creation is disabled by application policy.')
    const principal = getPrincipal(req)
    if (!await creationAccess.canCreate(principal)) throw forbidden('Ask an application administrator for permission to create workspaces.')
    const workspace = await repository.createWorkspace(principal, name)
    res.status(201).json({ workspace })
  })

  api.patch('/workspaces/:id', async (req, res) => {
    const name = pickAllowedField(req.body, 'name', ['name'])
    const workspace = await repository.renameWorkspace(getPrincipal(req), req.params.id, name, readIfMatch(req))
    res.json({ workspace })
  })

  api.get('/workspaces/:id/lifecycle', async (req, res) => {
    res.json(await workspaceLifecycle.impact(getPrincipal(req), req.params.id))
  })

  api.post('/workspaces/:id/lifecycle', async (req, res) => {
    const action = pickAllowedField(req.body, 'action', ['action'])
    const result = await workspaceLifecycle.change(getPrincipal(req), req.params.id, action, readIfMatch(req))
    res.status(result.operation && result.operation.status !== 'complete' ? 202 : 200).json(result)
  })

  api.get('/workspaces/:id/state', async (req, res) => {
    const snapshot = await repository.getWorkspaceState(getPrincipal(req), req.params.id)
    res.setHeader('ETag', snapshot.etag)
    res.json(snapshot)
  })

  api.put('/workspaces/:id/state', async (req, res) => {
    const result = await repository.putWorkspaceState(getPrincipal(req), req.params.id, req.body, readIfMatch(req))
    res.setHeader('ETag', result.etag)
    res.json(result)
  })

  app.use('/api', api)
  // Anything under /api not matched above must still come back as a CloudApiError, never the HTML
  // SPA fallback registered below.
  app.use('/api', (_req, res) => {
    res.status(404).json(toCloudApiError(notFound('Not found.')))
  })

  // Every remaining route (the static SPA shell/assets) also requires a valid principal.
  app.use(telemetryMiddleware('score.auth', createAuthMiddleware(config)))
  mountStaticSpa(app, distDir)

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    recordRequestError(err)
    if (res.headersSent) {
      next(err)
      return
    }
    if (err instanceof HttpError) {
      res.status(err.status).json(toCloudApiError(err))
      return
    }
    if (isBodyParserError(err)) {
      if (err.type === 'entity.too.large') {
        res.status(413).json(toCloudApiError(invalidRequest('The request body is too large. The limit is 10 MB.')))
        return
      }
      if (err.type === 'entity.parse.failed' || err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') {
        res.status(400).json(toCloudApiError(invalidRequest('The request body is not valid JSON.')))
        return
      }
    }
    console.error('Unhandled server error:', {
      category: errorCategory(err),
      method: safeMethod(req.method),
      route: safeRoute(req.originalUrl),
    })
    res.status(503).json(toCloudApiError(unavailable()))
  })

  return app
}
