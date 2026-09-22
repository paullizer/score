import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity'
import type { TokenCredential } from '@azure/identity'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createAzureGradeBlobStore, createAzureGradeStore } from '../server/grades/azure-store'
import {
  gradeRecordHash, parseGradeSeedSnapshot, validateGradeVersion, validateReferenceDocument,
} from '../server/grades/validation'
import type { ReferenceDocument } from '../src/domain/real-grades'
import { discoverOpmSources, parseOpmDiscoveryResult } from './opm/index'
import { extractReferenceDocument, fetchReferenceOriginal } from './references/index'
import { createRemoteRenderer, invokeStructuredModel } from './runtime'
import { loadGradeWorkerConfig, type GradeWorkerConfig } from './grades/config'
import { draftGradeRubric, planGradeCompetencies, reviewGradeRubric } from './grades/model'
import { GradeWorkerError, runGradeWorker, type GradeWorkerDependencies } from './grades/runtime'
import { createAzureWorkerSettings } from './settings-store'
import { workerFailureDiagnostic, workerStartupFailure, withWorkerSettingsDiagnostics, type WorkerStartupPhase } from './startup'

export { loadGradeWorkerConfig } from './grades/config'
export { runGradeWorker } from './grades/runtime'

async function getToken(credential: TokenCredential, scope: string): Promise<string> {
  const token = await credential.getToken(scope)
  if (!token) throw new GradeWorkerError('grade-identity-unavailable', 'The grade worker could not obtain an Azure service token.', true)
  return token.token
}

export function createGradeWorkerDependencies(config: GradeWorkerConfig, credential: TokenCredential): GradeWorkerDependencies {
  const model = {
    endpoint: config.modelEndpoint,
    deployment: config.modelDeployment,
    modelName: config.modelName,
    reasoningEffort: config.reasoningEffort,
    getToken: (scope: string) => getToken(credential, scope),
  }
  return {
    settings: withWorkerSettingsDiagnostics(createAzureWorkerSettings(config, credential, model)),
    store: createAzureGradeStore(config.stores, credential),
    blobs: createAzureGradeBlobStore(config.stores, credential),
    discover: discoverOpmSources,
    fetchOriginal: fetchReferenceOriginal,
    extractReference: extractReferenceDocument,
    planCompetencies: planGradeCompetencies,
    draftGrade: draftGradeRubric,
    reviewGrade: reviewGradeRubric,
    invokeModel: (request, signal) => invokeStructuredModel(model, request, signal),
    documentIntelligence: {
      endpoint: config.documentIntelligenceEndpoint,
      getToken: scope => getToken(credential, scope),
    },
    sourceOptions: { browser: createRemoteRenderer(config.rendererUrl) },
    parseSeed: parseGradeSeedSnapshot,
    parseDiscovery: parseOpmDiscoveryResult,
    parseDocument: value => {
      const errors = validateReferenceDocument(value)
      if (errors.length) throw new GradeWorkerError('invalid-reference-document', `The reference document failed validation: ${errors.join(' ')}`)
      return value as ReferenceDocument
    },
    validateVersion: validateGradeVersion,
    recordHash: gradeRecordHash,
  }
}

export async function main(): Promise<void> {
  const stopping = new AbortController()
  const stop = () => stopping.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  let phase: WorkerStartupPhase = 'configuration'
  try {
    const config = loadGradeWorkerConfig(process.env)
    phase = 'identity'
    let credential: TokenCredential
    if (config.localDevelopment) credential = new AzureCliCredential({ tenantId: config.tenantId })
    else {
      if (!config.clientId) throw new GradeWorkerError('grade-identity-missing', 'The hosted grade worker requires its dedicated managed identity.')
      credential = new ManagedIdentityCredential({ clientId: config.clientId })
    }
    phase = 'dependencies'
    const dependencies = createGradeWorkerDependencies(config, credential)
    phase = 'processing'
    const result = await runGradeWorker(dependencies, {
      maxItems: config.maxItems, budgetMilliseconds: config.budgetMilliseconds, signal: stopping.signal,
    })
    console.log('Score grade worker completed:', result)
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
      component: 'score-grade-worker', event: 'worker-failed', code: 'grade-worker-failed', ...workerFailureDiagnostic(error),
    }))
    process.exitCode = 1
  })
}
