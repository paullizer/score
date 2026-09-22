import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, seedResume, seedJob, seedGrade, createRun, finishInitialization, publishResult,
  startHttp, ACTOR, NOW, LATER, clone, jsonBytes, sha,
} from './real-analyses.test-support.mjs'

const status = expected => error => error.status === expected
const requestFor = (resume, target) => ({ name: 'Explicit source comparison', resumes: [resume.selection], targets: [target.selection] })
const runComparisons = (f, runId) => [...f.analysis.store.values.values()]
  .filter(value => value.record.recordType === 'analysis-comparison' && value.record.runId === runId)
  .sort((a, b) => a.record.index - b.record.index)

for (const [resumeCount, targetCount] of [[10, 10], [103, 4], [500, 1], [1, 500]]) {
  const total = resumeCount * targetCount
  test(`${resumeCount} resumes against ${targetCount} targets initialize all ${total} comparisons in resumable 25-pair batches`, async () => {
    const f = fixture()
    const created = await createRun(f, resumeCount, targetCount)
    assert.equal(created.run.progress.total, total)
    assert.equal(created.run.progress.initialized, 25)
    assert.equal(created.run.status, 'initializing')
    assert.equal(f.analysis.store.batches.length, 1)
    let finished = { record: created.run, etag: created.etag }
    while (finished.record.status === 'initializing') {
      const previous = finished.record.progress.initialized
      finished = await finishInitialization(f, created.run.id)
      assert.ok(finished.record.progress.initialized > previous)
    }
    assert.equal(finished.record.progress.initialized, total)
    assert.equal(finished.record.progress.queued, total)
    assert.equal(finished.record.status, 'queued')
    const batchSizes = Array.from({ length: Math.ceil(total / 25) }, (_, index) => Math.min(25, total - index * 25) + 1)
    assert.deepEqual(f.analysis.store.batches.map(batch => batch.length), batchSizes)
    assert.equal(runComparisons(f, created.run.id).length, total)
    assert.equal(new Set(runComparisons(f, created.run.id).map(item => item.record.id)).size, total)
    const detail = await f.service.detail(f.workspaceId, created.run.id)
    assert.deepEqual(detail.resumes.map(item => item.selection), created.request.resumes)
    assert.deepEqual(detail.targets.map(item => item.selection), created.request.targets)
    const comparisons = []
    let token
    do {
      const page = await f.service.comparisons(f.workspaceId, created.run.id, token, 50)
      assert.ok(page.comparisons.length <= 50)
      comparisons.push(...page.comparisons)
      token = page.continuationToken
    } while (token)
    assert.deepEqual(comparisons.map(item => item.comparison.index), Array.from({ length: total }, (_, index) => index))
    await finishInitialization(f, created.run.id)
    const replay = await f.service.create(f.workspaceId, created.key, created.request, ACTOR)
    assert.equal(replay.run.id, created.run.id)
    assert.deepEqual(replay.run.manifest, created.run.manifest)
    assert.equal(f.analysis.store.batches.length, batchSizes.length)
    assert.equal(f.analysis.store.values.size, total + 1)
    for (const { record } of f.analysis.store.values.values()) {
      assert.ok(jsonBytes(record).byteLength < api.MAX_ANALYSIS_RECORD_BYTES)
      assert.ok(!JSON.stringify(record).includes('Evaluated engineering systems independently'))
    }
  })
}

test('more than 500 pairs are rejected before any analysis snapshots or work are published', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const job = await seedJob(f)
  for (const [resumeCount, targetCount] of [[501, 1], [1, 501], [3, 167], [126, 4]]) {
    const request = {
      name: 'Oversized selection',
      resumes: Array.from({ length: resumeCount }, () => ({ ...resume.selection, resumeId: `resume-${randomUUID()}` })),
      targets: Array.from({ length: targetCount }, () => ({ ...job.selection, jobId: `job-${randomUUID()}` })),
    }
    await assert.rejects(f.service.create(f.workspaceId, randomUUID(), request, ACTOR),
      error => error.status === 400 && /500/.test(error.message))
    assert.equal(f.analysis.store.values.size, 0)
    assert.equal(f.analysis.blobs.values.size, 0)
  }
})

test('creation rejects stale source/version hashes, missing/foreign/sample/mixed selections and body tampering', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const job = await seedJob(f)
  const original = requestFor(resume, job)
  const variants = [
    value => { value.resumes[0].documentSha256 = '0'.repeat(64) },
    value => { value.resumes[0].documentVersion = 2 },
    value => { value.targets[0].rubricHash = '0'.repeat(64) },
    value => { value.targets[0].documentSha256 = '0'.repeat(64) },
    value => { value.targets[0].rubricVersion = 2 },
    value => { value.resumes.push({ ...value.resumes[0], resumeId: `resume-${randomUUID()}` }) },
    value => { value.targets.push({ ...value.targets[0], jobId: `job-${randomUUID()}` }) },
    value => { value.targets[0].kind = 'sample' },
    value => { value.resumes[0].sample = true },
    value => { value.targets[0].rubric = job.rubric },
    value => { value.score = 100 },
    value => { value.workspaceId = 'another-workspace' },
    value => { value.resumes.push(value.resumes[0]) },
    value => { value.targets.push(value.targets[0]) },
  ]
  for (const mutate of variants) {
    const request = clone(original)
    mutate(request)
    await assert.rejects(f.service.create(f.workspaceId, randomUUID(), request, ACTOR), error => [400, 404, 409].includes(error.status))
  }
  assert.equal(f.analysis.store.values.size, 0)
  const pending = clone(resume.record)
  pending.resume.status = 'queued'
  delete pending.completedAt
  f.resumeValues.set(`${f.workspaceId}/${pending.id}`, { record: pending, etag: '"pending"' })
  await assert.rejects(f.service.create(f.workspaceId, randomUUID(), original, ACTOR), status(409))
  f.resumeValues.set(`${f.workspaceId}/${resume.record.id}`, { record: { ...resume.record, workspaceId: 'different-workspace' }, etag: '"foreign"' })
  await assert.rejects(f.service.create(f.workspaceId, randomUUID(), original, ACTOR))
  assert.equal(f.analysis.store.values.size, 0)
})

test('server discovery uses all pages and the approved GS version/context even with a newer unapproved draft', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const jobs = []
  for (let index = 0; index < 4; index++) jobs.push(await seedJob(f, `Saved role ${index}`))
  const gs = await seedGrade(f, jobs[0])
  const page = await f.service.listTargets(f.workspaceId, undefined, 2)
  assert.equal(page.targets.length, 2)
  const targets = [...page.targets]
  let token = page.continuationToken
  while (token) {
    const more = await f.service.listTargets(f.workspaceId, token, 2)
    targets.push(...more.targets)
    token = more.continuationToken
  }
  assert.equal(targets.length, 5)
  const offered = targets.find(item => item.kind === 'grade')
  assert.deepEqual(offered.selection, gs.selection)
  assert.equal(offered.newerDraftAvailable, true)
  assert.deepEqual(offered.context, gs.sourceSet.context)
  assert.notDeepEqual(offered.context, gs.newerSet.context)
  assert.equal(offered.label, gs.version.rubric.name)
  const created = await f.service.create(f.workspaceId, randomUUID(), requestFor(resume, gs), ACTOR)
  const comparison = runComparisons(f, created.run.id)[0]
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id)
  assert.equal(detail.targetSnapshot.version.id, gs.version.id)
  assert.equal(detail.targetSnapshot.version.rubric.criteria[1].support, 'not-applicable')
  assert.equal(detail.targetSnapshot.version.rubric.criteria[1].weight, 0)
  assert.deepEqual(detail.targetSnapshot.version.qualifications, gs.version.qualifications)
  assert.equal(detail.targetSnapshot.references.length, gs.sourceSet.sources.length)
  for (const ref of detail.targetSnapshot.references) assert.ok(ref.document.blobName.startsWith(`${f.workspaceId}/${created.run.id}/evidence/`))
  const refDoc = await f.service.document(f.workspaceId, created.run.id, comparison.record.id, gs.reference.id, 1)
  assert.deepEqual(refDoc.document, gs.reference)
  const seedDoc = await f.service.document(f.workspaceId, created.run.id, comparison.record.id, gs.seed.document.id, 1)
  assert.deepEqual(seedDoc.document, gs.seed.document)
  const request = requestFor(resume, gs)
  request.targets[0] = { ...request.targets[0], versionId: gs.newer.id, version: 2, versionHash: gs.newer.contentHash,
    sourceSetId: gs.newerSet.id, sourceSetHash: gs.newerSet.contentHash }
  await assert.rejects(f.service.create(f.workspaceId, randomUUID(), request, ACTOR), status(409))
  f.gradeValues.clear()
  f.grades.blobs.values.clear()
  f.jobValues.clear()
  f.jobs.blobs.values.clear()
  const frozen = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id)
  assert.deepEqual(frozen.targetSnapshot.sourceSet.context, gs.sourceSet.context)
  assert.deepEqual((await f.service.document(f.workspaceId, created.run.id, comparison.record.id, gs.reference.id, 1)).document, gs.reference)
})

test('corrupt approval identities, unsupported reviews, content hashes and source sets fail closed', async () => {
  for (const corrupt of [
    gs => ({ ...gs.approval, versionHash: '0'.repeat(64) }),
    gs => ({ ...gs.approval, versionId: gs.newer.id }),
    gs => ({ ...gs.approval, sourceSetId: gs.newerSet.id }),
    gs => ({ ...gs.review, outcome: 'needs-sources' }),
    gs => ({ ...gs.review, grade: 12 }),
    gs => ({ ...gs.sourceSet, contentHash: '0'.repeat(64) }),
    gs => ({ ...gs.version, rubric: { ...gs.version.rubric, name: 'Tampered version content' } }),
  ]) {
    const f = fixture()
    const resume = await seedResume(f)
    const gs = await seedGrade(f)
    const record = corrupt(gs)
    f.gradeValues.set(`${f.workspaceId}/${record.id}`, { record, etag: '"corrupt"' })
    await assert.rejects(f.service.create(f.workspaceId, randomUUID(), requestFor(resume, gs), ACTOR))
    await assert.rejects(f.service.listTargets(f.workspaceId))
    assert.equal(f.analysis.store.values.size, 0)
  }
})

test('ready resume profile/source metadata must match real paragraphs and the immutable capture manifest', async () => {
  for (const change of ['profile', 'metadata', 'manifest', 'document']) {
    const f = fixture()
    const resume = await seedResume(f)
    const job = await seedJob(f)
    if (change === 'metadata') {
      resume.record.resume.name = 'Fabricated filename identity'
      f.resumeValues.set(`${f.workspaceId}/${resume.record.id}`, { record: resume.record, etag: '"bad"' })
    } else {
      const name = change === 'profile' ? resume.record.profileBlob.blobName :
        change === 'manifest' ? resume.record.captureManifest.blobName : resume.record.extraction.document.blobName
      f.resumes.blobs.values.delete(name)
    }
    await assert.rejects(f.service.create(f.workspaceId, randomUUID(), requestFor(resume, job), ACTOR))
    assert.equal(f.analysis.store.values.size, 0)
  }
})

test('unpublished winning manifests revalidate intake eligibility; accepted history never requires live sources', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const job = await seedJob(f)
  const request = requestFor(resume, job)
  const key = randomUUID()
  f.analysis.store._beforeCreate(() => { throw new Error('Publication temporarily unavailable') })
  await assert.rejects(f.service.create(f.workspaceId, key, request, ACTOR), /temporarily unavailable/)
  assert.equal(f.analysis.store.values.size, 0)
  const manifestName = `${f.workspaceId}/analysis-run-${key}/manifest.json`
  const originalManifest = clone(f.analysis.blobs.values.get(manifestName))
  assert.ok(originalManifest)
  const sources = [f.resumeValues, f.jobValues, f.rubricValues, f.resumes.blobs.values, f.jobs.blobs.values]
    .map(values => ({ values, entries: clone([...values]) }))
  f.resumeValues.clear()
  f.jobValues.clear()
  f.rubricValues.clear()
  f.resumes.blobs.values.clear()
  f.jobs.blobs.values.clear()
  f.now = LATER
  f.analysis.store._beforeCreate(undefined)
  await assert.rejects(f.service.create(f.workspaceId, key, request, ACTOR), status(404))
  assert.equal(f.analysis.store.values.size, 0, 'An unpublished manifest is not authorization to resurrect removed inputs.')
  for (const source of sources) for (const [key, value] of source.entries) source.values.set(key, value)
  f.jobValues.get(`${f.workspaceId}/${job.record.id}`).record.job.title = 'Renamed current job'
  const created = await f.service.create(f.workspaceId, key, request, ACTOR)
  assert.equal(created.run.createdAt, NOW)
  assert.equal(created.run.createdBy, ACTOR)
  assert.deepEqual(f.analysis.blobs.values.get(manifestName), originalManifest)
  const comparison = runComparisons(f, created.run.id)[0]
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id)
  assert.deepEqual(detail.resumeSnapshot.document, resume.document)
  assert.deepEqual(detail.targetSnapshot.rubric, job.rubric)
  assert.equal(detail.targetSnapshot.job.title, job.record.job.title)
  for (const source of sources) source.values.clear()
  const repeated = await f.service.create(f.workspaceId, key, request, ACTOR)
  assert.equal(repeated.run.id, created.run.id)
  assert.equal(runComparisons(f, created.run.id).length, 1)
  await assert.rejects(f.service.create(f.workspaceId, key, { ...request, name: 'Another request' }, ACTOR), status(409))
  await assert.rejects(f.service.create(f.workspaceId, key, request, 'another-creator'), status(409))
})

test('ambiguous manifest, record and chunk publications recover winning writes, never duplicate or replace evidence', async () => {
  for (const stage of ['manifest', 'record', 'chunk']) {
    const f = fixture()
    if (stage === 'manifest') f.analysis.blobs._afterPut(name => {
      if (name.endsWith('/manifest.json')) { f.analysis.blobs._afterPut(undefined); throw new Error('Lost manifest response') }
    })
    if (stage === 'record') f.analysis.store._afterCreate(() => { f.analysis.store._afterCreate(undefined); throw new Error('Lost record response') })
    if (stage === 'chunk') f.analysis.store._afterBatch(() => { throw new Error('Lost batch response') })
    const created = await createRun(f, 3, 10)
    await finishInitialization(f, created.run.id)
    const current = await f.service.create(f.workspaceId, created.key, created.request, ACTOR)
    assert.equal(current.run.progress.total, 30)
    assert.equal(current.run.progress.initialized, 30)
    assert.equal(current.run.progress.queued, 30)
    assert.equal(runComparisons(f, created.run.id).length, 30)
  }
})

test('initialization resumes after a pre-commit failure and cancellation fences before and after partial chunks', async () => {
  const failed = fixture()
  failed.analysis.store._beforeBatch(() => { throw new Error('Storage did not publish') })
  await assert.rejects(createRun(failed, 3, 10), /did not publish/)
  const run = [...failed.analysis.store.values.values()][0]
  assert.equal(run.record.status, 'initializing')
  assert.equal(run.record.progress.initialized, 0)
  assert.ok((await failed.analysis.store.listPending(NOW, 100)).some(item => item.record.id === run.record.id))
  await finishInitialization(failed, run.record.id)
  assert.equal(runComparisons(failed, run.record.id).length, 30)

  const f = fixture()
  const created = await createRun(f, 10, 10)
  const cancelled = await f.service.cancel(f.workspaceId, created.run.id, ACTOR, created.etag)
  assert.equal(cancelled.run.status, 'cancelled')
  assert.equal(cancelled.run.cancellation.nextComparisonIndex, 25)
  assert.equal(cancelled.run.progress.cancelled, 25)
  assert.ok((await f.analysis.store.listPending(NOW, 100)).some(item => item.record.id === created.run.id))
  await assert.rejects(f.service.retry(f.workspaceId, created.run.id, {}, cancelled.etag), status(409))
  const done = await finishInitialization(f, created.run.id)
  assert.equal(done.record.progress.initialized, 100)
  assert.equal(done.record.progress.cancelled, 100)
  assert.equal(done.record.progress.queued, 0)
  assert.equal(done.record.cancellation.nextComparisonIndex, 100)
  assert.equal(runComparisons(f, created.run.id).length, 100)
  assert.equal((await f.analysis.store.listPending(NOW, 100)).length, 0)
  const retried = await f.service.retry(f.workspaceId, created.run.id, {}, done.etag)
  assert.equal(retried.run.progress.queued, 100)
  assert.equal(retried.run.progress.cancelled, 0)
  assert.equal(retried.run.cancellation, undefined)

  const racing = fixture()
  racing.analysis.store._beforeBatch(async operations => {
    const expectedRun = operations.find(item => item.record.recordType === 'analysis-run').record
    const current = await racing.analysis.store.get(racing.workspaceId, expectedRun.id)
    const cancelledRun = {
      ...current.record, status: 'cancelled',
      cancellation: { requestedAt: NOW, requestedBy: ACTOR, nextComparisonIndex: 0 },
    }
    delete cancelledRun.nextAttemptAt
    await racing.analysis.store.replace(cancelledRun, current.etag)
  })
  const race = await createRun(racing, 3, 10)
  await finishInitialization(racing, race.run.id)
  assert.ok(runComparisons(racing, race.run.id).every(item => item.record.status === 'cancelled'))
  assert.equal((await racing.analysis.store.listPending(NOW, 100)).length, 0)
})

test('500-pair cancellation and explicit bulk retry preserve completed evidence and every frozen pair', async () => {
  const f = fixture()
  const created = await createRun(f, 125, 4)
  let current = { record: created.run, etag: created.etag }
  while (current.record.status === 'initializing') {
    const previous = current.record.progress.initialized
    current = await finishInitialization(f, created.run.id)
    assert.ok(current.record.progress.initialized > previous)
  }
  const original = runComparisons(f, created.run.id)
  const completed = await publishResult(f, created.run.id, original[0].record.id)
  const before = await f.service.detail(f.workspaceId, created.run.id)
  const cancelled = await f.service.cancel(f.workspaceId, created.run.id, ACTOR, before.etag)
  current = { record: cancelled.run, etag: cancelled.etag }
  while (!current.record.cancellation.completedAt) {
    const previous = current.record.cancellation.nextComparisonIndex
    current = await finishInitialization(f, created.run.id)
    assert.ok(current.record.cancellation.nextComparisonIndex > previous)
  }
  assert.equal(current.record.progress.total, 500)
  assert.equal(current.record.progress.complete, 1)
  assert.equal(current.record.progress.cancelled, 499)
  assert.equal(current.record.cancellation.nextComparisonIndex, 500)
  const comparisonIds = original.slice(1).map(item => item.record.id)
  const retried = await f.service.retry(f.workspaceId, created.run.id, { comparisonIds }, current.etag)
  assert.equal(retried.run.progress.queued, 499)
  assert.equal(retried.run.progress.complete, 1)
  assert.equal(retried.run.progress.cancelled, 0)
  assert.equal(retried.run.cancellation, undefined)
  assert.deepEqual(retried.run.manifest, created.run.manifest)
  const identities = pairs => pairs.map(({ record }) => ({ id: record.id, resume: record.resume, target: record.target }))
  assert.deepEqual(identities(runComparisons(f, created.run.id)), identities(original))
  assert.deepEqual((await f.service.comparisonDetail(f.workspaceId, created.run.id, original[0].record.id)).result, completed.result)
  assert.ok(f.analysis.store.batches.every(batch => batch.length <= 26))
})

test('comparison paging and document delivery are scoped by workspace, run and exact version', async () => {
  const f = fixture()
  const created = await createRun(f, 3, 10)
  await finishInitialization(f, created.run.id)
  const first = await f.service.comparisons(f.workspaceId, created.run.id, undefined, 7)
  assert.equal(first.comparisons.length, 7)
  assert.ok(first.continuationToken)
  const all = [...first.comparisons]
  let token = first.continuationToken
  while (token) {
    const page = await f.service.comparisons(f.workspaceId, created.run.id, token, 7)
    all.push(...page.comparisons)
    token = page.continuationToken
  }
  assert.equal(all.length, 30)
  assert.deepEqual(all.map(item => item.comparison.index), Array.from({ length: 30 }, (_, i) => i))
  const another = await createRun(f)
  await assert.rejects(f.service.comparisons(f.workspaceId, another.run.id, first.continuationToken), status(400))
  await assert.rejects(f.service.list(f.workspaceId, first.continuationToken), status(400))
  await assert.rejects(f.service.detail('another-workspace', created.run.id), status(404))
  await assert.rejects(f.service.comparisonDetail(f.workspaceId, another.run.id, first.comparisons[0].comparison.id), status(404))
  const item = first.comparisons[0].comparison
  const document = await f.service.document(f.workspaceId, created.run.id, item.id, created.resumes[0].document.id, 1)
  assert.deepEqual(document.document, created.resumes[0].document)
  await assert.rejects(f.service.document(f.workspaceId, created.run.id, item.id, created.resumes[0].document.id, 2), status(404))
  await assert.rejects(f.service.document(f.workspaceId, created.run.id, item.id, '../manifest', 1), status(400))
  await assert.rejects(f.service.comparisons(f.workspaceId, created.run.id, 'not-a-token'), status(400))
  await assert.rejects(f.service.comparisons(f.workspaceId, created.run.id, undefined, 101), status(400))
})

for (const collision of ['job', 'grade-seed', 'grade-reference']) {
  test(`document lookup fails closed for a scoped resume/${collision} ID collision without losing either original`, async () => {
    const f = fixture()
    const key = randomUUID()
    const resume = await seedResume(f, 'Distinct resume subject', key)
    const job = await seedJob(f, 'Distinct job requirement', collision === 'grade-reference' ? randomUUID() : key)
    const target = collision === 'job' ? job : await seedGrade(f, job,
      collision === 'grade-reference' ? { referenceDocumentId: resume.document.id } : {})
    const created = await f.service.create(f.workspaceId, randomUUID(), requestFor(resume, target), ACTOR)
    const comparison = runComparisons(f, created.run.id)[0]
    const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id)
    assert.deepEqual(detail.resumeSnapshot.document, resume.document)
    assert.deepEqual(detail.targetSnapshot.kind === 'job' ? detail.targetSnapshot.document : detail.targetSnapshot.seed.document, job.document)
    await assert.rejects(f.service.document(f.workspaceId, created.run.id, comparison.record.id, resume.document.id, 1), status(409))
    await assert.rejects(f.service.document('another-workspace', created.run.id, comparison.record.id, resume.document.id, 1), status(404))
    const other = await createRun(f)
    const otherComparison = runComparisons(f, other.run.id)[0]
    await assert.rejects(f.service.document(f.workspaceId, other.run.id, otherComparison.record.id, resume.document.id, 1), status(404))
    if (collision === 'grade-reference') {
      assert.deepEqual((await f.service.document(f.workspaceId, created.run.id, comparison.record.id, job.document.id, 1)).document, job.document)
    } else if (collision === 'grade-seed') {
      assert.deepEqual((await f.service.document(f.workspaceId, created.run.id, comparison.record.id, target.reference.id, 1)).document, target.reference)
    }
    const http = await startHttp(f)
    try {
      const response = await http.request(`/${created.run.id}/comparisons/${comparison.record.id}/documents/${resume.document.id}?version=1`)
      assert.equal(response.status, 409)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const body = await response.json()
      assert.equal(body.error.code, 'conflict')
      assert.equal(body.document, undefined)
      const originals = await http.request(`/${created.run.id}/comparisons/${comparison.record.id}`)
      assert.equal(originals.status, 200)
      assert.deepEqual((await originals.json()).resumeSnapshot.document, resume.document)
    } finally { await http.close() }
  })
}

for (const takeover of ['before-load', 'before-commit', 'between-chunks']) {
  test(`initializer attempt fence prevents same-owner takeover ${takeover} from adopting a newer claim`, async () => {
    const f = fixture()
    const created = await createRun(f, 10, 10)
    const owner = 'shared-worker-owner'
    const oldAttempt = randomUUID()
    const newAttempt = randomUUID()
    const reclaimedAt = '2026-09-18T02:00:02.000Z'
    const current = await f.analysis.store.get(f.workspaceId, created.run.id)
    const claimed = {
      ...current.record, attemptId: oldAttempt, attempts: 1,
      lease: { owner, heartbeatAt: NOW, expiresAt: '2026-09-18T02:00:01.000Z' },
    }
    delete claimed.nextAttemptAt
    await f.analysis.store.replace(claimed, current.etag)
    const reclaim = async () => {
      f.now = reclaimedAt
      const latest = await f.analysis.store.get(f.workspaceId, created.run.id)
      await f.analysis.store.replace({
        ...latest.record, attemptId: newAttempt, attempts: 2, updatedAt: reclaimedAt,
        lease: { owner, heartbeatAt: reclaimedAt, expiresAt: LATER },
      }, latest.etag)
    }
    if (takeover === 'before-load') await reclaim()
    else if (takeover === 'before-commit') f.analysis.store._beforeBatch(reclaim)
    else f.analysis.store._afterBatch(reclaim)
    const batchesBefore = f.analysis.store.batches.length
    const blobEventsBefore = f.analysis.blobs.events.length
    const stopped = await api.advanceAnalysisRun(f.analysis, f.workspaceId, created.run.id, {
      now: () => new Date(f.now), maxChunks: 4, leaseOwner: owner, expectedAttemptId: oldAttempt,
    })
    const initialized = takeover === 'between-chunks' ? 50 : 25
    assert.equal(stopped.record.attemptId, newAttempt)
    assert.equal(stopped.record.lease.owner, owner)
    assert.equal(stopped.record.attempts, 2)
    assert.equal(stopped.record.progress.initialized, initialized)
    assert.equal(runComparisons(f, created.run.id).length, initialized)
    assert.equal(f.analysis.store.batches.length - batchesBefore, takeover === 'between-chunks' ? 1 : 0)
    if (takeover === 'before-load') assert.equal(f.analysis.blobs.events.length, blobEventsBefore)
    const resumed = await api.advanceAnalysisRun(f.analysis, f.workspaceId, created.run.id, {
      now: () => new Date(f.now), maxChunks: 4, leaseOwner: owner, expectedAttemptId: newAttempt,
    })
    assert.equal(resumed.record.progress.initialized, 100)
    assert.equal(resumed.record.status, 'queued')
    assert.equal(runComparisons(f, created.run.id).length, 100)
  })
}

test('per-comparison actions preserve counters and fence stale writes; completed result evidence is immutable through retries and edits', async () => {
  const f = fixture()
  const created = await createRun(f, 1, 3)
  const comparisons = runComparisons(f, created.run.id)
  const scored = await publishResult(f, created.run.id, comparisons[0].record.id)
  const unscored = await publishResult(f, created.run.id, comparisons[1].record.id, true)
  const cancelled = await f.service.comparisonAction(f.workspaceId, created.run.id, comparisons[2].record.id, 'cancel', comparisons[2].etag)
  let current = await f.service.detail(f.workspaceId, created.run.id)
  assert.equal(current.run.status, 'partial')
  assert.deepEqual(current.run.progress, { total: 3, initialized: 3, queued: 0, running: 0, complete: 2, failed: 0, cancelled: 1, scored: 1, unscored: 1 })
  await assert.rejects(f.service.comparisonAction(f.workspaceId, created.run.id, comparisons[2].record.id, 'retry', comparisons[2].etag), status(409))
  const complete = await f.analysis.store.get(f.workspaceId, comparisons[0].record.id)
  await assert.rejects(f.service.comparisonAction(f.workspaceId, created.run.id, complete.record.id, 'retry', complete.etag), status(409))
  await assert.rejects(f.service.comparisonAction(f.workspaceId, created.run.id, complete.record.id, 'cancel', complete.etag), status(409))
  await assert.rejects(f.service.retry(f.workspaceId, created.run.id, { comparisonIds: [complete.record.id] }, current.etag), status(409))
  const retried = await f.service.comparisonAction(f.workspaceId, created.run.id, cancelled.comparison.id, 'retry', cancelled.etag)
  assert.equal(retried.comparison.retryCount, 1)
  current = await f.service.detail(f.workspaceId, created.run.id)
  assert.equal(current.run.progress.queued, 1)
  assert.equal(current.run.progress.complete, 2)
  assert.equal(current.run.progress.scored, 1)
  assert.equal(current.run.progress.unscored, 1)
  assert.equal(current.run.status, 'queued')
  f.jobValues.clear()
  f.rubricValues.clear()
  f.resumes.blobs.values.clear()
  f.jobs.blobs.values.clear()
  const originalScored = await f.service.comparisonDetail(f.workspaceId, created.run.id, complete.record.id)
  const originalUnscored = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparisons[1].record.id)
  assert.deepEqual(originalScored.result, scored.result)
  assert.deepEqual(originalUnscored.result, unscored.result)
  assert.equal(originalScored.result.overall.score, 80)
  assert.equal(originalUnscored.result.overall.status, 'withheld')
  assert.equal(originalScored.result.humanReviewRequired, true)
  await assert.rejects(f.analysis.store.replace({ ...complete.record, status: 'queued' }, complete.etag))
  const badResult = clone(scored.result)
  badResult.overall.score = 100
  assert.throws(() => api.parseAnalysisResult(badResult))
  const badEvidence = clone(scored.result)
  badEvidence.criteria[0].citations[0].documentId = created.targets[0].document.id
  badEvidence.provenance.assessmentSha256 = api.analysisHash({
    criteria: badEvidence.criteria, qualifications: badEvidence.qualifications, summary: badEvidence.summary, limitations: badEvidence.limitations,
  })
  badEvidence.provenance.groundingReviews[0].assessmentSha256 = badEvidence.provenance.assessmentSha256
  const validShape = api.parseAnalysisResult(badEvidence)
  assert.throws(() => api.assertAnalysisResultBinding(validShape, current.run, complete.record, originalScored.resumeSnapshot, originalScored.targetSnapshot))
})

test('run cancellation and comparison publication use the same atomic run ETag fence', async () => {
  const f = fixture()
  const created = await createRun(f)
  const before = runComparisons(f, created.run.id)[0]
  const parent = await f.analysis.store.get(f.workspaceId, created.run.id)
  const late = { ...before.record, status: 'running', attempts: 1, attemptId: randomUUID(),
    lease: { owner: 'late-worker', expiresAt: LATER, heartbeatAt: NOW } }
  delete late.nextAttemptAt
  const cancelled = await f.service.cancel(f.workspaceId, created.run.id, ACTOR, parent.etag)
  await assert.rejects(f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: late, etag: before.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(parent.record, before.record, late, NOW), etag: parent.etag },
  ]), api.StoreConflictError)
  assert.equal(cancelled.run.progress.cancelled, 1)
  assert.equal((await f.analysis.store.get(f.workspaceId, before.record.id)).record.status, 'cancelled')
  assert.throws(() => api.applyAnalysisComparisonTransition(cancelled.run, before.record, late, NOW))
})

test('failed initialization and terminal comparison failure retry retain manifests, reset attempts and update parent progress', async () => {
  const f = fixture()
  const created = await createRun(f, 3, 10)
  const current = await f.analysis.store.get(f.workspaceId, created.run.id)
  const initializationError = {
    ...current.record, status: 'failed', completedAt: NOW, attempts: 3,
    error: { code: 'storage-error', stage: 'initialization', message: 'Captured work could not be initialized.', retryable: true },
  }
  delete initializationError.nextAttemptAt
  const failed = await f.analysis.store.replace(initializationError, current.etag)
  const retried = await f.service.retry(f.workspaceId, created.run.id, {}, failed.etag)
  assert.equal(retried.run.status, 'queued')
  assert.equal(retried.run.attempts, 0)
  assert.equal(retried.run.retryCount, 1)
  assert.deepEqual(retried.run.manifest, created.run.manifest)
  const comparison = runComparisons(f, created.run.id)[0]
  const errorRecord = {
    ...comparison.record, status: 'failed', attempts: 3, completedAt: NOW,
    error: { code: 'grounding-failed', stage: 'grounding', message: 'Exact evidence could not be supported.', retryable: false },
  }
  delete errorRecord.nextAttemptAt
  const parent = await f.analysis.store.get(f.workspaceId, created.run.id)
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: errorRecord, etag: comparison.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(parent.record, comparison.record, errorRecord, NOW), etag: parent.etag },
  ])
  const before = await f.service.detail(f.workspaceId, created.run.id)
  assert.equal(before.run.progress.failed, 1)
  assert.ok(!(await f.analysis.store.listPending(NOW, 100)).some(item => item.record.id === comparison.record.id))
  const retry = await f.service.retry(f.workspaceId, created.run.id, { comparisonIds: [comparison.record.id] }, before.etag)
  const updated = await f.analysis.store.get(f.workspaceId, comparison.record.id)
  assert.equal(retry.run.progress.failed, 0)
  assert.equal(retry.run.progress.queued, 30)
  assert.equal(updated.record.attempts, 0)
  assert.equal(updated.record.retryCount, 1)
  assert.equal(updated.record.error, undefined)
  assert.deepEqual(updated.record.resume, comparison.record.resume)
  assert.deepEqual(updated.record.target, comparison.record.target)
})

test('paused cancellation requires explicit conditional retry and resumes only cleanup without changing completed evidence', async () => {
  for (const failure of [
    { attempts: 3, retryable: true },
    { attempts: 1, retryable: false },
  ]) {
    const f = fixture()
    const created = await createRun(f, 2, 20)
    await finishInitialization(f, created.run.id)
    const completedId = runComparisons(f, created.run.id)[0].record.id
    const original = await publishResult(f, created.run.id, completedId)
    const before = await f.service.detail(f.workspaceId, created.run.id)
    const cancelling = await f.service.cancel(f.workspaceId, created.run.id, ACTOR, before.etag)
    assert.equal(cancelling.run.cancellation.nextComparisonIndex, 25)
    const pausedRecord = {
      ...cancelling.run, attempts: failure.attempts,
      error: { code: 'storage-error', stage: 'initialization', message: 'Cancellation could not finish from the captured manifest.', retryable: failure.retryable },
    }
    delete pausedRecord.nextAttemptAt
    delete pausedRecord.lease
    const paused = await f.analysis.store.replace(pausedRecord, cancelling.etag)
    assert.equal(api.analysisCancellationNeedsRetry(paused.record), true)
    assert.equal((await f.analysis.store.listPending(NOW, 100)).length, 0)
    assert.deepEqual(await finishInitialization(f, created.run.id), paused, 'A worker helper cannot silently restart an exhausted control cycle.')
    assert.deepEqual((await f.service.cancel(f.workspaceId, created.run.id, ACTOR, paused.etag)).run, paused.record)
    await assert.rejects(f.service.retry(f.workspaceId, created.run.id, {}, cancelling.etag), status(409))
    const cancelledComparison = runComparisons(f, created.run.id)[1]
    await assert.rejects(f.service.retry(f.workspaceId, created.run.id, { comparisonIds: [cancelledComparison.record.id] }, paused.etag), status(409))
    await assert.rejects(f.service.comparisonAction(f.workspaceId, created.run.id, cancelledComparison.record.id, 'retry', cancelledComparison.etag), status(409))

    const recovered = await f.service.retry(f.workspaceId, created.run.id, {}, paused.etag)
    assert.equal(recovered.run.status, 'cancelled')
    assert.equal(recovered.run.attempts, 0)
    assert.equal(recovered.run.retryCount, paused.record.retryCount + 1)
    assert.equal(recovered.run.error, undefined)
    assert.equal(recovered.run.cancellation.nextComparisonIndex, 40)
    assert.ok(recovered.run.cancellation.completedAt)
    assert.equal(recovered.run.cancellation.requestedAt, paused.record.cancellation.requestedAt)
    assert.equal(recovered.run.cancellation.requestedBy, paused.record.cancellation.requestedBy)
    assert.deepEqual(recovered.run.manifest, paused.record.manifest)
    assert.deepEqual(recovered.run.progress, {
      total: 40, initialized: 40, queued: 0, running: 0, complete: 1, failed: 0, cancelled: 39, scored: 1, unscored: 0,
    })
    assert.deepEqual((await f.service.comparisonDetail(f.workspaceId, created.run.id, completedId)).result, original.result)
    assert.equal((await f.analysis.store.listPending(NOW, 100)).length, 0)
    await assert.rejects(f.service.retry(f.workspaceId, created.run.id, {}, paused.etag), status(409))
    const scoring = await f.service.retry(f.workspaceId, created.run.id, {}, recovered.etag)
    assert.equal(scoring.run.progress.queued, 39)
    assert.equal(scoring.run.progress.complete, 1)
    assert.equal(scoring.run.cancellation, undefined)
  }
})

test('HTTP contracts enforce membership, viewer restrictions, CSRF, no-store, strict bodies and conditional mutations', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const job = await seedJob(f)
  const http = await startHttp(f)
  try {
    const input = requestFor(resume, job)
    assert.equal((await http.request('', 'GET', undefined, { noAuth: true })).status, 401)
    assert.equal((await http.request('', 'GET', undefined, { role: 'stranger' })).status, 404)
    assert.equal((await http.request('/targets', 'GET', undefined, { role: 'viewer' })).status, 200)
    assert.equal((await http.request('', 'POST', input, { role: 'viewer', headers: { 'idempotency-key': randomUUID() } })).status, 403)
    assert.equal((await http.request('', 'POST', input, { headers: { origin: 'https://foreign.example', 'idempotency-key': randomUUID() } })).status, 403)
    assert.equal((await http.request('', 'POST', input, { headers: { 'x-score-request': '', 'idempotency-key': randomUUID() } })).status, 403)
    assert.equal((await http.request('', 'POST', input)).status, 400)
    assert.equal((await http.request('', 'POST', { ...input, snapshot: {} }, { headers: { 'idempotency-key': randomUUID() } })).status, 400)
    for (const suffix of ['?limit=101', '?limit=1.1', '?limit=1&limit=2', '?continuationToken=x', '?blobName=secret', '/targets?limit=0']) {
      const response = await http.request(suffix)
      assert.equal(response.status, 400, suffix)
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    const createdResponse = await http.request('', 'POST', input, { headers: { 'idempotency-key': randomUUID() } })
    assert.equal(createdResponse.status, 202)
    assert.equal(createdResponse.headers.get('cache-control'), 'no-store')
    const { run: created } = await createdResponse.json()
    assert.equal(created.run.progress.total, 1)
    assert.equal(createdResponse.headers.get('etag'), created.etag)
    const detail = await (await http.request(`/${created.run.id}`)).json()
    assert.equal(detail.run.id, created.run.id)
    assert.ok(detail.resumes && detail.targets)
    const page = await (await http.request(`/${created.run.id}/comparisons`)).json()
    const comparison = page.comparisons[0]
    const compDetail = await (await http.request(`/${created.run.id}/comparisons/${comparison.comparison.id}`)).json()
    assert.equal(compDetail.comparison.id, comparison.comparison.id)
    assert.equal(compDetail.result, null)
    assert.equal((await http.request(`/${created.run.id}/cancel`, 'POST', {})).status, 428)
    assert.equal((await http.request(`/${created.run.id}/cancel`, 'POST', {}, { headers: { 'if-match': '*' } })).status, 400)
    assert.equal((await http.request(`/${created.run.id}/cancel`, 'POST', {}, { headers: { 'if-match': '"old"' } })).status, 409)
    assert.equal((await http.request(`/${created.run.id}/cancel`, 'POST', { workspaceId: 'tamper' }, { headers: { 'if-match': created.etag } })).status, 400)
    const cancelled = await http.request(`/${created.run.id}/cancel`, 'POST', {}, { headers: { 'if-match': created.etag } })
    assert.equal(cancelled.status, 200)
    const { run } = await cancelled.json()
    assert.equal(run.run.status, 'cancelled')
    const retried = await http.request(`/${created.run.id}/retry`, 'POST', {}, { headers: { 'if-match': run.etag } })
    assert.equal(retried.status, 200)
    assert.equal((await retried.json()).run.run.progress.queued, 1)
    assert.equal((await http.request(`/${created.run.id}/comparisons/${comparison.comparison.id}/documents/${resume.document.id}`)).status, 400)
    const source = await http.request(`/${created.run.id}/comparisons/${comparison.comparison.id}/documents/${resume.document.id}?version=1`)
    assert.equal(source.status, 200)
    assert.deepEqual((await source.json()).document, resume.document)
  } finally { await http.close() }
  const disabled = await startHttp(f, false)
  try { assert.equal((await disabled.request()).status, 503) } finally { await disabled.close() }
})

for (const role of ['stranger', 'viewer']) {
  test(`application Admin with ${role} workspace access can create analyses, read frozen evidence, and manage accepted work`, async t => {
    const f = fixture()
    const resume = await seedResume(f)
    const job = await seedJob(f)
    const http = await startHttp(f)
    t.after(() => http.close())
    const actor = { role, roles: ['Score.Admin'] }
    const input = requestFor(resume, job)
    assert.equal((await http.request('', 'POST', input, { role, headers: { 'idempotency-key': randomUUID() } })).status,
      role === 'stranger' ? 404 : 403)
    const response = await http.request('', 'POST', input, { ...actor, headers: { 'idempotency-key': randomUUID() } })
    assert.equal(response.status, 202)
    const created = (await response.json()).run
    assert.equal((await http.request(`/${created.run.id}`, 'GET', undefined, actor)).status, 200)
    const comparisons = await http.request(`/${created.run.id}/comparisons`, 'GET', undefined, actor)
    assert.equal(comparisons.status, 200)
    const comparison = (await comparisons.json()).comparisons[0].comparison
    const evidence = await http.request(`/${created.run.id}/comparisons/${comparison.id}/documents/${resume.document.id}?version=1`,
      'GET', undefined, actor)
    assert.equal(evidence.status, 200)
    assert.deepEqual((await evidence.json()).document, resume.document)
    assert.equal((await http.request(`/${created.run.id}/cancel`, 'POST', {}, {
      ...actor, headers: { 'if-match': created.etag },
    })).status, 200)
  })
}

test('manifest, snapshot and stored-record validators reject identity, cursor, scope and nested-field tampering', async () => {
  const f = fixture()
  const created = await createRun(f)
  const comparison = runComparisons(f, created.run.id)[0]
  const manifest = await api.readAnalysisManifest(f.analysis.blobs, created.run)
  const { resumeSnapshot, targetSnapshot } = await api.readAnalysisSnapshots(f.analysis.blobs, created.run, comparison.record)
  for (const mutate of [
    value => { value.comparisons[0].id = `analysis-comparison-${randomUUID()}` },
    value => { value.inputFingerprint = '0'.repeat(64) },
    value => { value.resumes[0].blob.blobName = `other-workspace/${created.run.id}/manifest.json` },
    value => { value.createdBy = '' },
    value => { value.request.resumes[0].sample = true },
  ]) {
    const value = clone(manifest); mutate(value)
    assert.throws(() => api.parseAnalysisInitializationManifest(value))
  }
  for (const mutate of [
    value => { value.progress.queued = 0 },
    value => { value.initialization.nextComparisonIndex = 0 },
    value => { value.manifest.blobName = `${f.workspaceId}/analysis-run-${randomUUID()}/manifest.json` },
    value => { value.dataKind = 'sample' },
    value => { value.score = 100 },
  ]) {
    const value = clone(created.run); mutate(value)
    assert.throws(() => api.parseAnalysisEntity(value))
  }
  const foreignProfile = clone(resumeSnapshot)
  foreignProfile.profile.workspaceId = 'other-workspace'
  assert.throws(() => api.parseFrozenResumeSnapshot(foreignProfile))
  const foreignCitation = clone(targetSnapshot)
  foreignCitation.rubric.criteria[0].sourceCitations[0].documentId = resumeSnapshot.document.id
  assert.throws(() => api.parseFrozenTargetSnapshot(foreignCitation))
  const badBlob = clone(f.analysis.blobs.values.get(comparison.record.resume.blob.blobName))
  badBlob.bytes = jsonBytes({ ...resumeSnapshot, dataKind: 'sample' })
  badBlob.sha256 = sha(badBlob.bytes)
  f.analysis.blobs.values.set(comparison.record.resume.blob.blobName, badBlob)
  await assert.rejects(f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id))
})

test('bodyless actions work while nonempty unsupported entities and client fields cannot become empty actions', async () => {
  const f = fixture()
  const created = await createRun(f)
  const comparisonId = runComparisons(f, created.run.id)[0].record.id
  const http = await startHttp(f)
  const path = `/${created.run.id}`
  try {
    const cancelledResponse = await http.request(`${path}/cancel`, 'POST', undefined, { headers: { 'if-match': created.etag } })
    assert.equal(cancelledResponse.status, 200)
    const cancelled = (await cancelledResponse.json()).run
    assert.equal(cancelled.run.status, 'cancelled')
    const retryResponse = await http.request(`${path}/retry`, 'POST', undefined, { headers: { 'if-match': cancelled.etag } })
    assert.equal(retryResponse.status, 200)
    const ready = (await retryResponse.json()).run
    for (const contentType of ['text/plain', 'application/octet-stream']) {
      const response = await http.request(`${path}/cancel`, 'POST', undefined, {
        headers: { 'if-match': ready.etag, 'content-type': contentType }, rawBody: '{}',
      })
      assert.equal(response.status, 400)
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    const chunked = await http.request(`${path}/cancel`, 'POST', undefined, {
      headers: { 'if-match': ready.etag, 'content-type': 'text/plain' },
      rawBody: new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('not an empty action')); controller.close() },
      }),
    })
    assert.equal(chunked.status, 400)
    for (const payload of [[], { score: 100 }, { comparisonIds: [comparisonId] }]) {
      assert.equal((await http.request(`${path}/cancel`, 'POST', payload, { headers: { 'if-match': ready.etag } })).status, 400)
    }
    assert.equal((await f.service.detail(f.workspaceId, created.run.id)).etag, ready.etag)
    const comparison = (await f.service.comparisons(f.workspaceId, created.run.id)).comparisons[0]
    const cancelledPair = await http.request(`${path}/comparisons/${comparisonId}/cancel`, 'POST', undefined, {
      headers: { 'if-match': comparison.etag },
    })
    assert.equal(cancelledPair.status, 200)
    const pair = (await cancelledPair.json()).comparison
    const retriedPair = await http.request(`${path}/comparisons/${comparisonId}/retry`, 'POST', undefined, { headers: { 'if-match': pair.etag } })
    assert.equal(retriedPair.status, 200)
    assert.equal((await retriedPair.json()).comparison.comparison.status, 'queued')
    assert.equal((await http.request(`${path}/cancel`, 'POST')).status, 428)
  } finally { await http.close() }
})
