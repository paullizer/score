import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { frontendWorkspaceContext } from './frontend.test-support.mjs'

const directory = resolve(`.real-lifecycle-tests-${randomUUID()}`)
const workspaceId = 'workspace-one'
const timestamp = '2026-09-18T19:00:00.000Z'
const hash = 'a'.repeat(64)
const originals = new Map()
const nativeFetch = globalThis.fetch
const clone = (value) => structuredClone(value)
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const json = (body, status = 200, etag) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) },
})
let ui, dom, root, createRoot, current, state, parent, navigation

function resume(id = 'resume-word', name = 'Ada 10', kind = 'docx', lifecycle) {
  const document = { id: `document-${id}`, version: 1, kind: 'resume', sample: false, title: 'Private source',
    paragraphs: [{ id: 'p1', page: 1, heading: 'Experience', text: 'Documented engineering work from the captured source.' }] }
  return {
    workspaceId, resume: { id, dataKind: 'real', name, role: 'Engineer', location: null, experience: null,
      documentId: document.id, documentVersion: 1, sourceLabel: `${id}.${kind}`, batchId: randomUUID(), status: 'ready', createdAt: timestamp },
    source: { kind, displayName: `${id}.${kind}`, fileName: `${id}.${kind}` }, lifecycle,
    capture: { original: { blobName: `${workspaceId}/${id}/original.${kind}`, sha256: hash, bytes: 100,
      contentType: kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown' }, capturedAt: timestamp, redirects: [] },
    documentRef: { documentId: document.id, documentVersion: 1, sha256: hash, bytes: 200, contentType: 'application/json', blobName: `${workspaceId}/${id}/document.json` },
    etag: `"${id}-1"`, updatedAt: timestamp, attempts: 1, retryCount: 0, warnings: [], duplicates: [],
    document, profile: null, extraction: { pagination: kind === 'docx' ? 'captured-sections' : 'markdown-sections', method: kind === 'docx' ? 'document-intelligence' : 'markdown', version: 'fixture', pageCount: null },
  }
}

function target() {
  return { id: 'target-one', kind: 'job', workspaceId, dataKind: 'real', label: 'Engineering role', sublabel: 'Captured requirements',
    rubricId: 'rubric-one', rubricVersion: 1, criterionCount: 1,
    selection: { kind: 'job', jobId: 'job-one', rubricId: 'rubric-one', rubricVersion: 1, rubricHash: hash,
      documentId: 'job-document', documentVersion: 1, documentSha256: hash } }
}

function analysis(id = 'run-one', status = 'running', lifecycle) {
  const source = resume()
  return {
    run: { id, recordType: 'analysis-run', workspaceId, dataKind: 'real', name: 'Evidence review', createdAt: timestamp, updatedAt: timestamp,
      status, lifecycle, attempts: 1, retryCount: 0, initialization: { nextComparisonIndex: 1, completedAt: timestamp },
      progress: { total: 1, initialized: 1, queued: 0, running: status === 'running' ? 1 : 0, complete: status === 'complete' ? 1 : 0,
        failed: 0, cancelled: status === 'cancelled' ? 1 : 0, scored: status === 'complete' ? 1 : 0, unscored: 0 } },
    etag: `"${id}-1"`, lifecycle,
    resumes: [{ workspaceId, dataKind: 'real', selection: { resumeId: source.resume.id, documentId: source.document.id, documentVersion: 1, documentSha256: hash },
      name: source.resume.name, role: source.resume.role, sourceLabel: source.source.displayName, capturedAt: timestamp }],
    targets: [target()],
  }
}

function comparison(run = analysis()) {
  const source = resume()
  return {
    etag: '"comparison-1"',
    comparison: { id: 'pair-one', workspaceId, dataKind: 'real', runId: run.run.id, index: 0, status: 'running', attempts: 1, retryCount: 0,
      resume: { snapshotId: 'frozen-resume', summary: run.resumes[0] }, target: { snapshotId: 'frozen-target', summary: run.targets[0] } },
    resumeSnapshot: { dataKind: 'real', workspaceId, resume: source.resume, document: source.document, extraction: source.extraction },
    targetSnapshot: { dataKind: 'real', workspaceId, kind: 'job', document: { ...source.document, id: 'job-document', kind: 'job' },
      rubric: { dataKind: 'real', criteria: [] }, summary: target(), selection: target().selection },
    result: null,
  }
}

before(async () => {
  await mkdir(directory)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
    DocumentFragment: dom.window.DocumentFragment, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle, localStorage: dom.window.localStorage, CSS: { escape: (value) => value }, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export * from './src/services/realResumes'
      export * from './src/services/realAnalyses'
      export { WorkspaceContext, useWorkspace } from './src/app/workspace-context'
      export { RealResumesBridge } from './src/app/RealResumesBridge'
      export { RealAnalysesBridge } from './src/app/RealAnalysesBridge'
      export { useRealResumes } from './src/app/real-resumes-context'
      export { useRealAnalyses } from './src/app/real-analyses-context'
      export { LifecycleDialogProvider, LifecycleOperationBanner } from './src/components/lifecycle/LifecycleControls'
      export { ResumesPage } from './src/features/resumes/ResumesPage'
      export { AnalysesPage, AnalysisSetup, AnalysisDetail } from './src/features/analyses/AnalysesPage'
      export { realTargetAvailable, realTargetArchived, resumeSelectionIssue, targetSelectionIssue } from './src/features/analyses/realAnalysisUi'
      export { gradeHeadId } from './src/domain/real-grades'
      export { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
    ` },
    outfile: join(directory, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', jsx: 'automatic',
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' }, logLevel: 'silent',
  })
  ui = await import(pathToFileURL(join(directory, 'ui.mjs')).href)
})

beforeEach(() => {
  current = null
  const run = analysis()
  state = { resumes: [resume()], analyses: [run], pairs: [comparison(run)], requests: [], responses: [], read: null, reads: new Map(), revision: 1 }
  parent = frontendWorkspaceContext({ cloud: { currentWorkspaceId: workspaceId } })
  dom.window.localStorage.clear()
  globalThis.fetch = async (url, init) => {
    const path = new URL(url, 'https://score.test').pathname
    const method = init.method ?? 'GET'
    state.requests.push({ path, method, headers: init.headers, body: init.body })
    if (path === '/api/features') return json({ realResumeImports: true, realAnalyses: true, markdownResumeImports: true, wordDocumentImports: true })
    const root = `/api/workspaces/${workspaceId}`
    if (path === `${root}/resumes`) return json({ resumes: clone(state.resumes) })
    if (path === `${root}/analyses` && method === 'GET') return json({ runs: clone(state.analyses) })
    if (path === `${root}/analyses/targets`) return json({ targets: [target()] })
    const match = new RegExp(`^${root}/(resumes|analyses)/([^/]+)(.*)$`).exec(path)
    assert.ok(match, `Unexpected frontend request ${method} ${path}`)
    const [, collection, id, suffix] = match
    const record = state[collection].find((item) => (item.resume ?? item.run).id === id)
    if (!record) return json({ error: { code: 'not_found', message: 'This private record is no longer available.' } }, 404)
    if (method === 'GET' && state.reads.has(path)) {
      const read = state.reads.get(path)
      state.reads.delete(path)
      return read()
    }
    if (suffix === '/lifecycle') {
      if (method === 'GET') return json({ impact: {
        target: { kind: collection === 'resumes' ? 'resume' : 'analysis', id }, name: (record.resume ?? record.run).name,
        counts: { records: 1 }, blockers: collection === 'resumes' ? state.analyses.filter((run) => run.resumes.some((item) => item.selection.resumeId === id))
          .map((item) => ({ kind: 'analysis', id: item.run.id, name: item.run.name, href: `/analyses/${item.run.id}?data=real` })) : [],
      } })
      assert.equal(init.headers.get('If-Match'), record.etag, 'Lifecycle mutations use the freshly read exact target ETag')
      const { action } = JSON.parse(init.body)
      if (action === 'delete' && collection === 'resumes' && state.analyses.some((run) => run.resumes.some((item) => item.selection.resumeId === id))) {
        return json({ error: { code: 'conflict', message: 'Delete the retained analysis, including archived runs, first.' } }, 409)
      }
      const queued = state.responses.shift()
      if (queued) return queued({ record, collection, action })
      if (action === 'delete') {
        state[collection] = state[collection].filter((item) => (item.resume ?? item.run).id !== id)
        return json({ deleted: true })
      }
      record.lifecycle = action === 'archive' ? { archivedAt: timestamp } : {}
      if (record.run) record.run.lifecycle = record.lifecycle
      delete record.lifecycleOperation
      delete record.operation
      record.etag = `"revision-${++state.revision}"`
      return json({ [collection === 'resumes' ? 'resume' : 'analysis']: clone(record) })
    }
    if (suffix === '/comparisons') return json({ comparisons: clone(state.pairs) })
    if (suffix === '/comparisons/pair-one') return json(clone(state.pairs[0]))
    if (!suffix) {
      const read = state.read
      if (read) { state.read = null; return read(record) }
      return json(clone(record))
    }
    return json({ error: { code: 'invalid_request', message: 'No new processing was expected.' } }, 400)
  }
})

afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; await new Promise((resolve) => setTimeout(resolve, 0)) }
})
after(async () => {
  globalThis.fetch = nativeFetch
  dom.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(directory, { recursive: true, force: true })
})

function Probe() {
  current = { resumes: ui.useRealResumes(), analyses: ui.useRealAnalyses(), workspace: ui.useWorkspace() }
  navigation = ui.useNavigate()
  return null
}
async function mount(path = '/resumes') {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => root.render(React.createElement(ui.MemoryRouter, { initialEntries: [path], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    React.createElement(ui.WorkspaceContext.Provider, { value: parent },
      React.createElement(ui.RealResumesBridge, { workspaceId }, React.createElement(ui.RealAnalysesBridge, { workspaceId },
        React.createElement(ui.LifecycleDialogProvider, null,
          React.createElement(Probe), React.createElement(ui.LifecycleOperationBanner),
          React.createElement(ui.Routes, null,
            React.createElement(ui.Route, { path: '/resumes', element: React.createElement(ui.ResumesPage) }),
            React.createElement(ui.Route, { path: '/resumes/:id', element: React.createElement(ui.ResumesPage) }),
            React.createElement(ui.Route, { path: '/analyses', element: React.createElement(ui.AnalysesPage) }),
            React.createElement(ui.Route, { path: '/analyses/new', element: React.createElement(ui.AnalysisSetup) }),
            React.createElement(ui.Route, { path: '/analyses/:id', element: React.createElement(ui.AnalysisDetail) }),
          ))))))))
  await settle(() => current?.resumes.phase === 'ready' && current?.analyses.phase === 'ready')
}
async function settle(predicate) {
  for (let index = 0; index < 80 && !predicate(); index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.ok(predicate(), 'Expected combined real lifecycle UI state')
}
async function navigate(path) { await act(async () => navigation(path)) }
async function click(label, within = document) {
  const button = [...within.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent.trim() === label)
  assert.ok(button, label)
  await act(async () => button.click())
}
async function search(label, value) {
  const input = document.querySelector(`input[aria-label="${label}"]`)
  assert.ok(input, label)
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

test('real lifecycle clients retain 202 and explicit failed envelopes, aliases and exact target ETags', async () => {
  for (const [kind, get, change] of [
    ['resume', ui.getRealResumeLifecycleImpact, ui.changeRealResumeLifecycle],
    ['analysis', ui.getRealAnalysisLifecycleImpact, ui.changeRealAnalysisLifecycle],
  ]) {
    const requests = []
    const operation = { id: randomUUID(), action: 'delete', status: 'running', updatedAt: timestamp }
    globalThis.fetch = async (path, init) => {
      requests.push({ path, init })
      return init.method === 'POST' ? json({ operation }, 202, '"pending-version"') : json({ impact: { target: { kind, id: 'private / id' }, name: 'Private target', counts: {}, blockers: [] } })
    }
    assert.equal((await get('workspace / one', 'private / id')).target.kind, kind)
    const pending = await change('workspace / one', 'private / id', 'delete', '"exact-target"')
    assert.equal(pending.operation.status, 'running')
    assert.equal(pending.deleted, undefined)
    assert.equal(pending.etag, '"pending-version"')
    assert.match(requests[0].path, /workspace%20%2F%20one.*private%20%2F%20id\/lifecycle$/)
    assert.equal(requests[1].init.headers.get('If-Match'), '"exact-target"')
    assert.deepEqual(JSON.parse(requests[1].init.body), { action: 'delete' })
    globalThis.fetch = async () => json({ operation: { ...operation, status: 'failed', error: 'Cleanup needs retry.' } }, 503)
    assert.equal((await change(workspaceId, 'id', 'delete', '"fresh"')).operation.status, 'failed')
    globalThis.fetch = async () => json({ deleted: true }, 202)
    await assert.rejects(change(workspaceId, 'id', 'delete', '"fresh"'), /not acknowledged/)
    await assert.rejects(change(workspaceId, 'id', 'delete', ''), /exact/)
  }
})

test('default cloud resume mode combines archive search, sorting, Word evidence and isolated real contexts', async () => {
  state.resumes.push(resume('resume-markdown', 'Zeta 2', 'markdown', { archivedAt: timestamp }))
  const original = JSON.stringify(parent.workspace)
  await mount()
  assert.match(document.querySelector('tbody').textContent, /Ada 10/)
  assert.doesNotMatch(document.querySelector('tbody').textContent, /Zeta 2/)
  await search('Search real resumes', 'Zeta')
  const archived = document.querySelector('tbody tr')
  assert.match(archived.textContent, /Archived.*Markdown/s)
  assert.equal(archived.querySelector('input[type="checkbox"]').disabled, true)
  const filter = document.querySelector('select[aria-label="Real resume archive state"]')
  await act(async () => { filter.value = 'all'; filter.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  await search('Search real resumes', '')
  const header = document.querySelector('thead th button[aria-label^="Sort Stated name"]')
  await act(async () => header.click())
  assert.deepEqual([...document.querySelectorAll('tbody a.row-title')].map((item) => item.textContent), ['Ada 10', 'Zeta 2'])
  await navigate('/resumes/resume-word?data=real')
  await settle(() => document.querySelector('.document-viewer'))
  assert.match(document.body.textContent, /Formatted Word preview/)
  assert.match(document.querySelector('.document-viewer').textContent, /Captured source section 1/)
  assert.match(document.querySelector('a[download]').href, /\/api\/workspaces\/workspace-one\/resumes\/resume-word\/original$/)
  assert.equal(current.workspace.workspace.resumes.length, 0)
  assert.equal(current.workspace.workspace.runs.length, 0)
  assert.equal(current.workspace.workspace.documents.length, 0)
  assert.equal(current.workspace.workspace.lifecycle.entities['resume:resume-markdown'].archivedAt, timestamp)
  assert.equal(JSON.stringify(parent.workspace), original)
  assert.equal(dom.window.localStorage.length, 0)
})

test('input archive preserves in-progress real snapshots and archived analyses remain deletion blockers', async () => {
  const before = clone(state.analyses[0])
  const pair = clone(state.pairs[0])
  await mount('/analyses')
  await act(async () => {
    await current.analyses.ensureDetail('run-one')
    await current.analyses.ensureComparisons('run-one')
    await current.analyses.ensureComparison('run-one', 'pair-one')
    await current.workspace.changeLifecycle({ kind: 'resume', id: 'resume-word' }, 'archive')
  })
  assert.deepEqual(state.analyses[0], before)
  assert.deepEqual(current.analyses.comparison('run-one', 'pair-one').value, pair)
  assert.equal(current.analyses.canWrite, true)
  await act(async () => current.workspace.changeLifecycle({ kind: 'analysis', id: 'run-one' }, 'archive'))
  assert.equal(document.querySelector('tbody'), null, 'An archived run is hidden from ordinary history')
  await search('Find a real analysis…', 'Evidence')
  assert.match(document.querySelector('tbody').textContent, /Archived/)
  const impact = await current.workspace.getLifecycleImpact({ kind: 'resume', id: 'resume-word' })
  assert.deepEqual(impact.blockers.map((item) => item.id), ['run-one'])
  await act(async () => assert.rejects(current.workspace.changeLifecycle({ kind: 'resume', id: 'resume-word' }, 'delete'), /changed in another session/))
  await navigate('/analyses/run-one?data=real')
  assert.equal([...document.querySelectorAll('button')].find((item) => item.textContent === 'New run with these inputs').disabled, true)
  assert.equal([...document.querySelectorAll('button')].find((item) => item.textContent === 'Cancel unfinished').disabled, true)
  assert.deepEqual(current.analyses.detail('run-one').value.resumes, before.resumes)
  assert.deepEqual(current.analyses.detail('run-one').value.targets, before.targets)
  assert.equal(state.requests.some((item) => /\/(retry|cancel)$/.test(item.path)), false)
})

test('real lifecycle dialog survives filtered rows and incomplete acknowledgement; retry refreshes the exact ETag', async () => {
  state.analyses = []
  state.responses.push(({ record }) => {
    const operation = { id: record.resume.id, action: 'archive', status: 'running', updatedAt: timestamp }
    record.lifecycle = { archivedAt: timestamp }; record.lifecycleOperation = operation; record.etag = '"archive-pending"'
    return json({ resume: clone(record), operation }, 202)
  })
  await mount()
  await click('Archive Ada 10')
  await settle(() => document.querySelector('[role="dialog"] button.button-primary:not(:disabled)'))
  await click('Archive', document.querySelector('[role="dialog"]'))
  await settle(() => document.querySelector('[role="dialog"]')?.textContent.includes('Retry operation'))
  assert.equal(document.querySelector('tbody'), null)
  assert.ok(document.querySelector('[role="dialog"]'), 'The stable dialog stays mounted after its row disappears')
  assert.match(document.body.textContent, /operation remains pending/)
  state.resumes[0].etag = '"new-authoritative-version"'
  await click('Retry operation', document.querySelector('[role="dialog"]'))
  await settle(() => !document.querySelector('[role="dialog"]'))
  const posts = state.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/lifecycle'))
  assert.equal(posts.length, 2)
  assert.equal(posts[1].headers.get('If-Match'), '"new-authoritative-version"')
  assert.equal(current.workspace.lifecycleOperations.length, 0)
  assert.equal(current.workspace.workspace.resumes.length, 0)
})

test('cold deletion recovery clears documents, discovers pending status and never reports success on 202', async () => {
  state.analyses = []
  const record = state.resumes[0]
  record.lifecycle = { deletingAt: timestamp }
  record.lifecycleOperation = { id: record.resume.id, action: 'delete', status: 'failed', updatedAt: timestamp, error: 'Blob cleanup is incomplete.' }
  record.document = null; record.capture = null; record.documentRef = null
  await mount('/resumes/resume-word')
  await settle(() => current.workspace.lifecycleOperations.length === 1)
  assert.match(document.body.textContent, /Blob cleanup is incomplete/)
  assert.equal(document.querySelector('.document-viewer'), null)
  assert.equal(document.querySelector('a[download]'), null)
  await click('Retry lifecycle operation')
  await settle(() => current.workspace.lifecycleOperations.length === 0 && current.resumes.summaries.length === 0)
  assert.equal(current.resumes.detail('resume-word').state, 'error')
})

test('pending real analysis deletion clears frozen caches, locks only that run and retries its current run ETag', async () => {
  await mount('/analyses/run-one?data=real')
  await act(async () => current.analyses.ensureComparison('run-one', 'pair-one'))
  state.responses.push(({ record }) => {
    const operation = { id: randomUUID(), action: 'delete', status: 'failed', updatedAt: timestamp, error: 'Analysis cleanup is incomplete.' }
    record.lifecycle = { deletingAt: timestamp }; record.run.lifecycle = record.lifecycle; record.operation = operation
    record.etag = '"deletion-run-version"'; record.resumes = []; record.targets = []
    return json({ operation, etag: record.etag }, 202)
  })
  await act(async () => assert.rejects(current.workspace.changeLifecycle({ kind: 'analysis', id: 'run-one' }, 'delete'), /incomplete/))
  assert.equal(current.analyses.detail('run-one').state, 'error')
  assert.equal(current.analyses.comparison('run-one', 'pair-one').state, 'idle')
  assert.equal(current.resumes.summaries[0].resume.status, 'ready')
  assert.equal(current.resumes.canWrite, true)
  await assert.rejects(current.workspace.changeLifecycle({ kind: 'analysis', id: 'run-one' }, 'unarchive'), /Finish the incomplete/)
  state.analyses[0].etag = '"latest-run-recovery"'
  await act(async () => current.workspace.changeLifecycle({ kind: 'analysis', id: 'run-one' }, 'delete'))
  assert.equal(state.requests.filter((item) => item.method === 'POST').at(-1).headers.get('If-Match'), '"latest-run-recovery"')
  assert.equal(current.workspace.lifecycleOperations.length, 0)
  assert.equal(current.analyses.summaries.length, 0)
  assert.equal(current.workspace.workspace.runs.length, 0)
})

test('real restore changes only the item flag under an archived workspace and viewer lifecycle writes stay blocked', async () => {
  parent.cloud.workspaces[0].archivedAt = timestamp
  parent.workspace.lifecycle.archivedAt = timestamp
  state.resumes[0].lifecycle = { archivedAt: timestamp }
  await mount()
  assert.equal(current.resumes.canWrite, false)
  assert.equal(current.analyses.canWrite, false)
  await assert.rejects(current.resumes.retry('resume-word', state.resumes[0].etag), /archived, read-only/)
  await act(async () => current.workspace.changeLifecycle({ kind: 'resume', id: 'resume-word' }, 'unarchive'))
  assert.equal(current.workspace.workspace.lifecycle.entities['resume:resume-word'].archivedAt, undefined)
  assert.equal(current.workspace.workspace.lifecycle.archivedAt, timestamp)
  assert.equal(current.resumes.canWrite, false)
  const count = state.requests.filter((item) => item.method === 'POST').length
  parent = { ...parent, cloud: { ...parent.cloud, workspaces: [{ ...parent.cloud.workspaces[0], role: 'viewer' }] } }
  await mount()
  await assert.rejects(current.workspace.changeLifecycle({ kind: 'resume', id: 'resume-word' }, 'archive'), /read-only/)
  await assert.rejects(current.workspace.changeLifecycle({ kind: 'analysis', id: 'run-one' }, 'archive'), /read-only/)
  assert.equal(state.requests.filter((item) => item.method === 'POST').length, count)
})

test('authoritative lists evict deleted real caches and late detail responses cannot revive archived input state', async () => {
  await mount()
  await act(async () => {
    await current.resumes.ensureDetail('resume-word')
    await current.analyses.ensureDetail('run-one')
    await current.analyses.ensureComparisons('run-one')
    await current.analyses.ensureComparison('run-one', 'pair-one')
  })
  const late = deferred()
  const stale = clone(state.resumes[0])
  state.read = () => late.promise
  let read
  await act(async () => { read = current.resumes.ensureDetail('resume-word', true) })
  await act(async () => current.workspace.changeLifecycle({ kind: 'resume', id: 'resume-word' }, 'archive'))
  await act(async () => { late.resolve(json(stale)); await read })
  assert.equal(current.resumes.summaries[0].lifecycle.archivedAt, timestamp)
  state.resumes = []; state.analyses = []
  await act(async () => { await current.resumes.refresh(); await current.analyses.refresh() })
  assert.equal(current.resumes.summaries.length, 0)
  assert.equal(current.resumes.detail('resume-word').state, 'error')
  assert.equal(current.analyses.summaries.length, 0)
  assert.equal(current.analyses.detail('run-one').state, 'error')
  assert.equal(current.analyses.comparisons('run-one').state, 'idle')
  assert.equal(current.analyses.comparison('run-one', 'pair-one').state, 'idle')
  await assert.rejects(current.analyses.document('run-one', 'pair-one', 'document-resume-word', 1), /unavailable/)
})

test('authoritative refresh overlapping retained detail reads settles current resume, run and comparison views', async () => {
  state.analyses = [analysis('run-one', 'complete')]
  state.pairs = [comparison(state.analyses[0])]
  state.pairs[0].comparison.status = 'complete'
  await mount()
  const base = `/api/workspaces/${workspaceId}`
  const reads = [
    { path: `${base}/resumes/resume-word`, value: clone(state.resumes[0]), start: () => current.resumes.ensureDetail('resume-word') },
    { path: `${base}/analyses/run-one`, value: clone(state.analyses[0]), start: () => current.analyses.ensureDetail('run-one') },
    { path: `${base}/analyses/run-one/comparisons`, value: { comparisons: clone(state.pairs) }, start: () => current.analyses.ensureComparisons('run-one') },
    { path: `${base}/analyses/run-one/comparisons/pair-one`, value: clone(state.pairs[0]), start: () => current.analyses.ensureComparison('run-one', 'pair-one') },
  ].map((item) => ({ ...item, held: deferred() }))
  for (const read of reads) state.reads.set(read.path, () => read.held.promise)
  let loading
  await act(async () => { loading = Promise.all(reads.map((item) => item.start())) })
  await settle(() => state.reads.size === 0)
  state.resumes[0].etag = '"resume-current"'
  state.analyses[0].etag = '"run-current"'
  await act(async () => { await current.resumes.refresh(); await current.analyses.refresh() })
  await act(async () => {
    for (const read of reads) read.held.resolve(json(read.value))
    await loading
  })
  await settle(() => current.resumes.detail('resume-word').state === 'ready' && current.analyses.detail('run-one').state === 'ready' &&
    current.analyses.comparisons('run-one').state === 'ready' && current.analyses.comparison('run-one', 'pair-one').state === 'ready')
  assert.equal(current.resumes.detail('resume-word').value.etag, '"resume-current"')
  assert.equal(current.analyses.detail('run-one').value.etag, '"run-current"')
  assert.equal(current.analyses.comparisons('run-one').value[0].etag, '"comparison-1"')
  assert.equal(current.analyses.comparison('run-one', 'pair-one').value.etag, '"comparison-1"')
  assert.equal(state.requests.some((item) => item.method === 'POST'), false)
})

test('real direct preselection, archived grade heads and deleted job rubrics cannot enter a new 500-pair run', async () => {
  state.resumes[0].lifecycle = { archivedAt: timestamp }
  await mount('/analyses/new?data=real&resumes=resume-word&jobs=job-one')
  await settle(() => [...document.querySelectorAll('button')].some((item) => item.textContent === 'Run analysis'))
  const run = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Run analysis')
  assert.equal(run.disabled, true)
  await search('Search analysis resumes', 'Ada')
  assert.equal(document.querySelector('input[aria-label^="Include Ada"]').disabled, true)
  assert.match(document.body.textContent, /Maximum 500/)
  const selection = { kind: 'grade', ladderId: 'ladder-one', grade: 9 }
  const head = ui.gradeHeadId(selection.ladderId, selection.grade)
  const workspace = { ...parent.workspace, lifecycle: { entities: { [`rubric:${head}`]: { archivedAt: timestamp, parentKey: 'ladder:ladder-one' } } } }
  assert.equal(ui.realTargetAvailable(workspace, selection), false)
  workspace.lifecycle.entities = { 'ladder:ladder-one': { archivedAt: timestamp } }
  assert.equal(ui.realTargetArchived(workspace, selection), true)
  workspace.lifecycle.entities = {}
  workspace.jobs = [{ id: 'job-one', rubricId: null, rubricDeletedAt: timestamp }]
  assert.equal(ui.realTargetAvailable(workspace, target().selection), false)
  assert.equal(state.requests.some((item) => item.method === 'POST'), false)
})
