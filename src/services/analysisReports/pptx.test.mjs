import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { fromBuffer } from 'yauzl'
import { SaxesParser } from 'saxes'
import fontkit from '@pdf-lib/fontkit'
import { loadReportFoundation, realReportFixture, reportFixtureCitation, REPORT_TEST_TIMESTAMP } from './test-support.mjs'

let foundation, api, cleanup, output
before(async () => {
  const loaded = await loadReportFoundation()
  foundation = loaded.api
  cleanup = loaded.cleanup
  output = resolve(`.analysis-report-pptx-tests-${randomUUID()}`)
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      export * from './src/services/analysisReports/pptx';
      export * from './src/services/analysisReports/pptx-layout';
      export { REPORT_LIMITS } from './src/domain/analysis-reports';
    ` },
    outfile: join(output, 'pptx.mjs'), bundle: true, packages: 'external',
    format: 'esm', platform: 'node', logLevel: 'silent',
  })
  api = await import(pathToFileURL(join(output, 'pptx.mjs')).href)
})
after(async () => {
  await cleanup?.()
  if (output) await rm(output, { recursive: true, force: true })
})

async function unzip(bytes) {
  assert.ok(bytes instanceof Uint8Array)
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04])
  return new Promise((resolveZip, reject) => {
    fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error)
      const entries = new Map()
      zip.on('error', reject)
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError)
          const chunks = []
          stream.on('error', reject)
          stream.on('data', chunk => chunks.push(chunk))
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks))
            zip.readEntry()
          })
        })
      })
      zip.on('end', () => resolveZip(entries))
      zip.readEntry()
    })
  })
}

function inspectXml(xml) {
  const parser = new SaxesParser({ xmlns: false })
  const shapes = []
  let shape, paragraph, inText = false
  const fonts = []
  const tableHeights = []
  parser.on('opentag', tag => {
    if (tag.name === 'p:sp' || tag.name === 'p:graphicFrame') {
      shape = { kind: tag.name, name: '', paragraphs: [], fonts: [], box: {} }
    }
    if (tag.name === 'p:cNvPr' && shape) shape.name = tag.attributes.name
    if (tag.name === 'a:off' && shape) {
      shape.box.x = Number(tag.attributes.x) / 914400
      shape.box.y = Number(tag.attributes.y) / 914400
    }
    if (tag.name === 'a:ext' && shape && tag.attributes.cx) {
      shape.box.w = Number(tag.attributes.cx) / 914400
      shape.box.h = Number(tag.attributes.cy) / 914400
    }
    if (tag.name === 'a:p') paragraph = ''
    if (tag.name === 'a:t') inText = true
    if (tag.name === 'a:br' && paragraph !== undefined) paragraph += '\n'
    if (tag.name === 'a:rPr' && tag.attributes.sz) {
      const size = Number(tag.attributes.sz) / 100
      fonts.push(size)
      shape?.fonts.push(size)
    }
    if (tag.name === 'a:tr') tableHeights.push(Number(tag.attributes.h) / 914400)
  })
  parser.on('text', value => { if (inText && paragraph !== undefined) paragraph += value })
  parser.on('closetag', tag => {
    if (tag.name === 'a:t') inText = false
    if (tag.name === 'a:p') {
      if (shape) shape.paragraphs.push(paragraph)
      paragraph = undefined
    }
    if ((tag.name === 'p:sp' || tag.name === 'p:graphicFrame') && shape) {
      shape.text = shape.paragraphs.join('\n')
      shapes.push(shape)
      shape = undefined
    }
  })
  parser.write(xml).close()
  return { shapes, fonts, tableHeights, text: shapes.map(item => item.text).join('\n') }
}

async function inspectReport(report) {
  const bytes = await api.generatePptxReport(report)
  const entries = await unzip(bytes)
  for (const [name, contents] of entries) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      try { new SaxesParser().write(contents.toString('utf8')).close() }
      catch (error) { throw new Error(`Invalid XML in ${name}: ${error.message}`) }
    }
  }
  const slides = [...entries].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]))
    .map(([name, contents]) => ({ name, xml: contents.toString('utf8'), ...inspectXml(contents.toString('utf8')) }))
  return { bytes, entries, slides, text: slides.map(slide => slide.text).join('\n') }
}

function collectedShapeText(slides, name) {
  return slides.flatMap(slide => slide.shapes.filter(shape => shape.name === name).map(shape => shape.text)).join('')
}

function assertAllSavedBlocks(report, slides) {
  const saved = new Map()
  for (const slide of slides) {
    for (const shape of slide.shapes) {
      if (/^review-\d+-detail-\d+$/.test(shape.name)) saved.set(shape.name, (saved.get(shape.name) ?? '') + shape.text)
    }
  }
  let review = 0
  for (const group of report.groups) {
    for (const comparison of group.comparisons) {
      const blocks = foundation.buildComparisonDetailBlocks(group.target, comparison)
      blocks.forEach((block, index) => {
        assert.equal(saved.get(`review-${review}-detail-${index}`), block.text.replace(/\r\n/g, '\n'),
          `Review ${review}, saved block ${index} (${block.kind}) must survive exactly, including source locators`)
      })
      review++
    }
  }
}

function assertSlideGeometry(slides) {
  for (const slide of slides) {
    assert.doesNotMatch(slide.xml, /<p:pic\b|<a:normAutofit\b|<a:spAutoFit\b/)
    assert.ok(slide.shapes.some(shape => shape.name === 'score-brand'))
    assert.ok(slide.fonts.length > 0)
    assert.ok(slide.fonts.every(size => size >= 11), 'No tiny or auto-shrunk font sizes')
    for (const shape of slide.shapes) {
      const { x, y, w, h } = shape.box
      assert.ok([x, y, w, h].every(Number.isFinite), `${slide.name} / ${shape.name} has finite dimensions`)
      assert.ok(x >= 0.5 - 0.000002 && y >= 0.5 - 0.000002, `${slide.name} / ${shape.name} honors top/left margins`)
      assert.ok(w > 0 && h > 0, `${slide.name} / ${shape.name} has positive size`)
      assert.ok(x + w <= api.PPTX_LAYOUT.width - 0.5 + 0.000002, `${slide.name} / ${shape.name} stays inside right margin`)
      assert.ok(y + h <= api.PPTX_LAYOUT.height - 0.5 + 0.000002, `${slide.name} / ${shape.name} stays inside bottom margin`)
      if (/^review-\d+-detail-\d+$/.test(shape.name)) {
        assert.ok(shape.fonts.every(size => size >= 14), 'Saved evidence is never reduced below 14pt')
      }
    }
    const textShapes = slide.shapes.filter(shape => shape.text)
    for (let left = 0; left < textShapes.length; left++) {
      for (let right = left + 1; right < textShapes.length; right++) {
        const a = textShapes[left].box
        const b = textShapes[right].box
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        assert.ok(overlapX <= 0.00001 || overlapY <= 0.00001,
          `${slide.name}: editable text/table boxes ${textShapes[left].name} and ${textShapes[right].name} do not overlap`)
      }
    }
    if (slide.tableHeights.length) {
      const table = slide.shapes.find(shape => shape.kind === 'p:graphicFrame')
      assert.ok(slide.tableHeights.reduce((total, height) => total + height, 0) <= table.box.h + 0.00001)
      assert.match(table.text, /Saved criterion\nWeight\nSaved score\nEvidence status/)
    }
  }
}

test('presentation display labels never replace original candidate or target identities', async () => {
  const input = realReportFixture({ scores: [92.75] })
  input.run.name = 'Renamed analysis'
  input.targets[0].displayName = 'Custom target'
  input.comparisons[0].candidate.displayName = 'Custom candidate'
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  for (const value of ['Renamed analysis', 'Custom target', 'Custom candidate',
    `Source-stated name: ${input.comparisons[0].candidate.name}`, `Source target title: ${input.targets[0].label}`]) {
    assert.ok(result.text.includes(value), `Missing label or source identity: ${value}`)
  }
  assertAllSavedBlocks(report, result.slides)
})

test('real editable widescreen PPTX preserves every identity, saved block and source citation', async () => {
  const input = realReportFixture({
    scores: [92.75, 0, null, 10, 20, 30, 40], targetCount: 2,
    statuses: ['complete', 'complete', 'complete', 'failed', 'queued', 'cancelled', 'running'],
  })
  input.run.name = 'Saved <evidence> & “review”'
  input.comparisons.filter(comparison => comparison.candidate.id === 'candidate-0').forEach(comparison => {
    comparison.candidate.name = 'Zoë <王> & Олена'
    comparison.summary = `Full saved assessment for ${comparison.id}. No new assessment was generated.`
  })
  const report = foundation.buildAnalysisReport(input)
  const original = JSON.stringify(report)
  const result = await inspectReport(report)
  assert.equal(JSON.stringify(report), original, 'Writer does not mutate source, rank or highlight membership')
  assert.match(result.entries.get('[Content_Types].xml').toString(), /presentationml\.presentation\.main\+xml/)
  assert.match(result.entries.get('ppt/presentation.xml').toString(), /<p:sldSz cx="12192000" cy="6858000"/)
  assert.ok(result.entries.has('ppt/theme/theme1.xml'))
  assert.ok([...result.entries.keys()].every(name => !name.startsWith('ppt/media/') && !name.startsWith('ppt/embeddings/')))
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
  const overviewSlides = result.slides.filter(slide => slide.shapes.some(shape => shape.name === 'slide-title' && shape.text === 'Candidate overview'))
  assert.equal(overviewSlides.length, report.counts.total)
  assert.match(result.text, /0 \/ 100/)
  assert.match(result.text, /Withheld — Weighted criteria were not assessed\./)
  assert.match(result.text, /Captured HTML section 3/)
  assert.match(result.text, /PDF page 178/)
  assert.match(result.text, /PARTIAL/)
  assert.match(result.text, /Highest evidence matches are not hiring recommendations/)
  const firstReview = result.slides.findIndex(slide => slide.text.includes('Candidate overview'))
  const lastHighlight = result.slides.findLastIndex(slide => slide.text.includes('Highest evidence matches'))
  assert.ok(lastHighlight < firstReview, 'All target summaries precede all detailed reviews')
  for (const slide of overviewSlides.filter(slide => /Status: (Queued|Running|Failed|Cancelled)/.test(slide.text))) {
    assert.match(slide.text, /Unavailable/)
    assert.doesNotMatch(slide.text, /0 \/ 100|0 \/ 5|Saved overall assessment/)
  }
})

test('supplied per-target ranks and capped highlight ties are preserved without reranking', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({
    scores: [100, 99, 98, 97, ...Array(12).fill(80), 0], criterionCount: 1,
  }))
  const group = report.groups[0]
  const result = await inspectReport(report)
  assert.match(result.text, /6 additional candidates tied at 80 \/ 100/)
  assert.match(result.text, /not an evidence advantage/)
  group.comparisons.forEach((comparison, index) => {
    const expected = `Rank ${comparison.rank}`
    const actual = collectedShapeText(result.slides, `highlight-0-${index}-rank`)
    assert.equal(actual.length > 0, group.highlightedComparisonIds.includes(comparison.id))
    if (actual) assert.equal(actual, expected)
    const detailOverview = result.slides.find(slide => slide.shapes.some(shape => shape.name === `review-${index}-overview-status`))
    assert.match(detailOverview.text, new RegExp(`Evidence rank ${comparison.rank}(?:\\n|$)`))
  })
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
})

test('long summaries, names, criterion labels and quotations continue without truncation or text loss', async () => {
  const input = realReportFixture({ scores: [91.125], criterionCount: 20 })
  input.run.name = `Frozen run ${'W'.repeat(260)} end-of-run-name`
  input.targets[0].label = `Saved target ${'対象 Ω multilingual '.repeat(45)} TARGET END`
  input.targets[0].criteria[0].label = `${'Wide_MW_criterion_without_spaces'.repeat(130)} LABEL END`
  input.targets[0].criteria[1].label = 'Weight and not-applicable exclusions remain explicit'
  const comparison = input.comparisons[0]
  comparison.candidate.name = `Name Ω 李 ${'W'.repeat(350)} CANDIDATE END`
  comparison.candidate.role = `Recorded role ${'Senior review context '.repeat(50)} ROLE END`
  comparison.summary = `SUMMARY START\n${'Exact saved assessment with non-ASCII café, Ω and Кириллица; no replacement text. '.repeat(220)}\nSUMMARY END`
  comparison.criteria[0].rationale = `Rationale ${'Saved rationale with sufficient evidence context. '.repeat(85)} RATIONALE END`
  comparison.criteria[0].citations = [reportFixtureCitation(comparison.candidate.documentId, {
    quote: `QUOTE START\r\n\t${'Exact source words — <not markup> & “not an excerpt”. '.repeat(140)}\nQUOTE END`,
    sourceTitle: 'Original “Résumé” & version',
    heading: `Long saved heading ${'section '.repeat(80)} HEADING END`,
  })]
  input.targets[0].criteria[2].guidance = `${'Saved guidance, without truncation. '.repeat(120)} GUIDANCE END`
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
  assert.ok(result.slides.filter(slide => slide.text.includes('Candidate review continued')).length > 3)
  assert.ok(result.slides.filter(slide => slide.text.includes('Criterion scorecard')).length > 3)
  assert.ok(result.slides.filter(slide => slide.text.includes('Criterion evidence')).length >= 20)
  assert.ok(result.slides.some(slide => /continued \d+/.test(slide.text)))
  assert.match(result.text, /Summary excerpt · saved assessment/)
  const summaryBlockIndex = foundation.buildComparisonDetailBlocks(report.groups[0].target, report.groups[0].comparisons[0])
    .findIndex(block => block.text === comparison.summary)
  const lastSummary = result.slides.findLastIndex(slide => slide.shapes.some(shape => shape.name === `review-0-detail-${summaryBlockIndex}`))
  const firstTable = result.slides.findIndex(slide => slide.text.includes('Criterion scorecard'))
  assert.ok(lastSummary < firstTable, 'Full summary finishes before the criterion details begin')
})

test('GS qualifications stay separate and unscored; zero, excluded and not-assessed states survive', async () => {
  const input = realReportFixture({ scores: [null], kind: 'grade', criterionCount: 3 })
  const comparison = input.comparisons[0]
  const states = ['missing', 'not-assessed', 'not-applicable']
  const weights = [70, 30, 0]
  comparison.criteria.forEach((criterion, index) => {
    input.targets[0].criteria[index].weight = weights[index]
    Object.assign(criterion, {
      weight: weights[index], score: index === 0 ? 0 : null, evidenceStatus: states[index], citations: [],
      limitation: index === 1 ? { code: 'source-limited', criterionId: criterion.criterionId, message: 'Exact limitation: source coverage is incomplete.' } : null,
    })
  })
  comparison.coverage = { totalCriteria: 3, supported: 0, partial: 0, missing: 1, notAssessed: 1, notApplicable: 1, assessedWeight: 70, totalWeight: 100 }
  comparison.qualifications = [{
    qualificationId: 'separate-gs-qualification',
    text: 'Saved specialized-experience qualification, not a scored criterion.',
    interpretation: 'A qualified reviewer must determine applicability.',
    support: 'derived', evidenceStatus: 'partial', rationale: 'Exact saved qualification rationale.',
    citations: [reportFixtureCitation(comparison.candidate.documentId)],
    requirementCitations: [reportFixtureCitation('gs-source', { pagination: 'captured-sections', page: 9 })],
    limitation: { code: 'human-review', message: 'Saved qualification limitation.' },
  }]
  comparison.limitations = [{ code: 'coverage-limited', message: 'Review the source limitations before interpreting the score.' }]
  const report = foundation.buildAnalysisReport(input)
  const result = await inspectReport(report)
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
  assert.match(result.text, /No scored highlights are available/)
  assert.match(result.text, /0 \/ 5/)
  assert.match(result.text, /Not applicable \(excluded\)/)
  assert.match(result.text, /Not assessed/)
  const completeBlocks = foundation.buildComparisonDetailBlocks(report.groups[0].target, report.groups[0].comparisons[0])
    .map((_block, index) => collectedShapeText(result.slides, `review-0-detail-${index}`)).join('\n')
  assert.match(completeBlocks, /not a printed page/)
  assert.match(result.text, /GS qualifications — separate, unscored human review/)
  for (const slide of result.slides.filter(slide => slide.text.includes('GS qualification review'))) {
    assert.doesNotMatch(slide.text, /Saved score|Weight:|\/ 5|\/ 100/)
  }
})

test('sample identity and full human-review cautions travel with every sample slide', async () => {
  const report = foundation.buildSampleAnalysisReport(foundation.createInitialWorkspace().runs[0], { generatedAt: REPORT_TEST_TIMESTAMP })
  const result = await inspectReport(report)
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
  assert.match(result.text, /Fictional sample data\. Fixed illustrative scores are not real assessments\./)
  for (const slide of result.slides) {
    assert.match(slide.text, /FICTIONAL SAMPLE/)
    assert.match(slide.text, /Human review required/)
  }
})

test('fractional scores remain exact and weight displays are compact, explained and unbroken', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [100 / 3, 1e-12], criterionCount: 3 }))
  const result = await inspectReport(report)
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
  assert.match(result.text, /33\.333333333333336 \/ 100/)
  assert.match(result.text, /1e-12 \/ 100/)
  assert.match(result.text, /~33\.33%/)
  assert.doesNotMatch(result.text, /33\.333333333333336%/)
  assert.match(result.text, /~ means rounded to two decimals/)
  assert.equal(api.measurePptxText('~33.33%', 1.6 - 0.25, 14).lines.length, 1)
  assert.equal(api.measurePptxText('<0.01%', 1.6 - 0.25, 14).lines.length, 1)
})

test('native scorecards distinguish zero from tiny positive weights without changing saved precision', async () => {
  const input = realReportFixture({ scores: [92], criterionCount: 4 })
  const weights = [0, 0.001, 49.999, 50]
  input.targets[0].criteria.forEach((criterion, index) => {
    criterion.weight = weights[index]
    input.comparisons[0].criteria[index].weight = weights[index]
  })
  const report = foundation.buildAnalysisReport(input)
  const original = JSON.stringify(report)
  const result = await inspectReport(report)
  const weightCells = result.slides.flatMap(slide => slide.shapes)
    .filter(shape => shape.kind === 'p:graphicFrame')
    .flatMap(shape => shape.paragraphs)
    .filter(value => /^(?:[~<])?\d+(?:\.\d+)?%$/.test(value))
  assert.deepEqual(weightCells, ['0%', '<0.01%', '~50%', '50%'])
  assert.equal(JSON.stringify(report), original)
  assert.deepEqual(report.groups[0].comparisons[0].criteria.map(criterion => criterion.weight), weights)
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
})

function visualQaFixture(long = false) {
  const input = realReportFixture({ scores: [92, 88, null], criterionCount: 3, kind: 'grade' })
  input.run.name = 'Engineering evidence review'
  input.targets[0].label = 'Engineering specialist - GS-9'
  input.targets[0].versionLabel = 'GS-9 / approved rubric v1'
  const names = ['Jordan Example', 'Morgan Rivera', 'Celine Laurent']
  const labels = ['Technical analysis', 'Project delivery', 'Clear communication']
  input.targets[0].criteria.forEach((criterion, index) => {
    criterion.label = labels[index]
    criterion.description = `Review saved evidence of ${labels[index].toLowerCase()} in defined engineering work.`
  })
  input.comparisons.forEach((comparison, index) => {
    comparison.candidate.name = names[index]
    comparison.summary = index === 2
      ? 'The submitted record does not provide enough context to assess the weighted criteria. The overall score is withheld; additional evidence and human review are needed.'
      : 'The submitted record describes independent engineering work, documented project delivery, and clear communication of findings. Review the quoted evidence and limitations before drawing any conclusions about the candidate.'
    comparison.qualifications = [{
      qualificationId: 'qualification-one', text: 'Documented engineering education or equivalent qualifying experience',
      interpretation: 'Separate, unscored human review is required. This is not an eligibility determination.',
      support: 'direct', evidenceStatus: 'not-assessed', rationale: 'The saved documents do not establish the required qualification history.',
      citations: [], requirementCitations: [reportFixtureCitation('requirement-target-0', { pagination: 'pdf-pages', page: 7 })],
      limitation: { code: 'not-assessable', message: 'Qualification history needs review.', qualificationId: 'qualification-one' },
    }]
  })
  if (long) {
    input.run.name = 'Long evidence and Unicode review'
    input.comparisons = [input.comparisons[0]]
    input.comparisons[0].candidate.name = 'Zoë Martínez / Кириллица / Ω'
    input.comparisons[0].summary = Array.from({ length: 36 }, (_, index) =>
      `Saved assessment paragraph ${index + 1}: This engineering record contains detailed source evidence that must remain readable without hidden truncation.`).join('\n\n')
    input.comparisons[0].criteria[0].rationale = 'LongWordWithoutSpaces'.repeat(80)
    input.comparisons[0].criteria[0].citations[0].quote += '\n' + 'An additional complete saved quotation with long engineering details. '.repeat(80)
  }
  return foundation.buildAnalysisReport(input)
}

test('moderate visual-QA fixture packs highlights, methodology, metadata and evidence without isolated provenance slides', async () => {
  const report = visualQaFixture()
  const result = await inspectReport(report)
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
  assert.ok(result.slides.length <= 36, `Expected materially fewer than the original 48 slides, got ${result.slides.length}`)
  assert.equal(result.slides.filter(slide => slide.shapes.some(shape => shape.name === 'slide-title' && shape.text === 'Candidate overview')).length, 3)
  assert.ok(result.slides.some(slide => slide.shapes.filter(shape => /^highlight-\d+-\d+-candidate$/.test(shape.name)).length >= 2),
    'At least two ordinary highlights share one slide')
  const methodSlide = result.slides.find(slide => slide.shapes.some(shape => shape.name === 'summary-method'))
  assert.ok(methodSlide.shapes.some(shape => shape.name === 'run-context'), 'Methodology shares the report-context slide')
  assert.ok(!result.slides.some(slide => slide.shapes.some(shape => shape.name === 'slide-title' && shape.text === 'Limitations & provenance')))
  const provenanceBlocks = new Map()
  report.groups[0].comparisons.forEach((comparison, index) => {
    const blocks = foundation.buildComparisonDetailBlocks(report.groups[0].target, comparison)
    comparison.provenance.forEach(fact => {
      const blockIndex = blocks.findIndex(block => block.text === `${fact.label}: ${fact.value}`)
      provenanceBlocks.set(`review-${index}-detail-${blockIndex}`, true)
    })
  })
  for (const slide of result.slides.filter(slide => slide.shapes.some(shape => provenanceBlocks.has(shape.name)))) {
    assert.ok(slide.shapes.some(shape => /^review-\d+-detail-\d+$/.test(shape.name) && !provenanceBlocks.has(shape.name)),
      'Provenance is consolidated with other saved review content')
  }
})

test('long visual-QA fixture has full-width paragraph continuations and source context on every split quotation', async () => {
  const report = visualQaFixture(true)
  const result = await inspectReport(report)
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
  assert.ok(result.slides.length <= 34, `Expected fewer than the original 42 long-evidence slides, got ${result.slides.length}`)
  const comparison = report.groups[0].comparisons[0]
  const blocks = foundation.buildComparisonDetailBlocks(report.groups[0].target, comparison)
  const summaryIndex = blocks.findIndex(block => block.text === comparison.summary)
  const summaryKey = `review-0-detail-${summaryIndex}`
  const summarySlides = result.slides.filter(slide => slide.shapes.some(shape => shape.name === summaryKey))
  assert.ok(summarySlides.length > 1)
  for (const [index, slide] of summarySlides.entries()) {
    const summary = slide.shapes.find(shape => shape.name === summaryKey)
    assert.match(summary.text, /^Saved assessment paragraph \d+:/)
    assert.match(summary.text.trimEnd(), /without hidden truncation\.$/)
    if (index) {
      assert.ok(summary.box.w >= 12, 'Continued summaries use the full width')
      assert.ok(!slide.shapes.some(shape => shape.name === 'review-score-card'), 'Continued summaries do not repeat the score rail')
    }
  }
  const quoteIndex = blocks.findIndex(block => block.kind === 'citation' && block.text.includes('An additional complete saved quotation'))
  const quoteKey = `review-0-detail-${quoteIndex}`
  const quoteSlides = result.slides.filter(slide => slide.shapes.some(shape => shape.name === quoteKey))
  assert.ok(quoteSlides.length > 2)
  for (const slide of quoteSlides) {
    const context = slide.shapes.find(shape => shape.name === `${quoteKey}-source-context`)
    assert.ok(context, 'Every long quotation fragment has an external source-context caption')
    assert.match(context.text, /Zoë Martínez|Review 1/)
    assert.match(context.text, /Criterion 1/)
    assert.match(context.text, /Source:/)
    assert.match(context.text, /v2/)
    assert.match(context.text, /Captured HTML section 3/)
    const quote = slide.shapes.find(shape => shape.name === quoteKey)
    assert.ok(context.box.y + context.box.h <= quote.box.y + 0.00001, 'Source context is outside, above the exact quote')
  }
  const cover = result.slides.find(slide => slide.shapes.some(shape => shape.name === 'scope-card'))
  assert.ok(cover.shapes.some(shape => shape.text === 'candidate'))
  assert.ok(cover.shapes.some(shape => shape.text === 'comparison'))
  assert.ok(!cover.shapes.some(shape => shape.text === 'candidates' || shape.text === 'comparisons'))
})

test('all 500 captured comparisons survive a partial report without a smaller candidate cap', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({
    scores: Array(500).fill(0), criterionCount: 1,
    statuses: ['complete', ...Array(499).fill('queued')],
  }))
  const result = await inspectReport(report)
  assert.equal(result.slides.filter(slide => slide.shapes.some(shape => shape.name === 'slide-title' && shape.text === 'Candidate overview')).length, 500)
  assertAllSavedBlocks(report, result.slides)
  assertSlideGeometry(result.slides)
  assert.ok(result.bytes.byteLength < api.REPORT_LIMITS.maxOutputBytes)
  assert.match(result.text, /Candidate ID: candidate-499/)
})

test('pagination measures wide characters, paragraphs, tabs and nonbreaking strings within fixed bounds', () => {
  const text = `Preserved start\tΩ李\r\n${'Wm'.repeat(150)}\n${'one  two three '.repeat(240)}\nPreserved end`
  const pages = api.paginatePptxBlocks([{ key: 'long-test-block', text }], 8.6, 3.9)
  assert.equal(pages.flatMap(page => page.fragments.map(fragment => fragment.text)).join(''), text)
  assert.ok(pages.length > 3)
  for (const page of pages) {
    assert.ok(page.height <= 3.9 + 0.000001)
    for (const fragment of page.fragments) {
      const measured = api.measurePptxText(fragment.text, 8.6, fragment.fontSize)
      assert.ok(measured.height <= fragment.height + 0.000001)
      assert.ok(measured.lines.every(line => line.width <= 8.6 * 72 * 0.94 + 0.000001))
      assert.ok(fragment.y >= 0 && fragment.y + fragment.height <= 3.9 + 0.000001)
    }
  }
  assert.ok(api.measurePptxText('WWWWWWWWWW', 1.5, 16).lines.length > api.measurePptxText('iiiiiiiiii', 1.5, 16).lines.length)
  assert.throws(() => api.assertPptxBox({ x: 0.3, y: 1, w: 1, h: 1 }), /safe slide bounds/)
  assert.throws(() => api.assertPptxBox({ x: 1, y: 1, w: Number.NaN, h: 1 }), /safe slide bounds/)
  assert.throws(() => api.takePptxText('Saved text', 1, 0.01, 16), /readable line/)
})

test('conservative Latin measurements cover both bundled font weights without blanket character overestimates', async () => {
  for (const style of ['Regular', 'Bold']) {
    const font = fontkit.create(await readFile(resolve('src', 'assets', 'report-fonts', `NotoSans-${style}.ttf`)))
    for (let code = 32; code < 127; code++) {
      const actual = font.glyphForCodePoint(code).advanceWidth / font.unitsPerEm * 16
      const measured = api.pptxGlyphWidth(String.fromCodePoint(code), 16)
      assert.ok(Number.isFinite(measured) && measured >= actual, `${style} advance for ${String.fromCodePoint(code)} is conservatively measured`)
    }
  }
  assert.ok(api.pptxGlyphWidth('f', 16) < api.pptxGlyphWidth('d', 16))
  assert.ok(api.pptxGlyphWidth('r', 16) < api.pptxGlyphWidth('o', 16))
})

test('invalid XML, slide/page caps, output size and time limits fail explicitly rather than omitting evidence', async () => {
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [0], criterionCount: 1 }))
  const invalid = structuredClone(report)
  invalid.groups[0].comparisons[0].summary += '\u0000'
  await assert.rejects(api.generatePptxReport(invalid), /XML-invalid/)
  for (const [key, limit, expected] of [
    ['maxSlides', 2, /slide\/page limit/],
    ['maxPages', 2, /slide\/page limit/],
    ['maxOutputBytes', 100, /output byte limit/],
    ['maxGenerationMilliseconds', -1, /time limit/],
  ]) {
    const original = api.REPORT_LIMITS[key]
    try {
      api.REPORT_LIMITS[key] = limit
      await assert.rejects(api.generatePptxReport(report), error => {
        assert.match(error.message, expected)
        assert.match(error.message, /Narrow the export/)
        assert.match(error.message, /no comparisons or evidence have been omitted/)
        return true
      })
    } finally {
      api.REPORT_LIMITS[key] = original
    }
  }
})

test('PPTX writer bundles for a browser worker without Node imports or external assets', async () => {
  const result = await build({
    entryPoints: [resolve('src', 'services', 'analysisReports', 'pptx.ts')],
    bundle: true, platform: 'browser', format: 'iife', globalName: 'ScoreReportTest',
    write: false, metafile: true, logLevel: 'silent',
  })
  assert.ok(result.outputFiles[0].contents.byteLength > 0)
  const imports = Object.values(result.metafile.outputs).flatMap(item => item.imports)
  assert.ok(imports.every(item => !item.external), 'All runtime modules resolve in a browser-worker build')
  const ownSource = result.outputFiles[0].text
  assert.doesNotMatch(ownSource, /from ["'](?:node:|fs["']|path["'])/)
  const scope = createContext({
    console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Blob,
    fetch: () => { throw new Error('Report generation must not fetch assets or private data.') },
  })
  runInContext('self = globalThis', scope)
  runInContext(ownSource, scope)
  assert.equal(runInContext('typeof process + "/" + typeof Buffer + "/" + typeof document', scope), 'undefined/undefined/undefined')
  const report = foundation.buildAnalysisReport(realReportFixture({ scores: [0], criterionCount: 1 }))
  const bytes = await scope.ScoreReportTest.generatePptxReport(report)
  const entries = await unzip(Uint8Array.from(bytes))
  assert.ok(entries.has('ppt/presentation.xml'), 'Actual worker-like generation returns PPTX bytes without Node globals')
})
