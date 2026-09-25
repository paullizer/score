import assert from 'node:assert/strict'
import test from 'node:test'
import { api, fixture, createRun, publishResult, startHttp, clone, NOW } from './real-analyses.test-support.mjs'
import { runComparisons, settleNarratives } from './real-analysis-narratives.test-support.mjs'

const summaryStatus = (f, runId, options) => f.service.summaryStatus(f.workspaceId, runId, options)
const publicationBlob = /\/narratives\/(?:candidate|target)\//

async function initializedRun(f, resumes = 1, targets = 1) {
  const created = await createRun(f, resumes, targets), runId = created.run.id
  while ((await f.analysis.store.get(f.workspaceId, runId)).record.progress.initialized < resumes * targets) {
    await api.advanceAnalysisRun(f.analysis, f.workspaceId, runId, { now: () => new Date(f.now), maxChunks: 4 })
  }
  return { ...created, runId, pairs: runComparisons(f, runId) }
}

function observeBlobReads(f) {
  const names = [], read = f.analysis.blobs.read
  f.analysis.blobs.read = async (...args) => { names.push(args[0]); return read(...args) }
  return { names, restore() { f.analysis.blobs.read = read } }
}

test('summary status follows each comparison from scoring through its summary using work metadata only', async () => {
  const f = fixture()
  const { runId, pairs } = await initializedRun(f, 2, 2)
  const queued = await summaryStatus(f, runId, { items: true })
  assert.equal(queued.generation, 'automatic')
  assert.equal(queued.ready, false)
  assert.equal(queued.scope.targetId, null)
  assert.deepEqual(queued.scoring, { total: 4, initialized: 4, queued: 4, running: 0, complete: 0, failed: 0, cancelled: 0 })
  assert.deepEqual(queued.corrections, { pending: 0 })
  assert.equal(queued.counts.candidates.notRequired, 4)
  assert.equal(queued.counts.targets.notRequired, 2)
  assert.ok(queued.comparisons.every(item => item.comparisonStatus === 'queued' && item.resultSha256 === null &&
    item.status === 'not-required' && item.correctionPending === false))

  const [first] = pairs
  const targetId = first.record.target.summary.id
  const { completed } = await publishResult(f, runId, first.record.id)
  const scored = await summaryStatus(f, runId, { items: true })
  assert.deepEqual(scored.comparisons.find(item => item.comparisonId === first.record.id), {
    comparisonId: first.record.id, targetId, comparisonStatus: 'complete', resultSha256: completed.result.sha256,
    correctionPending: false, status: 'queued',
  })
  assert.deepEqual(scored.targets.find(item => item.targetId === targetId), { targetId, status: 'waiting', waitingFor: 'scoring' })
  assert.equal(scored.counts.candidates.queued, 1)
  assert.equal(scored.counts.targets.waiting, 1)
  assert.notEqual(scored.revision, queued.revision)
  const { comparisons, targets, ...totals } = scored
  assert.equal(comparisons.length, 4)
  assert.equal(targets.length, 2)
  const compact = await summaryStatus(f, runId)
  assert.equal('comparisons' in compact || 'targets' in compact, false)
  assert.deepEqual(compact, totals)

  for (const pair of pairs.slice(1)) await publishResult(f, runId, pair.record.id)
  const waiting = await summaryStatus(f, runId, { items: true })
  assert.equal(waiting.scoring.complete, 4)
  assert.equal(waiting.ready, false, 'Scoring alone never makes the run ready while its automatic summaries are pending.')
  assert.ok(waiting.targets.every(item => item.status === 'waiting' && item.waitingFor === 'candidate-narratives'))
  assert.notEqual(waiting.workRevision, scored.workRevision)

  const settled = await settleNarratives(f, runId)
  assert.equal(settled.ready, true)
  const records = clone([...f.analysis.store.values]), blobs = clone([...f.analysis.blobs.values])
  const reads = observeBlobReads(f)
  let ready
  try { ready = await summaryStatus(f, runId, { items: true }) } finally { reads.restore() }
  assert.equal(ready.ready, true)
  assert.equal(ready.revision, settled.revision, 'The status shares the whole-run summary revision.')
  assert.equal(ready.counts.candidates.ready, 4)
  assert.equal(ready.counts.targets.ready, 2)
  assert.ok(ready.comparisons.every(item => item.status === 'ready'))
  assert.ok(ready.targets.every(item => item.status === 'ready' && item.waitingFor === null))
  assert.ok(reads.names.length > 0)
  assert.ok(reads.names.every(name => !publicationBlob.test(name)), reads.names.join('\n'))
  const serialized = JSON.stringify(ready)
  assert.ok(!serialized.includes(settled.comparisons[0].published.text))
  assert.ok(!serialized.includes(settled.targets[0].published.paragraphs[0]))
  assert.deepEqual([...f.analysis.store.values], records)
  assert.deepEqual([...f.analysis.blobs.values], blobs)
})

test('summary status reports each run’s captured summary policy rather than current settings', async () => {
  for (const [change, generation] of [
    [settings => { settings.summaries.generationMode = 'on-demand' }, 'on-demand'],
    [settings => { settings.features.summaryGeneration = false }, 'disabled'],
    [() => {}, 'automatic'],
  ]) {
    const f = fixture(), settings = api.createDefaultAdminSettings()
    change(settings)
    f.service = new api.RealAnalysisService(f.analysis, f, () => new Date(f.now),
      async () => api.captureProcessingSettings(settings, `policy-${generation}`, NOW))
    const { runId, pairs } = await initializedRun(f)
    await publishResult(f, runId, pairs[0].record.id)
    const status = await summaryStatus(f, runId, { items: true })
    assert.equal(status.generation, generation)
    assert.equal(status.ready, false)
    assert.equal(status.comparisons[0].status, generation === 'automatic' ? 'queued' : 'missing')
    assert.equal(status.targets[0].status, generation === 'automatic' ? 'waiting' : 'missing')
    // A later Admin change affects new runs only.
    settings.summaries.generationMode = generation === 'automatic' ? 'on-demand' : 'automatic'
    settings.features.summaryGeneration = true
    assert.equal((await summaryStatus(f, runId)).generation, generation)
  }
})

test('summary status 404s removed, missing and foreign runs', async () => {
  const f = fixture()
  const { runId, pairs } = await initializedRun(f)
  await publishResult(f, runId, pairs[0].record.id)
  await assert.rejects(api.readAnalysisSummaryStatus(f.analysis, 'workspace-other', runId), { status: 404 })
  await assert.rejects(summaryStatus(f, `analysis-run-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`), { status: 404 })
  const run = await f.analysis.store.get(f.workspaceId, runId)
  f.analysis.store.save({ ...run.record, lifecycle: { deletingAt: f.now } })
  await assert.rejects(summaryStatus(f, runId), { status: 404 })
})

test('HTTP summary status is readable by viewers, no-store, and validates its one query parameter', async () => {
  const f = fixture()
  const { runId, pairs } = await initializedRun(f)
  await publishResult(f, runId, pairs[0].record.id)
  const http = await startHttp(f)
  try {
    const suffix = `/${runId}/summary-status`
    const compact = await http.request(suffix, 'GET', undefined, { role: 'viewer' })
    assert.equal(compact.status, 200)
    assert.equal(compact.headers.get('cache-control'), 'no-store')
    const body = await compact.json()
    assert.equal(body.generation, 'automatic')
    assert.equal('comparisons' in body, false)
    const detailed = await (await http.request(`${suffix}?items=true`, 'GET', undefined, { role: 'viewer' })).json()
    assert.equal(detailed.comparisons.length, 1)
    assert.equal(detailed.targets.length, 1)
    assert.equal('comparisons' in await (await http.request(`${suffix}?items=false`)).json(), false)
    assert.equal((await http.request(suffix, 'GET', undefined, { role: 'stranger' })).status, 404)
    for (const query of ['?items=yes', '?items=true&items=true', '?targetId=Role%200']) {
      assert.equal((await http.request(`${suffix}${query}`)).status, 400, query)
    }
    assert.equal((await http.request(`/not-a-run/summary-status`)).status, 404)
  } finally { await http.close() }
})
