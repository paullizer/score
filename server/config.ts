import { GUID_PATTERN } from './ids'
import type { RealJobsConfig } from './jobs/store'
import type { RealGradesConfig } from './grades/store'

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
  readonly jobLifecycleStore?: RealJobsConfig
  readonly gradeLifecycleStore?: RealGradesConfig
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
  const importsSetting = optional(env, 'REAL_JOB_IMPORTS_ENABLED')
  if (importsSetting !== undefined && importsSetting !== 'true' && importsSetting !== 'false') {
    throw new ConfigError('REAL_JOB_IMPORTS_ENABLED must be true or false.')
  }
  let realJobs: RealJobsConfig | undefined
  if (importsSetting === 'true') {
    const container = required(env, 'JOB_RECORDS_CONTAINER')
    const blobContainer = required(env, 'JOB_SOURCE_CONTAINER')
    if (container === cosmos.container) throw new ConfigError('JOB_RECORDS_CONTAINER must be separate from COSMOS_CONTAINER.')
    if (blobContainer === storage.containerName) {
      throw new ConfigError('JOB_SOURCE_CONTAINER must be separate from WORKSPACE_BLOB_CONTAINER.')
    }

    realJobs = {
      cosmosEndpoint: cosmos.endpoint,
      database: cosmos.database,
      container,
      storageAccountUrl: storage.accountUrl,
      blobContainer,
    }
  }

  const gradesSetting = optional(env, 'REAL_GRADE_LADDERS_ENABLED')
  if (gradesSetting !== undefined && gradesSetting !== 'true' && gradesSetting !== 'false') {
    throw new ConfigError('REAL_GRADE_LADDERS_ENABLED must be true or false.')
  }
  let realGrades: RealGradesConfig | undefined
  if (gradesSetting === 'true') {
    const container = optional(env, 'GRADE_RECORDS_CONTAINER') ?? 'grade-records'
    const blobContainer = optional(env, 'GRADE_SOURCE_CONTAINER') ?? 'grade-sources'
    if (container === cosmos.container || container === (realJobs?.container ?? optional(env, 'JOB_RECORDS_CONTAINER') ?? 'job-records')) {
      throw new ConfigError('GRADE_RECORDS_CONTAINER must be separate from workspace and job records.')
    }
    if (blobContainer === storage.containerName ||
      blobContainer === (realJobs?.blobContainer ?? optional(env, 'JOB_SOURCE_CONTAINER') ?? 'job-sources')) {
      throw new ConfigError('GRADE_SOURCE_CONTAINER must be separate from workspace and job sources.')
    }
    realGrades = {
      cosmosEndpoint: cosmos.endpoint, database: cosmos.database, container,
      storageAccountUrl: storage.accountUrl, blobContainer,
    }
  }

  const jobRecords = optional(env, 'JOB_RECORDS_CONTAINER')
  const jobSources = optional(env, 'JOB_SOURCE_CONTAINER')
  if (Boolean(jobRecords) !== Boolean(jobSources)) {
    throw new ConfigError('Both job storage containers must be configured so lifecycle cleanup cannot skip existing data.')
  }
  const jobLifecycleStore = realJobs ?? (jobRecords && jobSources ? {
    cosmosEndpoint: cosmos.endpoint, database: cosmos.database, container: jobRecords,
    storageAccountUrl: storage.accountUrl, blobContainer: jobSources,
  } : undefined)
  const gradeRecords = optional(env, 'GRADE_RECORDS_CONTAINER')
  const gradeSources = optional(env, 'GRADE_SOURCE_CONTAINER')
  const gradeLifecycleStore = realGrades ?? (gradeRecords || gradeSources ? {
    cosmosEndpoint: cosmos.endpoint, database: cosmos.database, container: gradeRecords ?? 'grade-records',
    storageAccountUrl: storage.accountUrl, blobContainer: gradeSources ?? 'grade-sources',
  } : undefined)
  if (jobLifecycleStore && (jobLifecycleStore.container === cosmos.container ||
    jobLifecycleStore.blobContainer === storage.containerName)) {
    throw new ConfigError('Job lifecycle storage must be separate from workspace storage.')
  }
  if (gradeLifecycleStore && (gradeLifecycleStore.container === cosmos.container ||
    gradeLifecycleStore.container === jobLifecycleStore?.container ||
    gradeLifecycleStore.blobContainer === storage.containerName ||
    gradeLifecycleStore.blobContainer === jobLifecycleStore?.blobContainer)) {
    throw new ConfigError('Grade lifecycle storage must be separate from workspace and job storage.')
  }

  return {
    authMode,
    tenantId: requireGuid(env, 'AZURE_TENANT_ID'),
    allowedUserIds: parseAllowedUserIds(env),
    managedIdentityClientId: optional(env, 'AZURE_CLIENT_ID'),
    cosmos,
    storage,
    realJobs,
    realGrades,
    jobLifecycleStore,
    gradeLifecycleStore,
    appOrigin: requireHttpsOrigin(env, 'APP_ORIGIN'),
    isProduction,
    isAppService,
  }
}
