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

const output = resolve(`.navigation-protection-tests-${randomUUID()}`)
const originals = new Map()
const element = React.createElement
const apiRef = { current: null }
let ui, dom, root, createRoot, navigate, location, saved, saveCalls

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const pause = (milliseconds = 10) => new Promise((resolve) => setTimeout(resolve, milliseconds))

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'PopStateEvent',
    'DocumentFragment', 'localStorage']) {
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
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export { GradeNavigationProtectionProvider, GradeRouterProtection } from './src/app/GradeNavigationProtection';
    export { useGradeLeaveGuard } from './src/app/grade-navigation-context';
    export { RubricEditor } from './src/features/rubrics/RubricEditor';
    export { App } from './src/app/App';
    export { WorkspaceContext } from './src/app/workspace-context';
    export { createInitialWorkspace } from './src/data/fixtures';
    export { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
  jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

beforeEach(() => { saveCalls = []; saved = []; navigate = null; location = null; dom.window.localStorage.clear() })
afterEach(async () => {
  if (root) { await act(async () => { root.unmount(); await pause() }); root = null }
})
after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

function Probe() { navigate = ui.useNavigate(); location = ui.useLocation(); return null }
function EditorHost({ rubric }) {
  const [open, setOpen] = useState(true)
  return open ? element(ui.RubricEditor, { rubric, onClose: () => setOpen(false), onSaved: (id) => { saved.push(id); setOpen(false) } })
    : element('p', null, 'Editor closed')
}
async function renderTree(tree) {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => { root.render(tree); await pause() })
}
function contextFor(save = () => 'saved-rubric', cloud = false) {
  const workspace = ui.createInitialWorkspace()
  return frontendWorkspaceContext({
    workspace,
    ...(cloud ? { cloud: { currentWorkspaceId: 'workspace-one' } } : {}),
    saveRubric: (draft) => { saveCalls.push(structuredClone(draft)); return save(draft) },
  })
}
async function renderEditor({ cloud = false, save, historyIndexes = true } = {}) {
  const context = contextFor(save, cloud)
  const rubric = context.workspace.rubrics[0]
  const prefix = cloud ? '/workspaces/workspace-one' : ''
  const path = `${prefix}/rubrics/${rubric.id}`
  dom.window.history.replaceState(historyIndexes ? { idx: 0 } : null, '', `${prefix}/jobs`)
  dom.window.history.pushState(historyIndexes ? { idx: 1 } : null, '', path)
  await renderTree(element(ui.GradeNavigationProtectionProvider, {
    workspaceId: 'workspace-one', ...(cloud ? {} : { routePrefix: '/' }), apiRef,
  }, element(ui.BrowserRouter, { basename: prefix || '/', future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    element(ui.GradeRouterProtection, null, element(ui.WorkspaceContext.Provider, { value: context },
      element(Probe),
      element(ui.Routes, null,
        element(ui.Route, { path: '/rubrics/:id', element: element(EditorHost, { rubric }) }),
        element(ui.Route, { path: '/jobs', element: element('h1', null, 'Job library') }),
        element(ui.Route, { path: '/analyses', element: element('h1', null, 'Analysis library') })))))))
  return { rubric, path, prefix }
}
function dialog(title) {
  return [...document.querySelectorAll('[role="dialog"]')].find((item) => item.querySelector('h2')?.textContent === title)
}
function button(label, within = document) {
  const found = [...within.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent.trim()) === label)
  assert.ok(found, `Button "${label}" exists`)
  return found
}
function nameInput() {
  const label = [...dialog('Edit rubric').querySelectorAll('label')].find((item) => item.querySelector('.field-label')?.textContent === 'Rubric name')
  assert.ok(label, 'The rubric name field exists')
  return label.querySelector('input')
}
async function click(item) { assert.ok(item); await act(async () => item.click()) }
async function editName(value = 'Unsaved rubric title') {
  const input = nameInput()
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function dismiss(method) {
  await act(async () => { await pause() })
  if (method === 'Cancel' || method === 'Close dialog') await click(button(method, dialog('Edit rubric')))
  else await act(async () => {
    if (method === 'Escape') document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    else {
      const overlay = document.querySelector('.dialog-overlay')
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        overlay.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0, cancelable: true }))
      }
    }
  })
}
function unloadBlocked() {
  const event = new dom.window.Event('beforeunload', { cancelable: true })
  dom.window.dispatchEvent(event)
  return event.defaultPrevented
}
async function until(predicate, message) {
  for (let index = 0; index < 150; index += 1) {
    if (predicate()) return
    await act(async () => { await pause() })
  }
  assert.fail(message)
}

for (const method of ['Cancel', 'Close dialog', 'Escape', 'outside']) {
  test(`dirty rubric ${method} supports Stay and explicit discard without saving`, async () => {
    const { rubric } = await renderEditor()
    assert.equal(unloadBlocked(), false)
    await editName()
    assert.equal(unloadBlocked(), true)
    await dismiss(method)
    const protection = dialog('Unsaved changes')
    assert.ok(protection)
    assert.match(protection.textContent, new RegExp(`Rubric: ${rubric.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    await click(button('Stay here', protection))
    assert.equal(nameInput().value, 'Unsaved rubric title')
    assert.equal(unloadBlocked(), true)
    await dismiss(method)
    await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
    assert.equal(Boolean(dialog('Edit rubric')), false)
    assert.equal(unloadBlocked(), false)
    assert.deepEqual(saveCalls, [])
  })

  test(`clean rubric ${method} closes without an unnecessary prompt`, async () => {
    await renderEditor()
    await dismiss(method)
    assert.equal(Boolean(dialog('Edit rubric')), false)
    assert.equal(Boolean(dialog('Unsaved changes')), false)
    assert.equal(unloadBlocked(), false)
    assert.deepEqual(saveCalls, [])
  })
}

test('reverting rubric edits to the opening value makes the dialog clean again', async () => {
  const { rubric } = await renderEditor()
  await editName()
  await editName(rubric.name)
  assert.equal(unloadBlocked(), false)
  await dismiss('Cancel')
  assert.equal(Boolean(dialog('Unsaved changes')), false)
  assert.equal(Boolean(dialog('Edit rubric')), false)
})

test('dirty criterion edits are protected even when the name is untouched', async () => {
  await renderEditor()
  const criterion = dialog('Edit rubric').querySelector('.criterion-card input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(criterion, 'Changed criterion label')
    criterion.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await dismiss('Cancel')
  assert.ok(dialog('Unsaved changes'))
})

test('pending rubric save cannot be discarded; failed saves keep the editable draft and dirty guard', async () => {
  const request = deferred()
  const { rubric } = await renderEditor({ cloud: true, save: () => request.promise })
  await editName('Private revised rubric')
  await click(button(`Save version ${rubric.version + 1}`, dialog('Edit rubric')))
  assert.equal(saveCalls.length, 1)
  assert.equal(button('Cancel', dialog('Edit rubric')).disabled, true)
  await dismiss('Close dialog')
  const pending = dialog('Request in progress')
  assert.ok(pending)
  assert.match(pending.textContent, /Private revised rubric|Rubric:/)
  assert.doesNotMatch(pending.textContent, /grade request|unsaved grade/i)
  assert.equal(button('Discard unsaved changes and leave', pending).disabled, true)
  assert.match(pending.textContent, /never cancels that work/)
  assert.equal(unloadBlocked(), true)
  await act(async () => request.reject(new Error('A newer version was saved elsewhere. Review it and try again.')))
  assert.ok(dialog('Unsaved changes'))
  await click(button('Stay here', dialog('Unsaved changes')))
  assert.equal(nameInput().value, 'Private revised rubric')
  assert.equal(nameInput().disabled, false)
  assert.match(dialog('Edit rubric').textContent, /A newer version was saved elsewhere/)
  assert.deepEqual(saved, [])
  assert.equal(unloadBlocked(), true)
  await dismiss('Cancel')
  assert.ok(dialog('Unsaved changes'), 'Failure acknowledgement releases only the pending state, not the dirty draft')
})

test('a clean pending save remains protected until acknowledgement, then releases without cancelling work', async () => {
  const request = deferred()
  const { rubric } = await renderEditor({ save: () => request.promise })
  await click(button(`Save version ${rubric.version + 1}`, dialog('Edit rubric')))
  await dismiss('Escape')
  const pending = dialog('Request in progress')
  assert.ok(pending)
  assert.equal(button('Continue', pending).disabled, true)
  await act(async () => request.resolve('acknowledged-rubric'))
  assert.deepEqual(saved, ['acknowledged-rubric'])
  assert.equal(Boolean(dialog('Edit rubric')), false)
  assert.equal(unloadBlocked(), false)
  await click(button('Stay here', dialog('Continue leaving?')))
  assert.equal(Boolean(document.querySelector('[role="dialog"]')), false)
  assert.equal(saveCalls.length, 1)
})

test('synchronous save rejection clears its immediate request hold but preserves dirty edits', async () => {
  const { rubric } = await renderEditor({ save: () => { throw new Error('This rubric changed before saving.') } })
  await editName()
  await click(button(`Save version ${rubric.version + 1}`, dialog('Edit rubric')))
  assert.match(dialog('Edit rubric').textContent, /This rubric changed before saving/)
  await dismiss('Close dialog')
  assert.ok(dialog('Unsaved changes'))
  assert.equal(Boolean(dialog('Request in progress')), false)
  assert.equal(nameInput().value, 'Unsaved rubric title')
})

test('successful dirty save releases the guard before the saved-version callback', async () => {
  const { rubric } = await renderEditor()
  await editName('  Saved rubric title  ')
  await click(button(`Save version ${rubric.version + 1}`, dialog('Edit rubric')))
  assert.deepEqual(saved, ['saved-rubric'])
  assert.equal(saveCalls[0].name, 'Saved rubric title')
  assert.equal(Boolean(dialog('Edit rubric')), false)
  assert.equal(unloadBlocked(), false)
  await act(async () => navigate('/jobs'))
  assert.equal(location.pathname, '/jobs')
  assert.equal(Boolean(dialog('Unsaved changes')), false)
})

for (const cloud of [false, true]) {
  const mode = cloud ? 'cloud' : 'standalone'
  test(`${mode} push and replace navigation preserve dirty drafts until explicit discard`, async () => {
    const { rubric } = await renderEditor({ cloud })
    await editName()
    await act(async () => navigate('/jobs'))
    assert.ok(dialog('Unsaved changes'))
    assert.equal(location.pathname, `/rubrics/${rubric.id}`)
    await click(button('Stay here', dialog('Unsaved changes')))
    assert.equal(nameInput().value, 'Unsaved rubric title')
    await act(async () => navigate('/analyses?view=history', { replace: true }))
    await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
    assert.equal(location.pathname, '/analyses')
    assert.equal(location.search, '?view=history')
    assert.equal(unloadBlocked(), false)
  })

  test(`${mode} browser Back restores the outgoing URL while Stay/Discard is pending`, async () => {
    const { path, prefix } = await renderEditor({ cloud })
    await editName()
    await act(async () => dom.window.history.back())
    await until(() => dialog('Unsaved changes'), 'Back should request a dirty-edit decision')
    assert.equal(dom.window.location.pathname, path)
    await click(button('Stay here', dialog('Unsaved changes')))
    assert.equal(nameInput().value, 'Unsaved rubric title')
    await act(async () => dom.window.history.back())
    await until(() => dialog('Unsaved changes'), 'A second Back should remain protected')
    await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
    await until(() => dom.window.location.pathname === `${prefix}/jobs` && location.pathname === '/jobs', 'Discard should complete Back once')
    assert.equal(Boolean(dialog('Edit rubric')), false)
    assert.equal(unloadBlocked(), false)
  })
}

test('Back without a React Router history index still protects and restores standalone edits', async () => {
  const { path } = await renderEditor({ historyIndexes: false })
  await editName()
  await act(async () => dom.window.history.back())
  await until(() => dialog('Unsaved changes'), 'An unindexed Back should request confirmation')
  assert.equal(dom.window.location.pathname, path)
  await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
  await until(() => location.pathname === '/jobs', 'The authorized fallback pop should reach the intended page')
})

test('cloud workspace preflight uses the same dirty guard and keeps a rejected switch in the current workspace', async () => {
  const { path } = await renderEditor({ cloud: true })
  await editName()
  let attempt
  await act(async () => { attempt = apiRef.current.confirmLeave() })
  assert.ok(dialog('Unsaved changes'))
  await click(button('Stay here', dialog('Unsaved changes')))
  assert.equal(await attempt, false)
  assert.equal(dom.window.location.pathname, path)
  assert.equal(nameInput().value, 'Unsaved rubric title')
  await act(async () => { attempt = apiRef.current.confirmLeave() })
  await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
  assert.equal(await attempt, true)
  assert.deepEqual(saveCalls, [])
})

test('cloud history outside the workspace prefix remains available to the cloud workspace gate', async () => {
  const { path } = await renderEditor({ cloud: true })
  await editName()
  const destination = '/workspaces/workspace-two/jobs'
  let intercepted = false
  const outerGate = (event) => { intercepted = true; event.stopImmediatePropagation() }
  dom.window.addEventListener('popstate', outerGate, { capture: true })
  try {
    await act(async () => {
      dom.window.history.pushState({ idx: 2 }, '', destination)
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: { idx: 2 } }))
    })
    assert.equal(intercepted, true, 'The same-workspace guard must not swallow the cloud gate event')
    assert.equal(Boolean(dialog('Unsaved changes')), false)
    assert.equal(nameInput().value, 'Unsaved rubric title')
  } finally {
    dom.window.removeEventListener('popstate', outerGate, { capture: true })
    dom.window.history.replaceState({ idx: 1 }, '', path)
  }
})

test('standalone App installs protection around its existing router and rubric editor', async () => {
  const context = contextFor()
  const rubric = context.workspace.rubrics[0]
  dom.window.history.replaceState({ idx: 0 }, '', `/rubrics/${rubric.id}`)
  await renderTree(element(ui.BrowserRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    element(ui.WorkspaceContext.Provider, { value: context }, element(ui.App))))
  const edit = [...document.querySelectorAll('button')].find((item) => /^Edit (rubric|name)/.test(item.textContent.trim()))
  await click(edit)
  await editName()
  await click(document.querySelector('.sidebar a[href="/jobs"]'))
  assert.ok(dialog('Unsaved changes'))
  await click(button('Stay here', dialog('Unsaved changes')))
  assert.equal(nameInput().value, 'Unsaved rubric title')
  await click(document.querySelector('.sidebar a[href="/jobs"]'))
  await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
  assert.equal(dom.window.location.pathname, '/jobs')
  assert.equal(Boolean(dialog('Edit rubric')), false)
})
