import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import {
  assertCredentialFreeEnvironment,
  createRendererApp,
  RendererError,
} from '../dist-renderer/app.mjs'

const unusedFetcher = async () => {
  throw new Error('fetcher should not be called')
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}

function renderRequest(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/render`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-score-worker': 'job-ingestion',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('condition was not reached')
}

test('health is anonymous while render enforces the internal worker interface guard', async () => {
  const app = createRendererApp({
    fetcher: unusedFetcher,
    render: async (url) => ({ html: '<html></html>', finalUrl: url }),
  })

  await withServer(app, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ready' })
    assert.equal(health.headers.get('access-control-allow-origin'), null)

    const missingHeader = await fetch(`${baseUrl}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://jobs.example/role' }),
    })
    assert.equal(missingHeader.status, 403)
    assert.equal((await missingHeader.json()).error.code, 'worker_header_required')

    const browserRequest = await renderRequest(
      baseUrl,
      { url: 'https://jobs.example/role' },
      { origin: 'https://attacker.example' },
    )
    assert.equal(browserRequest.status, 403)
    assert.equal((await browserRequest.json()).error.code, 'browser_request_rejected')
  })
})

test('render validates the exact JSON schema and enforces the 16 KB body limit', async () => {
  let renderCalls = 0
  const app = createRendererApp({
    fetcher: unusedFetcher,
    render: async (url) => {
      renderCalls += 1
      return { html: '<html></html>', finalUrl: url }
    },
  })

  await withServer(app, async (baseUrl) => {
    const extraField = await renderRequest(baseUrl, {
      url: 'https://jobs.example/role',
      workspace: 'forbidden',
    })
    assert.equal(extraField.status, 400)
    assert.equal((await extraField.json()).error.code, 'invalid_request')

    const oversized = await renderRequest(baseUrl, { url: `https://jobs.example/${'a'.repeat(17_000)}` })
    assert.equal(oversized.status, 413)
    assert.equal((await oversized.json()).error.code, 'request_too_large')
    assert.equal(renderCalls, 0)
  })
})

test('render maps safe public transport and rendering failures to stable envelopes', async () => {
  const cases = [
    ['unsafe_url', 400, 'unsafe_url'],
    ['limit_exceeded', 413, 'limit_exceeded'],
    ['render_timeout', 504, 'render_timeout'],
    ['render_failed', 502, 'render_failed'],
  ]

  for (const [rendererCode, status, responseCode] of cases) {
    const app = createRendererApp({
      fetcher: unusedFetcher,
      render: async () => {
        throw new RendererError(rendererCode, 'internal detail that must not be exposed')
      },
    })
    await withServer(app, async (baseUrl) => {
      const response = await renderRequest(baseUrl, { url: 'https://jobs.example/role' })
      assert.equal(response.status, status)
      const body = await response.json()
      assert.equal(body.error.code, responseCode)
      assert.doesNotMatch(body.error.message, /internal detail/)
    })
  }
})

test('render limits active work and rejects beyond its bounded queue', async () => {
  const pending = []
  const render = (url) => new Promise((resolve) => {
    pending.push(() => resolve({ html: `<html>${url}</html>`, finalUrl: url }))
  })
  const app = createRendererApp({
    fetcher: unusedFetcher,
    render,
    maxConcurrency: 1,
    maxQueue: 1,
  })

  await withServer(app, async (baseUrl) => {
    const first = renderRequest(baseUrl, { url: 'https://jobs.example/one' })
    await waitFor(() => pending.length === 1)
    const second = renderRequest(baseUrl, { url: 'https://jobs.example/two' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const third = await renderRequest(baseUrl, { url: 'https://jobs.example/three' })
    assert.equal(third.status, 429)
    assert.equal((await third.json()).error.code, 'busy')

    pending.shift()()
    assert.equal((await first).status, 200)
    await waitFor(() => pending.length === 1)
    pending.shift()()
    assert.equal((await second).status, 200)
  })
})

test('credential-free startup guard rejects Azure identity variables even when empty', () => {
  assert.doesNotThrow(() => assertCredentialFreeEnvironment({ PORT: '8080' }))
  assert.throws(
    () => assertCredentialFreeEnvironment({ IDENTITY_ENDPOINT: '' }),
    /IDENTITY_ENDPOINT/,
  )
  assert.throws(
    () => assertCredentialFreeEnvironment({ AZURE_CLIENT_ID: 'not-allowed' }),
    /AZURE_CLIENT_ID/,
  )
})
