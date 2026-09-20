import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { api, fixture, createRun, publishResult, ACTOR, clone } from '../server-tests/real-analyses.test-support.mjs'
import {
  drainNarrativeRequest, narrativeRuntime, narrativeWorker, runComparisons, settleNarratives,
} from '../server-tests/real-analysis-narratives.test-support.mjs'
import { loadWorker } from './shared-model-loader.mjs'

const { runAnalysisWorker, processClaimedNarrative } = await narrativeRuntime()
async function summaries(f, runId, targetId) { return api.readAnalysisSummaries(f.analysis, f.workspaceId, runId, targetId) }
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
  assert.doesNotMatch(JSON.stringify(mock.events), /fake-private-token|submitted document|rubric|paragraphs|blobName/)
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
