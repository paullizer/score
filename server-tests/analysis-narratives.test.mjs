import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { api, fixture, createRun, publishResult, startHttp, ACTOR, clone } from './real-analyses.test-support.mjs'
import {
  drainNarrativeRequest, runComparisons, settleNarratives,
} from './real-analysis-narratives.test-support.mjs'

async function generate(f, runId, mode = 'missing', targetId, key = randomUUID(), expected) {
  const before = await api.readAnalysisSummaries(f.analysis, f.workspaceId, runId, targetId)
  return f.service.generateSummaries(f.workspaceId, runId, { mode, ...(targetId ? { targetId } : {}) }, key, expected ?? before.etag, ACTOR)
}
async function historical(f, resumeCount = 1, targetCount = 1) {
  const created = await createRun(f, resumeCount, targetCount)
  for (const comparison of runComparisons(f, created.run.id)) {
    await publishResult(f, created.run.id, comparison.record.id, false, { scheduleNarratives: false })
  }
  return created
}

test('summary reads are exhaustive, read-only, private, and independent of live source services', async () => {
  const f = fixture()
  const created = await historical(f, 2, 2)
  f.resumeValues.clear(); f.jobValues.clear(); f.rubricValues.clear()
  const records = clone([...f.analysis.store.values]), blobs = clone([...f.analysis.blobs.values])
  const summaries = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id)
  assert.equal(summaries.ready, false)
  assert.deepEqual(summaries.scoring, { total: 4, initialized: 4, queued: 0, running: 0, complete: 4, failed: 0, cancelled: 0 })
  assert.equal(summaries.counts.candidates.missing, 4)
  assert.equal(summaries.counts.targets.missing, 2)
  assert.equal(summaries.capture.comparisons.length, 4)
  assert.equal(summaries.capture.targets.length, 2)
  assert.equal(summaries.capture.revision, summaries.revision)
  assert.ok(summaries.capture.comparisons.every(pair => /^[a-f0-9]{64}$/.test(pair.resultSha256) && pair.narrative === null))
  assert.doesNotMatch(JSON.stringify(summaries), /blobName|requirementEvidence|paragraphId|Engineering systems are designed/)
  assert.deepEqual([...f.analysis.store.values], records)
  assert.deepEqual([...f.analysis.blobs.values], blobs)
  await assert.rejects(api.readAnalysisSummaries(f.analysis, 'workspace-other', created.run.id), { status: 404 })
  await assert.rejects(api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id, 'Role 0'), { status: 400 })
  await assert.rejects(api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id, `target-${'a'.repeat(48)}`), { status: 404 })
})

test('missing coalesces work, all creates new generations, and durable receipts never replay older requests', async () => {
  const f = fixture()
  const created = await historical(f)
  const pair = runComparisons(f, created.run.id)[0]
  const scoring = clone(pair), bytes = clone(f.analysis.blobs.values.get(pair.record.result.blobName))
  const before = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id)
  const key = randomUUID()
  const first = await generate(f, created.run.id, 'missing', undefined, key, before.etag)
  assert.deepEqual(first.scheduled, { candidates: 1, targets: 1 })
  assert.equal(first.summaries.counts.candidates.queued, 1)
  assert.equal(first.summaries.targets[0].status, 'waiting')
  const duplicate = await generate(f, created.run.id, 'missing', undefined, key, before.etag)
  assert.equal(duplicate.summaries.comparisons[0].generationId, first.summaries.comparisons[0].generationId)
  assert.deepEqual((await generate(f, created.run.id)).scheduled, { candidates: 0, targets: 0 })
  await drainNarrativeRequest(f, created.run.id, key)
  const ready = await settleNarratives(f, created.run.id)
  assert.equal(ready.ready, true, JSON.stringify(ready))
  assert.ok(ready.comparisons[0].published.text.endsWith('.'))
  assert.ok(ready.comparisons[0].published.overview.endsWith('.'))
  assert.ok(ready.targets[0].published.paragraphs.length)
  assert.deepEqual((await f.service.summarySubject(f.workspaceId, created.run.id,
    { kind: 'candidate', subjectId: pair.record.id })).narrative, ready.comparisons[0])
  assert.deepEqual((await f.service.summarySubject(f.workspaceId, created.run.id,
    { kind: 'target', subjectId: ready.targets[0].targetId })).narrative, ready.targets[0])
  assert.deepEqual((await generate(f, created.run.id)).scheduled, { candidates: 0, targets: 0 })
  const refresh = await generate(f, created.run.id, 'all')
  assert.deepEqual(refresh.scheduled, { candidates: 1, targets: 1 })
  assert.equal(refresh.summaries.ready, false)
  assert.notEqual(refresh.summaries.comparisons[0].generationId, ready.comparisons[0].generationId)
  assert.deepEqual(refresh.summaries.comparisons[0].published, ready.comparisons[0].published)
  assert.deepEqual(refresh.summaries.targets[0].published, ready.targets[0].published)
  await drainNarrativeRequest(f, created.run.id, refresh.requestId)
  const refreshed = await settleNarratives(f, created.run.id)
  assert.equal(refreshed.ready, true)
  assert.notEqual(refreshed.comparisons[0].published.revision, ready.comparisons[0].published.revision)
  const replay = await generate(f, created.run.id, 'missing', undefined, key, before.etag)
  assert.equal(replay.summaries.revision, refreshed.revision)
  assert.equal(replay.summaries.comparisons[0].generationId, refreshed.comparisons[0].generationId)
  await assert.rejects(generate(f, created.run.id, 'all', undefined, key, before.etag), { status: 409 })
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, pair.record.id), scoring)
  assert.deepEqual(f.analysis.blobs.values.get(pair.record.result.blobName), bytes)
})

test('scope ETags bind exact selected generations and ignore heartbeats and independent target work', async () => {
  const f = fixture()
  const created = await historical(f, 1, 2)
  const request = await generate(f, created.run.id)
  await drainNarrativeRequest(f, created.run.id, request.requestId)
  assert.equal((await settleNarratives(f, created.run.id)).ready, true)
  const all = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id)
  const [first, second] = all.targets.map(target => target.targetId)
  const selected = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id, first)
  let run = await f.analysis.store.get(f.workspaceId, created.run.id)
  f.now = new Date(Date.parse(f.now) + 1).toISOString()
  await f.analysis.store.replace({ ...run.record, updatedAt: f.now }, run.etag)
  assert.equal((await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id, first)).etag, selected.etag)
  await generate(f, created.run.id, 'all', second)
  const after = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id, first)
  assert.equal(after.etag, selected.etag)
  assert.equal(after.ready, true)
  assert.deepEqual(after.capture, selected.capture)
  assert.equal((await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id)).ready, false)
  run = await f.analysis.store.get(f.workspaceId, created.run.id)
  await assert.rejects(generate(f, created.run.id, 'all', first, randomUUID(), run.etag), { status: 400 })
  await assert.rejects(generate(f, created.run.id, 'all', first, randomUUID(), all.etag), { status: 409 })
})

test('a settled target stays independently ready while another target resumes scoring, and zero-completed overviews are not required', async () => {
  const f = fixture()
  const created = await createRun(f, 1, 2)
  const [first, second] = runComparisons(f, created.run.id)
  await publishResult(f, created.run.id, first.record.id)
  await f.service.comparisonAction(f.workspaceId, created.run.id, second.record.id, 'cancel', second.etag)
  assert.equal((await settleNarratives(f, created.run.id)).ready, true)
  const selected = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id, first.record.target.summary.id)
  const empty = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id, second.record.target.summary.id)
  assert.equal(empty.ready, true)
  assert.equal(empty.counts.targets.notRequired, 1)
  assert.equal(empty.capture.targets[0].narrative, null)
  await f.service.comparisonAction(f.workspaceId, created.run.id, second.record.id, 'retry',
    (await f.analysis.store.get(f.workspaceId, second.record.id)).etag)
  const pending = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id, second.record.target.summary.id)
  assert.equal(pending.ready, false)
  assert.equal(pending.scoring.queued, 1)
  assert.equal(pending.counts.targets.notRequired, 1, 'A pending score blocks readiness without inventing a zero-score overview.')
  assert.deepEqual((await generate(f, created.run.id, 'missing', second.record.target.summary.id)).scheduled, { candidates: 0, targets: 0 })
  const unchanged = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id, first.record.target.summary.id)
  assert.equal(unchanged.ready, true)
  assert.deepEqual(unchanged.capture, selected.capture)
  assert.equal((await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id)).ready, false)
})

test('paused failed initialization never becomes summary-ready or silently schedules missing scoring work', async () => {
  const f = fixture()
  const created = await createRun(f, 100)
  const current = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.ok(current.record.progress.initialized < current.record.progress.total)
  const paused = { ...current.record, status: 'failed', attempts: 1, attemptId: randomUUID(),
    error: { code: 'snapshot-invalid', stage: 'initialization', message: 'The saved snapshot is invalid.', retryable: false } }
  delete paused.lease
  delete paused.nextAttemptAt
  await f.analysis.store.replace(paused, current.etag)
  const before = clone([...f.analysis.store.values])
  const summary = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id)
  assert.equal(summary.ready, false)
  assert.equal(summary.scoring.total, 100)
  assert.equal(summary.scoring.initialized, paused.progress.initialized)
  assert.equal(summary.counts.candidates.notRequired, 100)
  assert.equal(summary.counts.targets.notRequired, 1)
  assert.deepEqual([...f.analysis.store.values], before)
  assert.deepEqual((await generate(f, created.run.id)).scheduled, { candidates: 0, targets: 0 })
  assert.equal((await f.analysis.store.listPending(f.now, 100)).length, 0)
})

test('narrative schemas reject foreign identities, invalid paths, result rebinding and unsafe work states', async () => {
  const f = fixture()
  const created = await createRun(f)
  const pair = runComparisons(f, created.run.id)[0]
  await publishResult(f, created.run.id, pair.record.id)
  const id = api.analysisNarrativeId('candidate', created.run.id, pair.record.id)
  const current = await f.analysis.store.get(f.workspaceId, id)
  assert.equal(api.isAnalysisRecordId(id), true)
  const attemptId = randomUUID()
  const blob = api.analysisNarrativeBlobName(f.workspaceId, created.run.id, 'candidate', pair.record.id, current.record.generationId, attemptId)
  assert.equal(api.analysisBlobInRun(blob, f.workspaceId, created.run.id), true)
  assert.equal(api.analysisBlobInRun(blob, 'workspace-neighbor', created.run.id), false)
  for (const bad of [blob.replace('/candidate/', '/other/'), blob.replace(/\.json$/, '.txt'), `${blob}/extra`,
    blob.replace(`/${current.record.generationId}/`, '/../../'), blob.replace('/narratives/', '/results/')]) {
    assert.equal(api.isSafeAnalysisBlobName(bad), false, bad)
  }
  for (const change of [
    { id: `${id}:foreign` }, { status: 'ready' }, { status: 'running' },
    { status: 'waiting', inputFingerprint: null, waitingFor: 'scoring' }, { resultSha256: 'bad' },
    { privateSourceParagraphs: ['not accepted'] },
  ]) assert.throws(() => api.parseAnalysisEntity({ ...current.record, ...change }))
  assert.throws(() => api.assertAnalysisReplacement(current.record, { ...current.record, resultSha256: '0'.repeat(64) }), /immutable/)
  const completed = await f.analysis.store.get(f.workspaceId, pair.record.id)
  assert.throws(() => api.assertAnalysisReplacement(completed.record, { ...completed.record, updatedAt: new Date(Date.parse(f.now) + 1).toISOString() }), /Completed evidence/)
})

test('persisted synthesis provenance binds every review to its exact input/output pair and frozen comparison subset', async () => {
  const f = fixture()
  const created = await createRun(f)
  await publishResult(f, created.run.id, runComparisons(f, created.run.id)[0].record.id)
  const ready = await settleNarratives(f, created.run.id)
  assert.equal(ready.ready, true)
  const target = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('target', created.run.id, ready.targets[0].targetId))
  const artifact = await api.readAnalysisNarrativePublication(f.analysis.blobs, target.record)
  assert.equal(artifact.kind, 'target')
  // Keep exercising the immutable v1 reader after new workers begin publishing v2 summaries.
  artifact.schemaVersion = 1
  delete artifact.approval
  delete artifact.history
  artifact.paragraphs = ['The saved analysis records engineering evidence for human review.']
  artifact.claims = [{ id: 'legacy-claim', location: { field: 'paragraphs', paragraphIndex: 0, sentenceIndex: 0 },
    references: [{ kind: 'coverage', comparisonId: artifact.binding.comparisons[0].comparisonId }] }]
  artifact.provenance.outputSha256 = api.analysisHash({ paragraphs: artifact.paragraphs, claims: artifact.claims })
  artifact.provenance.groundingReviews = [{ ...artifact.provenance.groundingReviews.at(-1), outputSha256: artifact.provenance.outputSha256 }]
  const finalReview = artifact.provenance.groundingReviews.at(-1)
  const steps = [1, 2].map(index => ({
    comparisonIds: artifact.binding.comparisons.map(pair => pair.comparisonId),
    inputFingerprint: api.analysisHash({ input: index }), outputSha256: api.analysisHash({ output: index }),
    provenance: clone(artifact.provenance.generation),
  }))
  artifact.provenance.synthesis = steps
  artifact.provenance.groundingReviews = [
    ...steps.map(step => ({
      ...clone(finalReview), id: `review-${randomUUID()}`, inputFingerprint: step.inputFingerprint, outputSha256: step.outputSha256,
    })),
    finalReview,
  ]
  assert.ok(artifact.provenance.groundingReviews.length > artifact.provenance.correctionCount + 1)
  assert.doesNotThrow(() => api.parseAnalysisNarrativeArtifact(artifact))
  for (const change of [
    value => { value.provenance.groundingReviews[0].outputSha256 = steps[1].outputSha256 },
    value => { value.provenance.groundingReviews.shift() },
    value => { value.provenance.synthesis[0].comparisonIds = [`analysis-comparison-${randomUUID()}`] },
    value => { value.provenance.synthesis[0].comparisonIds.push(value.provenance.synthesis[0].comparisonIds[0]) },
    value => { value.provenance.synthesis[0].provenance.completedAt = new Date(Date.parse(value.createdAt) + 1).toISOString() },
    value => { value.provenance.groundingReviews.at(-1).outputSha256 = steps[0].outputSha256 },
  ]) {
    const invalid = clone(artifact)
    change(invalid)
    assert.throws(() => api.parseAnalysisNarrativeArtifact(invalid), /grounding/)
  }
  for (const count of [1001, 1002]) {
    const bounded = clone(artifact)
    bounded.provenance.correctionCount = 2
    bounded.provenance.synthesis = Array.from({ length: count }, (_, index) => ({
      ...clone(steps[0]), inputFingerprint: api.analysisHash({ reduction: index }),
    }))
    bounded.provenance.groundingReviews = [
      ...bounded.provenance.synthesis.map((step, index) => ({
        ...clone(finalReview), id: `reduction-review-${index}`,
        inputFingerprint: step.inputFingerprint, outputSha256: step.outputSha256,
      })),
      clone(finalReview),
    ]
    assert.doesNotThrow(() => api.parseAnalysisNarrativeArtifact(bounded), `${count} exact reviewed reductions must not be truncated.`)
    if (count === 1002) {
      bounded.provenance.synthesis.push(clone(bounded.provenance.synthesis[0]))
      assert.throws(() => api.parseAnalysisNarrativeArtifact(bounded), error =>
        error.issues?.some(issue => issue.path.join('.') === 'provenance.synthesis' && issue.code === 'too_big' && issue.maximum === 1002))
    }
  }
})

test('HTTP summaries authorize exact read/write scopes, no-store, CSRF, UUID idempotency and summary ETags', async () => {
  const f = fixture()
  const created = await historical(f)
  const http = await startHttp(f)
  try {
    const suffix = `/${created.run.id}/summaries`
    const read = await http.request(suffix, 'GET', undefined, { role: 'viewer' })
    assert.equal(read.status, 200)
    assert.equal(read.headers.get('cache-control'), 'no-store')
    const summary = await read.json()
    assert.equal(read.headers.get('etag'), summary.etag)
    assert.deepEqual(summary.capabilities, { canGenerate: false, reason: 'read-only' })
    assert.equal((await http.request(suffix, 'GET', undefined, { role: 'stranger' })).status, 404)
    assert.equal((await http.request(`${suffix}?targetId=x&targetId=y`)).status, 400)
    const headers = { 'if-match': summary.etag, 'idempotency-key': randomUUID() }
    assert.equal((await http.request(suffix, 'POST', { mode: 'missing' }, { role: 'viewer', headers })).status, 403)
    assert.equal((await http.request(suffix, 'POST', { mode: 'missing' }, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403)
    assert.equal((await http.request(suffix, 'POST', { mode: 'missing' }, { headers: { 'idempotency-key': randomUUID() } })).status, 428)
    assert.equal((await http.request(suffix, 'POST', { mode: 'missing' }, { headers: { ...headers, 'idempotency-key': 'unstable' } })).status, 400)
    assert.equal((await http.request(suffix, 'POST', { mode: 'all', targetLabel: 'Role 0' }, { headers })).status, 400)
    const accepted = await http.request(suffix, 'POST', { mode: 'missing' }, { headers })
    assert.equal(accepted.status, 202)
    const result = await accepted.json()
    assert.deepEqual(result.scheduled, { candidates: 1, targets: 1 })
    assert.equal(accepted.headers.get('etag'), result.summaries.etag)
    assert.equal(f.mutationLeases.active, 0)
    assert.ok(f.mutationLeases.acquired > 0)
    const replay = await http.request(suffix, 'POST', { mode: 'missing' }, { headers })
    assert.equal(replay.status, 202)
    assert.equal((await replay.json()).requestId, result.requestId)
  } finally { await http.close() }
})

test('ambiguous request acceptance and scheduling retain one receipt and durable bounded progress', async () => {
  const f = fixture()
  const created = await historical(f, 3)
  const initial = await api.readAnalysisSummaries(f.analysis, f.workspaceId, created.run.id)
  const key = randomUUID()
  let uploadFailed = false
  f.analysis.blobs._afterPut(name => {
    if (name.includes('/narratives/requests/') && !uploadFailed) {
      uploadFailed = true
      throw new Error('ambiguous immutable request plan')
    }
  })
  f.analysis.store._afterBatch(() => { throw new Error('ambiguous accepted request') })
  const result = await generate(f, created.run.id, 'all', undefined, key, initial.etag)
  assert.equal(uploadFailed, true)
  f.analysis.store._afterBatch(() => { throw new Error('ambiguous scheduler chunk') })
  await drainNarrativeRequest(f, created.run.id, key)
  const receipt = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('request', created.run.id, key))
  assert.equal(receipt.record.status, 'complete')
  assert.equal(receipt.record.nextIndex, 4)
  assert.equal([...f.analysis.store.values.values()].filter(value => value.record.recordType === 'analysis-narrative-request').length, 1)
  assert.deepEqual((await generate(f, created.run.id, 'all', undefined, key, initial.etag)).scheduled, result.scheduled)
  const before = clone([...f.analysis.store.values])
  assert.equal(await api.advanceAnalysisNarrativeRequest(f.analysis, f.workspaceId, created.run.id, key), false)
  assert.deepEqual([...f.analysis.store.values], before)
})

test('all 500 completed comparisons schedule exhaustively through bounded durable chunks without changing result bytes', async () => {
  const f = fixture()
  const created = await createRun(f, 500)
  while ((await f.analysis.store.get(f.workspaceId, created.run.id)).record.progress.initialized < 500) {
    await api.advanceAnalysisRun(f.analysis, f.workspaceId, created.run.id, { now: () => new Date(f.now), maxChunks: 4 })
  }
  for (const pair of runComparisons(f, created.run.id)) {
    await publishResult(f, created.run.id, pair.record.id, false, { scheduleNarratives: false })
  }
  const comparisons = clone(runComparisons(f, created.run.id))
  const results = comparisons.map(pair => [pair.record.result.blobName, api.analysisBytesHash(f.analysis.blobs.values.get(pair.record.result.blobName).bytes)])
  const request = await generate(f, created.run.id, 'all')
  assert.deepEqual(request.scheduled, { candidates: 500, targets: 1 })
  assert.equal(request.summaries.counts.candidates.queued, 500)
  assert.equal(request.summaries.capture.comparisons.length, 500)
  await api.advanceAnalysisNarrativeRequest(f.analysis, f.workspaceId, created.run.id, request.requestId, () => new Date(f.now))
  let receipt = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('request', created.run.id, request.requestId))
  assert.equal(receipt.record.nextIndex, 24)
  assert.equal(receipt.record.status, 'queued')
  await drainNarrativeRequest(f, created.run.id, request.requestId)
  receipt = await f.analysis.store.get(f.workspaceId, receipt.record.id)
  assert.equal(receipt.record.nextIndex, 501)
  assert.equal(receipt.record.status, 'complete')
  const children = [...f.analysis.store.values.values()].filter(value => value.record.recordType === 'analysis-candidate-narrative')
  assert.equal(children.length, 500)
  assert.equal(new Set(children.map(value => value.record.comparisonId)).size, 500)
  assert.deepEqual(runComparisons(f, created.run.id), comparisons)
  for (const [name, hash] of results) assert.equal(api.analysisBytesHash(f.analysis.blobs.values.get(name).bytes), hash)
  assert.ok(f.analysis.store.batches.every(batch => batch.length <= 26 && Buffer.byteLength(JSON.stringify(batch)) <= api.MAX_ANALYSIS_TRANSACTION_BYTES))
})
