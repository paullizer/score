import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import fontkit from '@pdf-lib/fontkit'
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { loadReportFoundation, realReportFixture, reportFixtureCitation, REPORT_TEST_TIMESTAMP } from './test-support.mjs'

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
  }
  measurementFonts = { regular: fontkit.create(regular), bold: fontkit.create(bold) }
})
after(async () => {
  await cleanup?.()
  if (output) await rm(output, { recursive: true, force: true })
})

const utf16Decoder = new TextDecoder('utf-16be')
const streamDecoder = new TextDecoder()
const utf16 = hex => utf16Decoder.decode(Buffer.from(hex, 'hex'))
const streamText = (document, reference) => streamDecoder.decode(decodePDFRawStream(document.context.lookup(reference, PDFRawStream)).decode())

async function readPdf(bytes) {
  assert.ok(bytes instanceof Uint8Array)
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-')
  const document = await PDFDocument.load(bytes)
  const fontCache = new Map()
  const pages = document.getPages().map(page => {
    const fonts = new Map()
    const resources = page.node.Resources().lookup(PDFName.of('Font'), PDFDict)
    for (const [key, reference] of resources.entries()) {
      if (fontCache.has(reference.toString())) {
        fonts.set(key.toString().slice(1), fontCache.get(reference.toString()))
        continue
      }
      const dictionary = document.context.lookup(reference, PDFDict)
      assert.equal(dictionary.get(PDFName.of('Subtype')).toString(), '/Type0')
      assert.ok(dictionary.has(PDFName.of('ToUnicode')), 'Embedded text font needs a Unicode character map')
      const cmap = streamText(document, dictionary.get(PDFName.of('ToUnicode')))
      const bfchars = cmap.match(/beginbfchar([\s\S]*?)endbfchar/)[1]
      const characters = new Map(Array.from(bfchars.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi),
        match => [match[1].toUpperCase(), utf16(match[2])]))
      const font = { characters, bold: dictionary.get(PDFName.of('BaseFont')).toString().includes('Bold') }
      fonts.set(key.toString().slice(1), font)
      fontCache.set(reference.toString(), font)
    }
    const contents = page.node.Contents()
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents]
    const content = streams.map(reference => streamText(document, reference)).join('\n')
    const text = []
    for (const match of content.matchAll(/\/Span\s*<<\s*\/ActualText\s*<([0-9a-f]*)>\s*>>\s*BDC([\s\S]*?)EMC/gi)) {
      const positioning = content.slice(content.lastIndexOf('BT\n', match.index), match.index)
      const fontMatch = positioning.match(/\/([^\s/]+)\s+([\d.]+)\s+Tf/)
      const position = positioning.match(/1 0 0 1 ([-\d.]+) ([-\d.]+) Tm/)
      assert.ok(fontMatch && position, 'Source text must accompany actual selectable page text, not only PDF metadata')
      const font = fonts.get(fontMatch[1])
      assert.ok(font)
      const glyphs = Array.from(match[2].matchAll(/<([0-9a-f]*)>\s*Tj/gi), item => item[1]).join('')
      let rendered = ''
      for (let offset = 0; offset < glyphs.length; offset += 4) {
        const glyph = glyphs.slice(offset, offset + 4).toUpperCase()
        assert.notEqual(glyph, '0000', 'Missing-glyph substitution is never allowed')
        assert.ok(font.characters.has(glyph), `Glyph ${glyph} must be mapped to Unicode`)
        rendered += font.characters.get(glyph)
      }
      text.push({
        source: utf16(match[1]), rendered, x: Number(position[1]), y: Number(position[2]),
        size: Number(fontMatch[2]), bold: font.bold,
      })
    }
    assert.ok(text.length, 'Every page should contain real text drawing operations')
    return {
      width: page.getWidth(), height: page.getHeight(), items: text,
      text: text.map(item => item.source).join(''),
      rendered: text.map(item => item.rendered).join(''),
      body: text.filter(item => item.y > 60 && item.y < 704).map(item => item.source).join(''),
    }
  })
  return { document, pages, text: pages.map(page => page.text).join('\n'), body: pages.map(page => page.body).join('') }
}

async function generate(input = realReportFixture({ scores: [92.75] })) {
  const report = foundation.buildAnalysisReport(input)
  const before = JSON.stringify(report)
  const started = Date.now()
  const bytes = await writer.generatePdfReport(report, options)
  const generated = Date.now()
  assert.equal(JSON.stringify(report), before, 'PDF generation must not mutate saved evidence or rankings')
  const pdf = await readPdf(bytes)
  return { report, bytes, ...pdf, generationMilliseconds: generated - started, inspectionMilliseconds: Date.now() - generated }
}

async function savePdfQaArtifact(name, bytes) {
  const directory = process.env.REPORT_PDF_QA_DIRECTORY
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name), bytes)
}

function reviewSections(pdf) {
  const sections = []
  for (const page of pdf.pages) {
    if (page.body.includes('CANDIDATE / TARGET REVIEW ')) sections.push({ pages: [] })
    if (sections.length) sections.at(-1).pages.push(page)
  }
  return sections.map(section => ({ ...section, body: section.pages.map(page => page.body).join('') }))
}

function assertNoClipping(pdf) {
  for (const page of pdf.pages) {
    assert.equal(page.width, 612)
    assert.equal(page.height, 792)
    for (const item of page.items) {
      const font = item.bold ? measurementFonts.bold : measurementFonts.regular
      const { glyphs } = font.layout(item.rendered, { liga: false, clig: false })
      const width = glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) * item.size / font.unitsPerEm
      assert.ok(item.x >= 46 - 0.01, `Text crossed left margin at ${item.x}: ${item.source.slice(0, 80)}`)
      assert.ok(item.x + width <= 566 + 0.1, `Text crossed right margin: ${item.source.slice(0, 80)}`)
      if (item.y > 60 && item.y < 704) {
        assert.ok(item.size >= 9.5, 'Body text must not shrink below 9.5 pt')
        assert.ok(item.y + font.ascent * item.size / font.unitsPerEm <= 685 + 0.1, 'Body collided with continuation header')
        assert.ok(item.y + font.descent * item.size / font.unitsPerEm >= 66 - 0.1, 'Body collided with footer')
      }
    }
  }
}

function richMetadataInput() {
  const input = realReportFixture({ scores: [60, 60], criterionCount: 1 })
  input.run.name = 'PDF layout QA — synthetic saved records'
  const target = input.targets[0]
  const identity = '1bf996c9-2c24-4292-81a1-922edad5bd3f'
  const hash = 'a123456789bcdef0'.repeat(4)
  target.id = `target-${hash.slice(0, 48)}`
  target.rubricId = `rubric-${identity}`
  target.selection.rubricId = target.rubricId
  target.selection.jobId = `job-${identity}`
  target.snapshot.snapshotId = `analysis-snapshot-${identity}`
  target.label = 'Engineering specialist'
  target.sublabel = 'Integration test agency · Engineering work rubric · v1'
  target.versionLabel = 'Rubric v1 · source document v1'
  target.criteria[0].label = 'Engineering methods'
  target.criteria[0].description = 'Apply engineering methods to defined projects and communicate findings.'
  target.criteria[0].guidance = '0: No evidence. 1: Observed work. 2: Assisted work. 3: Independent work. 4: Complex work. 5: Sustained broad work.'
  target.facts = [
    ['Rubric description', 'Source-grounded test seed.'], ['Rubric created', REPORT_TEST_TIMESTAMP],
    ['Inputs frozen', REPORT_TEST_TIMESTAMP], ['Organization', 'Integration test agency'],
    ['Series', '0801'], ['Grade', 'GS-9'], ['Source captured', REPORT_TEST_TIMESTAMP],
    ['Rubric SHA-256', hash], ['Requirement document SHA-256', hash],
  ].map(([label, value]) => ({ label, value }))
  input.comparisons.forEach((comparison, index) => {
    comparison.targetId = target.id
    comparison.id = `analysis-comparison-${identity}-${index}`
    comparison.candidate.id = `resume-${identity}-${index}`
    comparison.candidate.name = 'Jordan Example'
    comparison.candidate.role = 'Engineering specialist'
    comparison.candidate.snapshot.snapshotId = `analysis-snapshot-${identity}-${index}`
    comparison.summary = 'The submitted document was compared only with this exact saved rubric. Criterion evidence: 1 supported, 0 partial, 0 missing, 0 not assessed, and 0 excluded. The document evidence-match total is 60/100. Missing evidence does not establish that a person lacks ability. This is a human-review aid, not a hiring recommendation or an official GS eligibility decision.'
    comparison.criteria[0].rationale = 'The cited passage describes independent engineering work within defined projects, matching the saved independent-work anchor.'
    comparison.provenance = [
      ['Manifest SHA-256', hash], ['Assessment SHA-256', hash], ['Assessment model', 'gpt-5-mini-fixture'],
      ['Assessment deployment', 'fixture-deployment'], ['Assessment prompt version', 'score-analysis-assessment-v1'],
      ['Assessment schema version', 'score-analysis-assessment-v1'], ['Assessment started', REPORT_TEST_TIMESTAMP],
      ['Assessment completed', REPORT_TEST_TIMESTAMP], ['Output correction count', '0'],
      ['Calculation version', 'weighted-0-100-v1'], ['Resume source captured', REPORT_TEST_TIMESTAMP],
      ['Resume extraction', 'document-intelligence · score-resume-extraction-v1'],
      ['Grounding review 1', `analysis-grounding-${identity} · supported`],
      ['Grounding model 1', 'gpt-5-mini-fixture · fixture-deployment'],
      ['Grounding prompt 1', 'score-analysis-grounding-v1'], ['Grounding completed 1', REPORT_TEST_TIMESTAMP],
    ].map(([label, value]) => ({ label, value }))
  })
  return input
}

test('PDF: display headings and original source identities are both selectable', async () => {
  const input = realReportFixture({ scores: [92.75] })
  input.run.name = 'Renamed analysis'
  input.targets[0].displayName = 'Custom target'
  input.comparisons[0].candidate.displayName = 'Custom candidate'
  const pdf = await generate(input)
  for (const value of ['Renamed analysis', 'Custom target', 'Custom candidate',
    `Source-stated name: ${input.comparisons[0].candidate.name}`, `Source target title: ${input.targets[0].label}`]) {
    assert.ok(pdf.text.includes(value), `Missing label or source identity: ${value}`)
  }
  assertNoClipping(pdf)
})

test('PDF: a real, selectable US letter PDF includes saved context, Unicode fonts, evidence, provenance and page numbers', async () => {
  const pdf = await generate()
  assert.equal(pdf.document.getTitle(), foundation.reportTitle(pdf.report))
  assert.equal(pdf.document.getAuthor(), 'Score')
  assert.ok(pdf.pages.length >= 2)
  assert.ok(pdf.bytes.byteLength < writer.REPORT_LIMITS.maxOutputBytes)
  for (const expected of [
    'Analysis evidence report', 'Saved evidence review', 'run-one', 'workspace-one',
    '2026-09-18T18:00:00.000Z to 2026-09-18T18:00:02.000Z',
    'Generated: 2026-09-18T18:00:03.000Z', '92.75 / 100',
    'not an instantaneous database snapshot', 'Highest evidence matches',
    'Saved summary excerpt:', 'Criterion highlights (excerpt):',
    'Full saved overall assessment', 'Criterion summary', 'Detailed criterion evidence',
    'Exact saved rationale for criterion-0.', 'Captured HTML section 3', 'PDF page 178',
    'Resume evidence', 'Requirement evidence',
  ]) assert.ok(pdf.body.includes(expected), `Missing report content: ${expected}`)
  assert.ok(pdf.pages.map(page => page.rendered).join('').includes('Documented evidence with café, naïve, Ω, and Кириллица.'))
  assert.ok(pdf.body.includes(foundation.REPORT_HUMAN_REVIEW_NOTICE))
  for (const comparison of pdf.report.groups[0].comparisons) {
    assert.ok(pdf.body.includes(`Comparison ID: ${comparison.id}`))
    assert.ok(pdf.body.includes(`Saved result SHA-256: ${comparison.resultSha256}`))
    for (const criterion of comparison.criteria) {
      for (const citation of [...criterion.citations, ...criterion.requirementCitations]) {
        assert.ok(pdf.body.includes(citation.quote))
        assert.ok(pdf.body.includes(citation.locator))
      }
    }
  }
  pdf.pages.forEach((page, index) => assert.ok(page.text.includes(`Page ${index + 1} of ${pdf.pages.length}`)))
  assertNoClipping(pdf)
})

test('PDF: an installed independent reader extracts searchable phrases and Unicode evidence', async context => {
  const pdf = await generate()
  const path = join(output, 'reader-check.pdf')
  await writeFile(path, pdf.bytes)
  const result = spawnSync('pdftotext', ['-raw', '-enc', 'UTF-8', path, '-'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error?.code === 'ENOENT') {
    context.skip('Optional local pdftotext reader is unavailable; embedded glyphs and Unicode maps are checked in the portable tests.')
    return
  }
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  for (const phrase of [
    'Analysis evidence report', 'Full saved overall assessment',
    'Documented evidence with café, naïve, Ω, and Кириллица.',
    'Exact saved rationale for criterion-0.', 'Resume evidence 1',
  ]) assert.ok(result.stdout.includes(phrase), `Independent reader lost searchable text: ${phrase}`)
})

test('PDF: every exact-target summary precedes every pair review, with independent saved ranks and no skipped comparisons', async () => {
  const input = realReportFixture({ scores: [92, 81, 0], targetCount: 2, criterionCount: 1 })
  input.comparisons[1].overall.score = 5
  input.comparisons[3].overall.score = 99
  input.comparisons[5].overall.score = 40
  const pdf = await generate(input)
  const firstDetail = pdf.pages.findIndex(page => page.body.includes('CANDIDATE / TARGET REVIEW '))
  const summaries = pdf.pages.slice(0, firstDetail).map(page => page.body).join('')
  assert.ok(summaries.includes('Exact target ID: target-0'))
  assert.ok(summaries.includes('Exact target ID: target-1'))
  assert.ok(summaries.includes('rubric-0 · version 1'))
  assert.ok(summaries.includes('rubric-1 · version 2'))
  assert.equal(pdf.pages.slice(0, firstDetail).flatMap(page => page.items).filter(item => item.source === 'Highest evidence matches').length, 2)
  const sections = reviewSections(pdf)
  const ordered = pdf.report.groups.flatMap(group => group.comparisons)
  assert.equal(sections.length, input.comparisons.length)
  sections.forEach((section, index) => {
    const comparison = ordered[index]
    assert.ok(section.body.includes(`Comparison ID: ${comparison.id}`))
    assert.ok(section.body.includes(`Evidence-match rank within this exact target: ${comparison.rank}`))
    assert.equal((pdf.body.match(new RegExp(`Comparison ID: ${comparison.id}(?!\\d)`, 'g')) ?? []).length, 1)
    for (const page of section.pages) {
      assert.ok(page.text.includes(`Review ${index + 1} of ${ordered.length}`))
      assert.ok(page.items.some(item => item.y === 718 && item.source.includes('Same saved target label')))
    }
  })
  assertNoClipping(pdf)
})

test('PDF: capped fifth-place ties are disclosed; only supplied highlights appear in the opening table, with all candidates in details', async () => {
  const pdf = await generate(realReportFixture({ scores: [100, 99, 98, 97, ...Array(11).fill(80), 0], criterionCount: 1 }))
  const firstDetail = pdf.pages.findIndex(page => page.body.includes('CANDIDATE / TARGET REVIEW '))
  const summary = pdf.pages.slice(0, firstDetail).map(page => page.body).join('')
  assert.ok(firstDetail >= 1 && firstDetail <= 3, `Typical single-target summary used ${firstDetail} pages`)
  assert.ok(summary.includes('5 additional candidates tied at 80 / 100'))
  assert.ok(summary.includes('not an evidence advantage'))
  assert.equal((summary.match(/Saved summary excerpt:/g) ?? []).length, 10)
  const summaryLines = pdf.pages.slice(0, firstDetail).flatMap(page => page.items.map(item => item.source))
  for (const id of pdf.report.groups[0].highlightedComparisonIds) assert.ok(summaryLines.includes(id))
  assert.ok(!summaryLines.includes('comparison-10'))
  assert.equal(reviewSections(pdf).length, 16)
  const tablePages = pdf.pages.slice(0, firstDetail).filter(page => page.body.includes('Saved summary excerpt:'))
  assert.ok(tablePages.length > 1)
  for (const page of tablePages) {
    assert.ok(page.body.includes('Rank'))
    assert.ok(page.body.includes('Saved assessment highlights'), 'Table headers must repeat on summary continuation pages')
  }
})

test('PDF: zero, withheld, partial, failed and unfinished pairs remain distinct without invented assessments', async () => {
  const input = realReportFixture({
    scores: [0, null, 40, 30, 20, 10], statuses: ['complete', 'complete', 'queued', 'running', 'failed', 'cancelled'], criterionCount: 1,
  })
  const pdf = await generate(input)
  assert.ok(pdf.body.includes('Partial report: 2 of 6 comparisons complete; 1 scored; 1 overall scores withheld; 1 queued; 1 running; 1 failed; 1 cancelled.'))
  assert.ok(pdf.pages.every(page => page.text.includes('SAVED ANALYSIS · PARTIAL')))
  const sections = reviewSections(pdf)
  assert.equal(sections.length, 6)
  assert.ok(sections[0].body.includes('Saved overall score: 0 / 100'))
  assert.ok(sections[0].body.includes('Evidence-match rank within this exact target: 1'))
  assert.ok(sections[1].body.includes('Saved overall score: Withheld — Weighted criteria were not assessed.'))
  assert.ok(sections[1].body.includes('Score availability reason: unassessed-weighted-criteria'))
  assert.ok(sections[1].body.includes('Not assessed'))
  for (const [index, status] of ['Queued', 'Running', 'Failed', 'Cancelled'].entries()) {
    const body = sections[index + 2].body
    assert.ok(body.includes(`Status at capture: ${status}`))
    assert.ok(body.includes('Saved overall score: Unavailable'))
    assert.ok(!body.includes('Criterion summary'))
    assert.ok(!body.includes('Full saved overall assessment'))
    assert.ok(!body.includes(' / 100'))
  }
  assert.ok(sections[4].body.includes('Processing error · storage-error'))
  assert.ok(sections[4].body.includes('Saved source could not be read.'))
  assert.ok(sections[4].body.includes('Stage: assessment · Retryable: Yes'))
})

test('PDF: all-withheld summaries do not invent highlights, and fictional sample reports are marked throughout', async () => {
  const withheld = await generate(realReportFixture({ scores: [null], criterionCount: 1 }))
  assert.ok(withheld.body.includes('No scored highlights are available for this exact target.'))
  assert.ok(!withheld.body.includes('Saved summary excerpt:'))
  assert.equal(reviewSections(withheld).length, 1)
  const report = foundation.buildSampleAnalysisReport(foundation.createInitialWorkspace().runs[0], { generatedAt: REPORT_TEST_TIMESTAMP })
  const sample = await readPdf(await writer.generatePdfReport(report, options))
  assert.ok(sample.body.includes('Sample Analysis evidence report'))
  assert.ok(sample.body.includes(foundation.REPORT_SAMPLE_NOTICE))
  assert.ok(sample.pages.every(page => page.text.includes('SAMPLE')))
  assert.equal(reviewSections(sample).length, report.counts.total)
})

test('PDF: supported Unicode, source newlines, tabs, combining accents and unbroken strings are preserved without clipping', async () => {
  const input = realReportFixture({ scores: [92], criterionCount: 1 })
  const comparison = input.comparisons[0]
  comparison.candidate.name = 'José Zoë — Ω Кириллица, Łukasz'
  comparison.candidate.role = 'Cafe\u0301 analyst'
  const unbroken = `LONG-START-${'W'.repeat(2200)}-LONG-END`
  comparison.summary = `First line with exact  spaces.\r\nSecond\tline with A\u0301 and résumé.\n${unbroken}\nSummary ending preserved.`
  comparison.criteria[0].citations[0].quote = 'Exact “naïve” résumé quotation.\nNext\tline Ω; Кириллица; A\u0301.'
  const pdf = await generate(input)
  assert.ok(pdf.body.includes(comparison.candidate.name))
  assert.ok(pdf.body.includes(comparison.candidate.role))
  assert.ok(pdf.body.includes(comparison.summary), 'Full saved assessment must survive pagination with original source whitespace')
  assert.ok(pdf.body.includes(comparison.criteria[0].citations[0].quote))
  assertNoClipping(pdf)
})

test('PDF: citation endings stay with their source locators across short and multi-page quote boundaries', async () => {
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  const fonts = {
    regular: await document.embedFont(options.fonts.regular, { subset: true, features: { liga: false, clig: false } }),
    bold: await document.embedFont(options.fonts.bold, { subset: true, features: { liga: false, clig: false } }),
  }
  const layout = new writer.PdfReportLayout(document, fonts, 'SAVED ANALYSIS')
  layout.startSection({ section: 'Citation QA', primary: 'Review 1 · Saved candidate', secondary: 'Target 1 · Saved target' })
  layout.paragraph(Array(35).fill('Filler line.').join('\n'))
  const cases = [
    ['Short citation', 'SHORT-QUOTE-END', 'Source locator: SHORT-LOCATOR\nExact document version and paragraph.'],
    ['Long citation', `${Array(46).fill('Full saved evidence line.').join('\n')}\nLONG-QUOTE-END`, 'Source locator: LONG-LOCATOR · version 2 · paragraph final-evidence'],
    ['Near-page-height locator', 'First quote line.\nSecond quote line.\nTALL-QUOTE-END', `Source locator: TALL-LOCATOR\n${Array(38).fill('Exact source locator continuation.').join('\n')}`],
    ['Multi-page locator', 'HUGE-QUOTE-END', `Source locator: HUGE-LOCATOR\n${Array(46).fill('Full source locator continuation.').join('\n')}`],
  ]
  for (const [label, quote, locator] of cases) layout.citation(label, quote, locator)
  layout.finish()
  const pdf = await readPdf(await document.save())
  for (const [label, quote, locator] of cases) {
    const tail = quote.split('\n').at(-1)
    const firstLocatorLine = locator.split('\n')[0]
    const page = pdf.pages.find(value => value.body.includes(tail))
    assert.ok(page?.body.includes(firstLocatorLine), `Orphaned locator after ${label}`)
    assert.ok(pdf.body.includes(quote), `Truncated quote in ${label}`)
    assert.ok(pdf.body.includes(locator), `Truncated locator in ${label}`)
  }
  assert.ok(pdf.pages[1].body.includes('Short citation'), 'Move the short quotation, label and locator together when only 86 pt remain')
  assertNoClipping(pdf)
})

test('PDF: metadata-rich basic reviews compact provenance without dropping exact facts or immutable identities', async context => {
  const input = richMetadataInput()
  const pdf = await generate(input)
  const sections = reviewSections(pdf)
  assert.equal(sections.length, 2)
  sections.forEach((section, index) => {
    assert.ok(section.pages.length <= 3, `A one-criterion review used ${section.pages.length} pages`)
    const comparison = input.comparisons[index]
    for (const fact of [...input.targets[0].facts, ...comparison.provenance]) {
      assert.ok(section.body.includes(`${fact.label}: ${fact.value}`), `Lost provenance fact ${fact.label}`)
    }
    for (const value of [
      input.targets[0].id, input.targets[0].rubricId, input.targets[0].snapshot.snapshotId, input.targets[0].snapshot.sha256,
      comparison.id, comparison.candidate.id, comparison.candidate.snapshot.snapshotId,
      comparison.candidate.snapshot.sha256, comparison.candidate.documentSha256, comparison.resultSha256,
      ...Object.values(input.targets[0].selection).map(String),
    ]) assert.ok(section.body.includes(value), `Lost exact identity ${value}`)
    for (const criterion of comparison.criteria) {
      for (const citation of [...criterion.citations, ...criterion.requirementCitations]) {
        assert.ok(section.pages.some(page => page.body.includes(citation.quote) && page.body.includes(citation.locator)),
          'A basic review must keep each short quote with its full locator')
      }
    }
  })
  assertNoClipping(pdf)
  await savePdfQaArtifact('score-pdf-compact-review.pdf', pdf.bytes)
  context.diagnostic(`${pdf.pages.length} pages total; ${sections.map(section => section.pages.length).join(', ')} pages per metadata-rich review`)
})

test('PDF: fractional criterion weights use the shared display formatter and explain rounding without changing saved values', async () => {
  const input = realReportFixture({ scores: [92], criterionCount: 3 })
  const pdf = await generate(input)
  assert.ok(pdf.body.includes('Saved weight: ~33.33%'))
  assert.ok(pdf.body.includes('A ~ before a weight denotes display rounding only.'))
  assert.ok(!pdf.body.includes('33.333333333333336%'))
  assert.equal(pdf.report.groups[0].comparisons[0].criteria[0].weight, 100 / 3)
  assert.ok(pdf.pages.some(page => page.items.some(item => item.source === '~33.33%')), 'A formatted weight should fit on one table line')
  assertNoClipping(pdf)
})

test('PDF: an oversized table row and long continuation identities paginate without dropping source text', async () => {
  const input = realReportFixture({ scores: [92], criterionCount: 1 })
  const name = `NAME-START-${'W'.repeat(1200)}-NAME-END`
  const label = `CRITERION-START-${'Ω'.repeat(1800)}-CRITERION-END`
  input.comparisons[0].candidate.name = name
  input.targets[0].criteria[0].label = label
  input.comparisons[0].criteria[0].citations[0] = reportFixtureCitation('resume-document-0', {
    heading: `LONG-HEADING-${'H'.repeat(700)}-HEADING-END`, quote: 'Exact quotation beneath a very long saved locator.',
  })
  const pdf = await generate(input)
  assert.ok(pdf.body.includes(name))
  assert.ok(pdf.body.includes(label))
  assert.ok(pdf.body.includes(input.comparisons[0].criteria[0].citations[0].locator))
  assert.equal(reviewSections(pdf).length, 1)
  assert.ok(pdf.pages.filter(page => page.body.includes('Saved assessment highlights')).length >= 2)
  assert.ok(pdf.pages.filter(page => page.body.includes('Criterion / requirement')).length >= 2)
  assertNoClipping(pdf)
})

test('PDF: long assessments, twenty criteria and many quotations add pages without losing final evidence or locators', async () => {
  const baseline = await generate(realReportFixture({ scores: [92], criterionCount: 1 }))
  const input = realReportFixture({ scores: [92], criterionCount: 20 })
  input.comparisons[0].summary = `${'Long saved assessment paragraph. '.repeat(550)}ASSESSMENT-FINAL-MARKER`
  const target = input.targets[0]
  const comparison = input.comparisons[0]
  target.criteria.forEach((definition, index) => {
    definition.label = `Criterion label ${index + 1} with a stable saved identity`
    definition.description = `Full wording marker ${index}. ${'Detailed requirement wording. '.repeat(5)}WORDING-END-${index}`
    definition.guidance += `\nGUIDANCE-END-${index}`
    const criterion = comparison.criteria[index]
    criterion.rationale = `RATIONALE-START-${index} ${'Documented rationale for human review. '.repeat(index === 19 ? 100 : 4)}RATIONALE-END-${index}`
    criterion.citations = Array.from({ length: 3 }, (_, quote) => reportFixtureCitation(comparison.candidate.documentId, {
      paragraphId: `resume-pass-${index}-${quote}`, sourceTitle: 'Frozen résumé.docx',
      quote: `RESUME-QUOTE-${index}-${quote} ${'Exact saved evidence. '.repeat(index === 19 && quote === 2 ? 100 : 4)}RESUME-END-${index}-${quote}`,
      pagination: 'captured-sections', page: index + 1,
    }))
    criterion.requirementCitations = Array.from({ length: 2 }, (_, quote) => reportFixtureCitation('requirement-target-0', {
      paragraphId: `requirement-pass-${index}-${quote}`, sourceTitle: 'Frozen job requirement.pdf', pagination: 'pdf-pages',
      quote: `REQUIREMENT-QUOTE-${index}-${quote}\nFinal requirement line ${index}-${quote}.`, page: 178 + index,
    }))
  })
  const pdf = await generate(input)
  assert.ok(pdf.pages.length > baseline.pages.length + 15)
  assert.ok(pdf.body.includes(comparison.summary))
  for (const definition of target.criteria) {
    assert.ok(pdf.body.includes(definition.description))
    assert.ok(pdf.body.includes(definition.guidance))
  }
  for (const criterion of comparison.criteria) {
    assert.ok(pdf.body.includes(criterion.rationale))
    for (const citation of [...criterion.citations, ...criterion.requirementCitations]) {
      assert.ok(pdf.body.includes(citation.quote), `Missing full quotation ${citation.paragraphId}`)
      assert.ok(pdf.body.includes(citation.locator), `Missing full locator ${citation.paragraphId}`)
    }
  }
  const tableStart = pdf.pages.findIndex(page => page.body.includes('Criterion summary'))
  const tableEnd = pdf.pages.findIndex(page => page.body.includes('Detailed criterion evidence'))
  assert.ok(tableEnd > tableStart, 'The twenty-criterion table should paginate')
  for (let index = tableStart + 1; index <= tableEnd; index++) {
    const page = pdf.pages[index]
    if (page.body.includes('criterion-')) {
      assert.ok(page.body.includes('Criterion / requirement'))
      assert.ok(page.body.includes('Evidence status'))
    }
  }
  assertNoClipping(pdf)
  await savePdfQaArtifact('score-pdf-long-evidence.pdf', pdf.bytes)
})

test('PDF: not-applicable exclusions, missing evidence and unscored GS qualifications retain distinct full findings', async () => {
  const input = realReportFixture({ scores: [null], criterionCount: 3, kind: 'grade' })
  const comparison = input.comparisons[0]
  const weights = [60, 40, 0]
  const statuses = ['missing', 'not-assessed', 'not-applicable']
  comparison.criteria.forEach((criterion, index) => {
    input.targets[0].criteria[index].weight = weights[index]
    Object.assign(criterion, {
      weight: weights[index], score: index === 0 ? 0 : null, evidenceStatus: statuses[index],
      citations: [], limitation: index === 1 ? criterion.limitation : null,
    })
  })
  comparison.coverage = {
    totalCriteria: 3, supported: 0, partial: 0, missing: 1, notAssessed: 1, notApplicable: 1, assessedWeight: 60, totalWeight: 100,
  }
  comparison.qualifications = [{
    qualificationId: 'qualification-one', text: 'Full saved GS qualification wording.',
    interpretation: 'Separate GS qualification interpretation.', support: 'derived', evidenceStatus: 'partial',
    rationale: 'Full saved qualification rationale with its own evidence.',
    citations: [reportFixtureCitation(comparison.candidate.documentId, { quote: 'Exact GS resume evidence.', paragraphId: 'qualification-resume' })],
    requirementCitations: [reportFixtureCitation('grade-source', { quote: 'Exact GS qualification requirement.', paragraphId: 'qualification-source', pagination: 'markdown-sections' })],
    limitation: { code: 'qualified-human-review', message: 'Qualification limitation retained.', qualificationId: 'qualification-one' },
  }]
  comparison.limitations = [{ code: 'overall-review', message: 'Full overall saved limitation.', criterionId: 'criterion-1' }]
  const pdf = await generate(input)
  for (const text of [
    'Saved score: 0 / 5 · Missing evidence', 'Not assessed', 'Not applicable (excluded)',
    'GS qualifications — separate, unscored human review', 'Score: Unscored qualification review',
    'Full saved GS qualification wording.', 'Separate GS qualification interpretation.',
    'Source support: derived', 'Full saved qualification rationale with its own evidence.',
    'Qualification limitation retained.', 'Full overall saved limitation.',
    'Exact GS resume evidence.', 'Exact GS qualification requirement.', 'Markdown section 3',
  ]) assert.ok(pdf.body.includes(text), `Missing GS/state content: ${text}`)
  assertNoClipping(pdf)
})

test('PDF: missing, corrupt and unsupported fonts fail explicitly instead of producing substitutions', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [92], criterionCount: 1 }))
  await assert.rejects(writer.generatePdfReport(report), /requires.*local.*regular and bold font bytes/i)
  await assert.rejects(writer.generatePdfReport(report, { fonts: { regular: new ArrayBuffer(4), bold: options.fonts.bold } }), /regular font could not be read/)
  for (const [character, expected] of [['🚀', /U\+1F680/], ['漢', /U\+6F22/], ['\u0000', /U\+0000/], ['\ud800', /U\+D800/]]) {
    const copy = structuredClone(report)
    copy.groups[0].comparisons[0].criteria[0].citations[0].quote = `Saved evidence with ${character}.`
    await assert.rejects(writer.generatePdfReport(copy, options), error => {
      assert.match(error.message, expected)
      assert.match(error.message, /No source text was substituted or omitted/)
      assert.match(error.message, /another report format|locally licensed PDF font/)
      return true
    })
  }
})

test('PDF: page and output-byte resource limits fail explicitly and never return a shortened report', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [92], criterionCount: 1 }))
  const pages = writer.REPORT_LIMITS.maxPages
  const bytes = writer.REPORT_LIMITS.maxOutputBytes
  try {
    writer.REPORT_LIMITS.maxPages = 1
    await assert.rejects(writer.generatePdfReport(report, options), /1-page resource limit.*Narrow the export.*no comparisons or evidence have been omitted/)
    writer.REPORT_LIMITS.maxPages = pages
    writer.REPORT_LIMITS.maxOutputBytes = 32
    await assert.rejects(writer.generatePdfReport(report, options), /output resource limit.*Narrow the export.*no comparisons or evidence have been omitted/)
  } finally {
    writer.REPORT_LIMITS.maxPages = pages
    writer.REPORT_LIMITS.maxOutputBytes = bytes
  }
})

test('PDF: all 500 complete comparisons generate without a smaller candidate cap or skipped pairs', async context => {
  const pdf = await generate(realReportFixture({ scores: Array(500).fill(80), criterionCount: 1 }))
  assert.equal(reviewSections(pdf).length, 500)
  for (let index = 0; index < 500; index++) {
    assert.equal((pdf.body.match(new RegExp(`Comparison ID: comparison-${index}(?!\\d)`, 'g')) ?? []).length, 1)
  }
  assert.ok(pdf.pages.length <= writer.REPORT_LIMITS.maxPages)
  assert.ok(pdf.bytes.byteLength <= writer.REPORT_LIMITS.maxOutputBytes)
  context.diagnostic(`${pdf.pages.length} pages; ${pdf.bytes.byteLength} bytes; generation ${pdf.generationMilliseconds} ms; inspection ${pdf.inspectionMilliseconds} ms`)
})

test('PDF: writer bundles for the browser without Node filesystem access, font fetches or a conversion service', async () => {
  const bundle = await build({
    entryPoints: [resolve('src', 'services', 'analysisReports', 'pdf.ts')],
    bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
  })
  assert.equal(bundle.outputFiles.length, 1)
  assert.ok(bundle.outputFiles[0].text.includes('generatePdfReport'))
  const source = await readFile(resolve('src', 'services', 'analysisReports', 'pdf.ts'), 'utf8')
  assert.doesNotMatch(source, /node:fs|readFile|fetch\s*\(|https?:\/\//)
})
