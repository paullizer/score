import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { realReportFixture, REPORT_TEST_HASH, REPORT_TEST_TIMESTAMP } from './test-support.mjs'

const output = resolve(`.analysis-report-real-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
const storageDescriptors = new Map()
let loadRealAnalysisReport, requests
const clone = value => structuredClone(value)
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const reference = (name, sha256 = REPORT_TEST_HASH) => ({ blobName: name, sha256, bytes: 1024, contentType: 'application/json' })

function fixture(options = {}) {
  const report = realReportFixture(options)
  report.run.id = `analysis-run-${randomUUID()}`
  const { workspaceId, run } = report
  const root = `${workspaceId}/${run.id}`
  const targets = report.targets.map(target => ({
    id: target.id, dataKind: 'real', workspaceId, kind: target.kind, label: target.label, sublabel: target.sublabel,
    rubricId: target.rubricId, rubricVersion: target.rubricVersion, criterionCount: target.criteria.length, selection: clone(target.selection),
  }))
  const resumes = [...new Map(report.comparisons.map(({ candidate }) => [candidate.id, {
    workspaceId, dataKind: 'real', name: candidate.name, role: candidate.role, sourceLabel: candidate.sourceLabel, capturedAt: REPORT_TEST_TIMESTAMP,
    selection: { resumeId: candidate.id, documentId: candidate.documentId, documentVersion: candidate.documentVersion, documentSha256: candidate.documentSha256 },
  }])).values()]
  const inventory = report.comparisons.map(comparison => {
    comparison.id = `analysis-comparison-${randomUUID()}`
    const candidate = comparison.candidate
    const target = report.targets.find(value => value.id === comparison.targetId)
    const attemptId = randomUUID()
    return {
      etag: `"comparison-${comparison.index}"`,
      comparison: {
        id: comparison.id, recordType: 'analysis-comparison', dataKind: 'real', workspaceId, runId: run.id,
        index: comparison.index, status: comparison.status,
        resume: { snapshotId: candidate.snapshot.snapshotId,
          blob: reference(`${root}/snapshots/${candidate.snapshot.snapshotId}/${candidate.snapshot.sha256}.json`, candidate.snapshot.sha256),
          summary: clone(resumes.find(value => value.selection.resumeId === candidate.id)) },
        target: { snapshotId: target.snapshot.snapshotId,
          blob: reference(`${root}/snapshots/${target.snapshot.snapshotId}/${target.snapshot.sha256}.json`, target.snapshot.sha256),
          summary: clone(targets.find(value => value.id === target.id)) },
        ...(comparison.status === 'complete' ? {
          attemptId, result: reference(`${root}/results/${comparison.id}/${attemptId}.json`, comparison.resultSha256),
          resultSummary: { completion: comparison.completion, overall: clone(comparison.overall), coverage: clone(comparison.coverage) },
          completedAt: REPORT_TEST_TIMESTAMP,
        } : {}),
        ...(comparison.error ? { error: clone(comparison.error) } : {}),
      },
    }
  })
  const progress = { total: inventory.length, initialized: inventory.length, queued: 0, running: 0, complete: 0, failed: 0, cancelled: 0, scored: 0, unscored: 0 }
  for (const { comparison } of inventory) {
    progress[comparison.status]++
    if (comparison.status === 'complete') progress[comparison.resultSummary.overall.status === 'available' ? 'scored' : 'unscored']++
  }
  return {
    report, inventory,
    detail: {
      etag: '"saved-run"',
      run: { ...clone(run), recordType: 'analysis-run', workspaceId, dataKind: 'real',
        status: progress.complete === progress.total ? 'complete' : progress.running ? 'running' : progress.queued ? 'queued' : progress.complete ? 'partial' : 'failed',
        manifest: reference(`${root}/manifest.json`), progress,
        initialization: { nextComparisonIndex: inventory.length, completedAt: REPORT_TEST_TIMESTAMP } },
      targets, resumes,
    },
  }
}

function batch(f, ids) {
  const comparisons = ids.map(id => clone(f.report.comparisons.find(comparison => comparison.id === id)))
  const targetIds = new Set(comparisons.map(comparison => comparison.targetId))
  return { schemaVersion: 1, dataKind: 'real', workspaceId: f.report.workspaceId, runId: f.report.run.id,
    targets: clone(f.report.targets.filter(target => targetIds.has(target.id))), comparisons }
}

function serve(f, { pageSize = 50, page, report, detail } = {}) {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    assert.equal(init.method, 'GET', 'Export must not create analyses or invoke models.')
    assert.equal(init.cache, 'no-store')
    const parsed = new URL(url, 'https://score.test')
    if (parsed.pathname.endsWith('/report-comparisons')) {
      const ids = parsed.searchParams.getAll('comparisonId')
      assert.ok(ids.length >= 1 && ids.length <= 25)
      assert.equal(new Set(ids).size, ids.length)
      return report ? report(ids, init, parsed) : json(batch(f, ids))
    }
    if (parsed.pathname.endsWith('/comparisons')) {
      const offset = Number(parsed.searchParams.get('continuationToken') ?? 0)
      const body = { comparisons: clone(f.inventory.slice(offset, offset + pageSize)),
        ...(offset + pageSize < f.inventory.length ? { continuationToken: String(offset + pageSize) } : {}) }
      return page ? page(body, offset, init) : json(body)
    }
    assert.equal(parsed.pathname, `/api/workspaces/${f.report.workspaceId}/analyses/${f.report.run.id}`)
    return detail ? detail(init) : json(f.detail)
  }
}

function load(f, options) { return loadRealAnalysisReport(f.report.workspaceId, f.report.run.id, options) }
function reportRequests() { return requests.filter(request => request.url.includes('/report-comparisons?')) }

function addDisplayLabels(f) {
  f.detail.run.displayName = 'Renamed saved run'
  for (const target of f.detail.targets) target.displayName = `Display ${target.id}`
  for (const resume of f.detail.resumes) resume.displayName = `Display ${resume.selection.resumeId}`
  for (const { comparison } of f.inventory) {
    comparison.resume.summary.displayName = `Display ${comparison.resume.summary.selection.resumeId}`
    comparison.target.summary.displayName = `Display ${comparison.target.summary.id}`
  }
  for (const target of f.report.targets) target.displayName = `Display ${target.id}`
  for (const comparison of f.report.comparisons) comparison.candidate.displayName = `Display ${comparison.candidate.id}`
}

before(async () => {
  await mkdir(output)
  await build({
    entryPoints: [join('src', 'services', 'analysisReports', 'real.ts')], outfile: join(output, 'real.mjs'),
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' },
  })
  ;({ loadRealAnalysisReport } = await import(pathToFileURL(join(output, 'real.mjs')).href))
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) {
    storageDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error('Report data must never access browser persistence.') } })
  }
})
beforeEach(() => { requests = [] })
afterEach(() => { globalThis.fetch = originalFetch })
after(async () => {
  for (const [name, descriptor] of storageDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

test('real exports use the current run title and exact captured labels without replacing source identities', async () => {
  const f = fixture()
  addDisplayLabels(f)
  serve(f)
  const report = await load(f)
  assert.equal(report.run.name, 'Renamed saved run')
  for (const group of report.groups) {
    const original = f.report.targets.find(target => target.id === group.target.id)
    assert.equal(group.target.displayName, original.displayName)
    assert.equal(group.target.label, original.label)
    for (const comparison of group.comparisons) {
      const source = f.report.comparisons.find(item => item.id === comparison.id)
      assert.equal(comparison.candidate.displayName, source.candidate.displayName)
      assert.equal(comparison.candidate.name, source.candidate.name)
      assert.deepEqual(comparison.overall, source.overall)
    }
  }
})

test('real exports reject display labels that differ from the captured analysis summaries', async () => {
  const f = fixture()
  addDisplayLabels(f)
  serve(f, { report: ids => {
    const payload = batch(f, ids)
    payload.comparisons[0].candidate.displayName = 'Different live label'
    return json(payload)
  } })
  await assert.rejects(load(f), /candidate differs from the captured/)
})

test('500 comparisons consume the complete inventory and bounded concurrent 25-ID batches, without new-run feature gates or persistence', async () => {
  const f = fixture({ scores: Array.from({ length: 250 }, (_, index) => index % 101), targetCount: 2 })
  let active = 0, maximum = 0
  const progress = []
  serve(f, { report: async ids => {
    active++
    maximum = Math.max(maximum, active)
    await delay(3)
    active--
    return json(batch(f, ids))
  } })
  const report = await load(f, { onProgress: (completed, total) => progress.push([completed, total]) })
  assert.equal(report.counts.total, 500)
  assert.equal(report.counts.complete, 500)
  assert.equal(report.candidateCount, 250)
  assert.equal(report.groups.length, 2)
  assert.ok(report.groups.every(group => group.comparisons.length === 250))
  assert.equal(new Set(report.groups.flatMap(group => group.comparisons.map(comparison => comparison.id))).size, 500)
  assert.equal(requests.filter(request => /\/comparisons(?:\?|$)/.test(request.url)).length, 10)
  assert.equal(reportRequests().length, 20)
  assert.ok(maximum > 1 && maximum <= 3)
  assert.equal(requests.length, 31)
  assert.deepEqual(progress[0], [0, 500])
  assert.deepEqual(progress.at(-1), [500, 500])
  assert.ok(progress.every((value, index) => !index || value[0] > progress[index - 1][0]))
  assert.ok(requests.every(({ init }) => init.credentials === 'include' && init.headers.get('X-Score-Request') === 'workspace' && init.signal))
  assert.ok(report.capture.startedAt <= report.capture.completedAt && report.capture.completedAt <= report.generatedAt)
  assert.ok(!JSON.stringify(report).includes('blobName'))
  assert.ok(report.groups.flatMap(group => group.comparisons).some(comparison => comparison.overall.score === 0))
})

test('exact UI target IDs, rather than duplicate labels, select one frozen target after checking the full inventory', async () => {
  const f = fixture({ scores: [90, 80, null], targetCount: 2 })
  assert.equal(f.report.targets[0].label, f.report.targets[1].label)
  serve(f, { pageSize: 2 })
  const targetId = f.detail.targets[1].id
  const report = await load(f, { targetId })
  assert.equal(report.scope.targetId, targetId)
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].target.id, targetId)
  assert.deepEqual(report.groups[0].target.selection, f.detail.targets[1].selection)
  assert.equal(report.counts.total, 3)
  assert.ok(report.groups[0].comparisons.every(comparison => comparison.targetId === targetId))
  assert.equal(requests.filter(request => /\/comparisons(?:\?|$)/.test(request.url)).length, 3)
  assert.equal(new URL(reportRequests()[0].url, 'https://score.test').searchParams.getAll('comparisonId').length, 3)
  await assert.rejects(load(f, { targetId: 'same title, different selection' }), /selected exact target/)
})

test('both 500 resumes for one target and one resume for 500 exact targets remain supported', async () => {
  for (const [resumeCount, targetCount] of [[500, 1], [1, 500]]) {
    requests = []
    const f = fixture({ scores: Array.from({ length: resumeCount }, () => 80), targetCount })
    serve(f)
    const report = await load(f)
    assert.equal(report.counts.total, 500)
    assert.equal(report.candidateCount, resumeCount)
    assert.equal(report.groups.length, targetCount)
    assert.equal(reportRequests().length, 20)
    assert.ok(report.groups.every(group => group.counts.total === resumeCount))
  }
})

test('capture-time unfinished statuses and errors stay frozen when later batches contain completed results', async () => {
  const f = fixture({ scores: [90, 80, 70, 60, 50], statuses: ['complete', 'running', 'failed', 'queued', 'cancelled'] })
  const later = realReportFixture({ scores: [90, 80, 70, 60, 50] })
  later.comparisons.forEach((comparison, index) => { comparison.id = f.report.comparisons[index].id })
  serve(f, { report: ids => {
    const response = batch(f, ids)
    response.comparisons = ids.map(id => clone(later.comparisons.find(comparison => comparison.id === id)))
    f.detail.run.progress = { ...f.detail.run.progress, complete: 5, running: 0, queued: 0, failed: 0, cancelled: 0, scored: 5 }
    return json(response)
  } })
  const report = await load(f)
  assert.equal(report.partial, true)
  assert.deepEqual(report.counts, { total: 5, complete: 1, running: 1, failed: 1, queued: 1, cancelled: 1, scored: 1, withheld: 0 })
  for (const comparison of report.groups[0].comparisons.slice(1)) {
    assert.equal(comparison.status, f.inventory[comparison.index].comparison.status)
    assert.equal(comparison.summary, null)
    assert.equal(comparison.coverage, null)
    assert.equal(comparison.resultSha256, null)
    assert.equal(comparison.analyzedAt, null)
    assert.equal(comparison.completion, null)
    assert.equal(comparison.overall.status, 'unavailable')
    assert.deepEqual(comparison.criteria, [])
    assert.deepEqual(comparison.qualifications, [])
    assert.deepEqual(comparison.limitations, [])
    assert.deepEqual(comparison.provenance, [])
    assert.deepEqual(comparison.error, f.inventory[comparison.index].comparison.error ?? null)
  }
  assert.equal(requests.filter(request => request.url.endsWith(f.report.run.id)).length, 1)
})

test('zero complete scopes cannot export, but completed withheld results remain eligible without a highlight', async () => {
  const empty = fixture({ scores: [null, null], statuses: ['queued', 'failed'] })
  serve(empty)
  await assert.rejects(load(empty), /At least one comparison.*complete/)
  assert.equal(reportRequests().length, 0)
  const withheld = fixture({ scores: [null] })
  serve(withheld)
  const report = await load(withheld)
  assert.equal(report.counts.withheld, 1)
  assert.equal(report.partial, false)
  assert.deepEqual(report.groups[0].highlightedComparisonIds, [])
  assert.equal(report.groups[0].comparisons[0].overall.status, 'withheld')
  const scoped = fixture({ scores: [90], targetCount: 2 })
  const queued = scoped.inventory[1].comparison
  queued.status = 'queued'
  delete queued.result
  delete queued.resultSummary
  delete queued.completedAt
  delete queued.attemptId
  Object.assign(scoped.detail.run.progress, { complete: 1, scored: 1, queued: 1 })
  scoped.detail.run.status = 'queued'
  serve(scoped)
  const before = reportRequests().length
  await assert.rejects(load(scoped, { targetId: scoped.detail.targets[1].id }), /At least one comparison.*complete/)
  assert.equal(reportRequests().length, before)
})

test('batch scope, kinds, requested IDs, hashes, frozen candidate/selection bindings and saved summaries fail closed', async () => {
  const changes = [
    value => { value.workspaceId = 'another-workspace' },
    value => { value.runId = 'another-run' },
    value => { value.dataKind = 'sample' },
    value => { value.comparisons[0].dataKind = 'sample' },
    value => { value.comparisons = [] },
    value => { value.comparisons.push(clone(value.comparisons[0])) },
    value => { value.comparisons[0].id = 'foreign-comparison' },
    value => { value.comparisons[0].index = 9 },
    value => { value.comparisons[0].resultSha256 = 'b'.repeat(64) },
    value => { value.comparisons[0].candidate.id = 'different-candidate' },
    value => { value.comparisons[0].candidate.name = 'Different saved name' },
    value => { value.comparisons[0].candidate.sourceLabel = 'another.docx' },
    value => { value.comparisons[0].candidate.documentSha256 = 'b'.repeat(64) },
    value => { value.comparisons[0].candidate.snapshot.sha256 = 'b'.repeat(64) },
    value => { value.comparisons[0].candidate.snapshot.snapshotId = 'other-snapshot' },
    value => { value.comparisons[0].overall.score = 1 },
    value => { value.targets[0].snapshot.sha256 = 'b'.repeat(64) },
    value => { value.targets[0].snapshot.snapshotId = 'another-target-snapshot' },
    value => { value.targets[0].selection.rubricHash = 'b'.repeat(64) },
    value => { value.targets[0].label = 'Current live title' },
    value => { value.targets[0].id = value.comparisons[0].targetId = 'another-target' },
    value => { value.comparisons[0].criteria[0].citations[0].locator = 'Printed page 3' },
    value => { value.originalDocument = { paragraphs: ['Do not include private originals'] } },
  ]
  for (const change of changes) {
    const f = fixture({ scores: [90] })
    serve(f, { report: ids => { const value = batch(f, ids); change(value); return json(value) } })
    await assert.rejects(load(f), undefined, change.toString())
  }
})

test('malformed, foreign, duplicate, repeated, missing and inconsistent complete inventories stop before report reads', async () => {
  const changes = [
    f => { f.inventory.pop() },
    f => { f.inventory[1] = clone(f.inventory[0]) },
    f => { f.inventory[1].comparison.index = f.inventory[0].comparison.index },
    f => { f.inventory[0].comparison.workspaceId = 'foreign-workspace' },
    f => { f.inventory[0].comparison.runId = 'foreign-run' },
    f => { f.inventory[0].comparison.dataKind = 'sample' },
    f => { f.inventory[0].comparison.resume.summary.selection.documentVersion++ },
    f => { f.inventory[0].comparison.target.summary.selection.rubricHash = 'b'.repeat(64) },
    f => { f.inventory[0].comparison.resume.blob.blobName = 'foreign/snapshot.json' },
    f => { f.inventory[0].comparison.result.blobName = 'foreign/result.json' },
    f => { f.inventory[0].comparison.result.sha256 = 'invalid-hash' },
    f => { f.inventory[0].comparison.resultSummary.coverage.totalCriteria++ },
    f => { f.inventory[0].comparison.resultSummary.coverage.assessedWeight = 0 },
    f => { delete f.inventory[0].comparison.result },
    f => { f.inventory[0].comparison.status = 'running' },
    f => { f.inventory[2].comparison.resume.blob.sha256 = 'b'.repeat(64) },
    f => { f.detail.run.progress.total-- },
    f => { f.detail.run.progress.initialized-- },
    f => { f.detail.run.status = 'initializing' },
    f => { f.detail.run.initialization.nextComparisonIndex-- },
    f => { f.detail.targets[1] = clone(f.detail.targets[0]) },
    f => { f.detail.targets[1].selection = { ...clone(f.detail.targets[0].selection), rubricHash: 'b'.repeat(64) } },
    f => { f.detail.resumes[1] = clone(f.detail.resumes[0]) },
    f => { f.detail.run.manifest.blobName = 'foreign/manifest.json' },
  ]
  for (const change of changes) {
    requests = []
    const f = fixture({ scores: [90, 80], targetCount: 2 })
    change(f)
    serve(f)
    await assert.rejects(load(f), undefined, change.toString())
    assert.equal(reportRequests().length, 0)
  }
})

test('valid empty Cosmos pages with advancing continuation tokens do not omit report comparisons', async () => {
  const f = fixture({ scores: [90, 80, 70] })
  let initialEmpty = false
  serve(f, { pageSize: 2, page: (body) => {
    if (!initialEmpty) {
      initialEmpty = true
      return json({ comparisons: [], continuationToken: '0' })
    }
    return json(body)
  } })
  const report = await load(f)
  assert.equal(report.counts.total, 3)
  assert.equal(report.counts.complete, 3)
  assert.deepEqual(report.groups[0].comparisons.map(comparison => comparison.id), f.inventory.map(({ comparison }) => comparison.id))
  assert.equal(requests.filter(request => /\/comparisons(?:\?|$)/.test(request.url)).length, 3)
})

test('continued pages cannot repeat IDs/tokens, omit rows, exceed 500 items, or use malformed continuation tokens', async () => {
  for (const kind of ['ids', 'token', 'empty', 'omitted', 'object-token', 'oversized-token']) {
    const f = fixture({ scores: [90, 80, 70] })
    serve(f, { pageSize: 1, page: (body, offset) => {
      if (kind === 'ids' && offset) body.comparisons = clone([f.inventory[0]])
      if (kind === 'token') body.continuationToken = '1'
      if (kind === 'empty') body.comparisons = []
      if (kind === 'omitted') delete body.continuationToken
      if (kind === 'object-token') body.continuationToken = { token: 'other' }
      if (kind === 'oversized-token') body.continuationToken = 'x'.repeat(16 * 1024 + 1)
      return json(body)
    } })
    await assert.rejects(load(f), undefined, kind)
  }
  const oversized = fixture({ scores: Array.from({ length: 501 }, () => 80) })
  serve(oversized)
  await assert.rejects(load(oversized), /budget|500/)
})

test('target definitions cannot change between batches and oversized response payloads are explicit errors', async () => {
  const f = fixture({ scores: Array.from({ length: 26 }, () => 80) })
  serve(f, { report: ids => {
    const response = batch(f, ids)
    if (ids.length === 1) response.targets[0].criteria[0].guidance = 'A later rubric must not enter this export.'
    return json(response)
  } })
  await assert.rejects(load(f), /target changed between batches/)
  const large = fixture({ scores: [80] })
  serve(large, { report: ids => {
    const response = batch(large, ids)
    response.comparisons[0].summary = 'x'.repeat(8 * 1024 * 1024)
    return json(response)
  } })
  await assert.rejects(load(large), /8 MiB resource limit.*Narrow/)
})

test('cancellation before reads and during pagination prevents further private requests', async () => {
  const f = fixture({ scores: [90, 80, 70] })
  const before = new AbortController()
  before.abort()
  serve(f)
  await assert.rejects(load(f, { signal: before.signal }), error => error.name === 'AbortError')
  assert.equal(requests.length, 0)
  const during = new AbortController()
  serve(f, { pageSize: 1, page: body => { during.abort(); return json(body) } })
  await assert.rejects(load(f, { signal: during.signal }), error => error.name === 'AbortError')
  assert.equal(requests.length, 2)
  assert.equal(reportRequests().length, 0)
})

test('workspace-lifetime cancellation aborts all in-flight batches and late successful responses cannot complete an export', async () => {
  const f = fixture({ scores: Array.from({ length: 100 }, () => 80) })
  const controller = new AbortController()
  const pending = []
  const progress = []
  serve(f, { report: (ids, init) => new Promise(resolve => pending.push({ ids, init, resolve })) })
  const loading = load(f, { signal: controller.signal, onProgress: completed => progress.push(completed) })
  for (let index = 0; pending.length < 3 && index < 100; index++) await delay(1)
  assert.equal(pending.length, 3)
  controller.abort()
  for (const item of pending) item.resolve(json(batch(f, item.ids)))
  await assert.rejects(loading, error => error.name === 'AbortError')
  assert.ok(pending.every(item => item.init.signal.aborted))
  assert.deepEqual(progress, [0])
  assert.equal(reportRequests().length, 3)
})

test('auth, redirect, and network errors abort the entire export without fallback or further batches', async () => {
  for (const failure of ['auth', 'html', 'network']) {
    const f = fixture({ scores: Array.from({ length: 100 }, () => 80) })
    requests = []
    let calls = 0
    serve(f, { report: async (_ids, init) => {
      if (++calls === 1) {
        if (failure === 'auth') return json({ error: { code: 'unauthorized', message: 'Sign in again.' } }, 401)
        if (failure === 'html') return new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } })
        throw new Error('Network unavailable')
      }
      await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
    } })
    await assert.rejects(load(f), /Sign in|sign in|Network/)
    assert.ok(reportRequests().length <= 3)
    assert.ok(reportRequests().every(request => request.init.signal.aborted))
  }
})

test('every new export reauthorizes and reloads private data rather than returning a cached report', async () => {
  const f = fixture({ scores: [80] })
  serve(f)
  await load(f)
  const firstCount = requests.length
  serve(f, { detail: () => json({ error: { code: 'forbidden', message: 'Workspace membership ended.' } }, 403) })
  await assert.rejects(load(f), /Workspace membership ended/)
  assert.equal(requests.length, firstCount + 1)
})
