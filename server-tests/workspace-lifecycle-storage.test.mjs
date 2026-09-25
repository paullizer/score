import assert from 'node:assert/strict'
import test from 'node:test'
import { RestError } from '@azure/storage-blob'
import {
  createDirectoryStoreFromContainer, createStateStoreFromContainer, membershipIdFor, StoreConflictError, WorkspaceMutationBusyError,
} from '../dist-server/app.mjs'

test('workspace state deletion is exact-ETag scoped and never a wildcard purge', async () => {
  const calls = []
  const store = createStateStoreFromContainer({
    getBlockBlobClient(name) {
      return {
        async deleteIfExists(options) { calls.push({ name, options }) },
      }
    },
    async getProperties() {},
  })
  await store.deleteState('workspace-one', '"etag-one"')
  assert.deepEqual(calls, [{ name: 'workspace-one/state.json', options: {
    conditions: { ifMatch: '"etag-one"' }, deleteSnapshots: 'include',
  } }])
  await assert.rejects(store.deleteState('workspace-one', '*'), StoreConflictError)
  assert.equal(calls.length, 1)
})

test('state mutation leases survive state deletion and renew with finite Azure duration', async () => {
  const calls = []
  const store = createStateStoreFromContainer({
    getBlockBlobClient(name) {
      calls.push(name)
      return {
        async upload(bytes, length, options) {
          assert.equal(length, 0)
          assert.equal(bytes.byteLength, 0)
          assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
          throw new RestError('Already present', { statusCode: 412 })
        },
        getBlobLeaseClient() {
          return {
            async acquireLease(duration) { calls.push(['acquire', duration]) },
            async renewLease() { calls.push('renew') },
            async releaseLease() { calls.push('release') },
          }
        },
      }
    },
    async getProperties() {},
  })
  const lease = await store.acquireMutationLease('workspace-one')
  await lease.renew()
  await lease.release()
  assert.deepEqual(calls, ['workspace-one/mutation.lock', ['acquire', 60], 'renew', 'release'])
  await assert.rejects(store.acquireMutationLease('../outside'), /Invalid workspace/)
})

test('a lease held by another request is a busy workspace that callers may retry shortly', async () => {
  let acquired = false
  const store = createStateStoreFromContainer({
    getBlockBlobClient() {
      return {
        async upload() { throw new RestError('Already present', { statusCode: 412 }) },
        getBlobLeaseClient() {
          return {
            async acquireLease() {
              if (acquired) throw new RestError('There is already a lease present.', { statusCode: 409 })
              acquired = true
            },
            async renewLease() {},
            async releaseLease() { acquired = false },
          }
        },
      }
    },
    async getProperties() {},
  })
  const held = await store.acquireMutationLease('workspace-one')
  await assert.rejects(store.acquireMutationLease('workspace-one'), error => {
    assert.ok(error instanceof WorkspaceMutationBusyError)
    assert.ok(error instanceof StoreConflictError, 'Existing conflict handling still applies')
    assert.equal(error.name, 'StoreConflictError')
    assert.equal(error.message, 'Another workspace change is in progress. Reload and retry.')
    return true
  })
  await held.release()
  await (await store.acquireMutationLease('workspace-one')).release()
})

test('unavailable leases and authorization errors fail closed rather than pretending serialization', async () => {
  const denied = new RestError('Denied', { statusCode: 403 })
  const store = createStateStoreFromContainer({
    getBlockBlobClient() {
      return {
        async upload() { throw denied },
        getBlobLeaseClient() { assert.fail('Must not proceed after a storage denial') },
      }
    },
    async getProperties() {},
  })
  await assert.rejects(store.acquireMutationLease('workspace-one'), error => error === denied)
  const unsupported = createStateStoreFromContainer({ getBlockBlobClient() { return {} }, async getProperties() {} })
  await assert.rejects(unsupported.acquireMutationLease('workspace-one'), /does not support mutation leases/)
})

test('directory cleanup preserves recovery until owner removal and retirement publish atomically', async () => {
  const records = new Map()
  const key = (partition, id) => `${partition}:${id}`
  const ownerId = membershipIdFor('owner')
  for (const partition of ['workspace-one', 'workspace-other']) {
    records.set(key(partition, 'workspace'), { id: 'workspace', workspaceId: partition, ownerId: 'owner', _etag: '"metadata"' })
    for (let index = 0; index < 215; index++) {
      const id = index === 0 ? ownerId : `member-${index}`
      records.set(key(partition, id), { id, workspaceId: partition, principalType: 'user',
        principalId: index === 0 ? 'owner' : `user-${index}`, _etag: `"member-${index}"` })
    }
  }
  const batches = []
  let rejectRetirement = true
  const store = createDirectoryStoreFromContainer({
    item(id, partition) { return { async read() {
      const resource = records.get(key(partition, id))
      return resource ? { resource } : { statusCode: 404 }
    } } },
    items: {
      query(query, options) {
        assert.equal(options.partitionKey, 'workspace-one')
        assert.ok(query.parameters.some(item => item.name === '@ownerId' && item.value === ownerId))
        return { async fetchAll() {
          return { resources: [...records.values()].filter(item => item.workspaceId === options.partitionKey &&
            item.principalType === 'user' && item.id !== ownerId).slice(0, 100) }
        } }
      },
      async batch(operations, partition) {
        batches.push(operations.length)
        if (operations[0].operationType === 'Replace') {
          assert.deepEqual(operations.map(item => item.operationType), ['Replace', 'Delete'])
          assert.equal(operations[1].id, ownerId)
          if (rejectRetirement === 'status') return { code: 503, result: [{ statusCode: 200, eTag: '"uncommitted"' }, { statusCode: 204 }] }
          if (rejectRetirement) return { result: [{ statusCode: 424 }, { statusCode: 412 }] }
        }
        for (const operation of operations) {
          assert.equal(operation.ifMatch, records.get(key(partition, operation.id))._etag)
          if (operation.operationType === 'Delete') records.delete(key(partition, operation.id))
          else records.set(key(partition, operation.id), { ...operation.resourceBody, _etag: '"retired"' })
        }
        return { result: operations.map(item => ({ statusCode: 200, ...(item.operationType === 'Replace' ? { eTag: '"retired"' } : {}) })) }
      },
    },
    async read() {},
  })
  await store.deleteMemberships('workspace-one')
  await store.deleteMemberships('workspace-one')
  assert.deepEqual(batches, [100, 100, 14])
  assert.ok(records.has(key('workspace-one', 'workspace')))
  assert.ok(records.has(key('workspace-one', ownerId)))
  assert.equal([...records.values()].filter(item => item.workspaceId === 'workspace-other').length, 216)
  const retired = {
    id: 'workspace', workspaceId: 'workspace-one', ownerId: 'owner', name: 'Deleted workspace',
    deletedAt: '2026-09-18T15:00:00.000Z',
    lifecycleOperation: { id: 'delete-operation', action: 'delete', status: 'complete', updatedAt: '2026-09-18T15:00:00.000Z' },
  }
  await assert.rejects(store.replaceMetadata(retired, '"metadata"'), StoreConflictError)
  assert.ok(records.has(key('workspace-one', ownerId)), 'A failed retirement must not remove recovery access')
  assert.equal(records.get(key('workspace-one', 'workspace')).deletedAt, undefined)
  rejectRetirement = 'status'
  await assert.rejects(store.replaceMetadata(retired, '"metadata"'), /did not succeed/)
  assert.ok(records.has(key('workspace-one', ownerId)))
  rejectRetirement = false
  assert.equal((await store.replaceMetadata(retired, '"metadata"')).etag, '"retired"')
  assert.equal(records.has(key('workspace-one', ownerId)), false)
  assert.equal(records.get(key('workspace-one', 'workspace')).deletedAt, retired.deletedAt)
  assert.equal([...records.values()].filter(item => item.workspaceId === 'workspace-other').length, 216)
})
