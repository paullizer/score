import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, createRun, finishInitialization, seedResume, seedJob, publishResult, startHttp, ACTOR, NOW, clone,
} from './real-analyses.test-support.mjs'
import { fakeJobCosmos, realJobRecord, realJobRubric, JOB_TEST_TIME } from './job-cosmos-fake.mjs'

function runtimePolicy() {
  return {
    value: api.createDefaultAdminSettings(), revision: 'policy-one', unavailable: false, reads: 0,
    async capture() {
      this.reads++
      if (this.unavailable) throw api.unavailable('Settings read failed.')
      return api.captureProcessingSettings(this.value, this.revision, NOW)
    },
  }
}

const compareRecords = (f, runId) => [...f.analysis.store.values.values()]
  .filter(value => value.record.recordType === 'analysis-comparison' && value.record.runId === runId)
const configure = (f, policy) => {
  f.service = new api.RealAnalysisService(f.analysis, f, () => new Date(f.now), () => policy.capture())
}

test('direct analysis admissions enforce lowered counts and feature/pause policy, while historical reads, replay and retries survive failure', async () => {
  const f = fixture(), prepared = await createRun(f, 2, 1), policy = runtimePolicy()
  policy.value.analyses.maxComparisons = 1
  const http = await startHttp(f, true, policy)
  try {
    const key = randomUUID()
    const create = (id = key) => http.request('', 'POST', prepared.request, { headers: { 'idempotency-key': id } })
    assert.equal((await create()).status, 400)
    policy.value.analyses.maxComparisons = 2
    let response = await create()
    assert.equal(response.status, 202, await response.clone().text())
    const accepted = (await response.json()).run
    const runId = accepted.run.id
    assert.equal(accepted.run.processingSettings.revision, 'policy-one')
    const pin = clone(accepted.run.processingSettings)
    const manifest = await api.readAnalysisManifest(f.analysis.blobs, accepted.run)
    assert.deepEqual(manifest.processingSettings, pin)
    for (const value of compareRecords(f, runId)) assert.deepEqual(value.record.processingSettings, pin)
    policy.revision = 'policy-two'
    policy.value.features.newAnalyses = false
    assert.equal((await create(randomUUID())).status, 503)
    assert.equal((await http.request(`/${runId}`)).status, 200)
    const reads = policy.reads
    assert.equal((await create()).status, 202)
    assert.equal(policy.reads, reads, 'Accepted idempotent replay must not load current settings.')
    policy.value.features.newAnalyses = true
    policy.value.maintenance.pauseNewWork = true
    assert.equal((await create(randomUUID())).status, 503)
    policy.unavailable = true
    assert.equal((await create(randomUUID())).status, 503)
    assert.equal((await http.request(`/${runId}`)).status, 200)
    const pair = compareRecords(f, runId)[0]
    response = await http.request(`/${runId}/comparisons/${pair.record.id}/cancel`, 'POST', {},
      { headers: { 'if-match': pair.etag } })
    assert.equal(response.status, 200, await response.clone().text())
    const stopped = await f.analysis.store.get(f.workspaceId, pair.record.id)
    response = await http.request(`/${runId}/comparisons/${pair.record.id}/retry`, 'POST', {},
      { headers: { 'if-match': stopped.etag } })
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual((await f.analysis.store.get(f.workspaceId, pair.record.id)).record.processingSettings, pin)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  } finally { await http.close() }
})

test('configured analysis rollout blocks new processing while accepted comparisons and summary requests keep their pins', async () => {
  const f = fixture(), prepared = await createRun(f), policy = runtimePolicy()
  const http = await startHttp(f, true, policy, false)
  const create = () => http.request('', 'POST', prepared.request, { headers: { 'idempotency-key': randomUUID() } })
  try {
    let response = await create()
    assert.equal(response.status, 503, await response.clone().text())
    http.config.settings.runtimeEnabled = true
    response = await create()
    assert.equal(response.status, 202, await response.clone().text())
    const accepted = (await response.json()).run.run
    assert.equal(accepted.processingSettings.revision, 'policy-one')
    http.config.settings.runtimeEnabled = false
    const pair = compareRecords(f, accepted.id)[0]
    const path = `/${accepted.id}/comparisons/${pair.record.id}`
    assert.equal((await http.request(`${path}/cancel`, 'POST', {}, { headers: { 'if-match': pair.etag } })).status, 200)
    const cancelled = await f.analysis.store.get(f.workspaceId, pair.record.id)
    response = await http.request(`${path}/retry`, 'POST', {}, { headers: { 'if-match': cancelled.etag } })
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual((await f.analysis.store.get(f.workspaceId, pair.record.id)).record.processingSettings, accepted.processingSettings)
    await publishResult(f, accepted.id, pair.record.id)
    const automatic = [...f.analysis.store.values.values()].filter(value => value.record.runId === accepted.id &&
      ['analysis-candidate-narrative', 'analysis-target-narrative'].includes(value.record.recordType))
    assert.equal(automatic.length, 2)
    assert.ok(automatic.every(value => value.record.processingSettings.revision === 'policy-one'))
    const scope = await f.service.summaries(f.workspaceId, accepted.id)
    const requestId = randomUUID()
    const regenerate = () => http.request(`/${accepted.id}/summaries`, 'POST', { mode: 'all' },
      { headers: { 'idempotency-key': requestId, 'if-match': scope.etag } })
    assert.equal((await regenerate()).status, 503)
    http.config.settings.runtimeEnabled = true
    policy.revision = 'regeneration-after-ready'
    f.analysis.store._beforeBatch(() => { throw new Error('Interrupted pinned summary admission') })
    assert.ok((await regenerate()).status >= 500)
    http.config.settings.runtimeEnabled = false
    policy.unavailable = true
    const reads = policy.reads
    response = await regenerate()
    assert.equal(response.status, 202, await response.clone().text())
    assert.equal(policy.reads, reads)
    const request = await response.json()
    await api.advanceAnalysisNarrativeRequest(f.analysis, f.workspaceId, accepted.id, request.requestId, () => new Date(f.now))
    const scheduled = [...f.analysis.store.values.values()].filter(value => value.record.runId === accepted.id &&
      ['analysis-narrative-request', 'analysis-candidate-narrative', 'analysis-target-narrative'].includes(value.record.recordType))
    assert.equal(scheduled.length, 3)
    assert.ok(scheduled.every(value => value.record.processingSettings.revision === 'regeneration-after-ready'))
    const coordinator = scheduled.find(value => value.record.recordType === 'analysis-narrative-request').record
    const plan = JSON.parse(Buffer.from((await f.analysis.blobs.read(coordinator.plan.blobName)).bytes).toString())
    assert.deepEqual(plan.processingSettings, coordinator.processingSettings)
    assert.deepEqual((await f.analysis.store.get(f.workspaceId, accepted.id)).record.processingSettings, accepted.processingSettings)
    assert.equal((await http.request(`/${accepted.id}`)).status, 200)
    assert.equal((await create()).status, 503)
  } finally { await http.close() }
})

test('truly unconfigured legacy admissions remain available without creating runtime pins', async () => {
  const f = fixture(), prepared = await createRun(f), http = await startHttp(f)
  try {
    const response = await http.request('', 'POST', prepared.request, { headers: { 'idempotency-key': randomUUID() } })
    assert.equal(response.status, 202, await response.clone().text())
    const run = (await response.json()).run.run
    assert.equal(run.processingSettings, undefined)
    const manifest = await api.readAnalysisManifest(f.analysis.blobs, run)
    assert.equal(manifest.processingSettings, undefined)
    assert.ok(compareRecords(f, run.id).every(value => value.record.processingSettings === undefined))
  } finally { await http.close() }
})

test('an accepted single-summary admission recovers its pin and dependent target after rollout closes', async () => {
  const f = fixture(), policy = runtimePolicy(), { run } = await createRun(f)
  const pair = compareRecords(f, run.id)[0]
  await publishResult(f, run.id, pair.record.id, false, { scheduleNarratives: false })
  const subject = { kind: 'candidate', subjectId: pair.record.id }
  const history = await api.readAnalysisSummaryHistory(f.analysis, f.workspaceId, run.id, subject)
  const http = await startHttp(f, true, policy), requestId = randomUUID()
  const retry = () => http.request(`/${run.id}/summaries/candidate/${pair.record.id}/retry`, 'POST', {},
    { headers: { 'idempotency-key': requestId, 'if-match': history.etag } })
  try {
    f.analysis.store._beforeBatch(() => { throw new Error('Interrupted accepted single-summary admission') })
    assert.equal((await retry()).status, 503)
    http.config.settings.runtimeEnabled = false
    policy.unavailable = true
    const reads = policy.reads
    const response = await retry()
    assert.equal(response.status, 202, await response.clone().text())
    assert.equal(policy.reads, reads)
    const children = [...f.analysis.store.values.values()].filter(value => value.record.runId === run.id &&
      ['analysis-candidate-narrative', 'analysis-target-narrative'].includes(value.record.recordType))
    assert.equal(children.length, 2)
    assert.ok(children.every(value => value.record.processingSettings.revision === 'policy-one'))
  } finally { await http.close() }
})

test('an immutable accepted analysis manifest recovers after interrupted admission without rebinding to current settings', async () => {
  const f = fixture(), policy = runtimePolicy()
  configure(f, policy)
  const resume = await seedResume(f), job = await seedJob(f)
  const request = { name: 'Captured admission', resumes: [resume.selection], targets: [job.selection] }
  const key = randomUUID()
  f.analysis.store._beforeCreate(() => { throw new Error('Simulated process interruption') })
  await assert.rejects(f.service.create(f.workspaceId, key, request, ACTOR), /interruption/)
  const manifestName = `${f.workspaceId}/analysis-run-${key}/manifest.json`
  const manifest = JSON.parse(Buffer.from(f.analysis.blobs.values.get(manifestName).bytes).toString())
  assert.equal(manifest.processingSettings.revision, 'policy-one')
  f.analysis.store._beforeCreate(undefined)
  policy.unavailable = true
  const recovered = await f.service.create(f.workspaceId, key, request, ACTOR)
  assert.deepEqual(recovered.run.processingSettings, manifest.processingSettings)
  assert.equal(policy.reads, 1)
})

test('legacy accepted retry uses the immutable configured baseline, fails closed when it is unavailable, and never reads newest policy', async () => {
  const f = fixture(), { run } = await createRun(f), policy = runtimePolicy()
  const raw = f.analysis.blobs.values.get(run.manifest.blobName)
  const manifest = JSON.parse(Buffer.from(raw.bytes).toString())
  delete manifest.processingSettings
  const bytes = Buffer.from(JSON.stringify(manifest))
  const legacyBlob = { ...raw, bytes, sha256: api.analysisBytesHash(bytes) }
  f.analysis.blobs.values.set(run.manifest.blobName, legacyBlob)
  const oldRun = clone(run)
  delete oldRun.processingSettings
  oldRun.manifest = api.analysisBlobReference(run.manifest.blobName, legacyBlob)
  f.analysis.store.save(oldRun)
  const pair = compareRecords(f, run.id)[0]
  const oldPair = clone(pair.record)
  delete oldPair.processingSettings
  const savedPair = f.analysis.store.save(oldPair)
  const legacySettings = api.createDefaultAdminSettings()
  legacySettings.ai.deployments[0].deploymentName = 'pre-rollout-deployment'
  const baseline = api.captureProcessingSettings(legacySettings, api.LEGACY_SETTINGS_REVISION, NOW)
  policy.unavailable = true
  let legacyUnavailable = true, legacyReads = 0
  policy.captureLegacy = async () => {
    legacyReads++
    if (legacyUnavailable) throw api.unavailable('Immutable baseline unavailable.')
    return baseline
  }
  const http = await startHttp(f, true, policy)
  const path = `/${run.id}/comparisons/${pair.record.id}`
  try {
    assert.equal((await http.request(`/${run.id}`)).status, 200)
    assert.equal((await http.request(`${path}/cancel`, 'POST', {}, { headers: { 'if-match': savedPair.etag } })).status, 200)
    const cancelled = await f.analysis.store.get(f.workspaceId, pair.record.id)
    assert.equal((await http.request(`${path}/retry`, 'POST', {}, { headers: { 'if-match': cancelled.etag } })).status, 503)
    assert.equal((await f.analysis.store.get(f.workspaceId, pair.record.id)).record.processingSettings, undefined)
    legacyUnavailable = false
    const response = await http.request(`${path}/retry`, 'POST', {}, { headers: { 'if-match': cancelled.etag } })
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual((await f.analysis.store.get(f.workspaceId, pair.record.id)).record.processingSettings, baseline)
    assert.deepEqual((await f.analysis.store.get(f.workspaceId, run.id)).record.processingSettings, baseline)
    assert.equal(policy.reads, 0)
    assert.equal(legacyReads, 2, 'Each request reads the immutable baseline once, not once per record.')
  } finally { await http.close() }
})

test('on-demand summaries do not run automatically; explicit regeneration captures a separate policy and retries preserve it', async () => {
  const f = fixture(), policy = runtimePolicy()
  policy.value.summaries.generationMode = 'on-demand'
  configure(f, policy)
  const { run } = await createRun(f)
  const pair = compareRecords(f, run.id)[0]
  await publishResult(f, run.id, pair.record.id)
  assert.equal([...f.analysis.store.values.values()].filter(value => value.record.recordType === 'analysis-candidate-narrative').length, 0)
  const scope = await f.service.summaries(f.workspaceId, run.id)
  policy.revision = 'summary-policy-two'
  policy.value.summaries.maxRounds = 1
  const key = randomUUID()
  const request = await f.service.generateSummaries(f.workspaceId, run.id, { mode: 'all' }, key, scope.etag, ACTOR)
  policy.unavailable = true
  await api.advanceAnalysisNarrativeRequest(f.analysis, f.workspaceId, run.id, request.requestId, () => new Date(f.now))
  const narratives = [...f.analysis.store.values.values()].filter(value =>
    ['analysis-candidate-narrative', 'analysis-target-narrative'].includes(value.record.recordType))
  assert.equal(narratives.length, 2)
  for (const value of narratives) {
    assert.equal(value.record.processingSettings.revision, 'summary-policy-two')
    assert.equal(value.record.processingSettings.settings.summaries.maxRounds, 1)
  }
  assert.equal((await f.analysis.store.get(f.workspaceId, run.id)).record.processingSettings.revision, 'policy-one')
  assert.equal((await f.analysis.store.get(f.workspaceId, pair.record.id)).record.processingSettings.revision, 'policy-one')
  assert.equal((await f.service.generateSummaries(f.workspaceId, run.id, { mode: 'all' }, key, scope.etag, ACTOR)).requestId, key)
  const candidate = narratives.find(value => value.record.recordType === 'analysis-candidate-narrative')
  const stopped = {
    ...candidate.record, status: 'failed',
    error: { code: 'service-unavailable', stage: 'candidate-generation', message: 'Unavailable model.', retryable: true },
  }
  delete stopped.nextAttemptAt
  const failed = await f.analysis.store.replace(stopped, candidate.etag)
  const subject = { kind: 'candidate', subjectId: pair.record.id }
  const history = await f.service.summaryHistory(f.workspaceId, run.id, subject)
  const target = narratives.find(value => value.record.recordType === 'analysis-target-narrative')
  await f.service.retrySummary(f.workspaceId, run.id, subject, randomUUID(), history.etag, ACTOR)
  const retried = await f.analysis.store.get(f.workspaceId, candidate.record.id)
  assert.equal(retried.record.generationId, failed.record.generationId)
  assert.deepEqual(retried.record.processingSettings, failed.record.processingSettings)
  assert.deepEqual((await f.analysis.store.get(f.workspaceId, target.record.id)).record, target.record,
    'Retrying an accepted candidate must not create a fresh target generation or reset its budget.')
  assert.throws(() => api.assertAnalysisReplacement(retried.record, {
    ...retried.record, processingSettings: { ...retried.record.processingSettings, revision: 'forged' },
  }), /processing settings/)
})

test('summary history and manual-publication policies remain restrictive during configured rollout inactivity', async () => {
  const f = fixture(), policy = runtimePolicy(), { run } = await createRun(f)
  const pair = compareRecords(f, run.id)[0]
  await publishResult(f, run.id, pair.record.id)
  policy.value.summaries.historyRoles = 'owner'
  policy.value.summaries.manualPublicationRoles = 'owner'
  policy.value.summaries.allowManualPublication = false
  const http = await startHttp(f, true, policy, false)
  const path = `/${run.id}/summaries/candidate/${pair.record.id}`
  try {
    assert.equal((await http.request(`${path}/history`, 'GET', undefined, { role: 'editor' })).status, 403)
    assert.equal((await http.request(`${path}/history`, 'GET', undefined, { role: 'viewer' })).status, 403)
    assert.equal((await http.request(`${path}/history`, 'GET', undefined, { role: 'stranger' })).status, 404)
    assert.equal((await http.request(`${path}/history`)).status, 200)
    const publication = await http.request(`${path}/publish`, 'POST', {
      generationId: randomUUID(), round: 1, outputSha256: '0'.repeat(64),
    }, { headers: { 'idempotency-key': randomUUID(), 'if-match': '"unused"' } })
    assert.equal(publication.status, 403)
    policy.unavailable = true
    assert.equal((await http.request(`${path}/history`)).status, 503)
    assert.equal((await http.request(`/${run.id}/summaries`, 'GET', undefined, { role: 'viewer' })).status, 200)
  } finally { await http.close() }
})

test('official export capture enforces format, scope, roles and pinned policy even across live changes or settings outage', async () => {
  const f = fixture(), policy = runtimePolicy(), { run } = await createRun(f, 1, 2)
  const pairs = compareRecords(f, run.id)
  for (const pair of pairs) await publishResult(f, run.id, pair.record.id)
  policy.value.reports.enabledFormats = ['csv']
  policy.value.reports.defaultFormat = 'csv'
  policy.value.reports.allowedRoles = ['owner']
  policy.value.reports.maxComparisons = 1
  policy.value.reports.batchComparisons = 1
  const http = await startHttp(f, true, policy)
  const prefix = `/${run.id}/report-capture`
  const targetId = pairs[0].record.target.summary.id
  const query = new URLSearchParams({ format: 'csv', targetId })
  try {
    assert.equal((await http.request(`${prefix}?format=csv`)).status, 400)
    assert.equal((await http.request(`${prefix}?format=pdf&targetId=${encodeURIComponent(targetId)}`)).status, 403)
    assert.equal((await http.request(`${prefix}?${query}`, 'GET', undefined, { role: 'viewer' })).status, 403)
    const response = await http.request(`${prefix}?${query}`)
    assert.equal(response.status, 200, await response.clone().text())
    const capture = await response.json()
    assert.equal(capture.settings.revision, 'policy-one')
    assert.match(capture.captureToken, /^[A-Za-z0-9_-]{43}$/)
    const batch = new URLSearchParams({
      comparisonId: pairs[0].record.id, format: 'csv', targetId,
      settingsRevision: capture.settings.revision, captureToken: capture.captureToken,
    })
    const batchPath = () => `/${run.id}/report-comparisons?${batch}`
    assert.equal((await http.request(batchPath(), 'GET', undefined, { role: 'editor' })).status, 400)
    policy.revision = 'policy-two'
    policy.value.reports.allowedRoles = []
    policy.value.reports.enabledFormats = []
    policy.value.reports.defaultFormat = null
    policy.unavailable = true
    const capturedRead = await http.request(batchPath())
    assert.equal(capturedRead.status, 200, await capturedRead.clone().text())
    assert.deepEqual((await capturedRead.json()).settings, capture.settings)
    assert.equal((await http.request(`${prefix}?${query}`)).status, 503)
    batch.set('comparisonId', pairs[1].record.id)
    assert.equal((await http.request(batchPath())).status, 404)
    batch.set('comparisonId', pairs[0].record.id)
    batch.set('settingsRevision', 'policy-two')
    assert.equal((await http.request(batchPath())).status, 400)
    batch.set('settingsRevision', capture.settings.revision)
    batch.set('captureToken', 'forged-token')
    assert.equal((await http.request(batchPath())).status, 400)
    batch.delete('captureToken')
    assert.equal((await http.request(batchPath())).status, 400)
  } finally { await http.close() }
})

test('configured rollout inactivity preserves saved report restrictions without applying new-analysis limits to history', async () => {
  const f = fixture(), policy = runtimePolicy(), { run } = await createRun(f, 2)
  const pairs = compareRecords(f, run.id)
  for (const pair of pairs) await publishResult(f, run.id, pair.record.id)
  policy.value.analyses.maxComparisons = 1
  policy.value.reports.enabledFormats = ['csv']
  policy.value.reports.defaultFormat = 'csv'
  policy.value.reports.allowedRoles = ['owner']
  policy.value.reports.maxComparisons = 2
  policy.value.reports.batchComparisons = 2
  const http = await startHttp(f, true, policy, false)
  const path = `/${run.id}/report-capture`
  try {
    assert.equal((await http.request(`${path}?format=pdf`)).status, 403)
    assert.equal((await http.request(`${path}?format=csv`, 'GET', undefined, { role: 'viewer' })).status, 403)
    const response = await http.request(`${path}?format=csv`)
    assert.equal(response.status, 200, await response.clone().text())
    const capture = await response.json()
    const query = new URLSearchParams({ captureToken: capture.captureToken, format: 'csv', settingsRevision: capture.settings.revision })
    for (const pair of pairs) query.append('comparisonId', pair.record.id)
    const batchPath = `/${run.id}/report-comparisons?${query}`
    const batch = await http.request(batchPath)
    assert.equal(batch.status, 200, await batch.clone().text())
    assert.equal((await batch.json()).comparisons.length, 2)
    policy.value.reports.allowedRoles = []
    assert.equal((await http.request(`${path}?format=csv`)).status, 403)
    assert.equal((await http.request(`/${run.id}/report-comparisons?comparisonId=${pairs[0].record.id}`)).status, 403)
    policy.unavailable = true
    assert.equal((await http.request(`${path}?format=csv`)).status, 503)
    assert.equal((await http.request(`/${run.id}`)).status, 200)
    assert.equal((await http.request(batchPath)).status, 200)
  } finally { await http.close() }
})

test('captured exports enforce concurrent-batch, byte, expiry and current workspace-role limits server-side', async () => {
  const f = fixture(), policy = runtimePolicy(), { run } = await createRun(f)
  const manifest = await api.readAnalysisManifest(f.analysis.blobs, run)
  let now = Date.parse(NOW)
  const captures = new api.AnalysisReportCaptures(() => new Date(now))
  policy.value.reports.maxConcurrentBatches = 1
  policy.value.reports.maxInputBytes = 1
  policy.value.reports.allowedRoles = ['owner']
  const metadata = captures.capture(await policy.capture(), 'owner', ACTOR, run, manifest, 'csv')
  const ids = manifest.comparisons.map(value => value.id)
  const begin = role => captures.begin(metadata.captureToken, f.workspaceId, run.id, ACTOR, role ?? 'owner', ids)
  assert.throws(() => begin('viewer'), { status: 403 })
  const active = begin()
  assert.throws(() => begin(), { status: 503 })
  assert.throws(() => active.finish({ schemaVersion: 1, dataKind: 'real', workspaceId: f.workspaceId,
    runId: run.id, targets: [], comparisons: [] }), { status: 400 })
  begin().finish()
  now += policy.value.reports.maxGenerationMilliseconds
  assert.throws(() => begin(), { status: 400 })
})

test('real Cosmos job admission counts a whole batch atomically, retains consumed slots, and protects accepted pins', async () => {
  const cosmos = fakeJobCosmos(), store = api.createJobStoreFromContainer(cosmos.container), policy = runtimePolicy()
  policy.value.imports.jobs.maxBatchItems = 2
  const snapshot = await policy.capture(), batchId = randomUUID()
  const record = () => {
    const value = realJobRecord(undefined, `job-${randomUUID()}`)
    value.job.batchId = batchId
    value.processingSettings = snapshot
    return value
  }
  const first = record(), second = record()
  const [left, right] = await Promise.all([store.create(first), store.create(second)])
  assert.equal(left.created, true)
  assert.equal(right.created, true)
  assert.equal((await store.create(first)).created, false)
  await assert.rejects(store.create(record()), /2-item limit/)
  const batch = cosmos.records.get(`${first.workspaceId}/job-batch-${batchId}`)
  assert.equal(batch.jobIds.length, 2)
  assert.equal(cosmos.batches.filter(ops => ops.some(op => op.resourceBody?.recordType === 'job' &&
    op.operationType === 'Create')).length >= 2, true)
  const changed = { ...first, processingSettings: { ...snapshot, revision: 'replacement-policy' } }
  await assert.rejects(store.replace(changed, left.value.etag), /settings are immutable/)
  const rubric = realJobRubric(changed)
  const published = { ...changed, job: { ...changed.job, status: 'ready', rubricId: rubric.id } }
  await assert.rejects(store.publish(published, left.value.etag, rubric), /settings are immutable/)
  const deleting = await store.transitionLifecycle(first.workspaceId, first.id, left.value.etag, 'job', 'delete', JOB_TEST_TIME)
  await store.purgeJobRecords(first.workspaceId, first.id, JOB_TEST_TIME)
  assert.ok(deleting.record.lifecycle.deletingAt)
  await assert.rejects(store.create(record()), /2-item limit/)
  assert.equal(cosmos.records.get(`${first.workspaceId}/job-batch-${batchId}`).jobIds.length, 2)
  await store.setWorkspaceLifecycle(first.workspaceId, 'deleting', JOB_TEST_TIME)
  await store.purgeWorkspaceRecords(first.workspaceId, JOB_TEST_TIME)
  assert.equal(cosmos.records.has(`${first.workspaceId}/job-batch-${batchId}`), false)
})

const HTTP_TENANT = '00000000-0000-4000-8000-000000000001'
const HTTP_OWNER = '00000000-0000-4000-8000-000000000002'
const rejectsWith = (status, pattern) => error => error.status === status && (!pattern || pattern.test(error.message))
const byIndex = values => values.sort((a, b) => a.record.index - b.record.index)
const changeRules = policy => {
  policy.revision = 'policy-two'
  policy.value.ai.tasks.assessment.completionTokenLimit = 4096
}

async function failComparison(f, runId, comparisonId) {
  const [parent, value] = await Promise.all([f.analysis.store.get(f.workspaceId, runId), f.analysis.store.get(f.workspaceId, comparisonId)])
  const timestamp = new Date(Math.max(Date.parse(f.now), Date.parse(parent.record.updatedAt), Date.parse(value.record.updatedAt))).toISOString()
  const failed = {
    ...clone(value.record), status: 'failed', attempts: 3, updatedAt: timestamp, completedAt: timestamp,
    error: { code: 'grounding-failed', stage: 'grounding', message: 'Exact evidence could not be supported.', retryable: false },
  }
  delete failed.nextAttemptAt
  delete failed.lease
  delete failed.attemptId
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: failed, etag: value.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(parent.record, value.record, failed, timestamp), etag: parent.etag },
  ])
}
const runEtag = async (f, runId) => (await f.analysis.store.get(f.workspaceId, runId)).etag

test('current-rules retry records an audited upgrade for stopped comparisons while pins and completed results stay immutable', async () => {
  const f = fixture(), policy = runtimePolicy()
  configure(f, policy)
  const created = await createRun(f, 3, 1), runId = created.run.id
  const pin = clone(created.run.processingSettings)
  assert.equal(pin.revision, 'policy-one')
  const [done, failed, cancelled] = byIndex(compareRecords(f, runId)).map(value => value.record.id)
  await publishResult(f, runId, done)
  await failComparison(f, runId, failed)
  const active = await f.analysis.store.get(f.workspaceId, cancelled)
  await f.service.comparisonAction(f.workspaceId, runId, cancelled, 'cancel', active.etag)
  const completed = await f.analysis.store.get(f.workspaceId, done)

  policy.revision = 'policy-relabelled'
  await f.service.retry(f.workspaceId, runId, { comparisonIds: [failed], useCurrentRules: true }, await runEtag(f, runId), ACTOR)
  let value = await f.analysis.store.get(f.workspaceId, failed)
  assert.equal(value.record.status, 'queued')
  assert.equal(value.record.settingsUpgrade, undefined, 'A new revision label with identical rules is an ordinary retry.')
  assert.deepEqual(api.analysisComparisonProcessingSettings(value.record), pin)

  await failComparison(f, runId, failed)
  changeRules(policy)
  const summary = await f.service.retry(f.workspaceId, runId, { useCurrentRules: true }, await runEtag(f, runId), ACTOR)
  for (const id of [failed, cancelled]) {
    value = await f.analysis.store.get(f.workspaceId, id)
    assert.equal(value.record.status, 'queued')
    assert.deepEqual(value.record.processingSettings, pin, 'The admitted pin is never rewritten.')
    assert.equal(value.record.settingsUpgrade.requestedBy, ACTOR)
    assert.equal(value.record.settingsUpgrade.requestedAt, value.record.updatedAt)
    assert.equal(value.record.settingsUpgrade.processingSettings.revision, 'policy-two')
    assert.equal(api.analysisComparisonProcessingSettings(value.record).settings.ai.tasks.assessment.completionTokenLimit, 4096)
  }
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, done), completed, 'Completed evidence is never re-pinned.')
  assert.deepEqual(summary.run.processingSettings, pin)
  assert.deepEqual((await api.readAnalysisManifest(f.analysis.blobs, summary.run)).processingSettings, pin)

  const upgraded = await f.analysis.store.get(f.workspaceId, failed)
  await failComparison(f, runId, failed)
  await f.service.retry(f.workspaceId, runId, { comparisonIds: [failed] }, await runEtag(f, runId))
  assert.deepEqual((await f.analysis.store.get(f.workspaceId, failed)).record.settingsUpgrade, upgraded.record.settingsUpgrade,
    'A later ordinary retry keeps the explicitly selected rules.')
})

test('current-rules retry refuses unfinished initialization or cancellation, anonymous callers and unpinned deployments', async () => {
  const f = fixture(), policy = runtimePolicy()
  configure(f, policy)
  const initializing = await createRun(f, 2, 20)
  assert.ok(initializing.run.progress.initialized < initializing.run.progress.total)
  await assert.rejects(f.service.retry(f.workspaceId, initializing.run.id, { useCurrentRules: true }, initializing.etag, ACTOR),
    rejectsWith(409, /Current rules apply only/))
  await finishInitialization(f, initializing.run.id)
  const cancelling = await f.service.cancel(f.workspaceId, initializing.run.id, ACTOR, await runEtag(f, initializing.run.id))
  assert.equal(cancelling.run.cancellation.completedAt, undefined)
  await assert.rejects(f.service.retry(f.workspaceId, initializing.run.id, { useCurrentRules: true }, cancelling.etag, ACTOR),
    rejectsWith(409, /Current rules apply only/))

  const created = await createRun(f, 1, 1), runId = created.run.id
  const [pair] = compareRecords(f, runId)
  await failComparison(f, runId, pair.record.id)
  changeRules(policy)
  await assert.rejects(f.service.retry(f.workspaceId, runId, { useCurrentRules: true }, await runEtag(f, runId)),
    rejectsWith(400, /who requested/))
  f.service = new api.RealAnalysisService(f.analysis, f, () => new Date(f.now),
    Object.assign(() => policy.capture(), { pinNewAdmissions: false }))
  await assert.rejects(f.service.retry(f.workspaceId, runId, { useCurrentRules: true }, await runEtag(f, runId), ACTOR),
    rejectsWith(409, /does not pin processing rules/))
  const unchanged = await f.analysis.store.get(f.workspaceId, pair.record.id)
  assert.equal(unchanged.record.status, 'failed')
  assert.equal(unchanged.record.settingsUpgrade, undefined)
})

test('the comparison store guard rejects forging, replacing or removing a current-rules upgrade outside an explicit retry', async () => {
  const f = fixture(), policy = runtimePolicy()
  configure(f, policy)
  const created = await createRun(f, 2, 1), runId = created.run.id
  const [first, second] = byIndex(compareRecords(f, runId)).map(value => value.record.id)
  await failComparison(f, runId, first)
  changeRules(policy)
  await f.service.retry(f.workspaceId, runId, { comparisonIds: [first], useCurrentRules: true }, await runEtag(f, runId), ACTOR)
  const upgraded = (await f.analysis.store.get(f.workspaceId, first)).record
  const upgrade = clone(upgraded.settingsUpgrade)
  const later = new Date(Date.parse(upgraded.updatedAt) + 1000).toISOString()
  const rejected = (previous, next) => assert.throws(() => api.assertAnalysisReplacement(previous, next), /Current-rules processing settings/)
  const removed = { ...clone(upgraded), updatedAt: later }
  delete removed.settingsUpgrade
  rejected(upgraded, removed)
  rejected(upgraded, { ...clone(upgraded), updatedAt: later, settingsUpgrade: { ...upgrade, requestedBy: 'someone-else' } })
  const queued = (await f.analysis.store.get(f.workspaceId, second)).record
  rejected(queued, { ...clone(queued), updatedAt: later, settingsUpgrade: { ...upgrade, requestedAt: later } })

  const stopped = { ...clone(upgraded), status: 'failed', updatedAt: later, completedAt: later,
    error: { code: 'grounding-failed', stage: 'grounding', message: 'Exact evidence could not be supported.', retryable: false } }
  delete stopped.nextAttemptAt
  const retryAt = new Date(Date.parse(later) + 1000).toISOString()
  api.assertAnalysisReplacement(stopped, api.retryAnalysisComparisonRecord(stopped, retryAt, { ...upgrade, requestedAt: retryAt }))
  rejected(stopped, api.retryAnalysisComparisonRecord(stopped, retryAt, { ...upgrade, requestedAt: later }))
  rejected(stopped, { ...api.retryAnalysisComparisonRecord(stopped, retryAt, { ...upgrade, requestedAt: retryAt }), retryCount: stopped.retryCount + 2 })
})

test('the HTTP retry route records the signed-in actor for current rules while ordinary retries survive disabled new analyses', async () => {
  const f = fixture(), prepared = await createRun(f, 2, 1), policy = runtimePolicy()
  const http = await startHttp(f, true, policy)
  try {
    let response = await http.request('', 'POST', prepared.request, { headers: { 'idempotency-key': randomUUID() } })
    assert.equal(response.status, 202, await response.clone().text())
    const runId = (await response.json()).run.run.id
    const pin = clone((await f.analysis.store.get(f.workspaceId, runId)).record.processingSettings)
    const [first, second] = byIndex(compareRecords(f, runId)).map(value => value.record.id)
    await failComparison(f, runId, first)
    await failComparison(f, runId, second)
    const retry = async body => http.request(`/${runId}/retry`, 'POST', body, { headers: { 'if-match': await runEtag(f, runId) } })
    assert.equal((await retry({ useCurrentRules: 'yes' })).status, 400)
    assert.equal((await retry({ useCurrentRules: true, rules: 'current' })).status, 400)
    changeRules(policy)
    policy.value.features.newAnalyses = false
    response = await retry({ comparisonIds: [first], useCurrentRules: true })
    assert.equal(response.status, 503, await response.clone().text())
    assert.equal((await f.analysis.store.get(f.workspaceId, first)).record.status, 'failed')
    response = await retry({ comparisonIds: [first] })
    assert.equal(response.status, 200, await response.clone().text())
    let value = await f.analysis.store.get(f.workspaceId, first)
    assert.equal(value.record.status, 'queued')
    assert.equal(value.record.settingsUpgrade, undefined)
    policy.value.features.newAnalyses = true
    response = await retry({ comparisonIds: [second], useCurrentRules: true })
    assert.equal(response.status, 200, await response.clone().text())
    value = await f.analysis.store.get(f.workspaceId, second)
    assert.equal(value.record.settingsUpgrade.requestedBy, api.principalKeyFor(HTTP_TENANT, HTTP_OWNER))
    assert.equal(value.record.settingsUpgrade.processingSettings.revision, 'policy-two')
    assert.deepEqual(value.record.processingSettings, pin)
    const detail = await http.request(`/${runId}/comparisons/${second}`)
    assert.equal(detail.status, 200)
    assert.equal((await detail.json()).comparison.settingsUpgrade.processingSettings.revision, 'policy-two')
  } finally { await http.close() }
})
