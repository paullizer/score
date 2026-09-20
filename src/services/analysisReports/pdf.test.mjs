import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import {
  loadReportFoundation, realReportFixture, reportFixtureCitation, REPORT_TEST_TIMESTAMP, withReportNarratives,
} from './test-support.mjs'
import {
  assertNoClipping as checkClipping, contentsPages, fictionalPdfNavigationQaFixture, fictionalPdfQaFixture, fictionalSampleInput,
  overviewPages, readablePdfFixture, readPdf, reviewSections, targetOpenerPages,
} from './pdf-test-support.mjs'

let foundation, cleanup, writer, output, options, measurementFonts
before(async () => {
  ({ api: foundation, cleanup } = await loadReportFoundation())
  output = resolve(`.analysis-report-pdf-tests-${randomUUID()}`)
  await mkdir(output)
  await build({
    stdin: {
      resolveDir: process.cwd(), loader: 'ts', contents: `
        export { generatePdfReport } from './src/services/analysisReports/pdf';
        export { PdfReportLayout } from './src/services/analysisReports/pdf-layout';
        export { reportReviewLinks } from './src/services/analysisReports/links';
        export { REPORT_LIMITS } from './src/domain/analysis-reports';
      `,
    },
    outfile: join(output, 'pdf-writer.mjs'), bundle: true, packages: 'external',
    format: 'esm', platform: 'node', logLevel: 'silent',
  })
  writer = await import(pathToFileURL(join(output, 'pdf-writer.mjs')).href)
  const regular = await readFile(resolve('src', 'assets', 'report-fonts', 'NotoSans-Regular.ttf'))
  const bold = await readFile(resolve('src', 'assets', 'report-fonts', 'NotoSans-Bold.ttf'))
  options = {
    fonts: {
      regular: regular.buffer.slice(regular.byteOffset, regular.byteOffset + regular.byteLength),
      bold: bold.buffer.slice(bold.byteOffset, bold.byteOffset + bold.byteLength),
    },
    links: { origin: 'https://score.example', workspaceId: 'workspace-one' },
  }
  measurementFonts = { regular: fontkit.create(regular), bold: fontkit.create(bold) }
})
after(async () => {
  await cleanup?.()
  if (output) await rm(output, { recursive: true, force: true })
})

async function generate(input = readablePdfFixture(), generationOptions = options, buildOptions = {}) {
  const source = JSON.stringify(input)
  const report = foundation.buildAnalysisReport(input, buildOptions)
  const saved = JSON.stringify(report)
  const started = Date.now()
  const bytes = await writer.generatePdfReport(report, generationOptions)
  const generated = Date.now()
  assert.equal(JSON.stringify(input), source, 'PDF generation must not mutate source input')
  assert.equal(JSON.stringify(report), saved, 'PDF generation must not mutate saved scores, evidence or highlight selection')
  const pdf = await readPdf(bytes)
  return { report, bytes, ...pdf, generationMilliseconds: generated - started, inspectionMilliseconds: Date.now() - generated }
}

async function savePdfQaArtifact(name, input) {
  const directory = process.env.REPORT_PDF_QA_DIRECTORY
  if (!directory) return
  const pdf = await generate(fictionalSampleInput(input), { fonts: options.fonts, links: { origin: options.links.origin } })
  checkClipping(pdf, measurementFonts)
  assert.ok(pdf.body.includes(foundation.REPORT_SAMPLE_NOTICE))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name), pdf.bytes)
}

const assertNoClipping = pdf => checkClipping(pdf, measurementFonts)
const occurrences = (text, phrase) => text.split(phrase).length - 1
const overviewText = pdf => overviewPages(pdf).map(page => page.body).join('')

function assertContentsDestinations(pdf) {
  const contents = contentsPages(pdf)
  const openers = targetOpenerPages(pdf)
  const groups = pdf.report.groups.filter(group => group.comparisons.some(comparison => comparison.status === 'complete'))
  assert.equal(openers.length, groups.length)
  assert.ok(contents.length)
  assert.equal(pdf.pages[0].section.replace('FICTIONAL SAMPLE · ', ''), 'Introduction')
  assert.equal(pdf.pages[1], contents[0])
  assert.ok(contents.every(page => pdf.pages.indexOf(page) < pdf.pages.indexOf(openers[0])))
  for (const [index, group] of groups.entries()) {
    const opener = openers[index]
    const label = `${group.target.kind === 'grade' ? 'Grade' : 'Job'} analysis ${index + 1}`
    const targetPageIndex = pdf.pages.indexOf(opener)
    assert.equal(opener.primary, label)
    const page = contents.find(page => page.items.some(item => item.source === label))
    assert.ok(page, `Missing contents entry ${label}`)
    const item = page.items.find(item => item.source === label)
    const link = page.internalAnnotations.find(annotation =>
      Math.abs(annotation.rect[0] - item.x) < 0.01 && item.y >= annotation.rect[1] && item.y <= annotation.rect[3])
    assert.equal(link?.targetPageIndex, targetPageIndex, `Contents entry ${label} must resolve to its final exact-target opener`)
    assert.ok(page.items.some(value => value.source === `Page ${targetPageIndex + 1}` && value.y === item.y),
      'Visible page references must be finalized after contents and target pagination')
    assert.ok(contents.flatMap(page => page.internalAnnotations).some(link => link.targetPageIndex === targetPageIndex))
    assert.equal(opener.internalAnnotations.length, 1)
    assert.equal(opener.internalAnnotations[0].targetPageIndex, pdf.pages.indexOf(contents[0]))
    assert.ok(opener.body.includes('Return to contents'))
  }
  assert.ok(pdf.uriAnnotations.every(link => new URL(link.url).origin === options.links.origin))
}

function assertNoTechnicalMetadata(pdf) {
  assert.doesNotMatch(pdf.text, /Run ID:|Workspace ID:|Exact target ID:|Candidate ID:|Comparison ID:|Criterion ID:|SHA-256|Capture interval:|Saved provenance|Review \d|Partial report|cutoff|competition rank|Assessment model|Output correction count|RAW-GUIDANCE-|RAW-WORDING-|RAW-RESUME-QUOTE-|RAW-REQUIREMENT-QUOTE-/i)
  assert.ok(pdf.pages.every(page => !page.section.includes('PARTIAL')))
  for (const group of pdf.report.groups) {
    for (const value of [group.target.id, group.target.rubricId, group.target.snapshot?.sha256]) {
      if (value) assert.ok(!pdf.text.includes(value), `Technical metadata was displayed: ${value}`)
    }
    for (const comparison of group.comparisons) {
      for (const value of [comparison.id, comparison.candidate.id, comparison.candidate.documentId, comparison.resultSha256]) {
        if (value) assert.ok(!pdf.text.includes(value), `Technical identity was displayed: ${value}`)
      }
    }
  }
}

test('PDF: display headings and original source identities are both selectable', async () => {
  const input = readablePdfFixture({ scores: [92.75, null], criterionCount: 6 })
  input.run.name = 'Renamed analysis'
  input.targets[0].displayName = 'Custom target'
  input.targets[0].label = 'LEGACY-COMPOSITE TITLE - OFFICE MUST NOT BE USED'
  input.comparisons[0].candidate.displayName = 'Custom candidate'
  input.comparisons[1].candidate.displayName = 'Captured withheld candidate'
  const pdf = await generate(input)
  assert.equal(pdf.document.getTitle(), foundation.reportTitle(pdf.report))
  for (const value of ['Renamed analysis', 'Custom target', 'Custom candidate',
    `Source-stated name: ${input.comparisons[0].candidate.name}`, `Source target title: ${input.targets[0].presentation.title}`,
    input.comparisons[0].candidate.sourceLabel]) {
    assert.ok(pdf.text.includes(value), `Missing label or source identity: ${value}`)
  }
  const overview = overviewText(pdf)
  assert.ok(overview.includes('Custom candidate'))
  assert.ok(overview.includes('Captured withheld candidate'))
  const review = reviewSections(pdf)[0]
  assert.ok(review.pages.length <= 2)
  assert.ok(review.pages.every(page => page.items.some(item => item.y === 734 && item.source === 'Custom candidate')))
  assert.ok(review.pages.every(page => page.items.some(item => item.y === 718 && item.source === 'Job analysis 1 · Featured candidate 1')))
  assert.equal(review.pages.flatMap(page => page.annotations).length, 3)
  assert.doesNotMatch(pdf.text, /LEGACY-COMPOSITE/)
  assertContentsDestinations(pdf)
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
})

test('PDF: long captured aliases disambiguate exact targets and paginate without replacing original sources', async () => {
  const input = readablePdfFixture({ scores: [92.75], targetCount: 2, criterionCount: 6 })
  input.run.name = `${'Current analysis '.repeat(10).slice(0, 159)}Z`
  input.targets.forEach(target => { target.displayName = `${'Captured target '.repeat(10).slice(0, 159)}Z` })
  input.comparisons.forEach(comparison => {
    comparison.candidate.displayName = `${'Captured resume '.repeat(10).slice(0, 159)}Z`
    comparison.candidate.name = null
  })
  const pdf = await generate(input)
  assert.equal(pdf.document.getTitle(), foundation.reportTitle(pdf.report))
  assert.ok(pdf.body.includes(input.run.name))
  const reviews = reviewSections(pdf)
  assert.equal(reviews.length, 2)
  pdf.report.groups.forEach((group, index) => {
    const label = group.target.displayName
    assert.ok(overviewText(pdf).includes(label))
    assert.ok(reviews[index].body.includes(label))
    assert.ok(reviews[index].body.includes('Source-stated name: Not stated'))
    assert.ok(reviews[index].body.includes(`Source target title: ${group.target.presentation.title}`))
    assert.ok(reviews[index].pages.every(page => page.secondary === `Job analysis ${index + 1} · Featured candidate 1`))
    assert.ok(reviews[index].body.includes(group.comparisons[0].candidate.sourceLabel))
    assert.ok(reviews[index].pages.length <= 3)
    const links = writer.reportReviewLinks(pdf.report, group.comparisons[0], options)
    for (const url of Object.values(links)) assert.ok(reviews[index].pages.some(page => page.annotations.some(link => link.url === url)))
  })
  assertContentsDestinations(pdf)
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
})

test('PDF: source-name disclosures never strand the explanation section heading above a page break', async () => {
  const input = fictionalPdfQaFixture()
  input.run.name = 'Fictional research shortlisting review'
  input.targets[0].displayName = 'Survey methods vacancy'
  input.comparisons[0].candidate.displayName = 'Research applicant A'
  const pdf = await generate(fictionalSampleInput(input), { fonts: options.fonts, links: { origin: options.links.origin } })
  const review = reviewSections(pdf)[0]
  const headingPage = review.pages.find(page => page.items.some(item => item.source === 'Why these scores'))
  assert.ok(headingPage)
  assert.ok(headingPage.items.some(item => item.bold && item.size === 10 && /^C1(?: |$)/.test(item.source)),
    'The explanation heading must share a page with the first criterion, not reserve only a fixed number of blank points.')
  assertNoClipping(pdf)
})

test('PDF: concise searchable report includes job context, one caution, all criterion scores and page numbers', async context => {
  const input = readablePdfFixture()
  const pdf = await generate(input)
  assert.equal(pdf.document.getTitle(), foundation.reportTitle(pdf.report))
  assert.equal(pdf.document.getAuthor(), 'Score')
  assert.equal(occurrences(pdf.body, 'Analysis evidence report'), 1)
  assert.equal(occurrences(pdf.body, foundation.REPORT_HUMAN_REVIEW_NOTICE), 1)
  assert.equal(occurrences(pdf.body, 'Analysis date:'), 1)
  assert.ok(pdf.pages[0].body.includes('Distinct reviewed candidates: 1'))
  assert.ok(pdf.pages[0].body.includes('Job targets: 1'))
  assert.ok(pdf.pages[0].body.includes('Completed candidate-job reviews: 1'))
  assert.ok(pdf.body.includes('2026'))
  for (const expected of [
    'Reporting on 1 of 1 candidate', 'About the job', 'Engineering specialist', 'Example public works team',
    'Candidates at a glance', 'Assessment highlights', 'Alex Morgan', '92.75 / 100', 'Civil engineer',
    'Alex-Morgan-resume.docx', 'Why this score', 'Scorecard', 'Why these scores', 'Weight',
    'Applied engineering methods to flood-risk mapping',
    'Source:', 'Application access is required.',
  ]) assert.ok(pdf.body.includes(expected), `Missing readable content: ${expected}`)
  const section = reviewSections(pdf)[0]
  assert.equal(reviewSections(pdf).length, 1)
  assert.ok(section.pages.length <= 2, `An ordinary six-criterion review used ${section.pages.length} pages`)
  for (const page of section.pages) {
    assert.equal(page.primary, 'Alex Morgan')
    assert.equal(page.secondary, 'Job analysis 1 · Featured candidate 1')
  }
  for (const [index, definition] of input.targets[0].criteria.entries()) {
    assert.ok(section.body.includes(`C${index + 1} ${definition.label}`))
    assert.ok(section.body.includes(`C${index + 1} ${definition.label} (3 / 5)`))
    assert.ok(section.body.includes(input.comparisons[0].criteria[index].rationale))
  }
  assert.equal(section.pages.flatMap(page => page.items).filter(item => item.source === '3 / 5').length, 6)
  assert.ok(pdf.pages.some(page => page.items.some(item => item.source.includes('92.75 / 100') && item.size >= 20)))
  pdf.pages.forEach((page, index) => {
    assert.ok(page.text.includes(`Page ${index + 1} of ${pdf.pages.length}`))
    assert.equal(page.items.filter(item => item.y < 60).length, 1, 'Footers should contain page numbers, not repeated cautions')
  })
  assertNoTechnicalMetadata(pdf)
  assertContentsDestinations(pdf)
  assertNoClipping(pdf)
  await savePdfQaArtifact('score-pdf-fictional-ordinary-v2.pdf', fictionalPdfQaFixture())
  context.diagnostic(`${pdf.pages.length} pages total; ${section.pages.length} pages for the ordinary featured review`)
})

test('PDF: overview names and featured links have actual same-origin URI annotations', async () => {
  const pdf = await generate(readablePdfFixture({ scores: [92, 81, null], criterionCount: 2 }))
  const overviewLinks = overviewPages(pdf).flatMap(page => page.annotations)
  assert.equal(overviewLinks.length, 3)
  for (const comparison of pdf.report.groups[0].comparisons) {
    const expected = writer.reportReviewLinks(pdf.report, comparison, options)
    assert.equal(overviewLinks.filter(link => link.url === expected.analysis).length, 1)
    if (comparison.overall.status === 'available') {
      for (const url of Object.values(expected)) assert.ok(pdf.annotations.some(link => link.url === url), `Missing clickable destination ${url}`)
    }
  }
  for (const section of reviewSections(pdf)) {
    const annotations = section.pages.flatMap(page => page.annotations)
    assert.equal(annotations.length, 3)
    for (const label of ['View analysis', 'View resume', 'View job']) {
      const item = section.pages.flatMap(page => page.items).find(value => value.source === label)
      assert.ok(item, `Missing link label ${label}`)
      assert.ok(annotations.some(link => Math.abs(link.rect[0] - item.x) < 0.01 && item.y >= link.rect[1] && item.y <= link.rect[3]))
    }
  }
  assertContentsDestinations(pdf)
  assertNoClipping(pdf)
})

test('PDF: fictional QA fixtures have consistent stored totals and distinct substantive criterion rationales', () => {
  for (const kind of ['ordinary', 'long', 'large']) {
    const input = fictionalPdfQaFixture(kind)
    const comparison = input.comparisons[0]
    const weighted = comparison.criteria.reduce((total, criterion) => total + criterion.weight * criterion.score / 5, 0)
    assert.ok(Math.abs(comparison.overall.score - weighted) < 0.000001, `${kind} QA must use internally consistent stored scores`)
    assert.ok(comparison.criteria.every(criterion => Number.isInteger(criterion.score)))
    assert.equal(new Set(comparison.criteria.map(criterion => criterion.rationale)).size, comparison.criteria.length)
    assert.equal(new Set(input.targets[0].criteria.map(criterion => criterion.label)).size, comparison.criteria.length)
    assert.ok(comparison.criteria.every(criterion => criterion.citations.length && criterion.rationale.length > 60))
    assert.doesNotMatch(comparison.summary, /Full saved overall assessment|flood-risk/)
    foundation.buildAnalysisReport(input)
    const sample = fictionalSampleInput(input)
    assert.deepEqual(sample.comparisons.map(comparison => comparison.summary), input.comparisons.map(comparison => comparison.summary))
    assert.equal(sample.capture.summaries.source, 'fixture')
    for (const narrative of [...sample.targets, ...sample.comparisons].map(value => value.narrative).filter(Boolean)) {
      assert.equal(narrative.dataKind, 'sample')
      assert.match(narrative.revision, /^fixture-/)
      assert.equal('generationId' in narrative, false)
      assert.equal('publishedAt' in narrative, false)
    }
    foundation.buildAnalysisReport(sample)
  }
})

test('PDF: an independent local reader extracts meaningful Unicode text', async context => {
  const input = readablePdfFixture({ criterionCount: 1 })
  input.comparisons[0].candidate.name = 'José Zoë — Ω Кириллица, Łukasz'
  input.comparisons[0].criteria[0].rationale = 'Reviewed café ventilation, naïve assumptions and Ω measurements with Кириллица project notes.'
  const pdf = await generate(input)
  const path = join(output, 'reader-check.pdf')
  await writeFile(path, pdf.bytes)
  const result = spawnSync('pdftotext', ['-raw', '-enc', 'UTF-8', path, '-'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error?.code === 'ENOENT') {
    context.skip('Optional local pdftotext is unavailable; embedded glyphs and Unicode maps are tested portably.')
    return
  }
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  for (const phrase of ['Analysis evidence report', 'José Zoë', 'Why these scores', 'Reviewed café ventilation, naïve assumptions and Ω measurements', 'View analysis']) {
    assert.ok(result.stdout.includes(phrase), `Independent reader lost searchable text: ${phrase}`)
  }
  assertNoClipping(pdf)
})

test('PDF: each exact target keeps its context, featured reviews and all-completed table contiguous in that order', async () => {
  const input = readablePdfFixture({ scores: [92, 81, 0, null, 60], statuses: ['complete', 'complete', 'complete', 'complete', 'cancelled'], targetCount: 2, criterionCount: 1 })
  input.comparisons[1].overall.score = 5
  input.comparisons[3].overall.score = 99
  input.comparisons[5].overall.score = 40
  const pdf = await generate(input)
  const overviews = overviewPages(pdf)
  assert.equal(occurrences(overviewText(pdf), 'Candidates at a glance'), 2)
  assert.ok(pdf.pages[0].body.includes('Reporting on 8 of 10 candidate-job reviews'))
  assert.ok(pdf.pages[0].body.includes('Distinct reviewed candidates: 4'))
  assert.ok(pdf.pages[0].body.includes('Job targets: 2'))
  assert.ok(pdf.pages[0].body.includes('Completed candidate-job reviews: 8'))
  assert.equal(overviews.flatMap(page => page.annotations).length, 8)
  const labels = new Set(overviews.map(page => page.items.find(item => item.y === 734)?.source))
  assert.equal(labels.size, 2, 'Same-label exact targets need readable disambiguation, not merged overview rows')
  const sections = reviewSections(pdf)
  const featured = pdf.report.groups.flatMap(group => group.highlightedComparisonIds.map(id => ({ group, comparison: group.comparisons.find(item => item.id === id) })))
  assert.equal(sections.length, featured.length)
  sections.forEach((section, index) => {
    const { comparison, group } = featured[index]
    assert.ok(section.body.includes(comparison.candidate.name))
    for (const page of section.pages) {
      assert.equal(page.primary, comparison.candidate.name)
      assert.ok(page.secondary.startsWith(`Job analysis ${pdf.report.groups.indexOf(group) + 1} · Featured candidate `))
    }
  })
  for (const [index] of pdf.report.groups.entries()) {
    const label = `Job analysis ${index + 1}`
    const opener = targetOpenerPages(pdf)[index]
    const reviews = pdf.pages.filter(page => page.secondary.startsWith(`${label} · Featured candidate `))
    const glance = overviews.filter(page => page.primary === label)
    assert.ok(pdf.pages.indexOf(opener) < pdf.pages.indexOf(reviews[0]))
    assert.ok(pdf.pages.indexOf(reviews.at(-1)) < pdf.pages.indexOf(glance[0]))
    if (index + 1 < pdf.report.groups.length) {
      assert.ok(pdf.pages.indexOf(glance.at(-1)) < pdf.pages.indexOf(targetOpenerPages(pdf)[index + 1]))
    }
  }
  assertContentsDestinations(pdf)
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
})

test('PDF: full canonical title, separate organization and exact saved paragraphs survive wrapping without legacy synthesis', async () => {
  const input = readablePdfFixture({ criterionCount: 1 })
  const target = input.targets[0]
  const comparison = input.comparisons[0]
  target.label = 'LEGACY combined title and agency must not appear'
  target.sublabel = 'LEGACY fallback subtitle must not appear'
  target.presentation = {
    title: 'Survey Statistician - Research Methods, Data Quality and Longitudinal Programme Evaluation',
    organization: 'Department of Public Research - National Survey Processing and Statistical Evidence Review Center, Regional Operations Directorate',
    description: `DESCRIPTION-START\n\n${'The saved role includes survey planning, reproducible quantitative checks, research documentation and coordination of fieldwork partners. '.repeat(100)}\nDESCRIPTION-END`,
    series: '1530', grade: 'GS-12', versionLabel: 'Approved rubric v7',
  }
  target.narrative.paragraphs = [
    'The saved reviews document completed research and quantitative work. Their strongest examples connect methods with delivered reports and reproducible checks.',
    'Leadership examples concern small teams and defined workstreams. Broader programme and budget responsibility remain unverified in the available records.',
    'These observations describe this exact saved target rather than a cross-job ranking. Human reviewers need to inspect source completeness and the separate qualification requirements.',
  ]
  comparison.narrative.text = 'The resume documents survey design and reproducible statistical analysis. Completed research reports connect those methods with delivered public-facing findings. Leadership examples concern mentoring analysts rather than ownership of a large programme. Budget authority remains unverified and requires human source review.'
  comparison.narrative.overview = 'Survey design and reproducible analysis are supported by completed research, while larger programme leadership remains unverified.'
  comparison.summary = 'LEGACY-COUNT-SUMMARY: Criterion evidence: 1 supported. The document evidence-match total is 92.75/100.'
  const pdf = await generate(input)
  const contents = contentsPages(pdf).map(page => page.body).join('')
  const context = pdf.pages.filter(page => page.section.endsWith('Target overview')).map(page => page.body).join('')
  const review = reviewSections(pdf)[0]
  for (const text of [target.presentation.title, target.presentation.organization, 'Series: 1530', 'Grade: GS-12', 'Approved rubric v7']) {
    assert.ok(contents.includes(text), `Contents lost frozen identity ${text}`)
    assert.ok(context.includes(text), `Opener lost frozen identity ${text}`)
    assert.ok(review.body.includes(text), `Candidate review lost frozen identity ${text}`)
    assert.ok(overviewText(pdf).includes(text), `At-a-glance section lost frozen identity ${text}`)
  }
  assert.ok(context.includes(target.presentation.description), 'The full saved description must flow across pages without summarization')
  assert.ok(pdf.pages.filter(page => page.section.endsWith('Target overview')).length > 2)
  for (const paragraph of target.narrative.paragraphs) assert.ok(context.includes(paragraph))
  assert.ok(review.body.includes(comparison.narrative.text))
  assert.ok(overviewText(pdf).includes(comparison.narrative.overview))
  assert.doesNotMatch(pdf.body, /LEGACY|\.{3}|\u2026/)
  assert.ok(contentsPages(pdf).flatMap(page => page.items).some(item => item.size === 13 && item.source.startsWith('Survey Statistician')))
  assert.ok(contentsPages(pdf).flatMap(page => page.items).some(item => item.size === 10.5 && item.source.startsWith('Department of Public Research')))
  assertContentsDestinations(pdf)
  assertNoClipping(pdf)
})

test('PDF: duplicate Survey Statistician office labels never expand legacy sublabels into canonical titles', async () => {
  const input = readablePdfFixture({ scores: [80], targetCount: 3, criterionCount: 1 })
  const organizations = [
    'Department of Public Research - National Survey Processing and Statistical Evidence Review Center, Eastern Operations',
    'Department of Public Research - National Survey Processing and Statistical Evidence Review Center, Western Operations',
    'Department of Public Research - National Survey Processing and Statistical Evidence Review Center, Eastern Operations',
  ]
  input.targets.forEach((target, index) => {
    target.label = 'Survey Statistician'
    target.sublabel = `${organizations[index]} · Survey methods rubric · approved version ${index + 1}`
    target.presentation = {
      ...target.presentation,
      title: target.label, organization: organizations[index], series: '1530',
      grade: index === 1 ? 'GS-12' : 'GS-11', versionLabel: `Approved rubric v${index + 1}`,
    }
  })
  const report = foundation.buildAnalysisReport(input)
  const legacyLabels = report.groups.map(group => {
    const label = `${group.target.label} - ${group.target.sublabel}`
    assert.equal(foundation.readableTargetLabel(report, group), label, 'Legacy CSV label expansion remains unchanged')
    return label
  })
  const pdf = await generate(input)
  for (const label of legacyLabels) assert.ok(!pdf.body.includes(label), 'A legacy organization/rubric sublabel must not become a PDF title')
  assert.equal(contentsPages(pdf).flatMap(page => page.items)
    .filter(item => item.source === 'Survey Statistician' && item.size === 13 && item.bold).length, 3)
  for (const [index, target] of input.targets.entries()) {
    const label = `Job analysis ${index + 1}`
    const surfaces = [
      pdf.pages.filter(page => page.primary === label && page.section.endsWith('Target overview')),
      pdf.pages.filter(page => page.secondary.startsWith(`${label} · Featured candidate `)),
      overviewPages(pdf).filter(page => page.primary === label),
    ]
    for (const pages of surfaces) {
      const items = pages.flatMap(page => page.items.filter(item => item.y > 60 && item.y < 704))
      assert.equal(items.filter(item => item.source === target.presentation.title && item.bold).length, 1)
      assert.equal(items.filter(item => item.size === 11 && !item.bold).map(item => item.source).join(''), target.presentation.organization)
      const body = pages.map(page => page.body).join('')
      assert.ok(body.includes(`Grade: ${target.presentation.grade}`))
      assert.ok(body.includes(target.presentation.versionLabel))
      assert.ok(!body.includes(target.sublabel))
    }
  }
  assertContentsDestinations(pdf)
  assertNoClipping(pdf)
})

test('PDF: paginated contents resolves duplicate title, organization and grade/version destinations after long descriptions and scorecards', async () => {
  const input = readablePdfFixture({ scores: [80], targetCount: 14, criterionCount: 1, kind: 'grade' })
  const dense = readablePdfFixture({ scores: [80], criterionCount: 100, kind: 'grade' })
  input.targets[0].criteria = dense.targets[0].criteria
  input.comparisons[0].criteria = dense.comparisons[0].criteria
  input.comparisons[0].coverage = dense.comparisons[0].coverage
  for (const [index, target] of input.targets.entries()) {
    target.presentation = {
      title: index === 0 ? `LONG-TITLE-START ${'Advanced Quantitative Research and Engineering Methods '.repeat(24)} LONG-TITLE-END`
        : 'General engineering - Research methods',
      organization: index === 0 ? `LONG-ORGANIZATION-START ${'National Technical Processing and Evidence Review Center '.repeat(28)} LONG-ORGANIZATION-END`
        : `Department of Public Research, ${index % 2 ? 'Eastern' : 'Western'} Processing Center`,
      description: index === 0
        ? `ROLE-START ${'The frozen requirements cover documented engineering methods and independently reviewed quantitative research. '.repeat(150)} ROLE-END`
        : 'The exact saved grade concerns engineering methods and independently reviewed quantitative research.',
      series: '0801', grade: 'GS-9', versionLabel: `Approved grade version ${index + 1}`,
    }
  }
  const pdf = await generate(input)
  assert.ok(pdf.pages[0].body.includes('Jobs / grades: 14'))
  assert.ok(contentsPages(pdf).length > 3, 'Contents must paginate by measured wrapped entry height')
  assert.ok(reviewSections(pdf)[0].pages.length > 5)
  assert.ok(pdf.pages.filter(page => page.section.endsWith('Target overview') && page.primary === 'Grade analysis 1').length > 5)
  assertContentsDestinations(pdf)
  const contents = contentsPages(pdf).flatMap(page => page.items.filter(item =>
    item.y > 60 && item.y < 704 && !/^Page \d+$/u.test(item.source))).map(item => item.source).join('')
  assert.ok(contents.includes(input.targets[0].presentation.title))
  assert.ok(contents.includes(input.targets[0].presentation.organization))
  const openers = targetOpenerPages(pdf)
  assert.equal(new Set(openers.map(page => pdf.pages.indexOf(page))).size, 14)
  for (const [index, opener] of openers.entries()) {
    const targetContext = pdf.pages.filter(page => page.primary === opener.primary && page.section.endsWith('Target overview'))
      .map(page => page.body).join('')
    assert.ok(targetContext.includes(input.targets[index].presentation.versionLabel))
  }
  assertNoClipping(pdf)
})

test('PDF: contents includes only completed target groups and exact-target exports retain their own native destinations', async () => {
  const input = readablePdfFixture({ scores: [80], targetCount: 3, criterionCount: 1 })
  const failed = realReportFixture({ scores: [80], targetCount: 3, criterionCount: 1, statuses: ['failed'] })
  failed.comparisons[1].candidate = structuredClone(input.comparisons[1].candidate)
  input.comparisons[1] = failed.comparisons[1]
  delete input.targets[1].narrative
  const pdf = await generate(withReportNarratives(input))
  assertContentsDestinations(pdf)
  assert.equal(targetOpenerPages(pdf).length, 2)
  assert.ok(pdf.pages[0].body.includes('Distinct reviewed candidates: 1'))
  assert.ok(pdf.pages[0].body.includes('Job targets: 2'))
  assert.ok(pdf.pages[0].body.includes('Completed candidate-job reviews: 2'))
  assert.ok(pdf.pages[0].body.includes('1 could not be assessed'))
  assert.ok(!contentsPages(pdf).map(page => page.body).join('').includes(input.targets[1].presentation.organization))

  const selected = structuredClone(input)
  const targetId = input.targets[2].id
  selected.targets = selected.targets.filter(target => target.id === targetId)
  selected.comparisons = selected.comparisons.filter(comparison => comparison.targetId === targetId)
  const single = await generate(withReportNarratives(selected, { targetId }), options, { targetId })
  assertContentsDestinations(single)
  assert.equal(targetOpenerPages(single).length, 1)
  assert.ok(targetOpenerPages(single)[0].body.includes(input.targets[2].presentation.organization))
  assert.ok(single.pages[0].body.includes('Completed candidate-job reviews: 1'))
  assertNoClipping(pdf)
  assertNoClipping(single)
})

test('PDF: absent, stale or inconsistent saved summaries fail closed before filtering the original capture', async () => {
  const input = readablePdfFixture({ scores: [80, null, 70], statuses: ['complete', 'complete', 'failed'], criterionCount: 1 })
  const report = foundation.buildAnalysisReport(input)
  for (const invalidate of [
    report => { delete report.capture.summaries },
    report => { report.capture.summaries.ready = false },
    report => { delete report.groups[0].target.narrative },
    report => { delete report.groups[0].comparisons[0].narrative },
    report => { delete report.groups[0].target.presentation },
    report => { report.groups[0].comparisons[0].narrative.inputFingerprint = 'f'.repeat(64) },
    report => { report.groups[0].target.narrative.revision = 'e'.repeat(64) },
    report => { report.capture.summaries.comparisons = report.capture.summaries.comparisons.filter(pin => pin.status === 'complete') },
    report => { report.capture.summaries.comparisons.find(pin => pin.status === 'failed').status = 'cancelled' },
    report => { report.groups[0].comparisons[0].resultSha256 = 'b'.repeat(64) },
    report => { report.capture.summaries.scope.targetId = report.groups[0].target.id },
  ]) {
    const invalid = structuredClone(report)
    invalidate(invalid)
    await assert.rejects(writer.generatePdfReport(invalid, options), /saved|narrative|summar|capture|presentation|metadata/i)
  }
})

test('PDF: capped ties stay equal in all-completed overview; only supplied highlights get individual reviews', async () => {
  const input = readablePdfFixture({ scores: [100, 99, 98, 97, ...Array(11).fill(80), 0], criterionCount: 1 })
  const pdf = await generate(input)
  const summary = overviewText(pdf)
  assert.equal(overviewPages(pdf).flatMap(page => page.annotations).length, 16)
  assert.equal(occurrences(summary, '80 / 100'), 11)
  for (const comparison of input.comparisons) assert.equal(occurrences(summary, comparison.candidate.name), 1)
  assert.equal(reviewSections(pdf).length, 10)
  const detailed = reviewSections(pdf).map(section => section.body).join('')
  const featuredIds = new Set(pdf.report.groups[0].highlightedComparisonIds)
  for (const comparison of input.comparisons) assert.equal(detailed.includes(comparison.candidate.name), featuredIds.has(comparison.id))
  assert.ok(overviewPages(pdf).length > 1, 'The overview should paginate instead of shrinking text')
  for (const page of overviewPages(pdf).filter(page => page.annotations.length)) {
    for (const header of ['Name', 'Score', 'Assessment highlights']) assert.ok(page.body.includes(header), `Continuation page lost ${header}`)
  }
  assert.doesNotMatch(pdf.text, /rank|cutoff|capped|tied at|additional candidates tied/i)
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
})

test('PDF: zero, completed withheld scores and actual unfinished reasons remain distinct', async () => {
  const input = fictionalSampleInput(readablePdfFixture({
    scores: [0, null, 40, 30, 20, 10], statuses: ['complete', 'complete', 'queued', 'running', 'failed', 'cancelled'], criterionCount: 1,
  }))
  const comparison = input.comparisons[0]
  comparison.criteria[0].score = 0
  comparison.criteria[0].evidenceStatus = 'missing'
  comparison.criteria[0].citations = []
  comparison.criteria[0].rationale = 'The resume does not provide examples of engineering methods.'
  comparison.coverage.supported = 0
  comparison.coverage.missing = 1
  comparison.summary = 'The submitted resume does not provide examples of the required engineering work.'
  const pdf = await generate(input)
  assert.equal(occurrences(pdf.body, 'Reporting on 2 of 6 candidates'), 1)
  assert.match(pdf.body, /2 still processing/)
  assert.match(pdf.body, /1 could not be assessed/)
  assert.match(pdf.body, /1 cancelled/)
  assert.equal(occurrences(pdf.body, 'still processing'), 1)
  assert.equal(occurrences(pdf.body, 'could not be assessed'), 1)
  assert.equal(occurrences(pdf.body, 'cancelled'), 1)
  assert.equal(overviewPages(pdf).flatMap(page => page.annotations).length, 2)
  assert.ok(overviewText(pdf).includes('Weighted criteria were not assessed.'))
  assert.ok(overviewText(pdf).includes('Withheld'))
  assert.ok(overviewText(pdf).includes('0 / 100'))
  const sections = reviewSections(pdf)
  assert.equal(sections.length, 1)
  assert.ok(sections[0].body.includes('Overall score: 0 / 100'))
  assert.ok(sections[0].body.includes('0 / 5'))
  assert.ok(sections[0].body.includes('Missing evidence'))
  for (const unfinished of input.comparisons.slice(2)) assert.ok(!pdf.body.includes(unfinished.candidate.name))
  assert.doesNotMatch(pdf.body, /storage-error|assessment · Retryable|unassessed-weighted-criteria|PARTIAL/)
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
})

test('PDF: all-withheld results remain in the overview without invented reviews; fictional samples stay unmistakable', async () => {
  const withheld = await generate(readablePdfFixture({ scores: [null, null], criterionCount: 1 }))
  assert.equal(reviewSections(withheld).length, 0)
  assert.equal(overviewPages(withheld).flatMap(page => page.annotations).length, 2)
  assert.equal(occurrences(withheld.body, 'Withheld'), 2)
  assert.equal(occurrences(withheld.body, 'Weighted criteria were not assessed.'), 2)
  assert.ok(!withheld.body.includes('Scorecard'))
  const report = foundation.buildSampleAnalysisReport(foundation.createInitialWorkspace().runs[0], { generatedAt: REPORT_TEST_TIMESTAMP })
  const sample = await readPdf(await writer.generatePdfReport(report, { fonts: options.fonts, links: { origin: options.links.origin } }))
  assert.equal(occurrences(sample.body, 'Analysis evidence report'), 1)
  assert.equal(occurrences(sample.body, foundation.REPORT_SAMPLE_NOTICE), 1)
  assert.ok(sample.pages.every(page => page.section.startsWith('FICTIONAL SAMPLE')))
  assert.equal(reviewSections(sample).length, report.groups.reduce((sum, group) => sum + group.highlightedComparisonIds.length, 0))
  assertNoClipping(withheld)
  assertNoClipping(sample)
})

test('PDF: duplicate or unnamed candidates have readable labels and distinct saved-review destinations', async () => {
  const input = readablePdfFixture({ scores: [80, 80, 60], criterionCount: 1 })
  input.comparisons[0].candidate.name = 'Jordan Example'
  input.comparisons[1].candidate.name = 'Jordan Example'
  input.comparisons[2].candidate.name = null
  const pdf = await generate(input)
  assert.equal(occurrences(overviewText(pdf), 'Jordan Example'), 2)
  assert.equal(reviewSections(pdf).length, 3, 'Repeated display names still need distinct numbered review headers')
  assert.equal(new Set(reviewSections(pdf).map(section => section.secondary)).size, 3)
  const destinations = overviewPages(pdf).flatMap(page => page.annotations.map(link => link.url))
  assert.equal(new Set(destinations).size, 3)
  assert.ok(!pdf.text.includes('candidate-2'), 'Unnamed fallbacks must not disclose raw candidate IDs')
  assertNoClipping(pdf)
})

test('PDF: running headers retain full names at the measured width boundary and use numbered fallbacks without shrinking', async () => {
  const font = measurementFonts.bold
  const characterWidth = font.layout('W').glyphs[0].advanceWidth * 9.5 / font.unitsPerEm
  const fittingName = 'W'.repeat(Math.floor(520 / characterWidth))
  const overflowingName = `${fittingName}W`
  const longName = `LONG-CANDIDATE-START-${'W'.repeat(1200)}-LONG-CANDIDATE-END`
  const names = [fittingName, overflowingName, longName]
  const input = readablePdfFixture({ scores: [90, 80, 70], criterionCount: 1 })
  input.comparisons.forEach((comparison, index) => { comparison.candidate.name = names[index] })
  const pdf = await generate(input)
  const reviews = reviewSections(pdf)
  assert.equal(reviews.length, names.length)
  assert.ok(reviews[2].pages.length > 1, 'The pathological name must exercise continuation headers')
  for (const [index, section] of reviews.entries()) {
    assert.ok(section.body.includes(names[index]), 'The full candidate identity must remain in the review body')
    for (const page of section.pages) {
      assert.equal(page.primary, index === 0 ? fittingName : `Candidate ${index + 1}`)
      assert.equal(page.secondary, `Job analysis 1 · Featured candidate ${index + 1}`)
      assert.equal(page.items.find(item => item.y === 734)?.size, 9.5)
      assert.doesNotMatch(page.primary, /\.{3}|\u2026/)
    }
  }
  assertContentsDestinations(pdf)
  assertNoClipping(pdf)
})

test('PDF: wrapped linked text and oversized table cells preserve Unicode, whitespace and annotation rectangles across pages', async () => {
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  const fonts = {
    regular: await document.embedFont(options.fonts.regular, { subset: true, features: { liga: false, clig: false } }),
    bold: await document.embedFont(options.fonts.bold, { subset: true, features: { liga: false, clig: false } }),
  }
  const layout = new writer.PdfReportLayout(document, fonts, '')
  layout.startSection({ section: 'Candidate review', primary: 'Job analysis 1 · Featured candidate 1', secondary: 'Scorecard and supporting evidence' })
  layout.paragraph(`José Zoë — ${'Ω'.repeat(180)}`, { bold: true, size: 20, leading: 28 })
  layout.paragraph(`Engineering specialist ${'W'.repeat(180)}`, { bold: true, size: 12, leading: 17 })
  const linked = `First line with exact  spaces.\r\nSecond\tline with A\u0301 and résumé.\nLONG-START-${'W'.repeat(2200)}-LONG-END`
  const destination = 'https://score.example/analyses/saved-review'
  layout.paragraph(linked, { link: destination })
  const name = `NAME-START-${'W'.repeat(3000)}-NAME-END`
  const tableDestination = `${destination}?candidate=wrapped`
  layout.table(['Name', 'Score', 'Assessment highlights'], [[{ text: name, url: tableDestination }, '92 / 100', 'Documented engineering work.']], [133, 76, 311])
  layout.finish()
  const pdf = await readPdf(await document.save())
  assert.ok(pdf.body.includes(linked))
  const linkedName = pdf.pages.flatMap(page => page.items.filter(item => page.annotations.some(link =>
    link.url === tableDestination && Math.abs(link.rect[0] - item.x) < 0.01 && item.y >= link.rect[1] && item.y <= link.rect[3])))
    .map(item => item.source).join('')
  assert.equal(linkedName, name, 'Table headers and other cells must not hide dropped linked text across page boundaries')
  assert.ok(pdf.annotations.length > 100)
  assert.ok(pdf.annotations.every(link => [destination, tableDestination].includes(link.url)))
  assert.ok(pdf.pages.filter(page => page.body.includes('Assessment highlights')).length > 1)
  assert.ok(pdf.pages.every(page => page.primary === 'Job analysis 1 · Featured candidate 1'))
  assertNoClipping(pdf)
})

test('PDF: metadata-rich records retain concise rationale, not audit text or unsupported omitted glyphs', async () => {
  const input = readablePdfFixture({ scores: [60, 60], criterionCount: 1 })
  input.run.name = 'Current analysis title'
  input.targets[0].facts.push({ label: 'Rubric SHA-256', value: 'b'.repeat(64) }, { label: 'Assessment deployment', value: '漢-hidden-deployment' })
  input.targets[0].criteria[0].guidance += ' 🚀 Guidance is not reader-facing.'
  for (const comparison of input.comparisons) {
    comparison.provenance.push({ label: 'Hidden provenance', value: '🚀漢\u0000 audit only' })
    comparison.criteria[0].citations[0] = reportFixtureCitation(comparison.candidate.documentId, {
      sourceTitle: comparison.candidate.sourceLabel, quote: 'RAW-RESUME-QUOTE: Omitted quotation with 🚀漢.',
    })
  }
  const pdf = await generate(input)
  for (const section of reviewSections(pdf)) assert.ok(section.pages.length <= 2)
  assertNoTechnicalMetadata(pdf)
  assert.doesNotMatch(pdf.text, /🚀|漢|audit only/)
  assert.ok(pdf.body.includes('Current analysis title'))
  assert.ok(pdf.body.includes('Applied engineering methods to flood-risk mapping'))
  assert.ok(pdf.body.includes('Applied engineering methods to bridge inspections'))
  assertNoClipping(pdf)
})

test('PDF: saved processing-summary boilerplate is omitted in favor of specific assessment evidence', async () => {
  const input = readablePdfFixture({ scores: [60], criterionCount: 1 })
  input.comparisons[0].summary = 'The submitted document was compared only with this exact saved rubric. Criterion evidence: 1 supported, 0 partial, 0 missing, 0 not assessed, and 0 excluded. The document evidence-match total is 60/100. Missing evidence does not establish that a person lacks ability. This is a human-review aid, not a hiring recommendation or an official GS eligibility decision.'
  const pdf = await generate(input)
  assert.doesNotMatch(pdf.body, /The submitted document was compared only|Criterion evidence:|The document evidence-match total|This is a human-review aid/)
  assert.ok(pdf.body.includes(input.comparisons[0].criteria[0].rationale))
  assert.equal(occurrences(pdf.body, foundation.REPORT_HUMAN_REVIEW_NOTICE), 1)
  assertNoClipping(pdf)
})

test('PDF: every material overall limitation remains readable when it is not already explained', async () => {
  const input = readablePdfFixture({ criterionCount: 1 })
  input.comparisons[0].limitations = [
    { code: 'date-gap', message: 'The resume omits dates for the engineering placement.' },
    { code: 'responsibility-gap', message: 'The project description does not distinguish independent work from supervised tasks.' },
    { code: 'source-gap', message: 'The final source attachment is incomplete and needs verification.' },
  ]
  const pdf = await generate(input)
  for (const limitation of input.comparisons[0].limitations) {
    assert.ok(reviewSections(pdf)[0].body.includes(limitation.message), `Lost material review note: ${limitation.message}`)
    assert.ok(!pdf.text.includes(limitation.code))
  }
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
})

test('PDF: measured rationale groups keep short labels and source locators with their evidence at page boundaries', async () => {
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  const fonts = {
    regular: await document.embedFont(options.fonts.regular, { subset: true, features: { liga: false, clig: false } }),
    bold: await document.embedFont(options.fonts.bold, { subset: true, features: { liga: false, clig: false } }),
  }
  const layout = new writer.PdfReportLayout(document, fonts, '')
  layout.startSection({ section: 'Candidate review', primary: 'Alex Morgan', secondary: 'Engineering specialist' })
  layout.paragraph(Array(37).fill('Filler line.').join('\n'))
  const cases = [
    ['Short rationale', 'First short evidence line.\nSHORT-RATIONALE-END', 'Source: résumé.docx, section 2'],
    ['Long rationale', `${Array(48).fill('Recorded engineering experience.').join('\n')}\nLONG-RATIONALE-END`, 'Source: engineering-report.pdf, page 12'],
    ['Long source title', 'SOURCE-TITLE-RATIONALE-END', `Source: ${'Long source title. '.repeat(160)}SOURCE-TITLE-END, section 4`],
  ]
  for (const [label, text, source] of cases) layout.explanation(label, text, source)
  layout.finish()
  const pdf = await readPdf(await document.save())
  for (const [label, text, source] of cases) {
    const ending = text.split('\n').at(-1)
    const page = pdf.pages.find(item => item.body.includes(ending))
    assert.ok(page?.body.includes(source.slice(0, 40)), `Orphaned source after ${label}`)
    assert.ok(pdf.body.includes(text))
    assert.ok(pdf.body.includes(source))
  }
  assert.ok(pdf.pages[1].body.includes('Short rationale'), 'A short rationale and its heading should move with the source label')
  assertNoClipping(pdf)
})

test('PDF: fractional weights keep saved values and use the shared display rounding notation', async () => {
  const pdf = await generate(readablePdfFixture({ criterionCount: 3 }))
  assert.ok(pdf.body.includes('~33.33%'))
  assert.ok(pdf.body.includes('~ marks a weight rounded for display.'))
  assert.ok(!pdf.body.includes('33.333333333333336%'))
  assert.equal(pdf.report.groups[0].comparisons[0].criteria[0].weight, 100 / 3)
  assert.ok(pdf.pages.some(page => page.items.some(item => item.source === '~33.33%')))
  assertNoClipping(pdf)
})

test('PDF: long summaries and quote-heavy ordinary scorecards stay concise without losing material criterion gaps', async context => {
  const input = readablePdfFixture()
  const comparison = input.comparisons[0]
  comparison.summary = `Led flood-risk mapping and independently checked engineering calculations. ${'Administrative narrative retained in the saved analysis. '.repeat(550)}UNNEEDED-SUMMARY-END`
  input.targets[0].criteria.forEach((definition, index) => {
    definition.description += ` ${'Raw requirement wording. '.repeat(100)}WORDING-END-${index}`
    definition.guidance += ` ${'Internal scoring instructions. '.repeat(100)}GUIDANCE-END-${index}`
    const criterion = comparison.criteria[index]
    criterion.rationale += ` ${'Expanded working notes remain in the full saved analysis. '.repeat(100)}RATIONALE-END-${index}`
    criterion.citations = Array.from({ length: 5 }, (_, quote) => reportFixtureCitation(comparison.candidate.documentId, {
      sourceTitle: comparison.candidate.sourceLabel, pagination: 'captured-sections', page: index + 1,
      paragraphId: `raw-resume-${index}-${quote}`, quote: `RAW-RESUME-QUOTE-${index}-${quote}: ${'Exact saved evidence. '.repeat(100)}QUOTE-END-${index}-${quote}`,
    }))
  })
  const last = comparison.criteria.at(-1)
  last.evidenceStatus = 'partial'
  last.score = 2
  last.limitation = { code: 'scope-unverified', criterionId: last.criterionId, message: 'The resume does not establish ownership of the final quality sign-off.' }
  comparison.coverage.supported--
  comparison.coverage.partial++
  const pdf = await generate(input)
  const sections = reviewSections(pdf)
  assert.equal(sections.length, 1)
  assert.ok(sections[0].pages.length <= 3, `A quote-heavy ordinary scorecard grew to ${sections[0].pages.length} pages`)
  assert.ok(pdf.body.includes(last.limitation.message))
  for (const [index, criterion] of comparison.criteria.entries()) {
    assert.ok(pdf.body.includes(`C${index + 1} ${input.targets[0].criteria[index].label}`))
    assert.ok(pdf.body.includes(criterion.rationale.split('. ')[0]))
  }
  assert.doesNotMatch(pdf.body, /UNNEEDED-SUMMARY-END|RATIONALE-END-|WORDING-END-|GUIDANCE-END-|QUOTE-END-/)
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
  await savePdfQaArtifact('score-pdf-fictional-long-v2.pdf', fictionalPdfQaFixture('long'))
  context.diagnostic(`${sections[0].pages.length} pages for a quote-heavy six-criterion review`)
})

test('PDF: a truly large scorecard paginates every criterion and rationale with candidate/job continuation headers', async context => {
  const input = readablePdfFixture({ scores: [60], criterionCount: 100 })
  input.targets[0].criteria.forEach((definition, index) => {
    definition.label = `Engineering evidence area ${String(index + 1).padStart(3, '0')}`
    input.comparisons[0].criteria[index].rationale = `Published engineering check ${String(index + 1).padStart(3, '0')} with documented calculations and a peer-reviewed deliverable.`
  })
  const pdf = await generate(input)
  const section = reviewSections(pdf)[0]
  assert.ok(section.pages.length > 5)
  assert.equal(section.pages.flatMap(page => page.items).filter(item => item.source === '3 / 5').length, 100)
  for (const [index, definition] of input.targets[0].criteria.entries()) {
    assert.equal(occurrences(section.body, `C${index + 1} ${definition.label}`), 2, 'Each criterion needs its table row and its rationale heading')
    assert.ok(section.body.includes(input.comparisons[0].criteria[index].rationale))
  }
  for (const page of section.pages.filter(page => page.items.some(item => item.source === '3 / 5'))) {
    for (const header of ['Criterion', 'Weight', 'Score']) assert.ok(page.body.includes(header))
  }
  for (const page of section.pages) {
    assert.equal(page.primary, 'Alex Morgan')
    assert.equal(page.secondary, 'Job analysis 1 · Featured candidate 1')
  }
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
  await savePdfQaArtifact('score-pdf-fictional-large-scorecard-v2.pdf', fictionalPdfQaFixture('large'))
  context.diagnostic(`${section.pages.length} pages for all 100 criteria and their rationales`)
})

test('PDF: an extreme criterion label flows through scorecard rows and explanation pages without losing its original text', async () => {
  const input = readablePdfFixture({ criterionCount: 1 })
  const phrase = 'Documented quantitative methods and independently reviewed evidence. '
  input.targets[0].criteria[0].label = `CRITERION-START ${phrase.repeat(110)}CRITERION-END`
  const pdf = await generate(input)
  const section = reviewSections(pdf)[0]
  assert.ok(section.pages.length > 5)
  assert.equal(occurrences(section.body, 'CRITERION-START'), 2)
  assert.equal(occurrences(section.body, 'CRITERION-END'), 2)
  const items = section.pages.flatMap(page => page.items.filter(item => item.y > 60 && item.y < 704))
  const tableCriterion = items.filter(item => item.x === 53 && item.size === 9.5 && !item.bold).map(item => item.source).join('')
  const explanationLabel = items.filter(item => item.x === 46 && item.size === 10 && item.bold).map(item => item.source).join('')
  assert.equal(tableCriterion, `C1 ${input.targets[0].criteria[0].label}`)
  assert.equal(explanationLabel.slice(explanationLabel.indexOf('C1 CRITERION-START')), `C1 ${input.targets[0].criteria[0].label} (3 / 5)`)
  assert.ok(section.body.includes(input.comparisons[0].criteria[0].rationale))
  assertContentsDestinations(pdf)
  assertNoClipping(pdf)
})

test('PDF: zero, not assessed and N/A remain separate, with short material unscored GS notes and grade links', async () => {
  const input = readablePdfFixture({ scores: [0], criterionCount: 3, kind: 'grade' })
  const comparison = input.comparisons[0]
  comparison.completion = 'limited'
  const weights = [100, 0, 0]
  const statuses = ['missing', 'not-assessed', 'not-applicable']
  comparison.criteria.forEach((criterion, index) => {
    input.targets[0].criteria[index].weight = weights[index]
    Object.assign(criterion, {
      weight: weights[index], score: index === 0 ? 0 : null, evidenceStatus: statuses[index], citations: [],
      rationale: [
        'The resume does not provide examples of independent engineering methods.',
        'Quantitative analysis could not be assessed from the submitted source.',
        'Project delivery is not applicable to this saved scorecard.',
      ][index],
      limitation: index === 1 ? { code: 'source-incomplete', criterionId: criterion.criterionId, message: 'The submitted attachment omits the quantitative project details.' } : null,
    })
  })
  comparison.coverage = { totalCriteria: 3, supported: 0, partial: 0, missing: 1, notAssessed: 1, notApplicable: 1, assessedWeight: 100, totalWeight: 100 }
  comparison.summary = 'The resume does not establish the engineering work required by this grade.'
  comparison.qualifications = [{
    qualificationId: 'qualification-one',
    text: `One year of specialized experience at the next lower grade. ${'Lengthy qualification wording. '.repeat(200)}`,
    interpretation: 'Review the duration and level of the work separately from criterion scores.',
    support: 'gap', evidenceStatus: 'missing',
    rationale: 'The resume does not establish a full year of specialized experience at the next lower grade.',
    citations: [],
    requirementCitations: [reportFixtureCitation('grade-source', { quote: 'RAW-QUALIFICATION-QUOTE', pagination: 'markdown-sections' })],
    limitation: { code: 'duration-unverified', message: 'Employment dates do not confirm the required duration.', qualificationId: 'qualification-one' },
  }]
  comparison.limitations = [{ code: 'human-verification', message: 'The source attachment is incomplete.', criterionId: 'criterion-1' }]
  const pdf = await generate(input)
  const section = reviewSections(pdf)[0]
  for (const text of [
    'Overall score: 0 / 100', '0 / 5', 'Not assessed', 'Missing evidence', 'GS qualification notes (unscored)',
    'The submitted attachment omits the quantitative project details.', 'View grade requirements',
  ]) assert.ok(section.body.includes(text), `Missing meaningful grade/state content: ${text}`)
  assert.match(section.body, /N\/A|Not applicable/)
  assert.match(section.body, /specialized experience|Employment dates/)
  assert.doesNotMatch(section.body, /RAW-QUALIFICATION-QUOTE|qualification-one|Source support:|Lengthy qualification wording\. Lengthy qualification wording\./)
  const expected = writer.reportReviewLinks(pdf.report, pdf.report.groups[0].comparisons[0], options)
  assert.ok(pdf.annotations.some(link => link.url === expected.target))
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
})

test('PDF: missing, corrupt and unsupported rendered fonts fail explicitly, never substitute glyphs', async () => {
  const report = foundation.buildAnalysisReport(readablePdfFixture({ criterionCount: 1 }))
  await assert.rejects(writer.generatePdfReport(report), /requires.*local.*regular and bold font bytes/i)
  await assert.rejects(writer.generatePdfReport(report, { ...options, fonts: { regular: new ArrayBuffer(4), bold: options.fonts.bold } }), /regular font could not be read/)
  for (const [character, expected] of [['🚀', /U\+1F680/], ['漢', /U\+6F22/], ['\u0000', /U\+0000/], ['\ud800', /U\+D800/]]) {
    const copy = structuredClone(report)
    copy.groups[0].comparisons[0].candidate.name = `Saved candidate ${character}`
    await assert.rejects(writer.generatePdfReport(copy, options), error => {
      assert.match(error.message, expected)
      assert.match(error.message, /No source text was substituted or omitted/)
      assert.match(error.message, /another report format|locally licensed PDF font/)
      return true
    })
  }
  for (const field of ['title', 'organization', 'description']) {
    const copy = structuredClone(report)
    copy.groups[0].target.presentation[field] += ' 漢'
    await assert.rejects(writer.generatePdfReport(copy, options), /U\+6F22.*No source text was substituted or omitted/)
  }
  const candidate = structuredClone(report)
  candidate.groups[0].comparisons[0].narrative.text = candidate.groups[0].comparisons[0].narrative.text.replace('Led', '漢')
  await assert.rejects(writer.generatePdfReport(candidate, options), /U\+6F22.*No source text was substituted or omitted/)
  const overview = structuredClone(report)
  overview.groups[0].target.narrative.paragraphs[0] = overview.groups[0].target.narrative.paragraphs[0].replace('completed', '漢')
  await assert.rejects(writer.generatePdfReport(overview, options), /U\+6F22.*No source text was substituted or omitted/)
  for (const identity of ['analysis', 'candidate', 'target']) {
    const copy = structuredClone(report)
    if (identity === 'analysis') copy.run.name = 'Current analysis 🚀'
    if (identity === 'candidate') copy.groups[0].comparisons[0].candidate.displayName = 'Captured candidate 🚀'
    if (identity === 'target') copy.groups[0].target.displayName = 'Captured target 🚀'
    await assert.rejects(writer.generatePdfReport(copy, options), /U\+1F680.*No source text was substituted or omitted/)
  }
})

test('PDF: invalid application origins and unsafe layout links are rejected explicitly', async () => {
  const report = foundation.buildAnalysisReport(readablePdfFixture({ criterionCount: 1 }))
  await assert.rejects(writer.generatePdfReport(report, { fonts: options.fonts }), /origin|link|application/i)
  for (const origin of ['javascript:alert(1)', 'file:///private/report.pdf', 'https://user:password@score.example']) {
    await assert.rejects(writer.generatePdfReport(report, { ...options, links: { origin } }), /origin|link|application|credential/i)
  }
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  const font = await document.embedFont(options.fonts.regular, { subset: true })
  const layout = new writer.PdfReportLayout(document, { regular: font, bold: font }, '')
  layout.startSection({ section: 'Link QA', primary: 'Saved candidate', secondary: 'Engineering specialist' })
  assert.throws(() => layout.paragraph('Unsafe link', { link: 'javascript:alert(1)' }), /safe HTTP or HTTPS/)
})

test('PDF: missing or duplicate internal destinations and overlong running headers fail explicitly', async () => {
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  const font = await document.embedFont(options.fonts.regular, { subset: true })
  const layout = new writer.PdfReportLayout(document, { regular: font, bold: font }, '')
  layout.startSection({ section: 'Contents', primary: 'Included target sections', secondary: 'Navigation within this report' })
  layout.markDestination('contents')
  assert.throws(() => layout.markDestination('contents'), /unique identities/)
  layout.paragraph('Open a missing target', { link: { destination: 'missing-target' } })
  assert.throws(() => layout.finish(), /internal link has no final destination/)
  assert.throws(() => layout.startSection({
    section: 'Target overview', primary: 'Unbounded running identity '.repeat(100), secondary: 'Job analysis 1',
  }), /running headers require short section labels/)
})

test('PDF: full source validation is not bypassed for deliberately omitted quote or provenance content', () => {
  const invalid = readablePdfFixture({ criterionCount: 1 })
  invalid.comparisons[0].criteria[0].citations[0].locator = 'Mismatched hidden locator'
  assert.throws(() => foundation.buildAnalysisReport(invalid), /Citation locator does not match/)
  const oversized = readablePdfFixture({ criterionCount: 1 })
  oversized.comparisons[0].provenance.push({ label: 'Hidden oversized field', value: 'W'.repeat(writer.REPORT_LIMITS.maxTextCharacters + 1) })
  assert.throws(() => foundation.buildAnalysisReport(oversized), /too_big|Too big|100000/)
})

test('PDF: page, input/output byte and generation-time limits fail explicitly without returning a shortened report', async () => {
  const report = foundation.buildAnalysisReport(readablePdfFixture({ criterionCount: 1 }))
  const limits = { ...writer.REPORT_LIMITS }
  try {
    writer.REPORT_LIMITS.maxPages = 1
    await assert.rejects(writer.generatePdfReport(report, options), /1-page resource limit.*Narrow the export.*no comparisons or evidence have been omitted/)
    writer.REPORT_LIMITS.maxPages = limits.maxPages
    writer.REPORT_LIMITS.maxOutputBytes = 32
    await assert.rejects(writer.generatePdfReport(report, options), /output resource limit.*Narrow the export/)
    writer.REPORT_LIMITS.maxOutputBytes = limits.maxOutputBytes
    writer.REPORT_LIMITS.maxInputBytes = 32
    await assert.rejects(writer.generatePdfReport(report, options), /Report data exceeds.*resource limit/)
    writer.REPORT_LIMITS.maxInputBytes = limits.maxInputBytes
    writer.REPORT_LIMITS.maxGenerationMilliseconds = -1
    await assert.rejects(writer.generatePdfReport(report, options), /time limit.*Narrow the export/)
  } finally {
    Object.assign(writer.REPORT_LIMITS, limits)
  }
})

test('PDF: every one of 500 completed candidates remains in the overview, without 500 individual review sections', async context => {
  const input = readablePdfFixture({ scores: Array(500).fill(80), criterionCount: 1 })
  const pdf = await generate(input)
  const summary = overviewText(pdf)
  assert.equal(reviewSections(pdf).length, 10)
  const destinations = new Set(overviewPages(pdf).flatMap(page => page.annotations.map(link => link.url)))
  assert.equal(destinations.size, 500)
  for (const comparison of pdf.report.groups[0].comparisons) {
    assert.equal(occurrences(summary, comparison.candidate.name), 1)
    assert.ok(destinations.has(writer.reportReviewLinks(pdf.report, comparison, options).analysis))
  }
  assert.ok(pdf.pages.length <= writer.REPORT_LIMITS.maxPages)
  assert.ok(pdf.bytes.byteLength <= writer.REPORT_LIMITS.maxOutputBytes)
  assertNoTechnicalMetadata(pdf)
  assertContentsDestinations(pdf)
  assertNoClipping(pdf)
  context.diagnostic(`${pdf.pages.length} pages; ${pdf.bytes.byteLength} bytes; generation ${pdf.generationMilliseconds} ms; inspection ${pdf.inspectionMilliseconds} ms`)
})

test('PDF: fictional multi-job and long-metadata fixtures expose local visual QA generation hooks', async () => {
  for (const kind of ['multi', 'long-metadata']) {
    const input = fictionalPdfNavigationQaFixture(kind)
    const pdf = await generate(input)
    assertContentsDestinations(pdf)
    assert.equal(targetOpenerPages(pdf).length, 3)
    assert.equal(overviewPages(pdf).flatMap(page => page.uriAnnotations).length, 12)
    assert.doesNotMatch(pdf.body, /Legacy composite|\.{3}|\u2026/)
    assertNoClipping(pdf)
    await savePdfQaArtifact(`score-pdf-fictional-${kind}-v3.pdf`, input)
  }
})

test('PDF: writer bundles for the browser without Node filesystem access, font fetches or conversion services', async () => {
  const bundle = await build({
    entryPoints: [resolve('src', 'services', 'analysisReports', 'pdf.ts')],
    bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
  })
  assert.equal(bundle.outputFiles.length, 1)
  assert.ok(bundle.outputFiles[0].text.includes('generatePdfReport'))
  const source = await readFile(resolve('src', 'services', 'analysisReports', 'pdf.ts'), 'utf8')
  assert.doesNotMatch(source, /node:fs|readFile|fetch\s*\(|https?:\/\//)
})
