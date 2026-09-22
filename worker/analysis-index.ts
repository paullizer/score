import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity'
import type { TokenCredential } from '@azure/identity'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAzureAnalysisBlobStore, createAzureAnalysisStore } from '../server/analyses/azure-store'
import { loadAnalysisWorkerConfig, type AnalysisWorkerConfig } from './analyses/config'
import { runAnalysisWorker, type AnalysisWorkerDependencies } from './analyses/runtime'
import { logAnalysisTelemetry } from './analyses/telemetry'
import { createAzureWorkerSettings } from './settings-store'
import { workerFailureDiagnostic, workerStartupFailure, withWorkerSettingsDiagnostics, type WorkerStartupPhase } from './startup'

export { loadAnalysisWorkerConfig } from './analyses/config'
export { runAnalysisWorker } from './analyses/runtime'

export function createAnalysisWorkerDependencies(
  config: AnalysisWorkerConfig, credential: TokenCredential,
): AnalysisWorkerDependencies {
  return {
    settings: withWorkerSettingsDiagnostics(createAzureWorkerSettings(config, credential, {
      deployment: config.modelDeployment, modelName: config.modelName, reasoningEffort: config.reasoningEffort,
    })),
    store: createAzureAnalysisStore(config.stores, credential),
    blobs: createAzureAnalysisBlobStore(config.stores, credential),
    correctionsEnabled: config.stores.evidenceCorrectionsEnabled === true,
    onEvent: logAnalysisTelemetry,
    model: {
      endpoint: config.modelEndpoint, deployment: config.modelDeployment,
      modelName: config.modelName, reasoningEffort: config.reasoningEffort,
      async getToken(scope) {
        const token = await credential.getToken(scope)
        if (!token) throw new Error('The analysis worker could not obtain an Azure service token.')
        return token.token
      },
    },
  }
}

export async function main(): Promise<void> {
  const stopping = new AbortController()
  const stop = () => stopping.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  let phase: WorkerStartupPhase = 'configuration'
  try {
    const config = loadAnalysisWorkerConfig(process.env)
    phase = 'identity'
    const credential: TokenCredential = config.localDevelopment
      ? new AzureCliCredential({ tenantId: config.tenantId })
      : new ManagedIdentityCredential({ clientId: config.clientId! })
    phase = 'dependencies'
    const dependencies = createAnalysisWorkerDependencies(config, credential)
    phase = 'processing'
    const result = await runAnalysisWorker(dependencies, {
      maxItems: config.maxItems, budgetMilliseconds: config.budgetMilliseconds, signal: stopping.signal,
    })
    console.log('Score analysis worker completed:', result)
  } catch (error) {
    throw workerStartupFailure(phase, error)
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    console.error(JSON.stringify({
      component: 'score-analysis-worker', event: 'worker-failed', code: 'analysis-worker-failed', ...workerFailureDiagnostic(error),
    }))
    process.exitCode = 1
  })
}
