import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { analysisSummaryFixture, summaryTimestamp } from './analysisSummaries.test-support.mjs'

const output = resolve(`.analysis-score-distribution-tests-${randomUUID()}`)
const fixture = analysisSummaryFixture()
const target = fixture.targets[0]
const windows = []
const originalFetch = globalThis.fetch
const require = createRequire(import.meta.url)
let ui

before(async () => {
  globalThis.fetch = async () => assert.fail('Score distribution must not fetch services or evidence.')
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export * from './src/features/analyses/analysisScoreDistributionData';
      export { AnalysisScoreDistribution } from './src/features/analyses/AnalysisScoreDistribution';
    ` },
    outfile: join(output, 'ui.cjs'), bundle: true, packages: 'external', format: 'cjs', platform: 'node',
    jsx: 'automatic', logLevel: 'silent',
  })
  ui = require(join(output, 'ui.cjs'))
})
afterEach(() => { for (const window of windows.splice(0)) window.close() })
after(async () => {
  globalThis.fetch = originalFetch
  await rm(output, { recursive: true, force: true })
})

function pair(index, { score = 50, status = 'complete', chosenTarget = target, missing = false, correction } = {}) {
  const { comparison } = structuredClone(fixture.details[0])
  comparison.id = `score-pair-${index}`
  comparison.index = index
  comparison.status = status
  comparison.resume.summary.selection.resumeId = `score-resume-${index}`
  comparison.target.summary = structuredClone(chosenTarget)
  if (status !== 'complete' || missing) delete comparison.resultSummary
  else comparison.resultSummary.overall = score === null
    ? { status: 'withheld', score: null, reason: 'unassessed-weighted-criteria', message: 'Saved weighted evidence is unassessed.' }
    : { status: 'available', score }
  return { etag: `"score-pair-${index}"`, comparison, ...(correction ? { activeCorrection: correction } : {}) }
}
const pairs = scores => scores.map((score, index) => pair(index, { score }))
const binCounts = distribution => distribution.bins.map(bin => bin.count)
function frozen(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) frozen(item) }
  return value
}
function render(overrides = {}) {
  const html = renderToStaticMarkup(React.createElement(ui.AnalysisScoreDistribution, {
    target, comparisons: pairs([12, 28, 44, 51, 56, 62, 67, 73, 81, 88]), planned: 10,
    onRetry: () => assert.fail('Rendering must not request work.'), ...overrides,
  }))
  const dom = new JSDOM(html)
  windows.push(dom.window)
  return { html, document: dom.window.document, text: dom.window.document.body.textContent }
}
function statistics(document) {
  return Object.fromEntries([...document.querySelectorAll('.score-distribution-statistics > div')]
    .map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]))
}

test('the selected mockup sample has exact bins, statistics and median-of-halves endpoints without mutating saved data', () => {
  const input = frozen(pairs([12, 28, 44, 51, 56, 62, 67, 73, 81, 88]).reverse())
  const before = JSON.stringify(input)
  const distribution = ui.calculateScoreDistribution(input, target.selection, 10)
  assert.deepEqual(distribution.statistics, { mean: 56.2, median: 59, minimum: 12, maximum: 88, lowerQuartile: 44, upperQuartile: 73 })
  assert.deepEqual(binCounts(distribution), [0, 1, 1, 0, 1, 2, 2, 1, 2, 0])
  assert.equal(distribution.counts.scored, 10)
  assert.equal(distribution.counts.uninitialized, 0)
  assert.deepEqual(distribution.markers.map(marker => marker.score), [12, 28, 44, 51, 56, 62, 67, 73, 81, 88])
  assert.deepEqual(distribution.errors, [])
  assert.equal(JSON.stringify(input), before)
})

test('zero, 100, every boundary and unrounded decimal scores are counted exactly once', () => {
  const scores = [0, 9.999, 10, 19.999, 20, 29.999, 30, 39.999, 40, 49.999, 50, 59.999, 60, 69.999, 70, 79.999, 80, 89.999, 90, 99.9, 100]
  const distribution = ui.calculateScoreDistribution(pairs(scores), target.selection, scores.length)
  assert.deepEqual(binCounts(distribution), [2, 2, 2, 2, 2, 2, 2, 2, 2, 3])
  assert.equal(binCounts(distribution).reduce((sum, count) => sum + count, 0), scores.length)
  assert.equal(distribution.statistics.minimum, 0)
  assert.equal(distribution.statistics.maximum, 100)
  assert.equal(distribution.markers[1].score, 9.999)
  assert.equal(ui.scoreDistributionBinLabel(distribution.bins[0]), '0 to under 10')
  assert.equal(ui.scoreDistributionBinLabel(distribution.bins[9]), '90 to 100 (inclusive)')
})

test('empty, single and identical groups retain observed values without inventing a spread', () => {
  const empty = ui.calculateScoreDistribution([], target.selection, 4)
  assert.equal(empty.statistics, null)
  assert.deepEqual(binCounts(empty), Array(10).fill(0))
  assert.deepEqual(empty.markers, [])
  assert.equal(empty.counts.uninitialized, 4)
  for (const score of [0, 52.4, 100]) {
    const single = ui.calculateScoreDistribution(pairs([score]), target.selection, 1)
    assert.deepEqual(single.statistics, { mean: score, median: score, minimum: score, maximum: score, lowerQuartile: score, upperQuartile: score })
    const identical = ui.calculateScoreDistribution(pairs(Array(4).fill(score)), target.selection, 4)
    assert.deepEqual(identical.markers, [{ score, count: 4 }])
    assert.equal(identical.statistics.lowerQuartile, score)
    assert.equal(identical.statistics.upperQuartile, score)
  }
})

test('even and odd medians and middle-half endpoints use the documented lower and upper halves', () => {
  for (const [scores, expected] of [
    [[8, 2], [5, 2, 8]],
    [[8, 1, 5, 2], [3.5, 1.5, 6.5]],
    [[10, 1, 5, 8, 2], [5, 1.5, 9]],
    [[7, 6, 5, 4, 3, 2, 1], [4, 2, 6]],
  ]) {
    const { statistics } = ui.calculateScoreDistribution(pairs(scores), target.selection, scores.length)
    assert.deepEqual([statistics.median, statistics.lowerQuartile, statistics.upperQuartile], expected)
  }
})

test('withheld, absent, invalid, unfinished, failed and cancelled results are never zero scores', () => {
  const input = [
    pair(0, { score: 0 }), pair(1, { score: 50 }), pair(2, { score: null }), pair(3, { missing: true }),
    pair(4, { status: 'queued' }), pair(5, { status: 'running' }), pair(6, { status: 'failed' }), pair(7, { status: 'cancelled' }),
    ...[-1, 101, Number.NaN, Infinity, '80'].map((score, index) => pair(8 + index, { score })),
    pair(13), pair(14, { status: 'unexpected' }),
  ]
  input[4].comparison.resultSummary = { ...input[0].comparison.resultSummary, overall: { status: 'available', score: 88 } }
  input[13].comparison.resultSummary.overall = { status: 'available', score: null }
  const distribution = ui.calculateScoreDistribution(frozen(input), target.selection, 17)
  assert.deepEqual(distribution.counts, { scored: 2, withheld: 1, withoutScore: 1, queued: 1, running: 1, failed: 1, cancelled: 1,
    invalid: 7, uninitialized: 2, corrections: 0 })
  assert.deepEqual(distribution.markers, [{ score: 0, count: 1 }, { score: 50, count: 1 }])
  assert.match(distribution.errors.join(' '), /7 saved comparisons have an invalid score or state.*No value was clipped or replaced/)
})

test('exact jobs, rubric versions, GS levels and approved versions never pool even when labels match', () => {
  const jobVersion = structuredClone(target)
  jobVersion.selection.rubricVersion++
  const otherJob = structuredClone(target)
  otherJob.selection.jobId = 'other-job'
  const grade = fixture.targets[1]
  const gradeLevel = structuredClone(grade)
  gradeLevel.selection.grade = 11
  const gradeVersion = structuredClone(grade)
  gradeVersion.selection.version++
  gradeVersion.selection.versionId = 'other-approved-version'
  const targets = [target, jobVersion, otherJob, grade, gradeLevel, gradeVersion]
  const input = targets.map((chosenTarget, index) => pair(index, { score: index * 20, chosenTarget }))
  for (const [index, selected] of targets.entries()) {
    const distribution = ui.calculateScoreDistribution(input, selected.selection, 1)
    assert.equal(distribution.counts.scored, 1)
    assert.equal(distribution.statistics.mean, index * 20)
    assert.deepEqual(distribution.errors, [])
  }
})

test('mismatched hashes and source bindings fail visibly rather than combining same-label targets', () => {
  for (const field of ['rubricHash', 'documentSha256', 'documentId', 'documentVersion', 'approvalId']) {
    const changed = structuredClone(target)
    changed.selection[field] = field === 'documentVersion' ? 2 : 'changed-binding'
    const input = [pair(0, { score: 40 }), pair(1, { score: 100, chosenTarget: changed })]
    const distribution = ui.calculateScoreDistribution(input, target.selection, 2)
    assert.equal(distribution.counts.scored, 1, field)
    assert.equal(distribution.counts.invalid, 1, field)
    assert.equal(distribution.counts.uninitialized, 0)
    assert.equal(distribution.statistics.mean, 40)
    assert.match(distribution.errors.join(' '), /different target hash or source binding/)
  }
})

test('all 500 comparisons and repeated scores are represented without truncation or inferred identity merging', () => {
  const input = frozen(pairs(Array.from({ length: 500 }, (_, index) => index % 101)))
  const distribution = ui.calculateScoreDistribution(input, target.selection, 500)
  assert.equal(distribution.counts.scored, 500)
  assert.equal(binCounts(distribution).reduce((sum, count) => sum + count, 0), 500)
  assert.equal(distribution.markers.reduce((sum, marker) => sum + marker.count, 0), 500)
  assert.equal(distribution.statistics.mean, 49.52)
  const repeated = ui.calculateScoreDistribution(pairs(Array(500).fill(50)), target.selection, 500)
  assert.deepEqual(repeated.markers, [{ score: 50, count: 500 }])
  assert.equal(repeated.bins[5].count, 500)
})

test('pending corrections retain the saved result and a published replacement recomputes the distribution', () => {
  const input = [pair(0, { score: 45, correction: { status: 'running', policyVersion: 'full-reassessment-v1', requestedAt: summaryTimestamp } })]
  const before = ui.calculateScoreDistribution(frozen(input), target.selection, 1)
  assert.equal(before.statistics.mean, 45)
  assert.equal(before.counts.corrections, 1)
  const published = structuredClone(input)
  delete published[0].activeCorrection
  published[0].comparison.resultSummary.overall.score = 90
  const after = ui.calculateScoreDistribution(published, target.selection, 1)
  assert.equal(after.statistics.mean, 90)
  assert.equal(after.counts.corrections, 0)
  assert.equal(input[0].comparison.resultSummary.overall.score, 45)
})

test('an inconsistent frozen plan is disclosed rather than replaced with an invented count', () => {
  const distribution = ui.calculateScoreDistribution(pairs([20, 80]), target.selection, 1)
  assert.equal(distribution.planned, 1)
  assert.match(distribution.errors.join(' '), /exceed this target's frozen resume count/)
})

test('concept C renders the selected statistics, observed range, ten bins and accessible exact counts', () => {
  const { document, text } = render()
  assert.deepEqual(statistics(document), { Scored: '10 / 10', Mean: '56.2', Median: '59.0', Range: '12-88' })
  assert.equal(document.querySelectorAll('.score-distribution-bin').length, 10)
  assert.equal(document.querySelectorAll('.score-distribution-marker').length, 10)
  assert.match(text, /Middle half: 44-73/)
  assert.match(text, /Full target group; search and sorting below do not change it/)
  assert.match(text, /not a fitted curve, an anomaly test, or a hiring recommendation/)
  assert.equal(document.querySelector('details > summary').textContent, 'View score counts')
  assert.equal(document.querySelectorAll('[aria-label="Exact score counts"] dt').length, 10)
  assert.equal(document.querySelector('[aria-label="Scrollable exact score counts"]').tabIndex, 0)
})

test('multi-target selection, loading and failed reads cannot masquerade as an empty or zero-scored group', () => {
  const selection = render({ target: undefined })
  assert.match(selection.text, /Select one exact job or grade/)
  assert.equal(selection.document.querySelector('.score-distribution-statistics'), null)
  const loading = render({ comparisons: null })
  assert.equal(loading.document.querySelector('[role="status"]').textContent, 'Loading saved scores...')
  assert.equal(loading.document.querySelector('.score-distribution-histogram'), null)
  const failure = render({ comparisons: null, error: 'Score history is temporarily unavailable.' })
  assert.match(failure.document.querySelector('[role="alert"]').textContent, /Score history is temporarily unavailable.*Saved scores could not be loaded/)
  assert.equal(failure.document.querySelector('.score-distribution-statistics'), null)
  assert.equal(failure.document.querySelector('button').textContent, 'Reload scores')
})

test('withheld and unfinished groups show explicit counts without a fabricated curve or mean', () => {
  const { document, text } = render({ comparisons: [pair(0, { score: null }), pair(1, { status: 'queued' })], planned: 3 })
  assert.deepEqual(statistics(document), { Scored: '0 / 3', Mean: 'Not available', Median: 'Not available', Range: 'Not available' })
  assert.equal(document.querySelector('.score-distribution-histogram'), null)
  assert.match(text, /1 withheld.*1 queued.*1 not initialized/)
  assert.match(text, /No scores are invented while work is pending/)
})

test('an empty saved scope does not claim every comparison has a score', () => {
  const { document, text } = render({ comparisons: [], planned: 0 })
  assert.equal(statistics(document).Scored, '0 / 0')
  assert.match(text, /No available overall scores/)
  assert.doesNotMatch(text, /Every comparison.*available score/)
})

test('last loaded scores survive explicit refresh errors and invalid values are excluded with an alert', () => {
  const stale = render({ error: 'The comparison refresh failed.' })
  assert.equal(statistics(stale.document).Mean, '56.2')
  assert.match(stale.text, /last loaded scores are shown; the refresh could not be confirmed/)
  const invalid = render({ comparisons: pairs([20, Number.NaN]), planned: 2 })
  assert.equal(statistics(invalid.document).Scored, '1 / 2')
  assert.equal(statistics(invalid.document).Mean, '20.0')
  assert.match(invalid.document.querySelector('[role="alert"]').textContent, /invalid score or state/)
  assert.match(invalid.text, /Not charted: 1 invalid/)
})

test('single values render a point and large identical groups disclose every represented resume', () => {
  const single = render({ comparisons: pairs([100]), planned: 1 })
  assert.ok(single.document.querySelector('.score-distribution-middle-half.is-point'))
  assert.equal(single.document.querySelector('.score-distribution-marker-group').style.left, '100%')
  const many = render({ comparisons: pairs(Array(500).fill(0)), planned: 500 })
  assert.equal(statistics(many.document).Scored, '500 / 500')
  assert.equal(many.document.querySelector('.score-distribution-marker-count').textContent, '500')
  assert.equal(many.document.querySelector('[aria-label="Exact score counts"] dd').textContent, '500 resumes')
  assert.equal(many.document.querySelectorAll('.score-distribution-marker').length, 3)
})

test('saved labels are escaped text, never executable content', () => {
  const changed = { ...target, displayName: '<img src=x onerror=alert(1)>' }
  const { document, text } = render({ target: changed })
  assert.equal(document.querySelector('img'), null)
  assert.match(text, /<img src=x onerror=alert\(1\)>/)
})
