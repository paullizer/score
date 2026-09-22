import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { api, analysisApi, qcFixture, feedback, submittedPlan, proposal, qcHttp, principal, clone } from './qc.test-support.mjs'
import { reviewedCorrection } from './analysis-corrections.test-support.mjs'
import { ACTOR, createRun, publishResult } from './real-analyses.test-support.mjs'

const http = expected => error => error.status === expected
test('drafts retain incomplete rows, but explicit complete submissions and valid frozen IDs are required', async () => {
  const f = await qcFixture(), caller = f.caller('reviewer'), context = f.contexts[0]
  const incomplete = feedback(context, 'disagree')
  incomplete.feedback[0].reason = ''
  incomplete.feedback[0].recommendation = null
  const draft = await f.base.saveReview(caller, incomplete, randomUUID())
  assert.equal(draft.record.submittedId, null)
  await assert.rejects(f.base.saveReview(caller, incomplete, randomUUID(), draft.etag, true), http(400))
  await assert.rejects(f.base.saveReview(caller, { ...feedback(context), author: principal('owner') }, randomUUID(), draft.etag), http(400))
  const foreign = feedback(context)
  foreign.feedback[0].criterionId = 'foreign-criterion'
  await assert.rejects(f.base.saveReview(caller, foreign, randomUUID(), draft.etag), http(409))
  const invalidLink = feedback(context)
  invalidLink.feedback[0].evidenceParagraphIds = ['foreign-paragraph']
  await assert.rejects(f.base.saveReview(caller, invalidLink, randomUUID(), draft.etag), http(409))
  const submitted = await f.base.saveReview(caller, feedback(context, 'disagree', 0), randomUUID(), draft.etag, true)
  assert.equal(submitted.record.feedback[0].recommendation.score, 0)
  assert.equal(submitted.record.submissionNumber, 1)
  assert.equal((await f.base.reviewHistory(caller, context.scope, {})).items.length, 1)
})

test('HTTP PUT persists incomplete disagreement drafts while POST submission remains strict', async t => {
  const f = await qcFixture(), server = await qcHttp(f)
  t.after(() => server.close())
  const input = feedback(f.contexts[0], 'disagree')
  input.feedback[0].reason = ''
  input.feedback[0].recommendation = null
  const response = await server.request('/reviews', 'PUT', input, 'reviewer', { 'If-None-Match': '*' })
  assert.equal(response.status, 200)
  const draft = await response.json()
  assert.equal(draft.record.feedback[0].reason, '')
  assert.equal(draft.record.feedback[0].recommendation, null)
  assert.equal(draft.record.submittedId, null)
  assert.equal(response.headers.get('etag'), draft.etag)
  assert.equal((await server.request('/reviews/submit', 'POST', input, 'reviewer', { 'If-Match': draft.etag })).status, 400)
  input.feedback[0].reason = 'The documented work does not support the recorded anchor.'
  input.feedback[0].recommendation = { kind: 'score', score: 0 }
  const submitted = await server.request('/reviews/submit', 'POST', input, 'reviewer', { 'If-Match': draft.etag })
  assert.equal(submitted.status, 200)
  assert.equal((await submitted.json()).record.submissionNumber, 1)
})

test('separate immutable reviewer opinions, server peer blinding and latest-per-reviewer aggregation', async () => {
  const f = await qcFixture(), context = f.contexts[0], first = f.caller('reviewer'), second = f.caller('second')
  const saved = await f.base.saveReview(first, feedback(context), randomUUID(), undefined, true)
  await assert.rejects(f.base.peers(second, context.scope, randomUUID()), http(403))
  assert.equal((await f.base.reviewHistory(second, context.scope, {})).items.length, 0)
  const secondSaved = await f.base.saveReview(second, feedback(context, 'disagree', 0), randomUUID(), undefined, true)
  let peers = await f.base.peers(first, context.scope, randomUUID())
  assert.equal(peers.submissions.length, 2)
  assert.ok(peers.submissions.every(value => value.peerIndependent))
  const exposed = await f.base.head(first, context.scope)
  await assert.rejects(f.base.saveReview(first, feedback(context), randomUUID(), saved.etag, true), http(409))
  await f.base.saveReview(first, feedback(context, 'disagree', 2), randomUUID(), exposed.etag, true)
  peers = await f.base.peers(first, context.scope, randomUUID())
  assert.equal(peers.submissions.length, 2)
  assert.equal(peers.submissions.find(value => value.author.principalId === first.actor.principalId).peerIndependent, false)
  assert.equal(peers.submissions.find(value => value.author.principalId === second.actor.principalId).id, secondSaved.record.submittedId)
  assert.equal((await f.base.reviewHistory(first, context.scope, {})).items.length, 2)
  const owner = f.caller('owner')
  const coordinator = await f.base.saveReview(owner, feedback(context), randomUUID(), undefined, true)
  const ownerSubmission = await f.base.get(f.workspaceId, coordinator.record.submittedId, 'qc-submission')
  assert.equal(ownerSubmission.record.peerIndependent, false)
})

test('exact result hashes and historical sidecars do not rewrite production evidence or unlock a new result', async () => {
  const f = await qcFixture(), caller = f.caller('reviewer'), context = f.contexts[0]
  const original = clone([...f.analysis.store.values]), blobs = clone([...f.analysis.blobs.values])
  assert.equal(context.diagnostics.status, 'not-recorded')
  await f.base.saveReview(caller, feedback(context), randomUUID(), undefined, true)
  const changed = { ...context.scope, resultSha256: 'a'.repeat(64) }
  assert.equal(await f.base.canSeePeers(caller, changed), false)
  await assert.rejects(f.base.saveReview(caller, { ...feedback(context), scope: changed }, randomUUID()), http(409))
  const historical = await f.base.context(caller, context.scope.runId, context.scope.comparisonId, 'original')
  assert.equal(historical.scope.resultSha256, context.scope.resultSha256)
  assert.deepEqual([...f.analysis.store.values], original)
  assert.deepEqual([...f.analysis.blobs.values], blobs)
})

test('ETag fences preserve edits, idempotent submissions survive lost acknowledgements and payload reuse fails', async () => {
  const f = await qcFixture(), caller = f.caller('reviewer'), context = f.contexts[0]
  const draft = await f.base.saveReview(caller, { ...feedback(context), feedback: [] }, randomUUID())
  const key = randomUUID()
  f.qc.store.afterCommit = async () => { throw new Error('Connection lost after durable commit') }
  await assert.rejects(f.base.saveReview(caller, feedback(context), key, draft.etag, true))
  const retried = await f.base.saveReview(caller, feedback(context), key, draft.etag, true)
  assert.equal(retried.record.submissionNumber, 1)
  assert.equal((await f.base.reviewHistory(caller, context.scope, {})).items.length, 1)
  await assert.rejects(f.base.saveReview(caller, feedback(context, 'disagree', 0), key, retried.etag, true), http(409))
  const results = await Promise.allSettled([
    f.base.saveReview(caller, feedback(context), randomUUID(), retried.etag),
    f.base.saveReview(caller, feedback(context, 'disagree', 1), randomUUID(), retried.etag),
  ])
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(results.filter(value => value.status === 'rejected').length, 1)
})

test('pagination tokens bind exact workspace, author, result and limits', async () => {
  const f = await qcFixture(), context = f.contexts[0], caller = f.caller('reviewer')
  let head
  for (let revision = 0; revision < 3; revision++) head = await f.base.saveReview(caller, feedback(context), randomUUID(), head?.etag, true)
  const page = await f.base.reviewHistory(caller, context.scope, { limit: 1 })
  assert.ok(page.continuationToken)
  assert.equal((await f.base.reviewHistory(caller, context.scope, { limit: 1, continuationToken: page.continuationToken })).items.length, 1)
  await assert.rejects(f.base.reviewHistory(f.caller('second'), context.scope, { limit: 1, continuationToken: page.continuationToken }), http(400))
  await assert.rejects(f.base.reviewHistory(caller, context.scope, { limit: 2, continuationToken: page.continuationToken }), http(400))
})

test('plan creation, lists, history and evaluation details cannot bypass any selected peer gate', async () => {
  const f = await qcFixture(2)
  const created = await submittedPlan(f, { holdout: true })
  const second = f.caller('second')
  await f.base.saveReview(second, feedback(f.contexts[0]), randomUUID(), undefined, true)
  await assert.rejects(f.plans.detail(second, created.plan.id), http(403))
  await assert.rejects(f.plans.history(second, created.plan.id, {}), http(403))
  assert.equal((await f.plans.list(second, {})).items.length, 0)
  await assert.rejects(f.plans.create(second, {
    name: 'Peer leak', objective: 'Collect unauthorized feedback', cases: created.plan.cases, excludedFeedback: [],
  }, randomUUID()), http(403))
  await f.base.saveReview(second, feedback(f.contexts[1]), randomUUID(), undefined, true)
  assert.equal((await f.plans.detail(second, created.plan.id)).canEdit, false)
  await assert.rejects(f.plans.edit(second, created.plan.id, { proposal: proposal(created.plan) }, randomUUID(), created.etag), http(403))
  assert.ok((await f.base.head(second, f.contexts[1].scope)).record.peerExposedAt)
  const changed = await f.plans.edit(f.caller('reviewer'), created.plan.id, { proposal: proposal(created.plan) }, randomUUID(), created.etag)
  assert.equal(changed.plan.revision, 2)
  assert.equal((await f.plans.history(f.caller('reviewer'), changed.plan.id, {})).items.length, 2)
})

test('foreign references, duplicate reviewers, excluded feedback overlaps, and holdout citations fail closed', async () => {
  const f = await qcFixture(2), created = await submittedPlan(f, { holdout: true })
  const candidate = proposal(created.plan)
  candidate.findings[0].reviewIds = [created.plan.cases[1].reviewIds[0]]
  await assert.rejects(f.plans.edit(f.caller('reviewer'), created.plan.id, { proposal: candidate }, randomUUID(), created.etag))
  candidate.findings[0].reviewIds = created.plan.cases[0].reviewIds
  candidate.changes[0].guidance = `Always prefer ${f.contexts[0].analysis.resumeSnapshot.resume.name}.`
  await assert.rejects(f.plans.edit(f.caller('reviewer'), created.plan.id, { proposal: candidate }, randomUUID(), created.etag), http(400))
  const source = f.contexts[0].analysis.targetSnapshot.document
  candidate.changes[0].guidance = `Use the case-specific source ${source.id} as the application-wide target.`
  await assert.rejects(f.plans.edit(f.caller('reviewer'), created.plan.id, { proposal: candidate }, randomUUID(), created.etag), http(400))
  const quotation = source.paragraphs.find(paragraph => paragraph.text.length >= 60)
  assert.ok(quotation)
  candidate.changes[0].guidance = `Use this private source wording in future cases: ${quotation.text}`
  await assert.rejects(f.plans.edit(f.caller('reviewer'), created.plan.id, { proposal: candidate }, randomUUID(), created.etag), http(400))
  const request = { name: 'Duplicated selected feedback', objective: 'No invented consensus', cases: clone(created.plan.cases), excludedFeedback: [] }
  const head = await f.base.head(f.caller('reviewer'), f.contexts[0].scope)
  const secondRevision = await f.base.saveReview(f.caller('reviewer'), feedback(f.contexts[0]), randomUUID(), head.etag, true)
  request.cases[0].reviewIds.push(secondRevision.record.submittedId)
  await assert.rejects(f.plans.create(f.caller('reviewer'), request, randomUUID()), http(400))
})

test('plan details project exact compatible paired trials and unsupported families before paid admission', async () => {
  for (const kind of ['job', 'grade']) {
    const f = await qcFixture(2, {}, kind)
    let detail = await submittedPlan(f, { holdout: true })
    assert.equal(detail.trialScope, undefined)
    const changed = proposal(detail.plan)
    changed.changes = api.QC_PROMPT_FAMILIES.map(familyId => ({ ...changed.changes[0], familyId }))
    detail = await f.plans.edit(f.caller('reviewer'), detail.plan.id, { proposal: changed }, randomUUID(), detail.etag)
    const supported = kind === 'job' ? ['jobRubric', 'assessment'] : ['gradeCompetencies', 'gradeDraft', 'assessment']
    const expected = detail.plan.cases.flatMap(selection => supported.map(familyId => ({
      scope: selection.scope, purpose: selection.purpose, familyId,
    })))
    assert.deepEqual(detail.trialScope.pairs, expected)
    assert.equal(detail.trialScope.baselineTrials, expected.length)
    assert.equal(detail.trialScope.candidateTrials, expected.length)
    assert.equal(detail.trialScope.pairs.filter(pair => pair.purpose === 'holdout').length, supported.length)
    assert.deepEqual(detail.trialScope.unsupportedFamilies, api.QC_PROMPT_FAMILIES.filter(familyId => !supported.includes(familyId)))
    await assert.rejects(f.plans.request(f.caller('reviewer'), detail.plan.id, 'evaluation', randomUUID(), detail.etag), http(400))
    assert.equal([...f.qc.store.values.values()].filter(value => value.record.recordType === 'qc-work').length, 0)
    changed.changes = changed.changes.filter(change => supported.includes(change.familyId))
    detail = await f.plans.edit(f.caller('reviewer'), detail.plan.id, { proposal: changed }, randomUUID(), detail.etag)
    const queued = await f.plans.request(f.caller('reviewer'), detail.plan.id, 'evaluation', randomUUID(), detail.etag)
    assert.deepEqual(queued.trialScope, { pairs: expected, baselineTrials: expected.length, candidateTrials: expected.length, unsupportedFamilies: [] })
  }
})

test('HTTP QC reauthorizes within the workspace lease and never grants membership-less administrators access', async t => {
  const f = await qcFixture(), server = await qcHttp(f)
  t.after(() => server.close())
  assert.equal((await server.request('/capabilities', 'GET', undefined, 'reviewer')).status, 200)
  assert.equal((await server.request('/capabilities', 'GET', undefined, 'viewer')).status, 403)
  assert.ok([403, 404].includes((await server.request('/capabilities', 'GET', undefined, 'stranger')).status))
  assert.equal((await server.request('/capabilities', 'GET', undefined, 'admin')).status, 200)
  const noCsrf = await server.request('/reviews', 'PUT', feedback(f.contexts[0]), 'reviewer', { 'x-score-request': '' })
  assert.equal(noCsrf.status, 403)
  const spoof = await server.request('/reviews', 'PUT', { ...feedback(f.contexts[0]), author: principal('owner') })
  assert.equal(spoof.status, 400)
  server.beforeLease(async () => { server.memberships.delete(api.membershipIdFor(principal('reviewer').principalKey)) })
  const revoked = await server.request('/reviews', 'PUT', feedback(f.contexts[0]))
  assert.ok([403, 404].includes(revoked.status))
  assert.equal([...f.qc.store.values.values()].filter(value => value.record.recordType === 'qc-review').length, 0)
})

test('HTTP paid QC admission projects cancellation for the plan owner and coordinators during queued and running work', async t => {
  const f = await qcFixture(), created = await submittedPlan(f), server = await qcHttp(f)
  t.after(() => server.close())
  await f.base.saveReview(f.caller('second'), feedback(f.contexts[0]), randomUUID(), undefined, true)
  const path = `/plans/${created.plan.id}`
  const response = await server.request(`${path}/draft`, 'POST', {}, 'reviewer', { 'If-Match': created.etag })
  assert.equal(response.status, 202)
  const queued = await response.json()
  assert.equal(queued.work.status, 'queued')
  assert.equal(queued.canCancel, true)
  assert.equal(queued.canEdit, false)
  for (const role of ['owner', 'admin']) {
    const detail = await (await server.request(path, 'GET', undefined, role)).json()
    assert.equal(detail.canCancel, true, role)
    assert.equal(detail.canEdit, false, role)
  }
  const other = await (await server.request(path, 'GET', undefined, 'second')).json()
  assert.equal(other.canCancel, false, 'An independent reviewer cannot cancel a plan they do not own')
  assert.equal((await server.request(`${path}/cancel`, 'POST', {}, 'second', { 'If-Match': queued.etag })).status, 403)
  const membershipId = api.membershipIdFor(principal('second').principalKey)
  server.memberships.set(membershipId, { ...server.memberships.get(membershipId), role: 'editor' })
  const outcome = await api.runQcWorker({
    ...f.qc, clock: f.clock,
    model: {
      endpoint: 'https://score-unit.openai.azure.com', deployment: 'unit', modelName: 'unit',
      async getToken() { assert.fail('The injected QC model must not acquire a real token') },
      async fetch() { assert.fail('The injected QC model must not make a real model request') },
    },
    async invoke() {
      for (const role of ['reviewer', 'owner', 'second', 'admin']) {
        const detail = await (await server.request(path, 'GET', undefined, role)).json()
        assert.equal(detail.work.status, 'running', role)
        assert.equal(detail.canEdit, false, role)
        assert.equal(detail.canCancel, true, role)
      }
      const detail = await (await server.request(path, 'GET', undefined, 'owner')).json()
      const cancelled = await server.request(`${path}/cancel`, 'POST', {}, 'owner', { 'If-Match': detail.etag })
      assert.equal(cancelled.status, 200)
      const stopped = await cancelled.json()
      assert.equal(stopped.work.status, 'cancelled')
      assert.equal(stopped.canCancel, false)
      return { content: JSON.stringify(proposal(created.plan)), model: 'unit-planner' }
    },
  })

  test('removing an Admin membership revokes every private QC surface but preserves ordinary workspace access', async t => {
    const f = await qcFixture(), server = await qcHttp(f)
    t.after(() => server.close())
    const scope = f.contexts[0].scope
    const contextPath = `/context?${new URLSearchParams({ runId: scope.runId, comparisonId: scope.comparisonId })}`
    assert.equal((await server.request(contextPath, 'GET', undefined, 'admin')).status, 200)
    const saved = await server.request('/reviews', 'PUT', feedback(f.contexts[0]), 'admin', { 'If-None-Match': '*' })
    assert.equal(saved.status, 200, 'An explicit Reader member Admin can save QC feedback')
    const before = clone([...f.qc.store.values])
    server.memberships.delete(api.membershipIdFor(principal('admin').principalKey))
    assert.equal(await server.repository.authorizeWorkspace(principal('admin'), f.workspaceId, 'write'), 'owner')
    for (const path of ['/capabilities', contextPath, '/prompts', '/prompts/history', '/plans', '/batches']) {
      assert.equal((await server.request(path, 'GET', undefined, 'admin')).status, 404, path)
    }
    assert.equal((await server.request('/peers', 'POST', scope, 'admin')).status, 404)
    assert.equal((await server.request('/reviews/submit', 'POST', feedback(f.contexts[0]), 'admin')).status, 404)
    assert.deepEqual([...f.qc.store.values], before, 'Revoked access cannot create feedback, exposure, or plan records')
  })
  assert.deepEqual(outcome, { claimed: 1, completed: 0, deferred: 0, stopped: 1 })
  const stopped = await (await server.request(path)).json()
  assert.equal(stopped.plan.status, 'cancelled')
  assert.equal(stopped.plan.revision, created.plan.revision)
})

test('HTTP QC fixture can explicitly retain the runtime rollout admission fence without hiding saved plans', async t => {
  const f = await qcFixture(), created = await submittedPlan(f)
  const server = await qcHttp(f, { settings: { runtimeEnabled: false } })
  t.after(() => server.close())
  const path = `/plans/${created.plan.id}`
  assert.equal((await server.request(path)).status, 200)
  const response = await server.request(`${path}/draft`, 'POST', {}, 'reviewer', { 'If-Match': created.etag })
  assert.equal(response.status, 503)
  assert.equal([...f.qc.store.values.values()].filter(value => value.record.recordType === 'qc-work').length, 0)
})

test('disabled QC admission preserves history, peer auditing, and cancellation while rejecting new mutations', async t => {
  for (const qcEnabled of [false, undefined]) {
    const f = await qcFixture(), created = await submittedPlan(f)
    const accepted = await f.plans.request(f.caller('reviewer'), created.plan.id, 'plan', randomUUID(), created.etag)
    const server = await qcHttp(f, { qcEnabled })
    t.after(() => server.close())
    const capabilities = await (await server.request('/capabilities')).json()
    assert.equal(capabilities.reviews, true)
    assert.equal(capabilities.admissionEnabled, false)
    assert.equal(capabilities.writable, true, 'Admission does not alter lifecycle writability or cancellation')
    assert.equal(capabilities.improvements, false)
    assert.match(capabilities.message, /disabled.*readable/i)
    const scope = f.contexts[0].scope
    const context = await (await server.request(`/context?${new URLSearchParams({
      runId: scope.runId, comparisonId: scope.comparisonId,
    })}`)).json()
    assert.equal(context.writable, true, 'The saved result remains lifecycle-writable independently of admission')
    assert.ok(context.myReview)
    assert.equal((await server.request(`/reviews/history?${new URLSearchParams(scope)}`)).status, 200)
    const peers = await server.request('/peers', 'POST', scope)
    assert.equal(peers.status, 200)
    assert.deepEqual((await peers.json()).scope, scope)
    assert.equal((await server.request('/plans')).status, 200)
    assert.equal((await server.request(`/plans/${created.plan.id}/history`)).status, 200)
    assert.equal((await server.request('/batches')).status, 200)
    assert.equal((await server.request('/prompts')).status, 200)
    assert.equal((await server.request('/prompts/history')).status, 200)
    const detail = await (await server.request(`/plans/${created.plan.id}`)).json()
    assert.equal(detail.canEdit, false)
    assert.equal(detail.canActivate, false)
    assert.equal(detail.canCancel, true)
    const newPlan = { name: 'Blocked admission', objective: 'Preserve history without admitting new work.',
      cases: created.plan.cases, excludedFeedback: [] }
    const before = clone([...f.qc.store.values])
    const blobCount = f.qc.blobs.values.size
    const production = clone([...f.analysis.store.values])
    for (const [suffix, method, data, role = 'reviewer'] of [
      ['/reviews', 'PUT', feedback(f.contexts[0])],
      ['/reviews/submit', 'POST', feedback(f.contexts[0])],
      ['/batches', 'POST', { name: 'Blocked batch', comparisons: [scope] }, 'owner'],
      ['/plans', 'POST', newPlan],
      [`/plans/${created.plan.id}`, 'PUT', { proposal: proposal(created.plan) }],
      [`/plans/${created.plan.id}/draft`, 'POST', {}],
      [`/plans/${created.plan.id}/evaluate`, 'POST', { confirmPaidWork: true }],
      [`/plans/${created.plan.id}/retry`, 'POST', {}],
      [`/plans/${created.plan.id}/activate`, 'POST', { confirm: true, reason: 'Blocked activation' }, 'admin'],
      ['/prompts/restore', 'POST', { revision: created.plan.baseline.revision, confirm: true, reason: 'Blocked restore' }, 'admin'],
    ]) assert.equal((await server.request(suffix, method, data, role, { 'If-Match': detail.etag })).status, 503, suffix)
    assert.deepEqual([...f.qc.store.values], before, 'Denied writes neither change feedback nor schedule work')
    assert.equal(f.qc.blobs.values.size, blobCount, 'Denied writes do not stage new private artifacts')
    assert.deepEqual([...f.analysis.store.values], production, 'Ordinary analysis records remain untouched')
    const cancelled = await server.request(`/plans/${created.plan.id}/cancel`, 'POST', {}, 'reviewer', { 'If-Match': detail.etag })
    assert.equal(cancelled.status, 200)
    const stopped = await cancelled.json()
    assert.equal(stopped.plan.status, 'cancelled')
    assert.equal(stopped.canEdit, false)
    assert.equal(stopped.canActivate, false)
    assert.equal(stopped.canCancel, false)
    assert.equal(stopped.work.id, accepted.work.id)
    assert.equal(stopped.work.status, 'cancelled')
  }
})

test('QC admission is rechecked after a request acquires its workspace mutation lease', async t => {
  const f = await qcFixture(), server = await qcHttp(f)
  t.after(() => server.close())
  assert.equal((await (await server.request('/capabilities')).json()).admissionEnabled, true)
  server.beforeLease(async () => { server.setAdmissionEnabled(false) })
  assert.equal((await server.request('/reviews', 'PUT', feedback(f.contexts[0]))).status, 503)
  assert.equal([...f.qc.store.values.values()].filter(value => value.record.recordType === 'qc-review').length, 0)
  server.setAdmissionEnabled(true)
  assert.equal((await server.request('/reviews', 'PUT', feedback(f.contexts[0]))).status, 200)
})

test('archived evidence remains readable while writes and late worker publications are fenced', async t => {
  const f = await qcFixture(), server = await qcHttp(f)
  t.after(() => server.close())
  server.archive()
  const query = new URLSearchParams({ runId: f.contexts[0].scope.runId, comparisonId: f.contexts[0].scope.comparisonId })
  const context = await server.request(`/context?${query}`)
  assert.equal(context.status, 200)
  assert.equal((await context.json()).writable, false)
  assert.equal((await server.request('/reviews', 'PUT', feedback(f.contexts[0]))).status, 409)
  assert.equal((await server.request('/context?author=spoof')).status, 400)
})

test('run deletion purges reviews and whole multi-run improvement packs, including interrupted orphan captures', async () => {
  const f = await qcFixture(), additional = await createRun(f, 1, 1)
  const comparison = [...f.analysis.store.values.values()].find(value =>
    value.record.recordType === 'analysis-comparison' && value.record.runId === additional.run.id)
  await publishResult(f, additional.run.id, comparison.record.id, false, { scheduleNarratives: false })
  f.contexts.push(await f.base.context(f.caller('reviewer'), additional.run.id, comparison.record.id))
  const created = await submittedPlan(f, { holdout: true })
  assert.equal(new Set(created.plan.cases.map(entry => entry.scope.runId)).size, 2)
  const ownerId = api.qcId('plan', 'interrupted')
  await api.putQcJson(f.qc.blobs, f.workspaceId, ownerId, { private: 'Orphan source material' }, {
    runIds: [f.contexts[0].scope.runId], assertActive: async () => {},
  })
  assert.ok(f.qc.blobs.values.size >= 2)
  const hooks = api.createQcRunLifecycleHooks(f.qc)
  await hooks.setRunState(f.workspaceId, f.contexts[0].scope.runId, 'deleting', f.now)
  assert.equal((await f.qc.store.get(f.workspaceId, created.plan.id)).record.status, 'invalidated')
  assert.deepEqual(await f.qc.store.pendingLifecycle(10), [f.workspaceId])
  await hooks.purgeRun(f.workspaceId, f.contexts[0].scope.runId, f.now)
  assert.equal(f.qc.blobs.values.size, 0)
  assert.equal(await f.qc.store.get(f.workspaceId, created.plan.id), undefined)
  const retained = [...f.qc.store.values.values()].filter(value => value.record.recordType !== 'qc-control')
  assert.deepEqual(new Set(retained.map(value => value.record.recordType)), new Set(['qc-review', 'qc-submission', 'qc-request']))
  assert.ok(retained.every(value => api.qcRunIds(value.record).every(runId => runId === additional.run.id)))
  await assert.rejects(f.base.saveReview(f.caller('reviewer'), feedback(f.contexts[0]), randomUUID()), http(404))
  const tombstone = await f.qc.store.get(f.workspaceId, api.qcControlId(f.contexts[0].scope.runId))
  await api.setQcRunState(f.qc, f.workspaceId, f.contexts[0].scope.runId, 'deleting', new Date(Date.parse(f.now) + 60_000).toISOString())
  assert.deepEqual(await f.qc.store.get(f.workspaceId, tombstone.record.id), tombstone)
  await hooks.setRunState(f.workspaceId, f.contexts[0].scope.runId, 'deleting', f.now)
  assert.equal((await f.qc.store.get(f.workspaceId, api.qcControlId(f.contexts[0].scope.runId))).record.state, 'deleted')
  await hooks.purgeRun(f.workspaceId, f.contexts[0].scope.runId, f.now)
})

test('run hooks recover interrupted cancellation before restoration and never restart prior accepted work', async () => {
  const f = await qcFixture(), created = await submittedPlan(f), hooks = api.createQcRunLifecycleHooks(f.qc)
  const accepted = await f.plans.request(f.caller('reviewer'), created.plan.id, 'plan', randomUUID(), created.etag)
  const runId = f.contexts[0].scope.runId
  await hooks.setRunState(f.workspaceId, runId, 'active', f.now)
  assert.equal((await f.qc.store.get(f.workspaceId, accepted.work.id)).record.status, 'queued',
    'An unchanged active state, including a rename, cannot cancel accepted work')
  const failCancellation = async operations => {
    if (operations.some(entry => entry.record.recordType === 'qc-work' && entry.record.status === 'cancelled')) {
      throw new Error('Simulated interrupted private cancellation')
    }
    f.qc.store.beforeCommit = failCancellation
  }
  f.qc.store.beforeCommit = failCancellation
  await assert.rejects(hooks.setRunState(f.workspaceId, runId, 'archived', f.now))
  const interrupted = await f.qc.store.get(f.workspaceId, api.qcControlId(runId))
  assert.equal(interrupted.record.state, 'archived')
  assert.equal(interrupted.record.cancellationPending, true)
  await hooks.setRunState(f.workspaceId, runId, 'active', f.now)
  const restored = await f.qc.store.get(f.workspaceId, api.qcControlId(runId))
  assert.equal(restored.record.state, 'active')
  assert.equal(restored.record.generation, 2)
  assert.equal(restored.record.cancellationPending, false)
  assert.equal((await f.qc.store.get(f.workspaceId, accepted.work.id)).record.status, 'cancelled')
  assert.equal((await f.qc.store.pending(f.now, 10)).length, 0)
  const current = await f.plans.detail(f.caller('reviewer'), created.plan.id)
  const retried = await f.plans.retry(f.caller('reviewer'), created.plan.id, randomUUID(), current.etag)
  const receipt = await f.qc.store.get(f.workspaceId, api.qcId('request', retried.work.requestedBy.principalId, retried.work.requestId))
  assert.equal(receipt.record.controlFences.find(fence => fence.controlId === restored.record.id).generation, 2)
})

test('run and workspace cleanup retain a finite drain barrier for cancelled worker leases and purge all private text', async () => {
  for (const scope of ['run', 'workspace', 'already-cancelled']) {
    const f = await qcFixture()
    f.now = new Date(Date.now() + 600_000).toISOString()
    const secret = `PRIVATE_QC_FEEDBACK_TO_PURGE_${scope}`, input = feedback(f.contexts[0])
    input.feedback[0].reason = secret
    const review = await f.base.saveReview(f.caller('reviewer'), input, randomUUID(), undefined, true)
    const plan = await f.plans.create(f.caller('reviewer'), {
      name: 'Lease draining', objective: 'Wait for all bounded private writers before removing source-owned QC.',
      cases: [{ scope: input.scope, reviewIds: [review.record.submittedId], purpose: 'drafting', note: '', referenceDecisions: [] }],
      excludedFeedback: [],
    }, randomUUID())
    const accepted = await f.plans.request(f.caller('reviewer'), plan.plan.id, 'plan', randomUUID(), plan.etag)
    const claim = await api.claimQcWork({ ...f.qc, clock: f.clock, model: {} },
      await f.qc.store.get(f.workspaceId, accepted.work.id), 'cleanup-drain')
    assert.ok(claim)
    if (scope === 'already-cancelled') {
      const current = await f.plans.detail(f.caller('reviewer'), plan.plan.id)
      await f.plans.cancel(f.caller('reviewer'), plan.plan.id, randomUUID(), current.etag)
    }
    const participant = api.createQcLifecycleParticipant(f.qc), hooks = api.createQcRunLifecycleHooks(f.qc)
    if (scope === 'workspace') {
      await participant.setState(f.workspaceId, 'deleting', f.now)
      await participant.cancel(f.workspaceId, f.now)
    } else await hooks.setRunState(f.workspaceId, input.scope.runId, 'deleting', f.now)
    const purge = () => scope === 'workspace'
      ? participant.purge(f.workspaceId, f.now) : hooks.purgeRun(f.workspaceId, input.scope.runId, f.now)
    await assert.rejects(purge(), error => error.status === 503 && /leases to drain/.test(error.message))
    assert.equal((await f.qc.store.get(f.workspaceId, plan.plan.id)).record.status, 'invalidated')
    assert.equal((await f.qc.store.get(f.workspaceId, accepted.work.id)).record.lease, null)
    const drains = await f.qc.store.list(f.workspaceId, { recordType: 'qc-writer', ownerId: plan.plan.id })
    assert.equal(drains.items.length, 1)
    assert.equal(drains.items[0].record.expiresAt, claim.record.lease.expiresAt)
    assert.ok(!JSON.stringify(drains).includes(secret))
    f.now = new Date(Date.parse(claim.record.lease.expiresAt) + 1).toISOString()
    await purge()
    assert.equal(f.qc.blobs.values.size, 0)
    for (const value of f.qc.store.values.values()) {
      assert.equal(value.record.recordType, 'qc-control')
      assert.ok(!JSON.stringify(value).includes(secret))
      assert.ok(Object.keys(value.record).every(key => [
        'id', 'recordType', 'workspaceId', 'runId', 'createdAt', 'updatedAt', 'state',
        'generation', 'cleanupPending', 'cancellationPending',
      ].includes(key)))
    }
    assert.deepEqual(await f.qc.store.pendingLifecycle(10), [])
  }
})

test('an active analysis with pending lifecycle recovery stays readable but cannot admit new QC until completion', async () => {
  const f = await qcFixture(), created = await submittedPlan(f), scope = f.contexts[0].scope
  const hooks = api.createQcRunLifecycleHooks(f.qc)
  f.analysis.qcLifecycle = hooks
  const lifecycle = new analysisApi.AnalysisLibraryLifecycleService(f.analysis, () => new Date(f.now))
  let run = await f.analysis.store.get(f.workspaceId, scope.runId)
  assert.equal((await lifecycle.change(f.workspaceId, scope.runId, 'archive', run.etag, ACTOR)).pending, undefined)
  run = await f.analysis.store.get(f.workspaceId, scope.runId)
  assert.equal((await lifecycle.change(f.workspaceId, scope.runId, 'unarchive', run.etag, ACTOR)).pending, undefined)
  await analysisApi.updateAnalysisControl(f.analysis.store, f.workspaceId, scope.runId, record => ({
    ...record, operation: { ...record.operation, status: 'pending' },
  }))
  const control = await f.analysis.store.getControl(f.workspaceId, scope.runId)
  assert.equal(control.record.state, 'active')
  assert.notEqual(control.record.operation.status, 'complete')
  const context = await f.base.context(f.caller('reviewer'), scope.runId, scope.comparisonId)
  assert.equal(context.writable, false)
  assert.deepEqual(context.scope, scope)
  assert.equal((await f.plans.detail(f.caller('reviewer'), created.plan.id)).canEdit, false)
  await assert.rejects(f.base.saveReview(f.caller('reviewer'), feedback(context), randomUUID(), context.myReview.etag), http(409))
  await analysisApi.createAnalysisLifecycleParticipant(f.analysis).resume(f.workspaceId, f.now)
  assert.equal((await f.analysis.store.getControl(f.workspaceId, scope.runId)).record.operation.status, 'complete')
  assert.equal((await f.base.context(f.caller('reviewer'), scope.runId, scope.comparisonId)).writable, true)
})

test('published corrections resolve current and historical frozen scopes without inheriting peer unlocks', async () => {
  const f = await qcFixture(1, { configureAssessment(assessment) {
    assessment.criteria = assessment.criteria.map(row => ({
      ...row, score: null, evidenceStatus: 'not-assessed', rationale: 'No supporting professional work is documented.',
      limitation: { code: 'not-assessable', message: 'No supporting work is documented.', criterionId: row.criterionId },
    }))
    assessment.limitations = assessment.criteria.map(row => row.limitation)
  } })
  f.analysis.evidenceCorrectionsEnabled = true
  const original = f.contexts[0], { runId, comparisonId } = original.scope
  await f.base.saveReview(f.caller('reviewer'), feedback(original), randomUUID(), undefined, true)
  const originalRecords = clone(await f.analysis.store.get(f.workspaceId, comparisonId))
  const preview = await f.service.correctionPreview(f.workspaceId, runId, comparisonId), requestId = randomUUID()
  await f.service.requestCorrection(f.workspaceId, runId, comparisonId, {
    policyVersion: preview.policyVersion, resultSha256: preview.resultSha256, criterionIds: preview.criterionIds,
    reason: 'Explicitly review the saved documentary absence without rewriting historical results.',
  }, requestId, preview.etag, ACTOR)
  await (await reviewedCorrection({ f, runId, comparisonId })).publish()
  const current = await f.base.context(f.caller('reviewer'), runId, comparisonId)
  assert.equal(current.scope.resultRevision, requestId)
  assert.equal(current.analysis.result.criteria[0].score, 0)
  assert.notEqual(current.scope.resultSha256, original.scope.resultSha256)
  assert.equal(current.myReview, null)
  assert.equal(current.canSeePeers, false)
  assert.equal(current.diagnostics.status, 'not-recorded')
  await assert.rejects(f.base.peers(f.caller('reviewer'), current.scope, randomUUID()), http(403))
  const historical = await f.base.context(f.caller('reviewer'), runId, comparisonId, 'original')
  assert.deepEqual(historical.scope, original.scope)
  assert.equal(historical.canSeePeers, true)
  assert.equal(historical.analysis.result.criteria[0].score, null)
  assert.deepEqual((await f.base.context(f.caller('reviewer'), runId, comparisonId, requestId)).scope, current.scope)
  await assert.rejects(f.base.saveReview(f.caller('reviewer'), {
    ...feedback(current), scope: { ...current.scope, resultSha256: original.scope.resultSha256 },
  }, randomUUID()), http(409))
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, comparisonId), originalRecords)
})

test('HTTP mutations enforce exact concurrency, stable keys, explicit paid consent, and same-origin exposure', async t => {
  const f = await qcFixture(), server = await qcHttp(f)
  t.after(() => server.close())
  assert.equal((await server.request('/reviews', 'PUT', feedback(f.contexts[0]), 'reviewer', { 'Idempotency-Key': '' })).status, 400)
  const first = await server.request('/reviews', 'PUT', feedback(f.contexts[0]), 'reviewer', { 'If-None-Match': '*' })
  assert.equal(first.status, 200)
  const draft = await first.json()
  assert.equal(first.headers.get('etag'), draft.etag)
  assert.equal((await server.request('/reviews', 'PUT', feedback(f.contexts[0]))).status, 428)
  assert.equal((await server.request('/reviews', 'PUT', feedback(f.contexts[0]), 'reviewer', { 'If-None-Match': '*' })).status, 409)
  for (const etag of ['*', 'W/"weak"', '"one","two"', 'unquoted', '"unterminated', '"embedded"quote"']) assert.equal((await server.request('/reviews', 'PUT',
    feedback(f.contexts[0]), 'reviewer', { 'If-Match': etag })).status, 400)
  const created = await submittedPlan(f)
  assert.equal((await server.request(`/plans/${created.plan.id}/evaluate`, 'POST', {}, 'reviewer', { 'If-Match': created.etag })).status, 400)
  assert.equal((await server.request(`/plans/${created.plan.id}`, 'GET', undefined, 'reviewer', { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await server.request('/plans?authorId=foreign')).status, 400)
  assert.equal([...f.qc.store.values.values()].filter(value => value.record.recordType === 'qc-work').length, 0)
})

test('archived peer exposure preserves private opinions and cannot masquerade as independence on restoration', async () => {
  const f = await qcFixture(), caller = f.caller('reviewer'), scope = f.contexts[0].scope
  let head = await f.base.saveReview(caller, feedback(f.contexts[0]), randomUUID(), undefined, true)
  await api.setQcRunState(f.qc, f.workspaceId, scope.runId, 'archived', f.now)
  assert.equal((await f.base.peers(caller, scope, randomUUID())).submissions.length, 1)
  const exposed = await f.base.head(caller, scope)
  assert.ok(exposed.record.peerExposedAt)
  assert.deepEqual(exposed.record.feedback, head.record.feedback)
  await assert.rejects(f.base.saveReview(caller, feedback(f.contexts[0]), randomUUID(), exposed.etag, true), http(409))
  await api.setQcRunState(f.qc, f.workspaceId, scope.runId, 'active', f.now)
  head = await f.base.saveReview(caller, feedback(f.contexts[0]), randomUUID(), exposed.etag, true)
  assert.equal((await f.base.get(f.workspaceId, head.record.submittedId, 'qc-submission')).record.peerIndependent, false)
})
