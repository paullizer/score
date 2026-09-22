import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'

const output = resolve(`.workspace-access-tests-${randomUUID()}`)
const originals = new Map()
const element = React.createElement
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
const user = { id: 'owner-user', tenantId: 'tenant', name: 'Current owner', email: 'owner@example.test' }
const metadata = { id: 'workspace-one', name: 'Shared workspace', kind: 'personal', role: 'owner', accessSource: 'membership', etag: '"workspace-one"', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const firstPerson = { id: 'person-one', name: 'Pat Eligible', email: 'pat@example.test', applicationRoles: ['Score.User'] }
const preLogin = { id: 'person-never-signed-in', name: 'New Reader', email: 'new@example.test', applicationRoles: ['Score.User'] }
const adminPerson = { id: 'admin-person', name: 'App Administrator', email: 'admin@example.test', applicationRoles: ['Score.Admin'] }
const json = (value, status = 200) => Response.json(value, { status })
let ui, dom, root, createRoot, requests, override, capabilities, workspaces, workspace, members, grant, settings

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
function session() { return { mode: 'cloud', user, capabilities, workspaces } }
function publicSettings() { return ui.projectPublicSettings(ui.captureProcessingSettings(settings, 'settings-1', '2026-01-01T00:00:00.000Z')) }
function settingsResponse() {
  return {
    settings, revision: 'settings-1', etag: '"settings-1"', createdAt: '2026-01-01',
    defaults: ui.createDefaultAdminSettings(), fields: ui.ADMIN_SETTINGS_FIELDS,
    environment: {
      runtimeEnabled: true, storeConfigured: true, runtimeSettingsVersion: 'score-runtime-settings-v1', workerVerification: null,
      runtimeReadiness: { configured: true, newProcessingAllowed: true, reason: null, message: null }, tenantId: user.tenantId,
      model: { endpoint: null, resourceId: null, authentication: 'managed-identity', inventoryAvailable: false, probeIdentity: 'api-managed-identity', workerIdentityVerified: false },
    },
  }
}

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
    'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'PopStateEvent', 'DocumentFragment', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  for (const [name, value] of Object.entries({
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  originals.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'))
  dom.window.matchMedia = globalThis.matchMedia
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export { CloudApplication } from './src/app/CloudApplication';
      export { CloudWorkspaceProvider } from './src/app/CloudWorkspaceProvider';
      export { GradeNavigationProtectionProvider } from './src/app/GradeNavigationProtection';
      export { useGradeLeaveGuard } from './src/app/grade-navigation-context';
      export { WorkspaceSwitcher } from './src/components/workspace/WorkspaceSwitcher';
      export { ManageWorkspaceAccess } from './src/components/workspace/ManageWorkspaceAccess';
      export { EligiblePeoplePicker } from './src/components/workspace/EligiblePeoplePicker';
      export { CloudSaveBanner } from './src/components/workspace/CloudSaveStatus';
      export { RealRequestScope } from './src/app/real-request-scope';
      export { createInitialWorkspace } from './src/data/fixtures';
      export { createDefaultAdminSettings } from './src/domain/admin-settings-defaults';
      export { projectPublicSettings, captureProcessingSettings } from './src/domain/admin-settings-resolver';
      export { ADMIN_SETTINGS_FIELDS } from './src/domain/admin-settings-fields';
      export { describeSettingValue } from './src/features/admin/settingsForm';
      export * from './src/services/cloudWorkspace';
      export * from './src/services/workspaceAccess';
    ` },
    outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' },
  })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

beforeEach(() => {
  requests = []; override = null
  capabilities = { applicationAdmin: false, canCreateWorkspaces: false }
  workspaces = []; workspace = ui.createInitialWorkspace(); settings = ui.createDefaultAdminSettings()
  members = { members: [{ id: user.id, name: user.name, email: user.email, role: 'owner' }], etag: '"members-1"' }
  grant = { userId: firstPerson.id, canCreateWorkspaces: false, etag: '"unassigned"' }
  ui.setCloudSessionAccess(null)
  dom.window.localStorage.clear()
  dom.window.history.replaceState(null, '', '/')
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url, 'https://score.test')
    const path = parsed.pathname
    const method = init.method ?? 'GET'
    requests.push({ path, url, method, init })
    const custom = await override?.(path, init, parsed)
    if (custom !== undefined) return custom
    if (path === '/api/features') return json({
      realJobImports: true, realGradeLadders: true, realResumeImports: true, realAnalyses: true,
      markdownJobImports: true, markdownResumeImports: true, wordDocumentImports: true,
      analysisSummaryGeneration: true, publicSettings: publicSettings(),
    })
    if (path === '/api/session/identity') return json({ mode: 'cloud', user, capabilities })
    if (path === '/api/session') return json(session())
    if (path === '/api/workspaces' && method === 'GET') return json({ workspaces })
    if (path === '/api/workspaces' && method === 'POST') {
      const created = { ...metadata, id: 'workspace-new', name: JSON.parse(init.body).name }
      workspaces.push(created)
      return json({ workspace: created })
    }
    const counts = /^\/api\/workspaces\/([^/]+)\/summary$/.exec(path)
    if (counts) return json({ workspaceId: counts[1], jobs: { status: 'ready', count: 2 }, resumes: { status: 'ready', count: 3 }, analyses: { status: 'ready', count: 1 } })
    if (path === '/api/admin/users' || path.endsWith('/share-candidates')) {
      if (parsed.searchParams.get('query')) return json({ users: [preLogin] })
      return json(parsed.searchParams.has('continuation') ? { users: [preLogin, adminPerson] } : { users: [firstPerson], continuation: 'page-two' })
    }
    if (path.endsWith('/workspace-creation')) {
      if (method === 'PUT') grant = { ...grant, ...JSON.parse(init.body), etag: '"grant-2"' }
      return json(grant)
    }
    if (path.endsWith('/members')) return json(members)
    if (path.includes('/members/') && method !== 'GET') {
      const id = decodeURIComponent(path.split('/').at(-1))
      const person = [firstPerson, preLogin, adminPerson].find(value => value.id === id) ?? user
      const current = members.members.find(value => value.id === id)
      const role = method === 'PUT' ? JSON.parse(init.body).role : null
      if (current?.role === 'owner' && role !== 'owner' && members.members.filter(value => value.role === 'owner').length === 1) {
        return json({ error: { code: 'conflict', message: 'The last explicit owner cannot be removed or demoted. Add another owner first.' } }, 409)
      }
      members = {
        members: [...members.members.filter(value => value.id !== id), ...(role ? [{ id, name: person.name, email: person.email, role }] : [])],
        etag: `"members-${Number(members.etag.match(/\d+/)[0]) + 1}"`,
      }
      if (id === user.id && !capabilities.applicationAdmin) {
        const workspaceId = path.split('/')[3]
        workspaces = role ? workspaces.map(item => item.id === workspaceId ? { ...item, role } : item)
          : workspaces.filter(item => item.id !== workspaceId)
      }
      return json(members)
    }
    if (path === '/api/admin/settings') return json(settingsResponse())
    if (path.endsWith('/state')) return json(method === 'PUT' ? { etag: '"state-2"' } : { workspace, etag: '"state-1"' })
    if (path.endsWith('/jobs')) return json({ jobs: [] })
    if (path.endsWith('/resumes')) return json({ resumes: [] })
    if (path.endsWith('/grade-ladders')) return json({ ladders: [] })
    if (path.endsWith('/analyses/targets')) return json({ targets: [] })
    if (path.endsWith('/analyses')) return json({ runs: [] })
    throw new Error(`Unexpected access fixture request: ${method} ${url}`)
  }
})
afterEach(async () => {
  if (root) { await act(async () => { root.unmount(); await pause() }); root = null }
  ui.setCloudSessionAccess(null)
})
after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

async function render(tree) {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => { root.render(tree); await pause() })
}
async function until(predicate, message) {
  for (let index = 0; index < 150; index++) {
    if (predicate()) return
    await act(async () => { await pause() })
  }
  assert.fail(`${message}\n${document.body.textContent.slice(0, 3000)}`)
}
function visible(node) { return !node.closest('[hidden]') }
function button(label, within = document) {
  const result = [...within.querySelectorAll('button')].find(item => visible(item) && (item.getAttribute('aria-label') ?? item.textContent.trim()) === label)
  assert.ok(result, `Button "${label}" exists`)
  return result
}
const click = async node => { await act(async () => { node.click(); await pause() }) }
const dialog = title => [...document.querySelectorAll('[role="dialog"]')].find(item => item.querySelector('h2')?.textContent === title)
async function edit(input, value) {
  assert.ok(input, 'Editable control exists')
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    await pause()
  })
}
async function focus() { await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); await pause() }) }
const writes = path => requests.filter(request => request.path === path && !['GET', 'HEAD'].includes(request.method))

test('access clients use encoded, paged paths, CSRF and exact grant/member ETags without replay', async () => {
  override = () => json({ users: [], members: [], etag: '"next"', userId: 'a/b', canCreateWorkspaces: false })
  await ui.listEligibleUsers('name & email', 'next/+')
  await ui.listShareCandidates('w/a', 'name & email', 'next/+')
  await ui.setCreationAccess('a/b', true, '"unassigned"')
  await ui.setWorkspaceMember('w/a', 'a/b', 'viewer', '"collection"')
  await ui.removeWorkspaceMember('w/a', 'a/b', '"new-collection"')
  assert.match(requests[0].url, /query=name\+%26\+email&continuation=next%2F%2B/)
  assert.match(requests[1].url, /workspaces\/w%2Fa\/share-candidates/)
  assert.equal(requests[2].init.headers.get('If-Match'), '"unassigned"')
  assert.equal(requests[3].init.headers.get('If-Match'), '"collection"')
  assert.equal(requests[4].init.headers.get('If-Match'), '"new-collection"')
  assert.deepEqual(JSON.parse(requests[3].init.body), { role: 'viewer' })
  assert.ok(requests.every(item => item.init.headers.get('X-Score-Request') === 'workspace' && item.init.credentials === 'include'))
  override = () => json({ error: { code: 'conflict', message: 'New access revision.' } }, 409)
  await assert.rejects(ui.setCreationAccess('a/b', true, '"stale"'), ui.CloudConflictError)
  assert.equal(requests.length, 6)
})

test('access generations reject stale responses, stop queued writes and do not infer creation from ownership', async () => {
  workspaces = [metadata]
  ui.setCloudSessionAccess(session())
  await assert.rejects(ui.createWorkspace('Not authorized'), /grant you permission/)
  assert.equal(requests.length, 0)
  const held = deferred()
  override = path => path.endsWith('/state') ? held.promise : undefined
  const pending = ui.saveWorkspaceState(metadata.id, workspace, '"state"')
  const rejected = assert.rejects(pending, ui.CloudAccessChangedError)
  workspaces = [{ ...metadata, role: 'viewer' }]
  ui.setCloudSessionAccess(session())
  held.resolve(json({ etag: '"accepted-but-stale"' }))
  await rejected
  const count = requests.length
  await assert.rejects(ui.saveWorkspaceState(metadata.id, workspace, '"state"'), /Reader access/)
  assert.equal(requests.length, count)
  workspaces = []
  ui.setCloudSessionAccess(session())
  await assert.rejects(ui.loadWorkspaceState(metadata.id), /no longer available/)
  assert.equal(requests.length, count)
})

test('implicit admin access-source changes invalidate reads; request scopes settle old writes without applying them', async () => {
  capabilities = { applicationAdmin: true, canCreateWorkspaces: true }; workspaces = [metadata]
  ui.setCloudSessionAccess(session())
  const held = deferred()
  override = path => path.endsWith('/state') ? held.promise : undefined
  const read = ui.loadWorkspaceState(metadata.id)
  const rejected = assert.rejects(read, ui.CloudAccessChangedError)
  workspaces = [{ ...metadata, accessSource: 'application-admin' }]
  ui.setCloudSessionAccess(session())
  held.resolve(json({ workspace, etag: '"state"' }))
  await rejected
  const scope = new ui.RealRequestScope()
  scope.updateAccess('owner:membership', true)
  const ticket = scope.mutate('queued-write')
  scope.updateAccess('viewer:membership', true)
  assert.equal(scope.mutationCurrent(ticket), false)
  assert.equal(scope.mutationOwned(ticket), true, 'The pending indicator can settle without accepting a stale result.')
  scope.finishMutation(ticket)
  const disposable = scope.read('history')
  scope.updateAccess('removed', false)
  assert.equal(disposable.controller.signal.aborted, true)
  assert.equal(scope.current(disposable), false)
  assert.equal(scope.read('new-read'), null)
  assert.throws(() => scope.mutate('new-write'), /no longer available/)
})

test('empty workspace state distinguishes explicit creation grants and refreshes capabilities through session reads', async () => {
  await render(element(ui.CloudApplication))
  await until(() => document.body.textContent.includes('No workspaces are assigned'), 'Unassigned empty state')
  assert.equal(button('New workspace').disabled, true)
  assert.equal(writes('/api/workspaces').length, 0)
  assert.match(document.body.textContent, /application administrator for permission/)
  capabilities.canCreateWorkspaces = true
  await focus()
  await until(() => !button('New workspace').disabled, 'New explicit grant is reflected')
  assert.equal(requests.filter(item => item.path === '/api/workspaces').length, 0, 'Refresh uses session capabilities, not list-only metadata.')
  await click(button('New workspace'))
  await edit(document.querySelector('[aria-label="New workspace name"]'), 'Team hiring')
  await click(button('Create'))
  await until(() => document.querySelector('.app-layout'), 'Explicitly created workspace opens')
  assert.equal(writes('/api/workspaces').length, 1)
})

test('archived workspace state and application creation stop remain distinct from individual grants', async () => {
  capabilities.canCreateWorkspaces = true
  workspaces = [{ ...metadata, archivedAt: '2026-01-02' }]
  settings.workspaces.allowCreation = false
  await render(element(ui.CloudApplication))
  await until(() => document.querySelector('.workspace-home-card'), 'Archived-only home')
  assert.match(document.body.textContent, /Archived.*read only/)
  assert.equal(requests.filter(item => item.path.endsWith('/summary')).length, 0)
  assert.equal(button('New workspace').disabled, true)
  assert.match(document.body.textContent, /disabled by application policy/)
  assert.ok(button('Manage access to Shared workspace'))
  assert.equal(writes('/api/workspaces').length, 0)
})

test('home shares the access-aware directory, uses real counts, and exposes administration without selecting a workspace', async () => {
  workspaces = [metadata]
  settings.workspaces.allowCreation = false
  localStorage.setItem('score-cloud-last-workspace:tenant:owner-user', metadata.id)
  await render(element(ui.CloudApplication))
  await until(() => document.querySelector('.workspace-card-counts dd')?.textContent === '2', 'Real counts load on home')
  assert.equal(location.pathname, '/')
  assert.equal(document.querySelector('.app-layout'), null)
  assert.equal(button('New workspace').disabled, true)
  assert.ok(button('Manage access to Shared workspace'))
  assert.ok(!document.body.textContent.includes('Users / user access'))
  assert.ok(!requests.some(item => /\/(?:state|jobs|resumes|analyses|grade-ladders)$/.test(item.path)))
  capabilities = { applicationAdmin: true, canCreateWorkspaces: true }
  workspaces = [{ ...metadata, accessSource: 'application-admin' }]
  await focus()
  await until(() => document.body.textContent.includes('Users / user access'), 'Admin navigation is exposed by the refreshed capability')
  assert.match(document.querySelector('.workspace-home-card').textContent, /Application administrator/)
  assert.equal(button('New workspace').disabled, true, 'Global policy still applies to an implicit creation grant.')
  await click(button('Users / user access'))
  await until(() => document.querySelector('#admin-users-content'), 'User access opens directly from home')
  assert.equal(location.pathname, '/admin/users')
})

test('home sharing protects unfinished choices on browser history and clears revoked cards, counts and recents after self-removal', async () => {
  const other = { ...metadata, id: 'workspace-two', name: 'Other workspace' }
  workspaces = [metadata, other]
  members.members.push({ ...firstPerson, role: 'owner' })
  const recentKey = 'score-cloud-recent-workspaces:tenant:owner-user'
  localStorage.setItem(recentKey, JSON.stringify({ version: 1, entries: [
    { id: metadata.id, lastOpenedAt: '2026-01-02T00:00:00.000Z' },
    { id: other.id, lastOpenedAt: '2026-01-01T00:00:00.000Z' },
  ] }))
  dom.window.history.replaceState(null, '', '/admin/users')
  dom.window.history.pushState(null, '', '/')
  await render(element(ui.CloudApplication))
  await until(() => document.querySelectorAll('.workspace-home-card').length === 2, 'Home lists both accessible workspaces')
  await click(button('Manage access to Shared workspace'))
  await until(() => [...document.querySelectorAll('button')].some(item => item.textContent === 'Load more people'), 'Sharing candidates load')
  await click(button('Load more people'))
  await until(() => document.body.textContent.includes('Select New Reader'), 'An eligible non-member is available')
  await click(button('Select New Reader'))
  await act(async () => { window.history.back(); await pause(30) })
  await until(() => dialog('Unsaved changes'), 'Home membership choices protect cross-scope history')
  await click(button('Stay here', dialog('Unsaved changes')))
  assert.equal(location.pathname, '/')
  assert.ok(document.querySelector('[aria-label="New member role"]'))
  await click(button('Cancel selection'))
  await click(button('Remove Current owner'))
  await click(button('Remove membership', dialog('Remove workspace member?')))
  await until(() => document.querySelectorAll('.workspace-home-card').length === 1, 'Self-removal prunes the home directory')
  assert.match(dialog('Manage access').textContent, /no longer has permission to manage/)
  assert.deepEqual(JSON.parse(localStorage.getItem(recentKey)).entries.map(item => item.id), [other.id])
  assert.equal(document.querySelector('[aria-label="Manage access to Shared workspace"]'), null)
  assert.equal(button('New workspace').disabled, true)
  const oldRequests = requests.filter(item => item.path.startsWith('/api/workspaces/workspace-one/')).length
  await assert.rejects(ui.loadWorkspaceState(metadata.id), /no longer available/)
  await focus()
  assert.equal(requests.filter(item => item.path.startsWith('/api/workspaces/workspace-one/')).length, oldRequests)
  assert.equal(document.querySelector('.app-layout'), null)
})

test('home count authentication failures suspend access without discarding an unfinished membership choice', async () => {
  workspaces = [metadata]
  const pendingCounts = deferred()
  let expired = false
  override = path => path.endsWith('/summary') ? pendingCounts.promise.then(response => response.clone())
    : path === '/api/session' && expired ? json({ error: { code: 'unauthorized', message: 'Sign in again to refresh access.' } }, 401) : undefined
  await render(element(ui.CloudApplication))
  await until(() => document.querySelector('.workspace-home-card'), 'Home loads while counts are pending')
  await click(button('Manage access to Shared workspace'))
  await until(() => document.body.textContent.includes('Select Pat Eligible'), 'A membership choice is available')
  await click(button('Select Pat Eligible'))
  expired = true
  await act(async () => {
    pendingCounts.resolve(json({ error: { code: 'unauthorized', message: 'Sign in again to refresh access.' } }, 401))
    await pause()
  })
  await until(() => dialog('Manage access')?.textContent.includes('no longer has permission to manage'), 'Access is suspended')
  assert.ok(document.querySelector('.workspace-home'), 'The draft-owning home remains mounted.')
  assert.equal(requests.filter(item => item.method === 'PUT').length, 0)
  override = null
  await focus()
  await until(() => document.querySelector('[aria-label="New member role"]'), 'Reauthentication restores the same unsaved choice')
  assert.equal(document.querySelector('[aria-label="New member role"]').value, 'viewer')
  assert.match(dialog('Manage access').textContent, /Pat Eligible/)
  assert.equal(requests.filter(item => item.method === 'PUT').length, 0)
})

test('owner is not application admin; direct user access is reachable for admins with no workspace', async () => {
  dom.window.history.replaceState(null, '', '/admin/users')
  workspaces = [metadata]
  await render(element(ui.CloudApplication))
  await until(() => document.body.textContent.includes('Application administrator access required'), 'Owner is denied')
  assert.ok(!requests.some(item => item.path.startsWith('/api/admin/')))
  await act(async () => { root.unmount(); root = null })
  capabilities = { applicationAdmin: true, canCreateWorkspaces: true }; workspaces = []
  await render(element(ui.CloudApplication))
  await until(() => document.querySelector('#admin-users-content'), 'Users page opens independently of a workspace')
  assert.ok(requests.some(item => item.path === '/api/session/identity'))
  assert.ok(!requests.some(item => item.path.includes('/members')))
  await until(() => document.body.textContent.includes('Pat Eligible'), 'Eligible people load')
  await click(button('Select Pat Eligible'))
  await until(() => document.querySelector('input[type="checkbox"]'), 'Current grant loads')
  await click(document.querySelector('input[type="checkbox"]'))
  await click(button('Review permission change'))
  assert.ok(dialog('Grant workspace creation?'))
  assert.equal(writes('/api/admin/users/person-one/workspace-creation').length, 0)
  await click(button('Grant permission', dialog('Grant workspace creation?')))
  await until(() => document.body.textContent.includes('Workspace-creation permission granted'), 'Grant acknowledged')
  const request = writes('/api/admin/users/person-one/workspace-creation')[0]
  assert.equal(request.init.headers.get('If-Match'), '"unassigned"')
  assert.deepEqual(JSON.parse(request.init.body), { canCreateWorkspaces: true })
})

test('admin user search includes later pages and pre-login users; implicit admin creation cannot be revoked here', async () => {
  capabilities = { applicationAdmin: true, canCreateWorkspaces: true }
  dom.window.history.replaceState(null, '', '/admin/users')
  await render(element(ui.CloudApplication))
  await until(() => document.body.textContent.includes('Pat Eligible'), 'First people page')
  await click(button('Load more people'))
  await until(() => document.body.textContent.includes('New Reader'), 'Never-signed-in user on next page')
  assert.ok(requests.some(item => item.url.includes('continuation=page-two')))
  await click(button('Select App Administrator'))
  await until(() => document.body.textContent.includes('without an individual grant'), 'Admin implicit permission notice')
  assert.equal(document.querySelector('input[type="checkbox"]').disabled, true)
  assert.equal(document.querySelector('input[type="checkbox"]').checked, true)
  assert.equal(requests.filter(item => item.method === 'PUT').length, 0)
})

test('settings and user-access navigation retains the existing unsaved-leave confirmation', async () => {
  capabilities = { applicationAdmin: true, canCreateWorkspaces: true }
  dom.window.history.replaceState(null, '', '/admin/users')
  await render(element(ui.CloudApplication))
  await until(() => document.body.textContent.includes('Pat Eligible'), 'People load')
  await click(button('Select Pat Eligible'))
  await until(() => document.querySelector('input[type="checkbox"]'), 'Permission loads')
  await click(document.querySelector('input[type="checkbox"]'))
  await click(button('Application settings'))
  assert.ok(dialog('Unsaved changes'))
  assert.equal(window.location.pathname, '/admin/users')
  await click(button('Stay here', dialog('Unsaved changes')))
  assert.equal(document.querySelector('input[type="checkbox"]').checked, true)
  await click(button('Application settings'))
  await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
  await until(() => document.querySelector('.settings-savebar'), 'Settings loads after explicit discard')
  await edit(document.querySelector('[aria-label="Search application settings"]'), 'appearance.applicationTitle')
  const field = [...document.querySelectorAll('.settings-field')].find(item => item.querySelector('code')?.textContent === 'appearance.applicationTitle')
  await edit(field.querySelector('textarea'), 'Unsaved title')
  await click(button('Users / user access'))
  assert.ok(dialog('Unsaved changes'))
  assert.equal(window.location.pathname, '/admin/settings')
  assert.equal(requests.filter(item => item.method === 'PATCH').length, 0)
})

test('grant conflicts preserve the proposal and require a current read rather than automatic retry', async () => {
  capabilities = { applicationAdmin: true, canCreateWorkspaces: true }
  dom.window.history.replaceState(null, '', '/admin/users')
  override = (path, init) => path.endsWith('/workspace-creation') && init.method === 'PUT'
    ? json({ error: { code: 'conflict', message: 'Another administrator updated this grant.' } }, 409) : undefined
  await render(element(ui.CloudApplication))
  await until(() => document.body.textContent.includes('Pat Eligible'), 'People load')
  await click(button('Select Pat Eligible'))
  await until(() => document.querySelector('input[type="checkbox"]'), 'Grant loads')
  await click(document.querySelector('input[type="checkbox"]'))
  await click(button('Review permission change'))
  await click(button('Grant permission', dialog('Grant workspace creation?')))
  await until(() => document.body.textContent.includes('Nothing was automatically resent'), 'Conflict recovery shown')
  assert.equal(document.querySelector('input[type="checkbox"]').checked, true)
  assert.equal(button('Review permission change').disabled, true)
  assert.equal(writes('/api/admin/users/person-one/workspace-creation').length, 1)
  await click(button('Refresh current access'))
  assert.ok(dialog('Unsaved changes'))
  await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
  await until(() => !document.querySelector('input[type="checkbox"]')?.checked && !document.body.textContent.includes('Your proposed choice is retained'), 'Fresh grant explicitly reloaded')
  assert.equal(writes('/api/admin/users/person-one/workspace-creation').length, 1)
})

async function openSharing(current = metadata) {
  await render(element(ui.GradeNavigationProtectionProvider, { workspaceId: current.id, apiRef: { current: null } },
    element(ui.ManageWorkspaceAccess, { workspaceId: current.id, workspace: current, onClose() {}, onAccessChanged: async () => {} })))
  await until(() => document.querySelector('[aria-label="Role for Current owner"]'), 'Membership list loads')
}

test('sharing identifies people, defaults to Reader, confirms changes and uses collection ETags', async () => {
  await openSharing({ ...metadata, accessSource: 'application-admin', archivedAt: '2026-01-02' })
  assert.match(document.body.textContent, /last one|last explicit Owner/)
  assert.match(document.body.textContent, /Your access: Application administrator/)
  assert.match(document.body.textContent, /archived.*managed/s)
  await until(() => document.body.textContent.includes('Pat Eligible'), 'Candidates load')
  await click(button('Load more people'))
  await until(() => document.body.textContent.includes('New Reader'), 'Pre-login recipient appears')
  await click(button('Select New Reader'))
  assert.equal(document.querySelector('[aria-label="New member role"]').value, 'viewer')
  assert.equal(document.querySelector('[aria-label="New member role"] option:checked').textContent, 'Reader')
  await click(button('Review adding member'))
  assert.equal(requests.filter(item => item.method === 'PUT').length, 0)
  await click(button('Save membership', dialog('Add workspace member?')))
  await until(() => document.querySelector('[aria-label="Role for New Reader"]'), 'New member appears')
  const path = '/api/workspaces/workspace-one/members/person-never-signed-in'
  assert.equal(writes(path)[0].init.headers.get('If-Match'), '"members-1"')
  assert.deepEqual(JSON.parse(writes(path)[0].init.body), { role: 'viewer' })
  await edit(document.querySelector('[aria-label="Role for New Reader"]'), 'editor')
  assert.ok(dialog('Change workspace role?'))
  await click(button('Save membership', dialog('Change workspace role?')))
  await until(() => document.querySelector('[aria-label="Role for New Reader"]').value === 'editor', 'Changed role acknowledged')
  assert.equal(writes(path)[1].init.headers.get('If-Match'), '"members-2"')
  await click(button('Remove New Reader'))
  await click(button('Remove membership', dialog('Remove workspace member?')))
  await until(() => !document.querySelector('[aria-label="Role for New Reader"]'), 'Removal acknowledged')
  assert.equal(writes(path)[2].method, 'DELETE')
  assert.equal(writes(path)[2].init.headers.get('If-Match'), '"members-3"')
})

test('last-owner refusal and ambiguous sharing acknowledgement show explicit recovery without replay', async () => {
  await openSharing()
  await click(button('Remove Current owner'))
  await click(button('Remove membership', dialog('Remove workspace member?')))
  await until(() => document.body.textContent.includes('last explicit owner cannot'), 'Last owner error retained')
  assert.equal(document.querySelector('[aria-label="Role for Current owner"]').disabled, true)
  await click(button('Refresh members'))
  await until(() => !document.querySelector('[aria-label="Role for Current owner"]').disabled, 'Owner list reloaded')
  await until(() => document.body.textContent.includes('Pat Eligible'), 'Candidates load')
  await click(button('Select Pat Eligible'))
  await click(button('Review adding member'))
  override = (path, init) => {
    if (path.endsWith('/members/person-one') && init.method === 'PUT') throw new TypeError('Connection ended before acknowledgement.')
  }
  await click(button('Save membership', dialog('Add workspace member?')))
  await until(() => document.body.textContent.includes('may already have been accepted'), 'Ambiguous outcome warning')
  const path = '/api/workspaces/workspace-one/members/person-one'
  assert.equal(writes(path).length, 1)
  assert.equal(button('Review adding member').disabled, true)
  await click(button('Refresh members'))
  await until(() => !button('Review adding member').disabled, 'Membership reloaded before new explicit choice')
  assert.equal(writes(path).length, 1)
})

test('Reader and Editor have no sharing/lifecycle ownership controls and no inherited creation grant', async () => {
  for (const role of ['viewer', 'editor']) {
    await render(element(ui.WorkspaceSwitcher, { empty: true, cloud: {
      workspaces: [{ ...metadata, role }], currentWorkspaceId: metadata.id, canCreateWorkspaces: false,
      refreshWorkspaces: async () => {}, switchWorkspace: async () => ({ ok: true }), createWorkspace: async () => ({ ok: true }),
      renameWorkspace: async () => ({ ok: true }), getWorkspaceLifecycleImpact: async () => { throw new Error('Not authorized') },
      changeWorkspaceLifecycle: async () => { throw new Error('Not authorized') },
    } }))
    assert.ok(!document.querySelector('[aria-label="Manage access to Shared workspace"]'))
    assert.ok(!document.querySelector('[aria-label="Rename Shared workspace"]'))
    assert.equal(button('New workspace').disabled, true)
    assert.match(document.body.textContent, role === 'viewer' ? /Reader/ : /Editor/)
    assert.ok(!document.body.textContent.includes('Personal'))
  }
  assert.equal(ui.describeSettingValue('reports.allowedRoles', ['owner', 'editor', 'viewer']), 'Owner, Editor, Reader')
})

test('downgrade stops debounced sample writes while keeping drafts; removal hides content without preserving a readable summary', async () => {
  let observed
  const providerRef = { current: null }
  const leaveRef = { current: null }
  const acknowledged = async () => ({ ok: true })
  function Probe({ value, cloud }) {
    observed = { value, cloud }
    return element('section', { 'data-testid': 'retained-content' }, element(ui.CloudSaveBanner, { cloud }), element('p', null, value.workspace.rubrics.map(item => item.name).join(' / ')))
  }
  function tree(items) {
    return element(ui.GradeNavigationProtectionProvider, { workspaceId: metadata.id, apiRef: leaveRef },
      element(ui.CloudWorkspaceProvider, {
        workspaceId: metadata.id, user, workspaces: items, apiRef: providerRef, leaveProtectionRef: leaveRef,
        canCreateWorkspaces: false, onAuthError() {}, onSignedOut() {},
        switchWorkspace: acknowledged, createWorkspace: acknowledged, renameWorkspace: acknowledged,
        refreshWorkspaces: async () => {}, getWorkspaceLifecycleImpact: async () => ({}), changeWorkspaceLifecycle: async () => {},
        leaveUnavailableWorkspace: acknowledged,
      }, (value, cloud) => element(Probe, { value, cloud })))
  }
  await render(tree([metadata]))
  await until(() => observed?.value.workspace, 'Sample snapshot ready')
  await act(async () => {
    observed.value.saveRubric({ ...observed.value.workspace.rubrics[0], name: 'Unsaved local draft' })
    await pause()
  })
  assert.equal(providerRef.current.hasPendingChanges(), true)
  await render(tree([{ ...metadata, role: 'viewer' }]))
  await act(async () => { await pause(800) })
  assert.equal(writes('/api/workspaces/workspace-one/state').length, 0)
  assert.match(document.body.textContent, /role is now Reader/)
  assert.match(document.body.textContent, /Unsaved local draft/)
  assert.ok(![...document.querySelectorAll('button')].some(item => item.textContent === 'Keep my changes'))
  await act(async () => { await observed.cloud.keepMineAndOverwrite() })
  assert.equal(writes('/api/workspaces/workspace-one/state').length, 0)
  await render(tree([]))
  assert.equal(observed.cloud.workspaces.length, 0)
  assert.equal(document.querySelector('[data-testid="retained-content"]').closest('[hidden]') !== null, true)
  assert.match(document.body.textContent, /Workspace access is no longer available/)
  assert.equal(providerRef.current.hasPendingChanges(), true)
  assert.equal((await providerRef.current.flush()).ok, false)
})

test('focus revocation hides open access dialogs and stops workspace requests; restoration is explicit refresh', async () => {
  workspaces = [metadata]
  dom.window.history.replaceState(null, '', '/workspaces/workspace-one/jobs')
  await render(element(ui.CloudApplication))
  await until(() => document.querySelector('.workspace-switcher-trigger'), 'Workspace opens')
  await click(document.querySelector('.workspace-switcher-trigger'))
  await click(button('Manage access to Shared workspace'))
  await until(() => document.querySelector('[aria-label="Role for Current owner"]'), 'Access dialog opens')
  workspaces = []
  await focus()
  await until(() => document.body.textContent.includes('Workspace access is no longer available'), 'Revoked content is locked')
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0, 'Portalled dialogs are not readable through the lock.')
  const count = requests.filter(item => item.path.startsWith('/api/workspaces/')).length
  await assert.rejects(ui.loadWorkspaceState(metadata.id), /no longer available/)
  await focus()
  assert.equal(requests.filter(item => item.path.startsWith('/api/workspaces/')).length, count)
  workspaces = [{ ...metadata, role: 'viewer' }]
  await focus()
  await until(() => !document.querySelector('.access-suspended[hidden]'), 'Restored Reader membership is usable')
  assert.equal(button('New analysis').disabled, true)
})

test('search ignores stale people responses instead of applying results to a different query', async () => {
  const old = deferred()
  const load = (query, _continuation, signal) => {
    if (!query) return old.promise
    assert.equal(signal.aborted, false)
    return Promise.resolve({ users: [preLogin] })
  }
  await render(element(ui.EligiblePeoplePicker, { load, onChoose() {} }))
  await edit(document.querySelector('[aria-label="Search eligible people"]'), 'New')
  await until(() => document.body.textContent.includes('New Reader'), 'Search result arrives')
  await act(async () => { old.resolve({ users: [firstPerson], continuation: 'obsolete' }); await pause() })
  assert.ok(!document.body.textContent.includes('Pat Eligible'))
  assert.ok(!document.body.textContent.includes('Load more people'))
})
