import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { runWorker, sourceBlobNames } from '../dist-worker/runtime.mjs'

const workspaceId = '22222222-2222-4222-8222-222222222222'
const jobId = 'job-11111111-1111-4111-8111-111111111111'
const documentId = 'document-11111111-1111-4111-8111-111111111111'
const now = '2026-09-17T12:00:00.000Z'
const document = {
  id: documentId,
  title: 'Platform Engineer',
  kind: 'job',
  version: 1,
  sample: false,
  paragraphs: [{ id: 'p-0001', page: 1, heading: 'Requirements', text: 'TypeScript experience is required.' }],
}
const modelResult = {
  isJobPosting: true,
  rejectionReason: null,
  title: 'Platform Engineer',
  organization: null,
  location: null,
  arrangement: null,
  employmentType: null,
  grade: null,
  series: null,
  description: 'Evaluation criteria for the imported role.',
  warnings: [],
  criteria: [{
    label: 'TypeScript',
    description: 'Professional TypeScript experience.',
    weight: 100,
    guidance: '0: none; 1: minimal; 2: limited; 3: capable; 4: strong; 5: expert.',
    requirementType: 'required',
    sourceParagraphId: 'p-0001',
    quote: 'TypeScript experience is required.',
  }],
}

function record(overrides = {}) {
  return {
    id: jobId,
    workspaceId,
    recordType: 'job',
    job: {
      id: jobId,
      title: '',
      organization: '',
      location: '',
      arrangement: '',
      employmentType: '',
      grade: '',
      series: '',
      source: 'url',
      sourceLabel: 'Job URL',
      documentId,
      rubricId: null,
      status: 'queued',
      createdAt: now,
      dataKind: 'real',
    },
    source: {
      kind: 'url',
      displayName: 'Job URL',
      url: 'https://jobs.example/1',
      finalUrl: 'https://jobs.example/1',
      originalBlobName: `${workspaceId}/${jobId}/original.html`,
      originalContentType: 'text/html',
      sha256: 'abc',
      bytes: 100,
      capturedAt: now,
      extractionMethod: 'html',
    },
    inputFingerprint: 'fingerprint',
    createdBy: 'user',
    updatedAt: now,
    attempts: 0,
    nextAttemptAt: now,
    extractedBlobName: `${workspaceId}/${jobId}/source-document.json`,
    warnings: [],
    ...overrides,
  }
}

function fakeStore(initial, hooks = {}) {
  let current = structuredClone(initial)
  let version = 1
  let published
  let workspaceState = 'active'
  const writers = new Map()
  const locked = value => value?.archivedAt || value?.deletingAt || value?.deletedAt
  function assertWritable() {
    if (workspaceState !== 'active' || !current || locked(current.lifecycle) ||
      locked(current.rubricLifecycle) || current.job.rubricDeletedAt) {
      const error = new Error('Lifecycle conflict')
      error.name = 'StoreConflictError'
      throw error
    }
  }
  return {
    async get() { return current ? { record: structuredClone(current), etag: `"${version}"` } : undefined },
    async listPending() { return current ? [{ record: structuredClone(current), etag: `"${version}"` }] : [] },
    async replace(value, etag) {
      if (hooks.replace) await hooks.replace(value, etag, { get current() { return current }, set current(value) { current = value } })
      assertWritable()
      if (etag !== `"${version}"`) {
        const error = new Error('conflict')
        error.name = 'StoreConflictError'
        throw error
      }
      current = structuredClone(value)
      version += 1
      return { record: structuredClone(current), etag: `"${version}"` }
    },
    async publish(value, etag, rubric) {
      if (hooks.publish) await hooks.publish()
      assertWritable()
      if (etag !== `"${version}"`) throw new Error('publish conflict')
      current = structuredClone(value)
      published = structuredClone(rubric)
      version += 1
      return { record: structuredClone(current), etag: `"${version}"` }
    },
    async create() { throw new Error('not used') },
    async list() { return { jobs: [] } },
    async getRubric() { return published },
    async listRubrics() { return published ? [published] : [] },
    async getWorkspaceLifecycle() { return { state: workspaceState, updatedAt: now } },
    async beginBlobWrite(workspaceId, jobId, blobName, owner) {
      assertWritable()
      assert.equal(owner, current.lease.owner)
      const writer = { id: `writer-${writers.size}`, workspaceId, jobId, blobName, owner, expiresAt: new Date(Date.now() + 120_000).toISOString() }
      writers.set(writer.id, writer)
      return writer
    },
    async assertBlobWrite(writer) {
      assertWritable()
      assert.equal(current.lease?.owner, writer.owner)
      assert.ok(writers.has(writer.id))
    },
    async finishBlobWrite(writer) { writers.delete(writer.id) },
    setWorkspaceState(value) { workspaceState = value },
    setLifecycle(scope, metadata) {
      current[scope === 'job' ? 'lifecycle' : 'rubricLifecycle'] = metadata
      if (locked(metadata)) {
        current.lease = undefined
        current.nextAttemptAt = undefined
        current.job.status = 'cancelled'
      }
      version += 1
    },
    deleteRubric() {
      current.rubricLifecycle = { deletedAt: now }
      current.job = { ...current.job, status: 'ready', rubricId: null, rubricDeletedAt: now }
      current.lease = undefined
      current.nextAttemptAt = undefined
      published = undefined
      version += 1
    },
    state: () => structuredClone(current),
    published: () => structuredClone(published),
  }
}

function fakeBlobs(sourceDocument = document) {
  const values = new Map([
    [`${workspaceId}/${jobId}/source-document.json`, {
      bytes: Buffer.from(JSON.stringify(sourceDocument)),
      contentType: 'application/json',
      sha256: 'doc-hash',
      etag: '"doc"',
    }],
  ])
  let writes = 0
  return {
    async read(name) { return values.get(name) },
    async putImmutable(name, bytes, contentType, fence) {
      if (fence) await fence.assertActive()
      writes += 1
      const blob = { bytes, contentType, sha256: 'new', etag: '"new"' }
      if (!values.has(name)) values.set(name, blob)
      return { created: true, blob }
    },
    async putFenced(name, bytes, contentType, fence) {
      await fence.assertActive()
      return this.putImmutable(name, bytes, contentType, fence)
    },
    writes: () => writes,
  }
}

function dependencies(store, blobs, fetchImpl) {
  return {
    store,
    blobs,
    owner: 'worker-test',
    clock: {
      now: () => new Date(now),
      sleep: async () => {},
    },
    documentIntelligence: {
      endpoint: 'https://di.example',
      getToken: async () => 'token',
      fetch: async () => { throw new Error('cached extraction must skip OCR') },
    },
    model: {
      endpoint: 'https://model.example',
      deployment: 'rubric',
      modelName: 'gpt-5-mini',
      getToken: async () => 'token',
      fetch: fetchImpl,
      clock: { now: () => new Date(now), sleep: async () => {} },
    },
    validateRealRubric: () => [],
  }
}

function successfulModel(result = modelResult) {
  return new Response(JSON.stringify({
    model: 'gpt-5-mini-version',
    choices: [{ message: { content: JSON.stringify(result) } }],
  }), { status: 200 })
}

test('Markdown job originals are extracted without OCR or public fetches and retained across retries', async () => {
  const bytes = Buffer.from('# Platform Engineer\n\nTypeScript experience is required.')
  const originalName = `${workspaceId}/${jobId}/original.md`
  const values = new Map([[originalName, {
    bytes, contentType: 'text/markdown', sha256: createHash('sha256').update(bytes).digest('hex'), etag: '"original"',
  }]])
  const initial = record({ extractedBlobName: undefined })
  initial.job = { ...initial.job, source: 'markdown', sourceLabel: 'role.MARKDOWN', title: 'role.MARKDOWN' }
  initial.source = {
    kind: 'markdown', displayName: 'role.MARKDOWN', originalBlobName: originalName,
    originalContentType: 'text/markdown', sha256: values.get(originalName).sha256, bytes: bytes.length,
  }
  const store = fakeStore(initial)
  const writes = []
  const blobs = {
    async read(name) { return values.get(name) },
    async putImmutable(name, body, contentType, fence) {
      if (fence) await fence.assertActive()
      writes.push(name)
      if (values.has(name)) return { created: false, blob: values.get(name) }
      const blob = { bytes: body, contentType, sha256: createHash('sha256').update(body).digest('hex'), etag: '"new"' }
      values.set(name, blob)
      return { created: true, blob }
    },
    async putFenced(name, body, contentType, fence) {
      await fence.assertActive()
      return this.putImmutable(name, body, contentType, fence)
    },
  }
  let modelCalls = 0
  const deps = dependencies(store, blobs, async () => {
    modelCalls++
    return modelCalls <= 4 ? new Response('', { status: 503 }) : successfulModel()
  })
  deps.safeFetchOptions = { resolver: async () => { throw new Error('Markdown must not resolve public hosts') } }
  deps.browser = { render: async () => { throw new Error('Markdown must not render HTML') } }
  assert.equal(sourceBlobNames(initial).original, originalName)
  await runWorker(deps, { maxJobs: 1 })
  assert.equal(store.state().job.status, 'queued')
  const saved = await store.get()
  await store.replace({ ...saved.record, nextAttemptAt: now }, saved.etag)
  deps.model.fetch = async () => successfulModel({
    ...modelResult, criteria: modelResult.criteria.map(criterion => ({ ...criterion, sourceParagraphId: 'p-0002' })),
  })
  await runWorker(deps, { maxJobs: 1 })
  assert.equal(store.state().job.status, 'ready', JSON.stringify(store.state().error))
  assert.equal(store.state().source.extractionMethod, 'markdown')
  assert.equal(store.state().source.originalContentType, 'text/markdown')
  assert.deepEqual(writes, [`${workspaceId}/${jobId}/source-document.json`])
  assert.deepEqual(values.get(originalName).bytes, bytes)
  assert.equal(store.published().criteria[0].sourceCitations[0].quote, 'TypeScript experience is required.')
})

test('worker claims, reuses cached extraction, and atomically publishes a ready job', async () => {
  const store = fakeStore(record())
  const blobs = fakeBlobs()
  const result = await runWorker(dependencies(store, blobs, async () => successfulModel()), { maxJobs: 1 })
  assert.deepEqual(result, { claimed: 1, completed: 1 })
  assert.equal(blobs.writes(), 0)
  assert.equal(store.state().attempts, 1)
  assert.equal(store.state().job.status, 'ready')
  assert.equal(store.state().lease, undefined)
  assert.equal(store.state().job.rubricId, `rubric-${jobId}`)
  assert.equal(store.published().criteria[0].sourceCitations[0].quote, 'TypeScript experience is required.')
})

for (const [kind, contentType] of [
  ['pdf', 'application/pdf'], ['markdown', 'text/markdown'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['doc', 'application/msword'],
  ['url', 'application/pdf'], ['url', 'text/html'],
]) {
  test(`job ${kind} publication validates PDF page limits using captured ${contentType} metadata`, async () => {
    const initial = record()
    initial.source = { ...initial.source, kind, originalContentType: contentType }
    initial.job.source = kind
    const store = fakeStore(initial)
    const deps = dependencies(store, fakeBlobs(), async () => successfulModel())
    const validatedTypes = []
    deps.validateRealRubric = (_rubric, _document, type) => { validatedTypes.push(type); return [] }
    await runWorker(deps, { maxJobs: 1 })
    assert.equal(store.state().job.status, 'ready')
    assert.deepEqual(validatedTypes, [contentType])
  })
}

test('cancellation that removes the lease wins before model generation and publication', async () => {
  let replacements = 0
  const store = fakeStore(record(), {
    replace: async (_value, _etag, state) => {
      replacements += 1
      if (replacements === 2) {
        state.current = {
          ...state.current,
          lease: undefined,
          job: { ...state.current.job, status: 'cancelled' },
        }
        const error = new Error('The job changed since it was last loaded.')
        error.name = 'StoreConflictError'
        throw error
      }
    },
  })
  let modelCalls = 0
  await runWorker(dependencies(store, fakeBlobs(), async () => {
    modelCalls += 1
    return successfulModel()
  }), { maxJobs: 1 })
  assert.equal(modelCalls, 0)
  assert.equal(store.state().job.status, 'cancelled')
  assert.equal(store.published(), undefined)
})

test('claim races are skipped while unexpected store failures surface', async () => {
  const race = fakeStore(record(), {
    replace: async () => {
      const error = new Error('The job changed since it was last loaded.')
      error.name = 'StoreConflictError'
      throw error
    },
  })
  assert.deepEqual(await runWorker(dependencies(race, fakeBlobs(), async () => successfulModel())), { claimed: 0, completed: 0 })

  const unavailable = fakeStore(record(), {
    replace: async () => { throw new Error('Cosmos unavailable') },
  })
  await assert.rejects(runWorker(dependencies(unavailable, fakeBlobs(), async () => successfulModel())), /Cosmos unavailable/)
})

test('transient model failures defer work with backoff and stop automatically after attempt three', async () => {
  const retrying = fakeStore(record())
  await runWorker(dependencies(retrying, fakeBlobs(), async () => new Response('', { status: 503 })), { maxJobs: 1 })
  assert.equal(retrying.state().job.status, 'queued')
  assert.equal(retrying.state().error.retryable, true)
  assert.equal(retrying.state().nextAttemptAt, '2026-09-17T12:00:15.000Z')
  assert.equal(retrying.state().lease, undefined)

  const exhausted = fakeStore(record({ attempts: 2 }))
  await runWorker(dependencies(exhausted, fakeBlobs(), async () => new Response('', { status: 503 })), { maxJobs: 1 })
  assert.equal(exhausted.state().job.status, 'error')
  assert.match(exhausted.state().job.error, /retry limit reached/)
  assert.equal(exhausted.state().attempts, 3)
})

test('expired crashed claims remain recoverable and a crashed third claim becomes terminal', async () => {
  const recoverable = fakeStore(record({
    attempts: 1,
    job: { ...record().job, status: 'generating' },
    lease: { owner: 'dead-worker', expiresAt: '2026-09-17T11:59:00.000Z' },
    nextAttemptAt: '2026-09-17T11:59:00.000Z',
  }))
  await runWorker(dependencies(recoverable, fakeBlobs(), async () => successfulModel()), { maxJobs: 1 })
  assert.equal(recoverable.state().job.status, 'ready')
  assert.equal(recoverable.state().attempts, 2)

  const exhausted = fakeStore(record({
    attempts: 3,
    job: { ...record().job, status: 'parsing' },
    lease: { owner: 'dead-worker', expiresAt: '2026-09-17T11:59:00.000Z' },
    nextAttemptAt: '2026-09-17T11:59:00.000Z',
  }))
  assert.deepEqual(await runWorker(dependencies(exhausted, fakeBlobs(), async () => successfulModel()), { maxJobs: 1 }), {
    claimed: 0,
    completed: 0,
  })
  assert.equal(exhausted.state().job.status, 'error')
  assert.equal(exhausted.state().error.code, 'attempt-limit-reached')
  assert.equal(exhausted.state().lease, undefined)
})

test('immutable extraction conflicts use the durable document for generation and publication', async () => {
  const durableDocument = {
    ...document,
    title: 'Durable Role',
    paragraphs: [{ id: 'p-0001', page: 1, heading: 'Requirements', text: 'Durable source experience is required.' }],
  }
  const originalName = `${workspaceId}/${jobId}/original.html`
  const extractedName = `${workspaceId}/${jobId}/source-document.json`
  const originalBytes = Buffer.from(`<main><h1>Competing Role</h1><h2>Requirements</h2><p>${'Competing source requirement. '.repeat(30)}</p></main>`)
  const originalHash = createHash('sha256').update(originalBytes).digest('hex')
  const blobs = {
    async read(name) {
      if (name === extractedName) return undefined
      if (name === originalName) {
        return { bytes: originalBytes, contentType: 'text/html', sha256: originalHash, etag: '"original"' }
      }
      return undefined
    },
    async putImmutable(name) {
      assert.equal(name, extractedName)
      return {
        created: false,
        blob: {
          bytes: Buffer.from(JSON.stringify(durableDocument)),
          contentType: 'application/json',
          sha256: 'durable',
          etag: '"durable"',
        },
      }
    },
    async putFenced(name, _bytes, _contentType, fence) {
      await fence.assertActive()
      return this.putImmutable(name)
    },
  }
  const store = fakeStore(record({
    extractedBlobName: undefined,
    source: { ...record().source, sha256: originalHash, bytes: originalBytes.byteLength },
  }))
  const durableResult = {
    ...modelResult,
    title: 'Durable Role',
    criteria: [{
      ...modelResult.criteria[0],
      label: 'Durable source experience',
      description: 'Experience stated by the durable source.',
      quote: 'Durable source experience is required.',
    }],
  }
  await runWorker(dependencies(store, blobs, async (_url, init) => {
    const request = JSON.parse(init.body)
    assert.match(request.messages[1].content, /Durable source experience is required/)
    assert.doesNotMatch(request.messages[1].content, /Competing source requirement/)
    return new Response(JSON.stringify({
      model: 'gpt-5-mini-version',
      choices: [{ message: { content: JSON.stringify(durableResult) } }],
    }), { status: 200 })
  }), { maxJobs: 1 })
  assert.equal(store.state().job.status, 'ready')
  assert.equal(store.published().criteria[0].sourceCitations[0].quote, 'Durable source experience is required.')
})

test('run deadline aborts generation and durably defers the claimed job', async () => {
  const store = fakeStore(record())
  await runWorker(dependencies(store, fakeBlobs(), async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })), { maxJobs: 1, budgetMilliseconds: 10 })
  assert.equal(store.state().job.status, 'queued')
  assert.equal(store.state().error.code, 'run-budget-exhausted')
  assert.equal(store.state().lease, undefined)
})

test('direct URL PDFs over the storage limit fail permanently before immutable writes', async () => {
  const store = fakeStore(record({
    extractedBlobName: undefined,
    source: { kind: 'url', displayName: 'Large PDF', url: 'https://jobs.example/large.pdf' },
  }))
  let writes = 0
  const blobs = {
    async read() { return undefined },
    async putImmutable() {
      writes += 1
      throw new Error('must not write oversized source')
    },
  }
  const deps = dependencies(store, blobs, async () => successfulModel())
  deps.safeFetchOptions = {
    resolver: async () => ['93.184.216.34'],
    transport: async () => ({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array(10 * 1024 * 1024 + 1),
    }),
  }
  await runWorker(deps, { maxJobs: 1 })
  assert.equal(writes, 0)
  assert.equal(store.state().job.status, 'error')
  assert.equal(store.state().error.code, 'pdf-too-large')
  assert.equal(store.state().error.retryable, false)
})

test('run bounds the number of claimed jobs and uses coordinated blob names', async () => {
  const names = sourceBlobNames(record(), 'text/html')
  assert.deepEqual(names, {
    original: `${workspaceId}/${jobId}/original.html`,
    extracted: `${workspaceId}/${jobId}/source-document.json`,
  })
  const store = fakeStore(record())
  assert.deepEqual(await runWorker(dependencies(store, fakeBlobs(), async () => successfulModel()), { maxJobs: 0 }), {
    claimed: 0,
    completed: 0,
  })
})

for (const kind of ['url', 'pdf', 'markdown', 'docx', 'doc']) {
  for (const scope of ['job', 'rubric', 'workspace']) {
    test(`${kind} worker skips ${scope} archives before claiming or calling a model`, async () => {
      const initial = record(scope === 'workspace' ? {} : {
        [scope === 'job' ? 'lifecycle' : 'rubricLifecycle']: { archivedAt: now },
      })
      initial.job.source = kind
      initial.source.kind = kind
      const store = fakeStore(initial)
      if (scope === 'workspace') store.setWorkspaceState('archived')
      let calls = 0
      const result = await runWorker(dependencies(store, fakeBlobs(), async () => {
        calls += 1
        return successfulModel()
      }))
      assert.deepEqual(result, { claimed: 0, completed: 0 })
      assert.equal(calls, 0)
      assert.equal(store.published(), undefined)
    })
  }
}

test('archiving during generation cancels a late result and restoring never restarts it', async () => {
  const store = fakeStore(record())
  const blobs = fakeBlobs()
  await runWorker(dependencies(store, blobs, async () => {
    store.setLifecycle('rubric', { archivedAt: now })
    return successfulModel()
  }))
  assert.equal(store.published(), undefined)
  assert.equal(store.state().job.status, 'cancelled')
  assert.equal(store.state().lease, undefined)
  assert.ok(await blobs.read(`${workspaceId}/${jobId}/source-document.json`))
  store.setLifecycle('rubric', {})
  assert.deepEqual(await runWorker(dependencies(store, blobs, async () => {
    assert.fail('unarchive must not regenerate')
  })), { claimed: 0, completed: 0 })
})

test('workspace fencing at the final publication boundary wins over the worker pre-check', async () => {
  let store
  store = fakeStore(record(), { publish: async () => store.setWorkspaceState('archived') })
  await runWorker(dependencies(store, fakeBlobs(), async () => successfulModel()))
  assert.equal(store.published(), undefined)
  assert.equal(store.state().lifecycle, undefined, 'parent archive does not stamp child metadata')
  assert.notEqual(store.state().job.status, 'ready')
})

test('deliberate rubric deletion during generation cannot publish or retry an old rubric', async () => {
  const store = fakeStore(record())
  const blobs = fakeBlobs()
  await runWorker(dependencies(store, blobs, async () => {
    store.deleteRubric()
    return successfulModel()
  }))
  assert.equal(store.published(), undefined)
  assert.equal(store.state().job.rubricId, null)
  assert.equal(store.state().job.rubricDeletedAt, now)
  assert.equal(store.state().job.status, 'ready')
  assert.ok(await blobs.read(`${workspaceId}/${jobId}/source-document.json`))
  assert.deepEqual(await runWorker(dependencies(store, blobs, async () => assert.fail('deleted rubric restarted'))), {
    claimed: 0, completed: 0,
  })
})

test('worker explicitly rejects a store without lifecycle fencing', async () => {
  const store = fakeStore(record())
  delete store.getWorkspaceLifecycle
  await assert.rejects(runWorker(dependencies(store, fakeBlobs(), async () => successfulModel())), /fencing is unavailable/)
})

for (const [kind, contentType] of [
  ['pdf', 'application/pdf'], ['markdown', 'text/markdown'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['doc', 'application/msword'],
]) {
  test(`cached ${kind} extraction honors format-specific pagination before model generation`, async () => {
    const initial = record()
    initial.job.source = kind
    initial.source = { ...initial.source, kind, originalContentType: contentType }
    const store = fakeStore(initial)
    const cached = { ...document, paragraphs: document.paragraphs.map(paragraph => ({ ...paragraph, page: 75 })) }
    let calls = 0
    await runWorker(dependencies(store, fakeBlobs(cached), async () => {
      calls += 1
      return successfulModel()
    }))
    if (kind === 'pdf') {
      assert.equal(calls, 0)
      assert.equal(store.state().error.code, 'invalid-extraction-cache')
      assert.equal(store.published(), undefined)
    } else {
      assert.equal(calls, 1)
      assert.equal(store.state().job.status, 'ready')
      assert.equal(store.state().job.source, kind)
      assert.equal(store.state().source.kind, kind)
      assert.equal(store.published().criteria[0].sourceCitations[0].page, 75)
    }
  })
}
