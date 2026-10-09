import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  captureProcessingSettings,
  createApp,
  createAssistLimiter,
  createDefaultAdminSettings,
  effectiveFeatures,
  processingSettingsSnapshotSchema,
} from '../dist-server/app.mjs'
import {
  ALLOWED_OID,
  APP_ORIGIN,
  OTHER_ALLOWED_OID,
  authHeaders,
  baseConfig,
  createFakeAccessStore,
  createFakeDirectoryStore,
  createFakeStateStore,
  membershipFor,
  seedWorkspace,
} from './helpers.mjs'
import { createFakeRealJobs } from './job-lifecycle-fakes.mjs'
import { loadWorker } from '../worker-tests/shared-model-loader.mjs'

const { EVIDENCE_SCALE_VERSION, renderEvidenceGuidance } = await loadWorker('../src/domain/evidence-scale.ts')

const CSRF = { origin: APP_ORIGIN, 'x-score-request': 'workspace' }
const NOW = '2026-10-09T14:00:00.000Z'
const ADMIN_OID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const REAL_JOBS_CONFIG = {
  cosmosEndpoint: 'https://example-cosmos.documents.azure.com:443/',
  database: 'score',
  container: 'job-records',
  storageAccountUrl: 'https://example.blob.core.windows.net',
  blobContainer: 'job-sources',
}
const MODEL_CONFIG = { endpoint: 'https://score-test.openai.azure.com', deploymentName: 'gpt-test', modelName: 'gpt-test' }

function levels(subject) {
  return [
    `Lists training or a skill in ${subject}.`,
    `Describes one project applying ${subject}.`,
    `Describes ongoing ${subject} across several assignments.`,
    `Owns ${subject} for a program or system with larger scope.`,
    `Leads ${subject} for an organization, with described outcomes.`,
  ].map((examples, index) => ({ level: index + 1, examples }))
}

function reviewReply(findings = []) {
  return JSON.stringify({ summary: findings.length ? 'Two criteria may overlap.' : 'No problems found.', findings })
}

function fakeInvoker(outputs) {
  const calls = []
  const invoke = async request => {
    calls.push(request)
    const next = outputs[Math.min(calls.length - 1, outputs.length - 1)]
    return { content: next, model: 'fake-review-model' }
  }
  invoke.calls = calls
  return invoke
}

async function startServer(options = {}) {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  const jobs = createFakeRealJobs()
  let settingsValue = options.settings ?? createDefaultAdminSettings()
  const settings = {
    async capture() { return captureProcessingSettings(settingsValue, 'approval-policy', NOW) },
    _set(value) { settingsValue = value },
  }
  const invoke = options.invoke ?? fakeInvoker([reviewReply()])
  const app = createApp({
    config: baseConfig({
      realJobs: REAL_JOBS_CONFIG,
      rubricAssistant: { model: MODEL_CONFIG },
      settings: { runtimeEnabled: true },
    }),
    directory,
    state,
    accessStore: createFakeAccessStore(),
    jobs: { store: jobs.store, blobs: jobs.blobs },
    settings,
    assist: { invoke, limiter: createAssistLimiter() },
    now: () => new Date(NOW),
  })
  const server = createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    directory, state, jobs, settings, invoke,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

async function seedJob(server, { scaled = true } = {}) {
  const workspace = await seedWorkspace(server)
  const imported = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/pdf`, {
    method: 'POST',
    headers: { ...authHeaders(), ...CSRF, 'content-type': 'application/pdf', 'x-file-name': 'Data%20Analyst.pdf', 'idempotency-key': randomUUID() },
    body: Buffer.from('%PDF-1.7\nreal job source\n', 'ascii'),
  })
  assert.equal(imported.status, 202, await imported.clone().text())
  const jobId = (await imported.json()).job.job.id
  const current = await server.jobs.store.get(workspace.id, jobId)
  const document = {
    id: current.record.job.documentId, title: 'Data Analyst', kind: 'job', version: 1, sample: false,
    paragraphs: [
      { id: 'paragraph-1', page: 1, heading: 'Duties', text: 'Analyzes workforce data for program decisions.' },
      { id: 'paragraph-2', page: 1, heading: 'Duties', text: 'Presents findings to senior leaders.' },
    ],
  }
  const documentBlobName = `${workspace.id}/${jobId}/source-document.json`
  await server.jobs.blobs.putImmutable(documentBlobName, Buffer.from(JSON.stringify(document)), 'application/json')
  const citation = paragraph => ({
    documentId: document.id, documentVersion: 1, paragraphId: paragraph.id, page: 1, heading: paragraph.heading, quote: paragraph.text,
  })
  const criterion = (id, label, subject, weight, paragraph) => {
    const examples = levels(subject)
    return {
      id, key: 'custom', label, description: paragraph.text, weight, requirementType: 'required',
      sourceParagraphId: paragraph.id, sourceCitations: [citation(paragraph)],
      ...(scaled
        ? { levels: examples, guidance: renderEvidenceGuidance(examples) }
        : { guidance: 'Score 0: No supporting evidence. Score 1: Minimal. Score 2: Basic. Score 3: Adequate. Score 4: Strong. Score 5: Exceptional.' }),
    }
  }
  const rubricId = `rubric-${jobId}`
  const rubric = {
    id: rubricId, groupId: rubricId, kind: 'job', jobId, name: 'Data Analyst rubric', description: 'Grounded requirements',
    version: 1, createdAt: NOW, dataKind: 'real',
    provenance: { kind: 'generated', model: 'gpt-test', promptVersion: 'score-job-rubric-v4' },
    criteria: [
      criterion('criterion-01', 'Workforce data analysis', 'workforce data analysis', 60, document.paragraphs[0]),
      criterion('criterion-02', 'Briefing senior leaders', 'briefings to senior leaders', 40, document.paragraphs[1]),
    ],
    ...(scaled ? { scaleVersion: EVIDENCE_SCALE_VERSION } : {}),
  }
  const record = {
    ...current.record, job: { ...current.record.job, status: 'ready', rubricId, title: 'Data Analyst' },
    extractedBlobName: documentBlobName, nextAttemptAt: undefined, updatedAt: NOW,
  }
  await server.jobs.store.publish(record, current.etag, rubric)
  return { workspace, jobId, rubric, path: `${server.baseUrl}/api/workspaces/${workspace.id}/jobs/${jobId}` }
}

function headers(oid = ALLOWED_OID, extra = {}, roles = ['Score.User']) {
  return { ...authHeaders({ oid, roles }), ...CSRF, 'content-type': 'application/json', ...extra }
}

async function checks(seed, version = 1, oid = ALLOWED_OID) {
  return fetch(`${seed.path}/rubric/checks?rubricId=${encodeURIComponent(seed.rubric.id)}&version=${version}`, { headers: authHeaders({ oid }) })
}

async function runChecks(seed, version = 1, oid = ALLOWED_OID) {
  return fetch(`${seed.path}/rubric/checks`, {
    method: 'POST', headers: headers(oid), body: JSON.stringify({ rubricId: seed.rubric.id, version }),
  })
}

async function job(seed) {
  const response = await fetch(seed.path, { headers: authHeaders() })
  assert.equal(response.status, 200)
  return response.json()
}

async function approve(seed, body, { oid = ALLOWED_OID, etag, roles } = {}) {
  return fetch(`${seed.path}/rubric/approve`, {
    method: 'POST',
    headers: headers(oid, etag === undefined ? {} : { 'if-match': etag }, roles),
    body: JSON.stringify(body),
  })
}

test('the approval switch is optional, on by default, and stays a policy while new work is paused', () => {
  const defaults = createDefaultAdminSettings()
  assert.equal('rubricApprovalRequired' in defaults.features, false, 'Defaults keep their earlier shape; an absent key means on')
  const capture = captureProcessingSettings(defaults, 'legacy-v1', '1970-01-01T00:00:00.000Z')
  assert.equal('rubricApprovalRequired' in capture.settings.features, false, 'Captured snapshots are not rewritten with a default')
  assert.deepEqual(processingSettingsSnapshotSchema.parse(capture), capture)
  const capabilities = {
    realJobImports: true, realGradeLadders: true, realResumeImports: false, realAnalyses: true,
    analysisSummaryGeneration: false, wordDocumentImports: false, rubricAssistant: true,
  }
  const absent = effectiveFeatures(capabilities, capture, true)
  assert.equal(absent.rubricApprovalRequired, true, 'An absent key means on')
  assert.equal(absent.publicSettings.features.rubricApprovalRequired, true)
  assert.equal(absent.rubricChecks, true)
  assert.equal(effectiveFeatures({ ...capabilities, rubricAssistant: false }, capture, true).rubricChecks, false,
    'Checks need the job-rubric model deployment')

  const off = structuredClone(defaults)
  off.features.rubricApprovalRequired = false
  const switchedOff = effectiveFeatures(capabilities, captureProcessingSettings(off, 'off', NOW), true)
  assert.equal(switchedOff.rubricApprovalRequired, false)
  assert.equal(switchedOff.publicSettings.features.rubricApprovalRequired, false)
  assert.equal(switchedOff.rubricChecks, true, 'Turning approval off leaves the checks available')

  const paused = structuredClone(defaults)
  paused.maintenance.pauseNewWork = true
  const whilePaused = effectiveFeatures(capabilities, captureProcessingSettings(paused, 'paused', NOW), true)
  assert.equal(whilePaused.rubricApprovalRequired, true, 'Pausing new work does not relax the approval policy')
  assert.equal(whilePaused.rubricChecks, false, 'Checks call a model, so they stop while new work is paused')
})

test('rubric checks run once per saved version and refuse rubrics made before the evidence scale', async () => {
  const server = await startServer({
    invoke: fakeInvoker([
      JSON.stringify({ summary: 'x', findings: [{ code: 'same-capability', criteria: ['C1'], message: 'Only one criterion.' }] }),
      reviewReply([{ code: 'same-capability', criteria: ['C1', 'C2'], message: 'Both criteria count the same briefing work.' }]),
    ]),
  })
  try {
    const legacy = await seedJob(server, { scaled: false })
    const legacyState = await checks(legacy)
    assert.equal(legacyState.status, 200)
    const legacyReview = (await legacyState.json()).review
    assert.equal(legacyReview.status, 'draft')
    assert.equal(legacyReview.checks, null)
    assert.match(legacyReview.blockers.join(' '), /before the evidence scale/)
    const refused = await runChecks(legacy)
    assert.equal(refused.status, 409)
    assert.match((await refused.json()).error.message, /before the evidence scale/)
    assert.equal(server.invoke.calls.length, 0, 'Legacy rubrics never call the model')

    const seed = await seedJob(server)
    const before = (await (await checks(seed)).json()).review
    assert.equal(before.checks, null)
    assert.deepEqual(before.blockers, [])
    assert.match(before.rubricHash, /^[0-9a-f]{64}$/)

    server.directory._addMembership(seed.workspace.id, membershipFor(seed.workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
    assert.equal((await runChecks(seed, 1, OTHER_ALLOWED_OID)).status, 403, 'Readers cannot run checks')

    const ran = await runChecks(seed)
    assert.equal(ran.status, 200, await ran.clone().text())
    const review = (await ran.json()).review
    assert.equal(server.invoke.calls.length, 2, 'One correction after an invalid review')
    assert.equal(server.invoke.calls[0].taskId, 'jobRubric')
    assert.match(server.invoke.calls[0].system, /score-evidence-ladder-v1|No relevant evidence/)
    assert.match(server.invoke.calls[1].user, /at least two criteria/)
    assert.equal(review.checks.rubricHash, before.rubricHash)
    assert.equal(review.checks.qaVersion, 'score-rubric-qa-v1')
    assert.equal(review.checks.review.promptVersion, 'score-job-rubric-review-v1')
    assert.deepEqual(review.checks.review.findings, [{
      code: 'same-capability', severity: 'warning', criterionIds: ['criterion-01', 'criterion-02'],
      message: 'Both criteria count the same briefing work.',
    }])
    assert.ok(Array.isArray(review.checks.checks))
    assert.deepEqual(review.blockers, [], 'Review findings are warnings for the approver')

    server.directory._addMembership(seed.workspace.id, membershipFor(seed.workspace.id, { oid: OTHER_ALLOWED_OID, role: 'editor' }))
    const again = await runChecks(seed, 1, OTHER_ALLOWED_OID)
    assert.equal(again.status, 200)
    assert.deepEqual((await again.json()).review.checks, review.checks, 'Stored results are reused')
    assert.equal(server.invoke.calls.length, 2, 'Checks never run twice for one version')
    assert.deepEqual((await (await checks(seed)).json()).review.checks, review.checks)
  } finally { await server.close() }
})

test('only workspace owners approve the exact checked latest version, and newer approvals supersede older ones', async () => {
  const server = await startServer()
  try {
    const seed = await seedJob(server)
    const state = (await (await checks(seed)).json()).review
    let detail = await job(seed)
    const body = { rubricId: seed.rubric.id, version: 1, rubricHash: state.rubricHash }

    assert.equal((await approve(seed, body, { oid: OTHER_ALLOWED_OID, etag: detail.etag })).status, 404, 'Non-members cannot see the workspace')
    for (const role of ['editor', 'viewer', 'reviewer']) {
      server.directory._addMembership(seed.workspace.id, membershipFor(seed.workspace.id, { oid: OTHER_ALLOWED_OID, role }))
      const refused = await approve(seed, body, { oid: OTHER_ALLOWED_OID, etag: detail.etag })
      assert.equal(refused.status, 403, `${role} cannot approve`)
    }
    const noCsrf = await fetch(`${seed.path}/rubric/approve`, {
      method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json', 'if-match': detail.etag }, body: JSON.stringify(body),
    })
    assert.equal(noCsrf.status, 403)
    assert.equal((await approve(seed, body)).status, 428, 'Approval needs the exact job ETag')
    assert.equal((await approve(seed, body, { etag: '"stale"' })).status, 409)
    assert.equal((await approve(seed, { ...body, rubricHash: 'f'.repeat(64) }, { etag: detail.etag })).status, 409,
      'Approval covers exactly the reviewed content')
    const unchecked = await approve(seed, body, { etag: detail.etag })
    assert.equal(unchecked.status, 409)
    assert.match((await unchecked.json()).error.message, /Run the rubric checks/)

    assert.equal((await runChecks(seed)).status, 200)
    const approved = await approve(seed, body, { etag: detail.etag })
    assert.equal(approved.status, 200, await approved.clone().text())
    detail = (await approved.json()).job
    assert.equal(approved.headers.get('etag'), detail.etag)
    assert.match(detail.rubricApproval.approvalId, /^rubric-approval-[0-9a-f-]{36}$/)
    assert.equal(detail.rubricApproval.version, 1)
    assert.equal(detail.rubricApproval.rubricHash, state.rubricHash)
    assert.equal(detail.rubricApproval.approvedAt, NOW)
    assert.equal((await (await checks(seed)).json()).review.status, 'approved')
    assert.equal((await approve(seed, body, { etag: detail.etag })).status, 409, 'An approved version is not approved twice')

    const edited = structuredClone(detail.rubric)
    edited.criteria[0].label = 'Workforce data analysis and modeling'
    const saved = await fetch(`${seed.path}/rubric`, {
      method: 'PUT', headers: headers(ALLOWED_OID, { 'if-match': detail.etag }), body: JSON.stringify({ rubric: edited }),
    })
    assert.equal(saved.status, 200, await saved.clone().text())
    detail = (await saved.json()).job
    assert.equal(detail.rubric.version, 2)
    assert.equal(detail.rubricApproval.version, 1, 'Edits create a draft; the approved version stays in force')
    assert.equal((await (await checks(seed, 2)).json()).review.status, 'draft')
    const stale = await approve(seed, body, { etag: detail.etag })
    assert.equal(stale.status, 409, 'Older versions are not re-approved')

    const second = (await (await runChecks(seed, 2)).json()).review
    const administrator = await approve(seed, { rubricId: seed.rubric.id, version: 2, rubricHash: second.rubricHash },
      { oid: ADMIN_OID, etag: detail.etag, roles: ['Score.User', 'Score.Admin'] })
    assert.equal(administrator.status, 200, 'Application admins act with owner authority')
    detail = (await administrator.json()).job
    assert.equal(detail.rubricApproval.version, 2)
    assert.equal((await (await checks(seed, 1)).json()).review.status, 'superseded')
    const records = server.jobs.store._approvals.get(`${seed.workspace.id}/${seed.jobId}`)
    assert.equal(records.length, 2)
    assert.equal(records[1].supersedes, records[0].id)
    assert.equal(records[1].qa.id, `rubric-qa:${seed.rubric.id}:2:score-rubric-qa-v1`)
    assert.match(records[1].document.sha256, /^[0-9a-f]{64}$/)
    assert.equal(records[1].scaleVersion, EVIDENCE_SCALE_VERSION)
  } finally { await server.close() }
})

test('rubrics made before the evidence scale cannot be approved', async () => {
  const server = await startServer()
  try {
    const legacy = await seedJob(server, { scaled: false })
    const state = (await (await checks(legacy)).json()).review
    const detail = await job(legacy)
    const refused = await approve(legacy, { rubricId: legacy.rubric.id, version: 1, rubricHash: state.rubricHash }, { etag: detail.etag })
    assert.equal(refused.status, 409)
    assert.equal((await job(legacy)).rubricApproval, undefined)
  } finally { await server.close() }
})

test('unexpected failures after storing QA are not hidden by a success-shaped cached response', async () => {
  const server = await startServer()
  try {
    const seed = await seedJob(server)
    const create = server.jobs.store.createRubricQa.bind(server.jobs.store)
    server.jobs.store.createRubricQa = async record => {
      await create(record)
      throw new Error('Simulated persistence failure after the conditional write.')
    }
    const response = await runChecks(seed)
    assert.equal(response.status, 503, 'Only conditional-write conflicts can return a competing result')
    const stored = await (await checks(seed)).json()
    assert.ok(stored.review.checks, 'A later explicit read can recover the durable record')
  } finally { await server.close() }
})
