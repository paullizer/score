import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { api, fixture, createRun, publishResult, startHttp, ACTOR, clone, sha } from './real-analyses.test-support.mjs'

const issue = { code: 'unsupported-claim', message: '<script>Private reviewer finding</script>',
  field: 'text', paragraphIndex: null }
const failure = { code: 'grounding-failed', stage: 'grounding',
  message: 'Factual review still reports issues. Inspect the saved drafts or retry.', retryable: false }
const provenance = timestamp => ({
  model: 'actual-summary-model', deployment: 'saved-analysis-model', promptVersion: 'summary-v2', schemaVersion: 'summary-v2',
  startedAt: timestamp, completedAt: timestamp, inputCharacters: 1234,
})
const clock = f => () => new Date(f.now)
const advance = f => { f.now = new Date(Date.parse(f.now) + 1).toISOString(); return f.now }

async function setup(resumes = 1, targets = 1) {
  const f = fixture(), created = await createRun(f, resumes, targets)
  const comparisons = [...f.analysis.store.values.values()].filter(value => value.record.recordType === 'analysis-comparison')
  for (const pair of comparisons) await publishResult(f, created.run.id, pair.record.id)
  const subject = { kind: 'candidate', subjectId: comparisons[0].record.id }
  return { f, runId: created.run.id, subject, comparisons }
}

async function save(f, runId, record, etag) {
  const run = await f.analysis.store.get(f.workspaceId, runId)
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record, etag },
    { kind: 'replace', record: { ...run.record, updatedAt: record.updatedAt > run.record.updatedAt ? record.updatedAt : run.record.updatedAt }, etag: run.etag },
  ])
  return f.analysis.store.get(f.workspaceId, record.id)
}

async function claim(f, runId, subject) {
  const state = await api.readSummarySubject(f.analysis, f.workspaceId, runId, subject)
  const record = {
    ...state.current.record, status: 'running', attemptId: randomUUID(), attempts: state.current.record.attempts + 1,
    inputFingerprint: state.inputFingerprint, updatedAt: advance(f),
    lease: { owner: 'summary-test-worker', heartbeatAt: f.now, expiresAt: new Date(Date.parse(f.now) + 90_000).toISOString() },
  }
  delete record.nextAttemptAt; delete record.error; delete record.waitingFor
  return save(f, runId, record, state.current.etag)
}

async function checkpoint(f, runId, current, step) {
  const createdAt = advance(f)
  const history = await api.writeSummaryCheckpoint(f.analysis, current.record, step, { createdAt, assertActive: async () => {} })
  const unchanged = await f.analysis.store.get(f.workspaceId, current.record.id)
  assert.equal(unchanged.etag, current.etag, 'Checkpoint helpers must not advance the Cosmos head themselves.')
  return save(f, runId, { ...current.record, updatedAt: createdAt, history,
    ...(step.scopeId === 'final' ? { summaryRound: step.round } : {}) }, current.etag)
}

async function rounds(f, runId, subject, count = 3, review = true) {
  let current = await claim(f, runId, subject)
  const entries = []
  for (let round = 1; round <= count; round++) {
    const common = { scopeId: 'final', sourceFingerprint: current.record.inputFingerprint, round, modelCallId: randomUUID() }
    current = await checkpoint(f, runId, current, { ...common, phase: 'started' })
    const draft = subject.kind === 'candidate'
      ? { kind: 'candidate', text: `Round ${round}: Ph.D. engineering work in the U.S.; the assessment reports 1000 units and 12 points. ` +
        'Saved analysis context. '.repeat(50), overview: 'An unconstrained overview without sentence-count rules' }
      : { kind: 'target', paragraphs: [`Saved target summary round ${round} without a prescribed sentence count`] }
    const generated = { ...common, phase: 'generated', draft, outputSha256: api.analysisHash(draft), generation: provenance(f.now) }
    current = await checkpoint(f, runId, current, generated)
    let latest = generated
    if (review) {
      latest = { ...generated, phase: 'reviewed', review: {
        id: randomUUID(), modelCallId: randomUUID(), inputFingerprint: common.sourceFingerprint, outputSha256: generated.outputSha256,
        provenance: provenance(f.now), outcome: 'needs-correction',
        issues: [{ ...issue, ...(subject.kind === 'target' ? { field: 'paragraphs', paragraphIndex: 0 } : {}) }],
      } }
      current = await checkpoint(f, runId, current, latest)
    }
    entries.push(latest)
  }
  const stopped = { ...current.record, status: 'failed', updatedAt: advance(f),
    error: { ...failure, diagnostic: { reason: 'factual-review', round: count, issueCount: review ? 1 : 0 } } }
  delete stopped.lease
  current = await save(f, runId, stopped, current.etag)
  return { current, entries }
}
const selection = (record, step) => ({ generationId: record.generationId, round: step.round, outputSha256: step.outputSha256 })

test('all three generated drafts and exact reviews survive failure, scoped pagination, and a fresh retry', async () => {
  const { f, runId, subject } = await setup()
  let result = await rounds(f, runId, subject)
  const firstGeneration = result.current.record.generationId
  const originalHistory = clone(result.current.record.history)
  let page = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject)
  assert.equal(page.entries.length, 9)
  assert.deepEqual(page.entries.filter(value => value.phase === 'reviewed').map(value => value.round), [3, 2, 1])
  assert.equal(page.entries[0].review.issues[0].message, issue.message)
  const resume = await api.readSummaryGeneration(f.analysis, result.current.record)
  assert.equal(resume.steps.length, 9)
  assert.equal(resume.seed, undefined)
  const key = randomUUID()
  const retry = await api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject, key, page.etag, ACTOR, clock(f))
  assert.equal(retry.summaries.comparisons[0].status, 'queued')
  assert.notEqual(retry.summaries.comparisons[0].generationId, firstGeneration)
  assert.equal(retry.summaries.comparisons[0].summaryRound, undefined)
  const next = await f.analysis.store.get(f.workspaceId, result.current.record.id)
  assert.deepEqual(next.record.history, originalHistory)
  const resumed = await api.readSummaryGeneration(f.analysis, next.record)
  assert.deepEqual(resumed.steps, [])
  assert.equal(resumed.seed.round, 3)
  assert.equal(resumed.seed.review.issues[0].message, issue.message)
  result = await rounds(f, runId, subject)
  page = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject)
  assert.equal(page.entries.length, 12)
  assert.ok(page.continuationToken)
  const older = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject, page.continuationToken)
  assert.equal(older.entries.length, 6)
  assert.equal(older.continuationToken, undefined)
  assert.equal(new Set([...page.entries, ...older.entries].map(entry => entry.id)).size, 18)
  const wrongTarget = { kind: 'target', subjectId: retry.summaries.targets[0].targetId }
  await assert.rejects(api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, wrongTarget, page.continuationToken), { status: 400 })
})

test('historical completed results without a sidecar report no captured history and retry only the selected subject', async () => {
  const f = fixture(), created = await createRun(f, 2)
  const pairs = [...f.analysis.store.values.values()].filter(value => value.record.recordType === 'analysis-comparison')
  for (const pair of pairs) await publishResult(f, created.run.id, pair.record.id, false, { scheduleNarratives: false })
  const subject = { kind: 'candidate', subjectId: pairs[0].record.id }
  const history = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, created.run.id, subject)
  assert.deepEqual(history.entries, [])
  assert.deepEqual(history.capabilities, { canPublish: false, canRetry: true })
  const key = randomUUID()
  const result = await api.retryAnalysisSummary(f.analysis, f.workspaceId, created.run.id, subject, key, history.etag, ACTOR, clock(f))
  assert.equal(result.summaries.comparisons.find(value => value.comparisonId === pairs[0].record.id).status, 'queued')
  assert.equal(result.summaries.comparisons.find(value => value.comparisonId === pairs[1].record.id).status, 'missing')
  assert.deepEqual((await api.retryAnalysisSummary(f.analysis, f.workspaceId, created.run.id, subject,
    key, history.etag, ACTOR, clock(f))).summaries, result.summaries)
  await assert.rejects(api.readAnalysisSummaryHistory(f.analysis, 'workspace-other', created.run.id, subject), { status: 404 })
})

test('started and failed-without-draft checkpoints retain durable round slots without inventing usable output', async () => {
  const { f, runId, subject } = await setup()
  let current = await claim(f, runId, subject)
  const slot = { scopeId: 'final', sourceFingerprint: current.record.inputFingerprint, round: 1 }
  current = await checkpoint(f, runId, current, { ...slot, phase: 'started' })
  const first = clone(current.record.history)
  current = await checkpoint(f, runId, current, { ...slot, phase: 'failed', error: {
    code: 'invalid-model-output', stage: 'candidate-generation', retryable: false,
    message: 'The response did not contain a usable draft.',
  } })
  const resume = await api.readSummaryGeneration(f.analysis, current.record)
  assert.deepEqual(resume.steps.map(step => step.phase), ['failed', 'started'])
  assert.ok(resume.steps.every(step => step.round === 1 && step.draft === undefined && step.review === undefined))
  const page = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject)
  assert.deepEqual(page.entries[0].previous, first)
  assert.equal(page.entries[0].error.code, 'invalid-model-output')
  await assert.rejects(api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, subject,
    { generationId: current.record.generationId, round: 1, outputSha256: '0'.repeat(64) },
    randomUUID(), current.etag, ACTOR, clock(f)), { status: 409 })
})

test('checkpoint hashes, review bindings, immutable bytes, owned paths and worker attempts fail closed', async () => {
  const { f, runId, subject } = await setup()
  const current = await claim(f, runId, subject)
  const draft = { kind: 'candidate', text: 'A usable unrestricted draft', overview: 'A saved overview' }
  const step = { scopeId: 'final', sourceFingerprint: current.record.inputFingerprint, round: 1, phase: 'generated',
    draft, outputSha256: api.analysisHash(draft), modelCallId: randomUUID(), generation: provenance(f.now) }
  for (const change of [
    { outputSha256: '0'.repeat(64) }, { sourceFingerprint: '0'.repeat(64) },
    { scopeId: `reduction-${'0'.repeat(64)}` }, { draft: { kind: 'target', paragraphs: ['Foreign summary kind'] } },
  ]) await assert.rejects(api.writeSummaryCheckpoint(f.analysis, current.record, { ...step, ...change },
    { createdAt: advance(f), assertActive: async () => {} }), /Summary|summary/)
  await assert.rejects(api.writeSummaryCheckpoint(f.analysis, current.record, { ...step, phase: 'reviewed', review: {
    id: randomUUID(), modelCallId: randomUUID(), inputFingerprint: '0'.repeat(64), outputSha256: step.outputSha256,
    provenance: provenance(f.now), outcome: 'supported', issues: [],
  } }, { createdAt: advance(f), assertActive: async () => {} }), /exact output/)
  const saved = await checkpoint(f, runId, current, step)
  const name = saved.record.history.blob.blobName
  assert.equal(api.isSafeAnalysisBlobName(name), true)
  for (const invalid of [name.replace('/candidate/', '/other/'), name.replace(/\.json$/, '.txt'), `${name}/extra`,
    name.replace(`/${subject.subjectId}/`, '/../../'), name.replace('/narrative-history/', '/narratives/')]) {
    assert.equal(api.isSafeAnalysisBlobName(invalid), false)
  }
  assert.throws(() => api.parseAnalysisEntity({ ...saved.record, history: { ...saved.record.history,
    blob: { ...saved.record.history.blob, blobName: name.replace(subject.subjectId, `analysis-comparison-${randomUUID()}`) } } }), /history|checkpoint/i)
  await assert.rejects(api.writeSummaryCheckpoint(f.analysis, current.record, step,
    { createdAt: advance(f), assertActive: async () => {} }), /history head/)
  f.analysis.blobs.values.get(name).bytes[10] ^= 1
  await assert.rejects(api.readSummaryGeneration(f.analysis, saved.record), /digest/)
})

test('history capture failure is explicit, leaves the head intact, and recovers an ambiguous immutable upload', async () => {
  const { f, runId, subject } = await setup()
  const current = await claim(f, runId, subject)
  const step = { scopeId: 'final', sourceFingerprint: current.record.inputFingerprint, round: 1, phase: 'started', modelCallId: randomUUID() }
  const original = f.analysis.blobs.putFenced
  f.analysis.blobs.putFenced = async () => { throw new Error('private-storage-exception') }
  await assert.rejects(api.writeSummaryCheckpoint(f.analysis, current.record, step,
    { createdAt: advance(f), assertActive: async () => {} }), error =>
    error.name === 'SummaryHistoryCaptureError' && error.failure.diagnostic.reason === 'history-write-failed' &&
    !error.message.includes('private-storage-exception'))
  assert.equal((await f.analysis.store.get(f.workspaceId, current.record.id)).record.history, undefined)
  f.analysis.blobs.putFenced = original
  f.analysis.blobs._afterPut(name => { if (name.includes('/narrative-history/')) throw new Error('ambiguous PUT') })
  const saved = await checkpoint(f, runId, current, step)
  assert.equal((await api.readSummaryGeneration(f.analysis, saved.record)).steps.length, 1)
})

test('store transitions cannot erase history, replace immutable references or reset a generation round budget', async () => {
  const { f, runId, subject } = await setup()
  const { current } = await rounds(f, runId, subject)
  const previous = current.record
  assert.throws(() => api.assertAnalysisReplacement(previous, { ...previous, history: undefined }), /history cannot be erased/)
  assert.throws(() => api.assertAnalysisReplacement(previous, { ...previous, history: {
    ...previous.history, blob: { ...previous.history.blob, sha256: '0'.repeat(64) },
  } }), /immutable checkpoint/)
  assert.throws(() => api.assertAnalysisReplacement(previous, { ...previous, summaryRound: 1 }), /round budget/)
  const retry = { ...previous, status: 'queued', generationId: randomUUID(), attempts: 0 }
  assert.doesNotThrow(() => api.assertAnalysisReplacement(previous, retry))
  assert.throws(() => api.assertAnalysisReplacement(previous, { ...retry,
    history: { ...previous.history, id: randomUUID() },
  }), /predecessor history/)
  assert.throws(() => api.assertAnalysisReplacement(previous, { ...retry, status: 'ready' }), /manual publication authorization/)
})

test('manual publication keeps the selected failed review, immutable drafts, explicit approval and dependent-only scheduling', async t => {
  const events = []
  t.mock.method(console, 'info', (...args) => events.push(args))
  const { f, runId, subject, comparisons } = await setup(2, 2)
  const result = await rounds(f, runId, subject)
  const before = clone([...f.analysis.store.values.values()].filter(value => value.record.recordType === 'analysis-comparison'))
  const unrelated = clone([...f.analysis.store.values.values()].filter(value =>
    value.record.recordType === 'analysis-candidate-narrative' && value.record.comparisonId !== subject.subjectId))
  const retained = clone([...f.analysis.blobs.values].filter(([name]) => name.includes('/narrative-history/')))
  const page = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject)
  const selected = selection(result.current.record, result.entries[0])
  const key = randomUUID()
  const published = await api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, subject, selected, key, page.etag, ACTOR, clock(f))
  assert.equal(published.summaries.scope.targetId, comparisons[0].record.target.summary.id)
  const summary = published.summaries.comparisons.find(value => value.comparisonId === subject.subjectId)
  assert.equal(summary.status, 'ready')
  assert.equal(summary.published.summaryVersion, 2)
  assert.equal(summary.published.text, result.entries[0].draft.text)
  assert.equal(summary.published.approval.kind, 'manual')
  assert.equal(summary.published.approval.approvedBy, ACTOR)
  assert.equal(summary.published.approval.reviewOutcome, 'needs-correction')
  assert.deepEqual(summary.published.approval.issues, [issue])
  assert.equal(summary.hasHistory, true)
  const current = await f.analysis.store.get(f.workspaceId, result.current.record.id)
  assert.equal(current.record.lease, undefined)
  assert.equal(current.record.attempts, 0)
  assert.equal(current.record.attemptId, result.current.record.attemptId)
  const artifact = await api.readAnalysisNarrativePublication(f.analysis.blobs, current.record)
  assert.equal(artifact.provenance.groundingReviews[0].outcome, 'needs-correction')
  assert.equal(artifact.provenance.outputSha256, api.analysisHash(result.entries[0].draft))
  assert.equal(artifact.claims.length, 0)
  assert.equal(published.summaries.targets[0].status, 'waiting')
  assert.deepEqual([...f.analysis.blobs.values].filter(([name]) => name.includes('/narrative-history/')), retained)
  assert.deepEqual([...f.analysis.store.values.values()].filter(value => value.record.recordType === 'analysis-comparison'), before)
  assert.deepEqual([...f.analysis.store.values.values()].filter(value =>
    value.record.recordType === 'analysis-candidate-narrative' && value.record.comparisonId !== subject.subjectId), unrelated)
  const replay = await api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, subject, selected, key, page.etag, ACTOR, clock(f))
  assert.equal(replay.summaries.revision, published.summaries.revision)
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/narratives/candidate/')).length, 1)
  assert.match(JSON.stringify(events), /summary-manual-publication/)
  const audit = events.map(([value]) => value).filter(value => typeof value === 'string' && value.startsWith('{'))
    .map(value => JSON.parse(value)).find(value => value.event === 'summary-manual-publication')
  assert.equal(audit.component, 'score-analysis-narrative')
  assert.equal(audit.draftGenerationId, selected.generationId)
  assert.equal(audit.round, selected.round)
  assert.ok(audit.timestamp && audit.modelCallId)
  assert.doesNotMatch(JSON.stringify(events), /Private reviewer finding|Ph\.D\.|<script>|approvedBy|lease/)
  assert.throws(() => api.parseAnalysisNarrativeArtifact({ ...artifact, approval: { kind: 'automatic' } }), /supported review/)
  assert.throws(() => api.parseAnalysisNarrativeArtifact({ ...artifact, approval: { ...artifact.approval, reviewOutcome: 'supported', issues: [] } }), /actual review/)
})

test('audit sink failure is reported safely without hiding a committed summary action', async t => {
  const { f, runId, subject } = await setup()
  const page = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject)
  const errors = []
  t.mock.method(console, 'info', () => { throw new Error('PRIVATE-AUDIT-SINK') })
  t.mock.method(console, 'error', (...args) => errors.push(args))
  const result = await api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject,
    randomUUID(), page.etag, ACTOR, clock(f))
  assert.equal(result.summaries.comparisons[0].status, 'queued')
  assert.equal(errors.length, 1)
  assert.match(JSON.stringify(errors), /audit sink failed/)
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE-AUDIT-SINK/)
})

test('target reductions remain supporting history, not selectable finals, and changed candidate inputs cannot seed or publish stale target drafts', async () => {
  const { f, runId, subject } = await setup()
  const inventory = await api.readAnalysisNarrativeInventory(f.analysis, f.workspaceId, runId)
  const target = { kind: 'target', subjectId: inventory.targets[0].target.summary.id }
  let current = await claim(f, runId, target)
  const fingerprint = api.analysisHash({ reduction: 'bounded-saved-analysis-batch' })
  const draft = { kind: 'reduction', paragraphs: ['A saved intermediate reduction, never a publishable final.'] }
  const generated = {
    scopeId: `reduction-${fingerprint}`, sourceFingerprint: fingerprint, round: 1, phase: 'generated', draft,
    generation: provenance(f.now), modelCallId: randomUUID(), outputSha256: api.analysisHash(draft),
  }
  current = await checkpoint(f, runId, current, generated)
  current = await checkpoint(f, runId, current, { ...generated, phase: 'reviewed', review: {
    id: randomUUID(), modelCallId: randomUUID(), provenance: provenance(f.now), inputFingerprint: fingerprint,
    outputSha256: generated.outputSha256, outcome: 'supported', issues: [],
  } })
  const result = await rounds(f, runId, target, 1)
  const generation = await api.readSummaryGeneration(f.analysis, result.current.record)
  assert.equal(generation.steps.length, 5)
  assert.equal(generation.steps.filter(value => value.scopeId.startsWith('reduction-')).length, 2)
  const history = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, target)
  await assert.rejects(api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, target,
    selection(current.record, generated), randomUUID(), history.etag, ACTOR, clock(f)), { status: 409 })
  const candidateHistory = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject)
  await api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject, randomUUID(), candidateHistory.etag, ACTOR, clock(f))
  const refreshed = await api.readSummarySubject(f.analysis, f.workspaceId, runId, target)
  assert.notEqual(refreshed.inputFingerprint, result.current.record.inputFingerprint)
  assert.deepEqual(refreshed.current.record.history, result.current.record.history)
  const resume = await api.readSummaryGeneration(f.analysis, { ...refreshed.current.record, inputFingerprint: refreshed.inputFingerprint })
  assert.deepEqual(resume, { steps: [] })
  await assert.rejects(api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, target,
    selection(result.current.record, result.entries[0]), randomUUID(), refreshed.etag, ACTOR, clock(f)), { status: 409 })
})

test('manual publication races fail closed and cannot overwrite a newly requested generation', async () => {
  const { f, runId, subject } = await setup()
  const result = await rounds(f, runId, subject, 1)
  const history = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject)
  const retryKey = randomUUID()
  let raced = false
  f.analysis.blobs._beforeFencedPut(async name => {
    if (name.includes('/narratives/candidate/') && !raced) {
      raced = true
      await api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject, retryKey, history.etag, ACTOR, clock(f))
    }
  })
  await assert.rejects(api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, subject,
    selection(result.current.record, result.entries[0]), randomUUID(), history.etag, ACTOR, clock(f)), { status: 409 })
  assert.equal(raced, true)
  const current = await f.analysis.store.get(f.workspaceId, result.current.record.id)
  assert.equal(current.record.requestId, retryKey)
  assert.equal(current.record.status, 'queued')
  assert.equal(current.record.published, undefined)
  assert.equal([...f.analysis.blobs.values.keys()].some(name => name.includes('/narratives/candidate/')), false)
})

test('run deletion drains history writers and removes linked checkpoints, orphan checkpoints, and action reservations', async () => {
  const { f, runId, subject } = await setup()
  const result = await rounds(f, runId, subject, 1)
  await api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject, randomUUID(), result.current.etag, ACTOR, clock(f))
  const current = await claim(f, runId, subject)
  const started = { scopeId: 'final', sourceFingerprint: current.record.inputFingerprint, round: 1, phase: 'started' }
  const orphan = await api.writeSummaryCheckpoint(f.analysis, current.record, started,
    { createdAt: advance(f), assertActive: async () => {} })
  assert.ok(f.analysis.blobs.values.has(orphan.blob.blobName))
  assert.notEqual(current.record.history.id, orphan.id)
  const lifecycle = new api.AnalysisLibraryLifecycleService(f.analysis, clock(f))
  let deleted
  f.analysis.blobs._beforeFencedPut(async name => {
    if (!name.includes('/narrative-history/')) return
    const run = await f.analysis.store.get(f.workspaceId, runId)
    deleted = await lifecycle.change(f.workspaceId, runId, 'delete', run.etag, ACTOR)
  })
  await assert.rejects(api.writeSummaryCheckpoint(f.analysis, current.record, started,
    { createdAt: advance(f), assertActive: async () => {} }), /generation|archived|removed|attempt/i)
  assert.equal(deleted.pending, true)
  assert.ok(f.analysis.blobs.values.has(orphan.blob.blobName), 'A registered late writer must drain before any prefix cleanup.')
  await api.updateAnalysisControl(f.analysis.store, f.workspaceId, runId, control => ({
    ...control, writers: Object.fromEntries(Object.entries(control.writers ?? {}).map(([key, value]) => [
      key, { ...value, expiresAt: new Date(Date.now() - 1).toISOString() },
    ])),
  }))
  const participant = api.createAnalysisLifecycleParticipant(f.analysis)
  for (let pass = 0; pass < 10 && await f.analysis.store.get(f.workspaceId, runId); pass++) {
    await participant.resume(f.workspaceId, f.now)
  }
  assert.equal(await f.analysis.store.get(f.workspaceId, runId), undefined)
  assert.equal(f.analysis.blobs.values.size, 0)
  assert.equal((await f.analysis.store.getControl(f.workspaceId, runId)).record.state, 'deleted')
  await assert.rejects(api.fencedAnalysisBlobs(f.analysis, f.workspaceId, runId)
    .putImmutable(orphan.blob.blobName, Buffer.from('{}'), 'application/json'), /archived|removed|changed/)
  assert.equal(f.analysis.blobs.values.size, 0)
})

test('unreviewed publication is disclosed without a fake supported review; stale drafts and ETags cannot be selected', async () => {
  const { f, runId, subject } = await setup()
  const result = await rounds(f, runId, subject, 1, false)
  const page = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject)
  const chosen = selection(result.current.record, result.entries[0])
  await assert.rejects(api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, subject,
    { ...chosen, outputSha256: '0'.repeat(64) }, randomUUID(), page.etag, ACTOR, clock(f)), { status: 409 })
  await assert.rejects(api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, subject,
    { ...chosen, generationId: randomUUID() }, randomUUID(), page.etag, ACTOR, clock(f)), { status: 409 })
  await assert.rejects(api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, subject,
    chosen, randomUUID(), '"stale-etag"', ACTOR, clock(f)), { status: 409 })
  const output = await api.publishAnalysisSummaryDraft(f.analysis, f.workspaceId, runId, subject,
    chosen, randomUUID(), page.etag, ACTOR, clock(f))
  assert.equal(output.summaries.comparisons[0].published.approval.reviewOutcome, 'not-reviewed')
  const record = (await f.analysis.store.get(f.workspaceId, result.current.record.id)).record
  const artifact = await api.readAnalysisNarrativePublication(f.analysis.blobs, record)
  assert.deepEqual(artifact.provenance.groundingReviews, [])
  assert.throws(() => api.parseAnalysisNarrativeArtifact({ ...artifact, approval: { kind: 'automatic' } }), /supported review/)
})

test('retry receipts recover ambiguous writes, never duplicate a generation, and reject replay over newer work', async () => {
  const { f, runId, subject } = await setup()
  const result = await rounds(f, runId, subject, 1)
  const page = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject), key = randomUUID()
  f.analysis.blobs._afterPut(name => { if (name.includes('/narrative-actions/')) throw new Error('ambiguous action reservation') })
  f.analysis.store._afterBatch(() => { throw new Error('ambiguous committed retry') })
  const first = await api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject, key, page.etag, ACTOR, clock(f))
  const duplicate = await api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject, key, page.etag, ACTOR, clock(f))
  assert.equal(first.summaries.comparisons[0].generationId, duplicate.summaries.comparisons[0].generationId)
  assert.equal(first.summaries.comparisons[0].retryCount, result.current.record.retryCount + 1)
  assert.equal(first.summaries.comparisons[0].attempts, 0)
  const bulk = await api.readAnalysisSummaries(f.analysis, f.workspaceId, runId)
  await assert.rejects(api.generateAnalysisSummaries(f.analysis, f.workspaceId, runId,
    { mode: 'all' }, key, bulk.etag, ACTOR, clock(f)), { status: 409 })
  const nextPage = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, runId, subject)
  await api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject, randomUUID(), nextPage.etag, ACTOR, clock(f))
  await assert.rejects(api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject, key, page.etag, ACTOR, clock(f)), { status: 409 })
  await assert.rejects(api.retryAnalysisSummary(f.analysis, f.workspaceId, runId, subject, key, page.etag, 'another-owner', clock(f)), { status: 409 })
})

test('HTTP history and actions enforce owner/editor membership, exact subjects, CSRF, ETags and archived read-only history', async () => {
  const { f, runId, subject } = await setup()
  const result = await rounds(f, runId, subject, 1), http = await startHttp(f)
  const base = `/${runId}/summaries/${subject.kind}/${subject.subjectId}`
  try {
    for (const role of ['owner', 'editor']) {
      const response = await http.request(`${base}/history`, 'GET', undefined, { role })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal((await response.json()).entries.length, 3)
    }
    assert.equal((await http.request(`${base}/history`, 'GET', undefined, { role: 'viewer' })).status, 403)
    assert.equal((await http.request(`${base}/history`, 'GET', undefined, { role: 'stranger' })).status, 404)
    assert.equal((await http.request(`${base}/history?limit=1`)).status, 400)
    assert.equal((await http.request(`/${runId}/summaries/candidate/analysis-comparison-${randomUUID()}/history`)).status, 404)
    const chosen = selection(result.current.record, result.entries[0])
    const headers = { 'if-match': result.current.etag, 'idempotency-key': randomUUID() }
    for (const action of ['retry', 'publish']) {
      const body = action === 'retry' ? {} : chosen
      assert.equal((await http.request(`${base}/${action}`, 'POST', body, { role: 'viewer', headers })).status, 403)
      assert.equal((await http.request(`${base}/${action}`, 'POST', body, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403)
      assert.equal((await http.request(`${base}/${action}`, 'POST', body, { headers: { 'idempotency-key': randomUUID() } })).status, 428)
      assert.equal((await http.request(`${base}/${action}`, 'POST', body, { headers: { ...headers, 'idempotency-key': 'not-a-uuid' } })).status, 400)
    }
    const retry = await http.request(`${base}/retry`, 'POST', {}, { role: 'editor', headers })
    assert.equal(retry.status, 202)
    assert.ok((await retry.json()).summaries)
    const run = await f.analysis.store.get(f.workspaceId, runId)
    const lifecycle = new api.AnalysisLibraryLifecycleService(f.analysis, clock(f))
    await lifecycle.change(f.workspaceId, runId, 'archive', run.etag, ACTOR)
    const archived = await http.request(`${base}/history`, 'GET', undefined, { role: 'editor' })
    assert.equal(archived.status, 200)
    const history = await archived.json()
    assert.deepEqual(history.capabilities, { canPublish: false, canRetry: false })
    assert.equal((await http.request(`${base}/retry`, 'POST', {}, { headers: {
      'if-match': history.etag, 'idempotency-key': randomUUID(),
    } })).status, 409)
    assert.equal(f.mutationLeases.active, 0)
  } finally { await http.close() }
})

test('legacy v1 publications remain hash-stable and use legacy provenance/prose validation only', async () => {
  const { f, runId, subject } = await setup()
  const current = await claim(f, runId, subject)
  const state = await api.readSummarySubject(f.analysis, f.workspaceId, runId, subject)
  const output = {
    text: 'The saved record describes engineering work. The assessment records supported evidence. Human review remains necessary.',
    overview: 'The saved assessment records engineering evidence.',
    claims: [...[0, 1, 2].map(sentenceIndex => ({ id: `claim-${sentenceIndex}`,
      location: { field: 'text', sentenceIndex }, references: [{ kind: 'overall', comparisonId: subject.subjectId }] })),
    { id: 'overview-claim', location: { field: 'overview', sentenceIndex: 0 }, references: [{ kind: 'overall', comparisonId: subject.subjectId }] }],
  }
  const artifact = api.parseAnalysisNarrativeArtifact({
    schemaVersion: 1, dataKind: 'real', kind: 'candidate', createdAt: f.now, generationId: current.record.generationId,
    requestId: current.record.requestId, inputFingerprint: state.inputFingerprint, humanReviewRequired: true, binding: state.binding, ...output,
    provenance: {
      attemptId: current.record.attemptId, outputSha256: api.analysisHash(output), generation: provenance(f.now), correctionCount: 0,
      groundingReviews: [{ id: 'legacy-review', outcome: 'supported', issues: [], inputFingerprint: state.inputFingerprint,
        outputSha256: api.analysisHash(output), provenance: provenance(f.now) }],
    },
  })
  const name = api.analysisNarrativeBlobName(f.workspaceId, runId, subject.kind, subject.subjectId, current.record.generationId, current.record.attemptId)
  const blob = await api.putAnalysisJson(f.analysis.blobs, name, artifact)
  const record = { ...current.record, status: 'ready', published: { blob, revision: blob.sha256,
    generationId: current.record.generationId, publishedAt: f.now, inputFingerprint: state.inputFingerprint } }
  delete record.lease
  await save(f, runId, record, current.etag)
  const summaries = await api.readAnalysisSummaries(f.analysis, f.workspaceId, runId)
  assert.equal(summaries.comparisons[0].published.summaryVersion, undefined)
  assert.equal(summaries.comparisons[0].published.approval, undefined)
  assert.equal(sha(f.analysis.blobs.values.get(name).bytes), blob.sha256)
  assert.equal((await api.readAnalysisNarrativePublication(f.analysis.blobs, record)).provenance.outputSha256, api.analysisHash(output))
  const invalid = clone(artifact); invalid.provenance.groundingReviews = []
  assert.throws(() => api.parseAnalysisNarrativeArtifact(invalid))
})
