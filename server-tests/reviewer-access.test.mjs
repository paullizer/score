import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  ALLOWED_OID, OTHER_ALLOWED_OID, NOT_ALLOWED_OID, OTHER_TENANT_ID, TENANT_ID, APP_ORIGIN,
  authHeaders, baseConfig, membershipFor, membershipIdFor, principalKeyFor, sampleWorkspaceBody, startTestServer,
} from './helpers.mjs'
import { createFakeRealJobs } from './job-lifecycle-fakes.mjs'

const headers = { origin: APP_ORIGIN, 'X-Score-Request': 'workspace', 'content-type': 'application/json' }

async function setup(t, overrides = {}) {
  const server = await startTestServer(overrides)
  t.after(async () => { server.server.closeAllConnections(); await server.close() })
  const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
  assert.equal(response.status, 200)
  server.workspace = (await response.json()).workspaces[0]
  server.path = `/api/workspaces/${server.workspace.id}`
  server.request = (suffix = '/reviewers', options = {}) => fetch(`${server.baseUrl}${server.path}${suffix}`, {
    method: options.method ?? 'GET',
    headers: {
      ...authHeaders({ oid: options.oid ?? ALLOWED_OID, ...(options.identity ?? {}) }),
      ...(options.method && options.method !== 'GET' ? headers : {}),
      ...(options.etag !== undefined ? { 'If-Match': options.etag } : {}), ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  return server
}

async function access(server) {
  const response = await server.request()
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const body = await response.json()
  assert.equal(response.headers.get('ETag'), body.etag)
  return body
}

async function add(server, etag, objectId = OTHER_ALLOWED_OID, label) {
  return server.request('/reviewers', { method: 'POST', etag, body: { objectId, ...(label ? { label } : {}) } })
}

test('owners grant and revoke exact admitted reviewer memberships with immutable audit and current membership reads', async t => {
  const server = await setup(t)
  const ownerKey = principalKeyFor(TENANT_ID, ALLOWED_OID)
  const ownerMembership = await server.directory.getStoredMembership(server.workspace.id, membershipIdFor(ownerKey))
  const original = await access(server)
  assert.deepEqual(original.reviewers, [])
  assert.equal(original.tenantId, TENANT_ID)

  const created = await add(server, original.etag, OTHER_ALLOWED_OID.toUpperCase(), '  Friendly administrator label  ')
  assert.equal(created.status, 201, await created.clone().text())
  const granted = await created.json()
  assert.notEqual(granted.etag, original.etag)
  assert.equal(created.headers.get('ETag'), granted.etag)
  assert.deepEqual(granted.reviewers, [{ objectId: OTHER_ALLOWED_OID, role: 'reviewer', label: 'Friendly administrator label' }])
  const member = await server.directory.getStoredMembership(server.workspace.id, membershipIdFor(principalKeyFor(TENANT_ID, OTHER_ALLOWED_OID)))
  assert.equal(member.membership.role, 'reviewer')
  assert.equal(member.membership.principalType, 'user')
  assert.deepEqual(await server.directory.getStoredMembership(server.workspace.id, membershipIdFor(ownerKey)), ownerMembership)

  const identity = await fetch(`${server.baseUrl}/api/session/identity`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID, name: 'Owner', email: 'owner@example.test' }) })
  assert.equal((await identity.json()).capabilities.applicationAdmin, false, 'A friendly label is never app-admin promotion')
  const directory = await fetch(`${server.baseUrl}/api/workspaces`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })
  assert.equal((await directory.json()).workspaces.find(item => item.id === server.workspace.id).role, 'reviewer')
  assert.equal((await server.request('/state', { oid: OTHER_ALLOWED_OID })).status, 200)
  assert.equal((await server.request('/reviewers', { oid: OTHER_ALLOWED_OID })).status, 403)
  assert.equal((await add(server, original.etag)).status, 409)
  assert.equal((await add(server, granted.etag)).status, 409, 'Duplicate grants do not overwrite or add audit events')

  const removed = await server.request(`/reviewers/${OTHER_ALLOWED_OID}`, { method: 'DELETE', etag: granted.etag })
  assert.equal(removed.status, 200, await removed.clone().text())
  const revoked = await removed.json()
  assert.deepEqual(revoked.reviewers, [])
  assert.notEqual(revoked.etag, granted.etag)
  assert.equal((await server.request('/state', { oid: OTHER_ALLOWED_OID })).status, 404)
  const memberships = await fetch(`${server.baseUrl}/api/workspaces`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })
  assert.ok(!(await memberships.json()).workspaces.some(item => item.id === server.workspace.id))
  assert.equal((await server.request(`/reviewers/${OTHER_ALLOWED_OID}`, { method: 'DELETE', etag: granted.etag })).status, 409)
  assert.deepEqual(await server.directory.getStoredMembership(server.workspace.id, membershipIdFor(ownerKey)), ownerMembership)
  const audits = server.directory._membershipAudits(server.workspace.id)
  assert.deepEqual(audits.map(item => item.action), ['reviewer-added', 'reviewer-removed'])
  assert.equal(new Set(audits.map(item => item.id)).size, 2)
  assert.ok(audits.every(item => item.actorId === ownerKey && item.targetPrincipalId === member.membership.principalId &&
    item.membershipId === member.membership.id && item.role === 'reviewer' && item.createdAt))
})

test('reviewer membership administration stays owner-only, including for member and nonmember application administrators', async t => {
  const config = baseConfig({ adminUserIds: new Set([OTHER_ALLOWED_OID]) })
  const server = await setup(t, { config })
  const current = await access(server)
  for (const role of [undefined, 'viewer', 'reviewer', 'editor']) {
    if (role) server.directory._addMembership(server.workspace.id, membershipFor(server.workspace.id, { oid: OTHER_ALLOWED_OID, role }))
    for (const [suffix, method, body] of [
      ['/reviewers', 'GET'],
      ['/reviewers', 'POST', { objectId: OTHER_ALLOWED_OID }],
      [`/reviewers/${ALLOWED_OID}`, 'DELETE'],
    ]) {
      const response = await server.request(suffix, { method, body, oid: OTHER_ALLOWED_OID, etag: current.etag })
      assert.equal(response.status, role ? 403 : 404, `${role ?? 'nonmember'} admin ${method}`)
    }
  }
  assert.deepEqual(server.directory._membershipAudits(server.workspace.id), [])
})

test('reviewer mutations reject forged roles, principals, tenants, unadmitted users, weak ETags and cross-origin requests', async t => {
  const server = await setup(t)
  const { etag } = await access(server)
  assert.equal((await add(server, undefined)).status, 428)
  for (const invalid of ['*', 'W/"weak"', '"one", "two"']) assert.equal((await add(server, invalid)).status, 400)
  for (const body of [
    { objectId: OTHER_ALLOWED_OID, role: 'owner' }, { objectId: OTHER_ALLOWED_OID, role: 'editor' },
    { objectId: OTHER_ALLOWED_OID, applicationAdmin: true }, { objectId: OTHER_ALLOWED_OID, tenantId: OTHER_TENANT_ID },
    { objectId: OTHER_ALLOWED_OID, principalId: principalKeyFor(TENANT_ID, ALLOWED_OID) },
    { objectId: OTHER_ALLOWED_OID, actorId: 'forged' }, { objectId: NOT_ALLOWED_OID },
    { objectId: 'other@example.test' }, { objectId: 'Friendly user' }, { objectId: OTHER_ALLOWED_OID, label: 'x'.repeat(81) },
    { objectId: OTHER_ALLOWED_OID, label: 'unsafe\nlabel' }, { objectId: OTHER_ALLOWED_OID, label: { role: 'owner' } },
  ]) {
    assert.equal((await server.request('/reviewers', { method: 'POST', etag, body })).status, 400, JSON.stringify(body))
  }
  assert.equal((await server.request('/reviewers', { method: 'POST', etag, body: { objectId: OTHER_ALLOWED_OID },
    headers: { origin: 'https://external.example.test' } })).status, 403)
  assert.equal((await server.request('/reviewers', { method: 'POST', etag, body: { objectId: OTHER_ALLOWED_OID },
    headers: { 'X-Score-Request': '' } })).status, 403)
  assert.equal((await server.request('/reviewers', { identity: { tenantId: OTHER_TENANT_ID } })).status, 403)
  assert.equal((await server.request('/reviewers?tenantId=foreign')).status, 400)
  assert.deepEqual(server.directory._membershipAudits(server.workspace.id), [])
  assert.deepEqual((await access(server)).reviewers, [])
})

test('reviewer endpoints cannot replace existing access or remove the owner recovery membership', async t => {
  const server = await setup(t)
  const { etag } = await access(server)
  assert.equal((await add(server, etag, ALLOWED_OID)).status, 403)
  assert.equal((await server.request(`/reviewers/${ALLOWED_OID}`, { method: 'DELETE', etag })).status, 403)
  for (const role of ['owner', 'editor', 'viewer']) {
    const membership = membershipFor(server.workspace.id, { oid: OTHER_ALLOWED_OID, role })
    server.directory._addMembership(server.workspace.id, membership)
    assert.equal((await add(server, etag)).status, 409)
    assert.equal((await server.request(`/reviewers/${OTHER_ALLOWED_OID}`, { method: 'DELETE', etag })).status, 403)
    assert.deepEqual(await server.directory.getMembership(server.workspace.id, membership.id), membership)
  }
  assert.deepEqual(server.directory._membershipAudits(server.workspace.id), [])
})

test('reviewer membership changes serialize with workspace mutations and fence lifecycle transitions', async t => {
  const server = await setup(t)
  let current = await access(server)
  const lease = await server.state.acquireMutationLease(server.workspace.id)
  try { assert.equal((await add(server, current.etag)).status, 409) } finally { await lease.release() }
  assert.equal((await add(server, current.etag)).status, 201)
  current = await access(server)
  const before = await server.directory.getMetadata(server.workspace.id)
  const operation = { id: randomUUID(), action: 'archive', status: 'running', updatedAt: new Date().toISOString() }
  const transition = await server.directory.replaceMetadata({ ...before.metadata, lifecycleOperation: operation }, before.etag)
  assert.equal((await server.request(`/reviewers/${OTHER_ALLOWED_OID}`, { method: 'DELETE', etag: transition.etag })).status, 409)
  assert.equal((await add(server, transition.etag)).status, 409)
  const archived = await server.directory.replaceMetadata({ ...transition.metadata, archivedAt: operation.updatedAt,
    lifecycleOperation: { ...operation, status: 'complete' } }, transition.etag)
  assert.equal((await server.request(`/reviewers/${OTHER_ALLOWED_OID}`, { method: 'DELETE', etag: current.etag })).status, 409)
  assert.equal((await server.request(`/reviewers/${OTHER_ALLOWED_OID}`, { method: 'DELETE', etag: archived.etag })).status, 200,
    'An owner can revoke access to archived retained content')
  assert.equal(server.directory._membershipAudits(server.workspace.id).length, 2)
})

test('membership and role are rechecked after acquiring the mutation lease and stale directory queries cannot revive access', async t => {
  const server = await setup(t)
  const { etag } = await access(server)
  const ownerId = membershipIdFor(principalKeyFor(TENANT_ID, ALLOWED_OID))
  const acquire = server.state.acquireMutationLease
  server.state.acquireMutationLease = async workspaceId => {
    const lease = await acquire(workspaceId)
    server.directory._removeMembership(workspaceId, ownerId)
    return lease
  }
  assert.equal((await add(server, etag)).status, 404)
  assert.deepEqual(server.directory._membershipAudits(server.workspace.id), [])
  server.directory.listMembershipsForPrincipal = async () => [membershipFor(server.workspace.id, { oid: ALLOWED_OID, role: 'owner' })]
  const response = await fetch(`${server.baseUrl}/api/workspaces`, { headers: authHeaders() })
  assert.deepEqual((await response.json()).workspaces, [])
})

test('owners can revoke previously admitted reviewers without restoring their sign-in admission', async t => {
  const server = await setup(t)
  const { etag } = await access(server)
  const granted = await add(server, etag)
  assert.equal(granted.status, 201)
  const current = await granted.json()
  server.config.allowedUserIds.delete(OTHER_ALLOWED_OID)
  assert.equal((await server.request('/state', { oid: OTHER_ALLOWED_OID })).status, 403)
  const removed = await server.request(`/reviewers/${OTHER_ALLOWED_OID}`, { method: 'DELETE', etag: current.etag })
  assert.equal(removed.status, 200)
  assert.deepEqual((await removed.json()).reviewers, [])
  assert.equal((await add(server, (await access(server)).etag)).status, 400)
  assert.equal(server.config.allowedUserIds.has(OTHER_ALLOWED_OID), false)
})

test('invalid stored role or membership identity never becomes workspace access through administrator status', async t => {
  const server = await setup(t, { config: baseConfig({ adminUserIds: new Set([OTHER_ALLOWED_OID]) }) })
  const member = membershipFor(server.workspace.id, { oid: OTHER_ALLOWED_OID, role: 'reviewer' })
  for (const bad of [
    { ...member, role: 'admin' }, { ...member, role: undefined }, { ...member, principalType: 'group' },
    { ...member, principalId: principalKeyFor(OTHER_TENANT_ID, OTHER_ALLOWED_OID) },
    { ...member, workspaceId: 'foreign-workspace' },
  ]) {
    server.directory._addMembership(server.workspace.id, bad)
    assert.equal((await server.request('/state', { oid: OTHER_ALLOWED_OID })).status, 404)
    assert.equal((await server.request('/state', { method: 'PUT', body: sampleWorkspaceBody(),
      oid: OTHER_ALLOWED_OID, etag: '"any"' })).status, 404)
    const list = await fetch(`${server.baseUrl}/api/workspaces`, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })
    assert.deepEqual((await list.json()).workspaces, [])
  }
})

test('reviewers and member admins cannot perform any ordinary workspace mutation or original download', async t => {
  const jobs = createFakeRealJobs()
  const server = await setup(t, { config: baseConfig({ realJobs: {}, adminUserIds: new Set([OTHER_ALLOWED_OID]) }), jobs })
  server.directory._addMembership(server.workspace.id, membershipFor(server.workspace.id, { oid: OTHER_ALLOWED_OID, role: 'reviewer' }))
  const state = await (await server.request('/state', { oid: OTHER_ALLOWED_OID })).json()
  const mutations = [
    ['', 'PATCH', { name: 'Unauthorized rename' }], ['/state', 'PUT', sampleWorkspaceBody()],
    ['/lifecycle', 'POST', { action: 'archive' }], ['/lifecycle', 'POST', { action: 'delete' }],
    ['/jobs/pdf', 'POST', {}], ['/jobs/markdown', 'POST', {}], ['/jobs/file', 'POST', {}], ['/jobs/url', 'POST', {}],
    ['/jobs/job-one/metadata', 'PATCH', {}], ['/jobs/job-one/rubric', 'PUT', {}],
    ['/jobs/job-one/retry', 'POST', {}], ['/jobs/job-one/cancel', 'POST', {}], ['/jobs/job-one/lifecycle', 'POST', {}],
    ['/resumes/pdf', 'POST', {}], ['/resumes/resume-one/metadata', 'PATCH', {}], ['/resumes/resume-one/retry', 'POST', {}],
    ['/resumes/resume-one/lifecycle', 'POST', {}], ['/grade-ladders', 'POST', {}],
    ['/grade-ladders/ladder-one/grades/12/draft', 'PUT', {}], ['/grade-ladders/ladder-one/lifecycle', 'POST', {}],
    ['/analyses', 'POST', {}], ['/analyses/run-one/retry', 'POST', {}], ['/analyses/run-one/cancel', 'POST', {}],
    ['/analyses/run-one/metadata', 'PATCH', {}], ['/analyses/run-one/lifecycle', 'POST', {}],
    ['/analyses/run-one/summaries', 'POST', {}], ['/analyses/run-one/summaries/candidate/comparison-one/publish', 'POST', {}],
    ['/analyses/run-one/summaries/candidate/comparison-one/retry', 'POST', {}],
    ['/analyses/run-one/comparisons/comparison-one/corrections', 'POST', {}],
    ['/analyses/run-one/comparisons/comparison-one/corrections/cancel', 'POST', {}],
  ]
  for (const [suffix, method, body] of mutations) {
    const response = await server.request(suffix, { method, body, oid: OTHER_ALLOWED_OID, etag: suffix === '/state' ? state.etag : server.workspace.etag })
    assert.equal(response.status, 403, `${method} ${suffix}: ${await response.text()}`)
  }
  const original = await server.request('/jobs/job-one/original', { oid: OTHER_ALLOWED_OID })
  assert.equal(original.status, 403, 'Reviewer read access does not change the original-download allowlist')
  assert.equal((await server.request('/state', { oid: OTHER_ALLOWED_OID })).status, 200)
  assert.equal((await server.state.getState(server.workspace.id)).etag, state.etag)
  assert.deepEqual(server.directory._membershipAudits(server.workspace.id), [])
})
