import { SCORE_LEGEND } from '../../domain/rubric-exports'
import type { DocumentReportLayout } from './document-layout'
import {
  RUBRIC_NO_GUIDANCE, RUBRIC_QUALIFICATIONS_NOTE, RUBRIC_QUALIFICATIONS_TITLE, RUBRIC_ROUNDED_WEIGHT_NOTE,
  RUBRIC_SECTION_SUBTITLE, rubricAboutTitle, rubricAnchorLabel, rubricCriterionSummary, rubricDetailsTitle, rubricGlanceTable,
  rubricMetadataEntries, rubricNoDetails, rubricQuote, rubricSourceLabel,
  type RubricDocumentCriterion, type RubricDocumentSource, type RubricExportDocument,
} from './rubric-model'

/** Where the rubric sits: its own document (level 1) or the end of a report's job section (level 2). */
export interface RubricSectionPlacement {
  level: 1 | 2
}

function writeSources<Color>(
  layout: DocumentReportLayout<Color>, document: RubricExportDocument, sources: readonly RubricDocumentSource[],
): void {
  layout.label(rubricSourceLabel(document))
  if (!sources.length) {
    layout.paragraph(document.noSources, { size: 10, leading: 15, color: layout.colors.muted, after: 8 })
    return
  }
  for (const source of sources) {
    layout.paragraph(rubricQuote(source), {
      size: 10, leading: 15, padding: 10, background: layout.colors.background, rule: true,
      after: source.location ? 4 : 10, ...(source.location ? { keepWithNext: 14, keepTailWithNext: true } : {}),
    })
    if (source.location) layout.paragraph(source.location, { size: 9.5, leading: 14, color: layout.colors.muted, after: 10 })
  }
}

function writeCriterion<Color>(
  layout: DocumentReportLayout<Color>, document: RubricExportDocument, criterion: RubricDocumentCriterion,
  headingLevel: 3 | undefined,
): void {
  layout.paragraph(`${criterion.code}. ${criterion.label}`, {
    size: 12, leading: 17, bold: true, before: 10, after: 3, keepWithNext: 40, ...(headingLevel ? { headingLevel } : {}),
  })
  layout.paragraph(rubricCriterionSummary(criterion), { size: 9.5, leading: 14, color: layout.colors.muted, after: 6, keepWithNext: 30 })
  layout.paragraph(criterion.description, { size: 10.5, leading: 16, after: 8 })
  if (criterion.support) layout.paragraph(`Source support: ${criterion.support}`, { size: 10, leading: 15, bold: true, after: 4 })
  if (criterion.interpretation) layout.paragraph(`Interpretation: ${criterion.interpretation}`, { size: 10, leading: 15, after: 8 })
  layout.label('Scoring guidance')
  if (criterion.guidance.kind === 'anchors') {
    if (criterion.guidance.introduction) layout.paragraph(criterion.guidance.introduction, { size: 10, leading: 15, after: 6 })
    layout.table(['Score', 'What earns this score'],
      criterion.guidance.anchors.map(anchor => [rubricAnchorLabel(anchor), anchor.text]), [120, 400])
  } else layout.paragraph(criterion.guidance.text || RUBRIC_NO_GUIDANCE, { size: 10, leading: 15, after: 8 })
  writeSources(layout, document, criterion.sources)
}

/**
 * The rubric in reader-facing language: what each criterion asks for, how it is scored and where it came from.
 * The caller starts the page section; PDF and Word share this content.
 */
export function writeRubricSection<Color>(
  layout: DocumentReportLayout<Color>, document: RubricExportDocument, placement: RubricSectionPlacement,
): void {
  const subsection = placement.level === 1 ? 2 : 3
  const heading = (text: string) => layout.paragraph(text, {
    size: 14, bold: true, color: layout.colors.accent, before: 9, after: 7, keepWithNext: 30, headingLevel: subsection,
  })
  if (placement.level === 2) {
    layout.paragraph(rubricDetailsTitle(document.kind), { size: 22, leading: 31, bold: true, after: 6, keepWithNext: 30, headingLevel: 2 })
    layout.paragraph(document.title, { size: 17, leading: 24, bold: true, after: 5, keepWithNext: 28 })
  } else {
    layout.label(document.kind === 'grade' ? 'Grade rubric' : 'Job rubric')
    layout.paragraph(document.title, { size: 22, leading: 31, bold: true, after: 6, keepWithNext: 30, headingLevel: 1 })
  }
  if (document.organization) layout.paragraph(document.organization, { size: 11, leading: 16, after: 6, keepWithNext: 28 })
  if (document.sourceTitle) {
    layout.paragraph(`Source ${document.kind} title: ${document.sourceTitle}`, { size: 9.5, leading: 14, color: layout.colors.muted, after: 7 })
  }
  layout.metadata(rubricMetadataEntries(document))
  if (document.link) layout.links([document.link])

  heading(rubricAboutTitle(document))
  if (document.description.trim()) layout.paragraph(document.description, { size: 10.5, leading: 16, after: 10 })
  for (const fact of document.about) layout.paragraph(`${fact.label}: ${fact.value}`, { size: 10, leading: 15, after: 6 })
  if (!document.description.trim() && !document.about.length) {
    layout.paragraph(rubricNoDetails(document), { size: 10, leading: 15, color: layout.colors.muted, after: 8 })
  }

  heading('How this rubric is scored')
  const [first = '', ...rest] = document.scoring
  if (first) layout.paragraph(first, { size: 10.5, leading: 16, after: 8 })
  layout.table(['Score', 'Level'], SCORE_LEGEND.map(item => [String(item.value), item.label]), [80, 440])
  for (const paragraph of rest) layout.paragraph(paragraph, { size: 10.5, leading: 16, after: 8 })
  if (document.weightNotice) {
    layout.paragraph(document.weightNotice, {
      size: 10, leading: 15, bold: true, padding: 10, background: layout.colors.background, rule: true, after: 10,
    })
  }

  heading('Criteria at a glance')
  const glance = rubricGlanceTable(document)
  layout.table(glance.headers, glance.rows, document.kind === 'grade' ? [44, 296, 110, 70] : [44, 316, 90, 70])
  if (document.criteria.some(criterion => criterion.weightLabel.startsWith('~'))) {
    layout.paragraph(RUBRIC_ROUNDED_WEIGHT_NOTE, { size: 9.5, leading: 14, color: layout.colors.muted, after: 7 })
  }

  heading('Criteria in detail')
  for (const criterion of document.criteria) writeCriterion(layout, document, criterion, placement.level === 1 ? 3 : undefined)

  if (document.qualifications.length) {
    heading(RUBRIC_QUALIFICATIONS_TITLE)
    layout.paragraph(RUBRIC_QUALIFICATIONS_NOTE, { size: 10, leading: 15, after: 8 })
    for (const qualification of document.qualifications) {
      layout.paragraph(qualification.code, { size: 12, leading: 17, bold: true, before: 10, after: 3, keepWithNext: 40 })
      layout.paragraph(qualification.text, { size: 10.5, leading: 16, after: 6 })
      layout.paragraph(`Source support: ${qualification.support}`, { size: 10, leading: 15, bold: true, after: 4 })
      if (qualification.interpretation.trim()) {
        layout.paragraph(`Interpretation: ${qualification.interpretation}`, { size: 10, leading: 15, after: 8 })
      }
      writeSources(layout, document, qualification.sources)
    }
  }
}

/** A standalone rubric export: one running-header section, the rubric, then any administrator notice. */
export function writeStandaloneRubric<Color>(layout: DocumentReportLayout<Color>, document: RubricExportDocument, notice = ''): void {
  const label = document.kind === 'grade' ? 'Grade rubric' : 'Job rubric'
  layout.startSection({ section: label, primary: document.title, primaryFallback: label, secondary: RUBRIC_SECTION_SUBTITLE })
  writeRubricSection(layout, document, { level: 1 })
  if (notice.trim()) {
    layout.paragraph('Additional notice', {
      size: 13, bold: true, color: layout.colors.accent, before: 9, after: 7, keepWithNext: 30, headingLevel: 2,
    })
    layout.paragraph(notice, { size: 9.5, leading: 14, color: layout.colors.muted, after: 8 })
  }
}
