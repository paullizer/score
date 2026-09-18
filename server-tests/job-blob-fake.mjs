import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { RestError } from '@azure/storage-blob'

const fail = statusCode => { throw new RestError(`Blob ${statusCode}`, { statusCode }) }

export function fakeJobBlobContainer() {
  const values = new Map()
  const prefixes = []
  const deleted = []
  let counter = 0
  let beforeContentUpload
  let afterAcquire
  const client = name => ({
    async upload(bytes, _length, options = {}) {
      if (bytes.length && beforeContentUpload) {
        const callback = beforeContentUpload
        beforeContentUpload = undefined
        await callback()
      }
      const existing = values.get(name)
      const lease = existing?.lease && existing.lease.expiresAt > Date.now() ? existing.lease : undefined
      if (options.conditions?.ifNoneMatch === '*' && existing) fail(409)
      if (options.conditions?.leaseId && lease?.id !== options.conditions.leaseId) fail(412)
      if (lease && options.conditions?.leaseId !== lease.id) fail(412)
      if (options.conditions?.ifMatch && options.conditions.ifMatch !== existing?.etag) fail(412)
      const etag = `"blob-${++counter}"`
      values.set(name, {
        bytes: Buffer.from(bytes), contentType: options.blobHTTPHeaders?.blobContentType,
        cacheControl: options.blobHTTPHeaders?.blobCacheControl,
        metadata: options.metadata ?? {}, etag, lease,
      })
      return { etag }
    },
    async download() {
      const value = values.get(name)
      if (!value) fail(404)
      return {
        etag: value.etag, contentType: value.contentType, metadata: value.metadata,
        contentLength: value.bytes.length, readableStreamBody: Readable.from([value.bytes]),
      }
    },
    async getProperties() {
      const value = values.get(name)
      if (!value) fail(404)
      return { etag: value.etag, metadata: value.metadata }
    },
    getBlobLeaseClient(proposedId = randomUUID()) {
      return {
        leaseId: proposedId,
        async acquireLease(seconds) {
          const value = values.get(name)
          if (!value) fail(404)
          if (value.lease?.expiresAt > Date.now()) fail(409)
          value.lease = { id: proposedId, expiresAt: Date.now() + seconds * 1000 }
          if (afterAcquire) {
            const callback = afterAcquire
            afterAcquire = undefined
            await callback()
          }
          return { leaseId: proposedId }
        },
        async releaseLease() {
          const value = values.get(name)
          if (!value) fail(404)
          if (value.lease?.id !== proposedId) fail(412)
          delete value.lease
        },
        async breakLease() {
          const value = values.get(name)
          if (!value) fail(404)
          if (!value.lease) fail(409)
          delete value.lease
        },
      }
    },
    async deleteIfExists(options) {
      assert.equal(options.deleteSnapshots, 'include')
      if (values.get(name)?.lease?.expiresAt > Date.now()) fail(412)
      deleted.push(name)
      return { succeeded: values.delete(name) }
    },
  })
  return {
    container: {
      getBlockBlobClient: client,
      listBlobsFlat({ prefix }) {
        prefixes.push(prefix)
        return {
          byPage({ continuationToken, maxPageSize }) {
            return {
              async next() {
                const names = [...values.keys()].filter(name => name.startsWith(prefix)).sort()
                const offset = Number(continuationToken ?? 0)
                return {
                  done: false,
                  value: {
                    segment: { blobItems: names.slice(offset, offset + maxPageSize).map(name => ({ name })) },
                    ...(offset + maxPageSize < names.length ? { continuationToken: String(offset + maxPageSize) } : {}),
                  },
                }
              },
            }
          },
        }
      },
    },
    values, prefixes, deleted,
    beforeContentUpload(callback) { beforeContentUpload = callback },
    afterAcquire(callback) { afterAcquire = callback },
    expireLeases() { for (const value of values.values()) if (value.lease) value.lease.expiresAt = 0 },
  }
}
