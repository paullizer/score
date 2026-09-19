import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import type {
  AnalysisReport, RankedReportComparison, ReportCitation, ReportComparison,
  ReportGenerationOptions, ReportGroup, ReportLimitation, ReportTarget,
} from '../../domain/analysis-reports'
import {
  candidateName, comparisonStatusLabel, criterionScoreLabel, evidenceStatusLabel, formatReportWeight, highlightNotice,
  overallScoreLabel, REPORT_FONT_FAMILY, REPORT_TITLE, reportStatusNotice, reportTitle, summaryExcerpt, targetName,
} from './presentation'
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

function assertSupportedReportText(report: AnalysisReport, fonts: PdfReportFonts): void {
  const supported = Object.entries(fonts).map(([weight, font]) => ({ weight, characters: new Set(font.getCharacterSet()) }))
  const checked = new Set<number>()
  const pending: { value: unknown; path: string }[] = [{ value: report, path: 'report' }]
  while (pending.length) {
    const { value, path } = pending.pop()!
    if (typeof value === 'string') {
      for (const character of value) {
        const code = character.codePointAt(0)!
        if (checked.has(code) || [9, 10, 13, 0x85, 0x2028, 0x2029].includes(code)) continue
        for (const font of supported) {
          if (!font.characters.has(code) || code < 32 || (code >= 0x7f && code < 0xa0) || (code >= 0xd800 && code <= 0xdfff)) {
            const unicode = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
            throw new Error(`The local PDF ${font.weight} font cannot render ${unicode} in ${path}. No source text was substituted or omitted. Use another report format or supply a locally licensed PDF font that supports this character.`)
          }
        }
        checked.add(code)
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) pending.push({ value: child, path: `${path}.${key}` })
    }
  }
}

function targetIdentity(target: ReportTarget): string {
  return `${target.displayName ? `Source target title: ${target.label}\n` : ''}Exact target ID: ${target.id}\n${target.kind === 'grade' ? 'Grade' : 'Job'} · ${target.sublabel}\n${target.versionLabel}\nRubric: ${target.rubricId} · version ${target.rubricVersion}`
}

function reviewNumber(group: ReportGroup, comparison: ReportComparison, report: AnalysisReport): number {
  let count = 0
  for (const item of report.groups) {
    if (item === group) return count + group.comparisons.indexOf(comparison as RankedReportComparison) + 1
    count += item.comparisons.length
  }
  throw new Error('A PDF comparison is missing its exact report target.')
}

function savedCriterionHighlights(target: ReportTarget, comparison: ReportComparison): string {
  const highlights = comparison.criteria
    .filter(criterion => criterion.score !== null)
    .map((criterion, index) => ({ criterion, index }))
    .sort((left, right) => right.criterion.score! - left.criterion.score! || left.index - right.index)
    .slice(0, 2)
    .map(({ criterion }) => {
      const definition = target.criteria.find(value => value.id === criterion.criterionId)
      if (!definition) throw new Error(`Missing saved criterion definition ${criterion.criterionId}.`)
      return `${summaryExcerpt(definition.label, 64).text}: ${criterionScoreLabel(criterion)} · ${evidenceStatusLabel(criterion.evidenceStatus)}`
    })
  return highlights.length ? `Criterion highlights (excerpt):\n${highlights.join('\n')}` : 'No scored criterion highlights.'
}

function writeRunContext(layout: PdfReportLayout, report: AnalysisReport): void {
  layout.paragraph(report.dataKind === 'sample' ? `Sample ${REPORT_TITLE}` : REPORT_TITLE, { size: 23, bold: true, leading: 32, after: 7 })
  layout.paragraph(report.run.name, { size: 14, bold: true, after: 10 })
  layout.paragraph([
    `Run ID: ${report.run.id} · Created: ${report.run.createdAt}`,
    ...(report.workspaceId ? [`Workspace ID: ${report.workspaceId}`] : []),
    `Capture interval: ${report.capture.startedAt} to ${report.capture.completedAt}`,
    `Generated: ${report.generatedAt}`,
    `Scope: ${report.scope.targetId ? `Exact target ${report.scope.targetId}` : `Entire saved analysis · ${report.groups.length} exact targets`}`,
    `Included: ${report.candidateCount} candidates · ${report.counts.total} candidate/target comparisons`,
  ].join('\n'), { size: 9.5, leading: 14, after: 10 })
  for (const notice of report.notices) {
    layout.paragraph(notice, {
      size: 9.5, leading: 14, after: 5,
      bold: notice.startsWith('Partial report:') || notice.startsWith('Fictional sample'),
      color: notice.startsWith('Partial report:') || notice.startsWith('Fictional sample') ? PDF_REPORT_COLORS.accent : PDF_REPORT_COLORS.muted,
    })
  }
}

function writeTargetSummary(layout: PdfReportLayout, report: AnalysisReport, group: ReportGroup, index: number): void {
  const target = group.target
  layout.startSection({
    section: 'Target summary',
    primary: `Target ${index + 1} of ${report.groups.length} · ${targetName(target)}`,
    secondary: `${target.versionLabel} · ${target.id} · ${target.rubricId} v${target.rubricVersion}`,
  })
  if (index === 0) writeRunContext(layout, report)
  layout.heading(`Target ${index + 1} · ${targetName(target)}`, 17)
  layout.paragraph(targetIdentity(target), { size: 9.5, leading: 14, after: 8 })
  layout.paragraph(reportStatusNotice(group.counts), { size: 9.5, leading: 14, after: 7 })
  layout.heading('Highest evidence matches', 13)
  layout.paragraph(highlightNotice(group), { size: 9.5, leading: 14, after: 7 })
  const comparisons = new Map(group.comparisons.map(comparison => [comparison.id, comparison]))
  const highlighted = group.highlightedComparisonIds.map(id => {
    const comparison = comparisons.get(id)
    if (!comparison || comparison.status !== 'complete' || comparison.overall.status !== 'available' || comparison.rank === null) {
      throw new Error(`The PDF highlight ${id} is not a completed, ranked comparison for its exact target.`)
    }
    return comparison
  })
  layout.table(
    ['Rank', 'Saved score', 'Candidate / review', 'Saved assessment highlights'],
    highlighted.map(comparison => [
      `${comparison.rank}`,
      overallScoreLabel(comparison.overall),
      `${candidateName(comparison.candidate)}\nReview ${reviewNumber(group, comparison, report)}\n${comparison.id}`,
      `Saved summary excerpt:\n${summaryExcerpt(comparison.summary!, 220).text}\n${savedCriterionHighlights(target, comparison)}`,
    ]),
    [40, 62, 140, 278],
  )
  layout.paragraph(
    `All ${group.counts.total} comparisons for this exact target appear in the full reviews, including unhighlighted, withheld and unfinished pairs. All target summaries precede the candidate reviews. Excerpts above are not substitutes for the full saved evidence.`,
    { size: 9.5, leading: 14, color: PDF_REPORT_COLORS.muted, after: 8 },
  )
}

function writeLimitation(layout: PdfReportLayout, limitation: ReportLimitation): void {
  layout.label(`Saved limitation · ${limitation.code}`)
  if (limitation.criterionId || limitation.qualificationId) {
    layout.paragraph([
      ...(limitation.criterionId ? [`Criterion ID: ${limitation.criterionId}`] : []),
      ...(limitation.qualificationId ? [`Qualification ID: ${limitation.qualificationId}`] : []),
    ].join('\n'), { size: 9.5, after: 4 })
  }
  layout.callout(limitation.message)
}

function writeCitations(layout: PdfReportLayout, label: string, citations: ReportCitation[]): void {
  if (!citations.length) {
    layout.paragraph(`${label}: no cited passages in the saved assessment.`, { size: 9.5, color: PDF_REPORT_COLORS.muted })
    return
  }
  citations.forEach((citation, index) => {
    layout.citation(`${label} ${index + 1} · Exact saved quotation`, citation.quote, `Source locator: ${citation.locator}`)
  })
}

function writeCriteria(layout: PdfReportLayout, target: ReportTarget, comparison: ReportComparison): void {
  const assessments = new Map(comparison.criteria.map(criterion => [criterion.criterionId, criterion]))
  const criteria = target.criteria.map(definition => {
    const assessment = assessments.get(definition.id)
    if (!assessment) throw new Error(`Missing saved assessment for criterion ${definition.id}.`)
    return { definition, assessment }
  })
  layout.heading('Criterion summary')
  layout.paragraph('Saved scores and evidence states are unchanged. A ~ before a weight denotes display rounding only. Not applicable is excluded; missing evidence and not assessed are distinct.', { size: 9.5 })
  layout.table(
    ['Criterion / requirement', 'Weight', 'Saved score', 'Evidence status'],
    criteria.map(({ definition, assessment }) => [
      `${definition.label}\n${definition.id}\n${definition.requirementType ?? 'Requirement not specified'}`,
      formatReportWeight(assessment.weight),
      criterionScoreLabel(assessment),
      evidenceStatusLabel(assessment.evidenceStatus),
    ]),
    [231, 55, 90, 144],
  )
  layout.heading('Detailed criterion evidence', 16)
  criteria.forEach(({ definition, assessment }, index) => {
    layout.heading(`Criterion ${index + 1} · ${definition.label}`)
    layout.paragraph(`Criterion ID: ${definition.id}\nSaved weight: ${formatReportWeight(assessment.weight)} · Requirement: ${definition.requirementType ?? 'Not specified'}\nSaved score: ${criterionScoreLabel(assessment)} · ${evidenceStatusLabel(assessment.evidenceStatus)}`)
    layout.label('Saved criterion wording')
    layout.paragraph(definition.description)
    layout.label('Saved guidance')
    layout.paragraph(definition.guidance)
    layout.label('Saved assessment rationale')
    layout.paragraph(assessment.rationale)
    if (assessment.limitation) writeLimitation(layout, assessment.limitation)
    writeCitations(layout, 'Resume evidence', assessment.citations)
    writeCitations(layout, 'Requirement evidence', assessment.requirementCitations)
  })
}

function writeQualifications(layout: PdfReportLayout, comparison: ReportComparison): void {
  if (!comparison.qualifications.length) return
  layout.heading('GS qualifications — separate, unscored human review', 16)
  layout.paragraph('These saved qualification findings are not criterion scores, do not contribute a separate numeric score, and are not official GS eligibility findings.')
  comparison.qualifications.forEach((qualification, index) => {
    layout.heading(`Qualification ${index + 1} · ${qualification.qualificationId}`)
    layout.label('Saved qualification wording')
    layout.paragraph(qualification.text)
    layout.paragraph(`Evidence status: ${evidenceStatusLabel(qualification.evidenceStatus)}\nSource support: ${qualification.support}\nScore: Unscored qualification review`)
    layout.label('Saved interpretation')
    layout.paragraph(qualification.interpretation || 'No interpretation was recorded.')
    layout.label('Saved qualification rationale')
    layout.paragraph(qualification.rationale)
    if (qualification.limitation) writeLimitation(layout, qualification.limitation)
    writeCitations(layout, 'Resume evidence', qualification.citations)
    writeCitations(layout, 'Requirement evidence', qualification.requirementCitations)
  })
}

function writeProvenance(layout: PdfReportLayout, target: ReportTarget, comparison: ReportComparison): void {
  layout.heading('Saved provenance')
  const identities = [
    `Analyzed: ${comparison.analyzedAt ?? 'No analysis timestamp recorded'}`,
    `Evidence type: ${comparison.dataKind === 'sample' ? 'Fictional sample' : 'Saved real assessment'}`,
    ...[...target.facts, ...comparison.provenance].map(fact => `${fact.label}: ${fact.value}`),
  ]
  if (target.snapshot) identities.push(`Target snapshot: ${target.snapshot.snapshotId}`, `Target snapshot SHA-256: ${target.snapshot.sha256}`)
  if (comparison.candidate.snapshot) identities.push(`Resume snapshot: ${comparison.candidate.snapshot.snapshotId}`, `Resume snapshot SHA-256: ${comparison.candidate.snapshot.sha256}`)
  if (comparison.candidate.documentSha256) identities.push(`Resume document SHA-256: ${comparison.candidate.documentSha256}`)
  if (comparison.resultSha256) identities.push(`Saved result SHA-256: ${comparison.resultSha256}`)
  layout.metadata(identities)
  if (target.selection) {
    layout.label('Frozen target selection')
    layout.metadata(Object.entries(target.selection).map(([field, value]) => `${field}: ${value}`))
  }
}

function writeComparison(
  layout: PdfReportLayout, report: AnalysisReport, group: ReportGroup,
  comparison: RankedReportComparison, groupIndex: number, number: number,
): void {
  const target = group.target
  layout.startSection({
    section: 'Candidate review',
    primary: `Review ${number} of ${report.counts.total} · ${candidateName(comparison.candidate)}`,
    secondary: `Target ${groupIndex + 1} · ${targetName(target)} · ${target.versionLabel}`,
  })
  layout.paragraph(`CANDIDATE / TARGET REVIEW ${number}`, { size: 9.5, bold: true, color: PDF_REPORT_COLORS.accent })
  layout.paragraph(candidateName(comparison.candidate), { size: 22, leading: 31, bold: true, after: 6, keepWithNext: 30 })
  layout.paragraph(targetName(target), { size: 13, bold: true, after: 4, keepWithNext: 28 })
  layout.metadata([
    ...(comparison.candidate.displayName ? [`Source-stated name: ${comparison.candidate.name ?? 'Not stated'}`] : []),
    ...(target.displayName ? [`Source target title: ${target.label}`] : []),
    `Role: ${comparison.candidate.role ?? 'Not recorded'}`,
    `${target.kind === 'grade' ? 'Grade' : 'Job'} · ${target.sublabel}`,
    `Exact target ID: ${target.id}`,
    `${target.versionLabel} · Rubric: ${target.rubricId} · version ${target.rubricVersion}`,
    `Candidate ID: ${comparison.candidate.id}`,
    `Comparison ID: ${comparison.id}`,
    `Resume source: ${comparison.candidate.sourceLabel}`,
    `Document: ${comparison.candidate.documentId} · version ${comparison.candidate.documentVersion}`,
  ])
  layout.callout(`Status at capture: ${comparisonStatusLabel(comparison.status)}\nSaved overall score: ${overallScoreLabel(comparison.overall)}`, true)
  if (comparison.overall.status !== 'available') layout.paragraph(`Score availability reason: ${comparison.overall.reason}`, { size: 9.5 })
  if (comparison.error) {
    layout.label(`Processing error · ${comparison.error.code}`)
    layout.paragraph(comparison.error.message)
    layout.paragraph(`Stage: ${comparison.error.stage ?? 'Not recorded'} · Retryable: ${comparison.error.retryable === null ? 'Not recorded' : comparison.error.retryable ? 'Yes' : 'No'}`, { size: 9.5 })
  }
  if (comparison.status !== 'complete') {
    layout.callout('No completed assessment was captured for this pair. No overall rank, criterion scores, assessment rationale or qualification findings are inferred.')
    writeProvenance(layout, target, comparison)
    return
  }
  layout.paragraph(`Completion: ${comparison.completion}\nEvidence-match rank within this exact target: ${comparison.rank === null ? 'Not ranked — overall score withheld' : comparison.rank}\nHighlighted in target summary: ${group.highlightedComparisonIds.includes(comparison.id) ? 'Yes' : 'No'}`)
  layout.heading('Full saved overall assessment', 16)
  layout.paragraph(comparison.summary!)
  if (comparison.coverage) {
    const coverage = comparison.coverage
    layout.heading('Evidence coverage')
    layout.callout(`${coverage.totalCriteria} criteria · ${coverage.supported} supported · ${coverage.partial} partial · ${coverage.missing} missing · ${coverage.notAssessed} not assessed · ${coverage.notApplicable} not applicable (excluded)\nAssessed weight: ${coverage.assessedWeight} / ${coverage.totalWeight}`)
  } else {
    layout.paragraph('Evidence coverage: no saved coverage totals were recorded.', { size: 9.5 })
  }
  if (comparison.limitations.length) {
    layout.heading('Overall saved limitations')
    for (const limitation of comparison.limitations) writeLimitation(layout, limitation)
  } else {
    layout.paragraph('Overall saved limitations: none recorded. Criterion and qualification limitations, when present, appear with their findings.', { size: 9.5 })
  }
  writeCriteria(layout, target, comparison)
  writeQualifications(layout, comparison)
  writeProvenance(layout, target, comparison)
}

export async function generatePdfReport(report: AnalysisReport, options?: ReportGenerationOptions): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const fonts = await embedReportFonts(document, options)
  assertSupportedReportText(report, fonts)
  document.setTitle(reportTitle(report), { showInWindowTitleBar: true })
  document.setAuthor('Score')
  document.setSubject('Saved analysis evidence for qualified human review')
  document.setCreator('Score')
  document.setProducer('Score · pdf-lib')
  document.setCreationDate(new Date(report.generatedAt))
  document.setModificationDate(new Date(report.generatedAt))
  const designation = `${report.dataKind === 'sample' ? 'SAMPLE' : 'SAVED ANALYSIS'}${report.partial ? ' · PARTIAL' : ''}`
  const layout = new PdfReportLayout(document, fonts, designation)
  report.groups.forEach((group, index) => writeTargetSummary(layout, report, group, index))
  let number = 0
  report.groups.forEach((group, groupIndex) => {
    for (const comparison of group.comparisons) writeComparison(layout, report, group, comparison, groupIndex, ++number)
  })
  layout.finish()
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false })
  layout.checkTime()
  if (bytes.byteLength > REPORT_LIMITS.maxOutputBytes) {
    throw new Error(`PDF exceeds the ${Math.floor(REPORT_LIMITS.maxOutputBytes / 1024 / 1024)} MiB output resource limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.`)
  }
  return bytes
}
