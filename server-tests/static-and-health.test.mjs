import assert from 'node:assert/strict'
import test from 'node:test'
import { ALLOWED_OID, authHeaders, baseConfig, startTestServer } from './helpers.mjs'

test('Unknown /api routes return a JSON CloudApiError, never the SPA HTML fallback', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/this-route-does-not-exist`, { headers: authHeaders() })
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    const body = await response.json()
    assert.equal(body.error.code, 'not_found')
  } finally {
    await server.close()
  }
})

test('Unknown /api routes still require authentication (401 before the 404 is ever reached)', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/this-route-does-not-exist`)
    assert.equal(response.status, 401)
  } finally {
    await server.close()
  }
})

test('The SPA shell is served for a BrowserRouter-style /workspaces/:id deep link and nested sub-routes', async () => {
  const server = await startTestServer()
  try {
    // The frontend uses a per-workspace basename (/workspaces/:id/...); a hard refresh or shared
    // link on any nested client-side route under it must still resolve to the SPA shell, not a 404.
    const workspaceId = '1d6312bd-3eaa-4586-8b74-e90eee126f78'
    for (const routePath of [
      `/workspaces/${workspaceId}`,
      `/workspaces/${workspaceId}/`,
      `/workspaces/${workspaceId}/jobs`,
      `/workspaces/${workspaceId}/resumes/some-resume-id`,
    ]) {
      const response = await fetch(`${server.baseUrl}${routePath}`, { headers: authHeaders() })
      assert.equal(response.status, 200, `expected the SPA shell for ${routePath}`)
      assert.match(response.headers.get('content-type') ?? '', /text\/html/)
      assert.match(await response.text(), /Score test fixture shell/)
    }
  } finally {
    await server.close()
  }
})

test('The SPA shell is served for an authenticated non-API GET request (client-side routing fallback)', async () => {
  const server = await startTestServer()
  try {
    const root = await fetch(`${server.baseUrl}/`, { headers: authHeaders() })
    assert.equal(root.status, 200)
    assert.match(root.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await root.text(), /Score test fixture shell/)

    const deepLink = await fetch(`${server.baseUrl}/workspaces/some-deep-client-route`, { headers: authHeaders() })
    assert.equal(deepLink.status, 200)
    assert.match(await deepLink.text(), /Score test fixture shell/)
  } finally {
    await server.close()
  }
})

test('Static/SPA routes require authentication just like the API does', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/`)
    assert.equal(response.status, 401)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  } finally {
    await server.close()
  }
})

test('Hashed asset files are served with long, immutable caching', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/assets/app.abc123.js`, { headers: authHeaders() })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /immutable/)
  } finally {
    await server.close()
  }
})

test('Path traversal attempts against static files do not escape the dist directory', async () => {
  const server = await startTestServer()
  try {
    const attempts = ['/..%2f..%2fpackage.json', '/assets/..%2f..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json']
    for (const attempt of attempts) {
      const response = await fetch(`${server.baseUrl}${attempt}`, { headers: authHeaders() })
      const text = await response.text()
      assert.ok(!text.includes('@azure/cosmos'), `must not leak repository files for ${attempt}`)
    }
  } finally {
    await server.close()
  }
})

test('/healthz is anonymous and reports ready when both stores are reachable', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/healthz`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.deepEqual(Object.keys(body), ['status'])
    assert.equal(body.status, 'ready')
  } finally {
    await server.close()
  }
})

test('role-aware admission marker is Easy Auth-only and never changes healthy or unavailable health JSON', async () => {
  for (const authMode of ['easyauth', 'dev-header']) {
    for (const unavailable of [false, true]) {
      const server = await startTestServer({ config: baseConfig({
        authMode, ...(authMode === 'dev-header' ? { devUserRoles: new Map([[ALLOWED_OID, ['Score.User']]]) } : {}),
      }) })
      try {
        if (unavailable) server.directory._setAccessError(new Error('Fixture dependency unavailable'))
        const response = await fetch(`${server.baseUrl}/healthz`)
        assert.equal(response.status, unavailable ? 503 : 200)
        assert.equal(response.headers.get('x-score-access-control'), authMode === 'easyauth' ? 'entra-roles-v1' : null)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await response.json(), { status: unavailable ? 'unavailable' : 'ready' })
      } finally { await server.close() }
    }
  }
})

test('/healthz reports unavailable (503) if either the directory or state store is unreachable', async () => {
  const server = await startTestServer()
  try {
    server.directory._setAccessError(new Error('Cosmos is down (test).'))
    const response = await fetch(`${server.baseUrl}/healthz`)
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.status, 'unavailable')
    assert.deepEqual(Object.keys(body), ['status'])
  } finally {
    await server.close()
  }
})

test('/healthz never echoes configuration or secrets, and caches briefly instead of re-checking every call', async () => {
  const server = await startTestServer()
  try {
    const first = await (await fetch(`${server.baseUrl}/healthz`)).json()
    assert.equal(first.status, 'ready')

    // Flip the fake to failing immediately after a success; a cached result should still be
    // returned for a rapid follow-up call rather than re-probing the (now failing) stores.
    server.directory._setAccessError(new Error('Cosmos is down (test).'))
    const second = await (await fetch(`${server.baseUrl}/healthz`)).json()
    assert.equal(second.status, 'ready', 'a rapid follow-up call should reuse the cached result')
  } finally {
    await server.close()
  }
})
