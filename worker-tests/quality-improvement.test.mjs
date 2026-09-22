import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, qcFixture, submittedPlan, proposal, principal, clone,
  completeAssessmentTrial as completeTrial, queueAssessmentEvaluation as evaluationPlan,
} from '../server-tests/qc.test-support.mjs'

const model = {
  endpoint: 'https://score-unit.openai.azure.com', deployment: 'unit', modelName: 'unit',
  async getToken() { return 'unit-token' },
  async fetch() { throw new Error('No real model request belongs in this isolated runtime test') },
}
function dependencies(f, extra = {}) { return { ...f.qc, model, clock: f.clock, ...extra } }

test('opening QC and creating a plan never claims work; explicit drafting has a leased immutable proposal revision', async () => {
  const f = await qcFixture(), detail = await submittedPlan(f)
  let calls = 0
  const deps = dependencies(f, { async invoke() {
    calls++
    return { content: JSON.stringify(proposal(detail.plan)), model: 'unit-planner' }
  } })
  assert.deepEqual(await api.runQcWorker(deps), { claimed: 0, completed: 0, deferred: 0, stopped: 0 })
  assert.equal(calls, 0)
  const key = randomUUID()
  const requested = await f.plans.request(f.caller('reviewer'), detail.plan.id, 'plan', key, detail.etag)
  assert.equal(requested.plan.status, 'planning')
  assert.equal(requested.canEdit, false)
  assert.equal(requested.canCancel, true)
  assert.equal(calls, 0)
  assert.deepEqual(await api.runQcWorker(deps), { claimed: 1, completed: 1, deferred: 0, stopped: 0 })
  const drafted = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
  assert.equal(calls, 1)
  assert.equal(drafted.plan.status, 'draft')
  assert.equal(drafted.canEdit, true)
  assert.equal(drafted.canCancel, false)
  assert.equal(drafted.plan.revision, 2)
  assert.deepEqual(drafted.plan.proposal, proposal(drafted.plan))
  const checkpoint = await api.readQcJson(f.qc.blobs, drafted.work.checkpoint, f.workspaceId, drafted.plan.id)
  assert.equal(checkpoint.provenance.actualModel, 'unit-planner')
  assert.equal(checkpoint.provenance.promptSha256.length, 64)
  assert.equal(checkpoint.provenance.outputSchemaSha256.length, 64)
  assert.equal((await f.plans.history(f.caller('reviewer'), detail.plan.id, {})).items.length, 2)
  assert.equal((await f.plans.request(f.caller('reviewer'), detail.plan.id, 'plan', key, detail.etag)).plan.revision, 2)
  await api.runQcWorker(deps)
  assert.equal(calls, 1)
})

test('baseline/candidate trials use frozen identical settings and evidence, remain production-isolated, and bind activation exactly', async () => {
  const f = await qcFixture(2), detail = await evaluationPlan(f)
  const sourceRecords = clone([...f.analysis.store.values]), sourceBlobs = clone([...f.analysis.blobs.values])
  const registryBundles = clone([...f.registryStore.bundles]), registryRevisions = clone([...f.registryStore.revisions])
  const checkpoint = await api.readQcJson(f.qc.blobs, detail.work.checkpoint, f.workspaceId, detail.plan.id)
  assert.equal(f.registryStore.bundles.has(checkpoint.candidate.bundle.bundleId), false,
    'Evaluation admission must keep unpublished candidates in private QC storage')
  const baseline = (await f.prompts.current()).bundle.bundleId
  assert.equal(baseline, detail.plan.baseline.revision)
  const captured = []
  const deps = dependencies(f, {
    async trial(entry, family, settings) {
      captured.push({ scope: entry.selection.scope, settings: clone(settings), family })
      return completeTrial(entry, family, settings)
    },
  })
  assert.equal((await api.runQcWorker(deps)).completed, 1)
  const evaluated = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
  assert.equal(evaluated.plan.status, 'ready')
  assert.equal(evaluated.evaluation.cases.length, 2)
  assert.equal(evaluated.evaluation.eligible, true)
  assert.equal(captured.length, 4)
  assert.deepEqual(evaluated.trialScope.pairs, evaluated.evaluation.cases.map(({ scope, purpose, familyId }) => ({ scope, purpose, familyId })))
  assert.equal(evaluated.trialScope.baselineTrials + evaluated.trialScope.candidateTrials, captured.length)
  for (let index = 0; index < captured.length; index += 2) {
    assert.deepEqual(captured[index].scope, captured[index + 1].scope)
    assert.deepEqual(captured[index].settings.settings, captured[index + 1].settings.settings)
    assert.deepEqual(captured[index].settings.tasks, captured[index + 1].settings.tasks)
    assert.notEqual(captured[index].settings.promptBundle.bundle.bundleId, captured[index + 1].settings.promptBundle.bundle.bundleId)
    assert.deepEqual(captured[index].settings.promptBundle.revisions.assessmentGrounding, captured[index + 1].settings.promptBundle.revisions.assessmentGrounding)
  }
  assert.equal((await f.prompts.current()).bundle.bundleId, baseline, 'Evaluation cannot activate global prompts')
  assert.deepEqual([...f.registryStore.bundles], registryBundles)
  assert.deepEqual([...f.registryStore.revisions], registryRevisions)
  await assert.rejects(f.plans.activate(f.caller('reviewer'), principal('reviewer'), detail.plan.id,
    { reason: 'Reviewed candidate', confirm: true }, randomUUID(), evaluated.etag), error => error.status === 403)
  assert.equal(f.registryStore.bundles.has(checkpoint.candidate.bundle.bundleId), false)
  const activated = await f.plans.activate(f.caller('admin'), principal('admin'), detail.plan.id,
    { reason: 'Reviewed the complete bounded evaluation and limitations.', confirm: true }, randomUUID(), evaluated.etag)
  assert.equal(activated.plan.status, 'activated')
  assert.notEqual(activated.plan.activatedRevision, baseline)
  assert.equal((await f.prompts.current()).bundle.bundleId, activated.plan.activatedRevision)
  assert.deepEqual(await f.prompts.capture(activated.plan.activatedRevision), checkpoint.candidate,
    'Activation registers the exact privately evaluated snapshot without rebuilding its hashes')
  await assert.rejects(f.plans.edit(f.caller('reviewer'), detail.plan.id,
    { proposal: proposal(detail.plan) }, randomUUID(), activated.etag), error => error.status === 409)
  assert.deepEqual([...f.analysis.store.values], sourceRecords)
  assert.deepEqual([...f.analysis.blobs.values], sourceBlobs)
})

test('transient candidate failure checkpoints the completed baseline and resumes without another baseline call', async () => {
  const f = await qcFixture(), detail = await evaluationPlan(f)
  let baselineCalls = 0, candidateCalls = 0
  const deps = dependencies(f, {
    async trial(entry, family, settings) {
      if (settings.promptBundle.bundle.bundleId === detail.plan.baseline.revision) baselineCalls++
      else if (++candidateCalls === 1) throw Object.assign(new Error('Private provider failure body must never be saved'), { retryable: true })
      return completeTrial(entry, family, settings)
    },
  })
  const first = await api.runQcWorker(deps)
  assert.equal(first.deferred, 1)
  let waiting = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
  assert.equal(waiting.work.status, 'queued')
  assert.equal(waiting.work.attempts, 1)
  assert.ok(waiting.work.checkpoint)
  assert.ok(!JSON.stringify(waiting).includes('Private provider failure'))
  f.now = new Date(Date.parse(waiting.work.nextAttemptAt) + 1).toISOString()
  assert.equal((await api.runQcWorker(deps)).completed, 1)
  waiting = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
  assert.equal(waiting.plan.status, 'ready')
  assert.equal(baselineCalls, 1)
  assert.equal(candidateCalls, 2)
})

test('cancelled work and archived runs cannot publish a late model response', async () => {
  for (const kind of ['cancel', 'archive']) {
    const f = await qcFixture(), detail = await evaluationPlan(f)
    let calls = 0
    const deps = dependencies(f, {
      async trial(entry, family, settings) {
        if (++calls === 2) {
          if (kind === 'cancel') {
            const current = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
            await f.plans.cancel(f.caller('reviewer'), detail.plan.id, randomUUID(), current.etag)
          } else {
            await api.setQcRunState(f.qc, f.workspaceId, entry.selection.scope.runId, 'archived', f.now)
            await api.cancelQcRun(f.qc, f.workspaceId, entry.selection.scope.runId, f.now)
          }
        }
        return completeTrial(entry, family, settings)
      },
    })
    assert.equal((await api.runQcWorker(deps)).stopped, 1)
    const current = await f.qc.store.get(f.workspaceId, detail.plan.id)
    assert.equal(current.record.status, 'cancelled')
    assert.equal(current.record.evaluation, null)
    assert.equal((await f.prompts.current()).bundle.bundleId, detail.plan.baseline.revision)
  }
})

test('enqueue-time lifecycle generations fence stale model results even when the live state is active again', async () => {
  const f = await qcFixture(), detail = await evaluationPlan(f)
  let calls = 0
  const result = await api.runQcWorker(dependencies(f, {
    async trial(entry, family, settings) {
      calls++
      const control = await f.qc.store.get(f.workspaceId, api.qcControlId(entry.selection.scope.runId))
      f.qc.store.save({ ...control.record, state: 'active', generation: control.record.generation + 2 })
      return completeTrial(entry, family, settings)
    },
  }))
  assert.equal(result.stopped, 1)
  assert.equal(calls, 1)
  const current = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
  assert.equal(current.evaluation, null)
  assert.equal(current.canActivate, false)
  const cancelled = await f.plans.cancel(f.caller('reviewer'), detail.plan.id, randomUUID(), current.etag)
  const retried = await f.plans.retry(f.caller('reviewer'), detail.plan.id, randomUUID(), cancelled.etag)
  assert.notEqual(retried.work.id, detail.work.id)
  assert.equal((await api.runQcWorker(dependencies(f, { trial: completeTrial }))).completed, 1)
})

test('failed validation, missing trials and observed model drift block readiness and activation', async () => {
  for (const kind of ['validation', 'model-drift', 'missing-grounding-provenance']) {
    const f = await qcFixture(), detail = await evaluationPlan(f)
    const deps = dependencies(f, {
      async trial(entry, family, settings) {
        const output = completeTrial(entry, family, settings)
        if (kind === 'missing-grounding-provenance') delete output.models.assessmentReview
        if (settings.promptBundle.bundle.bundleId !== detail.plan.baseline.revision) {
          if (kind === 'validation') return { trial: {
            status: 'failed', error: 'Grounding failed.', findings: ['No substituted result.'],
            reviewedCriteria: 0, exactAgreements: 0, absoluteDifference: 0,
          }, models: {} }
          if (kind === 'model-drift') output.models.assessment = 'changed-underlying-model'
        }
        return output
      },
    })
    await api.runQcWorker(deps)
    const result = await f.plans.detail(f.caller('admin'), detail.plan.id)
    assert.equal(result.plan.status, 'failed')
    assert.equal(result.evaluation.eligible, false)
    assert.equal(result.canActivate, false)
    await assert.rejects(f.plans.activate(f.caller('admin'), principal('admin'), detail.plan.id,
      { reason: 'Cannot approve failed trials', confirm: true }, randomUUID(), result.etag), error => error.status === 409)
    const retried = await f.plans.retry(f.caller('reviewer'), detail.plan.id, randomUUID(), result.etag)
    const checkpoint = await api.readQcJson(f.qc.blobs, retried.work.checkpoint, f.workspaceId, detail.plan.id)
    assert.equal(checkpoint.cases.length, 0, 'An explicit retry must not reuse a failed or model-incompatible pair')
    let retryCalls = 0
    assert.equal((await api.runQcWorker(dependencies(f, {
      async trial(...args) { retryCalls++; return completeTrial(...args) },
    }))).completed, 1)
    assert.equal(retryCalls, 2)
    assert.equal((await f.plans.detail(f.caller('admin'), detail.plan.id)).plan.status, 'ready')
  }
})

test('changed proposal and changed live settings invalidate activation of an otherwise eligible evaluation', async () => {
  const f = await qcFixture(), detail = await evaluationPlan(f)
  await api.runQcWorker(dependencies(f, { trial: completeTrial }))
  let evaluated = await f.plans.detail(f.caller('admin'), detail.plan.id)
  const settings = clone(f.settings.settings)
  settings.ai.tasks.assessment.completionTokenLimit -= 1
  f.settings = api.captureProcessingSettings(settings, 'changed-model-settings', f.now)
  await assert.rejects(f.plans.activate(f.caller('admin'), principal('admin'), detail.plan.id,
    { reason: 'Settings drift must not activate', confirm: true }, randomUUID(), evaluated.etag), error => error.status === 409)
  const edited = proposal(detail.plan)
  edited.expectedEffects = 'A different explicit hypothesis needs a new evaluation.'
  evaluated = await f.plans.edit(f.caller('reviewer'), detail.plan.id, { proposal: edited }, randomUUID(), evaluated.etag)
  assert.equal(evaluated.plan.status, 'draft')
  assert.equal(evaluated.evaluation, null)
  await assert.rejects(f.plans.activate(f.caller('admin'), principal('admin'), detail.plan.id,
    { reason: 'Changed proposal cannot activate', confirm: true }, randomUUID(), evaluated.etag), error => error.status === 409)
})

test('planner receives authorized drafting feedback only, never holdout feedback or reference decisions', async () => {
  const f = await qcFixture(2), detail = await submittedPlan(f, { holdout: true })
  const pack = await api.readQcCasePack(f.qc.blobs, detail.plan)
  const secret = 'WITHHELD_HUMAN_REFERENCE_84f616'
  pack.cases[1].reviews[0].feedback[0].reason = secret
  pack.cases[1].selection.referenceDecisions[0].reason = secret
  pack.cases[1].selection.note = secret
  const data = api.qcDraftingInput(detail.plan, pack)
  assert.equal(data.withheldCaseCount, 1)
  assert.ok(!JSON.stringify(data).includes(secret))
  assert.ok(!JSON.stringify(data).includes(pack.cases[1].reviews[0].id))
  assert.ok(JSON.stringify(data).includes(pack.cases[0].reviews[0].id))
  let observed
  const drafted = await api.draftQcPlan(detail.plan, pack, {
    model, clock: f.clock,
    async invoke(_options, request) { observed = request; return { content: JSON.stringify(proposal(detail.plan)), model: 'qc-planner-model' } },
  }, new AbortController().signal)
  assert.ok(drafted.changes.length)
  assert.ok(!observed.user.includes(secret))
  assert.match(observed.system, /untrusted DATA/)
})

test('trial model input excludes reviewer opinions and curator reference decisions even for holdouts', async () => {
  const f = await qcFixture(2), detail = await submittedPlan(f, { holdout: true })
  const pack = await api.readQcCasePack(f.qc.blobs, detail.plan), entry = pack.cases[1]
  const secret = 'WITHHELD_REVIEW_DECISION_c811f30'
  entry.reviews[0].feedback[0].reason = secret
  entry.selection.referenceDecisions[0].reason = secret
  let calls = 0
  const output = await api.runQcTrial(entry, 'assessment', detail.plan.processingSettings, {
    clock: f.clock,
    model: { ...model, async fetch(_url, options) {
      calls++
      const body = JSON.parse(options.body)
      assert.ok(!JSON.stringify(body).includes(secret))
      assert.ok(!JSON.stringify(body).includes(entry.reviews[0].id))
      return new Response(JSON.stringify({ model: detail.plan.processingSettings.tasks.assessment.modelName,
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    } },
  }, new AbortController().signal)
  assert.ok(calls > 0)
  assert.equal(output.trial.status, 'failed')
  assert.equal(output.trial.reviewedCriteria, 0)
})

test('QC worker config rejects every live production store and requires dedicated private stores and read-only settings', () => {
  const environment = {
    WORKER_AUTH_MODE: 'azure-cli', AZURE_TENANT_ID: '00000000-0000-4000-8000-000000000001',
    COSMOS_ENDPOINT: 'https://score-unit.documents.azure.com', STORAGE_ACCOUNT_URL: 'https://scoreunit.blob.core.windows.net',
    SCORE_SETTINGS_CONTAINER: 'application-settings',
    RUBRIC_MODEL_ENDPOINT: 'https://score-unit.openai.azure.com', RUBRIC_MODEL_DEPLOYMENT: 'gpt-5-mini', RUBRIC_MODEL_NAME: 'gpt-5-mini',
  }
  assert.equal(api.loadQcWorkerConfig(environment).stores.container, 'qc-records')
  for (const field of ['ANALYSIS_RECORDS_CONTAINER', 'JOB_RECORDS_CONTAINER', 'GRADE_RECORDS_CONTAINER', 'RESUME_RECORDS_CONTAINER',
    'WORKSPACE_BLOB_CONTAINER', 'DOCUMENT_INTELLIGENCE_ENDPOINT', 'JOB_RENDERER_URL']) {
    assert.throws(() => api.loadQcWorkerConfig({ ...environment, [field]: 'forbidden-live-access' }))
  }
  assert.throws(() => api.loadQcWorkerConfig({ ...environment, QC_RECORDS_CONTAINER: 'analysis-records' }))
  assert.throws(() => api.loadQcWorkerConfig({ ...environment, NODE_ENV: 'production' }))
  const hosted = {
    ...environment, WORKER_AUTH_MODE: undefined, NODE_ENV: 'production',
    AZURE_CLIENT_ID: '00000000-0000-4000-8000-000000000002', QC_WORKER_MAX_ITEMS: '2',
    QC_RECORDS_CONTAINER: 'qc-records', QC_SOURCE_CONTAINER: 'qc-sources',
  }
  const config = api.loadQcWorkerConfig(hosted)
  assert.equal(config.localDevelopment, false)
  assert.equal(config.stores.workerEnabled, true)
  assert.equal(config.maxItems, 2)
  assert.equal(config.budgetMilliseconds, 660_000)
  assert.deepEqual(api.loadQcWorkerConfig({
    ...hosted, QC_ENABLED: 'false', QC_WORKER_ENABLED: 'false',
  }), config, 'API admission flags cannot interrupt an isolated worker processing already accepted work')
})

test('concurrent claims have one winner and expired leases fence the superseded worker', async () => {
  const f = await qcFixture(), detail = await evaluationPlan(f)
  const candidate = await f.qc.store.get(f.workspaceId, detail.work.id), deps = dependencies(f, { trial: completeTrial })
  const claims = await Promise.all([api.claimQcWork(deps, candidate, 'first'), api.claimQcWork(deps, candidate, 'second')])
  assert.equal(claims.filter(Boolean).length, 1)
  const old = claims.find(Boolean)
  f.now = new Date(Date.parse(old.record.lease.expiresAt) + 1).toISOString()
  const reclaimed = await api.claimQcWork(deps, candidate, 'replacement')
  assert.ok(reclaimed)
  assert.notEqual(reclaimed.record.lease.id, old.record.lease.id)
  const deadline = Date.parse(f.now) + 660_000
  assert.equal(await api.processQcWork(deps, old, deadline), 'stopped')
  assert.equal(await api.processQcWork(deps, reclaimed, deadline), 'complete')
  assert.equal((await f.plans.detail(f.caller('reviewer'), detail.plan.id)).plan.status, 'ready')
})

test('bounded transient storage/provider retries stop at the captured policy and require explicit retry after exhaustion', async () => {
  const f = await qcFixture(), detail = await evaluationPlan(f)
  let calls = 0
  const deps = dependencies(f, { async trial() { calls++; throw Object.assign(new Error('Private transient provider body'), { statusCode: 503 }) } })
  for (let attempt = 1; attempt <= 3; attempt++) {
    await api.runQcWorker(deps)
    const current = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
    assert.equal(current.work.attempts, attempt)
    if (attempt < 3) {
      assert.equal(current.work.status, 'queued')
      f.now = new Date(Date.parse(current.work.nextAttemptAt) + 1).toISOString()
    } else {
      assert.equal(current.work.status, 'failed')
      assert.equal(current.plan.status, 'failed')
      const retried = await f.plans.retry(f.caller('reviewer'), detail.plan.id, randomUUID(), current.etag)
      assert.notEqual(retried.work.id, detail.work.id)
      assert.equal(retried.work.attempts, 0)
    }
  }
  assert.equal(calls, 3)
  assert.equal(api.retryableQcFailure({ retryable: false, statusCode: 503 }), false)
  assert.equal(api.retryableQcFailure({ code: 'ECONNRESET' }), true)
  assert.equal((await api.runQcWorker(dependencies(f, { trial: completeTrial }))).completed, 1)
})

test('execution deadline aborts publication and holds the accepted exact candidate for a bounded retry', async () => {
  const f = await qcFixture(), detail = await evaluationPlan(f)
  const checkpoint = await api.readQcJson(f.qc.blobs, detail.work.checkpoint, f.workspaceId, detail.plan.id)
  const result = await api.runQcWorker(dependencies(f, { async trial(entry, family, settings) {
    f.now = new Date(Date.parse(f.now) + 1001).toISOString()
    return completeTrial(entry, family, settings)
  } }), { budgetMilliseconds: 1000 })
  assert.equal(result.deferred, 1)
  const current = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
  assert.equal(current.evaluation, null)
  assert.equal(current.work.status, 'queued')
  const after = await api.readQcJson(f.qc.blobs, current.work.checkpoint, f.workspaceId, detail.plan.id)
  assert.deepEqual(after.candidate, checkpoint.candidate)
})

test('deadlines and lease expiry are rechecked after publication fences, with completed paired trials resumable', async () => {
  for (const kind of ['deadline', 'lease']) {
    const f = await qcFixture(), detail = await evaluationPlan(f)
    let calls = 0
    const deps = dependencies(f, { async trial(...args) { calls++; return completeTrial(...args) } })
    const publication = async operations => {
      if (operations.some(entry => entry.record.recordType === 'qc-plan' && entry.record.status === 'ready')) {
        f.now = new Date(Date.parse(f.now) + (kind === 'deadline' ? 1001 : 90_001)).toISOString()
      } else f.qc.store.beforeCommit = publication
    }
    f.qc.store.beforeCommit = publication
    const outcome = await api.runQcWorker(deps, { budgetMilliseconds: kind === 'deadline' ? 1000 : 660_000 })
    assert.equal(outcome[kind === 'deadline' ? 'deferred' : 'stopped'], 1)
    const blocked = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
    assert.equal(blocked.evaluation, null)
    assert.equal(blocked.canActivate, false)
    if (kind === 'deadline') f.now = new Date(Date.parse(blocked.work.nextAttemptAt) + 1).toISOString()
    assert.equal((await api.runQcWorker(deps)).completed, 1)
    assert.equal(calls, 2, 'Completed baseline and candidate trials must not be purchased again')
    assert.equal((await f.plans.detail(f.caller('reviewer'), detail.plan.id)).plan.status, 'ready')
  }
})

test('immutable checkpoint candidate and fixed-contract mismatches are rejected before paid model calls', async () => {
  const f = await qcFixture(), detail = await evaluationPlan(f)
  const checkpoint = await api.readQcJson(f.qc.blobs, detail.work.checkpoint, f.workspaceId, detail.plan.id)
  checkpoint.candidate = await f.prompts.capture(detail.plan.baseline.revision)
  const reference = await api.putQcJson(f.qc.blobs, f.workspaceId, detail.plan.id, checkpoint, {
    runIds: detail.plan.cases.map(entry => entry.scope.runId), assertActive: async () => {},
  })
  const current = await f.qc.store.get(f.workspaceId, detail.work.id)
  await f.qc.store.transact(f.workspaceId, [{ kind: 'replace', record: { ...current.record, checkpoint: reference }, etag: current.etag }])
  let calls = 0
  await api.runQcWorker(dependencies(f, { async trial(...args) { calls++; return completeTrial(...args) } }))
  assert.equal(calls, 0)
  assert.equal((await f.plans.detail(f.caller('reviewer'), detail.plan.id)).plan.status, 'failed')
})

test('a lost private activation acknowledgement replays once and guarded restore cannot publish an unevaluated draft', async () => {
  const f = await qcFixture(), detail = await evaluationPlan(f)
  await api.runQcWorker(dependencies(f, { trial: completeTrial }))
  const ready = await f.plans.detail(f.caller('admin'), detail.plan.id), baseline = detail.plan.baseline.revision
  const key = randomUUID(), reason = { reason: 'Approve exact frozen trials with the recorded limitations.', confirm: true }
  f.qc.store.beforeCommit = async () => { throw new Error('Private acknowledgement unavailable') }
  await assert.rejects(f.plans.activate(f.caller('admin'), principal('admin'), detail.plan.id, reason, key, ready.etag))
  const activatedCount = f.registryStore.activations.length
  assert.equal(activatedCount, 2)
  const activated = await f.plans.activate(f.caller('admin'), principal('admin'), detail.plan.id, reason, key, ready.etag)
  assert.equal(activated.plan.status, 'activated')
  assert.equal(f.registryStore.activations.length, activatedCount)
  const current = await f.prompts.current()
  const unpublished = await f.prompts.createDraft(principal('reviewer'), {
    baseBundleId: current.bundle.bundleId, baseBundleSha256: current.bundle.bundleSha256, generalized: true,
    guidance: { assessment: 'Separate each documented scope from unsupported inference while preserving every fixed scoring constraint.' },
  })
  await assert.rejects(f.plans.restore(f.caller('admin'), principal('admin'),
    { revision: unpublished.bundle.bundleId, reason: 'A draft is not a rollback release.', confirm: true }, randomUUID(), current.etag),
  error => error.status === 404)
  await assert.rejects(f.plans.restore(f.caller('reviewer'), principal('reviewer'),
    { revision: baseline, reason: 'Reviewers cannot restore releases.', confirm: true }, randomUUID(), current.etag), error => error.status === 403)
  const restoreKey = randomUUID(), restoreInput = { revision: baseline, reason: 'Restore the prior compatible release after reviewing regressions.', confirm: true }
  f.qc.store.beforeCommit = async () => { throw new Error('Restore acknowledgement unavailable') }
  await assert.rejects(f.plans.restore(f.caller('admin'), principal('admin'), restoreInput, restoreKey, current.etag))
  assert.equal((await f.prompts.current()).bundle.bundleId, baseline)
  const restores = f.registryStore.activations.length
  assert.equal((await f.plans.restore(f.caller('admin'), principal('admin'), restoreInput, restoreKey, current.etag)).revision, baseline)
  assert.equal(f.registryStore.activations.length, restores)
  await assert.rejects(f.plans.restore(f.caller('admin'), principal('admin'),
    { ...restoreInput, reason: 'Changed request contents are not a replay.' }, restoreKey, current.etag), error => error.status === 409)
})

test('numeric metrics preserve explicit zero, omit unscored rows, and never reassign old model confidence to normalized ratings', () => {
  const entry = { selection: { referenceDecisions: [
    { criterionId: 'zero', score: 0 }, { criterionId: 'uncertain', score: null }, { criterionId: 'changed', score: 3 },
  ] } }
  const scores = [
    { criterionId: 'zero', score: 0, evidenceStatus: 'missing' },
    { criterionId: 'uncertain', score: 4, evidenceStatus: 'supported' },
    { criterionId: 'changed', score: 2, evidenceStatus: 'partial' },
  ]
  assert.deepEqual(api.qcAssessmentMetrics(entry, scores), { reviewedCriteria: 2, exactAgreements: 1, absoluteDifference: 1 })
  const findings = api.qcConfidenceFindings(entry, scores, { criteria: [
    { criterionId: 'zero', assessedScore: null, assessedEvidenceStatus: 'not-assessed', confidence: null },
    { criterionId: 'changed', assessedScore: 2, assessedEvidenceStatus: 'partial', confidence: 'low' },
  ] })
  assert.match(findings.find(value => value.includes('not-recorded:')), /1\/1 exact/)
  assert.match(findings.find(value => value.includes('low:')), /0\/1 exact/)
  assert.match(findings.find(value => value.includes('high:')), /0\/0 exact/)
})

test('real job-rubric trials validate generated citations and weights without inventing old-criterion numeric agreement', async () => {
  const f = await qcFixture()
  let detail = await submittedPlan(f)
  const changed = proposal(detail.plan)
  changed.changes[0] = {
    familyId: 'jobRubric', guidance: 'Use separate observable work expectations and preserve exact quoted source support for every proposed criterion.',
    reason: 'Test draft source grounding independently of saved assessment scores.',
  }
  detail = await f.plans.edit(f.caller('reviewer'), detail.plan.id, { proposal: changed }, randomUUID(), detail.etag)
  detail = await f.plans.request(f.caller('reviewer'), detail.plan.id, 'evaluation', randomUUID(), detail.etag)
  const pack = await api.readQcCasePack(f.qc.blobs, detail.plan), target = pack.cases[0].analysis.targetSnapshot
  const paragraph = target.document.paragraphs[0]
  const valid = {
    isJobPosting: true, rejectionReason: null, title: target.document.title, organization: null, location: null,
    arrangement: null, employmentType: null, grade: null, series: null, description: 'An independently grounded proposed work rubric.', warnings: [],
    criteria: [{
      label: 'Documented engineering analysis', description: paragraph.text, weight: 100, guidance: target.rubric.criteria[0].guidance,
      requirementType: 'required', sourceParagraphId: paragraph.id, quote: paragraph.text,
    }],
  }
  const requests = [], records = clone([...f.analysis.store.values]), sources = clone([...f.analysis.blobs.values])
  const modelFor = output => ({ ...model, async fetch(_url, options) {
    requests.push(JSON.parse(options.body))
    return Response.json({ model: detail.plan.processingSettings.tasks.jobRubric.modelName, choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })
  } })
  assert.equal((await api.runQcWorker(dependencies(f, { model: modelFor(valid) }))).completed, 1)
  const result = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
  assert.equal(result.plan.status, 'ready')
  assert.equal(requests.length, 2)
  for (const trial of [result.evaluation.cases[0].baseline, result.evaluation.cases[0].candidate]) {
    assert.equal(trial.status, 'complete')
    assert.equal(trial.reviewedCriteria, 0)
    assert.equal(trial.absoluteDifference, 0)
    assert.equal(trial.rubric.criteria.reduce((total, row) => total + row.weight, 0), 100)
    assert.equal(trial.rubric.criteria[0].sourceCitations[0].quote, paragraph.text)
    assert.deepEqual(trial.rubric.qualifications, [])
  }
  const invalid = clone(valid)
  invalid.criteria[0].weight = 99
  assert.equal((await api.runQcTrial(pack.cases[0], 'jobRubric', detail.plan.processingSettings,
    dependencies(f, { model: modelFor(invalid) }), new AbortController().signal)).trial.status, 'failed')
  invalid.criteria[0].weight = 100
  invalid.criteria[0].sourceParagraphId = 'foreign-source-paragraph'
  assert.equal((await api.runQcTrial(pack.cases[0], 'jobRubric', detail.plan.processingSettings,
    dependencies(f, { model: modelFor(invalid) }), new AbortController().signal)).trial.status, 'failed')
  assert.deepEqual([...f.analysis.store.values], records)
  assert.deepEqual([...f.analysis.blobs.values], sources)
})

test('real GS trials reuse full source, qualification, exclusion, and independent-grounding validators without production publication', async () => {
  const f = await qcFixture(1, {}, 'grade'), detail = await submittedPlan(f)
  const pack = await api.readQcCasePack(f.qc.blobs, detail.plan), entry = pack.cases[0], target = entry.analysis.targetSnapshot
  const criteria = target.version.rubric.criteria, secret = 'QC_HUMAN_OPINION_DO_NOT_SEND_TO_TRIAL_2a386'
  entry.reviews[0].feedback[0].reason = secret
  entry.selection.referenceDecisions[0].reason = secret
  const calls = [], sources = clone([...f.analysis.blobs.values]), records = clone([...f.analysis.store.values])
  let reviewOutcome = 'supported'
  const deps = dependencies(f, { async invoke(_model, request) {
    calls.push(request)
    assert.ok(!request.user.includes(secret))
    assert.ok(!request.user.includes(entry.reviews[0].id))
    const input = JSON.parse(request.user).input
    let output
    if (input.operation === 'plan-competencies') output = {
      competencies: criteria.map(row => ({
        id: row.competencyId, label: row.label, description: row.description,
        seedCriterionIds: [], citations: row.sourceCitations,
      })), issues: [],
    }
    else if (input.operation === 'draft-grade') output = {
      description: 'Source-grounded draft with separate unscored qualifications.',
      criteria: criteria.map(row => ({
        competencyId: row.competencyId, key: row.key, description: row.description, weight: row.weight,
        support: row.support, sourceCitations: row.sourceCitations, gradeBasis: row.gradeBasis,
        interpretation: row.interpretation, guidance: row.guidance,
      })),
      qualifications: target.version.qualifications, issues: [],
    }
    else if (input.operation === 'independent-grounding-review') output = { outcome: reviewOutcome, issues: [] }
    else throw new Error(`Unexpected test stage ${input.operation}`)
    return { content: JSON.stringify(output), model: detail.plan.processingSettings.tasks[request.taskId].modelName }
  } })
  for (const family of ['gradeDraft', 'gradeCompetencies']) {
    const start = calls.length
    const result = await api.runQcTrial(entry, family, detail.plan.processingSettings, deps, new AbortController().signal)
    assert.equal(result.trial.status, 'complete')
    assert.equal(result.trial.reviewedCriteria, 0)
    assert.equal(result.trial.exactAgreements, 0)
    assert.ok(result.models.gradeDraft)
    assert.ok(result.models.gradeReview)
    assert.equal(result.trial.rubric.qualifications.length, target.version.qualifications.length)
    for (const qualification of result.trial.rubric.qualifications) {
      const original = target.version.qualifications.find(item => item.id === qualification.id)
      assert.ok(qualification.interpretation.startsWith(original.interpretation))
      assert.match(qualification.interpretation, /unscored source requirement/)
      assert.deepEqual({ ...qualification, interpretation: original.interpretation }, original)
    }
    const excluded = result.trial.rubric.criteria.find(row => row.support === 'not-applicable')
    assert.equal(excluded.weight, 0)
    assert.deepEqual(excluded.gradeBasis, [])
    assert.ok(result.trial.rubric.criteria.every(row => row.sourceCitations.length > 0))
    for (const request of calls) {
      const data = JSON.parse(request.user)
      assert.equal(data.sources.length, entry.references.length)
      for (const source of data.sources) assert.ok(source.sections.every(section => section.included))
    }
    const firstInputs = calls.slice(start).map(request => request.user)
    f.now = new Date(Date.parse(f.now) + 1000).toISOString()
    assert.equal((await api.runQcTrial(entry, family, detail.plan.processingSettings, deps, new AbortController().signal)).trial.status, 'complete')
    assert.deepEqual(calls.slice(start + firstInputs.length).map(request => request.user), firstInputs,
      'Paired trials cannot change caller-assigned identity or timestamps in model-visible input')
  }
  const oversized = clone(entry)
  oversized.references.find(document => document.id !== target.seed.document.id).paragraphs.push({
    id: 'qc-other-grade-oversized', page: 1, heading: 'GS-15 additional background',
    text: 'Other grade documented work scope and background. '.repeat(9000),
  })
  const beforeBudgetFailure = calls.length
  const bounded = await api.runQcTrial(oversized, 'gradeDraft', detail.plan.processingSettings, deps, new AbortController().signal)
  assert.equal(bounded.trial.status, 'failed')
  assert.match(bounded.trial.error, /complete frozen evidence.*budget/i)
  assert.equal(calls.length, beforeBudgetFailure, 'An omitted source section must be rejected before any paid model call')
  reviewOutcome = 'needs-sources'
  assert.equal((await api.runQcTrial(entry, 'gradeDraft', detail.plan.processingSettings, deps, new AbortController().signal)).trial.status, 'failed')
  assert.deepEqual([...f.analysis.store.values], records)
  assert.deepEqual([...f.analysis.blobs.values], sources)
})

test('dedicated QC claim controls do not borrow analysis pauses or rewrite captured retry/model settings', async () => {
  const f = await qcFixture(), detail = await evaluationPlan(f)
  let live = clone(f.settings.settings), reads = 0
  live.workers.qc.pauseClaiming = true
  const settings = { legacy: f.settings, async current() { reads++; return api.captureProcessingSettings(live, 'execution-policy', f.now) } }
  assert.equal((await api.runQcWorker(dependencies(f, { settings, trial: completeTrial }))).claimed, 0)
  assert.equal(reads, 1)
  live = clone(live)
  live.workers.qc.pauseClaiming = false
  live.workers.analyses.pauseClaiming = true
  live.maintenance.pauseNewWork = true
  live.processing.qc.maxAutomaticAttempts = 1
  assert.equal((await api.runQcWorker(dependencies(f, { settings, trial: completeTrial }))).completed, 1)
  const evaluated = await f.plans.detail(f.caller('reviewer'), detail.plan.id)
  assert.equal(evaluated.plan.processingSettings.settings.processing.qc.maxAutomaticAttempts, 3)
  assert.equal(evaluated.plan.status, 'ready')
  assert.equal(reads, 2)
})
