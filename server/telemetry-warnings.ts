export type TelemetryWarning =
  | 'configuration_invalid' | 'configuration_override_ignored' | 'startup_failed'
  | 'export_failed' | 'export_timeout' | 'export_rejected'
  | 'sdk_warning' | 'sdk_error' | 'shutdown_failed' | 'shutdown_timeout'

export function createTelemetryWarnings(
  sink: (code: TelemetryWarning) => void = (code) => console.warn(`[score.telemetry] ${code}`),
): (code: TelemetryWarning) => void {
  const lastReported = new Map<TelemetryWarning, number>()
  return (code) => {
    const now = performance.now()
    const previous = lastReported.get(code)
    if (previous !== undefined && now - previous < 60_000) return
    lastReported.set(code, now)
    sink(code)
  }
}
