import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { frontendWorkspaceContext } from './frontend.test-support.mjs'

const output = resolve(`.library-view-state-tests-${randomUUID()}`)
const originals = new Map()
const element = React.createElement
let ui, dom, root, createRoot, navigate, location, controls

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export { LibraryViewStateProvider } from './src/app/LibraryViewStateProvider';
    export { useLibraryViewState } from './src/app/library-view-state';
    export { RubricsPage } from './src/features/rubrics/RubricsPage';
    export { WorkspaceContext } from './src/app/workspace-context';
    export { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
  jsx: 'automatic', logLevel: 'silent' })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

beforeEach(() => {
  controls = new Map()
  navigate = null
  location = null
  dom.window.localStorage.clear()
  dom.window.sessionStorage.clear()
})
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null } })
after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

function Probe() { navigate = ui.useNavigate(); location = ui.useLocation(); return null }
function Library({ library = 'jobs', id = 'list' }) {
  const [query, setQuery] = ui.useLibraryViewState(`${library}:query`, '')
  const [archive, setArchive] = ui.useLibraryViewState(`${library}:archive`, 'default')
  const [sort, setSort] = ui.useLibraryViewState(`${library}:sort`, () => ({ key: 'date', direction: 'desc' }))
  const [selected, setSelected] = useState([])
  controls.set(id, { query, archive, sort, selected, setQuery, setArchive, setSort, setSelected })
  return element('output', { 'data-list': id }, query)
}
async function renderTree(tree) {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => root.render(tree))
}
function router(children, url = '/library') {
  return element(ui.MemoryRouter, { initialEntries: [url], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    element(React.Fragment, null, element(Probe), children))
}
async function renderLibrary({ scopeKey = 'tenant:user:one', library = 'jobs', provider = true } = {}) {
  const tree = router(element(ui.Routes, null,
    element(ui.Route, { path: '/library', element: element(Library, { library }) }),
    element(ui.Route, { path: '/detail', element: element('p', null, 'Saved record') })))
  await renderTree(provider ? element(ui.LibraryViewStateProvider, { scopeKey }, tree) : tree)
}
async function go(to) { await act(async () => navigate(to)) }
function state(id = 'list') {
  const { query, archive, sort, selected } = controls.get(id)
  return { query, archive, sort, selected }
}
function noPersistence() {
  assert.equal(dom.window.localStorage.length, 0)
  assert.equal(dom.window.sessionStorage.length, 0)
  assert.equal(location.search, '')
  assert.equal(location.hash, '')
}

test('library Back remount restores search, filters, and sort without retaining selected records', async () => {
  await renderLibrary()
  await act(async () => {
    const list = controls.get('list')
    list.setQuery('private reviewer query')
    list.setArchive('all')
    list.setSort({ key: 'title', direction: 'asc' })
    list.setSelected(['private-source-id'])
  })
  await go('/detail')
  assert.equal(document.querySelector('[data-list]'), null)
  await go(-1)
  assert.deepEqual(state(), { query: 'private reviewer query', archive: 'all', sort: { key: 'title', direction: 'asc' }, selected: [] })
  noPersistence()
})

test('workspace, session, and provider remounts clear tab-only browsing state', async () => {
  await renderLibrary()
  await act(async () => controls.get('list').setQuery('first workspace'))
  await renderLibrary({ scopeKey: 'tenant:user:two' })
  assert.equal(state().query, '')
  await act(async () => controls.get('list').setQuery('second workspace'))
  await renderLibrary({ scopeKey: 'tenant:user:one' })
  assert.equal(state().query, '', 'Returning to a workspace starts a new browsing scope')
  await act(async () => controls.get('list').setQuery('old session'))
  await renderLibrary({ scopeKey: 'tenant:another-user:one' })
  assert.equal(state().query, '')
  await act(async () => controls.get('list').setQuery('before reload'))
  await act(async () => root.unmount())
  root = null
  await renderLibrary({ scopeKey: 'tenant:another-user:one' })
  assert.equal(state().query, '')
  noPersistence()
})

test('functional setters share live state only inside one provider and existing reset values remain usable', async () => {
  const inner = element(React.Fragment, null, element(Library, { id: 'first' }), element(Library, { id: 'second' }))
  await renderTree(element(React.Fragment, null,
    element(ui.LibraryViewStateProvider, { scopeKey: 'one' }, inner),
    element(ui.LibraryViewStateProvider, { scopeKey: 'one' }, element(Library, { id: 'isolated' }))))
  await act(async () => {
    controls.get('first').setQuery((current) => `${current}one`)
    controls.get('second').setQuery((current) => `${current} two`)
    controls.get('first').setSort((current) => ({ ...current, direction: 'asc' }))
  })
  assert.equal(state('first').query, 'one two')
  assert.equal(state('second').query, 'one two')
  assert.equal(state('second').sort.direction, 'asc')
  assert.equal(state('isolated').query, '')
  await act(async () => {
    controls.get('first').setQuery('')
    controls.get('second').setSort({ key: 'date', direction: 'desc' })
  })
  assert.deepEqual(state('first'), { query: '', archive: 'default', sort: { key: 'date', direction: 'desc' }, selected: [] })
})

test('without a provider the hook behaves like isolated component useState and resets on route remount', async () => {
  await renderLibrary({ provider: false })
  await act(async () => {
    controls.get('list').setQuery('first')
    controls.get('list').setQuery((value) => `${value} second`)
  })
  assert.equal(state().query, 'first second')
  await go('/detail')
  await go(-1)
  assert.equal(state().query, '')
  noPersistence()
})

test('rubric library restores its search/archive controls on Back and ignores legacy data query navigation', async () => {
  const rubric = { id: 'rubric-one', groupId: 'group-one', kind: 'job', jobId: 'job-one', name: 'Analyst rubric', description: '', version: 1, criteria: [], createdAt: '2026-09-19T00:00:00.000Z', dataKind: 'real' }
  const workspace = { jobs: [{ id: 'job-one', title: 'Analyst role', status: 'ready', rubricId: rubric.id, dataKind: 'real' }], documents: [], rubrics: [rubric], lifecycle: { entities: { 'job:job-one': {}, 'rubric:group-one': { parentKey: 'job:job-one' } } } }
  const context = frontendWorkspaceContext({ workspace, cloud: { currentWorkspaceId: 'one' } })
  const legacyQuery = new URLSearchParams({ kind: 'job', data: 'samples' }).toString()
  const tree = router(element(ui.WorkspaceContext.Provider, { value: context },
    element(ui.Routes, null,
      element(ui.Route, { path: '/rubrics', element: element(ui.RubricsPage) }),
      element(ui.Route, { path: '/rubrics/:id', element: element('p', null, 'Rubric details') }))), `/rubrics?${legacyQuery}`)
  await renderTree(element(ui.LibraryViewStateProvider, { scopeKey: 'tenant:user:one' }, tree))
  const search = () => document.querySelector('input[type="search"]')
  const archive = () => document.querySelector('select[aria-label="Rubric archive state"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(search(), 'analyst')
    search().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    archive().value = 'all'
    archive().dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await go(`/rubrics/${rubric.id}`)
  await go(-1)
  assert.equal(search().value, 'analyst')
  assert.equal(archive().value, 'all')
  assert.equal(location.search, `?${legacyQuery}`)
  await go('/rubrics?kind=job&data=real')
  assert.equal(search().value, 'analyst')
  assert.equal(archive().value, 'all')
  assert.equal(dom.window.localStorage.length, 0)
  assert.equal(dom.window.sessionStorage.length, 0)
})
