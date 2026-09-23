import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const originalFetch = globalThis.fetch
const outputDirectory = resolve(`.grade-client-tests-${randomUUID()}`)
const key = 'b170274c-b0dc-4579-a589-18c5c7bde712'
const timestamp = '2026-09-17T18:00:00.000Z'
let client, jobClient, ui, components
let requests
const emptyProjection = () => ({ jobs: [], documents: [], rubrics: [], lifecycle: { entities: {} } })

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function citation() {
  return { documentId: 'reference-1', documentVersion: 1, paragraphId: 'paragraph-178', page: 178, heading: 'GS-9 engineering work', quote: 'Apply engineering methods to defined projects.' }
}

function makeVersion(grade = 9, version = 1, ladderId = 'ladder-one') {
  return {
    id: `grade-version-${grade}-${version}`, recordType: 'grade-version', workspaceId: 'workspace-one',
    ladderId, grade, version, generationId: 'generation-one', sourceSetId: 'source-set-one',
    createdAt: timestamp, updatedAt: timestamp, createdBy: 'reviewer-one', contentHash: 'a'.repeat(64), issues: [],
    rubric: {
      id: `grade-rubric-${ladderId}-${grade}`, groupId: `grade-group-${ladderId}-${grade}`, kind: 'grade', dataKind: 'real', ladder: 'Same display name',
      grade: `GS-${grade}`, name: `GS-${grade} engineering review`, description: 'A grounded draft, not an official decision.', createdAt: timestamp, version,
      provenance: { kind: 'generated', model: 'review-test', promptVersion: 'v1' },
      criteria: [{
        id: `criterion-${grade}`, competencyId: 'common-engineering', key: 'technical', label: 'Engineering methods',
        description: 'Apply engineering methods to defined projects.', weight: 100,
        guidance: '0: No cited work.\n1: Introductory observation.\n2: Assisted application.\n3: Independent application.\n4: Complex applications.\n5: Sustained broad application.',
        gradeBasis: [citation()], sourceCitations: [citation()], interpretation: 'The explicit GS-9 passage supports independent application in the defined scope.', support: 'direct',
      }],
    },
    qualifications: [],
  }
}

function makeDetail() {
  const version = makeVersion()
  const review = {
    id: 'grade-review-one', recordType: 'grade-review', workspaceId: 'workspace-one', ladderId: version.ladderId, grade: 9,
    versionId: version.id, versionHash: version.contentHash, sourceSetId: version.sourceSetId, outcome: 'supported', issues: [],
    createdAt: timestamp, updatedAt: timestamp, model: 'review-test', promptVersion: 'review-v1',
  }
  return {
    ladder: {
      id: version.ladderId, recordType: 'grade-ladder', workspaceId: 'workspace-one',
      name: 'Same display name', context: { series: '0801', agency: 'An agency', agencyType: 'other-federal', supervision: 'nonsupervisory', functions: [], specialty: '', confirmed: true, answers: {} },
      grades: [9], seedJobId: 'job-one', seedRubricId: 'job-rubric-one', seedRubricVersion: 2, seedJobTitle: 'Engineering specialist',
      seedBlobName: 'private-seed.json', sourceIds: ['seed-source', 'source-one'], sourceRevision: 1, sourceSetId: version.sourceSetId,
      generationId: version.generationId, status: 'review', issues: [], createdAt: timestamp, updatedAt: timestamp,
      createdBy: 'owner', inputFingerprint: 'b'.repeat(64),
    },
    etag: '"ladder-etag"',
    levels: [{
      head: { id: 'grade-head-one-9', recordType: 'grade-head', workspaceId: 'workspace-one', ladderId: version.ladderId, grade: 9, status: 'ready-for-review', latestVersionId: version.id, latestReviewId: review.id, generationId: version.generationId, sourceSetId: version.sourceSetId, issues: [], createdAt: timestamp, updatedAt: timestamp },
      etag: '"head-etag"', version, review, approval: null,
    }],
    sources: [],
    sourceSet: { id: version.sourceSetId, issues: [], sources: [], decisions: [], context: {}, grades: [9], revision: 1, createdAt: timestamp },
    workItems: [],
  }
}

function detailWithExclusion() {
  const detail = makeDetail()
  const excluded = {
    ...structuredClone(detail.levels[0].version.rubric.criteria[0]),
    id: 'excluded-research', competencyId: 'excluded-research', label: 'Research functions',
    support: 'not-applicable', weight: 0, gradeBasis: [],
    description: 'Research functions are excluded from this position.',
    guidance: 'Unscored exclusion: research functions do not apply to the captured position context.',
    interpretation: 'The captured work-level guide explicitly excludes research duties for this position.',
    sourceCitations: [{
      documentId: 'reference-exclusion', documentVersion: 3, paragraphId: 'research-exclusion', page: 27,
      heading: 'Research exclusions', quote: 'Research functions do not apply to this position.',
    }],
  }
  detail.levels[0].version.rubric.criteria.push(excluded)
  detail.levels[0].version.contentHash = 'c'.repeat(64)
  detail.levels[0].review.versionHash = detail.levels[0].version.contentHash
  detail.sourceSet.sources.push({
    sourceId: 'source-exclusion', documentId: 'reference-exclusion', documentVersion: 3, title: 'Work-level exclusions',
    origin: 'opm', purpose: 'grading', publisher: 'Office of Personnel Management', authorityStatus: 'current',
    documentBlobName: 'captured/document-v3.json', originalBlobName: 'captured/original.pdf', sha256: 'd'.repeat(64),
    pageCount: 204, selectedPages: [27], completeness: 'selected-pages',
    coverage: { series: ['0801'], grades: [9], functions: [], state: 'confirmed', explanation: 'Explicit work-level exclusion for the confirmed position context.' },
    issues: [],
  })
  detail.sourceSet.decisions.push({ sourceId: 'source-exclusion', selected: true, applicability: 'applicable', reason: 'Captured work-level exclusion applies to this position.' })
  return detail
}

before(async () => {
  await mkdir(outputDirectory)
  const entries = {
    client: join('src', 'services', 'gradeLadders.ts'),
    jobs: join('src', 'services', 'realJobs.ts'),
    ui: join('src', 'features', 'grade-ladders', 'gradeUi.ts'),
  }
  await Promise.all(Object.entries(entries).map(([name, entry]) => build({
    entryPoints: [entry], outfile: join(outputDirectory, `${name}.mjs`), bundle: true, packages: 'external',
    platform: 'node', format: 'esm', logLevel: 'silent',
  })))
  await build({
    stdin: { contents: `export { DocumentViewer } from './src/components/documents/DocumentViewer'; export { GradeMatrix } from './src/features/grade-ladders/GradeMatrix'; export { WorkspaceContext } from './src/app/workspace-context';`, resolveDir: process.cwd(), loader: 'tsx' },
    outfile: join(outputDirectory, 'components.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent',
  })
  ;[client, jobClient, ui, components] = await Promise.all(['client', 'jobs', 'ui', 'components'].map((name) => import(pathToFileURL(join(outputDirectory, `${name}.mjs`)).href)))
})

beforeEach(() => {
  requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ ladder: makeDetail() }) }
})

after(async () => { globalThis.fetch = originalFetch; await rm(outputDirectory, { recursive: true, force: true }) })

test('grade feature discovery stays separate from job Word-capability defaults', async () => {
  globalThis.fetch = async () => json({ realJobImports: true, limits: { maxPdfPages: 50 }, realGradeLadders: true, gradeLimits: { maxSources: 15 } })
  assert.deepEqual(await jobClient.fetchJobProcessingFeatures(), {
    realJobImports: true, markdownJobImports: false, wordDocumentImports: false, rubricAssistant: false,
    limits: {
      maxFileBytes: 10 * 1024 * 1024, maxPdfBytes: 10 * 1024 * 1024, maxMarkdownBytes: 10 * 1024 * 1024, maxPdfPages: 50,
      maxSourceCharacters: 180_000, maxBatchFiles: 10, maxUrlLength: 4096, maxCriteria: 20,
    },
  })
  const available = await client.fetchGradeProcessingFeatures()
  assert.equal(available.realGradeLadders, true)
  assert.equal(available.gradeLimits.maxSources, 15)
  assert.equal(available.gradeLimits.maxPdfPages, 250, 'Missing limits use the compiled ceiling, not undefined')
  globalThis.fetch = async () => json({ realJobImports: true })
  const disabled = await client.fetchGradeProcessingFeatures()
  assert.equal(disabled.realGradeLadders, false)
  assert.equal(disabled.gradeLimits.maxPdfPages, 250)
})

test('list and history consume all pages, encoding tokens and rejecting repeated pagination', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return requests.length === 1 ? json({ ladders: [makeDetail()], continuationToken: 'next / token' }) : json({ ladders: [] })
  }
  assert.equal((await client.listAllGradeLadders('workspace / one')).length, 1)
  assert.equal(requests[1].url, '/api/workspaces/workspace%20%2F%20one/grade-ladders?continuationToken=next%20%2F%20token')
  globalThis.fetch = async () => json({ versions: [makeVersion()], continuationToken: 'repeat' })
  await assert.rejects(client.listAllGradeVersions('w', 'l', 9), /repeated continuation token/)
})

test('GET detail is direct while create and every mutation unwrap the ladder envelope', async () => {
  const detail = makeDetail()
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json(init.method === 'GET' ? detail : { ladder: detail }, init.method === 'POST' ? 202 : 200) }
  assert.equal((await client.getGradeLadder('w', 'l')).ladder.id, detail.ladder.id)
  const input = { name: 'Family', jobId: 'job-one', rubricId: 'same-id-across-versions', rubricVersion: 2, context: detail.ladder.context, grades: [1, 9, 15] }
  assert.equal((await client.createGradeLadder('w', input, key)).levels[0].etag, '"head-etag"')
  assert.deepEqual(JSON.parse(requests[1].init.body), input)
  assert.equal(requests[1].init.headers.get('Idempotency-Key'), key)
  for (const { init } of requests) {
    assert.equal(init.credentials, 'include')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers.get('X-Score-Request'), 'workspace')
  }
})

test('all ladder operations use exact methods, endpoint paths, ETags and stable idempotency keys', async () => {
  await client.updateGradeLadder('w', 'l', { grades: [1, 15] }, '"ladder"')
  await client.discoverGradeSources('w', 'l', '"ladder"', key)
  await client.addGradeSourceUrl('w', 'l', { url: 'https://example.test/guide#section', selectedPages: [3, 4] }, key)
  await client.updateGradeSource('w', 'l', 'source / one', { selectedPages: [17, 18] }, '"ladder"')
  await client.confirmGradeSources('w', 'l', { decisions: [] }, '"ladder"', key)
  await client.generateGradeLadder('w', 'l', '"ladder"', key)
  await client.retryGradeWork('w', 'l', { grade: 9 }, '"ladder"')
  await client.cancelGradeWork('w', 'l', { workId: 'grade-work-one' }, '"ladder"')
  const tails = ['', '/discover', '/sources/url', '/sources/source%20%2F%20one', '/source-set', '/generate', '/retry', '/cancel']
  for (const [index, request] of requests.entries()) {
    assert.equal(request.url, `/api/workspaces/w/grade-ladders/l${tails[index]}`)
    assert.equal(request.init.method, index === 0 || index === 3 ? 'PATCH' : 'POST')
    assert.equal(request.init.headers.get('If-Match'), index === 2 ? null : '"ladder"')
    assert.equal(request.init.headers.get('Idempotency-Key'), [1, 2, 4, 5].includes(index) ? key : null)
  }
  assert.deepEqual(JSON.parse(requests[6].init.body), { grade: 9 })
  assert.deepEqual(JSON.parse(requests[7].init.body), { workId: 'grade-work-one' })
})

test('grade lifecycle scopes previews and mutations to the logical grade with its exact head ETag', async () => {
  const impact = { target: { kind: 'rubric', id: 'grade-head-one-9' }, name: 'GS-9 rubric', counts: { versions: 2 }, blockers: [] }
  const operation = { id: 'lifecycle-one', action: 'delete', status: 'failed', updatedAt: timestamp, error: 'Cleanup is incomplete.' }
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return init.method === 'POST' ? json({ pending: true, etag: '"pending-head"', operation }, 503) : json({ impact })
  }
  assert.deepEqual(await client.getGradeLifecycleImpact('workspace one', 'ladder/one', 9), impact)
  const result = await client.changeGradeLifecycle('workspace one', 'ladder/one', 'delete', '"head-exact"', 9)
  assert.equal(requests[0].url, '/api/workspaces/workspace%20one/grade-ladders/ladder%2Fone/lifecycle?grade=9')
  assert.equal(requests[1].init.headers.get('If-Match'), '"head-exact"')
  assert.deepEqual(JSON.parse(requests[1].init.body), { action: 'delete', grade: 9 })
  assert.deepEqual(result.operation, operation)
  assert.equal(result.etag, '"pending-head"')
  assert.equal(result.deleted, undefined)
})

test('an authoritative empty grade list evicts all history projections without changing the base projection', () => {
  const workspace = emptyProjection(), baseline = structuredClone(workspace)
  const result = ui.projectRealGrades(workspace, [makeVersion()], [])
  assert.equal(result.rubrics.some((rubric) => rubric.dataKind === 'real'), false)
  assert.deepEqual(workspace, baseline)
})

test('draft and approval use grade-head ETags, never accept client review/provenance state', async () => {
  const version = makeVersion()
  await client.saveGradeDraft('w', 'l', 9, { rubric: version.rubric, qualifications: [], review: 'invented' }, '"head"')
  await client.approveGrade('w', 'l', 9, { versionId: version.id, reviewId: 'review-one' }, '"head"')
  assert.equal(requests[0].url, '/api/workspaces/w/grade-ladders/l/grades/9/draft')
  assert.equal(requests[0].init.method, 'PUT')
  assert.equal(requests[0].init.headers.get('If-Match'), '"head"')
  const draftBody = JSON.parse(requests[0].init.body)
  assert.deepEqual(Object.keys(draftBody).sort(), ['qualifications', 'rubric'])
  assert.equal(draftBody.rubric.provenance, undefined)
  assert.equal(version.rubric.provenance.kind, 'generated', 'serialization does not alter the original captured version')
  assert.equal(requests[1].url, '/api/workspaces/w/grade-ladders/l/grades/9/approve')
  assert.equal(requests[1].init.headers.get('If-Match'), '"head"')
  assert.deepEqual(JSON.parse(requests[1].init.body), { versionId: version.id, reviewId: 'review-one' })
  await assert.rejects(async () => client.updateGradeLadder('w', 'l', { name: 'changed' }, ''), /Reload/)
  await assert.rejects(async () => client.createGradeLadder('w', {}, 'not-a-UUID'), /UUID/)
})

test('reference PDF uploads send actual bytes, encoded filename and selected original pages', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 201, 0, 12])
  const file = new File([bytes], 'engineering standard.pdf', { type: 'application/pdf' })
  await client.uploadGradeSourcePdf('w', 'l', file, key, [178, 179, 204])
  assert.equal(requests[0].url, '/api/workspaces/w/grade-ladders/l/sources/pdf')
  assert.equal(requests[0].init.headers.get('Content-Type'), 'application/pdf')
  assert.equal(requests[0].init.headers.get('X-File-Name'), 'engineering%20standard.pdf')
  assert.equal(requests[0].init.headers.get('X-Source-Pages'), '178,179,204')
  assert.equal(requests[0].init.headers.get('Idempotency-Key'), key)
  assert.equal(requests[0].init.headers.get('If-Match'), null)
  assert.deepEqual(new Uint8Array(requests[0].init.body), bytes)
})

test('historic document/original links include the frozen sourceSetId and direct GETs preserve reference kind', async () => {
  const reference = { id: 'reference-1', kind: 'reference', version: 4, sample: false, paragraphs: [], pageCount: 204, selectedPages: [178], completeness: 'selected-pages' }
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json(reference) }
  assert.deepEqual(await client.getGradeSourceDocument('w', 'l', 's', 'set / one'), reference)
  assert.equal(requests[0].url, '/api/workspaces/w/grade-ladders/l/sources/s/document?sourceSetId=set%20%2F%20one')
  assert.equal(client.gradeSourceOriginalUrl('w', 'l', 's', 'set / one'), '/api/workspaces/w/grade-ladders/l/sources/s/original?sourceSetId=set%20%2F%20one')
  assert.equal(client.gradeSourceOriginalUrl('w', 'l', 's'), '/api/workspaces/w/grade-ladders/l/sources/s/original')
  await client.getGradeSourceSet('w', 'l', 'set / one')
  assert.equal(requests[1].url, '/api/workspaces/w/grade-ladders/l/source-sets/set%20%2F%20one')
})

test('authentication and concurrency errors are explicit, with no silent fallback or automatic mutation retry', async () => {
  globalThis.fetch = async () => json({ error: { code: 'conflict', message: 'The grade head changed.' } }, 409)
  await assert.rejects(client.approveGrade('w', 'l', 9, { versionId: 'v', reviewId: 'r' }, '"old-head"'), { name: 'CloudConflictError', message: 'The grade head changed.' })
  globalThis.fetch = async () => new Response('<html>Sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
  await assert.rejects(client.getGradeLadder('w', 'l'), { name: 'CloudAuthError' })
  globalThis.fetch = async () => json({ error: { code: 'forbidden', message: 'Viewer access is read-only.' } }, 403)
  await assert.rejects(client.generateGradeLadder('w', 'l', '"e"', key), /Viewer access is read-only/)
})

test('page selection is bounded, absolute, deduplicated, and does not silently truncate', () => {
  assert.deepEqual(ui.parseSelectedPages('178-180, 204, 180'), [178, 179, 180, 204])
  assert.deepEqual(ui.parseSelectedPages(''), [])
  for (const invalid of ['0', '5-2', '1-251', '1-10000000000', '100001', '1,,2', 'pages 1-3']) assert.throws(() => ui.parseSelectedPages(invalid))
})

test('budgets exclude the automatic seed but include actual selected PDF pages', () => {
  const sources = [{ id: 'seed', origin: 'seed-job', pageCount: 50, selectedPages: [], originalContentType: 'application/pdf' },
    ...Array.from({ length: 15 }, (_, index) => ({ id: `source-${index}`, origin: 'upload', pageCount: 204, selectedPages: [178, 179], originalContentType: 'application/pdf' }))]
  const decisions = sources.map((source) => ({ sourceId: source.id, selected: true }))
  assert.deepEqual(ui.selectedSourceBudget(sources, decisions), { references: 15, pdfPages: 30, unknownPdfPages: false })
  const detail = makeDetail()
  detail.sources = sources
  assert.equal(ui.initialSourceDecisions(detail)[0].applicability, 'applicable', 'matches the API automatic seed contract')
})

test('private grades are display-only projections with stable family identity and latest-version selection', () => {
  const legacy = emptyProjection()
  const before = JSON.stringify(legacy)
  const current = makeVersion(9, 3, 'family-a')
  const older = makeVersion(9, 1, 'family-a')
  const sameNameOtherFamily = makeVersion(9, 1, 'family-b')
  const projection = ui.projectRealGrades(legacy, [current, older, sameNameOtherFamily])
  const real = projection.rubrics.filter((rubric) => rubric.dataKind === 'real')
  assert.equal(real.length, 2)
  assert.equal(real.find((rubric) => rubric.id === current.rubric.id).version, 3)
  assert.notEqual(real[0].groupId, real[1].groupId)
  assert.equal(projection.documents, legacy.documents)
  assert.equal(projection.jobs, legacy.jobs)
  assert.deepEqual(projection.lifecycle, legacy.lifecycle)
  assert.equal(JSON.stringify(legacy), before)
})

test('draft weight validation preserves zero and partial allocations without weighting evidence gaps or exclusions', () => {
  const row = (support, weight) => ({ support, weight })
  const valid = [
    [],
    [row('gap', 0)],
    [row('not-applicable', 0)],
    [row('direct', 40), row('gap', 0)],
    [row('derived', 100), row('gap', 0)],
    [row('direct', 40), row('derived', 60)],
    [row('direct', 100), row('not-applicable', 0)],
    [row('derived', 0.5), row('gap', 0), row('not-applicable', 0)],
  ]
  for (const criteria of valid) assert.deepEqual(ui.gradeDraftWeightState(criteria).errors, [], JSON.stringify(criteria))
  const invalid = [
    [row('gap', 1)], [row('not-applicable', 1)], [row('direct', 0)], [row('derived', 0), row('gap', 0)],
    [row('direct', -1)], [row('direct', 101)], [row('direct', NaN)], [row('gap', Infinity)],
    [row('direct', 60), row('derived', 41), row('gap', 0)],
    [row('direct', 99)], [row('direct', 60), row('not-applicable', 0)],
  ]
  for (const criteria of invalid) assert.ok(ui.gradeDraftWeightState(criteria).errors.length, JSON.stringify(criteria))
  assert.equal(ui.gradeDraftWeightState([row('gap', 0)]).total, 0)
  assert.equal(ui.gradeDraftWeightState([row('direct', 40), row('gap', 0)]).fullySupported, false)
  assert.equal(ui.gradeDraftWeightState([row('direct', 100), row('not-applicable', 0)]).fullySupported, true)
})

test('approval is scoped to an exact supported version, review, source set, weights and independent grade blockers', () => {
  const detail = makeDetail()
  assert.deepEqual(ui.gradeApprovalBlockers(detail, detail.levels[0]), [])
  const cases = [
    (value) => { value.levels[0].head.status = 'processing' },
    (value) => { value.levels[0].review.versionHash = 'wrong' },
    (value) => { value.ladder.sourceSetId = 'new-source-set' },
    (value) => { value.levels[0].version.rubric.criteria[0].support = 'gap' },
    (value) => { value.levels[0].version.rubric.criteria[0].support = 'not-applicable' },
    (value) => { value.levels[0].version.rubric.criteria[0].weight = 0 },
    (value) => { value.levels[0].version.rubric.criteria[0].sourceCitations = [] },
    (value) => { value.levels[0].version.qualifications.push({ id: 'q', support: 'gap', text: 'Qualification missing', citations: [], interpretation: '' }) },
  ]
  for (const change of cases) {
    const changed = structuredClone(detail)
    change(changed)
    assert.ok(ui.gradeApprovalBlockers(changed, changed.levels[0]).length)
  }
  detail.ladder.issues = [{ id: 'gs11-gap', severity: 'blocker', scope: 'grade', code: 'missing-evidence', grade: 11, message: 'GS-11 needs sources.' }]
  assert.deepEqual(ui.gradeApprovalBlockers(detail, detail.levels[0]), [], 'one incomplete grade does not block another supported grade')
})

test('source-cited not-applicable exclusions allow approval only with exact frozen bindings, unscored rows and a matching supported review', () => {
  const detail = detailWithExclusion()
  const excluded = (value) => value.levels[0].version.rubric.criteria[1]
  assert.deepEqual(ui.gradeApprovalBlockers(detail, detail.levels[0]), [])
  const cases = [
    ['nonzero exclusion weight', (value) => { excluded(value).weight = 1 }],
    ['invalid exclusion weight', (value) => { excluded(value).weight = NaN }],
    ['asserted grade basis', (value) => { excluded(value).gradeBasis = [excluded(value).sourceCitations[0]] }],
    ['missing exclusion citations', (value) => { excluded(value).sourceCitations = [] }],
    ['blank quote', (value) => { excluded(value).sourceCitations[0].quote = ' ' }],
    ['blank passage identity', (value) => { excluded(value).sourceCitations[0].paragraphId = '' }],
    ['uncaptured document', (value) => { excluded(value).sourceCitations[0].documentId = 'other-document' }],
    ['wrong captured version', (value) => { excluded(value).sourceCitations[0].documentVersion = 4 }],
    ['omitted original page', (value) => { excluded(value).sourceCitations[0].page = 28 }],
    ['invalid original page', (value) => { excluded(value).sourceCitations[0].page = 0 }],
    ['missing interpretation', (value) => { excluded(value).interpretation = '' }],
    ['missing guidance', (value) => { excluded(value).guidance = '' }],
    ['numeric score anchors', (value) => { excluded(value).guidance = '0: No research evidence.' }],
    ['inline score anchors', (value) => { excluded(value).guidance = 'Research is excluded; 1: Introductory research.' }],
    ['missing frozen set', (value) => { value.sourceSet = null }],
    ['different frozen set', (value) => { value.sourceSet.id = 'source-set-other' }],
    ['qualification instead of exclusion evidence', (value) => { value.sourceSet.sources[0].purpose = 'qualification' }],
    ['seed context instead of exclusion evidence', (value) => { value.sourceSet.sources[0].origin = 'seed-job' }],
    ['unresolved authority', (value) => { value.sourceSet.sources[0].authorityStatus = 'unknown' }],
    ['incomplete extraction', (value) => { value.sourceSet.sources[0].completeness = 'incomplete' }],
    ['unselected source', (value) => { value.sourceSet.decisions[0].selected = false }],
    ['unresolved applicability', (value) => { value.sourceSet.decisions[0].applicability = 'uncertain' }],
    ['missing semantic review', (value) => { value.levels[0].review = null }],
    ['unsupported semantic review', (value) => { value.levels[0].review.outcome = 'needs-sources' }],
    ['stale reviewed hash', (value) => { value.levels[0].review.versionHash = 'old-hash' }],
    ['stale reviewed version', (value) => { value.levels[0].review.versionId = 'old-version' }],
    ['stale review pointer', (value) => { value.levels[0].head.latestReviewId = 'old-review' }],
    ['stale draft pointer', (value) => { value.levels[0].head.latestVersionId = 'old-version' }],
    ['wrong reviewed source set', (value) => { value.levels[0].review.sourceSetId = 'old-source-set' }],
    ['wrong reviewed grade', (value) => { value.levels[0].review.grade = 11 }],
    ['wrong reviewed family', (value) => { value.levels[0].review.ladderId = 'other-ladder' }],
    ['wrong reviewed workspace', (value) => { value.levels[0].review.workspaceId = 'other-workspace' }],
    ['review still processing', (value) => { value.levels[0].head.status = 'processing' }],
    ['supported row missing grade basis', (value) => { value.levels[0].version.rubric.criteria[0].gradeBasis = [] }],
    ['supported row zero weight', (value) => { value.levels[0].version.rubric.criteria[0].weight = 0 }],
    ['underallocated supported weights', (value) => { value.levels[0].version.rubric.criteria[0].weight = 99 }],
    ['only exclusions', (value) => { value.levels[0].version.rubric.criteria.shift() }],
    ['gap instead of sourced exclusion', (value) => { excluded(value).support = 'gap' }],
    ['unresolved source blocker', (value) => { value.sourceSet.sources[0].issues.push({ id: 'conflict', code: 'source-conflict', scope: 'source', severity: 'blocker', message: 'Source versions conflict.' }) }],
    ['unresolved review blocker', (value) => { value.levels[0].review.issues.push({ id: 'unresolved', code: 'unresolved', scope: 'criterion', severity: 'blocker', message: 'Exclusion applicability is unresolved.' }) }],
  ]
  for (const [label, change] of cases) {
    const changed = structuredClone(detail)
    change(changed)
    assert.ok(ui.gradeApprovalBlockers(changed, changed.levels[0]).length, label)
  }
  detail.levels[0].version.issues.push({ id: 'exclusion-note', code: 'criterion-not-applicable', scope: 'criterion', severity: 'warning', message: 'Research is explicitly excluded.' })
  assert.deepEqual(ui.gradeApprovalBlockers(detail, detail.levels[0]), [], 'an evidenced exclusion warning is not a support gap')
})

function renderMatrix(props) {
  const value = {
    workspace: emptyProjection(),
    cloud: { mode: 'cloud', currentWorkspaceId: 'workspace-one', workspaces: [{ id: 'workspace-one', role: 'owner' }] },
    getLifecycleImpact() {}, changeLifecycle() {},
  }
  return renderToStaticMarkup(React.createElement(components.WorkspaceContext.Provider, { value }, React.createElement(components.GradeMatrix, props)))
}

test('matrix shows sourced exclusions as unscored before and after approval, not as zero scores or draft gaps', () => {
  const detail = detailWithExclusion()
  const render = () => renderMatrix({
    detail, selectedGrade: 9, onGrade() {}, canWrite: true, pending: false, unsavedSources: false,
    onSource() {}, onEdit() {}, onHistory() {}, async onApprove() {},
  })
  let html = render()
  const approvalButtons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g).filter((button) => button.includes('Approve supported version'))
  assert.ok(approvalButtons.length)
  assert.ok(approvalButtons.every((button) => !/\bdisabled=/.test(button)))
  assert.match(html, /Not applicable · exclusion/)
  assert.match(html, /<strong>Unscored<\/strong>/)
  assert.match(html, /Exclusion guidance \(unscored\)/)
  assert.match(html, /Exact source quotation/)
  assert.doesNotMatch(html, /<strong>0%<\/strong>|Evidence gap · draft/)
  detail.levels[0].head.status = 'approved'
  detail.levels[0].head.approvedVersionId = detail.levels[0].version.id
  html = render()
  assert.match(html, /Version approved/)
  assert.match(html, /<strong>Unscored<\/strong>/)
  assert.doesNotMatch(html, /<strong>0%<\/strong>|Evidence gap · draft/)
})

test('summary freshness includes independently updated grade heads, not only the ladder ETag', () => {
  const first = makeDetail()
  const next = structuredClone(first)
  next.levels[0].etag = '"new-review-head"'
  assert.notEqual(ui.gradeSummaryStamp(first), ui.gradeSummaryStamp(next))
  assert.equal(ui.gradeWorkActive(first), false)
  next.workItems.push({ status: 'queued' })
  assert.equal(ui.gradeWorkActive(next), true)
})

test('reference viewer labels partial original pages accurately without masquerading as a job', () => {
  const html = renderToStaticMarkup(React.createElement(components.DocumentViewer, {
    document: { id: 'ref', kind: 'reference', sample: false, version: 4, title: 'Engineering family standard', pageCount: 204, completeness: 'selected-pages', selectedPages: [178, 204],
      paragraphs: [{ id: 'p178', page: 178, heading: 'Professional work', text: 'Engineering evidence.' }, { id: 'p204', page: 204, heading: 'Table', text: 'Headers and alternatives.', table: { headers: ['Grade', 'Experience'], row: 1 } }] },
  }))
  assert.match(html, /Captured reference/)
  assert.match(html, /Original page 178 of 204/)
  assert.match(html, /omitted pages were not examined/)
  assert.match(html, /Table columns: Grade · Experience/)
  assert.doesNotMatch(html, /POSITION DESCRIPTION|Fictional document/)
})

test('matrix renders distinct competency IDs, separate unscored qualifications, and viewer-safe actions', () => {
  const detail = makeDetail()
  const higher = makeVersion(11)
  higher.rubric.criteria[0].competencyId = 'different-competency-same-label'
  higher.rubric.criteria[0].support = 'gap'
  detail.levels.push({ ...structuredClone(detail.levels[0]), head: { ...detail.levels[0].head, id: 'head-11', grade: 11, status: 'needs-sources' }, version: higher, review: null })
  const html = renderMatrix({
    detail, selectedGrade: 9, onGrade() {}, canWrite: false, pending: false, unsavedSources: false, onSource() {}, onEdit() {}, onHistory() {}, async onApprove() {},
  })
  assert.match(html, /common-engineering/)
  assert.match(html, /different-competency-same-label/)
  assert.match(html, /Minimum qualifications/)
  assert.match(html, /Unscored/)
  assert.match(html, /Evidence gap · draft/)
  assert.match(html, /Only an owner or editor can approve/)
  assert.match(html, /Interpretation \/ grade distinction/)
  assert.match(html, /Exact source quotation/)
})
