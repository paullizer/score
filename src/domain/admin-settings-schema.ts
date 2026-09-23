import { z } from 'zod'
import { LEGACY_MODEL_TASK_IDS, MODEL_TASK_IDS } from './admin-settings-tasks'
import type { AdminSettings, AdminSettingsPatch, CurrentAdminSettings, ModelTaskId, ProcessingSettingsSnapshot, SettingsFieldError } from './admin-settings'
import { TASK_MODEL_LIMITS, createDefaultAdminSettings } from './admin-settings-defaults'
import { ADMIN_SETTINGS_STORAGE_LIMITS, settingsJsonBytes } from './admin-settings-limits'
import { PROMPT_REGISTRY_LIMITS, promptBundleSnapshotSchema } from './prompt-versions'

const MIB = 1024 * 1024
const integer = (max: number, min = 1) => z.number().int().min(min).max(max)
const text = (max: number) => z.string().trim().max(max).refine(
  value => [...value].every(character => character === '\n' || character === '\t' || character.charCodeAt(0) >= 32),
  'Use plain text without control characters.',
)
const requiredText = (max: number) => text(max).refine(value => value.length > 0, 'A nonblank value is required.')
const unique = <T extends z.ZodType>(schema: T, max: number, min = 0) =>
  z.array(schema).min(min).max(max).refine(values => new Set(values).size === values.length, 'Duplicate values are not allowed.')
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use a stable identifier with letters, digits, dots, underscores, or hyphens.')
const role = z.enum(['owner', 'editor', 'viewer', 'reviewer'])
const format = z.enum(['pdf', 'markdown', 'docx', 'doc'])
const reportFormat = z.enum(['csv', 'pdf', 'docx', 'pptx'])
const effort = z.enum(['minimal', 'low', 'medium', 'high'])
const administrativeRoles = z.enum(['owner', 'owner-and-editor'])
const httpsLink = z.union([z.literal(''), z.string().trim().max(2048).refine(value => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
  } catch { return false }
}, 'Enter an HTTPS URL without credentials, or leave it blank.')])

export const modelCapabilitiesSchema = z.strictObject({
  structuredOutputs: z.boolean(), contextTokens: integer(2_000_000, 0), maxOutputTokens: integer(256_000, 0),
  reasoningEfforts: unique(effort, 4), temperature: z.boolean(), topP: z.boolean(),
})
export const modelDeploymentSchema = z.strictObject({
  id: identifier, deploymentName: identifier, label: requiredText(100), description: text(500), enabled: z.boolean(),
  modelName: requiredText(100), modelVersion: z.string().min(1).max(100).nullable(), capabilities: modelCapabilitiesSchema,
  verification: z.enum(['deployment-config', 'discovered', 'validated']), verifiedAt: z.iso.datetime().nullable(),
})
export const taskInputBudgetSchema = z.strictObject({
  unit: z.enum(['characters', 'bytes', 'tokens']), maxInput: integer(400_000), maxRequest: integer(400_000),
  reservedTokens: integer(16_384, 2_048),
})
export const taskModelSettingsSchema = z.strictObject({
  deploymentId: identifier.nullable(), reasoningEffort: effort.nullable(), completionTokenLimit: integer(128_000),
  inputBudget: taskInputBudgetSchema, temperature: z.number().min(0).max(2).nullable(), topP: z.number().gt(0).max(1).nullable(),
})
const tasksSchema = z.strictObject({
  ...Object.fromEntries(LEGACY_MODEL_TASK_IDS.map(task => [task, taskModelSettingsSchema])) as Record<Exclude<ModelTaskId, 'qcPlan'>, typeof taskModelSettingsSchema>,
  qcPlan: taskModelSettingsSchema.optional(),
})
const hostname = z.string().trim().toLowerCase().max(253).transform(value => value.replace(/\.$/, '')).refine(value => {
  if (!value || value.includes(':') || value.includes('/') || value.includes('*')) return false
  return value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}, 'Enter a hostname only (no URL, wildcard, path, port, or credentials).')
const hostRules = z.array(z.strictObject({ hostname, includeSubdomains: z.boolean() })).max(100).refine(
  values => new Set(values.map(value => value.hostname)).size === values.length, 'Duplicate hostnames are not allowed.',
)
const urlScope = z.strictObject({ allowedHosts: hostRules, blockedHosts: hostRules })
const sourcePolicy = z.strictObject({
  allowedFormats: unique(format, 4), allowUrls: z.boolean(), maxFileBytes: integer(10 * MIB), maxBatchItems: integer(10),
  maxPdfPages: integer(50), maxSourceCharacters: integer(180_000),
})
const workerPolicy = (maxItems: number) => z.strictObject({
  maxItemsPerExecution: integer(maxItems), budgetMilliseconds: integer(660_000, 1000), pauseClaiming: z.boolean(),
})
const processingPolicy = (maxBackoff: number, maxBase: number) => z.strictObject({
  maxAutomaticAttempts: integer(3),
  retryBackoff: z.strictObject({ baseMilliseconds: integer(maxBase, 1000), maxMilliseconds: integer(maxBackoff, 1000) }),
})

const settingsObject = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  ai: z.strictObject({
    deployments: z.array(modelDeploymentSchema).min(1).max(100), defaultDeploymentId: identifier, tasks: tasksSchema,
    jobRubric: z.strictObject({ maxOutputCorrections: integer(1, 0) }),
    resumeProfile: z.strictObject({ maxOutputCorrections: integer(1, 0) }),
    grades: z.strictObject({ maxOutputCorrections: integer(1, 0) }),
    transport: z.strictObject({ maxAttempts: integer(2) }), requestTimeoutMilliseconds: integer(60_000, 1000),
  }),
  features: z.strictObject({
    jobImports: z.boolean(), resumeImports: z.boolean(), gradeLadders: z.boolean(), newAnalyses: z.boolean(),
    // samplesVisible is retired and ignored, but strict stored revisions and snapshots still carry it.
    summaryGeneration: z.boolean(), samplesVisible: z.boolean(),
    // Optional, never defaulted here: absent keeps earlier revisions and captured snapshots byte-identical.
    rubricAssistant: z.boolean().optional(),
  }),
  maintenance: z.strictObject({ pauseNewWork: z.boolean(), explanation: text(1000) }),
  imports: z.strictObject({
    jobs: sourcePolicy, resumes: sourcePolicy,
    urls: z.strictObject({
      requireHttps: z.boolean(), jobs: urlScope, resumes: urlScope, agencyReferences: urlScope,
      timeoutMilliseconds: integer(30_000, 1000), maxResponseBytes: integer(12 * MIB), maxRedirects: integer(5, 0),
    }),
  }),
  documents: z.strictObject({ formattedDocxPreviewEnabled: z.boolean(), originalDownloadRoles: unique(role, 4) }),
  grades: z.strictObject({
    references: z.strictObject({
      maxSources: integer(15), maxPdfBytes: integer(20 * MIB), maxSelectedPages: integer(250),
      maxTotalSelectedPages: integer(500), maxSourceCharacters: integer(2_000_000), pdfChunkPages: integer(50),
      maxLinks: integer(2000), allowAgencyUploads: z.boolean(), allowAgencyUrls: z.boolean(),
    }),
    maxCriteria: integer(20), allowedLevels: unique(integer(15), 15, 1),
    defaults: z.strictObject({
      levels: unique(integer(15), 15), agency: text(300),
      agencyType: z.enum(['dod', 'other-federal', 'non-federal', 'unknown']),
      supervision: z.enum(['nonsupervisory', 'supervisor', 'leader', 'unknown']),
      functions: unique(z.enum(['research', 'development', 'test-evaluation']), 3), specialty: text(1000),
    }),
    discovery: z.strictObject({ maxHops: integer(2, 0), maxRequests: integer(80), maxDocuments: integer(35), maxBytes: integer(64 * MIB) }),
  }),
  rubrics: z.strictObject({ jobs: z.strictObject({ maxCriteria: integer(20) }) }),
  analyses: z.strictObject({ maxComparisons: integer(500), maxOutputCorrections: integer(2, 0) }),
  processing: z.strictObject({
    jobs: processingPolicy(300_000, 15_000), grades: processingPolicy(120_000, 30_000),
    resumes: processingPolicy(60_000, 15_000), analyses: processingPolicy(120_000, 30_000),
    qc: processingPolicy(300_000, 30_000).optional(),
  }),
  summaries: z.strictObject({
    generationMode: z.enum(['automatic', 'on-demand']), maxRounds: integer(3), allowManualPublication: z.boolean(),
    manualPublicationRoles: administrativeRoles, historyRoles: administrativeRoles, historyPageSize: integer(12),
    operationTimeoutMilliseconds: integer(600_000, 1000),
  }),
  workers: z.strictObject({
    jobs: workerPolicy(20), grades: workerPolicy(20), resumes: workerPolicy(20), analyses: workerPolicy(100),
    qc: workerPolicy(10).optional(),
  }),
  extraction: z.strictObject({ transport: z.strictObject({ maxAttempts: integer(3) }), pollTimeoutMilliseconds: integer(240_000, 1000) }),
  rendering: z.strictObject({
    timeoutMilliseconds: integer(30_000, 1000), settleMilliseconds: integer(2000, 0),
    maxRequests: integer(80), maxAggregateBytes: integer(8 * MIB), maxDomBytes: integer(2 * MIB),
  }),
  ui: z.strictObject({ polling: z.strictObject({ jobsMilliseconds: integer(60_000, 1000), otherProcessingMilliseconds: integer(60_000, 1000) }) }),
  reports: z.strictObject({
    enabledFormats: unique(reportFormat, 4), defaultFormat: reportFormat.nullable(),
    highlightCount: integer(10), maxHighlights: integer(10), title: requiredText(200), additionalFooter: text(2000),
    maxComparisons: integer(500), batchComparisons: integer(25), maxConcurrentBatches: integer(3),
    maxInputBytes: integer(32 * MIB), maxOutputBytes: integer(64 * MIB), maxGenerationMilliseconds: integer(180_000, 1000),
    maxPages: integer(10_000), maxSlides: integer(10_000), allowedRoles: unique(role, 4),
  }),
  appearance: z.strictObject({
    applicationTitle: requiredText(80), defaultTheme: z.enum(['system', 'light', 'dark']),
    announcement: z.strictObject({ enabled: z.boolean(), text: text(2000), tone: z.enum(['info', 'warning']) }),
  }),
  navigation: z.strictObject({ defaultPage: z.enum(['jobs', 'resumes', 'rubrics', 'analyses']) }),
  help: z.strictObject({ supportUrl: httpsLink, documentationUrl: httpsLink }),
  workspaces: z.strictObject({ allowCreation: z.boolean() }),
  diagnostics: z.strictObject({ capturePrivateFailures: z.boolean() }),
  logging: z.strictObject({ detail: z.enum(['normal', 'diagnostic-metadata']) }),
})

export const reportSettingsSchema: z.ZodType<AdminSettings['reports']> = settingsObject.shape.reports.superRefine((report, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
  if (report.enabledFormats.length === 0 ? report.defaultFormat !== null : !report.defaultFormat || !report.enabledFormats.includes(report.defaultFormat)) {
    issue('defaultFormat', 'Choose an enabled format, or null when all formats are disabled.')
  }
  if (report.highlightCount > report.maxHighlights) issue('highlightCount', 'The highlight count must not exceed maximum highlights.')
  if (report.batchComparisons > report.maxComparisons) issue('batchComparisons', 'A read batch must fit the export comparison bound.')
})

export const adminSettingsSchema: z.ZodType<AdminSettings> = settingsObject.superRefine((settings, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: path.split('.'), message })
  const qcFields = [settings.ai.tasks.qcPlan, settings.processing.qc, settings.workers.qc]
  if (settings.schemaVersion === 2 ? qcFields.some(value => value === undefined) : qcFields.some(value => value !== undefined)) {
    issue('schemaVersion', 'Version 1 retains its original shape. Version 2 requires the dedicated QC task, processing policy, and worker policy together.')
  }
  const settingsBytes = settingsJsonBytes(settings)
  if (settingsBytes > ADMIN_SETTINGS_STORAGE_LIMITS.maxSettingsBytes) {
    ctx.addIssue({
      code: 'custom', path: [],
      message: `Settings must fit within ${ADMIN_SETTINGS_STORAGE_LIMITS.maxSettingsBytes} serialized UTF-8 bytes; this draft uses ${settingsBytes}. Shorten optional text, host lists or unused catalog descriptions. Nothing was truncated or saved.`,
    })
  }
  const deployments = settings.ai.deployments
  if (new Set(deployments.map(item => item.id)).size !== deployments.length) issue('ai.deployments', 'Deployment IDs must be unique.')
  if (new Set(deployments.map(item => item.deploymentName.toLowerCase())).size !== deployments.length) issue('ai.deployments', 'Azure deployment names must be unique.')
  if (deployments.some(item => item.enabled && !item.capabilities.structuredOutputs)) {
    issue('ai.deployments', 'Enabled deployments must have a supported strict structured-output adapter.')
  }
  if (!deployments.some(item => item.id === settings.ai.defaultDeploymentId && item.enabled && item.capabilities.structuredOutputs)) {
    issue('ai.defaultDeploymentId', 'Choose an enabled Azure deployment supporting strict structured output.')
  }
  for (const task of MODEL_TASK_IDS) {
    const binding = settings.ai.tasks[task]
    if (!binding) continue
    const path = `ai.tasks.${task}`
    const ceiling = TASK_MODEL_LIMITS[task]
    const deployment = deployments.find(item => item.id === (binding.deploymentId ?? settings.ai.defaultDeploymentId))
    if (!deployment?.enabled || !deployment.capabilities.structuredOutputs) {
      issue(`${path}.deploymentId`, 'Choose an enabled deployment with supported strict structured output.')
      continue
    }
    const capabilities = deployment.capabilities
    if (binding.reasoningEffort !== null && !capabilities.reasoningEfforts.includes(binding.reasoningEffort)) {
      issue(`${path}.reasoningEffort`, 'This reasoning effort is unsupported by the selected deployment.')
    }
    if (binding.temperature !== null && !capabilities.temperature) issue(`${path}.temperature`, 'This deployment does not support temperature.')
    if (binding.topP !== null && !capabilities.topP) issue(`${path}.topP`, 'This deployment does not support top-p.')
    if (binding.temperature !== null && binding.topP !== null) issue(`${path}.topP`, 'Set temperature or top-p, not both.')
    if (binding.completionTokenLimit > Math.min(ceiling.completionTokenLimit, capabilities.maxOutputTokens)) {
      issue(`${path}.completionTokenLimit`, 'The completion budget exceeds this task or deployment output ceiling.')
    }
    if (binding.inputBudget.unit !== ceiling.inputBudget.unit) issue(`${path}.inputBudget.unit`, `This task measures its input in ${ceiling.inputBudget.unit}.`)
    if (binding.inputBudget.maxInput > ceiling.inputBudget.maxInput) issue(`${path}.inputBudget.maxInput`, 'The input budget exceeds the compiled task ceiling.')
    if (binding.inputBudget.maxRequest > ceiling.inputBudget.maxRequest) issue(`${path}.inputBudget.maxRequest`, 'The full request budget exceeds the compiled task ceiling.')
    if (binding.inputBudget.maxInput > binding.inputBudget.maxRequest) issue(`${path}.inputBudget.maxInput`, 'The input allowance must fit within the full request allowance.')
    // Bytes are a conservative token bound; character requests still require a transport-level
    // UTF-8/token check of the actual complete prompt/schema (characters are not tokens).
    if (binding.inputBudget.maxRequest + binding.inputBudget.reservedTokens + binding.completionTokenLimit > capabilities.contextTokens) {
      issue(`${path}.inputBudget.maxRequest`, 'The full request, token reserve, and completion budget do not fit this deployment context.')
    }
  }
  const report = settings.reports
  if (report.enabledFormats.length === 0 ? report.defaultFormat !== null : !report.defaultFormat || !report.enabledFormats.includes(report.defaultFormat)) {
    issue('reports.defaultFormat', 'Choose an enabled format, or null when all formats are disabled.')
  }
  if (report.highlightCount > report.maxHighlights) issue('reports.highlightCount', 'The highlight count must not exceed maximum highlights.')
  if (report.batchComparisons > report.maxComparisons) issue('reports.batchComparisons', 'A read batch must fit the export comparison bound.')
  if (settings.grades.defaults.levels.some(level => !settings.grades.allowedLevels.includes(level))) {
    issue('grades.defaults.levels', 'Default levels must be a subset of allowed GS levels.')
  }
  const references = settings.grades.references
  if (references.maxSelectedPages > references.maxTotalSelectedPages) issue('grades.references.maxSelectedPages', 'Per-source selected pages must fit the total selected-page bound.')
  if (references.pdfChunkPages > references.maxSelectedPages) issue('grades.references.pdfChunkPages', 'Extraction chunks must fit the per-source selected-page bound.')
  for (const kind of ['jobs', 'grades', 'resumes', 'analyses', 'qc'] as const) {
    const policy = settings.processing[kind], worker = settings.workers[kind]
    if (!policy || !worker) continue
    const retry = policy.retryBackoff
    if (retry.baseMilliseconds > retry.maxMilliseconds) issue(`processing.${kind}.retryBackoff.baseMilliseconds`, 'The retry base must not exceed its cap.')
    if (settings.ai.requestTimeoutMilliseconds > worker.budgetMilliseconds) {
      issue(`workers.${kind}.budgetMilliseconds`, 'The execution budget must accommodate a model request.')
    }
  }
  if (settings.summaries.operationTimeoutMilliseconds + 1000 > settings.workers.analyses.budgetMilliseconds) {
    issue('summaries.operationTimeoutMilliseconds', 'Leave at least one second of the analysis worker budget for cleanup.')
  }
  if (settings.ai.requestTimeoutMilliseconds > settings.summaries.operationTimeoutMilliseconds) issue('summaries.operationTimeoutMilliseconds', 'The summary operation must accommodate a model request.')
  if (settings.rendering.settleMilliseconds >= settings.rendering.timeoutMilliseconds) issue('rendering.settleMilliseconds', 'Settling must be shorter than the render timeout.')
  if (settings.rendering.maxDomBytes > settings.rendering.maxAggregateBytes) issue('rendering.maxDomBytes', 'DOM bytes must fit the aggregate render budget.')
  if (settings.rendering.timeoutMilliseconds > settings.imports.urls.timeoutMilliseconds) issue('rendering.timeoutMilliseconds', 'Rendering must fit the URL operation deadline.')
  if (settings.appearance.announcement.enabled && !settings.appearance.announcement.text) issue('appearance.announcement.text', 'An enabled announcement needs text.')
})

function partialObject(schema: z.ZodObject): z.ZodObject {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    let child = field as z.ZodType
    if (child instanceof z.ZodOptional) child = child.unwrap() as z.ZodType
    shape[key] = (child instanceof z.ZodObject ? partialObject(child) : child).optional()
  }
  return z.strictObject(shape)
}
export const adminSettingsPatchSchema = partialObject(settingsObject) as z.ZodType<AdminSettingsPatch>

export class SettingsValidationError extends Error {
  constructor(readonly fields: SettingsFieldError[]) {
    super(fields.map(field => `${field.path || 'settings'}: ${field.message}`).join(' '))
    this.name = 'SettingsValidationError'
  }
}

export function settingsValidationError(error: z.ZodError): SettingsValidationError {
  return new SettingsValidationError(error.issues.flatMap(issue => issue.code === 'unrecognized_keys'
    ? issue.keys.map(key => ({ path: [...issue.path, key].join('.'), message: 'Unknown setting.' }))
    : [{ path: issue.path.join('.'), message: issue.message }]))
}
export function parseAdminSettings(value: unknown): AdminSettings {
  const result = adminSettingsSchema.safeParse(value)
  if (!result.success) throw settingsValidationError(result.error)
  return result.data
}

/** Explicit new-QC-work/editor upgrade; never use when reconstructing accepted legacy snapshots. */
export function upgradeQcAdminSettings(value: AdminSettings): CurrentAdminSettings {
  const settings = parseAdminSettings(value)
  if (settings.schemaVersion === 2) return structuredClone(settings) as CurrentAdminSettings
  const defaults = createDefaultAdminSettings()
  const deployment = settings.ai.deployments.find(item => item.id === settings.ai.defaultDeploymentId)!
  const limit = TASK_MODEL_LIMITS.qcPlan
  const completionTokenLimit = Math.min(limit.completionTokenLimit, deployment.capabilities.maxOutputTokens)
  const maxRequest = Math.min(limit.inputBudget.maxRequest, deployment.capabilities.contextTokens - completionTokenLimit - limit.inputBudget.reservedTokens)
  return parseAdminSettings({
    ...settings, schemaVersion: 2,
    ai: { ...settings.ai, tasks: { ...settings.ai.tasks, qcPlan: {
      deploymentId: null, reasoningEffort: null, completionTokenLimit, temperature: null, topP: null,
      inputBudget: { ...limit.inputBudget, maxRequest, maxInput: Math.min(limit.inputBudget.maxInput, maxRequest) },
    } } },
    processing: { ...settings.processing, qc: defaults.processing.qc },
    workers: { ...settings.workers, qc: defaults.workers.qc },
  }) as CurrentAdminSettings
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function merge(base: unknown, patch: unknown): unknown {
  if (!record(base) || !record(patch)) return structuredClone(patch)
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new SettingsValidationError([{ path: key, message: 'Unknown setting.' }])
    }
    result[key] = record(value) ? merge(base[key], value) : structuredClone(value)
  }
  return result
}
export function mergeAdminSettings(current: AdminSettings, patch: unknown): AdminSettings {
  const result = adminSettingsPatchSchema.safeParse(patch)
  if (!result.success) throw settingsValidationError(result.error)
  const base = current.schemaVersion === 1 && result.data.schemaVersion === 2 ? upgradeQcAdminSettings(current) : current
  return parseAdminSettings(merge(base, result.data))
}

const resolvedTaskSchema = taskModelSettingsSchema.extend({
  taskId: z.enum(MODEL_TASK_IDS), deploymentId: identifier, deploymentName: identifier, modelName: requiredText(100),
  modelVersion: z.string().min(1).max(100).nullable(), capabilities: modelCapabilitiesSchema,
})
const legacyProcessingSettingsSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: identifier, capturedAt: z.iso.datetime(), settings: adminSettingsSchema,
  tasks: z.strictObject({
    ...Object.fromEntries(LEGACY_MODEL_TASK_IDS.map(task => [task, resolvedTaskSchema])) as Record<Exclude<ModelTaskId, 'qcPlan'>, typeof resolvedTaskSchema>,
    qcPlan: resolvedTaskSchema.optional(),
  }),
})
export const processingSettingsSnapshotSchema: z.ZodType<ProcessingSettingsSnapshot> = z.discriminatedUnion('schemaVersion', [
  legacyProcessingSettingsSnapshotSchema,
  legacyProcessingSettingsSnapshotSchema.extend({ schemaVersion: z.literal(2), promptBundle: promptBundleSnapshotSchema }),
]).superRefine((snapshot, ctx) => {
  const maxBytes = snapshot.schemaVersion === 2 ? PROMPT_REGISTRY_LIMITS.snapshotBytes : ADMIN_SETTINGS_STORAGE_LIMITS.maxSnapshotBytes
  if (settingsJsonBytes(snapshot) > maxBytes) {
    ctx.addIssue({
      code: 'custom', path: [],
      message: `A complete processing-settings snapshot must fit within ${maxBytes} serialized UTF-8 bytes. No partial policy was captured.`,
    })
  }
  for (const task of MODEL_TASK_IDS) {
    const binding = snapshot.settings.ai.tasks[task]
    const resolved = snapshot.tasks[task]
    if (!binding && !resolved) continue
    if (!binding || !resolved) {
      ctx.addIssue({ code: 'custom', path: ['tasks', task], message: 'A task and its exact resolved capture must both be present or both absent.' })
      continue
    }
    const deployment = snapshot.settings.ai.deployments.find(item => item.id === (binding.deploymentId ?? snapshot.settings.ai.defaultDeploymentId))
    const expected = deployment && {
      ...binding, taskId: task, deploymentId: deployment.id, deploymentName: deployment.deploymentName,
      modelName: deployment.modelName, modelVersion: deployment.modelVersion, capabilities: deployment.capabilities,
    }
    if (!expected || Object.keys(expected).some(key => JSON.stringify(resolved[key as keyof typeof resolved]) !== JSON.stringify(expected[key as keyof typeof expected]))) {
      ctx.addIssue({ code: 'custom', path: ['tasks', task], message: 'Resolved task does not match the frozen settings.' })
    }
  }
})
