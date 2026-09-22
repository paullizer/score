import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { seededLadder, seedRealJob } from './gradeLadders.test-support.mjs'
import { diagnosticFixture, diagnosticReference, failedComparisonFixture, privateReviewReason } from './analysisDiagnostics.test-support.mjs'
import {
  allPages,
  analysisPassageFor,
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
    await dialog.getByLabel('Choose resume PDF or Markdown files', { exact: true }).setInputFiles({
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
  const other = await fixture.seedWorkspace('Empty evidence workspace')
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
    await page.waitForURL((url) => url.pathname.startsWith(`/workspaces/${other.id}/`))
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
    const features = await (await fixture.request('/api/features')).json()
    assert.equal(features.deploymentCapabilities.realResumeImports, false)
    assert.equal(features.deploymentCapabilities.realAnalyses, false)
    assert.equal(features.publicSettings.features.resumeImports, false)
    assert.equal((await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes`)).status, 503, 'This fixture removes the history service, not merely new admissions')
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes?data=real`)
    await visible(page.getByRole('heading', { name: 'Real resume imports are not enabled', exact: true }))
    await visible(page.getByRole('button', { name: 'Check availability', exact: true }))
    assert.equal(await page.getByRole('button', { name: 'Add resumes', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Add real resumes', exact: true }).count(), 0)
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

const browsingProfiles = [
  { name: 'Zora Example', fileName: 'resume-10.pdf', score: 3 },
  { name: 'ada Example', fileName: 'resume-2.pdf', score: 1 },
  { name: 'Morgan Example', fileName: 'resume-1.pdf', score: 0 },
  { name: null, fileName: 'resume-20.pdf', score: null },
]

function modelResponse(output) {
  return Response.json({ model: 'browsing-fixture', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })
}

async function seedBrowsingInputs(fixture) {
  await seedRealJob(fixture)
  const resumes = []
  for (const profile of browsingProfiles) {
    const paragraphs = resumeParagraphs.map((paragraph, index) => index === 0 ? { ...paragraph, text: profile.name ?? 'Professional profile' } : paragraph)
    const imported = await importResumePdf(fixture, await resumePdf({ name: profile.fileName, paragraphs }))
    const imports = processingStubs(fixture, {
      ocrParagraphs: paragraphs,
      onModelRequest(request) {
        if (request.response_format.json_schema.name !== 'resume_profile') return
        const source = JSON.parse(request.messages[1].content).source.paragraphs
        function quote(text) {
          const paragraph = source.find((item) => item.text.includes(text))
          assert.ok(paragraph, `The fictional source must contain ${text}.`)
          return { paragraphId: paragraph.paragraphId ?? paragraph.id, quote: paragraph.text }
        }
        const field = (text) => text === null ? { status: 'unavailable', value: null, citations: [] }
          : { status: 'available', value: text, citations: [quote(text)] }
        return modelResponse({
          classification: 'single-profile', sparse: false,
          professionalEvidence: [quote('Applied engineering methods'), quote('Bachelor of Engineering')],
          name: field(profile.name), role: field('Engineering specialist'), location: field('Remote'),
          experience: field('Ten years of engineering experience.'),
        })
      },
    })
    await processAllResumes(fixture, imports)
    resumes.push(await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}`)))
  }
  const stubs = processingStubs(fixture, {
    onModelRequest(request) {
      if (request.response_format.json_schema.name !== 'resume_rubric_assessment') return
      const input = JSON.parse(request.messages[1].content).input
      const work = analysisPassageFor(input.resume.paragraphs, 'Applied engineering methods')
      assert.ok(work, 'The browsing fixture must select an exact frozen assessment passage.')
      const profile = browsingProfiles.find((item) => item.name && input.resume.paragraphs.some((paragraph) => paragraph.passages.some((passage) => passage.text === item.name)))
        ?? browsingProfiles.at(-1)
      assert.deepEqual(input.qualifications, [])
      const score = profile.score
      return modelResponse({
        criteria: input.rubric.criteria.map((criterion) => ({
          criterionId: criterion.id, score,
          evidenceStatus: score === null ? 'not-assessed' : score === 0 ? 'missing' : 'supported',
          rationale: score === null ? 'The saved criterion guidance is ambiguous about the required scope of work.'
            : score === 0 ? 'No supporting evidence was assigned to this criterion in this controlled fixture.'
              : 'The quoted passage provides the controlled fixture evidence for this saved criterion.',
          citations: score > 0 ? [work] : [],
          limitation: score === null ? {
            code: 'ambiguous-guidance', message: 'Human review must resolve the ambiguous scope of the saved scoring guidance.',
          } : null,
        })),
        qualifications: [],
      })
    },
  })
  const targets = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets')
  assert.equal(targets.length, 2)
  return { resumes, targets, stubs }
}

async function createBrowsingRun(fixture, resumes, targets, name) {
  return (await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ name, resumes: resumes.map(resumeSelection), targets: targets.map((target) => target.selection) }),
  }), [200, 202])).run
}

async function diagnosticBrowserScenario(fixture) {
  await seedRealJob(fixture)
  const imported = await importResumePdf(fixture, await resumePdf())
  const stubs = processingStubs(fixture)
  await processAllResumes(fixture, stubs)
  const resume = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}`))
  const targets = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets')
  const created = await createBrowsingRun(fixture, [resume], [targets[0]], 'Private diagnostic fixture')
  await processAllAnalyses(fixture, stubs)
  const runPath = `/api/workspaces/${fixture.workspaceId}/analyses/${created.run.id}`
  const [pair] = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
  const pairPath = `${runPath}/comparisons/${pair.comparison.id}`
  const accepted = await jsonResponse(await fixture.request(pairPath))
  assert.ok(accepted.result, 'The browser fixture needs a normalized assessment from fictional sources.')
  const diagnostic = diagnosticFixture(accepted)
  return {
    runPath, pairPath, accepted, diagnostic, detail: failedComparisonFixture(accepted, diagnostic),
    run: await jsonResponse(await fixture.request(runPath)),
    url: `${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${created.run.id}?data=real&result=${pair.comparison.id}`,
  }
}

async function routeDiagnosticScenario(page, fixture, scenario, diagnostics) {
  await page.route(`${fixture.origin}/api/workspaces/${fixture.workspaceId}/analyses**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === `${scenario.pairPath}/diagnostics`) return diagnostics(route)
    if (path === scenario.pairPath) return route.fulfill({ json: scenario.detail })
    if (path === `${scenario.runPath}/comparisons`) return route.fulfill({ json: { comparisons: [{ etag: scenario.detail.etag, comparison: scenario.detail.comparison }] } })
    if (path === scenario.runPath || path === `/api/workspaces/${fixture.workspaceId}/analyses`) {
      const run = structuredClone(scenario.run)
      const status = scenario.detail.comparison.status
      run.run.status = status
      run.run.progress = { total: 1, initialized: 1, queued: 0, running: 0, complete: 0, failed: 0, cancelled: 0, scored: 0, unscored: 0, [status]: 1 }
      if (status === 'complete') run.run.progress.scored = 1
      return route.fulfill({ json: path === scenario.runPath ? run : { runs: [run] } })
    }
    return route.continue()
  })
}

test('browser failed diagnostics expose exact frozen sources, private review reasons, bounded history, and no draft scores', { timeout: 120_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const scenario = await diagnosticBrowserScenario(fixture)
  const older = diagnosticFixture(scenario.accepted, 'fixture-older-attempt', 'fixture-assessment-v2')
  scenario.diagnostic.previous = diagnosticReference(older)
  scenario.detail = failedComparisonFixture(scenario.accepted, scenario.diagnostic)
  let unavailable = true
  const reads = []
  const { context, page, errors } = await newPage()
  try {
    await routeDiagnosticScenario(page, fixture, scenario, (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('continuationToken')
      reads.push(cursor)
      return unavailable ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Private diagnostic fixture service is temporarily unavailable.' } } })
        : route.fulfill({ json: cursor ? { attempts: [older] } : { attempts: [scenario.diagnostic], continuationToken: 'opaque older / fixture' } })
    })
    await page.goto(scenario.url)
    await visible(page.getByRole('heading', { name: 'This comparison could not be assessed', exact: true }))
    await visible(page.getByRole('button', { name: 'Retry diagnostics', exact: true }))
    await visible(page.getByText(/Private diagnostic fixture service is temporarily unavailable/))
    assert.equal(await page.getByText(/No saved diagnostic history is available/).count(), 0)
    assert.ok(reads.every((cursor) => cursor === null), 'no earlier attempt is fetched automatically')
    unavailable = false
    await page.getByRole('button', { name: 'Retry diagnostics', exact: true }).click()
    const review = await visible(page.getByRole('region', { name: 'Private review reasons for cycle 3', exact: true }))
    await visible(review.getByText(privateReviewReason, { exact: true }))
    const criterion = scenario.accepted.targetSnapshot.rubric.criteria[0]
    await visible(review.getByRole('heading', { name: `${criterion.label} (${criterion.id})`, exact: true }))
    await visible(review.getByText('Review ID: fixture-review-fixture-failed-attempt-2', { exact: true }))
    assert.equal(await review.locator('b').count(), 0, 'authorized model explanations are rendered as text, not markup')
    assert.equal(await page.locator('.overall-score, .criterion-score, .criterion-results').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Retry comparison 1 with saved inputs', exact: true }).isEnabled(), true)
    const source = page.getByRole('region', { name: 'Saved real source evidence', exact: true })
    for (const paragraph of scenario.accepted.resumeSnapshot.document.paragraphs) await visible(source.getByText(paragraph.text, { exact: true }))
    await page.setViewportSize({ width: 430, height: 900 })
    await review.getByRole('button', { name: /^View resume evidence for unpublished review:/ }).first().click()
    const citation = scenario.diagnostic.assessments[2].review.issues[0].citations[0]
    await visible(source.locator('.document-paragraph.is-highlighted mark').filter({ hasText: citation.quote }))
    await source.getByRole('button', { name: 'Job description', exact: true }).click()
    for (const paragraph of scenario.accepted.targetSnapshot.document.paragraphs) await visible(source.getByText(paragraph.text, { exact: true }))
    await source.getByRole('button', { name: 'Resume evidence', exact: true }).click()
    await visible(source.getByText(resumeParagraphs[4].text, { exact: true }))
    await page.getByRole('button', { name: 'Load earlier saved attempt', exact: true }).click()
    await visible(page.getByRole('article', { name: 'Saved diagnostic attempt fixture-older-attempt', exact: true }))
    assert.equal(await page.getByRole('article', { name: 'Saved diagnostic attempt fixture-failed-attempt', exact: true }).count(), 0)
    assert.equal(reads.filter((cursor) => cursor === 'opaque older / fixture').length, 1)
    await visible(page.getByText(/Historical failure.*current comparison failed/))

    const accepted = structuredClone(scenario.accepted)
    accepted.comparison.failureDiagnostic = diagnosticReference(scenario.diagnostic)
    accepted.comparison.diagnosticCapture = scenario.detail.comparison.diagnosticCapture
    accepted.comparison.attemptId = 'fixture-success-after-retry'
    scenario.detail = accepted
    const beforeReload = reads.length
    await page.reload()
    await visible(page.getByRole('heading', { name: 'Evidence-based assessment', exact: true }))
    assert.equal(reads.length, beforeReload, 'successful comparisons keep failure history lazy')
    assert.equal(await page.locator('.overall-score').count(), 1)
    await page.getByText('Failure diagnostics and saved attempt history', { exact: true }).click()
    await visible(page.getByText(/Historical failure.*current comparison complete/))
    await visible(page.getByRole('region', { name: 'Private review reasons for cycle 3', exact: true }).getByText(privateReviewReason, { exact: true }))
    assert.equal(await page.locator('.overall-score').count(), 1, 'historical drafts never add another score')
    const storage = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'))
    assert.doesNotMatch(storage, /Private fixture review reason|Private unpublished fixture|assessmentSha256|fixture-failed-attempt/)
    assert.doesNotMatch(page.url(), /continuationToken|Private|fixture-failed-attempt|assessmentSha256/)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser legacy and unavailable failures keep source access and discard late diagnostics after a workspace switch', { timeout: 120_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const scenario = await diagnosticBrowserScenario(fixture)
  const legacy = structuredClone(scenario.detail)
  delete legacy.comparison.failureDiagnostic
  delete legacy.comparison.diagnosticCapture
  delete legacy.comparison.attemptId
  scenario.detail = legacy
  const hold = deferred()
  let diagnosticReads = 0
  const { context, page, errors } = await newPage()
  try {
    await routeDiagnosticScenario(page, fixture, scenario, (route) => { diagnosticReads++; return route.continue() })
    await page.goto(scenario.url)
    await visible(page.getByText('Details were not recorded for this attempt.', { exact: true }))
    const source = page.getByRole('region', { name: 'Saved real source evidence', exact: true })
    await visible(source.getByText(resumeParagraphs[4].text, { exact: true }))
    assert.equal(diagnosticReads, 0)
    scenario.detail.comparison.attemptId = 'fixture-unavailable-attempt'
    scenario.detail.comparison.diagnosticCapture = { attemptId: 'fixture-unavailable-attempt', status: 'unavailable', pipelineVersion: 'fixture-current-v3' }
    scenario.detail.comparison.failureDiagnostic = diagnosticReference(scenario.diagnostic)
    await page.reload()
    await visible(page.getByText(/Diagnostic details are unavailable for this attempt because they could not be saved/))
    assert.equal(diagnosticReads, 0, 'an older artifact is not automatically displayed as a newer failure')
    await visible(source.getByText(resumeParagraphs[4].text, { exact: true }))

    const other = await fixture.seedWorkspace('Empty diagnostic workspace')
    // A policy refresh can remount the detail; keep every diagnostic response pending until the switch.
    fixture.staleRead(`${scenario.pairPath}/diagnostics`, { attempts: [scenario.diagnostic] }, hold.promise, 200, { repeat: true })
    scenario.detail = failedComparisonFixture(scenario.accepted, scenario.diagnostic)
    await page.reload()
    await until(() => diagnosticReads > 0, 'The current failed comparison should request its private diagnostic.')
    await visible(page.getByText('Loading one private saved attempt...', { exact: true }))
    await page.locator('.workspace-switcher-trigger').first().click()
    const switcher = await visible(page.getByRole('dialog', { name: 'My workspaces', exact: true }))
    await switcher.getByRole('button', { name: 'Empty diagnostic workspace', exact: true }).click()
    await page.waitForURL((url) => url.pathname.startsWith(`/workspaces/${other.id}/`))
    hold.resolve()
    await page.getByRole('link', { name: /^Resumes/ }).first().click()
    await visible(page.getByRole('heading', { name: 'Import your first real resume', exact: true }))
    assert.equal(await page.getByText(privateReviewReason, { exact: true }).count(), 0)
    assert.equal(await page.getByText(resumeParagraphs[4].text, { exact: true }).count(), 0)
    assert.equal(await page.getByRole('article', { name: /^Saved diagnostic attempt/ }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { hold.resolve(); await context.close() }
})

test('browser comparison browsing searches every page, scopes score sorting, and preserves keyboard/mobile navigation', { timeout: 120_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true, pageSize: 2 })
  t.after(() => fixture.close())
  const { resumes, targets, stubs } = await seedBrowsingInputs(fixture)
  const created = await createBrowsingRun(fixture, resumes, targets, 'Searchable evidence review')
  await processAllAnalyses(fixture, stubs)
  const runPath = `/api/workspaces/${fixture.workspaceId}/analyses/${created.run.id}`
  const pairs = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
  assert.equal(pairs.length, 8)
  assert.ok(pairs.every(({ comparison }) => comparison.status === 'complete'),
    JSON.stringify(pairs.map(({ comparison }) => ({ id: comparison.id, status: comparison.status, error: comparison.error }))))
  const recordsBefore = JSON.stringify([...fixture.analyses.store.values.values()])
  const modelCallsBefore = stubs.modelCalls.length
  const requestStart = fixture.requests.length
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${created.run.id}?data=real`)
    const section = await visible(page.getByRole('region', { name: 'Real comparisons', exact: true }))
    const rows = section.locator('tbody tr')
    await until(async () => await rows.count() === 8, 'The comparison table must include every continuation page.')
    assert.ok(fixture.requests.slice(requestStart).some((request) => request.url.includes('/comparisons?continuationToken=')))
    const names = () => rows.locator('td:first-child .row-title').allTextContents()
    const search = section.getByRole('searchbox', { name: 'Search comparisons', exact: true })
    const targetSelect = section.getByRole('combobox', { name: /target/i })
    const sortSelect = section.getByRole('combobox', { name: /sort/i })
    const nameHeader = section.getByRole('columnheader').filter({ hasText: 'Saved resume' })
    const scoreHeader = section.getByRole('columnheader').filter({ hasText: 'Assessment / evidence match' })
    assert.equal(await scoreHeader.getByRole('button').isDisabled(), true)
    await nameHeader.getByRole('button').focus()
    await page.keyboard.press('Enter')
    assert.equal(await nameHeader.getAttribute('aria-sort'), 'ascending')
    assert.deepEqual(await names(), ['ada Example', 'ada Example', 'Morgan Example', 'Morgan Example', 'Zora Example', 'Zora Example', 'Name not stated', 'Name not stated'])
    await page.keyboard.press('Space')
    assert.equal(await nameHeader.getAttribute('aria-sort'), 'descending')
    assert.deepEqual(await names(), ['Zora Example', 'Zora Example', 'Morgan Example', 'Morgan Example', 'ada Example', 'ada Example', 'Name not stated', 'Name not stated'])

    const targetOptions = await targetSelect.locator('option').evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent })))
    const versionTwo = targetOptions.find((option) => option.label.includes('Job rubric v2'))
    assert.ok(versionTwo, 'Exact same-named targets must expose their saved versions.')
    await targetSelect.selectOption(versionTwo.value)
    await until(async () => await rows.count() === 4, 'Selecting one saved version should show only its four comparisons.')
    assert.ok((await rows.locator('td:nth-child(2)').allTextContents()).every((text) => text.includes('Job rubric v2')))
    await scoreHeader.getByRole('button').click()
    assert.equal(await scoreHeader.getAttribute('aria-sort'), 'descending')
    assert.deepEqual(await names(), ['Zora Example', 'ada Example', 'Morgan Example', 'Name not stated'])
    await scoreHeader.getByRole('button').click()
    assert.equal(await scoreHeader.getAttribute('aria-sort'), 'ascending')
    assert.deepEqual(await names(), ['Morgan Example', 'ada Example', 'Zora Example', 'Name not stated'])
    assert.match(await rows.first().locator('td:nth-child(3)').textContent(), /0\s*\/\s*100/)
    assert.match(await rows.last().locator('td:nth-child(3)').textContent(), /No overall score/)

    for (const [query, expected] of [
      ['  ADA  ', ['ada Example']],
      ['rEsUmE-10.PdF', ['Zora Example']],
      ['ENGINEERING SPECIALIST', ['Morgan Example', 'ada Example', 'Zora Example', 'Name not stated']],
    ]) {
      await search.fill(query)
      await until(async () => JSON.stringify(await names()) === JSON.stringify(expected), `Saved metadata search should match ${query}.`)
    }
    await search.fill('no-matching-person')
    await visible(section.getByRole('heading', { name: 'No matching comparisons', exact: true }))
    assert.equal(await rows.count(), 0)
    assert.equal(await search.isVisible(), true)
    assert.equal(await targetSelect.isVisible(), true)
    assert.equal(await section.getByText('Comparison initialization is still pending', { exact: true }).count(), 0)
    await search.fill('ADA')
    await until(async () => await rows.count() === 1, 'Search should restore the matching saved comparison.')
    const expectedPair = pairs.find(({ comparison }) => comparison.resume.summary.name === 'ada Example' && comparison.target.summary.selection.rubricVersion === 2)
    const sortValue = await sortSelect.inputValue()
    await rows.getByRole('button', { name: /^Review comparison / }).click()
    await visible(page.getByRole('heading', { name: 'Evidence-based assessment', exact: true }))
    assert.equal(new URL(page.url()).searchParams.get('result'), expectedPair.comparison.id)
    await page.getByRole('link', { name: 'All saved comparisons', exact: true }).click()
    assert.equal(await search.inputValue(), 'ADA')
    assert.equal(await targetSelect.inputValue(), versionTwo.value)
    assert.equal(await sortSelect.inputValue(), sortValue)
    assert.deepEqual(await names(), ['ada Example'])
    await rows.getByRole('button', { name: /^Review comparison / }).click()
    await visible(page.getByRole('heading', { name: 'Evidence-based assessment', exact: true }))
    await page.goBack()
    assert.equal(await search.inputValue(), 'ADA')
    assert.deepEqual(await names(), ['ada Example'])

    await page.setViewportSize({ width: 390, height: 844 })
    await visible(search)
    await visible(targetSelect)
    await visible(sortSelect)
    await search.fill('')
    await targetSelect.selectOption({ label: 'All targets' })
    assert.equal(await sortSelect.inputValue(), '')
    assert.equal(await scoreHeader.getByRole('button').isDisabled(), true)
    await until(async () => await rows.count() === 8, 'All targets should restore the complete saved comparison list.')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Only the table wrapper, not the page, may scroll horizontally.')
    assert.equal(JSON.stringify([...fixture.analyses.store.values.values()]), recordsBefore)
    assert.equal(stubs.modelCalls.length, modelCallsBefore)
    assert.equal(fixture.state.saves.length, 0)
    assert.ok(fixture.requests.slice(requestStart).every((request) => request.method === 'GET'), 'Browsing must not send mutation requests.')
    const stored = await page.evaluate(() => Object.values(localStorage).join('\n'))
    assert.doesNotMatch(stored, /ada Example|Zora Example|resume-10\.pdf|no-matching-person/)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser processing-status sorting preserves filters during refresh and cancels the reordered saved pair', { timeout: 120_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true, pageSize: 2 })
  t.after(() => fixture.close())
  const { resumes, targets, stubs } = await seedBrowsingInputs(fixture)
  const created = await createBrowsingRun(fixture, resumes, targets.slice(0, 1), 'Processing status review')
  const runPath = `/api/workspaces/${fixture.workspaceId}/analyses/${created.run.id}`
  let pairs = []
  for (let pass = 0; pass < 4; pass++) {
    await runtime.api.analysisWorker.runAnalysisWorker(stubs.analyses, { maxItems: 1 })
    pairs = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
    if (pairs.some(({ comparison }) => comparison.status === 'complete')) break
  }
  assert.equal(pairs.length, 4)
  assert.equal(pairs.filter(({ comparison }) => comparison.status === 'complete').length, 1)
  const cancelled = pairs.find(({ comparison }) => comparison.status === 'queued')
  await jsonResponse(await fixture.request(`${runPath}/comparisons/${cancelled.comparison.id}/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': cancelled.etag }, body: '{}',
  }), [200, 202])
  pairs = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
  const queued = pairs.find(({ comparison }) => comparison.status === 'queued')
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${created.run.id}?data=real`)
    const section = await visible(page.getByRole('region', { name: 'Real comparisons', exact: true }))
    const rows = section.locator('tbody tr')
    await until(async () => await rows.count() === 4, 'All current processing states should be loaded.')
    const search = section.getByRole('searchbox', { name: 'Search comparisons', exact: true })
    await search.fill('resume-')
    const statusHeader = section.getByRole('columnheader').filter({ hasText: /Status.*actions/i })
    await statusHeader.getByRole('button').click()
    assert.equal(await statusHeader.getAttribute('aria-sort'), 'ascending')
    assert.equal(await rows.first().getByRole('button', { name: `Retry comparison ${cancelled.comparison.index + 1} with saved inputs`, exact: true }).count(), 1)
    const completed = pairs.find(({ comparison }) => comparison.status === 'complete')
    assert.equal(await rows.last().getByRole('button', { name: new RegExp(`^Review comparison ${completed.comparison.index + 1}:`) }).count(), 1)
    await statusHeader.getByRole('button').click()
    assert.equal(await statusHeader.getAttribute('aria-sort'), 'descending')
    assert.equal(await rows.first().getByRole('button', { name: new RegExp(`^Review comparison ${completed.comparison.index + 1}:`) }).count(), 1)

    const requestStart = fixture.requests.length
    await rows.getByRole('button', { name: `Cancel comparison ${queued.comparison.index + 1}`, exact: true }).click()
    await visible(rows.getByRole('button', { name: `Retry comparison ${queued.comparison.index + 1} with saved inputs`, exact: true }))
    assert.ok(fixture.requests.slice(requestStart).some((request) => request.method === 'POST' && request.url.endsWith(`/comparisons/${queued.comparison.id}/cancel`)))
    await page.getByRole('button', { name: 'Refresh pairs', exact: true }).click()
    assert.equal(await search.inputValue(), 'resume-')
    assert.equal(await statusHeader.getAttribute('aria-sort'), 'descending')
    await processAllAnalyses(fixture, stubs)
    await page.getByRole('button', { name: 'Refresh pairs', exact: true }).click()
    await visible(page.getByText('4 / 4 comparisons finished', { exact: true }))
    assert.equal(await search.inputValue(), 'resume-')
    assert.equal(await statusHeader.getAttribute('aria-sort'), 'descending')
    assert.equal(await rows.count(), 4)
    assert.equal(fixture.state.saves.length, 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser library sorting keeps sample selections and gives mobile cards the same order', { timeout: 90_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const samples = runtime.fixtures.createInitialWorkspace()
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  const orderedNames = samples.resumes.map((resume) => resume.name).sort(collator.compare)
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/resumes?data=samples`)
    await visible(page.getByRole('heading', { name: 'Resumes', exact: true }))
    const candidateHeader = page.getByRole('columnheader').filter({ hasText: 'Candidate' })
    await candidateHeader.getByRole('button').click()
    const tableNames = () => page.locator('.data-table tbody .row-title').allTextContents()
    assert.deepEqual(await tableNames(), orderedNames)
    const chosen = samples.resumes[0]
    await page.getByRole('checkbox', { name: `Select ${chosen.name}`, exact: true }).check()
    const search = page.getByRole('searchbox', { name: 'Search resume library', exact: true })
    await search.fill('no-such-sample-profile')
    await visible(page.getByRole('heading', { name: 'No matching resumes', exact: true }))
    await visible(page.getByText(/1 hidden by search/))
    const sort = page.getByRole('combobox', { name: /sort/i })
    const descending = await sort.locator('option').evaluateAll((options) =>
      options.find((option) => /Candidate/.test(option.textContent) && /Z.*A/.test(option.textContent))?.value)
    assert.ok(descending)
    await sort.selectOption(descending)
    await search.fill('')
    assert.deepEqual(await tableNames(), [...orderedNames].reverse())
    assert.equal(await page.getByRole('checkbox', { name: `Select ${chosen.name}`, exact: true }).isChecked(), true)
    await page.setViewportSize({ width: 390, height: 844 })
    await visible(sort)
    assert.deepEqual(await page.locator('.resume-card .row-title').allTextContents(), [...orderedNames].reverse())
    assert.equal(await page.getByRole('checkbox', { name: `Select ${chosen.name}`, exact: true }).isChecked(), true)
    await sort.selectOption('')
    assert.deepEqual(await page.locator('.resume-card .row-title').allTextContents(), samples.resumes.map((resume) => resume.name))
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))

    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/jobs`)
    await visible(page.getByRole('heading', { name: 'Your jobs', exact: true }))
    await page.getByRole('button', { name: /^Samples/ }).click()
    const jobHeader = page.getByRole('columnheader').filter({ hasText: 'Job / organization' })
    await jobHeader.getByRole('button').click()
    assert.deepEqual(await tableNames(), samples.jobs.map((job) => job.title).sort(collator.compare))
    await jobHeader.getByRole('button').click()
    assert.deepEqual(await tableNames(), samples.jobs.map((job) => job.title).sort((left, right) => collator.compare(right, left)))
    await page.setViewportSize({ width: 390, height: 844 })
    await visible(page.getByRole('combobox', { name: /sort/i }))
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    assert.equal(fixture.analyses.store.values.size, 0)
    assert.equal(fixture.state.saves.length, 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser sample comparison browsing keeps the matrix and remembers search while reviewing one target', { timeout: 90_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const samples = runtime.fixtures.createInitialWorkspace()
  const run = samples.runs.find((item) => item.targets.length > 1)
  const selected = run.resumes[0].resume
  const { context, page, errors } = await newPage()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/${run.id}?data=samples`)
    await visible(page.getByRole('heading', { name: run.name, exact: true }))
    const search = page.getByRole('searchbox', { name: 'Search comparisons', exact: true })
    const targetSelect = page.getByRole('combobox', { name: /target/i })
    const sortSelect = page.getByRole('combobox', { name: /sort/i })
    await visible(page.locator('.matrix-table'))
    assert.equal(await page.locator('.matrix-table tbody tr').count(), run.resumes.length)
    await search.fill(`  ${selected.name.toUpperCase()}  `)
    assert.equal(await page.locator('.matrix-table tbody tr').count(), 1)
    await targetSelect.selectOption(run.targets[0].id)
    await visible(page.locator('.comparison-table'))
    const rows = page.locator('.comparison-table tbody tr')
    assert.equal(await rows.count(), 1)
    assert.equal(await rows.first().locator('.row-title').textContent(), selected.name)
    const scoreHeader = page.getByRole('columnheader').filter({ hasText: 'Evidence match' })
    await scoreHeader.getByRole('button').click()
    const sortValue = await sortSelect.inputValue()
    await rows.first().locator('.row-title').click()
    await visible(page.getByRole('heading', { name: 'The match, criterion by criterion', exact: true }))
    await page.getByRole('link', { name: 'All comparisons', exact: true }).click()
    assert.equal(await search.inputValue(), `  ${selected.name.toUpperCase()}  `)
    assert.equal(await targetSelect.inputValue(), run.targets[0].id)
    assert.equal(await sortSelect.inputValue(), sortValue)
    assert.equal(await rows.count(), 1)
    await search.fill('no-matching-sample')
    await visible(page.getByRole('heading', { name: 'No matching comparisons', exact: true }))
    assert.equal(await targetSelect.isVisible(), true)
    await search.fill(selected.sourceLabel)
    assert.equal(await rows.count(), 1)
    await targetSelect.selectOption({ label: 'All targets' })
    await visible(page.locator('.matrix-table'))
    assert.equal(await sortSelect.inputValue(), '')
    await search.fill('')
    assert.equal(await page.locator('.matrix-table tbody tr').count(), run.resumes.length)
    await page.setViewportSize({ width: 390, height: 844 })
    await visible(search)
    await visible(targetSelect)
    await visible(sortSelect)
    await visible(page.locator('.topbar').getByRole('button', { name: 'QC mode', exact: true }))
    await visible(page.locator('.topbar').getByRole('button', { name: 'New analysis', exact: true }))
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    assert.equal(fixture.analyses.store.values.size, 0, 'Sample browsing must never start real processing.')
    assert.equal(fixture.state.saves.length, 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
