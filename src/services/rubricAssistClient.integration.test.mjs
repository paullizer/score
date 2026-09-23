import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = resolve(`.rubric-assist-client-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
const originalTimeout = AbortSignal.timeout
let client
let requests

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function error(code, message, status, headers = {}) {
  return json({ error: { code, message } }, status, headers)
}

function validRequest(overrides = {}) {
  return {
    submissionId: randomUUID(),
    base: { rubricId: 'rubric-one', version: 3 },
    instruction: 'Tighten the rubric name.',
    conversation: [],
    focusCriterionId: null,
    draft: { name: 'Original rubric', description: '', criteria: [] },
    ...overrides,
  }
}

function validResponse(overrides = {}) {
  return {
    outcome: 'changed',
    reply: 'I updated the rubric name.',
    operations: [{ type: 'updateRubric', name: 'Tighter rubric' }],
    warnings: [],
    assistant: { promptVersion: 'score-rubric-assist-v1', model: 'test-model' },
    ...overrides,
  }
}

before(async () => {
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), contents: `
      export * from './src/services/rubricAssist'
      export * from './src/services/cloudWorkspace'
      export * from './src/services/realJobs'
      export { jobFeaturesWithPolicy } from './src/services/publicSettings'
      export { ASSIST_LIMITS } from './src/domain/assist'
    ` },
    outfile: join(output, 'client.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' },
  })
  client = await import(pathToFileURL(join(output, 'client.mjs')).href)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  AbortSignal.timeout = originalTimeout
})

beforeEach(() => { requests = [] })

after(async () => {
  await rm(output, { recursive: true, force: true })
})

test('rubric assist posts the validated request with workspace headers and the long opt-in timeout', async () => {
  const timeouts = []
  AbortSignal.timeout = (milliseconds) => {
    timeouts.push(milliseconds)
    return new AbortController().signal
  }
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    assert.equal('timeoutMilliseconds' in init, false)
    return json(validResponse())
  }
  const request = validRequest()

  const response = await client.requestRubricAssist('workspace one', 'job/one', request)

  assert.equal(response.operations[0].type, 'updateRubric')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/workspaces/workspace%20one/jobs/job%2Fone/rubric/assist')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.headers.get('X-Score-Request'), 'workspace')
  assert.equal(requests[0].init.headers.get('Content-Type'), 'application/json')
  assert.deepEqual(JSON.parse(requests[0].init.body), request)
  assert.deepEqual(timeouts, [client.ASSIST_LIMITS.clientTimeoutMilliseconds])
})

test('invalid rubric assist requests are rejected before fetch', async () => {
  globalThis.fetch = async () => { throw new Error('fetch should not be called') }
  await assert.rejects(client.requestRubricAssist('workspace', 'job', validRequest({ instruction: ' '.repeat(3) })), /Describe the change you want/)
  await assert.rejects(client.requestRubricAssist('workspace', 'job', validRequest({ instruction: 'x'.repeat(2001) })), /Instructions are limited/)
})

test('valid responses parse and malformed assistant responses are rejected without applying operations', async () => {
  globalThis.fetch = async () => json(validResponse())
  assert.equal((await client.requestRubricAssist('workspace', 'job', validRequest())).reply, 'I updated the rubric name.')

  for (const malformed of [
    validResponse({ outcome: 'explained', operations: [{ type: 'updateRubric', name: 'Should not apply' }] }),
    { ...validResponse(), extra: true },
  ]) {
    globalThis.fetch = async () => json(malformed)
    await assert.rejects(client.requestRubricAssist('workspace', 'job', validRequest()), (caught) => {
      assert.ok(caught instanceof client.CloudApiError)
      assert.equal(caught.code, 'unavailable')
      assert.equal(caught.message, 'The assistant returned an unexpected response. Your draft is unchanged.')
      return true
    })
  }
})

test('server assist errors keep actionable typed mappings', async () => {
  globalThis.fetch = async () => error('conflict', 'The rubric changed in another session.', 409)
  await assert.rejects(client.requestRubricAssist('workspace', 'job', validRequest()), (caught) => {
    assert.ok(caught instanceof client.CloudConflictError)
    assert.equal(caught.message, 'The rubric changed in another session.')
    return true
  })

  globalThis.fetch = async () => error('unavailable', 'Too many assistant requests.', 429, { 'Retry-After': '17' })
  await assert.rejects(client.requestRubricAssist('workspace', 'job', validRequest()), (caught) => {
    assert.equal(client.isAssistRateLimit(caught), true)
    assert.equal(caught.message, 'Too many assistant requests.')
    assert.equal(caught.retryAfterSeconds, 17)
    return true
  })

  globalThis.fetch = async () => error('unavailable', 'The assistant is temporarily unavailable.', 503)
  await assert.rejects(client.requestRubricAssist('workspace', 'job', validRequest()), (caught) => {
    assert.ok(caught instanceof client.CloudApiError)
    assert.equal(caught.status, 503)
    assert.equal(caught.message, 'The assistant is temporarily unavailable.')
    return true
  })
})

test('caller aborts propagate unchanged and client deadlines become assistant timeout errors', async () => {
  const cancellation = new DOMException('Reviewer cancelled', 'AbortError')
  const controller = new AbortController()
  controller.abort(cancellation)
  let calls = 0
  globalThis.fetch = async () => { calls++; return json(validResponse()) }
  await assert.rejects(client.requestRubricAssist('workspace', 'job', validRequest(), controller.signal), (caught) => caught === cancellation)
  assert.equal(calls, 0)

  AbortSignal.timeout = () => AbortSignal.abort(new DOMException('Deadline', 'TimeoutError'))
  await assert.rejects(client.requestRubricAssist('workspace', 'job', validRequest()), (caught) => {
    assert.ok(caught instanceof client.AssistRequestError)
    assert.equal(caught.kind, 'timeout')
    assert.equal(caught.message, 'The assistant took too long to respond. Your draft is unchanged.')
    return true
  })
})

test('default cloud requests keep the 30 second timeout while assist opts in to 170 seconds', async () => {
  const timeouts = []
  AbortSignal.timeout = (milliseconds) => {
    timeouts.push(milliseconds)
    return new AbortController().signal
  }
  globalThis.fetch = async (url) => url.endsWith('/features') ? json({}) : json(validResponse())

  await client.cloudJsonRequest('/features', { method: 'GET' })
  await client.requestRubricAssist('workspace', 'job', validRequest())

  assert.deepEqual(timeouts, [30_000, client.ASSIST_LIMITS.clientTimeoutMilliseconds])
})

test('rubricAssistant feature mapping is true only when advertised', async () => {
  for (const [advertised, expected] of [
    [{ realJobImports: true, rubricAssistant: true }, true],
    [{ realJobImports: true, rubricAssistant: false }, false],
    [{ realJobImports: true }, false],
  ]) {
    globalThis.fetch = async () => json(advertised)
    const features = await client.fetchJobProcessingFeatures()
    assert.equal(features.rubricAssistant, expected)
    assert.equal(client.jobFeaturesWithPolicy(features).rubricAssistant, expected)
  }
})
