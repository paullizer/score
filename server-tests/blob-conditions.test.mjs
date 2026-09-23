import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { RestError } from '@azure/storage-blob'
import { createStateStoreFromContainer, StoreConflictError } from '../dist-server/app.mjs'

test('getState returns undefined for a missing legacy state blob', async () => {
  const store = createStateStoreFromContainer({
    getBlockBlobClient(name) {
      assert.equal(name, 'test-workspace/state.json')
      return {
        async download() { throw new RestError('Not found', { statusCode: 404 }) },
      }
    },
    async getProperties() {},
  })
  assert.equal(await store.getState('test-workspace'), undefined)
})

for (const statusCode of [409, 412]) {
  test(`deleteState maps Azure HTTP ${statusCode} to StoreConflictError`, async () => {
    const store = createStateStoreFromContainer({
      getBlockBlobClient(name) {
        assert.equal(name, 'test-workspace/state.json')
        return {
          async deleteIfExists(options) {
            assert.deepEqual(options.conditions, { ifMatch: '"expected"' })
            throw new RestError('Conditional delete failed', { statusCode })
          },
        }
      },
      async getProperties() {},
    })
    await assert.rejects(store.deleteState('test-workspace', '"expected"'), StoreConflictError)
  })
}

test('getState propagates authorization failures instead of treating them as absence', async () => {
  const denied = new RestError('Denied', { statusCode: 403 })
  const store = createStateStoreFromContainer({
    getBlockBlobClient() {
      return {
        async download() { throw denied },
      }
    },
    async getProperties() {},
  })
  await assert.rejects(store.getState('test-workspace'), error => error === denied)
})

test('getState reads existing legacy state content and ETag', async () => {
  const store = createStateStoreFromContainer({
    getBlockBlobClient() {
      return {
        async download() {
          return { etag: '"existing"', readableStreamBody: Readable.from(['{"preserved":true}']) }
        },
      }
    },
    async getProperties() {},
  })
  assert.deepEqual(await store.getState('test-workspace'), { content: '{"preserved":true}', etag: '"existing"' })
})
