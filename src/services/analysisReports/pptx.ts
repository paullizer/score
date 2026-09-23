import PptxGenJS from 'pptxgenjs'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import type {
  AnalysisReport, ReportComparison, ReportGenerationOptions, ReportGroup, ReportTargetPresentation,
} from '../../domain/analysis-reports'
import { reportReviewLinks, validatedReportLinkContext } from './links'
import { assertReportResourceLimits } from './model'
import { getDisplayName } from '../../domain/displayNames'
import {
  candidateNarrativeDisclosures, candidateNarrativeOverview, candidateNarrativeText, reportTargetPresentation,
  requireReportNarratives, targetNarrativeDisclosures, targetNarrativeParagraphs,
} from './narratives'
import {
  assertXmlText, criterionScoreLabel, evidenceStatusLabel, formatReportWeight, overallScoreLabel,
  REPORT_FONT_FAMILY, REPORT_PALETTE, reportTitle,
} from './presentation'
import { readableAnalysisDate, readableCandidateName, readableCompletionNotice, selectKeyCriteria } from './readable'
import type { ReadableCriterion } from './readable'
import {
  assertPptxBox, keepPptxParagraphEndWordsTogether, measurePptxText, paginatePptxBlocks, PPTX_LAYOUT, takePptxText,
} from './pptx-layout'
import type { PptxBox, PptxFlowBlock } from './pptx-layout'
import { reportGenerationPolicy, reportLimits, reportPolicyTitle, snapshotReportPolicy } from './policy'

const C = REPORT_PALETTE
const BODY_WIDTH = PPTX_LAYOUT.width - 2 * PPTX_LAYOUT.margin
const CONTENT_BOTTOM = PPTX_LAYOUT.bodyBottom
const LINKS_Y = 6.55
const TABLE_FONT = PPTX_LAYOUT.tableFontSize
const TABLE_PADDING_X = 0.14
const TABLE_PADDING_Y = 0.05
const HEADER_HEIGHT = 0.46
const REVIEW_TABLE_Y = 2.58
const COLUMN_GAP = 0.36
const EXPLANATION_WIDTH = (BODY_WIDTH - COLUMN_GAP) / 2
const EXPLANATION_TEXT_GAP = 0.04
const HUMAN_REVIEW = 'Human review required. Evidence matches are not hiring decisions or official GS eligibility findings.'
const LIMIT_MESSAGE = 'Narrow the export to one exact job/grade target; the export was not generated.'
const WEIGHT_NOTICE = 'Weights: ~ rounded to two decimals; <0.01% is a positive weight below 0.01%.'

type ReviewLinks = ReturnType<typeof reportReviewLinks>
type TextValue = string | PptxGenJS.TextProps[]

function hyperlink(url: string, tooltip?: string): PptxGenJS.HyperlinkProps {
  assertXmlText(url, 'Review link')
  if (tooltip) assertXmlText(tooltip, 'Review link description')
  return { url, ...(tooltip ? { tooltip } : {}) }
}

function internalLink(slide: number): PptxGenJS.HyperlinkProps {
  if (!Number.isInteger(slide) || slide < 1) throw new Error('PowerPoint navigation has no valid destination.')
  return { slide }
}

function height(value: string, width: number, fontSize: number): number {
  return measurePptxText(value, width, fontSize).height
}

function fits(value: string, width: number, available: number, fontSize: number): boolean {
  return height(value, width, fontSize) <= available + 0.000001
}

function summaryLeading(fontSize: number): PptxGenJS.TextPropsOptions {
  // Percentage leading varies with a viewer's font metrics; point leading matches the paginator.
  return { lineSpacingMultiple: undefined, lineSpacing: fontSize * PPTX_LAYOUT.lineHeight }
}

function text(
  slide: PptxGenJS.Slide, value: TextValue, box: PptxBox, fontSize = 16,
  options: PptxGenJS.TextPropsOptions = {},
): void {
  const plain = typeof value === 'string' ? value : value.map(run => run.text).join('')
  assertXmlText(plain)
  assertPptxBox(box)
  if (!fits(plain, box.w, box.h, fontSize)) {
    throw new Error(`PowerPoint text exceeds its readable layout budget. ${LIMIT_MESSAGE}`)
  }
  slide.addText(value, {
    ...box, fontFace: REPORT_FONT_FAMILY, fontSize, color: C.text, margin: 0, lang: 'en-US',
    breakLine: false, paraSpaceAfter: 0, paraSpaceBefore: 0, lineSpacingMultiple: PPTX_LAYOUT.lineHeight,
    valign: 'top', wrap: true, fit: 'none', ...options,
  })
}

function rectangle(slide: PptxGenJS.Slide, box: PptxBox, color: string, name: string): void {
  assertPptxBox(box)
  slide.addShape('rect', { ...box, objectName: name, fill: { color }, line: { color, width: 0 } })
}

function linkText(
  slide: PptxGenJS.Slide, label: string, url: string, box: PptxBox, name: string, tooltip?: string,
): void {
  text(slide, label, box, 14, {
    color: C.accent, underline: { style: 'sng' }, hyperlink: hyperlink(url, tooltip), objectName: name,
  })
}

function sectionReference(group: ReportGroup, groupIndex: number): string {
  return `Section ${groupIndex + 1} · ${group.target.kind === 'grade' ? 'Grade' : 'Job'} analysis`
}

class ReportDeck {
  readonly presentation = new PptxGenJS()
  readonly limits: ReturnType<typeof reportLimits>
  slideCount = 0

  constructor(readonly report: AnalysisReport, readonly options: ReportGenerationOptions | undefined, private readonly startedAt: number) {
    this.limits = reportLimits(reportGenerationPolicy(report, 'pptx'))
    this.presentation.layout = 'LAYOUT_WIDE'
    this.presentation.author = 'Score'
    this.presentation.subject = 'Analysis evidence for human review'
    const title = reportTitle(report)
    assertXmlText(title)
    this.presentation.title = title
    this.presentation.company = 'Score'
    this.presentation.theme = { headFontFace: REPORT_FONT_FAMILY, bodyFontFace: REPORT_FONT_FAMILY }
  }

  checkBudget(): void {
    if (Date.now() - this.startedAt > this.limits.maxGenerationMilliseconds) {
      throw new Error(`PowerPoint generation exceeded the time limit. ${LIMIT_MESSAGE}`)
    }
  }

  slide(title: string, reference = '', name = 'slide-title', fontSize = 36): PptxGenJS.Slide {
    this.checkBudget()
    if (this.slideCount >= Math.min(this.limits.maxSlides, REPORT_LIMITS.maxPages)) {
      throw new Error(`PowerPoint exceeds the slide/page limit. ${LIMIT_MESSAGE}`)
    }
    const slide = this.presentation.addSlide()
    this.slideCount++
    slide.background = { color: C.background }
    rectangle(slide, { x: 0.6, y: 0.6, w: 1.35, h: 0.35 }, C.accent, 'score-brand')
    text(slide, 'SCORE', { x: 0.76, y: 0.615, w: 1.04, h: 0.32 }, 12, {
      bold: true, color: C.paper, objectName: 'brand',
    })
    if (reference) text(slide, reference, { x: 2.25, y: 0.615, w: 6.5, h: 0.3 }, 11, {
      color: C.muted, objectName: 'job-reference',
    })
    if (title) text(slide, title, { x: 0.6, y: 1.12, w: BODY_WIDTH, h: height(title, BODY_WIDTH, fontSize) }, fontSize, {
      bold: true, objectName: name,
    })
    text(slide, `${this.slideCount}`, { x: 12.21, y: 6.6, w: 0.52, h: 0.3 }, 11, {
      color: C.muted, align: 'right', objectName: 'slide-number',
    })
    return slide
  }

  links(comparison: ReportComparison): ReviewLinks {
    return reportReviewLinks(this.report, comparison, this.options)
  }
}

function coverGraphic(slide: PptxGenJS.Slide, x: number, y: number, index: number): void {
  if (index === 0) {
    for (let person = 0; person < 3; person++) {
      const box = { x: x + person * 0.24, y, w: 0.17, h: 0.17 }
      assertPptxBox(box)
      slide.addShape('ellipse', { ...box, fill: { color: C.accent }, line: { color: C.accent, width: 0 },
        objectName: `cover-people-${person}-head` })
      rectangle(slide, { ...box, y: y + 0.22, h: 0.24 }, C.accent, `cover-people-${person}-body`)
    }
  } else if (index === 1) {
    for (let card = 0; card < 3; card++) {
      rectangle(slide, { x: x + card * 0.12, y: y + card * 0.1, w: 0.46, h: 0.32 },
        card === 1 ? C.border : C.accent, `cover-analyses-${card}`)
    }
  } else {
    for (let bar = 0; bar < 3; bar++) {
      rectangle(slide, { x: x + bar * 0.24, y: y + (2 - bar) * 0.12, w: 0.16, h: 0.22 + bar * 0.12 },
        C.accent, `cover-comparisons-${bar}`)
    }
  }
}

function opening(deck: ReportDeck): void {
  const completed = deck.report.groups.flatMap(group => group.comparisons).filter(item => item.status === 'complete')
  const title = reportPolicyTitle(deck.report)
  const titleFits = fits(title, BODY_WIDTH, 0.9, 36)
  if (!titleFits) reportNotice(deck, 'Report title', [{ key: 'configured-report-title', text: title }])
  const slide = deck.slide(titleFits ? title : 'Saved analysis')
  const name = deck.report.run.name
  text(slide, fits(name, 6.5, 0.3, 11) ? name : 'View analysis title', {
    x: 2.25, y: 0.615, w: 6.5, h: 0.3,
  }, 11, {
    color: C.muted, objectName: 'job-reference',
    hyperlink: hyperlink(deck.links(deck.report.groups[0].comparisons[0]).analysis, name),
  })
  text(slide, 'Saved evidence for an informed review.', { x: 0.6, y: 2.08, w: BODY_WIDTH, h: 0.5 }, 20, {
    color: C.muted, objectName: 'cover-introduction',
  })
  const cards = [
    { count: new Set(completed.map(item => item.candidate.id)).size, label: 'Distinct reviewed\ncandidates', name: 'candidates' },
    { count: deck.report.groups.length, label: 'Jobs / grades\nExact saved targets', name: 'targets' },
    { count: completed.length, label: 'Completed candidate-job\ncomparisons', name: 'comparisons' },
  ]
  const width = (BODY_WIDTH - COLUMN_GAP * 2) / 3
  cards.forEach((card, index) => {
    const x = 0.6 + index * (width + COLUMN_GAP)
    rectangle(slide, { x, y: 2.9, w: width, h: 2.88 }, C.paper, `cover-${card.name}-card`)
    coverGraphic(slide, x + width - 0.95, 3.15, index)
    text(slide, `${card.count}`, { x: x + 0.24, y: 3.65, w: width - 0.48, h: 1.14 }, 60, {
      color: C.accent, bold: true, objectName: `cover-${card.name}-count`,
    })
    text(slide, card.label, { x: x + 0.24, y: 4.98, w: width - 0.48, h: 0.68 }, 16, {
      objectName: `cover-${card.name}-label`,
    })
  })
  const latest = completed.map(item => item.analyzedAt).filter((date): date is string => date !== null).sort().at(-1) ?? null
  text(slide, `Analysis date: ${readableAnalysisDate(latest) || 'Not recorded'}`, {
    x: 0.6, y: 6.13, w: BODY_WIDTH, h: 0.35,
  }, 14, { color: C.muted, objectName: 'analysis-date' })
}

function reportNotice(deck: ReportDeck, title: string, blocks: PptxFlowBlock[]): void {
  const pages = paginatePptxBlocks(blocks, BODY_WIDTH, CONTENT_BOTTOM - PPTX_LAYOUT.bodyY)
  pages.forEach((page, pageIndex) => {
    const slide = deck.slide(`${title}${pageIndex ? ' (continued)' : ''}`)
    for (const [index, fragment] of page.fragments.entries()) {
      text(slide, fragment.text, {
        x: PPTX_LAYOUT.margin, y: PPTX_LAYOUT.bodyY + fragment.y, w: BODY_WIDTH, h: fragment.height,
      }, fragment.fontSize, { objectName: `${fragment.key}-${pageIndex}-${index}`, ...summaryLeading(fragment.fontSize) })
    }
  })
}

interface AgendaEntry {
  group: ReportGroup
  index: number
  presentation: ReportTargetPresentation
  title: string
  metadata: string
  height: number
  titleHeight: number
  organizationHeight: number
  metadataHeight: number
}

interface AgendaPage {
  slide: PptxGenJS.Slide
  number: number
  entries: AgendaEntry[]
}

function targetMetadata(presentation: ReportTargetPresentation): string {
  return [
    presentation.series ? `Series: ${presentation.series}` : '',
    presentation.grade ? `Grade: ${presentation.grade}` : '',
    presentation.versionLabel,
  ].filter(Boolean).join(' · ')
}

function reserveAgenda(deck: ReportDeck): AgendaPage[] {
  const width = BODY_WIDTH - 1.38
  const pages: AgendaPage[] = []
  let entries: AgendaEntry[] = [], used = 0
  const capacity = 3.48
  const flush = () => {
    if (!entries.length) return
    const slide = deck.slide('', 'Saved analysis')
    pages.push({ slide, number: deck.slideCount, entries })
    entries = []
    used = 0
  }
  deck.report.groups.forEach((group, index) => {
    const presentation = reportTargetPresentation(group.target)
    const title = getDisplayName(group.target, presentation.title)
    const metadata = `${targetMetadata(presentation)} · ${group.counts.complete} reviewed`
    const titleHeight = height(title, width, 20)
    const organizationHeight = presentation.organization ? height(presentation.organization, width, 14) : 0
    const metadataHeight = height(metadata, width, 14)
    const entryHeight = 0.24 + titleHeight + (organizationHeight ? organizationHeight + 0.07 : 0) + metadataHeight + 0.1
    if (entryHeight > capacity) {
      throw new Error(`PowerPoint contents cannot fit the full job title, organization, and version at a readable size. ${LIMIT_MESSAGE}`)
    }
    if (entries.length && used + 0.22 + entryHeight > capacity) flush()
    if (entries.length) used += 0.22
    entries.push({ group, index, presentation, title, metadata, height: entryHeight, titleHeight, organizationHeight, metadataHeight })
    used += entryHeight
  })
  flush()
  return pages
}

function finishAgenda(deck: ReportDeck, pages: AgendaPage[], destinations: ReadonlyMap<string, number>): void {
  for (const [pageIndex, page] of pages.entries()) {
    const title = pages.length > 1 ? `Contents · ${pageIndex + 1} of ${pages.length}` : 'Contents'
    text(page.slide, title, { x: 0.6, y: 1.12, w: BODY_WIDTH, h: height(title, BODY_WIDTH, 36) }, 36, {
      bold: true, objectName: 'slide-title',
    })
    let y = PPTX_LAYOUT.bodyY
    for (const entry of page.entries) {
      const destination = destinations.get(entry.group.target.id)
      if (destination === undefined) throw new Error('PowerPoint contents is missing an exact target destination.')
      const name = `agenda-${entry.index}`
      rectangle(page.slide, { x: 0.6, y, w: BODY_WIDTH, h: entry.height }, C.paper, `${name}-panel`)
      text(page.slide, `${entry.index + 1}`, { x: 0.76, y: y + 0.14, w: 0.5, h: 0.48 }, 20, {
        bold: true, color: C.accent, objectName: `${name}-number`,
      })
      const x = 1.4, width = BODY_WIDTH - 1.38
      let rowY = y + 0.12
      text(page.slide, entry.title, { x, y: rowY, w: width, h: entry.titleHeight }, 20, {
        bold: true, color: C.accent, hyperlink: internalLink(destination), objectName: `${name}-title`,
      })
      rowY += entry.titleHeight + 0.07
      if (entry.organizationHeight) {
        text(page.slide, entry.presentation.organization, { x, y: rowY, w: width, h: entry.organizationHeight }, 14, {
          objectName: `${name}-organization`,
        })
        rowY += entry.organizationHeight + 0.07
      }
      text(page.slide, entry.metadata, { x, y: rowY, w: width, h: entry.metadataHeight }, 14, {
        color: C.muted, objectName: `${name}-metadata`,
      })
      y += entry.height + 0.22
    }
    if (pageIndex === 0) {
      const notice = readableCompletionNotice(deck.report.counts, deck.report.groups.length > 1)
      text(page.slide, notice, { x: 0.6, y: 5.73, w: BODY_WIDTH, h: 0.6 }, 14, { objectName: 'completion-notice' })
      text(page.slide, HUMAN_REVIEW, { x: 0.6, y: 6.38, w: 11.4, h: 0.58 }, 14, {
        color: C.muted, objectName: 'human-review-notice',
      })
    } else {
      text(page.slide, 'Select a job title to open its exact saved analysis section.', {
        x: 0.6, y: LINKS_Y, w: 11.4, h: 0.35,
      }, 14, { color: C.muted, objectName: 'agenda-navigation-note' })
    }
  }
}

function targetLinks(
  slide: PptxGenJS.Slide, deck: ReportDeck, group: ReportGroup, key: string, contentsSlide: number,
): void {
  linkText(slide, group.target.kind === 'grade' ? 'View grade requirements' : 'View job',
    deck.links(group.comparisons[0]).target, { x: 0.6, y: LINKS_Y, w: 3.4, h: 0.35 }, `${key}-source-link`)
  text(slide, 'Return to contents', { x: 9.0, y: LINKS_Y, w: 3.1, h: 0.35 }, 14, {
    color: C.accent, underline: { style: 'sng' }, hyperlink: internalLink(contentsSlide), objectName: `${key}-contents-link`,
  })
}

function jobIntroduction(deck: ReportDeck, group: ReportGroup, index: number, contentsSlide: number): number {
  const presentation = reportTargetPresentation(group.target)
  const title = getDisplayName(group.target, presentation.title)
  const key = `target-${index}`
  const reference = sectionReference(group, index)
  const slide = deck.slide('', `${reference} · About the ${group.target.kind}`)
  const destination = deck.slideCount
  const titleHeight = height(title, BODY_WIDTH, 30)
  const organizationHeight = presentation.organization ? height(presentation.organization, BODY_WIDTH, 20) : 0
  const metadata = targetMetadata(presentation)
  const metadataHeight = height(metadata, BODY_WIDTH, 14)
  const identityBottom = 1.12 + titleHeight + 0.18 + (organizationHeight ? organizationHeight + 0.18 : 0) + metadataHeight
  if (identityBottom > CONTENT_BOTTOM) {
    throw new Error(`PowerPoint job identity cannot fit its full title and organization at a readable size. ${LIMIT_MESSAGE}`)
  }
  text(slide, title, { x: 0.6, y: 1.12, w: BODY_WIDTH, h: titleHeight }, 30, {
    bold: true, objectName: `${key}-title`,
  })
  let y = 1.12 + titleHeight + 0.18
  if (organizationHeight) {
    text(slide, presentation.organization, { x: 0.6, y, w: BODY_WIDTH, h: organizationHeight }, 20, {
      color: C.muted, objectName: `${key}-organization`,
    })
    y += organizationHeight + 0.18
  }
  text(slide, metadata, { x: 0.6, y, w: BODY_WIDTH, h: metadataHeight }, 14, {
    color: C.muted, objectName: `${key}-metadata`,
  })
  targetLinks(slide, deck, group, key, contentsSlide)
  const manual = group.target.narrative?.approval?.kind === 'manual'
  const overviewSection = manual ? 'Manually approved overview' : 'Analysis overview'
  const blocks: PptxFlowBlock[] = [
    ...(group.target.displayName !== undefined ? [{
      key: `${key}-source-title`, text: `Source target title: ${presentation.title}`, section: 'Job context',
    }] : []),
    { key: `${key}-context-heading`, text: 'Job context', kind: 'heading', fontSize: 20, section: 'Job context' },
    { key: `${key}-description`,
      text: keepPptxParagraphEndWordsTogether(presentation.description, BODY_WIDTH, PPTX_LAYOUT.bodyFontSize), section: 'Job context' },
    { key: `${key}-overview-heading`, text: overviewSection, kind: 'heading', fontSize: 20, section: overviewSection },
    ...(group.comparisons.some(item => item.status === 'complete')
      ? targetNarrativeDisclosures(group.target).map((disclosure, disclosureIndex) => ({
        key: `${key}-disclosure-${disclosureIndex}`, text: disclosure, section: overviewSection,
      })) : []),
    ...(manual ? [{
      key: `${key}-summary-text-heading`, text: 'Saved overview text', kind: 'heading' as const, fontSize: 20, section: overviewSection,
    }] : []),
    ...(group.comparisons.some(item => item.status === 'complete')
      ? targetNarrativeParagraphs(group.target).map((paragraph, paragraphIndex) => ({
        key: `${key}-narrative-${paragraphIndex}`, text: paragraph, section: overviewSection,
      }))
      : [{ key: `${key}-unassessed`, text: 'No completed assessments are available for this job or grade.', section: 'Analysis overview' }]),
  ]
  const bodyY = identityBottom + 0.28
  const onOpener = CONTENT_BOTTOM - bodyY >= 1.25
  const pages = paginatePptxBlocks(blocks, BODY_WIDTH, onOpener ? CONTENT_BOTTOM - bodyY : CONTENT_BOTTOM - PPTX_LAYOUT.bodyY, {
    continuationHeight: CONTENT_BOTTOM - PPTX_LAYOUT.bodyY,
  })
  const startedSections = new Set<string>()
  pages.forEach((page, pageIndex) => {
    deck.checkBudget()
    const first = onOpener && pageIndex === 0 && page.capacity <= CONTENT_BOTTOM - bodyY + 0.000001
    const section = page.fragments[0].section ?? 'About the analysis'
    const continued = startedSections.has(section) || page.fragments[0].continued
    const current = first ? slide : deck.slide(`${section}${continued ? ' (continued)' : ''}`, reference)
    if (!first) targetLinks(current, deck, group, `${key}-context-${pageIndex}`, contentsSlide)
    if (pages[pageIndex + 1]?.fragments[0].continued) {
      text(current, 'Continues on next slide', { x: 4.3, y: LINKS_Y, w: 4.4, h: 0.35 }, 14, {
        color: C.muted, objectName: `${key}-context-${pageIndex}-continuation-note`,
      })
    }
    const omitHeading = !first && page.fragments[0].kind === 'heading' && page.fragments[0].text === section
    const offset = omitHeading ? page.fragments[1]?.y ?? 0 : 0
    for (const [fragmentIndex, fragment] of page.fragments.entries()) {
      if (fragment.section) startedSections.add(fragment.section)
      if (omitHeading && fragmentIndex === 0) continue
      text(current, fragment.text, {
        x: 0.6, y: (first ? bodyY : PPTX_LAYOUT.bodyY) + fragment.y - offset, w: BODY_WIDTH, h: fragment.height,
      }, fragment.fontSize, {
        bold: fragment.kind === 'heading', objectName: `${fragment.key}-part-${pageIndex}-${fragmentIndex}`,
        ...(group.target.narrative?.summaryVersion === 2 ? summaryLeading(fragment.fontSize) : {}),
      })
    }
  })
  return destination
}

interface DeckCell {
  text: string
  url?: string
  tooltip?: string
  runs?: PptxGenJS.TextProps[]
}

function tableRowHeight(cells: readonly DeckCell[], widths: readonly number[]): number {
  return Math.max(...cells.map((cell, index) =>
    height(cell.text, widths[index] - TABLE_PADDING_X * 2, TABLE_FONT))) + TABLE_PADDING_Y * 2
}

function uniformRowHeights(heights: readonly number[]): number[] {
  const maximum = Math.max(...heights)
  return heights.map(() => maximum)
}

function table(
  slide: PptxGenJS.Slide, headers: readonly string[], rows: readonly DeckCell[][],
  widths: number[], heights: number[], y: number, name: string,
): void {
  const box = { x: 0.6, y, w: BODY_WIDTH, h: HEADER_HEIGHT + heights.reduce((sum, value) => sum + value, 0) }
  assertPptxBox(box)
  const tableRows: PptxGenJS.TableRow[] = [headers.map(value => ({ text: value })), ...rows].map((row, rowIndex) =>
    row.map((cell: DeckCell) => {
      assertXmlText(cell.text)
      if (cell.runs && cell.runs.map(run => run.text).join('') !== cell.text) {
        throw new Error('PowerPoint table links must preserve the complete measured cell text.')
      }
      return {
        text: cell.runs ?? (cell.url ? [{ text: cell.text, options: { color: C.accent, hyperlink: hyperlink(cell.url, cell.tooltip) } }] : cell.text),
        options: {
          bold: rowIndex === 0, color: rowIndex === 0 ? C.paper : cell.url ? C.accent : C.text,
          fill: { color: rowIndex === 0 ? C.text : rowIndex % 2 ? C.paper : C.background },
        },
      }
    }))
  slide.addTable(tableRows, {
    ...box, objectName: name, colW: widths, rowH: [HEADER_HEIGHT, ...heights], autoPage: false,
    margin: [TABLE_PADDING_Y * 72, TABLE_PADDING_X * 72, TABLE_PADDING_Y * 72, TABLE_PADDING_X * 72],
    fontFace: REPORT_FONT_FAMILY, fontSize: TABLE_FONT, color: C.text,
    border: { color: C.border, pt: 0.65 }, valign: 'top',
  })
}

function resumeDocumentReference(comparison: ReportComparison): string {
  return `Resume v${comparison.candidate.documentVersion}`
}

function candidateTooltip(comparison: ReportComparison): string {
  const name = readableCandidateName(comparison.candidate)
  return comparison.candidate.displayName !== undefined
    ? `${name} · Source-stated name: ${comparison.candidate.name ?? 'Not stated'} · Source: ${comparison.candidate.sourceLabel}`
    : name
}

function overviewCandidateCell(
  comparison: ReportComparison, number: number, links: ReviewLinks, width: number, overviewSlide?: number,
): DeckCell {
  const name = readableCandidateName(comparison.candidate)
  const tooltip = candidateTooltip(comparison)
  if (fits(name, width, 1.1, TABLE_FONT)) return { text: name, url: links.analysis, tooltip }
  const label = `Candidate ${number}`
  const source = fits(`${label}\n${comparison.candidate.sourceLabel}\nView analysis`, width, 1.4, TABLE_FONT)
    ? comparison.candidate.sourceLabel : resumeDocumentReference(comparison)
  return {
    text: `${label}\n${source}\nView analysis`,
    runs: [
      { text: `${label}\n`, options: { color: C.accent, hyperlink: overviewSlide ? internalLink(overviewSlide) : hyperlink(links.analysis, tooltip) } },
      { text: `${source}\n`, options: { color: C.accent, hyperlink: hyperlink(links.resume, comparison.candidate.sourceLabel) } },
      { text: 'View analysis', options: { color: C.accent, hyperlink: hyperlink(links.analysis, tooltip) } },
    ],
  }
}

function overview(deck: ReportDeck, group: ReportGroup, groupIndex: number, candidateOverviews: ReadonlyMap<string, number>): void {
  const widths = [2.75, 2.35, BODY_WIDTH - 5.1]
  const y = PPTX_LAYOUT.bodyY, capacity = CONTENT_BOTTOM - y
  let rows: DeckCell[][] = [], heights: number[] = [], page = 0
  let continued = false, manualContinuation = false
  const flush = () => {
    const slide = deck.slide(`Candidates at a glance${continued ? ' (continued)' : ''}`, sectionReference(group, groupIndex))
    if (rows.length) table(slide, ['Name', 'Score', 'Assessment overview'], rows, widths, uniformRowHeights(heights), y, `overview-${groupIndex}-${page}`)
    else text(slide, 'No completed assessments are available for this job yet.', {
      x: 0.6, y, w: BODY_WIDTH, h: 0.8,
    }, 18, { objectName: 'empty-overview' })
    const notice = manualContinuation ? `Manually approved summary and known issues${continued ? ' (continued)' : ''}; saved scores are unchanged.`
      : continued ? 'Continued overview for the same saved candidate and score. Use the candidate link for details.'
        : 'Use candidate links for the overview, saved analysis, or resume.'
    text(slide, notice, { x: 0.6, y: LINKS_Y, w: 11.4, h: 0.35 }, 14, {
      color: C.muted, objectName: 'overview-link-note',
    })
    rows = []
    heights = []
    continued = false
    manualContinuation = false
    page++
  }
  for (const [index, comparison] of group.comparisons.entries()) {
    if (comparison.status !== 'complete') continue
    const row = [
      overviewCandidateCell(comparison, index + 1, deck.links(comparison), widths[0] - TABLE_PADDING_X * 2,
        candidateOverviews.get(comparison.id)),
      { text: comparison.overall.status === 'available' ? overallScoreLabel(comparison.overall) : 'Withheld' },
      { text: [...candidateNarrativeDisclosures(comparison), candidateNarrativeOverview(comparison)].join('\n\n') },
    ]
    const rowHeight = tableRowHeight(row, widths)
    if (HEADER_HEIGHT + rowHeight > capacity) {
      if (rows.length) flush()
      let remaining = row[2].text
      let part = 0
      do {
        const fragment = takePptxText(remaining, widths[2] - TABLE_PADDING_X * 2,
          capacity - HEADER_HEIGHT - TABLE_PADDING_Y * 2, TABLE_FONT)
        const continuedRow = [row[0], row[1], { text: fragment.text }]
        rows.push(continuedRow)
        heights.push(tableRowHeight(continuedRow, widths))
        continued = part++ > 0
        manualContinuation = comparison.narrative?.approval?.kind === 'manual'
        flush()
        remaining = fragment.rest
      } while (remaining)
      continue
    }
    if (rows.length && HEADER_HEIGHT + (rows.length + 1) * Math.max(rowHeight, ...heights) > capacity) flush()
    rows.push(row)
    heights.push(rowHeight)
  }
  if (rows.length || !page) flush()
}

function savedCriteria(group: ReportGroup, comparison: ReportComparison): ReadableCriterion[] {
  const assessments = new Map(comparison.criteria.map(criterion => [criterion.criterionId, criterion]))
  return group.target.criteria.map((definition, index) => {
    const assessment = assessments.get(definition.id)
    if (!assessment) throw new Error('A completed PowerPoint review is missing a saved criterion.')
    const limitation = assessment.limitation?.message ?? null
    return {
      id: definition.id, number: index + 1, label: definition.label, weight: assessment.weight,
      weightLabel: formatReportWeight(assessment.weight), score: assessment.score,
      scoreLabel: assessment.evidenceStatus === 'not-applicable' ? 'N/A' : criterionScoreLabel(assessment),
      evidenceStatus: assessment.evidenceStatus, required: definition.requirementType === 'required',
      sourceLabel: null, limitation,
      explanation: assessment.rationale + (limitation && !assessment.rationale.includes(limitation) ? `\n${limitation}` : ''),
    }
  })
}

interface WarningPlan {
  heading: string
  text: string
  height: number
  deferred: boolean
}

function reviewWarnings(comparison: ReportComparison): WarningPlan {
  const severity = { 'not-assessed': 3, missing: 2, partial: 1, supported: 0 }
  const concerns = comparison.qualifications.map((qualification, index) => ({ qualification, index }))
    .filter(({ qualification }) => qualification.evidenceStatus !== 'supported' || qualification.limitation)
    .sort((a, b) => severity[b.qualification.evidenceStatus] - severity[a.qualification.evidenceStatus] || a.index - b.index)
  let deferred = concerns.length > 2
  const width = BODY_WIDTH - 0.4
  const notes = concerns.slice(0, 2).map(({ qualification, index }) => {
    const message = qualification.limitation?.message ?? qualification.rationale
    const full = `${qualification.text}: ${message}`
    if (fits(full, width, 0.6, 14)) return full
    deferred = true
    const referenced = `Qualification ${index + 1}: ${message}`
    if (fits(referenced, width, 0.6, 14)) return referenced
    return `Qualification ${index + 1}: ${evidenceStatusLabel(qualification.evidenceStatus)}. View the full qualification review.`
  })
  if (!concerns.length && comparison.limitations.length) {
    const message = comparison.limitations[0].message
    if (fits(message, width, 0.9, 14)) notes.push(message)
    else { notes.push('An assessment limitation requires review in the full saved analysis.'); deferred = true }
    deferred ||= comparison.limitations.length > 1
  }
  if (deferred) notes.push('Further details are available in the full analysis.')
  const value = notes.join('\n')
  return {
    heading: concerns.length ? 'Unscored qualification caveats' : 'Assessment limitations',
    text: value, height: value ? height(value, width, 14) + 0.64 : 0, deferred,
  }
}

interface Explanation {
  criterion: ReadableCriterion
  label: string
  body: string
  headingHeight: number
  bodyHeight: number
  height: number
  deferred: boolean
}

interface ReviewPlan {
  criteria: ReadableCriterion[]
  keyCriteria: boolean
  rows: DeckCell[][]
  widths: number[]
  rowHeights: number[]
  explanations: Explanation[]
  split: number
  warnings: WarningPlan
  fullDetails: boolean
  combined: boolean
}

const CRITERION_WIDTHS = [8.03, 1.6, BODY_WIDTH - 9.63]
const COMBINED_WIDTHS = [3.6, 1.3, 1.8, BODY_WIDTH - 6.7]

function explanation(criterion: ReadableCriterion, width: number, available: number): Explanation {
  const fullLabel = `C${criterion.number} · ${criterion.label} · ${criterion.scoreLabel}`
  const shortLabel = `C${criterion.number} · ${criterion.scoreLabel} · ${evidenceStatusLabel(criterion.evidenceStatus)}`
  const label = fits(fullLabel, width, Math.min(1.05, available / 2), 14) ? fullLabel : shortLabel
  const headingHeight = height(label, width, 14)
  const bodyBudget = available - headingHeight - EXPLANATION_TEXT_GAP
  let body = criterion.explanation
  let deferred = label !== fullLabel
  if (!fits(body, width, bodyBudget, 14)) {
    body = criterion.limitation && fits(`${criterion.limitation}\nView the full saved explanation.`, width, bodyBudget, 14)
      ? `${criterion.limitation}\nView the full saved explanation.`
      : 'View the full saved explanation.'
    deferred = true
  }
  const bodyHeight = height(body, width, 14)
  return { criterion, label, body, headingHeight, bodyHeight, height: headingHeight + EXPLANATION_TEXT_GAP + bodyHeight, deferred }
}

function explanationRows(explanations: readonly Explanation[], split: number): number[] {
  const left = explanations.slice(0, split), right = explanations.slice(split)
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
    Math.max(left[index]?.height ?? 0, right[index]?.height ?? 0))
}

function reviewPlan(group: ReportGroup, comparison: ReportComparison, links: ReviewLinks, combined: boolean): ReviewPlan {
  const all = savedCriteria(group, comparison)
  const warnings = reviewWarnings(comparison)
  const available = CONTENT_BOTTOM - REVIEW_TABLE_Y - (warnings.height ? warnings.height + 0.24 : 0)
  const widths = combined ? COMBINED_WIDTHS : CRITERION_WIDTHS
  for (let count = Math.min(combined ? 4 : 8, all.length); count >= 1; count--) {
    const criteria = selectKeyCriteria(all, count)
    const explanations = criteria.map(criterion => explanation(criterion, EXPLANATION_WIDTH, Math.min(2.25, available)))
    const rows = criteria.map((criterion, index) => {
      const fullLabel = `C${criterion.number} · ${criterion.label}`
      const label = fits(fullLabel, widths[0] - TABLE_PADDING_X * 2, combined ? 1.3 : 1.05, 14)
        ? fullLabel : `C${criterion.number} · View full criterion`
      const row: DeckCell[] = [
        { text: label, ...(label !== fullLabel ? { url: links.analysis, tooltip: fullLabel } : {}) },
        { text: criterion.weightLabel }, { text: criterion.scoreLabel },
      ]
      if (combined) {
        const full = criterion.explanation
        const value = fits(full, widths[3] - TABLE_PADDING_X * 2, Math.max(0.6, available - HEADER_HEIGHT), 14)
          ? full : `${evidenceStatusLabel(criterion.evidenceStatus)}. View the full saved explanation.`
        row.push({ text: value, ...(value !== full ? { url: links.analysis } : {}) })
      }
      if (row[0].url) explanations[index].deferred = true
      return row
    })
    const measuredHeights = rows.map(row => tableRowHeight(row, widths))
    const rowHeights = combined ? uniformRowHeights(measuredHeights) : measuredHeights
    const weightNoteHeight = criteria.some(criterion => /^[~<]/.test(criterion.weightLabel)) ? 0.42 : 0
    const tableAvailable = (combined ? available : CONTENT_BOTTOM - REVIEW_TABLE_Y) - weightNoteHeight
    if (HEADER_HEIGHT + rowHeights.reduce((sum, value) => sum + value, 0) > tableAvailable) continue
    let split = 1, best = Infinity
    for (let cut = 1; cut <= explanations.length; cut++) {
      const rowHeights = explanationRows(explanations, cut)
      const alignedHeight = rowHeights.reduce((sum, value) => sum + value, 0) + Math.max(0, rowHeights.length - 1) * 0.22
      if (alignedHeight < best) { best = alignedHeight; split = cut }
    }
    if (!combined && best > available) continue
    return {
      criteria, keyCriteria: count < all.length, rows, widths: [...widths], rowHeights, explanations, split, warnings, combined,
      fullDetails: count < all.length || warnings.deferred || rows.some(row => row.some(cell => cell.url)) ||
        (!combined && explanations.some(item => item.deferred)),
    }
  }
  throw new Error(`PowerPoint cannot fit a readable key criterion and its qualification warnings within three candidate slides. ${LIMIT_MESSAGE}`)
}

function candidateLinks(
  slide: PptxGenJS.Slide, group: ReportGroup, comparison: ReportComparison, links: ReviewLinks, key: string, fullDetails: boolean,
): void {
  const items = [
    { label: 'View analysis', url: links.analysis, x: 0.6, w: 2.1, tooltip: candidateTooltip(comparison) },
    { label: 'View resume', url: links.resume, x: 2.9, w: 2.0,
      tooltip: [comparison.candidate.sourceLabel, comparison.candidate.role].filter(Boolean).join('\n') },
    { label: group.target.kind === 'grade' ? 'View grade requirements' : 'View job', url: links.target, x: 5.1, w: 3.3 },
    ...(fullDetails ? [{ label: 'View full scorecard', url: links.analysis, x: 9.0, w: 3.1 }] : []),
  ]
  items.forEach((item, index) => linkText(slide, item.label, item.url, {
    x: item.x, y: LINKS_Y, w: item.w, h: 0.35,
  }, `${key}-link-${index}`, item.tooltip))
}

interface CandidateLayout {
  nameFont: number
  nameHeight: number
  role: string
  roleHeight: number
  source: string
  sourceHeight: number
  sourceName: string | null
  sourceNameHeight: number
  summaryY: number
  narrativeFont: number
  separateNarrative: boolean
}

function candidateSummaryText(comparison: ReportComparison): string {
  return [...candidateNarrativeDisclosures(comparison), candidateNarrativeText(comparison)].join('\n\n')
}

function candidateLayout(comparison: ReportComparison): CandidateLayout {
  const name = readableCandidateName(comparison.candidate)
  const role = comparison.candidate.role ? `Role: ${comparison.candidate.role}` : 'Role not recorded'
  const source = `Source: ${comparison.candidate.sourceLabel}`
  const sourceName = comparison.candidate.displayName !== undefined ? `Source-stated name: ${comparison.candidate.name ?? 'Not stated'}` : null
  const metadataWidth = 8.55
  const roleLabel = fits(role, metadataWidth, 0.62, 15) ? role : 'View recorded role'
  const sourceLabel = fits(source, metadataWidth, 0.57, 14) ? source : `Source: ${resumeDocumentReference(comparison)}`
  const sourceNameLabel = sourceName === null ? null : fits(sourceName, metadataWidth, 0.57, 14) ? sourceName : 'View source-stated name'
  const roleHeight = height(roleLabel, metadataWidth, 15), sourceHeight = height(sourceLabel, metadataWidth, 14)
  const sourceNameHeight = sourceNameLabel === null ? 0 : height(sourceNameLabel, metadataWidth, 14)
  const narrative = candidateSummaryText(comparison)
  for (const nameFont of [32, 28, 24, 22]) {
    const nameHeight = height(name, metadataWidth, nameFont)
    if (nameHeight > 1.45) continue
    const summaryY = Math.max(3.02, 1.12 + nameHeight + 0.12 + roleHeight + 0.08 + sourceHeight +
      (sourceNameHeight ? sourceNameHeight + 0.08 : 0) + 0.28)
    for (const narrativeFont of [16, 14]) {
      if (fits(narrative, BODY_WIDTH - 0.4, CONTENT_BOTTOM - summaryY - 0.71, narrativeFont)) {
        return { nameFont, nameHeight, role: roleLabel, roleHeight, source: sourceLabel, sourceHeight,
          sourceName: sourceNameLabel, sourceNameHeight, summaryY, narrativeFont, separateNarrative: false }
      }
    }
  }
  const nameFont = [30, 26, 22, 20].find(size => fits(name, BODY_WIDTH, 3.62, size))
  const narrativeFont = comparison.narrative?.summaryVersion === 2 ? 16
    : [16, 14].find(size => fits(narrative, BODY_WIDTH, CONTENT_BOTTOM - 1.82, size))
  if (!nameFont || !narrativeFont) {
    throw new Error(`PowerPoint cannot preserve the full candidate name and saved assessment at readable sizes within three slides. ${LIMIT_MESSAGE}`)
  }
  return { nameFont, nameHeight: height(name, BODY_WIDTH, nameFont), role: roleLabel, roleHeight,
    source: sourceLabel, sourceHeight, sourceName: sourceNameLabel, sourceNameHeight,
    summaryY: 0, narrativeFont, separateNarrative: true }
}

function scorePanel(slide: PptxGenJS.Slide, comparison: ReportComparison, key: string, wide = false): void {
  const box = wide ? { x: 0.6, y: 5.54, w: BODY_WIDTH, h: 0.76 } : { x: 9.55, y: 1.16, w: BODY_WIDTH - 8.95, h: 1.56 }
  rectangle(slide, box, C.text, `${key}-score-panel`)
  const value = comparison.overall.status === 'available' ? overallScoreLabel(comparison.overall) : 'Withheld'
  if (wide) {
    text(slide, `Overall score: ${value}`, { x: 0.82, y: 5.69, w: BODY_WIDTH - 0.44, h: 0.52 }, 22, {
      color: C.paper, bold: true, objectName: `${key}-overall-score`,
    })
    return
  }
  text(slide, 'Overall score', { x: box.x + 0.2, y: 1.34, w: box.w - 0.4, h: 0.35 }, 14, { color: C.paper })
  const fontSize = value.length > 15 ? 16 : 28
  text(slide, value, { x: box.x + 0.2, y: 1.86, w: box.w - 0.4, h: 0.65 }, fontSize, {
    color: C.paper, bold: true, objectName: `${key}-overall-score`,
  })
  if (comparison.overall.status === 'available') {
    const track = { x: box.x + 0.2, y: 2.53, w: box.w - 0.4, h: 0.08 }
    rectangle(slide, track, C.border, `${key}-score-track`)
    const width = track.w * comparison.overall.score / 100
    if (width >= 1 / 914400) rectangle(slide, { ...track, w: width }, C.accent, `${key}-score-value`)
  }
}

function candidateOverview(
  deck: ReportDeck, group: ReportGroup, comparison: ReportComparison, links: ReviewLinks, plan: ReviewPlan,
  layout: CandidateLayout, key: string, reference: string,
): void {
  const slide = deck.slide('', reference)
  const width = layout.separateNarrative ? BODY_WIDTH : 8.55
  text(slide, readableCandidateName(comparison.candidate), {
    x: 0.6, y: 1.12, w: width, h: layout.nameHeight,
  }, layout.nameFont, { bold: true, objectName: `${key}-overview-name` })
  let y = 1.12 + layout.nameHeight + 0.12
  const metadata = [
    { index: 0, value: layout.role, full: comparison.candidate.role ? `Role: ${comparison.candidate.role}` : 'Role not recorded',
      h: layout.roleHeight, font: 15, url: links.analysis },
    { index: 1, value: layout.source, full: `Source: ${comparison.candidate.sourceLabel}`, h: layout.sourceHeight, font: 14, url: links.resume },
    ...(layout.sourceName === null ? [] : [{
      index: 2, value: layout.sourceName, full: `Source-stated name: ${comparison.candidate.name ?? 'Not stated'}`,
      h: layout.sourceNameHeight, font: 14, url: links.resume,
    }]),
  ]
  for (const item of layout.separateNarrative ? [...metadata.slice(2), metadata[1], metadata[0]] : metadata) {
    if (layout.separateNarrative && y + item.h > 5.25) continue
    text(slide, item.value, { x: 0.6, y, w: 8.55, h: item.h }, item.font, {
      color: C.muted, objectName: `${key}-metadata-${item.index}`,
      ...(item.value !== item.full ? { color: C.accent, hyperlink: hyperlink(item.url, item.full) } : {}),
    })
    y += item.h + 0.08
  }
  scorePanel(slide, comparison, key, layout.separateNarrative)
  const overview = [...candidateNarrativeDisclosures(comparison), candidateNarrativeOverview(comparison)].join('\n\n')
  if (!layout.separateNarrative) {
    rectangle(slide, { x: 0.6, y: layout.summaryY, w: BODY_WIDTH, h: CONTENT_BOTTOM - layout.summaryY }, C.paper, `${key}-summary-panel`)
    text(slide, 'Assessment summary', { x: 0.8, y: layout.summaryY + 0.16, w: BODY_WIDTH - 0.4, h: 0.43 }, 18, {
      bold: true, objectName: `${key}-summary-heading`,
    })
    text(slide, candidateSummaryText(comparison), {
      x: 0.8, y: layout.summaryY + 0.66, w: BODY_WIDTH - 0.4, h: CONTENT_BOTTOM - layout.summaryY - 0.71,
    }, layout.narrativeFont, {
      objectName: `${key}-summary`, ...(comparison.narrative?.summaryVersion === 2 ? summaryLeading(layout.narrativeFont) : {}),
    })
  } else if (fits(overview, BODY_WIDTH, 5.21 - y, 16)) {
    text(slide, overview, { x: 0.6, y: y + 0.12, w: BODY_WIDTH, h: 5.33 - y }, 16, {
      objectName: `${key}-identity-overview`, ...(comparison.narrative?.summaryVersion === 2 ? summaryLeading(16) : {}),
    })
  }
  candidateLinks(slide, group, comparison, links, key, plan.fullDetails)
}

function warnings(slide: PptxGenJS.Slide, plan: ReviewPlan, key: string, links: ReviewLinks): void {
  if (!plan.warnings.height) return
  const y = CONTENT_BOTTOM - plan.warnings.height
  rectangle(slide, { x: 0.6, y, w: BODY_WIDTH, h: plan.warnings.height }, C.paper, `${key}-qualification-panel`)
  text(slide, plan.warnings.heading, { x: 0.8, y: y + 0.13, w: BODY_WIDTH - 0.4, h: 0.35 }, 14, {
    bold: true, objectName: `${key}-qualification-heading`,
  })
  text(slide, plan.warnings.text, {
    x: 0.8, y: y + 0.53, w: BODY_WIDTH - 0.4, h: plan.warnings.height - 0.56,
  }, 14, { objectName: `${key}-qualification-notes`, ...(plan.warnings.deferred ? { hyperlink: hyperlink(links.analysis) } : {}) })
}

function candidateIdentity(
  comparison: ReportComparison, number: number, width: number, suffix = '', referenceWidth = width,
): { label: string; fontSize: number; reference: boolean } {
  const ending = suffix ? ` · ${suffix}` : ''
  const full = `${readableCandidateName(comparison.candidate)}${ending}`
  const fontSize = [20, 18].find(size => fits(full, width, 0.45, size))
  if (fontSize) return { label: full, fontSize, reference: false }
  const source = `Candidate ${number} · ${comparison.candidate.sourceLabel}${ending}`
  const sourceFont = [20, 18].find(size => fits(source, referenceWidth, 0.45, size))
  if (sourceFont) return { label: source, fontSize: sourceFont, reference: true }
  const label = `Candidate ${number} · ${resumeDocumentReference(comparison)}${ending}`
  const referenceFont = [20, 18].find(size => fits(label, referenceWidth, 0.45, size))
  if (!referenceFont) throw new Error(`PowerPoint cannot fit a readable candidate/source reference. ${LIMIT_MESSAGE}`)
  return { label, fontSize: referenceFont, reference: true }
}

function candidateOverviewLink(slide: PptxGenJS.Slide, destination: number, key: string, y: number): void {
  text(slide, 'Back to candidate overview', { x: 8.8, y, w: BODY_WIDTH - 8.2, h: 0.35 }, 14, {
    color: C.accent, underline: { style: 'sng' }, hyperlink: internalLink(destination), objectName: `${key}-overview-link`,
  })
}

function candidateDetailHeading(
  slide: PptxGenJS.Slide, comparison: ReportComparison, number: number, overviewSlide: number, key: string, keyCriteria: boolean,
): void {
  const identity = candidateIdentity(comparison, number, BODY_WIDTH, keyCriteria ? 'Key criteria' : '', 7.8)
  text(slide, identity.label, { x: 0.6, y: 2.05, w: identity.reference ? 7.8 : BODY_WIDTH, h: 0.45 }, identity.fontSize, {
    bold: true, objectName: `${key}-heading`,
  })
  if (identity.reference) candidateOverviewLink(slide, overviewSlide, key, 2.1)
}

function scorecard(
  deck: ReportDeck, group: ReportGroup, comparison: ReportComparison, links: ReviewLinks,
  plan: ReviewPlan, key: string, reference: string, number: number, overviewSlide: number,
): void {
  const slide = deck.slide(plan.combined ? 'Scorecard & evidence' : 'Scorecard', reference, `${key}-scorecard-name`)
  candidateDetailHeading(slide, comparison, number, overviewSlide, `${key}-scorecard`, plan.keyCriteria)
  table(slide, ['Criterion', 'Weight', 'Score', ...(plan.combined ? ['Evidence'] : [])],
    plan.rows, plan.widths, plan.rowHeights, REVIEW_TABLE_Y, `${key}-scorecard-table`)
  if (plan.criteria.some(criterion => /^[~<]/.test(criterion.weightLabel))) {
    const y = plan.combined && plan.warnings.height ? CONTENT_BOTTOM - plan.warnings.height - 0.55 : CONTENT_BOTTOM - 0.3
    text(slide, WEIGHT_NOTICE, { x: 0.6, y, w: BODY_WIDTH, h: 0.3 }, 11, {
      color: C.muted, objectName: `${key}-weight-note`,
    })
  }
  if (plan.combined) warnings(slide, plan, key, links)
  candidateLinks(slide, group, comparison, links, key, plan.fullDetails)
}

function explanationSlide(
  deck: ReportDeck, group: ReportGroup, comparison: ReportComparison, links: ReviewLinks,
  plan: ReviewPlan, key: string, reference: string, number: number, overviewSlide: number,
): void {
  const slide = deck.slide('Why these scores', reference, `${key}-explanations-name`)
  candidateDetailHeading(slide, comparison, number, overviewSlide, `${key}-explanations`, plan.keyCriteria)
  const rowStarts: number[] = []
  let rowY = REVIEW_TABLE_Y
  for (const rowHeight of explanationRows(plan.explanations, plan.split)) {
    rowStarts.push(rowY)
    rowY += rowHeight + 0.22
  }
  for (const [column, items] of [plan.explanations.slice(0, plan.split), plan.explanations.slice(plan.split)].entries()) {
    for (const [index, item] of items.entries()) {
      const x = 0.6 + column * (EXPLANATION_WIDTH + COLUMN_GAP), y = rowStarts[index]
      text(slide, item.label, { x, y, w: EXPLANATION_WIDTH, h: item.headingHeight }, 14, {
        bold: true, color: C.accent, objectName: `${key}-criterion-${item.criterion.number}-heading`,
        ...(item.deferred ? { hyperlink: hyperlink(links.analysis, item.criterion.label) } : {}),
      })
      text(slide, item.body, {
        x, y: y + item.headingHeight + EXPLANATION_TEXT_GAP, w: EXPLANATION_WIDTH, h: item.bodyHeight,
      }, 14, {
        objectName: `${key}-criterion-${item.criterion.number}-explanation`,
        ...(item.deferred ? { hyperlink: hyperlink(links.analysis, item.criterion.label) } : {}),
      })
    }
  }
  warnings(slide, plan, key, links)
  candidateLinks(slide, group, comparison, links, key, plan.fullDetails)
}

function featuredReview(deck: ReportDeck, group: ReportGroup, comparison: ReportComparison, groupIndex: number, index: number): number {
  const before = deck.slideCount
  const links = deck.links(comparison)
  const key = `review-${groupIndex}-${index}`
  const reference = `${sectionReference(group, groupIndex)} · Candidate ${index + 1}`
  const layout = candidateLayout(comparison)
  const plan = reviewPlan(group, comparison, links, layout.separateNarrative)
  candidateOverview(deck, group, comparison, links, plan, layout, key, reference)
  if (layout.separateNarrative && comparison.narrative?.summaryVersion === 2) {
    const manual = comparison.narrative.approval?.kind === 'manual'
    const blocks: PptxFlowBlock[] = [
      ...candidateNarrativeDisclosures(comparison).map((disclosure, index) => ({ key: `${key}-disclosure-${index}`, text: disclosure })),
      ...(manual ? [{ key: `${key}-summary-text-heading`, text: 'Saved summary text', kind: 'heading' as const, fontSize: 20 }] : []),
      { key: `${key}-summary`, text: candidateNarrativeText(comparison) },
    ]
    const pages = paginatePptxBlocks(blocks, BODY_WIDTH, CONTENT_BOTTOM - 1.82)
    pages.forEach((page, pageIndex) => {
      const slide = deck.slide('', reference)
      text(slide, `${manual ? 'Manually approved summary' : 'Assessment summary'}${pageIndex ? ' (continued)' : ''}`, { x: 0.6, y: 1.12, w: 7.8, h: 0.45 }, 20, {
        bold: true, objectName: `${key}-assessment-name-${pageIndex}`,
      })
      candidateOverviewLink(slide, before + 1, `${key}-assessment-${pageIndex}`, 1.18)
      for (const [fragmentIndex, fragment] of page.fragments.entries()) {
        text(slide, fragment.text, { x: 0.6, y: 1.82 + fragment.y, w: BODY_WIDTH, h: fragment.height }, fragment.fontSize, {
          bold: fragment.kind === 'heading', objectName: `${fragment.key}-part-${pageIndex}-${fragmentIndex}`,
          ...summaryLeading(fragment.fontSize),
        })
      }
      candidateLinks(slide, group, comparison, links, key, plan.fullDetails)
    })
  } else if (layout.separateNarrative) {
    const slide = deck.slide('', reference)
    text(slide, 'Assessment summary', { x: 0.6, y: 1.12, w: 3.65, h: 0.45 }, 20, {
      bold: true, objectName: `${key}-assessment-name`,
    })
    const identity = candidateIdentity(comparison, index + 1, 4.0)
    text(slide, identity.label, { x: 4.5, y: 1.12, w: 4.0, h: 0.45 }, identity.fontSize, {
      bold: true, objectName: `${key}-assessment-heading`,
    })
    candidateOverviewLink(slide, before + 1, `${key}-assessment`, 1.18)
    text(slide, candidateNarrativeText(comparison), {
      x: 0.6, y: 1.82, w: BODY_WIDTH, h: CONTENT_BOTTOM - 1.82,
    }, layout.narrativeFont, { objectName: `${key}-summary` })
    candidateLinks(slide, group, comparison, links, key, plan.fullDetails)
  }
  scorecard(deck, group, comparison, links, plan, key, reference, index + 1, before + 1)
  if (!layout.separateNarrative) explanationSlide(deck, group, comparison, links, plan, key, reference, index + 1, before + 1)
  if (comparison.narrative?.summaryVersion !== 2 && deck.slideCount - before > 3) {
    throw new Error('Legacy PowerPoint candidate reviews must not exceed three slides.')
  }
  return before + 1
}

export async function generatePptxReport(report: AnalysisReport, options?: ReportGenerationOptions): Promise<Uint8Array> {
  const startedAt = Date.now()
  report = snapshotReportPolicy(report)
  const policy = reportGenerationPolicy(report, 'pptx')
  const limits = reportLimits(policy)
  assertReportResourceLimits(report, limits.maxInputBytes)
  requireReportNarratives(report)
  validatedReportLinkContext(report, options)
  const deck = new ReportDeck(report, options, startedAt)
  opening(deck)
  const agenda = reserveAgenda(deck)
  const contentsByTarget = new Map(agenda.flatMap(page => page.entries.map(entry => [entry.group.target.id, page.number] as const)))
  const destinations = new Map<string, number>()
  report.groups.forEach((group, groupIndex) => {
    const contentsSlide = contentsByTarget.get(group.target.id)
    if (contentsSlide === undefined) throw new Error('PowerPoint target is missing from the contents.')
    destinations.set(group.target.id, jobIntroduction(deck, group, groupIndex, contentsSlide))
    const featured = new Set(group.highlightedComparisonIds)
    if (featured.size !== group.highlightedComparisonIds.length || [...featured].some(id =>
      !group.comparisons.some(item => item.id === id && item.status === 'complete' && item.overall.status === 'available'))) {
      throw new Error('PowerPoint highlights must retain the exact completed, scored reviews from the saved target.')
    }
    const candidateOverviews = new Map<string, number>()
    group.comparisons.forEach((comparison, index) => {
      if (featured.has(comparison.id)) candidateOverviews.set(comparison.id, featuredReview(deck, group, comparison, groupIndex, index))
    })
    overview(deck, group, groupIndex, candidateOverviews)
  })
  finishAgenda(deck, agenda, destinations)
  if (policy.additionalFooter) reportNotice(deck, 'Additional report notice', [
    { key: 'footer-human-review', text: HUMAN_REVIEW },
    { key: 'additional-footer', text: policy.additionalFooter },
  ])
  deck.checkBudget()
  const result = await deck.presentation.write({ outputType: 'arraybuffer', compression: true })
  deck.checkBudget()
  if (!(result instanceof ArrayBuffer)) throw new Error('PowerPoint generation did not produce binary report data.')
  const bytes = new Uint8Array(result)
  if (bytes.byteLength > limits.maxOutputBytes) throw new Error(`PowerPoint exceeds the output byte limit. ${LIMIT_MESSAGE}`)
  return bytes
}
