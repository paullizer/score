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
import { loadReportFoundation, reportFixtureCitation, REPORT_TEST_TIMESTAMP } from './test-support.mjs'
import {
  assertNoClipping as checkClipping, fictionalPdfQaFixture, fictionalSampleInput, overviewPages, readablePdfFixture, readPdf, reviewSections,
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

async function generate(input = readablePdfFixture(), generationOptions = options) {
  const source = JSON.stringify(input)
  const report = foundation.buildAnalysisReport(input)
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

function assertNoTechnicalMetadata(pdf) {
  assert.doesNotMatch(pdf.text, /Run ID:|Workspace ID:|Exact target ID:|Candidate ID:|Comparison ID:|Criterion ID:|SHA-256|Capture interval:|Saved provenance|Review \d|Partial report|cutoff|competition rank|Assessment model|Output correction count|RAW-GUIDANCE-|RAW-WORDING-|RAW-RESUME-QUOTE-|RAW-REQUIREMENT-QUOTE-/i)
  assert.ok(pdf.pages.every(page => !page.section.includes('PARTIAL')))
  for (const group of pdf.report.groups) {
    for (const value of [group.target.id, group.target.rubricId, group.target.versionLabel, group.target.snapshot?.sha256]) {
      if (value) assert.ok(!pdf.text.includes(value), `Technical metadata was displayed: ${value}`)
    }
    for (const comparison of group.comparisons) {
      for (const value of [comparison.id, comparison.candidate.id, comparison.candidate.documentId, comparison.resultSha256]) {
        if (value) assert.ok(!pdf.text.includes(value), `Technical identity was displayed: ${value}`)
      }
    }
  }
}

test('PDF: concise searchable report includes job context, one caution, all criterion scores and page numbers', async context => {
  const input = readablePdfFixture()
  const pdf = await generate(input)
  assert.equal(pdf.document.getTitle(), 'Analysis evidence report')
  assert.equal(pdf.document.getAuthor(), 'Score')
  assert.equal(occurrences(pdf.body, 'Analysis evidence report'), 1)
  assert.equal(occurrences(pdf.body, foundation.REPORT_HUMAN_REVIEW_NOTICE), 1)
  assert.equal(occurrences(pdf.body, 'Analysis date:'), 1)
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
  assert.ok(pdf.annotations.every(link => new URL(link.url).origin === options.links.origin))
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
    foundation.buildAnalysisReport(fictionalSampleInput(input))
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

test('PDF: every exact target has its own completed-only overview before featured candidate reviews', async () => {
  const input = readablePdfFixture({ scores: [92, 81, 0, null, 60], statuses: ['complete', 'complete', 'complete', 'complete', 'queued'], targetCount: 2, criterionCount: 1 })
  input.comparisons[1].overall.score = 5
  input.comparisons[3].overall.score = 99
  input.comparisons[5].overall.score = 40
  const pdf = await generate(input)
  const overviews = overviewPages(pdf)
  assert.equal(occurrences(overviewText(pdf), 'Candidates at a glance'), 2)
  assert.ok(overviewText(pdf).includes('candidate-job reviews'))
  assert.ok(overviews.every(page => pdf.pages.indexOf(page) < pdf.pages.findIndex(item => item.section.endsWith('Candidate review'))))
  assert.equal(overviews.flatMap(page => page.annotations).length, 8)
  const labels = new Set(overviews.map(page => page.items.find(item => item.y === 734)?.source))
  assert.equal(labels.size, 2, 'Same-label exact targets need readable disambiguation, not merged overview rows')
  const sections = reviewSections(pdf)
  const featured = pdf.report.groups.flatMap(group => group.highlightedComparisonIds.map(id => ({ group, comparison: group.comparisons.find(item => item.id === id) })))
  assert.equal(sections.length, featured.length)
  sections.forEach((section, index) => {
    const { comparison } = featured[index]
    assert.ok(section.body.includes(comparison.candidate.name))
    for (const page of section.pages) {
      assert.ok(page.items.some(item => item.y === 734 && item.source === comparison.candidate.name))
      assert.ok(page.items.some(item => item.y === 718 && item.source.includes('Engineering specialist')))
    }
  })
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
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
  const input = readablePdfFixture({
    scores: [0, null, 40, 30, 20, 10], statuses: ['complete', 'complete', 'queued', 'running', 'failed', 'cancelled'], criterionCount: 1,
  })
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
  const destinations = overviewPages(pdf).flatMap(page => page.annotations.map(link => link.url))
  assert.equal(new Set(destinations).size, 3)
  assert.ok(!pdf.text.includes('candidate-2'), 'Unnamed fallbacks must not disclose raw candidate IDs')
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
  layout.startSection({ section: 'Candidate review', primary: `José Zoë — ${'Ω'.repeat(180)}`, secondary: `Engineering specialist ${'W'.repeat(180)}` })
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
  assert.ok(pdf.pages.every(page => page.items.some(item => item.y === 734 && item.source.startsWith('José Zoë'))))
  assertNoClipping(pdf)
})

test('PDF: metadata-rich records retain concise rationale, not audit text or unsupported omitted glyphs', async () => {
  const input = readablePdfFixture({ scores: [60, 60], criterionCount: 1 })
  input.run.name = 'Internal processing audit 🚀'
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
  assert.doesNotMatch(pdf.text, /🚀|漢|audit only|Internal processing/)
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
    assert.ok(page.items.some(item => item.y === 734 && item.source === 'Alex Morgan'))
    assert.ok(page.items.some(item => item.y === 718 && item.source.includes('Engineering specialist')))
  }
  assertNoTechnicalMetadata(pdf)
  assertNoClipping(pdf)
  await savePdfQaArtifact('score-pdf-fictional-large-scorecard-v2.pdf', fictionalPdfQaFixture('large'))
  context.diagnostic(`${section.pages.length} pages for all 100 criteria and their rationales`)
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
  assertNoClipping(pdf)
  context.diagnostic(`${pdf.pages.length} pages; ${pdf.bytes.byteLength} bytes; generation ${pdf.generationMilliseconds} ms; inspection ${pdf.inspectionMilliseconds} ms`)
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
