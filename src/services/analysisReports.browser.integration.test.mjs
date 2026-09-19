import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument, PDFName } from 'pdf-lib'
import yauzl from 'yauzl'
import { SaxesParser } from 'saxes'
import {
  allPages, buildResumeAnalysisTestRuntime, importResumePdf, jsonResponse,
  processAllAnalyses, processAllResumes, processingStubs, resumePdf, resumeSelection, startResumeAnalysisFixture,
} from './resumeAnalysis.test-support.mjs'
import { seededLadder, seedRealJob } from './gradeLadders.test-support.mjs'

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
function csvRows(bytes) {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
  const rows = []
  let row = [], value = '', quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++ }
      else quoted = !quoted
    } else if (!quoted && (character === ',' || character === '\r' || character === '\n')) {
      row.push(value); value = ''
      if (character !== ',') {
        rows.push(row); row = []
        if (character === '\r' && text[index + 1] === '\n') index++
      }
    } else value += character
  }
  if (value || row.length) { row.push(value); rows.push(row) }
  assert.equal(quoted, false)
  return rows
}
function csvRecords(bytes, criterionCount, sample = false) {
  const [header, ...rows] = csvRows(bytes)
  assert.deepEqual(header, [
    sample ? 'Candidate name (fictional sample)' : 'Candidate name', 'Job/grade', 'Overall score', 'Overall assessment',
    ...Array.from({ length: criterionCount }, (_, index) => `C${index + 1}`),
    'Analysis date', 'Source', 'Analysis link', 'Resume link', 'Job/grade link',
  ])
  return rows.map((row) => {
    assert.equal(row.length, header.length)
    return Object.fromEntries(header.map((name, index) => [name, row[index]]))
  })
}
function assertReviewDestination(value, { origin, workspaceId, runId, comparisonId, data, view = null }) {
  const url = new URL(value)
  assert.equal(url.origin, origin)
  assert.equal(url.pathname, `${workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}` : ''}/analyses/${encodeURIComponent(runId)}`)
  assert.equal(url.searchParams.get('data'), data)
  assert.equal(url.searchParams.get('result'), comparisonId)
  assert.equal(url.searchParams.get('view'), view)
  assert.equal(url.username, '')
  assert.equal(url.password, '')
  assert.equal(url.hash, '')
}
function reportDestinations(row) { return [row['Analysis link'], row['Resume link'], row['Job/grade link']] }
async function pdfHyperlinks(bytes) {
  const pdf = await PDFDocument.load(bytes)
  const links = []
  for (const page of pdf.getPages()) for (const reference of page.node.Annots()?.asArray() ?? []) {
    const annotation = pdf.context.lookup(reference)
    if (annotation.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue
    const action = pdf.context.lookup(annotation.get(PDFName.of('A')))
    const uri = action?.get(PDFName.of('URI'))
    if (uri) links.push(uri.decodeText())
  }
  return links
}
async function officeHyperlinks(bytes, pattern) {
  const links = []
  for (const xml of await xmlParts(bytes, pattern)) {
    const parser = new SaxesParser()
    parser.on('opentag', (node) => {
      if (node.name === 'Relationship' && node.attributes.Type?.endsWith('/hyperlink')) {
        assert.equal(node.attributes.TargetMode, 'External')
        links.push(node.attributes.Target)
      }
    })
    parser.write(xml).close()
  }
  return links
}
const pptxHyperlinks = bytes => officeHyperlinks(bytes, /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/)
async function followSampleSources(page, row, run) {
  const pair = run.comparisons.find((comparison) => comparison.id === new URL(row['Analysis link']).searchParams.get('result'))
  assert.ok(pair)
  const resume = run.resumes.find((snapshot) => snapshot.resume.id === pair.resumeId).document
  const target = run.targets.find((target) => target.id === pair.targetId)
  await page.goto(row['Analysis link'])
  await visible(page.getByRole('heading', { name: 'Why this score', exact: true }))
  const citation = page.getByRole('button', { name: /^View resume evidence for/ }).first()
  await citation.click()
  await visible(page.locator('.document-paragraph.is-highlighted mark').first())
  await page.goto(row['Resume link'])
  const source = page.getByRole('region', { name: 'Source evidence viewer', exact: true })
  await visible(source.locator('.document-viewer h2').getByText(resume.title, { exact: true }))
  assert.equal(await source.locator('.is-highlighted').count(), 0)
  await page.goto(row['Job/grade link'])
  if (target.document) {
    await visible(source.locator('.document-viewer h2').getByText(target.document.title, { exact: true }))
    assert.equal(await source.locator('.is-highlighted').count(), 0)
  } else {
    await visible(source.getByRole('heading', { name: 'Source unavailable', exact: true }))
    assert.equal(await source.locator('.document-viewer').count(), 0)
  }
  if (target.kind === 'grade') {
    const requirements = source.getByRole('region', { name: 'Saved sample grade requirements', exact: true })
    await visible(requirements)
    await visible(requirements.getByText(target.rubric.criteria[0].description, { exact: true }))
  }
  await page.getByRole('link', { name: 'All comparisons', exact: true }).click()
  assert.equal(new URL(page.url()).searchParams.get('result'), null)
  assert.equal(new URL(page.url()).searchParams.get('view'), null)
  await page.goBack()
  assert.equal(new URL(page.url()).searchParams.get('view'), 'target')
  await visible(source)
}
function reportProcessingStubs(fixture) {
  return processingStubs(fixture, {
    onModelRequest(request) {
      if (request.response_format.json_schema.name !== 'resume_rubric_assessment') return
      const { input } = JSON.parse(request.messages[1].content)
      const passages = input.resume.paragraphs.flatMap((paragraph) => paragraph.passages ?? [])
      if (!passages.length) return
      const work = passages.find((passage) => passage.text.includes('Applied engineering methods independently'))
      const education = passages.find((passage) => passage.text.includes('Bachelor of Engineering'))
      assert.ok(work?.passageId, 'The report fixture must select actual frozen engineering evidence.')
      const output = {
        criteria: input.rubric.criteria.map((criterion) => ({
          criterionId: criterion.id, evidenceStatus: criterion.support === 'not-applicable' ? 'not-applicable' : 'supported',
          score: criterion.support === 'not-applicable' ? null : 3,
          rationale: criterion.support === 'not-applicable' ? 'The exact approved rubric excludes this work row from scoring.'
            : 'The cited passage describes independent engineering work within defined projects, matching the saved independent-work anchor.',
          citations: criterion.support === 'not-applicable' ? [] : [{ passageId: work.passageId }], limitation: null,
        })),
        qualifications: input.qualifications.map((qualification) => ({
          qualificationId: qualification.id, evidenceStatus: education ? 'partial' : 'missing',
          rationale: education ? 'The document states an engineering degree. A reviewer must verify the saved requirement and its alternatives; this is not an eligibility decision.'
            : 'No supporting qualification passage was located in the supplied document; human review is required.',
          citations: education ? [{ passageId: education.passageId }] : [], limitation: null,
        })),
      }
      return Response.json({ model: 'gpt-5-mini-fixture', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })
    },
  })
}
async function completedFixture({ comparisons = 2, partial = false } = {}) {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  try {
    await seedRealJob(fixture)
    for (let index = 0; index < comparisons; index++) await importResumePdf(fixture, await resumePdf({ name: `resume-${index}.pdf` }))
    const stubs = reportProcessingStubs(fixture)
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
    await visible(dialog.getByText('Reporting on 2 of 2 candidates', { exact: true }))
    const modelsBefore = stubs.modelCalls.length
    const stateBefore = JSON.stringify([...fixture.analyses.store.values.values()])
    const requestsBefore = fixture.requests.length
    if (process.env.SCORE_REPORT_QA_DIR) {
      await mkdir(process.env.SCORE_REPORT_QA_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.SCORE_REPORT_QA_DIR, 'export-dialog.png'), animations: 'disabled' })
    }
    let rows
    for (const format of ['csv', 'pdf', 'docx', 'pptx']) {
      const { bytes, filename } = await download(page, format)
      assert.ok(filename.endsWith(`.${format}`))
      assert.ok(bytes.length > 100)
      if (format === 'csv') {
        assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191])
        rows = csvRecords(bytes, 1)
        assert.equal(rows.length, pairs.length)
        for (const { comparison } of pairs) {
          const row = rows.find((row) => new URL(row['Analysis link']).searchParams.get('result') === comparison.id)
          assert.ok(row)
          assert.equal(row['Candidate name'], 'Jordan Example')
          assert.equal(row['Overall score'], '60')
          assert.equal(row.C1, '3')
          assert.match(row['Overall assessment'], /independent engineering work within defined projects/i)
          assert.doesNotMatch(row['Overall assessment'], /A specific explanation was not recorded/)
          for (const [index, value] of reportDestinations(row).entries()) assertReviewDestination(value, {
            origin: fixture.origin, workspaceId: fixture.workspaceId, runId, comparisonId: comparison.id, data: 'real',
            view: [null, 'resume', 'target'][index],
          })
        }
      } else if (format === 'pdf') {
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
        assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 2)
        const destinations = await pdfHyperlinks(bytes)
        for (const link of rows.flatMap(reportDestinations)) assert.ok(destinations.includes(link), `PDF link: ${link}`)
      } else {
        const parts = await xmlParts(bytes, format === 'docx' ? /^word\/document\.xml$/ : /^ppt\/slides\/slide\d+\.xml$/)
        assert.ok(parts.length > 0)
        const content = parts.join('\n')
        assert.match(content, /Jordan Example/)
        assert.match(content, /Engineering methods/)
        for (const { comparison } of pairs) assert.equal(content.includes(comparison.id), false)
        const destinations = format === 'pptx' ? await pptxHyperlinks(bytes)
          : await officeHyperlinks(bytes, /^word\/_rels\/document\.xml\.rels$/)
        for (const link of rows.flatMap(reportDestinations)) assert.ok(destinations.includes(link), `${format} link: ${link}`)
        assert.doesNotMatch(content, /Partial report|cutoff ties|Comparison ID|Run ID/)
        if (format === 'docx') {
          assert.match(content, /Saved analysis overview/)
          assert.match(content, /Contents/)
          assert.ok(content.indexOf('Why this score') < content.indexOf('Candidates at a glance'))
        }
        assert.match(content, /[Hh]uman|hiring recommendation/)
      }
      await saveArtifact(`browser-real.${format}`, bytes)
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const row = rows[0]
    const saved = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}/comparisons/${new URL(row['Analysis link']).searchParams.get('result')}`))
    await page.goto(row['Analysis link'])
    await visible(page.getByRole('heading', { name: 'Evidence-based assessment', exact: true }))
    await page.getByRole('button', { name: /^View resume evidence for/ }).first().click()
    await visible(page.locator('.document-paragraph.is-highlighted mark').first())
    await page.goto(row['Resume link'])
    const source = page.getByRole('region', { name: 'Saved real source evidence', exact: true })
    await visible(source.getByRole('heading', { name: 'Full saved resume', exact: true }))
    await visible(source.getByRole('heading', { name: saved.resumeSnapshot.document.title, exact: true }))
    assert.equal(await source.locator('.is-highlighted').count(), 0)
    await page.goto(row['Job/grade link'])
    await visible(source.getByRole('heading', { name: 'Full saved job description', exact: true }))
    await visible(source.getByRole('heading', { name: saved.targetSnapshot.document.title, exact: true }))
    assert.equal(await source.locator('.is-highlighted').count(), 0)
    await page.getByRole('link', { name: 'All saved comparisons', exact: true }).click()
    assert.equal(new URL(page.url()).searchParams.get('result'), null)
    assert.equal(new URL(page.url()).searchParams.get('view'), null)
    await page.goBack()
    await visible(source.getByRole('heading', { name: 'Full saved job description', exact: true }))
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
    const allRows = csvRecords(entire.bytes, Math.max(...run.targets.map((target) => target.rubric.criteria.length)), true)
    assert.equal(allRows.length, run.comparisons.filter((pair) => pair.status === 'complete').length)
    assert.deepEqual(new Set(allRows.map((row) => new URL(row['Analysis link']).searchParams.get('result'))),
      new Set(run.comparisons.filter((pair) => pair.status === 'complete').map((pair) => pair.id)))
    for (const row of allRows) for (const [index, value] of reportDestinations(row).entries()) assertReviewDestination(value, {
      origin: fixture.origin, workspaceId: fixture.workspaceId, runId: run.id,
      comparisonId: new URL(row['Analysis link']).searchParams.get('result'), data: 'samples', view: [null, 'resume', 'target'][index],
    })
    await dialog.getByLabel('Report scope', { exact: true }).selectOption(run.targets[1].id)
    const selected = await download(page, 'csv')
    const selectedRows = csvRecords(selected.bytes, run.targets[1].rubric.criteria.length, true)
    assert.deepEqual(new Set(selectedRows.map((row) => new URL(row['Analysis link']).searchParams.get('result'))),
      new Set(run.comparisons.filter((pair) => pair.targetId === run.targets[1].id && pair.status === 'complete').map((pair) => pair.id)))
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${run.id}?data=samples`)
    await page.getByRole('searchbox', { name: 'Search comparisons', exact: true }).fill('No candidate matches this filter')
    await visible(page.getByRole('heading', { name: 'No matching comparisons', exact: true }))
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const filteredTableExport = await download(page, 'csv')
    const filteredRows = csvRecords(filteredTableExport.bytes, Math.max(...run.targets.map((target) => target.rubric.criteria.length)), true)
    assert.deepEqual(new Set(filteredRows.map((row) => row['Analysis link'])), new Set(allRows.map((row) => row['Analysis link'])))
    await page.getByRole('dialog', { name: 'Export analysis report', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    for (const kind of ['job', 'grade']) {
      const target = run.targets.find((target) => target.kind === kind)
      const pair = run.comparisons.find((pair) => pair.targetId === target.id && pair.status === 'complete')
      await followSampleSources(page, allRows.find((row) => new URL(row['Analysis link']).searchParams.get('result') === pair.id), run)
    }
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
    const rows = csvRecords(output.bytes, Math.max(...run.targets.map((target) => target.rubric.criteria.length)), true)
    assert.equal(rows.length, run.comparisons.length)
    await page.getByRole('dialog', { name: 'Export analysis report', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    await followSampleSources(page, rows[0], run)
    await visible(page.getByText('Archived · read only', { exact: true }))
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

test('an active run reports completion counts, excludes unfinished CSV rows, and blocks Word exactly like PDF', { timeout: 90_000 }, async () => {
  const { fixture, runId, pairs } = await completedFixture({ partial: true })
  const { context, page, errors } = await newPage()
  try {
    assert.equal(pairs.filter(({ comparison }) => comparison.status === 'complete').length, 1)
    assert.equal(pairs.filter(({ comparison }) => comparison.status === 'queued').length, 1)
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?data=real`)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export analysis report', exact: true })
    await visible(dialog.getByText('Reporting on 1 of 2 candidates', { exact: true }))
    await visible(dialog.getByText('1 still processing; 0 could not be assessed; 0 cancelled. Later completions are not added to this download.', { exact: true }))
    assert.equal(await dialog.getByText('Partial report', { exact: true }).count(), 0)
    const output = await download(page, 'csv')
    assert.doesNotMatch(output.filename, / - partial\.csv$/)
    const rows = csvRecords(output.bytes, 1)
    assert.equal(rows.length, 1)
    assert.equal(new URL(rows[0]['Analysis link']).searchParams.get('result'), pairs.find(({ comparison }) => comparison.status === 'complete').comparison.id)
    assert.doesNotMatch(output.bytes.toString('utf8'), /"Queued"|"Partial report"/)
    for (const format of ['docx', 'pdf']) {
      await dialog.getByLabel('Report format', { exact: true }).selectOption(format)
      await visible(dialog.getByText(/Missing, outdated, failed, waiting, or generating summaries block/))
      await visible(dialog.getByText('Reporting on 1 of 2 candidates', { exact: true }))
      assert.equal(await dialog.getByRole('button', { name: /^Download / }).isDisabled(), true)
      assert.equal(await dialog.getByText('Partial report', { exact: true }).count(), 0)
    }
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('concise exports explain actual failure counts and include completed assessments with withheld scores', { timeout: 60_000 }, async () => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  const sample = runtime.fixtures.createInitialWorkspace(), run = sample.runs[1]
  const [withheld, failed, cancelled] = run.comparisons
  withheld.score = null
  withheld.summary = 'Some weighted criteria could not be assessed from the saved resume, so no overall score is available.'
  withheld.criteria = withheld.criteria.map((criterion) => ({
    ...criterion, score: null, evidenceStatus: 'not-assessed', rationale: 'The saved source does not provide assessable evidence for this criterion.', citations: [],
  }))
  Object.assign(failed, { status: 'failed', score: null, criteria: [], summary: 'This comparison could not be assessed.', error: 'Saved source unavailable.' })
  Object.assign(cancelled, { status: 'cancelled', score: null, criteria: [], summary: 'This comparison was cancelled.', error: 'Cancelled before assessment.' })
  fixture.state.states.set(fixture.workspaceId, { content: JSON.stringify(sample), etag: '"report-status-counts"' })
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${run.id}?data=samples`)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export analysis report', exact: true })
    await visible(dialog.getByText('Reporting on 1 of 3 candidates', { exact: true }))
    await visible(dialog.getByText('0 still processing; 1 could not be assessed; 1 cancelled. Later completions are not added to this download.', { exact: true }))
    assert.equal(await dialog.getByText('Partial report', { exact: true }).count(), 0)
    const output = await download(page, 'csv')
    assert.doesNotMatch(output.filename, / - partial\.csv$/)
    const rows = csvRecords(output.bytes, run.targets[0].rubric.criteria.length, true)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]['Overall score'], '')
    assert.match(rows[0]['Overall assessment'], /no overall score|overall score.*unavailable|not.*assess/i)
    for (let index = 1; index <= run.targets[0].rubric.criteria.length; index++) assert.equal(rows[0][`C${index}`], 'Not assessed')
    assert.equal(new URL(rows[0]['Analysis link']).searchParams.get('result'), withheld.id)
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

test('standalone sample exports link to frozen reviews and sources without a workspace prefix', { timeout: 180_000 }, async () => {
  const directory = resolve(`.report-standalone-browser-${randomUUID()}`)
  const { build, preview } = await import('vite')
  const { context, page, errors } = await newPage()
  let server
  try {
    await build({
      configFile: resolve('vite.config.ts'), define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"standalone"' },
      build: { outDir: directory, emptyOutDir: false }, logLevel: 'error',
    })
    server = await preview({
      configFile: false, build: { outDir: directory }, preview: { host: '127.0.0.1', port: 0, open: false }, logLevel: 'error',
    })
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    const sample = runtime.fixtures.createInitialWorkspace(), run = sample.runs[0]
    await page.addInitScript((workspace) => {
      if (!localStorage.getItem('score-demo-workspace-v1')) localStorage.setItem('score-demo-workspace-v1', JSON.stringify(workspace))
    }, sample)
    await page.goto(`${origin}/analyses/${run.id}?data=samples`)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export analysis report', exact: true })
    await visible(dialog.getByText(`Reporting on ${run.comparisons.length} of ${run.comparisons.length} candidate-job reviews`, { exact: true }))
    const output = await download(page, 'csv')
    assert.match(output.filename, /^Sample - /)
    const rows = csvRecords(output.bytes, Math.max(...run.targets.map((target) => target.rubric.criteria.length)), true)
    assert.equal(rows.length, run.comparisons.length)
    for (const row of rows) for (const [index, value] of reportDestinations(row).entries()) assertReviewDestination(value, {
      origin, runId: run.id, comparisonId: new URL(row['Analysis link']).searchParams.get('result'), data: 'samples',
      view: [null, 'resume', 'target'][index],
    })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    for (const kind of ['job', 'grade']) {
      const target = run.targets.find((target) => target.kind === kind)
      const pair = run.comparisons.find((pair) => pair.targetId === target.id)
      await followSampleSources(page, rows.find((row) => new URL(row['Analysis link']).searchParams.get('result') === pair.id), run)
    }
    const invalid = new URL(rows[0]['Analysis link'])
    invalid.searchParams.set('view', 'live-library')
    await page.goto(invalid.href)
    const pair = run.comparisons.find((pair) => pair.id === invalid.searchParams.get('result'))
    const resume = run.resumes.find((snapshot) => snapshot.resume.id === pair.resumeId)
    await visible(page.getByRole('region', { name: 'Source evidence viewer', exact: true }).getByRole('heading', { name: resume.document.title, exact: true }))
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    if (server) {
      server.httpServer.closeAllConnections()
      await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

test('grade export links open exact approved requirements and full frozen reference documents without invented citations', { timeout: 120_000 }, async () => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  const { context, page, errors } = await newPage()
  try {
    const seeded = await seededLadder(fixture)
    const supported = seeded.detail.levels.find((level) => level.head.grade === 9)
    const restore = fixture.installClientFetch()
    try {
      const approved = await runtime.client.approveGrade(fixture.workspaceId, seeded.detail.ladder.id, 9, {
        versionId: supported.version.id, reviewId: supported.review.id,
      }, supported.etag)
      const current = approved.levels.find((level) => level.head.grade === 9)
      await runtime.client.saveGradeDraft(fixture.workspaceId, seeded.detail.ladder.id, 9, {
        rubric: { ...current.version.rubric, name: 'Unapproved live replacement grade' }, qualifications: current.version.qualifications,
      }, current.etag)
    } finally { restore() }
    await importResumePdf(fixture, await resumePdf())
    const stubs = reportProcessingStubs(fixture)
    await processAllResumes(fixture, stubs)
    const resumes = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/resumes`, 'resumes')
    const targets = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets')
    const target = targets.find((target) => target.kind === 'grade' && target.selection.grade === 9)
    assert.ok(target)
    const created = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ name: 'Approved grade report', resumes: resumes.map(resumeSelection), targets: [target.selection] }),
    }), [202])
    await processAllAnalyses(fixture, stubs)
    const runId = created.run.run.id
    const pairs = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/${runId}/comparisons`, 'comparisons')
    assert.ok(pairs.every(({ comparison }) => comparison.status === 'complete'),
      JSON.stringify(pairs.map(({ comparison }) => ({ status: comparison.status, error: comparison.error }))))
    const comparisonId = pairs[0].comparison.id
    const saved = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}/comparisons/${comparisonId}`))
    const reference = saved.targetSnapshot.references.find((reference) => reference.source.sourceId === seeded.source.id)
    assert.ok(reference)
    fixture.grades.blobs.values.delete(reference.source.documentBlobName)
    const modelCalls = stubs.modelCalls.length
    const before = JSON.stringify([...fixture.analyses.store.values.values()])
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?data=real`)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const output = await download(page, 'csv')
    const [row] = csvRecords(output.bytes, saved.targetSnapshot.version.rubric.criteria.length)
    await page.goto(row['Job/grade link'])
    const source = page.getByRole('region', { name: 'Saved real source evidence', exact: true })
    const requirements = source.getByRole('region', { name: 'Saved approved grade requirements', exact: true })
    await visible(requirements.getByText(saved.targetSnapshot.version.rubric.criteria[0].description, { exact: true }))
    await visible(requirements.getByText(saved.targetSnapshot.version.qualifications[0].text, { exact: true }))
    assert.equal(await source.getByText('Unapproved live replacement grade', { exact: true }).count(), 0)
    await visible(requirements.getByText(/seed job is supporting context, not the whole grade standard/))
    assert.equal(await source.locator('.document-viewer').count(), 0)
    const key = JSON.stringify([reference.document.documentId, reference.document.documentVersion])
    await source.getByLabel('Frozen grade source document', { exact: true }).selectOption(key)
    await visible(source.getByRole('heading', { name: seeded.document.title, exact: true }))
    await visible(source.locator('.document-viewer').getByText(seeded.document.paragraphs[0].text, { exact: true }))
    assert.equal(await source.locator('.is-highlighted, mark').count(), 0)
    assert.ok(fixture.requests.some((request) => request.method === 'GET' && request.url.includes(`/comparisons/${comparisonId}/documents/${reference.document.documentId}?version=${reference.document.documentVersion}`)))
    await page.getByRole('button', { name: /^View requirement evidence for Engineering methods,/ }).first().click()
    await visible(source.locator('.document-paragraph.is-highlighted mark').first())
    await page.route('**/comparisons/*/documents/*?version=*', (route) => route.fulfill({
      status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'This frozen reference is no longer available.' } }),
    }))
    await page.goto(row['Job/grade link'])
    await source.getByLabel('Frozen grade source document', { exact: true }).selectOption(key)
    const unavailable = await visible(source.getByRole('alert'))
    assert.match(await unavailable.innerText(), /This frozen reference is no longer available\./)
    assert.equal(await source.locator('.document-viewer').count(), 0)
    assert.equal(stubs.modelCalls.length, modelCalls)
    assert.equal(JSON.stringify([...fixture.analyses.store.values.values()]), before)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('generated saved source links preserve workspace, access, missing-result, and deletion gates', { timeout: 90_000 }, async () => {
  const { fixture, runId, stubs } = await completedFixture({ comparisons: 1 })
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?data=real`)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const output = await download(page, 'csv')
    const [row] = csvRecords(output.bytes, 1)
    const models = stubs.modelCalls.length
    const foreign = new URL(row['Resume link'])
    foreign.pathname = foreign.pathname.replace(encodeURIComponent(fixture.workspaceId), encodeURIComponent(`other-${randomUUID()}`))
    await page.goto(foreign.href)
    await visible(page.getByRole('heading', { name: 'This workspace is unavailable', exact: true }))
    assert.equal(await page.locator('.document-viewer').count(), 0)
    const missing = new URL(row['Resume link'])
    missing.searchParams.set('result', `comparison-${randomUUID()}`)
    await page.goto(missing.href)
    await visible(page.getByRole('heading', { name: 'This comparison could not be opened', exact: true }))
    assert.equal(await page.locator('.document-viewer').count(), 0)
    await page.route(`**/api/workspaces/${fixture.workspaceId}/analyses**`, (route) => route.fulfill({
      status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden', message: 'Saved analysis access denied.' } }),
    }))
    await page.goto(row['Job/grade link'])
    await visible(page.getByRole('heading', { name: 'This real analysis could not be opened', exact: true }))
    await visible(page.getByText('Saved analysis access denied.', { exact: true }).first())
    assert.equal(await page.locator('.document-viewer').count(), 0)
    await page.unroute(`**/api/workspaces/${fixture.workspaceId}/analyses**`)
    const detail = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}`))
    const removed = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}/lifecycle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': detail.etag }, body: JSON.stringify({ action: 'delete' }),
    }))
    assert.equal(removed.deleted, true)
    await page.goto(row['Resume link'])
    await visible(page.getByRole('heading', { name: 'This real analysis could not be opened', exact: true }))
    assert.equal(await page.locator('.document-viewer').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Export report', exact: true }).count(), 0)
    assert.equal(stubs.modelCalls.length, models)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})
