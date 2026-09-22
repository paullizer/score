import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { api, fixture, createRun, publishResult, ACTOR, clone } from '../server-tests/real-analyses.test-support.mjs'
import {
  drainNarrativeRequest, narrativeRuntime, narrativeWorker, runComparisons, settleNarratives,
} from '../server-tests/real-analysis-narratives.test-support.mjs'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsSnapshot } from './runtime-settings-test-support.mjs'

const { runAnalysisWorker, processClaimedNarrative } = await narrativeRuntime()
async function summaries(f, runId, targetId) { return api.readAnalysisSummaries(f.analysis, f.workspaceId, runId, targetId) }
async function assertPublishedSettings(f, id, expected) {
  const { record } = await f.analysis.store.get(f.workspaceId, id)
  assert.deepEqual(record.processingSettings, expected)
  const blob = await f.analysis.blobs.read(record.published.blob.blobName)
  assert.ok(blob)
  assert.deepEqual(JSON.parse(Buffer.from(blob.bytes).toString('utf8')).processingSettings, expected)
}
async function generate(f, runId, mode = 'missing', targetId) {
  const before = await summaries(f, runId, targetId)
  return f.service.generateSummaries(f.workspaceId, runId, { mode, ...(targetId ? { targetId } : {}) },
    randomUUID(), before.etag, ACTOR)
}
async function until(predicate) {
  for (let turn = 0; turn < 300; turn++) {
    if (await predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Expected bounded asynchronous narrative progress')
}

async function summaryRetryFixture({ attempts = 3, transportAttempts = 1 } = {}) {
  const f = fixture()
  const accepted = settingsSnapshot(settings => {
    settings.processing.analyses.maxAutomaticAttempts = attempts
    settings.ai.transport.maxAttempts = transportAttempts
  }, 'accepted-summary-retry-policy')
  f.service = new api.RealAnalysisService(f.analysis, { resumes: f.resumes, jobs: f.jobs, grades: f.grades },
    () => new Date(f.now), async () => accepted)
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const id = api.analysisNarrativeId('candidate', created.run.id, pair.record.id)
  return { f, accepted, created, pair, id }
}

test('provider cooldown scheduling persists the maximum of captured backoff and provider not-before', async () => {
  for (const seconds of [10, 300]) {
    const { f, accepted, created, id } = await summaryRetryFixture()
    const scoring = clone(runComparisons(f, created.run.id))
    const retryAt = new Date(Date.parse(f.now) + seconds * 1_000).toISOString()
    const first = narrativeWorker(f, ({ kind }) => kind === 'analysis_narrative_grounding_review'
      ? new Response('PRIVATE-PROVIDER', { status: 429, headers: { 'Retry-After': String(seconds) } }) : undefined)
    await runAnalysisWorker(first.deps, { maxItems: 1 })
    const queued = (await f.analysis.store.get(f.workspaceId, id)).record
    assert.equal(queued.status, 'queued')
    assert.equal(queued.attempts, 1)
    assert.equal(queued.summaryRound, 1)
    assert.equal(queued.error.code, 'service-unavailable')
    assert.equal(queued.error.diagnostic.httpStatus, 429)
    assert.equal(queued.error.diagnostic.retryAt, retryAt)
    assert.equal(Date.parse(queued.nextAttemptAt), Math.max(
      Date.parse(queued.updatedAt) + accepted.settings.processing.analyses.retryBackoff.baseMilliseconds,
      Date.parse(retryAt),
    ))
    const history = JSON.parse(Buffer.from((await f.analysis.blobs.read(queued.history.blob.blobName)).bytes).toString())
    assert.equal(history.phase, 'failed')
    assert.ok(history.draft)
    assert.equal(history.error.diagnostic.httpStatus, 429)
    assert.equal(history.error.diagnostic.retryAt, retryAt)
    assert.deepEqual(queued.processingSettings, accepted)
    const outcome = first.events.find(event => event.event === 'narrative-outcome')
    assert.equal(outcome.outcome, 'queued')
    assert.equal(outcome.httpStatus, 429)
    assert.equal(outcome.retryAt, retryAt)
    assert.doesNotMatch(JSON.stringify(first.events), /PRIVATE-PROVIDER/)
    const resumed = narrativeWorker(f)
    await runAnalysisWorker(resumed.deps, { maxItems: 1 })
    assert.equal(resumed.calls.length, 0)
    assert.equal((await f.analysis.store.get(f.workspaceId, id)).record.attempts, 1)
    f.now = queued.nextAttemptAt
    await runAnalysisWorker(resumed.deps, { maxItems: 1 })
    const ready = (await f.analysis.store.get(f.workspaceId, id)).record
    assert.equal(ready.status, 'ready')
    assert.equal(ready.attempts, 2)
    assert.deepEqual(resumed.calls.map(call => call.kind), ['analysis_narrative_grounding_review'])
    assert.deepEqual(ready.processingSettings, accepted)
    assert.deepEqual(runComparisons(f, created.run.id), scoring)
  }
})

test('provider throttle exhaustion is terminal at the captured attempt limit and retains actionable metadata', async () => {
  const { f, accepted, created, id } = await summaryRetryFixture({ attempts: 2, transportAttempts: 2 })
  const scoring = clone(runComparisons(f, created.run.id))
  const mock = narrativeWorker(f, ({ kind }) => kind === 'analysis_narrative_grounding_review'
    ? new Response('PRIVATE-PROVIDER', { status: 429, headers: { 'x-ms-retry-after-ms': '300000' } }) : undefined)
  mock.deps.model.processingSettings = settingsSnapshot(settings => {
    settings.processing.analyses.maxAutomaticAttempts = 3
    for (const deployment of settings.ai.deployments) deployment.deploymentName = `new-${deployment.id}`
  }, 'new-policy-must-not-rebind')
  let generatedHash
  for (let attempt = 1; attempt <= 2; attempt++) {
    await runAnalysisWorker(mock.deps, { maxItems: 1 })
    const record = (await f.analysis.store.get(f.workspaceId, id)).record
    assert.equal(record.attempts, attempt)
    assert.equal(record.status, attempt === 1 ? 'queued' : 'failed')
    assert.equal(record.error.diagnostic.httpStatus, 429)
    assert.equal(record.error.diagnostic.retryAt, new Date(Date.parse(f.now) + 300_000).toISOString())
    assert.deepEqual(record.processingSettings, accepted)
    const history = JSON.parse(Buffer.from((await f.analysis.blobs.read(record.history.blob.blobName)).bytes).toString())
    generatedHash ??= history.outputSha256
    assert.equal(history.outputSha256, generatedHash)
    assert.equal(history.round, 1)
    if (attempt === 1) f.now = record.nextAttemptAt
    else {
      assert.equal(record.nextAttemptAt, undefined)
      assert.equal(record.lease, undefined)
      assert.match(record.error.message, /rate limited.*Automatic attempts are exhausted \(2\).*resume explicitly/)
    }
  }
  assert.equal(mock.calls.filter(call => call.kind === 'analysis_candidate_narrative').length, 1)
  assert.equal(mock.calls.filter(call => call.kind === 'analysis_narrative_grounding_review').length, 2)
  assert.ok(mock.calls.every(call => !call.request.model.startsWith('new-')))
  const calls = mock.calls.length
  f.now = new Date(Date.parse(f.now) + 600_000).toISOString()
  await runAnalysisWorker(mock.deps, { maxItems: 10 })
  assert.equal(mock.calls.length, calls, 'Terminal throttling must not automatically requeue forever.')
  assert.equal((await f.analysis.store.get(f.workspaceId, id)).record.status, 'failed')
  assert.deepEqual(runComparisons(f, created.run.id), scoring)
})

test('provider cooldown survives cancellation at the worker delay boundary and resumes only the saved review', async () => {
  const { f, created, id } = await summaryRetryFixture({ transportAttempts: 2 })
  const controller = new AbortController()
  const retryAt = new Date(Date.parse(f.now) + 60_000).toISOString()
  const first = narrativeWorker(f, ({ kind }) => kind === 'analysis_narrative_grounding_review'
    ? new Response('PRIVATE-PROVIDER', { status: 429, headers: { 'retry-after': '60' } }) : undefined)
  first.deps.clock.sleep = async (milliseconds, signal) => {
    assert.equal(milliseconds, 60_000)
    const running = (await f.analysis.store.get(f.workspaceId, id)).record
    const checkpoint = JSON.parse(Buffer.from((await f.analysis.blobs.read(running.history.blob.blobName)).bytes).toString())
    assert.equal(checkpoint.error.diagnostic.retryAt, retryAt)
    controller.abort(new Error('PRIVATE-INTERRUPTION'))
    signal.throwIfAborted()
  }
  await runAnalysisWorker(first.deps, { maxItems: 1, signal: controller.signal })
  const queued = (await f.analysis.store.get(f.workspaceId, id)).record
  assert.equal(queued.status, 'queued')
  assert.equal(queued.error.code, 'service-unavailable')
  assert.equal(queued.error.diagnostic.httpStatus, 429)
  assert.equal(queued.error.diagnostic.retryAt, retryAt)
  assert.equal(queued.nextAttemptAt, retryAt)
  assert.equal(first.calls.length, 2)
  assert.doesNotMatch(JSON.stringify(first.events), /PRIVATE/)
  f.now = retryAt
  const resumed = narrativeWorker(f)
  await runAnalysisWorker(resumed.deps, { maxItems: 1 })
  assert.equal((await f.analysis.store.get(f.workspaceId, id)).record.status, 'ready')
  assert.deepEqual(resumed.calls.map(call => call.kind), ['analysis_narrative_grounding_review'])
  assert.equal((await summaries(f, created.run.id)).counts.candidates.ready, 1)
})

test('interrupted cooldown recovery uses saved checkpoints without consuming an extra automatic attempt', async () => {
  for (const attempts of [1, 3]) {
    const { f, accepted, id } = await summaryRetryFixture({ attempts, transportAttempts: 2 })
    const controller = new AbortController()
    const retryAt = new Date(Date.parse(f.now) + 120_000).toISOString()
    let crashed
    const first = narrativeWorker(f, ({ kind }) => kind === 'analysis_narrative_grounding_review'
      ? new Response('PRIVATE-PROVIDER', { status: 429, headers: { 'retry-after': '120' } }) : undefined)
    first.deps.clock.sleep = async (milliseconds, signal) => {
      assert.equal(milliseconds, 120_000)
      crashed = clone((await f.analysis.store.get(f.workspaceId, id)).record)
      controller.abort()
      signal.throwIfAborted()
    }
    await runAnalysisWorker(first.deps, { maxItems: 1, signal: controller.signal })
    assert.ok(crashed)
    assert.equal(crashed.status, 'running')
    assert.equal(crashed.error, undefined)
    assert.equal(crashed.nextAttemptAt, undefined)
    f.analysis.store.save(crashed)
    f.now = new Date(Date.parse(crashed.lease.expiresAt) + 1).toISOString()
    const recovering = narrativeWorker(f)
    await runAnalysisWorker(recovering.deps, { maxItems: 1 })
    const recovered = (await f.analysis.store.get(f.workspaceId, id)).record
    assert.equal(recovering.calls.length, 0)
    assert.equal(recovered.attempts, crashed.attempts)
    assert.equal(recovered.error.diagnostic.httpStatus, 429)
    assert.equal(recovered.error.diagnostic.retryAt, retryAt)
    assert.deepEqual(recovered.history, crashed.history)
    assert.deepEqual(recovered.processingSettings, accepted)
    if (attempts === 1) {
      assert.equal(recovered.status, 'failed')
      assert.equal(recovered.nextAttemptAt, undefined)
      assert.match(recovered.error.message, /Automatic attempts are exhausted \(1\)/)
    } else {
      assert.equal(recovered.status, 'queued')
      assert.ok(recovered.nextAttemptAt >= retryAt)
      f.now = recovered.nextAttemptAt
      await runAnalysisWorker(recovering.deps, { maxItems: 1 })
      assert.equal((await f.analysis.store.get(f.workspaceId, id)).record.status, 'ready')
      assert.deepEqual(recovering.calls.map(call => call.kind), ['analysis_narrative_grounding_review'])
    }
  }
})

test('an unreadable cooldown checkpoint consumes bounded recovery attempts without calling the provider', async () => {
  const { f, id } = await summaryRetryFixture({ attempts: 2, transportAttempts: 2 })
  const controller = new AbortController()
  let crashed
  const first = narrativeWorker(f, ({ kind }) => kind === 'analysis_narrative_grounding_review'
    ? new Response('PRIVATE-PROVIDER', { status: 429, headers: { 'retry-after': '120' } }) : undefined)
  first.deps.clock.sleep = async (_milliseconds, signal) => {
    crashed = clone((await f.analysis.store.get(f.workspaceId, id)).record)
    controller.abort()
    signal.throwIfAborted()
  }
  await runAnalysisWorker(first.deps, { maxItems: 1, signal: controller.signal })
  assert.ok(crashed)
  f.analysis.store.save(crashed)
  f.now = new Date(Date.parse(crashed.lease.expiresAt) + 1).toISOString()
  const read = f.analysis.blobs.read
  f.analysis.blobs.read = async (name, signal) => {
    if (name === crashed.history.blob.blobName) throw new Error('PRIVATE-CHECKPOINT-STORAGE')
    return read(name, signal)
  }
  const recovering = narrativeWorker(f)
  await runAnalysisWorker(recovering.deps, { maxItems: 1 })
  const failed = (await f.analysis.store.get(f.workspaceId, id)).record
  assert.equal(failed.status, 'failed')
  assert.equal(failed.attempts, 2)
  assert.equal(failed.error.code, 'storage-error')
  assert.equal(failed.nextAttemptAt, undefined)
  assert.equal(recovering.calls.length, 0)
  assert.deepEqual(failed.history, crashed.history)
  assert.doesNotMatch(JSON.stringify(recovering.events), /PRIVATE/)
})

test('new completion atomically queues independent narrative work and target publication uses every completed result', async () => {
  const f = fixture()
  const created = await createRun(f, 2)
  for (const pair of runComparisons(f, created.run.id)) await publishResult(f, created.run.id, pair.record.id)
  const before = clone(runComparisons(f, created.run.id))
  const oldBlobs = new Map(before.map(pair => [pair.record.result.blobName, clone(f.analysis.blobs.values.get(pair.record.result.blobName))]))
  const completionBatches = f.analysis.store.batches.filter(batch => batch.some(operation =>
    operation.record.recordType === 'analysis-comparison' && operation.record.status === 'complete'))
  assert.equal(completionBatches.length, 2)
  assert.ok(completionBatches.every(batch => batch.some(operation => operation.record.recordType === 'analysis-candidate-narrative') &&
    batch.some(operation => operation.record.recordType === 'analysis-target-narrative')))
  const mock = narrativeWorker(f)
  const counts = await runAnalysisWorker(mock.deps, { maxItems: 2 })
  assert.deepEqual(counts, { claimed: 2, completed: 0 }, 'Narrative publications are not scoring completions.')
  assert.equal((await summaries(f, created.run.id)).counts.candidates.ready, 2)
  const ready = await settleNarratives(f, created.run.id, mock)
  assert.equal(ready.ready, true, JSON.stringify(ready))
  const targetCall = mock.calls.find(call => call.kind === 'analysis_target_narrative')
  assert.equal(targetCall.body.source.records.length, 2)
  assert.deepEqual(new Set(targetCall.body.source.records.flatMap(pair => pair.members)), new Set(before.map(pair => pair.record.id)))
  assert.ok(mock.calls.every(call => call.kind.startsWith('analysis_')), 'Summary-only inference never invokes scoring.')
  assert.deepEqual(runComparisons(f, created.run.id), before)
  for (const [name, blob] of oldBlobs) assert.deepEqual(f.analysis.blobs.values.get(name), blob)
  assert.equal(ready.capture.comparisons.every(pair => pair.narrative?.revision && pair.resultSha256), true)
  assert.doesNotMatch(JSON.stringify(mock.events), /fake-private-token|submitted document|"rubric":|"paragraphs":|"blobName":/)
})

test('a newly completed old-run pair backfills missing prerequisites but history reads never do', async () => {
  const f = fixture()
  const created = await createRun(f, 2)
  const [first, second] = runComparisons(f, created.run.id)
  await publishResult(f, created.run.id, first.record.id, false, { scheduleNarratives: false })
  assert.equal((await summaries(f, created.run.id)).counts.candidates.missing, 1)
  assert.equal([...f.analysis.store.values.values()].filter(value => value.record.recordType.includes('narrative')).length, 0)
  await publishResult(f, created.run.id, second.record.id)
  assert.equal((await summaries(f, created.run.id)).counts.candidates.missing, 1)
  const ready = await settleNarratives(f, created.run.id)
  assert.equal(ready.ready, true, JSON.stringify(ready))
  assert.equal(ready.counts.candidates.ready, 2)
})

test('failed narrative refresh retains previous publications and does not turn a successful assessment into failed scoring', async () => {
  const f = fixture()
  const created = await createRun(f)
  await publishResult(f, created.run.id, runComparisons(f, created.run.id)[0].record.id)
  const initial = await settleNarratives(f, created.run.id)
  assert.equal(initial.ready, true)
  const comparison = clone(runComparisons(f, created.run.id)[0])
  const request = await generate(f, created.run.id, 'all')
  await drainNarrativeRequest(f, created.run.id, request.requestId)
  const bad = narrativeWorker(f, ({ kind }) => kind === 'analysis_candidate_narrative' ? { privateModelOutput: 'PRIVATE-SENTINEL' } : undefined)
  const failed = await settleNarratives(f, created.run.id, bad)
  assert.equal(failed.counts.candidates.failed, 1, JSON.stringify(failed))
  assert.equal(failed.counts.targets.failed, 1)
  assert.equal(failed.targets[0].error.code, 'dependency-failed')
  assert.equal(failed.ready, false)
  assert.deepEqual(failed.comparisons[0].published, initial.comparisons[0].published)
  assert.deepEqual(failed.targets[0].published, initial.targets[0].published)
  assert.equal(bad.calls.filter(call => call.kind === 'analysis_candidate_narrative').length, 3)
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE-SENTINEL/)
  assert.deepEqual(runComparisons(f, created.run.id)[0], comparison)
  const retry = await generate(f, created.run.id)
  assert.deepEqual(retry.scheduled, { candidates: 1, targets: 1 })
  await drainNarrativeRequest(f, created.run.id, retry.requestId)
  assert.equal((await settleNarratives(f, created.run.id)).ready, true)
})

test('a scoring retry invalidates only its target, reuses current unaffected candidate summaries, and refreshes after settlement', async () => {
  const f = fixture()
  const created = await createRun(f, 2)
  const [first, second] = runComparisons(f, created.run.id)
  await publishResult(f, created.run.id, first.record.id)
  await f.service.comparisonAction(f.workspaceId, created.run.id, second.record.id, 'cancel',
    (await f.analysis.store.get(f.workspaceId, second.record.id)).etag)
  const original = await settleNarratives(f, created.run.id)
  assert.equal(original.ready, true)
  const firstPublication = original.comparisons.find(pair => pair.comparisonId === first.record.id).published
  await f.service.comparisonAction(f.workspaceId, created.run.id, second.record.id, 'retry',
    (await f.analysis.store.get(f.workspaceId, second.record.id)).etag)
  const stale = await summaries(f, created.run.id)
  assert.equal(stale.ready, false)
  assert.equal(stale.scoring.queued, 1)
  assert.equal(stale.targets[0].status, 'waiting')
  assert.deepEqual(stale.targets[0].published, original.targets[0].published)
  assert.deepEqual(stale.comparisons.find(pair => pair.comparisonId === first.record.id).published, firstPublication)
  await publishResult(f, created.run.id, second.record.id)
  const mock = narrativeWorker(f)
  const ready = await settleNarratives(f, created.run.id, mock)
  assert.equal(ready.ready, true)
  assert.equal(mock.calls.filter(call => call.kind === 'analysis_candidate_narrative').length, 1)
  assert.equal(mock.calls.filter(call => call.kind === 'analysis_target_narrative').length, 1)
  assert.deepEqual(ready.comparisons.find(pair => pair.comparisonId === first.record.id).published, firstPublication)
  assert.notEqual(ready.targets[0].published.revision, original.targets[0].published.revision)
})

test('superseded model output and expired same-owner attempts cannot publish or upload late narrative bytes', async () => {
  const f = fixture()
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  let release
  const waiting = new Promise(resolve => { release = resolve })
  let entered = false
  const old = narrativeWorker(f, async ({ kind }) => {
    if (kind === 'analysis_candidate_narrative') { entered = true; await waiting }
  })
  const processing = runAnalysisWorker(old.deps, { maxItems: 1 })
  await until(() => entered)
  const id = api.analysisNarrativeId('candidate', created.run.id, pair.record.id)
  const claimed = await f.analysis.store.get(f.workspaceId, id)
  const next = await generate(f, created.run.id, 'all')
  release()
  await processing
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/narratives/candidate/')).length, 0)
  await drainNarrativeRequest(f, created.run.id, next.requestId)
  const mock = narrativeWorker(f)
  assert.equal(await processClaimedNarrative(claimed, mock.deps), false)
  assert.equal(mock.calls.length, 0)
  const ready = await settleNarratives(f, created.run.id, mock)
  assert.equal(ready.ready, true)
  assert.notEqual(ready.comparisons[0].generationId, claimed.record.generationId)
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, pair.record.id),
    runComparisons(f, created.run.id)[0], 'Scoring remains independently immutable.')
})

test('archive fences a late blob PUT, unarchive never resumes cancelled generations, and deletion purges sidecars and receipts', async () => {
  const f = fixture()
  const created = await createRun(f)
  await publishResult(f, created.run.id, runComparisons(f, created.run.id)[0].record.id)
  const lifecycle = new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(f.now))
  let archived = false
  f.analysis.blobs._beforeFencedPut(async name => {
    if (name.includes('/narratives/candidate/') && !archived) {
      archived = true
      const run = await f.analysis.store.get(f.workspaceId, created.run.id)
      await lifecycle.change(f.workspaceId, created.run.id, 'archive', run.etag, ACTOR)
    }
  })
  const mock = narrativeWorker(f)
  await runAnalysisWorker(mock.deps, { maxItems: 1 })
  const stopped = await summaries(f, created.run.id)
  assert.equal(stopped.counts.candidates.cancelled, 1)
  assert.deepEqual(stopped.capabilities, { canGenerate: false, reason: 'archived' })
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/narratives/candidate/')).length, 0)
  await assert.rejects(generate(f, created.run.id), /archived|removed|changed/)
  let run = await f.analysis.store.get(f.workspaceId, created.run.id)
  await lifecycle.change(f.workspaceId, created.run.id, 'unarchive', run.etag, ACTOR)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 2 }), { claimed: 0, completed: 0 })
  f.analysis.blobs._beforeFencedPut(undefined)
  const request = await generate(f, created.run.id)
  await drainNarrativeRequest(f, created.run.id, request.requestId)
  assert.equal((await settleNarratives(f, created.run.id, mock)).ready, true)
  // A failed content PUT retains a finite reservation; simulate only its known expiry.
  const control = await f.analysis.store.getControl(f.workspaceId, created.run.id)
  if (control.record.writers) await api.updateAnalysisControl(f.analysis.store, f.workspaceId, created.run.id, value => ({
    ...value, writers: Object.fromEntries(Object.entries(value.writers).map(([id, writer]) => [id, { ...writer, expiresAt: '2020-01-01T00:00:00.000Z' }])),
  }))
  run = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.deepEqual(await lifecycle.change(f.workspaceId, created.run.id, 'delete', run.etag, ACTOR), { deleted: true })
  assert.equal([...f.analysis.store.values.values()].filter(value => value.record.runId === created.run.id || value.record.id === created.run.id).length, 0)
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.startsWith(`${f.workspaceId}/${created.run.id}/`)).length, 0)
  assert.equal((await f.analysis.store.getControl(f.workspaceId, created.run.id)).record.state, 'deleted')
})

test('a settled partial/cancelled 500-comparison scope includes every status without live sources or scoring restart', async () => {
  const f = fixture()
  const created = await createRun(f, 500)
  while ((await f.analysis.store.get(f.workspaceId, created.run.id)).record.progress.initialized < 500) {
    await api.advanceAnalysisRun(f.analysis, f.workspaceId, created.run.id, { now: () => new Date(f.now), maxChunks: 4 })
  }
  const pairs = runComparisons(f, created.run.id)
  await publishResult(f, created.run.id, pairs[0].record.id)
  await publishResult(f, created.run.id, pairs.at(-1).record.id)
  let run = await f.analysis.store.get(f.workspaceId, created.run.id)
  await f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag)
  while (!(await f.analysis.store.get(f.workspaceId, created.run.id)).record.cancellation.completedAt) {
    await api.advanceAnalysisRun(f.analysis, f.workspaceId, created.run.id, { now: () => new Date(f.now), maxChunks: 4 })
  }
  f.resumeValues.clear(); f.jobValues.clear(); f.rubricValues.clear()
  const scoring = clone(runComparisons(f, created.run.id))
  const request = await generate(f, created.run.id)
  assert.deepEqual(request.scheduled, { candidates: 2, targets: 1 })
  await drainNarrativeRequest(f, created.run.id, request.requestId)
  const mock = narrativeWorker(f)
  const ready = await settleNarratives(f, created.run.id, mock)
  assert.equal(ready.ready, true, JSON.stringify(ready.counts))
  assert.equal(ready.scoring.complete, 2)
  assert.equal(ready.scoring.cancelled, 498)
  assert.equal(ready.counts.candidates.notRequired, 498)
  assert.equal(ready.capture.comparisons.length, 500)
  const generation = mock.calls.find(call => call.kind === 'analysis_target_narrative')
  assert.deepEqual(generation.body.source.records.flatMap(unit => unit.members), scoring.map(pair => pair.record.id).sort())
  const supplied = new Map(mock.calls.flatMap(call => call.body.source?.records ?? [])
    .filter(unit => unit.analysis.comparisonId).map(unit => [unit.analysis.comparisonId, unit.analysis]))
  assert.equal([...supplied.values()].filter(analysis => analysis.status === 'cancelled').length, 498)
  assert.equal([...supplied.values()].filter(analysis => analysis.criteria).length, 2)
  assert.ok(mock.calls.every(call => call.kind.startsWith('analysis_')))
  assert.deepEqual(runComparisons(f, created.run.id), scoring)
  assert.ok(f.analysis.store.batches.every(batch => batch.length <= 26 && Buffer.byteLength(JSON.stringify(batch)) <= api.MAX_ANALYSIS_TRANSACTION_BYTES))
  run = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.equal(run.record.status, 'cancelled')
})

test('three failed factual rounds retain history and manual approval unblocks the overview without changing scoring', async () => {
  const { readSummaryGeneration } = await loadWorker('../server/analyses/summary-history.ts')
  const f = fixture()
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const scored = clone(runComparisons(f, created.run.id))
  let drafts = 0
  const mock = narrativeWorker(f, ({ kind }) => {
    if (kind === 'analysis_candidate_narrative') return {
      text: `Saved candidate draft number ${++drafts} requires factual correction.`,
      overview: 'The saved analysis needs careful interpretation.',
    }
    if (kind === 'analysis_narrative_grounding_review') return {
      outcome: 'needs-correction',
      issues: [{ code: 'unsupported-claim', message: 'The draft overstates the supplied analysis.', field: 'text', paragraphIndex: null }],
    }
  })
  const failed = await settleNarratives(f, created.run.id, mock)
  assert.equal(drafts, 3)
  assert.equal(failed.comparisons[0].status, 'failed')
  assert.equal(failed.comparisons[0].summaryRound, 3)
  assert.equal(failed.comparisons[0].hasHistory, true)
  const record = (await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', created.run.id, pair.record.id))).record
  const saved = await readSummaryGeneration(f.analysis, record)
  const reviewed = saved.steps.filter(step => step.scopeId === 'final' && step.phase === 'reviewed')
  assert.equal(reviewed.length, 3)
  assert.equal(new Set(reviewed.map(step => step.outputSha256)).size, 3)
  assert.ok(reviewed.every(step => step.review.issues.length === 1 && step.draft.text))
  assert.deepEqual(runComparisons(f, created.run.id), scored)
  assert.doesNotMatch(JSON.stringify(mock.events), /overstates the supplied|Saved candidate draft|fake-private-token/)
  const retryHistory = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, created.run.id,
    { kind: 'candidate', subjectId: pair.record.id })
  await f.service.retrySummary(f.workspaceId, created.run.id,
    { kind: 'candidate', subjectId: pair.record.id }, randomUUID(), retryHistory.etag, ACTOR)
  const retried = (await f.analysis.store.get(f.workspaceId, record.id)).record
  assert.equal(retried.generationId, record.generationId)
  assert.equal(retried.processingSettings.revision, 'legacy-v1')
  assert.equal(retried.summaryRound, 3)
  const legacyRetry = narrativeWorker(f)
  assert.equal((await settleNarratives(f, created.run.id, legacyRetry)).comparisons[0].status, 'failed')
  assert.equal(legacyRetry.calls.length, 0, 'Unpinned legacy history cannot reset its consumed rounds.')
  const page = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, created.run.id,
    { kind: 'candidate', subjectId: pair.record.id })
  const selected = reviewed.find(step => step.round === 1)
  await api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, created.run.id,
    { kind: 'candidate', subjectId: pair.record.id },
    { generationId: record.generationId, round: selected.round, outputSha256: selected.outputSha256 },
    randomUUID(), page.etag, ACTOR, () => new Date(f.now))
  const remaining = narrativeWorker(f)
  const ready = await settleNarratives(f, created.run.id, remaining)
  assert.equal(ready.ready, true)
  assert.equal(ready.comparisons[0].published.text, selected.draft.text)
  assert.equal(ready.comparisons[0].published.approval.kind, 'manual')
  assert.equal(ready.comparisons[0].published.approval.reviewOutcome, 'needs-correction')
  assert.ok(remaining.calls.every(call => call.kind !== 'analysis_candidate_narrative'))
  assert.doesNotMatch(JSON.stringify(remaining.calls.map(call => call.body.source)), /Saved candidate draft|overstates the supplied/)
  assert.deepEqual(runComparisons(f, created.run.id), scored)
})

test('explicit summaries pin an independent policy and manual retries retain its consumed rounds while regeneration adopts new settings', async () => {
  const f = fixture()
  const legacy = settingsSnapshot(() => {}, 'legacy-v1')
  let current = settingsSnapshot(settings => { settings.summaries.generationMode = 'on-demand' }, 'accepted-scoring-policy')
  f.service = new api.RealAnalysisService(f.analysis, { resumes: f.resumes, jobs: f.jobs, grades: f.grades },
    () => new Date(f.now), async () => current)
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  assert.equal((await summaries(f, created.run.id)).counts.candidates.missing, 1)
  assert.equal([...f.analysis.store.values.values()].filter(value => value.record.recordType.includes('narrative')).length, 0)

  current = settingsSnapshot(settings => { settings.summaries.maxRounds = 1 }, 'independent-summary-policy')
  const requested = await generate(f, created.run.id, 'all')
  await drainNarrativeRequest(f, created.run.id, requested.requestId)
  const mock = narrativeWorker(f, ({ kind }) => kind === 'analysis_narrative_grounding_review' ? {
    outcome: 'needs-correction',
    issues: [{ code: 'unsupported-claim', message: 'The draft overstates the supplied analysis.', field: 'text', paragraphIndex: null }],
  } : undefined)
  mock.deps.settings = { legacy, current: async () => current }
  const failed = await settleNarratives(f, created.run.id, mock)
  assert.equal(failed.comparisons[0].status, 'failed')
  assert.equal(failed.comparisons[0].summaryRound, 1)
  assert.equal(mock.calls.length, 2)
  const id = api.analysisNarrativeId('candidate', created.run.id, pair.record.id)
  const accepted = (await f.analysis.store.get(f.workspaceId, id)).record
  assert.equal(accepted.processingSettings.revision, 'independent-summary-policy')
  assert.equal((await f.analysis.store.get(f.workspaceId, created.run.id)).record.processingSettings.revision, 'accepted-scoring-policy')

  current = settingsSnapshot(settings => {
    for (const deployment of settings.ai.deployments) deployment.deploymentName = `new-${deployment.id}`
  }, 'new-summary-policy')
  const subject = { kind: 'candidate', subjectId: pair.record.id }
  const page = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, created.run.id, subject)
  await f.service.retrySummary(f.workspaceId, created.run.id, subject, randomUUID(), page.etag, ACTOR)
  const retried = (await f.analysis.store.get(f.workspaceId, id)).record
  assert.equal(retried.generationId, accepted.generationId)
  assert.equal(retried.processingSettings.revision, 'independent-summary-policy')
  assert.equal(retried.summaryRound, 1)
  assert.ok(accepted.history)
  assert.deepEqual(retried.history, accepted.history)
  const resumed = narrativeWorker(f)
  resumed.deps.settings = { legacy, current: async () => current }
  const exhausted = await settleNarratives(f, created.run.id, resumed)
  assert.equal(exhausted.comparisons[0].status, 'failed')
  assert.equal(exhausted.comparisons[0].summaryRound, 1)
  assert.equal(resumed.calls.length, 0, 'A retry cannot buy more rounds by reading the newer default.')

  const regenerate = await generate(f, created.run.id, 'all')
  await drainNarrativeRequest(f, created.run.id, regenerate.requestId)
  const fresh = (await f.analysis.store.get(f.workspaceId, id)).record
  assert.notEqual(fresh.generationId, accepted.generationId)
  assert.equal(fresh.processingSettings.revision, 'new-summary-policy')
  const final = narrativeWorker(f)
  final.deps.settings = { legacy, current: async () => current }
  assert.equal((await settleNarratives(f, created.run.id, final)).ready, true)
  assert.ok(final.calls.some(call => call.request.model === 'new-candidateSummary'))
  assert.ok(final.calls.some(call => call.request.model === 'new-targetSummary'))
  assert.ok(final.calls.filter(call => call.kind === 'analysis_narrative_grounding_review')
    .every(call => call.request.model === 'new-summaryReview'))
  await assertPublishedSettings(f, id, current)
  await assertPublishedSettings(f, api.analysisNarrativeId('target', created.run.id, pair.record.target.summary.id), current)
})

test('an immutable summary winner with different captured settings cannot be published as the accepted generation', async () => {
  const f = fixture()
  const accepted = settingsSnapshot(settings => {
    settings.processing.analyses.maxAutomaticAttempts = 1
  }, 'accepted-summary-policy')
  const changed = settingsSnapshot(settings => {
    settings.processing.analyses.maxAutomaticAttempts = 1
    settings.summaries.maxRounds = 2
  }, accepted.revision)
  f.service = new api.RealAnalysisService(f.analysis, { resumes: f.resumes, jobs: f.jobs, grades: f.grades },
    () => new Date(f.now), async () => accepted)
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const put = f.analysis.blobs.putImmutable.bind(f.analysis.blobs)
  let corrupted = false
  f.analysis.blobs.putImmutable = async (name, bytes, contentType, options) => {
    if (name.includes('/narratives/')) {
      const artifact = JSON.parse(Buffer.from(bytes).toString('utf8'))
      if (artifact.kind === 'candidate') {
        bytes = Buffer.from(JSON.stringify({ ...artifact, processingSettings: changed }))
        corrupted = true
      }
    }
    return put(name, bytes, contentType, options)
  }
  const mock = narrativeWorker(f)
  mock.deps.settings = { legacy: settingsSnapshot(() => {}, 'legacy-v1'), current: async () => accepted }
  const result = await settleNarratives(f, created.run.id, mock)
  const id = api.analysisNarrativeId('candidate', created.run.id, pair.record.id)
  const { record } = await f.analysis.store.get(f.workspaceId, id)
  assert.equal(corrupted, true)
  assert.equal(result.ready, false)
  assert.equal(record.status, 'failed')
  assert.equal(record.error.stage, 'publication')
  assert.equal(record.published, undefined)
  assert.deepEqual(record.processingSettings, accepted)
})

test('closed configured admissions preserve accepted automatic summaries and their captured retry policy', async () => {
  const f = fixture()
  const legacy = settingsSnapshot(() => {}, 'legacy-v1')
  const accepted = settingsSnapshot(settings => {
    for (const deployment of settings.ai.deployments) deployment.deploymentName = `accepted-${deployment.id}`
    settings.processing.analyses.maxAutomaticAttempts = 2
  }, 'accepted-run-policy')
  let current = accepted
  let ready = true
  let admissions = 0
  const closed = new Error('New processing is closed until worker rollout is verified.')
  const provider = Object.assign(async () => current, {
    admission: async () => { admissions++; if (!ready) throw closed; return current },
    newProcessingAllowed: () => ready,
    pinNewAdmissions: true,
    accepted: async snapshot => snapshot ?? legacy,
  })
  f.service = new api.RealAnalysisService(f.analysis, { resumes: f.resumes, jobs: f.jobs, grades: f.grades },
    () => new Date(f.now), provider)
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  ready = false
  provider.pinNewAdmissions = false
  current = settingsSnapshot(settings => {
    for (const deployment of settings.ai.deployments) deployment.deploymentName = `current-${deployment.id}`
    settings.summaries.generationMode = 'on-demand'
    settings.processing.analyses.maxAutomaticAttempts = 1
  }, 'current-policy')
  await publishResult(f, created.run.id, pair.record.id)
  await assert.rejects(generate(f, created.run.id, 'all'), error => error === closed)
  const admissionReads = admissions
  const mock = narrativeWorker(f, ({ kind, call }) =>
    kind === 'analysis_candidate_narrative' && call <= 2 ? new Response('Unavailable', { status: 503 }) : undefined)
  mock.deps.settings = { legacy, current: async () => current }
  assert.equal((await settleNarratives(f, created.run.id, mock)).ready, true)
  assert.ok(mock.calls.every(call => call.request.model.startsWith('accepted-')))
  assert.equal(admissions, admissionReads, 'Accepted continuations must not ask for new processing admission.')
  const candidateId = api.analysisNarrativeId('candidate', created.run.id, pair.record.id)
  const targetId = api.analysisNarrativeId('target', created.run.id, pair.record.target.summary.id)
  assert.equal((await f.analysis.store.get(f.workspaceId, candidateId)).record.attempts, 2)
  for (const id of [candidateId, targetId]) await assertPublishedSettings(f, id, accepted)
})

test('unconfigured legacy-mode unpinned regeneration uses canonical legacy rather than inheriting the old run or current policy', async () => {
  const f = fixture()
  const policy = (prefix, revision, attempts = 3) => settingsSnapshot(settings => {
    for (const deployment of settings.ai.deployments) deployment.deploymentName = `${prefix}-${deployment.id}`
    settings.processing.analyses.maxAutomaticAttempts = attempts
  }, revision)
  const legacy = policy('legacy', 'legacy-v1')
  let current = policy('run', 'accepted-run-policy', 1)
  const provider = Object.assign(async () => current, {
    // No configured-service readiness hook: this models legacy/test admissions, not configured rollout-off.
    pinNewAdmissions: true,
    accepted: async snapshot => snapshot ?? legacy,
  })
  f.service = new api.RealAnalysisService(f.analysis, { resumes: f.resumes, jobs: f.jobs, grades: f.grades },
    () => new Date(f.now), provider)
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const automatic = narrativeWorker(f)
  automatic.deps.settings = { legacy, current: async () => current }
  assert.equal((await settleNarratives(f, created.run.id, automatic)).ready, true)
  assert.ok(automatic.calls.some(call => call.request.model === 'run-candidateSummary'))
  assert.ok(automatic.calls.some(call => call.request.model === 'run-targetSummary'))
  const candidateId = api.analysisNarrativeId('candidate', created.run.id, pair.record.id)
  const targetId = api.analysisNarrativeId('target', created.run.id, pair.record.target.summary.id)
  for (const id of [candidateId, targetId]) await assertPublishedSettings(f, id, current)

  current = policy('current', 'later-current-policy', 1)
  provider.pinNewAdmissions = false
  const request = await generate(f, created.run.id, 'all')
  await drainNarrativeRequest(f, created.run.id, request.requestId)
  const candidate = (await f.analysis.store.get(f.workspaceId, candidateId)).record
  assert.equal(candidate.processingSettings, undefined)
  assert.equal((await f.analysis.store.get(f.workspaceId, targetId)).record.processingSettings, undefined)
  const crashedAt = new Date(Math.max(Date.parse(f.now), Date.parse(candidate.updatedAt))).toISOString()
  const expiredAt = new Date(Date.parse(crashedAt) + 90_000).toISOString()
  const crashed = {
    ...candidate, status: 'running', attempts: 1, attemptId: randomUUID(), updatedAt: crashedAt,
    lease: { owner: 'expired-summary-worker', heartbeatAt: crashedAt, expiresAt: expiredAt },
  }
  delete crashed.nextAttemptAt
  f.analysis.store.save(crashed)
  f.now = new Date(Date.parse(expiredAt) + 1).toISOString()
  const regenerated = narrativeWorker(f)
  regenerated.deps.settings = { legacy, current: async () => current }
  assert.equal((await settleNarratives(f, created.run.id, regenerated)).ready, true)
  assert.ok(regenerated.calls.some(call => call.request.model === 'legacy-candidateSummary'))
  assert.ok(regenerated.calls.some(call => call.request.model === 'legacy-targetSummary'))
  assert.ok(regenerated.calls.every(call => call.request.model.startsWith('legacy-')))
  for (const id of [candidateId, targetId]) {
    await assertPublishedSettings(f, id, legacy)
  }
  assert.equal((await f.analysis.store.get(f.workspaceId, candidateId)).record.attempts, 2)
  assert.equal((await f.analysis.store.get(f.workspaceId, created.run.id)).record.processingSettings.revision, 'accepted-run-policy')
})

test('resuming a candidate does not reset a failed dependent target and explicit target retry retains its accepted policy', async () => {
  const f = fixture()
  const accepted = settingsSnapshot(settings => {
    settings.summaries.maxRounds = 1
    settings.processing.analyses.maxAutomaticAttempts = 1
    settings.ai.transport.maxAttempts = 1
  }, 'accepted-target-policy')
  let current = accepted
  f.service = new api.RealAnalysisService(f.analysis, { resumes: f.resumes, jobs: f.jobs, grades: f.grades },
    () => new Date(f.now), async () => current)
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const first = narrativeWorker(f, ({ kind }) =>
    kind === 'analysis_narrative_grounding_review' ? new Response('', { status: 503 }) : undefined)
  first.deps.settings = { legacy: accepted, current: async () => current }
  const failed = await settleNarratives(f, created.run.id, first)
  assert.equal(failed.comparisons[0].status, 'failed')
  assert.equal(failed.targets[0].error.code, 'dependency-failed')
  const targetId = api.analysisNarrativeId('target', created.run.id, failed.targets[0].targetId)
  const targetBefore = await f.analysis.store.get(f.workspaceId, targetId)
  assert.equal(targetBefore.record.inputFingerprint, null)
  assert.equal(targetBefore.record.attempts, 0)
  assert.equal(targetBefore.record.history, undefined)
  assert.equal(targetBefore.record.summaryRound, undefined)

  current = settingsSnapshot(settings => {
    for (const deployment of settings.ai.deployments) deployment.deploymentName = `new-${deployment.id}`
  }, 'later-target-policy')
  const candidateSubject = { kind: 'candidate', subjectId: pair.record.id }
  const candidateHistory = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, created.run.id, candidateSubject)
  await f.service.retrySummary(f.workspaceId, created.run.id, candidateSubject, randomUUID(), candidateHistory.etag, ACTOR)
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, targetId), targetBefore)
  const candidateRetry = narrativeWorker(f)
  candidateRetry.deps.settings = { legacy: accepted, current: async () => current }
  await runAnalysisWorker(candidateRetry.deps)
  assert.equal(candidateRetry.calls.length, 1)
  assert.equal(candidateRetry.calls[0].request.model, 'deployment-summaryReview')
  assert.equal((await summaries(f, created.run.id)).comparisons[0].status, 'ready')
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, targetId), targetBefore)

  const targetSubject = { kind: 'target', subjectId: failed.targets[0].targetId }
  const targetHistory = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, created.run.id, targetSubject)
  const retryRequestId = randomUUID()
  await f.service.retrySummary(f.workspaceId, created.run.id, targetSubject, retryRequestId, targetHistory.etag, ACTOR)
  const queued = (await f.analysis.store.get(f.workspaceId, targetId)).record
  assert.equal(queued.status, 'waiting')
  assert.equal(queued.waitingFor, 'candidate-narratives')
  assert.equal(queued.inputFingerprint, null)
  assert.equal(queued.generationId, targetBefore.record.generationId)
  assert.equal(queued.requestId, targetBefore.record.requestId)
  assert.equal(queued.retryRequestId, retryRequestId)
  assert.equal(queued.summaryRound, targetBefore.record.summaryRound)
  assert.deepEqual(queued.history, targetBefore.record.history)
  assert.deepEqual(queued.processingSettings, targetBefore.record.processingSettings)
  assert.throws(() => api.assertAnalysisReplacement({ ...targetBefore.record, inputFingerprint: 'f'.repeat(64) }, queued),
    /cannot change its accepted inputs/)
  assert.throws(() => api.assertAnalysisReplacement(targetBefore.record, { ...queued, processingSettings: current }),
    /cannot change processing settings/)
  const targetRetry = narrativeWorker(f)
  targetRetry.deps.settings = { legacy: accepted, current: async () => current }
  assert.equal((await settleNarratives(f, created.run.id, targetRetry)).ready, true)
  assert.deepEqual(targetRetry.calls.map(call => call.request.model), ['deployment-targetSummary', 'deployment-summaryReview'])
  const completed = (await f.analysis.store.get(f.workspaceId, targetId)).record
  assert.equal(completed.generationId, targetBefore.record.generationId)
  assert.equal(completed.requestId, targetBefore.record.requestId)
  assert.equal(completed.retryRequestId, retryRequestId)
  assert.match(completed.inputFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(completed.summaryRound, 1)
  await assertPublishedSettings(f, targetId, accepted)
})

test('automatic retry resumes a persisted draft after a transient review failure without another generation', async () => {
  const f = fixture()
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const first = narrativeWorker(f, ({ kind }) =>
    kind === 'analysis_narrative_grounding_review' ? new Response('PRIVATE-UPSTREAM', { status: 503 }) : undefined)
  await runAnalysisWorker(first.deps, { maxItems: 1 })
  const pending = await summaries(f, created.run.id)
  assert.equal(pending.comparisons[0].status, 'queued')
  assert.equal(pending.comparisons[0].summaryRound, 1)
  assert.equal(pending.comparisons[0].hasHistory, true)
  assert.equal(first.calls.filter(call => call.kind === 'analysis_candidate_narrative').length, 1)
  f.now = new Date(Date.parse(f.now) + 60_000).toISOString()
  const resumed = narrativeWorker(f)
  const ready = await settleNarratives(f, created.run.id, resumed)
  assert.equal(ready.ready, true)
  assert.equal(resumed.calls.filter(call => call.kind === 'analysis_candidate_narrative').length, 0)
  assert.equal(ready.comparisons[0].summaryRound, 1)
})

test('a failed draft checkpoint reports history-write-failed and stops before review or publication', async () => {
  const f = fixture()
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const scored = clone(runComparisons(f, created.run.id))
  const put = f.analysis.blobs.putFenced
  f.analysis.blobs.putFenced = async function (name, bytes, ...args) {
    if (name.includes('/narrative-history/') && JSON.parse(bytes.toString()).phase === 'generated') {
      throw new Error('PRIVATE-HISTORY-STORAGE')
    }
    return put.call(this, name, bytes, ...args)
  }
  const mock = narrativeWorker(f)
  await runAnalysisWorker(mock.deps, { maxItems: 1 })
  const state = await summaries(f, created.run.id)
  assert.equal(state.comparisons[0].status, 'queued')
  assert.equal(state.comparisons[0].error.diagnostic.reason, 'history-write-failed')
  assert.equal(state.comparisons[0].published, null)
  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0].kind, 'analysis_candidate_narrative')
  assert.deepEqual(runComparisons(f, created.run.id), scored)
  assert.doesNotMatch(JSON.stringify(mock.events), /PRIVATE-HISTORY-STORAGE/)
})

test('summary-only cancellation fences in-flight and projected generations at a fixed clock without cancelling completed scoring', async () => {
  const f = fixture()
  const created = await createRun(f)
  await publishResult(f, created.run.id, runComparisons(f, created.run.id)[0].record.id)
  const frozen = clone(runComparisons(f, created.run.id))
  let release, entered = false
  const waiting = new Promise(resolve => { release = resolve })
  const old = narrativeWorker(f, async ({ kind }) => {
    if (kind === 'analysis_candidate_narrative') { entered = true; await waiting }
  })
  const processing = runAnalysisWorker(old.deps, { maxItems: 1 })
  await until(() => entered)
  let run = await f.analysis.store.get(f.workspaceId, created.run.id)
  const cancelled = await f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag)
  assert.equal(cancelled.run.status, 'complete')
  assert.equal(cancelled.run.cancellation, undefined)
  release()
  await processing
  assert.equal((await summaries(f, created.run.id)).counts.candidates.cancelled, 1)
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/narratives/candidate/')).length, 0)
  const refresh = await generate(f, created.run.id)
  assert.equal(refresh.summaries.counts.candidates.queued, 1)
  run = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.ok(run.record.updatedAt > cancelled.run.narrativeCancelledAt)
  await f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag)
  assert.equal((await summaries(f, created.run.id)).counts.candidates.cancelled, 1)
  const calls = old.calls.length
  assert.deepEqual(await runAnalysisWorker(old.deps, { maxItems: 2 }), { claimed: 1, completed: 0 })
  assert.equal(old.calls.length, calls, 'A cancelled coordinator only materializes cancelled state.')
  assert.equal(await api.advanceAnalysisNarrativeRequest(f.analysis, f.workspaceId, created.run.id, refresh.requestId), false)
  const latest = await generate(f, created.run.id)
  await drainNarrativeRequest(f, created.run.id, latest.requestId)
  assert.equal((await settleNarratives(f, created.run.id)).ready, true)
  assert.deepEqual(runComparisons(f, created.run.id), frozen)
})

test('retry and new completion advance the cancellation watermark even when the clock has not advanced', async () => {
  const f = fixture()
  const created = await createRun(f, 2)
  const [first, second] = runComparisons(f, created.run.id)
  await publishResult(f, created.run.id, first.record.id)
  let run = await f.analysis.store.get(f.workspaceId, created.run.id)
  await f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag)
  run = await f.analysis.store.get(f.workspaceId, created.run.id)
  const cutoff = run.record.narrativeCancelledAt
  await f.service.comparisonAction(f.workspaceId, created.run.id, second.record.id, 'retry',
    (await f.analysis.store.get(f.workspaceId, second.record.id)).etag)
  run = await f.analysis.store.get(f.workspaceId, created.run.id)
  const target = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('target', created.run.id, second.record.target.summary.id))
  assert.ok(target.record.requestedAt > cutoff)
  assert.ok(run.record.updatedAt >= target.record.requestedAt)
  await publishResult(f, created.run.id, second.record.id)
  run = await f.analysis.store.get(f.workspaceId, created.run.id)
  const candidate = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', created.run.id, second.record.id))
  assert.ok(run.record.updatedAt >= candidate.record.requestedAt)
  await f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag)
  const stopped = await summaries(f, created.run.id)
  assert.equal(stopped.scoring.complete, 2)
  assert.equal(stopped.counts.candidates.cancelled, 2)
  assert.equal(stopped.counts.targets.cancelled, 1)
  assert.deepEqual(await f.analysis.store.listPending(f.now, 100), [])
})

test('an explicit refresh on a settled cancelled run can itself be cancelled without restarting scoring', async () => {
  const f = fixture()
  const created = await createRun(f, 2)
  await publishResult(f, created.run.id, runComparisons(f, created.run.id)[0].record.id)
  let run = await f.analysis.store.get(f.workspaceId, created.run.id)
  await f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag)
  const original = clone(runComparisons(f, created.run.id))
  const request = await generate(f, created.run.id)
  await drainNarrativeRequest(f, created.run.id, request.requestId)
  run = await f.analysis.store.get(f.workspaceId, created.run.id)
  const stopped = await f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag)
  assert.equal(stopped.run.status, 'cancelled')
  assert.ok(stopped.run.cancellation.completedAt)
  assert.equal((await summaries(f, created.run.id)).counts.candidates.cancelled, 1)
  assert.deepEqual(await runAnalysisWorker(narrativeWorker(f).deps, { maxItems: 2 }), { claimed: 0, completed: 0 })
  assert.deepEqual(runComparisons(f, created.run.id), original)
})

test('cancellation and archive never restore old publications to ready while accepted refresh tasks are still being materialized', async () => {
  for (const action of ['cancel', 'archive', 'workspace-archive']) {
    const f = fixture()
    const created = await createRun(f)
    await publishResult(f, created.run.id, runComparisons(f, created.run.id)[0].record.id)
    const ready = await settleNarratives(f, created.run.id)
    assert.equal(ready.ready, true)
    const refresh = await generate(f, created.run.id, 'all')
    const run = await f.analysis.store.get(f.workspaceId, created.run.id)
    if (action === 'cancel') await f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag)
    else if (action === 'archive') {
      await new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(f.now))
        .change(f.workspaceId, created.run.id, 'archive', run.etag, ACTOR)
    } else {
      const participant = api.createAnalysisLifecycleParticipant(f.analysis)
      await participant.setState(f.workspaceId, 'archived', f.now)
      await participant.cancel(f.workspaceId, f.now)
    }
    const stopped = await summaries(f, created.run.id)
    assert.equal(stopped.ready, false, action)
    assert.equal(stopped.comparisons[0].status, 'cancelled', action)
    assert.equal(stopped.targets[0].status, 'cancelled', action)
    assert.deepEqual(stopped.comparisons[0].published, ready.comparisons[0].published)
    assert.deepEqual(stopped.targets[0].published, ready.targets[0].published)
    assert.equal(stopped.capture.comparisons[0].narrative, null)
    const mock = narrativeWorker(f)
    assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 2 }), { claimed: 1, completed: 0 })
    assert.equal(mock.calls.length, 0)
    const receipt = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('request', created.run.id, refresh.requestId))
    assert.equal(receipt.record.status, 'cancelled')
    assert.equal(receipt.record.nextIndex, 2)
    const after = await summaries(f, created.run.id)
    assert.equal(after.revision, stopped.revision, action)
    assert.equal(after.ready, false)
  }
})

test('missing saved inputs retry at bounded backoff, retain previous text, and never fall back to live sources', async () => {
  const f = fixture()
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const before = await settleNarratives(f, created.run.id)
  assert.equal(before.ready, true)
  const request = await generate(f, created.run.id, 'all')
  await drainNarrativeRequest(f, created.run.id, request.requestId)
  const name = pair.record.resume.blob.blobName, saved = f.analysis.blobs.values.get(name)
  f.analysis.blobs.values.delete(name)
  f.resumeValues.clear(); f.jobValues.clear(); f.rubricValues.clear()
  const mock = narrativeWorker(f)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runAnalysisWorker(mock.deps, { maxItems: 1 })
    const state = (await summaries(f, created.run.id)).comparisons[0]
    assert.equal(state.attempts, attempt)
    assert.equal(state.status, attempt < 3 ? 'queued' : 'failed')
    assert.equal(state.error.code, 'snapshot-unavailable')
    assert.deepEqual(state.published, before.comparisons[0].published)
    if (attempt < 3) {
      assert.equal(Date.parse(state.nextAttemptAt) - Date.parse(f.now), 30_000 * 2 ** (attempt - 1))
      f.now = state.nextAttemptAt
    } else assert.equal(state.nextAttemptAt, null)
  }
  assert.equal(mock.calls.length, 0)
  await runAnalysisWorker(mock.deps, { maxItems: 1 })
  const failed = await summaries(f, created.run.id)
  assert.equal(failed.targets[0].error.code, 'dependency-failed')
  assert.deepEqual(failed.targets[0].published, before.targets[0].published)
  f.analysis.blobs.values.set(name, saved)
  const retry = await generate(f, created.run.id)
  await drainNarrativeRequest(f, created.run.id, retry.requestId)
  assert.equal((await settleNarratives(f, created.run.id, mock)).ready, true)
})

test('cancelled scheduling cleanup cannot overwrite a newer target generation created by a scoring retry', async () => {
  const f = fixture()
  const created = await createRun(f, 2)
  const [first, second] = runComparisons(f, created.run.id)
  await publishResult(f, created.run.id, first.record.id)
  await f.service.comparisonAction(f.workspaceId, created.run.id, second.record.id, 'cancel', second.etag)
  assert.equal((await settleNarratives(f, created.run.id)).ready, true)
  const refresh = await generate(f, created.run.id, 'all')
  const run = await f.analysis.store.get(f.workspaceId, created.run.id)
  await f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag)
  await f.service.comparisonAction(f.workspaceId, created.run.id, second.record.id, 'retry',
    (await f.analysis.store.get(f.workspaceId, second.record.id)).etag)
  const targetId = api.analysisNarrativeId('target', created.run.id, first.record.target.summary.id)
  const target = await f.analysis.store.get(f.workspaceId, targetId)
  assert.equal((await summaries(f, created.run.id)).targets[0].generationId, target.record.generationId)
  await drainNarrativeRequest(f, created.run.id, refresh.requestId)
  assert.equal((await f.analysis.store.get(f.workspaceId, targetId)).record.generationId, target.record.generationId)
  assert.equal((await summaries(f, created.run.id)).comparisons.find(pair => pair.comparisonId === first.record.id).status, 'cancelled')
  await publishResult(f, created.run.id, second.record.id)
  const ready = await settleNarratives(f, created.run.id)
  assert.equal(ready.ready, true)
  assert.equal(ready.scoring.complete, 2)
  assert.equal(ready.targets[0].generationId, target.record.generationId)
})

test('narrative heartbeats preserve scope revisions and same-owner lease takeovers fence the obsolete attempt', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  let entered = false, release
  const waiting = new Promise(resolve => { release = resolve })
  const old = narrativeWorker(f, async ({ kind }) => {
    if (kind === 'analysis_candidate_narrative') { entered = true; await waiting }
  })
  const processing = runAnalysisWorker(old.deps, { maxItems: 1 })
  await until(() => entered)
  const id = api.analysisNarrativeId('candidate', created.run.id, pair.record.id)
  const claimed = await f.analysis.store.get(f.workspaceId, id)
  const revision = (await summaries(f, created.run.id)).revision
  f.now = new Date(Date.parse(f.now) + 30_000).toISOString()
  t.mock.timers.tick(25_000)
  await until(async () => (await f.analysis.store.get(f.workspaceId, id)).record.lease.heartbeatAt === f.now)
  assert.equal((await summaries(f, created.run.id)).revision, revision)
  f.now = new Date(Date.parse(f.now) + 90_001).toISOString()
  const replacement = narrativeWorker(f)
  await runAnalysisWorker(replacement.deps, { maxItems: 1 })
  const ready = await f.analysis.store.get(f.workspaceId, id)
  assert.equal(ready.record.status, 'ready')
  assert.equal(ready.record.attempts, 2)
  assert.notEqual(ready.record.attemptId, claimed.record.attemptId)
  release()
  await processing
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, id), ready)
  assert.equal(await processClaimedNarrative(claimed, replacement.deps), false)
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/narratives/candidate/')).length, 1)
  assert.ok(old.events.some(event => event.outcome === 'abandoned'))
})

test('ambiguous narrative claim, content upload, and publication recover without another model attempt', async () => {
  for (const stage of ['claim', 'upload', 'publication']) {
    const f = fixture()
    const created = await createRun(f)
    await publishResult(f, created.run.id, runComparisons(f, created.run.id)[0].record.id)
    let injected = false
    const failure = () => { injected = true; throw new Error('PRIVATE-AMBIGUOUS-STORAGE-DETAIL') }
    if (stage === 'upload') f.analysis.blobs._afterPut(name => { if (name.includes('/narratives/candidate/')) failure() })
    else {
      const after = operations => {
        if (operations.some(operation => operation.record.recordType === 'analysis-candidate-narrative' &&
          operation.record.status === (stage === 'claim' ? 'running' : 'ready'))) failure()
        f.analysis.store._afterBatch(after)
      }
      f.analysis.store._afterBatch(after)
    }
    const mock = narrativeWorker(f)
    await runAnalysisWorker(mock.deps, { maxItems: 1 })
    const result = await summaries(f, created.run.id)
    assert.equal(injected, true, stage)
    assert.equal(result.comparisons[0].status, 'ready', stage)
    assert.equal(result.comparisons[0].attempts, 1)
    assert.equal(mock.calls.filter(call => call.kind === 'analysis_candidate_narrative').length, 1)
    assert.doesNotMatch(JSON.stringify([result, mock.events]), /PRIVATE-AMBIGUOUS-STORAGE-DETAIL/)
  }
})

test('deletion racing a narrative PUT drains its writer, purges sidecars and receipts, and prevents a stale attempt from recreating bytes', async () => {
  const f = fixture()
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const refresh = await generate(f, created.run.id, 'all')
  await drainNarrativeRequest(f, created.run.id, refresh.requestId)
  const lifecycle = new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(f.now))
  let claimed, entered = false
  f.analysis.blobs._afterPut(async name => {
    if (!name.includes('/narratives/candidate/') || entered) return
    entered = true
    claimed = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', created.run.id, pair.record.id))
    const run = await f.analysis.store.get(f.workspaceId, created.run.id)
    await lifecycle.change(f.workspaceId, created.run.id, 'delete', run.etag, ACTOR)
  })
  const mock = narrativeWorker(f)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 0 })
  assert.equal(entered, true)
  const control = await f.analysis.store.getControl(f.workspaceId, created.run.id)
  assert.equal(control.record.state, 'deleting')
  assert.ok(Object.keys(control.record.writers).length)
  await api.updateAnalysisControl(f.analysis.store, f.workspaceId, created.run.id, value => ({
    ...value, writers: Object.fromEntries(Object.entries(value.writers).map(([id, writer]) => [
      id, { ...writer, expiresAt: '2020-01-01T00:00:00.000Z' },
    ])),
  }))
  await api.createAnalysisLifecycleParticipant(f.analysis).resume(f.workspaceId, f.now)
  assert.equal([...f.analysis.store.values.values()].filter(value => value.record.runId === created.run.id || value.record.id === created.run.id).length, 0)
  assert.equal(f.analysis.blobs.values.size, 0)
  const calls = mock.calls.length
  assert.equal(await processClaimedNarrative(claimed, mock.deps), false)
  assert.equal(mock.calls.length, calls)
  assert.equal(f.analysis.blobs.values.size, 0)
  assert.equal((await f.analysis.store.getControl(f.workspaceId, created.run.id)).record.state, 'deleted')
})
