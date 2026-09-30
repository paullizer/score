import type PptxGenJS from 'pptxgenjs'
import { keepPptxParagraphEndWordsTogether, paginatePptxBlocks, PPTX_LAYOUT, pptxTextHeight, takePptxText } from './pptx-layout'
import type { PptxFlowBlock } from './pptx-layout'
import {
  BODY_WIDTH, C, CONTENT_BOTTOM, fits, HEADER_HEIGHT, LINKS_Y, linkText, rectangle, SlideDeck, summaryLeading, table, TABLE_FONT,
  TABLE_PADDING_X, TABLE_PADDING_Y, tableRowHeight, text,
} from './pptx-primitives'
import type { DeckCell } from './pptx-primitives'
import { RUBRIC_EXPORT_SUBJECT, rubricExportDocumentTitle, type PreparedRubricExport } from './rubric-export'
import {
  RUBRIC_NO_GUIDANCE, RUBRIC_QUALIFICATIONS_NOTE, RUBRIC_QUALIFICATIONS_TITLE, RUBRIC_ROUNDED_WEIGHT_NOTE, rubricAboutTitle,
  rubricAnchorLabel, rubricCriterionSummary, rubricGlanceTable, rubricLegendText, rubricMetadataEntries, rubricNoDetails,
  rubricQuote, rubricSourceLabel, type RubricDocumentSource, type RubricExportDocument,
} from './rubric-model'

const RUBRIC_LIMIT_MESSAGE = 'The rubric export was not generated.'
const SCORING_SECTION = 'How this rubric is scored'
const GLANCE_SECTION = 'Criteria at a glance'
const DETAIL_SECTION = 'Criteria in detail'
const CITATION_PADDING = 0.16

export interface RubricSlideContext {
  /** Title of the first slide; reports use "Job & rubric details". */
  title: string
  /** Short running reference beside the Score mark. */
  reference: string
  /** Unique object-name prefix. */
  key: string
  /** Navigation along the bottom of every rubric slide. */
  links(slide: PptxGenJS.Slide, key: string): void
}

function flowSlides(
  deck: SlideDeck, blocks: readonly PptxFlowBlock[], context: RubricSlideContext, key: string, started: Set<string>,
): void {
  const pages = paginatePptxBlocks(blocks, BODY_WIDTH, CONTENT_BOTTOM - PPTX_LAYOUT.bodyY)
  pages.forEach((page, pageIndex) => {
    deck.checkBudget()
    const section = page.fragments[0].section ?? context.title
    const continued = started.has(section) || page.fragments[0].continued
    const slide = deck.slide(`${section}${continued ? ' (continued)' : ''}`, context.reference)
    context.links(slide, `${key}-${pageIndex}`)
    if (pages[pageIndex + 1]?.fragments[0].continued) {
      text(slide, 'Continues on next slide', { x: 4.3, y: LINKS_Y, w: 4.4, h: 0.35 }, 14, {
        color: C.muted, objectName: `${key}-${pageIndex}-continuation-note`,
      })
    }
    // The slide title already names a section that opens the page.
    const omitHeading = page.fragments[0].kind === 'heading' && page.fragments[0].text === section
    const offset = omitHeading ? page.fragments[1]?.y ?? 0 : 0
    for (const [index, fragment] of page.fragments.entries()) {
      if (fragment.section) started.add(fragment.section)
      if (omitHeading && index === 0) continue
      const y = PPTX_LAYOUT.bodyY + fragment.y - offset
      const name = `${fragment.key}-part-${pageIndex}-${index}`
      if (fragment.kind === 'citation') {
        rectangle(slide, { x: PPTX_LAYOUT.margin, y, w: BODY_WIDTH, h: fragment.height }, C.paper, `${name}-panel`)
        text(slide, fragment.text, {
          x: PPTX_LAYOUT.margin + CITATION_PADDING, y: y + CITATION_PADDING,
          w: BODY_WIDTH - CITATION_PADDING * 2, h: fragment.height - CITATION_PADDING * 2,
        }, fragment.fontSize, { objectName: name, ...summaryLeading(fragment.fontSize) })
      } else {
        text(slide, fragment.text, { x: PPTX_LAYOUT.margin, y, w: BODY_WIDTH, h: fragment.height }, fragment.fontSize, {
          bold: fragment.kind === 'heading', objectName: name, ...summaryLeading(fragment.fontSize),
        })
      }
    }
  })
}

const paragraph = (value: string) => keepPptxParagraphEndWordsTogether(value, BODY_WIDTH, PPTX_LAYOUT.bodyFontSize)

function sourceBlocks(document: RubricExportDocument, sources: readonly RubricDocumentSource[], key: string, section: string): PptxFlowBlock[] {
  return [
    { key: `${key}-sources-heading`, text: rubricSourceLabel(document), kind: 'heading', fontSize: 18, section },
    ...sources.length ? sources.map((source, index) => ({
      key: `${key}-source-${index}`, kind: 'citation' as const, fontSize: 14, section,
      text: source.location ? `${rubricQuote(source)}\n— ${source.location}` : rubricQuote(source),
    })) : [{ key: `${key}-no-sources`, text: document.noSources, fontSize: 14, section }],
  ]
}

function overviewBlocks(document: RubricExportDocument, context: RubricSlideContext): PptxFlowBlock[] {
  const key = context.key
  const intro = context.title
  const description = document.description.trim()
  const [first = '', ...rest] = document.scoring
  return [
    { key: `${key}-title`, text: document.title, kind: 'heading', fontSize: 24, section: intro },
    ...document.organization ? [{ key: `${key}-organization`, text: document.organization, fontSize: 18, section: intro }] : [],
    ...document.sourceTitle ? [{
      key: `${key}-source-title`, text: `Source ${document.kind} title: ${document.sourceTitle}`, fontSize: 14, section: intro,
    }] : [],
    { key: `${key}-metadata`, text: rubricMetadataEntries(document).join(' · '), fontSize: 14, section: intro },
    { key: `${key}-about-heading`, text: rubricAboutTitle(document), kind: 'heading', fontSize: 20, section: intro },
    ...description ? [{ key: `${key}-description`, text: paragraph(description), section: intro }] : [],
    ...document.about.length ? [{
      key: `${key}-facts`, text: document.about.map(fact => `${fact.label}: ${fact.value}`).join('\n'), section: intro,
    }] : [],
    ...!description && !document.about.length ? [{ key: `${key}-no-details`, text: rubricNoDetails(document), section: intro }] : [],
    { key: `${key}-scoring-heading`, text: SCORING_SECTION, kind: 'heading', fontSize: 20, section: SCORING_SECTION },
    ...first ? [{ key: `${key}-scoring-0`, text: paragraph(first), section: SCORING_SECTION }] : [],
    { key: `${key}-legend`, text: `Score levels: ${rubricLegendText()}`, section: SCORING_SECTION },
    ...rest.map((value, index) => ({ key: `${key}-scoring-${index + 1}`, text: paragraph(value), section: SCORING_SECTION })),
    ...document.weightNotice ? [{
      key: `${key}-weight-notice`, text: document.weightNotice, kind: 'citation' as const, fontSize: 14, section: SCORING_SECTION,
    }] : [],
  ]
}

function glanceSlides(deck: SlideDeck, document: RubricExportDocument, context: RubricSlideContext): void {
  const glance = rubricGlanceTable(document)
  const widths = [0.9, BODY_WIDTH - 5, 2.6, 1.5]
  const y = PPTX_LAYOUT.bodyY
  const capacity = CONTENT_BOTTOM - y
  const rounded = document.criteria.some(criterion => criterion.weightLabel.startsWith('~'))
  let rows: DeckCell[][] = [], heights: number[] = [], used = HEADER_HEIGHT, page = 0
  const flush = () => {
    const slide = deck.slide(`${GLANCE_SECTION}${page ? ' (continued)' : ''}`, context.reference)
    const name = `${context.key}-glance-${page}`
    table(slide, glance.headers, rows, widths, heights, y, name)
    context.links(slide, name)
    if (rounded) text(slide, RUBRIC_ROUNDED_WEIGHT_NOTE, { x: 4.3, y: LINKS_Y, w: 4.4, h: 0.35 }, 14, {
      color: C.muted, objectName: `${name}-rounded-note`,
    })
    rows = []
    heights = []
    used = HEADER_HEIGHT
    page++
  }
  for (const [code, label, requirement, weight] of glance.rows) {
    let remaining = label
    let part = 0
    while (remaining) {
      const row = [{ text: part ? `${code} (cont.)` : code }, { text: remaining }, { text: requirement }, { text: weight }]
      const rowHeight = tableRowHeight(row, widths)
      if (used + rowHeight <= capacity + 0.000001) {
        rows.push(row)
        heights.push(rowHeight)
        used += rowHeight
        break
      }
      const available = capacity - used - TABLE_PADDING_Y * 2
      if (rows.length && (HEADER_HEIGHT + rowHeight <= capacity + 0.000001 || available < pptxTextHeight(2, TABLE_FONT))) {
        flush()
        continue
      }
      // A label too long for one slide continues in the next row.
      const fragment = takePptxText(remaining, widths[1] - TABLE_PADDING_X * 2, available, TABLE_FONT)
      const split = [row[0], { text: fragment.text }, row[2], row[3]]
      rows.push(split)
      heights.push(tableRowHeight(split, widths))
      remaining = fragment.rest
      part++
      flush()
    }
  }
  if (rows.length) flush()
}

function detailBlocks(document: RubricExportDocument, context: RubricSlideContext): PptxFlowBlock[] {
  const blocks: PptxFlowBlock[] = []
  for (const [index, criterion] of document.criteria.entries()) {
    const key = `${context.key}-criterion-${index}`
    const section = DETAIL_SECTION
    blocks.push(
      { key: `${key}-title`, text: `${criterion.code}. ${criterion.label}`, kind: 'heading', fontSize: 20, section },
      { key: `${key}-summary`, text: rubricCriterionSummary(criterion), fontSize: 14, section },
      { key: `${key}-description`, text: paragraph(criterion.description), section },
    )
    if (criterion.support) blocks.push({ key: `${key}-support`, text: `Source support: ${criterion.support}`, section })
    if (criterion.interpretation) blocks.push({ key: `${key}-interpretation`, text: `Interpretation: ${criterion.interpretation}`, section })
    blocks.push({ key: `${key}-guidance-heading`, text: 'Scoring guidance', kind: 'heading', fontSize: 18, section })
    if (criterion.guidance.kind === 'anchors') {
      if (criterion.guidance.introduction) blocks.push({ key: `${key}-guidance-introduction`, text: criterion.guidance.introduction, section })
      for (const anchor of criterion.guidance.anchors) {
        blocks.push({ key: `${key}-anchor-${anchor.score}`, text: `${rubricAnchorLabel(anchor)}: ${anchor.text}`, fontSize: 14, section })
      }
    } else blocks.push({ key: `${key}-guidance`, text: paragraph(criterion.guidance.text || RUBRIC_NO_GUIDANCE), section })
    blocks.push(...sourceBlocks(document, criterion.sources, key, section))
  }
  if (document.qualifications.length) {
    const section = RUBRIC_QUALIFICATIONS_TITLE
    blocks.push(
      { key: `${context.key}-qualifications-heading`, text: section, kind: 'heading', fontSize: 20, section },
      { key: `${context.key}-qualifications-note`, text: RUBRIC_QUALIFICATIONS_NOTE, section },
    )
    for (const [index, qualification] of document.qualifications.entries()) {
      const key = `${context.key}-qualification-${index}`
      blocks.push(
        { key: `${key}-title`, text: qualification.code, kind: 'heading', fontSize: 20, section },
        { key: `${key}-text`, text: paragraph(qualification.text), section },
        { key: `${key}-support`, text: `Source support: ${qualification.support}`, section },
      )
      if (qualification.interpretation.trim()) {
        blocks.push({ key: `${key}-interpretation`, text: `Interpretation: ${qualification.interpretation}`, section })
      }
      blocks.push(...sourceBlocks(document, qualification.sources, key, section))
    }
  }
  return blocks
}

/** The rubric as slides: overview and scoring, criteria at a glance, then each criterion in detail. */
export function addRubricSlides(deck: SlideDeck, document: RubricExportDocument, context: RubricSlideContext): void {
  const started = new Set<string>()
  flowSlides(deck, overviewBlocks(document, context), context, `${context.key}-overview`, started)
  glanceSlides(deck, document, context)
  flowSlides(deck, detailBlocks(document, context), context, `${context.key}-details`, started)
}

export async function generateRubricPptx(prepared: PreparedRubricExport): Promise<Uint8Array> {
  const { document, limits, startedAt } = prepared
  const deck = new SlideDeck(limits, startedAt, {
    title: rubricExportDocumentTitle(document), subject: RUBRIC_EXPORT_SUBJECT,
  }, RUBRIC_LIMIT_MESSAGE)
  const title = document.kind === 'grade' ? 'Grade rubric' : 'Job rubric'
  const reference = fits(document.title, 6.5, 0.3, 11) ? document.title : title
  const link = document.link
  const links = (slide: PptxGenJS.Slide, key: string) => {
    if (link) linkText(slide, link.text, link.url, { x: 0.6, y: LINKS_Y, w: 3.4, h: 0.35 }, `${key}-rubric-link`)
  }
  addRubricSlides(deck, document, { title, reference, key: 'rubric', links })
  if (prepared.notice.trim()) {
    flowSlides(deck, [{ key: 'additional-notice', text: prepared.notice }], {
      title: 'Additional notice', reference, key: 'notice', links,
    }, 'notice', new Set())
  }
  deck.checkBudget()
  const result = await deck.presentation.write({ outputType: 'arraybuffer', compression: true })
  deck.checkBudget()
  if (!(result instanceof ArrayBuffer)) throw new Error('PowerPoint generation did not produce binary rubric data.')
  const bytes = new Uint8Array(result)
  if (bytes.byteLength > limits.maxOutputBytes) throw new Error(`This rubric PowerPoint exceeds the export size limit. ${RUBRIC_LIMIT_MESSAGE}`)
  return bytes
}
