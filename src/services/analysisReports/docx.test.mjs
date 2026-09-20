import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { SaxesParser } from 'saxes'
import yauzl from 'yauzl'
import {
  loadReportFoundation, realReportFixture, reportFixtureCitation, REPORT_TEST_TIMESTAMP, version2ReportFixture, withReportNarratives,
} from './test-support.mjs'
import {
  fictionalPdfNavigationQaFixture, fictionalPdfQaFixture, fictionalSampleInput, readablePdfFixture, readPdf,
} from './pdf-test-support.mjs'

let foundation, writer, cleanup, options
const output = resolve(`.analysis-report-docx-tests-${randomUUID()}`)
const entry = `
  export { generateDocxReport } from './src/services/analysisReports/docx';
  export { generatePdfReport } from './src/services/analysisReports/pdf';
  export { reportReviewLinks } from './src/services/analysisReports/links';
  export { REPORT_LIMITS } from './src/domain/analysis-reports';
`

before(async () => {
  const loaded = await loadReportFoundation()
  foundation = loaded.api
  cleanup = loaded.cleanup
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: entry },
    outfile: join(output, 'docx.mjs'), bundle: true, packages: 'external',
    platform: 'node', format: 'esm', logLevel: 'silent',
  })
  writer = await import(pathToFileURL(join(output, 'docx.mjs')).href)
  const fonts = await Promise.all(['Regular', 'Bold'].map(weight =>
    readFile(resolve('src', 'assets', 'report-fonts', `NotoSans-${weight}.ttf`))))
  const buffers = fonts.map(bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  options = {
    fonts: { regular: buffers[0], bold: buffers[1] },
    links: { origin: 'https://score.example', workspaceId: 'workspace-one' },
  }
})

after(async () => {
  await Promise.all([cleanup?.(), rm(output, { recursive: true, force: true })])
})

function unzip(bytes) {
  return new Promise((resolveZip, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error)
      const entries = new Map()
      zip.on('error', reject)
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) return zip.readEntry()
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError)
          const chunks = []
          stream.on('error', reject)
          stream.on('data', chunk => chunks.push(chunk))
          stream.on('end', () => {
            const content = Buffer.concat(chunks)
            entries.set(entry.fileName, /\.(xml|rels)$/.test(entry.fileName) ? content.toString('utf8') : content)
            zip.readEntry()
          })
        })
      })
      zip.on('end', () => resolveZip(entries))
      zip.readEntry()
    })
  })
}

function parseXml(xml, filename) {
  const root = { name: '#document', attributes: {}, children: [] }, stack = [root]
  const parser = new SaxesParser({ xmlns: true })
  parser.on('opentag', tag => {
    const node = {
      name: tag.name,
      attributes: Object.fromEntries(Object.entries(tag.attributes).map(([key, value]) => [key, value.value])),
      children: [],
    }
    stack.at(-1).children.push(node)
    stack.push(node)
  })
  parser.on('text', text => stack.at(-1).children.push(text))
  parser.on('closetag', () => stack.pop())
  parser.on('error', error => { throw new Error(`Invalid XML in ${filename}: ${error.message}`) })
  parser.write(xml).close()
  assert.equal(stack.length, 1, `${filename} has unclosed elements`)
  return root
}

function all(node, name) {
  if (typeof node === 'string') return []
  return [...(node.name === name ? [node] : []), ...node.children.flatMap(child => all(child, name))]
}

function inlineText(node) {
  if (typeof node === 'string') return ''
  if (node.name === 'w:pPr' || node.name === 'w:rPr') return ''
  if (node.name === 'w:t') return node.children.join('')
  if (node.name === 'w:tab') return '\t'
  if (node.name === 'w:br') return '\n'
  return node.children.map(inlineText).join('')
}

const textContent = node => all(node, 'w:p').map(inlineText).join('\n')
const normalizeLines = value => value.replace(/\r\n|[\r\u0085\u2028\u2029]/gu, '\n')
const normalizedBody = value => value.replace(/Page\s*\d*/g, '').replace(/[\s\u2022]/gu, '')
function containsText(node, expected) {
  assert.ok(textContent(node).includes(normalizeLines(expected)), `Missing exact text: ${JSON.stringify(expected.slice(0, 160))}`)
}

function documentSections(document, parts) {
  const relationships = new Map(all(parts.get('word/_rels/document.xml.rels'), 'Relationship')
    .map(node => [node.attributes.Id, node.attributes.Target]))
  const result = []
  let children = []
  for (const node of all(document, 'w:body')[0].children) {
    children.push(node)
    const properties = all(node, 'w:sectPr')[0]
    if (!properties) continue
    const headerReference = all(properties, 'w:headerReference').find(node => node.attributes['w:type'] === 'default')
    assert.ok(headerReference, 'Every section has its own identifying continuation header')
    const header = parts.get(`word/${relationships.get(headerReference.attributes['r:id'])}`)
    assert.ok(header)
    result.push({ name: '#section', attributes: {}, children, header, properties })
    children = []
  }
  assert.equal(children.length, 0)
  return result
}
const reviewSections = word => word.sections.filter(section => textContent(section.header).includes('Candidate review'))
const glanceSections = word => word.sections.filter(section => textContent(section.header).includes('Candidates at a glance'))

async function generate(report, generationOptions = options) {
  const original = JSON.stringify(report)
  const bytes = await writer.generateDocxReport(report, generationOptions)
  assert.equal(JSON.stringify(report), original, 'Word must not mutate scores, source evidence, scope or saved narratives')
  assert.ok(bytes instanceof Uint8Array)
  assert.ok(bytes.length > 1000 && bytes.length <= writer.REPORT_LIMITS.maxOutputBytes)
  assert.equal(Buffer.from(bytes.slice(0, 2)).toString(), 'PK')
  const entries = await unzip(bytes)
  for (const filename of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) {
    assert.ok(entries.has(filename), `Missing OOXML part ${filename}`)
  }
  const parts = new Map([...entries].filter(([name]) => /\.(xml|rels)$/.test(name)).map(([name, xml]) => [name, parseXml(xml, name)]))
  const document = parts.get('word/document.xml')
  return { bytes, entries, parts, document, sections: documentSections(document, parts) }
}
const reportFor = (input = readablePdfFixture(), buildOptions = {}) => foundation.buildAnalysisReport(input, buildOptions)

test('Word retains full long v2 prose, manual labels and known issues as native flowing text and table content', async () => {
  const report = reportFor(version2ReportFixture({ long: true }))
  const word = await generate(report)
  containsText(word.document, 'Manually approved summary. Automated review: needs-correction.')
  for (const group of report.groups) {
    for (const paragraph of group.target.narrative.paragraphs) containsText(word.document, paragraph)
    containsText(word.document, `Known issue: ${group.target.narrative.approval.issues[0].message}`)
    for (const comparison of group.comparisons) {
      if (comparison.highlighted) containsText(word.document, comparison.narrative.text)
      containsText(word.document, comparison.narrative.overview)
      containsText(word.document, `Known issue: ${comparison.narrative.approval.issues[0].message}`)
    }
  }
  assert.ok(all(word.document, 'w:tbl').length > 0)
  assert.equal(all(word.document, 'w:txbxContent').length, 0, 'Accepted prose flows instead of clipping in fixed text boxes.')
  assert.equal(all(word.document, 'w:drawing').length, 0)
})

test('Word and PDF emit the same completed report content, saved summaries, section order and source destinations', async () => {
  const report = reportFor(readablePdfFixture({ scores: [90, null], targetCount: 2, criterionCount: 2 }))
  const word = await generate(report)
  const pdf = await readPdf(await writer.generatePdfReport(report, options))
  assert.equal(normalizedBody(textContent(word.document)), normalizedBody(pdf.body),
    'Only whitespace, native list markers and viewer-generated contents page numbers may differ')
  assert.equal(word.sections.length, 2 + report.groups.length * 3)
  for (const [index, group] of report.groups.entries()) {
    const [opener, review, glance] = word.sections.slice(2 + index * 3, 5 + index * 3)
    containsText(opener, group.target.presentation.title)
    containsText(opener, group.target.presentation.organization)
    for (const paragraph of group.target.narrative.paragraphs) containsText(opener, paragraph)
    containsText(review, group.comparisons[0].narrative.text)
    containsText(glance, 'Candidates at a glance')
    for (const comparison of group.comparisons) containsText(glance, comparison.narrative.overview)
  }
  const destinations = all(word.parts.get('word/_rels/document.xml.rels'), 'Relationship')
    .filter(node => node.attributes.Type.endsWith('/hyperlink'))
  assert.deepEqual(new Set(destinations.map(node => node.attributes.Target)), new Set(pdf.uriAnnotations.map(link => link.url)))
  assert.ok(destinations.every(node => node.attributes.TargetMode === 'External'))
  assert.doesNotMatch(textContent(word.document), /RAW-|Comparison ID|Run ID|SHA-256|Full saved overall assessment|\[excerpt\]/)
  for (const part of word.parts.values()) {
    for (const name of ['w:drawing', 'w:pict', 'w:documentProtection', 'w:txbxContent']) assert.equal(all(part, name).length, 0)
  }
  assert.ok(![...word.entries.keys()].some(name => /(^word\/media\/|embeddings\/)/.test(name)), 'Pages must be editable, not screenshots')
})

test('Word and PDF display labels retain canonical source identities and identical report content', async () => {
  const input = readablePdfFixture({ scores: [92.75], criterionCount: 2 })
  input.run.name = 'Renamed analysis'
  input.targets[0].displayName = 'Custom target'
  input.targets[0].label = 'LEGACY-COMPOSITE TITLE - OFFICE MUST NOT BE USED'
  input.comparisons[0].candidate.displayName = 'Custom candidate'
  const report = foundation.buildAnalysisReport(input)
  const word = await generate(report)
  const pdf = await readPdf(await writer.generatePdfReport(report, options))
  assert.equal(normalizedBody(textContent(word.document)), normalizedBody(pdf.body))
  const title = all(word.parts.get('docProps/core.xml'), 'dc:title')[0].children.join('')
  assert.equal(title, foundation.reportTitle(report))
  for (const value of ['Renamed analysis', 'Custom target', 'Custom candidate',
    `Source-stated name: ${input.comparisons[0].candidate.name}`,
    `Source target title: ${input.targets[0].presentation.title}`, input.targets[0].presentation.organization]) {
    containsText(word.document, value)
  }
  assert.doesNotMatch(textContent(word.document), /LEGACY-COMPOSITE/)
  containsText(reviewSections(word)[0], input.comparisons[0].narrative.text)
})

test('duplicate target titles keep distinct native bookmarks, linked contents and live page references', async () => {
  const input = readablePdfFixture({ scores: [90], targetCount: 3, criterionCount: 1 })
  for (const target of input.targets) {
    target.presentation.title = 'Survey Statistician'
    target.label = 'LEGACY-COMPOSITE TITLE - OFFICE MUST NOT BE USED'
  }
  const word = await generate(reportFor(input))
  const starts = all(word.document, 'w:bookmarkStart')
  assert.equal(new Set(starts.map(node => node.attributes['w:id'])).size, starts.length, 'Numeric bookmark IDs must be unique, not only their names')
  const names = starts.map(node => node.attributes['w:name'])
  assert.equal(new Set(names).size, 4)
  assert.ok(names.every(name => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)))
  const ends = all(word.document, 'w:bookmarkEnd').map(node => node.attributes['w:id'])
  assert.deepEqual(new Set(starts.map(node => node.attributes['w:id'])), new Set(ends))
  const contents = word.sections[1]
  containsText(contents, 'Contents')
  const contentsParagraphs = all(contents, 'w:p')
  const firstEntry = contentsParagraphs.findIndex(node => inlineText(node).startsWith('Job analysis 1'))
  assert.ok(firstEntry >= 0)
  for (const paragraph of contentsParagraphs.slice(firstEntry).filter(node => inlineText(node).trim())) {
    assert.ok(all(paragraph, 'w:keepLines').some(node => node.attributes['w:val'] !== 'false'),
      'Contents titles and metadata should stay together rather than splitting an ordinary entry across pages')
  }
  for (const [index, target] of input.targets.entries()) {
    containsText(contents, target.presentation.title)
    containsText(contents, target.presentation.organization)
    const opener = word.sections[2 + index * 3]
    const destination = all(opener, 'w:bookmarkStart')[0].attributes['w:name']
    const label = all(contents, 'w:hyperlink').find(node => inlineText(node) === `Job analysis ${index + 1}`)
    assert.equal(label.attributes['w:anchor'], destination)
    const title = all(contents, 'w:hyperlink').find(node => inlineText(node) === 'Survey Statistician' && node.attributes['w:anchor'] === destination)
    assert.ok(title)
    assert.ok(all(contents, 'w:instrText').some(node => node.children.join('').includes(`PAGEREF ${destination}`)))
    assert.ok(all(opener, 'w:hyperlink').some(node => inlineText(node) === 'Return to contents' && node.attributes['w:anchor'] === names[0]))
  }
  for (const link of all(word.document, 'w:hyperlink').filter(node => node.attributes['w:anchor'])) {
    assert.ok(names.includes(link.attributes['w:anchor']))
  }
  assert.doesNotMatch(textContent(word.document), /LEGACY-COMPOSITE/)
  assert.equal(all(word.parts.get('word/settings.xml'), 'w:updateFields').length, 1)
})

test('exact-target exports stay independent of active siblings and preserve exhaustive capture checks before filtering', async () => {
  const base = readablePdfFixture({ scores: [90], targetCount: 2, criterionCount: 1 })
  base.comparisons[1] = realReportFixture({ scores: [90], targetCount: 2, statuses: ['running'], criterionCount: 1 }).comparisons[1]
  base.comparisons[1].candidate = structuredClone(base.comparisons[0].candidate)
  const input = withReportNarratives(base)
  assert.throws(() => reportFor(input), /ready narrative capture|still active|settled/i)
  const targetId = input.targets[0].id
  const report = reportFor(withReportNarratives(input, { targetId }), { targetId })
  const word = await generate(report)
  assert.equal(word.sections.length, 5)
  containsText(word.document, input.targets[0].presentation.organization)
  assert.ok(!textContent(word.document).includes(input.targets[1].presentation.organization))

  const terminal = readablePdfFixture({ scores: [90], targetCount: 2, criterionCount: 1 })
  terminal.comparisons[1] = realReportFixture({ scores: [90], targetCount: 2, statuses: ['failed'], criterionCount: 1 }).comparisons[1]
  terminal.comparisons[1].candidate = structuredClone(terminal.comparisons[0].candidate)
  const settled = reportFor(withReportNarratives(terminal))
  assert.equal((await generate(settled)).sections.length, 5, 'Targets with no completed comparison are excluded from both report formats')
  const damaged = structuredClone(settled)
  damaged.capture.summaries.comparisons.pop()
  await assert.rejects(writer.generateDocxReport(damaged, options), /capture|exhaustive|comparison/i)
  for (const damage of [
    report => { delete report.capture.summaries },
    report => { report.capture.summaries.ready = false },
    report => { delete report.groups[0].comparisons[0].narrative },
    report => { delete report.groups[0].target.narrative },
    report => { report.groups[0].comparisons[0].narrative.revision = 'outdated-revision' },
  ]) {
    const stale = structuredClone(report)
    damage(stale)
    await assert.rejects(writer.generateDocxReport(stale, options), /summary|summaries|narrative|publication/i)
  }
})

test('featured reviews follow the supplied exact-target highlights, including capped ties, before every completed glance row', async () => {
  const report = reportFor(readablePdfFixture({ scores: [100, 99, 98, 97, ...Array(12).fill(80), 70], criterionCount: 1 }))
  const word = await generate(report)
  assert.equal(reviewSections(word).length, 10)
  const rows = all(all(glanceSections(word)[0], 'w:tbl')[0], 'w:tr').slice(1)
  assert.equal(rows.length, 17)
  assert.deepEqual(rows.map(row => textContent(all(row, 'w:tc')[0])), report.groups[0].comparisons.map(item => item.candidate.name))
  assert.equal(textContent(word.sections.at(-1)).includes('Candidates at a glance'), true)
  assert.doesNotMatch(textContent(word.document), /cutoff ties|competition rank/)
  const direct = reportFor(readablePdfFixture({ scores: [90, 80, 70], criterionCount: 1 }))
  direct.groups[0].highlightedComparisonIds = [direct.groups[0].comparisons[2].id]
  const selected = await generate(direct)
  assert.equal(reviewSections(selected).length, 1)
  containsText(reviewSections(selected)[0], direct.groups[0].comparisons[2].candidate.name)
})

test('zero, withheld and failed/cancelled results have the same meaning as PDF, with no invented unfinished reviews', async () => {
  const input = readablePdfFixture({
    scores: [0, null, 10, 20], statuses: ['complete', 'complete', 'failed', 'cancelled'], criterionCount: 1,
  })
  const zero = input.comparisons[0]
  Object.assign(zero.criteria[0], { score: 0, evidenceStatus: 'missing', citations: [] })
  Object.assign(zero.coverage, { supported: 0, missing: 1 })
  const report = reportFor(input), word = await generate(report)
  containsText(word.document, 'Reporting on 2 of 4 candidates')
  containsText(reviewSections(word)[0], 'Overall score: 0 / 100')
  containsText(reviewSections(word)[0], '0 / 5')
  containsText(reviewSections(word)[0], 'Missing evidence')
  assert.equal(reviewSections(word).length, 1)
  const rows = all(all(glanceSections(word)[0], 'w:tbl')[0], 'w:tr').slice(1)
  assert.equal(rows.length, 2)
  const withheld = rows.find(row => textContent(all(row, 'w:tc')[1]) === 'Withheld')
  containsText(withheld, input.comparisons[1].overall.message)
  assert.doesNotMatch(textContent(withheld), /0 \/ (5|100)/)
  for (const excluded of input.comparisons.slice(2)) assert.ok(!textContent(word.document).includes(excluded.candidate.name))
  const unscored = await generate(reportFor(readablePdfFixture({ scores: [null, null], criterionCount: 1 })))
  assert.equal(reviewSections(unscored).length, 0)
  assert.equal(all(unscored.document, 'w:tbl').length, 1)
  assert.doesNotMatch(textContent(unscored.document), /Overall score: 0/)
})

test('GS qualification notes remain separate, native bullet lists and never numeric criterion scores', async () => {
  const input = readablePdfFixture({ scores: [0], criterionCount: 3, kind: 'grade' })
  const comparison = input.comparisons[0]
  comparison.completion = 'limited'
  comparison.criteria.forEach((criterion, index) => {
    input.targets[0].criteria[index].weight = index ? 0 : 100
    Object.assign(criterion, {
      weight: index ? 0 : 100, score: index ? null : 0, citations: [],
      evidenceStatus: ['missing', 'not-assessed', 'not-applicable'][index],
      limitation: index === 1 ? { code: 'source-incomplete', criterionId: criterion.criterionId, message: 'The submitted source omits the quantitative project details.' } : null,
    })
  })
  comparison.coverage = { totalCriteria: 3, supported: 0, partial: 0, missing: 1, notAssessed: 1, notApplicable: 1, assessedWeight: 100, totalWeight: 100 }
  comparison.qualifications = [{
    qualificationId: 'qualification-one', text: 'One year of specialized experience at the next lower grade.',
    interpretation: 'Review the duration and level separately from criterion scores.', support: 'gap', evidenceStatus: 'missing',
    rationale: 'The resume does not establish a full year of specialized experience at the next lower grade.',
    citations: [], requirementCitations: [reportFixtureCitation('grade-source', { quote: 'RAW-QUALIFICATION-QUOTE', pagination: 'markdown-sections' })],
    limitation: { code: 'duration-unverified', message: 'Employment dates do not confirm the required duration.', qualificationId: 'qualification-one' },
  }]
  const word = await generate(reportFor(input)), section = reviewSections(word)[0]
  for (const value of ['0 / 5', 'Not assessed', 'N/A', 'GS qualification notes (unscored)', 'View grade requirements']) containsText(section, value)
  const qualificationText = textContent(section).split('GS qualification notes (unscored)')[1]
  assert.match(qualificationText, /specialized experience|Employment dates/)
  assert.doesNotMatch(qualificationText, /\b\d+ \/ (5|100)\b|RAW-QUALIFICATION-QUOTE/)
  assert.ok(all(section, 'w:numPr').length > 0)
  assert.ok(all(word.parts.get('word/numbering.xml'), 'w:numFmt').some(node => node.attributes['w:val'] === 'bullet'))
  assert.ok(!all(section, 'w:t').some(node => node.children.join('').startsWith('\u2022 ')))
})

test('Unicode, XML escaping, tabs and multiline saved prose remain intact and editable', async () => {
  const input = readablePdfFixture({ criterionCount: 1 })
  input.comparisons[0].candidate.name = 'Zoë <Sánchez> & "李" — Кириллица 😀'
  input.targets[0].presentation.description = '  Exact <C++> & "SQL" résumé 😀\r\n\n\tSecond line: naïve Ω 李.\nTrailing spaces stay.  '
  input.comparisons[0].narrative.text = 'Résumé & scope "quoted" is documented. A second saved statement explains the work. The final statement describes the remaining evidence gap.'
  const report = reportFor(withReportNarratives(input))
  const word = await generate(report)
  containsText(word.document, input.comparisons[0].candidate.name)
  containsText(word.document, input.targets[0].presentation.description)
  containsText(word.document, input.comparisons[0].narrative.text)
  assert.match(word.entries.get('word/document.xml'), /&lt;C\+\+&gt; &amp;/)
  assert.ok(all(word.document, 'w:tab').length > 0)
  assert.ok(all(word.document, 'w:t').some(node => node.attributes['xml:space'] === 'preserve' && node.children.join('').startsWith('  Exact')))
})

test('long identities, descriptions, overview paragraphs and every criterion flow without fixed-height or clipped text', async () => {
  const input = readablePdfFixture({ scores: [92.7525], criterionCount: 100 })
  input.targets[0].presentation.title = `Survey Statistician ${'Regional data analysis '.repeat(15)}FULL TITLE END`
  input.targets[0].presentation.organization = `Office of ${'Technical assurance '.repeat(20)}FULL OFFICE END`
  input.targets[0].presentation.description = `${'Saved role context.\n'.repeat(150)}FULL DESCRIPTION END`
  input.targets[0].criteria[0].label = `${'Complete criterion wording '.repeat(140)}FULL CRITERION END`
  input.comparisons[0].candidate.name = `Full Candidate ${'W'.repeat(150)}\nFULL NAME END`
  const word = await generate(reportFor(input))
  for (const value of Object.values(input.targets[0].presentation)) if (value) containsText(word.document, value)
  const section = reviewSections(word)[0]
  containsText(section, input.comparisons[0].candidate.name.replace(/\s+/g, ' '))
  containsText(section.header, 'Candidate 1')
  assert.doesNotMatch(textContent(section.header), /FULL NAME END|\u2026|\[excerpt\]/)
  const rows = all(all(section, 'w:tbl')[0], 'w:tr')
  assert.equal(rows.length, 101)
  input.targets[0].criteria.forEach((criterion, index) => containsText(section, `C${index + 1} ${criterion.label}`))
  for (const name of ['w:trHeight', 'w:txbxContent']) assert.equal(all(word.document, name).length, 0)
  for (const row of rows.slice(1)) assert.ok(all(row, 'w:cantSplit').every(node => node.attributes['w:val'] === 'false'), 'Oversized rows must be able to continue on another page')
})

test('fractional weights use the shared display labels without changing saved values', async () => {
  const report = reportFor(readablePdfFixture({ scores: [92.7525], criterionCount: 3 }))
  const word = await generate(report), review = reviewSections(word)[0]
  const rows = all(all(review, 'w:tbl')[0], 'w:tr').slice(1)
  assert.deepEqual(rows.map(row => textContent(all(row, 'w:tc')[1])), Array(3).fill('~33.33%'))
  containsText(review, '~ marks a weight rounded for display.')
  containsText(review, '92.7525 / 100')
  assert.doesNotMatch(textContent(word.document), /33\.333333333333336%/)
})

test('Word uses PDF-equivalent US Letter geometry, palette, outline headings, repeating headers and dual DXA table widths', async () => {
  const word = await generate(reportFor(readablePdfFixture({ scores: [90], criterionCount: 2 })))
  for (const section of word.sections) {
    const size = all(section.properties, 'w:pgSz')[0].attributes
    assert.equal(size['w:w'], '12240')
    assert.equal(size['w:h'], '15840')
    const margin = all(section.properties, 'w:pgMar')[0].attributes
    for (const [side, value] of Object.entries({ top: 2140, bottom: 1320, left: 920, right: 920 })) assert.equal(Number(margin[`w:${side}`]), value)
    containsText(section.header, 'Score')
    assert.equal(all(section.header, 'w:p').length, 3)
    const stops = all(section.header, 'w:tab').filter(node => node.attributes['w:val'])
    assert.ok(stops.every(node => node.attributes['w:pos'] === (node.attributes['w:val'] === 'left' ? '0' : '10400')),
      'Header tab stops are relative to the text margin even when shading extends to the page edges')
  }
  for (const section of word.sections.slice(1)) assert.equal(all(section.properties, 'w:type')[0].attributes['w:val'], 'nextPage')
  assert.ok(all(word.document, 'w:pgNumType').every(node => node.attributes['w:start'] === undefined))
  assert.equal(all(word.document, 'w:pageBreakBefore').length, 0, 'Do not double section starts with paragraph page breaks')
  for (const table of all(word.document, 'w:tbl')) {
    assert.deepEqual(all(table, 'w:tblW')[0].attributes, { 'w:w': '10400', 'w:type': 'dxa' })
    assert.equal(all(table, 'w:tblLayout')[0].attributes['w:type'], 'fixed')
    const columns = all(table, 'w:gridCol').map(node => Number(node.attributes['w:w']))
    assert.equal(columns.reduce((sum, value) => sum + value, 0), 10400)
    const rows = all(table, 'w:tr')
    assert.equal(all(rows[0], 'w:tblHeader').length, 1)
    assert.equal(all(table, 'w:tblHeader').length, 1)
    for (const row of rows) for (const [index, cell] of all(row, 'w:tc').entries()) {
      assert.equal(Number(all(cell, 'w:tcW')[0].attributes['w:w']), columns[index])
      assert.equal(all(cell, 'w:tcW')[0].attributes['w:type'], 'dxa')
      assert.ok(all(cell, 'w:tcMar').length > 0)
    }
  }
  const styleNodes = all(word.parts.get('word/styles.xml'), 'w:style')
  assert.equal(new Set(styleNodes.map(node => node.attributes['w:styleId'])).size, styleNodes.length)
  for (const level of [1, 2, 3]) {
    const style = styleNodes.find(node => node.attributes['w:styleId'] === `Heading${level}`)
    assert.equal(all(style, 'w:outlineLvl')[0].attributes['w:val'], String(level - 1))
  }
  for (const fontSize of all(word.document, 'w:sz')) assert.ok(Number(fontSize.attributes['w:val']) >= 19)
  assert.ok(all(word.document, 'w:color').some(node => node.attributes['w:val'] === 'B11F4B'))
  assert.ok(all(word.document, 'w:shd').every(node => node.attributes['w:val'] === 'clear'))
  for (const border of all(word.document, 'w:pBdr')) {
    const order = ['w:top', 'w:left', 'w:bottom', 'w:right', 'w:between', 'w:bar']
    const children = border.children.filter(node => typeof node !== 'string').map(node => order.indexOf(node.name))
    assert.ok(children.every((value, index) => value >= 0 && (!index || children[index - 1] < value)),
      'Paragraph borders must follow the OOXML schema order')
  }
  const footer = [...word.parts].find(([name]) => /^word\/footer\d+\.xml$/.test(name))[1]
  const fields = all(footer, 'w:instrText').flatMap(node => node.children).join(' ')
  assert.match(fields, /\bPAGE\b/)
  assert.match(fields, /\bNUMPAGES\b/)
  assert.equal(all(word.document, 'w:footerReference').length, 1, 'Other sections inherit continuous pagination')
})

test('both full local Noto Sans faces are embedded with valid relationships and lossless font bytes', async () => {
  const word = await generate(reportFor(readablePdfFixture({ criterionCount: 1 })))
  const fontTable = word.parts.get('word/fontTable.xml')
  const family = all(fontTable, 'w:font').find(node => node.attributes['w:name'] === 'Noto Sans')
  assert.ok(family)
  const relationships = new Map(all(word.parts.get('word/_rels/fontTable.xml.rels'), 'Relationship').map(node => [node.attributes.Id, node.attributes]))
  for (const [weight, element] of [['regular', 'w:embedRegular'], ['bold', 'w:embedBold']]) {
    const embedded = all(family, element)[0].attributes
    assert.match(embedded['w:fontKey'], /^\{[A-F0-9-]{36}\}$/)
    const relationship = relationships.get(embedded['r:id'])
    assert.ok(relationship.Type.endsWith('/font'))
    assert.equal(relationship.TargetMode, undefined)
    const data = Buffer.from(word.entries.get(`word/${relationship.Target}`))
    const key = Buffer.from(embedded['w:fontKey'].replace(/[{}-]/g, ''), 'hex').reverse()
    for (let index = 0; index < 32; index++) data[index] ^= key[index % 16]
    assert.deepEqual(data, Buffer.from(options.fonts[weight]), 'Embedded fonts must survive browser-safe OOXML obfuscation exactly')
  }
  assert.ok(all(word.parts.get('word/styles.xml'), 'w:rFonts').some(node => node.attributes['w:ascii'] === 'Noto Sans'))
})

test('every one of 500 completed candidates remains in the editable glance table, without 500 featured reviews', async () => {
  const report = reportFor(readablePdfFixture({ scores: Array.from({ length: 500 }, (_, index) => index % 101), criterionCount: 1 }))
  const word = await generate(report)
  containsText(word.document, 'Distinct reviewed candidates: 500')
  containsText(word.document, 'Completed candidate-job reviews: 500')
  assert.equal(reviewSections(word).length, report.groups[0].highlightedComparisonIds.length)
  const rows = all(all(glanceSections(word)[0], 'w:tbl')[0], 'w:tr').slice(1)
  assert.equal(rows.length, 500)
  assert.deepEqual(rows.map(row => all(row, 'w:tc').slice(0, 2).map(textContent)), report.groups[0].comparisons.map(comparison => [
    comparison.candidate.name, foundation.overallScoreLabel(comparison.overall),
  ]))
})

test('fictional sample identity remains explicit without real model provenance or network calls', async () => {
  const report = foundation.buildSampleAnalysisReport(foundation.createInitialWorkspace().runs[0], { generatedAt: REPORT_TEST_TIMESTAMP })
  const word = await generate(report, { fonts: options.fonts, links: { origin: options.links.origin } })
  containsText(word.document, foundation.REPORT_SAMPLE_NOTICE)
  containsText(word.document, foundation.REPORT_HUMAN_REVIEW_NOTICE)
  for (const section of word.sections) containsText(section.header, 'FICTIONAL SAMPLE')
})

test('XML-invalid controls, including deliberately omitted evidence, fail visibly rather than corrupting the package', async () => {
  for (const invalid of ['\0', '\u0001', '\u000B', '\u000C', '\u001F', '\uFFFE', '\uFFFF', '\uD800', '\uDC00']) {
    const report = reportFor()
    report.groups[0].comparisons[0].criteria[0].citations[0].quote += invalid
    await assert.rejects(writer.generateDocxReport(report, options), /XML-invalid character \(U\+[0-9A-F]+\).*cannot be generated safely/)
  }
})

test('missing/corrupt fonts and unsafe or mismatched link contexts fail explicitly', async () => {
  const report = reportFor()
  await assert.rejects(writer.generateDocxReport(report, { links: options.links }), /locally bundled.*regular and bold/)
  for (const bytes of [new ArrayBuffer(4), Uint8Array.of(0, 1, 0, 0).buffer, new ArrayBuffer(4 * 1024 * 1024 + 1)]) {
    await assert.rejects(writer.generateDocxReport(report, { ...options, fonts: { ...options.fonts, regular: bytes } }), /local Word regular font/)
  }
  for (const links of [
    undefined, { origin: 'file:///private/report.docx' }, { ...options.links, origin: 'https://score.example/private' },
    { ...options.links, workspaceId: 'another-workspace' },
  ]) await assert.rejects(writer.generateDocxReport(report, { ...options, links }), /origin|workspace|HTTP|link/i)
})

test('input, output, section and generation limits abort visibly without returning a partial document', async () => {
  for (const [key, value, pattern] of [
    ['maxOutputBytes', 100, /Word report exceeds the output size limit/],
    ['maxPages', 1, /Word report exceeds the section\/page resource limit/],
    ['maxGenerationMilliseconds', -1, /Word generation exceeded the report time limit/],
  ]) {
    const report = reportFor(), original = writer.REPORT_LIMITS[key]
    try {
      writer.REPORT_LIMITS[key] = value
      await assert.rejects(writer.generateDocxReport(report, options), pattern)
    } finally { writer.REPORT_LIMITS[key] = original }
  }
  const invalid = reportFor()
  invalid.groups[0].target.presentation.description = 'x'.repeat(writer.REPORT_LIMITS.maxTextCharacters + 1)
  await assert.rejects(writer.generateDocxReport(invalid, options), /presentation metadata is invalid/)
  await assert.rejects(writer.generateDocxReport(foundation.buildAnalysisReport(realReportFixture()), options), /ready narrative capture/)
})

test('browser bundle emits genuine editable OOXML and embedded fonts without Node globals or network access', async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: "export { generateDocxReport } from './src/services/analysisReports/docx';" },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'DocxReport',
    metafile: true, logLevel: 'silent',
  })
  for (const output of Object.values(bundle.metafile.outputs)) assert.ok(!output.imports.some(item => item.external))
  const sandbox = { Blob, TextEncoder, TextDecoder, URL, URLSearchParams, setTimeout, clearTimeout, console }
  runInNewContext(`${bundle.outputFiles[0].text}\nglobalThis.reportWriter = DocxReport`, sandbox)
  assert.equal(sandbox.Buffer, undefined)
  assert.equal(sandbox.process, undefined)
  const bytes = await sandbox.reportWriter.generateDocxReport(reportFor(), options)
  const entries = await unzip(bytes)
  for (const [name, xml] of entries) if (/\.(xml|rels)$/.test(name)) parseXml(xml, name)
  containsText(parseXml(entries.get('word/document.xml'), 'word/document.xml'), 'Alex Morgan')
  assert.ok(entries.has('word/fonts/font1.odttf'))
  assert.ok(entries.has('word/fonts/font2.odttf'))
})

test('matching fictional Word and PDF fixtures support native local layout review', async () => {
  const aliases = fictionalPdfQaFixture()
  aliases.run.name = 'Fictional research shortlisting review'
  aliases.targets[0].displayName = 'Survey methods vacancy'
  aliases.comparisons[0].candidate.displayName = 'Research applicant A'
  const longAliases = fictionalPdfQaFixture()
  longAliases.run.name = `${'Fictional research analysis '.repeat(7).slice(0, 159)}Z`
  longAliases.targets[0].displayName = `${'Captured survey research vacancy '.repeat(6).slice(0, 159)}Z`
  longAliases.comparisons[0].candidate.displayName = `${'Captured research applicant '.repeat(7).slice(0, 159)}Z`
  longAliases.comparisons[0].candidate.name = null
  const fixtures = [
    ['ordinary', fictionalPdfQaFixture()], ['long', fictionalPdfQaFixture('long')], ['large', fictionalPdfQaFixture('large')],
    ['multi', fictionalPdfNavigationQaFixture()], ['long-metadata', fictionalPdfNavigationQaFixture('long-metadata')],
    ['aliases', aliases], ['long-aliases', longAliases],
  ]
  for (const [name, input] of fixtures) {
    const report = reportFor(fictionalSampleInput(input))
    const generationOptions = { fonts: options.fonts, links: { origin: options.links.origin } }
    const word = await generate(report, generationOptions)
    containsText(word.document, foundation.REPORT_SAMPLE_NOTICE)
    assert.equal(reviewSections(word).length, report.groups.reduce((sum, group) => sum + group.highlightedComparisonIds.length, 0))
    if (input.targets[0].displayName !== undefined) {
      for (const text of [input.run.name, input.targets[0].displayName, input.comparisons[0].candidate.displayName,
        `Source-stated name: ${input.comparisons[0].candidate.name ?? 'Not stated'}`,
        `Source target title: ${input.targets[0].presentation.title}`]) containsText(word.document, text)
      const pdf = await readPdf(await writer.generatePdfReport(report, generationOptions))
      const content = text => normalizedBody(text).replaceAll('CriterionWeightScore', '').replaceAll('NameScoreAssessmenthighlights', '')
      assert.equal(content(textContent(word.document)), content(pdf.body),
        'PDF repeats table headers at physical page breaks; Word stores one native repeating header row.')
    }
    if (process.env.REPORT_DOCX_QA_DIRECTORY) {
      await mkdir(process.env.REPORT_DOCX_QA_DIRECTORY, { recursive: true })
      await writeFile(join(process.env.REPORT_DOCX_QA_DIRECTORY, `score-word-${name}.docx`), word.bytes)
      await writeFile(join(process.env.REPORT_DOCX_QA_DIRECTORY, `score-pdf-${name}.pdf`), await writer.generatePdfReport(report, generationOptions))
    }
  }
})
