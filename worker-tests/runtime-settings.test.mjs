import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsDomain, settingsSnapshot } from './runtime-settings-test-support.mjs'

const [{ invokeStructuredModel }, policies, stores] = await Promise.all([
  loadWorker('../worker/model-transport.ts'), loadWorker('../worker/settings.ts'), loadWorker('../worker/settings-store.ts'),
])
const request = {
  name: 'settings_probe', schema: { type: 'object', properties: {}, additionalProperties: false },
  system: 'Return strict JSON.', user: 'Complete source.', source: 'Complete source.', maxCompletionTokens: 12,
}
const bootstrap = { endpoint: 'https://fixed-resource.openai.azure.com', deployment: 'bootstrap', modelName: 'gpt-5-mini', getToken: async () => 'not-a-real-token' }
const success = () => Response.json({ model: 'actual-response-model-2026', choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })

test('all eleven explicit tasks use independently frozen deployments, budgets and request parameters at the fixed resource', async () => {
  const snapshot = settingsSnapshot(settings => {
    settings.ai.tasks.assessment.reasoningEffort = 'high'
    settings.ai.tasks.assessmentReview.reasoningEffort = null
  })
  const seen = []
  for (const taskId of settingsDomain.MODEL_TASK_IDS) {
    const result = await invokeStructuredModel({
      ...bootstrap, processingSettings: snapshot, fetch: async (url, init) => {
        seen.push(taskId)
        assert.equal(url, `${bootstrap.endpoint}/openai/v1/chat/completions`)
        const body = JSON.parse(init.body)
        assert.equal(body.model, `deployment-${taskId}`)
        assert.equal(body.max_completion_tokens, snapshot.tasks[taskId].completionTokenLimit)
        assert.equal(body.reasoning_effort, snapshot.tasks[taskId].reasoningEffort ?? undefined)
        assert.equal(body.response_format.json_schema.strict, true)
        assert.equal(body.temperature, undefined)
        assert.equal(body.top_p, undefined)
        assert.equal(init.redirect, 'error')
        return success()
      },
    }, { ...request, taskId })
    assert.equal(result.model, 'actual-response-model-2026')
  }
  assert.equal(new Set(seen).size, 11)
})

test('only capability-supported temperature/topP are sent; invalid explicit snapshots never acquire a token or fall back', async () => {
  const snapshot = settingsSnapshot(settings => {
    const deployment = settings.ai.deployments.find(value => value.id === 'assessment')
    deployment.modelName = 'gpt-4.1'
    deployment.capabilities = settingsDomain.modelCapabilitiesFor('gpt-4.1')
    Object.assign(settings.ai.tasks.assessment, { reasoningEffort: null, temperature: 0.2 })
  })
  await invokeStructuredModel({
    ...bootstrap, processingSettings: snapshot, fetch: async (_url, init) => {
      const body = JSON.parse(init.body)
      assert.equal(body.temperature, 0.2)
      assert.equal(body.top_p, undefined)
      assert.equal(body.reasoning_effort, undefined)
      return success()
    },
  }, { ...request, taskId: 'assessment' })
  const topP = structuredClone(snapshot.settings)
  Object.assign(topP.ai.tasks.assessment, { temperature: null, topP: 0.8 })
  await invokeStructuredModel({
    ...bootstrap,
    processingSettings: settingsDomain.captureProcessingSettings(topP, 'top-p-test', snapshot.capturedAt),
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(init.body).top_p, 0.8)
      assert.equal(JSON.parse(init.body).temperature, undefined)
      return success()
    },
  }, { ...request, taskId: 'assessment' })
  for (const corrupt of [
    value => { value.settings.ai.tasks.assessment.deploymentId = 'missing' },
    value => { value.tasks.assessment.deploymentName = 'substituted' },
    value => { value.settings.ai.tasks.assessmentReview.temperature = 0.3 },
    value => { value.tasks.assessment.completionTokenLimit = 999_999 },
  ]) {
    const invalid = structuredClone(snapshot)
    corrupt(invalid)
    await assert.rejects(invokeStructuredModel({
      ...bootstrap, processingSettings: invalid,
      getToken: async () => assert.fail('invalid settings must be rejected before inference/authentication'),
      fetch: async () => assert.fail('invalid settings cannot call a model'),
    }, { ...request, taskId: 'assessment' }), error => error.code === 'settings-invalid')
  }
  await assert.rejects(invokeStructuredModel({ ...bootstrap, processingSettings: snapshot }, request), error => error.code === 'settings-invalid')
  await assert.rejects(invokeStructuredModel({
    ...bootstrap, processingSettings: null, getToken: async () => assert.fail('an explicit null pin is invalid'),
  }, { ...request, taskId: 'assessment' }), error => error.code === 'settings-invalid')
  assert.throws(() => policies.operationSettings({ processingSettings: null }, {}), error => error.code === 'settings-invalid')
})

test('source units and complete serialized schema/request budgets fail explicitly without clipping', async () => {
  const snapshot = settingsSnapshot(settings => {
    for (const task of ['jobRubric', 'resumeProfile']) {
      Object.assign(settings.ai.tasks[task].inputBudget, { maxInput: 10, maxRequest: 1000 })
    }
  })
  let calls = 0
  const model = { ...bootstrap, processingSettings: snapshot, fetch: async () => { calls++; return success() } }
  await invokeStructuredModel(model, { ...request, taskId: 'jobRubric', source: 'é'.repeat(6) })
  await assert.rejects(invokeStructuredModel(model, { ...request, taskId: 'resumeProfile', source: 'é'.repeat(6) }),
    error => error.code === 'model-context-limit' && /No evidence was truncated/.test(error.message))
  await assert.rejects(invokeStructuredModel(model, {
    ...request, taskId: 'jobRubric', source: 'short', schema: { ...request.schema, description: 'schema '.repeat(200) },
  }), error => error.code === 'model-context-limit')
  assert.equal(calls, 1)
})

test('model transport attempts are pinned independently of output repair and actual model identity is mandatory', async () => {
  const snapshot = settingsSnapshot(settings => { settings.ai.transport.maxAttempts = 1 })
  let calls = 0
  await assert.rejects(invokeStructuredModel({
    ...bootstrap, processingSettings: snapshot, fetch: async () => { calls++; return new Response('', { status: 503 }) },
  }, { ...request, taskId: 'jobRubric' }), error => error.status === 503)
  assert.equal(calls, 1)
  await assert.rejects(invokeStructuredModel({
    ...bootstrap, processingSettings: snapshot,
    fetch: async () => Response.json({ choices: [{ message: { content: '{}' } }] }),
  }, { ...request, taskId: 'jobRubric' }), error => error.code === 'model-invalid-response')
})

test('transport retry deadlines and task bindings use a frozen copy, not a mutable caller object', async () => {
  const mutable = structuredClone(settingsSnapshot())
  let calls = 0
  await invokeStructuredModel({
    ...bootstrap, processingSettings: mutable,
    clock: { now: () => new Date(), sleep: async () => {} },
    fetch: async (_url, init) => {
      calls++
      assert.equal(JSON.parse(init.body).model, 'deployment-assessment')
      if (calls === 1) {
        mutable.settings.ai.requestTimeoutMilliseconds = 1
        mutable.tasks.assessment.deploymentName = 'a-different-deployment'
        return new Response('', { status: 429 })
      }
      await new Promise(resolve => setTimeout(resolve, 20))
      return success()
    },
  }, { ...request, taskId: 'assessment' })
  assert.equal(calls, 2)
})

test('model request deadline covers a response body that never completes', async () => {
  const snapshot = settingsSnapshot(settings => {
    settings.ai.transport.maxAttempts = 1
    settings.ai.requestTimeoutMilliseconds = 1000
  })
  await assert.rejects(invokeStructuredModel({
    ...bootstrap, processingSettings: snapshot,
    fetch: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
  }, { ...request, taskId: 'jobRubric' }), error => error.code === 'request-timeout' && error.retryable)
})

test('legacy operations use the immutable bootstrap revision, not a later current default or activation flag', async () => {
  const legacy = policies.createLegacyWorkerSettings({ ...bootstrap, deployment: 'original-environment-deployment', reasoningEffort: 'low' })
  let current = settingsSnapshot()
  let legacyReads = 0
  const reader = stores.createWorkerSettingsReader(legacy, {
    getCurrent: async () => ({ etag: 'etag', revision: { revision: current.revision, settings: current.settings, createdAt: current.capturedAt } }),
    getRevision: async id => {
      legacyReads++
      assert.equal(id, 'legacy-v1')
      return { revision: legacy.revision, settings: legacy.settings, createdAt: legacy.capturedAt }
    },
  })
  await reader.current()
  const pinned = policies.operationSettings({ processingSettings: current }, { settings: reader })
  current = settingsSnapshot(settings => {
    settings.ai.tasks.jobRubric.deploymentId = 'gradeDraft'
    settings.processing.jobs.maxAutomaticAttempts = 1
    settings.workers.jobs.pauseClaiming = true
  }, 'runtime-test-v2')
  await reader.current()
  assert.equal(policies.operationSettings({}, { settings: reader }).tasks.jobRubric.deploymentName, 'original-environment-deployment')
  assert.equal(pinned.tasks.jobRubric.deploymentName, 'deployment-jobRubric')
  assert.equal(pinned.settings.processing.jobs.maxAutomaticAttempts, 3)
  assert.equal(legacyReads, 1)
  assert.ok(Object.isFrozen(pinned.settings.ai.tasks.jobRubric))
  assert.equal(policies.retryBackoff(pinned, 'jobs', 3), 60_000)
  assert.equal(stores.workerSettingsContainer({ SCORE_SETTINGS_CONTAINER: 'application-settings', SCORE_RUNTIME_SETTINGS_ENABLED: 'false' }), 'application-settings')
  assert.throws(() => stores.workerSettingsContainer({ SCORE_SETTINGS_CONTAINER: 'job-records' }), /dedicated/)
})

test('API and worker legacy captures share a stable persisted timestamp and ignore later clocks, environment and defaults', async () => {
  const { AdminSettingsService } = await loadWorker('../server/settings/service.ts')
  const original = policies.createLegacyWorkerSettings({ ...bootstrap, deployment: 'original-environment', reasoningEffort: 'low' })
  const changed = policies.createLegacyWorkerSettings({ ...bootstrap, deployment: 'changed-environment', reasoningEffort: 'low' })
  const baseline = {
    revision: settingsDomain.LEGACY_SETTINGS_REVISION, previousRevision: null,
    createdAt: '2026-09-01T00:00:00.000Z', actor: { system: 'initialization' },
    reason: 'initialize', changes: [], settings: original.settings,
  }
  let current = settingsSnapshot(() => {}, 'mutable-current-one')
  let now = '2026-09-20T00:00:00.000Z'
  const store = {
    getCurrent: async () => ({ etag: 'current-etag', revision: {
      ...baseline, revision: current.revision, createdAt: current.capturedAt, settings: current.settings,
    } }),
    getRevision: async revision => {
      assert.equal(revision, settingsDomain.LEGACY_SETTINGS_REVISION)
      return structuredClone(baseline)
    },
    initialize: async () => assert.fail('Existing immutable legacy policy must not be initialized again'),
  }
  const worker = stores.createWorkerSettingsReader(changed, store)
  await worker.current()
  const service = new AdminSettingsService({
    config: { settings: { defaults: changed.settings } }, store, now: () => new Date(now),
  })
  const first = await service.captureLegacy()
  now = '2026-10-01T00:00:00.000Z'
  current = settingsSnapshot(settings => { settings.processing.jobs.maxAutomaticAttempts = 1 }, 'mutable-current-two')
  await worker.current()
  assert.deepEqual(await service.captureLegacy(), first)
  assert.deepEqual(worker.legacy, first)
  assert.equal(first.capturedAt, baseline.createdAt)
  assert.equal(first.tasks.jobRubric.deploymentName, 'original-environment')
  assert.equal(first.settings.processing.jobs.maxAutomaticAttempts, 3)
  assert.equal(original.capturedAt, settingsDomain.LEGACY_SETTINGS_CAPTURED_AT)
  assert.equal(changed.capturedAt, settingsDomain.LEGACY_SETTINGS_CAPTURED_AT)
  assert.ok(Object.isFrozen(first.settings))
  assert.ok(Object.isFrozen(worker.legacy.settings))
})

test('missing, invalid or unreadable live tuning never falls back to a legacy policy', async () => {
  const legacy = settingsSnapshot()
  for (const read of [async () => undefined, async () => { throw new Error('read unavailable') }]) {
    const reader = stores.createWorkerSettingsReader(legacy, { getCurrent: read, getRevision: async () => undefined })
    await assert.rejects(policies.executionSettings({ settings: reader }, 'jobs', { maxItems: 4, budgetMilliseconds: 660_000 }))
  }
  await assert.rejects(policies.executionSettings({
    settings: { legacy, current: async () => ({ ...legacy, tasks: {} }) },
  }, 'jobs', { maxItems: 4, budgetMilliseconds: 660_000 }), error => error.code === 'settings-invalid')
})

test('configured readers use saved policies without validating unused environment bootstrap inputs', async () => {
  const legacy = settingsSnapshot(() => {}, 'legacy-v1')
  const current = settingsSnapshot(settings => {
    settings.workers.analyses.budgetMilliseconds = 300_000
    settings.summaries.operationTimeoutMilliseconds = 299_000
  }, 'saved-budget-policy')
  const conflicting = structuredClone(legacy)
  conflicting.settings.workers.analyses.budgetMilliseconds = 300_000
  assert.throws(() => policies.validateProcessingSettings(conflicting), error => error.code === 'settings-invalid')
  const reader = stores.createWorkerSettingsReader(conflicting, {
    getCurrent: async () => ({ etag: 'stored', revision: {
      revision: current.revision, settings: current.settings, createdAt: current.capturedAt,
    } }),
    getRevision: async () => ({
      revision: legacy.revision, settings: legacy.settings, createdAt: legacy.capturedAt,
    }),
  })
  const tuning = await policies.executionSettings({ settings: reader }, 'analyses', { maxItems: 1, budgetMilliseconds: 1000 })
  assert.equal(tuning.budgetMilliseconds, 300_000)
  assert.deepEqual(reader.legacy, legacy)
  const configured = stores.createAzureWorkerSettings({
    settingsContainer: 'application-settings',
    stores: { cosmosEndpoint: 'https://score.documents.azure.com', database: 'score' },
  }, { getToken: async () => assert.fail('Factory construction must not request Azure credentials.') }, {
    get deployment() { return assert.fail('Configured readers must not read environment model defaults.') },
    get modelName() { return assert.fail('Configured readers must not validate an unused environment model.') },
  })
  assert.equal(configured.mode, 'configured')
  assert.throws(() => configured.legacy, /must be loaded/)
})

test('unconfigured execution retains legacy environment budgets without weakening saved-policy constraints', async () => {
  const reader = stores.createAzureWorkerSettings({
    stores: { cosmosEndpoint: 'https://unused.documents.azure.com', database: 'score' },
  }, { getToken: async () => assert.fail('Unconfigured compatibility must not access Azure.') }, {
    ...bootstrap, deployment: 'environment-model', reasoningEffort: 'low',
  })
  assert.equal(reader.mode, 'unconfigured')
  assert.equal(reader.legacy.tasks.assessment.deploymentName, 'environment-model')
  const captured = structuredClone(reader.legacy)
  for (const kind of ['jobs', 'grades', 'resumes', 'analyses']) {
    for (const budgetMilliseconds of [1000, 300_000]) {
      assert.deepEqual(await policies.executionSettings({ settings: reader }, kind, { maxItems: 7, budgetMilliseconds }), {
        maxItemsPerExecution: 7, budgetMilliseconds, pauseClaiming: false,
      })
    }
  }
  assert.deepEqual(reader.legacy, captured)
  const invalidSavedPolicy = structuredClone(reader.legacy.settings)
  invalidSavedPolicy.workers.analyses.budgetMilliseconds = 1000
  assert.throws(() => settingsDomain.captureProcessingSettings(invalidSavedPolicy, 'invalid-short-budget', captured.capturedAt))
})

test('all four readers load execution tuning once and pause before any new claim', async () => {
  const modules = await Promise.all([
    loadWorker('../worker/runtime.ts'), loadWorker('../worker/grades/runtime.ts'),
    loadWorker('../worker/resumes/runtime.ts'), loadWorker('../worker/analyses/runtime.ts'),
  ])
  const functions = [modules[0].runWorker, modules[1].runGradeWorker, modules[2].runResumeWorker, modules[3].runAnalysisWorker]
  for (const [index, run] of functions.entries()) {
    let reads = 0
    const snapshot = settingsSnapshot(settings => {
      for (const kind of ['jobs', 'grades', 'resumes', 'analyses']) settings.workers[kind].pauseClaiming = true
    })
    const deps = {
      settings: { legacy: snapshot, current: async () => { reads++; return snapshot } },
      store: { getWorkspaceLifecycle: async () => ({ state: 'active' }), listPending: async () => assert.fail('paused workers cannot claim') },
    }
    assert.equal((await run(deps)).claimed, 0)
    assert.equal(reads, 1)
    assert.equal(modules[index].RUNTIME_SETTINGS_VERSION, 'score-runtime-settings-v1')
    await assert.rejects(run({
      ...deps, settings: { legacy: snapshot, current: async () => { throw new Error('Settings read denied') } },
    }), /Settings read denied/)
  }
})

test('safe logging metadata cannot include private evidence, URLs or credentials', async t => {
  const snapshot = settingsSnapshot(settings => { settings.logging.detail = 'diagnostic-metadata' })
  const metadata = policies.safeSettingsMetadata(snapshot, 'jobRubric')
  assert.equal(metadata.taskId, 'jobRubric')
  assert.ok(metadata.inputBudget)
  assert.doesNotMatch(JSON.stringify(metadata), /endpoint|secret|authorization|accessToken|paragraph|quote|https:/i)
  const normal = settingsSnapshot()
  assert.equal(policies.safeSettingsMetadata(normal, 'jobRubric').inputBudget, undefined)
  const events = []
  t.mock.method(console, 'info', (...event) => events.push(event))
  for (const processingSettings of [normal, snapshot]) {
    await invokeStructuredModel({ ...bootstrap, processingSettings, fetch: async () => success() },
      { ...request, taskId: 'jobRubric', user: 'PRIVATE-SOURCE-SENTINEL' })
  }
  assert.deepEqual(events, [['Score model settings:', metadata]])
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-SOURCE-SENTINEL|endpoint|accessToken|authorization|https:/i)
})

test('captured extraction submission attempts and total poll deadline do not reset per response', async () => {
  const { submitPdfLayout, pollPdfLayout } = await loadWorker('../worker/runtime.ts')
  const snapshot = settingsSnapshot(settings => {
    settings.extraction.transport.maxAttempts = 1
    settings.extraction.pollTimeoutMilliseconds = 2000
  })
  let elapsed = 0
  let submissions = 0
  let polls = 0
  const options = policies.extractionSettings({
    endpoint: 'https://extract.example', getToken: async () => 'test-token',
    clock: { now: () => new Date(elapsed), sleep: async milliseconds => { elapsed += milliseconds } },
    fetch: async (_url, init) => {
      if (init.method === 'POST') { submissions++; return new Response('', { status: 503 }) }
      polls++
      return Response.json({ status: 'running' })
    },
  }, snapshot)
  await assert.rejects(submitPdfLayout(Buffer.from('%PDF-1.7'), options))
  assert.equal(submissions, 1)
  await assert.rejects(pollPdfLayout('https://extract.example/operations/one', options), error => error.code === 'ocr-timeout')
  assert.equal(polls, 1)
  assert.equal(elapsed, 2000)
})

test('reference originals preserve their independent byte budget while applying captured URL rules', async () => {
  const { fetchOriginalUrl } = await loadWorker('../worker/references/transport.ts')
  const limits = []
  const original = await fetchOriginalUrl('https://agency.example/reference', {
    processingSettings: settingsSnapshot(),
    fetcher: async (url, options) => {
      limits.push(options.maxBytes)
      return { url, status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-1.7') }
    },
  })
  assert.equal(original.contentType, 'application/pdf')
  assert.deepEqual(limits, [20 * 1024 * 1024])
  await assert.rejects(fetchOriginalUrl('https://agency.example/reference', {
    processingSettings: settingsSnapshot(settings => {
      settings.grades.references.maxPdfBytes = 1024
      settings.imports.urls.agencyReferences.blockedHosts = [{ hostname: 'agency.example', includeSubdomains: true }]
    }),
    fetcher: async () => assert.fail('blocked agency hosts never reach reference transport'),
  }), error => error.code === 'unsafe-url')
})

test('reference transport accepts the full dedicated byte ceiling and rejects overflow independently of generic URL budgets', async () => {
  const { fetchOriginalUrl } = await loadWorker('../worker/references/transport.ts')
  const { safeFetch } = await loadWorker('../worker/runtime.ts')
  const referenceLimit = 20 * 1024 * 1024
  const pdf = Buffer.alloc(referenceLimit + 1, 0x20)
  pdf.write('%PDF-1.7\n')
  for (const genericLimit of [12 * 1024 * 1024, 1024]) {
    const snapshot = settingsSnapshot(settings => { settings.imports.urls.maxResponseBytes = genericLimit })
    let body = pdf.subarray(0, referenceLimit)
    const network = {
      resolver: async () => ['93.184.216.34'],
      transport: async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body }),
    }
    const fetcher = (url, request) => safeFetch(url, {
      ...policies.fetchSettings(network, snapshot, 'agencyReferences'), ...request,
    })
    const original = await fetchOriginalUrl('https://agency.example/reference.pdf', { processingSettings: snapshot, fetcher })
    assert.equal(original.bytes.byteLength, referenceLimit)
    assert.deepEqual(original.bytes, body)
    for (const scope of ['jobs', 'resumes']) {
      await assert.rejects(safeFetch('https://agency.example/reference.pdf', policies.fetchSettings(network, snapshot, scope)),
        error => error.code === 'source-too-large')
    }
    body = pdf
    await assert.rejects(fetchOriginalUrl('https://agency.example/reference.pdf', { processingSettings: snapshot, fetcher }),
      error => error.code === 'source-too-large')
  }
})

test('scoped URL policies precede DNS at each redirect and cannot bypass public-address protections', async () => {
  const { safeFetch } = await loadWorker('../worker/runtime.ts')
  const snapshot = settingsSnapshot(settings => {
    settings.imports.urls.requireHttps = true
    settings.imports.urls.jobs.allowedHosts = [{ hostname: 'example.com', includeSubdomains: true }]
    settings.imports.urls.jobs.blockedHosts = [{ hostname: 'blocked.example.com', includeSubdomains: true }]
  })
  for (const redirect of ['http://jobs.example.com/downgrade', 'https://bad.blocked.example.com/job', 'https://elsewhere.example/job']) {
    const resolved = []
    const options = policies.fetchSettings({
      resolver: async hostname => { resolved.push(hostname); return ['93.184.216.34'] },
      transport: async () => ({ status: 302, headers: { location: redirect }, body: new Uint8Array() }),
    }, snapshot, 'jobs')
    await assert.rejects(safeFetch('https://jobs.example.com/job', options), error => error.code === 'unsafe-url')
    assert.deepEqual(resolved, ['jobs.example.com'])
  }
  await assert.rejects(safeFetch('https://jobs.example.com/job', policies.fetchSettings({
    resolver: async () => ['10.0.0.1'], transport: async () => assert.fail('host policy cannot permit private DNS'),
  }, snapshot, 'jobs')), error => error.code === 'unsafe-url')
})

test('current settings reader never exposes a potentially changed bootstrap in place of stored legacy settings', async () => {
  const bootstrap = settingsSnapshot()
  const reader = stores.createWorkerSettingsReader(bootstrap, {
    getCurrent: async () => ({ revision: { revision: bootstrap.revision, settings: bootstrap.settings, createdAt: bootstrap.capturedAt } }),
    getRevision: async () => undefined,
  })
  assert.throws(() => reader.legacy, /must be loaded/)
  await assert.rejects(reader.current(), /legacy settings baseline is missing/)
})
