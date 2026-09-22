import { randomUUID } from 'node:crypto'
import type { WorkspaceReviewer, WorkspaceReviewerAccess } from '../../src/domain/cloud'
import type { AuthenticatedPrincipal } from '../auth'
import type { Config } from '../config'
import { conflict, forbidden, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { GUID_PATTERN, membershipIdFor, principalKeyFor } from '../ids'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import type { WorkspaceRepository } from '../repository'
import type { DirectoryStore, MembershipDoc, StoredMetadata } from '../store'

export interface WorkspaceMembersDeps {
  repository: WorkspaceRepository
  directory: DirectoryStore
  config: Pick<Config, 'tenantId' | 'allowedUserIds'>
  now?: () => Date
}

function objectId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80 || !GUID_PATTERN.test(value.trim())) {
    throw invalidRequest('Enter the exact Entra object ID (GUID) of an admitted account, not a name or email.')
  }
  return value.trim().toLowerCase()
}

function exactEtag(value: string | undefined): string {
  if (!value) throw preconditionRequired('Refresh workspace access and supply its current If-Match ETag.')
  if (value.trim() !== value || value === '*' || value.startsWith('W/') || value.length > 1024 || /[,\r\n]/.test(value)) {
    throw invalidRequest('If-Match must contain one exact workspace access ETag.')
  }
  return value
}

function reviewerInput(body: unknown): { objectId: string; label?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest('Reviewer access requires a JSON object.')
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => key !== 'objectId' && key !== 'label')) {
    throw invalidRequest('Only objectId and an optional display label are accepted. Workspace roles and sign-in admission cannot be changed here.')
  }
  if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 80 ||
    [...input.label].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    throw invalidRequest('The optional display label must be at most 80 characters without control characters.')
  }
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  return { objectId: objectId(input.objectId), ...(label ? { label } : {}) }
}

export class WorkspaceMembersService {
  constructor(private readonly deps: WorkspaceMembersDeps) {}

  private async owner(principal: AuthenticatedPrincipal, workspaceId: string): Promise<StoredMetadata> {
    if (principal.tenantId !== this.deps.config.tenantId || !this.deps.config.allowedUserIds.has(principal.oid) ||
      principal.principalKey !== principalKeyFor(principal.tenantId, principal.oid)) throw notFound()
    const role = await this.deps.repository.authorizeWorkspace(principal, workspaceId, 'read')
    if (role !== 'owner') throw forbidden('Only the workspace owner can manage reviewer access.')
    const stored = await this.deps.repository.getWorkspaceMetadata(principal, workspaceId)
    if (stored.metadata.ownerId !== principal.principalKey) throw forbidden('Only the workspace owner can manage reviewer access.')
    return stored
  }

  private reviewer(membership: MembershipDoc, stored: StoredMetadata): WorkspaceReviewer {
    const { metadata } = stored
    const oid = membership.principalId.slice(metadata.tenantId.length + 1)
    if (membership.workspaceId !== metadata.workspaceId || membership.role !== 'reviewer' ||
      membership.principalType !== 'user' || !membership.principalId.startsWith(`${metadata.tenantId}:`) ||
      !GUID_PATTERN.test(oid) || membership.id !== membershipIdFor(membership.principalId) || membership.principalId === metadata.ownerId) {
      throw unavailable('The saved reviewer membership has invalid scope. Nothing has been changed.')
    }
    return { objectId: oid, role: 'reviewer', ...(membership.label ? { label: membership.label } : {}) }
  }

  async list(principal: AuthenticatedPrincipal, workspaceId: string): Promise<WorkspaceReviewerAccess> {
    const stored = await this.owner(principal, workspaceId)
    const memberships = await this.deps.directory.listReviewerMemberships(workspaceId)
    const current = await this.owner(principal, workspaceId)
    if (current.etag !== stored.etag) throw conflict('Workspace access changed while loading. Refresh its reviewer list.')
    return {
      workspaceId, tenantId: stored.metadata.tenantId, etag: stored.etag,
      reviewers: memberships.map(item => this.reviewer(item.membership, stored)).sort((a, b) => a.objectId.localeCompare(b.objectId)),
    }
  }

  async add(principal: AuthenticatedPrincipal, workspaceId: string, body: unknown, ifMatch: string | undefined): Promise<WorkspaceReviewerAccess> {
    await this.owner(principal, workspaceId)
    const etag = exactEtag(ifMatch)
    const input = reviewerInput(body)
    if (!this.deps.config.allowedUserIds.has(input.objectId)) {
      throw invalidRequest('That object ID is not an admitted account in this deployment. Sharing cannot invite users or change sign-in admission.')
    }
    const principalId = principalKeyFor(this.deps.config.tenantId, input.objectId)
    return this.deps.repository.withWorkspaceMutation(principal, workspaceId, 'manage', async () => {
      const stored = await this.owner(principal, workspaceId)
      if (stored.etag !== etag) throw conflict('Workspace access changed. Refresh before adding a reviewer.')
      if (principalId === stored.metadata.ownerId) throw forbidden("The owner's recovery membership cannot be changed.")
      const id = membershipIdFor(principalId)
      if (await this.deps.directory.getStoredMembership(workspaceId, id)) {
        throw conflict('This account already has workspace access. Existing roles cannot be changed here.')
      }
      const timestamp = (this.deps.now?.() ?? new Date()).toISOString()
      const membership = { id, workspaceId, principalId, principalType: 'user' as const, role: 'reviewer' as const,
        ...(input.label ? { label: input.label } : {}) }
      assertWorkspaceMutationLease(workspaceId)
      await this.deps.directory.changeReviewerMembership({
        metadata: { ...stored.metadata, updatedAt: timestamp }, expectedMetadataEtag: stored.etag, membership,
        audit: {
          id: `membership-audit-${randomUUID()}`, type: 'membership-audit', workspaceId, action: 'reviewer-added',
          actorId: principal.principalKey, targetPrincipalId: principalId, membershipId: id, role: 'reviewer',
          ...(input.label ? { label: input.label } : {}), createdAt: timestamp,
        },
      })
      return this.list(principal, workspaceId)
    })
  }

  async remove(principal: AuthenticatedPrincipal, workspaceId: string, rawObjectId: unknown, ifMatch: string | undefined): Promise<WorkspaceReviewerAccess> {
    await this.owner(principal, workspaceId)
    const etag = exactEtag(ifMatch)
    const principalId = principalKeyFor(this.deps.config.tenantId, objectId(rawObjectId))
    return this.deps.repository.withWorkspaceMutation(principal, workspaceId, 'manage', async () => {
      const stored = await this.owner(principal, workspaceId)
      if (stored.etag !== etag) throw conflict('Workspace access changed. Refresh before removing a reviewer.')
      if (principalId === stored.metadata.ownerId) throw forbidden("The owner's recovery membership cannot be removed.")
      const membership = await this.deps.directory.getStoredMembership(workspaceId, membershipIdFor(principalId))
      if (!membership) throw notFound('Reviewer membership not found.')
      if (membership.membership.role !== 'reviewer') throw forbidden('Only reviewer memberships can be removed here. Existing owner, editor, and viewer access is unchanged.')
      this.reviewer(membership.membership, stored)
      const timestamp = (this.deps.now?.() ?? new Date()).toISOString()
      assertWorkspaceMutationLease(workspaceId)
      await this.deps.directory.changeReviewerMembership({
        metadata: { ...stored.metadata, updatedAt: timestamp }, expectedMetadataEtag: stored.etag,
        membership: { ...membership.membership, role: 'reviewer' }, expectedMembershipEtag: membership.etag,
        audit: {
          id: `membership-audit-${randomUUID()}`, type: 'membership-audit', workspaceId, action: 'reviewer-removed',
          actorId: principal.principalKey, targetPrincipalId: principalId, membershipId: membership.membership.id,
          role: 'reviewer', ...(membership.membership.label ? { label: membership.membership.label } : {}), createdAt: timestamp,
        },
      })
      return this.list(principal, workspaceId)
    })
  }
}
