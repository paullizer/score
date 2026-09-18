import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  createGradeStoreFromContainer, createGradeBlobStoreFromContainer,
  StoreConflictError, StoreNotFoundError, gradeVersionHash, gradeSourceSetHash,
} from '../dist-server/app.mjs'
import { gradeLifecycleTesting } from './grade-lifecycle-fakes.mjs'

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
        const records = () => {
          if (spec.query.includes('VALUE c.workspaceId')) return [...new Set([...values.values()].filter(record =>
            (record.recordType === 'grade-lifecycle' && record.ladderId && (record.state === 'deleting' || record.pending?.length ||
              (record.preparation && record.preparation.expiresAt <= parameter('@now')))) ||
            (['grade-ladder', 'grade-head'].includes(record.recordType) && record.lifecycle?.deletingAt))
            .map(record => record.workspaceId))].slice(0, parameter('@limit'))
          return [...values.values()].filter(record =>
          (!options?.partitionKey || record.workspaceId === options.partitionKey) &&
          (parameter('@recordType') ? record.recordType === parameter('@recordType') : record.recordType !== 'grade-lifecycle') &&
          (!parameter('@ladderId') || record.ladderId === parameter('@ladderId') ||
            (spec.query.includes('c.id = @ladderId') && record.id === parameter('@ladderId'))) &&
          (!parameter('@grade') || record.grade === parameter('@grade') ||
            (spec.query.includes('c.input.grade') && record.input?.grade === parameter('@grade'))) &&
          (!parameter('@generationId') || record.generationId === parameter('@generationId')) &&
          (!parameter('@status') || record.status === parameter('@status')) &&
          (!parameter('@now') || (['queued', 'running'].includes(record.status) &&
            (!record.nextAttemptAt || record.nextAttemptAt <= parameter('@now')) &&
            (!record.lease || record.lease.expiresAt <= parameter('@now')))))
          .sort((a, b) => spec.query.includes('ORDER BY c.id') ? a.id.localeCompare(b.id) :
            parameter('@now') ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt))
          .map(value => structuredClone(value))
        }
        return {
          async fetchNext() {
            const found = records()
            const start = Number(options?.continuationToken ?? 0)
            const limit = parameter('@limit') ?? options?.maxItemCount ?? 100
            return { resources: found.slice(start, start + limit), continuationToken: start + limit < found.length ? String(start + limit) : undefined }
          },
          async fetchAll() { return { resources: records().slice(0, parameter('@limit') ?? 100) } },
        }
      },
      async batch(operations, workspaceId) {
        batches.push({ operations: structuredClone(operations), workspaceId })
        if (race) { const callback = race; race = null; callback() }
        const bad = resultCode ?? operations.map(operation => {
          const previous = values.get(key(workspaceId, operation.id ?? operation.resourceBody.id))
          return operation.operationType === 'Create' ? previous ? 409 : 201
            : !previous ? 404 : previous._etag !== operation.ifMatch ? 412 : 200
        }).find(code => code >= 400)
        resultCode = undefined
        if (bad) return { code: bad, result: operations.map((_operation, index) => ({ statusCode: index ? 424 : bad })) }
        return {
          code: 200,
          result: operations.map(operation => {
            if (operation.operationType === 'Delete') {
              values.delete(key(workspaceId, operation.id))
              return { statusCode: 204 }
            }
            return { statusCode: operation.operationType === 'Create' ? 201 : 200, eTag: save(operation.resourceBody)._etag }
          }),
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
  assert.equal(cosmos.batches.length, 1)
  const initial = cosmos.batches[0]
  assert.equal(initial.workspaceId, WORKSPACE)
  assert.deepEqual(initial.operations.map(operation => [operation.operationType, operation.resourceBody.id]), [
    ['Create', root.id], ['Create', 'grade-lifecycle-workspace'], ['Create', `grade-lifecycle-${LADDER}`],
  ])
  assert.deepEqual(initial.operations[0].resourceBody, root)
  const workspaceControl = await store.getControl(WORKSPACE)
  const familyControl = await store.getControl(WORKSPACE, LADDER)
  const task = work()
  await store.transact(WORKSPACE, [
    { kind: 'replace', record: { ...root, status: 'discovering' }, etag: created.value.etag },
    { kind: 'create', record: task },
  ])
  assert.equal(cosmos.batches.length, 2)
  assert.equal(cosmos.replacements.length, 0)
  const publication = cosmos.batches[1]
  assert.equal(publication.workspaceId, WORKSPACE)
  assert.deepEqual(publication.operations, [
    { operationType: 'Replace', id: root.id, resourceBody: { ...root, status: 'discovering' }, ifMatch: created.value.etag },
    { operationType: 'Create', resourceBody: task },
    { operationType: 'Replace', id: workspaceControl.record.id, resourceBody: workspaceControl.record, ifMatch: workspaceControl.etag },
    { operationType: 'Replace', id: familyControl.record.id, resourceBody: familyControl.record, ifMatch: familyControl.etag },
  ])
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
  const workspaceControl = await store.getControl(WORKSPACE)
  const familyControl = await store.getControl(WORKSPACE, LADDER)
  const previousBatches = cosmos.batches.length
  await store.replace({ ...latest.record, name: 'Fresh editor' }, latest.etag)
  assert.equal(cosmos.batches.length, previousBatches + 1)
  assert.equal(cosmos.replacements.length, 0)
  assert.equal(cosmos.batches.at(-1).workspaceId, WORKSPACE)
  assert.deepEqual(cosmos.batches.at(-1).operations, [
    { operationType: 'Replace', id: root.id, resourceBody: { ...latest.record, name: 'Fresh editor' }, ifMatch: latest.etag },
    { operationType: 'Replace', id: workspaceControl.record.id, resourceBody: workspaceControl.record, ifMatch: workspaceControl.etag },
    { operationType: 'Replace', id: familyControl.record.id, resourceBody: familyControl.record, ifMatch: familyControl.etag },
  ])
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

test('workspace lifecycle fences are checked in the same Cosmos batch as create, claim and publication', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = (await store.create(ladder())).value
  const task = (await store.create(work())).value
  const control = await store.getControl(WORKSPACE)
  cosmos._race(() => cosmos.save({ ...control.record, state: 'archived', updatedAt: NOW }))
  await assert.rejects(store.replace({ ...task.record, status: 'running',
    lease: { owner: 'worker', expiresAt: '2026-09-18T00:00:00.000Z' } }, task.etag), StoreConflictError)
  assert.equal((await store.get(WORKSPACE, task.record.id)).record.status, 'queued')
  const guardedBatch = cosmos.batches.at(-1)
  assert.equal(guardedBatch.operations.find(operation => operation.id === control.record.id).ifMatch, control.etag)
  await assert.rejects(store.create(work()), StoreConflictError)
  await assert.rejects(store.replace({ ...root.record, name: 'Archived update' }, root.etag), StoreConflictError)
  await assert.rejects(store.transact(WORKSPACE, [{ kind: 'replace', ...task }]), StoreConflictError)
  assert.equal((await store.get(WORKSPACE, root.record.id)).record.name, root.record.name)
})

test('head archive is independently guarded and cannot be cleared through ordinary replacement', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = ladder()
  root.grades = [9, 12]
  await store.create(root)
  const generationId = randomUUID()
  const sourceSetId = `source-set-${randomUUID()}`
  const head = grade => ({
    id: `grade-head-${LADDER.slice(7)}-${grade}`, workspaceId: WORKSPACE, ladderId: LADDER,
    recordType: 'grade-head', createdAt: NOW, updatedAt: NOW, grade, status: 'queued', issues: [], generationId, sourceSetId,
  })
  const nine = (await store.create(head(9))).value
  const twelve = (await store.create(head(12))).value
  const task = grade => work({ input: { kind: 'generate-grade', grade, generationId, sourceSetId, competencyPlanId: `competency-plan-${randomUUID()}` } })
  const nineTask = (await store.create(task(9))).value
  const twelveTask = (await store.create(task(12))).value
  await store.transact(WORKSPACE, [{ kind: 'replace', etag: nine.etag,
    record: { ...nine.record, lifecycle: { archivedAt: NOW } } }], { lifecycle: true })
  const archived = await store.get(WORKSPACE, nine.record.id)
  await assert.rejects(store.replace(nine.record, archived.etag), StoreConflictError)
  await assert.rejects(store.replace({ ...nineTask.record, status: 'running' }, nineTask.etag), StoreConflictError)
  const siblingClaim = await store.replace({ ...twelveTask.record, status: 'running' }, twelveTask.etag)
  assert.equal(siblingClaim.record.status, 'running')
  assert.deepEqual((await store.get(WORKSPACE, twelve.record.id)).record, twelve.record)
  assert.equal((await store.listScope(WORKSPACE, { ladderId: LADDER, grade: 9 })).items.length, 2)
  assert.equal((await store.listScope('workspace-two', { ladderId: LADDER, grade: 9 })).items.length, 0)
})

test('permanent cleanup requires a deleting fence and pages more than one Cosmos batch without dropping sibling families', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = (await store.create(ladder())).value
  const otherId = `ladder-${randomUUID()}`
  const other = { ...ladder(), id: otherId, seedBlobName: `${WORKSPACE}/${otherId}/seed.json` }
  await store.create(other)
  const items = Array.from({ length: 125 }, () => work({ status: 'succeeded' }))
  for (const item of items) cosmos.save(item)
  const first = await store.get(WORKSPACE, items[0].id)
  await assert.rejects(store.transact(WORKSPACE, [{ kind: 'delete', ...first }], { lifecycle: true }), StoreConflictError)
  await assert.rejects(store.transact(WORKSPACE, [{ kind: 'delete', ...first }]), /fenced lifecycle/)
  const firstPage = await store.listScope(WORKSPACE, { ladderId: LADDER, limit: 50 })
  assert.equal(firstPage.items.length, 50)
  assert.ok(firstPage.continuationToken)
  assert.equal((await store.listScope(WORKSPACE, { ladderId: LADDER, limit: 50, continuationToken: firstPage.continuationToken })).items.length, 50)
  await store.transact(WORKSPACE, [{ kind: 'replace', etag: root.etag,
    record: { ...root.record, lifecycle: { deletingAt: NOW } } }], { lifecycle: true })
  const lifecycle = new gradeLifecycleTesting.GradeLifecycleService({
    store, blobs: { listPage: async () => ({ names: [] }), delete: async () => {} },
  }, { impact: async () => [] }, () => new Date(NOW))
  const pending = await store.get(WORKSPACE, LADDER)
  assert.deepEqual(await lifecycle.change(WORKSPACE, LADDER, 'delete', pending.etag), { deleted: true })
  assert.deepEqual((await store.listScope(WORKSPACE, { ladderId: LADDER })).items, [])
  assert.ok(await store.get(WORKSPACE, otherId))
  assert.equal((await store.getControl(WORKSPACE, LADDER)).record.state, 'deleted')
  assert.ok(cosmos.batches.filter(batch => batch.operations.some(operation => operation.operationType === 'Delete')).length > 4)
  assert.ok(cosmos.batches.every(batch => batch.operations.length <= 100 && Buffer.byteLength(JSON.stringify(batch.operations)) <= 1_800_000))
  await assert.rejects(store.create(root.record), StoreConflictError)
  await assert.rejects(store.create(items[0]), StoreConflictError)
})

test('scoped blob enumeration validates every page and cleanup deletes snapshots without accepting broad prefixes', async () => {
  const names = Array.from({ length: 207 }, (_, index) => `${WORKSPACE}/${LADDER}/${seedId}/chunks/v1-page-${index}.json`).sort()
  const calls = []
  let injectForeign = false
  const blobs = createGradeBlobStoreFromContainer({
    listBlobsFlat({ prefix }) {
      assert.equal(prefix, `${WORKSPACE}/${LADDER}/`)
      return {
        byPage({ continuationToken, maxPageSize }) {
          assert.equal(maxPageSize, 100)
          const start = Number(continuationToken ?? 0)
          return (async function* () {
            yield { segment: { blobItems: (injectForeign ? [`other-workspace/${LADDER}/seed.json`] : names.slice(start, start + maxPageSize)).map(name => ({ name })) },
              continuationToken: start + maxPageSize < names.length ? String(start + maxPageSize) : undefined }
          })()
        },
      }
    },
    getBlockBlobClient(name) {
      return { async deleteIfExists(options) { calls.push({ name, options }) } }
    },
  })
  const first = await blobs.listPage(WORKSPACE, LADDER)
  assert.equal(first.names.length, 100)
  const second = await blobs.listPage(WORKSPACE, LADDER, first.continuationToken)
  assert.equal(second.names.length, 100)
  const last = await blobs.listPage(WORKSPACE, LADDER, second.continuationToken)
  assert.equal(last.names.length, 7)
  assert.equal(last.continuationToken, undefined)
  await blobs.delete(first.names[0])
  assert.deepEqual(calls[0], { name: first.names[0], options: { deleteSnapshots: 'include' } })
  await assert.rejects(blobs.listPage('../workspace', LADDER), /workspace/)
  await assert.rejects(blobs.listPage(WORKSPACE, '../ladder'), /ID|scope/)
  await assert.rejects(blobs.delete(`${WORKSPACE}/${LADDER}/../secret.json`), /Invalid grade blob/)
  injectForeign = true
  await assert.rejects(blobs.listPage(WORKSPACE, LADDER), /invalid scoped name/)
  assert.equal(calls.length, 1)
})

test('bounded grade uploads pass their cancellation signal through to the Azure request', async () => {
  const controller = new AbortController()
  const blobs = createGradeBlobStoreFromContainer({
    getBlockBlobClient() {
      return { async upload(_bytes, _length, options) {
        assert.equal(options.abortSignal, controller.signal)
        return { etag: '"bounded-upload"' }
      } }
    },
  })
  assert.equal((await blobs.putImmutable(`${WORKSPACE}/${LADDER}/seed.json`, Buffer.from('{}'), 'application/json',
    { signal: controller.signal })).created, true)
})

test('workspace blob enumeration discovers legacy unpublished families using only an exact workspace prefix', async () => {
  const otherLadder = `ladder-${randomUUID()}`
  const owned = [`${WORKSPACE}/${LADDER}/initialization.json`, `${WORKSPACE}/${otherLadder}/seed.json`]
  let invalidName
  const blobs = createGradeBlobStoreFromContainer({
    listBlobsFlat({ prefix }) {
      assert.equal(prefix, `${WORKSPACE}/`)
      return {
        byPage({ continuationToken, maxPageSize }) {
          assert.equal(maxPageSize, 100)
          assert.equal(continuationToken, undefined)
          return (async function* () {
            yield { segment: { blobItems: (invalidName ? [invalidName] : owned).map(name => ({ name })) } }
          })()
        },
      }
    },
    getBlockBlobClient() { throw new Error('Enumeration cannot mutate content.') },
  })
  assert.deepEqual((await blobs.listFamilies(WORKSPACE)).ladderIds, [LADDER, otherLadder])
  for (const name of [
    `${WORKSPACE}-other/${otherLadder}/seed.json`, `${WORKSPACE}/not-a-ladder/seed.json`,
    `${WORKSPACE}/ladder-not-a-uuid/initialization.json`, `${WORKSPACE}/${LADDER}/../seed.json`,
  ]) {
    invalidName = name
    await assert.rejects(blobs.listFamilies(WORKSPACE), /invalid scoped name/)
  }
  await assert.rejects(blobs.listFamilies('../unsafe'), /workspace/)
})

test('workspace purge discovers and deletes paginated legacy seed and reference blobs without any records or controls', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const secondLadder = `ladder-${randomUUID()}`
  const secondSource = `source-${randomUUID()}`
  const names = [
    `${WORKSPACE}/${LADDER}/initialization.json`, `${WORKSPACE}/${LADDER}/seed.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/original.pdf`, `${WORKSPACE}/${LADDER}/${seedId}/document-v1.json`,
    `${WORKSPACE}/${LADDER}/${seedId}/capture.json`, `${WORKSPACE}/${LADDER}/discovery-${randomUUID()}.json`,
    `${WORKSPACE}/${LADDER}/requests/${randomUUID()}.json`,
    ...Array.from({ length: 115 }, (_, index) => `${WORKSPACE}/${LADDER}/${seedId}/chunks/v1-legacy-${index}.json`),
    `${WORKSPACE}/${secondLadder}/initialization.json`, `${WORKSPACE}/${secondLadder}/${secondSource}/original.html`,
    `${WORKSPACE}/${secondLadder}/${secondSource}/document-v3.json`,
  ]
  const foreign = [
    `workspace-two/${LADDER}/seed.json`, `${WORKSPACE}-other/${secondLadder}/initialization.json`,
    `workspace-two/${LADDER}/${seedId}/original.pdf`,
  ]
  const remaining = new Set([...names, ...foreign])
  const enumerations = []
  const deleted = []
  const blobs = createGradeBlobStoreFromContainer({
    listBlobsFlat({ prefix }) {
      assert.ok([`${WORKSPACE}/`, `${WORKSPACE}/${LADDER}/`, `${WORKSPACE}/${secondLadder}/`].includes(prefix))
      return {
        byPage({ continuationToken, maxPageSize }) {
          enumerations.push({ prefix, continuationToken })
          assert.equal(maxPageSize, 100)
          const matches = [...remaining].filter(name => name.startsWith(prefix)).sort()
          const start = Number(continuationToken ?? 0)
          return (async function* () {
            yield { segment: { blobItems: matches.slice(start, start + maxPageSize).map(name => ({ name })) },
              continuationToken: start + maxPageSize < matches.length ? String(start + maxPageSize) : undefined }
          })()
        },
      }
    },
    getBlockBlobClient(name) {
      return {
        async deleteIfExists(options) {
          assert.ok(names.includes(name), 'Cleanup may delete only validated artifacts owned by this workspace.')
          assert.deepEqual(options, { deleteSnapshots: 'include' })
          deleted.push(name)
          remaining.delete(name)
        },
      }
    },
  })
  assert.equal(cosmos.values.size, 0)
  assert.deepEqual((await store.listScope(WORKSPACE, {})).items, [])
  assert.deepEqual((await store.listControls(WORKSPACE)).items, [])
  for (const ladderId of [LADDER, secondLadder]) {
    assert.equal(await store.get(WORKSPACE, ladderId), undefined)
    assert.equal(await store.getControl(WORKSPACE, ladderId), undefined)
  }
  const participant = gradeLifecycleTesting.createGradeLifecycleParticipant({ store, blobs })
  await participant.setState(WORKSPACE, 'deleting', NOW)
  await participant.cancel(WORKSPACE, NOW)
  await participant.purge(WORKSPACE, NOW)
  await participant.setState(WORKSPACE, 'deleted', NOW)
  assert.deepEqual(remaining, new Set(foreign))
  assert.deepEqual(new Set(deleted), new Set(names))
  assert.ok(enumerations.some(page => page.prefix === `${WORKSPACE}/` && page.continuationToken !== undefined))
  assert.deepEqual((await store.listScope(WORKSPACE, {})).items, [])
  assert.equal((await store.getControl(WORKSPACE, LADDER)).record.state, 'deleted')
  assert.equal((await store.getControl(WORKSPACE, secondLadder)).record.state, 'deleted')
  assert.ok([...cosmos.values.values()].every(record => record.recordType === 'grade-lifecycle' && record.state === 'deleted'))
  const deletionCalls = deleted.length
  const retryStart = cosmos.batches.length
  const restarted = gradeLifecycleTesting.createGradeLifecycleParticipant({ store, blobs })
  await restarted.setState(WORKSPACE, 'deleting', '2026-09-18T21:00:00.000Z')
  assert.equal((await store.getControl(WORKSPACE)).record.state, 'deleted')
  await restarted.cancel(WORKSPACE, '2026-09-18T21:00:00.000Z')
  await restarted.purge(WORKSPACE, '2026-09-18T21:00:00.000Z')
  await restarted.setState(WORKSPACE, 'deleted', '2026-09-18T21:00:00.000Z')
  assert.equal(deleted.length, deletionCalls)
  assert.deepEqual(remaining, new Set(foreign))
  assert.ok(cosmos.batches.slice(retryStart).flatMap(batch => batch.operations)
    .filter(operation => operation.resourceBody?.recordType === 'grade-lifecycle')
    .every(operation => operation.resourceBody.state === 'deleted'), 'A coordinator retry must never regress terminal controls.')
  for (const state of ['active', 'archived']) {
    await assert.rejects(restarted.setState(WORKSPACE, state, NOW), error => error.status === 409)
  }
  assert.equal((await store.getControl(WORKSPACE)).record.state, 'deleted')
})

test('pending lifecycle discovery returns bounded distinct workspace IDs, not completed archives or private records', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  await store.create(ladder())
  await gradeLifecycleTesting.updateGradeControl(store, WORKSPACE, LADDER, control => ({
    ...control, pending: [{ action: 'archive', updatedAt: NOW }],
  }))
  const secondId = `ladder-${randomUUID()}`
  cosmos.save({ ...ladder(), id: secondId, workspaceId: 'workspace-two', lifecycle: { deletingAt: NOW },
    seedBlobName: `workspace-two/${secondId}/seed.json` })
  const thirdId = `ladder-${randomUUID()}`
  const third = (await store.create({ ...ladder(), id: thirdId, workspaceId: 'workspace-three',
    seedBlobName: `workspace-three/${thirdId}/seed.json` })).value
  await store.transact('workspace-three', [{ kind: 'replace', etag: third.etag,
    record: { ...third.record, lifecycle: { archivedAt: NOW } } }], { lifecycle: true })
  await gradeLifecycleTesting.updateGradeControl(store, 'workspace-four', `ladder-${randomUUID()}`, control => ({
    ...control, state: 'deleting',
  }))
  assert.deepEqual(new Set(await store.pendingLifecycleWorkspaces(20)), new Set([WORKSPACE, 'workspace-two', 'workspace-four']))
  assert.equal((await store.pendingLifecycleWorkspaces(1)).length, 1)
  assert.match(cosmos.queries.at(-1).spec.query, /SELECT DISTINCT TOP @limit VALUE c\.workspaceId/)
  await assert.rejects(store.pendingLifecycleWorkspaces(0), /limit/)
  await assert.rejects(store.pendingLifecycleWorkspaces(101), /limit/)
})

test('unpublished creation reservations are immutable and cleared atomically only by their matching ladder publication', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = ladder()
  const preparation = { inputFingerprint: root.inputFingerprint, expiresAt: new Date(Date.now() + 60_000).toISOString() }
  await gradeLifecycleTesting.updateGradeControl(store, WORKSPACE, LADDER, control => ({ ...control, preparation }), false)
  const reserved = await store.getControl(WORKSPACE, LADDER)
  await assert.rejects(store.transact(WORKSPACE, [], {
    controls: [{ etag: reserved.etag, record: { ...reserved.record, preparation: { ...preparation, expiresAt: '2099-01-01T00:00:00.000Z' } } }],
  }), StoreConflictError)
  await assert.rejects(store.create({ ...root, inputFingerprint: 'b'.repeat(64) }), StoreConflictError)
  cosmos._code(412)
  await assert.rejects(store.create(root), StoreConflictError)
  assert.deepEqual((await store.getControl(WORKSPACE, LADDER)).record.preparation, preparation)
  assert.equal(await store.get(WORKSPACE, LADDER), undefined)
  const created = await store.create(root)
  assert.equal(created.created, true)
  assert.equal((await store.getControl(WORKSPACE, LADDER)).record.preparation, undefined)
  const publication = cosmos.batches.at(-1).operations
  assert.ok(publication.some(operation => operation.operationType === 'Create' && operation.resourceBody.id === LADDER))
  assert.ok(publication.some(operation => operation.id === reserved.record.id &&
    operation.resourceBody.preparation === undefined && operation.ifMatch === reserved.etag))
})

test('expired preparation discovery is scoped and conditional orphan cleanup cannot erase a racing published ladder', async () => {
  const cosmos = container()
  const store = createGradeStoreFromContainer(cosmos)
  const root = ladder()
  await gradeLifecycleTesting.updateGradeControl(store, WORKSPACE, LADDER, control => ({
    ...control, preparation: { inputFingerprint: root.inputFingerprint, expiresAt: NOW },
  }))
  const futureId = `ladder-${randomUUID()}`
  await gradeLifecycleTesting.updateGradeControl(store, 'workspace-future', futureId, control => ({
    ...control, preparation: { inputFingerprint: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' },
  }))
  assert.deepEqual(await store.pendingLifecycleWorkspaces(20), [WORKSPACE])
  assert.match(cosmos.queries.at(-1).spec.query, /c\.preparation\.expiresAt <= @now/)
  await assert.rejects(store.create(root), StoreConflictError)
  const expired = await store.getControl(WORKSPACE, LADDER)
  cosmos._race(() => {
    cosmos.save(root)
    cosmos.save({ ...expired.record, preparation: undefined })
  })
  let deletedBlobs = 0
  await assert.rejects(gradeLifecycleTesting.discardGradePreparation({
    store, blobs: { listPage: async () => ({ names: [] }), delete: async () => { deletedBlobs++ } },
  }, WORKSPACE, LADDER, NOW), StoreConflictError)
  assert.deepEqual((await store.get(WORKSPACE, LADDER)).record, root)
  assert.equal((await store.getControl(WORKSPACE, LADDER)).record.state, 'active')
  assert.equal(deletedBlobs, 0)
})
