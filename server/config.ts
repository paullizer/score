import { GUID_PATTERN } from './ids'
import type { RealJobsConfig } from './jobs/store'
import type { RealGradesConfig } from './grades/store'
import type { RealResumesConfig } from './resumes/store'
import type { RealAnalysesConfig } from './analyses/store'
import type { SettingsConfig } from './settings/store'
import { z } from 'zod'
import { createDefaultAdminSettings, MODEL_TASK_IDS, parseAdminSettings, RUNTIME_SETTINGS_VERSION, SettingsValidationError } from '../src/domain/admin-settings'
import type { ProcessingKind, ReasoningEffort, RuntimeSettingsWorkerVerification, WorkerPolicy } from '../src/domain/admin-settings'

/**
 * Server configuration, loaded once from environment variables. Every default here is
 * fail-closed: a missing or malformed value throws rather than silently falling back to an
 * insecure default (e.g. "no allowed users" or "no tenant restriction").
 */
export type AuthMode = 'easyauth' | 'dev-header'

export interface CosmosConfig {
  readonly endpoint: string
  readonly database: string
  readonly container: string
}

export interface StorageConfig {
  readonly accountUrl: string
  readonly containerName: string
}

export interface Config {
  readonly authMode: AuthMode
  readonly tenantId: string
  readonly allowedUserIds: ReadonlySet<string>
  readonly adminUserIds?: ReadonlySet<string>
  readonly settings?: SettingsConfig
  readonly managedIdentityClientId: string | undefined
  readonly cosmos: CosmosConfig
  readonly storage: StorageConfig
  readonly realJobs: RealJobsConfig | undefined
  readonly realGrades?: RealGradesConfig
  readonly jobLifecycleStore?: RealJobsConfig
  readonly gradeLifecycleStore?: RealGradesConfig
  readonly resumeLifecycleStore?: RealResumesConfig
  readonly analysisLifecycleStore?: RealAnalysesConfig
  readonly realResumes?: RealResumesConfig
  readonly realAnalyses?: RealAnalysesConfig
  readonly wordDocumentImports: boolean
  readonly appOrigin: string
  readonly isProduction: boolean
  readonly isAppService: boolean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`Missing required environment variable ${name}.`)
  }
  return value.trim()
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function featureEnabled(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = optional(env, name)
  if (value !== undefined && value !== 'true' && value !== 'false') {
    throw new ConfigError(`${name} must be true or false.`)
  }
  return value === 'true'
}

function requireSeparateContainers(containers: readonly (readonly [string, string])[]): void {
  const names = new Map<string, string>()
  for (const [setting, name] of containers) {
    const other = names.get(name)
    if (other) throw new ConfigError(`${setting} must be separate from ${other}.`)
    names.set(name, setting)
  }
}

function requireGuid(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  if (!GUID_PATTERN.test(value)) throw new ConfigError(`${name} must be a GUID.`)
  return value.toLowerCase()
}

function parseAllowedUserIds(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = required(env, 'SCORE_ALLOWED_USER_IDS')
  const ids = raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
  if (ids.length === 0) throw new ConfigError('SCORE_ALLOWED_USER_IDS must list at least one Entra object ID.')
  for (const id of ids) {
    if (!GUID_PATTERN.test(id)) throw new ConfigError(`SCORE_ALLOWED_USER_IDS contains a value that is not a GUID: ${id}.`)
  }
  return new Set(ids.map((id) => id.toLowerCase()))
}

function parseAdminUserIds(env: NodeJS.ProcessEnv, allowed: ReadonlySet<string>): ReadonlySet<string> {
  const raw = optional(env, 'SCORE_ADMIN_USER_IDS')
  if (!raw) return new Set()
  const ids = raw.split(',').map(value => value.trim().toLowerCase())
  if (ids.some(id => !GUID_PATTERN.test(id))) throw new ConfigError('SCORE_ADMIN_USER_IDS must contain only Entra object-ID GUIDs.')
  if (ids.some(id => !allowed.has(id))) throw new ConfigError('Every SCORE_ADMIN_USER_IDS entry must also be an explicitly permitted sign-in identity.')
  return new Set(ids)
}

function azureModelEndpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ConfigError('RUBRIC_MODEL_ENDPOINT must be an Azure HTTPS service-root endpoint.') }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.openai.azure.com') || url.username || url.password ||
    (url.port && url.port !== '443') || url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('RUBRIC_MODEL_ENDPOINT must be one Azure OpenAI HTTPS root endpoint without credentials, path, query or fragment.')
  }
  return url.origin
}

function workerVerification(env: NodeJS.ProcessEnv): RuntimeSettingsWorkerVerification | undefined {
  const workerVersion = optional(env, 'SCORE_RUNTIME_SETTINGS_WORKER_VERSION')
  const image = optional(env, 'SCORE_RUNTIME_SETTINGS_VERIFIED_IMAGE')
  const verifiedAt = optional(env, 'SCORE_RUNTIME_SETTINGS_VERIFIED_AT')
  if (!workerVersion && !image && !verifiedAt) return undefined
  if (!workerVersion || !image || !verifiedAt) {
    throw new ConfigError('Runtime-settings worker version, verified image and verified timestamp must be supplied together or all cleared.')
  }
  if (workerVersion !== RUNTIME_SETTINGS_VERSION) {
    throw new ConfigError('SCORE_RUNTIME_SETTINGS_WORKER_VERSION must match this API runtime-settings contract.')
  }
  if (image.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9.-]*\/[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-fA-F0-9]{64})?$/.test(image)) {
    throw new ConfigError('SCORE_RUNTIME_SETTINGS_VERIFIED_IMAGE must be a nonsecret registry image reference, not a URL or credential.')
  }
  if (!z.iso.datetime({ offset: true }).safeParse(verifiedAt).success) {
    throw new ConfigError('SCORE_RUNTIME_SETTINGS_VERIFIED_AT must be an ISO timestamp.')
  }
  return { workerVersion, image, verifiedAt, verificationTimeOnly: true, liveHealth: false }
}

function settingsConfiguration(env: NodeJS.ProcessEnv, cosmos: CosmosConfig): SettingsConfig | undefined {
  const runtimeEnabled = featureEnabled(env, 'SCORE_RUNTIME_SETTINGS_ENABLED')
  const container = optional(env, 'SCORE_SETTINGS_CONTAINER')
  if (!container) {
    if (runtimeEnabled) throw new ConfigError('SCORE_SETTINGS_CONTAINER is required before activating runtime settings.')
    return undefined
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(container)) throw new ConfigError('SCORE_SETTINGS_CONTAINER must be a valid dedicated container name.')
  const endpointValue = optional(env, 'RUBRIC_MODEL_ENDPOINT')
  const deploymentName = optional(env, 'RUBRIC_MODEL_DEPLOYMENT')
  const modelName = optional(env, 'RUBRIC_MODEL_NAME')
  const resourceId = optional(env, 'SCORE_MODEL_RESOURCE_ID')
  const reasoning = optional(env, 'RUBRIC_MODEL_REASONING_EFFORT')
  if ((endpointValue || deploymentName || modelName || reasoning || resourceId || runtimeEnabled) && !(endpointValue && deploymentName && modelName)) {
    throw new ConfigError('Settings model configuration requires RUBRIC_MODEL_ENDPOINT, RUBRIC_MODEL_DEPLOYMENT and RUBRIC_MODEL_NAME together.')
  }
  if (deploymentName && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deploymentName)) throw new ConfigError('RUBRIC_MODEL_DEPLOYMENT must be an exact Azure deployment identifier.')
  if (reasoning && !['minimal', 'low', 'medium', 'high'].includes(reasoning)) throw new ConfigError('RUBRIC_MODEL_REASONING_EFFORT is unsupported.')
  if (resourceId && (!/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[A-Za-z0-9-]+$/i.test(resourceId) ||
    !GUID_PATTERN.test(resourceId.split('/')[2] ?? ''))) {
    throw new ConfigError('SCORE_MODEL_RESOURCE_ID must identify exactly one Azure Cognitive Services account.')
  }
  const workers: Partial<Record<ProcessingKind, Partial<WorkerPolicy>>> = {}
  const defaultSources: Record<string, string> = {}
  for (const [kind, itemsKey, budgetKey, max] of [
    ['jobs', 'WORKER_MAX_JOBS', 'WORKER_BUDGET_MS', 20],
    ['grades', 'GRADE_WORKER_MAX_ITEMS', 'GRADE_WORKER_BUDGET_MS', 20],
    ['resumes', 'RESUME_WORKER_MAX_ITEMS', 'RESUME_WORKER_BUDGET_MS', 20],
    ['analyses', 'ANALYSIS_WORKER_MAX_ITEMS', 'ANALYSIS_WORKER_BUDGET_MS', 100],
  ] as const) {
    const items = optional(env, itemsKey)
    const budget = optional(env, budgetKey)
    if (items && (!Number.isSafeInteger(Number(items)) || Number(items) < 1 || Number(items) > max)) throw new ConfigError(`${itemsKey} must be an integer from 1 to ${max}.`)
    if (budget && (!Number.isSafeInteger(Number(budget)) || Number(budget) < 1000 || Number(budget) > 660_000)) throw new ConfigError(`${budgetKey} must be an integer from 1000 to 660000.`)
    workers[kind] = { ...(items ? { maxItemsPerExecution: Number(items) } : {}), ...(budget ? { budgetMilliseconds: Number(budget) } : {}) }
    if (items) defaultSources[`workers.${kind}.maxItemsPerExecution`] = itemsKey
    if (budget) defaultSources[`workers.${kind}.budgetMilliseconds`] = budgetKey
  }
  if (deploymentName && modelName) {
    defaultSources['ai.deployments'] = 'RUBRIC_MODEL_DEPLOYMENT / RUBRIC_MODEL_NAME'
    for (const task of MODEL_TASK_IDS) defaultSources[`ai.tasks.${task}.reasoningEffort`] =
      reasoning ? 'RUBRIC_MODEL_REASONING_EFFORT' : 'RUBRIC_MODEL_REASONING_EFFORT (unset: omit parameter)'
  }
  const defaults = createDefaultAdminSettings({
    ...(deploymentName && modelName ? { model: { deploymentName, modelName, reasoningEffort: reasoning as ReasoningEffort | undefined } } : {}),
    workers,
  })
  try { parseAdminSettings(defaults) } catch (error) {
    if (error instanceof SettingsValidationError) {
      throw new ConfigError('The configured settings baseline is incompatible with Score task budgets or supported Azure model capabilities.')
    }
    throw error
  }
  return {
    cosmosEndpoint: cosmos.endpoint, database: cosmos.database, container, applicationId: 'score', runtimeEnabled, defaults, defaultSources,
    workerVerification: workerVerification(env),
    ...(endpointValue && deploymentName && modelName ? {
      model: { endpoint: azureModelEndpoint(endpointValue), deploymentName, modelName, ...(resourceId ? { resourceId } : {}) },
    } : {}),
  }
}

function requireHttpsOrigin(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} must be a valid URL.`)
  }
  if (url.protocol !== 'https:') throw new ConfigError(`${name} must use https.`)
  if (url.pathname !== '/' && url.pathname !== '') throw new ConfigError(`${name} must not include a path.`)
  return url.origin
}

function requireUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  try {
    return new URL(value).toString()
  } catch {
    throw new ConfigError(`${name} must be a valid URL.`)
  }
}

/** App Service sets one of these for every deployed site; used to fail closed on dev auth outside App Service too. */
function detectAppService(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WEBSITE_INSTANCE_ID || env.WEBSITE_SITE_NAME)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production'
  const isAppService = detectAppService(env)
  const authModeRaw = optional(env, 'SCORE_AUTH_MODE') ?? 'easyauth'
  if (authModeRaw !== 'easyauth' && authModeRaw !== 'dev-header') {
    throw new ConfigError("SCORE_AUTH_MODE must be 'easyauth' or 'dev-header'.")
  }
  const authMode: AuthMode = authModeRaw
  if (authMode === 'dev-header' && (isProduction || isAppService)) {
    throw new ConfigError('SCORE_AUTH_MODE=dev-header is prohibited in production or on App Service.')
  }

  const cosmos: CosmosConfig = {
    endpoint: requireUrl(env, 'COSMOS_ENDPOINT'),
    database: optional(env, 'COSMOS_DATABASE') ?? 'score',
    container: optional(env, 'COSMOS_CONTAINER') ?? 'workspaces',
  }
  const storage: StorageConfig = {
    accountUrl: requireUrl(env, 'STORAGE_ACCOUNT_URL'),
    containerName: optional(env, 'WORKSPACE_BLOB_CONTAINER') ?? 'workspace-state',
  }
  const jobsEnabled = featureEnabled(env, 'REAL_JOB_IMPORTS_ENABLED')
  const gradesEnabled = featureEnabled(env, 'REAL_GRADE_LADDERS_ENABLED')
  const resumesEnabled = featureEnabled(env, 'REAL_RESUME_IMPORTS_ENABLED')
  const analysesEnabled = featureEnabled(env, 'REAL_ANALYSES_ENABLED')
  const wordDocumentImports = featureEnabled(env, 'WORD_DOCUMENT_IMPORTS_ENABLED')
  const jobRecords = jobsEnabled ? required(env, 'JOB_RECORDS_CONTAINER') : optional(env, 'JOB_RECORDS_CONTAINER') ?? 'job-records'
  const jobSources = jobsEnabled ? required(env, 'JOB_SOURCE_CONTAINER') : optional(env, 'JOB_SOURCE_CONTAINER') ?? 'job-sources'
  const gradeRecords = optional(env, 'GRADE_RECORDS_CONTAINER') ?? 'grade-records'
  const gradeSources = optional(env, 'GRADE_SOURCE_CONTAINER') ?? 'grade-sources'
  const resumeRecords = optional(env, 'RESUME_RECORDS_CONTAINER') ?? 'resume-records'
  const resumeSources = optional(env, 'RESUME_SOURCE_CONTAINER') ?? 'resume-sources'
  const analysisRecords = optional(env, 'ANALYSIS_RECORDS_CONTAINER') ?? 'analysis-records'
  const analysisSources = optional(env, 'ANALYSIS_SOURCE_CONTAINER') ?? 'analysis-sources'
  const settings = settingsConfiguration(env, cosmos)

  // Reserve inactive stores too: enabling another feature must never expose an aliased store.
  requireSeparateContainers([
    ['COSMOS_CONTAINER', cosmos.container], ['JOB_RECORDS_CONTAINER', jobRecords],
    ['GRADE_RECORDS_CONTAINER', gradeRecords], ['RESUME_RECORDS_CONTAINER', resumeRecords],
    ['ANALYSIS_RECORDS_CONTAINER', analysisRecords],
    ['SCORE_SETTINGS_CONTAINER', settings?.container ?? 'application-settings'],
  ])
  requireSeparateContainers([
    ['WORKSPACE_BLOB_CONTAINER', storage.containerName], ['JOB_SOURCE_CONTAINER', jobSources],
    ['GRADE_SOURCE_CONTAINER', gradeSources], ['RESUME_SOURCE_CONTAINER', resumeSources],
    ['ANALYSIS_SOURCE_CONTAINER', analysisSources],
  ])
  const shared = {
    cosmosEndpoint: cosmos.endpoint, database: cosmos.database, storageAccountUrl: storage.accountUrl,
  }
  const realJobs: RealJobsConfig | undefined = jobsEnabled
    ? { ...shared, container: jobRecords, blobContainer: jobSources } : undefined
  const realGrades: RealGradesConfig | undefined = gradesEnabled
    ? { ...shared, container: gradeRecords, blobContainer: gradeSources } : undefined
  const realResumes: RealResumesConfig | undefined = resumesEnabled
    ? { ...shared, container: resumeRecords, blobContainer: resumeSources } : undefined
  const realAnalyses: RealAnalysesConfig | undefined = analysesEnabled
    ? { ...shared, container: analysisRecords, blobContainer: analysisSources } : undefined

  const configuredJobRecords = optional(env, 'JOB_RECORDS_CONTAINER')
  const configuredJobSources = optional(env, 'JOB_SOURCE_CONTAINER')
  if (Boolean(configuredJobRecords) !== Boolean(configuredJobSources)) {
    throw new ConfigError('Both job storage containers must be configured so lifecycle cleanup cannot skip existing data.')
  }
  const jobLifecycleStore = realJobs ?? (configuredJobRecords && configuredJobSources ? {
    ...shared, container: jobRecords, blobContainer: jobSources,
  } : undefined)
  const gradeLifecycleStore = realGrades ?? (optional(env, 'GRADE_RECORDS_CONTAINER') || optional(env, 'GRADE_SOURCE_CONTAINER') ? {
    ...shared, container: gradeRecords, blobContainer: gradeSources,
  } : undefined)
  const resumeLifecycleStore = realResumes ?? (optional(env, 'RESUME_RECORDS_CONTAINER') || optional(env, 'RESUME_SOURCE_CONTAINER') ? {
    ...shared, container: resumeRecords, blobContainer: resumeSources,
  } : undefined)
  const analysisLifecycleStore = realAnalyses ?? (optional(env, 'ANALYSIS_RECORDS_CONTAINER') || optional(env, 'ANALYSIS_SOURCE_CONTAINER') ? {
    ...shared, container: analysisRecords, blobContainer: analysisSources,
  } : undefined)

  const allowedUserIds = parseAllowedUserIds(env)
  return {
    authMode,
    tenantId: requireGuid(env, 'AZURE_TENANT_ID'),
    allowedUserIds,
    adminUserIds: parseAdminUserIds(env, allowedUserIds),
    settings,
    managedIdentityClientId: optional(env, 'AZURE_CLIENT_ID'),
    cosmos,
    storage,
    realJobs,
    realGrades,
    jobLifecycleStore,
    gradeLifecycleStore,
    resumeLifecycleStore,
    analysisLifecycleStore,
    realResumes,
    realAnalyses,
    wordDocumentImports,
    appOrigin: requireHttpsOrigin(env, 'APP_ORIGIN'),
    isProduction,
    isAppService,
  }
}
