import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { invokeStructuredModel } = await loadWorker('../worker/model-transport.ts')
const { parseModelTokenUsage } = await loadWorker('../worker/model-usage.ts')
const schema = { type: 'object', properties: { valid: { type: 'boolean' } }, required: ['valid'], additionalProperties: false }
const request = { name: 'test_usage', schema, system: 'Use supplied source.', user: 'Source.', taskId: 'assessment' }
const base = {
  endpoint: 'https://model.example/', deployment: 'test-model', modelName: 'configured-model',
  getToken: async () => 'test-token',
  clock: { now: () => new Date('2026-10-07T00:00:00Z'), sleep: async () => {} },
}
const payload = {
  model: 'actual-model', choices: [{ finish_reason: 'stop', message: { content: '{"valid":true}' } }],
  usage: {
    prompt_tokens: 100, completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 40 },
  },
}

test('usage parser distinguishes omitted details from zero and rejects invalid totals', () => {
  assert.deepEqual(parseModelTokenUsage(payload), {
    inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, reasoningTokens: 40, cacheWriteInputTokens: 0,
  })
  assert.deepEqual(parseModelTokenUsage({ usage: { prompt_tokens: 100, completion_tokens: 50 } }), {
    inputTokens: 100, outputTokens: 50, cachedInputTokens: null, reasoningTokens: null, cacheWriteInputTokens: null,
  })
  assert.equal(parseModelTokenUsage({ usage: { ...payload.usage, prompt_tokens: 1 } }), null)
  assert.equal(parseModelTokenUsage({ usage: { prompt_tokens: -1, completion_tokens: 0 } }), null)
  assert.equal(parseModelTokenUsage({}), null)
})

test('transport captures every retry separately without source, credentials or response prose', async () => {
  let calls = 0
  const records = []
  const result = await invokeStructuredModel({
    ...base,
    fetch: async () => ++calls === 1 ? new Response('', { status: 429 }) : Response.json(payload),
    onModelAttempt: async record => { records.push(record) },
  }, request)
  assert.equal(result.model, 'actual-model')
  assert.equal(records.length, 2)
  assert.equal(records[0].httpStatus, 429)
  assert.equal(records[0].usage, null)
  assert.equal(records[1].actualModel, 'actual-model')
  assert.equal(records[1].usage.reasoningTokens, 40)
  assert.equal(records[0].requestSha256, records[1].requestSha256)
  assert.notEqual(records[0].id, records[1].id)
  assert.equal(JSON.stringify(records).includes('test-token'), false)
  assert.equal(JSON.stringify(records).includes('Source.'), false)
})

test('usage write failures propagate without rebuying the request', async () => {
  let calls = 0
  await assert.rejects(invokeStructuredModel({
    ...base,
    fetch: async () => { calls++; return Response.json(payload) },
    onModelAttempt: async () => { throw new Error('Cost ledger unavailable') },
  }, request), /Cost ledger unavailable/)
  assert.equal(calls, 1)
})

test('truncated and refused responses still retain billable usage', async () => {
  const records = []
  await assert.rejects(invokeStructuredModel({
    ...base,
    fetch: async () => Response.json({ ...payload, choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    onModelAttempt: async record => { records.push(record) },
  }, request), error => error.code === 'model-context-limit')
  assert.equal(records[0].usage.outputTokens, 50)
})
