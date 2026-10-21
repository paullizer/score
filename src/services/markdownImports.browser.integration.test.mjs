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

for (const [count, width] of [[4, 1440], [10, 390]]) {
  test(`one ${count}-file Markdown resume drop succeeds first-pass with a delayed fail-fast lease at ${width}px`, { timeout: 120_000 }, async t => {
    const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
    t.after(() => fixture.close())
    const acquire = fixture.state.acquireMutationLease.bind(fixture.state)
    let enteredRelease, finishRelease
    const entered = new Promise(resolve => { enteredRelease = resolve })
    const gate = new Promise(resolve => { finishRelease = resolve })
    let held = false, contentions = 0, releases = 0
    fixture.state.acquireMutationLease = async workspaceId => {
      if (held) contentions++
      const lease = await acquire(workspaceId)
      held = true
      return {
        renew: () => lease.renew(),
        async release() {
          if (releases++ === 0) { enteredRelease(); await gate }
          await new Promise(resolve => setTimeout(resolve, 25))
          await lease.release()
          held = false
        },
      }
    }
    const context = await browser.newContext({ viewport: { width, height: 1000 } })
    const page = await context.newPage()
    const errors = [], responses = []
    const uploadPath = `/api/workspaces/${fixture.workspaceId}/resumes/markdown`
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (new URL(response.url()).pathname === uploadPath && response.request().method() === 'POST') responses.push(response)
    })
    const files = Array.from({ length: count }, (_, index) => ({
      name: `candidate-${String(index + 1).padStart(3, '0')}.md`,
      text: `\ufeff# Candidate ${index + 1}\r\n\r\nEngineer with documented project experience.\r\n`,
    }))
    try {
      await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes`)
      await page.getByRole('button', { name: 'Add resumes', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add real resumes', exact: true })
      const storageBefore = await page.evaluate(() => ({
        local: { ...localStorage }, session: { ...sessionStorage },
      }))
      const transfer = await page.evaluateHandle(inputs => {
        const data = new DataTransfer()
        for (const input of inputs) data.items.add(new File([input.text], input.name, { type: 'text/plain' }))
        return data
      }, files)
      try { await dialog.locator('.drop-zone').dispatchEvent('drop', { dataTransfer: transfer }) }
      finally { await transfer.dispose() }
      await dialog.getByRole('button', { name: `Import ${count} valid inputs`, exact: true }).click()
      await entered
      assert.equal(fixture.requests.filter(request => request.method === 'POST' && request.url === uploadPath).length, 1)
      assert.equal(await dialog.getByText('Waiting to upload — not sent yet', { exact: false }).count(), count - 1)
      assert.equal(await dialog.getByRole('button', { name: 'Awaiting acceptance…', exact: true }).isDisabled(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      await dialog.getByRole('button', { name: 'Close — keep uploading', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      finishRelease()
      await page.getByRole('button', { name: 'Add resumes', exact: true }).click()
      await dialog.getByText(`${count} accepted / ${count} inputs`, { exact: true }).waitFor()
      const uploads = fixture.requests.filter(request => request.method === 'POST' && request.url === uploadPath)
      assert.equal(uploads.length, count, 'Each source is sent once; no automatic or manual retry is needed')
      assert.equal(new Set(uploads.map(request => request.headers['idempotency-key'])).size, count)
      assert.equal(new Set(uploads.map(request => request.headers['x-import-batch'])).size, 1)
      assert.ok(uploads.every(request => request.headers['x-import-count'] === String(count)))
      assert.deepEqual(responses.map(response => response.status()), Array(count).fill(202))
      assert.equal(contentions, 0)
      assert.equal(held, false)
      const records = [...fixture.resumes.store.values.values()].filter(({ record }) => record.recordType === 'resume')
      assert.equal(records.length, count)
      for (const { record } of records) {
        const original = files.find(file => file.name === record.source.fileName)
        assert.ok(original)
        assert.deepEqual(Buffer.from((await fixture.resumes.blobs.read(record.capture.original.blobName)).bytes), Buffer.from(original.text))
        assert.equal(record.resume.status, 'queued')
      }
      assert.equal(fixture.analyses.store.values.size, 0)
      assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), storageBefore,
        'Uploads must not persist private files or import state alongside existing UI preferences')
      assert.deepEqual(errors, [])
    } finally { finishRelease(); await context.close() }
  })
}

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
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/jobs`)
    await page.locator('.sidebar').getByRole('button', { name: 'About Score', exact: true }).click()
    const about = page.getByRole('dialog', { name: 'About Score', exact: true })
    await about.waitFor({ state: 'visible' })
    const aboutText = await about.innerText()
    assert.match(aboutText, /Markdown uploads use \.md or \.markdown files/)
    assert.match(aboutText, /limited to 500 independent comparisons/)
    assert.match(aboutText, /Larger analyses use the same processing rate and may take longer/)
    await about.getByRole('button', { name: 'Back to the workspace', exact: true }).click()
    await about.waitFor({ state: 'hidden' })
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

    // A legacy data parameter from an old link is ignored and still opens the real library.
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes?${new URLSearchParams({ data: 'samples' })}`)
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
    assert.equal(fixture.requests.some((request) => request.url.endsWith('/state') && request.method !== 'GET'), false)
  } finally { await context.close() }
})
