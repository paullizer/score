import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, stop } from 'esbuild'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { installGradeBlobLifecycleFake, installGradeLifecycleFake } from '../../server-tests/grade-lifecycle-fakes.mjs'
import { buildDocxPreviewTestWorker, docxPreviewBrowserPlugin } from './wordPreview.test-support.mjs'

export const tenantId = '228db43d-371a-49d8-864e-fa202d181ea5'
export const userId = '1d6312bd-3eaa-4586-8b74-e90eee126f78'
export const auth = {
  'x-ms-client-principal': Buffer.from(JSON.stringify({ auth_typ: 'aad', claims: [
    { typ: 'tid', val: tenantId }, { typ: 'oid', val: userId }, { typ: 'name', val: 'Grade integration reviewer' },
    { typ: 'preferred_username', val: 'grade-reviewer@example.test' },
  ], name_typ: 'name', role_typ: 'roles' })).toString('base64'),
}
const nativeFetch = globalThis.fetch
const clone = (value) => structuredClone(value)
const hash = (value) => createHash('sha256').update(value).digest('hex')

export async function buildGradeTestRuntime({ browser = false, serverExports = '' } = {}) {
  const directory = resolve(`.grade-integration-${randomUUID()}`)
  await mkdir(directory)
  try {
    const entries = {
      server: join('server', 'app.ts'),
      client: join('src', 'services', 'gradeLadders.ts'),
      jobs: join('src', 'services', 'realJobs.ts'),
      fixtures: join('src', 'data', 'fixtures.ts'),
      'word-parser': join('server', 'documents', 'word-parser-worker.ts'),
    }
    await Promise.all(Object.entries(entries).map(([name, entry]) => build({
      ...(name === 'server' && serverExports ? {
        stdin: {
          contents: `export * from './server/app.ts'\n${serverExports}`,
          resolveDir: resolve('.'), sourcefile: 'integration-runtime.ts', loader: 'ts',
        },
      } : { entryPoints: [entry] }),
      outfile: join(directory, `${name}.mjs`), bundle: true, packages: 'external', platform: 'node',
      format: 'esm', jsx: 'automatic', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' }, logLevel: 'silent',
    })))
    await build({
      entryPoints: [join('server-tests', 'job-lifecycle-fakes.mjs')], outfile: join(directory, 'job-fakes.mjs'), bundle: true,
      packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{
        name: 'share-integration-server-errors',
        setup(builder) {
          builder.onResolve({ filter: /dist-server[/\\]app\.mjs$/ }, () => ({ path: pathToFileURL(join(directory, 'server.mjs')).href, external: true }))
        },
      }],
    })
    if (browser) {
      await Promise.all([build({
        entryPoints: [join('src', 'main.tsx')], outfile: join(directory, 'browser.js'), bundle: true, platform: 'browser',
        format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' },
        plugins: [docxPreviewBrowserPlugin()],
        define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"', 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
      }), buildDocxPreviewTestWorker(directory)])
      const [{ default: postcss }, { default: tailwind }, { default: autoprefixer }] = await Promise.all([import('postcss'), import('tailwindcss'), import('autoprefixer')])
      const css = await postcss([tailwind(), autoprefixer()]).process(await readFile(join('src', 'styles', 'globals.css'), 'utf8'), { from: join('src', 'styles', 'globals.css') })
      await writeFile(join(directory, 'browser.css'), css.css)
      const html = (await readFile('index.html', 'utf8')).replace(/<script type="module" src="\/src\/main\.tsx"><\/script>/, '<link rel="stylesheet" href="/browser.css"><script type="module" src="/browser.js"></script>')
      await writeFile(join(directory, 'index.html'), html)
    }
    const [api, client, jobsClient, fixtures, jobFakes] = await Promise.all(['server', 'client', 'jobs', 'fixtures', 'job-fakes'].map((name) => import(pathToFileURL(join(directory, `${name}.mjs`)).href)))
    return { directory, api, client, jobsClient, fixtures, jobFakes, async close() {
      try { stop() } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
    } }
  } catch (error) {
    const errors = [error]
    try { stop() } catch (cleanupError) { errors.push(cleanupError) }
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch (cleanupError) { errors.push(cleanupError) }
    if (errors.length > 1) throw new AggregateError(errors, 'Grade test runtime setup and cleanup failed.')
    throw error
  }
}

export function memoryBlobs() {
  const values = new Map()
  return {
    values,
    async read(name) { const value = values.get(name); return value ? clone(value) : undefined },
    async putImmutable(name, bytes, contentType, options) {
      if (options?.signal?.aborted) throw options.signal.reason
      await options?.assertActive?.()
      const current = values.get(name)
      if (current) return { created: false, blob: clone(current) }
      const blob = { bytes: Uint8Array.from(bytes), contentType, sha256: hash(bytes), etag: `"blob-${values.size + 1}"` }
      values.set(name, blob)
      return { created: true, blob: clone(blob) }
    },
  }
}

function memoryGrades(api) {
  const values = new Map()
  let counter = 0
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  const next = (record) => ({ record: clone(api.parseGradeEntity(record)), etag: `"grade-${++counter}"` })
  const mutable = new Set(['grade-ladder', 'grade-source', 'grade-head', 'grade-work'])
  const store = {
    values,
    async get(workspaceId, id) { const value = values.get(key(workspaceId, id)); return value ? clone(value) : undefined },
    async list(workspaceId, options) {
      const all = [...values.values()].filter(({ record }) => record.workspaceId === workspaceId &&
        record.recordType === options.recordType && (!options.ladderId || record.ladderId === options.ladderId) &&
        (options.grade === undefined || record.grade === options.grade) && (!options.generationId || record.generationId === options.generationId) &&
        (!options.status || record.status === options.status)).sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt))
      const start = Number(options.continuationToken ?? 0)
      const size = Math.min(options.limit ?? 2, 2)
      return { items: all.slice(start, start + size).map(clone), ...(start + size < all.length ? { continuationToken: String(start + size) } : {}) }
    },
    async create(record) {
      const current = values.get(key(record.workspaceId, record.id))
      if (current) return { created: false, value: clone(current) }
      const value = next(record); values.set(key(record.workspaceId, record.id), value)
      return { created: true, value: clone(value) }
    },
    async replace(record, etag) {
      await store.transact(record.workspaceId, [{ kind: 'replace', record, etag }])
      return store.get(record.workspaceId, record.id)
    },
    async transact(workspaceId, operations) {
      for (const operation of operations) {
        assert.equal(operation.record.workspaceId, workspaceId)
        api.parseGradeEntity(operation.record)
        const current = values.get(key(workspaceId, operation.record.id))
        if (operation.kind === 'create' ? Boolean(current) : !current || current.etag !== operation.etag) throw new api.StoreConflictError('Concurrent test publication.')
        if (operation.kind === 'replace' && !mutable.has(operation.record.recordType)) throw new Error('Immutable grade records cannot be replaced.')
      }
      for (const operation of operations) values.set(key(workspaceId, operation.record.id), next(operation.record))
    },
    async listPending() { return [] },
  }
  installGradeLifecycleFake(store, { values, remove: (workspaceId, id) => values.delete(key(workspaceId, id)), StoreConflictError: api.StoreConflictError })
  return { store, blobs: installGradeBlobLifecycleFake(memoryBlobs()) }
}

function memoryJobs(jobFakes) {
  const fixture = jobFakes.createFakeRealJobs()
  return { ...fixture, records: fixture.store._records, rubrics: fixture.store._rubrics, blobs: { ...fixture.blobs, values: fixture.blobs._values } }
}

function memoryWorkspace(api) {
  const metadata = new Map(), memberships = new Map(), states = new Map()
  let counter = 0
  const saves = []
  const leases = new Set()
  let nextSaveDelay
  const directory = {
    metadata, memberships,
    async getMetadata(id) { return clone(metadata.get(id)) },
    async getMembership(id, member) { return clone(memberships.get(`${id}/${member}`)) },
    async listMembershipsForPrincipal(principal) { return [...memberships.values()].filter((membership) => membership.principalId === principal).map(clone) },
    async createWorkspace(record, membership) {
      if (metadata.has(record.workspaceId)) return { created: false }
      metadata.set(record.workspaceId, { metadata: clone(record), etag: `"directory-${++counter}"` })
      memberships.set(`${record.workspaceId}/${membership.id}`, clone(membership))
      return { created: true }
    },
    async renameWorkspace(id, name, updatedAt, etag) {
      const current = metadata.get(id)
      if (!current || current.etag !== etag) throw new api.StoreConflictError()
      const value = { metadata: { ...current.metadata, name, updatedAt }, etag: `"directory-${++counter}"` }; metadata.set(id, value); return clone(value)
    },
    async deleteWorkspace(id) { metadata.delete(id) },
    async replaceMetadata(record, etag) {
      if (metadata.get(record.workspaceId)?.etag !== etag) throw new api.StoreConflictError()
      const value = { metadata: clone(record), etag: `"directory-${++counter}"` }
      metadata.set(record.workspaceId, value)
      if (record.deletedAt && record.lifecycleOperation?.action === 'delete' && record.lifecycleOperation.status === 'complete') {
        memberships.delete(`${record.workspaceId}/${api.membershipIdFor(record.ownerId)}`)
      }
      return clone(value)
    },
    async deleteMemberships(id) {
      const current = metadata.get(id)
      if (!current) throw new api.StoreNotFoundError()
      const ownerId = api.membershipIdFor(current.metadata.ownerId)
      for (const [key, membership] of memberships) {
        if (membership.workspaceId === id && membership.id !== ownerId) memberships.delete(key)
      }
    },
    async listLifecycleOperations(limit) {
      return [...metadata.values()].filter((value) => value.metadata.lifecycleOperation && value.metadata.lifecycleOperation.status !== 'complete').slice(0, limit).map(clone)
    },
    async checkAccess() {},
  }
  const state = {
    states, saves,
    delayNextSave(promise) { nextSaveDelay = promise },
    async getState(id) { return clone(states.get(id)) },
    async createState(id, content) {
      if (states.has(id)) return { created: false, etag: states.get(id).etag }
      const value = { content, etag: `"state-${++counter}"` }; states.set(id, value); return { created: true, etag: value.etag }
    },
    async putState(id, content, etag) {
      const delay = nextSaveDelay; nextSaveDelay = undefined
      if (delay) await delay
      if (states.get(id)?.etag !== etag) throw new api.StoreConflictError()
      const value = { content, etag: `"state-${++counter}"` }; states.set(id, value); saves.push({ id, content }); return { etag: value.etag }
    },
    async deleteState(id, etag) {
      if (etag !== undefined && states.has(id) && states.get(id).etag !== etag) throw new api.StoreConflictError()
      states.delete(id)
    },
    async acquireMutationLease(id) {
      if (leases.has(id)) throw new api.StoreConflictError('A workspace mutation is already in flight.')
      leases.add(id)
      let released = false
      return {
        async renew() { if (released || !leases.has(id)) throw new api.StoreConflictError('The workspace lease was released.') },
        async release() { if (!released) { released = true; leases.delete(id) } },
      }
    },
    async checkAccess() {},
  }
  return { directory, state }
}

export async function startGradeFixture(runtime, { injectAuth = false, resumes, analyses, configOverrides = {} } = {}) {
  const { api } = runtime
  const grades = memoryGrades(api), jobs = memoryJobs(runtime.jobFakes), { directory, state } = memoryWorkspace(api)
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  let clock = Math.max(Date.now(), Date.parse('2026-09-17T19:00:00.000Z'))
  const now = () => new Date(++clock)
  const serviceConfig = { cosmosEndpoint: 'https://test.documents.azure.com', database: 'score', storageAccountUrl: 'https://test.blob.core.windows.net' }
  const config = {
    authMode: 'easyauth', tenantId, allowedUserIds: new Set([userId]), appOrigin: origin, isProduction: false, isAppService: false,
    cosmos: { endpoint: serviceConfig.cosmosEndpoint, database: 'score', container: 'workspaces' }, storage: { accountUrl: serviceConfig.storageAccountUrl, containerName: 'workspace-state' },
    realJobs: { ...serviceConfig, container: 'job-records', blobContainer: 'job-sources' },
    realGrades: { ...serviceConfig, container: 'grade-records', blobContainer: 'grade-sources' },
    ...configOverrides,
  }
  const app = api.createApp({ config, directory, state, jobs, grades, resumes, analyses, now, distDir: runtime.directory })
  const requests = []
  const pendingRequests = new Set()
  let holdNextMutation
  let overrideRead
  let disposed = false
  server.on('request', (req, res) => {
    if (injectAuth) req.headers['x-ms-client-principal'] = auth['x-ms-client-principal']
    requests.push({ url: req.url, method: req.method, headers: { ...req.headers } })
    if (holdNextMutation && req.method !== 'GET' && req.url.includes('/grade-ladders')) {
      const hold = holdNextMutation; holdNextMutation = undefined
      const end = res.end
      res.end = function (...args) { void hold.then(() => { if (!res.destroyed) end.apply(res, args) }); return res }
    }
    const serve = async () => {
      if (overrideRead && req.method === 'GET' && req.url === overrideRead.path) {
        const override = overrideRead; overrideRead = undefined
        await override.wait
        res.statusCode = override.status
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(override.body)); return
      }
      if (!disposed) app(req, res)
    }
    const pending = serve().catch((error) => { res.statusCode = 500; res.end(String(error)) }).finally(() => pendingRequests.delete(pending))
    pendingRequests.add(pending)
  })
  const request = async (path, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('x-ms-client-principal', auth['x-ms-client-principal'])
    headers.set('x-score-request', 'workspace')
    if (init.method && init.method !== 'GET') headers.set('Origin', origin)
    return nativeFetch(`${origin}${path}`, { ...init, headers })
  }
  const sessionResponse = await request('/api/session')
  if (sessionResponse.status !== 200) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.equal(sessionResponse.status, 200, await sessionResponse.text())
  }
  const session = await sessionResponse.json()
  const workspaceId = session.workspaces[0].id
  return {
    runtime, origin, server, api, config, grades, jobs, resumes, analyses, directory, state, session, workspaceId, requests, now,
    advanceClock(milliseconds) { clock += milliseconds },
    request,
    installClientFetch() {
      const previous = globalThis.fetch
      globalThis.fetch = (path, init = {}) => request(path, init)
      return () => { globalThis.fetch = previous }
    },
    holdMutation(promise) { holdNextMutation = promise },
    staleRead(path, body, wait, status = 200) { overrideRead = { path, body, wait, status } },
    setRole(role) {
      const principalId = api.principalKeyFor(tenantId, userId)
      const memberKey = `${workspaceId}/${api.membershipIdFor(principalId)}`
      directory.memberships.set(memberKey, { ...directory.memberships.get(memberKey), role })
    },
    async close() {
      disposed = true
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export async function seedRealJob(fixture) {
  const { jobs, workspaceId, now } = fixture
  const uuid = randomUUID(), jobId = `job-${uuid}`, documentId = `document-${uuid}`, rubricId = `rubric-${uuid}`
  const original = Buffer.from('<html><body>Engineering specialist. Apply engineering methods to defined projects and communicate findings.</body></html>')
  const originalName = `${workspaceId}/${jobId}/original.html`, documentName = `${workspaceId}/${jobId}/source-document.json`
  const source = (await jobs.blobs.putImmutable(originalName, original, 'text/html')).blob
  const paragraph = { id: 'engineering-work', page: 1, heading: 'Engineering work', text: 'Apply engineering methods to defined projects and communicate findings.' }
  const document = { id: documentId, title: 'Engineering specialist', kind: 'job', sample: false, version: 1, paragraphs: [paragraph] }
  await jobs.blobs.putImmutable(documentName, Buffer.from(JSON.stringify(document)), 'application/json')
  const citation = { documentId, documentVersion: 1, paragraphId: paragraph.id, page: 1, heading: paragraph.heading, quote: paragraph.text }
  const rubric = {
    id: rubricId, groupId: `group-${uuid}`, kind: 'job', jobId, name: 'Engineering work rubric', description: 'Source-grounded test seed.', version: 1,
    createdAt: now().toISOString(), dataKind: 'real', provenance: { kind: 'generated', model: 'test-only', promptVersion: 'test-job-v1' },
    criteria: [{ id: 'engineering-criterion', key: 'custom', label: 'Engineering methods', description: paragraph.text, weight: 100,
      guidance: '0: No evidence. 1: Observed work. 2: Assisted work. 3: Independent work. 4: Complex work. 5: Sustained broad work.',
      requirementType: 'required', sourceParagraphId: paragraph.id, sourceCitations: [citation] }],
  }
  const job = { id: jobId, title: 'Engineering specialist', organization: 'Integration test agency', location: 'Remote', arrangement: 'Remote', employmentType: 'Full time',
    grade: 'GS-9', series: '0801', source: 'url', sourceLabel: 'https://agency.example.test/engineering-job', documentId, rubricId, status: 'ready', createdAt: now().toISOString(), dataKind: 'real' }
  const record = { id: jobId, workspaceId, recordType: 'job', job, source: { kind: 'url', displayName: job.sourceLabel, url: job.sourceLabel, finalUrl: job.sourceLabel, originalBlobName: originalName, originalContentType: 'text/html', sha256: source.sha256, bytes: original.length, capturedAt: now().toISOString(), extractionMethod: 'html' },
    extractedBlobName: documentName, inputFingerprint: hash(original), createdBy: 'test-reviewer', updatedAt: now().toISOString(), attempts: 1, warnings: [] }
  await jobs.store.create(record)
  const second = { ...clone(rubric), version: 2, name: 'Engineering work rubric · latest', createdAt: now().toISOString(), provenance: { ...rubric.provenance, kind: 'edited' } }
  jobs.rubrics.set(`${workspaceId}/${jobId}`, [rubric, second])
  return { job, rubric, latestRubric: second, document }
}

export async function finishWork(fixture, ladderId, kinds) {
  for (const entry of [...fixture.grades.store.values.values()]) {
    const work = entry.record
    if (work.recordType === 'grade-work' && work.ladderId === ladderId && kinds.includes(work.input.kind) && ['queued', 'running'].includes(work.status)) {
      await fixture.grades.store.replace({ ...work, status: 'succeeded', updatedAt: fixture.now().toISOString() }, entry.etag)
    }
  }
}

export async function referencePdf() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= 204; index++) {
    const page = pdf.addPage([612, 792])
    page.drawText(`Integration test reference, original page ${index}.`, { x: 40, y: 740, font, size: 12 })
    if (index === 178) page.drawText('GS-9: Apply engineering methods to defined projects.', { x: 40, y: 710, font, size: 12 })
    if (index === 204) page.drawText('Minimum qualification: An applicable engineering degree or equivalent.', { x: 40, y: 710, font, size: 10 })
  }
  return new File([await pdf.save()], 'engineering-test-reference.pdf', { type: 'application/pdf' })
}

export async function completeReference(fixture, detail, sourceId) {
  const stored = await fixture.grades.store.get(fixture.workspaceId, sourceId)
  const source = stored.record
  const document = { id: source.documentId, kind: 'reference', sample: false, version: source.documentVersion, title: 'Engineering test reference', pageCount: 204, selectedPages: [178, 204], completeness: 'selected-pages',
    paragraphs: [
      { id: 'engineering-grade-9', page: 178, heading: 'GS-9 work', text: 'GS-9: Apply engineering methods to defined projects.', sectionId: 'work-level', table: { headers: ['Grade', 'Work scope'], row: 1 } },
      { id: 'engineering-qualification', page: 204, heading: 'Minimum qualifications', text: 'Minimum qualification: An applicable engineering degree or equivalent.', sectionId: 'qualifications' },
    ] }
  const name = `${fixture.workspaceId}/${detail.ladder.id}/${sourceId}/document-v${document.version}.json`
  await fixture.grades.blobs.putImmutable(name, Buffer.from(JSON.stringify(document)), 'application/json')
  await fixture.grades.store.replace({ ...source, status: 'ready', title: document.title, documentBlobName: name, completeness: document.completeness, selectedPages: document.selectedPages, pageCount: 204,
    capturedAt: fixture.now().toISOString(), extractionMethod: 'document-intelligence', extractionVersion: 'test-publication-v1',
    coverage: { series: ['0801'], grades: [9], functions: [], state: 'confirmed', explanation: 'Test fixture provides an explicit GS-9 example only; no GS-11 distinction is evidenced.' },
    updatedAt: fixture.now().toISOString(), issues: [] }, stored.etag)
  await finishWork(fixture, detail.ladder.id, ['extract-source'])
  return document
}

export async function publishGrade(fixture, detail, document, grade = 9, supported = true) {
  const timestamp = fixture.now().toISOString(), id = `grade-version-${randomUUID()}`
  const exact = (paragraph) => ({ documentId: document.id, documentVersion: document.version, paragraphId: paragraph.id, page: paragraph.page, heading: paragraph.heading, quote: paragraph.text })
  const work = exact(document.paragraphs[0]), prerequisite = exact(document.paragraphs[1])
  const issues = supported ? [] : [{ id: `missing-grade-${grade}`, code: 'missing-grade-evidence', severity: 'blocker', scope: 'grade', grade, message: `GS-${grade} has no supporting work-level distinction in the captured set.` }]
  const version = {
    id, recordType: 'grade-version', workspaceId: fixture.workspaceId, ladderId: detail.ladder.id, createdAt: timestamp, updatedAt: timestamp,
    grade, version: 1, generationId: detail.ladder.generationId, sourceSetId: detail.ladder.sourceSetId, createdBy: 'test-worker', contentHash: '', issues,
    rubric: { id, groupId: `grade-head-${detail.ladder.id.slice(7)}-${grade}`, kind: 'grade', dataKind: 'real',
      ladder: detail.ladder.name, grade: `GS-${grade}`, version: 1, createdAt: timestamp, name: `GS-${grade} engineering expectations`, description: 'Review-only integration fixture, not OPM classification.',
      provenance: { kind: 'generated', model: 'test-publication', promptVersion: 'test-grade-v1' },
      criteria: [{ id: 'shared-engineering-methods', key: 'technical', competencyId: 'shared-engineering-methods', label: 'Engineering methods', description: supported ? work.quote : 'Supporting grade expectations remain unresolved.',
        weight: supported ? 100 : 0, support: supported ? 'direct' : 'gap', gradeBasis: supported ? [work] : [], sourceCitations: supported ? [work] : [],
        interpretation: supported ? 'The explicit GS-9 scope supports applying engineering methods to defined projects, not an inferred GS-11 expansion.' : '',
        guidance: supported ? '0: No demonstrated application.\n1: Observes a defined task.\n2: Applies methods with assistance.\n3: Applies methods independently.\n4: Handles complex defined tasks.\n5: Sustains application across defined projects.' : 'Unscored until captured evidence supports this grade expectation.' }],
    },
    qualifications: supported ? [{ id: 'engineering-degree', text: prerequisite.quote, support: 'direct', citations: [prerequisite], interpretation: 'The source preserves an engineering degree or equivalent alternative as an unscored prerequisite.' }] : [],
  }
  version.contentHash = fixture.api.gradeVersionHash(version)
  const review = { id: `grade-review-${randomUUID()}`, recordType: 'grade-review', workspaceId: fixture.workspaceId, ladderId: detail.ladder.id, createdAt: timestamp, updatedAt: timestamp,
    grade, versionId: id, versionHash: version.contentHash, sourceSetId: version.sourceSetId, outcome: supported ? 'supported' : 'needs-sources', issues,
    model: 'test-grounding-publication', promptVersion: 'test-review-v1' }
  const headId = `grade-head-${detail.ladder.id.slice(7)}-${grade}`
  const current = await fixture.grades.store.get(fixture.workspaceId, headId)
  await fixture.grades.store.transact(fixture.workspaceId, [
    { kind: 'create', record: version }, { kind: 'create', record: review },
    { kind: 'replace', etag: current.etag, record: { ...current.record, latestVersionId: id, latestReviewId: review.id, status: supported ? 'ready-for-review' : 'needs-sources', updatedAt: timestamp, issues } },
  ])
  return { version, review }
}

export async function publishNeedsSourcesReview(fixture, level, issues) {
  const version = level.version
  const timestamp = fixture.now().toISOString()
  const review = {
    id: `grade-review-${randomUUID()}`, recordType: 'grade-review', workspaceId: version.workspaceId, ladderId: version.ladderId,
    createdAt: timestamp, updatedAt: timestamp, grade: version.grade, versionId: version.id,
    versionHash: version.contentHash, sourceSetId: version.sourceSetId, outcome: 'needs-sources', issues: clone(issues),
    model: 'test-grounding-publication', promptVersion: 'test-review-v1',
  }
  const current = await fixture.grades.store.get(version.workspaceId, level.head.id)
  assert.equal(current.record.latestVersionId, version.id)
  await fixture.grades.store.transact(version.workspaceId, [
    { kind: 'create', record: review },
    { kind: 'replace', etag: current.etag, record: { ...current.record, status: 'needs-sources', latestReviewId: review.id, issues: clone(issues), updatedAt: timestamp } },
  ])
  await finishWork(fixture, version.ladderId, ['review-grade'])
  return review
}

export async function seededLadder(fixture) {
  const client = fixture.runtime.client
  const restoreFetch = fixture.installClientFetch()
  try {
    const seed = await seedRealJob(fixture)
    const input = { name: 'Engineering grade family', jobId: seed.job.id, rubricId: seed.rubric.id, rubricVersion: 1,
      context: { series: '0801', agency: 'Integration test agency', agencyType: 'other-federal', supervision: 'nonsupervisory', functions: [], specialty: 'Defined engineering projects', confirmed: true, answers: {} }, grades: [9, 11] }
    let detail = await client.createGradeLadder(fixture.workspaceId, input, randomUUID())
    await finishWork(fixture, detail.ladder.id, ['discover'])
    detail = await client.uploadGradeSourcePdf(fixture.workspaceId, detail.ladder.id, await referencePdf(), randomUUID(), [178, 204])
    const source = detail.sources.find((source) => source.origin === 'upload')
    const document = await completeReference(fixture, detail, source.id)
    detail = await client.getGradeLadder(fixture.workspaceId, detail.ladder.id)
    detail = await client.confirmGradeSources(fixture.workspaceId, detail.ladder.id, { decisions: detail.sources.map((source) => ({ sourceId: source.id, selected: true, applicability: 'applicable', reason: 'Reviewed test context and explicit source coverage.' })) }, detail.etag, randomUUID())
    detail = await client.generateGradeLadder(fixture.workspaceId, detail.ladder.id, detail.etag, randomUUID())
    await finishWork(fixture, detail.ladder.id, ['plan-competencies'])
    const first = await publishGrade(fixture, detail, document, 9, true)
    const second = await publishGrade(fixture, detail, document, 11, false)
    const ladder = await fixture.grades.store.get(fixture.workspaceId, detail.ladder.id)
    await fixture.grades.store.replace({ ...ladder.record, status: 'review', updatedAt: fixture.now().toISOString() }, ladder.etag)
    detail = await client.getGradeLadder(fixture.workspaceId, detail.ladder.id)
    return { detail, seed, source: detail.sources.find((item) => item.id === source.id), document, first, second }
  } finally { restoreFetch() }
}
