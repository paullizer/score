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
  analysisSummaryFixture, analysisSummaryIncidentFixture, candidateNarrativeText, summaryHistoryFixture, summaryResponse,
  summarySubjectResponse, summaryRunId, summaryTimestamp, summaryWorkHealthFixture, summaryWorkspaceId,
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
      import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
      import { RealAnalysesBridge } from './src/app/RealAnalysesBridge'
      import { useRealAnalyses } from './src/app/real-analyses-context'
      import { RealResumesContext } from './src/app/real-resumes-context'
      import { WorkspaceContext } from './src/app/workspace-context'
      import { RealAnalysisDetail } from './src/features/analyses/RealAnalysisDetail'
      import { AnalysisSetup } from './src/features/analyses/AnalysisSetup'
      import { AnalysisReportExport } from './src/features/analyses/AnalysisReportExport'
      import { frontendWorkspaceContext } from './src/services/frontend.test-support.mjs'
      import { createInitialWorkspace } from './src/data/fixtures'
      function Probe() {
        const api = useRealAnalyses()
        const navigate = useNavigate()
        return <>
          <button onClick={() => void api.refresh()}>Refresh fixture history</button>
          <button onClick={() => navigate('/analyses?data=real')}>Return fixture library</button>
          <button onClick={() => navigate('/analyses/run-one?data=real')}>Open fixture analysis</button>
          <button onClick={() => navigate('/analyses/new?data=real')}>Open fixture real setup</button>
          <button onClick={() => navigate('/analyses/new?data=samples')}>Open fixture sample setup</button>
        </>
      }
      function SavedAnalysis() {
        const location = useLocation()
        if (location.pathname === '/analyses/new') return <RealResumesContext.Provider value={{
          phase: 'ready', summaries: [], refresh: async () => {},
        }}><AnalysisSetup key={location.key} /></RealResumesContext.Provider>
        return location.pathname === '/analyses/run-one' ? <RealAnalysisDetail id="run-one" /> : <h1>Fixture analysis library</h1>
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
              : <RealAnalysesBridge workspaceId={workspaceId}><Probe /><SavedAnalysis /></RealAnalysesBridge>}
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
  beforeSubjectGet = null,
  fixture: inputFixture,
} = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  t.after(() => context.close())
  await context.addInitScript(({ role }) => {
    window.fixtureRole = role
    const interval = window.setInterval.bind(window)
    window.setInterval = (callback, delay, ...args) => interval(callback, delay === 3000 ? 150 : delay, ...args)
    const now = Date.now.bind(Date)
    const started = now()
    Date.now = () => started + (now() - started) * 20
  }, { role })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, []))
  const fixture = inputFixture ?? analysisSummaryFixture({ archived, secondStatus })
  const state = {
    fixture, liveTargets: structuredClone(fixture.targets), requests: [], options: { ...summaryOptions }, beforeGet: null, beforeSubjectGet, onPost: null,
    histories: new Map(), acknowledged: new Map(), beforeHistoryGet: null, onSummaryAction: null, summaryActions: 0,
    history(subject) {
      const key = `${subject.kind}:${subject.subjectId}`
      if (!state.histories.has(key)) state.histories.set(key, summaryHistoryFixture(fixture, subject))
      return state.histories.get(key)
    },
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
    const record = { path: url.pathname, targetId: url.searchParams.get('targetId'), cursor: url.searchParams.get('continuationToken'), method: request.method(),
      headers: request.headers(), body: request.postData() ? request.postDataJSON() : null }
    state.requests.push(record)
    const respond = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body), ...(body?.etag ? { headers: { ETag: body.etag } } : {}),
    })
    if (url.pathname === '/api/features') return respond(features)
    if (url.pathname.startsWith('/api/workspaces/workspace-two/')) {
      return url.pathname.endsWith('/analyses') ? respond({ runs: [] }) : respond({ error: { code: 'not_found', message: 'No saved analysis in the new workspace.' } }, 404)
    }
    const base = `/api/workspaces/${summaryWorkspaceId}/analyses`
    if (url.pathname === `${base}/targets`) return respond({ targets: state.liveTargets })
    if (url.pathname === base) return respond({ runs: [fixture.summary] })
    if (url.pathname === `${base}/${summaryRunId}`) return respond({ ...fixture.detail, ...fixture.summary })
    if (url.pathname === `${base}/${summaryRunId}/comparisons`) return respond({ comparisons: fixture.details })
    const comparison = fixture.details.find(({ comparison }) => url.pathname === `${base}/${summaryRunId}/comparisons/${comparison.id}`)
    if (comparison) return respond(comparison)
    const subjectRead = url.pathname.match(/\/summaries\/(candidate|target)\/([^/]+)$/)
    if (subjectRead && record.method === 'GET') {
      const subject = { kind: subjectRead[1], subjectId: decodeURIComponent(subjectRead[2]) }
      const value = summarySubjectResponse(fixture, subject, state.options)
      const custom = await state.beforeSubjectGet?.(record, subject)
      return respond(custom?.body ?? value, custom?.status ?? 200)
    }
    const historyAction = url.pathname.match(/\/summaries\/(candidate|target)\/([^/]+)\/(history|publish|retry|restart)$/)
    if (historyAction) {
      if (role === 'viewer') return respond({ error: { code: 'forbidden', message: 'Only owners and editors can review summary history.' } }, 403)
      const subject = { kind: historyAction[1], subjectId: decodeURIComponent(historyAction[2]) }
      const history = state.history(subject)
      const targetId = subject.kind === 'target' ? subject.subjectId
        : fixture.details.find(item => item.comparison.id === subject.subjectId).comparison.target.summary.id
      if (historyAction[3] === 'history') {
        const offset = Number(record.cursor ?? 0)
        const response = { ...history, entries: history.entries.slice(offset, offset + 12),
          ...(offset + 12 < history.entries.length ? { continuationToken: String(offset + 12) } : {}),
          ...(archived ? { capabilities: { canPublish: false, canRetry: false } } : {}) }
        await state.beforeHistoryGet?.(record)
        return respond(response)
      }
      if (archived) return respond({ error: { code: 'read_only', message: 'Unarchive before changing summaries.' } }, 409)
      const key = record.headers['idempotency-key']
      if (state.acknowledged.has(key)) return respond(state.acknowledged.get(key))
      const custom = await state.onSummaryAction?.(record)
      if (custom && !custom.commit) return respond(custom.body, custom.status)
      state.summaryActions++
      state.options.states ??= {}
      if (historyAction[3] === 'publish') {
        const entry = history.entries.find(item => item.generationId === record.body.generationId &&
          item.round === record.body.round && item.outputSha256 === record.body.outputSha256)
        assert.ok(entry?.draft && entry.scopeId === 'final')
        const review = history.entries.find(item => item.generationId === entry.generationId &&
          item.round === entry.round && item.outputSha256 === entry.outputSha256 && item.review)?.review
        state.options.states[subject.subjectId] = {
          status: 'ready', generationId: randomUUID(), summaryVersion: 2, hasHistory: true, summaryRound: entry.round,
          ...(entry.draft.kind === 'candidate' ? { text: entry.draft.text, overview: entry.draft.overview } : { paragraphs: entry.draft.paragraphs }),
          approval: { kind: 'manual', approvedAt: summaryTimestamp, approvedBy: 'workspace-editor',
            reviewOutcome: review?.outcome ?? 'not-reviewed', issues: review?.issues ?? [] },
        }
      } else {
        if (historyAction[3] === 'restart') assert.deepEqual(record.body, { confirmRestart: true })
        const current = state.summary(targetId)
        const item = subject.kind === 'candidate' ? current.comparisons.find(item => item.comparisonId === subject.subjectId) : current.targets[0]
        state.options.states[subject.subjectId] = {
          ...state.options.states[subject.subjectId], status: 'queued', previous: Boolean(item.published),
          previousPublication: item.published, summaryRound: 1, hasHistory: true, generationId: randomUUID(),
        }
        history.capabilities.canRetry = false
        if (history.capabilities.canResume !== undefined) history.capabilities.canResume = false
      }
      if (subject.kind === 'candidate') {
        const published = state.summary(targetId).targets[0].published
        state.options.states[targetId] = { ...state.options.states[targetId], status: 'waiting', previous: Boolean(published), previousPublication: published }
      }
      history.etag = `"summary-record-${state.summaryActions}"`
      const response = { summaries: state.summary(targetId) }
      state.acknowledged.set(key, response)
      return respond(custom?.body ?? response, custom?.status ?? 200)
    }
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
const subjectReads = (state) => state.requests.filter((request) => request.method === 'GET' && /\/summaries\/(candidate|target)\/[^/]+$/.test(request.path))
const scopeReads = (state) => state.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/summaries'))
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
  const readsBeforeClose = scopeReads(state).length
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  assert.equal(await page.getByLabel('Search comparisons', { exact: true }).inputValue(), 'Jordan')
  assert.equal(await page.getByLabel('Comparison target', { exact: true }).inputValue(), 'grade:ladder-one:9:approved-v2:2')
  await until(() => scopeReads(state).length > readsBeforeClose, 'Acknowledged summary work keeps polling after the dialog closes.')
  assert.deepEqual(errors, [])
})

test('work health shows the 412-ready incident truthfully and keeps interrupted subjects discoverable beside live work', async t => {
  const fixture = analysisSummaryIncidentFixture()
  const [, , queued, interrupted] = fixture.targets
  const { page, state } = await setup(t, { fixture, summaryOptions: {
    candidateStatus: 'ready', targetStatus: 'ready', hasHistory: true,
    states: {
      [queued.id]: { status: 'queued', workHealth: summaryWorkHealthFixture('awaiting-worker') },
      [interrupted.id]: { status: 'running', workHealth: summaryWorkHealthFixture('interrupted') },
    },
  } })
  const dialog = await openManager(page)
  await dialog.getByLabel('Summary scope', { exact: true }).selectOption('')
  await visible(dialog.getByRole('heading', { name: 'Candidate summaries: 412 / 412 current and ready', exact: true }))
  await visible(dialog.getByRole('heading', { name: 'Job / grade overviews: 2 / 4 current and ready', exact: true }))
  const overviews = dialog.getByRole('region', { name: 'Job / grade overviews', exact: true })
  await visible(overviews.getByText(/0 active · 1 queued awaiting worker · 0 cooldown/))
  await visible(overviews.getByText(/1 interrupted/))
  await visible(dialog.getByText('Queued - awaiting worker: 1 summary.', { exact: true }))
  await visible(dialog.getByText('Interrupted - worker lease expired: 1 summary.', { exact: true }))
  await visible(dialog.getByText(/^Lease expired/))
  await visible(dialog.getByText(/^Last activity/).first())
  await visible(dialog.getByRole('button', { name: `History: Overview (${interrupted.label})`, exact: true }))
  assert.equal(await dialog.getByText(/Summaries are generating|Server work continues|worker outage/).count(), 0)
  assert.equal(await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).isDisabled(), true)
  assert.equal(posts(state).length, 0)

  state.options.states[fixture.targets[0].id] = { status: 'running', previous: true, workHealth: summaryWorkHealthFixture('running') }
  await dialog.getByRole('button', { name: 'Refresh summary status', exact: true }).click()
  await visible(dialog.getByText(/^1 summary has an active worker lease/))
  await visible(dialog.getByRole('button', { name: `History: Overview (${interrupted.label})`, exact: true }))
  await visible(overviews.getByText(/1 active · 1 queued awaiting worker/))
  assert.equal(await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).isDisabled(), true)
  assert.equal(posts(state).length, 0)
})

test('work health polling renders cooldown then eligible queue with the same scope ETag and retained previous HTTP error', async t => {
  const retryAt = '2026-09-19T15:05:00.000Z'
  const { page, state } = await setup(t, { summaryOptions: {
    candidateStatus: 'ready', targetStatus: 'ready', hasHistory: true,
    states: { 'target-job-v1': {
      status: 'queued', nextAttemptAt: retryAt,
      workHealth: summaryWorkHealthFixture('throttled', { nextEligibleAt: retryAt }),
      processingError: { code: 'service-unavailable', stage: 'target-generation', message: 'The provider requested a later retry.',
        retryable: true, diagnostic: { httpStatus: 429, retryAt } },
    } },
  } })
  const before = state.summary(null)
  const dialog = await openManager(page)
  await dialog.getByLabel('Summary scope', { exact: true }).selectOption('')
  await visible(dialog.getByText('Rate-limit cooldown: 1 summary.', { exact: true }))
  await visible(dialog.getByText(/^Next retry no earlier than/))
  await visible(dialog.getByText(/HTTP 429/))
  assert.equal(await dialog.getByText(/Summaries are generating/).count(), 0)
  state.options.states['target-job-v1'].workHealth = summaryWorkHealthFixture('awaiting-worker', { nextEligibleAt: retryAt })
  const due = state.summary(null)
  assert.equal(due.etag, before.etag)
  assert.equal(due.revision, before.revision)
  assert.notEqual(due.workRevision, before.workRevision)
  assert.deepEqual(due.capture, before.capture)
  await visible(dialog.getByText('Queued - awaiting worker: 1 summary.', { exact: true }))
  await visible(dialog.getByText(/^Eligible since/))
  await visible(dialog.getByText(/HTTP 429/))
  assert.equal(await dialog.getByText('Rate-limit cooldown: 1 summary.', { exact: true }).count(), 0)
  assert.equal(posts(state).length, 0)
})

test('work health accepts legacy optional fields absent without claiming an unverified running lease is active', async t => {
  const { page } = await setup(t, { summaryOptions: { candidateStatus: 'ready', targetStatus: 'running' } })
  const dialog = await openManager(page)
  await dialog.getByLabel('Summary scope', { exact: true }).selectOption('')
  await visible(dialog.getByText(/2 running with unverified lease/))
  await visible(dialog.getByText('Running - lease status unavailable: 2 summaries.', { exact: true }))
  await visible(dialog.getByText(/^This response has no lease metadata/).first())
  assert.equal(await dialog.getByText(/an active worker lease/).count(), 0)
  assert.equal(await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).isDisabled(), true)
})

test('captured target display names stay consistent across summary management and the saved overview', async (t) => {
  const { page, fixture, state } = await setup(t)
  const target = fixture.targets[0]
  target.displayName = 'Captured research vacancy'
  await page.reload()
  await visible(page.getByRole('heading', { name: 'Saved narrative review', exact: true }))
  const selector = page.getByLabel('Comparison target', { exact: true })
  const value = await selector.getByRole('option', { name: /Captured research vacancy/ }).getAttribute('value')
  assert.ok(value)
  await selector.selectOption(value)
  const overview = await visible(page.getByRole('region', { name: 'Saved job or grade overview', exact: true }))
  await visible(overview.getByText(/^Captured research vacancy/))
  await visible(overview.getByText(`Source title: ${target.label}`, { exact: true }))
  const dialog = await openManager(page)
  assert.equal(await dialog.getByLabel('Summary scope', { exact: true }).inputValue(), target.id)
  assert.equal(await dialog.getByRole('option', { name: /Captured research vacancy/ }).count(), 1)
  const before = JSON.stringify(fixture.details)
  await dialog.getByRole('button', { name: 'Generate missing summaries', exact: true }).click()
  await visible(dialog.getByText(/^Summary request acknowledged:/))
  assert.deepEqual(posts(state).map(request => request.body), [{ mode: 'missing', targetId: target.id }])
  assert.equal(JSON.stringify(fixture.details), before)
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

test('completed comparisons refresh subject narratives without changing pair ETags, source evidence, or score displays', async (t) => {
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

test('late subject replies cannot restore old readiness after acknowledged regeneration', async (t) => {
  const { page, state } = await setup(t, { result: true, summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
  const candidate = page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true })
  await visible(candidate.getByText('Current summary', { exact: true }))
  const gate = deferred()
  t.after(() => gate.resolve())
  let held = 0
  state.beforeSubjectGet = async () => { held++; await gate.promise }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await until(() => held === 2, 'Both old subject publications were captured before the mutation.')
  const dialog = await openManager(page)
  state.beforeSubjectGet = null
  await dialog.getByRole('button', { name: 'Regenerate all summaries', exact: true }).click()
  await dialog.getByRole('button', { name: 'Confirm regenerate all', exact: true }).click()
  await visible(dialog.getByText(/^Summary request acknowledged:/))
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await visible(candidate.getByText('Queued - awaiting worker', { exact: true }))
  gate.resolve()
  await page.waitForTimeout(300)
  assert.equal(await candidate.getByText('Current summary', { exact: true }).count(), 0)
  await visible(candidate.getByText(/^Previous published summary - updating/))
  assert.equal(posts(state).length, 1)
})

test('delayed and failed subject summaries never block saved scores, criteria or frozen source navigation', async (t) => {
  const candidateGate = deferred()
  const targetGate = deferred()
  t.after(() => { candidateGate.resolve(); targetGate.resolve() })
  const { page, state } = await setup(t, {
    result: true, summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' },
    beforeSubjectGet: async (_request, subject) => {
      if (subject.kind === 'candidate') { await candidateGate.promise; return }
      await targetGate.promise
      return { status: 503, body: { error: { code: 'unavailable', message: 'Overview publication is temporarily unavailable.' } } }
    },
  })
  const candidate = page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true })
  const target = page.getByRole('region', { name: 'Saved job or grade overview', exact: true })
  await visible(candidate.getByText('Loading saved candidate summary...', { exact: true }))
  await visible(target.getByText('Loading saved overview...', { exact: true }))
  await visible(page.getByText('Original immutable scoring explanation.', { exact: true }))
  await visible(page.getByRole('region', { name: 'Real criterion assessments', exact: true }))
  await visible(page.getByRole('region', { name: 'Saved real source evidence', exact: true }))
  assert.match(await page.locator('.overall-score').innerText(), /60/)
  await page.getByRole('button', { name: 'Job description', exact: true }).click()
  await visible(page.getByRole('heading', { name: 'Full saved job description', exact: true }))
  await page.getByRole('button', { name: 'Resume evidence', exact: true }).click()
  await visible(page.getByRole('heading', { name: 'Full saved resume', exact: true }))
  assert.equal(scopeReads(state).length, 0, 'Opening one comparison never fetches full-scope published candidate text.')
  assert.deepEqual(new Set(subjectReads(state).map((request) => request.path.split('/summaries/')[1])),
    new Set(['candidate/comparison-1', 'target/target-job-v1']))
  candidateGate.resolve()
  await visible(candidate.getByText(candidateNarrativeText, { exact: true }))
  assert.equal(await target.getByText('Loading saved overview...', { exact: true }).count(), 1,
    'Candidate publication does not wait for the overview.')
  targetGate.resolve()
  await visible(target.getByRole('alert').getByText(/Overview publication is temporarily unavailable/))
  assert.equal(await candidate.getByText('Current summary', { exact: true }).count(), 1)
  state.beforeSubjectGet = null
  await target.getByRole('button', { name: 'Retry overview', exact: true }).click()
  await visible(target.getByText('Current summary', { exact: true }))
  assert.equal(scopeReads(state).length, 0)
  assert.equal(posts(state).length, 0)
})

test('ready publications keep refreshing independently of scoring ETags and preserve approved replacements', async (t) => {
  const { page, state, fixture } = await setup(t, { result: true, summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
  const candidate = page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true })
  await visible(candidate.getByText(candidateNarrativeText, { exact: true }))
  const immutable = JSON.stringify(fixture.details)
  const replacement = 'An independently approved replacement uses the saved engineering evidence. Scoring and immutable citations stay unchanged.'
  state.options.states = { 'comparison-1': {
    status: 'ready', text: replacement, summaryVersion: 2,
    approval: { kind: 'manual', approvedAt: summaryTimestamp, approvedBy: 'workspace-editor', reviewOutcome: 'not-reviewed', issues: [] },
  } }
  await visible(candidate.getByText(replacement, { exact: true }))
  await visible(candidate.getByText('Manually approved', { exact: true }))
  assert.equal(JSON.stringify(fixture.details), immutable)
  assert.equal(state.requests.filter((request) => request.path.endsWith('/comparisons/comparison-1')).length, 1)
  assert.equal(scopeReads(state).length, 0)
})

test('inactive overview and management scopes stop polling and are not refreshed on focus', async (t) => {
  const { page, state } = await setup(t, { summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
  await page.getByLabel('Comparison target', { exact: true }).selectOption('job:job-one:rubric-job:1')
  const target = page.getByRole('region', { name: 'Saved job or grade overview', exact: true })
  await visible(target.getByText('Current summary', { exact: true }))
  const dialog = await openManager(page)
  await dialog.getByLabel('Summary scope', { exact: true }).selectOption('target-grade-v2')
  await visible(dialog.getByRole('heading', { name: 'Candidate summaries: 1 / 1 current and ready', exact: true }))
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByLabel('Comparison target', { exact: true }).selectOption('grade:ladder-one:9:approved-v2:2')
  await visible(target.getByText('Current summary', { exact: true }))
  const inactiveJobReads = () => subjectReads(state).filter((request) => request.path.endsWith('/target/target-job-v1')).length
  const oldJobCount = inactiveJobReads()
  const oldScopeCount = scopeReads(state).length
  const gradeCount = subjectReads(state).filter((request) => request.path.endsWith('/target/target-grade-v2')).length
  await page.waitForTimeout(500)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await until(() => subjectReads(state).filter((request) => request.path.endsWith('/target/target-grade-v2')).length > gradeCount,
    'The displayed overview remains subscribed.')
  assert.equal(inactiveJobReads(), oldJobCount)
  assert.equal(scopeReads(state).length, oldScopeCount)
})

test('saved comparison navigation never discovers live new-run targets; actual setup and explicit refresh do', async (t) => {
  const { page, state } = await setup(t, {
    result: true, features: { realAnalyses: true, analysisSummaryGeneration: true },
    summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' },
  })
  const targetReads = () => state.requests.filter((request) => request.path.endsWith('/analyses/targets')).length
  await visible(page.getByText('Original immutable scoring explanation.', { exact: true }))
  assert.equal(targetReads(), 0)
  await page.getByRole('link', { name: 'All saved comparisons', exact: true }).click()
  await page.getByRole('button', { name: /^Review comparison 2:/ }).click()
  await visible(page.getByText('Original immutable scoring explanation.', { exact: true }))
  await page.getByRole('button', { name: 'Refresh fixture history', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(200)
  assert.equal(targetReads(), 0, 'Features, history refreshes, focus and comparison location keys cannot fan out to live source validation.')
  await page.getByRole('button', { name: 'Open fixture real setup', exact: true }).click()
  await visible(page.getByRole('heading', { name: 'Build a real analysis', exact: true }))
  assert.equal(targetReads(), 1)
  state.liveTargets[0].displayName = 'Latest live job option'
  await page.getByRole('button', { name: 'Refresh available inputs', exact: true }).click()
  await visible(page.getByText('Latest live job option', { exact: true }))
  assert.equal(targetReads(), 2)
  await page.getByRole('button', { name: 'Open fixture analysis', exact: true }).click()
  await visible(page.getByRole('heading', { name: 'Saved narrative review', exact: true }))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('button', { name: 'Open fixture sample setup', exact: true }).click()
  await page.waitForTimeout(200)
  assert.equal(targetReads(), 2, 'Neither historical navigation nor a Samples setup subscribes to private live target discovery.')
  state.liveTargets[0].displayName = 'Revalidated live job option'
  await page.getByRole('button', { name: 'Open fixture real setup', exact: true }).click()
  await visible(page.getByText('Revalidated live job option', { exact: true }))
  assert.equal(targetReads(), 3, 'A newly opened setup must revalidate live eligibility rather than reuse inactive cached targets.')
  assert.equal(posts(state).length, 0)
})

test('acknowledged current-analysis summary work progresses after closure but stops polling when leaving that analysis', async (t) => {
  const { page, state } = await setup(t)
  const dialog = await openManager(page)
  await dialog.getByRole('button', { name: 'Generate missing summaries', exact: true }).click()
  await visible(dialog.getByText(/^Summary request acknowledged:/))
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  const acknowledged = scopeReads(state).length
  await until(() => scopeReads(state).length > acknowledged, 'The current analysis continues observing acknowledged work.')
  await page.getByRole('button', { name: 'Return fixture library', exact: true }).click()
  await visible(page.getByRole('heading', { name: 'Fixture analysis library', exact: true }))
  const afterLeaving = scopeReads(state).length
  await page.waitForTimeout(500)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(200)
  assert.equal(scopeReads(state).length, afterLeaving, 'An old analysis never keeps a background full-scope subscription.')
  assert.equal(posts(state).length, 1, 'Polling and navigation never restart server generation.')
})

test('summary polling is single-flight, pauses when hidden, and refreshes each active subject once on return', async (t) => {
  const { page, state } = await setup(t, { result: true, summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
  const candidate = page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true })
  await visible(candidate.getByText(candidateNarrativeText, { exact: true }))
  await visible(page.getByRole('region', { name: 'Saved job or grade overview', exact: true }).getByText('Current summary', { exact: true }))
  const gate = deferred()
  t.after(() => gate.resolve())
  state.beforeSubjectGet = async () => { await gate.promise }
  const countByPath = () => Object.fromEntries([...new Set(subjectReads(state).map((request) => request.path))]
    .map((path) => [path, subjectReads(state).filter((request) => request.path === path).length]))
  const before = countByPath()
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
  await until(() => Object.entries(countByPath()).every(([path, count]) => count === before[path] + 1), 'Both active subject reads started.')
  await page.waitForTimeout(500)
  assert.deepEqual(countByPath(), Object.fromEntries(Object.entries(before).map(([path, count]) => [path, count + 1])),
    'Unchanged ticks cannot overlap an outstanding read of the same subject.')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
  state.beforeSubjectGet = null
  gate.resolve()
  await page.waitForTimeout(500)
  const hiddenCounts = countByPath()
  assert.deepEqual(hiddenCounts, Object.fromEntries(Object.entries(before).map(([path, count]) => [path, count + 1])))
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
  await until(() => Object.entries(countByPath()).every(([path, count]) => count === hiddenCounts[path] + 1),
    'Visibility and focus share a single refresh for each currently displayed subject.')
  assert.equal(scopeReads(state).length, 0)
})

test('summary read failures retain disclosed previous text, offer independent retry, and clear inaccessible publications', async (t) => {
  const { page, state } = await setup(t, { result: true, summaryOptions: { candidateStatus: 'ready', targetStatus: 'ready' } })
  const candidate = page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true })
  await visible(candidate.getByText(candidateNarrativeText, { exact: true }))
  let status = 503
  state.beforeSubjectGet = (_request, subject) => subject.kind === 'candidate'
    ? { status, body: { error: { code: status === 503 ? 'unavailable' : status === 404 ? 'not_found' : 'forbidden', message: 'Candidate publication could not be read.' } } }
    : undefined
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await visible(candidate.getByText('Current status unavailable', { exact: true }))
  await visible(candidate.getByText(/^Previous published summary - outdated/))
  await visible(candidate.getByText(candidateNarrativeText, { exact: true }))
  for (status of [401, 403, 404]) {
    await candidate.getByRole('button', { name: 'Retry candidate summary', exact: true }).click()
    await until(() => candidate.getByText(candidateNarrativeText, { exact: true }).count().then((count) => count === 0),
      'Access failures must discard the cached private publication.')
    await visible(candidate.getByRole('alert').getByText(/Candidate publication could not be read/))
    await visible(page.getByText('Original immutable scoring explanation.', { exact: true }))
  }
  state.beforeSubjectGet = null
  await candidate.getByRole('button', { name: 'Retry candidate summary', exact: true }).click()
  await visible(candidate.getByText(candidateNarrativeText, { exact: true }))
  assert.equal(scopeReads(state).length, 0)
  assert.equal(posts(state).length, 0)
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
    state.beforeSubjectGet = async () => { started = true; await gate.promise }
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

async function openCandidateHistory(page) {
  const candidate = await visible(page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true }))
  await candidate.getByRole('button', { name: 'History: Candidate summary', exact: true }).click()
  const history = await visible(candidate.getByRole('region', { name: 'Summary history: Candidate summary', exact: true }))
  await visible(history.getByText('Full candidate draft', { exact: true }).first())
  return { candidate, history }
}

test('owners and editors inspect full history, confirm the latest known issues, and publish without rescoring', async (t) => {
  for (const role of ['owner', 'editor']) {
    const { page, state, fixture } = await setup(t, { role, result: true, summaryOptions: {
      candidateStatus: 'failed', targetStatus: 'ready', hasHistory: true, summaryRound: 3,
    } })
    const source = JSON.stringify(fixture.details)
    const recorded = state.history({ kind: 'candidate', subjectId: 'comparison-1' })
    const { candidate, history } = await openCandidateHistory(page)
    await visible(candidate.getByText('Summary progress: round 3 of 3.', { exact: true }).first())
    assert.equal(posts(state).length, 0, 'Reading private history never starts model work.')
    assert.equal(await history.getByRole('article').count(), 6)
    const generated = history.getByRole('article', { name: `Summary checkpoint ${recorded.entries[1].id}`, exact: true })
    await generated.getByRole('button', { name: 'Use this draft', exact: true }).click()
    const confirmation = await visible(history.getByRole('region', { name: 'Confirm manual summary publication', exact: true }))
    await visible(confirmation.getByText(/This records human\/manual approval, not an automated pass/))
    await visible(confirmation.getByText(/nationwide experience was not established/))
    assert.equal(await confirmation.evaluate(element => element === document.activeElement), true)
    await confirmation.getByRole('button', { name: 'Keep unpublished', exact: true }).click()
    assert.equal(await generated.getByRole('button', { name: 'Use this draft', exact: true }).evaluate(element => element === document.activeElement), true)
    await generated.getByRole('button', { name: 'Use this draft', exact: true }).click()
    await confirmation.getByRole('button', { name: 'Confirm manual publication', exact: true }).click()
    await visible(history.getByText(/^Manual publication acknowledged/))
    await visible(candidate.getByText('Current summary', { exact: true }))
    await visible(candidate.getByText('Manually approved', { exact: true }).first())
    await visible(candidate.getByText('Manually approved summary. Automated review: needs-correction.', { exact: true }).first())
    await visible(history.getByText('Matches current published text', { exact: true }).first())
    await until(() => history.getByRole('button', { name: 'Refresh summary history', exact: true })
      .evaluate(element => element === document.activeElement), 'Acknowledged manual publication restores focus after refreshing private history.')
    assert.notEqual(state.summary('target-job-v1').comparisons[0].published.generationId, recorded.entries[1].generationId)
    await visible(generated.getByText('Historical generation', { exact: true }))
    assert.equal(JSON.stringify(fixture.details), source)
    assert.deepEqual(posts(state).map(request => request.path.split('/').slice(-4).join('/')), ['summaries/candidate/comparison-1/publish'])
    assert.deepEqual(posts(state)[0].body, {
      generationId: recorded.entries[1].generationId, round: 3, outputSha256: recorded.entries[1].outputSha256,
    })
    assert.equal(posts(state)[0].headers['if-match'], '"summary-record-etag"')
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('Retained candidate draft'))), false)
  }
})

test('editors can manually publish an unreviewed target draft and retry only that target without changing candidate summaries', async (t) => {
  const { page, state, fixture } = await setup(t, { role: 'editor', result: true,
    summaryOptions: { candidateStatus: 'ready', targetStatus: 'failed', hasHistory: true } })
  const candidatePublications = JSON.stringify(state.summary(null).comparisons)
  const savedScores = JSON.stringify(fixture.details)
  const recorded = state.history({ kind: 'target', subjectId: 'target-job-v1' })
  recorded.entries = recorded.entries.filter(entry => entry.phase === 'generated')
  const overview = await visible(page.getByRole('region', { name: 'Saved job or grade overview', exact: true }))
  await overview.getByRole('button', { name: 'History: Job / grade overview', exact: true }).click()
  const history = await visible(overview.getByRole('region', { name: 'Summary history: Job / grade overview', exact: true }))
  await visible(history.getByText('No factual review was recorded for this draft. It is not an automated pass.', { exact: true }).first())
  await history.getByRole('button', { name: 'Use this draft', exact: true }).first().click()
  const confirmation = await visible(history.getByRole('region', { name: 'Confirm manual summary publication', exact: true }))
  await visible(confirmation.getByText('Automated review: not-reviewed.', { exact: true }))
  await confirmation.getByRole('button', { name: 'Confirm manual publication', exact: true }).click()
  await visible(history.getByText(/^Manual publication acknowledged/))
  await visible(overview.getByText('Manually approved summary. Automated review: not-reviewed.', { exact: true }).first())
  await visible(history.getByText('Matches current published text', { exact: true }).first())
  assert.deepEqual(state.summary('target-job-v1').targets[0].published.paragraphs, recorded.entries[0].draft.paragraphs)
  await until(() => history.getByRole('button', { name: 'Retry this summary', exact: true }).isEnabled(), 'Target history refresh permits an explicit summary-only retry.')
  await history.getByRole('button', { name: 'Retry this summary', exact: true }).click()
  await visible(history.getByText(/^Retry acknowledged for this summary only/))
  assert.deepEqual(posts(state).map(request => request.path.split('/').slice(-4).join('/')), [
    'summaries/target/target-job-v1/publish', 'summaries/target/target-job-v1/retry',
  ])
  assert.deepEqual(posts(state)[1].body, {})
  assert.notEqual(posts(state)[0].headers['idempotency-key'], posts(state)[1].headers['idempotency-key'])
  assert.equal(posts(state)[1].headers['if-match'], '"summary-record-1"')
  assert.equal(JSON.stringify(state.summary(null).comparisons), candidatePublications)
  assert.equal(JSON.stringify(fixture.details), savedScores)
})

test('a targeted restart requires confirmation, supersedes active work and leaves completed candidate summaries and other targets unchanged', async (t) => {
  const { page, state, fixture } = await setup(t, { role: 'editor', result: true,
    summaryOptions: { candidateStatus: 'ready', targetStatus: 'running', previous: true, hasHistory: true } })
  const before = state.summary(null)
  const candidatePublications = JSON.stringify(before.comparisons)
  const otherTargets = JSON.stringify(before.targets.filter(item => item.targetId !== 'target-job-v1'))
  const savedScores = JSON.stringify(fixture.details)
  const recorded = state.history({ kind: 'target', subjectId: 'target-job-v1' })
  recorded.capabilities = { canPublish: true, canRetry: true, canResume: false, canRestart: true }
  const overview = await visible(page.getByRole('region', { name: 'Saved job or grade overview', exact: true }))
  await overview.getByRole('button', { name: 'History: Job / grade overview', exact: true }).click()
  const history = await visible(overview.getByRole('region', { name: 'Summary history: Job / grade overview', exact: true }))
  const restart = await visible(history.getByRole('button', { name: 'Restart with current settings', exact: true }))
  assert.equal(await history.getByRole('button', { name: 'Resume saved attempt', exact: true }).isDisabled(), true)
  await restart.click()
  const confirmation = await visible(history.getByRole('region', { name: 'Confirm summary restart', exact: true }))
  await visible(confirmation.getByText(/Queued or running work for this summary will be superseded/))
  await visible(confirmation.getByText(/Candidate summaries and other job \/ grade overviews are unchanged/))
  assert.equal(await confirmation.evaluate(element => element === document.activeElement), true)
  assert.equal(posts(state).length, 0, 'Opening confirmation must not enqueue paid model work.')
  await confirmation.getByRole('button', { name: 'Close confirmation', exact: true }).click()
  assert.equal(await restart.evaluate(element => element === document.activeElement), true)
  assert.equal(posts(state).length, 0)
  await restart.click()
  await confirmation.getByRole('button', { name: 'Confirm restart with current settings', exact: true }).click()
  await visible(history.getByText(/^Restart acknowledged for this summary only/))
  assert.deepEqual(posts(state).map(request => request.path.split('/').slice(-4).join('/')), [
    'summaries/target/target-job-v1/restart',
  ])
  assert.deepEqual(posts(state)[0].body, { confirmRestart: true })
  assert.equal(posts(state)[0].headers['if-match'], '"summary-record-etag"')
  assert.equal(JSON.stringify(state.summary(null).comparisons), candidatePublications)
  assert.equal(JSON.stringify(state.summary(null).targets.filter(item => item.targetId !== 'target-job-v1')), otherTargets)
  assert.deepEqual(state.summary(null).targets.find(item => item.targetId === 'target-job-v1').published,
    before.targets.find(item => item.targetId === 'target-job-v1').published)
  assert.equal(JSON.stringify(fixture.details), savedScores)
  await until(() => history.getByRole('button', { name: 'Refresh summary history', exact: true })
    .evaluate(element => element === document.activeElement), 'Restart acknowledgement restores focus after history refresh.')
})

test('resume and restart are distinct intents and an interrupted restart acknowledgement reuses the original request without duplicate work', async (t) => {
  const { page, state } = await setup(t, { result: true,
    summaryOptions: { candidateStatus: 'ready', targetStatus: 'failed', previous: true, hasHistory: true } })
  const candidatePublications = JSON.stringify(state.summary(null).comparisons)
  const recorded = state.history({ kind: 'target', subjectId: 'target-job-v1' })
  recorded.capabilities = { canPublish: true, canRetry: true, canResume: true, canRestart: true }
  const overview = await visible(page.getByRole('region', { name: 'Saved job or grade overview', exact: true }))
  await overview.getByRole('button', { name: 'History: Job / grade overview', exact: true }).click()
  const history = await visible(overview.getByRole('region', { name: 'Summary history: Job / grade overview', exact: true }))
  await history.getByRole('button', { name: 'Resume saved attempt', exact: true }).click()
  await visible(history.getByText(/^Resume acknowledged for this summary only/))
  const restart = history.getByRole('button', { name: 'Restart with current settings', exact: true })
  await until(() => restart.isEnabled(), 'The refreshed subject permits a separate new-generation intent.')
  const gate = deferred()
  state.onSummaryAction = async () => {
    await gate.promise
    return { commit: true, status: 503, body: { error: { code: 'unavailable', message: 'Summary restart acknowledgement was interrupted.' } } }
  }
  await restart.click()
  const confirmation = await visible(history.getByRole('region', { name: 'Confirm summary restart', exact: true }))
  const confirm = confirmation.getByRole('button', { name: 'Confirm restart with current settings', exact: true })
  await confirm.click()
  await until(() => posts(state).length === 2, 'The explicit restart was sent once.')
  assert.equal(await confirm.isDisabled(), true)
  gate.resolve()
  await visible(history.getByText(/Summary restart acknowledgement was interrupted/))
  await until(() => confirm.isEnabled(), 'An ambiguous acknowledgement can retry its original intent.')
  await confirm.click()
  await visible(history.getByText(/^Restart acknowledged for this summary only/))
  const requests = posts(state)
  assert.deepEqual(requests.map(request => request.path.split('/').at(-1)), ['retry', 'restart', 'restart'])
  assert.deepEqual(requests.map(request => request.body), [{}, { confirmRestart: true }, { confirmRestart: true }])
  assert.notEqual(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key'])
  assert.equal(requests[1].headers['idempotency-key'], requests[2].headers['idempotency-key'])
  assert.equal(requests[1].headers['if-match'], '"summary-record-1"')
  assert.equal(requests[1].headers['if-match'], requests[2].headers['if-match'])
  assert.equal(state.summaryActions, 2)
  assert.equal(JSON.stringify(state.summary(null).comparisons), candidatePublications)
})

test('disabled new-summary admission blocks restart but leaves accepted-generation resume available', async (t) => {
  const { page, state } = await setup(t, { result: true, features: { realAnalyses: false, analysisSummaryGeneration: false },
    summaryOptions: { candidateStatus: 'failed', targetStatus: 'failed', hasHistory: true } })
  const recorded = state.history({ kind: 'candidate', subjectId: 'comparison-1' })
  recorded.capabilities = { canPublish: true, canRetry: true, canResume: true, canRestart: true }
  const { history } = await openCandidateHistory(page)
  assert.equal(await history.getByRole('button', { name: 'Restart with current settings', exact: true }).isDisabled(), true)
  await visible(history.getByText(/The summary generation service is unavailable/))
  assert.equal(posts(state).length, 0)
  await history.getByRole('button', { name: 'Resume saved attempt', exact: true }).click()
  await visible(history.getByText(/^Resume acknowledged for this summary only/))
  assert.deepEqual(posts(state).map(request => request.path.split('/').at(-1)), ['retry'])
})

test('private summary pages retain earlier generations and exclude reductions and stale inputs from final selection', async (t) => {
  const { page, state } = await setup(t, { result: true, summaryOptions: { candidateStatus: 'failed', targetStatus: 'failed' } })
  const recorded = state.history({ kind: 'candidate', subjectId: 'comparison-1' })
  recorded.entries.push(...summaryHistoryFixture(state.fixture).entries, ...summaryHistoryFixture(state.fixture).entries)
  const { history } = await openCandidateHistory(page)
  assert.equal(await history.getByRole('article').count(), 12)
  await history.getByRole('button', { name: 'Load earlier summary history', exact: true }).click()
  await until(async () => await history.getByRole('article').count() === 18, 'Every older checkpoint remains accessible through pagination.')
  assert.equal(await history.getByRole('button', { name: 'Load earlier summary history', exact: true }).count(), 0)
  assert.ok(state.requests.some(request => request.path.endsWith('/history') && request.cursor === '12'))
  const overview = page.getByRole('region', { name: 'Saved job or grade overview', exact: true })
  const targetHistory = state.history({ kind: 'target', subjectId: 'target-job-v1' })
  const reduction = structuredClone(targetHistory.entries[0])
  reduction.id = randomUUID()
  reduction.scopeId = `reduction-${'d'.repeat(64)}`
  reduction.draft.kind = 'reduction'
  const stale = structuredClone(targetHistory.entries[0])
  stale.id = randomUUID()
  stale.inputFingerprint = 'b'.repeat(64)
  targetHistory.entries.unshift(reduction, stale)
  await overview.getByRole('button', { name: 'History: Job / grade overview', exact: true }).click()
  const targetPanel = await visible(overview.getByRole('region', { name: 'Summary history: Job / grade overview', exact: true }))
  await visible(targetPanel.getByText('Supporting reduction only · cannot be selected as a final summary.', { exact: true }))
  for (const entry of [reduction, stale]) {
    assert.equal(await targetPanel.getByRole('article', { name: `Summary checkpoint ${entry.id}`, exact: true })
      .getByRole('button', { name: 'Use this draft', exact: true }).count(), 0)
  }
  await visible(targetPanel.getByText('Historical saved inputs differ from the current summary. This draft cannot be published for the current input.', { exact: true }))
  assert.equal(posts(state).length, 0)
})

test('viewers have no private draft controls; archived owners can inspect history but cannot publish or retry', async (t) => {
  const viewer = await setup(t, { role: 'viewer', result: true, summaryOptions: { candidateStatus: 'failed', targetStatus: 'failed' } })
  assert.equal(await viewer.page.getByRole('button', { name: /^History:/ }).count(), 0)
  const viewerManager = await openManager(viewer.page)
  assert.equal(await viewerManager.getByText('All summary histories', { exact: true }).count(), 0)
  assert.equal(viewer.state.requests.filter(request => request.path.endsWith('/history')).length, 0)
  const archived = await setup(t, { archived: true, result: true, summaryOptions: { candidateStatus: 'failed', targetStatus: 'failed' } })
  const { history } = await openCandidateHistory(archived.page)
  assert.equal(await history.getByRole('article').count(), 6)
  assert.equal(await history.getByRole('button', { name: 'Use this draft', exact: true }).count(), 0)
  assert.equal(await history.getByRole('button', { name: 'Retry this summary', exact: true }).isDisabled(), true)
  await visible(history.getByText(/^History remains readable/))
  assert.equal(posts(archived.state).length, 0)
})

test('legacy summary failures honestly report unrecorded history and retry one subject with an idempotent ambiguous acknowledgement', async (t) => {
  const { page, state, fixture } = await setup(t, { result: true,
    summaryOptions: { candidateStatus: 'failed', targetStatus: 'failed', previous: true } })
  const source = JSON.stringify(fixture.details)
  const recorded = state.history({ kind: 'candidate', subjectId: 'comparison-1' })
  recorded.entries = []
  const candidate = await visible(page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true }))
  await candidate.getByRole('button', { name: 'History: Candidate summary', exact: true }).click()
  const history = await visible(candidate.getByRole('region', { name: 'Summary history: Candidate summary', exact: true }))
  await visible(history.getByText(/^History was not recorded for this summary/))
  await visible(history.getByText(/Legacy publication · approval metadata was not recorded\./))
  assert.equal(await history.getByRole('button', { name: 'Restart with current settings', exact: true }).count(), 0)
  assert.equal(posts(state).length, 0)
  const gate = deferred()
  state.onSummaryAction = async () => {
    await gate.promise
    return { commit: true, status: 503, body: { error: { code: 'unavailable', message: 'Summary retry acknowledgement was interrupted.' } } }
  }
  await history.getByRole('button', { name: 'Retry this summary', exact: true }).click()
  await until(() => posts(state).length === 1, 'The explicit single-summary retry was sent.')
  assert.equal(await history.getByRole('button', { name: 'Retry this summary', exact: true }).isDisabled(), true)
  gate.resolve()
  await visible(history.getByText(/Summary retry acknowledgement was interrupted/))
  await until(() => history.getByRole('button', { name: 'Retry this summary', exact: true }).isEnabled(), 'The uncertain request can be acknowledged by repeating its key.')
  await history.getByRole('button', { name: 'Retry this summary', exact: true }).click()
  await visible(history.getByText(/^Retry acknowledged for this summary only/))
  assert.equal(state.summaryActions, 1, 'An acknowledgement retry cannot create duplicate model work.')
  assert.equal(posts(state).length, 2)
  assert.deepEqual(posts(state).map(request => request.body), [{}, {}])
  assert.ok(posts(state).every(request => request.path.endsWith('/summaries/candidate/comparison-1/retry')))
  assert.equal(posts(state)[0].headers['idempotency-key'], posts(state)[1].headers['idempotency-key'])
  assert.equal(posts(state)[0].headers['if-match'], posts(state)[1].headers['if-match'])
  assert.equal(JSON.stringify(fixture.details), source)
})

test('manual draft publication keeps its original mutation key and ETag across an ambiguous error and explicit history refresh', async (t) => {
  for (const commit of [false, true]) {
    const { page, state } = await setup(t, { result: true, summaryOptions: { candidateStatus: 'failed', targetStatus: 'failed' } })
    const { history } = await openCandidateHistory(page)
    state.onSummaryAction = async () => posts(state).length === 1
      ? { commit, status: 503, body: { error: { code: 'unavailable', message: 'Manual publication acknowledgement was interrupted.' } } } : null
    await history.getByRole('button', { name: 'Use this draft', exact: true }).first().click()
    await history.getByRole('button', { name: 'Confirm manual publication', exact: true }).click()
    await visible(history.getByText(/Manual publication acknowledgement was interrupted/))
    if (commit) await visible(history.getByText('Matches current published text', { exact: true }).first())
    state.history({ kind: 'candidate', subjectId: 'comparison-1' }).etag = '"history-was-refreshed"'
    await history.getByRole('button', { name: 'Refresh summary history', exact: true }).click()
    await until(() => history.getByRole('button', { name: 'Use this draft', exact: true }).first().isEnabled(), 'History refreshed after the ambiguous acknowledgement.')
    await history.getByRole('button', { name: 'Use this draft', exact: true }).first().click()
    await history.getByRole('button', { name: 'Confirm manual publication', exact: true }).click()
    await visible(history.getByText(/^Manual publication acknowledged/))
    assert.equal(state.summaryActions, 1, 'Acknowledgement recovery does not publish a second artifact.')
    assert.equal(posts(state).length, 2)
    assert.equal(posts(state)[0].headers['idempotency-key'], posts(state)[1].headers['idempotency-key'])
    assert.equal(posts(state)[0].headers['if-match'], posts(state)[1].headers['if-match'])
    assert.deepEqual(posts(state)[0].body, posts(state)[1].body)
  }
})

test('repeated failures are grouped while each subject history stays reachable inside one accessible management dialog', async (t) => {
  const { page, state } = await setup(t, { summaryOptions: { candidateStatus: 'failed', targetStatus: 'failed', summaryRound: 3 } })
  const dialog = await openManager(page)
  assert.equal(await dialog.getByRole('alert').filter({ hasText: 'Summary grounding needs an explicit retry.' }).count(), 1)
  await dialog.getByText('Show affected summaries and history (4)', { exact: true }).click()
  const controls = dialog.getByRole('button', { name: /^History:/ })
  assert.equal(await controls.count(), 4)
  await controls.first().click()
  const history = await visible(dialog.getByRole('region', { name: /^Summary history: Candidate summary/ }).first())
  await visible(history.getByText('Full candidate draft', { exact: true }).first())
  await history.getByRole('button', { name: 'Use this draft', exact: true }).first().click()
  await visible(history.getByRole('region', { name: 'Confirm manual summary publication', exact: true }))
  assert.equal(await page.getByRole('dialog').count(), 1, 'Manual approval stays inline instead of nesting modals.')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await until(() => page.evaluate(() => document.activeElement.textContent === 'Manage summaries'), 'History retains the manager focus boundary.')
  assert.equal(posts(state).length, 0)
})

test('private history requests are aborted on closure and workspace changes without exposing late drafts', async (t) => {
  for (const switchWorkspace of [false, true]) {
    const { page, state } = await setup(t, { result: true, summaryOptions: { candidateStatus: 'failed', targetStatus: 'failed' } })
    const gate = deferred()
    let started = false
    state.beforeHistoryGet = async () => { started = true; await gate.promise }
    const candidate = await visible(page.getByRole('region', { name: 'Saved candidate assessment summary', exact: true }))
    await candidate.getByRole('button', { name: 'History: Candidate summary', exact: true }).click()
    await until(() => started, 'The private history request is pending.')
    if (switchWorkspace) await page.getByRole('button', { name: 'Switch fixture workspace', exact: true }).click()
    else await candidate.getByRole('button', { name: 'Close history: Candidate summary', exact: true }).click()
    gate.resolve()
    await page.waitForTimeout(250)
    assert.equal(await page.getByText(/^Retained candidate draft/).count(), 0)
    assert.equal(posts(state).length, 0)
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('Retained candidate draft'))), false)
  }
})
