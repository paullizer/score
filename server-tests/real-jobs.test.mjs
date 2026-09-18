import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { createApp, StoreConflictError } from '../dist-server/app.mjs'
import {
  ALLOWED_OID,
  APP_ORIGIN,
  OTHER_ALLOWED_OID,
  authHeaders,
  baseConfig,
  createFakeDirectoryStore,
  createFakeStateStore,
  membershipFor,
  startTestServer,
} from './helpers.mjs'
import { createFakeRealJobs } from './job-lifecycle-fakes.mjs'

const CSRF = { origin: APP_ORIGIN, 'x-score-request': 'workspace' }
const MAX_MARKDOWN = 10 * 1024 * 1024
const REAL_JOBS_CONFIG = {
  cosmosEndpoint: 'https://example-cosmos.documents.azure.com:443/',
  database: 'score',
  container: 'job-records',
  storageAccountUrl: 'https://example.blob.core.windows.net',
  blobContainer: 'job-sources',
}

function clone(value) {
  return structuredClone(value)
}

async function startRealJobsServer() {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  const jobs = createFakeRealJobs()
  const config = baseConfig({ realJobs: REAL_JOBS_CONFIG })
  const app = createApp({
    config,
    directory,
    state,
    jobs: { store: jobs.store, blobs: jobs.blobs },
    now: () => new Date('2026-09-17T14:00:00.000Z'),
  })
  const server = createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return {
    baseUrl,
    directory,
    state,
    jobs,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function bootstrap(server, oid = ALLOWED_OID) {
  const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders({ oid }) })
  assert.equal(response.status, 200)
  return (await response.json()).workspaces[0]
}

function writeHeaders(oid = ALLOWED_OID, extra = {}) {
  return { ...authHeaders({ oid }), ...CSRF, ...extra }
}

async function importPdf(server, workspaceId, options = {}) {
  const key = options.key ?? randomUUID()
  const bytes = options.bytes ?? Buffer.from('%PDF-1.7\nreal job source\n', 'ascii')
  const filename = options.filename ?? 'Principal Engineer.pdf'
  return fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/jobs/pdf`, {
    method: 'POST',
    headers: writeHeaders(options.oid, {
      'content-type': 'application/pdf',
      'x-file-name': encodeURIComponent(filename),
      'idempotency-key': key,
      ...(options.batchId ? { 'x-import-batch': options.batchId } : {}),
      ...options.headers,
    }),
    body: bytes,
  })
}

async function importMarkdown(server, workspaceId, options = {}) {
  return fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/jobs/markdown`, {
    method: 'POST',
    headers: writeHeaders(options.oid, {
      'content-type': 'text/markdown',
      'x-file-name': encodeURIComponent(options.filename ?? 'Principal Engineer.md'),
      'idempotency-key': options.key ?? randomUUID(),
      ...(options.batchId ? { 'x-import-batch': options.batchId } : {}),
      ...options.headers,
    }),
    body: options.bytes ?? Buffer.from('# Principal Engineer\n\nMust lead distributed systems delivery.\n'),
  })
}

async function importUrl(server, workspaceId, url, options = {}) {
  const key = options.key ?? randomUUID()
  return fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/jobs/url`, {
    method: 'POST',
    headers: writeHeaders(options.oid, { 'content-type': 'application/json', 'idempotency-key': key }),
    body: JSON.stringify({ url, ...(options.batchId ? { batchId: options.batchId } : {}) }),
  })
}

test('features are authenticated and remain disabled when job dependencies are absent', async () => {
  const server = await startTestServer()
  try {
    assert.equal((await fetch(`${server.baseUrl}/api/features`)).status, 401)
    const response = await fetch(`${server.baseUrl}/api/features`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.realJobImports, false)
    assert.equal(body.markdownJobImports, false)
    assert.equal(body.markdownResumeImports, false)
    assert.equal(body.limits.maxPdfBytes, 10 * 1024 * 1024)
    assert.equal(body.limits.maxMarkdownBytes, MAX_MARKDOWN)
    assert.equal(body.resumeLimits.maxMarkdownBytes, MAX_MARKDOWN)
  } finally {
    await server.close()
  }
})

test('PDF ingestion authenticates before raw parsing, validates input, persists bytes first, and is idempotent', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const unauthorized = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-file-name': 'x.pdf', 'idempotency-key': randomUUID() },
      body: Buffer.from('%PDF-1.7'),
    })
    assert.equal(unauthorized.status, 401)

    const invalidMagic = await importPdf(server, workspace.id, { bytes: Buffer.from('not a pdf') })
    assert.equal(invalidMagic.status, 400)
    const invalidName = await importPdf(server, workspace.id, { filename: '../source.pdf' })
    assert.equal(invalidName.status, 400)

    const oversized = await importPdf(server, workspace.id, {
      bytes: Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(10 * 1024 * 1024)]),
    })
    assert.equal(oversized.status, 413)

    const key = randomUUID()
    const accepted = await importPdf(server, workspace.id, { key })
    assert.equal(accepted.status, 202)
    const first = await accepted.json()
    assert.equal(first.job.job.id, `job-${key}`)
    assert.equal(first.job.job.dataKind, 'real')
    assert.equal(first.job.job.status, 'queued')
    assert.equal(first.job.source.displayName, 'Principal Engineer.pdf')
    assert.deepEqual(server.jobs.publicationEvents.map((event) => event.type).slice(-2), ['blob', 'job'])

    const repeated = await importPdf(server, workspace.id, { key })
    assert.equal(repeated.status, 200)
    assert.equal((await repeated.json()).job.job.id, first.job.job.id)

    const changed = await importPdf(server, workspace.id, { key, bytes: Buffer.from('%PDF-1.7\ndifferent') })
    assert.equal(changed.status, 409)
    const stored = await server.jobs.store.get(workspace.id, `job-${key}`)
    assert.equal(stored.record.source.sha256, first.job.source.sha256)
    assert.equal(stored.record.inputFingerprint, createHash('sha256')
      .update(['pdf', 'Principal Engineer.pdf', '', first.job.source.sha256].join('\0')).digest('hex'))
  } finally {
    await server.close()
  }
})

test('legacy PDF job basenames remain valid for import, immutable fingerprint replay, stored reads, and downloads', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const bytes = Buffer.from('%PDF-1.7\nlegacy basename source\n', 'ascii')
    for (const filename of [
      'Role: engineer.pdf', 'CON.pdf', 'Role| lead.pdf', ' role.pdf', 'Role? draft*.PDF', 'Role "engineer".pdf',
      `${'x'.repeat(251)}.pdf`,
    ]) {
      const key = randomUUID()
      const accepted = await importPdf(server, workspace.id, { key, filename, bytes })
      assert.equal(accepted.status, 202, filename)
      const { job } = await accepted.json()
      assert.equal(job.source.displayName, filename)
      const stored = await server.jobs.store.get(workspace.id, job.job.id)
      assert.equal(stored.record.inputFingerprint, createHash('sha256')
        .update(['pdf', filename, '', job.source.sha256].join('\0')).digest('hex'))
      const replay = await importPdf(server, workspace.id, {
        key, filename, bytes, ...(filename === 'Role: engineer.pdf' ? { headers: { 'x-file-name': filename } } : {}),
      })
      assert.equal(replay.status, 200, filename)
      assert.deepEqual((await replay.json()).job, job)
      const detail = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${job.job.id}`, { headers: authHeaders() })
      assert.equal(detail.status, 200)
      assert.equal((await detail.json()).source.displayName, filename)
      const original = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${job.job.id}/original`, { headers: authHeaders() })
      assert.equal(original.status, 200, filename)
      assert.equal(original.headers.get('content-type'), 'application/pdf')
      assert.equal(decodeURIComponent(original.headers.get('content-disposition').split("filename*=UTF-8''")[1]), filename)
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
    }
    for (const filename of ['', '../role.pdf', 'x\\role.pdf', 'role\u0000.pdf', 'role\u007f.pdf', `${'x'.repeat(252)}.pdf`, 'role.md']) {
      assert.equal((await importPdf(server, workspace.id, { filename, bytes })).status, 400, filename)
    }
    assert.equal((await importPdf(server, workspace.id, { bytes, headers: { 'x-file-name': '%ZZ.pdf' } })).status, 400)
  } finally { await server.close() }
})

test('gzip PDF job uploads retain legacy inflation, original bytes, idempotency, and the inflated 10 MiB limit', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const key = randomUUID()
    const bytes = Buffer.from('%PDF-1.7\ncompressed real job source\n', 'ascii')
    const response = await importPdf(server, workspace.id, {
      key, bytes: gzipSync(bytes), headers: { 'content-encoding': 'gzip' },
    })
    assert.equal(response.status, 202)
    const { job } = await response.json()
    assert.equal(job.source.originalContentType, 'application/pdf')
    assert.equal(job.source.bytes, bytes.byteLength)
    assert.equal(job.source.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual(Buffer.from((await server.jobs.blobs.read(job.source.originalBlobName)).bytes), bytes)
    const replay = await importPdf(server, workspace.id, { key, bytes })
    assert.equal(replay.status, 200)
    assert.deepEqual((await replay.json()).job, job)
    const maximum = Buffer.alloc(10 * 1024 * 1024, ' ')
    maximum.set(bytes)
    const boundary = await importPdf(server, workspace.id, { bytes: gzipSync(maximum), headers: { 'content-encoding': 'gzip' } })
    assert.equal(boundary.status, 202)
    assert.equal((await boundary.json()).job.source.bytes, maximum.byteLength)
    const events = clone(server.jobs.publicationEvents)
    const oversized = await importPdf(server, workspace.id, {
      bytes: gzipSync(Buffer.concat([maximum, Buffer.from(' ')])), headers: { 'content-encoding': 'gzip' },
    })
    assert.equal(oversized.status, 413)
    const markdown = await importMarkdown(server, workspace.id, {
      bytes: gzipSync(Buffer.from('# Role\n')), headers: { 'content-encoding': 'gzip' },
    })
    assert.equal(markdown.status, 400)
    assert.match((await markdown.json()).error.message, /Compressed Markdown uploads are not supported/)
    assert.deepEqual(server.jobs.publicationEvents, events)
  } finally { await server.close() }
})

test('Markdown job imports accept both extensions case-insensitively and preserve exact original bytes, hashes, and safe attachment names', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const features = await (await fetch(`${server.baseUrl}/api/features`, { headers: authHeaders() })).json()
    assert.equal(features.realJobImports, true)
    assert.equal(features.markdownJobImports, true)
    assert.equal(features.markdownResumeImports, false)
    assert.equal(features.limits.maxBatchFiles, 10)
    for (const filename of ['job.md', 'job.MD', 'Résumé role.markdown', "Résumé role's.MARKDOWN"]) {
      const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Role\r\n\r\nLead systems.\tCafé 😀\r\n')])
      const accepted = await importMarkdown(server, workspace.id, {
        filename, bytes, headers: { 'content-type': 'text/markdown; charset=UTF-8', 'content-encoding': 'identity' },
      })
      assert.equal(accepted.status, 202)
      const { job } = await accepted.json()
      assert.equal(job.job.source, 'markdown')
      assert.equal(job.source.kind, 'markdown')
      assert.equal(job.source.displayName, filename)
      assert.equal(job.source.originalContentType, 'text/markdown')
      assert.equal(job.source.originalBlobName, `${workspace.id}/${job.job.id}/original.md`)
      assert.equal(job.source.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.equal(job.source.bytes, bytes.byteLength)
      assert.equal(job.source.url, undefined)
      assert.equal(job.source.finalUrl, undefined)
      assert.equal(job.job.status, 'queued')
      assert.equal(job.rubric, null)
      assert.deepEqual(server.jobs.publicationEvents.slice(-2).map(event => event.type), ['blob', 'job'])
      const original = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${job.job.id}/original`, { headers: authHeaders() })
      assert.equal(original.status, 200)
      assert.equal(original.headers.get('content-type'), 'text/markdown')
      assert.match(original.headers.get('content-disposition'), /^attachment;/)
      assert.equal(decodeURIComponent(original.headers.get('content-disposition').split("filename*=UTF-8''")[1]), filename)
      assert.equal(original.headers.get('x-content-type-options'), 'nosniff')
      assert.match(original.headers.get('content-security-policy'), /sandbox; default-src 'none'/)
      assert.equal(original.headers.get('referrer-policy'), 'no-referrer')
      assert.match(original.headers.get('cache-control'), /private, no-store/)
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
    }
  } finally { await server.close() }
})

test('Markdown job metadata and strict UTF-8 validation reject unsafe, compressed, empty, binary, and over-limit inputs without publishing', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    for (const filename of [
      '../job.md', 'x\\job.markdown', 'job.pdf', 'job.md.exe', 'job:one.md', 'CON.md', 'job\u0085.md', ' job.md', 'job.md ',
      'x'.repeat(256) + '.md',
    ]) assert.equal((await importMarkdown(server, workspace.id, { filename })).status, 400, filename)
    for (const headers of [
      { 'x-file-name': '' }, { 'x-file-name': '%ZZ.md' }, { 'x-file-name': 'not encoded.md' },
      { 'x-file-name': '%ED%A0%80.md' }, { 'idempotency-key': '' }, { 'idempotency-key': 'not-a-uuid' },
      { 'x-import-batch': 'not-a-uuid' }, { 'content-type': 'text/plain' },
      { 'content-type': 'application/pdf' }, { 'content-type': 'text/markdown; charset=utf-16' },
      { 'content-type': 'text/markdown; charset=iso-8859-1' }, { 'content-type': 'text/markdown; unexpected=value' },
      { 'content-encoding': 'gzip' }, { 'content-encoding': 'br' }, { 'content-encoding': 'deflate' },
    ]) assert.equal((await importMarkdown(server, workspace.id, { headers })).status, 400, JSON.stringify(headers))
    for (const bytes of [
      Buffer.alloc(0), Buffer.from(' \t\r\n'), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xc3, 0x28]),
      Buffer.from('# role', 'utf16le'), Buffer.from('# role\0binary'), Buffer.from('# role\u0085binary'),
      Buffer.from('# role\u0001binary'), Buffer.from('# role\fbinary'), Buffer.from('%PDF-1.7\nnot Markdown'),
      Buffer.from([0xff, 0xfe, 0x41, 0x00]),
    ]) assert.equal((await importMarkdown(server, workspace.id, { bytes })).status, 400, bytes.toString('hex'))
    const tooLarge = await importMarkdown(server, workspace.id, { bytes: Buffer.alloc(MAX_MARKDOWN + 1, 'a') })
    assert.equal(tooLarge.status, 413)
    assert.match((await tooLarge.json()).error.message, /10 MiB/)
    assert.deepEqual(server.jobs.publicationEvents, [])
    const maximum = Buffer.alloc(MAX_MARKDOWN, 'a')
    const accepted = await importMarkdown(server, workspace.id, { bytes: maximum })
    assert.equal(accepted.status, 202)
    const { job } = await accepted.json()
    assert.equal(job.source.bytes, MAX_MARKDOWN)
    assert.deepEqual(Buffer.from((await server.jobs.blobs.read(job.source.originalBlobName)).bytes), maximum)
  } finally { await server.close() }
})

test('Markdown jobs authenticate, authorize, check CSRF and service availability before upload parsing', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const large = Buffer.alloc(MAX_MARKDOWN + 1, 'x')
    const path = `${server.baseUrl}/api/workspaces/${workspace.id}/jobs/markdown`
    assert.equal((await fetch(path, { method: 'POST', headers: { 'content-type': 'text/markdown' }, body: large })).status, 401)
    assert.equal((await importMarkdown(server, workspace.id, { bytes: large, headers: { origin: 'https://foreign.example' } })).status, 403)
    assert.equal((await importMarkdown(server, workspace.id, { bytes: large, headers: { 'x-score-request': '' } })).status, 403)
    assert.equal((await importMarkdown(server, workspace.id, { bytes: large, oid: OTHER_ALLOWED_OID })).status, 404)
    server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
    assert.equal((await importMarkdown(server, workspace.id, { bytes: large, oid: OTHER_ALLOWED_OID })).status, 403)
    assert.deepEqual(server.jobs.publicationEvents, [])
    const imported = (await (await importMarkdown(server, workspace.id)).json()).job
    assert.equal((await fetch(`${path.slice(0, -'/markdown'.length)}/${imported.job.id}/original`, {
      headers: authHeaders({ oid: OTHER_ALLOWED_OID }),
    })).status, 200)
  } finally { await server.close() }
  const disabled = await startTestServer()
  try {
    const workspace = await bootstrap(disabled)
    const response = await importMarkdown(disabled, workspace.id, { bytes: Buffer.alloc(MAX_MARKDOWN + 1, 'x') })
    assert.equal(response.status, 503)
  } finally { await disabled.close() }
})

test('Markdown job idempotency preserves the winner and rejects changed bytes, filename, batch, or source kind', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const key = randomUUID()
    const batchId = randomUUID()
    const first = await importMarkdown(server, workspace.id, { key, batchId })
    assert.equal(first.status, 202)
    const original = (await first.json()).job
    const events = clone(server.jobs.publicationEvents)
    const repeated = await importMarkdown(server, workspace.id, { key, batchId })
    assert.equal(repeated.status, 200)
    assert.deepEqual((await repeated.json()).job, original)
    for (const changes of [
      { filename: 'changed.md' }, { filename: 'Principal Engineer.markdown' },
      { bytes: Buffer.from('# changed source\n') }, { batchId: randomUUID() },
    ]) assert.equal((await importMarkdown(server, workspace.id, { key, batchId, ...changes })).status, 409)
    assert.equal((await importPdf(server, workspace.id, { key, batchId })).status, 409)
    assert.equal((await importUrl(server, workspace.id, 'https://example.com/job.md', { key, batchId })).status, 409)
    assert.deepEqual(server.jobs.publicationEvents, events)
    const pdfKey = randomUUID()
    assert.equal((await importPdf(server, workspace.id, { key: pdfKey })).status, 202)
    assert.equal((await importMarkdown(server, workspace.id, { key: pdfKey })).status, 409)
    const racing = randomUUID()
    const alternatives = [Buffer.from('# First job\n'), Buffer.from('# Second job\n')]
    const responses = await Promise.all(alternatives.map(bytes => importMarkdown(server, workspace.id, { key: racing, bytes })))
    assert.deepEqual(responses.map(response => response.status).sort(), [202, 409])
    const winner = responses.findIndex(response => response.status === 202)
    const record = await server.jobs.store.get(workspace.id, `job-${racing}`)
    assert.deepEqual(Buffer.from((await server.jobs.blobs.read(record.record.source.originalBlobName)).bytes), alternatives[winner])
  } finally { await server.close() }
})

test('Markdown job downloads fail closed for corrupt content metadata and URL Markdown captures', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const { job } = await (await importMarkdown(server, workspace.id)).json()
    const saved = await server.jobs.store.get(workspace.id, job.job.id)
    const url = `${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${job.job.id}/original`
    for (const change of [
      { originalContentType: 'application/pdf' }, { originalContentType: 'text/html' },
      { originalContentType: 'application/octet-stream' }, { sha256: 'a'.repeat(64) },
      { bytes: saved.record.source.bytes + 1 }, { finalUrl: 'https://example.com/forged' },
      { kind: 'url', url: 'https://example.com/role.md' },
    ]) {
      const current = await server.jobs.store.get(workspace.id, job.job.id)
      await server.jobs.store.replace({
        ...saved.record, source: { ...saved.record.source, ...change },
        job: { ...saved.record.job, source: change.kind ?? saved.record.job.source },
      }, current.etag)
      assert.equal((await fetch(url, { headers: authHeaders() })).status, 503)
    }
  } finally { await server.close() }
})

test('URL ingestion rejects unsafe inputs and publishes a truthful queued record without fetching', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    for (const url of [
      'ftp://example.com/job',
      'http://user:password@example.com/job',
      'http://127.0.0.1/job',
      'http://169.254.169.254/latest/meta-data',
      'https://example.com:8443/job',
      'not a url',
    ]) {
      const response = await importUrl(server, workspace.id, url)
      assert.equal(response.status, 400, url)
    }

    const key = randomUUID()
    const response = await importUrl(server, workspace.id, 'https://jobs.example.com/openings/42#requirements', { key })
    assert.equal(response.status, 202)
    const { job } = await response.json()
    assert.equal(job.job.title, 'jobs.example.com')
    assert.equal(job.job.sourceLabel, 'https://jobs.example.com/openings/42#requirements')
    assert.equal(job.source.url, 'https://jobs.example.com/openings/42#requirements')
    assert.equal(job.source.originalBlobName, undefined)
    assert.equal(server.jobs.publicationEvents.at(-1).type, 'job')
  } finally {
    await server.close()
  }
})

test('job records are membership-isolated and never enter the legacy workspace snapshot', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server, ALLOWED_OID)
    const imported = await importUrl(server, workspace.id, 'https://example.com/jobs/isolated')
    assert.equal(imported.status, 202)
    const jobId = (await imported.json()).job.job.id

    const otherList = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs`, {
      headers: authHeaders({ oid: OTHER_ALLOWED_OID }),
    })
    assert.equal(otherList.status, 404)
    const otherDetail = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}`, {
      headers: authHeaders({ oid: OTHER_ALLOWED_OID }),
    })
    assert.equal(otherDetail.status, 404)

    const stateResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/state`, { headers: authHeaders() })
    const snapshot = await stateResponse.json()
    assert.equal(snapshot.workspace.jobs.some((job) => job.id === jobId || job.dataKind === 'real'), false)
  } finally {
    await server.close()
  }
})

test('cancel and retry use CAS, clear leases, and prevent a stale worker publication', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const imported = await importUrl(server, workspace.id, 'https://example.com/jobs/retry')
    const jobId = (await imported.json()).job.job.id
    const before = await server.jobs.store.get(workspace.id, jobId)
    const leased = await server.jobs.store.replace({
      ...before.record,
      attempts: 3,
      lease: { owner: 'worker-1', expiresAt: '2026-09-17T15:00:00.000Z' },
    }, before.etag)

    const cancelledResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: writeHeaders(),
    })

    assert.equal(cancelledResponse.status, 200)
    const cancelled = (await cancelledResponse.json()).job
    assert.equal(cancelled.job.status, 'cancelled')
    const cancelledRecord = await server.jobs.store.get(workspace.id, jobId)
    assert.equal(cancelledRecord.record.lease, undefined)

    await assert.rejects(
      server.jobs.store.publish(
        { ...leased.record, job: { ...leased.record.job, status: 'ready', rubricId: `rubric-${jobId}` } },
        leased.etag,
        {
          id: `rubric-${jobId}`, groupId: `rubric-${jobId}`, kind: 'job', jobId, name: 'Stale', description: 'Stale',
          version: 1, criteria: [], createdAt: '2026-09-17T14:00:00.000Z', dataKind: 'real',
          provenance: { kind: 'generated', model: 'model', promptVersion: 'v1' },
        },
      ),
      StoreConflictError,
    )

    const retriedResponse = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}/retry`, {
      method: 'POST',
      headers: writeHeaders(),
    })
    assert.equal(retriedResponse.status, 200)
    const retried = (await retriedResponse.json()).job
    assert.equal(retried.job.status, 'queued')
    assert.equal(retried.attempts, 0)
    assert.equal(retried.error, undefined)

    server.jobs.store._failNextReplace()
    const racedCancel = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: writeHeaders(),
    })
    assert.equal(racedCancel.status, 409)
    assert.equal((await server.jobs.store.get(workspace.id, jobId)).record.job.status, 'queued')
  } finally {
    await server.close()
  }
})

test('pending polling recovers active jobs whose lease expired after nextAttemptAt was cleared', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const imported = await importUrl(server, workspace.id, 'https://example.com/jobs/lease-recovery')
    const jobId = (await imported.json()).job.job.id
    const queued = await server.jobs.store.get(workspace.id, jobId)
    await server.jobs.store.replace({
      ...queued.record,
      job: { ...queued.record.job, status: 'parsing' },
      nextAttemptAt: undefined,
      lease: { owner: 'crashed-worker', expiresAt: '2026-09-17T13:59:00.000Z' },
    }, queued.etag)

    const pending = await server.jobs.store.listPending('2026-09-17T14:00:00.000Z', 10)
    assert.deepEqual(pending.map((value) => value.record.id), [jobId])
  } finally {
    await server.close()
  }
})

test('original source download is authorized, no-store, nosniff, and an attachment', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const imported = await importPdf(server, workspace.id, { filename: 'Résumé role.pdf' })
    const { job } = await imported.json()
    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${job.job.id}/original`, {
      headers: authHeaders(),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/pdf')
    assert.match(response.headers.get('content-disposition'), /^attachment;/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(Buffer.from(await response.arrayBuffer()).toString('ascii'), /^%PDF-/)
  } finally {
    await server.close()
  }
})

test('a URL source resolved as PDF downloads as a PDF attachment without changing source kind', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const imported = await importUrl(server, workspace.id, 'https://jobs.example.com/posting/42')
    const jobId = (await imported.json()).job.job.id
    const current = await server.jobs.store.get(workspace.id, jobId)
    const blobName = `${workspace.id}/${jobId}/original.pdf`
    const bytes = Buffer.from('%PDF-1.7\nURL PDF source', 'ascii')
    const saved = await server.jobs.blobs.putImmutable(blobName, bytes, 'application/pdf')
    await server.jobs.store.replace({
      ...current.record,
      source: {
        ...current.record.source,
        originalBlobName: blobName,
        originalContentType: 'application/pdf',
        finalUrl: 'https://cdn.example.com/posting-42.pdf',
        sha256: saved.blob.sha256,
        bytes: bytes.byteLength,
      },
    }, current.etag)

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}/original`, {
      headers: authHeaders(),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/pdf')
    assert.match(response.headers.get('content-disposition'), /filename="cdn\.example\.com\.pdf"/)
    assert.equal((await server.jobs.store.get(workspace.id, jobId)).record.source.kind, 'url')
  } finally {
    await server.close()
  }
})

test('rubric edits require grounded citations and append an immutable version under job ETag CAS', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await bootstrap(server)
    const imported = await importPdf(server, workspace.id)
    const initialSummary = (await imported.json()).job
    const jobId = initialSummary.job.id
    const current = await server.jobs.store.get(workspace.id, jobId)
    const document = {
      id: current.record.job.documentId,
      title: 'Principal Engineer',
      kind: 'job',
      version: 1,
      paragraphs: [{ id: 'paragraph-1', page: 1, heading: 'Requirements', text: 'Must lead distributed systems delivery.' }],
      sample: false,
    }
    const documentBlobName = `${workspace.id}/${jobId}/source-document.json`
    await server.jobs.blobs.putImmutable(documentBlobName, Buffer.from(JSON.stringify(document)), 'application/json')
    const rubricId = `rubric-${jobId}`
    const citation = {
      documentId: document.id,
      documentVersion: 1,
      paragraphId: 'paragraph-1',
      page: 1,
      heading: 'Requirements',
      quote: 'Must lead distributed systems delivery.',
    }
    const generated = {
      id: rubricId,
      groupId: rubricId,
      kind: 'job',
      jobId,
      name: 'Principal Engineer rubric',
      description: 'Grounded requirements',
      version: 1,
      criteria: [{
        id: 'criterion-1',
        key: 'custom',
        label: 'Distributed systems leadership',
        description: 'Leads distributed systems delivery.',
        weight: 100,
        guidance: 'Look for direct leadership evidence.',
        requirementType: 'required',
        sourceCitations: [citation],
      }],
      createdAt: '2026-09-17T14:00:00.000Z',
      dataKind: 'real',
      provenance: { kind: 'generated', model: 'gpt-test', promptVersion: 'rubric-v1' },
    }
    const readyRecord = {
      ...current.record,
      job: { ...current.record.job, status: 'ready', rubricId },
      extractedBlobName: documentBlobName,
      nextAttemptAt: undefined,
      updatedAt: '2026-09-17T14:00:00.000Z',
    }
    const ready = await server.jobs.store.publish(readyRecord, current.etag, generated)

    const ungrounded = clone(generated)
    ungrounded.criteria[0].sourceCitations[0].quote = 'invented quote'
    const rejected = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}/rubric`, {
      method: 'PUT',
      headers: writeHeaders(ALLOWED_OID, { 'content-type': 'application/json', 'if-match': ready.etag }),
      body: JSON.stringify({ rubric: ungrounded }),
    })
    assert.equal(rejected.status, 400)
    assert.equal((await server.jobs.store.listRubrics(workspace.id, jobId)).length, 1)

    const editedInput = {
      ...generated,
      groupId: 'client-must-not-control-this',
      version: 99,
      createdAt: '1999-01-01T00:00:00.000Z',
      provenance: { kind: 'generated', model: 'client-model', promptVersion: 'client-prompt' },
      name: 'Edited grounded rubric',
    }
    const accepted = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}/rubric`, {
      method: 'PUT',
      headers: writeHeaders(ALLOWED_OID, { 'content-type': 'application/json', 'if-match': ready.etag }),
      body: JSON.stringify({ rubric: editedInput }),
    })
    assert.equal(accepted.status, 200)
    const detail = (await accepted.json()).job
    assert.equal(detail.document.sample, false)
    assert.equal(detail.rubric.version, 2)
    assert.equal(detail.rubric.groupId, generated.groupId)
    assert.deepEqual(detail.rubric.provenance, { kind: 'edited', model: 'gpt-test', promptVersion: 'rubric-v1' })
    assert.equal(detail.rubricVersions.length, 2)

    const stale = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}/rubric`, {
      method: 'PUT',
      headers: writeHeaders(ALLOWED_OID, { 'content-type': 'application/json', 'if-match': ready.etag }),
      body: JSON.stringify({ rubric: editedInput }),
    })
    assert.equal(stale.status, 409)
    assert.equal((await server.jobs.store.listRubrics(workspace.id, jobId)).length, 2)
  } finally {
    await server.close()
  }
})
