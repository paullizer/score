import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import fontkit from '@pdf-lib/fontkit'
import { loadReportFoundation, reportFixtureCitation, REPORT_TEST_TIMESTAMP, version2ReportFixture } from './test-support.mjs'
import {
  fictionalPptxFixture, inspectPptx, loadPptxTestApi, longPptxFixture, PPTX_SAMPLE_LINKS,
  PPTX_TEST_LINKS, powerpointLayoutFixture, readablePptxFixture, readyPptxFixture, refreshPptxCoverage, unzipPptx,
} from './pptx.test-support.mjs'

let foundation, api, cleanupFoundation, cleanupPptx
before(async () => {
  const [base, pptx] = await Promise.all([loadReportFoundation(), loadPptxTestApi()])
  foundation = {
    ...base.api,
    buildAnalysisReport: (input, options) => base.api.buildAnalysisReport(readyPptxFixture(input, options), options),
  }
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

test('long v2 summaries and manual known issues continue across readable slides and overview rows without clipping', async () => {
  const report = foundation.buildAnalysisReport(version2ReportFixture({ long: true }))
  const before = JSON.stringify(report)
  const result = await inspectReport(report)
  const group = report.groups[0]
  const candidate = group.comparisons[0]
  const summaryParts = matchingShapes(result.slides, /^review-0-0-summary-part-/)
  assert.ok(summaryParts.length > 1)
  assert.equal(summaryParts.map(shape => shape.text).join(''), candidate.narrative.text)
  const candidateDisclosures = matchingShapes(result.slides, /^review-0-0-disclosure-/).map(shape => shape.text).join('')
  assert.ok(candidateDisclosures.includes('Manually approved summary. Automated review: needs-correction.'))
  assert.ok(candidateDisclosures.includes(`Known issue: ${candidate.narrative.approval.issues[0].message}`))
  for (const [index, paragraph] of group.target.narrative.paragraphs.entries()) {
    assert.equal(matchingShapes(result.slides, new RegExp(`^target-0-narrative-${index}-part-`)).map(shape => shape.text).join(''), paragraph)
  }
  const targetDisclosures = matchingShapes(result.slides, /^target-0-disclosure-/).map(shape => shape.text).join('')
  assert.ok(targetDisclosures.includes(`Known issue: ${group.target.narrative.approval.issues[0].message}`))
  const overviewRows = matchingShapes(result.slides, /^overview-0-\d+$/).flatMap(shape => shape.rows.slice(1))
  for (const comparison of group.comparisons) {
    const rows = overviewRows.filter(row => row.cells[0].text === comparison.candidate.name)
    assert.ok(rows.length > 1, 'Accepted overviews and disclosures continue with the same candidate identity and score.')
    assert.equal(rows.map(row => row.cells[2].text).join(''),
      [...foundation.candidateNarrativeDisclosures(comparison), comparison.narrative.overview].join('\n\n'))
    assert.ok(rows.every(row => row.cells[1].text === (comparison.overall.status === 'available' ? `${comparison.overall.score} / 100` : 'Withheld')))
  }
  assert.equal(JSON.stringify(report), before)
  assert.ok(result.slides.some(slide => slide.text.includes('Candidates at a glance (continued)')))
  assert.ok(matchingShapes(result.slides, /^overview-link-note$/).some(shape => shape.text.includes('Manually approved summary and known issues (continued)')))
  for (const slide of result.slides.filter(slide => slide.shapes.some(shape => /^review-0-0-summary-part-|^target-0-narrative-/.test(shape.name)))) {
    assert.match(slide.xml, /<a:spcPts val="2000"\s*\/>/, 'V2 paragraph leading must match measured pagination in native PowerPoint.')
  }
  assertReadableGeometry(result.slides)
})

test('presentation display labels never replace original candidate or target identities', async () => {
  const input = readablePptxFixture({ scores: [92.75, null], criterionCount: 6 })
  input.run.name = 'Renamed analysis'
  input.targets[0].displayName = 'Custom target'
  input.targets[0].label = 'LEGACY-COMPOSITE TITLE - OFFICE MUST NOT BE USED'
  input.comparisons[0].candidate.displayName = 'Custom candidate'
  input.comparisons[1].candidate.displayName = 'Captured withheld candidate'
  const report = foundation.buildAnalysisReport(input)
  const original = JSON.stringify(report)
  const result = await inspectReport(report)
  for (const value of ['Renamed analysis', 'Custom target', 'Custom candidate',
    `Source-stated name: ${input.comparisons[0].candidate.name}`, `Source target title: ${report.groups[0].target.presentation.title}`,
    input.comparisons[0].candidate.sourceLabel]) {
    assert.ok(result.text.includes(value), `Missing label or source identity: ${value}`)
  }
  assert.match(result.entries.get('docProps/core.xml').toString(), /Analysis evidence report — Renamed analysis/)
  assert.equal(matchingShapes(result.slides, /^agenda-0-title$/)[0].text, 'Custom target')
  const overview = matchingShapes(result.slides, /^overview-0-\d+$/)
  assert.ok(overview.some(shape => shape.text.includes('Captured withheld candidate')))
  assert.equal(matchingShapes(result.slides, /^review-0-0-overview-name$/)[0].text, 'Custom candidate')
  assert.doesNotMatch(result.text, /LEGACY-COMPOSITE/)
  assert.equal(JSON.stringify(report), original)
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertTargetNavigationAndOrder(report, result)
  assertReadableGeometry(result.slides)
  assertNoAuditProse(result)
})

test('160-unit aliases and long source identities remain bounded and linked in single- and multiple-job decks', async () => {
  for (const targetCount of [1, 2]) {
    const input = readablePptxFixture({ scores: [92.75], criterionCount: 6, targetCount })
    input.run.name = `${'Current analysis '.repeat(10).slice(0, 159)}Z`
    input.targets.forEach(target => {
      target.displayName = `${'Captured target '.repeat(10).slice(0, 159)}Z`
      target.label = 'LEGACY-COMPOSITE TITLE - OFFICE MUST NOT BE USED'
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
    const title = result.slides[0].shapes.find(shape => shape.name === 'job-reference')
    assert.equal(title.links[0].tooltip, input.run.name)
    assert.equal(result.slides[0].relationships.get(title.links[0].id),
      api.reportReviewLinks(report, report.groups[0].comparisons[0], PPTX_TEST_LINKS).analysis)
    for (const [index, group] of report.groups.entries()) {
      const links = api.reportReviewLinks(report, group.comparisons[0], PPTX_TEST_LINKS)
      const sourceTitle = matchingShapes(result.slides, new RegExp(`^target-${index}-source-title-part-`))
      assert.equal(sourceTitle.map(shape => shape.text).join(''), `Source target title: ${group.target.presentation.title}`)
      const sourceName = matchingShapes(result.slides, new RegExp(`^review-${index}-0-metadata-2$`))[0]
      assert.equal(sourceName.links[0].tooltip, `Source-stated name: ${group.comparisons[0].candidate.name}`)
      const sourceFile = matchingShapes(result.slides, new RegExp(`^review-${index}-0-metadata-1$`))[0]
      assert.equal(sourceFile.links[0].tooltip, `Source: ${group.comparisons[0].candidate.sourceLabel}`)
      const opener = result.slides.find(slide => slide.shapes.some(shape => shape.name === `target-${index}-title`))
      assert.equal(opener.shapes.find(shape => shape.name === `target-${index}-title`).text, group.target.displayName)
      const sourceLink = opener.shapes.find(shape => shape.name === `target-${index}-source-link`)
      assert.equal(opener.relationships.get(sourceLink.links[0].id), links.target)
    }
    assertOverviewCoverage(report, result)
    assertFeaturedContract(report, result)
    assertTargetNavigationAndOrder(report, result)
    assert.doesNotMatch(result.text, /LEGACY-COMPOSITE/)
    assertReadableGeometry(result.slides)
    assertNoAuditProse(result)
  }
})

test('fictional captured display labels support native local presentation review', async () => {
  for (const kind of ['aliases', 'long-aliases']) {
    const input = fictionalPptxFixture()
    input.run.name = kind === 'aliases' ? 'Fictional research shortlisting review'
      : `${'Fictional research analysis '.repeat(7).slice(0, 159)}Z`
    input.targets[0].displayName = kind === 'aliases' ? 'Survey methods vacancy'
      : `${'Captured survey research vacancy '.repeat(6).slice(0, 159)}Z`
    input.comparisons.forEach((comparison, index) => {
      comparison.candidate.displayName = kind === 'aliases' ? `Research applicant ${index + 1}`
        : `${'Captured research applicant '.repeat(7).slice(0, 158)} ${index + 1}`
    })
    const report = foundation.buildAnalysisReport(input)
    const bytes = await api.generatePptxReport(report, PPTX_SAMPLE_LINKS)
    const result = await inspectPptx(bytes)
    assertOverviewCoverage(report, result)
    assertFeaturedContract(report, result)
    assertTargetNavigationAndOrder(report, result)
    assertReadableGeometry(result.slides)
    if (process.env.REPORT_PPTX_QA_DIRECTORY) {
      await mkdir(process.env.REPORT_PPTX_QA_DIRECTORY, { recursive: true })
      await writeFile(join(process.env.REPORT_PPTX_QA_DIRECTORY, `score-pptx-${kind}.pptx`), bytes)
    }
  }
})

function assertOverviewCoverage(report, result, options = report.dataKind === 'sample' ? PPTX_SAMPLE_LINKS : PPTX_TEST_LINKS) {
  report.groups.forEach((group, groupIndex) => {
    const actual = []
    for (const slide of result.slides) {
      for (const table of slide.shapes.filter(shape => new RegExp(`^overview-${groupIndex}-\\d+$`).test(shape.name))) {
        assert.deepEqual(table.rows[0].cells.map(cell => cell.text), ['Name', 'Score', 'Assessment overview'])
        assert.equal(new Set(table.rows.slice(1).map(row => row.height)).size, 1, 'Overview rows use one measured height per page')
        for (const row of table.rows.slice(1)) {
          assert.ok(row.cells[0].links.length, 'Every overview name is a native review hyperlink')
          actual.push({
            name: row.cells[0].text,
            links: row.cells[0].links.map(link => ({
              url: slide.relationships.get(link.id), destination: slide.slideRelationships.get(link.id),
              tooltip: link.tooltip, action: link.action,
            })),
            score: row.cells[1].text,
            highlights: row.cells[2].text,
          })
        }
      }
    }
    const complete = group.comparisons.filter(comparison => comparison.status === 'complete')
    assert.equal(actual.length, complete.length, 'Every complete comparison appears once, with no unfinished rows')
    complete.forEach((comparison, index) => {
      const expectedLinks = api.reportReviewLinks(report, comparison, options)
      const analysis = actual[index].links.find(link => link.url === expectedLinks.analysis)
      assert.ok(analysis,
        'Overview retains supplied saved-score order and ties without reranking')
      const name = api.readableCandidateName(comparison.candidate)
      assert.equal(analysis.tooltip, comparison.candidate.displayName
        ? `${name} · Source-stated name: ${comparison.candidate.name ?? 'Not stated'} · Source: ${comparison.candidate.sourceLabel}`
        : name)
      if (actual[index].name !== api.readableCandidateName(comparison.candidate)) {
        const number = group.comparisons.indexOf(comparison) + 1
        assert.ok(actual[index].name.startsWith(`Candidate ${number}\n`), 'A candidate ordinal is a reference, not an invented person alias')
        assert.ok(actual[index].name.includes(comparison.candidate.sourceLabel) ||
          actual[index].name.includes(`Resume v${comparison.candidate.documentVersion}`), 'Long-name references retain source-document context')
        assert.ok(actual[index].links.some(link => link.url === expectedLinks.resume), 'The exact resume source remains linked')
        if (group.highlightedComparisonIds.includes(comparison.id)) {
          const overview = result.slides.findIndex(slide => slide.shapes.some(shape => shape.name === `review-${groupIndex}-${number - 1}-overview-name`)) + 1
          assert.ok(actual[index].links.some(link => link.action === 'ppaction://hlinksldjump' && link.destination === overview),
            'A featured long-name reference has a native link to its full identity slide')
        } else {
          assert.ok(actual[index].links.every(link => link.destination === undefined), 'Unfeatured candidates are never linked to another person or an invented slide')
        }
      }
      assert.equal(actual[index].score, comparison.overall.status === 'available' ? `${comparison.overall.score} / 100` : 'Withheld')
      assert.equal(actual[index].highlights, comparison.narrative.overview, 'The complete saved overview is used without criterion-score boilerplate')
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
      const names = matchingShapes(result.slides, new RegExp(`^${key}-(overview|assessment|scorecard|explanations)-name$`))
      assert.equal(names.length, featured ? 3 : 0, 'Only highlighted comparisons receive three individual slides, never extra continuations')
      if (!featured) return
      assert.equal(names[0].text, api.readableCandidateName(comparison.candidate), 'The overview preserves the complete candidate name')
      const overviewSlide = result.slides.findIndex(slide => slide.shapes.some(shape => shape.name === `${key}-overview-name`)) + 1
      for (const detail of result.slides.filter(slide => slide.shapes.some(shape =>
        new RegExp(`^${key}-(assessment|scorecard|explanations)-name$`).test(shape.name)))) {
        const heading = detail.shapes.find(shape => new RegExp(`^${key}-(assessment|scorecard|explanations)-heading$`).test(shape.name))
        assert.ok(heading, 'Each detail page has a visible candidate identity, not just a numbered breadcrumb')
        assert.ok(heading.fonts.every(size => size >= 18), 'Candidate context is not tiny text')
        const back = detail.shapes.find(shape => new RegExp(`^${key}-(assessment|scorecard|explanations)-overview-link$`).test(shape.name))
        if (!heading.text.includes(api.readableCandidateName(comparison.candidate))) {
          assert.match(heading.text, new RegExp(`^Candidate ${index + 1}(?: · |$)`))
          assert.ok(heading.text.includes(comparison.candidate.sourceLabel) ||
            heading.text.includes(`Resume v${comparison.candidate.documentVersion}`), 'Compact identities include a complete source label or versioned resume reference')
          assert.ok(back, 'A long-name reference always has a native route back to the full candidate identity')
        }
        if (back) {
          assert.equal(back.text, 'Back to candidate overview')
          assert.equal(back.links[0].action, 'ppaction://hlinksldjump')
          assert.equal(detail.slideRelationships.get(back.links[0].id), overviewSlide,
            'Candidate backlinks resolve to the correct final overview slide')
        }
      }
      const summaries = matchingShapes(result.slides, new RegExp(`^${key}-summary$`))
      assert.equal(summaries.length, 1)
      assert.equal(summaries[0].text, comparison.narrative.text, 'The complete saved candidate assessment appears exactly once')
      assert.doesNotMatch(summaries[0].text, /(?:\d+\s*\/\s*5)|Criterion evidence:|\.{3}|…/)
      const tables = matchingShapes(result.slides, new RegExp(`^${key}-scorecard-table$`))
      assert.equal(tables.length, 1)
      const combined = names.some(shape => shape.name.endsWith('-assessment-name'))
      assert.deepEqual(tables[0].rows[0].cells.map(cell => cell.text), ['Criterion', 'Weight', 'Score', ...(combined ? ['Evidence'] : [])])
      if (combined) assert.equal(new Set(tables[0].rows.slice(1).map(row => row.height)).size, 1,
        'Combined scorecard rows reserve the largest measured height without shrinking any text')
      const displayed = tables[0].rows.slice(1).map(row => Number(row.cells[0].text.match(/^C(\d+)\b/)[1]))
      const explanations = matchingShapes(result.slides, new RegExp(`^${key}-criterion-\\d+-explanation$`))
      if (!combined) assert.deepEqual(explanations.map(shape => Number(shape.name.match(/criterion-(\d+)/)[1])), displayed,
        'Every selected criterion has a complete explanation or an explicit full-detail link in original order')
      for (const explanation of explanations) {
        const number = Number(explanation.name.match(/criterion-(\d+)/)[1])
        const score = comparison.criteria.find(criterion => criterion.criterionId === group.target.criteria[number - 1].id)
        const label = score.evidenceStatus === 'not-applicable' ? 'N/A' : foundation.criterionScoreLabel(score)
        const heading = matchingShapes(result.slides, new RegExp(`^${key}-criterion-${number}-heading$`))[0]
        assert.ok(heading.text.includes(`C${number}`) && heading.text.includes(label),
          'Every explanation identifies the criterion and its saved score without requiring the previous slide')
        assert.ok(heading.box.y + heading.box.h < explanation.box.y, 'Criterion headings and explanation bodies occupy separate text boxes')
        assert.doesNotMatch(heading.text, /[—-]\s*$/u, 'There is no dangling generated separator dash')
        assert.doesNotMatch(`${heading.text} ${explanation.text}`, /\.{3}|…/, 'No criterion label or evidence sentence is chopped')
        if (explanation.text.includes('View the full saved explanation.')) assert.ok(explanation.links.length)
        else assert.ok(explanation.text.includes(score.rationale), 'A selected rationale is preserved in full')
      }
      const criterionHeadings = matchingShapes(result.slides, new RegExp(`^${key}-criterion-\\d+-heading$`))
      const left = criterionHeadings.filter(shape => shape.box.x < 2), right = criterionHeadings.filter(shape => shape.box.x > 2)
      for (let row = 0; row < Math.min(left.length, right.length); row++) {
        assert.equal(left[row].box.y, right[row].box.y, 'Paired left/right evidence blocks start on the same measured row')
      }
      const fullScorecardLinks = matchingShapes(result.slides, new RegExp(`^${key}-link-3$`))
      const keyCriteria = matchingShapes(result.slides, new RegExp(`^${key}-scorecard-heading$`))[0].text.includes('Key criteria')
      const linkedDetails = tables[0].rows.slice(1).some(row => row.cells.some(cell => cell.links.length))
        || explanations.some(shape => shape.links.length)
        || matchingShapes(result.slides, new RegExp(`^${key}-qualification-notes$`)).some(shape => shape.links.length)
      assert.equal(fullScorecardLinks.length, keyCriteria || linkedDetails ? 3 : 0)
      assert.ok(fullScorecardLinks.every(shape => shape.text === 'View full scorecard' && shape.links.length > 0))
      const reviews = api.criterionReviews(group.target, comparison, 150)
      assert.deepEqual(displayed, api.selectKeyCriteria(reviews, displayed.length).map(criterion => criterion.number),
        'Presentation preserves the shared importance selection and original criterion numbers')
    })
  })
  assert.equal(matchingShapes(result.slides, /^review-\d+-\d+-(overview|assessment|scorecard|explanations)-name$/).length, expected.size * 3)
}

function assertTargetNavigationAndOrder(report, result) {
  assert.equal(matchingShapes(result.slides, /^cover-candidates-count$/)[0].text,
    String(new Set(report.groups.flatMap(group => group.comparisons).filter(item => item.status === 'complete').map(item => item.candidate.id)).size))
  assert.equal(matchingShapes(result.slides, /^cover-targets-count$/)[0].text, String(report.groups.length))
  assert.equal(matchingShapes(result.slides, /^cover-targets-label$/)[0].text, 'Jobs / grades\nExact saved targets')
  assert.equal(matchingShapes(result.slides, /^cover-comparisons-count$/)[0].text, String(report.counts.complete))
  const cover = result.slides[0]
  assert.equal(cover.shapes.filter(shape => /^cover-(candidates|targets|comparisons)-card$/.test(shape.name)).length, 3)
  assert.ok(cover.shapes.filter(shape => /^cover-(people|analyses|comparisons)-\d/.test(shape.name)).length >= 9)
  assert.ok(!cover.shapes.some(shape => /^target-|^review-|^agenda-/.test(shape.name)), 'The cover remains a short graphical introduction')
  const contents = result.slides.filter(slide => slide.shapes.some(shape => /^agenda-\d+-title$/.test(shape.name)))
  contents.forEach((slide, index) => {
    assert.equal(slide.shapes.find(shape => shape.name === 'slide-title').text,
      contents.length > 1 ? `Contents · ${index + 1} of ${contents.length}` : 'Contents')
  })
  let previousEnd = 0
  report.groups.forEach((group, index) => {
    const entrySlide = result.slides.find(slide => slide.shapes.some(shape => shape.name === `agenda-${index}-title`))
    const entry = entrySlide.shapes.find(shape => shape.name === `agenda-${index}-title`)
    assert.equal(entry.text, group.target.displayName ?? group.target.presentation.title)
    if (group.target.presentation.organization) {
      assert.equal(entrySlide.shapes.find(shape => shape.name === `agenda-${index}-organization`).text, group.target.presentation.organization)
    }
    assert.equal(entry.links[0].action, 'ppaction://hlinksldjump')
    const number = entrySlide.slideRelationships.get(entry.links[0].id)
    const opener = result.slides[number - 1]
    assert.ok(opener, 'Agenda targets an existing final slide')
    assert.equal(opener.shapes.find(shape => shape.name === `target-${index}-title`).text, group.target.displayName ?? group.target.presentation.title,
      'Duplicate titles still link to the exact target, including final pagination')
    if (group.target.presentation.organization) {
      assert.equal(opener.shapes.find(shape => shape.name === `target-${index}-organization`).text, group.target.presentation.organization)
    }
    const contents = opener.shapes.find(shape => shape.name === `target-${index}-contents-link`)
    assert.equal(opener.slideRelationships.get(contents.links[0].id), result.slides.indexOf(entrySlide) + 1)
    assert.equal(contents.links[0].action, 'ppaction://hlinksldjump')
    const source = opener.shapes.find(shape => shape.name === `target-${index}-source-link`)
    const options = report.dataKind === 'sample' ? PPTX_SAMPLE_LINKS : PPTX_TEST_LINKS
    assert.equal(opener.relationships.get(source.links[0].id), api.reportReviewLinks(report, group.comparisons[0], options).target)
    assert.equal(matchingShapes(result.slides, new RegExp(`^target-${index}-description-part-`)).map(shape => shape.text).join(''),
      api.keepPptxParagraphEndWordsTogether(group.target.presentation.description,
        api.PPTX_LAYOUT.width - 2 * api.PPTX_LAYOUT.margin, api.PPTX_LAYOUT.bodyFontSize),
      'Job context preserves the full source with display-only nonbreaking paragraph endings')
    group.target.narrative?.paragraphs.forEach((paragraph, paragraphIndex) => {
      assert.equal(matchingShapes(result.slides, new RegExp(`^target-${index}-narrative-${paragraphIndex}-part-`))
        .map(shape => shape.text).join(''), paragraph, 'Complete saved target prose survives all description pagination')
    })
    const reviewSlides = result.slides.map((slide, slideIndex) => slide.shapes.some(shape =>
      new RegExp(`^review-${index}-\\d+-(overview|assessment|scorecard|explanations)-name$`).test(shape.name)) ? slideIndex : -1).filter(value => value >= 0)
    const glanceSlides = result.slides.map((slide, slideIndex) => slide.shapes.some(shape =>
      new RegExp(`^overview-${index}-\\d+$`).test(shape.name)) ? slideIndex : -1).filter(value => value >= 0)
    assert.ok(number - 1 > previousEnd, 'Each exact target starts after the preceding entire section')
    if (reviewSlides.length) assert.ok(Math.min(...reviewSlides) > number - 1 && Math.max(...reviewSlides) < Math.min(...glanceSlides),
      'Each target keeps its opener, featured details, and all-candidate glance pages contiguous')
    previousEnd = glanceSlides.at(-1) ?? number - 1
  })
}

function assertNoAuditProse(result) {
  const generatedText = result.slides.flatMap(slide => slide.shapes
    .filter(shape => !/^target-\d+-(?:narrative|description)-|^review-\d+-\d+-summary$/.test(shape.name))
    .map(shape => shape.text)).join('\n')
  assert.doesNotMatch(result.text, /Partial report|(?:^|\n)PARTIAL(?:\n|$)|Highest evidence matches|Report context|Criterion evidence|Saved review context/i)
  assert.doesNotMatch(result.slides.flatMap(slide => slide.shapes.filter(shape => /^review-/.test(shape.name)).map(shape => shape.text)).join('\n'),
    /continued/i, 'Job context may continue; candidate reviews never acquire continuation slides')
  assert.doesNotMatch(generatedText, /\brank(?:ed|ing|s)?\b|cutoff|highlight list|highlighted match|capped|top five/i)
  assert.doesNotMatch(result.text, /Run ID|Candidate ID|Comparison ID|Rubric:|Target snapshot|SHA-256|capture interval|Assessment model|Grounding review/i)
  assert.doesNotMatch(result.text, /workspace-one|run-one|comparison-\d+|candidate-\d+|criterion-\d+|rubric-\d+|snapshot-|saved-model-version/)
  assert.equal((result.text.match(/Analysis evidence report/g) ?? []).length, 1)
  assert.equal((result.text.match(/Human review required/g) ?? []).length, 1)
  assert.equal((result.text.match(/not hiring decisions/g) ?? []).length, 1)
}

test('editable widescreen deck separates graphical cover, agenda, job context, featured reviews, and all-completed glance', async () => {
  const report = foundation.buildAnalysisReport(readablePptxFixture({ scores: [92.75, 87, 0, null], criterionCount: 6 }))
  const original = JSON.stringify(report)
  const result = await inspectReport(report)
  assert.equal(JSON.stringify(report), original, 'The writer does not alter saved scores, ordering, or highlight membership')
  assert.match(result.entries.get('[Content_Types].xml').toString(), /presentationml\.presentation\.main\+xml/)
  assert.match(result.entries.get('ppt/presentation.xml').toString(), /<p:sldSz cx="12192000" cy="6858000"/)
  assert.ok(result.entries.has('ppt/theme/theme1.xml'))
  assert.ok([...result.entries.keys()].every(name => !name.startsWith('ppt/media/') && !name.startsWith('ppt/embeddings/')))
  assert.doesNotMatch(result.slides[0].text, /Research analyst|Example Research Office|Reporting on/)
  assert.match(result.slides[1].text, /Contents|Reporting on 4 of 4 candidates/)
  assert.match(result.slides[0].text, /Analysis date: Sep 18, 2026/)
  assert.equal(matchingShapes(result.slides, /^target-0-title$/).length, 1, 'Even a single job has a distinct opener')
  assertTargetNavigationAndOrder(report, result)
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
  assert.match(result.text, /statistical reporting pipelines/)
  assert.doesNotMatch(result.text, /Summary excerpt|Exact saved rationale|Full saved overall assessment/)
})

test('ordinary candidate overviews show saved prose while scorecards retain complete strengths and gaps', async () => {
  const report = foundation.buildAnalysisReport(fictionalPptxFixture())
  const result = await inspectReport(report)
  const overview = result.slides.find(slide => slide.shapes.some(shape => shape.name === 'review-0-0-overview-name'))
  const summary = overview.shapes.find(shape => shape.name === 'review-0-0-summary').text
  assert.equal(summary, report.groups[0].comparisons[0].narrative.text)
  assert.match(summary, /survey|sampling/i)
  assert.match(summary, /department-wide team leadership is not established/i)
  assert.doesNotMatch(summary, /\.{3}|…|C\d+|\/ 5/, 'Saved prose is not a scorecard concatenation')
  assert.doesNotMatch(overview.text, /(?:^|\n)(?:Supported|Partial evidence|Missing evidence)(?:\n|$)/)
  assert.doesNotMatch(overview.text, /View full scorecard/, 'Ordinary overviews keep just the three useful source/review links')
  assertReadableGeometry(result.slides)
  const large = await inspectReport(foundation.buildAnalysisReport(fictionalPptxFixture('large')))
  const gap = matchingShapes(large.slides, /^review-0-0-criterion-\d+-explanation$/)
    .find(shape => shape.text.includes('no example of leading'))
  assert.match(gap.text, /leading the national household survey team\./)
  assert.doesNotMatch(gap.text, /\.{3}|…/)
  assertReadableGeometry(large.slides)
})

test('legacy processing-only summaries are ignored rather than used to manufacture a new assessment', async () => {
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
  assert.match(overview.text, /validation of sampling plans/)
  assert.match(overview.text, /Department-wide team leadership is not established/)
  assert.equal((overview.text.match(/validation of sampling plans/g) ?? []).length, 1)
  assert.equal(overview.shapes.find(shape => shape.name === 'review-0-0-summary').text,
    report.groups[0].comparisons[0].narrative.text)
  assert.ok(!overview.shapes.some(shape => shape.name === 'review-0-0-highlights-panel'))
  assertNoAuditProse(result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
})

test('overview rows preserve the complete saved Unicode sentence and its limitation clause', async () => {
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
  comparison.narrative = {
    text: 'The record documents regional research design and a tested sampling approach. Those examples support the submitted statistical work. Cross-department team leadership is not established in the evidence.',
    overview: 'The record describes 地域調査の設計と対象集団の標本抽出について、具体的な分析手順と検証記録が記載されています, but 部門横断チームの指揮経験は提出書類では確認されていません.',
  }
  const report = foundation.buildAnalysisReport(input)
  const expected = comparison.narrative.overview
  const result = await inspectReport(report)
  const table = matchingShapes(result.slides, /^overview-0-0$/)[0]
  assert.equal(table.rows[1].cells[2].text, expected, 'The writer preserves the complete saved overview')
  assert.match(table.rows[1].cells[2].text, /指揮経験は提出書類では確認されていません\./)
  assert.ok(table.rows[1].height > 0.94, 'Wide text receives a taller measured row rather than another excerpt')
  assertOverviewCoverage(report, result)
  assertFeaturedContract(report, result)
  assertTargetNavigationAndOrder(report, result)
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
  assertTargetNavigationAndOrder(report, result)
  assert.match(result.text, /Section 1 · Job analysis/)
  assert.match(result.text, /Section 2 · Job analysis/)
  assert.match(result.slides[1].text, /Reporting on 6 of 6 candidate-job reviews/)
  assert.equal(matchingShapes(result.slides, /^target-\d+-title$/).length, 2)
})

test('duplicate job labels never expand legacy office and rubric sublabels into the canonical slide title', async () => {
  const input = readablePptxFixture({ scores: [91], targetCount: 2, criterionCount: 2 })
  const title = 'Survey Statistician - Longitudinal Methods'
  const offices = [
    'Census Bureau / National Processing Center for Survey Operations',
    'Census Bureau / Regional Office for Statistical Research and Methods',
  ]
  input.targets.forEach((target, index) => {
    target.label = title
    target.sublabel = `${offices[index]} · Legacy saved rubric context ${index + 1}`
    target.presentation = {
      ...target.presentation, title, organization: offices[index], versionLabel: `Approved survey rubric v${index + 1}`,
    }
  })
  const savedSummaries = new Map(input.comparisons.map(comparison => [comparison.id, comparison.summary]))
  const report = foundation.buildAnalysisReport(input)
  report.groups.forEach(group => {
    assert.equal(api.readableTargetLabel(report, group), `${title} - ${group.target.sublabel}`,
      'The legacy duplicate-label expansion remains unchanged for CSV')
    for (const comparison of group.comparisons) {
      assert.equal(comparison.summary, savedSummaries.get(comparison.id), 'Fixture narrative fields do not overwrite saved legacy summaries')
    }
  })
  const original = JSON.stringify(report)
  const result = await inspectReport(report)
  assert.equal(JSON.stringify(report), original)
  assertTargetNavigationAndOrder(report, result)
  assertReadableGeometry(result.slides)
  assert.doesNotMatch(result.text, /Legacy saved rubric context/)
  assert.equal(matchingShapes(result.slides, /^target-\d+-title$/).filter(shape => shape.text === title).length, 2)
  offices.forEach((office, index) => {
    assert.equal(matchingShapes(result.slides, new RegExp(`^target-${index}-organization$`))[0].text, office)
    assert.match(matchingShapes(result.slides, new RegExp(`^target-${index}-metadata$`))[0].text,
      new RegExp(`Approved survey rubric v${index + 1}`))
  })
})

test('native agenda links resolve final positions after long titles, descriptions, and duplicate-grade pagination', async () => {
  const input = readablePptxFixture({ scores: [87], targetCount: 7, criterionCount: 3, kind: 'grade' })
  const title = 'Survey Statistician - National Survey Design, Longitudinal Methods, and Integrated Research Operations'
  const organization = 'United States Department of Commerce / Census Bureau / National Processing Center for Survey Operations and Statistical Methods'
  input.targets.forEach((target, index) => {
    target.label = 'Legacy combined title - Must not replace the frozen presentation'
    target.selection.grade = index % 2 ? 12 : 13
    target.presentation = {
      title, organization, series: '1530', grade: `GS-${target.selection.grade}`,
      versionLabel: `Approved grade rubric v${index + 1}`,
      description: `${'The frozen job overview covers survey design, sampling methods, analytical delivery, and coordination of statistical research. '.repeat(index + 3)}Final frozen description sentence ${index + 1}.`,
    }
    target.narrative = { paragraphs: [
      'The reviewed record documents practical analytical delivery and reproducible research methods. These examples support survey research within the captured scope.',
      'Leadership of larger programs is not established in the submitted evidence. Reviewers should verify that scope before drawing conclusions about the separate grade requirements.',
    ] }
  })
  const report = foundation.buildAnalysisReport(input)
  const original = JSON.stringify(report)
  const result = await inspectReport(report)
  assert.equal(JSON.stringify(report), original)
  assertTargetNavigationAndOrder(report, result)
  assertFeaturedContract(report, result)
  assertOverviewCoverage(report, result)
  assertReadableGeometry(result.slides)
  assert.ok(matchingShapes(result.slides, /^slide-title$/).filter(shape => /^Contents(?: · \d+ of \d+)?$/.test(shape.text)).length > 1,
    'Measured agenda entries overflow to additional linked pages')
  assert.ok(matchingShapes(result.slides, /^target-6-description-part-/).length > 1, 'Long frozen context continues outside candidate budgets')
  assert.doesNotMatch(result.text, /Legacy combined title|\.{3}|…/)
  assert.match(result.text, /Grade: GS-12/)
  assert.match(result.text, /Grade: GS-13/)
  assert.match(result.text, /Approved grade rubric v7/)
})

test('an exact-target export has distinct cover, agenda, and opener and ignores other targets pending work', async () => {
  const input = readablePptxFixture({ scores: [91], targetCount: 2, criterionCount: 2 })
  const other = input.comparisons.find(comparison => comparison.targetId === 'target-0')
  Object.assign(other, {
    status: 'running', completion: null, summary: null, coverage: null, analyzedAt: null, resultSha256: null,
    overall: { status: 'unavailable', score: null, reason: 'not-complete', message: 'Scoring remains in progress.' },
    criteria: [], qualifications: [], limitations: [], provenance: [],
  })
  const report = foundation.buildAnalysisReport(input, { targetId: 'target-1' })
  const result = await inspectReport(report)
  assert.equal(report.groups.length, 1)
  assertTargetNavigationAndOrder(report, result)
  assert.ok(result.slides[0].shapes.some(shape => shape.name === 'cover-targets-count'))
  assert.ok(result.slides[1].shapes.some(shape => shape.name === 'agenda-0-title'))
  assert.ok(result.slides[2].shapes.some(shape => shape.name === 'target-0-title'))
  assert.equal(result.slides[1].slideRelationships.get(result.slides[1].shapes.find(shape => shape.name === 'agenda-0-title').links[0].id), 3)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
})

test('real exports fail closed for missing, stale, malformed, pending, or inconsistent saved summaries', async () => {
  const report = foundation.buildAnalysisReport(readablePptxFixture({ scores: [91, null], criterionCount: 2 }))
  for (const change of [
    value => { delete value.capture.summaries },
    value => { value.capture.summaries.ready = false },
    value => { delete value.groups[0].comparisons[0].narrative },
    value => { delete value.groups[0].target.narrative },
    value => { value.groups[0].comparisons[0].narrative.revision = 'b'.repeat(64) },
    value => { value.groups[0].target.narrative.inputFingerprint = 'c'.repeat(64) },
    value => { value.groups[0].comparisons[0].narrative.text = 'Only an incomplete fragment' },
    value => { value.groups[0].comparisons[0].narrative.overview = 'A clipped explanation...' },
    value => { value.capture.summaries.comparisons[1].resultSha256 = 'b'.repeat(64) },
    value => { value.capture.summaries.comparisons.pop() },
    value => { value.capture.summaries.scope.targetId = 'target-0' },
    value => { delete value.groups[0].target.presentation },
  ]) {
    const invalid = structuredClone(report)
    change(invalid)
    await assert.rejects(api.generatePptxReport(invalid, PPTX_TEST_LINKS), /No PDF, Word, or PowerPoint report was produced|Manage summaries/)
  }
  for (const status of ['queued', 'running']) {
    assert.throws(() => foundation.buildAnalysisReport(readablePptxFixture({ scores: [91, 0], statuses: ['complete', status] })),
      /ready narrative capture/, 'An unsettled selected capture is rejected before reaching the writer')
  }
  const unsettledInput = readablePptxFixture({ scores: [91], criterionCount: 2, targetCount: 2 })
  const unfinished = unsettledInput.comparisons[1]
  Object.assign(unfinished, {
    status: 'cancelled', completion: null, summary: null, coverage: null, analyzedAt: null, resultSha256: null,
    overall: { status: 'unavailable', score: null, reason: 'not-complete', message: 'Cancelled before assessment.' },
    criteria: [], qualifications: [], limitations: [], provenance: [],
  })
  const missingUnassessedPin = foundation.buildAnalysisReport(unsettledInput)
  missingUnassessedPin.capture.summaries.comparisons.pop()
  await assert.rejects(api.generatePptxReport(missingUnassessedPin, PPTX_TEST_LINKS), /No PDF, Word, or PowerPoint report was produced/,
    'Readiness validates the original captured unassessed groups, not just completed presentation rows')
})

test('unassessed reasons appear once and unfinished candidates never gain overview rows or individual reviews', async () => {
  const input = readablePptxFixture({
    scores: Array(105).fill(84), criterionCount: 1,
    statuses: [...Array(95).fill('complete'), ...Array(8).fill('failed'), 'cancelled', 'cancelled'],
  })
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  assert.match(result.slides[1].text, /Reporting on 95 of 105 candidates/)
  for (const phrase of ['8 could not be assessed', '2 cancelled']) {
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
      status: 'cancelled', completion: null, summary: null, coverage: null, analyzedAt: null, resultSha256: null,
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

test('long full names, linked role/source metadata, saved prose, GS concerns, and 100 criteria stay within three candidate slides', async () => {
  for (const count of [6, 100]) {
    const input = longPptxFixture(count)
    const report = foundation.buildAnalysisReport(input)
    const result = await inspectReport(report)
    assert.equal(matchingShapes(result.slides, /^review-0-0-(overview|assessment|scorecard|explanations)-name$/).length, 3)
    assertOverviewCoverage(report, result)
    assertFeaturedContract(report, result)
    assertNoAuditProse(result)
    assertReadableGeometry(result.slides)
    assertTargetNavigationAndOrder(report, result)
    assert.match(result.text, /Key criteria/)
    assert.match(result.text, /View full scorecard/)
    assert.match(result.text, /Unscored qualification caveats/)
    assert.match(result.text, /Duration of specialized experience/)
    const notes = matchingShapes(result.slides, /^review-0-0-qualification-notes$/)
    assert.equal(notes.length, 1)
    assert.doesNotMatch(notes[0].text, /\/ 5|\/ 100|Weight:/)
    const name = matchingShapes(result.slides, /^review-0-0-overview-name$/)[0]
    assert.equal(name.text, input.comparisons[0].candidate.name, 'The long name stays complete on the identity slide')
    const source = matchingShapes(result.slides, /^review-0-0-metadata-1$/)[0]
    if (source) {
      assert.equal(source.links[0].tooltip, `Source: ${input.comparisons[0].candidate.sourceLabel}`)
      assert.equal(source.text, `Source: Resume v${input.comparisons[0].candidate.documentVersion}`)
    }
    const resumeLinks = matchingShapes(result.slides, /^review-0-0-link-1$/)
    assert.ok(resumeLinks.every(shape => shape.links[0].tooltip.includes(input.comparisons[0].candidate.sourceLabel)))
    assert.doesNotMatch(result.text, /\.{3}|…/, 'No identity or paragraph is silently abbreviated')
    assert.doesNotMatch(result.text, /fictional engineering quotation|Additional saved research methods and evidence details remain/)
    const table = matchingShapes(result.slides, /^review-0-0-scorecard-table$/)[0]
    const displayed = table.rows.slice(1).map(row => Number(row.cells[0].text.match(/^C(\d+)\b/)[1]))
    assert.ok(displayed.length < count)
    const reviews = api.criterionReviews(report.groups[0].target, report.groups[0].comparisons[0], 150)
    assert.deepEqual(displayed, api.selectKeyCriteria(reviews, displayed.length).map(criterion => criterion.number),
      'Oversized scorecards use the balanced shared selection and original criterion numbers')
  }
})

test('a full 900-character candidate paragraph and 100 oversized criterion records use complete prose and explicit detail links', async () => {
  const input = longPptxFixture(100)
  const comparison = input.comparisons[0]
  const narrative = comparison.narrative.text
  assert.ok(narrative.length <= 900)
  const addition = 'W'.repeat(900 - narrative.length)
  comparison.narrative.text = narrative.replace('survey design', `survey${addition} design`)
  assert.equal(comparison.narrative.text.length, 900)
  input.targets[0].criteria.forEach((criterion, index) => {
    criterion.label = `Research requirement ${index + 1} ${'Long-form documented analytical responsibility '.repeat(90)}`
  })
  comparison.criteria.forEach(criterion => {
    criterion.rationale = 'The full saved explanation documents the reviewed analytical work and the boundaries of the available source evidence. '.repeat(70)
  })
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  assertFeaturedContract(report, result)
  assertOverviewCoverage(report, result)
  assertReadableGeometry(result.slides)
  const summary = matchingShapes(result.slides, /^review-0-0-summary$/)[0]
  assert.equal(summary.text, comparison.narrative.text)
  assert.match(result.text, /View full criterion|View the full saved explanation/)
  assert.match(result.text, /Duration of specialized experience needs verification/)
  assert.doesNotMatch(result.text, /\.{3}|…/)
  assert.equal(matchingShapes(result.slides, /^review-0-0-(overview|assessment|scorecard|explanations)-name$/).length, 3)
})

test('long names use complete source labels or versioned resume references, never invented person aliases', async () => {
  for (const sourceLabel of ['Resume.pdf', `Captured resume ${'W'.repeat(300)}.pdf`]) {
    const input = readablePptxFixture({ scores: [91, null], criterionCount: 2 })
    input.comparisons.forEach(comparison => {
      comparison.candidate.name = `${'W'.repeat(350)} ${comparison.candidate.id}`
      comparison.candidate.sourceLabel = sourceLabel
    })
    const report = foundation.buildAnalysisReport(input)
    const result = await inspectReport(report)
    assertOverviewCoverage(report, result)
    assertFeaturedContract(report, result)
    assertReadableGeometry(result.slides)
    const identity = matchingShapes(result.slides, /^review-0-0-overview-name$/)[0]
    assert.equal(identity.text, input.comparisons[0].candidate.name)
    const compact = matchingShapes(result.slides, /^review-0-0-(assessment|scorecard)-heading$/)
    assert.ok(compact.every(shape => shape.text.includes(sourceLabel === 'Resume.pdf' ? sourceLabel : 'Resume v2')))
    const source = matchingShapes(result.slides, /^review-0-0-metadata-1$/)[0]
    assert.ok(source, 'A long identity gives its source document priority over an unrenderable recorded role')
    assert.doesNotMatch(result.text, /View full name|View resume source|\.{3}|…/)
  }
})

test('impossible full identity geometry fails visibly instead of clipping, shrinking below readable sizes, or adding candidate slides', async () => {
  const input = readablePptxFixture({ scores: [91], criterionCount: 2 })
  input.comparisons[0].candidate.name = 'W'.repeat(8192)
  await assert.rejects(api.generatePptxReport(foundation.buildAnalysisReport(input), PPTX_TEST_LINKS),
    /full candidate name.*readable sizes within three slides/)
  input.comparisons[0].candidate.name = 'Readable Example'
  input.targets[0].presentation.title = 'Unusually wide frozen title '.repeat(200)
  await assert.rejects(api.generatePptxReport(foundation.buildAnalysisReport(input), PPTX_TEST_LINKS),
    /full job title, organization, and version at a readable size/)
})

test('bounded single and multi-target long-title fixtures generate real decks for private visual QA', async () => {
  for (const kind of ['single-long', 'multi-long', 'long-candidate', 'dense']) {
    const report = foundation.buildAnalysisReport(powerpointLayoutFixture(kind))
    const result = await inspectReport(report)
    assertTargetNavigationAndOrder(report, result)
    assertFeaturedContract(report, result)
    assertOverviewCoverage(report, result)
    assertReadableGeometry(result.slides)
    assert.ok(result.slides.length < 30)
    assert.doesNotMatch(result.text, /\.{3}|…/)
  }
})

test('visual QA context pages break at complete sentences and do not repeat the slide title as a body heading', async () => {
  const report = foundation.buildAnalysisReport(powerpointLayoutFixture('multi-long'))
  const result = await inspectReport(report)
  assertTargetNavigationAndOrder(report, result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
  report.groups.forEach((group, index) => {
    const boundaries = new Set(Array.from(segmenter.segment(group.target.presentation.description),
      sentence => sentence.index + sentence.segment.length))
    let end = 0
    const fragments = matchingShapes(result.slides, new RegExp(`^target-${index}-description-part-`))
    assert.ok(fragments.length > 1)
    for (const fragment of fragments) {
      end += fragment.text.length
      assert.ok(boundaries.has(end), `Job context ends at a complete sentence, not ${JSON.stringify(fragment.text.slice(-35))}`)
    }
    for (const fragment of fragments.slice(1)) {
      const slide = result.slides.find(item => item.shapes.includes(fragment))
      assert.match(slide.shapes.find(shape => shape.name === 'slide-title').text, /Job context \(continued\)/)
    }
  })
  for (const slide of result.slides) {
    const title = slide.shapes.find(shape => shape.name === 'slide-title')?.text
    if (title === 'Analysis overview' || title === 'Job context') {
      assert.equal(slide.shapes.filter(shape => shape.text === title).length, 1, 'A section title is not duplicated immediately below itself')
    }
  }
})

test('separate evidence headings remove dangling separators and avoid the reviewed one-word explanation widow', async () => {
  const report = foundation.buildAnalysisReport(powerpointLayoutFixture('single-long'))
  const result = await inspectReport(report)
  const explanation = matchingShapes(result.slides, /^review-0-1-criterion-2-explanation$/)[0]
  const heading = matchingShapes(result.slides, /^review-0-1-criterion-2-heading$/)[0]
  assert.equal(explanation.text, report.groups[0].comparisons[1].criteria[1].rationale)
  assert.equal(heading.text, 'C2 · Statistical analysis · 4 / 5')
  const lines = api.measurePptxText(explanation.text, explanation.box.w, 14).lines
  assert.ok(explanation.text.slice(lines.at(-1).start, lines.at(-1).end).trim().split(/\s+/u).length >= 2,
    'The complete standalone rationale no longer strands team. on its own line')
  assertFeaturedContract(report, result)
  assertOverviewCoverage(report, result)
  assertReadableGeometry(result.slides)
})

test('job-context paragraph endings keep program delivery together without editing stored prose or font sizes', async () => {
  for (const kind of ['single-long', 'multi-long']) {
    const report = foundation.buildAnalysisReport(powerpointLayoutFixture(kind))
    const original = JSON.stringify(report)
    const result = await inspectReport(report)
    assert.equal(JSON.stringify(report), original, 'The widow fix changes only presentation whitespace, never frozen source text')
    report.groups.forEach((group, index) => {
      const fragments = matchingShapes(result.slides, new RegExp(`^target-${index}-description-part-`))
      const displayed = fragments.map(fragment => fragment.text).join('')
      assert.equal(displayed.replace(/\u00a0/g, ' '), group.target.presentation.description)
      assert.equal((displayed.match(/program\u00a0delivery\./g) ?? []).length, 2,
        'Both repeated frozen context paragraphs keep their final two words together in native PowerPoint text')
      for (const fragment of fragments) {
        assert.ok(fragment.fonts.every(size => size === 16), 'Job-context body text is not reduced')
        const lines = api.measurePptxText(fragment.text, fragment.box.w, 16).lines
        assert.ok(lines.every(line => fragment.text.slice(line.start, line.end).trim() !== 'delivery.'))
      }
    })
    assertTargetNavigationAndOrder(report, result)
    assertFeaturedContract(report, result)
    assertReadableGeometry(result.slides)
  }
})

test('a sentence longer than a full context page retains all text and has explicit continuation labels on both sides', async () => {
  const input = readablePptxFixture({ scores: [91], criterionCount: 2 })
  input.targets[0].presentation.description = 'The frozen job overview covers ' +
    'documented survey development methods, independently reviewable analytical decisions, and the boundaries of the captured evidence, '.repeat(35) +
    'with every source detail retained for human review.'
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  const parts = result.slides.filter(slide => slide.shapes.some(shape => /^target-0-description-part-/.test(shape.name)))
  assert.ok(parts.length > 2)
  for (const slide of parts.slice(0, -1)) {
    assert.ok(slide.shapes.some(shape => /-continuation-note$/.test(shape.name) && shape.text === 'Continues on next slide'))
  }
  for (const slide of parts.slice(1)) {
    assert.match(slide.shapes.find(shape => shape.name === 'slide-title').text, /Job context \(continued\)/)
  }
  assertTargetNavigationAndOrder(report, result)
  assertFeaturedContract(report, result)
  assertReadableGeometry(result.slides)
})

test('scorecards distinguish exact zero, N/A, not assessed, and positive fractional weights', async () => {
  const input = readablePptxFixture({ scores: [0], criterionCount: 5, kind: 'grade' })
  const comparison = input.comparisons[0]
  const weights = [0, 0.001, 49.999, 0, 50]
  const statuses = ['not-applicable', 'supported', 'missing', 'not-assessed', 'supported']
  const rationales = [
    'Not required for this assignment.',
    'Applied statistical methods in research.',
    'No team leadership evidence is recorded.',
    'Training details were not assessable.',
    'Delivered a regional research program.',
  ]
  comparison.criteria.forEach((criterion, index) => {
    input.targets[0].criteria[index].weight = weights[index]
    Object.assign(criterion, {
      weight: weights[index], evidenceStatus: statuses[index],
      score: ['not-applicable', 'not-assessed'].includes(statuses[index]) ? null : statuses[index] === 'missing' ? 0 : 4,
      citations: ['not-applicable', 'not-assessed', 'missing'].includes(statuses[index]) ? [] : [reportFixtureCitation(comparison.candidate.documentId)],
      limitation: statuses[index] === 'not-assessed' ? { code: 'source-limited', message: 'Training details were not assessable.' } : null,
      rationale: rationales[index],
    })
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
  input.comparisons[0].narrative = {
    text: 'Designed a bilingual research survey for Montréal and Київ with reproducible analytical methods. The evidence connects those methods to clear findings for research colleagues. Leadership of a larger team remains unestablished in the saved source record.',
    overview: 'Bilingual survey methods are documented, but leadership of a larger team remains unestablished.',
  }
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

test('pagination prefers complete sentences and moves an ordinary paragraph or its heading to a roomier page', () => {
  const first = 'The frozen requirements describe careful survey development and reproducible analytical review. '
  const second = 'Research teams coordinate the delivery of clear findings and preserve the boundaries of the captured evidence.'
  const width = 6
  const available = api.measurePptxText(first, width, 16).height + 0.15
  const fragment = api.takePptxText(first + second, width, available, 16)
  assert.equal(fragment.text, first)
  assert.equal(fragment.rest, second)
  const blocks = [
    { key: 'first', text: first },
    { key: 'second', text: second },
  ]
  const pages = api.paginatePptxBlocks(blocks, width, 1.4, { continuationHeight: 2.6 })
  assert.equal(pages[0].fragments[0].text, first)
  assert.equal(pages[1].fragments[0].text, second)
  const withHeading = api.paginatePptxBlocks([
    { key: 'heading', text: 'Job context', kind: 'heading' },
    { key: 'paragraph', text: first + second },
  ], width, 1.1, { continuationHeight: 3.5 })
  assert.equal(withHeading.length, 1, 'A short opener area does not force a split when its heading and sentence fit the next page')
  assert.equal(withHeading[0].capacity, 3.5)
  assert.equal(withHeading[0].fragments[0].text, 'Job context')
  assert.equal(withHeading[0].fragments[1].text, first + second)
})

test('nonbreaking paragraph endings preserve punctuation, paragraph whitespace, and safe wrapping bounds', () => {
  const original = 'Review program delivery.'
  const protectedText = api.keepPptxParagraphEndWordsTogether(original, 2.3, 16)
  assert.equal(protectedText, 'Review program\u00a0delivery.')
  const plainLines = api.measurePptxLines(original, 2.3, 16)
  const protectedLines = api.measurePptxLines(protectedText, 2.3, 16)
  assert.equal(original.slice(plainLines.at(-1).start).trim(), 'delivery.')
  assert.equal(protectedText.slice(protectedLines.at(-1).start).trim(), 'program\u00a0delivery.')
  assert.equal(api.pptxGlyphWidth('\u00a0', 16), api.pptxGlyphWidth(' ', 16))
  const paragraphs = 'Review program  delivery. \r\n\r\nCheck the saved source.\nAlready\u00a0together.'
  assert.equal(api.keepPptxParagraphEndWordsTogether(paragraphs, 8, 16),
    'Review program\u00a0\u00a0delivery. \r\n\r\nCheck the saved\u00a0source.\nAlready\u00a0together.')
  assert.equal(api.keepPptxParagraphEndWordsTogether('Finished. Done.', 8, 16), 'Finished. Done.',
    'The display rule does not bind words across sentence boundaries')
  const oversized = `${'W'.repeat(200)} delivery.`
  assert.equal(api.keepPptxParagraphEndWordsTogether(oversized, 2.3, 16), oversized,
    'A word pair wider than a readable line is not forced into an overflowing unbreakable span')
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
