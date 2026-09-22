import { randomUUID } from 'node:crypto'
import type { CreationAccess, EligibleUser, WorkspaceMembers } from '../../src/domain/access'
import type { WorkspaceRole } from '../../src/domain/cloud'
import { isApplicationAdmin, type AuthenticatedPrincipal } from '../auth'
import { conflict, forbidden, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { GUID_PATTERN, membershipIdFor, principalKeyFor } from '../ids'
import type { WorkspaceRepository } from '../repository'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { StoreConflictError, type DirectoryStore, type StoredMetadata, type StoredMembership } from '../store'
import type { EligibleUserDirectory } from './directory'
import type { AccessAudit, AccessStore } from './store'

const UNASSIGNED = '"unassigned"'
const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, owner: 2 }

export function userObjectId(value: string): string {
  if (!GUID_PATTERN.test(value)) throw invalidRequest('A valid Entra user object ID is required.')
  return value.toLowerCase()
}

function requireRevision(expected: string | undefined, actual: string): void {
  if (!expected) throw preconditionRequired()
  if (expected === '*') throw invalidRequest('Wildcard If-Match is not accepted.')
  if (expected !== actual) throw conflict('Access changed since it was loaded. Reload before trying again.')
}

export function requireApplicationAdmin(principal: AuthenticatedPrincipal): void {
  if (!isApplicationAdmin(principal)) throw forbidden('Application administrator access is required.')
}

async function eligible(directory: EligibleUserDirectory | undefined, userId: string): Promise<EligibleUser> {
  if (!directory) throw unavailable('The Entra user directory is not configured. An administrator must complete directory consent.')
  const user = await directory.get(userId)
  if (!user || user.id !== userId || !user.applicationRoles.some(role => role === 'Score.User' || role === 'Score.Admin')) {
    throw invalidRequest('This person must be assigned Score.User or Score.Admin in Entra before access can be granted.')
  }
  return user
}

function audit(principal: AuthenticatedPrincipal, targetId: string, action: string,
  previous: AccessAudit['previous'], next: AccessAudit['next'], now: string): AccessAudit {
  return {
    id: `access-${randomUUID()}`, tenantId: principal.tenantId, actorId: principal.oid,
    targetId, action, previous, next, createdAt: now,
  }
}

export class CreationAccessService {
  constructor(private readonly store: AccessStore | undefined, private readonly users: EligibleUserDirectory | undefined,
    private readonly clock: () => Date = () => new Date()) {}

  private storage(): AccessStore {
    if (!this.store) throw unavailable('Workspace-creation permissions storage is not configured.')
    return this.store
  }

  async canCreate(principal: AuthenticatedPrincipal): Promise<boolean> {
    if (isApplicationAdmin(principal)) return true
    return (await this.storage().getGrant(principal.tenantId, principal.oid))?.grant.canCreateWorkspaces === true
  }

  async read(principal: AuthenticatedPrincipal, target: string): Promise<CreationAccess> {
    requireApplicationAdmin(principal)
    const userId = userObjectId(target)
    const current = await this.storage().getGrant(principal.tenantId, userId)
    return { userId, canCreateWorkspaces: current?.grant.canCreateWorkspaces ?? false, etag: current?.etag ?? UNASSIGNED }
  }

  async set(principal: AuthenticatedPrincipal, target: string, allowed: boolean, expected: string | undefined): Promise<CreationAccess> {
    const current = await this.read(principal, target)
    requireRevision(expected, current.etag)
    if (allowed) await eligible(this.users, current.userId)
    try {
      await this.storage().setGrant({
        id: `grant-${current.userId}`, tenantId: principal.tenantId, userId: current.userId, canCreateWorkspaces: allowed,
      }, current.etag === UNASSIGNED ? undefined : current.etag,
      audit(principal, current.userId, 'workspace-creation', current.canCreateWorkspaces, allowed, this.clock().toISOString()))
    } catch (error) {
      if (error instanceof StoreConflictError) throw conflict(error.message)
      throw error
    }
    return this.read(principal, current.userId)
  }
}

export class WorkspaceAccessService {
  constructor(private readonly repository: WorkspaceRepository, private readonly directory: DirectoryStore,
    private readonly users: EligibleUserDirectory | undefined, private readonly clock: () => Date = () => new Date()) {}

  async requireOwner(principal: AuthenticatedPrincipal, workspaceId: string): Promise<void> {
    if (await this.repository.authorizeWorkspace(principal, workspaceId, 'read') !== 'owner') {
      throw forbidden('Only workspace owners and application admins can manage access.')
    }
  }

  private async entries(principal: AuthenticatedPrincipal, workspaceId: string): Promise<StoredMembership[]> {
    const entries = await this.directory.listWorkspaceMemberships(workspaceId)
    if (entries.some(({ membership }) => membership.workspaceId !== workspaceId ||
      membership.principalType !== 'user' || !membership.principalId.startsWith(`${principal.tenantId}:`) ||
      !GUID_PATTERN.test(membership.principalId.slice(principal.tenantId.length + 1)) ||
      membership.id !== membershipIdFor(membership.principalId) || !Object.hasOwn(ROLE_RANK, membership.role))) {
      throw unavailable('Workspace membership data is inconsistent. No access changes were made.')
    }
    return entries
  }

  private async snapshot(principal: AuthenticatedPrincipal, stored: StoredMetadata): Promise<WorkspaceMembers> {
    const entries = await this.entries(principal, stored.metadata.workspaceId)
    return {
      etag: stored.etag,
      members: entries.map(({ membership: member }) => ({
        id: member.principalId.split(':')[1],
        name: member.name ?? (member.principalId === principal.principalKey ? principal.name : member.principalId.split(':')[1]),
        email: member.email ?? (member.principalId === principal.principalKey ? principal.email : ''),
        role: member.role,
      })).sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name)),
    }
  }

  async list(principal: AuthenticatedPrincipal, workspaceId: string): Promise<WorkspaceMembers> {
    await this.requireOwner(principal, workspaceId)
    const stored = await this.repository.getWorkspaceMetadata(principal, workspaceId)
    return this.snapshot(principal, stored)
  }

  async change(principal: AuthenticatedPrincipal, workspaceId: string, target: string, role: WorkspaceRole | undefined,
    expected: string | undefined): Promise<WorkspaceMembers> {
    const userId = userObjectId(target)
    if (role !== undefined && !Object.hasOwn(ROLE_RANK, role)) throw invalidRequest('Choose Owner, Editor, or Reader.')
    return this.repository.withWorkspaceMutation(principal, workspaceId, 'members', async () => {
      const stored = await this.repository.getWorkspaceMetadata(principal, workspaceId)
      requireRevision(expected, stored.etag)
      const members = await this.entries(principal, workspaceId)
      const principalId = principalKeyFor(principal.tenantId, userId)
      const memberId = membershipIdFor(principalId)
      const previous = members.find(item => item.membership.id === memberId)
      if (!previous && role === undefined) throw notFound('This person is not a workspace member.')
      const owners = members.filter(item => item.membership.role === 'owner').length
      if (stored.metadata.ownerCount !== undefined && stored.metadata.ownerCount !== owners) {
        throw unavailable('Workspace ownership data is inconsistent. No access changes were made.')
      }
      const nextOwners = owners - (previous?.membership.role === 'owner' ? 1 : 0) + (role === 'owner' ? 1 : 0)
      if (nextOwners < 1) throw conflict('A workspace must keep at least one explicit owner. Add another owner first.')
      const user = role && (!previous || ROLE_RANK[role] > ROLE_RANK[previous.membership.role])
        ? await eligible(this.users, userId) : undefined
      const timestamp = this.clock().toISOString()
      assertWorkspaceMutationLease(workspaceId)
      const updated = await this.directory.changeMembership({
        metadata: { ...stored.metadata, ownerCount: nextOwners, updatedAt: timestamp },
        expectedMetadataEtag: stored.etag, memberId, expectedMemberEtag: previous?.etag,
        membership: role ? {
          id: memberId, workspaceId, principalId, principalType: 'user', role,
          ...(user ? { name: user.name, email: user.email } : {
            ...(previous?.membership.name !== undefined ? { name: previous.membership.name } : {}),
            ...(previous?.membership.email !== undefined ? { email: previous.membership.email } : {}),
          }),
        } : undefined,
        audit: audit(principal, userId, 'workspace-membership', previous?.membership.role ?? null, role ?? null, timestamp),
      })
      // A successful self-removal must still be acknowledged, not reauthorized into a misleading 404.
      return this.snapshot(principal, updated)
    })
  }
}
