import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { docxFile, legacyDocFile } from './word-fixtures.mjs'
import {
  createApp, StoreConflictError, parseGradeEntity, gradeContentHash, gradeVersionHash, gradeSourceSetHash, gradeRecordHash,
  parseGradeSeedSnapshot, validateGradeVersion, validateGradeApproval, validateReferenceDocument, loadConfig,
} from '../dist-server/app.mjs'
import {
  ALLOWED_OID, OTHER_ALLOWED_OID, APP_ORIGIN, TENANT_ID,
  authHeaders, baseConfig, createFakeDirectoryStore, createFakeStateStore, membershipFor,
} from './helpers.mjs'

const NOW = '2026-09-17T20:30:00.000Z'
const WORD_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
}
const CONTEXT = {
  series: '0801', agency: 'Example federal agency', agencyType: 'other-federal',
  supervision: 'nonsupervisory', functions: [], specialty: 'Engineering', confirmed: true, answers: {},
}
const CONFIG = {
  cosmosEndpoint: 'https://example.documents.azure.com/', database: 'score',
  container: 'grade-records', storageAccountUrl: 'https://example.blob.core.windows.net', blobContainer: 'grade-sources',
}
const JOB_CONFIG = { ...CONFIG, container: 'job-records', blobContainer: 'job-sources' }
const clone = value => structuredClone(value)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const headId = (ladderId, grade) => `grade-head-${ladderId.slice(7)}-${grade}`
const writeHeaders = (extra = {}, oid = ALLOWED_OID) => ({
  ...authHeaders({ oid }), origin: APP_ORIGIN, 'x-score-request': 'workspace', ...extra,
})
const guidance = [
  '0: No evidence of this work is demonstrated.',
  '1: Recognizes the work with extensive assistance.',
  '2: Completes routine tasks with close supervision.',
  '3: Applies methods independently on typical assignments.',
  '4: Resolves complex assignments with limited guidance.',
  '5: Integrates complex evidence and explains defensible decisions.',
].join('\n')

function blobs() {
  const values = new Map()
  const events = []
  return {
    values, events,
    async read(name) { events.push(['read', name]); return clone(values.get(name)) },
    async putImmutable(name, bytes, contentType) {
      events.push(['put', name])
      if (values.has(name)) return { created: false, blob: clone(values.get(name)) }
      const blob = { bytes: Uint8Array.from(bytes), sha256: sha(bytes), contentType, etag: `"blob-${values.size + 1}"` }
      values.set(name, blob)
      return { created: true, blob: clone(blob) }
    },
  }
}

function gradeStore() {
  const values = new Map()
  const events = []
  let next = 0
  let before = null
  let after = null
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  const save = record => {
    const value = { record: clone(parseGradeEntity(record)), etag: `"grade-${++next}"` }
    values.set(key(record.workspaceId, record.id), value)
    return clone(value)
  }
  return {
    values, events,
    async get(workspaceId, id) { return clone(values.get(key(workspaceId, id))) },
    async list(workspaceId, options) {
      const start = Number(options.continuationToken ?? 0)
      const records = [...values.values()].filter(({ record }) => record.workspaceId === workspaceId &&
        record.recordType === options.recordType &&
        (options.ladderId === undefined || record.ladderId === options.ladderId) &&
        (options.grade === undefined || record.grade === options.grade) &&
        (options.status === undefined || record.status === options.status) &&
        (options.generationId === undefined || record.generationId === options.generationId))
        .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt) || a.record.id.localeCompare(b.record.id))
      const items = records.slice(start, start + (options.limit ?? 50)).map(clone)
      return { items, ...(start + items.length < records.length ? { continuationToken: `${start + items.length}` } : {}) }
    },
    async create(record) {
      const existing = values.get(key(record.workspaceId, record.id))
      return existing ? { created: false, value: clone(existing) } : { created: true, value: save(record) }
    },
    async replace(record, etag) {
      if (!['grade-ladder', 'grade-source', 'grade-head', 'grade-work'].includes(record.recordType)) throw new Error('immutable')
      const old = values.get(key(record.workspaceId, record.id))
      if (!old || old.etag !== etag) throw new StoreConflictError()
      return save(record)
    },
    async transact(workspaceId, operations) {
      events.push(clone(operations))
      if (before) { const callback = before; before = null; await callback(operations) }
      assert.equal(new Set(operations.map(operation => operation.record.id)).size, operations.length)
      for (const operation of operations) {
        parseGradeEntity(operation.record)
        assert.equal(operation.record.workspaceId, workspaceId)
        const old = values.get(key(workspaceId, operation.record.id))
        if (operation.kind === 'create' ? Boolean(old) : !old || old.etag !== operation.etag) throw new StoreConflictError()
        if (operation.kind === 'replace' && !['grade-ladder', 'grade-source', 'grade-head', 'grade-work'].includes(operation.record.recordType)) {
          throw new Error('Immutable grade record replacement')
        }
      }
      for (const operation of operations) save(operation.record)
      if (after) { const callback = after; after = null; await callback(operations) }
    },
    async listPending(now, limit) {
      return [...values.values()].filter(({ record }) => record.recordType === 'grade-work' &&
        ['queued', 'running'].includes(record.status) && (!record.nextAttemptAt || record.nextAttemptAt <= now) &&
        (!record.lease || record.lease.expiresAt <= now)).sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt)).slice(0, limit).map(clone)
    },
    _before(callback) { before = callback },
    _after(callback) { after = callback },
    _unsafe(record) { values.set(key(record.workspaceId, record.id), { record: clone(record), etag: `"unsafe-${++next}"` }) },
  }
}

async function pdf(pages = 1) {
  const document = await PDFDocument.create()
  for (let index = 0; index < pages; index++) document.addPage()
  return document.save()
}

async function start(options = {}) {
  const directory = options.persisted?.directory ?? createFakeDirectoryStore()
  const state = options.persisted?.state ?? createFakeStateStore()
  const grades = options.persisted?.grades ?? { store: gradeStore(), blobs: blobs() }
  const jobRecords = new Map()
  const jobRubrics = new Map()
  const jobBlobs = blobs()
  const jobs = {
    store: {
      async get(workspaceId, id) { return clone(jobRecords.get(`${workspaceId}/${id}`)) },
      async listRubrics(workspaceId, id) { return clone(jobRubrics.get(`${workspaceId}/${id}`) ?? []) },
      async getRubric(workspaceId, id) {
        return [...jobRubrics.entries()].filter(([key]) => key.startsWith(`${workspaceId}/`))
          .flatMap(([, values]) => values).filter(value => value.id === id).sort((a, b) => b.version - a.version)[0]
      },
    },
    blobs: jobBlobs,
  }
  let now = new Date(NOW)
  const config = baseConfig({
    realJobs: options.jobs === false ? undefined : JOB_CONFIG,
    realGrades: options.grades === false ? undefined : CONFIG,
  })
  const app = createApp({ config, directory, state, jobs, grades, now: () => now })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`
  const api = {
    baseUrl, directory, state, grades, jobs, jobRecords, jobRubrics,
    setNow(value) { now = new Date(value) },
    async close() { await new Promise(resolve => server.close(resolve)) },
    async request(path, method = 'GET', body, extra = {}, oid = ALLOWED_OID) {
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: method === 'GET' ? { ...authHeaders({ oid }), ...extra } : writeHeaders({
          ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra,
        }, oid),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
  }
  const session = await api.request('/session')
  assert.equal(session.status, 200)
  api.workspaceId = (await session.json()).workspaces[0].id
  api.base = `/workspaces/${api.workspaceId}/grade-ladders`
  return api
}

async function seed(api, title = 'Engineer', options = {}) {
  if (typeof options === 'string') options = { kind: options }
  const key = randomUUID()
  const workspaceId = api.workspaceId
  const id = `job-${key}`
  const document = {
    id: `document-${key}`, title, version: 1, kind: 'job', sample: false,
    paragraphs: [{ id: 'job-p1', page: options.page ?? 1, heading: 'Duties', text: 'Evaluate engineering systems and explain recommendations based on evidence.' }],
  }
  const citation = {
    documentId: document.id, documentVersion: 1, paragraphId: 'job-p1', page: document.paragraphs[0].page, heading: 'Duties',
    quote: document.paragraphs[0].text,
  }
  const rubric = {
    id: `rubric-${key}`, groupId: `rubric-group-${key}`, jobId: id, kind: 'job', dataKind: 'real',
    name: 'Engineering work', description: 'Job work rubric', version: 1, createdAt: NOW,
    provenance: { kind: 'generated', model: 'test-model', promptVersion: 'job-v2' },
    criteria: [{
      id: 'seed-criterion', key: 'custom', label: 'Engineering analysis', description: document.paragraphs[0].text,
      weight: 100, guidance, requirementType: 'required', sourceCitations: [citation],
    }],
  }
  const kind = options.kind ?? 'pdf'
  assert.ok(['pdf', 'markdown', 'docx', 'doc', 'url'].includes(kind))
  const extension = kind === 'markdown' ? 'md' : kind === 'url' ? 'html' : kind
  const contentType = WORD_TYPES[kind] ?? (kind === 'pdf' ? 'application/pdf' : kind === 'markdown' ? 'text/markdown' : 'text/html')
  const displayName = kind === 'url' ? 'https://agency.example.gov/engineering-job' : options.fileName ?? `job.${extension}`
  const wordText = [document.title, ...document.paragraphs.flatMap(paragraph => [paragraph.heading, paragraph.text])].join('\n')
  const bytes = kind === 'pdf' ? await pdf() : kind === 'docx' ? docxFile(wordText) : kind === 'doc' ? legacyDocFile(wordText)
    : Buffer.from(kind === 'markdown' ? `# Duties\r\n\r\n${document.paragraphs[0].text}\r\n`
      : `<html><body><h1>Duties</h1><p>${document.paragraphs[0].text}</p></body></html>`)
  const originalName = `${workspaceId}/${id}/original.${extension}`
  const original = await api.jobs.blobs.putImmutable(originalName, bytes, contentType)
  await api.jobs.blobs.putImmutable(`${workspaceId}/${id}/source-document.json`, Buffer.from(JSON.stringify(document)), 'application/json')
  const record = {
    id, workspaceId, recordType: 'job',
    job: {
      id, title, organization: 'Example federal agency', location: '', arrangement: '', employmentType: '',
      grade: '', series: '0801', source: kind, sourceLabel: displayName, documentId: document.id,
      rubricId: rubric.id, status: 'ready', createdAt: NOW, dataKind: 'real',
    },
    source: {
      kind, displayName, originalBlobName: originalName,
      originalContentType: contentType, sha256: original.blob.sha256, bytes: original.blob.bytes.byteLength,
      capturedAt: NOW, extractionMethod: kind === 'doc' ? 'legacy-word' : kind === 'markdown' ? 'markdown'
        : kind === 'url' ? 'html' : 'document-intelligence',
      ...(kind === 'url' ? { url: displayName, finalUrl: displayName } : {}),
    },
    inputFingerprint: sha(Buffer.from(id)), createdBy: 'test-seed', updatedAt: NOW,
    attempts: 1, warnings: [], extractedBlobName: `${workspaceId}/${id}/source-document.json`,
  }
  api.jobRecords.set(`${workspaceId}/${id}`, { record, etag: '"job-seed"' })
  api.jobRubrics.set(`${workspaceId}/${id}`, [rubric])
  return { record, rubric, document, original: original.blob }
}

async function create(api, options = {}) {
  const seeded = options.seed ?? await seed(api)
  const input = {
    name: 'Engineering ladder', jobId: seeded.record.id, rubricId: seeded.rubric.id,
    rubricVersion: seeded.rubric.version, context: CONTEXT, grades: [9, 12], ...options.input,
  }
  const key = options.key ?? randomUUID()
  const response = await api.request(api.base, 'POST', input, { 'idempotency-key': key }, options.oid)
  const body = await response.json()
  if (!options.allowFailure) assert.equal(response.status, 202, JSON.stringify(body))
  return { response, body, detail: body.ladder, seeded, input, key }
}

async function stored(api, id) {
  const value = await api.grades.store.get(api.workspaceId, id)
  assert.ok(value, id)
  return value
}

async function finishDiscovery(api, detail) {
  for (const work of detail.workItems.filter(work => work.input.kind === 'discover' && ['queued', 'running'].includes(work.status))) {
    const value = await stored(api, work.id)
    await api.grades.store.replace({ ...value.record, status: 'succeeded' }, value.etag)
  }
  return (await api.request(`${api.base}/${detail.ladder.id}`)).json()
}

async function addSource(api, detail, options = {}) {
  const response = await api.request(`${api.base}/${detail.ladder.id}/sources/url`, 'POST',
    { url: options.url ?? 'https://agency.example.gov/engineering', ...(options.selectedPages ? { selectedPages: options.selectedPages } : {}) },
    { 'idempotency-key': options.key ?? randomUUID() })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  const source = body.ladder.sources.find(source => source.origin === 'url' && !detail.sources.some(old => old.id === source.id))
  return { detail: body.ladder, source }
}

async function readySource(api, source, overrides = {}, paragraphs) {
  const current = await stored(api, source.id)
  const originalName = `${api.workspaceId}/${source.ladderId}/${source.id}/original.pdf`
  const original = await api.grades.blobs.putImmutable(originalName, await pdf(2), 'application/pdf')
  const document = {
    id: source.documentId, version: current.record.documentVersion, title: source.title, kind: 'reference', sample: false,
    pageCount: 2, selectedPages: current.record.selectedPages, completeness: current.record.selectedPages.length ? 'selected-pages' : 'complete',
    paragraphs: paragraphs ?? [{
      id: 'ref-p1', page: current.record.selectedPages[0] ?? 1, heading: 'Engineering work at GS-9 and GS-12',
      text: 'Engineers evaluate systems independently using established methods and explain evidence-based recommendations.',
    }],
  }
  const documentName = `${api.workspaceId}/${source.ladderId}/${source.id}/document-v${document.version}.json`
  await api.grades.blobs.putImmutable(documentName, Buffer.from(JSON.stringify(document)), 'application/json')
  const record = {
    ...current.record, status: 'ready', originalBlobName: originalName, originalContentType: 'application/pdf',
    documentBlobName: documentName, sha256: original.blob.sha256, bytes: original.blob.bytes.byteLength,
    capturedAt: NOW, extractionMethod: 'document-intelligence', extractionVersion: 'reference-v1',
    pageCount: 2, completeness: document.completeness,
    coverage: { series: ['0801'], grades: [9, 12], functions: [], state: 'confirmed', explanation: 'Captured agency-scoped engineering work.' },
    ...overrides,
  }
  await api.grades.store.replace(record, current.etag)
  for (const value of api.grades.store.values.values()) {
    if (value.record.recordType === 'grade-work' && value.record.input.kind === 'extract-source' &&
      value.record.input.sourceId === source.id && ['queued', 'running'].includes(value.record.status)) {
      await api.grades.store.replace({ ...value.record, status: 'succeeded' }, value.etag)
    }
  }
  return document
}

async function confirmed(api, options = {}) {
  let { detail } = await create(api, options)
  detail = await finishDiscovery(api, detail)
  const added = await addSource(api, detail)
  const document = await readySource(api, added.source, options.sourceOverrides, options.paragraphs)
  detail = await (await api.request(`${api.base}/${detail.ladder.id}`)).json()
  const key = randomUUID()
  const response = await api.request(`${api.base}/${detail.ladder.id}/source-set`, 'POST', {
    decisions: [{ sourceId: added.source.id, selected: true, applicability: 'applicable', reason: 'The captured source describes applicable engineering work.' }],
  }, { 'idempotency-key': key, 'if-match': detail.etag })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return { detail: body.ladder, document, source: added.source }
}

async function generated(api, options = {}) {
  const value = await confirmed(api, options)
  const response = await api.request(`${api.base}/${value.detail.ladder.id}/generate`, 'POST', {}, {
    'if-match': value.detail.etag, 'idempotency-key': randomUUID(),
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  value.detail = body.ladder
  return value
}

async function publishGrade(api, detail, document, grade = 9, overrides = {}, extraCriteria = []) {
  const ladder = detail.ladder
  const head = await stored(api, headId(ladder.id, grade))
  const id = `grade-version-${randomUUID()}`
  const citation = {
    documentId: document.id, documentVersion: document.version, paragraphId: document.paragraphs[0].id,
    page: document.paragraphs[0].page, heading: document.paragraphs[0].heading, quote: document.paragraphs[0].text,
  }
  const version = {
    id, workspaceId: api.workspaceId, ladderId: ladder.id, recordType: 'grade-version',
    createdAt: NOW, updatedAt: NOW, grade, version: 1, generationId: ladder.generationId, sourceSetId: ladder.sourceSetId,
    rubric: {
      id, groupId: head.record.id, kind: 'grade', dataKind: 'real',
      ladder: ladder.name, grade: `GS-${grade}`, name: `${ladder.name} · GS-${grade}`,
      description: 'Source-grounded reviewer interpretation.', version: 1, createdAt: NOW,
      provenance: { kind: 'generated', model: 'grade-model', promptVersion: 'grade-v1' },
      criteria: [{
        id: 'engineering', competencyId: 'engineering', key: 'custom', label: 'Engineering analysis',
        description: 'Evaluate engineering systems independently and explain evidence-based recommendations.',
        weight: 100, guidance, support: 'direct', interpretation: 'Agency-scoped expectation interpreted from the captured work description.',
        sourceCitations: [citation], gradeBasis: [citation],
      }, ...clone(extraCriteria)],
    },
    qualifications: [], issues: [], createdBy: 'grade-worker', contentHash: '',
    ...overrides,
  }
  version.contentHash = gradeVersionHash(version)
  await api.grades.store.create(version)
  const review = {
    id: `grade-review-${randomUUID()}`, workspaceId: api.workspaceId, ladderId: ladder.id, recordType: 'grade-review',
    createdAt: NOW, updatedAt: NOW, grade, versionId: version.id, versionHash: version.contentHash,
    sourceSetId: version.sourceSetId, outcome: 'supported', issues: [], model: 'grade-review-model', promptVersion: 'grade-review-v1',
  }
  await api.grades.store.create(review)
  const updated = await api.grades.store.replace({
    ...head.record, status: 'ready-for-review', latestVersionId: version.id, latestReviewId: review.id,
  }, head.etag)
  return { version, review, head: updated }
}

async function frozenDocuments(api, sourceSet) {
  return Promise.all(sourceSet.sources.map(async source => JSON.parse(Buffer.from(
    (await api.grades.blobs.read(source.documentBlobName)).bytes).toString())))
}

const exclusionParagraphs = [
  { id: 'work', page: 1, heading: 'GS-9 engineering work', text: 'Evaluate engineering systems using established methods and explain evidence-based recommendations.' },
  { id: 'exclusion', page: 1, heading: 'GS-9 work-level exclusions', text: 'Government-wide engineering policy leadership is outside the GS-9 work covered by this standard.' },
  { id: 'qualification-exemption', page: 2, heading: 'GS-9 qualification requirements', text: 'A graduate degree is not required for this qualification path.' },
]

function exactCitation(document, paragraphId) {
  const paragraph = document.paragraphs.find(value => value.id === paragraphId)
  assert.ok(paragraph)
  return {
    documentId: document.id, documentVersion: document.version,
    paragraphId: paragraph.id, page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
  }
}

function excludedCriterion(document) {
  return {
    id: 'policy-leadership', competencyId: 'policy-leadership', key: 'leadership',
    label: 'Government-wide policy leadership',
    description: 'Government-wide policy leadership is not applicable to this GS-9 work scope.',
    weight: 0, support: 'not-applicable', gradeBasis: [],
    sourceCitations: [exactCitation(document, 'exclusion')],
    interpretation: 'The captured work-level standard explicitly excludes government-wide policy leadership from this grade.',
    guidance: 'Unscored: the cited work-level exclusion makes this competency not applicable.',
  }
}

test('grade configuration and centralized features preserve the job contract and fail closed', async () => {
  const env = {
    AZURE_TENANT_ID: TENANT_ID, SCORE_ALLOWED_USER_IDS: ALLOWED_OID, COSMOS_ENDPOINT: 'https://example.documents.azure.com/',
    STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net', APP_ORIGIN,
  }
  assert.equal(loadConfig(env).realGrades, undefined)
  assert.equal(loadConfig({ ...env, REAL_GRADE_LADDERS_ENABLED: 'true' }).realGrades.container, 'grade-records')
  assert.equal(loadConfig({ ...env, REAL_GRADE_LADDERS_ENABLED: 'true' }).realGrades.blobContainer, 'grade-sources')
  for (const setting of [
    { REAL_GRADE_LADDERS_ENABLED: 'yes' },
    { REAL_GRADE_LADDERS_ENABLED: 'true', GRADE_RECORDS_CONTAINER: 'workspaces' },
    { REAL_GRADE_LADDERS_ENABLED: 'true', GRADE_RECORDS_CONTAINER: 'job-records' },
    { REAL_GRADE_LADDERS_ENABLED: 'true', GRADE_SOURCE_CONTAINER: 'workspace-state' },
    { REAL_GRADE_LADDERS_ENABLED: 'true', GRADE_SOURCE_CONTAINER: 'job-sources' },
  ]) assert.throws(() => loadConfig({ ...env, ...setting }))
  const api = await start({ grades: false })
  try {
    assert.equal((await fetch(`${api.baseUrl}/features`)).status, 401)
    const response = await api.request('/features')
    const body = await response.json()
    assert.equal(body.realJobImports, true)
    assert.equal(body.realGradeLadders, false)
    assert.equal(body.limits.maxPdfPages, 50)
    assert.equal(body.gradeLimits.maxPdfPages, 250)
    assert.equal(body.gradeLimits.maxSources, 15)
    assert.equal((await api.request(api.base)).status, 503)
  } finally { await api.close() }
})

test('ladder creation freezes the explicitly selected authorized real job rubric version and seed evidence', async () => {
  const api = await start()
  try {
    const seeded = await seed(api)
    api.jobRubrics.get(`${api.workspaceId}/${seeded.record.id}`).push({ ...seeded.rubric, version: 2, name: 'Later saved version' })
    const created = await create(api, { seed: seeded })
    const { detail, key, input } = created
    assert.equal(detail.ladder.seedRubricVersion, 1)
    assert.equal(detail.ladder.seedRubricId, seeded.rubric.id)
    assert.equal(detail.ladder.status, 'discovering')
    assert.deepEqual(detail.levels.map(value => value.head.grade), [9, 12])
    assert.equal(detail.workItems[0].input.kind, 'discover')
    const seedSource = detail.sources[0]
    assert.equal(seedSource.origin, 'seed-job')
    assert.equal(seedSource.status, 'ready')
    const seedBlob = await api.grades.blobs.read(detail.ladder.seedBlobName)
    const snapshot = JSON.parse(Buffer.from(seedBlob.bytes).toString())
    assert.equal(snapshot.rubric.version, 1)
    assert.equal(snapshot.rubric.name, seeded.rubric.name)
    assert.ok(snapshot.source.originalBlobName.startsWith(`${api.workspaceId}/${detail.ladder.id}/`))
    const repeated = await api.request(api.base, 'POST', input, { 'idempotency-key': key })
    assert.equal(repeated.status, 202)
    assert.deepEqual(await repeated.json(), created.body)
    assert.equal((await api.request(api.base, 'POST', { ...input, name: 'Other input' }, { 'idempotency-key': key })).status, 409)
    const legacy = JSON.parse((await api.state.getState(api.workspaceId)).content)
    assert.ok(!legacy.jobs.some(job => job.id === seeded.record.id))
    assert.ok(!legacy.rubrics.some(rubric => rubric.kind === 'grade' && rubric.dataKind === 'real'))
    api.jobRecords.delete(`${api.workspaceId}/${seeded.record.id}`)
    api.jobRubrics.delete(`${api.workspaceId}/${seeded.record.id}`)
    api.jobs.blobs.values.clear()
    assert.equal((await api.request(`${api.base}/${detail.ladder.id}/sources/${seedSource.id}/document`)).status, 200)
    assert.equal((await api.request(`${api.base}/${detail.ladder.id}/sources/${seedSource.id}/original`)).status, 200)
  } finally { await api.close() }
})

for (const format of ['docx', 'doc']) {
  test(`${format.toUpperCase()} jobs remain private immutable GS seeds with byte-identical historical downloads, never standalone references`, async () => {
    const api = await start()
    try {
      const seeded = await seed(api, 'Word engineering seed', format)
      const original = await api.jobs.blobs.read(seeded.record.source.originalBlobName)
      const created = await create(api, { seed: seeded })
      let detail = created.detail
      const source = detail.sources[0]
      const address = `${api.base}/${detail.ladder.id}`
      assert.equal(source.origin, 'seed-job')
      assert.equal(source.purpose, 'job-context')
      assert.equal(source.extractionMethod, 'seed-snapshot')
      assert.equal(source.pageCount, 1)
      assert.deepEqual(source.selectedPages, [])
      assert.equal(source.originalContentType, WORD_TYPES[format])
      assert.equal(source.sha256, original.sha256)
      assert.equal(source.bytes, original.bytes.byteLength)
      assert.equal(source.originalBlobName, `${api.workspaceId}/${detail.ladder.id}/${source.id}/original.${format}`)
      const snapshot = parseGradeSeedSnapshot(JSON.parse(Buffer.from(
        (await api.grades.blobs.read(detail.ladder.seedBlobName)).bytes).toString()))
      assert.equal(snapshot.source.extractionMethod, format === 'doc' ? 'legacy-word' : 'document-intelligence')
      assert.deepEqual(snapshot.document, seeded.document)
      assert.deepEqual(snapshot.rubric.criteria[0].sourceCitations, seeded.rubric.criteria[0].sourceCitations)
      assert.deepEqual(Buffer.from((await api.grades.blobs.read(source.originalBlobName)).bytes), Buffer.from(original.bytes))

      const document = await api.request(`${address}/sources/${source.id}/document`)
      assert.equal(document.status, 200)
      assert.deepEqual((await document.json()).paragraphs, seeded.document.paragraphs)
      const download = await api.request(`${address}/sources/${source.id}/original`)
      assert.equal(download.status, 200)
      assert.equal(download.headers.get('content-type'), WORD_TYPES[format])
      assert.equal(download.headers.get('cache-control'), 'no-store')
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(download.headers.get('content-disposition'), `attachment; filename="${source.id}.${format}"`)
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(original.bytes))
      assert.equal((await api.request(`${address}/sources/${source.id}`, 'PATCH', { selectedPages: [1] },
        { 'if-match': detail.etag })).status, 400)
      assert.equal((await api.request(`${address}/sources/${source.id}/original`, 'GET', undefined, {}, OTHER_ALLOWED_OID)).status, 404)

      const independent = await fetch(`${api.baseUrl}${address}/sources/pdf`, {
        method: 'POST', headers: writeHeaders({
          'content-type': WORD_TYPES[format], 'x-file-name': `reference.${format}`, 'idempotency-key': randomUUID(),
        }), body: original.bytes,
      })
      assert.equal(independent.status, 400)
      for (const origin of ['upload', 'url', 'opm']) {
        assert.throws(() => parseGradeEntity({ ...source, origin, purpose: 'agency',
          ...(origin === 'url' ? { requestedUrl: `https://agency.example.gov/reference.${format}` } : {}) }))
      }

      detail = await finishDiscovery(api, detail)
      const confirmation = await api.request(`${address}/source-set`, 'POST', { decisions: [] },
        { 'idempotency-key': randomUUID(), 'if-match': detail.etag })
      assert.equal(confirmation.status, 200)
      const frozen = (await confirmation.json()).ladder.sourceSet
      assert.equal(frozen.sources.length, 1)
      assert.equal(frozen.sources[0].sha256, original.sha256)
      assert.equal(frozen.sources[0].originalBlobName, source.originalBlobName)
      assert.equal(frozen.contentHash, gradeSourceSetHash(frozen))

      api.jobRecords.clear()
      api.jobRubrics.clear()
      api.jobs.blobs.values.clear()
      api.grades.store.values.delete(`${api.workspaceId}/${source.id}`)
      const historical = await api.request(`${address}/sources/${source.id}/original?sourceSetId=${frozen.id}`)
      assert.equal(historical.status, 200)
      assert.equal(historical.headers.get('content-type'), WORD_TYPES[format])
      assert.deepEqual(Buffer.from(await historical.arrayBuffer()), Buffer.from(original.bytes))
      const oldDocument = await api.request(`${address}/sources/${source.id}/document?sourceSetId=${frozen.id}`)
      assert.equal(oldDocument.status, 200)
      assert.deepEqual((await oldDocument.json()).paragraphs, seeded.document.paragraphs)
      const stored = api.grades.blobs.values.get(source.originalBlobName)
      api.grades.blobs.values.set(source.originalBlobName, { ...stored, bytes: Buffer.from('changed bytes with a forged hash field') })
      assert.equal((await api.request(`${address}/sources/${source.id}/original?sourceSetId=${frozen.id}`)).status, 503)
    } finally { await api.close() }
  })

  test(`${format.toUpperCase()} GS creation rejects changed originals, foreign ownership and format/provenance mismatches`, async () => {
    const api = await start()
    try {
      const seeded = await seed(api, 'Word engineering seed', format)
      const key = `${api.workspaceId}/${seeded.record.id}`
      const original = await api.jobs.blobs.read(seeded.record.source.originalBlobName)
      for (const corrupt of [
        value => { value.source.bytes++ },
        value => { value.source.sha256 = '0'.repeat(64) },
        value => { delete value.source.sha256 },
        value => { delete value.source.bytes },
        value => { delete value.source.capturedAt },
        value => { delete value.source.extractionMethod },
        value => { value.workspaceId = 'other-workspace' },
        value => { value.source.originalBlobName = value.source.originalBlobName.replace(api.workspaceId, 'other-workspace') },
        value => { value.source.originalContentType = 'text/html' },
        value => { value.source.displayName = value.job.sourceLabel = 'mismatched.pdf' },
        value => { value.source.displayName = value.job.sourceLabel = format },
        value => { value.source.extractionMethod = 'html' },
        value => { value.source.kind = value.job.source = 'url'; value.source.url = 'https://example.gov/word-source' },
      ]) {
        const record = clone(seeded.record)
        corrupt(record)
        api.jobRecords.set(key, { record, etag: '"invalid-word-seed"' })
        const rejected = await create(api, { seed: seeded, allowFailure: true })
        assert.ok([400, 404, 409, 503].includes(rejected.response.status), JSON.stringify(rejected.body))
      }
      api.jobRecords.set(key, { record: seeded.record, etag: '"job-seed"' })
      api.jobs.blobs.values.set(seeded.record.source.originalBlobName, { ...original, bytes: Buffer.from('changed private original') })
      assert.equal((await create(api, { seed: seeded, allowFailure: true })).response.status, 503)
      api.jobs.blobs.values.set(seeded.record.source.originalBlobName, { ...original, contentType: 'text/html' })
      assert.equal((await create(api, { seed: seeded, allowFailure: true })).response.status, 503)
      assert.equal([...api.grades.store.values.values()].filter(value => value.record.recordType === 'grade-ladder').length, 0)
    } finally { await api.close() }
  })
}

for (const fileName of ['job.md', 'job.MARKDOWN']) {
  test(`Markdown ${fileName} seeds preserve exact frozen evidence and private original downloads after reload`, async () => {
    const api = await start()
    let reloaded
    try {
      const seeded = await seed(api, 'Markdown engineering role', { kind: 'markdown', fileName })
      const { detail } = await confirmed(api, { seed: seeded })
      const source = detail.sources.find(value => value.origin === 'seed-job')
      assert.equal(source.originalContentType, 'text/markdown')
      assert.equal(source.extractionMethod, 'seed-snapshot')
      assert.equal(source.completeness, 'complete')
      assert.deepEqual(source.selectedPages, [])
      assert.equal(source.originalBlobName, `${api.workspaceId}/${detail.ladder.id}/${source.id}/original.md`)
      const blob = await api.grades.blobs.read(detail.ladder.seedBlobName)
      const persisted = JSON.parse(Buffer.from(blob.bytes).toString('utf8'))
      const captured = parseGradeSeedSnapshot(persisted)
      assert.deepEqual(captured, persisted)
      assert.deepEqual(captured.document, seeded.document)
      assert.deepEqual(captured.rubric, seeded.rubric)
      assert.equal(captured.source.kind, 'markdown')
      assert.equal(captured.source.displayName, fileName)
      assert.equal(captured.source.sha256, seeded.original.sha256)
      const original = await api.grades.blobs.read(source.originalBlobName)
      assert.deepEqual(original.bytes, seeded.original.bytes)
      assert.equal(original.sha256, seeded.original.sha256)
      assert.equal(original.contentType, 'text/markdown')
      assert.deepEqual(parseGradeEntity(JSON.parse(JSON.stringify(detail.sourceSet))), detail.sourceSet)
      const frozenSeed = detail.sourceSet.sources.find(value => value.origin === 'seed-job')
      assert.equal(frozenSeed.originalBlobName, source.originalBlobName)
      assert.equal(frozenSeed.originalContentType, 'text/markdown')
      assert.equal(frozenSeed.sha256, seeded.original.sha256)
      assert.ok(detail.sourceSet.sources.filter(value => value.origin !== 'seed-job')
        .every(value => !Object.hasOwn(value, 'originalContentType')))
      reloaded = await start({ persisted: api })
      assert.equal(reloaded.jobRecords.size, 0)
      const restored = await (await reloaded.request(`${reloaded.base}/${detail.ladder.id}`)).json()
      assert.deepEqual(restored, detail)
      const history = await reloaded.request(`${reloaded.base}/${detail.ladder.id}/source-sets/${detail.sourceSet.id}`)
      assert.equal(history.status, 200)
      assert.equal((await history.json()).contentHash, detail.sourceSet.contentHash)
      for (const suffix of ['', `?sourceSetId=${detail.sourceSet.id}`]) {
        const path = `${reloaded.base}/${detail.ladder.id}/sources/${source.id}`
        const documentResponse = await reloaded.request(`${path}/document${suffix}`)
        assert.equal(documentResponse.status, 200)
        assert.deepEqual((await documentResponse.json()).paragraphs, seeded.document.paragraphs)
        const response = await reloaded.request(`${path}/original${suffix}`)
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /^text\/markdown(?:;|$)/)
        assert.equal(response.headers.get('content-disposition'), `attachment; filename="${source.id}.md"`)
        assert.equal(response.headers.get('etag'), original.etag)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
        assert.match(response.headers.get('content-security-policy'), /sandbox/)
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(seeded.original.bytes))
      }
    } finally {
      if (reloaded) await reloaded.close()
      await api.close()
    }
  })
}

test('Markdown seed metadata is strict and never extends supporting-reference upload or URL capture kinds', async () => {
  const api = await start()
  try {
    const seeded = await seed(api, 'Markdown engineering role', { kind: 'markdown' })
    const { detail } = await confirmed(api, { seed: seeded })
    const seedBlob = await api.grades.blobs.read(detail.ladder.seedBlobName)
    const snapshot = JSON.parse(Buffer.from(seedBlob.bytes).toString('utf8'))
    for (const change of [
      value => { value.source.kind = 'url'; value.job.source = 'url'; value.source.url = 'https://example.org/job.md' },
      value => { value.source.originalContentType = 'text/html' },
      value => { value.source.extractionMethod = 'html' },
      value => { delete value.source.extractionMethod },
      value => { delete value.source.capturedAt },
      value => { value.source.bytes = 10 * 1024 * 1024 + 1 },
      value => { value.source.url = 'https://example.org/job.md' },
      value => { value.source.finalUrl = 'https://example.org/job.md' },
      value => { value.source.originalBlobName = value.source.originalBlobName.replace(/\.md$/, '.html') },
      value => { value.source.originalBlobName = value.source.originalBlobName.replace(/\.md$/, '.markdown') },
      value => { value.source.displayName = '../job.md'; value.job.sourceLabel = '../job.md' },
      value => { value.source.displayName = 'job.pdf'; value.job.sourceLabel = 'job.pdf' },
      value => { value.rubric.criteria[0].sourceCitations[0].quote = 'An uncaptured requirement' },
    ]) {
      const invalid = clone(snapshot)
      change(invalid)
      assert.throws(() => parseGradeSeedSnapshot(invalid), undefined, change.toString())
    }
    const source = detail.sources.find(value => value.origin === 'seed-job')
    for (const change of [
      value => { value.origin = 'upload'; value.purpose = 'agency' },
      value => { value.origin = 'url'; value.purpose = 'agency'; value.requestedUrl = 'https://example.org/job.md' },
      value => { value.extractionMethod = 'markdown' },
      value => { value.extractionMethod = 'html' },
      value => { value.extractionMethod = 'document-intelligence' },
      value => { value.bytes = 10 * 1024 * 1024 + 1 },
      value => { value.originalContentType = 'application/pdf' },
      value => { value.originalBlobName = value.originalBlobName.replace(/\.md$/, '.pdf') },
      value => { value.requestedUrl = 'https://example.org/job.md' },
      value => { value.finalUrl = 'https://example.org/job.md' },
      value => { value.redirects = ['https://example.org/job.md'] },
      value => { value.selectedPages = [1] },
      value => { value.completeness = 'incomplete' },
    ]) {
      const invalid = clone(source)
      change(invalid)
      assert.throws(() => parseGradeEntity(invalid), undefined, change.toString())
    }
    for (const origin of ['upload', 'url', 'opm']) {
      const invalid = clone(detail.sourceSet)
      const supporting = invalid.sources.find(value => value.origin !== 'seed-job')
      supporting.origin = origin
      supporting.originalBlobName = supporting.originalBlobName.replace(/\.pdf$/, '.md')
      if (origin === 'opm') {
        supporting.publisher = 'OPM'
        supporting.url = 'https://www.opm.gov/standard.md'
        supporting.purpose = 'grading'
        supporting.authorityStatus = 'current'
      }
      invalid.contentHash = gradeSourceSetHash(invalid)
      assert.throws(() => parseGradeEntity(invalid), /Original blob ownership/)
    }
    for (const contentType of ['text/html', 'application/pdf', 'application/json']) {
      const invalid = clone(detail.sourceSet)
      invalid.sources.find(value => value.origin === 'seed-job').originalContentType = contentType
      invalid.contentHash = gradeSourceSetHash(invalid)
      assert.throws(() => parseGradeEntity(invalid))
    }
    const invalidReference = clone(detail.sourceSet)
    invalidReference.sources.find(value => value.origin !== 'seed-job').originalContentType = 'text/markdown'
    invalidReference.contentHash = gradeSourceSetHash(invalidReference)
    assert.throws(() => parseGradeEntity(invalidReference), /Original blob content type/)
    for (const fileName of ['standard.md', 'standard.pdf']) {
      const response = await fetch(`${api.baseUrl}${api.base}/${detail.ladder.id}/sources/pdf`, {
        method: 'POST', headers: writeHeaders({
          'content-type': 'text/markdown', 'x-file-name': fileName,
          'idempotency-key': randomUUID(), 'if-match': detail.etag,
        }), body: '# Supporting reference\nThis is not a PDF.',
      })
      assert.equal(response.status, 400)
      assert.match(JSON.stringify(await response.json()), fileName.endsWith('.md') ? /safe PDF basename/ : /application\/pdf/)
    }
  } finally { await api.close() }
})

test('Markdown seed creation rejects changed byte counts, forged digests and conflicting copied originals', async () => {
  const api = await start()
  try {
    for (const corruption of ['source-length', 'source-bytes', 'source-media', 'copy-digest', 'copy-bytes', 'copy-media']) {
      const seeded = await seed(api, 'Markdown engineering role', { kind: 'markdown' })
      const key = randomUUID()
      if (corruption === 'source-length') seeded.record.source.bytes++
      if (corruption === 'source-bytes') {
        api.jobs.blobs.values.get(seeded.record.source.originalBlobName).bytes = Buffer.from('Altered original bytes')
      }
      if (corruption === 'source-media') {
        api.jobs.blobs.values.get(seeded.record.source.originalBlobName).contentType = 'text/html'
      }
      if (corruption.startsWith('copy-')) {
        const original = clone(seeded.original)
        if (corruption === 'copy-digest') original.sha256 = '0'.repeat(64)
        if (corruption === 'copy-bytes') original.bytes = Buffer.from('Altered copied bytes')
        if (corruption === 'copy-media') original.contentType = 'application/pdf'
        api.grades.blobs.values.set(`${api.workspaceId}/ladder-${key}/source-${key}/original.md`, original)
      }
      const result = await create(api, { seed: seeded, key, allowFailure: true })
      assert.equal(result.response.status, corruption.startsWith('copy-') ? 409 : 503, corruption)
      assert.equal(await api.grades.store.get(api.workspaceId, `ladder-${key}`), undefined)
    }
  } finally { await api.close() }
})

test('grade seed validation retains the job PDF page limit while preserving Markdown section indices', async () => {
  const api = await start()
  try {
    const pdf = await seed(api, 'PDF role', { kind: 'pdf', page: 51 })
    const rejected = await create(api, { seed: pdf, allowFailure: true })
    assert.equal(rejected.response.status, 503)
    const markdown = await seed(api, 'Markdown role', { kind: 'markdown', page: 51 })
    const { detail } = await confirmed(api, { seed: markdown })
    const blob = await api.grades.blobs.read(detail.ladder.seedBlobName)
    const snapshot = parseGradeSeedSnapshot(JSON.parse(Buffer.from(blob.bytes).toString('utf8')))
    assert.equal(snapshot.document.paragraphs[0].page, 51)
    assert.equal(snapshot.rubric.criteria[0].sourceCitations[0].page, 51)
    assert.equal(detail.sourceSet.sources.find(source => source.origin === 'seed-job').pageCount, 51)
    const physicalPdf = clone(snapshot)
    physicalPdf.job.source = 'pdf'
    physicalPdf.job.sourceLabel = 'job.pdf'
    Object.assign(physicalPdf.source, {
      kind: 'pdf', displayName: 'job.pdf', originalContentType: 'application/pdf', extractionMethod: 'document-intelligence',
      originalBlobName: physicalPdf.source.originalBlobName.replace(/\.md$/, '.pdf'),
    })
    assert.throws(() => parseGradeSeedSnapshot(physicalPdf), /Seed job document is invalid/)
  } finally { await api.close() }
})

for (const kind of ['pdf', 'url']) {
  test(`legacy ${kind === 'pdf' ? 'PDF' : 'HTML'} grade seeds keep their serialized metadata and hashes`, async () => {
    const api = await start()
    try {
      const seeded = await seed(api, 'Existing engineering role', { kind })
      const { detail } = await confirmed(api, { seed: seeded })
      const blob = await api.grades.blobs.read(detail.ladder.seedBlobName)
      const snapshot = JSON.parse(Buffer.from(blob.bytes).toString('utf8'))
      assert.deepEqual(parseGradeSeedSnapshot(snapshot), snapshot)
      assert.equal(gradeContentHash(parseGradeSeedSnapshot(snapshot)), gradeContentHash(snapshot))
      assert.deepEqual(parseGradeEntity(detail.sourceSet), detail.sourceSet)
      assert.equal(gradeSourceSetHash(parseGradeEntity(detail.sourceSet)), detail.sourceSet.contentHash)
      assert.ok(detail.sourceSet.sources.every(source => !Object.hasOwn(source, 'originalContentType')))
      const legacy = clone(detail.sourceSet)
      for (const source of legacy.sources) delete source.originalContentType
      assert.equal(JSON.stringify(legacy), JSON.stringify(detail.sourceSet))
      assert.deepEqual(parseGradeEntity(legacy), legacy)
      assert.equal(gradeSourceSetHash(parseGradeEntity(legacy)), legacy.contentHash)
      const declared = clone(legacy)
      for (const source of declared.sources) {
        source.originalContentType = detail.sources.find(value => value.id === source.sourceId).originalContentType
      }
      declared.contentHash = gradeSourceSetHash(declared)
      assert.deepEqual(parseGradeEntity(declared), declared)
      const mismatched = clone(declared)
      mismatched.sources[0].originalContentType = mismatched.sources[0].originalContentType === 'application/pdf'
        ? 'text/html' : 'application/pdf'
      mismatched.contentHash = gradeSourceSetHash(mismatched)
      assert.throws(() => parseGradeEntity(mismatched), /Original blob content type mismatch/)
      assert.equal(snapshot.source.originalContentType, kind === 'pdf' ? 'application/pdf' : 'text/html')
      assert.match(snapshot.source.originalBlobName, kind === 'pdf' ? /\/original\.pdf$/ : /\/original\.html$/)
      const original = await api.grades.blobs.read(snapshot.source.originalBlobName)
      assert.deepEqual(original.bytes, seeded.original.bytes)
    } finally { await api.close() }
  })
}

test('legacy job PDF basenames remain valid grade seeds through freeze, reload and original downloads', async () => {
  const api = await start()
  try {
    for (const fileName of ['Role: engineer.pdf', 'CON.pdf', ' leading.pdf', '"Role".pdf', 'Role*.pdf', 'Role?.pdf']) {
      const seeded = await seed(api, 'Existing PDF role', { kind: 'pdf', fileName })
      const { detail } = await confirmed(api, { seed: seeded })
      const seedBlob = await api.grades.blobs.read(detail.ladder.seedBlobName)
      const snapshot = JSON.parse(Buffer.from(seedBlob.bytes).toString('utf8'))
      assert.deepEqual(parseGradeSeedSnapshot(snapshot), snapshot)
      assert.equal(snapshot.source.displayName, fileName)
      assert.equal(snapshot.job.sourceLabel, fileName)
      const source = detail.sourceSet.sources.find(value => value.origin === 'seed-job')
      assert.equal(Object.hasOwn(source, 'originalContentType'), false)
      assert.deepEqual(await (await api.request(`${api.base}/${detail.ladder.id}`)).json(), detail)
      const original = await api.request(`${api.base}/${detail.ladder.id}/sources/${source.sourceId}/original?sourceSetId=${detail.sourceSet.id}`)
      assert.equal(original.status, 200)
      assert.equal(original.headers.get('content-disposition'), `attachment; filename="${source.sourceId}.pdf"`)
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), Buffer.from(seeded.original.bytes))
    }
  } finally { await api.close() }
})

test('historical rubric selection snapshots the selected ID without changing the live job rubric pointer', async () => {
  const api = await start()
  try {
    const seeded = await seed(api)
    const jobKey = `${api.workspaceId}/${seeded.record.id}`
    const latest = { ...clone(seeded.rubric), id: `rubric-${randomUUID()}`, version: 2, name: 'Regenerated current rubric' }
    api.jobRubrics.get(jobKey).push(latest)
    const current = api.jobRecords.get(jobKey)
    api.jobRecords.set(jobKey, {
      ...current, record: { ...current.record, job: { ...current.record.job, rubricId: latest.id } },
    })
    const { detail } = await create(api, { seed: seeded })
    const blob = await api.grades.blobs.read(detail.ladder.seedBlobName)
    const captured = parseGradeSeedSnapshot(JSON.parse(Buffer.from(blob.bytes).toString()))
    assert.equal(captured.job.rubricId, seeded.rubric.id)
    assert.equal(captured.rubric.id, seeded.rubric.id)
    assert.equal(captured.rubric.version, seeded.rubric.version)
    assert.equal(detail.ladder.seedRubricId, seeded.rubric.id)
    assert.equal((await api.jobs.store.get(api.workspaceId, seeded.record.id)).record.job.rubricId, latest.id)
    const prepared = JSON.parse(Buffer.from((await api.grades.blobs.read(
      `${api.workspaceId}/${detail.ladder.id}/initialization.json`,
    )).bytes).toString())
    assert.equal(prepared.seed.job.rubricId, seeded.rubric.id)
    assert.deepEqual(prepared.seed.rubric, seeded.rubric)
  } finally { await api.close() }
})

test('creation requires ready real seed ownership, immutable saved version, UUID, strict body, and CSRF', async () => {
  const api = await start()
  try {
    const created = await create(api)
    const { input, seeded } = created
    assert.equal((await api.request(api.base, 'POST', input)).status, 400)
    const unspecifiedVersion = clone(input)
    delete unspecifiedVersion.rubricVersion
    assert.equal((await api.request(api.base, 'POST', unspecifiedVersion, { 'idempotency-key': randomUUID() })).status, 400)
    assert.equal((await api.request(api.base, 'POST', { ...input, createdBy: 'forged' }, { 'idempotency-key': randomUUID() })).status, 400)
    assert.equal((await api.request(api.base, 'POST', { ...input, rubricVersion: 99 }, { 'idempotency-key': randomUUID() })).status, 404)
    const noCsrf = await fetch(`${api.baseUrl}${api.base}`, {
      method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(input),
    })
    assert.equal(noCsrf.status, 403)
    const raw = api.jobRecords.get(`${api.workspaceId}/${seeded.record.id}`)
    raw.record.job.status = 'error'
    assert.equal((await create(api, { seed: seeded, allowFailure: true })).response.status, 409)
    raw.record.job.status = 'ready'
    raw.record.workspaceId = 'foreign-workspace'
    assert.equal((await create(api, { seed: seeded, allowFailure: true })).response.status, 404)
    assert.equal((await api.request(api.base, 'GET', undefined, {}, OTHER_ALLOWED_OID)).status, 404)
  } finally { await api.close() }
})

test('prepared seed timestamps and snapshots survive failed and ambiguous Cosmos publication without overwriting another initializer', async () => {
  const api = await start()
  try {
    const seeded = await seed(api)
    const key = randomUUID()
    api.grades.store._before(() => { throw new Error('Simulated transient publication failure') })
    const first = await create(api, { seed: seeded, key, allowFailure: true })
    assert.equal(first.response.status, 503)
    const name = `${api.workspaceId}/ladder-${key}/seed.json`
    const prepared = await api.grades.blobs.read(name)
    assert.ok(prepared)
    api.setNow('2026-09-17T21:00:00.000Z')
    api.jobRubrics.set(`${api.workspaceId}/${seeded.record.id}`, [{ ...seeded.rubric, version: 2, name: 'Changed after interrupted creation' }])
    const second = await create(api, { seed: seeded, key })
    assert.equal(second.detail.ladder.createdAt, NOW)
    assert.equal(second.detail.ladder.seedRubricVersion, 1)
    assert.deepEqual(await api.grades.blobs.read(name), prepared)
    api.jobRubrics.get(`${api.workspaceId}/${seeded.record.id}`).push(seeded.rubric)
    const duplicateKey = randomUUID()
    const simultaneous = await Promise.all([create(api, { seed: seeded, key: duplicateKey }), create(api, { seed: seeded, key: duplicateKey })])
    assert.equal(simultaneous[0].detail.ladder.id, simultaneous[1].detail.ladder.id)
    assert.equal(simultaneous[0].detail.ladder.createdAt, simultaneous[1].detail.ladder.createdAt)
    api.grades.store._after(() => { throw new Error('Cosmos accepted the transaction before transport timeout') })
    assert.equal((await create(api, { seed: seeded })).response.status, 202)
  } finally { await api.close() }
})

test('membership and viewer write restrictions run before reading raw PDF bodies; authorized uploads are private', async () => {
  const api = await start()
  try {
    const { detail } = await create(api)
    const url = `${api.baseUrl}${api.base}/${detail.ladder.id}/sources/pdf`
    const raw = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(20 * 1024 * 1024)])
    const uploadHeaders = { 'content-type': 'application/pdf', 'x-file-name': 'reference.pdf', 'idempotency-key': randomUUID() }
    assert.equal((await fetch(url, { method: 'POST', headers: uploadHeaders, body: raw })).status, 401)
    const beforeReads = api.grades.blobs.events.length
    assert.equal((await fetch(url, { method: 'POST', headers: writeHeaders(uploadHeaders, OTHER_ALLOWED_OID), body: raw })).status, 404)
    assert.equal(api.grades.blobs.events.length, beforeReads)
    api.directory._addMembership(api.workspaceId, membershipFor(api.workspaceId, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
    assert.equal((await fetch(url, { method: 'POST', headers: writeHeaders(uploadHeaders, OTHER_ALLOWED_OID), body: raw })).status, 403)
    assert.equal((await api.request(`${api.base}/${detail.ladder.id}`, 'GET', undefined, {}, OTHER_ALLOWED_OID)).status, 200)
    assert.equal((await fetch(url, { method: 'POST', headers: writeHeaders(uploadHeaders), body: raw })).status, 413)
    api.directory._addMembership(api.workspaceId, membershipFor(api.workspaceId, { oid: OTHER_ALLOWED_OID, role: 'editor' }))
    const accepted = await fetch(url, { method: 'POST', headers: writeHeaders(uploadHeaders, OTHER_ALLOWED_OID), body: await pdf(2) })
    const body = await accepted.json()
    assert.equal(accepted.status, 200, JSON.stringify(body))
    const source = body.ladder.sources.find(source => source.origin === 'upload')
    assert.equal(source.authorityStatus, 'supplied')
    assert.equal(source.purpose, 'agency')
    assert.equal(source.pageCount, 2)
    assert.equal(source.selectedPages.length, 0)
    assert.ok(source.originalBlobName.startsWith(`${api.workspaceId}/${detail.ladder.id}/${source.id}/`))
    const original = await api.request(`${api.base}/${detail.ladder.id}/sources/${source.id}/original`)
    assert.equal(original.status, 200)
    assert.equal(original.headers.get('cache-control'), 'no-store')
    assert.equal(original.headers.get('x-content-type-options'), 'nosniff')
    assert.match(original.headers.get('content-disposition'), /^attachment;/)
  } finally { await api.close() }
})

test('PDF intake validates structural metadata, page selection, safe filename, body limits, and idempotency', async () => {
  const api = await start()
  try {
    const { detail } = await create(api)
    const address = `${api.baseUrl}${api.base}/${detail.ladder.id}/sources/pdf`
    const bytes = await pdf(251)
    const key = randomUUID()
    const headers = writeHeaders({
      'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Agency policy.pdf'), 'idempotency-key': key,
    })
    assert.equal((await fetch(address, { method: 'POST', headers, body: bytes })).status, 400)
    for (const value of ['1-251', '0', '3-1', '1,1', '252', '../secret']) {
      assert.equal((await fetch(address, { method: 'POST', headers: { ...headers, 'x-source-pages': value }, body: bytes })).status, 400, value)
    }
    const selected = { ...headers, 'x-source-pages': '1,249-251' }
    const response = await fetch(address, { method: 'POST', headers: selected, body: bytes })
    assert.equal(response.status, 200)
    const source = (await response.json()).ladder.sources.find(source => source.origin === 'upload')
    assert.deepEqual(source.selectedPages, [1, 249, 250, 251])
    assert.equal((await fetch(address, { method: 'POST', headers: selected, body: bytes })).status, 200)
    assert.equal((await fetch(address, { method: 'POST', headers: { ...selected, 'x-file-name': 'different.pdf' }, body: bytes })).status, 409)
    assert.equal((await fetch(address, { method: 'POST', headers: { ...headers, 'x-file-name': '../secret.pdf' }, body: bytes })).status, 400)
    assert.equal((await fetch(address, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: Buffer.from('%PDF-1.7\nnot structurally valid') })).status, 400)
    assert.equal((await fetch(address, { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: bytes })).status, 400)
  } finally { await api.close() }
})

test('URL intake rejects unsafe locations and forged OPM authority and the 15-source budget excludes the automatic seed', async () => {
  const api = await start()
  try {
    let { detail } = await create(api)
    const address = `${api.base}/${detail.ladder.id}/sources/url`
    for (const url of [
      'ftp://example.com/a', 'https://name:password@example.com/a', 'https://127.0.0.1/a',
      'http://169.254.169.254/latest', 'http://168.63.129.16/', 'http://100.64.0.1/',
      'https://localhost/a', 'https://host.internal/a', 'https://example.com:8443/a',
    ]) assert.equal((await api.request(address, 'POST', { url }, { 'idempotency-key': randomUUID() })).status, 400, url)
    for (const field of ['origin', 'publisher', 'authorityStatus', 'originalBlobName', 'coverage']) {
      assert.equal((await api.request(address, 'POST', { url: 'https://www.opm.gov/standard.pdf', [field]: 'opm' },
        { 'idempotency-key': randomUUID() })).status, 400)
    }
    for (let index = 0; index < 15; index++) {
      const result = await addSource(api, detail, { url: `https://agency.example.gov/reference-${index}` })
      detail = result.detail
    }
    assert.equal(detail.sources.length, 16)
    assert.equal(detail.sources.filter(source => source.origin === 'seed-job').length, 1)
    assert.equal(detail.sources.filter(source => source.origin !== 'seed-job').length, 15)
    assert.ok(detail.sources.filter(source => source.origin === 'url').every(source =>
      source.authorityStatus === 'supplied' && source.purpose === 'agency' && !source.originalBlobName))
    assert.equal((await api.request(address, 'POST', { url: 'https://agency.example.gov/one-too-many' }, { 'idempotency-key': randomUUID() })).status, 400)
  } finally { await api.close() }
})

test('reviewers can scope supplied agency evidence but cannot overwrite explicit conflicts or client-assign coverage', async () => {
  for (const coverage of [
    { series: [], grades: [], functions: [], state: 'unknown', explanation: 'Document scope has not been assessed.' },
    { series: [], grades: [9, 12], functions: [], state: 'confirmed', explanation: 'No actual series mapping was recorded.' },
    { series: ['0801'], grades: [], functions: [], state: 'confirmed', explanation: 'No actual grade coverage was recorded.' },
    { series: ['0806'], grades: [9, 12], functions: [], state: 'confirmed', explanation: 'The captured source covers a different series.' },
  ]) {
    const api = await start()
    try {
      const { detail, document, source } = await generated(api, { sourceOverrides: { coverage } })
      const captured = detail.sourceSet.sources.find(value => value.sourceId === source.id)
      assert.equal(captured.authorityStatus, 'supplied')
      assert.equal(detail.sourceSet.decisions.find(value => value.sourceId === source.id).applicability, 'applicable')
      if (coverage.series.length === 0 || coverage.series.includes('0801')) {
        assert.equal(captured.coverage.state, 'confirmed')
        assert.deepEqual(captured.coverage.series, ['0801'])
        assert.deepEqual(captured.coverage.grades, [9, 12])
        assert.match(captured.coverage.explanation, /Reviewer-confirmed/)
        assert.ok(detail.sourceSet.issues.some(issue => issue.code === 'reviewer-confirmed-scope' &&
          issue.sourceId === source.id && issue.message.includes(coverage.explanation)))
      } else {
        assert.deepEqual(captured.coverage, coverage)
        assert.ok(detail.sourceSet.issues.some(issue => issue.code === 'unresolved-applicability' && issue.sourceId === source.id))
        const published = await publishGrade(api, detail, document)
        assert.equal((await api.request(`${api.base}/${detail.ladder.id}/grades/9/approve`, 'POST', {
          versionId: published.version.id, reviewId: published.review.id,
        }, { 'if-match': published.head.etag })).status, 409)
      }
      const response = await api.request(`${api.base}/${detail.ladder.id}/source-set`, 'POST', {
        decisions: [{
          sourceId: source.id, selected: true, applicability: 'applicable', reason: 'I assert that this source is confirmed.',
          coverage: { state: 'confirmed', series: ['0801'], grades: [9, 12] },
        }],
      }, { 'if-match': detail.etag, 'idempotency-key': randomUUID() })
      assert.equal(response.status, 400)
      assert.deepEqual((await stored(api, source.id)).record.coverage, coverage)
    } finally { await api.close() }
  }
})

test('later source assessments preserve the earlier reviewer-confirmed scope and source history', async () => {
  const api = await start()
  try {
    const paragraphs = [
      {
        id: 'ref-p1', page: 1, heading: 'GS-9 engineering work',
        text: 'At GS-9, engineers evaluate systems independently using established methods and explain evidence-based recommendations.',
      },
      {
        id: 'agency-scope', page: 1, heading: 'Agency applicability',
        text: 'Example federal agency. This standard applies to nonsupervisory engineering positions in occupational series 0801 at GS-9 and GS-12.',
      },
    ]
    const { detail, document, source } = await confirmed(api, {
      paragraphs,
      sourceOverrides: {
        coverage: { series: [], grades: [], functions: [], state: 'unknown', explanation: 'Awaiting document-grounded applicability assessment.' },
      },
    })
    const previous = clone(detail.sourceSet)
    const current = await stored(api, source.id)
    assert.equal(current.record.coverage.state, 'unknown')
    assert.equal(previous.sources.find(value => value.sourceId === source.id).coverage.state, 'confirmed')
    assert.ok(previous.issues.some(issue => issue.code === 'reviewer-confirmed-scope' && issue.message.includes('unknown')))
    const assessmentEvidence = {
      id: `agency-scope-${source.id}`, code: 'agency-scope-evidence', severity: 'warning', scope: 'source', sourceId: source.id,
      message: 'Source processing assessed explicit agency, series, grade and nonsupervisory scope. This supplied source is not verified OPM authority.',
      citations: [{
        documentId: document.id, documentVersion: document.version, paragraphId: 'agency-scope',
        page: 1, heading: 'Agency applicability', quote: paragraphs[1].text,
      }],
    }
    const assessed = {
      ...current.record, publisher: 'Example federal agency',
      coverage: {
        series: ['0801'], grades: [9, 12], functions: ['nonsupervisory'], state: 'confirmed',
        explanation: 'The captured agency-scope passage explicitly identifies this series, grades and functional scope.',
      },
      issues: [assessmentEvidence],
    }
    await api.grades.store.replace(assessed, current.etag)
    const confirmation = await api.request(`${api.base}/${detail.ladder.id}/source-set`, 'POST', {
      decisions: [{
        sourceId: source.id, selected: true, applicability: 'applicable',
        reason: 'Reviewed the source-processing assessment and its exact captured scope evidence.',
      }],
    }, { 'if-match': detail.etag, 'idempotency-key': randomUUID() })
    assert.equal(confirmation.status, 200)
    let updated = (await confirmation.json()).ladder
    const frozen = updated.sourceSet.sources.find(value => value.sourceId === source.id)
    assert.deepEqual(frozen.coverage, assessed.coverage)
    assert.equal(frozen.authorityStatus, 'supplied')
    assert.equal(frozen.origin, 'url')
    assert.deepEqual(frozen.issues, [assessmentEvidence])
    assert.ok(!updated.sourceSet.issues.some(issue => issue.code === 'unresolved-applicability'))
    assert.notEqual(updated.sourceSet.id, previous.id)
    assert.deepEqual((await api.request(`${api.base}/${detail.ladder.id}/source-sets/${previous.id}`)).status, 200)
    assert.deepEqual((await stored(api, previous.id)).record, previous)
    const generation = await api.request(`${api.base}/${detail.ladder.id}/generate`, 'POST', {}, {
      'if-match': updated.etag, 'idempotency-key': randomUUID(),
    })
    assert.equal(generation.status, 200)
    updated = (await generation.json()).ladder
    const published = await publishGrade(api, updated, document)
    const approval = await api.request(`${api.base}/${detail.ladder.id}/grades/9/approve`, 'POST', {
      versionId: published.version.id, reviewId: published.review.id,
    }, { 'if-match': published.head.etag })
    assert.equal(approval.status, 200, JSON.stringify(await approval.json()))
  } finally { await api.close() }
})

test('source-set freezing requires ready authorized sources and preserves source/history identity through page re-extraction', async () => {
  const api = await start()
  try {
    const { detail, document, source } = await confirmed(api)
    const set = detail.sourceSet
    assert.ok(set)
    assert.equal(set.contentHash, gradeSourceSetHash(set))
    assert.equal(set.sources.length, 2)
    assert.equal(set.decisions.find(decision => decision.sourceId === detail.sources.find(source => source.origin === 'seed-job').id).selected, true)
    assert.equal((await api.request(`${api.base}/${detail.ladder.id}/source-sets/${set.id}`)).status, 200)
    const oldDocumentName = set.sources.find(value => value.sourceId === source.id).documentBlobName
    const oldBlob = await api.grades.blobs.read(oldDocumentName)
    const patch = await api.request(`${api.base}/${detail.ladder.id}/sources/${source.id}`, 'PATCH', { selectedPages: [2] }, { 'if-match': detail.etag })
    assert.equal(patch.status, 200)
    const changed = (await patch.json()).ladder
    assert.equal(changed.sourceSet, null)
    const changedSource = changed.sources.find(value => value.id === source.id)
    assert.equal(changedSource.documentVersion, 2)
    assert.equal(changedSource.documentBlobName, undefined)
    const queued = changed.workItems.find(work => work.status === 'queued' && work.input.kind === 'extract-source')
    assert.equal(queued.input.documentVersion, 2)
    assert.deepEqual(await api.grades.blobs.read(oldDocumentName), oldBlob)
    const historical = await api.request(`${api.base}/${detail.ladder.id}/sources/${source.id}/document?sourceSetId=${set.id}`)
    assert.equal(historical.status, 200)
    assert.deepEqual(await historical.json(), document)
    await readySource(api, changedSource)
    const latest = await api.request(`${api.base}/${detail.ladder.id}/sources/${source.id}/document`)
    assert.equal(latest.status, 200)
    assert.equal((await latest.json()).version, 2)
    assert.equal((await api.request(`${api.base}/${detail.ladder.id}/sources/${source.id}/original?sourceSetId=${set.id}`)).status, 200)
    const other = (await create(api)).detail
    assert.equal((await api.request(`${api.base}/${other.ladder.id}/sources/${source.id}/document?sourceSetId=${set.id}`)).status, 404)
    assert.equal((await api.request(`${api.base}/${detail.ladder.id}/sources/source-${randomUUID()}/document?sourceSetId=${set.id}`)).status, 404)
    assert.equal((await api.request(`${api.base}/${detail.ladder.id}/sources/${source.id}/document?sourceSetId=..%2Fsecret`)).status, 404)
  } finally { await api.close() }
})

test('confirmation and discovery enforce ladder ETags, strict decisions, and stale generation cancellation', async () => {
  const api = await start()
  try {
    let { detail } = await create(api)
    const address = `${api.base}/${detail.ladder.id}`
    assert.equal((await api.request(`${address}/discover`, 'POST', {}, { 'idempotency-key': randomUUID() })).status, 428)
    assert.equal((await api.request(`${address}/discover`, 'POST', {}, { 'idempotency-key': randomUUID(), 'if-match': '"stale"' })).status, 409)
    assert.equal((await api.request(`${address}/source-set`, 'POST', { decisions: [] },
      { 'idempotency-key': randomUUID(), 'if-match': detail.etag })).status, 409)
    const key = randomUUID()
    const etag = detail.etag
    const first = await api.request(`${address}/discover`, 'POST', {}, { 'idempotency-key': key, 'if-match': etag })
    assert.equal(first.status, 200)
    detail = (await first.json()).ladder
    assert.equal(detail.workItems.filter(work => work.status === 'cancelled').length, 1)
    assert.equal((await api.request(`${address}/discover`, 'POST', {}, { 'idempotency-key': key, 'if-match': etag })).status, 200)
    const updated = await api.request(address, 'PATCH', { context: { ...CONTEXT, specialty: 'Genetics and disability policy systems' }, grades: [9, 11, 12] },
      { 'if-match': detail.etag })
    assert.equal(updated.status, 200)
    detail = (await updated.json()).ladder
    assert.equal(detail.workItems.filter(work => ['queued', 'running'].includes(work.status)).length, 0)
    assert.deepEqual(detail.levels.map(level => level.head.grade), [9, 11, 12])
    const added = await addSource(api, detail)
    assert.equal((await api.request(`${address}/source-set`, 'POST', {
      decisions: [{ sourceId: added.source.id, selected: true, applicability: 'applicable', reason: 'Applicable' }],
    }, { 'idempotency-key': randomUUID(), 'if-match': added.detail.etag })).status, 409)
    const seedSource = detail.sources.find(source => source.origin === 'seed-job')
    assert.equal((await api.request(`${address}/source-set`, 'POST', {
      decisions: [{ sourceId: seedSource.id, selected: false, applicability: 'excluded', reason: 'Ignore seed' }],
    }, { 'idempotency-key': randomUUID(), 'if-match': added.detail.etag })).status, 400)
  } finally { await api.close() }
})

test('source confirmation and generation recover committed-but-unacknowledged requests with stable idempotency receipts', async () => {
  const api = await start()
  try {
    let { detail } = await create(api)
    detail = await finishDiscovery(api, detail)
    const added = await addSource(api, detail)
    await readySource(api, added.source)
    detail = await (await api.request(`${api.base}/${detail.ladder.id}`)).json()
    const input = { decisions: [{
      sourceId: added.source.id, selected: true, applicability: 'applicable', reason: 'The reference supports this agency context.',
    }] }
    const confirmationKey = randomUUID()
    const etag = detail.etag
    const address = `${api.base}/${detail.ladder.id}`
    api.grades.store._after(() => { throw new Error('Publication acknowledgement lost') })
    const confirmed = await api.request(`${address}/source-set`, 'POST', input, {
      'idempotency-key': confirmationKey, 'if-match': etag,
    })
    assert.equal(confirmed.status, 200)
    detail = (await confirmed.json()).ladder
    const repeat = await api.request(`${address}/source-set`, 'POST', input, {
      'idempotency-key': confirmationKey, 'if-match': etag,
    })
    assert.equal(repeat.status, 200)
    assert.equal((await repeat.json()).ladder.sourceSet.id, detail.sourceSet.id)
    assert.equal((await api.request(`${address}/source-set`, 'POST', { decisions: [] }, {
      'idempotency-key': confirmationKey, 'if-match': etag,
    })).status, 409)
    const generationKey = randomUUID()
    const beforeGeneration = detail.etag
    api.grades.store._after(() => { throw new Error('Generation acknowledgement lost') })
    const generated = await api.request(`${address}/generate`, 'POST', {}, {
      'idempotency-key': generationKey, 'if-match': beforeGeneration,
    })
    assert.equal(generated.status, 200)
    detail = (await generated.json()).ladder
    assert.equal((await api.request(`${address}/generate`, 'POST', {}, {
      'idempotency-key': generationKey, 'if-match': beforeGeneration,
    })).status, 200)
    assert.equal(detail.workItems.filter(work => work.input.kind === 'plan-competencies').length, 1)
    assert.equal((await api.request(`${address}/generate`, 'POST', {}, {
      'idempotency-key': generationKey, 'if-match': detail.etag,
    })).status, 409)
    assert.equal((await api.request(`${address}/generate`, 'POST', {}, {
      'idempotency-key': randomUUID(), 'if-match': beforeGeneration,
    })).status, 409)
  } finally { await api.close() }
})

test('generation is idempotent and approval binds exact latest head/version/hash/review/source-set while preserving old approvals', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api)
    const address = `${api.base}/${detail.ladder.id}`
    const published = await publishGrade(api, detail, document)
    const currentDetail = await (await api.request(address)).json()
    const approve = () => api.request(`${address}/grades/9/approve`, 'POST', {
      versionId: published.version.id, reviewId: published.review.id,
    }, { 'if-match': published.head.etag })
    assert.equal((await api.request(`${address}/grades/9/approve`, 'POST', {
      versionId: published.version.id, reviewId: published.review.id,
    }, { 'if-match': currentDetail.etag })).status, 409, 'ladder ETag is not a grade-head ETag')
    const approved = await approve()
    const approvedBody = await approved.json()
    assert.equal(approved.status, 200, JSON.stringify(approvedBody))
    const approvedLevel = approvedBody.ladder.levels.find(level => level.head.grade === 9)
    assert.equal(approvedLevel.head.status, 'approved')
    assert.equal(approvedLevel.approval.versionHash, published.version.contentHash)
    assert.equal(approvedLevel.approval.reviewId, published.review.id)
    assert.deepEqual((await stored(api, published.version.id)).record, published.version)
    const editRubric = clone(published.version.rubric)
    delete editRubric.provenance
    editRubric.description = 'Updated reviewer-facing interpretation.'
    const edited = await api.request(`${address}/grades/9/draft`, 'PUT', { rubric: editRubric, qualifications: [] },
      { 'if-match': approvedLevel.etag })
    const editedBody = await edited.json()
    assert.equal(edited.status, 200, JSON.stringify(editedBody))
    const level = editedBody.ladder.levels.find(level => level.head.grade === 9)
    assert.equal(level.version.version, 2)
    assert.equal(level.version.rubric.id, level.version.id)
    assert.equal(level.version.rubric.provenance.kind, 'edited')
    assert.notEqual(level.version.contentHash, published.version.contentHash)
    assert.equal(level.head.approvedVersionId, published.version.id)
    assert.equal(level.approval.id, approvedLevel.approval.id)
    assert.equal(level.head.latestReviewId, undefined)
    assert.equal(level.head.status, 'processing')
    assert.ok(editedBody.ladder.workItems.some(work => work.input.kind === 'review-grade' && work.input.versionId === level.version.id))
    assert.equal((await api.request(`${address}/grades/9/approve`, 'POST', {
      versionId: level.version.id, reviewId: published.review.id,
    }, { 'if-match': level.etag })).status, 409)
    const history = await api.request(`${address}/grades/9/versions?limit=1`)
    assert.equal(history.status, 200)
    const first = await history.json()
    assert.equal(first.versions.length, 1)
    assert.ok(first.continuationToken)
    const second = await api.request(`${address}/grades/9/versions?limit=1&continuationToken=${first.continuationToken}`)
    assert.equal((await second.json()).versions.length, 1)
    const regenerated = await api.request(`${address}/generate`, 'POST', {}, {
      'if-match': editedBody.ladder.etag, 'idempotency-key': randomUUID(),
    })
    assert.equal(regenerated.status, 200)
    const retained = (await regenerated.json()).ladder.levels.find(level => level.head.grade === 9)
    assert.equal(retained.approval.id, approvedLevel.approval.id)
    assert.deepEqual((await stored(api, published.version.id)).record, published.version)
  } finally { await api.close() }
})

test('approval rejects mismatched semantic hashes, review verdicts, head gaps, global blockers, and empty/unsupported criteria', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api)
    let published = await publishGrade(api, detail, document)
    const address = `${api.base}/${detail.ladder.id}/grades/9/approve`
    const attempt = async () => {
      const head = await stored(api, published.head.record.id)
      return api.request(address, 'POST', { versionId: published.version.id, reviewId: published.review.id }, { 'if-match': head.etag })
    }
    for (const update of [
      { versionHash: 'a'.repeat(64) }, { sourceSetId: `source-set-${randomUUID()}` },
      { versionId: `grade-version-${randomUUID()}` }, { grade: 12 }, { outcome: 'needs-sources' },
      { issues: [{ id: 'global-gap', code: 'gap', severity: 'blocker', scope: 'context', message: 'Unresolved agency context.' }] },
    ]) {
      api.grades.store._unsafe({ ...published.review, ...update })
      assert.equal((await attempt()).status, 409, JSON.stringify(update))
    }
    api.grades.store._unsafe(published.review)
    for (const mutate of [
      version => { version.rubric.criteria = [] },
      version => { version.rubric.criteria[0].support = 'gap'; version.rubric.criteria[0].gradeBasis = []; version.rubric.criteria[0].sourceCitations = [] },
      version => { version.rubric.criteria[0].weight = 99 },
      version => { version.rubric.criteria[0].guidance = 'Use your judgment.' },
      version => { version.rubric.criteria[0].gradeBasis[0].quote = 'Fabricated source passage' },
      version => { version.rubric.criteria[0].sourceCitations[0].documentVersion = 2 },
    ]) {
      const version = clone(published.version)
      mutate(version)
      version.contentHash = gradeVersionHash(version)
      api.grades.store._unsafe(version)
      api.grades.store._unsafe({ ...published.review, versionHash: version.contentHash })
      assert.equal((await attempt()).status, 409)
    }
    api.grades.store._unsafe(published.version)
    api.grades.store._unsafe(published.review)
    const head = await stored(api, published.head.record.id)
    await api.grades.store.replace({
      ...head.record, issues: [{ id: 'head-gap', code: 'gap', scope: 'criterion', criterionId: 'engineering', severity: 'blocker', message: 'Unsupported criterion.' }],
    }, head.etag)
    assert.equal((await attempt()).status, 409)
  } finally { await api.close() }
})

test('approval accepts a cited unscored exclusion alongside supported weight 100 only after successful semantic review', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api, { paragraphs: exclusionParagraphs })
    const published = await publishGrade(api, detail, document, 9, {}, [excludedCriterion(document)])
    const documents = await frozenDocuments(api, detail.sourceSet)
    assert.deepEqual(validateGradeVersion(published.version, detail.sourceSet, documents), [])
    assert.deepEqual(validateGradeApproval(published.version, detail.sourceSet, documents), [])
    const address = `${api.base}/${detail.ladder.id}/grades/9/approve`
    const body = { versionId: published.version.id, reviewId: published.review.id }
    api.grades.store._unsafe({
      ...published.review, outcome: 'needs-sources',
      issues: [{ id: 'exclusion-review', code: 'exclusion-unverified', scope: 'criterion', criterionId: 'policy-leadership',
        grade: 9, severity: 'blocker', message: 'The independent review has not supported the proposed exclusion.' }],
    })
    assert.equal((await api.request(address, 'POST', body, { 'if-match': published.head.etag })).status, 409)
    api.grades.store._unsafe(published.review)
    const response = await api.request(address, 'POST', body, { 'if-match': published.head.etag })
    const approved = await response.json()
    assert.equal(response.status, 200, JSON.stringify(approved))
    const level = approved.ladder.levels.find(value => value.head.grade === 9)
    assert.equal(level.head.status, 'approved')
    assert.equal(level.version.rubric.criteria.find(value => value.support === 'not-applicable').weight, 0)
    assert.equal(level.approval.versionHash, published.version.contentHash)
    assert.deepEqual((await stored(api, published.version.id)).record, published.version)
    for (const change of [
      rubric => { rubric.criteria[1].support = 'derived' },
      rubric => { rubric.criteria[0].support = 'not-applicable' },
    ]) {
      const rubric = clone(published.version.rubric)
      delete rubric.provenance
      change(rubric)
      const rejected = await api.request(`${api.base}/${detail.ladder.id}/grades/9/draft`, 'PUT',
        { rubric, qualifications: [] }, { 'if-match': level.etag })
      assert.equal(rejected.status, 400)
      assert.match((await rejected.json()).error.message, /support classifications are server-owned/)
    }
  } finally { await api.close() }
})

test('approval rejects uncited, qualification-only, scored, all-N/A and gap rows despite a matching successful review hash', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api, { paragraphs: exclusionParagraphs })
    const published = await publishGrade(api, detail, document, 9, {}, [excludedCriterion(document)])
    const documents = await frozenDocuments(api, detail.sourceSet)
    const seedDocument = documents.find(value => value.id === detail.sourceSet.sources.find(source => source.origin === 'seed-job').documentId)
    const invalidRows = [
      ['uncited N/A', version => { version.rubric.criteria[1].sourceCitations = [] }],
      ['qualification-only N/A', version => { version.rubric.criteria[1].sourceCitations = [exactCitation(document, 'qualification-exemption')] }],
      ['seed-only N/A', version => { version.rubric.criteria[1].sourceCitations = [exactCitation(seedDocument, seedDocument.paragraphs[0].id)] }],
      ['all N/A', version => { version.rubric.criteria = [version.rubric.criteria[1]] }],
      ['gap', version => { version.rubric.criteria[1].support = 'gap' }],
      ['nonzero N/A weight', version => { version.rubric.criteria[1].weight = 1 }],
      ['N/A gradeBasis assertion', version => { version.rubric.criteria[1].gradeBasis = [exactCitation(document, 'exclusion')] }],
      ['N/A score anchors', version => { version.rubric.criteria[1].guidance = 'Unscored; 0: Not applicable to this role.' }],
      ['empty N/A interpretation', version => { version.rubric.criteria[1].interpretation = '' }],
      ['placeholder N/A guidance', version => { version.rubric.criteria[1].guidance = 'N/A' }],
      ['incomplete supported weights', version => { version.rubric.criteria[0].weight = 99 }],
      ['zero supported weight', version => { version.rubric.criteria[0].weight = 0 }],
      ['fabricated exclusion', version => { version.rubric.criteria[1].sourceCitations[0].quote = 'This quotation was fabricated.' }],
    ]
    for (const [label, mutate] of invalidRows) {
      const version = clone(published.version)
      mutate(version)
      version.contentHash = gradeRecordHash(version)
      assert.ok(validateGradeApproval(version, detail.sourceSet, documents).length, label)
      api.grades.store._unsafe(version)
      api.grades.store._unsafe({ ...published.review, versionHash: version.contentHash })
      const response = await api.request(`${api.base}/${detail.ladder.id}/grades/9/approve`, 'POST', {
        versionId: version.id, reviewId: published.review.id,
      }, { 'if-match': published.head.etag })
      assert.equal(response.status, 409, label)
    }
    for (const purpose of ['qualification', 'background']) {
      const sourceSet = clone(detail.sourceSet)
      const source = clone(sourceSet.sources.find(value => value.origin !== 'seed-job'))
      const sourceId = `source-${randomUUID()}`
      const evidenceDocument = {
        ...clone(document), id: `reference-${randomUUID()}`, title: `${purpose} exemption`,
        paragraphs: [clone(exclusionParagraphs[1])],
      }
      Object.assign(source, {
        sourceId, documentId: evidenceDocument.id, purpose, origin: 'opm', publisher: 'U.S. Office of Personnel Management',
        authorityStatus: 'current', url: 'https://www.opm.gov/test-only/exemptions',
        documentBlobName: `${api.workspaceId}/${detail.ladder.id}/${sourceId}/document-v1.json`,
        originalBlobName: `${api.workspaceId}/${detail.ladder.id}/${sourceId}/original.pdf`,
      })
      sourceSet.sources.push(source)
      sourceSet.decisions.push({ sourceId, selected: true, applicability: 'applicable', reason: 'Captured context, not work-level exclusion evidence.' })
      sourceSet.contentHash = gradeRecordHash(sourceSet)
      const version = clone(published.version)
      version.rubric.criteria[1].sourceCitations = [exactCitation(evidenceDocument, 'exclusion')]
      version.contentHash = gradeRecordHash(version)
      assert.ok(validateGradeApproval(version, sourceSet, [...documents, evidenceDocument])
        .some(error => error.includes('applicable work-level evidence')), `${purpose} cannot establish a work exclusion`)
    }
  } finally { await api.close() }
})

test('grade-specific source and review blockers do not block a different supported grade; global blockers still do', async () => {
  const api = await start()
  try {
    const blocker = { id: 'grade-twelve-gap', code: 'missing-support', severity: 'blocker', scope: 'grade', grade: 12, message: 'GS-12 lacks support.' }
    const { detail, document } = await generated(api, { sourceOverrides: { issues: [blocker] } })
    const nine = await publishGrade(api, detail, document, 9)
    const twelve = await publishGrade(api, detail, document, 12)
    api.grades.store._unsafe({ ...nine.review, issues: [blocker] })
    const response = await api.request(`${api.base}/${detail.ladder.id}/grades/9/approve`, 'POST', {
      versionId: nine.version.id, reviewId: nine.review.id,
    }, { 'if-match': nine.head.etag })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal((await api.request(`${api.base}/${detail.ladder.id}/grades/12/approve`, 'POST', {
      versionId: twelve.version.id, reviewId: twelve.review.id,
    }, { 'if-match': twelve.head.etag })).status, 409)
  } finally { await api.close() }
})

test('draft bodies cannot assign provenance, hashes, approvals, identities, or review verdicts and edits always request a new review', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api)
    const published = await publishGrade(api, detail, document)
    const address = `${api.base}/${detail.ladder.id}/grades/9/draft`
    const rubric = clone(published.version.rubric)
    delete rubric.provenance
    for (const input of [
      { rubric: { ...rubric, provenance: { kind: 'generated', model: 'forged', promptVersion: 'forged' } }, qualifications: [] },
      { rubric, qualifications: [], contentHash: 'a'.repeat(64) },
      { rubric, qualifications: [], approval: true },
      { rubric, qualifications: [], outcome: 'supported' },
      { rubric: { ...rubric, id: 'foreign-rubric' }, qualifications: [] },
      { rubric: { ...rubric, version: 99 }, qualifications: [] },
    ]) assert.equal((await api.request(address, 'PUT', input, { 'if-match': published.head.etag })).status, 400)
    const fakeQuote = clone(rubric)
    fakeQuote.criteria[0].gradeBasis[0].quote = 'Does not appear anywhere in the frozen source'
    assert.equal((await api.request(address, 'PUT', { rubric: fakeQuote, qualifications: [] }, { 'if-match': published.head.etag })).status, 400)
    const professional = clone(rubric)
    professional.criteria[0].description = 'Apply professional genetics and disability-policy expertise to evaluate engineering systems.'
    assert.equal((await api.request(address, 'PUT', { rubric: professional, qualifications: [] }, { 'if-match': published.head.etag })).status, 200)
  } finally { await api.close() }
})

test('cancellation, retry, source re-extraction, and stale publication are concurrency guarded and grade-scoped', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api)
    const nine = await publishGrade(api, detail, document, 9)
    const twelveHead = await stored(api, headId(detail.ladder.id, 12))
    const plan = detail.workItems.find(value => value.input.kind === 'plan-competencies')
    const failed = {
      id: `grade-work-${randomUUID()}`, recordType: 'grade-work', workspaceId: api.workspaceId, ladderId: detail.ladder.id,
      createdAt: NOW, updatedAt: NOW, input: {
        kind: 'generate-grade', grade: 12, sourceSetId: detail.ladder.sourceSetId,
        generationId: detail.ladder.generationId, competencyPlanId: `competency-plan-${randomUUID()}`,
      },
      status: 'failed', attempts: 3, error: { code: 'throttled', message: 'Model throttled', retryable: true },
    }
    await api.grades.store.create(failed)
    await api.grades.store.replace({ ...twelveHead.record, status: 'error' }, twelveHead.etag)
    const address = `${api.base}/${detail.ladder.id}`
    let loaded = await (await api.request(address)).json()
    const retry = await api.request(`${address}/retry`, 'POST', { grade: 12 }, { 'if-match': loaded.etag })
    assert.equal(retry.status, 200)
    loaded = (await retry.json()).ladder
    assert.equal(loaded.levels.find(level => level.head.grade === 9).head.status, 'ready-for-review')
    assert.equal(loaded.levels.find(level => level.head.grade === 12).head.status, 'queued')
    assert.equal((await stored(api, failed.id)).record.attempts, 0)
    assert.equal((await stored(api, failed.id)).record.nextAttemptAt, NOW)
    const old = await stored(api, failed.id)
    const cancel = await api.request(`${address}/cancel`, 'POST', { workId: failed.id }, { 'if-match': loaded.etag })
    assert.equal(cancel.status, 200)
    await assert.rejects(api.grades.store.replace({ ...old.record, status: 'succeeded' }, old.etag), StoreConflictError)
    assert.equal((await stored(api, nine.head.record.id)).record.status, 'ready-for-review')
    loaded = (await cancel.json()).ladder
    const unrelated = (await create(api)).detail.workItems[0].id
    assert.equal((await api.request(`${address}/cancel`, 'POST', { workId: unrelated }, { 'if-match': loaded.etag })).status, 404)
    const changed = await api.request(address, 'PATCH', { context: { ...CONTEXT, specialty: 'Updated source context' } }, { 'if-match': loaded.etag })
    assert.equal(changed.status, 200)
    loaded = (await changed.json()).ladder
    assert.equal((await api.request(`${address}/retry`, 'POST', { workId: plan.id }, { 'if-match': loaded.etag })).status, 409)
    const before = await stored(api, loaded.ladder.id)
    api.grades.store._before(async () => {
      await api.grades.store.replace({ ...before.record, name: 'Concurrent editor' }, before.etag)
    })
    assert.equal((await api.request(address, 'PATCH', { name: 'Stale writer' }, { 'if-match': loaded.etag })).status, 409)
    assert.equal((await stored(api, loaded.ladder.id)).record.name, 'Concurrent editor')
  } finally { await api.close() }
})

test('a cancelled grade can resume during planning without restarting the other grade; approval races never create orphan approvals', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api)
    const address = `${api.base}/${detail.ladder.id}`
    const cancel = await api.request(`${address}/cancel`, 'POST', { grade: 12 }, { 'if-match': detail.etag })
    assert.equal(cancel.status, 200)
    let changed = (await cancel.json()).ladder
    assert.equal(changed.levels.find(level => level.head.grade === 12).head.status, 'cancelled')
    assert.equal(changed.levels.find(level => level.head.grade === 9).head.status, 'queued')
    const retry = await api.request(`${address}/retry`, 'POST', { grade: 12 }, { 'if-match': changed.etag })
    assert.equal(retry.status, 200)
    changed = (await retry.json()).ladder
    assert.equal(changed.levels.find(level => level.head.grade === 12).head.status, 'queued')
    assert.equal(changed.workItems.filter(work => work.input.kind === 'plan-competencies').length, 1)
    const published = await publishGrade(api, changed, document)
    const head = await stored(api, published.head.record.id)
    const originalCount = [...api.grades.store.values.values()].filter(value => value.record.recordType === 'grade-approval').length
    api.grades.store._before(async () => {
      await api.grades.store.replace({ ...head.record, status: 'needs-sources' }, head.etag)
    })
    assert.equal((await api.request(`${address}/grades/9/approve`, 'POST', {
      versionId: published.version.id, reviewId: published.review.id,
    }, { 'if-match': head.etag })).status, 409)
    assert.equal([...api.grades.store.values.values()].filter(value => value.record.recordType === 'grade-approval').length, originalCount)
    assert.equal((await stored(api, head.record.id)).record.status, 'needs-sources')
  } finally { await api.close() }
})

test('obsolete extraction and review tasks cannot be retried after a new immutable document or draft version', async () => {
  const api = await start()
  try {
    const { detail, source } = await generated(api)
    const address = `${api.base}/${detail.ladder.id}`
    const oldExtraction = detail.workItems.find(work => work.input.kind === 'extract-source' && work.input.sourceId === source.id)
    const old = await stored(api, oldExtraction.id)
    await api.grades.store.replace({ ...old.record, status: 'cancelled' }, old.etag)
    const selection = await api.request(`${address}/sources/${source.id}`, 'PATCH', { selectedPages: [2] }, { 'if-match': detail.etag })
    assert.equal(selection.status, 200)
    const changed = (await selection.json()).ladder
    const currentSource = await stored(api, source.id)
    await api.grades.store.replace({ ...currentSource.record, status: 'error', error: { code: 'retryable', message: 'Retry extraction', retryable: true } }, currentSource.etag)
    assert.equal((await api.request(`${address}/retry`, 'POST', { workId: oldExtraction.id }, { 'if-match': changed.etag })).status, 409)
    const next = await generated(api)
    const published = await publishGrade(api, next.detail, next.document)
    const staleReview = {
      id: `grade-work-${randomUUID()}`, recordType: 'grade-work', workspaceId: api.workspaceId, ladderId: next.detail.ladder.id,
      createdAt: NOW, updatedAt: NOW, status: 'cancelled', attempts: 0,
      input: { kind: 'review-grade', grade: 9, generationId: published.version.generationId,
        sourceSetId: published.version.sourceSetId, versionId: `grade-version-${randomUUID()}` },
    }
    await api.grades.store.create(staleReview)
    const head = await stored(api, published.head.record.id)
    await api.grades.store.replace({ ...head.record, status: 'error' }, head.etag)
    assert.equal((await api.request(`${api.base}/${next.detail.ladder.id}/retry`, 'POST', { workId: staleReview.id },
      { 'if-match': next.detail.etag })).status, 409)
  } finally { await api.close() }
})

test('deterministic validators enforce strict stored shape, exact citations, page bindings, hashes and approval-only gaps', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api)
    const { version } = await publishGrade(api, detail, document)
    const documents = await frozenDocuments(api, detail.sourceSet)
    assert.deepEqual(validateGradeVersion(version, detail.sourceSet, documents), [])
    assert.deepEqual(validateGradeApproval(version, detail.sourceSet, documents), [])
    const unsupported = clone(version)
    unsupported.rubric.criteria[0].support = 'gap'
    unsupported.rubric.criteria[0].gradeBasis = []
    unsupported.rubric.criteria[0].sourceCitations = []
    unsupported.rubric.criteria[0].guidance = ''
    unsupported.contentHash = gradeVersionHash(unsupported)
    assert.deepEqual(validateGradeVersion(unsupported, detail.sourceSet, documents), [])
    assert.ok(validateGradeApproval(unsupported, detail.sourceSet, documents).length > 0)
    assert.throws(() => parseGradeEntity({ ...version, outcome: 'supported' }))
    assert.throws(() => parseGradeEntity({ ...version, rubric: { ...version.rubric, name: 'Tampered' } }))
    assert.throws(() => parseGradeEntity({ ...detail.sourceSet, sourceDocument: document }))
    assert.throws(() => parseGradeEntity({ ...detail.ladder, seedBlobName: `foreign/${detail.ladder.id}/seed.json` }))
    const source = detail.sources.find(source => source.origin === 'url')
    assert.throws(() => parseGradeEntity({ ...source, authorityStatus: 'current' }))
    assert.throws(() => parseGradeEntity({ ...source, origin: 'opm', publisher: 'OPM', authorityStatus: 'current' }))
    assert.throws(() => parseGradeEntity({ ...source, documentBlobName: `${api.workspaceId}/${detail.ladder.id}/source-${randomUUID()}/document-v1.json` }))
    assert.ok(validateReferenceDocument({ ...document, paragraphs: [...document.paragraphs, ...document.paragraphs] }).length)
    assert.ok(validateReferenceDocument({ ...document, selectedPages: [2] }).length)
    assert.ok(validateReferenceDocument({ ...document, surprise: true }).length)
    for (const mutate of [
      value => { value.rubric.criteria[0].gradeBasis[0].quote = 'not the captured text' },
      value => { value.rubric.criteria[0].sourceCitations[0].documentId = 'foreign-document' },
      value => { value.rubric.criteria[0].sourceCitations[0].documentVersion++ },
      value => { value.rubric.criteria[0].sourceCitations[0].page++ },
      value => { value.rubric.criteria[0].sourceCitations[0].heading = 'Other heading' },
      value => { value.rubric.criteria[0].description = 'Applicants must be under 40.' },
    ]) {
      const bad = clone(version)
      mutate(bad)
      bad.contentHash = gradeVersionHash(bad)
      assert.ok(validateGradeVersion(bad, detail.sourceSet, documents).length)
    }
    assert.equal(gradeContentHash({ a: 1, b: { x: 2, y: 3 } }), gradeContentHash({ b: { y: 3, x: 2 }, a: 1 }))
  } finally { await api.close() }
})

test('publication stores explicit support gaps and incomplete totals without applying approval-only blockers', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api)
    const { version } = await publishGrade(api, detail, document)
    const documents = await frozenDocuments(api, detail.sourceSet)
    const partial = clone(version)
    partial.rubric.criteria[0].weight = 40
    partial.issues = [{
      id: 'unresolved-extra-work', code: 'support-gap', severity: 'blocker', scope: 'grade', grade: 9,
      message: 'Additional competency evidence remains unresolved.',
    }]
    partial.contentHash = gradeRecordHash(partial)
    assert.deepEqual(validateGradeVersion(partial, detail.sourceSet, documents), [])
    assert.ok(validateGradeApproval(partial, detail.sourceSet, documents).some(error => error.includes('total exactly 100')))
    assert.ok(validateGradeApproval(partial, detail.sourceSet, documents).some(error => error.includes('Unresolved')))

    const sourceSet = clone(detail.sourceSet)
    sourceSet.id = `source-set-${randomUUID()}`
    sourceSet.context.confirmed = false
    const reference = sourceSet.sources.find(source => source.origin !== 'seed-job')
    reference.purpose = 'background'
    reference.coverage.state = 'unknown'
    sourceSet.decisions.find(decision => decision.sourceId === reference.sourceId).applicability = 'uncertain'
    const citation = clone(version.rubric.criteria[0].sourceCitations[0])
    sourceSet.issues = [{
      id: 'source-applicability-gap', code: 'unresolved-applicability', severity: 'blocker', scope: 'source',
      sourceId: reference.sourceId, message: 'This captured material does not yet establish grading applicability.',
      citations: [clone(citation)],
    }]
    sourceSet.contentHash = gradeRecordHash(sourceSet)
    const gap = clone(version)
    gap.id = `grade-version-${randomUUID()}`
    gap.rubric.id = gap.id
    gap.version = gap.rubric.version = 2
    gap.sourceSetId = sourceSet.id
    gap.rubric.criteria[0] = {
      ...gap.rubric.criteria[0], support: 'gap', weight: 0, gradeBasis: [],
      guidance: 'Unscored pending applicable work-level evidence.',
      interpretation: 'The captured passage is context only; it does not establish this grade expectation.',
    }
    gap.issues = [{
      id: 'criterion-support-gap', code: 'criterion-support-gap', severity: 'blocker', scope: 'criterion',
      criterionId: 'engineering', grade: 9, message: 'Additional grading evidence is required.',
      citations: [clone(citation)],
    }]
    gap.qualifications = [{
      id: 'qualification-gap', support: 'gap', text: 'Qualification applicability remains unresolved.',
      interpretation: 'The passage is context, not an established qualification requirement.',
      citations: [clone(citation)],
    }]
    gap.contentHash = gradeRecordHash(gap)
    assert.deepEqual(validateGradeVersion(gap, sourceSet, documents), [])
    assert.ok(validateGradeApproval(gap, sourceSet, documents).length > 0)
    assert.equal((await api.grades.store.create(sourceSet)).created, true)
    assert.equal((await api.grades.store.create(gap)).created, true)
    assert.deepEqual((await stored(api, gap.id)).record, gap)
  } finally { await api.close() }
})

test('incomplete drafts cannot hide fabricated citations in gaps or issues, or invalid supported scoring fields', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api)
    const { version } = await publishGrade(api, detail, document)
    const documents = await frozenDocuments(api, detail.sourceSet)
    const gap = clone(version)
    gap.rubric.criteria[0].support = 'gap'
    gap.rubric.criteria[0].weight = 0
    gap.rubric.criteria[0].guidance = 'Additional evidence is required; this criterion is unscored.'
    gap.rubric.criteria[0].gradeBasis = []
    gap.issues = [{
      id: 'missing-evidence', code: 'support-gap', scope: 'grade', grade: 9, severity: 'blocker',
      message: 'The grade needs additional supporting evidence.', citations: [clone(gap.rubric.criteria[0].sourceCitations[0])],
    }]
    gap.contentHash = gradeRecordHash(gap)
    assert.deepEqual(validateGradeVersion(gap, detail.sourceSet, documents), [])
    for (const mutate of [
      value => { value.rubric.criteria[0].sourceCitations[0].quote = 'Fabricated context for an unsupported criterion.' },
      value => { value.rubric.criteria[0].sourceCitations[0].documentVersion += 1 },
      value => { value.issues[0].citations[0].quote = 'Fabricated blocker evidence.' },
      value => { value.issues[0].citations[0].documentId = 'foreign-document' },
      value => { value.issues[0].citations[0].heading = 'Incorrect captured heading' },
      value => { value.sourceSetId = `source-set-${randomUUID()}` },
      value => { value.rubric.criteria[0].weight = -1 },
      value => { value.reviewVerdict = 'supported' },
    ]) {
      const invalid = clone(gap)
      mutate(invalid)
      invalid.contentHash = gradeRecordHash(invalid)
      assert.ok(validateGradeVersion(invalid, detail.sourceSet, documents).length > 0)
    }
    for (const weight of [0, -1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalid = clone(version)
      invalid.rubric.criteria[0].weight = weight
      invalid.contentHash = gradeRecordHash(invalid)
      assert.ok(validateGradeVersion(invalid, detail.sourceSet, documents).length > 0)
    }
    const invalidGuidance = clone(version)
    invalidGuidance.rubric.criteria[0].guidance = '3: Only one scoring anchor.'
    invalidGuidance.contentHash = gradeRecordHash(invalidGuidance)
    assert.ok(validateGradeVersion(invalidGuidance, detail.sourceSet, documents).some(error => error.includes('guidance')))
    const invalidSet = clone(detail.sourceSet)
    invalidSet.issues = [{
      id: 'invalid-issue-evidence', code: 'source-gap', scope: 'source', severity: 'blocker', message: 'Source evidence gap.',
      citations: [{ ...clone(gap.rubric.criteria[0].sourceCitations[0]), quote: 'This source-set issue quote was fabricated.' }],
    }]
    invalidSet.contentHash = gradeRecordHash(invalidSet)
    assert.ok(validateGradeVersion(gap, invalidSet, documents).some(error => error.includes('Citation')))
  } finally { await api.close() }
})

test('gradeRecordHash is the shared SHA256 of recursively ordinal-sorted JSON excluding only the root contentHash', () => {
  for (const recordType of ['grade-source-set', 'grade-version']) {
    const record = {
      recordType, updatedAt: NOW, contentHash: 'excluded',
      context: { a: 'lowercase', Z: 'uppercase', '2': 'two', '10': 'ten', contentHash: 'included' },
      sources: [{ b: 2, a: 1 }, { z: 3 }],
    }
    const original = clone(record)
    const expected = sha(
      `{"context":{"10":"ten","2":"two","Z":"uppercase","a":"lowercase","contentHash":"included"},"recordType":"${recordType}","sources":[{"a":1,"b":2},{"z":3}],"updatedAt":"${NOW}"}`,
    )
    assert.equal(gradeRecordHash(record), expected)
    assert.deepEqual(record, original)
    assert.equal(gradeRecordHash({ ...record, contentHash: 'different' }), expected)
    const withoutHash = clone(record)
    delete withoutHash.contentHash
    assert.equal(gradeRecordHash(withoutHash), expected)
    const reverseKeys = Object.fromEntries(Object.entries(record).reverse())
    reverseKeys.context = Object.fromEntries(Object.entries(record.context).reverse())
    assert.equal(gradeRecordHash(reverseKeys), expected)
    assert.notEqual(gradeRecordHash({ ...record, sources: record.sources.toReversed() }), expected)
    assert.notEqual(gradeRecordHash({ ...record, updatedAt: '2026-09-17T22:00:00.000Z' }), expected)
    assert.notEqual(gradeRecordHash({ ...record, context: { ...record.context, contentHash: 'nested change' } }), expected)
    assert.equal(recordType === 'grade-version' ? gradeVersionHash(record) : gradeSourceSetHash(record), expected)
  }
  assert.throws(() => gradeRecordHash({ recordType: 'grade-head' }), /immutable grade versions and source sets/)
})

test('discovery cancellation atomically advances sourceRevision and fences stale discovery publication', async () => {
  for (const global of [false, true]) {
    const api = await start()
    try {
      const { detail } = await create(api)
      const task = detail.workItems.find(work => work.input.kind === 'discover')
      const beforeWork = await stored(api, task.id)
      const leased = await api.grades.store.replace({
        ...beforeWork.record, status: 'running', lease: { owner: 'stale-discovery', expiresAt: '2026-09-17T22:00:00.000Z' },
      }, beforeWork.etag)
      const beforeLadder = await stored(api, detail.ladder.id)
      const response = await api.request(`${api.base}/${detail.ladder.id}/cancel`, 'POST', global ? {} : { workId: task.id }, {
        'if-match': beforeLadder.etag,
      })
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      assert.equal(body.ladder.ladder.sourceRevision, beforeLadder.record.sourceRevision + 1)
      assert.equal(body.ladder.ladder.status, global ? 'cancelled' : 'draft')
      const cancelled = await stored(api, task.id)
      assert.equal(cancelled.record.status, 'cancelled')
      assert.equal(cancelled.record.lease, undefined)
      const batch = api.grades.store.events.at(-1)
      assert.ok(batch.some(operation => operation.record.id === task.id && operation.etag === leased.etag))
      assert.ok(batch.some(operation => operation.record.id === detail.ladder.id && operation.etag === beforeLadder.etag &&
        operation.record.sourceRevision === beforeLadder.record.sourceRevision + 1))
      await assert.rejects(api.grades.store.transact(api.workspaceId, [
        { kind: 'replace', record: { ...beforeLadder.record, status: 'sources-ready' }, etag: beforeLadder.etag },
        { kind: 'replace', record: { ...leased.record, status: 'succeeded' }, etag: leased.etag },
      ]), StoreConflictError)
      assert.equal((await stored(api, detail.ladder.id)).record.sourceRevision, beforeLadder.record.sourceRevision + 1)
    } finally { await api.close() }
  }
})

test('work retry requires both the active source set and generation on the work and grade head', async () => {
  const api = await start()
  try {
    const { detail, document } = await generated(api)
    const published = await publishGrade(api, detail, document)
    const address = `${api.base}/${detail.ladder.id}`
    const originalHead = await stored(api, published.head.record.id)
    await api.grades.store.replace({ ...originalHead.record, status: 'error' }, originalHead.etag)
    for (const mismatch of [{ generationId: randomUUID() }, { sourceSetId: `source-set-${randomUUID()}` }]) {
      const work = {
        id: `grade-work-${randomUUID()}`, recordType: 'grade-work', workspaceId: api.workspaceId, ladderId: detail.ladder.id,
        createdAt: NOW, updatedAt: NOW, attempts: 0, status: 'cancelled',
        input: { kind: 'review-grade', grade: 9, generationId: published.version.generationId,
          sourceSetId: published.version.sourceSetId, versionId: published.version.id, ...mismatch },
      }
      await api.grades.store.create(work)
      assert.equal((await api.request(`${address}/retry`, 'POST', { workId: work.id }, { 'if-match': detail.etag })).status, 409)
      const currentWork = await stored(api, work.id)
      api.grades.store._unsafe({ ...currentWork.record, input: {
        ...currentWork.record.input, generationId: published.version.generationId, sourceSetId: published.version.sourceSetId,
      } })
      const currentHead = await stored(api, originalHead.record.id)
      await api.grades.store.replace({ ...originalHead.record, status: 'error', ...mismatch }, currentHead.etag)
      assert.equal((await api.request(`${address}/retry`, 'POST', { workId: work.id }, { 'if-match': detail.etag })).status, 409)
      const changedHead = await stored(api, originalHead.record.id)
      await api.grades.store.replace({ ...originalHead.record, status: 'error' }, changedHead.etag)
    }
  } finally { await api.close() }
})
