import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  const [result] = await Promise.all([
    Promise.race([
      page.waitForEvent('download', { timeout: 90_000 }),
      dialog.getByRole('alert').first().waitFor({ state: 'visible', timeout: 90_000 }).then(async () => {
        throw new Error(`${format} export failed: ${await dialog.getByRole('alert').first().innerText()}`)
      }),
    ]),
    dialog.getByRole('button', { name: /^Download / }).click(),
  ]).catch(async (cause) => {
    const state = await dialog.innerText().catch(() => 'The report dialog is no longer available.')
    throw new Error(`${format.toUpperCase()} download failed:\n${state}`, { cause })
  })
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
function csvRecords(bytes, criterionCount) {
  const [header, ...rows] = csvRows(bytes)
  assert.deepEqual(header, [
    'Candidate name', 'Job/grade', 'Overall score', 'Overall assessment',
    ...Array.from({ length: criterionCount }, (_, index) => `C${index + 1}`),
    'Analysis date', 'Source', 'Analysis link', 'Resume link', 'Job/grade link',
  ])
  return rows.map((row) => {
    assert.equal(row.length, header.length)
    return Object.fromEntries(header.map((name, index) => [name, row[index]]))
  })
}
function assertReviewDestination(value, { origin, workspaceId, runId, comparisonId, view = null }) {
  const url = new URL(value)
  assert.equal(url.origin, origin)
  assert.equal(url.pathname, `${workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}` : ''}/analyses/${encodeURIComponent(runId)}`)
  assert.equal(url.searchParams.get('data'), null)
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
function reportProcessingStubs(fixture, { unassessedAssessments = 0 } = {}) {
  let assessments = 0
  return processingStubs(fixture, {
    onModelRequest(request) {
      if (request.response_format.json_schema.name !== 'resume_rubric_assessment') return
      const { input } = JSON.parse(request.messages[1].content)
      const passages = input.resume.paragraphs.flatMap((paragraph) => paragraph.passages ?? [])
      if (!passages.length) return
      const work = passages.find((passage) => passage.text.includes('Applied engineering methods independently'))
      const education = passages.find((passage) => passage.text.includes('Bachelor of Engineering'))
      assert.ok(work?.passageId, 'The report fixture must select actual frozen engineering evidence.')
      const withhold = assessments++ < unassessedAssessments
      const output = {
        criteria: input.rubric.criteria.map((criterion) => ({
          criterionId: criterion.id,
          evidenceStatus: criterion.support === 'not-applicable' ? 'not-applicable' : withhold ? 'not-assessed' : 'supported',
          score: criterion.support === 'not-applicable' || withhold ? null : 3,
          rationale: criterion.support === 'not-applicable' ? 'The exact approved rubric excludes this work row from scoring.'
            : withhold ? 'The saved source does not provide assessable evidence for this criterion.'
              : 'The cited passage describes independent engineering work within defined projects, matching the saved independent-work anchor.',
          citations: criterion.support === 'not-applicable' || withhold ? [] : [{ passageId: work.passageId }],
          limitation: withhold ? { code: 'unusable-source', message: 'The saved source text cannot support a reliable criterion assessment.' } : null,
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
async function completedFixture({ comparisons = 2, partial = false, unassessedAssessments = 0 } = {}) {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  try {
    await seedRealJob(fixture)
    for (let index = 0; index < comparisons; index++) await importResumePdf(fixture, await resumePdf({ name: `resume-${index}.pdf` }))
    const stubs = reportProcessingStubs(fixture, { unassessedAssessments })
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

function comparisonEntry(fixture, comparisonId) {
  const entry = [...fixture.analyses.store.values.entries()]
    .find(([, value]) => value.record.recordType === 'analysis-comparison' && value.record.id === comparisonId)
  assert.ok(entry, `Missing comparison fixture record: ${comparisonId}`)
  return entry[1]
}

function markComparisonTerminal(fixture, comparisonId, status, message) {
  const entry = comparisonEntry(fixture, comparisonId)
  entry.record.status = status
  entry.record.updatedAt = fixture.now().toISOString()
  delete entry.record.completedAt
  if (status === 'cancelled') entry.record.cancelledAt = fixture.now().toISOString()
  else delete entry.record.cancelledAt
  delete entry.record.result
  delete entry.record.resultSummary
  delete entry.record.lease
  delete entry.record.nextAttemptAt
  delete entry.record.failureDiagnostic
  delete entry.record.diagnosticCapture
  if (status === 'failed') entry.record.error = { code: 'storage-error', stage: 'assessment', message, retryable: false }
  else delete entry.record.error
  recomputeRunProgress(fixture, entry.record.runId)
}

function recomputeRunProgress(fixture, runId) {
  const run = fixture.analyses.store.values.get(`${fixture.workspaceId}/${runId}`)?.record
  assert.ok(run, `Missing run fixture record: ${runId}`)
  const comparisons = [...fixture.analyses.store.values.values()]
    .map(({ record }) => record)
    .filter((record) => record.recordType === 'analysis-comparison' && record.runId === runId)
  const count = status => comparisons.filter(record => record.status === status).length
  run.progress = {
    total: run.progress.total,
    initialized: comparisons.length,
    queued: count('queued'),
    running: count('running'),
    complete: count('complete'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    scored: comparisons.filter(record => record.resultSummary?.overall.status === 'available').length,
    unscored: comparisons.filter(record => record.status === 'complete' && record.resultSummary?.overall.status !== 'available').length,
  }
  run.updatedAt = fixture.now().toISOString()
  if (run.progress.initialized === run.progress.total && run.progress.queued + run.progress.running === 0) {
    if (run.progress.complete === 0) {
      run.status = 'cancelled'
      run.cancellation = {
        requestedAt: run.cancellation?.requestedAt ?? fixture.now().toISOString(),
        requestedBy: run.cancellation?.requestedBy ?? 'integration-test',
        nextComparisonIndex: run.progress.total,
        completedAt: fixture.now().toISOString(),
      }
    } else {
      run.status = run.progress.failed || run.progress.cancelled || run.progress.unscored ? 'partial' : 'complete'
      delete run.cancellation
    }
    run.completedAt ??= fixture.now().toISOString()
  }
}

async function deleteAnalysis(fixture, runId) {
  const path = `/api/workspaces/${fixture.workspaceId}/analyses/${runId}`
  for (let attempt = 0; attempt < 10; attempt++) {
    const detail = await jsonResponse(await fixture.request(path))
    const response = await fixture.request(`${path}/lifecycle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': detail.etag },
      body: JSON.stringify({ action: 'delete' }),
    })
    const result = await jsonResponse(response, [200, 202])
    if (response.status === 200) {
      assert.equal(result.deleted, true)
      return
    }
    assert.equal(result.operation?.action, 'delete')
    assert.equal(result.operation?.status, 'pending')
    assert.ok(result.analysis?.lifecycle?.deletingAt)
    assert.equal(result.etag, result.analysis.etag)
  }
  assert.fail('Bounded analysis cleanup did not complete after explicit retries.')
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
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}`)
    await page.getByRole('button', { name: 'Rename analysis: Grouped report review', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Edit analysis name', exact: true })
    await editor.getByRole('textbox', { name: 'Analysis name', exact: true }).fill('Reviewer shortlist')
    await editor.getByRole('button', { name: 'Save name', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await visible(page.getByRole('heading', { name: 'Reviewer shortlist', exact: true }))
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const csv = await download(page, 'csv')
    assert.equal(csv.filename, 'Reviewer shortlist.csv')
    const records = csvRecords(csv.bytes, 1)
    assert.equal(records.length, pairs.length)
    assert.deepEqual(records.map(record => new URL(record['Analysis link']).searchParams.get('result')).sort(),
      pairs.map(({ comparison }) => comparison.id).sort())
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
    const summaries = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}/summaries`))
    assert.equal(summaries.ready, true, JSON.stringify([...fixture.analyses.store.values.values()]
      .filter(({ record }) => record.recordType.includes('narrative'))
      .map(({ record }) => ({ recordType: record.recordType, status: record.status, error: record.error }))))
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
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}?result=${pairs[0].comparison.id}`)
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
            origin: fixture.origin, workspaceId: fixture.workspaceId, runId, comparisonId: comparison.id,
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
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('unfinished analyses explain why export is disabled until a comparison completes', { timeout: 60_000 }, async () => {
  const { fixture, runId, pairs } = await completedFixture({ partial: true })
  const { context, page, errors } = await newPage()
  try {
    for (const { comparison } of pairs) markComparisonTerminal(fixture, comparison.id, 'cancelled', 'Cancelled before a score was produced.')
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}`)
    const button = await visible(page.getByRole('button', { name: 'Export report', exact: true }))
    assert.equal(await button.isDisabled(), true)
    assert.match(await button.getAttribute('title'), /At least one completed comparison/)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('an active run reports completion counts, excludes unfinished CSV rows, and blocks Word exactly like PDF', { timeout: 90_000 }, async () => {
  const { fixture, runId, pairs } = await completedFixture({ partial: true })
  const { context, page, errors } = await newPage()
  try {
    assert.equal(pairs.filter(({ comparison }) => comparison.status === 'complete').length, 1)
    assert.equal(pairs.filter(({ comparison }) => comparison.status === 'queued').length, 1)
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}`)
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

test('concise exports explain actual failure counts and include completed assessments', { timeout: 60_000 }, async () => {
  const { fixture, runId, pairs } = await completedFixture({ comparisons: 3 })
  const [completed, failed, cancelled] = pairs.map(({ comparison }) => comparison)
  const { context, page, errors } = await newPage()
  try {
    markComparisonTerminal(fixture, failed.id, 'failed', 'Saved source unavailable.')
    markComparisonTerminal(fixture, cancelled.id, 'cancelled', 'Cancelled before assessment.')
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}`)
    await page.getByRole('button', { name: 'Export report', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export analysis report', exact: true })
    await visible(dialog.getByText('Reporting on 1 of 3 candidates', { exact: true }))
    await visible(dialog.getByText('0 still processing; 1 could not be assessed; 1 cancelled. Later completions are not added to this download.', { exact: true }))
    assert.equal(await dialog.getByText('Partial report', { exact: true }).count(), 0)
    const output = await download(page, 'csv')
    assert.doesNotMatch(output.filename, / - partial\.csv$/)
    const rows = csvRecords(output.bytes, 1)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.ok(row, JSON.stringify(rows))
    assert.equal(row['Overall score'], '60')
    assert.match(row['Overall assessment'], /independent engineering work within defined projects/i)
    assert.equal(row.C1, '3')
    assert.equal(new URL(row['Analysis link']).searchParams.get('result'), completed.id)
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
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}`)
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
    await dialog.getByLabel('Report format', { exact: true }).selectOption('csv')
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
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}`)
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
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}`)
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
    await deleteAnalysis(fixture, runId)
    await dialog.waitFor({ state: 'hidden' })
    release.resolve()
    await finished.promise
    assert.equal(await page.getByRole('button', { name: 'Export report', exact: true }).count(), 0)
    assert.equal(downloads.length, 0)
    assert.deepEqual(errors, [])
  } finally { release.resolve(); await context.close(); await fixture.close() }
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
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}`)
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
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${runId}`)
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
    const runPath = `/api/workspaces/${fixture.workspaceId}/analyses/${runId}`
    const detail = await jsonResponse(await fixture.request(runPath))
    const deleteRun = async (etag) => jsonResponse(await fixture.request(`${runPath}/lifecycle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify({ action: 'delete' }),
    }), [200, 202])
    let removed = await deleteRun(detail.etag)
    if (removed.deleted !== true) {
      const operationId = removed.operation.id
      assert.equal(removed.operation.action, 'delete')
      assert.equal(removed.operation.status, 'pending')
      assert.ok(removed.analysis.lifecycle.deletingAt)
      assert.deepEqual([removed.analysis.resumes, removed.analysis.targets], [[], []])
      await page.goto(row['Resume link'])
      await visible(page.getByRole('heading', { name: 'Analysis cleanup or removal', exact: true }))
      assert.equal(await page.locator('.document-viewer').count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Export report', exact: true }).count(), 0)
      for (let pass = 0; pass < 40 && removed.deleted !== true; pass++) {
        assert.equal(removed.operation.id, operationId)
        assert.equal(removed.operation.action, 'delete')
        assert.equal(removed.operation.status, 'pending')
        removed = await deleteRun(removed.etag)
      }
    }
    assert.equal(removed.deleted, true)
    await page.goto(row['Resume link'])
    await visible(page.getByRole('heading', { name: 'This real analysis could not be opened', exact: true }))
    assert.equal(await page.locator('.document-viewer').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Export report', exact: true }).count(), 0)
    assert.equal(stubs.modelCalls.length, models)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})
