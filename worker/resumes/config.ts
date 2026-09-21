import type { RealResumesConfig } from '../../server/resumes/store'
import { workerSettingsContainer } from '../settings-store'

export interface ResumeWorkerConfig {
  stores: RealResumesConfig
  tenantId: string
  clientId?: string
  localDevelopment: boolean
  documentIntelligenceEndpoint: string
  modelEndpoint: string
  modelDeployment: string
  modelName: string
  reasoningEffort?: string
  rendererUrl: string
  maxItems: number
  budgetMilliseconds: number
  settingsContainer?: string
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim()
  if (!value) throw new Error(`${key} is required for the resume worker.`)
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
  if (url.protocol !== 'https:' || !url.hostname.endsWith(suffix) || url.username || url.password ||
    (url.port && url.port !== '443') || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${key} must be the Azure service root HTTPS endpoint.`)
  }
  return url.origin
}

function integer(environment: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const text = environment[key]?.trim()
  const number = text ? Number(text) : fallback
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`)
  }
  return number
}

export function loadResumeWorkerConfig(environment: NodeJS.ProcessEnv): ResumeWorkerConfig {
  const mode = environment.WORKER_AUTH_MODE?.trim()
  if (mode && mode !== 'azure-cli') throw new Error('WORKER_AUTH_MODE may only be azure-cli for explicit local development.')
  const localDevelopment = mode === 'azure-cli'
  if (localDevelopment && (environment.NODE_ENV === 'production' || [
    'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET', 'CONTAINER_APP_JOB_NAME',
    'CONTAINER_APP_NAME', 'WEBSITE_INSTANCE_ID', 'WEBSITE_HOSTNAME',
  ].some(key => environment[key]))) {
    throw new Error('Azure CLI resume-worker authentication is not allowed in a hosted runtime.')
  }
  const tenantId = guid(required(environment, 'AZURE_TENANT_ID'), 'AZURE_TENANT_ID')
  const clientId = localDevelopment ? undefined : guid(required(environment, 'AZURE_CLIENT_ID'), 'AZURE_CLIENT_ID')
  const container = environment.RESUME_RECORDS_CONTAINER?.trim() || 'resume-records'
  const blobContainer = environment.RESUME_SOURCE_CONTAINER?.trim() || 'resume-sources'
  if (container !== 'resume-records' || blobContainer !== 'resume-sources') {
    throw new Error('The resume worker must use its dedicated resume-records and resume-sources stores.')
  }
  if ([
    'JOB_RECORDS_CONTAINER', 'JOB_SOURCE_CONTAINER', 'GRADE_RECORDS_CONTAINER', 'GRADE_SOURCE_CONTAINER',
    'ANALYSIS_RECORDS_CONTAINER', 'ANALYSIS_SOURCE_CONTAINER', 'WORKSPACE_BLOB_CONTAINER',
  ].some(key => environment[key] !== undefined)) {
    throw new Error('Job, grade, analysis, and legacy workspace stores must not be configured in the resume worker.')
  }
  const modelName = required(environment, 'RUBRIC_MODEL_NAME')
  const reasoningEffort = environment.RUBRIC_MODEL_REASONING_EFFORT?.trim() || undefined
  if (reasoningEffort && (reasoningEffort !== 'low' || !/^gpt-?5/i.test(modelName))) {
    throw new Error('RUBRIC_MODEL_REASONING_EFFORT must be low and is supported only for GPT-5 models.')
  }
  let renderer: URL
  try { renderer = new URL(required(environment, 'JOB_RENDERER_URL')) } catch {
    throw new Error('JOB_RENDERER_URL must be a valid renderer URL.')
  }
  const localRenderer = localDevelopment && ['127.0.0.1', '[::1]', 'localhost'].includes(renderer.hostname) &&
    ['http:', 'https:'].includes(renderer.protocol)
  const hostedRenderer = renderer.protocol === 'https:' && renderer.hostname.includes('.internal.') &&
    renderer.hostname.endsWith('.azurecontainerapps.io') && (!renderer.port || renderer.port === '443')
  if ((!localRenderer && !hostedRenderer) || renderer.username || renderer.password || renderer.search ||
    renderer.hash || renderer.pathname !== '/') {
    throw new Error('JOB_RENDERER_URL must identify the private internal renderer, or an explicit local-development loopback renderer.')
  }
  const database = environment.COSMOS_DATABASE?.trim() || 'score'
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(database)) throw new Error('COSMOS_DATABASE must be a valid database identifier.')
  return {
    stores: {
      cosmosEndpoint: endpoint(environment, 'COSMOS_ENDPOINT', '.documents.azure.com'),
      database, container,
      storageAccountUrl: endpoint(environment, 'STORAGE_ACCOUNT_URL', '.blob.core.windows.net'),
      blobContainer,
    },
    tenantId, clientId, localDevelopment,
    documentIntelligenceEndpoint: endpoint(environment, 'DOCUMENT_INTELLIGENCE_ENDPOINT', '.cognitiveservices.azure.com'),
    modelEndpoint: endpoint(environment, 'RUBRIC_MODEL_ENDPOINT', '.openai.azure.com'),
    modelDeployment: required(environment, 'RUBRIC_MODEL_DEPLOYMENT'),
    modelName, reasoningEffort, rendererUrl: renderer.origin,
    maxItems: integer(environment, 'RESUME_WORKER_MAX_ITEMS', 5, 1, 20),
    budgetMilliseconds: integer(environment, 'RESUME_WORKER_BUDGET_MS', 660_000, 1000, 660_000),
    settingsContainer: workerSettingsContainer(environment),
  }
}
