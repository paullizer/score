export type HealthStatus = 'ready' | 'unavailable'

export interface HealthCheckable {
  checkAccess(): Promise<void>
}

export interface HealthDeps {
  readonly directory: HealthCheckable
  readonly state: HealthCheckable
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number
  /** How long a result is cached, in ms, so a burst of probes doesn't hammer Cosmos/Blob. */
  readonly cacheMs?: number
}

const DEFAULT_CACHE_MS = 5000

/**
 * Builds the /healthz check: confirms this instance's managed identity can reach both the Cosmos
 * container and the private Blob container, with no configuration or secrets in the response.
 * Anonymous by design (excluded from Easy Auth) so App Service's own health probe can call it.
 */
export function createHealthCheck(deps: HealthDeps): () => Promise<HealthStatus> {
  const now = deps.now ?? (() => Date.now())
  const cacheMs = deps.cacheMs ?? DEFAULT_CACHE_MS
  let cached: { at: number; status: HealthStatus } | undefined

  return async function check(): Promise<HealthStatus> {
    if (cached && now() - cached.at < cacheMs) return cached.status
    let status: HealthStatus
    try {
      await Promise.all([deps.directory.checkAccess(), deps.state.checkAccess()])
      status = 'ready'
    } catch {
      status = 'unavailable'
    }
    cached = { at: now(), status }
    return status
  }
}
