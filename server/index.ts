import process from 'node:process'
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity'
import type { TokenCredential } from '@azure/identity'
import { createApp } from './app'
import { createAzureDirectoryStore } from './azure-directory-store'
import { createAzureStateStore } from './azure-state-store'
import { ConfigError, loadConfig, type Config } from './config'
import { createAzureJobBlobStore, createAzureJobStore } from './jobs/azure-store'
import { createAzureGradeBlobStore, createAzureGradeStore } from './grades/azure-store'
import { createAzureResumeBlobStore, createAzureResumeStore } from './resumes/azure-store'
import { createAzureAnalysisBlobStore, createAzureAnalysisStore } from './analyses/azure-store'
import { shutdownTelemetry, telemetryPreloaded } from './telemetry-lifecycle'
import { errorCategory } from './telemetry-schema'

const DEFAULT_PORT = 8080

function createCredential(config: Config): TokenCredential {
  if (config.isAppService) {
    // User-assigned managed identity in production; clientId is undefined only for local runs.
    return new ManagedIdentityCredential({ clientId: config.managedIdentityClientId })
  }
  // Config loading already guarantees dev-header (the only non-easyauth mode) cannot reach here in
  // production or on App Service, so an explicitly configured developer's own Azure CLI login is
  // the only other supported credential source. Never account keys, either way.
  return new AzureCliCredential()
}

function readPort(): number {
  const raw = process.env.PORT
  if (!raw) return DEFAULT_PORT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new ConfigError('PORT must be an integer between 1 and 65535.')
  return parsed
}

function main(): void {
  if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim() && !telemetryPreloaded()) {
    console.error('Score telemetry preload is required. Start the server with npm start or the packaged container command.')
    process.exitCode = 1
    return
  }
  let config: Config
  try {
    config = loadConfig(process.env)
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Score server configuration error: ${error.message}`)
      process.exitCode = 1
      return
    }
    throw error
  }

  const credential = createCredential(config)
  const directory = createAzureDirectoryStore(config.cosmos, credential)
  const state = createAzureStateStore(config.storage, credential)
  const jobStorage = config.realJobs ?? config.jobLifecycleStore
  const gradeStorage = config.realGrades ?? config.gradeLifecycleStore
  const jobs = jobStorage
    ? {
        store: createAzureJobStore(jobStorage, credential),
        blobs: createAzureJobBlobStore(jobStorage, credential),
      }
    : undefined
  const grades = gradeStorage
    ? {
        store: createAzureGradeStore(gradeStorage, credential),
        blobs: createAzureGradeBlobStore(gradeStorage, credential),
      }
    : undefined
  const resumeStorage = config.realResumes ?? config.resumeLifecycleStore
  const analysisStorage = config.realAnalyses ?? config.analysisLifecycleStore
  const resumes = resumeStorage
    ? {
        store: createAzureResumeStore(resumeStorage, credential),
        blobs: createAzureResumeBlobStore(resumeStorage, credential),
      }
    : undefined
  const analyses = analysisStorage
    ? {
        store: createAzureAnalysisStore(analysisStorage, credential),
        blobs: createAzureAnalysisBlobStore(analysisStorage, credential),
      }
    : undefined
  const app = createApp({ config, directory, state, jobs, grades, resumes, analyses })
  const reconcile = app.locals.reconcileLifecycle as () => Promise<void>
  const recoverLifecycle = () => { void reconcile().catch((error: unknown) => {
    console.error('Lifecycle recovery is unavailable:', { category: errorCategory(error) })
  }) }
  recoverLifecycle()
  const lifecycleTimer = setInterval(recoverLifecycle, 60_000)
  lifecycleTimer.unref()

  const port = readPort()
  const host = config.authMode === 'dev-header' ? '127.0.0.1' : '0.0.0.0'
  const server = app.listen(port, host, () => {
    console.log(`Score server listening on port ${port}.`)
  })
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    clearInterval(lifecycleTimer)
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(0) }, 8_000)
    void (async () => {
      await new Promise<void>((resolve) => {
        const drainDeadline = setTimeout(() => { server.closeAllConnections(); resolve() }, 4_000)
        server.close(() => { clearTimeout(drainDeadline); resolve() })
      })
      await shutdownTelemetry()
      clearTimeout(deadline)
      process.exit(0)
    })()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

main()
