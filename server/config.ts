import { GUID_PATTERN } from './ids'
import type { RealJobsConfig } from './jobs/store'
import type { RealGradesConfig } from './grades/store'
import type { RealResumesConfig } from './resumes/store'
import type { RealAnalysesConfig } from './analyses/store'

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
  readonly managedIdentityClientId: string | undefined
  readonly cosmos: CosmosConfig
  readonly storage: StorageConfig
  readonly realJobs: RealJobsConfig | undefined
  readonly realGrades?: RealGradesConfig
  readonly realResumes?: RealResumesConfig
  readonly realAnalyses?: RealAnalysesConfig
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
  const jobRecords = jobsEnabled ? required(env, 'JOB_RECORDS_CONTAINER') : optional(env, 'JOB_RECORDS_CONTAINER') ?? 'job-records'
  const jobSources = jobsEnabled ? required(env, 'JOB_SOURCE_CONTAINER') : optional(env, 'JOB_SOURCE_CONTAINER') ?? 'job-sources'
  const gradeRecords = optional(env, 'GRADE_RECORDS_CONTAINER') ?? 'grade-records'
  const gradeSources = optional(env, 'GRADE_SOURCE_CONTAINER') ?? 'grade-sources'
  const resumeRecords = optional(env, 'RESUME_RECORDS_CONTAINER') ?? 'resume-records'
  const resumeSources = optional(env, 'RESUME_SOURCE_CONTAINER') ?? 'resume-sources'
  const analysisRecords = optional(env, 'ANALYSIS_RECORDS_CONTAINER') ?? 'analysis-records'
  const analysisSources = optional(env, 'ANALYSIS_SOURCE_CONTAINER') ?? 'analysis-sources'

  // Reserve inactive stores too: enabling another feature must never expose an aliased store.
  requireSeparateContainers([
    ['COSMOS_CONTAINER', cosmos.container], ['JOB_RECORDS_CONTAINER', jobRecords],
    ['GRADE_RECORDS_CONTAINER', gradeRecords], ['RESUME_RECORDS_CONTAINER', resumeRecords],
    ['ANALYSIS_RECORDS_CONTAINER', analysisRecords],
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

  return {
    authMode,
    tenantId: requireGuid(env, 'AZURE_TENANT_ID'),
    allowedUserIds: parseAllowedUserIds(env),
    managedIdentityClientId: optional(env, 'AZURE_CLIENT_ID'),
    cosmos,
    storage,
    realJobs,
    realGrades,
    realResumes,
    realAnalyses,
    appOrigin: requireHttpsOrigin(env, 'APP_ORIGIN'),
    isProduction,
    isAppService,
  }
}
