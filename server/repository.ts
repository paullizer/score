import { createInitialWorkspace } from '../src/data/fixtures'
import { setTimeout as delay } from 'node:timers/promises'
import type { CloudSession, CloudWorkspaceSnapshot, WorkspaceRole, WorkspaceSummary } from '../src/domain/cloud'
import type { Workspace } from '../src/domain/types'
import { validateWorkspace, WorkspaceValidationError } from '../src/domain/workspace-validation'
import { workspaceLifecycleTransitionErrors } from '../src/domain/lifecycle'
import type { AuthenticatedPrincipal } from './auth'
import { conflict, forbidden, invalidRequest, notFound, preconditionRequired, unavailable } from './errors'
import { defaultPersonalWorkspaceId, isValidWorkspaceId, membershipIdFor, newWorkspaceId } from './ids'
import {
  StoreConflictError,
  StoreNotFoundError,
  type DirectoryStore,
  type MembershipDoc,
  type StateStore,
  type WorkspaceMetadataDoc,
  type StoredMetadata,
} from './store'
import { assertWorkspaceMutationLease, withWorkspaceMutationLease } from './lifecycle/lease'

const MIN_NAME_LENGTH = 1
const MAX_NAME_LENGTH = 80

export interface WorkspaceRepositoryDeps {
  readonly directory: DirectoryStore
  readonly state: StateStore
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date
}

function validateName(name: unknown): string {
  if (typeof name !== 'string') throw invalidRequest('Workspace name must be a string.')
  const trimmed = name.trim()
  if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) {
    throw invalidRequest(`Workspace name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters.`)
  }
  return trimmed
}

export function toSummary(metadata: WorkspaceMetadataDoc, etag: string, role: WorkspaceRole): WorkspaceSummary {
  return {
    id: metadata.workspaceId,
    name: metadata.name,
    kind: metadata.kind,
    role,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    etag,
    ...(metadata.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
    ...(metadata.lifecycleOperation ? { lifecycleOperation: metadata.lifecycleOperation } : {}),
  }
}

export function decodeWorkspace(content: string): Workspace {
  try {
    return validateWorkspace(JSON.parse(content))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof WorkspaceValidationError) {
      throw unavailable("This workspace's saved data could not be read. Nothing has been changed.")
    }
    throw error
  }
}

/**
 * All cloud workspace business logic: membership/ownership checks, idempotent default-workspace
 * bootstrap, and the Cosmos-metadata/Blob-state split. Talks only to the {@link DirectoryStore} and
 * {@link StateStore} abstractions, so the same logic runs against both the real Azure-backed stores
 * and an in-memory fake in tests — the authorization and consistency rules are exercised for real
 * either way; only the storage primitives are swapped.
 */
export class WorkspaceRepository {
  private readonly directory: DirectoryStore
  private readonly state: StateStore
  private readonly clock: () => Date

  constructor(deps: WorkspaceRepositoryDeps) {
    this.directory = deps.directory
    this.state = deps.state
    this.clock = deps.now ?? (() => new Date())
  }

  private now(): string {
    return this.clock().toISOString()
  }

  /** GET /api/session: bootstraps a default personal workspace, then lists everything the user can see. */
  async getSession(principal: AuthenticatedPrincipal): Promise<CloudSession> {
    await this.ensureDefaultWorkspace(principal)
    const workspaces = await this.listWorkspaces(principal)
    return {
      mode: 'cloud',
      user: { id: principal.oid, tenantId: principal.tenantId, name: principal.name, email: principal.email },
      workspaces,
    }
  }

  /** GET /api/workspaces: lists only the memberships of the authenticated principal, never a global list. */
  async listWorkspaces(principal: AuthenticatedPrincipal): Promise<WorkspaceSummary[]> {
    const memberships = await this.directory.listMembershipsForPrincipal(principal.principalKey)
    const summaries = await Promise.all(
      memberships.map(async (membership): Promise<WorkspaceSummary | undefined> => {
        const stored = await this.directory.getMetadata(membership.workspaceId)
        // Membership without metadata is a storage inconsistency, not a workspace to show; skip it
        // rather than crash the whole list or fabricate a placeholder.
        if (!stored) {
          console.warn('An unpublished workspace membership has no directory metadata and was excluded from the workspace list.')
          return undefined
        }
        if (stored.metadata.deletedAt) return undefined
        if (stored.metadata.tenantId !== principal.tenantId || membership.principalId !== principal.principalKey) return undefined
        return toSummary(stored.metadata, stored.etag, membership.role)
      }),
    )
    return summaries
      .filter((summary): summary is WorkspaceSummary => summary !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Idempotently ensures the principal has a personal workspace, using a deterministic workspace ID
   * derived from the principal so concurrent first-time requests converge on exactly one workspace
   * instead of racing to create duplicates.
   */
  private async ensureDefaultWorkspace(principal: AuthenticatedPrincipal): Promise<void> {
    const workspaceId = defaultPersonalWorkspaceId(principal.principalKey)
    if (await this.directory.getMetadata(workspaceId)) {
      await this.initializeDefaultWorkspace(principal, false)
      return
    }
    // A stale first-use request must not prepare new state after another tab deletes the default.
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await withWorkspaceMutationLease(this.state, workspaceId, () => this.initializeDefaultWorkspace(principal, true))
        return
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error
        if (await this.directory.getMetadata(workspaceId)) {
          await this.initializeDefaultWorkspace(principal, false)
          return
        }
        if (attempt < 99) await delay(50)
      }
    }
    throw unavailable('Workspace initialization is still in progress. Retry shortly; no existing content has been replaced.')
  }

  private async initializeDefaultWorkspace(principal: AuthenticatedPrincipal, allowCreation: boolean): Promise<void> {
    const workspaceId = defaultPersonalWorkspaceId(principal.principalKey)
    const membershipId = membershipIdFor(principal.principalKey)
    const existingMetadata = await this.directory.getMetadata(workspaceId)
    if (existingMetadata) {
      if (existingMetadata.metadata.ownerId !== principal.principalKey || existingMetadata.metadata.tenantId !== principal.tenantId) {
        throw notFound()
      }
      if (existingMetadata.metadata.deletedAt) return
      if (existingMetadata.metadata.lifecycleOperation?.status !== undefined &&
        existingMetadata.metadata.lifecycleOperation.status !== 'complete') return
      await this.requireMembership(principal, workspaceId)
      const existingState = await this.state.getState(workspaceId)
      if (!existingState) {
        const latest = await this.directory.getMetadata(workspaceId)
        if (latest?.metadata.deletedAt || (latest?.metadata.lifecycleOperation && latest.metadata.lifecycleOperation.status !== 'complete')) return
        throw unavailable("Your default workspace's saved data is unavailable. It has not been replaced.")
      }
      decodeWorkspace(existingState.content)
      return
    }
    if (!allowCreation) throw unavailable('The workspace directory changed during initialization. Retry without recreating saved content.')

    const timestamp = this.now()
    const metadata: WorkspaceMetadataDoc = {
      id: 'workspace',
      workspaceId,
      name: 'My workspace',
      kind: 'personal',
      ownerId: principal.principalKey,
      tenantId: principal.tenantId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const membership: MembershipDoc = {
      id: membershipId,
      workspaceId,
      principalId: principal.principalKey,
      principalType: 'user',
      role: 'owner',
    }
    // The directory transaction is the publication point. Never roll back another initializer's
    // directory records or Blob after an ambiguous cross-store failure.
    const prepared = await this.state.createState(workspaceId, JSON.stringify(createInitialWorkspace()))
    if (!prepared.created) {
      const existingState = await this.state.getState(workspaceId)
      if (!existingState) throw unavailable('Workspace initialization could not be confirmed. Please retry.')
      decodeWorkspace(existingState.content)
    }
    await this.directory.createWorkspace(metadata, membership)
    await this.requireMembership(principal, workspaceId)
  }

  /** POST /api/workspaces: explicit personal workspace creation only; no ownership/type overrides. */
  async createWorkspace(principal: AuthenticatedPrincipal, name: unknown): Promise<WorkspaceSummary> {
    const trimmed = validateName(name)
    const workspaceId = newWorkspaceId()
    const membershipId = membershipIdFor(principal.principalKey)
    const timestamp = this.now()
    const metadata: WorkspaceMetadataDoc = {
      id: 'workspace',
      workspaceId,
      name: trimmed,
      kind: 'personal',
      ownerId: principal.principalKey,
      tenantId: principal.tenantId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const membership: MembershipDoc = {
      id: membershipId,
      workspaceId,
      principalId: principal.principalKey,
      principalType: 'user',
      role: 'owner',
    }

    const prepared = await this.state.createState(workspaceId, JSON.stringify(createInitialWorkspace()))
    if (!prepared.created) throw conflict('The new workspace identifier is already in use. No existing content was changed; try again.')
    const { created } = await this.directory.createWorkspace(metadata, membership)
    if (!created) throw unavailable('Workspace creation could not be confirmed. Reload the workspace list before retrying.')

    const stored = await this.directory.getMetadata(workspaceId)
    if (!stored) throw unavailable('Could not create the workspace. Try again.')
    return toSummary(stored.metadata, stored.etag, 'owner')
  }

  private async requireMembership(principal: AuthenticatedPrincipal, workspaceId: string): Promise<MembershipDoc> {
    const [stored, membership] = await Promise.all([
      this.directory.getMetadata(workspaceId),
      this.directory.getMembership(workspaceId, membershipIdFor(principal.principalKey)),
    ])
    if (!stored || stored.metadata.deletedAt || !membership || stored.metadata.tenantId !== principal.tenantId ||
      stored.metadata.workspaceId !== workspaceId || membership.workspaceId !== workspaceId ||
      membership.principalId !== principal.principalKey || membership.principalType !== 'user' ||
      !['owner', 'editor', 'viewer'].includes(membership.role)) {
      throw notFound()
    }
    return membership
  }

  /** Shared authorization gate for workspace-scoped feature routers. */
  async authorizeWorkspace(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    access: 'read' | 'write' | 'manage',
    allowPendingLifecycle = false,
  ): Promise<WorkspaceRole> {
    if (!isValidWorkspaceId(workspaceId)) throw notFound()
    const membership = await this.requireMembership(principal, workspaceId)
    if (access !== 'read' && membership.role === 'viewer') {
      throw forbidden('Viewers cannot change this workspace.')
    }
    if (access !== 'read') {
      const stored = await this.directory.getMetadata(workspaceId)
      if (!stored || stored.metadata.deletedAt) throw notFound()
      if (!allowPendingLifecycle && stored.metadata.lifecycleOperation && stored.metadata.lifecycleOperation.status !== 'complete') {
        throw conflict('A workspace lifecycle operation must finish or be retried before other changes can be made.')
      }
      if (access === 'write' && stored.metadata.archivedAt) {
        throw conflict('This workspace is archived. Unarchive it before editing or starting work.')
      }
    }
    return membership.role
  }

  async getWorkspaceMetadata(principal: AuthenticatedPrincipal, workspaceId: string): Promise<StoredMetadata> {
    await this.authorizeWorkspace(principal, workspaceId, 'read')
    const stored = await this.directory.getMetadata(workspaceId)
    if (!stored || stored.metadata.deletedAt) throw notFound()
    return stored
  }

  async withWorkspaceMutation<T>(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    access: 'write' | 'manage',
    operation: () => Promise<T>,
    allowPendingLifecycle = false,
  ): Promise<T> {
    if (!isValidWorkspaceId(workspaceId)) throw notFound()
    await this.authorizeWorkspace(principal, workspaceId, access, allowPendingLifecycle)
    try {
      return await withWorkspaceMutationLease(this.state, workspaceId, async () => {
        await this.authorizeWorkspace(principal, workspaceId, access, allowPendingLifecycle)
        return operation()
      })
    } catch (error) {
      if (error instanceof StoreConflictError) throw conflict(error.message)
      throw error
    }
  }

  /** PATCH /api/workspaces/:id: owner-only rename, guarded by the metadata etag. */
  async renameWorkspace(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    name: unknown,
    ifMatchEtag: string | undefined,
  ): Promise<WorkspaceSummary> {
    if (!isValidWorkspaceId(workspaceId)) throw notFound()
    const trimmed = validateName(name)
    if (ifMatchEtag === undefined) throw preconditionRequired()
    if (ifMatchEtag === '*') throw invalidRequest('Wildcard If-Match is not accepted; provide the current etag.')

    return this.withWorkspaceMutation(principal, workspaceId, 'write', async () => {
      const membership = await this.requireMembership(principal, workspaceId)
      if (membership.role !== 'owner') throw forbidden('Only the workspace owner can rename it.')
      try {
        assertWorkspaceMutationLease(workspaceId)
        const updated = await this.directory.renameWorkspace(workspaceId, trimmed, this.now(), ifMatchEtag)
        return toSummary(updated.metadata, updated.etag, membership.role)
      } catch (error) {
        if (error instanceof StoreNotFoundError) throw notFound()
        throw error
      }
    })
  }

  /** GET /api/workspaces/:id/state: never seeds/repairs missing or corrupt state, and never recovers interrupted work. */
  async getWorkspaceState(principal: AuthenticatedPrincipal, workspaceId: string): Promise<CloudWorkspaceSnapshot> {
    if (!isValidWorkspaceId(workspaceId)) throw notFound()
    await this.requireMembership(principal, workspaceId)

    const entry = await this.state.getState(workspaceId)
    if (!entry) throw unavailable("This workspace's saved data is unavailable right now. Nothing has been changed; try again shortly.")

    return { workspace: decodeWorkspace(entry.content), etag: entry.etag }
  }

  /** PUT /api/workspaces/:id/state: strong optimistic concurrency, validated before storage. */
  async putWorkspaceState(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    body: unknown,
    ifMatchEtag: string | undefined,
  ): Promise<{ etag: string }> {
    if (!isValidWorkspaceId(workspaceId)) throw notFound()
    await this.authorizeWorkspace(principal, workspaceId, 'manage')
    if (ifMatchEtag === undefined) throw preconditionRequired()
    if (ifMatchEtag === '*') throw invalidRequest('Wildcard If-Match is not accepted; provide the current etag.')

    let validated: Workspace
    try {
      validated = validateWorkspace(body)
    } catch (error) {
      if (error instanceof WorkspaceValidationError) throw invalidRequest(error.message)
      throw error
    }

    return this.withWorkspaceMutation(principal, workspaceId, 'manage', async () => {
      const previous = await this.state.getState(workspaceId)
      if (!previous) throw unavailable("This workspace's saved data is unavailable. Nothing has been recreated.")
      if (previous.etag !== ifMatchEtag) throw conflict()
      const current = decodeWorkspace(previous.content)
      if (current.lifecycle?.archivedAt !== validated.lifecycle?.archivedAt) {
        throw invalidRequest('Workspace archive state can only be changed through workspace lifecycle controls.')
      }
      const roots = (workspace: Workspace) => Object.entries(workspace.lifecycle?.entities ?? {})
        .filter(([key]) => key.startsWith('workspace:')).sort(([left], [right]) => left.localeCompare(right))
      if (JSON.stringify(roots(current)) !== JSON.stringify(roots(validated))) {
        throw invalidRequest('Workspace deletion state can only be changed through owner-only workspace lifecycle controls.')
      }
      const errors = workspaceLifecycleTransitionErrors(current, validated)
      if (errors.length) throw conflict(errors[0])
      assertWorkspaceMutationLease(workspaceId)
      return this.state.putState(workspaceId, JSON.stringify(validated), ifMatchEtag)
    })
  }
}
