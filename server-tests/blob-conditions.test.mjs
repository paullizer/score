import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { RestError } from '@azure/storage-blob'
import { createStateStoreFromContainer } from '../dist-server/app.mjs'

for (const statusCode of [409, 412]) {
  test(`conditional Blob create handles Azure HTTP ${statusCode} without overwriting existing state`, async () => {
    let downloaded = false
    const store = createStateStoreFromContainer({
      getBlockBlobClient(name) {
        assert.equal(name, 'test-workspace/state.json')
        return {
          async upload(_body, _length, options) {
            assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
            throw new RestError('Conditional create failed', { statusCode })
          },
          async download() {
            downloaded = true
            return { etag: '"existing"', readableStreamBody: Readable.from(['{"preserved":true}']) }
          },
        }
      },
      async getProperties() {},
    })
    assert.deepEqual(await store.createState('test-workspace', '{"replacement":true}'), { created: false, etag: '"existing"' })
    assert.equal(downloaded, true)
  })
}

test('a Blob authorization failure is not mistaken for an existing state', async () => {
  const denied = new RestError('Denied', { statusCode: 403 })
  const store = createStateStoreFromContainer({
    getBlockBlobClient() {
      return {
        async upload() { throw denied },
        async download() { assert.fail('Must not fall back to a download after an authorization error') },
      }
    },
    async getProperties() {},
  })
  await assert.rejects(store.createState('test-workspace', '{}'), error => error === denied)
})
