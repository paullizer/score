import {
  beginText, endText, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, popGraphicsState, pushGraphicsState,
  rgb, setFillingColor, setFontAndSize, setTextMatrix, showText,
} from 'pdf-lib'
import type { Color, PDFDocument, PDFFont, PDFPage } from 'pdf-lib'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import { REPORT_PALETTE } from './presentation'

export const PDF_REPORT_PAGE = {
  width: 612, height: 792, margin: 46, bodyTop: 685, bodyBottom: 66,
} as const

export const PDF_REPORT_WIDTH = PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin * 2

function color(hex: string): Color {
  return rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255)
}

export const PDF_REPORT_COLORS = {
  background: color(REPORT_PALETTE.background),
  paper: color(REPORT_PALETTE.paper),
  text: color(REPORT_PALETTE.text),
  accent: color(REPORT_PALETTE.accent),
  muted: color(REPORT_PALETTE.muted),
  border: color(REPORT_PALETTE.border),
} as const

export interface PdfReportFonts {
  regular: PDFFont
  bold: PDFFont
}

interface TextLine {
  text: string
  source: string
}

interface TextStyle {
  size?: number
  leading?: number
  bold?: boolean
  color?: Color
  padding?: number
  background?: Color
  rule?: boolean
  before?: number
  after?: number
  keepWithNext?: number
  keepTailWithNext?: boolean
}

interface PageIdentity {
  section: string
  primary: string
  secondary: string
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const printable = (text: string) => text.replace(/\t/g, '    ')

export function wrapPdfText(
  text: string, font: PDFFont, size: number, width: number,
  measureText: (text: string) => number = value => font.widthOfTextAtSize(printable(value), size),
): TextLine[] {
  const lines: TextLine[] = []
  const measure = measureText
  const parts = text.split(/(\r\n|[\r\n\u0085\u2028\u2029])/u)
  for (let partIndex = 0; partIndex < parts.length; partIndex += 2) {
    const part = parts[partIndex]
    let line = ''
    const appendLine = () => { lines.push({ text: line, source: line }); line = '' }
    for (const token of part.match(/\S+|[^\S\r\n]+/gu) ?? []) {
      if (measure(line + token) <= width) {
        line += token
        continue
      }
      if (line) appendLine()
      if (measure(token) <= width) {
        line = token
        continue
      }
      // Split oversized tokens by grapheme, not UTF-16 code unit, without dropping characters.
      const graphemes = Array.from(segmenter.segment(token), value => value.segment)
      let offset = 0
      while (offset < graphemes.length) {
        let low = 0
        let high = 1
        const remaining = graphemes.length - offset
        while (high < remaining && measure(graphemes.slice(offset, offset + high).join('')) <= width) {
          low = high
          high = Math.min(remaining, high * 2)
        }
        while (low < high) {
          const middle = Math.ceil((low + high) / 2)
          if (measure(graphemes.slice(offset, offset + middle).join('')) <= width) low = middle
          else high = middle - 1
        }
        if (!low) throw new Error('A PDF text grapheme is wider than its available column. Use another report format; no evidence has been omitted.')
        line = graphemes.slice(offset, offset + low).join('')
        offset += low
        if (offset < graphemes.length) appendLine()
      }
    }
    appendLine()
    if (parts[partIndex + 1]) lines[lines.length - 1].source += parts[partIndex + 1]
  }
  return lines
}

function compactHeader(text: string, measure: (text: string) => number): string {
  const oneLine = text.replace(/[\r\n\t\u0085\u2028\u2029]+/gu, ' ')
  if (measure(oneLine) <= PDF_REPORT_WIDTH) return oneLine
  const graphemes = Array.from(segmenter.segment(oneLine), value => value.segment)
  let low = 0
  let high = graphemes.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measure(`${graphemes.slice(0, middle).join('')}…`) <= PDF_REPORT_WIDTH) low = middle
    else high = middle - 1
  }
  return `${graphemes.slice(0, low).join('')}…`
}

export class PdfReportLayout {
  private page!: PDFPage
  private y: number = PDF_REPORT_PAGE.bodyTop
  private identity!: PageIdentity
  private readonly startedAt = Date.now()
  private readonly characters = new Map<PDFFont, Set<number>>()
  private readonly fontKeys = new WeakMap<PDFPage, Map<PDFFont, PDFName>>()
  private readonly fontRuns = new Map<PDFFont, Map<string, { width: number; encoded?: PDFHexString }>>()

  constructor(
    readonly document: PDFDocument,
    readonly fonts: PdfReportFonts,
    private readonly designation: string,
  ) {
    for (const font of Object.values(fonts)) {
      this.characters.set(font, new Set(font.getCharacterSet()))
      this.fontRuns.set(font, new Map())
    }
  }

  private fontRun(text: string, font: PDFFont): { width: number; encoded?: PDFHexString } {
    const value = printable(text)
    const cache = this.fontRuns.get(font)!
    let run = cache.get(value)
    if (run) cache.delete(value)
    else run = { width: font.widthOfTextAtSize(value, 1) }
    // Bounded, per-document caches are discarded with the export, never retained across reports.
    if (value.length <= 1024) {
      if (cache.size >= 4096) cache.delete(cache.keys().next().value!)
      cache.set(value, run)
    }
    return run
  }

  private measure(text: string, font: PDFFont, size: number): number {
    return this.fontRun(text, font).width * size
  }

  private wrap(text: string, font: PDFFont, size: number, width: number): TextLine[] {
    return wrapPdfText(text, font, size, width, value => this.measure(value, font, size))
  }

  startSection(identity: PageIdentity): void {
    this.identity = identity
    this.newPage()
  }

  checkTime(): void {
    if (Date.now() - this.startedAt > REPORT_LIMITS.maxGenerationMilliseconds) {
      throw new Error('PDF generation exceeded the report time limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.')
    }
  }

  private newPage(): void {
    this.checkTime()
    if (this.document.getPageCount() >= REPORT_LIMITS.maxPages) {
      throw new Error(`PDF exceeds the ${REPORT_LIMITS.maxPages}-page resource limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.`)
    }
    this.page = this.document.addPage([PDF_REPORT_PAGE.width, PDF_REPORT_PAGE.height])
    this.y = PDF_REPORT_PAGE.bodyTop
    this.page.drawRectangle({
      x: 0, y: 704, width: PDF_REPORT_PAGE.width, height: 88, color: PDF_REPORT_COLORS.background,
    })
    this.drawText('Score', PDF_REPORT_PAGE.margin, 765, 13, this.fonts.bold, PDF_REPORT_COLORS.accent)
    const badge = `${this.designation} · ${this.identity.section}`
    this.drawText(badge, PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin - this.measure(badge, this.fonts.regular, 8.5),
      766, 8.5, this.fonts.regular, PDF_REPORT_COLORS.muted)
    this.page.drawLine({
      start: { x: PDF_REPORT_PAGE.margin, y: 751 }, end: { x: PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin, y: 751 },
      color: PDF_REPORT_COLORS.border, thickness: 0.6,
    })
    this.drawText(compactHeader(this.identity.primary, value => this.measure(value, this.fonts.bold, 9.5)),
      PDF_REPORT_PAGE.margin, 734, 9.5, this.fonts.bold, PDF_REPORT_COLORS.text)
    this.drawText(compactHeader(this.identity.secondary, value => this.measure(value, this.fonts.regular, 9)),
      PDF_REPORT_PAGE.margin, 718, 9, this.fonts.regular, PDF_REPORT_COLORS.muted)
  }

  private ensureSpace(height: number): void {
    if (this.y - height < PDF_REPORT_PAGE.bodyBottom) this.newPage()
  }

  private drawText(text: string, x: number, baseline: number, size: number, font: PDFFont, fill: Color, source = text): void {
    if (!text && !source) return
    for (const character of printable(text)) {
      const code = character.codePointAt(0)!
      if (!this.characters.get(font)!.has(code)) {
        throw new Error(`The local PDF font cannot render U+${code.toString(16).toUpperCase().padStart(4, '0')}. Use another report format or a locally licensed font supporting this character; no source text was substituted.`)
      }
    }
    // ActualText retains source whitespace and combining sequences alongside embedded ToUnicode text.
    let fonts = this.fontKeys.get(this.page)
    if (!fonts) { fonts = new Map(); this.fontKeys.set(this.page, fonts) }
    let key = fonts.get(font)
    if (!key) { key = this.page.node.newFontDictionary(font.name, font.ref); fonts.set(font, key) }
    const run = this.fontRun(text || ' ', font)
    run.encoded ??= font.encodeText(printable(text) || ' ')
    this.page.pushOperators(
      pushGraphicsState(), setFillingColor(fill), beginText(), setFontAndSize(key, size),
      setTextMatrix(1, 0, 0, 1, x, baseline),
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
        PDFName.of('Span'), `<< /ActualText ${PDFHexString.fromText(source)} >>`,
      ]),
      showText(run.encoded), PDFOperator.of(PDFOperatorNames.EndMarkedContent), endText(), popGraphicsState(),
    )
  }

  paragraph(text: string, style: TextStyle = {}): void {
    const size = style.size ?? 10
    const leading = style.leading ?? Math.ceil(size * 1.5)
    const font = style.bold ? this.fonts.bold : this.fonts.regular
    const padding = style.padding ?? 0
    const after = style.after ?? 8
    const keepWithNext = style.keepWithNext ? style.keepWithNext + after : 0
    const lines = this.wrap(text, font, size, PDF_REPORT_WIDTH - padding * 2)
    this.y -= style.before ?? 0
    const height = lines.length * leading + padding * 2
    const bodyHeight = PDF_REPORT_PAGE.bodyTop - PDF_REPORT_PAGE.bodyBottom
    this.ensureSpace(Math.min(height, leading * 2 + padding * 2) +
      (!style.keepTailWithNext && height + keepWithNext <= bodyHeight ? keepWithNext : 0))
    let offset = 0
    while (offset < lines.length) {
      let capacity = Math.floor((this.y - PDF_REPORT_PAGE.bodyBottom - padding * 2) / leading)
      let carryingTail = false
      const remaining = lines.length - offset
      if (remaining <= capacity && remaining * leading + padding * 2 + keepWithNext > this.y - PDF_REPORT_PAGE.bodyBottom) {
        if (remaining > 2 && (style.keepTailWithNext || remaining * leading + padding * 2 + keepWithNext > bodyHeight)) {
          capacity = remaining - 2
          carryingTail = true
        } else {
          this.newPage()
          continue
        }
      }
      if (capacity < (carryingTail ? 1 : Math.min(2, remaining))) {
        this.newPage()
        continue
      }
      if (remaining > capacity && remaining - capacity === 1 && capacity > 2) capacity--
      const count = Math.min(capacity, remaining)
      const chunkHeight = count * leading + padding * 2
      if (style.background) this.page.drawRectangle({
        x: PDF_REPORT_PAGE.margin, y: this.y - chunkHeight, width: PDF_REPORT_WIDTH, height: chunkHeight, color: style.background,
      })
      if (style.rule) this.page.drawLine({
        start: { x: PDF_REPORT_PAGE.margin, y: this.y },
        end: { x: PDF_REPORT_PAGE.margin, y: this.y - chunkHeight },
        color: PDF_REPORT_COLORS.accent, thickness: 2,
      })
      const ascent = font.heightAtSize(size, { descender: false })
      for (let index = 0; index < count; index++) {
        const line = lines[offset + index]
        this.drawText(line.text, PDF_REPORT_PAGE.margin + padding, this.y - padding - ascent - index * leading,
          size, font, style.color ?? PDF_REPORT_COLORS.text, line.source)
      }
      this.y -= chunkHeight
      offset += count
      if (offset < lines.length) this.newPage()
    }
    this.y -= after
  }

  heading(text: string, size = 14): void {
    this.paragraph(text, { size, bold: true, color: PDF_REPORT_COLORS.accent, before: 9, after: 7, keepWithNext: 30 })
  }

  label(text: string): void {
    this.paragraph(text, { bold: true, after: 4, keepWithNext: 30 })
  }

  callout(text: string, bold = false): void {
    this.paragraph(text, { bold, padding: 10, background: PDF_REPORT_COLORS.background, rule: true, after: 10 })
  }

  citation(label: string, quote: string, locator: string): void {
    const bodyHeight = PDF_REPORT_PAGE.bodyTop - PDF_REPORT_PAGE.bodyBottom
    const quoteHeight = this.wrap(quote, this.fonts.regular, 10, PDF_REPORT_WIDTH - 20).length * 15 + 20
    const labelHeight = this.wrap(label, this.fonts.bold, 10, PDF_REPORT_WIDTH).length * 15
    const locatorHeight = this.wrap(locator, this.fonts.regular, 9.5, PDF_REPORT_WIDTH).length * 14
    const locatorReserve = locatorHeight <= bodyHeight - 55 ? locatorHeight : 28
    const groupHeight = quoteHeight + 5 + locatorReserve
    this.paragraph(label, {
      bold: true, after: 4,
      keepWithNext: labelHeight + 4 + groupHeight <= bodyHeight ? groupHeight : Math.min(quoteHeight, 50),
    })
    this.paragraph(quote, {
      padding: 10, background: PDF_REPORT_COLORS.background, rule: true, after: 5,
      keepWithNext: locatorReserve, keepTailWithNext: true,
    })
    this.paragraph(locator, { size: 9.5, leading: 14, color: PDF_REPORT_COLORS.muted, after: 10 })
  }

  metadata(entries: string[]): void {
    const rows: string[] = []
    let row = ''
    const flush = () => { if (row) rows.push(row); row = '' }
    for (const entry of entries) {
      if (/[\r\n\u0085\u2028\u2029]/u.test(entry) || this.measure(entry, this.fonts.regular, 9.5) > PDF_REPORT_WIDTH) {
        flush()
        rows.push(entry)
        continue
      }
      const combined = row ? `${row} · ${entry}` : entry
      if (this.measure(combined, this.fonts.regular, 9.5) > PDF_REPORT_WIDTH) {
        flush()
        row = entry
      } else row = combined
    }
    flush()
    if (rows.length) this.paragraph(rows.join('\n'), { size: 9.5, leading: 14, after: 6 })
  }

  table(headers: string[], rows: string[][], widths: number[]): void {
    if (!rows.length) return
    if (headers.length !== widths.length || Math.abs(widths.reduce((sum, width) => sum + width, 0) - PDF_REPORT_WIDTH) > 0.01 ||
      rows.some(row => row.length !== headers.length)) throw new Error('Invalid PDF report table layout.')
    const size = 9.5
    const leading = 14
    const padding = 7
    const headerLines = headers.map((header, index) => this.wrap(header, this.fonts.bold, size, widths[index] - padding * 2))
    const headerHeight = Math.max(...headerLines.map(lines => lines.length)) * leading + padding * 2
    const drawCells = (cells: TextLine[][], offset: number, count: number, isHeader: boolean, shaded: boolean) => {
      const height = count * leading + padding * 2
      this.page.drawRectangle({
        x: PDF_REPORT_PAGE.margin, y: this.y - height, width: PDF_REPORT_WIDTH, height,
        color: isHeader ? PDF_REPORT_COLORS.text : shaded ? PDF_REPORT_COLORS.background : PDF_REPORT_COLORS.paper,
      })
      const font = isHeader ? this.fonts.bold : this.fonts.regular
      const ascent = font.heightAtSize(size, { descender: false })
      let x: number = PDF_REPORT_PAGE.margin
      for (let cell = 0; cell < cells.length; cell++) {
        for (let line = 0; line < count; line++) {
          const value = cells[cell][offset + line]
          if (value) this.drawText(value.text, x + padding, this.y - padding - ascent - line * leading,
            size, font, isHeader ? PDF_REPORT_COLORS.paper : PDF_REPORT_COLORS.text, value.source)
        }
        x += widths[cell]
      }
      this.y -= height
      this.page.drawLine({
        start: { x: PDF_REPORT_PAGE.margin, y: this.y }, end: { x: PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin, y: this.y },
        thickness: 0.5, color: PDF_REPORT_COLORS.border,
      })
    }
    const drawHeader = () => drawCells(headerLines, 0, (headerHeight - padding * 2) / leading, true, false)
    const continueTable = () => { this.newPage(); drawHeader() }
    this.ensureSpace(headerHeight + leading * 2 + padding * 2)
    drawHeader()
    rows.forEach((row, rowIndex) => {
      const cells = row.map((value, index) => this.wrap(value, this.fonts.regular, size, widths[index] - padding * 2))
      const length = Math.max(...cells.map(lines => lines.length))
      const rowHeight = length * leading + padding * 2
      if (rowHeight <= PDF_REPORT_PAGE.bodyTop - PDF_REPORT_PAGE.bodyBottom - headerHeight &&
        rowHeight > this.y - PDF_REPORT_PAGE.bodyBottom) continueTable()
      let offset = 0
      while (offset < length) {
        const capacity = Math.floor((this.y - PDF_REPORT_PAGE.bodyBottom - padding * 2) / leading)
        if (capacity < Math.min(2, length - offset)) {
          continueTable()
          continue
        }
        const count = Math.min(capacity, length - offset)
        drawCells(cells, offset, count, false, rowIndex % 2 === 0)
        offset += count
        if (offset < length) continueTable()
      }
    })
    this.y -= 10
  }

  finish(): void {
    const pages = this.document.getPages()
    pages.forEach((page, index) => {
      this.page = page
      page.drawLine({
        start: { x: PDF_REPORT_PAGE.margin, y: 53 }, end: { x: PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin, y: 53 },
        color: PDF_REPORT_COLORS.border, thickness: 0.6,
      })
      this.drawText(`${this.designation} · Evidence for human review`, PDF_REPORT_PAGE.margin, 39, 8.5, this.fonts.regular, PDF_REPORT_COLORS.muted)
      const pageNumber = `Page ${index + 1} of ${pages.length}`
      this.drawText(pageNumber, PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin - this.measure(pageNumber, this.fonts.regular, 8.5),
        39, 8.5, this.fonts.regular, PDF_REPORT_COLORS.muted)
      this.drawText('Not a hiring recommendation or official GS eligibility finding.', PDF_REPORT_PAGE.margin, 25, 8.5, this.fonts.regular, PDF_REPORT_COLORS.muted)
    })
    this.checkTime()
  }
}
