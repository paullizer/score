import { AzureCliCredential, ManagedIdentityCredential, type TokenCredential } from '@azure/identity'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAzureQcBlobStore, createAzureQcStore } from '../server/qc/azure-store'
import { createAzureWorkerSettings } from './settings-store'
import { systemClock } from './clock'
import { loadQcWorkerConfig, type QcWorkerConfig } from './qc/config'
import { runQcWorker, QC_WORKER_VERSION, type QcWorkerDependencies } from './qc/runtime'

export { loadQcWorkerConfig } from './qc/config'
export { runQcWorker, QC_WORKER_VERSION, QC_RUNTIME_VERSION, RUNTIME_SETTINGS_VERSION, PROMPT_RUNTIME_VERSION } from './qc/runtime'
export function createQcWorkerDependencies(config: QcWorkerConfig, credential: TokenCredential): QcWorkerDependencies {
  const store = createAzureQcStore(config.stores, credential)
  return {
    store, blobs: createAzureQcBlobStore(config.stores, credential, store), workerEnabled: true, clock: systemClock,
    settings: createAzureWorkerSettings(config, credential, {
      deployment: config.modelDeployment, modelName: config.modelName, reasoningEffort: config.reasoningEffort,
    }),
    model: {
      endpoint: config.modelEndpoint, deployment: config.modelDeployment, modelName: config.modelName, reasoningEffort: config.reasoningEffort,
      async getToken(scope) {
        const token = await credential.getToken(scope)
        if (!token) throw new Error('The QC worker could not obtain a service token.')
        return token.token
      },
    },
  }
}
export async function main(): Promise<void> {
  const controller = new AbortController(), stop = () => controller.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    const config = loadQcWorkerConfig(process.env)
    const credential: TokenCredential = config.localDevelopment
      ? new AzureCliCredential({ tenantId: config.tenantId }) : new ManagedIdentityCredential({ clientId: config.clientId! })
    const result = await runQcWorker(createQcWorkerDependencies(config, credential), {
      maxItems: config.maxItems, budgetMilliseconds: config.budgetMilliseconds, signal: controller.signal,
    })
    console.log(JSON.stringify({ component: 'score-qc-worker', version: QC_WORKER_VERSION, event: 'completed', ...result }))
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error(JSON.stringify({ component: 'score-qc-worker', version: QC_WORKER_VERSION, event: 'failed', code: 'qc-worker-failed' }))
    process.exitCode = 1
  })
}
