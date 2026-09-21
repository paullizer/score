export type TelemetryShutdownResult = 'disabled' | 'flushed' | 'failed' | 'timed_out'

export interface TelemetryLifecycle {
  readonly enabled: boolean
  shutdown(): Promise<TelemetryShutdownResult>
}

const key = Symbol.for('score.telemetry.lifecycle')
const host = globalThis as typeof globalThis & { [key]?: TelemetryLifecycle }

export function registerTelemetryLifecycle(lifecycle: TelemetryLifecycle): void {
  host[key] = lifecycle
}

export function telemetryPreloaded(): boolean {
  return host[key] !== undefined
}

export function shutdownTelemetry(): Promise<TelemetryShutdownResult> {
  return host[key]?.shutdown() ?? Promise.resolve('disabled')
}
