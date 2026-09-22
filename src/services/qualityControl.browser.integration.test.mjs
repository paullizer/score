import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createServer } from 'node:http'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../../tailwind.config.js'
import { createQcFixture, qcPlanDetail, qcProposal } from './qualityControl.test-support.mjs'

const output = resolve(`.qc-browser-tests-${randomUUID()}`)
let browser, server, origin
before(async () => {
  await mkdir(output)
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, { useRef, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { BrowserRouter } from 'react-router-dom'
    import { App } from './src/app/App'
    import { WorkspaceContext } from './src/app/workspace-context'
    import { ApplicationNavigationContext } from './src/app/application-navigation-context'
    import { GradeNavigationProtectionProvider, GradeRouterProtection } from './src/app/GradeNavigationProtection'
    import { frontendWorkspaceContext } from './src/services/frontend.test-support.mjs'
    function Harness() {
      const [role, setRole] = useState(window.qcHarness.role)
      const apiRef = useRef(null)
      window.revokeQcMembership = () => setRole('viewer')
      const context = frontendWorkspaceContext({ cloud: { currentWorkspaceId: 'workspace-one',
        workspaces: [{ id: 'workspace-one', name: 'Browser QC fixture', role, etag: '"workspace"' }] } })
      return <GradeNavigationProtectionProvider workspaceId="workspace-one" apiRef={apiRef}>
        <BrowserRouter basename="/workspaces/workspace-one" future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <GradeRouterProtection><WorkspaceContext.Provider value={context}>
            <ApplicationNavigationContext.Provider value={{ applicationAdmin: window.qcHarness.admin, openAdminSettings: async () => {} }}>
              <App />
            </ApplicationNavigationContext.Provider>
          </WorkspaceContext.Provider></GradeRouterProtection>
        </BrowserRouter>
      </GradeNavigationProtectionProvider>
    }
    createRoot(document.getElementById('root')).render(<Harness />)
  ` }, outfile: join(output, 'app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
  define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"', 'process.env.NODE_ENV': '"test"' } })
  const js = await readFile(join(output, 'app.js'))
  const importedCss = await readFile(join(output, 'app.css'))
  const globals = await postcss([tailwindcss(tailwindConfig), autoprefixer]).process(await readFile(join('src', 'styles', 'globals.css'), 'utf8'),
    { from: join('src', 'styles', 'globals.css') })
  const html = (await readFile('index.html', 'utf8')).replace('src="/src/main.tsx"', 'src="/app.js"')
    .replace('</head>', '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/app.css"></head>')
  server = createServer((request, response) => {
    if (request.url === '/app.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(js); return }
    if (request.url === '/app.css') { response.writeHead(200, { 'Content-Type': 'text/css' }); response.end(importedCss); return }
    if (request.url === '/styles.css') { response.writeHead(200, { 'Content-Type': 'text/css' }); response.end(globals.css); return }
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  try { browser = await chromium.launch({ headless: true, downloadsPath: join(output, 'downloads'), tracesDir: join(output, 'traces') }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true, downloadsPath: join(output, 'downloads'), tracesDir: join(output, 'traces') })
  }
})
after(async () => {
  await browser?.close()
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(output, { recursive: true, force: true })
})
async function setup(t, { role = 'reviewer', admin = false, mobile = false, submitted = false } = {}) {
  const fixture = createQcFixture({ role, admin, submitted })
  const context = await browser.newContext({ viewport: mobile ? { width: 430, height: 932 } : { width: 1440, height: 1000 }, colorScheme: mobile ? 'dark' : 'light' })
  t.after(() => context.close())
  await context.addInitScript(options => { window.qcHarness = options }, { role, admin })
  const page = await context.newPage()
  page.setDefaultTimeout(12_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, [], 'No browser render errors'))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const response = await fixture.fetch(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() ?? undefined })
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  })
  return { fixture, page, context }
}
const writeCalls = fixture => fixture.requests.filter(item => ['POST', 'PUT'].includes(item.method))
const go = (page, path) => page.goto(`${origin}/workspaces/workspace-one${path}`)

test('browser: reviewer drafts, explicit zero recommendation, protected navigation and peer unlock', async t => {
  const { page, fixture } = await setup(t)
  await go(page, '/qc/reviews/run-one/comparison-1')
  await page.getByRole('heading', { name: 'Review this saved comparison' }).waitFor()
  assert.equal(await page.getByRole('navigation', { name: 'Main navigation' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'New analysis', exact: true }).count(), 0)
  assert.equal(writeCalls(fixture).length, 0)
  assert.equal(fixture.requests.some(item => /\/peers|\/summaries|\/corrections/.test(item.url)), false)
  await page.getByLabel('Decision for Engineering methods', { exact: true }).selectOption('disagree')
  await page.getByRole('button', { name: 'Save incomplete draft' }).click()
  await page.getByText('Draft saved on the server. Incomplete rows remain incomplete.', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Submit complete comparison' }).isDisabled(), true)
  await page.getByLabel('Required explanation for Engineering methods', { exact: true }).fill('Private browser feedback about the frozen evidence.')
  await page.getByRole('button', { name: 'Normal mode', exact: true }).click()
  const guard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
  await guard.waitFor()
  await guard.getByRole('button', { name: 'Stay here', exact: true }).click()
  assert.equal(await page.getByLabel('Required explanation for Engineering methods', { exact: true }).inputValue(), 'Private browser feedback about the frozen evidence.')
  await page.getByLabel('Recommended rating or unscored disposition for Engineering methods', { exact: true }).selectOption('0')
  await page.getByRole('button', { name: 'Submit complete comparison' }).click()
  await page.getByText('Submission 1 is saved.', { exact: false }).waitFor()
  assert.equal(fixture.calls.submitted, 1)
  assert.equal(fixture.requests.some(item => item.url.endsWith('/peers')), false)
  await page.getByRole('button', { name: 'Load authorized peer feedback', exact: true }).click()
  await page.getByText('Independent peer · submission 1', { exact: false }).waitFor()
  assert.equal(fixture.requests.filter(item => item.url.endsWith('/peers')).length, 1)
  const exposedEtag = fixture.heads.get('comparison-1').etag
  await page.getByRole('button', { name: 'Revise my feedback', exact: true }).click()
  await page.getByLabel('Required explanation for Engineering methods', { exact: true }).fill('An explicitly peer-exposed follow-up.')
  await page.getByRole('button', { name: 'Save incomplete draft', exact: true }).click()
  await page.getByText('Draft saved on the server. Incomplete rows remain incomplete.', { exact: true }).waitFor()
  assert.equal(writeCalls(fixture).at(-1).headers.get('If-Match'), exposedEtag)
  const leaked = await page.evaluate(() => ({
    url: location.href, local: Object.keys(localStorage).map(key => localStorage.getItem(key)).join(' '),
    session: Object.keys(sessionStorage).map(key => sessionStorage.getItem(key)).join(' '),
  }))
  assert.doesNotMatch(JSON.stringify(leaked), /Private browser feedback|Applied engineering methods/)
})

test('browser: optional batch pins completed results in a partial run without gating normal work', async t => {
  const { page, fixture } = await setup(t, { role: 'owner' })
  await go(page, '/qc')
  await page.getByLabel('Saved real analysis', { exact: true }).selectOption('run-one')
  await page.getByLabel('Select exact result', { exact: true }).check()
  await page.getByLabel('Batch name', { exact: true }).fill('Pinned partial-run review')
  await page.getByRole('button', { name: 'Save named batch', exact: true }).click()
  await page.getByText('Pinned partial-run review · 1 exact results', { exact: true }).click()
  const batch = fixture.batchRecords[0].record
  assert.equal(batch.comparisons[0].comparisonId, 'comparison-1')
  assert.equal(batch.comparisons[0].resultRevision, 'original')
  assert.equal(batch.comparisons[0].resultSha256.length, 64)
  const link = page.locator(`a[href*="/qc/reviews/run-one/comparison-1"][href*="resultSha256="]`).first()
  assert.match(await link.getAttribute('href'), /resultRevision=original/)
  assert.equal(fixture.calls.paid, 0)
  await page.getByRole('button', { name: 'Normal mode', exact: true }).click()
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor()
  assert.ok(await page.getByRole('button', { name: 'New analysis', exact: true }).count())
})

test('browser: curate attributable feedback, save draft, and explicitly confirm paid plan work', async t => {
  const { page, fixture } = await setup(t, { role: 'owner' })
  await go(page, '/qc/improvements/new')
  await page.getByLabel('Plan name', { exact: true }).fill('Browser curation')
  await page.getByLabel('Improvement objective', { exact: true }).fill('Investigate scoped evidence interpretation.')
  await page.getByLabel('Saved real analysis', { exact: true }).selectOption('run-one')
  await page.getByLabel('Select exact result', { exact: true }).check()
  assert.equal(fixture.requests.some(item => item.url.endsWith('/peers')), false)
  await page.getByRole('button', { name: 'Load authorized feedback for this case', exact: true }).click()
  await page.getByLabel('Disposition of Independent peer revision 1', { exact: true }).selectOption('include')
  await page.getByText('Optional named human reference decisions', { exact: true }).click()
  await page.getByLabel('Record a named human reference for Engineering methods', { exact: true }).check()
  await page.getByLabel('Reference name for Engineering methods', { exact: true }).fill('Scope adjudication')
  await page.getByLabel('Reference score for Engineering methods', { exact: true }).selectOption('0')
  await page.getByLabel('Reference reason for Engineering methods', { exact: true }).fill('This is my explicit reference, not a majority vote.')
  await page.getByRole('button', { name: 'Save draft plan — no AI work', exact: true }).click()
  await page.getByRole('button', { name: 'Draft improvement plan', exact: true }).waitFor()
  assert.equal(fixture.calls.createdPlans, 1)
  assert.equal(fixture.calls.paid, 0)
  assert.equal(writeCalls(fixture).find(item => item.url.endsWith('/qc/plans')).body.cases[0].referenceDecisions[0].score, 0)
  await page.getByRole('button', { name: 'Draft improvement plan', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm paid plan drafting', exact: true })
  await dialog.waitFor()
  assert.equal(await dialog.getByRole('button', { name: 'Confirm paid QC work' }).isDisabled(), true)
  await dialog.getByLabel('I approve the displayed paid QC scope.', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Confirm paid QC work', exact: true }).click()
  await page.getByText('Plan drafting · queued', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Refresh saved status', exact: true }).click()
  assert.equal(fixture.calls.paid, 1)
  await page.getByRole('button', { name: 'Cancel QC work', exact: true }).click()
  await page.getByRole('button', { name: 'Resume / retry saved work', exact: true }).waitFor()
  assert.equal(fixture.calls.paid, 1)
})

test('browser: evaluated admin activation is explicit and mobile dark-mode revocation clears evidence', async t => {
  const { page, fixture } = await setup(t, { role: 'owner', admin: true, mobile: true })
  fixture.plans.set('plan-one', qcPlanDetail({ status: 'ready', proposal: qcProposal(), admin: true }))
  await go(page, '/qc/improvements/plan-one')
  await page.getByRole('button', { name: 'Review activation of evaluated revision 1', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Activate app-wide prompt guidance?', exact: true })
  await dialog.getByLabel('Required administrator rationale', { exact: true }).fill('Reviewed exact evaluation and the limited reference sample.')
  await dialog.getByLabel('I reviewed this evaluated revision and understand the app-wide FUTURE-work effect.', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Activate evaluated revision for FUTURE work', exact: true }).click()
  await page.getByText('The evaluated prompt release was activated for future newly accepted work.', { exact: true }).waitFor()
  assert.equal(fixture.calls.activated, 1)
  assert.equal(fixture.calls.paid, 0)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'QC forms fit the mobile viewport')
})

test('browser: exact paid trial scope includes holdouts and pinned evidence without mobile overflow', async t => {
  const { page, fixture } = await setup(t, { mobile: true })
  await page.setViewportSize({ width: 360, height: 800 })
  const proposal = qcProposal()
  proposal.changes.push({ familyId: 'jobRubric', guidance: 'Keep job expectations source-grounded.', reason: 'Clarify boundaries.' })
  const detail = qcPlanDetail({ proposal })
  detail.plan.cases[0].scope.runId = `run-${'r'.repeat(96)}`
  const holdout = structuredClone(detail.plan.cases[0])
  holdout.scope.comparisonId = `comparison-${'h'.repeat(96)}`
  holdout.purpose = 'holdout'
  detail.plan.cases.push(holdout)
  detail.trialScope = { pairs: [
    { scope: detail.plan.cases[0].scope, purpose: 'drafting', familyId: 'assessment' },
    { scope: detail.plan.cases[0].scope, purpose: 'drafting', familyId: 'jobRubric' },
    { scope: holdout.scope, purpose: 'holdout', familyId: 'assessment' },
  ], baselineTrials: 3, candidateTrials: 3, unsupportedFamilies: [] }
  fixture.plans.set('plan-one', detail)
  await go(page, '/qc/improvements/plan-one')
  await page.getByRole('button', { name: 'Run baseline / candidate trial', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm paid evaluation', exact: true })
  await dialog.getByText('Inspect exact compatible trial scope', { exact: true }).click()
  await dialog.locator('.qc-pin > summary').first().click()
  assert.match(await dialog.innerText(), /3 paired case\/family comparisons/)
  assert.match(await dialog.innerText(), /3 baseline trial executions and 3 candidate trial executions/)
  assert.match(await dialog.innerText(), /2 drafting pairs; 1 holdout pairs/)
  assert.match(await dialog.innerText(), /Trial executions are not model-call counts/)
  assert.equal(await dialog.getByRole('link').count(), 3)
  assert.match(await dialog.getByRole('link').last().getAttribute('href'), /resultRevision=original.*resultSha256=/)
  assert.equal(await dialog.locator('.qc-trial-scope').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true)
  assert.equal(fixture.calls.paid, 0)
  assert.equal(await dialog.getByRole('button', { name: 'Confirm paid QC work', exact: true }).isDisabled(), true)
  await dialog.getByLabel('I approve the displayed paid QC scope.', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Confirm paid QC work', exact: true }).click()
  await page.getByText('Baseline / candidate evaluation · queued', { exact: true }).waitFor()
  assert.equal(fixture.calls.paid, 1)
})

test('browser: frozen trial grounding is inspectable, fits mobile, and clears on access loss', async t => {
  const { page, fixture } = await setup(t, { mobile: true })
  const detail = qcPlanDetail({ status: 'ready', proposal: qcProposal() })
  detail.plan.proposal.changes[0].familyId = 'gradeDraft'
  const outcome = detail.evaluation.cases[0]
  outcome.familyId = 'gradeDraft'
  for (const variant of ['baseline', 'candidate']) {
    const citation = { documentId: `${variant}-source`, documentVersion: 2, paragraphId: `${variant}-paragraph`, page: 8,
      heading: `${variant} frozen heading`, quote: `${variant} frozen evidence token-${'x'.repeat(240)}` }
    Object.assign(outcome[variant], { reviewedCriteria: 0, exactAgreements: 0, absoluteDifference: 0,
      rubric: { description: `${variant} generated rubric`, criteria: [{ id: 'criterion-one', label: `${variant} independent meaning`,
        description: 'A separately generated source-grounded scope.', weight: 100, guidance: 'Saved scoring anchors.',
        sourceCitations: [citation], gradeBasis: [{ ...citation, quote: `${variant} exact grade basis` }], support: 'direct' }],
      qualifications: [{ id: 'qualification-one', text: `${variant} unscored requirement`, support: 'direct',
        interpretation: 'Keep this separate from numeric scores.', citations: [{ ...citation, quote: `${variant} qualification evidence` }] }],
      issues: [{ id: 'finding-one', code: 'source-boundary', severity: 'warning', scope: 'criterion', criterionId: 'criterion-one',
        message: `${variant} saved grounding finding`, citations: [{ ...citation, quote: `${variant} grounding finding evidence` }] }],
      warnings: [`${variant} retained source warning`] } })
  }
  fixture.plans.set('plan-one', detail)
  await go(page, '/qc/improvements/plan-one')
  for (const variant of ['baseline', 'candidate']) {
    const title = `${variant[0].toUpperCase()}${variant.slice(1)}`
    const trial = page.getByRole('region', { name: `${title} trial`, exact: true })
    await trial.getByText(`${title} generated rubric — independent criterion meanings`, { exact: true }).click()
    await trial.getByText(outcome[variant].rubric.criteria[0].sourceCitations[0].quote, { exact: true }).waitFor()
    await trial.getByText(`${variant} exact grade basis`, { exact: true }).waitFor()
    await trial.getByText(`${variant} qualification evidence`, { exact: true }).waitFor()
    await trial.getByText(`${variant} grounding finding evidence`, { exact: true }).waitFor()
    await trial.getByText(`${variant} retained source warning`, { exact: true }).waitFor()
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'Frozen citation text fits the mobile viewport')
  assert.equal(writeCalls(fixture).length, 0)
  await page.evaluate(() => window.revokeQcMembership())
  await page.getByRole('heading', { name: 'QC requires an authorized cloud workspace', exact: true }).waitFor()
  assert.doesNotMatch(await page.locator('body').innerText(), /frozen evidence token|qualification evidence|grounding finding evidence/)
})

test('browser: admission-off keeps saved QC tabs and cancellation without disabling normal mode', async t => {
  const { page, fixture } = await setup(t, { role: 'owner', mobile: true })
  fixture.admissionEnabled = false
  fixture.workerEnabled = false
  fixture.plans.set('plan-one', qcPlanDetail({ status: 'planning' }))
  await go(page, '/qc/improvements/plan-one')
  await page.getByText('This switch does not change normal workspace permissions.', { exact: false }).waitFor()
  const cancel = page.getByRole('button', { name: 'Cancel QC work', exact: true })
  assert.equal(await cancel.isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Draft improvement plan', exact: true }).isDisabled(), true)
  await cancel.click()
  await page.getByText('Plan drafting · cancelled', { exact: true }).waitFor()
  assert.equal(fixture.plans.get('plan-one').work.status, 'cancelled')
  await page.getByRole('navigation', { name: 'Quality control navigation', exact: true }).getByRole('link', { name: 'Prompt versions', exact: true }).click()
  await page.getByRole('button', { name: 'Compare release release-old', exact: true }).click()
  await page.getByText('Previous compatible assessment guidance.', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'Normal mode', exact: true }).click()
  await page.getByRole('button', { name: /^Samples/ }).click()
  await page.waitForURL(url => url.pathname.endsWith('/analyses') && url.searchParams.get('data') === 'samples')
  assert.equal(await page.getByRole('button', { name: 'New analysis', exact: true }).first().isEnabled(), true)
  assert.deepEqual(writeCalls(fixture).map(item => item.url.split('/').at(-1)), ['cancel'])
  assert.equal(fixture.calls.paid, 0)
})

test('browser: member revocation aborts the private workspace view including unsaved review text', async t => {
  const { page } = await setup(t, { mobile: true })
  await go(page, '/qc/reviews/run-one/comparison-1')
  await page.getByLabel('Decision for Engineering methods', { exact: true }).selectOption('agree')
  await page.getByLabel('Optional comment for Engineering methods', { exact: true }).fill('Private unsaved explanation')
  await page.evaluate(() => window.revokeQcMembership())
  await page.getByRole('heading', { name: 'QC requires an authorized cloud workspace', exact: true }).waitFor()
  assert.doesNotMatch(await page.locator('body').innerText(), /Private unsaved explanation|Jordan Example|frozen passage|Engineering methods/)
})
