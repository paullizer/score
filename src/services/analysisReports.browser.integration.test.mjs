import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument } from 'pdf-lib'
import yauzl from 'yauzl'
import {
  allPages, buildResumeAnalysisTestRuntime, importResumePdf, jsonResponse,
  processAllAnalyses, processAllResumes, processingStubs, resumePdf, resumeSelection, startResumeAnalysisFixture,
} from './resumeAnalysis.test-support.mjs'
import { seedRealJob } from './gradeLadders.test-support.mjs'

let runtime, browser
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function visible(locator) {
  await locator.waitFor({ state: 'visible', timeout: 20_000 })
  return locator
}
async function saveArtifact(name, bytes) {
  if (!process.env.SCORE_REPORT_QA_DIR) return
  await mkdir(process.env.SCORE_REPORT_QA_DIR, { recursive: true })
  await writeFile(join(process.env.SCORE_REPORT_QA_DIR, name), bytes)
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  return { context, page, errors }
}
async function download(page, format) {
  const dialog = page.getByRole('dialog', { name: 'Export analysis report', exact: true })
  await dialog.getByLabel('Report format', { exact: true }).selectOption(format)
  const pending = page.waitForEvent('download', { timeout: 90_000 })
  await dialog.getByRole('button', { name: /^Download / }).click()
  const result = await pending
  assert.equal(await result.failure(), null)
  const stream = await result.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  await visible(dialog.getByText(/^Download started:/))
  return { filename: result.suggestedFilename(), bytes: Buffer.concat(chunks) }
}
function xmlParts(bytes, pattern) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, archive) => {
      if (error) { reject(error); return }
      const documents = []
      archive.on('error', reject)
      archive.on('end', () => resolve(documents))
      archive.on('entry', (entry) => {
        if (!pattern.test(entry.fileName)) { archive.readEntry(); return }
        archive.openReadStream(entry, (error, stream) => {
          if (error) { reject(error); return }
          const chunks = []
          stream.on('data', (chunk) => chunks.push(chunk))
          stream.on('error', reject)
          stream.on('end', () => { documents.push(Buffer.concat(chunks).toString('utf8')); archive.readEntry() })
        })
      })
      archive.readEntry()
    })
  })
}
async function completedFixture({ comparisons = 2, partial = false } = {}) {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  try {
    await seedRealJob(fixture)
    for (let index = 0; index < comparisons; index++) await importResumePdf(fixture, await resumePdf({ name: `resume-${index}.pdf` }))
    const stubs = processingStubs(fixture)
    await processAllResumes(fixture, stubs)
    const resumes = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/resumes`, 'resumes')
    const targets = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets')
    const created = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ name: 'Grouped report review', resumes: resumes.map(resumeSelection), targets: [targets[0].selection] }),
    }), [202])
    if (partial) await fixture.runtime.api.analysisWorker.runAnalysisWorker(stubs.analyses, { maxItems: 1 })
    else await processAllAnalyses(fixture, stubs)
    const runId = created.run.run.id
    const pairs = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/${runId}/comparisons`, 'comparisons')
    assert.ok(pairs.some(({ comparison }) => comparison.status === 'complete'),
      JSON.stringify(pairs.map(({ comparison }) => ({ status: comparison.status, error: comparison.error }))))
    if (!partial) assert.ok(pairs.every(({ comparison }) => comparison.status === 'complete'))
    return { fixture, stubs, runId, pairs }
  } catch (error) { await fixture.close(); throw error }
}

before(async () => {
  runtime = await buildResumeAnalysisTestRuntime({ browser: true, productionBrowser: true })
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  }
})
after(async () => { await browser?.close(); await runtime?.close() })

test('renaming a real analysis changes new report filenames without rescoring or replacing captured comparisons', { timeout: 90_000 }, async () => {
  const { fixture, stubs, runId, pairs } = await completedFixture()
  const { context, page, errors } = await newPage()
  try {
    const path = `/api/workspaces/${fixture.workspaceId}/analyses/${runId}`
    const before = await jsonResponse(await fixture.request(path))
    const modelsBefore = stubs.modelCalls.length
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?data=real`)
    await page.getByRole('button', { name: 'Rename analysis: Grouped report review', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Edit analysis name', exact: true })
    await editor.getByRole('textbox', { name: 'Analysis name', exact: true }).fill('Reviewer shortlist')
    await editor.getByRole('button', { name: 'Save name', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await visible(page.getByRole('heading', { name: 'Reviewer shortlist', exact: true }))
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const csv = await download(page, 'csv')
    assert.equal(csv.filename, 'Reviewer shortlist.csv')
    assert.match(csv.bytes.toString('utf8'), /"Reviewer shortlist"/)
    const saved = await jsonResponse(await fixture.request(path))
    assert.equal(saved.run.displayName, 'Reviewer shortlist')
    assert.equal(saved.run.name, before.run.name)
    assert.deepEqual(saved.run.manifest, before.run.manifest)
    assert.deepEqual(await allPages(fixture, `${path}/comparisons`, 'comparisons'), pairs)
    assert.equal(stubs.modelCalls.length, modelsBefore)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await fixture.close()
  }
})

test('a read-only reviewer downloads genuine CSV, PDF, Word and PowerPoint files from archived frozen results without new AI calls', { timeout: 180_000 }, async () => {
  const { fixture, stubs, runId, pairs } = await completedFixture()
  const { context, page, errors } = await newPage()
  try {
    const detail = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}`))
    const archived = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}/lifecycle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': detail.etag },
      body: JSON.stringify({ action: 'archive' }),
    }))
    assert.ok(archived.analysis.lifecycle.archivedAt)
    fixture.setRole('viewer')
    await page.route('**/api/features', async (route) => {
      const response = await route.fetch()
      const features = await response.json()
      await route.fulfill({ response, json: { ...features, realAnalyses: false, wordDocumentImports: false } })
    })
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?data=real&result=${pairs[0].comparison.id}`)
    await visible(page.getByRole('heading', { name: 'Grouped report review', exact: true }))
    const exportButton = page.getByRole('button', { name: 'Export report', exact: true })
    await exportButton.click()
    const dialog = await visible(page.getByRole('dialog', { name: 'Export analysis report', exact: true }))
    await visible(dialog.getByText('2 candidates / 2 comparisons', { exact: true }))
    const modelsBefore = stubs.modelCalls.length
    const stateBefore = JSON.stringify([...fixture.analyses.store.values.values()])
    const requestsBefore = fixture.requests.length
    if (process.env.SCORE_REPORT_QA_DIR) {
      await mkdir(process.env.SCORE_REPORT_QA_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.SCORE_REPORT_QA_DIR, 'export-dialog.png') })
    }
    for (const format of ['csv', 'pdf', 'docx', 'pptx']) {
      const { bytes, filename } = await download(page, format)
      assert.ok(filename.endsWith(`.${format}`))
      assert.ok(bytes.length > 100)
      if (format === 'csv') {
        assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191])
        assert.match(bytes.toString('utf8'), /"Candidate name","Job\/grade title"/)
        assert.match(bytes.toString('utf8'), /Jordan Example/)
        for (const { comparison } of pairs) assert.ok(bytes.toString('utf8').includes(comparison.id))
      } else if (format === 'pdf') {
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
        assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 3)
      } else {
        const parts = await xmlParts(bytes, format === 'docx' ? /^word\/document\.xml$/ : /^ppt\/slides\/slide\d+\.xml$/)
        assert.ok(parts.length > 0)
        const content = parts.join('\n')
        assert.match(content, /Jordan Example/)
        assert.match(content, /Engineering methods/)
        for (const { comparison } of pairs) assert.ok(content.includes(comparison.id))
        assert.match(content, /[Hh]uman|hiring recommendation/)
      }
      await saveArtifact(`browser-real.${format}`, bytes)
    }
    assert.equal(stubs.modelCalls.length, modelsBefore)
    assert.equal(JSON.stringify([...fixture.analyses.store.values.values()]), stateBefore)
    assert.ok(fixture.requests.slice(requestsBefore).every((request) => request.method === 'GET'), 'Export is read-only.')
    assert.ok(fixture.requests.some((request) => request.url.includes('/report-comparisons?')))
    assert.equal(await page.evaluate(() => Object.values(localStorage).some((value) => /Jordan Example|assessmentSha256/.test(value))), false)
    assert.equal(fixture.state.saves.length, 0)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('sample exports stay fictional, include the entire grouped analysis from an individual review, and support exact target scope', { timeout: 90_000 }, async () => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  const sample = runtime.fixtures.createInitialWorkspace()
  fixture.state.states.set(fixture.workspaceId, { content: JSON.stringify(sample), etag: '"report-samples"' })
  const run = sample.runs[0]
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${run.id}?data=samples&result=${run.comparisons[0].id}`)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const dialog = await visible(page.getByRole('dialog', { name: 'Export analysis report', exact: true }))
    await visible(dialog.getByText('Fictional sample', { exact: true }))
    const entire = await download(page, 'csv')
    assert.match(entire.filename, /^Sample - /)
    for (const pair of run.comparisons) assert.ok(entire.bytes.toString('utf8').includes(pair.id))
    await dialog.getByLabel('Report scope', { exact: true }).selectOption(run.targets[1].id)
    const selected = await download(page, 'csv')
    for (const pair of run.comparisons) {
      assert.equal(selected.bytes.toString('utf8').includes(pair.id), pair.targetId === run.targets[1].id)
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${run.id}?data=samples`)
    await page.getByRole('searchbox', { name: 'Search comparisons', exact: true }).fill('No candidate matches this filter')
    await visible(page.getByRole('heading', { name: 'No matching comparisons', exact: true }))
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const filteredTableExport = await download(page, 'csv')
    for (const pair of run.comparisons) assert.ok(filteredTableExport.bytes.toString('utf8').includes(pair.id))
    assert.ok(!fixture.requests.some((request) => request.url.includes('/report-comparisons')))
    await saveArtifact('browser-sample.csv', entire.bytes)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('archived sample analyses retain read-only exports alongside lifecycle controls', { timeout: 90_000 }, async () => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  const sample = runtime.fixtures.createInitialWorkspace()
  fixture.state.states.set(fixture.workspaceId, { content: JSON.stringify(sample), etag: '"report-archive"' })
  const run = sample.runs[0]
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${run.id}?data=samples`)
    await page.getByRole('button', { name: `Archive ${run.name}`, exact: true }).click()
    const archive = await visible(page.getByRole('dialog', { name: `Archive ${run.name}?`, exact: true }))
    await archive.getByRole('button', { name: 'Archive', exact: true }).click()
    await archive.waitFor({ state: 'hidden' })
    await visible(page.getByText('Archived · read only', { exact: true }))
    assert.equal(await page.getByRole('button', { name: 'New run with these inputs', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const output = await download(page, 'csv')
    for (const pair of run.comparisons) assert.ok(output.bytes.toString('utf8').includes(pair.id))
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('unfinished analyses explain why export is disabled until a comparison completes', { timeout: 60_000 }, async () => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  const sample = runtime.fixtures.createInitialWorkspace()
  const run = sample.runs[0]
  run.comparisons = run.comparisons.map((comparison) => ({
    ...comparison, status: 'cancelled', score: null, criteria: [],
    summary: 'This comparison was cancelled before assessment.', error: 'Cancelled before a score was produced.',
  }))
  fixture.state.states.set(fixture.workspaceId, { content: JSON.stringify(sample), etag: '"report-unfinished"' })
  const { context, page } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${run.id}?data=samples`)
    const button = await visible(page.getByRole('button', { name: 'Export report', exact: true }))
    assert.equal(await button.isDisabled(), true)
    assert.match(await button.getAttribute('title'), /At least one completed comparison/)
  } finally { await context.close(); await fixture.close() }
})

test('an active run exports a clearly labeled partial report and keeps queued pairs unscored', { timeout: 90_000 }, async () => {
  const { fixture, runId, pairs } = await completedFixture({ partial: true })
  const { context, page, errors } = await newPage()
  try {
    assert.equal(pairs.filter(({ comparison }) => comparison.status === 'complete').length, 1)
    assert.equal(pairs.filter(({ comparison }) => comparison.status === 'queued').length, 1)
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?data=real`)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export analysis report', exact: true })
    await visible(dialog.getByText('Partial report', { exact: true }))
    await visible(dialog.getByText('2 candidates / 2 comparisons', { exact: true }))
    const output = await download(page, 'csv')
    assert.match(output.filename, / - partial\.csv$/)
    const text = output.bytes.toString('utf8')
    assert.match(text, /"Queued"/)
    assert.match(text, /"Not assessed"/)
    for (const { comparison } of pairs) assert.ok(text.includes(comparison.id))
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('export permission failures are visible and cancelling a delayed evidence request cannot trigger a late download', { timeout: 90_000 }, async () => {
  const { fixture, runId } = await completedFixture({ comparisons: 1 })
  const { context, page, errors } = await newPage()
  const captured = deferred(), release = deferred(), finished = deferred()
  const downloads = []
  page.on('download', (value) => downloads.push(value))
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?data=real`)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export analysis report', exact: true })
    await dialog.getByLabel('Report format', { exact: true }).selectOption('csv')
    await page.route('**/report-comparisons?*', (route) => route.fulfill({
      status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden', message: 'Report access denied for this workspace.' } }),
    }))
    await dialog.getByRole('button', { name: 'Download CSV', exact: true }).click()
    await visible(dialog.getByRole('alert').getByText('Report access denied for this workspace.', { exact: true }))
    assert.equal(downloads.length, 0)
    await page.unroute('**/report-comparisons?*')
    await page.route('**/report-comparisons?*', async (route) => {
      const response = await route.fetch()
      captured.resolve()
      await release.promise
      try { await route.fulfill({ response }) } finally { finished.resolve() }
    })
    await dialog.getByRole('button', { name: 'Download CSV', exact: true }).click()
    await captured.promise
    await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    release.resolve()
    await finished.promise
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    await visible(page.getByRole('button', { name: 'Download CSV', exact: true }))
    assert.equal(downloads.length, 0)
    assert.deepEqual(errors, [])
  } finally { release.resolve(); await context.close(); await fixture.close() }
})

test('losing access to saved history cancels a pending export without a late private download', { timeout: 90_000 }, async () => {
  const { fixture, runId } = await completedFixture({ partial: true })
  const { context, page, errors } = await newPage()
  const captured = deferred(), release = deferred(), finished = deferred()
  const downloads = []
  page.on('download', (value) => downloads.push(value))
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?data=real`)
    await page.route('**/report-comparisons?*', async (route) => {
      const response = await route.fetch()
      captured.resolve()
      await release.promise
      try { await route.fulfill({ response }) } finally { finished.resolve() }
    })
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export analysis report', exact: true })
    await dialog.getByLabel('Report format', { exact: true }).selectOption('csv')
    await dialog.getByRole('button', { name: 'Download CSV', exact: true }).click()
    await captured.promise
    await page.route(`**/api/workspaces/${fixture.workspaceId}/analyses**`, (route) => route.fulfill({
      status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden', message: 'Workspace access is no longer available.' } }),
    }))
    await visible(page.getByRole('heading', { name: 'This real analysis could not be opened', exact: true }))
    await dialog.waitFor({ state: 'hidden' })
    release.resolve()
    await finished.promise
    assert.equal(await page.getByRole('button', { name: 'Export report', exact: true }).count(), 0)
    assert.equal(downloads.length, 0)
    assert.deepEqual(errors, [])
  } finally { release.resolve(); await context.close(); await fixture.close() }
})

test('analysis deletion removes the export controls and cancels a delayed report download', { timeout: 90_000 }, async () => {
  const { fixture, runId } = await completedFixture({ partial: true })
  const { context, page, errors } = await newPage()
  const captured = deferred(), release = deferred(), finished = deferred()
  const downloads = []
  page.on('download', (value) => downloads.push(value))
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?data=real`)
    await page.route('**/report-comparisons?*', async (route) => {
      const response = await route.fetch()
      captured.resolve()
      await release.promise
      try { await route.fulfill({ response }) } finally { finished.resolve() }
    })
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export analysis report', exact: true })
    await dialog.getByLabel('Report format', { exact: true }).selectOption('csv')
    await dialog.getByRole('button', { name: 'Download CSV', exact: true }).click()
    await captured.promise
    const detail = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}`))
    const removed = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}/lifecycle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': detail.etag },
      body: JSON.stringify({ action: 'delete' }),
    }))
    assert.equal(removed.deleted, true)
    await dialog.waitFor({ state: 'hidden' })
    release.resolve()
    await finished.promise
    assert.equal(await page.getByRole('button', { name: 'Export report', exact: true }).count(), 0)
    assert.equal(downloads.length, 0)
    assert.deepEqual(errors, [])
  } finally { release.resolve(); await context.close(); await fixture.close() }
})
