import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp, StoreConflictError } from '../dist-server/app.mjs'
import {
  ALLOWED_OID,
  APP_ORIGIN,
  OTHER_ALLOWED_OID,
  authHeaders,
  baseConfig,
  createFakeDirectoryStore,
  createFakeStateStore,
  startTestServer,
} from './helpers.mjs'
import { createFakeRealJobs } from './job-lifecycle-fakes.mjs'

const CSRF = { origin: APP_ORIGIN, 'x-score-request': 'workspace' }
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
    }),
    body: bytes,
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
    assert.equal(body.limits.maxPdfBytes, 10 * 1024 * 1024)
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
  } finally {
    await server.close()
  }
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
