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

const output = resolve(`.sidebar-frontend-tests-${randomUUID()}`)
const originals = new Map()
const h = React.createElement
const pause = () => new Promise(resolve => setTimeout(resolve, 10))
const timestamp = '2026-01-01T00:00:00.000Z'
let ui, dom, root, createRoot, calls, requests, storage

function testWorkspace() {
  return {
    documents: [{ id: 'document-one', title: 'Captured source', kind: 'job', version: 1, sample: false, paragraphs: [
      { id: 'paragraph-one', page: 1, heading: 'Duties', text: 'Captured source evidence supports this review.' },
    ] }],
    jobs: [{ id: 'job-one', title: 'Program analyst', organization: 'Agency', location: 'Remote', arrangement: 'Remote',
      employmentType: 'Full-time', grade: 'GS-13', series: '0343', source: 'pdf', sourceLabel: 'Captured job.pdf',
      documentId: 'document-one', rubricId: 'rubric-one', status: 'ready', createdAt: timestamp, dataKind: 'real' }],
    rubrics: [{ id: 'rubric-one', groupId: 'rubric-group-one', kind: 'job', jobId: 'job-one', name: 'Job rubric',
      description: 'Measures the role.', version: 1, createdAt: timestamp, dataKind: 'real',
      criteria: [{ id: 'criterion-one', key: 'technical', label: 'Evidence', description: 'Uses evidence.',
        guidance: 'Check exact source evidence.', weight: 100, requirementType: 'required' }] }],
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
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  originals.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'))
  dom.window.matchMedia = globalThis.matchMedia
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export { App } from './src/app/App'
    export { WorkspaceContext } from './src/app/workspace-context'
    export { PublicSettingsContext } from './src/app/public-settings-context'
    export { ApplicationNavigationContext } from './src/app/application-navigation-context'
    export { createDefaultAdminSettings } from './src/domain/admin-settings-defaults'
    export { projectPublicSettings, captureProcessingSettings } from './src/domain/admin-settings-resolver'
    export { MemoryRouter } from 'react-router-dom'
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
  jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})
beforeEach(() => {
  calls = []; requests = []; storage = dom.window.localStorage
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage })
  storage.clear()
  globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({ error: { code: 'not_found', message: 'Unexpected sidebar request.' } }, { status: 404 }) }
})
afterEach(async () => {
  if (root) { await act(async () => { root.unmount(); await pause() }); root = null }
  assert.deepEqual(requests, [], 'The sidebar never reads server state of its own')
})
after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  await rm(output, { recursive: true, force: true })
})

function Shell({ admin = true, help = true, application = true, title }) {
  const settings = ui.createDefaultAdminSettings()
  if (help) { settings.help.supportUrl = 'https://agency.example/support'; settings.help.documentationUrl = 'https://agency.example/help' }
  if (title) settings.appearance.applicationTitle = title
  const policy = { settings: ui.projectPublicSettings(ui.captureProcessingSettings(settings, 'revision-1', timestamp)), phase: 'ready', error: null, cloud: true, refresh: async () => {} }
  const navigation = { applicationAdmin: admin, workspaceHomePath: '/', directoryError: null,
    openAdminSettings: async () => { calls.push('settings') }, openAdminUsers: async () => { calls.push('users') }, openWorkspaceHome: async () => { calls.push('home') } }
  return h(ui.PublicSettingsContext.Provider, { value: policy },
    h(ui.WorkspaceContext.Provider, { value: frontendWorkspaceContext({ workspace: testWorkspace() }) },
      h(ui.ApplicationNavigationContext.Provider, { value: application ? navigation : null },
        h(ui.MemoryRouter, { initialEntries: ['/jobs'], future: { v7_startTransition: true, v7_relativeSplatPath: true } }, h(ui.App)))))
}
async function render(props = {}) {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => { root.render(h(Shell, props)); await pause() })
}
async function remount(props) {
  await act(async () => { root.unmount(); await pause() }); root = null
  await render(props)
}
const sidebar = () => document.querySelector('aside.sidebar')
const toggle = () => document.querySelector('.sidebar-toggle')
const items = (within = sidebar()) => [...within.querySelectorAll('.nav-item')]
function button(text, within = document) {
  const found = [...within.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent.trim()) === text)
  assert.ok(found, `Button "${text}" exists`)
  return found
}
async function click(node) { await act(async () => { node.click(); await pause() }) }

test('the collapse toggle persists, keeps accessible names and focus, and restores on the first render', async () => {
  await render()
  assert.equal(sidebar().id, 'primary-navigation')
  assert.equal(sidebar().classList.contains('is-collapsed'), false)
  const control = toggle()
  assert.deepEqual([control.type, control.getAttribute('aria-label'), control.getAttribute('aria-expanded'), control.getAttribute('aria-controls'), control.title],
    ['button', 'Collapse navigation', 'true', 'primary-navigation', 'Collapse navigation'])
  assert.equal(items().filter(item => item.hasAttribute('title')).length, 0, 'Expanded items have no tooltips')
  control.focus()
  await click(control)
  assert.equal(toggle(), control, 'The same toggle element is repositioned rather than replaced')
  assert.equal(document.activeElement, control)
  assert.deepEqual([control.getAttribute('aria-label'), control.getAttribute('aria-expanded'), control.title], ['Expand navigation', 'false', 'Expand navigation'])
  assert.equal(sidebar().classList.contains('is-collapsed'), true)
  assert.equal(storage.getItem('score-sidebar-collapsed'), 'true')

  // Labels stay in the DOM, so names and existing lookups keep working.
  assert.ok(button('All workspaces', sidebar()))
  assert.ok(button('Application settings', sidebar()))
  assert.ok(button('Users / user access', sidebar()))
  assert.ok(button('Sign out', sidebar()))
  assert.ok(sidebar().querySelector('a[aria-label="Score home"]'))
  const nav = sidebar().querySelector('nav[aria-label="Main navigation"]')
  assert.deepEqual([...nav.querySelectorAll('a')].map(link => [link.textContent, link.title]),
    [['Jobs1', 'Jobs · 1'], ['Resumes0', 'Resumes · 0'], ['Rubrics1', 'Rubrics · 1'], ['Analyses0', 'Analyses · 0']])
  assert.deepEqual(items().filter(item => !item.closest('nav')).map(item => [item.textContent.trim(), item.title]), [
    ['All workspaces', 'All workspaces'], ['Application settings', 'Application settings'], ['Users / user access', 'Users / user access'],
    ['About Score', 'About Score'], ['Support', 'Support'], ['Documentation', 'Documentation']])
  assert.equal(sidebar().querySelector('a[aria-label="Score home"]').title, 'Score home')
  assert.equal(sidebar().querySelector('.workspace-switcher-trigger').title, 'Fixture workspace\nOwner · cloud')
  assert.equal(sidebar().querySelector('.account-panel .avatar').title, 'Fixture reviewer\nreviewer@example.test')

  await remount()
  assert.equal(sidebar().classList.contains('is-collapsed'), true, 'The saved preference is read on the first render')
  assert.equal(toggle().getAttribute('aria-expanded'), 'false')
  await click(toggle())
  assert.equal(sidebar().classList.contains('is-collapsed'), false)
  assert.equal(storage.getItem('score-sidebar-collapsed'), 'false')
  assert.equal(toggle().getAttribute('aria-label'), 'Collapse navigation')
  assert.equal(items().filter(item => item.hasAttribute('title')).length, 0, 'Tooltips are removed after expanding')
  assert.equal(sidebar().querySelector('.workspace-switcher-trigger').hasAttribute('title'), false)
  await remount()
  assert.equal(sidebar().classList.contains('is-collapsed'), false)
})

test('an unavailable preference store never blocks collapsing for the visit', async () => {
  const blocked = () => { throw new DOMException('Storage is disabled.', 'SecurityError') }
  const warnings = []
  const warn = console.warn
  console.warn = (...values) => { warnings.push(values[0]) }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked } })
  try {
    await render()
    assert.equal(sidebar().classList.contains('is-collapsed'), false, 'An unreadable preference defaults to expanded')
    await click(toggle())
    assert.equal(sidebar().classList.contains('is-collapsed'), true)
    await click(toggle())
    assert.equal(sidebar().classList.contains('is-collapsed'), false)
    assert.ok(warnings.includes('The navigation preference could not be loaded.'))
    assert.equal(warnings.filter(message => message === 'The navigation preference applies to this visit only; it could not be saved.').length, 2)
  } finally { console.warn = warn }
})

test('administration, About, and configured help share the navigation item styling at the bottom of the sidebar', async () => {
  await render()
  const links = sidebar().querySelector('.sidebar-links')
  assert.ok(links && sidebar().querySelector('.sidebar-scroll').lastElementChild === links, 'The group follows the main navigation')
  assert.deepEqual(items(links).map(item => [item.tagName, item.textContent.trim(), Boolean(item.querySelector('svg')), Boolean(item.querySelector('.nav-label'))]), [
    ['BUTTON', 'Application settings', true, true], ['BUTTON', 'Users / user access', true, true], ['BUTTON', 'About Score', true, true],
    ['A', 'Support', true, true], ['A', 'Documentation', true, true]])
  assert.equal(links.querySelector('.button'), null, 'Bottom items do not use the smaller Button component styling')
  for (const [href, name] of [['https://agency.example/support', 'Support'], ['https://agency.example/help', 'Documentation']]) {
    const link = links.querySelector(`a[href="${href}"]`)
    assert.deepEqual([link?.textContent, link?.target, link?.rel], [name, '_blank', 'noopener noreferrer'])
  }
  await click(button('Application settings', links))
  await click(button('Users / user access', links))
  await click(button('All workspaces', sidebar()))
  assert.deepEqual(calls, ['settings', 'users', 'home'])

  await click(button('About Score', links))
  const about = [...document.querySelectorAll('[role="dialog"]')].find(item => item.querySelector('h2')?.textContent === 'About Score')
  assert.ok(about, 'About opens from the sidebar')
  assert.match(about.textContent, /How it works, current limits, and privacy/)
  assert.doesNotMatch(about.textContent, /UI preview|interactive preview|clearer way to see the fit/i)
  await click(button('Back to the workspace', about))

  await remount({ admin: false, help: false, title: 'Agency evidence' })
  assert.deepEqual(items(sidebar().querySelector('.sidebar-links')).map(item => item.textContent.trim()), ['About Agency evidence'])
  assert.equal(document.querySelector('a[href^="https://agency.example"]'), null)
  assert.ok(!document.body.textContent.includes('Application settings') && !document.body.textContent.includes('Users / user access'))
  await click(button('About Agency evidence'))
  assert.ok([...document.querySelectorAll('[role="dialog"] h2')].some(item => item.textContent === 'About Agency evidence'))
})

test('the retired note, preview labels, and duplicate QC entry points are absent', async () => {
  await render()
  const text = document.body.textContent
  for (const removed of [/Evidence, not impressions/i, /Traceable matches/i, /About this (preview|application)/i, /UI preview/i, /Enter QC mode/i]) {
    assert.doesNotMatch(text, removed)
  }
  assert.equal(document.querySelector('.about-chip, .sidebar-note, .sidebar-version, .workspace-home-nav'), null)
  assert.deepEqual([...document.querySelectorAll('.topbar-actions button')].map(item => item.textContent.trim()), ['QC mode', 'New analysis'])
  await click(button('Open navigation'))
  const drawer = [...document.querySelectorAll('[role="dialog"]')].find(item => item.querySelector('h2')?.textContent === 'Your workspace')
  assert.ok(button('All workspaces', drawer))
  assert.doesNotMatch(drawer.textContent, /Enter QC mode/)
  assert.deepEqual(items(drawer.querySelector('.sidebar-links')).map(item => item.textContent.trim()),
    ['Application settings', 'Users / user access', 'About Score', 'Support', 'Documentation'])
  assert.equal(drawer.querySelector('.nav-item[title]'), null)
})
