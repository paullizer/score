import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { buildGradeTestRuntime, completeReference, finishWork, publishNeedsSourcesReview, referencePdf, seededLadder, seedRealJob, startGradeFixture } from './gradeLadders.test-support.mjs'

let runtime, browser
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
async function visible(locator) {
  try { await locator.waitFor({ state: 'visible', timeout: 15000 }); return locator }
  catch (error) { throw new Error(`${error.message}\nVisible fixture content:\n${await locator.page().locator('body').innerText()}`, { cause: error }) }
}
async function until(check, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(message)
}
async function newPage(fixture) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: false })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15000)
  return { context, page, errors }
}
const column = (page, grade) => page.locator('.grade-matrix thead th').filter({ has: page.getByRole('heading', { name: `GS-${grade}`, exact: true }) })

before(async () => {
  runtime = await buildGradeTestRuntime({ browser: true })
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  }
})
after(async () => { await browser?.close(); await runtime?.close() })

test('direct grade links preserve saved evidence during feature-policy errors and recover new admissions explicitly', { timeout: 90000 }, async (t) => {
  const fixture = await startGradeFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  const { context, page, errors } = await newPage(fixture)
  let unavailable = true
  try {
    await page.route('**/api/features', async route => {
      if (unavailable) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Grade service temporarily unavailable.' } }) })
      else await route.continue()
    })
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}`)
    await visible(page.getByRole('heading', { name: detail.ladder.name, exact: true }))
    assert.equal(await page.getByRole('button', { name: 'Rediscover OPM sources', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('heading', { name: 'Loading private grade ladder', exact: true }).count(), 0)
    unavailable = false
    await page.getByRole('button', { name: 'Refresh application policy', exact: true }).click()
    await until(async () => await page.getByRole('button', { name: 'Refresh application policy', exact: true }).count() === 0, 'The effective policy refresh should recover without replacing saved evidence')
    await visible(page.getByRole('heading', { name: detail.ladder.name, exact: true }))
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test('browser creates an exact-version ladder and uploads real, page-ranged reference bytes without legacy state persistence', { timeout: 90000 }, async (t) => {
  const fixture = await startGradeFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const { context, page, errors } = await newPage(fixture)
  try {
    const seed = await seedRealJob(fixture)
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/jobs/${seed.job.id}`)
    await visible(page.getByRole('heading', { name: seed.job.title, exact: true }).first())
    await until(() => page.getByRole('button', { name: 'Create grade ladder', exact: true }).isEnabled(), 'The real-job creation entry point should enable')
    await page.getByRole('button', { name: 'Create grade ladder', exact: true }).click()
    const dialog = await visible(page.getByRole('dialog', { name: 'Create grade ladder', exact: true }))
    await dialog.getByLabel('Saved seed rubric version', { exact: true }).selectOption(`${seed.rubric.id}:1`)
    await dialog.getByLabel('Ladder family name', { exact: true }).fill('Browser-created engineering ladder')
    await dialog.getByLabel('I confirm this saved job/rubric version as the seed.').check()
    await dialog.getByLabel('Agency applicability', { exact: true }).selectOption('other-federal')
    await dialog.getByLabel('Supervisory / leader coverage', { exact: true }).selectOption('nonsupervisory')
    for (const grade of [1, 9, 15]) await dialog.getByLabel(`GS-${grade}`, { exact: true }).check()
    await dialog.getByLabel('I confirm the requested series, grades, and position context.', { exact: false }).check()
    await dialog.getByRole('button', { name: 'Create and discover sources' }).click()
    await visible(page.getByRole('heading', { name: 'Browser-created engineering ladder', exact: true }))
    const ladderId = new URL(page.url()).pathname.split('/').at(-1)
    let detail = await (await fixture.request(`/api/workspaces/${fixture.workspaceId}/grade-ladders/${ladderId}`)).json()
    assert.equal(detail.ladder.seedRubricVersion, 1)
    assert.deepEqual(detail.ladder.grades, [1, 9, 15])
    assert.ok(detail.workItems.some((work) => work.input.kind === 'discover' && work.status === 'queued'))
    await finishWork(fixture, ladderId, ['discover'])
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click()
    await page.getByRole('button', { name: 'Add PDF / URL', exact: true }).click()
    const upload = await visible(page.getByRole('dialog', { name: 'Add supporting evidence' }))
    const file = await referencePdf()
    await upload.getByLabel('Supporting PDF', { exact: true }).setInputFiles({ name: file.name, mimeType: 'application/pdf', buffer: Buffer.from(await file.arrayBuffer()) })
    await visible(upload.getByText(/204 original pages/))
    await upload.getByLabel('Original PDF pages (optional)', { exact: true }).fill('178,204')
    await upload.getByRole('button', { name: 'Capture supporting source' }).click()
    await upload.waitFor({ state: 'hidden' })
    detail = await (await fixture.request(`/api/workspaces/${fixture.workspaceId}/grade-ladders/${ladderId}`)).json()
    const source = detail.sources.find((source) => source.origin === 'upload')
    assert.ok(source)
    assert.deepEqual((await fixture.grades.blobs.read(source.originalBlobName)).bytes, new Uint8Array(await file.arrayBuffer()))
    await completeReference(fixture, detail, source.id)
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click()
    const sourceCard = page.locator('.grade-source-card').filter({ hasText: 'Engineering test reference' })
    await visible(sourceCard)
    await sourceCard.getByLabel('Applicability decision', { exact: true }).selectOption('applicable')
    await sourceCard.getByLabel('Evidence and scope for this decision', { exact: true }).fill('Reviewed the explicit GS-9 scope and retained unresolved coverage for GS-1 and GS-15.')
    await page.getByLabel('I reviewed the selected captures, page coverage, applicability, and unresolved issues.', { exact: false }).check()
    await page.getByRole('button', { name: 'Confirm frozen source set', exact: true }).click()
    await visible(page.getByText(/Frozen source set · revision/))
    detail = await (await fixture.request(`/api/workspaces/${fixture.workspaceId}/grade-ladders/${ladderId}`)).json()
    assert.equal(detail.sourceSet.sources.length, 2)
    assert.equal(detail.sourceSet.decisions.find((decision) => decision.sourceId === source.id).applicability, 'applicable')
    await page.getByRole('button', { name: 'Generate grade drafts', exact: true }).click()
    await visible(page.getByText(/Generation accepted/))
    assert.equal(fixture.requests.some((request) => request.url.endsWith('/state') && request.method !== 'GET'), false)
    const persistence = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    assert.doesNotMatch(persistence, /Browser-created engineering|Engineering test reference|source-set-|grade-version-/)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('browser review keeps exact citations, protects unsaved and accepted drafts, ignores stale reads, and supports mobile history', { timeout: 90000 }, async (t) => {
  const fixture = await startGradeFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  const { context, page, errors } = await newPage(fixture)
  const stale = deferred(), accepted = deferred()
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/jobs`)
    await visible(page.getByRole('heading', { name: 'Your jobs', exact: true }))
    await page.locator('.sidebar').getByRole('link', { name: /Rubrics/ }).click()
    await page.getByRole('button', { name: /GS \/ grade rubrics/ }).click()
    await page.getByRole('link', { name: detail.ladder.name, exact: true }).click()
    await visible(page.getByRole('table', { name: /GS grades aligned by common competency identity/ }))
    assert.equal(await column(page, 9).getByRole('button', { name: 'Approve supported version' }).isEnabled(), true)
    assert.equal(await column(page, 11).getByRole('button', { name: 'Approve supported version' }).isDisabled(), true)
    await page.locator('.grade-matrix').getByRole('button', { name: /Captured v1 · p. 178/ }).first().click()
    let inspector = await visible(page.getByRole('dialog', { name: 'Engineering test reference', exact: true }))
    await visible(inspector.getByText('Original page 178 of 204', { exact: true }))
    assert.match(await inspector.getByRole('link', { name: 'Captured original', exact: true }).getAttribute('href'), new RegExp(`sourceSetId=${detail.sourceSet.id}`))
    assert.equal(await inspector.locator('mark').first().textContent(), 'GS-9: Apply engineering methods to defined projects.')
    await inspector.getByRole('button', { name: 'Close source', exact: true }).click()

    const detailPath = `/api/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}`
    fixture.staleRead(detailPath, detail, stale.promise)
    const oldRead = page.waitForRequest((request) => new URL(request.url()).pathname === detailPath && request.method() === 'GET')
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click()
    await oldRead
    await column(page, 9).getByRole('button', { name: 'Approve supported version' }).click()
    const approval = await visible(page.getByRole('dialog', { name: /Approve GS-9, version 1/ }))
    await approval.getByRole('button', { name: 'Approve this supported version' }).click()
    await visible(column(page, 9).getByRole('button', { name: 'Version approved', exact: true }))
    stale.resolve()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await column(page, 9).getByRole('button', { name: 'Version approved', exact: true }).isDisabled(), true)

    await column(page, 9).getByRole('button', { name: 'Edit draft', exact: true }).click()
    let editor = await visible(page.getByRole('dialog', { name: 'Edit GS-9 draft', exact: true }))
    await editor.getByLabel('Grade rubric name', { exact: true }).fill('Protected unsaved engineering draft')
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented }), true)
    await editor.getByRole('button', { name: 'Close draft', exact: true }).click()
    let protection = await visible(page.getByRole('dialog', { name: 'Unsaved changes', exact: true }))
    await protection.getByRole('button', { name: 'Stay here', exact: true }).click()
    assert.equal(await editor.getByLabel('Grade rubric name', { exact: true }).inputValue(), 'Protected unsaved engineering draft')
    await editor.getByRole('button', { name: 'Cite captured grading evidence', exact: true }).click()
    const quotation = await visible(page.getByRole('dialog', { name: 'Cite an exact captured passage', exact: true }))
    await quotation.getByRole('button', { name: 'Cancel quotation', exact: true }).click()
    assert.equal(await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).count(), 0, 'closing an untouched nested quotation does not discard the outer draft')
    fixture.holdMutation(accepted.promise)
    await editor.getByRole('button', { name: 'Save draft and request review' }).click()
    await until(async () => {
      const current = await (await fixture.request(detailPath)).json()
      return current.levels.find((level) => level.head.grade === 9).version.version === 2
    }, 'The server should accept the draft while its response is held')
    await editor.getByRole('button', { name: 'Close draft', exact: true }).click()
    protection = await visible(page.getByRole('dialog', { name: 'Request in progress', exact: true }))
    assert.equal(await protection.getByRole('button', { name: /leave|Continue/ }).isDisabled(), true)
    accepted.resolve()
    await visible(page.getByRole('button', { name: 'Stay here', exact: true }))
    await page.getByRole('button', { name: 'Stay here', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await visible(column(page, 9).getByText('Generating / grounding review', { exact: true }))
    assert.equal(await column(page, 9).getByRole('button', { name: 'Approve supported version' }).isDisabled(), true)

    await page.setViewportSize({ width: 390, height: 844 })
    const tabs = await visible(page.getByRole('tablist', { name: 'Choose a GS grade' }))
    await tabs.getByRole('tab', { name: /GS-11/ }).click()
    await visible(page.locator('.grade-mobile-panel').getByText('Evidence gap · draft', { exact: true }))
    await tabs.getByRole('tab', { name: /GS-11/ }).press('ArrowLeft')
    assert.equal(await tabs.getByRole('tab', { name: /GS-9/ }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.locator('.grade-mobile-panel').getByRole('button', { name: 'History', exact: true }).click()
    await visible(page.getByRole('heading', { name: 'GS-9 · immutable history', exact: true }))
    await page.getByRole('link', { name: /Version 1/ }).click()
    await visible(page.getByRole('heading', { name: 'GS-9 engineering expectations', exact: true }))
    assert.equal(await page.getByRole('heading', { name: 'Protected unsaved engineering draft', exact: true }).count(), 0)
    await page.locator('.grade-history-content').getByRole('button', { name: /Engineering test reference · captured v1/ }).click()
    inspector = await visible(page.getByRole('dialog', { name: 'Engineering test reference', exact: true }))
    await visible(inspector.getByText(/omitted pages were not examined/))
    assert.equal(await inspector.locator('.document-kicker').first().textContent(), 'REFERENCE / STANDARD178')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    assert.deepEqual(errors, [])
  } finally { stale.resolve(); accepted.resolve(); await context.close(); await fixture.close() }
})

test('browser saves a still-incomplete zero-weight draft and leaves approval blocked after review', { timeout: 60000 }, async (t) => {
  const fixture = await startGradeFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  const gap = detail.levels.find((level) => level.head.grade === 11)
  const { context, page, errors } = await newPage(fixture)
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}`)
    await visible(page.getByRole('heading', { name: detail.ladder.name, exact: true }))
    assert.equal(await column(page, 11).getByRole('button', { name: 'Approve supported version' }).isDisabled(), true)
    await column(page, 11).getByRole('button', { name: 'Edit draft', exact: true }).click()
    const editor = await visible(page.getByRole('dialog', { name: 'Edit GS-11 draft', exact: true }))
    assert.equal(await editor.getByLabel('Review weight (%)', { exact: true }).inputValue(), '0')
    assert.equal(await editor.getByLabel('Review weight (%)', { exact: true }).getAttribute('max'), '0')
    await visible(editor.getByText('0% allocated / 100%', { exact: true }))
    await visible(editor.getByText(/Incomplete drafts may leave review weight unallocated/))
    assert.equal(await editor.getByRole('combobox').count(), 0, 'support labels remain server-controlled')
    await editor.getByLabel('Grade rubric name', { exact: true }).fill('Still-incomplete browser draft')
    const path = `/api/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}`
    const draftRequest = page.waitForRequest((request) => request.method() === 'PUT' && new URL(request.url()).pathname === `${path}/grades/11/draft`)
    await editor.getByRole('button', { name: 'Save draft and request review' }).click()
    const body = (await draftRequest).postDataJSON()
    assert.deepEqual(body.rubric.criteria, gap.version.rubric.criteria)
    await editor.waitFor({ state: 'hidden' })
    await visible(column(page, 11).getByText('Saved version 2', { exact: true }))
    let current = (await (await fixture.request(path)).json()).levels.find((level) => level.head.grade === 11)
    assert.equal(current.version.rubric.name, 'Still-incomplete browser draft')
    assert.deepEqual(current.version.rubric.criteria, gap.version.rubric.criteria)
    assert.equal(current.head.status, 'processing')
    assert.equal(current.approval, null)
    assert.equal(await column(page, 11).getByRole('button', { name: 'Approve supported version' }).isDisabled(), true)
    await publishNeedsSourcesReview(fixture, current, gap.review.issues)
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click()
    await visible(column(page, 11).getByText('Needs supporting sources', { exact: true }))
    assert.equal(await column(page, 11).getByRole('button', { name: 'Approve supported version' }).isDisabled(), true)
    current = (await (await fixture.request(path)).json()).levels.find((level) => level.head.grade === 11)
    assert.equal(current.review.outcome, 'needs-sources')
    assert.equal(current.version.rubric.criteria[0].weight, 0)
    assert.equal(current.version.rubric.criteria[0].support, 'gap')
    assert.equal(current.approval, null)
    assert.equal(current.head.approvedVersionId, undefined)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('workspace/sign-out guards protect unsaved real grade edits across navigation attempts', { timeout: 90000 }, async (t) => {
  const fixture = await startGradeFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  const other = await fixture.seedWorkspace('Other review workspace')
  const { context, page, errors } = await newPage(fixture)
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}`)
    await visible(page.getByRole('heading', { name: detail.ladder.name, exact: true }))
    await page.getByRole('button', { name: /Sources & applicability/ }).click()
    const reason = page.getByLabel('Evidence and scope for this decision', { exact: true })
    await reason.fill('Unsaved applicability review kept in this tab')
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    let protection = await visible(page.getByRole('dialog', { name: 'Unsaved changes', exact: true }))
    await protection.getByRole('button', { name: 'Stay here', exact: true }).click()
    await until(() => page.getByRole('button', { name: 'Sign out', exact: true }).isEnabled(), 'Cancelled sign-out must not stay disabled')
    assert.equal(await reason.inputValue(), 'Unsaved applicability review kept in this tab')
    await page.locator('.workspace-switcher-trigger').click()
    let switcher = await visible(page.getByRole('dialog', { name: 'My workspaces', exact: true }))
    await switcher.getByRole('button', { name: other.name, exact: true }).click()
    protection = await visible(page.getByRole('dialog', { name: 'Unsaved changes', exact: true }))
    await protection.getByRole('button', { name: 'Stay here', exact: true }).click()
    await until(() => switcher.getByRole('button', { name: other.name, exact: true }).isEnabled(), 'Cancelled workspace switching should settle')
    await switcher.getByRole('button', { name: 'Close dialog', exact: true }).click()
    assert.equal(await reason.inputValue(), 'Unsaved applicability review kept in this tab')
    await page.getByRole('button', { name: 'Grade matrix', exact: false }).click()
    protection = await visible(page.getByRole('dialog', { name: 'Unsaved changes', exact: true }))
    await protection.getByRole('button', { name: 'Discard unsaved changes and leave', exact: true }).click()
    await visible(page.locator('.grade-matrix'))
    assert.equal((await (await fixture.request(`/api/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}`)).json()).sourceSet.decisions.some((decision) => decision.reason === 'Unsaved applicability review kept in this tab'), false)

    await page.locator('.workspace-switcher-trigger').click()
    switcher = await visible(page.getByRole('dialog', { name: 'My workspaces', exact: true }))
    await switcher.getByRole('button', { name: other.name, exact: true }).click()
    await visible(page.locator('.workspace-switcher-trigger').filter({ hasText: other.name }))
    await page.evaluate(() => history.back())
    await visible(page.getByRole('heading', { name: detail.ladder.name, exact: true }))
    await page.evaluate(() => history.forward())
    await visible(page.locator('.workspace-switcher-trigger').filter({ hasText: other.name }))
    assert.equal(fixture.requests.some((request) => request.url.endsWith('/state') && request.method !== 'GET'), false)
    assert.equal([...fixture.grades.store.values.values()].filter(({ record }) => record.recordType === 'grade-version').length, 2)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('viewer UI is read-only, private sources remain inspectable, and detail failures do not retry in a render loop', { timeout: 60000 }, async (t) => {
  const fixture = await startGradeFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  fixture.setRole('viewer')
  const { context, page, errors } = await newPage(fixture)
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}`)
    await visible(page.getByRole('heading', { name: detail.ladder.name, exact: true }))
    assert.equal(await page.getByRole('button', { name: 'Context / add grades', exact: true }).isDisabled(), true)
    assert.equal(await column(page, 9).getByRole('button', { name: 'Edit draft', exact: true }).isDisabled(), true)
    assert.equal(await column(page, 9).getByRole('button', { name: 'Approve supported version', exact: true }).isDisabled(), true)
    await page.locator('.grade-matrix').getByRole('button', { name: /Captured v1 · p. 178/ }).first().click()
    const inspector = await visible(page.getByRole('dialog', { name: 'Engineering test reference', exact: true }))
    await visible(inspector.getByText('Original page 178 of 204', { exact: true }))
    await inspector.getByRole('button', { name: 'Close source', exact: true }).click()
    const path = `/api/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}`
    fixture.staleRead(path, { error: { code: 'unavailable', message: 'Grade detail temporarily unavailable; retry explicitly.' } }, Promise.resolve(), 503)
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click()
    await visible(page.getByText(/Grade detail temporarily unavailable; retry explicitly./))
    const count = fixture.requests.filter((request) => request.method === 'GET' && request.url === path).length
    await page.waitForTimeout(500)
    assert.equal(fixture.requests.filter((request) => request.method === 'GET' && request.url === path).length, count)
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})

test('draft-only source work keeps polling and cold rubric links resolve to real grade history', { timeout: 90000 }, async (t) => {
  const fixture = await startGradeFixture(runtime, { injectAuth: true })
  t.after(() => fixture.close())
  const seeded = await seededLadder(fixture)
  const restore = fixture.installClientFetch()
  let detail
  try {
    detail = await runtime.client.uploadGradeSourcePdf(fixture.workspaceId, seeded.detail.ladder.id, await referencePdf(), randomUUID(), [178, 204])
  } finally { restore() }
  const pendingSource = detail.sources.find((source) => source.status === 'queued')
  assert.ok(pendingSource)
  assert.equal(detail.ladder.status, 'draft')
  assert.equal(detail.levels.every((level) => level.head.status === 'draft'), true)
  const { context, page, errors } = await newPage(fixture)
  try {
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}`)
    await visible(page.getByRole('heading', { name: detail.ladder.name, exact: true }))
    await page.getByRole('button', { name: /Sources & applicability/ }).click()
    const card = page.locator(`[data-source-id="${pendingSource.id}"]`)
    await visible(card)
    const listPath = `/api/workspaces/${fixture.workspaceId}/grade-ladders`
    const initialLists = fixture.requests.filter((request) => request.method === 'GET' && request.url === listPath).length
    await until(() => fixture.requests.filter((request) => request.method === 'GET' && request.url === listPath).length > initialLists, 'The pending extraction should trigger a polling cycle even though heads are drafts')
    await completeReference(fixture, detail, pendingSource.id)
    await until(() => card.getByRole('button', { name: 'Inspect captured source', exact: true }).isEnabled(), 'A second poll should observe completed extraction without manual refresh')
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/rubrics/${seeded.first.version.id}`)
    await visible(page.getByRole('heading', { name: 'GS-9 · immutable history', exact: true }))
    assert.match(page.url(), new RegExp(`/grade-ladders/${detail.ladder.id}`))
    await visible(page.getByRole('heading', { name: seeded.first.version.rubric.name, exact: true }))
    await page.goto(`${fixture.origin}/workspaces/${fixture.workspaceId}/analyses/new?${new URLSearchParams({ data: 'samples', rubrics: seeded.first.version.id })}`)
    await visible(page.getByText('Analyses', { exact: true }).first())
    await visible(page.getByText(/New real analyses are currently unavailable/))
    assert.equal(new URL(page.url()).searchParams.get('data'), 'samples', 'Legacy data parameters are ignored, not stripped from the URL')
    assert.deepEqual(errors, [])
  } finally { await context.close(); await fixture.close() }
})
