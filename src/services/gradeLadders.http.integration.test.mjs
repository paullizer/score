import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { buildGradeTestRuntime, publishNeedsSourcesReview, seededLadder, startGradeFixture } from './gradeLadders.test-support.mjs'

const nativeFetch = globalThis.fetch
let runtime
before(async () => { runtime = await buildGradeTestRuntime() })
after(async () => { globalThis.fetch = nativeFetch; await runtime?.close() })

test('frontend workspace fakes enforce conditional metadata, idempotent cleanup, and exclusive mutation leases', async () => {
  const fixture = await startGradeFixture(runtime)
  try {
    const { directory, state, workspaceId, api } = fixture
    const original = await directory.getMetadata(workspaceId)
    await assert.rejects(directory.replaceMetadata(original.metadata, '"stale"'), api.StoreConflictError)
    const operation = { id: 'fixture-operation', action: 'archive', status: 'failed', updatedAt: fixture.now().toISOString() }
    const updated = await directory.replaceMetadata({ ...original.metadata, lifecycleOperation: operation }, original.etag)
    assert.notEqual(updated.etag, original.etag)
    assert.deepEqual((await directory.listLifecycleOperations(1)).map((value) => value.metadata.lifecycleOperation), [operation])

    const first = await state.acquireMutationLease(workspaceId)
    await assert.rejects(state.acquireMutationLease(workspaceId), api.StoreConflictError)
    await first.renew()
    await first.release()
    const second = await state.acquireMutationLease(workspaceId)
    await assert.rejects(first.renew(), api.StoreConflictError)
    await first.release()
    await assert.rejects(state.acquireMutationLease(workspaceId), api.StoreConflictError, 'A stale release cannot unlock the next lease holder')
    await second.renew()
    await second.release()

    const snapshot = await state.getState(workspaceId)
    await assert.rejects(state.deleteState(workspaceId, '"stale"'), api.StoreConflictError)
    await state.deleteState(workspaceId, snapshot.etag)
    await state.deleteState(workspaceId, snapshot.etag)
    assert.equal(await state.getState(workspaceId), undefined)
    await directory.deleteMemberships(workspaceId)
    const ownerId = api.membershipIdFor(original.metadata.ownerId)
    assert.equal([...directory.memberships.values()].filter((membership) => membership.workspaceId === workspaceId).length, 1)
    assert.ok(await directory.getMembership(workspaceId, ownerId), 'The owner can still discover and resume an unfinished deletion')
    const deletedAt = fixture.now().toISOString()
    await directory.replaceMetadata({ ...updated.metadata, deletedAt,
      lifecycleOperation: { ...operation, action: 'delete', status: 'complete', updatedAt: deletedAt } }, updated.etag)
    assert.equal([...directory.memberships.values()].some((membership) => membership.workspaceId === workspaceId), false)
  } finally { await fixture.close() }
})

test('real API/client lifecycle captures exact seed versions, real PDFs, frozen citations, independent grades and immutable edits', async () => {
  const fixture = await startGradeFixture(runtime)
  let restoreFetch
  try {
    const seeded = await seededLadder(fixture)
    restoreFetch = fixture.installClientFetch()
    const client = runtime.client, workspaceId = fixture.workspaceId, ladderId = seeded.detail.ladder.id
    let detail = seeded.detail
    assert.equal(detail.ladder.seedRubricVersion, 1, 'a stable rubric ID does not silently select latest seed v2')
    assert.equal(detail.sources.filter((source) => source.origin !== 'seed-job').length, 1)
    assert.equal(detail.sources.length, 2, 'the seed is captured in addition to the supporting source')
    assert.equal(detail.levels.find((level) => level.head.grade === 9).head.status, 'ready-for-review')
    assert.equal(detail.levels.find((level) => level.head.grade === 11).head.status, 'needs-sources')
    assert.equal(detail.sourceSet.sources.find((source) => source.sourceId === seeded.source.id).pageCount, 204)
    assert.deepEqual(detail.sourceSet.sources.find((source) => source.sourceId === seeded.source.id).selectedPages, [178, 204])
    const captured = await client.getGradeSourceDocument(workspaceId, ladderId, seeded.source.id, detail.sourceSet.id)
    assert.equal(captured.kind, 'reference')
    assert.deepEqual(captured, seeded.document)
    const jobBefore = JSON.stringify(await fixture.jobs.store.get(workspaceId, seeded.seed.job.id))
    const seedBefore = JSON.stringify(await fixture.jobs.store.listRubrics(workspaceId, seeded.seed.job.id))

    const unsupported = detail.levels.find((level) => level.head.grade === 11)
    await assert.rejects(client.approveGrade(workspaceId, ladderId, 11, { versionId: unsupported.version.id, reviewId: unsupported.review.id }, unsupported.etag), /successful grounding review|block|support/i)
    const supported = detail.levels.find((level) => level.head.grade === 9)
    await assert.rejects(client.approveGrade(workspaceId, ladderId, 9, { versionId: supported.version.id, reviewId: supported.review.id }, detail.etag), /changed|version|etag/i)
    const sourceSetId = detail.sourceSet.id, originalVersion = structuredClone(supported.version)
    detail = await client.approveGrade(workspaceId, ladderId, 9, { versionId: supported.version.id, reviewId: supported.review.id }, supported.etag)
    assert.equal(detail.levels.find((level) => level.head.grade === 9).head.status, 'approved')
    assert.equal(detail.levels.find((level) => level.head.grade === 11).head.status, 'needs-sources')
    assert.deepEqual(detail.levels.find((level) => level.head.grade === 9).version, originalVersion, 'approval appends a separate record')

    const approved = detail.levels.find((level) => level.head.grade === 9)
    const edit = { rubric: { ...approved.version.rubric, name: 'Reviewer-edited engineering draft' }, qualifications: approved.version.qualifications }
    detail = await client.saveGradeDraft(workspaceId, ladderId, 9, edit, approved.etag)
    const edited = detail.levels.find((level) => level.head.grade === 9)
    assert.equal(edited.version.version, 2)
    assert.equal(edited.head.status, 'processing')
    assert.equal(edited.review, null)
    assert.equal(edited.head.approvedVersionId, originalVersion.id, 'old approval remains available')
    assert.equal(edited.version.rubric.provenance.kind, 'edited')
    await assert.rejects(client.approveGrade(workspaceId, ladderId, 9, { versionId: edited.version.id, reviewId: approved.review.id }, edited.etag), /grounding review/)
    const versions = await client.listAllGradeVersions(workspaceId, ladderId, 9)
    assert.equal(versions.length, 2)
    assert.deepEqual(versions.find((version) => version.id === originalVersion.id), originalVersion)
    assert.notEqual(versions[0].rubric.id, versions[1].rubric.id, 'each immutable grade version has a distinct rubric identity')
    assert.equal(versions[0].rubric.groupId, versions[1].rubric.groupId, 'the family/grade head identity is stable')

    const review = { ...approved.review, id: `grade-review-${randomUUID()}`, versionId: edited.version.id, versionHash: edited.version.contentHash, createdAt: fixture.now().toISOString(), updatedAt: fixture.now().toISOString() }
    const currentHead = await fixture.grades.store.get(workspaceId, edited.head.id)
    await fixture.grades.store.transact(workspaceId, [
      { kind: 'create', record: review },
      { kind: 'replace', record: { ...currentHead.record, status: 'ready-for-review', latestReviewId: review.id, updatedAt: fixture.now().toISOString() }, etag: currentHead.etag },
    ])
    detail = await client.getGradeLadder(workspaceId, ladderId)
    const checked = detail.levels.find((level) => level.head.grade === 9)
    detail = await client.approveGrade(workspaceId, ladderId, 9, { versionId: checked.version.id, reviewId: checked.review.id }, checked.etag)
    assert.equal(detail.levels.find((level) => level.head.grade === 9).head.approvedVersionId, edited.version.id)
    assert.equal([...fixture.grades.store.values.values()].filter(({ record }) => record.recordType === 'grade-approval').length, 2)

    detail = await client.updateGradeSource(workspaceId, ladderId, seeded.source.id, { selectedPages: [178] }, detail.etag)
    assert.equal(detail.sourceSet, null, 'new extraction invalidates confirmation for new work')
    assert.equal(detail.sources.find((source) => source.id === seeded.source.id).documentVersion, 2)
    assert.deepEqual(await client.getGradeSourceDocument(workspaceId, ladderId, seeded.source.id, sourceSetId), captured, 'history resolves the old document blob')
    const originalResponse = await fixture.request(client.gradeSourceOriginalUrl(workspaceId, ladderId, seeded.source.id, sourceSetId))
    assert.equal(originalResponse.status, 200)
    assert.equal(originalResponse.headers.get('content-type'), 'application/pdf')
    assert.equal(originalResponse.headers.get('cache-control'), 'no-store')
    const original = new Uint8Array(await originalResponse.arrayBuffer())
    assert.ok(new TextDecoder().decode(original.slice(0, 8)).startsWith('%PDF-'))
    assert.deepEqual(original, (await fixture.grades.blobs.read(seeded.source.originalBlobName)).bytes)
    detail = await client.updateGradeLadder(workspaceId, ladderId, { grades: [9, 11, 15], context: { ...detail.ladder.context, specialty: 'Updated context requires new evidence.' } }, detail.etag)
    assert.deepEqual(detail.ladder.grades, [9, 11, 15])
    assert.equal((await client.listAllGradeVersions(workspaceId, ladderId, 9)).length, 2)
    assert.equal(JSON.stringify(await fixture.jobs.store.get(workspaceId, seeded.seed.job.id)), jobBefore)
    assert.equal(JSON.stringify(await fixture.jobs.store.listRubrics(workspaceId, seeded.seed.job.id)), seedBefore)
    assert.equal(fixture.state.saves.length, 0, 'real grade requests never write legacy sample state')
  } finally { restoreFetch?.(); await fixture.close() }
})

test('real API saves a still-incomplete zero-weight draft without inventing weights or approval', async () => {
  const fixture = await startGradeFixture(runtime)
  let restoreFetch
  try {
    const { detail } = await seededLadder(fixture)
    restoreFetch = fixture.installClientFetch()
    const client = runtime.client, workspaceId = fixture.workspaceId, ladderId = detail.ladder.id
    const gap = detail.levels.find((level) => level.head.grade === 11)
    assert.equal(gap.version.rubric.criteria[0].weight, 0)
    assert.equal(gap.version.rubric.criteria[0].support, 'gap')
    const input = {
      rubric: { ...gap.version.rubric, name: 'Still-incomplete engineering draft', description: 'Updated description; work-level evidence is still missing.' },
      qualifications: gap.version.qualifications,
    }
    const saved = await client.saveGradeDraft(workspaceId, ladderId, 11, input, gap.etag)
    const edited = saved.levels.find((level) => level.head.grade === 11)
    assert.equal(edited.version.version, 2)
    assert.equal(edited.version.rubric.name, input.rubric.name)
    assert.equal(edited.version.rubric.description, input.rubric.description)
    assert.deepEqual(edited.version.rubric.criteria, gap.version.rubric.criteria)
    assert.equal(edited.version.rubric.criteria.reduce((total, criterion) => total + criterion.weight, 0), 0)
    assert.equal(edited.head.status, 'processing')
    assert.equal(edited.review, null)
    assert.equal(edited.approval, null)
    assert.equal(edited.head.approvedVersionId, undefined)
    await assert.rejects(client.approveGrade(workspaceId, ladderId, 11, { versionId: edited.version.id, reviewId: gap.review.id }, edited.etag), /grounding review/)
    await publishNeedsSourcesReview(fixture, edited, gap.review.issues)
    const reviewed = (await client.getGradeLadder(workspaceId, ladderId)).levels.find((level) => level.head.grade === 11)
    assert.equal(reviewed.head.status, 'needs-sources')
    assert.equal(reviewed.review.outcome, 'needs-sources')
    assert.equal(reviewed.approval, null)
    await assert.rejects(client.approveGrade(workspaceId, ladderId, 11, { versionId: reviewed.version.id, reviewId: reviewed.review.id }, reviewed.etag), /grounding review/)
    assert.equal([...fixture.grades.store.values.values()].some(({ record }) => record.recordType === 'grade-approval'), false)
    assert.deepEqual((await client.listAllGradeVersions(workspaceId, ladderId, 11)).find((version) => version.id === gap.version.id), gap.version)
  } finally { restoreFetch?.(); await fixture.close() }
})

test('real API supports arbitrary GS inputs and idempotent paged creation while preserving job feature responses', async () => {
  const fixture = await startGradeFixture(runtime)
  let restoreFetch
  try {
    const { seed, detail } = await seededLadder(fixture)
    restoreFetch = fixture.installClientFetch()
    assert.equal((await runtime.jobsClient.fetchJobProcessingFeatures()).realJobImports, true)
    assert.equal((await runtime.jobsClient.fetchJobProcessingFeatures()).limits.maxPdfPages, 50)
    assert.equal((await runtime.client.fetchGradeProcessingFeatures()).gradeLimits.maxPdfPages, 250)
    const key = randomUUID()
    const input = { name: 'IT family with the same display name', jobId: seed.job.id, rubricId: seed.rubric.id, rubricVersion: 2,
      context: { ...detail.ladder.context, series: '2210' }, grades: Array.from({ length: 15 }, (_, index) => index + 1) }
    const first = await runtime.client.createGradeLadder(fixture.workspaceId, input, key)
    const repeat = await runtime.client.createGradeLadder(fixture.workspaceId, input, key)
    assert.equal(repeat.ladder.id, first.ladder.id)
    assert.equal(first.levels.length, 15)
    assert.equal(first.ladder.seedRubricVersion, 2)
    await assert.rejects(runtime.client.createGradeLadder(fixture.workspaceId, { ...input, name: 'Different payload' }, key), /idempotency key/)
    const other = await runtime.client.createGradeLadder(fixture.workspaceId, { ...input, context: { ...input.context, series: '9999' } }, randomUUID())
    assert.equal(other.ladder.context.series, '9999', 'unknown series enter discovery rather than silently map to a fixed series')
    const all = await runtime.client.listAllGradeLadders(fixture.workspaceId)
    assert.equal(all.length, 3)
    assert.notEqual(first.ladder.id, other.ladder.id)
    assert.ok(fixture.requests.some((request) => request.url.includes('continuationToken=')), 'real pagination was exercised')
  } finally { restoreFetch?.(); await fixture.close() }
})

test('viewer and cross-workspace API boundaries authorize before reference mutations or downloads', async () => {
  const fixture = await startGradeFixture(runtime)
  let restoreFetch
  try {
    const { detail, source } = await seededLadder(fixture)
    const created = await fixture.request('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Other private workspace' }) })
    assert.equal(created.status, 201)
    const other = (await created.json()).workspace
    restoreFetch = fixture.installClientFetch()
    const cross = await fixture.request(`/api/workspaces/${other.id}/grade-ladders/${detail.ladder.id}/sources/${source.id}/original?sourceSetId=${detail.sourceSet.id}`)
    assert.equal(cross.status, 404)
    fixture.setRole('viewer')
    assert.equal((await runtime.client.getGradeLadder(fixture.workspaceId, detail.ladder.id)).ladder.id, detail.ladder.id)
    const history = await runtime.client.getGradeSourceDocument(fixture.workspaceId, detail.ladder.id, source.id, detail.sourceSet.id)
    assert.equal(history.kind, 'reference')
    await assert.rejects(runtime.client.generateGradeLadder(fixture.workspaceId, detail.ladder.id, detail.etag, randomUUID()), { status: 403 })
    const raw = await fixture.request(`/api/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}/sources/pdf`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: 'not a PDF and no idempotency header' })
    assert.equal(raw.status, 403, 'viewer authorization precedes raw PDF parsing and upload metadata checks')
    const anonymous = await nativeFetch(`${fixture.origin}/api/features`)
    assert.equal(anonymous.status, 401)
    assert.equal(fixture.state.saves.length, 0)
  } finally { restoreFetch?.(); await fixture.close() }
})
