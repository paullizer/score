import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build, stop } from 'esbuild'
import { chromium } from 'playwright'

const directory = resolve(`.sidebar-browser-${randomUUID()}`)
const timestamp = '2026-09-18T12:00:00.000Z'
const workspaceId = 'workspace-one'
const user = { id: 'reviewer', tenantId: 'tenant', name: 'Morgan Reviewer', email: 'morgan.reviewer@example.test' }
let browser, domain, server

async function serve() {
  const html = (await readFile('index.html', 'utf8')).replace(/<script type="module" src="\/src\/main\.tsx"><\/script>/, '<link rel="stylesheet" href="/browser.css"><script type="module" src="/browser.js"></script>')
  const instance = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path.startsWith('/api/')) { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'not_found', message: 'Unmocked sidebar request.' } })); return }
    response.writeHead(200, { 'Content-Type': path === '/browser.js' ? 'application/javascript' : path === '/browser.css' ? 'text/css' : 'text/html' })
    response.end(path === '/browser.js' ? await readFile(join(directory, 'browser.js')) : path === '/browser.css' ? await readFile(join(directory, 'browser.css')) : html)
  })
  await new Promise((done) => instance.listen(0, '127.0.0.1', done))
  return { origin: `http://127.0.0.1:${instance.address().port}`, close: () => new Promise((done) => { instance.close(done); instance.closeAllConnections() }) }
}

before(async () => {
  await mkdir(directory)
  await build({
    entryPoints: [join('src', 'main.tsx')], outfile: join(directory, 'browser.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
    loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
  })
  await build({
    stdin: { contents: "export { createDefaultAdminSettings } from './src/domain/admin-settings-defaults'; export { captureProcessingSettings, projectPublicSettings } from './src/domain/admin-settings-resolver';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(directory, 'domain.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  })
  domain = await import(pathToFileURL(join(directory, 'domain.mjs')).href)
  const [{ default: postcss }, { default: tailwind }, { default: autoprefixer }] = await Promise.all([import('postcss'), import('tailwindcss'), import('autoprefixer')])
  const styles = await Promise.all(['globals.css', 'admin-settings.css', 'workspace-access.css'].map(file => readFile(join('src', 'styles', file), 'utf8')))
  const css = await postcss([tailwind(), autoprefixer()]).process(styles.join('\n'), { from: join('src', 'styles', 'globals.css') })
  await writeFile(join(directory, 'browser.css'), css.css)
  server = await serve()
  // Real scrollbars, as on Windows: headless Chromium hides them by default, which would mask layout shifts.
  const options = { headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] }
  try { browser = await chromium.launch(options) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ ...options, channel: 'msedge' })
  }
})
after(async () => {
  const closed = await Promise.allSettled([browser?.close(), server?.close()])
  const errors = closed.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  try { stop() } catch (error) { errors.push(error) }
  try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Sidebar browser test cleanup failed.')
})

async function until(check, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 30))
  }
  assert.fail(message)
}

function realJob(index, title, organization) {
  const id = `job-${index}`
  const criterion = { id: `criterion-${index}`, key: 'methods', label: 'Applies defined methods', description: 'Applies the stated methods to defined projects.', weight: 100,
    guidance: 'Review exact evidence.', requirementType: 'required', sourceParagraphId: `paragraph-${index}` }
  const rubric = { id: `rubric-${index}`, groupId: `group-${index}`, kind: 'job', jobId: id, name: `${title} rubric`, description: 'Real job rubric',
    version: 1, dataKind: 'real', createdAt: timestamp, criteria: [criterion] }
  return {
    job: { id, title, organization, location: 'Remote', arrangement: 'Remote', employmentType: 'Full time', grade: 'GS-12', series: '1530',
      source: 'url', sourceLabel: 'Captured posting', documentId: `document-${index}`, rubricId: rubric.id, status: 'ready', createdAt: timestamp, dataKind: 'real' },
    rubric, source: { kind: 'url', displayName: 'Captured posting', url: `https://example.test/jobs/${index}` },
    etag: `"${id}"`, updatedAt: timestamp, attempts: 1, warnings: [],
  }
}

function realResume(index) {
  const id = `resume-${index}`
  return {
    resume: { id, dataKind: 'real', name: `Candidate ${index}`, role: 'Statistician', location: null, experience: null, documentId: `resume-document-${index}`,
      documentVersion: 1, sourceLabel: `candidate-${index}.pdf`, batchId: 'batch-one', status: 'ready', createdAt: timestamp },
    workspaceId, source: { kind: 'pdf', displayName: `candidate-${index}.pdf` }, capture: null, documentRef: null,
    etag: `"${id}"`, updatedAt: timestamp, attempts: 1, retryCount: 0, warnings: [], duplicates: [],
  }
}

function fixture({ admin = true, help = true } = {}) {
  const settings = domain.createDefaultAdminSettings()
  if (help) { settings.help.supportUrl = 'https://agency.example/support'; settings.help.documentationUrl = 'https://agency.example/help' }
  const capabilities = { applicationAdmin: admin, canCreateWorkspaces: true }
  const summary = { id: workspaceId, name: 'Census field review', role: 'owner', kind: 'personal', createdAt: timestamp, updatedAt: timestamp, etag: '"metadata-1"' }
  const jobs = [realJob(1, 'Survey statistician', 'Bureau of the Census'), realJob(2, 'Program analyst', 'Bureau of the Census'), realJob(3, 'IT specialist (security)', 'Census field operations')]
  const resumes = Array.from({ length: 6 }, (_, index) => realResume(index + 1))
  const state = { unexpected: [] }
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  state.install = page => page.route('**/api/**', async (route) => {
    const request = route.request(), path = decodeURIComponent(new URL(request.url()).pathname)
    if (path === '/api/session') return json(route, { mode: 'cloud', user, capabilities, workspaces: [summary] })
    if (path === '/api/session/identity') return json(route, { mode: 'cloud', user, capabilities })
    if (path === '/api/features') return json(route, { realJobImports: true, realGradeLadders: true, realResumeImports: true, realAnalyses: true,
      publicSettings: domain.projectPublicSettings(domain.captureProcessingSettings(settings, 'revision-1', timestamp)) })
    if (path === '/api/workspaces') return json(route, { workspaces: [summary] })
    const tail = path.startsWith(`/api/workspaces/${workspaceId}`) ? path.slice(`/api/workspaces/${workspaceId}`.length) : null
    if (tail === '/jobs') return json(route, { jobs })
    if (tail === '/resumes') return json(route, { resumes })
    if (tail === '/grade-ladders') return json(route, { ladders: [] })
    if (tail === '/analyses/targets') return json(route, { targets: [] })
    if (tail === '/analyses') return json(route, { runs: [] })
    if (tail === '/summary') return json(route, { workspaceId, jobs: { status: 'ready', count: jobs.length }, resumes: { status: 'ready', count: resumes.length }, analyses: { status: 'ready', count: 0 } })
    state.unexpected.push(`${request.method()} ${path}`)
    return json(route, { error: { code: 'not_found', message: `Unexpected sidebar request: ${path}` } }, 404)
  })
  return state
}

async function pageFor(t, { width = 1440, height = 1000, theme = 'light', collapsed, ...options } = {}) {
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15000)
  const api = fixture(options)
  await api.install(page)
  await page.addInitScript(({ theme, collapsed }) => {
    localStorage.setItem('score-theme', theme)
    if (collapsed !== undefined) localStorage.setItem('score-sidebar-collapsed', String(collapsed))
    // Records the sidebar's classes the first time it is attached, before any paint could show another state.
    new MutationObserver((records, observer) => {
      const sidebar = document.querySelector('.sidebar')
      if (!sidebar) return
      window.__initialSidebarClass = sidebar.className
      observer.disconnect()
    }).observe(document, { childList: true, subtree: true })
  }, { theme, collapsed })
  t.after(async () => {
    await context.close()
    assert.deepEqual(errors, [], 'No browser runtime errors')
    assert.deepEqual(api.unexpected, [], 'No unmocked API requests')
  })
  return page
}

async function openWorkspace(page) {
  await page.goto(`${server.origin}/workspaces/${workspaceId}/jobs`)
  await page.getByRole('heading', { name: 'Your jobs', exact: true }).waitFor()
  await page.locator('.sidebar a[href$="/jobs"] .nav-count').filter({ hasText: '3' }).waitFor({ state: 'attached' })
}

async function screenshot(page, name) {
  if (!process.env.SCORE_TEST_SCREENSHOT_DIR) return
  await mkdir(process.env.SCORE_TEST_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.SCORE_TEST_SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' })
}

async function settle(page, width) {
  await until(async () => Math.round((await page.locator('aside.sidebar').boundingBox()).width) === width, `The sidebar settles at ${width}px`)
}

function navItems() {
  return [...document.querySelectorAll('.sidebar .nav-item')].map((item) => {
    const box = item.getBoundingClientRect(), icon = item.querySelector('svg').getBoundingClientRect()
    const label = item.querySelector('.nav-label'), labelBox = label.getBoundingClientRect()
    return {
      label: label.textContent, tag: item.tagName.toLowerCase(), group: item.closest('.sidebar-links') ? 'bottom' : item.closest('nav') ? 'main' : 'home',
      left: box.left, width: box.width, height: box.height, fontSize: getComputedStyle(item).fontSize,
      iconLeft: icon.left, iconCenter: icon.left + icon.width / 2, iconWidth: icon.width, labelLeft: labelBox.left, labelWidth: labelBox.width, title: item.getAttribute('title'),
    }
  })
}

function railGeometry() {
  const rect = (selector) => { const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height, center: x + width / 2 } }
  const sidebar = document.querySelector('.sidebar')
  return {
    horizontalOverflow: sidebar.scrollWidth - sidebar.clientWidth, mark: rect('.sidebar .brand-mark'), toggle: rect('.sidebar-toggle'),
    monogram: rect('.sidebar .workspace-monogram'), avatar: rect('.sidebar .account-panel .avatar'), signOut: rect('.sidebar .account-panel button'),
    hidden: ['.brand-title', '.workspace-switcher-trigger > div', '.nav-heading', '.sidebar-utility-label', '.account-panel-identity'].map((selector) => rect(`.sidebar ${selector}`).width),
    theme: [...document.querySelectorAll('.sidebar .theme-control button')].map((button) => { const { x, y, height } = button.getBoundingClientRect(); return { x, y, height } }),
  }
}

const labels = { home: ['All workspaces'], main: ['Jobs', 'Resumes', 'Rubrics', 'Analyses'], bottom: ['Application settings', 'Users / user access', 'About Score', 'Support', 'Documentation'] }
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 0.5, `${message}: ${actual} is not ${expected}`)

for (const theme of ['light', 'dark']) test(`desktop sidebar collapses to a centered icon rail and remembers the choice in ${theme} mode`, { timeout: 90000 }, async (t) => {
  const page = await pageFor(t, { theme })
  await openWorkspace(page)
  const sidebar = page.locator('aside.sidebar')
  assert.equal(await page.evaluate(() => window.__initialSidebarClass), 'sidebar')
  assert.equal(await sidebar.getAttribute('id'), 'primary-navigation')
  await settle(page, 228)
  const toggle = await page.$('.sidebar-toggle')
  assert.deepEqual(await toggle.evaluate((element) => [element.tagName, element.type, element.getAttribute('aria-label'), element.getAttribute('aria-expanded'), element.getAttribute('aria-controls'), element.title]),
    ['BUTTON', 'button', 'Collapse navigation', 'true', 'primary-navigation', 'Collapse navigation'])

  // Administration, About, and help links use the main navigation's exact item styling and alignment.
  const expanded = await page.evaluate(navItems)
  for (const [group, names] of Object.entries(labels)) assert.deepEqual(expanded.filter((item) => item.group === group).map((item) => item.label), names)
  assert.deepEqual(expanded.filter((item) => item.group === 'bottom').map((item) => item.tag), ['button', 'button', 'button', 'a', 'a'])
  for (const item of expanded) {
    assert.equal(item.fontSize, '13px', item.label); assert.equal(item.iconWidth, 18, item.label); assert.equal(item.title, null, item.label)
    for (const key of ['left', 'width', 'iconLeft', 'labelLeft']) close(item[key], expanded[0][key], `${item.label} ${key}`)
  }
  for (const [name, href] of [['Support', 'https://agency.example/support'], ['Documentation', 'https://agency.example/help']]) {
    const link = sidebar.getByRole('link', { name, exact: true })
    assert.deepEqual(await link.evaluate((element) => [element.getAttribute('href'), element.target, element.rel]), [href, '_blank', 'noopener noreferrer'])
  }

  // The retired note, preview labels, duplicate QC entry, and top-bar chip are gone.
  const body = await page.locator('body').innerText()
  for (const removed of [/Evidence, not impressions/i, /Traceable matches/i, /About this (preview|application)/i, /UI preview/i, /Enter QC mode/i]) assert.doesNotMatch(body, removed)
  assert.equal(await page.locator('.about-chip, .sidebar-note, .sidebar-version').count(), 0)
  assert.deepEqual(await page.locator('.topbar-actions').getByRole('button').allInnerTexts(), ['QC mode', 'New analysis'])

  const aboutButton = sidebar.getByRole('button', { name: 'About Score', exact: true })
  await aboutButton.click()
  const about = page.getByRole('dialog', { name: 'About Score', exact: true })
  await about.getByText('How it works, current limits, and privacy', { exact: true }).waitFor()
  assert.doesNotMatch(await about.innerText(), /UI preview|interactive preview/i)
  await about.getByRole('button', { name: 'Back to the workspace', exact: true }).click()
  await about.waitFor({ state: 'hidden' })
  // Radix restores focus in a task after the dialog unmounts, so wait for it rather than sampling once.
  await until(() => aboutButton.evaluate((element) => element === document.activeElement), 'Closing About returns focus to the sidebar item')
  await screenshot(page, `sidebar-expanded-1440-${theme}`)

  // The same toggle element keeps keyboard focus while the rail collapses.
  await toggle.focus()
  await page.keyboard.press('Enter')
  await settle(page, 77)
  assert.deepEqual(await toggle.evaluate((element) => [element.isConnected, element === document.activeElement, element.getAttribute('aria-label'), element.getAttribute('aria-expanded'), element.title]),
    [true, true, 'Expand navigation', 'false', 'Expand navigation'])
  assert.equal(await page.evaluate(() => localStorage.getItem('score-sidebar-collapsed')), 'true')
  assert.match(await sidebar.getAttribute('class'), /\bis-collapsed\b/)

  const rail = await sidebar.boundingBox()
  const railCenter = rail.x + (rail.width - 1) / 2
  const collapsed = await page.evaluate(navItems)
  assert.deepEqual(collapsed.map((item) => item.label), expanded.map((item) => item.label))
  const counts = Object.fromEntries(await page.locator('.sidebar nav .nav-item').evaluateAll((items) => items.map((item) => [item.querySelector('.nav-label').textContent, item.querySelector('.nav-count').textContent])))
  for (const item of collapsed) {
    close(item.iconCenter, railCenter, `${item.label} icon is centered`)
    assert.equal(item.height, 44, item.label); assert.equal(item.iconWidth, 18, item.label)
    assert.ok(item.labelWidth <= 1, `${item.label} is visually hidden`)
    assert.equal(item.title, item.group === 'main' ? `${item.label} · ${counts[item.label]}` : item.label)
  }
  assert.equal(counts.Jobs, '3')
  const geometry = await page.evaluate(railGeometry)
  assert.ok(geometry.horizontalOverflow <= 0, 'The rail never scrolls sideways')
  for (const key of ['mark', 'toggle', 'monogram', 'avatar', 'signOut']) close(geometry[key].center, railCenter, `${key} is centered`)
  assert.ok(geometry.toggle.y >= geometry.mark.y + geometry.mark.height, 'The expand button sits under the brand mark')
  assert.ok(geometry.signOut.y >= geometry.avatar.y + geometry.avatar.height, 'Sign out is stacked under the avatar')
  for (const width of geometry.hidden) assert.ok(width <= 1, 'Collapsed labels are visually hidden')
  assert.equal(geometry.theme.length, 3)
  for (const [index, button] of geometry.theme.entries()) {
    close(button.x, geometry.theme[0].x, 'Theme buttons share one column')
    if (index) assert.ok(button.y >= geometry.theme[index - 1].y + geometry.theme[index - 1].height, 'Theme buttons stack vertically')
  }
  assert.equal(await sidebar.getByRole('link', { name: 'Score home', exact: true }).getAttribute('title'), 'Score home')
  assert.equal(await sidebar.locator('.workspace-switcher-trigger').getAttribute('title'), 'Census field review\nOwner · cloud')
  assert.equal(await sidebar.locator('.account-panel .avatar').getAttribute('title'), `${user.name}\n${user.email}`)

  // Accessible names and existing selectors survive the visual collapse.
  await sidebar.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: /Rubrics/ }).waitFor()
  for (const name of ['All workspaces', 'Application settings', 'Users / user access', 'About Score', 'Sign out', 'Use light theme', 'Expand navigation']) await sidebar.getByRole('button', { name, exact: true }).waitFor()
  for (const name of ['Support', 'Documentation']) await sidebar.getByRole('link', { name, exact: true }).waitFor()
  await page.evaluate(() => document.activeElement?.blur())
  await screenshot(page, `sidebar-collapsed-1440-${theme}`)

  await sidebar.getByRole('link', { name: /^Analyses/ }).click()
  await until(async () => new URL(page.url()).pathname === `/workspaces/${workspaceId}/analyses`, 'The collapsed rail still navigates')
  assert.equal(await sidebar.getByRole('link', { name: /^Analyses/ }).getAttribute('aria-current'), 'page')
  await page.reload()
  await sidebar.locator('.workspace-switcher-trigger').waitFor()
  assert.equal(await page.evaluate(() => window.__initialSidebarClass), 'sidebar is-collapsed', 'A saved collapse applies on first render, without an expanded flash')
  assert.equal(Math.round((await sidebar.boundingBox()).width), 77)

  await sidebar.getByRole('button', { name: 'Expand navigation', exact: true }).click()
  await settle(page, 228)
  assert.equal(await page.evaluate(() => localStorage.getItem('score-sidebar-collapsed')), 'false')
  assert.equal(await sidebar.getByRole('button', { name: 'Collapse navigation', exact: true }).getAttribute('aria-expanded'), 'true')
  for (const item of await page.evaluate(navItems)) { assert.ok(item.labelWidth > 1, `${item.label} is visible again`); assert.equal(item.title, null) }
})

test('short desktop viewports keep the main navigation visible and pin appearance and account', { timeout: 90000 }, async (t) => {
  const page = await pageFor(t, { height: 700 })
  await openWorkspace(page)
  for (const collapsed of [false, true]) {
    if (collapsed) {
      await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click()
      await settle(page, 77)
    }
    const layout = await page.evaluate(() => {
      const scroll = document.querySelector('.sidebar-scroll'), sidebar = document.querySelector('.sidebar')
      return {
        scrollBottom: scroll.getBoundingClientRect().bottom, scrolls: scroll.scrollHeight > scroll.clientHeight, sidebarOverflow: sidebar.scrollHeight - sidebar.clientHeight,
        navBottom: Math.max(...[...document.querySelectorAll('.sidebar nav .nav-item')].map((item) => item.getBoundingClientRect().bottom)),
        accountBottom: document.querySelector('.sidebar .account-panel').getBoundingClientRect().bottom,
      }
    })
    assert.ok(layout.navBottom <= layout.scrollBottom, `Every main navigation item is in view (${collapsed ? 'collapsed' : 'expanded'})`)
    assert.ok(layout.accountBottom <= 700, 'Appearance and account stay pinned in view')
    assert.equal(layout.sidebarOverflow, 0)
    assert.equal(layout.scrolls, true, 'Only the navigation region scrolls')
    if (collapsed) {
      // A scrolling rail keeps every icon, inside or outside the scroll region, on one centered column.
      const rail = await page.locator('aside.sidebar').boundingBox()
      const railCenter = rail.x + (rail.width - 1) / 2
      for (const item of await page.evaluate(navItems)) {
        assert.equal(item.width, 44, `${item.label} keeps its square hit area while scrolling`)
        close(item.iconCenter, railCenter, `${item.label} icon stays centered while scrolling`)
      }
      const geometry = await page.evaluate(railGeometry)
      for (const key of ['mark', 'toggle', 'monogram', 'avatar', 'signOut']) close(geometry[key].center, railCenter, `${key} stays centered while scrolling`)
    }
    const documentation = page.locator('.sidebar').getByRole('link', { name: 'Documentation', exact: true })
    await documentation.scrollIntoViewIfNeeded()
    const box = await documentation.boundingBox()
    assert.ok(box.y + box.height <= layout.scrollBottom + 0.5, 'The help links remain reachable by scrolling')
    await page.locator('.sidebar-scroll').evaluate((element) => { element.scrollTop = 0 })
  }
})

for (const theme of ['light', 'dark']) test(`mobile drawer mirrors the sidebar and ignores the collapsed preference in ${theme} mode`, { timeout: 90000 }, async (t) => {
  const page = await pageFor(t, { width: 390, height: 900, theme, collapsed: true })
  await openWorkspace(page)
  assert.equal(await page.locator('aside.sidebar').isVisible(), false)
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  await menu.click()
  const drawer = page.getByRole('dialog', { name: 'Your workspace', exact: true })
  await drawer.getByRole('button', { name: 'All workspaces', exact: true }).waitFor()
  const order = await drawer.evaluate((dialog) => [
    [...dialog.querySelectorAll('button.nav-item')].find((item) => item.textContent.trim() === 'All workspaces'),
    dialog.querySelector('.workspace-switcher-trigger'), dialog.querySelector('.account-panel'), dialog.querySelector('nav[aria-label="Main navigation"]'),
    dialog.querySelector('.sidebar-links'), dialog.querySelector('.mobile-appearance'),
  ].map((element) => element?.getBoundingClientRect().top ?? null))
  assert.ok(order.every((top, index) => top !== null && (index === 0 || top > order[index - 1])), `Drawer order follows the sidebar: ${order}`)
  for (const name of ['Application settings', 'Users / user access', 'About Score', 'Sign out', 'Use light theme']) await drawer.getByRole('button', { name, exact: true }).waitFor()
  for (const name of ['Support', 'Documentation']) await drawer.getByRole('link', { name, exact: true }).waitFor()
  assert.equal(await drawer.getByText(/Enter QC mode/).count(), 0)
  assert.equal(await drawer.locator('.nav-item[title]').count(), 0, 'The drawer never uses collapsed tooltips')
  for (const width of await drawer.locator('.nav-label').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width))) assert.ok(width > 1, 'Drawer labels stay visible')
  await screenshot(page, `sidebar-drawer-390-${theme}`)

  // About replaces the drawer; closing it returns focus to the menu button.
  await drawer.getByRole('button', { name: 'About Score', exact: true }).click()
  const about = page.getByRole('dialog', { name: 'About Score', exact: true })
  await about.waitFor()
  await drawer.waitFor({ state: 'hidden' })
  await page.keyboard.press('Escape')
  await about.waitFor({ state: 'hidden' })
  await until(() => menu.evaluate((element) => element === document.activeElement), 'Focus returns to the navigation menu button')
  assert.equal(await page.evaluate(() => localStorage.getItem('score-sidebar-collapsed')), 'true', 'The drawer leaves the desktop preference unchanged')
})

