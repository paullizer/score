import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { createApp, StoreConflictError, createDefaultAdminSettings, captureProcessingSettings } from '../dist-server/app.mjs'
import { PDFDocument } from 'pdf-lib'
import {
  ALLOWED_OID,
  APP_ORIGIN,
  OTHER_ALLOWED_OID,
  authHeaders,
  baseConfig,
  createFakeAccessStore,
  createFakeDirectoryStore,
  createFakeStateStore,
  membershipFor,
  seedWorkspace,
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

async function startRealJobsServer(settings, runtimeEnabled = true) {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  const jobs = createFakeRealJobs()
  const config = baseConfig({ realJobs: REAL_JOBS_CONFIG, ...(settings ? { settings: { runtimeEnabled } } : {}) })
  const app = createApp({
    config,
    directory,
    state,
    accessStore: createFakeAccessStore(),
    jobs: { store: jobs.store, blobs: jobs.blobs },
    settings,
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
    config,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('job policy rejects direct feature/format/URL/size/page bypass and restricts original bytes without granting workspace access', async () => {
    let value = createDefaultAdminSettings(), outage = false, reads = 0
    const settings = { async capture() {
      reads++
      if (outage) throw new Error('Settings unavailable')
      return captureProcessingSettings(value, 'job-policy-one', '2026-09-17T14:00:00.000Z')
    } }
    const server = await startRealJobsServer(settings)
    try {
      const workspace = await seedWorkspace(server)
      value.features.jobImports = false
      assert.equal((await importPdf(server, workspace.id)).status, 503)
      value.features.jobImports = true
      value.maintenance.pauseNewWork = true
      assert.equal((await importMarkdown(server, workspace.id)).status, 503)
      value.maintenance.pauseNewWork = false
      value.imports.jobs.allowedFormats = ['pdf']
      assert.equal((await importMarkdown(server, workspace.id)).status, 403)
      value.imports.jobs.allowUrls = false
      assert.equal((await importUrl(server, workspace.id, 'https://example.com/role')).status, 403)
      value.imports.jobs.allowUrls = true
      value.imports.urls.requireHttps = true
      assert.equal((await importUrl(server, workspace.id, 'http://example.com/role')).status, 400)
      value.imports.urls.jobs.blockedHosts = [{ hostname: 'example.com', includeSubdomains: true }]
      assert.equal((await importUrl(server, workspace.id, 'https://sub.example.com/role')).status, 400)
      value = createDefaultAdminSettings()
      value.imports.jobs.maxFileBytes = 10
      assert.equal((await importPdf(server, workspace.id)).status, 413)
      value.imports.jobs.maxFileBytes = 10 * 1024 * 1024
      value.imports.jobs.maxPdfPages = 1
      const pdf = await PDFDocument.create()
      pdf.addPage(); pdf.addPage()
      assert.equal((await importPdf(server, workspace.id, { bytes: await pdf.save() })).status, 400)
      value.imports.jobs.maxPdfPages = 50
      const key = randomUUID()
      const response = await importPdf(server, workspace.id, { key })
      assert.equal(response.status, 202, await response.clone().text())
      const accepted = (await response.json()).job
      const current = await server.jobs.store.get(workspace.id, accepted.job.id)
      assert.equal(current.record.processingSettings.revision, 'job-policy-one')
      const path = `${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${accepted.job.id}`
      value.documents.originalDownloadRoles = ['owner']
      assert.equal((await fetch(`${path}/original`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 404)
      server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
      assert.equal((await fetch(`${path}/original`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 403)
      assert.equal((await fetch(path, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 200)
      value.documents.formattedDocxPreviewEnabled = false
      assert.equal((await fetch(`${path}/original?preview=formatted`, { headers: authHeaders() })).status, 403)
      assert.equal((await fetch(`${path}/original`, { headers: authHeaders() })).status, 200)
      value.features.jobImports = false
      const before = reads
      assert.equal((await importPdf(server, workspace.id, { key })).status, 200)
      assert.equal(reads, before)
      outage = true
      assert.equal((await importPdf(server, workspace.id)).status, 503)
      assert.equal((await fetch(path, { headers: authHeaders() })).status, 200)
      assert.equal((await fetch(`${path}/original`, { headers: authHeaders() })).status, 503)
      assert.equal((await fetch(`${path}/cancel`, { method: 'POST', headers: writeHeaders() })).status, 200)
      assert.equal((await fetch(`${path}/retry`, { method: 'POST', headers: writeHeaders() })).status, 200)
      assert.deepEqual((await server.jobs.store.get(workspace.id, accepted.job.id)).record.processingSettings, current.record.processingSettings)
    } finally { await server.close() }
})

test('configured job rollout blocks new admissions without weakening saved download policy or accepted retries', async () => {
  const value = createDefaultAdminSettings()
  value.documents.originalDownloadRoles = ['owner']
  value.documents.formattedDocxPreviewEnabled = false
  const settings = { async capture() { return captureProcessingSettings(value, 'job-rollout-policy', '2026-09-17T14:00:00.000Z') } }
  const server = await startRealJobsServer(settings, false)
  try {
    const workspace = await seedWorkspace(server)
    assert.equal((await importPdf(server, workspace.id)).status, 503)
    assert.equal((await importUrl(server, workspace.id, 'https://example.com/role')).status, 503)
    server.config.settings.runtimeEnabled = true
    const key = randomUUID()
    const pinned = (await (await importPdf(server, workspace.id, { key })).json()).job
    const captured = (await server.jobs.store.get(workspace.id, pinned.job.id)).record.processingSettings
    assert.equal(captured.revision, 'job-rollout-policy')
    server.config.settings.runtimeEnabled = false
    const path = `${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${pinned.job.id}`
    server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
    assert.equal((await fetch(`${path}/original`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 403)
    assert.equal((await fetch(`${path}/original?preview=formatted`, { headers: authHeaders() })).status, 403)
    assert.equal((await fetch(`${path}/original`, { headers: authHeaders() })).status, 200)
    assert.equal((await fetch(path, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 200)
    assert.equal((await importPdf(server, workspace.id, { key })).status, 200)
    assert.equal((await fetch(`${path}/cancel`, { method: 'POST', headers: writeHeaders() })).status, 200)
    assert.equal((await fetch(`${path}/retry`, { method: 'POST', headers: writeHeaders() })).status, 200)
    assert.deepEqual((await server.jobs.store.get(workspace.id, pinned.job.id)).record.processingSettings, captured)
    assert.equal((await importPdf(server, workspace.id)).status, 503)
  } finally { await server.close() }
})

function writeHeaders(oid = ALLOWED_OID, extra = {}) {
  return { ...authHeaders({ oid }), ...CSRF, ...extra }
}

test('revoking the submitter does not cancel or delete an accepted workspace-owned import', async t => {
  const server = await startRealJobsServer()
  t.after(() => server.close())
  const workspace = await seedWorkspace(server)
  server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'editor' }))
  const imported = await importPdf(server, workspace.id, { oid: OTHER_ALLOWED_OID })
  assert.equal(imported.status, 202)
  const job = (await imported.json()).job
  const before = await server.jobs.store.get(workspace.id, job.job.id)
  const root = `${server.baseUrl}/api/workspaces/${workspace.id}`
  const memberList = await fetch(`${root}/members`, { headers: authHeaders() })
  assert.equal(memberList.status, 200)
  const removal = await fetch(`${root}/members/${OTHER_ALLOWED_OID}`, {
    method: 'DELETE', headers: writeHeaders(ALLOWED_OID, { 'If-Match': (await memberList.json()).etag }),
  })
  assert.equal(removal.status, 200)
  assert.equal((await fetch(`${root}/jobs/${job.job.id}`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 404)
  assert.equal((await fetch(`${root}/jobs/${job.job.id}`, { headers: authHeaders() })).status, 200)
  assert.equal((await fetch(`${root}/jobs/${job.job.id}/original`, { headers: authHeaders() })).status, 200)
  assert.deepEqual(await server.jobs.store.get(workspace.id, job.job.id), before)
})

test('application Admin original-download policy is owner-equivalent with no membership or an explicit viewer membership', async t => {
  const policy = createDefaultAdminSettings()
  policy.documents.originalDownloadRoles = ['owner']
  const server = await startRealJobsServer({
    async capture() { return captureProcessingSettings(policy, 'owner-downloads', '2026-09-22T13:00:00.000Z') },
  })
  t.after(() => server.close())
  const workspace = await seedWorkspace(server)
  const imported = await importPdf(server, workspace.id)
  assert.equal(imported.status, 202)
  const job = (await imported.json()).job
  const path = `${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${job.job.id}/original`
  const admin = authHeaders({ oid: OTHER_ALLOWED_OID, roles: ['Score.Admin'] })
  assert.equal((await fetch(path, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 404)
  assert.equal((await fetch(path, { headers: admin })).status, 200)
  server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
  assert.equal((await fetch(path, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 403)
  assert.equal((await fetch(path, { headers: admin })).status, 200)
  assert.equal((await server.directory.getMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }).id)).role, 'viewer')
})

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

test('job metadata PATCH validates strict aliases, authorization and exact ETags without changing source or worker state', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await seedWorkspace(server)
    const imported = (await (await importPdf(server, workspace.id)).json()).job
    const initial = await server.jobs.store.get(workspace.id, imported.job.id)
    const leased = await server.jobs.store.replace({
      ...initial.record, attempts: 1, lease: { owner: 'worker', expiresAt: '2026-09-17T15:00:00.000Z' },
      job: { ...initial.record.job, status: 'parsing' },
    }, initial.etag)
    const path = `${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${imported.job.id}/metadata`
    const patch = (body = { displayName: 'Custom title' }, extra = {}) => fetch(path, {
      method: 'PATCH', headers: writeHeaders(ALLOWED_OID, { 'content-type': 'application/json', 'if-match': leased.etag, ...extra }),
      body: JSON.stringify(body),
    })
    assert.equal((await fetch(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
    assert.equal((await patch(undefined, { ...authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 404)
    server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
    assert.equal((await patch(undefined, { ...authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 403)
    for (const [headers, status] of [
      [{ origin: 'https://foreign.example' }, 403], [{ 'x-score-request': '' }, 403],
      [{ 'if-match': '' }, 428], [{ 'if-match': '*' }, 400], [{ 'if-match': `W/${leased.etag}` }, 400],
      [{ 'if-match': `${leased.etag}, "other"` }, 400], [{ 'if-match': '"stale"' }, 409],
    ]) assert.equal((await patch(undefined, headers)).status, status)
    for (const body of [
      {}, null, [], { displayName: 1 }, { displayName: '' }, { displayName: '   ' },
      { displayName: 'x'.repeat(161) }, { displayName: 'control\u0000' }, { displayName: 'line\nbreak' },
      { displayName: 'Name', title: 'Replace extracted title' }, { displayName: 'Name', source: imported.source },
      { displayName: 'Name', job: imported.job }, { displayName: 'Name', status: 'ready' },
    ]) assert.equal((await patch(body)).status, 400, JSON.stringify(body))
    const response = await patch({ displayName: ` ${'j'.repeat(160)} ` })
    assert.equal(response.status, 200, await response.clone().text())
    const { job } = await response.json()
    assert.equal(response.headers.get('etag'), job.etag)
    assert.equal(job.displayName, 'j'.repeat(160))
    assert.notEqual(job.etag, leased.etag)
    assert.deepEqual((await server.jobs.store.get(workspace.id, imported.job.id)).record,
      { ...leased.record, displayName: 'j'.repeat(160) })
    assert.deepEqual(job.job, leased.record.job)
    assert.deepEqual(job.source, imported.source)
    assert.equal((await patch()).status, 409)
    const detail = await (await fetch(path.replace(/\/metadata$/, ''), { headers: authHeaders() })).json()
    assert.equal(detail.displayName, 'j'.repeat(160))
    assert.equal(detail.job.displayName, undefined)
    const listed = await (await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs`, { headers: authHeaders() })).json()
    assert.equal(listed.jobs[0].displayName, 'j'.repeat(160))
    const original = await fetch(path.replace(/\/metadata$/, '/original'), { headers: authHeaders() })
    assert.equal(original.status, 200)
    assert.match(original.headers.get('content-disposition'), /Principal Engineer/)
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), Buffer.from('%PDF-1.7\nreal job source\n', 'ascii'))

    server.jobs.store._failNextReplace()
    assert.equal((await patch({ displayName: 'Lost race' }, { 'if-match': job.etag })).status, 409)
    assert.equal((await server.jobs.store.get(workspace.id, imported.job.id)).record.displayName, 'j'.repeat(160))
    const archived = await server.jobs.store.transitionLifecycle(workspace.id, imported.job.id, job.etag, 'job', 'archive', leased.record.updatedAt)
    assert.equal((await patch(undefined, { 'if-match': archived.etag })).status, 409)
    const restored = await server.jobs.store.transitionLifecycle(workspace.id, imported.job.id, archived.etag, 'job', 'unarchive', leased.record.updatedAt)
    await server.jobs.store.setWorkspaceLifecycle(workspace.id, 'archived', leased.record.updatedAt)
    assert.equal((await patch(undefined, { 'if-match': restored.etag })).status, 409)
    await server.jobs.store.setWorkspaceLifecycle(workspace.id, 'active', leased.record.updatedAt)
    const deleting = await server.jobs.store.transitionLifecycle(workspace.id, imported.job.id, restored.etag, 'job', 'delete', leased.record.updatedAt)
    assert.equal((await patch(undefined, { 'if-match': deleting.etag })).status, 409)
  } finally { await server.close() }
})

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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(disabled)
    const response = await importMarkdown(disabled, workspace.id, { bytes: Buffer.alloc(MAX_MARKDOWN + 1, 'x') })
    assert.equal(response.status, 503)
  } finally { await disabled.close() }
})

test('Markdown job idempotency preserves the winner and rejects changed bytes, filename, batch, or source kind', async () => {
  const server = await startRealJobsServer()
  try {
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server, { oid: ALLOWED_OID })
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
    const workspace = await seedWorkspace(server)
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
  const policy = createDefaultAdminSettings()
  let outage = false
  const server = await startRealJobsServer({ async capture() {
    if (outage) throw new Error('Settings unavailable')
    return captureProcessingSettings(policy, 'rubric-policy', '2026-09-17T14:00:00.000Z')
  } })
  try {
    const workspace = await seedWorkspace(server)
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
    const update = (rubric, etag) => fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}/rubric`, {
      method: 'PUT', headers: writeHeaders(ALLOWED_OID, { 'content-type': 'application/json', 'if-match': etag }),
      body: JSON.stringify({ rubric }),
    })
    const larger = { ...detail.rubric, criteria: [
      { ...detail.rubric.criteria[0], weight: 50 },
      { ...detail.rubric.criteria[0], id: 'criterion-2', label: 'Additional supported criterion', weight: 50 },
    ] }
    const expanded = await update(larger, detail.etag)
    assert.equal(expanded.status, 200, await expanded.clone().text())
    const existingLarger = (await expanded.json()).job
    policy.rubrics.jobs.maxCriteria = 1
    const addition = { ...existingLarger.rubric, criteria: [
      ...existingLarger.rubric.criteria.map(criterion => ({ ...criterion, weight: 33 })),
      { ...existingLarger.rubric.criteria[0], id: 'criterion-3', label: 'New criterion', weight: 34 },
    ] }
    assert.equal((await update(addition, existingLarger.etag)).status, 400)
    outage = true
    assert.equal((await update({ ...existingLarger.rubric, name: 'Historical larger rubric edit' }, existingLarger.etag)).status, 200)
  } finally {
    await server.close()
  }
})
