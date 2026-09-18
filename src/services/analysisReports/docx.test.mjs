import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { SaxesParser } from 'saxes'
import yauzl from 'yauzl'
import {
  loadReportFoundation, realReportFixture, reportFixtureCitation, REPORT_TEST_TIMESTAMP,
} from './test-support.mjs'

let foundation, writer, cleanup
const output = resolve(`.analysis-report-docx-tests-${randomUUID()}`)
const entry = `
  export { generateDocxReport } from './src/services/analysisReports/docx';
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
            entries.set(entry.fileName, Buffer.concat(chunks).toString('utf8'))
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
  const root = { name: '#document', attributes: {}, children: [] }
  const stack = [root]
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
  if (node.name === 'w:t') return node.children.join('')
  if (node.name === 'w:tab') return '\t'
  if (node.name === 'w:br') return '\n'
  return node.children.map(inlineText).join('')
}

function textContent(node) {
  return all(node, 'w:p').map(inlineText).join('\n')
}

function normalizeLines(value) {
  return value.replace(/\r\n|\r/g, '\n')
}

function containsText(node, expected) {
  assert.ok(textContent(node).includes(normalizeLines(expected)), `Missing exact text: ${JSON.stringify(expected.slice(0, 150))}`)
}

function reviewSections(document) {
  const body = all(document, 'w:body')[0]
  const sections = new Map()
  let current
  for (const node of body.children) {
    const mark = all(node, 'w:bookmarkStart').find(bookmark => bookmark.attributes['w:name']?.startsWith('review_'))
    if (mark) {
      current = { name: '#review', attributes: {}, children: [] }
      sections.set(mark.attributes['w:name'], current)
    }
    if (current) current.children.push(node)
  }
  return sections
}

async function generate(report) {
  const bytes = await writer.generateDocxReport(report)
  assert.ok(bytes instanceof Uint8Array)
  assert.ok(bytes.length > 1000 && bytes.length <= writer.REPORT_LIMITS.maxOutputBytes)
  assert.equal(Buffer.from(bytes.slice(0, 2)).toString(), 'PK')
  const entries = await unzip(bytes)
  for (const filename of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) {
    assert.ok(entries.has(filename), `Missing OOXML part ${filename}`)
  }
  const parts = new Map([...entries].filter(([name]) => /\.(xml|rels)$/.test(name)).map(([name, xml]) => [name, parseXml(xml, name)]))
  return { bytes, entries, parts, document: parts.get('word/document.xml') }
}

function assertFullDetail(section, target, comparison) {
  for (const expected of [
    foundation.candidateName(comparison.candidate), comparison.candidate.id, comparison.id,
    comparison.candidate.sourceLabel, comparison.candidate.documentId, target.id, target.label,
    target.versionLabel, target.rubricId, foundation.overallScoreLabel(comparison.overall),
  ]) containsText(section, expected)
  for (const snapshot of [target.snapshot, comparison.candidate.snapshot]) {
    if (snapshot) {
      containsText(section, snapshot.snapshotId)
      containsText(section, snapshot.sha256)
    }
  }
  for (const [key, value] of Object.entries(target.selection ?? {})) {
    if (key !== 'kind' && typeof value === 'string') containsText(section, value)
  }
  if (comparison.candidate.documentSha256) containsText(section, comparison.candidate.documentSha256)
  if (comparison.resultSha256) containsText(section, comparison.resultSha256)
  if (comparison.status !== 'complete') return
  containsText(section, comparison.summary)
  for (const definition of target.criteria) {
    for (const expected of [definition.id, definition.label, definition.description, definition.guidance]) containsText(section, expected)
  }
  for (const assessment of [...comparison.criteria, ...comparison.qualifications]) {
    containsText(section, assessment.rationale)
    for (const citation of [...assessment.citations, ...assessment.requirementCitations]) {
      containsText(section, citation.quote)
      containsText(section, citation.locator)
    }
    if (assessment.limitation) containsText(section, assessment.limitation.message)
  }
  for (const qualification of comparison.qualifications) {
    containsText(section, qualification.text)
    containsText(section, qualification.interpretation)
  }
  for (const value of comparison.limitations) containsText(section, value.message)
  for (const fact of [...target.facts, ...comparison.provenance]) containsText(section, fact.value)
}

test('editable Word package preserves all candidates, counts, saved scores, and frozen detail', async () => {
  const input = realReportFixture({ scores: [92.75, 87, 82, 75, 62, 43], targetCount: 2 })
  input.comparisons[1].overall.score = 12
  input.comparisons[3].overall.score = 99
  input.comparisons[5].overall.score = 44
  for (const item of input.comparisons) {
    if (item.candidate.id === 'candidate-2') item.candidate.name = 'Candidate 1'
    item.summary = `Complete saved assessment for ${item.id}. ${'Its original evidence is retained. '.repeat(16)}End of saved assessment ${item.id}.`
  }
  const report = foundation.buildAnalysisReport(input)
  const before = JSON.stringify(report)
  const { document, parts, entries } = await generate(report)
  assert.equal(JSON.stringify(report), before)
  containsText(document, '6 candidates · 12 comparisons · 2 exact targets')
  for (const expected of [
    report.run.id, report.run.name, report.run.createdAt, report.capture.startedAt, report.capture.completedAt,
    report.generatedAt, report.workspaceId, foundation.REPORT_HUMAN_REVIEW_NOTICE, foundation.REPORT_CAPTURE_NOTICE,
  ]) containsText(document, expected)
  const sections = reviewSections(document)
  assert.equal(sections.size, report.counts.total)
  for (const group of report.groups) {
    for (const comparison of group.comparisons) assertFullDetail(sections.get(`review_${comparison.index}`), group.target, comparison)
  }
  const tables = all(document, 'w:tbl')
  for (let groupIndex = 0; groupIndex < report.groups.length; groupIndex++) {
    const group = report.groups[groupIndex]
    const rows = all(tables[groupIndex], 'w:tr').slice(1)
    const highlighted = group.comparisons.filter(item => item.highlighted)
    assert.equal(rows.length, group.highlightedComparisonIds.length)
    assert.deepEqual(rows.map(row => all(row, 'w:tc').map(textContent)), highlighted.map(item => [
      String(item.rank),
      `${foundation.candidateName(item.candidate)}\n${item.candidate.role}\nCandidate ID: ${item.candidate.id}`,
      foundation.overallScoreLabel(item.overall),
    ]))
  }
  containsText(document, '[excerpt]')
  for (const part of parts.values()) {
    assert.equal(all(part, 'w:drawing').length, 0)
    assert.equal(all(part, 'w:pict').length, 0)
    assert.equal(all(part, 'w:documentProtection').length, 0)
  }
  assert.ok(![...entries.keys()].some(name => /(^word\/media\/|embeddings\/)/.test(name)))
})

test('summary ordering, ranks, highlight membership, and capped ties come from the shared model', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [100, 99, 98, 97, ...Array(12).fill(80), 70] }))
  const group = report.groups[0]
  const { document } = await generate(report)
  containsText(document, foundation.highlightNotice(group))
  containsText(document, '6 additional candidates tied at 80 / 100')
  assert.equal(all(all(document, 'w:tbl')[0], 'w:tr').length, group.highlightedComparisonIds.length + 1)
  assert.equal(reviewSections(document).size, 17)
  assert.deepEqual(
    all(all(document, 'w:tbl')[0], 'w:tr').slice(1).map(row => textContent(all(row, 'w:tc')[0])),
    group.comparisons.filter(item => item.highlighted).map(item => String(item.rank)),
  )
  const direct = foundation.buildAnalysisReport(realReportFixture({ scores: [90, 80, 70] }))
  const directGroup = direct.groups[0]
  directGroup.comparisons.reverse()
  directGroup.comparisons.forEach(item => { item.highlighted = item.id === 'comparison-2'; item.rank = 42 })
  directGroup.highlightedComparisonIds = ['comparison-2']
  directGroup.cutoffScore = 70
  const { document: consumed } = await generate(direct)
  const rows = all(all(consumed, 'w:tbl')[0], 'w:tr')
  assert.equal(rows.length, 2)
  containsText(rows[1], 'Candidate 2')
  assert.equal(textContent(all(rows[1], 'w:tc')[0]), '42')
  assert.deepEqual([...reviewSections(consumed).keys()], ['review_2', 'review_1', 'review_0'])
})

test('zero, withheld, excluded, and unfinished states never become fictitious assessments', async () => {
  const input = realReportFixture({
    scores: [0, null, 10, 20, 30, 40], statuses: ['complete', 'complete', 'queued', 'running', 'failed', 'cancelled'],
  })
  for (const assessment of input.comparisons[0].criteria) {
    assessment.score = 0
    assessment.evidenceStatus = 'missing'
    assessment.citations = []
  }
  input.comparisons[0].coverage.supported = 0
  input.comparisons[0].coverage.missing = 2
  const report = foundation.buildAnalysisReport(input)
  const { document, parts } = await generate(report)
  containsText(document, foundation.reportStatusNotice(report.counts))
  containsText(document, 'PARTIAL REPORT')
  const sections = reviewSections(document)
  const zero = sections.get('review_0')
  containsText(zero, '0 / 100')
  containsText(zero, '0 / 5')
  containsText(zero, 'Missing evidence')
  const withheld = sections.get('review_1')
  containsText(withheld, 'Withheld — Weighted criteria were not assessed.')
  containsText(withheld, 'unassessed-weighted-criteria')
  containsText(withheld, 'Not assessed')
  assert.ok(!all(withheld, 'w:p').some(node => /^(Overall score: )?0 \/ 100$/.test(inlineText(node))))
  assert.ok(!textContent(withheld).includes('0 / 5'))
  for (const comparison of report.groups[0].comparisons.filter(item => item.status !== 'complete')) {
    const section = sections.get(`review_${comparison.index}`)
    containsText(section, `Status: ${foundation.comparisonStatusLabel(comparison.status)}`)
    containsText(section, 'No completed assessment was captured')
    assert.equal(all(section, 'w:tbl').length, 0)
    assert.ok(!textContent(section).includes('0 / 100'))
    assert.ok(!textContent(section).includes('Full saved overall assessment'))
    assert.ok(!textContent(section).includes('Saved rationale'))
  }
  containsText(sections.get('review_4'), input.comparisons[4].error.message)
  containsText(sections.get('review_4'), 'Processing stage: assessment')
  containsText(sections.get('review_4'), 'Retryable: Yes')
  const header = [...parts].find(([name]) => /^word\/header\d+\.xml$/.test(name))[1]
  containsText(header, 'PARTIAL REPORT')

  const allWithheld = foundation.buildAnalysisReport(realReportFixture({ scores: [null, null] }))
  const { document: noScores } = await generate(allWithheld)
  containsText(noScores, 'No scored highlights are available')
  assert.equal(all(noScores, 'w:tbl').length, 2)
  assert.ok(!all(noScores, 'w:p').some(node => /^(Overall score: )?0 \/ 100$/.test(inlineText(node))))
})

test('GS qualification text, interpretation, evidence, and limitations remain separate and unscored', async () => {
  const input = realReportFixture({ scores: [null], kind: 'grade', criterionCount: 5 })
  const item = input.comparisons[0]
  const weights = [30, 20, 40, 10, 0]
  const statuses = ['supported', 'partial', 'missing', 'not-assessed', 'not-applicable']
  item.criteria.forEach((criterion, index) => {
    input.targets[0].criteria[index].weight = weights[index]
    Object.assign(criterion, {
      weight: weights[index], evidenceStatus: statuses[index], score: [3, 2, 0, null, null][index],
      citations: index < 2 ? [reportFixtureCitation(item.candidate.documentId)] : [],
      limitation: index === 3 ? { code: 'frozen-gap', message: 'Saved assessment limitation; do not infer missing coverage.', criterionId: criterion.criterionId } : null,
    })
  })
  item.coverage = {
    totalCriteria: 5, supported: 1, partial: 1, missing: 1, notAssessed: 1, notApplicable: 1, assessedWeight: 90, totalWeight: 100,
  }
  item.qualifications = [{
    qualificationId: 'gs-specialized-experience', text: 'Frozen GS qualification <specialized experience> & responsibility.',
    interpretation: 'Saved interpretation.\nSeparately review one year of specialized experience.',
    support: 'derived', evidenceStatus: 'partial', rationale: 'Exact saved GS rationale; this does not assign numeric points.',
    citations: [reportFixtureCitation(item.candidate.documentId, { quote: 'GS resume quote — exact, not rewritten.' })],
    requirementCitations: [reportFixtureCitation('gs-reference', { quote: 'Exact GS standard quotation.', pagination: 'pdf-pages', page: 178 })],
    limitation: { code: 'human-review', message: 'Duration still requires qualified review.', qualificationId: 'gs-specialized-experience' },
  }]
  item.limitations = [{ code: 'saved-overall-limit', message: 'Overall limitation stays in the saved report.', criterionId: 'criterion-3' }]
  const report = foundation.buildAnalysisReport(input)
  const { document } = await generate(report)
  const section = reviewSections(document).get('review_0')
  assertFullDetail(section, report.groups[0].target, report.groups[0].comparisons[0])
  for (const expected of ['Not applicable (excluded)', '0%', '0 / 5', 'Assessed weight / total weight: 90 / 100', 'PDF page 178']) containsText(section, expected)
  const content = textContent(section)
  const qualification = content.slice(content.indexOf('GS qualifications — separate, unscored human review'))
  assert.ok(qualification.includes(item.qualifications[0].text))
  assert.ok(qualification.includes('Source support: derived'))
  assert.ok(!/\b\d+ \/ (5|100)\b/.test(qualification), 'Qualification review must not introduce a numeric score')
  for (const criterionTable of all(section, 'w:tbl')) {
    assert.ok(!textContent(criterionTable).includes(item.qualifications[0].text))
  }
})

test('Unicode, XML metacharacters, multiline quotations, tabs, and original source locators survive OOXML escaping', async () => {
  const input = realReportFixture({ scores: [92.75] })
  const comparison = input.comparisons[0]
  comparison.candidate.name = 'Zoë <Sánchez> & "李" — Кириллица 😀'
  comparison.summary = 'Résumé & <scope> "quoted".\r\nSecond saved line.\n\nFinal line with a\ttab.'
  const quote = '  Exact <C++> & "SQL" résumé 😀\r\n\n\tSecond line: naïve Ω 李.\nTrailing spaces stay.  '
  comparison.criteria[0].citations = [reportFixtureCitation(comparison.candidate.documentId, {
    quote, sourceTitle: 'Résumé & <source>.docx', heading: '"Original" & immutable', pagination: 'captured-sections',
  })]
  comparison.criteria[0].requirementCitations = [
    reportFixtureCitation('requirement-target-0', { quote: 'Frozen <required> & quoted.\nSecond source line.', pagination: 'markdown-sections' }),
    reportFixtureCitation('requirement-target-0', { quote: 'Exact HTML capture.', pagination: 'html-sections' }),
    reportFixtureCitation('requirement-target-0', { quote: 'Printed PDF passage.', pagination: 'pdf-pages', page: 178 }),
  ]
  input.targets[0].criteria[0].guidance = 'Frozen <guidance> & score anchors.\n0: No evidence.\n5: Sustained ownership.'
  const report = foundation.buildAnalysisReport(input)
  input.targets[0].criteria[0].guidance = 'Live guidance must never replace the frozen guidance.'
  input.comparisons[0].criteria[0].citations[0].quote = 'Live replacement must not appear.'
  const { document, entries } = await generate(report)
  const section = reviewSections(document).get('review_0')
  assertFullDetail(section, report.groups[0].target, report.groups[0].comparisons[0])
  containsText(section, quote)
  containsText(section, comparison.summary)
  containsText(section, 'Captured source section 3 (not a printed page)')
  containsText(section, 'Markdown section 3')
  containsText(section, 'Captured HTML section 3')
  containsText(section, 'PDF page 178')
  assert.ok(!textContent(document).includes('Live replacement'))
  assert.ok(!textContent(document).includes('Live guidance'))
  assert.match(entries.get('word/document.xml'), /&lt;C\+\+&gt; &amp;/)
  assert.ok(all(document, 'w:tab').length > 0)
  assert.ok(all(document, 'w:t').some(node => node.attributes['xml:space'] === 'preserve' && node.children.join('').startsWith('  Exact')))
})

test('long full assessments and many criteria/citations flow without clipping or excerpting details', async () => {
  const input = realReportFixture({ scores: [89], criterionCount: 20 })
  const comparison = input.comparisons[0]
  comparison.summary = `${'Full saved assessment line.\n'.repeat(300)}UNIQUE FULL ASSESSMENT END`
  for (const [index, criterion] of comparison.criteria.entries()) {
    criterion.rationale = `${index}: ${'Detailed saved rationale is not shortened. '.repeat(35)}END RATIONALE ${index}`
    criterion.citations = Array.from({ length: 3 }, (_, citation) => reportFixtureCitation(comparison.candidate.documentId, {
      paragraphId: `criterion-${index}-passage-${citation}`, quote: `${'Exact evidence text.\n'.repeat(45)}END QUOTE ${index}-${citation}`,
    }))
    criterion.requirementCitations[0].quote = `${'Full frozen requirement wording. '.repeat(30)}END REQUIREMENT ${index}`
  }
  const report = foundation.buildAnalysisReport(input)
  const { document } = await generate(report)
  const section = reviewSections(document).get('review_0')
  assertFullDetail(section, report.groups[0].target, report.groups[0].comparisons[0])
  assert.ok(!textContent(section).includes('[excerpt]'))
  assert.equal(all(all(section, 'w:tbl')[0], 'w:tr').length, 21)
  assert.equal(all(document, 'w:trHeight').length, 0)
  assert.equal(all(document, 'w:txbxContent').length, 0)
})

test('fractional weights fit readable cells with shared display labels, explicit approximation notes, and unchanged scores', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [92.7525], criterionCount: 3 }))
  const before = JSON.stringify(report)
  const { document } = await generate(report)
  const section = reviewSections(document).get('review_0')
  const scoreTable = all(section, 'w:tbl')[0]
  const rows = all(scoreTable, 'w:tr').slice(1)
  assert.deepEqual(rows.map(row => textContent(all(row, 'w:tc')[1])), Array(3).fill('~33.33%'))
  assert.equal(all(scoreTable, 'w:gridCol')[1].attributes['w:w'], '1320')
  containsText(section, 'Weight / requirement: ~33.33%')
  containsText(section, '~ marks display-rounded criterion weights')
  containsText(section, 'Saved scores and weight totals are unchanged.')
  containsText(section, '92.7525 / 100')
  assert.ok(!textContent(document).includes('33.333333333333336%'))
  assert.equal(JSON.stringify(report), before)

  const tiny = realReportFixture({ scores: [89], criterionCount: 3 })
  const weights = [0, 50, 0.005]
  tiny.targets[0].criteria.forEach((criterion, index) => { criterion.weight = weights[index] })
  tiny.comparisons[0].criteria.forEach((criterion, index) => { criterion.weight = weights[index] })
  tiny.comparisons[0].coverage.assessedWeight = 50.005
  tiny.comparisons[0].coverage.totalWeight = 50.005
  const tinyReport = foundation.buildAnalysisReport(tiny)
  const { document: tinyDocument } = await generate(tinyReport)
  const tinySection = reviewSections(tinyDocument).get('review_0')
  assert.deepEqual(
    all(all(tinySection, 'w:tbl')[0], 'w:tr').slice(1).map(row => textContent(all(row, 'w:tc')[1])),
    ['0%', '50%', '<0.01%'],
  )
  containsText(tinySection, '<0.01% denotes a smaller nonzero weight')
  const { document: exactDocument } = await generate(foundation.buildAnalysisReport(realReportFixture({ scores: [89] })))
  assert.ok(!textContent(exactDocument).includes('~ marks display-rounded'))
})

test('compact provenance retains every unique frozen identity and exact fact without duplicating selection fields', async () => {
  for (const kind of ['job', 'grade']) {
    const input = realReportFixture({ scores: [92.75], kind, criterionCount: 3 })
    const target = input.targets[0]
    const comparison = input.comparisons[0]
    if (kind === 'job') {
      target.selection.rubricHash = 'b'.repeat(64)
      target.selection.documentSha256 = 'c'.repeat(64)
      target.facts.push(
        { label: 'Rubric SHA-256', value: target.selection.rubricHash },
        { label: 'Requirement document SHA-256', value: target.selection.documentSha256 },
      )
    } else {
      target.selection.versionHash = 'b'.repeat(64)
      target.selection.sourceSetHash = 'c'.repeat(64)
      target.facts.push(
        { label: 'Grade version SHA-256', value: target.selection.versionHash },
        { label: 'Approval ID', value: target.selection.approvalId },
        { label: 'Grade grounding review ID', value: target.selection.reviewId },
        { label: 'Frozen source set ID', value: target.selection.sourceSetId },
        { label: 'Frozen source set SHA-256', value: target.selection.sourceSetHash },
      )
    }
    target.snapshot.sha256 = 'd'.repeat(64)
    comparison.candidate.documentSha256 = 'e'.repeat(64)
    comparison.candidate.snapshot.sha256 = 'f'.repeat(64)
    comparison.resultSha256 = '1'.repeat(64)
    target.facts.push({ label: 'Exact audit note', value: 'Original <saved> provenance & detail.\nSecond line retains its exact words.' })
    const report = foundation.buildAnalysisReport(input)
    const { document } = await generate(report)
    const section = reviewSections(document).get('review_0')
    assertFullDetail(section, report.groups[0].target, report.groups[0].comparisons[0])
    const compact = all(section, 'w:p').filter(node => all(node, 'w:pStyle').some(style => style.attributes['w:val'] === 'ReportProvenance'))
    assert.ok(compact.length <= 16, 'Provenance should use concise labelled paragraphs, not label/value pairs and a raw selection dump')
    for (const fact of [...target.facts, ...comparison.provenance]) {
      assert.ok(compact.some(node => inlineText(node).includes(`${fact.label}: ${normalizeLines(fact.value)}`)))
    }
    const provenance = compact.map(inlineText).join('\n')
    for (const hash of ['b'.repeat(64), 'c'.repeat(64)]) assert.equal(provenance.split(hash).length - 1, 1, 'Exact identity facts must not be duplicated by selection metadata')
    assert.ok(!provenance.includes('rubricVersion:'))
    assert.ok(!provenance.includes('kind:'))
    assert.ok(!textContent(section).includes('Frozen target selection'))
  }
})

test('page starts, US Letter geometry, readable built-in styles, repeating table headers, and dual DXA widths are explicit', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({ targetCount: 2 }))
  const { document, parts } = await generate(report)
  const size = all(document, 'w:pgSz')[0].attributes
  assert.equal(size['w:w'], '12240')
  assert.equal(size['w:h'], '15840')
  const margin = all(document, 'w:pgMar')[0].attributes
  for (const side of ['top', 'bottom', 'left', 'right']) assert.equal(margin[`w:${side}`], '1440')
  const sections = all(document, 'w:sectPr')
  assert.equal(sections.length, report.counts.total + 1)
  for (const section of sections.slice(1)) assert.equal(all(section, 'w:type')[0].attributes['w:val'], 'nextPage')
  assert.ok(all(document, 'w:pgNumType').every(node => node.attributes['w:start'] === undefined), 'Page numbers must continue across candidate sections')
  const pageStarts = all(document, 'w:p').filter(p => all(p, 'w:pageBreakBefore').some(mark => mark.attributes['w:val'] !== 'false'))
  assert.equal(pageStarts.length, report.groups.length)
  for (const start of pageStarts) {
    assert.ok(inlineText(start).trim().length > 0, 'Page breaks must start real headings, not empty pages')
    assert.equal(all(start, 'w:pStyle')[0].attributes['w:val'], 'Heading1')
  }
  for (const section of reviewSections(document).values()) {
    assert.equal(all(section.children[0], 'w:pageBreakBefore').length, 0, 'Section page starts must not be doubled by paragraph page breaks')
  }
  for (const grid of all(document, 'w:tbl')) {
    const width = all(grid, 'w:tblW')[0].attributes
    assert.equal(width['w:type'], 'dxa')
    assert.equal(width['w:w'], '9360')
    assert.equal(all(grid, 'w:tblLayout')[0].attributes['w:type'], 'fixed')
    const columns = all(grid, 'w:gridCol').map(node => Number(node.attributes['w:w']))
    assert.equal(columns.reduce((sum, value) => sum + value, 0), 9360)
    const rows = all(grid, 'w:tr')
    assert.equal(all(rows[0], 'w:tblHeader').length, 1)
    assert.equal(all(grid, 'w:tblHeader').length, 1)
    for (const row of rows) {
      for (const [index, cell] of all(row, 'w:tc').entries()) {
        const cellWidth = all(cell, 'w:tcW')[0].attributes
        assert.equal(cellWidth['w:type'], 'dxa')
        assert.equal(Number(cellWidth['w:w']), columns[index])
        assert.ok(all(cell, 'w:tcMar').length > 0)
      }
    }
  }
  const styleNodes = all(parts.get('word/styles.xml'), 'w:style')
  assert.equal(new Set(styleNodes.map(node => node.attributes['w:styleId'])).size, styleNodes.length, 'Style IDs must be unique')
  for (const level of [1, 2, 3]) {
    const style = styleNodes.find(node => node.attributes['w:styleId'] === `Heading${level}`)
    assert.ok(style, `Built-in Heading${level} must be styled`)
    assert.equal(all(style, 'w:outlineLvl')[0].attributes['w:val'], String(level - 1))
    assert.ok(all(style, 'w:keepNext').length > 0)
  }
  for (const part of parts.values()) {
    for (const fontSize of all(part, 'w:sz')) assert.ok(Number(fontSize.attributes['w:val']) >= 20, 'No text below 10 pt')
  }
  const header = [...parts].find(([name]) => /^word\/header\d+\.xml$/.test(name))[1]
  const footer = [...parts].find(([name]) => /^word\/footer\d+\.xml$/.test(name))[1]
  containsText(header, 'SCORE')
  containsText(footer, 'Human review required')
  const instructions = all(footer, 'w:instrText').flatMap(node => node.children).join(' ')
  assert.match(instructions, /\bPAGE\b/)
  assert.match(instructions, /\bNUMPAGES\b/)
  const bookmarks = new Set(all(document, 'w:bookmarkStart').map(mark => mark.attributes['w:name']))
  for (const link of all(document, 'w:hyperlink')) assert.ok(bookmarks.has(link.attributes['w:anchor']))
})

test('every candidate section has a bounded, readable continuation header identifying the candidate and target', async () => {
  const input = realReportFixture({ scores: [90, 80], targetCount: 2 })
  input.comparisons.filter(item => item.candidate.id === 'candidate-1').forEach(item => {
    item.candidate.name = `Long candidate name ${'W'.repeat(80)}\nFull saved name ends here`
  })
  input.targets[1].label = `Long target ${'W'.repeat(80)}\nFull saved target ends here`
  const report = foundation.buildAnalysisReport(input)
  const { document, parts } = await generate(report)
  const relationships = new Map(all(parts.get('word/_rels/document.xml.rels'), 'Relationship').map(node => [
    node.attributes.Id, node.attributes.Target,
  ]))
  const sectionProperties = all(document, 'w:sectPr')
  let sectionIndex = 1
  for (const group of report.groups) {
    for (const comparison of group.comparisons) {
      const properties = sectionProperties[sectionIndex++]
      const reference = all(properties, 'w:headerReference').find(node => node.attributes['w:type'] === 'default')
      const header = parts.get(`word/${relationships.get(reference.attributes['r:id'])}`)
      assert.ok(header, 'Each review needs its own default header for every continuation page')
      const name = foundation.summaryExcerpt(foundation.candidateName(comparison.candidate).replace(/\s+/g, ' '), 36).text
      const target = foundation.summaryExcerpt(group.target.label.replace(/\s+/g, ' '), 40).text
      containsText(header, `Review ${comparison.index + 1}: ${name}`)
      containsText(header, `Target: ${target}`)
      containsText(header, 'SAVED ANALYSIS')
      assert.equal(all(header, 'w:p').length, 3)
      assert.ok(all(header, 'w:p').every(node => all(node, 'w:br').length === 0), 'Source newlines must not expand the running header')
      const review = reviewSections(document).get(`review_${comparison.index}`)
      containsText(review, foundation.candidateName(comparison.candidate))
      containsText(review, group.target.label)
    }
  }
  assert.equal(all(document, 'w:footerReference').length, 1, 'Candidate sections inherit the continuous report footer')
})

test('fictional sample notices and human-review guidance are visible in body and running header', async () => {
  const run = foundation.createInitialWorkspace().runs[0]
  const report = foundation.buildSampleAnalysisReport(run, { generatedAt: REPORT_TEST_TIMESTAMP })
  const { document, parts } = await generate(report)
  containsText(document, foundation.REPORT_SAMPLE_NOTICE)
  containsText(document, foundation.REPORT_HUMAN_REVIEW_NOTICE)
  containsText(document, foundation.reportTitle(report))
  containsText(document, `${report.candidateCount} candidates`)
  const header = [...parts].find(([name]) => /^word\/header\d+\.xml$/.test(name))[1]
  containsText(header, 'FICTIONAL SAMPLE')
  assert.equal(reviewSections(document).size, report.counts.total)
  for (const group of report.groups) {
    for (const comparison of group.comparisons) assertFullDetail(reviewSections(document).get(`review_${comparison.index}`), group.target, comparison)
  }
})

test('the 500-comparison report limit is supported without silently dropping candidates', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: Array.from({ length: 500 }, (_, index) => index % 101), criterionCount: 1 }))
  const { document } = await generate(report)
  containsText(document, '500 candidates · 500 comparisons · 1 exact target')
  const sections = reviewSections(document)
  assert.equal(sections.size, 500)
  for (const comparison of report.groups[0].comparisons) {
    const section = sections.get(`review_${comparison.index}`)
    containsText(section, `Candidate ID: ${comparison.candidate.id}`)
    containsText(section, `Comparison ID: ${comparison.id}`)
    containsText(section, foundation.overallScoreLabel(comparison.overall))
  }
})

test('XML-invalid controls and lone surrogates are rejected explicitly rather than dropped or corrupting the ZIP', async () => {
  for (const invalid of ['\0', '\u0001', '\u000B', '\u000C', '\u001F', '\uFFFE', '\uFFFF', '\uD800', '\uDC00']) {
    const report = foundation.buildAnalysisReport(realReportFixture({ scores: [90] }))
    report.groups[0].comparisons[0].criteria[0].citations[0].quote += invalid
    await assert.rejects(writer.generateDocxReport(report), /XML-invalid character \(U\+[0-9A-F]+\).*cannot be generated safely/)
  }
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [90] }))
  report.groups[0].target.facts[0].value += '\u0002'
  await assert.rejects(writer.generateDocxReport(report), /XML-invalid character/)
})

test('output byte limit rejects the actual complete package with an actionable message', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [90] }))
  const originalLimit = writer.REPORT_LIMITS.maxOutputBytes
  try {
    writer.REPORT_LIMITS.maxOutputBytes = 100
    await assert.rejects(writer.generateDocxReport(report), /Word report exceeds the output size limit.*Narrow the export.*no comparisons or evidence have been omitted/)
  } finally {
    writer.REPORT_LIMITS.maxOutputBytes = originalLimit
  }
})

test('browser bundle emits a real readable DOCX Blob without Node globals, filesystem access, or conversion services', async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: entry },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'DocxReport',
    metafile: true, logLevel: 'silent',
  })
  for (const output of Object.values(bundle.metafile.outputs)) {
    assert.ok(!output.imports.some(item => item.external), 'Browser bundle must not need Node/external modules')
  }
  const sandbox = { Blob, TextEncoder, TextDecoder, setTimeout, clearTimeout, console }
  runInNewContext(`${bundle.outputFiles[0].text}\nglobalThis.reportWriter = DocxReport`, sandbox)
  assert.equal(sandbox.Buffer, undefined)
  assert.equal(sandbox.process, undefined)
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [92.75] }))
  const bytes = await sandbox.reportWriter.generateDocxReport(report)
  const blob = new Blob([bytes], { type: foundation.REPORT_FORMATS.docx.mimeType })
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.ok(blob.size > 1000)
  const entries = await unzip(new Uint8Array(await blob.arrayBuffer()))
  for (const [name, xml] of entries) if (/\.(xml|rels)$/.test(name)) parseXml(xml, name)
  const document = parseXml(entries.get('word/document.xml'), 'word/document.xml')
  containsText(document, '92.75 / 100')
  containsText(document, 'Candidate 0')
})
