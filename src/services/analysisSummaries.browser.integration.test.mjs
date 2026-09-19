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
  analysisSummaryFixture, candidateNarrativeText, summaryResponse, summaryRunId, summaryTimestamp, summaryWorkspaceId,
} from './analysisSummaries.test-support.mjs'

const output = resolve(`.summary-browser-tests-${randomUUID()}`)
let browser, server, origin
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function visible(locator) {
  try { await locator.waitFor({ state: 'visible' }); return locator }
  catch (error) {
    throw new Error(`${error.message}\nVisible fixture content:\n${await locator.page().locator('body').innerText()}`, { cause: error })
  }
}
async function until(check, message) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(message)
}
before(async () => {
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { MemoryRouter } from 'react-router-dom'
      import { RealAnalysesBridge } from './src/app/RealAnalysesBridge'
      import { useRealAnalyses } from './src/app/real-analyses-context'
      import { WorkspaceContext } from './src/app/workspace-context'
      import { RealAnalysisDetail } from './src/features/analyses/RealAnalysisDetail'
      import { AnalysisReportExport } from './src/features/analyses/AnalysisReportExport'
      import { frontendWorkspaceContext } from './src/services/frontend.test-support.mjs'
      import { createInitialWorkspace } from './src/data/fixtures'
      function Probe() {
        const api = useRealAnalyses()
        return <button onClick={() => void api.refresh()}>Refresh fixture history</button>
      }
      function Harness() {
        const [workspaceId, setWorkspaceId] = useState('workspace-one')
        const context = frontendWorkspaceContext({ cloud: { currentWorkspaceId: workspaceId,
          workspaces: [{ id: workspaceId, role: window.fixtureRole || 'owner', name: workspaceId }] } })
        const sample = new URLSearchParams(window.location.search).has('sample')
        return <MemoryRouter initialEntries={['/analyses/run-one?data=real' + (new URLSearchParams(window.location.search).has('result') ? '&result=comparison-1' : '')]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <WorkspaceContext.Provider value={context}>
            <button onClick={() => setWorkspaceId('workspace-two')}>Switch fixture workspace</button>
            {sample ? <AnalysisReportExport source={{ kind: 'sample', run: createInitialWorkspace().runs[0], available: true }} />
              : <RealAnalysesBridge workspaceId={workspaceId}><Probe /><RealAnalysisDetail id="run-one" /></RealAnalysesBridge>}
          </WorkspaceContext.Provider>
        </MemoryRouter>
      }
      window.reportEvents = []
      createRoot(document.getElementById('root')).render(<Harness />)
    ` },
    outfile: join(output, 'app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"', 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'report-boundary-observer',
      setup(build) {
        build.onResolve({ filter: /services\/analysisReports\/(real|client)$/ }, ({ path }) => ({
          path: path.endsWith('/real') ? 'real' : 'client', namespace: 'report-observer',
        }))
        build.onLoad({ filter: /.*/, namespace: 'report-observer' }, ({ path }) => ({
          loader: 'js',
          contents: path === 'real' ? `
            export async function loadRealAnalysisReport(workspaceId, runId, options) {
              options.signal.throwIfAborted()
              window.reportEvents.push({ event: 'load', workspaceId, runId, requireSummaries: options.requireSummaries === true, targetId: options.targetId })
              return { id: runId, name: 'Fixture report' }
            }
            export async function assertRealAnalysisReportNarrativesCurrent(workspaceId, runId, report, signal) {
              signal.throwIfAborted()
              window.reportEvents.push({ event: 'assert', workspaceId, runId })
              if (window.failReportFence) throw new Error('Selected summary revisions changed before download.')
            }
          ` : `
            export async function generateReportInWorker(report, format, options) {
              options.signal.throwIfAborted()
              window.reportEvents.push({ event: 'worker', format })
              if (window.holdReportWorker) await new Promise((resolve, reject) => {
                window.releaseReportWorker = resolve
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
              })
              options.signal.throwIfAborted()
              return new Uint8Array([1, 2, 3])
            }
            export function downloadAnalysisReport(bytes, report, format, signal) {
              signal.throwIfAborted()
              window.reportEvents.push({ event: 'download', format })
              return 'fixture.' + format
            }
          `,
        }))
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
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  }
})
after(async () => {
  await browser?.close()
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await rm(output, { recursive: true, force: true })
})

async function setup(t, {
  role = 'owner', archived = false, secondStatus = 'complete', summaryOptions = {}, result = false, sample = false,
  features = { realAnalyses: false, analysisSummaryGeneration: true },
} = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  t.after(() => context.close())
  await context.addInitScript(({ role }) => {
    window.fixtureRole = role
    const interval = window.setInterval.bind(window)
    window.setInterval = (callback, delay, ...args) => interval(callback, delay === 3000 ? 150 : delay, ...args)
  }, { role })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, []))
  const fixture = analysisSummaryFixture({ archived, secondStatus })
  const state = {
    fixture, requests: [], options: { ...summaryOptions }, beforeGet: null, onPost: null,
    summary(targetId) {
      return summaryResponse(fixture, {
        ...state.options, targetId,
        ...(role === 'viewer' ? { canGenerate: false, reason: 'read-only' } : {}),
        ...(archived ? { canGenerate: false, reason: 'archived' } : {}),
      })
    },
    generation(input) {
      state.options.states ??= {}
      for (const { comparison } of fixture.details) {
        if (comparison.status !== 'complete' || (input.targetId && comparison.target.summary.id !== input.targetId)) continue
        const current = state.summary(input.targetId ?? null).comparisons.find((item) => item.comparisonId === comparison.id)
        if (input.mode === 'all' || current.status !== 'ready') state.options.states[comparison.id] = { status: 'queued', previous: Boolean(current.published) }
      }
      for (const target of fixture.targets) if (!input.targetId || target.id === input.targetId) {
        const current = state.summary(input.targetId ?? null).targets.find((item) => item.targetId === target.id)
        state.options.states[target.id] = { status: 'waiting', previous: Boolean(current.published) }
      }
    },
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const record = { path: url.pathname, targetId: url.searchParams.get('targetId'), method: request.method(),
      headers: request.headers(), body: request.postData() ? request.postDataJSON() : null }
    state.requests.push(record)
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/features') return respond(features)
    if (url.pathname.startsWith('/api/workspaces/workspace-two/')) {
      return url.pathname.endsWith('/analyses') ? respond({ runs: [] }) : respond({ error: { code: 'not_found', message: 'No saved analysis in the new workspace.' } }, 404)
    }
    const base = `/api/workspaces/${summaryWorkspaceId}/analyses`
    if (url.pathname === base) return respond({ runs: [fixture.summary] })
    if (url.pathname === `${base}/${summaryRunId}`) return respond({ ...fixture.detail, ...fixture.summary })
    if (url.pathname === `${base}/${summaryRunId}/comparisons`) return respond({ comparisons: fixture.details })
    const comparison = fixture.details.find(({ comparison }) => url.pathname === `${base}/${summaryRunId}/comparisons/${comparison.id}`)
    if (comparison) return respond(comparison)
    if (url.pathname === `${base}/${summaryRunId}/summaries`) {
      if (record.method === 'GET') {
        const value = state.summary(record.targetId)
        await state.beforeGet?.(record)
        return respond(value)
      }
      if (record.method === 'POST') {
        if (state.onPost) {
          const response = await state.onPost(record)
          if (response) return respond(response.body, response.status)
        }
        state.generation(record.body)
        const summaries = state.summary(record.body.targetId ?? null)
        return respond({ requestId: record.headers['idempotency-key'],
          scheduled: { candidates: summaries.scoring.complete, targets: summaries.targets.length }, summaries }, 202)
      }
    }
    return respond({ error: { code: 'not_found', message: `Unexpected fixture request: ${url.pathname}` } }, 404)
  })
  await page.goto(`${origin}/${sample ? '?sample=1' : result ? '?result=1' : ''}`)
  if (!sample) await visible(page.getByRole('heading', { name: 'Saved narrative review', exact: true }))
  return { page, context, state, fixture, errors }
}

const manager = (page) => page.getByRole('dialog', { name: 'Manage summaries', exact: true })
const exporter = (page) => page.getByRole('dialog', { name: 'Export analysis report', exact: true })
const posts = (state) => state.requests.filter((request) => request.method !== 'GET')
async function openManager(page) {
  await page.getByRole('button', { name: 'Manage summaries', exact: true }).click()
  const dialog = await visible(manager(page))
  await visible(dialog.getByRole('region', { name: 'Candidate summaries', exact: true }))
  return dialog
}
async function openExport(page) {
  await page.getByRole('button', { name: 'Export report', exact: true }).click()
  return visible(exporter(page))
}
async function readyDownload(dialog) {
  await until(() => dialog.getByRole('button', { name: /^Download / }).isEnabled(), 'The selected report scope should be ready.')
}

test('summary management uses explicit saved-run or exact-grade scope, not table search, and preserves browsing', async (t) => {
  const { page, state, errors } = await setup(t)
  assert.equal(await page.getByRole('button', { name: 'Manage summaries', exact: true }).count(), 1)
  await page.getByLabel('Search comparisons', { exact: true }).fill('Jordan')
  await page.getByLabel('Comparison target', { exact: true }).selectOption('grade:ladder-one:9:approved-v2:2')
  const dialog = await openManager(page)
  assert.equal(await dialog.getByLabel('Summary scope', { exact: true }).inputValue(), 'target-grade-v2')
  await visible(dialog.getByText('Only this saved run or one exact job / grade is included. Candidate searches and table filters do not limit summary generation.', { exact: true }))
  await dialog.getByLabel('Summary scope', { exact: true }).selectOption('')
  await visible(dialog.getByRole('heading', { name: 'Candidate summaries: 0 / 2 current and ready', exact: true }))
  const before = JSON.stringify(state.fixture.details)
  await dialog.getByRole('button', { name: 'Generate missing summaries', exact: true }).click()
  await visible(dialog.getByText(/^Summary request acknowledged:/))
  assert.deepEqual(posts(state).map((request) => request.body), [{ mode: 'missing' }])
  assert.match(posts(state)[0].headers['if-match'], /^"[a-f0-9]{64}"$/)
  assert.notEqual(posts(state)[0].headers['if-match'], state.fixture.summary.etag)
  assert.equal(JSON.stringify(state.fixture.details), before, 'Generating narrative text never changes frozen scores or comparisons.')
  assert.equal(await dialog.getByRole('button', { name: 'Generate missing summaries', exact: true }).isDisabled(), true)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  assert.equal(await page.getByLabel('Search comparisons', { exact: true }).inputValue(), 'Jordan')
  assert.equal(await page.getByLabel('Comparison target', { exact: true }).inputValue(), 'grade:ladder-one:9:approved-v2:2')
  await until(() => state.requests.filter((request) => request.path.endsWith('/summaries')).length > 3, 'Acknowledged summary work keeps polling after the dialog closes.')
  assert.deepEqual(errors, [])
})

test('regenerate all confirms separately, prevents duplicate submits, and keeps request key and original summary ETag after ambiguity', async (t) => {
  const { page, state, errors } = await setup(t, { summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
  const dialog = await openManager(page)
  assert.equal(await dialog.getByRole('button', { name: 'Generate missing summaries', exact: true }).isDisabled(), true)
  await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).click()
  await visible(dialog.getByRole('region', { name: 'Confirm summary regeneration', exact: true }))
  assert.equal(posts(state).length, 0)
  const gate = deferred()
  state.onPost = async () => {
    if (posts(state).length !== 1) return
    await gate.promise
    state.options.revisionTag = 'changed-after-ambiguous-acceptance'
    return { status: 503, body: { error: { code: 'unavailable', message: 'The acknowledgement was interrupted.' } } }
  }
  await dialog.getByRole('button', { name: 'Confirm regenerate all', exact: true }).click()
  await until(() => posts(state).length === 1, 'The first explicit summary request reached the service.')
  assert.equal(await dialog.getByRole('button', { name: 'Confirm regenerate all', exact: true }).isDisabled(), true)
  gate.resolve()
  await visible(dialog.getByText(/The acknowledgement was interrupted/))
  await until(() => dialog.getByRole('button', { name: 'Confirm regenerate all', exact: true }).isEnabled(), 'An unacknowledged request can be retried explicitly.')
  await dialog.getByRole('button', { name: 'Confirm regenerate all', exact: true }).click()
  await visible(dialog.getByText(/^Summary request acknowledged:/))
  assert.equal(posts(state).length, 2)
  assert.equal(posts(state)[0].headers['idempotency-key'], posts(state)[1].headers['idempotency-key'])
  assert.equal(posts(state)[0].headers['if-match'], posts(state)[1].headers['if-match'])
  assert.deepEqual(posts(state).map((request) => request.body), [{ mode: 'all' }, { mode: 'all' }])
  assert.equal(await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, [])
})

test('an obsolete status read cannot replace acknowledged regeneration with a previous ready publication', async (t) => {
  const { page, state } = await setup(t, { summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
  const dialog = await openManager(page)
  const gate = deferred()
  let started = false
  state.beforeGet = async () => { started = true; await gate.promise }
  await dialog.getByRole('button', { name: 'Refresh summary status', exact: true }).click()
  await until(() => started, 'The stale status read started before generation.')
  await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).click()
  await dialog.getByRole('button', { name: 'Confirm regenerate all', exact: true }).click()
  await visible(dialog.getByText(/^Summary request acknowledged:/))
  state.beforeGet = null
  gate.resolve()
  await visible(dialog.getByRole('heading', { name: 'Candidate summaries: 0 / 2 current and ready', exact: true }))
  await page.waitForTimeout(300)
  assert.equal(await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).isDisabled(), true)
  assert.equal(posts(state).length, 1)
})

test('completed comparisons refresh full narratives without changing pair ETags, source evidence, or score displays', async (t) => {
  const { page, state, fixture, errors } = await setup(t, { result: true, summaryOptions: {
    candidateStatus: 'ready', targetStatus: 'ready',
    states: { 'comparison-1': { status: 'running', previous: true }, 'target-job-v1': { status: 'waiting', previous: true } },
  } })
  const candidate = page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true })
  await visible(candidate.getByText(candidateNarrativeText, { exact: true }))
  await visible(candidate.getByText(/^Previous published summary - updating/))
  const score = await page.locator('.overall-score').innerText()
  const pairs = JSON.stringify(fixture.details)
  const revised = 'The saved project passage documents independent engineering methods. Those methods align with the exact frozen role. Breadth outside the documented projects remains uncertain.'
  state.options.states['comparison-1'] = { status: 'ready', text: revised }
  state.options.states['target-job-v1'] = { status: 'ready', paragraphs: ['The saved evidence supports applied engineering work, while broader context remains limited. This overview covers the exact saved job, not other grade targets.'] }
  await visible(candidate.getByText(revised, { exact: true }))
  await visible(candidate.getByText('Current summary', { exact: true }))
  await visible(page.getByRole('region', { name: 'Saved job or grade overview', exact: true }).getByText(/This overview covers the exact saved job/))
  assert.equal(await page.locator('.overall-score').innerText(), score)
  assert.equal(JSON.stringify(fixture.details), pairs)
  assert.equal(state.requests.filter((request) => request.path.endsWith('/comparisons/comparison-1')).length, 1,
    'Sidecar revisions render without refetching an immutable comparison.')
  await visible(page.getByRole('region', { name: 'Evidence coverage and limitations', exact: true }))
  assert.equal(posts(state).length, 0, 'Opening a completed comparison never enqueues model work.')
  assert.equal(await page.evaluate(() => Object.values(localStorage).some((value) => value.includes('engineering methods'))), false)
  assert.deepEqual(errors, [])
})

test('failed replacements retain previous publication and explicit summary errors without degrading the immutable result', async (t) => {
  const { page, state, errors } = await setup(t, { result: true, summaryOptions: {
    candidateStatus: 'ready', targetStatus: 'ready',
    states: { 'comparison-1': { status: 'failed', previous: true }, 'target-job-v1': { status: 'stale', previous: true } },
  } })
  const candidate = page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true })
  await visible(candidate.getByText(candidateNarrativeText, { exact: true }))
  await visible(candidate.getByText(/^Previous published summary - outdated/))
  await visible(candidate.getByRole('alert').getByText(/Summary grounding needs an explicit retry/))
  await visible(page.getByText('Original immutable scoring explanation.', { exact: true }))
  const dialog = await openManager(page)
  assert.equal(await dialog.getByLabel('Summary scope', { exact: true }).inputValue(), 'target-job-v1')
  assert.equal(await dialog.getByRole('button', { name: 'Generate missing summaries', exact: true }).isEnabled(), true)
  await dialog.getByRole('button', { name: 'Generate missing summaries', exact: true }).click()
  await visible(dialog.getByText(/^Summary request acknowledged:/))
  assert.deepEqual(posts(state)[0].body, { mode: 'missing', targetId: 'target-job-v1' })
  assert.deepEqual(errors, [])
})

test('viewers and archived analyses can read and export current summaries but cannot regenerate', async (t) => {
  for (const options of [{ role: 'viewer' }, { archived: true }]) {
    const { page, state, errors } = await setup(t, { ...options, summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
    const dialog = await openManager(page)
    assert.equal(await dialog.getByRole('button', { name: 'Generate missing summaries', exact: true }).isDisabled(), true)
    assert.equal(await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).isDisabled(), true)
    await visible(dialog.getByText(options.archived ? /^Unarchive this analysis/ : /^This workspace is read-only/))
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const report = await openExport(page)
    for (const format of ['pdf', 'docx', 'pptx']) {
      await report.getByLabel('Report format', { exact: true }).selectOption(format)
      await readyDownload(report)
      await report.getByRole('button', { name: /^Download / }).click()
      await visible(report.getByText(/^Download started:/))
    }
    assert.equal(posts(state).length, 0)
    assert.deepEqual(errors, [])
  }
})

test('missing or false generation capability fails closed without blocking historical summaries or any export format', async (t) => {
  for (const flag of [undefined, false]) {
    const { page, state } = await setup(t, { result: true, features: { realAnalyses: false, analysisSummaryGeneration: flag } })
    const dialog = await openManager(page)
    await visible(dialog.getByText(/^The summary generation service is unavailable/))
    assert.equal(await dialog.getByRole('button', { name: 'Generate missing summaries', exact: true }).isDisabled(), true)
    assert.equal(await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).isDisabled(), true)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const report = await openExport(page)
    for (const format of ['csv']) {
      await report.getByLabel('Report format', { exact: true }).selectOption(format)
      await readyDownload(report)
    }
    await report.getByRole('button', { name: 'Close', exact: true }).click()
    state.options.candidateStatus = 'ready'
    state.options.targetStatus = 'ready'
    const current = await openManager(page)
    await current.getByRole('button', { name: 'Refresh summary status', exact: true }).click()
    await visible(current.getByText('All required summaries in this scope are current and ready.', { exact: true }))
    await current.getByRole('button', { name: 'Close', exact: true }).click()
    await visible(page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true }).getByText(candidateNarrativeText, { exact: true }))
    const readyReport = await openExport(page)
    for (const format of ['pdf', 'docx', 'pptx']) {
      await readyReport.getByLabel('Report format', { exact: true }).selectOption(format)
      await readyDownload(readyReport)
    }
    assert.equal(posts(state).length, 0)
  }
})

test('PDF/Word/PPTX wait for selected current summaries; ready targets stay independent, CSV remains ungated, and export only reads', async (t) => {
  const { page, state, errors } = await setup(t, { secondStatus: 'running', summaryOptions: {
    candidateStatus: 'ready', targetStatus: 'ready',
    states: { 'comparison-2': { status: 'waiting', waitingFor: 'scoring' }, 'target-grade-v2': { status: 'waiting', waitingFor: 'scoring' } },
  } })
  const report = await openExport(page)
  await visible(report.getByText(/Missing, outdated, failed, waiting, or generating summaries block/))
  assert.equal(await report.getByRole('button', { name: /^Download / }).isDisabled(), true)
  for (const format of ['csv']) {
    await page.evaluate(() => { window.reportEvents = [] })
    await report.getByLabel('Report format', { exact: true }).selectOption(format)
    await readyDownload(report)
    await report.getByRole('button', { name: /^Download / }).click()
    await visible(report.getByText(/^Download started:/))
    const events = await page.evaluate(() => window.reportEvents)
    assert.deepEqual(events.map((item) => item.event), ['load', 'worker', 'download'])
    assert.equal(events[0].requireSummaries, false)
  }
  for (const format of ['pdf', 'docx', 'pptx']) {
    await report.getByLabel('Report format', { exact: true }).selectOption(format)
    assert.equal(await report.getByRole('button', { name: /^Download / }).isDisabled(), true)
  }
  await report.getByLabel('Report scope', { exact: true }).selectOption('target-job-v1')
  await readyDownload(report)
  for (const format of ['pdf', 'docx', 'pptx']) {
    await page.evaluate(() => { window.reportEvents = [] })
    await report.getByLabel('Report format', { exact: true }).selectOption(format)
    await readyDownload(report)
    await report.getByRole('button', { name: /^Download / }).click()
    await visible(report.getByText(/^Download started:/))
    const events = await page.evaluate(() => window.reportEvents)
    assert.deepEqual(events.map((item) => item.event), ['load', 'worker', 'assert', 'download'])
    assert.equal(events[0].requireSummaries, true)
    assert.equal(events[0].targetId, 'target-job-v1')
  }
  for (const format of ['pdf', 'docx', 'pptx']) {
    await report.getByLabel('Report format', { exact: true }).selectOption(format)
    await readyDownload(report)
    await page.evaluate(() => { window.reportEvents = []; window.failReportFence = true })
    await report.getByRole('button', { name: /^Download / }).click()
    await visible(report.getByText('Selected summary revisions changed before download.', { exact: true }))
    assert.deepEqual(await page.evaluate(() => window.reportEvents.map((item) => item.event)), ['load', 'worker', 'assert'])
  }
  assert.equal(posts(state).length, 0, 'Export never schedules summaries or scoring.')
  assert.deepEqual(errors, [])
})

test('uninitialized queued comparisons are shown once in the waiting count and block only their explicit narrative export scope', async (t) => {
  const { page } = await setup(t, { secondStatus: 'queued', summaryOptions: {
    candidateStatus: 'ready', targetStatus: 'ready', uninitializedIds: ['comparison-2'],
    states: { 'comparison-2': { status: 'waiting', waitingFor: 'scoring' }, 'target-grade-v2': { status: 'waiting', waitingFor: 'scoring' } },
  } })
  const report = await openExport(page)
  await visible(report.getByText(/^1 comparison is still awaiting or undergoing scoring/))
  await visible(report.getByText('Not initialized yet: 1 (included in the waiting count).', { exact: true }))
  assert.equal(await report.getByText(/^2 comparisons are still awaiting/).count(), 0)
  assert.equal(await report.getByRole('button', { name: /^Download / }).isDisabled(), true)
  await report.getByLabel('Report scope', { exact: true }).selectOption('target-job-v1')
  await readyDownload(report)
  await report.getByLabel('Report scope', { exact: true }).selectOption('target-grade-v2')
  await visible(report.getByText(/^1 comparison is still awaiting or undergoing scoring/))
  await visible(report.getByText('Not initialized yet: 1 (included in the waiting count).', { exact: true }))
  assert.equal(await report.getByRole('button', { name: /^Download / }).isDisabled(), true)
})

test('every unready sidecar state blocks all narrative formats despite an older publication and links to the separate management flow', async (t) => {
  const { page, state } = await setup(t, { summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
  const report = await openExport(page)
  for (const status of ['missing', 'stale', 'failed', 'waiting', 'queued', 'running', 'cancelled']) {
    state.options.states = { 'comparison-1': { status, previous: true } }
    for (const format of ['pptx', 'docx', 'pdf']) {
      await report.getByLabel('Report format', { exact: true }).selectOption(format)
      await visible(report.getByText(/Missing, outdated, failed, waiting, or generating summaries block/))
      assert.equal(await report.getByRole('button', { name: /^Download / }).isDisabled(), true)
    }
  }
  await report.getByLabel('Report scope', { exact: true }).selectOption('target-job-v1')
  await report.getByRole('button', { name: 'Manage summaries', exact: true }).click()
  const dialog = await visible(manager(page))
  assert.equal(await dialog.getByLabel('Summary scope', { exact: true }).inputValue(), 'target-job-v1')
  assert.equal(posts(state).length, 0)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await until(() => page.evaluate(() => document.activeElement.textContent === 'Manage summaries'), 'Returning from the export-linked workflow should focus the saved-analysis summary entry point.')
})

test('a late summary response cannot repopulate another workspace or an analysis being deleted', async (t) => {
  for (const deleting of [false, true]) {
    const { page, state, errors } = await setup(t, { summaryOptions: {
      candidateStatus: 'ready', targetStatus: 'ready', paragraphs: ['PRIVATE_OLD_WORKSPACE_OVERVIEW'],
    } })
    const gate = deferred()
    let started = false
    state.beforeGet = async () => { started = true; await gate.promise }
    await page.getByLabel('Comparison target', { exact: true }).selectOption('job:job-one:rubric-job:1')
    await until(() => started, 'The selected private summary request should be pending.')
    if (deleting) {
      state.fixture.summary.lifecycle = { deletingAt: summaryTimestamp }
      state.fixture.summary.etag = '"deleting-run"'
      await page.getByRole('button', { name: 'Refresh fixture history', exact: true }).click()
      await visible(page.getByRole('heading', { name: 'Analysis cleanup or removal', exact: true }))
    } else {
      await page.getByRole('button', { name: 'Switch fixture workspace', exact: true }).click()
      await until(() => state.requests.some((request) => request.path.startsWith('/api/workspaces/workspace-two/')), 'The replacement workspace is active.')
    }
    gate.resolve()
    await page.waitForTimeout(300)
    assert.equal(await page.getByText('PRIVATE_OLD_WORKSPACE_OVERVIEW', { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => Object.values(localStorage).some((value) => value.includes('PRIVATE_OLD_WORKSPACE_OVERVIEW'))), false)
    assert.deepEqual(errors, [])
  }
})

test('deletion during local report rendering cancels the download and samples never call real summaries', async (t) => {
  const { page, state, errors } = await setup(t, { summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
  const report = await openExport(page)
  await readyDownload(report)
  await page.evaluate(() => { window.holdReportWorker = true })
  await report.getByRole('button', { name: /^Download / }).click()
  await until(() => page.evaluate(() => window.reportEvents.some((item) => item.event === 'worker')), 'Local report rendering has started.')
  state.fixture.summary.lifecycle = { deletingAt: summaryTimestamp }
  state.fixture.summary.etag = '"deleting-run"'
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Refresh fixture history').click())
  await visible(page.getByRole('heading', { name: 'Analysis cleanup or removal', exact: true }))
  await page.evaluate(() => window.releaseReportWorker?.())
  assert.equal(await page.evaluate(() => window.reportEvents.some((item) => item.event === 'download')), false)
  assert.deepEqual(errors, [])
  const sample = await setup(t, { sample: true })
  const sampleReport = await openExport(sample.page)
  await visible(sampleReport.getByText(/Fictional samples use fixture summaries only/))
  assert.equal(sample.state.requests.filter((request) => request.path.endsWith('/summaries')).length, 0)
  assert.equal(posts(sample.state).length, 0)
})

test('summary management retains labeled keyboard controls and fits the existing mobile modal in both themes', async (t) => {
  const { page } = await setup(t)
  await page.setViewportSize({ width: 390, height: 844 })
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme)
    const dialog = await openManager(page)
    const geometry = await dialog.evaluate((element) => ({
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
      width: element.clientWidth, contentWidth: element.querySelector('.dialog-body').scrollWidth,
      viewport: window.innerWidth,
    }))
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport)
    assert.ok(geometry.contentWidth <= geometry.width, 'The summary counts and scope selector must wrap within the mobile dialog.')
    await dialog.getByLabel('Summary scope', { exact: true }).focus()
    assert.equal(await dialog.getByLabel('Summary scope', { exact: true }).evaluate((element) => element === document.activeElement), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await until(() => page.evaluate(() => document.activeElement.textContent === 'Manage summaries'), 'Closing the dialog should restore its management entry point focus.')
  }
})
