import {
  WORKER_CONFIGURATION_FIELDS, WORKER_CONFIGURATION_REASONS, WorkerConfigurationError,
  type WorkerConfigurationField, type WorkerConfigurationReason,
} from './configuration'
import { RuntimeSettingsError, validateProcessingSettings, type WorkerSettingsReader } from './settings'

const PHASES = ['configuration', 'identity', 'dependencies', 'settings-read', 'processing'] as const
export type WorkerStartupPhase = typeof PHASES[number]

class WorkerStartupError extends Error {
  constructor(readonly phase: WorkerStartupPhase, cause: unknown) {
    super('Worker startup failed.', { cause })
    this.name = 'WorkerStartupError'
  }
}

export function workerStartupFailure(phase: WorkerStartupPhase, error: unknown): unknown {
  if (error instanceof WorkerConfigurationError || error instanceof WorkerStartupError || phase === 'processing') return error
  return new WorkerStartupError(phase, error)
}

export interface WorkerFailureDiagnostic {
  phase: WorkerStartupPhase
  field?: WorkerConfigurationField
  reason: WorkerConfigurationReason | 'settings-read-failed' | 'invalid-settings' | 'unexpected-error'
}

export function workerFailureDiagnostic(error: unknown): WorkerFailureDiagnostic {
  let phase: WorkerStartupPhase = 'processing'
  if (error instanceof WorkerStartupError) {
    const startup = error
    phase = PHASES.find(value => value === startup.phase) ?? 'processing'
    error = error.cause
  }
  if (error instanceof WorkerConfigurationError) {
    const configuration = error
    const field = WORKER_CONFIGURATION_FIELDS.find(value => value === configuration.field)
    const reason = WORKER_CONFIGURATION_REASONS.find(value => value === configuration.reason)
    if (field && reason) return { phase: 'configuration', field, reason }
  }
  return {
    phase,
    reason: phase === 'settings-read'
      ? error instanceof RuntimeSettingsError && error.code === 'settings-invalid' ? 'invalid-settings' : 'settings-read-failed'
      : 'unexpected-error',
  }
}

export function withWorkerSettingsDiagnostics(reader: WorkerSettingsReader): WorkerSettingsReader {
  return {
    mode: reader.mode,
    get legacy() { return reader.legacy },
    async current() {
      try {
        return validateProcessingSettings(await reader.current())
      } catch (error) {
        throw workerStartupFailure('settings-read', error)
      }
    },
  }
}
