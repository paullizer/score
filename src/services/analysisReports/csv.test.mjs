import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadReportFoundation, realReportFixture } from './test-support.mjs'

const output = resolve(`.csv-report-tests-${randomUUID()}`)
let foundation, writer, model

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

function records(bytes) {
  const [headers, ...rows] = parseCsv(bytes)
  assert.equal(new Set(headers).size, headers.length)
  return { headers, rows, records: rows.map((row) => {
    assert.equal(row.length, headers.length)
    return Object.fromEntries(headers.map((header, index) => [header, row[index]]))
  }) }
}

before(async () => {
  await mkdir(output)
  foundation = await loadReportFoundation()
  model = foundation.api
  await build({
    entryPoints: ['src/services/analysisReports/csv.ts'], outfile: join(output, 'csv.mjs'),
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  })
  writer = await import(pathToFileURL(join(output, 'csv.mjs')).href)
})
after(async () => { await foundation?.cleanup(); await rm(output, { recursive: true, force: true }) })

test('custom labels get separate CSV columns without replacing source identity or saved scores', () => {
  const input = realReportFixture({ scores: [92.75] })
  input.run.name = 'Renamed analysis'
  input.targets[0].displayName = 'Custom target'
  input.comparisons[0].candidate.displayName = '=Custom label'
  const result = records(writer.generateCsvReport(model.buildAnalysisReport(input)))
  assert.deepEqual(result.headers.slice(-2), ['Candidate display label', 'Job/grade display title'])
  const row = result.records[0]
  assert.equal(row['Candidate name'], input.comparisons[0].candidate.name)
  assert.equal(row['Job/grade title'], input.targets[0].label)
  assert.equal(row['Candidate display label'], "'=Custom label")
  assert.equal(row['Job/grade display title'], 'Custom target')
  assert.equal(row['Run name'], 'Renamed analysis')
  assert.equal(row['Overall score'], '92.75')
  assert.ok(result.headers[2].includes('Custom target'))
})

test('CSV begins with name, job title and criterion columns and round-trips quoted Unicode assessments', () => {
  const input = realReportFixture()
  input.comparisons[0].candidate.name = 'Zoë, "Jordan" Кириллица'
  input.comparisons[0].summary = 'First saved paragraph, with "quotes".\r\nSecond saved paragraph: café Ω.'
  const report = model.buildAnalysisReport(input)
  const bytes = writer.generateCsvReport(report)
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf])
  const result = records(bytes)
  assert.deepEqual(result.headers.slice(0, 2), ['Candidate name', 'Job/grade title'])
  assert.match(result.headers[2], /\[T1 C1\].*Duplicate criterion label.*50% weight; 0-5/)
  assert.equal(result.headers[4], 'Overall score')
  assert.equal(result.headers[5], 'Overall assessment')
  assert.equal(result.records[0]['Candidate name'], input.comparisons[0].candidate.name)
  assert.equal(result.records[0]['Overall assessment'], input.comparisons[0].summary)
  assert.equal(result.records[0]['Overall score'], '92.75')
  assert.equal(result.rows.length, input.comparisons.length)
  assert.ok(result.records.every((row) => row['Human review notice'].includes('not hiring recommendations')))
})

test('same-name criteria and targets stay distinct with exactly one row per comparison', () => {
  const report = model.buildAnalysisReport(realReportFixture({ targetCount: 2 }))
  const result = records(writer.generateCsvReport(report))
  assert.equal(result.rows.length, 6)
  assert.equal(new Set(result.records.map((row) => row['Comparison ID'])).size, 6)
  const scores = result.rows.map((row) => row.slice(2, 6))
  assert.deepEqual(scores[0], ['3', '3', '', ''])
  assert.deepEqual(scores[3], ['', '', '3', '3'])
  assert.deepEqual(result.records.map((row) => row['Evidence-match rank within target']), ['1', '2', '3', '1', '2', '3'])
  assert.equal(new Set(result.headers.slice(2, 6)).size, 4)
})

test('CSV preserves zero, withheld, N/A and pending values without inventing scores', () => {
  const input = realReportFixture({ scores: [0, null, 30], statuses: ['complete', 'complete', 'running'] })
  for (const criterion of input.comparisons[0].criteria) {
    criterion.score = 0
    criterion.evidenceStatus = 'missing'
    criterion.citations = []
  }
  input.comparisons[0].coverage.supported = 0
  input.comparisons[0].coverage.missing = 2
  const result = records(writer.generateCsvReport(model.buildAnalysisReport(input)))
  assert.equal(result.records[0]['Overall score'], '0')
  assert.equal(result.rows[0][2], '0')
  assert.equal(result.records[1]['Overall score'], '')
  assert.equal(result.records[1]['Overall score availability'], 'withheld')
  assert.match(result.records[1]['Overall score reason'], /not assessed/)
  assert.equal(result.rows[1][2], 'Not assessed')
  assert.equal(result.records[2]['Overall score'], '')
  assert.equal(result.records[2]['Comparison status'], 'Running')
  assert.equal(result.records[2]['Supported criteria'], '')
  assert.equal(result.rows[2][2], 'Not assessed')
  assert.ok(result.records.every((row) => row['Report status'] === 'Partial'))

  const grade = realReportFixture({ scores: [80], kind: 'grade' })
  grade.targets[0].criteria[0].weight = 0
  grade.targets[0].criteria[1].weight = 100
  grade.comparisons[0].criteria[0] = { ...grade.comparisons[0].criteria[0], weight: 0, score: null, evidenceStatus: 'not-applicable', citations: [] }
  grade.comparisons[0].criteria[1].weight = 100
  grade.comparisons[0].coverage.supported = 1
  grade.comparisons[0].coverage.notApplicable = 1
  assert.equal(records(writer.generateCsvReport(model.buildAnalysisReport(grade))).rows[0][2], 'N/A')
})

test('all untrusted spreadsheet formula prefixes are neutralized, including whitespace and control prefixes', () => {
  const names = ['=1+2', '+1+2', '-1+2', '@SUM(A1)', ' \t=1+2', '\r=1+2', '\n=1+2', '\uFEFF=1+2', '\u200F=1+2', '\u0001=1+2', '\tordinary', '＝1+2']
  const input = realReportFixture({ scores: names.map(() => 80) })
  input.comparisons.forEach((comparison, index) => { comparison.candidate.name = names[index]; comparison.summary = `=Summary "${index}",\ncell` })
  input.run.name = '=run formula'
  input.targets[0].label = '+target formula'
  const result = records(writer.generateCsvReport(model.buildAnalysisReport(input)))
  for (const [index, record] of result.records.entries()) {
    assert.equal(record['Candidate name'], `'${names[index]}`)
    assert.equal(record['Overall score'], '80')
    assert.equal(record['Job/grade title'], "'+target formula")
    assert.equal(record['Run name'], "'=run formula")
    assert.equal(record['Overall assessment'], `'=Summary "${index}",\ncell`)
  }
})

test('top-five cutoff ties share ranks and all 500 comparisons are exported', () => {
  const report = model.buildAnalysisReport(realReportFixture({ scores: Array(500).fill(80) }))
  const result = records(writer.generateCsvReport(report))
  assert.equal(result.records.length, 500)
  assert.equal(result.records.filter((row) => row['Highlighted evidence match'] === 'Yes').length, 10)
  assert.ok(result.records.every((row) => row['Evidence-match rank within target'] === '1'))
  assert.ok(result.records.every((row) => row['Additional candidates tied at cutoff'] === '490'))
  assert.equal(new Set(result.records.map((row) => row['Comparison ID'])).size, 500)
})

test('sample CSV is explicitly fictional and malformed row counts fail rather than download partial data', () => {
  const input = realReportFixture({ scores: [80] })
  input.dataKind = 'sample'
  delete input.workspaceId
  for (const target of input.targets) { target.dataKind = 'sample'; target.selection = null; target.snapshot = null; target.rubricId = target.id }
  for (const comparison of input.comparisons) {
    comparison.dataKind = 'sample'
    comparison.candidate.snapshot = null
    comparison.candidate.documentSha256 = null
    comparison.resultSha256 = null
  }
  const report = model.buildAnalysisReport(input)
  assert.equal(records(writer.generateCsvReport(report)).records[0]['Report data'], 'Fictional sample')
  report.counts.total++
  assert.throws(() => writer.generateCsvReport(report), /rows do not match/)
})

test('CSV writer bundles for a browser without a filesystem or conversion service', async () => {
  const built = await build({
    entryPoints: ['src/services/analysisReports/csv.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
  })
  assert.ok(built.outputFiles[0].contents.length > 100)
})

test('document weight labels remain readable without concealing approximation or changing saved numbers', () => {
  assert.equal(model.formatReportWeight(50), '50%')
  assert.equal(model.formatReportWeight(0), '0%')
  assert.equal(model.formatReportWeight(100 / 3), '~33.33%')
  assert.equal(model.formatReportWeight(0.001), '<0.01%')
  assert.throws(() => model.formatReportWeight(Number.NaN), /invalid weight/)
  const input = realReportFixture({ criterionCount: 3 })
  const report = model.buildAnalysisReport(input)
  assert.equal(report.groups[0].target.criteria[0].weight, 100 / 3)
  assert.ok(records(writer.generateCsvReport(report)).headers[2].includes(`${100 / 3}%`))
})
