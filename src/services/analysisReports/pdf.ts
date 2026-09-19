import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import type {
  AnalysisReport, RankedReportComparison, ReportGenerationOptions, ReportGroup,
} from '../../domain/analysis-reports'
import {
  evidenceStatusLabel, overallScoreLabel, REPORT_FONT_FAMILY, REPORT_HUMAN_REVIEW_NOTICE,
  REPORT_SAMPLE_NOTICE, REPORT_TITLE,
} from './presentation'
import {
  assessmentHighlights, assessmentSummary, compactReportText, criterionReviews, qualificationNotes,
  readableAnalysisDate, readableCandidateName, readableCompletionNotice, readableJobFacts, readableTargetLabel,
} from './readable'
import type { ReadableCriterion } from './readable'
import { reportReviewLinks, validatedReportLinkContext } from './links'
import { assertReportResourceLimits } from './model'
import { PdfReportLayout, PDF_REPORT_COLORS } from './pdf-layout'
import type { PdfReportFonts } from './pdf-layout'

async function embedReportFonts(document: PDFDocument, options?: ReportGenerationOptions): Promise<PdfReportFonts> {
  if (!options?.fonts?.regular?.byteLength || !options.fonts.bold?.byteLength) {
    throw new Error('PDF generation requires the locally bundled Noto Sans regular and bold font bytes. Reload the application and retry; no report was generated.')
  }
  document.registerFontkit(fontkit)
  const embed = async (weight: 'regular' | 'bold') => {
    try {
      return await document.embedFont(options.fonts![weight], { subset: true, features: { liga: false, clig: false } })
    } catch {
      throw new Error(`The local PDF ${weight} font could not be read. Reload the application to load the bundled ${REPORT_FONT_FAMILY} fonts, then retry.`)
    }
  }
  const [regular, bold] = await Promise.all([embed('regular'), embed('bold')])
  return { regular, bold }
}

function writeIntroduction(layout: PdfReportLayout, report: AnalysisReport): void {
  layout.paragraph(REPORT_TITLE, { size: 23, bold: true, leading: 32, after: 8 })
  if (report.dataKind === 'sample') {
    layout.paragraph(REPORT_SAMPLE_NOTICE, { size: 9.5, leading: 14, bold: true, color: PDF_REPORT_COLORS.accent, after: 7 })
  }
  const dates = report.groups.flatMap(group => group.comparisons)
    .filter(comparison => comparison.status === 'complete' && comparison.analyzedAt)
    .map(comparison => comparison.analyzedAt!)
    .sort((left, right) => Date.parse(right) - Date.parse(left))
  layout.paragraph(`Analysis date: ${readableAnalysisDate(dates[0] ?? null) || 'Not recorded'}`, { size: 10, after: 5 })
  layout.paragraph(readableCompletionNotice(report.counts, report.groups.length > 1),
    { size: 11, leading: 16, bold: true, after: 8 })
  layout.paragraph(REPORT_HUMAN_REVIEW_NOTICE, { size: 9.5, leading: 14, color: PDF_REPORT_COLORS.muted, after: 8 })
  layout.paragraph('Links open the saved analysis and its source documents. Application access is required.',
    { size: 9.5, leading: 14, color: PDF_REPORT_COLORS.muted, after: 10 })
}

function writeTargetOverview(
  layout: PdfReportLayout, report: AnalysisReport, group: ReportGroup, index: number, options?: ReportGenerationOptions,
): void {
  const targetLabel = readableTargetLabel(report, group)
  layout.startSection({ section: 'Candidates at a glance', primary: targetLabel, secondary: group.target.kind === 'grade' ? 'Grade requirements' : 'Job overview' })
  if (!index) writeIntroduction(layout, report)
  layout.heading(targetLabel, 17)
  const facts = readableJobFacts(group.target, 4)
  if (facts.length) {
    layout.label(group.target.kind === 'grade' ? 'About the grade' : 'About the job')
    layout.paragraph(facts.join('\n'), { size: 10, leading: 15, after: 8 })
  }
  layout.heading('Candidates at a glance', 14)
  const completed = group.comparisons.filter(comparison => comparison.status === 'complete')
  if (!completed.length) {
    layout.paragraph('No completed assessments for this job or grade.')
    return
  }
  layout.table(
    ['Name', 'Score', 'Assessment highlights'],
    completed.map(comparison => [
      { text: readableCandidateName(comparison.candidate), url: reportReviewLinks(report, comparison, options).analysis },
      comparison.overall.status === 'available' ? overallScoreLabel(comparison.overall) : 'Withheld',
      assessmentHighlights(group.target, comparison),
    ]),
    [133, 76, 311],
  )
}

function highlightedComparisons(group: ReportGroup): RankedReportComparison[] {
  const comparisons = new Map(group.comparisons.map(comparison => [comparison.id, comparison]))
  return group.highlightedComparisonIds.map(id => {
    const comparison = comparisons.get(id)
    if (!comparison || comparison.status !== 'complete' || comparison.overall.status !== 'available') {
      throw new Error(`The PDF highlight ${id} is not a completed, scored comparison for its exact target.`)
    }
    return comparison
  })
}

function writeScorecard(layout: PdfReportLayout, criteria: ReadableCriterion[]): void {
  layout.heading('Scorecard', 16)
  layout.table(
    ['Criterion', 'Weight', 'Score'],
    criteria.map(criterion => [`C${criterion.number} ${criterion.label}`, criterion.weightLabel, criterion.scoreLabel]),
    [356, 70, 94],
  )
  if (criteria.some(criterion => criterion.weightLabel.startsWith('~'))) {
    layout.paragraph('~ marks a weight rounded for display.', { size: 9.5, leading: 14, color: PDF_REPORT_COLORS.muted, after: 7 })
  }
  layout.heading('Why these scores', 16)
  for (const criterion of criteria) {
    const state = criterion.evidenceStatus === 'partial' || criterion.evidenceStatus === 'missing'
      ? ` · ${evidenceStatusLabel(criterion.evidenceStatus)}` : ''
    const limitation = criterion.limitation && !criterion.explanation.includes(criterion.limitation) ? criterion.limitation : null
    const rationale = [criterion.explanation, limitation].filter(Boolean).join(' ')
    layout.explanation(`C${criterion.number} ${criterion.label} (${criterion.scoreLabel})${state}`, rationale,
      criterion.sourceLabel ? `Source: ${criterion.sourceLabel}` : null)
  }
}

function writeComparison(
  layout: PdfReportLayout, report: AnalysisReport, group: ReportGroup,
  comparison: RankedReportComparison, options?: ReportGenerationOptions,
): void {
  const name = readableCandidateName(comparison.candidate)
  const target = readableTargetLabel(report, group)
  const links = reportReviewLinks(report, comparison, options)
  const summary = assessmentSummary(group.target, comparison)
  const criteria = criterionReviews(group.target, comparison)
  const notes = qualificationNotes(comparison)
  layout.startSection({ section: 'Candidate review', primary: name, secondary: target })
  layout.paragraph(name, { size: 22, leading: 31, bold: true, after: 6, keepWithNext: 30 })
  layout.paragraph(target, { size: 12, leading: 17, bold: true, after: 5, keepWithNext: 28 })
  layout.paragraph([
    comparison.candidate.role?.trim() ? compactReportText(comparison.candidate.role, 180) : null,
    compactReportText(comparison.candidate.sourceLabel, 200),
  ].filter(Boolean).join(' · '), { size: 10, leading: 15, after: 10 })
  layout.paragraph(`Overall score: ${overallScoreLabel(comparison.overall)}`, {
    size: 20, leading: 28, bold: true, color: PDF_REPORT_COLORS.accent,
    padding: 10, background: PDF_REPORT_COLORS.background, after: 8,
  })
  layout.heading('Why this score', 13)
  layout.paragraph(summary, { size: 10.5, leading: 16, after: 8 })
  layout.links([
    { text: 'View analysis', url: links.analysis },
    { text: 'View resume', url: links.resume },
    { text: group.target.kind === 'grade' ? 'View grade requirements' : 'View job', url: links.target },
  ])
  const explained = [summary, REPORT_HUMAN_REVIEW_NOTICE, ...notes,
    ...criteria.map(criterion => [criterion.explanation, criterion.limitation].filter(Boolean).join(' '))]
  const limitations = [...new Set(comparison.limitations.map(limitation => compactReportText(limitation.message, 220)))]
    .filter(message => !explained.some(text => text.includes(message)))
  if (limitations.length) {
    layout.heading('Review notes', 13)
    for (const limitation of limitations) layout.paragraph(`• ${limitation}`, { size: 10, leading: 15, after: 6 })
  }
  writeScorecard(layout, criteria)
  if (notes.length) {
    layout.heading('GS qualification notes (unscored)', 13)
    for (const note of notes) layout.paragraph(`• ${note}`, { size: 10, leading: 15, after: 6 })
  }
}

export async function generatePdfReport(report: AnalysisReport, options?: ReportGenerationOptions): Promise<Uint8Array> {
  assertReportResourceLimits(report)
  const document = await PDFDocument.create()
  const fonts = await embedReportFonts(document, options)
  validatedReportLinkContext(report, options)
  document.setTitle(REPORT_TITLE, { showInWindowTitleBar: true })
  document.setAuthor('Score')
  document.setSubject('Analysis evidence for human review')
  document.setCreator('Score')
  document.setProducer('Score · pdf-lib')
  document.setCreationDate(new Date(report.generatedAt))
  document.setModificationDate(new Date(report.generatedAt))
  const layout = new PdfReportLayout(document, fonts, report.dataKind === 'sample' ? 'FICTIONAL SAMPLE' : '')
  report.groups.forEach((group, index) => writeTargetOverview(layout, report, group, index, options))
  for (const group of report.groups) {
    for (const comparison of highlightedComparisons(group)) writeComparison(layout, report, group, comparison, options)
  }
  layout.finish()
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false })
  layout.checkTime()
  if (bytes.byteLength > REPORT_LIMITS.maxOutputBytes) {
    throw new Error(`PDF exceeds the ${Math.floor(REPORT_LIMITS.maxOutputBytes / 1024 / 1024)} MiB output resource limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.`)
  }
  return bytes
}
