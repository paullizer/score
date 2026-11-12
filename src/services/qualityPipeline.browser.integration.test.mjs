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
import { pipelineFixture, pipelineUser, pipelineWorkspace } from './qualityPipeline.test-support.mjs'

const output = resolve('node_modules', '.cache', `quality-pipeline-browser-${randomUUID()}`)
let browser, server, origin
before(async () => {
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { QualityPipelinePage } from './src/features/admin/quality-pipeline/QualityPipelinePage'
      import { CloudApplication } from './src/app/CloudApplication'
      import { AccessSuspendedContext } from './src/app/access-suspended-context'
      import { setCloudSessionAccess } from './src/services/cloudWorkspace'
      function Harness() {
        const [workspaces, setWorkspaces] = useState(window.pipelineHarness.workspaces)
        const [suspended, setSuspended] = useState(false)
        window.revokePipelineMembership = () => {
          const next = workspaces.map(item => ({ ...item, membershipRole: undefined }))
          setCloudSessionAccess({ ...window.pipelineHarness, workspaces: next })
          setWorkspaces(next)
        }
        window.suspendPipelineAccess = () => {
          setCloudSessionAccess({ ...window.pipelineHarness, capabilities: { applicationAdmin: false }, workspaces: [] })
          setSuspended(true)
        }
        return <AccessSuspendedContext.Provider value={suspended}><QualityPipelinePage
          user={window.pipelineHarness.user} workspaces={workspaces} directoryReady directoryError={null}
          onRefreshDirectory={async () => {}} onLeave={() => {}} onOpenSettings={async () => {}}
        /></AccessSuspendedContext.Provider>
      }
      if (!window.pipelineHarness.cloud) setCloudSessionAccess(window.pipelineHarness)
      createRoot(document.getElementById('root')).render(window.pipelineHarness.cloud ? <CloudApplication /> : <Harness />)
    ` },
    outfile: join(output, 'app.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"test"' },
  })
  const js = await readFile(join(output, 'app.js')), css = await readFile(join(output, 'app.css'))
  const globals = await postcss([tailwindcss(tailwindConfig), autoprefixer]).process(await readFile(join('src', 'styles', 'globals.css'), 'utf8'),
    { from: join('src', 'styles', 'globals.css') })
  const html = (await readFile('index.html', 'utf8')).replace('src="/src/main.tsx"', 'src="/app.js"')
    .replace('</head>', '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/app.css"></head>')
  server = createServer((request, response) => {
    const asset = request.url === '/app.js' ? [js, 'text/javascript'] : request.url === '/app.css' ? [css, 'text/css']
      : request.url === '/styles.css' ? [globals.css, 'text/css'] : [html, 'text/html']
    response.writeHead(200, { 'Content-Type': asset[1] }); response.end(asset[0])
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

async function setup(t, { mobile = false, cloud = false } = {}) {
  const fixture = pipelineFixture()
  const context = await browser.newContext({
    viewport: mobile ? { width: 430, height: 932 } : { width: 1536, height: 1080 }, colorScheme: mobile ? 'dark' : 'light',
  })
  t.after(() => context.close())
  await context.addInitScript(options => { window.pipelineHarness = options }, {
    mode: 'cloud', user: pipelineUser, capabilities: { applicationAdmin: true }, workspaces: [pipelineWorkspace], cloud,
  })
  const page = await context.newPage()
  page.setDefaultTimeout(12_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, [], 'No render errors'))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    let response
    if (path === '/api/session/identity') response = Response.json({ mode: 'cloud', user: pipelineUser, capabilities: { applicationAdmin: true } })
    else if (path === '/api/session') response = Response.json({ mode: 'cloud', user: pipelineUser, capabilities: { applicationAdmin: true }, workspaces: [pipelineWorkspace] })
    else if (path === '/api/features') response = Response.json({ error: { code: 'unavailable', message: 'Current policy is temporarily unavailable.' } }, { status: 503 })
    else response = await fixture.fetch(request.url(), { method: request.method(), headers: request.headers() })
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  })
  return { fixture, page }
}
const go = (page, query = 'workspace=workspace-one&plan=plan-one') => page.goto(`${origin}/admin/quality-pipeline?${query}`)
async function screenshot(page, name) {
  if (!process.env.SCORE_TEST_ARTIFACTS) return
  await mkdir(process.env.SCORE_TEST_ARTIFACTS, { recursive: true })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: join(process.env.SCORE_TEST_ARTIFACTS, name), fullPage: true })
}

for (const mobile of [false, true]) {
  test(`pipeline browser: ${mobile ? 'mobile dark' : 'desktop light'} map, focus, exact pins and native links`, async t => {
    const { page, fixture } = await setup(t, { mobile })
    await go(page)
    await page.getByRole('button', { name: 'Focus selected path', exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('button[aria-pressed][disabled]'))
    await page.locator('[data-pipeline-node="tasks"]').click()
    await page.getByRole('heading', { name: 'Affected AI tasks', exact: true }).waitFor()
    assert.equal(await page.getByText('Proposed change', { exact: true }).count(), 1)
    assert.equal(await page.getByText('Unchanged', { exact: true }).count(), 3)
    await page.getByRole('button', { name: 'Focus selected path', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Show full map', exact: true }).getAttribute('aria-pressed'), 'true')
    await page.getByRole('button', { name: 'Back to map', exact: true }).click()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-pipeline-node')), 'tasks')
    assert.match(page.url(), /node=tasks/)
    assert.match(page.url(), /focus=1/)
    assert.equal(await page.getByRole('link', { name: 'Open exact evaluation', exact: true }).getAttribute('href'),
      '/workspaces/workspace-one/qc/improvements/plan-one#evaluation')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal page overflow')
    if (!mobile) {
      const graph = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-pipeline-node]')].map(element => element.getBoundingClientRect().toJSON())
        const overlaps = cards.some((a, index) => cards.slice(index + 1).some(b =>
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1))
        return { overlaps, paths: [...document.querySelectorAll('.pipeline-edge')].map(path => path.getAttribute('d')) }
      })
      assert.equal(graph.overlaps, false)
      assert.ok(graph.paths.length > 0)
      assert.ok(graph.paths.every(path => !/NaN|Infinity/.test(path)))
    }
    await page.getByRole('button', { name: 'Show full map', exact: true }).click()
    await screenshot(page, mobile ? 'quality-pipeline-mobile-dark.png' : 'quality-pipeline-desktop.png')
    await page.locator('[data-pipeline-node="results"]').click()
    const exactReview = page.getByRole('link', { name: 'Open exact QC review', exact: true }).first()
    assert.match(await exactReview.getAttribute('href'), /resultRevision=original&resultSha256=a{64}/)
    assert.ok(fixture.requests.every(request => request.method === 'GET'), 'The map makes no mutations')
    assert.equal(fixture.requests.some(request => /\/peers|\/qc\/plans\/|\/jobs|\/resumes/.test(request.path)), false)
  })
}

test('pipeline browser: transient failure is visibly stale; denied access clears all saved metadata', async t => {
  const { page, fixture } = await setup(t)
  await go(page)
  await page.getByText('Saved state: ready', { exact: true }).waitFor()
  fixture.override = url => url.pathname.endsWith('/plans/plan-one')
    ? Response.json({ error: { code: 'unavailable', message: 'Saved metadata cannot be read right now.' } }, { status: 503 }) : null
  await page.getByRole('button', { name: 'Refresh pipeline', exact: true }).click()
  await page.getByText(/Showing the last successful saved path/).waitFor()
  fixture.override = url => url.pathname.includes('/quality-pipeline/workspaces/')
    ? Response.json({ error: { code: 'forbidden', message: 'Explicit QC membership was revoked.' } }, { status: 403 }) : null
  await page.getByRole('button', { name: 'Refresh pipeline', exact: true }).click()
  await page.getByText(/Saved metadata has been cleared/).waitFor()
  assert.equal(await page.getByText('Saved state: ready', { exact: true }).count(), 0)
  assert.equal(await page.getByText('Assessment guidance candidate', { exact: false }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Focus selected path', exact: true }).isDisabled(), true)
})

test('pipeline browser: a late response cannot restore data after membership or admin suspension', async t => {
  const { page, fixture } = await setup(t)
  let release
  fixture.override = url => url.pathname.endsWith('/plans/plan-one') ? new Promise(resolve => { release = resolve }) : null
  await go(page)
  await page.waitForFunction(() => document.querySelector('[aria-label="Follow an improvement plan"]')?.options.length > 1)
  await page.evaluate(() => window.revokePipelineMembership())
  await page.getByText(/QC metadata requires explicit membership/).waitFor()
  release(Response.json(fixture.detail))
  assert.equal(await page.getByText('Saved state: ready', { exact: true }).count(), 0)
  await page.evaluate(() => window.suspendPipelineAccess())
  assert.equal(await page.locator('.pipeline-graph').count(), 0)
})

test('pipeline browser: direct admin routing reads only authorized metadata, even when policy is unavailable', async t => {
  const { page, fixture } = await setup(t, { cloud: true })
  await go(page)
  await page.getByRole('heading', { name: 'Quality pipeline', exact: true }).waitFor()
  await page.getByText('Saved state: ready', { exact: true }).waitFor()
  assert.ok(fixture.requests.some(request => request.path.endsWith('/plans/plan-one')))
  assert.equal(fixture.requests.some(request => /\/jobs|\/resumes|\/grade-ladders|\/analyses|\/state/.test(request.path)), false)
})
