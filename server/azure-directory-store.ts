import { CosmosClient, ErrorResponse } from '@azure/cosmos'
import type { Container } from '@azure/cosmos'
import type { TokenCredential } from '@azure/identity'
import type { CosmosConfig } from './config'
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

    async createWorkspace(metadata, membership) {
      const response = await container.items.batch(
        [
          { operationType: 'Create', resourceBody: { ...metadata } },
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

    async checkAccess() {
      await container.read()
    },
  }
}
