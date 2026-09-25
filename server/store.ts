import type { WorkspaceKind, WorkspaceRole } from '../src/domain/cloud'
import type { LifecycleOperation } from '../src/domain/lifecycle'
import type { AccessAudit } from './access/store'

/** Per-workspace metadata document; Cosmos item id is always the literal string 'workspace'. */
export interface WorkspaceMetadataDoc {
  readonly id: 'workspace'
  readonly workspaceId: string
  readonly name: string
  readonly kind: WorkspaceKind
  /** Original creator provenance only; current ownership comes from membership. */
  readonly ownerId: string
  readonly ownerCount?: number
  readonly deletionRecoveryPrincipalId?: string
  readonly tenantId: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly archivedAt?: string
  readonly deletedAt?: string
  readonly lifecycleOperation?: LifecycleOperation
  readonly lifecycleStage?: 'memberships'
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
  /** Optional owner-supplied display label. Never used to identify or authorize a principal. */
  readonly label?: string
  readonly name?: string
  readonly email?: string
}

export interface StoredMembership {
  readonly membership: MembershipDoc
  readonly etag: string
}

export interface MembershipAuditDoc {
  readonly id: string
  readonly workspaceId: string
  readonly type: 'membership-audit'
  readonly action: 'reviewer-added' | 'reviewer-removed'
  readonly actorId: string
  readonly targetPrincipalId: string
  readonly membershipId: string
  readonly role: 'reviewer'
  readonly label?: string
  readonly createdAt: string
}

export interface ReviewerMembershipChange {
  readonly metadata: WorkspaceMetadataDoc
  readonly expectedMetadataEtag: string
  readonly membership: MembershipDoc & { readonly role: 'reviewer' }
  /** Required when removing a reviewer; adds are create-only, never upserts. */
  readonly expectedMembershipEtag?: string
  readonly audit: MembershipAuditDoc
}

export interface MembershipChange {
  readonly metadata: WorkspaceMetadataDoc
  readonly expectedMetadataEtag: string
  readonly memberId: string
  readonly membership?: MembershipDoc
  readonly expectedMemberEtag?: string
  readonly audit: AccessAudit
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
 * The workspace mutation lease is held by another request, which may be the caller's own earlier
 * attempt. Nothing was changed, so the same request can be sent again shortly. It keeps the
 * `StoreConflictError` name so existing conflict handling is unchanged.
 */
export class WorkspaceMutationBusyError extends StoreConflictError {
  constructor(message = 'Another workspace change is in progress. Reload and retry.') {
    super(message)
  }
}

/**
 * Low-level Cosmos DB access for the single `workspaces` container (partition key `/workspaceId`).
 * Holds directory metadata and membership only. Feature records live in their own dedicated stores.
 */
export interface DirectoryStore {
  getMetadata(workspaceId: string): Promise<StoredMetadata | undefined>
  getMembership(workspaceId: string, membershipId: string): Promise<MembershipDoc | undefined>
  getStoredMembership(workspaceId: string, membershipId: string): Promise<StoredMembership | undefined>
  listReviewerMemberships(workspaceId: string): Promise<StoredMembership[]>
  /** Atomically changes one reviewer, creates its immutable audit, and advances the directory ETag. */
  changeReviewerMembership(change: ReviewerMembershipChange): Promise<StoredMetadata>
  /** Cross-partition lookup of every membership for a principal, across all workspaces. */
  listMembershipsForPrincipal(principalKey: string): Promise<MembershipDoc[]>
  listMetadataForTenant(tenantId: string): Promise<StoredMetadata[]>
  listWorkspaceMemberships(workspaceId: string): Promise<StoredMembership[]>
  changeMembership(change: MembershipChange): Promise<StoredMetadata>
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
  /** A completed deletion atomically publishes the tombstone and removes the final owner membership. */
  replaceMetadata(metadata: WorkspaceMetadataDoc, expectedEtag: string): Promise<StoredMetadata>
  /** Removes other memberships, preserving the owner's recovery access until final publication. */
  deleteMemberships(workspaceId: string): Promise<void>
  listLifecycleOperations(limit: number): Promise<StoredMetadata[]>
  /** Cheap read used by /healthz to confirm the container is reachable with the current identity. */
  checkAccess(): Promise<void>
}

export interface StateStoreEntry {
  readonly content: string
  readonly etag: string
}

export interface WorkspaceMutationLease {
  renew(): Promise<void>
  release(): Promise<void>
}

/**
 * Low-level private Blob access for the `workspace-state` container. It holds the per-workspace
 * mutation lease blob `${workspaceId}/mutation.lock`. Legacy `${workspaceId}/state.json` sample-state
 * blobs from older releases are never read by the application; they are only removed when their
 * workspace is permanently deleted.
 */
export interface StateStore {
  getState(workspaceId: string): Promise<StateStoreEntry | undefined>
  deleteState(workspaceId: string, expectedEtag: string): Promise<void>
  acquireMutationLease(workspaceId: string): Promise<WorkspaceMutationLease>
  /** Cheap read used by /healthz to confirm the container is reachable with the current identity. */
  checkAccess(): Promise<void>
}
