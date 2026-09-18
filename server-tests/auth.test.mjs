import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../dist-server/app.mjs'
import {
  ALLOWED_OID,
  NOT_ALLOWED_OID,
  OTHER_TENANT_ID,
  TENANT_ID,
  authHeaders,
  baseConfig,
  createFakeDirectoryStore,
  createFakeStateStore,
  startTestServer,
} from './helpers.mjs'

test('GET /api/session with no identity header is rejected as unauthorized', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`)
    assert.equal(response.status, 401)
    const body = await response.json()
    assert.equal(body.error.code, 'unauthorized')
  } finally {
    await server.close()
  }
})

test('GET /api/session rejects a header that is not valid base64', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: { 'x-ms-client-principal': '!!!not-base64!!!' },
    })
    assert.equal(response.status, 401)
  } finally {
    await server.close()
  }
})

test('GET /api/session rejects base64 that does not decode to JSON', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: { 'x-ms-client-principal': Buffer.from('not json at all', 'utf8').toString('base64') },
    })
    assert.equal(response.status, 401)
  } finally {
    await server.close()
  }
})

test('GET /api/session rejects a principal whose auth_typ is not aad', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: authHeaders({ authType: 'facebook' }),
    })
    assert.equal(response.status, 401)
  } finally {
    await server.close()
  }
})

test('GET /api/session rejects a principal with no claims array', async () => {
  const server = await startTestServer()
  try {
    const malformed = Buffer.from(JSON.stringify({ auth_typ: 'aad' }), 'utf8').toString('base64')
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: { 'x-ms-client-principal': malformed },
    })
    assert.equal(response.status, 401)
  } finally {
    await server.close()
  }
})

test('GET /api/session rejects a malformed claim entry (missing val)', async () => {
  const server = await startTestServer()
  try {
    const malformed = Buffer.from(
      JSON.stringify({ auth_typ: 'aad', claims: [{ typ: 'oid' }] }),
      'utf8',
    ).toString('base64')
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: { 'x-ms-client-principal': malformed },
    })
    assert.equal(response.status, 401)
  } finally {
    await server.close()
  }
})

test('GET /api/session accepts the long-form Microsoft claim URIs as an alias for tid/oid', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: authHeaders({ useLongClaimUris: true }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.user.id, ALLOWED_OID)
  } finally {
    await server.close()
  }
})

test('GET /api/session rejects a valid AAD principal from the wrong tenant with 403', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: authHeaders({ tenantId: OTHER_TENANT_ID }),
    })
    assert.equal(response.status, 403)
    const body = await response.json()
    assert.equal(body.error.code, 'forbidden')
  } finally {
    await server.close()
  }
})

test('GET /api/session rejects a valid AAD principal not on the allow-list with 403', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: authHeaders({ oid: NOT_ALLOWED_OID }),
    })
    assert.equal(response.status, 403)
  } finally {
    await server.close()
  }
})

test('GET /api/session rejects a mismatched x-ms-client-principal-id header (401, not trusted)', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: authHeaders({ principalIdHeader: NOT_ALLOWED_OID }),
    })
    assert.equal(response.status, 401)
  } finally {
    await server.close()
  }
})

test('GET /api/session accepts a matching x-ms-client-principal-id header', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: authHeaders({ principalIdHeader: ALLOWED_OID }),
    })
    assert.equal(response.status, 200)
  } finally {
    await server.close()
  }
})

test('GET /api/session with valid allow-listed principal succeeds and never uses email/name for authorization', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: authHeaders({ name: 'Someone Else', email: 'random@example.com' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.mode, 'cloud')
    assert.equal(body.user.id, ALLOWED_OID)
    assert.equal(body.user.tenantId, TENANT_ID)
  } finally {
    await server.close()
  }
})

test('GET /healthz never requires an identity header', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/healthz`)
    assert.notEqual(response.status, 401)
    assert.notEqual(response.status, 403)
  } finally {
    await server.close()
  }
})

test('dev-header auth mode accepts an explicit local developer principal', async () => {
  const server = await startTestServer({
    config: baseConfig({ authMode: 'dev-header' }),
  })
  try {
    const missing = await fetch(`${server.baseUrl}/api/session`)
    assert.equal(missing.status, 401)

    const malformed = await fetch(`${server.baseUrl}/api/session`, {
      headers: { 'x-score-dev-principal': 'not-a-valid-value' },
    })
    assert.equal(malformed.status, 401)

    const wrongUser = await fetch(`${server.baseUrl}/api/session`, {
      headers: { 'x-score-dev-principal': `${TENANT_ID}:${NOT_ALLOWED_OID}` },
    })
    assert.equal(wrongUser.status, 403)

    const ok = await fetch(`${server.baseUrl}/api/session`, {
      headers: { 'x-score-dev-principal': `${TENANT_ID}:${ALLOWED_OID}` },
    })
    assert.equal(ok.status, 200)
  } finally {
    await server.close()
  }
})

test('createApp fails closed if dev-header mode is configured for production or App Service', () => {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  assert.throws(() =>
    createApp({
      config: baseConfig({ authMode: 'dev-header', isProduction: true }),
      directory,
      state,
    }),
  )
  assert.throws(() =>
    createApp({
      config: baseConfig({ authMode: 'dev-header', isAppService: true }),
      directory,
      state,
    }),
  )
})
