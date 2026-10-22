import { BlobServiceClient, RestError } from '@azure/storage-blob'
import type { BlobLeaseClient, BlockBlobClient } from '@azure/storage-blob'
import { buffer as streamToBuffer } from 'node:stream/consumers'
import type { TokenCredential } from '@azure/identity'
import type { StorageConfig } from './config'
import { StoreConflictError, WorkspaceMutationBusyError, type StateStore } from './store'
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

const DEFAULT_MUTATION_LEASE_WAIT_MS = 25_000
const DEFAULT_MUTATION_LEASE_POLL_MS = 200

export interface StateStoreOptions {
  readonly acquireWaitMs?: number
  readonly acquirePollMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** Real Blob Storage-backed {@link StateStore}, authenticated with Azure AD (never account keys). */
export function createAzureStateStore(config: StorageConfig, credential: TokenCredential): StateStore {
  const service = new BlobServiceClient(config.accountUrl, credential)
  const containerClient = service.getContainerClient(config.containerName)
  return createStateStoreFromContainer(containerClient, { acquireWaitMs: DEFAULT_MUTATION_LEASE_WAIT_MS })
}

export function createStateStoreFromContainer(containerClient: StateBlobContainer, options: StateStoreOptions = {}): StateStore {
  const acquireWaitMs = options.acquireWaitMs ?? 0
  const acquirePollMs = options.acquirePollMs ?? DEFAULT_MUTATION_LEASE_POLL_MS
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  if (!Number.isInteger(acquireWaitMs) || acquireWaitMs < 0 || !Number.isInteger(acquirePollMs) || acquirePollMs < 1) {
    throw new Error('Invalid workspace mutation lease wait configuration.')
  }
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
    const started = now()
    for (;;) {
      try {
        await lease.acquireLease(60)
        break
      } catch (error) {
        if (![409, 412].includes(statusCodeOf(error) ?? 0)) throw error
        const elapsed = now() - started
        if (elapsed >= acquireWaitMs) throw new WorkspaceMutationBusyError()
        await sleep(Math.min(acquirePollMs, Math.max(1, acquireWaitMs - elapsed)))
      }
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
