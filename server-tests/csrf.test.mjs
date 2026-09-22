import assert from 'node:assert/strict'
import test from 'node:test'
import { ALLOWED_OID, APP_ORIGIN, CSRF_HEADER, authHeaders, createFakeAccessStore, startTestServer } from './helpers.mjs'

test('POST /api/workspaces without an Origin header is rejected (CSRF)', async () => {
  const server = await startTestServer({ accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...authHeaders(), ...CSRF_HEADER, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New workspace' }),
    })
    assert.equal(response.status, 403)
    const body = await response.json()
    assert.equal(body.error.code, 'forbidden')
  } finally {
    await server.close()
  }
})

test('POST /api/workspaces with a mismatched Origin header is rejected (CSRF)', async () => {
  const server = await startTestServer({ accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...authHeaders(), ...CSRF_HEADER, origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New workspace' }),
    })
    assert.equal(response.status, 403)
  } finally {
    await server.close()
  }
})

test('POST /api/workspaces with the correct Origin but no X-Score-Request header is rejected (CSRF)', async () => {
  const server = await startTestServer({ accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...authHeaders(), origin: APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New workspace' }),
    })
    assert.equal(response.status, 403)
  } finally {
    await server.close()
  }
})

test('POST /api/workspaces succeeds with a matching Origin and the X-Score-Request header', async () => {
  const server = await startTestServer({ accessStore: createFakeAccessStore([{ userId: ALLOWED_OID }]) })
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...authHeaders(), ...CSRF_HEADER, origin: APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New workspace' }),
    })
    assert.equal(response.status, 201)
  } finally {
    await server.close()
  }
})

test('GET requests are not subject to the CSRF Origin/header checks', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      headers: { ...authHeaders(), origin: 'https://evil.example.com' },
    })
    assert.equal(response.status, 200)
  } finally {
    await server.close()
  }
})

test('API responses never send a permissive CORS header', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      headers: { ...authHeaders(), origin: 'https://evil.example.com' },
    })
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  } finally {
    await server.close()
  }
})

test('API responses set Cache-Control: no-store', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/workspaces`, { headers: authHeaders() })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  } finally {
    await server.close()
  }
})
