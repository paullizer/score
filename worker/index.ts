import process from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity'
import type { TokenCredential } from '@azure/identity'
import { chromium } from 'playwright'
import { createAzureJobBlobStore, createAzureJobStore } from '../server/jobs/azure-store'
import type { RealJobsConfig } from '../server/jobs/store'
import type { ReasoningEffort } from '../src/domain/admin-settings'
import { validateRealRubric } from '../server/jobs/validation'
import { createPlaywrightRenderer, createRemoteRenderer, runWorker, WorkerError } from './runtime'
import { createAzureWorkerSettings } from './settings-store'
import {
  loadWorkerModelConfig, loadWorkerSettingsContainer, WorkerConfigurationError, type WorkerConfigurationField,
} from './configuration'
import { workerFailureDiagnostic, workerStartupFailure, withWorkerSettingsDiagnostics, type WorkerStartupPhase } from './startup'

interface WorkerConfig {
  stores: RealJobsConfig
  tenantId: string
  clientId?: string
  localDevelopment: boolean
  documentIntelligenceEndpoint: string
  rubricModelEndpoint: string
  rubricModelDeployment: string
  rubricModelName: string
  rubricModelReasoningEffort?: ReasoningEffort
  rendererUrl?: string
  maxJobs: number
  settingsContainer?: string
}

function required(environment: NodeJS.ProcessEnv, name: WorkerConfigurationField): string {
  const value = environment[name]?.trim()
  if (!value) throw new WorkerConfigurationError(name, 'missing', `${name} is required.`)
  return value
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const authMode = environment.WORKER_AUTH_MODE?.trim()
  if (authMode && authMode !== 'azure-cli') throw new WorkerConfigurationError('WORKER_AUTH_MODE', 'invalid-value', 'WORKER_AUTH_MODE must be azure-cli when set.')
  const model = loadWorkerModelConfig(environment)
  const maxJobs = Number(environment.WORKER_MAX_JOBS?.trim() || '4')
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 20) {
    throw new WorkerConfigurationError('WORKER_MAX_JOBS', 'invalid-integer', 'WORKER_MAX_JOBS must be an integer from 1 through 20.')
  }
  const rendererUrl = environment.JOB_RENDERER_URL?.trim() || undefined
  if (authMode !== 'azure-cli' && !rendererUrl) {
    throw new WorkerConfigurationError('JOB_RENDERER_URL', 'missing', 'JOB_RENDERER_URL is required for hosted worker execution.')
  }
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
    rubricModelDeployment: model.modelDeployment,
    rubricModelName: model.modelName,
    rubricModelReasoningEffort: model.reasoningEffort,
    rendererUrl,
    maxJobs,
    settingsContainer: loadWorkerSettingsContainer(environment),
  }
}

function createCredential(config: WorkerConfig): TokenCredential {
  if (config.localDevelopment) return new AzureCliCredential({ tenantId: config.tenantId })
  if (!config.clientId) throw new WorkerConfigurationError('AZURE_CLIENT_ID', 'missing', 'AZURE_CLIENT_ID is required for hosted worker execution.')
  return new ManagedIdentityCredential({ clientId: config.clientId })
}

async function token(credential: TokenCredential, scope: string): Promise<string> {
  const accessToken = await credential.getToken(scope)
  if (!accessToken) throw new WorkerError('token-unavailable', 'Azure identity did not return an access token.', true, 'rubric')
  return accessToken.token
}

export async function main(): Promise<void> {
  let phase: WorkerStartupPhase = 'configuration'
  try {
    const config = loadWorkerConfig(process.env)
    phase = 'identity'
    const credential = createCredential(config)
    phase = 'dependencies'
    let browser
    if (config.localDevelopment) {
      browser = await createPlaywrightRenderer(options => chromium.launch(options))
    } else {
      if (!config.rendererUrl) throw new WorkerConfigurationError('JOB_RENDERER_URL', 'missing', 'JOB_RENDERER_URL is required for hosted worker execution.')
      browser = createRemoteRenderer(config.rendererUrl)
    }
    const dependencies = {
      settings: withWorkerSettingsDiagnostics(createAzureWorkerSettings(config, credential, {
        deployment: config.rubricModelDeployment, modelName: config.rubricModelName,
        reasoningEffort: config.rubricModelReasoningEffort,
      })),
      store: createAzureJobStore(config.stores, credential),
      blobs: createAzureJobBlobStore(config.stores, credential),
      browser,
      documentIntelligence: {
        endpoint: config.documentIntelligenceEndpoint,
        getToken: (scope: string) => token(credential, scope),
      },
      model: {
        endpoint: config.rubricModelEndpoint,
        deployment: config.rubricModelDeployment,
        modelName: config.rubricModelName,
        reasoningEffort: config.rubricModelReasoningEffort,
        getToken: (scope: string) => token(credential, scope),
      },
      validateRealRubric,
    }
    phase = 'processing'
    const result = await runWorker(dependencies, { maxJobs: config.maxJobs })
    console.log(`Score job worker completed ${result.completed} claimed job(s).`)
  } catch (error) {
    throw workerStartupFailure(phase, error)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    console.error(JSON.stringify({
      component: 'score-job-worker', event: 'worker-failed', code: 'job-worker-failed', ...workerFailureDiagnostic(error),
    }))
    process.exitCode = 1
  })
}
