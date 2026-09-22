import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySampleLifecycle, captureProcessingSettings, createDefaultAdminSettings, WorkspaceAccessService, WorkspaceRepository,
} from '../dist-server/app.mjs'
import {
  ALLOWED_OID as OWNER, OTHER_ALLOWED_OID as PEER, NOT_ALLOWED_OID as OUTSIDER,
  APP_ORIGIN, CSRF_HEADER, OTHER_TENANT_ID, TENANT_ID, StoreConflictError, authHeaders,
  baseConfig, createFakeAccessStore, createFakeDirectoryStore, createFakeEligibleUsers, createFakeStateStore, membershipFor, membershipIdFor,
  principalKeyFor, sampleWorkspaceBody, seedWorkspace, startTestServer,
} from './helpers.mjs'

const ADMIN = '33333333-3333-4333-8333-333333333333'
const READER = '44444444-4444-4444-8444-444444444444'
const NEW_USER = '55555555-5555-4555-8555-555555555555'
const INELIGIBLE = '66666666-6666-4666-8666-666666666666'
const NOW = '2026-09-22T13:00:00.000Z'
const administrator = { oid: ADMIN, roles: ['Score.Admin'] }
const eligibleUsers = () => createFakeEligibleUsers([OWNER, PEER, READER, NEW_USER, ADMIN].map((id, index) => ({
  id, name: `Eligible person ${index}`, email: `person${index}@example.test`,
  applicationRoles: id === ADMIN ? ['Score.Admin'] : ['Score.User'],
})))

async function request(server, path, options = {}) {
  const { oid = OWNER, roles = ['Score.User'], tenantId = TENANT_ID, method = 'GET',
    body, etag, csrf = true, headers = {} } = options
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      ...authHeaders({ oid, roles, tenantId }),
      ...(method !== 'GET' && csrf ? { Origin: APP_ORIGIN, ...CSRF_HEADER } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(etag === undefined ? {} : { 'If-Match': etag }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json(), etag: response.headers.get('etag'), response }
}

async function workspaceFixture(t, options = {}) {
  const server = await startTestServer({
    seedWorkspace: true, eligibleUsers: eligibleUsers(), now: () => new Date(NOW), ...options,
  })
  t.after(() => server.close())
  server.workspace = server.fixtureWorkspace
  server.path = `/api/workspaces/${server.workspace.id}`
  return server
}

const grantPath = oid => `/api/admin/users/${oid}/workspace-creation`
const members = (server, actor = {}) => request(server, `${server.path}/members`, actor)
const changeMember = (server, oid, role, etag, actor = {}) =>
  request(server, `${server.path}/members/${oid}`, {
    ...actor, method: role === undefined ? 'DELETE' : 'PUT',
    ...(role === undefined ? {} : { body: { role } }), etag,
  })

async function share(server, oid, role, actor = {}) {
  const current = await members(server, actor)
  assert.equal(current.status, 200)
  const result = await changeMember(server, oid, role, current.body.etag, actor)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result
}

for (const [label, oid, memberRole, roles, readStatus, writeStatus, manageStatus] of [
  ['Reader', READER, 'viewer', ['Score.User'], 200, 403, 403],
  ['Editor', PEER, 'editor', ['Score.User'], 200, 200, 403],
  ['Owner', OWNER, 'owner', ['Score.User'], 200, 200, 200],
  ['application Admin without membership', ADMIN, undefined, ['Score.Admin'], 200, 200, 200],
  ['application Admin with Reader membership', ADMIN, 'viewer', ['Score.Admin'], 200, 200, 200],
  ['admitted nonmember', OUTSIDER, undefined, ['Score.User'], 404, 404, 404],
]) {
  test(`${label}: effective access is consistent across content, rename, lifecycle, sharing, and administration`, async t => {
    const server = await workspaceFixture(t)
    if (memberRole && oid !== OWNER) await share(server, oid, memberRole)
    const actor = { oid, roles }
    const saved = await request(server, `${server.path}/state`)
    const read = await request(server, `${server.path}/state`, actor)
    assert.equal(read.status, readStatus)
    assert.equal((await request(server, `${server.path}/state`, {
      ...actor, method: 'PUT', etag: saved.body.etag, body: saved.body.workspace,
    })).status, writeStatus)
    assert.equal((await members(server, actor)).status, manageStatus)
    assert.equal((await request(server, `${server.path}/share-candidates?query=person`, actor)).status, manageStatus)
    const metadata = await server.directory.getMetadata(server.workspace.id)
    assert.equal((await request(server, server.path, {
      ...actor, method: 'PATCH', body: { name: `Renamed by ${label}` }, etag: metadata.etag,
    })).status, manageStatus)
    const current = await server.directory.getMetadata(server.workspace.id)
    assert.equal((await request(server, `${server.path}/lifecycle`, {
      ...actor, method: 'POST', body: { action: 'archive' }, etag: current.etag,
    })).status, manageStatus)
    for (const path of ['/api/admin/users?query=person', grantPath(PEER)]) {
      assert.equal((await request(server, path, actor)).status, roles.includes('Score.Admin') ? 200 : 403)
    }
    if (roles.includes('Score.Admin')) {
      const session = await request(server, '/api/session', actor)
      const workspace = session.body.workspaces.find(item => item.id === server.workspace.id)
      assert.equal(workspace.role, 'owner')
      assert.equal(workspace.accessSource, 'application-admin')
      const explicit = await server.directory.getMembership(server.workspace.id, membershipIdFor(principalKeyFor(TENANT_ID, ADMIN)))
      assert.equal(explicit?.role, memberRole)
    }
  })
}

test('Editors retain content archive, restore, and deletion permissions; stored viewer membership remains read-only', async t => {
  const server = await workspaceFixture(t)
  await share(server, PEER, 'editor')
  await share(server, READER, 'viewer')
  const first = await request(server, `${server.path}/state`)
  const target = { kind: 'resume', id: first.body.workspace.resumes[0].id }
  let prepared = first.body.workspace
  for (const run of first.body.workspace.runs) prepared = applySampleLifecycle(prepared, { kind: 'analysis', id: run.id }, 'delete', NOW)
  assert.equal((await request(server, `${server.path}/state`, {
    oid: PEER, method: 'PUT', body: prepared, etag: first.body.etag,
  })).status, 200)
  for (const action of ['archive', 'unarchive', 'delete']) {
    const current = await request(server, `${server.path}/state`)
    const next = applySampleLifecycle(current.body.workspace, target, action, NOW)
    assert.equal((await request(server, `${server.path}/state`, {
      oid: READER, method: 'PUT', body: next, etag: current.body.etag,
    })).status, 403)
    assert.equal((await request(server, `${server.path}/state`, {
      oid: PEER, method: 'PUT', body: next, etag: current.body.etag,
    })).status, 200)
  }
  const after = await request(server, `${server.path}/state`)
  assert.ok(!after.body.workspace.resumes.some(item => item.id === target.id))
})

test('owning a workspace does not grant creation; explicit grant and revocation affect only future creation', async t => {
  const server = await workspaceFixture(t)
  assert.equal((await request(server, '/api/session')).body.capabilities.canCreateWorkspaces, false)
  assert.equal((await request(server, '/api/workspaces', { method: 'POST', body: { name: 'Not granted' } })).status, 403)
  assert.equal(server.directory._workspaceCount(), 1)
  const initial = await request(server, grantPath(OWNER), administrator)
  assert.deepEqual(initial.body, { userId: OWNER, canCreateWorkspaces: false, etag: '"unassigned"' })
  assert.equal(initial.etag, initial.body.etag)
  const granted = await request(server, grantPath(OWNER), {
    ...administrator, method: 'PUT', body: { canCreateWorkspaces: true }, etag: initial.etag,
  })
  assert.equal(granted.status, 200)
  assert.notEqual(granted.etag, initial.etag)
  assert.equal((await request(server, '/api/session')).body.capabilities.canCreateWorkspaces, true)
  const created = await request(server, '/api/workspaces', { method: 'POST', body: { name: 'Granted creation' } })
  assert.equal(created.status, 201)
  const revoked = await request(server, grantPath(OWNER), {
    ...administrator, method: 'PUT', body: { canCreateWorkspaces: false }, etag: granted.etag,
  })
  assert.equal(revoked.status, 200)
  assert.equal((await request(server, '/api/session')).body.capabilities.canCreateWorkspaces, false)
  assert.equal((await request(server, '/api/workspaces', { method: 'POST', body: { name: 'Revoked creation' } })).status, 403)
  assert.equal(server.directory._workspaceCount(), 2)
  for (const id of [server.workspace.id, created.body.workspace.id]) {
    assert.equal((await request(server, `/api/workspaces/${id}/state`)).status, 200)
  }
  const audit = server.accessStore._audits()
  assert.deepEqual(audit.map(item => [item.actorId, item.targetId, item.previous, item.next]),
    [[ADMIN, OWNER, false, true], [ADMIN, OWNER, true, false]])
  assert.ok(audit.every(item => item.tenantId === TENANT_ID && item.createdAt === NOW))
  assert.doesNotMatch(JSON.stringify(audit), /person0@|Test User|token|claims/)
})

test('an Admin can create without a grant or Graph, but global allowCreation stops both Admins and granted users', async t => {
  const settings = createDefaultAdminSettings()
  const server = await workspaceFixture(t, {
    config: baseConfig({ settings: { runtimeEnabled: true } }),
    settings: { async capture() { return captureProcessingSettings(settings, 'access-policy', NOW) } },
    accessStore: createFakeAccessStore([{ userId: OWNER }]),
  })
  server.eligibleUsers._setError(new Error('Graph unavailable'))
  assert.equal((await request(server, '/api/session', administrator)).body.capabilities.canCreateWorkspaces, true)
  assert.equal((await request(server, '/api/workspaces', {
    ...administrator, method: 'POST', body: { name: 'Admin creation' },
  })).status, 201)
  settings.workspaces.allowCreation = false
  for (const actor of [administrator, {}]) {
    assert.equal((await request(server, '/api/workspaces', {
      ...actor, method: 'POST', body: { name: 'Globally blocked' },
    })).status, 403)
  }
  assert.equal(server.directory._workspaceCount(), 2)
  assert.deepEqual(server.eligibleUsers.calls, [])
})

test('creation-grant routes enforce Admin, same-origin CSRF, exact ETags, and strict individual-only requests', async t => {
  const server = await workspaceFixture(t)
  const path = grantPath(PEER)
  assert.equal((await request(server, path)).status, 403)
  assert.equal((await request(server, path, { method: 'PUT', body: { canCreateWorkspaces: true }, etag: '"unassigned"' })).status, 403)
  const put = extra => request(server, path, {
    ...administrator, method: 'PUT', body: { canCreateWorkspaces: true }, etag: '"unassigned"', ...extra,
  })
  assert.equal((await put({ csrf: false })).status, 403)
  assert.equal((await put({ headers: { Origin: 'https://foreign.example' } })).status, 403)
  assert.equal((await put({ etag: undefined })).status, 428)
  assert.equal((await put({ etag: '*' })).status, 400)
  assert.equal((await put({ etag: '"stale"' })).status, 409)
  for (const body of [
    { canCreateWorkspaces: 'true' }, { canCreateWorkspaces: true, tenantId: OTHER_TENANT_ID },
    { canCreateWorkspaces: true, principalType: 'group' }, { canCreateWorkspaces: true, role: 'Score.Admin' },
    { canCreateWorkspaces: true, userId: OWNER }, {},
  ]) assert.equal((await put({ body })).status, 400)
  assert.equal((await request(server, grantPath('not-an-oid'), administrator)).status, 400)
  assert.equal((await request(server, grantPath(INELIGIBLE), {
    ...administrator, method: 'PUT', body: { canCreateWorkspaces: true }, etag: '"unassigned"',
  })).status, 400)
  assert.equal((await put({ tenantId: OTHER_TENANT_ID })).status, 403)
  assert.deepEqual(server.accessStore._audits(), [])
  const winner = await put()
  assert.equal(winner.status, 200)
  assert.equal((await put()).status, 409)
  assert.equal(server.accessStore._audits().length, 1)
})

test('two creation-grant writers using the unassigned revision commit one grant and one audit', async t => {
  const server = await workspaceFixture(t)
  const results = await Promise.all([true, false].map(canCreateWorkspaces =>
    request(server, grantPath(PEER), {
      ...administrator, method: 'PUT', body: { canCreateWorkspaces }, etag: '"unassigned"',
    })))
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409])
  const current = await request(server, grantPath(PEER), administrator)
  assert.equal(current.body.canCreateWorkspaces, results.find(item => item.status === 200).body.canCreateWorkspaces)
  assert.equal(server.accessStore._audits().length, 1)
})

test('creation-store read and transaction failures are explicit errors, never implied grants or successful revocations', async t => {
  const store = createFakeAccessStore([{ userId: OWNER }])
  const server = await workspaceFixture(t, { accessStore: store })
  const initial = await request(server, grantPath(OWNER), administrator)
  store._setReadError(new Error('Grant read failed'))
  for (const path of ['/api/session', '/api/session/identity']) {
    assert.equal((await request(server, path)).status, 503)
  }
  assert.equal((await request(server, grantPath(OWNER), administrator)).status, 503)
  assert.equal((await request(server, '/api/workspaces', { method: 'POST', body: { name: 'No unsafe fallback' } })).status, 503)
  assert.equal((await request(server, `${server.path}/state`)).status, 200)
  store._setReadError(undefined)
  store._setWriteError(new Error('Grant transaction failed'))
  assert.equal((await request(server, grantPath(OWNER), {
    ...administrator, method: 'PUT', body: { canCreateWorkspaces: false }, etag: initial.etag,
  })).status, 503)
  assert.deepEqual((await request(server, grantPath(OWNER), administrator)).body, initial.body)
  assert.deepEqual(store._audits(), [])
  assert.equal(server.directory._workspaceCount(), 1)
})

test('a never-signed-in eligible user receives named Reader access, not an implicit creation grant or personal workspace', async t => {
  const server = await workspaceFixture(t)
  const initialState = await server.state.getState(server.workspace.id)
  const added = await share(server, NEW_USER, 'viewer')
  assert.equal(added.etag, added.body.etag)
  assert.deepEqual(added.body.members.find(item => item.id === NEW_USER), {
    id: NEW_USER, role: 'viewer', name: 'Eligible person 3', email: 'person3@example.test',
  })
  const firstSession = await request(server, '/api/session', { oid: NEW_USER })
  assert.equal(firstSession.status, 200)
  assert.deepEqual(firstSession.body.workspaces.map(item => [item.id, item.role, item.accessSource]),
    [[server.workspace.id, 'viewer', 'membership']])
  assert.equal(firstSession.body.capabilities.canCreateWorkspaces, false)
  assert.equal(server.directory._workspaceCount(), 1)
  assert.equal((await changeMember(server, NEW_USER, undefined, added.etag)).status, 200)
  assert.deepEqual((await request(server, '/api/session', { oid: NEW_USER })).body.workspaces, [])
  assert.equal((await request(server, `${server.path}/state`, { oid: NEW_USER })).status, 404)
  assert.deepEqual(await server.state.getState(server.workspace.id), initialState)
  const audits = server.directory._audits(server.workspace.id)
  assert.deepEqual(audits.map(item => [item.actorId, item.targetId, item.previous, item.next]),
    [[OWNER, NEW_USER, null, 'viewer'], [OWNER, NEW_USER, 'viewer', null]])
  assert.doesNotMatch(JSON.stringify(audits), /person3@|Eligible person|token|claims/)
})

test('legacy viewer membership without display fields is preserved and does not imply creation access', async t => {
  const server = await workspaceFixture(t)
  server.directory._addMembership(server.workspace.id, membershipFor(server.workspace.id, { oid: READER, role: 'viewer' }))
  const listing = await members(server)
  assert.deepEqual(listing.body.members.find(item => item.id === READER), { id: READER, name: READER, email: '', role: 'viewer' })
  const session = await request(server, '/api/session', { oid: READER })
  assert.equal(session.body.workspaces[0].role, 'viewer')
  assert.equal(session.body.capabilities.canCreateWorkspaces, false)
  assert.equal((await request(server, `${server.path}/state`, { oid: READER })).status, 200)
})

test('legacy metadata without ownerCount derives the last-owner guard and initializes its count atomically on change', async t => {
  const server = await workspaceFixture(t)
  const saved = await server.directory.getMetadata(server.workspace.id)
  const legacy = { ...saved.metadata }
  delete legacy.ownerCount
  const before = await server.directory.replaceMetadata(legacy, saved.etag)
  assert.equal((await changeMember(server, OWNER, 'viewer', before.etag, administrator)).status, 409)
  assert.equal((await server.directory.getMetadata(server.workspace.id)).metadata.ownerCount, undefined)
  const added = await changeMember(server, PEER, 'owner', before.etag)
  assert.equal(added.status, 200)
  assert.equal((await server.directory.getMetadata(server.workspace.id)).metadata.ownerCount, 2)
  assert.equal((await changeMember(server, OWNER, undefined, added.etag, { oid: PEER })).status, 200)
  assert.equal((await server.directory.getMetadata(server.workspace.id)).metadata.ownerCount, 1)
})

test('fixture owner injection and demotion preserve counts and metadata revisions consumed by real sharing mutations', async t => {
  const server = await workspaceFixture(t)
  const initial = await server.directory.getMetadata(server.workspace.id)
  server.directory._addMembership(server.workspace.id, membershipFor(server.workspace.id, { oid: PEER, role: 'owner' }))
  const coOwned = await server.directory.getMetadata(server.workspace.id)
  assert.equal(coOwned.metadata.ownerCount, 2)
  assert.notEqual(coOwned.etag, initial.etag)
  server.directory._addMembership(server.workspace.id, membershipFor(server.workspace.id, { oid: PEER, role: 'owner' }))
  assert.equal((await server.directory.getMetadata(server.workspace.id)).metadata.ownerCount, 2)
  server.directory._addMembership(server.workspace.id, membershipFor(server.workspace.id, { oid: PEER, role: 'viewer' }))
  const demoted = await server.directory.getMetadata(server.workspace.id)
  assert.equal(demoted.metadata.ownerCount, 1)
  assert.notEqual(demoted.etag, coOwned.etag)
  const promoted = await changeMember(server, PEER, 'owner', demoted.etag)
  assert.equal(promoted.status, 200)
  assert.equal((await server.directory.getMetadata(server.workspace.id)).metadata.ownerCount, 2)
})

test('corrupt persisted owner counts fail closed without changing access or recording a successful audit', async t => {
  const server = await workspaceFixture(t)
  const initial = await server.directory.getMetadata(server.workspace.id)
  const corrupted = await server.directory.replaceMetadata({ ...initial.metadata, ownerCount: 2 }, initial.etag)
  assert.equal((await changeMember(server, NEW_USER, 'viewer', corrupted.etag)).status, 503)
  assert.deepEqual(await server.directory.getMetadata(server.workspace.id), corrupted)
  assert.deepEqual(server.directory._audits(server.workspace.id), [])
  assert.equal((await server.directory.listWorkspaceMemberships(server.workspace.id)).length, 1)
})

test('removing an Admin explicit Reader membership cannot revoke implicit application administration', async t => {
  const server = await workspaceFixture(t)
  const member = await share(server, ADMIN, 'viewer')
  assert.equal((await changeMember(server, ADMIN, undefined, member.etag)).status, 200)
  assert.equal((await members(server, administrator)).status, 200)
  assert.equal((await request(server, `${server.path}/state`, administrator)).status, 200)
  assert.equal((await request(server, grantPath(OWNER), administrator)).status, 200)
  const session = await request(server, '/api/session', administrator)
  assert.equal(session.body.workspaces[0].role, 'owner')
  assert.equal(session.body.workspaces[0].accessSource, 'application-admin')
  assert.equal((await server.directory.listMembershipsForPrincipal(principalKeyFor(TENANT_ID, ADMIN))).length, 0)
})

for (const role of [undefined, 'editor']) {
  test(`a peer owner can ${role ? 'demote' : 'remove'} the creator; creator provenance grants no permanent privilege`, async t => {
    const server = await workspaceFixture(t)
    const coOwned = await share(server, PEER, 'owner')
    const changed = await changeMember(server, OWNER, role, coOwned.etag, { oid: PEER })
    assert.equal(changed.status, 200)
    const saved = await server.directory.getMetadata(server.workspace.id)
    assert.equal(saved.metadata.ownerId, principalKeyFor(TENANT_ID, OWNER))
    assert.equal(saved.metadata.ownerCount, 1)
    assert.equal((await request(server, server.path, {
      method: 'PATCH', body: { name: 'Creator cannot override peers' }, etag: saved.etag,
    })).status, role ? 403 : 404)
    assert.equal((await request(server, `${server.path}/lifecycle`, {
      method: 'POST', body: { action: 'archive' }, etag: saved.etag,
    })).status, role ? 403 : 404)
    assert.equal((await members(server)).status, role ? 403 : 404)
    assert.equal((await members(server, { oid: PEER })).status, 200)
  })
}

test('implicit Admin access does not count toward the last explicit owner invariant', async t => {
  const server = await workspaceFixture(t)
  const before = await members(server)
  for (const actor of [{}, administrator]) {
    for (const role of [undefined, 'editor', 'viewer']) {
      assert.equal((await changeMember(server, OWNER, role, before.etag, actor)).status, 409)
    }
  }
  assert.deepEqual((await members(server)).body, before.body)
  assert.equal((await server.directory.getMetadata(server.workspace.id)).metadata.ownerCount, 1)
  assert.deepEqual(server.directory._audits(server.workspace.id), [])
})

test('metadata CAS independently prevents two co-owners from racing to remove the last explicit owner', async t => {
  const server = await workspaceFixture(t)
  const coOwned = await share(server, PEER, 'owner')
  // Both contenders reach the storage transaction, so the assertion tests CAS rather than only the lease fake.
  server.state.acquireMutationLease = async () => ({ async renew() {}, async release() {} })
  const change = server.directory.changeMembership
  let reached = 0, release
  const gate = new Promise(resolve => { release = resolve })
  server.directory.changeMembership = async value => {
    if (++reached === 2) release()
    await gate
    return change(value)
  }
  const results = await Promise.all([
    changeMember(server, OWNER, undefined, coOwned.etag),
    changeMember(server, PEER, undefined, coOwned.etag, { oid: PEER }),
  ])
  assert.equal(reached, 2)
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  const current = await members(server, administrator)
  assert.equal(current.body.members.filter(member => member.role === 'owner').length, 1)
  assert.equal((await server.directory.getMetadata(server.workspace.id)).metadata.ownerCount, 1)
  assert.equal(server.directory._audits(server.workspace.id).length, 2)
})

test('member authority is checked again after acquiring the workspace mutation lease', async t => {
  const server = await workspaceFixture(t)
  const coOwned = await share(server, PEER, 'owner')
  const acquire = server.state.acquireMutationLease
  server.state.acquireMutationLease = async id => {
    server.directory._addMembership(id, membershipFor(id, { oid: OWNER, role: 'viewer' }))
    return acquire(id)
  }
  assert.equal((await changeMember(server, NEW_USER, 'viewer', coOwned.etag)).status, 403)
  assert.equal(server.directory._audits(server.workspace.id).length, 1)
  assert.equal(await server.directory.getMembership(server.workspace.id, membershipIdFor(principalKeyFor(TENANT_ID, NEW_USER))), undefined)
})

test('lease loss during slow Entra revalidation prevents the membership transaction itself, not just its acknowledgment', async t => {
  const directory = createFakeDirectoryStore(), state = createFakeStateStore(), users = eligibleUsers()
  const workspace = await seedWorkspace({ directory, state })
  const repository = new WorkspaceRepository({ directory, state })
  const service = new WorkspaceAccessService(repository, directory, users)
  const principal = {
    tenantId: TENANT_ID, oid: OWNER, principalKey: principalKeyFor(TENANT_ID, OWNER),
    name: 'Fixture owner', email: 'owner@example.test', applicationRoles: ['Score.User'],
  }
  let renewInterval
  const schedule = globalThis.setInterval
  t.mock.method(globalThis, 'setInterval', (callback, delay, ...args) => {
    renewInterval = callback
    return schedule(callback, delay, ...args)
  })
  const acquire = state.acquireMutationLease
  state.acquireMutationLease = async id => ({
    ...await acquire(id), async renew() { throw new StoreConflictError('Lease lost during directory lookup') },
  })
  const get = users.get
  users.get = async id => {
    assert.equal(id, NEW_USER)
    assert.equal(typeof renewInterval, 'function')
    renewInterval()
    await new Promise(resolve => setImmediate(resolve))
    return get(id)
  }
  const before = await directory.getMetadata(workspace.id)
  await assert.rejects(service.change(principal, workspace.id, NEW_USER, 'viewer', workspace.etag),
    error => error.status === 409)
  assert.deepEqual(await directory.getMetadata(workspace.id), before)
  assert.deepEqual(directory._audits(workspace.id), [])
  assert.equal(await directory.getMembership(workspace.id, membershipIdFor(principalKeyFor(TENANT_ID, NEW_USER))), undefined)
  const released = await acquire(workspace.id)
  await released.release()
})

test('membership requests enforce CSRF, collection revision, individual eligibility, and strict role/tenant fields', async t => {
  const server = await workspaceFixture(t)
  const current = await members(server)
  const path = `${server.path}/members/${PEER}`
  const put = extra => request(server, path, { method: 'PUT', body: { role: 'viewer' }, etag: current.etag, ...extra })
  assert.equal((await put({ csrf: false })).status, 403)
  assert.equal((await put({ headers: { Origin: 'https://foreign.example' } })).status, 403)
  assert.equal((await put({ etag: undefined })).status, 428)
  assert.equal((await put({ etag: '*' })).status, 400)
  assert.equal((await put({ etag: '"stale"' })).status, 409)
  for (const body of [
    { role: 'reader' }, { role: 'admin' }, { role: 'Owner' }, { role: true }, {},
    { role: 'viewer', tenantId: OTHER_TENANT_ID }, { role: 'viewer', principalType: 'group' },
    { role: 'viewer', ownerId: PEER }, { role: 'viewer', email: 'claimed@example.test' },
  ]) assert.equal((await put({ body })).status, 400)
  assert.equal((await changeMember(server, 'a-group-name', 'viewer', current.etag)).status, 400)
  assert.equal((await changeMember(server, INELIGIBLE, 'viewer', current.etag)).status, 400)
  assert.equal((await put({ tenantId: OTHER_TENANT_ID })).status, 403)
  assert.equal((await put({ oid: OUTSIDER })).status, 404)
  assert.equal((await changeMember(server, PEER, undefined, current.etag)).status, 404)
  assert.deepEqual((await members(server)).body, current.body)
  const added = await put()
  assert.equal(added.status, 200)
  assert.equal((await put({ body: { role: 'editor' } })).status, 409)
  assert.equal((await request(server, path, { method: 'DELETE', etag: added.etag, csrf: false })).status, 403)
  assert.equal(server.directory._audits(server.workspace.id).length, 1)
})

test('member transaction errors leave membership, owner count, collection revision, and audit unchanged', async t => {
  const server = await workspaceFixture(t)
  const current = await share(server, PEER, 'viewer')
  const metadata = await server.directory.getMetadata(server.workspace.id)
  const audits = server.directory._audits(server.workspace.id)
  for (const [error, status] of [[new StoreConflictError('Member changed'), 409], [new Error('Cosmos transaction failed'), 503]]) {
    server.directory._setTransactionError(error)
    assert.equal((await changeMember(server, PEER, 'owner', current.etag)).status, status)
    assert.deepEqual((await members(server)).body, current.body)
    assert.deepEqual(await server.directory.getMetadata(server.workspace.id), metadata)
    assert.deepEqual(server.directory._audits(server.workspace.id), audits)
  }
})

test('membership transaction also conditions the target member ETag, not just the collection metadata', async t => {
  const server = await workspaceFixture(t)
  const current = await share(server, PEER, 'viewer')
  const metadata = await server.directory.getMetadata(server.workspace.id)
  const change = server.directory.changeMembership
  server.directory.changeMembership = async value => {
    server.directory._addMembership(server.workspace.id, membershipFor(server.workspace.id, { oid: PEER, role: 'editor' }))
    return change(value)
  }
  assert.equal((await changeMember(server, PEER, 'owner', current.etag)).status, 409)
  assert.deepEqual(await server.directory.getMetadata(server.workspace.id), metadata)
  assert.equal(server.directory._audits(server.workspace.id).length, 1)
  assert.equal((await members(server)).body.members.find(member => member.id === PEER).role, 'editor')
})

test('Graph failures block new grants and promotions but never existing reads, permitted creation, demotion, or revocation', async t => {
  const server = await workspaceFixture(t, { accessStore: createFakeAccessStore([{ userId: PEER }]) })
  const member = await share(server, PEER, 'editor')
  const grant = await request(server, grantPath(PEER), administrator)
  server.eligibleUsers._setError(new Error('Graph is unavailable'))
  assert.equal((await request(server, `${server.path}/state`, { oid: PEER })).status, 200)
  assert.equal((await request(server, '/api/workspaces', { oid: PEER, method: 'POST', body: { name: 'Already granted' } })).status, 201)
  assert.equal((await changeMember(server, NEW_USER, 'viewer', member.etag)).status, 503)
  assert.equal((await changeMember(server, PEER, 'owner', member.etag)).status, 503)
  assert.equal((await request(server, grantPath(NEW_USER), {
    ...administrator, method: 'PUT', body: { canCreateWorkspaces: true }, etag: '"unassigned"',
  })).status, 503)
  const calls = server.eligibleUsers.calls.length
  const demoted = await changeMember(server, PEER, 'viewer', member.etag)
  assert.equal(demoted.status, 200)
  assert.equal((await changeMember(server, PEER, undefined, demoted.etag)).status, 200)
  assert.equal((await request(server, grantPath(PEER), {
    ...administrator, method: 'PUT', body: { canCreateWorkspaces: false }, etag: grant.etag,
  })).status, 200)
  assert.equal(server.eligibleUsers.calls.length, calls)
  assert.equal((await request(server, '/api/admin/users', administrator)).status, 503)
  assert.equal((await request(server, `${server.path}/share-candidates`)).status, 503)
  assert.equal((await request(server, `${server.path}/state`, { oid: PEER })).status, 404)
})

test('promotion revalidates Entra eligibility while downgrade of a departed eligible user remains possible', async t => {
  const server = await workspaceFixture(t)
  const initial = await share(server, PEER, 'editor')
  server.eligibleUsers._remove(PEER)
  assert.equal((await changeMember(server, PEER, 'owner', initial.etag)).status, 400)
  const downgraded = await changeMember(server, PEER, 'viewer', initial.etag)
  assert.equal(downgraded.status, 200)
  assert.equal((await changeMember(server, PEER, 'editor', downgraded.etag)).status, 400)
  assert.equal((await changeMember(server, PEER, undefined, downgraded.etag)).status, 200)
})

test('directory lookup pagination is forwarded only after Owner or application-Admin authorization', async t => {
  const server = await workspaceFixture(t)
  await share(server, READER, 'viewer')
  const calls = []
  const user = await server.eligibleUsers.get(NEW_USER)
  server.eligibleUsers.search = async (query, continuation) => {
    calls.push([query, continuation])
    return { users: [user], continuation: 'next-page' }
  }
  for (const [path, actor] of [
    ['/api/admin/users?query=person&continuation=page-two', administrator],
    [`${server.path}/share-candidates?query=person&continuation=page-two`, {}],
  ]) {
    const response = await request(server, path, actor)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { users: [user], continuation: 'next-page' })
  }
  assert.deepEqual(calls, [['person', 'page-two'], ['person', 'page-two']])
  assert.equal((await request(server, '/api/admin/users')).status, 403)
  assert.equal((await request(server, `${server.path}/share-candidates`, { oid: READER })).status, 403)
  assert.equal(calls.length, 2)
})

test('access management remains available when archived and freezes during unfinished lifecycle work', async t => {
  const server = await workspaceFixture(t)
  const member = await share(server, PEER, 'viewer')
  const archived = await request(server, `${server.path}/lifecycle`, { method: 'POST', body: { action: 'archive' }, etag: member.etag })
  assert.equal(archived.status, 200)
  assert.equal((await members(server)).status, 200)
  const removed = await changeMember(server, PEER, undefined, archived.body.workspace.etag)
  assert.equal(removed.status, 200)
  const stored = await server.directory.getMetadata(server.workspace.id)
  const pending = await server.directory.replaceMetadata({
    ...stored.metadata, lifecycleOperation: { id: 'unfinished-delete', action: 'delete', status: 'failed', updatedAt: NOW },
  }, stored.etag)
  for (const actor of [{}, administrator]) {
    assert.equal((await changeMember(server, NEW_USER, 'viewer', pending.etag, actor)).status, 409)
  }
  assert.equal((await server.directory.getMetadata(server.workspace.id)).etag, pending.etag)
})

test('application Admin listing is tenant-scoped, includes archives and recovery, excludes completed deletions, and never synthesizes members', async t => {
  const server = await workspaceFixture(t)
  await share(server, ADMIN, 'viewer')
  const archived = await seedWorkspace(server, { oid: PEER, name: 'Archived fixture' })
  const recoverable = await seedWorkspace(server, { oid: PEER, name: 'Recoverable fixture' })
  const deleted = await seedWorkspace(server, { oid: PEER, name: 'Deleted fixture' })
  const foreign = await seedWorkspace(server, { tenantId: OTHER_TENANT_ID, name: 'Foreign tenant fixture' })
  for (const [workspace, fields] of [
    [archived, { archivedAt: NOW }],
    [recoverable, { lifecycleOperation: { id: 'pending', action: 'delete', status: 'failed', updatedAt: NOW } }],
    [deleted, { deletedAt: NOW, lifecycleOperation: { id: 'complete', action: 'delete', status: 'complete', updatedAt: NOW } }],
  ]) {
    const stored = await server.directory.getMetadata(workspace.id)
    await server.directory.replaceMetadata({ ...stored.metadata, ...fields }, stored.etag)
  }
  for (const path of ['/api/session', '/api/workspaces']) {
    const result = await request(server, path, administrator)
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.workspaces.map(item => item.id).sort(), [server.workspace.id, archived.id, recoverable.id].sort())
    assert.ok(result.body.workspaces.every(item => item.role === 'owner' && item.accessSource === 'application-admin'))
  }
  assert.equal((await request(server, `/api/workspaces/${foreign.id}/state`, administrator)).status, 404)
  assert.equal((await request(server, `/api/workspaces/${foreign.id}/members`, administrator)).status, 404)
  assert.equal((await request(server, `/api/workspaces/${deleted.id}/state`, administrator)).status, 404)
  assert.deepEqual((await request(server, '/api/session')).body.workspaces.map(item => item.id), [server.workspace.id])
  const explicit = await server.directory.listMembershipsForPrincipal(principalKeyFor(TENANT_ID, ADMIN))
  assert.equal(explicit.length, 1)
  assert.equal(explicit[0].role, 'viewer')
})

test('deletion recovery follows the current peer owner after creator removal and can be completed by an Admin without membership', async t => {
  const server = await workspaceFixture(t)
  const coOwned = await share(server, PEER, 'owner')
  const removed = await changeMember(server, OWNER, undefined, coOwned.etag, { oid: PEER })
  assert.equal(removed.status, 200)
  server.state._setRawContent(server.workspace.id, JSON.stringify(sampleWorkspaceBody()))
  const replace = server.directory.replaceMetadata
  let fail = true
  server.directory.replaceMetadata = async (metadata, etag) => {
    if (metadata.deletedAt && fail) { fail = false; throw new Error('Final tombstone publication failed') }
    return replace(metadata, etag)
  }
  const incomplete = await request(server, `${server.path}/lifecycle`, {
    oid: PEER, method: 'POST', body: { action: 'delete' }, etag: removed.etag,
  })
  assert.equal(incomplete.status, 202)
  assert.equal(incomplete.body.operation.status, 'failed')
  assert.equal(await server.state.getState(server.workspace.id), undefined)
  const stored = await server.directory.getMetadata(server.workspace.id)
  assert.equal(stored.metadata.ownerId, principalKeyFor(TENANT_ID, OWNER))
  assert.equal(stored.metadata.deletionRecoveryPrincipalId, principalKeyFor(TENANT_ID, PEER))
  assert.deepEqual((await server.directory.listWorkspaceMemberships(server.workspace.id)).map(item => item.membership.principalId),
    [principalKeyFor(TENANT_ID, PEER)])
  assert.deepEqual((await request(server, '/api/session')).body.workspaces, [])
  assert.equal((await request(server, `${server.path}/lifecycle`)).status, 404)
  assert.equal((await request(server, `${server.path}/lifecycle`, administrator)).status, 200)
  assert.equal((await request(server, '/api/session', { oid: PEER })).body.workspaces[0].lifecycleOperation.status, 'failed')
  assert.equal((await changeMember(server, NEW_USER, 'viewer', stored.etag, administrator)).status, 409)
  const completed = await request(server, `${server.path}/lifecycle`, {
    ...administrator, method: 'POST', body: { action: 'delete' }, etag: stored.etag,
  })
  assert.equal(completed.status, 200)
  assert.equal(completed.body.deleted, true)
  assert.deepEqual(await server.directory.listWorkspaceMemberships(server.workspace.id), [])
  assert.equal((await server.directory.getMetadata(server.workspace.id)).metadata.deletionRecoveryPrincipalId, principalKeyFor(TENANT_ID, PEER))
  assert.deepEqual((await request(server, '/api/session', administrator)).body.workspaces, [])
})
