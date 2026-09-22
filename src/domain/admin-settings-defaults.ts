import { MODEL_TASK_IDS } from './admin-settings-tasks'
import type { AdminSettings, ModelCapabilities, ModelTaskId, ProcessingKind, ReasoningEffort, TaskInputBudget, TaskModelSettings, WorkerPolicy } from './admin-settings'

export const LEGACY_SETTINGS_REVISION = 'legacy-v1'
export const LEGACY_SETTINGS_CAPTURED_AT = '1970-01-01T00:00:00.000Z'
const MIB = 1024 * 1024

export const TASK_MODEL_LIMITS: Readonly<Record<ModelTaskId, { readonly completionTokenLimit: number; readonly inputBudget: Readonly<TaskInputBudget> }>> = {
  jobRubric: { completionTokenLimit: 8_192, inputBudget: { unit: 'characters', maxInput: 180_000, maxRequest: 240_000, reservedTokens: 2_048 } },
  resumeProfile: { completionTokenLimit: 16_384, inputBudget: { unit: 'tokens', maxInput: 381_568, maxRequest: 381_568, reservedTokens: 2_048 } },
  gradeCompetencies: { completionTokenLimit: 12_000, inputBudget: { unit: 'characters', maxInput: 180_000, maxRequest: 180_000, reservedTokens: 2_048 } },
  gradeDraft: { completionTokenLimit: 24_000, inputBudget: { unit: 'characters', maxInput: 180_000, maxRequest: 180_000, reservedTokens: 2_048 } },
  gradeReview: { completionTokenLimit: 16_000, inputBudget: { unit: 'characters', maxInput: 180_000, maxRequest: 180_000, reservedTokens: 2_048 } },
  assessment: { completionTokenLimit: 16_384, inputBudget: { unit: 'characters', maxInput: 240_000, maxRequest: 240_000, reservedTokens: 2_048 } },
  assessmentReview: { completionTokenLimit: 12_288, inputBudget: { unit: 'characters', maxInput: 240_000, maxRequest: 240_000, reservedTokens: 2_048 } },
  candidateSummary: { completionTokenLimit: 4_096, inputBudget: { unit: 'bytes', maxInput: 96_000, maxRequest: 288_000, reservedTokens: 2_048 } },
  targetSummary: { completionTokenLimit: 12_288, inputBudget: { unit: 'bytes', maxInput: 96_000, maxRequest: 288_000, reservedTokens: 2_048 } },
  summaryReduction: { completionTokenLimit: 16_384, inputBudget: { unit: 'bytes', maxInput: 96_000, maxRequest: 288_000, reservedTokens: 2_048 } },
  summaryReview: { completionTokenLimit: 8_192, inputBudget: { unit: 'bytes', maxInput: 96_000, maxRequest: 288_000, reservedTokens: 2_048 } },
}
for (const limits of Object.values(TASK_MODEL_LIMITS)) {
  Object.freeze(limits.inputBudget)
  Object.freeze(limits)
}
Object.freeze(TASK_MODEL_LIMITS)

/** Deliberately allowlisted adapters, not capabilities inferred from a deployment's display name. */
export function modelCapabilitiesFor(modelName: string, modelVersion: string | null = null): ModelCapabilities {
  if (['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].includes(modelName) && (modelVersion === null || modelVersion === '2025-08-07')) {
    return {
      structuredOutputs: true, contextTokens: 400_000, maxOutputTokens: 128_000,
      reasoningEfforts: ['minimal', 'low', 'medium', 'high'], temperature: false, topP: false,
    }
  }
  if (modelName === 'gpt-5.6-luna' && (modelVersion === null || modelVersion === '2026-07-09')) {
    // Azure's verified Luna adapter; expose only efforts represented by the existing application schema.
    return {
      structuredOutputs: true, contextTokens: 1_050_000, maxOutputTokens: 128_000,
      reasoningEfforts: ['low', 'medium', 'high'], temperature: false, topP: false,
    }
  }
  if (modelName === 'gpt-4o' && (modelVersion === null || ['2024-08-06', '2024-11-20'].includes(modelVersion))) {
    return { structuredOutputs: true, contextTokens: 128_000, maxOutputTokens: 16_384, reasoningEfforts: [], temperature: true, topP: true }
  }
  if (modelName === 'gpt-4o-mini' && (modelVersion === null || modelVersion === '2024-07-18')) {
    return { structuredOutputs: true, contextTokens: 128_000, maxOutputTokens: 16_384, reasoningEfforts: [], temperature: true, topP: true }
  }
  if (['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'].includes(modelName) && (modelVersion === null || modelVersion === '2025-04-14')) {
    return { structuredOutputs: true, contextTokens: 1_047_576, maxOutputTokens: 32_768, reasoningEfforts: [], temperature: true, topP: true }
  }
  return { structuredOutputs: false, contextTokens: 0, maxOutputTokens: 0, reasoningEfforts: [], temperature: false, topP: false }
}

export interface AdminSettingsDefaultsOptions {
  model?: { deploymentName: string; modelName: string; reasoningEffort?: ReasoningEffort | null }
  workers?: Partial<Record<ProcessingKind, Partial<WorkerPolicy>>>
}

export function createDefaultAdminSettings(options: AdminSettingsDefaultsOptions = {}): AdminSettings {
  const model = options.model ?? { deploymentName: 'job-rubric', modelName: 'gpt-5-mini', reasoningEffort: 'low' }
  const tasks = Object.fromEntries(MODEL_TASK_IDS.map(task => [task, {
    deploymentId: null, reasoningEffort: model.reasoningEffort ?? null,
    completionTokenLimit: TASK_MODEL_LIMITS[task].completionTokenLimit,
    inputBudget: { ...TASK_MODEL_LIMITS[task].inputBudget }, temperature: null, topP: null,
  } satisfies TaskModelSettings])) as Record<ModelTaskId, TaskModelSettings>
  const source = () => ({
    allowedFormats: ['pdf', 'markdown', 'docx', 'doc'] as AdminSettings['imports']['jobs']['allowedFormats'],
    allowUrls: true, maxFileBytes: 10 * MIB, maxBatchItems: 10, maxPdfPages: 50, maxSourceCharacters: 180_000,
  })
  const hosts = () => ({ allowedHosts: [], blockedHosts: [] })
  const worker = (kind: ProcessingKind, maxItemsPerExecution: number): WorkerPolicy => ({
    maxItemsPerExecution, budgetMilliseconds: 660_000, pauseClaiming: false, ...options.workers?.[kind],
  })
  return {
    schemaVersion: 1,
    ai: {
      deployments: [{
        id: 'default', deploymentName: model.deploymentName, label: model.deploymentName, description: '', enabled: true,
        modelName: model.modelName, modelVersion: null, capabilities: modelCapabilitiesFor(model.modelName),
        verification: 'deployment-config', verifiedAt: null,
      }],
      defaultDeploymentId: 'default', tasks,
      jobRubric: { maxOutputCorrections: 1 }, resumeProfile: { maxOutputCorrections: 1 }, grades: { maxOutputCorrections: 1 },
      transport: { maxAttempts: 2 }, requestTimeoutMilliseconds: 60_000,
    },
    features: { jobImports: true, resumeImports: true, gradeLadders: true, newAnalyses: true, summaryGeneration: true, samplesVisible: true },
    maintenance: { pauseNewWork: false, explanation: '' },
    imports: {
      jobs: source(), resumes: source(),
      urls: {
        requireHttps: false, jobs: hosts(), resumes: hosts(), agencyReferences: hosts(),
        timeoutMilliseconds: 30_000, maxResponseBytes: 12 * MIB, maxRedirects: 5,
      },
    },
    documents: { formattedDocxPreviewEnabled: true, originalDownloadRoles: ['owner', 'editor', 'viewer'] },
    grades: {
      references: {
        maxSources: 15, maxPdfBytes: 20 * MIB, maxSelectedPages: 250, maxTotalSelectedPages: 500,
        maxSourceCharacters: 2_000_000, pdfChunkPages: 50, maxLinks: 2_000,
        allowAgencyUploads: true, allowAgencyUrls: true,
      },
      maxCriteria: 20, allowedLevels: Array.from({ length: 15 }, (_, i) => i + 1),
      defaults: { levels: [], agency: '', agencyType: 'unknown', supervision: 'unknown', functions: [], specialty: '' },
      discovery: { maxHops: 2, maxRequests: 80, maxDocuments: 35, maxBytes: 64 * MIB },
    },
    rubrics: { jobs: { maxCriteria: 20 } },
    analyses: { maxComparisons: 500, maxOutputCorrections: 2 },
    processing: {
      jobs: { maxAutomaticAttempts: 3, retryBackoff: { baseMilliseconds: 15_000, maxMilliseconds: 300_000 } },
      grades: { maxAutomaticAttempts: 3, retryBackoff: { baseMilliseconds: 30_000, maxMilliseconds: 120_000 } },
      resumes: { maxAutomaticAttempts: 3, retryBackoff: { baseMilliseconds: 15_000, maxMilliseconds: 60_000 } },
      analyses: { maxAutomaticAttempts: 3, retryBackoff: { baseMilliseconds: 30_000, maxMilliseconds: 120_000 } },
    },
    summaries: {
      generationMode: 'automatic', maxRounds: 3, allowManualPublication: true,
      manualPublicationRoles: 'owner-and-editor', historyRoles: 'owner-and-editor',
      historyPageSize: 12, operationTimeoutMilliseconds: 600_000,
    },
    workers: { jobs: worker('jobs', 4), grades: worker('grades', 5), resumes: worker('resumes', 5), analyses: worker('analyses', 2) },
    extraction: { transport: { maxAttempts: 3 }, pollTimeoutMilliseconds: 240_000 },
    rendering: { timeoutMilliseconds: 30_000, settleMilliseconds: 2_000, maxRequests: 80, maxAggregateBytes: 8 * MIB, maxDomBytes: 2 * MIB },
    ui: { polling: { jobsMilliseconds: 2_000, otherProcessingMilliseconds: 3_000 } },
    reports: {
      enabledFormats: ['csv', 'pdf', 'docx', 'pptx'], defaultFormat: 'pdf', highlightCount: 5, maxHighlights: 10,
      title: 'Analysis evidence report', additionalFooter: '', maxComparisons: 500,
      batchComparisons: 25, maxConcurrentBatches: 3, maxInputBytes: 32 * MIB, maxOutputBytes: 64 * MIB,
      maxGenerationMilliseconds: 180_000, maxPages: 10_000, maxSlides: 10_000, allowedRoles: ['owner', 'editor', 'viewer'],
    },
    appearance: { applicationTitle: 'Score', defaultTheme: 'system', announcement: { enabled: false, text: '', tone: 'info' } },
    navigation: { defaultPage: 'jobs' }, help: { supportUrl: '', documentationUrl: '' },
    workspaces: { allowCreation: true }, diagnostics: { capturePrivateFailures: true }, logging: { detail: 'normal' },
  }
}
