import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act, useEffect } from 'react'
import { JSDOM } from 'jsdom'

const output = resolve(`.assisted-editor-shell-tests-${randomUUID()}`)
const originals = new Map()
const h = React.createElement
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
let ui, dom, root, createRoot

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'PopStateEvent',
    'DocumentFragment', 'DOMException', 'KeyboardEvent', 'MouseEvent', 'localStorage']) {
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
    export { AssistedEditorShell } from './src/features/assist/AssistedEditorShell'
    export { AssistConversation } from './src/features/assist/AssistConversation'
    export { useAssistConversation } from './src/features/assist/useAssistConversation'
    export { ChangedField, RemovedItemRow, RemovedItemsGroup } from './src/features/assist/ChangedField'
    export { ChangeHistoryPanel } from './src/features/assist/ChangeHistoryPanel'
    export { Modal } from './src/components/ui'
    export { assistantReplayText, ASSIST_LIMITS } from './src/domain/assist'
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

afterEach(async () => {
  if (root) { await act(async () => { root.unmount(); await pause() }); root = null }
  document.body.innerHTML = '<div id="root"></div>'
})

after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  await rm(output, { recursive: true, force: true })
})

async function render(tree) {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => { root.render(tree); await pause() })
}
function button(name, within = document) {
  const found = [...within.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent.trim()) === name)
  assert.ok(found, `Button "${name}" exists`)
  return found
}
async function click(node) { await act(async () => { node.click(); await pause() }) }
async function fill(node, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(node, value)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await pause()
  })
}
async function key(node, init) { await act(async () => { node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); await pause() }) }

function ShellHarness({ calls }) {
  const [active, setActive] = React.useState('ask')
  return h(ui.AssistedEditorShell, {
    main: h('div', null, h('input', { 'aria-label': 'Editor input' }), h('button', { type: 'button' }, 'Main action')),
    panels: [
      { id: 'ask', label: 'Ask AI', content: h('p', null, 'Ask panel') },
      { id: 'changes', label: 'Changes', badge: 2, content: h('p', null, 'Changes panel') },
    ],
    activePanel: active,
    onActivePanelChange: value => { calls.active.push(value); setActive(value) },
    sideLabel: 'Rubric assistant',
    history: { canUndo: true, canRedo: true, undoLabel: 'Undo AI change: Guidance · Criterion 03', redoLabel: 'Redo user change: Weight', onUndo: () => calls.undo++, onRedo: () => calls.redo++ },
    summary: { total: 7, ai: 4, onReview: () => calls.review++, onNext: () => calls.next++ },
  })
}

test('AssistedEditorShell tabs, collapse, shortcuts, history names, and summary bar', async () => {
  const calls = { active: [], undo: 0, redo: 0, review: 0, next: 0 }
  await render(h(ShellHarness, { calls }))
  const tabs = [...document.querySelectorAll('[role="tab"]')]
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
  await key(tabs[0], { key: 'ArrowRight' })
  assert.equal(document.activeElement.textContent.includes('Changes'), true)
  assert.equal(calls.active.at(-1), 'changes')
  await key(document.activeElement, { key: 'Home' })
  assert.equal(calls.active.at(-1), 'ask')
  await click(button('Collapse Rubric assistant'))
  assert.equal(calls.active.at(-1), null)
  assert.ok(button('Open Rubric assistant'))
  assert.ok(button('Undo AI change: Guidance · Criterion 03'))
  assert.ok(button('Redo user change: Weight'))
  assert.match(document.body.textContent, /7 unsaved changes · 4 from AI assist/)
  await click(button('Review changes')); await click(button('Next change'))
  assert.equal(calls.review, 1); assert.equal(calls.next, 1)
  await key(document.querySelector('.assisted-shell'), { key: 'z', ctrlKey: true })
  await key(document.querySelector('.assisted-shell'), { key: 'z', ctrlKey: true, shiftKey: true })
  assert.equal(calls.undo, 1); assert.equal(calls.redo, 1)
  document.querySelector('input').focus()
  await key(document.querySelector('input'), { key: 'z', ctrlKey: true })
  assert.equal(calls.undo, 1)
})

test('ChangedField and removed rows expose accessible highlighting controls', async () => {
  const calls = { revert: 0, restore: [], all: 0 }
  await render(h('div', null,
    h(ui.ChangedField, { highlight: 'ai', fieldLabel: 'Guidance', previous: '', onRevert: () => calls.revert++ }, describedBy => h('input', { 'aria-label': 'Guidance', 'aria-describedby': describedBy })),
    h(ui.ChangedField, { highlight: null, fieldLabel: 'Plain' }, h('span', { id: 'plain-child' }, 'Plain child')),
    h(ui.RemovedItemRow, { label: 'Criterion 01', detail: 'Old detail', author: 'ai', onRestore: () => calls.restore.push('one') }),
    h(ui.RemovedItemsGroup, { items: [1, 2, 3, 4, 5].map(index => ({ id: `c${index}`, label: `Criterion ${index}`, author: index === 1 ? 'user' : 'ai' })), onRestore: id => calls.restore.push(id), onRestoreAll: () => calls.all++ }),
  ))
  assert.match(document.body.textContent, /AI assist/)
  assert.match(document.body.textContent, /Previously:/)
  assert.equal(document.querySelector('input').getAttribute('aria-describedby').startsWith(':'), true)
  await click(button('Revert Guidance'))
  assert.equal(calls.revert, 1)
  assert.ok(document.getElementById('plain-child'))
  await click(button('Restore Criterion 01'))
  assert.deepEqual(calls.restore, ['one'])
  assert.match(document.body.textContent, /5 criteria removed · Show/)
  await click([...document.querySelectorAll('button')].find(item => item.textContent.includes('Show')))
  await click(button('Restore all'))
  assert.equal(calls.all, 1)
})

function HookProbe({ api, sendImpl, onResponse, describeError }) {
  const state = ui.useAssistConversation({ send: sendImpl, onResponse, describeError, newId: (() => { let index = 0; return () => `id-${++index}` })() })
  useEffect(() => { api.current = state })
  return h('pre', null, JSON.stringify({ turns: state.turns, pending: state.pending, elapsedSeconds: state.elapsedSeconds }))
}

test('useAssistConversation sends bounded replay, handles cancel, retry, errors, thrown responses, undo marks, and unmount abort', async () => {
  const calls = []
  const api = { current: null }
  let mode = 'ok'
  let held = deferred()
  const sendImpl = input => {
    calls.push(input)
    if (mode === 'hold') return held.promise
    if (mode === 'error') return Promise.reject(Object.assign(new Error('Rate limited'), { kind: 'rate-limited', retryAfterSeconds: 9 }))
    return Promise.resolve({ reply: input.instruction })
  }
  const onResponse = response => {
    if (mode === 'throw') throw new Error('Draft changed')
    return { outcome: 'changed', reply: `<b>${response.reply}</b>`, changes: [{ key: response.reply, label: 'Label' }], warnings: [], replaySummary: `summary ${response.reply}` }
  }
  await render(h(HookProbe, { api, sendImpl, onResponse }))
  await act(async () => { await api.current.send('first', 'c1'); await pause() })
  assert.equal(api.current.turns.at(-1).text, '<b>first</b>')
  for (let index = 0; index < 22; index++) await act(async () => { await api.current.send(`turn ${index}`); await pause() })
  assert.ok(calls.at(-1).conversation.length <= 20)
  assert.ok(calls.at(-1).conversation.some(turn => turn.role === 'assistant' && turn.text.includes('Changes applied: summary')))
  mode = 'hold'
  await act(async () => { void api.current.send('slow'); void api.current.send('ignored'); await pause() })
  assert.equal(calls.filter(call => call.instruction === 'slow').length, 1)
  assert.equal(calls.some(call => call.instruction === 'ignored'), false)
  assert.equal(calls.at(-1).signal.aborted, false)
  await act(async () => { api.current.cancel(); await pause() })
  await act(async () => { held.resolve({ reply: 'slow' }); await pause() })
  assert.equal(calls.at(-1).signal.aborted, true)
  assert.equal(api.current.turns.at(-1).status, 'cancelled')
  mode = 'error'
  await act(async () => { await api.current.send('fails'); await pause() })
  assert.equal(api.current.turns.at(-1).status, 'error')
  assert.equal(api.current.turns.at(-1).error.retryAfterSeconds, 9)
  mode = 'ok'
  const failedId = api.current.turns.at(-1).id
  await act(async () => { await api.current.retry(failedId); await pause() })
  assert.equal(api.current.turns.at(-1).status, 'done')
  mode = 'throw'
  await act(async () => { await api.current.send('throwing'); await pause() })
  assert.equal(api.current.turns.at(-1).text, 'Draft changed')
  const doneTurn = api.current.turns.find(turn => turn.role === 'assistant' && turn.changes)
  assert.ok(doneTurn)
  await act(async () => { api.current.markUndone(doneTurn.id, { reverted: 1, skipped: 2 }); await pause() })
  assert.deepEqual(api.current.turns.find(turn => turn.undone)?.undone, { reverted: 1, skipped: 2 })
  mode = 'hold'
  held = deferred()
  await act(async () => { void api.current.send('unmounting'); await pause() })
  const signal = calls.at(-1).signal
  await act(async () => { root.unmount(); root = null; await pause() })
  assert.equal(signal.aborted, true)
})

test('useAssistConversation completes requests under React StrictMode remounting', async () => {
  const api = { current: null }
  const sendImpl = input => new Promise(resolve => setTimeout(() => resolve({ reply: input.instruction }), 20))
  const onResponse = response => ({ outcome: 'changed', reply: response.reply, changes: [], warnings: [], replaySummary: '' })
  await render(h(React.StrictMode, null, h(HookProbe, { api, sendImpl, onResponse })))
  await act(async () => { await api.current.send('strict mode'); await pause(40) })
  assert.equal(api.current.pending, false)
  assert.equal(api.current.turns.at(-1).status, 'done')
  assert.equal(api.current.turns.at(-1).text, 'strict mode')
})

test('AssistConversation composer and change cards are plain text and actionable', async () => {
  const calls = []
  await render(h(ui.AssistConversation, {
    turns: [{ id: 'a1', role: 'assistant', text: '<b>x</b>', at: Date.now(), status: 'done', outcome: 'changed', changes: [{ key: 'k1', label: 'Criterion', detail: 'Updated', quote: 'quoted text' }], warnings: ['Check weights'] }],
    pending: false,
    elapsedSeconds: 0,
    disabledReason: null,
    focus: { label: 'Criterion 01', onClear: () => calls.push('clear') },
    quickActions: [{ id: 'qa', label: 'Tighten wording', instruction: 'tighten' }],
    onSend: value => calls.push(['send', value]),
    onCancel: () => calls.push('cancel'),
    onRetry: id => calls.push(['retry', id]),
    onUndoTurn: id => calls.push(['undo', id]),
    onJump: key => calls.push(['jump', key]),
    onQuote: change => calls.push(['quote', change.key]),
  }))
  assert.equal(document.querySelector('.assist-turn-text').textContent, '<b>x</b>')
  assert.equal(document.querySelector('.assist-turn-text').querySelector('b'), null)
  await click(button('Clear focus Criterion 01'))
  await click(button('Tighten wording'))
  const textarea = document.querySelector('textarea')
  await fill(textarea, 'hello')
  await key(textarea, { key: 'Enter', ctrlKey: true })
  await click(button('Jump to Criterion'))
  await click(document.querySelector('blockquote'))
  await click(button('Undo this change'))
  assert.deepEqual(calls, ['clear', ['send', 'tighten'], ['send', 'hello'], ['jump', 'k1'], ['quote', 'k1'], ['undo', 'a1']])
  assert.match(document.body.textContent, /0 \/ 2,000|5 \/ 2,000/)
})

test('AssistConversation blocks disabled and over-limit sending and renders pending/error affordances', async () => {
  const calls = []
  await render(h(ui.AssistConversation, {
    turns: [{ id: 'e1', role: 'assistant', text: 'Failed', at: Date.now(), status: 'error', error: { message: 'Try later', retryable: true, retryAfterSeconds: 5 } }],
    pending: true,
    elapsedSeconds: 12,
    disabledReason: 'Assistant paused',
    onSend: value => calls.push(['send', value]),
    onCancel: () => calls.push('cancel'),
    onRetry: id => calls.push(['retry', id]),
    onUndoTurn: () => {},
    onJump: () => {},
  }))
  assert.match(document.body.textContent, /AI assist is working… 12 s/)
  assert.match(document.body.textContent, /Assistant paused/)
  assert.match(document.body.textContent, /Try again in 5 s/)
  await click(button('Cancel'))
  await click(button('Retry'))
  assert.deepEqual(calls, ['cancel', ['retry', 'e1']])
  assert.equal(button('Send').disabled, true)
})

test('ChangeHistoryPanel sections, restore, eviction, and saved versions', async () => {
  const calls = []
  await render(h(ui.ChangeHistoryPanel, {
    changes: [{ kind: 'field', key: 'name', label: 'Name', groupLabel: 'Rubric', before: 'Old', after: 'New', author: 'ai' }],
    onJump: key => calls.push(['jump', key]),
    onRevert: key => calls.push(['revert', key]),
    entries: [{ id: 'entry-1', origin: 'ai', note: 'Changed name', at: Date.now(), draft: {}, attribution: new Map(), keys: ['name'] }],
    cursor: 0,
    evictedEntries: 2,
    onRestore: id => calls.push(['restore', id]),
    savedVersions: [{ id: 'v1', label: 'Version 1', detail: 'Opened today', note: 'Reviewer edited', opened: true, latest: false }, { id: 'v2', label: 'Version 2', detail: 'Latest today', note: 'Added criteria', opened: false, latest: true }],
    previewingVersionId: 'v1',
    onPreviewVersion: id => calls.push(['preview', id]),
    onUseVersion: id => calls.push(['use', id]),
  }))
  assert.match(document.body.textContent, /Unsaved changes \(1\)/)
  assert.match(document.body.textContent, /This session/)
  assert.match(document.body.textContent, /Older steps were removed to stay within 100 steps/)
  assert.match(document.body.textContent, /Saved versions/)
  await click(button('Jump to Name · Rubric'))
  await click(button('Revert Name · Rubric'))
  assert.equal(button('Restore to here: Changed name').disabled, true, 'The current step cannot be restored onto itself')
  await click(button('Restore to here: opened version'))
  await click(button('Preview Version 1'))
  await click(button('Use Version 1 as starting point'))
  assert.deepEqual(calls, [['jump', 'name'], ['revert', 'name'], ['restore', 'baseline'], ['preview', 'v1'], ['use', 'v1']])
})

test('Modal fullscreen class is added without replacing existing variants', async () => {
  await render(h('div', null,
    h(ui.Modal, { open: true, onOpenChange: () => {}, title: 'Edit rubric', description: 'Full screen', fullscreen: true, wide: true, footer: h('button', null, 'Save version 2') }, h('p', null, 'Body')),
  ))
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog.classList.contains('dialog-fullscreen'))
  assert.ok(dialog.classList.contains('dialog-wide'))
  assert.ok(button('Save version 2'))
})
