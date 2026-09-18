import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { docxFile, legacyDocFile } from '../../server-tests/word-fixtures.mjs'

let outputDirectory
let client
let projection
let requests
const originalFetch = globalThis.fetch

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function summary(id, updatedAt, rubric = null) {
  return {
    job: {
      id,
      title: id,
      organization: 'Agency',
      location: 'Remote',
      arrangement: 'Remote',
      employmentType: 'Full time',
      grade: 'N/A',
      series: 'N/A',
      source: 'url',
      sourceLabel: `https://example.test/${id}`,
      documentId: `document-${id}`,
      rubricId: rubric?.id ?? null,
      status: rubric ? 'ready' : 'queued',
      createdAt: updatedAt,
      dataKind: 'real',
    },
    source: { kind: 'url', displayName: id, url: `https://example.test/${id}` },
    rubric,
    etag: `"${id}"`,
    updatedAt,
    attempts: 1,
    warnings: [],
  }
}

before(async () => {
  outputDirectory = resolve(`.real-job-client-tests-${randomUUID()}`)
  await mkdir(outputDirectory)
  const outfile = join(outputDirectory, 'realJobs.mjs')
  await build({
    entryPoints: ['src/services/realJobs.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' },
    logLevel: 'silent',
  })
  client = await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`)
  const projectionOutfile = join(outputDirectory, 'realJobsProjection.mjs')
  await build({
    entryPoints: ['src/app/realJobsProjection.ts'],
    outfile: projectionOutfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  })
  projection = await import(`${pathToFileURL(projectionOutfile).href}?test=${Date.now()}`)
})

after(async () => {
  globalThis.fetch = originalFetch
  await rm(outputDirectory, { recursive: true, force: true })
})

beforeEach(() => {
  requests = []
})

test('loads every jobs page with the fixed rubric summary field', async () => {
  const rubric = {
    id: 'rubric-2',
    groupId: 'group-2',
    kind: 'job',
    jobId: 'job-2',
    name: 'Grounded rubric',
    description: 'Generated from source',
    version: 1,
    criteria: [],
    createdAt: '2026-09-17T00:00:00.000Z',
    dataKind: 'real',
  }
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return requests.length === 1
      ? json({ jobs: [summary('job-1', '2026-09-17T00:00:00.000Z')], continuationToken: 'next page' })
      : json({ jobs: [summary('job-2', '2026-09-17T00:01:00.000Z', rubric)] })
  }

  const jobs = await client.listAllRealJobs('workspace / one')

  assert.deepEqual(jobs.map((item) => item.job.id), ['job-1', 'job-2'])
  assert.equal(jobs[1].rubric.id, 'rubric-2')
  assert.equal(requests[0].url, '/api/workspaces/workspace%20%2F%20one/jobs')
  assert.equal(requests[1].url, '/api/workspaces/workspace%20%2F%20one/jobs?continuationToken=next%20page')
  assert.equal(requests[0].init.credentials, 'include')
  assert.equal(requests[0].init.cache, 'no-store')
})

test('uploads actual PDF bytes with stable request metadata', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json({ job: summary('pdf-job', '2026-09-17T00:00:00.000Z') }, 202)
  }
  const file = new File([new Uint8Array([37, 80, 68, 70])], 'role details.pdf', { type: 'application/pdf' })

  await client.importRealJobPdf('workspace-1', file, 'stable-key', 'batch-key')

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/workspaces/workspace-1/jobs/pdf')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.headers.get('Content-Type'), 'application/pdf')
  assert.equal(requests[0].init.headers.get('X-File-Name'), 'role%20details.pdf')
  assert.equal(requests[0].init.headers.get('Idempotency-Key'), 'stable-key')
  assert.equal(requests[0].init.headers.get('X-Import-Batch'), 'batch-key')
  assert.equal(requests[0].init.headers.get('X-Score-Request'), 'workspace')
  assert.deepEqual([...new Uint8Array(requests[0].init.body)], [37, 80, 68, 70])
})

test('Word capability is fail-closed and legacy byte limits remain compatible', async () => {
  globalThis.fetch = async () => json({ realJobImports: true, limits: { maxPdfBytes: 9 * 1024 * 1024 } })
  const old = await client.fetchJobProcessingFeatures()
  assert.equal(old.wordDocumentImports, false)
  assert.equal(old.limits.maxFileBytes, 9 * 1024 * 1024)
  assert.equal(old.limits.maxPdfPages, 50)
  globalThis.fetch = async () => json({ realJobImports: true, wordDocumentImports: true })
  assert.equal((await client.fetchJobProcessingFeatures()).wordDocumentImports, true)
})

test('generic job file uploads preserve Word bytes and retry keys while keeping PDF on its legacy endpoint', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ job: summary('file-job', '2026-09-17T00:00:00.000Z') }, 202) }
  const files = [
    [new File([docxFile()], 'Rôle.DOCX'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'file'],
    [new File([legacyDocFile()], 'Legacy.DOC', { type: 'application/octet-stream' }), 'application/msword', 'file'],
    [new File(['%PDF-source'], 'Role.PDF'), 'application/pdf', 'pdf'],
  ]
  for (const [file, type, endpoint] of files) {
    const key = randomUUID()
    await client.importRealJobFile('workspace-one', file, key, 'unchanged-batch')
    await client.importRealJobFile('workspace-one', file, key, 'unchanged-batch')
    const pair = requests.slice(-2)
    for (const request of pair) {
      assert.equal(request.url, `/api/workspaces/workspace-one/jobs/${endpoint}`)
      assert.equal(request.init.headers.get('Content-Type'), type)
      assert.equal(request.init.headers.get('X-File-Name'), encodeURIComponent(file.name))
      assert.equal(request.init.headers.get('Idempotency-Key'), key)
      assert.equal(request.init.headers.get('X-Import-Batch'), 'unchanged-batch')
      assert.equal(request.init.credentials, 'include')
      assert.deepEqual(new Uint8Array(request.init.body), new Uint8Array(await file.arrayBuffer()))
    }
  }
  const before = requests.length
  await assert.rejects(client.importRealJobPdf('w', files[0][0], 'key'), /DOCX uploads are not enabled/)
  await assert.rejects(client.importRealJobFile('w', new File(['x'], 'macro.docm'), 'key'), /Other formats/)
  await assert.rejects(client.importRealJobFile('w', new File([docxFile()], 'docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }), 'key'), /supported file/)
  await assert.rejects(client.importRealJobFile('w', new File([], 'empty.docx'), 'key'), /empty/)
  assert.equal(requests.length, before)
})

test('sends direct URL imports as JSON with the same idempotency key', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json({ job: summary('url-job', '2026-09-17T00:00:00.000Z') }, 202)
  }

  await client.importRealJobUrl('workspace-1', 'https://example.test/jobs/42', 'stable-url-key', 'batch-key')

  assert.equal(requests[0].init.headers.get('Idempotency-Key'), 'stable-url-key')
  assert.equal(requests[0].init.headers.get('Content-Type'), 'application/json')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    url: 'https://example.test/jobs/42',
    batchId: 'batch-key',
  })
})

test('projects server records over colliding sample ids without mutating legacy state', () => {
  const updatedAt = '2026-09-17T00:00:00.000Z'
  const server = summary('shared-job', updatedAt)
  server.job.documentId = 'shared-document'
  server.job.rubricId = 'shared-rubric'
  const legacy = {
    schemaVersion: 1,
    jobs: [{ ...server.job, title: 'Sample collision', dataKind: undefined }],
    resumes: [],
    documents: [{ id: 'shared-document', title: 'Fictional filler', kind: 'job', version: 1, paragraphs: [], sample: true }],
    rubrics: [{
      id: 'shared-rubric',
      groupId: 'sample-group',
      kind: 'job',
      jobId: 'shared-job',
      name: 'Sample collision',
      description: 'Must not leak into the real job',
      version: 1,
      criteria: [],
      createdAt: updatedAt,
    }],
    runs: [],
  }

  const projected = projection.projectRealJobs(legacy, [server], [])

  assert.equal(projected.jobs[0].dataKind, 'real')
  assert.equal(projected.documents.some((document) => document.id === 'shared-document'), false)
  assert.equal(projected.rubrics.some((rubric) => rubric.id === 'shared-rubric'), false)
  assert.equal(legacy.documents[0].sample, true)
  assert.equal(legacy.jobs[0].title, 'Sample collision')
})

test('unwraps authoritative rubric detail from the PUT job envelope', async () => {
  const first = {
    id: 'rubric-v1',
    groupId: 'group-1',
    kind: 'job',
    jobId: 'job-1',
    name: 'Generated rubric',
    description: 'Generated',
    version: 1,
    criteria: [],
    createdAt: '2026-09-17T00:00:00.000Z',
    dataKind: 'real',
  }
  const edited = {
    ...first,
    id: 'rubric-v2',
    name: 'Reviewed rubric',
    description: 'Reviewed',
    version: 2,
    createdAt: '2026-09-17T00:01:00.000Z',
    provenance: { kind: 'edited', model: 'test-model', promptVersion: 'test-prompt' },
  }
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json({
      job: {
        ...summary('job-1', edited.createdAt, edited),
        document: null,
        rubricVersions: [first, edited],
      },
    })
  }

  const detail = await client.saveRealJobRubric('workspace-1', 'job-1', edited, '"etag-1"')

  assert.equal(detail.rubric.id, 'rubric-v2')
  assert.equal(detail.rubricVersions.at(-1).id, 'rubric-v2')
  assert.equal(requests[0].init.headers.get('If-Match'), '"etag-1"')
  assert.deepEqual(JSON.parse(requests[0].init.body), { rubric: edited })
})
