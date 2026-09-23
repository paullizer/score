import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { qcFixture, qcHttp, feedback, proposal, submittedPlan } from '../../server-tests/qc.test-support.mjs'

const output = resolve(`.qc-http-client-tests-${randomUUID()}`)
const nativeFetch = globalThis.fetch
let client, http, role, requests
before(async () => {
  await mkdir(output)
  await build({ entryPoints: [join('src', 'services', 'qualityControl.ts')], outfile: join(output, 'client.mjs'),
    bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent' })
  client = await import(pathToFileURL(join(output, 'client.mjs')).href)
})
afterEach(async () => { globalThis.fetch = nativeFetch; await http?.close(); http = null })
after(async () => { await rm(output, { recursive: true, force: true }) })

async function setup(configOverrides = {}) {
  const fixture = await qcFixture()
  http = await qcHttp(fixture, { settings: { runtimeEnabled: true }, ...configOverrides })
  role = 'reviewer'; requests = []
  const prefix = `/api/workspaces/${fixture.workspaceId}/qc`
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url !== 'string' || !url.startsWith(prefix)) return nativeFetch(url, init)
    requests.push({ url, init })
    const headers = Object.fromEntries(new Headers(init.headers))
    if (headers['idempotency-key']) {
      headers['Idempotency-Key'] = headers['idempotency-key']
      delete headers['idempotency-key']
    }
    return http.request(url.slice(prefix.length), init.method ?? 'GET', init.body ? JSON.parse(init.body) : undefined,
      role, headers)
  }
  return fixture
}

test('real QC HTTP contract supports incomplete drafts, independent submissions, exact history and explicit peers', async () => {
  const f = await setup(), scope = f.contexts[0].scope
  const capabilities = await client.getQcCapabilities(f.workspaceId)
  assert.equal(capabilities.reviews, true)
  assert.equal(capabilities.admissionEnabled, true)
  assert.equal(capabilities.applicationAdmin, false)
  const context = await client.getQcContext(f.workspaceId, scope.runId, scope.comparisonId, scope.resultRevision, undefined, scope.resultSha256)
  assert.equal(context.canSeePeers, false)
  assert.equal(context.diagnostics.status, 'not-recorded')
  await assert.rejects(client.getQcPeers(f.workspaceId, scope, randomUUID()), error => error.status === 403)
  const input = feedback(context)
  input.feedback[0] = { ...input.feedback[0], decision: 'disagree', reason: '', recommendation: null }
  let own = await client.saveQcReview(f.workspaceId, input, null, randomUUID(), false)
  assert.equal(own.record.feedback[0].reason, '')
  assert.equal(own.record.submittedId, null)
  const incomplete = await client.getQcContext(f.workspaceId, scope.runId, scope.comparisonId, scope.resultRevision)
  assert.equal(incomplete.myReview.etag, own.etag)
  assert.equal(incomplete.canSeePeers, false)
  input.feedback[0] = { ...input.feedback[0], reason: 'The exact evidence supports a narrower interpretation.', recommendation: { kind: 'score', score: 0 } }
  const key = randomUUID(), etag = own.etag
  own = await client.saveQcReview(f.workspaceId, input, etag, key, true)
  const replay = await client.saveQcReview(f.workspaceId, input, etag, key, true)
  assert.equal(replay.record.submittedId, own.record.submittedId)
  role = 'second'
  const second = await client.saveQcReview(f.workspaceId, feedback(context), null, randomUUID(), true)
  assert.notEqual(second.record.author.principalId, own.record.author.principalId)
  role = 'reviewer'
  const history = await client.getQcReviewHistory(f.workspaceId, scope)
  assert.equal(history.items.length, 1)
  assert.equal(history.items[0].record.peerIndependent, true)
  const peer = await client.getQcPeers(f.workspaceId, scope, randomUUID())
  assert.equal(peer.submissions.length, 2)
  assert.deepEqual(peer.submissions.find(item => item.id === own.record.submittedId).feedback[0].recommendation, { kind: 'score', score: 0 })
  const exposed = await client.getQcContext(f.workspaceId, scope.runId, scope.comparisonId, scope.resultRevision)
  assert.ok(exposed.myReview.record.peerExposedAt)
  const updated = await client.saveQcReview(f.workspaceId, input, exposed.myReview.etag, randomUUID(), true)
  const revisedHistory = await client.getQcReviewHistory(f.workspaceId, scope)
  assert.equal(revisedHistory.items.find(item => item.record.id === updated.record.submittedId).record.peerIndependent, false)
  assert.ok(requests.every(item => item.init.cache === 'no-store' && new Headers(item.init.headers).get('X-Score-Request') === 'workspace'))
})

test('real QC HTTP contract freezes curated plans and only explicit actions create, cancel or resume durable paid work', async () => {
  const f = await setup(), context = f.contexts[0], scope = context.scope
  const head = await client.saveQcReview(f.workspaceId, feedback(context), null, randomUUID(), true)
  const collected = await client.getQcPeers(f.workspaceId, scope, randomUUID())
  assert.equal(collected.submissions.length, 1)
  const input = { name: 'HTTP client curation', objective: 'Clarify the mapping between documentary scope and existing anchors.',
    cases: [{ scope, reviewIds: [head.record.submittedId], purpose: 'drafting', note: 'One selected reviewer, no consensus claim.',
      referenceDecisions: [{ criterionId: context.analysis.result.criteria[0].criterionId, score: 0, reason: 'Named reference “Scope check”: explicit human judgment.' }] }],
    excludedFeedback: [] }
  let detail = await client.createQcPlan(f.workspaceId, input, randomUUID())
  const workCount = () => [...f.qc.store.values.values()].filter(item => item.record.recordType === 'qc-work').length
  assert.equal(detail.plan.status, 'draft')
  assert.equal(detail.plan.proposal, null)
  assert.equal(workCount(), 0)
  assert.ok(detail.plan.casePack.bytes > 0)
  detail = await client.getQcPlan(f.workspaceId, detail.plan.id)
  await client.getQcPlanHistory(f.workspaceId, detail.plan.id)
  await client.listQcPlans(f.workspaceId)
  assert.equal(workCount(), 0, 'Opening, listing, and reading history never enqueue work')
  const key = randomUUID(), before = detail
  detail = await client.actOnQcPlan(f.workspaceId, detail, 'draft', key)
  assert.equal(detail.plan.status, 'planning')
  assert.equal(detail.work.status, 'queued')
  assert.equal(detail.canEdit, false)
  detail = await client.actOnQcPlan(f.workspaceId, before, 'draft', key)
  assert.equal(workCount(), 1, 'The same paid request key cannot duplicate durable work')
  detail = await client.actOnQcPlan(f.workspaceId, detail, 'cancel', randomUUID())
  assert.equal(detail.plan.status, 'cancelled')
  detail = await client.actOnQcPlan(f.workspaceId, detail, 'retry', randomUUID())
  assert.equal(workCount(), 2)
  assert.equal(detail.work.kind, 'plan')
  detail = await client.actOnQcPlan(f.workspaceId, detail, 'cancel', randomUUID())
  detail = await client.updateQcPlan(f.workspaceId, detail, proposal(detail.plan), randomUUID())
  assert.equal(detail.plan.revision, 2)
  assert.equal(detail.evaluation, null)
  assert.deepEqual(detail.trialScope.pairs, [{ scope, purpose: 'drafting', familyId: 'assessment' }])
  assert.equal(detail.trialScope.baselineTrials, 1)
  assert.equal(detail.trialScope.candidateTrials, 1)
  detail = await client.actOnQcPlan(f.workspaceId, detail, 'evaluate', randomUUID())
  assert.equal(detail.work.kind, 'evaluation')
  assert.equal(detail.canActivate, false)
  const current = await client.getQcPrompts(f.workspaceId)
  assert.ok(current.guidance.assessment)
  const promptHistory = await client.getQcPromptHistory(f.workspaceId)
  assert.ok(promptHistory.items.length > 0)
})

test('real QC client keeps saved reads and cancellation available when new admission is disabled', async () => {
  const f = await setup({ qcEnabled: false })
  const saved = await submittedPlan(f)
  const accepted = await f.plans.request(f.caller('reviewer'), saved.plan.id, 'plan', randomUUID(), saved.etag)
  const capabilities = await client.getQcCapabilities(f.workspaceId)
  assert.equal(capabilities.reviews, true)
  assert.equal(capabilities.admissionEnabled, false)
  assert.equal(capabilities.writable, true)
  assert.equal(capabilities.improvements, false)
  const scope = f.contexts[0].scope
  const context = await client.getQcContext(f.workspaceId, scope.runId, scope.comparisonId, scope.resultRevision)
  assert.ok(context.myReview)
  assert.ok((await client.getQcReviewHistory(f.workspaceId, scope)).items.length)
  assert.ok((await client.getQcPeers(f.workspaceId, scope, randomUUID())).submissions.length)
  assert.ok((await client.listQcPlans(f.workspaceId)).items.length)
  assert.ok((await client.getQcPlanHistory(f.workspaceId, saved.plan.id)).items.length)
  assert.ok((await client.getQcPromptHistory(f.workspaceId)).items.length)
  assert.ok((await client.getQcPrompts(f.workspaceId)).revision)
  let detail = await client.getQcPlan(f.workspaceId, saved.plan.id)
  assert.equal(detail.canEdit, false)
  assert.equal(detail.canActivate, false)
  assert.equal(detail.canCancel, true)
  await assert.rejects(client.saveQcReview(f.workspaceId, feedback(context), context.myReview.etag, randomUUID()),
    error => error.status === 503)
  detail = await client.actOnQcPlan(f.workspaceId, detail, 'cancel', randomUUID())
  assert.equal(detail.plan.status, 'cancelled')
  assert.equal(detail.work.id, accepted.work.id)
  assert.equal(detail.work.status, 'cancelled')
  assert.equal(detail.canEdit, false)
  await assert.rejects(client.actOnQcPlan(f.workspaceId, detail, 'retry', randomUUID()), error => error.status === 503)
})
