import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AssistCancelledError,
  createAssistLimiter,
  createAzureAssistModelInvoker,
  createDefaultAdminSettings,
  captureProcessingSettings,
  runAssist,
  tooManyRequests,
} from '../dist-server/app.mjs'
import { authHeaders, startTestServer } from './helpers.mjs'

function response(value, init = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function settingsSnapshot(overrides = {}) {
  const settings = createDefaultAdminSettings()
  settings.ai.transport.maxAttempts = 1
  settings.ai.requestTimeoutMilliseconds = 5_000
  const task = settings.ai.tasks.jobRubric
  Object.assign(task.inputBudget, overrides.inputBudget ?? {})
  if (overrides.contextTokens !== undefined) {
    const deployment = settings.ai.deployments.find(item => item.id === task.deploymentId) ?? settings.ai.deployments[0]
    deployment.capabilities.contextTokens = overrides.contextTokens
  }
  if (overrides.deploymentName) {
    const deployment = settings.ai.deployments.find(item => item.id === task.deploymentId) ?? settings.ai.deployments[0]
    deployment.deploymentName = overrides.deploymentName
    deployment.modelName = overrides.modelName ?? deployment.modelName
  }
  return captureProcessingSettings(settings, overrides.revision ?? 'assist-test-settings', '2026-09-23T13:00:00.000Z')
}

function toyProfile(options = {}) {
  return {
    kind: 'toy',
    taskId: 'jobRubric',
    promptVersion: 'toy-v1',
    schemaName: 'toy_schema',
    maxCompletionTokens: 64,
    jsonSchema: () => ({
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'reply', 'operations', 'warnings'],
      properties: {
        outcome: { type: 'string' },
        reply: { type: 'string' },
        operations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    }),
    buildPrompt: ({ context, instruction, conversation, correction }) => {
      options.onBuild?.({ context, instruction, conversation, correction })
      return {
        system: 'system',
        source: context.source,
        user: JSON.stringify({ source: context.source, draft: context.draft, instruction, conversation, correction }),
      }
    },
    validate: output => {
      if (!output || typeof output !== 'object') return { ok: false, errors: ['Output must be an object.'] }
      if (output.invalid) return { ok: false, errors: output.errors ?? ['Bad model output.'] }
      return { ok: true, value: {
        outcome: output.outcome ?? 'changed',
        reply: output.reply ?? 'ok',
        operations: output.operations ?? [{ type: 'noop' }],
        warnings: output.warnings ?? [],
      } }
    },
  }
}

async function runToy(options = {}) {
  const calls = []
  const invoke = options.invoke ?? (async request => {
    calls.push(request)
    const next = options.results?.[calls.length - 1] ?? { outcome: 'changed', reply: 'done', operations: [{ type: 'set' }], warnings: [] }
    return { content: typeof next === 'string' ? next : JSON.stringify(next), model: 'test-model' }
  })
  const result = await runAssist({
    profile: options.profile ?? toyProfile(options.profileOptions),
    context: options.context ?? { source: 'source', draft: 'draft' },
    instruction: options.instruction ?? 'help',
    conversation: options.conversation ?? [],
    invoke,
    processingSettings: options.processingSettings,
    maxCorrections: options.maxCorrections ?? 2,
    signal: options.signal ?? new AbortController().signal,
    now: options.now,
    deadlineMilliseconds: options.deadlineMilliseconds,
  })
  return { result, calls }
}

test('runAssist returns validated operations with assistant metadata', async () => {
  const { result, calls } = await runToy()
  assert.equal(result.outcome, 'changed')
  assert.deepEqual(result.operations, [{ type: 'set' }])
  assert.deepEqual(result.assistant, { promptVersion: 'toy-v1', model: 'test-model' })
  assert.equal(calls[0].deadlineAt > Date.now(), true)
})

test('runAssist retries invalid JSON and feeds validation errors into correction prompts', async () => {
  const builds = []
  const { result } = await runToy({
    profileOptions: { onBuild: input => builds.push(input) },
    results: [
      '{not json',
      { invalid: true, errors: ['Fix the operation.'] },
      { outcome: 'changed', reply: 'fixed', operations: [{ type: 'fixed' }], warnings: [] },
    ],
  })
  assert.equal(result.reply, 'fixed')
  assert.equal(builds[1].correction[0], 'Response was not valid JSON.')
  assert.deepEqual(builds[2].correction, ['Fix the operation.'])
})

test('runAssist reports exhausted corrections and honors maxCorrections zero', async () => {
  await assert.rejects(() => runToy({ results: [{ invalid: true, errors: ['Still wrong.'] }], maxCorrections: 0 }), error => {
    assert.equal(error.status, 502)
    assert.match(error.message, /Still wrong/)
    return true
  })
})

test('runAssist maps deadline and abort to safe errors', async () => {
  await assert.rejects(() => runToy({ now: () => 100, deadlineMilliseconds: 0 }), error => {
    assert.equal(error.status, 503)
    assert.match(error.message, /too long/)
    return true
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => runToy({ signal: controller.signal }), AssistCancelledError)
})

test('runAssist maps WorkerError-like rate limits without leaking provider bodies', async () => {
  await assert.rejects(() => runToy({
    invoke: async () => {
      throw { code: 'model-request-failed', httpStatus: 429, retryAt: new Date(10_000).toISOString(), cancelled: false }
    },
    now: () => 0,
  }), error => {
    assert.equal(error.status, 429)
    assert.equal(error.retryAfterSeconds, 10)
    assert.match(error.message, /rate limited/)
    return true
  })
})

test('runAssist drops oldest conversation turns to fit budget and rejects oversized source', async () => {
  const small = settingsSnapshot({ inputBudget: { maxInput: 1000, maxRequest: 12_000 } })
  const builds = []
  const conversation = [
    { role: 'user', text: 'old'.repeat(5000) },
    { role: 'assistant', text: 'middle'.repeat(1500) },
    { role: 'user', text: 'new' },
  ]
  await runToy({ processingSettings: small, conversation, profileOptions: { onBuild: input => builds.push(input.conversation.map(turn => turn.text)) } })
  assert.equal(builds.at(-1).includes(conversation[0].text), false)
  assert.equal(builds.at(-1).includes('new'), true)
  await assert.rejects(() => runToy({
    processingSettings: settingsSnapshot({ inputBudget: { maxInput: 4, maxRequest: 12_000 } }),
    context: { source: 'source too large', draft: 'draft' },
  }), error => {
    assert.equal(error.status, 400)
    assert.match(error.message, /source exceeds/)
    return true
  })
})

test('assist limiter enforces per-user, window, global, idempotent release and pruning', () => {
  let now = 0
  const limiter = createAssistLimiter({ perUserInFlight: 1, perUserMaxRequests: 2, perUserWindowMilliseconds: 1000, globalInFlight: 1, now: () => now })
  const release = limiter.acquire('a')
  assert.throws(() => limiter.acquire('a'), /in progress/)
  assert.throws(() => limiter.acquire('b'), /busy/)
  release()
  release()
  limiter.acquire('a')()
  assert.throws(() => limiter.acquire('a'), error => {
    assert.equal(error.status, 429)
    assert.equal(error.retryAfterSeconds, 1)
    assert.match(error.message, /Assistant limit reached/)
    return true
  })
  now = 1000
  limiter.acquire('a')()
  now = 2000
  limiter.acquire('a')()
})

test('Azure assist model invoker sends strict schema requests with pinned and fallback deployments', async () => {
  const requests = []
  const credential = { async getToken(scope) {
    assert.equal(scope, 'https://cognitiveservices.azure.com/.default')
    return { token: 'fake-token', expiresOnTimestamp: Date.now() + 60_000 }
  } }
  const invoker = createAzureAssistModelInvoker({
    endpoint: 'https://score-openai.example.com/',
    deploymentName: 'fallback-deployment',
    modelName: 'fallback-model',
    reasoningEffort: 'low',
    credential,
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) })
      assert.equal(init.headers.authorization, 'Bearer fake-token')
      return response({ model: 'actual-model', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] })
    },
    clock: { now: () => new Date(0), sleep: async () => {} },
  })
  const base = {
    taskId: 'jobRubric',
    name: 'toy_schema',
    schema: { type: 'object', additionalProperties: false, properties: {} },
    system: 'system',
    user: 'user',
    source: 'source',
    maxCompletionTokens: 123,
    deadlineAt: 10_000,
  }
  await invoker({ ...base, processingSettings: settingsSnapshot({ deploymentName: 'pinned-deployment', modelName: 'pinned-model' }) }, new AbortController().signal)
  await invoker(base, new AbortController().signal)
  assert.equal(requests[0].url, 'https://score-openai.example.com/openai/v1/chat/completions')
  assert.equal(requests[0].body.model, 'pinned-deployment')
  assert.equal(requests[0].body.response_format.json_schema.strict, true)
  assert.equal(requests[1].body.model, 'fallback-deployment')
})

test('Azure model HTTP 429 is surfaced through runAssist with Retry-After', async () => {
  const credential = { async getToken() { return { token: 'fake-token', expiresOnTimestamp: Date.now() + 60_000 } } }
  const invoker = createAzureAssistModelInvoker({
    endpoint: 'https://score-openai.example.com',
    deploymentName: 'fallback-deployment',
    modelName: 'fallback-model',
    credential,
    fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '7' } }),
    clock: { now: () => new Date(0), sleep: async () => {} },
  })
  await assert.rejects(() => runToy({
    invoke: invoker,
    processingSettings: settingsSnapshot(),
    now: () => 0,
  }), error => {
    assert.equal(error.status, 429)
    assert.equal(error.retryAfterSeconds, 7)
    return true
  })
})

test('HttpError retryAfterSeconds produces a Retry-After response header', async () => {
  const server = await startTestServer({ settings: { async capture() { throw tooManyRequests('Slow down.', 12.2) } } })
  try {
    const result = await fetch(`${server.baseUrl}/api/features`, { headers: authHeaders() })
    assert.equal(result.status, 429)
    assert.equal(result.headers.get('retry-after'), '13')
    assert.equal((await result.json()).error.code, 'unavailable')
  } finally {
    await server.close()
  }
})
