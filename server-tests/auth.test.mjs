import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../dist-server/app.mjs'
import {
  ALLOWED_OID,
  NOT_ALLOWED_OID,
  OTHER_TENANT_ID,
  TENANT_ID,
  authHeaders as fixtureAuthHeaders,
  baseConfig,
  createFakeDirectoryStore,
  createFakeStateStore,
  startTestServer,
} from './helpers.mjs'
import { build } from 'esbuild'

const authBundle = await build({
  entryPoints: ['server/auth.ts'], bundle: true, packages: 'external', platform: 'node',
  format: 'esm', target: 'node24', write: false,
})
const { isApplicationAdmin, parseEasyAuthPrincipal, parseDevHeaderPrincipal } = await import(
  `data:text/javascript;base64,${Buffer.from(authBundle.outputFiles[0].contents).toString('base64')}`)

function authHeaders({ roles = ['Score.User'], roleClaimType = 'roles', ...options } = {}) {
  const headers = fixtureAuthHeaders(options)
  const principal = JSON.parse(Buffer.from(headers['x-ms-client-principal'], 'base64').toString('utf8'))
  principal.claims = principal.claims.filter(claim =>
    !['roles', 'role', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'].includes(claim.typ))
  principal.claims.push(...roles.map(val => ({ typ: roleClaimType, val })))
  principal.role_typ = roleClaimType
  headers['x-ms-client-principal'] = Buffer.from(JSON.stringify(principal)).toString('base64')
  return headers
}

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

test('GET /api/session rejects an allowlisted AAD principal without a Score application role', async () => {
  const server = await startTestServer()
  try {
    const response = await fetch(`${server.baseUrl}/api/session`, {
      headers: authHeaders({ roles: [] }),
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

test('GET /api/session with a Score role succeeds and never uses email/name for authorization', async () => {
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
    config: baseConfig({ authMode: 'dev-header', devUserRoles: new Map([[ALLOWED_OID, ['Score.User']]]) }),
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

test('User, Admin alone, and both roles admit users independently of a retired ID allowlist', async () => {
  const server = await startTestServer()
  try {
    for (const roles of [['Score.User'], ['Score.Admin'], ['Score.User', 'Score.Admin']]) {
      const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders({ oid: NOT_ALLOWED_OID, roles }) })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-score-admission-version'), 'entra-roles-v1')
    }
  } finally { await server.close() }
})

test('standard and mapped Easy Auth role claims are exact, deduplicated and privilege-ordered', () => {
  for (const roleClaimType of ['roles', 'role', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role']) {
    const header = authHeaders({ roles: ['Score.User', 'Score.Admin', 'Score.User'], roleClaimType })['x-ms-client-principal']
    const principal = parseEasyAuthPrincipal(header, undefined, baseConfig())
    assert.deepEqual(principal.applicationRoles, ['Score.Admin', 'Score.User'])
    assert.equal(isApplicationAdmin(principal), true)
    assert.equal(isApplicationAdmin(principal, baseConfig({ tenantId: OTHER_TENANT_ID })), false)
  }
  for (const roles of [[], ['Admin'], ['User'], ['score.admin'], ['Score.User,Score.Admin'], ['["Score.User"]'], [' Score.User']]) {
    assert.throws(() => parseEasyAuthPrincipal(authHeaders({ roles })['x-ms-client-principal'], undefined, baseConfig()),
      error => error.kind === 'forbidden')
  }
})

test('admin IDs, allowlist entries, workspace ownership and arbitrary claims never designate an application admin', () => {
  const config = baseConfig({ adminUserIds: new Set([ALLOWED_OID]) })
  const principal = { oid: ALLOWED_OID, tenantId: TENANT_ID, role: 'owner' }
  assert.equal(isApplicationAdmin(principal, config), false)
  assert.equal(isApplicationAdmin({ ...principal, applicationRoles: ['Score.User'] }, config), false)
  assert.throws(() => parseEasyAuthPrincipal(authHeaders({ roles: ['Score.Admin'], roleClaimType: 'name' })['x-ms-client-principal'], undefined, config))
})

test('conflicting immutable identity claims and service identities are rejected', () => {
  for (const extraClaims of [
    [{ typ: 'tid', val: OTHER_TENANT_ID }],
    [{ typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: NOT_ALLOWED_OID }],
    [{ typ: 'oid', val: 'not-a-guid' }],
    [{ typ: 'idtyp', val: 'app' }],
    [{ typ: 'http://schemas.microsoft.com/identity/claims/identitytype', val: 'app' }],
  ]) {
    assert.throws(() => parseEasyAuthPrincipal(authHeaders({ roles: ['Score.Admin'], extraClaims })['x-ms-client-principal'], undefined, baseConfig()))
  }
})

test('developer roles are explicit, local-only, and cannot be chosen in a request header', () => {
  const config = baseConfig({ authMode: 'dev-header', devUserRoles: new Map([[ALLOWED_OID, ['Score.Admin']]]) })
  const header = `${TENANT_ID}:${ALLOWED_OID}`
  assert.deepEqual(parseDevHeaderPrincipal(header, config).applicationRoles, ['Score.Admin'])
  for (const invalid of [`${header}:Score.Admin`, `${TENANT_ID}:${NOT_ALLOWED_OID}`]) {
    assert.throws(() => parseDevHeaderPrincipal(invalid, config))
  }
  for (const overrides of [{ isProduction: true }, { isAppService: true }, { authMode: 'easyauth' }, { devUserRoles: undefined }]) {
    assert.throws(() => parseDevHeaderPrincipal(header, { ...config, ...overrides }))
  }
})

test('API and SPA admission use the same Score role policy', async () => {
  const server = await startTestServer()
  try {
    for (const path of ['/api/session', '/']) {
      const forbidden = await fetch(`${server.baseUrl}${path}`, { headers: authHeaders({ roles: [] }) })
      assert.equal(forbidden.status, 403)
      const accepted = await fetch(`${server.baseUrl}${path}`, { headers: authHeaders({ roles: ['Score.Admin'] }) })
      assert.equal(accepted.status, 200)
      assert.equal(accepted.headers.get('x-score-application-roles'), 'Score.Admin')
    }
  } finally { await server.close() }
})
