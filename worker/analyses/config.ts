import type { RealAnalysesConfig } from '../../server/analyses/store'
import { workerSettingsContainer } from '../settings-store'

export interface AnalysisWorkerConfig {
  stores: RealAnalysesConfig
  tenantId: string
  clientId?: string
  localDevelopment: boolean
  modelEndpoint: string
  modelDeployment: string
  modelName: string
  reasoningEffort?: string
  maxItems: number
  budgetMilliseconds: number
  settingsContainer?: string
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim()
  if (!value) throw new Error(`${key} is required for the analysis worker.`)
  return value
}

function guid(value: string, key: string): string {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) {
    throw new Error(`${key} must be a directory identifier.`)
  }
  return value
}

function endpoint(environment: NodeJS.ProcessEnv, key: string, suffix: string): string {
  let url: URL
  try { url = new URL(required(environment, key)) } catch {
    throw new Error(`${key} must be an absolute Azure HTTPS endpoint.`)
  }
  const account = url.hostname.slice(0, -suffix.length)
  if (url.protocol !== 'https:' || !url.hostname.endsWith(suffix) ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(account) ||
    url.username || url.password || (url.port && url.port !== '443') ||
    url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${key} must be the Azure service root HTTPS endpoint.`)
  }
  return url.origin
}

function integer(environment: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const text = environment[key]?.trim()
  const value = text ? Number(text) : fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`)
  }
  return value
}

export function loadAnalysisWorkerConfig(environment: NodeJS.ProcessEnv): AnalysisWorkerConfig {
  const corrections = environment.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED?.trim()
  if (corrections && corrections !== 'true' && corrections !== 'false') {
    throw new Error('ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED must be true or false.')
  }
  const mode = environment.WORKER_AUTH_MODE?.trim()
  if (mode && mode !== 'azure-cli') throw new Error('WORKER_AUTH_MODE may only be azure-cli for explicit local development.')
  const localDevelopment = mode === 'azure-cli'
  if (localDevelopment && (environment.NODE_ENV === 'production' || environment.IDENTITY_ENDPOINT ||
    environment.MSI_ENDPOINT || environment.CONTAINER_APP_JOB_NAME || environment.CONTAINER_APP_NAME ||
    environment.WEBSITE_INSTANCE_ID)) {
    throw new Error('Azure CLI analysis-worker authentication is not allowed in a hosted runtime.')
  }
  const tenantId = guid(required(environment, 'AZURE_TENANT_ID'), 'AZURE_TENANT_ID')
  const clientId = localDevelopment ? undefined : guid(required(environment, 'AZURE_CLIENT_ID'), 'AZURE_CLIENT_ID')
  const container = environment.ANALYSIS_RECORDS_CONTAINER?.trim() || 'analysis-records'
  const blobContainer = environment.ANALYSIS_SOURCE_CONTAINER?.trim() || 'analysis-sources'
  if (container !== 'analysis-records' || blobContainer !== 'analysis-sources') {
    throw new Error('The analysis worker must use its dedicated analysis-records and analysis-sources stores.')
  }
  if ([
    'JOB_RECORDS_CONTAINER', 'JOB_SOURCE_CONTAINER', 'GRADE_RECORDS_CONTAINER', 'GRADE_SOURCE_CONTAINER',
    'RESUME_RECORDS_CONTAINER', 'RESUME_SOURCE_CONTAINER', 'WORKSPACE_BLOB_CONTAINER', 'COSMOS_CONTAINER',
    'DOCUMENT_INTELLIGENCE_ENDPOINT', 'JOB_RENDERER_URL',
  ].some(key => environment[key]?.trim())) {
    throw new Error('Live job, grade, resume, legacy workspace, OCR, and renderer services must not be configured in the analysis worker.')
  }
  const database = environment.COSMOS_DATABASE?.trim() || 'score'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(database)) {
    throw new Error('COSMOS_DATABASE must be a valid database identifier.')
  }
  const modelName = required(environment, 'RUBRIC_MODEL_NAME')
  const reasoningEffort = environment.RUBRIC_MODEL_REASONING_EFFORT?.trim() || undefined
  if (reasoningEffort && (reasoningEffort !== 'low' || !/^gpt-?5/i.test(modelName))) {
    throw new Error('RUBRIC_MODEL_REASONING_EFFORT must be low and is supported only for GPT-5 models.')
  }
  const modelDeployment = required(environment, 'RUBRIC_MODEL_DEPLOYMENT')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,299}$/.test(modelDeployment) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/.test(modelName)) {
    throw new Error('The analysis model name and deployment must be bounded service identifiers.')
  }
  return {
    stores: {
      cosmosEndpoint: endpoint(environment, 'COSMOS_ENDPOINT', '.documents.azure.com'),
      database, container,
      storageAccountUrl: endpoint(environment, 'STORAGE_ACCOUNT_URL', '.blob.core.windows.net'),
      blobContainer,
      ...(corrections === 'true' ? { evidenceCorrectionsEnabled: true } : {}),
    },
    tenantId, clientId, localDevelopment,
    modelEndpoint: endpoint(environment, 'RUBRIC_MODEL_ENDPOINT', '.openai.azure.com'),
    modelDeployment, modelName, reasoningEffort,
    maxItems: integer(environment, 'ANALYSIS_WORKER_MAX_ITEMS', 2, 1, 100),
    budgetMilliseconds: integer(environment, 'ANALYSIS_WORKER_BUDGET_MS', 660_000, 1000, 660_000),
    settingsContainer: workerSettingsContainer(environment),
  }
}
