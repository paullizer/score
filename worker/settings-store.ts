import type { TokenCredential } from '@azure/identity'
import { captureProcessingSettings, LEGACY_SETTINGS_REVISION, type ProcessingSettingsSnapshot } from '../src/domain/admin-settings'
import { createAzureSettingsReader } from '../server/settings/azure-store'
import type { SettingsReader } from '../server/settings/store'
import type { RubricModelOptions } from './runtime'
import { createLegacyWorkerSettings, validateProcessingSettings, type WorkerSettingsReader } from './settings'

export function workerSettingsContainer(environment: NodeJS.ProcessEnv): string | undefined {
  if (environment.SCORE_SETTINGS_CONTAINER === undefined) return undefined
  if (environment.SCORE_SETTINGS_CONTAINER.trim() !== 'application-settings') {
    throw new Error('SCORE_SETTINGS_CONTAINER must identify the dedicated application-settings container.')
  }
  return 'application-settings'
}

export function createWorkerSettingsReader(
  bootstrap: ProcessingSettingsSnapshot | undefined, store?: SettingsReader,
): WorkerSettingsReader {
  let legacy: ProcessingSettingsSnapshot | undefined
  if (!store) {
    if (bootstrap === undefined) throw new Error('An unconfigured worker requires an explicit bootstrap policy.')
    legacy = validateProcessingSettings(bootstrap)
  }
  function loadedLegacy() {
    if (!legacy) throw new Error('The immutable legacy settings baseline must be loaded before processing work.')
    return legacy
  }
  return {
    mode: store ? 'configured' : 'unconfigured',
    get legacy() {
      return loadedLegacy()
    },
    async current() {
      if (!store) return loadedLegacy()
      const current = await store.getCurrent()
      if (!current) throw new Error('The application settings store is not initialized; this read-only worker cannot initialize it. No work was claimed.')
      if (!legacy) {
        const baseline = current.revision.revision === LEGACY_SETTINGS_REVISION
          ? current.revision : await store.getRevision(LEGACY_SETTINGS_REVISION)
        if (!baseline || baseline.revision !== LEGACY_SETTINGS_REVISION) {
          throw new Error('The immutable legacy settings baseline is missing. No mutable defaults were substituted.')
        }
        legacy = captureProcessingSettings(baseline.settings, baseline.revision, baseline.createdAt)
      }
      return captureProcessingSettings(current.revision.settings, current.revision.revision, current.revision.createdAt)
    },
  }
}

export function createAzureWorkerSettings(
  config: { stores: { cosmosEndpoint: string; database: string }; settingsContainer?: string },
  credential: TokenCredential,
  model: Pick<RubricModelOptions, 'deployment' | 'modelName' | 'reasoningEffort'>,
): WorkerSettingsReader {
  // Legacy execution limits remain entrypoint options, not newly validated saved-policy fields.
  if (!config.settingsContainer) return createWorkerSettingsReader(createLegacyWorkerSettings(model))
  const store = createAzureSettingsReader({
    cosmosEndpoint: config.stores.cosmosEndpoint, database: config.stores.database,
    container: config.settingsContainer, applicationId: 'score',
  }, credential)
  return createWorkerSettingsReader(undefined, store)
}
