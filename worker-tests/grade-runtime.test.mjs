import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { PDFDocument } from 'pdf-lib'
import {
  api as evidenceApi, fixture as evidenceFixture, evidenceOriginal, seedJob, seedGrade,
} from '../server-tests/real-analyses.test-support.mjs'

let runtime
let StoreConflictError
const outfile = path.resolve('dist-worker', `grade-runtime-test-${process.pid}.mjs`)
before(async () => {
  await mkdir(path.dirname(outfile), { recursive: true })
  await build({
    stdin: {
      contents: "export * from './worker/grades/runtime'; export {StoreConflictError} from './server/store'; export {GradeModelError} from './worker/grades/model-errors';",
      resolveDir: process.cwd(), loader: 'ts',
    },
    outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24',
  })
  runtime = await import(pathToFileURL(outfile))
  StoreConflictError = runtime.StoreConflictError
})
after(async () => { await unlink(outfile).catch(error => { if (error.code !== 'ENOENT') throw error }) })

const wid = '694eb995-1199-4548-a216-50f6d303ec12'
const lid = 'ladder-f2b18d43-b034-4f5d-8d43-6b7ac9801000'
const sourceId = 'source-f2b18d43-b034-4f5d-8d43-6b7ac9801001'
const workId = 'grade-work-f2b18d43-b034-4f5d-8d43-6b7ac9801002'
const setId = 'source-set-f2b18d43-b034-4f5d-8d43-6b7ac9801003'
const generationId = 'f2b18d43-b034-4f5d-8d43-6b7ac9801004'
const planId = 'competency-plan-f2b18d43-b034-4f5d-8d43-6b7ac9801005'
const docId = 'document-f2b18d43-b034-4f5d-8d43-6b7ac9801001'
const now = '2026-09-17T21:00:00.000Z'
const headId = grade => `grade-head-${lid.slice('ladder-'.length)}-${grade}`
const digest = value => createHash('sha256').update(value).digest('hex')
const bytesOf = value => Buffer.from(JSON.stringify(value))
const canonicalHash = record => digest(JSON.stringify({ ...record, contentHash: undefined }))
const base = id => ({ id, workspaceId: wid, createdAt: now, updatedAt: now })

function fakeStore(initial) {
  let revision = 0
  const records = new Map()
  const store = {
    beforeTransact: undefined,
    failAfterCommit: false,
    set(record) { records.set(record.id, { record: structuredClone(record), etag: `"${++revision}"` }) },
    async get(workspaceId, id) {
      const value = records.get(id)
      return value?.record.workspaceId === workspaceId ? structuredClone(value) : undefined
    },
    async list(workspaceId, options) {
      return {
        items: [...records.values()].filter(value => value.record.workspaceId === workspaceId &&
          value.record.recordType === options.recordType &&
          (!options.ladderId || value.record.ladderId === options.ladderId) &&
          (!options.status || value.record.status === options.status) &&
          (!options.grade || value.record.grade === options.grade)).map(value => structuredClone(value)),
      }
    },
    async create(record) {
      if (records.has(record.id)) return { created: false, value: structuredClone(records.get(record.id)) }
      store.set(record)
      return { created: true, value: structuredClone(records.get(record.id)) }
    },
    async replace(record, etag) {
      if (records.get(record.id)?.etag !== etag) throw new StoreConflictError('Changed.')
      store.set(record)
      return structuredClone(records.get(record.id))
    },
    async transact(workspaceId, operations) {
      if (store.beforeTransact) await store.beforeTransact(operations)
      const ids = new Set()
      for (const operation of operations) {
        assert.equal(operation.record.workspaceId, workspaceId)
        assert.ok(!ids.has(operation.record.id))
        ids.add(operation.record.id)
        if (operation.kind === 'create' && records.has(operation.record.id)) throw new StoreConflictError('Exists.')
        if (operation.kind === 'replace' && records.get(operation.record.id)?.etag !== operation.etag) throw new StoreConflictError('Changed.')
      }
      for (const operation of operations) store.set(operation.record)
      if (store.failAfterCommit) {
        store.failAfterCommit = false
        throw new Error('Ambiguous transaction response')
      }
    },
    async listPending(time, limit) {
      return [...records.values()].filter(value => value.record.recordType === 'grade-work' &&
        ['queued', 'running'].includes(value.record.status) &&
        (!value.record.lease || value.record.lease.expiresAt <= time) &&
        (!value.record.nextAttemptAt || value.record.nextAttemptAt <= time))
        .slice(0, limit).map(value => structuredClone(value))
    },
    values() { return [...records.values()].map(value => structuredClone(value.record)) },
  }
  initial.forEach(record => store.set(record))
  return store
}

function fakeBlobs() {
  const values = new Map()
  return {
    values,
    async read(name) { return values.get(name) },
    async putImmutable(name, bytes, contentType) {
      const old = values.get(name)
      const sha256 = digest(bytes)
      if (old) {
        if (old.sha256 !== sha256) throw new StoreConflictError('Immutable blob differs.')
        return { created: false, blob: old }
      }
      const blob = { bytes: Buffer.from(bytes), contentType, sha256, etag: `"${sha256}"` }
      values.set(name, blob)
      return { created: true, blob }
    },
  }
}

function fixture(input = { kind: 'extract-source', sourceId, documentVersion: 1 }) {
  const ladder = {
    ...base(lid), recordType: 'grade-ladder', name: 'Program analysis', grades: [9, 11],
    context: { series: '0343', agency: 'Test agency', agencyType: 'other-federal', supervision: 'nonsupervisory', functions: [], specialty: '', confirmed: true, answers: {} },
    seedJobId: 'job-f2b18d43-b034-4f5d-8d43-6b7ac9801100', seedRubricId: 'seed-rubric',
    seedRubricVersion: 1, seedJobTitle: 'Program Analyst', seedBlobName: `${wid}/${lid}/seed.json`,
    sourceIds: [sourceId], sourceRevision: 1, sourceSetId: setId, generationId, status: 'generating',
    issues: [], createdBy: 'user', inputFingerprint: digest('ladder'),
  }
  const source = {
    ...base(sourceId), recordType: 'grade-source', ladderId: lid, origin: 'url', purpose: 'grading',
    title: 'Analytical grading standard', publisher: 'OPM', requestedUrl: 'https://www.opm.gov/test-standard',
    redirects: [], discoveryPath: [], coverage: { series: ['0343'], grades: [9, 11], functions: [], state: 'confirmed', explanation: 'Test coverage' },
    authorityStatus: 'current', relatedLinks: [], status: 'queued', documentId: docId, documentVersion: 1,
    completeness: 'pending', selectedPages: [], issues: [], inputFingerprint: digest('source'),
  }
  const work = { ...base(workId), recordType: 'grade-work', ladderId: lid, input, status: 'queued', attempts: 0, nextAttemptAt: now }
  const document = {
    id: docId, version: 1, kind: 'reference', title: source.title, sample: false, pageCount: 1,
    selectedPages: [1], completeness: 'complete',
    paragraphs: [{ id: 'p1', page: 1, heading: 'GS-9', text: 'Analyze assigned program operations using established methods.' }],
  }
  const sourceSet = {
    ...base(setId), recordType: 'grade-source-set', ladderId: lid, revision: 1, context: ladder.context,
    grades: ladder.grades, seedBlobName: ladder.seedBlobName,
    sources: [{
      sourceId, title: source.title, origin: 'opm', purpose: 'grading', publisher: 'OPM',
      documentId: docId, documentVersion: 1, documentBlobName: `${wid}/${lid}/${sourceId}/document-v1.json`,
      originalBlobName: `${wid}/${lid}/${sourceId}/original.html`, sha256: digest('original'),
      authorityStatus: 'current', coverage: source.coverage, pageCount: 1, selectedPages: [1], completeness: 'complete', issues: [],
    }],
    decisions: [{ sourceId, selected: true, applicability: 'applicable', reason: 'Applies' }],
    issues: [], confirmedBy: 'user', contentHash: '',
  }
  sourceSet.contentHash = canonicalHash(sourceSet)
  const heads = ladder.grades.map(grade => ({
    ...base(headId(grade)), recordType: 'grade-head', ladderId: lid, grade, generationId, sourceSetId: setId,
    status: 'queued', issues: [],
  }))
  const store = fakeStore([ladder, source, work, sourceSet, ...heads])
  const blobs = fakeBlobs()
  const deps = {
    store, blobs, now: () => new Date(now),
    discover: async () => ({ series: '0343', seriesTitle: 'Management and Program Analysis', seriesStatus: 'listed', catalogVersion: 'test-v1', candidates: [], issues: [] }),
    fetchOriginal: async () => ({ bytes: Buffer.from('<html>Source</html>'), contentType: 'text/html', finalUrl: source.requestedUrl, redirects: [] }),
    extractReference: async () => ({ document, method: 'html', extractionVersion: 'test-v1', links: [], warnings: [] }),
    planCompetencies: async () => ({ competencies: [], issues: [], model: 'test-model', promptVersion: 'test-plan' }),
    draftGrade: async () => { throw new Error('Unexpected draft') },
    reviewGrade: async () => ({ outcome: 'supported', issues: [], model: 'test-model', promptVersion: 'test-review' }),
    invokeModel: async () => { throw new Error('Unexpected model') },
    documentIntelligence: { endpoint: 'https://unused.example', getToken: async () => 'unused' },
    parseSeed: value => value, parseDocument: value => value, parseDiscovery: value => value,
    validateVersion: () => [], recordHash: canonicalHash,
  }
  return { deps, store, blobs, ladder, source, work, document, sourceSet, heads }
}

test('reference capture is immutable, source publication is atomic, and the seed job is never accessed', async () => {
  const f = fixture()
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.succeeded, 1)
  assert.equal((await f.store.get(wid, sourceId)).record.status, 'ready')
  assert.equal((await f.store.get(wid, workId)).record.status, 'succeeded')
  assert.equal(f.blobs.values.size, 3)
  assert.ok(f.blobs.values.has(`${wid}/${lid}/${sourceId}/capture.json`))
  const source = (await f.store.get(wid, sourceId)).record
  assert.equal(source.sha256, digest(Buffer.from('<html>Source</html>')))
  assert.equal(source.documentVersion, 1)
})

test('cancelled source tasks cannot publish late extraction results', async () => {
  const f = fixture()
  f.deps.extractReference = async () => {
    f.store.set({ ...(await f.store.get(wid, workId)).record, status: 'cancelled', lease: undefined })
    return { document: f.document, method: 'html', extractionVersion: 'test', links: [], warnings: [] }
  }
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.cancelled, 1)
  assert.notEqual((await f.store.get(wid, sourceId)).record.status, 'ready')
  assert.equal((await f.store.get(wid, workId)).record.status, 'cancelled')
})

test('obsolete extraction cannot clobber a newer page-selected document version', async () => {
  const f = fixture()
  f.deps.extractReference = async () => {
    f.store.set({ ...(await f.store.get(wid, sourceId)).record, documentVersion: 2, selectedPages: [2], status: 'queued' })
    return { document: f.document, method: 'html', extractionVersion: 'test', links: [], warnings: [] }
  }
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.cancelled, 1)
  const source = (await f.store.get(wid, sourceId)).record
  assert.equal(source.documentVersion, 2)
  assert.equal(source.status, 'queued')
})

test('retry reuses captured original bytes instead of fetching a changed website', async () => {
  const f = fixture()
  let fetches = 0
  f.deps.fetchOriginal = async () => {
    fetches++
    return { bytes: Buffer.from('immutable'), contentType: 'text/html', finalUrl: f.source.requestedUrl, redirects: [] }
  }
  f.deps.extractReference = async () => { throw new runtime.GradeWorkerError('temporary-ocr', 'Temporary failure.', true) }
  await runtime.runGradeWorker(f.deps)
  const work = (await f.store.get(wid, workId)).record
  assert.equal(work.status, 'queued')
  f.store.set({ ...work, nextAttemptAt: now })
  f.deps.extractReference = async (_source, original) => {
    assert.equal(Buffer.from(original.bytes).toString(), 'immutable')
    return { document: f.document, method: 'html', extractionVersion: 'test', links: [], warnings: [] }
  }
  const retried = await runtime.runGradeWorker(f.deps)
  assert.equal(retried.succeeded, 1)
  assert.equal(fetches, 1)
})

test('stage budget deferral retains cached chunks without spending a failure attempt', async () => {
  const f = fixture()
  f.deps.extractReference = async (_source, _original, options) => {
    await options.writeChunk('pages-1-50', Buffer.from('cached OCR'), 'application/json')
    await new Promise((resolve, reject) => {
      const keepAlive = setTimeout(resolve, 1000)
      options.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(options.signal.reason) }, { once: true })
    })
    throw new Error('Budget should abort first')
  }
  const result = await runtime.runGradeWorker(f.deps, { budgetMilliseconds: 30 })
  assert.equal(result.deferred, 1)
  const work = (await f.store.get(wid, workId)).record
  assert.equal(work.status, 'queued')
  assert.equal(work.attempts, 0)
  assert.ok(f.blobs.values.has(`${wid}/${lid}/${sourceId}/chunks/v1-pages-1-50.json`))
})

test('expired third-attempt work is failed visibly instead of retried forever', async () => {
  const f = fixture()
  f.store.set({ ...f.work, status: 'running', attempts: 3, lease: { owner: 'crashed', expiresAt: now } })
  let extracted = false
  f.deps.extractReference = async () => { extracted = true; throw new Error('must not execute') }
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.failed, 1)
  assert.equal(extracted, false)
  assert.equal((await f.store.get(wid, workId)).record.status, 'failed')
  assert.equal((await f.store.get(wid, sourceId)).record.error.code, 'grade-attempt-limit')
})

test('long reference PDFs require page selection before OCR and expose page count', async () => {
  const f = fixture()
  const pdf = await PDFDocument.create()
  for (let i = 0; i < 251; i++) pdf.addPage()
  const bytes = await pdf.save()
  f.deps.fetchOriginal = async () => ({ bytes, contentType: 'application/pdf', redirects: [] })
  let extracted = false
  f.deps.extractReference = async () => { extracted = true; throw new Error('OCR must not run') }
  await runtime.runGradeWorker(f.deps)
  const source = (await f.store.get(wid, sourceId)).record
  assert.equal(source.pageCount, 251)
  assert.equal(source.error.code, 'reference-pages-required')
  assert.equal(extracted, false)
})

test('discovery creates separate sources/work and records catalog provenance', async () => {
  const f = fixture({ kind: 'discover' })
  f.deps.discover = async () => ({
    series: '0343', seriesTitle: 'Management and Program Analysis', seriesStatus: 'listed', catalogVersion: 'catalog-v1', issues: [],
    candidates: [{
      url: 'https://www.opm.gov/reference', title: 'OPM standard', purpose: 'grading', publisher: 'OPM',
      coverage: f.source.coverage, discoveryPath: ['https://www.opm.gov/catalog'], authorityStatus: 'current', relatedLinks: [], issues: [],
    }],
  })
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.succeeded, 1)
  const ladder = (await f.store.get(wid, lid)).record
  assert.equal(ladder.discovery.catalogVersion, 'catalog-v1')
  assert.equal(ladder.sourceRevision, 2)
  assert.equal(ladder.sourceSetId, undefined)
  const extraction = f.store.values().find(record => record.recordType === 'grade-work' && record.input.kind === 'extract-source')
  assert.equal(extraction.status, 'queued')
  assert.equal(extraction.input.documentVersion, 1)
  assert.equal(ladder.sourceIds.length, 2)
})

test('context changes during discovery prevent publication of a mismatched series', async () => {
  const f = fixture({ kind: 'discover' })
  f.deps.discover = async () => {
    f.store.set({ ...f.ladder, context: { ...f.ladder.context, series: '2210' } })
    return { series: '0343', seriesStatus: 'listed', catalogVersion: 'test', candidates: [], issues: [] }
  }
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.cancelled, 1)
  const ladder = (await f.store.get(wid, lid)).record
  assert.equal(ladder.context.series, '2210')
  assert.equal(ladder.discovery, undefined)
})

async function prepareVersion(f, issues = []) {
  await f.blobs.putImmutable(f.sourceSet.sources[0].documentBlobName, bytesOf(f.document), 'application/json')
  const versionId = 'grade-version-f2b18d43-b034-4f5d-8d43-6b7ac9801010'
  const citation = { documentId: docId, documentVersion: 1, paragraphId: 'p1', page: 1, heading: 'GS-9', quote: f.document.paragraphs[0].text }
  const version = {
    ...base(versionId), recordType: 'grade-version', ladderId: lid, grade: 9, version: 1, generationId, sourceSetId: setId,
    rubric: {
      id: versionId, groupId: headId(9), kind: 'grade', dataKind: 'real', ladder: f.ladder.name, grade: 'GS-9',
      name: 'Program analysis GS-9', description: 'Draft', version: 1, createdAt: now,
      criteria: [{
        id: 'c1', key: 'custom', competencyId: 'competency1', label: 'Analysis', description: 'Analyze assigned work',
        weight: 100, guidance: '0 None; 1 Intro; 2 Limited; 3 Independent; 4 Strong; 5 Sustained',
        sourceCitations: [citation], gradeBasis: [citation], interpretation: 'Applied source expectations', support: 'derived',
      }],
      provenance: { kind: 'generated', model: 'test', promptVersion: 'test' },
    },
    qualifications: [], issues, createdBy: 'grade-worker', contentHash: '',
  }
  version.contentHash = canonicalHash(version)
  f.store.set(version)
  f.store.set({ ...f.heads[0], latestVersionId: versionId, status: 'processing' })
  f.store.set({ ...f.work, input: { kind: 'review-grade', sourceSetId: setId, generationId, versionId, grade: 9 } })
  return version
}

test('a model supported verdict cannot override a grade-specific source blocker', async () => {
  const f = fixture()
  f.sourceSet.issues.push({ id: 'g9', code: 'unsupported-grade', severity: 'blocker', scope: 'grade', grade: 9, message: 'No applicable GS-9 basis.' })
  f.sourceSet.contentHash = canonicalHash(f.sourceSet)
  f.store.set(f.sourceSet)
  await prepareVersion(f)
  await runtime.runGradeWorker(f.deps)
  const head = (await f.store.get(wid, headId(9))).record
  assert.equal(head.status, 'needs-sources')
  const review = (await f.store.get(wid, head.latestReviewId)).record
  assert.equal(review.outcome, 'needs-sources')
  assert.ok(review.issues.some(issue => issue.id === 'g9'))
  assert.ok(!f.store.values().some(record => record.recordType === 'grade-approval'))
})

test('another grade gap does not block an independently supported reviewed grade', async () => {
  const f = fixture()
  f.sourceSet.issues.push({ id: 'g11', code: 'unsupported-grade', severity: 'blocker', scope: 'grade', grade: 11, message: 'No GS-11 evidence.' })
  f.sourceSet.contentHash = canonicalHash(f.sourceSet)
  f.store.set(f.sourceSet)
  await prepareVersion(f)
  await runtime.runGradeWorker(f.deps)
  assert.equal((await f.store.get(wid, headId(9))).record.status, 'ready-for-review')
})

test('a draft changed during review cannot receive a stale review head', async () => {
  const f = fixture()
  await prepareVersion(f)
  const newId = 'grade-version-f2b18d43-b034-4f5d-8d43-6b7ac9801020'
  f.deps.reviewGrade = async () => {
    f.store.set({ ...(await f.store.get(wid, headId(9))).record, latestVersionId: newId })
    return { outcome: 'supported', issues: [], model: 'test', promptVersion: 'test' }
  }
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.cancelled, 1)
  const head = (await f.store.get(wid, headId(9))).record
  assert.equal(head.latestVersionId, newId)
  assert.equal(head.latestReviewId, undefined)
  assert.equal(head.status, 'processing')
})

test('concurrent work claims process a source only once', async () => {
  const f = fixture()
  let calls = 0
  f.deps.extractReference = async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 20))
    return { document: f.document, method: 'html', extractionVersion: 'test', links: [], warnings: [] }
  }
  await Promise.all([
    runtime.runGradeWorker(f.deps, { owner: 'first' }),
    runtime.runGradeWorker(f.deps, { owner: 'second' }),
  ])
  assert.equal(calls, 1)
  assert.equal((await f.store.get(wid, workId)).record.status, 'succeeded')
})

test('worker rejects invalid limits before requesting tasks', async () => {
  const f = fixture()
  await assert.rejects(runtime.runGradeWorker(f.deps, { maxItems: 0 }), /between 1 and 20/)
})

test('competency planning atomically creates independent tasks for every selected grade', async () => {
  const f = fixture({ kind: 'plan-competencies', sourceSetId: setId, generationId })
  await f.blobs.putImmutable(f.sourceSet.sources[0].documentBlobName, bytesOf(f.document), 'application/json')
  await f.blobs.putImmutable(f.ladder.seedBlobName, bytesOf({
    job: { id: f.ladder.seedJobId }, rubric: { id: f.ladder.seedRubricId, version: 1 },
    document: f.document, source: {}, capturedAt: now,
  }), 'application/json')
  f.deps.planCompetencies = async input => {
    assert.equal(input.sourceSet.id, setId)
    assert.equal(input.seed.rubric.id, f.ladder.seedRubricId)
    return {
      competencies: [{ id: 'analysis', label: 'Program analysis', description: 'Analyze programs', seedCriterionIds: ['c1'], citations: [] }],
      issues: [], model: 'model-from-response', promptVersion: 'plan-v1',
    }
  }
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.succeeded, 1)
  const tasks = f.store.values().filter(record => record.recordType === 'grade-work' && record.input.kind === 'generate-grade')
  assert.deepEqual(tasks.map(task => task.input.grade).sort((left, right) => left - right), [9, 11])
  assert.ok(tasks.every(task => task.input.sourceSetId === setId && task.input.generationId === generationId))
  const plans = f.store.values().filter(record => record.recordType === 'grade-competency-plan')
  assert.equal(plans.length, 1)
  assert.equal(plans[0].model, 'model-from-response')
})

for (const format of ['docx', 'doc']) {
  test(`${format.toUpperCase()} captured seeds are planned from frozen grade storage without Word extraction or live job access`, async () => {
    const evidence = evidenceFixture(wid)
    const job = await seedJob(evidence, 'Word engineering context', randomUUID(), format)
    const approved = await seedGrade(evidence, job)
    const f = fixture()
    const ladder = {
      ...f.ladder, id: approved.selection.ladderId, context: approved.sourceSet.context, grades: approved.sourceSet.grades,
      seedJobId: job.record.id, seedRubricId: job.rubric.id, seedRubricVersion: job.rubric.version, seedJobTitle: job.record.job.title,
      seedBlobName: approved.sourceSet.seedBlobName, sourceIds: approved.sourceSet.sources.map(source => source.sourceId),
      sourceRevision: approved.sourceSet.revision, sourceSetId: approved.sourceSet.id,
    }
    const work = { ...f.work, ladderId: ladder.id,
      input: { kind: 'plan-competencies', sourceSetId: approved.sourceSet.id, generationId } }
    const heads = ladder.grades.map(grade => ({
      ...base(`grade-head-${ladder.id.slice(7)}-${grade}`), recordType: 'grade-head', ladderId: ladder.id,
      grade, generationId, sourceSetId: approved.sourceSet.id, status: 'queued', issues: [],
    }))
    const store = fakeStore([ladder, approved.sourceSet, work, ...heads])
    let planned = false
    evidence.grades.blobs.events.length = 0
    evidence.jobValues.clear()
    evidence.jobs.blobs.values.clear()
    const deps = {
      ...f.deps, store, blobs: evidence.grades.blobs, parseSeed: evidenceApi.parseGradeSeedSnapshot,
      recordHash: record => record.recordType === 'grade-source-set'
        ? evidenceApi.gradeSourceSetHash(record) : evidenceApi.gradeVersionHash(record),
      fetchOriginal: async () => { assert.fail('Frozen seeds must never fetch a live source') },
      extractReference: async () => { assert.fail('Frozen Word seeds must never enter the PDF/HTML reference parser') },
      async planCompetencies(input) {
        planned = true
        assert.equal(input.seed.source.kind, format)
        assert.equal(input.seed.source.extractionMethod, format === 'doc' ? 'legacy-word' : 'document-intelligence')
        assert.deepEqual(input.seed.document, job.document)
        const seedSource = input.sourceSet.sources.find(source => source.origin === 'seed-job')
        assert.equal(seedSource.sha256, job.record.source.sha256)
        assert.equal(seedSource.purpose, 'job-context')
        assert.equal(seedSource.pageCount, 1)
        assert.deepEqual(input.documents.find(document => document.id === seedSource.documentId).paragraphs, job.document.paragraphs)
        return {
          competencies: [{ id: 'engineering', label: 'Engineering', description: 'Evaluate engineering evidence.',
            seedCriterionIds: [job.rubric.criteria[0].id], citations: job.rubric.criteria[0].sourceCitations }],
          issues: [], model: 'test-model', promptVersion: 'test-plan',
        }
      },
    }
    assert.equal((await runtime.runGradeWorker(deps)).succeeded, 1)
    assert.equal(planned, true)
    assert.ok(evidence.grades.blobs.events.filter(([action]) => action === 'read').every(([, name]) => name.endsWith('.json')))
    assert.equal(store.values().filter(record => record.recordType === 'grade-work' && record.input.kind === 'generate-grade').length, 1)
  })

  test(`${format.toUpperCase()} seed re-extraction fails before any source read and does not alter its immutable ready metadata`, async () => {
    const f = fixture()
    const original = evidenceOriginal(format)
    const source = {
      ...f.source, origin: 'seed-job', purpose: 'job-context', requestedUrl: undefined, status: 'ready',
      authorityStatus: 'supplied', originalBlobName: `${wid}/${lid}/${sourceId}/original.${format}`,
      originalContentType: evidenceApi.UPLOAD_CONTENT_TYPES[format], sha256: digest(original), bytes: original.byteLength,
      documentBlobName: `${wid}/${lid}/${sourceId}/document-v1.json`, capturedAt: now,
      completeness: 'complete', pageCount: 1, extractionMethod: 'seed-snapshot', extractionVersion: 'grade-seed-v1',
    }
    f.store.set(source)
    f.deps.blobs.read = async () => { assert.fail('Seed re-extraction must stop before source blob access') }
    f.deps.fetchOriginal = async () => { assert.fail('Seed re-extraction must not fetch sources') }
    f.deps.extractReference = async () => { assert.fail('Seed re-extraction must not parse Word as HTML') }
    assert.equal((await runtime.runGradeWorker(f.deps)).failed, 1)
    assert.equal((await f.store.get(wid, workId)).record.error.code, 'seed-not-extractable')
    assert.deepEqual((await f.store.get(wid, sourceId)).record, source)
  })
}

test('cancelling one grade during shared planning does not strand the other grades', async () => {
  const f = fixture({ kind: 'plan-competencies', sourceSetId: setId, generationId })
  await f.blobs.putImmutable(f.sourceSet.sources[0].documentBlobName, bytesOf(f.document), 'application/json')
  await f.blobs.putImmutable(f.ladder.seedBlobName, bytesOf({
    job: { id: f.ladder.seedJobId }, rubric: { id: f.ladder.seedRubricId, version: 1 },
    document: f.document, source: {}, capturedAt: now,
  }), 'application/json')
  f.store.set({ ...f.heads[1], status: 'cancelled' })
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.succeeded, 1)
  const tasks = f.store.values().filter(record => record.recordType === 'grade-work' && record.input.kind === 'generate-grade')
  assert.deepEqual(tasks.map(task => task.input.grade), [9])
  assert.equal((await f.store.get(wid, headId(11))).record.status, 'cancelled')
  assert.equal((await f.store.get(wid, headId(9))).record.status, 'queued')
})

test('new grade generation preserves approved history and queues independent grounding review', async () => {
  const f = fixture()
  const prior = await prepareVersion(f)
  f.store.set({ ...f.heads[0], latestVersionId: prior.id, approvedVersionId: prior.id, approvalId: 'existing-approval' })
  f.store.set({
    ...base(planId), recordType: 'grade-competency-plan', ladderId: lid, generationId, sourceSetId: setId,
    competencies: [], issues: [], model: 'test', promptVersion: 'test',
  })
  f.store.set({ ...f.work, input: { kind: 'generate-grade', sourceSetId: setId, generationId, competencyPlanId: planId, grade: 9 } })
  f.deps.draftGrade = async input => ({
    rubric: { ...prior.rubric, id: input.versionId, version: input.version, createdAt: input.createdAt },
    qualifications: [], issues: [], model: 'test', promptVersion: 'test',
  })
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.succeeded, 1)
  const head = (await f.store.get(wid, headId(9))).record
  assert.equal(head.approvedVersionId, prior.id)
  assert.equal(head.approvalId, 'existing-approval')
  assert.notEqual(head.latestVersionId, prior.id)
  assert.equal((await f.store.get(wid, head.latestVersionId)).record.version, 2)
  assert.deepEqual((await f.store.get(wid, prior.id)).record, prior)
  const reviewTask = f.store.values().find(record => record.recordType === 'grade-work' && record.input.kind === 'review-grade' && record.id !== workId)
  assert.equal(reviewTask.input.versionId, head.latestVersionId)
  assert.equal(reviewTask.status, 'queued')
})

test('source changes during generation prevent a stale draft from being published', async () => {
  const f = fixture()
  const prior = await prepareVersion(f)
  f.store.set({
    ...base(planId), recordType: 'grade-competency-plan', ladderId: lid, generationId, sourceSetId: setId,
    competencies: [], issues: [], model: 'test', promptVersion: 'test',
  })
  f.store.set({ ...f.work, input: { kind: 'generate-grade', sourceSetId: setId, generationId, competencyPlanId: planId, grade: 9 } })
  f.deps.draftGrade = async input => {
    f.store.set({ ...f.ladder, sourceSetId: undefined, generationId: undefined, sourceRevision: 2, status: 'draft' })
    return { rubric: { ...prior.rubric, id: input.versionId, version: input.version }, qualifications: [], issues: [], model: 'test', promptVersion: 'test' }
  }
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.cancelled, 1)
  assert.equal(f.store.values().filter(record => record.recordType === 'grade-version').length, 1)
  assert.equal((await f.store.get(wid, headId(9))).record.latestVersionId, prior.id)
})

test('an already committed publication is not reversed after a lost transaction response', async () => {
  const f = fixture()
  f.store.beforeTransact = async operations => {
    if (operations.some(operation => operation.record.id === workId && operation.record.status === 'succeeded')) {
      f.store.failAfterCommit = true
    }
  }
  await runtime.runGradeWorker(f.deps)
  assert.equal((await f.store.get(wid, workId)).record.status, 'succeeded')
  assert.equal((await f.store.get(wid, sourceId)).record.status, 'ready')
  assert.equal(f.store.values().filter(record => record.recordType === 'grade-work').length, 1)
})

test('a capture interrupted before original storage rejects later changed content', async () => {
  const f = fixture()
  const manifest = {
    sourceId, blobName: `${wid}/${lid}/${sourceId}/original.html`, contentType: 'text/html',
    sha256: digest('first response'), bytes: Buffer.byteLength('first response'), capturedAt: now,
    finalUrl: f.source.requestedUrl, redirects: [],
  }
  await f.blobs.putImmutable(`${wid}/${lid}/${sourceId}/capture.json`, bytesOf(manifest), 'application/json')
  f.deps.fetchOriginal = async () => ({
    bytes: Buffer.from('changed response'), contentType: 'text/html', finalUrl: f.source.requestedUrl, redirects: [],
  })
  await runtime.runGradeWorker(f.deps)
  assert.equal((await f.store.get(wid, sourceId)).record.error.code, 'reference-changed-during-capture')
  assert.equal(f.blobs.values.has(manifest.blobName), false)
})

test('discovery retry uses the immutable catalog snapshot instead of changing evidence', async () => {
  const f = fixture({ kind: 'discover' })
  const capturedAt = '2026-09-17T20:00:00.000Z'
  await f.blobs.putImmutable(`${wid}/${lid}/discovery-${workId.slice('grade-work-'.length)}.json`, bytesOf({
    contextKey: JSON.stringify(f.ladder.context), capturedAt,
    result: { series: '0343', seriesStatus: 'listed', catalogVersion: 'captured-v1', candidates: [], issues: [] },
  }), 'application/json')
  f.deps.discover = async () => { throw new Error('A retry must not rediscover sources') }
  const result = await runtime.runGradeWorker(f.deps)
  assert.equal(result.succeeded, 1)
  const ladder = (await f.store.get(wid, lid)).record
  assert.equal(ladder.discovery.capturedAt, capturedAt)
  assert.equal(ladder.discovery.catalogVersion, 'captured-v1')
})

test('aggregate PDF budget is enforced before another reference starts OCR', async () => {
  const f = fixture()
  const extraIds = ['source-f2b18d43-b034-4f5d-8d43-6b7ac9801031', 'source-f2b18d43-b034-4f5d-8d43-6b7ac9801032']
  for (const id of extraIds) {
    f.store.set({ ...f.source, id, status: 'ready', pageCount: 250, originalContentType: 'application/pdf' })
  }
  f.store.set({ ...f.ladder, sourceIds: [sourceId, ...extraIds] })
  const pdf = await PDFDocument.create()
  pdf.addPage()
  const bytes = await pdf.save()
  f.deps.fetchOriginal = async () => ({ bytes, contentType: 'application/pdf', redirects: [] })
  f.deps.extractReference = async () => { throw new Error('OCR must not run') }
  await runtime.runGradeWorker(f.deps)
  assert.equal((await f.store.get(wid, sourceId)).record.error.code, 'reference-page-budget')
  assert.equal((await f.store.get(wid, sourceId)).record.pageCount, 1)
})

test('a tampered source set cannot be sent to a model or reviewed', async () => {
  const f = fixture()
  await prepareVersion(f)
  f.store.set({ ...f.sourceSet, context: { ...f.sourceSet.context, series: '2210' } })
  let invoked = false
  f.deps.reviewGrade = async () => { invoked = true; throw new Error('Must not run') }
  await runtime.runGradeWorker(f.deps)
  assert.equal(invoked, false)
  assert.equal((await f.store.get(wid, workId)).record.error.code, 'source-set-integrity')
})

test('insufficient bounded model context remains a visible source gap, not an approved or lost draft', async () => {
  const f = fixture()
  const version = await prepareVersion(f)
  f.deps.reviewGrade = async () => {
    throw new runtime.GradeModelError('model-context-limit', 'Select narrower complete evidence before review.', {
      issues: [{
        id: 'context-gap', code: 'model-context-limit', severity: 'blocker',
        scope: 'grade', grade: 9, message: 'The required complete source section exceeds the review budget.',
      }],
    })
  }
  await runtime.runGradeWorker(f.deps)
  const head = (await f.store.get(wid, headId(9))).record
  assert.equal(head.status, 'needs-sources')
  assert.equal(head.latestVersionId, version.id)
  assert.ok(head.issues.some(issue => issue.id === 'context-gap'))
  assert.equal((await f.store.get(wid, workId)).record.status, 'failed')
  assert.equal((await f.store.get(wid, lid)).record.status, 'incomplete')
})

test('an immutable-store conflict returning existing bytes cannot publish a different reference document', async () => {
  const f = fixture()
  const documentName = `${wid}/${lid}/${sourceId}/document-v1.json`
  await f.blobs.putImmutable(documentName, bytesOf({ ...f.document, title: 'Preserved original extraction' }), 'application/json')
  const put = f.blobs.putImmutable.bind(f.blobs)
  f.blobs.putImmutable = async (name, bytes, contentType) => {
    const current = f.blobs.values.get(name)
    return current ? { created: false, blob: current } : put(name, bytes, contentType)
  }
  await runtime.runGradeWorker(f.deps)
  const source = (await f.store.get(wid, sourceId)).record
  assert.equal(source.status, 'error')
  assert.equal(source.error.code, 'immutable-grade-artifact-conflict')
  assert.equal(JSON.parse(Buffer.from(f.blobs.values.get(documentName).bytes).toString()).title, 'Preserved original extraction')
})
