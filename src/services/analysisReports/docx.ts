import fontkit from '@pdf-lib/fontkit'
import type { Font } from '@pdf-lib/fontkit'
import {
  AlignmentType, BookmarkEnd, BookmarkStart, BorderStyle, Document, ExternalHyperlink, Footer, Header,
  HeadingLevel, InternalHyperlink, LevelFormat, LineRuleType, Packer, PageNumber, PageReference,
  Paragraph, SectionType, ShadingType, Tab, Table, TableCell, TableLayoutType, TableRow,
  TabStopType, TextRun, UnderlineType, VerticalAlign, WidthType,
} from 'docx'
import type { IContext, IParagraphOptions, IRunOptions, IStylesOptions, IXmlableObject, ParagraphChild } from 'docx'
import type { AnalysisReport, ReportGenerationOptions } from '../../domain/analysis-reports'
import {
  assertReportXmlText, REPORT_FONT_FAMILY, REPORT_HUMAN_REVIEW_NOTICE, REPORT_PALETTE, reportTitle,
} from './presentation'
import { assertReportResourceLimits } from './model'
import { requireReportNarratives } from './narratives'
import { writeDocumentReport } from './document-content'
import { DOCUMENT_REPORT_PAGE, DOCUMENT_REPORT_WIDTH, documentMetadataText } from './document-layout'
import type {
  DocumentContentsEntry, DocumentPageIdentity, DocumentReportLayout, DocumentReportLink,
  DocumentTableCell, DocumentTextLink, DocumentTextStyle,
} from './document-layout'
import { reportGenerationPolicy, reportLimits, snapshotReportPolicy } from './policy'

type Content = Paragraph | Table
type EmbeddedFonts = NonNullable<ConstructorParameters<typeof Document>[0]['fonts']>
const twips = (points: number) => Math.round(points * 20)
const lineParts = (value: string) => value.split(/\r\n|[\r\n\u0085\u2028\u2029]/u)
const palette = REPORT_PALETTE
const contentWidth = twips(DOCUMENT_REPORT_WIDTH)
const headingStyle = (level: number) => ({
  run: { font: REPORT_FONT_FAMILY, bold: true, color: palette.text },
  paragraph: { outlineLevel: level - 1, keepNext: true, keepLines: false },
})

const styles: IStylesOptions = {
  default: {
    document: {
      run: { font: REPORT_FONT_FAMILY, size: 21, color: palette.text },
      paragraph: { spacing: { after: 0, line: 320, lineRule: LineRuleType.EXACT }, keepLines: false },
    },
    heading1: headingStyle(1), heading2: headingStyle(2), heading3: headingStyle(3),
    hyperlink: { run: { color: palette.accent, underline: { type: UnderlineType.SINGLE } } },
  },
}

class BorderedParagraph extends Paragraph {
  override prepForXml(context: IContext): IXmlableObject | undefined {
    const xml = super.prepForXml(context)
    const paragraph: unknown = xml?.['w:p']
    if (!Array.isArray(paragraph)) throw new Error('Word paragraph formatting could not be prepared.')
    const properties: unknown = paragraph.find((node: unknown): node is Record<string, unknown> =>
      typeof node === 'object' && node !== null && 'w:pPr' in node)?.['w:pPr']
    if (!Array.isArray(properties)) throw new Error('Word paragraph properties could not be prepared.')
    const borders: unknown = properties.find((node: unknown): node is Record<string, unknown> =>
      typeof node === 'object' && node !== null && 'w:pBdr' in node)?.['w:pBdr']
    if (borders === undefined) return xml
    if (!Array.isArray(borders)) throw new Error('Word paragraph borders could not be prepared.')
    // docx orders bottom before left; Word's paragraph-border schema requires left before bottom.
    const left = borders.findIndex((node: unknown) => typeof node === 'object' && node !== null && 'w:left' in node)
    const bottom = borders.findIndex((node: unknown) => typeof node === 'object' && node !== null && 'w:bottom' in node)
    if (bottom >= 0 && left > bottom) borders.splice(bottom, 0, ...borders.splice(left, 1))
    return xml
  }
}

function fontInputs(options?: ReportGenerationOptions): { embedded: EmbeddedFonts; regular: Font; bold: Font } {
  const fonts = options?.fonts
  if (!fonts?.regular?.byteLength || !fonts.bold?.byteLength) {
    throw new Error('Word generation requires the locally bundled Noto Sans regular and bold font bytes. Reload the application and retry; no report was generated.')
  }
  const parse = (weight: 'regular' | 'bold'): Font => {
    const bytes = new Uint8Array(fonts[weight])
    if (bytes.length > 4 * 1024 * 1024 || bytes[0] !== 0 || bytes[1] !== 1 || bytes[2] !== 0 || bytes[3] !== 0) {
      throw new Error(`The local Word ${weight} font is not a supported bounded TrueType font. Reload the application and retry.`)
    }
    try {
      const font = fontkit.create(bytes)
      if (!('layout' in font) || !Number.isFinite(font.unitsPerEm) || font.unitsPerEm <= 0) throw new Error('Invalid font metrics')
      return font
    } catch {
      throw new Error(`The local Word ${weight} font could not be read. Reload the application and retry.`)
    }
  }
  const regular = parse('regular')
  const bold = parse('bold')
  const embedded = (['regular', 'bold'] as const).map(weight => ({
    name: `${REPORT_FONT_FAMILY} ${weight === 'regular' ? 'Regular' : 'Bold'}`,
    // docx's font packer accepts Uint8Array in browsers, but declares its input as Node Buffer.
    data: new Uint8Array(fonts[weight]) as EmbeddedFonts[number]['data'],
  }))
  return { embedded, regular, bold }
}

class WordReportLayout implements DocumentReportLayout<string> {
  readonly colors = palette
  private readonly sections: { identity: DocumentPageIdentity; children: Content[] }[] = []
  private readonly bookmarkNames = new Map<string, string>()
  private readonly destinations = new Set<string>()
  private pendingDestinations: string[] = []
  private bookmarkId = 0
  private pageCount = 0
  private remainingHeight = 0

  constructor(
    private readonly report: AnalysisReport, private readonly fonts: ReturnType<typeof fontInputs>,
    private readonly limits: ReturnType<typeof reportLimits>,
    private readonly startedAt: number,
  ) {}

  private get children(): Content[] {
    const section = this.sections.at(-1)
    if (!section) throw new Error('Word content requires a document section.')
    return section.children
  }

  private checkTime(): void {
    if (Date.now() - this.startedAt > this.limits.maxGenerationMilliseconds) {
      throw new Error('Word generation exceeded the report time limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.')
    }
  }

  private width(value: string, bold: boolean, size: number): number {
    const font = bold ? this.fonts.bold : this.fonts.regular
    return font.layout(value, { liga: false, clig: false }).glyphs
      .reduce((sum, glyph) => sum + glyph.advanceWidth, 0) * size / font.unitsPerEm
  }

  private newBudgetPage(): void {
    if (this.pageCount >= this.limits.maxPages) {
      throw new Error('The Word report exceeds the section/page resource limit. Narrow the export to one exact job/grade target; no text was omitted.')
    }
    this.pageCount++
    this.remainingHeight = DOCUMENT_REPORT_PAGE.bodyTop - DOCUMENT_REPORT_PAGE.bodyBottom
  }

  private measuredLines(value: string, bold: boolean, size: number, width: number): number {
    let lines = 1, used = 0
    const advances = new Map<string, number>()
    for (const token of value.match(/\S+|[^\S\r\n]+/gu) ?? []) {
      const advance = this.width(token.replace(/\t/g, '    '), bold, size)
      if (used && used + advance > width) { lines++; used = 0 }
      if (advance > width) {
        for (const character of token) {
          let characterWidth = advances.get(character)
          if (characterWidth === undefined) { characterWidth = this.width(character, bold, size); advances.set(character, characterWidth) }
          if (used && used + characterWidth > width) { lines++; used = 0 }
          used += characterWidth
        }
      } else used += advance
    }
    return lines
  }

  // Word repaginates in the reader's editor. Count all flowing body text conservatively, not just section openers.
  private budgetParagraph(value: string, style: DocumentTextStyle<string> & { keepLines?: boolean }): void {
    const size = style.size ?? 10
    const leading = style.leading ?? Math.ceil(size * 1.5)
    const padding = style.padding ?? 0
    const width = DOCUMENT_REPORT_WIDTH - padding * 2 - (value.startsWith('\u2022 ') ? 12 : 0)
    const lines = this.measuredLines(value, Boolean(style.bold), size, width)
    const before = (style.before ?? 0) + padding
    const after = (style.after ?? 8) + padding
    const height = lines * leading + before + after
    const bodyHeight = DOCUMENT_REPORT_PAGE.bodyTop - DOCUMENT_REPORT_PAGE.bodyBottom
    const reserve = style.keepLines && height <= bodyHeight ? height : before + Math.min(lines, 2) * leading
    if (this.remainingHeight < Math.min(bodyHeight, reserve + (style.keepWithNext ?? 0))) this.newBudgetPage()
    this.remainingHeight -= before
    for (let line = 0; line < lines; line++) {
      if (this.remainingHeight < leading) this.newBudgetPage()
      this.remainingHeight -= leading
    }
    this.remainingHeight -= after
  }

  private bookmarkName(destination: string): string {
    let name = this.bookmarkNames.get(destination)
    if (!name) {
      name = `score_section_${this.bookmarkNames.size + 1}`
      this.bookmarkNames.set(destination, name)
    }
    return name
  }

  private inline(value: string, options: IRunOptions = {}, link?: DocumentTextLink): ParagraphChild[] {
    const children = value.split(/(\t)/).map(part => part === '\t'
      ? new TextRun({ ...options, children: [new Tab()] }) : new TextRun({ ...options, text: part }))
    if (!link) return children
    if (typeof link !== 'string') {
      return [new InternalHyperlink({ anchor: this.bookmarkName(link.destination), children })]
    }
    const url = new URL(link)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      Array.from(link).some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) {
      throw new Error('A Word report link must be a safe absolute application URL without credentials.')
    }
    return [new ExternalHyperlink({ link, children })]
  }

  private appendParagraph(paragraph: Paragraph): void {
    for (const destination of this.pendingDestinations) {
      // The convenience Bookmark constructor resets its numeric ID for each instance.
      const id = ++this.bookmarkId
      paragraph.addChildElement(new BookmarkStart(this.bookmarkName(destination), id))
      paragraph.addChildElement(new BookmarkEnd(id))
    }
    this.pendingDestinations = []
    this.children.push(paragraph)
  }

  startSection(identity: DocumentPageIdentity): void {
    this.checkTime()
    if (this.pendingDestinations.length) throw new Error('A Word destination has no content.')
    this.newBudgetPage()
    const primaryFits = !/[\r\n\t\u0085\u2028\u2029]/u.test(identity.primary) &&
      Array.from(identity.primary).every(character => this.fonts.bold.hasGlyphForCodePoint(character.codePointAt(0)!)) &&
      this.width(identity.primary, true, 9.5) <= DOCUMENT_REPORT_WIDTH
    this.sections.push({
      identity: !primaryFits && identity.primaryFallback !== undefined ? { ...identity, primary: identity.primaryFallback } : identity,
      children: [],
    })
  }

  markDestination(destination: string): void {
    if (!destination || !this.sections.length || this.destinations.has(destination)) {
      throw new Error('Word destinations must uniquely identify an existing section opener.')
    }
    this.destinations.add(destination)
    this.bookmarkName(destination)
    this.pendingDestinations.push(destination)
  }

  paragraph(value: string, style: DocumentTextStyle<string> & { keepLines?: boolean } = {}): void {
    this.checkTime()
    const lines = lineParts(value)
    const size = style.size ?? 10
    const leading = style.leading ?? Math.ceil(size * 1.5)
    const padding = style.padding ?? 0
    const paddedBorder = style.background && padding
      ? { style: BorderStyle.SINGLE, color: style.background, size: 1, space: padding } : undefined
    const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3]
    lines.forEach((line, index) => {
      this.budgetParagraph(line, {
        ...style, before: index === 0 ? style.before : 0, after: index === lines.length - 1 ? style.after : 0,
      })
      const bullet = line.startsWith('\u2022 ')
      const options: IParagraphOptions = {
        widowControl: true, keepLines: style.keepLines ?? false,
        keepNext: index < lines.length - 1 || Boolean(style.keepWithNext),
        ...(style.headingLevel && index === 0 ? { heading: headings[style.headingLevel - 1] } : {}),
        spacing: {
          before: twips(index === 0 ? (style.before ?? 0) + padding : 0),
          after: twips(index === lines.length - 1 ? (style.after ?? 8) + padding : 0),
          line: twips(leading), lineRule: LineRuleType.EXACT,
        },
        ...(padding ? { indent: { left: twips(padding), right: twips(padding) } } : {}),
        ...(style.background ? { shading: { fill: style.background, type: ShadingType.CLEAR } } : {}),
        ...(paddedBorder || style.rule ? { border: {
          ...(paddedBorder ? { top: paddedBorder, bottom: paddedBorder, left: paddedBorder, right: paddedBorder } : {}),
          ...(style.rule ? { left: { style: BorderStyle.SINGLE, color: palette.accent, size: 16, space: padding } } : {}),
        } } : {}),
        ...(bullet ? { numbering: { reference: 'review-notes', level: 0 } } : {}),
      }
      this.appendParagraph(new BorderedParagraph({
        ...options,
        children: [
          ...this.inline(bullet ? line.slice(2) : line, {
            font: REPORT_FONT_FAMILY, size: size * 2, bold: style.bold,
            color: style.color ?? (style.link ? palette.accent : palette.text),
            ...(style.link ? { underline: { type: UnderlineType.SINGLE } } : {}),
          }, style.link),
        ],
      }))
    })
  }

  heading(value: string, size = 14): void {
    this.paragraph(value, {
      size, bold: true, color: palette.accent, before: 9, after: 7, keepWithNext: 30, headingLevel: 3,
    })
  }

  label(value: string): void {
    this.paragraph(value, { bold: true, after: 4, keepWithNext: 30 })
  }

  metadata(entries: string[]): void {
    const text = documentMetadataText(entries, value => this.width(value, false, 9.5))
    if (text) this.paragraph(text, { size: 9.5, leading: 14, after: 6 })
  }

  links(links: readonly DocumentReportLink[]): void {
    if (!links.length) return
    this.budgetParagraph(links.map(link => link.text).join('    '), { size: 10, leading: 17, bold: true, after: 9 })
    this.children.push(new Paragraph({
      widowControl: true, keepLines: false,
      spacing: { after: 180, line: 340, lineRule: LineRuleType.EXACT },
      children: links.flatMap((link, index) => [
        ...(index ? [new TextRun({ text: '    ', size: 20 })] : []),
        ...this.inline(link.text, { size: 20, bold: true, color: palette.accent, underline: { type: UnderlineType.SINGLE } }, link.url),
      ]),
    }))
  }

  contentsEntry(entry: DocumentContentsEntry): void {
    const anchor = this.bookmarkName(entry.destination)
    this.budgetParagraph(`${entry.label}\tPage ${this.limits.maxPages}`, { size: 10, leading: 14, after: 6, keepWithNext: 28 })
    this.children.push(new Paragraph({
      keepNext: true, keepLines: true, widowControl: true,
      spacing: { after: 120, line: 280, lineRule: LineRuleType.EXACT },
      tabStops: [{ type: TabStopType.RIGHT, position: contentWidth }],
      children: [
        ...this.inline(entry.label, { size: 20, bold: true, color: palette.accent, underline: { type: UnderlineType.SINGLE } }, { destination: entry.destination }),
        new TextRun({ children: [new Tab(), 'Page '], size: 20, color: palette.accent }),
        new PageReference(anchor, { hyperlink: true }),
      ],
    }))
    this.paragraph(entry.title, {
      size: 13, leading: 19, bold: true, after: 4, keepWithNext: 28, keepLines: true, link: { destination: entry.destination },
    })
    if (entry.organization) this.paragraph(entry.organization, { size: 10.5, leading: 16, after: 4, keepWithNext: 14, keepLines: true })
    if (entry.metadata.length) this.paragraph(entry.metadata.join('\n'), { size: 9.5, leading: 14, after: 4, color: palette.muted, keepWithNext: 14, keepLines: true })
    this.paragraph(entry.detail, { size: 9.5, leading: 14, after: 16, color: palette.muted, keepLines: true })
  }

  table(headers: string[], rows: DocumentTableCell[][], widths: number[]): void {
    if (!rows.length) return
    this.checkTime()
    if (headers.length !== widths.length || widths.some(width => !Number.isFinite(width) || width <= 14) ||
      Math.abs(widths.reduce((sum, width) => sum + width, 0) - DOCUMENT_REPORT_WIDTH) > 0.01 ||
      rows.some(row => row.length !== headers.length)) throw new Error('Invalid Word report table layout.')
    const lineCount = (values: DocumentTableCell[], header: boolean) => Math.max(...values.map((value, column) =>
      lineParts(typeof value === 'string' ? value : value.text).reduce((sum, line) =>
        sum + this.measuredLines(line, header, 9.5, widths[column] - 14), 0)))
    const headerHeight = lineCount(headers, true) * 14 + 14
    const bodyHeight = DOCUMENT_REPORT_PAGE.bodyTop - DOCUMENT_REPORT_PAGE.bodyBottom
    if (headerHeight + 42 > bodyHeight) throw new Error('The Word table heading exceeds the readable page budget. No text was omitted.')
    const continueTable = () => { this.newBudgetPage(); this.remainingHeight -= headerHeight }
    if (this.remainingHeight < headerHeight + 42) this.newBudgetPage()
    this.remainingHeight -= headerHeight
    for (const row of rows) {
      this.checkTime()
      let lines = lineCount(row, false)
      if (lines * 14 + 14 <= bodyHeight - headerHeight && lines * 14 + 14 > this.remainingHeight) continueTable()
      while (lines > 0) {
        const capacity = Math.floor((this.remainingHeight - 14) / 14)
        if (capacity < Math.min(2, lines)) { continueTable(); continue }
        const taken = Math.min(capacity, lines)
        this.remainingHeight -= taken * 14 + 14
        lines -= taken
        if (lines) continueTable()
      }
    }
    this.remainingHeight -= 10
    const border = { style: BorderStyle.SINGLE, size: 4, color: palette.border }
    const noBorder = { style: BorderStyle.NONE, size: 0, color: palette.paper }
    const cells = (values: DocumentTableCell[], header: boolean, index = 0) => values.map((value, column) => {
      const label = typeof value === 'string' ? value : value.text
      const link = typeof value === 'string' ? undefined : value.url
      return new TableCell({
        width: { size: twips(widths[column]), type: WidthType.DXA },
        margins: { top: 140, bottom: 140, left: 140, right: 140 },
        borders: { bottom: border },
        verticalAlign: VerticalAlign.TOP,
        shading: { type: ShadingType.CLEAR, fill: header ? palette.text : index % 2 === 0 ? palette.background : palette.paper },
        children: lineParts(label).map(line => new Paragraph({
          widowControl: true, keepNext: false, keepLines: false,
          spacing: { before: 0, after: 0, line: 280, lineRule: LineRuleType.EXACT },
          children: this.inline(line, {
            size: 19, bold: header, font: REPORT_FONT_FAMILY,
            color: header ? palette.paper : link ? palette.accent : palette.text,
            ...(link ? { underline: { type: UnderlineType.SINGLE } } : {}),
          }, link),
        })),
      })
    })
    this.children.push(new Table({
      width: { size: contentWidth, type: WidthType.DXA }, columnWidths: widths.map(twips), layout: TableLayoutType.FIXED,
      borders: {
        top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder,
      },
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: cells(headers, true) }),
        ...rows.map((row, index) => new TableRow({ cantSplit: false, children: cells(row, false, index) })),
      ],
    }))
  }

  explanation(label: string, value: string, source: string | null, sectionHeading?: string): void {
    if (sectionHeading) this.heading(sectionHeading, 16)
    this.paragraph(label, { size: 10, leading: 15, bold: true, before: 5, after: 4, keepWithNext: 30 })
    this.paragraph(value, { size: 10, leading: 15, after: source ? 3 : 8, ...(source ? { keepWithNext: 14 } : {}) })
    if (source) this.paragraph(source, { size: 9.5, leading: 14, color: palette.muted, after: 8 })
  }

  private header(identity: DocumentPageIdentity): Header {
    const designation = [this.report.dataKind === 'sample' ? 'FICTIONAL SAMPLE' : '', identity.section].filter(Boolean).join(' \u00b7 ')
    const shaded = {
      shading: { fill: palette.background, type: ShadingType.CLEAR },
      indent: { left: -twips(DOCUMENT_REPORT_PAGE.margin), right: -twips(DOCUMENT_REPORT_PAGE.margin) },
      tabStops: [
        { type: TabStopType.LEFT, position: 0 },
        { type: TabStopType.RIGHT, position: contentWidth },
      ],
    }
    return new Header({ children: [
      new Paragraph({
        ...shaded,
        spacing: { after: 0, line: 720, lineRule: LineRuleType.EXACT },
        border: { bottom: { style: BorderStyle.SINGLE, color: palette.border, size: 5, space: 5 } },
        children: [
          new TextRun({ children: [new Tab(), 'Score'], size: 26, bold: true, color: palette.accent }),
          new TextRun({ children: [new Tab(), designation], size: 17, color: palette.muted }),
        ],
      }),
      new Paragraph({
        ...shaded, spacing: { after: 0, line: 440, lineRule: LineRuleType.EXACT },
        children: [new TextRun({ children: [new Tab(), identity.primary], size: 19, bold: true })],
      }),
      new Paragraph({
        ...shaded, spacing: { after: 0, line: 280, lineRule: LineRuleType.EXACT },
        border: { bottom: { style: BorderStyle.SINGLE, color: palette.background, size: 1, space: 9 } },
        children: [new TextRun({ children: [new Tab(), identity.secondary], size: 18, color: palette.muted })],
      }),
    ] })
  }

  async finish(): Promise<Uint8Array> {
    if (this.pendingDestinations.length || [...this.bookmarkNames.keys()].some(name => !this.destinations.has(name))) {
      throw new Error('A Word internal link has no document destination. No incomplete report was generated.')
    }
    const page = {
      size: { width: twips(DOCUMENT_REPORT_PAGE.width), height: twips(DOCUMENT_REPORT_PAGE.height) },
      margin: {
        top: twips(DOCUMENT_REPORT_PAGE.height - DOCUMENT_REPORT_PAGE.bodyTop),
        bottom: twips(DOCUMENT_REPORT_PAGE.bodyBottom),
        left: twips(DOCUMENT_REPORT_PAGE.margin), right: twips(DOCUMENT_REPORT_PAGE.margin),
        header: 0, footer: 720,
      },
    }
    const footer = new Footer({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 },
      border: { top: { style: BorderStyle.SINGLE, color: palette.border, size: 5, space: 8 } },
      children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 17, color: palette.muted })],
    })] })
    const document = new Document({
      creator: 'Score', lastModifiedBy: 'Score', title: reportTitle(this.report),
      subject: 'Analysis evidence for human review', description: REPORT_HUMAN_REVIEW_NOTICE,
      styles, features: { updateFields: true }, fonts: this.fonts.embedded,
      numbering: { config: [{ reference: 'review-notes', levels: [{
        level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 240, hanging: 240 } }, run: { font: REPORT_FONT_FAMILY } },
      }] }] },
      sections: this.sections.map((section, index) => ({
        properties: { page, ...(index ? { type: SectionType.NEXT_PAGE } : {}) },
        headers: { default: this.header(section.identity) },
        ...(!index ? { footers: { default: footer } } : {}),
        children: section.children,
      })),
    })
    const [regular, bold] = document.FontTable.fontOptionsWithKey
    // docx only exposes regular-face definitions; map both packaged faces with schema-valid GUIDs.
    const fontTable = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:font w:name="${REPORT_FONT_FAMILY}">
    <w:family w:val="swiss"/><w:pitch w:val="variable"/>
    <w:embedRegular r:id="rId1" w:fontKey="{${regular.fontKey.toUpperCase()}}"/>
    <w:embedBold r:id="rId2" w:fontKey="{${bold.fontKey.toUpperCase()}}"/>
  </w:font>
</w:fonts>`
    const blob = await Packer.toBlob(document, undefined, [{ path: 'word/fontTable.xml', data: fontTable }])
    this.checkTime()
    if (blob.size > this.limits.maxOutputBytes) {
      throw new Error('The Word report exceeds the output size limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.')
    }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    this.checkTime()
    return bytes
  }
}

export async function generateDocxReport(report: AnalysisReport, options?: ReportGenerationOptions): Promise<Uint8Array> {
  const startedAt = Date.now()
  report = snapshotReportPolicy(report)
  const limits = reportLimits(reportGenerationPolicy(report, 'docx'))
  assertReportResourceLimits(report, limits.maxInputBytes)
  requireReportNarratives(report)
  assertReportXmlText(report)
  const layout = new WordReportLayout(report, fontInputs(options), limits, startedAt)
  writeDocumentReport(layout, report, options)
  return layout.finish()
}
