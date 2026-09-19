import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import { build } from 'esbuild'
import { loadReportFoundation, realReportBatchFixture, realReportFixture, reportFixtureCitation, REPORT_TEST_TIMESTAMP } from './test-support.mjs'

let api, cleanup
before(async () => { ({ api, cleanup } = await loadReportFoundation()) })
after(async () => { await cleanup?.() })

function sampleRun() { return api.createInitialWorkspace().runs[0] }
function sampleOptions() { return { generatedAt: REPORT_TEST_TIMESTAMP } }

test('sample report display names retain source names and leave all saved results unchanged', () => {
  const run = sampleRun()
  const original = structuredClone(run)
  run.displayName = 'Reviewer analysis title'
  run.targets[0].displayName = 'Reviewer target label'
  run.resumes[0].resume.displayName = 'Reviewer resume label'
  const report = api.buildSampleAnalysisReport(run, sampleOptions())
  assert.equal(report.run.name, run.displayName)
  const group = report.groups.find(item => item.target.id === run.targets[0].id)
  assert.equal(group.target.label, original.targets[0].label)
  assert.equal(api.targetName(group.target), 'Reviewer target label')
  const comparison = group.comparisons.find(item => item.candidate.id === run.resumes[0].resume.id)
  assert.equal(comparison.candidate.name, original.resumes[0].resume.name)
  assert.equal(api.candidateName(comparison.candidate), 'Reviewer resume label')
  const text = api.buildComparisonDetailBlocks(group.target, comparison).map(block => block.text).join('\n')
  assert.ok(text.includes(`Source-stated name: ${original.resumes[0].resume.name}`))
  assert.ok(text.includes(`Source target title: ${original.targets[0].label}`))
  assert.deepEqual(run.comparisons, original.comparisons)
  assert.deepEqual(comparison.criteria.map(item => item.score),
    original.comparisons.find(item => item.id === comparison.id).criteria.map(item => item.score))
})

test('invalid display metadata produces structured validation failures rather than escaping safeParse', () => {
  const input = realReportFixture({ scores: [80] })
  for (const displayName of [null, 42, '', '  ', ' surrounded ', 'line\nbreak', 'line\u2028break', 'control\u0001', 'x'.repeat(161), '😀'.repeat(81)]) {
    const target = api.reportTargetSchema.safeParse({ ...input.targets[0], displayName })
    assert.equal(target.success, false)
    assert.equal(target.error.issues[0].path[0], 'displayName')
    const comparison = api.reportComparisonSchema.safeParse({
      ...input.comparisons[0], candidate: { ...input.comparisons[0].candidate, displayName },
    })
    assert.equal(comparison.success, false)
    assert.deepEqual(comparison.error.issues[0].path, ['candidate', 'displayName'])
  }
  assert.equal(api.reportDisplayNameSchema.safeParse('x'.repeat(160)).success, true)
  assert.equal(api.reportDisplayNameSchema.safeParse('😀'.repeat(80)).success, true)
})

test('format metadata and resource limits are shared by all report consumers', () => {
  assert.equal(api.ANALYSIS_REPORT_SCHEMA_VERSION, 1)
  assert.deepEqual(Object.keys(api.REPORT_FORMATS), ['csv', 'pdf', 'docx', 'pptx'])
  assert.equal(api.REPORT_FORMATS.pdf.mimeType, 'application/pdf')
  assert.equal(api.REPORT_FORMATS.docx.extension, 'docx')
  assert.match(api.REPORT_FORMATS.pptx.mimeType, /presentationml/)
  assert.equal(api.REPORT_LIMITS.maxComparisons, 500)
  assert.equal(api.REPORT_LIMITS.batchComparisons, 25)
  for (const key of ['maxInputBytes', 'maxBatchBytes', 'maxOutputBytes', 'maxGenerationMilliseconds', 'maxPages', 'maxSlides']) {
    assert.ok(Number.isFinite(api.REPORT_LIMITS[key]) && api.REPORT_LIMITS[key] > 0)
  }
})

test('exact targets and versions stay separate despite identical target and criterion labels', () => {
  const input = realReportFixture({ scores: [90, 80, 80], targetCount: 2 })
  input.comparisons[1].overall.score = 10
  input.comparisons[3].overall.score = 95
  input.comparisons[5].overall.score = 50
  const report = api.buildAnalysisReport(input)
  assert.equal(report.groups.length, 2)
  assert.equal(report.candidateCount, 3)
  assert.equal(report.counts.total, 6)
  assert.equal(report.groups[0].target.label, report.groups[1].target.label)
  assert.notEqual(report.groups[0].target.rubricId, report.groups[1].target.rubricId)
  assert.deepEqual(report.groups[0].comparisons.map(item => [item.id, item.rank]), [
    ['comparison-0', 1], ['comparison-2', 2], ['comparison-4', 2],
  ])
  assert.deepEqual(report.groups[1].comparisons.map(item => [item.id, item.rank]), [
    ['comparison-3', 1], ['comparison-5', 2], ['comparison-1', 3],
  ])
  assert.equal(report.groups[1].target.rubricVersion, 2)
  assert.equal(new Set(report.groups.flatMap(group => group.comparisons.map(item => item.id))).size, 6)
})

test('ranking is competition ranking and fifth-place ties expand highlights', () => {
  const report = api.buildAnalysisReport(realReportFixture({ scores: [98, 95, 95, 90, 80, 80, 79] }))
  const group = report.groups[0]
  assert.deepEqual(group.comparisons.map(item => item.rank), [1, 2, 2, 4, 5, 5, 7])
  assert.deepEqual(group.highlightedComparisonIds, ['comparison-0', 'comparison-1', 'comparison-2', 'comparison-3', 'comparison-4', 'comparison-5'])
  assert.equal(group.cutoffScore, 80)
  assert.equal(group.additionalCutoffTies, 0)
})

test('capped ties disclose every additional tied candidate and keep all detail entries', () => {
  const report = api.buildAnalysisReport(realReportFixture({ scores: [100, 99, 98, 97, ...Array(12).fill(80), 70] }))
  const group = report.groups[0]
  assert.equal(group.highlightedComparisonIds.length, 10)
  assert.equal(group.additionalCutoffTies, 6)
  assert.equal(group.cutoffScore, 80)
  assert.equal(group.comparisons.length, 17)
  assert.deepEqual(group.comparisons.slice(4, 16).map(item => item.rank), Array(12).fill(5))
  assert.match(api.highlightNotice(group), /6 additional candidates tied at 80/)
  assert.match(api.highlightNotice(group), /not an evidence advantage/)
})

test('original indexes determine display order within ties, never input transport order', () => {
  const input = realReportFixture({ scores: [80, 80, 80, 80, 80, 80] })
  input.comparisons.reverse()
  const group = api.buildAnalysisReport(input).groups[0]
  assert.deepEqual(group.comparisons.map(item => item.index), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(group.comparisons.map(item => item.rank), [1, 1, 1, 1, 1, 1])
})

test('numeric zero remains available, ranked, and highlighted; fewer than five is valid', () => {
  const report = api.buildAnalysisReport(realReportFixture({ scores: [0] }))
  const group = report.groups[0]
  assert.equal(group.comparisons[0].overall.score, 0)
  assert.equal(group.comparisons[0].rank, 1)
  assert.equal(group.comparisons[0].highlighted, true)
  assert.equal(group.cutoffScore, 0)
  assert.equal(report.counts.scored, 1)
  assert.equal(api.overallScoreLabel(group.comparisons[0].overall), '0 / 100')
  const tied = api.buildAnalysisReport(realReportFixture({ scores: Array(15).fill(0) })).groups[0]
  assert.equal(tied.additionalCutoffTies, 5)
})

test('complete withheld results remain exportable and never get invented scores or highlights', () => {
  const report = api.buildAnalysisReport(realReportFixture({ scores: [null, null] }))
  const group = report.groups[0]
  assert.equal(report.partial, false)
  assert.equal(report.counts.complete, 2)
  assert.equal(report.counts.scored, 0)
  assert.equal(report.counts.withheld, 2)
  assert.deepEqual(group.highlightedComparisonIds, [])
  assert.equal(group.cutoffScore, null)
  assert.equal(group.additionalCutoffTies, 0)
  assert.ok(group.comparisons.every(item => item.rank === null && item.overall.score === null))
  assert.match(api.highlightNotice(group), /No scored highlights/)
})

test('partial exports preserve queued, running, failed, and cancelled states without assessments', () => {
  const input = realReportFixture({ scores: [null, 10, 20, 30, 40], statuses: ['complete', 'queued', 'running', 'failed', 'cancelled'] })
  const report = api.buildAnalysisReport(input)
  assert.equal(report.partial, true)
  assert.deepEqual(report.counts, { total: 5, queued: 1, running: 1, complete: 1, failed: 1, cancelled: 1, scored: 0, withheld: 1 })
  assert.ok(report.notices.some(notice => notice.startsWith('Partial report:')))
  for (const comparison of report.groups[0].comparisons.slice(1)) {
    assert.equal(comparison.overall.status, 'unavailable')
    assert.equal(comparison.overall.score, null)
    assert.equal(comparison.completion, null)
    assert.equal(comparison.summary, null)
    assert.deepEqual(comparison.criteria, [])
    assert.equal(comparison.resultSha256, null)
    assert.equal(comparison.rank, null)
  }
  assert.equal(report.groups[0].comparisons[3].error.message, 'Saved source could not be read.')
})

test('scopes are exact IDs and a scope without completed comparisons cannot generate a report', () => {
  const input = realReportFixture({ targetCount: 2 })
  const report = api.buildAnalysisReport(input, { targetId: 'target-1' })
  assert.deepEqual(report.scope, { targetId: 'target-1' })
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].target.id, 'target-1')
  assert.equal(report.counts.total, 3)
  assert.throws(() => api.buildAnalysisReport(input, { targetId: input.targets[0].label }), /exact target/)
  const unfinished = realReportFixture({ scores: [10, 20], statuses: ['queued', 'running'] })
  assert.throws(() => api.buildAnalysisReport(unfinished), /At least one comparison/)
  input.comparisons.filter(item => item.targetId === 'target-1').forEach(item => Object.assign(item, {
    status: 'queued', completion: null, overall: api.unavailableOverallScore('queued'), summary: null, coverage: null,
    criteria: [], qualifications: [], limitations: [], analyzedAt: null, resultSha256: null,
  }))
  assert.throws(() => api.buildAnalysisReport(input, { targetId: 'target-1' }), /At least one comparison/)
})

test('zero, missing, unassessed, excluded, and separate unscored GS qualifications remain distinct', () => {
  const input = realReportFixture({ scores: [null], criterionCount: 5, kind: 'grade' })
  const comparison = input.comparisons[0]
  const weights = [30, 20, 40, 10, 0]
  const states = ['supported', 'partial', 'missing', 'not-assessed', 'not-applicable']
  comparison.criteria.forEach((assessment, index) => {
    input.targets[0].criteria[index].weight = weights[index]
    Object.assign(assessment, {
      weight: weights[index], evidenceStatus: states[index], score: [3, 2, 0, null, null][index],
      citations: index < 2 ? [reportFixtureCitation(comparison.candidate.documentId)] : [],
      limitation: index === 3 ? { code: 'not-assessable', message: 'Saved limitation', criterionId: assessment.criterionId } : null,
    })
  })
  comparison.coverage = { totalCriteria: 5, supported: 1, partial: 1, missing: 1, notAssessed: 1, notApplicable: 1, assessedWeight: 90, totalWeight: 100 }
  comparison.qualifications = [{
    qualificationId: 'qualification-one', text: 'Qualification wording', interpretation: 'Separate qualified human review.',
    support: 'direct', evidenceStatus: 'partial', rationale: 'Saved qualification assessment.',
    citations: [reportFixtureCitation(comparison.candidate.documentId)],
    requirementCitations: [reportFixtureCitation('qualification-source', { page: 178, pagination: 'pdf-pages' })], limitation: null,
  }]
  const report = api.buildAnalysisReport(input)
  const saved = report.groups[0].comparisons[0]
  assert.deepEqual(saved.criteria.map(item => item.score), [3, 2, 0, null, null])
  assert.deepEqual(saved.criteria.map(item => item.evidenceStatus), states)
  assert.equal(saved.qualifications[0].text, 'Qualification wording')
  assert.ok(!Object.hasOwn(saved.qualifications[0], 'score'))
  assert.equal(api.criterionScoreLabel(saved.criteria[2]), '0 / 5')
  assert.match(api.criterionScoreLabel(saved.criteria[3]), /Not assessed/)
  assert.match(api.criterionScoreLabel(saved.criteria[4]), /Not applicable/)
  const blocks = api.buildComparisonDetailBlocks(report.groups[0].target, saved)
  assert.ok(blocks.some(block => /separate, unscored human review/.test(block.text)))
  assert.ok(blocks.some(block => block.text.includes(saved.criteria[0].citations[0].quote)))
  assert.ok(blocks.some(block => block.text.includes(report.groups[0].target.criteria[0].guidance)))
  const poisoned = structuredClone(input)
  poisoned.comparisons[0].qualifications[0].score = 5
  assert.throws(() => api.buildAnalysisReport(poisoned))
})

test('saved numbers, wording, citations, and provenance are cloned rather than rescored or mutated', () => {
  const input = realReportFixture({ scores: [92.75] })
  const before = JSON.stringify(input)
  const report = api.buildAnalysisReport(input)
  assert.equal(report.groups[0].comparisons[0].overall.score, 92.75)
  assert.equal(report.groups[0].comparisons[0].criteria[0].score, 3)
  assert.deepEqual(report.groups[0].comparisons[0].provenance, input.comparisons[0].provenance)
  assert.deepEqual(report.groups[0].comparisons[0].criteria[0].citations, input.comparisons[0].criteria[0].citations)
  assert.equal(JSON.stringify(input), before)
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
  report.groups[0].target.criteria[0].guidance = 'Changed report copy'
  report.groups[0].comparisons[0].criteria[0].citations[0].quote = 'Changed report copy'
  assert.equal(JSON.stringify(input), before)
})

test('malformed collections, identities, finite numbers, and assessment bindings fail closed', () => {
  const mutations = [
    input => { input.targets.push(structuredClone(input.targets[0])) },
    input => { input.targets[0].criteria[1].id = input.targets[0].criteria[0].id },
    input => { input.comparisons[1].id = input.comparisons[0].id },
    input => { input.comparisons[1].index = input.comparisons[0].index },
    input => { input.comparisons[1].candidate = structuredClone(input.comparisons[0].candidate) },
    input => { input.comparisons[0].targetId = 'missing-target' },
    input => { input.comparisons[0].candidate.snapshot = null },
    input => { input.comparisons[0].candidate.documentSha256 = 'not-a-hash' },
    input => { input.comparisons[0].resultSha256 = null },
    input => { input.comparisons[0].overall.score = Infinity },
    input => { input.comparisons[0].overall.score = NaN },
    input => { input.comparisons[0].overall.score = 101 },
    input => { input.comparisons[0].overall.score = -1 },
    input => { input.comparisons[0].overall.score = null },
    input => { input.comparisons[0].criteria[0].score = 6 },
    input => { input.comparisons[0].criteria[0].score = 2.5 },
    input => { input.comparisons[0].criteria[0].weight = 1 },
    input => { input.targets[0].criteria[0].weight = NaN },
    input => { input.comparisons[0].criteria[0].citations = [] },
    input => { input.comparisons[0].criteria[0].evidenceStatus = 'missing' },
    input => { input.comparisons[0].criteria.pop() },
    input => { input.comparisons[0].criteria[1].criterionId = input.comparisons[0].criteria[0].criterionId },
    input => { input.comparisons[0].coverage.supported = 0 },
    input => { input.comparisons[0].coverage.assessedWeight = 0 },
    input => { input.comparisons[0].status = 'queued' },
    input => { input.targets[0].selection.rubricVersion = 9 },
    input => { input.workspaceId = undefined },
    input => { input.run.id = '  ' },
    input => { input.generatedAt = 'not-a-time' },
    input => { input.capture.startedAt = '2026-09-19T18:00:00.000Z' },
    input => { input.generatedAt = '2026-09-17T18:00:00.000Z' },
    input => { input.targets[0].document = { paragraphs: ['not part of compact report data'] } },
  ]
  for (const mutate of mutations) {
    const input = realReportFixture()
    mutate(input)
    assert.throws(() => api.buildAnalysisReport(input), `Mutation unexpectedly accepted: ${mutate}`)
  }
  const unassessed = realReportFixture({ scores: [null] })
  unassessed.comparisons[0].overall = { status: 'available', score: 99 }
  assert.throws(() => api.buildAnalysisReport(unassessed), /available overall score/)
  const wrongCompletion = realReportFixture({ scores: [null] })
  wrongCompletion.comparisons[0].completion = 'assessed'
  assert.throws(() => api.buildAnalysisReport(wrongCompletion), /completion state/)
})

test('citations retain exact quotations and distinguish printed PDF pages from captured sections', () => {
  for (const [pagination, designation] of [
    ['pdf-pages', 'PDF page 178'], ['html-sections', 'Captured HTML section 178'],
    ['markdown-sections', 'Markdown section 178'], ['captured-sections', 'Captured source section 178 (not a printed page)'],
  ]) {
    const raw = { documentId: 'source-doc', documentVersion: 7, paragraphId: 'passage-id', page: 178, heading: 'Saved heading', quote: 'Exact “résumé” quote.\nSecond line.' }
    const citation = api.createReportCitation(raw, { id: 'source-doc', version: 7, title: 'Immutable source.docx', pagination })
    assert.equal(citation.quote, raw.quote)
    assert.ok(citation.locator.includes(designation))
    assert.match(citation.locator, /source-doc · version 7/)
    assert.match(citation.locator, /paragraph passage-id/)
    if (pagination !== 'pdf-pages') assert.ok(!citation.locator.includes('PDF page'))
  }
  const input = realReportFixture()
  const citation = input.comparisons[0].criteria[0].citations[0]
  assert.throws(() => api.createReportCitation(citation, { id: 'wrong', version: 2, title: 'Source', pagination: 'pdf-pages' }), /does not match/)
  for (const mutate of [
    value => { value.quote = '   ' },
    value => { value.page = 0 },
    value => { value.page = Infinity },
    value => { value.locator = 'Printed page 3' },
    value => { value.pagination = 'pdf-pages' },
    value => { value.documentVersion = 99 },
  ]) {
    const copy = structuredClone(input)
    mutate(copy.comparisons[0].criteria[0].citations[0])
    assert.throws(() => api.buildAnalysisReport(copy))
  }
  const mismatched = structuredClone(input)
  mismatched.comparisons[0].criteria[0].citations[0] = reportFixtureCitation('foreign-resume')
  assert.throws(() => api.buildAnalysisReport(mismatched), /candidate document/)
  const wrongRequirement = structuredClone(input)
  wrongRequirement.comparisons[0].criteria[0].requirementCitations[0] = reportFixtureCitation('foreign-job')
  assert.throws(() => api.buildAnalysisReport(wrongRequirement), /job document/)
})

test('strict real batch parsing enforces identity, schema version, bounded batches, and real-only data', () => {
  const response = realReportBatchFixture()
  assert.deepEqual(api.parseRealReportBatchResponse(response), response)
  assert.equal(api.realReportBatchResponseSchema.safeParse(response).success, true)
  for (const mutate of [
    value => { value.dataKind = 'sample' },
    value => { value.schemaVersion = 2 },
    value => { value.workspaceId = '' },
    value => { value.runId = ' ' },
    value => { value.targets[0].dataKind = 'sample' },
    value => { value.targets[0].snapshot = null },
    value => { value.comparisons[0].dataKind = 'sample' },
    value => { value.comparisons[0].overall.score = NaN },
    value => { value.comparisons[0].criteria[0].sourceDocument = { paragraphs: ['private original'] } },
    value => { value.comparisons[0].candidate.sample = true },
  ]) {
    const copy = structuredClone(response)
    mutate(copy)
    assert.throws(() => api.parseRealReportBatchResponse(copy))
    assert.equal(api.realReportBatchResponseSchema.safeParse(copy).success, false)
  }
  assert.throws(() => api.parseRealReportBatchResponse(realReportBatchFixture(realReportFixture({ scores: Array(26).fill(90) }))))
  const maximum = realReportBatchFixture(realReportFixture({ scores: Array(25).fill(90) }))
  assert.equal(api.parseRealReportBatchResponse(maximum).comparisons.length, 25)
  const queued = realReportBatchFixture(realReportFixture({ scores: [0], statuses: ['queued'] }))
  assert.equal(api.parseRealReportBatchResponse(queued).comparisons[0].status, 'queued')
})

test('sample reports read frozen snapshots, preserve saved totals, and never synthesize GS qualifications', () => {
  const workspace = api.createInitialWorkspace()
  const run = workspace.runs[0]
  const before = JSON.stringify(run)
  const report = api.buildSampleAnalysisReport(run, sampleOptions())
  assert.equal(report.dataKind, 'sample')
  assert.equal(report.workspaceId, undefined)
  assert.equal(report.counts.total, run.comparisons.length)
  assert.ok(report.notices.includes(api.REPORT_SAMPLE_NOTICE))
  assert.ok(report.notices.includes(api.REPORT_HUMAN_REVIEW_NOTICE))
  assert.deepEqual(report.capture, { startedAt: REPORT_TEST_TIMESTAMP, completedAt: REPORT_TEST_TIMESTAMP })
  assert.equal(report.generatedAt, REPORT_TEST_TIMESTAMP)
  for (const group of report.groups) {
    assert.equal(group.target.selection, null)
    for (const comparison of group.comparisons) {
      const original = run.comparisons.find(item => item.id === comparison.id)
      assert.equal(comparison.overall.score, original.score)
      assert.equal(comparison.summary, original.summary)
      assert.deepEqual(comparison.qualifications, [])
      assert.equal(comparison.coverage, null)
      assert.equal(comparison.analyzedAt, null)
      assert.equal(comparison.candidate.snapshot, null)
      assert.equal(comparison.resultSha256, null)
    }
  }
  assert.equal(JSON.stringify(run), before)
  for (const rubric of workspace.rubrics) rubric.criteria[0].guidance = 'Changed live rubric, not frozen.'
  for (const document of workspace.documents) document.paragraphs[0].text = 'Changed live document, not frozen.'
  assert.deepEqual(api.buildSampleAnalysisReport(run, sampleOptions()), report)
  const changed = structuredClone(run)
  changed.comparisons[0].score = 0
  const zero = api.buildSampleAnalysisReport(changed, sampleOptions())
  const savedZero = zero.groups.flatMap(group => group.comparisons).find(item => item.id === changed.comparisons[0].id)
  assert.equal(savedZero.overall.score, 0)
  assert.equal(savedZero.overall.status, 'available')
  changed.comparisons[0].score = null
  const withheld = api.buildSampleAnalysisReport(changed, sampleOptions()).groups.flatMap(group => group.comparisons).find(item => item.id === changed.comparisons[0].id)
  assert.equal(withheld.overall.status, 'withheld')
  assert.equal(withheld.overall.score, null)
})

test('sample exact scope, saved guidance, requirement citations, unassessed criteria, and partial statuses are retained', () => {
  const run = sampleRun()
  const targetId = run.targets[0].id
  const comparison = run.comparisons.find(item => item.targetId === targetId)
  const assessment = comparison.criteria[0]
  Object.assign(assessment, { score: null, evidenceStatus: 'not-assessed', citations: [], rationale: 'Saved custom-criterion limitation.' })
  comparison.score = null
  const other = run.comparisons.find(item => item.targetId === targetId && item.id !== comparison.id)
  Object.assign(other, { status: 'failed', score: null, criteria: [], summary: 'Raw processing status, not an assessment.', error: 'Saved sample processing failure.' })
  const report = api.buildSampleAnalysisReport(run, { ...sampleOptions(), targetId })
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].target.id, targetId)
  assert.equal(report.partial, true)
  const complete = report.groups[0].comparisons.find(item => item.status === 'complete')
  assert.equal(complete.completion, 'limited')
  assert.equal(complete.criteria[0].rationale, assessment.rationale)
  assert.equal(report.groups[0].target.criteria[0].guidance, run.targets[0].rubric.criteria[0].guidance)
  const failed = report.groups[0].comparisons.find(item => item.status === 'failed')
  assert.equal(failed.summary, null)
  assert.deepEqual(failed.criteria, [])
  assert.equal(failed.error.message, 'Saved sample processing failure.')
  if (run.targets[0].kind === 'job') assert.ok(complete.criteria[0].requirementCitations.length > 0)
})

test('sample adapters reject real/mixed data, missing snapshots, duplicates, and incomplete inventories', () => {
  const mutations = [
    run => { run.dataKind = 'real' },
    run => { run.targets[0].rubric.dataKind = 'real' },
    run => { run.targets[0].rubric.provenance = { kind: 'generated', model: 'real-model', promptVersion: 'v1' } },
    run => { run.resumes[0].resume.sample = false },
    run => { run.resumes[0].document.sample = false },
    run => { run.resumes[0].resume.documentId = 'missing-document' },
    run => { run.resumes[0].document = undefined },
    run => { run.resumes.push(structuredClone(run.resumes[0])) },
    run => { run.comparisons.pop() },
    run => { run.comparisons[1].id = run.comparisons[0].id },
    run => { Object.assign(run.comparisons[1], { resumeId: run.comparisons[0].resumeId, targetId: run.comparisons[0].targetId }) },
    run => { run.comparisons[0].resumeId = 'missing-resume' },
    run => { run.comparisons[0].targetId = 'missing-target' },
    run => { run.comparisons[0].score = Infinity },
    run => { run.comparisons[0].score = 101 },
    run => { run.comparisons[0].criteria[0].score = -1 },
    run => { run.comparisons[0].criteria[0].score = NaN },
    run => { run.comparisons[0].criteria[1].criterionId = run.comparisons[0].criteria[0].criterionId },
    run => { run.targets[0].rubric.criteria[1].id = run.targets[0].rubric.criteria[0].id },
    run => { run.comparisons[0].status = 'queued' },
    run => { run.comparisons[0].qualifications = [] },
  ]
  for (const mutate of mutations) {
    const run = sampleRun()
    mutate(run)
    assert.throws(() => api.buildSampleAnalysisReport(run, sampleOptions()), `Mutation unexpectedly accepted: ${mutate}`)
  }
})

test('sample citations are verified against exact saved text, headings, positions, IDs, and versions', () => {
  const run = sampleRun()
  const entry = run.comparisons.find(item => item.criteria.some(criterion => criterion.citations.length))
  const assessment = entry.criteria.find(item => item.citations.length)
  const original = assessment.citations[0]
  for (const mutate of [
    citation => { citation.quote = 'Fabricated evidence not present in the source.' },
    citation => { citation.quote = '' },
    citation => { citation.page += 1 },
    citation => { citation.heading = 'Another heading' },
    citation => { citation.paragraphId = 'missing-paragraph' },
    citation => { citation.documentId = 'other-document' },
    citation => { citation.documentVersion += 1 },
  ]) {
    const copy = structuredClone(run)
    mutate(copy.comparisons.find(item => item.id === entry.id).criteria.find(item => item.criterionId === assessment.criterionId).citations[0])
    assert.throws(() => api.buildSampleAnalysisReport(copy, sampleOptions()))
  }
  const excerpt = original.quote.slice(0, 24)
  assessment.citations[0].quote = excerpt
  const report = api.buildSampleAnalysisReport(run, sampleOptions())
  const saved = report.groups.flatMap(group => group.comparisons).find(item => item.id === entry.id)
  assert.equal(saved.criteria.find(item => item.criterionId === assessment.criterionId).citations[0].quote, excerpt)
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes('"paragraphs":'))
  assert.ok(!serialized.includes('This document is entirely synthetic and was written for the Score UI demonstration.'))
})

test('sample illustrative grade reports do not invent official qualification evidence', () => {
  const workspace = api.createFixtureWorkspace()
  const grade = workspace.rubrics.find(rubric => rubric.kind === 'grade')
  const run = api.snapshotAnalysisRun(workspace, [workspace.resumes[0].id], [grade.id], 'Illustrative grade run', {
    id: 'sample-grade-run', createdAt: REPORT_TEST_TIMESTAMP, comparisonId: () => 'sample-grade-comparison',
  })
  run.comparisons = run.comparisons.map(item => api.evaluateComparison(run, item.id))
  const report = api.buildSampleAnalysisReport(run, sampleOptions())
  assert.equal(report.groups[0].target.kind, 'grade')
  assert.deepEqual(report.groups[0].comparisons[0].qualifications, [])
  assert.ok(report.groups[0].comparisons[0].criteria.every(item => item.requirementCitations.length === 0))
})

test('full 500-comparison reports are valid and 501 comparisons cannot be silently truncated', () => {
  const input = realReportFixture({ scores: Array.from({ length: 500 }, (_, index) => index % 101) })
  const report = api.buildAnalysisReport(input)
  assert.equal(report.counts.total, 500)
  assert.equal(report.candidateCount, 500)
  assert.equal(report.groups[0].comparisons.length, 500)
  assert.equal(new Set(report.groups[0].comparisons.map(item => item.id)).size, 500)
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
  assert.throws(() => api.buildAnalysisReport(realReportFixture({ scores: Array(501).fill(90) })))
})

test('resource bounds account for UTF-8, reject oversized batches, and explain scope narrowing', () => {
  assert.throws(() => api.assertReportResourceLimits({ text: 'é'.repeat(10) }, 25), /Narrow the export/)
  const circular = {}; circular.self = circular
  assert.throws(() => api.assertReportResourceLimits(circular), /JSON-serializable/)
  const response = realReportBatchFixture(realReportFixture({ scores: Array(25).fill(90) }))
  for (const comparison of response.comparisons) {
    comparison.summary = 'x'.repeat(api.REPORT_LIMITS.maxTextCharacters)
    for (const criterion of comparison.criteria) {
      criterion.rationale = 'x'.repeat(api.REPORT_LIMITS.maxTextCharacters)
      criterion.citations[0].quote = 'x'.repeat(api.REPORT_LIMITS.maxTextCharacters)
    }
  }
  assert.throws(() => api.parseRealReportBatchResponse(response), /resource limit.*Narrow/)
  const parsed = api.realReportBatchResponseSchema.safeParse(response)
  assert.equal(parsed.success, false)
  assert.ok(parsed.error.issues.some(issue => issue.message.includes('Narrow the export')))
})

test('presentation exposes full details but explicitly labels shortened executive-summary excerpts', () => {
  const summary = 'Résumé Ω 😀 saved full assessment. '.repeat(30)
  const excerpt = api.summaryExcerpt(summary, 60)
  assert.equal(excerpt.shortened, true)
  assert.match(excerpt.text, /… \[excerpt\]$/)
  assert.ok(Array.from(excerpt.text).length <= 60)
  assert.deepEqual(api.summaryExcerpt('Full short summary.'), { text: 'Full short summary.', shortened: false })
  assert.throws(() => api.summaryExcerpt(summary, 10))
  const input = realReportFixture({ scores: [90] })
  input.comparisons[0].summary = summary
  const report = api.buildAnalysisReport(input)
  const blocks = api.buildComparisonDetailBlocks(report.groups[0].target, report.groups[0].comparisons[0])
  assert.ok(blocks.some(block => block.text === summary))
  assert.ok(blocks.some(block => block.text.includes(input.comparisons[0].resultSha256)))
  assert.match(api.reportTitle(report), /Analysis evidence report/)
})

test('XML text validation rejects illegal controls and unpaired surrogates without altering legal text', () => {
  const valid = 'Café <evidence> & "quoted"\n\tRésumé Ω Кириллица 😀\r'
  assert.doesNotThrow(() => api.assertXmlText(valid))
  for (const invalid of ['\u0000', '\u001f', '\ud800', '\udfff', '\ufffe', '\uffff']) {
    assert.throws(() => api.assertXmlText(`Saved ${invalid} evidence`), /XML-invalid character/)
  }
  const report = api.buildAnalysisReport(realReportFixture())
  assert.doesNotThrow(() => api.assertReportXmlText(report))
  report.groups[0].comparisons[0].criteria[0].citations[0].quote = 'Bad \u0000 evidence'
  assert.throws(() => api.assertReportXmlText(report), /XML-invalid character/)
})

test('safe filenames remove Windows hazards while retaining usable Unicode names', () => {
  assert.equal(api.safeReportFilename('CON', 'pdf'), 'Report CON.pdf')
  assert.equal(api.safeReportFilename('NUL.hidden', 'docx'), 'Report NUL.hidden.docx')
  assert.equal(api.safeReportFilename(' . ', 'csv'), 'Analysis report.csv')
  const name = api.safeReportFilename('  Café: Résumé / comparison? <report> \u0000 ', 'pptx')
  assert.match(name, /^Café- Résumé/)
  assert.match(name, /\.pptx$/)
  assert.ok(!/[<>:"/\\|?*]/.test(name))
  assert.ok(name.length < 128)
})

test('licensed local Noto Sans regular and bold fonts expose usable, explicit glyph coverage', async () => {
  const root = resolve('src', 'assets', 'report-fonts')
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  for (const name of ['Regular', 'Bold']) {
    const bytes = await readFile(resolve(root, `NotoSans-${name}.ttf`))
    const font = fontkit.create(bytes)
    assert.equal(font.familyName, 'Noto Sans')
    assert.match(font.copyright, /Google LLC/)
    for (const character of 'AéïΩЖ—') assert.ok(font.characterSet.includes(character.codePointAt(0)), `${name} missing ${character}`)
    assert.ok(!font.characterSet.includes('漢'.codePointAt(0)), 'Writers need an explicit unsupported-glyph failure path.')
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    assert.ok(arrayBuffer instanceof ArrayBuffer)
    assert.equal(arrayBuffer.byteLength, bytes.byteLength)
    const embedded = await document.embedFont(arrayBuffer, { subset: true })
    document.addPage().drawText('Résumé café Ω Кириллица —', { font: embedded, size: 12 })
  }
  const pdf = await document.save()
  assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), '%PDF-')
  assert.match(await readFile(resolve(root, 'LICENSE-OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE Version 1.1/)
  assert.match(await readFile(resolve(root, 'ATTRIBUTION.txt'), 'utf8'), /ffebf8c1ee449e544955a7e813c54f9b73848eac/)
})

test('shared foundation bundles for the browser without Node-specific dependencies', async () => {
  const output = await build({
    entryPoints: ['model', 'sample', 'presentation'].map(name => resolve('src', 'services', 'analysisReports', `${name}.ts`)),
    bundle: true, platform: 'browser', format: 'esm', outdir: 'unused-in-memory-report-bundle', write: false, logLevel: 'silent',
  })
  assert.equal(output.outputFiles.length, 3)
  assert.ok(output.outputFiles.every(file => file.contents.byteLength > 0))
})
