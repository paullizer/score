import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { frontendWorkspaceContext } from './frontend.test-support.mjs'

const output = resolve(`.reviewer-access-tests-${randomUUID()}`)
const originals = new Map()
const element = React.createElement
const user = { id: '00000000-0000-4000-8000-000000000001', tenantId: '00000000-0000-4000-8000-000000000002',
  name: 'Display only', email: 'display@example.test' }
const reviewerId = '00000000-0000-4000-8000-000000000003'
const metadata = { id: 'workspace-one', name: 'Private workspace', role: 'owner', kind: 'personal',
  etag: '"workspace-1"', createdAt: '2026-09-22T14:00:00.000Z', updatedAt: '2026-09-22T14:00:00.000Z' }
let ui, dom, root, createRoot, cloud, requests, savedAccess, override, workspace, directoryRefreshes

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'DocumentFragment', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  for (const [name, value] of Object.entries({
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  originals.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'))
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export * from './src/domain/workspace-permissions'
      export { createInitialWorkspace } from './src/data/fixtures'
      export * from './src/services/cloudWorkspace'
      export { CloudWorkspaceProvider } from './src/app/CloudWorkspaceProvider'
      export { WorkspaceContext } from './src/app/workspace-context'
      export { realWorkspaceWritable, assertRealLifecyclePermission } from './src/app/real-lifecycle'
      export { useLifecycleAccess } from './src/components/lifecycle/useLifecycleAccess'
      export { WorkspaceSwitcher } from './src/components/workspace/WorkspaceSwitcher'
      export { RubricPanel } from './src/features/rubrics/RubricPanel'
      export { MemoryRouter } from 'react-router-dom'
    ` },
    outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' },
  })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

beforeEach(() => {
  requests = []; override = null; directoryRefreshes = 0
  workspace = ui.createInitialWorkspace()
  savedAccess = { workspaceId: metadata.id, tenantId: user.tenantId, etag: '"access-1"', reviewers: [] }
  cloud = frontendWorkspaceContext({ cloud: { user, currentWorkspaceId: metadata.id, workspaces: [{ ...metadata }],
    refreshWorkspaces: async () => { directoryRefreshes++ } } }).cloud
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url, 'https://score.test').pathname
    const method = init.method ?? 'GET'
    requests.push({ path, method, init })
    const custom = await override?.(path, init)
    if (custom !== undefined) return custom
    if (path === `/api/workspaces/${metadata.id}/state`) {
      assert.equal(method, 'GET', 'Read-only providers must not upload sample state')
      return Response.json({ workspace: structuredClone(workspace), etag: '"state-1"' })
    }
    const base = `/api/workspaces/${metadata.id}/reviewers`
    assert.ok(path === base || path.startsWith(`${base}/`), `${method} ${path}`)
    if (method !== 'GET') assert.equal(init.headers.get('If-Match'), savedAccess.etag, 'The current access-list ETag is mandatory')
    if (method === 'POST') {
      const body = JSON.parse(init.body)
      assert.deepEqual(Object.keys(body).sort(), body.label ? ['label', 'objectId'] : ['objectId'])
      savedAccess = { ...savedAccess, etag: '"access-2"', reviewers: [{ ...body, role: 'reviewer' }] }
    } else if (method === 'DELETE') {
      assert.equal(path, `${base}/${reviewerId}`)
      assert.equal(init.body, undefined)
      savedAccess = { ...savedAccess, etag: '"access-3"', reviewers: [] }
    }
    return Response.json(structuredClone(savedAccess), { status: method === 'POST' ? 201 : 200, headers: { ETag: savedAccess.etag } })
  }
})

afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null }
})
after(async () => {
  dom.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

async function render(content) {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => root.render(content))
}
async function picker() { await render(element(ui.WorkspaceSwitcher, { cloud, empty: true })) }
function button(label) {
  const found = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent.trim() === label)
  assert.ok(found, label)
  return found
}
async function click(label) { await act(async () => button(label).click()) }
async function input(label, value) {
  const control = [...document.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(label))?.querySelector('input')
  assert.ok(control, label)
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(control, value)
    control.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function settle(predicate) {
  for (let index = 0; index < 60 && !predicate(); index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  assert.ok(predicate(), 'Expected reviewer access UI state')
}

test('explicit workspace permissions deny undefined and invalid members even to application administrators', () => {
  for (const [role, editing, reviewing, coordinating] of [
    ['owner', true, true, true], ['editor', true, true, true], ['reviewer', false, true, false], ['viewer', false, false, false],
    [undefined, false, false, false], [null, false, false, false], ['admin', false, false, false], ['', false, false, false],
  ]) {
    assert.equal(ui.workspaceCanEdit(role), editing, `${role} edit`)
    assert.equal(ui.workspaceCanReview(role), reviewing, `${role} QC`)
    assert.equal(ui.workspaceCanCoordinateQc(role), coordinating, `${role} coordinator`)
    const member = ['owner', 'editor', 'reviewer', 'viewer'].includes(role)
    assert.equal(ui.workspaceCanReview(role, true), member, `${role} admin QC`)
    assert.equal(ui.workspaceCanCoordinateQc(role, true), member, `${role} admin coordinator`)
    const parent = frontendWorkspaceContext({ workspace, cloud: { workspaces: role ? [{ ...metadata, role }] : [] } })
    assert.equal(ui.realWorkspaceWritable(parent, metadata.id), editing)
    if (editing) assert.doesNotThrow(() => ui.assertRealLifecyclePermission(parent, metadata.id))
    else assert.throws(() => ui.assertRealLifecyclePermission(parent, metadata.id), /read-only|unavailable/)
  }
})

test('workspace picker exposes the own account ID while only owners can open reviewer management', async () => {
  for (const role of ['reviewer', 'editor', 'viewer']) {
    cloud = { ...cloud, workspaces: [{ ...metadata, role }] }
    await picker()
    assert.match(document.body.textContent, new RegExp(user.id))
    assert.match(document.body.textContent, new RegExp(user.tenantId))
    assert.equal(document.querySelector('button[aria-label^="Manage reviewer access"]'), null)
    assert.equal(document.querySelector('button[aria-label^="Rename"]'), null)
    assert.equal(document.querySelector('button[aria-label^="Archive"]'), null)
  }
  assert.equal(requests.length, 0)
})

test('owners add and explicitly remove reviewers using account IDs, display-only labels, and updated ETags', async () => {
  await picker()
  await click('Manage reviewer access for Private workspace')
  await settle(() => document.body.textContent.includes('No reviewer memberships.'))
  assert.match(document.body.textContent, /does not invite accounts or grant application-administrator/)
  await input('Reviewer account ID', reviewerId)
  await input('Display label', '<script>Not an administrator</script>')
  await click('Add reviewer')
  await settle(() => Boolean(document.querySelector(`button[aria-label="Remove reviewer ${reviewerId}"]`)))
  assert.equal(document.querySelector('script'), null, 'Labels render only as escaped display text')
  assert.match(document.body.textContent, /Not an administrator/)
  assert.equal(directoryRefreshes, 2, 'Opening the picker and acknowledging access refresh directory metadata')
  await click(`Remove reviewer ${reviewerId}`)
  assert.equal(requests.filter(item => item.method === 'DELETE').length, 0, 'Removal requires explicit confirmation')
  await click('Confirm removal')
  await settle(() => document.body.textContent.includes('No reviewer memberships.'))
  const writes = requests.filter(item => item.method !== 'GET')
  assert.deepEqual(writes.map(item => item.method), ['POST', 'DELETE'])
  assert.equal(writes[0].init.headers.get('If-Match'), '"access-1"')
  assert.equal(writes[1].init.headers.get('If-Match'), '"access-2"')
  assert.ok(requests.every(item => item.init.cache === 'no-store' && item.init.credentials === 'include' &&
    item.init.headers.get('X-Score-Request') === 'workspace'))
})

test('conflicts and authorization failures clear the access list and never auto-replay a membership mutation', async () => {
  savedAccess.reviewers = [{ objectId: reviewerId, role: 'reviewer', label: 'Private display label' }]
  await picker()
  await click('Manage reviewer access for Private workspace')
  await settle(() => document.body.textContent.includes('Private display label'))
  override = async (_path, init) => init.method === 'POST'
    ? Response.json({ error: { code: 'conflict', message: 'Access changed elsewhere.' } }, { status: 409 }) : undefined
  await input('Reviewer account ID', user.id)
  await click('Add reviewer')
  await settle(() => document.body.textContent.includes('Refresh access before explicitly trying again.'))
  assert.equal(document.body.textContent.includes('Private display label'), false)
  assert.equal(button('Add reviewer').disabled, true)
  assert.equal(requests.filter(item => item.method === 'POST').length, 1)
  override = null
  await click('Refresh access')
  await settle(() => document.body.textContent.includes('Private display label'))
  override = async (_path, init) => init.method === 'DELETE'
    ? Response.json({ error: { code: 'not_found', message: 'Membership no longer available.' } }, { status: 404 }) : undefined
  await click(`Remove reviewer ${reviewerId}`)
  await click('Confirm removal')
  await settle(() => document.body.textContent.includes('Membership no longer available.'))
  assert.equal(document.body.textContent.includes('Private display label'), false)
  assert.equal(requests.filter(item => item.method === 'DELETE').length, 1)
  assert.equal(directoryRefreshes, 2, 'Access loss refreshes the current directory without retaining a private member list')
})

test('a stale in-flight member list cannot remain visible after owner access is lost', async () => {
  let release
  const response = new Promise(resolve => { release = resolve })
  override = async () => response
  await picker()
  await click('Manage reviewer access for Private workspace')
  await settle(() => requests.length === 1)
  cloud = { ...cloud, workspaces: [{ ...metadata, role: 'reviewer' }] }
  await picker()
  await act(async () => release(Response.json({ ...savedAccess, reviewers: [{ objectId: reviewerId, role: 'reviewer', label: 'Private delayed label' }] })))
  assert.equal(document.body.textContent.includes('Private delayed label'), false)
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(requests[0].init.signal.aborted, true)
})

test('reviewer rubric and lifecycle UI remain read-only while retaining saved evidence', async () => {
  const value = frontendWorkspaceContext({ workspace, cloud: { user, currentWorkspaceId: metadata.id, workspaces: [{ ...metadata, role: 'reviewer' }] } })
  const rubric = workspace.rubrics.find(item => item.kind === 'job')
  await render(element(ui.MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    element(ui.WorkspaceContext.Provider, { value }, element(ui.RubricPanel, { rubric }))))
  assert.equal(button('Edit rubric').disabled, true)
  assert.equal(document.querySelector('[aria-label^="Lifecycle actions"]'), null)
  assert.match(document.body.textContent, /Reviewer access/)
  assert.match(document.body.textContent, new RegExp(rubric.criteria[0].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

function provider(props, capture, apiRef) {
  function Probe() { capture.access = ui.useLifecycleAccess(); return null }
  return element(ui.CloudWorkspaceProvider, {
    workspaceId: metadata.id, user, workspaces: [props], apiRef,
    onAuthError: message => assert.fail(message), onSignedOut: () => assert.fail('Unexpected sign out'),
    switchWorkspace: async () => ({ ok: true }), createWorkspace: async () => ({ ok: true }), renameWorkspace: async () => ({ ok: true }),
    refreshWorkspaces: async () => {}, getWorkspaceLifecycleImpact: async () => ({}), changeWorkspaceLifecycle: async () => {},
    leaveUnavailableWorkspace: async () => ({ ok: true }),
    children: (value, cloudValue) => {
      capture.value = value; capture.cloud = cloudValue
      return element(ui.WorkspaceContext.Provider, { value: { ...value, cloud: cloudValue } }, element(Probe))
    },
  })
}

test('cloud reviewer providers reject sample editing and lifecycle calls without autosaving a read', async () => {
  const capture = {}, apiRef = { current: null }
  await render(provider({ ...metadata, role: 'reviewer' }, capture, apiRef))
  await settle(() => Boolean(capture.value))
  assert.equal(capture.access.canEdit, false)
  assert.equal(capture.access.canManage, false)
  for (const mutate of [
    () => capture.value.resetDemo(), () => capture.value.addJobs([], 'pdf'), () => capture.value.addResumes([]),
    () => capture.value.cancelJob(workspace.jobs[0].id), () => capture.value.retryJob(workspace.jobs[0].id),
    () => capture.value.saveRubric(workspace.rubrics[0]), () => capture.value.startAnalysis([], []),
    () => capture.value.cancelRun('run'), () => capture.value.retryRun('run'),
  ]) assert.throws(mutate, /read-only/)
  await assert.rejects(capture.value.renameEntity({ kind: 'job', id: workspace.jobs[0].id }, 'Forbidden'), /read-only/)
  await assert.rejects(capture.value.changeLifecycle({ kind: 'job', id: workspace.jobs[0].id }, 'archive'), /role/)
  await act(async () => { capture.cloud.retrySave(); await apiRef.current.flush() })
  assert.ok(requests.every(item => item.method === 'GET'))
})

test('a role downgrade fences queued sample autosave and conflict overwrite before any network write', async () => {
  const capture = {}, apiRef = { current: null }
  await render(provider({ ...metadata }, capture, apiRef))
  await settle(() => Boolean(capture.value))
  await act(async () => {
    capture.value.resetDemo()
    root.render(provider({ ...metadata, role: 'reviewer' }, capture, apiRef))
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)) })
  assert.equal(capture.access.canEdit, false)
  assert.equal(capture.cloud.saveState, 'conflict')
  assert.equal(apiRef.current.hasPendingChanges(), true, 'Previously editable sample changes are not silently discarded')
  await act(async () => { capture.cloud.retrySave(); await capture.cloud.keepMineAndOverwrite() })
  assert.ok(requests.every(item => item.method === 'GET'), 'No stale autosave or conflict overwrite can issue a write')
  assert.equal((await apiRef.current.flush()).ok, false)
})

test('read-only reviewers still refresh saved sample content when workspace lifecycle metadata changes', async () => {
  const capture = {}, apiRef = { current: null }
  const reviewer = { ...metadata, role: 'reviewer' }
  await render(provider(reviewer, capture, apiRef))
  await settle(() => Boolean(capture.value))
  workspace = structuredClone(workspace)
  workspace.jobs[0].title = 'Updated saved evidence'
  await render(provider({ ...reviewer, archivedAt: '2026-09-22T14:01:00.000Z' }, capture, apiRef))
  await settle(() => capture.value.workspace.jobs[0].title === 'Updated saved evidence')
  assert.equal(capture.access.canEdit, false)
  assert.ok(requests.filter(item => item.path.endsWith('/state')).length >= 2)
  assert.ok(requests.every(item => item.method === 'GET'))
})
