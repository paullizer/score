import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import JSZip from 'jszip'
import { SaxesParser } from 'saxes'
import { loadReportFoundation, version2ReportFixture } from './test-support.mjs'
import { mappingWorkbookBytes } from './mapping-test-support.mjs'
import { readPdf } from './pdf-test-support.mjs'

let api, foundation, options
const output = resolve(`.applicant-mapping-tests-${randomUUID()}`)
const buffer = bytes => Uint8Array.from(bytes).buffer
before(async () => {
  await mkdir(output)
  foundation = await loadReportFoundation()
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      export * from './src/services/analysisReports/applicant-mapping';
      export * from './src/services/analysisReports/mapping-parser';
      export { generateCsvReport } from './src/services/analysisReports/csv';
      export { generateCsvBundle } from './src/services/analysisReports/csv-bundle';
      export { generatePdfReport } from './src/services/analysisReports/pdf';
      export { generateDocxReport } from './src/services/analysisReports/docx';
      export { generatePptxReport } from './src/services/analysisReports/pptx';
    ` }, outfile: join(output, 'mapping.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent',
  })
  api = await import(pathToFileURL(join(output, 'mapping.mjs')).href)
  options = {
    links: { origin: 'https://score.test', workspaceId: 'workspace-one' },
    fonts: {
      regular: buffer(await readFile(resolve('src', 'assets', 'report-fonts', 'NotoSans-Regular.ttf'))),
      bold: buffer(await readFile(resolve('src', 'assets', 'report-fonts', 'NotoSans-Bold.ttf'))),
    },
  }
})
after(async () => { await foundation?.cleanup(); await rm(output, { recursive: true, force: true }) })

function mappedReport({ long = false } = {}) {
  const input = version2ReportFixture()
  input.comparisons.forEach((item, index) => {
    item.candidate.name = null
    item.candidate.displayName = 'Unrelated mutable label'
    item.candidate.sourceLabel = `Applicant 09${index + 3}.pdf`
  })
  const report = foundation.api.buildAnalysisReport(input)
  const rows = [{ identifier: 'Applicant 093', name: long ? 'Long Local Name '.repeat(18).trim() : 'Local HR Name' }]
  const applicantIdentities = api.resolveApplicantIdentities(api.reportApplicants(report), rows)
  return { report, generation: { ...options, applicantIdentities } }
}

test('CSV parsing preserves text, BOM, escaped quotes and multiline fields and rejects malformed quoting', () => {
  const workbook = api.parseMappingCsv('\uFEFFID,Name,Notes\r\n"00093","Local, ""HR"" Name","line 1\nline 2"\r\n')
  assert.deepEqual(workbook.sheets[0].rows, [['ID', 'Name', 'Notes'], ['00093', 'Local, "HR" Name', 'line 1\nline 2']])
  for (const invalid of ['ID,Name\n"unclosed', 'ID,Name\nbad"quote,name', 'ID,Name\n"id"x,name']) {
    assert.throws(() => api.parseMappingCsv(invalid), /quot|unclosed/)
  }
})

test('XLSX parsing supports worksheets and text identifiers, marking numeric cells unsafe for selected columns', async () => {
  const bytes = mappingWorkbookBytes([
    { name: 'Notes', rows: [['Read me']] },
    { name: 'Applicants', rows: [['Other', 'Applicant ID', 'Name'], ['info', '00093', 'Local HR Name'], ['info', 94, 'Other Local Name']] },
  ])
  const workbook = await api.parseMappingFile('mapping.xlsx', buffer(bytes))
  assert.deepEqual(workbook.sheets.map(item => item.name), ['Notes', 'Applicants'])
  assert.equal(workbook.sheets[1].rows[1][1], '00093')
  assert.deepEqual(workbook.sheets[1].rows[2][1], { unsupported: true })
  assert.throws(() => api.mappingRows(workbook.sheets[1], 0, 1, 2), /row 3.*text/)
  assert.deepEqual(api.mappingRows({ ...workbook.sheets[1], rows: workbook.sheets[1].rows.slice(0, 2) }, 0, 1, 2),
    [{ identifier: '00093', name: 'Local HR Name' }])
})

test('mapping selection supports header offsets, blank names, unused columns and explicit missing/duplicate identifier errors', () => {
  const sheet = api.parseMappingCsv('Notes,,\nID,Name,Other\n Applicant 093.PDF , Local HR Name ,x\nApplicant 094,,x\n,,\n').sheets[0]
  assert.deepEqual(api.mappingRows(sheet, 1, 0, 1), [
    { identifier: 'Applicant 093', name: 'Local HR Name' }, { identifier: 'Applicant 094', name: null },
  ])
  assert.throws(() => api.mappingRows(sheet, 1, 1, 1), /different/)
  assert.throws(() => api.mappingRows(api.parseMappingCsv('ID,Name\n,Missing ID').sheets[0], 0, 0, 1), /identifier/)
  assert.throws(() => api.mappingRows(api.parseMappingCsv('ID,Name\nApplicant 093,A\nApplicant 093.pdf,A').sheets[0], 0, 0, 1), /duplicate/)
  assert.deepEqual(api.mappingRows(api.parseMappingCsv('ID,Name\nApplicant 093,Ren\u00e9e Jos\u00e9').sheets[0], 0, 0, 1),
    [{ identifier: 'Applicant 093', name: 'Ren\u00e9e Jos\u00e9' }])
})

test('matching is exact and source-bound, includes unmatched candidates and never uses extracted names or aliases', () => {
  const { report } = mappedReport()
  const candidates = api.reportApplicants(report)
  const identities = api.resolveApplicantIdentities([...candidates, ...candidates], [
    { identifier: 'Applicant 093', name: 'Local HR Name' },
    { identifier: 'Applicant 94', name: 'Wrong zeros' },
    { identifier: 'applicant 094', name: 'Wrong case' },
    { identifier: 'Unrelated mutable label', name: 'Wrong alias' },
  ])
  assert.equal(identities.length, 2)
  assert.deepEqual(identities.map(item => [item.identifier, item.name]), [['Applicant 093', 'Local HR Name'], ['Applicant 094', null]])
  assert.throws(() => api.resolveApplicantIdentities([candidates[0], { ...candidates[1], sourceLabel: candidates[0].sourceLabel }], []), /ambiguous/)
  const url = { ...candidates[0], sourceLabel: 'https://public.example/Applicant%20093.pdf' }
  assert.equal(api.resolveApplicantIdentities([url], [{ identifier: url.id, name: 'Never from URL' }])[0].name, null)
})

test('export identities reject foreign sources, missing/duplicate entries, extra fields, invalid names and combined resource overflow', () => {
  const { report, generation } = mappedReport()
  api.validateApplicantIdentities(report, generation)
  for (const change of [
    identities => identities.pop(),
    identities => { identities[0].sourceLabel = 'Different.pdf' },
    identities => { identities[0].documentVersion++ },
    identities => { identities[0].extra = 'untrusted' },
    identities => { identities[0].name = 'bad\nname' },
    identities => { identities.push(identities[0]) },
  ]) {
    const identities = structuredClone(generation.applicantIdentities)
    change(identities)
    assert.throws(() => api.validateApplicantIdentities(report, { applicantIdentities: identities }))
  }
  const limited = structuredClone(report)
  limited.capture.settings.policy.maxInputBytes = new TextEncoder().encode(JSON.stringify(limited)).length + 10
  assert.throws(() => api.validateApplicantIdentities(limited, generation), /limit|budget|bytes/)
})

test('input and CSV bounds fail at the actual threshold rather than clipping data', async () => {
  assert.throws(() => api.parseMappingCsv('x'.repeat(api.MAPPING_LIMITS.cellCharacters + 1)), /4,096/)
  assert.throws(() => api.parseMappingCsv(Array(51).fill('x').join(',')), /50 columns/)
  assert.throws(() => api.parseMappingCsv('x\n'.repeat(api.MAPPING_LIMITS.rows + 1)), /10,000/)
  assert.equal(api.parseMappingCsv('x\n'.repeat(api.MAPPING_LIMITS.rows)).sheets[0].rows.length, api.MAPPING_LIMITS.rows)
  await assert.rejects(api.parseMappingFile('bad.xls', buffer([1])), /Legacy/)
  await assert.rejects(api.parseMappingFile('large.csv', new ArrayBuffer(api.MAPPING_LIMITS.fileBytes + 1)), /5 MiB/)
  await assert.rejects(api.parseMappingFile('empty.csv', new ArrayBuffer(0)), /nonempty/)
})

test('XLSX preflight rejects formulas, macros, external links, sparse allocation attacks and expanded ZIP bombs', async () => {
  for (const [extra, expected] of [
    [{ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><f>SECRET_FORMULA</f><v>1</v></c></row></sheetData></worksheet>' }, /plain values/],
    [{ 'xl/vbaProject.bin': 'macro' }, /Macro/],
    [{ '[Content_Types].xml': '<Types><Override ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>' }, /Macro/],
    [{ 'xl/externalLinks/externalLink1.xml': '<externalLink/>' }, /external/],
    [{ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="10000"><c r="AX10000" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>' }, /including gaps/],
    [{ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="10001"/></sheetData></worksheet>' }, /10,000/],
    [{ 'xl/worksheets/sheet1.xml': '<!DOCTYPE worksheet [<!ENTITY x "secret">]><worksheet/>' }, /document types/],
    [{ 'large.txt': new Uint8Array(api.MAPPING_LIMITS.expandedBytes + 1) }, /16 MiB/],
  ]) {
    await assert.rejects(api.parseMappingFile('mapping.xlsx', buffer(mappingWorkbookBytes(undefined, extra))), expected)
  }
})

test('ordinary workbook printer settings are allowed without allowing executable workbook content', async () => {
  const bytes = mappingWorkbookBytes(undefined, { 'xl/printerSettings/printerSettings1.bin': new Uint8Array([1, 2, 3]) })
  const workbook = await api.parseMappingFile('mapping.xlsx', buffer(bytes))
  assert.ok(workbook.sheets.length > 0)
})

test('zero matches retains every completed applicant using its identifier', () => {
  const { report } = mappedReport()
  const applicantIdentities = api.resolveApplicantIdentities(api.reportApplicants(report), [{ identifier: 'Outside scope', name: 'Unused HR Name' }])
  assert.equal(applicantIdentities.length, 2)
  assert.ok(applicantIdentities.every(identity => identity.name === null))
  const csv = new TextDecoder().decode(api.generateCsvReport(report, { ...options, applicantIdentities }))
  assert.match(csv, /"Applicant 093"/)
  assert.match(csv, /"Applicant 094"/)
  assert.doesNotMatch(csv, /Unused HR Name/)
})

test('mapped CSV adds names and identifiers without dropping unmatched rows, modifying scores or altering ordinary exports', () => {
  const { report, generation } = mappedReport()
  const original = JSON.stringify(report)
  const ordinary = api.generateCsvReport(report, options)
  const named = new TextDecoder().decode(api.generateCsvReport(report, generation))
  assert.match(named, /"Applicant identifier"/)
  assert.match(named, /"Local HR Name"/)
  assert.match(named, /"Applicant 094"/)
  assert.match(named, /"Applicant 093.pdf"/)
  assert.match(named, /92\.75/)
  assert.match(named, /attached locally/)
  assert.deepEqual(api.generateCsvReport(report, options), ordinary)
  assert.equal(JSON.stringify(report), original)
  generation.applicantIdentities[0].name = '=FORMULA'
  assert.match(new TextDecoder().decode(api.generateCsvReport(report, generation)), /"'=FORMULA"/)
})

test('CSV ZIP uses the identical mapped analyses.csv and leaves rubric data candidate-free', async () => {
  const { report, generation } = mappedReport()
  const zip = await JSZip.loadAsync(await api.generateCsvBundle(report, generation))
  assert.deepEqual(await zip.file('analyses.csv').async('uint8array'), api.generateCsvReport(report, generation))
  assert.doesNotMatch(await zip.file('rubrics.csv').async('string'), /Local HR Name|Applicant 093/)
})

function xmlText(xml) {
  let text = ''
  const parser = new SaxesParser()
  parser.on('text', value => { text += value })
  parser.write(xml).close()
  return text
}

for (const format of ['pdf', 'docx', 'pptx']) test(`${format} includes matched names, unmatched identifiers, provenance and unchanged saved assessment text`, async () => {
  const { report, generation } = mappedReport({ long: true })
  const original = JSON.stringify(report)
  const writer = { pdf: api.generatePdfReport, docx: api.generateDocxReport, pptx: api.generatePptxReport }[format]
  const bytes = await writer(report, generation)
  let text
  if (format === 'pdf') text = (await readPdf(bytes)).text
  else {
    const zip = await JSZip.loadAsync(bytes)
    const pattern = format === 'docx' ? /^word\/document.xml$/ : /^ppt\/slides\/slide\d+\.xml$/
    text = (await Promise.all(Object.keys(zip.files).filter(name => pattern.test(name)).map(name => zip.file(name).async('string'))))
      .map(xmlText).join('\n')
  }
  assert.ok(text.includes(generation.applicantIdentities[0].name), 'The entire mapped name must be present')
  assert.match(text, /Applicant 093/)
  assert.match(text, /Applicant 094/)
  assert.match(text, /attached locally/)
  assert.match(text, /92.75/)
  assert.ok(text.includes(report.groups[0].comparisons[0].narrative.text))
  assert.equal(JSON.stringify(report), original)
})

test('named documents and decks keep source-stated names separate without requiring a custom display label', async () => {
  const { report, generation } = mappedReport()
  const candidate = report.groups[0].comparisons[0].candidate
  candidate.name = 'Original source claim'
  delete candidate.displayName
  for (const format of ['pdf', 'docx', 'pptx']) {
    const writer = { pdf: api.generatePdfReport, docx: api.generateDocxReport, pptx: api.generatePptxReport }[format]
    const bytes = await writer(report, generation)
    let text
    if (format === 'pdf') text = (await readPdf(bytes)).text
    else {
      const zip = await JSZip.loadAsync(bytes)
      const pattern = format === 'docx' ? /^word\/document.xml$/ : /^ppt\/slides\/slide\d+\.xml$/
      text = (await Promise.all(Object.keys(zip.files).filter(path => pattern.test(path)).map(path => zip.file(path).async('string'))))
        .map(xmlText).join('\n')
    }
    assert.match(text, /Local HR Name/)
    assert.match(text, /Source-stated name: Original source claim/)
    assert.equal(candidate.name, 'Original source claim')
  }
})

test('PowerPoint preserves maximum-length mapped names and identifiers without anonymous-number substitution', async () => {
  const { report } = mappedReport()
  const candidate = report.groups[0].comparisons[0].candidate
  const identifier = 'W'.repeat(api.MAPPING_LIMITS.identifierCharacters)
  const name = 'W'.repeat(api.MAPPING_LIMITS.nameCharacters)
  candidate.sourceLabel = `${identifier}.pdf`
  const applicantIdentities = api.resolveApplicantIdentities(api.reportApplicants(report), [{ identifier, name }])
  const bytes = await api.generatePptxReport(report, { ...options, applicantIdentities })
  const zip = await JSZip.loadAsync(bytes)
  const slides = await Promise.all(Object.keys(zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((left, right) => Number(left.match(/slide(\d+)/)[1]) - Number(right.match(/slide(\d+)/)[1]))
    .map(path => zip.file(path).async('string')))
  const identityText = slides.flatMap(xml => [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map(match => match[0]))
    .filter(shape => shape.includes('name="review-0-0-overview-name"'))
    .map(xmlText).join('').replace(/\s/g, '')
  assert.equal(identityText, `${name}${identifier}`, 'Every name and identifier character must be in visible identity text, not only a tooltip')
})
