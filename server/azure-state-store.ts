import { BlobServiceClient, RestError } from '@azure/storage-blob'
import type { BlockBlobClient } from '@azure/storage-blob'
import { buffer as streamToBuffer } from 'node:stream/consumers'
import type { TokenCredential } from '@azure/identity'
import type { StorageConfig } from './config'
import { StoreConflictError, type StateStore } from './store'

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

  async function createState(workspaceId: string, content: string) {
    const blob = containerClient.getBlockBlobClient(blobPathFor(workspaceId))
    const body = Buffer.from(content, 'utf8')
    try {
      const response = await blob.upload(body, body.byteLength, {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json' },
      })
      if (typeof response.etag !== 'string') throw new Error('Blob upload did not return an etag.')
      return { created: true, etag: response.etag }
    } catch (error) {
      if (statusCodeOf(error) === 409 || statusCodeOf(error) === 412) {
        // Lost a create race (e.g. a concurrent default-workspace bootstrap); read back what won.
        const existing = await getState(workspaceId)
        if (existing) return { created: false, etag: existing.etag }
      }
      throw error
    }
  }

  async function putState(workspaceId: string, content: string, expectedEtag: string) {
    const blob = containerClient.getBlockBlobClient(blobPathFor(workspaceId))
    const body = Buffer.from(content, 'utf8')
    try {
      const response = await blob.upload(body, body.byteLength, {
        conditions: { ifMatch: expectedEtag },
        blobHTTPHeaders: { blobContentType: 'application/json' },
      })
      if (typeof response.etag !== 'string') throw new Error('Blob upload did not return an etag.')
      return { etag: response.etag }
    } catch (error) {
      const statusCode = statusCodeOf(error)
      if (statusCode === 412 || statusCode === 404) throw new StoreConflictError('The workspace state changed since it was last loaded.')
      throw error
    }
  }

  async function checkAccess() {
    await containerClient.getProperties()
  }

  const store: StateStore = { getState, createState, putState, checkAccess }
  return store
}
