import PptxGenJS from 'pptxgenjs'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import type {
  AnalysisReport, ReportComparison, ReportGenerationOptions, ReportGroup,
} from '../../domain/analysis-reports'
import { reportReviewLinks, validatedReportLinkContext } from './links'
import { assertReportResourceLimits } from './model'
import {
  assertXmlText, overallScoreLabel, REPORT_FONT_FAMILY, REPORT_PALETTE, REPORT_TITLE, reportTitle,
} from './presentation'
import {
  assessmentHighlights, assessmentIntroduction, assessmentSummary, compactReportText, criterionReviews, qualificationNotes,
  readableAnalysisDate, readableCandidateName, readableCompletionNotice, readableJobFacts,
  readableTargetLabel, selectKeyCriteria,
} from './readable'
import type { ReadableCriterion } from './readable'
import { assertPptxBox, measurePptxText, PPTX_LAYOUT } from './pptx-layout'
import type { PptxBox } from './pptx-layout'

const C = REPORT_PALETTE
const BODY_WIDTH = PPTX_LAYOUT.width - 2 * PPTX_LAYOUT.margin
const CONTENT_BOTTOM = 6.22
const LINKS_Y = 6.43
const TABLE_FONT = PPTX_LAYOUT.tableFontSize
const TABLE_PADDING_X = 0.14
const TABLE_PADDING_Y = 0.05
const HEADER_HEIGHT = 0.46
const REVIEW_TABLE_Y = 2.58
const EXPLANATION_Y = 2.58
const COLUMN_GAP = 0.36
const EXPLANATION_WIDTH = (BODY_WIDTH - COLUMN_GAP) / 2
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

function text(
  slide: PptxGenJS.Slide, value: TextValue, box: PptxBox, fontSize = 16,
  options: PptxGenJS.TextPropsOptions = {},
): void {
  const plain = typeof value === 'string' ? value : value.map(run => run.text).join('')
  assertXmlText(plain)
  assertPptxBox(box)
  const height = measurePptxText(plain, box.w, fontSize).height
  if (height > box.h + 0.00001) throw new Error(`PowerPoint text exceeds its readable layout budget. ${LIMIT_MESSAGE}`)
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

function compactToBox(value: string, width: number, height: number, fontSize: number, fallback: string): string {
  if (measurePptxText(value, width, fontSize).height <= height + 0.000001) return value
  let limit = Math.min(Array.from(value).length, 480)
  while (limit >= 16) {
    const candidate = compactReportText(value, limit)
    if (measurePptxText(candidate, width, fontSize).height <= height + 0.000001) return candidate
    limit = Math.floor(limit * 0.82)
  }
  return fallback
}

function linkText(slide: PptxGenJS.Slide, label: string, url: string, box: PptxBox, name: string): void {
  text(slide, label, box, 14, {
    color: C.accent, underline: { style: 'sng' }, hyperlink: hyperlink(url), objectName: name,
  })
}

class ReportDeck {
  readonly presentation = new PptxGenJS()
  private readonly startedAt = Date.now()
  private slideCount = 0

  constructor(readonly report: AnalysisReport, readonly options?: ReportGenerationOptions) {
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
    if (Date.now() - this.startedAt > REPORT_LIMITS.maxGenerationMilliseconds) {
      throw new Error(`PowerPoint generation exceeded the time limit. ${LIMIT_MESSAGE}`)
    }
  }

  slide(
    title: string, reference = '', options: { titleWidth?: number; titleLink?: string; referenceLink?: string; name?: string } = {},
  ): PptxGenJS.Slide {
    this.checkBudget()
    if (this.slideCount >= Math.min(REPORT_LIMITS.maxSlides, REPORT_LIMITS.maxPages)) {
      throw new Error(`PowerPoint exceeds the slide/page limit. ${LIMIT_MESSAGE}`)
    }
    const slide = this.presentation.addSlide()
    this.slideCount++
    slide.background = { color: C.background }
    rectangle(slide, { x: 0.6, y: 0.6, w: 1.35, h: 0.35 }, C.accent, 'score-brand')
    text(slide, 'SCORE', { x: 0.76, y: 0.615, w: 1.04, h: 0.32 }, 12, {
      bold: true, color: C.paper, objectName: 'brand',
    })
    const displayedReference = compactToBox(reference, 6.5, 0.3, 11, 'Analysis evidence')
    text(slide, displayedReference, {
      x: 2.25, y: 0.615, w: 6.5, h: 0.3,
    }, 11, {
      color: C.muted, objectName: 'job-reference',
      ...(options.referenceLink && displayedReference !== reference ? { hyperlink: hyperlink(options.referenceLink, reference) } : {}),
    })
    if (this.report.dataKind === 'sample') {
      text(slide, 'FICTIONAL SAMPLE', { x: 9.0, y: 0.615, w: PPTX_LAYOUT.width - 9.6, h: 0.32 }, 11, {
        bold: true, align: 'right', color: C.accent, objectName: 'report-designation',
      })
    }
    const titleWidth = options.titleWidth ?? BODY_WIDTH
    const displayedTitle = compactToBox(title, titleWidth, 0.8, 36, 'Candidate review')
    text(slide, displayedTitle, {
      x: 0.6, y: 1.12, w: titleWidth, h: 0.8,
    }, 36, {
      bold: true, underline: { style: 'none' }, objectName: options.name ?? 'slide-title',
      ...(options.titleLink && displayedTitle !== title ? { hyperlink: hyperlink(options.titleLink, title) } : {}),
    })
    text(slide, `${this.slideCount}`, { x: 12.21, y: 6.45, w: 0.52, h: 0.3 }, 11, {
      color: C.muted, align: 'right', objectName: 'slide-number',
    })
    return slide
  }

  links(comparison: ReportComparison): ReviewLinks {
    return reportReviewLinks(this.report, comparison, this.options)
  }
}

function jobFacts(slide: PptxGenJS.Slide, group: ReportGroup, y: number): void {
  const width = (BODY_WIDTH - COLUMN_GAP) / 2
  readableJobFacts(group.target, 4).forEach((fact, index) => {
    const x = 0.6 + (index % 2) * (width + COLUMN_GAP)
    const rowY = y + Math.floor(index / 2) * 0.72
    rectangle(slide, { x, y: rowY, w: width, h: 0.62 }, C.paper, `job-fact-${index}-panel`)
    text(slide, compactToBox(fact, width - 0.32, 0.5, 14, 'See the job requirements for details.'), {
      x: x + 0.16, y: rowY + 0.065, w: width - 0.32, h: 0.5,
    }, 14, { objectName: `job-fact-${index}` })
  })
}

function sourceTargetTitle(slide: PptxGenJS.Slide, group: ReportGroup, url: string, y: number): void {
  if (!group.target.displayName) return
  const value = `Source target title: ${group.target.label}`
  const displayed = compactToBox(value, BODY_WIDTH, 0.35, 14, 'View source target title')
  text(slide, displayed, { x: 0.6, y, w: BODY_WIDTH, h: 0.35 }, 14, {
    color: C.muted, objectName: 'source-target-title',
    ...(displayed !== value ? { hyperlink: hyperlink(url, value) } : {}),
  })
}

function opening(deck: ReportDeck): void {
  const report = deck.report
  const single = report.groups.length === 1 ? report.groups[0] : undefined
  const slide = deck.slide(REPORT_TITLE, report.run.name, { referenceLink: deck.links(report.groups[0].comparisons[0]).analysis })
  const jobLabel = single ? readableTargetLabel(report, single) : `${report.groups.length} jobs and grades`
  const targetLink = single ? deck.links(single.comparisons[0]).target : undefined
  const jobHeight = single?.target.displayName ? 0.6 : 0.98
  const displayedJob = compactToBox(jobLabel, BODY_WIDTH, jobHeight, 24, 'Job requirements')
  text(slide, displayedJob, {
    x: 0.6, y: 2.08, w: BODY_WIDTH, h: jobHeight,
  }, 24, {
    bold: true, underline: { style: 'none' }, objectName: 'opening-job',
    ...(targetLink && displayedJob !== jobLabel ? { hyperlink: hyperlink(targetLink, jobLabel) } : {}),
  })
  if (single) sourceTargetTitle(slide, single, targetLink!, 2.75)
  const latestAnalysis = report.groups.flatMap(group => group.comparisons)
    .map(comparison => comparison.analyzedAt).filter((date): date is string => date !== null).sort().at(-1) ?? null
  text(slide, `Analysis date: ${readableAnalysisDate(latestAnalysis) || 'Not recorded'}`, {
    x: 0.6, y: 3.15, w: BODY_WIDTH, h: 0.4,
  }, 14, { color: C.muted, objectName: 'analysis-date' })
  text(slide, readableCompletionNotice(report.counts, report.groups.length > 1), {
    x: 0.6, y: 3.67, w: BODY_WIDTH, h: 0.78,
  }, 18, { objectName: 'completion-notice' })
  if (single) jobFacts(slide, single, 4.6)
  else text(slide, 'Each job has its own candidate overview and evidence reviews.', {
    x: 0.6, y: 4.7, w: BODY_WIDTH, h: 0.8,
  }, 20, { objectName: 'grouped-introduction' })
  text(slide, HUMAN_REVIEW, { x: 0.6, y: 6.12, w: 11.4, h: 0.6 }, 14, {
    color: C.muted, objectName: 'human-review-notice',
  })
}

function jobIntroduction(deck: ReportDeck, group: ReportGroup): void {
  const label = readableTargetLabel(deck.report, group)
  const links = deck.links(group.comparisons[0])
  const slide = deck.slide(group.target.kind === 'grade' ? 'About the grade' : 'About the job', label, { referenceLink: links.target })
  const displayedLabel = compactToBox(label, BODY_WIDTH, 1.2, 28, 'Job requirements')
  text(slide, displayedLabel, {
    x: 0.6, y: 2.14, w: BODY_WIDTH, h: 1.2,
  }, 28, {
    bold: true, objectName: 'target-label',
    ...(displayedLabel !== label ? { hyperlink: hyperlink(links.target, label) } : {}),
  })
  sourceTargetTitle(slide, group, links.target, 3.5)
  jobFacts(slide, group, group.target.displayName ? 4.05 : 3.75)
  linkText(slide, group.target.kind === 'grade' ? 'View grade requirements' : 'View job', links.target, {
    x: 0.6, y: LINKS_Y, w: 3.3, h: 0.35,
  }, 'target-link')
}

interface DeckCell {
  text: string
  url?: string
  tooltip?: string
}

function tableRowHeight(cells: readonly DeckCell[], widths: readonly number[]): number {
  return Math.max(...cells.map((cell, index) =>
    measurePptxText(cell.text, widths[index] - TABLE_PADDING_X * 2, TABLE_FONT).height)) + TABLE_PADDING_Y * 2
}

function table(
  slide: PptxGenJS.Slide, headers: readonly string[], rows: readonly DeckCell[][],
  widths: number[], heights: number[], y: number, name: string,
): void {
  const box = { x: 0.6, y, w: BODY_WIDTH, h: HEADER_HEIGHT + heights.reduce((sum, height) => sum + height, 0) }
  assertPptxBox(box)
  const tableRows: PptxGenJS.TableRow[] = [headers.map(value => ({ text: value })), ...rows].map((row, rowIndex) =>
    row.map((cell: DeckCell) => {
      assertXmlText(cell.text)
      return {
        text: cell.url ? [{ text: cell.text, options: { color: C.accent, hyperlink: hyperlink(cell.url, cell.tooltip) } }] : cell.text,
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

function overview(deck: ReportDeck, group: ReportGroup, groupIndex: number): void {
  const widths = [2.75, 2.35, BODY_WIDTH - 5.1]
  const y = PPTX_LAYOUT.bodyY
  const capacity = CONTENT_BOTTOM - y
  const label = readableTargetLabel(deck.report, group)
  let rows: DeckCell[][] = []
  let heights: number[] = []
  let used = HEADER_HEIGHT
  let page = 0
  const flush = () => {
    const slide = deck.slide('Candidates at a glance', label, { referenceLink: deck.links(group.comparisons[0]).target })
    if (rows.length) table(slide, ['Name', 'Score', 'Assessment highlights'], rows, widths, heights, y, `overview-${groupIndex}-${page}`)
    else text(slide, 'No completed assessments are available for this job yet.', {
      x: 0.6, y, w: BODY_WIDTH, h: 0.8,
    }, 18, { objectName: 'empty-overview' })
    text(slide, 'Select a name to view the full analysis.', { x: 0.6, y: LINKS_Y, w: 9.5, h: 0.35 }, 14, {
      color: C.muted, objectName: 'overview-link-note',
    })
    rows = []
    heights = []
    used = HEADER_HEIGHT
    page++
  }
  for (const comparison of group.comparisons) {
    if (comparison.status !== 'complete') continue
    const name = readableCandidateName(comparison.candidate)
    const links = deck.links(comparison)
    const tooltip = comparison.candidate.displayName
      ? `${name} · Source-stated name: ${comparison.candidate.name ?? 'Not stated'} · Source: ${comparison.candidate.sourceLabel}`
      : name
    const highlights = assessmentHighlights(group.target, comparison, 180)
    const row = [
      {
        text: compactToBox(name, widths[0] - TABLE_PADDING_X * 2, 0.65, TABLE_FONT, 'View candidate name'),
        url: links.analysis, tooltip,
      },
      { text: comparison.overall.status === 'available' ? overallScoreLabel(comparison.overall) : 'Withheld' },
      { text: highlights },
    ]
    const height = tableRowHeight(row, widths)
    if (HEADER_HEIGHT + height > capacity) throw new Error(`PowerPoint overview row exceeds its readable layout budget. ${LIMIT_MESSAGE}`)
    if (rows.length && used + height > capacity) flush()
    rows.push(row)
    heights.push(height)
    used += height
  }
  if (rows.length || !page) flush()
}

interface Explanation {
  criterion: ReadableCriterion
  label: string
  value: string
  height: number
}

interface ReviewPlan {
  criteria: ReadableCriterion[]
  keyCriteria: boolean
  rows: DeckCell[][]
  rowHeights: number[]
  explanations: Explanation[]
  split: number
  notes: string[]
  notesHeight: number
}

const CRITERION_WIDTHS = [8.03, 1.6, BODY_WIDTH - 9.63]

function reviewPlan(group: ReportGroup, comparison: ReportComparison, links: ReviewLinks): ReviewPlan {
  const all = criterionReviews(group.target, comparison, 150)
  const notes = qualificationNotes(comparison, 2, 150)
  const notesHeight = notes.length ? measurePptxText(notes.join('\n'), BODY_WIDTH - 0.4, 14).height + 0.66 : 0
  const available = CONTENT_BOTTOM - EXPLANATION_Y - (notesHeight ? notesHeight + 0.2 : 0)
  for (let count = Math.min(8, all.length); count >= 1; count--) {
    const criteria = count === all.length ? all : selectKeyCriteria(all, count)
    const rows = criteria.map(criterion => {
      const fullLabel = `C${criterion.number} · ${criterion.label}`
      const label = compactToBox(fullLabel, CRITERION_WIDTHS[0] - TABLE_PADDING_X * 2, 0.65, 14,
        `C${criterion.number} · View criterion`)
      return [{
        text: label, ...(label !== fullLabel ? { url: links.analysis, tooltip: fullLabel } : {}),
      }, { text: criterion.weightLabel }, { text: criterion.scoreLabel }]
    })
    const rowHeights = rows.map(row => tableRowHeight(row, CRITERION_WIDTHS))
    const weightNoteHeight = criteria.some(criterion => /^[~<]/.test(criterion.weightLabel)) ? 0.44 : 0
    if (HEADER_HEIGHT + rowHeights.reduce((sum, height) => sum + height, 0) > CONTENT_BOTTOM - REVIEW_TABLE_Y - weightNoteHeight) continue
    const explanations = criteria.map(criterion => {
      const label = criterionHeading(criterion, EXPLANATION_WIDTH)
      const value = `${label} — ${criterion.explanation}`
      return { criterion, label, value, height: measurePptxText(value, EXPLANATION_WIDTH, 14).height + 0.06 }
    })
    const height = (values: Explanation[]) => values.reduce((sum, value) => sum + value.height, 0) + Math.max(0, values.length - 1) * 0.22
    let split = 1
    let best = Infinity
    for (let cut = 1; cut <= explanations.length; cut++) {
      const maximum = Math.max(height(explanations.slice(0, cut)), height(explanations.slice(cut)))
      if (maximum < best) { best = maximum; split = cut }
    }
    if (best <= available) return { criteria, keyCriteria: count < all.length, rows, rowHeights, explanations, split, notes, notesHeight }
  }
  throw new Error(`PowerPoint scorecard cannot fit a readable criterion and qualification summary. ${LIMIT_MESSAGE}`)
}

function candidateLinks(
  slide: PptxGenJS.Slide, group: ReportGroup, links: ReviewLinks, key: string, includeFullScorecard: boolean,
): void {
  const items = [
    { label: 'View analysis', url: links.analysis, x: 0.6, w: 2.1 },
    { label: 'View resume', url: links.resume, x: 2.9, w: 2.0 },
    { label: group.target.kind === 'grade' ? 'View grade requirements' : 'View job', url: links.target, x: 5.1, w: 3.3 },
    ...(includeFullScorecard ? [{ label: 'View full scorecard', url: links.analysis, x: 9.0, w: 3.1 }] : []),
  ]
  items.forEach((item, index) => linkText(slide, item.label, item.url, {
    x: item.x, y: LINKS_Y, w: item.w, h: 0.35,
  }, `${key}-link-${index}`))
}

function criterionHeading(criterion: ReadableCriterion, width: number): string {
  const title = (label: string) => `C${criterion.number} · ${label} · ${criterion.scoreLabel}`
  const full = title(criterion.label)
  if (measurePptxText(full, width, 14).height <= 0.35) return full
  for (let budget = 64; budget >= 16; budget = Math.floor(budget * 0.8)) {
    const compact = title(compactReportText(criterion.label, budget))
    if (measurePptxText(compact, width, 14).height <= 0.35) return compact
  }
  return `C${criterion.number} · ${criterion.scoreLabel}`
}

function needsFullScorecard(plan: ReviewPlan): boolean {
  return plan.keyCriteria || plan.rows.some(row => row[0].url)
    || plan.criteria.some(criterion => /(?:\.{3}|…)$/u.test(criterion.explanation))
}

function overviewExplanations(
  group: ReportGroup, comparison: ReportComparison, selected: readonly ReadableCriterion[], width: number,
): Map<string, string> {
  const explanations = new Map(selected.map(criterion => [criterion.id, criterion.explanation]))
  for (const budget of [88, 72, 56, 48]) {
    const remaining = selected.filter(criterion => measurePptxText(explanations.get(criterion.id)!, width, 14).height > 0.6)
    if (!remaining.length) break
    const reviews = new Map(criterionReviews(group.target, comparison, budget).map(criterion => [criterion.id, criterion]))
    for (const criterion of remaining) explanations.set(criterion.id, reviews.get(criterion.id)!.explanation)
  }
  return new Map([...explanations].map(([id, explanation]) => [
    id, compactToBox(explanation, width, 0.6, 14, 'View the full analysis for the recorded evidence.'),
  ]))
}

function candidateOverview(
  deck: ReportDeck, group: ReportGroup, comparison: ReportComparison, links: ReviewLinks, plan: ReviewPlan, key: string,
): void {
  const name = readableCandidateName(comparison.candidate)
  const slide = deck.slide(name, readableTargetLabel(deck.report, group), {
    titleWidth: 8.55, titleLink: links.analysis, referenceLink: links.target, name: `${key}-overview-name`,
  })
  const metadataWidth = 8.55
  const alias = comparison.candidate.displayName !== undefined
  const metadataHeight = alias ? 0.34 : 0.39
  const metadataFont = alias ? 14 : 15
  for (const [index, item] of [
    { value: comparison.candidate.role ? `Role: ${comparison.candidate.role}` : 'Role not recorded', url: links.analysis },
    { value: `Source: ${comparison.candidate.sourceLabel}`, url: links.resume },
    ...(alias ? [{ value: `Source-stated name: ${comparison.candidate.name ?? 'Not stated'}`, url: links.resume }] : []),
  ].entries()) {
    const displayed = compactToBox(item.value, metadataWidth, metadataHeight, metadataFont, index ? 'View resume source' : 'View recorded role')
    text(slide, displayed, {
      x: 0.6, y: 2.0 + index * (alias ? 0.36 : 0.46), w: metadataWidth, h: metadataHeight,
    }, metadataFont, {
      color: C.muted, objectName: `${key}-metadata-${index}`,
      ...(displayed !== item.value ? { hyperlink: hyperlink(item.url, item.value) } : {}),
    })
  }
  const scoreBox = { x: 9.55, y: 1.16, w: BODY_WIDTH - 8.95, h: 1.64 }
  rectangle(slide, scoreBox, C.text, `${key}-score-panel`)
  text(slide, 'Overall score', { x: scoreBox.x + 0.2, y: 1.34, w: scoreBox.w - 0.4, h: 0.35 }, 14, { color: C.paper })
  const score = comparison.overall.status === 'available' ? overallScoreLabel(comparison.overall) : 'Withheld'
  const scoreFont = score.length > 15 ? 16 : 28
  text(slide, score, { x: scoreBox.x + 0.2, y: 1.88, w: scoreBox.w - 0.4, h: 0.65 }, scoreFont, {
    bold: true, color: C.paper, objectName: `${key}-overall-score`,
  })
  if (comparison.overall.status === 'available') {
    const track = { x: scoreBox.x + 0.2, y: 2.56, w: scoreBox.w - 0.4, h: 0.08 }
    rectangle(slide, track, C.border, `${key}-score-track`)
    const width = track.w * comparison.overall.score / 100
    if (width >= 1 / 914400) rectangle(slide, { ...track, w: width }, C.accent, `${key}-score-value`)
  }
  const introduction = assessmentIntroduction(comparison, 320)
  const summaryWidth = introduction ? 6.4 : BODY_WIDTH
  rectangle(slide, { x: 0.6, y: 3.11, w: summaryWidth, h: 2.99 }, C.paper, `${key}-summary-panel`)
  text(slide, 'Assessment summary', { x: 0.8, y: 3.32, w: summaryWidth - 0.4, h: 0.43 }, 18, {
    bold: true, objectName: `${key}-summary-heading`,
  })
  text(slide, compactToBox(introduction ?? assessmentSummary(group.target, comparison, 360), summaryWidth - 0.4, 2.03, 16,
    'See the full analysis for the recorded assessment.'), {
    x: 0.8, y: 3.86, w: summaryWidth - 0.4, h: 2.03,
  }, 16, { objectName: `${key}-summary` })
  if (!introduction) {
    candidateLinks(slide, group, links, key, needsFullScorecard(plan))
    return
  }
  const highlightsX = 0.6 + summaryWidth + COLUMN_GAP
  const highlightsWidth = BODY_WIDTH - summaryWidth - COLUMN_GAP
  rectangle(slide, { x: highlightsX, y: 3.11, w: highlightsWidth, h: 2.99 }, C.paper, `${key}-highlights-panel`)
  text(slide, 'Strengths & gaps', { x: highlightsX + 0.2, y: 3.32, w: highlightsWidth - 0.4, h: 0.43 }, 18, {
    bold: true, objectName: `${key}-highlights-heading`,
  })
  const selected = selectKeyCriteria(plan.criteria, 2)
  const explanations = overviewExplanations(group, comparison, selected, highlightsWidth - 0.4)
  selected.forEach((criterion, index) => {
    const y = 3.88 + index * 1.04
    const fullLabel = `C${criterion.number} · ${criterion.label} · ${criterion.scoreLabel}`
    const label = criterionHeading(criterion, highlightsWidth - 0.4)
    text(slide, label, { x: highlightsX + 0.2, y, w: highlightsWidth - 0.4, h: 0.35 }, 14, {
      bold: true, color: C.accent, objectName: `${key}-highlight-${index}-label`,
      ...(label !== fullLabel ? { hyperlink: hyperlink(links.analysis, criterion.label) } : {}),
    })
    text(slide, explanations.get(criterion.id)!, {
      x: highlightsX + 0.2, y: y + 0.41, w: highlightsWidth - 0.4, h: 0.6,
    }, 14, { objectName: `${key}-highlight-${index}-rationale` })
  })
  candidateLinks(slide, group, links, key, needsFullScorecard(plan))
}

function scorecard(
  deck: ReportDeck, group: ReportGroup, comparison: ReportComparison, links: ReviewLinks, plan: ReviewPlan, key: string,
): void {
  const slide = deck.slide(readableCandidateName(comparison.candidate), readableTargetLabel(deck.report, group), {
    titleLink: links.analysis, referenceLink: links.target, name: `${key}-scorecard-name`,
  })
  text(slide, plan.keyCriteria ? 'Scorecard · Key criteria' : 'Scorecard', {
    x: 0.6, y: 2.05, w: BODY_WIDTH, h: 0.45,
  }, 20, { bold: true, objectName: `${key}-scorecard-heading` })
  table(slide, ['Criterion', 'Weight', 'Score'], plan.rows, [...CRITERION_WIDTHS], plan.rowHeights,
    REVIEW_TABLE_Y, `${key}-scorecard-table`)
  if (plan.criteria.some(criterion => /^[~<]/.test(criterion.weightLabel))) {
    text(slide, WEIGHT_NOTICE, { x: 0.6, y: 5.94, w: BODY_WIDTH, h: 0.3 }, 11, {
      color: C.muted, objectName: `${key}-weight-note`,
    })
  }
  candidateLinks(slide, group, links, key, needsFullScorecard(plan))
}

function explanationSlide(
  deck: ReportDeck, group: ReportGroup, comparison: ReportComparison, links: ReviewLinks, plan: ReviewPlan, key: string,
): void {
  const slide = deck.slide(readableCandidateName(comparison.candidate), readableTargetLabel(deck.report, group), {
    titleLink: links.analysis, referenceLink: links.target, name: `${key}-explanations-name`,
  })
  text(slide, plan.keyCriteria ? 'Why these scores · Key criteria' : 'Why these scores', {
    x: 0.6, y: 2.05, w: 7.7, h: 0.45,
  }, 20, { bold: true, objectName: `${key}-explanations-heading` })
  text(slide, 'Concise explanations', { x: 8.65, y: 2.12, w: BODY_WIDTH - 8.05, h: 0.35 }, 14, {
    color: C.muted, objectName: `${key}-explanations-note`,
  })
  for (const [column, explanations] of [plan.explanations.slice(0, plan.split), plan.explanations.slice(plan.split)].entries()) {
    let y = EXPLANATION_Y
    for (const explanation of explanations) {
      text(slide, [
        {
          text: `${explanation.label} — `,
          options: {
            bold: true, color: C.accent,
            ...(explanation.label !== `C${explanation.criterion.number} · ${explanation.criterion.label} · ${explanation.criterion.scoreLabel}`
              ? { hyperlink: hyperlink(links.analysis, explanation.criterion.label) } : {}),
          },
        },
        { text: explanation.criterion.explanation },
      ], { x: 0.6 + column * (EXPLANATION_WIDTH + COLUMN_GAP), y, w: EXPLANATION_WIDTH, h: explanation.height }, 14, {
        objectName: `${key}-criterion-${explanation.criterion.number}-explanation`,
      })
      y += explanation.height + 0.22
    }
  }
  if (plan.notes.length) {
    const y = CONTENT_BOTTOM - plan.notesHeight
    rectangle(slide, { x: 0.6, y, w: BODY_WIDTH, h: plan.notesHeight }, C.paper, `${key}-qualification-panel`)
    text(slide, 'Unscored qualification caveats', { x: 0.8, y: y + 0.13, w: BODY_WIDTH - 0.4, h: 0.35 }, 14, {
      bold: true, objectName: `${key}-qualification-heading`,
    })
    text(slide, plan.notes.join('\n'), {
      x: 0.8, y: y + 0.53, w: BODY_WIDTH - 0.4, h: plan.notesHeight - 0.56,
    }, 14, { objectName: `${key}-qualification-notes` })
  }
  candidateLinks(slide, group, links, key, needsFullScorecard(plan))
}

export async function generatePptxReport(report: AnalysisReport, options?: ReportGenerationOptions): Promise<Uint8Array> {
  assertReportResourceLimits(report)
  const deck = new ReportDeck(report, options)
  validatedReportLinkContext(report, options)
  opening(deck)
  report.groups.forEach((group, groupIndex) => {
    if (report.groups.length > 1) jobIntroduction(deck, group)
    overview(deck, group, groupIndex)
    const featured = new Set(group.highlightedComparisonIds)
    group.comparisons.forEach((comparison, index) => {
      if (comparison.status !== 'complete' || !featured.has(comparison.id)) return
      const links = deck.links(comparison)
      const key = `review-${groupIndex}-${index}`
      const plan = reviewPlan(group, comparison, links)
      candidateOverview(deck, group, comparison, links, plan, key)
      scorecard(deck, group, comparison, links, plan, key)
      explanationSlide(deck, group, comparison, links, plan, key)
    })
  })
  deck.checkBudget()
  const result = await deck.presentation.write({ outputType: 'arraybuffer', compression: true })
  deck.checkBudget()
  if (!(result instanceof ArrayBuffer)) throw new Error('PowerPoint generation did not produce binary report data.')
  const bytes = new Uint8Array(result)
  if (bytes.byteLength > REPORT_LIMITS.maxOutputBytes) throw new Error(`PowerPoint exceeds the output byte limit. ${LIMIT_MESSAGE}`)
  return bytes
}
