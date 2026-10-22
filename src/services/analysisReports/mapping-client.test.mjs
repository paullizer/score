import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = resolve(`.mapping-client-tests-${randomUUID()}`)
const original = new Map()
let api, workers, behavior, timers
function install(name, value) {
  original.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
const file = () => new File(['ID,Name\nApplicant 093,Local HR Name'], 'mapping.csv', { type: 'text/csv' })
const workbook = { sheets: [{ name: 'CSV', rows: [['ID', 'Name'], ['Applicant 093', 'Local HR Name']] }] }
before(async () => {
  await mkdir(output)
  await build({
    entryPoints: ['src/services/analysisReports/mapping-client.ts'], outfile: join(output, 'client.mjs'),
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
    define: { 'import.meta.url': '"https://score.test/src/services/analysisReports/mapping-client.ts"' },
  })
  api = await import(pathToFileURL(join(output, 'client.mjs')).href)
})
beforeEach(() => {
  workers = []; timers = []
  behavior = worker => queueMicrotask(() => worker.onmessage?.({ data: { workbook } }))
  install('Worker', class {
    constructor(url, options) { this.url = url; this.options = options; this.terminated = 0; workers.push(this) }
    postMessage(request, transfer) { this.request = request; this.transfer = transfer; behavior(this) }
    terminate() { this.terminated++ }
  })
  install('fetch', () => { throw new Error('Unexpected mapping network request') })
  install('setTimeout', callback => { timers.push(callback); return timers.length })
  install('clearTimeout', () => {})
})
afterEach(() => {
  for (const [name, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  original.clear()
})
after(async () => { await rm(output, { recursive: true, force: true }) })

test('local mapping bytes transfer only to an owned worker and every handler is cleared on completion', async () => {
  const result = await api.readLocalMapping(file(), new AbortController().signal)
  assert.deepEqual(result, workbook)
  assert.equal(workers.length, 1)
  assert.equal(workers[0].options.type, 'module')
  assert.deepEqual(workers[0].transfer, [workers[0].request.bytes])
  assert.equal(workers[0].terminated, 1)
  assert.equal(workers[0].onmessage, null)
  assert.equal(workers[0].onerror, null)
  timers[0]()
  assert.equal(workers[0].terminated, 1)
})

test('invalid input and pre-aborted work never create a parser worker', async () => {
  for (const invalid of [new File(['x'], 'mapping.xls'), new File([], 'empty.csv'), new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.csv')]) {
    await assert.rejects(api.readLocalMapping(invalid, new AbortController().signal), /nonempty/)
  }
  await assert.rejects(api.readLocalMapping(file(), AbortSignal.abort()), error => error.name === 'AbortError')
  assert.equal(workers.length, 0)
})

test('cancelling while reading file bytes prevents worker startup', async () => {
  const controller = new AbortController()
  const input = file()
  input.arrayBuffer = async () => { controller.abort(); return new ArrayBuffer(1) }
  await assert.rejects(api.readLocalMapping(input, controller.signal), error => error.name === 'AbortError')
  assert.equal(workers.length, 0)
})

test('cancellation and parsing timeout terminate the worker and cannot return a late workbook', async () => {
  for (const mode of ['abort', 'timeout']) {
    const controller = new AbortController()
    behavior = worker => queueMicrotask(() => {
      const late = worker.onmessage
      if (mode === 'abort') controller.abort()
      else timers.at(-1)()
      late({ data: { workbook } })
    })
    await assert.rejects(api.readLocalMapping(file(), controller.signal), /abort|too long/i)
    assert.equal(workers.at(-1).terminated, 1)
    assert.equal(workers.at(-1).onmessage, null)
  }
})

test('parser errors and malformed messages are explicit and dispose their worker', async () => {
  for (const message of [{ error: 'Choose a plain-value workbook.' }, {}, null]) {
    behavior = worker => queueMicrotask(() => worker.onmessage({ data: message }))
    await assert.rejects(api.readLocalMapping(file(), new AbortController().signal), /plain-value|invalid/)
    assert.equal(workers.at(-1).terminated, 1)
  }
})
