import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { api, fixture, createRun, publishResult, NOW, LATER, ACTOR, clone } from './real-analyses.test-support.mjs'

function cosmos() {
  const values = new Map()
  const batches = []
  const queries = []
  const replacements = []
  let counter = 0
  let code
  let race
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  const save = record => {
    if (record.recordType === 'analysis-lifecycle') api.parseAnalysisControl(record)
    else api.parseAnalysisEntity(record)
    const resource = { ...clone(record), _etag: `"cosmos-${++counter}"`, _rid: 'rid', _self: 'self', _ts: 1000, _attachments: 'attachments' }
    values.set(key(record.workspaceId, record.id), resource)
    return clone(resource)
  }
  return {
    values, batches, queries, replacements, save,
    _fail(value) { code = value },
    _race(callback) { race = callback },
    item(id, workspaceId) {
      return {
        async read() {
          const resource = values.get(key(workspaceId, id))
          return { statusCode: resource ? 200 : 404, resource: clone(resource) }
        },
        async replace(record, options) {
          replacements.push(clone(options))
          assert.equal(options.accessCondition.type, 'IfMatch')
          const current = values.get(key(workspaceId, id))
          if (!current || current._etag !== options.accessCondition.condition) throw Object.assign(new Error('Stale'), { code: 412 })
          return { resource: save(record) }
        },
      }
    },
    items: {
      async create(record) {
        if (values.has(key(record.workspaceId, record.id))) throw Object.assign(new Error('Duplicate'), { code: 409 })
        return { resource: save(record) }
      },
      query(spec, options) {
        queries.push({ spec, options })
        const parameter = name => spec.parameters.find(item => item.name === name)?.value
        const records = () => [...values.values()].filter(record =>
          (!options?.partitionKey || record.workspaceId === options.partitionKey) &&
          (!parameter('@recordType') || record.recordType === parameter('@recordType')) &&
          (!parameter('@runId') || record.runId === parameter('@runId')) &&
          (!parameter('@status') || record.status === parameter('@status')) &&
          (!parameter('@now') || api.analysisWorkIsPending(record, parameter('@now')))).map(clone)
        return {
          async fetchNext() {
            const all = records()
            const start = Number(options?.continuationToken ?? 0)
            const limit = parameter('@limit') ?? options?.maxItemCount ?? 100
            assert.ok(Number.isInteger(start) && start >= 0)
            const resources = all.slice(start, start + limit)
            return { resources, ...(start + resources.length < all.length ? { continuationToken: `${start + resources.length}` } : {}) }
          },
          async fetchAll() { return { resources: records().slice(0, parameter('@limit') ?? Infinity) } },
        }
      },
      async batch(operations, workspaceId) {
        batches.push(clone(operations))
        if (race) { const callback = race; race = undefined; callback() }
        const bad = code ?? operations.map(operation => {
          assert.ok(!('ifMatchEtag' in operation))
          assert.ok(!('accessCondition' in operation))
          const previous = values.get(key(workspaceId, operation.id ?? operation.resourceBody.id))
          if (operation.operationType === 'Create') return previous ? 409 : 201
          assert.equal(typeof operation.ifMatch, 'string')
          return !previous ? 404 : previous._etag !== operation.ifMatch ? 412 : 200
        }).find(value => value >= 400)
        code = undefined
        if (bad) return { code: bad, result: operations.map((_item, index) => ({ statusCode: index ? 424 : bad })) }
        return { code: 200, result: operations.map(operation => {
          if (operation.operationType === 'Delete') {
            values.delete(key(workspaceId, operation.id))
            return { statusCode: 204 }
          }
          return { statusCode: operation.operationType === 'Create' ? 201 : 200, eTag: save(operation.resourceBody)._etag }
        }) }
      },
    },
  }
}
async function initializedPair() {
  const f = fixture()
  const created = await createRun(f)
  const comparison = [...f.analysis.store.values.values()].find(item => item.record.recordType === 'analysis-comparison').record
  const initial = {
    ...created.run, status: 'initializing', initialization: { nextComparisonIndex: 0 }, nextAttemptAt: NOW,
    progress: { ...created.run.progress, initialized: 0, queued: 0 },
  }
  delete initial.completedAt
  return { f, run: created.run, comparison, initial }
}

test('Cosmos initialization is a single bounded transaction with the SDK ifMatch run fence, not sequential writes', async () => {
  const { f, initial, run, comparison } = await initializedPair()
  const container = cosmos()
  const store = api.createAnalysisStoreFromContainer(container)
  const created = await store.create(initial)
  await store.transact(f.workspaceId, [
    { kind: 'create', record: comparison },
    { kind: 'replace', record: run, etag: created.value.etag },
  ])
  assert.equal(container.batches.length, 2)
  assert.equal(container.replacements.length, 0)
  assert.equal(container.batches[1][3].ifMatch, created.value.etag)
  assert.deepEqual(container.batches[1].slice(0, 2).map(item => item.resourceBody.recordType), ['analysis-lifecycle', 'analysis-lifecycle'])
  assert.equal((await store.get(f.workspaceId, run.id)).record.progress.queued, 1)
  assert.equal((await store.create(initial)).created, false)
  await assert.rejects(store.create(comparison), /publication fence/)
  const pair = await store.get(f.workspaceId, comparison.id)
  await assert.rejects(store.replace(pair.record, pair.etag), /atomic run/)
  const list = await store.list(f.workspaceId, { recordType: 'analysis-comparison', runId: run.id, limit: 1 })
  assert.equal(list.items.length, 1)
  assert.equal(container.queries.at(-1).options.partitionKey, f.workspaceId)
  assert.ok(container.queries.at(-1).spec.query.includes('ORDER BY c.index ASC'))
})

test('stale run ETags and every batch failure leave comparisons unpublished', async () => {
  for (const code of [404, 409, 412, 424, 500]) {
    const { f, initial, run, comparison } = await initializedPair()
    const container = cosmos()
    const store = api.createAnalysisStoreFromContainer(container)
    const created = await store.create(initial)
    container._fail(code)
    await assert.rejects(store.transact(f.workspaceId, [
      { kind: 'create', record: comparison }, { kind: 'replace', record: run, etag: created.value.etag },
    ]), code === 500 ? /did not succeed/ : api.StoreConflictError)
    assert.equal(await store.get(f.workspaceId, comparison.id), undefined)
    assert.equal((await store.get(f.workspaceId, run.id)).record.progress.initialized, 0)
  }
  const { f, initial, run, comparison } = await initializedPair()
  const container = cosmos()
  const store = api.createAnalysisStoreFromContainer(container)
  const created = await store.create(initial)
  container._race(() => container.save({ ...initial, updatedAt: LATER }))
  await assert.rejects(store.transact(f.workspaceId, [
    { kind: 'create', record: comparison }, { kind: 'replace', record: run, etag: created.value.etag },
  ]), api.StoreConflictError)
  assert.equal(await store.get(f.workspaceId, comparison.id), undefined)
  assert.equal((await store.get(f.workspaceId, run.id)).record.updatedAt, LATER)
})

test('analysis display metadata uses the normal Cosmos fences and permits no mixed evidence or processing changes', async () => {
  const { f, initial, run, comparison } = await initializedPair()
  const container = cosmos()
  const store = api.createAnalysisStoreFromContainer(container)
  const original = (await store.create(initial)).value
  const service = new api.RealAnalysisService({ store, blobs: f.analysis.blobs }, {}, () => new Date(LATER))
  const renamed = await service.updateMetadata(f.workspaceId, initial.id, { displayName: 'Saved alias' }, original.etag)
  assert.deepEqual(renamed.run, { ...initial, displayName: 'Saved alias', updatedAt: LATER })
  assert.deepEqual(container.batches.at(-1).map(item => item.resourceBody.recordType),
    ['analysis-lifecycle', 'analysis-lifecycle', 'analysis-run'])
  assert.equal(container.batches.at(-1).at(-1).ifMatch, original.etag)
  await assert.rejects(service.updateMetadata(f.workspaceId, initial.id, { displayName: 'Stale alias' }, original.etag),
    error => error.status === 409)
  await assert.rejects(store.replace({ ...renamed.run, displayName: 'Mixed edit', attempts: 1 }, renamed.etag), /Display-name edits/)
  await assert.rejects(store.replace({ ...renamed.run, name: 'Replace original' }, renamed.etag), /immutable/)
  await store.transact(f.workspaceId, [
    { kind: 'create', record: comparison },
    { kind: 'replace', record: { ...run, displayName: 'Saved alias', updatedAt: LATER }, etag: renamed.etag },
  ])
  assert.equal((await store.get(f.workspaceId, initial.id)).record.displayName, 'Saved alias')
  assert.equal((await store.get(f.workspaceId, initial.id)).record.progress.queued, 1)
})

test('100-pair initialization, full cancellation and full retry use the real adapter transaction invariants', async () => {
  const f = fixture()
  const created = await createRun(f, 10, 10)
  const container = cosmos()
  const store = api.createAnalysisStoreFromContainer(container)
  const initial = {
    ...created.run, status: 'initializing', initialization: { nextComparisonIndex: 0 }, nextAttemptAt: NOW,
    progress: { ...created.run.progress, initialized: 0, queued: 0 },
  }
  container.save(initial)
  const deps = { store, blobs: f.analysis.blobs }
  const initialized = await api.advanceAnalysisRun(deps, f.workspaceId, initial.id, { now: () => new Date(NOW), maxChunks: 4 })
  assert.equal(initialized.record.progress.queued, 100)
  assert.deepEqual(container.batches.map(batch => batch.length), [28, 28, 28, 28])
  const service = new api.RealAnalysisService(deps, f, () => new Date(NOW))
  await service.cancel(f.workspaceId, initial.id, 'owner', initialized.etag)
  const cancelled = await api.advanceAnalysisRun(deps, f.workspaceId, initial.id, { now: () => new Date(NOW), maxChunks: 4 })
  assert.equal(cancelled.record.progress.cancelled, 100)
  assert.equal((await store.listPending(NOW, 100)).length, 0)
  const retried = await service.retry(f.workspaceId, initial.id, {}, cancelled.etag)
  assert.equal(retried.run.progress.queued, 100)
  assert.equal(retried.run.progress.cancelled, 0)
  assert.equal(container.batches.length, 13)
  assert.ok(container.batches.every(batch => batch.length <= 28))
})

test('analysis adapter rejects unfenced/cross-partition operations, fake progress, immutable input edits and oversized batches', async () => {
  const { f, initial, run, comparison } = await initializedPair()
  const container = cosmos()
  const store = api.createAnalysisStoreFromContainer(container)
  const created = await store.create(initial)
  const runOperation = { kind: 'replace', record: run, etag: created.value.etag }
  await assert.rejects(store.transact(f.workspaceId, [{ kind: 'create', record: comparison }]), /run ETag fence/)
  await assert.rejects(store.transact('another-workspace', [{ kind: 'create', record: comparison }, runOperation]), /workspace partitions/)
  await assert.rejects(store.transact(f.workspaceId, [{ kind: 'create', record: comparison }, { ...runOperation, record: initial }]), /progress/)
  await assert.rejects(store.replace(run, created.value.etag), /atomically/)
  await assert.rejects(store.replace({ ...initial, name: 'Changed accepted name' }, created.value.etag), /immutable/)
  await assert.rejects(store.transact(f.workspaceId, Array.from({ length: 101 }, () => runOperation)), /at most 25/)
  await assert.rejects(store.transact(f.workspaceId, [runOperation, runOperation]), /unique/)
  await assert.rejects(store.list(f.workspaceId, { recordType: 'analysis-run', limit: 101 }), /query/)
  await assert.rejects(store.list(f.workspaceId, { recordType: 'analysis-run', continuationToken: 'x'.repeat(13 * 1024) }), /query/)
  await assert.rejects(store.listPending(NOW, 101), /query/)
  assert.equal(container.batches.length, 1)
  await store.replace({ ...initial, updatedAt: LATER }, created.value.etag)
  assert.equal(container.replacements.length, 0, 'Every run write shares the workspace and run control transaction.')
  assert.equal(container.batches.at(-1).at(-1).ifMatch, created.value.etag)
})

test('pending work contains expired initialization/cancellation and eligible queued/running pairs, never terminals', async () => {
  const { f, initial, comparison } = await initializedPair()
  const container = cosmos()
  const store = api.createAnalysisStoreFromContainer(container)
  container.save(comparison)
  container.save(initial)
  assert.equal((await store.listPending(NOW, 100)).length, 1, 'Uninitialized children cannot consume the ready-work limit.')
  assert.equal((await store.listPending(NOW, 1))[0].record.id, initial.id)
  const live = { ...initial, lease: { owner: 'worker', heartbeatAt: NOW, expiresAt: LATER } }
  container.save(live)
  assert.equal((await store.listPending(NOW, 100)).length, 0)
  assert.equal((await store.listPending(LATER, 100)).length, 1)
  const ready = { ...initial, status: 'queued', initialization: { nextComparisonIndex: 1, completedAt: NOW },
    progress: { ...initial.progress, initialized: 1, queued: 1 } }
  delete ready.nextAttemptAt
  container.save(ready)
  assert.deepEqual((await store.listPending(NOW, 100)).map(item => item.record.id), [comparison.id])
  const cancelled = { ...initial, status: 'cancelled', cancellation: { requestedAt: NOW, requestedBy: 'owner', nextComparisonIndex: 0 } }
  container.save(cancelled)
  const terminalPair = { ...comparison, status: 'cancelled', cancelledAt: NOW }
  delete terminalPair.nextAttemptAt
  container.save(terminalPair)
  const pending = await store.listPending(NOW, 100)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].record.id, initial.id)
  const finished = { ...cancelled, initialization: { nextComparisonIndex: 1, completedAt: NOW },
    progress: { ...initial.progress, initialized: 1, cancelled: 1 },
    cancellation: { ...cancelled.cancellation, nextComparisonIndex: 1, completedAt: NOW }, completedAt: NOW }
  delete finished.nextAttemptAt
  container.save(finished)
  assert.equal((await store.listPending(NOW, 100)).length, 0)
  assert.ok(container.queries.some(value => value.spec.query.includes('NOT IS_DEFINED(c.cancellation.completedAt)')))
  assert.equal(f.workspaceId, initial.workspaceId)
})

test('blob adapter enforces safe namespaces, bounds, exact media metadata and immutable winner semantics', async () => {
  const { f, run } = await initializedPair()
  const values = new Map()
  const uploads = []
  let badLength
  let badType
  const container = {
    getBlockBlobClient(name) {
      return {
        async upload(bytes, length, options) {
          uploads.push({ name, length, options: clone(options) })
          assert.equal(options.conditions.ifNoneMatch, '*')
          if (values.has(name)) throw Object.assign(new Error('Already exists'), { statusCode: 412 })
          values.set(name, { bytes: Buffer.from(bytes), contentType: options.blobHTTPHeaders.blobContentType, etag: '"blob"' })
          return { etag: '"blob"' }
        },
        async download() {
          const value = values.get(name)
          if (!value) throw Object.assign(new Error('Missing'), { statusCode: 404 })
          return { readableStreamBody: Readable.from([value.bytes]), contentType: badType ?? value.contentType,
            contentLength: badLength ?? value.bytes.byteLength, etag: value.etag }
        },
      }
    },
  }
  const store = api.createAnalysisBlobStoreFromContainer(container)
  const name = `${f.workspaceId}/${run.id}/manifest.json`
  const first = await store.putImmutable(name, Buffer.from('{"original":true}'), 'application/json')
  assert.equal(first.created, true)
  const repeated = await store.putImmutable(name, Buffer.from('{"replacement":true}'), 'application/json')
  assert.equal(repeated.created, false)
  assert.deepEqual(repeated.blob.bytes, first.blob.bytes)
  assert.equal(repeated.blob.sha256, first.blob.sha256)
  assert.equal(uploads.length, 2)
  for (const invalid of ['../private', `${f.workspaceId}/${run.id}/arbitrary.json`, 'https://blob.example/manifest.json',
    `${f.workspaceId}/${run.id}/../manifest.json`, `${f.workspaceId}\\${run.id}\\manifest.json`]) {
    await assert.rejects(store.read(invalid), /blob name/)
  }
  await assert.rejects(store.putImmutable(name, Buffer.from('html'), 'text/html'), /Invalid immutable/)
  badType = 'text/html'
  await assert.rejects(store.read(name), /content metadata/)
  badType = undefined
  badLength = api.MAX_ANALYSIS_JSON_BYTES + 1
  await assert.rejects(store.read(name), /bounded size/)
  badLength = 999
  await assert.rejects(store.read(name), /truncated/)
})

test('analysis Markdown originals round-trip as immutable .md blobs with exact media and 10 MiB bounds', async () => {
  const prefix = 'workspace-one/analysis-run-00000000-0000-4000-8000-000000000000/evidence'
  const values = new Map()
  const store = api.createAnalysisBlobStoreFromContainer({
    getBlockBlobClient(name) {
      return {
        async upload(bytes, length, options) {
          assert.equal(options.conditions.ifNoneMatch, '*')
          assert.equal(options.blobHTTPHeaders.blobContentType, 'text/markdown')
          assert.equal(length, bytes.byteLength)
          if (values.has(name)) throw Object.assign(new Error('Already captured'), { statusCode: 412 })
          values.set(name, Buffer.from(bytes))
          return { etag: '"markdown-original"' }
        },
        async download() {
          const bytes = values.get(name)
          return { etag: '"markdown-original"', contentType: 'text/markdown', contentLength: bytes.byteLength,
            readableStreamBody: Readable.from([bytes]) }
        },
      }
    },
  })
  const bytes = Buffer.from('# Captured source\r\n\r\nExact **Markdown** bytes.\r\n')
  const name = `${prefix}/${api.analysisBytesHash(bytes)}.md`
  const first = await store.putImmutable(name, bytes, 'text/markdown')
  const restored = await store.read(name)
  assert.deepEqual(restored, first.blob)
  assert.deepEqual(restored.bytes, bytes)
  assert.equal(restored.contentType, 'text/markdown')
  const repeated = await store.putImmutable(name, Buffer.from('changed'), 'text/markdown')
  assert.equal(repeated.created, false)
  assert.deepEqual(repeated.blob, first.blob)
  const maximum = 10 * 1024 * 1024
  const boundary = Buffer.alloc(maximum, 0x61)
  const boundaryName = `${prefix}/${api.analysisBytesHash(boundary)}.md`
  assert.equal((await store.putImmutable(boundaryName, boundary, 'text/markdown')).created, true)
  assert.equal((await store.read(boundaryName)).bytes.byteLength, maximum)
  await assert.rejects(store.putImmutable(name, Buffer.alloc(maximum + 1), 'text/markdown'), /Invalid immutable/)
  for (const contentType of ['application/json', 'text/html', 'application/pdf', 'text/plain']) {
    await assert.rejects(store.putImmutable(name, bytes, contentType), /Invalid immutable/)
  }
  await assert.rejects(store.putImmutable(name.replace(/\.md$/, '.markdown'), bytes, 'text/markdown'), /Invalid immutable/)
  for (const contentLength of [maximum + 1, undefined]) {
    const bounded = api.createAnalysisBlobStoreFromContainer({
      getBlockBlobClient() {
        return {
          async upload() {},
          async download() {
            return { etag: '"oversized"', contentType: 'text/markdown', contentLength,
              readableStreamBody: Readable.from([boundary, Buffer.from('x')]) }
          },
        }
      },
    })
    await assert.rejects(bounded.read(name), /bounded size/)
  }
  for (const contentType of ['text/html', 'application/json']) {
    const wrongMedia = api.createAnalysisBlobStoreFromContainer({
      getBlockBlobClient() {
        return { async upload() {}, async download() {
          return { etag: '"wrong-media"', contentType, contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) }
        } }
      },
    })
    await assert.rejects(wrongMedia.read(name), /content metadata/)
  }
})

test('exhausted cancellation and its queued children cannot poison pending discovery or starve a later healthy run', async () => {
  const f = fixture()
  const container = cosmos()
  const store = api.createAnalysisStoreFromContainer(container)
  for (let index = 0; index < 2; index++) {
    const blocked = await createRun(f, 10, 10)
    await api.advanceAnalysisRun(f.analysis, f.workspaceId, blocked.run.id, { now: () => new Date(NOW), maxChunks: 4 })
    for (const { record } of f.analysis.store.values.values()) {
      if (record.recordType === 'analysis-comparison' && record.runId === blocked.run.id) container.save(record)
    }
    const run = (await f.analysis.store.get(f.workspaceId, blocked.run.id)).record
    container.save({
      ...run, status: 'cancelled', attempts: 3,
      cancellation: { requestedAt: NOW, requestedBy: 'owner', nextComparisonIndex: 0 },
      error: { code: 'storage-error', stage: 'initialization', message: 'Cancellation is paused for an explicit retry.', retryable: true },
    })
  }
  const healthy = await createRun(f)
  for (const { record } of f.analysis.store.values.values()) {
    if (record.id === healthy.run.id || record.recordType === 'analysis-comparison' && record.runId === healthy.run.id) container.save(record)
  }
  const pending = await store.listPending(NOW, 1)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].record.runId, healthy.run.id)
  const queries = container.queries.filter(item => item.spec.parameters.some(parameter =>
    parameter.name === '@recordType' && parameter.value === 'analysis-run'))
  assert.ok(queries.length)
  assert.ok(queries.every(item => item.spec.query.includes('c.error.retryable = true AND c.attempts < @maxAttempts') &&
    item.spec.parameters.some(parameter => parameter.name === '@maxAttempts' && parameter.value === 3)))
  assert.ok(container.queries.some(item => item.options?.continuationToken), 'Pending scanning must page beyond paused parents.')
})

test('workspace control CAS atomically rejects a worker publication racing archive, even when run/pair ETags are unchanged', async () => {
  const f = fixture()
  const container = cosmos()
  f.analysis.store = api.createAnalysisStoreFromContainer(container)
  const created = await createRun(f)
  const store = f.analysis.store
  const run = await store.get(f.workspaceId, created.run.id)
  const pair = (await store.list(f.workspaceId, { recordType: 'analysis-comparison', runId: created.run.id })).items[0]
  const control = await store.getControl(f.workspaceId)
  const running = { ...pair.record, status: 'running', attempts: 1, attemptId: randomUUID(),
    lease: { owner: 'worker', heartbeatAt: NOW, expiresAt: LATER } }
  delete running.nextAttemptAt
  const parent = api.applyAnalysisComparisonTransition(run.record, pair.record, running, NOW)
  container._race(() => container.save({ ...control.record, state: 'archived', updatedAt: LATER }))
  await assert.rejects(store.transact(f.workspaceId, [
    { kind: 'replace', record: running, etag: pair.etag }, { kind: 'replace', record: parent, etag: run.etag },
  ]), api.StoreConflictError)
  assert.deepEqual(await store.get(f.workspaceId, pair.record.id), pair)
  assert.deepEqual(await store.get(f.workspaceId, created.run.id), run)
  assert.equal((await store.listPending(NOW, 100)).length, 0)
  assert.equal(container.batches.at(-1)[0].ifMatch, control.etag)
})

test('Cosmos archive/delete uses exact child/run/control ETags and a permanent minimal tombstone', async () => {
  const f = fixture()
  const container = cosmos()
  f.analysis.store = api.createAnalysisStoreFromContainer(container)
  const created = await createRun(f, 1, 2)
  const store = f.analysis.store
  const pair = (await store.list(f.workspaceId, { recordType: 'analysis-comparison', runId: created.run.id })).items[0]
  await publishResult(f, created.run.id, pair.record.id)
  const complete = await store.get(f.workspaceId, pair.record.id)
  const service = new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(NOW))
  let run = await store.get(f.workspaceId, created.run.id)
  const archived = await service.change(f.workspaceId, created.run.id, 'archive', run.etag, ACTOR)
  assert.ok(archived.analysis.run.lifecycle.archivedAt)
  assert.equal(archived.analysis.run.progress.cancelled, 1)
  assert.deepEqual(await store.get(f.workspaceId, pair.record.id), complete)
  run = await store.get(f.workspaceId, created.run.id)
  await assert.rejects(store.replace({ ...run.record, lifecycle: undefined }, run.etag), api.StoreConflictError)
  const before = new Map([...container.values].map(([key, value]) => [key, value._etag]))
  assert.deepEqual(await service.change(f.workspaceId, created.run.id, 'delete', run.etag, ACTOR), { deleted: true })
  assert.equal(await store.get(f.workspaceId, created.run.id), undefined)
  assert.equal(await store.get(f.workspaceId, pair.record.id), undefined)
  assert.equal((await store.getControl(f.workspaceId, created.run.id)).record.state, 'deleted')
  await assert.rejects(store.create(created.run), api.StoreConflictError)
  const deletes = container.batches.flat().filter(item => item.operationType === 'Delete')
  assert.equal(deletes.length, 3)
  assert.ok(deletes.every(item => typeof item.ifMatch === 'string' && item.ifMatch !== '*'))
  assert.equal(deletes.find(item => item.id === pair.record.id).ifMatch, before.get(`${f.workspaceId}/${pair.record.id}`))
  assert.ok(container.batches.every(batch => batch[0].resourceBody.id === api.analysisControlId() &&
    batch.length <= 28 && Buffer.byteLength(JSON.stringify(batch)) <= api.MAX_ANALYSIS_TRANSACTION_BYTES))
  assert.equal(container.replacements.length, 0)
})

test('a first publication cannot create its workspace guard over a concurrent terminal deletion fence', async () => {
  const { f, initial } = await initializedPair()
  const container = cosmos()
  const store = api.createAnalysisStoreFromContainer(container)
  container._race(() => container.save({
    ...api.newAnalysisControl(f.workspaceId, NOW), state: 'deleted',
  }))
  await assert.rejects(store.create(initial), api.StoreConflictError)
  assert.equal(await store.get(f.workspaceId, initial.id), undefined)
  assert.equal((await store.getControl(f.workspaceId)).record.state, 'deleted')
})

function leasedBlobContainer() {
  const values = new Map()
  const events = []
  let sequence = 0
  let beforeContent
  let foreignPage
  return {
    values, events,
    beforeContent(callback) { beforeContent = callback },
    foreignPage(value) { foreignPage = value },
    getBlockBlobClient(name) {
      return {
        async upload(bytes, _length, options) {
          if (bytes.byteLength && beforeContent) await beforeContent(name, options)
          const previous = values.get(name)
          if (options.conditions?.ifNoneMatch === '*') {
            if (previous) throw Object.assign(new Error('Exists'), { statusCode: 412 })
          } else {
            assert.ok(options.conditions?.leaseId, 'Content writes require a Blob-side lease, not just a Cosmos fence.')
            if (!previous || previous.etag !== options.conditions.ifMatch ||
              previous.leaseId !== options.conditions.leaseId || previous.leaseExpires <= Date.now()) {
              throw Object.assign(new Error('Content upload is fenced'), { statusCode: 412 })
            }
          }
          const value = {
            bytes: Buffer.from(bytes), contentType: options.blobHTTPHeaders.blobContentType,
            metadata: clone(options.metadata ?? {}), etag: `"blob-${++sequence}"`,
            ...(previous?.leaseId ? { leaseId: previous.leaseId, leaseExpires: previous.leaseExpires } : {}),
          }
          events.push(['put', name, bytes.byteLength, options.conditions])
          values.set(name, value)
          return { etag: value.etag }
        },
        async download() {
          const value = values.get(name)
          if (!value) throw Object.assign(new Error('Missing'), { statusCode: 404 })
          return { readableStreamBody: Readable.from([value.bytes]), contentLength: value.bytes.byteLength,
            contentType: value.contentType, etag: value.etag, metadata: value.metadata }
        },
        async getProperties() {
          const value = values.get(name)
          if (!value) throw Object.assign(new Error('Missing'), { statusCode: 404 })
          return { etag: value.etag, metadata: value.metadata }
        },
        getBlobLeaseClient(id = randomUUID()) {
          return {
            leaseId: id,
            async acquireLease(seconds) {
              const value = values.get(name)
              if (!value) throw Object.assign(new Error('Missing'), { statusCode: 404 })
              value.leaseId = id
              value.leaseExpires = Date.now() + seconds * 1000
            },
            async releaseLease() {
              const value = values.get(name)
              if (value?.leaseId === id) { delete value.leaseId; delete value.leaseExpires }
            },
            async breakLease(seconds) {
              assert.equal(seconds, 0)
              const value = values.get(name)
              if (!value) throw Object.assign(new Error('Missing'), { statusCode: 404 })
              delete value.leaseId
              delete value.leaseExpires
            },
          }
        },
        async deleteIfExists(options) {
          const value = values.get(name)
          if (!value) return { succeeded: false }
          assert.equal(options.deleteSnapshots, 'include')
          assert.ok(options.conditions.ifMatch && options.conditions.ifMatch !== '*')
          if (options.conditions.ifMatch !== value.etag) throw Object.assign(new Error('ETag changed'), { statusCode: 412 })
          events.push(['delete', name, options.conditions.ifMatch])
          values.delete(name)
          return { succeeded: true }
        },
      }
    },
    listBlobsFlat({ prefix }) {
      return {
        byPage({ continuationToken }) {
          return {
            async next() {
              if (!continuationToken) return { done: false, value: { segment: { blobItems: [] }, continuationToken: 'after-empty' } }
              assert.equal(continuationToken, 'after-empty')
              const blobItems = foreignPage ?? [...values].filter(([name]) => name.startsWith(prefix))
                .map(([name, value]) => ({ name, properties: { etag: value.etag } }))
              return { done: false, value: { segment: { blobItems } } }
            },
          }
        },
      }
    },
  }
}

test('Azure content PUTs cannot recreate deleted evidence even if an already-started upload returns late', async () => {
  const workspaceId = 'workspace-one'
  const runId = `analysis-run-${randomUUID()}`
  const name = `${workspaceId}/${runId}/manifest.json`
  const container = leasedBlobContainer()
  const blobs = api.createAnalysisBlobStoreFromContainer(container)
  let release
  let entered
  const arrived = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  container.beforeContent(async () => { entered(); await blocked })
  const upload = blobs.putFenced(name, Buffer.from('{"privateEvidence":true}'), 'application/json', {
    id: randomUUID(), workspaceId, runId, blobName: name,
    expiresAt: new Date(Date.now() + 120000).toISOString(), assertActive: async () => {},
  })
  const rejected = assert.rejects(upload, /fenced/)
  await arrived
  assert.equal(await blobs.read(name), undefined, 'A preparation placeholder is never readable as evidence.')
  const empty = await blobs.list(workspaceId, runId)
  assert.deepEqual(empty.items, [])
  assert.equal(empty.continuationToken, 'after-empty')
  const page = await blobs.list(workspaceId, runId, empty.continuationToken)
  assert.equal(page.items[0].name, name)
  await blobs.delete(workspaceId, runId, name, page.items[0].etag)
  release()
  await rejected
  assert.equal(await blobs.read(name), undefined)
  assert.equal(container.values.size, 0)
  assert.equal(container.events.some(event => event[0] === 'put' && event[2] > 0), false)
})

test('Azure cleanup enforces private ownership, exact Blob ETags and immutable fenced winners', async () => {
  const workspaceId = 'workspace-one'
  const runId = `analysis-run-${randomUUID()}`
  const name = `${workspaceId}/${runId}/manifest.json`
  const container = leasedBlobContainer()
  const blobs = api.createAnalysisBlobStoreFromContainer(container)
  const fence = { id: randomUUID(), workspaceId, runId, blobName: name,
    expiresAt: new Date(Date.now() + 120000).toISOString(), assertActive: async () => {} }
  const first = await blobs.putFenced(name, Buffer.from('{"captured":true}'), 'application/json', fence)
  const repeated = await blobs.putFenced(name, Buffer.from('{"replacement":true}'), 'application/json', { ...fence, id: randomUUID() })
  assert.equal(first.created, true)
  assert.equal(repeated.created, false)
  assert.deepEqual(repeated.blob.bytes, first.blob.bytes)
  await assert.rejects(blobs.delete(workspaceId, runId, name, '*'), /exact ETag/)
  await assert.rejects(blobs.delete(workspaceId, runId, name, '"stale"'), /ETag changed/)
  await assert.rejects(blobs.delete('other-workspace', runId, name, first.blob.etag), /scope/)
  assert.ok(await blobs.read(name))
  container.foreignPage([{ name: `other-workspace/${runId}/manifest.json`, properties: { etag: '"foreign"' } }])
  await assert.rejects(blobs.list(workspaceId, runId, 'after-empty'), /ownership/)
  await blobs.delete(workspaceId, runId, name, first.blob.etag)
  assert.equal(container.values.size, 0)
})
