import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { assertLosslessModelInput, passageSelection } from '../worker-tests/analysis-selection-test-support.mjs'
import {
  api, fixture, seedResume, seedJob, seedGrade, createRun, publishResult, ACTOR, NOW, LATER, clone, citation,
} from './real-analyses.test-support.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = path.join(root, 'dist-server', `real-analyses-model-boundary-${process.pid}.mjs`)
after(async () => { await unlink(bundle).catch(error => { if (error.code !== 'ENOENT') throw error }) })
await build({
  entryPoints: [path.join(root, 'worker', 'analyses', 'model.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
})
const model = await import(pathToFileURL(bundle).href)

function response(value, name) {
  return Response.json({ model: name, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })
}

function assessmentResponse(input, { scores = [4], unassessed = false, unassessedIds = [], limitedQualification = false } = {}) {
  const selected = passageSelection(input)
  return {
    criteria: input.rubric.criteria.map((criterion, index) => {
      const base = { criterionId: criterion.id, rationale: 'The submitted document describes the engineering work at this saved anchor.' }
      if (criterion.support === 'not-applicable') return {
        ...base, rationale: 'The approved work-level exclusion is retained as unscored for this rubric.',
        evidenceStatus: 'not-applicable', score: null, citations: [], limitation: null,
      }
      if (unassessed || unassessedIds.includes(criterion.id)) return {
        ...base, rationale: 'The captured source interleaves work descriptions without recoverable attribution.',
        evidenceStatus: 'not-assessed', score: null, citations: [],
        limitation: { code: 'unusable-source', message: 'The merged source text does not identify whose work is described; source repair is required.' },
      }
      const score = scores[index] ?? scores[0]
      return {
        ...base, evidenceStatus: score ? 'partial' : 'missing', score,
        citations: score ? [selected] : [], limitation: null,
      }
    }),
    qualifications: input.qualifications.map(qualification => ({
      qualificationId: qualification.id, evidenceStatus: limitedQualification ? 'not-assessed' : 'missing',
      rationale: 'The submitted document does not establish this qualification alternative; human review remains necessary.',
      citations: [],
      limitation: limitedQualification ? { code: 'not-assessable', message: 'The available source does not establish the qualification scope.' } : null,
    })),
  }
}

async function realModelPublication(f, resume, target, options = {}) {
  const corrections = options.corrections ?? (options.corrected ? 1 : 0)
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Actual model-helper boundary', resumes: [resume.selection], targets: [target.selection],
  }, ACTOR)
  let run = await f.analysis.store.get(f.workspaceId, created.run.id)
  let comparison = [...f.analysis.store.values.values()].find(item => item.record.recordType === 'analysis-comparison' &&
    item.record.runId === run.record.id)
  const attemptId = randomUUID()
  const running = {
    ...comparison.record, status: 'running', attempts: 1, attemptId,
    lease: { owner: 'boundary-worker', heartbeatAt: NOW, expiresAt: LATER },
  }
  delete running.nextAttemptAt
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: running, etag: comparison.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, comparison.record, running, NOW), etag: run.etag },
  ])
  run = await f.analysis.store.get(f.workspaceId, run.record.id)
  comparison = await f.analysis.store.get(f.workspaceId, comparison.record.id)
  const snapshots = await api.readAnalysisSnapshots(f.analysis.blobs, run.record, comparison.record)
  const frozenTarget = snapshots.targetSnapshot
  const input = {
    resume: snapshots.resumeSnapshot.document,
    rubric: frozenTarget.kind === 'job' ? frozenTarget.rubric : frozenTarget.version.rubric,
    qualifications: frozenTarget.kind === 'job' ? [] : frozenTarget.version.qualifications,
    requirementEvidence: frozenTarget.requirementEvidence,
  }
  assert.deepEqual(api.analysisRequirementEvidenceForInput(input), input.requirementEvidence)
  assert.deepEqual(model.validateAnalysisAssessmentInput(input).requirementEvidence, input.requirementEvidence)
  const calls = []
  let assessed = 0
  let reviewed = 0
  let tick = Date.parse(NOW)
  const clock = { now: () => new Date(tick += 1000), sleep: async () => { throw new Error('No retryable transport response was provided.') } }
  const actual = await model.assessResumeAgainstTarget(input, {
    clock, resumeSnapshotSha256: comparison.record.resume.blob.sha256, targetSnapshotSha256: comparison.record.target.blob.sha256,
    model: {
      endpoint: 'https://analysis-boundary.example/', deployment: 'boundary-deployment',
      getToken: async scope => { assert.equal(scope, 'https://cognitiveservices.azure.com/.default'); return 'test-token' },
      fetch: async (_url, init) => {
        const request = JSON.parse(init.body)
        const payload = JSON.parse(request.messages.find(item => item.role === 'user').content)
        calls.push({ request, payload })
        assertLosslessModelInput(payload.input, model.validateAnalysisAssessmentInput(input))
        if (!payload.assessment) {
          assessed++
          return response(assessmentResponse(payload.input, { ...options, ...(assessed <= corrections ? { scores: [assessed] } : {}) }),
            'actual-boundary-assessor')
        }
        reviewed++
        if (reviewed <= corrections) return response({
          outcome: 'needs-correction', issues: [{
            code: 'unsupported-score', message: 'Review the cited scope against the saved score guidance.',
            criterionId: input.rubric.criteria[0].id, qualificationId: null,
            citations: [passageSelection(payload.input)],
          }],
        }, 'actual-boundary-reviewer')
        return response({ outcome: 'supported', issues: [] }, 'actual-boundary-reviewer')
      },
    },
  })
  assert.equal(assessed, corrections + 1)
  assert.equal(reviewed, corrections + 1)
  assert.equal(actual.assessmentSha256, api.analysisHash(actual.assessment))
  assert.equal(actual.assessmentSha256, api.analysisAssessmentHash(actual.assessment))
  assert.equal(model.hashAnalysisAssessment(actual.assessment), actual.assessmentSha256)
  assert.deepEqual(actual.summary, api.calculateAnalysisSummary(actual.assessment.criteria, actual.assessment.qualifications, actual.assessment.limitations))
  assert.deepEqual(api.validateAnalysisAssessment(actual.assessment, input.resume, frozenTarget), [])
  assert.equal(actual.assessmentProvenance.model, 'actual-boundary-assessor')
  assert.ok(actual.groundingReviews.every(item => item.provenance.model === 'actual-boundary-reviewer'))
  f.now = clock.now().toISOString()
  const result = api.parseAnalysisResult({
    ...actual.assessment, ...actual.summary, schemaVersion: 1, dataKind: 'real', workspaceId: f.workspaceId,
    runId: run.record.id, comparisonId: comparison.record.id, createdAt: f.now, humanReviewRequired: true,
    provenance: {
      attemptId, manifestSha256: run.record.manifest.sha256,
      resumeSnapshot: { snapshotId: comparison.record.resume.snapshotId, sha256: comparison.record.resume.blob.sha256 },
      targetSnapshot: { snapshotId: comparison.record.target.snapshotId, sha256: comparison.record.target.blob.sha256 },
      assessmentSha256: actual.assessmentSha256, assessment: actual.assessmentProvenance,
      groundingReviews: actual.groundingReviews, correctionCount: actual.correctionCount, calculationVersion: 'weighted-0-100-v1',
    },
  })
  api.assertAnalysisResultBinding(result, run.record, comparison.record, snapshots.resumeSnapshot, frozenTarget)
  const reference = await api.putAnalysisJson(f.analysis.blobs,
    api.analysisResultBlobName(f.workspaceId, run.record.id, comparison.record.id, attemptId), result)
  const complete = {
    ...comparison.record, status: 'complete', updatedAt: f.now, completedAt: f.now,
    result: reference, resultSummary: actual.summary,
  }
  delete complete.lease
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: complete, etag: comparison.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, comparison.record, complete, f.now), etag: run.etag },
  ])
  const detail = await f.service.comparisonDetail(f.workspaceId, run.record.id, comparison.record.id)
  assert.deepEqual(detail.result, result)
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.provenance.assessment.promptVersion, 'score-analysis-assessment-v4')
  assert.equal(result.provenance.assessment.schemaVersion, 'score-analysis-assessment-v3')
  assert.ok(result.provenance.groundingReviews.every(review =>
    review.provenance.promptVersion === 'score-analysis-grounding-v4' &&
    review.provenance.schemaVersion === 'score-analysis-grounding-v2'))
  assert.doesNotMatch(JSON.stringify(result), /"passageId"|"passages"/)
  return { detail, result, calls, input, snapshots, run, comparison: complete }
}

test('shared canonical content hashing preserves previous fingerprints without changing Blob byte hashes', () => {
  for (const value of [
    { z: 'last', a: 'first', nested: { Z: 2, a: 1, omitted: undefined } },
    { unicode: 'Engineering – résumé', values: [1, null, undefined, { z: 3, b: true }] },
    { '10': 'ten', '2': 'two', '01': 'one', empty: {}, zero: -0 },
    ['ordered', { second: 2, first: 1 }],
  ]) assert.equal(api.analysisHash(value), api.gradeContentHash(value))
  const compact = Buffer.from('{"z":1,"a":2}')
  const reordered = Buffer.from('{\n  "a": 2,\n  "z": 1\n}')
  assert.equal(api.analysisHash(JSON.parse(compact)), api.analysisHash(JSON.parse(reordered)))
  assert.notEqual(api.analysisBytesHash(compact), api.analysisBytesHash(reordered))
  assert.notEqual(api.analysisHash(JSON.parse(compact)), api.analysisBytesHash(compact))
  assert.notEqual(api.analysisHash([1, 2]), api.analysisHash([2, 1]))
})

test('actual assessment and grounding output survives API publication/readback with one correction and fractional weights', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const target = await seedJob(f)
  target.rubric.criteria = [33.33, 33.33, 33.34].map((weight, index) => ({
    ...clone(target.rubric.criteria[0]), id: `engineering-${index}`, weight,
  }))
  target.selection.rubricHash = api.analysisHash(target.rubric)
  const published = await realModelPublication(f, resume, target, { corrected: true, scores: [1, 2, 4] })
  assert.equal(published.result.overall.score, 46.7)
  assert.equal(published.result.completion, 'assessed')
  assert.equal(published.result.provenance.correctionCount, 1)
  assert.equal(published.result.provenance.groundingReviews.length, 2)
  assert.notEqual(published.result.provenance.groundingReviews[0].assessmentSha256, published.result.provenance.assessmentSha256)
  const reordered = value => Array.isArray(value) ? value.map(reordered) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) : value
  assert.deepEqual(api.parseAnalysisResult(reordered(published.result)), published.result)
  const invalid = clone(published.result)
  invalid.provenance.targetSnapshot.sha256 = '0'.repeat(64)
  assert.throws(() => api.parseAnalysisResult(invalid))
  f.resumes.blobs.values.clear()
  f.jobs.blobs.values.clear()
  assert.deepEqual((await f.service.comparisonDetail(f.workspaceId, published.run.record.id, published.comparison.id)).result, published.result)
})

test('historical literal-quote results remain API-readable and byte-identical alongside selection-model publications', async () => {
  const f = fixture()
  const oldRun = await createRun(f)
  const oldComparison = [...f.analysis.store.values.values()].find(item =>
    item.record.recordType === 'analysis-comparison' && item.record.runId === oldRun.run.id).record
  const historical = await publishResult(f, oldRun.run.id, oldComparison.id)
  const historicalBytes = clone(f.analysis.blobs.values.get(historical.reference.blobName).bytes)
  assert.equal(historical.result.schemaVersion, 1)
  assert.equal(historical.result.provenance.assessment.schemaVersion, '1')
  assert.equal(historical.result.provenance.assessment.promptVersion, 'assessment-v1')

  const modern = await realModelPublication(f, await seedResume(f), await seedJob(f))
  assert.equal(modern.result.schemaVersion, historical.result.schemaVersion)
  const citationFields = ['documentId', 'documentVersion', 'heading', 'page', 'paragraphId', 'quote']
  for (const result of [historical.result, modern.result]) {
    assert.deepEqual(api.parseAnalysisResult(result), result)
    assert.deepEqual(Object.keys(result.criteria[0].citations[0]).sort(), citationFields)
    assert.equal(typeof result.criteria[0].citations[0].quote, 'string')
    assert.doesNotMatch(JSON.stringify(result), /"passageId"|"passages"/)
  }
  f.resumeValues.clear()
  f.jobValues.clear()
  f.rubricValues.clear()
  f.resumes.blobs.values.clear()
  f.jobs.blobs.values.clear()
  const historicalDetail = await f.service.comparisonDetail(f.workspaceId, oldRun.run.id, oldComparison.id)
  const modernDetail = await f.service.comparisonDetail(f.workspaceId, modern.run.record.id, modern.comparison.id)
  assert.deepEqual(historicalDetail.result, historical.result)
  assert.deepEqual(modernDetail.result, modern.result)
  assert.deepEqual(f.analysis.blobs.values.get(historical.reference.blobName).bytes, historicalBytes)
  assert.equal(api.analysisBytesHash(historicalBytes), historical.reference.sha256)
  const historicalExcerpt = clone(historical.result)
  historicalExcerpt.criteria[0].citations[0].quote = 'Evaluated engineering systems independently'
  historicalExcerpt.provenance.assessmentSha256 = api.analysisAssessmentHash(historicalExcerpt)
  historicalExcerpt.provenance.groundingReviews[0].assessmentSha256 = historicalExcerpt.provenance.assessmentSha256
  assert.deepEqual(api.parseAnalysisResult(historicalExcerpt), historicalExcerpt)
  const { criteria, qualifications, summary, limitations } = historicalExcerpt
  assert.deepEqual(api.validateAnalysisAssessment(
    { criteria, qualifications, summary, limitations }, historicalDetail.resumeSnapshot.document, historicalDetail.targetSnapshot,
  ), [])
})

test('two corrections and three reviews survive publication/readback without widening provenance guarantees', async () => {
  const f = fixture()
  const published = await realModelPublication(f, await seedResume(f), await seedJob(f), { corrections: 2 })
  assert.equal(published.calls.length, 6)
  assert.equal(published.result.provenance.correctionCount, 2)
  assert.equal(published.result.provenance.groundingReviews.length, 3)
  assert.equal(new Set(published.result.provenance.groundingReviews.map(review => review.assessmentSha256)).size, 3)
  assert.deepEqual(published.detail.result, published.result)
  for (const mutate of [
    result => { result.provenance.correctionCount = 3 },
    result => { result.provenance.correctionCount = 1 },
    result => { result.provenance.groundingReviews.push(clone(result.provenance.groundingReviews.at(-1))) },
    result => { result.provenance.groundingReviews.at(-1).assessmentSha256 = '0'.repeat(64) },
    result => { result.provenance.groundingReviews[1].resumeSnapshotSha256 = '0'.repeat(64) },
  ]) {
    const invalid = clone(published.result)
    mutate(invalid)
    assert.throws(() => api.parseAnalysisResult(invalid))
  }
})

for (const seededJobId of [false, true]) {
  test(`actual GS model output preserves exclusions/qualification evidence with optional jobId ${seededJobId}`, async () => {
    const f = fixture()
    const resume = await seedResume(f)
    const job = await seedJob(f)
    const target = await seedGrade(f, job, {
      configureVersion(version) {
        if (seededJobId) version.rubric.jobId = job.record.id
        version.qualifications[0].citations.push(clone(version.qualifications[0].citations[0]))
      },
    })
    const published = await realModelPublication(f, resume, target, { limitedQualification: true })
    assert.equal(published.result.overall.status, 'available')
    assert.equal(published.result.overall.score, 80)
    assert.equal(published.result.completion, 'limited')
    assert.equal(published.result.coverage.notApplicable, 1)
    assert.equal(published.result.criteria[1].score, null)
    assert.equal(published.result.criteria[1].weight, 0)
    assert.equal(published.result.qualifications[0].evidenceStatus, 'not-assessed')
    assert.equal(published.result.qualifications[0].requirementCitations.length, 1)
    assert.equal(published.snapshots.targetSnapshot.version.qualifications[0].citations.length, 2)
    assert.ok(published.result.qualifications.every(item => !Object.hasOwn(item, 'score')))
  })
}

test('complete approved boundary of 50 qualifications and 60 distinct requirement citations reaches the real model without truncation', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const extraReferenceParagraphs = Array.from({ length: 60 }, (_, index) => ({
    id: `method-${index}`, page: 1, heading: 'GS-9 engineering work scope',
    text: `Evaluate engineering method ${index} and explain the evidence-based recommendation.`,
  }))
  const target = await seedGrade(f, undefined, {
    extraReferenceParagraphs,
    configureVersion(version, reference) {
      const extra = reference.paragraphs.slice(3).map(paragraph => citation(reference, paragraph))
      version.rubric.criteria[0].sourceCitations = extra.slice(0, 30)
      version.rubric.criteria[0].gradeBasis = extra.slice(30)
      version.qualifications = Array.from({ length: 50 }, (_, index) => ({ ...clone(version.qualifications[0]), id: `qualification-${index}` }))
    },
  })
  const published = await realModelPublication(f, resume, target)
  assert.equal(published.input.requirementEvidence[0].citations.length, 60)
  assert.equal(published.result.criteria[0].requirementCitations.length, 60)
  assert.equal(published.result.qualifications.length, 50)
  assert.equal(published.result.overall.score, 80)
  assert.equal(published.calls.length, 2)
  assert.ok(published.calls.every(call => call.payload.input.qualifications.length === 50))
})

test('actual all-unassessed model output stays unscored and withheld rather than manufacturing a zero', async () => {
  const f = fixture()
  const published = await realModelPublication(f, await seedResume(f), await seedJob(f), { unassessed: true })
  assert.equal(published.result.overall.status, 'withheld')
  assert.equal(published.result.overall.score, null)
  assert.equal(published.result.overall.reason, 'no-assessable-weight')
  assert.equal(published.result.completion, 'limited')
  const current = await f.service.detail(f.workspaceId, published.run.record.id)
  assert.equal(current.run.progress.scored, 0)
  assert.equal(current.run.progress.unscored, 1)
})

test('actual partly unassessed model output withholds the total instead of normalizing the remaining weight', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const target = await seedJob(f)
  target.rubric.criteria = [40, 60].map((weight, index) => ({
    ...clone(target.rubric.criteria[0]), id: `engineering-${index}`, weight,
  }))
  target.selection.rubricHash = api.analysisHash(target.rubric)
  const published = await realModelPublication(f, resume, target, { scores: [5], unassessedIds: ['engineering-1'] })
  assert.equal(published.result.overall.status, 'withheld')
  assert.equal(published.result.overall.score, null)
  assert.equal(published.result.overall.reason, 'unassessed-weighted-criteria')
  assert.equal(published.result.coverage.totalWeight, 100)
  assert.equal(published.result.coverage.assessedWeight, 40)
})
