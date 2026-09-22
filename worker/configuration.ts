import { modelCapabilitiesFor } from '../src/domain/admin-settings-defaults'
import type { ReasoningEffort } from '../src/domain/admin-settings'
import { workerSettingsContainer } from './settings-store'

export const WORKER_CONFIGURATION_FIELDS = [
  'WORKER_AUTH_MODE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID',
  'COSMOS_ENDPOINT', 'COSMOS_DATABASE', 'STORAGE_ACCOUNT_URL', 'SCORE_SETTINGS_CONTAINER',
  'RUBRIC_MODEL_ENDPOINT', 'RUBRIC_MODEL_DEPLOYMENT', 'RUBRIC_MODEL_NAME', 'RUBRIC_MODEL_REASONING_EFFORT',
  'DOCUMENT_INTELLIGENCE_ENDPOINT', 'JOB_RENDERER_URL', 'WORKER_MAX_JOBS',
  'GRADE_WORKER_MAX_ITEMS', 'GRADE_WORKER_BUDGET_MS', 'RESUME_WORKER_MAX_ITEMS', 'RESUME_WORKER_BUDGET_MS',
  'ANALYSIS_WORKER_MAX_ITEMS', 'ANALYSIS_WORKER_BUDGET_MS', 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED',
  'JOB_RECORDS_CONTAINER', 'JOB_SOURCE_CONTAINER', 'GRADE_RECORDS_CONTAINER', 'GRADE_SOURCE_CONTAINER',
  'RESUME_RECORDS_CONTAINER', 'RESUME_SOURCE_CONTAINER', 'ANALYSIS_RECORDS_CONTAINER', 'ANALYSIS_SOURCE_CONTAINER',
  'WORKSPACE_BLOB_CONTAINER', 'COSMOS_CONTAINER',
] as const

export const WORKER_CONFIGURATION_REASONS = [
  'missing', 'invalid-value', 'invalid-identifier', 'invalid-endpoint', 'invalid-integer',
  'store-isolation', 'hosted-auth', 'unsupported-model', 'unsupported-reasoning',
] as const

export type WorkerConfigurationField = typeof WORKER_CONFIGURATION_FIELDS[number]
export type WorkerConfigurationReason = typeof WORKER_CONFIGURATION_REASONS[number]

export class WorkerConfigurationError extends Error {
  constructor(readonly field: WorkerConfigurationField, readonly reason: WorkerConfigurationReason, message: string) {
    super(message)
    this.name = 'WorkerConfigurationError'
  }
}

export interface WorkerModelConfig {
  modelDeployment: string
  modelName: string
  reasoningEffort?: ReasoningEffort
}

export function loadWorkerModelConfig(environment: NodeJS.ProcessEnv): WorkerModelConfig {
  const modelName = environment.RUBRIC_MODEL_NAME?.trim()
  const modelDeployment = environment.RUBRIC_MODEL_DEPLOYMENT?.trim()
  if (!modelName) throw new WorkerConfigurationError('RUBRIC_MODEL_NAME', 'missing', 'RUBRIC_MODEL_NAME is required.')
  if (!modelDeployment) throw new WorkerConfigurationError('RUBRIC_MODEL_DEPLOYMENT', 'missing', 'RUBRIC_MODEL_DEPLOYMENT is required.')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/.test(modelName)) {
    throw new WorkerConfigurationError('RUBRIC_MODEL_NAME', 'invalid-identifier', 'RUBRIC_MODEL_NAME must be a bounded service identifier.')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,299}$/.test(modelDeployment)) {
    throw new WorkerConfigurationError('RUBRIC_MODEL_DEPLOYMENT', 'invalid-identifier', 'RUBRIC_MODEL_DEPLOYMENT must be a bounded service identifier.')
  }
  const capabilities = modelCapabilitiesFor(modelName)
  if (!capabilities.structuredOutputs) {
    throw new WorkerConfigurationError('RUBRIC_MODEL_NAME', 'unsupported-model', 'RUBRIC_MODEL_NAME must identify a supported structured-output model.')
  }
  const reasoning = environment.RUBRIC_MODEL_REASONING_EFFORT?.trim()
  const reasoningEffort = capabilities.reasoningEfforts.find(effort => effort === reasoning)
  if (reasoning && reasoningEffort === undefined) {
    throw new WorkerConfigurationError('RUBRIC_MODEL_REASONING_EFFORT', 'unsupported-reasoning',
      'RUBRIC_MODEL_REASONING_EFFORT is not supported by the configured model.')
  }
  return { modelDeployment, modelName, reasoningEffort }
}

export function loadWorkerSettingsContainer(environment: NodeJS.ProcessEnv): string | undefined {
  try {
    return workerSettingsContainer(environment)
  } catch {
    throw new WorkerConfigurationError('SCORE_SETTINGS_CONTAINER', 'store-isolation',
      'SCORE_SETTINGS_CONTAINER must identify the dedicated application-settings container.')
  }
}
