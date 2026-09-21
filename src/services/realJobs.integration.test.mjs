import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { docxFile, legacyDocFile } from '../../server-tests/word-fixtures.mjs'
import { frontendWorkspaceContext } from './frontend.test-support.mjs'

const outputDirectory = resolve(`.real-job-client-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
const originals = new Map()
let client
let projection
let requests
let ui, dom, root, createRoot, current

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
  await mkdir(outputDirectory)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter, DocumentFragment: dom.window.DocumentFragment, CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
    CSS: { escape: (value) => value }, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
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
  const uiOutfile = join(outputDirectory, 'ui.mjs')
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export { WorkspaceContext, useWorkspace } from './src/app/workspace-context';
      export { RealJobsBridge } from './src/app/RealJobsBridge';
      export { JobImport } from './src/features/jobs/JobImport';
      export { JobsPage, JobDetail } from './src/features/jobs/JobsPage';
      export { RubricsPage } from './src/features/rubrics/RubricsPage';
      export { GradeSourceInspector } from './src/features/grade-ladders/GradeSourceInspector';
      export { GradeLaddersContext } from './src/app/grade-ladders-context';
      export { JOB_IMPORT_LIMITS } from './src/domain/real-jobs';
      export { supportedUploadFormats, uploadAccept } from './src/domain/document-formats';
      export { uploadFileByteLimit } from './src/services/documentUploads';
      export { MemoryRouter, Routes, Route } from 'react-router-dom';
    ` },
    outfile: uiOutfile, bundle: true, packages: 'external', format: 'esm', platform: 'node', jsx: 'automatic',
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' }, logLevel: 'silent',
  })
  ui = await import(pathToFileURL(uiOutfile).href)
})

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = null
    // Radix restores focus on the next task; keep the JSDOM event constructors alive until then.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
})
after(async () => {
  globalThis.fetch = originalFetch
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(outputDirectory, { recursive: true, force: true })
})

beforeEach(() => {
  requests = []
  current = null
})

test('Markdown job capability is opt-in and requires real job imports', async () => {
  for (const advertised of [
    {}, { realJobImports: true }, { realJobImports: true, markdownJobImports: false },
    { realJobImports: false, markdownJobImports: true }, { markdownJobImports: true },
    { realJobImports: true, markdownJobImports: 'true' },
  ]) {
    globalThis.fetch = async () => json(advertised)
    const features = await client.fetchJobProcessingFeatures()
    assert.equal(features.markdownJobImports, false)
    assert.equal(features.realJobImports, advertised.realJobImports === true)
    assert.equal(features.limits.maxMarkdownBytes, 10 * 1024 * 1024)
  }
  globalThis.fetch = async () => json({ realJobImports: true, markdownJobImports: true })
  assert.equal((await client.fetchJobProcessingFeatures()).markdownJobImports, true)
})

test('job Markdown and Word capabilities stay independent, including the resume-only Markdown flag', async () => {
  for (const [advertised, expected] of [
    [{ realJobImports: true, markdownResumeImports: true }, ['pdf']],
    [{ realJobImports: true, markdownResumeImports: true, wordDocumentImports: true }, ['pdf', 'docx', 'doc']],
    [{ realJobImports: true, markdownJobImports: true }, ['pdf', 'markdown']],
    [{ realJobImports: true, markdownJobImports: true, wordDocumentImports: true }, ['pdf', 'markdown', 'docx', 'doc']],
    [{ realJobImports: false, markdownJobImports: true, wordDocumentImports: true }, ['pdf']],
  ]) {
    globalThis.fetch = async () => json(advertised)
    const features = await client.fetchJobProcessingFeatures()
    assert.deepEqual(ui.supportedUploadFormats(features), expected)
    assert.equal(features.markdownResumeImports, undefined)
  }
  globalThis.fetch = async () => json({ realJobImports: true, markdownJobImports: true, wordDocumentImports: true,
    limits: { maxFileBytes: 8, maxPdfBytes: 2, maxMarkdownBytes: 4 } })
  const { limits } = await client.fetchJobProcessingFeatures()
  assert.equal(limits.maxBatchFiles, 10)
  assert.deepEqual(['pdf', 'markdown', 'docx', 'doc'].map((format) => ui.uploadFileByteLimit(format, limits)), [2, 4, 8, 8])
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
  assert.equal(old.limits.maxFileBytes, 10 * 1024 * 1024)
  assert.equal(ui.uploadFileByteLimit('pdf', old.limits), 9 * 1024 * 1024)
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

test('job PDF clients preserve legacy colon and reserved-basename acceptance without changing upload headers', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json({ job: summary('legacy-pdf', '2026-09-17T00:00:00.000Z') }, 202)
  }
  for (const name of ['Role: engineer.pdf', 'CON.pdf', 'LPT1.PDF']) {
    const file = new File(['%PDF-legacy-source'], name, { type: 'application/pdf' })
    for (const upload of [client.importRealJobPdf, client.importRealJobFile]) {
      await upload('w', file, 'legacy-key', 'legacy-batch')
      const request = requests.at(-1)
      assert.equal(request.url, '/api/workspaces/w/jobs/pdf')
      assert.equal(request.init.headers.get('Content-Type'), 'application/pdf')
      assert.equal(request.init.headers.get('X-File-Name'), encodeURIComponent(name))
      assert.equal(request.init.headers.get('Idempotency-Key'), 'legacy-key')
      assert.equal(request.init.headers.get('X-Import-Batch'), 'legacy-batch')
      assert.deepEqual(new Uint8Array(request.init.body), new Uint8Array(await file.arrayBuffer()))
    }
  }
})

test('job PDF clients surface legacy server filename rejection without changing or guessing the source', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json({ error: { code: 'invalid_request', message: 'X-File-Name must be a safe PDF basename.' } }, 400)
  }
  for (const name of ['folder\\role.pdf', 'role\n.pdf', 'not-a-pdf.txt']) {
    const file = new File(['%PDF-source'], name, { type: 'application/pdf' })
    await assert.rejects(client.importRealJobFile('w', file, 'pdf-key'), /safe PDF basename/)
    assert.equal(requests.at(-1).url, '/api/workspaces/w/jobs/pdf')
    assert.equal(requests.at(-1).init.headers.get('X-File-Name'), encodeURIComponent(name))
  }
  assert.equal(requests.length, 3)
})

test('Markdown file dispatch is case-insensitive, ignores browser MIME, and preserves exact bytes and headers', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json({ job: summary('markdown-job', '2026-09-17T00:00:00.000Z') }, 202)
  }
  const bytes = new Uint8Array([239, 187, 191, ...new TextEncoder().encode('# Rôle\r\n\r\nExact **source** bytes.\r\n')])
  for (const [name, type] of [
    ['rôle.MD', ''], ['role.MarkDown', 'text/plain'], ['role.md', 'application/octet-stream'],
    ['role.MARKDOWN', 'application/pdf'], ['role.md', 'text/markdown'],
  ]) {
    const file = new File([bytes], name, { type })
    await client.importRealJobFile('workspace / one', file, 'stable-markdown-key', 'batch-key')
    const request = requests.at(-1)
    assert.equal(request.url, '/api/workspaces/workspace%20%2F%20one/jobs/markdown')
    assert.equal(request.init.headers.get('Content-Type'), 'text/markdown')
    assert.equal(request.init.headers.get('X-File-Name'), encodeURIComponent(name))
    assert.equal(request.init.headers.get('Idempotency-Key'), 'stable-markdown-key')
    assert.equal(request.init.headers.get('X-Import-Batch'), 'batch-key')
    assert.equal(request.init.headers.get('X-Score-Request'), 'workspace')
    assert.deepEqual(new Uint8Array(request.init.body), bytes)
  }
  await client.importRealJobMarkdown('w', new File([bytes], 'role.md'), 'direct-markdown-key')
  assert.equal(requests.at(-1).init.headers.get('X-Import-Batch'), null)
  await client.importRealJobFile('w', new File(['%PDF-content'], 'role.PDF'), 'pdf-key')
  assert.equal(requests.at(-1).url, '/api/workspaces/w/jobs/pdf')
  assert.equal(requests.at(-1).init.headers.get('Content-Type'), 'application/pdf')
})

test('unknown, unsafe, empty, oversized, and mismatched job files are rejected before sending', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); throw new Error('Unexpected upload') }
  for (const file of [
    new File(['# Heading'], 'role.txt', { type: 'text/markdown' }),
    new File(['# Heading'], 'role.html', { type: 'text/html' }),
    new File(['# Heading'], 'CON.md'),
    new File(['# Heading'], 'folder\\role.md'),
    new File([], 'empty.MD'),
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.markdown'),
  ]) await assert.rejects(client.importRealJobFile('w', file, 'key'), /not supported|safe|nonempty|10 MiB/)
  await assert.rejects(client.importRealJobPdf('w', new File(['# Heading'], 'role.md', { type: 'application/pdf' }), 'key'), /safe .pdf filename/)
  await assert.rejects(client.importRealJobMarkdown('w', new File(['%PDF-content'], 'role.pdf'), 'key'), /safe .md or .markdown filename/)
  assert.equal(requests.length, 0)
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

function workspaceValue(records = []) {
  return frontendWorkspaceContext({
    workspace: {
      schemaVersion: 1, jobs: records.map((item) => item.job), resumes: [], runs: [],
      documents: records.flatMap((item) => item.document ? [item.document] : []),
      rubrics: records.flatMap((item) => item.rubricVersions ?? (item.rubric ? [item.rubric] : [])),
    },
    notify() {}, cancelJob() {}, retryJob() {}, saveRubric() {},
    addJobs() { throw new Error('A real import reached sample intake') },
    cloud: {
      currentWorkspaceId: 'workspace-one', workspaces: [{ id: 'workspace-one', role: 'owner' }],
      realJobs: {
        phase: 'ready', features: { realJobImports: true, markdownJobImports: true, limits: ui.JOB_IMPORT_LIMITS },
        summaries: records, error: null, detail: (id) => ({ state: 'ready', value: records.find((item) => item.job.id === id) }),
        source: (id) => records.find((item) => item.job.id === id)?.source,
        ensureDetail: async () => {}, refresh: async () => {},
        originalUrl: (id) => `/api/workspaces/workspace-one/jobs/${id}/original`,
      },
    },
  })
}

async function mount(element, value = workspaceValue(), path = '/jobs') {
  root ??= createRoot(dom.window.document.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(ui.MemoryRouter, {
      key: path, initialEntries: [path], future: { v7_startTransition: true, v7_relativeSplatPath: true },
    }, React.createElement(ui.WorkspaceContext.Provider, { value }, element)))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function chooseFiles(files, drop = false) {
  if (drop) {
    const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files } })
    await act(async () => dom.window.document.querySelector('.drop-zone').dispatchEvent(event))
  } else {
    const input = dom.window.document.querySelector('input[type="file"]')
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  }
}

async function clickButton(label) {
  const button = [...dom.window.document.querySelectorAll('button')].find((item) => item.textContent.trim() === label)
  assert.ok(button, `Button ${label} exists`)
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
}

test('job picker and drop zone accept mixed PDF/Markdown files and retry the same source identity', async () => {
  const value = workspaceValue()
  const calls = []
  let markdownAttempts = 0
  value.cloud.realJobs.importFile = async (file, idempotencyKey, batchId) => {
    calls.push({ file, idempotencyKey, batchId })
    if (file.name.endsWith('.MD') && markdownAttempts++ === 0) throw new Error('Acceptance could not be confirmed.')
    return summary(file.name, '2026-09-17T00:00:00.000Z')
  }
  await mount(React.createElement(ui.JobImport, { onClose() {} }), value)
  const input = dom.window.document.querySelector('input[type="file"]')
  assert.equal(input.getAttribute('aria-label'), 'Choose real job PDF or Markdown files')
  for (const extension of ['.pdf', '.md', '.markdown']) assert.ok(input.accept.split(',').includes(extension))
  const files = [new File(['%PDF-source'], 'role.PDF'), new File(['# Duties\r\nExact bytes'], 'role.MD', { type: 'application/pdf' })]
  await chooseFiles(files)
  assert.equal(dom.window.document.querySelectorAll('.import-item').length, 2)
  await chooseFiles(files, true)
  await clickButton('Import 2 jobs')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].file, files[0])
  assert.equal(calls[1].file, files[1])
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey)
  assert.equal(calls[0].batchId, calls[1].batchId)
  assert.match(dom.window.document.body.textContent, /1 queued \/ 1 unacknowledged/)
  await act(async () => {
    dom.window.document.querySelector('button[aria-label="Retry role.MD"]').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2], calls[1])
  assert.match(dom.window.document.body.textContent, /2 queued \/ 0 unacknowledged/)
  assert.match(dom.window.document.querySelector('.import-items').textContent, /Markdown/)
})

test('job picker advertises Markdown and Word together without enabling either through the other flag', async () => {
  const value = workspaceValue()
  value.cloud.realJobs.features.wordDocumentImports = true
  const calls = []
  value.cloud.realJobs.importFile = async (file, key, batchId) => { calls.push({ file, key, batchId }); return summary(file.name, '2026-09-17T00:00:00.000Z') }
  await mount(React.createElement(ui.JobImport, { onClose() {} }), value)
  const input = dom.window.document.querySelector('input[type="file"]')
  assert.equal(input.getAttribute('aria-label'), 'Choose real job PDF or Markdown or Word files')
  for (const extension of ['.pdf', '.md', '.markdown', '.docx', '.doc']) assert.ok(input.accept.split(',').includes(extension))
  const files = [
    new File(['# Source'], 'role.MD', { type: 'application/pdf' }), new File([docxFile()], 'role.DOCX'),
    new File([legacyDocFile()], 'role.DOC'), new File(['%PDF-source'], 'role.PDF'), new File(['invalid'], 'role.docm'),
  ]
  await chooseFiles(files, true)
  assert.equal(dom.window.document.querySelectorAll('.import-item').length, 5)
  await clickButton('Import 4 jobs')
  assert.deepEqual(calls.map((call) => call.file), files.slice(0, 4))
  assert.equal(new Set(calls.map((call) => call.batchId)).size, 1)
  assert.equal(new Set(calls.map((call) => call.key)).size, 4)
  assert.match(dom.window.document.body.textContent, /4 queued \/ 0 unacknowledged \/ 1 invalid/)

  const isolated = workspaceValue()
  isolated.cloud.currentWorkspaceId = 'workspace-two'
  isolated.cloud.workspaces = [{ id: 'workspace-two', role: 'owner', etag: '"workspace-two"' }]
  isolated.cloud.realJobs.features.markdownJobImports = false
  isolated.cloud.realJobs.features.markdownResumeImports = true
  isolated.cloud.realJobs.features.wordDocumentImports = true
  await mount(React.createElement(ui.JobImport, { onClose() {} }), isolated)
  const wordOnly = dom.window.document.querySelector('input[type="file"]')
  assert.equal(wordOnly.getAttribute('aria-label'), 'Choose real job PDF or Word files')
  assert.equal(wordOnly.accept.split(',').includes('.md'), false)
  assert.equal(wordOnly.accept.split(',').includes('.docx'), true)
})

test('job picker accepts legacy PDF basenames while Markdown retains strict filename validation', async () => {
  const value = workspaceValue()
  const calls = []
  value.cloud.realJobs.importFile = async (file) => {
    calls.push(file)
    return summary(file.name, '2026-09-17T00:00:00.000Z')
  }
  await mount(React.createElement(ui.JobImport, { onClose() {} }), value)
  const files = ['Role: engineer.pdf', 'CON.pdf', 'LPT1.PDF'].map((name) => new File(['%PDF-source'], name, { type: 'application/pdf' }))
  await chooseFiles(files)
  assert.equal(dom.window.document.querySelectorAll('.import-item').length, 3)
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null)
  await clickButton('Import 3 jobs')
  assert.deepEqual(calls, files)
  assert.match(dom.window.document.body.textContent, /3 queued \/ 0 unacknowledged/)
  assert.equal(dom.window.document.querySelector('input[type="file"]').disabled, true)
  await clickButton('Start another batch')
  await chooseFiles([new File(['# Source'], 'Role: engineer.md')], true)
  assert.match(dom.window.document.querySelector('[role="alert"]').textContent, /safe filename/)
  assert.equal(calls.length, 3)
})

test('job UI rejects unknown or disabled Markdown files while keeping PDF and URL imports usable', async () => {
  const value = workspaceValue()
  delete value.cloud.realJobs.features.markdownJobImports
  const calls = []
  value.cloud.realJobs.importFile = async (file) => { calls.push(file); return summary('pdf', '2026-09-17T00:00:00.000Z') }
  await mount(React.createElement(ui.JobImport, { onClose() {} }), value)
  await chooseFiles([new File(['# Source'], 'role.txt', { type: 'text/markdown' })], true)
  assert.match(dom.window.document.querySelector('[role="alert"]').textContent, /Other formats cannot be processed/)
  assert.equal(dom.window.document.querySelectorAll('.import-item').length, 1, 'Invalid input is retained without discarding valid neighbors.')
  await chooseFiles([new File(['# Source'], 'role.MaRkDoWn')])
  assert.match(dom.window.document.querySelector('[role="alert"]').textContent, /Markdown uploads are not enabled/)
  assert.equal(calls.length, 0)
  await chooseFiles([new File(['%PDF-source'], 'role.pdf')])
  await clickButton('Import 1 job')
  assert.equal(calls.length, 1)
  await clickButton('Start another batch')
  await clickButton('Direct URLs')
  assert.equal(dom.window.document.querySelector('textarea').disabled, false)
})

function JobsProbe() {
  current = ui.useWorkspace().cloud.realJobs
  return React.createElement('span', null, current.phase)
}

for (const policyUnavailable of [false, true]) {
  test(`job StrictMode bootstrap releases aborted reads and loads history with ${policyUnavailable ? 'unavailable' : 'ready'} feature policy`, async () => {
    const record = markdownDetail()
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init })
      if (url === '/api/features') return policyUnavailable
        ? json({ error: { code: 'unavailable', message: 'Current policy is unavailable.' } }, 503)
        : json({ realJobImports: true, markdownJobImports: true })
      if (url.endsWith('/jobs')) return json({ jobs: [{ ...record, document: undefined, rubricVersions: undefined }] })
      if (url.endsWith(`/jobs/${record.job.id}`)) return json(record)
      throw new Error(`Unexpected bootstrap request: ${url}`)
    }
    const value = workspaceValue()
    const { cloud, ...legacyValue } = value
    await mount(React.createElement(React.StrictMode, null,
      React.createElement(ui.RealJobsBridge, { workspaceId: 'workspace-one', legacyValue, cloud },
        React.createElement(JobsProbe))), value, `/jobs/${record.job.id}`)
    for (let index = 0; index < 30 && (current?.phase !== 'ready' || current.detail(record.job.id).state !== 'ready'); index++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    }
    assert.equal(current.phase, 'ready', 'StrictMode cleanup must release the aborted initial list request')
    assert.equal(current.detail(record.job.id).state, 'ready', 'A cold source link loads its captured detail without manual refresh')
    assert.deepEqual(current.detail(record.job.id).value.document, record.document)
    const lists = requests.filter(request => request.url.endsWith('/jobs'))
    assert.equal(lists.length, 2, 'Only the cancelled bootstrap and its replacement are fetched')
    assert.equal(lists[0].init.signal.aborted, true)
    assert.equal(lists[1].init.signal.aborted, false)
    if (policyUnavailable) {
      assert.equal(current.features, null)
      assert.throws(() => current.importPdf(new File(['%PDF-source'], 'source.pdf'), randomUUID()), /New job imports are unavailable/)
      assert.equal(requests.some(request => request.init.method === 'POST'), false, 'Unavailable policy never enables new imports')
    }
  })
}

test('job rename projects acknowledged metadata and preserves ready source details outside sample persistence', async () => {
  let record = markdownDetail()
  const original = structuredClone(record)
  const baseEtag = record.etag
  let projected
  function RenameProbe() { projected = ui.useWorkspace(); return null }
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/features') return json({ realJobImports: true, markdownJobImports: true })
    if (init.method === 'PATCH') {
      assert.equal(init.headers.get('If-Match'), baseEtag)
      record = { ...record, displayName: JSON.parse(init.body).displayName, etag: '"renamed"' }
      return json({ job: { ...record, document: undefined, rubricVersions: undefined } })
    }
    if (url.endsWith('/jobs')) return json({ jobs: [{ ...record, document: undefined, rubricVersions: undefined }] })
    if (url.endsWith(`/jobs/${record.job.id}`)) return json(record)
    throw new Error(`Unexpected metadata dependency request: ${url}`)
  }
  const value = workspaceValue()
  const { cloud, ...legacyValue } = value
  await mount(React.createElement(ui.RealJobsBridge, { workspaceId: 'workspace-one', legacyValue, cloud },
    React.createElement(RenameProbe)), value)
  for (let index = 0; index < 30 && projected?.cloud.realJobs.phase !== 'ready'; index++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  assert.equal(projected.cloud.realJobs.phase, 'ready')
  await act(async () => projected.cloud.realJobs.ensureDetail(record.job.id))
  const document = projected.cloud.realJobs.detail(record.job.id).value.document
  await act(async () => projected.renameEntity({ kind: 'job', id: record.job.id }, 'Hiring title', baseEtag))
  assert.equal(projected.workspace.jobs[0].displayName, 'Hiring title')
  assert.equal(projected.workspace.jobs[0].title, original.job.title)
  assert.equal(projected.cloud.realJobs.detail(record.job.id).state, 'ready')
  assert.equal(projected.cloud.realJobs.detail(record.job.id).value.document, document)
  assert.deepEqual(record.job, original.job)
  assert.deepEqual(legacyValue.workspace.jobs, [])
  assert.equal(requests.filter(request => request.init.method === 'PATCH').length, 1)
})

test('job bridge fails closed for unadvertised Markdown without blocking PDF or URL APIs', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/features') return json({ realJobImports: true })
    if (init.method === 'GET') return json({ jobs: [] })
    return json({ job: summary(`job-${requests.length}`, '2026-09-17T00:00:00.000Z') }, 202)
  }
  const value = workspaceValue()
  const { cloud, ...legacyValue } = value
  await mount(React.createElement(ui.RealJobsBridge, { workspaceId: 'workspace-one', legacyValue, cloud },
    React.createElement(JobsProbe)), value)
  for (let index = 0; index < 30 && current?.phase !== 'ready'; index++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  assert.equal(current.phase, 'ready')
  const markdown = new File(['# Source'], 'role.md')
  await assert.rejects(current.importMarkdown(markdown, 'md-key'), /not enabled/)
  await assert.rejects(current.importFile(markdown, 'md-key'), /not enabled/)
  assert.equal(requests.filter((item) => item.init.method === 'POST').length, 0)
  await act(async () => {
    await current.importPdf(new File(['%PDF-source'], 'role.pdf'), 'pdf-key')
    await current.importUrl('https://example.test/role', 'url-key')
  })
  assert.deepEqual(requests.filter((item) => item.init.method === 'POST').map((item) => item.url.split('/').at(-1)), ['pdf', 'url'])
})

function markdownDetail() {
  const item = summary('markdown-job', '2026-09-17T00:00:00.000Z')
  const paragraph = { id: 'markdown-p1', page: 1, heading: 'Responsibilities', text: 'Prepare accessible documentation. <img src=x onerror="alert(1)"> **Plain evidence**.' }
  const document = { id: item.job.documentId, title: 'Captured role', kind: 'job', sample: false, version: 1, paragraphs: [paragraph] }
  const citation = { documentId: document.id, documentVersion: 1, paragraphId: paragraph.id, page: 1, heading: paragraph.heading, quote: 'accessible documentation' }
  const rubric = {
    id: 'markdown-rubric', groupId: 'markdown-group', jobId: item.job.id, kind: 'job', dataKind: 'real', version: 1,
    name: 'Documented expectations', description: 'Grounded in local Markdown.', createdAt: item.updatedAt,
    criteria: [{ id: 'criterion-one', key: 'custom', label: 'Clear documentation', description: 'Prepare accessible documentation.',
      weight: 100, guidance: 'Assess cited evidence.', requirementType: 'required', sourceCitations: [citation] }],
  }
  return {
    ...item, job: { ...item.job, source: 'markdown', sourceLabel: 'role.MD', status: 'ready', rubricId: rubric.id },
    source: { kind: 'markdown', displayName: 'role.MD', originalContentType: 'text/markdown' }, document, rubric, rubricVersions: [rubric],
  }
}

test('real job source badges and Markdown filtering do not add Markdown controls to samples', async () => {
  const markdown = markdownDetail()
  const pdf = summary('pdf-job', '2026-09-17T00:00:00.000Z')
  pdf.job.source = 'pdf'
  pdf.source = { kind: 'pdf', displayName: 'role.pdf' }
  const value = workspaceValue([markdown, pdf])
  value.workspace.jobs.push({ ...pdf.job, id: 'sample-job', dataKind: undefined })
  await mount(React.createElement(ui.JobsPage), value)
  const select = dom.window.document.querySelector('select[aria-label="Filter by source"]')
  assert.ok(select.querySelector('option[value="markdown"]'))
  assert.match(dom.window.document.querySelector('tbody').textContent, /Markdown document/)
  await act(async () => { select.value = 'markdown'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  assert.equal(dom.window.document.querySelectorAll('tbody tr').length, 1)
  assert.match(dom.window.document.querySelector('tbody').textContent, /markdown-job/)
  const samples = [...dom.window.document.querySelectorAll('[aria-label="Choose real jobs or samples"] button')].find((button) => button.textContent.startsWith('Samples'))
  await act(async () => samples.click())
  const sampleSource = dom.window.document.querySelector('select[aria-label="Filter by source"]')
  assert.equal(sampleSource.value, 'all')
  assert.equal(sampleSource.querySelector('option[value="markdown"]'), null)
  assert.match(dom.window.document.querySelector('tbody').textContent, /pdf-job/)
})

test('job and rubric evidence use Markdown sections and highlight exact plain-text citations', async () => {
  const saved = markdownDetail()
  const value = workspaceValue([saved])
  for (const [path, route, Component] of [
    ['/jobs/markdown-job', '/jobs/:id', ui.JobDetail],
    ['/rubrics/markdown-rubric?job=markdown-job', '/rubrics/:id', ui.RubricsPage],
  ]) {
    await mount(React.createElement(ui.Routes, null, React.createElement(ui.Route, { path: route, element: React.createElement(Component) })), value, path)
    const source = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent.includes('View exact source · Markdown section 1'))
    assert.ok(source, 'Citation link identifies a Markdown section')
    await act(async () => { source.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const viewer = dom.window.document.querySelector('.document-viewer')
    assert.match(viewer.textContent, /Markdown section 1 of 1/)
    assert.doesNotMatch(viewer.textContent, /Original page|Captured HTML|Fictional/)
    assert.equal(viewer.querySelector('h3').textContent, 'Responsibilities')
    assert.equal(viewer.querySelector('mark').textContent, 'accessible documentation')
    assert.equal(viewer.querySelector('img'), null)
    assert.match(viewer.textContent, /<img src=x onerror="alert\(1\)"> \*\*Plain evidence\*\*/)
  }
})

test('frozen Markdown grade seeds retain section labels and exact quotation highlighting', async () => {
  const saved = markdownDetail()
  const citation = saved.rubric.criteria[0].sourceCitations[0]
  const reference = { ...saved.document, kind: 'reference', completeness: 'complete', pageCount: 1, selectedPages: [] }
  const source = {
    sourceId: 'seed-source', documentId: reference.id, documentVersion: 1, title: 'Captured Markdown seed', origin: 'seed-job',
    purpose: 'job-context', publisher: 'Supplied role', originalContentType: 'text/markdown', selectedPages: [], pageCount: 1, completeness: 'complete',
    authorityStatus: 'supplied', coverage: { state: 'confirmed', explanation: 'Captured seed', series: [], grades: [], functions: [] }, issues: [], sha256: 'a'.repeat(64),
  }
  const gradeApi = {
    sourceSet: async () => ({ sources: [source], createdAt: '2026-09-17T00:00:00.000Z' }),
    document: async () => reference, originalUrl: () => '/api/captured-original',
  }
  await mount(React.createElement(ui.GradeLaddersContext.Provider, { value: gradeApi },
    React.createElement(ui.GradeSourceInspector, { ladderId: 'ladder-one', selection: { sourceSetId: 'frozen-set', citation }, onClose() {} })))
  const viewer = dom.window.document.querySelector('.document-viewer')
  assert.ok(viewer)
  assert.match(viewer.textContent, /Markdown section 1 of 1/)
  assert.equal(viewer.querySelector('mark').textContent, citation.quote)
  assert.match(dom.window.document.querySelector('.grade-provenance').textContent, /Markdown sections, not PDF pages/)
  assert.doesNotMatch(viewer.textContent, /Original page|Captured HTML/)
})
