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

function markdownDetail() {
  const value = detail()
  return {
    ...value,
    resume: { ...value.resume, sourceLabel: 'resume.MD' },
    source: { kind: 'markdown', displayName: 'resume.MD', fileName: 'resume.MD' },
    capture: { ...value.capture, original: { ...value.capture.original, contentType: 'text/markdown' } },
    extraction: { ...value.extraction, method: 'markdown', version: 'markdown-v1', pagination: 'markdown-sections', pageCount: null },
  }
}

function deferred() {
  let resolvePromise
  const promise = new Promise((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

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
      export { RealAddResumesDialog } from './src/features/resumes/RealAddResumesDialog';
      export { RealComparisonReview } from './src/features/analyses/RealComparisonReview';
      export { RealAnalysesContext } from './src/app/real-analyses-context';
      export { RESUME_IMPORT_LIMITS } from './src/domain/real-resumes';
      export { MemoryRouter } from 'react-router-dom';
    ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
      jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } }),
  ])
  ;[client, ui] = await Promise.all(['client', 'ui'].map((name) => import(pathToFileURL(join(output, `${name}.mjs`)).href)))
})

beforeEach(() => { requests = []; current = null })
afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = null
    // Radix restores focus on the next task; keep the JSDOM event constructors alive until then.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
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

test('features are additive and missing resume support fails closed', async () => {
  globalThis.fetch = async () => json({ realJobImports: true, realGradeLadders: true, realResumeImports: true, resumeLimits: { maxBatchItems: 10, maxPdfPages: 50 } })
  assert.deepEqual(await client.fetchResumeProcessingFeatures(), { realResumeImports: true, markdownResumeImports: false, resumeLimits: { maxBatchItems: 10, maxPdfPages: 50 } })
  globalThis.fetch = async () => json({ realJobImports: true })
  const unavailable = await client.fetchResumeProcessingFeatures()
  assert.equal(unavailable.realResumeImports, false)
  assert.equal(unavailable.markdownResumeImports, false)
  assert.equal(unavailable.resumeLimits.maxPdfBytes, 10 * 1024 * 1024)
})

test('Markdown resume capability must be advertised explicitly with real resume support', async () => {
  for (const features of [
    { realResumeImports: true }, { realResumeImports: true, markdownResumeImports: false },
    { realResumeImports: false, markdownResumeImports: true }, { markdownResumeImports: true },
    { realResumeImports: true, markdownResumeImports: 'true' },
  ]) {
    globalThis.fetch = async () => json(features)
    const result = await client.fetchResumeProcessingFeatures()
    assert.equal(result.markdownResumeImports, false)
    assert.equal(result.realResumeImports, features.realResumeImports === true)
    assert.equal(result.resumeLimits.maxMarkdownBytes, 10 * 1024 * 1024)
  }
  globalThis.fetch = async () => json({ realResumeImports: true, markdownResumeImports: true })
  assert.equal((await client.fetchResumeProcessingFeatures()).markdownResumeImports, true)
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

test('Markdown resume clients dispatch by extension and preserve original bytes, names, and batch headers regardless of MIME', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ resume: summary('accepted', 'w', 'queued') }, 202) }
  const bytes = new Uint8Array([239, 187, 191, ...new TextEncoder().encode('# Résumé\r\n\r\n- Original **evidence**\r\n')])
  for (const [name, type] of [
    ['résumé.MD', ''], ['resume.MarkDown', 'text/plain'], ['resume.md', 'application/octet-stream'],
    ['resume.MARKDOWN', 'application/pdf'], ['resume.md', 'text/markdown'],
  ]) {
    const file = new File([bytes], name, { type })
    await client.importRealResumeFile('w', file, key, batchId, 4)
    const request = requests.at(-1)
    assert.equal(request.url, '/api/workspaces/w/resumes/markdown')
    assert.equal(request.init.headers.get('Content-Type'), 'text/markdown')
    assert.equal(request.init.headers.get('X-File-Name'), encodeURIComponent(name))
    assert.equal(request.init.headers.get('Idempotency-Key'), key)
    assert.equal(request.init.headers.get('X-Import-Batch'), batchId)
    assert.equal(request.init.headers.get('X-Import-Count'), '4')
    assert.deepEqual(new Uint8Array(request.init.body), bytes)
  }
  await client.importRealResumeMarkdown('w', new File([bytes], 'resume.md'), key, batchId, 4)
  assert.equal(requests.at(-1).url, '/api/workspaces/w/resumes/markdown')
  await client.importRealResumeFile('w', new File(['%PDF-source'], 'resume.PDF'), key, batchId, 4)
  assert.equal(requests.at(-1).url, '/api/workspaces/w/resumes/pdf')
  assert.equal(requests.at(-1).init.headers.get('Content-Type'), 'application/pdf')
})

test('unsupported, unsafe, empty, oversized, or mismatched resume files never become guessed uploads', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); throw new Error('Unexpected upload') }
  for (const file of [
    new File(['# Profile'], 'resume.txt', { type: 'text/markdown' }), new File(['Profile'], 'resume.docx'),
    new File(['%PDF-source'], 'Role: engineer.pdf'), new File(['%PDF-source'], 'CON.pdf'),
    new File(['# Profile'], 'LPT1.md'), new File(['# Profile'], 'folder\\resume.md'),
    new File([], 'empty.markdown'), new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'oversized.MD'),
  ]) await assert.rejects(client.importRealResumeFile('w', file, key, batchId, 1), /not supported|safe|nonempty|10 MiB/)
  await assert.rejects(client.importRealResumePdf('w', new File(['# Profile'], 'resume.md', { type: 'application/pdf' }), key, batchId, 1), /safe .pdf filename/)
  await assert.rejects(client.importRealResumeMarkdown('w', new File(['%PDF-source'], 'resume.pdf'), key, batchId, 1), /safe .md or .markdown filename/)
  assert.equal(requests.length, 0)
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

test('mixed PDF/Markdown/URL batches retain invalid entries and same-named Markdown files as separate inputs', () => {
  const files = [
    new File(['%PDF-source'], 'resume.PDF'),
    new File(['# First profile'], 'resume.MD'),
    new File(['# Second profile'], 'resume.MD', { type: 'text/plain' }),
    new File(['# Third profile'], 'profile.MaRkDoWn', { type: 'application/pdf' }),
    new File(['# Not a supported file'], 'notes.txt', { type: 'text/markdown' }),
  ]
  const inputs = [...files.map(ui.resumeFileSource), { kind: 'url', url: 'https://example.test/profile' }, { kind: 'url', url: 'not a URL' }]
  assert.deepEqual(inputs.slice(0, 5).map((item) => item.kind), ['pdf', 'markdown', 'markdown', 'markdown', 'unsupported'])
  const initial = { id: batchId, inputCount: null, items: [] }
  const batch = ui.appendResumeInputs(initial, inputs, ui.RESUME_IMPORT_LIMITS, true)
  assert.deepEqual(batch.items.map((item) => item.state), ['pending', 'pending', 'pending', 'pending', 'invalid', 'pending', 'invalid'])
  assert.equal(new Set(batch.items.map((item) => item.key)).size, 7)
  assert.equal(batch.items[1].source.file, files[1])
  assert.equal(batch.items[2].source.file, files[2])
  assert.equal(batch.items[1].label, batch.items[2].label)
  const ten = ui.appendResumeInputs(batch, Array.from({ length: 3 }, (_, index) => ({ kind: 'url', url: `https://example.test/extra-${index}` })), ui.RESUME_IMPORT_LIMITS, true)
  assert.equal(ten.items.length, 10)
  assert.throws(() => ui.appendResumeInputs(ten, [ui.resumeFileSource(new File(['# Extra'], 'extra.md'))], ui.RESUME_IMPORT_LIMITS, true), /Nothing was truncated/)
  const disabled = ui.appendResumeInputs(initial, inputs)
  assert.deepEqual(disabled.items.map((item) => item.state), ['pending', 'invalid', 'invalid', 'invalid', 'invalid', 'pending', 'invalid'])
  assert.match(disabled.items[1].error, /not enabled/)
})

test('Markdown file validation uses bytes rather than PDF pages or pre-normalization character counts', () => {
  const limits = { ...ui.RESUME_IMPORT_LIMITS, maxPdfPages: 0 }
  const atLimit = ui.resumeFileSource(new File([new Uint8Array(10 * 1024 * 1024)], 'limit.MD'))
  assert.equal(ui.validateResumeInput(atLimit, limits, true), undefined)
  assert.match(ui.validateResumeInput(ui.resumeFileSource(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.markdown')), limits, true), /exceeds 10 MiB/)
  assert.match(ui.validateResumeInput(ui.resumeFileSource(new File([], 'empty.md')), limits, true), /empty/)
  assert.match(ui.validateResumeInput(ui.resumeFileSource(new File(['# Source'], 'unsafe\n.md')), limits, true), /safe filename/)
  assert.match(ui.validateResumeInput(atLimit, limits), /not enabled/)
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

test('Markdown evidence displays headings and literal text with only the exact quotation highlighted', () => {
  const document = detail().document
  document.paragraphs[0].text = 'Exact **source** text. <script>alert("not executed")</script> [link](https://example.test/)'
  const html = renderToStaticMarkup(React.createElement(ui.DocumentViewer, {
    document, pagination: 'markdown-sections', highlightedId: 'resume-p1', quote: '**source** text',
  }))
  assert.match(html, /Markdown section 1 of 1/)
  assert.match(html, /aria-label="Captured professional profile, Markdown section 1"/)
  assert.match(html, /<h3>.*Experience<\/h3>/)
  assert.match(html, /<mark>\*\*source\*\* text<\/mark>/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script|<a href=|Original page|Captured HTML|Fictional/)
})

test('Markdown resume library and detail identify uploads and sections rather than public URLs or PDF pages', async () => {
  const saved = markdownDetail()
  const api = {
    workspaceId: 'workspace-one', canWrite: true, phase: 'ready', features: { realResumeImports: true, markdownResumeImports: true, resumeLimits: ui.RESUME_IMPORT_LIMITS },
    error: null, summaries: [saved], detail: () => ({ state: 'ready', value: saved }), ensureDetail: async () => {}, refresh: async () => {},
    pending: () => false, originalUrl: () => '/api/saved-original', batches: [], currentBatchId: null,
  }
  root = createRoot(dom.window.document.getElementById('root'))
  for (const id of [undefined, saved.resume.id]) {
    await act(async () => root.render(React.createElement(ui.MemoryRouter, { key: id ?? 'library', future: { v7_startTransition: true, v7_relativeSplatPath: true } },
      React.createElement(ui.RealResumesContext.Provider, { value: api }, React.createElement(ui.RealResumesPage, { id })))))
    if (!id) {
      assert.match(dom.window.document.querySelector('tbody').textContent, /Markdown · added/)
      assert.doesNotMatch(dom.window.document.querySelector('tbody').textContent, /Public URL/)
    } else {
      assert.match(dom.window.document.querySelector('.source-footer').textContent, /Uploaded Markdown/)
      assert.match(dom.window.document.querySelector('.document-viewer').textContent, /Markdown section 1 of 1/)
      assert.match(dom.window.document.body.textContent, /Markdown sections, not PDF pages/)
      assert.doesNotMatch(dom.window.document.querySelector('.document-viewer').textContent, /Original page|Captured HTML/)
    }
  }
})

function markdownComparison(kind) {
  const saved = markdownDetail()
  const jobDocument = {
    id: 'frozen-job', kind: 'job', title: 'Frozen Markdown requirements', sample: false, version: 3,
    paragraphs: [{ id: 'job-p1', page: 1, heading: 'Responsibilities', text: 'Coordinate documented engineering projects.' }],
  }
  const resumeCitation = {
    documentId: saved.document.id, documentVersion: 1, paragraphId: 'resume-p1', page: 1,
    heading: 'Experience', quote: 'accessible project documentation',
  }
  const requirementCitation = {
    documentId: jobDocument.id, documentVersion: 3, paragraphId: 'job-p1', page: 1,
    heading: 'Responsibilities', quote: 'documented engineering projects',
  }
  const criterion = { id: 'criterion-one', label: 'Documentation', weight: 100, description: 'Document engineering work.', guidance: 'Assess exact source evidence.', requirementType: 'required' }
  const rubric = { version: 2, criteria: [criterion] }
  const target = {
    kind, summary: { label: 'Saved requirements', sublabel: 'Exact Markdown source' },
    selection: kind === 'job' ? { kind, rubricVersion: 2, documentVersion: 3 } : { kind, grade: 9, version: 2 },
    requirementEvidence: [{ kind: 'criterion', criterionId: criterion.id, citations: [requirementCitation] }],
    ...(kind === 'job' ? { rubric, document: jobDocument, original: { contentType: 'text/markdown' } }
      : { version: { id: 'approved-version', rubric, qualifications: [] }, approval: { id: 'approval' }, review: { id: 'review' },
        sourceSet: { id: 'frozen-set' }, seed: { document: jobDocument, source: { kind: 'markdown', originalContentType: 'text/markdown' } }, references: [] }),
  }
  return {
    comparison: { id: `comparison-${kind}`, runId: 'run-one', status: 'complete' },
    resumeSnapshot: { resume: saved.resume, document: saved.document, extraction: saved.extraction },
    targetSnapshot: target,
    result: {
      completion: 'complete', overall: { status: 'available', score: 100 }, summary: 'Review the captured evidence.', limitations: [],
      coverage: { supported: 1, partial: 0, missing: 0, notAssessed: 0, notApplicable: 0, assessedWeight: 100, totalWeight: 100 },
      criteria: [{ criterionId: criterion.id, evidenceStatus: 'supported', score: 5, rationale: 'Saved evidence supports the requirement.',
        citations: [resumeCitation], requirementCitations: [requirementCitation] }], qualifications: [],
      createdAt: timestamp, provenance: {
        assessment: { model: 'test', deployment: 'test', promptVersion: 'test', schemaVersion: 'test' }, calculationVersion: 'test',
        groundingReviews: [], correctionCount: 0, resumeSnapshot: { snapshotId: 'resume-snapshot', sha256: hash },
        targetSnapshot: { snapshotId: 'target-snapshot', sha256: hash },
      },
    },
  }
}

test('frozen Markdown resume, job and grade-seed evidence keep section labels and exact citations', async () => {
  root = createRoot(dom.window.document.getElementById('root'))
  for (const kind of ['job', 'grade']) {
    const saved = markdownComparison(kind)
    await act(async () => root.render(React.createElement(ui.RealComparisonReview, { key: kind, detail: saved })))
    assert.match(dom.window.document.querySelector('.document-viewer').textContent, /Markdown section 1 of 1/)
    await act(async () => dom.window.document.querySelector('button[aria-label^="View resume evidence"]').click())
    await settle(() => dom.window.document.querySelector('.document-viewer mark')?.textContent === 'accessible project documentation')
    await act(async () => dom.window.document.querySelector('button[aria-label^="View requirement evidence"]').click())
    await settle(() => dom.window.document.querySelector('.document-viewer mark')?.textContent === 'documented engineering projects')
    const viewer = dom.window.document.querySelector('.document-viewer')
    assert.match(viewer.textContent, /Markdown section 1 of 1/)
    assert.equal(viewer.querySelector('h3').textContent, 'Responsibilities')
    assert.doesNotMatch(viewer.textContent, /Original page|Captured HTML|Fictional/)
  }
  const mismatched = markdownComparison('job')
  mismatched.result.criteria[0].requirementCitations[0].quote = 'An absent quotation'
  await act(async () => root.render(React.createElement(ui.RealComparisonReview, { key: 'invalid', detail: mismatched })))
  await act(async () => dom.window.document.querySelector('button[aria-label^="View requirement evidence"]').click())
  await settle(() => dom.window.document.querySelector('[role="alert"]')?.textContent.includes('does not exactly match'))
  assert.equal(dom.window.document.querySelector('.document-viewer mark'), null)
})

test('copied frozen Markdown seed references use their captured MIME and the exact authorized document', async () => {
  const saved = markdownComparison('grade')
  const reference = { ...saved.targetSnapshot.seed.document, id: 'copied-markdown-seed', kind: 'reference', pageCount: 1, selectedPages: [], completeness: 'complete' }
  saved.result.criteria[0].requirementCitations[0].documentId = reference.id
  saved.targetSnapshot.references = [{
    source: { origin: 'seed-job', selectedPages: [], originalContentType: 'text/markdown' },
    document: { documentId: reference.id, documentVersion: reference.version },
  }]
  const calls = []
  const api = { document: async (...args) => { calls.push(args); return reference } }
  root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => root.render(React.createElement(ui.RealAnalysesContext.Provider, { value: api },
    React.createElement(ui.RealComparisonReview, { detail: saved }))))
  await act(async () => dom.window.document.querySelector('button[aria-label^="View requirement evidence"]').click())
  await settle(() => dom.window.document.querySelector('.document-viewer mark')?.textContent === 'documented engineering projects')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 4), ['run-one', 'comparison-grade', reference.id, reference.version])
  const viewer = dom.window.document.querySelector('.document-viewer')
  assert.match(viewer.textContent, /Markdown section 1 of 1/)
  assert.doesNotMatch(viewer.textContent, /Original page|Captured HTML/)
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
function tree(workspaceId, showProbe = true, role = 'owner', showDialog = false) {
  return React.createElement(ui.MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    React.createElement(ui.WorkspaceContext.Provider, { value: {
    workspace: sample, cloud: { currentWorkspaceId: workspaceId, workspaces: [{ id: workspaceId, role }] },
    addResumes: () => { throw new Error('Real input reached sample intake') }, startAnalysis: () => { throw new Error('Real input reached sample scoring') },
  } }, React.createElement(ui.RealResumesBridge, { workspaceId },
    React.createElement(React.Fragment, null, showProbe ? React.createElement(Probe) : null,
      showDialog ? React.createElement(ui.RealAddResumesDialog, { open: true, onOpenChange() {} }) : null))))
}
async function mount(workspaceId = 'workspace-one', showProbe = true, role = 'owner', showDialog = false) {
  root ??= createRoot(dom.window.document.getElementById('root'))
  await act(async () => { root.render(tree(workspaceId, showProbe, role, showDialog)); await new Promise((resolve) => setTimeout(resolve, 0)) })
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

test('mixed Markdown batches preserve retries, invalid entries and same-named files while releasing accepted file bytes', async () => {
  let lostKey
  let firstMarkdown = true
  let accepted = 0
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/features') return json({ realResumeImports: true, markdownResumeImports: true })
    if (init.method === 'GET') return json({ resumes: [] })
    if (url.endsWith('/markdown') && firstMarkdown) {
      firstMarkdown = false
      lostKey = init.headers.get('Idempotency-Key')
      return json({ error: { code: 'unavailable', message: 'Acceptance response lost.' } }, 503)
    }
    return json({ resume: summary(`accepted-${++accepted}`, 'workspace-one', 'queued') }, 202)
  }
  await mount()
  await settle(() => current?.phase === 'ready')
  const files = [
    new File(['%PDF-one'], 'resume.pdf'),
    new File(['# First profile\r\nExact bytes'], 'resume.MD'),
    new File(['# Second profile'], 'resume.MD', { type: 'application/pdf' }),
    new File(['invalid'], 'resume.docx'),
  ]
  const initial = JSON.stringify(sample)
  dom.window.localStorage.clear()
  await act(async () => current.stage([...files.map(ui.resumeFileSource), { kind: 'url', url: 'https://example.test/profile' }]))
  const batch = current.batches[0]
  const originalKeys = batch.items.map((item) => item.key)
  await act(async () => current.submitBatch(batch.id))
  assert.deepEqual(current.batches[0].items.map((item) => item.state), ['accepted', 'unconfirmed', 'accepted', 'invalid', 'accepted'])
  assert.equal(current.batches[0].inputCount, 5)
  assert.equal(current.batches[0].items[0].source.file, null)
  assert.equal(current.batches[0].items[2].source.file, null, 'accepted Markdown bytes are released')
  assert.equal(current.batches[0].items[2].source.kind, 'markdown', 'source label survives byte disposal')
  assert.equal(current.batches[0].items[1].source.file, files[1], 'unconfirmed source bytes stay in memory for an unchanged retry')
  assert.equal(current.batches[0].items[3].source.file, files[3], 'invalid input remains visible and is never sent')
  await mount('workspace-one', false)
  await mount()
  await act(async () => current.submitBatch(batch.id, [lostKey]))
  const posts = requests.filter((request) => request.init.method === 'POST')
  assert.equal(posts.length, 5)
  assert.deepEqual(posts.slice(0, 4).map((request) => request.url.split('/').at(-1)).sort(), ['markdown', 'markdown', 'pdf', 'url'])
  assert.equal(posts[4].url.split('/').at(-1), 'markdown')
  assert.equal(new Set(posts.slice(0, 4).map((request) => request.init.headers.get('Idempotency-Key'))).size, 4)
  const retries = posts.filter((request) => request.init.headers.get('Idempotency-Key') === lostKey)
  assert.equal(retries.length, 2)
  for (const request of posts) {
    assert.equal(request.init.headers.get('X-Import-Batch'), batch.id)
    assert.equal(request.init.headers.get('X-Import-Count'), '5')
  }
  assert.deepEqual(new Uint8Array(retries[0].init.body), new Uint8Array(retries[1].init.body))
  assert.deepEqual(current.batches[0].items.map((item) => item.key), originalKeys)
  assert.equal(current.batches[0].items[1].source.file, null)
  assert.equal(JSON.stringify(sample), initial)
  assert.equal(dom.window.localStorage.length, 0)
})

test('unadvertised Markdown remains an invalid item while a mixed batch still sends PDF and URL inputs', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/features') return json({ realResumeImports: true })
    if (init.method === 'GET') return json({ resumes: [] })
    return json({ resume: summary(`accepted-${requests.length}`, 'workspace-one', 'queued') }, 202)
  }
  await mount()
  await settle(() => current?.phase === 'ready')
  await act(async () => current.stage([
    ui.resumeFileSource(new File(['# Source'], 'resume.md')),
    ui.resumeFileSource(new File(['%PDF-source'], 'resume.pdf')),
    { kind: 'url', url: 'https://example.test/profile' },
    ui.resumeFileSource(new File(['unknown'], 'resume.txt')),
  ]))
  assert.deepEqual(current.batches[0].items.map((item) => item.state), ['invalid', 'pending', 'pending', 'invalid'])
  assert.match(current.batches[0].items[0].error, /not enabled/)
  await act(async () => current.submitBatch(current.batches[0].id))
  const posts = requests.filter((request) => request.init.method === 'POST')
  assert.deepEqual(posts.map((request) => request.url.split('/').at(-1)).sort(), ['pdf', 'url'])
  assert.equal(posts.every((request) => request.init.headers.get('X-Import-Count') === '4'), true)
  assert.deepEqual(current.batches[0].items.map((item) => item.state), ['invalid', 'accepted', 'accepted', 'invalid'])
})

test('a capability removed after staging is checked again before Markdown submission', async () => {
  let enabled = true
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/features') return json({ realResumeImports: true, ...(enabled ? { markdownResumeImports: true } : {}) })
    return json({ resumes: [] })
  }
  await mount()
  await settle(() => current?.phase === 'ready')
  await act(async () => current.stage([ui.resumeFileSource(new File(['# Source'], 'resume.md'))]))
  assert.equal(current.batches[0].items[0].state, 'pending')
  enabled = false
  await act(async () => current.refresh())
  await act(async () => current.submitBatch(current.batches[0].id))
  assert.equal(requests.some((request) => request.init.method === 'POST'), false)
  assert.match(current.batches[0].items[0].error, /not enabled/)
})

test('resume picker, drop zone and URL tab preserve one mixed batch with unknown files explicitly invalid', async () => {
  globalThis.fetch = async (url) => url === '/api/features'
    ? json({ realResumeImports: true, markdownResumeImports: true }) : json({ resumes: [] })
  await mount('workspace-one', true, 'owner', true)
  await settle(() => current?.phase === 'ready')
  const input = dom.window.document.querySelector('input[type="file"]')
  assert.equal(input.getAttribute('aria-label'), 'Choose resume PDF or Markdown files')
  assert.match(input.accept, /\.pdf,.md,.markdown/)
  const files = [new File(['%PDF-source'], 'resume.PDF'), new File(['# Experience'], 'resume.MD', { type: 'text/plain' })]
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  const keys = current.batches[0].items.map((item) => item.key)
  const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['# Other'], 'other.MarkDown'), new File(['unknown'], 'notes.txt')] } })
  await act(async () => dom.window.document.querySelector('.drop-zone').dispatchEvent(drop))
  assert.deepEqual(current.batches[0].items.map((item) => item.source.kind), ['pdf', 'markdown', 'markdown', 'unsupported'])
  const tab = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Public URLs')
  await act(async () => tab.click())
  const textarea = dom.window.document.querySelector('textarea')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'https://example.test/profile')
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const add = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Add URLs to batch')
  assert.equal(add.disabled, false)
  await act(async () => add.click())
  assert.equal(current.batches.length, 1)
  assert.equal(current.batches[0].items.length, 5)
  assert.deepEqual(current.batches[0].items.slice(0, 2).map((item) => item.key), keys)
  assert.equal(current.batches[0].items[3].state, 'invalid')
  assert.match(dom.window.document.querySelector('[aria-label="Real resume import batch"]').textContent, /Unsupported file/)
  assert.match(dom.window.document.body.textContent, /Import 4 valid inputs/)
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
