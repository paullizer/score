import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

const output = resolve(`.real-resume-client-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
const key = '2d2a2db7-b3aa-4383-a6e1-90aab16992aa'
const batchId = 'b7971149-c541-4fb5-a096-a40ecf8c2ed5'
const timestamp = '2026-09-17T18:00:00.000Z'
const hash = 'a'.repeat(64)
let client, ui, createRoot, dom, root, current, requests
const originals = new Map()

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function summary(id = 'resume-one', workspaceId = 'workspace-one', status = 'ready') {
  return {
    resume: { id, dataKind: 'real', name: null, role: null, location: null, experience: null, documentId: `document-${id}`, documentVersion: 1,
      sourceLabel: 'resume.pdf', batchId, status, createdAt: timestamp },
    workspaceId, source: { kind: 'pdf', displayName: 'resume.pdf', fileName: 'resume.pdf' },
    capture: status === 'ready' ? { original: { blobName: 'private/original.pdf', contentType: 'application/pdf', sha256: hash, bytes: 12 }, capturedAt: timestamp, redirects: [] } : null,
    documentRef: status === 'ready' ? { blobName: 'private/document.json', contentType: 'application/json', sha256: hash, bytes: 300, documentId: `document-${id}`, documentVersion: 1 } : null,
    etag: `"${id}-${status}"`, updatedAt: timestamp, attempts: 1, retryCount: 0, warnings: [], duplicates: [],
  }
}

function detail(id = 'resume-one', workspaceId = 'workspace-one') {
  const value = summary(id, workspaceId)
  const unavailable = { status: 'unavailable', value: null, citations: [] }
  return { ...value,
    document: { id: value.resume.documentId, title: 'Captured professional profile', kind: 'resume', version: 1, sample: false,
      paragraphs: [{ id: 'resume-p1', page: 1, heading: 'Experience', text: 'Prepared accessible project documentation.' }] },
    profile: { schemaVersion: 1, dataKind: 'real', workspaceId, resumeId: id, documentId: value.resume.documentId, documentVersion: 1, documentSha256: hash,
      name: unavailable, role: unavailable, location: unavailable, experience: unavailable,
      provenance: { model: 'test-model', promptVersion: 'profile-v1', schemaVersion: 'profile-v1', extractedAt: timestamp } },
    extraction: { method: 'html', version: 'html-v1', extractedAt: timestamp, pagination: 'html-sections', pageCount: null, normalizedCharacters: 40, document: value.documentRef },
  }
}

function deferred() {
  let resolvePromise
  const promise = new Promise((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, localStorage: dom.window.localStorage, CSS: { escape: (value) => value },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await Promise.all([
    build({ entryPoints: [join('src', 'services', 'realResumes.ts')], outfile: join(output, 'client.mjs'), bundle: true, packages: 'external',
      format: 'esm', platform: 'node', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } }),
    build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export * from './src/features/resumes/resumeImportUi';
      export { RealRequestScope } from './src/app/real-request-scope';
      export { WorkspaceContext } from './src/app/workspace-context';
      export { RealResumesBridge } from './src/app/RealResumesBridge';
      export { RealResumesContext, useRealResumes } from './src/app/real-resumes-context';
      export { DocumentViewer } from './src/components/documents/DocumentViewer';
      export { RealResumeStatus, RealResumeActions, RealResumesPage } from './src/features/resumes/RealResumesPage';
      export { MemoryRouter } from 'react-router-dom';
    ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
      jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } }),
  ])
  ;[client, ui] = await Promise.all(['client', 'ui'].map((name) => import(pathToFileURL(join(output, `${name}.mjs`)).href)))
})

beforeEach(() => { requests = []; current = null })
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null } })
after(async () => {
  globalThis.fetch = originalFetch
  dom.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

test('features are additive and missing resume support fails closed', async () => {
  globalThis.fetch = async () => json({ realJobImports: true, realGradeLadders: true, realResumeImports: true, resumeLimits: { maxBatchItems: 10, maxPdfPages: 50 } })
  assert.deepEqual(await client.fetchResumeProcessingFeatures(), { realResumeImports: true, resumeLimits: { maxBatchItems: 10, maxPdfPages: 50 } })
  globalThis.fetch = async () => json({ realJobImports: true })
  const unavailable = await client.fetchResumeProcessingFeatures()
  assert.equal(unavailable.realResumeImports, false)
  assert.equal(unavailable.resumeLimits.maxPdfBytes, 10 * 1024 * 1024)
})

test('resumes consume all pages, encode tokens, reject repeated tokens and foreign/sample records', async () => {
  const workspaceId = 'workspace / one'
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return requests.length === 1 ? json({ resumes: [summary('first', workspaceId)], continuationToken: 'next / page' }) : json({ resumes: [summary('second', workspaceId)] })
  }
  assert.deepEqual((await client.listAllRealResumes(workspaceId)).map((item) => item.resume.id), ['first', 'second'])
  assert.equal(requests[1].url, '/api/workspaces/workspace%20%2F%20one/resumes?continuationToken=next%20%2F%20page')
  globalThis.fetch = async () => json({ resumes: [], continuationToken: 'again' })
  await assert.rejects(client.listAllRealResumes('w'), /repeated continuation token/)
  globalThis.fetch = async () => json({ resumes: [summary('foreign', 'other-workspace')] })
  await assert.rejects(client.listAllRealResumes('w'), /real record for this workspace/)
  globalThis.fetch = async () => json({ resumes: [{ ...summary('sample', 'w'), resume: { id: 'sample', sample: true } }] })
  await assert.rejects(client.listAllRealResumes('w'), /No sample was substituted/)
})

test('actual PDF bytes and both UUIDs are preserved, with a consistent declared batch count', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ resume: summary('accepted', 'w', 'queued') }, 202) }
  const file = new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 200])], 'résumé details.pdf', { type: 'application/pdf' })
  await client.importRealResumePdf('w', file, key, batchId, 2)
  await client.importRealResumePdf('w', file, key, batchId, 2)
  for (const request of requests) {
    assert.equal(request.url, '/api/workspaces/w/resumes/pdf')
    assert.equal(request.init.headers.get('Content-Type'), 'application/pdf')
    assert.equal(request.init.headers.get('X-File-Name'), encodeURIComponent(file.name))
    assert.equal(request.init.headers.get('Idempotency-Key'), key)
    assert.equal(request.init.headers.get('X-Import-Batch'), batchId)
    assert.equal(request.init.headers.get('X-Import-Count'), '2')
    assert.equal(request.init.headers.get('X-Score-Request'), 'workspace')
    assert.deepEqual(new Uint8Array(request.init.body), new Uint8Array(await file.arrayBuffer()))
    assert.equal(request.init.credentials, 'include')
    assert.equal(request.init.cache, 'no-store')
    assert.equal(request.init.redirect, 'manual')
  }
})

test('URL imports contain only a URL body and stable batch headers; 0/11 inputs and invalid keys are rejected', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ resume: summary('accepted', 'w', 'queued') }, 202) }
  await client.importRealResumeUrl('w', 'https://www.linkedin.com/in/public-profile', key, batchId, 10)
  assert.deepEqual(JSON.parse(requests[0].init.body), { url: 'https://www.linkedin.com/in/public-profile' })
  assert.equal(requests[0].init.headers.get('X-Import-Count'), '10')
  for (const count of [0, 11, 1.5]) await assert.rejects(client.importRealResumeUrl('w', 'https://example.test/profile', key, batchId, count), /between 1 and 10/)
  await assert.rejects(client.importRealResumeUrl('w', 'https://example.test/profile', 'bad-key', batchId, 1), /UUID/)
  assert.equal(requests.length, 1)
})

test('detail is unwrapped; original downloads stay authorized; retry/cancel send displayed ETags and empty bodies', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json(init.method === 'GET' ? detail('r / one', 'w / one') : { resume: summary('r / one', 'w / one', 'queued') })
  }
  assert.equal((await client.getRealResume('w / one', 'r / one')).document.kind, 'resume')
  assert.equal(client.realResumeOriginalUrl('w / one', 'r / one'), '/api/workspaces/w%20%2F%20one/resumes/r%20%2F%20one/original')
  await client.retryRealResume('w / one', 'r / one', '"displayed-etag"')
  await client.cancelRealResume('w / one', 'r / one', '"same-etag"')
  assert.equal(requests[1].url, '/api/workspaces/w%20%2F%20one/resumes/r%20%2F%20one/retry')
  assert.equal(requests[1].init.headers.get('If-Match'), '"displayed-etag"')
  assert.equal(requests[2].init.headers.get('If-Match'), '"same-etag"')
  assert.equal(requests[1].init.body, undefined)
  assert.equal(requests[2].init.body, undefined)
  await assert.rejects(client.cancelRealResume('w', 'r', ''), /Reload/)
})

test('auth, service, and concurrency errors never fall back or auto-retry a new ETag', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ error: { code: 'conflict', message: 'Resume changed.' } }, 409) }
  await assert.rejects(client.retryRealResume('w', 'r', '"old"'), { name: 'CloudConflictError', message: 'Resume changed.' })
  assert.equal(requests.length, 1)
  globalThis.fetch = async () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } })
  await assert.rejects(client.getRealResume('w', 'r'), { name: 'CloudAuthError' })
  globalThis.fetch = async () => json({ error: { code: 'forbidden', message: 'Viewer access is read-only.' } }, 403)
  await assert.rejects(client.cancelRealResume('w', 'r', '"e"'), /read-only/)
})

test('mixed PDF/URL batches keep good and invalid items, allow identical basenames, and never truncate', () => {
  const first = new File(['%PDF-one'], 'resume.pdf', { type: 'application/pdf' })
  const second = new File(['%PDF-two'], 'resume.pdf', { type: 'application/pdf' })
  const inputs = [{ kind: 'pdf', file: first }, { kind: 'pdf', file: second }, { kind: 'pdf', file: new File(['bad'], 'notes.txt') },
    ...ui.resumeUrlLines('https://example.test/profile\r\nnot a URL\n\nhttps://www.linkedin.com/in/public-profile').map((url) => ({ kind: 'url', url }))]
  const initial = { id: batchId, inputCount: null, items: [] }
  const batch = ui.appendResumeInputs(initial, inputs)
  assert.equal(batch.items.length, 6)
  assert.equal(batch.items.filter((item) => item.state === 'pending').length, 4)
  assert.equal(batch.items.filter((item) => item.state === 'invalid').length, 2)
  assert.notEqual(batch.items[0].key, batch.items[1].key)
  assert.equal(batch.items[0].source.file, first)
  assert.equal(batch.items[1].source.file, second)
  assert.equal(initial.items.length, 0)
  const ten = ui.appendResumeInputs(batch, Array.from({ length: 4 }, (_, index) => ({ kind: 'url', url: `https://example.test/person-${index}` })))
  assert.equal(ten.items.length, 10)
  assert.throws(() => ui.appendResumeInputs(ten, [{ kind: 'url', url: 'https://example.test/eleven' }]), /Nothing was truncated/)
  assert.equal(ten.items.length, 10)
  assert.throws(() => ui.appendResumeInputs({ ...ten, inputCount: 10 }, [{ kind: 'pdf', file: first }]), /already been submitted/)
})

test('PDF size/URL bounds are per-item; no credential or nonpublic fallback is provided', () => {
  assert.equal(ui.validateResumeInput({ kind: 'pdf', file: new File([new Uint8Array(10 * 1024 * 1024)], 'limit.pdf') }), undefined)
  assert.match(ui.validateResumeInput({ kind: 'pdf', file: new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.pdf') }), /exceeds 10 MiB/)
  assert.match(ui.validateResumeInput({ kind: 'pdf', file: new File([], 'empty.pdf') }), /empty/)
  assert.match(ui.validateResumeInput({ kind: 'url', url: `https://example.test/${'a'.repeat(4096)}` }), /4096/)
  assert.match(ui.validateResumeInput({ kind: 'url', url: 'https://user:password@example.test/profile' }), /without credentials/)
  assert.match(ui.validateResumeInput({ kind: 'url', url: 'file:///resume.pdf' }), /Only public/)
  const blocked = { ...summary(), error: { code: 'access-blocked', message: 'Blocked', retryable: false } }
  assert.match(ui.resumeErrorMessage(blocked), /This URL is not publicly accessible and could not be processed\./)
  assert.match(ui.resumeErrorMessage(blocked), /cannot sign in or bypass/)
  const missing = { ...blocked, error: { code: 'not-found', message: 'This page was not found.', retryable: false } }
  assert.equal(ui.resumeErrorMessage(missing), 'This page was not found.')
  assert.equal(ui.resumeName(summary()), 'Name not stated')
  assert.equal(ui.readyRealResume(summary()), true)
  assert.equal(ui.readyRealResume(summary('queued', 'w', 'queued')), false)
})

test('real HTML source rendering uses captured sections, actual text, and never invented PDF pages', () => {
  const html = renderToStaticMarkup(React.createElement(ui.DocumentViewer, {
    document: detail().document, pagination: 'html-sections', highlightedId: 'resume-p1', quote: 'accessible project documentation',
  }))
  assert.match(html, /Actual source/)
  assert.match(html, /Captured HTML section 1 of 1/)
  assert.match(html, /<mark>accessible project documentation<\/mark>/)
  assert.doesNotMatch(html, /Original page|Sample content|Fictional/)
})

test('resume detail reflects newly discovered duplicates without changing the immutable record ETag', async () => {
  const captured = detail()
  const first = summary()
  const api = { workspaceId: 'workspace-one', canWrite: true, phase: 'ready', features: { realResumeImports: true },
    error: null, summaries: [first], detail: () => ({ state: 'ready', value: captured }), ensureDetail: async () => {},
    pending: () => false, originalUrl: () => '/api/workspaces/workspace-one/resumes/resume-one/original' }
  function content(value) {
    return React.createElement(ui.MemoryRouter, { initialEntries: ['/resumes/resume-one?data=real'], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
      React.createElement(ui.RealResumesContext.Provider, { value }, React.createElement(ui.RealResumesPage, { id: 'resume-one' })))
  }
  root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => root.render(content(api)))
  const refreshed = { ...first, duplicates: [{ kind: 'exact-content', resumeId: 'resume-two', message: 'A later URL capture contains the same source content.' }] }
  assert.equal(refreshed.etag, captured.etag)
  await act(async () => root.render(content({ ...api, summaries: [refreshed] })))
  assert.match(dom.window.document.body.textContent, /A later URL capture contains the same source content/)
  assert.match(dom.window.document.body.textContent, /No profiles were merged or overwritten/)
})

test('manual resume retries ignore automatic retry policy and retain the exact record, capture, and ETag', async () => {
  const calls = []
  const blocked = { ...summary('blocked-url', 'workspace-one', 'error'),
    source: { kind: 'url', displayName: 'Public profile URL', url: 'https://example.test/profile' },
    error: { code: 'access-blocked', stage: 'download', message: 'This URL is not publicly accessible and could not be processed.', retryable: false } }
  const captured = { ...summary('captured-resume'), resume: { ...summary('captured-resume').resume, status: 'error' },
    error: { code: 'invalid-model-output', stage: 'profiling', message: 'Profile output was invalid.', retryable: false } }
  const api = { canWrite: true, phase: 'ready', pending: () => false,
    retry: async (id, etag) => { calls.push({ id, etag }); return id === blocked.resume.id ? blocked : captured } }
  const content = (value, canWrite = true) => React.createElement(ui.RealResumesContext.Provider, { value: { ...api, canWrite } },
    React.createElement(ui.RealResumeActions, { summary: value }))
  root = createRoot(dom.window.document.getElementById('root'))
  for (const value of [blocked, captured]) {
    const before = JSON.stringify(value)
    await act(async () => root.render(content(value)))
    const retry = dom.window.document.querySelector('button[aria-label^="Retry processing"]')
    assert.equal(retry.disabled, false)
    await act(async () => retry.click())
    assert.deepEqual(calls.at(-1), { id: value.resume.id, etag: value.etag })
    assert.equal(JSON.stringify(value), before, 'manual retry never replaces the stored source or selected record')
  }
  assert.equal(blocked.capture, null)
  assert.equal(captured.capture.original.sha256, hash)
  await act(async () => root.render(content(blocked, false)))
  assert.equal(dom.window.document.querySelector('button[aria-label^="Retry processing"]').disabled, true)
  await act(async () => root.render(content(summary('already-ready'))))
  assert.equal(dom.window.document.querySelector('button[aria-label^="Retry processing"]'), null)
})

test('request scope fences stale reads and workspace lifetimes without cancelling independent mutations', () => {
  const scope = new ui.RealRequestScope()
  const before = scope.read('library')
  const first = scope.mutate('import-one')
  const second = scope.mutate('import-two')
  assert.equal(before.controller.signal.aborted, true)
  assert.equal(scope.current(before), false)
  assert.equal(scope.mutationCurrent(first), true)
  assert.equal(scope.mutationCurrent(second), true)
  assert.equal(scope.read('library'), null)
  assert.throws(() => scope.mutate('import-one'), /Wait/)
  scope.finishMutation(first)
  scope.finishMutation(second)
  const read = scope.read('detail')
  assert.equal(scope.accept('resume', read.sequence), true)
  assert.equal(scope.accept('resume', before.sequence), false)
  scope.close()
  scope.activate()
  assert.equal(scope.current(read), false)
  assert.equal(scope.mutationCurrent(first), false)
})

function Probe() { current = ui.useRealResumes(); return React.createElement('span', null, current.phase) }
const sample = { schemaVersion: 1, jobs: [], resumes: [], rubrics: [], documents: [], runs: [] }
function tree(workspaceId, showProbe = true, role = 'owner') {
  return React.createElement(ui.WorkspaceContext.Provider, { value: {
    workspace: sample, cloud: { currentWorkspaceId: workspaceId, workspaces: [{ id: workspaceId, role }] },
    addResumes: () => { throw new Error('Real input reached sample intake') }, startAnalysis: () => { throw new Error('Real input reached sample scoring') },
  } }, React.createElement(ui.RealResumesBridge, { workspaceId }, showProbe ? React.createElement(Probe) : null))
}
async function mount(workspaceId = 'workspace-one', showProbe = true, role = 'owner') {
  root ??= createRoot(dom.window.document.getElementById('root'))
  await act(async () => { root.render(tree(workspaceId, showProbe, role)); await new Promise((resolve) => setTimeout(resolve, 0)) })
}
async function settle(predicate) {
  for (let index = 0; index < 30 && !predicate(); index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.equal(Boolean(predicate()), true, 'Expected asynchronous UI state was reached')
}

test('provider retains independent accepted/unconfirmed uploads after dialog unmount and retries exact keys', async () => {
  const secondUpload = deferred()
  let uploadCount = 0
  let urlAttempts = 0
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/features') return json({ realResumeImports: true })
    if (init.method === 'GET') return json({ resumes: [] })
    uploadCount++
    if (url.endsWith('/url') && urlAttempts++ === 0) return secondUpload.promise
    return json({ resume: summary(`accepted-${uploadCount}`, 'workspace-one', 'queued') }, 202)
  }
  await mount()
  await settle(() => current?.phase === 'ready')
  const before = JSON.stringify(sample)
  dom.window.localStorage.clear()
  await act(async () => current.stage([{ kind: 'pdf', file: new File(['%PDF-one'], 'resume.pdf') }, { kind: 'url', url: 'https://example.test/profile' }]))
  const batch = current.batches[0]
  let submission
  await act(async () => { submission = current.submitBatch(batch.id); await new Promise((resolve) => setTimeout(resolve, 0)) })
  await settle(() => current.batches[0].items[0].state === 'accepted')
  assert.equal(current.batches[0].items[0].state, 'accepted')
  assert.equal(current.batches[0].items[0].source.file, null, 'acknowledged PDF bytes are released from browser memory')
  assert.equal(current.batches[0].items[1].state, 'uploading')
  assert.throws(() => current.newBatch(), /active batch has not been replaced/)
  await mount('workspace-one', false)
  await act(async () => { secondUpload.resolve(json({ error: { code: 'unavailable', message: 'Acceptance response unavailable.' } }, 503)); await submission })
  await mount()
  assert.deepEqual(current.batches[0].items.map((item) => item.state), ['accepted', 'unconfirmed'])
  await act(async () => current.submitBatch(batch.id, [batch.items[1].key]))
  const uploads = requests.filter((item) => item.init.method === 'POST')
  assert.equal(uploads.length, 3)
  const urlRequests = uploads.filter((item) => item.url.endsWith('/url'))
  assert.equal(urlRequests[0].init.headers.get('Idempotency-Key'), urlRequests[1].init.headers.get('Idempotency-Key'))
  assert.equal(urlRequests[0].init.headers.get('X-Import-Batch'), urlRequests[1].init.headers.get('X-Import-Batch'))
  assert.equal(urlRequests[1].init.headers.get('X-Import-Count'), '2')
  assert.equal(urlRequests[0].init.body, urlRequests[1].init.body)
  assert.equal(JSON.stringify(sample), before)
  assert.equal(dom.window.localStorage.length, 0)
})

test('workspace switching ignores late library and action responses; viewers cannot mutate', async () => {
  const oldList = deferred()
  const oldAction = deferred()
  globalThis.fetch = async (url, init) => {
    if (url === '/api/features') return json({ realResumeImports: true })
    if (url === '/api/workspaces/old/resumes' && init.method === 'GET') return oldList.promise
    if (url.endsWith('/cancel')) return oldAction.promise
    return json({ resumes: [summary('new-only', 'new', 'queued')] })
  }
  await mount('old')
  await mount('new')
  await settle(() => current?.phase === 'ready')
  await act(async () => oldList.resolve(json({ resumes: [summary('private-old', 'old')] })))
  assert.deepEqual(current.summaries.map((item) => item.resume.id), ['new-only'])
  let pending
  await act(async () => { pending = current.cancel('new-only', '"displayed"'); pending.catch(() => undefined) })
  await mount('other', true, 'viewer')
  await act(async () => oldAction.resolve(json({ resume: summary('new-only', 'new', 'cancelled') })))
  await assert.rejects(pending, /workspace changed/)
  assert.equal(current.summaries.some((item) => item.resume.id === 'private-old'), false)
  await assert.rejects(current.cancel('anything', '"e"'), /read-only/)
})
