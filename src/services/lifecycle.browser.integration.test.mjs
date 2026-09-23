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
const clone = (value) => structuredClone(value)
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
let browser, domain, cloudServer

async function serve() {
  const html = (await readFile('index.html', 'utf8')).replace(/<script type="module" src="\/src\/main\.tsx"><\/script>/, '<link rel="stylesheet" href="/browser.css"><script type="module" src="/browser.js"></script>')
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path.startsWith('/api/')) { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'not_found', message: 'Unmocked lifecycle request.' } })); return }
    response.writeHead(200, { 'Content-Type': path === '/browser.js' ? 'application/javascript' : path === '/browser.css' ? 'text/css' : 'text/html' })
    response.end(path === '/browser.js' ? await readFile(join(directory, 'browser.js')) : path === '/browser.css' ? await readFile(join(directory, 'browser.css')) : html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}

before(async () => {
  await mkdir(directory)
  await build({
    entryPoints: [join('src', 'main.tsx')], outfile: join(directory, 'browser.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
    loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
  })
  await build({
    stdin: { contents: "export * from './src/domain/lifecycle'; export { gradeHeadId } from './src/domain/real-grades'; export { createDefaultAdminSettings } from './src/domain/admin-settings-defaults'; export { captureProcessingSettings, projectPublicSettings } from './src/domain/admin-settings-resolver';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(directory, 'domain.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  })
  domain = await import(pathToFileURL(join(directory, 'domain.mjs')).href)
  const [{ default: postcss }, { default: tailwind }, { default: autoprefixer }] = await Promise.all([import('postcss'), import('tailwindcss'), import('autoprefixer')])
  const styles = await Promise.all(['globals.css', 'admin-settings.css', 'workspace-access.css'].map(file => readFile(join('src', 'styles', file), 'utf8')))
  const css = await postcss([tailwind(), autoprefixer()]).process(styles.join('\n'), { from: join('src', 'styles', 'globals.css') })
  await writeFile(join(directory, 'browser.css'), css.css)
  cloudServer = await serve()
  try { browser = await chromium.launch({ headless: true }) }
  catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  }
})
after(async () => {
  const closed = await Promise.allSettled([browser?.close(), cloudServer?.close()])
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
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await (await response).finished()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function pageFor(t) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15000)
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'No browser runtime errors') })
  return page
}

function testWorkspace() {
  const document = { id: 'document-template', version: 1, kind: 'job', title: 'Template real source', sample: false,
    paragraphs: [{ id: 'paragraph-one', page: 1, heading: 'Engineering work', text: 'Applies engineering methods to defined projects.' }] }
  const criterion = { id: 'criterion-one', key: 'engineering', label: 'Engineering methods', description: 'Apply engineering methods.', weight: 100,
    guidance: 'Review exact evidence.', requirementType: 'required', sourceParagraphId: 'paragraph-one' }
  const rubric = { id: 'rubric-template', groupId: 'group-template', kind: 'job', jobId: 'job-template', name: 'Template job rubric',
    description: 'Real template rubric', version: 1, dataKind: 'real', createdAt: timestamp, criteria: [criterion] }
  const grade = { ...rubric, id: 'grade-template', groupId: 'grade-group-template', kind: 'grade', jobId: undefined, name: 'Template GS rubric', grade: 'GS-9' }
  const job = { id: 'job-template', title: 'Template real job', organization: 'Example agency', location: 'Remote',
    arrangement: 'Remote', employmentType: 'Full time', grade: 'GS-9', series: '0801', source: 'url', sourceLabel: 'Template source',
    documentId: document.id, rubricId: rubric.id, status: 'ready', createdAt: timestamp, dataKind: 'real' }
  return { jobs: [job], documents: [document], rubrics: [rubric, grade], lifecycle: { entities: {} } }
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

async function renameItem(page, kind, currentName, nextName) {
  await page.getByRole('button', { name: `Rename ${kind}: ${currentName}`, exact: true }).first().click()
  const fields = { job: 'Job display title', resume: 'Resume label', analysis: 'Analysis name' }
  const dialog = page.getByRole('dialog', { name: `Edit ${fields[kind].toLowerCase()}`, exact: true })
  const input = dialog.getByRole('textbox', { name: fields[kind], exact: true })
  assert.equal(await input.getAttribute('maxlength'), '160')
  await input.fill(nextName)
  await input.press('Enter')
  await dialog.waitFor({ state: 'hidden' })
}

function cloudFixture(workspace = testWorkspace(), summaries = []) {
  let revision = 1
  const user = { id: 'reviewer', tenantId: 'tenant', name: 'Lifecycle reviewer', email: 'reviewer@example.test' }
  const state = {
    user, workspace, summaries, jobs: [], ladders: [], saves: [], mutations: [], requests: [], pendingArchive: false,
    capabilities: { applicationAdmin: false, canCreateWorkspaces: true },
    settings: domain.createDefaultAdminSettings(),
    eligibleUsers: [
      { id: 'eligible-one', name: 'Eligible colleague', email: 'colleague@example.test', applicationRoles: ['Score.User'] },
      { id: 'never-signed-in', name: 'New teammate', email: 'new@example.test', applicationRoles: ['Score.User'] },
    ],
    members: { members: [{ id: user.id, name: user.name, email: user.email, role: 'owner' }], etag: '"members-1"' },
    creationGrant: { userId: 'never-signed-in', canCreateWorkspaces: false, etag: '"unassigned"' }, memberFailure: null,
    beforeRead: null, beforeSave: null, saveFailures: [], jobPending: [], gradePending: [], gradeFailureStatus: 503,
    lifecycleFailure: null, impactFailures: 0, jobDetailFailures: 0, jobDetailFailureStatus: 503,
    gradeImpactFailures: 0, hideDeletingFamilies: false, stateMissing: false, summaryCounts: {},
  }
  const response = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
  const impact = (target, name, counts = {}, blockers = []) => ({ target, name, counts, blockers })
  state.install = async (page) => {
    await page.route('**/api/**', async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method()
      const path = decodeURIComponent(url.pathname), body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? request.postDataJSON() : undefined
      state.requests.push([method, path])
      if (method !== 'GET') state.mutations.push({ method, path, body, etag: request.headers()['if-match'] })
      if (path === '/api/session') return response(route, { mode: 'cloud', user, capabilities: clone(state.capabilities), workspaces: clone(state.summaries) })
      if (path === '/api/session/identity') return response(route, { mode: 'cloud', user, capabilities: clone(state.capabilities) })
      if (path === '/api/admin/users' || path.endsWith('/share-candidates')) {
        const query = url.searchParams.get('query')?.toLowerCase()
        const users = state.eligibleUsers.filter(person => !query || `${person.name} ${person.email}`.toLowerCase().includes(query))
        const index = Number(url.searchParams.get('continuation') ?? 0)
        return response(route, { users: clone(users.slice(index, index + 1)), ...(index + 1 < users.length ? { continuation: String(index + 1) } : {}) })
      }
      if (path.endsWith('/workspace-creation')) {
        if (method === 'PUT') {
          assert.equal(request.headers()['if-match'], state.creationGrant.etag)
          state.creationGrant = { ...state.creationGrant, canCreateWorkspaces: body.canCreateWorkspaces, etag: `"grant-${++revision}"` }
        }
        return response(route, clone(state.creationGrant))
      }
      if (path === '/api/features') return response(route, { realJobImports: true, realGradeLadders: true,
        publicSettings: domain.projectPublicSettings(domain.captureProcessingSettings(state.settings, 'legacy-v1', timestamp), false) })
      if (path === '/api/workspaces' && method === 'GET') return response(route, { workspaces: clone(state.summaries) })
      if (path === '/api/workspaces' && method === 'POST') {
        const created = workspaceSummary(`created-${revision++}`, body.name)
        state.summaries.push(created)
        return response(route, { workspace: created }, 201)
      }
      const root = /^\/api\/workspaces\/([^/]+)(.*)$/.exec(path)
      if (!root) return response(route, { error: { code: 'not_found', message: path } }, 404)
      const [, workspaceId, tail] = root
      if (tail === '/members') return response(route, clone(state.members))
      if (tail.startsWith('/members/')) {
        assert.equal(request.headers()['if-match'], state.members.etag)
        if (state.memberFailure) {
          const message = state.memberFailure; state.memberFailure = null
          return response(route, { error: { code: 'conflict', message } }, 409)
        }
        const id = tail.split('/').at(-1)
        const person = state.eligibleUsers.find(person => person.id === id) ?? user
        state.members = {
          members: [...state.members.members.filter(member => member.id !== id), ...(method === 'PUT' ? [{ id, name: person.name, email: person.email, role: body.role }] : [])],
          etag: `"members-${++revision}"`,
        }
        if (id === user.id && !state.capabilities.applicationAdmin) {
          state.summaries = method === 'DELETE' ? state.summaries.filter(item => item.id !== workspaceId)
            : state.summaries.map(item => item.id === workspaceId ? { ...item, role: body.role, accessSource: 'membership' } : item)
        }
        return response(route, clone(state.members))
      }
      if (tail === '/summary') {
        const counts = state.summaryCounts[workspaceId] ?? { jobs: 0, resumes: 0, analyses: 0 }
        return response(route, { workspaceId, ...Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, { status: 'ready', count }])) })
      }
      if (tail === '/lifecycle') {
        const current = state.summaries.find((item) => item.id === workspaceId)
        if (method === 'GET') return response(route, { impact: impact({ kind: 'workspace', id: workspaceId }, current.name, { workspaces: 1 }, []) })
        assert.equal(request.headers()['if-match'], current.etag)
        if (body.action === 'delete') { state.summaries = state.summaries.filter((item) => item.id !== workspaceId); return response(route, { deleted: true }) }
        current.etag = `"metadata-${++revision}"`
        if (body.action === 'archive') current.archivedAt = timestamp
        else delete current.archivedAt
        const operation = { id: 'workspace-operation', action: body.action, status: state.pendingArchive ? 'running' : 'complete', updatedAt: timestamp }
        state.pendingArchive = false
        current.lifecycleOperation = operation
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

for (const theme of ['light', 'dark']) for (const width of [1440, 390]) test(`workspace home is keyboard accessible and responsive at ${width}px in ${theme} mode`, { timeout: 60000 }, async (t) => {
  const first = workspaceSummary('workspace-one', 'Clinical research')
  const second = workspaceSummary('workspace-two', 'Program delivery', 'viewer')
  const third = workspaceSummary('workspace-three', 'An exceptionally detailed workspace name for research and interdisciplinary work')
  const archived = { ...workspaceSummary('workspace-archived', 'Archived review'), archivedAt: timestamp }
  const fixture = cloudFixture(testWorkspace(), [first, second, third, archived])
  fixture.summaryCounts[first.id] = { jobs: 12, resumes: 38, analyses: 7 }
  const page = await pageFor(t)
  await page.setViewportSize({ width, height: 1000 })
  await page.addInitScript(({ theme, timestamp }) => {
    localStorage.setItem('score-theme', theme)
    localStorage.setItem('score-cloud-recent-workspaces:tenant:reviewer', JSON.stringify({ version: 1, entries: [
      { id: 'workspace-two', lastOpenedAt: timestamp }, { id: 'workspace-one', lastOpenedAt: '2026-09-17T12:00:00.000Z' },
      { id: 'workspace-archived', lastOpenedAt: '2026-09-16T12:00:00.000Z' },
    ] }))
  }, { theme, timestamp })
  await fixture.install(page)
  await page.goto(cloudServer.origin)
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  await page.locator('.workspace-card-counts dd').getByText('38', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/')
  assert.equal(await page.locator('.workspace-home-card').count(), 3)
  assert.equal(await page.getByRole('button', { name: 'Open recent workspace Program delivery', exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Open recent workspace Archived review', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Rename Program delivery', exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Home must fit the viewport, including long names')
  assert.equal(fixture.requests.some(([, path]) => /\/workspaces\/[^/]+\/(?:state|jobs|resumes|analyses|grade-ladders)(?:\/|$)/.test(path)), false, 'Home must not fetch a workspace library or private content')
  if (process.env.SCORE_TEST_SCREENSHOT_DIR) {
    await mkdir(process.env.SCORE_TEST_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.SCORE_TEST_SCREENSHOT_DIR, `workspace-home-${width}-${theme}.png`), fullPage: true })
  }
  const create = page.getByRole('button', { name: 'New workspace', exact: true })
  await create.focus()
  await page.keyboard.press('Enter')
  const input = page.getByRole('textbox', { name: 'New workspace name', exact: true })
  await input.waitFor()
  assert.equal(await input.evaluate((element) => element === document.activeElement), true)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'New workspace', exact: true }).waitFor({ state: 'hidden' })
  await page.getByRole('searchbox', { name: 'Search workspaces', exact: true }).fill('Archived review')
  await page.getByRole('button', { name: 'Archived review', exact: true }).waitFor()
  assert.equal(await page.locator('.workspace-home-card').count(), 1)
  assert.equal(await page.locator('.workspace-home-card .workspace-card-counts').count(), 0)
  await page.getByRole('searchbox', { name: 'Search workspaces', exact: true }).fill('')
  await page.getByRole('button', { name: first.name, exact: true }).click()
  await page.getByRole('heading', { name: 'Your jobs', exact: true }).waitFor()
  if (width < 760) {
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
    await page.getByRole('dialog', { name: 'Your workspace', exact: true }).getByRole('button', { name: 'All workspaces', exact: true }).click()
  } else await page.getByRole('link', { name: 'Score home', exact: true }).click()
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/')
})

test('mobile workspace home shares access, prunes self-removal, and preserves implicit admin access with global creation policy', { timeout: 60000 }, async (t) => {
  const summary = workspaceSummary()
  const fixture = cloudFixture(testWorkspace(), [summary])
  fixture.capabilities.canCreateWorkspaces = false
  fixture.settings.workspaces.allowCreation = false
  fixture.summaryCounts[summary.id] = { jobs: 7, resumes: 11, analyses: 2 }
  const page = await pageFor(t)
  await page.setViewportSize({ width: 390, height: 1000 })
  await page.addInitScript(({ id, timestamp }) => localStorage.setItem('score-cloud-recent-workspaces:tenant:reviewer',
    JSON.stringify({ version: 1, entries: [{ id, lastOpenedAt: timestamp }] })), { id: summary.id, timestamp })
  await fixture.install(page)
  await page.goto(cloudServer.origin)
  await page.locator('.workspace-card-counts dd').getByText('11', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/')
  assert.equal(await page.getByRole('button', { name: 'New workspace', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: `Manage access to ${summary.name}`, exact: true }).click()
  const access = page.getByRole('dialog', { name: 'Manage access', exact: true })
  await access.getByRole('searchbox', { name: 'Search eligible people', exact: true }).fill('new@example.test')
  await access.getByRole('button', { name: 'Select New teammate', exact: true }).click()
  assert.equal(await access.getByRole('combobox', { name: 'New member role', exact: true }).inputValue(), 'viewer')
  await access.getByRole('button', { name: 'Review adding member', exact: true }).click()
  await page.getByRole('dialog', { name: 'Add workspace member?', exact: true }).getByRole('button', { name: 'Save membership', exact: true }).click()
  await access.getByRole('combobox', { name: 'Role for New teammate', exact: true }).selectOption('owner')
  await page.getByRole('dialog', { name: 'Change workspace role?', exact: true }).getByRole('button', { name: 'Save membership', exact: true }).click()
  await until(() => access.getByRole('combobox', { name: 'Role for New teammate', exact: true }).inputValue().then(role => role === 'owner'), 'Peer ownership is acknowledged.')
  await access.getByRole('button', { name: 'Remove Lifecycle reviewer', exact: true }).click()
  await page.getByRole('dialog', { name: 'Remove workspace member?', exact: true }).getByRole('button', { name: 'Remove membership', exact: true }).click()
  await access.getByRole('alert').filter({ hasText: 'no longer has permission to manage' }).waitFor()
  await access.getByRole('button', { name: 'Close dialog', exact: true }).click()
  assert.equal(await page.locator('.workspace-home-card').count(), 0)
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('score-cloud-recent-workspaces:tenant:reviewer')).entries), [])
  assert.equal(fixture.requests.some(([, path]) => /\/workspaces\/[^/]+\/(?:state|jobs|resumes|analyses|grade-ladders)(?:\/|$)/.test(path)), false)
  fixture.capabilities = { applicationAdmin: true, canCreateWorkspaces: true }
  fixture.summaries = [{ ...summary, accessSource: 'application-admin' }]
  await refreshDirectory(page)
  await page.locator('.workspace-home-card').getByText('Application administrator', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'New workspace', exact: true }).isDisabled(), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.getByRole('button', { name: 'Users / user access', exact: true }).click()
  await page.getByRole('heading', { name: 'Users / user access', exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/admin/users')
})

test('archiving the current workspace returns home rather than entering another available workspace', { timeout: 60000 }, async (t) => {
  const first = workspaceSummary('workspace-one', 'Current review')
  const other = workspaceSummary('workspace-two', 'Another review')
  const fixture = cloudFixture(testWorkspace(), [first, other])
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs`)
  await page.getByRole('heading', { name: 'Your jobs', exact: true }).waitFor()
  await page.locator('.sidebar .workspace-switcher-trigger').click()
  await lifecycle(page, first.name, 'archive')
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/')
  assert.equal(fixture.requests.some(([, path]) => path === '/api/workspaces/workspace-two/state'), false)
  await page.getByRole('button', { name: other.name, exact: true }).waitFor()
})

test('cloud empty directory, last-workspace archive, pending retry, and explicit unarchive stay real-only', { timeout: 90000 }, async (t) => {
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
  assert.equal(await page.getByText('Archived · read only', { exact: true }).count() > 0, true)
  await lifecycle(page, 'Only workspace', 'unarchive')
  await lifecycle(page, 'Only workspace', 'delete')
  await page.reload()
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  assert.equal(fixture.summaries.length, 0)
  assert.equal(fixture.mutations.filter((item) => item.path === '/api/workspaces').length, 1)
  await page.goto(`${cloudServer.origin}/workspaces/${selectedId}/jobs`)
  await page.getByRole('heading', { name: 'This workspace is unavailable', exact: true }).waitFor()
})

test('archived cloud deep links are readable for viewers but never selected automatically or usable as seeds', { timeout: 60000 }, async (t) => {
  const sample = testWorkspace()
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

test('cross-tab workspace lifecycle refresh preserves unsaved grade drafts and their leave protection', { timeout: 60000 }, async (t) => {
  const sample = testWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
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
  fixture.workspace = fixture.workspace
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await editor.getByText('Archived · read only', { exact: true }).waitFor()
  assert.equal(await editor.getByRole('textbox', { name: 'Grade rubric name', exact: true }).inputValue(), 'Keep this unsaved draft')
  assert.equal(await editor.getByRole('button', { name: 'Save draft and request review', exact: true }).isDisabled(), true)
  await editor.getByRole('button', { name: 'Close draft', exact: true }).click()
  const protection = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
  await protection.getByRole('button', { name: 'Stay here', exact: true }).click()
  assert.equal(await editor.getByRole('textbox', { name: 'Grade rubric name', exact: true }).inputValue(), 'Keep this unsaved draft')
  assert.equal(fixture.saves.length, 0)
})

test('workspace access browser: empty capabilities and pre-login admin creation grants', { timeout: 60000 }, async (t) => {
  const fixture = cloudFixture()
  fixture.capabilities.canCreateWorkspaces = false
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(cloudServer.origin)
  await page.getByRole('heading', { name: 'My workspaces', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'New workspace', exact: true }).isDisabled(), true)
  assert.equal(fixture.mutations.length, 0)
  fixture.capabilities.canCreateWorkspaces = true
  await refreshDirectory(page)
  assert.equal(await page.getByRole('button', { name: 'New workspace', exact: true }).isEnabled(), true)
  assert.equal(fixture.mutations.length, 0, 'Session refresh never bootstraps a workspace.')

  fixture.capabilities.applicationAdmin = true
  await page.goto(`${cloudServer.origin}/admin/users`)
  await page.getByRole('heading', { name: 'Users / user access', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Load more people', exact: true }).click()
  await page.getByRole('button', { name: 'Select New teammate', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Can create workspaces', exact: true }).check()
  await page.getByRole('button', { name: 'Review permission change', exact: true }).click()
  assert.equal(fixture.mutations.length, 0)
  await page.getByRole('dialog', { name: 'Grant workspace creation?', exact: true }).getByRole('button', { name: 'Grant permission', exact: true }).click()
  await page.getByText('Workspace-creation permission granted. Existing workspace access is unchanged.', { exact: true }).waitFor()
  assert.equal(fixture.creationGrant.canCreateWorkspaces, true)
  assert.deepEqual(fixture.mutations.map(item => [item.method, item.path, item.etag]), [
    ['PUT', '/api/admin/users/never-signed-in/workspace-creation', '"unassigned"'],
  ])
})

test('workspace access browser: Reader sharing, conflict recovery, downgrade and revocation', { timeout: 60000 }, async (t) => {
  const fixture = cloudFixture(testWorkspace(), [{ ...workspaceSummary(), accessSource: 'application-admin' }])
  fixture.capabilities.applicationAdmin = true
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/jobs`)
  await page.locator('.sidebar .workspace-switcher-trigger').click()
  await page.getByRole('button', { name: 'Manage access to Lifecycle workspace', exact: true }).click()
  const access = page.getByRole('dialog', { name: 'Manage access', exact: true })
  await access.getByText('Your access: Application administrator', { exact: true }).waitFor()
  await access.getByRole('searchbox', { name: 'Search eligible people', exact: true }).fill('new@example.test')
  await access.getByRole('button', { name: 'Select New teammate', exact: true }).click()
  assert.equal(await access.getByRole('combobox', { name: 'New member role', exact: true }).inputValue(), 'viewer')
  await access.getByRole('button', { name: 'Review adding member', exact: true }).click()
  assert.equal(fixture.mutations.length, 0)
  await page.getByRole('dialog', { name: 'Add workspace member?', exact: true }).getByRole('button', { name: 'Save membership', exact: true }).click()
  const role = access.getByRole('combobox', { name: 'Role for New teammate', exact: true })
  await role.waitFor()
  assert.deepEqual(fixture.mutations[0].body, { role: 'viewer' })
  assert.equal(fixture.mutations[0].etag, '"members-1"')

  fixture.memberFailure = 'Another Owner changed this membership revision.'
  await role.selectOption('editor')
  await page.getByRole('dialog', { name: 'Change workspace role?', exact: true }).getByRole('button', { name: 'Save membership', exact: true }).click()
  await access.getByRole('alert').filter({ hasText: 'Nothing was automatically resent' }).waitFor()
  assert.equal(await role.isDisabled(), true)
  assert.equal(fixture.mutations.length, 2)
  await access.getByRole('button', { name: 'Refresh members', exact: true }).click()
  await until(() => role.isEnabled(), 'Membership recovery requires a fresh read.')
  assert.equal(fixture.mutations.length, 2)
  assert.equal(await role.inputValue(), 'viewer')

  fixture.capabilities = { applicationAdmin: false, canCreateWorkspaces: false }
  fixture.summaries[0] = { ...fixture.summaries[0], role: 'viewer', accessSource: 'membership' }
  await refreshDirectory(page)
  await access.getByRole('alert').filter({ hasText: 'no longer has permission to manage' }).waitFor()
  await access.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'My workspaces', exact: true })
  assert.equal(await picker.getByRole('button', { name: 'Manage access to Lifecycle workspace', exact: true }).count(), 0)
  await picker.getByRole('button', { name: 'Close dialog', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'New analysis', exact: true }).isDisabled(), true)
  fixture.summaries = []
  await refreshDirectory(page)
  await page.getByRole('heading', { name: 'Workspace access is no longer available', exact: true }).waitFor()
  assert.equal(await page.locator('.app-layout').isVisible(), false)
  const requests = fixture.requests.filter(([, path]) => path.startsWith('/api/workspaces/')).length
  await refreshDirectory(page)
  assert.equal(fixture.requests.filter(([, path]) => path.startsWith('/api/workspaces/')).length, requests)
})

test('workspace access browser: revoked grade drafts remain protected and restore only with access', { timeout: 60000 }, async (t) => {
  const sample = testWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
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
  await editor.getByRole('textbox', { name: 'Grade rubric name', exact: true }).fill('Retain my access-revoked draft')
  fixture.summaries[0] = { ...fixture.summaries[0], role: 'viewer' }
  await refreshDirectory(page)
  assert.equal(await editor.getByRole('button', { name: 'Save draft and request review', exact: true }).isDisabled(), true)
  assert.equal(await editor.getByRole('textbox', { name: 'Grade rubric name', exact: true }).inputValue(), 'Retain my access-revoked draft')
  fixture.summaries = []
  await refreshDirectory(page)
  await page.getByRole('heading', { name: 'Workspace access is no longer available', exact: true }).waitFor()
  assert.equal(await editor.isVisible(), false)
  assert.equal(fixture.mutations.length, 0)
  fixture.summaries = [{ ...workspaceSummary(), role: 'editor' }]
  await refreshDirectory(page)
  await editor.waitFor()
  assert.equal(await editor.getByRole('textbox', { name: 'Grade rubric name', exact: true }).inputValue(), 'Retain my access-revoked draft')
  assert.equal(fixture.mutations.length, 0, 'Restoration never replays the draft.')
  fixture.summaries = []
  await refreshDirectory(page)
  await page.getByRole('button', { name: 'Choose another workspace', exact: true }).click()
  await page.getByRole('dialog', { name: 'Discard unsaved changes and leave?', exact: true }).getByRole('button', { name: 'Discard local changes and leave', exact: true }).click()
  const protection = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
  await protection.getByRole('button', { name: 'Stay here', exact: true }).click()
  await page.getByRole('heading', { name: 'Workspace access is no longer available', exact: true }).waitFor()
  assert.equal(fixture.mutations.length, 0)
})

test('real jobs reconcile every page, evict deleted details, and reject stale detail replies without legacy state autosave', { timeout: 90000 }, async (t) => {
  const sample = testWorkspace()
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
  const sample = testWorkspace()
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
  assert.equal(fixture.saves.length, 0, 'Real lifecycle overlays must never be written to legacy state autosave')
})

test('an archived empty grade exposes only Unarchive without restoring deleted history', { timeout: 90000 }, async (t) => {
  const sample = testWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
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
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/rubrics?kind=grade`)
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
  const sample = testWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
  fixture.ladders = [realLadder(sample), realLadder(sample, 'ladder-real-two')]
  const page = await pageFor(t)
  await fixture.install(page)
  await page.goto(`${cloudServer.origin}/workspaces/workspace-one/rubrics?kind=grade`)
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
  const sample = testWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
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
  const sample = testWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
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
  const sample = testWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
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
  const sample = testWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
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

for (const status of [403, 404]) test(`retained cleanup ETags do not bypass a ${status} refresh response or claim deletion complete`, { timeout: 60000 }, async (t) => {
  const sample = testWorkspace(), fixture = cloudFixture(sample, [workspaceSummary()])
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
