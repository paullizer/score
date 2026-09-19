import assert from 'node:assert/strict'
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { realReportFixture, reportFixtureCitation } from './test-support.mjs'

const utf16Decoder = new TextDecoder('utf-16be')
const streamDecoder = new TextDecoder()
const utf16 = hex => utf16Decoder.decode(Buffer.from(hex, 'hex'))
const streamText = (document, reference) => streamDecoder.decode(decodePDFRawStream(document.context.lookup(reference, PDFRawStream)).decode())

export async function readPdf(bytes) {
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
      assert.ok(dictionary.has(PDFName.of('ToUnicode')), 'Embedded text needs a Unicode character map')
      const cmap = streamText(document, dictionary.get(PDFName.of('ToUnicode')))
      const bfchars = Array.from(cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g), match => match[1]).join('\n')
      const characters = new Map(Array.from(bfchars.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi),
        match => [match[1].toUpperCase(), utf16(match[2])]))
      const font = { characters, bold: dictionary.get(PDFName.of('BaseFont')).toString().includes('Bold') }
      fonts.set(key.toString().slice(1), font)
      fontCache.set(reference.toString(), font)
    }
    const contents = page.node.Contents()
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents]
    const content = streams.map(reference => streamText(document, reference)).join('\n')
    const items = []
    for (const match of content.matchAll(/\/Span\s*<<\s*\/ActualText\s*<([0-9a-f]*)>\s*>>\s*BDC([\s\S]*?)EMC/gi)) {
      const positioning = content.slice(content.lastIndexOf('BT\n', match.index), match.index)
      const fontMatch = positioning.match(/\/([^\s/]+)\s+([\d.]+)\s+Tf/)
      const position = positioning.match(/1 0 0 1 ([-\d.]+) ([-\d.]+) Tm/)
      assert.ok(fontMatch && position, 'Source text must accompany selectable page text, not only metadata')
      const font = fonts.get(fontMatch[1])
      assert.ok(font)
      const glyphs = Array.from(match[2].matchAll(/<([0-9a-f]*)>\s*Tj/gi), item => item[1]).join('')
      let rendered = ''
      for (let offset = 0; offset < glyphs.length; offset += 4) {
        const glyph = glyphs.slice(offset, offset + 4).toUpperCase()
        assert.notEqual(glyph, '0000', 'Missing-glyph substitution is never allowed')
        assert.ok(font.characters.has(glyph), `Glyph ${glyph} must map to Unicode`)
        rendered += font.characters.get(glyph)
      }
      items.push({
        source: utf16(match[1]), rendered, x: Number(position[1]), y: Number(position[2]),
        size: Number(fontMatch[2]), bold: font.bold,
      })
    }
    assert.ok(items.length, 'Every page needs real text drawing operations')
    const annotations = (page.node.Annots()?.asArray() ?? []).map(reference => {
      const annotation = document.context.lookup(reference, PDFDict)
      assert.equal(annotation.lookup(PDFName.of('Subtype')).toString(), '/Link')
      const action = annotation.lookup(PDFName.of('A'), PDFDict)
      assert.equal(action.lookup(PDFName.of('S')).toString(), '/URI')
      return {
        url: action.lookup(PDFName.of('URI')).decodeText(),
        rect: annotation.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => value.asNumber()),
      }
    })
    return {
      width: page.getWidth(), height: page.getHeight(), items, annotations,
      text: items.map(item => item.source).join(''),
      rendered: items.map(item => item.rendered).join(''),
      body: items.filter(item => item.y > 60 && item.y < 704).map(item => item.source).join(''),
      section: items.find(item => item.y === 766)?.source ?? '',
    }
  })
  return {
    document, pages, text: pages.map(page => page.text).join('\n'), body: pages.map(page => page.body).join(''),
    annotations: pages.flatMap(page => page.annotations),
  }
}

export function reviewSections(pdf) {
  const sections = []
  for (const page of pdf.pages) {
    if (!page.section.endsWith('Candidate review')) continue
    if (page.items.some(item => item.size === 20 && item.source.startsWith('Overall score:'))) sections.push({ pages: [] })
    if (sections.length) sections.at(-1).pages.push(page)
  }
  return sections.map(section => ({ ...section, body: section.pages.map(page => page.body).join('') }))
}

export const overviewPages = pdf => pdf.pages.filter(page => page.section.endsWith('Candidates at a glance'))

export function assertNoClipping(pdf, fonts) {
  for (const page of pdf.pages) {
    assert.equal(page.width, 612)
    assert.equal(page.height, 792)
    for (const item of page.items) {
      const font = item.bold ? fonts.bold : fonts.regular
      const { glyphs } = font.layout(item.rendered, { liga: false, clig: false })
      const width = glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) * item.size / font.unitsPerEm
      assert.ok(item.x >= 46 - 0.01, `Text crossed left margin: ${item.source.slice(0, 80)}`)
      assert.ok(item.x + width <= 566 + 0.1, `Text crossed right margin: ${item.source.slice(0, 80)}`)
      if (item.y > 60 && item.y < 704) {
        assert.ok(item.size >= 9.5, 'Body text must not shrink below 9.5 pt')
        assert.ok(item.y + font.ascent * item.size / font.unitsPerEm <= 685 + 0.1, 'Body collided with header')
        assert.ok(item.y + font.descent * item.size / font.unitsPerEm >= 66 - 0.1, 'Body collided with footer')
      }
    }
    for (const annotation of page.annotations) {
      const [left, bottom, right, top] = annotation.rect
      assert.ok(left >= 46 - 0.01 && right <= 566 + 0.1 && left < right, 'Link rectangle must fit its column')
      assert.ok(bottom >= 66 - 0.1 && top <= 685 + 0.1 && bottom < top, 'Link rectangle must fit the body')
      const text = page.items.find(item => Math.abs(item.x - left) < 0.01 && item.y >= bottom && item.y <= top)
      assert.ok(text, 'A clickable rectangle must cover actual link text on that page')
      const font = text.bold ? fonts.bold : fonts.regular
      const width = font.layout(text.rendered, { liga: false, clig: false }).glyphs
        .reduce((sum, glyph) => sum + glyph.advanceWidth, 0) * text.size / font.unitsPerEm
      assert.ok(Math.abs(right - left - width) < 0.1, 'A link rectangle must match its wrapped line, not the whole cell')
    }
  }
}

export function readablePdfFixture(options = {}) {
  const input = realReportFixture({ scores: [92.75], criterionCount: 6, ...options })
  const names = ['Alex Morgan', 'Casey Rivera', 'Jordan Ellis', 'Taylor Chen', 'Sam Wilson', 'Avery Patel', 'Quinn Brooks', 'Riley Singh']
  const projects = ['flood-risk mapping', 'bridge inspections', 'energy audits', 'water-quality sampling', 'road-safety studies', 'drainage design']
  const labels = ['Engineering methods', 'Quantitative analysis', 'Project delivery', 'Technical communication', 'Team leadership', 'Quality assurance']
  for (const [index, target] of input.targets.entries()) {
    target.label = target.kind === 'grade' ? 'General engineering · GS-9' : 'Engineering specialist'
    target.sublabel = `Example public works team ${index + 1}`
    target.facts = [{ label: 'Organization', value: `Example public works team ${index + 1}` }, { label: 'Series', value: '0801' }, { label: 'Grade', value: 'GS-9' }]
    for (const [number, criterion] of target.criteria.entries()) {
      criterion.label = labels[number] ?? `Engineering evidence area ${number + 1}`
      criterion.description = `RAW-WORDING-${number}. Apply engineering methods to defined projects and communicate findings.`
      criterion.guidance = `RAW-GUIDANCE-${number}. 0: No evidence. 3: Independent work. 5: Sustained broad work.`
    }
  }
  for (const comparison of input.comparisons) {
    const index = Number(comparison.candidate.id.replace('candidate-', ''))
    const project = projects[index % projects.length]
    comparison.candidate.name = names[index] ?? `Fictional Candidate ${String(index).padStart(3, '0')}`
    comparison.candidate.role = 'Civil engineer'
    comparison.candidate.sourceLabel = `${comparison.candidate.name.replaceAll(' ', '-')}-resume.docx`
    if (comparison.status !== 'complete') continue
    comparison.summary = `Led ${project} and independently checked engineering calculations. The submitted work includes concise technical reports for public works reviewers.`
    if (comparison.overall.status === 'withheld') comparison.summary = `The resume describes ${project}, but the available source could not establish the weighted requirements.`
    comparison.criteria.forEach((criterion, number) => {
      const evidence = [
        `Applied engineering methods to ${project} and documented design assumptions.`,
        `Analysed ${project} data using reproducible calculations and uncertainty checks.`,
        `Coordinated deliverables and milestones for ${project}, including a completed engineering report.`,
        `Presented ${project} findings in concise technical reports for non-specialist reviewers.`,
        `Mentored two analysts while coordinating data collection for ${project}.`,
        `Peer-reviewed ${project} calculations and recorded the resulting quality corrections.`,
      ][number] ?? `Completed engineering check ${number + 1} for ${project}, documenting methods and review results.`
      criterion.rationale = criterion.evidenceStatus === 'not-assessed'
        ? `The available source could not establish ${labels[number]?.toLowerCase() ?? `engineering evidence area ${number + 1}`}.`
        : evidence
      if (criterion.citations.length) {
        criterion.citations = [reportFixtureCitation(comparison.candidate.documentId, {
          sourceTitle: comparison.candidate.sourceLabel, pagination: 'captured-sections', page: number + 1,
          heading: 'Project experience', paragraphId: `raw-resume-paragraph-${number}`,
          quote: `RAW-RESUME-QUOTE-${number}: ${evidence}`,
        })]
      }
      criterion.requirementCitations = [reportFixtureCitation(`requirement-${comparison.targetId}`, {
        sourceTitle: 'Engineering-role.pdf', pagination: 'pdf-pages', page: 4 + number,
        heading: 'Responsibilities', paragraphId: `raw-job-paragraph-${number}`,
        quote: `RAW-REQUIREMENT-QUOTE-${number}: Apply and communicate engineering methods.`,
      })]
    })
  }
  return input
}

export function fictionalSampleInput(input) {
  const sample = structuredClone(input)
  sample.dataKind = 'sample'
  delete sample.workspaceId
  for (const target of sample.targets) {
    target.dataKind = 'sample'
    target.rubricId = target.id
    target.selection = null
    target.snapshot = null
  }
  for (const comparison of sample.comparisons) {
    comparison.dataKind = 'sample'
    comparison.candidate.documentSha256 = null
    comparison.candidate.snapshot = null
    comparison.resultSha256 = null
    comparison.qualifications = []
  }
  return sample
}

export function fictionalPdfQaFixture(kind = 'ordinary') {
  const large = kind === 'large'
  const input = readablePdfFixture({ scores: [large ? 80 : 85], criterionCount: large ? 100 : 4 })
  const target = input.targets[0]
  const comparison = input.comparisons[0]
  input.run.name = 'Fictional survey research review'
  target.label = 'Survey research lead'
  target.sublabel = 'Fictional public research office'
  target.facts = [
    { label: 'Organization', value: 'Fictional public research office' },
    { label: 'Functions', value: 'Survey design, statistical analysis and research delivery' },
    { label: 'Supervision', value: 'Small research team with external fieldwork partners' },
  ]
  comparison.candidate.name = 'Alex Example'
  comparison.candidate.role = 'Survey methodologist'
  comparison.candidate.sourceLabel = large ? 'Alex-Example-research-portfolio.pdf' : 'Alex-Example-research-resume.pdf'
  comparison.summary = large
    ? 'Broad research-portfolio evidence covers survey planning, statistical analysis and delivered project work. Leadership examples mainly concern small teams rather than multi-team programme ownership.'
    : 'Strong survey design and statistical analysis, backed by delivered research projects. The resume documents small-team mentoring but gives fewer examples of leadership at a larger scale.'
  const ordinary = [
    ['Survey design', 40, 5, 'Designed household and business surveys, including sampling frames, field protocols and quality checks.'],
    ['Statistical analysis', 25, 4, 'Used R and Python to estimate survey results, assess non-response bias and report confidence intervals.'],
    ['Project delivery', 20, 4, 'Managed a six-month survey programme, coordinating fieldwork, a vendor and two published research reports.'],
    ['Team leadership', 15, 3, 'Mentored two analysts and coordinated a small research team. The resume does not confirm budget ownership or leadership of larger teams.'],
  ]
  const topics = [
    'Household sampling', 'Business survey recruitment', 'Non-response follow-up', 'Questionnaire accessibility',
    'Multilingual fieldwork', 'Survey data protection', 'Administrative record linkage', 'Longitudinal panel retention',
    'Remote field interviews', 'Statistical disclosure control', 'Public health questionnaires', 'Transport survey diaries',
    'Education research panels', 'Environmental survey records', 'Workforce survey collection', 'Community consultation',
    'Open-data publishing', 'Procurement of fieldwork', 'Research quality assurance', 'Survey findings dissemination',
  ]
  const dimensions = [
    ['Research planning', 5, topic => `Designed the ${topic} workstream, documenting research questions, collection methods and review gates.`],
    ['Statistical analysis', 4, topic => `Analysed ${topic} results with reproducible R code and recorded data-quality and uncertainty checks.`],
    ['Project delivery', 4, topic => `Delivered the ${topic} workstream to an agreed timetable and documented milestones with research partners.`],
    ['Team leadership', 3, topic => `Mentored analysts supporting ${topic}. The resume does not establish responsibility for a multi-team programme in this area.`],
    ['Communication', 4, topic => `Presented ${topic} findings through a technical report and an accessible briefing for non-specialist reviewers.`],
  ]
  target.criteria.forEach((definition, index) => {
    let label, weight, score, rationale
    if (large) {
      const topic = topics[Math.floor(index / dimensions.length)]
      const dimension = dimensions[index % dimensions.length]
      label = `${topic} — ${dimension[0]}`
      weight = 1
      score = dimension[1]
      rationale = dimension[2](topic.toLowerCase())
    } else {
      [label, weight, score, rationale] = ordinary[index]
    }
    Object.assign(definition, {
      label, weight,
      description: `Evaluate documented work in ${label.toLowerCase()}.`,
      guidance: '0: No evidence. 1: Observed work. 2: Assisted work. 3: Independent work. 4: Complex work. 5: Sustained broad work.',
    })
    const criterion = comparison.criteria[index]
    Object.assign(criterion, {
      weight, score, evidenceStatus: score === 3 ? 'partial' : 'supported', rationale,
      limitation: score === 3 ? {
        code: 'leadership-scope', criterionId: definition.id,
        message: large ? 'The resume does not establish responsibility for a multi-team programme in this area.'
          : 'The resume does not confirm budget ownership or leadership of larger teams.',
      } : null,
      citations: [reportFixtureCitation(comparison.candidate.documentId, {
        sourceTitle: comparison.candidate.sourceLabel, pagination: 'pdf-pages', page: 2 + Math.floor(index / 2),
        heading: label, paragraphId: `fictional-project-${index}`, quote: rationale,
      })],
      requirementCitations: [reportFixtureCitation(`requirement-${comparison.targetId}`, {
        sourceTitle: 'Survey-research-role.pdf', pagination: 'pdf-pages', page: 2,
        heading: 'Research responsibilities', paragraphId: `fictional-requirement-${index}`,
        quote: `Documented experience is required in ${label.toLowerCase()}.`,
      })],
    })
    if (kind === 'long') {
      criterion.rationale += ` ${`Additional working notes describe ${label.toLowerCase()} activities and supporting project records. `.repeat(160)}`
      criterion.citations = Array.from({ length: 12 }, (_, citationIndex) => reportFixtureCitation(comparison.candidate.documentId, {
        sourceTitle: comparison.candidate.sourceLabel, pagination: 'pdf-pages', page: 2 + Math.floor(index / 2),
        heading: label, paragraphId: `fictional-project-${index}-${citationIndex}`,
        quote: `${rationale} ${'Detailed source observations remain available in the saved analysis. '.repeat(60)}`,
      }))
    }
  })
  if (kind === 'long') comparison.summary += ` ${'Detailed project chronology and working notes remain in the saved assessment. '.repeat(600)}`
  comparison.coverage = {
    totalCriteria: target.criteria.length, supported: large ? 80 : 3, partial: large ? 20 : 1,
    missing: 0, notAssessed: 0, notApplicable: 0, assessedWeight: 100, totalWeight: 100,
  }
  return input
}
