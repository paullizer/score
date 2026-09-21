import {
  captureProcessingSettings, createDefaultAdminSettings, LEGACY_SETTINGS_CAPTURED_AT, LEGACY_SETTINGS_REVISION,
  processingSettingsSnapshotSchema, resolveTaskModel,
  type AdminSettings, type ModelTaskId, type ProcessingKind, type ProcessingSettingsSnapshot,
  type ReasoningEffort, type ResolvedTaskModel, type WorkerPolicy,
} from '../src/domain/admin-settings'
import type { UploadFormat } from '../src/domain/document-formats'
import type { DocumentIntelligenceClientOptions, RubricModelOptions, SafeFetchOptions, StructuredModelRequest } from './runtime'

export interface WorkerSettingsReader {
  readonly mode?: 'configured' | 'unconfigured'
  readonly legacy: ProcessingSettingsSnapshot
  /** Configured readers load once per execution; failures stop claims, never select stale defaults. */
  current(): Promise<ProcessingSettingsSnapshot>
}

export interface WorkerSettingsDependencies {
  settings?: WorkerSettingsReader
}

export class RuntimeSettingsError extends Error {
  readonly retryable = false
  constructor(readonly code: 'settings-invalid' | 'model-context-limit' | 'source-policy-limit', message: string) {
    super(message)
    this.name = 'RuntimeSettingsError'
  }
}

const validated = new WeakMap<object, ProcessingSettingsSnapshot>()
const compatibility = captureProcessingSettings(createDefaultAdminSettings(), LEGACY_SETTINGS_REVISION, LEGACY_SETTINGS_CAPTURED_AT)

export function validateProcessingSettings(snapshot: ProcessingSettingsSnapshot): ProcessingSettingsSnapshot {
  const existing = validated.get(snapshot)
  if (existing) return existing
  const result = processingSettingsSnapshotSchema.safeParse(snapshot)
  if (!result.success) throw new RuntimeSettingsError('settings-invalid', 'The captured processing settings are invalid. No current policy or model was substituted.')
  const frozen = captureProcessingSettings(result.data.settings, result.data.revision, result.data.capturedAt)
  validated.set(snapshot, frozen)
  validated.set(frozen, frozen)
  return frozen
}

export function createLegacyWorkerSettings(
  model: Pick<RubricModelOptions, 'deployment' | 'modelName' | 'reasoningEffort'>,
  workers?: Partial<Record<ProcessingKind, Partial<WorkerPolicy>>>,
): ProcessingSettingsSnapshot {
  return captureProcessingSettings(createDefaultAdminSettings({
    model: {
      deploymentName: model.deployment, modelName: model.modelName,
      reasoningEffort: (model.reasoningEffort as ReasoningEffort | undefined) ?? null,
    },
    workers,
  }), LEGACY_SETTINGS_REVISION, LEGACY_SETTINGS_CAPTURED_AT)
}

/** Legacy work never consults the mutable current-settings reader. */
export function operationSettings(
  record: { processingSettings?: ProcessingSettingsSnapshot },
  dependencies: WorkerSettingsDependencies,
): ProcessingSettingsSnapshot {
  return record.processingSettings !== undefined ? validateProcessingSettings(record.processingSettings) : dependencies.settings?.legacy ?? compatibility
}

export function modelProcessingSettings(model: RubricModelOptions): ProcessingSettingsSnapshot | undefined {
  if (model.processingSettings !== undefined) return validateProcessingSettings(model.processingSettings)
  return undefined
}

export async function executionSettings(
  dependencies: WorkerSettingsDependencies, kind: ProcessingKind,
  fallback: { maxItems: number; budgetMilliseconds: number },
): Promise<WorkerPolicy> {
  if (!dependencies.settings || dependencies.settings.mode === 'unconfigured') {
    return { maxItemsPerExecution: fallback.maxItems, budgetMilliseconds: fallback.budgetMilliseconds, pauseClaiming: false }
  }
  const snapshot = validateProcessingSettings(await dependencies.settings.current())
  return snapshot.settings.workers[kind]
}

export function retryBackoff(snapshot: ProcessingSettingsSnapshot, kind: ProcessingKind, attempts: number): number {
  const { baseMilliseconds, maxMilliseconds } = snapshot.settings.processing[kind].retryBackoff
  return Math.min(maxMilliseconds, baseMilliseconds * 2 ** Math.max(0, attempts - 1))
}

export function taskModelOptions(model: RubricModelOptions, taskId: ModelTaskId): RubricModelOptions {
  const snapshot = modelProcessingSettings(model)
  if (!snapshot) return model
  const task = resolveTaskModel(snapshot, taskId)
  return {
    ...model, processingSettings: snapshot, deployment: task.deploymentName,
    modelName: task.modelName, reasoningEffort: task.reasoningEffort ?? undefined,
  }
}

export function taskForRequest(options: RubricModelOptions, request: StructuredModelRequest): ResolvedTaskModel | undefined {
  const snapshot = request.processingSettings !== undefined
    ? validateProcessingSettings(request.processingSettings) : modelProcessingSettings(options)
  if (!snapshot) return undefined
  if (!request.taskId) throw new RuntimeSettingsError('settings-invalid', 'A captured model request must identify its task. No generic model binding was used.')
  return resolveTaskModel(snapshot, request.taskId)
}

/** UTF-8 bytes are a conservative upper bound, not an assumption of four characters per token. */
export function inputSize(text: string, unit: ResolvedTaskModel['inputBudget']['unit']): number {
  return unit === 'characters' ? text.length : Buffer.byteLength(text, 'utf8')
}

export function assertModelBudget(task: ResolvedTaskModel | undefined, request: StructuredModelRequest, body: object): void {
  if (!task) return
  const serialized = JSON.stringify(body)
  if (inputSize(request.source ?? request.user, task.inputBudget.unit) > task.inputBudget.maxInput ||
    inputSize(serialized, task.inputBudget.unit) > task.inputBudget.maxRequest ||
    Buffer.byteLength(serialized, 'utf8') + task.completionTokenLimit + task.inputBudget.reservedTokens > task.capabilities.contextTokens) {
    throw new RuntimeSettingsError('model-context-limit',
      `The complete ${task.taskId} source or request exceeds its captured model budget. No evidence was truncated.`)
  }
}

export function sourcePolicy(snapshot: ProcessingSettingsSnapshot, kind: 'jobs' | 'resumes'): AdminSettings['imports']['jobs'] {
  return snapshot.settings.imports[kind]
}

export function assertSourceKind(snapshot: ProcessingSettingsSnapshot, scope: 'jobs' | 'resumes', kind: UploadFormat | 'url'): void {
  const policy = sourcePolicy(snapshot, scope)
  if (kind === 'url' ? !policy.allowUrls : !policy.allowedFormats.includes(kind)) {
    throw new RuntimeSettingsError('source-policy-limit', 'This source format is not allowed by the operation’s captured import policy.')
  }
}

export function extractionSettings(
  options: DocumentIntelligenceClientOptions, snapshot: ProcessingSettingsSnapshot,
): DocumentIntelligenceClientOptions {
  return {
    ...options, maxAttempts: snapshot.settings.extraction.transport.maxAttempts,
    pollTimeoutMilliseconds: snapshot.settings.extraction.pollTimeoutMilliseconds,
  }
}

export function fetchSettings(
  options: SafeFetchOptions | undefined, snapshot: ProcessingSettingsSnapshot, scope: 'jobs' | 'resumes' | 'agencyReferences' | 'opm',
): SafeFetchOptions {
  const { urls } = snapshot.settings.imports
  const urlPolicy = {
    ...(scope === 'opm'
      ? { allowedHosts: [{ hostname: 'opm.gov', includeSubdomains: true }], blockedHosts: [] }
      : urls[scope]),
    requireHttps: urls.requireHttps,
  }
  const lower = (value: number | undefined, maximum: number, minimum = 1): number =>
    value === undefined ? maximum : Number.isSafeInteger(value) && value >= minimum ? Math.min(value, maximum) : value
  return {
    ...options,
    timeoutMilliseconds: lower(options?.timeoutMilliseconds, urls.timeoutMilliseconds),
    maxBytes: lower(options?.maxBytes, urls.maxResponseBytes),
    maxRedirects: lower(options?.maxRedirects, urls.maxRedirects, 0),
    urlPolicy,
    renderPolicy: {
      rendering: snapshot.settings.rendering,
      urls: {
        ...urlPolicy, timeoutMilliseconds: urls.timeoutMilliseconds,
        maxResponseBytes: urls.maxResponseBytes, maxRedirects: urls.maxRedirects,
      },
    },
  }
}

export function assertSourcePolicy(
  paragraphs: readonly { text: string; heading: string; page: number }[],
  snapshot: ProcessingSettingsSnapshot, kind: 'jobs' | 'resumes', isPdf: boolean,
): void {
  const policy = sourcePolicy(snapshot, kind)
  if (paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length + paragraph.heading.length, 0) > policy.maxSourceCharacters) {
    throw new RuntimeSettingsError('source-policy-limit', `The extracted source exceeds its captured ${policy.maxSourceCharacters}-character limit. No evidence was truncated.`)
  }
  if (isPdf && paragraphs.some(paragraph => paragraph.page > policy.maxPdfPages)) {
    throw new RuntimeSettingsError('source-policy-limit', `The PDF exceeds its captured ${policy.maxPdfPages}-page limit.`)
  }
}

export function safeSettingsMetadata(snapshot: ProcessingSettingsSnapshot, taskId?: ModelTaskId): object {
  return {
    settingsRevision: snapshot.revision,
    ...(taskId ? { taskId, deployment: snapshot.tasks[taskId].deploymentName } : {}),
    ...(snapshot.settings.logging.detail === 'diagnostic-metadata' ? {
      schemaVersion: snapshot.schemaVersion,
      ...(taskId ? { inputBudget: snapshot.tasks[taskId].inputBudget, completionTokenLimit: snapshot.tasks[taskId].completionTokenLimit } : {}),
    } : {}),
  }
}
