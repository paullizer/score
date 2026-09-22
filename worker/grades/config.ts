import type { RealGradesConfig } from '../../server/grades/store'
import {
  loadWorkerModelConfig, loadWorkerSettingsContainer, WorkerConfigurationError,
  type WorkerConfigurationField, type WorkerModelConfig,
} from '../configuration'

export interface GradeWorkerConfig extends WorkerModelConfig {
  stores: RealGradesConfig
  tenantId: string
  clientId?: string
  localDevelopment: boolean
  documentIntelligenceEndpoint: string
  modelEndpoint: string
  rendererUrl: string
  maxItems: number
  budgetMilliseconds: number
  settingsContainer?: string
}

function required(environment: NodeJS.ProcessEnv, key: WorkerConfigurationField): string {
  const value = environment[key]?.trim()
  if (!value) throw new WorkerConfigurationError(key, 'missing', `${key} is required for the grade worker.`)
  return value
}

function guid(value: string, key: WorkerConfigurationField): string {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) {
    throw new WorkerConfigurationError(key, 'invalid-identifier', `${key} must be a directory identifier.`)
  }
  return value
}

function endpoint(environment: NodeJS.ProcessEnv, key: WorkerConfigurationField, suffix: string): string {
  const value = required(environment, key)
  let url: URL
  try { url = new URL(value) } catch {
    throw new WorkerConfigurationError(key, 'invalid-endpoint', `${key} must be an absolute Azure HTTPS endpoint.`)
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith(suffix) || url.username || url.password ||
    (url.port && url.port !== '443') || url.pathname !== '/' || url.search || url.hash) {
    throw new WorkerConfigurationError(key, 'invalid-endpoint', `${key} must be the Azure service root HTTPS endpoint.`)
  }
  return url.origin
}

function integer(environment: NodeJS.ProcessEnv, key: WorkerConfigurationField, fallback: number, min: number, max: number): number {
  const text = environment[key]?.trim()
  const number = text ? Number(text) : fallback
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new WorkerConfigurationError(key, 'invalid-integer', `${key} must be an integer between ${min} and ${max}.`)
  }
  return number
}

export function loadGradeWorkerConfig(environment: NodeJS.ProcessEnv): GradeWorkerConfig {
  const mode = environment.WORKER_AUTH_MODE?.trim()
  if (mode && mode !== 'azure-cli') throw new WorkerConfigurationError('WORKER_AUTH_MODE', 'invalid-value', 'WORKER_AUTH_MODE may only be azure-cli for explicit local development.')
  const localDevelopment = mode === 'azure-cli'
  if (localDevelopment && (environment.NODE_ENV === 'production' || environment.IDENTITY_ENDPOINT || environment.CONTAINER_APP_JOB_NAME)) {
    throw new WorkerConfigurationError('WORKER_AUTH_MODE', 'hosted-auth', 'Azure CLI grade-worker authentication is not allowed in a hosted runtime.')
  }
  const tenantId = guid(required(environment, 'AZURE_TENANT_ID'), 'AZURE_TENANT_ID')
  const clientId = localDevelopment ? undefined : guid(required(environment, 'AZURE_CLIENT_ID'), 'AZURE_CLIENT_ID')
  const container = environment.GRADE_RECORDS_CONTAINER?.trim() || 'grade-records'
  const blobContainer = environment.GRADE_SOURCE_CONTAINER?.trim() || 'grade-sources'
  if (container !== 'grade-records' || blobContainer !== 'grade-sources') {
    throw new WorkerConfigurationError(container !== 'grade-records' ? 'GRADE_RECORDS_CONTAINER' : 'GRADE_SOURCE_CONTAINER',
      'store-isolation', 'The grade worker must use its dedicated grade-records and grade-sources stores.')
  }
  const forbidden = (['JOB_RECORDS_CONTAINER', 'JOB_SOURCE_CONTAINER', 'WORKSPACE_BLOB_CONTAINER'] as const).find(key => environment[key])
  if (forbidden) {
    throw new WorkerConfigurationError(forbidden, 'store-isolation', 'Job and legacy workspace stores must not be configured in the grade worker.')
  }
  const model = loadWorkerModelConfig(environment)
  const rendererUrl = required(environment, 'JOB_RENDERER_URL')
  let renderer: URL
  try { renderer = new URL(rendererUrl) } catch {
    throw new WorkerConfigurationError('JOB_RENDERER_URL', 'invalid-endpoint', 'JOB_RENDERER_URL must be a valid renderer URL.')
  }
  const localRenderer = localDevelopment && ['127.0.0.1', '[::1]', 'localhost'].includes(renderer.hostname) && ['http:', 'https:'].includes(renderer.protocol)
  const hostedRenderer = renderer.protocol === 'https:' && renderer.hostname.includes('.internal.') &&
    renderer.hostname.endsWith('.azurecontainerapps.io') && (!renderer.port || renderer.port === '443')
  if ((!localRenderer && !hostedRenderer) || renderer.username || renderer.password || renderer.search || renderer.hash || renderer.pathname !== '/') {
    throw new WorkerConfigurationError('JOB_RENDERER_URL', 'invalid-endpoint', 'JOB_RENDERER_URL must identify the private internal renderer, or an explicit local-development loopback renderer.')
  }
  return {
    stores: {
      cosmosEndpoint: endpoint(environment, 'COSMOS_ENDPOINT', '.documents.azure.com'),
      database: environment.COSMOS_DATABASE?.trim() || 'score',
      container,
      storageAccountUrl: endpoint(environment, 'STORAGE_ACCOUNT_URL', '.blob.core.windows.net'),
      blobContainer,
    },
    tenantId, clientId, localDevelopment,
    documentIntelligenceEndpoint: endpoint(environment, 'DOCUMENT_INTELLIGENCE_ENDPOINT', '.cognitiveservices.azure.com'),
    modelEndpoint: endpoint(environment, 'RUBRIC_MODEL_ENDPOINT', '.openai.azure.com'),
    ...model, rendererUrl: renderer.origin,
    maxItems: integer(environment, 'GRADE_WORKER_MAX_ITEMS', 5, 1, 20),
    budgetMilliseconds: integer(environment, 'GRADE_WORKER_BUDGET_MS', 660_000, 1000, 660_000),
    settingsContainer: loadWorkerSettingsContainer(environment),
  }
}
