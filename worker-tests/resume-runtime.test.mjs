import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { setImmediate as flush, setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { build } from 'esbuild'
import { PDFDocument, PDFName } from 'pdf-lib'

const bundled = await build({
  stdin: {
    contents: `
      export * from './worker/resumes/runtime'
      export * from './server/resumes/validation'
      export { RealResumeService } from './server/resumes/service'
      export * from './server/resumes/guards'
      export * from './server/resumes/lifecycle'
      export { StoreConflictError, StoreNotFoundError } from './server/store'
    `,
    resolveDir: process.cwd(), sourcefile: 'resume-runtime-test-bundle.ts',
  },
  bundle: true, write: false, packages: 'external', format: 'cjs',
  platform: 'node', target: 'node24', logLevel: 'silent',
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports,
)
const {
  runResumeWorker, processClaimedResume, resumeWorkerConstants, RealResumeService,
  parseResumeEntity, parseResumeCaptureManifest, parseRealResumeProfile, resumeContentHash, resumeSha256,
  resumeBlobReference, resumeCaptureBlobName, resumeOriginalBlobName, resumeDocumentBlobName, resumeProfileBlobName,
  validateResumeDocumentBinding, validateRealResumeProfile,
  checkResumeReplacement, prepareResumeTransaction, parseResumeControl, resumeControlId,
  resumeIsLocked, StoreConflictError, ResumeLifecycleService, createResumeLifecycleParticipant,
} = module.exports

const WORKSPACE = 'resume-worker-tests'
const NOW = '2026-09-18T03:00:00.000Z'
const NAME = 'Jordan Vale'
const ROLE = 'Software engineer'
const EXPERIENCE = 'Built accessible case management services.'
const clone = value => structuredClone(value)
const key = (workspaceId, id) => `${workspaceId}/${id}`

class MemoryStore {
  values = new Map()
  controls = new Map()
  serial = 0
  writes = []

  async get(workspaceId, id) { return clone(this.values.get(key(workspaceId, id))) }
  async list(workspaceId, options) {
    const all = [...this.values.values()].filter(({ record }) => record.workspaceId === workspaceId &&
      record.recordType === options.recordType && (!options.status || record.resume.status === options.status) &&
      (!options.batchId || record.batchId === options.batchId))
    const offset = Number(options.continuationToken ?? 0)
    const limit = options.limit ?? 100
    return {
      items: clone(all.slice(offset, offset + limit)),
      ...(offset + limit < all.length ? { continuationToken: String(offset + limit) } : {}),
    }
  }
  save(record) {
    const parsed = parseResumeEntity(JSON.parse(JSON.stringify(record)))
    const value = { record: parsed, etag: `"record-${++this.serial}"` }
    this.values.set(key(record.workspaceId, record.id), clone(value))
    this.writes.push(clone(parsed))
    return clone(value)
  }
  async create(record) {
    const current = await this.get(record.workspaceId, record.id)
    if (current) {
      await prepareResumeTransaction(this, record.workspaceId, [{ kind: 'create', record }])
      return { created: false, value: current }
    }
    await this.transact(record.workspaceId, [{ kind: 'create', record }])
    return { created: true, value: await this.get(record.workspaceId, record.id) }
  }
  async replace(record, etag) {
    const current = this.values.get(key(record.workspaceId, record.id))
    checkResumeReplacement(current, record, etag)
    await this.transact(record.workspaceId, [{ kind: 'replace', record, etag }])
    return this.get(record.workspaceId, record.id)
  }
  async transact(workspaceId, operations, options) {
    const controls = await prepareResumeTransaction(this, workspaceId, operations, options)
    for (const operation of operations) {
      const current = this.values.get(key(workspaceId, operation.record.id))
      if (operation.kind === 'create' ? current : !current || current.etag !== operation.etag) throw new StoreConflictError()
      parseResumeEntity(operation.record)
    }
    for (const control of controls) {
      if (this.controls.get(key(workspaceId, control.record.id))?.etag !== control.etag) throw new StoreConflictError()
      parseResumeControl(control.record)
    }
    for (const operation of operations) {
      if (operation.kind === 'delete') this.values.delete(key(workspaceId, operation.record.id))
      else this.save(operation.record)
    }
    for (const control of controls) this.controls.set(key(workspaceId, control.record.id), {
      record: clone(control.record), etag: `"control-${++this.serial}"`,
    })
  }
  async getControl(workspaceId, resumeId) { return clone(this.controls.get(key(workspaceId, resumeControlId(resumeId)))) }
  async listControls(workspaceId, continuationToken) {
    const all = [...this.controls.values()].filter(value => value.record.workspaceId === workspaceId)
    const offset = Number(continuationToken ?? 0)
    return { items: clone(all.slice(offset, offset + 100)),
      ...(offset + 100 < all.length ? { continuationToken: String(offset + 100) } : {}) }
  }
  async pendingLifecycleWorkspaces(limit) {
    return [...new Set([...this.controls.values()].filter(({ record }) => record.state === 'deleting' ||
      (record.operation && record.operation.status !== 'complete') || Date.parse(record.preparation?.expiresAt) <= Date.now())
      .map(value => value.record.workspaceId))].slice(0, limit)
  }
  async listPending(now, limit) {
    return clone([...this.values.values()].filter(({ record }) =>
      record.recordType === 'resume' && !resumeIsLocked(record.lifecycle) &&
      (!this.controls.get(key(record.workspaceId, resumeControlId())) || this.controls.get(key(record.workspaceId, resumeControlId())).record.state === 'active') &&
      (!record.nextAttemptAt || record.nextAttemptAt <= now) &&
      (record.resume.status === 'queued' && !record.lease ||
        ['parsing', 'profiling'].includes(record.resume.status) && record.lease?.expiresAt <= now),
    ).slice(0, limit))
  }
}

class MemoryBlobs {
  values = new Map()
  writes = []
  serial = 0
  async read(name) { return clone(this.values.get(name)) }
  save(name, bytes, contentType) {
    const blob = { bytes: Uint8Array.from(bytes), contentType, sha256: resumeSha256(bytes), etag: `"blob-${++this.serial}"` }
    this.values.set(name, blob)
    return clone(blob)
  }
  async putImmutable(name, bytes, contentType) {
    this.writes.push(name)
    const existing = this.values.get(name)
    return existing ? { created: false, blob: clone(existing) }
      : { created: true, blob: this.save(name, bytes, contentType) }
  }
  async putFenced(name, bytes, contentType, fence) {
    fence.signal?.throwIfAborted()
    await fence.assertActive()
    const result = await this.putImmutable(name, bytes, contentType)
    await fence.assertActive()
    return result
  }
  async listFamilies(workspaceId) {
    return { resumeIds: [...new Set([...this.values.keys()].filter(name => name.startsWith(`${workspaceId}/`)).map(name => name.split('/')[1]))] }
  }
  async listPage(workspaceId, resumeId, token) {
    const all = [...this.values.keys()].filter(name => name.startsWith(`${workspaceId}/${resumeId}/`)).sort()
    const offset = Number(token ?? 0)
    return { names: all.slice(offset, offset + 100), ...(offset + 100 < all.length ? { continuationToken: String(offset + 100) } : {}) }
  }
  async delete(name) { this.values.delete(name) }
  putJson(name, value) { return this.save(name, Buffer.from(JSON.stringify(value)), 'application/json') }
}

function clock() {
  let time = Date.parse(NOW)
  return {
    now: () => new Date(time),
    sleep: async (milliseconds, signal) => {
      signal?.throwIfAborted()
      time += milliseconds
    },
    advance: milliseconds => { time += milliseconds },
  }
}

function html(role = ROLE, extra = '') {
  return `<html><head><title>Professional profile</title></head><body><main>
    <h1>${NAME}</h1><p>${role}</p><p>Seattle, Washington</p>
    <h2>Experience</h2><p>${EXPERIENCE} Led engineering delivery reviews and documented reliable software releases.</p>
    <p>Created interoperable service interfaces, improved incident investigation practices, and collaborated with designers to test accessible user journeys for public services.</p>
    <h2>Education</h2><p>BSc Computer Science, Example College. Completed projects in distributed systems, testing, and software design.</p>
    <h2>Projects</h2><p>Designed a public transit timetable application, documented validation rules, and wrote automated tests for its data ingestion workflow.</p>
    ${extra}</main></body></html>`
}

function http(body = html(), status = 200, type = 'text/html', headers = {}) {
  return { status, headers: { 'content-type': type, ...headers }, body: typeof body === 'string' ? Buffer.from(body) : body }
}

async function pdf(pages = 2, encrypted = false) {
  const document = await PDFDocument.create()
  for (let page = 1; page <= pages; page++) {
    document.addPage().drawText(page === 1 ? `${NAME}\n${ROLE}\nSeattle, Washington` : `${EXPERIENCE}\nBSc Computer Science`)
  }
  if (encrypted) {
    document.context.trailerInfo.Encrypt = document.context.register(document.context.obj({ Filter: PDFName.of('Standard'), V: 1, R: 2 }))
  }
  return new Uint8Array(await document.save())
}

function ocr(pages = 2, paragraphs) {
  const values = paragraphs ?? [
    [NAME, 1, 'title'], [ROLE, 1], ['Seattle, Washington', 1], ['Experience', Math.min(2, pages), 'sectionHeading'],
    [`${EXPERIENCE} Led delivery reviews across engineering teams.`, Math.min(2, pages)],
    ['BSc Computer Science, Example College.', Math.min(2, pages)],
  ]
  return {
    status: 'succeeded', analyzeResult: {
      pages: Array.from({ length: pages }, (_, index) => ({ pageNumber: index + 1 })),
      paragraphs: values.map(([content, pageNumber, role], index) => ({
        content, role, boundingRegions: [{ pageNumber }], spans: [{ offset: index * 100, length: content.length }],
      })),
    },
  }
}

function modelPayload(body, overrides = {}) {
  const paragraphs = JSON.parse(body.messages[1].content).source.paragraphs
  const unavailable = () => ({ status: 'unavailable', value: null, citations: [] })
  const quote = paragraph => ({ paragraphId: paragraph.paragraphId, quote: paragraph.text.slice(0, 1_500) })
  const field = values => {
    for (const value of values) {
      const paragraph = paragraphs.find(item => item.text.slice(0, 1_500).includes(value))
      if (paragraph) return { status: 'available', value, citations: [quote(paragraph)] }
    }
    return unavailable()
  }
  const professional = paragraphs.find(item => item.text.includes('Built') || item.text.includes('BSc')) ?? paragraphs.at(-1)
  return {
    classification: 'single-profile', professionalEvidence: [quote(professional)], sparse: false,
    name: field([NAME]), role: field(['Platform architect', ROLE]), location: field(['Seattle, Washington']),
    experience: field([EXPERIENCE]), ...overrides,
  }
}

function modelResponse(body, overrides = {}) {
  return Response.json({
    model: 'gpt-5-mini-controlled-build',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelPayload(body, overrides)) } }],
  })
}

function unicodeModelResponse(body, name) {
  const paragraph = JSON.parse(body.messages[1].content).source.paragraphs.find(value => value.text === name)
  assert.ok(paragraph, 'The model must receive the correctly decoded, original name')
  return modelResponse(body, {
    name: { status: 'available', value: name, citations: [{ paragraphId: paragraph.paragraphId, quote: paragraph.text }] },
  })
}

function fixture(options = {}) {
  const store = new MemoryStore()
  const blobs = new MemoryBlobs()
  const time = clock()
  const service = new RealResumeService({ store, blobs }, time.now)
  const requests = { public: [], ocr: [], model: [], tokens: [] }
  const deps = {
    store, blobs, clock: time, owner: 'resume-test-worker',
    safeFetchOptions: {
      resolver: async () => ['93.184.216.34'],
      transport: async request => {
        requests.public.push(request)
        return options.transport ? options.transport(request) : http()
      },
    },
    documentIntelligence: {
      endpoint: 'https://ocr.example', clock: time,
      getToken: async scope => { requests.tokens.push(scope); return 'controlled-ocr-token' },
      fetch: async (url, init) => {
        requests.ocr.push({ url, init })
        if (options.ocrFetch) return options.ocrFetch(url, init)
        return init.method === 'POST'
          ? new Response(null, { status: 202, headers: { 'operation-location': 'https://ocr.example/operation/1' } })
          : Response.json(options.ocrResult ?? ocr(options.pages ?? 2))
      },
    },
    model: {
      endpoint: 'https://model.example', deployment: 'existing-model', modelName: 'gpt-5-mini', clock: time,
      getToken: async scope => { requests.tokens.push(scope); return 'controlled-model-token' },
      fetch: async (url, init) => {
        const body = JSON.parse(init.body)
        requests.model.push({ url, body, init })
        return options.modelFetch ? options.modelFetch(body, init) : modelResponse(body)
      },
    },
    ...(options.browser ? { browser: options.browser } : {}),
  }
  const request = (extra = {}) => ({ idempotencyKey: randomUUID(), batchId: randomUUID(), inputCount: 1, createdBy: 'test-actor', ...extra })
  return {
    store, blobs, service, clock: time, requests, deps,
    async url(url = 'https://profiles.example/jordan', workspace = WORKSPACE, extra) {
      return (await service.importUrl(workspace, request(extra), url)).resume.resume.id
    },
    async upload(bytes, name = 'same-name.pdf', workspace = WORKSPACE, extra) {
      return (await service.importPdf(workspace, request(extra), name, bytes)).resume.resume.id
    },
    async markdown(bytes, name = 'same-name.md', workspace = WORKSPACE, extra) {
      return (await service.importMarkdown(workspace, request(extra), name, bytes)).resume.resume.id
    },
    async record(id, workspace = WORKSPACE) { return (await store.get(workspace, id)).record },
    async detail(id, workspace = WORKSPACE) { return service.detail(workspace, id) },
    async cancel(id) {
      const current = await store.get(WORKSPACE, id)
      return service.cancel(WORKSPACE, id, current.etag)
    },
  }
}

async function assertReady(run, id, workspace = WORKSPACE) {
  const record = await run.record(id, workspace)
  assert.equal(record.resume.status, 'ready', JSON.stringify(record.error))
  assert.ok(record.completedAt)
  assert.equal(record.lease, undefined)
  assert.equal(record.nextAttemptAt, undefined)
  assert.equal(record.error, undefined)
  assert.equal(parseResumeEntity(record).id, id)
  const detail = await run.detail(id, workspace)
  assert.equal(detail.document.sample, false)
  assert.deepEqual(validateResumeDocumentBinding(detail.document, record), [])
  assert.deepEqual(validateRealResumeProfile(detail.profile, detail.document, {
    workspaceId: workspace, resumeId: id, documentSha256: record.extraction.document.sha256,
  }), [])
  assert.equal(parseRealResumeProfile(detail.profile).resumeId, id)
  const manifest = parseResumeCaptureManifest(JSON.parse(Buffer.from((await run.blobs.read(record.captureManifest.blobName)).bytes)))
  assert.equal(manifest.inputFingerprint, record.inputFingerprint)
  assert.deepEqual(manifest.capture, record.capture)
  for (const reference of [record.capture.original, record.captureManifest, record.extraction.document, record.profileBlob]) {
    const blob = await run.blobs.read(reference.blobName)
    assert.equal(reference.sha256, resumeSha256(blob.bytes))
    assert.equal(reference.bytes, blob.bytes.byteLength)
  }
  for (const field of ['name', 'role', 'location', 'experience']) {
    assert.equal(detail.resume[field], detail.profile[field].value)
    for (const citation of detail.profile[field].citations) {
      assert.equal(citation.documentId, detail.document.id)
      assert.equal(citation.documentVersion, detail.document.version)
      const paragraph = detail.document.paragraphs.find(item => item.id === citation.paragraphId)
      assert.equal(citation.page, paragraph.page)
      assert.equal(citation.heading, paragraph.heading)
      assert.ok(paragraph.text.includes(citation.quote))
    }
  }
  return { record, detail }
}

test('resume metadata edits preserve source identity and continue an owned publication after an ETag race without new attempts', async () => {
  let run
  let id
  run = fixture({
    async modelFetch(body) {
      assert.doesNotMatch(JSON.stringify(body), /Initial alias|During profiling|Publication alias/)
      const live = await run.store.get(WORKSPACE, id)
      await run.service.updateMetadata(WORKSPACE, id, { displayName: 'During profiling' }, live.etag)
      return modelResponse(body)
    },
  })
  id = await run.url()
  const imported = await run.store.get(WORKSPACE, id)
  await run.service.updateMetadata(WORKSPACE, id, { displayName: 'Initial alias' }, imported.etag)
  const replace = run.store.replace.bind(run.store)
  let raced = false
  run.store.replace = async (record, etag) => {
    if (!raced && record.resume.status === 'ready') {
      raced = true
      const live = await run.store.get(WORKSPACE, id)
      await run.service.updateMetadata(WORKSPACE, id, { displayName: 'Publication alias' }, live.etag)
    }
    return replace(record, etag)
  }
  assert.deepEqual(await runResumeWorker(run.deps, { maxItems: 1 }), { claimed: 1, completed: 1 })
  const { record, detail } = await assertReady(run, id)
  assert.equal(raced, true)
  assert.equal(record.displayName, 'Publication alias')
  assert.equal(detail.displayName, 'Publication alias')
  assert.equal(record.resume.name, NAME)
  assert.equal(record.resume.sourceLabel, imported.record.resume.sourceLabel)
  assert.deepEqual(record.source, imported.record.source)
  assert.equal(record.attempts, 1)
  assert.equal(record.retryCount, 0)
  assert.equal(run.requests.model.length, 1)
})

test('resume metadata edits after an ambiguously acknowledged ready publication preserve both the saved alias and successful result', async () => {
  const run = fixture()
  const id = await run.url()
  const replace = run.store.replace.bind(run.store)
  let renamed = false
  run.store.replace = async (record, etag) => {
    const saved = await replace(record, etag)
    if (!renamed && record.resume.status === 'ready') {
      renamed = true
      await run.service.updateMetadata(WORKSPACE, id, { displayName: 'Confirmed after publication' }, saved.etag)
      throw new Error('The ready publication response was lost.')
    }
    return saved
  }
  assert.deepEqual(await runResumeWorker(run.deps, { maxItems: 1 }), { claimed: 1, completed: 1 })
  const { record } = await assertReady(run, id)
  assert.equal(record.displayName, 'Confirmed after publication')
  assert.equal(record.resume.name, NAME)
  assert.equal(record.attempts, 1)
  assert.equal(record.error, undefined)
  assert.equal(run.requests.model.length, 1)
})

test('Markdown resume originals produce grounded metadata and section citations without OCR or public requests', async () => {
  const bytes = Buffer.from(`\ufeff# ${NAME}\r\n\r\n${ROLE}\r\n\r\nSeattle, Washington\r\n\r\n## Experience\r\n\r\n${EXPERIENCE}\r\n`)
  const run = fixture({ browser: { render: async () => { throw new Error('Markdown must not render HTML') } } })
  const id = await run.markdown(bytes, 'Filename is not a person.MARKDOWN')
  assert.equal((await run.record(id)).resume.name, null)
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { record, detail } = await assertReady(run, id)
  assert.equal(detail.resume.name, NAME)
  assert.equal(detail.resume.role, ROLE)
  assert.equal(record.capture.original.contentType, 'text/markdown')
  assert.ok(record.capture.original.blobName.endsWith('/original.md'))
  assert.equal(record.capture.finalUrl, undefined)
  assert.deepEqual(record.capture.redirects, [])
  assert.equal(record.extraction.method, 'markdown')
  assert.equal(record.extraction.version, 'score-markdown-extraction-v1')
  assert.equal(record.extraction.pagination, 'markdown-sections')
  assert.equal(record.extraction.pageCount, null)
  assert.equal(run.requests.public.length, 0)
  assert.equal(run.requests.ocr.length, 0)
  assert.equal(run.requests.model.length, 1)
  const original = await run.service.original(WORKSPACE, id)
  assert.equal(original.filename, 'Filename is not a person.MARKDOWN')
  assert.deepEqual(Buffer.from(original.bytes), bytes)
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 0, completed: 0 })
})

test('cancelled Markdown profiling retries the identical original and cached document without OCR or refetch', async () => {
  let cancelled = false
  const run = fixture({
    async modelFetch(body) {
      if (!cancelled) {
        cancelled = true
        await run.cancel(id)
      }
      return modelResponse(body)
    },
  })
  const bytes = Buffer.from(`# ${NAME}\n\n${ROLE}\n\n## Experience\n\n${EXPERIENCE}`)
  const id = await run.markdown(bytes)
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
  const stopped = await run.record(id)
  assert.equal(stopped.resume.status, 'cancelled')
  assert.ok(stopped.extraction)
  assert.equal(stopped.profileBlob, undefined)
  const current = await run.store.get(WORKSPACE, id)
  await run.service.retry(WORKSPACE, id, current.etag)
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { record } = await assertReady(run, id)
  assert.equal(record.retryCount, 1)
  assert.deepEqual(record.capture, stopped.capture)
  assert.deepEqual(record.extraction, stopped.extraction)
  assert.equal(run.blobs.writes.filter(name => name === stopped.extraction.document.blobName).length, 1)
  assert.deepEqual(Buffer.from((await run.service.original(WORKSPACE, id)).bytes), bytes)
  assert.equal(run.requests.ocr.length, 0)
  assert.equal(run.requests.public.length, 0)
})

test('actual uploaded PDF bytes take OCR and grounded profile paths; API validates every reference and quote', async () => {
  const bytes = await pdf()
  const run = fixture()
  const id = await run.upload(bytes, 'Filename is not a person.pdf')
  const imported = await run.store.get(WORKSPACE, id)
  const displayName = 'DISPLAY_ALIAS_IS_NOT_RESUME_EVIDENCE'
  await run.service.updateMetadata(WORKSPACE, id, { displayName }, imported.etag)
  assert.equal((await run.record(id)).resume.name, null)
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { record, detail } = await assertReady(run, id)
  assert.equal(detail.displayName, displayName)
  assert.equal(detail.resume.name, NAME)
  assert.equal(detail.resume.role, ROLE)
  assert.equal(detail.document.title, 'Filename is not a person.pdf')
  assert.deepEqual(record.source, imported.record.source)
  assert.equal(record.capture.finalUrl, undefined)
  assert.deepEqual(record.capture.redirects, [])
  assert.equal(record.extraction.method, 'document-intelligence')
  assert.equal(record.extraction.pagination, 'pdf-pages')
  assert.equal(record.extraction.pageCount, 2)
  assert.equal(detail.profile.experience.citations[0].page, 2)
  assert.deepEqual(new Uint8Array(run.requests.ocr[0].init.body), bytes)
  assert.equal(run.requests.public.length, 0)
  assert.equal(run.requests.ocr.length, 2)
  assert.equal(run.requests.model.length, 1)
  assert.ok(run.requests.tokens.every(scope => scope === 'https://cognitiveservices.azure.com/.default'))
  assert.equal(run.requests.model[0].body.messages[1].content.includes('Filename is not a person'), false)
  assert.equal(JSON.stringify(run.requests.model[0].body).includes(displayName), false)
  assert.deepEqual(JSON.parse(run.requests.model[0].body.messages[1].content), {
    source: { paragraphs: detail.document.paragraphs.map(paragraph => ({ paragraphId: paragraph.id, text: paragraph.text })) },
  })
  assert.equal(run.requests.model[0].body.response_format.json_schema.name, 'resume_profile')
  assert.equal(detail.profile.provenance.model, 'gpt-5-mini-controlled-build')
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 0, completed: 0 })
})

test('public HTML follows DNS-pinned redirects, saves actual provenance, and never invokes OCR or scoring', async () => {
  const run = fixture({
    transport: async request => request.url.pathname === '/old'
      ? http('', 302, 'text/html', { location: '/jordan' }) : http(),
  })
  const id = await run.url('https://profiles.example/old')
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { record, detail } = await assertReady(run, id)
  assert.equal(record.capture.finalUrl, 'https://profiles.example/jordan')
  assert.deepEqual(record.capture.redirects, ['https://profiles.example/jordan'])
  assert.equal(record.extraction.method, 'html')
  assert.equal(record.extraction.pagination, 'html-sections')
  assert.equal(record.extraction.pageCount, null)
  assert.ok(detail.document.paragraphs.every(paragraph => paragraph.page === 1))
  assert.ok(run.requests.public.every(request => request.address === '93.184.216.34' && request.method === 'GET'))
  assert.equal(run.requests.ocr.length, 0)
  assert.equal(run.requests.model.length, 1)
  assert.equal(run.requests.model[0].body.response_format.json_schema.name, 'resume_profile')
})

test('HTML meta encodings, transport charset aliases, and Unicode BOMs preserve names and captured bytes', async () => {
  const name = 'José Álvarez'
  const page = html().replace(NAME, name)
  const meta = page.replace('<head>', '<head><meta charset="windows-1252">')
  const httpEquiv = page.replace('<head>', '<head><META CONTENT="text/html; CHARSET=iso-8859-1" HTTP-EQUIV="Content-Type">')
  const cases = [
    ['UTF-8 default', Buffer.from(page), 'text/html'],
    ['meta charset', Buffer.from(meta, 'latin1'), 'text/html'],
    ['meta http-equiv', Buffer.from(httpEquiv, 'latin1'), 'text/html'],
    ['HTTP charset with equivalent meta', Buffer.from(meta, 'latin1'), 'Text/Html; charset="ISO-8859-1"'],
    ['UTF-8 BOM overrides legacy meta and transport', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(meta)]), 'text/html; charset=windows-1252'],
    ['UTF-16 LE BOM overrides transport', Buffer.from(`\ufeff${page}`, 'utf16le'), 'text/html; charset=windows-1252'],
    ['UTF-16 BE BOM', Buffer.from(`\ufeff${page}`, 'utf16le').swap16(), 'text/html'],
    ['XML encoding declaration', Buffer.from(`<?xml version="1.0" encoding="iso-8859-1"?>${page}`, 'latin1'), 'application/xhtml+xml'],
  ]
  for (const [label, bytes, type] of cases) {
    const run = fixture({
      transport: async () => http(bytes, 200, type),
      modelFetch: async body => unicodeModelResponse(body, name),
    })
    const id = await run.url()
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 }, label)
    const { record, detail } = await assertReady(run, id)
    assert.equal(detail.resume.name, name, label)
    assert.equal(detail.profile.name.citations[0].quote, name, label)
    assert.equal(record.extraction.method, 'html')
    const original = await run.blobs.read(record.capture.original.blobName)
    assert.deepEqual(Buffer.from(original.bytes), bytes, `${label}: preserve actual captured source bytes`)
    assert.equal(record.capture.original.sha256, resumeSha256(bytes))
    assert.equal(run.requests.public.length, 1)
  }
})

test('Shift-JIS meta decoding preserves non-Latin names and quotations', async () => {
  const name = '山田 太郎'
  const nameBytes = Buffer.from([0x8e, 0x52, 0x93, 0x63, 0x20, 0x91, 0xbe, 0x98, 0x59])
  const [prefix, suffix] = html().replace('<head>', '<head><meta charset="Shift_JIS">').split(NAME)
  const bytes = Buffer.concat([Buffer.from(prefix), nameBytes, Buffer.from(suffix)])
  const run = fixture({
    transport: async () => http(bytes),
    modelFetch: async body => unicodeModelResponse(body, name),
  })
  const id = await run.url()
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { detail } = await assertReady(run, id)
  assert.equal(detail.resume.name, name)
  assert.equal(detail.profile.name.citations[0].quote, name)
})

test('header-only legacy encodings use isolated rendering or fail explicitly rather than lose replayable provenance', async () => {
  const name = 'José Álvarez'
  const page = html().replace(NAME, name)
  for (const withRenderer of [false, true]) {
    let renders = 0
    const run = fixture({
      transport: async () => http(Buffer.from(page, 'latin1'), 200, 'text/html; charset=windows-1252'),
      modelFetch: async body => unicodeModelResponse(body, name),
      ...(withRenderer ? { browser: { render: async () => {
        renders++
        return { html: page, finalUrl: 'https://profiles.example/jordan' }
      } } } : {}),
    })
    const id = await run.url()
    const result = await runResumeWorker(run.deps)
    if (withRenderer) {
      assert.deepEqual(result, { claimed: 1, completed: 1 })
      const { record, detail } = await assertReady(run, id)
      assert.equal(record.extraction.method, 'browser')
      assert.equal(detail.resume.name, name)
      const original = await run.blobs.read(record.capture.original.blobName)
      assert.deepEqual([...original.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
      assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(original.bytes), page)
      assert.equal(renders, 1)
    } else {
      assert.deepEqual(result, { claimed: 1, completed: 0 })
      const record = await run.record(id)
      assert.equal(record.error.code, 'unsupported-content')
      assert.match(record.error.message, /character encoding.*secure renderer/)
      assert.equal(record.error.retryable, false)
      assert.equal(record.capture, undefined)
      assert.equal(run.requests.model.length, 0)
    }
  }
})

test('HTTP charset takes precedence over conflicting HTML meta and never publishes mojibake', async () => {
  const name = 'José Álvarez'
  const page = html().replace(NAME, name).replace('<head>', '<head><meta charset="windows-1252">')
  let renders = 0
  const run = fixture({
    transport: async () => http(Buffer.from(page), 200, 'text/html; charset=UTF-8'),
    modelFetch: async body => unicodeModelResponse(body, name),
    browser: { render: async () => {
      renders++
      return { html: page, finalUrl: 'https://profiles.example/jordan' }
    } },
  })
  const id = await run.url()
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { record, detail } = await assertReady(run, id)
  assert.equal(detail.resume.name, name)
  assert.equal(record.extraction.method, 'browser')
  assert.equal(renders, 1)
})

test('legacy and rendered encodings survive profiling retries without refetching or changing frozen evidence', async () => {
  const name = 'José Álvarez'
  const full = html().replace(NAME, name).replace('<head>', '<head><meta charset="windows-1252">')
  const thin = `<html><head><meta charset="windows-1252"></head><body><main><h1>${name}</h1><p>Software engineer. ${EXPERIENCE}</p></main></body></html>`
  for (const rendered of [false, true]) {
    let healthy = false
    let renders = 0
    const bytes = Buffer.from(rendered ? thin : full, 'latin1')
    const run = fixture({
      transport: async () => http(bytes, 200, 'text/html; charset=iso-8859-1'),
      modelFetch: async body => healthy ? unicodeModelResponse(body, name) : new Response(null, { status: 503 }),
      ...(rendered ? { browser: { render: async () => {
        renders++
        return { html: full, finalUrl: 'https://profiles.example/jordan' }
      } } } : {}),
    })
    const id = await run.url()
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
    const failed = await run.record(id)
    const original = await run.blobs.read(failed.capture.original.blobName)
    assert.equal(failed.error.code, 'service-unavailable')
    healthy = true
    run.clock.advance(15_001)
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
    const { record, detail } = await assertReady(run, id)
    assert.equal(detail.resume.name, name)
    assert.equal(record.capture.original.sha256, failed.capture.original.sha256)
    assert.deepEqual(record.extraction, failed.extraction)
    assert.deepEqual(await run.blobs.read(record.capture.original.blobName), original)
    assert.equal(run.requests.public.length, 1)
    assert.equal(renders, rendered ? 1 : 0)
    assert.equal(record.extraction.method, rendered ? 'browser' : 'html')
  }
})

test('unsupported and malformed HTML encodings are explicit private-safe errors before capture or profiling', async () => {
  const invalidUtf8 = Buffer.concat([Buffer.from(html().replace(NAME, 'NAME').split('NAME')[0]), Buffer.from([0xc3, 0x28]), Buffer.from('</h1></main>')])
  const cases = [
    [Buffer.from(html()), 'text/html; charset=private-marker-encoding', 'unsupported-content'],
    [Buffer.from(html().replace('<head>', '<head><meta charset="private-marker-encoding">')), 'text/html', 'unsupported-content'],
    [invalidUtf8, 'text/html; charset=utf-8', 'unreadable-document'],
    [Buffer.from('<html>\0<body>Invalid NUL</body></html>'), 'text/html', 'unreadable-document'],
    [Buffer.from([0xff, 0xfe, 0x3c]), 'text/html', 'unreadable-document'],
    [Buffer.from([0xff, 0xfe, 0, 0, 0x3c, 0, 0, 0]), 'text/html', 'unsupported-content'],
    [Buffer.from(html().replace('<head>', '<head><meta charset="utf-8"><meta charset="windows-1252">')), 'text/html', 'unreadable-document'],
  ]
  for (const [bytes, type, code] of cases) {
    let renders = 0
    const run = fixture({
      transport: async () => http(bytes, 200, type),
      browser: { render: async () => { renders++; return { html: html(), finalUrl: 'https://profiles.example/jordan' } } },
    })
    const id = await run.url()
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
    const record = await run.record(id)
    assert.equal(record.error.code, code)
    assert.match(record.error.message, /character encoding/)
    assert.doesNotMatch(record.error.message, /private-marker|Jordan|profiles\.example/)
    assert.equal(record.error.retryable, false)
    assert.equal(record.resume.name, null)
    assert.equal(record.capture, undefined)
    assert.equal(record.profileBlob, undefined)
    assert.equal(renders, 0)
    assert.equal(run.requests.model.length, 0)
  }
})

test('renderer Unicode strings with lone surrogates cannot be silently UTF-8 replaced', async () => {
  const run = fixture({
    transport: async () => http(`<main><h1>${NAME}</h1><p>Software engineer. ${EXPERIENCE}</p></main>`),
    browser: { render: async () => ({ html: html().replace(NAME, 'Broken \ud800 Name'), finalUrl: 'https://profiles.example/jordan' }) },
  })
  const id = await run.url()
  await runResumeWorker(run.deps)
  assert.equal((await run.record(id)).error.code, 'unreadable-document')
  assert.match((await run.record(id)).error.message, /invalid character encoding/)
  assert.equal(run.requests.model.length, 0)
})

for (const type of ['application/pdf', 'application/octet-stream']) {
  test(`public PDF uses the same validated OCR path when served as ${type}`, async () => {
    const bytes = await pdf()
    const run = fixture({ transport: async () => http(bytes, 200, type) })
    const id = await run.url('https://profiles.example/download')
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
    const { record } = await assertReady(run, id)
    assert.equal(record.capture.original.contentType, 'application/pdf')
    assert.equal(record.capture.finalUrl, 'https://profiles.example/download')
    assert.deepEqual(record.capture.redirects, [])
    assert.deepEqual(new Uint8Array(run.requests.ocr[0].init.body), bytes)
    assert.equal(record.extraction.method, 'document-intelligence')
  })
}

test('valid PDF headers accepted within the first 1024 bytes retain the exact uploaded bytes for OCR', async () => {
  const document = await pdf()
  for (const prefix of [Buffer.from('Exported resume document\n'), Buffer.alloc(1019, 32)]) {
    const bytes = Buffer.concat([prefix, document])
    for (const url of [false, true]) {
      const run = fixture({ transport: async () => http(bytes, 200, 'application/octet-stream') })
      const id = url ? await run.url() : await run.upload(bytes)
      assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
      await assertReady(run, id)
      assert.deepEqual(Buffer.from(run.requests.ocr[0].init.body), bytes)
    }
  }
})

test('PDF magic extending beyond byte 1023 is rejected before OCR or profiling', async () => {
  const bytes = Buffer.concat([Buffer.alloc(1020, 32), await pdf()])
  const run = fixture({ transport: async () => http(bytes, 200, 'application/pdf') })
  const id = await run.url()
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
  const record = await run.record(id)
  assert.equal(record.error.code, 'unreadable-document')
  assert.match(record.error.message, /PDF/)
  assert.equal(run.requests.ocr.length, 0)
  assert.equal(run.requests.model.length, 0)
  assert.equal(record.capture, undefined)
  await assert.rejects(run.upload(bytes), /not a PDF/i)
})

test('private rendering re-extracts a thin profile, records its final URL without inventing redirect history', async () => {
  const renderCalls = []
  const run = fixture({
    transport: async () => http(`<main><h1>${NAME}</h1><p>Software engineer. ${EXPERIENCE}</p></main>`),
    browser: { render: async (url, options) => {
      renderCalls.push({ url, options })
      return { html: html(), finalUrl: 'https://profiles.example/rendered-jordan' }
    } },
  })
  const id = await run.url()
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { record, detail } = await assertReady(run, id)
  assert.equal(record.extraction.method, 'browser')
  assert.equal(record.capture.finalUrl, 'https://profiles.example/rendered-jordan')
  assert.deepEqual(record.capture.redirects, [])
  assert.equal(renderCalls.length, 1)
  assert.ok(renderCalls[0].options.signal instanceof AbortSignal)
  assert.ok(detail.document.paragraphs.some(value => value.text.includes('transit timetable')))
})

test('an empty JavaScript application shell requires isolated rendering followed by professional-profile extraction', async () => {
  for (const shell of [
    '<html><head><title>Professional profile</title></head><body><div id="root">Loading profile…</div><script src="/app.js"></script></body></html>',
    '<html><head><title>Profile</title></head><body><div id="app"></div><script src="profile.js"></script></body></html>',
  ]) {
    for (const browser of [
      undefined,
      { render: async () => ({ html: html(), finalUrl: 'https://profiles.example/jordan' }) },
    ]) {
      const run = fixture({ transport: async () => http(shell), browser })
      const id = await run.url()
      const result = await runResumeWorker(run.deps)
      if (browser) {
        assert.deepEqual(result, { claimed: 1, completed: 1 })
        assert.equal((await assertReady(run, id)).record.extraction.method, 'browser')
      } else {
        assert.deepEqual(result, { claimed: 1, completed: 0 })
        const record = await run.record(id)
        assert.equal(record.error.code, 'service-unavailable')
        assert.equal(record.error.retryable, true)
        assert.equal(record.capture, undefined)
        assert.equal(run.requests.model.length, 0)
      }
    }
  }
})

test('unreadable rendered HTML gives URL guidance rather than PDF-password instructions', async () => {
  const shell = '<html><head><title>Profile</title></head><body><div id="app"></div><script src="profile.js"></script></body></html>'
  let renders = 0
  const run = fixture({
    transport: async () => http(shell),
    browser: { render: async () => {
      renders++
      return { html: shell, finalUrl: 'https://profiles.example/jordan' }
    } },
  })
  const id = await run.url()
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
  const record = await run.record(id)
  assert.equal(record.error.code, 'unreadable-document')
  assert.equal(record.error.stage, 'parsing')
  assert.match(record.error.message, /public.*(?:page|URL)/i)
  assert.doesNotMatch(record.error.message, /PDF|password/i)
  assert.equal(renders, 1, 'An unreadable rendered result must not trigger an unbounded render loop')
  assert.equal(run.requests.model.length, 0)
  assert.equal(record.capture, undefined)
  assert.equal(record.profileBlob, undefined)
})

test('unrelated structured pages and nonempty application pages do not qualify for shell rendering', async () => {
  for (const body of [
    '<html><title>News article</title><body><div id="root"></div><script src="/app.js"></script></body></html>',
    '<div id="root">Browse our products</div><script src="/app.js"></script>',
    '<div id="root"></div><script type="application/ld+json">{"@type":"Article","name":"News"}</script><script src="/app.js"></script>',
  ]) {
    let rendered = false
    const run = fixture({
      transport: async () => http(body),
      browser: { render: async () => { rendered = true; return { html: html(), finalUrl: 'https://profiles.example/jordan' } } },
    })
    const id = await run.url()
    await runResumeWorker(run.deps)
    assert.equal((await run.record(id)).error.code, 'not-a-profile')
    assert.equal(rendered, false)
    assert.equal(run.requests.model.length, 0)
  }
})

test('a renderer cannot turn a login wall, unrelated page, or private final URL into an accepted profile', async () => {
  for (const [rendered, expected] of [
    [{ html: '<html><title>Sign in</title><main>Sign in to view this profile.</main></html>', finalUrl: 'https://www.linkedin.com/authwall' }, 'access-blocked'],
    [{ html: '<main><h1>Products</h1><p>Garden furniture for sale.</p></main>', finalUrl: 'https://profiles.example/shop' }, 'not-a-profile'],
    [{ html: html(), finalUrl: 'http://127.0.0.1/private' }, 'invalid-source'],
  ]) {
    const run = fixture({
      transport: async () => http(`<main><h1>${NAME}</h1><p>Software engineer. ${EXPERIENCE}</p></main>`),
      browser: { render: async () => rendered },
    })
    const id = await run.url()
    await runResumeWorker(run.deps)
    const record = await run.record(id)
    assert.equal(record.error.code, expected)
    assert.equal(record.resume.name, null)
    assert.equal(record.capture, undefined)
    assert.equal(record.profileBlob, undefined)
    assert.equal(run.requests.model.length, 0)
  }
})

test('renderer service failures are retryable service errors, not private-page or profile successes', async () => {
  const run = fixture({
    transport: async () => http(`<main><h1>${NAME}</h1><p>Software engineer. ${EXPERIENCE}</p></main>`),
    browser: { render: async () => { throw new Error('private renderer source marker') } },
  })
  const id = await run.url()
  await runResumeWorker(run.deps)
  const record = await run.record(id)
  assert.equal(record.error.code, 'service-unavailable')
  assert.equal(record.error.stage, 'download')
  assert.equal(record.error.retryable, true)
  assert.equal(run.requests.model.length, 0)
  assert.doesNotMatch(record.error.message, /private renderer source marker/)
})

test('a genuine sparse public profile succeeds with explicit unavailable metadata and low-content warnings', async () => {
  const run = fixture({
    transport: async () => http('<html><title>Professional profile</title><main><h2>Projects</h2><p>Built an accessible transit timetable application.</p></main></html>'),
    modelFetch: async body => modelResponse(body, { sparse: true }),
  })
  const id = await run.url()
  await runResumeWorker(run.deps)
  const { detail } = await assertReady(run, id)
  assert.deepEqual([detail.resume.name, detail.resume.role, detail.resume.location, detail.resume.experience], [null, null, null, null])
  assert.match(detail.warnings.join(' '), /limited.*unavailable/i)
})

test('HTTP 403 and HTTP-200 sign-in walls are independent item failures without rendering or profiling', async () => {
  let renders = 0
  const run = fixture({
    transport: async request => request.url.pathname === '/403' ? http('private-marker', 403)
      : request.url.pathname === '/login'
        ? http('<html><title>Sign in</title><main><input type="password"><p>Sign in to view this profile.</p></main></html>')
        : http(),
    browser: { render: async () => { renders++; throw new Error('Must not render an access wall') } },
  })
  const ids = await Promise.all(['/403', '/login', '/ok'].map(path => run.url(`https://profiles.example${path}`)))
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 3, completed: 1 })
  for (const id of ids.slice(0, 2)) {
    const record = await run.record(id)
    assert.equal(record.resume.status, 'error')
    assert.equal(record.error.code, 'access-blocked')
    assert.equal(record.error.message, 'This URL is not publicly accessible and could not be processed.')
    assert.equal(record.error.retryable, false)
    assert.equal(record.capture, undefined)
    assert.equal(record.profileBlob, undefined)
    assert.equal(record.resume.name, null)
  }
  await assertReady(run, ids[2])
  assert.equal(renders, 0)
  assert.equal(run.requests.model.length, 1)
})

for (const [label, response, code, retryable] of [
  ['missing', () => http('private-marker', 404), 'not-found', false],
  ['gone', () => http('private-marker', 410), 'not-found', false],
  ['outage', () => http('private-marker', 503), 'service-unavailable', true],
  ['rate limited', () => http('private-marker', 429), 'service-unavailable', true],
  ['network', () => { throw new Error('private-marker candidate@example.test') }, 'network-error', true],
  ['unknown MIME', () => http(html(), 200, 'text/plain'), 'unsupported-content', false],
  ['unrelated', () => http('<main><h1>Products</h1><p>Garden furniture for sale.</p><script src="app.js"></script></main>'), 'not-a-profile', false],
  ['directory', () => http('<main><h1>People directory</h1><article><h2>Jordan Vale</h2><p>Engineer</p></article></main>'), 'multiple-profiles', false],
]) {
  test(`${label} is classified distinctly and never exposes response content in the error`, async () => {
    let renders = 0
    const run = fixture({ transport: async () => response(), browser: { render: async () => { renders++; return { html: html(), finalUrl: 'https://profiles.example/' } } } })
    const id = await run.url()
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
    const record = await run.record(id)
    assert.equal(record.error.code, code)
    assert.equal(record.error.retryable, retryable)
    assert.equal(record.resume.status, retryable ? 'queued' : 'error')
    assert.doesNotMatch(record.error.message, /private-marker|candidate@|profiles\.example/)
    assert.equal(run.requests.model.length, 0)
    assert.equal(renders, 0)
  })
}

test('unsafe DNS and redirects, credentials, and nonstandard ports never reach the public transport', async () => {
  for (const addresses of [['127.0.0.1'], ['93.184.216.34', '10.0.0.1'], ['168.63.129.16'], ['::1']]) {
    const run = fixture()
    run.deps.safeFetchOptions.resolver = async () => addresses
    const id = await run.url()
    await runResumeWorker(run.deps)
    assert.equal((await run.record(id)).error.code, 'invalid-source')
    assert.equal(run.requests.public.length, 0)
  }
  for (const location of ['http://127.0.0.1/private', 'https://user:secret@profiles.example/', 'https://profiles.example:444/']) {
    const run = fixture({ transport: async () => http('', 302, 'text/html', { location }) })
    const id = await run.url()
    await runResumeWorker(run.deps)
    assert.equal((await run.record(id)).error.code, 'invalid-source')
    assert.equal(run.requests.public.length, 1)
  }
})

test('public fetching strips caller authentication and enforces redirect and byte budgets', async () => {
  const run = fixture({ transport: async request => http('', 302, 'text/html', { location: `${request.url.pathname}/again` }) })
  Object.assign(run.deps.safeFetchOptions, {
    maxRedirects: 100, maxBytes: 100_000_000, timeoutMilliseconds: 999_999, method: 'POST',
    body: Buffer.from('private-marker'), headers: { authorization: 'private-marker', cookie: 'private-marker' },
  })
  const id = await run.url()
  await runResumeWorker(run.deps)
  assert.equal((await run.record(id)).error.code, 'invalid-source')
  assert.equal(run.requests.public.length, 6)
  for (const request of run.requests.public) {
    assert.equal(request.method, 'GET')
    assert.equal(request.body, undefined)
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers.cookie, undefined)
    assert.ok(request.maxBytes <= 12 * 1024 * 1024)
    assert.ok(request.timeoutMilliseconds <= 30_000)
  }
})

test('overlong redirect URLs and invalid fetch overrides never weaken the public source bounds', async () => {
  const run = fixture({ transport: async () => http('', 302, 'text/html', { location: `https://profiles.example/${'x'.repeat(4096)}` }) })
  const id = await run.url()
  await runResumeWorker(run.deps)
  assert.equal((await run.record(id)).error.code, 'invalid-source')
  assert.equal(run.requests.public.length, 1)
  for (const override of [{ maxBytes: NaN }, { maxRedirects: Infinity }, { timeoutMilliseconds: -1 }]) {
    const bounded = fixture()
    Object.assign(bounded.deps.safeFetchOptions, override)
    const item = await bounded.url()
    await runResumeWorker(bounded.deps)
    assert.equal((await bounded.record(item)).error.code, 'invalid-source')
    assert.equal(bounded.requests.public.length, 0)
  }
})

test('50-page PDFs succeed while oversized, encrypted, malformed, and 51-page sources fail before OCR', async () => {
  const valid = fixture({ pages: 50 })
  const accepted = await valid.upload(await pdf(50))
  await runResumeWorker(valid.deps)
  assert.equal((await assertReady(valid, accepted)).record.extraction.pageCount, 50)
  const oversized = new Uint8Array(10 * 1024 * 1024 + 1)
  oversized.set(Buffer.from('%PDF-1.7'))
  for (const [bytes, code] of [
    [oversized, 'pdf-too-large'], [await pdf(51), 'pdf-too-many-pages'],
    [await pdf(1, true), 'unreadable-document'], [Buffer.from('%PDF-broken'), 'unreadable-document'],
    [Buffer.from('not a PDF'), 'unreadable-document'],
  ]) {
    const run = fixture({ transport: async () => http(bytes, 200, 'application/pdf') })
    const id = await run.url()
    await runResumeWorker(run.deps)
    const record = await run.record(id)
    assert.equal(record.error.code, code)
    assert.equal(record.error.retryable, false)
    if (code === 'unreadable-document') assert.match(record.error.message, /PDF|password/i)
    assert.equal(run.requests.ocr.length, 0)
    assert.equal(run.requests.model.length, 0)
  }
})

test('OCR results must preserve actual pages, and complete normalized heading plus text counts stop at 180000', async () => {
  for (const [length, expected] of [[179_994, 'ready'], [179_995, 'source-too-large']]) {
    const text = `${EXPERIENCE} ${'x'.repeat(length - EXPERIENCE.length - 1)}`
    const run = fixture({ pages: 1, ocrResult: ocr(1, [[text, 1]]) })
    const id = await run.upload(await pdf(1))
    await runResumeWorker(run.deps)
    const record = await run.record(id)
    if (expected === 'ready') {
      await assertReady(run, id)
      assert.equal(record.extraction.normalizedCharacters, 180_000)
    } else {
      assert.equal(record.error.code, expected)
      assert.equal(run.requests.model.length, 0)
    }
  }
  const run = fixture({ ocrResult: ocr(1) })
  const id = await run.upload(await pdf(2))
  await runResumeWorker(run.deps)
  assert.equal((await run.record(id)).error.code, 'service-unavailable')
  assert.equal(run.requests.model.length, 0)
})

test('oversized HTML is rejected without truncation or model calls', async () => {
  const run = fixture({ transport: async () => http(html(ROLE, `<p>${'x'.repeat(180_001)}</p>`)) })
  const id = await run.url()
  await runResumeWorker(run.deps)
  assert.equal((await run.record(id)).error.code, 'source-too-large')
  assert.equal(run.requests.model.length, 0)
})

test('OCR and model errors are sanitized and never persist invented metadata or raw service output', async () => {
  for (const model of [false, true]) {
    const run = fixture(model ? {
      modelFetch: async body => {
        const value = modelPayload(body)
        value.name = { status: 'available', value: 'Invented candidate', citations: [{ paragraphId: 'p-missing', quote: 'private-marker candidate@example.test' }] }
        return Response.json({ model: 'actual-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })
      },
    } : {
      ocrFetch: async (_url, init) => init.method === 'POST'
        ? new Response(null, { status: 202, headers: { 'operation-location': 'https://ocr.example/operation/1' } })
        : Response.json({ status: 'failed', error: { code: 'BadSource', message: 'private-marker candidate@example.test' } }),
    })
    const id = await run.upload(await pdf())
    await runResumeWorker(run.deps)
    const record = await run.record(id)
    assert.equal(record.error.code, model ? 'invalid-model-output' : 'unreadable-document')
    assert.equal(record.error.stage, model ? 'profiling' : 'parsing')
    assert.doesNotMatch(record.error.message, /private-marker|candidate@|Invented/)
    assert.deepEqual([record.resume.name, record.resume.role, record.resume.location, record.resume.experience], [null, null, null, null])
    assert.equal(record.profileBlob, undefined)
    assert.equal(await run.blobs.read(resumeProfileBlobName(WORKSPACE, id)), undefined)
    assert.equal(run.requests.model.length, model ? 2 : 0)
  }
})

test('identical filenames never merge people; URL captures update workspace-local exact-content warnings', async () => {
  const original = await pdf()
  const other = await pdf(1)
  const run = fixture({ transport: async () => http(original, 200, 'application/pdf') })
  const first = await run.upload(original)
  const second = await run.upload(other)
  const foreign = await run.upload(original, 'same-name.pdf', 'other-workspace')
  assert.deepEqual((await run.record(second)).duplicates, [])
  const id = await run.url()
  await runResumeWorker(run.deps)
  const result = await assertReady(run, id)
  assert.equal(result.record.duplicates.length, 1)
  assert.deepEqual(result.record.duplicates.map(item => [item.kind, item.resumeId]), [['exact-content', first]])
  assert.equal(result.record.duplicates.some(item => item.resumeId === foreign), false)
  assert.notEqual(first, second)
  assert.equal((await run.record(first)).resume.id, first)
  assert.ok((await run.detail(first)).duplicates.some(item => item.resumeId === id))
})

test('a winning capture keeps its own bytes and final URL, not a losing fresh download', async () => {
  const run = fixture()
  const id = await run.url('https://profiles.example/requested')
  const initial = await run.record(id)
  const winningBytes = Buffer.from(html('Platform architect'))
  const winningName = resumeOriginalBlobName(WORKSPACE, id, 'html')
  const winningBlob = run.blobs.save(winningName, winningBytes, 'text/html')
  const winningManifest = {
    schemaVersion: 1, dataKind: 'real', workspaceId: WORKSPACE, resumeId: id,
    inputFingerprint: initial.inputFingerprint, source: initial.source,
    capture: {
      original: resumeBlobReference(winningName, winningBlob), capturedAt: NOW,
      finalUrl: 'https://profiles.example/winning-final', redirects: ['https://profiles.example/winning-final'],
    },
  }
  // Reveal the competing original only once the immutable manifest race has happened.
  run.blobs.values.delete(winningName)
  const put = run.blobs.putImmutable.bind(run.blobs)
  run.blobs.putImmutable = async (name, bytes, type) => {
    if (name === resumeCaptureBlobName(WORKSPACE, id)) {
      run.blobs.save(winningName, winningBytes, 'text/html')
      run.blobs.putJson(name, winningManifest)
    }
    return put(name, bytes, type)
  }
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { record, detail } = await assertReady(run, id)
  assert.equal(record.capture.finalUrl, winningManifest.capture.finalUrl)
  assert.equal(record.capture.original.sha256, resumeSha256(winningBytes))
  assert.equal(detail.resume.role, 'Platform architect')
  assert.ok(run.requests.model[0].body.messages[1].content.includes('Platform architect'))
  assert.equal(run.requests.model[0].body.messages[1].content.includes(ROLE), false)
})

test('crashes between immutable manifest and original publication recover only the exact winning bytes', async () => {
  const run = fixture()
  const id = await run.url()
  const put = run.blobs.putImmutable.bind(run.blobs)
  let fail = true
  run.blobs.putImmutable = async (name, bytes, type) => {
    if (name.endsWith('original.html') && fail) throw new Error('lost storage response private-marker')
    return put(name, bytes, type)
  }
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
  const manifestName = resumeCaptureBlobName(WORKSPACE, id)
  const firstManifest = await run.blobs.read(manifestName)
  assert.ok(firstManifest)
  assert.equal((await run.record(id)).capture, undefined)
  run.clock.advance(15_001)
  fail = false
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { record } = await assertReady(run, id)
  assert.equal(record.captureManifest.sha256, firstManifest.sha256)
  assert.equal(record.attempts, 2)
  assert.equal(run.requests.public.length, 2)
})

test('a reserved capture whose missing bytes now differ fails closed rather than relabeling newer content', async () => {
  const run = fixture()
  const id = await run.url()
  const record = await run.record(id)
  const old = Buffer.from(html('Platform architect'))
  const name = resumeOriginalBlobName(WORKSPACE, id, 'html')
  const original = resumeBlobReference(name, { bytes: old, contentType: 'text/html', sha256: resumeSha256(old), etag: 'reserved' })
  run.blobs.putJson(resumeCaptureBlobName(WORKSPACE, id), {
    schemaVersion: 1, dataKind: 'real', workspaceId: WORKSPACE, resumeId: id,
    inputFingerprint: record.inputFingerprint, source: record.source,
    capture: { original, capturedAt: NOW, finalUrl: 'https://profiles.example/original-final', redirects: [] },
  })
  await runResumeWorker(run.deps)
  assert.equal((await run.record(id)).error.code, 'invalid-source')
  assert.equal(await run.blobs.read(name), undefined)
  assert.equal(run.requests.model.length, 0)
})

for (const target of ['document', 'profile', 'ready-response']) {
  test(`${target} publication ambiguity preserves winning evidence and avoids repeated OCR/model work`, async () => {
    const run = fixture()
    const id = await run.upload(await pdf())
    const replace = run.store.replace.bind(run.store)
    let injected = false
    run.store.replace = async (record, etag) => {
      const hit = target === 'document' ? record.extraction && record.resume.status === 'profiling'
        : record.resume.status === 'ready'
      if (hit && !injected) {
        injected = true
        if (target === 'ready-response') await replace(record, etag)
        throw new Error('ambiguous storage failure private-marker')
      }
      return replace(record, etag)
    }
    const first = await runResumeWorker(run.deps)
    const ocrRequests = run.requests.ocr.length
    const modelRequests = run.requests.model.length
    if (target === 'ready-response') assert.deepEqual(first, { claimed: 1, completed: 1 })
    else {
      assert.deepEqual(first, { claimed: 1, completed: 0 })
      run.clock.advance(15_001)
      assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
      assert.equal(run.requests.ocr.length, ocrRequests)
      assert.equal(run.requests.model.length, target === 'profile' ? modelRequests : modelRequests + 1)
    }
    await assertReady(run, id)
  })
}

test('an already stored validated profile wins over a different fresh model response', async () => {
  const run = fixture()
  const id = await run.url()
  const put = run.blobs.putImmutable.bind(run.blobs)
  run.blobs.putImmutable = async (name, bytes, type) => {
    if (name === resumeProfileBlobName(WORKSPACE, id)) {
      const winner = JSON.parse(Buffer.from(bytes))
      winner.name = { status: 'unavailable', value: null, citations: [] }
      winner.provenance.model = 'actual-winning-model'
      run.blobs.putJson(name, winner)
    }
    return put(name, bytes, type)
  }
  await runResumeWorker(run.deps)
  const { detail } = await assertReady(run, id)
  assert.equal(detail.resume.name, null)
  assert.equal(detail.profile.provenance.model, 'actual-winning-model')
})

test('winning normalized document bytes, not losing fresh OCR text, bind the profile request and citations', async () => {
  const run = fixture()
  const id = await run.upload(await pdf())
  const put = run.blobs.putImmutable.bind(run.blobs)
  run.blobs.putImmutable = async (name, bytes, type) => {
    if (name === resumeDocumentBlobName(WORKSPACE, id)) {
      const winner = JSON.parse(Buffer.from(bytes))
      winner.paragraphs = winner.paragraphs.filter(paragraph => paragraph.text !== NAME)
      run.blobs.putJson(name, winner)
    }
    return put(name, bytes, type)
  }
  await runResumeWorker(run.deps)
  const { detail } = await assertReady(run, id)
  assert.equal(detail.resume.name, null)
  assert.ok(detail.profile.experience.citations.length > 0)
  assert.equal(run.requests.model[0].body.messages[1].content.includes(NAME), false)
  assert.equal(detail.document.paragraphs.some(paragraph => paragraph.text === NAME), false)
})

for (const mutation of ['original-hash', 'original-type', 'manifest-fingerprint', 'manifest-bytes', 'document-owner', 'document-json', 'document-hash', 'profile-quote']) {
  test(`corrupt ${mutation} fails verification without invented profile or replaced evidence`, async () => {
    const run = fixture()
    const id = await run.upload(await pdf())
    const initial = await run.record(id)
    if (mutation === 'original-hash') run.blobs.values.get(initial.capture.original.blobName).sha256 = 'f'.repeat(64)
    if (mutation === 'original-type') run.blobs.values.get(initial.capture.original.blobName).contentType = 'text/html'
    if (mutation.startsWith('manifest-')) {
      const blob = await run.blobs.read(initial.captureManifest.blobName)
      const manifest = JSON.parse(Buffer.from(blob.bytes))
      if (mutation === 'manifest-fingerprint') manifest.inputFingerprint = 'f'.repeat(64)
      else manifest.capture.original.bytes += 1
      const changed = run.blobs.putJson(initial.captureManifest.blobName, manifest)
      const current = await run.store.get(WORKSPACE, id)
      // Point to a correctly hashed but semantically foreign manifest to exercise binding checks.
      current.record.captureManifest = { ...resumeBlobReference(initial.captureManifest.blobName, changed), contentType: 'application/json' }
      run.store.save(current.record)
    }
    if (mutation.startsWith('document-')) {
      const documentName = resumeDocumentBlobName(WORKSPACE, id)
      const document = {
        id: mutation === 'document-owner' ? `document-${randomUUID()}` : initial.resume.documentId,
        version: 1, kind: 'resume', sample: false, title: 'Saved resume',
        paragraphs: [{ id: 'p-1', page: 1, heading: 'Experience', text: EXPERIENCE }],
      }
      if (mutation === 'document-json') run.blobs.save(documentName, Buffer.from('{'), 'application/json')
      else run.blobs.putJson(documentName, document)
      if (mutation === 'document-hash') run.blobs.values.get(documentName).sha256 = 'f'.repeat(64)
    }
    if (mutation === 'profile-quote') {
      const put = run.blobs.putImmutable.bind(run.blobs)
      run.blobs.putImmutable = async (name, bytes, type) => {
        if (name === resumeProfileBlobName(WORKSPACE, id)) {
          const profile = JSON.parse(Buffer.from(bytes))
          profile.name.citations[0].quote = 'Invented private-marker'
          run.blobs.putJson(name, profile)
        }
        return put(name, bytes, type)
      }
    }
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
    const record = await run.record(id)
    assert.equal(record.resume.status, 'error')
    assert.ok(['storage-error', 'invalid-source', 'invalid-profile'].includes(record.error.code))
    assert.equal(record.resume.name, null)
    assert.equal(record.profileBlob, undefined)
    assert.doesNotMatch(record.error.message, /private-marker|Jordan|Seattle|case management/)
  })
}

test('an orphan original without provenance is never silently assigned a guessed final URL', async () => {
  const run = fixture()
  const id = await run.url()
  run.blobs.save(resumeOriginalBlobName(WORKSPACE, id, 'html'), Buffer.from(html()), 'text/html')
  await runResumeWorker(run.deps)
  assert.equal((await run.record(id)).error.code, 'invalid-source')
  assert.equal(run.requests.public.length, 0)
  assert.equal(run.requests.model.length, 0)
})

test('conditional claim races have one winner and completed counts exclude failed items', async () => {
  const run = fixture()
  const id = await run.url()
  const results = await Promise.all([
    runResumeWorker({ ...run.deps, owner: 'worker-one' }),
    runResumeWorker({ ...run.deps, owner: 'worker-two' }),
  ])
  assert.equal(results.reduce((sum, value) => sum + value.claimed, 0), 1)
  assert.equal(results.reduce((sum, value) => sum + value.completed, 0), 1)
  assert.equal(run.requests.model.length, 1)
  assert.equal((await assertReady(run, id)).record.attempts, 1)
})

test('expired claims recover with a new attempt ID, while three expired attempts stop automatically', async () => {
  for (const attempts of [1, 3]) {
    const run = fixture()
    const id = await run.url()
    const current = await run.store.get(WORKSPACE, id)
    const attemptId = randomUUID()
    run.store.save({
      ...current.record, attempts, attemptId, resume: { ...current.record.resume, status: 'parsing' },
      lease: { owner: 'crashed-worker', heartbeatAt: NOW, expiresAt: new Date(Date.parse(NOW) + 90_000).toISOString() },
      nextAttemptAt: new Date(Date.parse(NOW) + 90_000).toISOString(),
    })
    run.clock.advance(90_001)
    const counts = await runResumeWorker(run.deps)
    const record = await run.record(id)
    if (attempts === 1) {
      assert.deepEqual(counts, { claimed: 1, completed: 1 })
      assert.equal(record.attempts, 2)
      assert.notEqual(record.attemptId, attemptId)
      await assertReady(run, id)
    } else {
      assert.deepEqual(counts, { claimed: 0, completed: 0 })
      assert.equal(record.resume.status, 'error')
      assert.equal(record.attempts, 3)
      assert.equal(record.lease, undefined)
      assert.match(record.error.message, /three automatic attempts/)
      assert.equal(run.requests.public.length, 0)
    }
  }
})

test('heartbeats extend the same attempt and observe cancellation while a model call is in flight', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let release
  let reached
  const started = new Promise(resolve => { reached = resolve })
  let modelSignal
  const run = fixture({ modelFetch: async (body, init) => {
    modelSignal = init.signal
    reached()
    await new Promise(resolve => { release = resolve })
    return modelResponse(body)
  } })
  const id = await run.url()
  const processing = runResumeWorker(run.deps)
  await started
  const initial = await run.record(id)
  for (let index = 0; index < 4; index++) {
    run.clock.advance(25_000)
    t.mock.timers.tick(25_000)
    await flush()
    const live = await run.record(id)
    assert.equal(live.attemptId, initial.attemptId)
    assert.equal(live.lease.heartbeatAt, run.clock.now().toISOString())
    assert.equal(Date.parse(live.lease.expiresAt) - run.clock.now().getTime(), resumeWorkerConstants.leaseMilliseconds)
  }
  await run.cancel(id)
  run.clock.advance(25_000)
  t.mock.timers.tick(25_000)
  await flush()
  assert.equal(modelSignal.aborted, true)
  release()
  assert.deepEqual(await processing, { claimed: 1, completed: 0 })
  assert.equal((await run.record(id)).resume.status, 'cancelled')
  assert.equal(await run.blobs.read(resumeProfileBlobName(WORKSPACE, id)), undefined)
})

for (const scope of ['resume', 'workspace']) {
  test(`a ${scope} archive fence rejects stale claim pages before any retrieval or processing`, async () => {
    const run = fixture()
    const id = await run.url()
    const candidate = await run.store.get(WORKSPACE, id)
    if (scope === 'resume') {
      await new ResumeLifecycleService(run.deps, undefined, run.clock.now).change(WORKSPACE, id, 'archive', candidate.etag)
    } else await createResumeLifecycleParticipant(run.deps).setState(WORKSPACE, 'archived', NOW)
    run.store.listPending = async () => [candidate]
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 0, completed: 0 })
    assert.equal(run.requests.public.length, 0)
    assert.equal(run.requests.ocr.length, 0)
    assert.equal(run.requests.model.length, 0)
    assert.equal(await run.blobs.read(resumeProfileBlobName(WORKSPACE, id)), undefined)
  })
}

for (const action of ['archive', 'delete']) {
  for (const during of ['download', 'model']) {
    test(`resume ${action} during ${during} blocks late source/profile publication and never operates on frozen analysis work`, async () => {
      const frozen = Object.freeze({ id: 'independent-frozen-analysis', status: 'running', profileVersion: 1 })
      let run, id
      let dependencyCalls = 0
      const transition = async () => {
        const current = await run.store.get(WORKSPACE, id)
        const lifecycle = new ResumeLifecycleService(run.deps, {
          async impact(workspaceId, target) {
            dependencyCalls++
            assert.equal(workspaceId, WORKSPACE)
            assert.deepEqual(target, { kind: 'resume', id })
            return []
          },
        }, run.clock.now)
        await lifecycle.change(WORKSPACE, id, action, current.etag)
      }
      run = fixture(during === 'download' ? {
        transport: async () => { await transition(); return http() },
      } : {
        modelFetch: async body => { await transition(); return modelResponse(body) },
      })
      id = await run.url()
      assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
      if (action === 'archive') {
        const archived = await run.record(id)
        assert.ok(archived.lifecycle.archivedAt)
        assert.equal(archived.resume.status, 'cancelled')
        assert.equal(archived.attemptId, undefined)
        assert.equal(archived.lease, undefined)
        assert.equal(dependencyCalls, 0)
        if (during === 'model') assert.ok(archived.extraction)
      } else {
        assert.equal(await run.store.get(WORKSPACE, id), undefined)
        assert.equal((await run.store.getControl(WORKSPACE, id)).record.state, 'deleted')
        assert.equal([...run.blobs.values.keys()].some(name => name.startsWith(`${WORKSPACE}/${id}/`)), false)
        assert.equal(dependencyCalls, 1)
      }
      assert.equal(await run.blobs.read(resumeProfileBlobName(WORKSPACE, id)), undefined)
      assert.equal(frozen.status, 'running')
    })
  }
}

test('workspace archive is observed by heartbeat before cancellation recovery runs', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let release, reached, modelSignal
  const started = new Promise(resolve => { reached = resolve })
  const run = fixture({ modelFetch: async (body, init) => {
    modelSignal = init.signal
    reached()
    await new Promise(resolve => { release = resolve })
    return modelResponse(body)
  } })
  const id = await run.url()
  const processing = runResumeWorker(run.deps)
  await started
  const participant = createResumeLifecycleParticipant(run.deps)
  await participant.setState(WORKSPACE, 'archived', NOW)
  run.clock.advance(25_000)
  t.mock.timers.tick(25_000)
  await flush()
  assert.equal(modelSignal.aborted, true)
  await participant.cancel(WORKSPACE, run.clock.now().toISOString())
  await participant.setState(WORKSPACE, 'active', run.clock.now().toISOString())
  release()
  assert.deepEqual(await processing, { claimed: 1, completed: 0 })
  assert.equal((await run.record(id)).resume.status, 'cancelled')
  assert.equal(await run.blobs.read(resumeProfileBlobName(WORKSPACE, id)), undefined)
})

test('a pre-archive callback cannot publish after restore and an explicit new retry, even under the same worker owner', async () => {
  let release, reached
  let calls = 0
  const started = new Promise(resolve => { reached = resolve })
  const run = fixture({ modelFetch: async body => {
    if (++calls === 1) {
      reached()
      await new Promise(resolve => { release = resolve })
      return modelResponse(body)
    }
    return modelResponse(body, { name: { status: 'unavailable', value: null, citations: [] } })
  } })
  const id = await run.url()
  const first = runResumeWorker(run.deps)
  await started
  const lifecycle = new ResumeLifecycleService(run.deps, undefined, run.clock.now)
  const current = await run.store.get(WORKSPACE, id)
  await lifecycle.change(WORKSPACE, id, 'archive', current.etag)
  const archived = await run.store.get(WORKSPACE, id)
  await lifecycle.change(WORKSPACE, id, 'unarchive', archived.etag)
  const restored = await run.store.get(WORKSPACE, id)
  assert.equal(restored.record.resume.status, 'cancelled')
  await run.service.retry(WORKSPACE, id, restored.etag)
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const winner = await run.store.get(WORKSPACE, id)
  release()
  assert.deepEqual(await first, { claimed: 1, completed: 0 })
  assert.deepEqual(await run.store.get(WORKSPACE, id), winner)
  assert.equal((await run.detail(id)).resume.name, null)
})

test('a heartbeat queued behind successful publication cannot turn its ready count into a lost lease', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const run = fixture()
  const id = await run.url()
  const replace = run.store.replace.bind(run.store)
  let release
  let published
  const saved = new Promise(resolve => { published = resolve })
  run.store.replace = async (record, etag) => {
    const value = await replace(record, etag)
    if (record.resume?.status === 'ready') {
      published()
      await new Promise(resolve => { release = resolve })
    }
    return value
  }
  const processing = runResumeWorker(run.deps)
  await saved
  run.clock.advance(25_000)
  t.mock.timers.tick(25_000)
  release()
  assert.deepEqual(await processing, { claimed: 1, completed: 1 })
  await assertReady(run, id)
})

for (const during of ['download', 'model']) {
  test(`cancellation during ${during} fences every late profile and metadata publication`, async () => {
    let run
    let id
    run = fixture(during === 'download' ? {
      transport: async () => { await run.cancel(id); return http() },
    } : {
      modelFetch: async body => { await run.cancel(id); return modelResponse(body) },
    })
    id = await run.url()
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
    const record = await run.record(id)
    assert.equal(record.resume.status, 'cancelled')
    assert.equal(record.resume.name, null)
    assert.equal(record.error, undefined)
    assert.equal(record.lease, undefined)
    assert.equal(record.attemptId, undefined)
    assert.equal(record.profileBlob, undefined)
    assert.equal(await run.blobs.read(resumeProfileBlobName(WORKSPACE, id)), undefined)
    if (during === 'download') assert.equal(record.capture, undefined)
    else assert.ok(record.extraction)
    parseResumeEntity(record)
  })
}

test('an expired old attempt cannot overwrite a new ready attempt even when both use the same owner', async () => {
  let firstRelease
  let firstReached
  const firstStarted = new Promise(resolve => { firstReached = resolve })
  let calls = 0
  const run = fixture({ modelFetch: async body => {
    calls++
    if (calls === 1) {
      firstReached()
      await new Promise(resolve => { firstRelease = resolve })
      return modelResponse(body)
    }
    return modelResponse(body, { name: { status: 'unavailable', value: null, citations: [] } })
  } })
  const id = await run.url()
  const first = runResumeWorker(run.deps)
  await firstStarted
  const firstAttempt = (await run.record(id)).attemptId
  run.clock.advance(90_001)
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const winner = await run.record(id)
  assert.notEqual(winner.attemptId, firstAttempt)
  assert.equal(winner.resume.name, null)
  firstRelease()
  assert.deepEqual(await first, { claimed: 1, completed: 0 })
  assert.deepEqual(await run.record(id), winner)
  await assertReady(run, id)
  assert.equal(run.requests.public.length, 1)
})

test('three transient automatic attempts back off, stop, and allow only an explicit new manual retry cycle', async () => {
  let healthy = false
  const run = fixture({ transport: async () => healthy ? http() : http('private-marker', 503) })
  const id = await run.url()
  const imported = await run.store.get(WORKSPACE, id)
  await run.service.updateMetadata(WORKSPACE, id, { displayName: 'Keep across all retries' }, imported.etag)
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 0 })
    const record = await run.record(id)
    assert.equal(record.attempts, attempt)
    assert.equal(record.displayName, 'Keep across all retries')
    assert.equal(record.error.code, 'service-unavailable')
    assert.equal(record.error.retryable, true)
    assert.deepEqual(await runResumeWorker(run.deps), { claimed: 0, completed: 0 })
    if (attempt < 3) {
      assert.equal(Date.parse(record.nextAttemptAt) - run.clock.now().getTime(), 15_000 * 2 ** (attempt - 1))
      run.clock.advance(15_000 * 2 ** (attempt - 1))
    } else {
      assert.equal(record.resume.status, 'error')
      assert.equal(record.nextAttemptAt, undefined)
      assert.equal(record.lease, undefined)
      assert.match(record.error.message, /Automatic retry limit reached/)
    }
  }
  const current = await run.store.get(WORKSPACE, id)
  await run.service.retry(WORKSPACE, id, current.etag)
  healthy = true
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 1, completed: 1 })
  const { record } = await assertReady(run, id)
  assert.equal(record.attempts, 1)
  assert.equal(record.retryCount, 1)
  assert.equal(record.displayName, 'Keep across all retries')
})

test('execution budget aborts uncooperative model work and fences late completion', async () => {
  let release
  let reached
  const started = new Promise(resolve => { reached = resolve })
  const run = fixture({ modelFetch: async body => {
    reached()
    await new Promise(resolve => { release = resolve })
    return modelResponse(body)
  } })
  const id = await run.url()
  const keepAlive = sleep(100)
  const processing = runResumeWorker(run.deps, { budgetMilliseconds: 35 })
  await started
  assert.deepEqual(await processing, { claimed: 1, completed: 0 })
  assert.equal((await run.record(id)).error.code, 'timeout')
  assert.equal((await run.record(id)).resume.status, 'queued')
  release()
  await flush()
  await keepAlive
  assert.equal(await run.blobs.read(resumeProfileBlobName(WORKSPACE, id)), undefined)
  assert.equal((await run.record(id)).resume.status, 'queued')
})

test('max-items, pending bounds, and an already stopped host prevent unintended additional work', async () => {
  const run = fixture()
  for (let index = 0; index < 3; index++) await run.url(`https://profiles.example/person-${index}`)
  assert.deepEqual(await runResumeWorker(run.deps, { maxItems: 1, pendingLimit: 2 }), { claimed: 1, completed: 1 })
  assert.equal((await run.store.listPending(run.clock.now().toISOString(), 100)).length, 2)
  assert.deepEqual(await runResumeWorker(run.deps, { signal: AbortSignal.abort() }), { claimed: 0, completed: 0 })
  for (const options of [{ maxItems: 0 }, { maxItems: 21 }, { pendingLimit: 101 }, { budgetMilliseconds: 660_001 }]) {
    await assert.rejects(runResumeWorker(run.deps, options), /execution limits/)
  }
  assert.equal(typeof processClaimedResume, 'function')
})

test('default execution processes five items consistently with the dedicated hosted worker', async () => {
  const run = fixture()
  for (let index = 0; index < 6; index++) await run.url(`https://profiles.example/person-${index}`)
  assert.deepEqual(await runResumeWorker(run.deps), { claimed: 5, completed: 5 })
  assert.equal((await run.store.listPending(run.clock.now().toISOString(), 100)).length, 1)
})
