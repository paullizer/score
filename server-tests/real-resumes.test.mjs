import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { rm } from 'node:fs/promises'
import { build } from 'esbuild'
import express from 'express'
import { PDFDocument } from 'pdf-lib'

const WORKSPACE = 'workspace-one'
const OTHER_WORKSPACE = 'workspace-two'
const TENANT = '228db43d-371a-49d8-864e-fa202d181ea5'
const OWNER = '1d6312bd-3eaa-4586-8b74-e90eee126f78'
const VIEWER = '2f9b6a10-6a3d-4e26-9b8b-2a6f6e9d9a11'
const OUTSIDER = '9c9c9c9c-9c9c-49c9-8c9c-9c9c9c9c9c9c'
const ORIGIN = 'https://resume-api.example.test'
const NOW = '2026-09-18T02:30:00.000Z'
const MAX_PDF = 10 * 1024 * 1024
const MAX_MARKDOWN = 10 * 1024 * 1024
const clone = value => structuredClone(value)
const output = join(process.cwd(), 'dist-server', `real-resumes-isolated-tests-${process.pid}.mjs`)
let api
let pdfBytes

before(async () => {
  await build({
    stdin: {
      contents: [
        "export * from './server/resumes/routes';",
        "export * from './server/resumes/service';",
        "export * from './server/resumes/validation';",
        "export * from './server/resumes/azure-store';",
        "export * from './server/errors';",
        "export * from './server/store';",
        "export * from './server/ids';",
        "export * from './server/middleware';",
        "export {WorkspaceRepository} from './server/repository';",
      ].join('\n'),
      resolveDir: process.cwd(), loader: 'ts',
    },
    outfile: output, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  })
  api = await import(pathToFileURL(output).href)
  pdfBytes = await pdf(1)
})
after(async () => { await rm(output, { force: true }) })

async function pdf(pages, title = 'Synthetic resume API test') {
  const document = await PDFDocument.create()
  document.setTitle(title)
  document.setCreationDate(new Date(NOW))
  document.setModificationDate(new Date(NOW))
  for (let index = 0; index < pages; index++) document.addPage([612, 792])
  return Buffer.from(await document.save({ useObjectStreams: false }))
}

function fakeBlobContainer(events) {
  const values = new Map()
  let next = 0
  let failure
  let override
  return {
    values,
    fail(callback) { failure = callback },
    override(callback) { override = callback },
    getBlockBlobClient(name) {
      return {
        async download() {
          const value = values.get(name)
          if (!value) throw Object.assign(new Error('Missing blob'), { statusCode: 404 })
          const response = {
            readableStreamBody: Readable.from([Buffer.from(value.bytes)]),
            contentLength: value.bytes.length, contentType: value.contentType, etag: value.etag,
          }
          return override ? override(response, name) : response
        },
        async upload(bytes, length, options) {
          assert.equal(length, bytes.byteLength)
          assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
          if (values.has(name)) throw Object.assign(new Error('Already exists'), { statusCode: 412 })
          const blob = {
            bytes: Buffer.from(bytes), contentType: options.blobHTTPHeaders.blobContentType,
            etag: `"blob-${++next}"`,
          }
          if (failure) {
            const callback = failure
            failure = undefined
            callback({ name, blob, values })
          }
          values.set(name, blob)
          events.push({ kind: 'blob', name })
          return { etag: blob.etag }
        },
      }
    },
  }
}

function fakeCosmosContainer(events, blobValues) {
  const values = new Map()
  const queries = []
  const batches = []
  const replacements = []
  const creates = []
  let next = 0
  let race
  let responseOverride
  let queryOverride
  let failBefore = false
  let failAfter = false
  let suppressBody = false
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  const save = record => {
    const value = {
      ...clone(record), _etag: `"cosmos-${++next}"`, _rid: 'rid', _self: 'self', _attachments: 'attachments', _ts: 1000,
    }
    values.set(key(record.workspaceId, record.id), value)
    return clone(value)
  }
  return {
    values, queries, batches, replacements, creates, save, key,
    race(callback) { race = callback },
    response(callback) { responseOverride = callback },
    queryResponse(callback) { queryOverride = callback },
    failBefore() { failBefore = true },
    failAfter() { failAfter = true },
    suppressBody(value = true) { suppressBody = value },
    item(id, workspaceId) {
      return {
        async read() {
          const value = values.get(key(workspaceId, id))
          return { statusCode: value ? 200 : 404, resource: clone(value) }
        },
        async replace(record, options) {
          replacements.push({ record: clone(record), options: clone(options) })
          const current = values.get(key(workspaceId, id))
          if (!current || current._etag !== options.accessCondition?.condition) {
            throw Object.assign(new Error('Precondition failed'), { code: 412 })
          }
          const resource = save(record)
          return { statusCode: 200, ...(suppressBody ? {} : { resource }) }
        },
      }
    },
    items: {
      async create(record) {
        creates.push(clone(record))
        if (values.has(key(record.workspaceId, record.id))) throw Object.assign(new Error('Duplicate'), { code: 409 })
        const resource = save(record)
        return { statusCode: 201, ...(suppressBody ? {} : { resource }) }
      },
      query(spec, options) {
        queries.push({ spec: clone(spec), options: clone(options) })
        const parameter = name => spec.parameters.find(item => item.name === name)?.value
        const filtered = () => {
          const now = parameter('@now')
          return [...values.values()].filter(record =>
            (!options?.partitionKey || record.workspaceId === options.partitionKey) &&
            record.recordType === parameter('@recordType') &&
            (!parameter('@batchId') || record.batchId === parameter('@batchId')) &&
            (!parameter('@status') || record.resume?.status === parameter('@status')) &&
            (!now || ((!record.nextAttemptAt || record.nextAttemptAt <= now) &&
              (record.resume?.status === 'queued' && !record.lease ||
                ['parsing', 'profiling'].includes(record.resume?.status) && record.lease?.expiresAt <= now))))
            .sort((a, b) => now ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt))
        }
        return {
          async fetchNext() {
            const all = filtered()
            const offset = Number(options?.continuationToken ?? '0')
            const count = options?.maxItemCount ?? 100
            const result = {
              resources: all.slice(offset, offset + count).map(clone),
              ...(offset + count < all.length ? { continuationToken: String(offset + count) } : {}),
            }
            return queryOverride ? queryOverride(result) : result
          },
          async fetchAll() {
            const result = { resources: filtered().slice(0, parameter('@limit') ?? 100).map(clone) }
            return queryOverride ? queryOverride(result) : result
          },
        }
      },
      async batch(operations, workspaceId, options) {
        batches.push({ operations: clone(operations), workspaceId, options: clone(options) })
        assert.deepEqual(options, { contentResponseOnWriteEnabled: false })
        if (race) { const callback = race; race = undefined; callback() }
        if (failBefore) { failBefore = false; throw new Error('Transient publication failure before commit') }
        if (responseOverride) return responseOverride(operations)
        const statuses = operations.map(operation => {
          const current = values.get(key(workspaceId, operation.resourceBody.id))
          return operation.operationType === 'Create' ? current ? 409 : 201
            : !current ? 404 : current._etag !== operation.ifMatch ? 412 : 200
        })
        const failure = statuses.findIndex(code => code >= 400)
        if (failure !== -1) return {
          code: 207, result: statuses.map((statusCode, index) => ({ statusCode: index === failure ? statusCode : 424 })),
        }
        for (const operation of operations) {
          const record = operation.resourceBody
          if (record.recordType === 'resume' && operation.operationType === 'Create' && blobValues) {
            assert.ok(blobValues.has(api.resumeImportReceiptBlobName(workspaceId, record.id)), 'immutable receipt must precede queue publication')
            if (record.source.kind !== 'url') {
              assert.ok(blobValues.has(record.capture.original.blobName), 'original bytes must precede eligible work')
              assert.ok(blobValues.has(record.captureManifest.blobName), 'capture manifest must precede eligible work')
            }
          }
        }
        const result = operations.map((operation, index) => ({
          statusCode: statuses[index], eTag: save(operation.resourceBody)._etag,
        }))
        events.push({ kind: 'transaction', ids: operations.map(operation => operation.resourceBody.id) })
        if (failAfter) { failAfter = false; throw new Error('Successful publication response lost') }
        return { code: 200, result }
      },
    },
  }
}

function dependencies() {
  const events = []
  const blobContainer = fakeBlobContainer(events)
  const cosmos = fakeCosmosContainer(events, blobContainer.values)
  const deps = {
    store: api.createResumeStoreFromContainer(cosmos),
    blobs: api.createResumeBlobStoreFromContainer(blobContainer),
  }
  return { ...deps, deps, events, blobContainer, cosmos }
}

function auth(oid = OWNER) {
  return {
    'x-ms-client-principal': Buffer.from(JSON.stringify({
      auth_typ: 'aad', claims: [{ typ: 'tid', val: TENANT }, { typ: 'oid', val: oid }, { typ: 'name', val: 'API test user' }],
      name_typ: 'name', role_typ: 'roles',
    })).toString('base64'),
  }
}

function headers({ oid = OWNER, write = true, ...extra } = {}) {
  return { ...auth(oid), ...(write ? { origin: ORIGIN, 'x-score-request': 'workspace' } : {}), ...extra }
}

async function fixture(options = {}) {
  const resumes = dependencies()
  const errors = []
  let clock = NOW
  let sampleCalls = 0
  const actor = oid => `${TENANT}:${oid}`
  const memberships = new Map()
  for (const [workspaceId, oid, role] of [
    [WORKSPACE, OWNER, 'owner'], [WORKSPACE, VIEWER, 'viewer'], [OTHER_WORKSPACE, OUTSIDER, 'owner'],
  ]) {
    const principalId = actor(oid)
    const membership = {
      id: api.membershipIdFor(principalId), workspaceId, principalId, principalType: 'user', role,
    }
    memberships.set(`${workspaceId}/${membership.id}`, membership)
  }
  const directory = {
    async getMetadata(workspaceId) {
      return [WORKSPACE, OTHER_WORKSPACE].includes(workspaceId) ? {
        metadata: { id: 'workspace', workspaceId, tenantId: TENANT }, etag: '"workspace-etag"',
      } : undefined
    },
    async getMembership(workspaceId, id) { return clone(memberships.get(`${workspaceId}/${id}`)) },
  }
  const state = new Proxy({}, { get() { sampleCalls++; throw new Error('Real resume APIs must not touch sample persistence') } })
  const now = () => new Date(clock)
  const repository = new api.WorkspaceRepository({ directory, state, now })
  const config = {
    authMode: 'easyauth', tenantId: TENANT, allowedUserIds: new Set([OWNER, VIEWER, OUTSIDER]), appOrigin: ORIGIN,
  }
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '10mb' }))
  const router = express.Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.use(api.createAuthMiddleware(config), api.createCsrfMiddleware(config))
  router.use(api.createRealResumesRouter({ repository, resumes: options.disabled ? undefined : resumes.deps, now }))
  app.use('/api', router)
  app.use((error, _req, res, _next) => {
    if (error instanceof api.HttpError) return res.status(error.status).json(api.toCloudApiError(error))
    if (error?.type === 'entity.too.large') return res.status(413).json(api.toCloudApiError(api.invalidRequest('Body too large.')))
    if (error?.type) return res.status(400).json(api.toCloudApiError(api.invalidRequest('Invalid request body.')))
    errors.push(error)
    res.status(503).json(api.toCloudApiError(api.unavailable()))
  })
  const server = createServer(app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${server.address().port}/api/workspaces`
  return {
    ...resumes, errors, now, base, service: new api.RealResumeService(resumes.deps, now),
    advance(value) { clock = value },
    path(workspaceId = WORKSPACE) { return `${base}/${workspaceId}/resumes` },
    async close() { assert.equal(sampleCalls, 0); await new Promise(resolve => server.close(resolve)) },
  }
}

const input = (overrides = {}) => ({
  idempotencyKey: randomUUID(), batchId: randomUUID(), inputCount: 1, createdBy: `${TENANT}:${OWNER}`, ...overrides,
})

async function importPdf(server, options = {}) {
  const request = input(options.input)
  return fetch(`${server.path(options.workspaceId)}/pdf`, {
    method: 'POST',
    headers: headers({
      oid: options.oid,
      'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(options.filename ?? 'resume.pdf'),
      'idempotency-key': request.idempotencyKey, 'x-import-batch': request.batchId, 'x-import-count': String(request.inputCount),
      ...options.headers,
    }),
    body: options.bytes ?? pdfBytes,
  })
}

async function importMarkdown(server, options = {}) {
  const request = input(options.input)
  return fetch(`${server.path(options.workspaceId)}/markdown`, {
    method: 'POST',
    headers: headers({
      oid: options.oid,
      'content-type': 'text/markdown', 'x-file-name': encodeURIComponent(options.filename ?? 'resume.md'),
      'idempotency-key': request.idempotencyKey, 'x-import-batch': request.batchId, 'x-import-count': String(request.inputCount),
      ...options.headers,
    }),
    body: options.bytes ?? Buffer.from('# Alex Example\n\nEngineer based in Portland.\n'),
  })
}

async function importUrl(server, options = {}) {
  const request = input(options.input)
  return fetch(`${server.path(options.workspaceId)}/url`, {
    method: 'POST',
    headers: headers({
      oid: options.oid, 'content-type': 'application/json', 'idempotency-key': request.idempotencyKey,
      'x-import-batch': request.batchId, 'x-import-count': String(request.inputCount), ...options.headers,
    }),
    body: JSON.stringify(options.body ?? { url: options.url ?? 'https://example.com/resume' }),
  })
}

async function action(server, id, operation, etag, body, extra = {}) {
  return fetch(`${server.path()}/${id}/${operation}`, {
    method: 'POST',
    headers: headers({ ...(etag ? { 'if-match': etag } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function bodyOf(response, expectedStatus) {
  const body = await response.json()
  assert.equal(response.status, expectedStatus, JSON.stringify(body))
  return body
}

async function putJson(server, name, value) {
  const result = await server.blobs.putImmutable(name, Buffer.from(JSON.stringify(value)), 'application/json')
  return { ...api.resumeBlobReference(name, result.blob), contentType: 'application/json' }
}

async function captureHtml(server, id) {
  const current = await server.store.get(WORKSPACE, id)
  const { record } = current
  const name = api.resumeOriginalBlobName(WORKSPACE, id, 'html')
  const bytes = Buffer.from('<html><script>throw new Error("never execute source")</script><body>Synthetic source</body></html>')
  const original = await server.blobs.putImmutable(name, bytes, 'text/html')
  const capture = {
    original: api.resumeBlobReference(name, original.blob), capturedAt: NOW, finalUrl: record.source.url, redirects: [],
  }
  const captureManifest = await putJson(server, api.resumeCaptureBlobName(WORKSPACE, id), {
    schemaVersion: 1, dataKind: 'real', workspaceId: WORKSPACE, resumeId: id,
    inputFingerprint: record.inputFingerprint, source: record.source, capture,
  })
  await server.store.replace({ ...record, capture, captureManifest }, current.etag)
  return bytes
}

async function profileResume(server, id, status = 'ready', page = 1) {
  const current = await server.store.get(WORKSPACE, id)
  const record = current.record
  const document = {
    id: record.resume.documentId, title: 'Captured resume', kind: 'resume', version: 1, sample: false,
    paragraphs: [{ id: 'p-1', page, heading: 'Profile', text: 'Alex Example. Engineer. Portland. Ten years of engineering experience.' }],
  }
  const documentRef = await putJson(server, api.resumeDocumentBlobName(WORKSPACE, id), document)
  const format = {
    'application/pdf': { method: 'document-intelligence', pagination: 'pdf-pages', pageCount: 1 },
    'text/html': { method: 'html', pagination: 'html-sections', pageCount: null },
    'text/markdown': { method: 'markdown', pagination: 'markdown-sections', pageCount: null },
  }[record.capture.original.contentType]
  const extraction = {
    ...format,
    version: 'resume-extraction-v1', extractedAt: NOW,
    normalizedCharacters: document.paragraphs[0].heading.length + document.paragraphs[0].text.length,
    document: { ...documentRef, documentId: document.id, documentVersion: document.version },
  }
  const field = value => ({
    status: 'available', value, citations: [{
      documentId: document.id, documentVersion: 1, paragraphId: 'p-1', page, heading: 'Profile', quote: value,
    }],
  })
  const profile = {
    schemaVersion: 1, dataKind: 'real', workspaceId: WORKSPACE, resumeId: id, documentId: document.id,
    documentVersion: 1, documentSha256: documentRef.sha256,
    name: field('Alex Example'), role: field('Engineer'), location: field('Portland'),
    experience: { status: 'unavailable', value: null, citations: [] },
    provenance: { model: 'test-model', promptVersion: 'profile-v1', schemaVersion: '1', extractedAt: NOW },
  }
  const profileBlob = await putJson(server, api.resumeProfileBlobName(WORKSPACE, id), profile)
  const result = {
    ...record, extraction, profileBlob,
    resume: { ...record.resume, status, name: 'Alex Example', role: 'Engineer', location: 'Portland' },
    attempts: 1, attemptId: randomUUID(),
  }
  delete result.nextAttemptAt
  if (status === 'ready') result.completedAt = NOW
  else result.lease = { owner: 'worker', heartbeatAt: NOW, expiresAt: '2026-09-18T02:35:00.000Z' }
  const saved = await server.store.replace(result, current.etag)
  return { ...saved, profile, document }
}

test('actual PDF bytes, receipts, and captures are durable before atomic admission; metadata starts unavailable', async () => {
  const server = await fixture()
  try {
    const request = input()
    const response = await importPdf(server, { input: request, filename: 'Résumé candidate.pdf' })
    const { resume: accepted } = await bodyOf(response, 202)
    assert.equal(accepted.resume.id, `resume-${request.idempotencyKey}`)
    assert.equal(accepted.resume.documentId, `document-${request.idempotencyKey}`)
    assert.equal(accepted.resume.status, 'queued')
    assert.deepEqual(['name', 'role', 'location', 'experience'].map(field => accepted.resume[field]), [null, null, null, null])
    assert.equal(accepted.documentRef, null)
    assert.equal(accepted.source.fileName, 'Résumé candidate.pdf')
    assert.equal(response.headers.get('etag'), accepted.etag)
    assert.deepEqual(server.events.map(event => event.kind), ['blob', 'blob', 'blob', 'transaction'])
    const raw = server.blobContainer.values.get(accepted.capture.original.blobName)
    assert.deepEqual(raw.bytes, pdfBytes)
    assert.equal(accepted.capture.original.sha256, api.resumeSha256(pdfBytes))
    const replay = await bodyOf(await importPdf(server, { input: request, filename: 'Résumé candidate.pdf' }), 200)
    assert.equal(replay.resume.resume.id, accepted.resume.id)
    assert.equal(server.blobContainer.values.size, 3)
    assert.equal(server.cosmos.values.size, 2)
    const detailResponse = await fetch(`${server.path()}/${accepted.resume.id}`, { headers: headers({ write: false }) })
    const detail = await bodyOf(detailResponse, 200)
    assert.equal(detail.resume.id, accepted.resume.id, 'details are not wrapped in another resume field')
    assert.equal(detail.document, null)
    assert.equal(detail.profile, null)
    assert.match(detailResponse.headers.get('cache-control'), /no-store/)
    const original = await fetch(`${server.path()}/${accepted.resume.id}/original`, { headers: auth() })
    assert.equal(original.status, 200)
    assert.match(original.headers.get('content-disposition'), /^attachment;/)
    assert.match(original.headers.get('content-disposition'), /filename\*=UTF-8''R%C3%A9sum%C3%A9/)
    assert.equal(original.headers.get('content-type'), 'application/pdf')
    assert.equal(original.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), pdfBytes)
  } finally { await server.close() }
})

test('Markdown resume imports preserve both extensions, original UTF-8 bytes and immutable provenance before atomic batch publication', async () => {
  const server = await fixture()
  try {
    for (const filename of ['resume.md', 'resume.MD', 'Résumé candidate.markdown', "Résumé candidate's.MARKDOWN"]) {
      const request = input()
      const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Alex Example\r\n\r\nEngineer.\tCafé 😀\r\n')])
      const response = await importMarkdown(server, {
        input: request, filename, bytes, headers: { 'content-type': 'text/markdown; charset="UTF-8"', 'content-encoding': 'identity' },
      })
      const { resume: accepted } = await bodyOf(response, 202)
      const id = api.resumeIdForKey(request.idempotencyKey)
      assert.equal(accepted.resume.id, id)
      assert.equal(accepted.resume.status, 'queued')
      assert.equal(response.headers.get('etag'), accepted.etag)
      assert.deepEqual(accepted.source, { kind: 'markdown', displayName: filename, fileName: filename })
      assert.deepEqual(['name', 'role', 'location', 'experience'].map(field => accepted.resume[field]), [null, null, null, null])
      assert.equal(accepted.capture.original.blobName, `${WORKSPACE}/${id}/original.md`)
      assert.equal(accepted.capture.original.contentType, 'text/markdown')
      assert.equal(accepted.capture.original.sha256, api.resumeSha256(bytes))
      assert.equal(accepted.capture.original.bytes, bytes.byteLength)
      assert.equal(accepted.capture.finalUrl, undefined)
      assert.deepEqual(accepted.capture.redirects, [])
      assert.deepEqual(server.events.slice(-4).map(event => event.kind), ['blob', 'blob', 'blob', 'transaction'])
      const receipt = JSON.parse(server.blobContainer.values.get(api.resumeImportReceiptBlobName(WORKSPACE, id)).bytes.toString('utf8'))
      assert.equal(receipt.markdownSha256, api.resumeSha256(bytes))
      assert.equal(Object.hasOwn(receipt, 'pdfSha256'), false)
      assert.equal(receipt.inputFingerprint, api.resumeContentHash({
        source: accepted.source, batchId: request.batchId, inputCount: request.inputCount,
        createdBy: request.createdBy, markdownSha256: api.resumeSha256(bytes),
      }))
      const original = await fetch(`${server.path()}/${id}/original`, { headers: auth() })
      assert.equal(original.status, 200)
      assert.equal(original.headers.get('content-type'), 'text/markdown')
      assert.match(original.headers.get('content-disposition'), /^attachment;/)
      assert.equal(decodeURIComponent(original.headers.get('content-disposition').split("filename*=UTF-8''")[1]), filename)
      assert.equal(original.headers.get('x-content-type-options'), 'nosniff')
      assert.match(original.headers.get('content-security-policy'), /sandbox; default-src 'none'/)
      assert.equal(original.headers.get('referrer-policy'), 'no-referrer')
      assert.match(original.headers.get('cache-control'), /private, no-store/)
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
      const replay = (await bodyOf(await importMarkdown(server, { input: request, filename, bytes }), 200)).resume
      assert.equal(replay.etag, accepted.etag)
      assert.equal((await server.store.get(WORKSPACE, api.resumeBatchRecordId(request.batchId))).record.items.length, 1)
    }
    assert.equal(api.isSafeResumeFilename('resume.md'), false, 'legacy helper callers must remain PDF-only by default')
    assert.equal(api.isSafeResumeFilename('resume.MARKDOWN', 'markdown'), true)
    assert.equal(api.isSafeResumeFilename('resume.PDF'), true)
  } finally { await server.close() }
})

test('Markdown resume metadata, UTF-8, binary controls, empty inputs, compressed bodies, and 10 MiB byte limits are strictly validated', async () => {
  const server = await fixture()
  try {
    for (const filename of [
      '../resume.md', 'x\\resume.markdown', 'resume.pdf', 'resume.md.exe', 'x:resume.md', 'NUL.markdown',
      'resume\u0085.md', ' resume.md', 'resume.md ', 'x'.repeat(256) + '.md',
    ]) await bodyOf(await importMarkdown(server, { filename }), 400)
    for (const headers of [
      { 'x-file-name': '' }, { 'x-file-name': '%ZZ.md' }, { 'x-file-name': 'not encoded.md' }, { 'x-file-name': '%ED%A0%80.md' },
      { 'content-type': 'text/plain' }, { 'content-type': 'application/pdf' },
      { 'content-type': 'text/markdown; charset=utf-16' }, { 'content-type': 'text/markdown; charset=iso-8859-1' },
      { 'content-type': 'text/markdown; unexpected=value' },
      { 'content-encoding': 'gzip' }, { 'content-encoding': 'br' }, { 'content-encoding': 'deflate' },
    ]) await bodyOf(await importMarkdown(server, { headers }), 400)
    for (const name of ['idempotency-key', 'x-import-batch']) {
      for (const value of ['', 'not-a-uuid', `${randomUUID()}, ${randomUUID()}`]) {
        await bodyOf(await importMarkdown(server, { headers: { [name]: value } }), 400)
      }
    }
    for (const count of ['', '0', '11', '-1', '01', '1.0', '1e1', '1, 2']) {
      await bodyOf(await importMarkdown(server, { headers: { 'x-import-count': count } }), 400)
    }
    for (const bytes of [
      Buffer.alloc(0), Buffer.from(' \t\r\n'), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xc3, 0x28]),
      Buffer.from('# Resume', 'utf16le'), Buffer.from('# Resume\0binary'), Buffer.from('# Resume\u0085binary'),
      Buffer.from('# Resume\u0001binary'), Buffer.from('# Resume\fbinary'), Buffer.from('%PDF-1.7\nnot Markdown'),
      Buffer.from([0xff, 0xfe, 0x41, 0x00]),
    ]) await bodyOf(await importMarkdown(server, { bytes }), 400)
    const oversized = await bodyOf(await importMarkdown(server, { bytes: Buffer.alloc(MAX_MARKDOWN + 1, 'x') }), 413)
    assert.match(oversized.error.message, /10 MiB/)
    assert.equal(server.blobContainer.values.size, 0)
    assert.equal(server.cosmos.values.size, 0)
    const bytes = Buffer.alloc(MAX_MARKDOWN, 'x')
    const accepted = (await bodyOf(await importMarkdown(server, { bytes }), 202)).resume
    assert.equal(accepted.capture.original.bytes, MAX_MARKDOWN)
    assert.deepEqual(server.blobContainer.values.get(accepted.capture.original.blobName).bytes, bytes)
    await assert.rejects(server.service.importMarkdown(WORKSPACE, input(), 'resume.md', Buffer.alloc(MAX_MARKDOWN + 1, 'x')),
      error => error instanceof api.HttpError && error.status === 413)
    await assert.rejects(server.service.importMarkdown(WORKSPACE, input(), 'resume.md', Buffer.from([0x80])),
      error => error instanceof api.HttpError && error.status === 400 && /UTF-8/.test(error.message))
  } finally { await server.close() }
})

test('Markdown resume authentication, CSRF, workspace access, read-only membership and disabled service checks precede raw parsing', async () => {
  const server = await fixture()
  try {
    const bytes = Buffer.alloc(MAX_MARKDOWN + 1, 'x')
    assert.equal((await fetch(`${server.path()}/markdown`, {
      method: 'POST', headers: { 'content-type': 'text/markdown' }, body: bytes,
    })).status, 401)
    assert.equal((await importMarkdown(server, { bytes, oid: VIEWER })).status, 403)
    assert.equal((await importMarkdown(server, { bytes, oid: OUTSIDER })).status, 404)
    assert.equal((await importMarkdown(server, { bytes, headers: { origin: 'https://foreign.example' } })).status, 403)
    assert.equal((await importMarkdown(server, { bytes, headers: { 'x-score-request': '' } })).status, 403)
    assert.equal(server.blobContainer.values.size, 0)
    const initial = (await bodyOf(await importMarkdown(server), 202)).resume
    for (const suffix of ['', `/${initial.resume.id}`, `/${initial.resume.id}/original`]) {
      assert.equal((await fetch(`${server.path()}${suffix}`, { headers: auth(VIEWER) })).status, 200)
      assert.equal((await fetch(`${server.path()}${suffix}`, { headers: auth(OUTSIDER) })).status, 404)
    }
    assert.equal((await action(server, initial.resume.id, 'cancel', initial.etag, undefined, { ...auth(VIEWER) })).status, 403)
    assert.equal((await fetch(`${server.path(OTHER_WORKSPACE)}/${initial.resume.id}/original`, { headers: auth(OUTSIDER) })).status, 404)
  } finally { await server.close() }
  const disabled = await fixture({ disabled: true })
  try {
    assert.equal((await importMarkdown(disabled, { bytes: Buffer.alloc(MAX_MARKDOWN + 1, 'x') })).status, 503)
    assert.equal(disabled.blobContainer.values.size, 0)
  } finally { await disabled.close() }
})

test('Markdown receipt replay survives failed publication and binds source bytes, filename, batch, count, actor, and kind without overwrites', async () => {
  const server = await fixture()
  try {
    const request = input()
    server.cosmos.failBefore()
    await bodyOf(await importMarkdown(server, { input: request }), 503)
    assert.equal(server.blobContainer.values.size, 3)
    assert.equal(server.cosmos.values.size, 0)
    const winners = [...server.blobContainer.values.entries()].map(([name, blob]) => [name, Buffer.from(blob.bytes)])
    for (const options of [
      { filename: 'changed.md' }, { filename: 'resume.markdown' }, { bytes: Buffer.from('# Changed profile\n') },
      { input: { ...request, batchId: randomUUID() } }, { input: { ...request, inputCount: 2 } },
    ]) await bodyOf(await importMarkdown(server, { input: request, ...options }), 409)
    await bodyOf(await importPdf(server, { input: request }), 409)
    await bodyOf(await importUrl(server, { input: request }), 409)
    await assert.rejects(server.service.importMarkdown(WORKSPACE, { ...request, createdBy: 'different-actor' }, 'resume.md',
      Buffer.from('# Alex Example\n\nEngineer based in Portland.\n')), error => error instanceof api.HttpError && error.status === 409)
    server.advance('2026-09-18T02:31:00.000Z')
    const recovered = (await bodyOf(await importMarkdown(server, { input: request }), 202)).resume
    assert.equal(recovered.resume.createdAt, NOW)
    assert.equal(recovered.capture.capturedAt, NOW)
    await bodyOf(await importMarkdown(server, { input: request }), 200)
    for (const [name, bytes] of winners) assert.deepEqual(server.blobContainer.values.get(name).bytes, bytes)
    assert.equal((await server.store.get(WORKSPACE, api.resumeBatchRecordId(request.batchId))).record.items.length, 1)
    const racing = input()
    const alternatives = [Buffer.from('# First profile\n'), Buffer.from('# Second profile\n')]
    const outcomes = await Promise.all(alternatives.map(bytes => importMarkdown(server, { input: racing, bytes })))
    assert.deepEqual(outcomes.map(response => response.status).sort(), [202, 409])
    const winner = outcomes.findIndex(response => response.status === 202)
    const record = (await server.store.get(WORKSPACE, api.resumeIdForKey(racing.idempotencyKey))).record
    assert.deepEqual(server.blobContainer.values.get(record.capture.original.blobName).bytes, alternatives[winner])
  } finally { await server.close() }
})

test('legacy PDF and URL receipts retain their original fingerprints and exact field sets when replayed after Markdown support', async () => {
  const server = await fixture()
  try {
    for (const kind of ['pdf', 'url']) {
      const request = input()
      const source = kind === 'pdf'
        ? { kind: 'pdf', displayName: 'resume.pdf', fileName: 'resume.pdf' }
        : { kind: 'url', displayName: 'https://example.com/resume', url: 'https://example.com/resume' }
      const pdfSha256 = kind === 'pdf' ? api.resumeSha256(pdfBytes) : undefined
      const fingerprint = api.resumeContentHash({
        source, batchId: request.batchId, inputCount: request.inputCount, createdBy: request.createdBy, pdfSha256,
      })
      const id = api.resumeIdForKey(request.idempotencyKey)
      const receipt = {
        ...request, schemaVersion: 1, dataKind: 'real', workspaceId: WORKSPACE, resumeId: id,
        createdAt: NOW, source, inputFingerprint: fingerprint, ...(pdfSha256 ? { pdfSha256 } : {}),
      }
      const name = api.resumeImportReceiptBlobName(WORKSPACE, id)
      const originalBytes = Buffer.from(JSON.stringify(receipt))
      await server.blobs.putImmutable(name, originalBytes, 'application/json')
      server.advance('2026-09-18T02:31:00.000Z')
      const submit = kind === 'pdf' ? importPdf : importUrl
      const accepted = (await bodyOf(await submit(server, { input: request }), 202)).resume
      assert.equal(accepted.resume.createdAt, NOW)
      const record = (await server.store.get(WORKSPACE, id)).record
      assert.equal(record.inputFingerprint, fingerprint)
      assert.deepEqual(server.blobContainer.values.get(name).bytes, originalBytes)
      await bodyOf(await submit(server, { input: request }), 200)
      assert.deepEqual(JSON.parse(server.blobContainer.values.get(name).bytes.toString('utf8')), receipt)
      if (kind === 'pdf') assert.equal(JSON.parse(originalBytes.toString('utf8')).pdfSha256, api.resumeSha256(pdfBytes))
      assert.equal(Object.hasOwn(JSON.parse(originalBytes.toString('utf8')), 'markdownSha256'), false)
    }
  } finally { await server.close() }
})

test('mixed PDF and Markdown resume batches share admission limits and keep same-content imports separate with scoped duplicate warnings', async () => {
  const server = await fixture()
  try {
    const batchId = randomUUID()
    const firstInput = input({ batchId, inputCount: 3 })
    const first = (await bodyOf(await importPdf(server, { input: firstInput }), 202)).resume
    await bodyOf(await importMarkdown(server, { input: { batchId, inputCount: 3 }, bytes: Buffer.from([0x80]) }), 400)
    const markdownInput = input({ batchId, inputCount: 3 })
    const second = (await bodyOf(await importMarkdown(server, { input: markdownInput }), 202)).resume
    assert.deepEqual(second.duplicates, [])
    const third = (await bodyOf(await importMarkdown(server, { input: { batchId, inputCount: 3 }, filename: 'renamed.MARKDOWN' }), 202)).resume
    assert.deepEqual(third.duplicates.map(warning => [warning.kind, warning.resumeId]), [['exact-content', second.resume.id]])
    assert.notEqual(third.resume.id, second.resume.id)
    await bodyOf(await importPdf(server, { input: firstInput }), 200)
    await bodyOf(await importMarkdown(server, { input: markdownInput }), 200)
    await bodyOf(await importMarkdown(server, { input: { batchId, inputCount: 3 } }), 409)
    await bodyOf(await importMarkdown(server, { input: { batchId, inputCount: 4 } }), 409)
    assert.equal((await server.store.get(WORKSPACE, api.resumeBatchRecordId(batchId))).record.items.length, 3)
    const detail = await server.service.detail(WORKSPACE, second.resume.id)
    assert.deepEqual(detail.duplicates.map(warning => [warning.kind, warning.resumeId]), [['exact-content', third.resume.id]])
    const foreign = (await bodyOf(await importMarkdown(server, { workspaceId: OTHER_WORKSPACE, oid: OUTSIDER }), 202)).resume
    assert.deepEqual(foreign.duplicates, [])
    assert.equal((await server.service.detail(WORKSPACE, first.resume.id)).duplicates.length, 0)
    const fullBatch = randomUUID()
    const outcomes = await Promise.all(Array.from({ length: 11 }, (_, index) =>
      (index % 2 ? importPdf : importMarkdown)(server, { input: { batchId: fullBatch, inputCount: 10 } })))
    assert.equal(outcomes.filter(response => response.status === 202).length, 10)
    assert.equal(outcomes.filter(response => response.status === 409).length, 1)
    const admitted = (await server.store.get(WORKSPACE, api.resumeBatchRecordId(fullBatch))).record.items
    assert.equal(admitted.length, 10)
    const kinds = await Promise.all(admitted.map(async item => (await server.store.get(WORKSPACE, item.resumeId)).record.source.kind))
    assert.deepEqual([...new Set(kinds)].sort(), ['markdown', 'pdf'])
  } finally { await server.close() }
})

test('Markdown captures require matching extraction method and section provenance, reject URL capture substitution, and do not use PDF page limits', async () => {
  const server = await fixture()
  try {
    const initial = (await bodyOf(await importMarkdown(server), 202)).resume
    const ready = await profileResume(server, initial.resume.id, 'ready', 75)
    const detail = await server.service.detail(WORKSPACE, initial.resume.id)
    assert.equal(detail.document.paragraphs[0].page, 75)
    assert.equal(detail.extraction.method, 'markdown')
    assert.equal(detail.extraction.pagination, 'markdown-sections')
    assert.equal(detail.extraction.pageCount, null)
    assert.deepEqual(api.validateResumeDocumentBinding(ready.document, ready.record), [])
    for (const mutate of [
      value => { value.extraction.method = 'html' },
      value => { value.extraction.method = 'document-intelligence' },
      value => { value.extraction.pagination = 'pdf-pages' },
      value => { value.extraction.pagination = 'html-sections' },
      value => { value.extraction.pageCount = 1 },
      value => { value.capture.original.contentType = 'application/pdf' },
      value => { value.capture.original.contentType = 'text/html' },
      value => { value.capture.finalUrl = 'https://example.com/resume.md' },
      value => { value.capture.redirects = ['https://example.com/resume.md'] },
      value => { delete value.capture; delete value.captureManifest },
    ]) {
      const invalid = clone(ready.record)
      mutate(invalid)
      assert.throws(() => api.parseResumeEntity(invalid))
    }
    const source = { kind: 'url', url: 'https://example.com/resume.md', displayName: 'https://example.com/resume.md' }
    assert.throws(() => api.parseResumeCaptureManifest({
      schemaVersion: 1, dataKind: 'real', workspaceId: WORKSPACE, resumeId: initial.resume.id,
      inputFingerprint: ready.record.inputFingerprint, source,
      capture: { ...ready.record.capture, finalUrl: source.url },
    }), /PDF or HTML/)
    const urlRecord = {
      ...ready.record, source, resume: { ...ready.record.resume, sourceLabel: source.displayName },
      capture: { ...ready.record.capture, finalUrl: source.url },
    }
    assert.throws(() => api.parseResumeEntity(urlRecord), /PDF or HTML/)
    const raw = server.blobContainer.values.get(ready.record.capture.original.blobName)
    raw.contentType = 'text/html'
    assert.equal((await fetch(`${server.path()}/${initial.resume.id}/original`, { headers: auth() })).status, 503)
  } finally { await server.close() }
})

test('raw upload authorization, read-only membership, foreign workspace isolation, and CSRF precede PDF parsing', async () => {
  const server = await fixture()
  try {
    const large = Buffer.alloc(MAX_PDF + 1)
    const unauthenticated = await fetch(`${server.path()}/pdf`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: large,
    })
    assert.equal(unauthenticated.status, 401)
    assert.equal((await importPdf(server, { oid: VIEWER, bytes: large })).status, 403)
    assert.equal((await importPdf(server, { oid: OUTSIDER, bytes: large })).status, 404)
    assert.equal((await importPdf(server, { bytes: large, headers: { origin: 'https://foreign.example' } })).status, 403)
    assert.equal((await importPdf(server, { bytes: large, headers: { 'x-score-request': 'wrong' } })).status, 403)
    assert.equal(server.blobContainer.values.size, 0)
    const { resume: accepted } = await bodyOf(await importPdf(server), 202)
    for (const suffix of ['', `/${accepted.resume.id}`, `/${accepted.resume.id}/original`]) {
      assert.equal((await fetch(`${server.path()}${suffix}`, { headers: auth(VIEWER) })).status, 200)
      assert.equal((await fetch(`${server.path()}${suffix}`, { headers: auth(OUTSIDER) })).status, 404)
    }
    assert.equal((await action(server, accepted.resume.id, 'cancel', accepted.etag, undefined, { ...auth(VIEWER) })).status, 403)
    assert.equal((await fetch(`${server.path(OTHER_WORKSPACE)}/${accepted.resume.id}`, { headers: auth(OUTSIDER) })).status, 404)
  } finally { await server.close() }
  const disabled = await fixture({ disabled: true })
  try {
    assert.equal((await importPdf(disabled, { bytes: Buffer.alloc(MAX_PDF + 1) })).status, 503)
    assert.equal(disabled.blobContainer.values.size, 0)
  } finally { await disabled.close() }
})

test('PDF validation rejects malformed/encrypted sources and enforces exact 10 MiB and 50-page limits, including scanned PDFs', async () => {
  const server = await fixture()
  try {
    for (const bytes of [Buffer.alloc(0), Buffer.from('not a PDF'), Buffer.from('%PDF-1.7\nmalformed')]) {
      await bodyOf(await importPdf(server, { bytes }), 400)
    }
    const encrypted = Buffer.from(pdfBytes.toString('latin1').replace(/trailer\s*<</, 'trailer\n<< /Encrypt 999 0 R'), 'latin1')
    assert.notDeepEqual(encrypted, pdfBytes)
    const encryptedResponse = await bodyOf(await importPdf(server, { bytes: encrypted }), 400)
    assert.match(encryptedResponse.error.message, /password|unencrypted|protection/i)
    const tooMany = await bodyOf(await importPdf(server, { bytes: await pdf(51) }), 400)
    assert.match(tooMany.error.message, /50 pages/)
    const tooBig = await bodyOf(await importPdf(server, { bytes: Buffer.concat([pdfBytes, Buffer.alloc(MAX_PDF)]) }), 413)
    assert.match(tooBig.error.message, /10 MiB/)
    assert.equal(server.cosmos.values.size, 0)
    assert.equal(server.blobContainer.values.size, 0)
    await bodyOf(await importPdf(server, { bytes: await pdf(50) }), 202)
    const exactMaximum = Buffer.concat([pdfBytes, Buffer.alloc(MAX_PDF - pdfBytes.length, ' ')])
    const accepted = await bodyOf(await importPdf(server, { bytes: exactMaximum }), 202)
    assert.equal(accepted.resume.capture.original.bytes, MAX_PDF)
    assert.deepEqual(server.blobContainer.values.get(accepted.resume.capture.original.blobName).bytes, exactMaximum)
  } finally { await server.close() }
})

test('safe filenames and raw content types are enforced without using filenames as candidate identity', async () => {
  const server = await fixture()
  try {
    for (const filename of ['../resume.pdf', 'x\\resume.pdf', 'resume.txt', 'x:resume.pdf', 'x\n.pdf', 'CON.pdf', ' resume.pdf']) {
      await bodyOf(await importPdf(server, { filename }), 400)
    }
    await bodyOf(await importPdf(server, { headers: { 'x-file-name': '%ZZ.pdf' } }), 400)
    await bodyOf(await importPdf(server, { headers: { 'x-file-name': 'not encoded.pdf' } }), 400)
    await bodyOf(await importPdf(server, { headers: { 'content-type': 'text/plain' } }), 400)
    await bodyOf(await importPdf(server, { headers: { 'content-encoding': 'gzip' } }), 400)
    const first = (await bodyOf(await importPdf(server), 202)).resume
    const second = (await bodyOf(await importPdf(server, { bytes: await pdf(1, 'Different source bytes') }), 202)).resume
    assert.notEqual(first.resume.id, second.resume.id)
    assert.equal(first.source.fileName, second.source.fileName)
    assert.deepEqual(second.duplicates, [])
    const exact = (await bodyOf(await importPdf(server, { filename: 'another-name.pdf' }), 202)).resume
    assert.deepEqual(exact.duplicates.map(value => [value.kind, value.resumeId]), [['exact-content', first.resume.id]])
    assert.equal(exact.resume.name, null)
  } finally { await server.close() }
})

test('public URL imports capture only a stable input identity and never invent a ready profile or bypass access controls', async () => {
  const server = await fixture()
  try {
    const request = input()
    const response = (await bodyOf(await importUrl(server, { input: request, url: 'https://WWW.LINKEDIN.COM:443/in/example#about' }), 202)).resume
    assert.equal(response.source.url, 'https://www.linkedin.com/in/example')
    assert.equal(response.resume.status, 'queued')
    assert.equal(response.resume.name, null)
    assert.equal(response.capture, null)
    assert.equal(server.blobContainer.values.size, 1, 'URL intake creates only its immutable receipt; retrieval is worker-owned')
    const replay = (await bodyOf(await importUrl(server, { input: request, url: 'https://www.linkedin.com/in/example' }), 200)).resume
    assert.equal(replay.resume.id, response.resume.id)
    const duplicate = (await bodyOf(await importUrl(server, { url: 'https://www.linkedin.com/in/example#contact' }), 202)).resume
    assert.deepEqual(duplicate.duplicates.map(value => [value.kind, value.resumeId]), [['same-source', response.resume.id]])
    const foreign = (await bodyOf(await importUrl(server, {
      url: 'https://www.linkedin.com/in/example', oid: OUTSIDER, workspaceId: OTHER_WORKSPACE,
    }), 202)).resume
    assert.deepEqual(foreign.duplicates, [])
    assert.equal((await fetch(`${server.path()}/${response.resume.id}/original`, { headers: auth() })).status, 404)
  } finally { await server.close() }
})

test('URL validation bounds inputs and rejects credentials, nonstandard ports, unsafe literals, and private host names', async () => {
  const server = await fixture()
  try {
    for (const url of [
      '', 'relative', 'ftp://example.com/resume', 'file:///secret.pdf', 'https://person:password@example.com/',
      'https://example.com:8443/', 'http://localhost/', 'http://foo.localhost/', 'http://metadata.google.internal/',
      'http://168.63.129.16/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://100.64.0.1/',
      'http://2130706433/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
      'http://printer/', 'https://example.com\\@localhost/', ' https://example.com/', `https://example.com/${'x'.repeat(4096)}`,
    ]) await bodyOf(await importUrl(server, { url }), 400)
    for (const body of [{ url: 'https://example.com/', profile: {} }, { url: 'https://example.com/', workspaceId: OTHER_WORKSPACE }, [], {}]) {
      await bodyOf(await importUrl(server, { body }), 400)
    }
    assert.equal(server.cosmos.values.size, 0)
    const base = 'https://example.com/'
    await bodyOf(await importUrl(server, { url: base + 'x'.repeat(4096 - base.length) }), 202)
    await bodyOf(await importUrl(server, { url: 'http://example.com:80/resume.pdf' }), 202)
  } finally { await server.close() }
})

test('UUID headers and decimal declared counts are required; an eleven-input request is rejected before storing content', async () => {
  const server = await fixture()
  try {
    for (const count of ['', '0', '11', '-1', '01', '1.0', '1e1', '1, 2']) {
      await bodyOf(await importPdf(server, { headers: { 'x-import-count': count } }), 400)
    }
    for (const name of ['idempotency-key', 'x-import-batch']) {
      await bodyOf(await importPdf(server, { headers: { [name]: '' } }), 400)
      await bodyOf(await importUrl(server, { headers: { [name]: 'not-a-uuid' } }), 400)
    }
    assert.equal(server.cosmos.values.size, 0)
    assert.equal(server.blobContainer.values.size, 0)
  } finally { await server.close() }
})

test('concurrent admission accepts at most ten unique items and atomically binds every accepted item to its batch', async () => {
  const server = await fixture()
  try {
    const batchId = randomUUID()
    const results = await Promise.all(Array.from({ length: 11 }, (_, index) => importUrl(server, {
      input: { batchId, inputCount: 10 }, url: `https://example.com/profile-${index}`,
    })))
    assert.equal(results.filter(response => response.status === 202).length, 10)
    assert.equal(results.filter(response => response.status === 409).length, 1)
    const batch = await server.store.get(WORKSPACE, api.resumeBatchRecordId(batchId))
    assert.equal(batch.record.inputCount, 10)
    assert.equal(batch.record.items.length, 10)
    assert.equal(new Set(batch.record.items.map(item => item.idempotencyKey)).size, 10)
    for (const item of batch.record.items) {
      const saved = await server.store.get(WORKSPACE, item.resumeId)
      assert.equal(saved.record.inputFingerprint, item.inputFingerprint)
      assert.equal(saved.record.batchId, batchId)
    }
    assert.ok(server.cosmos.batches.every(batch => batch.operations.length === 2), 'admission and publication must be one Cosmos transaction')
    assert.ok(server.cosmos.batches.some(batch => batch.operations[0].ifMatch), 'concurrent admission must condition the batch head')
    assert.equal((await server.store.list(WORKSPACE, { recordType: 'resume' })).items.length, 10)
  } finally { await server.close() }
})

test('batch declarations cannot be changed, successes are independent of invalid items, and retries do not consume another slot', async () => {
  const server = await fixture()
  try {
    const batchId = randomUUID()
    const firstInput = input({ batchId, inputCount: 2 })
    const first = (await bodyOf(await importPdf(server, { input: firstInput }), 202)).resume
    await bodyOf(await importPdf(server, { input: { batchId, inputCount: 2 }, bytes: Buffer.from('invalid') }), 400)
    await bodyOf(await importUrl(server, { input: { batchId, inputCount: 3 } }), 409)
    await bodyOf(await importPdf(server, { input: firstInput }), 200)
    await bodyOf(await importUrl(server, { input: { batchId, inputCount: 2 } }), 202)
    await bodyOf(await importUrl(server, { input: { batchId, inputCount: 2 }, url: 'https://example.com/extra' }), 409)
    const cancelled = (await bodyOf(await action(server, first.resume.id, 'cancel', first.etag), 200)).resume
    await bodyOf(await action(server, first.resume.id, 'retry', cancelled.etag), 200)
    assert.equal((await server.store.get(WORKSPACE, api.resumeBatchRecordId(batchId))).record.items.length, 2)
    assert.equal((await server.store.list(WORKSPACE, { recordType: 'resume' })).items.length, 2)
  } finally { await server.close() }
})

test('idempotency binds filenames, source bytes, URL, batch declaration, and source kind; concurrent conflicting bodies never overwrite the winner', async () => {
  const server = await fixture()
  try {
    const request = input()
    const initial = (await bodyOf(await importPdf(server, { input: request }), 202)).resume
    await bodyOf(await importPdf(server, { input: request, filename: 'changed.pdf' }), 409)
    await bodyOf(await importPdf(server, { input: request, bytes: await pdf(1, 'Changed bytes') }), 409)
    await bodyOf(await importUrl(server, { input: request }), 409)
    await bodyOf(await importPdf(server, { input: { ...request, batchId: randomUUID() } }), 409)
    await bodyOf(await importPdf(server, { input: { ...request, inputCount: 2 } }), 409)
    assert.deepEqual(server.blobContainer.values.get(initial.capture.original.blobName).bytes, pdfBytes)
    const racing = input()
    const alternatives = [pdfBytes, await pdf(2)]
    const outcomes = await Promise.all(alternatives.map(bytes => importPdf(server, { input: racing, bytes })))
    assert.deepEqual(outcomes.map(result => result.status).sort(), [202, 409])
    const winner = outcomes.findIndex(result => result.status === 202)
    const record = await server.store.get(WORKSPACE, api.resumeIdForKey(racing.idempotencyKey))
    assert.deepEqual(server.blobContainer.values.get(record.record.capture.original.blobName).bytes, alternatives[winner])
    assert.equal((await server.store.get(WORKSPACE, api.resumeBatchRecordId(racing.batchId))).record.items.length, 1)
    const urlRequest = input()
    await bodyOf(await importUrl(server, { input: urlRequest }), 202)
    await bodyOf(await importUrl(server, { input: urlRequest, url: 'https://example.com/other' }), 409)
  } finally { await server.close() }
})

test('lost and failed publication responses recover from immutable winning receipts without deleting or re-fetching accepted inputs', async () => {
  const server = await fixture()
  try {
    const request = input()
    server.cosmos.failBefore()
    await bodyOf(await importPdf(server, { input: request }), 503)
    assert.equal(server.cosmos.values.size, 0)
    assert.equal(server.blobContainer.values.size, 3)
    const receipts = clone([...server.blobContainer.values.entries()])
    server.advance('2026-09-18T02:31:00.000Z')
    const recovered = (await bodyOf(await importPdf(server, { input: request }), 202)).resume
    assert.equal(recovered.resume.createdAt, NOW)
    assert.equal(recovered.capture.capturedAt, NOW)
    assert.deepEqual([...server.blobContainer.values.entries()], receipts.map(([name, blob]) => [name, { ...blob, bytes: Buffer.from(blob.bytes) }]))
    const ambiguous = input()
    server.cosmos.failAfter()
    const accepted = (await bodyOf(await importUrl(server, { input: ambiguous }), 200)).resume
    assert.equal(accepted.resume.status, 'queued')
    await bodyOf(await importUrl(server, { input: ambiguous }), 200)
    assert.equal((await server.store.get(WORKSPACE, api.resumeBatchRecordId(ambiguous.batchId))).record.items.length, 1)
    const lostUpload = input()
    server.blobContainer.fail(({ name, blob, values }) => {
      values.set(name, blob)
      throw new Error('Lost immutable receipt upload response')
    })
    await bodyOf(await importPdf(server, { input: lostUpload }), 503)
    const success = (await bodyOf(await importPdf(server, { input: lostUpload }), 202)).resume
    assert.equal(success.resume.id, api.resumeIdForKey(lostUpload.idempotencyKey))
  } finally { await server.close() }
})

test('retry and cancellation require exact ETags and empty input; cancellation fences out late workers and keeps evidence', async () => {
  const server = await fixture()
  try {
    const initial = (await bodyOf(await importPdf(server), 202)).resume
    await bodyOf(await action(server, initial.resume.id, 'cancel'), 428)
    await bodyOf(await action(server, initial.resume.id, 'cancel', '*'), 400)
    await bodyOf(await action(server, initial.resume.id, 'cancel', 'W/"weak"'), 400)
    await bodyOf(await action(server, initial.resume.id, 'cancel', '"one","two"'), 400)
    await bodyOf(await action(server, initial.resume.id, 'cancel', '"stale"'), 409)
    await bodyOf(await action(server, initial.resume.id, 'cancel', initial.etag, { source: 'forged' }), 400)
    await bodyOf(await action(server, initial.resume.id, 'retry', initial.etag), 409)
    const processing = await profileResume(server, initial.resume.id, 'profiling')
    await bodyOf(await action(server, initial.resume.id, 'cancel', initial.etag), 409)
    const cancelled = (await bodyOf(await action(server, initial.resume.id, 'cancel', processing.etag, {}), 200)).resume
    assert.equal(cancelled.resume.status, 'cancelled')
    assert.deepEqual(cancelled.capture, initial.capture)
    assert.deepEqual(cancelled.documentRef, processing.record.extraction.document)
    assert.equal(cancelled.resume.name, 'Alex Example')
    assert.deepEqual(await server.store.listPending(NOW, 100), [])
    const late = { ...processing.record, resume: { ...processing.record.resume, status: 'ready' }, completedAt: NOW }
    delete late.lease
    await assert.rejects(server.store.replace(late, processing.etag), api.StoreConflictError)
    const retried = (await bodyOf(await action(server, initial.resume.id, 'retry', cancelled.etag), 200)).resume
    assert.equal(retried.resume.status, 'queued')
    assert.equal(retried.retryCount, 1)
    assert.equal(retried.attempts, 0)
    const record = (await server.store.get(WORKSPACE, initial.resume.id)).record
    assert.equal(record.attemptId, undefined)
    assert.equal(record.cancelledAt, undefined)
    assert.deepEqual(record.extraction, processing.record.extraction)
    assert.deepEqual(record.profileBlob, processing.record.profileBlob)
    assert.equal((await server.service.detail(WORKSPACE, initial.resume.id)).profile.name.value, 'Alex Example')
    assert.equal((await server.store.listPending(NOW, 100)).length, 1)
    await bodyOf(await action(server, initial.resume.id, 'cancel', cancelled.etag), 409)
  } finally { await server.close() }
})

test('ready details verify actual document hashes, exact profile citations, and metadata; ready records cannot be retried or cancelled', async () => {
  const server = await fixture()
  try {
    const initial = (await bodyOf(await importPdf(server), 202)).resume
    const ready = await profileResume(server, initial.resume.id)
    const detail = await bodyOf(await fetch(`${server.path()}/${initial.resume.id}`, { headers: auth() }), 200)
    assert.deepEqual(detail.document, ready.document)
    assert.deepEqual(detail.profile, ready.profile)
    assert.equal(detail.resume.experience, null)
    await bodyOf(await action(server, initial.resume.id, 'cancel', ready.etag), 409)
    await bodyOf(await action(server, initial.resume.id, 'retry', ready.etag), 409)
    const key = server.cosmos.key(WORKSPACE, initial.resume.id)
    const original = clone(server.cosmos.values.get(key))
    server.cosmos.values.set(key, { ...original, resume: { ...original.resume, name: 'Invented metadata' } })
    await bodyOf(await fetch(`${server.path()}/${initial.resume.id}`, { headers: auth() }), 503)
    server.cosmos.values.set(key, original)
    const profileName = original.profileBlob.blobName
    const savedBlob = server.blobContainer.values.get(profileName)
    const corrupted = { ...ready.profile, name: { ...ready.profile.name, value: 'Unquoted name' } }
    server.blobContainer.values.set(profileName, { ...savedBlob, bytes: Buffer.from(JSON.stringify(corrupted)) })
    await bodyOf(await fetch(`${server.path()}/${initial.resume.id}`, { headers: auth() }), 503)
    assert.equal(server.cosmos.values.get(key).resume.status, 'ready', 'corruption must not silently overwrite saved state')
  } finally { await server.close() }
})

test('paged summaries contain no document/profile content and preserve continuation tokens across the whole library', async () => {
  const server = await fixture()
  try {
    for (let index = 0; index < 5; index++) {
      await server.service.importUrl(WORKSPACE, input(), `https://example.com/person-${index}`)
    }
    const seen = []
    let token
    do {
      const response = await fetch(`${server.path()}?limit=2${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`, { headers: auth() })
      const page = await bodyOf(response, 200)
      assert.ok(page.resumes.length <= 2)
      for (const item of page.resumes) {
        assert.equal(Object.hasOwn(item, 'document'), false)
        assert.equal(Object.hasOwn(item, 'profile'), false)
        seen.push(item.resume.id)
      }
      token = page.continuationToken
    } while (token)
    assert.equal(seen.length, 5)
    assert.equal(new Set(seen).size, 5)
    const lastQueries = server.cosmos.queries.filter(query => query.options?.maxItemCount === 2)
    assert.deepEqual(lastQueries.map(query => query.options.continuationToken), [undefined, '2', '4'])
    assert.ok(lastQueries.every(query => query.options.partitionKey === WORKSPACE && query.options.maxItemCount === 2))
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'continuationToken=', 'continuationToken=a&continuationToken=b']) {
      await bodyOf(await fetch(`${server.path()}?${query}`, { headers: auth() }), 400)
    }
  } finally { await server.close() }
})

test('captured HTML is delivered only as a private attachment, and corrupt/foreign originals are refused', async () => {
  const server = await fixture()
  try {
    const initial = (await bodyOf(await importUrl(server), 202)).resume
    const bytes = await captureHtml(server, initial.resume.id)
    const url = `${server.path()}/${initial.resume.id}/original`
    const response = await fetch(url, { headers: auth() })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/html')
    assert.match(response.headers.get('content-disposition'), /^attachment;/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.match(response.headers.get('content-security-policy'), /sandbox/)
    assert.match(response.headers.get('cache-control'), /private, no-store/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    const original = server.cosmos.values.get(server.cosmos.key(WORKSPACE, initial.resume.id))
    const blob = server.blobContainer.values.get(original.capture.original.blobName)
    blob.bytes = Buffer.from('<html>Changed source</html>')
    await bodyOf(await fetch(url, { headers: auth() }), 503)
    blob.bytes = bytes
    const invalid = clone(original)
    invalid.capture.original.blobName = `${OTHER_WORKSPACE}/${initial.resume.id}/original.html`
    server.cosmos.values.set(server.cosmos.key(WORKSPACE, initial.resume.id), invalid)
    await bodyOf(await fetch(url, { headers: auth() }), 503)
    await bodyOf(await action(server, initial.resume.id, 'cancel', original._etag), 503)
  } finally { await server.close() }
})

test('newly captured URLs receive exact-content warnings across list pages without mutating or merging either import', async () => {
  const server = await fixture()
  try {
    const first = (await bodyOf(await importUrl(server, { url: 'https://example.com/one' }), 202)).resume
    const second = (await bodyOf(await importUrl(server, { url: 'https://example.com/two' }), 202)).resume
    assert.deepEqual(second.duplicates, [])
    await captureHtml(server, first.resume.id)
    await captureHtml(server, second.resume.id)
    const firstRecord = await server.store.get(WORKSPACE, first.resume.id)
    const secondRecord = await server.store.get(WORKSPACE, second.resume.id)
    const page = await bodyOf(await fetch(`${server.path()}?limit=1`, { headers: auth() }), 200)
    assert.equal(page.resumes.length, 1)
    assert.deepEqual(page.resumes[0].duplicates.map(warning => [warning.kind, warning.resumeId]), [['exact-content', second.resume.id]])
    const detail = await bodyOf(await fetch(`${server.path()}/${second.resume.id}`, { headers: auth() }), 200)
    assert.deepEqual(detail.duplicates.map(warning => [warning.kind, warning.resumeId]), [['exact-content', first.resume.id]])
    assert.equal((await server.store.get(WORKSPACE, first.resume.id)).etag, firstRecord.etag)
    assert.equal((await server.store.get(WORKSPACE, second.resume.id)).etag, secondRecord.etag)
  } finally { await server.close() }
})

function queuedRecord(overrides = {}) {
  const key = randomUUID()
  const id = api.resumeIdForKey(key)
  const batchId = randomUUID()
  const source = { kind: 'url', displayName: 'https://example.com/resume', url: 'https://example.com/resume' }
  const record = {
    id, recordType: 'resume', dataKind: 'real', workspaceId: WORKSPACE, createdAt: NOW, updatedAt: NOW,
    resume: {
      id, dataKind: 'real', name: null, role: null, location: null, experience: null,
      documentId: api.resumeDocumentId(id), documentVersion: 1, sourceLabel: source.displayName,
      batchId, status: 'queued', createdAt: NOW,
    },
    source, batchId, idempotencyKey: key, inputFingerprint: 'a'.repeat(64), createdBy: 'test-actor',
    attempts: 0, retryCount: 0, nextAttemptAt: NOW, warnings: [], duplicates: [],
  }
  return { ...record, ...overrides, resume: { ...record.resume, ...overrides.resume } }
}

function admission(record, inputCount = 1) {
  return {
    id: api.resumeBatchRecordId(record.batchId), recordType: 'resume-batch', dataKind: 'real',
    workspaceId: record.workspaceId, batchId: record.batchId, createdBy: record.createdBy,
    createdAt: NOW, updatedAt: NOW, inputCount,
    items: [{ idempotencyKey: record.idempotencyKey, inputFingerprint: record.inputFingerprint, resumeId: record.id, acceptedAt: NOW }],
  }
}

test('Cosmos reads/writes validate records and exact ETags; single-write response bodies and bodyless batch responses use SDK semantics', async () => {
  const cosmos = fakeCosmosContainer([])
  const store = api.createResumeStoreFromContainer(cosmos)
  const record = queuedRecord()
  const batch = admission(record, 2)
  const created = await store.create(batch)
  assert.equal(created.created, true)
  assert.equal((await store.create(batch)).created, false)
  await store.transact(WORKSPACE, [
    { kind: 'replace', record: batch, etag: created.value.etag }, { kind: 'create', record },
  ])
  assert.equal(cosmos.batches.length, 1)
  assert.equal(cosmos.replacements.length, 0)
  assert.deepEqual(cosmos.batches[0].operations.map(operation => operation.operationType), ['Replace', 'Create'])
  assert.equal(cosmos.batches[0].operations[0].ifMatch, created.value.etag)
  assert.deepEqual(cosmos.batches[0].options, { contentResponseOnWriteEnabled: false })
  const current = await store.get(WORKSPACE, record.id)
  assert.ok(current.etag)
  assert.deepEqual(current.record, record)
  const updated = await store.replace({ ...record, warnings: ['Captured public sources may be incomplete.'] }, current.etag)
  assert.deepEqual(cosmos.replacements[0].options, { accessCondition: { type: 'IfMatch', condition: current.etag } })
  await assert.rejects(store.replace(record, current.etag), api.StoreConflictError)
  for (const etag of ['', '*', 'W/"weak"', '"one","two"', 'x'.repeat(1025)]) {
    await assert.rejects(store.replace(record, etag))
  }
  cosmos.suppressBody()
  const later = await store.replace({ ...updated.record, warnings: [] }, updated.etag)
  assert.deepEqual(later.record, record, 'when a successful write has no body, confirm the stored winning record')
  const another = queuedRecord()
  assert.equal((await store.create(another)).created, true)
  assert.equal(await store.get(WORKSPACE, api.resumeIdForKey(randomUUID())), undefined)
  await assert.rejects(store.replace(queuedRecord(), '"missing"'), api.StoreNotFoundError)
})

test('Cosmos batch ETag races and HTTP/operation failures never publish partial resume admission', async () => {
  for (const code of [404, 409, 412, 424, 429, 500]) {
    const cosmos = fakeCosmosContainer([])
    const store = api.createResumeStoreFromContainer(cosmos)
    const record = queuedRecord()
    const batch = admission(record)
    const saved = await store.create(batch)
    cosmos.response(operations => ({
      code: 207, result: operations.map((_operation, index) => ({ statusCode: index === 1 ? code : 424 })),
    }))
    await assert.rejects(store.transact(WORKSPACE, [
      { kind: 'replace', record: batch, etag: saved.value.etag }, { kind: 'create', record },
    ]), [404, 409, 412, 424].includes(code) ? api.StoreConflictError : Error)
    assert.equal(await store.get(WORKSPACE, record.id), undefined)
    assert.equal((await store.get(WORKSPACE, batch.id)).etag, saved.value.etag)
  }
  for (const response of [{ code: 200 }, { code: 200, result: [{}, {}] }, { code: 500, result: [{ statusCode: 200 }, { statusCode: 201 }] }]) {
    const cosmos = fakeCosmosContainer([])
    const store = api.createResumeStoreFromContainer(cosmos)
    const record = queuedRecord()
    cosmos.response(() => response)
    await assert.rejects(store.transact(WORKSPACE, [{ kind: 'create', record: admission(record) }, { kind: 'create', record }]))
    assert.equal(cosmos.values.size, 0)
  }
  const cosmos = fakeCosmosContainer([])
  const store = api.createResumeStoreFromContainer(cosmos)
  const record = queuedRecord()
  const batch = admission(record)
  const saved = await store.create(batch)
  cosmos.race(() => cosmos.save(batch))
  await assert.rejects(store.transact(WORKSPACE, [
    { kind: 'replace', record: batch, etag: saved.value.etag }, { kind: 'create', record },
  ]), api.StoreConflictError)
  assert.equal(await store.get(WORKSPACE, record.id), undefined)
  await assert.rejects(store.transact(OTHER_WORKSPACE, [{ kind: 'create', record }]), /workspace/)
  await assert.rejects(store.transact(WORKSPACE, []))
  await assert.rejects(store.transact(WORKSPACE, [{ kind: 'create', record }, { kind: 'create', record }]))
  await assert.rejects(store.transact(WORKSPACE, [{ kind: 'upsert', record }]))
})

test('store rejects corrupted ownership, namespace crossings, unknown enums, fictional metadata, and incomplete ready state', async () => {
  const server = await fixture()
  try {
    const accepted = (await bodyOf(await importPdf(server), 202)).resume
    const key = server.cosmos.key(WORKSPACE, accepted.resume.id)
    const original = clone(server.cosmos.values.get(key))
    const mutations = [
      value => { value.workspaceId = OTHER_WORKSPACE },
      value => { value.id = api.resumeIdForKey(randomUUID()) },
      value => { value.unknown = true },
      value => { value._etag = undefined },
      value => { value.dataKind = 'sample' },
      value => { value.resume.status = 'generating' },
      value => { value.resume.name = 'Name inferred from filename' },
      value => { value.resume.documentId = api.resumeDocumentId(api.resumeIdForKey(randomUUID())) },
      value => { value.resume.batchId = randomUUID() },
      value => { value.source.fileName = '../secret.pdf' },
      value => { value.source.displayName = 'Different filename.pdf' },
      value => { value.capture.original.blobName = `${OTHER_WORKSPACE}/${accepted.resume.id}/original.pdf` },
      value => { value.capture.original.blobName = `${WORKSPACE}/${accepted.resume.id}/../original.pdf` },
      value => { value.capture.original.blobName = `${WORKSPACE}/${api.resumeIdForKey(randomUUID())}/original.pdf` },
      value => { value.capture.original.contentType = 'text/html' },
      value => { value.capture.original.bytes = MAX_PDF + 1 },
      value => { value.capture.original.sha256 = 'not-a-hash' },
      value => { value.capture.finalUrl = 'http://127.0.0.1/' },
      value => { delete value.captureManifest },
      value => { value.captureManifest.blobName = value.capture.original.blobName },
      value => { value.resume.status = 'ready'; value.completedAt = NOW; delete value.nextAttemptAt },
      value => { value.resume.status = 'parsing' },
      value => { value.error = { code: 'made-up-error', stage: 'download', message: 'Unknown', retryable: false } },
      value => { value.attempts = 4 },
      value => { value.retryCount = -1 },
      value => { value.duplicates = [{ kind: 'exact-content', resumeId: value.id, message: 'Self duplicate' }] },
      value => { value.updatedAt = '2020-01-01T00:00:00.000Z' },
    ]
    for (const mutate of mutations) {
      const value = clone(original)
      mutate(value)
      server.cosmos.values.set(key, value)
      await assert.rejects(server.store.get(WORKSPACE, accepted.resume.id))
    }
    server.cosmos.values.set(key, original)
    await assert.rejects(server.store.get('../unsafe', original.id), /workspace/)
    await assert.rejects(server.store.get(WORKSPACE, '../secret'), /ID/)
    await assert.rejects(server.store.create({ ...queuedRecord(), source: { kind: 'url', url: 'http://localhost/', displayName: 'http://localhost/' } }))
    server.cosmos.queryResponse(result => ({ ...result, resources: [{ ...original, workspaceId: OTHER_WORKSPACE }] }))
    await assert.rejects(server.store.list(WORKSPACE, { recordType: 'resume' }))
    server.cosmos.queryResponse(result => ({ ...result, resources: [{ ...original, recordType: 'resume-batch' }] }))
    await assert.rejects(server.store.list(WORKSPACE, { recordType: 'resume' }))
  } finally { await server.close() }
})

test('batch records are append-only and enforce declared count, unique IDs, and immutable ownership', async () => {
  const cosmos = fakeCosmosContainer([])
  const store = api.createResumeStoreFromContainer(cosmos)
  const record = queuedRecord()
  const batch = admission(record, 2)
  const saved = await store.create(batch)
  for (const changed of [
    { ...batch, inputCount: 11 }, { ...batch, inputCount: 3 }, { ...batch, items: [] },
    { ...batch, items: [...batch.items, ...batch.items] },
    { ...batch, createdBy: 'other-user' },
    { ...batch, items: [{ ...batch.items[0], inputFingerprint: 'b'.repeat(64) }] },
    { ...batch, items: [{ ...batch.items[0], resumeId: api.resumeIdForKey(randomUUID()) }] },
  ]) await assert.rejects(store.replace(changed, saved.value.etag))
  const second = queuedRecord()
  const next = { ...batch, items: [...batch.items, ...admission(second).items] }
  const appended = await store.replace(next, saved.value.etag)
  assert.equal(appended.record.items.length, 2)
  await assert.rejects(store.replace({ ...next, items: [...next.items, ...admission(queuedRecord()).items] }, appended.etag))
  await assert.rejects(store.replace({ ...next, items: [...next.items].reverse() }, appended.etag))
})

test('resume originals, capture manifests, extractions, profile metadata, identities, and retry bounds cannot be rewritten', async () => {
  const server = await fixture()
  try {
    const initial = (await bodyOf(await importPdf(server), 202)).resume
    const processing = await profileResume(server, initial.resume.id, 'profiling')
    for (const mutate of [
      value => { value.createdBy = 'another-actor' },
      value => { value.inputFingerprint = 'b'.repeat(64) },
      value => { value.source.fileName = value.source.displayName = value.resume.sourceLabel = 'changed.pdf' },
      value => { value.resume.documentVersion = 2 },
      value => { value.capture.original.sha256 = 'b'.repeat(64) },
      value => { value.captureManifest.sha256 = 'b'.repeat(64) },
      value => { value.extraction.document.sha256 = 'b'.repeat(64) },
      value => { value.profileBlob.sha256 = 'b'.repeat(64) },
      value => { value.resume.name = 'Different name' },
      value => { value.attempts = 0 },
      value => { value.retryCount = 1 },
      value => { value.attemptId = randomUUID(); value.attempts++ },
      value => { value.lease.owner = 'different-worker' },
      value => { delete value.profileBlob; value.resume.name = value.resume.role = value.resume.location = null },
    ]) {
      const record = clone(processing.record)
      mutate(record)
      await assert.rejects(server.store.replace(record, processing.etag))
    }
    const heartbeat = {
      ...processing.record, updatedAt: '2026-09-18T02:31:00.000Z',
      lease: { ...processing.record.lease, heartbeatAt: '2026-09-18T02:31:00.000Z', expiresAt: '2026-09-18T02:36:00.000Z' },
    }
    const extended = await server.store.replace(heartbeat, processing.etag)
    const reclaimed = {
      ...extended.record, updatedAt: '2026-09-18T02:37:00.000Z', attempts: 2, attemptId: randomUUID(),
      lease: { owner: 'replacement-worker', heartbeatAt: '2026-09-18T02:37:00.000Z', expiresAt: '2026-09-18T02:42:00.000Z' },
    }
    const saved = await server.store.replace(reclaimed, extended.etag)
    assert.equal(saved.record.lease.owner, 'replacement-worker')
    const ready = { ...saved.record, resume: { ...saved.record.resume, status: 'ready' }, completedAt: '2026-09-18T02:37:00.000Z' }
    delete ready.lease
    const complete = await server.store.replace(ready, saved.etag)
    await assert.rejects(server.store.replace({ ...complete.record, warnings: ['Changed after completion'] }, complete.etag), /immutable/)
  } finally { await server.close() }
})

test('pending queries include only due queued items and expired processing leases, never terminal or still-owned work', async () => {
  const cosmos = fakeCosmosContainer([])
  const store = api.createResumeStoreFromContainer(cosmos)
  const due = queuedRecord()
  const later = queuedRecord({ nextAttemptAt: '2026-09-18T03:00:00.000Z' })
  const expired = queuedRecord({
    createdAt: '2026-09-18T02:00:00.000Z', attempts: 1, attemptId: randomUUID(),
    resume: { status: 'parsing', createdAt: '2026-09-18T02:00:00.000Z' },
    lease: { owner: 'expired', heartbeatAt: '2026-09-18T02:10:00.000Z', expiresAt: '2026-09-18T02:20:00.000Z' },
  })
  const leased = queuedRecord({
    attempts: 1, attemptId: randomUUID(), resume: { status: 'parsing' },
    lease: { owner: 'active', heartbeatAt: NOW, expiresAt: '2026-09-18T02:35:00.000Z' },
  })
  const failed = queuedRecord({
    resume: { status: 'error' }, nextAttemptAt: undefined, completedAt: NOW,
    error: { code: 'access-blocked', stage: 'download', message: 'This URL is not publicly accessible and could not be processed.', retryable: false },
  })
  const cancelled = queuedRecord({ resume: { status: 'cancelled' }, nextAttemptAt: undefined, cancelledAt: NOW })
  for (const record of [due, later, expired, leased, failed, cancelled]) await store.create(record)
  assert.deepEqual((await store.listPending(NOW, 100)).map(value => value.record.id), [expired.id, due.id])
  const spec = cosmos.queries.at(-1)
  assert.match(spec.spec.query, /c\.resume\.status = 'queued'/)
  assert.match(spec.spec.query, /IS_DEFINED\(c\.lease\)/)
  assert.equal(spec.options.maxItemCount, 100)
  assert.equal((await store.listPending(NOW, 1)).length, 1)
  for (const record of [later, leased, failed, cancelled]) {
    cosmos.queryResponse(() => ({ resources: [cosmos.values.get(cosmos.key(WORKSPACE, record.id))] }))
    await assert.rejects(store.listPending(NOW, 100), /Pending/)
  }
  cosmos.queryResponse(() => ({ resources: [cosmos.values.get(cosmos.key(WORKSPACE, due.id)), cosmos.values.get(cosmos.key(WORKSPACE, expired.id))] }))
  await assert.rejects(store.listPending(NOW, 1), /limit/)
  cosmos.queryResponse(undefined)
  for (const [timestamp, limit] of [['not-a-date', 1], [NOW, 0], [NOW, 101], ['2026-09-18T02:30:00Z', 1]]) {
    await assert.rejects(store.listPending(timestamp, limit))
  }
  for (const options of [
    { recordType: 'unknown' }, { recordType: 'resume', status: 'done' }, { recordType: 'resume-batch', status: 'queued' },
    { recordType: 'resume', batchId: '../bad' }, { recordType: 'resume', continuationToken: '' },
    { recordType: 'resume', limit: 101 },
  ]) await assert.rejects(store.list(WORKSPACE, options))
})

test('immutable Blob adapter bounds actual bytes, validates metadata and namespace, and returns the winning original on collisions', async () => {
  const events = []
  const container = fakeBlobContainer(events)
  const store = api.createResumeBlobStoreFromContainer(container)
  const id = api.resumeIdForKey(randomUUID())
  const name = api.resumeOriginalBlobName(WORKSPACE, id, 'pdf')
  const first = await store.putImmutable(name, pdfBytes, 'application/pdf')
  assert.equal(first.created, true)
  const loser = await store.putImmutable(name, Buffer.from('%PDF-1.7 different source'), 'application/pdf')
  assert.equal(loser.created, false)
  assert.deepEqual(loser.blob.bytes, pdfBytes)
  assert.equal(loser.blob.sha256, api.resumeSha256(pdfBytes))
  assert.equal(loser.blob.etag, first.blob.etag)
  for (const invalid of [
    `../${id}/original.pdf`, `${WORKSPACE}/${id}/../../original.pdf`, `${WORKSPACE}/${id}/original.json`,
    `${WORKSPACE}/${id}/source-document-v0.json`, `${WORKSPACE}/${id}/profile-v1000001.json`,
    `${WORKSPACE}/${id}%2fother/original.pdf`, `${WORKSPACE}\\${id}\\original.pdf`,
    `${WORKSPACE}/job-${randomUUID()}/original.pdf`, `https://example.com/${WORKSPACE}/${id}/original.pdf`,
  ]) {
    await assert.rejects(store.read(invalid))
    await assert.rejects(store.putImmutable(invalid, pdfBytes, 'application/pdf'))
  }
  await assert.rejects(store.putImmutable(name, pdfBytes, 'text/html'))
  await assert.rejects(store.putImmutable(name, new Uint8Array(), 'application/pdf'))
  await assert.rejects(store.putImmutable(name, Buffer.alloc(MAX_PDF + 1), 'application/pdf'))
  assert.equal(await store.read(api.resumeOriginalBlobName(WORKSPACE, api.resumeIdForKey(randomUUID()), 'pdf')), undefined)
  for (const change of [
    response => ({ ...response, contentType: 'text/html' }),
    response => ({ ...response, etag: undefined }),
    response => ({ ...response, contentLength: MAX_PDF + 1 }),
    response => ({ ...response, contentLength: 0 }),
    response => ({ ...response, contentLength: pdfBytes.length - 1 }),
    response => ({ ...response, readableStreamBody: undefined }),
    response => ({ ...response, contentLength: undefined, readableStreamBody: Readable.from([Buffer.alloc(MAX_PDF), Buffer.from('x')]) }),
  ]) {
    container.override(change)
    await assert.rejects(store.read(name))
  }
  container.override(undefined)
  assert.deepEqual((await store.read(name)).bytes, pdfBytes)
})

test('Markdown resume Blob adapters use explicit canonical MIME/size maps and preserve exact winning bytes without HTML or JSON fallbacks', async () => {
  const container = fakeBlobContainer([])
  const store = api.createResumeBlobStoreFromContainer(container)
  const id = api.resumeIdForKey(randomUUID())
  const name = api.resumeOriginalBlobName(WORKSPACE, id, 'markdown')
  assert.equal(name, `${WORKSPACE}/${id}/original.md`)
  assert.equal(api.resumeOriginalBlobName(WORKSPACE, id, 'text/markdown'), name)
  assert.equal(api.resumeBlobContentType(name), 'text/markdown')
  assert.equal(api.resumeBlobLimit(name), MAX_MARKDOWN)
  assert.throws(() => api.resumeOriginalBlobName(WORKSPACE, id, 'text/plain'))
  const bytes = Buffer.alloc(MAX_MARKDOWN, 'x')
  bytes.set(Buffer.from('\uFEFF# Résumé\r\n\t😀\r\n'))
  const original = await store.putImmutable(name, bytes, 'text/markdown')
  assert.equal(original.created, true)
  const reference = api.resumeBlobReference(name, original.blob)
  assert.equal(reference.contentType, 'text/markdown')
  assert.equal(reference.bytes, MAX_MARKDOWN)
  assert.equal(reference.sha256, api.resumeSha256(bytes))
  const replay = await store.putImmutable(name, Buffer.from('# Changed original\n'), 'text/markdown')
  assert.equal(replay.created, false)
  assert.deepEqual(replay.blob.bytes, bytes)
  assert.equal(replay.blob.etag, original.blob.etag)
  assert.deepEqual((await store.read(name)).bytes, bytes)
  for (const contentType of ['application/pdf', 'text/html', 'application/json', 'text/plain', 'application/octet-stream']) {
    await assert.rejects(store.putImmutable(name, bytes, contentType), /content type/)
    assert.throws(() => api.resumeBlobReference(name, { ...original.blob, contentType }))
  }
  await assert.rejects(store.putImmutable(name, Buffer.alloc(MAX_MARKDOWN + 1, 'x'), 'text/markdown'), /size/)
  await assert.rejects(store.putImmutable(name, Buffer.alloc(0), 'text/markdown'), /empty/)
  for (const file of ['original.markdown', 'original.MD', 'original.txt', 'original.json', '../original.md']) {
    const invalid = `${WORKSPACE}/${id}/${file}`
    assert.throws(() => api.resumeBlobContentType(invalid))
    assert.throws(() => api.resumeBlobLimit(invalid))
    await assert.rejects(store.putImmutable(invalid, Buffer.from('# Resume'), 'text/markdown'))
    await assert.rejects(store.read(invalid))
  }
  for (const change of [
    response => ({ ...response, contentType: 'text/html' }),
    response => ({ ...response, contentType: 'application/pdf' }),
    response => ({ ...response, contentType: 'application/json' }),
    response => ({ ...response, contentLength: MAX_MARKDOWN + 1 }),
    response => ({ ...response, contentLength: bytes.length - 1 }),
    response => ({ ...response, contentLength: undefined, readableStreamBody: Readable.from([bytes, Buffer.from('x')]) }),
  ]) {
    container.override(change)
    await assert.rejects(store.read(name))
  }
  container.override(undefined)
  assert.deepEqual((await store.read(name)).bytes, bytes)
})

test('document/profile validation is strict, source-bounded, version-bound, and requires exact quotations for every available field', async () => {
  const server = await fixture()
  try {
    const initial = (await bodyOf(await importPdf(server), 202)).resume
    const ready = await profileResume(server, initial.resume.id)
    assert.deepEqual(api.validateRealResumeDocument(ready.document), [])
    assert.deepEqual(api.parseRealResumeProfile(ready.profile), ready.profile)
    assert.deepEqual(api.validateRealResumeProfile(ready.profile, ready.document, {
      workspaceId: WORKSPACE, resumeId: initial.resume.id, documentSha256: ready.record.extraction.document.sha256,
    }), [])
    const boundary = { ...ready.document, paragraphs: [{ id: 'p', page: 1, heading: '', text: 'x'.repeat(180000) }] }
    assert.deepEqual(api.validateRealResumeDocument(boundary), [])
    assert.ok(api.validateRealResumeDocument({ ...boundary, paragraphs: [{ ...boundary.paragraphs[0], heading: 'x' }] }).length)
    for (const document of [
      { ...ready.document, sample: true }, { ...ready.document, kind: 'job' }, { ...ready.document, unexpected: true },
      { ...ready.document, version: 0 }, { ...ready.document, paragraphs: [] },
      { ...ready.document, paragraphs: [...ready.document.paragraphs, ...ready.document.paragraphs] },
      { ...ready.document, paragraphs: [{ ...ready.document.paragraphs[0], page: 0 }] },
    ]) assert.ok(api.validateRealResumeDocument(document).length)
    for (const mutate of [
      value => { value.extra = 'unknown' },
      value => { value.dataKind = 'sample' },
      value => { value.resumeId = api.resumeIdForKey(randomUUID()) },
      value => { value.name.status = 'invented' },
      value => { value.name.citations = [] },
      value => { value.name.value = 'Name not present in the source' },
      value => { value.name.citations[0].documentVersion = 2 },
      value => { value.name.citations[0].documentId = api.resumeDocumentId(api.resumeIdForKey(randomUUID())) },
      value => { value.experience.value = 'Inferred' },
    ]) {
      const profile = clone(ready.profile)
      mutate(profile)
      assert.throws(() => api.parseRealResumeProfile(profile))
    }
    for (const change of [
      { paragraphId: 'missing' }, { page: 2 }, { heading: 'Changed heading' },
      { quote: 'Alex Example is fabricated in this unmatched quotation' },
    ]) {
      const profile = clone(ready.profile)
      Object.assign(profile.name.citations[0], change)
      assert.ok(api.validateRealResumeProfile(profile, ready.document).length)
    }
    assert.ok(api.validateRealResumeProfile(ready.profile, ready.document, {
      workspaceId: OTHER_WORKSPACE, resumeId: initial.resume.id, documentSha256: ready.profile.documentSha256,
    }).length)
    assert.ok(api.validateRealResumeProfile(ready.profile, ready.document, {
      workspaceId: WORKSPACE, resumeId: initial.resume.id, documentSha256: 'b'.repeat(64),
    }).length)
    assert.ok(api.validateResumeDocumentBinding({ ...ready.document, paragraphs: [{ ...ready.document.paragraphs[0], page: 51 }] }, ready.record).length)
    assert.ok(api.validateResumeDocumentBinding({ ...ready.document, paragraphs: [{ ...ready.document.paragraphs[0], text: 'Changed' }] }, ready.record).length)
  } finally { await server.close() }
})
