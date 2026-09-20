import type {
  AnalysisReport, RankedReportComparison, ReportGenerationOptions, ReportGroup, ReportTargetPresentation,
} from '../../domain/analysis-reports'
import { getDisplayName } from '../../domain/displayNames'
import {
  evidenceStatusLabel, overallScoreLabel, REPORT_HUMAN_REVIEW_NOTICE,
  REPORT_SAMPLE_NOTICE, REPORT_TITLE,
} from './presentation'
import {
  compactReportText, criterionReviews, qualificationNotes,
  readableAnalysisDate, readableCandidateName, readableCompletionNotice,
} from './readable'
import type { ReadableCriterion } from './readable'
import { reportReviewLinks, validatedReportLinkContext } from './links'
import { assertReportResourceLimits } from './model'
import {
  candidateNarrativeDisclosures, candidateNarrativeOverview, candidateNarrativeText, reportTargetPresentation,
  requireReportNarratives, targetNarrativeDisclosures, targetNarrativeParagraphs,
} from './narratives'
import type { DocumentReportLayout } from './document-layout'

const CONTENTS_DESTINATION = 'contents'

interface TargetSection {
  group: ReportGroup
  label: string
  destination: string
  presentation: ReportTargetPresentation
}

function writeIntroduction<Color>(layout: DocumentReportLayout<Color>, report: AnalysisReport, sections: TargetSection[]): void {
  layout.startSection({ section: 'Introduction', primary: REPORT_TITLE, secondary: 'Saved analysis scope' })
  layout.paragraph(REPORT_TITLE, { size: 23, bold: true, leading: 32, after: 8, headingLevel: 1 })
  layout.paragraph(report.run.name, { size: 13, leading: 18, bold: true, after: 8 })
  if (report.dataKind === 'sample') {
    layout.paragraph(REPORT_SAMPLE_NOTICE, { size: 9.5, leading: 14, bold: true, color: layout.colors.accent, after: 7 })
  }
  const dates = report.groups.flatMap(group => group.comparisons)
    .filter(comparison => comparison.status === 'complete' && comparison.analyzedAt)
    .map(comparison => comparison.analyzedAt!)
    .sort((left, right) => Date.parse(right) - Date.parse(left))
  layout.paragraph(`Analysis date: ${readableAnalysisDate(dates[0] ?? null) || 'Not recorded'}`, { size: 10, after: 5 })
  layout.paragraph(`This report presents completed assessments for ${sections.length} exact saved job or grade ${sections.length === 1 ? 'target' : 'targets'} in the selected analysis scope.`,
    { size: 11, leading: 16, after: 10 })
  const completed = sections.flatMap(section => section.group.comparisons.filter(comparison => comparison.status === 'complete'))
  const targetLabel = sections.every(section => section.group.target.kind === 'job') ? 'Job targets' : 'Jobs / grades'
  layout.paragraph([
    `Distinct reviewed candidates: ${new Set(completed.map(comparison => comparison.candidate.id)).size}`,
    `${targetLabel}: ${sections.length}`,
    `Completed candidate-job reviews: ${completed.length}`,
  ].join('\n'), { size: 12, leading: 19, bold: true, after: 12 })
  layout.paragraph(readableCompletionNotice(report.counts, report.groups.length > 1),
    { size: 11, leading: 16, bold: true, after: 8 })
  layout.paragraph(REPORT_HUMAN_REVIEW_NOTICE, { size: 9.5, leading: 14, color: layout.colors.muted, after: 8 })
  layout.paragraph('Links open the saved analysis and its source documents. Application access is required.',
    { size: 9.5, leading: 14, color: layout.colors.muted, after: 10 })
}

function targetMetadata(presentation: ReportTargetPresentation): string[] {
  return [
    presentation.series ? `Series: ${presentation.series}` : '',
    presentation.grade ? `Grade: ${presentation.grade}` : '',
    presentation.versionLabel,
  ].filter(Boolean)
}

function writeTargetIdentity<Color>(layout: DocumentReportLayout<Color>, section: TargetSection, size: number): void {
  const { group, presentation } = section
  layout.paragraph(getDisplayName(group.target, presentation.title), {
    size, leading: Math.ceil(size * 1.4), bold: true, after: 5, keepWithNext: 28,
    ...(size === 20 ? { headingLevel: 1 } : {}),
  })
  if (presentation.organization) {
    layout.paragraph(presentation.organization, { size: 11, leading: 16, after: 6, keepWithNext: 28 })
  }
  if (group.target.displayName !== undefined) {
    layout.paragraph(`Source target title: ${presentation.title}`, {
      size: 9.5, leading: 14, color: layout.colors.muted, after: 7,
    })
  }
  layout.metadata(targetMetadata(presentation))
}

function writeContents<Color>(layout: DocumentReportLayout<Color>, sections: TargetSection[]): void {
  layout.startSection({ section: 'Contents', primary: 'Included job and grade analyses', secondary: 'Navigation within this report' })
  layout.markDestination(CONTENTS_DESTINATION)
  layout.paragraph('Contents', { size: 22, leading: 31, bold: true, after: 7, keepWithNext: 30, headingLevel: 1 })
  layout.paragraph('Select a job or grade to open its context, saved overview, featured reviews and complete candidate table.',
    { size: 10, leading: 15, after: 15 })
  for (const section of sections) {
    const count = section.group.comparisons.filter(comparison => comparison.status === 'complete').length
    layout.contentsEntry({
      label: section.label, title: getDisplayName(section.group.target, section.presentation.title), organization: section.presentation.organization,
      metadata: targetMetadata(section.presentation),
      detail: `${count} completed ${count === 1 ? 'comparison' : 'comparisons'}`,
      destination: section.destination,
    })
  }
}

function writeTargetOverview<Color>(
  layout: DocumentReportLayout<Color>, report: AnalysisReport, section: TargetSection, options?: ReportGenerationOptions,
): void {
  const { group, presentation } = section
  layout.startSection({ section: 'Target overview', primary: section.label, secondary: 'Job context and saved analysis overview' })
  layout.markDestination(section.destination)
  layout.paragraph('Return to contents', { size: 9.5, leading: 14, after: 12, link: { destination: CONTENTS_DESTINATION } })
  layout.label(section.label)
  writeTargetIdentity(layout, section, 20)
  const comparison = group.comparisons.find(comparison => comparison.status === 'complete')
  if (!comparison) throw new Error('A document target section requires a completed comparison.')
  layout.links([{
    text: group.target.kind === 'grade' ? 'View grade requirements' : 'View job',
    url: reportReviewLinks(report, comparison, options).target,
  }])
  layout.heading(group.target.kind === 'grade' ? 'About the grade' : 'About the job', 14)
  if (presentation.description) layout.paragraph(presentation.description, { size: 10.5, leading: 16, after: 10 })
  const contextLabels = new Set(['Location', 'Work arrangement', 'Employment type', 'Specialty', 'Functions', 'Supervision'])
  for (const fact of group.target.facts.filter(fact => contextLabels.has(fact.label))) {
    layout.paragraph(`${fact.label}: ${fact.value}`, { size: 10, leading: 15, after: 6 })
  }
  layout.heading('Saved analysis overview', 14)
  for (const disclosure of targetNarrativeDisclosures(group.target)) {
    layout.paragraph(disclosure, { size: 10, leading: 15, after: 7, color: layout.colors.accent })
  }
  for (const paragraph of targetNarrativeParagraphs(group.target)) {
    layout.paragraph(paragraph, { size: 10.5, leading: 16, after: 10 })
  }
}

function writeCandidatesAtAGlance<Color>(
  layout: DocumentReportLayout<Color>, report: AnalysisReport, section: TargetSection, options?: ReportGenerationOptions,
): void {
  const { group } = section
  layout.startSection({ section: 'Candidates at a glance', primary: section.label, secondary: 'All completed comparisons' })
  writeTargetIdentity(layout, section, 17)
  layout.heading('Candidates at a glance', 14)
  const completed = group.comparisons.filter(comparison => comparison.status === 'complete')
  layout.table(
    ['Name', 'Score', 'Assessment highlights'],
    completed.map(comparison => {
      const overview = [...candidateNarrativeDisclosures(comparison), candidateNarrativeOverview(comparison)].join('\n\n')
      return [
        { text: readableCandidateName(comparison.candidate), url: reportReviewLinks(report, comparison, options).analysis },
        comparison.overall.status === 'available' ? overallScoreLabel(comparison.overall) : 'Withheld',
        comparison.overall.status === 'withheld' && !overview.includes(comparison.overall.message)
          ? `${overview}\nScore withheld: ${comparison.overall.message}` : overview,
      ]
    }),
    [133, 76, 311],
  )
}

function highlightedComparisons(group: ReportGroup): RankedReportComparison[] {
  const comparisons = new Map(group.comparisons.map(comparison => [comparison.id, comparison]))
  return group.highlightedComparisonIds.map(id => {
    const comparison = comparisons.get(id)
    if (!comparison || comparison.status !== 'complete' || comparison.overall.status !== 'available') {
      throw new Error(`The document highlight ${id} is not a completed, scored comparison for its exact target.`)
    }
    return comparison
  })
}

function writeScorecard<Color>(layout: DocumentReportLayout<Color>, criteria: ReadableCriterion[]): void {
  layout.heading('Scorecard', 16)
  layout.table(
    ['Criterion', 'Weight', 'Score'],
    criteria.map(criterion => [`C${criterion.number} ${criterion.label}`, criterion.weightLabel, criterion.scoreLabel]),
    [356, 70, 94],
  )
  if (criteria.some(criterion => criterion.weightLabel.startsWith('~'))) {
    layout.paragraph('~ marks a weight rounded for display.', { size: 9.5, leading: 14, color: layout.colors.muted, after: 7 })
  }
  for (const [index, criterion] of criteria.entries()) {
    const state = criterion.evidenceStatus === 'partial' || criterion.evidenceStatus === 'missing'
      ? ` · ${evidenceStatusLabel(criterion.evidenceStatus)}` : ''
    const limitation = criterion.limitation && !criterion.explanation.includes(criterion.limitation) ? criterion.limitation : null
    const rationale = [criterion.explanation, limitation].filter(Boolean).join(' ')
    layout.explanation(`C${criterion.number} ${criterion.label} (${criterion.scoreLabel})${state}`, rationale,
      criterion.sourceLabel ? `Source: ${criterion.sourceLabel}` : null, index === 0 ? 'Why these scores' : undefined)
  }
}

function writeComparison<Color>(
  layout: DocumentReportLayout<Color>, report: AnalysisReport, section: TargetSection,
  comparison: RankedReportComparison, index: number, options?: ReportGenerationOptions,
): void {
  const { group } = section
  const name = readableCandidateName(comparison.candidate)
  const links = reportReviewLinks(report, comparison, options)
  const summary = candidateNarrativeText(comparison)
  const criteria = criterionReviews(group.target, comparison)
  const notes = qualificationNotes(comparison)
  layout.startSection({
    section: 'Candidate review', primary: name, primaryFallback: `Candidate ${index + 1}`,
    secondary: `${section.label} · Featured candidate ${index + 1}`,
  })
  layout.paragraph(name, { size: 22, leading: 31, bold: true, after: 6, keepWithNext: 30, headingLevel: 2 })
  writeTargetIdentity(layout, section, 12)
  if (comparison.candidate.displayName !== undefined) {
    layout.paragraph(`Source-stated name: ${comparison.candidate.name ?? 'Not stated'}`, {
      size: 9.5, leading: 14, color: layout.colors.muted, after: 7,
    })
  }
  layout.paragraph([
    comparison.candidate.role?.trim() ? compactReportText(comparison.candidate.role, 180) : null,
    compactReportText(comparison.candidate.sourceLabel, 200),
  ].filter(Boolean).join(' · '), { size: 10, leading: 15, after: 10 })
  layout.paragraph(`Overall score: ${overallScoreLabel(comparison.overall)}`, {
    size: 20, leading: 28, bold: true, color: layout.colors.accent,
    padding: 10, background: layout.colors.background, after: 8,
  })
  layout.heading('Why this score', 13)
  for (const disclosure of candidateNarrativeDisclosures(comparison)) {
    layout.paragraph(disclosure, { size: 10, leading: 15, after: 7, color: layout.colors.accent })
  }
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

export function writeDocumentReport<Color>(
  layout: DocumentReportLayout<Color>, report: AnalysisReport, options?: ReportGenerationOptions,
): void {
  assertReportResourceLimits(report)
  requireReportNarratives(report)
  validatedReportLinkContext(report, options)
  const sections = report.groups.filter(group => group.comparisons.some(comparison => comparison.status === 'complete'))
    .map((group, index): TargetSection => ({
      group, label: `${group.target.kind === 'grade' ? 'Grade' : 'Job'} analysis ${index + 1}`,
      destination: `target:${group.target.id}`, presentation: reportTargetPresentation(group.target),
    }))
  if (!sections.length) throw new Error('At least one completed comparison is required for a document report.')
  writeIntroduction(layout, report, sections)
  writeContents(layout, sections)
  for (const section of sections) {
    writeTargetOverview(layout, report, section, options)
    highlightedComparisons(section.group).forEach((comparison, index) => writeComparison(layout, report, section, comparison, index, options))
    writeCandidatesAtAGlance(layout, report, section, options)
  }
}
