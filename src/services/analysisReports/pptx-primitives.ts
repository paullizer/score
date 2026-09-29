import PptxGenJS from 'pptxgenjs'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import { assertXmlText, REPORT_FONT_FAMILY, REPORT_PALETTE } from './presentation'
import { assertPptxBox, measurePptxText, PPTX_LAYOUT } from './pptx-layout'
import type { PptxBox } from './pptx-layout'
import type { reportLimits } from './policy'

export const C = REPORT_PALETTE
export const BODY_WIDTH = PPTX_LAYOUT.width - 2 * PPTX_LAYOUT.margin
export const CONTENT_BOTTOM = PPTX_LAYOUT.bodyBottom
export const LINKS_Y = 6.55
export const TABLE_FONT = PPTX_LAYOUT.tableFontSize
export const TABLE_PADDING_X = 0.14
export const TABLE_PADDING_Y = 0.05
export const HEADER_HEIGHT = 0.46
export const COLUMN_GAP = 0.36
export const LIMIT_MESSAGE = 'Narrow the export to one exact job/grade target; the export was not generated.'

export type TextValue = string | PptxGenJS.TextProps[]

export function hyperlink(url: string, tooltip?: string): PptxGenJS.HyperlinkProps {
  assertXmlText(url, 'Review link')
  if (tooltip) assertXmlText(tooltip, 'Review link description')
  return { url, ...(tooltip ? { tooltip } : {}) }
}

export function internalLink(slide: number): PptxGenJS.HyperlinkProps {
  if (!Number.isInteger(slide) || slide < 1) throw new Error('PowerPoint navigation has no valid destination.')
  return { slide }
}

export function height(value: string, width: number, fontSize: number): number {
  return measurePptxText(value, width, fontSize).height
}

export function fits(value: string, width: number, available: number, fontSize: number): boolean {
  return height(value, width, fontSize) <= available + 0.000001
}

export function summaryLeading(fontSize: number): PptxGenJS.TextPropsOptions {
  // Percentage leading varies with a viewer's font metrics; point leading matches the paginator.
  return { lineSpacingMultiple: undefined, lineSpacing: fontSize * PPTX_LAYOUT.lineHeight }
}

export function text(
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

export function rectangle(slide: PptxGenJS.Slide, box: PptxBox, color: string, name: string): void {
  assertPptxBox(box)
  slide.addShape('rect', { ...box, objectName: name, fill: { color }, line: { color, width: 0 } })
}

export function linkText(
  slide: PptxGenJS.Slide, label: string, url: string, box: PptxBox, name: string, tooltip?: string,
): void {
  text(slide, label, box, 14, {
    color: C.accent, underline: { style: 'sng' }, hyperlink: hyperlink(url, tooltip), objectName: name,
  })
}

export interface DeckCell {
  text: string
  url?: string
  tooltip?: string
  runs?: PptxGenJS.TextProps[]
}

export function tableRowHeight(cells: readonly DeckCell[], widths: readonly number[]): number {
  return Math.max(...cells.map((cell, index) =>
    height(cell.text, widths[index] - TABLE_PADDING_X * 2, TABLE_FONT))) + TABLE_PADDING_Y * 2
}

export function uniformRowHeights(heights: readonly number[]): number[] {
  const maximum = Math.max(...heights)
  return heights.map(() => maximum)
}

export function table(
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

export interface SlideDeckMetadata {
  title: string
  subject: string
}

/** Score-branded wide slides with the captured slide and time budgets. */
export class SlideDeck {
  readonly presentation = new PptxGenJS()
  slideCount = 0

  constructor(
    readonly limits: ReturnType<typeof reportLimits>, private readonly startedAt: number,
    metadata: SlideDeckMetadata, private readonly limitMessage = LIMIT_MESSAGE,
  ) {
    this.presentation.layout = 'LAYOUT_WIDE'
    this.presentation.author = 'Score'
    this.presentation.subject = metadata.subject
    assertXmlText(metadata.title)
    this.presentation.title = metadata.title
    this.presentation.company = 'Score'
    this.presentation.theme = { headFontFace: REPORT_FONT_FAMILY, bodyFontFace: REPORT_FONT_FAMILY }
  }

  checkBudget(): void {
    if (Date.now() - this.startedAt > this.limits.maxGenerationMilliseconds) {
      throw new Error(`PowerPoint generation exceeded the time limit. ${this.limitMessage}`)
    }
  }

  slide(title: string, reference = '', name = 'slide-title', fontSize = 36): PptxGenJS.Slide {
    this.checkBudget()
    if (this.slideCount >= Math.min(this.limits.maxSlides, REPORT_LIMITS.maxPages)) {
      throw new Error(`PowerPoint exceeds the slide/page limit. ${this.limitMessage}`)
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
}
