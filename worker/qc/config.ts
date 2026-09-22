import type { QcConfig } from '../../server/qc/store'
import { loadWorkerModelConfig, type WorkerModelConfig } from '../configuration'

export interface QcWorkerConfig extends WorkerModelConfig {
  stores: QcConfig
  tenantId: string
  clientId?: string
  localDevelopment: boolean
  modelEndpoint: string
  settingsContainer: string
  maxItems: number
  budgetMilliseconds: number
}
function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim()
  if (!value) throw new Error(`${key} is required for the isolated QC worker.`)
  return value
}
function endpoint(environment: NodeJS.ProcessEnv, key: string, suffix: string): string {
  let parsed: URL
  try { parsed = new URL(required(environment, key)) } catch { throw new Error(`${key} must be an Azure HTTPS service root.`) }
  const account = parsed.hostname.slice(0, -suffix.length)
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith(suffix) || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(account) ||
    parsed.username || parsed.password || parsed.pathname !== '/' || parsed.port && parsed.port !== '443' || parsed.search || parsed.hash) {
    throw new Error(`${key} must be an Azure HTTPS service root.`)
  }
  return parsed.origin
}
function identifier(environment: NodeJS.ProcessEnv, key: string): string {
  const value = required(environment, key)
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) throw new Error(`${key} must be a directory identifier.`)
  return value
}
function integer(environment: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const text = environment[key]?.trim()
  const value = text ? Number(text) : fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`)
  return value
}
export function loadQcWorkerConfig(environment: NodeJS.ProcessEnv): QcWorkerConfig {
  const auth = environment.WORKER_AUTH_MODE?.trim()
  if (auth && auth !== 'azure-cli') throw new Error('QC WORKER_AUTH_MODE may only be azure-cli for explicit local development.')
  const localDevelopment = auth === 'azure-cli'
  if (localDevelopment && ['IDENTITY_ENDPOINT', 'MSI_ENDPOINT', 'CONTAINER_APP_JOB_NAME', 'CONTAINER_APP_NAME', 'WEBSITE_INSTANCE_ID']
    .some(key => environment[key]) || localDevelopment && environment.NODE_ENV === 'production') {
    throw new Error('Azure CLI authentication is forbidden for hosted QC workers.')
  }
  for (const key of [
    'JOB_RECORDS_CONTAINER', 'JOB_SOURCE_CONTAINER', 'GRADE_RECORDS_CONTAINER', 'GRADE_SOURCE_CONTAINER',
    'RESUME_RECORDS_CONTAINER', 'RESUME_SOURCE_CONTAINER', 'ANALYSIS_RECORDS_CONTAINER', 'ANALYSIS_SOURCE_CONTAINER',
    'WORKSPACE_BLOB_CONTAINER', 'COSMOS_CONTAINER', 'DOCUMENT_INTELLIGENCE_ENDPOINT', 'JOB_RENDERER_URL',
  ]) if (environment[key]?.trim()) throw new Error('The QC worker cannot configure live production, workspace-directory, extraction, or renderer stores.')
  const container = environment.QC_RECORDS_CONTAINER?.trim() || 'qc-records'
  const blobContainer = environment.QC_SOURCE_CONTAINER?.trim() || 'qc-sources'
  if (container !== 'qc-records' || blobContainer !== 'qc-sources') throw new Error('QC requires isolated qc-records and qc-sources stores.')
  if (required(environment, 'SCORE_SETTINGS_CONTAINER') !== 'application-settings') throw new Error('QC settings access must be read-only application-settings.')
  const database = environment.COSMOS_DATABASE?.trim() || 'score'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(database)) throw new Error('COSMOS_DATABASE is invalid.')
  return {
    stores: {
      cosmosEndpoint: endpoint(environment, 'COSMOS_ENDPOINT', '.documents.azure.com'), database, container,
      storageAccountUrl: endpoint(environment, 'STORAGE_ACCOUNT_URL', '.blob.core.windows.net'), blobContainer, workerEnabled: true,
    },
    tenantId: identifier(environment, 'AZURE_TENANT_ID'),
    clientId: localDevelopment ? undefined : identifier(environment, 'AZURE_CLIENT_ID'), localDevelopment,
    modelEndpoint: endpoint(environment, 'RUBRIC_MODEL_ENDPOINT', '.openai.azure.com'),
    ...loadWorkerModelConfig(environment), settingsContainer: 'application-settings',
    maxItems: integer(environment, 'QC_WORKER_MAX_ITEMS', 2, 1, 10),
    budgetMilliseconds: integer(environment, 'QC_WORKER_BUDGET_MS', 660_000, 1000, 660_000),
  }
}
