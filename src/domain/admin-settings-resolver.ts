import { MODEL_TASK_IDS } from './admin-settings-tasks'
import type {
  AdminSettings, HostRule, ModelTaskId, ProcessingSettingsSnapshot, PublicSettings, ResolvedTaskModel,
  RuntimeSettingsReadiness, SettingsChange,
} from './admin-settings'
import { parseAdminSettings, processingSettingsSnapshotSchema, settingsValidationError, SettingsValidationError } from './admin-settings-schema'

export function resolveTaskModel(settings: AdminSettings | ProcessingSettingsSnapshot, taskId: ModelTaskId): ResolvedTaskModel {
  if ('tasks' in settings) return structuredClone(settings.tasks[taskId])
  const binding = settings.ai.tasks[taskId]
  const id = binding.deploymentId ?? settings.ai.defaultDeploymentId
  const deployment = settings.ai.deployments.find(item => item.id === id)
  if (!deployment?.enabled || !deployment.capabilities.structuredOutputs) {
    throw new SettingsValidationError([{ path: `ai.tasks.${taskId}.deploymentId`, message: 'The selected deployment is unavailable or incompatible; no substitute was used.' }])
  }
  return structuredClone({
    ...binding, taskId, deploymentId: deployment.id, deploymentName: deployment.deploymentName,
    modelName: deployment.modelName, modelVersion: deployment.modelVersion, capabilities: deployment.capabilities,
  })
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
export function captureProcessingSettings(settings: AdminSettings, revision: string, capturedAt: string): ProcessingSettingsSnapshot {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(revision) || !Number.isFinite(Date.parse(capturedAt))) {
    throw new SettingsValidationError([{ path: 'revision', message: 'A valid immutable revision and capture timestamp are required.' }])
  }
  const copy = parseAdminSettings(settings)
  const tasks = Object.fromEntries(MODEL_TASK_IDS.map(task => [task, resolveTaskModel(copy, task)])) as Record<ModelTaskId, ResolvedTaskModel>
  const result = processingSettingsSnapshotSchema.safeParse({ schemaVersion: 1, revision, capturedAt, settings: copy, tasks })
  if (!result.success) throw settingsValidationError(result.error)
  return freeze(result.data)
}

/** Explicit allowlist: never serialize the admin response or deployment/environment object here. */
export function projectPublicSettings(
  snapshot: ProcessingSettingsSnapshot, runtimeEnabled = true, settingsConfigured = runtimeEnabled,
): PublicSettings {
  const settings = snapshot.settings
  return structuredClone({
    schemaVersion: 1, revision: snapshot.revision, runtimeEnabled,
    runtimeReadiness: runtimeSettingsReadiness(runtimeEnabled, settingsConfigured),
    features: settings.features, maintenance: settings.maintenance,
    imports: { jobs: settings.imports.jobs, resumes: settings.imports.resumes, requireHttps: settings.imports.urls.requireHttps },
    grades: {
      maxCriteria: settings.grades.maxCriteria, allowedLevels: settings.grades.allowedLevels,
      defaults: settings.grades.defaults, references: settings.grades.references,
    },
    rubrics: settings.rubrics, analyses: { maxComparisons: settings.analyses.maxComparisons },
    summaries: {
      generationMode: settings.summaries.generationMode, allowManualPublication: settings.summaries.allowManualPublication,
      manualPublicationRoles: settings.summaries.manualPublicationRoles, historyRoles: settings.summaries.historyRoles,
      historyPageSize: settings.summaries.historyPageSize,
    },
    documents: settings.documents, reports: settings.reports, appearance: settings.appearance,
    navigation: settings.navigation, help: settings.help, workspaces: settings.workspaces, ui: settings.ui,
  })
}

export function runtimeSettingsReadiness(runtimeEnabled: boolean, configured: boolean): RuntimeSettingsReadiness {
  const newProcessingAllowed = !configured || runtimeEnabled
  return {
    configured, newProcessingAllowed,
    reason: newProcessingAllowed ? null : 'worker-verification-required',
    message: newProcessingAllowed ? null : 'New processing is paused until all four worker readers are verified and settings-driven admissions are enabled.',
  }
}

export function diffAdminSettings(before: AdminSettings, after: AdminSettings): SettingsChange[] {
  const changes: SettingsChange[] = []
  const visit = (left: unknown, right: unknown, path: string) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      const a = left as Record<string, unknown>
      const b = right as Record<string, unknown>
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) visit(a[key], b[key], path ? `${path}.${key}` : key)
    } else changes.push({ path, before: structuredClone(left), after: structuredClone(right) })
  }
  visit(before, after, '')
  return changes
}

export function hostMatchesRule(hostname: string, rule: HostRule): boolean {
  const actual = hostname.toLowerCase().replace(/\.$/, '')
  const expected = rule.hostname.toLowerCase().replace(/\.$/, '')
  return actual === expected || (rule.includeSubdomains && actual.endsWith(`.${expected}`))
}

/** Additional business policy only. Callers must retain DNS/public-address/redirect checks. */
export function urlAllowedBySettings(value: string, settings: AdminSettings, scope: 'jobs' | 'resumes' | 'agencyReferences'): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) ||
    (settings.imports.urls.requireHttps && url.protocol !== 'https:')) return false
  const policy = settings.imports.urls[scope]
  if (policy.blockedHosts.some(rule => hostMatchesRule(url.hostname, rule))) return false
  return policy.allowedHosts.length === 0 || policy.allowedHosts.some(rule => hostMatchesRule(url.hostname, rule))
}
