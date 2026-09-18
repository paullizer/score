import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { before, after, test } from 'node:test'
import { build, stop } from 'esbuild'
import { chromium } from 'playwright'

const directory = resolve(`.lifecycle-browser-${randomUUID()}`)
const timestamp = '2026-09-18T12:00:00.000Z'
const storageKey = 'score-demo-workspace-v1'
const emptyState = () => ({ schemaVersion: 1, jobs: [], resumes: [], documents: [], rubrics: [], runs: [] })
const clone = (value) => structuredClone(value)
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
let browser, domain, localServer, cloudServer

async function serve(mode) {
  const html = (await readFile('index.html', 'utf8')).replace(/<script type="module" src="\/src\/main\.tsx"><\/script>/, '<link rel="stylesheet" href="/browser.css"><script type="module" src="/browser.js"></script>')
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path.startsWith('/api/')) { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'not_found', message: 'Unmocked lifecycle request.' } })); return }
    response.writeHead(200, { 'Content-Type': path === '/browser.js' ? 'application/javascript' : path === '/browser.css' ? 'text/css' : 'text/html' })
    response.end(path === '/browser.js' ? await readFile(join(directory, `${mode}.js`)) : path === '/browser.css' ? await readFile(join(directory, 'browser.css')) : html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}

before(async () => {
  await mkdir(directory)
  await Promise.all(['local', 'cloud'].map((mode) => build({
    entryPoints: [join('src', 'main.tsx')], outfile: join(directory, `${mode}.js`), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
    loader: { '.css': 'empty' }, define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': JSON.stringify(mode), 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
  })))
  await build({
    stdin: { contents: "export * from './src/data/fixtures'; export * from './src/domain/lifecycle'; export { gradeHeadId } from './src/domain/real-grades';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(directory, 'domain.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  })
  domain = await import(pathToFileURL(join(directory, 'domain.mjs')).href)
  const [{ default: postcss }, { default: tailwind }, { default: autoprefixer }] = await Promise.all([import('postcss'), import('tailwindcss'), import('autoprefixer')])
  const css = await postcss([tailwind(), autoprefixer()]).process(await readFile(join('src', 'styles', 'globals.css'), 'utf8'), { from: join('src', 'styles', 'globals.css') })
  await writeFile(join(directory, 'browser.css'), css.css)
  localServer = await serve('local'); cloudServer = await serve('cloud')
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  }
})
after(async () => {
  const closed = await Promise.allSettled([browser?.close(), localServer?.close(), cloudServer?.close()])
  const errors = closed.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  try { stop() } catch (error) { errors.push(error) }
  try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Lifecycle browser test cleanup failed.')
})

async function until(check, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.fail(message)
}

async function refreshDirectory(page) {
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspaces')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await (await response).finished()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function pageFor(t, workspace) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15000)
  if (workspace) await page.addInitScript(({ workspace, storageKey }) => {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(workspace))
  }, { workspace, storageKey })
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'No browser runtime errors') })
  return page
}

async function lifecycle(page, name, action) {
  const label = action === 'delete' ? 'Permanently delete' : action === 'archive' ? 'Archive' : 'Unarchive'
  await page.getByRole('button', { name: `${label} ${name}`, exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: `${label} ${name}?`, exact: true })
  await dialog.waitFor()
  if (action === 'delete') await dialog.getByRole('checkbox').check()
  const submit = dialog.getByRole('button', { name: label, exact: true })
  await until(() => submit.isEnabled(), `The ${action} impact must finish loading`)
  await submit.click()
  await dialog.waitFor({ state: 'hidden' })
}

async function stored(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey)
}

test('sample jobs, logical rubrics, resumes, and ladder families have complete lifecycle controls', { timeout: 90000 }, async (t) => {
  const workspace = domain.createInitialWorkspace(); workspace.runs = []
  const job = workspace.jobs[0], resume = workspace.resumes[0]
  const rubric = workspace.rubrics.find((item) => item.id === job.rubricId)
  const grade = workspace.rubrics.find((item) => item.kind === 'grade')
  const page = await pageFor(t, workspace)
  await page.goto(`${localServer.origin}/jobs`)
  await lifecycle(page, job.title, 'archive')
  assert.equal(await page.getByRole('link', { name: job.title, exact: true }).count(), 0)
  await page.getByRole('searchbox', { name: 'Search jobs, organizations...' }).fill(job.title)
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: job.title, exact: true }) })
  assert.equal(await row.getByText('Archived', { exact: true }).count() > 0, true)
  assert.equal(await row.getByRole('checkbox').isDisabled(), true)
  await row.getByRole('link', { name: job.title, exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Analyze applicants' }).isDisabled(), true)
  await lifecycle(page, rubric.name, 'archive')
  await lifecycle(page, job.title, 'unarchive')
  assert.equal(await page.getByRole('button', { name: 'Edit rubric', exact: true }).isDisabled(), true, 'Restoring the job preserves the rubric’s independent archive')
  await lifecycle(page, rubric.name, 'unarchive')
  await lifecycle(page, rubric.name, 'delete')
  await page.getByRole('heading', { name: 'No rubric', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Retry import', exact: true }).count(), 0)
  assert.equal((await stored(page)).documents.some((item) => item.id === job.documentId), true)
  assert.equal((await stored(page)).rubrics.some((item) => item.groupId === rubric.groupId), false)
  await lifecycle(page, job.title, 'delete')
  assert.equal((await stored(page)).documents.some((item) => item.id === job.documentId), false)

  await page.goto(`${localServer.origin}/resumes`)
  await lifecycle(page, resume.name, 'archive')
  await page.getByRole('combobox', { name: 'Resume archive state', exact: true }).selectOption('archived')
  assert.equal(await page.getByRole('checkbox', { name: `Select ${resume.name}`, exact: true }).isDisabled(), true)
  await lifecycle(page, resume.name, 'unarchive')
  await page.getByRole('combobox', { name: 'Resume archive state', exact: true }).selectOption('all')
  await lifecycle(page, resume.name, 'delete')
  assert.equal((await stored(page)).resumes.some((item) => item.id === resume.id), false)

  await page.goto(`${localServer.origin}/rubrics?kind=grade`)
  await lifecycle(page, grade.ladder, 'archive')
  await page.getByRole('searchbox', { name: 'Search rubric library', exact: true }).fill(grade.ladder)
  assert.equal(await page.getByRole('checkbox', { name: `Select ${grade.name}`, exact: true }).isDisabled(), true)
  await lifecycle(page, grade.ladder, 'unarchive')
  await lifecycle(page, grade.ladder, 'delete')
  assert.equal((await stored(page)).rubrics.some((item) => item.ladder === grade.ladder), false)
})

test('archived analyses remain deletion blockers and can be explicitly removed inside an archived local workspace', { timeout: 90000 }, async (t) => {
  const workspace = domain.createInitialWorkspace()
  const run = workspace.runs.find((item) => item.targets.length === 1)
  const job = run.targets[0].job
  const page = await pageFor(t, workspace)
  await page.goto(`${localServer.origin}/analyses`)
  await lifecycle(page, run.name, 'archive')
  await page.goto(`${localServer.origin}/jobs/${job.id}`)
  await page.getByRole('button', { name: `Permanently delete ${job.title}`, exact: true }).click()
  let dialog = page.getByRole('dialog', { name: `Permanently delete ${job.title}?`, exact: true })
  await dialog.getByRole('link', { name: run.name, exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).isDisabled(), true)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await lifecycle(page, 'My workspace', 'archive')
  await page.goto(`${localServer.origin}/analyses`)
  await page.getByRole('combobox', { name: 'Analysis archive state', exact: true }).selectOption('archived')
  for (const analysis of workspace.runs) await lifecycle(page, analysis.name, 'delete')
  await page.getByRole('button', { name: 'Permanently delete My workspace', exact: true }).first().click()
  dialog = page.getByRole('dialog', { name: 'Permanently delete My workspace?', exact: true })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click()
  await page.getByRole('heading', { name: 'Your local workspace was deleted' }).waitFor()
  await page.reload()
  await page.getByRole('heading', { name: 'Your local workspace was deleted' }).waitFor()
  assert.equal((await stored(page)).jobs.length, 0)
  await page.getByRole('button', { name: 'Create demo workspace', exact: true }).click()
  await page.getByRole('heading', { name: 'Your jobs', exact: true }).waitFor()
  const replacement = await stored(page)
  assert.equal(replacement.jobs.some((item) => workspace.jobs.some((previous) => previous.id === item.id)), false, 'Explicit creation uses fresh identities')
})

test('local deletion recovery recognizes any legacy root identity without reviving retained tombstones', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(); sample.runs = []
  const removed = domain.applySampleLifecycle(sample, { kind: 'workspace', id: 'legacy-local-root' }, 'delete', timestamp)
  const page = await pageFor(t, removed)
  await page.goto(`${localServer.origin}/jobs`)
  await page.getByRole('heading', { name: 'Your local workspace was deleted', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Create demo workspace', exact: true }).click()
  await page.getByRole('heading', { name: 'Your jobs', exact: true }).waitFor()
  const fresh = await stored(page)
  assert.ok(fresh.lifecycle.epoch)
  assert.equal(fresh.lifecycle.entities['workspace:legacy-local-root'].deletedAt, timestamp)
  assert.equal(fresh.jobs.some((job) => sample.jobs.some((previous) => previous.id === job.id)), false)
  await page.reload()
  await page.getByRole('heading', { name: 'Your jobs', exact: true }).waitFor()
})

test('search can discover archived analysis inputs but bulk selection and old preselected URLs cannot use them', { timeout: 60000 }, async (t) => {
  let workspace = domain.createInitialWorkspace()
  const resume = workspace.resumes[0], rubric = workspace.rubrics[0]
  workspace = domain.applySampleLifecycle(workspace, { kind: 'resume', id: resume.id }, 'archive', timestamp)
  workspace = domain.applySampleLifecycle(workspace, { kind: 'rubric', id: rubric.groupId }, 'archive', timestamp)
  const page = await pageFor(t, workspace)
  await page.goto(`${localServer.origin}/analyses/new?resumes=${resume.id}&rubrics=${rubric.id}`)
  await page.getByText(/Some requested inputs are archived/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Run sample analysis', exact: true }).isDisabled(), true)
  await page.getByRole('searchbox', { name: 'Search people or experience...' }).fill(resume.name)
  assert.equal(await page.getByRole('checkbox', { name: `Include ${resume.name}`, exact: true }).isDisabled(), true)
  await page.getByRole('searchbox', { name: 'Find a rubric...' }).fill(rubric.name)
  assert.equal(await page.getByRole('checkbox', { name: `Include ${rubric.name}`, exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: 'Remove unavailable selections' }).click()
  assert.equal(await page.getByRole('button', { name: 'Select visible', exact: true }).isDisabled(), true)
  assert.equal((await stored(page)).runs.length, workspace.runs.length)
})

function cloudFixture(workspace = emptyState(), summaries = []) {
  let revision = 1
  const user = { id: 'reviewer', tenantId: 'tenant', name: 'Lifecycle reviewer', email: 'reviewer@example.test' }
  const state = {
    user, workspace, summaries, jobs: [], ladders: [], saves: [], mutations: [], requests: [], pendingArchive: false,
    beforeRead: null, beforeSave: null, saveFailures: [], jobPending: [], gradePending: [], gradeFailureStatus: 503,
    lifecycleFailure: null, impactFailures: 0, jobDetailFailures: 0, jobDetailFailureStatus: 503,
    gradeImpactFailures: 0, hideDeletingFamilies: false, stateMissing: false,
  }
  const response = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
  const impact = (target, name, counts = {}, blockers = []) => ({ target, name, counts, blockers })
  state.install = async (page) => {
    await page.route('**/api/**', async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method()
      const path = decodeURIComponent(url.pathname), body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? request.postDataJSON() : undefined
      state.requests.push([method, path])
      if (method !== 'GET') state.mutations.push({ method, path, body, etag: request.headers()['if-match'] })
      if (path === '/api/session') return response(route, { mode: 'cloud', user, workspaces: clone(state.summaries) })
      if (path === '/api/features') return response(route, { realJobImports: true, realGradeLadders: true })
      if (path === '/api/workspaces' && method === 'GET') return response(route, { workspaces: clone(state.summaries) })
      if (path === '/api/workspaces' && method === 'POST') {
        const created = workspaceSummary(`created-${revision++}`, body.name)
        state.summaries.push(created)
        return response(route, { workspace: created }, 201)
      }
      const root = /^\/api\/workspaces\/([^/]+)(.*)$/.exec(path)
      if (!root) return response(route, { error: { code: 'not_found', message: path } }, 404)
      const [, workspaceId, tail] = root
      if (tail === '/state') {
        if (state.stateMissing) return response(route, { error: { code: 'not_found', message: 'Sample-state cleanup is already complete; workspace cleanup remains pending.' } }, 404)
        if (method === 'PUT') {
          await state.beforeSave?.()
          const failure = state.saveFailures.shift()
          if (failure) return response(route, { error: { code: failure === 409 ? 'conflict' : 'unavailable', message: failure === 409 ? 'A newer sample state was saved elsewhere.' : 'Injected save failure; no changes were acknowledged.' } }, failure)
          state.saves.push(clone(body)); state.workspace = clone(body); return response(route, { etag: `"state-${++revision}"` })
        }
        const snapshot = { workspace: clone(state.workspace), etag: `"state-${revision}"` }
        await state.beforeRead?.(tail, snapshot)
        return response(route, snapshot).catch(() => undefined)
      }
      if (tail === '/lifecycle') {
        const current = state.summaries.find((item) => item.id === workspaceId)
        if (method === 'GET') return response(route, { impact: impact({ kind: 'workspace', id: workspaceId }, current.name, { workspaces: 1 }, state.workspace.runs.map((run) => ({ kind: 'analysis', id: run.id, name: run.name, href: `/workspaces/${workspaceId}/analyses/${run.id}` }))) })
        assert.equal(request.headers()['if-match'], current.etag)
        if (body.action === 'delete') { state.summaries = state.summaries.filter((item) => item.id !== workspaceId); return response(route, { deleted: true }) }
        current.etag = `"metadata-${++revision}"`
        if (body.action === 'archive') current.archivedAt = timestamp
        else delete current.archivedAt
        const operation = { id: 'workspace-operation', action: body.action, status: state.pendingArchive ? 'running' : 'complete', updatedAt: timestamp }
        state.pendingArchive = false
        current.lifecycleOperation = operation
        state.workspace = domain.setWorkspaceArchive(state.workspace, body.action === 'archive', timestamp)
        return response(route, { workspace: clone(current), operation }, operation.status === 'complete' ? 200 : 202)
      }
      if (tail === '/jobs') {
        const items = clone(state.jobs), pageIndex = Number(url.searchParams.get('continuationToken') ?? 0)
        const result = { jobs: items.slice(pageIndex, pageIndex + 1), ...(pageIndex + 1 < items.length ? { continuationToken: String(pageIndex + 1) } : {}) }
        await state.beforeRead?.(tail, result)
        return response(route, result).catch(() => undefined)
      }
      if (tail === '/grade-ladders') {
        const items = clone(state.ladders.filter((family) => !state.hideDeletingFamilies || !family.ladder.lifecycle?.deletingAt)), pageIndex = Number(url.searchParams.get('continuationToken') ?? 0)
        const result = { ladders: items.slice(pageIndex, pageIndex + 1), ...(pageIndex + 1 < items.length ? { continuationToken: String(pageIndex + 1) } : {}) }
        await state.beforeRead?.(tail, result)
        return response(route, result).catch(() => undefined)
      }
      const jobPath = /^\/jobs\/([^/]+)(\/lifecycle)?$/.exec(tail)
      if (jobPath) {
        const job = state.jobs.find((item) => item.job.id === jobPath[1])
        if (!job) return response(route, { error: { code: 'not_found', message: 'This job was permanently deleted.' } }, 404)
        if (!jobPath[2]) {
          if (state.jobDetailFailures > 0) {
            state.jobDetailFailures--
            return response(route, { error: { code: state.jobDetailFailureStatus === 403 ? 'forbidden' : state.jobDetailFailureStatus === 404 ? 'not_found' : 'unavailable', message: 'Job detail reads are unavailable.' } }, state.jobDetailFailureStatus)
          }
          const snapshot = clone(job)
          if (job.lifecycle?.deletingAt || job.rubricLifecycle?.deletingAt) { snapshot.rubric = null; snapshot.rubricVersions = [] }
          if (job.lifecycle?.deletingAt) snapshot.document = null
          await state.beforeRead?.(tail, snapshot); return response(route, snapshot).catch(() => undefined)
        }
        const scope = body?.scope ?? url.searchParams.get('scope')
        const blockers = state.ladders.filter((family) => family.ladder.seedJobId === job.job.id).map(({ ladder }) => ({ kind: 'ladder', id: ladder.id, name: ladder.name, href: `/grade-ladders/${ladder.id}` }))
        if (method === 'GET') {
          if (state.impactFailures > 0) { state.impactFailures--; return response(route, { error: { code: 'unavailable', message: 'Impact refresh is unavailable.' } }, 503) }
          return response(route, { impact: impact({ kind: scope, id: scope === 'job' ? job.job.id : job.rubric?.groupId }, scope === 'job' ? job.job.title : job.rubric?.name, { rubricVersions: job.rubricVersions.length }, blockers) })
        }
        assert.equal(request.headers()['if-match'], job.etag)
        if (state.lifecycleFailure) {
          const failure = state.lifecycleFailure; state.lifecycleFailure = null
          state.impactFailures = failure.impactFailures
          return response(route, { error: { code: 'conflict', message: 'Injected lifecycle conflict; no changes were acknowledged.' } }, 409)
        }
        if (body.action === 'delete' && blockers.length) return response(route, { error: { code: 'conflict', message: 'Retained seed ladders block this deletion.' } }, 409)
        const pending = body.action === 'delete' ? state.jobPending.shift() : undefined
        if (pending) {
          job[scope === 'job' ? 'lifecycle' : 'rubricLifecycle'] = { deletingAt: timestamp }
          job.etag = `"job-${++revision}"`
          const operation = { id: `${scope}-delete:${job.job.id}`, action: 'delete', status: pending, updatedAt: timestamp, error: 'Injected job cleanup is incomplete.' }
          return response(route, { job: { ...clone(job), rubric: null, rubricVersions: [], ...(scope === 'job' ? { document: null } : {}) }, operation }, 202)
        }
        if (body.action === 'delete' && scope === 'job') { state.jobs = state.jobs.filter((item) => item !== job); return response(route, { deleted: true }) }
        const field = scope === 'job' ? 'lifecycle' : 'rubricLifecycle'
        if (body.action === 'delete') { job.rubric = null; job.rubricVersions = []; job.job.rubricId = null; job.job.rubricDeletedAt = timestamp; job[field] = { deletedAt: timestamp } }
        else if (body.action === 'archive') job[field] = { archivedAt: timestamp }
        else job[field] = {}
        job.etag = `"job-${++revision}"`
        return response(route, { job: clone(job) })
      }
      const familyPath = /^\/grade-ladders\/([^/]+)(.*)$/.exec(tail)
      if (familyPath) {
        const family = state.ladders.find((item) => item.ladder.id === familyPath[1])
        if (!family) return response(route, { error: { code: 'not_found', message: 'This ladder was permanently deleted.' } }, 404)
        if (!familyPath[2]) {
          if (family.ladder.lifecycle?.deletingAt) return response(route, {
            ladder: { ...clone(family.ladder), sourceIds: [], issues: [], sourceSetId: undefined, generationId: undefined },
            etag: family.etag, levels: [], sources: [], sourceSet: null, workItems: [],
          })
          const snapshot = clone(family); await state.beforeRead?.(tail, snapshot); return response(route, snapshot).catch(() => undefined)
        }
        if (familyPath[2].endsWith('/versions')) {
          const grade = Number(familyPath[2].split('/')[2]), level = family.levels.find((item) => item.head.grade === grade)
          const result = { versions: level?.version ? [clone(level.version)] : [] }
          await state.beforeRead?.(tail, result)
          return response(route, result).catch(() => undefined)
        }
        if (familyPath[2].startsWith('/source-sets/')) return response(route, clone(family.sourceSet))
        if (familyPath[2] === '/generate' && method === 'POST') {
          assert.equal(request.headers()['if-match'], family.etag)
          const template = realLadder(state.workspace, family.ladder.id, family.ladder.seedJobId)
          const generationId = `generation-${randomUUID()}`
          for (const level of family.levels) {
            if (level.head.lifecycle?.archivedAt || level.head.lifecycle?.deletingAt) continue
            const version = clone(level.version ?? template.levels.find((item) => item.head.grade === level.head.grade).version)
            version.id = `grade-version-${randomUUID()}`
            version.version = (level.version?.version ?? 0) + 1
            version.generationId = generationId
            version.rubric.id = `grade-rubric-${randomUUID()}`
            version.rubric.version = version.version
            version.rubric.groupId = level.head.id
            level.version = version
            level.review = null; level.approval = null
            level.head.lifecycle = { ...level.head.lifecycle }; delete level.head.lifecycle.deletedAt
            level.head.latestVersionId = version.id
            level.head.generationId = generationId
            level.head.status = 'ready-for-review'
            level.etag = `"generated-head-${++revision}"`
          }
          family.ladder.generationId = generationId
          family.etag = `"generated-ladder-${++revision}"`
          return response(route, { ladder: clone(family) }, 202)
        }
        if (familyPath[2] === '/lifecycle') {
          const grade = body?.grade ?? (url.searchParams.has('grade') ? Number(url.searchParams.get('grade')) : undefined)
          const level = grade === undefined ? undefined : family.levels.find((item) => item.head.grade === grade)
          if (method === 'GET') {
            if (state.gradeImpactFailures > 0) { state.gradeImpactFailures--; return response(route, { error: { code: 'unavailable', message: 'Lifecycle preview reads are temporarily unavailable.' } }, 503) }
            return response(route, { impact: impact({ kind: grade === undefined ? 'ladder' : 'rubric', id: level?.head.id ?? family.ladder.id }, grade === undefined ? family.ladder.name : `${family.ladder.name} · GS-${grade}`, { grades: grade === undefined ? family.levels.length : 1 }) }, 200, { ETag: level?.etag ?? family.etag })
          }
          assert.equal(request.headers()['if-match'], level?.etag ?? family.etag)
          const pending = body.action === 'delete' ? state.gradePending.shift() : undefined
          if (pending) {
            const entity = level?.head ?? family.ladder
            entity.lifecycle = { deletingAt: timestamp }
            if (level) level.etag = `"pending-head-${++revision}"`
            else family.etag = `"pending-ladder-${++revision}"`
            const operation = { id: entity.id, action: 'delete', status: pending, updatedAt: timestamp, error: 'Injected grade cleanup is incomplete.' }
            return response(route, { pending: true, etag: level?.etag ?? family.etag, operation }, pending === 'failed' ? state.gradeFailureStatus : 202)
          }
          if (body.action === 'delete' && grade === undefined) { state.ladders = state.ladders.filter((item) => item !== family); return response(route, { deleted: true }) }
          const entity = level?.head ?? family.ladder
          if (body.action === 'delete') { entity.lifecycle = { ...entity.lifecycle, deletedAt: timestamp }; delete entity.lifecycle.deletingAt; delete entity.latestVersionId; level.version = null; level.review = null; level.approval = null }
          else if (body.action === 'archive') entity.lifecycle = { ...entity.lifecycle, archivedAt: timestamp }
          else { entity.lifecycle = { ...entity.lifecycle }; delete entity.lifecycle.archivedAt }
          if (level) level.etag = `"head-${++revision}"`
          else family.etag = `"ladder-${++revision}"`
          return response(route, { ladder: clone(family) })
        }
      }
      return response(route, { error: { code: 'not_found', message: `Unexpected test request: ${path}` } }, 404)
    })
  }
  return state
}

function workspaceSummary(id = 'workspace-one', name = 'Lifecycle workspace', role = 'owner') {
  return { id, name, role, kind: 'personal', createdAt: timestamp, updatedAt: timestamp, etag: '"metadata-1"' }
}

function realJob(source, id = 'job-real-one') {
  const job = { ...clone(source.jobs[0]), id, title: `Real ${id}`, dataKind: 'real', documentId: `document-${id}`, rubricId: `rubric-${id}` }
  const rubric = { ...clone(source.rubrics[0]), id: job.rubricId, groupId: `group-${id}`, jobId: id, name: `Rubric ${id}`, dataKind: 'real' }
  return { job, rubric, rubricVersions: [rubric], document: { ...clone(source.documents.find((item) => item.id === source.jobs[0].documentId)), id: job.documentId, sample: false }, source: { kind: 'url', displayName: 'Real source', url: 'https://example.test/role' }, etag: `"${id}-etag"`, updatedAt: timestamp, attempts: 1, warnings: [] }
}

function realLadder(source, id = 'ladder-real-one', seedJobId = 'job-real-one') {
  return {
    ladder: { id, name: `Real family ${id}`, recordType: 'grade-ladder', workspaceId: 'workspace-one', createdAt: timestamp, updatedAt: timestamp, status: 'review',
      context: { series: '0301', agency: 'Example agency', agencyType: 'other-federal', supervision: 'nonsupervisory', functions: [], specialty: '', confirmed: true, answers: {} },
      grades: [9, 11], seedJobId, seedRubricId: `rubric-${seedJobId}`, seedRubricVersion: 1, seedJobTitle: 'Captured real role', sourceIds: [], sourceRevision: 0, issues: [] },
    etag: `"${id}-etag"`, sources: [], sourceSet: null, workItems: [],
    levels: [9, 11].map((grade) => ({
      head: { id: domain.gradeHeadId(id, grade), ladderId: id, workspaceId: 'workspace-one', grade, status: 'ready-for-review', issues: [], latestVersionId: `version-${id}-${grade}`, createdAt: timestamp, updatedAt: timestamp },
      etag: `"head-${id}-${grade}"`, review: null, approval: null,
      version: { id: `version-${id}-${grade}`, ladderId: id, workspaceId: 'workspace-one', grade, version: 1, generationId: 'generation-one', sourceSetId: 'set-one', contentHash: 'a'.repeat(64), issues: [], qualifications: [], createdAt: timestamp,
        rubric: { ...clone(source.rubrics.find((item) => item.kind === 'grade')), id: `rubric-${id}-${grade}`, groupId: domain.gradeHeadId(id, grade), dataKind: 'real', grade: `GS-${grade}`, name: `Real GS-${grade} expectations`, version: 1,
          criteria: source.rubrics[0].criteria.map((criterion) => ({ ...criterion, competencyId: criterion.id, sourceCitations: [], gradeBasis: [], interpretation: 'Retained interpretation.', support: 'gap', weight: 0 })) },
      },
    })),
  }
}

test('cloud empty directory, last-workspace archive, pending retry, and explicit unarchive never recreate samples', { timeout: 90000 }, async (t) => {
  const page = await pageFor(t)
  const fixture = cloudFixture()
  await fixture.install(page)
  await page.goto(cloudServer.origin)
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  assert.equal(fixture.mutations.length, 0)
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  await page.getByRole('textbox', { name: 'New workspace name', exact: true }).fill('Only workspace')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('heading', { name: 'Your jobs', exact: true }).waitFor()
  const selectedId = fixture.summaries[0].id
  fixture.pendingArchive = true
  await page.locator('.sidebar .workspace-switcher-trigger').click()
  await page.getByRole('button', { name: 'Archive Only workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Archive Only workspace?', exact: true })
  await until(() => dialog.getByRole('button', { name: 'Archive', exact: true }).isEnabled(), 'Workspace impact ready')
  await dialog.getByRole('button', { name: 'Archive', exact: true }).click()
  await dialog.getByText(/still in progress/).waitFor()
  assert.equal(await page.locator('.toast').count(), 0, 'Pending is not success')
  await dialog.getByRole('button', { name: 'Retry operation', exact: true }).click()
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  assert.equal(await page.getByText('Archived', { exact: true }).count() > 0, true)
  await lifecycle(page, 'Only workspace', 'unarchive')
  await lifecycle(page, 'Only workspace', 'delete')
  await page.reload()
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  assert.equal(fixture.summaries.length, 0)
  assert.equal(fixture.mutations.filter((item) => item.path === '/api/workspaces').length, 1)
  await page.goto(`${cloudServer.origin}/workspaces/${selectedId}/jobs`)
  await page.getByRole('heading', { name: 'This workspace is unavailable', exact: true }).waitFor()
})

test('a partially deleted workspace deep link still exposes lifecycle recovery when its sample state is gone', { timeout: 60000 }, async (t) => {
  const summary = { ...workspaceSummary(), lifecycleOperation: { id: 'unfinished-root-delete', action: 'delete', status: 'failed', updatedAt: timestamp, error: 'Membership cleanup is incomplete.' } }
  const fixture = cloudFixture(emptyState(), [summary]); fixture.stateMissing = true
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs`)
  await page.getByRole('heading', { name: 'This workspace could not be opened', exact: true }).waitFor()
  await page.locator('.workspace-switcher-trigger').click()
  const picker = page.getByRole('dialog', { name: 'My workspaces', exact: true })
  await picker.getByText('Membership cleanup is incomplete.', { exact: true }).waitFor()
  await picker.getByRole('button', { name: 'Retry operation', exact: true }).click()
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  assert.equal(fixture.summaries.length, 0)
  assert.equal(fixture.mutations.filter((item) => item.path === '/api/workspaces').length, 0)
})

test('archived cloud deep links are readable for viewers but never selected automatically or usable as seeds', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace()
  const summary = { ...workspaceSummary('workspace-one', 'Archived review', 'viewer'), archivedAt: timestamp }
  const fixture = cloudFixture(sample, [summary])
  fixture.jobs = [realJob(sample)]
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(cloudServer.origin)
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Archived review', exact: true }).click()
  await page.getByRole('heading', { name: 'Your jobs', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Add jobs', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'New analysis', exact: true }).isDisabled(), true)
  await page.getByRole('searchbox', { name: 'Search jobs, organizations...' }).fill(fixture.jobs[0].job.title)
  await page.getByRole('link', { name: fixture.jobs[0].job.title, exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Create grade ladder', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: /^Permanently delete/ }).count(), 0)
  const job = fixture.jobs[0]
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/grade-ladders/new?job=${job.job.id}&rubric=${job.rubric.id}&rubricVersion=1`)
  await page.getByText(/requested seed is archived/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Create and discover sources', exact: true }).isDisabled(), true)
  assert.equal(fixture.mutations.length, 0)
})

test('cloud sample deletion keeps its confirmation until the save is acknowledged and retries without deleting twice', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(); sample.runs = []
  const fixture = cloudFixture(sample, [workspaceSummary()])
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/resumes`)
  const resume = sample.resumes[0], saving = deferred()
  t.after(() => saving.resolve())
  fixture.beforeSave = () => saving.promise
  fixture.saveFailures = [503]
  await page.getByRole('button', { name: `Permanently delete ${resume.name}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `Permanently delete ${resume.name}?`, exact: true })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click()
  await until(() => Promise.resolve(fixture.mutations.some((item) => item.method === 'PUT')), 'The sample lifecycle save is in flight')
  assert.equal(await dialog.getByRole('button', { name: 'Awaiting acknowledgement…', exact: true }).isDisabled(), true)
  assert.equal(fixture.workspace.resumes.some((item) => item.id === resume.id), true, 'Server content is retained until acknowledgement')
  saving.resolve()
  await dialog.getByText(/Injected save failure/).waitFor()
  assert.equal(await page.locator('.toast').filter({ hasText: /Permanent deletion saved/ }).count(), 0)
  fixture.beforeSave = null
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(fixture.workspace.resumes.some((item) => item.id === resume.id), false)
  assert.equal(fixture.saves.length, 1)
  assert.equal(fixture.mutations.filter((item) => item.method === 'PUT').length, 2)
})

test('keep-mine conflict resolution cannot resurrect an identity deleted by another tab', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(); sample.runs = []
  const fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.saveFailures = [409]
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/rubrics/${sample.rubrics[0].id}`)
  await page.getByRole('button', { name: 'Edit rubric', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit rubric', exact: true })
  await editor.getByRole('textbox', { name: 'Rubric name', exact: true }).fill('Unsaved local rubric edit')
  await editor.getByRole('button', { name: 'Save version 2', exact: true }).click()
  await page.getByRole('button', { name: 'Keep my changes', exact: true }).waitFor()
  fixture.workspace = domain.applySampleLifecycle(fixture.workspace, { kind: 'resume', id: sample.resumes[0].id }, 'delete', timestamp)
  await page.getByRole('button', { name: 'Keep my changes', exact: true }).click()
  await page.getByRole('button', { name: 'Overwrite with mine', exact: true }).click()
  await page.getByText(/Keep mine cannot resurrect removed content/).waitFor()
  assert.equal(fixture.mutations.filter((item) => item.method === 'PUT').length, 1, 'An unsafe fresh-ETag overwrite is never sent')
  assert.equal(fixture.workspace.resumes.some((item) => item.id === sample.resumes[0].id), false)
})

test('keep-mine uses full transition validation to protect completed evidence before sending a fresh-ETag PUT', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.saveFailures = [409]
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/rubrics/${sample.rubrics[0].id}`)
  await page.getByRole('button', { name: 'Edit rubric', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit rubric', exact: true })
  await editor.getByRole('textbox', { name: 'Rubric name', exact: true }).fill('Unsaved rubric revision')
  await editor.getByRole('button', { name: 'Save version 2', exact: true }).click()
  await page.getByRole('button', { name: 'Keep my changes', exact: true }).waitFor()
  fixture.workspace = clone(fixture.workspace)
  fixture.workspace.runs[0].comparisons[0].summary += ' Preserved output from another session.'
  const preserved = fixture.workspace.runs[0].comparisons[0].summary
  await page.getByRole('button', { name: 'Keep my changes', exact: true }).click()
  await page.getByRole('button', { name: 'Overwrite with mine', exact: true }).click()
  await page.getByText(/must preserve its completed results/).waitFor()
  assert.equal(fixture.mutations.filter((item) => item.method === 'PUT').length, 1)
  assert.equal(fixture.workspace.runs[0].comparisons[0].summary, preserved)
  assert.equal(fixture.saves.length, 0)
})

test('keep-mine still saves valid ordinary sample edits after explicit conflict resolution', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.saveFailures = [409]
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/rubrics/${sample.rubrics[0].id}`)
  await page.getByRole('button', { name: 'Edit rubric', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit rubric', exact: true })
  await editor.getByRole('textbox', { name: 'Rubric name', exact: true }).fill('Explicitly retained local revision')
  await editor.getByRole('button', { name: 'Save version 2', exact: true }).click()
  await page.getByRole('button', { name: 'Keep my changes', exact: true }).waitFor()
  fixture.workspace = clone(fixture.workspace)
  fixture.workspace.resumes[0].location = 'Ordinary metadata edited elsewhere'
  await page.getByRole('button', { name: 'Keep my changes', exact: true }).click()
  await page.getByRole('button', { name: 'Overwrite with mine', exact: true }).click()
  await until(() => Promise.resolve(fixture.saves.length === 1), 'Valid ordinary edits are acknowledged')
  assert.equal(fixture.workspace.rubrics.some((rubric) => rubric.name === 'Explicitly retained local revision'), true)
  assert.equal(fixture.workspace.resumes[0].location, sample.resumes[0].location)
})

test('focus refresh fences another tab’s archive before a delayed sample import can save', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace()
  const fixture = cloudFixture(sample, [workspaceSummary()])
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/resumes`)
  await page.getByRole('button', { name: 'Add resumes', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add resumes', exact: true })
  await dialog.getByRole('button', { name: 'Load sample batch', exact: true }).click()
  await dialog.getByRole('button', { name: 'Add 3 sample resumes', exact: true }).click()
  fixture.summaries[0] = { ...fixture.summaries[0], archivedAt: timestamp, etag: '"archived-elsewhere"' }
  fixture.workspace = domain.setWorkspaceArchive(fixture.workspace, true, timestamp)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.locator('.lifecycle-banner').filter({ hasText: 'Archived · read only' }).first().waitFor()
  await page.waitForTimeout(800)
  assert.equal(fixture.saves.length, 0)
  assert.equal(fixture.workspace.resumes.length, sample.resumes.length)
  assert.equal(await dialog.getByRole('button', { name: 'Add 3 sample resumes', exact: true }).isDisabled(), true)
})

test('unarchiving an explicitly opened cloud workspace refreshes sample state and its ETag before new imports', { timeout: 60000 }, async (t) => {
  const sample = domain.setWorkspaceArchive(domain.createInitialWorkspace(), true, timestamp)
  const fixture = cloudFixture(sample, [{ ...workspaceSummary(), archivedAt: timestamp }])
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/resumes`)
  assert.equal(await page.getByRole('button', { name: 'Add resumes', exact: true }).isDisabled(), true)
  await page.locator('.sidebar .workspace-switcher-trigger').click()
  await lifecycle(page, 'Lifecycle workspace', 'unarchive')
  await page.getByRole('dialog', { name: 'My workspaces', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click()
  await until(() => page.getByRole('button', { name: 'Add resumes', exact: true }).isEnabled(), 'Unarchived sample state is installed')
  await page.getByRole('button', { name: 'Add resumes', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add resumes', exact: true })
  await dialog.getByRole('button', { name: 'Load sample batch', exact: true }).click()
  await dialog.getByRole('button', { name: 'Add 3 sample resumes', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await until(() => Promise.resolve(fixture.saves.length === 1), 'A new import is acknowledged after unarchive')
  assert.equal(fixture.workspace.resumes.length, sample.resumes.length + 3)
  assert.equal(fixture.workspace.lifecycle.archivedAt, undefined)
})

test('cross-tab workspace lifecycle refresh preserves unsaved grade drafts and their leave protection', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.ladders = [realLadder(sample)]
  const family = fixture.ladders[0]
  family.ladder.sourceSetId = 'set-one'; family.ladder.generationId = 'generation-one'
  family.sourceSet = { id: 'set-one', sources: [], decisions: [], issues: [], context: family.ladder.context, grades: [9, 11], revision: 1, createdAt: timestamp }
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/grade-ladders/${family.ladder.id}`)
  const column = page.locator('.grade-matrix thead th').filter({ has: page.getByRole('heading', { name: 'GS-9', exact: true }) })
  await column.getByRole('button', { name: 'Edit draft', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit GS-9 draft', exact: true })
  await editor.getByRole('textbox', { name: 'Grade rubric name', exact: true }).fill('Keep this unsaved draft')
  fixture.summaries[0] = { ...fixture.summaries[0], archivedAt: timestamp, etag: '"externally-archived"' }
  fixture.workspace = domain.setWorkspaceArchive(fixture.workspace, true, timestamp)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await editor.getByText('Archived · read only', { exact: true }).waitFor()
  assert.equal(await editor.getByRole('textbox', { name: 'Grade rubric name', exact: true }).inputValue(), 'Keep this unsaved draft')
  assert.equal(await editor.getByRole('button', { name: 'Save draft and request review', exact: true }).isDisabled(), true)
  await editor.getByRole('button', { name: 'Close draft', exact: true }).click()
  const protection = page.getByRole('dialog', { name: 'Leave unsaved grade changes?', exact: true })
  await protection.getByRole('button', { name: 'Stay here', exact: true }).click()
  assert.equal(await editor.getByRole('textbox', { name: 'Grade rubric name', exact: true }).inputValue(), 'Keep this unsaved draft')
  assert.equal(fixture.saves.length, 0)
})

test('real jobs reconcile every page, evict deleted details, and reject stale detail replies without sample autosave', { timeout: 90000 }, async (t) => {
  const sample = domain.createInitialWorkspace()
  const fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.jobs = [realJob(sample), realJob(sample, 'job-real-two')]
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs`)
  await page.getByRole('link', { name: 'Real job-real-two', exact: true }).waitFor()
  assert.equal(fixture.requests.filter(([method, path]) => method === 'GET' && path.endsWith('/jobs')).length >= 2, true)
  fixture.jobs = fixture.jobs.filter((item) => item.job.id !== 'job-real-two')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await until(async () => await page.getByRole('link', { name: 'Real job-real-two', exact: true }).count() === 0, 'An absent row must be removed by authoritative all-page refresh')
  const gate = deferred(), requested = deferred()
  t.after(() => gate.resolve())
  fixture.beforeRead = async (path) => { if (path === '/jobs/job-real-one') { requested.resolve(); await gate.promise } }
  await page.getByRole('link', { name: 'Real job-real-one', exact: true }).click()
  await requested.promise
  await lifecycle(page, 'Real job-real-one', 'delete')
  gate.resolve()
  await page.getByRole('heading', { name: 'Your jobs', exact: true }).waitFor()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await until(() => Promise.resolve(fixture.requests.filter(([method, path]) => method === 'GET' && path.endsWith('/jobs')).length >= 4), 'Jobs refresh finishes')
  assert.equal(await page.getByRole('link', { name: 'Real job-real-one', exact: true }).count(), 0)
  assert.equal(fixture.saves.length, 0)
})

test('real grade family and per-grade archive states, seed blockers, and no-rubric deletion stay independent', { timeout: 90000 }, async (t) => {
  const sample = domain.createInitialWorkspace()
  const fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.jobs = [realJob(sample)]
  fixture.ladders = [realLadder(sample)]
  const page = await pageFor(t)
  await fixture.install(page)
  const family = fixture.ladders[0].ladder
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/grade-ladders/${family.id}`)
  await page.getByRole('heading', { name: family.name, exact: true }).waitFor()
  await lifecycle(page, `${family.name} · GS-9`, 'archive')
  await page.getByRole('combobox', { name: 'Grade archive state', exact: true }).selectOption('all')
  const column = (grade) => page.locator('.grade-matrix thead th').filter({ has: page.getByRole('heading', { name: `GS-${grade}`, exact: true }) })
  assert.equal(await column(9).getByRole('button', { name: 'Edit draft', exact: true }).isDisabled(), true)
  await lifecycle(page, family.name, 'archive')
  await lifecycle(page, family.name, 'unarchive')
  assert.equal(await column(9).getByRole('button', { name: 'Edit draft', exact: true }).isDisabled(), true)
  assert.equal(Boolean(fixture.ladders[0].levels[1].head.lifecycle?.archivedAt), false)
  await lifecycle(page, `${family.name} · GS-9`, 'unarchive')
  await lifecycle(page, `${family.name} · GS-9`, 'delete')
  await column(9).getByText('No rubric', { exact: true }).waitFor()
  assert.equal(fixture.ladders[0].levels[1].version !== null, true)
  await lifecycle(page, family.name, 'archive')

  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs/job-real-one`)
  await page.getByRole('button', { name: 'Permanently delete Real job-real-one', exact: true }).click()
  const blocker = page.getByRole('dialog', { name: 'Permanently delete Real job-real-one?', exact: true })
  await blocker.getByRole('link', { name: family.name, exact: true }).waitFor()
  assert.equal(await blocker.getByRole('button', { name: 'Permanently delete', exact: true }).isDisabled(), true)
  await blocker.getByRole('link', { name: family.name, exact: true }).click()
  await lifecycle(page, family.name, 'delete')
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs/job-real-one`)
  await lifecycle(page, 'Rubric job-real-one', 'delete')
  await page.getByRole('heading', { name: 'No rubric', exact: true }).waitFor()
  assert.equal(fixture.jobs[0].document !== null, true)
  assert.equal(fixture.saves.length, 0, 'Real lifecycle overlays must never be written to sample autosave')
})

test('managing another workspace does not cancel the current workspace analysis', { timeout: 90000 }, async (t) => {
  const sample = domain.createInitialWorkspace()
  sample.runs = []
  const other = workspaceSummary('workspace-two', 'Other workspace')
  const fixture = cloudFixture(sample, [workspaceSummary(), other])
  const page = await pageFor(t)
  await page.addInitScript(() => {
    const timeout = window.setTimeout.bind(window)
    window.setTimeout = (handler, milliseconds, ...arguments_) => timeout(handler, milliseconds === 420 ? 60_000 : milliseconds, ...arguments_)
  })
  await fixture.install(page)
  let fail = true
  await page.route('**/api/workspaces/workspace-two/lifecycle', async route => {
    if (route.request().method() === 'GET') return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        impact: { target: { kind: 'workspace', id: other.id }, name: other.name, counts: {}, blockers: [] },
      }),
    })
    if (fail) return route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Injected other-workspace failure.' } }),
    })
    other.archivedAt = timestamp
    other.etag = '"other-archived"'
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ workspace: other }) })
  })
  const rubric = sample.rubrics.find(item => item.kind === 'job' && sample.jobs.some(job => job.rubricId === item.id && job.status === 'ready'))
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/analyses/new?resumes=${sample.resumes[0].id}&rubrics=${rubric.id}`)
  await page.getByRole('button', { name: 'Run sample analysis', exact: true }).click()
  await until(() => Promise.resolve(fixture.workspace.runs.length === 1), 'The current analysis is saved before managing another workspace')
  assert.equal(fixture.workspace.runs[0].comparisons[0].status, 'running')
  await page.locator('.sidebar .workspace-switcher-trigger').click()
  await page.getByRole('button', { name: 'Archive Other workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Archive Other workspace?', exact: true })
  const submit = dialog.getByRole('button', { name: 'Archive', exact: true })
  await until(() => submit.isEnabled(), 'Impact loads')
  await submit.click()
  await dialog.getByText('Injected other-workspace failure.', { exact: true }).waitFor()
  assert.equal(fixture.workspace.runs[0].comparisons[0].status, 'running')
  fail = false
  await submit.click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(other.archivedAt, timestamp)
  assert.match(page.url(), /workspaces\/workspace-one\/analyses\//)
  assert.ok(fixture.saves.every(value => value.runs.every(run => run.comparisons.every(comparison => comparison.status !== 'cancelled'))))
  assert.equal(fixture.workspace.runs[0].comparisons[0].status, 'running')
})

test('an archived empty grade exposes only Unarchive without restoring deleted history', { timeout: 90000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.ladders = [realLadder(sample)]
  const detail = fixture.ladders[0]
  detail.ladder.sourceSetId = 'set-one'; detail.ladder.generationId = 'generation-one'
  detail.sourceSet = { id: 'set-one', sources: [], decisions: [], issues: [], context: detail.ladder.context, grades: [9, 11], revision: 1, createdAt: timestamp }
  const deletedVersionId = detail.levels[0].version.id
  const siblingVersionId = detail.levels[1].version.id
  const page = await pageFor(t)
  await fixture.install(page)
  const family = fixture.ladders[0].ladder, name = `${family.name} · GS-9`
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/grade-ladders/${family.id}`)
  await page.getByRole('heading', { name: family.name, exact: true }).waitFor()
  await page.getByRole('combobox', { name: 'Grade archive state', exact: true }).selectOption('all')
  await lifecycle(page, name, 'archive')
  await lifecycle(page, name, 'delete')
  const column = page.locator('.grade-matrix thead th').filter({ has: page.getByRole('heading', { name: 'GS-9', exact: true }) })
  await column.getByText('No rubric', { exact: true }).waitFor()
  const head = fixture.ladders[0].levels[0].head
  assert.ok(head.lifecycle.deletedAt && head.lifecycle.archivedAt)
  assert.equal(await column.getByRole('button', { name: `Permanently delete ${name}`, exact: true }).count(), 0)
  await page.getByRole('button', { name: `Unarchive ${name}`, exact: true }).click()
  const restore = page.getByRole('dialog', { name: `Unarchive ${name}?`, exact: true })
  await restore.getByText(/Unarchive only the empty grade slot/).waitFor()
  await until(() => restore.getByRole('button', { name: 'Unarchive', exact: true }).isEnabled(), 'Empty slot impact is loaded')
  await restore.getByRole('button', { name: 'Unarchive', exact: true }).click()
  await restore.waitFor({ state: 'hidden' })
  assert.ok(head.lifecycle.deletedAt)
  assert.equal(head.lifecycle.archivedAt, undefined)
  assert.equal(fixture.ladders[0].levels[0].version, null)
  assert.equal(await column.getByRole('button', { name: 'Edit draft', exact: true }).isDisabled(), true)
  assert.equal(await column.getByRole('button', { name: `Archive ${name}`, exact: true }).count(), 0)
  head.lifecycle.archivedAt = timestamp
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/rubrics?kind=grade&data=real`)
  await page.getByRole('combobox', { name: 'Rubric archive state', exact: true }).selectOption('all')
  await lifecycle(page, name, 'unarchive')
  assert.equal(head.lifecycle.archivedAt, undefined)
  assert.ok(head.lifecycle.deletedAt)
  head.lifecycle.archivedAt = timestamp
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/grade-ladders/${family.id}?grade=9&version=${deletedVersionId}`)
  await page.getByRole('heading', { name: 'No rubric', exact: true }).waitFor()
  await lifecycle(page, name, 'unarchive')
  assert.ok(head.lifecycle.deletedAt)
  assert.equal(fixture.ladders[0].levels[0].version, null)
  assert.equal(fixture.mutations.filter((item) => item.path.endsWith('/generate')).length, 0, 'Unarchive never regenerates deleted history')
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/grade-ladders/${family.id}`)
  await lifecycle(page, `${family.name} · GS-11`, 'archive')
  await page.getByRole('button', { name: 'Generate new revision', exact: true }).click()
  await until(() => Promise.resolve(Boolean(detail.levels[0].version)), 'Explicit generation creates a fresh version in the active empty slot')
  await column.getByText('Saved version 1', { exact: true }).waitFor()
  assert.equal(await column.getByRole('button', { name: 'Edit draft', exact: true }).isEnabled(), true)
  assert.notEqual(detail.levels[0].version.id, deletedVersionId)
  assert.equal(head.lifecycle.deletedAt, undefined)
  assert.equal(detail.levels[1].version.id, siblingVersionId, 'The separately archived sibling is not regenerated')
  assert.equal(fixture.saves.length, 0)
})

test('real grades reconcile missing families across all pages and ignore late deleted history and detail replies', { timeout: 90000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.ladders = [realLadder(sample), realLadder(sample, 'ladder-real-two')]
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/rubrics?kind=grade&data=real`)
  const family = fixture.ladders[0].ladder, other = fixture.ladders[1].ladder
  await page.getByRole('link', { name: other.name, exact: true }).waitFor()
  fixture.ladders = fixture.ladders.slice(0, 1)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await until(async () => await page.getByRole('link', { name: other.name, exact: true }).count() === 0, 'The missing second-page family is evicted')
  await page.getByRole('link', { name: family.name, exact: true }).click()
  const historyGate = deferred(), historyRead = deferred()
  t.after(() => historyGate.resolve())
  fixture.beforeRead = async (path) => { if (path.endsWith('/grades/9/versions')) { historyRead.resolve(); await historyGate.promise } }
  const column = page.locator('.grade-matrix thead th').filter({ has: page.getByRole('heading', { name: 'GS-9', exact: true }) })
  await column.getByRole('button', { name: 'History', exact: true }).click()
  await historyRead.promise
  await lifecycle(page, `${family.name} · GS-9`, 'delete')
  historyGate.resolve()
  await page.locator('.grade-version-history').getByRole('heading', { name: 'No rubric', exact: true }).waitFor()
  assert.equal(await page.locator('.grade-version-history').getByRole('link', { name: /Version 1/ }).count(), 0)

  const detailGate = deferred(), detailRead = deferred()
  t.after(() => detailGate.resolve())
  fixture.beforeRead = async (path) => { if (path === `/grade-ladders/${family.id}`) { detailRead.resolve(); await detailGate.promise } }
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click()
  await detailRead.promise
  await lifecycle(page, family.name, 'delete')
  detailGate.resolve()
  await page.getByRole('heading', { name: 'Rubrics', exact: true }).waitFor()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  assert.equal(await page.getByRole('link', { name: family.name, exact: true }).count(), 0)
  assert.equal(fixture.saves.length, 0)
})

test('pending and failed real cleanup survives row eviction and retries with refreshed exact ETags', { timeout: 90000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.jobs = [realJob(sample)]
  fixture.jobPending = ['pending']
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs`)
  await page.getByRole('button', { name: 'Permanently delete Real job-real-one', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Permanently delete Real job-real-one?', exact: true })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click()
  await dialog.getByText('Injected job cleanup is incomplete.', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Close — operation remains pending', exact: true }).click()
  let operations = page.getByRole('region', { name: 'Incomplete lifecycle operations', exact: true })
  await operations.getByText(/Real job-real-one · delete pending/).waitFor()
  fixture.jobDetailFailures = 1
  await operations.getByRole('button', { name: 'Retry lifecycle operation', exact: true }).click()
  await operations.waitFor({ state: 'hidden' })
  const jobMutations = fixture.mutations.filter((item) => item.path.endsWith('/jobs/job-real-one/lifecycle'))
  assert.equal(jobMutations.length, 2)
  assert.notEqual(jobMutations[0].etag, jobMutations[1].etag)
  assert.equal(fixture.jobDetailFailures, 0, 'A read outage falls back to the returned fenced job ETag')
  assert.equal(fixture.jobs.length, 0)

  fixture.ladders = [realLadder(sample)]
  fixture.gradePending = ['failed']
  fixture.hideDeletingFamilies = true
  const family = fixture.ladders[0].ladder
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/grade-ladders/${family.id}`)
  await page.getByRole('button', { name: `Permanently delete ${family.name}`, exact: true }).click()
  dialog = page.getByRole('dialog', { name: `Permanently delete ${family.name}?`, exact: true })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click()
  await dialog.getByText('Injected grade cleanup is incomplete.', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Close — operation remains pending', exact: true }).click()
  operations = page.getByRole('region', { name: 'Incomplete lifecycle operations', exact: true })
  await operations.getByText(new RegExp(`${family.name} · delete failed`)).waitFor()
  assert.equal(await page.locator('.toast').filter({ hasText: /Permanent deletion acknowledged by the grade/ }).count(), 0)
  assert.equal(await page.getByRole('button', { name: /Generate grade drafts|Generate new revision/ }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Context / add grades', exact: true }).count(), 0)
  assert.equal(await page.locator('.grade-matrix, .grade-sources, .grade-version-history').count(), 0)
  fixture.gradeImpactFailures = 1
  await operations.getByRole('button', { name: 'Retry lifecycle operation', exact: true }).click()
  await operations.waitFor({ state: 'hidden' })
  const gradeMutations = fixture.mutations.filter((item) => item.path.endsWith(`/grade-ladders/${family.id}/lifecycle`))
  assert.equal(gradeMutations.length, 2)
  assert.notEqual(gradeMutations[0].etag, gradeMutations[1].etag)
  assert.equal(fixture.gradeImpactFailures, 0, 'The response target ETag remains usable when preview reads fail')
  assert.equal(fixture.ladders.length, 0)
  assert.equal(fixture.saves.length, 0)
})

test('cold readers discover fenced cleanup markers and can resume them without restoring deleted content', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.jobs = [realJob(sample)]
  fixture.jobs[0].lifecycle = { deletingAt: timestamp }
  fixture.ladders = [realLadder(sample, 'ladder-pending', 'another-seed')]
  fixture.ladders[0].ladder.lifecycle = { deletingAt: timestamp }
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs`)
  const operations = page.getByRole('region', { name: 'Incomplete lifecycle operations', exact: true })
  await until(async () => await operations.getByRole('button', { name: 'Retry lifecycle operation', exact: true }).count() === 2, 'Both durable deletion fences are discoverable')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Lifecycle recovery remains usable on a narrow dark-theme screen')
  const pendingRow = page.getByRole('row').filter({ has: page.getByRole('link', { name: fixture.jobs[0].job.title, exact: true }) })
  await pendingRow.getByText('Deletion pending', { exact: true }).first().waitFor()
  assert.equal(await pendingRow.getByRole('checkbox').isDisabled(), true)
  await operations.locator('.lifecycle-banner').filter({ hasText: 'Real job-real-one' }).getByRole('button').click()
  await until(() => Promise.resolve(fixture.jobs.length === 0), 'The retained job fence is completed')
  await until(async () => await operations.getByRole('button', { name: 'Retry lifecycle operation', exact: true }).count() === 1, 'The acknowledged job operation is removed')
  await operations.getByRole('button', { name: 'Retry lifecycle operation', exact: true }).click()
  await operations.waitFor({ state: 'hidden' })
  assert.equal(fixture.ladders.length, 0)
  assert.equal(fixture.saves.length, 0)
})

for (const status of ['pending', 'failed']) test(`202 ${status} grade cleanup retains its head ETag and read-only recovery without ladder detail`, { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.ladders = [realLadder(sample, `ladder-head-${status}`)]
  fixture.gradePending = [status]; fixture.gradeFailureStatus = 202
  const family = fixture.ladders[0]
  family.ladder.sourceSetId = 'set-one'; family.ladder.generationId = 'generation-one'
  family.sourceSet = { id: 'set-one', sources: [], decisions: [], issues: [], context: family.ladder.context, grades: [9, 11], revision: 1, createdAt: timestamp }
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/grade-ladders/${family.ladder.id}`)
  const column = page.locator('.grade-matrix thead th').filter({ has: page.getByRole('heading', { name: 'GS-9', exact: true }) })
  await until(() => column.getByRole('button', { name: 'Edit draft', exact: true }).isEnabled(), 'The active grade is initially editable')
  const name = `${family.ladder.name} · GS-9`
  await page.getByRole('button', { name: `Permanently delete ${name}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `Permanently delete ${name}?`, exact: true })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click()
  await dialog.getByText('Injected grade cleanup is incomplete.', { exact: true }).waitFor()
  const pendingEtag = family.levels[0].etag
  assert.equal(await dialog.getByRole('button', { name: 'Retry operation', exact: true }).isEnabled(), true)
  assert.equal(fixture.ladders.length, 1)
  assert.equal(await page.locator('.toast').filter({ hasText: /Permanent deletion acknowledged/ }).count(), 0)
  await dialog.getByRole('button', { name: 'Close — operation remains pending', exact: true }).click()
  assert.equal(await column.getByRole('button', { name: 'Edit draft', exact: true }).isDisabled(), true)
  await column.getByText('Deletion pending', { exact: true }).waitFor()
  const operations = page.getByRole('region', { name: 'Incomplete lifecycle operations', exact: true })
  await operations.getByRole('button', { name: 'Retry lifecycle operation', exact: true }).click()
  await operations.waitFor({ state: 'hidden' })
  const mutations = fixture.mutations.filter((item) => item.path.endsWith(`/grade-ladders/${family.ladder.id}/lifecycle`))
  assert.equal(mutations.length, 2)
  assert.equal(mutations[1].etag, pendingEtag)
  assert.equal(mutations[1].body.grade, 9)
  assert.equal(family.levels[0].version, null)
  assert.notEqual(family.levels[1].version, null)
  assert.equal(fixture.saves.length, 0)
})

test('failed impact refresh logs the secondary failure without replacing the lifecycle error', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.jobs = [realJob(sample)]
  fixture.lifecycleFailure = { impactFailures: 1 }
  const page = await pageFor(t), warnings = []
  page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()) })
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs`)
  await page.getByRole('button', { name: 'Archive Real job-real-one', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Archive Real job-real-one?', exact: true })
  await until(() => dialog.getByRole('button', { name: 'Archive', exact: true }).isEnabled(), 'The initial impact is available')
  await dialog.getByRole('button', { name: 'Archive', exact: true }).click()
  await dialog.getByRole('button', { name: 'Retry impact check', exact: true }).waitFor()
  assert.match(await dialog.getByRole('alert').textContent(), /Injected lifecycle conflict/)
  assert.equal(await dialog.getByRole('button', { name: 'Archive', exact: true }).isDisabled(), true)
  await until(() => Promise.resolve(warnings.some((message) => message.includes('could not refresh lifecycle impact'))), 'The secondary failure is logged')
  await dialog.getByRole('button', { name: 'Retry impact check', exact: true }).click()
  await until(() => dialog.getByRole('button', { name: 'Archive', exact: true }).isEnabled(), 'A new impact is checked before retry')
  await dialog.getByRole('button', { name: 'Archive', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
})

test('initial sample load ignores an obsolete reply after authoritative workspace metadata changes', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  const gate = deferred(), requested = deferred()
  t.after(() => gate.resolve())
  let hold = true
  fixture.beforeRead = async (path) => {
    if (path === '/state' && hold) { hold = false; requested.resolve(); await gate.promise }
  }
  const page = await pageFor(t)
  await fixture.install(page)
  try {
    await page.goto(`${cloudServer.origin}/workspaces/workspace-one/analyses/${sample.runs[0].id}`)
    await requested.promise
    fixture.workspace = domain.setWorkspaceArchive(sample, true, timestamp)
    fixture.workspace = domain.applySampleLifecycle(fixture.workspace, { kind: 'analysis', id: sample.runs[0].id }, 'delete', timestamp)
    fixture.summaries[0] = { ...fixture.summaries[0], archivedAt: timestamp, etag: '"archived-during-load"' }
    await refreshDirectory(page)
    gate.resolve()
    await page.getByRole('heading', { name: 'This analysis is no longer here', exact: true }).waitFor()
    assert.equal(fixture.requests.filter(([method, path]) => method === 'GET' && path.endsWith('/state')).length >= 2, true)
    assert.equal(await page.getByRole('button', { name: 'New analysis', exact: true }).isDisabled(), true)
    assert.equal(fixture.saves.length, 0)
  } finally { gate.resolve() }
})

test('archive-to-unarchive refresh refetches changed generations instead of reinstalling a stale sample snapshot', { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/analyses/${sample.runs[0].id}`)
  await page.getByRole('heading', { name: sample.runs[0].name, exact: true }).waitFor()
  const gate = deferred(), requested = deferred()
  t.after(() => gate.resolve())
  let hold = true
  fixture.beforeRead = async (path) => {
    if (path === '/state' && hold) { hold = false; requested.resolve(); await gate.promise }
  }
  try {
    fixture.workspace = domain.setWorkspaceArchive(fixture.workspace, true, timestamp)
    fixture.summaries[0] = { ...fixture.summaries[0], archivedAt: timestamp, etag: '"archive-generation"' }
    await refreshDirectory(page)
    await requested.promise
    fixture.workspace = domain.applySampleLifecycle(fixture.workspace, { kind: 'analysis', id: sample.runs[0].id }, 'delete', timestamp)
    fixture.workspace = domain.setWorkspaceArchive(fixture.workspace, false, timestamp)
    fixture.summaries[0] = { ...fixture.summaries[0], archivedAt: undefined, etag: '"unarchive-generation"' }
    await refreshDirectory(page)
    gate.resolve()
    await page.getByRole('heading', { name: 'This analysis is no longer here', exact: true }).waitFor()
    await until(() => page.getByRole('button', { name: 'New analysis', exact: true }).isEnabled(), 'The newest unarchived state is installed')
    assert.equal(fixture.requests.filter(([method, path]) => method === 'GET' && path.endsWith('/state')).length >= 3, true)
    assert.equal(fixture.saves.length, 0)
  } finally { gate.resolve() }
})

for (const status of [403, 404]) test(`retained cleanup ETags do not bypass a ${status} refresh response or claim deletion complete`, { timeout: 60000 }, async (t) => {
  const sample = domain.createInitialWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.jobs = [realJob(sample)]; fixture.jobPending = ['pending']
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs`)
  await page.getByRole('button', { name: 'Permanently delete Real job-real-one', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Permanently delete Real job-real-one?', exact: true })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Permanently delete', exact: true }).click()
  await dialog.getByText('Injected job cleanup is incomplete.', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Close — operation remains pending', exact: true }).click()
  fixture.jobDetailFailures = 1; fixture.jobDetailFailureStatus = status
  const operations = page.getByRole('region', { name: 'Incomplete lifecycle operations', exact: true })
  await operations.getByRole('button', { name: 'Retry lifecycle operation', exact: true }).click()
  await operations.getByRole('alert').waitFor()
  assert.equal(fixture.mutations.filter((item) => item.path.endsWith('/jobs/job-real-one/lifecycle')).length, 1)
  assert.equal(fixture.jobs.length, 1)
  assert.equal(await page.locator('.toast').filter({ hasText: /deletion.*complete|deletion acknowledged/i }).count(), 0)
})
