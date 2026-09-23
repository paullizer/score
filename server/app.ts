import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { HttpError, forbidden, gone, invalidRequest, notFound, toCloudApiError, unavailable } from './errors'
import { createHealthCheck } from './health'
import { createAuthMiddleware, createCsrfMiddleware } from './middleware'
import { getPrincipal } from './request-context'
import { WorkspaceRepository } from './repository'
import { createWorkspaceMembersRouter } from './members/routes'
import { getWorkspaceCounts } from './workspace-summary'
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
import type { PromptRegistryService } from './settings/prompts'
import type { QcDeps } from './qc/store'
import { createQcRouter } from './qc/routes'
import { createQcLifecycleParticipant, createQcRunLifecycleHooks } from './qc/lifecycle'
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
import type { AssistModelInvoker } from './assist/types'
import type { AssistLimiter } from './assist/limits'
export { WorkspaceRepository } from './repository'
export { WorkspaceLifecycleService } from './lifecycle/service'
export { createLifecycleDependencies } from './lifecycle/dependencies'
export { StoreConflictError, StoreNotFoundError } from './store'
export { createStateStoreFromContainer } from './azure-state-store'
export { createDirectoryStoreFromContainer } from './azure-directory-store'
export { createJobStoreFromContainer, createJobBlobStoreFromContainer } from './jobs/azure-store'
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
export { PromptRegistryService, createPromptRegistryService, createCompiledPromptBaseline } from './settings/prompts'
export { createAzurePromptStore, createAzurePromptReader, createPromptStoreFromContainer } from './settings/prompt-azure-store'
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
export { runAssist, AssistCancelledError } from './assist/runner'
export { createAssistLimiter } from './assist/limits'
export type { AssistLimiter } from './assist/limits'
export type { AssistModelInvoker } from './assist/types'
export { createAzureAssistModelInvoker } from './assist/model'
export { tooManyRequests } from './errors'
export { JOB_RUBRIC_ASSIST_SYSTEM_PROMPT, JOB_RUBRIC_COMPILED_PROMPT, jobRubricAssistProfile, rubricAssistResponseSchema } from './assist/profiles/job-rubric'

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
  readonly prompts?: PromptRegistryService
  readonly qc?: QcDeps
  readonly assist?: { readonly invoke: AssistModelInvoker; readonly limiter: AssistLimiter }
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
  const qc = deps.qc
  const unavailableQc = async (): Promise<never> => {
    throw unavailable('QC storage is unavailable. Analysis lifecycle cleanup cannot skip its private feedback and case packs.')
  }
  const qcLifecycle: RealAnalysesDeps['qcLifecycle'] = qc ? createQcRunLifecycleHooks(qc)
    : config.qc ? { setRunState: unavailableQc, purgeRun: unavailableQc } : undefined
  const analysisStorage = deps.analyses
    ? { ...deps.analyses, ...(qcLifecycle ? { qcLifecycle } : {}) } : undefined
  const participants: WorkspaceLifecycleParticipant[] = []
  if (qc) participants.push(createQcLifecycleParticipant(qc))
  else if (config.qc) participants.push(unavailableParticipant('QC'))
  if (analysisStorage) participants.push(createAnalysisLifecycleParticipant(analysisStorage))
  else if (config.realAnalyses || config.analysisLifecycleStore) participants.push(unavailableParticipant('Analysis'))
  if (deps.resumes) participants.push(createResumeLifecycleParticipant(deps.resumes))
  else if (config.realResumes || config.resumeLifecycleStore) participants.push(unavailableParticipant('Resume'))
  if (deps.grades) participants.push(createGradeLifecycleParticipant(deps.grades))
  else if (config.realGrades || config.gradeLifecycleStore) participants.push(unavailableParticipant('Grade'))
  if (deps.jobs) participants.push(createJobLifecycleParticipant(deps.jobs))
  else if (config.realJobs || config.jobLifecycleStore) participants.push(unavailableParticipant('Job'))
  const lifecycle = createLifecycleDependencies(deps.jobs, deps.grades, Boolean(config.realGrades || config.gradeLifecycleStore),
    analysisStorage, Boolean(config.realAnalyses || config.analysisLifecycleStore))
  const workspaceLifecycle = new WorkspaceLifecycleService({ repository, directory, state, participants, lifecycle, now: deps.now })
  const checkHealth = createHealthCheck({ directory, state })
  const jobs = config.realJobs && deps.jobs?.store && deps.jobs.blobs ? deps.jobs : undefined
  const grades = config.realGrades && deps.grades?.store && deps.grades.blobs ? deps.grades : undefined
  const resumes = config.realResumes && deps.resumes?.store && deps.resumes.blobs ? deps.resumes : undefined
  const analyses = config.realAnalyses && analysisStorage?.store && analysisStorage.blobs
    ? { ...analysisStorage, evidenceCorrectionsEnabled: config.realAnalyses.evidenceCorrectionsEnabled === true } : undefined
  const canCreateAnalyses = Boolean(analyses && resumes && (jobs || grades))
  const wordDocumentImports = config.wordDocumentImports === true
  const assist = config.rubricAssistant && jobs && deps.assist ? deps.assist : undefined

  const app = express()
  app.locals.reconcileLifecycle = () => workspaceLifecycle.reconcile()
  app.locals.bootstrapSettings = async () => {
    const [settings] = await Promise.all([deps.settings?.current(), deps.prompts?.current()])
    return settings
  }
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
  api.use(createWorkspaceMembersRouter({ repository, directory, config, eligibleUsers: deps.eligibleUsers, now: deps.now }))
  api.use(createQcRouter({ repository, state, config, qc, analyses: analysisStorage, prompts: deps.prompts, now: deps.now }))
  api.use(createAccessRouter(creationAccess, workspaceAccess, deps.eligibleUsers))
  api.get('/features', async (req, res) => {
    const snapshot = await getAdmissionSettings(req)
    res.json(effectiveFeatures({
      realJobImports: Boolean(jobs), realGradeLadders: Boolean(grades), realResumeImports: Boolean(resumes),
      realAnalyses: canCreateAnalyses, analysisSummaryGeneration: Boolean(analyses),
      analysisEvidenceCorrections: Boolean(analyses?.evidenceCorrectionsEnabled),
      wordDocumentImports: wordDocumentImports && Boolean(jobs || resumes), rubricAssistant: Boolean(assist),
    }, snapshot, config.settings?.runtimeEnabled === true, Boolean(config.settings || deps.settings)))
  })
  api.use(createRealJobsRouter({ repository, jobs, lifecycle, now: deps.now, wordDocumentImports, assist }))
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

  api.get('/workspaces/:id/summary', async (req, res) => {
    res.json(await getWorkspaceCounts({
      repository, jobs: deps.jobs?.store, resumes: deps.resumes?.store, analyses: deps.analyses?.store,
    }, getPrincipal(req), req.params.id))
  })

  api.get('/workspaces/:id/lifecycle', async (req, res) => {
    res.json(await workspaceLifecycle.impact(getPrincipal(req), req.params.id))
  })

  api.post('/workspaces/:id/lifecycle', async (req, res) => {
    const action = pickAllowedField(req.body, 'action', ['action'])
    const result = await workspaceLifecycle.change(getPrincipal(req), req.params.id, action, readIfMatch(req))
    res.status(result.operation && result.operation.status !== 'complete' ? 202 : 200).json(result)
  })

  // Retired sample-state endpoints. Stale browser tabs from older releases get an explicit reload
  // instruction; no authorization lookup or storage access happens here.
  const retiredWorkspaceState = (_req: Request, res: Response) => {
    res.status(410).json(toCloudApiError(gone('This version of Score is out of date. Reload the page.')))
  }
  api.get('/workspaces/:id/state', retiredWorkspaceState)
  api.put('/workspaces/:id/state', retiredWorkspaceState)

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
      if (err.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterSeconds))))
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
