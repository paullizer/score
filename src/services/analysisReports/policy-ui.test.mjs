import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const output = resolve(`.report-preview-policy-tests-${randomUUID()}`)
const original = new Map()
let runtime, React, createRoot, root, dom, host, requests, settings
const source = { id: 'document-one', version: 1, kind: 'job', title: 'Saved Word evidence', sample: false,
  paragraphs: [{ id: 'paragraph-one', page: 1, heading: 'Captured evidence', text: 'Authoritative extracted evidence remains available.' }] }
const originalUrl = '/api/workspaces/workspace-one/jobs/job-one/original'
const originalDocx = { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
function install(name, value) {
  if (!original.has(name)) original.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
function findButton(label) {
  return [...document.querySelectorAll('button')].find(button => button.textContent.trim() === label)
}
async function click(button) {
  assert.ok(button)
  await React.act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await delay(0) })
}
function context(role = 'owner') {
  return { workspace: { schemaVersion: 1, jobs: [], resumes: [], rubrics: [], runs: [], documents: [] }, cloud: {
    currentWorkspaceId: 'workspace-one',
    workspaces: [{ id: 'workspace-one', role }, { id: 'unrelated-owner-workspace', role: 'owner' }],
  } }
}
async function render({ role = 'owner', phase = 'ready', error = null, cloud = true, preview = true, originalMetadata = originalDocx } = {}) {
  const policy = { settings, phase, error, cloud, refresh: async () => {} }
  const detail = {
    run: { id: 'run-one', name: 'Saved evidence', createdAt: '2026-09-18T18:00:00.000Z' },
    targets: [{ id: 'target-one', label: 'Saved target', displayName: 'Saved target', rubricVersion: 1 }],
    resumes: [{ id: 'resume-one' }],
  }
  const comparisons = [{ comparison: {
    id: 'comparison-one', status: 'complete', target: { summary: { id: 'target-one' } },
  } }]
  const content = preview
    ? React.createElement(runtime.PrivateDocumentViewer, { document: source, originalUrl, original: originalMetadata })
    : React.createElement(runtime.MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } },
      React.createElement(runtime.AnalysisReportExport, { source: { workspaceId: 'workspace-one', detail, comparisons, available: true } }))
  await React.act(async () => {
    root.render(React.createElement(runtime.PublicSettingsContext.Provider, { value: policy },
      React.createElement(runtime.WorkspaceContext.Provider, { value: context(role) }, content)))
    await delay(0)
  })
}
before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://score.test', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent']) install(name, name === 'window' ? dom.window : dom.window[name])
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  install('IS_REACT_ACT_ENVIRONMENT', true)
  React = await import('react')
  ;({ createRoot } = await import('react-dom/client'))
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export { PrivateDocumentViewer } from './src/components/documents/PrivateDocumentViewer';
      export { AnalysisReportExport } from './src/features/analyses/AnalysisReportExport';
      export { WorkspaceContext } from './src/app/workspace-context';
      export { PublicSettingsContext } from './src/app/public-settings-context';
      export { createDefaultAdminSettings } from './src/domain/admin-settings-defaults';
      export { MemoryRouter } from 'react-router-dom';
    ` }, outfile: join(output, 'ui.mjs'), bundle: true, jsx: 'automatic', packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' })
  runtime = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})
beforeEach(() => {
  const defaults = runtime.createDefaultAdminSettings()
  settings = { ...defaults, revision: 'policy-one', runtimeEnabled: true }
  requests = []
  install('fetch', (url, init) => {
    requests.push({ url: String(url), init })
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await React.act(() => root.unmount())
  await delay(0)
  host.remove()
})
after(async () => {
  dom.window.close()
  for (const [name, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

test('private Word preview starts with extracted evidence and remains independent from disabled new Word admissions', async () => {
  settings.features.jobImports = false
  settings.imports.jobs.allowedFormats = []
  await render()
  assert.match(document.body.textContent, /Authoritative extracted evidence remains available/)
  assert.equal(requests.length, 0)
  await click(findButton('Formatted Word preview'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `https://score.test${originalUrl}?preview=formatted`)
  assert.equal(requests[0].init.cache, 'no-store')
  assert.equal(document.querySelector('a[download]').href, `https://score.test${originalUrl}`)
})

test('preview policy and every current workspace role gate original-byte work without concealing extracted evidence', async () => {
  settings.documents.originalDownloadRoles = ['editor']
  for (const role of ['owner', 'viewer', null]) {
    await render({ role })
    assert.equal(findButton('Formatted Word preview'), undefined)
    assert.match(document.body.textContent, /current workspace role cannot access original files/)
    assert.match(document.body.textContent, /Authoritative extracted evidence remains available/)
  }
  assert.equal(requests.length, 0)
  await render({ role: 'editor' })
  assert.ok(findButton('Formatted Word preview'))
  settings = { ...settings, documents: { ...settings.documents, formattedDocxPreviewEnabled: false } }
  await render({ role: 'editor' })
  assert.equal(findButton('Formatted Word preview'), undefined)
  assert.match(document.body.textContent, /disabled by application policy/)
  assert.equal(requests.length, 0)
})

test('revoking original access aborts an active private preview, removes original links and restores extracted text', async () => {
  await render({ role: 'viewer' })
  await click(findButton('Formatted Word preview'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.signal.aborted, false)
  settings = { ...settings, revision: 'policy-two', documents: { ...settings.documents, originalDownloadRoles: ['owner'] } }
  await render({ role: 'viewer' })
  assert.equal(requests[0].init.signal.aborted, true)
  assert.equal(findButton('Formatted Word preview'), undefined)
  assert.equal(document.querySelector('a[download]'), null)
  assert.match(document.body.textContent, /Authoritative extracted evidence remains available/)
  settings.documents.originalDownloadRoles = ['owner', 'viewer']
  await render({ role: 'viewer' })
  assert.equal(findButton('Extracted text').getAttribute('aria-pressed'), 'true')
  assert.equal(requests.length, 1, 'Restoring access must not automatically refetch original bytes.')
})

test('loading or failed public-policy refresh blocks formatted preview even when stale settings previously allowed it', async () => {
  for (const phase of ['loading', 'error']) {
    await render({ phase, error: phase === 'error' ? 'Policy lookup is unavailable.' : null })
    assert.equal(findButton('Formatted Word preview'), undefined)
    assert.match(document.body.textContent, /Checking current document permissions|Policy lookup is unavailable/)
    assert.match(document.body.textContent, /Authoritative extracted evidence/)
  }
  assert.equal(requests.length, 0)
  settings.documents.originalDownloadRoles = []
  await render({ originalMetadata: { contentType: 'application/msword' } })
  assert.match(document.body.textContent, /Legacy Word DOC.*text-only preview/)
  assert.doesNotMatch(document.body.textContent, /Download the original to inspect/)
})

test('missing cloud projection fails closed even in a ready context; standalone defaults stay explicit', async () => {
  settings = null
  await render()
  assert.equal(findButton('Formatted Word preview'), undefined)
  assert.match(document.body.textContent, /Current document policy is unavailable/)
  assert.match(document.body.textContent, /Authoritative extracted evidence remains available/)
  await render({ preview: false })
  assert.equal(findButton('Export report').disabled, true)
  assert.match(document.body.textContent, /Current report policy is unavailable/)
  await render({ preview: false, cloud: false })
  assert.equal(findButton('Export report').disabled, false)
  await render({ cloud: false })
  assert.ok(findButton('Formatted Word preview'))
  assert.equal(requests.length, 0)
})

test('configured inactive processing retains saved export and original-byte policy without blocking authorized historical use', async () => {
  settings.runtimeEnabled = false
  settings.runtimeReadiness = {
    configured: true, newProcessingAllowed: false, reason: 'worker-verification-required', message: 'Worker verification is required.',
  }
  settings.features = Object.fromEntries(Object.keys(settings.features).map(key => [key, false]))
  settings.imports.jobs.allowedFormats = []
  settings.documents.originalDownloadRoles = ['viewer']
  settings.reports = { ...settings.reports, allowedRoles: ['viewer'], enabledFormats: ['csv'], defaultFormat: 'csv' }
  await render({ role: 'owner' })
  assert.equal(findButton('Formatted Word preview'), undefined)
  assert.match(document.body.textContent, /current workspace role cannot access original files/)
  assert.match(document.body.textContent, /Authoritative extracted evidence remains available/)
  await render({ role: 'viewer' })
  await click(findButton('Formatted Word preview'))
  assert.equal(requests.length, 1)
  await render({ preview: false, role: 'owner' })
  assert.equal(requests[0].init.signal.aborted, true)
  assert.equal(findButton('Export report').disabled, true)
  assert.match(document.body.textContent, /current workspace role is not allowed to export/)
  await render({ preview: false, role: 'viewer' })
  assert.equal(findButton('Export report').disabled, false)
  await click(findButton('Export report'))
  const selector = document.querySelector('select')
  assert.equal(selector.value, 'csv')
  assert.equal(selector.querySelector('option[value="pdf"]').disabled, true)
  assert.equal(findButton('Download CSV').disabled, false)
  assert.equal(requests.length, 1, 'Opening the historical export dialog must not start processing or read another original.')
  await render({ preview: false, role: 'viewer', phase: 'error', error: 'Configured policy is unavailable.' })
  assert.equal(findButton('Export report').disabled, true)
  assert.match(document.body.textContent, /Configured policy is unavailable/)
})

test('disabled export formats and roles have explicit visible UX, not merely hidden buttons or tooltip-only enforcement', async () => {
  settings.reports.enabledFormats = []
  settings.reports.defaultFormat = null
  await render({ preview: false })
  assert.equal(findButton('Export report').disabled, true)
  assert.match(document.body.textContent, /Official exports are disabled by application policy/)
  settings.reports = { ...runtime.createDefaultAdminSettings().reports, allowedRoles: ['owner'] }
  await render({ preview: false, role: 'viewer' })
  assert.equal(findButton('Export report').disabled, true)
  assert.match(document.body.textContent, /current workspace role is not allowed to export/)
  assert.equal(requests.length, 0)
})

test('the export dialog uses the configured default and labels disabled formats while keeping enabled choices available', async () => {
  settings.reports.enabledFormats = ['csv', 'docx']
  settings.reports.defaultFormat = 'docx'
  settings.reports.highlightCount = 2
  settings.reports.maxHighlights = 3
  await render({ preview: false })
  await click(findButton('Export report'))
  const selector = document.querySelector('select')
  assert.ok(selector)
  assert.equal(selector.value, 'docx')
  assert.equal(selector.querySelector('option[value="pdf"]').disabled, true)
  assert.match(selector.querySelector('option[value="pdf"]').textContent, /disabled by policy/)
  assert.equal(selector.querySelector('option[value="csv"]').disabled, false)
  assert.match(document.body.textContent, /highest 2 scored matches.*ties up to 3 highlights/)
  assert.equal(requests.length, 0)
})
