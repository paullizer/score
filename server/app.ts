import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { HttpError, invalidRequest, notFound, toCloudApiError, unavailable } from './errors'
import { createHealthCheck } from './health'
import { createAuthMiddleware, createCsrfMiddleware } from './middleware'
import { getPrincipal } from './request-context'
import { WorkspaceRepository } from './repository'
import { mountStaticSpa } from './static'
import type { Config } from './config'
import { createRealJobsRouter, type RealJobsDeps } from './jobs/routes'
import { createRealGradesRouter, type RealGradesDeps } from './grades/routes'
import { JOB_IMPORT_LIMITS } from '../src/domain/real-jobs'
import { GRADE_LADDER_LIMITS } from '../src/domain/real-grades'
import type { DirectoryStore, StateStore } from './store'
import { createLifecycleDependencies } from './lifecycle/dependencies'
import { WorkspaceLifecycleService } from './lifecycle/service'
import type { WorkspaceLifecycleParticipant } from './lifecycle/contracts'
import { createJobLifecycleParticipant } from './jobs/lifecycle'
import { createGradeLifecycleParticipant } from './grades/lifecycle'
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
export { ConfigError, loadConfig } from './config'
export { defaultPersonalWorkspaceId, isValidWorkspaceId, membershipIdFor, principalKeyFor } from './ids'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST_DIR = path.join(currentDir, '..', 'dist')
const MAX_JSON_BODY = '10mb'

export interface AppDeps {
  readonly config: Config
  readonly directory: DirectoryStore
  readonly state: StateStore
  readonly jobs?: RealJobsDeps
  readonly grades?: RealGradesDeps
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
  const participants: WorkspaceLifecycleParticipant[] = []
  if (deps.grades) participants.push(createGradeLifecycleParticipant(deps.grades))
  else if (config.realGrades || config.gradeLifecycleStore) participants.push(unavailableParticipant('Grade'))
  if (deps.jobs) participants.push(createJobLifecycleParticipant(deps.jobs))
  else if (config.realJobs || config.jobLifecycleStore) participants.push(unavailableParticipant('Job'))
  const lifecycle = createLifecycleDependencies(state, deps.jobs, deps.grades, Boolean(config.realGrades || config.gradeLifecycleStore))
  const workspaceLifecycle = new WorkspaceLifecycleService({ repository, directory, state, participants, now: deps.now })
  const checkHealth = createHealthCheck({ directory, state })

  const app = express()
  app.locals.reconcileLifecycle = () => workspaceLifecycle.reconcile()
  app.disable('x-powered-by')
  app.use(express.json({ limit: MAX_JSON_BODY }))

  app.get('/healthz', noStore, async (_req, res) => {
    const status = await checkHealth()
    res.status(status === 'ready' ? 200 : 503).json({ status })
  })

  const api = express.Router()
  api.use(noStore)
  api.use(createAuthMiddleware(config))
  api.use(createCsrfMiddleware(config))
  api.get('/features', (_req, res) => {
    res.json({
      realJobImports: Boolean(config.realJobs && deps.jobs), limits: JOB_IMPORT_LIMITS,
      realGradeLadders: Boolean(config.realGrades && deps.grades), gradeLimits: GRADE_LADDER_LIMITS,
    })
  })
  api.use(createRealJobsRouter({ repository, jobs: config.realJobs ? deps.jobs : undefined, lifecycle, now: deps.now }))
  api.use(createRealGradesRouter({
    repository, grades: config.realGrades ? deps.grades : undefined,
    jobs: config.realJobs ? deps.jobs : undefined, lifecycle, now: deps.now,
  }))

  api.get('/session', async (req, res) => {
    res.json(await repository.getSession(getPrincipal(req)))
  })

  api.get('/workspaces', async (req, res) => {
    res.json({ workspaces: await repository.listWorkspaces(getPrincipal(req)) })
  })

  api.post('/workspaces', async (req, res) => {
    const name = pickAllowedField(req.body, 'name', ['name'])
    const workspace = await repository.createWorkspace(getPrincipal(req), name)
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
  app.use(createAuthMiddleware(config))
  mountStaticSpa(app, distDir)

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
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
      name: err instanceof Error ? err.name : 'UnknownError',
      method: req.method,
      path: req.path,
    })
    res.status(503).json(toCloudApiError(unavailable()))
  })

  return app
}
