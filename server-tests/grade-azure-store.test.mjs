import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  createGradeStoreFromContainer, createGradeBlobStoreFromContainer,
  StoreConflictError, StoreNotFoundError, gradeVersionHash, gradeSourceSetHash,
} from '../dist-server/app.mjs'

const WORKSPACE = 'workspace-one'
const LADDER = `ladder-${randomUUID()}`
const NOW = '2026-09-17T20:30:00.000Z'
const seedId = `source-${randomUUID()}`
const context = {
  series: '0801', agency: 'Agency', agencyType: 'other-federal', supervision: 'nonsupervisory',
  functions: [], specialty: 'Engineering', confirmed: true, answers: {},
}
const ladder = () => ({
  id: LADDER, workspaceId: WORKSPACE, recordType: 'grade-ladder', createdAt: NOW, updatedAt: NOW,
  name: 'Grade ladder', context, grades: [9], seedJobId: `job-${randomUUID()}`,
  seedRubricId: 'seed-rubric', seedRubricVersion: 1, seedJobTitle: 'Engineer',
  seedBlobName: `${WORKSPACE}/${LADDER}/seed.json`, sourceIds: [seedId], sourceRevision: 1,
  status: 'draft', issues: [], createdBy: 'test', inputFingerprint: 'a'.repeat(64),
})
const work = (overrides = {}) => ({
  id: `grade-work-${randomUUID()}`, workspaceId: WORKSPACE, recordType: 'grade-work', ladderId: LADDER,
  createdAt: NOW, updatedAt: NOW, input: { kind: 'discover' }, status: 'queued', attempts: 0, ...overrides,
})

function container() {
  const values = new Map()
  const queries = []
  const batches = []
  const replacements = []
  let next = 0
  let resultCode
  let race
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  const save = record => {
    const document = { ...structuredClone(record), _etag: `"cosmos-${++next}"`, _rid: 'rid', _ts: 1000, _self: 'self', _attachments: 'attachments' }
    values.set(key(record.workspaceId, record.id), document)
    return document
  }
  return {
    values, queries, batches, replacements, save,
    _code(code) { resultCode = code },
    _race(callback) { race = callback },
    item(id, workspaceId) {
      return {
        async read() {
          const value = values.get(key(workspaceId, id))
          return { statusCode: value ? 200 : 404, resource: structuredClone(value) }
        },
        async replace(record, options) {
          replacements.push({ record: structuredClone(record), options })
          const current = values.get(key(workspaceId, id))
          if (!current || current._etag !== options.accessCondition.condition) throw Object.assign(new Error('Precondition failed'), { code: 412 })
          return { resource: save(record) }
        },
      }
    },
    items: {
      async create(record) {
        if (values.has(key(record.workspaceId, record.id))) throw Object.assign(new Error('Duplicate'), { code: 409 })
        return { resource: save(record) }
      },
      query(spec, options) {
        queries.push({ spec, options })
        const parameter = name => spec.parameters.find(value => value.name === name)?.value
        const records = () => [...values.values()].filter(record =>
          (!options?.partitionKey || record.workspaceId === options.partitionKey) &&
          record.recordType === parameter('@recordType') &&
          (!parameter('@ladderId') || record.ladderId === parameter('@ladderId')) &&
          (!parameter('@grade') || record.grade === parameter('@grade')) &&
          (!parameter('@generationId') || record.generationId === parameter('@generationId')) &&
          (!parameter('@status') || record.status === parameter('@status')) &&
          (!parameter('@now') || (['queued', 'running'].includes(record.status) &&
            (!record.nextAttemptAt || record.nextAttemptAt <= parameter('@now')) &&
            (!record.lease || record.lease.expiresAt <= parameter('@now')))))
          .sort((a, b) => parameter('@now') ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt))
          .slice(0, parameter('@limit') ?? options?.maxItemCount ?? 100).map(value => structuredClone(value))
        return {
          async fetchNext() { return { resources: records(), continuationToken: undefined } },
          async fetchAll() { return { resources: records() } },
        }
      },
      async batch(operations, workspaceId) {
        batches.push({ operations: structuredClone(operations), workspaceId })
        if (race) { const callback = race; race = null; callback() }
        const bad = resultCode ?? operations.map(operation => {
          const previous = values.get(key(workspaceId, operation.resourceBody.id))
          return operation.operationType === 'Create' ? previous ? 409 : 201
            : !previous ? 404 : previous._etag !== operation.ifMatch ? 412 : 200
        }).find(code => code >= 400)
        resultCode = undefined
        if (bad) return { code: bad, result: operations.map((_operation, index) => ({ statusCode: index ? 424 : bad })) }
        return {
          code: 200,
          result: operations.map(operation => ({
            statusCode: operation.operationType === 'Create' ? 201 : 200, eTag: save(operation.resourceBody)._etag,
          })),
        }
      },
    },
  }
}

test('Azure grade adapter publishes one same-workspace transactional batch with ETag guards, never sequential publication', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = ladder()
  const created = await store.create(root)
  assert.equal(created.created, true)
  const task = work()
  await store.transact(WORKSPACE, [
    { kind: 'replace', record: { ...root, status: 'discovering' }, etag: created.value.etag },
    { kind: 'create', record: task },
  ])
  assert.equal(cosmos.batches.length, 1)
  assert.equal(cosmos.replacements.length, 0)
  assert.equal(cosmos.batches[0].workspaceId, WORKSPACE)
  assert.deepEqual(cosmos.batches[0].operations.map(value => value.operationType), ['Replace', 'Create'])
  assert.equal(cosmos.batches[0].operations[0].ifMatch, created.value.etag)
  assert.equal((await store.get(WORKSPACE, root.id)).record.status, 'discovering')
  assert.equal((await store.get(WORKSPACE, task.id)).record.status, 'queued')
  assert.equal((await store.create(root)).created, false)
  assert.equal((await store.get(WORKSPACE, `ladder-${randomUUID()}`)), undefined)
})

test('ETag races fail atomically; batch HTTP/operation failures never partially publish', async () => {
  for (const code of [404, 409, 412, 424]) {
    const cosmos = container()
    const store = createGradeStoreFromContainer(cosmos)
    const root = ladder()
    const created = await store.create(root)
    const task = work()
    cosmos._code(code)
    await assert.rejects(store.transact(WORKSPACE, [
      { kind: 'create', record: task },
      { kind: 'replace', record: { ...root, status: 'discovering' }, etag: created.value.etag },
    ]), StoreConflictError)
    assert.equal((await store.get(WORKSPACE, root.id)).record.status, 'draft')
    assert.equal(await store.get(WORKSPACE, task.id), undefined)
  }
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = ladder()
  const created = await store.create(root)
  const task = work()
  cosmos._race(() => cosmos.save({ ...root, name: 'Concurrent editor' }))
  await assert.rejects(store.transact(WORKSPACE, [
    { kind: 'replace', record: { ...root, name: 'Stale editor' }, etag: created.value.etag },
    { kind: 'create', record: task },
  ]), StoreConflictError)
  assert.equal(await store.get(WORKSPACE, task.id), undefined)
  assert.equal((await store.get(WORKSPACE, root.id)).record.name, 'Concurrent editor')
  const latest = await store.get(WORKSPACE, root.id)
  await store.replace({ ...latest.record, name: 'Fresh editor' }, latest.etag)
  assert.deepEqual(cosmos.replacements[0].options, { accessCondition: { type: 'IfMatch', condition: latest.etag } })
})

test('optional discovery metadata round-trips while legacy drafts and missing series titles remain valid', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = ladder()
  const created = await store.create(root)
  assert.equal(created.value.record.discovery, undefined)
  const discovery = {
    seriesTitle: 'General Engineering', seriesStatus: 'listed', catalogVersion: 'opm-catalog-v1',
    capturedAt: NOW, artifactBlobName: `${WORKSPACE}/${LADDER}/discovery-${randomUUID()}.json`,
  }
  const discovered = await store.replace({ ...root, discovery, status: 'sources-ready' }, created.value.etag)
  assert.deepEqual((await store.get(WORKSPACE, root.id)).record.discovery, discovery)
  const withoutTitle = { ...discovery }
  delete withoutTitle.seriesTitle
  const titleless = await store.replace({ ...root, discovery: withoutTitle }, discovered.etag)
  assert.deepEqual(titleless.record.discovery, withoutTitle)
  const page = await store.list(WORKSPACE, { recordType: 'grade-ladder', limit: 1 })
  assert.deepEqual(page.items[0].record.discovery, withoutTitle)
  for (const invalid of [
    { ...discovery, seriesStatus: 'active' },
    { ...discovery, catalogVersion: '' },
    { ...discovery, capturedAt: 'not-a-timestamp' },
    { ...discovery, artifactBlobName: `other-workspace/${LADDER}/discovery-${randomUUID()}.json` },
    { ...discovery, artifactBlobName: `${WORKSPACE}/ladder-${randomUUID()}/discovery-${randomUUID()}.json` },
    { ...discovery, artifactBlobName: `${WORKSPACE}/${LADDER}/seed.json` },
    { ...discovery, artifactBlobName: `${WORKSPACE}/${LADDER}/${seedId}/capture.json` },
    { ...discovery, artifactBlobName: `${WORKSPACE}/${LADDER}/discovery-../secret.json` },
    { ...discovery, artifactBlobName: 'https://example.gov/discovery.json' },
    { ...discovery, unrecognizedField: true },
  ]) await assert.rejects(store.replace({ ...root, discovery: invalid }, titleless.etag))
  const legacy = await store.replace(root, titleless.etag)
  assert.equal(legacy.record.discovery, undefined)
})

test('Markdown seed-source Cosmos metadata reloads exactly and cannot become supporting-reference evidence', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const source = {
    id: seedId, workspaceId: WORKSPACE, ladderId: LADDER, recordType: 'grade-source',
    createdAt: NOW, updatedAt: NOW, origin: 'seed-job', purpose: 'job-context',
    title: 'Markdown engineering role', publisher: 'Imported job', redirects: [], discoveryPath: [],
    coverage: { series: ['0801'], grades: [9], functions: [], state: 'confirmed', explanation: 'Captured seed role context.' },
    authorityStatus: 'supplied', relatedLinks: [], status: 'ready', documentId: 'document-markdown-seed', documentVersion: 1,
    originalBlobName: `${WORKSPACE}/${LADDER}/${seedId}/original.md`, originalContentType: 'text/markdown',
    documentBlobName: `${WORKSPACE}/${LADDER}/${seedId}/document-v1.json`, sha256: 'a'.repeat(64), bytes: 123,
    capturedAt: NOW, extractionMethod: 'seed-snapshot', extractionVersion: 'grade-seed-v1',
    completeness: 'complete', pageCount: 1, selectedPages: [], issues: [], inputFingerprint: 'b'.repeat(64),
  }
  const created = await store.create(source)
  const restored = await store.get(WORKSPACE, seedId)
  assert.deepEqual(restored.record, source)
  assert.equal(restored.etag, created.value.etag)
  for (const overrides of [
    { origin: 'upload', purpose: 'agency' },
    { origin: 'url', purpose: 'agency', requestedUrl: 'https://example.org/reference.md' },
    { extractionMethod: 'html' },
    { extractionMethod: 'markdown' },
    { bytes: 10 * 1024 * 1024 + 1 },
    { originalContentType: 'text/html' },
    { originalBlobName: source.originalBlobName.replace(/\.md$/, '.html') },
  ]) await assert.rejects(store.replace({ ...source, ...overrides }, restored.etag))
  await assert.rejects(store.replace({ ...source, sha256: 'c'.repeat(64) }, restored.etag), /immutable/)
  assert.deepEqual((await store.get(WORKSPACE, seedId)), restored)
  assert.equal(cosmos.replacements.length, 0)
})

test('stored entity decoding is strict about nested fields, ownership, hashes, record bounds, and identities', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = ladder()
  const original = cosmos.save(root)
  assert.equal((await store.get(WORKSPACE, root.id)).etag, original._etag)
  for (const invalid of [
    { ...original, workspaceId: 'foreign-workspace' },
    { ...original, id: `ladder-${randomUUID()}` },
    { ...original, unknown: true },
    { ...original, context: { ...context, workspaceId: 'forged' } },
    { ...original, seedBlobName: `foreign/${LADDER}/seed.json` },
    { ...original, sourceIds: [seedId, seedId] },
    { ...original, sourceRevision: -1 },
    { ...original, createdAt: undefined },
    { ...original, _etag: undefined },
    { ...original, name: 'x'.repeat(600_000) },
  ]) {
    cosmos.values.set(`${WORKSPACE}/${root.id}`, invalid)
    await assert.rejects(store.get(WORKSPACE, root.id))
  }
  await assert.rejects(store.get('../secrets', root.id), /workspace/)
  await assert.rejects(store.get(WORKSPACE, '../secret'), /ID/)
  await assert.rejects(store.create({ ...root, workspaceId: '../unsafe' }))
  await assert.rejects(store.create({ ...work(), input: { kind: 'review-grade', versionId: 'foreign' } }))
  const head = {
    id: `grade-head-${LADDER.slice(7)}-12`, recordType: 'grade-head', workspaceId: WORKSPACE, ladderId: LADDER,
    grade: 9, status: 'draft', createdAt: NOW, updatedAt: NOW, issues: [],
  }
  await assert.rejects(store.create(head), /head identity/)
})

test('all immutable grade record types reject replace and mutable identity/provenance cannot be rewritten', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = ladder()
  const setId = `source-set-${randomUUID()}`
  const versionId = `grade-version-${randomUUID()}`
  const reviewId = `grade-review-${randomUUID()}`
  const common = { workspaceId: WORKSPACE, ladderId: LADDER, createdAt: NOW, updatedAt: NOW }
  const sourceSet = {
    ...common, id: setId, recordType: 'grade-source-set', revision: 1, context, grades: [9],
    seedBlobName: root.seedBlobName, sources: [{
      sourceId: seedId, title: 'Seed', origin: 'seed-job', purpose: 'job-context', publisher: 'Employer',
      documentId: 'seed-document', documentVersion: 1, documentBlobName: `${WORKSPACE}/${LADDER}/${seedId}/document-v1.json`,
      originalBlobName: `${WORKSPACE}/${LADDER}/${seedId}/original.pdf`, sha256: 'a'.repeat(64),
      authorityStatus: 'supplied',
      coverage: { series: ['0801'], grades: [9], functions: [], state: 'confirmed', explanation: 'Seed role context.' },
      pageCount: 1, selectedPages: [], completeness: 'complete', issues: [],
    }],
    decisions: [{ sourceId: seedId, selected: true, applicability: 'applicable', reason: 'Automatic seed' }],
    issues: [], confirmedBy: 'actor', contentHash: '',
  }
  sourceSet.contentHash = gradeSourceSetHash(sourceSet)
  const version = {
    ...common, id: versionId, recordType: 'grade-version', grade: 9, version: 1,
    sourceSetId: setId, generationId: randomUUID(),
    rubric: {
      id: versionId, groupId: `grade-head-${LADDER.slice(7)}-9`, kind: 'grade', dataKind: 'real', ladder: LADDER, grade: 'GS-9',
      name: 'Unsupported draft', description: 'Explicit draft without grading evidence.', version: 1, createdAt: NOW,
      criteria: [], provenance: { kind: 'generated', model: 'grade-model', promptVersion: 'grade-v1' },
    },
    qualifications: [], issues: [], createdBy: 'grade-worker', contentHash: '',
  }
  version.contentHash = gradeVersionHash(version)
  const records = [
    sourceSet, version,
    { ...common, id: `competency-plan-${randomUUID()}`, recordType: 'grade-competency-plan', sourceSetId: setId, generationId: version.generationId,
      competencies: [{ id: 'c1', label: 'Analysis', description: 'Engineering analysis', seedCriterionIds: [], citations: [] }],
      issues: [], model: 'model', promptVersion: 'plan-v1' },
    { ...common, id: reviewId, recordType: 'grade-review', grade: 9, versionId, versionHash: version.contentHash,
      sourceSetId: setId, outcome: 'needs-sources', issues: [], model: 'review-model', promptVersion: 'review-v1' },
    { ...common, id: `grade-approval-${randomUUID()}`, recordType: 'grade-approval', grade: 9, versionId,
      versionHash: version.contentHash, reviewId, sourceSetId: setId, approvedBy: 'actor' },
  ]
  for (const record of records) {
    const created = await store.create(record)
    await assert.rejects(store.replace(record, created.value.etag), /Immutable/)
    await assert.rejects(store.transact(WORKSPACE, [{ kind: 'replace', record, etag: created.value.etag }]), /Immutable/)
  }
  const created = await store.create(root)
  await assert.rejects(store.replace({ ...root, seedRubricVersion: 2 }, created.value.etag), /seed is immutable/)
  await assert.rejects(store.replace({ ...root, createdAt: '2026-09-17T20:00:00.000Z' }, created.value.etag), /identity/)
  await assert.rejects(store.replace(root, '*'), /exact grade ETag/)
  await assert.rejects(store.replace({ ...root, id: `ladder-${randomUUID()}`, seedBlobName: root.seedBlobName }, created.value.etag))
  await assert.rejects(store.replace(work(), '"missing"'), StoreNotFoundError)
  const task = work()
  const taskCreated = await store.create(task)
  await assert.rejects(store.replace({ ...task, input: { kind: 'extract-source', sourceId: seedId, documentVersion: 1 } }, taskCreated.value.etag), /input is immutable/)
})

test('transaction limits reject cross-partition, duplicate IDs, oversized batches, and immutable records before Cosmos calls', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  await assert.rejects(store.transact(WORKSPACE, []))
  await assert.rejects(store.transact(WORKSPACE, Array.from({ length: 101 }, () => ({ kind: 'create', record: work() }))))
  const repeated = work()
  await assert.rejects(store.transact(WORKSPACE, [{ kind: 'create', record: repeated }, { kind: 'create', record: repeated }]))
  await assert.rejects(store.transact(WORKSPACE, [{ kind: 'create', record: work({ workspaceId: 'other-workspace' }) }]), /cross workspace/)
  assert.equal(cosmos.batches.length, 0)
  const large = Array.from({ length: 6 }, () => {
    const record = ladder()
    const id = `ladder-${randomUUID()}`
    record.id = id
    record.seedBlobName = `${WORKSPACE}/${id}/seed.json`
    record.issues = Array.from({ length: 100 }, (_, index) => ({
      id: `issue-${index}`, code: 'large-issue', severity: 'warning', scope: 'context', message: 'x'.repeat(3800),
    }))
    return { kind: 'create', record }
  })
  await assert.rejects(store.transact(WORKSPACE, large), /payload budget/)
  assert.equal(cosmos.batches.length, 0)
})

test('grade lists are partitioned and pending work includes missing schedules and expired running leases ordered by createdAt', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const queued = work({ createdAt: '2026-09-17T20:00:00.000Z' })
  const expired = work({ status: 'running', lease: { owner: 'old-worker', expiresAt: '2026-09-17T20:10:00.000Z' } })
  const missingLease = work({ status: 'running' })
  const otherWorkspace = work({ workspaceId: 'workspace-two' })
  const future = work({ nextAttemptAt: '2026-09-17T21:00:00.000Z' })
  const leased = work({ status: 'running', lease: { owner: 'active-worker', expiresAt: '2026-09-17T21:00:00.000Z' } })
  const cancelled = work({ status: 'cancelled' })
  for (const record of [queued, expired, missingLease, otherWorkspace, future, leased, cancelled]) await store.create(record)
  const due = await store.listPending(NOW, 20)
  assert.equal(due.length, 4)
  assert.equal(due[0].record.id, queued.id)
  assert.ok(due.some(value => value.record.id === expired.id))
  assert.ok(due.some(value => value.record.id === missingLease.id))
  const query = cosmos.queries.at(-1)
  assert.match(query.spec.query, /ORDER BY c\.createdAt ASC/)
  assert.match(query.spec.query, /NOT IS_DEFINED\(c\.nextAttemptAt\)/)
  assert.match(query.spec.query, /c\.status = 'running'/)
  assert.ok(!query.spec.query.includes('ORDER BY c.nextAttemptAt'))
  const page = await store.list(WORKSPACE, { recordType: 'grade-work', ladderId: LADDER, limit: 2 })
  assert.equal(page.items.length, 2)
  assert.ok(page.items.every(value => value.record.workspaceId === WORKSPACE))
  assert.equal(cosmos.queries.at(-1).options.partitionKey, WORKSPACE)
  assert.equal(cosmos.queries.at(-1).options.maxItemCount, 2)
  await assert.rejects(store.listPending(NOW, 101))
  await assert.rejects(store.list(WORKSPACE, { recordType: 'grade-work', limit: 0 }))
})

for (const statusCode of [409, 412]) {
  test(`grade Blob adapter uses create-only conditions and preserves existing immutable bytes after HTTP ${statusCode}`, async () => {
    const name = `${WORKSPACE}/${LADDER}/seed.json`
    const bytes = Buffer.from('{"captured":"earlier"}')
    const store = createGradeBlobStoreFromContainer({
      getBlockBlobClient(requested) {
        assert.equal(requested, name)
        return {
          async upload(_bytes, _length, options) {
            assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
            assert.equal(options.blobHTTPHeaders.blobContentType, 'application/json')
            throw Object.assign(new Error('Already captured'), { statusCode })
          },
          async download() {
            return { etag: '"original"', contentType: 'application/json', contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) }
          },
        }
      },
    })
    const result = await store.putImmutable(name, Buffer.from('{"captured":"later"}'), 'application/json')
    assert.equal(result.created, false)
    assert.equal(result.blob.etag, '"original"')
    assert.deepEqual(Buffer.from(result.blob.bytes), bytes)
  })
}

test('grade Blob adapter bounds declared and streamed bytes, rejects unsafe paths/MIME, and allows safe worker cache artifacts', async () => {
  let writes = 0
  let reads = 0
  const service = createGradeBlobStoreFromContainer({
    getBlockBlobClient() {
      return {
        async upload() { writes++; return { etag: '"uploaded"' } },
        async download() { reads++; throw Object.assign(new Error('missing'), { statusCode: 404 }) },
      }
    },
  })
  for (const name of [
    '../workspace-state/secret.json', `${WORKSPACE}/${LADDER}/../secret.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/../../secret.json`, `${WORKSPACE}/${LADDER}/${seedId}/chunks/../../secret.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/x%2fsecret.json`, `${WORKSPACE}/${LADDER}/${seedId}/chunks/..secret.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/v1-cache%2fsecret.json`, `${WORKSPACE}/${LADDER}/${seedId}/chunks/v1-cache\\secret.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/unversioned-cache.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/v0-cache.json`, `${WORKSPACE}/${LADDER}/${seedId}/chunks/v01-cache.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/v1-.json`, `${WORKSPACE}/${LADDER}/${seedId}/chunks/v1-${'a'.repeat(121)}.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/document-v0.json`, `${WORKSPACE}/${LADDER}/${seedId}/document-v01.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/document-v1000001.json`, `${WORKSPACE}/${LADDER}/${seedId}/capture.json/extra`,
    `${WORKSPACE}/${LADDER}/../../workspace-state/private.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/secret.json`, `https://example.com/private.pdf`,
  ]) {
    await assert.rejects(service.read(name), /Invalid grade blob name/)
    await assert.rejects(service.putImmutable(name, Buffer.from('body'), 'application/json'), /Invalid grade blob name/)
  }
  assert.equal(reads, 0)
  assert.equal(writes, 0)
  const pdfName = `${WORKSPACE}/${LADDER}/${seedId}/original.pdf`
  await assert.rejects(service.putImmutable(pdfName, Buffer.from('body'), 'text/html'), /content type/)
  await assert.rejects(service.putImmutable(pdfName, Buffer.alloc(20 * 1024 * 1024 + 1), 'application/pdf'), /size/)
  const artifactNames = [
    `${WORKSPACE}/${LADDER}/${seedId}/capture.json`,
    `${WORKSPACE}/${LADDER}/discovery-${randomUUID()}.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/v2-ocr-operation.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/v2-ocr.result.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/v3-_ocr.result-ABC_123.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/v3-result..pages.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/chunks/v1000000-${'a'.repeat(120)}.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/document-v2.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/document-v1000000.json`,
    `${WORKSPACE}/${LADDER}/initialization.json`,
    `${WORKSPACE}/${LADDER}/requests/${randomUUID()}.json`,
  ]
  for (const name of artifactNames) {
    assert.equal((await service.putImmutable(name, Buffer.from('{}'), 'application/json')).created, true)
    assert.equal(await service.read(name), undefined)
  }
  assert.equal(writes, artifactNames.length)
  for (const contentLength of [20 * 1024 * 1024 + 1, undefined]) {
    const bounded = createGradeBlobStoreFromContainer({
      getBlockBlobClient() {
        return {
          async upload() {},
          async download() {
            return {
              etag: '"large"', contentType: 'application/pdf', contentLength,
              readableStreamBody: Readable.from([Buffer.alloc(20 * 1024 * 1024), Buffer.from('x')]),
            }
          },
        }
      },
    })
    await assert.rejects(bounded.read(pdfName), /exceeds the supported size/)
  }
})

test('grade seed Markdown originals preserve raw bytes, hashes and ETags and enforce the 10 MiB MIME-specific budget', async () => {
  const name = `${WORKSPACE}/${LADDER}/${seedId}/original.md`
  const maximum = 10 * 1024 * 1024
  let saved
  const service = createGradeBlobStoreFromContainer({
    getBlockBlobClient(requested) {
      assert.equal(requested, name)
      return {
        async upload(bytes, length, options) {
          assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
          assert.equal(options.blobHTTPHeaders.blobContentType, 'text/markdown')
          assert.equal(length, bytes.byteLength)
          if (saved) throw Object.assign(new Error('Already captured'), { statusCode: 409 })
          saved = Buffer.from(bytes)
          return { etag: '"markdown-seed"' }
        },
        async download() {
          return { etag: '"markdown-seed"', contentType: 'text/markdown', contentLength: saved.byteLength,
            readableStreamBody: Readable.from([saved]) }
        },
      }
    },
  })
  const bytes = Buffer.from('# Engineering role\r\n\r\nExact **Markdown** bytes.\r\n')
  const first = await service.putImmutable(name, bytes, 'text/markdown')
  assert.deepEqual(await service.read(name), first.blob)
  assert.deepEqual(first.blob.bytes, bytes)
  const repeated = await service.putImmutable(name, Buffer.from('Different Markdown'), 'text/markdown')
  assert.equal(repeated.created, false)
  assert.deepEqual(repeated.blob, first.blob)
  for (const contentType of ['text/html', 'application/json', 'application/pdf', 'text/plain']) {
    await assert.rejects(service.putImmutable(name, bytes, contentType), /content type/)
  }
  await assert.rejects(service.putImmutable(name.replace(/\.md$/, '.markdown'), bytes, 'text/markdown'), /blob name/)
  await assert.rejects(service.putImmutable(name, Buffer.alloc(maximum + 1), 'text/markdown'), /supported size/)
  saved = undefined
  const boundary = Buffer.alloc(maximum, 0x61)
  assert.equal((await service.putImmutable(name, boundary, 'text/markdown')).created, true)
  assert.equal((await service.read(name)).bytes.byteLength, maximum)
  for (const contentLength of [maximum + 1, undefined]) {
    const bounded = createGradeBlobStoreFromContainer({
      getBlockBlobClient() {
        return { async upload() {}, async download() {
          return { etag: '"oversized"', contentType: 'text/markdown', contentLength,
            readableStreamBody: Readable.from([boundary, Buffer.from('x')]) }
        } }
      },
    })
    await assert.rejects(bounded.read(name), /supported size/)
  }
  for (const contentType of ['text/html', 'application/json']) {
    const wrongMedia = createGradeBlobStoreFromContainer({
      getBlockBlobClient() {
        return { async upload() {}, async download() {
          return { etag: '"wrong-media"', contentType, contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) }
        } }
      },
    })
    await assert.rejects(wrongMedia.read(name), /content metadata/)
  }
})

for (const statusCode of [409, 412]) {
  test(`capture manifest conflicts preserve the first hash/final URL binding after HTTP ${statusCode}`, async () => {
    const name = `${WORKSPACE}/${LADDER}/${seedId}/capture.json`
    const manifest = {
      sourceId: seedId, blobName: `${WORKSPACE}/${LADDER}/${seedId}/original.html`,
      contentType: 'text/html', sha256: 'a'.repeat(64), bytes: 20, capturedAt: NOW,
      finalUrl: 'https://agency.example.gov/captured-reference', redirects: [],
    }
    const body = Buffer.from(JSON.stringify(manifest))
    const service = createGradeBlobStoreFromContainer({
      getBlockBlobClient(requested) {
        assert.equal(requested, name)
        return {
          async upload(_bytes, _length, options) {
            assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
            throw Object.assign(new Error('An initializer already captured this manifest'), { statusCode })
          },
          async download() {
            return {
              etag: '"first-capture"', contentType: 'application/json', contentLength: body.length,
              readableStreamBody: Readable.from([body]),
            }
          },
        }
      },
    })
    const replacement = { ...manifest, sha256: 'b'.repeat(64), finalUrl: 'https://agency.example.gov/changed-reference' }
    const result = await service.putImmutable(name, Buffer.from(JSON.stringify(replacement)), 'application/json')
    assert.equal(result.created, false)
    assert.deepEqual(JSON.parse(Buffer.from(result.blob.bytes).toString()), manifest)
    assert.equal(result.blob.etag, '"first-capture"')
  })
}
