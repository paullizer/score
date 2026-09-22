import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { api, qcFixture, submittedPlan, proposal, clone, principal } from './qc.test-support.mjs'
import { legacyV1Capture, legacyV1Snapshot } from '../worker-tests/runtime-settings-test-support.mjs'
import { loadWorker } from '../worker-tests/shared-model-loader.mjs'

const legacySettings = () => legacyV1Snapshot().settings
const rawHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('accepted version-1 settings retain their exact content, task count, and hashes under strict readers', () => {
  const snapshot = legacyV1Snapshot(), before = legacyV1Capture.snapshotJson, sha256 = api.qcValueHash(snapshot)
  const validated = api.validateProcessingSettings(snapshot)
  assert.equal(Object.keys(validated.tasks).length, 11)
  assert.equal(validated.settings.schemaVersion, 1)
  assert.equal(JSON.stringify(validated), before)
  assert.equal(api.qcValueHash(validated), sha256)
  assert.equal(rawHash(validated), legacyV1Capture.snapshotSha256)
  assert.equal(rawHash(validated.settings), legacyV1Capture.policySha256)
  assert.throws(() => api.resolveTaskModel(validated, 'qcPlan'), /did not capture/)
  const upgraded = api.captureQcProcessingSettings(snapshot)
  assert.equal(upgraded.settings.schemaVersion, 2)
  assert.equal(upgraded.tasks.qcPlan.taskId, 'qcPlan')
  assert.equal(upgraded.tasks.qcPlan.deploymentId, snapshot.settings.ai.defaultDeploymentId)
  assert.equal(upgraded.tasks.qcPlan.reasoningEffort, null)
  assert.equal(upgraded.settings.workers.qc.maxItemsPerExecution, 2)
  for (const [task, binding] of Object.entries(snapshot.tasks)) assert.deepEqual(upgraded.tasks[task], binding)
  assert.equal(JSON.stringify(snapshot), before)
})

test('server policy reads, ordinary patches, imports and restores preserve genuine v1 history across explicit QC upgrades', async () => {
  const { AdminSettingsService } = await loadWorker('../server/settings/service.ts')
  const original = legacyV1Snapshot(), admin = principal('admin')
  const baseline = {
    revision: original.revision, previousRevision: null, createdAt: original.capturedAt,
    actor: { system: 'initialization' }, reason: 'initialize', changes: [], settings: clone(original.settings),
  }
  const revisions = new Map([[baseline.revision, clone(baseline)]])
  const immutableHashes = new Map([[baseline.revision, rawHash(baseline)]])
  let current = { revision: clone(baseline), etag: '"settings-1"' }, nextId = 0
  const store = {
    async getCurrent() { return clone(current) },
    async getRevision(id) { return clone(revisions.get(id)) },
    async initialize() { assert.fail('Existing historical policy must not be replaced by current defaults') },
    async publish(value, expected) {
      assert.equal(expected, current.etag)
      assert.equal(revisions.has(value.revision), false)
      revisions.set(value.revision, clone(value))
      immutableHashes.set(value.revision, rawHash(value))
      current = { revision: clone(value), etag: `"settings-${revisions.size}"` }
      return clone(current)
    },
  }
  const service = new AdminSettingsService({
    config: { tenantId: admin.tenantId,
      settings: { runtimeEnabled: true, defaults: api.createDefaultAdminSettings() } },
    store, now: () => new Date('2026-09-22T12:00:00.000Z'), newId: () => `qc-migration-${++nextId}`,
  })
  const assertV1 = settings => {
    assert.equal(settings.schemaVersion, 1)
    assert.equal(Object.keys(settings.ai.tasks).length, 11)
    assert.equal(Object.hasOwn(settings.ai.tasks, 'qcPlan'), false)
    assert.equal(Object.hasOwn(settings.processing, 'qc'), false)
    assert.equal(Object.hasOwn(settings.workers, 'qc'), false)
    assert.deepEqual(settings.documents.originalDownloadRoles, original.settings.documents.originalDownloadRoles)
    assert.deepEqual(settings.reports.allowedRoles, original.settings.reports.allowedRoles)
  }
  const initial = await service.read()
  assertV1(initial.settings)
  assert.equal(initial.defaults.schemaVersion, 2)
  assert.equal(rawHash(initial.settings), legacyV1Capture.policySha256)
  const accepted = await service.captureLegacy(), exported = await service.export()
  assert.equal(rawHash(accepted), legacyV1Capture.snapshotSha256)
  assertV1(exported.settings)
  const patched = await service.patch(admin, { appearance: { applicationTitle: 'Ordinary v1 edit' } }, initial.etag)
  assertV1(patched.settings)
  assert.deepEqual(patched.settings.ai, original.settings.ai)
  assert.deepEqual(patched.settings.processing, original.settings.processing)
  assert.deepEqual(patched.settings.workers, original.settings.workers)
  const importedDocument = clone(exported)
  importedDocument.settings.appearance.applicationTitle = 'Imported v1 edit'
  const beforePreview = revisions.size
  const preview = await service.previewImport(importedDocument, patched.etag)
  assertV1(preview.settings)
  await assert.rejects(service.applyImport(admin, importedDocument, patched.etag, false), error => error.status === 400)
  assert.equal(revisions.size, beforePreview, 'Preview and unconfirmed import cannot publish')
  const imported = await service.applyImport(admin, importedDocument, patched.etag, true)
  assertV1(imported.settings)
  assert.equal(imported.settings.appearance.applicationTitle, 'Imported v1 edit')
  await assert.rejects(service.patch(admin, { workers: { qc: { maxItemsPerExecution: 1 } } }, imported.etag),
    error => error.name === 'SettingsValidationError')
  const upgraded = await service.patch(admin, { schemaVersion: 2 }, imported.etag)
  assert.equal(upgraded.settings.schemaVersion, 2)
  assert.ok(upgraded.settings.ai.tasks.qcPlan)
  assert.ok(upgraded.settings.processing.qc)
  assert.ok(upgraded.settings.workers.qc)
  for (const [task, binding] of Object.entries(original.settings.ai.tasks)) assert.deepEqual(upgraded.settings.ai.tasks[task], binding)
  const acceptedQc = await service.capture(), acceptedQcHash = rawHash(acceptedQc)
  const beforeStaleRestore = revisions.size
  await assert.rejects(service.restore(admin, original.revision, imported.etag), error => error.status === 409)
  assert.equal(revisions.size, beforeStaleRestore)
  const restored = await service.restore(admin, original.revision, upgraded.etag)
  assertV1(restored.settings)
  assert.equal(rawHash(restored.settings), legacyV1Capture.policySha256)
  assert.notEqual(restored.revision, original.revision)
  assert.equal(revisions.get(restored.revision).reason, 'restore')
  assert.equal(revisions.get(restored.revision).restoredFrom, original.revision)
  const upgradedAgain = await service.patch(admin, { schemaVersion: 2 }, restored.etag)
  const legacyPreview = await service.previewImport(exported, upgradedAgain.etag)
  assertV1(legacyPreview.settings)
  const restoredByImport = await service.applyImport(admin, exported, upgradedAgain.etag, true)
  assertV1(restoredByImport.settings)
  assert.equal(rawHash(restoredByImport.settings), legacyV1Capture.policySha256)
  assert.equal(rawHash(await service.captureLegacy()), legacyV1Capture.snapshotSha256)
  assert.equal(rawHash(api.validateProcessingSettings(accepted)), legacyV1Capture.snapshotSha256)
  assert.equal(rawHash(api.validateProcessingSettings(acceptedQc)), acceptedQcHash)
  assert.equal(rawHash(original), legacyV1Capture.snapshotSha256)
  for (const [id, expected] of immutableHashes) assert.equal(rawHash(revisions.get(id)), expected)
})

test('the dedicated QC task/policies require complete version-2 capture and permit explicit bounded administrative upgrade', () => {
  const legacy = legacySettings()
  const deployment = { ...clone(legacy.ai.deployments[0]), id: 'qc-planning', deploymentName: 'qc-planning-model', label: 'QC planning' }
  assert.equal(api.mergeAdminSettings(legacy, { appearance: { applicationTitle: 'Changed title' } }).schemaVersion, 1)
  const current = api.mergeAdminSettings(legacy, {
    schemaVersion: 2, ai: { deployments: [...legacy.ai.deployments, deployment],
      tasks: { qcPlan: { deploymentId: deployment.id, reasoningEffort: 'high', completionTokenLimit: 4096 } } },
    processing: { qc: { maxAutomaticAttempts: 2 } }, workers: { qc: { maxItemsPerExecution: 1 } },
  })
  assert.equal(current.schemaVersion, 2)
  assert.equal(current.ai.tasks.qcPlan.completionTokenLimit, 4096)
  assert.equal(current.processing.qc.maxAutomaticAttempts, 2)
  assert.equal(current.workers.qc.maxItemsPerExecution, 1)
  assert.deepEqual(current.processing.analyses, legacy.processing.analyses)
  assert.deepEqual(current.workers.analyses, legacy.workers.analyses)
  assert.deepEqual(current.ai.tasks.assessment, legacy.ai.tasks.assessment)
  assert.equal(api.resolveTaskModel(current, 'qcPlan').deploymentName, deployment.deploymentName)
  assert.equal(api.resolveTaskModel(current, 'qcPlan').reasoningEffort, 'high')
  assert.equal(api.resolveTaskModel(current, 'assessment').deploymentName, legacy.ai.deployments[0].deploymentName)
  assert.equal(legacy.schemaVersion, 1)
  assert.equal(legacy.ai.tasks.qcPlan, undefined)
  assert.throws(() => api.parseAdminSettings({ ...current, schemaVersion: 1 }))
  const incomplete = clone(current)
  delete incomplete.ai.tasks.qcPlan
  assert.throws(() => api.parseAdminSettings(incomplete))
  assert.throws(() => api.mergeAdminSettings(current, { workers: { qc: { maxItemsPerExecution: 11 } } }))
  assert.throws(() => api.mergeAdminSettings(current, { ai: { tasks: { qcPlan: { completionTokenLimit: 16_385 } } } }))
  const captured = clone(api.captureProcessingSettings(current, 'qc-policy-v2', '2026-10-01T00:00:00.000Z'))
  for (const [task, binding] of Object.entries(legacyV1Snapshot().tasks)) assert.deepEqual(captured.tasks[task], binding)
  delete captured.tasks.qcPlan
  assert.equal(api.processingSettingsSnapshotSchema.safeParse(captured).success, false)
  assert.equal(rawHash(legacy), legacyV1Capture.policySha256)
})

test('QC policy upgrades and exact private candidates retain every accepted prompt pin through API and worker reconstruction', async () => {
  const legacy = legacyV1Snapshot(), pins = api.createCompiledPromptBaseline(legacy.capturedAt)
  const pinned = api.captureProcessingSettings(legacy.settings, legacy.revision, legacy.capturedAt, pins)
  const upgraded = api.captureQcProcessingSettings(pinned)
  assert.equal(pinned.schemaVersion, 2)
  assert.equal(pinned.settings.schemaVersion, 1)
  assert.equal(upgraded.schemaVersion, 2)
  assert.equal(upgraded.settings.schemaVersion, 2)
  assert.equal(rawHash(pinned.settings), legacyV1Capture.policySha256)
  assert.equal(rawHash(upgraded.promptBundle), rawHash(pins))
  for (const [task, binding] of Object.entries(legacy.tasks)) assert.deepEqual(upgraded.tasks[task], binding)
  const oldPolicy = clone(upgraded.settings)
  oldPolicy.schemaVersion = 1
  delete oldPolicy.ai.tasks.qcPlan
  delete oldPolicy.processing.qc
  delete oldPolicy.workers.qc
  assert.equal(rawHash(oldPolicy), legacyV1Capture.policySha256)
  const { tenantId, oid } = principal('reviewer')
  for (const baseline of [pinned, upgraded]) {
    const candidate = api.createPromptCandidateSettings(baseline, {
      assessment: 'Explain documentary scope and explicit responsibility before choosing the existing saved anchor.',
    }, { tenantId, oid }, '2026-09-22T00:00:00.000Z', `qc-pinned-v${baseline.settings.schemaVersion}`)
    assert.equal(rawHash(candidate.settings), rawHash(baseline.settings))
    assert.equal(rawHash(candidate.tasks), rawHash(baseline.tasks))
    assert.equal(candidate.revision, legacy.revision)
    assert.equal(candidate.capturedAt, legacy.capturedAt)
    assert.notEqual(candidate.promptBundle.bundle.bundleSha256, baseline.promptBundle.bundle.bundleSha256)
    assert.equal(JSON.stringify(candidate), JSON.stringify({ ...baseline, promptBundle: candidate.promptBundle }))
    for (const snapshot of [baseline, candidate]) {
      const original = JSON.stringify(snapshot), req = {}
      const fail = () => assert.fail('An accepted prompt capture cannot resolve mutable current settings or prompts')
      api.attachSettingsContext({ settings: { runtimeEnabled: false } }, { capture: fail, captureLegacy: fail })(req, {}, () => {})
      const retained = [
        api.processingSettingsSnapshotSchema.parse(clone(snapshot)),
        api.captureProcessingSettings(snapshot.settings, snapshot.revision, snapshot.capturedAt, snapshot.promptBundle),
        api.validateProcessingSettings(clone(snapshot)),
        api.operationSettings({ processingSettings: clone(snapshot) }, { settings: { get legacy() { return fail() }, current: fail } }),
        await api.getSettingsForAcceptedWork(req, clone(snapshot)),
      ]
      for (const value of retained) {
        assert.equal(JSON.stringify(value), original)
        assert.equal(rawHash(value), rawHash(snapshot))
        assert.equal(rawHash(value.settings), rawHash(snapshot.settings))
        assert.equal(rawHash(value.promptBundle), rawHash(snapshot.promptBundle))
      }
    }
  }
  assert.equal(rawHash(legacy), legacyV1Capture.snapshotSha256)
})

test('new QC plans upgrade legacy live policy copies without rewriting older accepted analyses or requiring a silent global migration', async () => {
  const f = await qcFixture()
  f.settings = api.captureProcessingSettings(legacySettings(), 'historical-live-config', f.now)
  const old = clone(f.settings), analyses = clone([...f.analysis.store.values])
  let detail = await submittedPlan(f)
  assert.equal(detail.plan.processingSettings.settings.schemaVersion, 2)
  assert.equal(detail.plan.processingSettings.tasks.qcPlan.taskId, 'qcPlan')
  assert.deepEqual(f.settings, old)
  detail = await f.plans.edit(f.caller('reviewer'), detail.plan.id, { proposal: proposal(detail.plan) }, randomUUID(), detail.etag)
  detail = await f.plans.request(f.caller('reviewer'), detail.plan.id, 'evaluation', randomUUID(), detail.etag)
  await api.runQcWorker({ ...f.qc, clock: f.clock, model: {}, async trial(entry, _family, settings) {
    const saved = entry.analysis.result
    const assessment = { criteria: saved.criteria, qualifications: saved.qualifications, summary: saved.summary, limitations: saved.limitations }
    return {
      trial: { status: 'complete', error: null, assessment, findings: [], ...api.qcAssessmentMetrics(entry, assessment.criteria),
        summary: { completion: saved.completion, overall: saved.overall, coverage: saved.coverage } },
      models: { assessment: settings.tasks.assessment.modelName, assessmentReview: settings.tasks.assessmentReview.modelName },
    }
  } })
  detail = await f.plans.detail(f.caller('admin'), detail.plan.id)
  assert.equal(detail.plan.status, 'ready')
  assert.equal((await f.plans.activate(f.caller('admin'), principal('admin'), detail.plan.id,
    { reason: 'The same explicitly upgraded QC policy and original model bindings were evaluated.', confirm: true }, randomUUID(), detail.etag)).plan.status, 'activated')
  assert.deepEqual(f.settings, old)
  assert.deepEqual([...f.analysis.store.values], analyses)
})
