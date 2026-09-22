import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { SCORE_ROLES, SCORE_ADMIN_ROLE_ID, SCORE_USER_ROLE_ID } from '../scripts/azure-access.mjs'

const bundle = await build({
  entryPoints: ['server/access/entra-directory.ts'], bundle: true, packages: 'external',
  platform: 'node', format: 'esm', target: 'node24', write: false,
})
const { createEntraDirectory, EntraDirectoryError } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const appId = id(1)
const root = 'https://graph.microsoft.com/v1.0'
const config = { container: 'application-access', servicePrincipalId: appId }
const assignment = (principalId, roleId = SCORE_USER_ROLE_ID, principalType = 'User', resourceId = appId) => ({
  principalId, principalType, resourceId, appRoleId: roleId,
})
const user = (userId, name, email = `${name.toLowerCase()}@example.test`) => ({
  id: userId, displayName: name, mail: email, userPrincipalName: email,
})
const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers })

function fixture({ assignments = [], groups = new Map(), users = new Map(), override, options = {} } = {}) {
  const requests = []
  const tokenScopes = []
  const credential = {
    async getToken(scope) { tokenScopes.push(scope); return { token: 'test-directory-token', expiresOnTimestamp: Date.now() + 60_000 } },
  }
  const directory = createEntraDirectory(config, credential, {
    ...options,
    fetch: async (input, init) => {
      const url = new URL(input)
      requests.push(url)
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers.Authorization, 'Bearer test-directory-token')
      const custom = await override?.(url, requests)
      if (custom) return custom
      if (url.pathname === `/v1.0/servicePrincipals/${appId}`) {
        return json({ id: appId, appRoleAssignmentRequired: true, appRoles: SCORE_ROLES })
      }
      if (url.pathname === `/v1.0/servicePrincipals/${appId}/appRoleAssignedTo`) return json({ value: assignments })
      const groupMatch = url.pathname.match(/^\/v1\.0\/groups\/([^/]+)\/members$/)
      if (groupMatch) return groups.has(groupMatch[1]) ? json({ value: groups.get(groupMatch[1]) }) : json({}, 404)
      const userMatch = url.pathname.match(/^\/v1\.0\/users\/([^/]+)$/)
      if (userMatch) return users.has(userMatch[1]) ? json(users.get(userMatch[1])) : json({}, 404)
      throw new Error(`Unexpected directory request ${url.pathname}`)
    },
  })
  return { directory, requests, tokenScopes, assignments, groups, users }
}

test('eligibility merges direct users and direct group users before first login, with Admin precedence', async () => {
  const a = id(10), b = id(11), c = id(12), g = id(20), nested = id(21), service = id(30)
  const f = fixture({
    assignments: [
      assignment(a), assignment(a), assignment(a, SCORE_ADMIN_ROLE_ID),
      assignment(g, SCORE_USER_ROLE_ID, 'Group'), assignment(g, SCORE_ADMIN_ROLE_ID, 'Group'),
      assignment(service, SCORE_USER_ROLE_ID, 'ServicePrincipal'),
      assignment(c, id(999)), assignment(c, SCORE_ADMIN_ROLE_ID, 'User', id(99)),
    ],
    groups: new Map([[g, [
      { id: a, '@odata.type': '#microsoft.graph.user' }, { id: b, '@odata.type': '#microsoft.graph.user' },
      { id: nested, '@odata.type': '#microsoft.graph.group' }, { id: service, '@odata.type': '#microsoft.graph.servicePrincipal' },
    ]]]),
    users: new Map([[a, user(a, 'Alice')], [b, user(b, 'Before first login')], [c, user(c, 'Not eligible')]]),
  })
  assert.deepEqual(await f.directory.search(''), { users: [
    { id: a, name: 'Alice', email: 'alice@example.test', applicationRoles: ['Score.Admin', 'Score.User'] },
    { id: b, name: 'Before first login', email: 'before first login@example.test', applicationRoles: ['Score.Admin', 'Score.User'] },
  ] })
  assert.ok(f.requests.every(url => !url.pathname.includes(nested) && !url.pathname.includes(service) && !url.pathname.includes('/users/' + c)))
  assert.ok(f.tokenScopes.every(scope => scope === 'https://graph.microsoft.com/.default'))
  assert.equal(f.requests.filter(url => url.pathname.includes(`/groups/${g}`)).length, 1)
})

test('all Graph assignment/group pages and application result pages are consumed without truncation', async () => {
  const g = id(20)
  const people = Array.from({ length: 113 }, (_, index) => user(id(100 + index), `Person ${String(index).padStart(3, '0')}`))
  const f = fixture({
    users: new Map(people.map(person => [person.id, person])),
    options: { pageSize: 17 },
    override: url => {
      if (url.pathname.endsWith('/appRoleAssignedTo')) {
        return url.searchParams.has('$skiptoken') ? json({ value: [assignment(g, SCORE_ADMIN_ROLE_ID, 'Group')] }) :
          json({ value: people.slice(0, 50).map(person => assignment(person.id)),
            '@odata.nextLink': `${root}/servicePrincipals/${appId}/appRoleAssignedTo?$skiptoken=next` })
      }
      if (url.pathname.endsWith(`/groups/${g}/members`)) {
        const value = (url.searchParams.has('$skiptoken') ? people.slice(80) : people.slice(50, 80))
          .map(person => ({ id: person.id, '@odata.type': '#microsoft.graph.user' }))
        return json({ value, ...(!url.searchParams.has('$skiptoken') ? {
          '@odata.nextLink': `${root}/groups/${g}/members?$skiptoken=members`,
        } : {}) })
      }
    },
  })
  const seen = []
  let continuation
  do {
    const page = await f.directory.search('person', continuation)
    seen.push(...page.users.map(person => person.id))
    continuation = page.continuation
    if (continuation) assert.match(continuation, /^[A-Za-z0-9_-]{32}$/)
  } while (continuation)
  assert.deepEqual(seen, people.map(person => person.id))
  assert.equal(new Set(seen).size, 113)
  assert.equal(f.requests.filter(url => url.pathname.endsWith('/appRoleAssignedTo')).length, 2)
})

test('search scopes names/email to eligible profiles and does not browse tenant users or serialize Graph links', async () => {
  const a = id(10), b = id(11)
  const f = fixture({
    assignments: [assignment(a), assignment(b, SCORE_ADMIN_ROLE_ID)],
    users: new Map([[a, user(a, 'Alice', 'chosen@example.test')],
      [b, { ...user(b, 'Bob'), mail: null, userPrincipalName: 'guest@tenant.test' }]]),
    options: { pageSize: 1 },
  })
  assert.deepEqual((await f.directory.search(' CHOSEN@ ')).users.map(person => person.id), [a])
  assert.deepEqual((await f.directory.search('guest@')).users.map(person => person.id), [b])
  assert.equal((await f.directory.search("x' or true")).users.length, 0)
  assert.ok(f.requests.every(url => url.pathname !== '/v1.0/users' && !url.searchParams.has('$search')))
  for (const url of f.requests.filter(url => url.pathname.includes('/users/'))) {
    assert.equal(url.searchParams.get('$select'), 'id,displayName,mail,userPrincipalName')
  }
  const page = await f.directory.search('')
  assert.doesNotMatch(JSON.stringify(page), /graph.microsoft|test-directory-token/)
})

test('grant-time lookup never trusts cached search results and excludes deleted users', async () => {
  const a = id(10), b = id(11)
  const f = fixture({ assignments: [assignment(a), assignment(b)], users: new Map([[a, user(a, 'Alice')]]) })
  assert.equal((await f.directory.search('')).users.length, 1)
  assert.equal(await f.directory.get(b), undefined)
  assert.equal((await f.directory.get(a)).id, a)
  f.assignments.splice(0)
  assert.equal(await f.directory.get(a), undefined)
  await assert.rejects(() => f.directory.get('someone@example.test'), error => error.status === 400)
})

test('opaque continuations expire, remain query-bound and can be retried', async () => {
  let clock = 10_000
  const people = [user(id(10), 'Alice'), user(id(11), 'Bob'), user(id(12), 'Carol')]
  const f = fixture({
    assignments: people.map(person => assignment(person.id)), users: new Map(people.map(person => [person.id, person])),
    options: { pageSize: 1, now: () => clock, continuationTtlMs: 100 },
  })
  const first = await f.directory.search('')
  const second = await f.directory.search('', first.continuation)
  assert.equal(second.users[0].name, 'Bob')
  assert.equal((await f.directory.search('', first.continuation)).users[0].name, 'Bob')
  await assert.rejects(() => f.directory.search('changed', first.continuation), error => error.status === 400)
  await assert.rejects(() => f.directory.search('', 'https://graph.microsoft.com/next'), error => error.status === 400)
  clock += 101
  await assert.rejects(() => f.directory.search('', second.continuation), /expired/)
})

test('cross-origin, credentialed, changed-resource and repeated nextLinks fail before token forwarding', async () => {
  for (const nextLink of [
    'https://attacker.test/v1.0/users', 'http://graph.microsoft.com/v1.0/users',
    `https://user:password@graph.microsoft.com/v1.0/servicePrincipals/${appId}/appRoleAssignedTo`,
    `${root}/users`, `${root}/servicePrincipals/${appId}/appRoleAssignedTo#fragment`,
    'not a URL',
  ]) {
    const f = fixture({ override: url => url.pathname.endsWith('/appRoleAssignedTo') ? json({ value: [], '@odata.nextLink': nextLink }) : undefined })
    await assert.rejects(() => f.directory.search(''), EntraDirectoryError)
    assert.equal(f.requests.length, 2)
  }
  const loop = `${root}/servicePrincipals/${appId}/appRoleAssignedTo?$skiptoken=loop`
  const f = fixture({ override: url => url.pathname.endsWith('/appRoleAssignedTo') ? json({ value: [], '@odata.nextLink': loop }) : undefined })
  await assert.rejects(() => f.directory.search(''), /repeated/)
})

test('missing consent, hidden groups and partial Graph failures are explicit errors, never empty success', async () => {
  const a = id(10), g = id(20)
  for (const status of [403, 401, 404, 500]) {
    const f = fixture({
      assignments: [assignment(a), assignment(g, SCORE_USER_ROLE_ID, 'Group')], users: new Map([[a, user(a, 'Alice')]]),
      override: url => url.pathname.includes(`/groups/${g}`) ? json({ error: { message: 'private-detail' } }, status) : undefined,
    })
    await assert.rejects(() => f.directory.search(''), error => {
      assert.ok(error instanceof EntraDirectoryError)
      assert.equal(error.status, 503)
      assert.doesNotMatch(error.message, /private-detail/)
      if (status === 403) assert.match(error.message, /Member.Read.Hidden/)
      return true
    })
  }
})

test('throttling honors bounded Retry-After then reports throttling instead of partial eligibility', async () => {
  const sleeps = []
  let calls = 0
  const retry = fixture({
    options: { sleep: async milliseconds => sleeps.push(milliseconds) },
    override: url => url.pathname.endsWith('/appRoleAssignedTo') && calls++ === 0 ? json({}, 429, { 'Retry-After': '1' }) : undefined,
  })
  assert.deepEqual(await retry.directory.search(''), { users: [] })
  assert.deepEqual(sleeps, [1000])
  for (const retryAfter of ['0', '120']) {
    const f = fixture({
      options: { sleep: async () => undefined },
      override: url => url.pathname.endsWith('/appRoleAssignedTo') ? json({}, 429, { 'Retry-After': retryAfter }) : undefined,
    })
    await assert.rejects(() => f.directory.search(''), error =>
      error.reason === 'throttled' && error.retryAfterSeconds === Number(retryAfter))
    assert.equal(f.requests.filter(url => url.pathname.endsWith('/appRoleAssignedTo')).length, retryAfter === '0' ? 3 : 1)
  }
})

test('unsafe role configuration and malformed pages fail closed', async () => {
  for (const replacement of [
    { id: appId, appRoles: SCORE_ROLES, appRoleAssignmentRequired: false },
    { id: appId, appRoles: [SCORE_ROLES[0]], appRoleAssignmentRequired: true },
    { id: appId, appRoles: SCORE_ROLES.map(role => ({ ...role, allowedMemberTypes: ['Application', 'User'] })), appRoleAssignmentRequired: true },
  ]) {
    const f = fixture({ override: url => url.pathname === `/v1.0/servicePrincipals/${appId}` ? json(replacement) : undefined })
    await assert.rejects(() => f.directory.search(''), error => error.reason === 'configuration')
  }
  const f = fixture({ override: url => url.pathname.endsWith('/appRoleAssignedTo') ? json({ value: null }) : undefined })
  await assert.rejects(() => f.directory.search(''), EntraDirectoryError)
})

test('network and timeout failures do not fabricate a denial or empty directory', async () => {
  const offline = fixture({ override: () => { throw new TypeError('private connection detail') } })
  await assert.rejects(() => offline.directory.search(''), error => error.reason === 'upstream' && !error.message.includes('private'))
  const timedOut = createEntraDirectory(config, { getToken: async () => ({ token: 'token', expiresOnTimestamp: 1 }) }, {
    requestTimeoutMs: 1,
    fetch: async (_url, { signal }) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      signal.throwIfAborted()
      return json({})
    },
  })
  await assert.rejects(() => timedOut.search(''), error => error.reason === 'timeout')
})
