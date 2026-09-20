import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadReportFoundation, realReportFixture, version2ReportFixture } from './test-support.mjs'

const output = resolve(`.csv-report-tests-${randomUUID()}`)
let foundation, writer, model
const options = { links: { origin: 'https://score.example', workspaceId: 'workspace-one' } }

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

test('v2 manual summaries do not change the existing CSV assessment, scores or columns', () => {
  const input = version2ReportFixture({ long: true })
  const legacy = structuredClone(input)
  delete legacy.capture.summaries
  legacy.targets.forEach(target => { delete target.narrative })
  legacy.comparisons.forEach(comparison => { delete comparison.narrative })
  const current = writer.generateCsvReport(model.buildAnalysisReport(input), options)
  const baseline = writer.generateCsvReport(model.buildAnalysisReport(legacy), options)
  assert.deepEqual(current, baseline)
  assert.doesNotMatch(Buffer.from(current).toString('utf8'), /Manually approved|Known issue|Saved overview/)
})

test('custom labels get separate CSV columns without replacing source identity or saved scores', () => {
  const input = realReportFixture({ scores: [92.75] })
  input.run.name = 'Renamed analysis'
  input.targets[0].displayName = 'Custom target'
  input.comparisons[0].candidate.displayName = '=Custom label'
  const report = model.buildAnalysisReport(input)
  const original = JSON.stringify(report)
  const result = records(writer.generateCsvReport(report, options))
  assert.equal(result.headers.length, 13)
  assert.deepEqual(result.headers.slice(-2), ['Candidate display label', 'Job/grade display title'])
  const row = result.records[0]
  assert.equal(row['Candidate name'], input.comparisons[0].candidate.name)
  assert.equal(row['Job/grade'], input.targets[0].label)
  assert.equal(row['Candidate display label'], "'=Custom label")
  assert.equal(row['Job/grade display title'], 'Custom target')
  assert.equal(row.Source, input.comparisons[0].candidate.sourceLabel)
  assert.equal(row['Overall score'], '92.75')
  assert.deepEqual([row.C1, row.C2], ['3', '3'])
  assert.equal(new URL(row['Analysis link']).searchParams.get('result'), 'comparison-0')
  assert.equal(model.safeReportFilename(report.run.name, 'csv'), 'Renamed analysis.csv')
  assert.equal(JSON.stringify(report), original)
})

test('mixed captured aliases append only two columns and leave canonical target disambiguation unchanged', () => {
  const input = realReportFixture({ scores: [80, 70], targetCount: 2 })
  input.targets[0].displayName = '+Reviewer target'
  for (const comparison of input.comparisons.filter(item => item.candidate.id === 'candidate-0')) {
    comparison.candidate.name = null
    comparison.candidate.displayName = 'Captured resume label'
  }
  const result = records(writer.generateCsvReport(model.buildAnalysisReport(input), options))
  assert.equal(result.headers.length, 13)
  assert.equal(result.records[0]['Candidate name'], input.comparisons[0].candidate.sourceLabel)
  assert.equal(result.records[0]['Candidate display label'], 'Captured resume label')
  assert.equal(result.records[1]['Candidate display label'], '')
  assert.equal(result.records[0]['Job/grade display title'], "'+Reviewer target")
  assert.equal(result.records[2]['Job/grade display title'], '')
  assert.equal(result.records[0]['Job/grade'], `${input.targets[0].label} (Job 1)`)
  assert.equal(result.records[2]['Job/grade'], `${input.targets[1].label} (Job 2)`)
  assert.ok(!result.headers.some(header => /rank|cutoff|hash|\bID\b|coverage|notice/i.test(header)))
})

test('CSV uses the compact reader-facing schema and round-trips quoted Unicode source text', () => {
  const input = realReportFixture()
  input.comparisons[0].candidate.name = 'Zoë, "Jordan" Кириллица'
  input.comparisons[0].candidate.sourceLabel = 'Résumé, "original".pdf\r\nCaptured source: café Ω.'
  input.comparisons[0].summary = 'Analyzed survey data with R and explained findings to project teams.'
  input.comparisons[0].criteria[0].rationale = 'Built an R workflow to analyze survey responses.'
  input.comparisons[0].criteria[1].rationale = 'Presented survey findings to three project teams.'
  const report = model.buildAnalysisReport(input)
  const original = JSON.stringify(report)
  const bytes = writer.generateCsvReport(report, options)
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf])
  const result = records(bytes)
  assert.deepEqual(result.headers, [
    'Candidate name', 'Job/grade', 'Overall score', 'Overall assessment', 'C1', 'C2',
    'Analysis date', 'Source', 'Analysis link', 'Resume link', 'Job/grade link',
  ])
  assert.equal(result.records[0]['Candidate name'], input.comparisons[0].candidate.name)
  assert.equal(result.records[0].Source, input.comparisons[0].candidate.sourceLabel)
  assert.match(result.records[0]['Overall assessment'], /survey/)
  assert.ok(result.records[0]['Overall assessment'].length <= 300)
  assert.equal(result.records[0]['Overall score'], '92.75')
  assert.equal(result.records[0]['Analysis date'], 'Sep 18, 2026')
  assert.equal(result.rows.length, input.comparisons.length)
  assert.equal(JSON.stringify(report), original)
  const analysis = new URL(result.records[0]['Analysis link'])
  assert.equal(analysis.origin, options.links.origin)
  assert.equal(analysis.pathname, '/workspaces/workspace-one/analyses/run-one')
  assert.equal(analysis.searchParams.get('result'), 'comparison-0')
  assert.equal(analysis.searchParams.get('data'), 'real')
  assert.equal(new URL(result.records[0]['Resume link']).searchParams.get('view'), 'resume')
  assert.equal(new URL(result.records[0]['Job/grade link']).searchParams.get('view'), 'target')
})

test('different jobs reuse local criterion columns without merging targets or multiplying width', () => {
  const input = realReportFixture({ targetCount: 2 })
  const second = input.targets[1]
  second.criteria[0].weight = 40
  second.criteria[1].weight = 35
  second.criteria.push({ ...second.criteria[0], id: 'criterion-2', weight: 25 })
  for (const comparison of input.comparisons.filter(item => item.targetId === second.id)) {
    comparison.criteria[0].weight = 40
    comparison.criteria[1].weight = 35
    comparison.criteria.push({ ...comparison.criteria[0], criterionId: 'criterion-2', weight: 25, score: 4 })
    comparison.coverage.supported = 3
    comparison.coverage.totalCriteria = 3
  }
  const report = model.buildAnalysisReport(input)
  const result = records(writer.generateCsvReport(report, options))
  assert.equal(result.rows.length, 6)
  assert.equal(new Set(result.records.map(row => row['Analysis link'])).size, 6)
  assert.deepEqual(result.headers.filter(header => /^C\d+$/.test(header)), ['C1', 'C2', 'C3'])
  assert.deepEqual(result.rows[0].slice(4, 7), ['3', '3', ''])
  assert.deepEqual(result.rows[3].slice(4, 7), ['3', '3', '4'])
  assert.notEqual(result.records[0]['Job/grade'], result.records[3]['Job/grade'])
  assert.ok(result.records.every(row => !row['Job/grade'].includes('target-')))
})

test('CSV includes completed results only and preserves zero, withheld, N/A and not assessed', () => {
  const input = realReportFixture({ scores: [0, null, 30, 40], statuses: ['complete', 'complete', 'running', 'failed'] })
  for (const criterion of input.comparisons[0].criteria) {
    criterion.score = 0
    criterion.evidenceStatus = 'missing'
    criterion.citations = []
  }
  input.comparisons[0].coverage.supported = 0
  input.comparisons[0].coverage.missing = 2
  const result = records(writer.generateCsvReport(model.buildAnalysisReport(input), options))
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0]['Overall score'], '0')
  assert.equal(result.records[0].C1, '0')
  assert.equal(result.records[1]['Overall score'], '')
  assert.match(result.records[1]['Overall assessment'], /No overall score:.*not assessed/)
  assert.equal(result.records[1].C1, 'Not assessed')
  assert.ok(!result.headers.some(header => /status|availability|reason|partial|rank|cutoff|hash|\bID\b|coverage|notice/i.test(header)))
  assert.ok(result.records.every(row => !['comparison-2', 'comparison-3'].includes(new URL(row['Analysis link']).searchParams.get('result'))))

  const grade = realReportFixture({ scores: [80], kind: 'grade' })
  grade.targets[0].criteria[0].weight = 0
  grade.targets[0].criteria[1].weight = 100
  grade.comparisons[0].criteria[0] = { ...grade.comparisons[0].criteria[0], weight: 0, score: null, evidenceStatus: 'not-applicable', citations: [] }
  grade.comparisons[0].criteria[1].weight = 100
  grade.comparisons[0].coverage.supported = 1
  grade.comparisons[0].coverage.notApplicable = 1
  assert.equal(records(writer.generateCsvReport(model.buildAnalysisReport(grade), options)).records[0].C1, 'N/A')
})

test('all untrusted spreadsheet formula prefixes are neutralized, including whitespace and control prefixes', () => {
  const names = ['=1+2', '+1+2', '-1+2', '@SUM(A1)', ' \t=1+2', '\r=1+2', '\n=1+2', '\uFEFF=1+2', '\u200F=1+2', '\u0001=1+2', '\tordinary', '＝1+2']
  const input = realReportFixture({ scores: names.map(() => 80) })
  input.comparisons.forEach((comparison, index) => { comparison.candidate.name = names[index]; comparison.summary = `=Summary "${index}",\ncell` })
  input.targets[0].label = '+target formula'
  input.comparisons.forEach((comparison, index) => { comparison.candidate.sourceLabel = names[index] })
  const result = records(writer.generateCsvReport(model.buildAnalysisReport(input), options))
  for (const [index, record] of result.records.entries()) {
    const displayName = model.readableCandidateName(input.comparisons[index].candidate)
    assert.equal(record['Candidate name'], names[index] === '\tordinary' ? 'ordinary' : `'${displayName}`)
    assert.equal(record.Source, `'${names[index]}`)
    assert.equal(record['Overall score'], '80')
    assert.equal(record['Job/grade'], "'+target formula")
    assert.equal(record['Overall assessment'], `'=Summary "${index}", cell`)
  }
})

test('all 500 completed comparisons are exported without ranking and tie metadata', () => {
  const report = model.buildAnalysisReport(realReportFixture({ scores: Array(500).fill(80) }))
  const result = records(writer.generateCsvReport(report, options))
  assert.equal(result.records.length, 500)
  assert.equal(result.headers.length, 11)
  assert.ok(!result.headers.some(header => /rank|highlight|cutoff|ties/i.test(header)))
  assert.equal(new Set(result.records.map(row => row['Analysis link'])).size, 500)
})

test('sample CSV is explicitly fictional without a repeated metadata column', () => {
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
  const standalone = { links: { origin: 'http://localhost:5173' } }
  const result = records(writer.generateCsvReport(report, standalone))
  assert.equal(result.headers[0], 'Candidate name (fictional sample)')
  assert.ok(!result.headers.includes('Report data'))
  const link = new URL(result.records[0]['Analysis link'])
  assert.equal(link.pathname, '/analyses/run-one')
  assert.equal(link.searchParams.get('data'), 'samples')
})

test('inconsistent inventories and missing link context stop the CSV download', () => {
  const report = model.buildAnalysisReport(realReportFixture({ scores: [80] }))
  report.counts.total++
  assert.throws(() => writer.generateCsvReport(report, options), /rows do not match/)
  report.counts.total--
  report.counts.complete++
  assert.throws(() => writer.generateCsvReport(report, options), /rows do not match/)
  report.counts.complete--
  report.groups[0].counts.complete++
  assert.throws(() => writer.generateCsvReport(report, options), /rows do not match/)
  report.groups[0].counts.complete--
  assert.throws(() => writer.generateCsvReport(report), /link|origin/i)
  report.groups[0].comparisons[0].criteria.pop()
  assert.throws(() => writer.generateCsvReport(report, options), /criterion assessment is missing/)
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
  const original = JSON.stringify(report)
  assert.deepEqual(records(writer.generateCsvReport(report, options)).headers.slice(4, 7), ['C1', 'C2', 'C3'])
  assert.equal(JSON.stringify(report), original)
})
