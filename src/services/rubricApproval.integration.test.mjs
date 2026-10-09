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

const output = resolve(`.rubric-approval-tests-${randomUUID()}`)
const originals = new Map()
const h = React.createElement
let dom, root, createRoot, ui
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
const HASH = 'a'.repeat(64)

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
  originals.set('CSS', Object.getOwnPropertyDescriptor(globalThis, 'CSS'))
  Object.defineProperty(globalThis, 'CSS', { configurable: true, writable: true, value: { escape: (value) => String(value).replace(/["\\\]]/g, '\\$&') } })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export { RubricPanel } from './src/features/rubrics/RubricPanel'
    export { WorkspaceContext } from './src/app/workspace-context'
    export { EVIDENCE_SCALE_VERSION } from './src/domain/evidence-scale'
    export { BrowserRouter } from 'react-router-dom'
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent' })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

afterEach(async () => {
  if (root) { await act(async () => { root.unmount(); await pause() }); root = null }
  document.body.innerHTML = '<div id="root"></div>'
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
const levels = [1, 2, 3, 4, 5].map((level) => ({ level, examples: `Documents analysis work at level ${level}.` }))
const unexpected = async () => { throw new Error('Unexpected rubric approval call.') }

function fixture({ legacy = false } = {}) {
  const document = {
    id: 'doc-1', title: 'Program analyst', kind: 'job', version: 1, sample: false,
    paragraphs: [{ id: 'p1', page: 1, heading: 'Duties', text: 'Lead data analysis and communicate findings to stakeholders.' }],
  }
  const criterion = (id, label, weight, quote) => ({
    id, key: 'custom', label, description: `${label} for the role.`, guidance: 'Rendered from the evidence scale.', weight,
    requirementType: 'required', sourceParagraphId: 'p1', sourceCitations: [citation(quote)], ...(legacy ? {} : { levels }),
  })
  const rubric = {
    id: 'rubric-1', groupId: 'rubric-group-1', kind: 'job', jobId: 'job-1', name: 'Program analyst rubric',
    description: 'Assess job requirements.', version: 2, createdAt: '2026-01-02T00:00:00.000Z', dataKind: 'real',
    provenance: { kind: 'edited', model: 'fixture', promptVersion: 'fixture' },
    ...(legacy ? {} : { scaleVersion: ui.EVIDENCE_SCALE_VERSION }),
    criteria: [criterion('criterion-1', 'Analysis', 60, 'Lead data analysis'), criterion('criterion-2', 'Communication', 40, 'communicate findings to stakeholders')],
  }
  const firstVersion = { ...rubric, version: 1, createdAt: '2026-01-01T00:00:00.000Z' }
  const job = { id: 'job-1', title: 'Program analyst', organization: 'Fixture org', location: '', arrangement: '', employmentType: '', grade: '', series: '', source: 'pdf', sourceLabel: 'job.pdf', documentId: document.id, rubricId: rubric.id, status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', dataKind: 'real' }
  return { workspace: { jobs: [job], documents: [document], rubrics: [rubric] }, job, document, rubric, firstVersion }
}

const pointer = (version) => ({ approvalId: `rubric-approval-${version}`, rubricId: 'rubric-1', version, rubricHash: HASH, approvedBy: 'owner', approvedAt: '2026-01-04T00:00:00.000Z' })
const checkState = ({ blockers = [], checks = null } = {}) => ({ rubricId: 'rubric-1', version: 2, rubricHash: HASH, status: 'draft', blockers, checks })
const qaRecord = (checks = [], findings = []) => ({
  id: 'rubric-qa:rubric-1:2:score-rubric-qa-v1', workspaceId: 'workspace-one', recordType: 'rubric-qa', jobId: 'job-1', rubricId: 'rubric-1', version: 2,
  rubricHash: HASH, qaVersion: 'score-rubric-qa-v1', checks,
  review: { promptVersion: 'score-job-rubric-review-v1', model: 'fixture-model', summary: 'The criteria cover separate work.', findings },
  createdBy: 'owner', createdAt: '2026-01-03T00:00:00.000Z',
})
const overlap = { code: 'same-capability', severity: 'warning', criterionIds: ['criterion-1', 'criterion-2'], message: 'Both criteria may credit the same analysis work.' }
const structure = { code: 'scale-structure', severity: 'blocker', criterionIds: ['criterion-1'], message: 'Level 3 repeats level 2.' }

async function render({ role = 'owner', approval, legacy = false, required = true, checksAvailable = true, ...api } = {}, panelProps = {}) {
  const data = fixture({ legacy })
  const ctx = frontendWorkspaceContext({
    workspace: data.workspace,
    cloud: {
      currentWorkspaceId: 'workspace-one',
      workspaces: [{ id: 'workspace-one', name: 'Fixture workspace', role, etag: '"workspace"' }],
      realJobs: {
        features: {
          realJobImports: true, markdownJobImports: true, wordDocumentImports: false, rubricAssistant: false, rubricExports: false,
          rubricApprovalRequired: required, rubricChecks: checksAvailable,
          limits: { maxCriteria: 20, maxBatchFiles: 10, maxFileBytes: 1, maxPdfBytes: 1, maxPdfPages: 1, maxSourceCharacters: 1000, maxUrlLength: 1000, maxMarkdownBytes: 1 },
        },
        detail: () => ({ state: 'ready', value: {
          job: data.job, document: data.document, rubric: data.rubric, rubricVersions: [data.firstVersion, data.rubric],
          ...(approval ? { rubricApproval: approval } : {}),
          source: { kind: 'pdf', displayName: 'job.pdf' }, etag: '"job"', updatedAt: data.job.createdAt, attempts: 1, warnings: [],
        } }),
        source: () => ({ kind: 'pdf', displayName: 'job.pdf', originalContentType: 'application/pdf' }),
        rubricChecks: unexpected, runRubricChecks: unexpected, approveRubric: unexpected, ...api,
      },
    },
  })
  root ??= createRoot(document.getElementById('root'))
  await act(async () => {
    root.render(h(ui.BrowserRouter, null, h(ui.WorkspaceContext.Provider, { value: ctx },
      h(ui.RubricPanel, { rubric: panelProps.version === 1 ? data.firstVersion : data.rubric, readOnly: panelProps.readOnly ?? false }))))
    await pause()
  })
}

const text = () => document.body.textContent.replace(/\s+/g, ' ')
const dialog = () => document.querySelector('[role="dialog"]')
const findButton = (label, within = document) => [...within.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent.trim()) === label)
function button(label, within = document) {
  const found = findButton(label, within)
  assert.ok(found, `Button "${label}" exists`)
  return found
}
async function click(node) { await act(async () => { node.click(); await pause() }) }

test('an owner runs the checks on the latest scaled draft, reviews the findings and approves that exact version', async () => {
  const calls = []
  const checked = checkState({ checks: qaRecord([], [overlap]) })
  await render({
    rubricChecks: async (jobId, rubricId, version) => { calls.push(['read', jobId, rubricId, version]); return checkState() },
    runRubricChecks: async (jobId, rubricId, version) => { calls.push(['run', jobId, rubricId, version]); return checked },
    approveRubric: async (jobId, state) => { calls.push(['approve', jobId, state]) },
  })
  assert.match(text(), /Approval Draft/)
  assert.match(text(), /Not approved yet\. New analyses and grade ladders can use this rubric only after a workspace owner approves it\./)
  await click(button('Check and approve'))
  assert.ok(dialog(), 'The approval dialog opens')
  assert.equal(button('Approve version 2', dialog()).disabled, true, 'Approval waits for the checks')
  await click(button('Run rubric checks', dialog()))
  assert.match(dialog().textContent, /The criteria cover separate work\./)
  assert.match(dialog().textContent, /Review before approving/)
  assert.match(dialog().textContent, /Both criteria may credit the same analysis work\./)
  assert.match(dialog().textContent, /01 Analysis · 02 Communication/)
  assert.equal(button('Approve version 2', dialog()).disabled, false, 'Warnings inform the owner but don’t block approval')
  await click(button('Approve version 2', dialog()))
  assert.deepEqual(calls, [['read', 'job-1', 'rubric-1', 2], ['run', 'job-1', 'rubric-1', 2], ['approve', 'job-1', checked]])
  assert.equal(dialog(), null, 'The dialog closes after approval')
})

test('blocking findings keep Approve disabled and say what to fix', async () => {
  await render({ rubricChecks: async () => checkState({ blockers: ['Fix the level examples before approving.'], checks: qaRecord([structure]) }) })
  await click(button('Check and approve'))
  assert.match(dialog().textContent, /This version can’t be approved yet\..*Fix the level examples before approving\./)
  assert.match(dialog().textContent, /Must fix before approval.*Level 3 repeats level 2\./)
  assert.equal(button('Approve version 2', dialog()).disabled, true)
})

test('editors can run the checks but only workspace owners approve', async () => {
  await render({ role: 'editor', rubricChecks: async () => checkState({ checks: qaRecord() }) })
  assert.equal(findButton('Check and approve'), undefined)
  await click(button('Run rubric checks'))
  assert.equal(findButton('Approve version 2', dialog()), undefined)
  assert.match(dialog().textContent, /The checks found nothing to review\./)
  assert.match(dialog().textContent, /Only a workspace owner can approve rubrics\./)
})

test('checks stay unavailable while the deployment can’t run them', async () => {
  await render({ checksAvailable: false, rubricChecks: async () => checkState() })
  await click(button('Check and approve'))
  assert.equal(findButton('Run rubric checks', dialog()), undefined)
  assert.match(dialog().textContent, /Rubric checks aren’t available right now/)
  assert.equal(button('Approve version 2', dialog()).disabled, true)
})

test('approved, superseded, legacy and optional-approval rubrics explain their state without offering approval', async () => {
  await render({ approval: pointer(2) })
  assert.match(text(), /Approval Approved/)
  assert.match(text(), /New analyses and grade ladders use this version\./)
  assert.equal(findButton('Check and approve'), undefined)
  await act(async () => { root.unmount(); await pause() }); root = null

  await render({ approval: pointer(2) }, { version: 1, readOnly: true })
  assert.match(text(), /Approval Superseded/)
  assert.match(text(), /Version 2 was approved after this one and is the version new work uses\./)
  assert.equal(findButton('Check and approve'), undefined)
  await act(async () => { root.unmount(); await pause() }); root = null

  await render({ legacy: true })
  assert.match(text(), /made before the evidence scale, so it can’t be approved/)
  assert.equal(findButton('Check and approve'), undefined)
  await act(async () => { root.unmount(); await pause() }); root = null

  await render({ required: false })
  assert.match(text(), /Admin settings let new analyses use rubrics without approval\./)
  assert.ok(findButton('Check and approve'), 'Owners can still approve while approval is optional')
})
