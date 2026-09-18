import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { seededLadder, seedRealJob } from './gradeLadders.test-support.mjs'
import {
  allPages,
  buildResumeAnalysisTestRuntime,
  importResumePdf,
  jsonResponse,
  processAllAnalyses,
  processAllResumes,
  processingStubs,
  publicProfileHtml,
  resumeParagraphs,
  resumePdf,
  resumeSelection,
  startResumeAnalysisFixture,
} from './resumeAnalysis.test-support.mjs'

let runtime, browser
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function visible(locator) {
  await locator.waitFor({ state: 'visible', timeout: 15_000 })
  return locator
}
async function until(check, message) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(message)
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: false })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  return { context, page, errors }
}

before(async () => {
  runtime = await buildResumeAnalysisTestRuntime({ browser: true })
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  }
})
after(async () => { await browser?.close(); await runtime?.close() })

test('browser imports actual PDF bytes, explicitly runs real analysis, opens citations, and preserves results across sample reset', { timeout: 120_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  await seedRealJob(fixture)
  const stubs = processingStubs(fixture)
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes?data=real`)
    await visible(page.getByRole('heading', { name: 'Resumes', exact: true }))
    await page.getByRole('button', { name: 'Add resumes', exact: true }).click()
    const dialog = await visible(page.getByRole('dialog', { name: 'Add real resumes', exact: true }))
    const file = await resumePdf()
    const bytes = Buffer.from(await file.arrayBuffer())
    await dialog.getByLabel('Choose resume PDF files', { exact: true }).setInputFiles({
      name: file.name, mimeType: 'application/pdf', buffer: bytes,
    })
    await dialog.getByRole('button', { name: 'Import 1 valid input', exact: true }).click()
    await visible(dialog.getByText(/Accepted by the server/))
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const saved = [...fixture.resumes.store.values.values()].find(({ record }) => record.recordType === 'resume').record
    assert.deepEqual((await fixture.resumes.blobs.read(saved.capture.original.blobName)).bytes, Uint8Array.from(bytes))
    assert.equal(stubs.modelCalls.length, 0)
    assert.equal(fixture.analyses.store.values.size, 0)

    await processAllResumes(fixture, stubs)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await visible(page.getByRole('link', { name: 'Jordan Example', exact: true }))
    await page.getByRole('link', { name: 'Jordan Example', exact: true }).click()
    const source = await visible(page.getByRole('region', { name: 'Actual resume source', exact: true }))
    await visible(source.getByText(resumeParagraphs[4].text, { exact: true }))
    assert.equal(await source.getByText('Sample content', { exact: true }).count(), 0)
    await page.goBack()
    await page.getByRole('checkbox', { name: 'Select Jordan Example from resume.pdf', exact: true }).check()
    await page.getByRole('button', { name: 'Build analysis (1)', exact: true }).click()
    await visible(page.getByRole('heading', { name: 'Build a real analysis', exact: true }))
    assert.equal(await page.getByRole('checkbox', { name: 'Include Jordan Example from resume.pdf', exact: true }).isChecked(), true)
    await page.getByRole('checkbox', { name: /^Include Engineering specialist, Job rubric v2/ }).check()
    await page.getByLabel('Analysis name (optional)', { exact: true }).fill('Browser engineering review')
    assert.equal(fixture.analyses.store.values.size, 0, 'Selecting inputs alone never submits model work.')
    await page.getByRole('button', { name: 'Run analysis', exact: true }).click()
    await visible(page.getByRole('heading', { name: 'Browser engineering review', exact: true }))
    const runUrl = page.url()
    await processAllAnalyses(fixture, stubs)
    await page.getByRole('button', { name: 'Refresh pairs', exact: true }).click()
    await visible(page.getByText('1 / 1 comparisons finished', { exact: true }))
    await page.getByRole('button', { name: /^Review comparison 1:/ }).click()
    await visible(page.getByRole('heading', { name: 'Evidence-based assessment', exact: true }))
    await page.getByRole('button', { name: /^View resume evidence for Engineering methods,/ }).click()
    await visible(page.locator('.document-paragraph.is-highlighted mark').filter({ hasText: resumeParagraphs[4].text }))
    assert.equal(await page.getByText('Simulated scoring', { exact: true }).count(), 0)
    const resultUrl = page.url()
    await page.reload()
    await visible(page.getByRole('heading', { name: 'Evidence-based assessment', exact: true }))
    const recordsBefore = JSON.stringify([...fixture.analyses.store.values.values()])
    const sourceBefore = JSON.stringify([...fixture.resumes.store.values.values()])
    const storage = await page.evaluate(() => Object.values(localStorage).join('\n'))
    assert.doesNotMatch(storage, /Jordan Example|Applied engineering methods|documentSha256|assessmentSha256/)
    assert.equal(fixture.state.saves.length, 0)

    await page.getByRole('button', { name: 'Reset samples', exact: true }).click()
    const reset = await visible(page.getByRole('dialog', { name: 'Reset sample content?', exact: true }))
    await reset.getByRole('button', { name: 'Reset samples', exact: true }).click()
    await reset.waitFor({ state: 'hidden' })
    await until(() => fixture.state.saves.length > 0, 'The explicit sample reset should save only sample state.')
    assert.equal(JSON.stringify([...fixture.analyses.store.values.values()]), recordsBefore)
    assert.equal(JSON.stringify([...fixture.resumes.store.values.values()]), sourceBefore)
    assert.ok(fixture.state.saves.every(({ content }) => !content.includes('Jordan Example') && !content.includes('assessmentSha256')))
    await page.goto(resultUrl)
    await visible(page.getByRole('heading', { name: 'Browser engineering review', exact: true }))
    await visible(page.getByRole('heading', { name: 'Evidence-based assessment', exact: true }))
    assert.ok(resultUrl.startsWith(runUrl))
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser multiline URLs keep good inputs, explain inaccessible LinkedIn, and do not turn invalid URLs into samples', { timeout: 90_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const publicUrl = 'https://profiles.example.test/jordan'
  const blockedUrl = 'https://www.linkedin.com/in/inaccessible-fixture'
  const stubs = processingStubs(fixture, {
    urlPages: new Map([[publicUrl, { body: publicProfileHtml }], [blockedUrl, { status: 403, body: 'Access denied' }]]),
  })
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes?data=real`)
    await page.getByRole('button', { name: 'Add resumes', exact: true }).click()
    const dialog = await visible(page.getByRole('dialog', { name: 'Add real resumes', exact: true }))
    await dialog.getByRole('button', { name: 'Public URLs', exact: true }).click()
    await dialog.getByLabel('Public resume or profile URLs').fill(`${publicUrl}\n${blockedUrl}\nnot-a-url`)
    await dialog.getByRole('button', { name: 'Add URLs to batch', exact: true }).click()
    await visible(dialog.getByText(/Invalid input.*not sent/))
    await dialog.getByRole('button', { name: 'Import 2 valid inputs', exact: true }).click()
    await until(async () => await dialog.getByText(/Accepted by the server/).count() === 2, 'Both valid URL submissions should be accepted independently.')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await processAllResumes(fixture, stubs)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    const blocked = page.getByRole('row').filter({ hasText: blockedUrl })
    await visible(blocked.getByText(/not publicly accessible.*could not be processed/i))
    assert.equal(await blocked.getByRole('checkbox').isDisabled(), true)
    const ready = page.getByRole('row').filter({ hasText: publicUrl })
    await visible(ready.getByRole('link', { name: 'Jordan Example', exact: true }))
    assert.equal(await ready.getByRole('checkbox').isEnabled(), true)
    assert.equal([...fixture.resumes.store.values.values()].filter(({ record }) => record.recordType === 'resume').length, 2)
    assert.equal(stubs.modelCalls.length, 1)
    assert.equal(fixture.analyses.store.values.size, 0)
    assert.equal(fixture.state.saves.length, 0)
    const storage = await page.evaluate(() => Object.values(localStorage).join('\n'))
    assert.doesNotMatch(storage, /linkedin\.com|profiles\.example|Jordan Example/)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser workspace switching ignores a late private resume response from the previous workspace', { timeout: 90_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const imported = await importResumePdf(fixture, await resumePdf())
  await processAllResumes(fixture, processingStubs(fixture))
  const oldPath = `/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}`
  const oldDetail = await jsonResponse(await fixture.request(oldPath))
  const created = await jsonResponse(await fixture.request('/api/workspaces', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Empty evidence workspace' }),
  }), [201])
  const hold = deferred()
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes?data=real`)
    await visible(page.getByRole('link', { name: 'Jordan Example', exact: true }))
    fixture.staleRead(oldPath, oldDetail, hold.promise)
    await page.getByRole('link', { name: 'Jordan Example', exact: true }).click()
    await visible(page.getByRole('heading', { name: 'Opening private resume', exact: true }))
    await page.locator('.workspace-switcher-trigger').first().click()
    const switcher = await visible(page.getByRole('dialog', { name: 'My workspaces', exact: true }))
    await switcher.getByRole('button', { name: 'Empty evidence workspace', exact: true }).click()
    await page.waitForURL((url) => url.pathname.startsWith(`/workspaces/${created.workspace.id}/`))
    hold.resolve()
    await page.getByRole('link', { name: /^Resumes/ }).first().click()
    await visible(page.getByRole('heading', { name: 'Import your first real resume', exact: true }))
    assert.equal(await page.getByText('Jordan Example', { exact: true }).count(), 0)
    assert.equal(await page.getByText(resumeParagraphs[4].text, { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { hold.resolve(); await context.close() }
})

test('browser unavailable real services remain explicit while Samples require deliberate selection', { timeout: 90_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, {
    injectAuth: true, configOverrides: { realResumes: undefined, realAnalyses: undefined },
  })
  t.after(() => fixture.close())
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes?data=real`)
    await visible(page.getByRole('heading', { name: 'Real resume imports are not enabled', exact: true }))
    assert.equal(await page.getByText(/Every candidate is fictional/).count(), 0)
    await page.getByRole('button', { name: /^Samples/ }).click()
    await visible(page.getByText(/Every candidate is fictional/))
    assert.equal(fixture.resumes.store.values.size, 0)
    assert.equal(fixture.analyses.store.values.size, 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser approved GS analysis opens copied reference evidence through its exact comparison boundary', { timeout: 120_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const seeded = await seededLadder(fixture)
  const supported = seeded.detail.levels.find((level) => level.head.grade === 9)
  const restore = fixture.installClientFetch()
  try {
    const approved = await runtime.client.approveGrade(fixture.workspaceId, seeded.detail.ladder.id, 9, {
      versionId: supported.version.id, reviewId: supported.review.id,
    }, supported.etag)
    const current = approved.levels.find((level) => level.head.grade === 9)
    await runtime.client.saveGradeDraft(fixture.workspaceId, seeded.detail.ladder.id, 9, {
      rubric: { ...current.version.rubric, name: 'Unapproved replacement grade' },
      qualifications: current.version.qualifications,
    }, current.etag)
  } finally { restore() }
  await importResumePdf(fixture, await resumePdf())
  const stubs = processingStubs(fixture)
  await processAllResumes(fixture, stubs)
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/new?data=real`)
    await visible(page.getByRole('heading', { name: 'Build a real analysis', exact: true }))
    await page.getByRole('checkbox', { name: 'Include Jordan Example from resume.pdf', exact: true }).check()
    await page.getByRole('button', { name: /^Approved GS versions/ }).click()
    await visible(page.getByText('Newer draft exists · not selected', { exact: true }))
    await page.getByRole('checkbox', { name: /^Include GS-9 engineering expectations,/ }).check()
    assert.equal(await page.getByRole('checkbox', { name: /Unapproved replacement grade/ }).count(), 0)
    await page.getByLabel('Analysis name (optional)', { exact: true }).fill('Approved GS source review')
    await page.getByRole('button', { name: 'Run analysis', exact: true }).click()
    await visible(page.getByRole('heading', { name: 'Approved GS source review', exact: true }))
    await processAllAnalyses(fixture, stubs)
    await page.getByRole('button', { name: 'Refresh pairs', exact: true }).click()
    await visible(page.getByText('1 / 1 comparisons finished', { exact: true }))
    await page.getByRole('button', { name: /^Review comparison 1:/ }).click()
    await visible(page.getByRole('heading', { name: 'Evidence-based assessment', exact: true }))
    await visible(page.getByRole('region', { name: 'Unscored GS qualifications', exact: true }))
    await page.getByRole('button', { name: /^View requirement evidence for Engineering methods,/ }).first().click()
    const quote = supported.version.rubric.criteria[0].gradeBasis[0].quote
    await visible(page.locator('.document-paragraph.is-highlighted mark').filter({ hasText: quote }))
    assert.ok(fixture.requests.some((request) => request.method === 'GET' &&
      /\/analyses\/[^/]+\/comparisons\/[^/]+\/documents\/[^?]+\?version=1/.test(request.url)),
    'Copied GS evidence must use the authorized comparison-scoped document endpoint.')
    assert.equal(fixture.state.saves.length, 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser preserves 103 resumes across navigation and reload and submits all 412 comparisons against four jobs', { timeout: 120_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true, pageSize: 25 })
  t.after(() => fixture.close())
  for (let index = 0; index < 4; index++) await seedRealJob(fixture)
  const bytes = await (await resumePdf()).arrayBuffer()
  for (let offset = 0; offset < 103; offset += 10) {
    const batchId = randomUUID()
    const inputCount = Math.min(10, 103 - offset)
    await Promise.all(Array.from({ length: inputCount }, (_, index) => importResumePdf(fixture,
      new File([bytes], `resume-${offset + index + 1}.pdf`, { type: 'application/pdf' }), { batchId, inputCount })))
  }
  const stubs = processingStubs(fixture)
  await processAllResumes(fixture, stubs)
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes?data=real`)
    await page.getByRole('button', { name: 'Select ready visible', exact: true }).click()
    await page.getByRole('button', { name: 'Build analysis (103)', exact: true }).click()
    await visible(page.getByRole('heading', { name: 'Build a real analysis', exact: true }))
    const location = new URL(page.url())
    assert.ok(location.pathname.length + location.search.length <= 2048)
    const selected = page.getByRole('checkbox', { name: /^Include Jordan Example from resume-/ })
    assert.equal(await selected.count(), 103)
    assert.equal(await selected.evaluateAll((elements) => elements.filter((element) => element.checked).length), 103)
    await page.reload()
    await visible(page.getByRole('heading', { name: 'Build a real analysis', exact: true }))
    assert.equal(await selected.count(), 103)
    assert.equal(await selected.evaluateAll((elements) => elements.filter((element) => element.checked).length), 103)
    const targets = page.getByRole('checkbox', { name: /^Include Engineering specialist, Job rubric v2/ })
    assert.equal(await targets.count(), 4)
    for (const target of await targets.all()) await target.check()
    assert.equal(await page.getByRole('button', { name: 'Run analysis', exact: true }).isEnabled(), true)
    assert.equal(await page.locator('.comparison-count strong').textContent(), '412')
    const extra = page.getByRole('checkbox', { name: /^Include Engineering specialist, Job rubric v1/ }).first()
    await extra.check()
    assert.equal(await page.getByRole('button', { name: 'Run analysis', exact: true }).isDisabled(), true)
    await visible(page.getByText(/515 comparisons exceeds the 500-comparison limit/))
    assert.equal(await selected.evaluateAll((elements) => elements.filter((element) => element.checked).length), 103)
    await extra.uncheck()
    assert.ok(fixture.requests.filter((request) => request.url.startsWith('/workspaces/')).every((request) => request.url.length <= 2048))
    assert.equal(fixture.analyses.store.values.size, 0, 'Navigation and selection never submit analyses automatically.')
    await page.getByLabel('Analysis name (optional)', { exact: true }).fill('Full resume library review')
    await page.getByRole('button', { name: 'Run analysis', exact: true }).click()
    await visible(page.getByRole('heading', { name: 'Full resume library review', exact: true }))
    const runs = [...fixture.analyses.store.values.values()].filter(({ record }) => record.recordType === 'analysis-run')
    assert.equal(runs.length, 1)
    assert.equal(runs[0].record.progress.total, 412)
    const detail = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runs[0].record.id}`))
    assert.equal(detail.resumes.length, 103)
    assert.equal(new Set(detail.targets.map(item => item.selection.jobId)).size, 4)
    assert.equal(stubs.modelCalls.filter(request => request.response_format.json_schema.name === 'resume_rubric_assessment').length, 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser resumes a paused cancellation without scoring or replacing its captured inputs', { timeout: 90_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true, pageSize: 25 })
  t.after(() => fixture.close())
  const imported = await importResumePdf(fixture, await resumePdf())
  const stubs = processingStubs(fixture)
  await processAllResumes(fixture, stubs)
  const resume = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}`))
  for (let index = 0; index < 15; index++) await seedRealJob(fixture)
  const targets = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets')
  assert.equal(targets.length, 30)
  const created = (await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ name: 'Paused cancellation recovery', resumes: [resumeSelection(resume)], targets: targets.map((target) => target.selection) }),
  }), [200, 202])).run
  const runPath = `/api/workspaces/${fixture.workspaceId}/analyses/${created.run.id}`
  await jsonResponse(await fixture.request(`${runPath}/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': created.etag }, body: '{}',
  }), [200, 202])
  const stored = await fixture.analyses.store.get(fixture.workspaceId, created.run.id)
  assert.equal(stored.record.cancellation.nextComparisonIndex, 25)
  assert.equal(stored.record.cancellation.completedAt, undefined)
  const paused = {
    ...stored.record, updatedAt: fixture.now().toISOString(), attempts: 3,
    error: { code: 'storage-error', stage: 'initialization', message: 'Cancellation paused after repeated storage failures.', retryable: true },
  }
  delete paused.lease
  delete paused.nextAttemptAt
  await fixture.analyses.store.replace(paused, stored.etag)
  const manifest = structuredClone(paused.manifest)
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${created.run.id}?data=real`)
    await visible(page.getByRole('heading', { name: 'Paused cancellation recovery', exact: true }))
    await visible(page.getByText('Cancellation paused', { exact: true }))
    assert.equal(await page.getByRole('button', { name: /^Retry comparison 1 with saved inputs$/ }).isDisabled(), true)
    await page.getByRole('button', { name: 'Resume cancellation', exact: true }).click()
    await visible(page.getByText('30 / 30 comparisons finished', { exact: true }))
    const final = await jsonResponse(await fixture.request(runPath))
    assert.equal(final.run.status, 'cancelled')
    assert.ok(final.run.cancellation.completedAt)
    assert.equal(final.run.progress.cancelled, 30)
    assert.equal(final.run.progress.complete, 0)
    assert.equal(final.run.retryCount, paused.retryCount + 1)
    assert.deepEqual(final.run.manifest, manifest)
    assert.equal(stubs.modelCalls.length, 1, 'Resuming cleanup must not invoke the analysis model.')
    const pairs = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
    assert.ok(pairs.every(({ comparison }) => comparison.status === 'cancelled' && !comparison.result))
    assert.equal(fixture.state.saves.length, 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
