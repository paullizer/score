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
import { createAzureSettingsStore } from './settings/azure-store'
import { AdminSettingsService } from './settings/service'
import { createAzureSettingsModelAdapter } from './settings/models'
import type { StoredSettings } from './settings/store'
import { RUNTIME_SETTINGS_VERSION } from '../src/domain/admin-settings'

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
  const settings = config.settings ? new AdminSettingsService({
    config, store: createAzureSettingsStore(config.settings, credential),
    ...(config.settings.model ? {
      models: createAzureSettingsModelAdapter({
        resource: config.settings.model,
        credential: new ManagedIdentityCredential({ clientId: config.managedIdentityClientId }),
      }),
    } : {}),
  }) : undefined
  const app = createApp({ config, directory, state, jobs, grades, resumes, analyses, settings })
  const bootstrapSettings = app.locals.bootstrapSettings as () => Promise<StoredSettings | undefined>
  const initializeSettings = (): void => {
    void bootstrapSettings().then(current => {
      if (current) console.info('Application settings store initialized:', {
        revision: current.revision.revision, runtimeSettingsVersion: RUNTIME_SETTINGS_VERSION,
        runtimeEnabled: config.settings?.runtimeEnabled === true,
      })
    }, (error: unknown) => {
      console.error('Application settings initialization is unavailable; settings-driven admissions remain fail-closed:', {
        name: error instanceof Error ? error.name : 'UnknownError',
      })
      const retry = setTimeout(initializeSettings, 60_000)
      retry.unref()
    })
  }
  // Initialize using the API's write identity even before runtime activation. Historical reads
  // stay available if this independent store is down; workers only ever read the published data.
  initializeSettings()
  const reconcile = app.locals.reconcileLifecycle as () => Promise<void>
  const recoverLifecycle = () => { void reconcile().catch((error: unknown) => {
    console.error('Lifecycle recovery is unavailable:', { name: error instanceof Error ? error.name : 'UnknownError' })
  }) }
  recoverLifecycle()
  const lifecycleTimer = setInterval(recoverLifecycle, 60_000)
  lifecycleTimer.unref()

  const port = readPort()
  const host = config.authMode === 'dev-header' ? '127.0.0.1' : '0.0.0.0'
  app.listen(port, host, () => {
    console.log(`Score server listening on port ${port}.`)
  })
}

main()
