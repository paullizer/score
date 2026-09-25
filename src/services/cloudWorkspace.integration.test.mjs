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
let client, originalClock
before(async () => {
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), contents: `
      export * from './src/services/cloudWorkspace'
      export * from './src/app/real-request-scope'
    ` },
    outfile: join(output, 'client.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    logLevel: 'silent',
  })
  client = await import(pathToFileURL(join(output, 'client.mjs')).href)
  originalClock = { ...client.cloudRetryClock }
})
afterEach(() => {
  globalThis.fetch = originalFetch
  AbortSignal.timeout = originalTimeout
  Object.assign(client.cloudRetryClock, originalClock)
  client.setCloudSessionAccess(null)
})
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
  await assert.rejects(client.cloudJsonRequest('/workspaces/test/records'), (error) => {
    assert.ok(error instanceof client.CloudTimeoutError)
    assert.ok(error instanceof client.CloudApiError)
    assert.equal(error.status, 408)
    assert.equal(error.acknowledgementUnknown, false)
    assert.match(error.message, /didn’t get a response within 30 seconds/)
    assert.match(error.message, /Nothing was changed/)
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
        await assert.rejects(request('/workspaces/test/records'), (error) =>
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
      assert.match(error.message, /can’t tell yet whether your change was saved/)
      assert.match(error.message, /Reload to check before trying again/)
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
    await assert.rejects(request('/workspaces/test/records', { signal: caller.signal }), (error) => error === cancellation)
  }
  const caller = new AbortController()
  caller.abort()
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({}) }
  await assert.rejects(client.cloudJsonRequest('/workspaces/test/records', { signal: caller.signal }), { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('non-timeout body and network failures are not swallowed or converted to acknowledgements', async () => {
  for (const error of [new TypeError('Connection interrupted'), new SyntaxError('Malformed API body')]) {
    globalThis.fetch = async () => { throw error }
    await assert.rejects(client.cloudJsonRequest('/workspaces/test/records'), (caught) => caught === error)
    assert.equal(client.isCloudNetworkFailure(error), error instanceof TypeError, 'Only a dropped connection is recorded as a network failure')
  }
  const error = new TypeError('Lifecycle response stream interrupted')
  globalThis.fetch = async () => bodyFailure(503, async () => { throw error })
  await assert.rejects(client.cloudLifecycleRequest('/workspaces/test/lifecycle', { method: 'POST' }), (caught) => caught === error)
})

function virtualClock() {
  const clock = { now: 0, waits: [] }
  client.cloudRetryClock.now = () => clock.now
  client.cloudRetryClock.sleep = async (milliseconds, signal) => { signal?.throwIfAborted(); clock.waits.push(milliseconds); clock.now += milliseconds }
  return clock
}
function recordDeadlines() {
  const deadlines = []
  AbortSignal.timeout = (milliseconds) => { deadlines.push(milliseconds); return new AbortController().signal }
  return deadlines
}
const patientWait = { attemptTimeoutMilliseconds: 120_000, totalWaitMilliseconds: 600_000 }
const envelope = (status, code, message, headers = {}) => Response.json({ error: { code, message } }, { status, headers })

test('timeout messages state the deadline that actually applied', async () => {
  const deadlines = recordDeadlines()
  globalThis.fetch = async () => { throw timeout() }
  await assert.rejects(client.cloudJsonRequest('/workspaces/test/action', { method: 'POST', body: '{}', timeoutMilliseconds: 120_000 }), (error) => {
    assert.ok(error instanceof client.CloudTimeoutError)
    assert.match(error.message, /within 120 seconds/)
    return true
  })
  assert.deepEqual(deadlines, [120_000])
})

test('idempotent requests re-send identical bytes and key until Score gives a definite answer', async () => {
  const clock = virtualClock()
  const deadlines = recordDeadlines()
  const key = randomUUID()
  const body = JSON.stringify({ name: 'Large analysis' })
  const requests = []
  const answers = [
    () => { throw timeout() },
    () => { throw new TypeError('Failed to fetch') },
    () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    () => envelope(409, 'conflict', 'Another workspace change is in progress. Reload and retry.', { 'Retry-After': '2' }),
    () => envelope(503, 'unavailable', 'Try again shortly.', { 'Retry-After': '120' }),
    () => Response.json({ run: { id: 'accepted' } }, { status: 202 }),
  ]
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return answers[requests.length - 1]() }
  const result = await client.cloudIdempotentJsonRequest('/workspaces/test/analyses', {
    method: 'POST', headers: { 'Idempotency-Key': key }, body,
  }, patientWait)
  assert.deepEqual(result, { run: { id: 'accepted' } })
  assert.equal(requests.length, answers.length)
  assert.ok(requests.every(({ url, init }) => url === '/api/workspaces/test/analyses' && init.method === 'POST' &&
    init.body === body && init.headers.get('Idempotency-Key') === key), 'Every try sends the identical request')
  assert.deepEqual(clock.waits, [1_000, 2_000, 4_000, 2_000, 30_000], 'Backoff grows; Retry-After sets its own bounded pause')
  assert.deepEqual(deadlines, Array(answers.length).fill(120_000))
})

test('definite answers, caller cancellation and unsafe requests are never re-sent', async () => {
  virtualClock()
  const init = () => ({ method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: '{}' })
  for (const [status, code] of [[400, 'invalid_request'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict'], [503, 'unavailable']]) {
    let calls = 0
    globalThis.fetch = async () => { calls++; return envelope(status, code, `Definite ${status}`) }
    await assert.rejects(client.cloudIdempotentJsonRequest('/workspaces/test/analyses', init(), patientWait),
      (error) => error.status === status && error.message === `Definite ${status}`)
    assert.equal(calls, 1, `Score's own HTTP ${status} without Retry-After is a definite answer`)
  }
  let calls = 0
  globalThis.fetch = async () => { calls++; return envelope(401, 'unauthorized', 'Sign in again.') }
  await assert.rejects(client.cloudIdempotentJsonRequest('/workspaces/test/analyses', init(), patientWait), client.CloudAuthError)
  assert.equal(calls, 1)

  const caller = new AbortController()
  const leaving = new DOMException('Left the page', 'AbortError')
  calls = 0
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch') }
  client.cloudRetryClock.sleep = async (_milliseconds, signal) => { caller.abort(leaving); signal.throwIfAborted() }
  await assert.rejects(client.cloudIdempotentJsonRequest('/workspaces/test/analyses', { ...init(), signal: caller.signal }, patientWait),
    (error) => error === leaving)
  assert.equal(calls, 1, 'Cancelling while waiting stops further tries')

  calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({}) }
  await assert.rejects(client.cloudIdempotentJsonRequest('/workspaces/test/analyses', { method: 'POST', body: '{}' }, patientWait), /Idempotency-Key/)
  await assert.rejects(client.cloudIdempotentJsonRequest('/workspaces/test/analyses', { ...init(), body: new Blob(['{}']) }, patientWait), /replayable/)
  assert.equal(calls, 0)
  assert.equal(client.isCloudRetryableFailure(new client.CloudAccessChangedError()), false)
})

test('an access change while waiting to resend stops every later try', async () => {
  const session = (role, userId = 'user-a') => ({
    mode: 'cloud', user: { tenantId: 'tenant-one', id: userId },
    capabilities: { applicationAdmin: false, canCreateWorkspaces: false },
    workspaces: [{ id: 'workspace-one', name: 'Shared', kind: 'group', role, createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:00.000Z', etag: '"workspace"' }],
  })
  for (const next of [session('editor'), session('owner', 'user-b')]) {
    virtualClock()
    client.setCloudSessionAccess(session('owner'))
    let calls = 0
    globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch') }
    client.cloudRetryClock.sleep = async (_milliseconds, signal) => { client.setCloudSessionAccess(next); signal.throwIfAborted() }
    await assert.rejects(client.cloudIdempotentJsonRequest('/workspaces/workspace-one/analyses', {
      method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: '{}',
    }, patientWait), client.CloudAccessChangedError)
    assert.equal(calls, 1, 'The request is not resent under the changed role or signed-in user')
  }

  virtualClock()
  client.setCloudSessionAccess(session('owner'))
  let calls = 0
  let resolveSleep
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch') }
  client.cloudRetryClock.sleep = (_milliseconds, signal) => new Promise((resolve, reject) => {
    resolveSleep = resolve
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const waiting = client.cloudIdempotentJsonRequest('/workspaces/workspace-one/analyses', {
    method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: '{}',
  }, patientWait)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(resolveSleep, 'The first failed try is waiting to resend')
  client.setCloudSessionAccess(session('editor'))
  await assert.rejects(waiting, client.CloudAccessChangedError, 'The pause ends as soon as access changes')
  assert.equal(calls, 1)
})

test('a request that never gets a definite answer stops within its total wait with a plain message', async () => {
  const clock = virtualClock()
  const deadlines = recordDeadlines()
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch') }
  await assert.rejects(client.cloudIdempotentJsonRequest('/workspaces/test/analyses', {
    method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: '{}',
  }, { attemptTimeoutMilliseconds: 120_000, totalWaitMilliseconds: 60_000, pendingMessage: 'Still not confirmed.' }), (error) => {
    assert.ok(error instanceof client.CloudAcknowledgementPendingError)
    assert.equal(error.acknowledgementUnknown, true)
    assert.equal(error.message, 'Still not confirmed.')
    return true
  })
  assert.deepEqual(clock.waits, [1_000, 2_000, 4_000, 8_000, 15_000, 15_000])
  assert.equal(calls, clock.waits.length + 1)
  assert.equal(deadlines[0], 60_000, 'A try never outlasts the remaining total wait')
  assert.ok(deadlines.every((deadline, index) => index === 0 || deadline < deadlines[index - 1]))
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
