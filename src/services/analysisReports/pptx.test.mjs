import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import fontkit from '@pdf-lib/fontkit'
import { loadReportFoundation, reportFixtureCitation, REPORT_TEST_TIMESTAMP } from './test-support.mjs'
import {
  fictionalPptxFixture, inspectPptx, loadPptxTestApi, longPptxFixture, PPTX_SAMPLE_LINKS,
  PPTX_TEST_LINKS, readablePptxFixture, refreshPptxCoverage, unzipPptx,
} from './pptx.test-support.mjs'

let foundation, api, cleanupFoundation, cleanupPptx
before(async () => {
  const [base, pptx] = await Promise.all([loadReportFoundation(), loadPptxTestApi()])
  foundation = base.api
  api = pptx.api
  cleanupFoundation = base.cleanup
  cleanupPptx = pptx.cleanup
})
after(async () => { await Promise.all([cleanupFoundation?.(), cleanupPptx?.()]) })

async function inspectReport(report, options = report.dataKind === 'sample' ? PPTX_SAMPLE_LINKS : PPTX_TEST_LINKS) {
  return inspectPptx(await api.generatePptxReport(report, options))
}

function matchingShapes(slides, pattern) {
  return slides.flatMap(slide => slide.shapes.filter(shape => pattern.test(shape.name)))
}

function assertReadableGeometry(slides) {
  const smallText = /^(?:brand|job-reference|report-designation|slide-number)$|^review-\d+-\d+-weight-note$/
  for (const slide of slides) {
    assert.doesNotMatch(slide.xml, /<p:pic\b|<a:normAutofit\b|<a:spAutoFit\b/)
    assert.ok(slide.shapes.some(shape => shape.name === 'score-brand'))
    assert.ok(slide.fonts.length > 0)
    assert.ok(slide.fonts.every(size => size >= 11))
    for (const shape of slide.shapes) {
      const { x, y, w, h } = shape.box
      assert.ok([x, y, w, h].every(Number.isFinite), `${slide.name} / ${shape.name} has finite geometry`)
      assert.ok(x >= 0.5 - 0.000002 && y >= 0.5 - 0.000002, `${slide.name} / ${shape.name} honors top/left margins`)
      assert.ok(w > 0 && h > 0, `${slide.name} / ${shape.name} has positive dimensions`)
      assert.ok(x + w <= api.PPTX_LAYOUT.width - 0.5 + 0.000002, `${slide.name} / ${shape.name} stays inside right margin`)
      assert.ok(y + h <= api.PPTX_LAYOUT.height - 0.5 + 0.000002, `${slide.name} / ${shape.name} stays inside bottom margin`)
      if (shape.text && !smallText.test(shape.name)) {
        assert.ok(shape.fonts.every(size => size >= 14), `${slide.name} / ${shape.name} keeps body/table text at least 14pt`)
      }
      if (shape.kind === 'p:sp' && shape.text) {
        const measured = api.measurePptxText(shape.text, w, Math.max(...shape.fonts))
        assert.ok(measured.height <= h + 0.000002, `${slide.name} / ${shape.name} reserves its measured text height`)
      }
      if (shape.kind === 'p:graphicFrame') {
        assert.ok(shape.rows.reduce((sum, row) => sum + row.height, 0) <= h + 0.00001)
        for (const row of shape.rows) {
          row.cells.forEach((cell, index) => {
            const measured = api.measurePptxText(cell.text, shape.columnWidths[index] - 0.28, 14)
            assert.ok(measured.height + 0.10 <= row.height + 0.00001,
              `${slide.name} / ${shape.name} reserves measured height and padding for ${JSON.stringify(cell.text)}`)
          })
        }
      }
    }
    const textShapes = slide.shapes.filter(shape => shape.text)
    for (let left = 0; left < textShapes.length; left++) {
      for (let right = left + 1; right < textShapes.length; right++) {
        const a = textShapes[left].box, b = textShapes[right].box
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        assert.ok(overlapX <= 0.00001 || overlapY <= 0.00001,
          `${slide.name}: editable text/table boxes ${textShapes[left].name} and ${textShapes[right].name} do not overlap`)
      }
    }
  }
}

test('presentation display labels never replace original candidate or target identities', async () => {
  const input = readablePptxFixture({ scores: [92.75, null], criterionCount: 6 })
  input.run.name = 'Renamed analysis'
  input.targets[0].displayName = 'Custom target'
  input.comparisons[0].candidate.displayName = 'Custom candidate'
  input.comparisons[1].candidate.displayName = 'Captured withheld candidate'
  const report = foundation.buildAnalysisReport(input)
  const original = JSON.stringify(report)
  const result = await inspectReport(report)
  for (const value of ['Renamed analysis', 'Custom target', 'Custom candidate',
    `Source-stated name: ${input.comparisons[0].candidate.name}`, `Source target title: ${input.targets[0].label}`,
    input.comparisons[0].candidate.sourceLabel]) {
    assert.ok(result.text.includes(value), `Missing label or source identity: ${value}`)
  }
  assert.match(result.entries.get('docProps/core.xml').toString(), /Analysis evidence report — Renamed analysis/)
  assert.match(result.slides[0].text, /Custom target/)
  const overview = matchingShapes(result.slides, /^overview-0-\d+$/)
  assert.ok(overview.some(shape => shape.text.includes('Captured withheld candidate')))
  assert.ok(matchingShapes(result.slides, /^review-0-0-(overview|scorecard|explanations)-name$/).every(shape => shape.text === 'Custom candidate'))
  assert.equal(JSON.stringify(report), original)
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
  assertNoAuditProse(result)
})

test('160-unit aliases and long source identities remain bounded and linked in single- and multiple-job decks', async () => {
  for (const targetCount of [1, 2]) {
    const input = readablePptxFixture({ scores: [92.75], criterionCount: 6, targetCount })
    input.run.name = `${'Current analysis '.repeat(10).slice(0, 159)}Z`
    input.targets.forEach(target => {
      target.displayName = `${'Captured target '.repeat(10).slice(0, 159)}Z`
      target.label = 'Original source target title '.repeat(100).trimEnd()
    })
    input.comparisons.forEach(comparison => {
      comparison.candidate.displayName = `${'Captured resume '.repeat(10).slice(0, 159)}Z`
      comparison.candidate.name = 'Original source candidate name '.repeat(60).trimEnd()
      comparison.candidate.sourceLabel = `${'Original resume filename '.repeat(60)}.pdf`
    })
    const report = foundation.buildAnalysisReport(input)
    const original = JSON.stringify(report)
    const result = await inspectReport(report)
    assert.equal(JSON.stringify(report), original)
    assert.equal(result.slides.length, targetCount === 1 ? 5 : 11)
    const title = result.slides[0].shapes.find(shape => shape.name === 'job-reference')
    assert.equal(title.links[0].tooltip, input.run.name)
    assert.equal(result.slides[0].relationships.get(title.links[0].id),
      api.reportReviewLinks(report, report.groups[0].comparisons[0], PPTX_TEST_LINKS).analysis)
    for (const [index, group] of report.groups.entries()) {
      const links = api.reportReviewLinks(report, group.comparisons[0], PPTX_TEST_LINKS)
      const sourceTitle = result.slides.flatMap(slide => slide.shapes
        .filter(shape => shape.name === 'source-target-title' && slide.relationships.get(shape.links[0]?.id) === links.target))
      assert.equal(sourceTitle.length, 1)
      assert.equal(sourceTitle[0].links[0].tooltip, `Source target title: ${group.target.label}`)
      const sourceName = matchingShapes(result.slides, new RegExp(`^review-${index}-0-metadata-2$`))[0]
      assert.equal(sourceName.links[0].tooltip, `Source-stated name: ${group.comparisons[0].candidate.name}`)
      const sourceFile = matchingShapes(result.slides, new RegExp(`^review-${index}-0-metadata-1$`))[0]
      assert.equal(sourceFile.links[0].tooltip, `Source: ${group.comparisons[0].candidate.sourceLabel}`)
      const references = result.slides.flatMap(slide => slide.shapes.filter(shape =>
        shape.name === 'job-reference' && shape.links[0]?.tooltip === api.readableTargetLabel(report, group)))
      assert.ok(references.length >= 4, 'Compacted job aliases keep the full captured, disambiguated label')
    }
    assertOverviewCoverage(report, result)
    assertFeaturedContract(report, result)
    assertReadableGeometry(result.slides)
    assertNoAuditProse(result)
  }
})

function assertOverviewCoverage(report, result, options = report.dataKind === 'sample' ? PPTX_SAMPLE_LINKS : PPTX_TEST_LINKS) {
  report.groups.forEach((group, groupIndex) => {
    const actual = []
    for (const slide of result.slides) {
      for (const table of slide.shapes.filter(shape => new RegExp(`^overview-${groupIndex}-\\d+$`).test(shape.name))) {
        assert.deepEqual(table.rows[0].cells.map(cell => cell.text), ['Name', 'Score', 'Assessment highlights'])
        for (const row of table.rows.slice(1)) {
          assert.ok(row.cells[0].links.length, 'Every overview name is a native review hyperlink')
          actual.push({
            name: row.cells[0].text,
            analysis: slide.relationships.get(row.cells[0].links[0].id),
            tooltip: row.cells[0].links[0].tooltip,
            score: row.cells[1].text,
            highlights: row.cells[2].text,
          })
        }
      }
    }
    const complete = group.comparisons.filter(comparison => comparison.status === 'complete')
    assert.equal(actual.length, complete.length, 'Every complete comparison appears once, with no unfinished rows')
    complete.forEach((comparison, index) => {
      assert.equal(actual[index].analysis, api.reportReviewLinks(report, comparison, options).analysis,
        'Overview retains supplied saved-score order and ties without reranking')
      const name = api.readableCandidateName(comparison.candidate)
      assert.equal(actual[index].tooltip, comparison.candidate.displayName
        ? `${name} · Source-stated name: ${comparison.candidate.name ?? 'Not stated'} · Source: ${comparison.candidate.sourceLabel}`
        : name)
      assert.equal(actual[index].score, comparison.overall.status === 'available' ? `${comparison.overall.score} / 100` : 'Withheld')
      assert.ok(actual[index].highlights.length > 10)
    })
  })
}

function assertFeaturedContract(report, result) {
  const expected = new Set()
  report.groups.forEach((group, groupIndex) => {
    group.comparisons.forEach((comparison, index) => {
      const key = `review-${groupIndex}-${index}`
      const featured = group.highlightedComparisonIds.includes(comparison.id)
      if (featured) expected.add(key)
      const names = matchingShapes(result.slides, new RegExp(`^${key}-(overview|scorecard|explanations)-name$`))
      assert.equal(names.length, featured ? 3 : 0, 'Only highlighted comparisons receive exactly three individual slides')
      if (!featured) return
      for (const name of names) {
        assert.ok(name.text, 'Candidate is named on each of their slides')
        const fullName = api.readableCandidateName(comparison.candidate)
        if (name.text !== fullName) assert.equal(name.links[0]?.tooltip, fullName, 'Compacted names retain full clickable tooltips')
      }
      const tables = matchingShapes(result.slides, new RegExp(`^${key}-scorecard-table$`))
      assert.equal(tables.length, 1)
      assert.deepEqual(tables[0].rows[0].cells.map(cell => cell.text), ['Criterion', 'Weight', 'Score'])
      const displayed = tables[0].rows.slice(1).map(row => Number(row.cells[0].text.match(/^C(\d+)\b/)[1]))
      const explanations = matchingShapes(result.slides, new RegExp(`^${key}-criterion-\\d+-explanation$`))
      assert.deepEqual(explanations.map(shape => Number(shape.name.match(/criterion-(\d+)/)[1])), displayed,
        'Every displayed criterion has one concise explanation in its original order')
      for (const explanation of explanations) {
        const number = Number(explanation.name.match(/criterion-(\d+)/)[1])
        const score = comparison.criteria.find(criterion => criterion.criterionId === group.target.criteria[number - 1].id)
        const label = score.evidenceStatus === 'not-applicable' ? 'N/A' : foundation.criterionScoreLabel(score)
        assert.ok(explanation.text.includes(`C${number}`) && explanation.text.includes(label),
          'Every explanation identifies the criterion and its saved score without requiring the previous slide')
      }
      const fullScorecardLinks = matchingShapes(result.slides, new RegExp(`^${key}-link-3$`))
      const keyCriteria = matchingShapes(result.slides, new RegExp(`^${key}-scorecard-heading$`))[0].text.includes('Key criteria')
      const shortened = tables[0].rows.slice(1).some(row => row.cells[0].links.length)
        || explanations.some(shape => /(?:\.{3}|…)$/u.test(shape.text))
      assert.equal(fullScorecardLinks.length, keyCriteria || shortened ? 3 : 0)
      assert.ok(fullScorecardLinks.every(shape => shape.text === 'View full scorecard' && shape.links.length > 0))
    })
  })
  assert.equal(matchingShapes(result.slides, /^review-\d+-\d+-(overview|scorecard|explanations)-name$/).length, expected.size * 3)
}

function assertNoAuditProse(result) {
  assert.doesNotMatch(result.text, /Partial report|(?:^|\n)PARTIAL(?:\n|$)|Highest evidence matches|Report context|Criterion evidence|Saved review context|continued/i)
  assert.doesNotMatch(result.text, /\brank(?:ed|ing|s)?\b|cutoff|highlight list|highlighted match|capped|top five/i)
  assert.doesNotMatch(result.text, /Run ID|Candidate ID|Comparison ID|Rubric:|Target snapshot|SHA-256|capture interval|Assessment model|Grounding review/i)
  assert.doesNotMatch(result.text, /workspace-one|run-one|comparison-\d+|candidate-\d+|criterion-\d+|rubric-\d+|snapshot-|saved-model-version/)
  assert.equal((result.text.match(/Analysis evidence report/g) ?? []).length, 1)
  assert.equal((result.text.match(/Human review required/g) ?? []).length, 1)
  assert.equal((result.text.match(/not hiring decisions/g) ?? []).length, 1)
}

test('editable widescreen deck combines single-job context, all-completed overview, and three-slide featured reviews', async () => {
  const report = foundation.buildAnalysisReport(readablePptxFixture({ scores: [92.75, 87, 0, null], criterionCount: 6 }))
  const original = JSON.stringify(report)
  const result = await inspectReport(report)
  assert.equal(JSON.stringify(report), original, 'The writer does not alter saved scores, ordering, or highlight membership')
  assert.match(result.entries.get('[Content_Types].xml').toString(), /presentationml\.presentation\.main\+xml/)
  assert.match(result.entries.get('ppt/presentation.xml').toString(), /<p:sldSz cx="12192000" cy="6858000"/)
  assert.ok(result.entries.has('ppt/theme/theme1.xml'))
  assert.ok([...result.entries.keys()].every(name => !name.startsWith('ppt/media/') && !name.startsWith('ppt/embeddings/')))
  assert.match(result.slides[0].text, /Research analyst/)
  assert.match(result.slides[0].text, /Reporting on 4 of 4 candidates/)
  assert.match(result.slides[0].text, /Analysis date: Sep 18, 2026/)
  assert.match(result.slides[0].text, /Example Research Office|Hybrid, Example City/)
  assert.equal(result.slides.filter(slide => slide.text.includes('About the job')).length, 0, 'Single-job context stays on the opening slide')
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
  assertNoAuditProse(result)
  for (const table of matchingShapes(result.slides, /^review-\d+-\d+-scorecard-table$/)) {
    assert.equal(table.rows.length - 1, 6, 'Ordinary scorecards show every criterion')
  }
  assert.match(result.text, /0 \/ 100/)
  assert.match(result.text, /Withheld/)
  assert.match(result.text, /No overall score/)
  assert.match(result.text, /longitudinal surveys|sampling plans/)
  assert.match(result.text, /SQL analysis pipelines/)
  assert.doesNotMatch(result.text, /Summary excerpt|Exact saved rationale|Full saved overall assessment/)
})

test('ordinary overview highlights explain the specific strength and gap using C-prefixed criterion numbers', async () => {
  const report = foundation.buildAnalysisReport(fictionalPptxFixture())
  const result = await inspectReport(report)
  const overview = result.slides.find(slide => slide.shapes.some(shape => shape.name === 'review-0-0-overview-name'))
  const label = index => overview.shapes.find(shape => shape.name === `review-0-0-highlight-${index}-label`).text
  const rationale = index => overview.shapes.find(shape => shape.name === `review-0-0-highlight-${index}-rationale`).text
  assert.equal(label(0), 'C1 · Survey design · 5 / 5')
  assert.equal(label(1), 'C4 · Leadership · 3 / 5')
  assert.match(rationale(0), /survey|sampling/i)
  assert.match(rationale(1), /department-wide leadership is not established/i)
  assert.doesNotMatch(`${rationale(0)} ${rationale(1)}`, /\.{3}|…/, 'Ordinary evidence statements remain complete')
  assert.doesNotMatch(overview.text, /(?:^|\n)(?:Supported|Partial evidence|Missing evidence)(?:\n|$)/)
  assert.doesNotMatch(overview.text, /View full scorecard/, 'Ordinary overviews keep just the three useful source/review links')
  assertReadableGeometry(result.slides)
  const large = await inspectReport(foundation.buildAnalysisReport(fictionalPptxFixture('large')))
  const gap = matchingShapes(large.slides, /^review-0-0-highlight-\d-rationale$/)
    .find(shape => shape.text.includes('no example of leading'))
  assert.match(gap.text, /leading the national household survey team\./)
  assert.doesNotMatch(gap.text, /\.{3}|…/)
  assertReadableGeometry(large.slides)
})

test('processing-only summaries become one substantive overview without repeating the same criterion evidence', async () => {
  const input = fictionalPptxFixture()
  input.comparisons[0].summary = [
    'The submitted document was compared only with this exact saved rubric.',
    'Criterion evidence: 4 supported, 0 partial, 0 missing, 0 not assessed, and 0 excluded.',
    'The document evidence-match total is 85/100.',
    'Missing evidence does not establish that a person lacks ability.',
  ].join(' ')
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  const overview = result.slides.find(slide => slide.shapes.some(shape => shape.name === 'review-0-0-overview-name'))
  assert.match(overview.text, /validated sampling plans/)
  assert.match(overview.text, /department-wide leadership is not established/)
  assert.equal((overview.text.match(/validated sampling plans/g) ?? []).length, 1)
  assert.ok(!overview.shapes.some(shape => shape.name === 'review-0-0-highlights-panel'))
  assertNoAuditProse(result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
})

test('overview rows preserve projected limitation clauses instead of truncating them again to a fixed row height', async () => {
  const input = readablePptxFixture({ scores: [50], criterionCount: 2 })
  input.targets[0].criteria[0].label = '統計調査の設計'
  input.targets[0].criteria[1].label = '部門横断チームの指揮'
  const comparison = input.comparisons[0]
  comparison.criteria[0].rationale = '地域調査の設計と対象集団の標本抽出について、具体的な分析手順と検証記録が記載されています。'
  Object.assign(comparison.criteria[1], {
    score: 0, evidenceStatus: 'missing', citations: [],
    rationale: '部門横断チームの指揮経験は提出書類では確認されていません。',
  })
  refreshPptxCoverage(comparison)
  const report = foundation.buildAnalysisReport(input)
  const expected = api.assessmentHighlights(report.groups[0].target, report.groups[0].comparisons[0], 180)
  const result = await inspectReport(report)
  const table = matchingShapes(result.slides, /^overview-0-0$/)[0]
  assert.equal(table.rows[1].cells[2].text, expected, 'The writer preserves the complete shared projection')
  assert.match(table.rows[1].cells[2].text, /指揮経験は提出書類では確認されていません。/)
  assert.ok(table.rows[1].height > 0.94, 'Wide text receives a taller measured row rather than another excerpt')
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
})

test('tied scores preserve the all-completed overview while only the supplied ten highlights receive detail slides', async () => {
  const report = foundation.buildAnalysisReport(readablePptxFixture({
    scores: [100, 99, 98, 97, ...Array(12).fill(80), 0, null], criterionCount: 3,
  }))
  const result = await inspectReport(report)
  assert.equal(report.groups[0].highlightedComparisonIds.length, 10)
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertNoAuditProse(result)
  assertReadableGeometry(result.slides)
  assert.equal(matchingShapes(result.slides, /^review-0-\d+-overview-name$/).length, 10)
  assert.ok(matchingShapes(result.slides, /^overview-0-\d+$/).length > 1, 'Overview paginates rows, not rank cards or repeated intros')
})

test('each exact target gets a separate overview and human-readable disambiguation without leaking identities', async () => {
  const input = readablePptxFixture({ scores: [87, 95, null], targetCount: 2, criterionCount: 3 })
  input.comparisons.forEach(comparison => { comparison.candidate.name = 'Same Example Name' })
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertNoAuditProse(result)
  assertReadableGeometry(result.slides)
  assert.match(result.text, /Research analyst \(Job 1\)/)
  assert.match(result.text, /Research analyst \(Job 2\)/)
  assert.match(result.slides[0].text, /Reporting on 6 of 6 candidate-job reviews/)
  assert.equal(result.slides.filter(slide => matchingShapes([slide], /^slide-title$/).some(shape => shape.text === 'About the job')).length, 2)
})

test('unfinished reasons appear once and unfinished candidates never gain overview rows or individual reviews', async () => {
  const input = readablePptxFixture({
    scores: Array(105).fill(84), criterionCount: 1,
    statuses: [...Array(95).fill('complete'), 'queued', 'queued', 'running', 'running', 'running', 'failed', 'failed', 'failed', 'cancelled', 'cancelled'],
  })
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  assert.match(result.slides[0].text, /Reporting on 95 of 105 candidates/)
  for (const phrase of ['5 still processing', '3 could not be assessed', '2 cancelled']) {
    assert.equal(result.text.split(phrase).length - 1, 1, `${phrase} is explained only once`)
  }
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
  assertNoAuditProse(result)
})

test('all-withheld reports and unfinished target groups do not invent highlighted candidates', async () => {
  const unfinishedGroup = readablePptxFixture({
    scores: [null, 0, 0], statuses: ['complete', 'failed', 'cancelled'], criterionCount: 3, targetCount: 2,
  })
  for (const comparison of unfinishedGroup.comparisons.filter(item => item.targetId === 'target-1' && item.status === 'complete')) {
    Object.assign(comparison, {
      status: 'queued', completion: null, summary: null, coverage: null, analyzedAt: null, resultSha256: null,
      overall: { status: 'unavailable', score: null, reason: 'not-complete', message: 'No completed assessment was captured.' },
      criteria: [], qualifications: [], limitations: [], provenance: [],
    })
  }
  for (const input of [readablePptxFixture({ scores: [null, null, null], criterionCount: 3 }), unfinishedGroup]) {
    const report = foundation.buildAnalysisReport(input)
    const result = await inspectReport(report)
    assertOverviewCoverage(report, result)
    assertFeaturedContract(report, result)
    assertReadableGeometry(result.slides)
    assertNoAuditProse(result)
    assert.equal(matchingShapes(result.slides, /^review-/).length, 0)
    assert.equal((result.text.match(/Withheld/g) ?? []).length, report.counts.complete)
    assert.match(result.text, /No overall score/)
    if (report.groups.some(group => group.counts.complete === 0)) assert.match(result.text, /No completed assessments/)
    assert.doesNotMatch(result.text, /0 \/ 100|0 \/ 5/)
  }
})

test('long names, source labels, assessment text, GS concerns, and 100 criteria stay within three candidate slides', async () => {
  for (const count of [6, 100]) {
    const input = longPptxFixture(count)
    const report = foundation.buildAnalysisReport(input)
    const result = await inspectReport(report)
    assert.equal(result.slides.length, 5, 'One opening, one overview, and at most three featured slides')
    assertOverviewCoverage(report, result)
    assertFeaturedContract(report, result)
    assertNoAuditProse(result)
    assertReadableGeometry(result.slides)
    assert.match(result.text, /Key criteria/)
    assert.match(result.text, /View full scorecard/)
    assert.match(result.text, /Unscored qualification caveats/)
    assert.match(result.text, /Duration of specialized experience/)
    const notes = matchingShapes(result.slides, /^review-0-0-qualification-notes$/)
    assert.equal(notes.length, 1)
    assert.doesNotMatch(notes[0].text, /\/ 5|\/ 100|Weight:/)
    const name = matchingShapes(result.slides, /^review-0-0-overview-name$/)[0]
    assert.ok(name.text.length < input.comparisons[0].candidate.name.length)
    assert.equal(name.links[0].tooltip, input.comparisons[0].candidate.name)
    const source = matchingShapes(result.slides, /^review-0-0-metadata-1$/)[0]
    assert.equal(source.links[0].tooltip, `Source: ${input.comparisons[0].candidate.sourceLabel}`)
    assert.match(name.text, /\.\.\.|View|Candidate review/, 'Shortened names are visibly compact and link to their full name')
    assert.doesNotMatch(result.text, /fictional engineering quotation|Additional saved research methods and evidence details remain/)
    const table = matchingShapes(result.slides, /^review-0-0-scorecard-table$/)[0]
    const displayed = table.rows.slice(1).map(row => Number(row.cells[0].text.match(/^C(\d+)\b/)[1]))
    assert.ok(displayed.length < count)
    const reviews = api.criterionReviews(report.groups[0].target, report.groups[0].comparisons[0], 150)
    assert.deepEqual(displayed, api.selectKeyCriteria(reviews, displayed.length).map(criterion => criterion.number),
      'Oversized scorecards use the balanced shared selection and original criterion numbers')
  }
})

test('scorecards distinguish exact zero, N/A, not assessed, and positive fractional weights', async () => {
  const input = readablePptxFixture({ scores: [0], criterionCount: 5, kind: 'grade' })
  const comparison = input.comparisons[0]
  const weights = [0, 0.001, 49.999, 0, 50]
  const statuses = ['not-applicable', 'supported', 'missing', 'not-assessed', 'supported']
  comparison.criteria.forEach((criterion, index) => {
    input.targets[0].criteria[index].weight = weights[index]
    Object.assign(criterion, {
      weight: weights[index], evidenceStatus: statuses[index],
      score: ['not-applicable', 'not-assessed'].includes(statuses[index]) ? null : statuses[index] === 'missing' ? 0 : 4,
      citations: ['not-applicable', 'not-assessed', 'missing'].includes(statuses[index]) ? [] : [reportFixtureCitation(comparison.candidate.documentId)],
      limitation: statuses[index] === 'not-assessed' ? { code: 'source-limited', message: 'Training details were not assessable.' } : null,
    })
    if (statuses[index] === 'not-applicable') criterion.rationale = 'This requirement does not apply to the recorded assignment.'
    if (statuses[index] === 'not-assessed') criterion.rationale = 'The record does not establish the training history.'
  })
  comparison.completion = 'limited'
  comparison.qualifications = [{
    qualificationId: 'specialized-experience', text: 'Specialized research experience',
    interpretation: 'Separate unscored review.', support: 'gap', evidenceStatus: 'not-assessed',
    rationale: 'The record does not establish the required duration of specialized experience.',
    citations: [], requirementCitations: [],
    limitation: { code: 'duration-review', message: 'Specialized experience duration needs verification.' },
  }]
  refreshPptxCoverage(comparison)
  const report = foundation.buildAnalysisReport(input)
  const original = JSON.stringify(report)
  const result = await inspectReport(report)
  assert.equal(JSON.stringify(report), original)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
  assert.match(result.text, /0 \/ 100/)
  const table = matchingShapes(result.slides, /^review-0-0-scorecard-table$/)[0]
  assert.equal(table.rows.length - 1, 5)
  assert.deepEqual(table.rows.slice(1).map(row => row.cells[1].text), ['0%', '<0.01%', '~50%', '0%', '50%'])
  assert.deepEqual(table.rows.slice(1).map(row => row.cells[2].text), ['N/A', '4 / 5', '0 / 5', 'Not assessed', '4 / 5'])
  assert.match(result.text, /~ rounded to two decimals/)
  assert.match(result.text, /Unscored qualification caveats/)
  assert.match(result.text, /View grade requirements/)
})

test('floating point saved totals retain exact numeric precision rather than rounding or recomputing', async () => {
  const report = foundation.buildAnalysisReport(readablePptxFixture({ scores: [100 / 3, 1e-12], criterionCount: 3 }))
  const result = await inspectReport(report)
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
  assert.match(result.text, /33\.333333333333336 \/ 100/)
  assert.match(result.text, /1e-12 \/ 100/)
  assert.match(result.text, /~33\.33%/)
  assert.doesNotMatch(result.text, /33\.333333333333336%/)
  const sampleInput = fictionalPptxFixture()
  sampleInput.comparisons[0].criteria[0].score = 10 / 3
  const sample = await inspectReport(foundation.buildAnalysisReport(sampleInput))
  assert.match(sample.text, /3\.3333333333333335 \/ 5/)
  assertReadableGeometry(sample.slides)
})

test('native hyperlinks use real saved-workspace destinations and human-readable review labels', async () => {
  const report = foundation.buildAnalysisReport(readablePptxFixture({ scores: [92], criterionCount: 3 }))
  const large = foundation.buildAnalysisReport(readablePptxFixture({ scores: [92], criterionCount: 100 }))
  for (const source of [report, large]) {
    const result = await inspectReport(source)
    const expected = api.reportReviewLinks(source, source.groups[0].comparisons[0], PPTX_TEST_LINKS)
    for (const slide of result.slides.filter(slide => slide.shapes.some(shape => /^review-/.test(shape.name)))) {
      for (const [index, label, target] of [
        [0, 'View analysis', expected.analysis], [1, 'View resume', expected.resume],
        [2, 'View job', expected.target], ...(source === large ? [[3, 'View full scorecard', expected.analysis]] : []),
      ]) {
        const shape = slide.shapes.find(shape => shape.name === `review-0-0-link-${index}`)
        assert.equal(shape.text, label)
        assert.equal(slide.relationships.get(shape.links[0].id), target)
      }
      if (source === report) assert.ok(!slide.shapes.some(shape => shape.name === 'review-0-0-link-3'))
      for (const target of slide.relationships.values()) {
        const url = new URL(target)
        assert.equal(url.origin, 'https://score.example')
        assert.match(url.pathname, /workspace-one/)
        assert.doesNotMatch(target, /token=|sig=|file:|blob:/)
      }
    }
  }
  await assert.rejects(api.generatePptxReport(report), /origin/i)
  await assert.rejects(api.generatePptxReport(report, { links: { origin: 'https://score.example', workspaceId: 'wrong-workspace' } }), /workspace/i)
  const noFeatured = foundation.buildAnalysisReport(readablePptxFixture({ scores: [null] }))
  await assert.rejects(api.generatePptxReport(noFeatured), /origin/i)
})

test('fictional samples stay unmistakably labelled on every slide with just one human-review caution', async () => {
  for (const report of [
    foundation.buildAnalysisReport(fictionalPptxFixture()),
    foundation.buildSampleAnalysisReport(foundation.createInitialWorkspace().runs[0], { generatedAt: REPORT_TEST_TIMESTAMP }),
  ]) {
    const result = await inspectReport(report)
    assertOverviewCoverage(report, result)
    assertFeaturedContract(report, result)
    assertReadableGeometry(result.slides)
    assertNoAuditProse(result)
    for (const slide of result.slides) assert.match(slide.text, /FICTIONAL SAMPLE/)
    for (const slide of result.slides) {
      for (const url of slide.relationships.values()) assert.ok(!url.includes('workspace-one'))
    }
  }
})

test('fictional QA decks use coherent stored scores and distinct substantive criterion rationales', () => {
  for (const kind of ['normal', 'long', 'large']) {
    const input = fictionalPptxFixture(kind)
    const report = foundation.buildAnalysisReport(input)
    assert.equal(report.dataKind, 'sample')
    for (const comparison of input.comparisons.filter(item => item.overall.status === 'available')) {
      const weight = comparison.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
      const contribution = comparison.criteria.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0)
      assert.equal(weight, 100)
      assert.ok(Math.abs(contribution / 5 - comparison.overall.score) < 1e-9,
        'Only synthetic QA fixture arithmetic is checked; the production writer still never recalculates saved scores')
      assert.equal(new Set(comparison.criteria.map(criterion => criterion.rationale)).size, comparison.criteria.length)
    }
  }
  const normal = fictionalPptxFixture()
  assert.deepEqual(normal.targets[0].criteria.map(criterion => criterion.weight), [40, 25, 20, 15])
  assert.deepEqual(normal.comparisons[0].criteria.map(criterion => criterion.score), [5, 4, 4, 3])
  assert.equal(normal.comparisons[0].overall.score, 85)
})

test('Unicode, fallback names, formula-like source text, and XML metacharacters remain readable and escaped', async () => {
  const input = readablePptxFixture({ scores: [95, 88, null], criterionCount: 3 })
  input.comparisons[0].candidate.name = 'Zoë <王> & Олена / 👩🏽‍🔬 / e\u0301'
  input.comparisons[0].summary = 'Designed a bilingual research survey for Montréal and Київ. Leadership evidence is limited.'
  input.comparisons[1].candidate.name = null
  input.comparisons[1].candidate.sourceLabel = '=Résumé & “notes”.pdf'
  input.comparisons[1].criteria[0].rationale = 'Compared café survey responses across São Paulo and Αθήνα.'
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
  assertNoAuditProse(result)
  assert.match(result.text, /Zoë <王> & Олена/)
  assert.match(result.text, /=Résumé & “notes”\.pdf/)
  assert.match(result.text, /café|São Paulo|Αθήνα/)
  assert.doesNotMatch(result.text, /\uFFFD/)
})

test('all 500 completed comparisons survive overview pagination without creating unfeatured detail sections', async () => {
  const report = foundation.buildAnalysisReport(readablePptxFixture({ scores: Array(500).fill(80), criterionCount: 1 }))
  const result = await inspectReport(report)
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
  assertNoAuditProse(result)
  assert.ok(result.slides.length < 200, `Compact overview rows keep the 500-candidate deck bounded (${result.slides.length} slides)`)
  assert.ok(result.bytes.byteLength < api.REPORT_LIMITS.maxOutputBytes)
})

test('pagination primitives conservatively measure wide characters, paragraphs, tabs, and unbroken strings', () => {
  const value = `Preserved start\tΩ李\r\n${'Wm'.repeat(150)}\n${'one  two three '.repeat(240)}\nPreserved end`
  const pages = api.paginatePptxBlocks([{ key: 'long-test-block', text: value }], 8.6, 3.9)
  assert.equal(pages.flatMap(page => page.fragments.map(fragment => fragment.text)).join(''), value)
  assert.ok(pages.length > 3)
  for (const page of pages) {
    assert.ok(page.height <= 3.9 + 0.000001)
    for (const fragment of page.fragments) {
      const measured = api.measurePptxText(fragment.text, 8.6, fragment.fontSize)
      assert.ok(measured.height <= fragment.height + 0.000001)
      assert.ok(measured.lines.every(line => line.width <= 8.6 * 72 * 0.94 + 0.000001))
      assert.ok(fragment.y >= 0 && fragment.y + fragment.height <= 3.9 + 0.000001)
    }
  }
  assert.ok(api.measurePptxText('WWWWWWWWWW', 1.5, 16).lines.length > api.measurePptxText('iiiiiiiiii', 1.5, 16).lines.length)
  assert.throws(() => api.assertPptxBox({ x: 0.3, y: 1, w: 1, h: 1 }), /safe slide bounds/)
  assert.throws(() => api.assertPptxBox({ x: 1, y: 1, w: Number.NaN, h: 1 }), /safe slide bounds/)
  assert.throws(() => api.takePptxText('Saved text', 1, 0.01, 16), /readable line/)
})

test('conservative Latin measurements cover bundled regular and bold font advances', async () => {
  for (const style of ['Regular', 'Bold']) {
    const font = fontkit.create(await readFile(resolve('src', 'assets', 'report-fonts', `NotoSans-${style}.ttf`)))
    for (let code = 32; code < 127; code++) {
      const actual = font.glyphForCodePoint(code).advanceWidth / font.unitsPerEm * 16
      const measured = api.pptxGlyphWidth(String.fromCodePoint(code), 16)
      assert.ok(Number.isFinite(measured) && measured >= actual, `${style}: ${String.fromCodePoint(code)} has a conservative measured advance`)
    }
  }
  assert.ok(api.pptxGlyphWidth('f', 16) < api.pptxGlyphWidth('d', 16))
  assert.ok(api.pptxGlyphWidth('r', 16) < api.pptxGlyphWidth('o', 16))
})

test('XML validation covers rendered content, while complete input resource and slide/output/time limits remain enforced', async () => {
  const report = foundation.buildAnalysisReport(readablePptxFixture({ scores: [0], criterionCount: 1 }))
  const invalid = structuredClone(report)
  invalid.groups[0].comparisons[0].candidate.name = 'Invalid\u0000name'
  await assert.rejects(api.generatePptxReport(invalid, PPTX_TEST_LINKS), /XML-invalid/)
  const omitted = structuredClone(report)
  omitted.groups[0].comparisons[0].provenance.push({ label: 'Unused audit text', value: 'No visible content\u0000' })
  omitted.groups[0].comparisons[0].criteria[0].citations[0].quote += '\u0000'
  const valid = await inspectReport(omitted)
  assert.doesNotMatch(valid.text, /Unused audit text|No visible content/)
  const inputLimit = api.REPORT_LIMITS.maxInputBytes
  try {
    api.REPORT_LIMITS.maxInputBytes = new TextEncoder().encode(JSON.stringify(report)).byteLength + 1024
    const largeOmittedAudit = structuredClone(report)
    largeOmittedAudit.groups[0].comparisons[0].provenance.push({ label: 'Omitted audit', value: 'x'.repeat(8192) })
    await assert.rejects(api.generatePptxReport(largeOmittedAudit, PPTX_TEST_LINKS), /resource limit/,
      'Even prose omitted from the slides still counts against the full captured-input budget')
  } finally {
    api.REPORT_LIMITS.maxInputBytes = inputLimit
  }
  for (const [key, limit, expected] of [
    ['maxSlides', 2, /slide\/page limit/],
    ['maxPages', 2, /slide\/page limit/],
    ['maxOutputBytes', 100, /output byte limit/],
    ['maxGenerationMilliseconds', -1, /time limit/],
    ['maxInputBytes', 100, /resource limit/],
  ]) {
    const original = api.REPORT_LIMITS[key]
    try {
      api.REPORT_LIMITS[key] = limit
      await assert.rejects(api.generatePptxReport(report, PPTX_TEST_LINKS), error => {
        assert.match(error.message, expected)
        assert.match(error.message, /Narrow the export/)
        return true
      })
    } finally {
      api.REPORT_LIMITS[key] = original
    }
  }
})

test('browser-worker bundle generates actual editable PPTX bytes without Node globals, network calls, or asset requests', async () => {
  const result = await build({
    entryPoints: [resolve('src', 'services', 'analysisReports', 'pptx.ts')],
    bundle: true, platform: 'browser', format: 'iife', globalName: 'ScoreReportTest',
    write: false, metafile: true, logLevel: 'silent',
  })
  assert.ok(result.outputFiles[0].contents.byteLength > 0)
  assert.ok(Object.values(result.metafile.outputs).flatMap(item => item.imports).every(item => !item.external))
  const source = result.outputFiles[0].text
  assert.doesNotMatch(source, /from ["'](?:node:|fs["']|path["'])/)
  const scope = createContext({
    console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Blob, URL, URLSearchParams,
    fetch: () => { throw new Error('Report generation must not fetch assets or private data.') },
  })
  runInContext('self = globalThis', scope)
  runInContext(source, scope)
  assert.equal(runInContext('typeof process + "/" + typeof Buffer + "/" + typeof document', scope), 'undefined/undefined/undefined')
  const report = foundation.buildAnalysisReport(readablePptxFixture({ scores: [0], criterionCount: 1 }))
  const bytes = await scope.ScoreReportTest.generatePptxReport(report, PPTX_TEST_LINKS)
  const entries = await unzipPptx(Uint8Array.from(bytes))
  assert.ok(entries.has('ppt/presentation.xml'))
})
