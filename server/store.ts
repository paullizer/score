import type { WorkspaceKind, WorkspaceRole } from '../src/domain/cloud'

/** Per-workspace metadata document; Cosmos item id is always the literal string 'workspace'. */
export interface WorkspaceMetadataDoc {
  readonly id: 'workspace'
  readonly workspaceId: string
  readonly name: string
  readonly kind: WorkspaceKind
  /** Immutable tenant+OID principal key of the workspace owner. Never a display name/email. */
  readonly ownerId: string
  readonly tenantId: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** A stored metadata document plus its Cosmos `_etag`, used for optimistic concurrency on rename. */
export interface StoredMetadata {
  readonly metadata: WorkspaceMetadataDoc
  readonly etag: string
}

/** Per-principal membership document, extensible to future group principals. */
export interface MembershipDoc {
  readonly id: string
  readonly workspaceId: string
  /** Immutable tenant+OID principal key. Never trust a client-supplied copy of this. */
  readonly principalId: string
  readonly principalType: 'user'
  readonly role: WorkspaceRole
}

/** Thrown by a store when the requested item does not exist. */
export class StoreNotFoundError extends Error {
  constructor(message = 'Not found.') {
    super(message)
    this.name = 'StoreNotFoundError'
  }
}

/** Thrown by a store on an optimistic-concurrency mismatch (stale etag) or a duplicate create. */
export class StoreConflictError extends Error {
  constructor(message = 'Conflict.') {
    super(message)
    this.name = 'StoreConflictError'
  }
}

/**
 * Low-level Cosmos DB access for the single `workspaces` container (partition key `/workspaceId`).
 * Holds directory metadata and membership only — never the large simulated workspace state, which
 * lives in Blob storage instead to stay well under Cosmos's per-item size limit.
 */
export interface DirectoryStore {
  getMetadata(workspaceId: string): Promise<StoredMetadata | undefined>
  getMembership(workspaceId: string, membershipId: string): Promise<MembershipDoc | undefined>
  /** Cross-partition lookup of every membership for a principal, across all workspaces. */
  listMembershipsForPrincipal(principalKey: string): Promise<MembershipDoc[]>
  /**
   * Atomically creates metadata and upserts its owner membership in one workspace partition.
   * Metadata creation remains conditional, so an existing workspace is never modified. An orphan
   * owner membership can be repaired only when its metadata has not been published.
   * Returns `created: false` (without error) if the metadata document already existed, so callers
   * bootstrapping a deterministic default workspace can treat a concurrent race as a success.
   */
  createWorkspace(metadata: WorkspaceMetadataDoc, membership: MembershipDoc): Promise<{ created: boolean }>
  /** Conditional rename; throws {@link StoreConflictError} on etag mismatch, {@link StoreNotFoundError} if gone. */
  renameWorkspace(workspaceId: string, name: string, updatedAt: string, expectedEtag: string): Promise<StoredMetadata>
  /** Cheap read used by /healthz to confirm the container is reachable with the current identity. */
  checkAccess(): Promise<void>
}

export interface StateStoreEntry {
  readonly content: string
  readonly etag: string
}

/**
 * Low-level private Blob access for complete workspace state, one blob per workspace at
 * `${workspaceId}/state.json`. All writes are conditioned on Blob ETags for strong optimistic
 * concurrency; there is no last-write-wins path.
 */
export interface StateStore {
  getState(workspaceId: string): Promise<StateStoreEntry | undefined>
  /** First write for a new workspace; conditioned on the blob not already existing. */
  createState(workspaceId: string, content: string): Promise<{ created: boolean; etag: string }>
  /** Throws {@link StoreConflictError} if `expectedEtag` no longer matches the stored blob. */
  putState(workspaceId: string, content: string, expectedEtag: string): Promise<{ etag: string }>
  /** Cheap read used by /healthz to confirm the container is reachable with the current identity. */
  checkAccess(): Promise<void>
}
