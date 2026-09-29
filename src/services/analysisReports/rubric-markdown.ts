import { SCORE_LEGEND } from '../../domain/rubric-exports'
import type { reportLimits } from './policy'
import {
  RUBRIC_NO_GUIDANCE, RUBRIC_QUALIFICATIONS_NOTE, RUBRIC_QUALIFICATIONS_TITLE, RUBRIC_ROUNDED_WEIGHT_NOTE,
  rubricAboutTitle, rubricAnchorLabel, rubricGlanceTable, rubricMetadataEntries, rubricNoDetails, rubricQuote, rubricSourceLabel,
  type RubricDocumentLink, type RubricDocumentSource, type RubricExportDocument,
} from './rubric-model'

// Every ASCII punctuation mark may be backslash-escaped in CommonMark. These are the
// ones that can start inline markup, HTML, entities, headings, tables or math in common renderers.
const INLINE_SYNTAX = /[\\`*_[\]<>|~&$#]/gu

function sourceLines(text: string): string[] {
  return text.replace(/\r\n?|[\u2028\u2029]/gu, '\n').split('\n').map(line => line.trim())
}

const singleLine = (text: string): string => text.replace(/\s+/gu, ' ').trim()

export function markdownInline(text: string): string {
  return text.replace(INLINE_SYNTAX, '\\$&')
}

// Block syntax that only matters at the start of a line: list markers and setext underlines.
function lineStart(escaped: string): string {
  return escaped.replace(/^[+=-]/u, '\\$&').replace(/^(\d+)([.)])/u, '$1\\$2')
}

export function markdownLine(text: string): string {
  return lineStart(markdownInline(singleLine(text)))
}

/** Untrusted text as literal Markdown paragraphs. Source line breaks become hard breaks. */
export function markdownParagraphs(text: string): string[] {
  const normalized = sourceLines(text).join('\n').trim()
  if (!normalized) return []
  return normalized.split(/\n{2,}/u).map(paragraph =>
    paragraph.split('\n').map(line => lineStart(markdownInline(line))).join('\\\n'))
}

export function markdownCell(text: string): string {
  return sourceLines(text).join('\n').trim().split('\n').map(markdownInline).join('<br>')
}

function markdownLink(link: RubricDocumentLink): string {
  if (!/^https?:\/\/[^\s<>]+$/u.test(link.url)) throw new Error('A rubric export link is not a safe HTTP(S) address.')
  return `[${markdownInline(singleLine(link.text))}](<${link.url}>)`
}

function heading(level: 1 | 2 | 3 | 4, text: string): string {
  return `${'#'.repeat(level)} ${markdownInline(singleLine(text))}`
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const row = (cells: readonly string[]) => `| ${cells.map(markdownCell).join(' | ')} |`
  return [row(headers), `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row)].join('\n')
}

function quote(source: RubricDocumentSource): string {
  const body = markdownParagraphs(rubricQuote(source)).map(paragraph => paragraph.split('\n').map(line => `> ${line}`).join('\n'))
  if (source.location) body.push(`> — ${markdownInline(singleLine(source.location))}`)
  return body.join('\n>\n')
}

const labelled = (label: string, value: string) => `**${label}:** ${markdownInline(singleLine(value))}`

export function writeRubricMarkdown(document: RubricExportDocument, notice = ''): string {
  const blocks: string[] = []
  const paragraphs = (text: string) => { blocks.push(...markdownParagraphs(text)) }
  const sources = (items: RubricDocumentSource[]) => {
    blocks.push(heading(4, rubricSourceLabel(document)))
    if (!items.length) blocks.push(markdownLine(document.noSources))
    for (const source of items) blocks.push(quote(source))
  }

  blocks.push(heading(1, document.title))
  if (document.organization) blocks.push(markdownLine(document.organization))
  if (document.sourceTitle) blocks.push(`Source ${document.kind} title: ${markdownInline(singleLine(document.sourceTitle))}`)
  blocks.push(rubricMetadataEntries(document).map(entry => `- ${markdownLine(entry)}`).join('\n'))
  if (document.link) blocks.push(markdownLink(document.link))

  blocks.push(heading(2, rubricAboutTitle(document)))
  paragraphs(document.description)
  if (document.about.length) blocks.push(document.about.map(fact => `- ${labelled(markdownInline(fact.label), fact.value)}`).join('\n'))
  if (!document.description.trim() && !document.about.length) blocks.push(rubricNoDetails(document))

  blocks.push(heading(2, 'How this rubric is scored'))
  const [first = '', ...rest] = document.scoring
  paragraphs(first)
  blocks.push(table(['Score', 'Level'], SCORE_LEGEND.map(item => [String(item.value), item.label])))
  rest.forEach(paragraphs)
  if (document.weightNotice) blocks.push(`> ${labelled('Note', document.weightNotice)}`)

  blocks.push(heading(2, 'Criteria at a glance'))
  const glance = rubricGlanceTable(document)
  blocks.push(table(glance.headers, glance.rows))
  if (document.criteria.some(criterion => criterion.weightLabel.startsWith('~'))) {
    blocks.push(`*${markdownInline(RUBRIC_ROUNDED_WEIGHT_NOTE)}*`)
  }

  blocks.push(heading(2, 'Criteria in detail'))
  for (const criterion of document.criteria) {
    blocks.push(heading(3, `${criterion.code}. ${criterion.label}`))
    blocks.push([
      criterion.requirement ? labelled('Requirement', criterion.requirement) : '',
      labelled('Weight', criterion.weightLabel),
    ].filter(Boolean).join(' · '))
    paragraphs(criterion.description)
    if (criterion.support) blocks.push(labelled('Source support', criterion.support))
    if (criterion.interpretation) {
      blocks.push('**Interpretation:**')
      paragraphs(criterion.interpretation)
    }
    blocks.push(heading(4, 'Scoring guidance'))
    if (criterion.guidance.kind === 'anchors') {
      paragraphs(criterion.guidance.introduction)
      blocks.push(table(['Score', 'What earns this score'],
        criterion.guidance.anchors.map(anchor => [rubricAnchorLabel(anchor), anchor.text])))
    } else paragraphs(criterion.guidance.text || RUBRIC_NO_GUIDANCE)
    sources(criterion.sources)
  }

  if (document.qualifications.length) {
    blocks.push(heading(2, RUBRIC_QUALIFICATIONS_TITLE))
    blocks.push(RUBRIC_QUALIFICATIONS_NOTE)
    for (const qualification of document.qualifications) {
      blocks.push(heading(3, qualification.code))
      paragraphs(qualification.text)
      blocks.push(labelled('Source support', qualification.support))
      if (qualification.interpretation.trim()) {
        blocks.push('**Interpretation:**')
        paragraphs(qualification.interpretation)
      }
      sources(qualification.sources)
    }
  }

  if (notice.trim()) {
    blocks.push(heading(2, 'Additional notice'))
    paragraphs(notice)
  }
  return `${blocks.join('\n\n')}\n`
}

export function generateRubricMarkdown(
  document: RubricExportDocument,
  options: { notice?: string; limits: ReturnType<typeof reportLimits>; startedAt: number },
): Uint8Array {
  const bytes = new TextEncoder().encode(writeRubricMarkdown(document, options.notice))
  if (bytes.byteLength > options.limits.maxOutputBytes) {
    throw new Error('This Markdown file exceeds the export size limit. No file was downloaded.')
  }
  if (Date.now() - options.startedAt > options.limits.maxGenerationMilliseconds) {
    throw new Error('Markdown generation exceeded its time limit. No file was downloaded.')
  }
  return bytes
}
