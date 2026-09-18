import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { frontendWorkspaceContext } from './frontend.test-support.mjs'

const output = resolve(`.analysis-table-browsing-tests-${randomUUID()}`)
const timestamp = '2026-09-18T12:00:00.000Z'
const workspaceId = 'fictional-workspace'
const hash = 'a'.repeat(64)
const originals = new Map()
const originalFetch = globalThis.fetch
let ui, dom, root, createRoot, navigate, location, calls

function target({ kind = 'job', id = 'job-one', version = 1, label = 'Shared target', sublabel = 'Captured engineering scope' } = {}) {
  const common = { id: `target-${id}-${version}`, workspaceId, dataKind: 'real', kind, label, sublabel, rubricId: `rubric-${id}`, rubricVersion: version, criterionCount: 3 }
  return kind === 'job' ? { ...common, selection: { kind, jobId: id, rubricId: common.rubricId, rubricVersion: version, rubricHash: hash,
    documentId: `document-${id}`, documentVersion: 1, documentSha256: hash } }
    : { ...common, selection: { kind, ladderId: id, grade: 9, versionId: `approved-${id}-${version}`, version, versionHash: hash,
      approvalId: `approval-${id}-${version}`, reviewId: `review-${id}-${version}`, sourceSetId: `sources-${id}`, sourceSetHash: hash },
    approvedAt: timestamp, newerDraftAvailable: true, context: {} }
}

function pair(index, { name = `Candidate ${index}`, role = 'Saved engineer', sourceLabel = `profile-${index}.pdf`,
  score = 50, status = 'complete', chosenTarget = target(), runId = 'run-one', completion = 'assessed' } = {}) {
  const selection = { resumeId: `resume-${index}`, documentId: `resume-document-${index}`, documentVersion: 1, documentSha256: hash }
  return { etag: `"pair-${index}"`, comparison: {
    id: `pair-${index}`, recordType: 'analysis-comparison', workspaceId, dataKind: 'real', runId, index, status,
    createdAt: timestamp, updatedAt: timestamp, attempts: 1, retryCount: 0,
    resume: { snapshotId: `snapshot-resume-${index}`, summary: { workspaceId, dataKind: 'real', selection, name, role, sourceLabel, capturedAt: timestamp } },
    target: { snapshotId: `snapshot-target-${index}`, summary: chosenTarget },
    ...(status === 'complete' ? { resultSummary: { completion, overall: score === null
      ? { status: 'withheld', score: null, reason: 'unassessed-weighted-criteria', message: 'A saved weighted criterion was not assessable.' }
      : { status: 'available', score }, coverage: { totalCriteria: 3, supported: 1, partial: 1, missing: 0, notAssessed: 1, notApplicable: 0, assessedWeight: 60, totalWeight: 100 } } } : {}),
  } }
}

function summary(pairs = [], { id = 'run-one', name = 'Saved evidence review', status = 'complete', total = pairs.length, createdAt = timestamp } = {}) {
  const count = (status) => pairs.filter((pair) => pair.comparison.status === status).length
  return { etag: `"${id}-${status}"`, run: {
    id, recordType: 'analysis-run', workspaceId, dataKind: 'real', name, status, createdAt, updatedAt: timestamp, createdBy: 'fixture',
    idempotencyKey: 'fixture-key', inputFingerprint: hash, manifest: {}, initialization: { nextComparisonIndex: pairs.length, completedAt: timestamp },
    attempts: 1, retryCount: 0,
    progress: { total, initialized: pairs.length, queued: count('queued'), running: count('running'), complete: count('complete'),
      failed: count('failed'), cancelled: count('cancelled'), scored: pairs.filter((pair) => pair.comparison.resultSummary?.overall.status === 'available').length,
      unscored: pairs.filter((pair) => pair.comparison.resultSummary?.overall.status === 'withheld').length },
  } }
}

function resultDetail(savedPair) {
  const { comparison } = savedPair
  const resume = comparison.resume.summary
  const target = comparison.target.summary
  const document = { id: resume.selection.documentId, kind: 'resume', version: 1, title: 'Frozen fictional source', sample: false,
    paragraphs: [{ id: 'source-p1', page: 1, heading: 'Experience', text: 'BODY-ONLY-NEEDLE is not summary metadata.' }] }
  return { ...savedPair,
    resumeSnapshot: { resume, document, extraction: { pagination: 'html-sections' } },
    targetSnapshot: { kind: 'job', summary: target, selection: target.selection, rubric: { id: target.rubricId, version: target.rubricVersion, criteria: [] },
      document: { ...document, id: 'job-document', kind: 'job' }, requirementEvidence: [], original: { contentType: 'text/html' } },
    result: comparison.status !== 'complete' ? null : {
      ...comparison.resultSummary, createdAt: timestamp, summary: 'A fictional frozen assessment, never a hiring decision.',
      criteria: [], qualifications: [], limitations: [{ code: 'sparse-source', message: 'Frozen limitation remains visible.' }],
      provenance: { assessment: { model: 'fixture', deployment: 'fixture', promptVersion: 'fixture-v1', schemaVersion: 'fixture-v1' },
        calculationVersion: 'fixture-v1', groundingReviews: [], correctionCount: 0,
        resumeSnapshot: { snapshotId: comparison.resume.snapshotId, sha256: hash }, targetSnapshot: { snapshotId: comparison.target.snapshotId, sha256: hash } },
    },
  }
}

function apiFor(pairs, targets = [target()], options = {}) {
  const runSummary = options.summary ?? summary(pairs)
  const detail = { ...runSummary, targets, resumes: pairs.map((pair) => pair.comparison.resume.summary) }
  const api = {
    workspaceId, canWrite: true, phase: 'ready', error: null, creationError: null, features: { realAnalyses: true }, summaries: [runSummary],
    targets: { state: 'ready', value: targets }, detail: () => ({ state: 'ready', value: detail }),
    comparisons: () => ({ state: 'ready', value: pairs }),
    comparison: (runId, id) => {
      const found = pairs.find((pair) => pair.comparison.runId === runId && pair.comparison.id === id)
      return found ? { state: 'ready', value: resultDetail(found) } : { state: 'error', error: 'Saved fixture comparison not found.' }
    },
    ensureDetail: async (...args) => { calls.push(['detail', ...args]) },
    ensureComparisons: async (...args) => { calls.push(['pairs', ...args]) },
    ensureComparison: async (...args) => { calls.push(['result', ...args]) },
    refresh: async () => { calls.push(['refresh']) },
    pending: () => false,
    retryComparison: async (...args) => { calls.push(['retry-pair', ...args]); return pairs.find((pair) => pair.comparison.id === args[1]) },
    cancelComparison: async (...args) => { calls.push(['cancel-pair', ...args]); return pairs.find((pair) => pair.comparison.id === args[1]) },
    retry: async (...args) => { calls.push(['retry-run', ...args]); return runSummary },
    cancel: async (...args) => { calls.push(['cancel-run', ...args]); return runSummary },
    document: async () => assert.fail('Browsing must not fetch evidence documents.'),
  }
  return { ...api, ...options }
}

function sampleRun({ multi = true, id = 'sample-run' } = {}) {
  const workspace = ui.createInitialWorkspace()
  const single = structuredClone(workspace.runs.find((run) => run.targets.length === 1))
  const grade = structuredClone(workspace.runs.flatMap((run) => run.targets).find((target) => target.kind === 'grade'))
  const targets = multi ? [grade, single.targets[0]] : single.targets
  const resumes = single.resumes
  const names = ['Zeta Person', 'alpha Person', 'Candidate 10']
  resumes.forEach(({ resume, document }, index) => {
    resume.name = names[index]
    resume.role = ['Research analyst', 'Platform engineer', 'Data specialist'][index]
    resume.sourceLabel = ['Research-CV.pdf', 'Engineering-profile.html', 'data-source.pdf'][index]
    document.title = ['Saved research portfolio', 'Saved systems portfolio', 'Saved analytics portfolio'][index]
  })
  const run = { ...single, id, name: `Fictional ${id}`, targets, resumes, comparisons: [] }
  for (const [resumeIndex, { resume }] of resumes.entries()) for (const [targetIndex, target] of targets.entries()) {
    run.comparisons.push({ id: `${id}-pair-${resumeIndex}-${targetIndex}`, resumeId: resume.id, targetId: target.id, status: 'queued', score: null, criteria: [], summary: '' })
  }
  run.comparisons = run.comparisons.map((comparison) => ui.evaluateComparison(run, comparison.id))
  for (const [index, { resume }] of resumes.entries()) for (const target of targets) {
    const comparison = run.comparisons.find((comparison) => comparison.resumeId === resume.id && comparison.targetId === target.id)
    comparison.score = (target.kind === 'job' ? [0, 75, null] : [95, 10, 20])[index]
    comparison.criteria = comparison.criteria.map((criterion, criterionIndex) => ({ ...criterion,
      citations: criterionIndex < [2, 1, 0][index] ? [{ documentId: resumes[index].document.id, documentVersion: 1,
        paragraphId: resumes[index].document.paragraphs[0].id, page: 1, heading: 'Saved source', quote: 'Fictional citation' }] : [],
    }))
  }
  return run
}

function frozen(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) frozen(item) }
  return value
}

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, localStorage: dom.window.localStorage,
    CSS: { escape: (value) => value }, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export * from './src/features/analyses/analysisTableBrowsing';
    export { targetIdentity } from './src/features/analyses/realAnalysisUi';
    export { WorkspaceContext } from './src/app/workspace-context';
    export { RealAnalysesContext } from './src/app/real-analyses-context';
    export { AnalysisDetail } from './src/features/analyses/AnalysisDetail';
    export { RealAnalysisDetail } from './src/features/analyses/RealAnalysisDetail';
    export { AnalysesPage } from './src/features/analyses/AnalysesPage';
    export { RealAnalysesPage } from './src/features/analyses/RealAnalysesPage';
    export { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
    export { createInitialWorkspace } from './src/data/fixtures';
    export { evaluateComparison } from './src/services/scoring';
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
  jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

beforeEach(() => {
  calls = []
  dom.window.localStorage.clear()
  globalThis.fetch = async () => assert.fail('This suite must not contact cloud services or private documents.')
})
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null } })
after(async () => {
  globalThis.fetch = originalFetch
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

const browse = (overrides = {}) => ({ query: '', targetId: '', sort: null, ...overrides })
const indexes = (rows) => rows.map((row) => row.comparison.index)
const sampleNames = (rows) => rows.map((row) => row.snapshot.resume.name)

test('real selectors preserve saved index ties, natural names, null-last scores in both directions, and frozen inputs', () => {
  const targets = [target()]
  const pairs = [pair(0, { name: 'Candidate 10', score: null }), pair(1, { name: 'Candidate 2', score: 0 }),
    pair(2, { name: 'ALPHA', score: 72 }), pair(3, { name: 'alpha', score: 72 }),
    pair(4, { name: null, score: 90 }), pair(5, { name: '  ', score: Number.NaN })]
  const incoming = frozen([pairs[4], pairs[3], pairs[0], pairs[5], pairs[1], pairs[2]])
  const before = JSON.stringify(incoming)
  const ordered = (key, direction) => ui.selectRealComparisons(incoming, targets, browse({ sort: { key, direction } })).rows
  assert.deepEqual(indexes(ordered('name', 'asc')), [2, 3, 1, 0, 4, 5])
  assert.deepEqual(indexes(ordered('name', 'desc')), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(indexes(ordered('score', 'asc')), [1, 2, 3, 4, 0, 5])
  assert.deepEqual(indexes(ordered('score', 'desc')), [4, 2, 3, 1, 0, 5])
  const saved = ui.selectRealComparisons(incoming, targets, browse()).rows
  assert.deepEqual(indexes(saved), [0, 1, 2, 3, 4, 5])
  assert.notEqual(saved, incoming)
  assert.equal(saved[0], pairs[0])
  assert.equal(JSON.stringify(incoming), before)
})

test('real metadata search trims and case-folds only saved fields, with exact duplicate-name target intersection', () => {
  const targets = [target({ version: 1, sublabel: 'Captured Alpha agency' }), target({ version: 2, sublabel: 'Captured Beta agency' })]
  const pairs = frozen([pair(0, { name: 'Ada Lovelace', role: 'Platform Engineer', sourceLabel: 'Curriculum-10.pdf', chosenTarget: targets[0] }),
    pair(1, { name: 'Ada Lovelace', chosenTarget: targets[1] })])
  for (const query of ['', '  ', '  ADA  ', 'LOVELACE', 'platform', '10.PDF', 'shared TARGET', 'ALPHA AGENCY']) {
    assert.equal(ui.selectRealComparisons(pairs, targets, browse({ query })).rows.some((row) => row.comparison.index === 0), true, query)
  }
  for (const query of ['BODY-ONLY-NEEDLE', 'Lovelace Platform', 'Missing person']) assert.equal(ui.selectRealComparisons(pairs, targets, browse({ query })).rows.length, 0)
  assert.deepEqual(indexes(ui.selectRealComparisons(pairs, targets, browse({ query: 'ada', targetId: ui.targetIdentity(targets[1].selection) })).rows), [1])
  assert.equal(ui.selectRealComparisons(pairs, targets, browse({ query: 'alpha agency', targetId: ui.targetIdentity(targets[1].selection) })).rows.length, 0)
  assert.notEqual(ui.realComparisonTargetLabel(targets[0]), ui.realComparisonTargetLabel(targets[1]))
  const sameLabels = [target({ id: 'job-a' }), target({ id: 'job-b' })]
  const labels = ui.distinctTargetLabels(sameLabels, ui.realComparisonTargetLabel)
  assert.notEqual(labels[0], labels[1], 'Exact identities remain distinguishable even when every display field matches.')
})

test('score gating uses the entire frozen target manifest, including uninitialized targets and exact grade versions', () => {
  const targets = [target(), target({ version: 2 }), target({ kind: 'grade', id: 'ladder-a' }), target({ kind: 'grade', id: 'ladder-a', version: 2 })]
  const pairs = [pair(0, { score: 0 }), pair(1, { score: 80 })]
  let selection = ui.selectRealComparisons(pairs, targets, browse({ sort: { key: 'score', direction: 'desc' } }))
  assert.equal(selection.scoreEnabled, false)
  assert.equal(selection.sort, null)
  assert.deepEqual(indexes(selection.rows), [0, 1], 'One materialized target is not permission to rank a multi-target plan.')
  selection = ui.selectRealComparisons(pairs, targets, browse({ targetId: ui.targetIdentity(targets[0].selection), sort: { key: 'score', direction: 'desc' } }))
  assert.equal(selection.scoreEnabled, true)
  assert.deepEqual(indexes(selection.rows), [1, 0])
  const gradePairs = [pair(2, { chosenTarget: targets[2] }), pair(3, { chosenTarget: targets[3] })]
  assert.deepEqual(indexes(ui.selectRealComparisons(gradePairs, targets, browse({ targetId: ui.targetIdentity(targets[2].selection) })).rows), [2])
  assert.equal(ui.selectRealComparisons(pairs, [targets[0]], browse()).scoreEnabled, true)
})

test('status sorting means processing, preserving completed unscored/limited pairs and active versus paused cancellation', () => {
  const pairs = [pair(0, { score: null, completion: 'limited' }), pair(1, { status: 'failed' }), pair(2, { status: 'running' }),
    pair(3, { status: 'cancelled' }), pair(4, { status: 'queued' }), pair(5, { score: 0 })]
  assert.deepEqual(pairs.map((pair) => ui.realComparisonProcessingRank(pair)), [2, 0, 1, 0, 1, 2])
  assert.deepEqual(indexes(ui.selectRealComparisons(pairs, [target()], browse({ sort: { key: 'status', direction: 'asc' } })).rows), [1, 3, 2, 4, 0, 5])
  assert.deepEqual(indexes(ui.selectRealComparisons(pairs, [target()], browse({ sort: { key: 'status', direction: 'desc' } })).rows), [0, 5, 2, 4, 1, 3])
  const cancelling = summary(pairs, { status: 'cancelled' })
  cancelling.run.cancellation = { requestedAt: timestamp, requestedBy: 'fixture', nextComparisonIndex: 2 }
  assert.equal(ui.realAnalysisProcessingRank(cancelling), 1)
  assert.equal(ui.realComparisonProcessingRank(pairs[3], cancelling), 1)
  assert.equal(ui.realComparisonProcessingRank(pairs[0], cancelling), 2)
  const paused = structuredClone(cancelling)
  paused.run.attempts = 3
  paused.run.error = { code: 'storage-error', stage: 'initialization', message: 'Cleanup paused.', retryable: true }
  assert.equal(ui.realAnalysisProcessingRank(paused), 0)
  assert.equal(ui.realComparisonProcessingRank(pairs[2], paused), 0)
  assert.equal(ui.realComparisonProcessingRank(pairs[0], paused), 2)
  cancelling.run.cancellation.completedAt = timestamp
  assert.equal(ui.realAnalysisProcessingRank(cancelling), 0)
  for (const status of ['initializing', 'queued', 'running', 'parsing', 'generating', 'profiling']) assert.equal(ui.analysisProcessingRank(status), 1)
})

test('sample selectors retain matrix rows for target matches and search only frozen resume metadata and document labels', () => {
  const run = frozen(sampleRun())
  const original = JSON.stringify(run)
  for (const query of ['  RESEARCH  ', 'research-CV', 'saved research portfolio', 'zeta']) {
    assert.deepEqual(sampleNames(ui.selectSampleComparisons(run, browse({ query })).rows), ['Zeta Person'])
  }
  assert.equal(ui.selectSampleComparisons(run, browse({ query: run.targets[0].sublabel.toUpperCase() })).rows.length, 3)
  assert.equal(ui.selectSampleComparisons(run, browse({ query: run.resumes[0].document.paragraphs[0].text })).rows.length, 0)
  const job = run.targets.find((target) => target.kind === 'job')
  assert.equal(ui.selectSampleComparisons(run, browse({ query: run.targets.find((target) => target.kind === 'grade').label, targetId: job.id })).rows.length, 0)
  for (const key of ['score', 'coverage', 'status']) {
    const result = ui.selectSampleComparisons(run, browse({ sort: { key, direction: 'desc' } }))
    assert.equal(result.sort, null)
    assert.deepEqual(sampleNames(result.rows), ['Zeta Person', 'alpha Person', 'Candidate 10'])
  }
  assert.equal(ui.selectSampleComparisons(run, browse()).comparisonCount, 6)
  assert.equal(JSON.stringify(run), original)
})

test('sample target-scoped scores and cited-criterion counts keep zero and completed unscored rows separate from pending work', () => {
  const run = sampleRun()
  const targetId = run.targets.find((target) => target.kind === 'job').id
  const sort = (key, direction) => ui.selectSampleComparisons(run, browse({ targetId, sort: { key, direction } })).rows
  assert.deepEqual(sampleNames(sort('score', 'asc')), ['Zeta Person', 'alpha Person', 'Candidate 10'])
  assert.deepEqual(sampleNames(sort('score', 'desc')), ['alpha Person', 'Zeta Person', 'Candidate 10'])
  assert.deepEqual(sampleNames(sort('coverage', 'asc')), ['Candidate 10', 'alpha Person', 'Zeta Person'])
  assert.deepEqual(sampleNames(sort('coverage', 'desc')), ['Zeta Person', 'alpha Person', 'Candidate 10'])
  const first = run.comparisons.find((comparison) => comparison.resumeId === run.resumes[0].resume.id && comparison.targetId === targetId)
  first.status = 'running'
  first.score = 99
  assert.deepEqual(sampleNames(sort('score', 'desc')), ['alpha Person', 'Zeta Person', 'Candidate 10'], 'An old score on unfinished work is not an available score.')
  assert.deepEqual(sampleNames(sort('coverage', 'asc')), ['Candidate 10', 'alpha Person', 'Zeta Person'])
  assert.deepEqual(sampleNames(sort('coverage', 'desc')), ['alpha Person', 'Candidate 10', 'Zeta Person'])
  assert.deepEqual(sampleNames(sort('status', 'desc')), ['alpha Person', 'Candidate 10', 'Zeta Person'])
  assert.deepEqual(ui.sampleComparisonDefaultSort(sampleRun({ multi: false })), { key: 'score', direction: 'desc' })
  assert.equal(ui.sampleComparisonDefaultSort(run), null)
})

test('history selectors use true totals, chronological timestamps, sample runStatus, stable ties, and default source order', () => {
  const real = [summary([], { id: 'ten', name: 'Analysis 10', total: 2, createdAt: '2026-09-18T23:30:00-04:00' }),
    summary([], { id: 'two', name: 'analysis 2', total: 100, createdAt: '2026-09-19T01:00:00Z', status: 'partial' }),
    summary([], { id: 'tie', name: 'Analysis 2', total: 0, createdAt: '2026-09-17T00:00:00Z', status: 'running' })]
  const before = JSON.stringify(frozen(real))
  const realOrder = (key, direction) => ui.selectRealAnalysisRuns(real, '', 'all', { key, direction }).map((summary) => summary.run.id)
  assert.deepEqual(realOrder('name', 'asc'), ['two', 'tie', 'ten'])
  assert.deepEqual(realOrder('name', 'desc'), ['ten', 'two', 'tie'])
  assert.deepEqual(realOrder('comparisons', 'asc'), ['tie', 'ten', 'two'])
  assert.deepEqual(realOrder('comparisons', 'desc'), ['two', 'ten', 'tie'])
  assert.deepEqual(realOrder('created', 'desc'), ['ten', 'two', 'tie'])
  assert.deepEqual(realOrder('status', 'asc'), ['two', 'tie', 'ten'])
  assert.deepEqual(ui.selectRealAnalysisRuns(real, '', 'all', null), real)
  assert.deepEqual(ui.selectRealAnalysisRuns(real, '  ANALYSIS  ', 'complete', null).map((summary) => summary.run.id), ['ten'])
  assert.equal(JSON.stringify(real), before)
  const complete = sampleRun({ multi: false, id: 'sample-complete' })
  complete.comparisons.forEach((comparison) => { comparison.score = 50 })
  const limited = sampleRun({ id: 'sample-limited' })
  const running = sampleRun({ id: 'sample-running' })
  running.comparisons[0].status = 'queued'
  const sample = [complete, limited, running]
  assert.deepEqual(ui.selectSampleAnalysisRuns(sample, '', 'all', { key: 'status', direction: 'asc' }).map((run) => run.id), ['sample-limited', 'sample-running', 'sample-complete'])
  assert.deepEqual(ui.selectSampleAnalysisRuns(sample, '', 'all', { key: 'targets', direction: 'asc' }).map((run) => run.id), ['sample-complete', 'sample-limited', 'sample-running'])
  assert.deepEqual(ui.selectSampleAnalysisRuns(sample, '', 'attention', null).map((run) => run.id), ['sample-limited', 'sample-running'])
  assert.deepEqual(ui.selectSampleAnalysisRuns(sample, '', 'all', null), sample)
})

function Probe() {
  navigate = ui.useNavigate()
  location = ui.useLocation()
  return null
}
function app({ api = null, runs = [], cloud = true, path = '/analyses/run-one?data=real', directId } = {}) {
  const workspace = { schemaVersion: 1, jobs: [], resumes: [], documents: [], rubrics: [], runs }
  const value = { workspace, ...(cloud ? { cloud: { currentWorkspaceId: api?.workspaceId ?? workspaceId } } : {}),
    cancelRun: (id) => calls.push(['cancel-sample', id]), retryRun: (id) => calls.push(['retry-sample', id]) }
  return React.createElement(ui.MemoryRouter, { initialEntries: [path], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    React.createElement(ui.WorkspaceContext.Provider, { value: frontendWorkspaceContext(value, { analyses: api?.summaries }) }, React.createElement(ui.RealAnalysesContext.Provider, { value: api },
      React.createElement(Probe),
      directId ? React.createElement(ui.RealAnalysisDetail, { id: directId }) : React.createElement(ui.Routes, null,
        React.createElement(ui.Route, { path: '/analyses', element: React.createElement(ui.AnalysesPage) }),
        React.createElement(ui.Route, { path: '/analyses/:id', element: React.createElement(ui.AnalysisDetail) }),
      ),
    )),
  )
}
async function render(element) {
  root ??= createRoot(dom.window.document.getElementById('root'))
  await act(async () => root.render(element))
}
function element(selector) {
  const found = dom.window.document.querySelector(selector)
  assert.ok(found, selector)
  return found
}
function button(label) {
  const found = [...dom.window.document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label || button.textContent.trim() === label)
  assert.ok(found, label)
  return found
}
async function click(label) { await act(async () => button(label).click()) }
async function sortHeader(label) {
  const found = [...dom.window.document.querySelectorAll('th button')].find((button) => button.getAttribute('aria-label').startsWith(`Sort ${label}:`))
  assert.ok(found, label)
  await act(async () => found.click())
}
async function choose(label, text) {
  const select = element(`select[aria-label="${label}"]`)
  const option = [...select.options].find((option) => option.textContent === text)
  assert.ok(option, `${label}: ${text}`)
  assert.equal(option.disabled, false, `${text} is enabled`)
  await act(async () => { select.value = option.value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
}
async function chooseTarget(value) {
  const select = element('select[aria-label="Comparison target"]')
  assert.ok([...select.options].some((option) => option.value === value), value)
  await act(async () => { select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
}
async function search(value, label = 'Search comparisons') {
  const input = element(`input[aria-label="${label}"]`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function go(to) { await act(async () => navigate(to)) }
async function backLink(text) {
  const link = [...dom.window.document.querySelectorAll('a')].find((link) => link.textContent.trim() === text)
  assert.ok(link, text)
  await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })))
}
function tableRows(selector = '.comparison-table') { return [...dom.window.document.querySelectorAll(`${selector} tbody tr`)] }
function tableNames(selector = '.comparison-table') { return tableRows(selector).map((row) => row.querySelector('.row-title, .matrix-person strong').textContent) }
function rowIndexes() { return tableRows().map((row) => Number(row.querySelector('[aria-label^="Review comparison "]').getAttribute('aria-label').match(/^Review comparison (\d+):/)[1]) - 1) }
function chosenSort(label = 'Sort comparisons') { return element(`select[aria-label="${label}"]`).selectedOptions[0].textContent }

test('real comparison headers and mobile selector share state, expose exact targets, and reset unsafe score sorting', async () => {
  const targets = [target(), target({ version: 2 }), target({ kind: 'grade', id: 'ladder-a', label: 'Approved GS-9' })]
  const pairs = [pair(0, { name: 'Zeta', score: 0 }), pair(1, { name: 'Alpha', score: 72 }),
    pair(2, { name: null, score: null, completion: 'limited' }), pair(3, { name: 'Beta', score: 88, chosenTarget: targets[1] }),
    pair(4, { name: 'Gamma', chosenTarget: targets[2] })]
  await render(app({ api: apiFor(pairs, targets) }))
  assert.deepEqual(rowIndexes(), [0, 1, 2, 3, 4])
  assert.equal(chosenSort(), 'Saved order')
  assert.equal(button('Sort Assessment / evidence match: high to low').disabled, true)
  assert.match(dom.window.document.body.textContent, /Select one exact job or grade to sort scores/)
  const targetOptions = [...element('select[aria-label="Comparison target"]').options]
  assert.equal(targetOptions.length, 4)
  assert.match(targetOptions[1].textContent, /Job rubric v1 · source v1/)
  assert.match(targetOptions[2].textContent, /Job rubric v2 · source v1/)
  assert.match(targetOptions[3].textContent, /GS-9 · approved v1/)
  assert.equal([...element('select[aria-label="Sort comparisons"]').options].filter((option) => option.disabled).length, 2)
  await sortHeader('Saved resume')
  assert.deepEqual(rowIndexes(), [1, 3, 4, 0, 2])
  assert.equal(chosenSort(), 'Saved resume: A to Z')
  assert.equal(element('th[aria-sort]').getAttribute('aria-sort'), 'ascending')
  await sortHeader('Saved resume')
  assert.deepEqual(rowIndexes(), [0, 4, 3, 1, 2])
  await sortHeader('Exact target')
  assert.deepEqual(rowIndexes(), [4, 0, 1, 2, 3])
  await sortHeader('Exact target')
  assert.deepEqual(rowIndexes(), [3, 0, 1, 2, 4])
  await chooseTarget(ui.targetIdentity(targets[0].selection))
  await sortHeader('Assessment / evidence match')
  assert.deepEqual(rowIndexes(), [1, 0, 2])
  assert.equal(chosenSort(), 'Assessment / evidence match: high to low')
  assert.match(tableRows()[1].cells[2].textContent, /0\/ 100/)
  assert.match(tableRows()[2].textContent, /No overall score.*Complete · limited assessment.*A saved weighted criterion was not assessable/s)
  assert.equal(tableRows()[2].cells[3].querySelector('.badge').textContent, 'Complete')
  await sortHeader('Assessment / evidence match')
  assert.deepEqual(rowIndexes(), [0, 1, 2])
  await choose('Sort comparisons', 'Saved order')
  assert.deepEqual(rowIndexes(), [0, 1, 2])
  assert.equal(dom.window.document.querySelector('th[aria-sort]'), null)
  await sortHeader('Assessment / evidence match')
  await chooseTarget('')
  assert.equal(chosenSort(), 'Saved order')
  assert.deepEqual(rowIndexes(), [0, 1, 2, 3, 4])
  assert.equal(button('Sort Assessment / evidence match: high to low').disabled, true)
  assert.deepEqual(calls.filter(([kind]) => !['detail', 'pairs'].includes(kind)), [])
})

test('real filtered-empty views keep controls, honest saved/planned counts, stale service errors, and no evidence fetches', async () => {
  const targets = [target()]
  const pairs = [pair(0, { name: 'Ada', role: 'Platform specialist', sourceLabel: 'Curriculum-10.pdf' }), pair(1, { name: 'Grace' })]
  const api = apiFor(pairs, targets, {
    summary: summary(pairs, { total: 8, status: 'running' }), error: 'Fixture progress service is stale.',
    comparisons: () => ({ state: 'ready', value: pairs, error: 'Fixture comparison reload failed.' }),
  })
  await render(app({ api }))
  const initialReads = calls.length
  for (const query of ['  ADA ', 'platform specialist', 'CURRICULUM-10.PDF']) {
    await search(query)
    assert.deepEqual(tableNames(), ['Ada'])
    assert.match(dom.window.document.body.textContent, /Showing 1 of 2 saved comparison records \/ 8 planned/)
  }
  await search('BODY-ONLY-NEEDLE')
  assert.match(dom.window.document.body.textContent, /No matching comparisons/)
  assert.doesNotMatch(dom.window.document.body.textContent, /Comparison initialization is still pending|Loading independent comparisons/)
  assert.match(dom.window.document.body.textContent, /Fixture progress service is stale/)
  assert.match(dom.window.document.body.textContent, /Fixture comparison reload failed/)
  assert.match(dom.window.document.body.textContent, /Showing 0 of 2 saved comparison records \/ 8 planned/)
  assert.equal(element('input[aria-label="Search comparisons"]').disabled, false)
  await choose('Sort comparisons', 'Status / actions: complete first')
  await click('Clear comparison filters')
  assert.deepEqual(rowIndexes(), [0, 1])
  assert.equal(calls.length, initialReads, 'Metadata search and sorting do not trigger service reads or mutations.')
  assert.equal(dom.window.localStorage.length, 0)
  assert.doesNotMatch(location.search, /BODY-ONLY-NEEDLE|platform|Curriculum/i)
  await render(app({ api: { ...api, phase: 'error', canWrite: false } }))
  await search('no such candidate')
  assert.match(dom.window.document.body.textContent, /No matching comparisons/)
  assert.match(dom.window.document.body.textContent, /Fixture comparison reload failed/)
  assert.equal(element('select[aria-label="Sort comparisons"]').disabled, false)
})

test('real no-service, loading, failed-list, pending-initialization, and no-match states remain distinct across hook transitions', async () => {
  await render(app())
  assert.match(dom.window.document.body.textContent, /Real analyses require a cloud workspace/)
  const api = apiFor([], [target()])
  await render(app({ api: { ...api, phase: 'unavailable', error: 'Private fixture history unavailable.' } }))
  assert.match(dom.window.document.body.textContent, /Saved real analysis history is unavailable/)
  await render(app({ api: { ...api, phase: 'loading', detail: () => ({ state: 'loading' }) } }))
  assert.match(dom.window.document.body.textContent, /Opening saved real analysis/)
  await render(app({ api: { ...api, detail: () => ({ state: 'error', error: 'Frozen manifest read failed.' }) } }))
  assert.match(dom.window.document.body.textContent, /This real analysis could not be opened/)
  await render(app({ api: { ...api, comparisons: () => ({ state: 'loading' }) } }))
  assert.match(dom.window.document.body.textContent, /Loading independent comparisons/)
  await search('not saved yet')
  await render(app({ api }))
  assert.match(dom.window.document.body.textContent, /Comparison initialization is still pending/)
  assert.doesNotMatch(dom.window.document.body.textContent, /No matching comparisons/)
  await render(app({ api: { ...api, comparisons: () => ({ state: 'error', error: 'Fixture list service failed.' }) } }))
  assert.match(dom.window.document.body.textContent, /The comparison list could not be loaded/)
  assert.match(dom.window.document.body.textContent, /Fixture list service failed/)
  assert.doesNotMatch(dom.window.document.body.textContent, /Loading independent comparisons|Comparison initialization is still pending/)
  assert.equal(element('input[aria-label="Search comparisons"]').value, 'not saved yet')
  await render(app({ api: apiFor([pair(0)]) }))
  assert.match(dom.window.document.body.textContent, /No matching comparisons/)
  await click('Clear comparison filters')
  assert.deepEqual(rowIndexes(), [0])
})

test('reordered real row actions retain record identities and read-only, cancellation, and retry guards', async () => {
  const pairs = [pair(0, { name: 'Zeta', status: 'failed' }), pair(1, { name: 'Alpha', status: 'failed' }),
    pair(2, { name: 'Beta', status: 'running' }), pair(3, { name: 'Gamma', score: null })]
  const run = summary(pairs, { status: 'running' })
  const api = apiFor(pairs, [target()], { summary: run })
  await render(app({ api }))
  await sortHeader('Saved resume')
  assert.deepEqual(rowIndexes(), [1, 2, 3, 0])
  await click('Retry comparison 2 with saved inputs')
  await click('Cancel comparison 3')
  assert.deepEqual(calls.filter(([kind]) => kind.endsWith('-pair')), [
    ['retry-pair', 'run-one', 'pair-1', '"pair-1"'], ['cancel-pair', 'run-one', 'pair-2', '"pair-2"'],
  ])
  await render(app({ api: { ...api, canWrite: false } }))
  assert.equal(button('Retry comparison 2 with saved inputs').disabled, true)
  assert.equal(button('Cancel comparison 3').disabled, true)
  await choose('Sort comparisons', 'Status / actions: complete first')
  assert.deepEqual(rowIndexes(), [3, 2, 0, 1])
  assert.equal(tableRows()[0].cells[3].querySelector('.badge').textContent, 'Complete')
  const cancelling = structuredClone(run)
  cancelling.run.status = 'cancelled'
  cancelling.run.cancellation = { requestedAt: timestamp, requestedBy: 'fixture', nextComparisonIndex: 0 }
  await render(app({ api: apiFor(pairs, [target()], { summary: cancelling }) }))
  assert.match(dom.window.document.body.textContent, /Cancelling unfinished work/)
  assert.equal(button('Retry comparison 2 with saved inputs').disabled, true)
  assert.equal(button('Cancel comparison 3').disabled, true)
  cancelling.run.attempts = 3
  cancelling.run.error = { code: 'storage-error', stage: 'initialization', message: 'Fixture cleanup paused.', retryable: true }
  await render(app({ api: apiFor(pairs, [target()], { summary: cancelling }) }))
  assert.match(dom.window.document.body.textContent, /Cancellation paused/)
  assert.equal(button('Resume cancellation').disabled, false)
  assert.equal(button('Retry comparison 2 with saved inputs').disabled, true)
  assert.equal(tableRows()[0].cells[3].querySelector('.badge').textContent, 'Complete')
  assert.equal(calls.filter(([kind]) => kind.endsWith('-pair')).length, 2, 'Browsing never implicitly retries or cancels a row.')
})

test('all 500 acknowledged comparisons stay searchable and update in sorted order without losing browsing state', async () => {
  const targets = [target()]
  const pairs = frozen(Array.from({ length: 500 }, (_, index) => pair(index, { score: index % 100 })))
  await render(app({ api: apiFor(pairs, targets) }))
  assert.equal(tableRows().length, 500)
  assert.match(dom.window.document.body.textContent, /Showing 500 of 500 saved comparison records \/ 500 planned/)
  await search('  CANDIDATE 499 ')
  assert.deepEqual(rowIndexes(), [499])
  await chooseTarget(ui.targetIdentity(targets[0].selection))
  await sortHeader('Assessment / evidence match')
  await search('Candidate')
  assert.deepEqual(rowIndexes().slice(0, 5), [99, 199, 299, 399, 499])
  const updated = pairs.map((saved, index) => index === 0 ? pair(index, { score: 100 }) : saved)
  await render(app({ api: apiFor(updated, targets) }))
  assert.equal(element('input[aria-label="Search comparisons"]').value, 'Candidate')
  assert.equal(element('select[aria-label="Comparison target"]').value, ui.targetIdentity(targets[0].selection))
  assert.equal(chosenSort(), 'Assessment / evidence match: high to low')
  assert.equal(tableRows().length, 500)
  assert.deepEqual(rowIndexes().slice(0, 6), [0, 99, 199, 299, 399, 499])
  assert.equal(pairs[0].comparison.resultSummary.overall.score, 0)
  await click('Refresh pairs')
  assert.ok(calls.some(([kind, id, force]) => kind === 'pairs' && id === 'run-one' && force === true))
  assert.equal(chosenSort(), 'Assessment / evidence match: high to low')
  assert.equal(element('input[aria-label="Search comparisons"]').value, 'Candidate')
})

test('real result links and browser history retain local browsing, while run, workspace, and real/sample boundaries reset it', async () => {
  const targets = [target(), target({ version: 2 })]
  const first = [pair(0, { name: 'Zeta Person', score: 0 }), pair(1, { name: 'Alpha Person', score: 75 }),
    pair(2, { name: 'Beta Person', chosenTarget: targets[1] })]
  const second = [pair(0, { name: 'Another Person', runId: 'run-two' })]
  const apiOne = apiFor(first, targets)
  const apiTwo = apiFor(second, [targets[0]], { summary: summary(second, { id: 'run-two' }) })
  const source = (id) => id === 'run-two' ? apiTwo : apiOne
  const api = { ...apiOne, summaries: [...apiOne.summaries, ...apiTwo.summaries],
    detail: (id) => source(id).detail(id), comparisons: (id) => source(id).comparisons(id), comparison: (id, pairId) => source(id).comparison(id, pairId) }
  const runs = [sampleRun({ id: 'run-one' })]
  await render(app({ api, runs }))
  await search('  PERSON ')
  await chooseTarget(ui.targetIdentity(targets[0].selection))
  await sortHeader('Assessment / evidence match')
  await click('Review comparison 2: Alpha Person against Shared target')
  assert.equal(new URLSearchParams(location.search).get('result'), 'pair-1')
  assert.match(dom.window.document.body.textContent, /Frozen limitation remains visible/)
  assert.ok(calls.some(([kind, runId, pairId]) => kind === 'result' && runId === 'run-one' && pairId === 'pair-1'))
  await backLink('All saved comparisons')
  assert.equal(element('input[aria-label="Search comparisons"]').value, '  PERSON ')
  assert.equal(chosenSort(), 'Assessment / evidence match: high to low')
  assert.equal(element('select[aria-label="Comparison target"]').value, ui.targetIdentity(targets[0].selection))
  assert.deepEqual(rowIndexes(), [1, 0])
  await click('Review comparison 2: Alpha Person against Shared target')
  await go(-1)
  assert.deepEqual(rowIndexes(), [1, 0])
  assert.equal(element('input[aria-label="Search comparisons"]').value, '  PERSON ')
  await go('/analyses/run-two?data=real')
  assert.equal(element('input[aria-label="Search comparisons"]').value, '')
  assert.equal(chosenSort(), 'Saved order')
  assert.equal(element('select[aria-label="Comparison target"]').value, '')
  await go('/analyses/run-one?data=real')
  await search('alpha')
  await render(app({ api: { ...api, workspaceId: 'other-fictional-workspace' }, runs }))
  assert.equal(element('input[aria-label="Search comparisons"]').value, '')
  assert.equal(chosenSort(), 'Saved order')
  await search('zeta')
  await go('/analyses/run-one?data=samples')
  assert.equal(element('input[aria-label="Search comparisons"]').value, '')
  assert.equal(chosenSort(), 'Saved order')
  await search('systems portfolio')
  await go('/analyses/run-one?data=real')
  assert.equal(element('input[aria-label="Search comparisons"]').value, '')
  assert.doesNotMatch(location.search, /PERSON|alpha|zeta|portfolio/i)
  assert.equal(location.state, null)
  assert.equal(dom.window.localStorage.length, 0)
})

test('the directly mounted real detail resets on a new id without relying on external router keys', async () => {
  const api = apiFor([pair(0)])
  await render(app({ api, directId: 'run-one' }))
  await search('Candidate')
  await sortHeader('Saved resume')
  const second = apiFor([pair(0, { runId: 'run-two' })], [target()], { summary: summary([], { id: 'run-two' }) })
  await render(app({ api: second, directId: 'run-two' }))
  assert.equal(element('input[aria-label="Search comparisons"]').value, '')
  assert.equal(chosenSort(), 'Saved order')
})

test('sample matrix search and exact-target tables share browsing state without aggregate sorting', async () => {
  const run = sampleRun()
  const original = JSON.stringify(frozen(run))
  const job = run.targets.find((target) => target.kind === 'job')
  const grade = run.targets.find((target) => target.kind === 'grade')
  await render(app({ runs: [run], cloud: false, path: '/analyses/sample-run' }))
  assert.deepEqual(tableNames('.matrix-table'), ['Zeta Person', 'alpha Person', 'Candidate 10'])
  assert.equal(chosenSort(), 'Saved order')
  assert.equal([...element('select[aria-label="Sort comparisons"]').options].filter((option) => option.disabled).length, 6)
  assert.match(dom.window.document.body.textContent, /The matrix has no combined score or status/)
  assert.match(dom.window.document.body.textContent, /3 of 3 resumes shown · 6 of 6 saved comparisons shown/)
  await sortHeader('Resume')
  assert.deepEqual(tableNames('.matrix-table'), ['alpha Person', 'Candidate 10', 'Zeta Person'])
  await search('  ENGINEERING-PROFILE.HTML  ')
  assert.deepEqual(tableNames('.matrix-table'), ['alpha Person'])
  assert.match(dom.window.document.body.textContent, /1 of 3 resumes shown · 2 of 6 saved comparisons shown/)
  await search(grade.label.toUpperCase())
  assert.equal(tableRows('.matrix-table').length, 3)
  await chooseTarget(job.id)
  assert.match(dom.window.document.body.textContent, /No matching comparisons/)
  await click('Clear comparison filters')
  assert.equal(tableRows('.matrix-table').length, 3)
  await chooseTarget(job.id)
  assert.equal(tableRows().length, 3)
  assert.equal(dom.window.document.querySelector('.matrix-table'), null)
  await sortHeader('Evidence match')
  assert.deepEqual(tableNames(), ['alpha Person', 'Zeta Person', 'Candidate 10'])
  assert.match(tableRows()[1].cells[1].textContent, /0\/ 100/)
  assert.match(tableRows()[2].cells[1].textContent, /Not assessed/)
  assert.equal(tableRows()[2].cells[3].querySelector('.badge').textContent, 'Complete')
  await sortHeader('Evidence match')
  assert.deepEqual(tableNames(), ['Zeta Person', 'alpha Person', 'Candidate 10'])
  for (const text of ['Evidence match: high to low', 'Evidence coverage: fewest cited criteria first', 'Status / actions: complete first']) {
    await chooseTarget(job.id)
    await choose('Sort comparisons', text)
    await chooseTarget('')
    assert.equal(chosenSort(), 'Saved order')
    assert.deepEqual(tableNames('.matrix-table'), ['Zeta Person', 'alpha Person', 'Candidate 10'])
    assert.equal(dom.window.document.querySelector('th[aria-sort]'), null)
  }
  await chooseTarget(grade.id)
  await sortHeader('Evidence match')
  assert.deepEqual(tableNames(), ['Zeta Person', 'Candidate 10', 'alpha Person'])
  await click('Zeta Person')
  assert.equal(new URLSearchParams(location.search).get('result'), run.comparisons.find((comparison) => comparison.resumeId === run.resumes[0].resume.id && comparison.targetId === grade.id).id)
  await backLink('All comparisons')
  assert.equal(element('select[aria-label="Comparison target"]').value, grade.id)
  assert.equal(chosenSort(), 'Evidence match: high to low')
  assert.deepEqual(tableNames(), ['Zeta Person', 'Candidate 10', 'alpha Person'])
  await click('Zeta Person')
  await go(-1)
  assert.equal(element('select[aria-label="Comparison target"]').value, grade.id)
  assert.equal(JSON.stringify(run), original)
  assert.deepEqual(calls, [])
})

test('single-target samples retain their score-descending default, zero/null directions, metadata query, and run resets', async () => {
  const run = sampleRun({ multi: false })
  const nextRun = sampleRun({ multi: false, id: 'next-sample' })
  await render(app({ runs: [run, nextRun], cloud: false, path: '/analyses/sample-run' }))
  assert.deepEqual(tableNames(), ['alpha Person', 'Zeta Person', 'Candidate 10'])
  assert.equal(chosenSort(), 'Evidence match: high to low')
  assert.equal(element('th[aria-sort]').getAttribute('aria-sort'), 'descending')
  assert.equal(button('Sort Evidence match: low to high').disabled, false)
  await sortHeader('Evidence match')
  assert.deepEqual(tableNames(), ['Zeta Person', 'alpha Person', 'Candidate 10'])
  await sortHeader('Resume')
  assert.deepEqual(tableNames(), ['alpha Person', 'Candidate 10', 'Zeta Person'])
  await choose('Sort comparisons', 'Default order (score: high to low)')
  assert.deepEqual(tableNames(), ['alpha Person', 'Zeta Person', 'Candidate 10'])
  await search('  SAVED SYSTEMS PORTFOLIO ')
  assert.deepEqual(tableNames(), ['alpha Person'])
  await click('alpha Person')
  await backLink('All comparisons')
  assert.equal(element('input[aria-label="Search comparisons"]').value, '  SAVED SYSTEMS PORTFOLIO ')
  assert.deepEqual(tableNames(), ['alpha Person'])
  await go('/analyses/next-sample')
  assert.equal(element('input[aria-label="Search comparisons"]').value, '')
  assert.equal(chosenSort(), 'Evidence match: high to low')
  await search('Zeta')
  await render(app({ runs: [run, nextRun], api: { workspaceId: 'another-sample-workspace' }, cloud: true }))
  assert.equal(element('input[aria-label="Search comparisons"]').value, '')
  assert.equal(dom.window.localStorage.length, 0)
})

test('sample status and coverage sorting keep processing labels visible and actions bound to the saved run', async () => {
  const run = sampleRun({ multi: false })
  run.comparisons[0].status = 'failed'
  run.comparisons[0].score = null
  run.comparisons[1].status = 'running'
  run.comparisons[1].score = null
  await render(app({ runs: [run], cloud: false, path: '/analyses/sample-run' }))
  await sortHeader('Status / actions')
  assert.deepEqual(tableNames(), ['Zeta Person', 'alpha Person', 'Candidate 10'])
  assert.deepEqual(tableRows().map((row) => row.cells[3].querySelector('.badge').textContent), ['Failed', 'Running', 'Complete'])
  await sortHeader('Status / actions')
  assert.deepEqual(tableNames(), ['Candidate 10', 'alpha Person', 'Zeta Person'])
  await sortHeader('Evidence coverage')
  assert.deepEqual(tableNames(), ['Candidate 10', 'Zeta Person', 'alpha Person'])
  await click('Cancel pending')
  assert.deepEqual(calls, [['cancel-sample', 'sample-run']])
  const updated = structuredClone(run)
  updated.comparisons[1].status = 'cancelled'
  await render(app({ runs: [updated], cloud: false }))
  assert.equal(chosenSort(), 'Evidence coverage: fewest cited criteria first')
  await click('Retry unfinished')
  assert.deepEqual(calls.at(-1), ['retry-sample', 'sample-run'])
  await search('no saved candidate')
  assert.match(dom.window.document.body.textContent, /No matching comparisons/)
  await click('Clear comparison filters')
  assert.equal(tableRows().length, 3)
})

test('synthetic-data guards still block real or mixed sample snapshots before exposing comparison browsing', async () => {
  const run = sampleRun()
  run.targets[0].rubric.dataKind = 'real'
  await render(app({ runs: [run], cloud: false, path: '/analyses/sample-run' }))
  assert.match(dom.window.document.body.textContent, /Real inputs cannot have demo scores/)
  assert.equal(dom.window.document.querySelector('input[aria-label="Search comparisons"]'), null)
  const mixed = sampleRun()
  mixed.resumes[0].document.sample = false
  await render(app({ runs: [mixed], cloud: false }))
  assert.match(dom.window.document.body.textContent, /Real inputs cannot have demo scores/)
  assert.equal(dom.window.document.querySelector('table'), null)
})

test('real analysis history exposes total-count/status/date sorting, keeps filtering and read-only errors, and leaves Open unsortable', async () => {
  const histories = [summary([], { id: 'ten', name: 'Analysis 10', total: 2, createdAt: '2026-09-18T23:30:00-04:00' }),
    summary([], { id: 'two', name: 'Analysis 2', total: 100, status: 'partial', createdAt: '2026-09-19T01:00:00Z' }),
    summary([], { id: 'one', name: 'Analysis 1', total: 0, status: 'running', createdAt: '2026-09-17T00:00:00Z' })]
  const api = apiFor([], [target()], { summaries: histories, canWrite: false, error: 'Last history refresh failed.' })
  await render(app({ api, path: '/analyses?data=real' }))
  assert.deepEqual(tableNames('.data-table'), ['Analysis 10', 'Analysis 2', 'Analysis 1'])
  assert.equal(chosenSort('Sort real analyses'), 'Default order')
  assert.equal(element('thead th:last-child').textContent, 'Open analysis')
  assert.equal(element('thead th:last-child').querySelector('button'), null)
  assert.equal(button('New analysis').disabled, true)
  await sortHeader('Analysis')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 1', 'Analysis 2', 'Analysis 10'])
  assert.equal(chosenSort('Sort real analyses'), 'Analysis: A to Z')
  await sortHeader('Status')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 2', 'Analysis 1', 'Analysis 10'])
  await sortHeader('Independent comparisons')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 1', 'Analysis 10', 'Analysis 2'])
  await sortHeader('Created')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 10', 'Analysis 2', 'Analysis 1'])
  assert.equal(chosenSort('Sort real analyses'), 'Created: newest first')
  await choose('Sort real analyses', 'Default order')
  await click('Complete')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 10'])
  await search('missing name', 'Find a real analysis…')
  assert.match(dom.window.document.body.textContent, /No matching analyses/)
  assert.match(dom.window.document.body.textContent, /Last history refresh failed/)
  await click('Clear filters')
  assert.equal(tableRows('.data-table').length, 3)
  await choose('Sort real analyses', 'Analysis: Z to A')
  await render(app({ api: { ...api, workspaceId: 'other-history-workspace' } }))
  assert.equal(chosenSort('Sort real analyses'), 'Default order')
})

test('sample analysis history sorts counts, processing status and dates with default reset and no human-review state', async () => {
  const ten = sampleRun({ multi: false, id: 'sample-ten' })
  ten.name = 'Analysis 10'
  ten.comparisons.forEach((comparison) => { comparison.score = 50 })
  ten.createdAt = '2026-09-17T00:00:00Z'
  ten.resumes = ten.resumes.slice(0, 1)
  const two = sampleRun({ id: 'sample-two' })
  two.name = 'Analysis 2'
  two.createdAt = '2026-09-19T00:00:00Z'
  const one = sampleRun({ multi: false, id: 'sample-one' })
  one.name = 'Analysis 1'
  one.comparisons[0].status = 'queued'
  one.createdAt = '2026-09-18T00:00:00Z'
  one.resumes = one.resumes.slice(0, 2)
  const runs = [ten, two, one]
  await render(app({ runs, cloud: false, path: '/analyses' }))
  assert.deepEqual(tableNames('.data-table'), ['Analysis 10', 'Analysis 2', 'Analysis 1'])
  assert.equal(element('thead th:last-child').querySelector('button'), null)
  await sortHeader('Analysis')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 1', 'Analysis 2', 'Analysis 10'])
  await sortHeader('Resumes')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 10', 'Analysis 1', 'Analysis 2'])
  await sortHeader('Targets')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 10', 'Analysis 1', 'Analysis 2'])
  await sortHeader('Status')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 2', 'Analysis 1', 'Analysis 10'])
  await sortHeader('Created')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 2', 'Analysis 1', 'Analysis 10'])
  await choose('Sort analyses', 'Default order')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 10', 'Analysis 2', 'Analysis 1'])
  await click('Complete')
  assert.deepEqual(tableNames('.data-table'), ['Analysis 10'])
  await search('missing analysis', 'Find an analysis...')
  assert.match(dom.window.document.body.textContent, /No matching analyses/)
  await click('Clear filters')
  assert.equal(tableRows('.data-table').length, 3)
  assert.equal(calls.length, 0)
})
