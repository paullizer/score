import assert from 'node:assert/strict'
import test from 'node:test'
import {
  StoreConflictError, createAzureSettingsModelAdapter, createDefaultAdminSettings, createSettingsReaderFromContainer, createSettingsStoreFromContainer,
  resolveTaskModel,
} from '../dist-server/app.mjs'

const time = '2026-09-21T12:00:00.000Z'
function revision(id = 'legacy-v1', previousRevision = null) {
  return {
    revision: id, previousRevision, createdAt: time, actor: { system: 'initialization' },
    reason: previousRevision ? 'patch' : 'initialize', changes: [], settings: createDefaultAdminSettings(),
  }
}
function cosmos() {
  const documents = new Map()
  const calls = []
  let sequence = 0
  let readFailure = false
  let transactionFailure = false
  const container = {
    item(id, partition) {
      assert.equal(partition, 'score')
      return {
        async read() {
          calls.push(['read', id])
          if (readFailure) return { statusCode: 503 }
          const doc = documents.get(id)
          return doc ? { statusCode: 200, resource: structuredClone(doc) } : { statusCode: 404 }
        },
      }
    },
    items: {
      async batch(operations, partition) {
        assert.equal(partition, 'score')
        calls.push(['batch', structuredClone(operations)])
        assert.equal(operations.length, 3)
        assert.equal(operations[1].operationType, 'Create')
        assert.equal(operations[2].operationType, 'Create')
        if (transactionFailure) return { code: 503, result: [{ statusCode: 424 }, { statusCode: 503 }, { statusCode: 424 }] }
        const next = new Map(documents)
        const results = []
        for (const operation of operations) {
          const id = operation.id ?? operation.resourceBody.id
          const existing = next.get(id)
          let status
          if (operation.operationType === 'Create' && existing) status = 409
          else if (operation.operationType === 'Replace' && !existing) status = 404
          else if (operation.operationType === 'Replace' && existing._etag !== operation.ifMatch) status = 412
          if (status) {
            const failed = operations.map((_, index) => ({ statusCode: index === results.length ? status : 424 }))
            return { code: status, result: failed }
          }
          const etag = `"cosmos-${++sequence}"`
          next.set(id, { ...structuredClone(operation.resourceBody), _etag: etag, _rid: 'system-only', _ts: 1 })
          results.push({ statusCode: operation.operationType === 'Create' ? 201 : 200, eTag: etag })
        }
        documents.clear()
        for (const [id, document] of next) documents.set(id, document)
        return { code: 200, result: results }
      },
      query(query, options) {
        assert.equal(options.partitionKey, 'score')
        return {
          async fetchAll() {
            const before = query.parameters.find(parameter => parameter.name === '@before')?.value
            const limit = query.parameters.find(parameter => parameter.name === '@limit').value
            return { resources: [...documents.values()]
              .filter(document => document.recordType === 'settings-audit' && (!before || document.revision < before))
              .sort((a, b) => b.revision.localeCompare(a.revision)).slice(0, limit).map(document => structuredClone(document)) }
          },
        }
      },
    },
  }
  return {
    container, documents, calls,
    setReadFailure(value) { readFailure = value },
    setTransactionFailure(value) { transactionFailure = value },
  }
}

test('Cosmos settings transaction keeps pointer, immutable revision, and audit in one application partition', async () => {
  const fake = cosmos()
  const store = createSettingsStoreFromContainer(fake.container)
  assert.equal(await store.getCurrent(), undefined)
  assert.equal(await store.initialize(revision()), true)
  assert.equal(await store.initialize(revision()), false)
  assert.equal(fake.documents.size, 3)
  const first = await store.getCurrent()
  assert.equal(first.revision.revision, 'legacy-v1')
  assert.equal('_etag' in first.revision, false)
  const next = revision('r-20260921120000000-next', first.revision.revision)
  next.settings.appearance.applicationTitle = 'Next title'
  const updated = await store.publish(next, first.etag)
  assert.equal(updated.revision.settings.appearance.applicationTitle, 'Next title')
  assert.equal(fake.documents.size, 5)
  assert.equal((await store.getRevision('legacy-v1')).settings.appearance.applicationTitle, 'Score')
  const page = await store.history(1)
  assert.equal(page.revisions[0].revision, next.revision)
  assert.equal((await store.history(1, page.nextBefore)).revisions[0].revision, 'legacy-v1')
  assert.equal('settings' in page.revisions[0], false)
  const operations = fake.calls.filter(call => call[0] === 'batch').at(-1)[1]
  assert.equal(operations[0].ifMatch, first.etag)
  assert.equal(operations[1].resourceBody.recordType, 'settings-revision')
  assert.equal(operations[2].resourceBody.recordType, 'settings-audit')
})

test('Cosmos CAS failures and transaction failures never leave revision/audit documents without publication', async () => {
  const fake = cosmos()
  const store = createSettingsStoreFromContainer(fake.container)
  await store.initialize(revision())
  const first = await store.getCurrent()
  await assert.rejects(store.publish(revision('r-stale', 'legacy-v1'), '"wrong"'), StoreConflictError)
  assert.equal(fake.documents.size, 3)
  fake.setTransactionFailure(true)
  await assert.rejects(store.publish(revision('r-failed', 'legacy-v1'), first.etag), /transaction did not succeed/)
  assert.equal(fake.documents.size, 3)
  assert.equal((await store.getCurrent()).etag, first.etag)
  fake.setTransactionFailure(false)
  fake.setReadFailure(true)
  await assert.rejects(store.getCurrent(), /invalid document response/)
})

test('worker reader has no initialization or publication surface and never writes an absent store', async () => {
  const fake = cosmos()
  const reader = createSettingsReaderFromContainer(fake.container)
  assert.deepEqual(Object.keys(reader).sort(), ['getCurrent', 'getRevision'])
  assert.equal(await reader.getCurrent(), undefined)
  assert.equal(await reader.getRevision('legacy-v1'), undefined)
  assert.equal(fake.calls.some(call => call[0] === 'batch'), false)
  const store = createSettingsStoreFromContainer(fake.container)
  await store.initialize(revision())
  const writes = fake.calls.filter(call => call[0] === 'batch').length
  assert.equal((await reader.getCurrent()).revision.revision, 'legacy-v1')
  assert.equal((await reader.getRevision('legacy-v1')).settings.ai.defaultDeploymentId, 'default')
  assert.equal(fake.calls.filter(call => call[0] === 'batch').length, writes)
})

test('corrupt current pointers and immutable revision conflicts cannot be reinterpreted as uninitialized settings', async () => {
  const fake = cosmos()
  const store = createSettingsStoreFromContainer(fake.container)
  fake.documents.set('current', {
    id: 'current', applicationId: 'score', recordType: 'settings-current', revision: 'missing', _etag: '"etag"',
  })
  await assert.rejects(store.getCurrent(), /missing immutable revision/)
  fake.documents.delete('current')
  fake.documents.set('revision:legacy-v1', { id: 'revision:legacy-v1' })
  await assert.rejects(store.initialize(revision()), /transaction did not succeed/)
  assert.equal(fake.documents.has('current'), false)
})

const resourceId = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/score/providers/Microsoft.CognitiveServices/accounts/score-models'
const resource = { endpoint: 'https://score-models.openai.azure.com', resourceId, deploymentName: 'job-rubric', modelName: 'gpt-5-mini' }
function azure(fetcher) {
  const scopes = []
  const calls = []
  const adapter = createAzureSettingsModelAdapter({
    resource, now: () => new Date(time),
    credential: { async getToken(scope) { scopes.push(scope); return { token: 'synthetic-managed-identity-token', expiresOnTimestamp: Date.now() + 60_000 } } },
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options) },
  })
  return { adapter, scopes, calls }
}
function inventoryDocument(name, modelName = 'gpt-5-mini', version = '2025-08-07') {
  return {
    id: `${resourceId}/deployments/${name}`, name,
    properties: { provisioningState: 'Succeeded', model: { format: 'OpenAI', name: modelName, version } },
  }
}
function completion(content, options = {}) {
  return new Response(JSON.stringify({
    model: 'gpt-5-mini-2025-08-07', choices: [{ finish_reason: options.finish ?? 'stop', message: { content, refusal: options.refusal ?? null } }],
  }), { status: options.status ?? 200 })
}
function taskRequest(task = 'assessmentReview') {
  const settings = createDefaultAdminSettings()
  settings.ai.deployments[0].deploymentName = 'review-task'
  return {
    kind: 'task', deployment: settings.ai.deployments[0], settings,
    task: resolveTaskModel(settings, task), confirmPaidProbe: true,
  }
}

test('inventory uses only resource-scoped managed-identity discovery and distinguishes unsupported models', async () => {
  const fake = azure(async () => new Response(JSON.stringify({
    value: [inventoryDocument('job-rubric'), inventoryDocument('unsupported', 'unrecognized-model', '1')],
  })))
  const result = await fake.adapter.inventory()
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].url, `https://management.azure.com${resourceId}/deployments?api-version=2024-10-01`)
  assert.equal(fake.calls[0].options.redirect, 'error')
  assert.deepEqual(fake.scopes, ['https://management.azure.com/.default'])
  assert.equal(result.deployments[0].capabilities.structuredOutputs, true)
  assert.equal(result.deployments[0].verification, 'discovered')
  assert.equal(result.deployments[0].verifiedAt, null)
  assert.equal(result.deployments[1].capabilities.structuredOutputs, false)
  assert.equal(result.deployments[1].enabled, false)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-managed-identity-token/)
})

test('inventory enables the verified Luna version, not lookalike names, unknown versions, or deployment-name aliases', async () => {
  const pending = inventoryDocument('luna-pending', 'gpt-5.6-luna', '2026-07-09')
  pending.properties.provisioningState = 'Creating'
  const otherFormat = inventoryDocument('luna-other-format', 'gpt-5.6-luna', '2026-07-09')
  otherFormat.properties.model.format = 'Other'
  const fake = azure(async () => Response.json({
    value: [
      inventoryDocument('summary-luna', 'gpt-5.6-luna', '2026-07-09'),
      inventoryDocument('luna-unknown-version', 'gpt-5.6-luna', '2026-07-10'),
      inventoryDocument('luna-lookalike', 'gpt-5.6-luna-preview', '2026-07-09'),
      inventoryDocument('gpt-5.6-luna', 'gpt-5-mini', '2025-08-07'),
      pending, otherFormat,
    ],
  }))
  const result = await fake.adapter.inventory()
  const [luna, unknownVersion, lookalike, alias, notReady, unsupportedFormat] = result.deployments
  assert.equal(luna.enabled, true)
  assert.equal(luna.modelName, 'gpt-5.6-luna')
  assert.equal(luna.modelVersion, '2026-07-09')
  assert.equal(luna.deploymentName, 'summary-luna')
  assert.equal(luna.capabilities.structuredOutputs, true)
  assert.equal(luna.capabilities.contextTokens, 1_050_000)
  assert.equal(luna.capabilities.maxOutputTokens, 128_000)
  assert.deepEqual(luna.capabilities.reasoningEfforts, ['low', 'medium', 'high'])
  assert.equal(luna.capabilities.temperature, false)
  assert.equal(luna.capabilities.topP, false)
  for (const unsupported of [unknownVersion, lookalike, unsupportedFormat]) {
    assert.equal(unsupported.enabled, false)
    assert.equal(unsupported.capabilities.structuredOutputs, false)
    assert.equal(unsupported.capabilities.contextTokens, 0)
  }
  assert.equal(alias.enabled, true)
  assert.equal(alias.modelName, 'gpt-5-mini')
  assert.equal(alias.modelVersion, '2025-08-07')
  assert.equal(notReady.enabled, false)
  assert.equal(notReady.capabilities.structuredOutputs, true)
  assert.equal(luna.verification, 'discovered')
  assert.equal(luna.verifiedAt, null)
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].options.method, 'GET')
  assert.deepEqual(fake.scopes, ['https://management.azure.com/.default'])
})

test('inventory refuses cross-resource or cross-origin continuation before sending credentials', async () => {
  for (const nextLink of [
    'https://evil.example/deployments',
    `https://management.azure.com${resourceId.replace('score-models', 'different-account')}/deployments?api-version=2024-10-01`,
  ]) {
    const fake = azure(async () => new Response(JSON.stringify({ value: [], nextLink })))
    await assert.rejects(fake.adapter.inventory(), /outside the configured resource/)
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.scopes.length, 1)
  }
})

test('probes require explicit cost confirmation and reject unsupported parameters before inference', async () => {
  const fake = azure(async () => { throw new Error('No network call was expected') })
  const input = taskRequest()
  await assert.rejects(fake.adapter.test({ ...input, confirmPaidProbe: false }), /Confirm the paid probe/)
  await assert.rejects(fake.adapter.test({ ...input, task: { ...input.task, temperature: 0.2 } }), /unsupported/)
  assert.equal(fake.calls.length, 0)
  assert.equal(fake.scopes.length, 0)
})

test('task probes reject synthetic source and complete-request budget overruns before authentication', async () => {
  const fake = azure(async () => { throw new Error('No network call was expected') })
  const input = taskRequest()
  for (const budget of [
    { ...input.task.inputBudget, maxInput: 1 },
    { ...input.task.inputBudget, maxRequest: 1 },
  ]) {
    await assert.rejects(fake.adapter.test({
      ...input, task: { ...input.task, inputBudget: budget },
    }), /selected task budget/)
  }
  assert.equal(fake.scopes.length, 0)
  assert.equal(fake.calls.length, 0)
})

test('synthetic task probes use the resolved deployment and parameters and validate schema plus exact evidence', async () => {
  const evidence = 'The synthetic source states that one example project was completed.'
  const fake = azure(async () => completion(JSON.stringify({
    task: 'assessmentReview', supported: true, evidence: [{ paragraphId: 'synthetic-p1', quote: evidence }], missing: null,
  })))
  const result = await fake.adapter.test(taskRequest())
  assert.equal(result.status, 'passed')
  assert.equal(result.identity, 'api-managed-identity')
  assert.equal(result.workerIdentityVerified, false)
  assert.equal(result.actualModel, 'gpt-5-mini-2025-08-07')
  assert.equal(fake.calls[0].url, 'https://score-models.openai.azure.com/openai/v1/chat/completions')
  const submitted = JSON.parse(fake.calls[0].options.body)
  assert.equal(submitted.model, 'review-task')
  assert.equal(submitted.reasoning_effort, 'low')
  assert.equal(submitted.max_completion_tokens, 12_288)
  assert.equal(submitted.response_format.json_schema.strict, true)
  assert.deepEqual(submitted.response_format.json_schema.schema.properties.task.enum, ['assessmentReview'])
  assert.equal('temperature' in submitted, false)
  assert.equal('top_p' in submitted, false)
  assert.deepEqual(fake.scopes, ['https://cognitiveservices.azure.com/.default'])
  assert.doesNotMatch(JSON.stringify(result), /synthetic-managed-identity-token/)
})

test('HTTP success alone, invalid JSON, refusal, and truncated output never produce fake probe success', async () => {
  const responses = [
    () => completion('{}'),
    () => completion('not JSON'),
    () => completion('{"value":"score-structured-output"}', { finish: 'length' }),
    () => completion(null, { refusal: 'Cannot comply' }),
    () => new Response(JSON.stringify({ error: { message: 'private upstream diagnostic' } }), { status: 429 }),
  ]
  for (const makeResponse of responses) {
    const fake = azure(async () => makeResponse())
    const input = taskRequest()
    const result = await fake.adapter.test(input)
    assert.equal(result.status, 'failed')
    assert.equal(result.workerIdentityVerified, false)
    assert.doesNotMatch(JSON.stringify(result), /private upstream diagnostic/)
  }
})

test('otherwise valid synthetic results reject ambiguous choices, tool calls, and invalid model identity', async () => {
  const content = JSON.stringify({
    task: 'assessmentReview', supported: true, missing: null,
    evidence: [{ paragraphId: 'synthetic-p1', quote: 'The synthetic source states that one example project was completed.' }],
  })
  const choice = { finish_reason: 'stop', message: { content, refusal: null } }
  const payloads = [
    { model: 'gpt-5-mini', choices: [choice, choice] },
    { model: 'gpt-5-mini', choices: [{ ...choice, message: { ...choice.message, tool_calls: [] } }] },
    { model: 'gpt-5-mini', choices: [{ ...choice, message: { ...choice.message, function_call: { name: 'unexpected' } } }] },
    { model: 'invalid model identity', choices: [choice] },
    { model: 'gpt-5-mini', choices: [{ message: choice.message }] },
  ]
  for (const payload of payloads) {
    const fake = azure(async () => new Response(JSON.stringify(payload)))
    const result = await fake.adapter.test(taskRequest())
    assert.equal(result.status, 'failed')
    assert.equal(result.workerIdentityVerified, false)
  }
})

test('probe deadlines bound uncooperative credentials and response bodies without late inference', { timeout: 10_000 }, async () => {
  await Promise.all(['credentials', 'body'].map(async stalled => {
    let release = () => {}
    let calls = 0
    const token = { token: 'synthetic-managed-identity-token', expiresOnTimestamp: Date.now() + 60_000 }
    const adapter = createAzureSettingsModelAdapter({
      resource,
      credential: {
        getToken: async () => stalled === 'credentials'
          ? new Promise(resolve => { release = () => resolve(token) }) : token,
      },
      fetch: async () => {
        calls++
        return new Response(new ReadableStream({
          start(controller) { release = () => controller.close() },
        }))
      },
    })
    const input = taskRequest()
    input.settings.ai.requestTimeoutMilliseconds = 1000
    try {
      await assert.rejects(adapter.test(input), error => error.status === 503 && /bounded deadline/.test(error.message))
      assert.equal(calls, stalled === 'credentials' ? 0 : 1)
    } finally {
      release()
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(calls, stalled === 'credentials' ? 0 : 1)
  }))
})

test('probe responses retain a streamed byte ceiling as well as a declared-length ceiling', async () => {
  for (const makeResponse of [
    () => new Response('{}', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response(JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) })),
  ]) {
    const fake = azure(async () => makeResponse())
    await assert.rejects(fake.adapter.test(taskRequest()), /oversized validation response/)
    assert.equal(fake.calls.length, 1)
  }
})

test('connection checks are truthful management-plane checks and never claim inference or worker proof', async () => {
  const fake = azure(async () => new Response(JSON.stringify({ value: [inventoryDocument('review-task')] })))
  const request = taskRequest()
  const result = await fake.adapter.test({ ...request, kind: 'connection', task: undefined, confirmPaidProbe: false })
  assert.equal(result.status, 'passed')
  assert.match(result.checks[0].message, /No inference or worker identity was tested/)
  assert.equal(fake.calls[0].options.method, 'GET')
  assert.equal(result.workerIdentityVerified, false)
})
