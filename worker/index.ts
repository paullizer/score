import process from 'node:process'
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity'
import type { TokenCredential } from '@azure/identity'
import { chromium } from 'playwright'
import { createAzureJobBlobStore, createAzureJobStore } from '../server/jobs/azure-store'
import type { RealJobsConfig } from '../server/jobs/store'
import { validateRealRubric } from '../server/jobs/validation'
import { createPlaywrightRenderer, createRemoteRenderer, runWorker, WorkerError } from './runtime'
import { createAzureWorkerSettings, workerSettingsContainer } from './settings-store'

interface WorkerConfig {
  stores: RealJobsConfig
  tenantId: string
  clientId?: string
  localDevelopment: boolean
  documentIntelligenceEndpoint: string
  rubricModelEndpoint: string
  rubricModelDeployment: string
  rubricModelName: string
  rubricModelReasoningEffort?: string
  rendererUrl?: string
  maxJobs: number
  settingsContainer?: string
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const authMode = environment.WORKER_AUTH_MODE?.trim()
  if (authMode && authMode !== 'azure-cli') throw new Error('WORKER_AUTH_MODE must be azure-cli when set.')
  const modelName = required(environment, 'RUBRIC_MODEL_NAME')
  const reasoning = environment.RUBRIC_MODEL_REASONING_EFFORT?.trim()
  if (reasoning && reasoning !== 'low') throw new Error('RUBRIC_MODEL_REASONING_EFFORT must be low when set.')
  if (reasoning && !/^gpt-?5/i.test(modelName)) throw new Error('RUBRIC_MODEL_REASONING_EFFORT is supported only for GPT-5 models.')
  const maxJobs = Number(environment.WORKER_MAX_JOBS?.trim() || '4')
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 20) throw new Error('WORKER_MAX_JOBS must be an integer from 1 through 20.')
  const rendererUrl = environment.JOB_RENDERER_URL?.trim() || undefined
  if (authMode !== 'azure-cli' && !rendererUrl) throw new Error('JOB_RENDERER_URL is required for hosted worker execution.')
  return {
    stores: {
      cosmosEndpoint: required(environment, 'COSMOS_ENDPOINT'),
      database: environment.COSMOS_DATABASE?.trim() || 'score',
      container: environment.JOB_RECORDS_CONTAINER?.trim() || 'job-records',
      storageAccountUrl: required(environment, 'STORAGE_ACCOUNT_URL'),
      blobContainer: environment.JOB_SOURCE_CONTAINER?.trim() || 'job-sources',
    },
    tenantId: required(environment, 'AZURE_TENANT_ID'),
    clientId: environment.AZURE_CLIENT_ID?.trim() || undefined,
    localDevelopment: authMode === 'azure-cli',
    documentIntelligenceEndpoint: required(environment, 'DOCUMENT_INTELLIGENCE_ENDPOINT'),
    rubricModelEndpoint: required(environment, 'RUBRIC_MODEL_ENDPOINT'),
    rubricModelDeployment: required(environment, 'RUBRIC_MODEL_DEPLOYMENT'),
    rubricModelName: modelName,
    rubricModelReasoningEffort: reasoning,
    rendererUrl,
    maxJobs,
    settingsContainer: workerSettingsContainer(environment),
  }
}

function createCredential(config: WorkerConfig): TokenCredential {
  if (config.localDevelopment) return new AzureCliCredential({ tenantId: config.tenantId })
  if (!config.clientId) throw new Error('AZURE_CLIENT_ID is required for hosted worker execution.')
  return new ManagedIdentityCredential({ clientId: config.clientId })
}

async function token(credential: TokenCredential, scope: string): Promise<string> {
  const accessToken = await credential.getToken(scope)
  if (!accessToken) throw new WorkerError('token-unavailable', 'Azure identity did not return an access token.', true, 'rubric')
  return accessToken.token
}

async function main(): Promise<void> {
  try {
    const config = loadWorkerConfig(process.env)
    const credential = createCredential(config)
    let browser
    if (config.localDevelopment) {
      browser = await createPlaywrightRenderer(options => chromium.launch(options))
    } else {
      if (!config.rendererUrl) throw new Error('JOB_RENDERER_URL is required for hosted worker execution.')
      browser = createRemoteRenderer(config.rendererUrl)
    }
    const result = await runWorker({
      settings: createAzureWorkerSettings(config, credential, {
        deployment: config.rubricModelDeployment, modelName: config.rubricModelName,
        reasoningEffort: config.rubricModelReasoningEffort,
      }),
      store: createAzureJobStore(config.stores, credential),
      blobs: createAzureJobBlobStore(config.stores, credential),
      browser,
      documentIntelligence: {
        endpoint: config.documentIntelligenceEndpoint,
        getToken: scope => token(credential, scope),
      },
      model: {
        endpoint: config.rubricModelEndpoint,
        deployment: config.rubricModelDeployment,
        modelName: config.rubricModelName,
        reasoningEffort: config.rubricModelReasoningEffort,
        getToken: scope => token(credential, scope),
      },
      validateRealRubric,
    }, { maxJobs: config.maxJobs })
    console.log(`Score job worker completed ${result.completed} claimed job(s).`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown worker failure.'
    console.error(`Score job worker failed: ${message}`)
    process.exitCode = 1
  }
}

void main()
