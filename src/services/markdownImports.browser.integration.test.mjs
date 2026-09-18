import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { processAllAnalyses, processAllResumes, resumeParagraphs, startResumeAnalysisFixture } from './resumeAnalysis.test-support.mjs'
import { buildMarkdownRuntime, markdownJob, markdownProcessingStubs, markdownResume, processMarkdownJobs } from './markdownImports.test-support.mjs'

let runtime, browser
before(async () => {
  runtime = await buildMarkdownRuntime({ browser: true })
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  }
})
after(async () => { await browser?.close(); await runtime?.close() })

test('browser imports Markdown through job drop and resume picker, then highlights frozen analysis evidence', { timeout: 120_000 }, async t => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const stubs = markdownProcessingStubs(fixture)
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/jobs?data=real`)
    await page.getByRole('button', { name: 'Add jobs', exact: true }).click()
    const jobsDialog = page.getByRole('dialog', { name: 'Import real job descriptions', exact: true })
    await jobsDialog.waitFor({ state: 'visible' })
    assert.match(await jobsDialog.locator('input[type=file]').getAttribute('accept'), /\.md(?:,|$)/)
    assert.match(await jobsDialog.locator('input[type=file]').getAttribute('accept'), /\.markdown(?:,|$)/)
    const transfer = await page.evaluateHandle(text => {
      const data = new DataTransfer()
      data.items.add(new File([text], 'engineering.markdown', { type: 'text/plain' }))
      return data
    }, markdownJob.toString('utf8'))
    try { await jobsDialog.locator('.drop-zone').dispatchEvent('drop', { dataTransfer: transfer }) }
    finally { await transfer.dispose() }
    await jobsDialog.getByRole('button', { name: 'Import 1 job', exact: true }).click()
    await jobsDialog.getByRole('button', { name: 'Done', exact: true }).click()
    await jobsDialog.waitFor({ state: 'hidden' })
    const importedJob = [...fixture.jobs.records.values()][0].record
    assert.equal(importedJob.source.kind, 'markdown')
    assert.deepEqual(Buffer.from((await fixture.jobs.blobs.read(importedJob.source.originalBlobName)).bytes), markdownJob)
    assert.equal(fixture.analyses.store.values.size, 0)
    await processMarkdownJobs(fixture, stubs)
    await page.reload()
    await page.getByRole('link', { name: 'Engineering specialist', exact: true }).click()
    await page.getByText('Markdown section 1 of 1', { exact: true }).waitFor({ state: 'visible' })

    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes?data=real`)
    await page.getByRole('button', { name: 'Add resumes', exact: true }).click()
    const resumesDialog = page.getByRole('dialog', { name: 'Add real resumes', exact: true })
    await resumesDialog.waitFor({ state: 'visible' })
    await resumesDialog.locator('input[type=file]').setInputFiles({
      name: 'resume.MD', mimeType: 'application/octet-stream', buffer: markdownResume,
    })
    await resumesDialog.getByRole('button', { name: 'Import 1 valid input', exact: true }).click()
    await resumesDialog.getByText(/Accepted by the server/).waitFor({ state: 'visible' })
    await resumesDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await resumesDialog.waitFor({ state: 'hidden' })
    const importedResume = [...fixture.resumes.store.values.values()].find(({ record }) => record.recordType === 'resume').record
    assert.equal(importedResume.source.kind, 'markdown')
    assert.deepEqual(Buffer.from((await fixture.resumes.blobs.read(importedResume.capture.original.blobName)).bytes), markdownResume)
    await processAllResumes(fixture, stubs)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Select Jordan Example from resume.MD', exact: true }).check()
    await page.getByRole('button', { name: 'Build analysis (1)', exact: true }).click()
    await page.getByRole('checkbox', { name: /^Include Engineering specialist, Job rubric v1/ }).check()
    await page.getByLabel('Analysis name (optional)', { exact: true }).fill('Markdown browser review')
    assert.equal(fixture.analyses.store.values.size, 0)
    await page.getByRole('button', { name: 'Run analysis', exact: true }).click()
    await page.getByRole('heading', { name: 'Markdown browser review', exact: true }).waitFor({ state: 'visible' })
    await processAllAnalyses(fixture, stubs)
    await page.getByRole('button', { name: 'Refresh pairs', exact: true }).click()
    await page.getByText('1 / 1 comparisons finished', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: /^Review comparison 1:/ }).click()
    await page.getByRole('button', { name: /^View resume evidence for Engineering methods,/ }).click()
    await page.locator('.document-paragraph.is-highlighted mark').filter({ hasText: resumeParagraphs[4].text }).waitFor({ state: 'visible' })
    await page.getByText('Markdown section 1 of 1', { exact: true }).waitFor({ state: 'visible' })
    await page.reload()
    await page.getByRole('heading', { name: 'Evidence-based assessment', exact: true }).waitFor({ state: 'visible' })
    assert.deepEqual(stubs.ocrCalls, [])
    assert.deepEqual(stubs.sourceCalls, [])
    assert.deepEqual(stubs.browserCalls, [])
    assert.deepEqual(errors, [])
    assert.equal(fixture.state.saves.length, 0)
  } finally { await context.close() }
})
