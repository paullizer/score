import { CosmosClient, ErrorResponse } from '@azure/cosmos'
import type { Container, DeleteOperation, OperationInput } from '@azure/cosmos'
import type { TokenCredential } from '@azure/identity'
import type { CosmosConfig } from './config'
import { GUID_PATTERN, membershipIdFor } from './ids'
import {
  StoreConflictError,
  StoreNotFoundError,
  type DirectoryStore,
  type MembershipDoc,
  type WorkspaceMetadataDoc,
} from './store'

// Cosmos stores every system field (_rid, _self, _etag, _attachments, _ts, ...) alongside our own
// properties; this is the shape we read those documents back as before stripping to our own type.
type CosmosDoc<T> = T & { _etag?: string }

function isErrorResponse(error: unknown): error is ErrorResponse {
  return error instanceof ErrorResponse
}

function statusCodeOf(error: unknown): number | undefined {
  if (!isErrorResponse(error)) return undefined
  return typeof error.code === 'number' ? error.code : undefined
}

/** Strips Cosmos's `_etag` system field, returning only our own document shape. */
function omitEtag<T extends object>(doc: CosmosDoc<T>): T {
  const rest: Record<string, unknown> = { ...doc }
  delete rest._etag
  return rest as T
}

/** Real Cosmos DB-backed {@link DirectoryStore}, authenticated with Azure AD (never account keys). */
export function createAzureDirectoryStore(config: CosmosConfig, credential: TokenCredential): DirectoryStore {
  const client = new CosmosClient({ endpoint: config.endpoint, aadCredentials: credential })
  const container: Container = client.database(config.database).container(config.container)
  return createDirectoryStoreFromContainer(container)
}

export function createDirectoryStoreFromContainer(container: Pick<Container, 'item' | 'items' | 'read'>): DirectoryStore {
  return {
    async getMetadata(workspaceId) {
      let response
      try {
        response = await container.item('workspace', workspaceId).read<CosmosDoc<WorkspaceMetadataDoc>>()
      } catch (error) {
        if (statusCodeOf(error) === 404) return undefined
        throw error
      }
      if (response.statusCode === 404) return undefined
      if (!response.resource) throw new Error('Cosmos returned no workspace metadata body.')
      const _etag = response.resource._etag
      if (typeof _etag !== 'string') throw new Error('Cosmos workspace metadata is missing an _etag.')
      return { metadata: omitEtag(response.resource), etag: _etag }
    },

    async getMembership(workspaceId, membershipId) {
      let response
      try {
        response = await container.item(membershipId, workspaceId).read<CosmosDoc<MembershipDoc>>()
      } catch (error) {
        if (statusCodeOf(error) === 404) return undefined
        throw error
      }
      if (response.statusCode === 404) return undefined
      if (!response.resource) throw new Error('Cosmos returned no membership body.')
      return omitEtag(response.resource)
    },

    async getStoredMembership(workspaceId, membershipId) {
      let response
      try {
        response = await container.item(membershipId, workspaceId).read<CosmosDoc<MembershipDoc>>()
      } catch (error) {
        if (statusCodeOf(error) === 404) return undefined
        throw error
      }
      if (response.statusCode === 404) return undefined
      if (!response.resource || !response.resource._etag) throw new Error('Cosmos membership is missing its body or ETag.')
      return { membership: omitEtag(response.resource), etag: response.resource._etag }
    },

    async listReviewerMemberships(workspaceId) {
      const { resources } = await container.items.query<CosmosDoc<MembershipDoc>>({
        query: 'SELECT * FROM c WHERE c.principalType = @principalType AND c.role = @role',
        parameters: [{ name: '@principalType', value: 'user' }, { name: '@role', value: 'reviewer' }],
      }, { partitionKey: workspaceId }).fetchAll()
      return resources.map(resource => {
        if (!resource._etag || resource.workspaceId !== workspaceId || resource.principalType !== 'user' || resource.role !== 'reviewer') {
          throw new Error('Cosmos returned invalid reviewer scope or concurrency metadata.')
        }
        return { membership: omitEtag(resource), etag: resource._etag }
      })
    },

    async changeReviewerMembership({ metadata, expectedMetadataEtag, membership, expectedMembershipEtag, audit }) {
      const removing = audit.action === 'reviewer-removed'
      const objectId = membership.principalId.slice(metadata.tenantId.length + 1)
      if (!expectedMetadataEtag || expectedMetadataEtag === '*' ||
        (removing && (!expectedMembershipEtag || expectedMembershipEtag === '*')) ||
        (!removing && (audit.action !== 'reviewer-added' || expectedMembershipEtag !== undefined))) {
        throw new StoreConflictError('Exact membership and workspace concurrency conditions are required.')
      }
      if (metadata.deletedAt || (metadata.lifecycleOperation && metadata.lifecycleOperation.status !== 'complete') ||
        membership.workspaceId !== metadata.workspaceId || membership.principalType !== 'user' || membership.role !== 'reviewer' ||
        !membership.principalId.startsWith(`${metadata.tenantId}:`) || !GUID_PATTERN.test(objectId) ||
        membership.id !== membershipIdFor(membership.principalId) ||
        audit.type !== 'membership-audit' || !audit.id.startsWith('membership-audit-') || audit.workspaceId !== metadata.workspaceId ||
        !audit.actorId.startsWith(`${metadata.tenantId}:`) || !GUID_PATTERN.test(audit.actorId.slice(metadata.tenantId.length + 1)) ||
        audit.targetPrincipalId !== membership.principalId ||
        audit.membershipId !== membership.id || audit.role !== 'reviewer') {
        throw new StoreConflictError('The reviewer change does not match its workspace ownership or lifecycle fence.')
      }
      const actorId = membershipIdFor(audit.actorId)
      let actor: CosmosDoc<MembershipDoc> | undefined
      try {
        actor = (await container.item(actorId, metadata.workspaceId).read<CosmosDoc<MembershipDoc>>()).resource
      } catch (error) {
        if (statusCodeOf(error) !== 404) throw error
      }
      if (!actor || actor.id !== actorId || actor.workspaceId !== metadata.workspaceId ||
        actor.principalId !== audit.actorId || actor.principalType !== 'user' || actor.role !== 'owner') {
        throw new StoreConflictError('Only a current explicit workspace owner can change reviewer access.')
      }
      const { lifecycleOperation, ...fields } = metadata
      const removeMembership: DeleteOperation = { operationType: 'Delete', id: membership.id, ifMatch: expectedMembershipEtag }
      const operations: OperationInput[] = [
        { operationType: 'Replace', id: 'workspace', ifMatch: expectedMetadataEtag,
          resourceBody: { ...fields, ...(lifecycleOperation ? { lifecycleOperation: { ...lifecycleOperation } } : {}) } },
        removing
          ? removeMembership
          : { operationType: 'Create', resourceBody: { ...membership } },
        { operationType: 'Create', resourceBody: { ...audit } },
      ]
      try {
        const response = await container.items.batch(operations, metadata.workspaceId)
        const results = response.result ?? []
        if (results.length !== operations.length || results.some(item => item.statusCode < 200 || item.statusCode >= 300) ||
          (response.code !== undefined && (response.code < 200 || response.code >= 300))) {
          const code = results.find(item => item.statusCode >= 400 && item.statusCode !== 424)?.statusCode ?? response.code
          if ([404, 409, 412, 424].includes(code ?? 0)) throw new StoreConflictError('Workspace access changed. Refresh before retrying.')
          throw new Error('The reviewer membership transaction did not succeed.')
        }
        const etag = results[0]?.eTag
        if (!etag) throw new Error('The reviewer membership transaction returned no workspace ETag.')
        return { metadata, etag }
      } catch (error) {
        if ([404, 409, 412].includes(statusCodeOf(error) ?? 0)) throw new StoreConflictError('Workspace access changed. Refresh before retrying.')
        throw error
      }
    },

    async listMembershipsForPrincipal(principalKey) {
      const { resources } = await container.items
        .query<CosmosDoc<MembershipDoc>>({
          query: 'SELECT * FROM c WHERE c.principalType = @principalType AND c.principalId = @principalId',
          parameters: [
            { name: '@principalType', value: 'user' },
            { name: '@principalId', value: principalKey },
          ],
        })
        .fetchAll()
      return resources.map((resource) => omitEtag(resource))
    },

    async listMetadataForTenant(tenantId) {
      const { resources } = await container.items.query<CosmosDoc<WorkspaceMetadataDoc>>({
        query: "SELECT * FROM c WHERE c.id = 'workspace' AND c.tenantId = @tenantId",
        parameters: [{ name: '@tenantId', value: tenantId }],
      }).fetchAll()
      return resources.map(resource => {
        if (!resource._etag) throw new Error('Workspace metadata is missing its ETag.')
        return { metadata: omitEtag(resource), etag: resource._etag }
      })
    },

    async listWorkspaceMemberships(workspaceId) {
      const { resources } = await container.items.query<CosmosDoc<MembershipDoc>>({
        query: 'SELECT * FROM c WHERE c.principalType = @type',
        parameters: [{ name: '@type', value: 'user' }],
      }, { partitionKey: workspaceId }).fetchAll()
      return resources.map(resource => {
        if (!resource._etag || resource.workspaceId !== workspaceId) throw new Error('Membership scope or concurrency metadata is invalid.')
        return { membership: omitEtag(resource), etag: resource._etag }
      })
    },

    async changeMembership(change) {
      const { metadata, expectedMetadataEtag, memberId, membership, expectedMemberEtag, audit } = change
      if (!expectedMetadataEtag || expectedMetadataEtag === '*' || (!membership && !expectedMemberEtag)) {
        throw new StoreConflictError('Current access revisions are required.')
      }
      const { lifecycleOperation, ...fields } = metadata
      const operations: OperationInput[] = [{
        operationType: 'Replace', id: 'workspace', ifMatch: expectedMetadataEtag,
        resourceBody: { ...fields, ...(lifecycleOperation ? { lifecycleOperation: { ...lifecycleOperation } } : {}) },
      }]
      if (membership) {
        operations.push(expectedMemberEtag
          ? { operationType: 'Replace', id: memberId, ifMatch: expectedMemberEtag, resourceBody: { ...membership } }
          : { operationType: 'Create', resourceBody: { ...membership } })
      } else {
        const remove: DeleteOperation = { operationType: 'Delete', id: memberId, ifMatch: expectedMemberEtag }
        operations.push(remove)
      }
      operations.push({ operationType: 'Create', resourceBody: { ...audit, workspaceId: metadata.workspaceId } })
      try {
        const response = await container.items.batch(operations, metadata.workspaceId)
        const results = response.result ?? []
        if (results.length !== operations.length || results.some(item => item.statusCode < 200 || item.statusCode >= 300) ||
          (response.code !== undefined && (response.code < 200 || response.code >= 300))) {
          const code = results.find(item => item.statusCode >= 400 && item.statusCode !== 424)?.statusCode ?? response.code
          if ([404, 409, 412, 424].includes(code ?? 0)) throw new StoreConflictError('Workspace access changed. Reload members before trying again.')
          throw new Error('The workspace access transaction did not succeed.')
        }
        const etag = results[0]?.eTag
        if (!etag) throw new Error('Workspace access transaction returned no metadata ETag.')
        return { metadata, etag }
      } catch (error) {
        if ([404, 409, 412].includes(statusCodeOf(error) ?? 0)) throw new StoreConflictError()
        throw error
      }
    },

    async createWorkspace(metadata, membership) {
      const { lifecycleOperation, ...fields } = metadata
      const response = await container.items.batch(
        [
          { operationType: 'Create', resourceBody: { ...fields, ...(lifecycleOperation ? { lifecycleOperation: { ...lifecycleOperation } } : {}) } },
          { operationType: 'Upsert', resourceBody: { ...membership } },
        ],
        metadata.workspaceId,
      )
      const results = response.result ?? []
      const allSucceeded = results.length === 2 && results.every((item) => item.statusCode >= 200 && item.statusCode < 300)
      if (allSucceeded) return { created: true }
      const metadataResult = results[0]
      if (metadataResult && metadataResult.statusCode === 409) return { created: false }
      throw new Error(`Cosmos workspace creation did not succeed (batch status ${response.code ?? 'unknown'}).`)
    },

    async renameWorkspace(workspaceId, name, updatedAt, expectedEtag) {
      const current = await container.item('workspace', workspaceId).read<CosmosDoc<WorkspaceMetadataDoc>>()
      if (current.statusCode === 404 || !current.resource) throw new StoreNotFoundError('Workspace metadata not found.')
      const replacement: WorkspaceMetadataDoc = { ...omitEtag(current.resource), name, updatedAt }
      let response
      try {
        response = await container
          .item('workspace', workspaceId)
          .replace(replacement, { accessCondition: { type: 'IfMatch', condition: expectedEtag } })
      } catch (error) {
        const statusCode = statusCodeOf(error)
        if (statusCode === 412) throw new StoreConflictError('The workspace changed since it was last loaded.')
        if (statusCode === 404) throw new StoreNotFoundError('Workspace metadata not found.')
        throw error
      }
      const resource = response.resource as CosmosDoc<WorkspaceMetadataDoc> | undefined
      if (!resource || typeof resource._etag !== 'string') throw new Error('Cosmos did not return updated workspace metadata.')
      return { metadata: omitEtag(resource), etag: resource._etag }
    },

    async replaceMetadata(metadata, expectedEtag) {
      if (!expectedEtag || expectedEtag === '*') throw new StoreConflictError('The current metadata ETag is required.')
      try {
        if (metadata.deletedAt && metadata.lifecycleOperation?.action === 'delete' && metadata.lifecycleOperation.status === 'complete') {
          const recoveryPrincipalId = metadata.deletionRecoveryPrincipalId ?? metadata.ownerId
          const ownerId = membershipIdFor(recoveryPrincipalId)
          let owner: CosmosDoc<MembershipDoc> | undefined
          try {
            const response = await container.item(ownerId, metadata.workspaceId).read<CosmosDoc<MembershipDoc>>()
            owner = response.resource
          } catch (error) {
            if (statusCodeOf(error) !== 404) throw error
          }
          const { lifecycleOperation, ...fields } = metadata
          const operations: OperationInput[] = [{
            operationType: 'Replace', id: 'workspace', ifMatch: expectedEtag,
            resourceBody: { ...fields, lifecycleOperation: { ...lifecycleOperation } },
          }]
          if (owner) {
            if (!owner._etag || owner.id !== ownerId || owner.workspaceId !== metadata.workspaceId ||
              owner.principalId !== recoveryPrincipalId || owner.principalType !== 'user') {
              throw new Error('The final workspace membership has invalid ownership or concurrency metadata.')
            }
            const removeOwner: DeleteOperation = { operationType: 'Delete', id: ownerId, ifMatch: owner._etag }
            operations.push(removeOwner)
          }
          const response = await container.items.batch(operations, metadata.workspaceId)
          const results = response.result ?? []
          if (results.length !== operations.length || results.some(item => item.statusCode < 200 || item.statusCode >= 300) ||
            (response.code !== undefined && (response.code < 200 || response.code >= 300))) {
            const code = results.find(item => item.statusCode >= 400 && item.statusCode !== 424)?.statusCode ?? response.code
            if ([404, 409, 412, 424].includes(code ?? 0)) throw new StoreConflictError('Workspace finalization changed before publication.')
            throw new Error('The workspace finalization transaction did not succeed.')
          }
          const etag = results[0]?.eTag
          if (!etag) throw new Error('Workspace finalization returned no metadata ETag.')
          return { metadata, etag }
        }
        const response = await container.item('workspace', metadata.workspaceId).replace<CosmosDoc<WorkspaceMetadataDoc>>(
          metadata, { accessCondition: { type: 'IfMatch', condition: expectedEtag } },
        )
        if (!response.resource || typeof response.resource._etag !== 'string') {
          throw new Error('Cosmos did not return the updated workspace metadata.')
        }
        return { metadata: omitEtag(response.resource), etag: response.resource._etag }
      } catch (error) {
        if ([409, 412].includes(statusCodeOf(error) ?? 0)) throw new StoreConflictError()
        if (statusCodeOf(error) === 404) throw new StoreNotFoundError()
        throw error
      }
    },

    async deleteMemberships(workspaceId) {
      const metadata = await container.item('workspace', workspaceId).read<CosmosDoc<WorkspaceMetadataDoc>>()
      if (!metadata.resource || metadata.resource.workspaceId !== workspaceId || !metadata.resource.ownerId) {
        throw new StoreNotFoundError('Workspace ownership is unavailable during membership cleanup.')
      }
      // Keep recovery discoverable until the tombstone and owner removal commit together.
      const ownerId = membershipIdFor(metadata.resource.deletionRecoveryPrincipalId ?? metadata.resource.ownerId)
      for (;;) {
        const response = await container.items.query<CosmosDoc<MembershipDoc>>({
          query: 'SELECT TOP 100 * FROM c WHERE c.principalType = @type AND c.id != @ownerId',
          parameters: [{ name: '@type', value: 'user' }, { name: '@ownerId', value: ownerId }],
        }, { partitionKey: workspaceId }).fetchAll()
        if (!response.resources.length) return
        if (response.resources.some(item => !item._etag || item.workspaceId !== workspaceId ||
          item.principalType !== 'user' || item.id === ownerId)) {
          throw new Error('Workspace membership cleanup returned invalid scope or concurrency metadata.')
        }
        const batch = await container.items.batch(response.resources.map(item => ({
          operationType: 'Delete' as const, id: item.id, ifMatch: item._etag,
        })), workspaceId)
        if (!batch.result || batch.result.length !== response.resources.length ||
          batch.result.some(item => item.statusCode < 200 || item.statusCode >= 300) ||
          (batch.code !== undefined && (batch.code < 200 || batch.code >= 300))) {
          throw new StoreConflictError('Workspace memberships changed during deletion.')
        }
      }
    },

    async listLifecycleOperations(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid lifecycle operation limit.')
      const response = await container.items.query<CosmosDoc<WorkspaceMetadataDoc>>({
        query: `SELECT TOP @limit * FROM c WHERE c.id = 'workspace'
          AND IS_DEFINED(c.lifecycleOperation) AND c.lifecycleOperation.status != 'complete'
          ORDER BY c.updatedAt ASC`,
        parameters: [{ name: '@limit', value: limit }],
      }).fetchAll()
      return response.resources.map(item => {
        if (!item._etag) throw new Error('Workspace lifecycle metadata has no ETag.')
        return { metadata: omitEtag(item), etag: item._etag }
      })
    },

    async checkAccess() {
      await container.read()
    },
  }
}
