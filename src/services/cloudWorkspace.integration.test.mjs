import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = resolve(`.cloud-client-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
const originalTimeout = AbortSignal.timeout
let client
before(async () => {
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), contents: `
      export * from './src/services/cloudWorkspace'
      export * from './src/app/real-request-scope'
    ` },
    outfile: join(output, 'client.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' },
  })
  client = await import(pathToFileURL(join(output, 'client.mjs')).href)
})
afterEach(() => { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout })
after(async () => { await rm(output, { recursive: true, force: true }) })

const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')
function bodyFailure(status, fail) {
  const response = Response.json({ error: { code: 'unavailable', message: 'Not acknowledged.' } }, { status })
  response.json = fail
  response.clone = () => response
  return response
}
function deadline() {
  const controller = new AbortController()
  AbortSignal.timeout = (milliseconds) => {
    assert.equal(milliseconds, 30_000, 'The existing request deadline is unchanged.')
    return controller.signal
  }
  return controller
}

test('fetch deadlines become understandable typed read errors without replaying the request', async () => {
  deadline()
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); throw timeout() }
  await assert.rejects(client.cloudJsonRequest('/workspaces/test/state'), (error) => {
    assert.ok(error instanceof client.CloudTimeoutError)
    assert.ok(error instanceof client.CloudApiError)
    assert.equal(error.status, 408)
    assert.equal(error.acknowledgementUnknown, false)
    assert.match(error.message, /timed out after 30 seconds/)
    assert.match(error.message, /read did not change/)
    return true
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.cache, 'no-store')
})

test('JSON, ETag and lifecycle reads normalize deadlines in both success bodies and error envelopes', async () => {
  for (const request of [client.cloudJsonRequest, client.cloudJsonResponse, client.cloudLifecycleRequest]) {
    for (const status of [200, 401, 403, 409, 503]) {
      for (const streamAbort of [false, true]) {
        const timer = deadline()
        globalThis.fetch = async () => bodyFailure(status, async () => {
          if (!streamAbort) throw timeout()
          timer.abort(timeout())
          throw new DOMException('The response stream was aborted', 'AbortError')
        })
        await assert.rejects(request('/workspaces/test/state'), (error) =>
          error instanceof client.CloudTimeoutError && error.acknowledgementUnknown === false)
      }
    }
  }
})

test('timed-out writes explicitly retain ambiguous acknowledgement, original idempotency and no automatic replay', async () => {
  const requests = []
  const key = randomUUID()
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    deadline()
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init })
      return bodyFailure(200, async () => { throw timeout() })
    }
    await assert.rejects(client.cloudJsonRequest('/workspaces/test/action', {
      method, headers: { 'Idempotency-Key': key, 'If-Match': '"original"' }, body: JSON.stringify({ action: 'retry' }),
    }), (error) => {
      assert.ok(error instanceof client.CloudTimeoutError)
      assert.equal(error.acknowledgementUnknown, true)
      assert.match(error.message, /may still have been accepted/)
      assert.match(error.message, /do not assume it was saved/)
      return true
    })
  }
  assert.equal(requests.length, 4)
  assert.ok(requests.every(({ init }) => init.headers.get('Idempotency-Key') === key && init.headers.get('If-Match') === '"original"'))
})

test('intentional caller cancellation remains AbortError even during body reads and is never labeled timeout', async () => {
  for (const request of [client.cloudJsonRequest, client.cloudJsonResponse, client.cloudLifecycleRequest]) {
    const timer = deadline()
    const caller = new AbortController()
    const cancellation = new DOMException('Navigated away from saved evidence', 'AbortError')
    globalThis.fetch = async () => bodyFailure(200, async () => {
      caller.abort(cancellation)
      timer.abort(timeout())
      throw cancellation
    })
    await assert.rejects(request('/workspaces/test/state', { signal: caller.signal }), (error) => error === cancellation)
  }
  const caller = new AbortController()
  caller.abort()
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({}) }
  await assert.rejects(client.cloudJsonRequest('/workspaces/test/state', { signal: caller.signal }), { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('non-timeout body and network failures are not swallowed or converted to acknowledgements', async () => {
  for (const error of [new TypeError('Connection interrupted'), new SyntaxError('Malformed API body')]) {
    globalThis.fetch = async () => { throw error }
    await assert.rejects(client.cloudJsonRequest('/workspaces/test/state'), (caught) => caught === error)
  }
  const error = new TypeError('Lifecycle response stream interrupted')
  globalThis.fetch = async () => bodyFailure(503, async () => { throw error })
  await assert.rejects(client.cloudLifecycleRequest('/workspaces/test/lifecycle', { method: 'POST' }), (caught) => caught === error)
})

test('active read scheduling backs off unchanged or failed reads, caps at 30 seconds and resets on revision changes', () => {
  const schedule = new client.RealReadBackoff()
  let now = 0
  assert.equal(schedule.due('subject', now), true)
  schedule.record('subject', 'revision-one', now)
  for (const delay of [3000, 6000, 12000, 24000, 30000, 30000]) {
    assert.equal(schedule.due('subject', now + delay - 1), false)
    now += delay
    assert.equal(schedule.due('subject', now), true)
    schedule.record('subject', 'revision-one', now)
  }
  schedule.record('subject', undefined, now)
  assert.equal(schedule.due('subject', now + 29999), false)
  schedule.record('subject', 'revision-two', now)
  assert.equal(schedule.due('subject', now + 3000), true)
  schedule.clear((key) => key === 'subject')
  assert.equal(schedule.due('subject', now), true)
})
