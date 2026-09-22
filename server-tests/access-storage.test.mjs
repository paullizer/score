import assert from 'node:assert/strict'
import test from 'node:test'
import { ErrorResponse } from '@azure/cosmos'
import {
  createAccessStoreFromContainer, createDirectoryStoreFromContainer, StoreConflictError,
} from '../dist-server/app.mjs'
import {
  ALLOWED_OID as OWNER, OTHER_ALLOWED_OID as PEER, OTHER_TENANT_ID, TENANT_ID,
  membershipFor, membershipIdFor, principalKeyFor,
} from './helpers.mjs'

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-09-22T13:00:00.000Z'
const clone = value => structuredClone(value)
const metadata = () => ({
  id: 'workspace', workspaceId: WORKSPACE, name: 'Stored fixture', kind: 'personal',
  ownerId: principalKeyFor(TENANT_ID, OWNER), ownerCount: 1, tenantId: TENANT_ID, createdAt: NOW, updatedAt: NOW,
})
const grant = (canCreateWorkspaces = true) => ({
  id: `grant-${PEER}`, tenantId: TENANT_ID, userId: PEER, canCreateWorkspaces,
})
const audit = (id, previous = false, next = true) => ({
  id: `access-${id}`, tenantId: TENANT_ID, actorId: OWNER, targetId: PEER,
  action: typeof next === 'boolean' ? 'workspace-creation' : 'workspace-membership',
  previous, next, createdAt: NOW,
})
const cosmosError = status => {
  const error = new ErrorResponse(`Cosmos ${status}`)
  error.code = status
  return error
}

function transactionalContainer(partitionField) {
  const values = new Map(), batches = [], queries = []
  let sequence = 0, forcedBatch, forcedRead, readError, batchError, queryResources
  const key = (partition, id) => `${partition}/${id}`
  const nextEtag = () => `"cosmos-${++sequence}"`
  const seed = (document, etag = nextEtag()) => {
    values.set(key(document[partitionField], document.id), clone({ ...document, _etag: etag }))
    return etag
  }
  const container = {
    item(id, partition) {
      return {
        async read() {
          if (readError) throw readError
          if (forcedRead !== undefined) return clone(forcedRead)
          const resource = values.get(key(partition, id))
          return resource ? { statusCode: 200, resource: clone(resource) } : { statusCode: 404 }
        },
      }
    },
    items: {
      async batch(operations, partition) {
        batches.push({ operations: clone(operations), partition })
        if (batchError) throw batchError
        if (forcedBatch !== undefined) return clone(forcedBatch)
        const pending = new Map(values), result = []
        for (const operation of operations) {
          const id = operation.id ?? operation.resourceBody.id
          const current = pending.get(key(partition, id))
          let failure
          if (operation.resourceBody && operation.resourceBody[partitionField] !== partition) failure = 400
          else if (operation.operationType === 'Create' && current) failure = 409
          else if (['Replace', 'Delete'].includes(operation.operationType) && !current) failure = 404
          else if (['Replace', 'Delete'].includes(operation.operationType) && current._etag !== operation.ifMatch) failure = 412
          if (failure) {
            return { code: failure, result: operations.map((_, index) => ({ statusCode: index === result.length ? failure : 424 })) }
          }
          if (operation.operationType === 'Delete') {
            pending.delete(key(partition, id))
            result.push({ statusCode: 204 })
          } else {
            const eTag = nextEtag()
            pending.set(key(partition, id), clone({ ...operation.resourceBody, _etag: eTag }))
            result.push({ statusCode: operation.operationType === 'Create' ? 201 : 200, eTag })
          }
        }
        values.clear()
        for (const [id, value] of pending) values.set(id, value)
        return { code: 200, result }
      },
      query(spec, options = {}) {
        queries.push({ spec: clone(spec), options: clone(options) })
        return { async fetchAll() {
          if (queryResources !== undefined) return { resources: clone(queryResources) }
          const parameters = new Map(spec.parameters.map(item => [item.name, item.value]))
          let resources = [...values.values()].filter(value =>
            (options.partitionKey === undefined || value[partitionField] === options.partitionKey) &&
            (!parameters.has('@tenantId') || value.id === 'workspace' && value.tenantId === parameters.get('@tenantId')) &&
            (!parameters.has('@type') || value.principalType === parameters.get('@type')) &&
            (!parameters.has('@principalType') || value.principalType === parameters.get('@principalType')) &&
            (!parameters.has('@principalId') || value.principalId === parameters.get('@principalId')) &&
            (!parameters.has('@ownerId') || value.id !== parameters.get('@ownerId')))
          if (spec.query.includes('TOP 100')) resources = resources.slice(0, 100)
          return { resources: clone(resources) }
        } }
      },
    },
    async read() {},
  }
  return {
    container, batches, queries, seed,
    snapshot() { return clone([...values]) },
    get(partition, id) { return clone(values.get(key(partition, id))) },
    forceBatch(response) { forcedBatch = response },
    forceRead(response) { forcedRead = response },
    failRead(error) { readError = error },
    failBatch(error) { batchError = error },
    forceQuery(resources) { queryResources = resources },
  }
}

test('creation-grant persistence atomically creates or conditionally replaces the tenant-scoped grant and minimal audit', async () => {
  const fake = transactionalContainer('tenantId')
  const store = createAccessStoreFromContainer(fake.container)
  assert.equal(await store.getGrant(TENANT_ID, PEER), undefined)
  await store.setGrant(grant(), undefined, audit('granted'))
  const initial = await store.getGrant(TENANT_ID, PEER)
  assert.equal(initial.grant.canCreateWorkspaces, true)
  assert.equal(await store.getGrant(OTHER_TENANT_ID, PEER), undefined)
  assert.deepEqual(fake.batches[0], {
    partition: TENANT_ID, operations: [
      { operationType: 'Create', resourceBody: grant() },
      { operationType: 'Create', resourceBody: audit('granted') },
    ],
  })
  const before = fake.snapshot()
  await assert.rejects(store.setGrant(grant(false), undefined, audit('duplicate')), StoreConflictError)
  await assert.rejects(store.setGrant(grant(false), '"stale"', audit('stale')), StoreConflictError)
  assert.deepEqual(fake.snapshot(), before)
  await store.setGrant(grant(false), initial.etag, audit('revoked', true, false))
  const revoked = await store.getGrant(TENANT_ID, PEER)
  assert.equal(revoked.grant.canCreateWorkspaces, false)
  assert.notEqual(revoked.etag, initial.etag)
  const transaction = fake.batches.at(-1)
  assert.equal(transaction.partition, TENANT_ID)
  assert.deepEqual(transaction.operations.map(item => item.operationType), ['Replace', 'Create'])
  assert.equal(transaction.operations[0].ifMatch, initial.etag)
  assert.equal(transaction.operations[0].id, grant().id)
  assert.equal(fake.snapshot().length, 3)
  assert.doesNotMatch(JSON.stringify(transaction.operations), /email|name|token|claims|settings/)
})

test('creation-grant initial and replacement races commit exactly one winner and never orphan an audit', async () => {
  const fake = transactionalContainer('tenantId')
  const store = createAccessStoreFromContainer(fake.container)
  const first = await Promise.allSettled([
    store.setGrant(grant(true), undefined, audit('first-true')),
    store.setGrant(grant(false), undefined, audit('first-false', false, false)),
  ])
  assert.deepEqual(first.map(item => item.status).sort(), ['fulfilled', 'rejected'])
  assert.ok(first.find(item => item.status === 'rejected').reason instanceof StoreConflictError)
  assert.equal(fake.snapshot().length, 2)
  const current = await store.getGrant(TENANT_ID, PEER)
  const second = await Promise.allSettled([
    store.setGrant(grant(true), current.etag, audit('next-true')),
    store.setGrant(grant(false), current.etag, audit('next-false', true, false)),
  ])
  assert.deepEqual(second.map(item => item.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(fake.snapshot().length, 3)
})

test('a duplicate creation-grant audit aborts the permission write instead of advancing the grant alone', async () => {
  const fake = transactionalContainer('tenantId')
  const store = createAccessStoreFromContainer(fake.container)
  await store.setGrant(grant(), undefined, audit('original'))
  const current = await store.getGrant(TENANT_ID, PEER)
  const before = fake.snapshot()
  await assert.rejects(store.setGrant(grant(false), current.etag, audit('original', true, false)), StoreConflictError)
  assert.deepEqual(fake.snapshot(), before)
})

test('creation-grant reads distinguish not-found from storage failure and reject malformed or cross-tenant records', async () => {
  const fake = transactionalContainer('tenantId')
  const store = createAccessStoreFromContainer(fake.container)
  fake.failRead(cosmosError(404))
  assert.equal(await store.getGrant(TENANT_ID, PEER), undefined)
  for (const status of [401, 403, 429, 503]) {
    const failure = cosmosError(status)
    fake.failRead(failure)
    await assert.rejects(store.getGrant(TENANT_ID, PEER), error => error === failure)
  }
  fake.failRead(undefined)
  for (const response of [
    { statusCode: 503 }, { statusCode: 200 },
    { resource: grant() },
    ...[
      { tenantId: OTHER_TENANT_ID }, { userId: OWNER }, { id: 'another-grant' },
      { canCreateWorkspaces: 'true' }, { _etag: undefined },
    ].map(fields => ({ resource: { ...grant(), _etag: '"current"', ...fields } })),
  ]) {
    fake.forceRead(response)
    await assert.rejects(store.getGrant(TENANT_ID, PEER), /invalid/)
  }
})

test('creation-grant batch errors, incomplete results, and failure envelopes never return successful saves', async () => {
  const fake = transactionalContainer('tenantId')
  const store = createAccessStoreFromContainer(fake.container)
  for (const response of [
    {}, { code: 200, result: [] }, { result: [{ statusCode: 201 }] },
    { result: [{ statusCode: 201 }, { statusCode: 503 }] },
    { code: 503, result: [{ statusCode: 201 }, { statusCode: 201 }] },
  ]) {
    fake.forceBatch(response)
    await assert.rejects(store.setGrant(grant(), undefined, audit('failed')), /did not succeed/)
    assert.deepEqual(fake.snapshot(), [])
  }
  for (const code of [404, 409, 412, 424]) {
    fake.forceBatch({ code, result: [{ statusCode: code }, { statusCode: 424 }] })
    await assert.rejects(store.setGrant(grant(), undefined, audit('conflicted')), StoreConflictError)
  }
  fake.forceBatch(undefined)
  for (const code of [404, 409, 412]) {
    fake.failBatch(cosmosError(code))
    await assert.rejects(store.setGrant(grant(), undefined, audit('conflicted')), StoreConflictError)
  }
  const failure = cosmosError(503)
  fake.failBatch(failure)
  await assert.rejects(store.setGrant(grant(), undefined, audit('unavailable')), error => error === failure)
  assert.deepEqual(fake.snapshot(), [])
})

function directoryFixture() {
  const fake = transactionalContainer('workspaceId')
  fake.seed(metadata(), '"metadata-original"')
  fake.seed(membershipFor(WORKSPACE, { oid: OWNER, role: 'owner' }), '"owner-original"')
  const store = createDirectoryStoreFromContainer(fake.container)
  const change = {
    metadata: metadata(), expectedMetadataEtag: '"metadata-original"',
    memberId: membershipIdFor(principalKeyFor(TENANT_ID, PEER)),
    membership: membershipFor(WORKSPACE, { oid: PEER, role: 'viewer', name: 'Peer', email: 'peer@example.test' }),
    audit: audit('add-member', null, 'viewer'),
  }
  return { fake, store, change }
}

test('member create, promotion, and creator removal atomically condition metadata, target member, and audit in the workspace partition', async () => {
  const { fake, store, change } = directoryFixture()
  const created = await store.changeMembership(change)
  assert.notEqual(created.etag, change.expectedMetadataEtag)
  assert.deepEqual(fake.batches[0].operations.map(item => item.operationType), ['Replace', 'Create', 'Create'])
  assert.equal(fake.batches[0].partition, WORKSPACE)
  assert.equal(fake.batches[0].operations[0].ifMatch, '"metadata-original"')
  assert.equal(fake.batches[0].operations[2].resourceBody.workspaceId, WORKSPACE)
  assert.equal(fake.batches[0].operations[1].resourceBody.principalType, 'user')
  const peer = (await store.listWorkspaceMemberships(WORKSPACE)).find(item => item.membership.id === change.memberId)
  const promoted = await store.changeMembership({
    ...change, metadata: { ...created.metadata, ownerCount: 2 }, expectedMetadataEtag: created.etag,
    expectedMemberEtag: peer.etag, membership: { ...peer.membership, role: 'owner' }, audit: audit('promote', 'viewer', 'owner'),
  })
  assert.deepEqual(fake.batches[1].operations.map(item => item.operationType), ['Replace', 'Replace', 'Create'])
  assert.equal(fake.batches[1].operations[0].ifMatch, created.etag)
  assert.equal(fake.batches[1].operations[1].ifMatch, peer.etag)
  const owner = (await store.listWorkspaceMemberships(WORKSPACE)).find(item => item.membership.role === 'owner' && item.membership.id !== change.memberId)
  const removed = await store.changeMembership({
    metadata: { ...promoted.metadata, ownerCount: 1 }, expectedMetadataEtag: promoted.etag,
    memberId: owner.membership.id, expectedMemberEtag: owner.etag, audit: { ...audit('remove-creator', 'owner', null), targetId: OWNER },
  })
  assert.deepEqual(fake.batches[2].operations.map(item => item.operationType), ['Replace', 'Delete', 'Create'])
  assert.equal(fake.batches[2].operations[1].ifMatch, owner.etag)
  assert.equal(removed.metadata.ownerId, principalKeyFor(TENANT_ID, OWNER))
  assert.equal(removed.metadata.ownerCount, 1)
  assert.deepEqual((await store.listWorkspaceMemberships(WORKSPACE)).map(item => [item.membership.principalId, item.membership.role]),
    [[principalKeyFor(TENANT_ID, PEER), 'owner']])
  assert.ok(fake.batches.every(batch => batch.operations.length === 3 && batch.partition === WORKSPACE))
})

test('stale metadata/member revisions, duplicate member create, and duplicate audits roll back every membership transaction operation', async () => {
  const { fake, store, change } = directoryFixture()
  const added = await store.changeMembership(change)
  const peer = (await store.listWorkspaceMemberships(WORKSPACE)).find(item => item.membership.id === change.memberId)
  const before = fake.snapshot()
  for (const update of [
    { ...change, audit: audit('stale-metadata', null, 'viewer') },
    { ...change, expectedMetadataEtag: added.etag, audit: audit('duplicate-member', null, 'viewer') },
    { ...change, expectedMetadataEtag: added.etag, expectedMemberEtag: '"stale-member"', audit: audit('stale-member', 'viewer', 'owner') },
    { ...change, expectedMetadataEtag: added.etag, expectedMemberEtag: peer.etag },
    { ...change, expectedMetadataEtag: added.etag, membership: undefined, expectedMemberEtag: '"stale-delete"', audit: audit('stale-delete', 'viewer', null) },
  ]) {
    await assert.rejects(store.changeMembership(update), StoreConflictError)
    assert.deepEqual(fake.snapshot(), before)
  }
  assert.equal((await store.getMetadata(WORKSPACE)).etag, added.etag)
})

test('a membership transaction requires explicit current metadata and deletion ETags before issuing a batch', async () => {
  const { fake, store, change } = directoryFixture()
  for (const invalid of [
    { ...change, expectedMetadataEtag: '' }, { ...change, expectedMetadataEtag: '*' },
    { ...change, membership: undefined, expectedMemberEtag: undefined },
  ]) await assert.rejects(store.changeMembership(invalid), StoreConflictError)
  assert.deepEqual(fake.batches, [])
})

test('member transaction adapters reject incomplete, partial, failed-envelope, and missing-ETag responses', async () => {
  const { fake, store, change } = directoryFixture()
  const before = fake.snapshot()
  for (const response of [
    {}, { result: [] }, { result: [{ statusCode: 200 }, { statusCode: 201 }] },
    { result: [{ statusCode: 200, eTag: '"uncommitted"' }, { statusCode: 201 }, { statusCode: 503 }] },
    { code: 503, result: [{ statusCode: 200, eTag: '"uncommitted"' }, { statusCode: 201 }, { statusCode: 201 }] },
  ]) {
    fake.forceBatch(response)
    await assert.rejects(store.changeMembership(change), /did not succeed/)
    assert.deepEqual(fake.snapshot(), before)
  }
  fake.forceBatch({ code: 200, result: [{ statusCode: 200 }, { statusCode: 201 }, { statusCode: 201 }] })
  await assert.rejects(store.changeMembership(change), /no metadata ETag/)
  for (const code of [404, 409, 412, 424]) {
    fake.forceBatch({ code, result: [{ statusCode: 424 }, { statusCode: code }, { statusCode: 424 }] })
    await assert.rejects(store.changeMembership(change), StoreConflictError)
  }
  fake.forceBatch(undefined)
  for (const code of [404, 409, 412]) {
    fake.failBatch(cosmosError(code))
    await assert.rejects(store.changeMembership(change), StoreConflictError)
  }
  const failure = cosmosError(503)
  fake.failBatch(failure)
  await assert.rejects(store.changeMembership(change), error => error === failure)
  assert.deepEqual(fake.snapshot(), before)
})

test('tenant directory and workspace-member queries are scoped, parameterized, and preserve concurrency metadata', async () => {
  const { fake, store } = directoryFixture()
  fake.seed({ ...metadata(), workspaceId: OTHER_WORKSPACE, tenantId: OTHER_TENANT_ID }, '"foreign"')
  const tenant = await store.listMetadataForTenant(TENANT_ID)
  assert.equal(tenant.length, 1)
  assert.equal(tenant[0].metadata.workspaceId, WORKSPACE)
  assert.equal(tenant[0].etag, '"metadata-original"')
  assert.equal('_etag' in tenant[0].metadata, false)
  const members = await store.listWorkspaceMemberships(WORKSPACE)
  assert.equal(members.length, 1)
  assert.equal(members[0].etag, '"owner-original"')
  assert.equal('_etag' in members[0].membership, false)
  assert.deepEqual(fake.queries[0].spec.parameters, [{ name: '@tenantId', value: TENANT_ID }])
  assert.ok(!fake.queries[0].spec.query.includes(TENANT_ID))
  assert.deepEqual(fake.queries[1].options, { partitionKey: WORKSPACE })
  fake.forceQuery([metadata()])
  await assert.rejects(store.listMetadataForTenant(TENANT_ID), /ETag/)
  fake.forceQuery([membershipFor(WORKSPACE, { oid: OWNER, role: 'owner' })])
  await assert.rejects(store.listWorkspaceMemberships(WORKSPACE), /scope or concurrency/)
  fake.forceQuery([{ ...membershipFor(OTHER_WORKSPACE, { oid: OWNER, role: 'owner' }), _etag: '"other"' }])
  await assert.rejects(store.listWorkspaceMemberships(WORKSPACE), /scope or concurrency/)
})

test('deletion cleanup and final tombstone condition the current recovery owner rather than immutable creator provenance', async () => {
  const { fake, store } = directoryFixture()
  const recoveryPrincipalId = principalKeyFor(TENANT_ID, PEER)
  const recoveryMemberId = membershipIdFor(recoveryPrincipalId)
  fake.seed({ ...metadata(), deletionRecoveryPrincipalId: recoveryPrincipalId }, '"recovery-metadata"')
  fake.seed(membershipFor(WORKSPACE, { oid: OWNER, role: 'viewer' }), '"demoted-creator"')
  fake.seed(membershipFor(WORKSPACE, { oid: PEER, role: 'owner' }), '"recovery-owner"')
  fake.seed(membershipFor(OTHER_WORKSPACE, { oid: OWNER, role: 'owner' }), '"unrelated-owner"')
  await store.deleteMemberships(WORKSPACE)
  assert.equal(fake.get(WORKSPACE, membershipIdFor(principalKeyFor(TENANT_ID, OWNER))), undefined)
  assert.ok(fake.get(WORKSPACE, recoveryMemberId))
  assert.ok(fake.get(OTHER_WORKSPACE, membershipIdFor(principalKeyFor(TENANT_ID, OWNER))))
  assert.ok(fake.queries.every(query => query.options.partitionKey === WORKSPACE &&
    query.spec.parameters.some(parameter => parameter.name === '@ownerId' && parameter.value === recoveryMemberId)))
  const tombstone = {
    ...metadata(), deletionRecoveryPrincipalId: recoveryPrincipalId, deletedAt: NOW,
    lifecycleOperation: { id: 'delete', action: 'delete', status: 'complete', updatedAt: NOW },
  }
  const before = fake.snapshot()
  fake.forceBatch({ code: 412, result: [{ statusCode: 424 }, { statusCode: 412 }] })
  await assert.rejects(store.replaceMetadata(tombstone, '"recovery-metadata"'), StoreConflictError)
  assert.deepEqual(fake.snapshot(), before)
  fake.forceBatch(undefined)
  const final = await store.replaceMetadata(tombstone, '"recovery-metadata"')
  assert.notEqual(final.etag, '"recovery-metadata"')
  assert.equal(fake.get(WORKSPACE, recoveryMemberId), undefined)
  const operations = fake.batches.at(-1).operations
  assert.deepEqual(operations.map(item => item.operationType), ['Replace', 'Delete'])
  assert.deepEqual(operations[1], { operationType: 'Delete', id: recoveryMemberId, ifMatch: '"recovery-owner"' })
  assert.equal(fake.get(WORKSPACE, 'workspace').ownerId, principalKeyFor(TENANT_ID, OWNER))
  assert.ok(fake.get(OTHER_WORKSPACE, membershipIdFor(principalKeyFor(TENANT_ID, OWNER))))
})
