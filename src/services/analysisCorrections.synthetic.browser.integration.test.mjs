import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../../tailwind.config.js'
import {
  correctionFixture, correctionPreview, correctionSummary, correctionHistory, publishCorrectionFixture,
} from './analysisCorrections.synthetic.test-support.mjs'

const output = resolve(`.correction-browser-tests-${randomUUID()}`)
let browser, server, origin
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function until(check, message) {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(20)
  }
  assert.fail(message)
}
before(async () => {
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React, { useCallback, useRef, useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { MemoryRouter } from 'react-router-dom'
      import { RealAnalysesContext } from './src/app/real-analyses-context'
      import { WorkspaceContext } from './src/app/workspace-context'
      import { RealAnalysisDetail } from './src/features/analyses/RealAnalysisDetail'
      import { getRealAnalysis, getRealAnalysisComparison, listAllRealAnalysisComparisons } from './src/services/realAnalyses'
      import { frontendWorkspaceContext } from './src/services/frontend.test-support.mjs'
      function Harness() {
        const [fixture, setFixture] = useState(window.syntheticFixture)
        const [enabled, setEnabled] = useState(window.syntheticFeature)
        const [switched, setSwitched] = useState(false)
        const [role, setRole] = useState(window.syntheticRole)
        const current = useRef(fixture)
        current.current = fixture
        window.switchFixtureWorkspace = () => setSwitched(true)
        window.disableFixtureCorrections = () => setEnabled(false)
        const ensureDetail = useCallback(async (runId, force) => {
          if (!force) return
          window.refreshCalls.push({ kind: 'run', runId })
          const value = await getRealAnalysis(current.current.workspaceId, runId)
          setFixture(previous => ({ ...previous, summary: { run: value.run, etag: value.etag }, detail: value }))
        }, [])
        const ensureComparisons = useCallback(async (runId, force) => {
          if (!force) return
          window.refreshCalls.push({ kind: 'pairs', runId })
          const values = await listAllRealAnalysisComparisons(current.current.workspaceId, runId)
          setFixture(previous => ({ ...previous, details: previous.details.map(detail => {
            const next = values.find(value => value.comparison.id === detail.comparison.id)
            return next ? { ...detail, ...next } : detail
          }) }))
        }, [])
        const ensureComparison = useCallback(async (runId, comparisonId, force) => {
          if (!force) return
          window.refreshCalls.push({ kind: 'detail', runId, comparisonId })
          const value = await getRealAnalysisComparison(current.current.workspaceId, runId, comparisonId)
          setFixture(previous => ({ ...previous, details: previous.details.map(item => item.comparison.id === comparisonId ? value : item) }))
        }, [])
        const context = frontendWorkspaceContext({
          cloud: { currentWorkspaceId: fixture.workspaceId,
            workspaces: [{ id: fixture.workspaceId, role, name: 'Synthetic workspace' }] },
          notify: text => window.notifications.push(text),
        }, { analyses: [fixture.summary] })
        const api = {
          workspaceId: fixture.workspaceId, canWrite: role !== 'viewer', canReviewSummaries: role !== 'viewer',
          phase: 'ready', features: { realAnalyses: false, analysisEvidenceCorrections: enabled },
          error: null, creationError: null, summaries: [fixture.summary], targets: { state: 'ready', value: fixture.targets },
          detail: () => ({ state: 'ready', value: fixture.detail }), comparisons: () => ({ state: 'ready', value: fixture.details }),
          comparison: (runId, comparisonId) => {
            const value = fixture.details.find(item => item.comparison.id === comparisonId)
            return value ? { state: 'ready', value } : { state: 'idle' }
          },
          ensureDetail, ensureComparisons, ensureComparison,
          refresh: async () => { throw new Error('Corrections must not refresh the entire workspace.') },
          refreshTargets: async () => { throw new Error('Corrections must not refresh target summaries.') },
          pending: () => false,
          narratives: () => ({ state: 'idle' }),
          ensureNarratives: async () => { throw new Error('Corrections must not fetch full-target narratives.') },
        }
        const result = new URLSearchParams(location.search).has('result') ? '&result=' + fixture.details[0].comparison.id : ''
        return <MemoryRouter initialEntries={['/analyses/' + fixture.summary.run.id + '?data=real' + result]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <WorkspaceContext.Provider value={context}><RealAnalysesContext.Provider value={api}>
            <button onClick={() => setEnabled(false)}>Disable fixture corrections</button>
            <button onClick={() => setRole('viewer')}>Revoke fixture editor access</button>
            {switched ? <p>Switched fixture workspace</p> : <RealAnalysisDetail id={fixture.summary.run.id} />}
          </RealAnalysesContext.Provider></WorkspaceContext.Provider>
        </MemoryRouter>
      }
      window.refreshCalls = []
      window.notifications = []
      createRoot(document.getElementById('root')).render(<Harness />)
    ` },
    outfile: join(output, 'app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"', 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'unrelated-narrative-export-boundary',
      setup(builder) {
        builder.onResolve({ filter: /\/(AnalysisSummaries|AnalysisReportExport)$/ }, () => ({ path: 'boundary', namespace: 'correction-fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'correction-fixture' }, () => ({ loader: 'js', contents: `
          export const ManageAnalysisSummaries = () => null
          export const RealTargetNarrative = () => null
          export const RealCandidateNarrative = () => null
          export const AnalysisReportExport = () => null
        ` }))
      },
    }],
  })
  const js = await readFile(join(output, 'app.js'))
  const css = await postcss([tailwindcss(tailwindConfig), autoprefixer]).process(
    await readFile(join('src', 'styles', 'globals.css'), 'utf8'), { from: join('src', 'styles', 'globals.css') },
  )
  const html = (await readFile('index.html', 'utf8')).replace('src="/src/main.tsx"', 'src="/app.js"')
    .replace('</head>', '<link rel="stylesheet" href="/styles.css"></head>')
  server = createServer((request, response) => {
    if (request.url === '/app.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(js); return }
    if (request.url === '/styles.css') { response.writeHead(200, { 'Content-Type': 'text/css' }); response.end(css.css); return }
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  }
})
after(async () => {
  await browser?.close()
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(output, { recursive: true, force: true })
})

async function setup(t, { fixture = correctionFixture(), role = 'owner', feature = true, result = false, initialCorrectionStatus } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  t.after(() => context.close())
  await context.addInitScript(({ fixture, role, feature }) => {
    window.syntheticFixture = fixture
    window.syntheticRole = role
    window.syntheticFeature = feature
    const timeout = window.setTimeout.bind(window)
    window.setTimeout = (callback, delay, ...args) => timeout(callback, delay === 3000 ? 180 : delay, ...args)
  }, { fixture, role, feature })
  const page = await context.newPage()
  page.setDefaultTimeout(12_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, []))
  const state = {
    fixture, requests: [], heads: new Map(), histories: new Map(), blocked: new Set(), previewFailures: new Set(),
    beforePreview: null, onPost: null, onStatus: null, activePreviews: 0, maxPreviews: 0, activePosts: 0, maxPosts: 0,
    comparisonReadFailures: 0,
  }
  if (initialCorrectionStatus) {
    const id = fixture.details[0].comparison.id
    state.heads.set(id, correctionSummary(fixture, id, { status: initialCorrectionStatus }))
  }
  const base = `/api/workspaces/${fixture.workspaceId}/analyses/${fixture.summary.run.id}`
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const record = { path: url.pathname, method: request.method(), headers: request.headers(),
      body: request.postData() ? request.postDataJSON() : null, cursor: url.searchParams.get('continuationToken') }
    state.requests.push(record)
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === base) return respond({ ...fixture.detail, ...fixture.summary })
    if (url.pathname === `${base}/comparisons`) {
      if (state.comparisonReadFailures-- > 0) return respond({ error: {
        code: 'unavailable', message: 'Synthetic current scores unavailable.',
      } }, 503)
      return respond({ comparisons: fixture.details.map(({ comparison, etag }) => ({ comparison, etag })) })
    }
    const match = url.pathname.match(/\/comparisons\/([^/]+)(.*)$/)
    if (!match) return respond({ error: { code: 'invalid_request', message: 'Unexpected synthetic fixture request.' } }, 400)
    const [, comparisonId, suffix] = match
    if (!suffix) return respond(fixture.details.find(item => item.comparison.id === comparisonId))
    if (suffix === '/corrections/preview') {
      state.activePreviews++
      state.maxPreviews = Math.max(state.maxPreviews, state.activePreviews)
      try {
        if (state.beforePreview) await state.beforePreview(comparisonId)
        if (state.previewFailures.has(comparisonId)) return await respond({ error: { code: 'unavailable', message: 'Synthetic preview unavailable; this comparison was not skipped.' } }, 503)
        return await respond(correctionPreview(fixture, comparisonId, { correction: state.heads.get(comparisonId), blocked: state.blocked.has(comparisonId) }))
      } finally { state.activePreviews-- }
    }
    if (suffix === '/corrections' && record.method === 'GET') {
      if (state.onStatus) await state.onStatus(comparisonId)
      return respond({ correction: state.heads.get(comparisonId) ?? null })
    }
    if (suffix === '/corrections' && record.method === 'POST') {
      state.activePosts++
      state.maxPosts = Math.max(state.maxPosts, state.activePosts)
      try {
        if (state.onPost && await state.onPost({ route, record, comparisonId, respond })) return
        const key = record.headers['idempotency-key']
        const correction = correctionSummary(fixture, comparisonId, { requestId: key, reason: record.body.reason })
        state.heads.set(comparisonId, correction)
        return await respond({ requestId: key, correction }, 202)
      } finally { state.activePosts-- }
    }
    if (suffix === '/corrections/cancel') {
      const previous = state.heads.get(comparisonId)
      assert.equal(record.headers['if-match'], previous.etag)
      const correction = { ...previous, status: 'cancelled', etag: '"synthetic-cancelled"', hasHistory: true }
      state.heads.set(comparisonId, correction)
      return respond({ requestId: correction.requestId, correction })
    }
    if (suffix === '/corrections/history') return respond(state.histories.get(comparisonId) ?? {
      ...correctionHistory(fixture, comparisonId), correction: state.heads.get(comparisonId) ?? null, entries: [],
    })
    return respond({ error: { code: 'invalid_request', message: 'Unexpected synthetic endpoint.' } }, 400)
  })
  await page.goto(`${origin}/${result ? '?result=1' : ''}`)
  await page.getByRole('heading', { name: 'Synthetic correction review', exact: true }).waitFor()
  return { page, state }
}

const postRequests = state => state.requests.filter(request => request.method === 'POST' && request.path.endsWith('/corrections'))
async function openReview(page, single = false) {
  await page.getByRole('button', { name: single ? /^(Review this withheld score|Manage current correction)$/ : /^Review withheld scores \(/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Review withheld scores', exact: true })
  await dialog.waitFor()
  await until(async () => await dialog.getByText('Loading read-only preview…', { exact: true }).count() === 0, 'Previews should finish.')
  return dialog
}
async function confirm(dialog, count) {
  await dialog.getByRole('checkbox', { name: /^I reviewed all/ }).check()
  await dialog.getByRole('button', { name: `Confirm review for ${count} ${count === 1 ? 'comparison' : 'comparisons'}`, exact: true }).click()
}

test('run action reviews all available withheld comparisons beyond 25, limits preview concurrency, and discloses every blocked or failed item without writing', async t => {
  const { page, state } = await setup(t, { fixture: correctionFixture({ withheld: 31, numeric: 2, failed: 1 }) })
  state.blocked.add('synthetic-comparison-2')
  state.previewFailures.add('synthetic-comparison-3')
  state.beforePreview = () => pause(15)
  await page.getByRole('searchbox', { name: 'Search comparisons' }).fill('source 31')
  const dialog = await openReview(page)
  assert.match(await dialog.innerText(), /Exact scope: 31 currently available withheld comparisons/)
  assert.match(await dialog.innerText(), /29 selected · 0 loading previews · 1 without selectable criteria · 1 with errors/)
  assert.equal(await dialog.locator('section[aria-label^="Correction review:"]').count(), 31)
  assert.equal(state.requests.filter(item => item.path.endsWith('/preview')).length, 31)
  assert.equal(state.maxPreviews, 2)
  assert.equal(postRequests(state).length, 0)
  assert.match(await dialog.innerText(), /genuine source-quality blocker/)
  assert.match(await dialog.innerText(), /Synthetic preview unavailable; this comparison was not skipped/)
  assert.equal(await dialog.getByRole('button', { name: 'Confirm review for 29 comparisons', exact: true }).isEnabled(), false)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  assert.equal(postRequests(state).length, 0)
})

test('ambiguous single requests retain exact key, ETag and reason across closing and reopening; cancellation uses its acknowledged head', async t => {
  const { page, state } = await setup(t, { result: true, role: 'editor' })
  let first = true
  state.onPost = async ({ route }) => {
    if (!first) return false
    first = false
    await route.abort('failed')
    return true
  }
  let dialog = await openReview(page, true)
  await confirm(dialog, 1)
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).waitFor()
  const original = postRequests(state)[0]
  assert.equal(await page.locator('.overall-score strong').first().innerText(), 'Score withheld')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  dialog = await openReview(page, true)
  await dialog.getByLabel('Reason recorded in the audit history').fill('An edited reason must not replace the immutable interrupted request.')
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click()
  await dialog.getByText('Correction queued', { exact: true }).waitFor()
  const replay = postRequests(state)[1]
  assert.equal(replay.headers['idempotency-key'], original.headers['idempotency-key'])
  assert.equal(replay.headers['if-match'], original.headers['if-match'])
  assert.deepEqual(replay.body, original.body)
  await dialog.getByRole('button', { name: 'Cancel correction', exact: true }).click()
  await dialog.getByText('Correction cancelled — not published', { exact: true }).waitFor()
  assert.equal(state.requests.filter(item => item.path.endsWith('/cancel')).length, 1)
  assert.equal(postRequests(state).length, 2)
  assert.equal(state.fixture.details[0].result.overall.status, 'withheld')
})

test('only verified publication refreshes the run, pair list and affected detail; zero and retained history remain visible with writes gated off', async t => {
  const { page, state } = await setup(t, { result: true })
  const comparisonId = state.fixture.details[0].comparison.id
  const originalHash = state.fixture.details[0].comparison.result.sha256
  const untouched = structuredClone(state.fixture.details.slice(1))
  let polls = 0
  state.onStatus = async id => {
    const previous = state.heads.get(id)
    if (!previous || !['queued', 'running'].includes(previous.status)) return
    polls++
    const next = correctionSummary(state.fixture, id, {
      requestId: previous.requestId, reason: previous.reason, status: polls < 3 ? 'running' : 'ready',
    })
    state.heads.set(id, next)
    if (next.status === 'ready') {
      state.histories.set(id, correctionHistory(state.fixture, id, { status: 'ready', correction: next }))
      publishCorrectionFixture(state.fixture, next)
    }
  }
  const dialog = await openReview(page, true)
  assert.deepEqual(await page.evaluate(() => window.refreshCalls), [])
  await confirm(dialog, 1)
  await dialog.getByText('Correction published', { exact: true }).waitFor()
  await until(async () => (await page.evaluate(() => window.refreshCalls)).filter(item => item.kind === 'detail').length === 1, 'Publication must refresh the open detail.')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByText('Current reviewed correction revision', { exact: true }).waitFor()
  assert.equal(await page.locator('.overall-score .score strong').innerText(), '0')
  assert.equal(await page.locator('.criterion-score strong').first().innerText(), '0')
  assert.deepEqual(state.fixture.details.slice(1), untouched)
  const refreshes = await page.evaluate(() => window.refreshCalls)
  assert.deepEqual(refreshes.map(item => item.kind).sort(), ['detail', 'pairs', 'run'])
  assert.equal(refreshes.find(item => item.kind === 'detail').comparisonId, comparisonId)
  assert.equal(state.requests.some(item => item.path.includes('/summaries')), false)
  await page.getByRole('button', { name: 'Disable fixture corrections', exact: true }).click()
  await page.getByRole('button', { name: 'Original result and correction history', exact: true }).click()
  const history = page.getByRole('region', { name: 'Private original result and correction history', exact: true })
  await history.getByText('Published reviewed revision', { exact: true }).waitFor()
  assert.match(await history.innerText(), /Original saved score[\s\S]*Score withheld/)
  assert.match(await history.innerText(), new RegExp(originalHash))
  assert.match(await history.innerText(), /Published server total[\s\S]*0/)
  await history.getByText('Full original rationale and saved evidence', { exact: true }).click()
  assert.match(await history.innerText(), /Original immutable scoring explanation/)
  assert.match(await history.innerText(), /The reviewed synthetic source does not document the required professional practice/)
  assert.match(await history.innerText(), /Original requirement evidence — not applicant evidence/)
  assert.equal((await history.innerText()).includes('private/frozen.json'), false)
  assert.equal(postRequests(state).length, 1)
})

test('a published correction can refresh its score after a transient read failure without replaying the mutation', async t => {
  const { page, state } = await setup(t, { fixture: correctionFixture({ withheld: 1, numeric: 0, failed: 0 }) })
  state.comparisonReadFailures = 1
  state.onStatus = async id => {
    const previous = state.heads.get(id)
    if (previous?.status !== 'queued') return
    const correction = correctionSummary(state.fixture, id, { status: 'ready', requestId: previous.requestId, reason: previous.reason })
    state.heads.set(id, correction)
    publishCorrectionFixture(state.fixture, correction)
  }
  const dialog = await openReview(page)
  await confirm(dialog, 1)
  await dialog.getByText(/Correction publication is confirmed, but the current score view could not refresh/).waitFor()
  await dialog.getByRole('button', { name: 'Check correction status', exact: true }).click()
  await until(async () => (await page.evaluate(() => window.refreshCalls.filter(item => item.kind === 'detail').length)) === 1,
    'Checking the published status must retry failed score reads.')
  assert.equal(await dialog.getByText(/Correction publication is confirmed, but the current score view could not refresh/).count(), 0)
  assert.equal((await page.evaluate(() => window.refreshCalls.filter(item => item.kind === 'pairs').length)), 2)
  assert.equal(postRequests(state).length, 1)
})

test('capability, role and lifecycle gates block writes while owner/editor history remains independent of the deployment gate', async t => {
  for (const options of [
    { feature: false }, { feature: null }, { role: 'viewer' }, { fixture: correctionFixture({ archived: true }) },
  ]) {
    await t.test(JSON.stringify(options.role ?? options.feature ?? 'archived-or-missing'), async child => {
      const { page, state } = await setup(child, { ...options, result: true })
      assert.equal(await page.getByRole('button', { name: 'Review this withheld score', exact: true }).isEnabled(), false)
      assert.equal(await page.getByRole('button', { name: /^Review withheld scores \(/ }).isEnabled(), false)
      const historyButton = page.getByRole('button', { name: 'Original result and correction history', exact: true })
      if (options.role === 'viewer') assert.equal(await historyButton.count(), 0)
      else {
        await historyButton.click()
        await page.getByText('No correction attempts are recorded. The original result remains unchanged.', { exact: true }).waitFor()
      }
      assert.equal(postRequests(state).length, 0)
      assert.equal(state.requests.some(item => item.path.endsWith('/preview')), false)
    })
  }
})

test('the new-request capability never disables authorized cancellation of existing work or its management entry point', async t => {
  for (const status of ['queued', 'running']) await t.test(`flag off with ${status} work`, async child => {
    const { page, state } = await setup(child, { feature: false, role: 'editor', result: true, initialCorrectionStatus: status })
    await page.getByRole('button', { name: 'Manage current correction', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^Review withheld scores \(/ }).isEnabled(), false)
    assert.equal(await page.getByRole('button', { name: 'Original result and correction history', exact: true }).isEnabled(), true)
    const dialog = await openReview(page, true)
    assert.match(await dialog.innerText(), /New evidence-gap correction requests are not enabled/)
    assert.equal(await dialog.getByRole('button', { name: 'Confirm review for 0 comparisons', exact: true }).isEnabled(), false)
    const cancel = dialog.getByRole('button', { name: 'Cancel correction', exact: true })
    assert.equal(await cancel.isEnabled(), true)
    await cancel.click()
    await dialog.getByText('Correction cancelled — not published', { exact: true }).waitFor()
    assert.equal(postRequests(state).length, 0)
    assert.equal(state.requests.filter(item => item.path.endsWith('/cancel')).length, 1)
  })
  await t.test('flag changes while the review is open', async child => {
    const { page, state } = await setup(child, { result: true })
    const dialog = await openReview(page, true)
    await confirm(dialog, 1)
    await dialog.getByText('Correction queued', { exact: true }).waitFor()
    await page.evaluate(() => window.disableFixtureCorrections())
    await dialog.getByText('New evidence-gap correction requests are not enabled. Existing status, authorized cancellation, and history remain available.', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Cancel correction', exact: true }).click()
    await dialog.getByText('Correction cancelled — not published', { exact: true }).waitFor()
    assert.equal(postRequests(state).length, 1)
    assert.equal(state.requests.filter(item => item.path.endsWith('/cancel')).length, 1)
  })
  await t.test('a failed preview cannot hide already known cancellation controls', async child => {
    const { page, state } = await setup(child, { feature: false, result: true, initialCorrectionStatus: 'queued' })
    state.previewFailures.add(state.fixture.details[0].comparison.id)
    await page.getByRole('button', { name: 'Manage current correction', exact: true }).waitFor()
    const dialog = await openReview(page, true)
    assert.match(await dialog.innerText(), /Synthetic preview unavailable/)
    await dialog.getByRole('button', { name: 'Cancel correction', exact: true }).click()
    await dialog.getByText('Correction cancelled — not published', { exact: true }).waitFor()
    assert.equal(postRequests(state).length, 0)
  })
  await t.test('archived work remains read-only even when its status is active', async child => {
    const { page, state } = await setup(child, {
      feature: false, result: true, fixture: correctionFixture({ archived: true }), initialCorrectionStatus: 'queued',
    })
    await page.getByRole('button', { name: 'Manage current correction', exact: true }).waitFor()
    const dialog = await openReview(page, true)
    assert.equal(await dialog.getByRole('button', { name: 'Cancel correction', exact: true }).isEnabled(), false)
    assert.equal(state.requests.some(item => item.method === 'POST'), false)
  })
})

test('partial scheduling reports exact per-item outcomes; a known failed review requires a fresh preview and a new explicit key', async t => {
  const { page, state } = await setup(t, { fixture: correctionFixture({ withheld: 3, numeric: 1, failed: 1 }) })
  state.onPost = async ({ comparisonId, respond }) => {
    await pause(20)
    if (comparisonId === 'synthetic-comparison-2') { await respond({ error: { code: 'conflict', message: 'Synthetic stale correction preview.' } }, 409); return true }
    if (comparisonId === 'synthetic-comparison-3') { await respond({ error: { code: 'unavailable', message: 'Synthetic acknowledgement unavailable.' } }, 503); return true }
    return false
  }
  state.onStatus = async id => {
    const previous = state.heads.get(id)
    if (previous?.status === 'queued') {
      const failed = correctionSummary(state.fixture, id, { status: 'failed', requestId: previous.requestId, reason: previous.reason })
      state.heads.set(id, failed)
      state.histories.set(id, correctionHistory(state.fixture, id, { correction: failed }))
    }
  }
  const dialog = await openReview(page)
  await confirm(dialog, 3)
  await dialog.getByText('Submission receipt: 1 of 3 selected correction requests acknowledged. 2 not acknowledged; inspect each outcome below. An acknowledgement schedules review, not publication.', { exact: true }).waitFor()
  await dialog.getByText('Correction failed — not published', { exact: true }).waitFor()
  assert.equal(state.maxPosts, 2)
  assert.equal(postRequests(state).length, 3)
  assert.equal(new Set(postRequests(state).map(item => item.headers['idempotency-key'])).size, 3)
  const firstKey = postRequests(state)[0].headers['idempotency-key']
  const first = dialog.locator('section[aria-label^="Correction review: Synthetic source 1 "]')
  assert.equal(await first.getByRole('checkbox').isEnabled(), false)
  await first.getByRole('button', { name: 'Load fresh preview', exact: true }).click()
  await until(async () => await first.getByRole('checkbox').isEnabled(), 'A new request must require the fresh failed-head preview.')
  await confirm(dialog, 1)
  await until(() => postRequests(state).length === 4, 'Only one new request should be sent.')
  assert.notEqual(postRequests(state)[3].headers['idempotency-key'], firstKey)
  assert.equal(state.fixture.details[0].comparison.resultSummary.overall.status, 'withheld')
  assert.deepEqual(await page.evaluate(() => window.refreshCalls), [])
})

test('closing a run modal stops status timers; a workspace change aborts previews and prevents queued work from leaking', async t => {
  await t.test('poll cleanup', async child => {
    const { page, state } = await setup(child, { fixture: correctionFixture({ withheld: 1, numeric: 0, failed: 0 }) })
    const dialog = await openReview(page)
    await confirm(dialog, 1)
    await dialog.getByText('Correction queued', { exact: true }).waitFor()
    await until(() => state.requests.some(item => item.method === 'GET' && item.path.endsWith('/corrections')), 'Queued work should poll its cheap status endpoint.')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const count = state.requests.length
    await pause(450)
    assert.equal(state.requests.length, count)
    assert.equal(postRequests(state).length, 1)
  })
  await t.test('context cleanup', async child => {
    const { page, state } = await setup(child, { fixture: correctionFixture({ withheld: 8, numeric: 0, failed: 0 }) })
    let release
    const held = new Promise(resolve => { release = resolve })
    state.beforePreview = () => held
    await page.getByRole('button', { name: /^Review withheld scores \(/ }).click()
    await until(() => state.activePreviews === 2, 'Only two previews should be in flight.')
    await page.evaluate(() => window.switchFixtureWorkspace())
    await page.getByText('Switched fixture workspace', { exact: true }).waitFor()
    release()
    await pause(300)
    assert.equal(state.requests.filter(item => item.path.endsWith('/preview')).length, 2)
    assert.equal(postRequests(state).length, 0)
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.notifications), [])
  })
})
