import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, createRun, publishResult, startHttp, ACTOR, clone,
} from './real-analyses.test-support.mjs'

const comparisons = (f, runId) => [...f.analysis.store.values.values()]
  .filter(value => value.record.recordType === 'analysis-comparison' && value.record.runId === runId)
  .sort((a, b) => a.record.index - b.record.index)

function diagnosticFor(run, comparison, createdAt, attemptId = randomUUID()) {
  return {
    schemaVersion: 1, dataKind: 'real', workspaceId: run.workspaceId, runId: run.id, comparisonId: comparison.id,
    attemptId, createdAt, pipelineVersion: api.ANALYSIS_PIPELINE_VERSION,
    manifestSha256: run.manifest.sha256,
    resumeSnapshot: { snapshotId: comparison.resume.snapshotId, sha256: comparison.resume.blob.sha256 },
    targetSnapshot: { snapshotId: comparison.target.snapshotId, sha256: comparison.target.blob.sha256 },
    processingAttempt: 1, retryCount: comparison.retryCount, correctionCount: 2,
    error: { code: 'invalid-model-output', stage: 'assessment', retryable: false, message: 'The model did not return valid JSON. No score was published.' },
    reason: 'invalid-json', events: [], omittedEvents: 0, assessments: [],
    ...(comparison.failureDiagnostic ? { previous: comparison.failureDiagnostic } : {}),
  }
}

async function saveFailure(f, runId, comparisonId) {
  const run = await f.analysis.store.get(f.workspaceId, runId)
  const comparison = await f.analysis.store.get(f.workspaceId, comparisonId)
  f.now = new Date(Date.parse(f.now) + 1000).toISOString()
  const diagnostic = api.parseAnalysisFailureDiagnostic(diagnosticFor(run.record, comparison.record, f.now))
  const name = api.analysisDiagnosticBlobName(f.workspaceId, runId, comparisonId, diagnostic.attemptId)
  const blob = await api.putAnalysisJson(f.analysis.blobs, name, diagnostic)
  const next = {
    ...comparison.record, status: 'failed', updatedAt: f.now, attemptId: diagnostic.attemptId, attempts: 1,
    error: diagnostic.error, failureDiagnostic: { attemptId: diagnostic.attemptId, createdAt: f.now, blob },
    diagnosticCapture: { attemptId: diagnostic.attemptId, status: 'saved', pipelineVersion: diagnostic.pipelineVersion },
  }
  delete next.nextAttemptAt
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: next, etag: comparison.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, comparison.record, next, f.now), etag: run.etag },
  ])
  return diagnostic
}

test('diagnostic history is immutable, paginated one attempt at a time and preserved by ordinary retry', async () => {
  const f = fixture()
  const created = await createRun(f, 1, 2)
  const [pair] = comparisons(f, created.run.id)
  const first = await saveFailure(f, created.run.id, pair.record.id)
  const failed = await f.analysis.store.get(f.workspaceId, pair.record.id)
  const originalReference = clone(failed.record.failureDiagnostic)
  const originalBytes = clone(f.analysis.blobs.values.get(originalReference.blob.blobName))
  await f.service.comparisonAction(f.workspaceId, created.run.id, pair.record.id, 'retry', failed.etag)
  const queued = await f.analysis.store.get(f.workspaceId, pair.record.id)
  assert.deepEqual(queued.record.failureDiagnostic, originalReference)
  assert.equal(queued.record.error, undefined)
  assert.equal(queued.record.attemptId, undefined)
  const second = await saveFailure(f, created.run.id, pair.record.id)
  const page = await f.service.diagnostics(f.workspaceId, created.run.id, pair.record.id)
  assert.deepEqual(page.attempts, [second])
  assert.ok(page.continuationToken)
  const older = await f.service.diagnostics(f.workspaceId, created.run.id, pair.record.id, page.continuationToken)
  assert.deepEqual(older, { attempts: [first] })
  assert.deepEqual(f.analysis.blobs.values.get(originalReference.blob.blobName), originalBytes)
  const latest = await f.analysis.store.get(f.workspaceId, pair.record.id)
  const erased = clone(latest.record)
  delete erased.failureDiagnostic
  assert.throws(() => api.assertAnalysisReplacement(latest.record, erased), /cannot be erased/)
  const changed = clone(latest.record)
  changed.failureDiagnostic.blob.sha256 = 'a'.repeat(64)
  assert.throws(() => api.assertAnalysisReplacement(latest.record, changed), /immutable attempt replaced/)
})

test('disabled private diagnostic capture persists without an artifact and remains readable through retry', async () => {
  const f = fixture()
  const settings = api.createDefaultAdminSettings()
  settings.diagnostics.capturePrivateFailures = false
  f.service = new api.RealAnalysisService(f.analysis, f, () => new Date(f.now),
    async () => api.captureProcessingSettings(settings, 'private-capture-disabled', f.now))
  const created = await createRun(f)
  const [pair] = comparisons(f, created.run.id)
  const run = await f.analysis.store.get(f.workspaceId, created.run.id)
  const attemptId = randomUUID()
  const failed = {
    ...pair.record, status: 'failed', attemptId, attempts: 1,
    error: { code: 'invalid-model-output', stage: 'assessment', retryable: false, message: 'The model did not return valid JSON. No score was published.' },
    diagnosticCapture: { attemptId, status: 'disabled', pipelineVersion: api.ANALYSIS_PIPELINE_VERSION },
  }
  delete failed.nextAttemptAt
  assert.equal(api.parseAnalysisEntity(failed).diagnosticCapture.status, 'disabled')
  const serialized = JSON.stringify(failed)
  const decoded = api.parseAnalysisEntity(JSON.parse(serialized))
  assert.deepEqual(decoded, api.parseAnalysisEntity(failed))
  assert.equal(decoded.failureDiagnostic, undefined)
  assert.equal(api.parseAnalysisEntity({
    ...JSON.parse(serialized), diagnosticCapture: { ...failed.diagnosticCapture, status: 'unavailable' },
  }).diagnosticCapture.status, 'unavailable')
  const legacy = JSON.parse(serialized)
  delete legacy.diagnosticCapture
  assert.equal(api.parseAnalysisEntity(legacy).diagnosticCapture, undefined)
  assert.throws(() => api.parseAnalysisEntity({
    ...failed, diagnosticCapture: { ...failed.diagnosticCapture, status: 'saved' },
  }), /immutable artifact/)
  assert.throws(() => api.parseAnalysisEntity({ ...failed, diagnosticCapture: { ...failed.diagnosticCapture, rawOutput: 'private' } }))
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: failed, etag: pair.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, pair.record, failed, f.now), etag: run.etag },
  ])
  assert.deepEqual(await f.service.diagnostics(f.workspaceId, created.run.id, pair.record.id), { attempts: [] })
  assert.ok([...f.analysis.blobs.values.keys()].every(name => !name.includes('/diagnostics/')))
  const current = await f.analysis.store.get(f.workspaceId, pair.record.id)
  assert.deepEqual(api.parseAnalysisEntity(JSON.parse(JSON.stringify(current.record))).diagnosticCapture, failed.diagnosticCapture)
  await f.service.comparisonAction(f.workspaceId, created.run.id, pair.record.id, 'retry', current.etag)
  const retried = await f.analysis.store.get(f.workspaceId, pair.record.id)
  assert.deepEqual(retried.record.diagnosticCapture, failed.diagnosticCapture)
  assert.deepEqual(retried.record.processingSettings, failed.processingSettings)
})

test('renaming a failed analysis preserves private diagnostics and frozen inputs', async () => {
  const f = fixture()
  const created = await createRun(f)
  const [pair] = comparisons(f, created.run.id)
  const diagnostic = await saveFailure(f, created.run.id, pair.record.id)
  const run = await f.analysis.store.get(f.workspaceId, created.run.id)
  const failed = clone(await f.analysis.store.get(f.workspaceId, pair.record.id))
  const savedDetail = await f.service.comparisonDetail(f.workspaceId, created.run.id, pair.record.id)
  const savedBlobs = clone(f.analysis.blobs.values)
  f.now = new Date(Date.parse(f.now) + 1000).toISOString()

  const renamed = await f.service.updateMetadata(f.workspaceId, created.run.id, {
    displayName: 'Review failed assessment',
  }, run.etag)

  assert.deepEqual(renamed.run, { ...run.record, displayName: 'Review failed assessment', updatedAt: f.now })
  assert.notEqual(renamed.etag, run.etag)
  assert.equal((await api.readAnalysisManifest(f.analysis.blobs, renamed.run)).request.name, created.run.name)
  assert.deepEqual(await f.service.diagnostics(f.workspaceId, created.run.id, pair.record.id), { attempts: [diagnostic] })
  assert.deepEqual(await f.service.comparisonDetail(f.workspaceId, created.run.id, pair.record.id), savedDetail)
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, pair.record.id), failed)
  assert.deepEqual(f.analysis.blobs.values, savedBlobs)
})

test('diagnostic routes require workspace read authorization and reject raw paths and foreign history cursors', async t => {
  const f = fixture()
  const created = await createRun(f, 1, 2)
  const [pair, other] = comparisons(f, created.run.id)
  await saveFailure(f, created.run.id, pair.record.id)
  const failed = await f.analysis.store.get(f.workspaceId, pair.record.id)
  await f.service.comparisonAction(f.workspaceId, created.run.id, pair.record.id, 'retry', failed.etag)
  await saveFailure(f, created.run.id, pair.record.id)
  const http = await startHttp(f)
  t.after(() => http.close())
  const path = `/${created.run.id}/comparisons/${pair.record.id}/diagnostics`
  const response = await http.request(path, 'GET', undefined, { role: 'viewer' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const page = await response.json()
  assert.equal(page.attempts.length, 1)
  assert.equal(page.attempts[0].comparisonId, pair.record.id)
  assert.equal((await http.request(path, 'GET', undefined, { noAuth: true })).status, 401)
  assert.equal((await http.request(path, 'GET', undefined, { role: 'stranger' })).status, 404)
  for (const query of ['?limit=10', '?blobName=private.json', '?continuationToken=', '?continuationToken=a&continuationToken=b']) {
    assert.equal((await http.request(`${path}${query}`)).status, 400, query)
  }
  const otherPath = `/${created.run.id}/comparisons/${other.record.id}/diagnostics`
  assert.equal((await http.request(`${otherPath}?continuationToken=${encodeURIComponent(page.continuationToken)}`)).status, 400)
  assert.equal((await http.request(`/${created.run.id}/comparisons/analysis-comparison-${randomUUID()}/diagnostics`)).status, 404)
  const forged = JSON.parse(Buffer.from(page.continuationToken, 'base64url').toString())
  const reference = JSON.parse(forged.cursor)
  reference.blob.blobName = reference.blob.blobName.replace(pair.record.id, other.record.id)
  forged.cursor = JSON.stringify(reference)
  const token = Buffer.from(JSON.stringify(forged)).toString('base64url')
  assert.equal((await http.request(`${path}?continuationToken=${token}`)).status, 400)
  await assert.rejects(f.service.diagnostics('another-workspace', created.run.id, pair.record.id), error => error.status === 404)
})

test('historical comparisons need no diagnostic metadata, while missing or changed artifacts fail explicitly', async () => {
  const f = fixture()
  const created = await createRun(f)
  const [pair] = comparisons(f, created.run.id)
  assert.deepEqual(await f.service.diagnostics(f.workspaceId, created.run.id, pair.record.id), { attempts: [] })
  assert.equal(api.parseAnalysisEntity(pair.record).failureDiagnostic, undefined)
  await saveFailure(f, created.run.id, pair.record.id)
  const failed = await f.analysis.store.get(f.workspaceId, pair.record.id)
  const reference = failed.record.failureDiagnostic.blob
  const original = clone(f.analysis.blobs.values.get(reference.blobName))
  f.analysis.blobs.values.delete(reference.blobName)
  await assert.rejects(f.service.diagnostics(f.workspaceId, created.run.id, pair.record.id), /missing or its digest changed/)
  f.analysis.blobs.values.set(reference.blobName, { ...original, bytes: Buffer.from('{"changed":true}') })
  await assert.rejects(f.service.diagnostics(f.workspaceId, created.run.id, pair.record.id), /missing or its digest changed/)
})

test('failure diagnostics validate source ownership, assessment hashes, review scopes and bounded typed events', async () => {
  const f = fixture()
  const created = await createRun(f)
  const [pair] = comparisons(f, created.run.id)
  const { result, completed } = await publishResult(f, created.run.id, pair.record.id)
  const run = (await f.analysis.store.get(f.workspaceId, created.run.id)).record
  const snapshots = await api.readAnalysisSnapshots(f.analysis.blobs, run, completed)
  const diagnostic = diagnosticFor(run, completed, f.now, completed.attemptId)
  const assessment = { criteria: result.criteria, qualifications: result.qualifications, summary: result.summary, limitations: result.limitations }
  diagnostic.assessments = [{
    modelCallId: randomUUID(), correctionCount: 0, assessmentSha256: api.analysisAssessmentHash(assessment), assessment,
    provenance: result.provenance.assessment,
    review: {
      ...result.provenance.groundingReviews[0], outcome: 'needs-correction', issues: [{
        code: 'unsupported-score', message: 'PRIVATE-REVIEW-SENTINEL', criterionId: assessment.criteria[0].criterionId,
        citations: [assessment.criteria[0].citations[0]],
      }],
    },
  }]
  const valid = api.parseAnalysisFailureDiagnostic(diagnostic)
  api.assertAnalysisFailureDiagnosticBinding(valid, run, completed, snapshots)
  for (const mutate of [
    value => { value.resumeSnapshot.sha256 = '0'.repeat(64) },
    value => { value.targetSnapshot.snapshotId = `analysis-snapshot-${randomUUID()}` },
    value => { value.manifestSha256 = '0'.repeat(64) },
    value => { value.comparisonId = `analysis-comparison-${randomUUID()}` },
    value => { value.assessments[0].review.issues[0].criterionId = 'foreign-criterion' },
    value => { value.assessments[0].review.issues[0].citations[0].documentId = 'foreign-document' },
  ]) {
    const invalid = clone(valid)
    mutate(invalid)
    assert.throws(() => api.assertAnalysisFailureDiagnosticBinding(invalid, run, completed, snapshots), /diagnostic|Diagnostic/)
  }
  const incorrectHash = clone(valid)
  incorrectHash.assessments[0].assessment.criteria[0].rationale = 'Changed draft'
  assert.throws(() => api.parseAnalysisFailureDiagnostic(incorrectHash), /hash/)
  assert.throws(() => api.parseAnalysisFailureDiagnostic({ ...valid, rawModelOutput: 'PRIVATE-RAW-SENTINEL' }))
  const event = {
    event: 'validation-failed', timestamp: f.now, stage: 'grounding', workspaceId: f.workspaceId,
    runId: run.id, comparisonId: completed.id, attemptId: completed.attemptId,
  }
  assert.throws(() => api.parseAnalysisFailureDiagnostic({ ...valid, events: Array(65).fill(event) }))
  assert.throws(() => api.parseAnalysisFailureDiagnostic({ ...valid, events: [{ ...event, workspaceId: 'another-workspace' }] }), /ownership/)
  assert.throws(() => api.parseAnalysisFailureDiagnostic({ ...valid, events: [{
    ...event, schemaDiagnostics: { findings: [{ code: 'invalid_type', path: ['PRIVATE-FIELD-SENTINEL'] }], omittedFindings: 0 },
  }] }))
})

test('run deletion fences diagnostic reads and removes every retained attempt artifact', async () => {
  const f = fixture()
  const created = await createRun(f)
  const [pair] = comparisons(f, created.run.id)
  await saveFailure(f, created.run.id, pair.record.id)
  let current = await f.analysis.store.get(f.workspaceId, pair.record.id)
  await f.service.comparisonAction(f.workspaceId, created.run.id, pair.record.id, 'retry', current.etag)
  await saveFailure(f, created.run.id, pair.record.id)
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/diagnostics/')).length, 2)
  const lifecycle = new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(f.now))
  current = await f.analysis.store.get(f.workspaceId, created.run.id)
  await lifecycle.change(f.workspaceId, created.run.id, 'delete', current.etag, ACTOR)
  await assert.rejects(f.service.diagnostics(f.workspaceId, created.run.id, pair.record.id), error => error.status === 404)
  const participant = api.createAnalysisLifecycleParticipant(f.analysis)
  for (let pass = 0; pass < 10 && await f.analysis.store.get(f.workspaceId, created.run.id); pass++) {
    await participant.resume(f.workspaceId, f.now)
  }
  assert.equal(await f.analysis.store.get(f.workspaceId, created.run.id), undefined)
  assert.equal(f.analysis.blobs.values.size, 0)
})
