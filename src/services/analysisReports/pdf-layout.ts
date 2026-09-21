import {
  beginText, endText, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, PDFString, popGraphicsState, pushGraphicsState,
  rgb, setFillingColor, setFontAndSize, setTextMatrix, showText,
} from 'pdf-lib'
import type { Color, PDFDocument, PDFFont, PDFPage } from 'pdf-lib'
import { REPORT_LIMITS, type ReportPolicy } from '../../domain/analysis-reports'
import { REPORT_PALETTE } from './presentation'
import { DOCUMENT_REPORT_PAGE, DOCUMENT_REPORT_WIDTH, documentMetadataText } from './document-layout'
import type {
  DocumentContentsEntry, DocumentPageIdentity, DocumentReportLayout, DocumentReportLink,
  DocumentTableCell, DocumentTextLink, DocumentTextStyle,
} from './document-layout'

export const PDF_REPORT_PAGE = DOCUMENT_REPORT_PAGE
export const PDF_REPORT_WIDTH = DOCUMENT_REPORT_WIDTH

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

export type PdfReportLink = DocumentReportLink
type TableCell = DocumentTableCell
type TextLink = DocumentTextLink
type ContentsEntry = DocumentContentsEntry

interface TextLine {
  text: string
  source: string
}

type TextStyle = DocumentTextStyle<Color>
type PageIdentity = DocumentPageIdentity

const PRIMARY_HEADER_SIZE = 9.5
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

export class PdfReportLayout implements DocumentReportLayout<Color> {
  readonly colors = PDF_REPORT_COLORS
  private page!: PDFPage
  private y: number = PDF_REPORT_PAGE.bodyTop
  private identity!: PageIdentity
  private readonly startedAt = Date.now()
  private readonly characters = new Map<PDFFont, Set<number>>()
  private readonly fontKeys = new WeakMap<PDFPage, Map<PDFFont, PDFName>>()
  private readonly fontRuns = new Map<PDFFont, Map<string, { width: number; encoded?: PDFHexString }>>()
  private readonly checkedLinks = new Set<string>()
  private readonly destinations = new Map<string, PDFPage>()
  private readonly internalLinks: { page: PDFPage; destination: string; rect: number[] }[] = []
  private readonly pageReferences: { page: PDFPage; destination: string; baseline: number }[] = []

  constructor(
    readonly document: PDFDocument,
    readonly fonts: PdfReportFonts,
    private readonly designation: string,
    private readonly limits: Pick<ReportPolicy, 'maxPages' | 'maxGenerationMilliseconds'> = REPORT_LIMITS,
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
    const primaryFits = !/[\r\n\t\u0085\u2028\u2029]/u.test(identity.primary) &&
      this.measure(identity.primary, this.fonts.bold, PRIMARY_HEADER_SIZE) <= PDF_REPORT_WIDTH
    this.identity = !primaryFits && identity.primaryFallback !== undefined
      ? { ...identity, primary: identity.primaryFallback } : identity
    this.newPage()
  }

  markDestination(destination: string): void {
    if (!destination || !this.page || this.destinations.has(destination)) {
      throw new Error('PDF destinations must have unique identities and refer to an existing section opener.')
    }
    this.destinations.set(destination, this.page)
  }

  checkTime(): void {
    if (Date.now() - this.startedAt > this.limits.maxGenerationMilliseconds) {
      throw new Error('PDF generation exceeded the report time limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.')
    }
  }

  private newPage(): void {
    this.checkTime()
    if (this.document.getPageCount() >= this.limits.maxPages) {
      throw new Error(`PDF exceeds the ${this.limits.maxPages}-page resource limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.`)
    }
    this.page = this.document.addPage([PDF_REPORT_PAGE.width, PDF_REPORT_PAGE.height])
    this.y = PDF_REPORT_PAGE.bodyTop
    this.page.drawRectangle({
      x: 0, y: 704, width: PDF_REPORT_PAGE.width, height: 88, color: PDF_REPORT_COLORS.background,
    })
    this.drawText('Score', PDF_REPORT_PAGE.margin, 765, 13, this.fonts.bold, PDF_REPORT_COLORS.accent)
    const badge = [this.designation, this.identity.section].filter(Boolean).join(' · ')
    for (const [text, font, size, width] of [
      [badge, this.fonts.regular, 8.5, PDF_REPORT_WIDTH - 65],
      [this.identity.primary, this.fonts.bold, PRIMARY_HEADER_SIZE, PDF_REPORT_WIDTH],
      [this.identity.secondary, this.fonts.regular, 9, PDF_REPORT_WIDTH],
    ] as const) {
      if (/[\r\n\t\u0085\u2028\u2029]/u.test(text) || this.measure(text, font, size) > width) {
        throw new Error('PDF running headers require short section labels. Full job and candidate identities must wrap in the page body.')
      }
    }
    this.drawText(badge, PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin - this.measure(badge, this.fonts.regular, 8.5),
      766, 8.5, this.fonts.regular, PDF_REPORT_COLORS.muted)
    this.page.drawLine({
      start: { x: PDF_REPORT_PAGE.margin, y: 751 }, end: { x: PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin, y: 751 },
      color: PDF_REPORT_COLORS.border, thickness: 0.6,
    })
    this.drawText(this.identity.primary,
      PDF_REPORT_PAGE.margin, 734, PRIMARY_HEADER_SIZE, this.fonts.bold, PDF_REPORT_COLORS.text)
    this.drawText(this.identity.secondary,
      PDF_REPORT_PAGE.margin, 718, 9, this.fonts.regular, PDF_REPORT_COLORS.muted)
  }

  private ensureSpace(height: number): void {
    if (this.y - height < PDF_REPORT_PAGE.bodyBottom) this.newPage()
  }

  private addLink(link: TextLink, text: string, x: number, baseline: number, size: number, font: PDFFont): void {
    if (typeof link === 'string' && !this.checkedLinks.has(link)) {
      let destination: URL
      try { destination = new URL(link) } catch { throw new Error('A PDF report link must be an absolute application URL.') }
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password ||
        Array.from(link).some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) {
        throw new Error('A PDF report link must use a safe HTTP or HTTPS application URL without credentials.')
      }
      this.checkedLinks.add(link)
    }
    if (!text.trim()) return
    const width = this.measure(text, font, size)
    const ascent = font.heightAtSize(size, { descender: false })
    const descent = font.heightAtSize(size) - ascent
    const rect = [x, baseline - descent, x + width, baseline + ascent]
    if (typeof link === 'string') {
      const annotation = this.document.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(link) },
      })
      this.page.node.addAnnot(this.document.context.register(annotation))
    } else {
      this.internalLinks.push({ page: this.page, destination: link.destination, rect })
    }
    this.page.drawLine({
      start: { x, y: baseline - 1.5 }, end: { x: x + width, y: baseline - 1.5 },
      color: PDF_REPORT_COLORS.accent, thickness: 0.4,
    })
  }

  private drawText(text: string, x: number, baseline: number, size: number, font: PDFFont, fill: Color, source = text, link?: TextLink): void {
    if (!text && !source) return
    for (const character of printable(text)) {
      const code = character.codePointAt(0)!
      if (!this.characters.get(font)!.has(code) || code < 32 || (code >= 0x7f && code < 0xa0) ||
        (code >= 0xd800 && code <= 0xdfff)) {
        throw new Error(`The local PDF font cannot render U+${code.toString(16).toUpperCase().padStart(4, '0')} in the displayed report. No source text was substituted or omitted. Use another report format or a locally licensed PDF font supporting this character.`)
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
    if (link) this.addLink(link, text, x, baseline, size, font)
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
          size, font, style.color ?? (style.link ? PDF_REPORT_COLORS.accent : PDF_REPORT_COLORS.text), line.source, style.link)
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

  contentsEntry(entry: ContentsEntry): void {
    const metadata = entry.metadata.join('\n')
    const blocks = [
      { text: entry.title, size: 13, leading: 19, bold: true, after: 4, link: { destination: entry.destination }, keepWithNext: 28 },
      ...(entry.organization ? [{ text: entry.organization, size: 10.5, leading: 16, after: 4, keepWithNext: 14 }] : []),
      ...(metadata ? [{ text: metadata, size: 9.5, leading: 14, after: 4, color: PDF_REPORT_COLORS.muted }] : []),
      { text: entry.detail, size: 9.5, leading: 14, after: 16, color: PDF_REPORT_COLORS.muted },
    ]
    const height = 20 + blocks.reduce((sum, block) => sum +
      this.wrap(block.text, 'bold' in block && block.bold ? this.fonts.bold : this.fonts.regular,
        block.size, PDF_REPORT_WIDTH).length * block.leading + block.after, 0)
    const bodyHeight = PDF_REPORT_PAGE.bodyTop - PDF_REPORT_PAGE.bodyBottom
    this.ensureSpace(height <= bodyHeight ? height : 58)
    const baseline = this.y - this.fonts.bold.heightAtSize(10, { descender: false })
    if (this.measure(entry.label, this.fonts.bold, 10) +
      this.measure(`Page ${this.limits.maxPages}`, this.fonts.regular, 10) + 24 > PDF_REPORT_WIDTH) {
      throw new Error('PDF contents labels must leave space for their final page references.')
    }
    this.drawText(entry.label, PDF_REPORT_PAGE.margin, baseline, 10, this.fonts.bold,
      PDF_REPORT_COLORS.accent, entry.label, { destination: entry.destination })
    this.pageReferences.push({ page: this.page, destination: entry.destination, baseline })
    this.y -= 20
    for (const { text, ...style } of blocks) this.paragraph(text, style)
  }

  callout(text: string, bold = false): void {
    this.paragraph(text, { bold, padding: 10, background: PDF_REPORT_COLORS.background, rule: true, after: 10 })
  }

  links(links: readonly PdfReportLink[]): void {
    const size = 10
    const leading = 17
    const gap = 24
    const font = this.fonts.bold
    const ascent = font.heightAtSize(size, { descender: false })
    let x: number = PDF_REPORT_PAGE.margin
    for (const link of links) {
      const lines = this.wrap(link.text, font, size, PDF_REPORT_WIDTH)
      for (const [index, line] of lines.entries()) {
        const width = this.measure(line.text, font, size)
        if (index || x + width > PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin) {
          this.y -= leading
          x = PDF_REPORT_PAGE.margin
        }
        this.ensureSpace(leading)
        this.drawText(line.text, x, this.y - ascent, size, font, PDF_REPORT_COLORS.accent, line.source, link.url)
        x += width + gap
      }
    }
    if (links.length) this.y -= leading + 9
  }

  explanation(label: string, text: string, source: string | null, sectionHeading?: string): void {
    const bodyHeight = PDF_REPORT_PAGE.bodyTop - PDF_REPORT_PAGE.bodyBottom
    const labelHeight = this.wrap(label, this.fonts.bold, 10, PDF_REPORT_WIDTH).length * 15
    const textHeight = this.wrap(text, this.fonts.regular, 10, PDF_REPORT_WIDTH).length * 15
    const sourceHeight = source ? this.wrap(source, this.fonts.regular, 9.5, PDF_REPORT_WIDTH).length * 14 : 0
    const sourceReserve = sourceHeight <= bodyHeight - 30 ? sourceHeight : 28
    const groupHeight = textHeight + (source ? 3 + sourceReserve : 0)
    const headingHeight = sectionHeading ? this.wrap(sectionHeading, this.fonts.bold, 16, PDF_REPORT_WIDTH).length * 24 + 16 : 0
    const keepWithNext = headingHeight + (sectionHeading ? 5 : 0) + labelHeight + 4 + groupHeight <= bodyHeight
      ? groupHeight : Math.min(textHeight, 30)
    const keepTailWithNext = Boolean(sectionHeading && headingHeight + 5 + labelHeight + 4 + keepWithNext > bodyHeight)
    if (sectionHeading) {
      this.ensureSpace(Math.min(bodyHeight, headingHeight + 5 +
        (keepTailWithNext ? Math.min(labelHeight, 30) : labelHeight) + 4 + keepWithNext))
      this.heading(sectionHeading, 16)
    }
    this.paragraph(label, {
      size: 10, leading: 15, bold: true, before: 5, after: 4,
      keepWithNext, keepTailWithNext,
    })
    this.paragraph(text, {
      size: 10, leading: 15, after: source ? 3 : 8, keepWithNext: sourceReserve, keepTailWithNext: true,
    })
    if (source) this.paragraph(source, { size: 9.5, leading: 14, color: PDF_REPORT_COLORS.muted, after: 8 })
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
    const text = documentMetadataText(entries, value => this.measure(value, this.fonts.regular, 9.5))
    if (text) this.paragraph(text, { size: 9.5, leading: 14, after: 6 })
  }

  table(headers: string[], rows: TableCell[][], widths: number[]): void {
    if (!rows.length) return
    if (headers.length !== widths.length || widths.some(width => !Number.isFinite(width) || width <= 14) ||
      Math.abs(widths.reduce((sum, width) => sum + width, 0) - PDF_REPORT_WIDTH) > 0.01 ||
      rows.some(row => row.length !== headers.length)) throw new Error('Invalid PDF report table layout.')
    const size = 9.5
    const leading = 14
    const padding = 7
    const headerLines = headers.map((header, index) => this.wrap(header, this.fonts.bold, size, widths[index] - padding * 2))
    const headerHeight = Math.max(...headerLines.map(lines => lines.length)) * leading + padding * 2
    const drawCells = (cells: TextLine[][], offset: number, count: number, isHeader: boolean, shaded: boolean, links: (string | undefined)[] = []) => {
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
            size, font, isHeader ? PDF_REPORT_COLORS.paper : links[cell] ? PDF_REPORT_COLORS.accent : PDF_REPORT_COLORS.text, value.source, links[cell])
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
      const cells = row.map((value, index) => this.wrap(typeof value === 'string' ? value : value.text,
        this.fonts.regular, size, widths[index] - padding * 2))
      const links = row.map(value => typeof value === 'string' ? undefined : value.url)
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
        drawCells(cells, offset, count, false, rowIndex % 2 === 0, links)
        offset += count
        if (offset < length) continueTable()
      }
    })
    this.y -= 10
  }

  finish(): void {
    const pages = this.document.getPages()
    const pageNumbers = new Map(pages.map((page, index) => [page, index + 1]))
    const destinationPage = (destination: string): PDFPage => {
      const page = this.destinations.get(destination)
      if (!page || !pageNumbers.has(page)) throw new Error('A PDF internal link has no final destination. No incomplete report was generated.')
      return page
    }
    // Page references and native destinations resolve only after every flowing section is laid out.
    for (const reference of this.pageReferences) {
      const text = `Page ${pageNumbers.get(destinationPage(reference.destination))}`
      this.page = reference.page
      this.drawText(text, PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin - this.measure(text, this.fonts.regular, 10),
        reference.baseline, 10, this.fonts.regular, PDF_REPORT_COLORS.accent, text, { destination: reference.destination })
    }
    for (const link of this.internalLinks) {
      const page = destinationPage(link.destination)
      const annotation = this.document.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: link.rect, Border: [0, 0, 0],
        Dest: [page.ref, 'XYZ', null, page.getHeight(), null],
      })
      link.page.node.addAnnot(this.document.context.register(annotation))
    }
    pages.forEach((page, index) => {
      this.page = page
      page.drawLine({
        start: { x: PDF_REPORT_PAGE.margin, y: 53 }, end: { x: PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin, y: 53 },
        color: PDF_REPORT_COLORS.border, thickness: 0.6,
      })
      const pageNumber = `Page ${index + 1} of ${pages.length}`
      this.drawText(pageNumber, PDF_REPORT_PAGE.width - PDF_REPORT_PAGE.margin - this.measure(pageNumber, this.fonts.regular, 8.5),
        39, 8.5, this.fonts.regular, PDF_REPORT_COLORS.muted)
    })
    this.checkTime()
  }
}
