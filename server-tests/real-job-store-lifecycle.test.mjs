import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { build } from 'esbuild'
import { fakeJobCosmos, realJobRecord, realJobRubric, JOB_TEST_WORKSPACE as workspaceId, JOB_TEST_ID as jobId, JOB_TEST_TIME as timestamp } from './job-cosmos-fake.mjs'
import { fakeJobBlobContainer } from './job-blob-fake.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist-server', 'job-lifecycle-test-entry.mjs')
await build({
  stdin: {
    contents: [
      "export * from './server/jobs/azure-store';",
      "export * from './server/jobs/lifecycle';",
      "export * from './server/jobs/guards';",
      "export * from './server/jobs/validation';",
    ].join('\n'),
    loader: 'ts', resolveDir: root,
  },
  outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24',
})
const {
  createJobStoreFromContainer, createJobBlobStoreFromContainer, createJobLifecycleParticipant,
  JobCleanupPendingError, jobLifecycleImpact, purgeJob, purgeJobRubric, putJobBlob, validateRealJobRecord,
} = await import(pathToFileURL(output).href)

function fixture() {
  const cosmos = fakeJobCosmos()
  const blob = fakeJobBlobContainer()
  const jobs = { store: createJobStoreFromContainer(cosmos.container), blobs: createJobBlobStoreFromContainer(blob.container) }
  return { cosmos, blob, jobs }
}

async function ready(jobs) {
  const created = await jobs.store.create(realJobRecord())
  const rubric = realJobRubric(created.value.record)
  const value = await jobs.store.publish({
    ...created.value.record, nextAttemptAt: undefined,
    job: { ...created.value.record.job, status: 'ready', rubricId: rubric.id },
  }, created.value.etag, rubric)
  return { value, rubric }
}

function injectEmptyCosmosPages(cosmos) {
  cosmos.queryPages((_spec, options, readPage) => {
    const token = options.continuationToken ?? '0'
    const empty = /^empty:(\d+):(\d+)$/.exec(token)
    const offset = empty?.[1] ?? token
    const stage = empty ? Number(empty[2]) : 0
    if (stage < 2) return { resources: [], continuationToken: `empty:${offset}:${stage + 1}` }
    return readPage(offset)
  })
}

test('job creation, claim and publication use same-partition workspace CAS rather than a racy check', async () => {
  const { cosmos, jobs } = fixture()
  const created = await jobs.store.create(realJobRecord())
  assert.equal((await jobs.store.create(realJobRecord())).created, false)
  cosmos.beforeBatch(async () => jobs.store.setWorkspaceLifecycle(workspaceId, 'archived', timestamp))
  await assert.rejects(jobs.store.replace({
    ...created.value.record, lease: { owner: 'stale-worker', expiresAt: new Date(Date.now() + 90_000).toISOString() },
  }, created.value.etag), /workspace is archived/)
  assert.equal((await jobs.store.get(workspaceId, jobId)).record.lease, undefined)
  await assert.rejects(jobs.store.create(realJobRecord(workspaceId, `job-${randomUUID()}`)), /workspace is archived/)
  await jobs.store.cancelWorkspace(workspaceId, timestamp)
  const cancelled = await jobs.store.get(workspaceId, jobId)
  assert.equal(cancelled.record.lifecycle, undefined)
  assert.equal(cancelled.record.job.status, 'cancelled')
  await jobs.store.setWorkspaceLifecycle(workspaceId, 'active', timestamp)
  assert.deepEqual(await jobs.store.listPending('2099-01-01T00:00:00.000Z', 10), [])
  for (const batch of cosmos.batches) assert.equal(batch[0].id, 'job-workspace-lifecycle')
})

test('job and rubric archives never alter immutable rubric evidence and preserve independent child archives', async () => {
  const { cosmos, jobs } = fixture()
  const { value, rubric } = await ready(jobs)
  const rawVersion = structuredClone([...cosmos.records.values()].find(value => value.recordType === 'rubric-version'))
  const child = await jobs.store.transitionLifecycle(workspaceId, jobId, value.etag, 'rubric', 'archive', timestamp)
  const parent = await jobs.store.transitionLifecycle(workspaceId, jobId, child.etag, 'job', 'archive', timestamp)
  const restored = await jobs.store.transitionLifecycle(workspaceId, jobId, parent.etag, 'job', 'unarchive', timestamp)
  assert.equal(restored.record.rubricLifecycle.archivedAt, timestamp)
  assert.equal(restored.record.job.status, 'ready')
  assert.deepEqual([...cosmos.records.values()].find(value => value.recordType === 'rubric-version'), rawVersion)
  assert.deepEqual(await jobs.store.getRubric(workspaceId, rubric.id), rubric)
  await assert.rejects(jobs.store.publish(restored.record, restored.etag, { ...rubric, version: 2 }), /archived or removed/)
})

test('rubric delete purges all immutable pages and leaves a validated deliberate No rubric state', async () => {
  const { cosmos, jobs } = fixture()
  const { value, rubric } = await ready(jobs)
  for (let version = 2; version <= 127; version += 1) {
    cosmos.write({
      id: `rubric-version:${rubric.id}:${version}`, workspaceId, recordType: 'rubric-version',
      jobId, rubricId: rubric.id, version, rubric: { ...rubric, version },
    })
  }
  const queried = []
  const impact = await jobLifecycleImpact(jobs, value, 'rubric', {
    async impact(workspace, target) { queried.push({ workspace, target }); return [] },
  })
  assert.equal(impact.counts.rubricVersions, 127)
  assert.deepEqual(queried, [{ workspace: workspaceId, target: { kind: 'rubric', id: rubric.groupId } }])
  const deleting = await jobs.store.transitionLifecycle(workspaceId, jobId, value.etag, 'rubric', 'delete', timestamp)
  const deleted = await purgeJobRubric(jobs, deleting, timestamp)
  assert.equal(deleted.record.job.status, 'ready')
  assert.equal(deleted.record.job.rubricId, null)
  assert.equal(deleted.record.job.rubricDeletedAt, timestamp)
  assert.ok(validateRealJobRecord(deleted.record))
  assert.equal(validateRealJobRecord({ ...deleted.record, job: { ...deleted.record.job, rubricDeletedAt: undefined } }), false)
  assert.deepEqual(await jobs.store.listRubrics(workspaceId, jobId), [])
  assert.equal(await jobs.store.getRubric(workspaceId, rubric.id), undefined)
  assert.ok(cosmos.batches.filter(batch => batch.some(op => op.operationType === 'Delete')).length >= 3)
  await assert.rejects(jobs.store.publish(value.record, value.etag, { ...rubric, version: 128 }), /changed|removed/)
  await assert.rejects(jobs.store.replace({ ...deleted.record, job: { ...deleted.record.job, status: 'queued' } }, deleted.etag), /archived or removed/)
})

test('a rubric deletion between worker precheck and Cosmos publication never resurrects a version', async () => {
  const { cosmos, jobs } = fixture()
  const { value, rubric } = await ready(jobs)
  cosmos.beforeBatch(async () => {
    const deleting = await jobs.store.transitionLifecycle(workspaceId, jobId, value.etag, 'rubric', 'delete', timestamp)
    await purgeJobRubric(jobs, deleting, timestamp)
  })
  await assert.rejects(jobs.store.publish(value.record, value.etag, { ...rubric, version: 2 }), /changed/)
  assert.equal((await jobs.store.get(workspaceId, jobId)).record.job.rubricId, null)
  assert.deepEqual(await jobs.store.listRubrics(workspaceId, jobId), [])
})

test('job tombstones block URL create and PDF upload replay without retaining deleted content', async () => {
  const { cosmos, blob, jobs } = fixture()
  const { value } = await ready(jobs)
  await putJobBlob(jobs.store, jobs.blobs, workspaceId, jobId, `${workspaceId}/${jobId}/original.html`, Buffer.from('<main>role</main>'), 'text/html')
  const deleting = await jobs.store.transitionLifecycle(workspaceId, jobId, value.etag, 'job', 'delete', timestamp)
  await purgeJob(jobs, deleting, timestamp)
  assert.equal(await jobs.store.get(workspaceId, jobId), undefined)
  assert.deepEqual(cosmos.records.get(`${workspaceId}/${jobId}`), {
    id: jobId, workspaceId, recordType: 'job-tombstone', deletedAt: timestamp,
    _etag: cosmos.records.get(`${workspaceId}/${jobId}`)._etag,
  })
  assert.equal(blob.values.size, 0)
  await assert.rejects(jobs.store.create(realJobRecord()), /deleted job/)
  await assert.rejects(putJobBlob(jobs.store, jobs.blobs, workspaceId, jobId, `${workspaceId}/${jobId}/original.pdf`, Buffer.from('%PDF-old'), 'application/pdf'), /removed/)
  assert.equal(blob.values.size, 0)
})

test('bounded Blob writers make deletion pending and an expired late content PUT cannot recreate purged sources', async () => {
  const { cosmos, blob, jobs } = fixture()
  const created = await jobs.store.create(realJobRecord())
  blob.beforeContentUpload(async () => {
    const deleting = await jobs.store.transitionLifecycle(workspaceId, jobId, created.value.etag, 'job', 'delete', timestamp)
    await assert.rejects(purgeJob(jobs, deleting, timestamp), JobCleanupPendingError)
    for (const raw of cosmos.records.values()) if (raw.recordType === 'blob-writer') raw.expiresAt = new Date(0).toISOString()
    blob.expireLeases()
    await purgeJob(jobs, deleting, timestamp)
  })
  await assert.rejects(putJobBlob(
    jobs.store, jobs.blobs, workspaceId, jobId, `${workspaceId}/${jobId}/original.html`, Buffer.from('late source'), 'text/html',
  ), /412/)
  assert.equal(blob.values.size, 0)
  assert.equal(await jobs.store.get(workspaceId, jobId), undefined)
})

test('a lifecycle fence after Blob lease acquisition prevents content persistence', async () => {
  const { blob, jobs } = fixture()
  const created = await jobs.store.create(realJobRecord())
  blob.afterAcquire(async () => {
    await jobs.store.transitionLifecycle(workspaceId, jobId, created.value.etag, 'job', 'archive', timestamp)
  })
  await assert.rejects(putJobBlob(
    jobs.store, jobs.blobs, workspaceId, jobId, `${workspaceId}/${jobId}/original.html`, Buffer.from('source'), 'text/html',
  ), /archived or removed/)
  assert.equal(await jobs.blobs.read(`${workspaceId}/${jobId}/original.html`), undefined)
  assert.equal([...blob.values.values()][0].bytes.length, 0, 'abandoned preparation markers contain no source content')
})

test('workspace purge pages jobs and every owned Blob prefix while preserving another workspace', async () => {
  const { cosmos, blob, jobs } = fixture()
  for (let index = 0; index < 111; index += 1) {
    const id = `job-${randomUUID()}`
    await jobs.store.create(realJobRecord(workspaceId, id))
    blob.values.set(`${workspaceId}/${id}/preparation/request-${index}.json`, {
      bytes: Buffer.from('private'), contentType: 'application/json', metadata: {}, etag: `"${index}"`,
    })
  }
  const other = 'workspace-one-other'
  await jobs.store.create(realJobRecord(other))
  const preservedName = `${other}/${jobId}/original.pdf`
  blob.values.set(preservedName, { bytes: Buffer.from('%PDF-other'), metadata: {}, etag: '"other"', contentType: 'application/pdf' })
  const participant = createJobLifecycleParticipant(jobs)
  assert.deepEqual(await participant.counts(workspaceId), { jobs: 111, rubrics: 0, rubricVersions: 0, sourceArtifacts: 111 })
  await participant.setState(workspaceId, 'deleting', timestamp)
  await participant.cancel(workspaceId, timestamp)
  await participant.purge(workspaceId, timestamp)
  await participant.setState(workspaceId, 'deleted', timestamp)
  assert.deepEqual((await jobs.store.list(workspaceId)).jobs, [])
  assert.ok(await jobs.store.get(other, jobId))
  assert.deepEqual([...blob.values.keys()], [preservedName])
  assert.ok(blob.deleted.every(name => name.startsWith(`${workspaceId}/`)))
  assert.equal([...cosmos.records.values()].filter(value => value.workspaceId === workspaceId && value.recordType === 'job-tombstone').length, 111)
  await assert.rejects(participant.setState(workspaceId, 'active', timestamp), /cannot be restored/)
})

test('Blob cleanup rejects traversal, arbitrary prefixes and malicious page ownership', async () => {
  const { blob, jobs } = fixture()
  await assert.rejects(jobs.blobs.list('../workspace'), /Invalid job blob scope/)
  await assert.rejects(jobs.blobs.delete(workspaceId, jobId, `workspace-two/${jobId}/original.pdf`), /Invalid job Blob deletion scope/)
  await assert.rejects(jobs.blobs.delete(workspaceId, jobId, `${workspaceId}/${jobId}/../secret`), /Invalid job Blob deletion scope/)
  assert.deepEqual(blob.deleted, [])
  const malicious = createJobBlobStoreFromContainer({
    getBlockBlobClient() { throw new Error('must not mutate') },
    listBlobsFlat() {
      return { byPage() { return { async next() { return { value: { segment: { blobItems: [{ name: `workspace-two/${jobId}/original.pdf` }] } } } } } } }
    },
  })
  await assert.rejects(malicious.list(workspaceId, jobId), /outside its validated scope/)
})

test('job validation only accepts lifecycle flags in mutable job metadata and rejects accidental ready-null states', () => {
  const record = realJobRecord()
  assert.ok(validateRealJobRecord({ ...record, lifecycle: { archivedAt: timestamp }, rubricLifecycle: { archivedAt: timestamp, parentKey: `job:${jobId}` } }))
  assert.equal(validateRealJobRecord({ ...record, source: { ...record.source, archivedAt: timestamp } }), false)
  assert.equal(validateRealJobRecord({ ...record, lifecycle: { archivedAt: 'bad timestamp' } }), false)
  assert.equal(validateRealJobRecord({ ...record, job: { ...record.job, status: 'ready' } }), false)
})

test('dependency reads without a configured provider fail closed', async () => {
  const { jobs } = fixture()
  const { value } = await ready(jobs)
  await assert.rejects(jobLifecycleImpact(jobs, value, 'job', undefined), /dependency checks are unavailable/)
})

test('pending job polling continues past archived workspaces instead of starving active ones', async () => {
  const { jobs } = fixture()
  for (let index = 0; index < 23; index += 1) await jobs.store.create(realJobRecord(workspaceId, `job-${randomUUID()}`))
  await jobs.store.setWorkspaceLifecycle(workspaceId, 'archived', timestamp)
  const active = await jobs.store.create(realJobRecord('active-workspace'))
  const pending = await jobs.store.listPending('2099-01-01T00:00:00.000Z', 5)
  assert.deepEqual(pending.map(value => value.record.workspaceId), [active.value.record.workspaceId])
})

test('missing Blob fencing capability is explicit rather than an unfenced source write', async () => {
  const { jobs } = fixture()
  await jobs.store.create(realJobRecord())
  const blobs = {
    async putImmutable() { assert.fail('must not silently use an unfenced legacy Blob writer') },
  }
  await assert.rejects(putJobBlob(
    jobs.store, blobs, workspaceId, jobId, `${workspaceId}/${jobId}/original.html`, Buffer.from('source'), 'text/html',
  ), /fencing is unavailable/)
})

test('workspace purge includes unpublished imports and preparation artifacts without a job record', async () => {
  const { blob, jobs } = fixture()
  const sourceName = `${workspaceId}/${jobId}/original.pdf`
  await putJobBlob(jobs.store, jobs.blobs, workspaceId, jobId, sourceName, Buffer.from('%PDF-unpublished'), 'application/pdf')
  blob.values.set(`${workspaceId}/${jobId}/preparation/request.json`, {
    bytes: Buffer.from('unpublished request'), contentType: 'application/json', metadata: {}, etag: '"request"',
  })
  assert.equal(await jobs.store.get(workspaceId, jobId), undefined)
  const participant = createJobLifecycleParticipant(jobs)
  assert.deepEqual(await participant.counts(workspaceId), { jobs: 0, rubrics: 0, rubricVersions: 0, sourceArtifacts: 2 })
  await participant.setState(workspaceId, 'deleting', timestamp)
  await participant.cancel(workspaceId, timestamp)
  await participant.purge(workspaceId, timestamp)
  await participant.setState(workspaceId, 'deleted', timestamp)
  assert.equal(blob.values.size, 0)
  await assert.rejects(putJobBlob(
    jobs.store, jobs.blobs, workspaceId, jobId, sourceName, Buffer.from('%PDF-late'), 'application/pdf',
  ), /workspace is archived or removed/)
  assert.equal(blob.values.size, 0)
})

test('restarted job participants discover durable cleanup and continue other entities while a writer drains', async () => {
  const { cosmos, jobs } = fixture()
  const { value } = await ready(jobs)
  await jobs.store.transitionLifecycle(workspaceId, jobId, value.etag, 'rubric', 'delete', timestamp)
  const owned = await jobs.store.create(realJobRecord(workspaceId, `job-${randomUUID()}`))
  await jobs.store.beginBlobWrite(workspaceId, owned.value.record.id, `${workspaceId}/${owned.value.record.id}/original.html`)
  await jobs.store.transitionLifecycle(workspaceId, owned.value.record.id, owned.value.etag, 'job', 'delete', timestamp)
  await jobs.store.create(realJobRecord('unrelated-workspace'))
  const restarted = createJobLifecycleParticipant(jobs)
  assert.deepEqual(await restarted.pendingWorkspaces(20), [workspaceId])
  await assert.rejects(restarted.resume(workspaceId, timestamp), JobCleanupPendingError)
  assert.equal((await jobs.store.get(workspaceId, jobId)).record.job.rubricDeletedAt, timestamp)
  assert.deepEqual(await restarted.pendingWorkspaces(20), [workspaceId])
  for (const raw of cosmos.records.values()) if (raw.recordType === 'blob-writer') raw.expiresAt = new Date(0).toISOString()
  await createJobLifecycleParticipant(jobs).resume(workspaceId, timestamp)
  assert.equal(await jobs.store.get(workspaceId, owned.value.record.id), undefined)
  assert.ok(await jobs.store.get('unrelated-workspace', jobId))
  assert.deepEqual(await restarted.pendingWorkspaces(20), [])
})

test('job cleanup reconciliation is page-bounded and leaves the remaining page discoverable', async () => {
  const { jobs } = fixture()
  for (let index = 0; index < 52; index += 1) {
    const created = await jobs.store.create(realJobRecord(workspaceId, `job-${randomUUID()}`))
    await jobs.store.transitionLifecycle(workspaceId, created.value.record.id, created.value.etag, 'job', 'delete', timestamp)
  }
  const participant = createJobLifecycleParticipant(jobs)
  await participant.resume(workspaceId, timestamp)
  assert.equal((await jobs.store.listLifecyclePending(workspaceId)).jobs.length, 2)
  assert.deepEqual(await participant.pendingWorkspaces(20), [workspaceId])
  await participant.resume(workspaceId, timestamp)
  assert.deepEqual(await participant.pendingWorkspaces(20), [])
})

test('missing lifecycle discovery/resume capabilities fail explicitly', async () => {
  const { jobs } = fixture()
  const participant = createJobLifecycleParticipant(jobs)
  delete jobs.store.pendingLifecycleWorkspaces
  await assert.rejects(participant.pendingWorkspaces(20), /discovery is unavailable/)
  delete jobs.store.listLifecyclePending
  await assert.rejects(participant.resume(workspaceId, timestamp), /recovery storage is unavailable/)
})

test('job cleanup follows empty Cosmos pages and retries residual history behind an existing tombstone', async () => {
  const { cosmos, jobs } = fixture()
  const { value, rubric } = await ready(jobs)
  for (let version = 2; version <= 57; version += 1) {
    cosmos.write({
      id: `rubric-version:${rubric.id}:${version}`, workspaceId, recordType: 'rubric-version',
      jobId, rubricId: rubric.id, version, rubric: { ...rubric, version },
    })
  }
  const deleting = await jobs.store.transitionLifecycle(workspaceId, jobId, value.etag, 'job', 'delete', timestamp)
  injectEmptyCosmosPages(cosmos)
  await purgeJob(jobs, deleting, timestamp)
  assert.equal(cosmos.records.get(`${workspaceId}/${jobId}`).recordType, 'job-tombstone')
  assert.equal([...cosmos.records.values()].filter(record => record.recordType === 'rubric-version').length, 0)

  const leftover = {
    id: `rubric-version:${rubric.id}:58`, workspaceId, recordType: 'rubric-version',
    jobId, rubricId: rubric.id, version: 58, rubric: { ...rubric, version: 58 },
  }
  cosmos.write(leftover)
  await jobs.store.purgeJobRecords(workspaceId, jobId, timestamp)
  assert.equal(cosmos.records.has(`${workspaceId}/${leftover.id}`), false)
  assert.equal(cosmos.records.get(`${workspaceId}/${jobId}`).recordType, 'job-tombstone')
})

test('rubric deletion completion rejects hidden later-page versions before publishing No rubric', async () => {
  const { cosmos, jobs } = fixture()
  const { value } = await ready(jobs)
  const deleting = await jobs.store.transitionLifecycle(workspaceId, jobId, value.etag, 'rubric', 'delete', timestamp)
  injectEmptyCosmosPages(cosmos)
  await assert.rejects(jobs.store.completeRubricDeletion(workspaceId, jobId, deleting.etag, timestamp), /cleanup has not completed/)
  const unchanged = await jobs.store.get(workspaceId, jobId)
  assert.equal(unchanged.etag, deleting.etag)
  assert.ok(unchanged.record.job.rubricId)
  const deleted = await purgeJobRubric(jobs, deleting, timestamp)
  assert.equal(deleted.record.job.rubricId, null)
  assert.equal([...cosmos.records.values()].some(record => record.recordType === 'rubric-version'), false)
})

test('workspace cleanup follows empty Cosmos pages for versions, writers, and every job page', async () => {
  const { cosmos, jobs } = fixture()
  await ready(jobs)
  for (let index = 0; index < 54; index += 1) await jobs.store.create(realJobRecord(workspaceId, `job-${randomUUID()}`))
  await jobs.store.create(realJobRecord('other-workspace'))
  const writer = await jobs.store.beginBlobWrite(workspaceId, jobId, `${workspaceId}/${jobId}/original.html`)
  cosmos.records.get(`${workspaceId}/${writer.id}`).expiresAt = new Date(0).toISOString()
  injectEmptyCosmosPages(cosmos)
  const participant = createJobLifecycleParticipant(jobs)
  await participant.setState(workspaceId, 'deleting', timestamp)
  await participant.cancel(workspaceId, timestamp)
  await participant.purge(workspaceId, timestamp)
  const remaining = [...cosmos.records.values()].filter(record => record.workspaceId === workspaceId)
  assert.equal(remaining.filter(record => record.recordType === 'job-tombstone').length, 55)
  assert.equal(remaining.some(record => ['job', 'rubric-version', 'blob-writer'].includes(record.recordType)), false)
  assert.ok(await jobs.store.get('other-workspace', jobId))
})

test('job cleanup fails closed on nonadvancing empty pages without publishing a tombstone', async () => {
  const { cosmos, jobs } = fixture()
  const { value } = await ready(jobs)
  await jobs.store.transitionLifecycle(workspaceId, jobId, value.etag, 'job', 'delete', timestamp)
  cosmos.queryPages(() => ({ resources: [], continuationToken: 'stuck-page' }))
  await assert.rejects(jobs.store.purgeJobRecords(workspaceId, jobId, timestamp), /pagination did not advance/)
  assert.equal(cosmos.records.get(`${workspaceId}/${jobId}`).recordType, 'job')
  assert.ok(cosmos.records.get(`${workspaceId}/${jobId}`).lifecycle.deletingAt)
  assert.equal([...cosmos.records.values()].filter(record => record.recordType === 'rubric-version').length, 1)
})

test('reconciliation follows empty pending-entity pages instead of starving durable deletions', async () => {
  const { cosmos, jobs } = fixture()
  const { value } = await ready(jobs)
  await jobs.store.transitionLifecycle(workspaceId, jobId, value.etag, 'rubric', 'delete', timestamp)
  injectEmptyCosmosPages(cosmos)
  const initial = await jobs.store.listLifecyclePending(workspaceId)
  assert.deepEqual(initial.jobs, [])
  assert.ok(initial.continuationToken)
  const participant = createJobLifecycleParticipant(jobs)
  await participant.resume(workspaceId, timestamp)
  assert.equal((await jobs.store.get(workspaceId, jobId)).record.job.rubricDeletedAt, timestamp)
  assert.deepEqual(await participant.pendingWorkspaces(20), [])
})

test('participant terminal deletion retries stay fenced without downgrading the deleted store marker', async () => {
  const { cosmos, jobs } = fixture()
  await ready(jobs)
  const participant = createJobLifecycleParticipant(jobs)
  await participant.setState(workspaceId, 'deleting', timestamp)
  await participant.cancel(workspaceId, timestamp)
  await participant.purge(workspaceId, timestamp)
  await participant.setState(workspaceId, 'deleted', timestamp)

  const terminal = structuredClone(cosmos.records.get(`${workspaceId}/job-workspace-lifecycle`))
  const retryTime = '2026-09-18T12:01:00.000Z'
  await participant.setState(workspaceId, 'deleting', retryTime)
  assert.deepEqual(cosmos.records.get(`${workspaceId}/job-workspace-lifecycle`), terminal)
  await assert.rejects(jobs.store.setWorkspaceLifecycle(workspaceId, 'deleting', retryTime), /cannot be restored/)
  assert.deepEqual(cosmos.records.get(`${workspaceId}/job-workspace-lifecycle`), terminal)

  await participant.cancel(workspaceId, retryTime)
  await participant.purge(workspaceId, retryTime)
  await participant.setState(workspaceId, 'deleted', retryTime)
  assert.equal((await jobs.store.getWorkspaceLifecycle(workspaceId)).state, 'deleted')
  assert.equal(await jobs.store.get(workspaceId, jobId), undefined)
  assert.deepEqual(await jobs.store.listRubrics(workspaceId, jobId), [])
  await assert.rejects(jobs.store.create(realJobRecord(workspaceId, `job-${randomUUID()}`)), /archived or removed/)
})
