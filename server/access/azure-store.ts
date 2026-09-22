import { CosmosClient, ErrorResponse, type Container, type OperationInput } from '@azure/cosmos'
import type { TokenCredential } from '@azure/identity'
import type { CosmosConfig } from '../config'
import { StoreConflictError } from '../store'
import type { AccessStore, CreationGrant } from './store'

export function createAzureAccessStore(config: CosmosConfig, container: string, credential: TokenCredential): AccessStore {
  const client = new CosmosClient({ endpoint: config.endpoint, aadCredentials: credential })
  return createAccessStoreFromContainer(client.database(config.database).container(container))
}

export function createAccessStoreFromContainer(container: Pick<Container, 'item' | 'items'>): AccessStore {
  return {
    async getGrant(tenantId, userId) {
      let response
      try {
        response = await container.item(`grant-${userId}`, tenantId).read<CreationGrant & { _etag?: string }>()
      } catch (error) {
        if (error instanceof ErrorResponse && Number(error.code) === 404) return undefined
        throw error
      }
      if (response.statusCode === 404) return undefined
      const grant = response.resource
      if (!grant?._etag || grant.tenantId !== tenantId || grant.userId !== userId ||
        grant.id !== `grant-${userId}` || typeof grant.canCreateWorkspaces !== 'boolean') {
        throw new Error('Stored workspace-creation permission is invalid.')
      }
      return { grant, etag: grant._etag }
    },
    async setGrant(grant, expectedEtag, audit) {
      const operations: OperationInput[] = [
        expectedEtag
          ? { operationType: 'Replace', id: grant.id, ifMatch: expectedEtag, resourceBody: { ...grant } }
          : { operationType: 'Create', resourceBody: { ...grant } },
        { operationType: 'Create', resourceBody: { ...audit } },
      ]
      try {
        const response = await container.items.batch(operations, grant.tenantId)
        const results = response.result ?? []
        if (results.length !== 2 || results.some(item => item.statusCode < 200 || item.statusCode >= 300) ||
          (response.code !== undefined && (response.code < 200 || response.code >= 300))) {
          const code = results.find(item => item.statusCode >= 400 && item.statusCode !== 424)?.statusCode ?? response.code
          if ([404, 409, 412, 424].includes(code ?? 0)) throw new StoreConflictError('Creation permission changed. Reload before trying again.')
          throw new Error('The workspace-creation permission transaction did not succeed.')
        }
      } catch (error) {
        if (error instanceof ErrorResponse && [404, 409, 412].includes(Number(error.code))) throw new StoreConflictError()
        throw error
      }
    },
  }
}
