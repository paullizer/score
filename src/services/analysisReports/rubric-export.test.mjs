import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import fontkit from '@pdf-lib/fontkit'
import { build } from 'esbuild'
import JSZip from 'jszip'
import { SaxesParser } from 'saxes'
import { assertNoClipping, readablePdfFixture, readPdf } from './pdf-test-support.mjs'
import { inspectPptx } from './pptx.test-support.mjs'
import { realReportFixture, reportFixtureCitation, withReportNarratives } from './test-support.mjs'

const output = resolve(`.rubric-export-tests-${randomUUID()}`)
const LINKS = { origin: 'https://score.example' }
const RUBRIC_URL = 'https://score.example/workspaces/workspace-one/rubrics/rubric-1?job=job-1'
const NOTICE = 'Share only with the hiring panel.'
let api, fonts, measurementFonts, options

before(async () => {
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      export * from './src/services/analysisReports/rubric-model';
      export * from './src/services/analysisReports/rubric-export';
      export * from './src/services/analysisReports/rubric-markdown';
      export * from './src/services/analysisReports/rubric-csv';
      export { generateRubricPdf } from './src/services/analysisReports/rubric-pdf';
      export { generateRubricDocx } from './src/services/analysisReports/rubric-docx';
      export { generateRubricPptx } from './src/services/analysisReports/rubric-pptx';
      export { generateCsvBundle } from './src/services/analysisReports/csv-bundle';
      export { generateCsvReport } from './src/services/analysisReports/csv';
      export { generatePdfReport } from './src/services/analysisReports/pdf';
      export { generateDocxReport } from './src/services/analysisReports/docx';
      export { generatePptxReport } from './src/services/analysisReports/pptx';
      export { reportReviewLinks } from './src/services/analysisReports/links';
      export { buildAnalysisReport } from './src/services/analysisReports/model';
      export { readableAnalysisDate, readableTargetSourceLabel } from './src/services/analysisReports/readable';
      export { createDefaultAdminSettings } from './src/domain/admin-settings-defaults';
      export { REPORT_CSV_BUNDLE_FILES } from './src/domain/analysis-reports';
      export { SCORE_LEGEND } from './src/domain/rubric-exports';
    ` },
    outfile: join(output, 'rubric-export.mjs'), bundle: true, packages: 'external',
    platform: 'node', format: 'esm', logLevel: 'silent',
  })
  api = await import(pathToFileURL(join(output, 'rubric-export.mjs')).href)
  const [regular, bold] = await Promise.all(['Regular', 'Bold'].map(weight =>
    readFile(resolve('src', 'assets', 'report-fonts', `NotoSans-${weight}.ttf`))))
  const buffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  fonts = { regular: buffer(regular), bold: buffer(bold) }
  measurementFonts = { regular: fontkit.create(regular), bold: fontkit.create(bold) }
  options = { fonts, links: { origin: 'https://score.example', workspaceId: 'workspace-one' } }
})

after(() => rm(output, { recursive: true, force: true }))

const ANCHORED_GUIDANCE = 'Look for owned designs. 0: No evidence. 1: Mentions design work. 2: Contributed to designs. 3: Designed a component independently. 4: Led designs across teams. 5: Set design direction for an organization.'

function rubricPayload({ notice = '', policy = {} } = {}) {
  return {
    schemaVersion: 1, dataKind: 'real', workspaceId: 'workspace-one', generatedAt: '2026-09-18T18:00:03.000Z',
    settings: {
      revision: 'settings-one',
      policy: { ...api.createDefaultAdminSettings().reports, additionalFooter: notice, ...policy },
    },
    job: {
      id: 'job-1', title: 'Principal Engineer', displayName: 'Principal Engineer (shared)', organization: 'Example Agency',
      location: 'Denver, CO', arrangement: 'Hybrid', employmentType: 'Full-time', grade: 'GS-14', series: '2210',
      sourceLabel: 'principal-engineer.pdf', pagination: 'pdf-pages',
    },
    rubric: {
      id: 'rubric-1', version: 2, latestVersion: 2, name: 'Principal Engineer rubric',
      description: 'How we assess principal engineers.', createdAt: '2026-09-17T18:00:00.000Z', provenance: 'edited',
      criteria: [
        {
          label: 'System design', description: 'Designs resilient distributed systems.', weight: 60,
          guidance: ANCHORED_GUIDANCE, requirementType: 'required',
          citations: [
            { page: 2, heading: 'Duties', quote: 'Design and evolve resilient distributed systems.' },
            { page: 3, heading: 'Qualifications', quote: 'Experience leading architecture reviews.' },
          ],
        },
        {
          label: 'Mentoring', description: 'Grows other engineers.', weight: 40,
          guidance: 'Credit sustained mentoring of engineers.', requirementType: 'preferred',
          citations: [{ page: 3, heading: 'Qualifications', quote: 'Mentors engineers across teams.' }],
        },
      ],
    },
  }
}

const documentFor = value => api.rubricDocumentFromPayload(api.parseRubricExportPayload(value), LINKS)
const compact = value => value.replace(/\s+/gu, '')
// The PDF repeats table header rows at page breaks; Word stores one native repeating header row.
const TABLE_HEADERS = [
  'ScoreLevel', 'ScoreWhatearnsthisscore', '#CriterionRequirementWeight', '#CriterionSourcesupportWeight',
  'CriterionWeightScore', 'NameScoreAssessmenthighlights',
]
const normalizedBody = value => TABLE_HEADERS.reduce((text, header) => text.replaceAll(header, ''),
  value.replace(/Page\s*\d*/g, '').replace(/[\s\u2022]/gu, ''))

function assertIncludes(haystack, values, context) {
  const text = compact(haystack)
  for (const value of values) assert.ok(text.includes(compact(value)), `${context} is missing ${JSON.stringify(value)}`)
}

function assertLinesInOrder(text, expected) {
  const lines = text.split('\n')
  let cursor = 0
  for (const line of expected) {
    const found = lines.indexOf(line, cursor)
    assert.ok(found >= 0, `Missing or out-of-order line: ${JSON.stringify(line)}`)
    cursor = found + 1
  }
}

function parseCsv(bytes) {
  const text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')
  const rows = []
  let row = [], cell = '', quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character !== '"') cell += character
      else if (text[index + 1] === '"') { cell += '"'; index++ }
      else quoted = false
    } else if (character === '"') quoted = true
    else if (character === ',') { row.push(cell); cell = '' }
    else if (character === '\r' && text[index + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; index++
    } else cell += character
  }
  assert.equal(quoted, false)
  assert.equal(row.length, 0)
  assert.equal(cell, '')
  return rows
}

function csvRecords(bytes) {
  const [headers, ...rows] = parseCsv(bytes)
  assert.equal(new Set(headers).size, headers.length)
  return {
    headers, records: rows.map(row => {
      assert.equal(row.length, headers.length)
      return Object.fromEntries(headers.map((header, index) => [header, row[index]]))
    }),
  }
}

function parseXml(xml, handlers) {
  const parser = new SaxesParser()
  for (const [event, handler] of Object.entries(handlers)) parser.on(event, handler)
  parser.write(xml).close()
}

/** Paragraph text from word/document.xml, skipping paragraph and run properties. */
function wordParagraphs(xml) {
  const paragraphs = []
  let current = null, inText = false, properties = 0
  parseXml(xml, {
    opentag(tag) {
      if (tag.name === 'w:pPr' || tag.name === 'w:rPr') properties++
      else if (properties) return
      else if (tag.name === 'w:p') current = ''
      else if (tag.name === 'w:t') inText = true
      else if (tag.name === 'w:tab' && current !== null) current += '\t'
      else if (tag.name === 'w:br' && current !== null) current += '\n'
    },
    text(value) { if (inText && current !== null) current += value },
    closetag(tag) {
      if (tag.name === 'w:pPr' || tag.name === 'w:rPr') properties--
      else if (tag.name === 'w:t') inText = false
      else if (tag.name === 'w:p') { paragraphs.push(current); current = null }
    },
  })
  return paragraphs
}

async function readWord(bytes) {
  assert.ok(bytes instanceof Uint8Array)
  assert.equal(Buffer.from(bytes.subarray(0, 2)).toString(), 'PK')
  const zip = await JSZip.loadAsync(bytes)
  const read = name => zip.file(name)?.async('string')
  const [xml, relationships, core] = await Promise.all([
    read('word/document.xml'), read('word/_rels/document.xml.rels'), read('docProps/core.xml'),
  ])
  const hyperlinks = []
  parseXml(relationships, {
    opentag(tag) {
      if (tag.name === 'Relationship' && tag.attributes.Type.endsWith('/hyperlink')) {
        assert.equal(tag.attributes.TargetMode, 'External')
        hyperlinks.push(tag.attributes.Target)
      }
    },
  })
  let title = ''
  let inTitle = false
  parseXml(core, {
    opentag(tag) { inTitle = tag.name === 'dc:title' },
    text(value) { if (inTitle) title += value },
    closetag() { inTitle = false },
  })
  return {
    xml, title, hyperlinks, text: wordParagraphs(xml).join('\n'),
    sections: (xml.match(/<w:sectPr\b/g) ?? []).length,
    media: Object.keys(zip.files).filter(name => /^word\/(media|embeddings)\//.test(name)),
  }
}

async function presentationTitle(deck) {
  let title = ''
  let inTitle = false
  parseXml(deck.entries.get('docProps/core.xml').toString('utf8'), {
    opentag(tag) { inTitle = tag.name === 'dc:title' },
    text(value) { if (inTitle) title += value },
    closetag() { inTitle = false },
  })
  return title
}

const slideTitle = slide => slide.shapes.find(shape => shape.name === 'slide-title')?.text ?? ''
const slideReference = slide => slide.shapes.find(shape => shape.name === 'job-reference')?.text ?? ''

async function readZip(bytes) {
  assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x50, 0x4b, 0x03, 0x04])
  const zip = await JSZip.loadAsync(bytes)
  const entries = new Map()
  for (const [name, file] of Object.entries(zip.files)) entries.set(name, await file.async('uint8array'))
  return entries
}

function gradeFixture({ secondSupport = 'derived' } = {}) {
  const input = readablePdfFixture({ kind: 'grade', scores: [90, 80], criterionCount: 2 })
  const target = input.targets[0]
  const [first, second] = target.criteria
  target.facts.push(
    { label: 'GS grade', value: 'GS-9' },
    { label: 'Rubric name', value: 'GS-0801 grade 9 rubric' },
    { label: 'Rubric origin', value: 'Approved grade ladder' },
    { label: `${first.label} (${first.id}) — source support`, value: 'direct' },
    { label: `${first.label} (${first.id}) — interpretation`, value: 'Count only engineering design work.' },
    { label: `${second.label} (${second.id}) — source support`, value: secondSupport },
  )
  for (const comparison of input.comparisons) {
    comparison.qualifications = [{
      qualificationId: 'specialized-experience', text: 'One year of specialized experience at the next lower grade.',
      interpretation: 'Review the duration separately from criterion scores.', support: 'gap', evidenceStatus: 'missing',
      rationale: 'The resume does not establish a full year of specialized experience.',
      citations: [], limitation: null,
      requirementCitations: [reportFixtureCitation('grade-standard', {
        quote: 'QUALIFICATION-SOURCE-QUOTE', pagination: 'markdown-sections', page: 2,
        heading: 'Specialized experience', sourceTitle: 'GS-0801 standard', paragraphId: 'qualification-paragraph',
      })],
    }]
  }
  return input
}

test('rubric payloads are strict, re-check the captured export policy and name files after the job', () => {
  const value = rubricPayload()
  assert.deepEqual(api.parseRubricExportPayload(value), value)
  const invalid = [
    payload => { payload.internalHash = 'a'.repeat(64) },
    payload => { payload.rubric.criteria[0].id = 'criterion-one' },
    payload => { payload.rubric.criteria[0].citations = [] },
    payload => { payload.rubric.criteria[0].weight = 0 },
    payload => { payload.rubric.version = 3 },
    payload => { payload.dataKind = 'demo' },
    payload => { payload.job.displayName = ' Padded title ' },
    payload => { payload.job.pagination = 'printed-pages' },
  ]
  for (const mutate of invalid) {
    const payload = structuredClone(value)
    mutate(payload)
    assert.throws(() => api.parseRubricExportPayload(payload), /saved rubric could not be read for export.*No file was generated/)
  }

  const prepared = api.prepareRubricExport(rubricPayload({ notice: NOTICE }), 'pdf', { origin: 'https://score.example/' }, 1234)
  assert.equal(prepared.format, 'pdf')
  assert.equal(prepared.notice, NOTICE)
  assert.equal(prepared.startedAt, 1234)
  assert.equal(prepared.generatedAt, value.generatedAt)
  assert.equal(prepared.document.link.url, RUBRIC_URL)
  assert.throws(() => api.prepareRubricExport(value, 'html', LINKS), /rubric export format is invalid/)

  const onlyPdf = rubricPayload({ policy: { enabledFormats: ['pdf'], defaultFormat: 'pdf' } })
  assert.equal(api.prepareRubricExport(onlyPdf, 'pdf', LINKS).format, 'pdf')
  assert.equal(api.prepareRubricExport(onlyPdf, 'markdown', LINKS).format, 'markdown')
  for (const [format, label] of [['docx', 'Word \\(\\.docx\\)'], ['pptx', 'PowerPoint \\(\\.pptx\\)'], ['csv', 'CSV']]) {
    assert.throws(() => api.prepareRubricExport(onlyPdf, format, LINKS), new RegExp(`^Error: ${label} export is disabled by application policy`))
  }
  const noReportFormats = rubricPayload({ policy: { enabledFormats: [], defaultFormat: null } })
  assert.equal(api.prepareRubricExport(noReportFormats, 'markdown', LINKS).format, 'markdown')
  assert.throws(() => api.prepareRubricExport(noReportFormats, 'pdf', LINKS), /PDF export is disabled by application policy/)
  const noRoles = rubricPayload({ policy: { allowedRoles: [] } })
  for (const format of ['markdown', 'pdf']) {
    assert.throws(() => api.prepareRubricExport(noRoles, format, LINKS), /Official exports are disabled for every workspace role/)
  }
  assert.throws(() => api.prepareRubricExport(rubricPayload({ policy: { maxInputBytes: 256 } }), 'markdown', LINKS),
    /exceeds the export input size limit/)

  const control = rubricPayload()
  control.rubric.criteria[1].description = 'Grows other engineers.\u0001'
  for (const format of ['docx', 'pptx']) {
    assert.throws(() => api.prepareRubricExport(control, format, LINKS), /Rubric text contains an XML-invalid character \(U\+0001\)/)
  }
  assert.equal(api.prepareRubricExport(control, 'markdown', LINKS).format, 'markdown')

  assert.equal(api.rubricExportFilename(value, 'pdf'), 'Principal Engineer (shared) - rubric v2.pdf')
  assert.equal(api.rubricExportFilename(value, 'docx'), 'Principal Engineer (shared) - rubric v2.docx')
  assert.equal(api.rubricExportFilename(value, 'pptx'), 'Principal Engineer (shared) - rubric v2.pptx')
  assert.equal(api.rubricExportFilename(value, 'markdown'), 'Principal Engineer (shared) - rubric v2.md')
  assert.equal(api.rubricExportFilename(value, 'csv'), 'Principal Engineer (shared) - rubric v2.csv')
  const unsafe = structuredClone(value)
  delete unsafe.job.displayName
  unsafe.job.title = 'R&D: Lead/Architect?'
  assert.equal(api.rubricExportFilename(unsafe, 'pdf'), 'R&D- Lead-Architect- - rubric v2.pdf')
})

test('scoring guidance becomes a 0–5 table only when it states every level in order', () => {
  assert.deepEqual(api.parseRubricGuidance(ANCHORED_GUIDANCE), {
    kind: 'anchors', introduction: 'Look for owned designs.',
    anchors: [
      { score: 0, level: 'No support', text: 'No evidence.' },
      { score: 1, level: 'Introductory', text: 'Mentions design work.' },
      { score: 2, level: 'Limited', text: 'Contributed to designs.' },
      { score: 3, level: 'Independent', text: 'Designed a component independently.' },
      { score: 4, level: 'Substantial', text: 'Led designs across teams.' },
      { score: 5, level: 'Sustained', text: 'Set design direction for an organization.' },
    ],
  })
  const lines = api.parseRubricGuidance('Score 0 - none\nScore 1 - some\nScore 2 - limited\nScore 3 - independent\nScore 4 - substantial\nScore 5 - sustained')
  assert.equal(lines.kind, 'anchors')
  assert.equal(lines.introduction, '')
  assert.deepEqual(lines.anchors.map(anchor => anchor.text), ['none', 'some', 'limited', 'independent', 'substantial', 'sustained'])
  for (const text of [
    '0: No evidence.\n3: Documented application.\n5: Sustained ownership.',
    '0: a. 2: b. 1: c. 3: d. 4: e. 5: f.',
    'Credit sustained mentoring of engineers.',
    'Needs 3 years of experience and 5+ projects.',
  ]) assert.deepEqual(api.parseRubricGuidance(text), { kind: 'text', text })
})

test('a saved rubric becomes a reader-facing document without internal identifiers', () => {
  const value = rubricPayload()
  const document = documentFor(value)
  assert.equal(document.kind, 'job')
  assert.equal(document.title, 'Principal Engineer (shared)')
  assert.equal(document.sourceTitle, 'Principal Engineer')
  assert.equal(document.organization, 'Example Agency')
  assert.equal(document.rubricName, 'Principal Engineer rubric')
  assert.equal(document.versionLabel, 'Version 2 (current)')
  assert.equal(document.origin, 'Edited by a reviewer')
  assert.equal(document.savedAt, api.readableAnalysisDate(value.rubric.createdAt))
  assert.equal(document.exportedAt, api.readableAnalysisDate(value.generatedAt))
  assert.deepEqual(document.about, [
    { label: 'Location', value: 'Denver, CO' }, { label: 'Work arrangement', value: 'Hybrid' },
    { label: 'Employment type', value: 'Full-time' }, { label: 'Series', value: '2210' },
    { label: 'Grade', value: 'GS-14' }, { label: 'Source', value: 'principal-engineer.pdf' },
  ])
  assert.equal(document.weightTotal, 100)
  assert.equal(document.weightNotice, null)
  assert.deepEqual(document.criteria.map(item => [item.code, item.label, item.requirement, item.weightLabel, item.scored]), [
    ['C1', 'System design', 'Required', '60%', true], ['C2', 'Mentoring', 'Preferred', '40%', true],
  ])
  assert.deepEqual(document.criteria[0].sources, [
    { quote: 'Design and evolve resilient distributed systems.', location: 'PDF page 2 · Duties' },
    { quote: 'Experience leading architecture reviews.', location: 'PDF page 3 · Qualifications' },
  ])
  assert.equal(document.criteria[0].guidance.kind, 'anchors')
  assert.deepEqual(document.criteria[1].guidance, { kind: 'text', text: 'Credit sustained mentoring of engineers.' })
  assert.equal(document.criteria[0].guidanceText, ANCHORED_GUIDANCE)
  assert.deepEqual(document.link, { text: 'View rubric in Score', url: RUBRIC_URL })
  assert.equal(document.noSources, api.RUBRIC_NO_SOURCES)
  assert.deepEqual(document.qualifications, [])
  assert.equal(document.tableLabel, 'Principal Engineer')
  assert.equal(document.tableDisplayTitle, 'Principal Engineer (shared)')
  assert.equal(document.scoring.length, 4)
  assert.equal(document.scoring[0], 'Each criterion is scored from 0 to 5 against its scoring guidance, using only evidence found in the submitted resume.')
  assert.doesNotMatch(JSON.stringify({ ...document, link: null }), /rubric-1|job-1|workspace-one|settings-one/)
  assert.deepEqual(api.rubricMetadataEntries(document), [
    'Rubric: Principal Engineer rubric', 'Version 2 (current)', 'Edited by a reviewer',
    `Saved ${document.savedAt}`, `Exported ${document.exportedAt}`,
  ])

  const older = structuredClone(value)
  delete older.job.displayName
  older.job.location = '  '
  older.rubric.version = 1
  older.rubric.latestVersion = 3
  older.rubric.provenance = 'generated'
  older.rubric.criteria[1].weight = 30.125
  const olderDocument = documentFor(older)
  assert.equal(olderDocument.title, 'Principal Engineer')
  assert.equal(olderDocument.sourceTitle, null)
  assert.equal(olderDocument.tableDisplayTitle, null)
  assert.equal(olderDocument.versionLabel, 'Version 1 of 3 — a newer version exists')
  assert.equal(olderDocument.origin, 'Generated from the job posting')
  assert.equal(olderDocument.about.some(fact => fact.label === 'Location'), false)
  assert.equal(olderDocument.criteria[1].weightLabel, '~30.13%')
  assert.equal(olderDocument.weightNotice,
    'The criterion weights total 90.125%, not 100%. Review the rubric in Score before relying on its overall scores.')

  const encoded = structuredClone(value)
  encoded.workspaceId = 'team space/1'
  encoded.rubric.id = 'rubric#1'
  encoded.job.id = 'job&1'
  assert.equal(documentFor(encoded).link.url, 'https://score.example/workspaces/team%20space%2F1/rubrics/rubric%231?job=job%261')
  for (const origin of ['https://score.example/app', 'javascript:alert(1)', 'https://user@score.example', 'https://score.example?x=1']) {
    assert.throws(() => api.rubricDocumentFromPayload(value, { origin }), /Rubric links require a valid HTTP\(S\) application origin/)
  }
})

test('report rubric details come from the frozen target and its completed comparisons', () => {
  const input = readablePdfFixture({ scores: [90, 80], criterionCount: 2 })
  input.targets[0].facts.push(
    { label: 'Rubric name', value: 'Engineering specialist rubric' },
    { label: 'Rubric origin', value: 'Edited by a reviewer' },
    { label: 'Rubric created', value: '2026-09-10T12:00:00.000Z' },
    { label: 'Job location', value: 'Denver, CO' },
    { label: 'Job work arrangement', value: 'Hybrid' },
    { label: 'Job employment type', value: 'Full-time' },
    { label: 'Job source', value: 'engineering-role.pdf' },
  )
  const report = api.buildAnalysisReport(input)
  const [group] = report.groups
  const original = JSON.stringify(report)
  const document = api.rubricDocumentFromReportGroup(report, group, options)
  assert.equal(JSON.stringify(report), original)
  assert.equal(document.kind, 'job')
  assert.equal(document.title, 'Engineering specialist')
  assert.equal(document.organization, 'Example public works team 1')
  assert.equal(document.rubricName, 'Engineering specialist rubric')
  assert.equal(document.versionLabel, group.target.presentation.versionLabel)
  assert.equal(document.origin, 'Edited by a reviewer')
  assert.equal(document.savedAt, api.readableAnalysisDate('2026-09-10T12:00:00.000Z'))
  assert.equal(document.exportedAt, null)
  assert.deepEqual(document.about.map(fact => fact.label), ['Location', 'Work arrangement', 'Employment type', 'Series', 'Grade', 'Source'])
  assert.deepEqual(document.criteria.map(item => [item.code, item.label, item.description]),
    group.target.criteria.map((item, index) => [`C${index + 1}`, item.label, item.description]))
  // Both candidates cite the same posting passage; it is listed once.
  assert.deepEqual(document.criteria.map(item => item.sources), [0, 1].map(number => [{
    quote: `RAW-REQUIREMENT-QUOTE-${number}: Apply and communicate engineering methods.`,
    location: `PDF page ${4 + number} · Responsibilities`,
  }]))
  assert.equal(document.noSources, api.RUBRIC_NO_SOURCES)
  assert.deepEqual(document.link, { text: 'View job', url: api.reportReviewLinks(report, group.comparisons[0], options).target })
  assert.equal(document.tableLabel, api.readableTargetSourceLabel(report, group))
  assert.deepEqual(document.qualifications, [])
  assert.equal(api.rubricDetailsTitle('job'), 'Job & rubric details')

  // A job whose only comparison failed still appears in PowerPoint reports; its rubric has no posting quotes.
  const terminal = readablePdfFixture({ scores: [90], targetCount: 2, criterionCount: 2 })
  terminal.comparisons[1] = realReportFixture({ scores: [90], targetCount: 2, statuses: ['failed'], criterionCount: 2 }).comparisons[1]
  terminal.comparisons[1].candidate = structuredClone(terminal.comparisons[0].candidate)
  const settled = api.buildAnalysisReport(withReportNarratives(terminal))
  const unfinished = settled.groups.find(item => item.comparisons.every(comparison => comparison.status !== 'complete'))
  assert.ok(unfinished)
  const empty = api.rubricDocumentFromReportGroup(settled, unfinished, options)
  assert.equal(empty.noSources, api.RUBRIC_NO_COMPLETED_SOURCES)
  assert.equal(empty.criteria.length, 2)
  assert.ok(empty.criteria.every(item => item.sources.length === 0))
  assert.deepEqual(empty.link, { text: 'View job', url: api.reportReviewLinks(settled, unfinished.comparisons[0], options).target })
})

test('grade rubric details show source support, unscored criteria and deduplicated GS qualifications', () => {
  const report = api.buildAnalysisReport(gradeFixture({ secondSupport: 'not-applicable' }))
  const [group] = report.groups
  const document = api.rubricDocumentFromReportGroup(report, group, options)
  assert.equal(document.kind, 'grade')
  assert.equal(document.rubricName, 'GS-0801 grade 9 rubric')
  assert.equal(document.origin, 'Approved grade ladder')
  assert.deepEqual(document.about, [{ label: 'GS grade', value: 'GS-9' }, { label: 'Series', value: '0801' }])
  assert.deepEqual(document.criteria.map(item => [item.support, item.interpretation, item.weightLabel, item.scored]), [
    ['Direct support', 'Count only engineering design work.', '50%', true],
    ['Not applicable · unscored', null, 'Not scored', false],
  ])
  assert.ok(document.scoring.includes('Criteria marked “Not scored” don’t apply to this grade. They carry no weight.'))
  assert.ok(document.scoring.includes('GS qualifications are listed separately. They aren’t scored, and they aren’t an official eligibility finding.'))
  assert.deepEqual(api.rubricGlanceTable(document), {
    headers: ['#', 'Criterion', 'Source support', 'Weight'],
    rows: [
      ['C1', group.target.criteria[0].label, 'Direct support', '50%'],
      ['C2', group.target.criteria[1].label, 'Not applicable · unscored', 'Not scored'],
    ],
  })
  // Two sources are cited, so every location names its source.
  assert.equal(document.criteria[0].sources[0].location, 'Engineering-role.pdf · PDF page 4 · Responsibilities')
  assert.deepEqual(document.qualifications, [{
    code: 'Q1', text: 'One year of specialized experience at the next lower grade.',
    interpretation: 'Review the duration separately from criterion scores.', support: 'Evidence gap',
    sources: [{ quote: 'QUALIFICATION-SOURCE-QUOTE', location: 'GS-0801 standard · Markdown section 2 · Specialized experience' }],
  }])
  assert.equal(document.link.text, 'View grade requirements')
  assert.equal(api.rubricDetailsTitle('grade'), 'Grade & rubric details')
  assert.equal(api.rubricSourceLabel(document), 'From the grade sources')
})

test('Markdown keeps the rubric structure and treats saved text as literal text', () => {
  const value = rubricPayload()
  const document = documentFor(value)
  const markdown = api.writeRubricMarkdown(document, NOTICE)
  assert.ok(markdown.endsWith('\n') && !markdown.endsWith('\n\n'))
  assertLinesInOrder(markdown, [
    '# Principal Engineer (shared)',
    'Example Agency',
    'Source job title: Principal Engineer',
    '- Rubric: Principal Engineer rubric',
    '- Version 2 (current)',
    '- Edited by a reviewer',
    `- Saved ${document.savedAt}`,
    `- Exported ${document.exportedAt}`,
    `[View rubric in Score](<${RUBRIC_URL}>)`,
    '## About the job',
    'How we assess principal engineers.',
    '- **Location:** Denver, CO',
    '- **Source:** principal-engineer.pdf',
    '## How this rubric is scored',
    document.scoring[0],
    '| Score | Level |',
    '| --- | --- |',
    ...api.SCORE_LEGEND.map(item => `| ${item.value} | ${item.label} |`),
    document.scoring[1],
    '## Criteria at a glance',
    '| \\# | Criterion | Requirement | Weight |',
    '| --- | --- | --- | --- |',
    '| C1 | System design | Required | 60% |',
    '| C2 | Mentoring | Preferred | 40% |',
    '## Criteria in detail',
    '### C1. System design',
    '**Requirement:** Required · **Weight:** 60%',
    'Designs resilient distributed systems.',
    '#### Scoring guidance',
    'Look for owned designs.',
    '| Score | What earns this score |',
    '| 0 · No support | No evidence. |',
    '| 5 · Sustained | Set design direction for an organization. |',
    '#### From the job posting',
    '> “Design and evolve resilient distributed systems.”',
    '> — PDF page 2 · Duties',
    '> “Experience leading architecture reviews.”',
    '> — PDF page 3 · Qualifications',
    '### C2. Mentoring',
    '**Requirement:** Preferred · **Weight:** 40%',
    '#### Scoring guidance',
    'Credit sustained mentoring of engineers.',
    '#### From the job posting',
    '> “Mentors engineers across teams.”',
    '## Additional notice',
    NOTICE,
  ])
  assert.doesNotMatch(api.writeRubricMarkdown(document), /Additional notice/)
  assert.doesNotMatch(markdown.replace(RUBRIC_URL, ''), /job-1|rubric-1|workspace-one|settings-one/)

  const tricky = structuredClone(value)
  tricky.rubric.criteria[0].label = '*Bold* <b>|pipe|</b> & `code` $x$ #tag [link](https://evil.example)'
  tricky.rubric.criteria[0].description = '- dash\r\n1. one\n\nSecond paragraph'
  tricky.rubric.criteria[1].citations[0].quote = 'Line one\nLine two'
  const escaped = api.writeRubricMarkdown(documentFor(tricky))
  const label = '\\*Bold\\* \\<b\\>\\|pipe\\|\\</b\\> \\& \\`code\\` \\$x\\$ \\#tag \\[link\\](https://evil.example)'
  assert.ok(escaped.includes(`\n### C1. ${label}\n`))
  assert.ok(escaped.includes(`\n| C1 | ${label} | Required | 60% |\n`))
  assert.ok(escaped.includes('\n\\- dash\\\n1\\. one\n\nSecond paragraph\n'))
  assert.ok(escaped.includes('\n> “Line one\\\n> Line two”\n'))
  assert.doesNotMatch(escaped, /<b>|(?<!\\)\]\(https:\/\/evil/)

  assert.throws(() => api.writeRubricMarkdown({ ...document, link: { text: 'View', url: 'javascript:alert(1)' } }),
    /not a safe HTTP\(S\) address/)
  const prepared = api.prepareRubricExport(value, 'markdown', LINKS)
  const bytes = api.generateRubricMarkdown(prepared.document, prepared)
  assert.equal(Buffer.from(bytes).toString('utf8'), api.writeRubricMarkdown(prepared.document, prepared.notice))
  assert.throws(() => api.generateRubricMarkdown(prepared.document, { limits: { ...prepared.limits, maxOutputBytes: 64 }, startedAt: Date.now() }),
    /exceeds the export size limit/)
  assert.throws(() => api.generateRubricMarkdown(prepared.document, {
    limits: prepared.limits, startedAt: Date.now() - prepared.limits.maxGenerationMilliseconds - 1,
  }), /time limit/)
})

test('rubric CSV has one row per criterion and guards spreadsheet formulas', () => {
  const value = rubricPayload({ notice: NOTICE })
  value.rubric.criteria[1].label = '=HYPERLINK("https://evil.example")'
  const prepared = api.prepareRubricExport(value, 'csv', LINKS)
  const bytes = api.generateRubricCsv([prepared.document], prepared)
  assert.deepEqual(Array.from(bytes.subarray(0, 3)), [0xef, 0xbb, 0xbf])
  assert.ok(Buffer.from(bytes).toString('utf8').endsWith('\r\n'))
  const { headers, records } = csvRecords(bytes)
  assert.deepEqual(headers, [
    'Job/grade', 'Organization', 'Rubric', 'Rubric version', 'Criterion #', 'Criterion', 'Requirement type', 'Weight (%)',
    'Scored', 'Description', 'Scoring guidance', 'Source quotes', 'Source locations', 'Link', 'Job/grade display title',
    'Additional notice',
  ])
  assert.deepEqual(records[0], {
    'Job/grade': 'Principal Engineer', Organization: 'Example Agency', Rubric: 'Principal Engineer rubric', 'Rubric version': '2',
    'Criterion #': 'C1', Criterion: 'System design', 'Requirement type': 'Required', 'Weight (%)': '60', Scored: 'Yes',
    Description: 'Designs resilient distributed systems.', 'Scoring guidance': ANCHORED_GUIDANCE,
    'Source quotes': '[1] “Design and evolve resilient distributed systems.”\n[2] “Experience leading architecture reviews.”',
    'Source locations': '[1] PDF page 2 · Duties\n[2] PDF page 3 · Qualifications',
    Link: RUBRIC_URL, 'Job/grade display title': 'Principal Engineer (shared)', 'Additional notice': NOTICE,
  })
  assert.equal(records.length, 2)
  assert.equal(records[1].Criterion, `'=HYPERLINK("https://evil.example")`)

  const plain = rubricPayload()
  delete plain.job.displayName
  const plainRows = api.rubricCsvRows([documentFor(plain)])
  assert.deepEqual(plainRows[0].slice(-2), ['Source locations', 'Link'])
  assert.throws(() => api.rubricCsvRows([]), /needs at least one rubric/)
  assert.throws(() => api.generateRubricCsv([prepared.document], { limits: { ...prepared.limits, maxOutputBytes: 200 }, startedAt: Date.now() }),
    /exceeds the export size limit/)
})

test('PDF, Word and PowerPoint rubric exports carry the same saved rubric, link and title', async () => {
  const value = rubricPayload({ notice: NOTICE })
  const title = 'Principal Engineer (shared) — job rubric (version 2)'
  const expected = [
    'Principal Engineer (shared)', 'Example Agency', 'Source job title: Principal Engineer', 'Rubric: Principal Engineer rubric',
    'Version 2 (current)', 'Edited by a reviewer', 'View rubric in Score', 'About the job', 'How we assess principal engineers.',
    'Location: Denver, CO', 'How this rubric is scored', ...api.SCORE_LEGEND.map(item => item.label), 'Criteria at a glance',
    'Criteria in detail', 'C1. System design', 'Designs resilient distributed systems.', 'Scoring guidance', 'Look for owned designs.',
    '0 · No support', 'No evidence.', '5 · Sustained', 'Set design direction for an organization.', 'From the job posting',
    '“Design and evolve resilient distributed systems.”', 'PDF page 2 · Duties', '“Experience leading architecture reviews.”',
    'C2. Mentoring', 'Grows other engineers.', 'Credit sustained mentoring of engineers.', '“Mentors engineers across teams.”',
    'Additional notice', NOTICE,
  ]

  const pdfBytes = await api.generateRubricPdf(api.prepareRubricExport(value, 'pdf', LINKS), fonts)
  const pdf = await readPdf(pdfBytes)
  assertNoClipping(pdf, measurementFonts)
  assert.equal(pdf.document.getTitle(), title)
  assert.equal(pdf.document.getSubject(), 'Job rubric for human review')
  assertIncludes(pdf.body, expected, 'PDF')
  assert.deepEqual([...new Set(pdf.uriAnnotations.map(link => link.url))], [RUBRIC_URL])
  assert.ok(pdf.pages.every(page => page.section.endsWith('Job rubric') && page.primary === 'Principal Engineer (shared)'))
  assert.doesNotMatch(pdf.text, /job-1|rubric-1|workspace-one|settings-one/)

  const word = await readWord(await api.generateRubricDocx(api.prepareRubricExport(value, 'docx', LINKS), fonts))
  assert.equal(word.title, title)
  assert.equal(normalizedBody(word.text), normalizedBody(pdf.body), 'Word mirrors the PDF text')
  assert.deepEqual([...new Set(word.hyperlinks)], [RUBRIC_URL])
  assert.deepEqual(word.media, [], 'Word text is editable, not pictures of pages')

  const deck = await inspectPptx(await api.generateRubricPptx(api.prepareRubricExport(value, 'pptx', LINKS)))
  assert.equal(await presentationTitle(deck), title)
  assertIncludes(deck.text, expected.filter(item => item !== '0 · No support' && item !== '5 · Sustained'), 'PowerPoint')
  assertIncludes(deck.text, ['0 · No support: No evidence.', '5 · Sustained: Set design direction for an organization.'], 'PowerPoint')
  const titles = deck.slides.map(slideTitle)
  assert.equal(titles[0], 'Job rubric')
  for (const section of ['Criteria at a glance', 'Criteria in detail', 'Additional notice']) assert.ok(titles.includes(section), section)
  assert.ok(titles.indexOf('Criteria at a glance') < titles.indexOf('Criteria in detail'))
  assert.ok(deck.slides.every(slide => [...slide.relationships.values()].includes(RUBRIC_URL)), 'Every slide links back to the rubric')
  assert.ok(deck.slides.every(slide => slideReference(slide) === 'Principal Engineer (shared)'))
})

test('long rubrics continue across PDF pages and PowerPoint slides without losing criteria', async () => {
  const value = rubricPayload()
  value.rubric.criteria = Array.from({ length: 20 }, (_, index) => ({
    label: `Criterion ${index + 1} ${'with a long descriptive label '.repeat(index === 3 ? 12 : 1)}END-${index + 1}`,
    description: `${'Detailed expectation for this criterion. '.repeat(12)}DESCRIPTION-END-${index + 1}`,
    weight: 5, guidance: ANCHORED_GUIDANCE,
    requirementType: index % 2 ? 'preferred' : 'required',
    citations: [{ page: index + 1, heading: 'Duties', quote: `${'A long quoted passage from the posting. '.repeat(6)}QUOTE-END-${index + 1}` }],
  }))
  const pdf = await readPdf(await api.generateRubricPdf(api.prepareRubricExport(value, 'pdf', LINKS), fonts))
  assertNoClipping(pdf, measurementFonts)
  assert.ok(pdf.pages.length > 3)
  const ends = value.rubric.criteria.flatMap((_, index) => [`END-${index + 1}`, `DESCRIPTION-END-${index + 1}`, `QUOTE-END-${index + 1}`])
  assertIncludes(pdf.body, ends, 'Long PDF')

  const deck = await inspectPptx(await api.generateRubricPptx(api.prepareRubricExport(value, 'pptx', LINKS)))
  assertIncludes(deck.text, ends, 'Long PowerPoint')
  const titles = deck.slides.map(slideTitle)
  assert.ok(titles.includes('Criteria at a glance (continued)'))
  assert.ok(titles.includes('Criteria in detail (continued)'))
})

test('report exports end each job section with its job & rubric details only when requested', async () => {
  const report = api.buildAnalysisReport(readablePdfFixture({ scores: [90, null], targetCount: 2, criterionCount: 2 }))
  const original = JSON.stringify(report)
  const detailedOptions = { ...options, rubricDetails: true }
  const [plainPdf, detailedPdf] = await Promise.all([
    api.generatePdfReport(report, options).then(readPdf), api.generatePdfReport(report, detailedOptions).then(readPdf),
  ])
  assert.equal(JSON.stringify(report), original, 'Rubric details must not change the saved report')
  const rubricPage = page => page.section.endsWith('Job & rubric details')
  assert.equal(plainPdf.pages.some(rubricPage), false)
  assert.doesNotMatch(plainPdf.text, /rubric details/i)
  const unchanged = pdf => pdf.pages.filter(page => !rubricPage(page) && !page.section.endsWith('Contents')).map(page => page.body)
  assert.deepEqual(unchanged(detailedPdf), unchanged(plainPdf), 'Only the contents and the new sections differ')
  assertIncludes(detailedPdf.pages.filter(page => page.section.endsWith('Contents')).map(page => page.body).join(''),
    ['complete candidate table and rubric details', 'Job & rubric details included'], 'Contents')

  const runs = []
  detailedPdf.pages.forEach((page, index) => {
    if (!rubricPage(page)) return
    if (runs.at(-1)?.end === index - 1) runs.at(-1).end = index
    else runs.push({ start: index, end: index })
  })
  assert.equal(runs.length, report.groups.length)
  for (const [index, run] of runs.entries()) {
    const pages = detailedPdf.pages.slice(run.start, run.end + 1)
    const previous = detailedPdf.pages[run.start - 1]
    assert.ok(previous.section.endsWith('Candidates at a glance'), 'Rubric details follow the candidate table')
    assert.ok(pages.every(page => page.primary === previous.primary && page.secondary === 'How each criterion is defined and scored'))
    const next = detailedPdf.pages[run.end + 1]
    if (index < runs.length - 1) assert.ok(next.body.includes('Returntocontents') || next.body.includes('Return to contents'))
    else assert.equal(next, undefined)
    const { target } = report.groups[index]
    assertIncludes(pages.map(page => page.body).join(''), [
      'Job & rubric details', target.presentation.title, 'About the job', 'How this rubric is scored', 'Criteria at a glance',
      'Criteria in detail', 'View job', 'From the job posting',
      ...target.criteria.flatMap((criterion, number) => [
        `C${number + 1}. ${criterion.label}`, criterion.description, criterion.guidance.split(' 0:')[0],
        `RAW-REQUIREMENT-QUOTE-${number}`,
      ]),
    ], `Rubric details ${index + 1}`)
  }
  const links = detailedPdf.pages.filter(rubricPage).flatMap(page => page.uriAnnotations.map(link => link.url))
  assert.deepEqual(new Set(links), new Set(report.groups.map(group => api.reportReviewLinks(report, group.comparisons[0], options).target)))

  const [plainWord, detailedWord] = await Promise.all([
    api.generateDocxReport(report, options).then(readWord), api.generateDocxReport(report, detailedOptions).then(readWord),
  ])
  assert.equal(detailedWord.sections, plainWord.sections + report.groups.length, 'Word adds one section per job')
  assert.doesNotMatch(plainWord.text, /rubric details/i)
  assert.equal(normalizedBody(detailedWord.text), normalizedBody(detailedPdf.body), 'Word mirrors the PDF, including rubric details')

  const [plainDeck, detailedDeck] = await Promise.all([
    api.generatePptxReport(report, options).then(inspectPptx), api.generatePptxReport(report, detailedOptions).then(inspectPptx),
  ])
  const rubricSlides = deck => deck.slides.filter(slide => slideReference(slide).endsWith(' · Rubric details'))
  assert.equal(rubricSlides(plainDeck).length, 0)
  assert.equal(detailedDeck.slides.length, plainDeck.slides.length + rubricSlides(detailedDeck).length)
  const references = detailedDeck.slides.map(slideReference)
  const titles = detailedDeck.slides.map(slideTitle)
  for (const [index, group] of report.groups.entries()) {
    const section = `Section ${index + 1} · Job analysis`
    const slides = references.flatMap((reference, slide) => reference === `${section} · Rubric details` ? [slide] : [])
    const glance = references.flatMap((reference, slide) =>
      reference === section && titles[slide].startsWith('Candidates at a glance') ? [slide] : [])
    assert.ok(slides.length >= 3)
    assert.ok(slides.every((slide, position) => !position || slide === slides[position - 1] + 1), 'Rubric slides stay together')
    assert.equal(slides[0], Math.max(...glance) + 1, 'Rubric slides follow the candidate table')
    assert.equal(titles[slides[0]], 'Job & rubric details')
    const nextSection = references.findIndex(reference => reference.startsWith(`Section ${index + 2} ·`))
    assert.equal(slides.at(-1) + 1, nextSection === -1 ? detailedDeck.slides.length : nextSection)
    const text = slides.map(slide => detailedDeck.slides[slide].text).join('\n')
    assertIncludes(text, [
      'How this rubric is scored', 'Criteria at a glance', 'Criteria in detail', 'From the job posting',
      ...group.target.criteria.map((criterion, number) => `C${number + 1}. ${criterion.label}`),
      ...group.target.criteria.map((_, number) => `RAW-REQUIREMENT-QUOTE-${number}`),
    ], `PowerPoint rubric details ${index + 1}`)
  }
})

test('grade reports add grade & rubric details with GS qualifications in every format', async () => {
  const report = api.buildAnalysisReport(gradeFixture())
  const detailedOptions = { ...options, rubricDetails: true }
  const pdf = await readPdf(await api.generatePdfReport(report, detailedOptions))
  const pages = pdf.pages.filter(page => page.section.endsWith('Grade & rubric details'))
  assert.ok(pages.length > 0)
  const expected = [
    'Grade & rubric details', 'About the grade', 'GS grade: GS-9', 'Rubric: GS-0801 grade 9 rubric', 'Approved grade ladder',
    'Direct support', 'Derived support', 'Interpretation: Count only engineering design work.', 'From the grade sources',
    'GS qualifications (unscored)', 'Q1', 'One year of specialized experience at the next lower grade.',
    'Source support: Evidence gap', '“QUALIFICATION-SOURCE-QUOTE”', 'View grade requirements',
  ]
  assertIncludes(pages.map(page => page.body).join(''), expected, 'Grade PDF')
  const word = await readWord(await api.generateDocxReport(report, detailedOptions))
  assert.equal(normalizedBody(word.text), normalizedBody(pdf.body))
  const deck = await inspectPptx(await api.generatePptxReport(report, detailedOptions))
  const slides = deck.slides.filter(slide => slideReference(slide) === 'Section 1 · Grade analysis · Rubric details')
  assert.equal(slideTitle(slides[0]), 'Grade & rubric details')
  assertIncludes(slides.map(slide => slide.text).join('\n'), expected.filter(item => item !== 'View grade requirements'), 'Grade PowerPoint')

  const bundle = await readZip(await api.generateCsvBundle(report, options))
  const rubrics = csvRecords(bundle.get('rubrics.csv'))
  assert.deepEqual(rubrics.headers.slice(12, 16), ['Source locations', 'Source support', 'Interpretation', 'Link'])
  assert.deepEqual(rubrics.records.map(row => [row['Criterion #'], row.Scored, row['Source support']]), [
    ['C1', 'Yes', 'Direct support'], ['C2', 'Yes', 'Derived support'], ['Q1', 'No', 'Evidence gap'],
  ])
  assert.equal(rubrics.records[2].Criterion, 'One year of specialized experience at the next lower grade.')
  assert.equal(rubrics.records[2].Interpretation, 'Review the duration separately from criterion scores.')
})

test('the CSV bundle pairs the unchanged analysis CSV with a rubric CSV that joins on job and criterion', async () => {
  const report = api.buildAnalysisReport(readablePdfFixture({ scores: [90, 80], targetCount: 2, criterionCount: 2 }))
  const original = JSON.stringify(report)
  const bytes = await api.generateCsvBundle(report, options)
  assert.equal(JSON.stringify(report), original)
  assert.deepEqual(await api.generateCsvBundle(report, options), bytes, 'The bundle is deterministic')
  const entries = await readZip(bytes)
  assert.deepEqual([...entries.keys()], [api.REPORT_CSV_BUNDLE_FILES.analyses, api.REPORT_CSV_BUNDLE_FILES.rubrics])
  assert.deepEqual(entries.get('analyses.csv'), api.generateCsvReport(report, options), 'analyses.csv is exactly the plain CSV report')
  assert.deepEqual(Array.from(entries.get('rubrics.csv').subarray(0, 3)), [0xef, 0xbb, 0xbf])

  const analyses = csvRecords(entries.get('analyses.csv'))
  const rubrics = csvRecords(entries.get('rubrics.csv'))
  assert.equal(rubrics.records.length, report.groups.reduce((sum, group) => sum + group.target.criteria.length, 0))
  for (const group of report.groups) {
    const label = api.readableTargetSourceLabel(report, group)
    const rows = rubrics.records.filter(row => row['Job/grade'] === label && row.Organization === group.target.presentation.organization)
    assert.deepEqual(rows.map(row => row['Criterion #']), group.target.criteria.map((_, index) => `C${index + 1}`))
    assert.deepEqual(rows.map(row => row.Criterion), group.target.criteria.map(criterion => criterion.label))
    for (const row of rows) assert.ok(analyses.headers.includes(row['Criterion #']), 'Criterion numbers match the analysis columns')
    const analysisRows = analyses.records.filter(row => row['Job/grade'] === label)
    assert.ok(analysisRows.length > 0)
    assert.ok(rows.every(row => row.Link === analysisRows[0]['Job/grade link']))
  }

  const policy = { ...report.capture.settings.policy, additionalFooter: NOTICE }
  const noticed = { ...report, capture: { ...report.capture, settings: { ...report.capture.settings, policy } } }
  const noticedRubrics = csvRecords((await readZip(await api.generateCsvBundle(noticed, options))).get('rubrics.csv'))
  assert.ok(noticedRubrics.records.every(row => row['Additional notice'] === NOTICE))

  const tight = { ...report, capture: { ...report.capture, settings: { ...report.capture.settings, policy: { ...policy, maxOutputBytes: 2500 } } } }
  await assert.rejects(api.generateCsvBundle(tight, options), /exceeds the (export|report download) size limit/)
})
