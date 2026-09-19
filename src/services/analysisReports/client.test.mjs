import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { loadReportFoundation, realReportFixture } from './test-support.mjs'

const output = resolve(`.report-download-tests-${randomUUID()}`)
const original = new Map()
let foundation, api, report, dom, workers, behavior, downloads, revoked, timerCallbacks
const csvBytes = () => Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a).buffer
const pdfBytes = () => new TextEncoder().encode('%PDF-1.7\n').buffer
const officeBytes = () => Uint8Array.of(0x50, 0x4b, 0x03, 0x04).buffer
const links = { origin: 'https://score.test', workspaceId: 'workspace-one' }
function install(name, value) {
  if (!original.has(name)) original.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

before(async () => {
  await mkdir(output)
  foundation = await loadReportFoundation()
  report = foundation.api.buildAnalysisReport(realReportFixture({ scores: [88] }))
  await build({
    entryPoints: ['src/services/analysisReports/client.ts'], outfile: join(output, 'client.mjs'),
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
    define: { 'import.meta.url': '"https://score.test/src/services/analysisReports/client.ts"' },
  })
  api = await import(pathToFileURL(join(output, 'client.mjs')).href)
})
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://score.test/analyses/run-one' })
  workers = []; downloads = []; revoked = []; timerCallbacks = []
  behavior = (worker, request) => queueMicrotask(() => worker.onmessage?.({
    data: { type: 'complete', requestId: request.requestId, bytes: csvBytes() },
  }))
  install('window', dom.window)
  install('document', dom.window.document)
  install('fetch', async () => { throw new Error('Unexpected report network request') })
  install('Worker', class {
    constructor(url, options) { this.url = url; this.options = options; this.terminated = 0; workers.push(this) }
    postMessage(request, transfer) { this.request = request; this.transfer = transfer; behavior(this, request) }
    terminate() { this.terminated++ }
  })
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  original.set('restoreObjectURLs', { value: () => { URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL } })
  URL.createObjectURL = (blob) => { downloads.push({ blob }); return 'blob:report-fixture' }
  URL.revokeObjectURL = (url) => revoked.push(url)
  dom.window.HTMLAnchorElement.prototype.click = function () {
    downloads.at(-1).filename = this.download
    downloads.at(-1).url = this.href
  }
  dom.window.setTimeout = (callback) => { timerCallbacks.push(callback); return timerCallbacks.length }
})
afterEach(() => {
  original.get('restoreObjectURLs')?.value()
  original.delete('restoreObjectURLs')
  for (const [name, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  original.clear()
  dom.window.close()
})
after(async () => { await foundation?.cleanup(); await rm(output, { recursive: true, force: true }) })

test('worker results are matched to the request, validated, and terminated before returning bytes', async () => {
  const controller = new AbortController()
  const messages = []
  behavior = (worker, request) => queueMicrotask(() => {
    worker.onmessage({ data: { type: 'progress', requestId: request.requestId, message: 'Preparing CSV' } })
    worker.onmessage({ data: { type: 'complete', requestId: request.requestId, bytes: csvBytes() } })
  })
  const bytes = await api.generateReportInWorker(report, 'csv', { signal: controller.signal, links, onProgress: (message) => messages.push(message) })
  assert.deepEqual(new Uint8Array(bytes), new Uint8Array(csvBytes()))
  assert.deepEqual(messages, ['Preparing CSV'])
  assert.equal(workers.length, 1)
  assert.equal(workers[0].options.type, 'module')
  assert.equal(workers[0].terminated, 1)
  assert.equal(workers[0].request.report.run.id, report.run.id)
  assert.deepEqual(workers[0].request.options.links, links)
  assert.deepEqual(workers[0].transfer, [])
  controller.abort()
  assert.equal(workers[0].terminated, 1)
  assert.equal(downloads.length, 0)
})

test('foreign, malformed, and wrong-file worker responses fail closed', async () => {
  for (const reply of [
    (request) => ({ type: 'complete', requestId: 'wrong-request', bytes: csvBytes() }),
    (request) => ({ type: 'complete', requestId: request.requestId, bytes: new TextEncoder().encode('<html>sign in</html>').buffer }),
    (request) => ({ type: 'complete', requestId: request.requestId, bytes: 'not bytes' }),
    (request) => ({ type: 'unknown', requestId: request.requestId }),
  ]) {
    behavior = (worker, request) => queueMicrotask(() => worker.onmessage({ data: reply(request) }))
    await assert.rejects(api.generateReportInWorker(report, 'csv', { signal: new AbortController().signal, links }), /different|invalid/)
    assert.equal(workers.at(-1).terminated, 1)
  }
  assert.equal(downloads.length, 0)
})

test('worker errors are visible and cancellation terminates generation without downloading', async () => {
  behavior = (worker, request) => queueMicrotask(() => worker.onmessage({
    data: { type: 'error', requestId: request.requestId, message: 'This text cannot be rendered.' },
  }))
  await assert.rejects(api.generateReportInWorker(report, 'csv', { signal: new AbortController().signal, links }), /cannot be rendered/)
  behavior = () => {}
  const controller = new AbortController()
  const pending = api.generateReportInWorker(report, 'csv', { signal: controller.signal, links })
  controller.abort()
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  assert.equal(workers.at(-1).terminated, 1)
  assert.equal(downloads.length, 0)
  const before = workers.length
  await assert.rejects(api.generateReportInWorker(report, 'csv', { signal: controller.signal, links }), (error) => error.name === 'AbortError')
  assert.equal(workers.length, before)
})

test('PDF font bytes come only from same-origin bundled assets and transfer into the worker', async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options })
    return new Response(Uint8Array.of(0, 1, 0, 0, 1, 2, 3), { headers: { 'Content-Type': 'font/ttf' } })
  }
  behavior = (worker, request) => queueMicrotask(() => worker.onmessage({
    data: { type: 'complete', requestId: request.requestId, bytes: pdfBytes() },
  }))
  await api.generateReportInWorker(report, 'pdf', { signal: new AbortController().signal, links })
  assert.deepEqual(requests.map(({ url }) => url), [
    'https://score.test/src/assets/report-fonts/NotoSans-Regular.ttf',
    'https://score.test/src/assets/report-fonts/NotoSans-Bold.ttf',
  ])
  assert.ok(requests.every(({ options }) => options.credentials === 'same-origin' && options.redirect === 'error'))
  assert.equal(workers[0].transfer.length, 2)
  assert.deepEqual(workers[0].request.options.links, links)
  assert.deepEqual(new Uint8Array(workers[0].request.options.fonts.regular), Uint8Array.of(0, 1, 0, 0, 1, 2, 3))
})

test('HTML, oversized, and failed font responses never start a PDF worker', async () => {
  for (const response of [
    () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
    () => new Response('Unavailable', { status: 503 }),
  ]) {
    globalThis.fetch = async () => response()
    await assert.rejects(api.generateReportInWorker(report, 'pdf', { signal: new AbortController().signal, links }), /font|TrueType/)
  }
  assert.equal(workers.length, 0)
})

test('one failed font request cancels other pending font work', async () => {
  let otherSignal
  globalThis.fetch = (url, { signal }) => {
    if (String(url).includes('-Regular.ttf')) return Promise.resolve(new Response('Unavailable', { status: 503 }))
    otherSignal = signal
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  await assert.rejects(api.generateReportInWorker(report, 'pdf', { signal: new AbortController().signal, links }), /fonts could not be loaded/)
  assert.equal(otherSignal.aborted, true)
  assert.equal(workers.length, 0)
})

test('download uses the expected MIME, safe filename and short-lived object URL without storing report data', async () => {
  const filename = api.downloadAnalysisReport(csvBytes(), { ...report, run: { ...report.run, name: '../Private: review' }, partial: true }, 'csv', new AbortController().signal)
  assert.equal(filename, '-Private- review.csv')
  assert.equal(downloads[0].filename, filename)
  assert.equal(downloads[0].blob.type, 'text/csv;charset=utf-8')
  assert.equal(downloads[0].url, 'blob:report-fixture')
  assert.equal(document.querySelectorAll('a').length, 0)
  assert.deepEqual(revoked, [])
  timerCallbacks.forEach((callback) => callback())
  assert.deepEqual(revoked, ['blob:report-fixture'])
  assert.equal(dom.window.localStorage.length, 0)
  assert.equal(dom.window.sessionStorage.length, 0)
})

test('concise exports require valid link context before font requests or worker startup', async () => {
  for (const format of ['csv', 'pdf', 'pptx']) {
    await assert.rejects(api.generateReportInWorker(report, format, { signal: new AbortController().signal }), /trusted application origin/)
    await assert.rejects(api.generateReportInWorker(report, format, {
      signal: new AbortController().signal, links: { ...links, origin: 'https://score.test/private' },
    }), /valid HTTP\(S\)/)
    await assert.rejects(api.generateReportInWorker(report, format, {
      signal: new AbortController().signal, links: { ...links, workspaceId: 'another-workspace' },
    }), /must match/)
  }
  assert.equal(workers.length, 0)
  assert.equal(downloads.length, 0)
})

test('Word remains generatable without links and retains its partial filename', async () => {
  behavior = (worker, request) => queueMicrotask(() => worker.onmessage({
    data: { type: 'complete', requestId: request.requestId, bytes: officeBytes() },
  }))
  const bytes = await api.generateReportInWorker(report, 'docx', { signal: new AbortController().signal })
  assert.equal(workers[0].request.options.links, undefined)
  assert.deepEqual(workers[0].transfer, [])
  const filename = api.downloadAnalysisReport(bytes, { ...report, partial: true }, 'docx', new AbortController().signal)
  assert.equal(filename, 'Saved evidence review - partial.docx')
})

test('only concise formats omit the partial filename marker and sample filenames stay labeled', () => {
  for (const format of ['csv', 'pdf', 'pptx']) {
    const bytes = format === 'csv' ? csvBytes() : format === 'pdf' ? pdfBytes() : officeBytes()
    const filename = api.downloadAnalysisReport(bytes, { ...report, dataKind: 'sample', partial: true }, format, new AbortController().signal)
    assert.equal(filename, `Sample - Saved evidence review.${format}`)
  }
})

test('aborted or invalid-file downloads create no object URL or anchor', () => {
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => api.downloadAnalysisReport(csvBytes(), report, 'csv', controller.signal), (error) => error.name === 'AbortError')
  assert.throws(() => api.downloadAnalysisReport(new ArrayBuffer(0), report, 'csv', new AbortController().signal), /empty/)
  assert.throws(() => api.downloadAnalysisReport(csvBytes(), report, 'pdf', new AbortController().signal), /invalid file/)
  assert.equal(downloads.length, 0)
})
