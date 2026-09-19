import PptxGenJS from 'pptxgenjs'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import type {
  AnalysisReport, RankedReportComparison, ReportCitation, ReportGenerationOptions, ReportGroup,
} from '../../domain/analysis-reports'
import { assertReportResourceLimits } from './model'
import {
  assertReportXmlText, buildComparisonDetailBlocks, candidateName, comparisonStatusLabel,
  criterionScoreLabel, evidenceStatusLabel, formatReportWeight, highlightNotice, overallScoreLabel, paginationLabel, REPORT_CAPTURE_NOTICE, REPORT_FONT_FAMILY,
  REPORT_PALETTE, reportStatusNotice, reportTitle, summaryExcerpt, targetName,
} from './presentation'
import type { ReportTextBlock } from './presentation'
import {
  assertPptxBox, measurePptxText, paginatePptxBlocks, PPTX_LAYOUT, takePptxText,
} from './pptx-layout'
import type { PptxBox, PptxFlowBlock, PptxFlowPage } from './pptx-layout'

const C = REPORT_PALETTE
const BODY_WIDTH = PPTX_LAYOUT.width - 2 * PPTX_LAYOUT.margin
const BODY_HEIGHT = PPTX_LAYOUT.bodyBottom - PPTX_LAYOUT.bodyY
const RAIL_WIDTH = 2.75
const FLOW_WIDTH = BODY_WIDTH - RAIL_WIDTH - 0.35
const FOOTER = 'Human review required · Evidence matches, not hiring or GS eligibility decisions.'
const LIMIT_MESSAGE = 'Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.'
const WEIGHT_NOTICE = 'Weights: ~ means rounded to two decimals; <0.01% means a smaller positive weight. Saved scores are unchanged.'

function text(slide: PptxGenJS.Slide, value: string, box: PptxBox, fontSize = 16, options: PptxGenJS.TextPropsOptions = {}): void {
  assertPptxBox(box)
  const height = measurePptxText(value, box.w, fontSize).height
  if (height > box.h + 0.00001) {
    throw new Error(`PowerPoint text requires continuation. ${LIMIT_MESSAGE}`)
  }
  slide.addText(value, {
    ...box, h: height, fontFace: REPORT_FONT_FAMILY, fontSize, color: C.text, margin: 0, lang: 'en-US',
    breakLine: false, paraSpaceAfter: 0, paraSpaceBefore: 0, lineSpacingMultiple: PPTX_LAYOUT.lineHeight,
    valign: 'top', wrap: true, fit: 'none', ...options,
  })
}

function rectangle(slide: PptxGenJS.Slide, box: PptxBox, color: string, name: string, border?: string): void {
  assertPptxBox(box)
  slide.addShape('rect', {
    ...box, objectName: name, fill: { color }, line: { color: border ?? color, width: border ? 0.7 : 0 },
  })
}

function bar(slide: PptxGenJS.Slide, score: number, maximum: number, box: PptxBox, name: string): void {
  rectangle(slide, box, C.border, `${name}-track`)
  const width = box.w * score / maximum
  if (width >= 1 / 914400) rectangle(slide, { ...box, w: width }, C.accent, `${name}-value`)
}

class ReportDeck {
  readonly presentation = new PptxGenJS()
  private readonly startedAt = Date.now()
  private slideCount = 0

  constructor(readonly report: AnalysisReport) {
    this.presentation.layout = 'LAYOUT_WIDE'
    this.presentation.author = 'Score'
    this.presentation.subject = 'Saved analysis evidence for qualified human review'
    this.presentation.title = reportTitle(report)
    this.presentation.company = 'Score'
    this.presentation.theme = { headFontFace: REPORT_FONT_FAMILY, bodyFontFace: REPORT_FONT_FAMILY }
  }

  checkBudget(): void {
    if (Date.now() - this.startedAt > REPORT_LIMITS.maxGenerationMilliseconds) {
      throw new Error(`PowerPoint generation exceeded the time limit. ${LIMIT_MESSAGE}`)
    }
  }

  slide(title: string, reference: string): PptxGenJS.Slide {
    this.checkBudget()
    if (this.slideCount >= Math.min(REPORT_LIMITS.maxSlides, REPORT_LIMITS.maxPages)) {
      throw new Error(`PowerPoint exceeds the slide/page limit. ${LIMIT_MESSAGE}`)
    }
    const slide = this.presentation.addSlide()
    this.slideCount++
    slide.background = { color: C.background }
    rectangle(slide, { x: 0.6, y: 0.6, w: 1.35, h: 0.35 }, C.accent, 'score-brand')
    text(slide, 'SCORE', { x: 0.76, y: 0.615, w: 1.04, h: 0.32 }, 12, { bold: true, color: C.paper, objectName: 'brand' })
    text(slide, reference, { x: 2.25, y: 0.615, w: 6.6, h: 0.32 }, 11, { color: C.muted, objectName: 'review-reference' })
    const designation = `${this.report.dataKind === 'sample' ? 'FICTIONAL SAMPLE' : 'SAVED ANALYSIS'}${this.report.partial ? ' · PARTIAL' : ''}`
    text(slide, designation, { x: 9.0, y: 0.615, w: PPTX_LAYOUT.width - 9.6, h: 0.32 }, 11, {
      bold: true, align: 'right', color: C.accent, objectName: 'report-designation',
    })
    text(slide, title, { x: 0.6, y: 0.98, w: BODY_WIDTH, h: 0.8 }, 36, { bold: true, objectName: 'slide-title' })
    text(slide, FOOTER, { x: 0.6, y: 6.62, w: 10.8, h: 0.32 }, 11, { color: C.muted, objectName: 'human-review-footer' })
    text(slide, `${this.slideCount}`, { x: 11.7, y: 6.62, w: 1.03, h: 0.32 }, 11, {
      color: C.muted, align: 'right', objectName: 'slide-number',
    })
    return slide
  }
}

function fragments(slide: PptxGenJS.Slide, page: PptxFlowPage, x: number, y: number, width: number): void {
  for (const fragment of page.fragments) {
    const quote = fragment.kind === 'citation'
    const padding = quote ? 0.16 : 0
    const box = { x, y: y + fragment.y, w: width, h: fragment.height }
    if (quote) rectangle(slide, box, C.paper, `${fragment.key}-quote-panel`, C.border)
    if (fragment.contextHeight) text(slide, fragment.context!, {
      x: box.x + padding, y: box.y + padding, w: box.w - padding * 2, h: fragment.contextHeight - 0.08,
    }, 12, { color: C.muted, objectName: `${fragment.key}-source-context` })
    text(slide, fragment.text, {
      x: box.x + padding, y: box.y + padding + fragment.contextHeight,
      w: box.w - padding * 2, h: box.h - padding * 2 - fragment.contextHeight,
    }, fragment.fontSize, {
      bold: fragment.kind === 'heading', color: fragment.kind === 'heading' ? C.accent : C.text,
      objectName: fragment.key,
    })
  }
}

function flow(
  deck: ReportDeck, title: string, reference: string, blocks: PptxFlowBlock[],
  rail?: (slide: PptxGenJS.Slide) => void,
): void {
  const width = rail ? FLOW_WIDTH : BODY_WIDTH - 0.4
  const pages = paginatePptxBlocks(blocks, width, BODY_HEIGHT - (rail ? 0 : 0.4), {
    continuationWidth: rail ? BODY_WIDTH : width, continuationHeight: rail ? BODY_HEIGHT : BODY_HEIGHT - 0.4,
  })
  pages.forEach((page, index) => {
    const slideTitle = title === 'Candidate overview' && index ? 'Candidate review continued' : title
    const slide = deck.slide(slideTitle, `${reference}${index ? ` · continued ${index + 1}` : ''}`)
    if (!rail) rectangle(slide, { x: 0.6, y: PPTX_LAYOUT.bodyY, w: BODY_WIDTH, h: BODY_HEIGHT }, C.paper, 'content-panel')
    fragments(slide, page, rail ? 0.6 : 0.8, PPTX_LAYOUT.bodyY + (rail ? 0 : 0.2), page.width)
    if (!index) rail?.(slide)
  })
}

function blocksWithKeys(blocks: readonly ReportTextBlock[], prefix: string): PptxFlowBlock[] {
  return blocks.map((block, index) => ({ ...block, key: `${prefix}-${index}` }))
}

function overviewRail(deck: ReportDeck, slide: PptxGenJS.Slide): void {
  const x = PPTX_LAYOUT.width - 0.6 - RAIL_WIDTH
  rectangle(slide, { x, y: PPTX_LAYOUT.bodyY, w: RAIL_WIDTH, h: BODY_HEIGHT }, C.text, 'scope-card')
  text(slide, `${deck.report.candidateCount}`, { x: x + 0.22, y: 2.28, w: RAIL_WIDTH - 0.44, h: 1 }, 46, {
    color: C.paper, bold: true, objectName: 'candidate-count',
  })
  text(slide, deck.report.candidateCount === 1 ? 'candidate' : 'candidates', { x: x + 0.22, y: 3.27, w: RAIL_WIDTH - 0.44, h: 0.4 }, 16, { color: C.paper })
  text(slide, `${deck.report.counts.total}`, { x: x + 0.22, y: 3.94, w: RAIL_WIDTH - 0.44, h: 0.85 }, 36, { color: C.paper, bold: true })
  text(slide, deck.report.counts.total === 1 ? 'comparison' : 'comparisons', { x: x + 0.22, y: 4.8, w: RAIL_WIDTH - 0.44, h: 0.4 }, 16, { color: C.paper })
  text(slide, `${deck.report.groups.length} exact target${deck.report.groups.length === 1 ? '' : 's'}`, {
    x: x + 0.22, y: 5.53, w: RAIL_WIDTH - 0.44, h: 0.6,
  }, 14, { color: C.paper })
}

function opening(deck: ReportDeck): void {
  const report = deck.report
  flow(deck, 'Analysis evidence report', 'CAPTURED ANALYSIS', [
    { key: 'report-title', text: reportTitle(report), kind: 'heading', fontSize: 26 },
    ...report.notices.filter(notice => notice !== REPORT_CAPTURE_NOTICE).map((notice, index) => ({ key: `report-notice-${index}`, text: notice })),
  ], slide => overviewRail(deck, slide))
  const metadata = [
    { key: 'run-context', text: `Run ID: ${report.run.id}\nRun created: ${report.run.createdAt}\nGenerated: ${report.generatedAt}` },
    { key: 'capture-context', text: `Capture started: ${report.capture.startedAt}\nCapture completed: ${report.capture.completedAt}` },
    { key: 'scope-context', text: `Scope: ${report.scope.targetId === null ? 'Entire grouped analysis' : `Exact target ${report.scope.targetId}`}\nData: ${report.dataKind === 'sample' ? 'Fictional sample' : 'Saved real analysis'}${report.workspaceId ? `\nWorkspace: ${report.workspaceId}` : ''}` },
  ]
  const notes = [
    { key: 'capture-notice', text: REPORT_CAPTURE_NOTICE },
    { key: 'summary-method', text: 'Highlights reuse saved assessments, not new evaluations. Excerpts are labeled; full saved evidence follows. Compare ranks only within one frozen target.' },
    { key: 'weight-display-note', text: WEIGHT_NOTICE },
  ]
  const columnWidth = (BODY_WIDTH - 0.3) / 2
  const columns = [metadata, notes].map(blocks =>
    paginatePptxBlocks(blocks.map(block => ({ ...block, fontSize: 14 })), columnWidth - 0.4, BODY_HEIGHT - 0.4))
  for (let part = 0; part < Math.max(...columns.map(column => column.length)); part++) {
    const slide = deck.slide('Report context', `CAPTURE WINDOW & SAVED SCOPE${part ? ` · continued ${part + 1}` : ''}`)
    columns.forEach((column, index) => {
      if (!column[part]) return
      const x = 0.6 + index * (columnWidth + 0.3)
      rectangle(slide, { x, y: PPTX_LAYOUT.bodyY, w: columnWidth, h: BODY_HEIGHT }, C.paper, `context-column-${index}`)
      fragments(slide, column[part], x + 0.2, PPTX_LAYOUT.bodyY + 0.2, columnWidth - 0.4)
    })
  }
}

function highlightScore(slide: PptxGenJS.Slide, comparison: RankedReportComparison, y: number, height: number, key: string): void {
  rectangle(slide, { x: 0.6, y, w: 2.0, h: height }, C.text, `${key}-rank-card`)
  text(slide, `Rank ${comparison.rank}`, { x: 0.79, y: y + 0.16, w: 1.62, h: 0.4 }, 16, { bold: true, color: C.paper, objectName: `${key}-rank` })
  text(slide, overallScoreLabel(comparison.overall), { x: 0.79, y: y + 0.66, w: 1.62, h: height - 1.05 }, 16, {
    color: C.paper, objectName: `${key}-score`,
  })
  if (comparison.overall.status === 'available') {
    bar(slide, comparison.overall.score, 100, { x: 0.79, y: y + height - 0.28, w: 1.62, h: 0.1 }, `${key}-score-bar`)
  }
}

function highlights(deck: ReportDeck, group: ReportGroup, groupIndex: number): void {
  const reference = `Target ${groupIndex + 1}`
  flow(deck, 'Highest evidence matches', reference, [
    { key: `target-${groupIndex}-label`, text: targetName(group.target), kind: 'heading' },
    ...(group.target.displayName ? [{ key: `target-${groupIndex}-source-label`, text: `Source target title: ${group.target.label}`, kind: 'paragraph' as const }] : []),
    { key: `target-${groupIndex}-identity`, text: `${group.target.sublabel}\n${group.target.versionLabel}\nTarget: ${group.target.id}\nRubric: ${group.target.rubricId} · version ${group.target.rubricVersion}` },
    { key: `target-${groupIndex}-status`, text: reportStatusNotice(group.counts) },
    { key: `target-${groupIndex}-highlight-notice`, text: highlightNotice(group) },
  ])
  let slide: PptxGenJS.Slide | undefined
  let y: number = PPTX_LAYOUT.bodyBottom
  const width = BODY_WIDTH - 2.35 - 0.36
  const highlightsById = new Set(group.highlightedComparisonIds)
  group.comparisons.forEach((comparison, index) => {
    if (!highlightsById.has(comparison.id)) return
    const key = `highlight-${groupIndex}-${index}`
    const pages = paginatePptxBlocks([
      { key: `${key}-candidate`, text: candidateName(comparison.candidate), kind: 'heading', fontSize: 18 },
      { key: `${key}-excerpt`, text: `Summary excerpt · saved assessment: ${summaryExcerpt(comparison.summary!, 140).text}`, fontSize: 14 },
    ], width, BODY_HEIGHT - 0.36)
    pages.forEach((page, part) => {
      const height = Math.max(1.6, page.height + 0.36, measurePptxText(overallScoreLabel(comparison.overall), 1.62, 16).height + 1.05)
      if (!slide || y + height > PPTX_LAYOUT.bodyBottom + 0.000001) {
        slide = deck.slide('Highest evidence matches', `${reference} · saved-score order${part ? ' · continued' : ''}`)
        y = PPTX_LAYOUT.bodyY
      }
      rectangle(slide, { x: 2.95, y, w: BODY_WIDTH - 2.35, h: height }, C.paper, `${key}-excerpt-card`)
      fragments(slide, page, 3.13, y + 0.18, width)
      highlightScore(slide, comparison, y, height, key)
      y += height + 0.22
    })
  })
}

function reviewRail(slide: PptxGenJS.Slide, comparison: RankedReportComparison, statusName: string): void {
  const x = PPTX_LAYOUT.width - 0.6 - RAIL_WIDTH
  rectangle(slide, { x, y: PPTX_LAYOUT.bodyY, w: RAIL_WIDTH, h: BODY_HEIGHT }, C.text, 'review-score-card')
  text(slide, 'SAVED OVERALL', { x: x + 0.2, y: 2.3, w: RAIL_WIDTH - 0.4, h: 0.36 }, 12, { color: C.paper, bold: true })
  const score = comparison.overall.status === 'available' ? overallScoreLabel(comparison.overall) :
    comparison.overall.status === 'withheld' ? 'Withheld' : 'Unavailable'
  text(slide, score, { x: x + 0.2, y: 2.88, w: RAIL_WIDTH - 0.4, h: 1.7 }, 26, { color: C.paper, bold: true, objectName: 'saved-overall-score' })
  if (comparison.overall.status === 'available') bar(slide, comparison.overall.score, 100, { x: x + 0.2, y: 4.5, w: RAIL_WIDTH - 0.4, h: 0.16 }, 'overall-score-bar')
  text(slide, `Status: ${comparisonStatusLabel(comparison.status)}`, { x: x + 0.2, y: 4.96, w: RAIL_WIDTH - 0.4, h: 0.66 }, 14, {
    color: C.paper, objectName: statusName,
  })
  text(slide, comparison.rank === null ? 'Not ranked' : `Evidence rank ${comparison.rank}${comparison.highlighted ? '\nHighlighted match' : ''}`, {
    x: x + 0.2, y: 5.63, w: RAIL_WIDTH - 0.4, h: 0.64,
  }, 14, { color: C.paper, objectName: 'saved-evidence-rank' })
}

interface TableTail {
  slide: PptxGenJS.Slide
  bottom: number
}

function criteriaTable(deck: ReportDeck, comparison: RankedReportComparison, group: ReportGroup, reference: string): TableTail | undefined {
  const columnWidths = [5.97, 1.6, 1.98, BODY_WIDTH - 9.55]
  const headers = ['Saved criterion', 'Weight', 'Saved score', 'Evidence status']
  const padding = 14 / 72
  const headerHeight = 0.56
  let rows: string[][] = []
  let heights: number[] = []
  let used = headerHeight
  let part = 0
  let tail: TableTail | undefined
  const flush = () => {
    if (!rows.length) return
    const slide = deck.slide('Criterion scorecard', `${reference}${part ? ` · continued ${part + 1}` : ''}`)
    const tableRows: PptxGenJS.TableRow[] = [headers, ...rows].map((row, rowIndex) => row.map(value => ({
      text: value,
      options: { bold: rowIndex === 0, color: rowIndex === 0 ? C.paper : C.text, fill: { color: rowIndex === 0 ? C.text : rowIndex % 2 ? C.paper : C.background } },
    })))
    const box = { x: 0.6, y: PPTX_LAYOUT.bodyY, w: BODY_WIDTH, h: used }
    assertPptxBox(box)
    slide.addTable(tableRows, {
      ...box, objectName: `criterion-table-${part}`, colW: [...columnWidths], rowH: [headerHeight, ...heights],
      autoPage: false, margin: [7, 9, 7, 9], fontFace: REPORT_FONT_FAMILY, fontSize: 14,
      color: C.text, border: { color: C.border, pt: 0.65 }, valign: 'top',
    })
    tail = { slide, bottom: PPTX_LAYOUT.bodyY + used }
    part++
    rows = []
    heights = []
    used = headerHeight
  }
  group.target.criteria.forEach((definition, index) => {
    const assessment = comparison.criteria.find(item => item.criterionId === definition.id)
    if (!assessment) throw new Error(`Missing saved criterion assessment. ${LIMIT_MESSAGE}`)
    const fixed = [formatReportWeight(definition.weight), criterionScoreLabel(assessment), evidenceStatusLabel(assessment.evidenceStatus)]
    const fixedHeight = Math.max(...fixed.map((value, column) => measurePptxText(value, columnWidths[column + 1] - 0.25, 14).height)) + padding
    let label = `${index + 1}. ${definition.label}`
    do {
      const desiredHeight = Math.max(fixedHeight, measurePptxText(label, columnWidths[0] - 0.25, 14).height + padding)
      if (rows.length && desiredHeight > BODY_HEIGHT - used) flush()
      const available = BODY_HEIGHT - used
      const chunk = takePptxText(label, columnWidths[0] - 0.25, available - padding, 14)
      const rowHeight = Math.max(fixedHeight, chunk.height + padding)
      if (rowHeight > available + 0.000001) throw new Error(`PowerPoint criterion table needs more space. ${LIMIT_MESSAGE}`)
      rows.push([chunk.text, ...fixed])
      heights.push(rowHeight)
      used += rowHeight
      label = chunk.rest
      if (label.length) flush()
    } while (label.length)
  })
  flush()
  return tail
}

function citationContext(
  comparison: RankedReportComparison, reference: string, section: string, citation: ReportCitation,
  evidenceLabel: string, index: number, contentWidth: number,
): string {
  const width = contentWidth - 0.32
  const oneLine = measurePptxText('Context', width, 12).height
  const identity = `${candidateName(comparison.candidate)} · ${section}`
  const source = `Source: ${citation.sourceTitle} · v${citation.documentVersion} · ${paginationLabel(citation.pagination, citation.page)} · paragraph ${citation.paragraphId}`
  return `${measurePptxText(identity, width, 12).height <= oneLine ? identity : `${reference} · ${section.split(' — ')[0]}`}\n${
    measurePptxText(source, width, 12).height <= oneLine ? source :
      `Source: ${evidenceLabel} ${index + 1} · v${citation.documentVersion} · ${paginationLabel(citation.pagination, citation.page)}`
  }`
}

function evidenceBlocks(
  blocks: PptxFlowBlock[], comparison: RankedReportComparison, reference: string, section: string,
  citations: ReportCitation[], requirementCitations: ReportCitation[], contentWidth = BODY_WIDTH - 0.4,
): PptxFlowBlock[] {
  let citationIndex = 0
  return blocks.map(block => {
    const result = { ...block, section, fontSize: block.kind === 'heading' ? 20 : block.kind === 'citation' ? 15 : 14 }
    if (block.kind !== 'citation') return result
    const resume = citationIndex < citations.length
    const index = resume ? citationIndex : citationIndex - citations.length
    const citation = resume ? citations[index] : requirementCitations[index]
    citationIndex++
    return { ...result, context: citationContext(comparison, reference, section, citation, resume ? 'Resume evidence' : 'Requirement evidence', index, contentWidth) }
  })
}

function flowingReviewDetails(deck: ReportDeck, reference: string, blocks: PptxFlowBlock[], tail?: TableTail): void {
  const startY = tail ? tail.bottom + 0.2 : PPTX_LAYOUT.bodyY + 0.2
  const reuse = tail && PPTX_LAYOUT.bodyBottom - startY >= 1.6
  const pages = paginatePptxBlocks(blocks, BODY_WIDTH - 0.4, reuse ? PPTX_LAYOUT.bodyBottom - startY : BODY_HEIGHT - 0.4, {
    continuationHeight: BODY_HEIGHT - 0.4,
  })
  pages.forEach((page, index) => {
    const reused = reuse && !index
    const section = page.fragments[0]?.section ?? 'Saved context'
    const slide = reused ? tail!.slide : deck.slide(section.startsWith('Criterion ') ? 'Criterion evidence' : 'Saved review context',
      `${reference} · ${section.split(' — ')[0]}${index ? ` · continued ${index + 1}` : ''}`)
    if (!reused) rectangle(slide, { x: 0.6, y: PPTX_LAYOUT.bodyY, w: BODY_WIDTH, h: BODY_HEIGHT }, C.paper, 'content-panel')
    fragments(slide, page, 0.8, reused ? startY : PPTX_LAYOUT.bodyY + 0.2, page.width)
  })
}

function qualificationReviews(deck: ReportDeck, reference: string, sections: PptxFlowBlock[][]): void {
  const columnWidth = (BODY_WIDTH - 0.3) / 2
  let slide: PptxGenJS.Slide | undefined
  let y: number = PPTX_LAYOUT.bodyBottom
  for (const section of sections) {
    let headingCount = 0
    while (section[headingCount]?.kind === 'heading') headingCount++
    const headers = paginatePptxBlocks(section.slice(0, headingCount), BODY_WIDTH - 0.4, BODY_HEIGHT - 0.4)
    const header = headers[0]
    const plainPages = paginatePptxBlocks(section, BODY_WIDTH - 0.4, BODY_HEIGHT - 0.4)
    if (headers.length !== 1 || header.height > BODY_HEIGHT - 2.54) {
      flow(deck, 'GS qualification review', `${reference} · unscored human review`, section)
      slide = undefined
      continue
    }
    const columnHeight = BODY_HEIGHT - header.height - 0.54
    const body = section.slice(headingCount)
    const columns = [body.filter(block => block.kind !== 'citation'), body.filter(block => block.kind === 'citation')].map(blocks =>
      paginatePptxBlocks(blocks, columnWidth - 0.4, columnHeight, { continuationHeight: BODY_HEIGHT - 0.4 }))
    const count = Math.max(...columns.map(column => column.length))
    if (count > plainPages.length) {
      flow(deck, 'GS qualification review', `${reference} · unscored human review`, section)
      slide = undefined
      continue
    }
    for (let part = 0; part < count; part++) {
      const headerHeight = part ? 0 : header.height + 0.14
      const height = headerHeight + Math.max(...columns.map(column => column[part]?.height ?? 0)) + 0.4
      if (!slide || y + height > PPTX_LAYOUT.bodyBottom + 0.000001) {
        slide = deck.slide('GS qualification review', `${reference} · unscored human review${part ? ' · continued' : ''}`)
        y = PPTX_LAYOUT.bodyY
      }
      rectangle(slide, { x: 0.6, y, w: BODY_WIDTH, h: height }, C.paper, 'qualification-panel')
      if (!part) fragments(slide, header, 0.8, y + 0.2, BODY_WIDTH - 0.4)
      columns.forEach((column, index) => {
        if (column[part]) fragments(slide!, column[part], 0.8 + index * (columnWidth + 0.3), y + 0.2 + headerHeight, columnWidth - 0.4)
      })
      y += height + 0.22
    }
  }
}

function review(deck: ReportDeck, group: ReportGroup, comparison: RankedReportComparison, groupIndex: number, reviewIndex: number): void {
  const reference = `Target ${groupIndex + 1} · Review ${reviewIndex + 1}`
  const key = `review-${reviewIndex}`
  const allBlocks = blocksWithKeys(buildComparisonDetailBlocks(group.target, comparison), `${key}-detail`)
  const tailCount = comparison.provenance.length + (comparison.status === 'complete' ? comparison.limitations.length : 0)
  const detailEnd = allBlocks.length - tailCount
  const firstCriterion = allBlocks.findIndex((block, index) => index > 0 && block.kind === 'heading')
  const prefix = allBlocks.slice(0, firstCriterion < 0 ? detailEnd : firstCriterion)
  const overview: PptxFlowBlock[] = [prefix[0], {
    key: `${key}-overview-status`, text: `Status: ${comparisonStatusLabel(comparison.status)}\nOverall score: ${overallScoreLabel(comparison.overall)}`, fontSize: 14,
  }]
  if (comparison.status === 'complete') {
    const coverage = comparison.coverage ? prefix.pop() : undefined
    const summary = prefix.pop()!
    if (summary.text !== comparison.summary) throw new Error('The saved assessment is missing from the report detail blocks.')
    overview.push({ key: `${key}-summary-heading`, text: 'Saved overall assessment · full text', kind: 'heading', fontSize: 18 }, { ...summary, fontSize: 15 })
    if (coverage) prefix.push(coverage)
  } else {
    overview.push({ key: `${key}-no-assessment`, text: 'No completed assessment was captured for this candidate/target pair. No score, criterion assessment, or ranking has been invented.' })
    if (comparison.error) overview.push({ key: `${key}-error`, text: `Processing error (${comparison.error.code}): ${comparison.error.message}` })
  }
  let statusIndex = -1
  for (let index = prefix.length - 1; index >= 0; index--) {
    if (prefix[index].kind === 'paragraph' && prefix[index].text === overview[1].text) { statusIndex = index; break }
  }
  if (statusIndex < 0) throw new Error('The saved comparison status is missing from the report detail blocks.')
  overview[1] = { ...prefix.splice(statusIndex, 1)[0], fontSize: 14 }
  flow(deck, 'Candidate overview', reference, overview, slide => reviewRail(slide, comparison, `${key}-overview-status`))
  const tableTail = comparison.status === 'complete' ? criteriaTable(deck, comparison, group, reference) : undefined
  const context = prefix.slice(1)
  if (comparison.overall.status !== 'available') context.push({
    key: `${key}-score-reason`, text: `Score availability reason: ${comparison.overall.reason}`,
  })
  if (comparison.error) context.push({
    key: `${key}-error-context`,
    text: `Processing stage: ${comparison.error.stage ?? 'Not recorded'}\nRetryable: ${comparison.error.retryable === null ? 'Not recorded' : comparison.error.retryable ? 'Yes' : 'No'}`,
  })
  const details: PptxFlowBlock[] = [
    { key: `${key}-context-heading`, text: 'Saved context, limitations & provenance', kind: 'heading', fontSize: 18, section: 'Saved context' },
    ...[...context, ...allBlocks.slice(detailEnd)].map(block => ({ ...block, fontSize: 14, section: 'Saved context' })),
  ]
  const qualifications: PptxFlowBlock[][] = []
  if (firstCriterion >= 0) {
    let cursor = firstCriterion
    group.target.criteria.forEach((definition, index) => {
      const start = cursor++
      while (cursor < detailEnd && allBlocks[cursor].kind !== 'heading') cursor++
      const assessment = comparison.criteria.find(item => item.criterionId === definition.id)!
      details.push(...evidenceBlocks(allBlocks.slice(start, cursor), comparison, reference,
        `Criterion ${index + 1} — ${definition.label}`, assessment.citations, assessment.requirementCitations))
    })
    if (comparison.qualifications.length) {
      const qualificationNotice = allBlocks[cursor++]
      comparison.qualifications.forEach((qualification, index) => {
        const start = cursor++
        while (cursor < detailEnd && allBlocks[cursor].kind !== 'heading') cursor++
        qualifications.push([
          ...(index === 0 ? [{ ...qualificationNotice, fontSize: 14 }] : []),
          ...evidenceBlocks(allBlocks.slice(start, cursor), comparison, reference,
            `Qualification ${index + 1} — unscored`, qualification.citations, qualification.requirementCitations, (BODY_WIDTH - 0.3) / 2 - 0.4),
        ])
      })
    }
  }
  flowingReviewDetails(deck, reference, details, tableTail)
  if (qualifications.length) qualificationReviews(deck, reference, qualifications)
}

export async function generatePptxReport(report: AnalysisReport, options?: ReportGenerationOptions): Promise<Uint8Array> {
  // Office text stays native/editable; the optional PDF font binaries are not embedded in this deck.
  void options
  assertReportResourceLimits(report)
  assertReportXmlText(report)
  const deck = new ReportDeck(report)
  opening(deck)
  report.groups.forEach((group, index) => highlights(deck, group, index))
  let reviewIndex = 0
  report.groups.forEach((group, groupIndex) => {
    group.comparisons.forEach(comparison => review(deck, group, comparison, groupIndex, reviewIndex++))
  })
  deck.checkBudget()
  const result = await deck.presentation.write({ outputType: 'arraybuffer', compression: true })
  deck.checkBudget()
  if (!(result instanceof ArrayBuffer)) throw new Error('PowerPoint generation did not produce binary report data.')
  const bytes = new Uint8Array(result)
  if (bytes.byteLength > REPORT_LIMITS.maxOutputBytes) throw new Error(`PowerPoint exceeds the output byte limit. ${LIMIT_MESSAGE}`)
  return bytes
}
