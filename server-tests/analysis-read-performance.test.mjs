import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { api, fixture, createRun, publishResult, startHttp, ACTOR, clone } from './real-analyses.test-support.mjs'
import { drainNarrativeRequest, runComparisons } from './real-analysis-narratives.test-support.mjs'

const candidate = id => ({ kind: 'candidate', subjectId: id })
const target = id => ({ kind: 'target', subjectId: id })
const readSubject = (f, runId, subject, signal) => f.service.summarySubject(f.workspaceId, runId, subject, signal)
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function publishNarrative(f, run, record, binding) {
  const kind = binding.kind
  const subjectId = kind === 'candidate' ? binding.comparisonId : binding.targetId
  const comparisonId = kind === 'candidate' ? subjectId : binding.comparisons[0].comparisonId
  const reference = { kind: 'overall', comparisonId }
  const output = kind === 'candidate' ? {
    text: 'The saved record describes engineering work. The assessment records supporting evidence. Human review remains necessary.',
    overview: 'The saved assessment describes engineering evidence.',
    claims: [
      ...[0, 1, 2].map(sentenceIndex => ({
        id: `text-${sentenceIndex}`, location: { field: 'text', sentenceIndex }, references: [reference],
      })),
      { id: 'overview', location: { field: 'overview', sentenceIndex: 0 }, references: [reference] },
    ],
  } : {
    paragraphs: ['The saved analysis records engineering evidence for human review.'],
    claims: [{ id: 'paragraph', location: { field: 'paragraphs', paragraphIndex: 0, sentenceIndex: 0 }, references: [reference] }],
  }
  const attemptId = randomUUID()
  const inputFingerprint = api.analysisHash(binding)
  const provenance = {
    model: 'saved-test-model', deployment: 'saved-test-deployment', promptVersion: 'legacy-v1', schemaVersion: 'legacy-v1',
    startedAt: f.now, completedAt: f.now, inputCharacters: 100,
  }
  const artifact = api.parseAnalysisNarrativeArtifact({
    schemaVersion: 1, dataKind: 'real', kind, binding, ...output, createdAt: f.now,
    generationId: record.generationId, requestId: record.requestId, inputFingerprint, humanReviewRequired: true,
    provenance: {
      attemptId, outputSha256: api.analysisHash(output), generation: provenance, correctionCount: 0,
      groundingReviews: [{ id: 'saved-review', outcome: 'supported', issues: [], inputFingerprint,
        outputSha256: api.analysisHash(output), provenance }],
    },
    ...(record.published ? { previousPublication: record.published } : {}),
  })
  const name = api.analysisNarrativeBlobName(f.workspaceId, run.id, kind, subjectId, record.generationId, attemptId)
  const blob = await api.putAnalysisJson(f.analysis.blobs, name, artifact)
  const ready = {
    ...record, status: 'ready', attemptId, attempts: 1, inputFingerprint, updatedAt: f.now,
    published: { blob, revision: blob.sha256, inputFingerprint, generationId: record.generationId, publishedAt: f.now },
  }
  delete ready.nextAttemptAt
  delete ready.waitingFor
  delete ready.lease
  delete ready.error
  f.analysis.store.save(ready)
  return ready
}

async function readyFixture(resumes = 1, targets = 1) {
  const f = fixture()
  const created = await createRun(f, resumes, targets), runId = created.run.id
  while ((await f.analysis.store.get(f.workspaceId, runId)).record.progress.initialized < resumes * targets) {
    await api.advanceAnalysisRun(f.analysis, f.workspaceId, runId, { now: () => new Date(f.now), maxChunks: 4 })
  }
  for (const pair of runComparisons(f, runId)) await publishResult(f, runId, pair.record.id, false, { scheduleNarratives: false })
  const run = (await f.analysis.store.get(f.workspaceId, runId)).record
  const identity = () => ({ requestId: randomUUID(), requestedAt: f.now, requestedBy: ACTOR, reason: 'missing' })
  for (const { record: pair } of runComparisons(f, runId)) {
    await publishNarrative(f, run, api.newCandidateNarrative(run, pair, identity()), api.candidateNarrativeBinding(run, pair))
  }
  const inventory = await api.readAnalysisNarrativeInventory(f.analysis, f.workspaceId, runId)
  for (const { target, binding } of inventory.targets) {
    await publishNarrative(f, run, api.newTargetNarrative(run, target, identity()), binding)
  }
  f.analysis.store.save(run)
  return { f, runId, pairs: runComparisons(f, runId) }
}

async function replaceCandidate(f, runId, pair) {
  const run = (await f.analysis.store.get(f.workspaceId, runId)).record
  const previous = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', runId, pair.id))
  const record = api.newCandidateNarrative(run, pair, {
    requestId: randomUUID(), requestedAt: f.now, requestedBy: ACTOR, reason: 'all',
  }, previous.record)
  const next = await publishNarrative(f, run, record, api.candidateNarrativeBinding(run, pair))
  f.analysis.store.save(run)
  return next
}

function observeReads(f) {
  const calls = { get: [], list: [], blobs: [], controls: [] }
  const store = f.analysis.store, blobs = f.analysis.blobs
  const original = { get: store.get, list: store.list, read: blobs.read, getControl: store.getControl }
  store.get = async (...args) => { calls.get.push(args[1]); return original.get(...args) }
  store.list = async (...args) => { calls.list.push(args[1]); return original.list(...args) }
  store.getControl = async (...args) => { calls.controls.push(args[1]); return original.getControl(...args) }
  blobs.read = async (...args) => { calls.blobs.push(args[0]); return original.read(...args) }
  return {
    calls,
    reset() { for (const callsOfKind of Object.values(calls)) callsOfKind.length = 0 },
    restore() { store.get = original.get; store.list = original.list; store.getControl = original.getControl; blobs.read = original.read },
  }
}

test('100 resumes / 500 comparisons use constant candidate reads, no comparison narrative fan-out, and four ordered full-summary readers', async t => {
  const { f, runId, pairs } = await readyFixture(100, 5)
  const baseline = await f.service.summaries(f.workspaceId, runId)
  assert.equal(baseline.ready, true)
  assert.equal(baseline.comparisons.length, 500)
  assert.equal(baseline.targets.length, 5)
  const saved = clone([...f.analysis.store.values]), batches = f.analysis.store.batches.length
  const observed = observeReads(f)
  t.after(() => observed.restore())
  const pair = pairs[0].record
  const ownId = api.analysisNarrativeId('candidate', runId, pair.id)
  const ownPublication = f.analysis.store.values.get(`${f.workspaceId}/${ownId}`).record.published.blob.blobName
  const detail = await f.service.comparisonDetail(f.workspaceId, runId, pair.id)
  assert.ok(detail.result && detail.resumeSnapshot.document && detail.targetSnapshot.document)
  assert.equal(detail.narrative, undefined)
  assert.deepEqual(observed.calls.list, [])
  assert.equal(observed.calls.get.filter(id => id.includes('narrative')).length, 0)
  assert.equal(observed.calls.blobs.filter(name => name.includes('/narratives/')).length, 0)
  assert.equal(observed.calls.blobs.length, 5, 'Only manifest, selected resume/target, original, and result are read.')

  observed.reset()
  const selected = await readSubject(f, runId, candidate(pair.id))
  assert.equal(selected.schemaVersion, 1)
  assert.equal(selected.dataKind, 'real')
  assert.equal(selected.workspaceId, f.workspaceId)
  assert.equal(selected.runId, runId)
  assert.equal(selected.subjectId, pair.id)
  assert.equal(selected.kind, 'candidate')
  assert.match(selected.revision, /^[a-f0-9]{64}$/)
  assert.equal(selected.etag, `"${selected.revision}"`)
  assert.deepEqual(selected.narrative, baseline.comparisons[0])
  assert.deepEqual(observed.calls.list, [], 'A candidate read must never enumerate any collection.')
  assert.deepEqual(observed.calls.get.filter(id => id.includes('narrative')), [ownId])
  assert.deepEqual(observed.calls.blobs, [`${f.workspaceId}/${runId}/manifest.json`, ownPublication])
  assert.equal(observed.calls.get.length, 6, 'One constant correction-head lookup selects the current assessment revision.')
  assert.equal(observed.calls.get.filter(id => id.startsWith('analysis-correction:')).length, 1)
  assert.equal(observed.calls.controls.length, 1)
  assert.doesNotMatch(JSON.stringify(selected), /blobName|provenance|"lease"|leaseOwner|requestedBy|processingSettings/)

  observed.reset()
  const overview = await readSubject(f, runId, target(pair.target.summary.id))
  assert.deepEqual(overview.narrative, baseline.targets.find(value => value.targetId === pair.target.summary.id))
  assert.equal(observed.calls.list.length, 3)
  assert.ok(observed.calls.list.filter(options => options.recordType !== 'analysis-correction')
    .every(options => options.targetId === pair.target.summary.id))
  assert.deepEqual(observed.calls.list.map(options => options.recordType), ['analysis-comparison', 'analysis-candidate-narrative', 'analysis-correction'])
  assert.ok(observed.calls.list.filter(options => options.recordType === 'analysis-correction')
    .every(options => options.runId === runId && options.targetId === undefined))
  assert.equal(observed.calls.blobs.length, 2)
  assert.ok(observed.calls.blobs[1].includes('/narratives/target/'))
  assert.equal(observed.calls.blobs.filter(name => name.includes('/narratives/candidate/')).length, 0)

  observed.restore()
  const read = f.analysis.blobs.read
  let active = 0, maximum = 0
  const started = [], completed = []
  f.analysis.blobs.read = async (name, signal) => {
    if (!/\/narratives\/(?:candidate|target)\//.test(name)) return read(name, signal)
    const index = started.length
    started.push(name)
    maximum = Math.max(maximum, ++active)
    try {
      await delay(index % 4 === 0 ? 8 : 1, undefined, { signal })
      completed.push(name)
      return await read(name, signal)
    } finally { active-- }
  }
  const startedAt = performance.now()
  const full = await f.service.summaries(f.workspaceId, runId)
  const elapsed = performance.now() - startedAt
  f.analysis.blobs.read = read
  assert.equal(maximum, 4)
  assert.equal(active, 0)
  assert.equal(started.length, 505)
  assert.notDeepEqual(completed, started, 'Delayed publications must exercise out-of-order completion.')
  assert.deepEqual(full, baseline, 'Output and report pins retain manifest order despite concurrent reads.')
  assert.ok(elapsed < 30_000, `Controlled large-run full read took ${elapsed} ms.`)
  assert.deepEqual([...f.analysis.store.values], saved)
  assert.equal(f.analysis.store.batches.length, batches)
  t.diagnostic(`Controlled 505-publication read: ${elapsed.toFixed(0)} ms; max concurrency ${maximum}.`)
})

test('candidate reads ignore missing unrelated publications and retain pending generations and prior text without repairing metadata', async () => {
  const { f, runId, pairs } = await readyFixture(2, 2)
  const subject = candidate(pairs[0].record.id)
  const before = await readSubject(f, runId, subject)
  const all = await f.service.summaries(f.workspaceId, runId)
  const request = await f.service.generateSummaries(f.workspaceId, runId, { mode: 'all' }, randomUUID(), all.etag, ACTOR)
  const unrelated = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', runId, pairs[1].record.id))
  f.analysis.blobs.values.delete(unrelated.record.published.blob.blobName)
  const observed = observeReads(f), saved = clone([...f.analysis.store.values])
  try {
    const pending = await readSubject(f, runId, subject)
    assert.equal(pending.narrative.status, 'queued')
    assert.notEqual(pending.narrative.generationId, before.narrative.generationId)
    assert.deepEqual(pending.narrative.published, before.narrative.published)
    assert.notEqual(pending.revision, before.revision)
    assert.deepEqual(pending.narrative, request.summaries.comparisons[0])
    assert.equal(observed.calls.list.length, 0)
    assert.equal(observed.calls.get.length, 7, 'Pending requests add just one receipt point read to the revision-aware point lookup.')
    assert.equal(observed.calls.blobs.length, 3, 'Only the manifest, bounded request plan, and own publication are downloaded.')
    assert.deepEqual([...f.analysis.store.values], saved)
    assert.ok((await f.service.comparisonDetail(f.workspaceId, runId, subject.subjectId)).result)
  } finally { observed.restore() }
  await assert.rejects(f.service.summaries(f.workspaceId, runId), /missing|digest/)
})

test('narrow reads distinguish uninitialized, unfinished and historical missing summaries without scheduling work', async () => {
  const f = fixture(), created = await createRun(f, 100)
  const runId = created.run.id
  const manifest = await api.readAnalysisManifest(f.analysis.blobs, created.run)
  const before = clone([...f.analysis.store.values])
  for (const pair of [manifest.comparisons[0], manifest.comparisons.at(-1)]) {
    const summary = await readSubject(f, runId, candidate(pair.id))
    assert.equal(summary.narrative.status, 'not-required')
    assert.equal(summary.narrative.comparisonStatus, 'queued')
    assert.equal(summary.narrative.published, null)
  }
  assert.equal((await readSubject(f, runId, target(manifest.targets[0].summary.id))).narrative.status, 'not-required')
  assert.deepEqual([...f.analysis.store.values], before)
  while ((await f.analysis.store.get(f.workspaceId, runId)).record.progress.initialized < 100) {
    await api.advanceAnalysisRun(f.analysis, f.workspaceId, runId, { now: () => new Date(f.now), maxChunks: 4 })
  }
  await publishResult(f, runId, manifest.comparisons[0].id, false, { scheduleNarratives: false })
  const current = clone([...f.analysis.store.values])
  const missing = await readSubject(f, runId, candidate(manifest.comparisons[0].id))
  assert.equal(missing.narrative.status, 'missing')
  assert.equal(missing.narrative.comparisonStatus, 'complete')
  assert.equal(missing.narrative.published, null)
  assert.deepEqual([...f.analysis.store.values], current)
})

test('subject revisions ignore independent target work and heartbeats but target currentness includes every selected candidate generation', async () => {
  const { f, runId, pairs } = await readyFixture(2, 2)
  const [first, other] = pairs
  const subject = candidate(first.record.id), overviewSubject = target(first.record.target.summary.id)
  const before = await readSubject(f, runId, subject), overview = await readSubject(f, runId, overviewSubject)
  await replaceCandidate(f, runId, other.record)
  assert.equal((await readSubject(f, runId, subject)).etag, before.etag)
  assert.equal((await readSubject(f, runId, overviewSubject)).etag, overview.etag)
  const run = await f.analysis.store.get(f.workspaceId, runId)
  f.analysis.store.save({ ...run.record, updatedAt: new Date(Date.parse(f.now) + 1).toISOString() })
  assert.equal((await readSubject(f, runId, subject)).etag, before.etag)
  await replaceCandidate(f, runId, pairs[2].record)
  const stale = await readSubject(f, runId, overviewSubject)
  assert.equal(stale.narrative.status, 'stale')
  assert.notEqual(stale.revision, overview.revision)
  assert.deepEqual(stale.narrative.published, overview.narrative.published)
  assert.equal((await readSubject(f, runId, subject)).etag, before.etag)
})

test('summary work health observes lease expiry without writes and excludes heartbeats from readiness and polling revisions', async t => {
  const { f, runId, pairs } = await readyFixture(1, 2)
  t.mock.timers.enable({ apis: ['Date'], now: new Date(f.now) })
  const run = (await f.analysis.store.get(f.workspaceId, runId)).record
  const pair = pairs[0].record
  const previous = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', runId, pair.id))
  const leased = {
    ...api.newCandidateNarrative(run, pair, { requestId: randomUUID(), requestedAt: f.now, requestedBy: ACTOR, reason: 'all' }, previous.record),
    status: 'running', attemptId: randomUUID(), attempts: 1,
    lease: { owner: 'private-worker-identity', heartbeatAt: f.now, expiresAt: new Date(Date.parse(f.now) + 90_000).toISOString() },
  }
  delete leased.nextAttemptAt
  f.analysis.store.save(leased)
  const subject = candidate(pair.id)
  const before = await readSubject(f, runId, subject)
  const scope = await f.service.summaries(f.workspaceId, runId)
  assert.equal(before.narrative.workHealth.state, 'running')
  assert.equal(before.narrative.workHealth.attempt, 1)
  assert.equal(before.narrative.workHealth.lastActivityAt, f.now)
  assert.deepEqual(before.narrative.workHealth.capturedSettings, { revision: 'legacy-v1', modelName: 'gpt-5-mini', reasoningEffort: 'low' })
  assert.doesNotMatch(JSON.stringify(before), /private-worker-identity|leaseOwner|processingSettings|retryBackoff/)

  t.mock.timers.tick(25_000)
  const heartbeat = new Date().toISOString()
  leased.updatedAt = heartbeat
  leased.lease = { ...leased.lease, heartbeatAt: heartbeat, expiresAt: new Date(Date.now() + 90_000).toISOString() }
  f.analysis.store.save(leased)
  const renewed = await readSubject(f, runId, subject)
  assert.equal(renewed.narrative.workHealth.state, 'running')
  assert.equal(renewed.narrative.workHealth.lastActivityAt, heartbeat)
  assert.equal(renewed.narrative.workHealth.leaseExpiresAt, leased.lease.expiresAt)
  assert.equal(renewed.revision, before.revision)
  assert.equal(renewed.etag, before.etag)
  assert.equal(renewed.workRevision, before.workRevision, 'Lease renewal is not a reason to refetch immutable content or reset poll backoff.')
  const renewedScope = await f.service.summaries(f.workspaceId, runId)
  assert.equal(renewedScope.workRevision, scope.workRevision)
  assert.equal(renewedScope.etag, scope.etag)
  assert.deepEqual(renewedScope.capture, scope.capture)

  const records = clone([...f.analysis.store.values]), blobs = clone([...f.analysis.blobs.values])
  t.mock.timers.tick(89_999)
  assert.equal((await readSubject(f, runId, subject)).narrative.workHealth.state, 'running')
  t.mock.timers.tick(1)
  const interrupted = await readSubject(f, runId, subject)
  assert.equal(interrupted.narrative.status, 'running', 'Health must not rewrite persisted status or publication readiness.')
  assert.equal(interrupted.narrative.workHealth.state, 'interrupted')
  assert.equal(interrupted.narrative.workHealth.nextEligibleAt, leased.lease.expiresAt)
  assert.notEqual(interrupted.workRevision, before.workRevision)
  assert.equal(interrupted.revision, before.revision)
  assert.equal(interrupted.etag, before.etag)
  assert.deepEqual(interrupted.narrative.published, before.narrative.published)
  const expiredScope = await f.service.summaries(f.workspaceId, runId)
  assert.notEqual(expiredScope.workRevision, scope.workRevision)
  assert.equal(expiredScope.etag, scope.etag)
  assert.deepEqual(expiredScope.capture, scope.capture)
  assert.equal(expiredScope.targets[1].status, 'ready')
  assert.deepEqual([...f.analysis.store.values], records)
  assert.deepEqual([...f.analysis.blobs.values], blobs)
  const legacy = { ...leased }
  delete legacy.processingSettings
  f.analysis.store.save(legacy)
  const legacyResponse = await readSubject(f, runId, subject)
  assert.deepEqual(legacyResponse.narrative.workHealth.capturedSettings, { revision: 'legacy-v1', modelName: null, reasoningEffort: null })
  assert.equal(legacyResponse.etag, before.etag)
})

test('summary work health distinguishes provider cooldown, future retry, due queue and terminal failure without treating age as an outage', async t => {
  const { f, runId, pairs } = await readyFixture(1, 3)
  t.mock.timers.enable({ apis: ['Date'], now: new Date(f.now) })
  const run = (await f.analysis.store.get(f.workspaceId, runId)).record
  const retryAt = new Date(Date.now() + 120_000).toISOString()
  const pending = pairs.map(({ record: pair }, index) => {
    const record = api.newCandidateNarrative(run, pair, { requestId: randomUUID(), requestedAt: f.now, requestedBy: ACTOR, reason: 'all' })
    return { ...record, attempts: 1, attemptId: randomUUID(), nextAttemptAt: retryAt,
      error: { code: 'service-unavailable', stage: 'candidate-generation', message: 'The summary provider asked for a later retry.', retryable: true,
        ...(index === 0 ? { diagnostic: { httpStatus: 429, retryAt } } : {}) } }
  })
  for (const item of pending) f.analysis.store.save(item)
  const first = await f.service.summaries(f.workspaceId, runId)
  assert.deepEqual(first.comparisons.map(item => item.workHealth.state), ['throttled', 'retry-scheduled', 'retry-scheduled'])
  assert.equal(first.comparisons[0].workHealth.nextEligibleAt, retryAt)
  const records = clone([...f.analysis.store.values])
  t.mock.timers.tick(120_000)
  const due = await f.service.summaries(f.workspaceId, runId)
  assert.ok(due.comparisons.every(item => item.workHealth.state === 'awaiting-worker'))
  assert.equal(due.comparisons[0].error.diagnostic.httpStatus, 429, 'A previous provider error is context, not a terminal queued state.')
  assert.equal(due.etag, first.etag)
  assert.deepEqual(due.capture, first.capture)
  assert.notEqual(due.workRevision, first.workRevision)
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000)
  const old = await f.service.summaries(f.workspaceId, runId)
  assert.ok(old.comparisons.every(item => item.workHealth.state === 'awaiting-worker'))
  assert.equal(old.workRevision, due.workRevision)
  assert.deepEqual([...f.analysis.store.values], records)
  const failed = { ...pending[2], status: 'failed', error: { ...pending[2].error, retryable: false } }
  delete failed.nextAttemptAt
  f.analysis.store.save(failed)
  const terminal = await readSubject(f, runId, candidate(pairs[2].record.id))
  assert.equal(terminal.narrative.workHealth.state, 'failed')
  assert.equal(terminal.narrative.workHealth.nextEligibleAt, null)
})

test('summary work health identifies actual prerequisite waits and an eligible target still waiting for worker promotion', async t => {
  const { f, runId, pairs } = await readyFixture()
  t.mock.timers.enable({ apis: ['Date'], now: new Date(f.now) })
  const run = (await f.analysis.store.get(f.workspaceId, runId)).record
  const pair = pairs[0].record
  const original = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', runId, pair.id))
  const inventory = await api.readAnalysisNarrativeInventory(f.analysis, f.workspaceId, runId)
  const waiting = api.newTargetNarrative(run, inventory.targets[0].target,
    { requestId: randomUUID(), requestedAt: f.now, requestedBy: ACTOR, reason: 'all' })
  f.analysis.store.save(waiting)
  f.analysis.store.save(api.newCandidateNarrative(run, pair,
    { requestId: randomUUID(), requestedAt: f.now, requestedBy: ACTOR, reason: 'all' }, original.record))
  const pending = await readSubject(f, runId, target(waiting.targetId))
  assert.equal(pending.narrative.status, 'waiting')
  assert.equal(pending.narrative.workHealth.state, 'waiting-prerequisites')
  assert.equal(pending.narrative.waitingFor, 'candidate-narratives')
  assert.equal(pending.narrative.workHealth.nextEligibleAt, null)
  f.analysis.store.save(original.record)
  const eligible = await readSubject(f, runId, target(waiting.targetId))
  assert.equal(eligible.narrative.status, 'waiting')
  assert.equal(eligible.narrative.waitingFor, null)
  assert.equal(eligible.narrative.workHealth.state, 'awaiting-worker')
  assert.equal(eligible.narrative.workHealth.nextEligibleAt, f.now)
  const other = await createRun(f, 2)
  const comparisons = runComparisons(f, other.run.id)
  await publishResult(f, other.run.id, comparisons[0].record.id)
  const scoring = await f.service.summaries(f.workspaceId, other.run.id)
  assert.equal(scoring.targets[0].waitingFor, 'scoring')
  assert.equal(scoring.targets[0].workHealth.state, 'waiting-prerequisites')
})

test('summary work health reproduces 412 ready candidates and two ready, one queued, one interrupted overview without readiness churn', async t => {
  const { f, runId } = await readyFixture(103, 4)
  t.mock.timers.enable({ apis: ['Date'], now: new Date(f.now) })
  const inventory = await api.readAnalysisNarrativeInventory(f.analysis, f.workspaceId, runId)
  const ready = await f.service.summaries(f.workspaceId, runId)
  const { run } = inventory
  for (const [index, item] of inventory.targets.entries()) {
    if (index < 2) continue
    const next = { ...api.newTargetNarrative(run.record, item.target,
      { requestId: randomUUID(), requestedAt: f.now, requestedBy: ACTOR, reason: 'all' }),
      status: index === 2 ? 'queued' : 'running', inputFingerprint: api.analysisHash(item.binding) }
    delete next.waitingFor
    if (index === 3) {
      next.attemptId = randomUUID()
      next.attempts = 1
      next.lease = { owner: 'abandoned-worker', heartbeatAt: f.now, expiresAt: new Date(Date.now() + 90_000).toISOString() }
      delete next.nextAttemptAt
    }
    f.analysis.store.save(next)
  }
  const active = await f.service.summaries(f.workspaceId, runId)
  const records = clone([...f.analysis.store.values]), blobs = clone([...f.analysis.blobs.values])
  t.mock.timers.tick(3_600_000)
  const screenshot = await f.service.summaries(f.workspaceId, runId)
  assert.equal(screenshot.counts.candidates.total, 412)
  assert.equal(screenshot.counts.candidates.ready, 412)
  assert.equal(screenshot.counts.targets.total, 4)
  assert.equal(screenshot.counts.targets.ready, 2)
  assert.equal(screenshot.counts.targets.queued, 1)
  assert.equal(screenshot.counts.targets.running, 1)
  assert.deepEqual(screenshot.targets.map(item => item.workHealth.state), ['inactive', 'inactive', 'awaiting-worker', 'interrupted'])
  assert.equal(screenshot.ready, false)
  assert.equal(screenshot.etag, active.etag)
  assert.deepEqual(screenshot.capture, active.capture)
  assert.notEqual(screenshot.workRevision, active.workRevision)
  assert.deepEqual(screenshot.comparisons.map(item => item.published), ready.comparisons.map(item => item.published))
  assert.deepEqual(screenshot.targets.slice(0, 2).map(item => item.published), ready.targets.slice(0, 2).map(item => item.published))
  assert.deepEqual([...f.analysis.store.values], records)
  assert.deepEqual([...f.analysis.blobs.values], blobs)
})

test('a coordinator finishing between root and receipt reads retries the run fence without accepting partial desired generations', async () => {
  const { f, runId, pairs } = await readyFixture()
  const before = await f.service.summaries(f.workspaceId, runId)
  const request = await f.service.generateSummaries(f.workspaceId, runId, { mode: 'all' }, randomUUID(), before.etag, ACTOR)
  const receiptId = api.analysisNarrativeId('request', runId, request.requestId)
  const get = f.analysis.store.get
  let raced = false
  f.analysis.store.get = async (...args) => {
    if (args[1] === receiptId && !raced) {
      raced = true
      await drainNarrativeRequest(f, runId, request.requestId)
    }
    return get(...args)
  }
  const subject = await readSubject(f, runId, candidate(pairs[0].record.id))
  assert.equal(raced, true)
  assert.equal(subject.narrative.status, 'queued')
  assert.equal(subject.narrative.generationId, request.summaries.comparisons[0].generationId)
  assert.deepEqual(subject.narrative.published, before.comparisons[0].published)
  assert.equal((await get(f.workspaceId, receiptId)).record.status, 'complete')
})

test('publication races recapture the exact subject and exhaust repeated changes explicitly instead of returning old text as current', async () => {
  const { f, runId, pairs } = await readyFixture()
  const subject = candidate(pairs[0].record.id)
  const before = await readSubject(f, runId, subject), read = f.analysis.blobs.read
  let next, raced = false
  const downloaded = []
  f.analysis.blobs.read = async (name, signal) => {
    downloaded.push(name)
    const blob = await read(name, signal)
    if (name.includes('/narratives/candidate/') && !raced) {
      raced = true
      next = await replaceCandidate(f, runId, pairs[0].record)
    }
    return blob
  }
  const after = await readSubject(f, runId, subject)
  assert.notEqual(after.revision, before.revision)
  assert.equal(after.narrative.status, 'ready')
  assert.equal(after.narrative.published.revision, next.published.revision)
  assert.equal(downloaded.filter(name => name.endsWith('/manifest.json')).length, 1, 'Immutable inputs are reused only inside this request.')
  assert.equal(downloaded.filter(name => name.includes('/narratives/candidate/')).length, 2)

  let races = 0
  f.analysis.blobs.read = async (name, signal) => {
    const blob = await read(name, signal)
    if (name.includes('/narratives/candidate/')) { races++; await replaceCandidate(f, runId, pairs[0].record) }
    return blob
  }
  await assert.rejects(readSubject(f, runId, subject), { status: 409 })
  assert.equal(races, 4)
  f.analysis.blobs.read = read
  assert.equal((await readSubject(f, runId, subject)).narrative.status, 'ready')
})

test('narrow reads preserve archive cancellation, reject deletion races and fail closed on corrupt own evidence', async () => {
  const { f, runId, pairs } = await readyFixture()
  const subject = candidate(pairs[0].record.id)
  const all = await f.service.summaries(f.workspaceId, runId)
  await f.service.generateSummaries(f.workspaceId, runId, { mode: 'all' }, randomUUID(), all.etag, ACTOR)
  const lifecycle = new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(f.now))
  let run = await f.analysis.store.get(f.workspaceId, runId)
  await lifecycle.change(f.workspaceId, runId, 'archive', run.etag, ACTOR)
  const archived = await readSubject(f, runId, subject)
  assert.equal(archived.narrative.status, 'cancelled')
  assert.deepEqual(archived.narrative.published, all.comparisons[0].published)
  const archivedTarget = await readSubject(f, runId, target(all.targets[0].targetId))
  assert.equal(archivedTarget.narrative.status, 'cancelled')
  assert.deepEqual(archivedTarget.narrative.published, all.targets[0].published)
  assert.ok((await f.service.comparisonDetail(f.workspaceId, runId, subject.subjectId)).result)
  const record = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', runId, subject.subjectId))
  const name = record.record.published.blob.blobName, blob = clone(f.analysis.blobs.values.get(name))
  f.analysis.blobs.values.delete(name)
  await assert.rejects(readSubject(f, runId, subject), /missing|digest/)
  f.analysis.blobs.values.set(name, clone(blob))
  f.analysis.blobs.values.get(name).bytes[0] ^= 1
  await assert.rejects(readSubject(f, runId, subject), /digest/)
  assert.ok((await f.service.comparisonDetail(f.workspaceId, runId, subject.subjectId)).result,
    'Even corruption of this comparison publication must not hide valid frozen evidence.')
  f.analysis.blobs.values.set(name, blob)
  f.analysis.store.values.get(`${f.workspaceId}/${record.record.id}`).record.resultSha256 = '0'.repeat(64)
  await assert.rejects(readSubject(f, runId, subject), /input|binding|comparison|fingerprint/i)
  f.analysis.store.save(record.record)
  const read = f.analysis.blobs.read
  let raced = false
  f.analysis.blobs.read = async (...args) => {
    const value = await read(...args)
    if (args[0] === name && !raced) {
      raced = true
      run = await f.analysis.store.get(f.workspaceId, runId)
      await lifecycle.change(f.workspaceId, runId, 'delete', run.etag, ACTOR)
    }
    return value
  }
  await assert.rejects(readSubject(f, runId, subject), { status: 404 })
  assert.equal(raced, true)
  await assert.rejects(readSubject(f, runId, subject), { status: 404 })
  await assert.rejects(f.service.comparisonDetail(f.workspaceId, runId, subject.subjectId), { status: 404 })
})

test('full summary capture retries changed publications and never accepts old report pins as the new revision', async () => {
  const { f, runId, pairs } = await readyFixture(3)
  const before = await f.service.summaries(f.workspaceId, runId), read = f.analysis.blobs.read
  let replacement, raced = false
  f.analysis.blobs.read = async (name, signal) => {
    const value = await read(name, signal)
    if (name.includes(`/candidate/${pairs[0].record.id}/`) && !raced) {
      raced = true
      replacement = await replaceCandidate(f, runId, pairs[0].record)
    }
    return value
  }
  const after = await f.service.summaries(f.workspaceId, runId)
  assert.notEqual(after.revision, before.revision)
  assert.equal(after.comparisons[0].published.revision, replacement.published.revision)
  assert.equal(after.capture.comparisons[0].narrative.revision, replacement.published.revision)
  assert.equal(after.ready, false)
  assert.equal(after.targets[0].status, 'stale')
  assert.equal(after.capture.targets[0].narrative, null)
  assert.deepEqual(after.targets[0].published, before.targets[0].published)
})

test('comparison evidence is not returned when the run or workspace is deleted during its immutable read', async () => {
  for (const scope of ['run', 'workspace']) {
    const { f, runId, pairs } = await readyFixture()
    const read = f.analysis.blobs.read
    let raced = false
    f.analysis.blobs.read = async (...args) => {
      const value = await read(...args)
      if (args[0] === pairs[0].record.result.blobName && !raced) {
        raced = true
        if (scope === 'run') {
          const run = await f.analysis.store.get(f.workspaceId, runId)
          await new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(f.now))
            .change(f.workspaceId, runId, 'delete', run.etag, ACTOR)
        } else {
          await api.createAnalysisLifecycleParticipant(f.analysis).setState(f.workspaceId, 'deleting', f.now)
        }
      }
      return value
    }
    await assert.rejects(f.service.comparisonDetail(f.workspaceId, runId, pairs[0].record.id), { status: 404 })
    assert.equal(raced, true)
  }
})

test('full publication pool stops new work on cancellation or failure and never returns partial summaries', async () => {
  const { f, runId } = await readyFixture(9)
  const read = f.analysis.blobs.read
  for (const failure of ['cancel', 'storage']) {
    const started = deferred(), controller = new AbortController(), releases = []
    let calls = 0, active = 0, aborted = 0
    f.analysis.blobs.read = async (name, signal) => {
      if (!name.includes('/narratives/candidate/')) return read(name, signal)
      calls++; active++
      if (calls === 4) started.resolve()
      try {
        return await new Promise((_resolve, reject) => {
          const abort = () => { aborted++; reject(signal.reason) }
          signal.addEventListener('abort', abort, { once: true })
          releases.push(() => {
            signal.removeEventListener('abort', abort)
            reject(new Error('Controlled publication failure'))
          })
        })
      } finally { active-- }
    }
    const pending = f.service.summaries(f.workspaceId, runId, undefined, controller.signal)
    const rejected = assert.rejects(pending, failure === 'cancel' ? { name: 'AbortError' } : /Controlled publication failure/)
    await started.promise
    if (failure === 'cancel') controller.abort()
    else releases[0]()
    await rejected
    await nextTurn()
    assert.equal(calls, 4, 'No fifth immutable publication is scheduled after the first failure or disconnect.')
    assert.equal(active, 0)
    assert.equal(aborted, failure === 'cancel' ? 4 : 3)
  }
  f.analysis.blobs.read = read
  assert.equal((await f.service.summaries(f.workspaceId, runId)).ready, true)
})

test('candidate and core reads carry cancellation into metadata and blobs, including expired deadlines', async () => {
  const { f, runId, pairs } = await readyFixture()
  const subject = candidate(pairs[0].record.id)
  for (const action of [
    signal => f.service.comparisonDetail(f.workspaceId, runId, subject.subjectId, signal),
    signal => readSubject(f, runId, subject, signal),
    signal => f.service.summaries(f.workspaceId, runId, undefined, signal),
  ]) {
    const expired = AbortSignal.abort(new DOMException('Controlled deadline', 'TimeoutError'))
    const observed = observeReads(f)
    await assert.rejects(action(expired), { name: 'TimeoutError' })
    assert.equal(observed.calls.get.length + observed.calls.list.length + observed.calls.blobs.length, 0)
    observed.restore()
    const controller = new AbortController(), read = f.analysis.blobs.read
    let reads = 0
    f.analysis.blobs.read = async (name, signal) => {
      assert.equal(signal, controller.signal)
      reads++
      controller.abort()
      return read(name)
    }
    await assert.rejects(action(controller.signal), { name: 'AbortError' })
    assert.equal(reads, 1)
    f.analysis.blobs.read = read
  }
})

test('subject HTTP reads authorize viewers, expose exact ETags, reject invalid scope, and remain read-only', async () => {
  const { f, runId, pairs } = await readyFixture()
  const http = await startHttp(f)
  const suffix = `/${runId}/summaries/candidate/${pairs[0].record.id}`
  const before = clone([...f.analysis.store.values]), blobs = clone([...f.analysis.blobs.values])
  try {
    const response = await http.request(suffix, 'GET', undefined, { role: 'viewer' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const summary = await response.json()
    assert.equal(response.headers.get('etag'), summary.etag)
    assert.deepEqual(summary, await readSubject(f, runId, candidate(pairs[0].record.id)))
    assert.equal((await http.request(suffix, 'GET', undefined, { noAuth: true })).status, 401)
    assert.equal((await http.request(suffix, 'GET', undefined, { role: 'stranger' })).status, 404)
    assert.equal((await http.request(`${suffix}?targetId=anything`)).status, 400)
    assert.equal((await http.request(suffix.replace('/candidate/', '/invalid/'))).status, 404)
    assert.equal((await http.request(suffix.replace(pairs[0].record.id, `analysis-comparison-${randomUUID()}`))).status, 404)
    assert.equal((await http.request(`/${runId}/summaries/target/${pairs[0].record.target.summary.id}`)).status, 200)
    assert.equal(f.mutationLeases.acquired, 0)
    assert.deepEqual([...f.analysis.store.values], before)
    assert.deepEqual([...f.analysis.blobs.values], blobs)
  } finally { await http.close() }
})

test('HTTP disconnects abort core, full-scope, and narrow storage reads without cancelling durable work', async () => {
  const { f, runId, pairs } = await readyFixture()
  const http = await startHttp(f), read = f.analysis.blobs.read
  const { resumeSnapshot } = await f.service.comparisonDetail(f.workspaceId, runId, pairs[0].record.id)
  const before = clone([...f.analysis.store.values])
  try {
    for (const suffix of [
      `/${runId}/comparisons/${pairs[0].record.id}`,
      `/${runId}/comparisons`,
      `/${runId}/comparisons/${pairs[0].record.id}/documents/${resumeSnapshot.document.id}?version=${resumeSnapshot.document.version}`,
      `/${runId}/summaries`,
      `/${runId}/summaries/candidate/${pairs[0].record.id}`,
      `/${runId}/summaries/target/${pairs[0].record.target.summary.id}`,
    ]) {
      const started = deferred(), aborted = deferred(), controller = new AbortController()
      let reads = 0
      f.analysis.blobs.read = async (_name, signal) => {
        assert.ok(signal)
        reads++
        started.resolve()
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          aborted.resolve()
          reject(signal.reason)
        }, { once: true }))
      }
      const request = http.request(suffix, 'GET', undefined, { signal: controller.signal })
      const rejected = assert.rejects(request, { name: 'AbortError' })
      await started.promise
      controller.abort()
      await rejected
      await aborted.promise
      await nextTurn()
      assert.equal(reads, 1)
    }
    assert.deepEqual([...f.analysis.store.values], before)
  } finally { f.analysis.blobs.read = read; await http.close() }
})

test('HTTP read deadlines remain 30 seconds and abort storage with an explicit safe timeout response', async t => {
  const { f, runId, pairs } = await readyFixture()
  const http = await startHttp(f), read = f.analysis.blobs.read
  const before = clone([...f.analysis.store.values]), deadlines = [], reasons = []
  const schedule = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === 30_000) {
      deadlines.push(milliseconds)
      return schedule(callback, 10, ...args)
    }
    return schedule(callback, milliseconds, ...args)
  })
  f.analysis.blobs.read = async (_name, signal) => {
    signal.throwIfAborted()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      reasons.push(signal.reason.name)
      reject(signal.reason)
    }, { once: true }))
  }
  try {
    for (const suffix of [
      `/${runId}/comparisons/${pairs[0].record.id}`,
      `/${runId}/summaries`,
      `/${runId}/summaries/candidate/${pairs[0].record.id}`,
      `/${runId}/summaries/target/${pairs[0].record.target.summary.id}`,
    ]) {
      const response = await http.request(suffix)
      assert.equal(response.status, 503)
      const body = await response.json()
      assert.equal(body.error.code, 'unavailable')
      assert.match(body.error.message, /timed out/i)
      assert.doesNotMatch(body.error.message, /workspace-one|analysis-run-|blob|private/i)
    }
    assert.equal(deadlines.length, 4)
    assert.deepEqual(reasons, Array(4).fill('TimeoutError'))
    assert.deepEqual([...f.analysis.store.values], before)
    assert.equal(f.mutationLeases.acquired, 0)
  } finally { f.analysis.blobs.read = read; await http.close() }
})

test('immutable read caches are request-owned, byte-bounded, and do not suppress per-reference hash validation', async () => {
  const { f, runId } = await readyFixture()
  const run = await f.analysis.store.get(f.workspaceId, runId)
  const observed = observeReads(f)
  try {
    const first = api.createAnalysisImmutableBlobReader(f.analysis.blobs)
    await api.readAnalysisBlob(first, run.record.manifest, f.workspaceId, runId)
    await api.readAnalysisBlob(first, run.record.manifest, f.workspaceId, runId)
    assert.equal(observed.calls.blobs.length, 1)
    await assert.rejects(api.readAnalysisBlob(first, { ...run.record.manifest, sha256: '0'.repeat(64) }, f.workspaceId, runId), /digest/)
    assert.equal(observed.calls.blobs.length, 1)
    await api.readAnalysisBlob(api.createAnalysisImmutableBlobReader(f.analysis.blobs), run.record.manifest, f.workspaceId, runId)
    assert.equal(observed.calls.blobs.length, 2)
  } finally { observed.restore() }
  const calls = []
  const large = new Uint8Array(api.MAX_ANALYSIS_JSON_BYTES)
  const reader = api.createAnalysisImmutableBlobReader({
    async read(name) {
      calls.push(name)
      return { bytes: name === 'large' ? large : new Uint8Array([1]), contentType: 'application/json', sha256: '0'.repeat(64), etag: '"blob"' }
    },
  })
  await reader.read('large')
  await reader.read('small')
  await reader.read('large')
  await reader.read('small')
  assert.deepEqual(calls, ['large', 'small', 'small'], 'The cache must not retain bytes above the existing single-JSON budget.')
  const names = []
  const entries = api.createAnalysisImmutableBlobReader({
    async read(name) {
      names.push(name)
      return { bytes: new Uint8Array([1]), contentType: 'application/json', sha256: '0'.repeat(64), etag: '"blob"' }
    },
  })
  await Promise.all(Array.from({ length: 20 }, (_, index) => entries.read(`${index}`)))
  await entries.read('0')
  await entries.read('19')
  assert.equal(names.filter(name => name === '0').length, 1)
  assert.equal(names.filter(name => name === '19').length, 2, 'Small immutable responses cannot exceed the entry-count bound either.')
})
