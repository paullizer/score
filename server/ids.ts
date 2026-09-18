import { createHash, randomUUID } from 'node:crypto'

/** Entra tenant/object IDs are GUIDs. Shape check only; not a trust boundary by itself. */
export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Workspace IDs are used directly as Cosmos partition keys and as a Blob path segment, so they are
// restricted to a small, unambiguous, URL- and path-safe character set (no dots, slashes, or
// percent-encoding surprises).
export const WORKSPACE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export function isValidWorkspaceId(value: string): boolean {
  return WORKSPACE_ID_PATTERN.test(value)
}

/** The immutable identity of a principal: tenant + object ID. Never a display name or email. */
export function principalKeyFor(tenantId: string, oid: string): string {
  return `${tenantId}:${oid}`
}

/** Deterministic id for a principal's membership document; unique within a workspace partition. */
export function membershipIdFor(principalKey: string): string {
  return `member-${createHash('sha256').update(principalKey).digest('hex')}`
}

/**
 * Deterministic personal workspace ID for a given principal, so a first-time session bootstrap is
 * idempotent under concurrent requests: every request for the same principal computes the same
 * candidate ID, and a Cosmos item *create* (not upsert) on that ID naturally deduplicates races
 * instead of relying on a lock.
 */
export function defaultPersonalWorkspaceId(principalKey: string): string {
  return `personal-${createHash('sha256').update(principalKey).digest('hex').slice(0, 32)}`
}

export function newWorkspaceId(): string {
  return randomUUID()
}
