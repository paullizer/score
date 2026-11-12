import assert from 'node:assert/strict'
import test from 'node:test'
import {
  api, qcFixture, qcHttp, principal, submittedPlan, queueAssessmentEvaluation, completeAssessmentTrial,
} from './qc.test-support.mjs'

async function evaluatedFixture() {
  const f = await qcFixture(2)
  const requested = await queueAssessmentEvaluation(f)
  const result = await api.runQcWorker({
    ...f.qc, clock: f.clock, trial: completeAssessmentTrial,
    model: {
      endpoint: 'https://score-unit.openai.azure.com', deployment: 'unit', modelName: 'unit',
      async getToken() { assert.fail('Pipeline tests never need provider credentials') },
      async fetch() { assert.fail('Pipeline tests never call a model') },
    },
  })
  assert.equal(result.completed, 1)
  return { f, plan: (await f.qc.store.get(f.workspaceId, requested.plan.id)).record }
}

test('pipeline reads project saved pins without exposing content, marking peers or reading case packs', async t => {
  const f = await qcFixture()
  const saved = await submittedPlan(f)
  const before = structuredClone([...f.qc.store.values])
  const sourceRecords = structuredClone([...f.analysis.store.values])
  f.qc.blobs.read = async () => assert.fail('A draft map never reads source or case-pack artifacts')
  const server = await qcHttp(f)
  t.after(() => server.close())
  const page = await server.pipeline()
  assert.equal(page.status, 200)
  assert.match(page.headers.get('cache-control'), /private.*no-store/)
  const body = await page.json()
  assert.equal(body.items.length, 1)
  assert.deepEqual(Object.keys(body.items[0]).sort(), ['id', 'name', 'revision', 'status', 'updatedAt', 'workspaceId'])
  const response = await server.pipeline(`/${saved.plan.id}`)
  assert.equal(response.status, 200)
  const detail = await response.json()
  assert.equal(detail.plan.id, saved.plan.id)
  assert.equal(detail.casePackSha256, saved.plan.casePack.sha256)
  assert.deepEqual(detail.cases[0].scope, saved.plan.cases[0].scope)
  assert.equal(detail.baseline.id, saved.plan.baseline.revision)
  assert.equal(detail.candidate, null)
  assert.equal(detail.evaluation, null)
  assert.equal(detail.tasks.length, 4)
  for (const key of ['objective', 'feedback', 'proposal', 'guidance', 'author', 'processingSettings', 'note', 'referenceDecisions']) {
    assert.doesNotMatch(JSON.stringify(detail), new RegExp(`"${key}":`), `private ${key} is not projected`)
  }
  assert.deepEqual([...f.qc.store.values], before, 'Map reads do not create peer-exposure or audit writes')
  assert.deepEqual([...f.analysis.store.values], sourceRecords)
})

test('pipeline requires application admin, explicit QC membership and the application origin', async t => {
  const f = await qcFixture()
  const saved = await submittedPlan(f)
  const server = await qcHttp(f)
  t.after(() => server.close())
  for (const role of ['owner', 'reviewer', 'viewer', 'stranger']) {
    const response = await server.pipeline(`/${saved.plan.id}`, role)
    assert.ok([403, 404].includes(response.status), `${role} does not gain access`)
  }
  const crossSite = await server.pipeline('', 'admin', { 'Sec-Fetch-Site': 'cross-site' })
  assert.equal(crossSite.status, 403)
  const foreignOrigin = await server.pipeline('', 'admin', { Origin: 'https://foreign.example.test' })
  assert.equal(foreignOrigin.status, 403)
  const foreignTenant = await server.pipeline('', 'admin', {
    'x-ms-client-principal': Buffer.from(JSON.stringify({ claims: [
      { typ: 'tid', val: '11111111-1111-4111-8111-111111111111' },
      { typ: 'oid', val: principal('admin').oid }, { typ: 'roles', val: 'Score.Admin' },
    ] })).toString('base64'),
  })
  assert.ok([401, 403].includes(foreignTenant.status), 'An administrator in another tenant is not admitted')
  for (const suffix of ['?limit=51', '?limit=0', '?limit=1&extra=true', `/${saved.plan.id}?extra=true`]) {
    const response = await server.pipeline(suffix)
    assert.equal(response.status, 400, suffix)
  }
})

test('pipeline pages are scoped and bounded; history survives paused admission and archive', async t => {
  const f = await qcFixture()
  await submittedPlan(f)
  await submittedPlan(f)
  const server = await qcHttp(f)
  t.after(() => server.close())
  server.setAdmissionEnabled(false)
  server.archive()
  const first = await server.pipeline('?limit=1')
  assert.equal(first.status, 200)
  const page = await first.json()
  assert.equal(page.items.length, 1)
  assert.ok(page.continuationToken)
  const next = await server.pipeline(`?limit=1&${new URLSearchParams({ continuationToken: page.continuationToken })}`)
  assert.equal(next.status, 200)
  const nextPage = await next.json()
  assert.equal(nextPage.items.length, 1)
  assert.notEqual(page.items[0].id, nextPage.items[0].id)
  const foreign = await new api.QualityPipelineService(f.base).list({ ...f.caller('admin'), workspaceId: 'other-workspace' }, { limit: 1 })
  assert.equal(foreign.items.length, 0)
})

test('selected pipeline validates the exact evaluation and returns metadata, not trial outputs', async t => {
  const { f, plan } = await evaluatedFixture()
  const before = structuredClone([...f.qc.store.values])
  const sourceRead = f.qc.blobs.read.bind(f.qc.blobs)
  const reads = []
  f.qc.blobs.read = async reference => {
    reads.push(reference.name)
    assert.notEqual(reference.name, plan.casePack.name, 'The map must not read the case pack')
    return sourceRead(reference)
  }
  const server = await qcHttp(f)
  t.after(() => server.close())
  const response = await server.pipeline(`/${plan.id}`)
  assert.equal(response.status, 200)
  const detail = await response.json()
  assert.equal(detail.evaluation.eligibleAtCompletion, true)
  assert.equal(detail.evaluation.holdoutTrials, 1)
  assert.equal(detail.evaluation.trials, 2)
  assert.equal(detail.evaluation.sha256, plan.evaluation.sha256)
  assert.ok(detail.candidate.id)
  assert.match(detail.candidate.sha256, /^[a-f0-9]{64}$/)
  assert.equal(detail.activatedBundleId, null, 'Completed evaluation is not activation')
  assert.deepEqual(detail.changedFamilies, ['assessment'])
  assert.deepEqual(reads, [plan.evaluation.name])
  assert.doesNotMatch(JSON.stringify(detail), /"assessment":|"findings":|"rationale":|"criteria":|"guidance":/)
  assert.deepEqual([...f.qc.store.values], before)
})

for (const fault of ['membership', 'admin', 'plan', 'run']) {
  test(`pipeline rechecks ${fault} after reading a selected artifact`, async t => {
    const { f, plan } = await evaluatedFixture()
    const server = await qcHttp(f)
    t.after(() => server.close())
    const read = f.qc.blobs.read.bind(f.qc.blobs)
    f.qc.blobs.read = async reference => {
      const bytes = await read(reference)
      if (fault === 'membership') server.memberships.delete(api.membershipIdFor(principal('admin').principalKey))
      else if (fault === 'admin') server.setApplicationRoles('admin', ['Score.User'])
      else if (fault === 'plan') f.qc.store.save(plan)
      else f.qc.store.save({
        id: api.qcControlId(plan.cases[0].scope.runId), recordType: 'qc-control', workspaceId: f.workspaceId,
        runId: plan.cases[0].scope.runId, state: 'deleting', createdAt: f.now, updatedAt: f.now,
      })
      return bytes
    }
    const response = await server.pipeline(`/${plan.id}`)
    assert.ok([403, 404, 409].includes(response.status), `The changed ${fault} guard must refuse the response`)
    assert.equal((await response.json()).plan, undefined)
  })
}

test('pipeline rejects corrupt evaluation evidence or missing declared work instead of substituting defaults', async t => {
  const { f, plan } = await evaluatedFixture()
  const server = await qcHttp(f)
  t.after(() => server.close())
  const read = f.qc.blobs.read.bind(f.qc.blobs)
  f.qc.blobs.read = async () => new TextEncoder().encode('{}')
  const response = await server.pipeline(`/${plan.id}`)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).plan, undefined)
  f.qc.blobs.read = read
  f.qc.store.values.delete(`${f.workspaceId}/${plan.workId}`)
  const missingWork = await server.pipeline(`/${plan.id}`)
  assert.equal(missingWork.status, 503)
  assert.equal((await missingWork.json()).plan, undefined)
})
