import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ADMIN_SETTINGS_FIELDS, LEGACY_SETTINGS_REVISION, RUNTIME_SETTINGS_VERSION, captureProcessingSettings, createDefaultAdminSettings,
  diffAdminSettings, mergeAdminSettings, parseAdminSettings, resolveTaskModel, runtimeSettingsReadiness, SettingsValidationError,
} from '../../src/domain/admin-settings'
import type {
  AdminSettings, AdminSettingsResponse, DeploymentInventory, ModelDeployment, ModelTaskId, ModelTestResult,
  ProcessingSettingsSnapshot, SettingsEnvironment, SettingsExport, SettingsImportPreview, SettingsRevision,
} from '../../src/domain/admin-settings'
import type { AuthenticatedPrincipal } from '../auth'
import type { Config } from '../config'
import { conflict, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { StoreConflictError } from '../store'
import { settingsRevisionSchema } from './azure-store'
import type { SettingsModelAdapter } from './models'
import type { SettingsHistoryPage, SettingsStore, StoredSettings } from './store'
import type { PromptRegistryCapture } from './prompts'
import { validatePromptSnapshot } from './prompt-integrity'

export interface AdminSettingsServiceDeps {
  config: Config
  store: SettingsStore
  models?: SettingsModelAdapter
  prompts?: PromptRegistryCapture
  now?: () => Date
  newId?: () => string
}
const revisionId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const portableDeployment = z.strictObject({
  id: revisionId, deploymentName: revisionId, label: z.string().min(1).max(100),
  description: z.string().max(500), enabled: z.boolean(),
})
const importEnvelope = z.strictObject({
  format: z.literal('score-admin-settings'), schemaVersion: z.literal(1), exportedAt: z.iso.datetime(),
  sourceRevision: revisionId, settings: z.record(z.string(), z.unknown()),
})
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function trustedMetadata(deployment: ModelDeployment) {
  return {
    deploymentName: deployment.deploymentName, modelName: deployment.modelName, modelVersion: deployment.modelVersion,
    capabilities: deployment.capabilities, verification: deployment.verification, verifiedAt: deployment.verifiedAt,
  }
}

export class AdminSettingsService {
  private readonly config: Config
  private readonly store: SettingsStore
  private readonly models?: SettingsModelAdapter
  private readonly prompts?: PromptRegistryCapture
  private readonly clock: () => Date
  private readonly newId: () => string
  private readonly defaults: AdminSettings

  constructor(deps: AdminSettingsServiceDeps) {
    this.config = deps.config
    this.store = deps.store
    this.models = deps.models
    this.prompts = deps.prompts
    this.clock = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
    this.defaults = parseAdminSettings(deps.config.settings?.defaults ?? createDefaultAdminSettings())
  }

  get runtimeEnabled(): boolean { return this.config.settings?.runtimeEnabled === true }

  environment(): SettingsEnvironment {
    const verification = this.config.settings?.workerVerification
    return {
      runtimeEnabled: this.runtimeEnabled, runtimeSettingsVersion: RUNTIME_SETTINGS_VERSION, storeConfigured: true,
      runtimeReadiness: runtimeSettingsReadiness(this.runtimeEnabled, true),
      workerVerification: verification ? {
        workerVersion: verification.workerVersion, image: verification.image, verifiedAt: verification.verifiedAt,
        verificationTimeOnly: true, liveHealth: false,
      } : null,
      model: {
        endpoint: this.config.settings?.model?.endpoint ?? null, resourceId: this.config.settings?.model?.resourceId ?? null,
        authentication: 'managed-identity', inventoryAvailable: Boolean(this.config.settings?.model?.resourceId && this.models),
        probeIdentity: 'api-managed-identity', workerIdentityVerified: false,
      },
      administratorUserIds: [...this.config.adminUserIds ?? []].sort(), tenantId: this.config.tenantId,
    }
  }

  async current(): Promise<StoredSettings> {
    let stored = await this.store.getCurrent()
    if (!stored) {
      const baseline: SettingsRevision = {
        revision: LEGACY_SETTINGS_REVISION, previousRevision: null, createdAt: this.clock().toISOString(),
        actor: { system: 'initialization' }, reason: 'initialize', changes: [], settings: structuredClone(this.defaults),
      }
      captureProcessingSettings(baseline.settings, baseline.revision, baseline.createdAt)
      await this.store.initialize(baseline)
      stored = await this.store.getCurrent()
      if (!stored) throw unavailable('Settings initialization could not be confirmed. No defaults were substituted for a failed read.')
    }
    if (!stored.etag || stored.etag === '*') throw unavailable('Application settings are missing their concurrency version.')
    // Store adapters/fakes cannot turn malformed persistent configuration into implicit defaults.
    return { etag: stored.etag, revision: settingsRevisionSchema.parse(stored.revision) }
  }

  async read(): Promise<AdminSettingsResponse> {
    return this.response(await this.current())
  }

  private response(stored: StoredSettings): AdminSettingsResponse {
    return {
      settings: structuredClone(stored.revision.settings), revision: stored.revision.revision, etag: stored.etag,
      createdAt: stored.revision.createdAt, defaults: structuredClone(this.defaults),
      fields: ADMIN_SETTINGS_FIELDS.map(field => {
        let value: unknown = this.defaults
        for (const key of field.path.split('.')) value = object(value) ? value[key] : undefined
        return {
          ...structuredClone(field), defaultValue: structuredClone(value),
          defaultSource: this.config.settings?.defaultSources?.[field.path] ?? field.defaultSource,
        }
      }),
      environment: this.environment(),
    }
  }

  /** Saved policy stays authoritative even while rollout temporarily closes new processing. */
  async capture(): Promise<ProcessingSettingsSnapshot> {
    const stored = await this.current()
    const promptBundle = this.prompts ? await this.prompts.capture() : undefined
    if (this.prompts && !promptBundle) throw unavailable('The configured accepted-work prompt bundle is unavailable. No compiled default was substituted.')
    if (promptBundle) validatePromptSnapshot(promptBundle)
    return captureProcessingSettings(stored.revision.settings, stored.revision.revision, this.clock().toISOString(), promptBundle)
  }

  /** Accepted legacy work uses the immutable persisted baseline, never today's admin or env defaults. */
  async captureLegacy(): Promise<ProcessingSettingsSnapshot> {
    let revision = await this.store.getRevision(LEGACY_SETTINGS_REVISION)
    if (!revision) {
      // An API retry can precede startup bootstrap. Existing current policy is never used as
      // the baseline, and current() never recreates missing history behind an existing pointer.
      await this.current()
      revision = await this.store.getRevision(LEGACY_SETTINGS_REVISION)
    }
    if (!revision) throw unavailable('The immutable legacy settings baseline is unavailable; no replacement defaults were used.')
    const validated = settingsRevisionSchema.parse(revision)
    if (validated.revision !== LEGACY_SETTINGS_REVISION) throw unavailable('The immutable legacy settings baseline has inconsistent identity.')
    return captureProcessingSettings(validated.settings, validated.revision, validated.createdAt)
  }

  private requireMatch(current: StoredSettings, ifMatch: string | undefined): string {
    if (!ifMatch) throw preconditionRequired('An exact If-Match ETag is required to publish application settings.')
    if (ifMatch === '*' || ifMatch.startsWith('W/') || ifMatch.includes(',') || ifMatch.trim() !== ifMatch) {
      throw invalidRequest('Use the single exact ETag from the settings response; wildcard and weak ETags are not accepted.')
    }
    if (ifMatch !== current.etag) throw conflict('Application settings changed since this draft was loaded. Keep your draft, reload, and review the differences.')
    return ifMatch
  }

  private async authoritativeCatalog(
    candidate: AdminSettings, current: AdminSettings, forceRefresh = false, discovered?: DeploymentInventory,
  ): Promise<AdminSettings> {
    const known = new Map(current.ai.deployments.map(deployment => [deployment.id, deployment]))
    const changedTrust = candidate.ai.deployments.some(deployment => {
      const old = known.get(deployment.id)
      return !old || (deployment.enabled && !old.enabled) || JSON.stringify(trustedMetadata(old)) !== JSON.stringify(trustedMetadata(deployment))
    })
    if (!changedTrust && !forceRefresh) return parseAdminSettings(candidate)
    const inventory = discovered ?? await this.models?.inventory()
    if (!inventory) throw unavailable('Deployment inventory is unavailable. Discovery/verification metadata cannot be supplied or changed manually.')
    const actual = new Map(inventory.deployments.map(deployment => [deployment.deploymentName, deployment]))
    const deployments = candidate.ai.deployments.map(deployment => {
      const found = actual.get(deployment.deploymentName)
      if (!found) throw new SettingsValidationError([{ path: 'ai.deployments', message: `Deployment "${deployment.deploymentName}" is not present in the configured Azure resource.` }])
      if (deployment.enabled && !found.enabled) throw new SettingsValidationError([{ path: 'ai.deployments', message: `Deployment "${deployment.deploymentName}" is not ready or does not have a supported structured-output adapter.` }])
      return { ...found, id: deployment.id, label: deployment.label, description: deployment.description, enabled: deployment.enabled }
    })
    return parseAdminSettings({ ...candidate, ai: { ...candidate.ai, deployments } })
  }

  async patch(principal: AuthenticatedPrincipal, patch: unknown, ifMatch: string | undefined): Promise<AdminSettingsResponse> {
    const current = await this.current()
    const expected = this.requireMatch(current, ifMatch)
    const candidate = await this.authoritativeCatalog(mergeAdminSettings(current.revision.settings, patch), current.revision.settings)
    return this.publish(principal, candidate, current, expected, 'patch')
  }

  private async publish(
    principal: AuthenticatedPrincipal, settings: AdminSettings, current: StoredSettings, expectedEtag: string,
    reason: 'patch' | 'restore' | 'import', restoredFrom?: string,
  ): Promise<AdminSettingsResponse> {
    const timestamp = this.clock().toISOString()
    const revision = `r-${timestamp.replace(/[-:.TZ]/g, '')}-${this.newId()}`
    const value: SettingsRevision = {
      revision, previousRevision: current.revision.revision, createdAt: timestamp,
      actor: { tenantId: principal.tenantId, oid: principal.oid }, reason,
      ...(restoredFrom ? { restoredFrom } : {}), changes: diffAdminSettings(current.revision.settings, settings), settings,
    }
    captureProcessingSettings(settings, revision, timestamp)
    try { return this.response(await this.store.publish(value, expectedEtag)) } catch (error) {
      if (error instanceof StoreConflictError) throw conflict('Application settings changed before publication. Keep your draft and review the new version.')
      throw error
    }
  }

  async history(limit = 20, before?: string): Promise<SettingsHistoryPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (before !== undefined && !revisionId.safeParse(before).success)) {
      throw invalidRequest('Use a history limit from 1 to 100 and a valid revision cursor.')
    }
    await this.current()
    return this.store.history(limit, before)
  }

  async revision(revision: string): Promise<SettingsRevision> {
    if (!revisionId.safeParse(revision).success) throw invalidRequest('Invalid settings revision identifier.')
    const stored = await this.store.getRevision(revision)
    if (!stored) throw notFound('This application-settings revision does not exist.')
    return settingsRevisionSchema.parse(stored)
  }

  async restore(principal: AuthenticatedPrincipal, revision: string, ifMatch: string | undefined): Promise<AdminSettingsResponse> {
    const current = await this.current()
    const expected = this.requireMatch(current, ifMatch)
    const old = await this.revision(revision)
    const candidate = await this.authoritativeCatalog(old.settings, current.revision.settings, Boolean(this.models))
    return this.publish(principal, candidate, current, expected, 'restore', revision)
  }

  async export(): Promise<SettingsExport> {
    const current = await this.current()
    const { ai, ...settings } = structuredClone(current.revision.settings)
    return {
      format: 'score-admin-settings', schemaVersion: 1, exportedAt: this.clock().toISOString(), sourceRevision: current.revision.revision,
      settings: {
        ...settings, ai: {
          ...ai, deployments: ai.deployments.map(({ id, deploymentName, label, description, enabled }) => ({ id, deploymentName, label, description, enabled })),
        },
      },
    }
  }

  private async importCandidate(document: unknown, current: AdminSettings): Promise<AdminSettings> {
    const parsed = importEnvelope.safeParse(document)
    if (!parsed.success) throw invalidRequest('Import must be a strict version-1 score-admin-settings export, without bootstrap or credential fields.')
    const ai = parsed.data.settings.ai
    if (!object(ai)) throw invalidRequest('Imported settings must include the complete AI settings object.')
    const catalog = z.array(portableDeployment).min(1).max(100).safeParse(ai.deployments)
    if (!catalog.success) throw invalidRequest('Import deployment entries may contain only id, deploymentName, label, description and enabled.')
    let discovered: DeploymentInventory | undefined
    const deployments: ModelDeployment[] = []
    for (const entry of catalog.data) {
      let found = current.ai.deployments.find(deployment => deployment.deploymentName === entry.deploymentName)
      if (!found) {
        if (!this.models) throw unavailable('Scoped Azure deployment discovery is required before importing an unknown deployment.')
        discovered ??= await this.models.inventory()
        found = discovered.deployments.find(deployment => deployment.deploymentName === entry.deploymentName)
      }
      if (!found) throw new SettingsValidationError([{ path: 'ai.deployments', message: `Imported deployment "${entry.deploymentName}" is not present in the fixed Azure resource.` }])
      if (entry.enabled && !found.capabilities.structuredOutputs) throw invalidRequest('An imported enabled deployment lacks the supported structured-output adapter.')
      deployments.push({ ...found, ...entry })
    }
    return this.authoritativeCatalog(parseAdminSettings({ ...parsed.data.settings, ai: { ...ai, deployments } }), current, false, discovered)
  }

  async previewImport(document: unknown, ifMatch: string | undefined): Promise<SettingsImportPreview> {
    const current = await this.current()
    this.requireMatch(current, ifMatch)
    const settings = await this.importCandidate(document, current.revision.settings)
    return { baseRevision: current.revision.revision, etag: current.etag, settings, changes: diffAdminSettings(current.revision.settings, settings) }
  }

  async applyImport(principal: AuthenticatedPrincipal, document: unknown, ifMatch: string | undefined, confirmed: boolean): Promise<AdminSettingsResponse> {
    if (!confirmed) throw invalidRequest('Review the import preview and explicitly confirm before applying settings.')
    const current = await this.current()
    const expected = this.requireMatch(current, ifMatch)
    const settings = await this.importCandidate(document, current.revision.settings)
    return this.publish(principal, settings, current, expected, 'import')
  }

  async inventory(): Promise<DeploymentInventory> {
    if (!this.models) throw unavailable('The fixed Azure resource and scoped deployment-read adapter are not configured.')
    const current = await this.current()
    const inventory = await this.models.inventory()
    return {
      ...inventory,
      deployments: inventory.deployments.map(deployment => {
        const old = current.revision.settings.ai.deployments.find(item => item.deploymentName === deployment.deploymentName)
        return old ? { ...deployment, id: old.id, label: old.label, description: old.description, enabled: old.enabled && deployment.enabled } : deployment
      }),
    }
  }

  async test(input: {
    kind: 'connection' | 'structured-output' | 'task'
    taskId?: ModelTaskId
    deploymentId?: string
    draft?: unknown
    confirmPaidProbe: boolean
  }): Promise<ModelTestResult> {
    if (!this.models) throw unavailable('The API managed-identity model validation adapter is not configured.')
    const current = await this.current()
    const candidate = input.draft === undefined ? current.revision.settings
      : await this.authoritativeCatalog(mergeAdminSettings(current.revision.settings, input.draft), current.revision.settings)
    const task = input.kind === 'task'
      ? input.taskId ? resolveTaskModel(candidate, input.taskId) : undefined : undefined
    if (input.kind === 'task' && !task) throw invalidRequest('Select a task for a synthetic task-configuration probe.')
    if (task && input.deploymentId && task.deploymentId !== input.deploymentId) {
      throw invalidRequest('The draft task is bound to a different deployment. Update its binding before testing; no substitution was made.')
    }
    const deployment = candidate.ai.deployments.find(item => item.id === (task?.deploymentId ?? input.deploymentId ?? candidate.ai.defaultDeploymentId))
    if (!deployment) throw invalidRequest('The selected deployment does not exist; no fallback was used.')
    return this.models.test({ kind: input.kind, deployment, task, settings: candidate, confirmPaidProbe: input.confirmPaidProbe })
  }
}
