import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { fromBuffer } from 'yauzl'
import { SaxesParser } from 'saxes'
import { realReportFixture, reportFixtureCitation } from './test-support.mjs'

export const PPTX_TEST_LINKS = { links: { origin: 'https://score.example', workspaceId: 'workspace-one' } }
export const PPTX_SAMPLE_LINKS = { links: { origin: 'https://score.example' } }

export async function loadPptxTestApi() {
  const output = resolve(`.analysis-report-pptx-tests-${randomUUID()}`)
  await mkdir(output)
  try {
    await build({
      stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
        export * from './src/services/analysisReports/pptx';
        export * from './src/services/analysisReports/pptx-layout';
        export * from './src/services/analysisReports/readable';
        export * from './src/services/analysisReports/links';
        export { REPORT_LIMITS } from './src/domain/analysis-reports';
      ` },
      outfile: join(output, 'pptx.mjs'), bundle: true, packages: 'external',
      format: 'esm', platform: 'node', logLevel: 'silent',
    })
    return {
      api: await import(pathToFileURL(join(output, 'pptx.mjs')).href),
      cleanup: () => rm(output, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}

export async function unzipPptx(bytes) {
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

export function inspectSlideXml(xml) {
  const parser = new SaxesParser({ xmlns: false })
  const shapes = [], fonts = []
  let shape, paragraph, cell, row, inText = false
  parser.on('opentag', tag => {
    if (tag.name === 'p:sp' || tag.name === 'p:graphicFrame') {
      shape = { kind: tag.name, name: '', paragraphs: [], fonts: [], box: {}, links: [], rows: [], columnWidths: [] }
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
    if (tag.name === 'a:gridCol' && shape) shape.columnWidths.push(Number(tag.attributes.w) / 914400)
    if (tag.name === 'a:tr') row = { height: Number(tag.attributes.h) / 914400, cells: [] }
    if (tag.name === 'a:tc') cell = { paragraphs: [], links: [], fonts: [] }
    if (tag.name === 'a:p') paragraph = ''
    if (tag.name === 'a:t') inText = true
    if (tag.name === 'a:br' && paragraph !== undefined) paragraph += '\n'
    if (tag.name === 'a:rPr' && tag.attributes.sz) {
      const size = Number(tag.attributes.sz) / 100
      fonts.push(size)
      shape?.fonts.push(size)
      cell?.fonts.push(size)
    }
    if (tag.name === 'a:hlinkClick' && shape) {
      const link = { id: tag.attributes['r:id'], tooltip: tag.attributes.tooltip ?? '' }
      shape.links.push(link)
      cell?.links.push(link)
    }
  })
  parser.on('text', value => { if (inText && paragraph !== undefined) paragraph += value })
  parser.on('closetag', tag => {
    if (tag.name === 'a:t') inText = false
    if (tag.name === 'a:p') {
      shape?.paragraphs.push(paragraph)
      cell?.paragraphs.push(paragraph)
      paragraph = undefined
    }
    if (tag.name === 'a:tc' && cell) {
      cell.text = cell.paragraphs.join('\n')
      row?.cells.push(cell)
      cell = undefined
    }
    if (tag.name === 'a:tr' && row) {
      shape?.rows.push(row)
      row = undefined
    }
    if ((tag.name === 'p:sp' || tag.name === 'p:graphicFrame') && shape) {
      shape.text = shape.paragraphs.join('\n')
      shapes.push(shape)
      shape = undefined
    }
  })
  parser.write(xml).close()
  return { shapes, fonts, text: shapes.map(item => item.text).join('\n') }
}

function relationships(xml) {
  const result = new Map()
  const parser = new SaxesParser()
  parser.on('opentag', tag => {
    if (tag.name === 'Relationship' && tag.attributes.Type.endsWith('/hyperlink')) {
      assert.equal(tag.attributes.TargetMode, 'External')
      result.set(tag.attributes.Id, tag.attributes.Target)
    }
  })
  parser.write(xml).close()
  return result
}

export async function inspectPptx(bytes) {
  const entries = await unzipPptx(bytes)
  for (const [name, contents] of entries) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      try { new SaxesParser().write(contents.toString('utf8')).close() }
      catch (error) { throw new Error(`Invalid XML in ${name}: ${error.message}`) }
    }
  }
  const slides = [...entries].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]))
    .map(([name, contents]) => {
      const xml = contents.toString('utf8')
      const relName = name.replace('slides/', 'slides/_rels/') + '.rels'
      return {
        name, xml, ...inspectSlideXml(xml),
        relationships: relationships(entries.get(relName)?.toString('utf8') ?? '<Relationships/>'),
      }
    })
  return { bytes, entries, slides, text: slides.map(slide => slide.text).join('\n') }
}

export function readablePptxFixture(options = {}) {
  const input = realReportFixture(options)
  input.run.name = 'Fictional research evidence review'
  const labels = ['Survey design', 'Statistical analysis', 'Team leadership', 'Communication', 'Program delivery', 'Documentation']
  const names = ['Jordan Example', 'Morgan Example', 'Celine Example']
  const rationales = [
    [
      'Designed longitudinal surveys and validated national sampling plans.',
      'Used regression models to interpret research datasets.',
      'The resume gives no example of leading a multidisciplinary team.',
      'Presented accessible research findings to nontechnical stakeholders.',
      'Delivered a regional research program on its planned schedule.',
      'Documented reproducible methods and data-quality checks.',
    ],
    [
      'Adapted survey questions after a structured pilot study.',
      'Built repeatable SQL analysis pipelines for program reporting.',
      'Coordinated two analysts; wider team leadership is not established.',
      'Translated statistical findings into short operational briefings.',
      'Tracked project dependencies and resolved reporting delays.',
      'Published a shared reporting guide with worked examples.',
    ],
  ]
  for (const target of input.targets) {
    target.label = target.kind === 'grade' ? 'Research specialist - GS-9' : 'Research analyst'
    target.sublabel = 'Example Research Office'
    target.facts = [
      { label: 'Organization', value: 'Example Research Office' },
      { label: 'Location', value: 'Hybrid, Example City' },
      { label: 'Employment type', value: 'Full time' },
      { label: 'Functions', value: 'Survey design and statistical research' },
    ]
    target.criteria.forEach((criterion, index) => {
      criterion.label = `${labels[index % labels.length]}${index >= labels.length ? ` ${Math.floor(index / labels.length) + 1}` : ''}`
      criterion.description = `Review documented ${labels[index % labels.length].toLowerCase()}.`
    })
  }
  for (const comparison of input.comparisons) {
    const candidateIndex = Number(comparison.candidate.id.split('-').at(-1))
    comparison.candidate.name = names[candidateIndex] ?? `Person ${candidateIndex + 1} Example`
    comparison.candidate.role = candidateIndex % 2 ? 'Research program analyst' : 'Survey research analyst'
    comparison.candidate.sourceLabel = `${comparison.candidate.name} - résumé.pdf`
    if (comparison.status !== 'complete') continue
    comparison.summary = comparison.overall.status === 'withheld'
      ? 'The submitted record does not establish enough detail to assess the weighted criteria.'
      : candidateIndex % 2
        ? 'Built repeatable statistical reporting pipelines. Wider team leadership is not established in the resume.'
        : 'Designed national survey instruments and analyzed research datasets. Team leadership evidence is limited.'
    comparison.criteria.forEach((criterion, index) => {
      if (comparison.overall.status === 'withheld') {
        criterion.rationale = 'The submitted record does not establish enough context to assess this requirement.'
        return
      }
      criterion.rationale = rationales[candidateIndex % 2][index % labels.length]
      criterion.score = index % labels.length === 2 ? (candidateIndex % 2 ? 2 : 0) : index % labels.length === candidateIndex % 2 ? 5 : 4
      criterion.evidenceStatus = index % labels.length === 2 ? (candidateIndex % 2 ? 'partial' : 'missing') : 'supported'
      if (criterion.evidenceStatus === 'missing') criterion.citations = []
    })
    refreshPptxCoverage(comparison)
  }
  return input
}

export function refreshPptxCoverage(comparison) {
  if (comparison.status !== 'complete') return
  const count = status => comparison.criteria.filter(criterion => criterion.evidenceStatus === status).length
  comparison.coverage = {
    totalCriteria: comparison.criteria.length, supported: count('supported'), partial: count('partial'),
    missing: count('missing'), notAssessed: count('not-assessed'), notApplicable: count('not-applicable'),
    assessedWeight: comparison.criteria.filter(criterion => criterion.evidenceStatus !== 'not-assessed').reduce((sum, criterion) => sum + criterion.weight, 0),
    totalWeight: comparison.criteria.reduce((sum, criterion) => sum + criterion.weight, 0),
  }
}

export function longPptxFixture(criterionCount = 20) {
  const input = readablePptxFixture({ scores: [91.125], criterionCount, kind: 'grade' })
  input.targets[0].label += ` · ${'対象 Ω multilingual '.repeat(45)}`
  input.targets[0].criteria[0].label = `Advanced research methods ${'Wide_MW_criterion_without_spaces'.repeat(60)}`
  const comparison = input.comparisons[0]
  comparison.candidate.name = `Zoë Martínez / 李 / Кириллица / ${'W'.repeat(350)}`
  comparison.candidate.role = `Research analyst ${'Senior survey delivery context '.repeat(50)}`
  comparison.candidate.sourceLabel = `Fictional résumé ${'W'.repeat(300)}.pdf`
  comparison.summary = 'Designed national survey instruments and analyzed research datasets. ' +
    'The resume does not establish sustained leadership of large research teams. '.repeat(220)
  comparison.criteria[0].rationale = 'Designed longitudinal surveys with independently reviewed sampling plans. ' +
    'Additional saved research methods and evidence details remain in the full analysis. '.repeat(160)
  comparison.criteria[0].citations[0].quote = 'A fictional engineering quotation with café, Ω and Кириллица. '.repeat(220)
  comparison.qualifications = Array.from({ length: 100 }, (_, index) => ({
    qualificationId: `qualification-${index}`, text: `Specialized research experience ${index + 1}`,
    interpretation: 'Separate unscored qualification review.',
    support: 'gap', evidenceStatus: index % 2 ? 'missing' : 'not-assessed',
    rationale: 'The resume does not establish the required duration of specialized research experience.',
    citations: [], requirementCitations: [],
    limitation: { code: 'duration-not-established', message: 'Duration of specialized experience needs verification.' },
  }))
  return input
}

export function fictionalPptxFixture(kind = 'normal') {
  const input = kind === 'normal' ? readablePptxFixture({ scores: [85, 76, null], criterionCount: 4 })
    : kind === 'long' ? longPptxFixture(4)
      : readablePptxFixture({ scores: [74.4], criterionCount: 100, kind: 'grade' })
  const ordinaryLabels = ['Survey design', 'Statistical analysis', 'Project delivery', 'Leadership']
  const ordinaryWeights = [40, 25, 20, 15]
  const ordinaryScores = [[5, 4, 4, 3], [4, 4, 3, 4]]
  const ordinaryRationales = [
    [
      'Designed longitudinal surveys and validated sampling plans across five regions.',
      'Applied regression models and sensitivity checks to interpret research datasets.',
      'Delivered a regional research program on schedule and documented operational handoffs.',
      'Coordinated three analysts; department-wide leadership is not established in the resume.',
    ],
    [
      'Refined survey questions after pilot interviews and documented revisions to the instrument.',
      'Built repeatable SQL reporting pipelines and checked model assumptions with the research team.',
      'Tracked project dependencies, but delivery of a complete program is only partly documented.',
      'Led four analysts and established a regular peer-review process for their research outputs.',
    ],
  ]
  const workstreams = [
    'National household survey', 'Youth employment study', 'Housing affordability panel',
    'Rural health access survey', 'Commuter travel survey', 'Small-business research',
    'Community needs assessment', 'Education outcomes study', 'Digital services research',
    'Public program evaluation',
  ]
  const capabilities = [
    'Sampling design', 'Statistical modeling', 'Survey testing', 'Data quality', 'Reproducible analysis',
    'Research planning', 'Project delivery', 'Stakeholder briefings', 'Team leadership', 'Documentation',
  ]
  const largeScores = [5, 4, 4, 3, 5, 4, 3, 4, 2, 4]
  const largeRationales = [
    topic => `Designed strata and documented sampling frames for the ${topic}.`,
    topic => `Validated regression assumptions and reported uncertainty for the ${topic}.`,
    topic => `Piloted the instrument and resolved ambiguous questions in the ${topic}.`,
    topic => `Documented data checks for the ${topic}; responsibility for resolving every exception is less clear.`,
    topic => `Published validated analysis scripts and reviewable outputs for the ${topic}.`,
    topic => `Defined research milestones and dependencies for the ${topic}.`,
    topic => `Delivered an initial phase of the ${topic}; ownership of the complete program is not established.`,
    topic => `Presented accessible findings from the ${topic} to operational stakeholders.`,
    topic => `Supported colleagues on the ${topic}, but sustained team leadership is not established.`,
    topic => `Produced a methods guide and documented analytical decisions for the ${topic}.`,
  ]
  input.targets[0].criteria.forEach((criterion, index) => {
    criterion.label = kind === 'large'
      ? `${workstreams[Math.floor(index / 10)]}: ${capabilities[index % 10]}`
      : ordinaryLabels[index]
    criterion.weight = kind === 'large' ? 1 : ordinaryWeights[index]
    criterion.description = `Review documented evidence of ${criterion.label.toLowerCase()}.`
  })
  input.comparisons.forEach((comparison, candidateIndex) => {
    if (comparison.status !== 'complete') return
    const available = comparison.overall.status === 'available'
    if (available) comparison.overall.score = kind === 'large' ? 74.4 : candidateIndex ? 76 : 85
    comparison.summary = !available
      ? 'The submitted record does not establish enough context to assess the survey, analysis, delivery, or leadership requirements.'
      : kind === 'large'
        ? 'Strong sampling design and reproducible analysis are documented across several research studies. Team leadership and full-program delivery are less consistently established.'
        : candidateIndex
          ? 'Combines statistical reporting with documented team leadership. Evidence of owning a complete research program is less developed.'
          : 'Strong survey design is supported by statistical analysis and reliable project delivery. The resume documents coordination of a small team, not department-wide leadership.'
    comparison.criteria.forEach((assessment, index) => {
      const definition = input.targets[0].criteria[index]
      assessment.weight = definition.weight
      if (!available) {
        assessment.rationale = `The submitted record does not establish enough detail to assess ${definition.label.toLowerCase()}.`
        return
      }
      const workstream = Math.floor(index / 10)
      const capability = index % 10
      const missingLeadership = kind === 'large' && capability === 8 && workstream % 3 === 0
      assessment.score = kind === 'large' ? missingLeadership ? 0 : largeScores[capability] : ordinaryScores[candidateIndex][index]
      assessment.evidenceStatus = assessment.score === 0 ? 'missing' : assessment.score <= 3 ? 'partial' : 'supported'
      assessment.rationale = kind === 'large'
        ? missingLeadership
          ? `The resume gives no example of leading the ${workstreams[workstream].toLowerCase()} team.`
          : largeRationales[capability](workstreams[workstream].toLowerCase())
        : ordinaryRationales[candidateIndex][index]
      assessment.citations = assessment.score === 0 ? [] : [reportFixtureCitation(comparison.candidate.documentId, {
        sourceTitle: comparison.candidate.sourceLabel, pagination: 'pdf-pages', page: index % 12 + 1,
        heading: definition.label, quote: assessment.rationale,
      })]
    })
    refreshPptxCoverage(comparison)
  })
  if (kind === 'long') {
    input.targets[0].criteria[0].label += ` — ${'Longitudinal sampling and survey-method review '.repeat(60)}`
    const comparison = input.comparisons[0]
    comparison.summary += '\n\n' + 'Detailed fictional source notes describe the survey design decisions and documented project outcomes. '.repeat(180)
    comparison.criteria.forEach((assessment, index) => {
      assessment.rationale += ` Additional fictional ${ordinaryLabels[index].toLowerCase()} context remains in the full review.`.repeat(140)
      assessment.citations[0].quote += '\n' + `The fictional ${ordinaryLabels[index].toLowerCase()} record preserves detailed source evidence. `.repeat(180)
    })
  }
  input.dataKind = 'sample'
  delete input.workspaceId
  for (const target of input.targets) {
    target.dataKind = 'sample'
    target.rubricId = target.id
    target.selection = null
    target.snapshot = null
  }
  for (const comparison of input.comparisons) {
    comparison.dataKind = 'sample'
    comparison.candidate.documentSha256 = null
    comparison.candidate.snapshot = null
    comparison.resultSha256 = null
    comparison.qualifications = []
  }
  return input
}
