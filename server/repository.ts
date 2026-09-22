import { createInitialWorkspace } from '../src/data/fixtures'
import type { CloudSession, CloudWorkspaceSnapshot, WorkspaceRole, WorkspaceSummary } from '../src/domain/cloud'
import type { Workspace } from '../src/domain/types'
import { validateWorkspace, WorkspaceValidationError } from '../src/domain/workspace-validation'
import { workspaceLifecycleTransitionErrors } from '../src/domain/lifecycle'
import { isApplicationAdmin, type AuthenticatedPrincipal } from './auth'
import { conflict, forbidden, invalidRequest, notFound, preconditionRequired, unavailable } from './errors'
import { isValidWorkspaceId, membershipIdFor, newWorkspaceId } from './ids'
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

export function toSummary(metadata: WorkspaceMetadataDoc, etag: string, role: WorkspaceRole, admin = false): WorkspaceSummary {
  return {
    id: metadata.workspaceId,
    name: metadata.name,
    kind: metadata.kind,
    role,
    accessSource: admin ? 'application-admin' : 'membership',
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
 * Cloud workspace business logic: effective access checks and the Cosmos-metadata/Blob-state split.
 * Talks only to the {@link DirectoryStore} and
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

  /** Session reads never create or repair a workspace. */
  async getSession(principal: AuthenticatedPrincipal): Promise<CloudSession> {
    const workspaces = await this.listWorkspaces(principal)
    return {
      mode: 'cloud',
      user: { id: principal.oid, tenantId: principal.tenantId, name: principal.name, email: principal.email },
      workspaces,
    }
  }

  /** Ordinary users see memberships; application admins see this tenant's directory. */
  async listWorkspaces(principal: AuthenticatedPrincipal): Promise<WorkspaceSummary[]> {
    if (isApplicationAdmin(principal)) {
      const records = await this.directory.listMetadataForTenant(principal.tenantId)
      return records.filter(({ metadata }) => metadata.tenantId === principal.tenantId && !metadata.deletedAt)
        .map(({ metadata, etag }) => toSummary(metadata, etag, 'owner', true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }
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
        if (stored.metadata.tenantId !== principal.tenantId || membership.principalId !== principal.principalKey ||
          membership.principalType !== 'user' || !['owner', 'editor', 'viewer'].includes(membership.role)) return undefined
        return toSummary(stored.metadata, stored.etag, membership.role)
      }),
    )
    return summaries
      .filter((summary): summary is WorkspaceSummary => summary !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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
      ownerCount: 1,
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
      name: principal.name,
      email: principal.email,
    }

    const prepared = await this.state.createState(workspaceId, JSON.stringify(createInitialWorkspace()))
    if (!prepared.created) throw conflict('The new workspace identifier is already in use. No existing content was changed; try again.')
    const { created } = await this.directory.createWorkspace(metadata, membership)
    if (!created) throw unavailable('Workspace creation could not be confirmed. Reload the workspace list before retrying.')

    const stored = await this.directory.getMetadata(workspaceId)
    if (!stored) throw unavailable('Could not create the workspace. Try again.')
    return toSummary(stored.metadata, stored.etag, 'owner', isApplicationAdmin(principal))
  }

  private async requireWorkspaceRole(principal: AuthenticatedPrincipal, workspaceId: string): Promise<WorkspaceRole> {
    const [stored, membership] = await Promise.all([
      this.directory.getMetadata(workspaceId),
      this.directory.getMembership(workspaceId, membershipIdFor(principal.principalKey)),
    ])
    if (!stored || stored.metadata.deletedAt || stored.metadata.tenantId !== principal.tenantId ||
      stored.metadata.workspaceId !== workspaceId) throw notFound()
    if (isApplicationAdmin(principal)) return 'owner'
    if (!membership || membership.workspaceId !== workspaceId ||
      membership.principalId !== principal.principalKey || membership.principalType !== 'user' ||
      !['owner', 'editor', 'viewer'].includes(membership.role)) {
      throw notFound()
    }
    return membership.role
  }

  /** Shared authorization gate for workspace-scoped feature routers. */
  async authorizeWorkspace(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    access: 'read' | 'write' | 'manage' | 'members',
    allowPendingLifecycle = false,
  ): Promise<WorkspaceRole> {
    if (!isValidWorkspaceId(workspaceId)) throw notFound()
    const role = await this.requireWorkspaceRole(principal, workspaceId)
    if (access !== 'read' && role === 'viewer') {
      throw forbidden('Readers cannot change this workspace.')
    }
    if (access === 'members' && role !== 'owner') throw forbidden('Only workspace owners and application admins can manage access.')
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
    return role
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
    access: 'write' | 'manage' | 'members',
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
      const role = await this.requireWorkspaceRole(principal, workspaceId)
      if (role !== 'owner') throw forbidden('Only workspace owners and application admins can rename it.')
      try {
        assertWorkspaceMutationLease(workspaceId)
        const updated = await this.directory.renameWorkspace(workspaceId, trimmed, this.now(), ifMatchEtag)
        return toSummary(updated.metadata, updated.etag, role, isApplicationAdmin(principal))
      } catch (error) {
        if (error instanceof StoreNotFoundError) throw notFound()
        throw error
      }
    })
  }

  /** GET /api/workspaces/:id/state: never seeds/repairs missing or corrupt state, and never recovers interrupted work. */
  async getWorkspaceState(principal: AuthenticatedPrincipal, workspaceId: string): Promise<CloudWorkspaceSnapshot> {
    if (!isValidWorkspaceId(workspaceId)) throw notFound()
    await this.requireWorkspaceRole(principal, workspaceId)

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
