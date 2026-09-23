import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  AssistCancelledError,
  captureProcessingSettings,
  createApp,
  createAssistLimiter,
  createDefaultAdminSettings,
  rubricAssistResponseSchema,
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

const CSRF = { origin: APP_ORIGIN, 'x-score-request': 'workspace' }
const REAL_JOBS_CONFIG = {
  cosmosEndpoint: 'https://example-cosmos.documents.azure.com:443/',
  database: 'score',
  container: 'job-records',
  storageAccountUrl: 'https://example.blob.core.windows.net',
  blobContainer: 'job-sources',
}
const MODEL_CONFIG = {
  endpoint: 'https://score-test.openai.azure.com',
  deploymentName: 'gpt-test',
  modelName: 'gpt-test',
}

function writeHeaders(oid = ALLOWED_OID, extra = {}) {
  return { ...authHeaders({ oid }), ...CSRF, ...extra }
}

function clone(value) {
  return structuredClone(value)
}

function guidance(label = 'evidence') {
  return `Score 0: No supporting evidence in the submitted resume for this criterion. Score 1: Minimal ${label}. Score 2: Basic ${label}. Score 3: Adequate ${label}. Score 4: Strong ${label}. Score 5: Exceptional ${label}.`
}

function changedLabelOutput(label = 'Platform leadership') {
  return JSON.stringify({
    outcome: 'changed',
    reply: 'Updated the criterion label.',
    rubric: { name: null, description: null },
    criteria: [{
      action: 'update', ref: 'C1', afterRef: null, label, description: null, guidance: null, weight: null,
      requirementType: null, paragraphId: null, quote: null,
    }],
    warnings: [],
  })
}

function addedCriterionOutput() {
  return JSON.stringify({
    outcome: 'changed',
    reply: 'Added a supported cloud operations criterion.',
    rubric: { name: null, description: null },
    criteria: [{
      action: 'add', ref: null, afterRef: 'C1', label: 'Cloud operations',
      description: 'Operates Azure services for production workloads.', guidance: guidance('cloud operations evidence'),
      weight: 50, requirementType: 'required', paragraphId: 'paragraph-2', quote: 'Must operate Azure services for production workloads.',
    }, {
      action: 'update', ref: 'C1', afterRef: null, label: null, description: null, guidance: null, weight: 50,
      requirementType: null, paragraphId: null, quote: null,
    }],
    warnings: ['Review the new weighting.'],
  })
}

function fakeInvoker(outputs = [changedLabelOutput()]) {
  const calls = []
  const invoke = async (request, signal) => {
    calls.push({ request, signal })
    const next = outputs[Math.min(calls.length - 1, outputs.length - 1)]
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(request, signal)
    return { content: next, model: 'fake-model' }
  }
  invoke.calls = calls
  return invoke
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function startAssistServer(options = {}) {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  const jobs = createFakeRealJobs()
  let settingsValue = options.settings ?? createDefaultAdminSettings()
  let settingsOutage = false
  const settings = {
    async capture() {
      if (settingsOutage) throw new Error('settings unavailable')
      return captureProcessingSettings(settingsValue, options.revision ?? 'assist-policy', '2026-09-23T14:00:00.000Z')
    },
    _set(value) { settingsValue = value },
    _outage(value) { settingsOutage = value },
    _get() { return settingsValue },
  }
  const config = baseConfig({
    realJobs: REAL_JOBS_CONFIG,
    ...(options.configRubricAssistant === false ? {} : { rubricAssistant: { model: MODEL_CONFIG } }),
    ...(options.configSettings === false ? {} : { settings: { runtimeEnabled: options.runtimeEnabled ?? true } }),
  })
  const invoke = options.invoke ?? fakeInvoker()
  const assist = options.assist === false ? undefined : { invoke, limiter: options.limiter ?? createAssistLimiter() }
  const app = createApp({
    config,
    directory,
    state,
    accessStore: createFakeAccessStore(),
    jobs: { store: jobs.store, blobs: jobs.blobs },
    settings: options.configSettings === false ? undefined : settings,
    assist,
    now: () => new Date('2026-09-23T14:00:00.000Z'),
  })
  const server = createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    directory,
    state,
    jobs,
    settings,
    config,
    invoke,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

async function importPdf(server, workspaceId) {
  const key = randomUUID()
  return fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/jobs/pdf`, {
    method: 'POST',
    headers: writeHeaders(ALLOWED_OID, {
      'content-type': 'application/pdf',
      'x-file-name': 'Principal%20Engineer.pdf',
      'idempotency-key': key,
    }),
    body: Buffer.from('%PDF-1.7\nreal job source\n', 'ascii'),
  })
}

async function seedReadyJob(server) {
  const workspace = await seedWorkspace(server)
  const imported = await importPdf(server, workspace.id)
  assert.equal(imported.status, 202, await imported.clone().text())
  const summary = (await imported.json()).job
  const jobId = summary.job.id
  const current = await server.jobs.store.get(workspace.id, jobId)
  const document = {
    id: current.record.job.documentId,
    title: 'Principal Engineer',
    kind: 'job',
    version: 1,
    paragraphs: [
      { id: 'paragraph-1', page: 1, heading: 'Requirements', text: 'Must lead distributed systems delivery.' },
      { id: 'paragraph-2', page: 2, heading: 'Operations', text: 'Must operate Azure services for production workloads.' },
    ],
    sample: false,
  }
  const documentBlobName = `${workspace.id}/${jobId}/source-document.json`
  await server.jobs.blobs.putImmutable(documentBlobName, Buffer.from(JSON.stringify(document)), 'application/json')
  const rubricId = `rubric-${jobId}`
  const citation = {
    documentId: document.id,
    documentVersion: 1,
    paragraphId: 'paragraph-1',
    page: 1,
    heading: 'Requirements',
    quote: 'Must lead distributed systems delivery.',
  }
  const rubric = {
    id: rubricId,
    groupId: rubricId,
    kind: 'job',
    jobId,
    name: 'Principal Engineer rubric',
    description: 'Grounded requirements',
    version: 1,
    criteria: [{
      id: 'criterion-1',
      key: 'custom',
      label: 'Distributed systems leadership',
      description: 'Leads distributed systems delivery.',
      weight: 100,
      guidance: guidance('distributed systems leadership evidence'),
      requirementType: 'required',
      sourceParagraphId: 'paragraph-1',
      sourceCitations: [citation],
    }],
    createdAt: '2026-09-23T14:00:00.000Z',
    dataKind: 'real',
    provenance: { kind: 'generated', model: 'gpt-test', promptVersion: 'rubric-v1' },
  }
  const readyRecord = {
    ...current.record,
    displayName: 'Principal Engineer',
    job: { ...current.record.job, status: 'ready', rubricId, title: 'Principal Engineer' },
    extractedBlobName: documentBlobName,
    nextAttemptAt: undefined,
    updatedAt: '2026-09-23T14:00:00.000Z',
  }
  const ready = await server.jobs.store.publish(readyRecord, current.etag, rubric)
  return { workspace, jobId, document, rubric, ready, citation }
}

function assistRequest(seed, overrides = {}) {
  return {
    submissionId: randomUUID(),
    base: { rubricId: seed.rubric.id, version: seed.rubric.version },
    instruction: 'Make the rubric clearer.',
    conversation: [],
    focusCriterionId: null,
    draft: {
      name: seed.rubric.name,
      description: seed.rubric.description,
      criteria: seed.rubric.criteria.map(criterion => ({
        id: criterion.id,
        label: criterion.label,
        description: criterion.description,
        guidance: criterion.guidance,
        weight: criterion.weight,
        requirementType: criterion.requirementType,
        citation: { paragraphId: criterion.sourceCitations[0].paragraphId, quote: criterion.sourceCitations[0].quote },
      })),
    },
    ...overrides,
  }
}

async function postAssist(server, seed, body = assistRequest(seed), oid = ALLOWED_OID, headers = {}) {
  return fetch(`${server.baseUrl}/api/workspaces/${seed.workspace.id}/jobs/${seed.jobId}/rubric/assist`, {
    method: 'POST',
    headers: writeHeaders(oid, { 'content-type': 'application/json', ...headers }),
    body: JSON.stringify(body),
  })
}

test('rubric assistant is on by default and is controlled by the Admin settings switch, deployment and pause policy', async () => {
  const disabled = await startAssistServer({ configRubricAssistant: false })
  try {
    const seed = await seedReadyJob(disabled)
    const features = await (await fetch(`${disabled.baseUrl}/api/features`, { headers: authHeaders() })).json()
    assert.equal(features.rubricAssistant, false)
    assert.equal(features.deploymentCapabilities.rubricAssistant, false)
    const response = await postAssist(disabled, seed)
    assert.equal(response.status, 503)
    assert.match((await response.text()), /not enabled/)
  } finally { await disabled.close() }

  let calls = 0
  const enabled = await startAssistServer({ invoke: async (...args) => { calls += 1; return fakeInvoker()(...args) } })
  try {
    const seed = await seedReadyJob(enabled)
    const defaults = createDefaultAdminSettings()
    assert.equal('rubricAssistant' in defaults.features, false, 'Defaults keep their earlier shape; an absent key means on')
    const initial = await (await fetch(`${enabled.baseUrl}/api/features`, { headers: authHeaders() })).json()
    assert.equal(initial.rubricAssistant, true, 'On by default with no environment flag')
    assert.equal(initial.publicSettings.features.rubricAssistant, true)

    const off = createDefaultAdminSettings()
    off.features.rubricAssistant = false
    enabled.settings._set(off)
    const switchedOff = await (await fetch(`${enabled.baseUrl}/api/features`, { headers: authHeaders() })).json()
    assert.equal(switchedOff.rubricAssistant, false)
    assert.equal(switchedOff.publicSettings.features.rubricAssistant, false)
    assert.equal(switchedOff.deploymentCapabilities.rubricAssistant, true, 'The deployment can still offer it')
    const refused = await postAssist(enabled, seed)
    assert.equal(refused.status, 503)
    assert.match(await refused.text(), /turned off in Admin settings/)
    assert.equal(calls, 0, 'A switched-off assistant never calls the model')

    const on = createDefaultAdminSettings()
    on.features.rubricAssistant = true
    enabled.settings._set(on)
    assert.equal((await (await fetch(`${enabled.baseUrl}/api/features`, { headers: authHeaders() })).json()).rubricAssistant, true)

    const paused = createDefaultAdminSettings()
    paused.maintenance.pauseNewWork = true
    paused.maintenance.explanation = 'Maintenance window.'
    enabled.settings._set(paused)
    const features = await (await fetch(`${enabled.baseUrl}/api/features`, { headers: authHeaders() })).json()
    assert.equal(features.rubricAssistant, false)
    assert.equal(features.deploymentCapabilities.rubricAssistant, true)
  } finally { await enabled.close() }
})

test('rubric assistant enforces roles and csrf', async () => {
  const server = await startAssistServer()
  try {
    const seed = await seedReadyJob(server)
    for (const role of ['viewer', 'reviewer']) {
      server.directory._addMembership(seed.workspace.id, membershipFor(seed.workspace.id, { oid: OTHER_ALLOWED_OID, role }))
      assert.equal((await postAssist(server, seed, assistRequest(seed), OTHER_ALLOWED_OID)).status, 403)
    }
    server.directory._addMembership(seed.workspace.id, membershipFor(seed.workspace.id, { oid: OTHER_ALLOWED_OID, role: 'editor' }))
    assert.equal((await postAssist(server, seed, assistRequest(seed), OTHER_ALLOWED_OID)).status, 200)
    assert.equal((await postAssist(server, seed)).status, 200)
    const noCsrf = await fetch(`${server.baseUrl}/api/workspaces/${seed.workspace.id}/jobs/${seed.jobId}/rubric/assist`, {
      method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(assistRequest(seed)),
    })
    assert.equal(noCsrf.status, 403)
  } finally { await server.close() }
})

test('rubric assistant rejects invalid request bodies before model calls', async () => {
  const server = await startAssistServer()
  try {
    const seed = await seedReadyJob(server)
    const cases = [
      ['blank instruction', { instruction: '   ' }, /Describe the change/],
      ['oversized instruction', { instruction: 'x'.repeat(2001) }, /limited to 2,000 characters/],
      ['unknown field', { unexpected: true }, /Unrecognized key|unexpected/i],
      ['missing focus', { focusCriterionId: 'missing' }, /focused criterion/],
      ['too many turns', { conversation: Array.from({ length: 21 }, () => ({ role: 'user', text: 'hello' })) }, /at most 20/],
    ]
    for (const [, patch, message] of cases) {
      const response = await postAssist(server, seed, assistRequest(seed, patch))
      assert.equal(response.status, 400, await response.clone().text())
      assert.match(await response.text(), message)
    }
    assert.equal(server.invoke.calls.length, 0)
  } finally { await server.close() }
})

test('rubric assistant maps job state conflicts and not found', async () => {
  const server = await startAssistServer()
  try {
    const seed = await seedReadyJob(server)
    const unknown = await fetch(`${server.baseUrl}/api/workspaces/${seed.workspace.id}/jobs/job-${randomUUID()}/rubric/assist`, {
      method: 'POST', headers: writeHeaders(ALLOWED_OID, { 'content-type': 'application/json' }), body: JSON.stringify(assistRequest(seed)),
    })
    assert.equal(unknown.status, 404)

    await server.jobs.store.publish(seed.ready.record, seed.ready.etag, { ...seed.rubric, version: 2, name: 'Newer rubric' })
    assert.equal((await postAssist(server, seed)).status, 409)
  } finally { await server.close() }

  for (const mutate of [
    record => ({ ...record, job: { ...record.job, status: 'generating' } }),
    record => ({ ...record, job: { ...record.job, rubricDeletedAt: '2026-09-23T14:01:00.000Z' } }),
    record => ({ ...record, lifecycle: { archivedAt: '2026-09-23T14:01:00.000Z' } }),
  ]) {
    const scoped = await startAssistServer()
    try {
      const seed = await seedReadyJob(scoped)
      const key = `${seed.workspace.id}/${seed.jobId}`
      const current = scoped.jobs.store._records.get(key)
      scoped.jobs.store._records.set(key, { ...current, record: mutate(current.record) })
      assert.equal((await postAssist(scoped, seed)).status, 409)
    } finally { await scoped.close() }
  }

  const archivedWorkspace = await startAssistServer()
  try {
    const seed = await seedReadyJob(archivedWorkspace)
    await archivedWorkspace.jobs.store.setWorkspaceLifecycle(seed.workspace.id, 'deleting', '2026-09-23T14:01:00.000Z')
    assert.equal((await postAssist(archivedWorkspace, seed)).status, 409)
  } finally { await archivedWorkspace.close() }
})

test('rubric assistant succeeds without writing stores and builds citations server-side', async () => {
  const server = await startAssistServer({ invoke: fakeInvoker([addedCriterionOutput()]) })
  const captured = []
  const originalError = console.error
  console.error = (...args) => { captured.push(args.map(String).join(' ')) }
  try {
    const seed = await seedReadyJob(server)
    const beforeEvents = server.jobs.publicationEvents.length
    const before = await server.jobs.store.get(seed.workspace.id, seed.jobId)
    const request = assistRequest(seed, { instruction: 'Add cloud operations.' })
    const response = await postAssist(server, seed, request)
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json()
    assert.equal(rubricAssistResponseSchema.safeParse(body).success, true)
    assert.equal(body.assistant.promptVersion, 'score-rubric-assist-v1')
    assert.equal(body.operations.some(operation => operation.type === 'addCriterion'), true)
    const added = body.operations.find(operation => operation.type === 'addCriterion').criterion
    assert.deepEqual(added.sourceCitations[0], {
      documentId: seed.document.id,
      documentVersion: 1,
      paragraphId: 'paragraph-2',
      page: 2,
      heading: 'Operations',
      quote: 'Must operate Azure services for production workloads.',
    })
    const modelRequest = server.invoke.calls[0].request
    assert.ok(modelRequest.user.indexOf('Must lead distributed systems delivery.') < modelRequest.user.indexOf('CURRENT DRAFT:'))
    assert.equal(modelRequest.user.includes('client-document-id'), false)
    assert.equal(server.jobs.publicationEvents.length, beforeEvents)
    assert.deepEqual(await server.jobs.store.get(seed.workspace.id, seed.jobId), before)
    assert.equal(captured.some(line => line.includes(request.instruction)), false)
  } finally {
    console.error = originalError
    await server.close()
  }
})

test('rubric assistant maps invalid model output, provider throttling, and per-user limiter', async () => {
  const invalidSettings = createDefaultAdminSettings()
  invalidSettings.ai.jobRubric.maxOutputCorrections = 1
  const invalid = await startAssistServer({ settings: invalidSettings, invoke: fakeInvoker(['{"not":"valid"}', '{"still":"invalid"}']) })
  try {
    const seed = await seedReadyJob(invalid)
    const before = await invalid.jobs.store.get(seed.workspace.id, seed.jobId)
    const response = await postAssist(invalid, seed)
    assert.equal(response.status, 502, await response.clone().text())
    assert.deepEqual(await invalid.jobs.store.get(seed.workspace.id, seed.jobId), before)
  } finally { await invalid.close() }

  const retryAt = new Date(Date.now() + 45_000).toISOString()
  const throttled = await startAssistServer({ invoke: fakeInvoker([() => { throw { code: 'rate-limit', httpStatus: 429, retryAt } }]) })
  try {
    const seed = await seedReadyJob(throttled)
    const response = await postAssist(throttled, seed)
    assert.equal(response.status, 429)
    assert.ok(Number(response.headers.get('retry-after')) >= 1)
  } finally { await throttled.close() }

  const gate = deferred()
  const limiterServer = await startAssistServer({ invoke: fakeInvoker([async (_request, signal) => {
    await gate.promise
    if (signal.aborted) throw new AssistCancelledError()
    return { content: changedLabelOutput('Concurrent label'), model: 'fake-model' }
  }]) })
  try {
    const seed = await seedReadyJob(limiterServer)
    const first = postAssist(limiterServer, seed)
    while (limiterServer.invoke.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    const second = await postAssist(limiterServer, seed)
    assert.equal(second.status, 429)
    gate.resolve()
    assert.equal((await first).status, 200)
  } finally { await limiterServer.close() }
})

test('rubric assistant does not hold the workspace mutation lease while the model is pending', async () => {
  const gate = deferred()
  const server = await startAssistServer({ invoke: fakeInvoker([async () => {
    await gate.promise
    return { content: changedLabelOutput('Lease-free label'), model: 'fake-model' }
  }]) })
  try {
    const seed = await seedReadyJob(server)
    const first = postAssist(server, seed)
    while (server.invoke.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    const save = await fetch(`${server.baseUrl}/api/workspaces/${seed.workspace.id}/jobs/${seed.jobId}/rubric`, {
      method: 'PUT',
      headers: writeHeaders(ALLOWED_OID, { 'content-type': 'application/json', 'if-match': seed.ready.etag }),
      body: JSON.stringify({ rubric: { ...seed.rubric, name: 'Saved while assistant pending' } }),
    })
    assert.equal(save.status, 200, await save.clone().text())
    gate.resolve()
    assert.equal((await first).status, 200)
  } finally { await server.close() }
})

test('rubric assistant aborts the model call when the client disconnects', async () => {
  const abortObserved = deferred()
  const server = await startAssistServer({ invoke: fakeInvoker([async (_request, signal) => {
    signal.addEventListener('abort', () => abortObserved.resolve(), { once: true })
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
  }]) })
  try {
    const seed = await seedReadyJob(server)
    const controller = new AbortController()
    const request = fetch(`${server.baseUrl}/api/workspaces/${seed.workspace.id}/jobs/${seed.jobId}/rubric/assist`, {
      method: 'POST',
      headers: writeHeaders(ALLOWED_OID, { 'content-type': 'application/json' }),
      body: JSON.stringify(assistRequest(seed)),
      signal: controller.signal,
    }).catch(error => error)
    while (server.invoke.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await abortObserved.promise
    const result = await request
    assert.equal(result.name, 'AbortError')
    assert.equal(server.invoke.calls[0].signal.aborted, true)
  } finally { await server.close() }
})
