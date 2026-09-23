import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { frontendWorkspaceContext } from './frontend.test-support.mjs'

const output = resolve(`.rubric-assist-editor-tests-${randomUUID()}`)
const originals = new Map()
const h = React.createElement
let dom, root, createRoot, ui, saveCalls, assistCalls
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent',
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
  originals.set('crypto', Object.getOwnPropertyDescriptor(globalThis, 'crypto'))
  Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: { randomUUID } })
  // JSDOM has no CSS.escape; browsers do, and DocumentViewer/Jump use it for attribute selectors.
  originals.set('CSS', Object.getOwnPropertyDescriptor(globalThis, 'CSS'))
  Object.defineProperty(globalThis, 'CSS', { configurable: true, writable: true, value: { escape: (value) => String(value).replace(/["\\\]]/g, '\\$&') } })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export { RubricPanel } from './src/features/rubrics/RubricPanel'
    export { WorkspaceContext } from './src/app/workspace-context'
    export { BrowserRouter } from 'react-router-dom'
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

afterEach(async () => {
  if (root) { await act(async () => { root.unmount(); await pause() }); root = null }
  document.body.innerHTML = '<div id="root"></div>'
  saveCalls = []
  assistCalls = []
})

after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

const citation = (quote) => ({ documentId: 'doc-1', documentVersion: 1, paragraphId: 'p1', page: 1, heading: 'Duties', quote })
const assistant = { promptVersion: 'score-rubric-assist-v1', model: 'fixture-model' }
const changed = (operations, reply = 'Updated the draft.') => ({ outcome: 'changed', reply, warnings: [], assistant, operations })

function fixture() {
  const document = {
    id: 'doc-1', title: 'Program analyst', kind: 'job', version: 1, sample: false,
    paragraphs: [{ id: 'p1', page: 1, heading: 'Duties', text: 'Lead data analysis and communicate findings to stakeholders.' }],
  }
  const rubric = {
    id: 'rubric-1', groupId: 'rubric-group-1', kind: 'job', jobId: 'job-1', name: 'Program analyst rubric',
    description: 'Assess job requirements.', version: 2, createdAt: '2026-01-02T00:00:00.000Z', dataKind: 'real',
    provenance: { kind: 'edited', model: 'fixture', promptVersion: 'fixture' },
    criteria: [
      { id: 'criterion-1', key: 'custom', label: 'Analysis', description: 'Uses data.', guidance: '0 no evidence; 5 sustained evidence.', weight: 60, requirementType: 'required', sourceParagraphId: 'p1', sourceCitations: [citation('Lead data analysis')] },
      { id: 'criterion-2', key: 'custom', label: 'Communication', description: 'Shares findings.', guidance: '0 no evidence; 5 sustained evidence.', weight: 40, requirementType: 'preferred', sourceParagraphId: 'p1', sourceCitations: [citation('communicate findings to stakeholders')] },
    ],
  }
  const firstVersion = {
    ...rubric, version: 1, name: 'Legacy analyst rubric', createdAt: '2026-01-01T00:00:00.000Z',
    provenance: { kind: 'generated', model: 'fixture', promptVersion: 'fixture' },
    criteria: [{ ...rubric.criteria[0], label: 'Legacy analysis' }, rubric.criteria[1]],
  }
  const job = { id: 'job-1', title: 'Program analyst', organization: 'Fixture org', location: '', arrangement: '', employmentType: '', grade: '', series: '', source: 'pdf', sourceLabel: 'job.pdf', documentId: document.id, rubricId: rubric.id, status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', dataKind: 'real' }
  return { workspace: { schemaVersion: 1, jobs: [job], resumes: [], documents: [document], rubrics: [rubric], runs: [] }, job, document, rubric, firstVersion }
}

function context({ assist, rubricAssistant = true, role = 'owner' } = {}) {
  const data = fixture()
  return frontendWorkspaceContext({
    workspace: data.workspace,
    saveRubric: (draft) => { saveCalls.push(structuredClone(draft)); return 'saved-rubric' },
    cloud: {
      currentWorkspaceId: 'workspace-one',
      workspaces: [{ id: 'workspace-one', name: 'Fixture workspace', role, etag: '"workspace"' }],
      realJobs: {
        features: { realJobImports: true, markdownJobImports: true, wordDocumentImports: true, rubricAssistant, limits: { maxCriteria: 20, maxBatchFiles: 10, maxFileBytes: 1, maxPdfBytes: 1, maxPdfPages: 1, maxSourceCharacters: 1000, maxUrlLength: 1000, maxMarkdownBytes: 1 } },
        detail: () => ({ state: 'ready', value: { job: data.job, document: data.document, rubric: data.rubric, rubricVersions: [data.firstVersion, data.rubric], source: { kind: 'pdf', displayName: 'job.pdf' }, etag: '"job"', updatedAt: data.job.createdAt, attempts: 1, warnings: [] } }),
        source: () => ({ kind: 'pdf', displayName: 'job.pdf', originalContentType: 'application/pdf' }),
        assistRubric: async (jobId, request, signal) => {
          assistCalls.push({ jobId, request, signal })
          return assist ? assist(request, signal) : changed([{ type: 'updateCriterion', criterionId: 'criterion-1', changes: { label: 'Data analysis', citation: citation('Lead data analysis') } }], 'Updated the focused criterion.')
        },
      },
    },
  })
}

async function render(options = {}, panelProps = {}) {
  saveCalls = []
  assistCalls = []
  const ctx = context(options)
  root ??= createRoot(document.getElementById('root'))
  await act(async () => {
    root.render(h(ui.BrowserRouter, null, h(ui.WorkspaceContext.Provider, { value: ctx }, h(ui.RubricPanel, { rubric: ctx.workspace.rubrics[0], ...panelProps }))))
    await pause()
  })
  return ctx.workspace.rubrics[0]
}

function buttons(within = document) { return [...within.querySelectorAll('button')] }
function findButton(label, within = document) {
  return buttons(within).find((item) => (item.getAttribute('aria-label') ?? item.textContent.trim()) === label)
}
function button(label, within = document) {
  const found = findButton(label, within)
  assert.ok(found, `Button "${label}" exists`)
  return found
}
const dialog = () => document.querySelector('[role="dialog"]')
const field = (key, selector = 'input, textarea, select') => document.querySelector(`[data-change-key="${key}"]`)?.querySelector(selector)
const highlight = (key) => document.querySelector(`[data-change-key="${key}"] .changed-field`)
const formFieldset = () => dialog().querySelector('form fieldset')
function tab(label) {
  const found = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent.startsWith(label))
  assert.ok(found, `Tab "${label}" exists`)
  return found
}

async function click(node) { await act(async () => { node.click(); await pause() }) }
async function setValue(node, value) {
  await act(async () => {
    const prototype = node instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype
      : node instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
    node.dispatchEvent(new dom.window.Event(node instanceof dom.window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    await pause()
  })
}
async function ask(text) {
  await setValue(document.querySelector('textarea[placeholder="Ask AI to change or explain this draft"]'), text)
  await click(button('Send'))
  await pause(20)
}

test('Edit with AI sends focused draft, applies highlighted changes, reviews and confirms save', async () => {
  const rubric = await render()
  await click(button('Edit with AI'))
  assert.equal(tab('Ask AI').getAttribute('aria-selected'), 'true')
  await ask('Tighten this criterion')
  assert.equal(assistCalls.length, 1)
  assert.equal(assistCalls[0].jobId, 'job-1')
  assert.deepEqual(assistCalls[0].request.base, { rubricId: rubric.id, version: rubric.version })
  assert.equal(assistCalls[0].request.draft.criteria[0].label, 'Analysis')
  assert.deepEqual(assistCalls[0].request.conversation, [])
  assert.equal(field('criterion:criterion-1:label').value, 'Data analysis')
  assert.ok(highlight('criterion:criterion-1:label').classList.contains('is-ai'))
  assert.match(highlight('criterion:criterion-1:label').textContent, /AI assist/)
  assert.match(highlight('criterion:criterion-1:label').textContent, /Analysis/, 'Previous value is shown')
  assert.match(dialog().textContent, /1 unsaved change · 1 from AI assist/)
  await click(button('Review changes'))
  assert.match(document.querySelector('[role="tabpanel"]:not([hidden])').textContent, /Unsaved changes \(1\)/)
  await click(button(`Save version ${rubric.version + 1}`))
  assert.equal(saveCalls.length, 0, 'AI changes require a confirmation step')
  assert.match(document.querySelector('.dialog-footer').textContent, /with 1 changes \(1 from AI assist\)/)
  await click(button(`Confirm and save version ${rubric.version + 1}`))
  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].criteria[0].label, 'Data analysis')
  assert.deepEqual(saveCalls[0].criteria[0].sourceCitations[0], citation('Lead data analysis'))
})

test('a follow-up request replays the completed exchange as context', async () => {
  await render()
  await click(button('Edit with AI'))
  await ask('Rename it')
  await ask('Now tighten the description')
  assert.equal(assistCalls.length, 2)
  const replay = assistCalls[1].request.conversation
  assert.equal(replay.length, 2)
  assert.deepEqual(replay[0], { role: 'user', text: 'Rename it' })
  assert.equal(replay[1].role, 'assistant')
  assert.match(replay[1].text, /Changes applied:/)
  assert.equal(assistCalls[1].request.draft.criteria[0].label, 'Data analysis', 'The second request sees the updated draft')
})

test('reviewer edits are highlighted separately and Revert restores the opened value', async () => {
  await render()
  await click(button('Edit rubric'))
  await setValue(field('rubric.name'), 'Renamed rubric')
  assert.ok(highlight('rubric.name').classList.contains('is-user'))
  assert.match(highlight('rubric.name').textContent, /Edited/)
  assert.match(highlight('rubric.name').textContent, /Program analyst rubric/)
  await click(button('Revert Rubric name'))
  assert.equal(field('rubric.name').value, 'Program analyst rubric')
  assert.equal(highlight('rubric.name'), null)
})

test('Undo this change reverts AI edits but keeps fields the reviewer changed afterwards', async () => {
  await render({ assist: () => changed([{ type: 'updateCriterion', criterionId: 'criterion-1', changes: { label: 'Data analysis', description: 'Analyzes program data.' } }]) })
  await click(button('Edit with AI'))
  await ask('Improve criterion 1')
  assert.equal(field('criterion:criterion-1:description').value, 'Analyzes program data.')
  await setValue(field('criterion:criterion-1:description'), 'Reviewer wording.')
  await click(button('Undo this change'))
  assert.equal(field('criterion:criterion-1:label').value, 'Analysis')
  assert.equal(field('criterion:criterion-1:description').value, 'Reviewer wording.')
  assert.ok(findButton('Undone (1 reverted, 1 skipped because they changed later)'))
})

test('header Undo and Redo step through AI and reviewer changes', async () => {
  await render()
  await click(button('Edit with AI'))
  await ask('Rename criterion 1')
  const undo = buttons(dialog()).find((item) => item.textContent.trim() === 'Undo')
  assert.match(undo.getAttribute('aria-label'), /^Undo AI change:/)
  await click(undo)
  assert.equal(field('criterion:criterion-1:label').value, 'Analysis')
  await click(buttons(dialog()).find((item) => item.textContent.trim() === 'Redo'))
  assert.equal(field('criterion:criterion-1:label').value, 'Data analysis')
})

test('AI additions are badged and AI removals stay visible until restored', async () => {
  const addedId = randomUUID()
  await render({
    assist: () => changed([
      { type: 'removeCriterion', criterionId: 'criterion-2' },
      { type: 'addCriterion', afterCriterionId: null, criterion: { id: addedId, key: 'custom', label: 'Stakeholder engagement', description: 'Communicates findings.', guidance: '0 none; 1 a; 2 b; 3 c; 4 d; 5 e.', weight: 40, requirementType: 'required', sourceParagraphId: 'p1', sourceCitations: [citation('communicate findings to stakeholders')] } },
    ]),
  })
  await click(button('Edit with AI'))
  await ask('Replace the communication criterion')
  const removed = dialog().querySelector('.removed-item-row')
  assert.ok(removed, 'Removed criterion stays visible')
  assert.match(removed.textContent, /by AI assist/)
  assert.match(document.querySelector(`[data-change-key="criterion:${addedId}"]`).textContent, /New · AI assist/)
  const addedLabel = highlight(`criterion:${addedId}:label`)
  assert.match(addedLabel.textContent, /AI assist/, 'Fields the assistant populated in a new criterion are attributed')
  assert.equal(addedLabel.querySelector('.changed-previous'), null, 'A new criterion has no previous value to show')
  assert.equal(buttons(addedLabel).some((item) => item.textContent.trim() === 'Revert'), false, 'Removing the criterion, not a per-field revert, undoes an addition')
  await click(buttons(removed).find((item) => (item.getAttribute('aria-label') ?? '').startsWith('Restore')))
  assert.equal(dialog().querySelector('.removed-item-row'), null)
  assert.equal(field('criterion:criterion-2:label').value, 'Communication')
})

test('conflicts and rate limits leave the draft unchanged with actionable messages', async () => {
  let failure = Object.assign(new Error('conflict'), { name: 'CloudConflictError', status: 409 })
  await render({ assist: () => { throw failure } })
  await click(button('Edit with AI'))
  await ask('Change criterion 1')
  assert.match(dialog().textContent, /A newer version of this rubric was saved/)
  assert.equal(field('criterion:criterion-1:label').value, 'Analysis')
  assert.equal(highlight('criterion:criterion-1:label'), null)
  failure = Object.assign(new Error('The model is busy right now (rate limited). Try again in about 7 seconds. Your draft is unchanged.'), { kind: 'rate-limited', status: 429, retryAfterSeconds: 7 })
  await ask('Try again')
  assert.match(dialog().textContent, /Try again in 7 s\./)
  assert.ok(findButton('Retry'))
})

test('the form locks while the assistant works; Cancel and closing the editor abort the request', async () => {
  await render({
    assist: (_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }),
  })
  await click(button('Edit with AI'))
  await ask('Rebuild everything')
  assert.equal(formFieldset().disabled, true)
  assert.match(dialog().textContent, /AI assist is working…/)
  await click(button('Cancel', dialog().querySelector('.assist-pending')))
  assert.equal(assistCalls[0].signal.aborted, true)
  assert.equal(formFieldset().disabled, false)
  assert.match(dialog().textContent, /Cancelled\. Your draft is unchanged\./)
  await ask('Rebuild everything again')
  assert.equal(assistCalls[1].signal.aborted, false)
  await click(button('Cancel', document.querySelector('.dialog-footer')))
  assert.equal(assistCalls[1].signal.aborted, true, 'Closing the editor cancels the in-flight request')
  assert.equal(dialog(), null)
})

test('explanations render as plain text without changes, and manual-only saves stay one click', async () => {
  const rubric = await render({ assist: () => ({ outcome: 'explained', reply: '<b>No</b>: the posting does not mention Kubernetes.', operations: [], warnings: [], assistant }) })
  await click(button('Edit with AI'))
  await ask('Add a Kubernetes criterion')
  const reply = [...dialog().querySelectorAll('.assist-turn-text')].at(-1)
  assert.equal(reply.textContent, '<b>No</b>: the posting does not mention Kubernetes.')
  assert.equal(reply.querySelector('b'), null)
  assert.equal(dialog().querySelector('.changed-field'), null)
  await setValue(field('rubric.name'), 'Renamed rubric')
  await click(button(`Save version ${rubric.version + 1}`))
  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].name, 'Renamed rubric')
})

test('Draft with AI sends a request focused on the new empty criterion', async () => {
  await render()
  await click(button('Edit with AI'))
  await click(button('Add criterion'))
  const draftInput = [...dialog().querySelectorAll('.rubric-draft-with-ai input')].at(-1)
  assert.ok(draftInput, 'The new card offers Draft with AI')
  await setValue(draftInput, 'stakeholder communication')
  await click(buttons(dialog()).filter((item) => item.textContent.trim() === 'Draft with AI').at(-1))
  assert.equal(assistCalls.length, 1)
  const request = assistCalls[0].request
  const added = request.draft.criteria.at(-1)
  assert.equal(request.focusCriterionId, added.id)
  assert.notEqual(added.id, 'criterion-1')
  assert.match(request.instruction, /Draft criterion 03/)
  assert.match(request.instruction, /stakeholder communication/)
})

test('saved versions can be previewed and used as a starting point', async () => {
  await render()
  await click(button('Edit rubric'))
  await click(tab('Changes'))
  assert.match(dialog().textContent, /Version 1/)
  await click(button('Preview Version 1'))
  assert.match(dialog().textContent, /Previewing Version 1/)
  await click(button('Back to draft'))
  await click(button('Use Version 1 as starting point'))
  assert.equal(field('rubric.name').value, 'Legacy analyst rubric')
  assert.equal(field('criterion:criterion-1:label').value, 'Legacy analysis')
  assert.ok(highlight('criterion:criterion-1:label').classList.contains('is-user'))
})

test('focusing a criterion highlights its cited passage in the Job posting tab', async () => {
  await render()
  await click(button('Edit rubric'))
  await click(button('Ask AI about criterion 1'))
  assert.match(dialog().textContent, /About: Criterion 01 · Analysis/)
  await click(tab('Job posting'))
  assert.ok(document.querySelector('[data-paragraph-id="p1"]').classList.contains('is-highlighted'))
})

test('the read-only panel offers per-criterion Ask AI that opens the editor focused on it', async () => {
  await render()
  await click(button('Ask AI about Communication'))
  assert.equal(tab('Ask AI').getAttribute('aria-selected'), 'true')
  assert.match(dialog().textContent, /About: Criterion 02 · Communication/)
})

test('AI entry points are hidden for samples, viewers, read-only panels, and when the assistant is unavailable', async () => {
  const ctx = context()
  const sample = { ...ctx.workspace.rubrics[0], dataKind: undefined }
  ctx.workspace = { ...ctx.workspace, rubrics: [sample] }
  root ??= createRoot(document.getElementById('root'))
  await act(async () => { root.render(h(ui.BrowserRouter, null, h(ui.WorkspaceContext.Provider, { value: ctx }, h(ui.RubricPanel, { rubric: sample })))); await pause() })
  assert.equal(findButton('Edit with AI'), undefined)
  await act(async () => { root.unmount(); await pause() }); root = null

  await render({ role: 'viewer' })
  assert.equal(findButton('Edit with AI'), undefined)
  await act(async () => { root.unmount(); await pause() }); root = null

  await render({}, { readOnly: true })
  assert.equal(findButton('Edit with AI'), undefined)
  await act(async () => { root.unmount(); await pause() }); root = null

  await render({ rubricAssistant: false })
  assert.equal(findButton('Edit with AI'), undefined)
  assert.equal(findButton('Ask AI about Analysis'), undefined)
  await click(button('Edit rubric'))
  assert.equal([...document.querySelectorAll('[role="tab"]')].some((item) => item.textContent.startsWith('Ask AI')), false)
})
