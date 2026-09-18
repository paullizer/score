import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { frontendWorkspaceContext } from './frontend.test-support.mjs'

const output = resolve(`.real-analysis-client-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
const timestamp = '2026-09-17T18:00:00.000Z'
const key = '6b997c8d-331e-4149-a7fc-b93259efed42'
const workspaceId = 'workspace-one'
const hash = 'a'.repeat(64)
const originals = new Map()
let client, ui, dom, root, createRoot, requests, current

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function blob(name = 'private/snapshot.json') { return { blobName: name, contentType: 'application/json', bytes: 123, sha256: hash } }
function resumeSelection(id = 'resume-one', version = 1) { return { resumeId: id, documentId: `document-${id}`, documentVersion: version, documentSha256: hash } }
function resumeSummary(id = 'resume-one', version = 1, status = 'ready') {
  return {
    resume: { id, dataKind: 'real', name: null, role: null, location: null, experience: null, documentId: `document-${id}`, documentVersion: version,
      sourceLabel: 'resume.pdf', status, batchId: key, createdAt: timestamp },
    workspaceId, source: { kind: 'pdf', fileName: 'resume.pdf', displayName: 'resume.pdf' }, etag: `"${id}"`, updatedAt: timestamp, attempts: 1, retryCount: 0, warnings: [], duplicates: [],
    capture: { original: { ...blob('private/original.pdf'), contentType: 'application/pdf' }, redirects: [], capturedAt: timestamp },
    documentRef: status === 'ready' ? { ...blob(), documentId: `document-${id}`, documentVersion: version } : null,
  }
}
function target(kind = 'job', version = 1) {
  const common = { id: `${kind}-target-${version}`, workspaceId, dataKind: 'real', label: kind === 'job' ? 'Saved engineering role' : 'Approved engineering GS-9',
    sublabel: 'Captured organization and scope', rubricId: `${kind}-rubric`, rubricVersion: version, criterionCount: 5 }
  return kind === 'job' ? { ...common, kind, selection: { kind, jobId: 'job-one', rubricId: 'job-rubric', rubricVersion: version, rubricHash: hash, documentId: 'job-document', documentVersion: 1, documentSha256: hash } }
    : { ...common, kind, selection: { kind, ladderId: 'ladder-one', grade: 9, versionId: `approved-version-${version}`, version, versionHash: hash, approvalId: `approval-${version}`, reviewId: `review-${version}`, sourceSetId: 'source-set-one', sourceSetHash: hash },
      context: { series: '0801', agency: 'Captured agency', agencyType: 'other-federal', supervision: 'nonsupervisory', specialty: 'Captured engineering scope', functions: [], answers: {}, confirmed: true },
      approvedAt: timestamp, newerDraftAvailable: true }
}
function jobTargets(count) {
  return Array.from({ length: count }, (_, index) => {
    const value = target('job')
    const jobId = `job-${index + 1}`, rubricId = `rubric-${jobId}`
    return { ...value, id: `target-${jobId}`, label: `Saved engineering role ${index + 1}`, rubricId,
      selection: { ...value.selection, jobId, rubricId, documentId: `document-${jobId}` } }
  })
}
function runSummary(id = 'run-one', status = 'complete', workspace = workspaceId) {
  return { etag: `"${id}-${status}"`, run: {
    id, recordType: 'analysis-run', workspaceId: workspace, dataKind: 'real', name: 'Saved evidence review', createdAt: timestamp, updatedAt: timestamp, createdBy: 'reviewer',
    idempotencyKey: key, inputFingerprint: hash, status, manifest: blob('private/manifest.json'), initialization: { nextComparisonIndex: 1, completedAt: timestamp },
    progress: { total: 1, initialized: 1, queued: status === 'queued' ? 1 : 0, running: status === 'running' ? 1 : 0, complete: status === 'complete' ? 1 : 0,
      failed: status === 'failed' ? 1 : 0, cancelled: status === 'cancelled' ? 1 : 0, scored: status === 'complete' ? 1 : 0, unscored: 0 },
    attempts: 1, retryCount: 0,
  } }
}
function runDetail(kind = 'job', version = 1) {
  return { ...runSummary(), resumes: [{ workspaceId, dataKind: 'real', selection: resumeSelection(), name: null, role: null, sourceLabel: 'resume.pdf', capturedAt: timestamp }], targets: [target(kind, version)] }
}
function referenceDocument() {
  return { id: 'saved-reference', kind: 'reference', version: 3, title: 'Captured requirement standard', sample: false, pageCount: 204, selectedPages: [178], completeness: 'selected-pages',
    paragraphs: [{ id: 'reference-p178', page: 178, heading: 'Engineering expectations', text: 'Apply engineering methods to documented projects.' }] }
}
function comparisonDetail(kind = 'grade') {
  const summary = target(kind)
  const resumeDocument = { id: 'document-resume-one', kind: 'resume', version: 1, title: 'Captured professional profile', sample: false,
    paragraphs: [{ id: 'resume-p1', page: 1, heading: 'Experience', text: 'Prepared accessible project documentation and tested engineering methods.' }] }
  const resumeCitation = { documentId: resumeDocument.id, documentVersion: 1, paragraphId: 'resume-p1', page: 1, heading: 'Experience', quote: 'Prepared accessible project documentation' }
  const requirementCitation = { documentId: 'saved-reference', documentVersion: 3, paragraphId: 'reference-p178', page: 178, heading: 'Engineering expectations', quote: 'Apply engineering methods to documented projects.' }
  const criteria = ['Supported work', 'Partial work', 'Missing work', 'Unassessed work', 'Excluded work'].map((label, index) => ({
    id: `criterion-${index}`, key: 'custom', competencyId: `competency-${index}`, label, description: `${label} in the saved rubric.`, weight: [40, 30, 30, 0, 0][index],
    guidance: '0: No documented evidence.\n3: Independent application.\n5: Broad sustained application.', requirementType: index === 1 ? 'preferred' : 'required',
    support: index === 4 ? 'not-applicable' : 'direct', gradeBasis: [requirementCitation], sourceCitations: [requirementCitation], interpretation: 'Captured work requirement.',
  }))
  const rubric = { id: summary.rubricId, groupId: `${kind}-group`, kind, dataKind: 'real', name: summary.label, description: 'Saved requirements.',
    version: 1, criteria, createdAt: timestamp, ...(kind === 'grade' ? { grade: 'GS-9', ladder: 'Captured engineering' } : { jobId: 'job-one' }) }
  const qualification = { id: 'qualification-one', text: 'Documented engineering qualifications', citations: [requirementCitation], interpretation: 'Separate human review is required.', support: 'direct' }
  const reference = { sourceId: 'reference-source', title: 'Captured requirement standard', origin: 'opm', purpose: 'grading', publisher: 'Test publisher',
    documentId: 'saved-reference', documentVersion: 3, documentBlobName: 'grade/document.json', originalBlobName: 'grade/original.pdf', sha256: hash, pageCount: 204, selectedPages: [178], completeness: 'selected-pages',
    authorityStatus: 'current', issues: [], coverage: { series: ['0801'], grades: [9], functions: [], state: 'confirmed', explanation: 'Captured scope.' } }
  const jobDocument = { id: 'job-document', kind: 'job', version: 1, title: 'Captured job', sample: false,
    paragraphs: [{ id: 'job-p1', page: 1, heading: 'Responsibilities', text: 'Document engineering projects.' }] }
  const job = { id: 'job-one', title: 'Saved engineering role', dataKind: 'real', status: 'ready', documentId: 'job-document', rubricId: 'job-rubric',
    organization: 'Captured organization', grade: '', series: '', location: '', arrangement: '', employmentType: '', source: 'url', sourceLabel: 'Captured job', createdAt: timestamp }
  const source = { kind: 'url', displayName: 'Captured job', url: 'https://example.test/job', originalContentType: 'text/html' }
  const targetSnapshot = {
    schemaVersion: 1, snapshotId: 'target-snapshot', workspaceId, dataKind: 'real', frozenAt: timestamp, kind, selection: summary.selection, summary,
    requirementEvidence: criteria.map((criterion) => ({ kind: 'criterion', criterionId: criterion.id, citations: [requirementCitation] })),
    ...(kind === 'grade' ? {
      version: { id: 'approved-version-1', recordType: 'grade-version', workspaceId, ladderId: 'ladder-one', grade: 9, version: 1, contentHash: hash,
        sourceSetId: 'source-set-one', generationId: 'generation-one', rubric, qualifications: [qualification], issues: [], createdAt: timestamp, updatedAt: timestamp, createdBy: 'reviewer' },
      approval: { id: 'approval-1', versionId: 'approved-version-1', versionHash: hash },
      review: { id: 'review-1', outcome: 'supported' },
      sourceSet: { id: 'source-set-one', context: summary.context, sources: [reference] },
      seed: { job, document: jobDocument, rubric: { ...rubric, kind: 'job', id: 'job-rubric', jobId: 'job-one' }, source, capturedAt: timestamp },
      references: [{ source: reference, document: { ...blob('analysis/copied-reference.json'), documentId: 'saved-reference', documentVersion: 3 } }],
    } : { job, rubric, document: jobDocument, source, original: { ...blob('private/job.html'), contentType: 'text/html' } }),
  }
  const model = { model: 'test-assessor', deployment: 'test-deployment', promptVersion: 'assessment-v1', schemaVersion: 'assessment-v1',
    startedAt: timestamp, completedAt: timestamp, inputCharacters: 500 }
  const resultSummary = { completion: 'limited', overall: { status: 'available', score: 36 },
    coverage: { totalCriteria: 5, supported: 1, partial: 1, missing: 1, notAssessed: 1, notApplicable: 1, assessedWeight: 100, totalWeight: 100 } }
  const comparison = { id: 'comparison-one', recordType: 'analysis-comparison', workspaceId, dataKind: 'real', runId: 'run-one', index: 0, status: 'complete',
    createdAt: timestamp, updatedAt: timestamp, attempts: 1, retryCount: 0,
    resume: { snapshotId: 'resume-snapshot', blob: blob(), summary: runDetail().resumes[0] },
    target: { snapshotId: 'target-snapshot', blob: blob(), summary }, resultSummary,
  }
  return { etag: '"comparison-one"', comparison,
    resumeSnapshot: { schemaVersion: 1, snapshotId: 'resume-snapshot', workspaceId, dataKind: 'real', frozenAt: timestamp, selection: resumeSelection(),
      resume: resumeSummary().resume, source: resumeSummary().source, capture: resumeSummary().capture, document: resumeDocument,
      profile: { schemaVersion: 1, dataKind: 'real', workspaceId, resumeId: 'resume-one' },
      extraction: { method: 'html', pagination: 'html-sections', version: 'html-v1', pageCount: null, normalizedCharacters: 90, document: resumeSummary().documentRef, extractedAt: timestamp } },
    targetSnapshot,
    result: { schemaVersion: 1, dataKind: 'real', workspaceId, runId: 'run-one', comparisonId: 'comparison-one', createdAt: timestamp, humanReviewRequired: true,
      ...resultSummary, summary: 'Review evidence in this captured source, not personal ability.', limitations: [{ code: 'sparse-source', message: 'This public profile contains limited context.' }],
      criteria: criteria.map((criterion, index) => ({
        criterionId: criterion.id, weight: criterion.weight, evidenceStatus: ['supported', 'partial', 'missing', 'not-assessed', 'not-applicable'][index],
        score: [3, 2, 0, null, null][index], rationale: `${criterion.label} assessment.`, citations: index < 2 ? [resumeCitation] : [], requirementCitations: [requirementCitation],
        ...(index === 3 ? { limitation: { code: 'not-assessable', message: 'This criterion could not be assessed from this source.', criterionId: criterion.id } } : {}),
      })),
      qualifications: [{ qualificationId: qualification.id, evidenceStatus: 'partial', rationale: 'Additional qualification review is required.', citations: [resumeCitation], requirementCitations: [requirementCitation] }],
      provenance: { attemptId: 'attempt-one', manifestSha256: hash, resumeSnapshot: { snapshotId: 'resume-snapshot', sha256: hash }, targetSnapshot: { snapshotId: 'target-snapshot', sha256: hash },
        assessmentSha256: hash, assessment: model, groundingReviews: [{ id: 'grounding-one', outcome: 'supported', issues: [], provenance: model }], correctionCount: 0, calculationVersion: 'weighted-0-100-v1' },
    },
  }
}

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, localStorage: dom.window.localStorage, CSS: { escape: (value) => value }, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await Promise.all([
    build({ entryPoints: [join('src', 'services', 'realAnalyses.ts')], outfile: join(output, 'client.mjs'), bundle: true, packages: 'external',
      format: 'esm', platform: 'node', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } }),
    build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export * from './src/features/analyses/realAnalysisUi';
      export * from './src/app/real-data-mode';
      export { RealAnalysesBridge } from './src/app/RealAnalysesBridge';
      export { RealAnalysesContext, useRealAnalyses } from './src/app/real-analyses-context';
      export { RealResumesContext } from './src/app/real-resumes-context';
      export { WorkspaceContext } from './src/app/workspace-context';
      export { RealAnalysisSetup } from './src/features/analyses/RealAnalysisSetup';
      export { RealResumesPage } from './src/features/resumes/RealResumesPage';
      export { RealComparisonReview } from './src/features/analyses/RealComparisonReview';
      export { RealComparisonValue, RealAnalysisDetail } from './src/features/analyses/RealAnalysisDetail';
      export { BrowserRouter, MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
      export { createInitialWorkspace } from './src/data/fixtures';
      export { snapshotAnalysisRun, evaluateComparison } from './src/services/scoring';
    ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
      jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } }),
  ])
  ;[client, ui] = await Promise.all(['client', 'ui'].map((name) => import(pathToFileURL(join(output, `${name}.mjs`)).href)))
})
beforeEach(() => { requests = []; current = null; dom.window.history.replaceState(null, '', '/') })
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null } })
after(async () => {
  globalThis.fetch = originalFetch
  dom.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

test('feature flags fail closed and every target/run/comparison page is consumed without repeated tokens', async () => {
  globalThis.fetch = async () => json({ realJobImports: true })
  assert.equal((await client.fetchAnalysisProcessingFeatures()).realAnalyses, false)
  for (const [method, field, first, second, endpoint, args] of [
    ['listAllRealAnalyses', 'runs', runSummary('first'), runSummary('second'), '/analyses', [workspaceId]],
    ['listAllRealAnalysisTargets', 'targets', target('job'), target('grade'), '/analyses/targets', [workspaceId]],
    ['listAllRealAnalysisComparisons', 'comparisons', comparisonDetail(), { ...comparisonDetail(), comparison: { ...comparisonDetail().comparison, id: 'second' } }, '/analyses/run-one/comparisons', [workspaceId, 'run-one']],
  ]) {
    requests = []
    globalThis.fetch = async (url, init) => { requests.push({ url, init }); return requests.length === 1 ? json({ [field]: [first], continuationToken: 'next / page' }) : json({ [field]: [second] }) }
    assert.equal((await client[method](...args)).length, 2)
    assert.equal(requests[1].url, `/api/workspaces/${workspaceId}${endpoint}?continuationToken=next%20%2F%20page`)
    globalThis.fetch = async () => json({ [field]: [], continuationToken: 'repeat' })
    await assert.rejects(client[method](...args), /repeated continuation token/)
  }
})

test('run creation sends typed exact selections only, preserves UUIDs, allows 500 and rejects 501 without truncation', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ run: runSummary() }, 202) }
  const input = { name: 'Manual review', resumes: Array.from({ length: 500 }, (_, index) => resumeSelection(`resume-${index}`)), targets: [target('job').selection] }
  await client.createRealAnalysis(workspaceId, input, key)
  assert.deepEqual(JSON.parse(requests[0].init.body), input)
  assert.equal(requests[0].init.headers.get('Idempotency-Key'), key)
  assert.equal(requests[0].init.headers.get('X-Score-Request'), 'workspace')
  assert.equal(requests[0].init.credentials, 'include')
  assert.equal(requests[0].init.cache, 'no-store')
  await assert.rejects(client.createRealAnalysis(workspaceId, { ...input, resumes: [...input.resumes, resumeSelection('resume-501')] }, key), /at most 500/)
  assert.equal(requests.length, 1)
  await assert.rejects(client.createRealAnalysis(workspaceId, { ...input, resumes: [resumeSelection(), resumeSelection()] }, key), /only once/)
  await assert.rejects(client.createRealAnalysis(workspaceId, { ...input, resumes: [{ resumeId: 'sample', sample: true }] }, key), /exact ready resume/)
  await client.createRealAnalysis(workspaceId, { name: 'No authoritative content', resumes: [{ ...resumeSelection(), document: 'Do not send source text' }],
    targets: [{ ...target('grade').selection, approved: true, score: 100 }], overallScore: 100 }, key)
  assert.deepEqual(Object.keys(JSON.parse(requests.at(-1).init.body)).sort(), ['name', 'resumes', 'targets'])
  assert.equal(JSON.parse(requests.at(-1).init.body).resumes[0].document, undefined)
  assert.equal(JSON.parse(requests.at(-1).init.body).targets[0].approved, undefined)
})

test('103 resumes against four jobs are submitted as one complete 412-comparison request', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ run: runSummary() }, 202) }
  const input = {
    name: 'Full resume library review',
    resumes: Array.from({ length: 103 }, (_, index) => resumeSelection(`resume-${index}`)),
    targets: jobTargets(4).map(item => item.selection),
  }
  await client.createRealAnalysis(workspaceId, input, key)
  assert.equal(requests.length, 1)
  assert.deepEqual(JSON.parse(requests[0].init.body), input)
  assert.equal(input.resumes.length * input.targets.length, 412)
})

test('unwrapped details retain independent snapshots and authorized documents require exact saved versions', async () => {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json(url.includes('/documents/') ? { document: referenceDocument() } : url.includes('/comparisons/') ? comparisonDetail() : runDetail('grade'))
  }
  assert.equal((await client.getRealAnalysis(workspaceId, 'run-one')).targets[0].selection.versionId, 'approved-version-1')
  assert.equal((await client.getRealAnalysisComparison(workspaceId, 'run-one', 'comparison-one')).result.overall.score, 36)
  assert.equal((await client.getRealAnalysisDocument(workspaceId, 'run-one', 'comparison-one', 'saved-reference', 3)).kind, 'reference')
  assert.equal(requests[2].url, `/api/workspaces/${workspaceId}/analyses/run-one/comparisons/comparison-one/documents/saved-reference?version=3`)
  await assert.rejects(client.getRealAnalysisDocument(workspaceId, 'run-one', 'comparison-one', 'saved-reference', 4), /exact saved document/)
  await assert.rejects(client.getRealAnalysisDocument(workspaceId, 'run-one', 'comparison-one', 'saved-reference', 0), /exact saved document version/)
  await assert.rejects(client.getRealAnalysisDocument(workspaceId, 'run-one', '', 'saved-reference', 3), /exact saved comparison/)
  globalThis.fetch = async () => json({ ...runDetail(), resumes: [{ ...runDetail().resumes[0], dataKind: 'sample' }] })
  await assert.rejects(client.getRealAnalysis(workspaceId, 'run-one'), /mixed or foreign/)
})

test('100 exact resume selections use a bounded complete URL and a workspace-bound metadata transfer', () => {
  const summaries = Array.from({ length: 100 }, (_, index) => resumeSummary(`resume-${index}`))
  const selected = summaries.map(ui.realResumeSelection)
  const chosenTarget = target('job', 2)
  const navigation = ui.realAnalysisLink({ resumes: selected, targets: [chosenTarget.selection] }, workspaceId)
  const url = new URL(navigation.to, 'https://score.test')
  assert.ok(navigation.to.length <= ui.REAL_ANALYSIS_LINK_MAX_LENGTH, 'The whole URL, not only the query, stays bounded.')
  assert.equal(url.hash, '')
  assert.equal(url.searchParams.get('selectionTransfer'), navigation.state.id)
  assert.equal(navigation.state.workspaceId, workspaceId)
  const restored = ui.resolveRealAnalysisNavigation(url.searchParams, structuredClone(navigation.state), workspaceId)
  assert.equal(restored.error, null)
  const parsed = ui.initialRealSelections(restored.params, summaries, [chosenTarget])
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.resumes.map((item) => item.selection), selected)
  assert.deepEqual(parsed.targets.map((item) => item.selection), [chosenTarget.selection])
  assert.equal(dom.window.localStorage.length, 0)
})

test('small exact-source deep links remain self-contained; large transfers exclude all source content', () => {
  const small = ui.realAnalysisLink({ resumes: [resumeSelection()], targets: [target().selection] }, workspaceId)
  assert.equal(small.state, undefined)
  const url = new URL(small.to, 'https://score.test')
  assert.deepEqual(JSON.parse(url.searchParams.get('resumeSelections')), [resumeSelection()])
  assert.equal(url.searchParams.has('selectionTransfer'), false)
  const selected = Array.from({ length: 100 }, (_, index) => ({ ...resumeSelection(`resume-${index}`),
    name: 'Unstated personal metadata must not travel', document: { text: 'Source content must not travel' } }))
  const large = ui.realAnalysisLink({ resumes: selected, targets: [{ ...target().selection, rubric: { content: 'Rubric content must not travel' } }] }, workspaceId)
  assert.equal(large.state.input.resumes.length, 100)
  assert.equal(large.state.input.resumes[0].name, undefined)
  assert.equal(large.state.input.resumes[0].document, undefined)
  assert.equal(large.state.input.targets[0].rubric, undefined)
  assert.doesNotMatch(JSON.stringify(large), /content must not travel|metadata must not travel/)
})

test('missing, mismatched, malformed, and mixed router transfers fail explicitly without guessing current inputs', () => {
  const selected = Array.from({ length: 100 }, (_, index) => resumeSelection(`resume-${index}`))
  const navigation = ui.realAnalysisLink({ resumes: selected }, workspaceId)
  const params = new URL(navigation.to, 'https://score.test').searchParams
  for (const state of [null, undefined, {}, { ...navigation.state, workspaceId: 'other-workspace' },
    { ...navigation.state, id: randomUUID() }, { ...navigation.state, input: {} },
    { ...navigation.state, input: { resumes: [{ resumeId: 'incomplete' }] } }]) {
    assert.match(ui.resolveRealAnalysisNavigation(params, state, workspaceId).error, /unavailable in this tab or workspace/)
  }
  const mixed = new URLSearchParams(params)
  mixed.set('resumes', 'another-resume')
  assert.match(ui.resolveRealAnalysisNavigation(mixed, navigation.state, workspaceId).error, /mixes transferred selections/)
  assert.match(ui.initialRealSelections(params, [], []).errors[0], /transfer has not been restored/)
})

test('missing, malformed, duplicate, and mixed fragment selections fail explicitly instead of being dropped', () => {
  const summaries = Array.from({ length: 100 }, (_, index) => resumeSummary(`resume-${index}`))
  const selected = summaries.map(ui.realResumeSelection)
  const url = new URL(`/analyses/new?data=real&selectionTransport=fragment#${new URLSearchParams({ resumeSelections: JSON.stringify(selected) })}`, 'https://score.test')
  assert.deepEqual(ui.initialRealSelections(url.searchParams, summaries, [], undefined, url.hash).resumes.map((item) => item.selection), selected,
    'previously issued complete fragment links still resolve without losing exact selections')
  for (const fragment of ['', '#resumeSelections=not-json', '#unknown=value', '#resumeSelections=[]&resumeSelections=[]', `#${'x'.repeat(256_001)}`]) {
    const result = ui.initialRealSelections(url.searchParams, summaries, [], undefined, fragment)
    assert.ok(result.errors.length > 0)
    assert.equal(result.resumes.length, 0)
  }
  const mixed = new URLSearchParams(url.searchParams)
  mixed.set('resumeSelections', JSON.stringify([selected[0]]))
  const result = ui.initialRealSelections(mixed, summaries, [], undefined, url.hash)
  assert.match(result.errors.join(' '), /ambiguous/)
  assert.equal(result.resumes.length, 0)
})

test('retry/cancel use caller ETags, correct envelopes, saved pairs, and no automatic version rebinding', async () => {
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json(url.includes('/comparisons/') ? { comparison: comparisonDetail() } : { run: runSummary() }) }
  await client.retryRealAnalysis(workspaceId, 'run-one', { comparisonIds: ['comparison-one'] }, '"run-etag"')
  await client.cancelRealAnalysis(workspaceId, 'run-one', '"run-etag"')
  await client.retryRealAnalysisComparison(workspaceId, 'run-one', 'comparison-one', '"pair-etag"')
  await client.cancelRealAnalysisComparison(workspaceId, 'run-one', 'comparison-one', '"pair-etag"')
  assert.deepEqual(JSON.parse(requests[0].init.body), { comparisonIds: ['comparison-one'] })
  assert.deepEqual(requests.map((item) => item.init.headers.get('If-Match')), ['"run-etag"', '"run-etag"', '"pair-etag"', '"pair-etag"'])
  assert.equal(requests[1].init.body, undefined)
  assert.equal(requests[2].init.body, undefined)
  assert.equal(requests[3].init.body, undefined)
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ error: { code: 'conflict', message: 'The selected version changed.' } }, 409) }
  await assert.rejects(client.retryRealAnalysis(workspaceId, 'run-one', {}, '"old-etag"'), { name: 'CloudConflictError' })
  assert.equal(requests.length, 5)
  assert.equal(requests.at(-1).init.headers.get('If-Match'), '"old-etag"')
  globalThis.fetch = async () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } })
  await assert.rejects(client.getRealAnalysis(workspaceId, 'run-one'), { name: 'CloudAuthError' })
})

test('exact selections use documentRef IDs/hashes; unknown, sample, and pending inputs are preserved as errors', () => {
  const ready = resumeSummary()
  assert.deepEqual(ui.realResumeSelection(ready), resumeSelection())
  const selection = ui.initialRealSelections(new URLSearchParams({ resumes: 'resume-one,sample-person,pending', rubrics: 'job-rubric,sample-rubric' }),
    [ready, resumeSummary('pending', 1, 'profiling')], [target('job')])
  assert.equal(selection.resumes.length, 3)
  assert.equal(selection.targets.length, 2)
  assert.equal(selection.resumes[1].selection, null)
  assert.match(ui.resumeSelectionIssue(selection.resumes[1], [ready]), /Sample, missing/)
  assert.match(ui.resumeSelectionIssue(selection.resumes[2], [ready]), /unfinished/)
  assert.match(ui.targetSelectionIssue(selection.targets[1], [target('job')]), /sample/)
  const invalid = ui.initialRealSelections(new URLSearchParams({ targetSelections: '[{"kind":"grade","version":2}]' }), [ready], [target('grade')])
  assert.match(invalid.errors[0], /Nothing will be silently skipped/)
})

test('approved GS versions and new-run snapshots never silently use newer drafts or changed current versions', () => {
  const approved = target('grade', 1)
  const choices = ui.initialRealSelections(new URLSearchParams({ rubrics: 'grade-rubric' }), [], [approved])
  assert.equal(choices.targets[0].selection.versionId, 'approved-version-1')
  assert.equal(choices.targets[0].summary.newerDraftAvailable, true)
  const unapproved = ui.initialRealSelections(new URLSearchParams({ ladder: 'ladder-one', grade: '9', version: '2' }), [], [approved])
  assert.equal(unapproved.targets[0].selection, null)
  const replay = ui.initialRealSelections(new URLSearchParams({ from: 'run-one' }), [resumeSummary('resume-one', 2)], [target('grade', 2)], runDetail('grade'))
  assert.equal(replay.resumes[0].selection.documentVersion, 1)
  assert.equal(replay.targets[0].selection.version, 1)
  assert.match(ui.resumeSelectionIssue(replay.resumes[0], [resumeSummary('resume-one', 2)]), /identity or hash changed/)
  assert.match(ui.targetSelectionIssue(replay.targets[0], [target('grade', 2)]), /source set changed/)
  const link = new URL(ui.realAnalysisLink({ resumes: [resumeSelection()], targets: [approved.selection] }).to, 'https://score.test')
  assert.equal(link.searchParams.get('data'), 'real')
  assert.deepEqual(JSON.parse(link.searchParams.get('targetSelections')), [approved.selection])
})

test('historical job versions remain independently eligible and never collapse into one target', async () => {
  const older = target('job', 1)
  const newer = target('job', 2)
  assert.notEqual(ui.targetIdentity(older.selection), ui.targetIdentity(newer.selection))
  assert.equal(ui.targetFamilyIdentity(older.selection), ui.targetFamilyIdentity(newer.selection))
  const replay = ui.initialRealSelections(new URLSearchParams({ from: 'run-one' }), [resumeSummary()], [newer, older], runDetail('job', 1))
  assert.equal(replay.targets[0].selection.rubricVersion, 1)
  assert.equal(ui.targetSelectionIssue(replay.targets[0], [newer, older]), null)
  assert.equal(ui.newerSavedJobTarget(replay.targets[0].selection, [newer, older]).rubricVersion, 2)
  const ambiguous = ui.initialRealSelections(new URLSearchParams({ rubrics: 'job-rubric' }), [], [newer, older])
  assert.equal(ambiguous.targets[0].selection, null, 'an ambiguous direct ID does not silently choose the latest or first page')
  const exact = ui.initialRealSelections(new URLSearchParams({ rubrics: 'job-rubric', rubricVersion: '1' }), [], [newer, older])
  assert.equal(exact.targets[0].selection.rubricVersion, 1)
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return json({ run: runSummary() }, 202) }
  await client.createRealAnalysis(workspaceId, { name: 'Separate saved versions', resumes: [resumeSelection()], targets: [older.selection, newer.selection] }, key)
  assert.deepEqual(JSON.parse(requests[0].init.body).targets.map((item) => item.rubricVersion), [1, 2])
  await assert.rejects(client.createRealAnalysis(workspaceId, { name: 'Duplicate same version', resumes: [resumeSelection()], targets: [older.selection, older.selection] }, key), /only once/)
})

test('direct IDs retain explicit modes, mixed sample links do not reach the fixture scorer, and sample behavior is unchanged', () => {
  const sample = ui.createInitialWorkspace()
  const before = JSON.stringify(sample)
  const resume = sample.resumes[0].id
  const rubric = sample.rubrics.find((item) => item.kind === 'grade').id
  assert.equal(ui.analysisDataMode(new URLSearchParams(), true, sample, sample.runs[0].id), 'samples')
  assert.equal(ui.analysisDataMode(new URLSearchParams({ data: 'real' }), true, sample, sample.runs[0].id), 'real')
  assert.equal(ui.analysisDataMode(new URLSearchParams({ resumes: resume, rubrics: rubric }), true, sample), 'samples')
  assert.equal(ui.analysisDataMode(new URLSearchParams({ resumes: `${resume},real-resume`, rubrics: rubric }), true, sample), 'real')
  assert.equal(ui.analysisDataMode(new URLSearchParams({ data: 'unknown' }), true, sample), 'invalid')
  const identity = { id: 'sample-run-test', createdAt: timestamp, comparisonId: (index) => `sample-pair-${index}` }
  assert.throws(() => ui.snapshotAnalysisRun(sample, [resume, 'real-resume'], [rubric], 'Mixed', identity), /missing/)
  const run = ui.snapshotAnalysisRun(sample, [resume], [rubric], 'Samples unchanged', identity)
  assert.equal(ui.evaluateComparison(run, run.comparisons[0].id).status, 'complete')
  assert.equal(JSON.stringify(sample), before)
})

test('results display server totals, limited completion, exact statuses and unscored GS qualifications separately', () => {
  const detail = comparisonDetail()
  let html = renderToStaticMarkup(React.createElement(ui.RealComparisonReview, { detail }))
  assert.match(html, /SERVER-CALCULATED EVIDENCE MATCH/)
  assert.match(html, />36<\/strong>/)
  assert.match(html, /Complete · limited assessment/)
  assert.match(html, /Supported/)
  assert.match(html, /Partial support/)
  assert.match(html, /Missing evidence/)
  assert.match(html, /Not assessed/)
  assert.match(html, /Not applicable · unscored/)
  assert.match(html, /Required/)
  assert.match(html, /GS qualifications/)
  assert.match(html, /Separate · unscored · human review/)
  assert.match(html, /Captured HTML section/)
  assert.doesNotMatch(html, /Original page 1/)
  detail.result.overall = { status: 'withheld', score: null, reason: 'unassessed-weighted-criteria', message: 'A weighted criterion could not be assessed.' }
  html = renderToStaticMarkup(React.createElement(ui.RealComparisonReview, { detail }))
  assert.match(html, /Score withheld/)
  assert.match(html, /A weighted criterion could not be assessed/)
  assert.doesNotMatch(html, />36<\/strong>/)
  const summary = { ...detail, comparison: { ...detail.comparison, resultSummary: { ...detail.comparison.resultSummary, overall: { status: 'available', score: 73 } } } }
  assert.match(renderToStaticMarkup(React.createElement(ui.RealComparisonValue, { summary })), />73<\/strong>/)
})

async function render(element) {
  root ??= createRoot(dom.window.document.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(ui.WorkspaceContext.Provider, {
      value: frontendWorkspaceContext({ cloud: { currentWorkspaceId: workspaceId } }, { resumes: [resumeSummary()], analyses: [runSummary()] }),
    }, element))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
async function settle(predicate) {
  for (let index = 0; index < 30 && !predicate(); index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.equal(Boolean(predicate()), true, 'Expected asynchronous analysis UI state was reached')
}
function router(element, location = '/analyses/new?data=real') {
  const url = typeof location === 'string' ? null : new URL(location.to, 'https://score.test')
  const entry = url ? { pathname: url.pathname, search: url.search, hash: url.hash, state: location.state } : location
  return React.createElement(ui.MemoryRouter, { initialEntries: [entry], future: { v7_startTransition: true, v7_relativeSplatPath: true } }, element)
}
const baseApi = { workspaceId, canWrite: true, phase: 'ready', features: { realAnalyses: true, analysisLimits: { maxComparisons: 500 } },
  error: null, summaries: [], pending: () => false, detail: () => ({ state: 'idle' }), ensureDetail: async () => {}, refresh: async () => {}, refreshTargets: async () => {}, requestKey: () => key }
const baseResumes = { workspaceId, canWrite: true, phase: 'ready', error: null, features: { realResumeImports: true }, refresh: async () => {} }
function builder(api, resumes, location) {
  return router(React.createElement(ui.RealAnalysesContext.Provider, { value: api },
    React.createElement(ui.RealResumesContext.Provider, { value: { ...baseResumes, summaries: resumes } }, React.createElement(ui.RealAnalysisSetup))), location)
}

test('103-resume library navigation preserves every exact selection and requires manual review before 412 comparisons', async () => {
  dom.window.localStorage.clear()
  const summaries = Array.from({ length: 103 }, (_, index) => resumeSummary(`resume-${index}`))
  const exact = summaries.map(ui.realResumeSelection)
  const chosenTargets = jobTargets(4)
  const calls = []
  const api = { ...baseApi, targets: { state: 'ready', value: chosenTargets },
    create: async (input) => { calls.push(input); throw new Error('Controlled acceptance-response failure.') } }
  const resumes = { ...baseResumes, summaries, batches: [], currentBatchId: null, pending: () => false }
  let navigation
  function NavigationProbe() { navigation = ui.useLocation(); return null }
  dom.window.history.replaceState(null, '', `/workspaces/${workspaceId}/resumes?data=real`)
  const content = React.createElement(ui.RealAnalysesContext.Provider, { value: api },
    React.createElement(ui.RealResumesContext.Provider, { value: resumes }, React.createElement(React.Fragment, null,
      React.createElement(NavigationProbe),
      React.createElement(ui.Routes, null,
        React.createElement(ui.Route, { path: '/resumes', element: React.createElement(ui.RealResumesPage) }),
        React.createElement(ui.Route, { path: '/analyses/new', element: React.createElement(ui.RealAnalysisSetup) })),
    )))
  const application = () => React.createElement(ui.BrowserRouter, {
    basename: `/workspaces/${workspaceId}`, future: { v7_startTransition: true, v7_relativeSplatPath: true },
  }, content)
  await render(application())
  await act(async () => [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Select ready visible').click())
  const build = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Build analysis (103)')
  assert.equal(build.disabled, false)
  await act(async () => build.click())
  const href = navigation.pathname + navigation.search + navigation.hash
  assert.ok(href.length <= ui.REAL_ANALYSIS_LINK_MAX_LENGTH)
  assert.equal(navigation.hash, '')
  assert.deepEqual(navigation.state.input.resumes, exact)
  assert.deepEqual(dom.window.history.state.usr.input.resumes, exact)
  assert.ok(dom.window.location.href.length < 2048)
  assert.equal(dom.window.document.querySelectorAll('input[type="checkbox"]:checked').length, 103)
  assert.equal(calls.length, 0)
  await act(async () => root.unmount()); root = null
  await render(application())
  assert.equal(dom.window.document.querySelectorAll('input[type="checkbox"]:checked').length, 103, 'a reload-style remount restores the same browser history entry')
  assert.deepEqual(navigation.state.input.resumes, exact)
  const chooseTargets = dom.window.document.querySelectorAll('input[aria-label^="Include Saved engineering role"]')
  assert.equal(chooseTargets.length, 4)
  await act(async () => { for (const checkbox of chooseTargets) checkbox.click() })
  const run = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Run analysis')
  assert.equal(run.disabled, false)
  assert.equal(dom.window.document.querySelector('.comparison-count strong').textContent, '412')
  assert.equal(calls.length, 0, 'navigating and selecting do not automatically start scoring')
  await act(async () => run.click())
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].resumes, exact)
  assert.deepEqual(calls[0].targets, chosenTargets.map(item => item.selection))
  assert.equal(calls[0].resumes.length * calls[0].targets.length, 412)
  assert.equal(dom.window.localStorage.length, 0)

  await act(async () => root.unmount()); root = null
  await render(builder(api, summaries, href))
  assert.match(dom.window.document.body.textContent, /Exact selections unavailable in this link/)
  assert.match(dom.window.document.body.textContent, /A copied large-selection URL alone cannot restore them/)
  assert.equal([...dom.window.document.querySelectorAll('button')].some((button) => button.textContent === 'Run analysis'), false)
  assert.equal(calls.length, 1, 'an unavailable transferred link cannot substitute or submit inputs')
})

test('builder requires a manual click, keeps exact versions while targets refresh, and marks newer drafts', async () => {
  const calls = []
  let eligible = target('grade', 1)
  const api = { ...baseApi, targets: { state: 'ready', value: [eligible] }, create: async (input, requestKey) => { calls.push({ input, requestKey }); throw new Error('Response lost; acceptance unknown.') } }
  const location = ui.realAnalysisLink({ resumes: [resumeSelection()], targets: [eligible.selection] })
  await render(builder(api, [resumeSummary()], location))
  assert.equal(calls.length, 0)
  assert.match(dom.window.document.body.textContent, /Newer draft exists · not selected/)
  eligible = target('grade', 2)
  api.targets = { state: 'ready', value: [eligible] }
  await render(builder(api, [resumeSummary()], location))
  let button = [...dom.window.document.querySelectorAll('button')].find((item) => item.textContent === 'Run analysis')
  assert.equal(button.disabled, true)
  assert.match(dom.window.document.body.textContent, /Selected: GS-9 · approved v1/)
  const accept = [...dom.window.document.querySelectorAll('button')].find((item) => item.textContent === 'Use current eligible version')
  await act(async () => accept.click())
  button = [...dom.window.document.querySelectorAll('button')].find((item) => item.textContent === 'Run analysis')
  assert.equal(button.disabled, false)
  await act(async () => button.click())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input.targets[0].version, 2)
  assert.equal(calls[0].input.resumes[0].documentSha256, hash)
  const retry = [...dom.window.document.querySelectorAll('button')].find((item) => item.textContent === 'Retry unchanged submission')
  await act(async () => retry.click())
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], calls[0])
})

test('builder allows exactly 500 comparisons and submits every pair only after a manual click', async () => {
  const resumes = Array.from({ length: 125 }, (_, index) => resumeSummary(`resume-${index}`))
  const targets = jobTargets(4)
  const calls = []
  const api = { ...baseApi, targets: { state: 'ready', value: targets },
    create: async (input) => { calls.push(input); throw new Error('Controlled acceptance-response failure.') } }
  const selected = { resumes: resumes.map(ui.realResumeSelection), targets: targets.map(item => item.selection) }
  await render(builder(api, resumes, ui.realAnalysisLink(selected, workspaceId)))
  assert.equal(dom.window.document.querySelector('.comparison-count strong').textContent, '500')
  assert.match(dom.window.document.body.textContent, /Maximum 500\. No truncation\./)
  const run = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === 'Run analysis')
  assert.equal(run.disabled, false)
  assert.equal(calls.length, 0)
  await act(async () => run.click())
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].resumes, selected.resumes)
  assert.deepEqual(calls[0].targets, selected.targets)
})

test('builder visibly rejects 501 comparisons without dropping inputs; viewer and pending sources cannot run', async () => {
  const resumes = Array.from({ length: 501 }, (_, index) => resumeSummary(`resume-${index}`))
  const eligible = target()
  const api = { ...baseApi, targets: { state: 'ready', value: [eligible] }, create: () => { throw new Error('Oversized run was sent') } }
  await render(builder(api, resumes, ui.realAnalysisLink({ resumes: resumes.map(ui.realResumeSelection), targets: [eligible.selection] }, workspaceId)))
  assert.match(dom.window.document.body.textContent, /501 comparisons exceeds the 500-comparison limit/)
  assert.equal(dom.window.document.querySelectorAll('input[type="checkbox"]:checked').length, 502)
  assert.equal([...dom.window.document.querySelectorAll('button')].find((item) => item.textContent === 'Run analysis').disabled, true)
  await act(async () => root.unmount()); root = null
  await render(builder({ ...api, canWrite: false }, [resumeSummary('pending', 1, 'queued')], '/analyses/new?data=real'))
  assert.match(dom.window.document.body.textContent, /read-only/)
  assert.equal(dom.window.document.querySelector('input[aria-label^="Include Name not stated"]').disabled, true)
})

test('builder reviews newer job versions without replacing the selected historical version', async () => {
  const older = target('job', 1)
  const newer = target('job', 2)
  const calls = []
  const api = { ...baseApi, targets: { state: 'ready', value: [newer, older] }, create: async (input) => { calls.push(input); throw new Error('Controlled response loss') } }
  await render(builder(api, [resumeSummary()], ui.realAnalysisLink({ resumes: [resumeSelection()], targets: [older.selection] })))
  assert.match(dom.window.document.body.textContent, /A newer saved job rubric v2 is available/)
  assert.match(dom.window.document.body.textContent, /This selection still uses v1/)
  const olderCheckbox = dom.window.document.querySelector('input[aria-label*="Job rubric v1"]')
  const newerCheckbox = dom.window.document.querySelector('input[aria-label*="Job rubric v2"]')
  assert.equal(olderCheckbox.checked, true)
  assert.equal(newerCheckbox.checked, false)
  await act(async () => newerCheckbox.click())
  assert.equal(olderCheckbox.checked, true)
  assert.equal(newerCheckbox.checked, true)
  assert.match(dom.window.document.body.textContent, /newer version is also selected as a separate comparison target/)
  await act(async () => [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Run analysis').click())
  assert.deepEqual(calls[0].targets.map((selection) => selection.rubricVersion), [1, 2])
})

test('saved GS results and comparison-scoped evidence remain readable when new-run dependencies are disabled', async () => {
  const detail = comparisonDetail()
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/features') return json({ realAnalyses: false, realResumeImports: false })
    if (url.endsWith('/analyses')) return json({ runs: [runSummary()] })
    if (url.endsWith('/analyses/run-one')) return json(runDetail('grade'))
    if (url.endsWith('/comparisons')) return json({ comparisons: [detail] })
    if (url.endsWith('/comparisons/comparison-one')) return json(detail)
    if (url === `/api/workspaces/${workspaceId}/analyses/run-one/comparisons/comparison-one/documents/saved-reference?version=3`) {
      return json({ document: referenceDocument() })
    }
    return json({ error: { code: 'forbidden', message: 'This reference is not included in the requested comparison.' } }, 403)
  }
  await render(router(React.createElement(ui.WorkspaceContext.Provider, { value: frontendWorkspaceContext({
    workspace: legacy, cloud: { currentWorkspaceId: workspaceId, workspaces: [{ id: workspaceId, role: 'owner' }] },
  }) }, React.createElement(ui.RealAnalysesBridge, { workspaceId }, React.createElement(React.Fragment, null,
    React.createElement(Probe), React.createElement(ui.RealAnalysisDetail, { id: 'run-one' })))), '/analyses/run-one?data=real&result=comparison-one'))
  await settle(() => current?.phase === 'ready')
  await settle(() => dom.window.document.querySelector('button[aria-label^="View requirement evidence for Supported work"]'))
  assert.equal(current.features.realAnalyses, false)
  assert.equal(current.error, null)
  assert.equal(requests.some((request) => request.url.endsWith('/targets')), false)
  assert.equal([...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'New run with these inputs').disabled, true)
  const documentRequests = () => requests.filter((request) => request.url.includes('/documents/'))
  assert.equal(documentRequests().length, 0, 'references are loaded lazily, not entire libraries')
  const button = dom.window.document.querySelector('button[aria-label^="View requirement evidence for Supported work"]')
  await act(async () => button.click())
  await settle(() => dom.window.document.querySelector('mark')?.textContent === 'Apply engineering methods to documented projects.')
  assert.equal(documentRequests().length, 1)
  assert.equal(documentRequests()[0].url, `/api/workspaces/${workspaceId}/analyses/run-one/comparisons/comparison-one/documents/saved-reference?version=3`)
  assert.match(dom.window.document.body.textContent, /Original page 178 of 204/)
  await assert.rejects(current.document('run-one', 'comparison-other', 'saved-reference', 3), /not included in the requested comparison/)
  assert.deepEqual(documentRequests().map((request) => request.url), [
    `/api/workspaces/${workspaceId}/analyses/run-one/comparisons/comparison-one/documents/saved-reference?version=3`,
    `/api/workspaces/${workspaceId}/analyses/run-one/comparisons/comparison-other/documents/saved-reference?version=3`,
  ])
  assert.equal(requests.some((request) => request.url.startsWith(`/api/workspaces/${workspaceId}/analyses/run-one/documents/`)), false)
  const forged = { ...detail.result.criteria[0].citations[0], documentId: 'job-document' }
  assert.equal(ui.citationMatches(detail.resumeSnapshot.document, forged), false)
  assert.equal(ui.citationMatches(detail.resumeSnapshot.document, { ...detail.result.criteria[0].citations[0], quote: 'An invented quotation' }), false)
})

test('bounded cancellation remains active and disables retries until durable cancellation finishes', async () => {
  const pending = runSummary('run-one', 'cancelled')
  pending.run.cancellation = { requestedAt: timestamp, requestedBy: 'reviewer', nextComparisonIndex: 0 }
  assert.equal(ui.realAnalysisWorkActive(pending), true)
  const finished = structuredClone(pending)
  finished.run.cancellation.completedAt = timestamp
  assert.equal(ui.realAnalysisWorkActive(finished), false)
  const pair = comparisonDetail()
  pair.comparison.status = 'cancelled'
  delete pair.comparison.resultSummary
  const content = (summary) => router(React.createElement(ui.RealAnalysesContext.Provider, { value: {
    ...baseApi, summaries: [summary], detail: () => ({ state: 'ready', value: { ...runDetail(), ...summary } }),
    comparisons: () => ({ state: 'ready', value: [pair] }), ensureComparisons: async () => {},
  } }, React.createElement(ui.RealAnalysisDetail, { id: 'run-one' })), '/analyses/run-one?data=real')
  await render(content(pending))
  assert.match(dom.window.document.body.textContent, /Cancelling unfinished work/)
  assert.match(dom.window.document.body.textContent, /keeps polling until the server confirms completion/)
  for (const label of ['Retry failed / cancelled', 'Retry saved pair']) {
    assert.equal([...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === label).disabled, true)
  }
  await render(content(finished))
  for (const label of ['Retry failed / cancelled', 'Retry saved pair']) {
    assert.equal([...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === label).disabled, false)
  }
})

test('paused cancellation exposes run-level cleanup recovery without restarting or retrying individual pairs', async () => {
  const paused = runSummary('run-one', 'cancelled')
  paused.run.cancellation = { requestedAt: timestamp, requestedBy: 'reviewer', nextComparisonIndex: 0 }
  paused.run.attempts = 3
  paused.run.error = { code: 'storage-error', stage: 'initialization', message: 'Cancellation paused after storage failures.', retryable: true }
  assert.equal(ui.realAnalysisCancellationPending(paused), true)
  assert.equal(ui.realAnalysisCancellationPaused(paused), true)
  assert.equal(ui.realAnalysisWorkActive(paused), false, 'A stopped control task must not be presented as automatic active processing.')
  const pair = comparisonDetail()
  pair.comparison.status = 'cancelled'
  delete pair.comparison.resultSummary
  const calls = []
  const value = {
    ...baseApi, summaries: [paused], detail: () => ({ state: 'ready', value: { ...runDetail(), ...paused } }),
    comparisons: () => ({ state: 'ready', value: [pair] }), ensureComparisons: async () => {},
    retry: async (...args) => { calls.push(args); return paused },
  }
  const content = (api) => router(React.createElement(ui.RealAnalysesContext.Provider, { value: api },
    React.createElement(ui.RealAnalysisDetail, { id: 'run-one' })), '/analyses/run-one?data=real')
  await render(content(value))
  assert.match(dom.window.document.body.textContent, /Cancellation paused/)
  const resume = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Resume cancellation')
  assert.equal(resume.disabled, false)
  assert.equal([...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Retry saved pair').disabled, true)
  await act(async () => resume.click())
  assert.deepEqual(calls, [['run-one', {}, paused.etag]])
  await render(content({ ...value, canWrite: false }))
  assert.equal([...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Resume cancellation').disabled, true)
})

test('manual run and pair retries stay available after automatic retries stop and reuse saved identities', async () => {
  const failed = runSummary('run-one', 'failed')
  failed.run.error = { code: 'invalid-model-output', stage: 'assessment', message: 'Automatic model attempts exhausted.', retryable: false }
  const pair = comparisonDetail()
  pair.comparison.status = 'failed'
  pair.comparison.error = failed.run.error
  delete pair.comparison.resultSummary
  pair.result = null
  const before = JSON.stringify({ failed, pair })
  const calls = []
  const api = { ...baseApi, summaries: [failed], detail: () => ({ state: 'ready', value: { ...runDetail(), ...failed } }),
    comparisons: () => ({ state: 'ready', value: [pair] }), ensureComparisons: async () => {},
    retry: async (runId, input, etag) => { calls.push({ action: 'run', runId, input, etag }); return failed },
    retryComparison: async (runId, comparisonId, etag) => { calls.push({ action: 'pair', runId, comparisonId, etag }); return pair },
  }
  const content = (canWrite = true) => router(React.createElement(ui.RealAnalysesContext.Provider, { value: { ...api, canWrite } },
    React.createElement(ui.RealAnalysisDetail, { id: 'run-one' })), '/analyses/run-one?data=real')
  await render(content())
  const retryPair = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Retry saved pair')
  const retryRun = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Retry failed / cancelled')
  assert.equal(retryPair.disabled, false)
  assert.equal(retryRun.disabled, false)
  await act(async () => retryPair.click())
  await act(async () => retryRun.click())
  assert.deepEqual(calls, [
    { action: 'pair', runId: 'run-one', comparisonId: 'comparison-one', etag: pair.etag },
    { action: 'run', runId: 'run-one', input: {}, etag: failed.etag },
  ])
  assert.equal(JSON.stringify({ failed, pair }), before, 'manual retries do not replace frozen snapshots or bind new target versions')
  await render(content(false))
  for (const label of ['Retry saved pair', 'Retry failed / cancelled']) {
    assert.equal([...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === label).disabled, true)
  }
})

function Probe() { current = ui.useRealAnalyses(); return React.createElement('span', null, current.phase) }
const legacy = { schemaVersion: 1, jobs: [], resumes: [], rubrics: [], documents: [], runs: [] }
function bridge(workspace = workspaceId, role = 'owner', show = true) {
  return router(React.createElement(ui.WorkspaceContext.Provider, { value: frontendWorkspaceContext({ workspace: legacy, cloud: { currentWorkspaceId: workspace, workspaces: [{ id: workspace, role }] } }) },
    React.createElement(ui.RealAnalysesBridge, { workspaceId: workspace }, show ? React.createElement(Probe) : null)))
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }

test('existing-run retry and cancellation remain available without new-run source readiness', async () => {
  let run = runSummary('run-one', 'failed')
  let pair = { ...comparisonDetail(), comparison: { ...comparisonDetail().comparison, status: 'failed' }, result: null }
  delete pair.comparison.resultSummary
  const originalManifest = structuredClone(run.run.manifest)
  const originalSnapshots = JSON.stringify({ resume: pair.resumeSnapshot, target: pair.targetSnapshot })
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/features') return json({ realAnalyses: false, realResumeImports: false })
    if (init.method === 'POST') {
      const status = url.endsWith('/retry') ? 'queued' : 'cancelled'
      run = runSummary('run-one', status)
      pair = { ...pair, comparison: { ...pair.comparison, status }, etag: `"pair-${status}"` }
      return json(url.includes('/comparisons/') ? { comparison: pair } : { run })
    }
    if (url.endsWith('/analyses')) return json({ runs: [run] })
    if (url.endsWith('/analyses/run-one')) return json({ ...runDetail('grade'), ...run })
    if (url.endsWith('/comparisons')) return json({ comparisons: [pair] })
    throw new Error(`Unexpected live-source dependency request: ${url}`)
  }
  await render(bridge())
  await settle(() => current?.phase === 'ready' && current.features !== null)
  await assert.rejects(current.create({ name: 'Must remain blocked', resumes: [resumeSelection()], targets: [target().selection] }, key), /New analyses are unavailable/)
  let retriedPair, retriedRun
  await act(async () => { retriedPair = await current.retryComparison('run-one', 'comparison-one', '"original-pair"') })
  await act(async () => current.cancelComparison('run-one', 'comparison-one', retriedPair.etag))
  await act(async () => { retriedRun = await current.retry('run-one', {}, '"cancelled-run"') })
  await act(async () => current.cancel('run-one', retriedRun.etag))
  const posts = requests.filter((request) => request.init.method === 'POST')
  assert.deepEqual(posts.map((request) => request.url), [
    `/api/workspaces/${workspaceId}/analyses/run-one/comparisons/comparison-one/retry`,
    `/api/workspaces/${workspaceId}/analyses/run-one/comparisons/comparison-one/cancel`,
    `/api/workspaces/${workspaceId}/analyses/run-one/retry`,
    `/api/workspaces/${workspaceId}/analyses/run-one/cancel`,
  ])
  assert.deepEqual(posts.map((request) => request.init.headers.get('If-Match')), ['"original-pair"', retriedPair.etag, '"cancelled-run"', retriedRun.etag])
  assert.deepEqual(run.run.manifest, originalManifest)
  assert.equal(JSON.stringify({ resume: pair.resumeSnapshot, target: pair.targetSnapshot }), originalSnapshots)
  assert.equal(current.features.realAnalyses, false)
})

test('feature-readiness failures do not hide healthy saved history, but an unavailable history service stays explicit', async () => {
  globalThis.fetch = async (url) => url === '/api/features'
    ? json({ error: { code: 'unavailable', message: 'New-run readiness check is unavailable.' } }, 503)
    : json({ runs: [runSummary()] })
  await render(bridge())
  await settle(() => current?.phase === 'ready' && current.creationError)
  assert.equal(current.features, null)
  assert.equal(current.error, null)
  assert.equal(current.summaries[0].run.id, 'run-one')
  await assert.rejects(current.create({ name: 'No unchecked creation', resumes: [resumeSelection()], targets: [target().selection] }, key), /readiness check is unavailable/)
  globalThis.fetch = async (url) => url === '/api/features' ? json({ realAnalyses: false })
    : json({ error: { code: 'unavailable', message: 'The private analysis store is not enabled.' } }, 503)
  await act(async () => current.refresh())
  assert.equal(current.phase, 'unavailable')
  assert.match(current.error, /private analysis store is not enabled/)
  await assert.rejects(current.document('run-one', 'comparison-one', 'saved-reference', 3), /saved analysis document service is unavailable/)
})

test('historical initialization and cancellation keep polling while new-run readiness is false', async () => {
  const originalSetInterval = dom.window.setInterval
  const originalClearInterval = dom.window.clearInterval
  const timers = new Map()
  let timerId = 0
  dom.window.setInterval = (callback) => { timers.set(++timerId, callback); return timerId }
  dom.window.clearInterval = (id) => { timers.delete(id) }
  let saved = runSummary('run-one', 'initializing')
  saved.run.initialization = { nextComparisonIndex: 25 }
  saved.run.progress = { ...saved.run.progress, total: 100, initialized: 25, queued: 25 }
  let historyReads = 0
  globalThis.fetch = async (url) => {
    if (url === '/api/features') return json({ realAnalyses: false })
    historyReads++
    return json({ runs: [saved] })
  }
  try {
    await render(bridge())
    await settle(() => current?.phase === 'ready' && timers.size > 0)
    assert.equal(current.features.realAnalyses, false)
    saved = runSummary('run-one', 'cancelled')
    saved.run.cancellation = { requestedAt: timestamp, requestedBy: 'reviewer', nextComparisonIndex: 25 }
    await act(async () => { [...timers.values()][0](); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(current.summaries[0].run.status, 'cancelled')
    assert.equal(timers.size, 1, 'pending bounded cancellation continues polling independently of source readiness')
    saved.run.cancellation.completedAt = timestamp
    await act(async () => { [...timers.values()][0](); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(current.summaries[0].run.cancellation.completedAt, timestamp)
    assert.equal(timers.size, 0)
    assert.ok(historyReads >= 3)
  } finally {
    if (root) { await act(async () => root.unmount()); root = null }
    dom.window.setInterval = originalSetInterval
    dom.window.clearInterval = originalClearInterval
  }
})

test('analysis provider keeps uncertain creation keys across view remounts and never writes sample storage', async () => {
  let attempts = 0
  let accepted = null
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    if (url === '/api/features') return json({ realAnalyses: true })
    if (url.endsWith('/targets')) return json({ targets: [target()] })
    if (init.method === 'GET') return json({ runs: accepted ? [accepted] : [] })
    if (++attempts === 1) throw new TypeError('Response lost')
    accepted = runSummary('accepted-real', 'queued')
    return json({ run: accepted }, 202)
  }
  const before = JSON.stringify(legacy)
  dom.window.localStorage.clear()
  await render(bridge())
  await settle(() => current?.phase === 'ready')
  const input = { name: 'Saved review', resumes: [resumeSelection()], targets: [target().selection] }
  const firstKey = current.requestKey(input)
  await act(async () => { await assert.rejects(current.create(input, firstKey), /Response lost/) })
  await render(bridge(workspaceId, 'owner', false))
  await render(bridge())
  assert.equal(current.requestKey(input), firstKey)
  await act(async () => current.create(input, current.requestKey(input)))
  assert.equal(current.summaries[0].run.id, 'accepted-real')
  const posts = requests.filter((item) => item.init.method === 'POST')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].init.headers.get('Idempotency-Key'), posts[1].init.headers.get('Idempotency-Key'))
  assert.equal(posts[0].init.body, posts[1].init.body)
  assert.notEqual(current.requestKey(input), firstKey, 'a separately requested new run after acknowledgement gets a fresh key')
  assert.equal(JSON.stringify(legacy), before)
  assert.equal(dom.window.localStorage.length, 0)
})

test('stale list responses cannot replace acknowledged run mutations; workspace switches discard old private state', async () => {
  const stale = deferred()
  let lists = 0
  let cancelled = false
  globalThis.fetch = async (url, init) => {
    if (url === '/api/features') return json({ realAnalyses: true })
    if (url.endsWith('/targets')) return json({ targets: [] })
    if (url.endsWith('/cancel')) { cancelled = true; return json({ run: runSummary('run-one', 'cancelled') }) }
    if (url.endsWith('/comparisons')) return json({ comparisons: [] })
    if (url.endsWith('/run-one')) return json({ ...runDetail(), ...runSummary('run-one', cancelled ? 'cancelled' : 'running') })
    if (url.includes('/other/')) return json({ runs: [] })
    if (++lists === 2) return stale.promise
    return json({ runs: [runSummary('run-one', cancelled ? 'cancelled' : 'running')] })
  }
  await render(bridge())
  await settle(() => current?.phase === 'ready')
  let refreshing
  await act(async () => { refreshing = current.refresh(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  await act(async () => current.cancel('run-one', '"run-one-running"'))
  await act(async () => { stale.resolve(json({ runs: [runSummary('run-one', 'running')] })); await refreshing })
  assert.equal(current.summaries[0].run.status, 'cancelled')
  await render(bridge('other', 'viewer'))
  await settle(() => current?.phase === 'ready')
  assert.equal(current.summaries.length, 0)
  await assert.rejects(current.cancel('run-one', '"old"'), /read-only/)
})
