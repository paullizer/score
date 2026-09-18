import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { docxFile, legacyDocFile } from '../../server-tests/word-fixtures.mjs'
import {
  buildWordPreviewTestRuntime, docType, docxType, evidenceText, png, richPreviewDocx, startWordPreviewFixture,
} from './wordPreview.test-support.mjs'

let runtime, browser
const previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP }
const visible = async (locator) => { await locator.waitFor({ state: 'visible' }); return locator }
const originalRequests = (fixture) => fixture.requests.filter((request) => request.url.endsWith('/original'))
const uploads = (fixture) => fixture.requests.filter((request) => request.method === 'POST')
const frame = (page) => page.frameLocator('iframe[title="Approximate formatted Word preview"]')

before(async () => {
  runtime = await buildWordPreviewTestRuntime()
  process.env.TEMP = runtime.directory
  process.env.TMP = runtime.directory
  try { browser = await chromium.launch({ headless: true, downloadsPath: runtime.directory }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true, downloadsPath: runtime.directory })
  }
})
after(async () => {
  await browser?.close()
  for (const [key, value] of Object.entries(previousTemp)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await runtime?.close()
})

async function open(t, options) {
  const fixture = await startWordPreviewFixture(runtime, options)
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, reducedMotion: 'reduce' })
  await context.addCookies([{ url: fixture.origin, name: 'private-session', value: 'authorized' }])
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors = [], external = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith(fixture.origin)) external.push(request.url()) })
  await page.addInitScript(() => {
    window.previewWorkers = { started: 0, terminated: 0 }
    const RealWorker = window.Worker
    window.Worker = class extends RealWorker {
      constructor(...args) { super(...args); window.previewWorkers.started++ }
      terminate() { window.previewWorkers.terminated++; return super.terminate() }
    }
  })
  t.after(async () => { await context.close(); await fixture.close() })
  await page.goto(fixture.origin)
  await page.waitForFunction(() => window.wordTest)
  return { page, context, fixture, errors, external }
}

test('real job DOCX preview is lazy, private, semantic, sandboxed, and citation clicks restore exact evidence', { timeout: 60_000 }, async (t) => {
  const { page, fixture, external, errors } = await open(t, { state: { wordEnabled: false } })
  await visible(page.getByText('Captured source section 1 of 1', { exact: true }))
  assert.equal(originalRequests(fixture).length, 0)
  assert.deepEqual(await page.evaluate(() => window.previewWorkers), { started: 0, terminated: 0 })
  const view = page.getByRole('button', { name: 'Formatted Word preview', exact: true })
  await view.click()
  await visible(frame(page).getByRole('heading', { name: 'Engineering specialist', exact: true }))
  await visible(page.getByText('Approximate Word formatting', { exact: true }))
  assert.equal(await frame(page).locator('strong').textContent(), 'Strong evidence')
  assert.equal(await frame(page).locator('em').textContent(), 'emphasized work')
  assert.equal(await frame(page).locator('ol li').textContent(), 'First responsibility')
  assert.match(await frame(page).locator('table').textContent(), /SkillEngineering/)
  assert.equal(await frame(page).locator('img').count(), 1)
  await page.waitForFunction(() => window.previewWorkers.terminated === 1)
  assert.equal(await frame(page).locator('img').evaluate((image) => image.naturalWidth), 1)
  assert.equal(await frame(page).locator('a,script,style,svg,form,iframe,object,embed').count(), 1, 'Only the fixed preview stylesheet remains.')
  assert.equal(await frame(page).locator('a,script,svg,form,iframe,object,embed').count(), 0)
  assert.equal(await page.locator('.docx-preview-frame').getAttribute('sandbox'), '')
  assert.equal(await page.locator('.docx-preview-frame').getAttribute('referrerpolicy'), 'no-referrer')
  assert.match(await page.locator('.docx-preview-frame').getAttribute('srcdoc'), /default-src 'none'.*connect-src 'none'.*form-action 'none'/)
  assert.match(originalRequests(fixture)[0].headers.cookie, /private-session=authorized/)
  assert.equal(originalRequests(fixture)[0].headers['x-score-request'], 'workspace')
  assert.equal(await page.evaluate(() => window.__previewXss), undefined)
  assert.deepEqual(external, [], 'No linked image, script, font or navigation may reach the network.')
  const citation = page.getByRole('button', { name: /^View exact source/ })
  assert.match(await citation.textContent(), /Captured section 1/)
  assert.doesNotMatch(await citation.textContent(), /p\. 1/)
  for (let index = 0; index < 2; index++) {
    await citation.click()
    await visible(page.locator('.document-paragraph.is-highlighted mark'))
    assert.equal(await page.locator('.document-paragraph.is-highlighted mark').textContent(), evidenceText)
    assert.equal(await page.locator('.docx-preview-frame').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Extracted text', exact: true }).getAttribute('aria-pressed'), 'true')
    if (index === 0) { await view.click(); await visible(frame(page).getByRole('heading', { name: 'Engineering specialist', exact: true })) }
  }
  assert.equal(await page.evaluate(() => localStorage.length), 0)
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), [])
  assert.deepEqual(errors, [])
})

test('resume DOCX preview remains readable with admission disabled; legacy DOC stays explicit text-only', { timeout: 60_000 }, async (t) => {
  const { page, fixture } = await open(t, { state: { mode: 'resume', wordEnabled: false } })
  await visible(page.getByRole('heading', { name: 'Synthetic candidate', exact: true }))
  await visible(page.getByText('Captured source section 1 of 1', { exact: true }))
  assert.equal(originalRequests(fixture).length, 0)
  await page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await visible(frame(page).getByRole('heading', { name: 'Engineering specialist', exact: true }))
  const legacy = await open(t, { format: 'doc', state: { mode: 'resume', wordEnabled: false } })
  await visible(legacy.page.getByText('Legacy Word DOC · text-only preview.', { exact: true }))
  await visible(legacy.page.getByText('Captured source section 1 of 1', { exact: true }))
  assert.equal(await legacy.page.getByRole('button', { name: 'Formatted Word preview', exact: true }).count(), 0)
  assert.equal(await legacy.page.getByText(/Original page|PDF pages/).count(), 0)
  assert.equal(originalRequests(legacy.fixture).length, 0)
  const url = await legacy.page.getByRole('link', { name: 'Download captured original', exact: true }).getAttribute('href')
  const response = await legacy.context.request.get(`${legacy.fixture.origin}${url}`)
  assert.equal(response.headers()['content-type'], docType)
  assert.deepEqual(await response.body(), legacy.fixture.bytes)
})

test('safe formatted Word text and tables do not produce false content-removal warnings', { timeout: 30_000 }, async (t) => {
  const { page, errors } = await open(t, {
    bytes: docxFile(`Engineering specialist\n${evidenceText}`, { table: [['Skill', 'Engineering']] }),
  })
  const clean = await page.evaluate(() => window.wordTest.sanitize('<h1>Safe heading</h1><p>Safe evidence</p>'))
  assert.deepEqual(clean.warnings, [])
  await page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await visible(frame(page).getByRole('heading', { name: 'Engineering specialist', exact: true }))
  assert.match(await frame(page).locator('table').textContent(), /SkillEngineering/)
  assert.equal(await page.getByText('Preview limitations', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
})

test('hash mismatch is explicit and nonfatal; retry fetches and verifies the same private original', { timeout: 60_000 }, async (t) => {
  const { page, fixture } = await open(t)
  let first = true
  fixture.controls.original = (_req, res) => {
    if (!first) return false
    first = false
    const corrupt = Buffer.from(fixture.bytes)
    corrupt[100] ^= 0xff
    res.writeHead(200, { 'Content-Type': docxType, 'Content-Length': corrupt.length })
    res.end(corrupt)
    return true
  }
  await page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await visible(page.getByText(/does not match its saved SHA-256 hash/))
  assert.equal(await page.locator('.document-viewer, .docx-preview-frame').count(), 0, 'Conversion failure must not silently substitute a successful-looking extracted preview.')
  assert.equal(await page.evaluate(() => window.previewWorkers.started), 0)
  await visible(page.getByRole('heading', { name: 'Engineering specialist', exact: true }))
  await page.getByRole('button', { name: 'Retry formatted preview', exact: true }).click()
  await visible(frame(page).getByRole('heading', { name: 'Engineering specialist', exact: true }))
  assert.equal(originalRequests(fixture).length, 2)
  assert.equal(await page.evaluate(() => window.previewWorkers.terminated), 1)
})

test('bounded private fetch rejects oversized streams, wrong MIME, mismatched sizes, redirects and external endpoints', { timeout: 60_000 }, async (t) => {
  const { page, fixture } = await open(t, { metadata: { bytes: undefined, sha256: undefined } })
  const url = `${fixture.origin}/api/workspaces/workspace-one/jobs/job-one/original`
  const rejection = (metadata = {}) => page.evaluate(async ({ url, metadata }) => {
    try { await window.wordTest.fetchOriginal(url, metadata); return 'unexpected success' }
    catch (error) { return error.message }
  }, { url, metadata })
  fixture.controls.original = (_req, res) => {
    res.writeHead(200, { 'Content-Type': docxType })
    res.write(Buffer.alloc(10 * 1024 * 1024))
    res.end(Buffer.alloc(1))
    return true
  }
  assert.match(await rejection(), /bounded preview size/)
  fixture.controls.original = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>Sign in</p>'); return true }
  assert.match(await rejection(), /did not return a DOCX/)
  fixture.controls.original = (_req, res) => { res.writeHead(200, { 'Content-Type': docxType, 'Content-Length': '2' }); res.end('ab'); return true }
  assert.match(await rejection({ bytes: 3 }), /saved file size/)
  fixture.controls.original = (_req, res) => { res.writeHead(302, { Location: 'https://external.invalid/preview' }); res.end(); return true }
  assert.notEqual(await rejection(), 'unexpected success')
  for (const value of ['https://external.invalid/original', `${fixture.origin}/public.docx`, `${url}?redirect=elsewhere`]) {
    const before = fixture.requests.length
    const result = await page.evaluate(async (value) => {
      try { await window.wordTest.fetchOriginal(value, {}); return 'unexpected success' } catch (error) { return error.message }
    }, value)
    assert.match(result, /private, same-origin original endpoint/)
    assert.equal(fixture.requests.length, before)
  }
})

test('actual converter rejects corrupt and overexpanded archives, caps raster images, and ignores embedded style maps', { timeout: 60_000 }, async (t) => {
  const invalid = await open(t, { bytes: Buffer.from('not a Word archive at all') })
  await invalid.page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await visible(invalid.page.getByText(/archive directory is missing or corrupt/))
  assert.equal(await invalid.page.evaluate(() => window.previewWorkers.started), 1)
  assert.equal(await invalid.page.evaluate(() => window.previewWorkers.terminated), 1)
  const expanded = await open(t, { bytes: richPreviewDocx({ extraParts: { 'word/oversized.xml': Buffer.alloc(16 * 1024 * 1024 + 1, 0x20) } }) })
  await expanded.page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await visible(expanded.page.getByText(/oversized DOCX entry/))
  assert.equal(await expanded.page.locator('.docx-preview-frame').count(), 0)
  const images = await open(t, { bytes: richPreviewDocx({ images: 26 }) })
  await images.page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await visible(frame(images.page).getByRole('heading', { name: 'Engineering specialist', exact: true }))
  assert.equal(await frame(images.page).locator('img').count(), 24)
  await visible(images.page.getByText(/omitted to keep the preview within its image limits/))
  const forged = docxFile('Source content '.repeat(100))
  for (let offset = 0; offset + 46 < forged.length; offset++) {
    if (forged.readUInt32LE(offset) === 0x02014b50) {
      const name = forged.subarray(offset + 46, offset + 46 + forged.readUInt16LE(offset + 28)).toString()
      if (name === 'word/document.xml') { forged.writeUInt32LE(1, offset + 24); break }
    }
  }
  const actualExpansionError = await invalid.page.evaluate(async (bytes) => {
    try { await window.wordTest.validateArchive(bytes); return 'unexpected success' } catch (error) { return error.message }
  }, [...forged])
  assert.match(actualExpansionError, /actual expanded preview size limit/)
})

test('genuine JPEG/GIF images are readable; raster byte and pixel budgets reject oversized resources', { timeout: 60_000 }, async (t) => {
  const { page } = await open(t)
  const jpeg = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    return canvas.toDataURL('image/jpeg').split(',')[1]
  }), 'base64')
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  for (const [imageType, imageBytes, width] of [['image/jpeg', jpeg, 2], ['image/gif', gif, 1]]) {
    const fixture = await open(t, { bytes: richPreviewDocx({ imageType, imageBytes }) })
    await fixture.page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
    await visible(frame(fixture.page).getByRole('heading', { name: 'Engineering specialist', exact: true }))
    assert.equal(await frame(fixture.page).locator('img').count(), 1)
    assert.equal(await frame(fixture.page).locator('img').evaluate((image) => image.naturalWidth), width)
  }
  const large = await open(t, { bytes: richPreviewDocx({ imageBytes: Buffer.concat([png, Buffer.alloc(1024 * 1024)]) }) })
  await large.page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await visible(frame(large.page).getByRole('heading', { name: 'Engineering specialist', exact: true }))
  assert.equal(await frame(large.page).locator('img').count(), 0)
  await visible(large.page.getByText(/oversized or unsupported embedded image was omitted/))
  const oversizedPixels = Buffer.from(png)
  oversizedPixels.writeUInt32BE(5000, 16)
  oversizedPixels.writeUInt32BE(5000, 20)
  const result = await page.evaluate((base64) => window.wordTest.sanitize(`<p>Safe evidence</p><img src="data:image/png;base64,${base64}">`), oversizedPixels.toString('base64'))
  assert.doesNotMatch(result.srcDoc, /<img/)
  const aggregatePixels = Buffer.from(png)
  aggregatePixels.writeUInt32BE(3000, 16)
  aggregatePixels.writeUInt32BE(3000, 20)
  const aggregate = await page.evaluate((base64) => window.wordTest.sanitize(`<p>Safe evidence</p>${`<img src="data:image/png;base64,${base64}">`.repeat(3)}`), aggregatePixels.toString('base64'))
  assert.equal((aggregate.srcDoc.match(/<img/g) ?? []).length, 2, 'Total decoded pixels are capped independently of compressed image bytes.')
})

test('sanitizer strips XSS, active SVG, external CSS/resources and every navigation capability', { timeout: 30_000 }, async (t) => {
  const { page, external } = await open(t)
  const result = await page.evaluate(() => window.wordTest.sanitize(`
    <h2 onclick="parent.__previewXss=true">Safe heading</h2>
    <p><strong>Readable evidence</strong><a href="javascript:parent.__previewXss=true" target="_top">link text</a></p>
    <script>parent.__previewXss=true</script><base href="https://external.invalid/">
    <style>@import "https://external.invalid/private.css";</style>
    <img src="https://external.invalid/pixel" srcset="https://external.invalid/pixel2 2x" onerror="parent.__previewXss=true">
    <img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=">
    <svg><a href="https://external.invalid/svg">svg</a></svg>
    <math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=parent.__previewXss=true>"></table></mtext></math>
    <iframe src="https://external.invalid/frame"></iframe><object data="https://external.invalid/object"></object>
    <form action="https://external.invalid/submit"><input name="private" value="source"><button>Submit</button></form>
    <p style="background:url(https://external.invalid/background)" data-private="hidden" id="constructor">Still readable</p>
  `))
  assert.match(result.srcDoc, /Safe heading|Readable evidence/)
  assert.doesNotMatch(result.srcDoc, /<script|<svg|<math|<iframe|<object|<form|<input|<button|<base|<a\s|onerror=|onclick=|external\.invalid|data-private=/i)
  assert.ok(result.warnings.length)
  assert.deepEqual(external, [])
  assert.equal(await page.evaluate(() => window.__previewXss), undefined)
})

test('workspace/document changes abort original fetches and terminate stale workers; conversion timeout can be retried', { timeout: 60_000 }, async (t) => {
  const { page, fixture, errors } = await open(t)
  let closed = false
  let release
  const held = new Promise((resolve) => { release = resolve })
  fixture.controls.original = async (_req, res) => {
    res.on('close', () => { closed = true })
    await held
    return false
  }
  await page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await visible(page.getByText('Loading and privately converting the DOCX…', { exact: true }))
  await page.waitForTimeout(50)
  await page.evaluate(() => window.wordTest.render({ workspaceId: 'workspace-two', id: 'two', title: 'Second workspace', text: 'Second workspace evidence.' }))
  await visible(page.getByText('Second workspace evidence.', { exact: true }).first())
  release()
  await page.waitForFunction(() => !document.querySelector('.docx-preview-frame'))
  for (let index = 0; index < 30 && !closed; index++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(closed, true)
  assert.equal(await page.evaluate(() => window.previewWorkers.started), 0)
  fixture.controls.original = null
  await page.route('**/docxPreview.worker.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'self.onmessage = () => {};' }))
  await page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await page.waitForFunction(() => window.previewWorkers.started === 1)
  await page.evaluate(() => window.wordTest.render({ workspaceId: 'workspace-three', id: 'three', title: 'Third workspace' }))
  await visible(page.getByRole('heading', { name: 'Third workspace', exact: true }).first())
  assert.equal(await page.evaluate(() => window.previewWorkers.terminated), 1)
  await page.clock.install()
  await page.getByRole('button', { name: 'Formatted Word preview', exact: true }).click()
  await page.waitForFunction(() => window.previewWorkers.started === 2)
  await page.clock.fastForward(15_100)
  await visible(page.getByText(/The formatted preview timed out/))
  assert.equal(await page.evaluate(() => window.previewWorkers.terminated), 2)
  await page.unroute('**/docxPreview.worker.js')
  await page.getByRole('button', { name: 'Retry formatted preview', exact: true }).click()
  await visible(frame(page).getByRole('heading', { name: 'Engineering specialist', exact: true }))
  assert.equal(await page.evaluate(() => window.previewWorkers.terminated), 3)
  assert.deepEqual(errors, [])
})

test('job picker accepts advertised uppercase Word files, keeps invalid neighbors, and preserves retry keys and PDF routes', { timeout: 60_000 }, async (t) => {
  const { page, fixture } = await open(t, { state: { mode: 'job-import' } })
  const dialog = await visible(page.getByRole('dialog', { name: 'Import real job descriptions', exact: true }))
  const input = dialog.getByLabel('Choose real job PDF or Word files', { exact: true })
  assert.match(await input.getAttribute('accept'), /\.docx.*\.doc,/)
  const docx = docxFile(), doc = legacyDocFile()
  await input.setInputFiles([
    { name: 'Role.DOCX', mimeType: '', buffer: docx }, { name: 'Legacy.DOC', mimeType: '', buffer: doc },
    { name: 'Role.PDF', mimeType: '', buffer: Buffer.from('%PDF-source') }, { name: 'Macro.docm', mimeType: '', buffer: docx },
  ])
  await visible(dialog.getByText(/Other formats cannot be processed/))
  let first = true
  fixture.controls.upload = (req, res) => {
    if (req.headers['content-type'] !== docType || !first) return false
    first = false
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'unavailable', message: 'Response not confirmed; retry unchanged source.' } }))
    return true
  }
  await dialog.getByRole('button', { name: 'Import 3 jobs', exact: true }).click()
  await visible(dialog.getByText('2 queued / 1 unacknowledged / 1 invalid', { exact: true }))
  assert.equal(uploads(fixture).length, 3)
  assert.ok(uploads(fixture).some((request) => request.url.endsWith('/jobs/pdf')))
  assert.equal(uploads(fixture).filter((request) => request.url.endsWith('/jobs/file')).length, 2)
  await dialog.getByRole('button', { name: 'Retry Legacy.DOC', exact: true }).click()
  await visible(dialog.getByText('3 queued / 0 unacknowledged / 1 invalid', { exact: true }))
  const attempts = uploads(fixture).filter((request) => request.headers['content-type'] === docType)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].headers['idempotency-key'], attempts[1].headers['idempotency-key'])
  assert.equal(attempts[0].headers['x-import-batch'], attempts[1].headers['x-import-batch'])
  assert.deepEqual(attempts[0].bytes, doc)
  assert.deepEqual(attempts[1].bytes, doc)
  assert.equal(await input.isDisabled(), true, 'Acknowledged records and retry identities cannot be replaced by a later drop.')
  assert.equal(fixture.requests.some((request) => request.url.includes('/analyses')), false)
})

test('resume drop handles mixed files/URLs with per-item errors and releases accepted files; old servers and samples stay PDF-only', { timeout: 60_000 }, async (t) => {
  const { page, fixture } = await open(t, { state: { mode: 'resume-import' } })
  const dialog = await visible(page.getByRole('dialog', { name: 'Add real resumes', exact: true }))
  await visible(dialog.getByRole('button', { name: 'Choose files', exact: true }))
  await page.waitForFunction(() => !document.querySelector('input[type=file]').disabled)
  const docx = docxFile(), doc = legacyDocFile()
  const data = await page.evaluateHandle(({ docx, doc }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(docx)], 'Résumé.DOCX'))
    transfer.items.add(new File([new Uint8Array(doc)], 'Legacy.DOC'))
    transfer.items.add(new File(['invalid'], 'blocked.rtf'))
    return transfer
  }, { docx: [...docx], doc: [...doc] })
  await dialog.locator('.drop-zone').dispatchEvent('drop', { dataTransfer: data })
  await data.dispose()
  await dialog.getByRole('button', { name: 'Public URLs', exact: true }).click()
  await dialog.getByRole('textbox', { name: /Public resume or profile URLs/ }).fill('https://example.test/profile\nhttps://example.test/profile.docx')
  await dialog.getByRole('button', { name: 'Add URLs to batch', exact: true }).click()
  await visible(dialog.getByText('Word URLs cannot be imported. Download the document and upload a supported file instead.', { exact: true }))
  await dialog.getByRole('button', { name: 'Import 3 valid inputs', exact: true }).click()
  await visible(dialog.getByText('3 accepted / 5 inputs', { exact: true }))
  assert.equal(uploads(fixture).length, 3)
  assert.ok(uploads(fixture).every((request) => request.headers['x-import-count'] === '5'))
  assert.deepEqual(uploads(fixture).find((request) => request.headers['content-type'] === docxType).bytes, docx)
  assert.deepEqual(await page.evaluate(() => window.wordTest.resumeItems().filter((item) => item.state === 'accepted' && item.kind !== 'url').map((item) => item.hasFile)), [false, false])
  const old = await open(t, { state: { mode: 'resume-import', wordEnabled: false } })
  await visible(old.page.getByRole('button', { name: 'Choose PDFs', exact: true }))
  const oldInput = old.page.getByLabel('Choose resume PDF files', { exact: true })
  assert.equal(await oldInput.getAttribute('accept'), '.pdf,application/pdf')
  await old.page.waitForFunction(() => !document.querySelector('input[type=file]').disabled)
  await oldInput.setInputFiles({ name: 'NotEnabled.DOCX', mimeType: '', buffer: docx })
  await visible(old.page.getByText(/DOCX uploads are not enabled/))
  assert.equal(uploads(old.fixture).length, 0)
  const sample = await open(t, { state: { mode: 'sample-import' } })
  const sampleInput = sample.page.getByLabel('Choose job PDF files', { exact: true })
  assert.equal(await sampleInput.getAttribute('accept'), '.pdf,application/pdf')
  await sampleInput.setInputFiles({ name: 'NotASample.DOCX', mimeType: '', buffer: docx })
  await visible(sample.page.getByText('Choose PDF files only. File contents will not be read.', { exact: true }))
  assert.equal(uploads(sample.fixture).length, 0)
})
