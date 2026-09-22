import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, qcFixture, qcHttp, principal, completeAssessmentTrial, queueAssessmentEvaluation,
} from './qc.test-support.mjs'

async function evaluated() {
  const f = await qcFixture()
  const requested = await queueAssessmentEvaluation(f)
  const result = await api.runQcWorker({
    ...f.qc, clock: f.clock, trial: completeAssessmentTrial,
    model: {
      endpoint: 'https://score-unit.openai.azure.com', deployment: 'unit', modelName: 'unit',
      async getToken() { assert.fail('Injected trials do not need a provider token') },
      async fetch() { assert.fail('Publication tests never call a real model') },
    },
  })
  assert.equal(result.completed, 1)
  const ready = await f.plans.detail(f.caller('admin'), requested.plan.id)
  assert.equal(ready.evaluation.eligible, true)
  return { f, ready }
}

function afterLastRegistryRead(f, fault) {
  const commit = f.registryStore.activate.bind(f.registryStore)
  let called = false
  f.registryStore.activate = async (bundle, activation, expected, guard) => {
    await f.registryStore.getCurrent()
    called = true
    await fault()
    assert.equal(typeof guard, 'function', 'QC must supply the registry final-CAS publication guard')
    await guard()
    return commit(bundle, activation, expected)
  }
  return () => called
}

test('authorized HTTP activation and source-workspace rollback preserve production evidence', async t => {
  const { f, ready } = await evaluated()
  const sourceRecords = structuredClone([...f.analysis.store.values])
  const sourceBlobs = structuredClone([...f.analysis.blobs.values])
  const server = await qcHttp(f)
  t.after(() => server.close())
  const response = await server.request(`/plans/${ready.plan.id}/activate`, 'POST',
    { reason: 'Approve the exact evaluated candidate.', confirm: true }, 'admin', { 'If-Match': ready.etag })
  assert.equal(response.status, 200)
  const activated = await response.json()
  assert.equal(activated.plan.status, 'activated')
  for (const revision of [ready.plan.baseline.revision, activated.plan.activatedRevision]) {
    const currentResponse = await server.request('/prompts', 'GET', undefined, 'admin')
    assert.equal(currentResponse.status, 200)
    const current = await currentResponse.json()
    const restored = await server.request('/prompts/restore', 'POST',
      { revision, reason: 'Restore this previously approved compatible release.', confirm: true },
      'admin', { 'If-Match': current.etag })
    assert.equal(restored.status, 200)
    assert.equal((await restored.json()).revision, revision)
  }
  assert.equal(f.registryStore.activations.length, 4)
  assert.deepEqual([...f.analysis.store.values], sourceRecords)
  assert.deepEqual([...f.analysis.blobs.values], sourceBlobs)
})

for (const action of ['activate', 'restore']) {
  for (const fault of ['membership', 'admin', 'workspace', 'admission']) {
    test(`${action} reauthorizes ${fault} after the registry final read`, async t => {
      const { f, ready } = await evaluated()
      if (action === 'restore') {
        await f.plans.activate(f.caller('admin'), principal('admin'), ready.plan.id,
          { reason: 'Approve the evaluated release.', confirm: true }, randomUUID(), ready.etag)
      }
      const admins = new Set([principal('admin').oid])
      const server = await qcHttp(f, { adminUserIds: admins })
      t.after(() => server.close())
      const before = await f.prompts.current()
      const count = f.registryStore.activations.length
      const reached = afterLastRegistryRead(f, async () => {
        if (fault === 'membership') server.memberships.delete(api.membershipIdFor(principal('admin').principalKey))
        else if (fault === 'admin') admins.clear()
        else if (fault === 'workspace') server.archive()
        else server.setAdmissionEnabled(false)
      })
      const response = await server.request(action === 'activate' ? `/plans/${ready.plan.id}/activate` : '/prompts/restore',
        'POST', { reason: 'Do not publish after the authorization fence changes.', confirm: true,
          ...(action === 'restore' ? { revision: ready.plan.baseline.revision } : {}) },
        'admin', { 'If-Match': action === 'activate' ? ready.etag : before.etag })
      assert.equal(reached(), true)
      assert.ok([403, 404, 409, 503].includes(response.status), `${fault}: ${response.status}`)
      assert.equal((await f.prompts.current()).bundle.bundleId, before.bundle.bundleId)
      assert.equal(f.registryStore.activations.length, count)
    })
  }
}

for (const fault of ['run', 'plan', 'settings']) {
  test(`activation rechecks ${fault} bindings at the final registry handoff`, async () => {
    const { f, ready } = await evaluated()
    const before = await f.prompts.current()
    const reached = afterLastRegistryRead(f, async () => {
      if (fault === 'run') await api.setQcRunState(f.qc, f.workspaceId, ready.plan.cases[0].scope.runId, 'archived', f.now)
      else if (fault === 'plan') f.qc.store.save(ready.plan)
      else {
        const settings = structuredClone(f.settings.settings)
        settings.analyses.maxOutputCorrections = 1
        f.settings = api.captureProcessingSettings(settings, 'qc-settings-changed', f.now, f.settings.promptBundle)
      }
    })
    await assert.rejects(f.plans.activate(f.caller('admin'), principal('admin'), ready.plan.id,
      { reason: 'Require the exact evaluated bindings.', confirm: true }, randomUUID(), ready.etag),
    error => error.status === 409)
    assert.equal(reached(), true)
    assert.equal((await f.prompts.current()).bundle.bundleId, before.bundle.bundleId)
    assert.equal(f.registryStore.activations.length, 1)
  })
}

test('restoring an evaluated release requires its source workspace and a live exact source evaluation', async () => {
  const { f, ready } = await evaluated()
  const activated = await f.plans.activate(f.caller('admin'), principal('admin'), ready.plan.id,
    { reason: 'Approve the evaluated release.', confirm: true }, randomUUID(), ready.etag)
  let current = await f.prompts.current()
  await f.plans.restore(f.caller('admin'), principal('admin'),
    { revision: ready.plan.baseline.revision, reason: 'Return to the compatible baseline.', confirm: true }, randomUUID(), current.etag)
  current = await f.prompts.current()
  const restore = { revision: activated.plan.activatedRevision, reason: 'Restore the prior evaluated release.', confirm: true }
  const otherWorkspace = f.workspaceId.slice(0, -1) + (f.workspaceId.endsWith('0') ? '1' : '0')
  await assert.rejects(f.plans.restore({ ...f.caller('admin'), workspaceId: otherWorkspace }, principal('admin'),
    restore, randomUUID(), current.etag), error => error.status === 409)
  const count = f.registryStore.activations.length
  const reached = afterLastRegistryRead(f, () =>
    api.setQcRunState(f.qc, f.workspaceId, ready.plan.cases[0].scope.runId, 'archived', f.now))
  await assert.rejects(f.plans.restore(f.caller('admin'), principal('admin'),
    restore, randomUUID(), current.etag), error => error.status === 409)
  assert.equal(reached(), true)
  assert.equal(f.registryStore.activations.length, count)
  assert.equal((await f.prompts.current()).bundle.bundleId, ready.plan.baseline.revision)
})
