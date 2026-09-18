import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'

const output = resolve(`.library-table-sorting-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
const originals = new Map()
const timestamp = '2026-09-18T18:00:00.000Z'
const hash = 'a'.repeat(64)
let ui, dom, root, createRoot, calls, navigation

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function job(id, title, fields = {}) {
  return { id, title, organization: `Organization ${id}`, location: 'Remote', grade: '', series: '', arrangement: '', employmentType: '',
    source: 'pdf', sourceLabel: `Source ${id}`, status: 'ready', rubricId: `rubric-${id}`, documentId: `document-${id}`, createdAt: timestamp, ...fields }
}
function jobs(kind = 'samples') {
  return freeze([
    job('j-z', 'zeta 10', { createdAt: '2026-09-18T20:30:00-04:00' }),
    job('j-a10', 'Alpha 10', { source: 'website', status: 'generating', createdAt: '2026-09-19T00:15:00Z' }),
    job('j-a2', 'alpha 2', { source: 'url', status: 'error', createdAt: '2026-09-18T23:45:00Z' }),
    job('j-tie', 'ALPHA 2', { source: 'url', createdAt: '2026-09-19T00:15:00Z' }),
    job('j-cancel', 'Beta', { status: 'cancelled', createdAt: '2026-09-17T15:00:00Z' }),
    job('j-queue', 'Gamma', { source: 'website', status: 'queued', createdAt: '2026-09-16T15:00:00Z' }),
    job('j-parse', 'delta', { status: 'parsing', createdAt: '2026-09-15T15:00:00Z' }),
  ].map((item) => kind === 'real' ? { ...item, dataKind: 'real' } : item))
}
function sampleResume(id, name, fields = {}) {
  return { id, name, initials: 'EX', role: 'Example role', location: 'Remote', experience: 'Over 2 years', sourceLabel: 'Resume 10.pdf',
    documentId: `document-${id}`, createdAt: timestamp, sample: true, evidence: {}, ...fields }
}
function sampleResumes() {
  return freeze([
    sampleResume('s-z', 'Zoe 10', { createdAt: '2026-09-18T20:30:00-04:00' }),
    sampleResume('s-a10', 'Ada 10', { location: 'Austin', experience: '10 years', sourceLabel: 'resume 2.pdf', createdAt: '2026-09-19T00:15:00Z' }),
    sampleResume('s-a2', 'ada 2', { location: 'Boston', experience: '2 years', sourceLabel: 'Resume 1.pdf', createdAt: '2026-09-18T23:45:00Z' }),
    sampleResume('s-tie', 'ADA 2', { location: 'austin', experience: 'Extensive experience', sourceLabel: 'RESUME 2.pdf', createdAt: '2026-09-19T00:15:00Z' }),
    sampleResume('s-missing', '', { location: '', experience: '', sourceLabel: '', createdAt: '2026-09-17T15:00:00Z' }),
  ])
}
function realResume(id, name, status, sourceLabel, createdAt = timestamp) {
  return {
    resume: { id, dataKind: 'real', name, role: 'Stated role', location: null, experience: null, status,
      sourceLabel: `Saved metadata ${id}`, documentId: `document-${id}`, documentVersion: 1, batchId: 'batch-one', createdAt },
    workspaceId: 'workspace-one', source: { kind: 'pdf', displayName: sourceLabel, fileName: sourceLabel },
    etag: `"${id}-${status}"`, updatedAt: timestamp, attempts: 1, retryCount: 0, warnings: [], duplicates: [],
    capture: null,
    documentRef: status === 'ready'
      ? { documentId: `document-${id}`, documentVersion: 1, sha256: hash, blobName: 'private/document.json', bytes: 100, contentType: 'application/json' }
      : null,
  }
}
function realResumes() {
  return freeze([
    realResume('r-z', 'zoe 10', 'ready', 'Source 10.pdf', '2026-09-18T20:30:00-04:00'),
    realResume('r-a10', 'Ada 10', 'profiling', 'source 2.pdf', '2026-09-19T00:15:00Z'),
    realResume('r-null', null, 'error', 'Source 1.pdf', '2026-09-18T23:45:00Z'),
    realResume('r-a2', 'ada 2', 'ready', 'Other 9.pdf', '2026-09-19T00:15:00Z'),
    realResume('r-cancel', 'Beta', 'cancelled', 'Source 20.pdf', '2026-09-17T15:00:00Z'),
    realResume('r-queue', 'ALICE', 'queued', 'Alpha.pdf', '2026-09-16T15:00:00Z'),
    realResume('r-parse', 'Cal', 'parsing', 'Zebra.pdf', '2026-09-15T15:00:00Z'),
    realResume('r-tie', 'ADA 2', 'ready', 'SOURCE 2.pdf', '2026-09-14T15:00:00Z'),
    { ...realResume('r-blank', '  ', 'ready', '', '2026-09-13T15:00:00Z'), documentRef: null },
  ])
}
function workspaceContext({ jobRows = jobs(), resumeRows = sampleResumes(), cloud = false, workspaceId = 'workspace-one' } = {}) {
  return {
    workspace: freeze({ schemaVersion: 1, jobs: jobRows, resumes: resumeRows, documents: [], runs: [],
      rubrics: jobRows.map((item) => ({ id: item.rubricId, jobId: item.id, version: 1, criteria: [] })) }),
    ...(cloud ? { cloud: { currentWorkspaceId: workspaceId, realJobs: { phase: 'ready', error: null } } } : {}),
    cancelJob: async (id) => { calls.push({ kind: 'cancel-job', id }) },
    retryJob: async (id) => { calls.push({ kind: 'retry-job', id }) },
    addResumes: async () => { calls.push({ kind: 'add-resumes' }); return [] },
    notify: () => {},
  }
}
function target(item, version = 1) {
  return freeze({ id: `target-${item.id}-${version}`, kind: 'job', label: item.title, rubricId: item.rubricId, rubricVersion: version,
    selection: { kind: 'job', jobId: item.id, rubricId: item.rubricId, rubricVersion: version, rubricHash: hash,
      documentId: item.documentId, documentVersion: 1, documentSha256: hash } })
}
function analysesApi(targets = [], fields = {}) {
  return { workspaceId: 'workspace-one', phase: 'ready', canWrite: true, features: { realAnalyses: true },
    targets: { state: 'ready', value: targets }, ...fields }
}
function resumesApi(summaries = realResumes(), fields = {}) {
  return { workspaceId: 'workspace-one', phase: 'ready', canWrite: true, features: { realResumeImports: true }, error: null, summaries,
    batches: [], currentBatchId: null, pending: () => false,
    refresh: async () => { calls.push({ kind: 'refresh-resumes' }) },
    retry: async (id, etag) => { calls.push({ kind: 'retry-resume', id, etag }) },
    cancel: async (id, etag) => { calls.push({ kind: 'cancel-resume', id, etag }) },
    ...fields }
}

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export { JobsPage } from './src/features/jobs/JobsPage';
    export { ResumesPage } from './src/features/resumes/ResumesPage';
    export { RealResumesPage } from './src/features/resumes/RealResumesPage';
    export { WorkspaceContext } from './src/app/workspace-context';
    export { RealResumesContext } from './src/app/real-resumes-context';
    export { RealAnalysesContext } from './src/app/real-analyses-context';
    export { MemoryRouter, useLocation } from 'react-router-dom';
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})
beforeEach(() => {
  calls = []
  navigation = null
  dom.window.localStorage.clear()
  globalThis.fetch = async (...args) => { calls.push({ kind: 'fetch', args }); throw new Error('Browsing must not issue network requests.') }
})
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null } })
after(async () => {
  globalThis.fetch = originalFetch
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

function NavigationProbe() { navigation = ui.useLocation(); return null }
async function renderPage(Page, { context = workspaceContext(), resumes = resumesApi(), analyses = analysesApi(), url = '/resumes?data=samples' } = {}) {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => root.render(React.createElement(ui.MemoryRouter, {
    initialEntries: [url], future: { v7_startTransition: true, v7_relativeSplatPath: true },
  }, React.createElement(ui.WorkspaceContext.Provider, { value: context },
    React.createElement(ui.RealResumesContext.Provider, { value: resumes },
      React.createElement(ui.RealAnalysesContext.Provider, { value: analyses }, React.createElement(React.Fragment, null,
        React.createElement(NavigationProbe), React.createElement(Page))))))))
}
function button(label, within = document) {
  const found = [...within.querySelectorAll('button')].find((item) => item.textContent.trim() === label)
  assert.ok(found, `Button "${label}" exists`)
  return found
}
async function click(element) {
  assert.ok(element)
  await act(async () => element.click())
}
function header(label) { return button(label, document.querySelector('thead')).closest('th') }
async function sortHeader(label) { await click(header(label).querySelector('button')) }
function selector(label) {
  const found = document.querySelector(`select[aria-label="${label}"]`)
  assert.ok(found, `Selector "${label}" exists`)
  return found
}
async function choose(label, optionText) {
  const select = selector(label)
  assert.equal(select.disabled, false)
  const option = [...select.options].find((item) => item.textContent === optionText)
  assert.ok(option, `Option "${optionText}" exists`)
  await act(async () => { select.value = option.value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
}
function selectedOption(label) { return selector(label).selectedOptions[0].textContent }
async function search(value) {
  const input = document.querySelector('input[type="search"]')
  assert.ok(input)
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
function idFromLink(link) { return decodeURIComponent(new URL(link.href).pathname.split('/').at(-1)) }
function rowIds() { return [...document.querySelectorAll('tbody tr a.row-title')].map(idFromLink) }
function row(id) {
  const found = [...document.querySelectorAll('tbody tr')].find((item) => idFromLink(item.querySelector('a.row-title')) === id)
  assert.ok(found, `Row "${id}" exists`)
  return found
}
function checkbox(id) { return row(id).querySelector('input[type="checkbox"]') }
function order(ids, cards = false) {
  assert.deepEqual(rowIds(), ids)
  if (cards) assert.deepEqual([...document.querySelectorAll('.resume-card a.row-title')].map(idFromLink), ids)
}
function activeHeader(label, direction) {
  const active = [...document.querySelectorAll('th[aria-sort]')]
  assert.equal(active.length, 1, 'Only the activated column announces aria-sort')
  assert.equal(active[0], header(label))
  assert.equal(active[0].getAttribute('aria-sort'), direction)
  assert.equal(active[0].getAttribute('scope'), 'col')
}
function noMutations() {
  assert.deepEqual(calls, [])
  assert.equal(dom.window.localStorage.length, 0, 'Browsing does not persist searches, sorts, or selections')
}
async function segment(group, label) {
  const buttons = document.querySelector(`[role="group"][aria-label="${group}"]`).querySelectorAll('button')
  await click([...buttons].find((item) => item.textContent.startsWith(label)))
}

const newestJobs = ['j-z', 'j-a10', 'j-tie', 'j-a2', 'j-cancel', 'j-queue', 'j-parse']
const attentionJobs = ['j-a2', 'j-cancel', 'j-a10', 'j-queue', 'j-parse', 'j-z', 'j-tie']
const completeJobs = ['j-z', 'j-tie', 'j-a10', 'j-queue', 'j-parse', 'j-a2', 'j-cancel']
for (const kind of ['samples', 'real']) test(`${kind} jobs sort all meaningful headers and selector choices, with stable ties and a newest-first reset`, async () => {
  const items = jobs(kind)
  const context = workspaceContext({ jobRows: items, cloud: kind === 'real' })
  const snapshot = JSON.stringify(context.workspace)
  await renderPage(ui.JobsPage, { context, url: '/jobs' })
  order(newestJobs)
  assert.equal(selectedOption('Sort jobs'), 'Newest first (default)')
  activeHeader('Added', 'descending')
  const cases = [
    ['Job / organization', 'Job title', 'A–Z', 'Z–A',
      ['j-a2', 'j-tie', 'j-a10', 'j-cancel', 'j-parse', 'j-queue', 'j-z'], ['j-z', 'j-queue', 'j-parse', 'j-cancel', 'j-a10', 'j-a2', 'j-tie']],
    ['Source', 'Source type', 'A–Z', 'Z–A',
      ['j-a2', 'j-tie', 'j-z', 'j-cancel', 'j-parse', 'j-a10', 'j-queue'], ['j-a10', 'j-queue', 'j-z', 'j-cancel', 'j-parse', 'j-a2', 'j-tie']],
    ['Rubric', 'Processing status', 'Needs attention first', 'Complete first', attentionJobs, completeJobs],
    ['Status / actions', 'Processing status', 'Needs attention first', 'Complete first', attentionJobs, completeJobs],
  ]
  for (const [heading, option, asc, desc, ascending, descending] of cases) {
    await sortHeader(heading)
    order(ascending)
    activeHeader(heading, 'ascending')
    assert.equal(selectedOption('Sort jobs'), `${option}: ${asc}`)
    await sortHeader(heading)
    order(descending)
    activeHeader(heading, 'descending')
    assert.equal(selectedOption('Sort jobs'), `${option}: ${desc}`)
    await choose('Sort jobs', `${option}: ${asc}`)
    order(ascending)
    await choose('Sort jobs', `${option}: ${desc}`)
    order(descending)
  }
  await sortHeader('Added')
  order(newestJobs)
  activeHeader('Added', 'descending')
  await sortHeader('Added')
  order(['j-parse', 'j-queue', 'j-cancel', 'j-a2', 'j-a10', 'j-tie', 'j-z'])
  activeHeader('Added', 'ascending')
  await choose('Sort jobs', 'Added date: Newest first')
  order(newestJobs)
  await choose('Sort jobs', 'Added date: Oldest first')
  order(['j-parse', 'j-queue', 'j-cancel', 'j-a2', 'j-a10', 'j-tie', 'j-z'])
  await choose('Sort jobs', 'Newest first (default)')
  order(newestJobs)
  for (const label of ['Rubric ready', 'Creating rubric', 'Needs attention', 'Cancelled', 'Queued', 'Reading source']) {
    assert.ok(document.body.textContent.includes(label), `Exact processing label "${label}" stays visible`)
  }
  assert.equal(JSON.stringify(context.workspace), snapshot)
  assert.equal(navigation.search, '')
  noMutations()
})

test('jobs keep ready-only and hidden selections through source/status filters, zero matches, and sorting', async () => {
  await renderPage(ui.JobsPage, { url: '/jobs' })
  for (const id of ['j-a10', 'j-a2', 'j-cancel', 'j-queue', 'j-parse']) assert.equal(checkbox(id).disabled, true)
  await click(document.querySelector('input[aria-label="Select all visible ready jobs"]'))
  await sortHeader('Job / organization')
  assert.equal(checkbox('j-z').checked, true)
  assert.equal(checkbox('j-tie').checked, true)
  assert.doesNotMatch(document.querySelector('.selection-bar').textContent, /hidden/, 'Sorting preserves row references for filtered.includes')
  await search('  ALPHA 2  ')
  await choose('Filter by source', 'Direct URLs')
  await segment('Filter jobs by status', 'Ready')
  order(['j-tie'])
  assert.match(document.querySelector('.selection-bar').textContent, /2 jobs selected \(including hidden rows\)/)
  await search('not-in-this-library')
  order([])
  assert.match(document.body.textContent, /No jobs match these filters/)
  await choose('Sort jobs', 'Processing status: Complete first')
  assert.equal(button('Analyze selected').disabled, false)
  await click(button('Clear filters'))
  order(completeJobs)
  assert.equal(checkbox('j-z').checked, true)
  assert.equal(checkbox('j-tie').checked, true)
  noMutations()
  await click(button('Analyze selected'))
  assert.equal(navigation.pathname, '/analyses/new')
  assert.equal(new URLSearchParams(navigation.search).get('rubrics'), 'rubric-j-z,rubric-j-tie')
  noMutations()
})

test('real jobs retain the selected exact target across sorting, polling versions, and hidden rows', async () => {
  const items = jobs('real')
  const saved = target(items[0])
  const context = workspaceContext({ jobRows: items, cloud: true })
  await renderPage(ui.JobsPage, { context, analyses: analysesApi([saved]), url: '/jobs' })
  assert.equal(checkbox('j-z').disabled, false)
  assert.equal(checkbox('j-tie').disabled, true, 'Ready without an eligible exact saved target remains ineligible')
  await click(checkbox('j-z'))
  await sortHeader('Status / actions')
  const updated = { ...context, workspace: { ...context.workspace, rubrics: context.workspace.rubrics.map((rubric) => ({ ...rubric, version: 2 })) } }
  await renderPage(ui.JobsPage, { context: updated, analyses: analysesApi([target(items[0], 2)]), url: '/jobs' })
  order(attentionJobs)
  assert.equal(checkbox('j-z').checked, true)
  await search('no matches')
  await choose('Sort jobs', 'Added date: Oldest first')
  noMutations()
  await click(button('Analyze selected'))
  assert.deepEqual(JSON.parse(new URLSearchParams(navigation.search).get('targetSelections')), [saved.selection])
  noMutations()
})

test('real job selection stays read-only while browsing and writable row actions keep their record IDs', async () => {
  const items = jobs('real')
  const context = workspaceContext({ jobRows: items, cloud: true })
  await renderPage(ui.JobsPage, { context, analyses: analysesApi([target(items[0])], { canWrite: false }), url: '/jobs' })
  await choose('Sort jobs', 'Processing status: Complete first')
  order(completeJobs)
  assert.equal(checkbox('j-z').disabled, true)
  assert.equal(document.querySelector('input[aria-label="Select all visible ready jobs"]').disabled, true)
  noMutations()
  await renderPage(ui.JobsPage, { context, analyses: analysesApi([target(items[0])]), url: '/jobs' })
  order(completeJobs)
  await click(button('Retry', row('j-a2')))
  await click(button('Cancel', row('j-parse')))
  assert.deepEqual(calls, [{ kind: 'retry-job', id: 'j-a2' }, { kind: 'cancel-job', id: 'j-parse' }])
  assert.equal(row('j-z').querySelector('a[aria-label="Open zeta 10"]').getAttribute('href'), '/jobs/j-z')
})

test('job real/sample and workspace boundaries reset browsing and selection without persisting anything', async () => {
  const real = jobs('real')
  const sample = [job('sample-one', 'Sample role')]
  const context = workspaceContext({ jobRows: [...real, ...sample], cloud: true })
  const analyses = analysesApi([target(real[0])])
  await renderPage(ui.JobsPage, { context, analyses, url: '/jobs' })
  await click(checkbox('j-z'))
  await choose('Sort jobs', 'Job title: Z–A')
  await search('zeta')
  await choose('Filter by source', 'PDF files')
  await segment('Filter jobs by status', 'Ready')
  await segment('Choose real jobs or samples', 'Samples')
  order(['sample-one'])
  assert.equal(document.querySelector('input[type="search"]').value, '')
  assert.equal(selectedOption('Sort jobs'), 'Newest first (default)')
  assert.equal(selectedOption('Filter by source'), 'All sources')
  assert.equal(document.querySelector('.selection-bar'), null)
  await click(checkbox('sample-one'))
  await search('Sample')
  await choose('Sort jobs', 'Source type: Z–A')
  await segment('Choose real jobs or samples', 'Real jobs')
  order(newestJobs)
  assert.equal(document.querySelector('.selection-bar'), null)
  assert.equal(document.querySelector('input[type="search"]').value, '')
  assert.equal(selectedOption('Sort jobs'), 'Newest first (default)')
  await click(checkbox('j-z'))
  await search('zeta')
  await choose('Sort jobs', 'Job title: A–Z')
  await renderPage(ui.JobsPage, { context: { ...context, cloud: { ...context.cloud, currentWorkspaceId: 'workspace-two' } }, analyses, url: '/jobs' })
  order(newestJobs)
  assert.equal(document.querySelector('.selection-bar'), null)
  assert.equal(document.querySelector('input[type="search"]').value, '')
  assert.equal(selectedOption('Sort jobs'), 'Newest first (default)')
  noMutations()
})

test('merged Markdown and Word job sources retain filtering, source sorting, selections, and sample resets', async () => {
  const items = freeze([
    job('job-docx', 'Zora role', { dataKind: 'real', source: 'docx' }),
    job('job-pdf', 'PDF role', { dataKind: 'real' }),
    job('job-markdown', 'Markdown role', { dataKind: 'real', source: 'markdown' }),
    job('job-doc', 'Legacy role', { dataKind: 'real', source: 'doc' }),
    job('job-url', 'URL role', { dataKind: 'real', source: 'url' }),
    job('job-website', 'Website role', { dataKind: 'real', source: 'website' }),
  ])
  const context = workspaceContext({ jobRows: [...items, job('sample-one', 'Sample role')], cloud: true })
  context.cloud.realJobs.features = { realJobImports: true, markdownJobImports: false, wordDocumentImports: false }
  const analyses = analysesApi(items.map((item) => target(item)))
  await renderPage(ui.JobsPage, { context, analyses, url: '/jobs' })
  await sortHeader('Source')
  order(['job-url', 'job-markdown', 'job-pdf', 'job-website', 'job-doc', 'job-docx'])
  await sortHeader('Source')
  order(['job-docx', 'job-doc', 'job-website', 'job-pdf', 'job-markdown', 'job-url'])
  await click(checkbox('job-docx'))
  for (const [label, id] of [['Markdown files', 'job-markdown'], ['Word DOC files', 'job-doc'], ['Word DOCX files', 'job-docx']]) {
    await choose('Filter by source', label)
    order([id])
    await choose('Sort jobs', 'Job title: A–Z')
    assert.equal(button('Analyze selected').disabled, false)
    if (id !== 'job-docx') assert.match(document.querySelector('.selection-bar').textContent, /including hidden rows/)
  }
  assert.equal(checkbox('job-docx').checked, true)
  await segment('Choose real jobs or samples', 'Samples')
  order(['sample-one'])
  assert.equal(selectedOption('Filter by source'), 'All sources')
  assert.equal(selectedOption('Sort jobs'), 'Newest first (default)')
  assert.equal(document.querySelector('.selection-bar'), null)
  assert.ok([...selector('Filter by source').options].every((option) => !['markdown', 'doc', 'docx'].includes(option.value)))
  await segment('Choose real jobs or samples', 'Real jobs')
  order(items.map((item) => item.id))
  assert.equal(selectedOption('Filter by source'), 'All sources')
  assert.equal(checkbox('job-docx').checked, false)
  await click(checkbox('job-docx'))
  await choose('Filter by source', 'Markdown files')
  await click(button('Analyze selected'))
  assert.deepEqual(JSON.parse(new URLSearchParams(navigation.search).get('targetSelections')), [target(items[0]).selection])
  noMutations()
})

test('sample resumes sort displayed text naturally, keep missing fields last, and use the same order for desktop and cards', async () => {
  const context = workspaceContext()
  const initial = context.workspace.resumes.map((item) => item.id)
  const snapshot = JSON.stringify(context.workspace)
  await renderPage(ui.ResumesPage, { context })
  order(initial, true)
  assert.equal(selectedOption('Sort resumes'), 'Default order')
  assert.equal(document.querySelectorAll('th[aria-sort]').length, 0)
  assert.equal(document.querySelector('thead th:last-child button'), null, 'Navigation-only profile actions are not sortable')
  const cases = [
    ['Candidate', 'Candidate name', ['s-a2', 's-tie', 's-a10', 's-z', 's-missing'], ['s-z', 's-a10', 's-a2', 's-tie', 's-missing']],
    ['Location', 'Location', ['s-a10', 's-tie', 's-a2', 's-z', 's-missing'], ['s-z', 's-a2', 's-a10', 's-tie', 's-missing']],
    ['Experience', 'Experience text', ['s-a2', 's-a10', 's-tie', 's-z', 's-missing'], ['s-z', 's-tie', 's-a10', 's-a2', 's-missing']],
    ['Document label', 'Document label', ['s-a2', 's-a10', 's-tie', 's-z', 's-missing'], ['s-z', 's-a10', 's-tie', 's-a2', 's-missing']],
  ]
  for (const [heading, label, ascending, descending] of cases) {
    await sortHeader(heading)
    order(ascending, true)
    activeHeader(heading, 'ascending')
    assert.equal(selectedOption('Sort resumes'), `${label}: A–Z`)
    await sortHeader(heading)
    order(descending, true)
    activeHeader(heading, 'descending')
    await choose('Sort resumes', `${label}: A–Z`)
    order(ascending, true)
    await choose('Sort resumes', `${label}: Z–A`)
    order(descending, true)
  }
  await choose('Sort resumes', 'Added date: Oldest first')
  order(['s-missing', 's-a2', 's-a10', 's-tie', 's-z'], true)
  assert.equal(document.querySelectorAll('th[aria-sort]').length, 0)
  await choose('Sort resumes', 'Added date: Newest first')
  order(['s-z', 's-a10', 's-tie', 's-a2', 's-missing'], true)
  await choose('Sort resumes', 'Default order')
  order(initial, true)
  assert.equal(document.querySelectorAll('select[aria-label="Sort resumes"]').length, 1)
  assert.equal(selector('Sort resumes').closest('.hidden, .mobile-hide'), null)
  assert.equal(JSON.stringify(context.workspace), snapshot)
  assert.equal(navigation.search, '?data=samples')
  noMutations()
})

test('sample resume selections survive sorting and empty search in both layouts, and navigation uses the selected IDs', async () => {
  const context = workspaceContext({ cloud: true })
  await renderPage(ui.ResumesPage, { context })
  await click(checkbox('s-z'))
  await choose('Sort resumes', 'Candidate name: A–Z')
  const mobile = [...document.querySelectorAll('.resume-card')].find((item) => idFromLink(item.querySelector('a.row-title')) === 's-z')
  assert.equal(mobile.querySelector('input[type="checkbox"]').checked, true)
  assert.equal(row('s-z').querySelector('a[aria-label="View Zoe 10\'s resume"]').getAttribute('href'), '/resumes/s-z?data=samples')
  await search('  ADA 2  ')
  order(['s-a2', 's-tie'], true)
  assert.match(document.querySelector('[role="status"]').textContent, /1 selected · 1 hidden by search/)
  await search('no matches')
  order([], true)
  assert.match(document.body.textContent, /No matching resumes/)
  await choose('Sort resumes', 'Location: Z–A')
  assert.equal(button('Match to jobs (1)').disabled, false)
  await click(button('Clear search'))
  assert.equal(checkbox('s-z').checked, true)
  noMutations()
  await click(button('Match to jobs (1)'))
  assert.equal(navigation.pathname, '/analyses/new')
  assert.equal(new URLSearchParams(navigation.search).get('resumes'), 's-z')
  assert.equal(new URLSearchParams(navigation.search).get('data'), 'samples')
  noMutations()
})

const attentionResumes = ['r-null', 'r-cancel', 'r-a10', 'r-queue', 'r-parse', 'r-z', 'r-a2', 'r-tie', 'r-blank']
const completeResumes = ['r-z', 'r-a2', 'r-tie', 'r-blank', 'r-a10', 'r-queue', 'r-parse', 'r-null', 'r-cancel']
test('real resume headers and selector sort nullable names, displayed source labels, exact status groups, and chronological dates', async () => {
  const resumes = resumesApi()
  const snapshot = JSON.stringify(resumes.summaries)
  const initial = resumes.summaries.map((item) => item.resume.id)
  await renderPage(ui.RealResumesPage, { resumes, url: '/resumes?data=real' })
  order(initial)
  assert.equal(selectedOption('Sort real resumes'), 'Default order')
  assert.equal(document.querySelectorAll('th[aria-sort]').length, 0)
  await sortHeader('Stated profile')
  order(['r-a2', 'r-tie', 'r-a10', 'r-queue', 'r-cancel', 'r-parse', 'r-z', 'r-null', 'r-blank'])
  activeHeader('Stated profile', 'ascending')
  await sortHeader('Stated profile')
  order(['r-z', 'r-parse', 'r-cancel', 'r-queue', 'r-a10', 'r-a2', 'r-tie', 'r-null', 'r-blank'])
  activeHeader('Stated profile', 'descending')
  assert.equal(row('r-null').querySelector('a.row-title').textContent, 'Name not stated')
  assert.equal(row('r-blank').querySelector('a.row-title').textContent, 'Name not stated')
  for (const heading of ['Source / progress', 'Status / actions']) {
    await sortHeader(heading)
    order(attentionResumes)
    activeHeader(heading, 'ascending')
    assert.equal(selectedOption('Sort real resumes'), 'Processing status: Needs attention first')
    await sortHeader(heading)
    order(completeResumes)
    activeHeader(heading, 'descending')
    assert.equal(selectedOption('Sort real resumes'), 'Processing status: Complete first')
  }
  await choose('Sort real resumes', 'Processing status: Needs attention first')
  order(attentionResumes)
  activeHeader('Source / progress', 'ascending')
  await choose('Sort real resumes', 'Processing status: Complete first')
  order(completeResumes)
  const choices = [
    ['Stated name: A–Z', ['r-a2', 'r-tie', 'r-a10', 'r-queue', 'r-cancel', 'r-parse', 'r-z', 'r-null', 'r-blank']],
    ['Stated name: Z–A', ['r-z', 'r-parse', 'r-cancel', 'r-queue', 'r-a10', 'r-a2', 'r-tie', 'r-null', 'r-blank']],
    ['Source label: A–Z', ['r-queue', 'r-a2', 'r-null', 'r-a10', 'r-tie', 'r-z', 'r-cancel', 'r-parse', 'r-blank']],
    ['Source label: Z–A', ['r-parse', 'r-cancel', 'r-z', 'r-a10', 'r-tie', 'r-null', 'r-a2', 'r-queue', 'r-blank']],
    ['Added date: Oldest first', ['r-blank', 'r-tie', 'r-parse', 'r-queue', 'r-cancel', 'r-null', 'r-a10', 'r-a2', 'r-z']],
    ['Added date: Newest first', ['r-z', 'r-a10', 'r-a2', 'r-null', 'r-cancel', 'r-queue', 'r-parse', 'r-tie', 'r-blank']],
  ]
  for (const [choice, expected] of choices) { await choose('Sort real resumes', choice); order(expected) }
  assert.equal(document.querySelectorAll('th[aria-sort]').length, 0, 'Source/date selector choices do not mislabel the status header')
  await choose('Sort real resumes', 'Default order')
  order(initial)
  for (const label of ['Ready', 'Extracting profile', 'Could not process', 'Cancelled', 'Queued', 'Reading source']) {
    assert.ok(document.body.textContent.includes(label), `Exact processing label "${label}" stays visible`)
  }
  assert.equal(JSON.stringify(resumes.summaries), snapshot)
  assert.equal(navigation.search, '?data=real')
  noMutations()
})

test('merged Markdown and Word resumes remain selectable and sortable with format admission disabled', async () => {
  const formats = [
    { id: 'word-new', kind: 'docx', name: 'Zora', label: 'Resume 10.docx' },
    { id: 'markdown', kind: 'markdown', name: 'Mara', label: 'alpha.md' },
    { id: 'word-old', kind: 'doc', name: 'Lee', label: 'Resume 2.doc' },
    { id: 'pdf', kind: 'pdf', name: 'Parker', label: 'zeta.pdf' },
  ]
  const summaries = freeze(formats.map(({ id, kind, name, label }) => ({
    ...realResume(id, name, 'ready', label), source: { kind, fileName: label, displayName: label },
  })))
  const resumes = resumesApi(summaries, { features: { realResumeImports: true, markdownResumeImports: false, wordDocumentImports: false } })
  await renderPage(ui.RealResumesPage, { resumes, url: '/resumes?data=real' })
  await choose('Sort real resumes', 'Source label: A–Z')
  order(['markdown', 'word-old', 'word-new', 'pdf'])
  await choose('Sort real resumes', 'Source label: Z–A')
  order(['pdf', 'word-new', 'word-old', 'markdown'])
  for (const { id } of formats) assert.equal(checkbox(id).disabled, false)
  assert.match(row('word-new').textContent, /DOCX · added/)
  assert.match(row('word-old').textContent, /Word DOC/)
  assert.match(row('markdown').textContent, /Markdown/)
  await click(checkbox('word-new'))
  await search('Mara')
  order(['markdown'])
  assert.match(document.querySelector('[role="status"]').textContent, /1 selected · 1 hidden by search/)
  await choose('Sort real resumes', 'Processing status: Complete first')
  await click(button('Build analysis (1)'))
  assert.deepEqual(JSON.parse(new URLSearchParams(navigation.search).get('resumeSelections')), [{
    resumeId: 'word-new', documentId: 'document-word-new', documentVersion: 1, documentSha256: hash,
  }])
  noMutations()
})

test('real resumes keep ready-only exact selections through sorting, refresh versions, and zero search matches', async () => {
  const summaries = realResumes()
  const resumes = resumesApi(summaries)
  await renderPage(ui.RealResumesPage, { resumes, url: '/resumes?data=real' })
  for (const id of ['r-a10', 'r-null', 'r-cancel', 'r-queue', 'r-parse', 'r-blank']) assert.equal(checkbox(id).disabled, true)
  await click(button('Select ready visible'))
  assert.deepEqual([...document.querySelectorAll('tbody input:checked')].map((input) => idFromLink(input.closest('tr').querySelector('a.row-title'))), ['r-z', 'r-a2', 'r-tie'])
  await choose('Sort real resumes', 'Source label: Z–A')
  await search('  ZOE  ')
  order(['r-z'])
  assert.match(document.querySelector('[role="status"]').textContent, /3 selected · 2 hidden by search/)
  const refreshed = summaries.map((summary) => summary.resume.id === 'r-z'
    ? { ...summary, resume: { ...summary.resume, documentVersion: 2 }, documentRef: { ...summary.documentRef, documentVersion: 2, sha256: 'b'.repeat(64) } } : summary)
  await renderPage(ui.RealResumesPage, { resumes: { ...resumes, summaries: refreshed }, url: '/resumes?data=real' })
  assert.equal(checkbox('r-z').checked, true)
  assert.equal(selectedOption('Sort real resumes'), 'Source label: Z–A')
  await search('not in this library')
  assert.match(document.body.textContent, /No matching real resumes/)
  assert.match(document.querySelector('[role="status"]').textContent, /3 selected · 3 hidden by search/)
  await choose('Sort real resumes', 'Processing status: Complete first')
  noMutations()
  await click(button('Build analysis (3)'))
  const expected = ['r-z', 'r-a2', 'r-tie'].map((id) => ({ resumeId: id, documentId: `document-${id}`, documentVersion: 1, documentSha256: hash }))
  assert.deepEqual(JSON.parse(new URLSearchParams(navigation.search).get('resumeSelections')), expected)
  noMutations()
})

test('sorted real resume actions retain exact IDs and ETags, and pending/read-only/service guards remain unchanged', async () => {
  const resumes = resumesApi()
  await renderPage(ui.RealResumesPage, { resumes, url: '/resumes?data=real' })
  await choose('Sort real resumes', 'Processing status: Complete first')
  noMutations()
  await click(button('Retry processing', row('r-null')))
  await click(button('Cancel processing', row('r-parse')))
  assert.deepEqual(calls, [
    { kind: 'retry-resume', id: 'r-null', etag: '"r-null-error"' },
    { kind: 'cancel-resume', id: 'r-parse', etag: '"r-parse-parsing"' },
  ])
  assert.equal(row('r-null').querySelector('a.text-link').getAttribute('href'), '/resumes/r-null?data=real')
  await renderPage(ui.RealResumesPage, { resumes: { ...resumes, pending: (id) => id === 'r-null' }, url: '/resumes?data=real' })
  assert.equal(button('Retry processing', row('r-null')).disabled, true)
  await choose('Sort real resumes', 'Stated name: A–Z')
  assert.equal(button('Retry processing', row('r-null')).disabled, true)
  await renderPage(ui.RealResumesPage, { resumes: { ...resumes, canWrite: false }, analyses: analysesApi([], { canWrite: false }), url: '/resumes?data=real' })
  assert.equal(button('Add resumes').disabled, true)
  assert.equal(button('Build analysis').disabled, true)
  assert.equal(button('Retry processing', row('r-null')).disabled, true)
  assert.equal(button('Cancel processing', row('r-parse')).disabled, true)
  await choose('Sort real resumes', 'Processing status: Needs attention first')
  order(attentionResumes)
  await click(button('Retry processing', row('r-null')))
  await click(button('Cancel processing', row('r-parse')))
  assert.equal(calls.length, 2)
  await renderPage(ui.RealResumesPage, { resumes: { ...resumes, phase: 'error', error: 'Controlled service interruption' }, url: '/resumes?data=real' })
  assert.equal(button('Retry processing', row('r-null')).disabled, true)
  await search('no matches')
  await choose('Sort real resumes', 'Added date: Oldest first')
  assert.match(document.querySelector('[role="alert"]').textContent, /Controlled service interruption/)
  assert.equal(calls.length, 2)
})

test('resume workspace and real/sample switches reset both browsing and selection, while provider refreshes do not', async () => {
  const context = workspaceContext({ cloud: true })
  const resumes = resumesApi()
  await renderPage(ui.ResumesPage, { context, resumes, url: '/resumes?data=real' })
  await click(checkbox('r-z'))
  await choose('Sort real resumes', 'Stated name: Z–A')
  await search('Zoe')
  await segment('Choose real resumes or samples', 'Samples')
  order(context.workspace.resumes.map((item) => item.id), true)
  assert.equal(document.querySelector('input[type="search"]').value, '')
  assert.equal(selectedOption('Sort resumes'), 'Default order')
  assert.equal(button('Match to jobs').disabled, true)
  await click(checkbox('s-z'))
  await choose('Sort resumes', 'Candidate name: A–Z')
  await search('Zoe')
  await renderPage(ui.ResumesPage, { context: { ...context }, resumes: { ...resumes }, url: '/resumes?data=real' })
  assert.equal(document.querySelector('input[type="search"]').value, 'Zoe')
  assert.equal(selectedOption('Sort resumes'), 'Candidate name: A–Z')
  assert.equal(checkbox('s-z').checked, true)
  await segment('Choose real resumes or samples', 'Real resumes')
  order(resumes.summaries.map((item) => item.resume.id))
  assert.equal(document.querySelector('input[type="search"]').value, '')
  assert.equal(selectedOption('Sort real resumes'), 'Default order')
  assert.equal(button('Build analysis').disabled, true)
  await click(checkbox('r-z'))
  await search('Zoe')
  await choose('Sort real resumes', 'Stated name: A–Z')
  const switched = { ...context, cloud: { ...context.cloud, currentWorkspaceId: 'workspace-two' } }
  await renderPage(ui.ResumesPage, { context: switched, resumes: { ...resumes, workspaceId: 'workspace-two' }, url: '/resumes?data=real' })
  assert.equal(document.querySelector('input[type="search"]').value, '')
  assert.equal(selectedOption('Sort real resumes'), 'Default order')
  assert.equal(button('Build analysis').disabled, true)
  await segment('Choose real resumes or samples', 'Samples')
  assert.equal(selectedOption('Sort resumes'), 'Default order')
  assert.equal(button('Match to jobs').disabled, true)
  await click(checkbox('s-z'))
  await search('Zoe')
  await choose('Sort resumes', 'Document label: Z–A')
  await renderPage(ui.ResumesPage, { context, resumes, url: '/resumes?data=real' })
  assert.equal(document.querySelector('input[type="search"]').value, '')
  assert.equal(selectedOption('Sort resumes'), 'Default order')
  assert.equal(button('Match to jobs').disabled, true)
  noMutations()
})

for (const [page, label, option, url] of [
  ['JobsPage', 'Sort jobs', 'Processing status: Complete first', '/jobs'],
  ['ResumesPage', 'Sort resumes', 'Added date: Oldest first', '/resumes?data=samples'],
  ['RealResumesPage', 'Sort real resumes', 'Source label: Z–A', '/resumes?data=real'],
]) test(`${page} keeps its sort selector available for an empty library and empty searches`, async () => {
  await renderPage(ui[page], { context: workspaceContext({ jobRows: [], resumeRows: [] }), resumes: resumesApi([]), url })
  order([])
  await choose(label, option)
  await search('no matches')
  order([])
  assert.equal(selectedOption(label), option)
  await search('  ')
  order([])
  assert.equal(selector(label).disabled, false)
  noMutations()
})
