import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SaxesParser } from 'saxes'
import { loadReportFoundation, realReportFixture, version2ReportFixture, withReportNarratives } from './test-support.mjs'
import { assertNoClipping, fictionalSampleInput, readPdf } from './pdf-test-support.mjs'
import { inspectSlideXml, unzipPptx } from './pptx.test-support.mjs'
import fontkit from '@pdf-lib/fontkit'

const output = resolve(`.report-policy-tests-${randomUUID()}`)
let foundation, api, writers, options, measurementFonts
before(async () => {
  foundation = await loadReportFoundation()
  api = foundation.api
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      export { generateCsvReport } from './src/services/analysisReports/csv';
      export { generatePdfReport } from './src/services/analysisReports/pdf';
      export { generateDocxReport } from './src/services/analysisReports/docx';
      export { generatePptxReport } from './src/services/analysisReports/pptx';
    ` }, outfile: join(output, 'writers.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
  })
  const module = await import(pathToFileURL(join(output, 'writers.mjs')).href)
  writers = Object.fromEntries(['csv', 'pdf', 'docx', 'pptx'].map(format =>
    [format, module[`generate${{ csv: 'Csv', pdf: 'Pdf', docx: 'Docx', pptx: 'Pptx' }[format]}Report`]]))
  const fonts = await Promise.all(['Regular', 'Bold'].map(weight => readFile(resolve('src', 'assets', 'report-fonts', `NotoSans-${weight}.ttf`))))
  measurementFonts = { regular: fontkit.create(fonts[0]), bold: fontkit.create(fonts[1]) }
  options = { links: { origin: 'https://score.example', workspaceId: 'workspace-one' }, fonts: {
    regular: fonts[0].buffer.slice(fonts[0].byteOffset, fonts[0].byteOffset + fonts[0].byteLength),
    bold: fonts[1].buffer.slice(fonts[1].byteOffset, fonts[1].byteOffset + fonts[1].byteLength),
  } }
})
after(async () => { await foundation?.cleanup(); await rm(output, { recursive: true, force: true }) })

function settings(patch = {}, revision = 'report-policy-one') {
  return { revision, policy: { ...api.createDefaultAdminSettings().reports, ...patch } }
}
function report(patch = {}, input = version2ReportFixture()) {
  input.capture.settings = settings(patch)
  return api.buildAnalysisReport(input)
}
function changePolicy(value, patch) {
  const copy = structuredClone(value)
  copy.capture.settings = api.captureReportSettings({
    revision: value.capture.settings.revision, policy: { ...value.capture.settings.policy, ...patch },
  })
  return copy
}
function wordText(bytes) {
  return unzipPptx(bytes).then(entries => {
    const parser = new SaxesParser()
    let text = '', inside = false
    parser.on('opentag', tag => { if (tag.name === 'w:t') inside = true })
    parser.on('text', value => { if (inside) text += value })
    parser.on('closetag', tag => { if (tag.name === 'w:t') inside = false; if (tag.name === 'w:p') text += '\n' })
    parser.write(entries.get('word/document.xml').toString('utf8')).close()
    return text
  })
}
async function deck(bytes) {
  const entries = await unzipPptx(bytes)
  return [...entries].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([, value]) => inspectSlideXml(value.toString('utf8')))
}
const compact = value => value.replace(/\s+/gu, '')

test('the legacy snapshot captures exactly the approved report defaults, not current analysis admission', () => {
  const defaults = api.createDefaultAdminSettings()
  const value = api.buildAnalysisReport(realReportFixture())
  assert.deepEqual(value.capture.settings, { revision: 'legacy-v1', policy: defaults.reports })
  assert.deepEqual(value.capture.settings.policy.enabledFormats, ['csv', 'pdf', 'docx', 'pptx'])
  assert.equal(value.capture.settings.policy.defaultFormat, 'pdf')
  defaults.analyses.maxComparisons = 1
  defaults.reports.maxComparisons = 1
  assert.equal(value.capture.settings.policy.maxComparisons, 500)
  assert.equal(api.buildAnalysisReport(realReportFixture({ scores: Array(500).fill(90) })).counts.total, 500)
  assert.equal(api.reportTitle(value), 'Analysis evidence report — Saved evidence review')
})

test('nondefault emphasis expands and caps ties independently within every exact target', () => {
  const input = realReportFixture({ scores: [99, 95, 95, 95, 80, null], targetCount: 2 })
  const captured = settings({ highlightCount: 2, maxHighlights: 3 })
  input.capture.settings = captured
  const value = api.buildAnalysisReport(input)
  for (const group of value.groups) {
    assert.equal(group.comparisons.length, 6)
    assert.equal(group.highlightedComparisonIds.length, 3)
    assert.equal(group.cutoffScore, 95)
    assert.equal(group.additionalCutoffTies, 1)
    assert.deepEqual(group.comparisons.map(item => item.rank), [1, 2, 2, 2, 5, null])
    assert.ok(group.highlightedComparisonIds.every(id => group.comparisons.some(item => item.id === id && item.targetId === group.target.id)))
    assert.match(api.highlightNotice(group), /capped at 3; 1 additional candidates tied at 95/)
  }
  captured.policy.highlightCount = 1
  captured.policy.maxHighlights = 1
  assert.equal(value.capture.settings.policy.highlightCount, 2)
  assert.ok(Object.isFrozen(value.capture.settings.policy))
  assert.ok(Object.isFrozen(value.capture.settings.policy.enabledFormats))
  assert.ok(Object.isFrozen(value.capture.settings.policy.allowedRoles))
})

test('captured settings reject invalid defaults, empty-format mistakes, invalid roles and incoherent limits', () => {
  for (const patch of [
    { enabledFormats: [], defaultFormat: 'pdf' }, { defaultFormat: null }, { enabledFormats: ['csv'], defaultFormat: 'pdf' },
    { enabledFormats: ['csv', 'csv'], defaultFormat: 'csv' }, { allowedRoles: ['admin'] },
    { highlightCount: 4, maxHighlights: 3 }, { highlightCount: 0 }, { maxHighlights: 11 },
    { maxComparisons: 2, batchComparisons: 3 }, { maxInputBytes: 0 }, { maxOutputBytes: Infinity },
    { maxConcurrentBatches: 4 }, { maxGenerationMilliseconds: 999 }, { maxPages: 0 }, { maxSlides: 10_001 },
  ]) assert.throws(() => api.captureReportSettings(settings(patch)))
  const disabled = api.captureReportSettings(settings({ enabledFormats: [], defaultFormat: null }))
  assert.equal(disabled.policy.defaultFormat, null)
  for (const format of ['csv', 'pdf', 'docx', 'pptx']) assert.throws(() => api.assertReportFormat(disabled.policy, format), /disabled/)
})

test('report comparison admission is exact-scope only and never applies lower new-analysis limits to history', () => {
  const input = realReportFixture({ scores: [90, 80, 70], targetCount: 2 })
  input.capture.settings = settings({ maxComparisons: 3, batchComparisons: 3 })
  assert.throws(() => api.buildAnalysisReport(input), /3-comparison report limit.*Narrow/)
  assert.equal(api.buildAnalysisReport(input, { targetId: input.targets[0].id }).counts.total, 3)
  input.capture.settings.policy.maxComparisons = 2
  input.capture.settings.policy.batchComparisons = 2
  assert.throws(() => api.buildAnalysisReport(input, { targetId: input.targets[0].id }), /2-comparison report limit/)
})

test('all writers apply the captured title and full additive notice while retaining required evidence and disclosures', async () => {
  const footer = 'Authorized reviewers only. ' + 'Retain the full source and known limitations. '.repeat(35) + 'END OF ORGANIZATION NOTICE'
  const value = report({ title: 'Agency evidence review', additionalFooter: footer, highlightCount: 1, maxHighlights: 1 })
  const saved = JSON.stringify(value)
  const csv = Buffer.from(await writers.csv(value, options)).toString('utf8')
  assert.match(csv, /"Report title","Report disclosures"/)
  assert.ok(csv.includes('Agency evidence review — Saved evidence review'))
  assert.ok(csv.includes(footer))
  assert.ok(csv.includes(api.REPORT_HUMAN_REVIEW_NOTICE))
  assert.doesNotMatch(csv, /Manually approved|Known issue/, 'CSV remains independent of saved narrative publication.')
  const pdf = await readPdf(await writers.pdf(value, options))
  assertNoClipping(pdf, measurementFonts)
  const docx = await wordText(await writers.docx(value, options))
  const slides = await deck(await writers.pptx(value, options))
  const slideText = slides.map(slide => slide.text).join('\n')
  const slideFooter = slides.flatMap(slide => slide.shapes.filter(shape => shape.name.startsWith('additional-footer-')))
    .map(shape => shape.text).join('')
  for (const [format, text, footerText] of [['pdf', pdf.body, pdf.body], ['docx', docx, docx], ['pptx', slideText, slideFooter]]) {
    assert.ok(text.includes('Agency evidence review'))
    assert.ok(compact(footerText).includes(compact(footer)), `${format}: the complete footer survives page/slide continuation.`)
    assert.match(text, /Manually approved summary/)
    assert.match(text, /Known issue:/)
    assert.match(text, /[Hh]uman review|qualified reviewer/)
    for (const group of value.groups) {
      assert.ok(compact(text).includes(compact(group.target.narrative.paragraphs[0])))
      for (const item of group.comparisons) assert.ok(compact(text).includes(compact(item.narrative.overview)))
    }
  }
  assert.equal(JSON.stringify(value), saved)
  const sample = report({ title: 'Agency sample report', additionalFooter: footer }, fictionalSampleInput(withReportNarratives(realReportFixture())))
  const sampleOptions = { ...options, links: { origin: options.links.origin } }
  assert.match(Buffer.from(await writers.csv(sample, sampleOptions)).toString(), /fictional sample/i)
  assert.ok((await readPdf(await writers.pdf(sample, sampleOptions))).body.includes(api.REPORT_SAMPLE_NOTICE))
  assert.ok((await wordText(await writers.docx(sample, sampleOptions))).includes(api.REPORT_SAMPLE_NOTICE))
  assert.ok((await deck(await writers.pptx(sample, sampleOptions))).every(slide => slide.text.includes('FICTIONAL SAMPLE')))
})

test('a long configured title uses full flowing document text and separate deck title pages without shrinking or clipping', async () => {
  const title = 'An agency-specific evidence review title with complete scope and required context. '.repeat(2).trim()
  const value = report({ title })
  const pdf = await readPdf(await writers.pdf(value, options))
  assertNoClipping(pdf, measurementFonts)
  assert.ok(compact(pdf.body).includes(compact(title)))
  assert.ok(compact(await wordText(await writers.docx(value, options))).includes(compact(title)))
  const slides = await deck(await writers.pptx(value, options))
  assert.ok(compact(slides.map(slide => slide.text).join('\n')).includes(compact(title)))
})

test('disabled formats and empty role policies fail before every writer without removing readable reports', async () => {
  const value = report()
  for (const [format, writer] of Object.entries(writers)) {
    const disabled = changePolicy(value, { enabledFormats: [], defaultFormat: null })
    await assert.rejects(async () => writer(disabled, options), /disabled/)
    await assert.rejects(async () => writer(changePolicy(value, { allowedRoles: [] }), options), /every workspace role/)
    assert.equal(value.counts.complete, 2)
    assert.ok(value.groups[0].comparisons[0].summary)
    const csvOnly = changePolicy(value, { enabledFormats: ['csv'], defaultFormat: 'csv' })
    if (format === 'csv') assert.ok((await writer(csvOnly, options)).byteLength > 0)
    else await assert.rejects(async () => writer(csvOnly, options), /disabled/)
  }
})

test('every writer enforces the captured full-input and output bytes and wall-clock budgets', async () => {
  const value = report()
  const inputBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  for (const [format, writer] of Object.entries(writers)) {
    await assert.rejects(async () => writer(changePolicy(value, { maxInputBytes: inputBytes - 50 }), options), /resource limit/)
    await assert.rejects(async () => writer(changePolicy(value, { maxOutputBytes: 16 }), options), /size limit|output.*limit/)
    await assert.rejects(async () => writer(changePolicy(value, { maxComparisons: 1, batchComparisons: 1 }), options), /comparison report limit/)
    const clock = Date.now
    let time = 0
    try {
      Date.now = () => { time += 1001; return time }
      await assert.rejects(async () => writer(changePolicy(value, { maxGenerationMilliseconds: 1000 }), options), /time limit/, format)
    } finally { Date.now = clock }
  }
})

test('CSV output bytes and PDF/deck pages accept the exact limit and reject the next item without truncation', async () => {
  const value = report()
  const csv = writers.csv(value, options)
  assert.equal(writers.csv(changePolicy(value, { maxOutputBytes: csv.byteLength }), options).byteLength, csv.byteLength)
  assert.throws(() => writers.csv(changePolicy(value, { maxOutputBytes: csv.byteLength - 1 }), options), /download size limit/)
  const pdf = await readPdf(await writers.pdf(value, options))
  assert.equal((await readPdf(await writers.pdf(changePolicy(value, { maxPages: pdf.pages.length }), options))).pages.length, pdf.pages.length)
  await assert.rejects(writers.pdf(changePolicy(value, { maxPages: pdf.pages.length - 1 }), options), /page resource limit/)
  const slides = await deck(await writers.pptx(value, options))
  assert.equal((await deck(await writers.pptx(changePolicy(value, { maxSlides: slides.length }), options))).length, slides.length)
  await assert.rejects(writers.pptx(changePolicy(value, { maxSlides: slides.length - 1 }), options), /slide\/page limit/)
  await assert.rejects(writers.docx(changePolicy(value, { maxPages: 1 }), options), /section\/page resource limit/)
  assert.equal((await deck(await writers.pptx(changePolicy(value, { maxPages: 1 }), options))).length, slides.length,
    'The runtime document-page limit does not silently become the deck slide limit.')
  const longWord = report({ maxPages: 5, highlightCount: 1, maxHighlights: 1 }, version2ReportFixture({ long: true }))
  await assert.rejects(writers.docx(longWord, options), /section\/page resource limit/,
    'Five section openers are not enough to account for long, flowing Word paragraphs and table cells.')
})

test('asynchronous writers keep the captured policy even when their caller replaces settings during generation', async () => {
  for (const format of ['pdf', 'docx', 'pptx']) {
    const value = report({ title: 'The captured report title', additionalFooter: 'The captured organization notice.' })
    const pending = writers[format](value, options)
    value.capture.settings = settings({ title: 'A later report title', additionalFooter: 'A later organization notice.' }, 'later-policy')
    const bytes = await pending
    const text = format === 'pdf' ? (await readPdf(bytes)).body : format === 'docx' ? await wordText(bytes)
      : (await deck(bytes)).map(slide => slide.text).join('\n')
    assert.ok(text.includes('The captured report title'), format)
    assert.ok(text.includes('The captured organization notice.'), format)
    assert.doesNotMatch(text, /A later report title|A later organization notice/)
  }
})
