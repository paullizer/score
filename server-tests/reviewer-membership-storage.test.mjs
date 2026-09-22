import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createDirectoryStoreFromContainer, membershipIdFor, StoreConflictError } from '../dist-server/app.mjs'

const tenant = '00000000-0000-4000-8000-000000000001'
const owner = `${tenant}:00000000-0000-4000-8000-000000000002`
const reviewer = `${tenant}:00000000-0000-4000-8000-000000000003`
const workspaceId = 'workspace-one'
const timestamp = '2026-09-22T14:00:00.000Z'
const clone = value => structuredClone(value)

function fixture() {
  const records = new Map()
  const key = (partition, id) => `${partition}:${id}`
  const metadata = { id: 'workspace', workspaceId, ownerId: owner, tenantId: tenant, kind: 'personal',
    name: 'Private workspace', createdAt: timestamp, updatedAt: timestamp }
  const membership = { id: membershipIdFor(reviewer), workspaceId, principalId: reviewer, principalType: 'user', role: 'reviewer', label: 'Display only' }
  const ownerMembership = { id: membershipIdFor(owner), workspaceId, principalId: owner, principalType: 'user', role: 'owner' }
  records.set(key(workspaceId, 'workspace'), { ...metadata, _etag: '"metadata-1"' })
  records.set(key(workspaceId, ownerMembership.id), { ...ownerMembership, _etag: '"owner-1"' })
  records.set(key('other-workspace', membership.id), { ...membership, workspaceId: 'other-workspace', _etag: '"foreign"' })
  const calls = [], queries = []
  let sequence = 1, failure
  const store = createDirectoryStoreFromContainer({
    item(id, partition) { return { async read() {
      const resource = records.get(key(partition, id))
      return resource ? { resource: clone(resource) } : { statusCode: 404 }
    } } },
    items: {
      query(spec, options) {
        queries.push({ spec, options })
        return { async fetchAll() {
          return { resources: [...records.values()].filter(item => item.workspaceId === options.partitionKey &&
            item.principalType === 'user' && (spec.parameters.some(parameter => parameter.name === '@role') ? item.role === 'reviewer' : item.id !== membershipIdFor(owner))).map(clone) }
        } }
      },
      async batch(operations, partition) {
        calls.push({ operations: clone(operations), partition })
        if (failure) return clone(failure)
        const staged = new Map(records)
        const results = []
        for (const [index, operation] of operations.entries()) {
          const id = operation.id ?? operation.resourceBody.id
          const address = key(partition, id)
          const old = staged.get(address)
          const failed = operation.operationType === 'Create' ? (old ? 409 : undefined) :
            !old ? 404 : old._etag !== operation.ifMatch ? 412 : undefined
          if (failed) return { code: failed, result: operations.map((_, position) => ({ statusCode: position === index ? failed : 424 })) }
          if (operation.operationType === 'Delete') {
            staged.delete(address)
            results.push({ statusCode: 204 })
          } else {
            const eTag = `"transaction-${++sequence}"`
            staged.set(address, { ...clone(operation.resourceBody), _etag: eTag })
            results.push({ statusCode: operation.operationType === 'Create' ? 201 : 200, eTag })
          }
        }
        records.clear()
        for (const [address, record] of staged) records.set(address, record)
        return { code: 200, result: results }
      },
    },
    async read() {},
  })
  function change(action = 'reviewer-added') {
    return {
      metadata: clone(metadata), expectedMetadataEtag: '"metadata-1"', membership: clone(membership),
      audit: { id: `membership-audit-${randomUUID()}`, type: 'membership-audit', workspaceId,
        actorId: owner, targetPrincipalId: reviewer, membershipId: membership.id, role: 'reviewer',
        label: membership.label, action, createdAt: timestamp },
    }
  }
  return { store, records, calls, queries, key, metadata, membership, ownerMembership, change, fail(value) { failure = value } }
}

test('Cosmos reviewer membership, immutable audit, and workspace ETag advance in one conditional partition transaction', async () => {
  const f = fixture()
  const ownerBefore = await f.store.getStoredMembership(workspaceId, f.ownerMembership.id)
  assert.equal(await f.store.getStoredMembership(workspaceId, f.membership.id), undefined)
  const addition = f.change()
  const created = await f.store.changeReviewerMembership(addition)
  const addBatch = f.calls[0]
  assert.equal(addBatch.partition, workspaceId)
  assert.deepEqual(addBatch.operations.map(item => item.operationType), ['Replace', 'Create', 'Create'])
  assert.equal(addBatch.operations[0].ifMatch, '"metadata-1"')
  assert.equal(addBatch.operations[1].resourceBody.id, f.membership.id)
  assert.deepEqual(addBatch.operations[2].resourceBody, addition.audit)
  assert.notEqual(created.etag, '"metadata-1"')
  const members = await f.store.listReviewerMemberships(workspaceId)
  assert.equal(members.length, 1, 'No foreign-workspace membership is returned')
  assert.deepEqual(members[0].membership, f.membership)
  assert.ok(members[0].etag)
  assert.equal(f.queries[0].options.partitionKey, workspaceId)
  assert.ok(f.queries[0].spec.parameters.some(item => item.name === '@role' && item.value === 'reviewer'))
  assert.deepEqual(await f.store.getStoredMembership(workspaceId, f.ownerMembership.id), ownerBefore)
  const removal = { ...f.change('reviewer-removed'), expectedMetadataEtag: created.etag, expectedMembershipEtag: members[0].etag }
  const removed = await f.store.changeReviewerMembership(removal)
  assert.notEqual(removed.etag, created.etag)
  assert.deepEqual(f.calls[1].operations.map(item => item.operationType), ['Replace', 'Delete', 'Create'])
  assert.equal(f.calls[1].operations[1].ifMatch, members[0].etag)
  assert.equal(await f.store.getStoredMembership(workspaceId, f.membership.id), undefined)
  assert.ok(f.records.has(f.key(workspaceId, addition.audit.id)))
  assert.ok(f.records.has(f.key(workspaceId, removal.audit.id)))
  assert.ok(f.records.has(f.key('other-workspace', f.membership.id)))
  assert.deepEqual(await f.store.getStoredMembership(workspaceId, f.ownerMembership.id), ownerBefore)
})

test('stale metadata, changed memberships, and duplicate audits roll back all membership transaction writes', async () => {
  const f = fixture()
  const addition = f.change()
  const created = await f.store.changeReviewerMembership(addition)
  const reviewerRecord = await f.store.getStoredMembership(workspaceId, f.membership.id)
  const before = clone([...f.records])
  for (const change of [
    f.change(),
    { ...f.change(), expectedMetadataEtag: created.etag },
    { ...f.change('reviewer-removed'), expectedMetadataEtag: created.etag, expectedMembershipEtag: '"old-member"' },
    { ...f.change('reviewer-removed'), expectedMetadataEtag: created.etag, expectedMembershipEtag: reviewerRecord.etag,
      audit: { ...addition.audit, action: 'reviewer-removed' } },
  ]) {
    await assert.rejects(f.store.changeReviewerMembership(change), StoreConflictError)
    assert.deepEqual([...f.records], before, 'No partial access, audit, or lifecycle metadata change is published')
  }
})

test('Cosmos reviewer transactions authorize equal current co-owners, not the immutable creator', async () => {
  const f = fixture()
  const coOwner = `${tenant}:00000000-0000-4000-8000-000000000004`
  const coOwnerId = membershipIdFor(coOwner)
  f.records.set(f.key(workspaceId, coOwnerId), {
    id: coOwnerId, workspaceId, principalId: coOwner, principalType: 'user', role: 'owner', _etag: '"co-owner"',
  })
  const addition = f.change()
  addition.audit.actorId = coOwner
  await f.store.changeReviewerMembership(addition)
  assert.ok(await f.store.getStoredMembership(workspaceId, f.membership.id))
  assert.equal(f.calls[0].operations[2].resourceBody.actorId, coOwner)

  const demoted = fixture()
  demoted.records.set(demoted.key(workspaceId, demoted.ownerMembership.id), {
    ...demoted.ownerMembership, role: 'reviewer', _etag: '"demoted-creator"',
  })
  await assert.rejects(demoted.store.changeReviewerMembership(demoted.change()), StoreConflictError)
  assert.equal(demoted.calls.length, 0, 'Creator provenance cannot authorize a transaction after ownership loss')
})

test('membership store refuses wildcard removals, owner mutations, cross-tenant subjects, and unfinished lifecycle fences', async () => {
  const f = fixture()
  for (const mutate of [
    value => { value.expectedMetadataEtag = '*' },
    value => { value.audit.action = 'reviewer-removed' },
    value => { value.audit.action = 'reviewer-removed'; value.expectedMembershipEtag = '*' },
    value => { value.membership = { ...f.ownerMembership, role: 'reviewer' } },
    value => { value.membership.role = 'owner' },
    value => { value.membership.workspaceId = 'other-workspace' },
    value => { value.membership.principalId = `foreign:${reviewer.split(':')[1]}` },
    value => { value.audit.actorId = reviewer },
    value => { value.audit.targetPrincipalId = owner },
    value => { value.metadata.deletedAt = timestamp },
    value => { value.metadata.lifecycleOperation = { id: randomUUID(), action: 'delete', status: 'failed', updatedAt: timestamp } },
  ]) {
    const change = f.change(); mutate(change)
    await assert.rejects(f.store.changeReviewerMembership(change), StoreConflictError)
  }
  assert.equal(f.calls.length, 0)
})

test('a failed or incomplete Cosmos acknowledgement never looks like a saved membership change', async () => {
  const f = fixture()
  for (const failure of [
    { code: 503, result: [{ statusCode: 200, eTag: '"uncommitted"' }, { statusCode: 201 }, { statusCode: 201 }] },
    { code: 200, result: [{ statusCode: 200, eTag: '"partial"' }] },
    { code: 200, result: [{ statusCode: 200 }, { statusCode: 201 }, { statusCode: 201 }] },
    { code: 409, result: [{ statusCode: 424 }, { statusCode: 424 }, { statusCode: 409 }] },
  ]) {
    f.fail(failure)
    await assert.rejects(f.store.changeReviewerMembership(f.change()))
    assert.equal(await f.store.getStoredMembership(workspaceId, f.membership.id), undefined)
  }
})

test('lifecycle membership cleanup preserves immutable membership audit and final owner recovery access', async () => {
  const f = fixture()
  const addition = f.change()
  await f.store.changeReviewerMembership(addition)
  await f.store.deleteMemberships(workspaceId)
  assert.equal(await f.store.getStoredMembership(workspaceId, f.membership.id), undefined)
  assert.ok(await f.store.getStoredMembership(workspaceId, f.ownerMembership.id))
  assert.ok(f.records.has(f.key(workspaceId, addition.audit.id)))
  assert.ok(f.records.has(f.key('other-workspace', f.membership.id)))
})
