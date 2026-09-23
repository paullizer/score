import { BlobServiceClient, RestError } from '@azure/storage-blob'
import type { BlobLeaseClient, BlockBlobClient } from '@azure/storage-blob'
import { buffer as streamToBuffer } from 'node:stream/consumers'
import type { TokenCredential } from '@azure/identity'
import type { StorageConfig } from './config'
import { StoreConflictError, type StateStore } from './store'
import { isValidWorkspaceId } from './ids'

function statusCodeOf(error: unknown): number | undefined {
  return error instanceof RestError ? error.statusCode : undefined
}

function blobPathFor(workspaceId: string): string {
  return `${workspaceId}/state.json`
}

interface StateBlobContainer {
  getBlockBlobClient(path: string): {
    download(): Promise<Pick<Awaited<ReturnType<BlockBlobClient['download']>>, 'readableStreamBody' | 'etag'>>
    upload(...args: Parameters<BlockBlobClient['upload']>): Promise<Pick<Awaited<ReturnType<BlockBlobClient['upload']>>, 'etag'>>
    deleteIfExists?(...args: Parameters<BlockBlobClient['deleteIfExists']>): Promise<unknown>
    getBlobLeaseClient?(): Pick<BlobLeaseClient, 'acquireLease' | 'renewLease' | 'releaseLease'>
  }
  getProperties(): Promise<unknown>
}

/** Real Blob Storage-backed {@link StateStore}, authenticated with Azure AD (never account keys). */
export function createAzureStateStore(config: StorageConfig, credential: TokenCredential): StateStore {
  const service = new BlobServiceClient(config.accountUrl, credential)
  const containerClient = service.getContainerClient(config.containerName)
  return createStateStoreFromContainer(containerClient)
}

export function createStateStoreFromContainer(containerClient: StateBlobContainer): StateStore {
  async function getState(workspaceId: string) {
    const blob = containerClient.getBlockBlobClient(blobPathFor(workspaceId))
    let response
    try {
      response = await blob.download()
    } catch (error) {
      if (statusCodeOf(error) === 404) return undefined
      throw error
    }
    if (!response.readableStreamBody) throw new Error('Blob download returned no content stream.')
    if (typeof response.etag !== 'string') throw new Error('Blob download did not return an etag.')
    const content = (await streamToBuffer(response.readableStreamBody)).toString('utf8')
    return { content, etag: response.etag }
  }

  async function checkAccess() {
    await containerClient.getProperties()
  }

  async function deleteState(workspaceId: string, expectedEtag: string) {
    const blob = containerClient.getBlockBlobClient(blobPathFor(workspaceId))
    if (!blob.deleteIfExists) throw new Error('The state store does not support deletion.')
    if (!expectedEtag || expectedEtag === '*') throw new StoreConflictError('An exact state ETag is required.')
    try {
      await blob.deleteIfExists({ conditions: { ifMatch: expectedEtag }, deleteSnapshots: 'include' })
    } catch (error) {
      if ([409, 412].includes(statusCodeOf(error) ?? 0)) throw new StoreConflictError('The workspace state changed during deletion.')
      throw error
    }
  }

  async function acquireMutationLease(workspaceId: string) {
    if (!isValidWorkspaceId(workspaceId)) throw new Error('Invalid workspace mutation scope.')
    // Kept separately from state.json so an interrupted purge can still be resumed under a lease.
    const blob = containerClient.getBlockBlobClient(`${workspaceId}/mutation.lock`)
    if (!blob.getBlobLeaseClient) throw new Error('The state store does not support mutation leases.')
    try {
      await blob.upload(Buffer.alloc(0), 0, { conditions: { ifNoneMatch: '*' } })
    } catch (error) {
      if (![409, 412].includes(statusCodeOf(error) ?? 0)) throw error
    }
    const lease = blob.getBlobLeaseClient()
    try {
      await lease.acquireLease(60)
    } catch (error) {
      if ([409, 412].includes(statusCodeOf(error) ?? 0)) {
        throw new StoreConflictError('Another workspace change is in progress. Reload and retry.')
      }
      throw error
    }
    return {
      async renew() {
        try { await lease.renewLease() } catch (error) {
          if ([404, 409, 412].includes(statusCodeOf(error) ?? 0)) throw new StoreConflictError('The workspace mutation lease was lost.')
          throw error
        }
      },
      async release() { await lease.releaseLease() },
    }
  }

  const store: StateStore = { getState, deleteState, acquireMutationLease, checkAccess }
  return store
}
