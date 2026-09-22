import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, seedResume, seedJob, seedGrade, publishResult, startHttp, citation, clone, ACTOR, guidance, finishInitialization,
} from './real-analyses.test-support.mjs'
import { reviewedCorrection as reviewed } from './analysis-corrections.test-support.mjs'
import { narrativeRuntime, narrativeWorker, runComparisons, settleNarratives } from './real-analysis-narratives.test-support.mjs'

const status = expected => error => error.status === expected
const reason = 'Score absent documentary support as zero; preserve original results and evidence.'
const input = preview => ({ policyVersion: preview.policyVersion, resultSha256: preview.resultSha256, criterionIds: preview.criterionIds, reason })

function professionalJobOptions(personal = false) {
  return {
    configureDocument(document) {
      document.paragraphs.push({
        id: 'confidentiality', page: 1, heading: 'Sensitive data handling',
        text: personal ? 'Assess the applicant age.' : 'Apply confidentiality procedures when handling sensitive professional data.',
      })
    },
    configureRubric(rubric, document) {
      rubric.criteria[0].weight = 90
      rubric.criteria.push({
        id: 'confidentiality', key: 'custom', label: personal ? 'Applicant age' : 'Professional confidentiality',
        description: document.paragraphs[1].text, weight: 10, guidance, requirementType: 'required',
        sourceCitations: [citation(document, document.paragraphs[1])],
      })
    },
  }
}

async function setup({ blocked, blockerCode, personal = false, globalBlock = false, allMissing = false, enabled = true, unaffected = false } = {}) {
  const f = fixture()
  f.analysis.evidenceCorrectionsEnabled = enabled
  const resume = await seedResume(f)
  const other = unaffected ? await seedResume(f, 'Unchanged synthetic source') : undefined
  const job = await seedJob(f, 'Documented professional duties', randomUUID(), professionalJobOptions(personal))
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Synthetic correction history', resumes: [resume.selection, ...(other ? [other.selection] : [])], targets: [job.selection],
  }, ACTOR)
  const comparisons = (await f.service.comparisons(f.workspaceId, created.run.id)).comparisons
  const comparisonId = comparisons[0].comparison.id, runId = created.run.id
  const original = await publishResult(f, runId, comparisonId, false, {
    configureAssessment(assessment, snapshots) {
      assessment.criteria = assessment.criteria.map(row => {
        if (!allMissing && row.criterionId !== 'confidentiality') return row
        return {
          ...row, evidenceStatus: 'not-assessed', score: null,
          rationale: 'The successfully reviewed source does not describe this required work.',
          citations: [citation(snapshots.resumeSnapshot.document)],
          limitation: { code: blocked ?? 'not-assessable', message: 'No supporting work is documented.', criterionId: row.criterionId,
            ...(blockerCode ? { blockerCode } : {}) },
        }
      })
      assessment.limitations = assessment.criteria.filter(row => row.evidenceStatus === 'not-assessed').map(row => row.limitation)
      if (globalBlock) assessment.limitations.push({ code: 'context-limit', message: 'The complete source could not fit in the assessment context.' })
    },
  })
  let unchanged
  if (other) unchanged = await publishResult(f, runId, comparisons[1].comparison.id)
  return { f, runId, comparisonId, original, unchanged }
}

async function requestCorrection(context, requestId = randomUUID(), policyVersion = api.ANALYSIS_CORRECTION_POLICY_VERSION) {
  const { f, runId, comparisonId } = context
  const preview = await f.service.correctionPreview(f.workspaceId, runId, comparisonId)
  const response = await f.service.requestCorrection(f.workspaceId, runId, comparisonId, { ...input(preview), policyVersion }, requestId, preview.etag, ACTOR)
  return { preview, response, requestId }
}

function settingsFor(f, change = () => {}, revision = 'correction-policy-v1') {
  const settings = api.createDefaultAdminSettings()
  change(settings)
  return api.captureProcessingSettings(settings, revision, f.now)
}

test('correction admissions enforce maintenance, inactive rollout, and unavailable settings without blocking frozen reads', async t => {
  for (const mode of ['maintenance', 'inactive', 'unavailable']) await t.test(mode, async t => {
    const { f, runId, comparisonId } = await setup()
    const snapshot = settingsFor(f, settings => { settings.maintenance.pauseNewWork = mode === 'maintenance' })
    let policyReads = 0
    const http = await startHttp(f, true, {
      async capture() {
        policyReads++
        if (mode === 'unavailable') throw api.unavailable('Settings store unavailable.')
        return snapshot
      },
    }, mode !== 'inactive')
    t.after(http.close)
    const path = `/${runId}/comparisons/${comparisonId}/corrections`
    const preview = await (await http.request(`${path}/preview`)).json()
    const records = clone([...f.analysis.store.values]), blobs = clone([...f.analysis.blobs.values])
    const response = await http.request(path, 'POST', input(preview), {
      headers: { 'If-Match': preview.etag, 'Idempotency-Key': randomUUID() },
    })
    assert.equal(response.status, 503)
    assert.deepEqual([...f.analysis.store.values], records)
    assert.deepEqual([...f.analysis.blobs.values], blobs)
    assert.equal((await http.request(`${path}/history`)).status, 200)
    assert.equal((await http.request(`/${runId}/comparisons/${comparisonId}`)).status, 200)
    assert.equal(policyReads, mode === 'inactive' ? 0 : 1)
  })
})

test('accepted corrections retain their own policy and replay or cancel after new processing and settings reads close', async t => {
  const { f, runId, comparisonId } = await setup()
  const snapshot = settingsFor(f, settings => {
    settings.features.newAnalyses = false
    settings.ai.deployments[0].deploymentName = 'captured-correction-review'
  })
  let unavailable = false, policyReads = 0
  const http = await startHttp(f, true, {
    async capture() {
      policyReads++
      if (unavailable) throw api.unavailable('Current settings unavailable.')
      return snapshot
    },
  })
  t.after(http.close)
  const path = `/${runId}/comparisons/${comparisonId}/corrections`
  const preview = await (await http.request(`${path}/preview`)).json()
  const headers = { 'If-Match': preview.etag, 'Idempotency-Key': randomUUID() }
  assert.equal((await http.request(path, 'POST', input(preview), { headers })).status, 202)
  const accepted = await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId)
  const run = await api.loadAnalysisRun(f.analysis.store, f.workspaceId, runId)
  const proposal = await api.readAnalysisCorrectionProposal(f.analysis.blobs, run.record, accepted.record)
  assert.deepEqual(accepted.record.processingSettings, snapshot)
  assert.deepEqual(proposal.processingSettings, snapshot)
  assert.notEqual(run.record.processingSettings.revision, snapshot.revision)
  unavailable = true
  http.config.settings.runtimeEnabled = false
  f.analysis.evidenceCorrectionsEnabled = false
  assert.equal((await http.request(path, 'POST', input(preview), { headers })).status, 202)
  assert.deepEqual(await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId), accepted)
  assert.equal((await http.request(`${path}/history`)).status, 200)
  assert.equal((await http.request(`${path}/cancel`, 'POST', {}, { headers: { 'If-Match': accepted.etag } })).status, 200)
  assert.equal(policyReads, 1)
})

test('a reserved correction proposal resumes with its captured settings after an unacknowledged scheduling failure', async t => {
  const { f, runId, comparisonId } = await setup()
  const snapshot = settingsFor(f)
  let policyReads = 0
  const http = await startHttp(f, true, {
    async capture() {
      policyReads++
      if (policyReads > 1) throw api.unavailable('Current policy must not replace an accepted proposal.')
      return snapshot
    },
  })
  t.after(http.close)
  const path = `/${runId}/comparisons/${comparisonId}/corrections`
  const preview = await (await http.request(`${path}/preview`)).json()
  const headers = { 'If-Match': preview.etag, 'Idempotency-Key': randomUUID() }
  const transact = f.analysis.store.transact.bind(f.analysis.store)
  f.analysis.store.transact = async (workspaceId, operations, options) => {
    if (operations.some(item => item.record.recordType === 'analysis-correction')) throw new Error('Synthetic scheduling outage.')
    return transact(workspaceId, operations, options)
  }
  assert.equal((await http.request(path, 'POST', input(preview), { headers })).status, 503)
  assert.equal(await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId), undefined)
  const name = api.analysisCorrectionProposalBlobName(f.workspaceId, runId, comparisonId, headers['Idempotency-Key'])
  const reserved = clone(f.analysis.blobs.values.get(name))
  assert.ok(reserved)
  f.analysis.store.transact = transact
  http.config.settings.runtimeEnabled = false
  assert.equal((await http.request(path, 'POST', input(preview), { headers })).status, 202)
  const accepted = await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId)
  assert.deepEqual(accepted.record.processingSettings, snapshot)
  assert.deepEqual(f.analysis.blobs.values.get(name), reserved)
  assert.equal(policyReads, 1)
})

test('read-only preview treats contextual non-support as a zero proposal without changing original evidence or weights', async () => {
  const { f, runId, comparisonId, original } = await setup()
  const records = clone([...f.analysis.store.values])
  const blobs = clone([...f.analysis.blobs.values])
  const preview = await f.service.correctionPreview(f.workspaceId, runId, comparisonId)
  assert.equal(preview.before.overall.status, 'withheld')
  assert.deepEqual(preview.after.overall, { status: 'available', score: 72 })
  assert.deepEqual(preview.criterionIds, ['confidentiality'])
  assert.equal(preview.criteria[0].eligible, true)
  assert.equal(original.result.criteria[1].citations.length, 1)
  assert.deepEqual([...f.analysis.store.values], records)
  assert.deepEqual([...f.analysis.blobs.values], blobs)
})

test('supported publication preserves original bytes and unrelated results, projects every reader, and queues only affected summaries', async () => {
  const context = await setup({ unaffected: true })
  const { f, runId, comparisonId, original, unchanged } = context
  const raw = clone(await f.analysis.store.get(f.workspaceId, comparisonId))
  const oldNarrativeId = api.analysisNarrativeId('candidate', runId, comparisonId)
  const oldNarrative = clone(await f.analysis.store.get(f.workspaceId, oldNarrativeId))
  const untouched = clone(await f.analysis.store.get(f.workspaceId, unchanged.completed.id))
  const originalBytes = clone(f.analysis.blobs.values.get(original.reference.blobName))
  const { requestId } = await requestCorrection(context)
  const accepted = await reviewed(context)
  await accepted.publish()
  await accepted.publish()
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, comparisonId), raw)
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, oldNarrativeId), oldNarrative)
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, untouched.record.id), untouched)
  assert.deepEqual(f.analysis.blobs.values.get(original.reference.blobName), originalBytes)
  const detail = await f.service.comparisonDetail(f.workspaceId, runId, comparisonId)
  assert.equal(detail.result.overall.score, 72)
  assert.equal(detail.comparison.resultRevision.id, requestId)
  assert.deepEqual(detail.result.criteria[0], original.result.criteria[0])
  assert.equal(detail.result.criteria[1].score, 0)
  assert.deepEqual(detail.result.criteria[1].citations, [])
  assert.deepEqual(detail.result.criteria[1].requirementCitations, original.result.criteria[1].requirementCitations)
  assert.equal(detail.result.provenance.groundingReviews[0].assessmentSha256, detail.result.provenance.assessmentSha256)
  assert.equal(detail.result.provenance.groundingReviews[0].scope.baseAssessmentSha256, original.result.provenance.assessmentSha256)
  assert.deepEqual(detail.result.provenance.groundingReviews[0].scope.criterionIds, ['confidentiality'])
  assert.notEqual(detail.result.provenance.assessmentSha256, original.result.provenance.assessmentSha256)
  const run = await f.service.detail(f.workspaceId, runId)
  assert.equal(run.run.progress.scored, 2)
  assert.equal(run.run.progress.unscored, 0)
  const list = await f.service.comparisons(f.workspaceId, runId)
  assert.equal(list.comparisons.find(item => item.comparison.id === comparisonId).comparison.result.sha256, accepted.reference.sha256)
  const report = await f.service.reportComparisons(f.workspaceId, runId, [comparisonId, unchanged.completed.id])
  assert.equal(report.comparisons.find(item => item.id === comparisonId).overall.score, 72)
  assert.equal(report.comparisons.find(item => item.id === comparisonId).resultSha256, accepted.reference.sha256)
  assert.ok(report.comparisons.find(item => item.id === comparisonId).provenance.some(item => item.label === 'Evidence correction revision' && item.value === requestId))
  const summaries = await f.service.summaries(f.workspaceId, runId)
  assert.equal(summaries.capture.comparisons.find(item => item.comparisonId === comparisonId).resultSha256, accepted.reference.sha256)
  const newNarrative = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', runId, comparisonId, requestId))
  assert.equal(newNarrative.record.resultSha256, accepted.reference.sha256)
  assert.equal(newNarrative.record.status, 'queued')
  assert.ok(!(await f.analysis.store.listPending(f.now, 100)).some(item => item.record.id === oldNarrativeId))
  const history = await f.service.correctionHistory(f.workspaceId, runId, comparisonId)
  assert.deepEqual(history.originalAssessment.criteria, original.result.criteria)
  assert.equal(history.original.overall.score, null)
  assert.equal(history.entries[0].outcome, 'ready')
  assert.equal(history.entries[0].after.overall.score, 72)
  assert.equal(history.entries[0].resultSha256, accepted.reference.sha256)
  assert.deepEqual(history.entries[0].review.scope, detail.result.provenance.groundingReviews[0].scope)
})

test('all missing evidence yields an available numeric zero with all original weight assessed', async () => {
  const context = await setup({ allMissing: true })
  const { f, runId, comparisonId } = context
  const { preview } = await requestCorrection(context)
  assert.deepEqual(preview.after.overall, { status: 'available', score: 0 })
  assert.equal(preview.after.coverage.assessedWeight, 100)
  const accepted = await reviewed(context)
  await accepted.publish()
  assert.equal((await f.service.comparisonDetail(f.workspaceId, runId, comparisonId)).result.overall.score, 0)
})

test('unversioned requests retain legacy fingerprints and cannot be replayed as scoped consent', async () => {
  const context = await setup()
  const { f, runId, comparisonId } = context
  const preview = await f.service.correctionPreview(f.workspaceId, runId, comparisonId)
  assert.equal(preview.policyVersion, api.ANALYSIS_CORRECTION_POLICY_VERSION)
  const body = { resultSha256: preview.resultSha256, criterionIds: preview.criterionIds, reason }
  const key = randomUUID()
  const accepted = await f.service.requestCorrection(f.workspaceId, runId, comparisonId, body, key, preview.etag, ACTOR)
  assert.equal(accepted.correction.policyVersion, api.ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION)
  const expected = api.analysisHash({
    workspaceId: f.workspaceId, runId, comparisonId, actor: ACTOR,
    policyVersion: 'missing-evidence-zero-v1', input: { ...body, criterionIds: [...body.criterionIds].sort() },
  })
  assert.equal(api.analysisCorrectionFingerprint(f.workspaceId, runId, comparisonId, body, ACTOR), expected)
  await assert.rejects(f.service.requestCorrection(f.workspaceId, runId, comparisonId,
    { ...body, policyVersion: api.ANALYSIS_CORRECTION_POLICY_VERSION }, key, preview.etag, ACTOR), status(409))
  const publication = await reviewed(context)
  await publication.publish()
  assert.equal(publication.result.provenance.groundingReviews[0].scope, undefined)
  const replay = await f.service.requestCorrection(f.workspaceId, runId, comparisonId, body, key, preview.etag, ACTOR)
  assert.equal(replay.correction.revision.policyVersion, api.ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION)
})

test('scoped publication binds its exact selection and base without substituting for full assessment review', async () => {
  const context = await setup()
  await requestCorrection(context)
  const publication = await reviewed(context)
  const valid = publication.result
  for (const mutate of [
    result => { delete result.provenance.groundingReviews[0].scope },
    result => { result.provenance.correction.policyVersion = api.ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION },
    result => { result.provenance.groundingReviews[0].scope.baseAssessmentSha256 = 'f'.repeat(64) },
    result => { result.provenance.groundingReviews[0].scope.criterionIds = ['another-criterion'] },
    result => { result.provenance.groundingReviews[0].scope.decisions = [] },
    result => { result.provenance.groundingReviews[0].scope.decisions.push(result.provenance.groundingReviews[0].scope.decisions[0]) },
    result => { result.provenance.groundingReviews[0].scope.decisions[0].outcome = 'evidence-found' },
  ]) {
    const tampered = clone(valid)
    mutate(tampered)
    assert.throws(() => api.parseAnalysisResult(tampered))
  }
  const ordinary = clone(context.original.result)
  ordinary.provenance.groundingReviews[0].scope = clone(valid.provenance.groundingReviews[0].scope)
  assert.throws(() => api.parseAnalysisResult(ordinary), /ordinary assessments require full review/)
  await publication.publish()
  const detail = await context.f.service.comparisonDetail(context.f.workspaceId, context.runId, context.comparisonId)
  assert.deepEqual(detail.result.provenance.groundingReviews[0].scope, valid.provenance.groundingReviews[0].scope)
})

test('a scoped correction can inherit a legacy corrected base without altering its approved numeric rows', async () => {
  const context = await setup({ allMissing: true })
  const { f, runId, comparisonId } = context
  const first = await f.service.correctionPreview(f.workspaceId, runId, comparisonId)
  await f.service.requestCorrection(f.workspaceId, runId, comparisonId, {
    ...input(first), policyVersion: api.ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION,
    criterionIds: [first.criterionIds[0]],
  }, randomUUID(), first.etag, ACTOR)
  const legacy = await reviewed(context)
  await legacy.publish()
  await requestCorrection(context)
  const scoped = await reviewed(context)
  assert.equal(scoped.result.provenance.groundingReviews[0].scope.baseAssessmentSha256, legacy.result.provenance.assessmentSha256)
  assert.deepEqual(scoped.result.criteria[0], legacy.result.criteria[0])
  await scoped.publish()
  assert.equal(scoped.result.overall.score, 0)
  const history = await f.service.correctionHistory(f.workspaceId, runId, comparisonId)
  assert.equal(history.entries[0].review.scope.kind, 'evidence-gaps')
  assert.equal(history.entries[1].review.scope, undefined)
})

test('a 412-comparison recovery publishes 21 scoped corrections and preserves three legacy corrections and 388 unaffected results', async () => {
  const f = fixture()
  f.analysis.evidenceCorrectionsEnabled = true
  const resumes = [], jobs = []
  for (let index = 0; index < 103; index++) resumes.push(await seedResume(f, `Synthetic source ${index}`))
  for (let index = 0; index < 4; index++) jobs.push(await seedJob(f, `Synthetic duties ${index}`, randomUUID(), professionalJobOptions()))
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Synthetic 412-result recovery', resumes: resumes.map(item => item.selection), targets: jobs.map(item => item.selection),
  }, ACTOR)
  const runId = created.run.id
  for (let chunk = 0; chunk < 5 && runComparisons(f, runId).length < 412; chunk++) await finishInitialization(f, runId)
  const comparisons = runComparisons(f, runId)
  assert.equal(comparisons.length, 412)
  const targets = [...new Set(comparisons.map(item => item.record.target.summary.id))]
  const gaps = new Set([19, 4, 1].flatMap((count, index) =>
    comparisons.filter(item => item.record.target.summary.id === targets[index]).slice(0, count).map(item => item.record.id)))
  const originals = new Map()
  for (const { record } of comparisons) {
    originals.set(record.id, await publishResult(f, runId, record.id, false, {
      configureAssessment(assessment, snapshots) {
        if (!gaps.has(record.id)) return
        const row = assessment.criteria[1]
        assessment.criteria[1] = {
          ...row, evidenceStatus: 'not-assessed', score: null, citations: [citation(snapshots.resumeSnapshot.document)],
          rationale: 'No supporting professional confidentiality practice was found in this successfully reviewed source.',
          limitation: { code: 'sparse-source', criterionId: row.criterionId, message: 'The readable source does not describe this professional practice.' },
        }
        assessment.limitations = [assessment.criteria[1].limitation]
      },
    }))
  }
  const before = await settleNarratives(f, runId)
  assert.equal(before.counts.candidates.ready, 412)
  assert.equal(before.counts.targets.ready, 4)
  const originalRecords = new Map(runComparisons(f, runId).map(value => [value.record.id, value]))
  const originalNarratives = new Map()
  const originalTargets = new Map()
  for (const { record } of comparisons) originalNarratives.set(record.id,
    clone(await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', runId, record.id))))
  for (const targetId of targets) originalTargets.set(targetId,
    clone(await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('target', runId, targetId))))
  assert.equal((await f.service.detail(f.workspaceId, runId)).run.progress.unscored, 24)
  const legacy = new Map()
  for (const comparisonId of [...gaps].slice(0, 3)) {
    const context = { f, runId, comparisonId }
    await requestCorrection(context, randomUUID(), api.ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION)
    const accepted = await reviewed(context)
    await accepted.publish()
    assert.equal(accepted.result.provenance.groundingReviews[0].scope, undefined)
    legacy.set(comparisonId, clone((await f.service.comparisonDetail(f.workspaceId, runId, comparisonId)).comparison))
  }
  assert.equal((await f.service.detail(f.workspaceId, runId)).run.progress.unscored, 21)
  const remaining = [...gaps].filter(id => !legacy.has(id))
  for (const comparisonId of remaining) await requestCorrection({ f, runId, comparisonId })
  let published = 0
  for (const comparisonId of remaining) {
    const context = { f, runId, comparisonId }
    const accepted = await reviewed(context)
    assert.equal(accepted.result.overall.score, 72)
    assert.deepEqual(accepted.result.criteria[0], originals.get(comparisonId).result.criteria[0])
    await accepted.publish()
    if (++published === 1) {
      const worker = narrativeWorker(f)
      await (await narrativeRuntime()).runAnalysisWorker({ ...worker.deps, correctionsEnabled: false }, { maxItems: 100 })
      const waiting = await f.analysis.store.get(f.workspaceId, originalTargets.get(targets[0]).record.id)
      assert.equal(waiting.record.status, 'waiting')
      assert.equal(waiting.record.attempts, 0, 'An overview cannot start while the accepted correction cohort still has pending reviews.')
    }
  }
  assert.equal(published, 21)
  const refreshed = await settleNarratives(f, runId)
  assert.equal(refreshed.counts.candidates.ready, 412)
  assert.equal(refreshed.counts.targets.ready, 4)
  const run = (await f.service.detail(f.workspaceId, runId)).run
  assert.equal(run.progress.complete, 412)
  assert.equal(run.progress.scored, 412)
  assert.equal(run.progress.unscored, 0)
  const current = []
  let token
  do {
    const page = await f.service.comparisons(f.workspaceId, runId, token, 100)
    current.push(...page.comparisons)
    token = page.continuationToken
  } while (token)
  assert.equal(current.length, 412)
  assert.equal(current.filter(item => item.comparison.resultRevision).length, 24)
  for (const { comparison } of current) {
    const original = originals.get(comparison.id)
    assert.deepEqual(await f.analysis.store.get(f.workspaceId, comparison.id), originalRecords.get(comparison.id))
    assert.equal(api.analysisBytesHash(f.analysis.blobs.values.get(original.reference.blobName).bytes), original.reference.sha256)
    const oldNarrative = await f.analysis.store.get(f.workspaceId, api.analysisNarrativeId('candidate', runId, comparison.id))
    assert.deepEqual(oldNarrative, originalNarratives.get(comparison.id))
    assert.equal(api.analysisBytesHash(f.analysis.blobs.values.get(oldNarrative.record.published.blob.blobName).bytes),
      oldNarrative.record.published.blob.sha256)
    const captured = refreshed.capture.comparisons.find(item => item.comparisonId === comparison.id)
    assert.equal(captured.resultSha256, comparison.result.sha256)
    if (gaps.has(comparison.id)) assert.equal(comparison.resultSummary.overall.score, 72)
    else {
      assert.equal(comparison.result.sha256, original.reference.sha256)
      assert.deepEqual(comparison.resultSummary, original.completed.resultSummary)
      assert.deepEqual(refreshed.comparisons.find(item => item.comparisonId === comparison.id),
        before.comparisons.find(item => item.comparisonId === comparison.id))
    }
    if (legacy.has(comparison.id)) assert.deepEqual(comparison, legacy.get(comparison.id))
  }
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, originalTargets.get(targets[3]).record.id), originalTargets.get(targets[3]))
})

test('successive explicit corrections retain read-only historical publications and draft pages without rebinding or double-counting', async t => {
  const context = await setup({ allMissing: true })
  const { f, runId, comparisonId, original } = context
  const subject = { kind: 'candidate', subjectId: comparisonId }
  await settleNarratives(f, runId)
  for (let generation = 0; generation < 4; generation++) {
    const history = await f.service.summaryHistory(f.workspaceId, runId, subject)
    await f.service.retrySummary(f.workspaceId, runId, subject, randomUUID(), history.etag, ACTOR)
    await settleNarratives(f, runId)
  }
  const originalNarrative = await f.service.summarySubject(f.workspaceId, runId, subject)
  const firstPreview = await f.service.correctionPreview(f.workspaceId, runId, comparisonId)
  const firstRequest = await f.service.requestCorrection(f.workspaceId, runId, comparisonId,
    { ...input(firstPreview), criterionIds: ['confidentiality'] }, randomUUID(), firstPreview.etag, ACTOR)
  const first = await reviewed(context)
  await first.publish()
  await settleNarratives(f, runId)
  assert.equal((await f.service.detail(f.workspaceId, runId)).run.progress.unscored, 1)
  const firstNarrativeId = api.analysisNarrativeId('candidate', runId, comparisonId, firstRequest.requestId)
  const firstNarrative = clone(await f.analysis.store.get(f.workspaceId, firstNarrativeId))
  const firstPublication = await f.service.summarySubject(f.workspaceId, runId, subject)
  const secondRequest = await requestCorrection(context)
  assert.deepEqual(secondRequest.preview.criterionIds, ['engineering'])
  const second = await reviewed(context)
  assert.equal(second.proposal.baseResult.sha256, first.reference.sha256)
  assert.equal(second.proposal.originalResultSha256, original.reference.sha256)
  await second.publish()
  await settleNarratives(f, runId)
  const run = await f.service.detail(f.workspaceId, runId)
  assert.equal(run.run.progress.scored, 1)
  assert.equal(run.run.progress.unscored, 0)
  const current = await f.service.comparisonDetail(f.workspaceId, runId, comparisonId)
  assert.equal(current.result.overall.score, 0)
  assert.deepEqual(current.result.criteria[1], first.result.criteria[1])
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, firstNarrativeId), firstNarrative)
  const summaries = await f.service.summaries(f.workspaceId, runId)
  assert.equal(summaries.comparisons.length, 1)
  assert.equal(summaries.capture.comparisons[0].resultSha256, second.reference.sha256)
  const history = await f.service.correctionHistory(f.workspaceId, runId, comparisonId)
  assert.deepEqual(history.entries.map(entry => entry.requestId), [secondRequest.requestId, firstRequest.requestId])
  assert.deepEqual(history.originalAssessment.criteria, original.result.criteria)
  const records = clone([...f.analysis.store.values])
  const old = await f.service.summarySubject(f.workspaceId, runId, subject, undefined, 'original')
  assert.deepEqual(old.narrative, originalNarrative.narrative)
  assert.equal(old.resultRevisionId, 'original')
  const earlier = await f.service.summarySubject(f.workspaceId, runId, subject, undefined, firstRequest.requestId)
  assert.deepEqual(earlier.narrative, firstPublication.narrative)
  assert.equal(earlier.narrative.resultSha256, first.reference.sha256)
  const latest = await f.service.summarySubject(f.workspaceId, runId, subject)
  assert.equal(latest.narrative.resultSha256, second.reference.sha256)
  const historicalPage = await f.service.summaryHistory(f.workspaceId, runId, subject, undefined, undefined, 'original')
  assert.equal(historicalPage.resultRevisionId, 'original')
  assert.deepEqual(historicalPage.capabilities, { canPublish: false, canRetry: false, canResume: false, canRestart: false })
  assert.equal(historicalPage.entries.length, 12)
  assert.ok(historicalPage.continuationToken)
  const nextPage = await f.service.summaryHistory(f.workspaceId, runId, subject, historicalPage.continuationToken, undefined, 'original')
  assert.ok(nextPage.entries.length > 0)
  assert.ok(nextPage.entries.every(entry => !historicalPage.entries.some(previous => previous.id === entry.id)))
  await assert.rejects(f.service.summaryHistory(f.workspaceId, runId, subject, historicalPage.continuationToken), status(400))
  await assert.rejects(f.service.summarySubject(f.workspaceId, runId, subject, undefined, randomUUID()), status(404))
  assert.deepEqual([...f.analysis.store.values], records)
  const http = await startHttp(f)
  t.after(http.close)
  const path = `/${runId}/summaries/candidate/${comparisonId}`
  const draft = historicalPage.entries.find(entry => entry.draft)
  const body = { generationId: draft.generationId, round: draft.round, outputSha256: draft.outputSha256 }
  const headers = { 'If-Match': historicalPage.etag, 'Idempotency-Key': randomUUID() }
  assert.equal((await http.request(`${path}/publish?resultRevisionId=original`, 'POST', body, { headers })).status, 400)
  assert.equal((await http.request(`${path}/publish`, 'POST', body, { headers })).status, 409)
})

test('an explicit retry records a terminal storage failure even when its worker could not persist an attempt checkpoint', async () => {
  const context = await setup()
  const { f, runId, comparisonId } = context
  const first = await requestCorrection(context)
  const head = await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId)
  const run = await api.loadAnalysisRun(f.analysis.store, f.workspaceId, runId)
  const failed = {
    ...head.record, status: 'failed', attempts: 3, attemptId: randomUUID(),
    error: { code: 'storage-error', stage: 'publication', retryable: true, message: 'The private history store was unavailable.' },
  }
  delete failed.nextAttemptAt
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: failed, etag: head.etag }, { kind: 'replace', record: run.record, etag: run.etag },
  ])
  const next = await requestCorrection(context)
  assert.notEqual(next.requestId, first.requestId)
  const history = await f.service.correctionHistory(f.workspaceId, runId, comparisonId)
  assert.equal(history.entries[0].requestId, first.requestId)
  assert.equal(history.entries[0].outcome, 'failed')
  assert.equal(history.entries[0].error.code, 'storage-error')
  assert.equal(history.entries[0].resultSha256, null)
  assert.equal(history.correction.status, 'queued')
})

test('switching off admission still allows authorized cancellation of already accepted correction work', async () => {
  const context = await setup()
  const { f, runId, comparisonId } = context
  const accepted = await requestCorrection(context)
  f.analysis.evidenceCorrectionsEnabled = false
  const cancelled = await f.service.cancelCorrection(f.workspaceId, runId, comparisonId, accepted.response.correction.etag)
  assert.equal(cancelled.correction.status, 'cancelled')
  const history = await f.service.correctionHistory(f.workspaceId, runId, comparisonId)
  assert.equal(history.entries[0].outcome, 'cancelled')
  assert.equal(history.original.overall.status, 'withheld')
})

test('a generic legacy source-quality label requires scoped verification rather than proving an unusable source', async () => {
  const context = await setup({ blocked: 'source-quality' })
  const { f, runId, comparisonId } = context
  const preview = await f.service.correctionPreview(f.workspaceId, runId, comparisonId)
  assert.equal(preview.criteria[0].eligible, true)
  assert.equal(preview.after.overall.score, 72)
  await assert.rejects(f.service.requestCorrection(f.workspaceId, runId, comparisonId,
    { ...input(preview), policyVersion: api.ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION }, randomUUID(), preview.etag, ACTOR), status(400))
  await requestCorrection(context)
  const verified = await reviewed(context)
  await verified.publish()
  assert.equal(verified.result.criteria[1].score, 0)
})

for (const options of [{ blocked: 'source-quality', blockerCode: 'unusable-source' }, { blocked: 'context-limit' }, { personal: true }, { globalBlock: true }]) {
  test(`genuine blocker is not silently made zero: ${JSON.stringify(options)}`, async () => {
    const { f, runId, comparisonId } = await setup(options)
    const preview = await f.service.correctionPreview(f.workspaceId, runId, comparisonId)
    assert.equal(preview.after, null)
    assert.deepEqual(preview.criterionIds, [])
    assert.ok(preview.criteria[0].blockedReason)
    await assert.rejects(f.service.requestCorrection(f.workspaceId, runId, comparisonId,
      { ...input(preview), criterionIds: ['confidentiality'] }, randomUUID(), preview.etag, ACTOR), status(400))
    assert.equal(await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId), undefined)
  })
}

test('request keys bind exact source, criteria, and actor, replay ambiguous acknowledgement, and never reactivate superseded requests', async () => {
  const context = await setup()
  const { f, runId, comparisonId } = context
  const { preview, requestId, response } = await requestCorrection(context)
  const replay = await f.service.requestCorrection(f.workspaceId, runId, comparisonId, input(preview), requestId, preview.etag, ACTOR)
  assert.equal(replay.correction.etag, response.correction.etag)
  for (const [body, actor] of [
    [{ ...input(preview), reason: 'Different reason' }, ACTOR], [input(preview), 'another-actor'],
    [{ ...input(preview), policyVersion: api.ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION }, ACTOR],
  ]) {
    await assert.rejects(f.service.requestCorrection(f.workspaceId, runId, comparisonId, body, requestId, preview.etag, actor), status(409))
  }
  const cancelled = await f.service.cancelCorrection(f.workspaceId, runId, comparisonId, response.correction.etag)
  assert.equal(cancelled.correction.status, 'cancelled')
  const second = await requestCorrection(context)
  await f.service.cancelCorrection(f.workspaceId, runId, comparisonId, second.response.correction.etag)
  const fresh = await f.service.correctionPreview(f.workspaceId, runId, comparisonId)
  await assert.rejects(f.service.requestCorrection(f.workspaceId, runId, comparisonId, input(preview), requestId, fresh.etag, ACTOR), status(409))
  const history = await f.service.correctionHistory(f.workspaceId, runId, comparisonId)
  assert.equal(history.entries.length, 2)
  assert.ok(history.entries.every(item => item.outcome === 'cancelled' && item.resultSha256 === null))
})

test('lost request acknowledgement is reconciled against the exact durable request instead of duplicating work', async () => {
  const context = await setup()
  const { f, runId, comparisonId } = context
  f.analysis.store._afterBatch(operations => {
    if (operations.some(item => item.record.recordType === 'analysis-correction')) throw new Error('Synthetic lost acknowledgement')
  })
  const accepted = await requestCorrection(context)
  assert.equal(accepted.response.correction.requestId, accepted.requestId)
  assert.equal((await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId)).record.attempts, 0)
})

test('tampered existing numeric rows and reused old assessment content cannot be published as corrections', async () => {
  const context = await setup()
  const { f, runId, comparisonId, original } = context
  await requestCorrection(context)
  const changed = await reviewed(context, assessment => { assessment.criteria[0].score = 5 })
  await assert.rejects(changed.publish(), /differs from the accepted deterministic proposal|does not bind the exact proposed assessment/)
  assert.deepEqual((await f.service.comparisonDetail(f.workspaceId, runId, comparisonId)).result, original.result)
  assert.equal((await f.service.detail(f.workspaceId, runId)).run.progress.unscored, 1)
})

test('cancellation fences a late reviewed attempt without rewriting its original result', async () => {
  const context = await setup()
  const { f, runId, comparisonId, original } = context
  await requestCorrection(context)
  const accepted = await reviewed(context)
  const current = await f.service.correctionState(f.workspaceId, runId, comparisonId)
  await f.service.cancelCorrection(f.workspaceId, runId, comparisonId, current.correction.etag)
  await assert.rejects(accepted.publish(), /active publication lease/)
  assert.equal((await f.service.comparisonDetail(f.workspaceId, runId, comparisonId)).comparison.result.sha256, original.reference.sha256)
})

test('archive and workspace controls fence proposal writes and late publication', async () => {
  const context = await setup()
  const { f, runId, comparisonId, original } = context
  await requestCorrection(context)
  const accepted = await reviewed(context)
  await api.updateAnalysisControl(f.analysis.store, f.workspaceId, undefined, control => ({ ...control, state: 'archived' }))
  await assert.rejects(accepted.publish())
  assert.equal((await f.analysis.store.get(f.workspaceId, comparisonId)).record.result.sha256, original.reference.sha256)
})

test('default-off capability blocks requests while retained original results and read-only previews stay readable', async () => {
  const { f, runId, comparisonId } = await setup({ enabled: false })
  const preview = await f.service.correctionPreview(f.workspaceId, runId, comparisonId)
  await assert.rejects(f.service.requestCorrection(f.workspaceId, runId, comparisonId, input(preview), randomUUID(), preview.etag, ACTOR), status(503))
  assert.equal(await api.loadAnalysisCorrection(f.analysis.store, f.workspaceId, runId, comparisonId), undefined)
  assert.equal((await f.service.comparisonDetail(f.workspaceId, runId, comparisonId)).result.overall.status, 'withheld')
})

test('correction routes enforce owner/editor history, normal CSRF, exact ETags, strict bodies, and workspace mutation leases', async t => {
  const { f, runId, comparisonId } = await setup()
  const http = await startHttp(f)
  t.after(() => http.close())
  const path = `/${runId}/comparisons/${comparisonId}/corrections`
  for (const role of ['viewer', 'stranger']) {
    const response = await http.request(`${path}/preview`, 'GET', undefined, { role })
    assert.equal(response.status, role === 'viewer' ? 403 : 404)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const previewResponse = await http.request(`${path}/preview`)
  assert.equal(previewResponse.status, 200)
  const preview = await previewResponse.json()
  const headers = { 'If-Match': preview.etag, 'Idempotency-Key': randomUUID() }
  assert.equal((await http.request(path, 'POST', input(preview))).status, 400)
  assert.equal((await http.request(path, 'POST', { ...input(preview), score: 100 }, { headers })).status, 400)
  assert.equal((await http.request(path, 'POST', input(preview), { role: 'viewer', headers })).status, 403)
  assert.equal((await http.request(path, 'POST', input(preview), { headers: { ...headers, origin: 'https://foreign.example' } })).status, 403)
  assert.equal((await http.request(path, 'POST', input(preview), { headers: { ...headers, 'If-Match': '"stale"' } })).status, 409)
  const response = await http.request(path, 'POST', input(preview), { role: 'editor', headers })
  assert.equal(response.status, 202)
  assert.ok(f.mutationLeases.acquired > 0)
  assert.equal(f.mutationLeases.active, 0)
  const saved = await response.json()
  assert.equal(saved.correction.status, 'queued')
  assert.equal(saved.correction.requestId, headers['Idempotency-Key'])
  const historical = `/${runId}/summaries/candidate/${comparisonId}?resultRevisionId=original`
  const selected = await http.request(historical)
  assert.equal(selected.status, 200)
  assert.equal((await selected.json()).resultRevisionId, 'original')
  assert.equal((await http.request(historical, 'GET', undefined, { role: 'viewer' })).status, 403)
  assert.equal((await http.request(historical, 'GET', undefined, { role: 'stranger' })).status, 404)
  assert.equal((await http.request(`${historical}&resultRevisionId=original`)).status, 400)
  assert.equal((await http.request(historical.replace('original', 'invalid'))).status, 400)
})

test('GS exclusions and unscored qualification limitations survive a zero correction unchanged', async () => {
  const f = fixture()
  f.analysis.evidenceCorrectionsEnabled = true
  const resume = await seedResume(f)
  const grade = await seedGrade(f)
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Synthetic grade evidence correction', resumes: [resume.selection], targets: [grade.selection],
  }, ACTOR)
  const runId = created.run.id
  const comparisonId = (await f.service.comparisons(f.workspaceId, runId)).comparisons[0].comparison.id
  const original = await publishResult(f, runId, comparisonId, true, {
    configureAssessment(assessment, snapshots) {
      const qualification = snapshots.targetSnapshot.requirementEvidence.find(item => item.kind === 'qualification')
      const limitation = { code: 'not-assessable', message: 'Qualification alternatives require separate review.', qualificationId: qualification.qualificationId }
      assessment.qualifications = [{
        qualificationId: qualification.qualificationId, evidenceStatus: 'not-assessed', citations: [],
        requirementCitations: qualification.citations, rationale: limitation.message, limitation,
      }]
      assessment.limitations = [limitation]
    },
  })
  const context = { f, runId, comparisonId, original }
  const { preview } = await requestCorrection(context)
  assert.equal(preview.after.overall.score, 0)
  assert.equal(preview.after.completion, 'limited')
  const accepted = await reviewed(context)
  await accepted.publish()
  const result = (await f.service.comparisonDetail(f.workspaceId, runId, comparisonId)).result
  assert.deepEqual(result.criteria[1], original.result.criteria[1])
  assert.deepEqual(result.qualifications, original.result.qualifications)
  assert.deepEqual(result.limitations, original.result.limitations)
})
