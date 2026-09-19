import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { loadReportFoundation, realReportFixture } from './test-support.mjs'

let foundation, api
before(async () => { foundation = await loadReportFoundation(); api = foundation.api })
after(async () => { await foundation?.cleanup() })

function evidenceFixture() {
  const input = realReportFixture({ scores: [85], criterionCount: 4 })
  const labels = ['Survey design', 'Statistical analysis', 'Project delivery', 'Team leadership']
  const weights = [40, 25, 20, 15]
  const scores = [5, 4, 4, 3]
  const rationales = [
    'Designed a national survey with a documented sampling plan.',
    'Used R to analyze survey data and explain uncertainty.',
    'Delivered three survey projects within the agreed schedule.',
    'The resume gives few examples of leading a team.',
  ]
  input.targets[0].label = 'Survey statistician'
  input.targets[0].criteria.forEach((criterion, index) => {
    criterion.label = labels[index]
    criterion.weight = weights[index]
    Object.assign(input.comparisons[0].criteria[index], { score: scores[index], weight: weights[index], rationale: rationales[index] })
  })
  input.comparisons[0].summary = 'Full saved overall assessment. The resume shows survey design and statistical analysis experience. Human review is required.'
  return api.buildAnalysisReport(input)
}

test('readable assessments explain saved scores using actual evidence instead of boilerplate', () => {
  const report = evidenceFixture()
  const { target, comparisons: [comparison] } = report.groups[0]
  const before = JSON.stringify(report)
  const summary = api.assessmentSummary(target, comparison)
  const highlights = api.assessmentHighlights(target, comparison)
  assert.match(summary, /survey design and statistical analysis experience/)
  assert.match(summary, /national survey/)
  assert.match(highlights, /national survey/)
  assert.match(highlights, /Team leadership/)
  assert.ok(!/Full saved overall assessment|Human review is required|saved assessment excerpt/.test(`${summary} ${highlights}`))
  assert.ok(summary.length <= 460)
  assert.ok(highlights.length <= 240)
  assert.equal(JSON.stringify(report), before)
})

test('real saved processing summaries are replaced with specific candidate evidence', () => {
  const report = evidenceFixture()
  const { target, comparisons: [comparison] } = report.groups[0]
  comparison.summary = [
    'The submitted document was compared only with this exact saved rubric.',
    'Criterion evidence: 4 supported, 0 partial, 0 missing, 0 not assessed, and 0 excluded.',
    'The document evidence-match total is 85/100.',
    'The 2 qualification notes are separate, unscored, and require human review.',
    'Missing evidence does not establish that a person lacks ability.',
    'This is a human-review aid, not a hiring recommendation or an official GS eligibility decision.',
  ].join(' ')
  const original = JSON.stringify(report)
  assert.equal(api.assessmentIntroduction(comparison), null)
  for (const text of [api.assessmentSummary(target, comparison), api.assessmentHighlights(target, comparison)]) {
    assert.doesNotMatch(text, /compared only|Criterion evidence|evidence-match total|qualification notes are separate|lacks ability|human-review aid/)
    assert.match(text, /national survey/)
    assert.match(text, /few examples of leading a team/)
  }
  assert.equal(JSON.stringify(report), original)
})

test('an introduction keeps the saved narrative and cautions without repeating criterion highlights', () => {
  const report = evidenceFixture()
  const comparison = report.groups[0].comparisons[0]
  comparison.limitations = [{ code: 'dates-missing', message: 'Dates for the research role need confirmation.' }]
  const introduction = api.assessmentIntroduction(comparison)
  assert.match(introduction, /survey design and statistical analysis experience/)
  assert.match(introduction, /Dates for the research role need confirmation/)
  assert.doesNotMatch(introduction, /national survey|few examples of leading a team|Full saved/)
  assert.ok(introduction.length <= 320)
})

test('key criteria balance important strengths and gaps and preserve criterion numbering', () => {
  const report = evidenceFixture()
  const group = report.groups[0]
  const comparison = group.comparisons[0]
  comparison.criteria[1].score = 0
  comparison.criteria[1].evidenceStatus = 'missing'
  comparison.criteria[1].rationale = 'No examples of statistical analysis were found in the resume.'
  const all = api.criterionReviews(group.target, comparison)
  const chosen = api.selectKeyCriteria(all, 2)
  assert.deepEqual(chosen.map(criterion => criterion.number), [1, 2])
  assert.equal(chosen[1].scoreLabel, '0 / 5')
  assert.match(api.assessmentHighlights(group.target, comparison), /No examples/)
  assert.deepEqual(api.selectKeyCriteria(all, 0), [])
  assert.deepEqual(api.selectKeyCriteria(all, 100), all)
  assert.throws(() => api.selectKeyCriteria(all, -1), /nonnegative/)
})

test('a vague saved record does not become an invented favorable assessment', () => {
  const report = api.buildAnalysisReport(realReportFixture({ scores: [80] }))
  const group = report.groups[0]
  const text = api.assessmentHighlights(group.target, group.comparisons[0])
  assert.match(text, /specific explanation was not recorded/)
  assert.ok(!/strong|excellent|good fit|Exact saved rationale|Full saved overall assessment/i.test(text))
})

test('missing-evidence criteria are not hidden when their saved explanation is generic', () => {
  const report = api.buildAnalysisReport(realReportFixture({ scores: [30] }))
  const group = report.groups[0]
  const comparison = group.comparisons[0]
  comparison.criteria[0].score = 0
  comparison.criteria[0].evidenceStatus = 'missing'
  comparison.criteria[0].citations = []
  const text = api.assessmentHighlights(group.target, comparison)
  assert.match(text, /0 \/ 5/)
  assert.match(text, /No supporting evidence was found in the resume/)
  assert.ok(!/lacks|unqualified|cannot perform/i.test(text))
})

test('compact highlights retain a complete gap clause instead of cutting off its meaning', () => {
  const report = evidenceFixture()
  const group = report.groups[0]
  group.comparisons[0].criteria[3].rationale = 'Supported office meetings and helped with group discussions; independent team leadership was not established.'
  const text = api.assessmentHighlights(group.target, group.comparisons[0], 240)
  assert.match(text, /independent team leadership was not established\./)
  assert.ok(!text.includes('not...'))
  const reviews = api.criterionReviews(group.target, group.comparisons[0], 80)
  assert.equal(reviews[3].explanation, 'independent team leadership was not established.')
})

test('withheld results preserve the reason and important qualification caveats', () => {
  const report = api.buildAnalysisReport(realReportFixture({ scores: [null], kind: 'grade' }))
  const group = report.groups[0]
  const comparison = group.comparisons[0]
  comparison.qualifications = [{
    qualificationId: 'qualification-secret-id', text: 'Engineering education', interpretation: '', support: 'direct',
    evidenceStatus: 'not-assessed', rationale: 'The record does not establish the required education.',
    citations: [], requirementCitations: [], limitation: null,
  }]
  const text = api.assessmentSummary(group.target, comparison)
  assert.match(text, /No overall score: Weighted criteria were not assessed/)
  assert.match(text, /Qualification needs review \(unscored\)/)
  assert.match(text, /education/)
  assert.ok(!text.includes('qualification-secret-id'))
  assert.ok(!text.includes('0 / 100'))
})

test('readable criterion explanations preserve gaps and use short source locators', () => {
  const report = evidenceFixture()
  const group = report.groups[0]
  const comparison = group.comparisons[0]
  comparison.criteria[0].limitation = { code: 'private-code', message: 'The sampling method needs confirmation.' }
  const reviews = api.criterionReviews(group.target, comparison)
  assert.match(reviews[0].explanation, /needs confirmation/)
  assert.equal(reviews[0].sourceLabel, 'Saved résumé.docx, section 3')
  assert.ok(!JSON.stringify(reviews.map(review => review.sourceLabel)).includes('resume-document'))
  assert.equal(reviews[0].weightLabel, '40%')
  assert.equal(reviews[0].number, 1)
  comparison.criteria[0].score = null
  comparison.criteria[0].weight = 0
  comparison.criteria[0].evidenceStatus = 'not-applicable'
  assert.equal(api.criterionReviews(group.target, comparison)[0].scoreLabel, 'N/A')
  comparison.criteria.pop()
  assert.throws(() => api.criterionReviews(group.target, comparison), /missing a saved criterion/)
})

test('plain completion counts distinguish candidates from candidate-job reviews without partial jargon', () => {
  const report = api.buildAnalysisReport(realReportFixture({
    scores: [80, 80, 80, 80, 80, 80], statuses: ['complete', 'running', 'queued', 'failed', 'cancelled', 'complete'],
  }))
  assert.equal(api.readableCompletionNotice(report.counts), 'Reporting on 2 of 6 candidates. 2 still processing; 1 could not be assessed; 1 cancelled.')
  assert.match(api.readableCompletionNotice(report.counts, true), /2 of 6 candidate-job reviews/)
  assert.equal(api.readableAnalysisDate('2026-09-18T23:30:00.000Z'), 'Sep 18, 2026')
  assert.equal(api.readableAnalysisDate(null), '')
  assert.throws(() => api.readableAnalysisDate('not-a-date'), /invalid analysis date/)
})

test('job facts and display names do not expose administrative identity fallbacks', () => {
  const report = api.buildAnalysisReport(realReportFixture({ scores: [80], targetCount: 2 }))
  report.groups[0].target.facts = [
    { label: 'Organization', value: 'Census agency' },
    { label: 'Location', value: 'Washington, DC' },
    { label: 'Rubric SHA-256', value: 'secret-hash' },
    { label: 'Approval ID', value: 'secret-id' },
  ]
  assert.deepEqual(api.readableJobFacts(report.groups[0].target), ['Organization: Census agency', 'Location: Washington, DC'])
  assert.equal(api.readableCandidateName({ ...report.groups[0].comparisons[0].candidate, name: null }), 'Saved résumé.docx')
  const first = api.readableTargetLabel(report, report.groups[0])
  const second = api.readableTargetLabel(report, report.groups[1])
  assert.notEqual(first, second)
  assert.ok(!first.includes('target-0'))
})

test('readable labels use captured aliases while source names, filenames and saved evidence stay separate', () => {
  const input = realReportFixture({ scores: [80], targetCount: 2 })
  input.targets[0].displayName = 'Captured job label'
  input.targets[1].displayName = 'Another captured label'
  for (const comparison of input.comparisons) comparison.candidate.displayName = 'Captured resume label'
  const report = api.buildAnalysisReport(input)
  const original = JSON.stringify(report)
  const group = report.groups[0]
  const candidate = group.comparisons[0].candidate
  assert.equal(api.readableCandidateName(candidate), 'Captured resume label')
  assert.equal(api.readableCandidateSourceName(candidate), candidate.name)
  assert.equal(api.readableCandidateName({ ...candidate, name: null }), 'Captured resume label')
  assert.equal(api.readableCandidateSourceName({ ...candidate, name: null }), candidate.sourceLabel)
  assert.equal(api.readableCandidateName({ ...candidate, displayName: undefined, name: null }), candidate.sourceLabel)
  assert.equal(api.readableTargetLabel(report, group), 'Captured job label')
  assert.equal(api.readableTargetLabel(report, report.groups[1]), 'Another captured label')
  assert.equal(api.readableTargetSourceLabel(report, group), `${group.target.label} (Job 1)`)
  assert.equal(api.readableTargetSourceLabel(report, report.groups[1]), `${group.target.label} (Job 2)`)
  assert.equal(api.criterionReviews(group.target, group.comparisons[0])[0].sourceLabel, `${candidate.sourceLabel}, section 3`)
  assert.equal(JSON.stringify(report), original)
})

test('target disambiguation compares the visible captured labels, including alias/source-label collisions', () => {
  const input = realReportFixture({ scores: [80], targetCount: 3 })
  input.targets[0].displayName = 'Shared title'
  input.targets[1].displayName = 'Shared title'
  input.targets[2].label = 'Shared title'
  const report = api.buildAnalysisReport(input)
  assert.deepEqual(report.groups.map(group => api.readableTargetLabel(report, group)),
    ['Shared title (Job 1)', 'Shared title (Job 2)', 'Shared title (Job 3)'])
  report.groups[0].target.sublabel = 'Distinct saved scope'
  assert.equal(api.readableTargetLabel(report, report.groups[0]), 'Shared title - Distinct saved scope')
  assert.equal(report.groups.length, 3)
  assert.equal(report.counts.total, 3)
})

test('bounded display text respects grapheme boundaries and visibly marks shortening', () => {
  assert.equal(api.compactReportText('  Two  short\nsentences. ', 40), 'Two short sentences.')
  const result = api.compactReportText('Repeated e\u0301vidence '.repeat(100), 80)
  assert.ok(result.endsWith('...'))
  assert.ok(Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(result)).length <= 80)
  assert.ok(api.compactReportText('e\u0301'.repeat(100), 17).endsWith('e\u0301...'))
  assert.throws(() => api.compactReportText('text', 3), /budget/)
  const report = evidenceFixture()
  const comparison = report.groups[0].comparisons[0]
  comparison.criteria[0].rationale = 'LongUnbrokenEvidence'.repeat(1000)
  assert.ok(api.assessmentSummary(report.groups[0].target, comparison).length <= 460)
})
