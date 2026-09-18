import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, seedResume, seedJob, seedGrade, createRun, finishInitialization, publishResult, startHttp,
  ACTOR, NOW, LATER, clone, citation, jsonBytes, sha,
} from './real-analyses.test-support.mjs'

const comparisons = (f, runId) => [...f.analysis.store.values.values()]
  .filter(value => value.record.recordType === 'analysis-comparison' && value.record.runId === runId)
  .sort((left, right) => left.record.index - right.record.index)
const query = ids => new URLSearchParams(ids.map(id => ['comparisonId', id])).toString()
const reportPath = (runId, ids) => `/${runId}/report-comparisons?${query(ids)}`
const reads = f => f.analysis.blobs.events.filter(event => event[0] === 'read').map(event => event[1])
const readOnly = f => {
  const fail = async () => { throw new Error('Report reads must not mutate saved or live evidence.') }
  for (const store of [f.analysis.store, f.resumes?.store, f.jobs?.store, f.grades?.store].filter(Boolean)) {
    store.create = store.replace = store.transact = fail
  }
  f.analysis.blobs.putImmutable = fail
  for (const source of [f.resumes, f.jobs, f.grades].filter(Boolean)) {
    source.store.get = source.store.list = source.store.listRubrics = fail
    source.blobs.read = source.blobs.putImmutable = fail
  }
}

async function publishGradeResult(f, runId, comparisonId) {
  let run = await f.analysis.store.get(f.workspaceId, runId)
  let comparison = await f.analysis.store.get(f.workspaceId, comparisonId)
  const attemptId = randomUUID()
  const running = { ...comparison.record, status: 'running', attempts: 1, attemptId,
    lease: { owner: 'report-test-worker', heartbeatAt: NOW, expiresAt: LATER } }
  delete running.nextAttemptAt
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: running, etag: comparison.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, comparison.record, running, NOW), etag: run.etag },
  ])
  run = await f.analysis.store.get(f.workspaceId, runId)
  comparison = await f.analysis.store.get(f.workspaceId, comparisonId)
  const snapshots = await api.readAnalysisSnapshots(f.analysis.blobs, run.record, comparison.record)
  const target = snapshots.targetSnapshot
  assert.equal(target.kind, 'grade')
  const assessment = {
    summary: 'Frozen GS work-level evidence and separate qualification review.', limitations: [],
    criteria: target.version.rubric.criteria.map(criterion => ({
      criterionId: criterion.id, weight: criterion.weight, rationale: 'Saved exact evidence, not an official eligibility determination.',
      requirementCitations: target.requirementEvidence.find(item => item.kind === 'criterion' && item.criterionId === criterion.id).citations,
      ...(criterion.support === 'not-applicable' ? { evidenceStatus: 'not-applicable', score: null, citations: [] }
        : { evidenceStatus: 'supported', score: 4, citations: [citation(snapshots.resumeSnapshot.document)] }),
    })),
    qualifications: target.version.qualifications.map(qualification => ({
      qualificationId: qualification.id, evidenceStatus: 'partial', rationale: 'Education and experience alternatives need separate human review.',
      citations: [citation(snapshots.resumeSnapshot.document)],
      requirementCitations: target.requirementEvidence.find(item => item.kind === 'qualification' && item.qualificationId === qualification.id).citations,
    })),
  }
  const assessmentSha256 = api.analysisAssessmentHash(assessment)
  const model = { model: 'saved-test-model', deployment: 'saved-deployment', promptVersion: 'saved-prompt', schemaVersion: '1',
    startedAt: NOW, completedAt: NOW, inputCharacters: 1000 }
  const result = api.parseAnalysisResult({
    ...assessment, ...api.calculateAnalysisSummary(assessment.criteria, assessment.qualifications, assessment.limitations),
    schemaVersion: 1, dataKind: 'real', workspaceId: f.workspaceId, runId, comparisonId, createdAt: NOW, humanReviewRequired: true,
    provenance: { attemptId, manifestSha256: run.record.manifest.sha256, assessmentSha256, assessment: model,
      resumeSnapshot: { snapshotId: comparison.record.resume.snapshotId, sha256: comparison.record.resume.blob.sha256 },
      targetSnapshot: { snapshotId: comparison.record.target.snapshotId, sha256: comparison.record.target.blob.sha256 },
      groundingReviews: [{
        id: `grounding-${randomUUID()}`, outcome: 'supported', issues: [], assessmentSha256,
        resumeSnapshotSha256: comparison.record.resume.blob.sha256, targetSnapshotSha256: comparison.record.target.blob.sha256, provenance: model,
      }], correctionCount: 0, calculationVersion: 'weighted-0-100-v1' },
  })
  api.assertAnalysisResultBinding(result, run.record, comparison.record, snapshots.resumeSnapshot, target)
  const reference = await api.putAnalysisJson(f.analysis.blobs, api.analysisResultBlobName(f.workspaceId, runId, comparisonId, attemptId), result)
  const completed = { ...comparison.record, status: 'complete', completedAt: NOW, result: reference,
    resultSummary: { completion: result.completion, overall: result.overall, coverage: result.coverage } }
  delete completed.lease
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: completed, etag: comparison.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, comparison.record, completed, NOW), etag: run.etag },
  ])
  return result
}

async function selectedRun(f, resumes, targets) {
  const { run } = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Frozen report evidence', resumes: resumes.map(resume => resume.selection), targets: targets.map(target => target.selection),
  }, ACTOR)
  await finishInitialization(f, run.id)
  return run
}

test('report GET permits authenticated viewers, enforces workspace read authorization before private reads, and stays no-store', async () => {
  const f = fixture()
  const { run } = await createRun(f, 2, 1)
  const ids = comparisons(f, run.id).map(value => value.record.id)
  await publishResult(f, run.id, ids[0])
  const writes = clone(f.analysis.store.batches)
  readOnly(f)
  f.resumes = f.jobs = f.grades = undefined
  const http = await startHttp(f)
  const storeReads = []
  const get = f.analysis.store.get
  f.analysis.store.get = async (...args) => { storeReads.push(args); return get(...args) }
  try {
    for (const role of ['owner', 'viewer']) {
      const response = await http.request(reportPath(run.id, ids), 'GET', undefined, { role })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const report = await response.json()
      assert.equal(report.dataKind, 'real')
      assert.equal(report.runId, run.id)
      assert.equal(report.comparisons.length, 2)
      assert.equal(report.comparisons[0].overall.score, 80)
      assert.equal(report.comparisons[1].status, 'queued')
      assert.deepEqual(report.comparisons[1].criteria, [])
      assert.deepEqual(report.comparisons[1].qualifications, [])
      for (const field of ['completion', 'summary', 'coverage', 'analyzedAt', 'resultSha256']) assert.equal(report.comparisons[1][field], null)
      assert.equal(report.targets[0].criteria.length, 1)
      assert.equal(report.targets[0].id, comparisons(f, run.id)[0].record.target.summary.id)
      assert.ok(!JSON.stringify(report).includes('blobName'))
      assert.ok(!JSON.stringify(report).includes('"paragraphs"'))
      assert.ok(!JSON.stringify(report).includes('"original"'))
    }
    for (const options of [{ noAuth: true }, { role: 'stranger' }]) {
      storeReads.length = 0
      f.analysis.blobs.events.length = 0
      const response = await http.request(reportPath(run.id, ids), 'GET', undefined, options)
      assert.equal(response.status, options.noAuth ? 401 : 404)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(storeReads, [])
      assert.deepEqual(reads(f), [])
    }
    storeReads.length = 0
    const foreign = await http.request(`/../../foreign-workspace/analyses${reportPath(run.id, ids)}`)
    assert.equal(foreign.status, 404)
    assert.equal(foreign.headers.get('cache-control'), 'no-store')
    assert.deepEqual(storeReads, [])
    assert.deepEqual(f.analysis.store.batches, writes)
  } finally { await http.close() }
})

test('report query accepts exactly 25 distinct IDs and rejects malformed, duplicate, oversized or extra input before reading private stores', async () => {
  const f = fixture()
  const { run } = await createRun(f, 25, 1)
  const ids = comparisons(f, run.id).map(value => value.record.id)
  const http = await startHttp(f)
  const gets = []
  const get = f.analysis.store.get
  f.analysis.store.get = async (...args) => { gets.push(args); return get(...args) }
  try {
    const valid = await http.request(reportPath(run.id, ids), 'GET', undefined, { role: 'viewer' })
    assert.equal(valid.status, 200)
    assert.equal((await valid.json()).comparisons.length, 25)
    const invalid = [
      '', '?comparisonId=', '?comparisonId=not-an-analysis-id', '?comparisonId[]=not-an-id',
      `?comparisonId=${ids[0]},${ids[1]}`, `?${query([ids[0], ids[0]])}`,
      `?${query([...ids, `analysis-comparison-${randomUUID()}`])}`,
      `?${query([ids[0]])}&result=100`, `?${query([ids[0]])}&blobName=private.json`,
      `?${query([ids[0]])}&url=https%3A%2F%2Fexample.test`, `?${query([ids[0]])}&limit=25`,
      '?comparisonId[scope]=nested',
    ]
    for (const suffix of invalid) {
      gets.length = 0
      f.analysis.blobs.events.length = 0
      const response = await http.request(`/${run.id}/report-comparisons${suffix}`)
      assert.equal(response.status, 400, suffix)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(gets, [])
      assert.deepEqual(reads(f), [])
    }
    for (const invalidIds of [[], [ids[0], ids[0]], [...ids, `analysis-comparison-${randomUUID()}`], ['invalid']]) {
      await assert.rejects(f.service.reportComparisons(f.workspaceId, run.id, invalidIds), error => error.status === 400)
    }
  } finally { await http.close() }
})

test('foreign-run comparison IDs, missing results, corrupt digests and manifest/summary bindings fail rather than returning partial report data', async () => {
  const f = fixture()
  const { run } = await createRun(f, 2, 1)
  const other = await createRun(f)
  const ids = comparisons(f, run.id).map(value => value.record.id)
  await publishResult(f, run.id, ids[0])
  const complete = (await f.analysis.store.get(f.workspaceId, ids[0])).record
  const names = [run.manifest.blobName, complete.resume.blob.blobName, complete.target.blob.blobName, complete.result.blobName]
  const http = await startHttp(f)
  try {
    const foreign = await http.request(reportPath(run.id, [comparisons(f, other.run.id)[0].record.id]))
    assert.equal(foreign.status, 404)
    const unknown = await http.request(reportPath(`analysis-run-${randomUUID()}`, ids))
    assert.equal(unknown.status, 404)
    for (const name of names) for (const corrupt of ['missing', 'bytes', 'metadata']) {
      const original = clone(f.analysis.blobs.values.get(name))
      if (corrupt === 'missing') f.analysis.blobs.values.delete(name)
      else if (corrupt === 'bytes') f.analysis.blobs.values.get(name).bytes[0] ^= 1
      else f.analysis.blobs.values.get(name).sha256 = '0'.repeat(64)
      const response = await http.request(reportPath(run.id, ids))
      assert.equal(response.status, 503, `${name}: ${corrupt}`)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const body = await response.json()
      assert.ok(body.error)
      assert.equal(body.comparisons, undefined)
      f.analysis.blobs.values.set(name, original)
    }
    const reference = complete.result
    const savedBlob = clone(f.analysis.blobs.values.get(reference.blobName))
    const savedRecord = clone(await f.analysis.store.get(f.workspaceId, ids[0]))
    const result = JSON.parse(Buffer.from(savedBlob.bytes).toString('utf8'))
    result.provenance.manifestSha256 = '0'.repeat(64)
    const bytes = jsonBytes(result)
    f.analysis.blobs.values.set(reference.blobName, { ...savedBlob, bytes, sha256: sha(bytes) })
    f.analysis.store.save({ ...complete, result: { ...reference, sha256: sha(bytes), bytes: bytes.length } })
    const reboundDigest = await http.request(reportPath(run.id, ids))
    assert.equal(reboundDigest.status, 503, 'Valid new blob digest must not bypass frozen result provenance binding.')
    f.analysis.blobs.values.set(reference.blobName, savedBlob)
    f.analysis.store.values.set(`${f.workspaceId}/${ids[0]}`, savedRecord)
    const corruptSummary = clone(complete)
    corruptSummary.resultSummary.overall.score = 100
    f.analysis.store.save(corruptSummary)
    assert.equal((await http.request(reportPath(run.id, ids))).status, 503)
    f.analysis.store.values.set(`${f.workspaceId}/${ids[0]}`, savedRecord)
    assert.equal((await http.request(reportPath(run.id, ids))).status, 200)
  } finally { await http.close() }
})

test('report evidence stays frozen after all live source libraries change or disappear, and citations distinguish PDF/HTML/Markdown/Word', async () => {
  const f = fixture()
  const formats = ['pdf', 'url', 'markdown', 'docx', 'doc']
  const resumes = [], jobs = []
  for (const kind of formats) {
    resumes.push(await seedResume(f, `Captured ${kind} candidate`, randomUUID(), { kind }))
    jobs.push(await seedJob(f, `Captured ${kind} role`, randomUUID(), { kind, ...(kind === 'markdown' ? { page: 51 } : {}) }))
  }
  const run = await selectedRun(f, resumes, jobs)
  const records = comparisons(f, run.id).map(value => value.record)
  for (const record of records) await publishResult(f, run.id, record.id)
  const baseline = clone([...f.analysis.store.values.values()])
  for (const values of [f.resumeValues, f.jobValues, f.rubricValues, f.gradeValues, f.resumes.blobs.values, f.jobs.blobs.values, f.grades.blobs.values]) values.clear()
  readOnly(f)
  const historical = new api.RealAnalysisService(f.analysis)
  const report = await historical.reportComparisons(f.workspaceId, run.id, records.map(record => record.id))
  assert.equal(report.comparisons.length, 25)
  for (const comparison of report.comparisons) {
    const resume = resumes[Math.floor(comparison.index / jobs.length)]
    const job = jobs[comparison.index % jobs.length]
    assert.equal(comparison.candidate.name, resume.record.resume.name)
    assert.equal(comparison.candidate.documentSha256, resume.selection.documentSha256)
    assert.equal(comparison.overall.score, 80)
    assert.equal(comparison.summary, 'Evidence in the submitted document, for human review only.')
    const criterion = comparison.criteria[0]
    assert.equal(criterion.citations[0].pagination, api.documentPagination(resume.original.contentType))
    assert.equal(criterion.requirementCitations[0].pagination, api.documentPagination(job.original.contentType))
    for (const cited of [criterion.citations[0], criterion.requirementCitations[0]]) {
      if (cited.pagination === 'pdf-pages') assert.match(cited.locator, /PDF page/)
      else assert.ok(!/PDF page/.test(cited.locator))
      if (cited.pagination === 'captured-sections') assert.match(cited.locator, /not a printed page/)
      assert.ok(cited.locator.includes(cited.documentId))
      assert.ok(cited.locator.includes(`version ${cited.documentVersion}`))
    }
    assert.equal(criterion.requirementCitations[0].quote, job.document.paragraphs[0].text)
    const target = report.targets.find(target => target.id === comparison.targetId)
    assert.equal(target.id, records[comparison.index].target.summary.id)
    assert.equal(target.label, job.record.job.title)
    assert.deepEqual(target.selection, job.selection)
  }
  assert.deepEqual([...f.analysis.store.values.values()], baseline)
})

test('GS reports preserve approved context, exclusions, separate qualification interpretations, and validated reference locators', async () => {
  const f = fixture()
  const resume = await seedResume(f, 'GS example', randomUUID(), { kind: 'docx' })
  const job = await seedJob(f, 'GS seed', randomUUID(), { kind: 'markdown' })
  const grade = await seedGrade(f, job, { includeContentType: true })
  const supporting = grade.sourceSet.sources.find(source => source.origin !== 'seed-job')
  const oldOriginal = supporting.originalBlobName
  supporting.originalBlobName = oldOriginal.replace(/\.pdf$/, '.html')
  supporting.originalContentType = 'text/html'
  const html = Buffer.from('<html><body>Captured agency engineering evidence.</body></html>')
  supporting.sha256 = sha(html)
  await f.grades.blobs.putImmutable(supporting.originalBlobName, html, 'text/html')
  grade.sourceSet.contentHash = api.gradeSourceSetHash(grade.sourceSet)
  grade.selection.sourceSetHash = grade.sourceSet.contentHash
  f.gradeValues.set(`${f.workspaceId}/${grade.sourceSet.id}`, { record: clone(grade.sourceSet), etag: '"approved-frozen-set"' })
  const run = await selectedRun(f, [resume], [grade])
  const [record] = comparisons(f, run.id).map(value => value.record)
  const result = await publishGradeResult(f, run.id, record.id)
  const detail = await f.service.comparisonDetail(f.workspaceId, run.id, record.id)
  for (const values of [f.gradeValues, f.grades.blobs.values, f.jobValues, f.jobs.blobs.values]) values.clear()
  readOnly(f)
  const report = await new api.RealAnalysisService(f.analysis).reportComparisons(f.workspaceId, run.id, [record.id])
  const target = report.targets[0], comparison = report.comparisons[0]
  assert.equal(target.id, grade.head.approvedVersionId === target.selection.versionId ? record.target.summary.id : 'wrong approved version')
  assert.deepEqual(target.selection, grade.selection)
  assert.ok(target.facts.some(fact => fact.label === 'Agency' && fact.value === 'Historical agency'))
  assert.ok(target.facts.some(fact => fact.label.endsWith('— interpretation') && fact.value === grade.version.rubric.criteria[0].interpretation))
  assert.equal(comparison.overall.score, result.overall.score)
  assert.equal(comparison.criteria[1].evidenceStatus, 'not-applicable')
  assert.equal(comparison.criteria[1].score, null)
  assert.equal(comparison.criteria[1].weight, 0)
  assert.equal(comparison.qualifications.length, 1)
  assert.equal(comparison.qualifications[0].text, grade.version.qualifications[0].text)
  assert.equal(comparison.qualifications[0].interpretation, grade.version.qualifications[0].interpretation)
  assert.equal(comparison.qualifications[0].support, grade.version.qualifications[0].support)
  assert.equal(comparison.qualifications[0].score, undefined)
  for (const row of [...comparison.criteria, ...comparison.qualifications]) {
    assert.ok(row.requirementCitations.every(cited => cited.pagination === 'html-sections' && /Captured HTML section/.test(cited.locator)))
    assert.ok(row.citations.every(cited => cited.pagination === 'captured-sections' && /not a printed page/.test(cited.locator)))
  }
  const referenceName = detail.targetSnapshot.references.find(reference => reference.source.origin !== 'seed-job').document.blobName
  f.analysis.blobs.values.delete(referenceName)
  await assert.rejects(new api.RealAnalysisService(f.analysis).reportComparisons(f.workspaceId, run.id, [record.id]), /Captured blob/)
})

test('request-scoped reuse reads each manifest/resume/target/reference once and never trusts a cache from another request', async () => {
  const f = fixture()
  const resumes = [await seedResume(f), await seedResume(f), await seedResume(f)]
  const grade = await seedGrade(f)
  const run = await selectedRun(f, resumes, [grade])
  const records = comparisons(f, run.id).map(value => value.record)
  for (const record of records) await publishGradeResult(f, run.id, record.id)
  const detail = await f.service.comparisonDetail(f.workspaceId, run.id, records[0].id)
  const references = detail.targetSnapshot.references.map(reference => reference.document.blobName)
  f.analysis.blobs.events.length = 0
  const ids = records.map(record => record.id)
  const first = await f.service.reportComparisons(f.workspaceId, run.id, ids)
  const expected = [run.manifest.blobName, records[0].target.blob.blobName, ...references,
    ...records.map(record => record.resume.blob.blobName),
    ...comparisons(f, run.id).map(value => value.record.result.blobName)]
  assert.equal(reads(f).length, expected.length)
  for (const name of expected) assert.equal(reads(f).filter(value => value === name).length, 1, name)
  f.analysis.blobs.events.length = 0
  assert.deepEqual(await f.service.reportComparisons(f.workspaceId, run.id, ids), first)
  for (const name of expected) assert.equal(reads(f).filter(value => value === name).length, 1, name)
  f.analysis.blobs.values.get(references[0]).bytes[0] ^= 1
  await assert.rejects(f.service.reportComparisons(f.workspaceId, run.id, ids), /digest/)
})

test('one batch reuses resumes across targets and verifies identical original bytes once without retaining originals in its output', async () => {
  const f = fixture()
  const { run } = await createRun(f, 2, 3)
  const records = comparisons(f, run.id).map(value => value.record)
  const target = JSON.parse(Buffer.from(f.analysis.blobs.values.get(records[0].target.blob.blobName).bytes).toString('utf8'))
  const expected = new Set([run.manifest.blobName, target.original.blobName,
    ...records.map(record => record.resume.blob.blobName), ...records.map(record => record.target.blob.blobName)])
  f.analysis.blobs.events.length = 0
  const report = await f.service.reportComparisons(f.workspaceId, run.id, records.map(record => record.id))
  assert.equal(report.comparisons.length, 6)
  assert.equal(reads(f).length, expected.size)
  for (const name of expected) assert.equal(reads(f).filter(value => value === name).length, 1, name)
  assert.ok(!JSON.stringify(report).includes(target.original.blobName))
  assert.ok(report.comparisons.every(comparison => !comparison.criteria.length && !comparison.provenance.length))
})

test('snapshot reuse is bounded, cancellable, rejects foreign comparisons, and preserves existing detail validation', async () => {
  const f = fixture()
  const { run } = await createRun(f, 2, 1)
  const records = comparisons(f, run.id).map(value => value.record)
  const tiny = api.createAnalysisSnapshotReader(f.analysis.blobs, run, { maxComparisons: 2, maxBytes: 1 })
  await assert.rejects(tiny.snapshots(records[0]), error => error.status === 400 && /read budget.*Narrow/.test(error.message))
  const bounded = api.createAnalysisSnapshotReader(f.analysis.blobs, run, { maxComparisons: 1, maxBytes: 32 * 1024 * 1024 })
  await bounded.snapshots(records[0])
  await assert.rejects(bounded.snapshots(records[1]), /comparison budget/)
  const controller = new AbortController()
  controller.abort()
  f.analysis.blobs.events.length = 0
  await assert.rejects(f.service.reportComparisons(f.workspaceId, run.id, [records[0].id], controller.signal), error => error.name === 'AbortError')
  assert.deepEqual(reads(f), [])
  const during = new AbortController()
  const originalRead = f.analysis.blobs.read
  f.analysis.blobs.read = async name => {
    const blob = await originalRead(name)
    during.abort()
    return blob
  }
  await assert.rejects(f.service.reportComparisons(f.workspaceId, run.id, [records[0].id], during.signal), error => error.name === 'AbortError')
  assert.deepEqual(reads(f), [run.manifest.blobName])
  f.analysis.blobs.read = originalRead
  const snapshots = await api.readAnalysisSnapshots(f.analysis.blobs, run, records[0])
  const mismatched = clone(records[1])
  mismatched.resume = records[0].resume
  await assert.rejects(api.readAnalysisSnapshots(f.analysis.blobs, run, mismatched), /immutable plan/)
  await assert.rejects(api.createAnalysisSnapshotReader(f.analysis.blobs, run, { maxComparisons: 2, maxBytes: 32 * 1024 * 1024 }).snapshots(mismatched), /immutable plan/)
  assert.deepEqual(snapshots, {
    resumeSnapshot: (await f.service.comparisonDetail(f.workspaceId, run.id, records[0].id)).resumeSnapshot,
    targetSnapshot: (await f.service.comparisonDetail(f.workspaceId, run.id, records[0].id)).targetSnapshot,
  })
})

test('completed withheld scores are returned verbatim, not recalculated or substituted', async () => {
  const f = fixture()
  const { run } = await createRun(f)
  const [record] = comparisons(f, run.id).map(value => value.record)
  const saved = await publishResult(f, run.id, record.id, true)
  const report = await f.service.reportComparisons(f.workspaceId, run.id, [record.id])
  assert.deepEqual(report.comparisons[0].overall, saved.result.overall)
  assert.equal(report.comparisons[0].completion, 'limited')
  assert.equal(report.comparisons[0].criteria[0].evidenceStatus, 'not-assessed')
  assert.equal(report.comparisons[0].criteria[0].score, null)
  assert.deepEqual(report.comparisons[0].criteria[0].limitation, saved.result.criteria[0].limitation)
  assert.equal(report.comparisons[0].resultSha256, saved.reference.sha256)
})
