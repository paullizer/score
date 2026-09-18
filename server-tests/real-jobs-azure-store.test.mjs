import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import { RestError } from '@azure/storage-blob'
import { createJobBlobStoreFromContainer } from '../dist-server/app.mjs'

const BLOB_NAME = 'workspace-one/job-123e4567-e89b-42d3-a456-426614174000/original.pdf'

for (const statusCode of [409, 412]) {
  test(`immutable job Blob create handles Azure HTTP ${statusCode} by preserving and returning existing bytes`, async () => {
    const existing = Buffer.from('%PDF-1.7\nexisting bytes', 'ascii')
    let downloaded = false
    const store = createJobBlobStoreFromContainer({
      getBlockBlobClient(name) {
        assert.equal(name, BLOB_NAME)
        return {
          async upload(_body, _length, options) {
            assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
            assert.equal(options.blobHTTPHeaders.blobContentType, 'application/pdf')
            throw new RestError('Conditional create failed', { statusCode })
          },
          async download() {
            downloaded = true
            return {
              etag: '"existing-etag"',
              contentType: 'application/pdf',
              contentLength: existing.byteLength,
              readableStreamBody: Readable.from([existing]),
            }
          },
        }
      },
    })

    const result = await store.putImmutable(BLOB_NAME, Buffer.from('%PDF-1.7\nreplacement'), 'application/pdf')
    assert.equal(result.created, false)
    assert.equal(downloaded, true)
    assert.deepEqual(Buffer.from(result.blob.bytes), existing)
    assert.equal(result.blob.sha256, createHash('sha256').update(existing).digest('hex'))
    assert.equal(result.blob.contentType, 'application/pdf')
    assert.equal(result.blob.etag, '"existing-etag"')
  })
}

test('job Blob adapter rejects caller-controlled paths and bounds reads', async () => {
  const store = createJobBlobStoreFromContainer({
    getBlockBlobClient() {
      return {
        async upload() { assert.fail('unsafe path must not reach Blob Storage') },
        async download() { assert.fail('unsafe or oversized blob must not be consumed') },
      }
    },
  })
  await assert.rejects(store.read('../workspace-state/secret.json'), /Invalid job blob name/)
  await assert.rejects(store.putImmutable('../workspace-state/secret.json', new Uint8Array(), 'application/json'), /Invalid job blob name/)

  const oversized = createJobBlobStoreFromContainer({
    getBlockBlobClient() {
      return {
        async upload() {},
        async download() {
          return {
            etag: '"large"',
            contentType: 'application/pdf',
            contentLength: 10 * 1024 * 1024 + 1,
            readableStreamBody: Readable.from([]),
          }
        },
      }
    },
  })
  await assert.rejects(oversized.read(BLOB_NAME), /exceeds the supported size/)
})
