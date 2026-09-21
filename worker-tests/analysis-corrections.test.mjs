import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { api, fixture, seedJob, seedResume, citation, clone, ACTOR } from '../server-tests/real-analyses.test-support.mjs'

const bundle = path.resolve('dist-worker', `analysis-corrections-test-${process.pid}-${randomUUID()}.mjs`)
await mkdir(path.dirname(bundle), { recursive: true })
await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: [
      "export * from './worker/analyses/correction-runtime.ts';",
      "export { runAnalysisWorker } from './worker/analyses/runtime.ts';",
      "export * from './server/analyses/corrections.ts';",
      "export * from './server/analyses/correction-validation.ts';",
      "export { ANALYSIS_CORRECTION_POLICY_VERSION } from './src/domain/analysis-corrections.ts';",
    ].join('\n'),
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
})
const correction = await import(pathToFileURL(bundle).href)
after(async () => { await unlink(bundle) })

// Isolate the correction queue while retaining the shared fixture's schema, progress,
// transaction, and lifecycle checks.
function correctionTransactions(f) {
  const store = f.analysis.store
  const transact = store.transact.bind(store)
  const pending = store.listPending.bind(store)
  let before
  let afterBatch
  store.transact = async (workspaceId, operations, options) => {
    if (!operations.some(item => item.record.recordType === 'analysis-correction')) return transact(workspaceId, operations, options)
    if (before) { const callback = before; before = undefined; await callback(operations) }
    assert.ok(operations.every(item => item.record.recordType !== 'analysis-comparison'),
      'A correction must never rewrite the original comparison.')
    await transact(workspaceId, operations, options)
    if (afterBatch) { const callback = afterBatch; afterBatch = undefined; await callback(operations) }
  }
  store.listPending = async (now, limit) => (await pending(now, 100))
    .filter(({ record }) => record.recordType === 'analysis-correction').slice(0, limit)
  return {
    before(callback) { before = callback },
    after(callback) { afterBatch = callback },
  }
}

async function correctionFixture() {
  const f = fixture()
  f.analysis.evidenceCorrectionsEnabled = true
  const resume = await seedResume(f)
  const job = await seedJob(f)
  job.document.paragraphs.push(
    { id: 'job-data', page: 1, heading: 'Data practices', text: 'Document case-record handling safeguards and retention procedures.' },
    { id: 'job-advising', page: 1, heading: 'Advising', text: 'Advise project teams on statistical sampling and uncertainty.' },
  )
  f.jobs.blobs.values.delete(job.record.extractedBlobName)
  const document = await api.putAnalysisJson(f.jobs.blobs, job.record.extractedBlobName, job.document)
  const engineering = { ...job.rubric.criteria[0], weight: 60 }
  job.rubric.criteria = [
    engineering,
    ...[['data-practices', 'Data practices', 1], ['statistical-advising', 'Statistical advising', 2]].map(([id, label, index]) => ({
      ...engineering, id, label, description: job.document.paragraphs[index].text, weight: 20,
      sourceCitations: [citation(job.document, job.document.paragraphs[index])],
    })),
  ]
  f.rubricValues.set(`${f.workspaceId}/${job.record.id}`, [job.rubric])
  job.selection = { ...job.selection, documentSha256: document.sha256, rubricHash: api.analysisHash(job.rubric) }
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Synthetic evidence correction', resumes: [resume.selection], targets: [job.selection],
  }, ACTOR)
  f.runId = created.run.id
  const original = [...f.analysis.store.values.values()].find(item => item.record.recordType === 'analysis-comparison')
  f.comparisonId = original.record.id
  f.snapshots = await api.readAnalysisSnapshots(f.analysis.blobs, created.run, original.record)
  const criteria = job.rubric.criteria.map((row, index) => {
    const common = { criterionId: row.id, weight: row.weight, requirementCitations: row.sourceCitations }
    return index === 0
      ? { ...common, evidenceStatus: 'supported', score: 4, citations: [citation(resume.document)], rationale: 'The document describes independent engineering analysis.' }
      : {
        ...common, evidenceStatus: 'not-assessed', score: null,
        citations: index === 2 ? [citation(resume.document)] : [],
        rationale: 'The submitted document does not explicitly describe this separate professional practice.',
        limitation: { code: 'not-assessable', message: 'No explicit supporting practice is described in the submitted document.', criterionId: row.id },
      }
  })
  const assessment = {
    criteria, qualifications: [], summary: 'The submitted document was compared with the saved professional requirements.',
    limitations: criteria.flatMap(row => row.limitation ? [row.limitation] : []),
  }
  const attemptId = randomUUID()
  const assessmentSha256 = api.analysisHash(assessment)
  const model = {
    model: 'synthetic-original-assessor', deployment: 'synthetic-assessment', promptVersion: 'legacy-assessment-v1',
    schemaVersion: '1', startedAt: f.now, completedAt: f.now, inputCharacters: 1000,
  }
  const result = api.parseAnalysisResult({
    ...assessment, ...api.calculateAnalysisSummary(criteria, [], assessment.limitations),
    schemaVersion: 1, dataKind: 'real', workspaceId: f.workspaceId, runId: f.runId, comparisonId: f.comparisonId,
    createdAt: f.now, humanReviewRequired: true, provenance: {
      attemptId, manifestSha256: created.run.manifest.sha256, assessmentSha256, assessment: model,
      resumeSnapshot: { snapshotId: original.record.resume.snapshotId, sha256: original.record.resume.blob.sha256 },
      targetSnapshot: { snapshotId: original.record.target.snapshotId, sha256: original.record.target.blob.sha256 },
      groundingReviews: [{
        id: `original-review-${randomUUID()}`, outcome: 'supported', issues: [], assessmentSha256,
        resumeSnapshotSha256: original.record.resume.blob.sha256, targetSnapshotSha256: original.record.target.blob.sha256,
        provenance: { ...model, model: 'synthetic-original-reviewer' },
      }], correctionCount: 0, calculationVersion: 'weighted-0-100-v1',
    },
  })
  const reference = await api.putAnalysisJson(f.analysis.blobs, api.analysisResultBlobName(f.workspaceId, f.runId, f.comparisonId, attemptId), result)
  const complete = {
    ...original.record, status: 'complete', attempts: 1, attemptId, result: reference, completedAt: f.now,
    resultSummary: { completion: result.completion, overall: result.overall, coverage: result.coverage },
  }
  delete complete.nextAttemptAt
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: complete, etag: original.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(created.run, original.record, complete, f.now), etag: created.etag },
  ])
  f.original = await f.analysis.store.get(f.workspaceId, f.comparisonId)
  f.originalResult = clone(result)
  f.originalBlob = clone(f.analysis.blobs.values.get(reference.blobName))
  f.transactions = correctionTransactions(f)
  f.resumeValues.clear(); f.jobValues.clear(); f.rubricValues.clear()
  f.resumes.blobs.values.clear(); f.jobs.blobs.values.clear()
  return f
}

async function head(f) {
  return correction.loadAnalysisCorrection(f.analysis.store, f.workspaceId, f.runId, f.comparisonId)
}
async function enqueue(f, criterionIds = ['data-practices', 'statistical-advising'], mutate) {
  const run = await f.analysis.store.get(f.workspaceId, f.runId)
  const previous = await head(f)
  const effective = correction.projectAnalysisComparison(f.original.record, previous?.record)
  const base = await api.readAnalysisResult(f.analysis.blobs, run.record, effective, f.snapshots)
  const requestId = randomUUID()
  f.now = new Date(Math.max(Date.parse(f.now), Date.parse(run.record.updatedAt)) + 1).toISOString()
  const input = { resultSha256: effective.result.sha256, criterionIds, reason: 'Review only the selected missing professional evidence.' }
  const requestFingerprint = correction.analysisCorrectionFingerprint(f.workspaceId, f.runId, f.comparisonId, input, ACTOR)
  const assessment = correction.buildEvidenceCorrectionAssessment(base, f.snapshots.targetSnapshot, criterionIds)
  const proposal = {
    schemaVersion: 1, dataKind: 'real', workspaceId: f.workspaceId, runId: f.runId, comparisonId: f.comparisonId,
    createdAt: f.now, requestId, requestFingerprint, expectedEtag: previous?.etag ?? f.original.etag,
    manifestSha256: run.record.manifest.sha256, originalResultSha256: f.original.record.result.sha256,
    baseResult: effective.result, baseAttemptId: effective.attemptId,
    ...(effective.resultRevision ? { baseRevision: effective.resultRevision } : {}),
    resumeSnapshot: base.provenance.resumeSnapshot, targetSnapshot: base.provenance.targetSnapshot,
    provenance: {
      requestId, policyVersion: correction.ANALYSIS_CORRECTION_POLICY_VERSION,
      originalResultSha256: f.original.record.result.sha256, baseResultSha256: effective.result.sha256,
      baseAssessmentSha256: base.provenance.assessmentSha256, criterionIds, requestedBy: ACTOR, requestedAt: f.now, reason: input.reason,
    },
    assessment, summary: api.calculateAnalysisSummary(assessment.criteria, assessment.qualifications, assessment.limitations),
  }
  mutate?.(proposal)
  const reference = await api.putAnalysisJson(f.analysis.blobs,
    api.analysisCorrectionProposalBlobName(f.workspaceId, f.runId, f.comparisonId, requestId), proposal)
  const record = {
    id: api.analysisCorrectionId(f.runId, f.comparisonId), recordType: 'analysis-correction',
    workspaceId: f.workspaceId, runId: f.runId, comparisonId: f.comparisonId, dataKind: 'real',
    createdAt: previous?.record.createdAt ?? f.now, updatedAt: f.now, requestedAt: f.now, requestedBy: ACTOR,
    reason: input.reason, requestId, requestFingerprint, policyVersion: correction.ANALYSIS_CORRECTION_POLICY_VERSION,
    manifestSha256: proposal.manifestSha256, originalResult: f.original.record.result,
    resumeSnapshot: proposal.resumeSnapshot, targetSnapshot: proposal.targetSnapshot, criterionIds,
    baseResult: proposal.baseResult, baseAttemptId: proposal.baseAttemptId, ...(proposal.baseRevision ? { baseRevision: proposal.baseRevision } : {}),
    proposal: reference, status: 'queued', attempts: 0, retryCount: previous ? previous.record.retryCount + 1 : 0, nextAttemptAt: f.now,
    ...(previous?.record.published ? { published: previous.record.published } : {}),
    ...(previous?.record.history ? { history: previous.record.history } : {}),
  }
  await f.analysis.store.transact(f.workspaceId, [
    previous ? { kind: 'replace', record, etag: previous.etag } : { kind: 'create', record },
    { kind: 'replace', record: { ...run.record, updatedAt: f.now }, etag: run.etag },
  ])
  return proposal
}

function workerFor(f, handler) {
  const calls = []
  const events = []
  const clock = {
    now: () => new Date(f.now),
    async sleep(milliseconds, signal) {
      signal?.throwIfAborted()
      f.now = new Date(Date.parse(f.now) + milliseconds).toISOString()
    },
  }
  const deps = {
    ...f.analysis, clock, owner: 'correction-test-worker', correctionsEnabled: true,
    onEvent(event) { events.push(event) },
    model: {
      endpoint: 'https://correction-test.openai.azure.com', deployment: 'synthetic-review', modelName: 'gpt-5-mini',
      getToken: async () => 'SYNTHETIC-PRIVATE-TOKEN',
      async fetch(_url, init) {
        const request = JSON.parse(init.body)
        const call = { kind: request.response_format.json_schema.name, body: JSON.parse(request.messages[1].content), signal: init.signal }
        calls.push(call)
        assert.equal(call.kind, 'resume_rubric_grounding_review', 'Correction work must never call assessment or rewrite scores.')
        const value = await handler?.(call, calls.length) ?? { outcome: 'supported', issues: [] }
        if (value instanceof Response) return value
        return Response.json({ model: 'synthetic-independent-reviewer', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })
      },
    },
  }
  return { deps, calls, events, run: options => correction.runAnalysisWorker(deps, { maxItems: 1, ...options }) }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Expected bounded asynchronous correction progress.')
}
async function historyEntry(f, reference = undefined) {
  const selected = reference ?? (await head(f)).record.history
  return correction.parseAnalysisCorrectionHistoryEntry(api.parseAnalysisJson(await api.readAnalysisBlob(
    f.analysis.blobs, selected.blob, f.workspaceId, f.runId,
  )))
}
async function assertOriginal(f) {
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, f.comparisonId), f.original)
  assert.deepEqual(f.analysis.blobs.values.get(f.original.record.result.blobName), f.originalBlob)
}
async function cancel(f) {
  const current = await head(f)
  const run = await f.analysis.store.get(f.workspaceId, f.runId)
  const record = { ...current.record, status: 'cancelled', updatedAt: f.now }
  delete record.lease; delete record.nextAttemptAt; delete record.error
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record, etag: current.etag },
    { kind: 'replace', record: { ...run.record, updatedAt: f.now }, etag: run.etag },
  ])
}

test('correction dispatch requires an explicit enabled flag and does not restart completed comparison scoring', async () => {
  const f = await correctionFixture()
  await enqueue(f)
  const queued = await head(f)
  const worker = workerFor(f)
  for (const enabled of [undefined, false, 'true']) assert.deepEqual(
    await correction.runAnalysisWorker({ ...worker.deps, correctionsEnabled: enabled }), { claimed: 0, completed: 0 },
  )
  assert.equal(worker.calls.length, 0)
  assert.deepEqual(await head(f), queued)
  assert.equal((await f.analysis.store.get(f.workspaceId, f.runId)).record.status, 'complete')
  await assertOriginal(f)
})

test('an exact independently supported proposal publishes a separate revision, immutable review history, and revision-bound narratives', async () => {
  const f = await correctionFixture()
  const proposal = await enqueue(f)
  const worker = workerFor(f)
  assert.deepEqual(await worker.run(), { claimed: 1, completed: 0 })
  const saved = (await head(f)).record
  assert.equal(saved.status, 'ready', JSON.stringify(saved.error))
  assert.equal(worker.calls.length, 1)
  assert.deepEqual(worker.calls[0].body.assessment, proposal.assessment)
  assert.equal(saved.published.revision.baseResultSha256, f.original.record.result.sha256)
  const run = (await f.analysis.store.get(f.workspaceId, f.runId)).record
  const projected = correction.projectAnalysisComparison(f.original.record, saved)
  const result = await api.readAnalysisResult(f.analysis.blobs, run, projected, f.snapshots)
  assert.deepEqual(result.overall, { status: 'available', score: 48 })
  assert.deepEqual(result.criteria[0], f.originalResult.criteria[0])
  assert.deepEqual(result.criteria.slice(1).map(row => [row.score, row.evidenceStatus, row.citations]), [[0, 'missing', []], [0, 'missing', []]])
  assert.deepEqual(result.provenance.assessment, f.originalResult.provenance.assessment)
  assert.deepEqual(result.provenance.correction, proposal.provenance)
  assert.equal(result.provenance.groundingReviews.length, 1)
  assert.equal(result.provenance.groundingReviews[0].assessmentSha256, result.provenance.assessmentSha256)
  assert.notEqual(result.provenance.groundingReviews[0].id, f.originalResult.provenance.groundingReviews[0].id)
  assert.ok(result.provenance.groundingReviews[0].provenance.startedAt >= proposal.provenance.requestedAt)
  assert.ok(result.provenance.groundingReviews[0].provenance.completedAt <= result.createdAt)
  assert.notEqual(result.provenance.assessmentSha256, f.originalResult.provenance.assessmentSha256)
  const history = await historyEntry(f)
  assert.deepEqual(history.review, result.provenance.groundingReviews[0])
  assert.deepEqual(history.result, saved.published.result)
  assert.ok(history.createdAt >= result.createdAt)
  assert.equal(run.progress.scored, 1)
  assert.equal(run.progress.unscored, 0)
  const batch = f.analysis.store.batches.find(items => items.some(item => item.record.recordType === 'analysis-correction' && item.record.status === 'ready'))
  const narrative = batch.find(item => item.record.recordType === 'analysis-candidate-narrative').record
  assert.equal(narrative.resultSha256, saved.published.result.sha256)
  assert.equal(narrative.resultRevisionId, proposal.requestId)
  assert.ok(batch.some(item => item.record.recordType === 'analysis-target-narrative'))
  assert.doesNotMatch(JSON.stringify(worker.events), /SYNTHETIC-PRIVATE-TOKEN|paragraphs|rationale|blobName/)
  await assertOriginal(f)
})

test('a later correction binds the previous revision and preserves all prior numeric rows and history', async () => {
  const f = await correctionFixture()
  await enqueue(f, ['data-practices'])
  const worker = workerFor(f)
  await worker.run()
  const first = (await head(f)).record
  assert.equal(first.status, 'ready')
  assert.equal(first.published.summary.overall.status, 'withheld')
  const proposal = await enqueue(f, ['statistical-advising'])
  assert.equal(proposal.baseResult.sha256, first.published.result.sha256)
  assert.deepEqual((await head(f)).record.published, first.published)
  await worker.run()
  const second = (await head(f)).record
  assert.equal(second.status, 'ready')
  assert.equal(second.published.summary.overall.score, 48)
  assert.deepEqual((await historyEntry(f)).previous, first.history)
  assert.equal(second.published.revision.originalResultSha256, f.original.record.result.sha256)
  assert.equal(second.published.revision.baseResultSha256, first.published.result.sha256)
  await assertOriginal(f)
})

test('non-supported grounding is terminal, records exact findings, and retains the previous current publication', async () => {
  for (const outcome of ['needs-correction', 'unsupported']) {
    const f = await correctionFixture()
    await enqueue(f, ['data-practices'])
    await workerFor(f).run()
    const prior = (await head(f)).record
    const proposal = await enqueue(f, ['statistical-advising'])
    const worker = workerFor(f, () => ({
      outcome, issues: [{
        code: 'omitted-evidence', criterionId: 'statistical-advising', qualificationId: null, citations: [],
        message: 'The proposed absence needs further documentary review.',
      }],
    }))
    await worker.run()
    const failed = (await head(f)).record
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error.code, 'grounding-failed')
    assert.equal(failed.error.retryable, false)
    assert.equal(worker.calls.length, 1)
    assert.deepEqual(failed.published, prior.published)
    const entry = await historyEntry(f)
    assert.equal(entry.outcome, 'failed')
    assert.equal(entry.review.outcome, outcome)
    assert.equal(entry.review.assessmentSha256, api.analysisHash(proposal.assessment))
    assert.equal(entry.review.issues[0].message, 'The proposed absence needs further documentary review.')
    assert.deepEqual(entry.previous, prior.history)
    assert.equal(entry.result, undefined)
    assert.deepEqual(await worker.run(), { claimed: 0, completed: 0 })
    await assertOriginal(f)
  }
})

test('provider outages use bounded exponential retries with linked safe failures and never fabricate a zero result', async () => {
  const f = await correctionFixture()
  await enqueue(f)
  const worker = workerFor(f, () => new Response('PRIVATE-PROVIDER-BODY', { status: 503 }))
  let previous
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.deepEqual(await worker.run(), { claimed: 1, completed: 0 })
    const record = (await head(f)).record
    assert.equal(record.attempts, attempt)
    assert.equal(record.status, attempt === 3 ? 'failed' : 'queued')
    assert.equal(record.error.code, 'service-unavailable')
    assert.equal(record.published, undefined)
    assert.equal(record.lease, undefined)
    const entry = await historyEntry(f)
    assert.deepEqual(entry.previous, previous)
    assert.doesNotMatch(JSON.stringify(entry), /PRIVATE-PROVIDER-BODY|SYNTHETIC-PRIVATE-TOKEN/)
    previous = record.history
    if (attempt < 3) {
      assert.equal(Date.parse(record.nextAttemptAt) - Date.parse(record.updatedAt), 30_000 * 2 ** (attempt - 1))
      assert.deepEqual(await worker.run(), { claimed: 0, completed: 0 })
      f.now = record.nextAttemptAt
    }
  }
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/results/')).length, 1)
  await assertOriginal(f)
})

test('tampered frozen bytes, an altered numeric row, or an altered base assessment digest cannot reach the model', async () => {
  for (const change of ['snapshot', 'numeric-score', 'base-assessment']) {
    const f = await correctionFixture()
    await enqueue(f, undefined, proposal => {
      if (change === 'numeric-score') {
        proposal.assessment.criteria[0].score = 5
        proposal.summary = api.calculateAnalysisSummary(proposal.assessment.criteria, [], proposal.assessment.limitations)
      } else if (change === 'base-assessment') proposal.provenance.baseAssessmentSha256 = 'f'.repeat(64)
    })
    if (change === 'snapshot') f.analysis.blobs.values.get(f.original.record.resume.blob.blobName).bytes[0] ^= 1
    const worker = workerFor(f)
    await worker.run()
    const record = (await head(f)).record
    assert.equal(record.status, 'failed', change)
    assert.equal(record.error.code, 'snapshot-invalid', change)
    assert.equal(record.published, undefined)
    assert.equal(worker.calls.length, 0)
    assert.equal((await historyEntry(f)).review, undefined)
    await assertOriginal(f)
  }
})

test('the immutable success history is required before publication and a storage retry cannot reuse unreviewed result bytes', async t => {
  const f = await correctionFixture()
  await enqueue(f)
  const logged = []
  t.mock.method(console, 'error', (...args) => logged.push(args))
  f.analysis.blobs._beforeFencedPut(name => {
    if (name.includes('/correction-history/')) throw new Error('PRIVATE-STORAGE-DUMP')
  })
  const worker = workerFor(f)
  await worker.run()
  const failed = (await head(f)).record
  assert.equal(failed.status, 'queued')
  assert.equal(failed.error.code, 'storage-error')
  assert.equal(failed.published, undefined)
  assert.equal(failed.history, undefined)
  assert.ok(logged.length >= 1)
  assert.doesNotMatch(JSON.stringify(logged), /PRIVATE-STORAGE-DUMP|SYNTHETIC-PRIVATE-TOKEN/)
  f.analysis.blobs._beforeFencedPut(undefined)
  f.now = failed.nextAttemptAt
  await worker.run()
  const ready = (await head(f)).record
  assert.equal(ready.status, 'ready')
  assert.notEqual(ready.attemptId, failed.attemptId)
  assert.equal(worker.calls.length, 2)
  await assertOriginal(f)
})

test('ambiguous committed claim, result, history, and publication writes reconcile without reassessment or duplicate revisions', async () => {
  const f = await correctionFixture()
  await enqueue(f)
  f.transactions.after(operations => {
    assert.ok(operations.some(item => item.record.recordType === 'analysis-correction' && item.record.status === 'running'))
    f.transactions.after(items => {
      assert.ok(items.some(item => item.record.recordType === 'analysis-correction' && item.record.status === 'ready'))
      throw new Error('Lost publication response')
    })
    throw new Error('Lost claim response')
  })
  f.analysis.blobs._afterPut(name => {
    if (name.includes('/results/') || name.includes('/correction-history/')) throw new Error('Lost immutable PUT response')
  })
  const worker = workerFor(f)
  await worker.run()
  const saved = (await head(f)).record
  assert.equal(saved.status, 'ready', JSON.stringify(saved.error))
  assert.equal(saved.attempts, 1)
  assert.equal(worker.calls.length, 1)
  assert.equal((await historyEntry(f)).outcome, 'ready')
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/correction-history/')).length, 1)
  await assertOriginal(f)
})

test('a run ETag race at final publication preserves concurrent metadata and uses the same reviewed result', async () => {
  const f = await correctionFixture()
  await enqueue(f)
  const worker = workerFor(f, () => {
    f.transactions.before(async operations => {
      assert.ok(operations.some(item => item.record.recordType === 'analysis-correction' && item.record.status === 'ready'))
      const run = await f.analysis.store.get(f.workspaceId, f.runId)
      await f.service.updateMetadata(f.workspaceId, f.runId, { displayName: 'Concurrent human label' }, run.etag)
    })
  })
  await worker.run()
  assert.equal((await head(f)).record.status, 'ready')
  assert.equal((await f.analysis.store.get(f.workspaceId, f.runId)).record.displayName, 'Concurrent human label')
  assert.equal(worker.calls.length, 1)
  await assertOriginal(f)
})

test('an immutable result-name collision cannot substitute different reviewed content', async () => {
  const f = await correctionFixture()
  await enqueue(f)
  f.analysis.blobs._beforeFencedPut(async name => {
    if (name.includes('/results/')) await f.analysis.blobs.putImmutable(name, Buffer.from('{"foreign":"private-sentinel"}'), 'application/json')
  })
  const worker = workerFor(f)
  await worker.run()
  const failed = (await head(f)).record
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'invalid-model-output')
  assert.equal(failed.published, undefined)
  assert.equal(worker.calls.length, 1)
  assert.doesNotMatch(JSON.stringify(failed.error), /private-sentinel/)
  assert.equal((await historyEntry(f)).outcome, 'failed')
  await assertOriginal(f)
})

test('expired exhausted work settles without a fourth independent model attempt', async () => {
  const f = await correctionFixture()
  await enqueue(f)
  const queued = (await head(f)).record
  const exhausted = {
    ...queued, status: 'running', attempts: 3, attemptId: randomUUID(),
    lease: {
      owner: 'crashed-worker', heartbeatAt: f.now,
      expiresAt: new Date(Date.parse(f.now) + 90_000).toISOString(),
    },
  }
  delete exhausted.nextAttemptAt
  f.analysis.store.save(exhausted)
  f.now = new Date(Date.parse(exhausted.lease.expiresAt) + 1).toISOString()
  const worker = workerFor(f)
  await worker.run()
  const failed = (await head(f)).record
  assert.equal(failed.status, 'failed')
  assert.equal(failed.attempts, 3)
  assert.equal(failed.error.code, 'timeout')
  assert.equal(failed.published, undefined)
  assert.equal(worker.calls.length, 0)
  assert.equal((await historyEntry(f)).outcome, 'failed')
  await assertOriginal(f)
})

test('expired same-owner attempts cannot publish after takeover, and foreign owners cannot start an existing attempt', async () => {
  const f = await correctionFixture()
  await enqueue(f)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const first = workerFor(f, async () => { await blocked })
  const pending = first.run()
  try {
    await until(() => first.calls.length === 1)
    const old = await head(f)
    const competitor = workerFor(f)
    assert.equal(await correction.processClaimedCorrection(old, { ...competitor.deps, owner: 'other-worker' }), false)
    assert.equal(competitor.calls.length, 0)
    f.now = new Date(Date.parse(old.record.lease.expiresAt) + 1).toISOString()
    await competitor.run()
    const winning = await head(f)
    assert.equal(winning.record.status, 'ready')
    assert.equal(winning.record.attempts, 2)
    release()
    await pending
    assert.deepEqual(await head(f), winning)
    assert.notEqual(winning.record.attemptId, old.record.attemptId)
    assert.equal(await correction.processClaimedCorrection(old, competitor.deps), false)
    assert.equal(competitor.calls.length, 1)
    assert.equal(f.analysis.blobs.values.has(api.analysisResultBlobName(f.workspaceId, f.runId, f.comparisonId, old.record.attemptId)), false)
    await assertOriginal(f)
  } finally { release(); await pending }
})

test('a newer accepted request fences the old review even though the correction head ID is stable', async () => {
  const f = await correctionFixture()
  await enqueue(f)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const worker = workerFor(f, async () => { await blocked })
  const pending = worker.run()
  try {
    await until(() => worker.calls.length === 1)
    const old = (await head(f)).record
    await cancel(f)
    await enqueue(f, ['data-practices'])
    const newer = await head(f)
    assert.equal(newer.record.id, old.id)
    assert.notEqual(newer.record.requestId, old.requestId)
    release()
    await pending
    assert.deepEqual(await head(f), newer)
    assert.equal(f.analysis.blobs.values.has(api.analysisResultBlobName(f.workspaceId, f.runId, f.comparisonId, old.attemptId)), false)
    await workerFor(f).run()
    assert.equal((await head(f)).record.status, 'ready')
    assert.equal((await head(f)).record.published.summary.overall.status, 'withheld')
    await assertOriginal(f)
  } finally { release(); await pending }
})

test('heartbeat renewals remain run-fenced, and cancellation aborts a blocked independent review without late writes', async t => {
  const f = await correctionFixture()
  await enqueue(f)
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const worker = workerFor(f, async () => { await blocked })
  const pending = worker.run()
  try {
    await until(() => worker.calls.length === 1)
    const first = await head(f)
    f.now = new Date(Date.parse(f.now) + 25_000).toISOString()
    t.mock.timers.tick(25_000)
    await until(async () => (await head(f)).record.lease?.heartbeatAt === f.now)
    const renewed = (await head(f)).record
    assert.equal(renewed.attemptId, first.record.attemptId)
    assert.equal(Date.parse(renewed.lease.expiresAt) - Date.parse(f.now), 90_000)
    assert.deepEqual(await workerFor(f).run(), { claimed: 0, completed: 0 })
    await cancel(f)
    f.now = new Date(Date.parse(f.now) + 25_000).toISOString()
    t.mock.timers.tick(25_000)
    await until(() => worker.calls[0].signal.aborted)
    await pending
    assert.equal((await head(f)).record.status, 'cancelled')
    assert.equal((await head(f)).record.published, undefined)
    assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/results/')).length, 1)
    await assertOriginal(f)
  } finally { release(); await pending; t.mock.timers.reset() }
})

test('heartbeats serialize behind final publication instead of expiring or rewriting the approved attempt', async t => {
  const f = await correctionFixture()
  await enqueue(f)
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let publishing = false
  const worker = workerFor(f, () => {
    f.transactions.before(async operations => {
      assert.ok(operations.some(item => item.record.recordType === 'analysis-correction' && item.record.status === 'ready'))
      publishing = true
      await blocked
    })
  })
  const pending = worker.run()
  try {
    await until(() => publishing)
    const before = await head(f)
    f.now = new Date(Date.parse(f.now) + 25_000).toISOString()
    t.mock.timers.tick(25_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(await head(f), before)
    release()
    await pending
    const ready = (await head(f)).record
    assert.equal(ready.status, 'ready')
    assert.equal(ready.lease, undefined)
    assert.equal(worker.calls.length, 1)
    await assertOriginal(f)
  } finally { release(); await pending; t.mock.timers.reset() }
})

test('the bounded deadline aborts an unresponsive reviewer and checkpoints a retryable timeout without changing the result', async t => {
  const f = await correctionFixture()
  await enqueue(f)
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const worker = workerFor(f, async () => { await blocked })
  const pending = worker.run({ budgetMilliseconds: 1_000 })
  try {
    await until(() => worker.calls.length === 1)
    f.now = new Date(Date.parse(f.now) + 1_000).toISOString()
    t.mock.timers.tick(1_000)
    await pending
    const current = (await head(f)).record
    assert.equal(current.status, 'queued')
    assert.equal(current.error.code, 'timeout')
    assert.equal(current.lease, undefined)
    assert.equal(current.published, undefined)
    assert.equal((await historyEntry(f)).error.code, 'timeout')
    assert.equal(worker.calls[0].signal.aborted, true)
    await assertOriginal(f)
  } finally { release(); await pending; t.mock.timers.reset() }
})

test('narrative scheduling, archival, workspace locks, and in-flight cancellation fence correction work', async () => {
  for (const stopped of ['narrative', 'run-archive', 'workspace-archive', 'late-cancel']) {
    const f = await correctionFixture()
    await enqueue(f)
    if (stopped === 'narrative') {
      const run = await f.analysis.store.get(f.workspaceId, f.runId)
      f.analysis.store.save({ ...run.record, narrativeRequestId: randomUUID() })
    } else if (stopped === 'run-archive') {
      const run = await f.analysis.store.get(f.workspaceId, f.runId)
      const lifecycle = new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(f.now))
      await lifecycle.change(f.workspaceId, f.runId, 'archive', run.etag, ACTOR)
    } else if (stopped === 'workspace-archive') {
      await api.updateAnalysisControl(f.analysis.store, f.workspaceId, undefined, record => ({ ...record, state: 'archived' }))
    } else f.analysis.blobs._beforeFencedPut(async name => {
      if (name.includes('/results/')) await cancel(f)
    })
    const worker = workerFor(f)
    await worker.run()
    assert.equal(worker.calls.length, stopped === 'late-cancel' ? 1 : 0, stopped)
    assert.equal((await head(f)).record.published, undefined, stopped)
    assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/results/')).length, 1, stopped)
    await assertOriginal(f)
  }
})
