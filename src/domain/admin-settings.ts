import type { WorkspaceRole } from './cloud'
import type { GradeAgencyType, GradeFunction, GradeSupervision } from './real-grades'
import type { UploadFormat } from './document-formats'
import type { AnalysisReportFormat } from './analysis-reports'
import type { JOB_IMPORT_LIMITS } from './real-jobs'
import type { RESUME_IMPORT_LIMITS } from './real-resumes'
import type { GRADE_LADDER_LIMITS } from './real-grades'
import type { ANALYSIS_LIMITS } from './real-analyses'
import { MODEL_TASK_IDS } from './admin-settings-tasks'

export const ADMIN_SETTINGS_SCHEMA_VERSION = 1 as const
export const RUNTIME_SETTINGS_VERSION = 'score-runtime-settings-v1' as const
export { MODEL_TASK_IDS }
export type ModelTaskId = typeof MODEL_TASK_IDS[number]
export type ProcessingKind = 'jobs' | 'grades' | 'resumes' | 'analyses'
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'
export type SettingsSection = 'ai' | 'intake' | 'grades' | 'processing' | 'presentation' | 'access' | 'operations'

export interface ModelCapabilities {
  structuredOutputs: boolean
  contextTokens: number
  maxOutputTokens: number
  reasoningEfforts: ReasoningEffort[]
  temperature: boolean
  topP: boolean
}

export interface ModelDeployment {
  id: string
  deploymentName: string
  label: string
  description: string
  enabled: boolean
  /** These fields are trusted server inventory, never administrator-supplied capability claims. */
  modelName: string
  modelVersion: string | null
  capabilities: ModelCapabilities
  verification: 'deployment-config' | 'discovered' | 'validated'
  verifiedAt: string | null
}

export interface TaskInputBudget {
  unit: 'characters' | 'bytes' | 'tokens'
  /** Complete source/context allowance; evidence is never silently clipped to meet it. */
  maxInput: number
  /** Complete serialized prompt/schema/request allowance, excluding completion tokens. */
  maxRequest: number
  reservedTokens: number
}

export interface TaskModelSettings {
  /** null inherits the application default. An explicit invalid ID never falls back. */
  deploymentId: string | null
  /** null means omit the parameter, not inherit another task's parameter. */
  reasoningEffort: ReasoningEffort | null
  completionTokenLimit: number
  inputBudget: TaskInputBudget
  temperature: number | null
  topP: number | null
}

export interface HostRule {
  hostname: string
  includeSubdomains: boolean
}
export interface UrlScopePolicy { allowedHosts: HostRule[]; blockedHosts: HostRule[] }
export interface SourceImportPolicy {
  allowedFormats: UploadFormat[]
  allowUrls: boolean
  maxFileBytes: number
  maxBatchItems: number
  maxPdfPages: number
  maxSourceCharacters: number
}
export interface WorkerPolicy {
  maxItemsPerExecution: number
  budgetMilliseconds: number
  pauseClaiming: boolean
}
export interface ProcessingPolicy {
  maxAutomaticAttempts: number
  retryBackoff: { baseMilliseconds: number; maxMilliseconds: number }
}

export interface AdminSettings {
  schemaVersion: 1
  ai: {
    deployments: ModelDeployment[]
    defaultDeploymentId: string
    tasks: Record<ModelTaskId, TaskModelSettings>
    jobRubric: { maxOutputCorrections: number }
    resumeProfile: { maxOutputCorrections: number }
    grades: { maxOutputCorrections: number }
    transport: { maxAttempts: number }
    requestTimeoutMilliseconds: number
  }
  features: {
    jobImports: boolean
    resumeImports: boolean
    gradeLadders: boolean
    newAnalyses: boolean
    summaryGeneration: boolean
    samplesVisible: boolean
  }
  maintenance: { pauseNewWork: boolean; explanation: string }
  imports: {
    jobs: SourceImportPolicy
    resumes: SourceImportPolicy
    urls: {
      requireHttps: boolean
      jobs: UrlScopePolicy
      resumes: UrlScopePolicy
      agencyReferences: UrlScopePolicy
      timeoutMilliseconds: number
      /** Job/resume URLs and rendered subresources; reference originals use grades.references.maxPdfBytes. */
      maxResponseBytes: number
      maxRedirects: number
    }
  }
  documents: { formattedDocxPreviewEnabled: boolean; originalDownloadRoles: WorkspaceRole[] }
  grades: {
    references: {
      maxSources: number
      maxPdfBytes: number
      maxSelectedPages: number
      maxTotalSelectedPages: number
      maxSourceCharacters: number
      pdfChunkPages: number
      maxLinks: number
      allowAgencyUploads: boolean
      allowAgencyUrls: boolean
    }
    maxCriteria: number
    allowedLevels: number[]
    defaults: {
      levels: number[]
      agency: string
      agencyType: GradeAgencyType
      supervision: GradeSupervision
      functions: GradeFunction[]
      specialty: string
    }
    discovery: { maxHops: number; maxRequests: number; maxDocuments: number; maxBytes: number }
  }
  rubrics: { jobs: { maxCriteria: number } }
  analyses: { maxComparisons: number; maxOutputCorrections: number }
  processing: Record<ProcessingKind, ProcessingPolicy>
  summaries: {
    generationMode: 'automatic' | 'on-demand'
    maxRounds: number
    allowManualPublication: boolean
    manualPublicationRoles: 'owner' | 'owner-and-editor'
    historyRoles: 'owner' | 'owner-and-editor'
    historyPageSize: number
    operationTimeoutMilliseconds: number
  }
  workers: Record<ProcessingKind, WorkerPolicy>
  extraction: { transport: { maxAttempts: number }; pollTimeoutMilliseconds: number }
  rendering: {
    timeoutMilliseconds: number
    settleMilliseconds: number
    maxRequests: number
    maxAggregateBytes: number
    maxDomBytes: number
  }
  ui: { polling: { jobsMilliseconds: number; otherProcessingMilliseconds: number } }
  reports: {
    enabledFormats: AnalysisReportFormat[]
    /** null is required when every format is disabled. */
    defaultFormat: AnalysisReportFormat | null
    highlightCount: number
    maxHighlights: number
    title: string
    additionalFooter: string
    maxComparisons: number
    batchComparisons: number
    maxConcurrentBatches: number
    maxInputBytes: number
    maxOutputBytes: number
    maxGenerationMilliseconds: number
    maxPages: number
    maxSlides: number
    allowedRoles: WorkspaceRole[]
  }
  appearance: {
    applicationTitle: string
    defaultTheme: 'system' | 'light' | 'dark'
    announcement: { enabled: boolean; text: string; tone: 'info' | 'warning' }
  }
  navigation: { defaultPage: 'jobs' | 'resumes' | 'rubrics' | 'analyses' }
  help: { supportUrl: string; documentationUrl: string }
  workspaces: { allowCreation: boolean }
  diagnostics: { capturePrivateFailures: boolean }
  logging: { detail: 'normal' | 'diagnostic-metadata' }
}

export interface ResolvedTaskModel extends Omit<TaskModelSettings, 'deploymentId'> {
  taskId: ModelTaskId
  deploymentId: string
  deploymentName: string
  modelName: string
  modelVersion: string | null
  capabilities: ModelCapabilities
}

export interface ProcessingSettingsSnapshot {
  schemaVersion: 1
  revision: string
  capturedAt: string
  /** A complete value copy, not a pointer to mutable current settings. No secrets or endpoints. */
  settings: AdminSettings
  tasks: Record<ModelTaskId, ResolvedTaskModel>
}
export type EffectiveSettingsSnapshot = ProcessingSettingsSnapshot
export type DeepSettingsPatch<T> = T extends readonly unknown[] ? T : T extends object
  ? { [K in keyof T]?: DeepSettingsPatch<T[K]> } : T
export type AdminSettingsPatch = DeepSettingsPatch<AdminSettings>

export interface RuntimeSettingsReadiness {
  configured: boolean
  newProcessingAllowed: boolean
  reason: 'worker-verification-required' | null
  message: string | null
}
export interface PublicSettings {
  schemaVersion: 1
  revision: string
  runtimeEnabled: boolean
  runtimeReadiness: RuntimeSettingsReadiness
  features: AdminSettings['features']
  maintenance: AdminSettings['maintenance']
  imports: { jobs: SourceImportPolicy; resumes: SourceImportPolicy; requireHttps: boolean }
  grades: Pick<AdminSettings['grades'], 'maxCriteria' | 'allowedLevels' | 'defaults' | 'references'>
  rubrics: AdminSettings['rubrics']
  analyses: Pick<AdminSettings['analyses'], 'maxComparisons'>
  summaries: Pick<AdminSettings['summaries'], 'generationMode' | 'allowManualPublication' | 'manualPublicationRoles' | 'historyRoles' | 'historyPageSize'>
  documents: AdminSettings['documents']
  reports: AdminSettings['reports']
  appearance: AdminSettings['appearance']
  navigation: AdminSettings['navigation']
  help: AdminSettings['help']
  workspaces: AdminSettings['workspaces']
  ui: AdminSettings['ui']
}

export interface SettingsDeploymentCapabilities {
  realJobImports: boolean
  realResumeImports: boolean
  realGradeLadders: boolean
  realAnalyses: boolean
  analysisSummaryGeneration: boolean
  wordDocumentImports: boolean
}
export type RuntimeNumericLimits<T> = { -readonly [K in keyof T]: T[K] extends number ? number : T[K] }
export interface PublicFeaturesResponse extends SettingsDeploymentCapabilities {
  markdownJobImports: boolean
  markdownResumeImports: boolean
  limits: RuntimeNumericLimits<typeof JOB_IMPORT_LIMITS>
  resumeLimits: RuntimeNumericLimits<typeof RESUME_IMPORT_LIMITS>
  gradeLimits: RuntimeNumericLimits<typeof GRADE_LADDER_LIMITS>
  analysisLimits: RuntimeNumericLimits<typeof ANALYSIS_LIMITS>
  settingsRevision: string
  runtimeSettingsEnabled: boolean
  runtimeReadiness: RuntimeSettingsReadiness
  publicSettings: PublicSettings
  deploymentCapabilities: SettingsDeploymentCapabilities
}

export interface SettingsFieldError { path: string; message: string }
export interface SettingsFieldMetadata {
  path: string
  label: string
  description: string
  section: SettingsSection
  classification: 'recommended' | 'advanced' | 'read-only'
  control: 'boolean' | 'number' | 'text' | 'select' | 'multiselect' | 'deployments' | 'host-rules' | 'levels'
  units?: string
  min?: number
  max?: number
  options?: readonly string[]
  defaultValue: unknown
  defaultSource: string
  source: 'application-revision'
  scope: 'application'
  activation: 'next-refresh' | 'new-operation' | 'next-execution' | 'deployment'
  prerequisites: string[]
}

export interface SettingsChange { path: string; before: unknown; after: unknown }
export interface SettingsRevision {
  revision: string
  previousRevision: string | null
  createdAt: string
  actor: { tenantId: string; oid: string } | { system: 'initialization' }
  reason: 'initialize' | 'patch' | 'restore' | 'import'
  restoredFrom?: string
  changes: SettingsChange[]
  settings: AdminSettings
}
export interface SettingsHistoryResponse {
  revisions: Omit<SettingsRevision, 'settings'>[]
  nextBefore?: string
}
export interface RuntimeSettingsWorkerVerification {
  workerVersion: typeof RUNTIME_SETTINGS_VERSION
  image: string
  verifiedAt: string
  verificationTimeOnly: true
  liveHealth: false
}
export interface SettingsEnvironment {
  runtimeEnabled: boolean
  runtimeSettingsVersion: typeof RUNTIME_SETTINGS_VERSION
  runtimeReadiness: RuntimeSettingsReadiness
  storeConfigured: boolean
  workerVerification: RuntimeSettingsWorkerVerification | null
  model: {
    endpoint: string | null
    resourceId: string | null
    authentication: 'managed-identity'
    inventoryAvailable: boolean
    probeIdentity: 'api-managed-identity'
    workerIdentityVerified: false
  }
  administratorUserIds: string[]
  tenantId: string
}
export interface AdminSettingsResponse {
  settings: AdminSettings
  revision: string
  etag: string
  createdAt: string
  defaults: AdminSettings
  fields: SettingsFieldMetadata[]
  environment: SettingsEnvironment
}
export interface SettingsExport {
  format: 'score-admin-settings'
  schemaVersion: 1
  exportedAt: string
  sourceRevision: string
  /** Portable settings omit deployment discovery/verification trust metadata. */
  settings: Omit<AdminSettings, 'ai'> & {
    ai: Omit<AdminSettings['ai'], 'deployments'> & {
      deployments: Pick<ModelDeployment, 'id' | 'deploymentName' | 'label' | 'description' | 'enabled'>[]
    }
  }
}
export interface SettingsImportPreview {
  baseRevision: string
  etag: string
  changes: SettingsChange[]
  settings: AdminSettings
}
export interface DeploymentInventory {
  checkedAt: string
  deployments: ModelDeployment[]
}
export interface ModelTestResult {
  kind: 'connection' | 'structured-output' | 'task'
  status: 'passed' | 'failed'
  checkedAt: string
  deploymentId: string
  taskId?: ModelTaskId
  identity: 'api-managed-identity'
  workerIdentityVerified: false
  checks: { name: string; passed: boolean; message: string }[]
  actualModel?: string
}
export interface ModelConfigurationTestRequest {
  kind: ModelTestResult['kind']
  deploymentId?: string
  taskId?: ModelTaskId
  draft?: AdminSettingsPatch
  confirmPaidProbe?: boolean
}

export {
  createDefaultAdminSettings, modelCapabilitiesFor, TASK_MODEL_LIMITS, LEGACY_SETTINGS_REVISION, LEGACY_SETTINGS_CAPTURED_AT,
} from './admin-settings-defaults'
export { adminSettingsSchema, adminSettingsPatchSchema, processingSettingsSnapshotSchema, reportSettingsSchema, parseAdminSettings, mergeAdminSettings, SettingsValidationError } from './admin-settings-schema'
export { ADMIN_SETTINGS_FIELDS } from './admin-settings-fields'
export { ADMIN_SETTINGS_STORAGE_LIMITS, settingsJsonBytes } from './admin-settings-limits'
export { captureProcessingSettings, resolveTaskModel, projectPublicSettings, runtimeSettingsReadiness, diffAdminSettings, hostMatchesRule, urlAllowedBySettings } from './admin-settings-resolver'
