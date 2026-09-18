import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let outputDirectory
let client
let projection
let requests

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
  outputDirectory = resolve(`.real-jobs-client-tests-${randomUUID()}`)
  await mkdir(outputDirectory)
  const outfile = join(outputDirectory, 'realJobs.mjs')
  await build({
    entryPoints: [join('src', 'services', 'realJobs.ts')],
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
    entryPoints: [join('src', 'app', 'realJobsProjection.ts')],
    outfile: projectionOutfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  })
  projection = await import(`${pathToFileURL(projectionOutfile).href}?test=${Date.now()}`)
})

after(async () => {
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
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.headers.get('Content-Type'), 'application/pdf')
  assert.equal(requests[0].init.headers.get('X-File-Name'), 'role%20details.pdf')
  assert.equal(requests[0].init.headers.get('Idempotency-Key'), 'stable-key')
  assert.equal(requests[0].init.headers.get('X-Import-Batch'), 'batch-key')
  assert.equal(requests[0].init.headers.get('X-Score-Request'), 'workspace')
  assert.deepEqual([...new Uint8Array(requests[0].init.body)], [37, 80, 68, 70])
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

test('lifecycle preview and mutation use logical scope, exact ETag, and preserve incomplete acknowledgement', async () => {
  const impact = { target: { kind: 'rubric', id: 'logical-group' }, name: 'Saved rubric', counts: { rubricVersions: 3 }, blockers: [] }
  const operation = { id: 'pending-op', action: 'delete', status: 'running', updatedAt: '2026-09-18T00:00:00.000Z' }
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return init.method === 'POST' ? json({ operation }, 202) : json({ impact })
  }
  assert.deepEqual(await client.getRealJobLifecycleImpact('workspace one', 'job/one', 'rubric'), impact)
  const result = await client.changeRealJobLifecycle('workspace one', 'job/one', 'rubric', 'delete', '"exact-etag"')
  assert.equal(requests[0].url, '/api/workspaces/workspace%20one/jobs/job%2Fone/lifecycle?scope=rubric')
  assert.equal(requests[1].init.headers.get('If-Match'), '"exact-etag"')
  assert.deepEqual(JSON.parse(requests[1].init.body), { action: 'delete', scope: 'rubric' })
  assert.deepEqual(result.operation, operation)
  assert.equal(result.deleted, undefined)
})

test('authoritative projections discard stale deleted rubric details and never write real lifecycle into samples', () => {
  const time = '2026-09-18T00:00:00.000Z'
  const rubric = { id: 'old-version', groupId: 'real-group', jobId: 'real-job', kind: 'job', name: 'Real rubric', description: '', version: 1, criteria: [], createdAt: time, dataKind: 'real' }
  const old = summary('real-job', time, rubric)
  const legacy = { schemaVersion: 1, jobs: [], resumes: [], documents: [], rubrics: [], runs: [], lifecycle: { entities: { 'resume:sample-resume': { archivedAt: time } } } }
  const baseline = structuredClone(legacy)
  const current = { ...old, etag: '"new"', lifecycle: { archivedAt: time }, rubricLifecycle: { deletedAt: time }, job: { ...old.job, rubricId: null, rubricDeletedAt: time }, rubric: null }
  const staleDetail = { ...old, document: { id: 'real-document' }, rubricVersions: [rubric] }
  const projected = projection.projectRealJobs(legacy, [current], [staleDetail])
  assert.deepEqual(projected.rubrics, [])
  assert.deepEqual(projected.documents, [])
  assert.equal(projected.lifecycle.entities['job:real-job'].archivedAt, time)
  assert.deepEqual(legacy, baseline)
  const deleted = projection.projectRealJobs(legacy, [], [staleDetail])
  assert.deepEqual(deleted.jobs, [])
  assert.deepEqual(deleted.rubrics, [])
  assert.deepEqual(deleted.documents, [])
})

test('pending deletion retains only recovery metadata, never source documents or rubric histories', () => {
  const time = '2026-09-18T00:00:00.000Z'
  const rubric = { id: 'pending-rubric', groupId: 'pending-group', jobId: 'pending-job', kind: 'job', name: 'Pending rubric', description: '', version: 1, criteria: [], createdAt: time, dataKind: 'real' }
  const pending = { ...summary('pending-job', time, rubric), lifecycle: { deletingAt: time } }
  const legacy = { schemaVersion: 1, jobs: [], resumes: [], documents: [], rubrics: [], runs: [] }
  const projected = projection.projectRealJobs(legacy, [pending], [{ ...pending, document: { id: 'private-source' }, rubricVersions: [rubric] }])
  assert.equal(projected.jobs[0].id, 'pending-job')
  assert.equal(projected.lifecycle.entities['job:pending-job'].deletingAt, time)
  assert.deepEqual(projected.documents, [])
  assert.deepEqual(projected.rubrics, [])
  assert.deepEqual(legacy.jobs, [])
})
