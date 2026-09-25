import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { api, fixture, seedResume, seedJob, seedGrade, ACTOR, clone, sha } from './real-analyses.test-support.mjs'

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/** Wraps an async method so a test can see how many calls overlap; `delay` sets each call's latency. */
function trackConcurrency(target, method, delay = () => 2) {
  const original = target[method].bind(target)
  const stats = { active: 0, max: 0, calls: 0 }
  target[method] = async (...args) => {
    stats.calls++
    stats.active++
    stats.max = Math.max(stats.max, stats.active)
    try {
      await pause(delay(...args))
      return await original(...args)
    } finally { stats.active-- }
  }
  return stats
}
/** Counts control-only transactions, which are the writer reservations and releases. */
function trackControlWrites(f) {
  const transact = f.analysis.store.transact.bind(f.analysis.store)
  const stats = { count: 0 }
  f.analysis.store.transact = async (workspaceId, operations, options) => {
    if (!operations.length) stats.count++
    return transact(workspaceId, operations, options)
  }
  return stats
}
async function seedLibrary(f, resumeCount, targetCount) {
  const resumes = []
  for (let index = 0; index < resumeCount; index++) resumes.push(await seedResume(f, `Person Example ${index}`))
  const targets = []
  for (let index = 0; index < targetCount; index++) targets.push(await seedJob(f, `Role ${index}`))
  const request = { name: 'Batched library review', resumes: resumes.map(item => item.selection), targets: targets.map(item => item.selection) }
  return { resumes, targets, request }
}
const stored = (f, name) => JSON.parse(Buffer.from(f.analysis.blobs.values.get(name).bytes).toString())
/** Tracks how many different ladders have grade evidence being read at the same moment. */
function trackGradeReads(f) {
  const read = f.grades.blobs.read.bind(f.grades.blobs)
  const inFlight = new Map()
  const stats = { maxLadders: 0 }
  f.grades.blobs.read = async (name, signal) => {
    const ladder = name.split('/')[1]
    inFlight.set(ladder, (inFlight.get(ladder) ?? 0) + 1)
    stats.maxLadders = Math.max(stats.maxLadders, inFlight.size)
    try {
      await pause(3)
      return await read(name, signal)
    } finally {
      const left = inFlight.get(ladder) - 1
      if (left) inFlight.set(ladder, left)
      else inFlight.delete(ladder)
    }
  }
  return stats
}

test('bounded concurrency keeps order, never exceeds its limit and stops starting work after a failure', async () => {
  let active = 0
  let max = 0
  const results = await api.mapWithConcurrency([5, 1, 4, 2, 3], 2, async (value, index) => {
    active++
    max = Math.max(max, active)
    await pause(value)
    active--
    return value * 10 + index
  })
  assert.deepEqual(results, [50, 11, 42, 23, 34])
  assert.equal(max, 2)
  const started = []
  await assert.rejects(api.mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async value => {
    started.push(value)
    await pause(value === 0 ? 10 : 1)
    if (value < 2) throw new Error(`failed ${value}`)
    return value
  }), /failed 0/, 'Item 1 fails first, but item 0 has the lower index, as in a sequential scan')
  assert.deepEqual(started, [0, 1], 'No new item starts once a failure is known')
  assert.deepEqual(api.chunked([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.throws(() => api.chunked([1], 0), /positive integer/)
  await assert.rejects(api.mapWithConcurrency([1], 0, async value => value), /positive integer/)
})

test('target chunks keep request order with at most eight targets and two GS grades each', () => {
  const kinds = ['job', 'grade', 'grade', 'grade', ...Array(8).fill('job')]
  const chunks = api.analysisTargetChunks(kinds.map((kind, index) => ({ kind, index })))
  assert.deepEqual(chunks.map(chunk => chunk.map(item => item.index)), [[0, 1, 2], [3, 4, 5, 6, 7, 8, 9, 10], [11]])
  assert.deepEqual(api.analysisTargetChunks(Array(5).fill({ kind: 'grade' })).map(chunk => chunk.length), [2, 2, 1])
  assert.deepEqual(api.analysisTargetChunks(Array(17).fill({ kind: 'job' })).map(chunk => chunk.length), [8, 8, 1])
  assert.deepEqual(api.analysisTargetChunks([]), [])
})

test('GS grade targets resolve at most two at a time and keep their request positions', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const jobs = [await seedJob(f, 'Role 0'), await seedJob(f, 'Role 1')]
  const grades = []
  for (let index = 0; index < 3; index++) grades.push(await seedGrade(f, jobs[0]))
  const request = { name: 'Mixed targets', resumes: [resume.selection],
    targets: [jobs[0].selection, grades[0].selection, grades[1].selection, grades[2].selection, jobs[1].selection] }
  const creation = trackGradeReads(f)
  const created = await f.service.create(f.workspaceId, randomUUID(), request, ACTOR)
  assert.equal(created.run.progress.total, 5)
  assert.equal(creation.maxLadders, api.ANALYSIS_GRADE_CONCURRENCY, 'Two grades resolve together, never all three')
  const manifest = stored(f, created.run.manifest.blobName)
  assert.deepEqual(manifest.targets.map(item => item.summary.selection), request.targets)
  assert.deepEqual(manifest.targets.map(item => item.snapshotId),
    request.targets.map((_, index) => api.analysisDeterministicId('snapshot', created.run.id, `target:${index}`)))
  assert.deepEqual(manifest.targets.map(item => stored(f, item.blob.blobName).kind), request.targets.map(item => item.kind))

  const list = f.grades.store.list.bind(f.grades.store)
  f.grades.store.list = async (workspaceId, options) => {
    const items = []
    let token
    do {
      const page = await list(workspaceId, { ...options, continuationToken: token })
      items.push(...page.items)
      token = page.continuationToken
    } while (token)
    return { items }
  }
  const discovery = trackGradeReads(f)
  const page = await f.service.listTargets(f.workspaceId)
  assert.deepEqual(page.targets.filter(item => item.kind === 'grade').map(item => item.selection.ladderId).sort(),
    grades.map(item => item.selection.ladderId).sort())
  assert.equal(discovery.maxLadders, api.ANALYSIS_GRADE_CONCURRENCY, 'Discovery also resolves at most two grades at once')
})

test('parallel preparation freezes every source in request order with deterministic snapshot identities', async () => {
  const f = fixture()
  const { resumes, targets, request } = await seedLibrary(f, 19, 3)
  const reads = trackConcurrency(f.resumes.store, 'get')
  const key = randomUUID()
  const runId = `analysis-run-${key}`
  const created = await f.service.create(f.workspaceId, key, request, ACTOR)
  assert.equal(created.run.id, runId)
  assert.equal(created.run.progress.total, 57)
  assert.equal(reads.max, api.ANALYSIS_SOURCE_CONCURRENCY, 'Resumes resolve in parallel, at most eight at a time')
  assert.equal(reads.calls, 19 * 2, 'Each resume is frozen once and rechecked once after capture')
  const manifest = stored(f, created.run.manifest.blobName)
  assert.deepEqual(manifest.request, request)
  assert.deepEqual(manifest.resumes.map(item => item.snapshotId),
    resumes.map((_, index) => api.analysisDeterministicId('snapshot', runId, `resume:${index}`)))
  assert.deepEqual(manifest.targets.map(item => item.snapshotId),
    targets.map((_, index) => api.analysisDeterministicId('snapshot', runId, `target:${index}`)))
  assert.deepEqual(manifest.resumes.map(item => item.summary.selection), request.resumes)
  assert.deepEqual(manifest.resumes.map(item => item.summary.name), resumes.map(item => item.record.resume.name))
  assert.deepEqual(manifest.targets.map(item => item.summary.selection), request.targets)
  for (const reference of [...manifest.resumes, ...manifest.targets]) {
    const blob = f.analysis.blobs.values.get(reference.blob.blobName)
    assert.ok(blob, 'Every snapshot is saved before the manifest references it')
    assert.equal(sha(blob.bytes), reference.blob.sha256)
    assert.equal(reference.blob.blobName, `${f.workspaceId}/${runId}/snapshots/${reference.snapshotId}/${reference.blob.sha256}.json`)
    assert.equal(stored(f, reference.blob.blobName).snapshotId, reference.snapshotId)
  }
  assert.deepEqual(manifest.comparisons.map(item => [item.index, item.resumeSnapshotId, item.targetSnapshotId]),
    manifest.resumes.flatMap((resume, resumeIndex) => manifest.targets.map((target, targetIndex) =>
      [resumeIndex * manifest.targets.length + targetIndex, resume.snapshotId, target.snapshotId])))
})

test('snapshot and evidence copies share one writer reservation per batch and release every reservation', async () => {
  const f = fixture()
  const { request } = await seedLibrary(f, 20, 2)
  const writes = trackControlWrites(f)
  const created = await f.service.create(f.workspaceId, randomUUID(), request, ACTOR)
  // Three resume snapshot batches, one evidence batch, one target snapshot batch and the manifest each reserve and release once.
  assert.equal(writes.count, 2 * (3 + 1 + 1 + 1))
  const control = await f.analysis.store.getControl(f.workspaceId, created.run.id)
  assert.equal(control.record.writers, undefined, 'No writer reservation is left behind')
  const puts = f.analysis.blobs.events.filter(([kind]) => kind === 'put').map(([, name]) => name)
  // The seeded jobs share one PDF original, so both targets reference a single content-addressed evidence copy.
  assert.equal(puts.length, 20 + 1 + 2 + 1)
  assert.equal(new Set(puts).size, puts.length, 'Each immutable blob is written once')
})

test('a failed snapshot upload keeps only its own reservation, and the same request key completes the run', async () => {
  const f = fixture()
  const { request } = await seedLibrary(f, 10, 1)
  const key = randomUUID()
  const runId = `analysis-run-${key}`
  const failing = `/snapshots/${api.analysisDeterministicId('snapshot', runId, 'resume:3')}/`
  let failures = 0
  f.analysis.blobs._beforeFencedPut(async name => {
    if (name.includes(failing) && failures++ === 0) throw new Error('Upload interrupted')
  })
  await assert.rejects(f.service.create(f.workspaceId, key, request, ACTOR), /Upload interrupted/)
  assert.equal(await f.analysis.store.get(f.workspaceId, runId), undefined)
  assert.equal(f.analysis.blobs.values.has(`${f.workspaceId}/${runId}/manifest.json`), false)
  const writers = Object.values((await f.analysis.store.getControl(f.workspaceId, runId)).record.writers ?? {})
  assert.equal(writers.length, 1, 'Only the uncertain upload keeps its reservation until it drains')
  assert.ok(writers[0].blobName.includes(failing))
  const created = await f.service.create(f.workspaceId, key, request, ACTOR)
  assert.equal(created.run.id, runId)
  assert.equal(created.run.progress.total, 10)
})

test('a writer batch is bounded to its own run snapshots and evidence, and names each blob once', async () => {
  const f = fixture()
  const { request } = await seedLibrary(f, 1, 1)
  const created = await f.service.create(f.workspaceId, randomUUID(), request, ACTOR)
  const runId = created.run.id
  const write = name => ({ name, bytes: Buffer.from('{}'), contentType: 'application/json' })
  const evidence = `${f.workspaceId}/${runId}/evidence/${sha(Buffer.from('{}'))}.json`
  await assert.rejects(api.putFencedAnalysisBlobs(f.analysis, f.workspaceId, runId, [write(evidence), write(evidence)]), /name each blob once/)
  await assert.rejects(api.putFencedAnalysisBlobs(f.analysis, f.workspaceId, runId,
    Array.from({ length: api.ANALYSIS_BLOB_BATCH_LIMIT + 1 }, (_, index) => write(`${f.workspaceId}/${runId}/evidence/${sha(Buffer.from(`${index}`))}.json`))), /bounded/)
  await assert.rejects(api.putFencedAnalysisBlobs(f.analysis, f.workspaceId, runId, [write(`${f.workspaceId}/${runId}/manifest.json`)]), /writer scope/)
  const other = `analysis-run-${randomUUID()}`
  await assert.rejects(api.putFencedAnalysisBlobs(f.analysis, f.workspaceId, runId, [write(`${f.workspaceId}/${other}/evidence/${sha(Buffer.from('{}'))}.json`)]), /writer scope/)
  assert.deepEqual(await api.putFencedAnalysisBlobs(f.analysis, f.workspaceId, runId, []), [])
  const [saved] = await api.putFencedAnalysisBlobs(f.analysis, f.workspaceId, runId, [write(evidence)])
  assert.equal(saved.created, true)
  assert.equal((await f.analysis.store.getControl(f.workspaceId, runId)).record.writers, undefined)
})

test('two saved versions of one job share a single evidence copy', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const job = await seedJob(f)
  const newer = { ...clone(job.rubric), id: `rubric-${randomUUID()}`, version: 2, name: 'Saved newer rubric' }
  f.rubricValues.set(`${f.workspaceId}/${job.record.id}`, [job.rubric, newer])
  const second = { ...job.selection, rubricId: newer.id, rubricVersion: 2, rubricHash: api.analysisHash(newer) }
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Two versions of one job', resumes: [resume.selection], targets: [job.selection, second],
  }, ACTOR)
  const snapshots = stored(f, created.run.manifest.blobName).targets.map(item => stored(f, item.blob.blobName))
  assert.deepEqual(snapshots.map(item => item.rubric.version), [1, 2])
  assert.equal(snapshots[0].original.blobName, snapshots[1].original.blobName)
  assert.equal(f.analysis.blobs.events.filter(([kind, name]) => kind === 'put' && name === snapshots[0].original.blobName).length, 1)
})

test('parallel resolution still reports the failure a one-at-a-time scan would find first', async () => {
  const f = fixture()
  const { resumes, request } = await seedLibrary(f, 8, 1)
  f.resumeValues.delete(`${f.workspaceId}/${resumes[5].record.id}`)
  request.resumes[2] = { ...request.resumes[2], documentSha256: '0'.repeat(64) }
  // The stale selection at index 2 answers last, after the missing resume at index 5 has already failed.
  trackConcurrency(f.resumes.store, 'get', (_workspaceId, id) => id === resumes[2].record.id ? 20 : 1)
  await assert.rejects(f.service.create(f.workspaceId, randomUUID(), request, ACTOR),
    error => error.status === 409 && /stale/.test(error.message))
  assert.equal(f.analysis.store.values.size, 0)
  assert.equal([...f.analysis.blobs.values.keys()].some(name => name.endsWith('/manifest.json')), false)
})

test('target discovery resolves a page of jobs in parallel and returns every eligible version once', async () => {
  const f = fixture()
  const jobs = []
  for (let index = 0; index < 12; index++) jobs.push(await seedJob(f, `Role ${index}`))
  const list = f.jobs.store.list.bind(f.jobs.store)
  f.jobs.store.list = async (workspaceId, token) => {
    if (token) throw new Error('Every job is returned on one page')
    const all = []
    let next
    do {
      const page = await list(workspaceId, next)
      all.push(...page.jobs)
      next = page.continuationToken
    } while (next)
    return { jobs: all }
  }
  const reads = trackConcurrency(f.jobs.blobs, 'read')
  const page = await f.service.listTargets(f.workspaceId)
  assert.deepEqual(page.targets.map(item => item.selection.jobId).sort(), jobs.map(item => item.record.id).sort())
  assert.deepEqual(page.targets.map(item => item.id), page.targets.map(item => item.id).sort())
  assert.ok(reads.max > 2, 'Several jobs resolve at once')
  assert.ok(reads.max <= 2 * api.ANALYSIS_SOURCE_CONCURRENCY, 'At most eight jobs, each reading its document and original together')
})
