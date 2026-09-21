import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { frontendWorkspaceContext } from '../../services/frontend.test-support.mjs'

const output = resolve(`.naming-ui-tests-${randomUUID()}`)
const originals = new Map()
const originalFetch = globalThis.fetch
const timestamp = '2026-09-19T12:00:00.000Z'
const hash = 'a'.repeat(64)
let ui, dom, root, createRoot, calls, blockers, allowDiscard, guard

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
    DocumentFragment: dom.window.DocumentFragment, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle, localStorage: dom.window.localStorage, CSS: { escape: (value) => value },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export * from './src/domain/displayNames';
    export * from './src/features/analyses/analysisTableBrowsing';
    export { initialRealSelections } from './src/features/analyses/realAnalysisUi';
    export { resumeName } from './src/features/resumes/resumeImportUi';
    export { RenameEntityProvider, RenameEntityButton } from './src/components/ui/RenameEntityButton';
    export { WorkspaceContext } from './src/app/workspace-context';
    export { RealResumesContext } from './src/app/real-resumes-context';
    export { RealAnalysesContext } from './src/app/real-analyses-context';
    export { GradeNavigationContext } from './src/app/grade-navigation-context';
    export { JobsPage, JobDetail } from './src/features/jobs/JobsPage';
    export { ResumesPage } from './src/features/resumes/ResumesPage';
    export { RealResumesPage } from './src/features/resumes/RealResumesPage';
    export { AnalysesPage, AnalysisSetup, AnalysisDetail } from './src/features/analyses/AnalysesPage';
    export { RealAnalysesPage } from './src/features/analyses/RealAnalysesPage';
    export { RealAnalysisSetup } from './src/features/analyses/RealAnalysisSetup';
    export { RealAnalysisDetail } from './src/features/analyses/RealAnalysisDetail';
    export { createInitialWorkspace } from './src/data/fixtures';
    export { MemoryRouter, Routes, Route } from 'react-router-dom';
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})
beforeEach(() => {
  calls = []
  blockers = new Map()
  allowDiscard = false
  guard = {
    setBlocker: (id, value) => { if (value) blockers.set(id, value); else blockers.delete(id) },
    confirmLeave: async (ids) => {
      const active = ids ? ids.map((id) => blockers.get(id)).filter(Boolean) : [...blockers.values()]
      if (!active.length) return true
      calls.push(['confirm-discard', active])
      return !active.some((item) => item.pending) && allowDiscard
    },
    runAuthorized: (action) => action(), releaseForLeave() {}, recordLocation() {},
  }
  globalThis.fetch = async () => assert.fail('Naming UI fixtures must not contact private services.')
})
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null }
  await new Promise((done) => setTimeout(done, 0))
})
after(async () => {
  globalThis.fetch = originalFetch
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

const element = React.createElement
const noop = async () => {}
function context(workspace = ui.createInitialWorkspace(), fields = {}, extras = {}) {
  return frontendWorkspaceContext({ workspace, renameEntity: async (...args) => { calls.push(['rename', ...args]) }, ...fields }, extras)
}
async function render(Page, { workspace = context(), analyses = null, resumes = null, url = '/', path = '*', props = {} } = {}) {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => root.render(element(ui.MemoryRouter, { initialEntries: [url], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    element(ui.WorkspaceContext.Provider, { value: workspace },
      element(ui.RealAnalysesContext.Provider, { value: analyses },
        element(ui.RealResumesContext.Provider, { value: resumes },
          element(ui.GradeNavigationContext.Provider, { value: guard },
            element('main', null, element(ui.Routes, null, element(ui.Route, { path, element: element(Page, props) }))))))))))
}
async function remount(Page, options) {
  if (root) { await act(async () => root.unmount()); root = null }
  await render(Page, options)
}
function button(label, within = document) {
  const found = [...within.querySelectorAll('button')].find((item) => item.textContent.trim() === label || item.getAttribute('aria-label') === label)
  assert.ok(found, `Button "${label}" exists`)
  return found
}
async function click(node) { assert.ok(node); await act(async () => node.click()) }
async function type(node, value) {
  assert.ok(node)
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(node, value)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
function dialog() { return document.querySelector('[role="dialog"]') }
function nameInput() { return dialog()?.querySelector('input') }
async function submit() {
  await act(async () => dialog().querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
}
async function escape() {
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
}
async function outside() {
  await settleFocus()
  await act(async () => {
    document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    document.body.click()
  })
}
async function settleFocus() { await act(async () => { await new Promise((done) => setTimeout(done, 10)) }) }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function RenameFixture({ target, name, etag, show = true, disabled = false }) {
  return element(ui.RenameEntityProvider, null,
    element('h1', { tabIndex: -1 }, 'Naming fixture'),
    show && element(ui.RenameEntityButton, { target, name, etag, disabled }))
}
function realResume(fields = {}) {
  return {
    workspaceId: 'workspace-one', etag: '"resume-open"', displayName: 'Review label',
    resume: { id: 'resume-real', dataKind: 'real', status: 'ready', name: null, role: 'Source role', location: null, experience: null,
      sourceLabel: 'not-a-person.pdf', documentId: 'resume-document', documentVersion: 1, createdAt: timestamp },
    source: { kind: 'pdf', displayName: 'not-a-person.pdf', fileName: 'not-a-person.pdf' },
    documentRef: { documentId: 'resume-document', documentVersion: 1, sha256: hash },
    updatedAt: timestamp, attempts: 1, retryCount: 0, warnings: [], duplicates: [], capture: null, ...fields,
  }
}
function resumeApi(summary = realResume(), fields = {}) {
  return { workspaceId: 'workspace-one', phase: 'ready', canWrite: true, features: { realResumeImports: true }, error: null,
    summaries: [summary], pending: () => false, refresh: noop, ensureDetail: noop, detail: () => ({ state: 'ready', value: summary }),
    batches: [], currentBatchId: null, originalUrl: () => '/private/resume-source', ...fields }
}
function realRun(fields = {}) {
  return { etag: '"run-open"', run: { id: 'run-real', name: 'Original creation name', displayName: 'Display analysis',
    workspaceId: 'workspace-one', dataKind: 'real', status: 'complete', createdAt: timestamp,
    progress: { total: 1, initialized: 1, complete: 1, scored: 1, unscored: 0, failed: 0, cancelled: 0, queued: 0, running: 0 }, ...fields } }
}
function analysisApi(summary = realRun(), fields = {}) {
  return { workspaceId: 'workspace-one', phase: 'ready', canWrite: true, features: { realAnalyses: true, analysisLimits: { maxComparisons: 500 } },
    error: null, creationError: null, summaries: [summary], pending: () => false, refresh: noop, refreshTargets: noop,
    detail: () => ({ state: 'ready', value: { ...summary, resumes: [], targets: [] } }),
    targets: { state: 'ready', value: [] }, ensureDetail: noop, ensureComparisons: noop,
    comparisons: () => ({ state: 'ready', value: [] }), ...fields }
}

test('name rules bound suggestions without treating filenames as source-stated people', () => {
  assert.equal(ui.defaultAnalysisName(1, ['Policy review']), 'Policy review - 1 resume')
  assert.equal(ui.defaultAnalysisName(4, ['Policy', 'Engineering', 'GS-12']), '4 resumes - 3 targets')
  assert.equal(ui.defaultAnalysisName(4, ['A'.repeat(200)]).length, 160)
  assert.equal(ui.normalizeDisplayName('  My review  '), 'My review')
  for (const value of ['', '  ', 'a'.repeat(161), 'line\nbreak', 'control\u0000name']) assert.throws(() => ui.normalizeDisplayName(value))
  const summary = realResume()
  assert.equal(ui.resumeName(summary), 'Review label')
  delete summary.displayName
  assert.equal(ui.resumeName(summary), 'Name not stated')
  assert.equal(summary.source.displayName, 'not-a-person.pdf')
})

test('editor focuses its labeled field, rejects blank names, and confirms dirty Cancel, X, Escape and outside dismissal', async () => {
  const workspace = context()
  const target = { kind: 'job', id: workspace.workspace.jobs[0].id }
  const props = { target, name: 'Original title' }
  await render(RenameFixture, { workspace, props })
  const trigger = button('Rename job: Original title')
  trigger.focus()
  await click(trigger)
  assert.equal(document.activeElement, nameInput())
  assert.equal(nameInput().maxLength, 160)
  assert.equal(blockers.size, 0)
  await type(nameInput(), ' ')
  await submit()
  assert.match(dialog().textContent, /must not be empty/)
  assert.equal(nameInput().getAttribute('aria-invalid'), 'true')
  assert.equal(calls.filter(([kind]) => kind === 'rename').length, 0)
  await type(nameInput(), 'Draft title')
  assert.equal([...blockers.values()][0].dirty, true)
  await click(button('Cancel', dialog()))
  await click(button('Close dialog', dialog()))
  await escape()
  await outside()
  assert.equal(nameInput().value, 'Draft title')
  assert.equal(calls.filter(([kind]) => kind === 'confirm-discard').length, 4)
  allowDiscard = true
  await escape()
  await settleFocus()
  assert.equal(dialog(), null)
  assert.equal(document.activeElement, trigger)
  assert.equal(blockers.size, 0)
})

test('pending submission prevents duplicate submit and all dismissal; errors preserve the draft and guard', async () => {
  const pending = deferred()
  const workspace = context(undefined, { renameEntity: (...args) => { calls.push(['rename', ...args]); return pending.promise } })
  const props = { target: { kind: 'resume', id: workspace.workspace.resumes[0].id }, name: 'Original label' }
  await render(RenameFixture, { workspace, props })
  await click(button('Rename resume: Original label'))
  await type(nameInput(), '  Draft label  ')
  await submit()
  await submit()
  await escape()
  await outside()
  assert.equal(button('Saving…', dialog()).disabled, true)
  assert.equal(button('Cancel', dialog()).disabled, true)
  assert.equal(button('Close dialog', dialog()).disabled, true)
  assert.equal([...blockers.values()][0].pending, true)
  assert.deepEqual(calls.filter(([kind]) => kind === 'rename'), [['rename', props.target, 'Draft label', undefined]])
  await act(async () => pending.reject(new Error('Server acknowledgement was lost.')))
  assert.equal(nameInput().value, '  Draft label  ')
  assert.match(dialog().textContent, /acknowledgement was lost/)
  assert.equal([...blockers.values()][0].pending, false)
  assert.equal([...blockers.values()][0].dirty, true)
  assert.equal(button('Save name', dialog()).disabled, false)
})

test('a synchronous rename failure retains dirty protection but allows confirmed navigation and Cancel', async () => {
  const workspace = context(undefined, { renameEntity: () => { throw new Error('The item is now read-only.') } })
  const props = { target: { kind: 'job', id: workspace.workspace.jobs[0].id }, name: 'Original title' }
  await render(RenameFixture, { workspace, props })
  await click(button('Rename job: Original title'))
  await type(nameInput(), 'Retained draft')
  await submit()
  assert.equal(nameInput().value, 'Retained draft')
  assert.equal([...blockers.values()][0].dirty, true)
  assert.equal([...blockers.values()][0].pending, false)
  assert.equal(await guard.confirmLeave(), false)
  allowDiscard = true
  assert.equal(await guard.confirmLeave(), true)
  await click(button('Cancel', dialog()))
  assert.equal(dialog(), null)
})

test('real editor snapshots the opened ETag; polling never replaces the draft or permits an implicit overwrite', async () => {
  const initial = realRun()
  let api = analysisApi(initial)
  const workspace = context(undefined, { cloud: { currentWorkspaceId: 'workspace-one' }, renameEntity: async (...args) => {
    calls.push(['rename', ...args])
    if (args[2] === '"run-open"') throw new Error('This analysis changed in another session.')
  } }, { analyses: [initial] })
  const props = { target: { kind: 'analysis', id: initial.run.id }, name: initial.run.displayName, etag: initial.etag }
  await render(RenameFixture, { workspace, analyses: api, props })
  await click(button('Rename analysis: Display analysis'))
  await type(nameInput(), 'My draft')
  const polled = { ...initial, etag: '"polled-version"', run: { ...initial.run, displayName: 'Another editor’s title' } }
  api = analysisApi(polled, { refresh: async () => { calls.push(['reload']) } })
  await render(RenameFixture, { workspace, analyses: api, props: { ...props, name: polled.run.displayName, etag: polled.etag } })
  assert.equal(nameInput().value, 'My draft')
  await submit()
  assert.equal(calls.find(([kind]) => kind === 'rename')[3], '"run-open"')
  assert.equal(nameInput().value, 'My draft')
  await click(button('Reload latest name', dialog()))
  assert.equal(nameInput().value, 'My draft')
  assert.equal([...blockers.values()][0].pending, false)
  assert.equal(button('Save name', dialog()).disabled, true)
  assert.match(dialog().textContent, /Latest saved name: Another editor’s title/)
  await click(button('Keep my draft and use this version', dialog()))
  await submit()
  assert.equal(calls.filter(([kind]) => kind === 'rename')[1][3], '"polled-version"')
  assert.equal(dialog(), null)
  assert.equal(blockers.size, 0)
})

test('an editor survives a filtered row disappearing and returns focus to the library search after acknowledgement', async () => {
  const pending = deferred()
  const data = ui.createInitialWorkspace()
  const run = data.runs[0]
  run.displayName = 'Find this exact review'
  const fields = { renameEntity: (...args) => { calls.push(['rename', ...args]); return pending.promise } }
  let workspace = context(data, fields)
  await render(ui.AnalysesPage, { workspace, url: '/analyses' })
  const search = document.querySelector('input[type="search"]')
  await type(search, run.displayName)
  const trigger = button(`Rename analysis: ${run.displayName}`)
  trigger.focus()
  await click(trigger)
  await type(nameInput(), 'Renamed out of the filter')
  await submit()
  const updated = structuredClone(data)
  updated.runs[0].displayName = 'Renamed out of the filter'
  workspace = context(updated, fields)
  await render(ui.AnalysesPage, { workspace, url: '/analyses' })
  assert.equal(trigger.isConnected, false)
  assert.equal(nameInput().value, 'Renamed out of the filter')
  assert.equal([...blockers.values()][0].pending, true)
  await act(async () => pending.resolve())
  await settleFocus()
  assert.equal(dialog(), null)
  assert.equal(document.activeElement, search)
  assert.equal(search.value, 'Find this exact review')
  assert.match(document.body.textContent, /No matching analyses/)
})

test('reload can acknowledge an uncertain real save that already matches the retained draft without resubmitting', async () => {
  const initial = realResume()
  let api = resumeApi(initial)
  const workspace = context(undefined, { cloud: { currentWorkspaceId: 'workspace-one' }, renameEntity: async (...args) => {
    calls.push(['rename', ...args])
    throw new Error('The response was lost.')
  } }, { resumes: [initial] })
  const props = { target: { kind: 'resume', id: initial.resume.id }, name: initial.displayName, etag: initial.etag }
  await render(RenameFixture, { workspace, resumes: api, props })
  await click(button('Rename resume: Review label'))
  await type(nameInput(), '  Already accepted label  ')
  await submit()
  api = resumeApi({ ...initial, etag: '"accepted"', displayName: 'Already accepted label' })
  await render(RenameFixture, { workspace, resumes: api, props })
  await click(button('Reload latest name', dialog()))
  assert.match(dialog().textContent, /No additional save is needed/)
  await click(button('Use saved name', dialog()))
  assert.equal(dialog(), null)
  assert.equal(calls.filter(([kind]) => kind === 'rename').length, 1)
  assert.equal(blockers.size, 0)
})

test('real resume service failure cannot unmount an active rename or replace its draft', async () => {
  const saved = realResume()
  const workspace = context(undefined, { cloud: { currentWorkspaceId: 'workspace-one' } }, { resumes: [saved] })
  await render(ui.RealResumesPage, { workspace, resumes: resumeApi(saved), url: '/resumes?data=real' })
  await click(button('Rename resume: Review label'))
  await type(nameInput(), 'Preserve this draft')
  await render(ui.RealResumesPage, { workspace, resumes: resumeApi(saved, { phase: 'unavailable', error: 'Service unavailable.' }), url: '/resumes?data=real' })
  assert.equal(nameInput().value, 'Preserve this draft')
  assert.equal(button('Save name', dialog()).disabled, true)
  assert.match(dialog().textContent, /now read-only or unavailable/)
  assert.equal([...blockers.values()][0].dirty, true)
})

test('real detail cache loading and error transitions preserve drafts and the ETag captured on open', async () => {
  const data = ui.createInitialWorkspace()
  const job = { ...data.jobs[0], dataKind: 'real' }
  data.jobs = [job]
  data.documents = []
  const savedResume = realResume()
  const savedRun = realRun()
  const savedJob = { job, displayName: 'Private role label', etag: '"job-open"', warnings: [] }
  const cases = [
    { kind: 'analysis', id: savedRun.run.id, name: savedRun.run.displayName, etag: savedRun.etag, Page: ui.RealAnalysisDetail,
      url: `/analyses/${savedRun.run.id}?data=real`, props: { id: savedRun.run.id } },
    { kind: 'resume', id: savedResume.resume.id, name: savedResume.displayName, etag: savedResume.etag, Page: ui.RealResumesPage,
      url: `/resumes/${savedResume.resume.id}?data=real`, props: { id: savedResume.resume.id } },
    { kind: 'job', id: job.id, name: savedJob.displayName, etag: savedJob.etag, Page: ui.JobDetail,
      url: `/jobs/${job.id}`, path: '/jobs/:id' },
  ]
  function options(item, state = 'ready') {
    const run = { ...savedRun, etag: state === 'ready' ? savedRun.etag : '"refreshed-run"' }
    const resume = { ...savedResume, etag: state === 'ready' ? savedResume.etag : '"refreshed-resume"' }
    const summary = { ...savedJob, etag: state === 'ready' ? savedJob.etag : '"refreshed-job"' }
    const load = (value) => state === 'ready' ? { state, value } : { state, error: state === 'error' ? 'Detail refresh failed.' : undefined }
    return {
      ...item,
      workspace: context(data, { cloud: { currentWorkspaceId: 'workspace-one', realJobs: {
        summaries: [summary], detail: () => load(summary),
      } } }, { resumes: [resume], analyses: [run] }),
      analyses: analysisApi(run, { detail: () => load({ ...run, resumes: [], targets: [] }) }),
      resumes: resumeApi(resume, { detail: () => load(resume) }),
    }
  }
  for (const item of cases) {
    await remount(item.Page, options(item))
    await click(button(`Rename ${item.kind}: ${item.name}`))
    await type(nameInput(), `Retained ${item.kind} draft`)
    for (const state of ['loading', 'error']) {
      await render(item.Page, options(item, state))
      assert.equal(nameInput().value, `Retained ${item.kind} draft`)
      assert.equal([...blockers.values()][0].dirty, true)
    }
    await submit()
    assert.deepEqual(calls.filter(([kind]) => kind === 'rename').at(-1),
      ['rename', { kind: item.kind, id: item.id }, `Retained ${item.kind} draft`, item.etag])
    assert.equal(dialog(), null)
  }
})

test('sample list and detail naming keeps source identities visible and archived names read-only', async () => {
  const data = ui.createInitialWorkspace()
  const job = data.jobs[0], resume = data.resumes[0], run = data.runs[0]
  job.displayName = 'A new job label'
  resume.displayName = 'A new resume label'
  run.displayName = 'A new analysis label'
  const workspace = context(data)
  await render(ui.JobsPage, { workspace, url: '/jobs' })
  assert.ok(button(`Rename job: ${job.displayName}`))
  assert.ok(document.body.textContent.includes(`Source title: ${job.title}`))
  await click(button('Job / organization', document.querySelector('thead')))
  assert.equal(document.querySelector('a.row-title').textContent, job.displayName)
  await type(document.querySelector('input[type="search"]'), job.displayName)
  assert.equal(document.querySelectorAll('tbody tr').length, 1)
  await remount(ui.JobDetail, { workspace, url: `/jobs/${job.id}`, path: '/jobs/:id' })
  assert.equal(document.querySelector('h1').textContent, job.displayName)
  assert.match(document.body.textContent, /Original source:/)
  await remount(ui.ResumesPage, { workspace, url: '/resumes' })
  assert.equal(document.querySelectorAll(`[aria-label="Rename resume: ${resume.displayName}"]`).length, 2)
  assert.ok(document.body.textContent.includes(`Source name: ${resume.name}`))
  await click(button('Candidate', document.querySelector('thead')))
  assert.equal(document.querySelector('a.row-title').textContent, resume.displayName)
  await remount(ui.ResumesPage, { workspace, url: `/resumes/${resume.id}`, path: '/resumes/:id' })
  assert.equal(document.querySelector('h1').textContent, resume.displayName)
  assert.match(document.body.textContent, /Original filename:/)
  await remount(ui.AnalysisDetail, { workspace, url: `/analyses/${run.id}`, path: '/analyses/:id' })
  assert.equal(document.querySelector('h1').textContent, run.displayName)
  assert.equal(button(`Rename analysis: ${run.displayName}`).disabled, false)
  data.lifecycle = { entities: { [`analysis:${run.id}`]: { archivedAt: timestamp } } }
  await render(ui.AnalysisDetail, { workspace: context(data), url: `/analyses/${run.id}`, path: '/analyses/:id' })
  assert.equal(button(`Rename analysis: ${run.displayName}`).disabled, true)
  assert.equal(data.jobs[0].title, job.title)
  assert.equal(data.resumes[0].name, resume.name)
})

test('real analysis rename stays available with creation disabled and uses the summary ETag on history and detail', async () => {
  const saved = realRun()
  const api = analysisApi(saved, { features: { realAnalyses: false }, creationError: 'New inputs unavailable.' })
  const workspace = context(undefined, { cloud: { currentWorkspaceId: 'workspace-one' } }, { analyses: [saved] })
  await render(ui.RealAnalysesPage, { workspace, analyses: api, url: '/analyses?data=real' })
  assert.equal(button('New analysis').disabled, true)
  await click(button('Rename analysis: Display analysis'))
  await type(nameInput(), 'History rename')
  await submit()
  assert.deepEqual(calls.find(([kind]) => kind === 'rename'), ['rename', { kind: 'analysis', id: saved.run.id }, 'History rename', saved.etag])
  await remount(ui.RealAnalysisDetail, { workspace, analyses: api, url: `/analyses/${saved.run.id}?data=real`, props: { id: saved.run.id } })
  assert.equal(document.querySelector('h1').textContent, 'Display analysis')
  assert.equal(button('Rename analysis: Display analysis').disabled, false)
  await render(ui.RealAnalysisDetail, { workspace, analyses: { ...api, canWrite: false }, props: { id: saved.run.id } })
  assert.equal(button('Rename analysis: Display analysis').disabled, true)
})

test('real jobs and resumes use wrapper aliases, preserve stated identities, and send summary ETags', async () => {
  const data = ui.createInitialWorkspace()
  const job = { ...data.jobs[0], dataKind: 'real' }
  const jobSummary = { job, displayName: 'Private role label', etag: '"job-version"', warnings: [] }
  data.jobs = [job]
  const saved = realResume()
  const resumes = resumeApi(saved)
  const workspace = context(data, { cloud: { currentWorkspaceId: 'workspace-one', realJobs: { summaries: [jobSummary] } } }, { resumes: [saved] })
  await render(ui.JobsPage, { workspace, url: '/jobs' })
  assert.equal(document.querySelector('a.row-title').textContent, jobSummary.displayName)
  await click(button('Rename job: Private role label'))
  await type(nameInput(), 'Edited private role')
  await submit()
  assert.equal(calls.find(([kind]) => kind === 'rename')[3], '"job-version"')
  await remount(ui.JobDetail, { workspace, url: `/jobs/${job.id}`, path: '/jobs/:id' })
  assert.equal(document.querySelector('h1').textContent, jobSummary.displayName)
  await remount(ui.RealResumesPage, { workspace, resumes, url: '/resumes?data=real' })
  assert.equal(document.querySelector('a.row-title').textContent, 'Review label')
  assert.match(document.body.textContent, /Source name: Name not stated/)
  await type(document.querySelector('input[type="search"]'), 'not-a-person.pdf')
  assert.equal(document.querySelectorAll('tbody tr').length, 1)
  await click(button('Rename resume: Review label'))
  await type(nameInput(), 'Edited resume label')
  await submit()
  assert.equal(calls.filter(([kind]) => kind === 'rename')[1][3], saved.etag)
  await remount(ui.RealResumesPage, { workspace, resumes, props: { id: saved.resume.id }, url: `/resumes/${saved.resume.id}?data=real` })
  assert.equal(document.querySelector('h1').textContent, 'Review label')
  assert.match(document.body.textContent, /Source name: Name not stated · Original source: not-a-person.pdf/)
})

test('analysis browsing uses captured labels only; current source renames do not rewrite comparisons', () => {
  const data = ui.createInitialWorkspace()
  const run = structuredClone(data.runs.find((item) => item.targets.length === 1))
  run.displayName = 'Current analysis label'
  run.targets[0].displayName = 'Captured target label'
  run.resumes[0].resume.displayName = 'Captured resume label'
  data.jobs.forEach((item) => { item.displayName = 'Live job label' })
  data.resumes.forEach((item) => { item.displayName = 'Live resume label' })
  const original = JSON.stringify(run)
  assert.equal(ui.selectSampleAnalysisRuns([run], 'current ANALYSIS', 'all', null).length, 1)
  assert.equal(ui.selectSampleAnalysisRuns([run], run.name, 'all', null).length, 0)
  assert.equal(ui.selectSampleComparisons(run, { query: 'captured resume label', targetId: '', sort: null }).rows.length, 1)
  assert.equal(ui.selectSampleComparisons(run, { query: 'live resume label', targetId: '', sort: null }).rows.length, 0)
  assert.match(ui.sampleComparisonTargetLabel(run.targets[0]), /^Captured target label/)
  assert.equal(JSON.stringify(run), original)
  const saved = realRun()
  assert.equal(ui.selectRealAnalysisRuns([saved], 'Display analysis', 'all', null).length, 1)
  const pair = { comparison: { index: 0, status: 'complete', resume: { summary: { name: null, displayName: 'Captured real label', sourceLabel: 'original.pdf' } },
    target: { summary: { id: 'captured-target', label: 'Source job title', displayName: 'Captured real target', sublabel: 'Frozen scope',
      selection: { kind: 'job', jobId: 'j', rubricId: 'r', rubricVersion: 1 } } } } }
  assert.equal(ui.selectRealComparisons([pair], [], { query: 'captured real label', targetId: '', sort: { key: 'name', direction: 'asc' } }).rows.length, 1)
  assert.equal(ui.selectRealComparisons([pair], [], { query: 'original.pdf', targetId: '', sort: null }).rows.length, 1)
  assert.equal(ui.selectRealComparisons([pair], [], { query: 'live job label', targetId: '', sort: null }).rows.length, 0)
})

test('sample setup suggests alias-and-count defaults, keeps custom input, and only submits manually', async () => {
  const data = ui.createInitialWorkspace()
  const job = data.jobs.find((item) => item.status === 'ready' && item.rubricId)
  job.displayName = 'Program analyst shortlist'
  data.resumes[0].displayName = 'Applicant review label'
  const workspace = context(data, { startAnalysis: (...args) => { calls.push(['start', ...args]); return 'new-sample-run' } })
  const url = `/analyses/new?resumes=${data.resumes[0].id}&rubrics=${job.rubricId}`
  await render(ui.AnalysisSetup, { workspace, url })
  const input = document.querySelector('input[maxlength="160"]')
  assert.equal(input.placeholder, 'Program analyst shortlist - 1 resume')
  assert.equal(calls.length, 0)
  assert.ok(document.querySelector('[aria-label="Include Applicant review label"]'))
  await type(input, '  My intentional title  ')
  await click(document.querySelector(`[aria-label="Include ${data.resumes[1].name}"]`))
  assert.equal(input.value, '  My intentional title  ')
  assert.equal(input.placeholder, 'Program analyst shortlist - 2 resumes')
  await click(button('Run sample analysis'))
  assert.equal(calls.find(([kind]) => kind === 'start')[3], 'My intentional title')
  await remount(ui.AnalysisSetup, { workspace, url })
  await click(button('Run sample analysis'))
  assert.equal(calls.filter(([kind]) => kind === 'start')[1][3], 'Program analyst shortlist - 1 resume')
})

test('real setup freezes the resolved default, exact input objects and key across uncertain acceptance retries', async () => {
  const data = ui.createInitialWorkspace()
  const job = { ...data.jobs.find((item) => item.status === 'ready' && item.rubricId), dataKind: 'real' }
  data.jobs = [job]
  const rubric = data.rubrics.find((item) => item.id === job.rubricId)
  const target = { id: 'real-target', workspaceId: 'workspace-one', dataKind: 'real', kind: 'job', label: job.title,
    displayName: 'Cloud program analyst', sublabel: 'Source organization', rubricId: rubric.id, rubricVersion: rubric.version, criterionCount: 3,
    selection: { kind: 'job', jobId: job.id, rubricId: rubric.id, rubricVersion: rubric.version, rubricHash: hash,
      documentId: job.documentId, documentVersion: 1, documentSha256: hash } }
  const saved = realResume()
  const resumes = resumeApi(saved)
  let retained
  const api = analysisApi(undefined, { summaries: [], targets: { state: 'ready', value: [target] },
    requestKey: (input) => { calls.push(['key', structuredClone(input)]); return 'fixed-request-key' },
    create: async (input, key) => {
      retained = { input: structuredClone(input), key }
      calls.push(['create', structuredClone(input), key])
      throw new Error('Acceptance uncertain.')
    },
    hasRetainedCreation: (input, key) => retained?.key === key && JSON.stringify(retained.input) === JSON.stringify(input),
    recoverCreation: (input, key) => {
      assert.equal(api.hasRetainedCreation(input, key), true)
      return api.create(input, key)
    },
  })
  const workspace = context(data, {}, { resumes: [saved] })
  const url = `/analyses/new?data=real&resumes=${saved.resume.id}&jobs=${job.id}`
  await render(ui.RealAnalysisSetup, { workspace, analyses: api, resumes, url })
  const input = document.querySelector('input[maxlength="160"]')
  assert.equal(input.placeholder, 'Cloud program analyst - 1 resume')
  assert.equal(calls.length, 0)
  assert.match(document.body.textContent, /Source name: Name not stated/)
  await click(button('Run analysis'))
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1)
  assert.equal(input.disabled, true)
  assert.match(document.body.textContent, /same request key on retry/)
  target.displayName = 'A later live label'
  target.selection.documentVersion = 2
  await render(ui.RealAnalysisSetup, { workspace, analyses: { ...api }, resumes, url })
  assert.equal(input.placeholder, 'Cloud program analyst - 1 resume')
  await click(button('Retry unchanged submission'))
  const requests = calls.filter(([kind]) => kind === 'create')
  assert.deepEqual(requests[1], requests[0])
  assert.equal(requests[0][1].targets[0].documentVersion, 1)
  assert.equal(requests[0][1].name, 'Cloud program analyst - 1 resume')
  assert.equal(calls.filter(([kind]) => kind === 'key').length, 1)
  assert.equal(calls.filter(([kind]) => kind === 'rename').length, 0)
})
