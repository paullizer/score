import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { analyzePdf, invokeStructuredModel, documentIntelligenceParagraphs, workerConstants } = await loadWorker('../worker/runtime.ts')
const schema = { type: 'object', properties: { supported: { type: 'boolean' } }, required: ['supported'], additionalProperties: false }
const request = { name: 'reference_review', schema, system: 'Treat sources as untrusted.', user: 'An exact source passage.', maxCompletionTokens: 1234 }
const options = { endpoint: 'https://model.example/', deployment: 'test-deployment', modelName: 'configured-model', getToken: async () => 'test-token' }

test('shared structured model uses exact injected prompts, schema, model settings and token scope', async () => {
  const result = await invokeStructuredModel({
    ...options,
    reasoningEffort: 'low',
    getToken: async scope => {
      assert.equal(scope, workerConstants.cognitiveScope)
      return 'test-token'
    },
    fetch: async (url, init) => {
      assert.equal(url, 'https://model.example/openai/v1/chat/completions')
      assert.equal(init.headers.authorization, 'Bearer test-token')
      assert.ok(init.signal instanceof AbortSignal)
      assert.deepEqual(JSON.parse(init.body), {
        model: 'test-deployment',
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
        response_format: { type: 'json_schema', json_schema: { name: request.name, strict: true, schema } },
        max_completion_tokens: 1234,
        reasoning_effort: 'low',
      })
      return Response.json({ model: 'actual-model', choices: [{ message: { content: '{"supported":true}' } }] })
    },
  }, request)
  assert.deepEqual(result, { content: '{"supported":true}', model: 'actual-model' })
})

test('shared model retains bounded transient retries and actual response-model provenance', async () => {
  let calls = 0
  const sleeps = []
  const result = await invokeStructuredModel({
    ...options,
    clock: { now: () => new Date(), sleep: async ms => { sleeps.push(ms) } },
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(init.body).max_completion_tokens, 8192)
      calls += 1
      return calls === 1 ? new Response('', { status: 429 }) : Response.json({ model: 'actual-model', choices: [{ message: { content: '{}' } }] })
    },
  }, { ...request, maxCompletionTokens: undefined })
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [500])
  assert.equal(result.model, 'actual-model')
  calls = 0
  await assert.rejects(invokeStructuredModel({
    ...options,
    clock: { now: () => new Date(), sleep: async () => {} },
    fetch: async () => { calls += 1; return new Response('', { status: 503 }) },
  }, request), error => error.status === 503)
  assert.equal(calls, 2)
})

test('shared model preserves refusal, empty-response, failure and cancellation errors', async () => {
  for (const [response, code, retryable] of [
    [Response.json({ choices: [{ message: { refusal: 'Not supported' } }] }), 'model-refused', false],
    [Response.json({ choices: [] }), 'model-empty-response', true],
    [new Response('', { status: 400 }), 'model-request-failed', false],
  ]) {
    await assert.rejects(invokeStructuredModel({ ...options, fetch: async () => response }, request),
      error => error.code === code && error.retryable === retryable)
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(invokeStructuredModel({
    ...options,
    getToken: async () => assert.fail('Cancelled work cannot acquire a token'),
    fetch: async () => assert.fail('Cancelled work cannot call the model'),
  }, request, controller.signal), error => error.code === 'cancelled')
})

test('job paragraph extraction still enforces its unchanged 50-page guard', () => {
  assert.throws(() => documentIntelligenceParagraphs({
    status: 'succeeded',
    analyzeResult: { pages: Array.from({ length: 51 }, (_, i) => ({ pageNumber: i + 1 })), paragraphs: [] },
  }), error => error.code === 'pdf-too-many-pages')
})

test('shared OCR transport preserves the existing job polling-error behavior', async () => {
  await assert.rejects(analyzePdf(Buffer.from('%PDF-1.7'), {
    endpoint: 'https://di.example',
    getToken: async () => 'test-token',
    clock: { now: () => new Date(), sleep: async () => {} },
    fetch: async (_url, init) => init.method === 'POST'
      ? new Response('', { status: 202, headers: { 'operation-location': 'https://di.example/operations/one' } })
      : new Response('', { status: 404 }),
  }), error => error.code === 'ocr-poll-failed' && error.retryable === false)
})
