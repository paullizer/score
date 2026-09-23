import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'

const output = resolve(`.workspace-home-tests-${randomUUID()}`)
const originals = new Map()
const element = React.createElement
const pause = (milliseconds = 10) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const identity = { id: 'reviewer', tenantId: 'tenant', name: 'Fixture reviewer', email: 'reviewer@example.test' }
const metadata = (id = 'workspace-one', name = 'Research') => ({
  id, name, role: 'owner', kind: 'personal', etag: `"${id}-1"`,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const counts = (id, jobs = 3) => ({ workspaceId: id, jobs: { status: 'ready', count: jobs }, resumes: { status: 'ready', count: 4 }, analyses: { status: 'ready', count: 5 } })
const json = (body, status = 200) => Response.json(body, { status })
const failure = (message, status = 503) => json({ error: { code: status === 401 ? 'unauthorized' : 'unavailable', message } }, status)
const recentKey = 'score-cloud-recent-workspaces:tenant:reviewer'
let ui, dom, root, createRoot, requests, settings, workspaces, workspace, override, unexpected

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function testWorkspace() {
  return {
    documents: [{ id: 'document-one', title: 'Position description', kind: 'job', version: 1, sample: false, paragraphs: [
      { id: 'paragraph-one', page: 1, heading: 'Duties', text: 'Real source evidence.' },
    ] }],
    jobs: [{ id: 'job-one', title: 'Program analyst', organization: 'Agency', location: 'Remote', arrangement: 'Remote',
      employmentType: 'Full-time', grade: 'GS-13', series: '0343', source: 'pdf', sourceLabel: 'Position description.pdf',
      documentId: 'document-one', rubricId: 'rubric-one', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', dataKind: 'real' }],
    rubrics: [{ id: 'rubric-one', groupId: 'rubric-group-one', kind: 'job', jobId: 'job-one', name: 'Job rubric',
      description: 'Measures the role.', version: 1, createdAt: '2026-01-01T00:00:00.000Z', dataKind: 'real',
      criteria: [{ id: 'criterion-one', key: 'technical', label: 'Evidence', description: 'Uses evidence.',
        guidance: 'Check exact source evidence.', weight: 100, requirementType: 'required',
        sourceCitations: [{ documentId: 'document-one', documentVersion: 1, paragraphId: 'paragraph-one',
          page: 1, heading: 'Duties', quote: 'Real source evidence' }] }] }],
    lifecycle: { entities: {} },
  }
}

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent',
    'PopStateEvent', 'DocumentFragment', 'localStorage']) {
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
      export { useWorkspaceCounts } from './src/features/workspaces/useWorkspaceCounts';
      export { fetchWorkspaceCounts } from './src/services/workspaceSummaries';
      export { createDefaultAdminSettings } from './src/domain/admin-settings-defaults';
      export { captureProcessingSettings, projectPublicSettings } from './src/domain/admin-settings-resolver';
    ` },
    outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
  })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

beforeEach(() => {
  requests = []; unexpected = []; override = null; workspaces = [metadata()]
  settings = ui.createDefaultAdminSettings(); workspace = testWorkspace()
  dom.window.localStorage.clear()
  dom.window.history.replaceState(null, '', '/')
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url, 'https://score.test').pathname
    const method = init.method ?? 'GET'
    requests.push({ path, method, init })
    const custom = await override?.(path, init)
    if (custom !== undefined) return custom
    if (path === '/api/features') return json({
      realJobImports: true, realGradeLadders: true, realResumeImports: true, realAnalyses: true,
      markdownJobImports: true, markdownResumeImports: true, wordDocumentImports: true,
      publicSettings: ui.projectPublicSettings(ui.captureProcessingSettings(settings, 'revision-one', '2026-01-01T00:00:00.000Z')),
    })
    if (path === '/api/session' || path === '/api/session/identity') return json({ mode: 'cloud', user: identity, workspaces, capabilities: { applicationAdmin: false, canCreateWorkspaces: true } })
    if (path === '/api/workspaces') {
      if (method === 'POST') {
        const created = metadata(`workspace-${workspaces.length + 1}`, JSON.parse(init.body).name)
        workspaces = [...workspaces, created]
        return json({ workspace: created }, 201)
      }
      return json({ workspaces })
    }
    const summary = /^\/api\/workspaces\/([^/]+)\/summary$/.exec(path)
    if (summary) return json(counts(summary[1]))
    if (path.endsWith('/state')) throw new Error(`Workspace state API must not be used: ${method} ${path}`)
    if (path.endsWith('/jobs')) return json({ jobs: [] })
    if (path.endsWith('/resumes')) return json({ resumes: [] })
    if (path.endsWith('/grade-ladders')) return json({ ladders: [] })
    if (path.endsWith('/analyses/targets')) return json({ targets: [] })
    if (path.endsWith('/analyses')) return json({ runs: [] })
    const lifecycle = /^\/api\/workspaces\/([^/]+)\/lifecycle$/.exec(path)
    if (lifecycle) {
      const item = workspaces.find((value) => value.id === lifecycle[1])
      if (method === 'GET') return json({ impact: { target: { kind: 'workspace', id: item.id }, name: item.name, counts: {}, blockers: [] } })
      const { action } = JSON.parse(init.body)
      if (action === 'delete') { workspaces = workspaces.filter((value) => value !== item); return json({ deleted: true }) }
      const updated = { ...item, archivedAt: action === 'archive' ? '2026-01-01T00:00:00.000Z' : undefined, etag: '"changed"' }
      workspaces = workspaces.map((value) => value === item ? updated : value)
      return json({ workspace: updated })
    }
    unexpected.push(`${method} ${path}`)
    throw new Error(`Unexpected fixture request: ${method} ${path}`)
  }
})

afterEach(async () => {
  if (root) { await act(async () => { root.unmount(); await pause() }); root = null }
  assert.deepEqual(unexpected, [])
})
after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

async function until(check, message) {
  for (let index = 0; index < 300; index++) {
    if (check()) return
    await act(async () => { await pause() })
  }
  assert.fail(message)
}
async function render(node = element(ui.CloudApplication)) {
  root = createRoot(document.getElementById('root'))
  await act(async () => { root.render(node); await pause() })
}
function button(name, scope = document) {
  return [...scope.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === name || item.textContent.trim() === name)
}
function dialog(name) {
  return [...document.querySelectorAll('[role="dialog"]')].find((item) =>
    document.getElementById(item.getAttribute('aria-labelledby'))?.textContent === name)
}
async function click(target) {
  assert.ok(target, 'The requested control exists')
  assert.equal(target.disabled, false, 'The requested control is enabled')
  await act(async () => { target.click(); await pause() })
}
async function edit(input, value) {
  assert.ok(input)
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    await pause()
  })
}
const privateReads = () => requests.filter((item) => /\/workspaces\/[^/]+\/(?:state|jobs|resumes|analyses|grade-ladders)(?:\/|$)/.test(item.path))
const isHome = () => Boolean(document.querySelector('.workspace-home'))

for (const count of [0, 1, 3]) test(`root shows workspace home with ${count} workspaces, never an automatic selection`, async () => {
  workspaces = Array.from({ length: count }, (_, index) => metadata(`workspace-${index}`, `Workspace ${index}`))
  localStorage.setItem('score-cloud-last-workspace:tenant:reviewer', 'workspace-0')
  await render()
  await until(isHome, 'Workspace home loads')
  await until(() => requests.filter((item) => item.path === '/api/session').length > 1, 'Directory and capability refresh is complete')
  assert.equal(location.pathname, '/')
  assert.equal(document.querySelectorAll('.workspace-home-card').length, count)
  assert.ok(button('New workspace'))
  assert.equal(document.querySelector('.sidebar'), null)
  assert.equal(button('New analysis'), undefined)
  assert.equal(privateReads().length, 0)
  assert.ok(JSON.parse(localStorage.getItem(recentKey)).entries.every((entry) => entry.lastOpenedAt === null))
})

for (const path of ['/workspaces', '/workspaces/', '/jobs']) test(`${path} is a home entry, not an implicit workspace selection`, async () => {
  dom.window.history.replaceState(null, '', path)
  await render(); await until(isHome, 'Workspace home loads')
  assert.equal(location.pathname, '/')
  assert.equal(privateReads().length, 0)
})

test('selecting and returning home honors the workspace start page, host theme, recents, and browser history', async () => {
  workspaces = [metadata(), metadata('workspace-two', 'Hiring')]
  settings.navigation.defaultPage = 'resumes'
  dom.window.history.replaceState(null, '', '/?scoutTheme=dark')
  await render(); await until(isHome, 'Home loads')
  await click(button('Research'))
  await until(() => document.querySelector('.sidebar'), 'Selected workspace opens')
  assert.equal(location.pathname, '/workspaces/workspace-one/resumes')
  assert.equal(new URLSearchParams(location.search).get('scoutTheme'), 'dark')
  const saved = JSON.parse(localStorage.getItem(recentKey)).entries
  assert.equal(saved[0].id, 'workspace-one')
  assert.ok(Number.isFinite(Date.parse(saved[0].lastOpenedAt)))
  assert.ok(privateReads().every((item) => item.path.includes('/workspace-one/')))
  await click(button('All workspaces'))
  await until(isHome, 'All workspaces returns home')
  assert.equal(location.pathname, '/')
  assert.equal(new URLSearchParams(location.search).get('scoutTheme'), 'dark')
  assert.ok(button('Open recent workspace Research'))
  await act(async () => { window.history.back(); await pause() })
  await until(() => document.querySelector('.sidebar'), 'Back restores the selected workspace')
  assert.equal(location.pathname, '/workspaces/workspace-one/resumes')
  await act(async () => { window.history.forward(); await pause() })
  await until(isHome, 'Forward restores home')
})

test('deep links keep their record, query, and fragment while invalid links never select a different workspace', async () => {
  const path = `/workspaces/workspace-one/jobs/${workspace.jobs[0].id}?scoutTheme=dark#source`
  dom.window.history.replaceState(null, '', path)
  await render()
  await until(() => document.querySelector('.sidebar'), 'Bookmarked workspace opens directly')
  assert.equal(location.pathname + location.search + location.hash, path)
  assert.equal(isHome(), false)
  await act(async () => { root.unmount(); await pause() }); root = null
  requests = []
  dom.window.history.replaceState(null, '', '/workspaces/inaccessible/jobs')
  await render()
  await until(() => document.body.textContent.includes('This workspace is unavailable'), 'Invalid workspace stays explicit')
  assert.equal(privateReads().length, 0)
  await click(button('Go to my workspaces'))
  await until(isHome, 'Unavailable link can return home')
  assert.equal(location.pathname, '/')
})

test('creation is prominent, retains a failed name, and enters only the acknowledged new workspace', async () => {
  let fail = true
  override = (path, init) => path === '/api/workspaces' && init.method === 'POST' && fail ? failure('Creation is temporarily unavailable.') : undefined
  await render(); await until(isHome, 'Home loads')
  await click(button('New workspace'))
  const input = document.querySelector('input[aria-label="New workspace name"]')
  assert.equal(input.maxLength, 80)
  assert.equal(button('Create', dialog('New workspace')).disabled, true)
  await edit(input, '  New review  ')
  await click(button('Create', dialog('New workspace')))
  assert.ok(dialog('New workspace'))
  assert.match(dialog('New workspace').textContent, /Creation is temporarily unavailable/)
  assert.equal(input.value, '  New review  ')
  assert.equal(location.pathname, '/')
  fail = false
  await click(button('Create', dialog('New workspace')))
  await until(() => document.querySelector('.sidebar'), 'Acknowledged workspace opens')
  assert.equal(location.pathname, '/workspaces/workspace-2/jobs')
  assert.equal(workspaces.at(-1).name, 'New review')
  assert.equal(requests.filter((item) => item.method === 'POST').length, 2)
  assert.equal(JSON.parse(localStorage.getItem(recentKey)).entries[0].id, 'workspace-2')
})

test('creation policy and archived-only directories stay usable without false active totals', async () => {
  settings.workspaces.allowCreation = false
  workspaces = [{ ...metadata(), archivedAt: '2026-01-01T00:00:00.000Z', role: 'viewer' }]
  await render(); await until(isHome, 'Archived-only home loads')
  assert.equal(button('New workspace').disabled, true)
  assert.ok(button('Research'))
  assert.equal(button('Rename Research'), undefined)
  assert.match(document.body.textContent, /Archived.*read only/)
  assert.equal(requests.filter((item) => item.path.endsWith('/summary')).length, 0)
  await click(button('Research'))
  await until(() => document.querySelector('.sidebar'), 'Archived content can still open')
})

test('a pending creation cannot be submitted twice or abandoned through in-app history', async () => {
  const creation = deferred()
  dom.window.history.replaceState(null, '', '/workspaces/workspace-one/jobs')
  dom.window.history.pushState(null, '', '/')
  override = (path, init) => path === '/api/workspaces' && init.method === 'POST' ? creation.promise : undefined
  await render(); await until(isHome, 'Home loads')
  await click(button('New workspace'))
  await edit(document.querySelector('input[aria-label="New workspace name"]'), 'Pending review')
  await click(button('Create', dialog('New workspace')))
  assert.equal(button('Creating…', dialog('New workspace')).disabled, true)
  await act(async () => {
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    window.history.back()
    await pause(30)
  })
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1)
  assert.equal(location.pathname, '/')
  assert.ok(dialog('New workspace'))
  const unload = new dom.window.Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  assert.equal(unload.defaultPrevented, true)
  const created = metadata('created-workspace', 'Pending review')
  workspaces = [...workspaces, created]
  await act(async () => { creation.resolve(json({ workspace: created }, 201)); await pause() })
  await until(() => document.querySelector('.sidebar'), 'Acknowledged creation opens normally')
  assert.equal(location.pathname, '/workspaces/created-workspace/jobs')
})

test('home navigation protects dirty drafts with explicit stay and discard choices', async () => {
  dom.window.history.replaceState(null, '', '/workspaces/workspace-one/grade-ladders/new')
  await render()
  const input = () => document.querySelector('input[placeholder="A recognizable role or specialty"]')
  await until(input, 'Grade editor opens')
  await edit(input(), 'Do not lose this draft')
  await click(button('All workspaces'))
  assert.ok(dialog('Unsaved changes'))
  await click(button('Stay here', dialog('Unsaved changes')))
  assert.equal(input().value, 'Do not lose this draft')
  assert.equal(location.pathname, '/workspaces/workspace-one/grade-ladders/new')
  await act(async () => { document.querySelector('a.brand').click(); await pause() })
  assert.ok(dialog('Unsaved changes'), 'The brand uses the same protected home navigation')
  await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
  await until(isHome, 'Explicit discard returns home')
  assert.equal(requests.filter((item) => item.method === 'POST').length, 0)
})

test('browser back to home preserves a dirty workspace and resolves a stay decision only once', async () => {
  dom.window.history.replaceState(null, '', '/')
  dom.window.history.pushState(null, '', '/workspaces/workspace-one/grade-ladders/new')
  await render()
  const input = () => document.querySelector('input[placeholder="A recognizable role or specialty"]')
  await until(input, 'Editor opens')
  await edit(input(), 'A draft kept on browser Back')
  await act(async () => { window.history.back(); await pause(30) })
  await until(() => dialog('Unsaved changes'), 'Cross-workspace history is guarded')
  await click(button('Stay here', dialog('Unsaved changes')))
  await until(() => !dialog('Unsaved changes'), 'Stay dismisses the guard without reopening it')
  assert.equal(location.pathname, '/workspaces/workspace-one/grade-ladders/new')
  assert.equal(input().value, 'A draft kept on browser Back')
  await act(async () => { window.history.back(); await pause(30) })
  await until(() => dialog('Unsaved changes'), 'Another attempt can be explicitly discarded')
  await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
  await until(isHome, 'Discard completes browser Back to home')
})

test('workspace counts are real-only, failure is not zero, and retry does not reload other successful cards', async () => {
  workspaces = [metadata(), metadata('workspace-two', 'Hiring')]
  let fail = true
  override = (path) => path === '/api/workspaces/workspace-one/summary' && fail ? failure('Counts unavailable for Research.') : undefined
  await render()
  await until(() => button('Retry counts'), 'Count failure is explicit')
  await until(() => document.querySelectorAll('.workspace-card-counts dd').length === 3, 'Other card counts are ready')
  assert.equal(privateReads().length, 0)
  const otherReads = requests.filter((item) => item.path === '/api/workspaces/workspace-two/summary').length
  fail = false
  await click(button('Retry counts'))
  await until(() => document.querySelectorAll('.workspace-card-counts dd').length === 6 && !button('Retry counts'), 'Retry loads only missing counts')
  assert.deepEqual([...document.querySelectorAll('.workspace-card-counts dd')].map((item) => item.textContent), ['3', '4', '5', '3', '4', '5'])
  assert.equal(requests.filter((item) => item.path === '/api/workspaces/workspace-two/summary').length, otherReads)
})

test('card-count client rejects wrong-workspace, negative, fractional, and malformed success responses', async () => {
  for (const response of [
    counts('workspace-two'), counts('workspace-one', -1), counts('workspace-one', 1.5),
    { ...counts('workspace-one'), resumes: { status: 'unavailable', message: '' } }, { workspaceId: 'workspace-one' },
  ]) {
    override = () => json(response)
    await assert.rejects(ui.fetchWorkspaceCounts('workspace-one'), /invalid workspace counts/)
  }
})

test('count loading is bounded, cancels on scope change, and never publishes an old account response', async () => {
  let outstanding = 0, maximum = 0, observed
  const pending = []
  override = (path, init) => path.endsWith('/summary') ? new Promise((resolve, reject) => {
    outstanding++; maximum = Math.max(maximum, outstanding)
    let settled = false
    const complete = (value, error) => {
      if (settled) return
      settled = true; outstanding--
      if (error) reject(error)
      else resolve(value)
    }
    init.signal.addEventListener('abort', () => complete(undefined, init.signal.reason), { once: true })
    pending.push({ path, complete })
  }) : undefined
  const items = Array.from({ length: 9 }, (_, index) => metadata(`workspace-${index}`))
  const ids = items.map((item) => item.id)
  function Probe({ scope, items, ids }) {
    observed = ui.useWorkspaceCounts(scope, items, ids, 0, (message) => { throw new Error(message) })
    return null
  }
  await render(element(Probe, { scope: 'account-one', items, ids }))
  await until(() => outstanding === 4, 'Only four summary requests start')
  const replacement = [metadata('another-account-workspace')]
  await act(async () => {
    root.render(element(Probe, { scope: 'account-two', items: replacement, ids: replacement.map((item) => item.id) }))
    await pause()
  })
  await until(() => outstanding === 1, 'Previous scope requests are cancelled')
  const current = pending.at(-1)
  await act(async () => { current.complete(json(counts('another-account-workspace', 8))); await pause() })
  await until(() => observed.states['another-account-workspace']?.status === 'ready', 'New scope publishes its own summary')
  assert.deepEqual(Object.keys(observed.states), ['another-account-workspace'])
  assert.equal(observed.states['another-account-workspace'].value.jobs.count, 8)
  assert.ok(maximum <= 4)
})

test('directory refresh failures stay explicit and retry preserves access without a content fallback', async () => {
  let fail = true
  override = (path) => path === '/api/session' && requests.filter(item => item.path === '/api/session').length > 1 && fail ? failure('Directory refresh failed.') : undefined
  await render()
  await until(() => button('Retry workspace list'), 'Refresh failure is visible')
  assert.ok(button('Research'))
  assert.equal(privateReads().length, 0)
  fail = false
  await click(button('Retry workspace list'))
  await until(() => !button('Retry workspace list'), 'Directory retry clears its error')
})

test('count requests and cached results are fenced across role changes, implicit-admin changes, and revoked membership', async () => {
  let observed
  const stale = deferred()
  const first = { ...metadata(), accessSource: 'application-admin' }
  const ids = [first.id]
  let items = [first]
  let firstRead = true
  let jobs = 8
  override = path => {
    if (!path.endsWith('/summary')) return
    if (firstRead) { firstRead = false; return stale.promise }
    return json(counts(first.id, jobs))
  }
  function Probe({ items }) {
    observed = ui.useWorkspaceCounts('same-account', items, ids, 0, message => { throw new Error(message) })
    return null
  }
  await render(element(Probe, { items }))
  await until(() => requests.some(item => item.path.endsWith('/summary')), 'Initial counts are pending')
  items = [{ ...first, accessSource: 'membership' }]
  await act(async () => { root.render(element(Probe, { items })); await pause() })
  await until(() => observed.states[first.id]?.status === 'ready', 'A changed access source gets a fresh count response')
  await act(async () => { stale.resolve(json(counts(first.id, 99))); await pause() })
  assert.equal(observed.states[first.id].value.jobs.count, 8)
  jobs = 9
  items = [{ ...first, role: 'viewer', accessSource: 'membership' }]
  await act(async () => { root.render(element(Probe, { items })); await pause() })
  await until(() => observed.states[first.id]?.value?.jobs.count === 9, 'Role changes invalidate unchanged metadata ETags')
  await act(async () => { root.render(element(Probe, { items: [] })); await pause() })
  assert.deepEqual(observed.states, {})
  jobs = 10
  await act(async () => { root.render(element(Probe, { items })); await pause() })
  await until(() => observed.states[first.id]?.value?.jobs.count === 10, 'Restored membership never reuses a revoked cache entry')
  assert.equal(requests.filter(item => item.path.endsWith('/summary')).length, 4)
})
