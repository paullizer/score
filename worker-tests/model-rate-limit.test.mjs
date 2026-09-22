import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsSnapshot } from './runtime-settings-test-support.mjs'

const { invokeStructuredModel } = await loadWorker('../worker/model-transport.ts')
const { modelRetryFallback, MAX_MODEL_RETRY_TIMESTAMP } = await loadWorker('../worker/model-retry.ts')
const NOW = Date.parse('2026-09-21T12:00:00.000Z')
const request = {
  name: 'retry_test', schema: { type: 'object', properties: {}, additionalProperties: false },
  system: 'Return JSON.', user: 'Frozen evidence.', taskId: 'targetSummary',
}
const success = () => Response.json({ model: 'actual-model', choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })
async function until(predicate) {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Expected the bounded model operation to reach its mocked boundary')
}
function harness(headers, { status = 429, random = 0.5, alwaysFail = false } = {}) {
  let now = NOW
  const calls = [], sleeps = [], failures = []
  const clock = {
    now: () => new Date(now),
    async sleep(milliseconds, signal) {
      signal?.throwIfAborted()
      sleeps.push(milliseconds)
      now += milliseconds
    },
  }
  const model = {
    endpoint: 'https://model-test.example', deployment: 'frozen-deployment', modelName: 'frozen-model',
    clock, retryRandom: () => random, getToken: async () => 'PRIVATE-TOKEN',
    async fetch(_url, init) {
      calls.push({ at: now, body: init.body, signal: init.signal })
      return calls.length === 1 || alwaysFail ? new Response('PRIVATE-RESPONSE', { status, headers }) : success()
    },
  }
  return { model, calls, sleeps, failures, advance: ms => { now += ms }, onRetry: async error => { failures.push(error) } }
}

for (const [name, headers, milliseconds] of [
  ['seconds', { 'Retry-After': '2' }, 2_000],
  ['zero seconds', { 'Retry-After': '0' }, 0],
  ['HTTP-date', { 'Retry-After': new Date(NOW + 6_000).toUTCString() }, 6_000],
  ['obsolete RFC 850 HTTP-date', { 'Retry-After': 'Monday, 21-Sep-26 12:00:06 GMT' }, 6_000],
  ['obsolete asctime HTTP-date', { 'Retry-After': 'Mon Sep 21 12:00:06 2026' }, 6_000],
  ['past HTTP-date', { 'Retry-After': new Date(NOW - 6_000).toUTCString() }, 0],
  ['Azure retry-after-ms', { 'retry-after-ms': '1250' }, 1_250],
  ['Azure x-ms-retry-after-ms', { 'x-ms-retry-after-ms': '2750' }, 2_750],
  ['whitespace', { 'Retry-After': ' 3 ' }, 3_000],
  ['longest valid hint', { 'Retry-After': '2', 'retry-after-ms': '1250', 'x-ms-retry-after-ms': '2750' }, 2_750],
  ['valid hint beside a malformed hint', { 'Retry-After': 'Infinity', 'retry-after-ms': '1500' }, 1_500],
]) {
  test(`model transport honors ${name} without retrying early`, async () => {
    const mock = harness(headers)
    const result = await invokeStructuredModel(mock.model, { ...request, onRetry: mock.onRetry })
    assert.equal(result.model, 'actual-model')
    assert.deepEqual(mock.sleeps, [milliseconds])
    assert.equal(mock.calls.length, 2)
    assert.equal(mock.calls[1].at, NOW + milliseconds)
    assert.equal(mock.failures[0].httpStatus, 429)
    assert.equal(mock.failures[0].status, 429, 'Legacy status readers remain compatible.')
    assert.equal(mock.failures[0].retryAt, new Date(NOW + milliseconds).toISOString())
    assert.doesNotMatch(JSON.stringify(mock.failures), /PRIVATE/)
  })
}

test('absent, malformed and overflowing hints use deterministic bounded jitter, not header text', async () => {
  const invalid = [
    {}, { 'retry-after': '' }, { 'retry-after': '-1' }, { 'retry-after': '1.5' },
    { 'retry-after': 'Infinity' }, { 'retry-after': '1e30' }, { 'retry-after': 'PRIVATE-DATA' },
    { 'retry-after': '9'.repeat(400) }, { 'retry-after': '9999999999999' },
    { 'retry-after': 'Tue, 31 Feb 2026 12:00:00 GMT' },
    { 'retry-after-ms': '1.5' }, { 'retry-after-ms': '-1' },
    { 'x-ms-retry-after-ms': 'Infinity' }, { 'x-ms-retry-after-ms': '9007199254740991' },
  ]
  for (const headers of invalid) {
    const mock = harness(headers)
    await invokeStructuredModel(mock.model, { ...request, onRetry: mock.onRetry })
    assert.deepEqual(mock.sleeps, [375], JSON.stringify(headers))
    assert.equal(mock.failures[0].retryAt, new Date(NOW + 375).toISOString())
  }
  assert.equal(modelRetryFallback(0, () => 0), 250)
  assert.equal(modelRetryFallback(0, () => 1), 500)
  assert.equal(modelRetryFallback(1, () => 0.5), 750)
  assert.equal(modelRetryFallback(20, () => 1), 5_000)
})

test('valid long hints and hints at the deadline defer intact without sleeping or timer overflow', async () => {
  for (const milliseconds of [1_000, 1_001, 86_400_000, 2 ** 31 + 1, MAX_MODEL_RETRY_TIMESTAMP - NOW]) {
    const mock = harness({ 'x-ms-retry-after-ms': String(milliseconds) })
    await assert.rejects(invokeStructuredModel(mock.model, {
      ...request, deadlineAt: NOW + 1_000, onRetry: mock.onRetry,
    }), error => {
      assert.equal(error.httpStatus, 429)
      assert.equal(error.retryable, true)
      assert.equal(error.retryAt, new Date(NOW + milliseconds).toISOString())
      assert.match(error.message, /rate limited/)
      return true
    })
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.failures.length, 1)
    assert.deepEqual(mock.sleeps, [])
  }
})

test('deadline checks include authentication and never issue a late request on an advancing fake clock', async () => {
  const mock = harness({})
  mock.model.getToken = async () => { mock.advance(1_000); return 'PRIVATE-TOKEN' }
  await assert.rejects(invokeStructuredModel(mock.model, { ...request, deadlineAt: NOW + 1_000 }),
    error => error.code === 'request-timeout' && error.retryable)
  assert.equal(mock.calls.length, 0)
  assert.deepEqual(mock.sleeps, [])
})

test('an early-returning clock cannot cause an early retry of a valid provider hint', async () => {
  const mock = harness({ 'retry-after': '2' })
  mock.model.clock.sleep = async ms => { mock.sleeps.push(ms) }
  await assert.rejects(invokeStructuredModel(mock.model, request),
    error => error.httpStatus === 429 && error.retryAt === new Date(NOW + 2_000).toISOString())
  assert.equal(mock.calls.length, 1)
  assert.deepEqual(mock.sleeps, [2_000])
})

test('cooldown capture precedes sleep and cancellation retains safe provider metadata', async () => {
  const controller = new AbortController()
  const mock = harness({ 'retry-after': '2' })
  mock.model.clock.sleep = async (ms, signal) => {
    assert.equal(mock.failures.length, 1)
    assert.equal(ms, 2_000)
    assert.ok(signal instanceof AbortSignal)
    controller.abort(new Error('PRIVATE-INTERRUPTION'))
    signal.throwIfAborted()
  }
  await assert.rejects(invokeStructuredModel(mock.model, { ...request, onRetry: mock.onRetry }, controller.signal), error => {
    assert.equal(error.httpStatus, 429)
    assert.equal(error.retryAt, new Date(NOW + 2_000).toISOString())
    assert.equal(error.cancelled, true)
    assert.equal(error.retryable, true)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(error.message, /PRIVATE/)
    return true
  })
  assert.equal(mock.calls.length, 1)
})

test('a noncooperative sleep is bounded by cancellation even with a frozen injected clock', async () => {
  const controller = new AbortController()
  const mock = harness({ 'retry-after': '2' })
  mock.model.clock.sleep = async (_ms, signal) => {
    assert.ok(signal instanceof AbortSignal)
    queueMicrotask(() => controller.abort())
    return new Promise(() => {})
  }
  await assert.rejects(invokeStructuredModel(mock.model, request, controller.signal),
    error => error.httpStatus === 429 && error.cancelled && Boolean(error.retryAt))
  assert.equal(mock.calls.length, 1)
})

test('wall-clock deadline bounds an uncooperative cooldown and checkpoint callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const boundary of ['sleep', 'checkpoint']) {
    const mock = harness({ 'retry-after-ms': '500' })
    let waiting = false
    const never = async () => { waiting = true; return new Promise(() => {}) }
    if (boundary === 'sleep') mock.model.clock.sleep = never
    const operation = invokeStructuredModel(mock.model, {
      ...request, deadlineAt: NOW + 1_000, onRetry: boundary === 'checkpoint' ? never : mock.onRetry,
    })
    const rejection = assert.rejects(operation, error =>
      error.httpStatus === 429 && error.retryAt === new Date(NOW + 500).toISOString())
    await until(() => waiting)
    t.mock.timers.tick(1_000)
    await rejection
    assert.equal(mock.calls.length, 1)
  }
})

test('explicit deadline bounds hung authentication, fetch, and body reads without cooperative cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const boundary of ['token', 'fetch', 'body']) {
    const mock = harness({})
    let waiting = false
    const never = async () => { waiting = true; return new Promise(() => {}) }
    if (boundary === 'token') mock.model.getToken = never
    if (boundary === 'fetch') mock.model.fetch = never
    if (boundary === 'body') mock.model.fetch = async () => {
      waiting = true
      return new Response(new ReadableStream({ start() {} }))
    }
    const rejection = assert.rejects(invokeStructuredModel(mock.model, { ...request, deadlineAt: NOW + 1_000 }),
      error => error.code === 'request-timeout' && error.retryable)
    await until(() => waiting)
    t.mock.timers.tick(1_000)
    await rejection
  }
})

test('retries retain the captured task, serialized evidence and transport attempt limit', async () => {
  const mutable = structuredClone(settingsSnapshot())
  const captured = structuredClone(mutable)
  const input = structuredClone(request)
  const mock = harness({ 'retry-after': '1' }, { alwaysFail: true })
  mock.model.processingSettings = mutable
  const fetch = mock.model.fetch
  mock.model.fetch = async (...args) => {
    const response = await fetch(...args)
    mutable.settings.ai.transport.maxAttempts = 1
    mutable.tasks.targetSummary.deploymentName = 'PRIVATE-SUBSTITUTION'
    mutable.settings.ai.requestTimeoutMilliseconds = 1
    mock.model.deployment = 'PRIVATE-SUBSTITUTION'
    input.schema.description = 'PRIVATE-MUTATION'
    input.user = 'PRIVATE-MUTATION'
    return response
  }
  await assert.rejects(invokeStructuredModel(mock.model, input), error => error.httpStatus === 429)
  assert.equal(mock.calls.length, captured.settings.ai.transport.maxAttempts)
  assert.equal(mock.calls[0].body, mock.calls[1].body)
  assert.equal(JSON.parse(mock.calls[1].body).model, captured.tasks.targetSummary.deploymentName)
  assert.doesNotMatch(mock.calls[1].body, /PRIVATE/)
})

test('nonretryable rejection and authentication errors remain distinct from throttling and outages', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const mock = harness({ 'retry-after': '5' }, { status })
    await assert.rejects(invokeStructuredModel(mock.model, request), error => {
      assert.equal(error.code, 'model-request-failed')
      assert.equal(error.httpStatus, status)
      assert.equal(error.retryable, false)
      assert.equal(error.retryAt, undefined)
      assert.match(error.message, status === 401 || status === 403 ? /authentication or access/ : /rejected/)
      assert.doesNotMatch(error.message, /PRIVATE/)
      return true
    })
    assert.equal(mock.calls.length, 1)
    assert.deepEqual(mock.sleeps, [])
  }
  const unavailable = harness({ 'retry-after': '200' }, { status: 503 })
  await assert.rejects(invokeStructuredModel(unavailable.model, request), error =>
    error.httpStatus === 503 && error.retryable && /unavailable/.test(error.message) && Boolean(error.retryAt))
  assert.equal(unavailable.calls.length, 1)
})

test('invalid explicit deadlines fail before authentication rather than scheduling an overflowing timer', async () => {
  for (const deadlineAt of [NaN, Infinity, -1, 0.5, MAX_MODEL_RETRY_TIMESTAMP + 1]) {
    const mock = harness({})
    mock.model.getToken = async () => assert.fail('Invalid deadline must not authenticate')
    await assert.rejects(invokeStructuredModel(mock.model, { ...request, deadlineAt }),
      error => error.code === 'settings-invalid' && !error.retryable)
    assert.equal(mock.calls.length, 0)
  }
})
