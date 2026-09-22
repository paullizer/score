import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import { api, qcFixture, feedback, submittedPlan, clone } from './qc.test-support.mjs'

function cosmosContainer(values = []) {
  const records = new Map(values.map(value => [`${value.record.workspaceId}/${value.record.id}`, { ...clone(value.record), _etag: value.etag }]))
  const batches = [], queries = []
  let revision = 0
  const container = {
    records, batches, queries, pages: [], beforeBatch: undefined,
    item(id, workspaceId) {
      return { async read() { return { resource: clone(records.get(`${workspaceId}/${id}`)) } } }
    },
    items: {
      query(statement, options) {
        queries.push({ statement, options })
        return { async fetchNext() { return container.pages.shift() ?? { resources: [], hasMoreResults: false } } }
      },
      async batch(operations, workspaceId) {
        batches.push(clone(operations))
        if (container.beforeBatch) { const hook = container.beforeBatch; container.beforeBatch = undefined; await hook() }
        const statuses = operations.map(operation => {
          const id = operation.id ?? operation.resourceBody.id, current = records.get(`${workspaceId}/${id}`)
          if (operation.operationType === 'Create') return current ? 409 : 201
          return !current ? 404 : current._etag !== operation.ifMatch ? 412 : 200
        })
        if (statuses.some(status => status >= 400)) return {
          code: 207, result: statuses.map(statusCode => ({ statusCode: statusCode >= 400 ? statusCode : 424 })),
        }
        for (const operation of operations) {
          const id = operation.id ?? operation.resourceBody.id
          if (operation.operationType === 'Delete') records.delete(`${workspaceId}/${id}`)
          else records.set(`${workspaceId}/${id}`, { ...clone(operation.resourceBody), _etag: `"azure-${++revision}"` })
        }
        return { code: 200, result: statuses.map(statusCode => ({ statusCode })) }
      },
    },
  }
  return container
}
function blobContainer() {
  const values = new Map(), uploads = []
  let version = 0
  const conflict = () => { throw Object.assign(new Error('Precondition changed'), { statusCode: 412 }) }
  const container = {
    values, uploads, beforeFinalUpload: undefined,
    getBlockBlobClient(name) {
      return {
        async upload(body, bytes, options) {
          const previous = values.get(name)
          if (options.conditions.ifNoneMatch === '*' && previous) conflict()
          if (options.conditions.ifMatch && previous?.etag !== options.conditions.ifMatch) conflict()
          if (previous?.leaseId && options.conditions.leaseId !== previous.leaseId) conflict()
          if (bytes && container.beforeFinalUpload) {
            const hook = container.beforeFinalUpload; container.beforeFinalUpload = undefined; await hook()
          }
          uploads.push({ name, bytes, conditions: clone(options.conditions) })
          values.set(name, {
            bytes: Buffer.from(body), etag: `"blob-${++version}"`, metadata: clone(options.metadata),
            contentType: options.blobHTTPHeaders.blobContentType, leaseId: previous?.leaseId,
          })
        },
        async getProperties() {
          const value = values.get(name)
          if (!value) throw Object.assign(new Error('Not found'), { statusCode: 404 })
          return { etag: value.etag, metadata: clone(value.metadata), contentLength: value.bytes.length, contentType: value.contentType }
        },
        async download() {
          const value = values.get(name)
          if (!value) throw Object.assign(new Error('Not found'), { statusCode: 404 })
          return { contentLength: value.bytes.length, contentType: value.contentType, metadata: clone(value.metadata),
            readableStreamBody: Readable.from([value.bytes]) }
        },
        getBlobLeaseClient(leaseId) {
          return {
            leaseId,
            async acquireLease(seconds) {
              assert.equal(seconds, 60)
              const value = values.get(name)
              if (value.leaseId) conflict()
              value.leaseId = leaseId
            },
            async releaseLease() {
              const value = values.get(name)
              if (value?.leaseId !== leaseId) conflict()
              delete value.leaseId
            },
          }
        },
        async delete(options) {
          const current = values.get(name)
          if (!current) return
          if (current.leaseId || current.etag !== options.conditions.ifMatch) conflict()
          values.delete(name)
        },
      }
    },
    listBlobsFlat({ prefix }) {
      return { byPage({ continuationToken = '0', maxPageSize }) {
        const offset = Number(continuationToken)
        const all = [...values].filter(([name]) => name.startsWith(prefix))
        const items = all.slice(offset, offset + maxPageSize).map(([name, value]) => ({ name, properties: { etag: value.etag } }))
        return (async function* () {
          yield { segment: { blobItems: items }, continuationToken: offset + maxPageSize < all.length ? `${offset + maxPageSize}` : undefined }
        })()
      } }
    },
  }
  return container
}

test('Cosmos QC pages use exact partition and parameterized scope, bound tokens, and strict record decoding', async () => {
  const f = await qcFixture()
  const review = await f.base.saveReview(f.caller('reviewer'), feedback(f.contexts[0]), randomUUID())
  const container = cosmosContainer([...f.qc.store.values.values()])
  const store = api.createQcStoreFromContainer(container)
  const options = { recordType: 'qc-review', ...f.contexts[0].scope, authorId: f.caller('reviewer').actor.principalId, limit: 1 }
  container.pages.push({ resources: [], hasMoreResults: true }, {
    resources: [{ ...clone(review.record), _etag: review.etag }], continuationToken: 'private-cosmos-cursor',
  })
  const result = await store.list(f.workspaceId, options)
  assert.equal(result.items.length, 1)
  assert.equal(container.queries[0].options.partitionKey, f.workspaceId)
  assert.match(container.queries[0].statement.query, /c\.workspaceId = @workspaceId/)
  assert.match(container.queries[0].statement.query, /c\.scope\.resultRevision = @resultRevision/)
  assert.ok(!container.queries[0].statement.query.includes(options.authorId))
  assert.equal(api.qcPageCursor(f.workspaceId, { ...options, continuationToken: result.continuationToken }), 'private-cosmos-cursor')
  await assert.rejects(store.list(f.workspaceId, { ...options, limit: 2, continuationToken: result.continuationToken }))
  for (const changed of [
    { ...review.record, author: f.caller('second').actor }, { ...review.record, scope: { ...review.record.scope, resultSha256: 'a'.repeat(64) } },
    { ...review.record, unexpected: 'unknown field' },
  ]) {
    container.pages.push({ resources: [{ ...changed, _etag: review.etag }] })
    await assert.rejects(store.list(f.workspaceId, options))
  }
  container.records.set(`${f.workspaceId}/${review.record.id}`, { ...review.record, _etag: '*' })
  await assert.rejects(store.get(f.workspaceId, review.record.id))
})

test('every QC Cosmos mutation atomically fences the exact workspace and all run control ETags', async () => {
  const f = await qcFixture()
  const review = await f.base.saveReview(f.caller('reviewer'), feedback(f.contexts[0]), randomUUID())
  const container = cosmosContainer([...f.qc.store.values.values()]), store = api.createQcStoreFromContainer(container)
  const changed = { ...review.record, feedback: [] }
  await store.transact(f.workspaceId, [{ kind: 'replace', record: changed, etag: review.etag }])
  const batch = container.batches.at(-1)
  assert.deepEqual(new Set(batch.map(item => item.id)), new Set([
    review.record.id, api.qcControlId(), api.qcControlId(review.record.scope.runId),
  ]))
  assert.ok(batch.every(item => item.operationType === 'Replace' && /^".+"$/.test(item.ifMatch)))
  const current = await store.get(f.workspaceId, review.record.id)
  const controlKey = `${f.workspaceId}/${api.qcControlId(review.record.scope.runId)}`
  container.beforeBatch = async () => {
    const value = container.records.get(controlKey)
    container.records.set(controlKey, { ...value, state: 'archived', _etag: '"concurrent-archive"' })
  }
  await assert.rejects(store.transact(f.workspaceId, [{ kind: 'replace', record: review.record, etag: current.etag }]),
    error => error instanceof api.StoreConflictError)
  assert.deepEqual((await store.get(f.workspaceId, review.record.id)).record.feedback, [])
  await assert.rejects(store.transact(f.workspaceId, [{ kind: 'replace', record: review.record, etag: current.etag }]),
    error => error instanceof api.StoreConflictError)
})

test('accepted lifecycle generations survive ordinary ETag changes but cannot cross an archive and restore cycle', async () => {
  const f = await qcFixture(), created = await submittedPlan(f)
  const accepted = await f.plans.request(f.caller('reviewer'), created.plan.id, 'plan', randomUUID(), created.etag)
  const container = cosmosContainer([...f.qc.store.values.values()]), store = api.createQcStoreFromContainer(container)
  let work = await store.get(f.workspaceId, accepted.work.id)
  await store.transact(f.workspaceId, [{ kind: 'replace', record: work.record, etag: work.etag }])
  work = await store.get(f.workspaceId, accepted.work.id)
  const key = `${f.workspaceId}/${api.qcControlId(created.plan.cases[0].scope.runId)}`
  const current = container.records.get(key)
  container.records.set(key, { ...current, generation: current.generation + 2, _etag: '"restored-control"' })
  await assert.rejects(store.transact(f.workspaceId, [{ kind: 'replace', record: work.record, etag: work.etag }]),
    error => error instanceof api.StoreConflictError)
  assert.deepEqual(await store.get(f.workspaceId, accepted.work.id), work)
})

test('private artifacts are content-addressed, immutable, digest checked, and conditionally deleted', async () => {
  const f = await qcFixture(), container = blobContainer()
  const blobs = api.createQcBlobStoreFromContainer(container, f.qc.store)
  const ownerId = api.qcId('plan', 'immutable-store-contract')
  const body = Buffer.from(JSON.stringify({ privateFrozenMaterial: 'Exact original evidence without clipping.' }))
  const fence = { runIds: [f.contexts[0].scope.runId], assertActive: () => f.base.assertWritable(f.caller('reviewer'), [f.contexts[0].scope.runId]) }
  const reference = await blobs.put(f.workspaceId, ownerId, body, fence)
  assert.equal(reference.sha256, api.qcBytesHash(body))
  assert.deepEqual(Buffer.from(await blobs.read(reference)), body)
  assert.deepEqual(await blobs.put(f.workspaceId, ownerId, body, fence), reference)
  assert.equal(container.uploads.filter(item => item.bytes).length, 1)
  const saved = container.values.get(reference.name)
  await assert.rejects(blobs.delete(f.workspaceId, reference.name, '"stale-etag"'))
  saved.bytes[0] ^= 1
  await assert.rejects(blobs.read(reference), /digest/)
  saved.bytes = Buffer.from(body)
  saved.metadata = { scorepreparing: 'true' }
  await assert.rejects(blobs.read(reference), /metadata/)
  saved.metadata = {}
  await blobs.delete(f.workspaceId, reference.name, saved.etag)
  assert.equal(container.values.size, 0)
  assert.equal([...f.qc.store.values.values()].filter(value => value.record.recordType === 'qc-writer').length, 0)
})

test('deletion waits for a finite artifact writer, fences its late result, and recovers without retained private data', async () => {
  const f = await qcFixture(), container = blobContainer()
  const blobs = api.createQcBlobStoreFromContainer(container, f.qc.store), qc = { ...f.qc, blobs }
  const runId = f.contexts[0].scope.runId
  let blocked = false
  container.beforeFinalUpload = async () => {
    await api.setQcRunState(qc, f.workspaceId, runId, 'deleting', f.now)
    await assert.rejects(api.purgeQcRun(qc, f.workspaceId, runId, f.now), error => error.status === 503)
    blocked = true
  }
  await assert.rejects(blobs.put(f.workspaceId, api.qcId('plan', 'interrupted-write'), Buffer.from('{"frozen":"private"}'), {
    runIds: [runId], assertActive: () => f.base.assertWritable(f.caller('reviewer'), [runId]),
  }))
  assert.equal(blocked, true)
  assert.ok(container.values.size > 0)
  assert.deepEqual(await f.qc.store.pendingLifecycle(10), [f.workspaceId])
  await api.createQcLifecycleParticipant(qc).resume(f.workspaceId, f.now)
  assert.equal(container.values.size, 0)
  assert.equal([...f.qc.store.values.values()].filter(value => value.record.recordType !== 'qc-control').length, 0)
  assert.deepEqual(await f.qc.store.pendingLifecycle(10), [])
})
