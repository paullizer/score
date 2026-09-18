import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity'
import type { TokenCredential } from '@azure/identity'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createAzureResumeBlobStore, createAzureResumeStore } from '../server/resumes/azure-store'
import { createRemoteRenderer } from './runtime'
import { loadResumeWorkerConfig, type ResumeWorkerConfig } from './resumes/config'
import { ResumeWorkerError, runResumeWorker, type ResumeWorkerDependencies } from './resumes/runtime'

export { loadResumeWorkerConfig } from './resumes/config'
export { processClaimedResume, runResumeWorker } from './resumes/runtime'

async function getToken(credential: TokenCredential, scope: string): Promise<string> {
  const token = await credential.getToken(scope)
  if (!token) throw new ResumeWorkerError('service-unavailable', 'The resume worker could not obtain an Azure service token.', true)
  return token.token
}

export function createResumeWorkerDependencies(config: ResumeWorkerConfig, credential: TokenCredential): ResumeWorkerDependencies {
  return {
    store: createAzureResumeStore(config.stores, credential),
    blobs: createAzureResumeBlobStore(config.stores, credential),
    documentIntelligence: {
      endpoint: config.documentIntelligenceEndpoint,
      getToken: scope => getToken(credential, scope),
    },
    model: {
      endpoint: config.modelEndpoint, deployment: config.modelDeployment, modelName: config.modelName,
      reasoningEffort: config.reasoningEffort,
      getToken: scope => getToken(credential, scope),
    },
    browser: createRemoteRenderer(config.rendererUrl, fetch, { allowLocalHttp: config.localDevelopment }),
  }
}

export async function main(): Promise<void> {
  const stopping = new AbortController()
  const stop = () => stopping.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    const config = loadResumeWorkerConfig(process.env)
    let credential: TokenCredential
    if (config.localDevelopment) credential = new AzureCliCredential({ tenantId: config.tenantId })
    else {
      if (!config.clientId) throw new ResumeWorkerError('service-unavailable', 'The hosted resume worker requires its dedicated managed identity.')
      credential = new ManagedIdentityCredential({ clientId: config.clientId })
    }
    const result = await runResumeWorker(createResumeWorkerDependencies(config, credential), {
      maxItems: config.maxItems, budgetMilliseconds: config.budgetMilliseconds, signal: stopping.signal,
    })
    console.log('Score resume worker completed:', result)
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    console.error('Score resume worker failed:', {
      code: error instanceof ResumeWorkerError ? error.code : 'startup-failed',
    })
    process.exitCode = 1
  })
}
