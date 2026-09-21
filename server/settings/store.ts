import type { AdminSettings, RuntimeSettingsWorkerVerification, SettingsHistoryResponse, SettingsRevision } from '../../src/domain/admin-settings'

export const SETTINGS_APPLICATION_ID = 'score' as const

export interface SettingsModelResource {
  readonly endpoint: string
  readonly resourceId?: string
  readonly deploymentName: string
  readonly modelName: string
}
export interface SettingsConfig {
  readonly cosmosEndpoint: string
  readonly database: string
  readonly container: string
  readonly applicationId: 'score'
  readonly runtimeEnabled: boolean
  readonly model?: SettingsModelResource
  readonly defaults: AdminSettings
  readonly defaultSources?: Readonly<Record<string, string>>
  readonly workerVerification?: RuntimeSettingsWorkerVerification
}

export interface StoredSettings {
  revision: SettingsRevision
  etag: string
}
export type SettingsHistoryPage = SettingsHistoryResponse

export interface SettingsReader {
  /** Only a confirmed missing current pointer returns undefined; corrupt or failed reads throw. */
  getCurrent(): Promise<StoredSettings | undefined>
  getRevision(revision: string): Promise<SettingsRevision | undefined>
}

export interface SettingsStore extends SettingsReader {
  /** Atomically creates pointer, immutable revision and audit. False means only a create conflict. */
  initialize(revision: SettingsRevision): Promise<boolean>
  /** Atomically CAS-replaces the pointer and creates immutable revision + audit. Never retries CAS. */
  publish(revision: SettingsRevision, expectedEtag: string): Promise<StoredSettings>
  history(limit: number, before?: string): Promise<SettingsHistoryPage>
}
