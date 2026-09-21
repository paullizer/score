import { REPORT_FORMATS, REPORT_LIMITS } from '../../domain/analysis-reports'
import type {
  AnalysisReport, AnalysisReportFormat, ReportCandidate, ReportCitation, ReportComparison,
  ReportComparisonStatus, ReportCriterionAssessment, ReportDataKind, ReportEvidenceStatus,
  ReportGroup, ReportOverallScore, ReportStatusCounts, ReportTarget,
} from '../../domain/analysis-reports'
import type { DocumentPagination } from '../../domain/document-formats'
import { getDisplayName } from '../../domain/displayNames'

export const REPORT_TITLE = 'Analysis evidence report'
export const REPORT_HUMAN_REVIEW_NOTICE = 'Highest evidence matches are not hiring recommendations or official GS eligibility findings. A qualified reviewer must inspect the evidence and limitations.'
export const REPORT_SAMPLE_NOTICE = 'Fictional sample data. Fixed illustrative scores are not real assessments.'
export const REPORT_CAPTURE_NOTICE = 'This report records a capture interval, not an instantaneous database snapshot. Comparisons unfinished at capture remain unfinished in this report.'
export const REPORT_FONT_FAMILY = 'Noto Sans'
export const REPORT_PALETTE = {
  background: 'F7F4EF',
  paper: 'FFFFFF',
  text: '242424',
  accent: 'B11F4B',
  muted: '625E5B',
  border: 'D8D0C7',
} as const

export function reportTitle(report: Pick<AnalysisReport, 'dataKind' | 'run' | 'capture'>): string {
  return `${report.dataKind === 'sample' ? 'Sample ' : ''}${report.capture.settings.policy.title} — ${report.run.name}`
}

export function comparisonStatusLabel(status: ReportComparisonStatus): string {
  return { queued: 'Queued', running: 'Running', complete: 'Complete', failed: 'Failed', cancelled: 'Cancelled' }[status]
}

export function evidenceStatusLabel(status: ReportEvidenceStatus): string {
  return {
    supported: 'Supported',
    partial: 'Partial evidence',
    missing: 'Missing evidence',
    'not-assessed': 'Not assessed',
    'not-applicable': 'Not applicable (excluded)',
  }[status]
}

export function overallScoreLabel(overall: ReportOverallScore): string {
  if (overall.status === 'available') return `${overall.score} / 100`
  return `${overall.status === 'withheld' ? 'Withheld' : 'Unavailable'} — ${overall.message}`
}

export function criterionScoreLabel(criterion: Pick<ReportCriterionAssessment, 'score' | 'evidenceStatus'>): string {
  return criterion.score === null ? evidenceStatusLabel(criterion.evidenceStatus) : `${criterion.score} / 5`
}

export function formatReportWeight(weight: number): string {
  if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw new Error('A report criterion has an invalid weight.')
  if (weight > 0 && weight < 0.01) return '<0.01%'
  const display = Number(weight.toFixed(2))
  return `${display === weight ? '' : '~'}${display}%`
}

export function unavailableOverallScore(status: Exclude<ReportComparisonStatus, 'complete'>): ReportOverallScore {
  return { status: 'unavailable', score: null, reason: 'not-complete', message: `${comparisonStatusLabel(status)}; no completed assessment was captured.` }
}

export function candidateSourceName(candidate: ReportCandidate): string {
  return candidate.name?.trim() ? candidate.name : `Unnamed candidate (${candidate.id})`
}

export function candidateName(candidate: ReportCandidate): string {
  return getDisplayName(candidate, candidateSourceName(candidate))
}

export function targetName(target: ReportTarget): string {
  return getDisplayName(target, target.label)
}

export function paginationLabel(pagination: DocumentPagination, page: number): string {
  switch (pagination) {
    case 'pdf-pages': return `PDF page ${page}`
    case 'html-sections': return `Captured HTML section ${page}`
    case 'markdown-sections': return `Markdown section ${page}`
    case 'captured-sections': return `Captured source section ${page} (not a printed page)`
  }
}

export function sourceVersionLocator(source: Pick<ReportCitation, 'sourceTitle' | 'documentId' | 'documentVersion'>): string {
  return `${source.sourceTitle} · ${source.documentId} · version ${source.documentVersion}`
}

export function citationLocator(citation: Omit<ReportCitation, 'quote' | 'locator'>): string {
  return `${sourceVersionLocator(citation)} · ${paginationLabel(citation.pagination, citation.page)} · ${citation.heading} · paragraph ${citation.paragraphId}`
}

export function reportStatusNotice(counts: ReportStatusCounts): string {
  const description = `${counts.complete} of ${counts.total} comparisons complete; ${counts.scored} scored; ${counts.withheld} overall scores withheld`
  return counts.complete === counts.total ? `${description}.` :
    `Partial report: ${description}; ${counts.queued} queued; ${counts.running} running; ${counts.failed} failed; ${counts.cancelled} cancelled.`
}

export function buildReportNotices(dataKind: ReportDataKind, counts: ReportStatusCounts, additionalFooter = ''): string[] {
  return [
    ...(dataKind === 'sample' ? [REPORT_SAMPLE_NOTICE] : []),
    REPORT_HUMAN_REVIEW_NOTICE,
    reportStatusNotice(counts),
    REPORT_CAPTURE_NOTICE,
    ...(additionalFooter ? [additionalFooter] : []),
  ]
}

export function highlightNotice(group: ReportGroup): string {
  if (!group.highlightedComparisonIds.length) return 'No scored highlights are available for this exact target. Completed assessments with withheld totals remain in the details.'
  const prefix = `Highest evidence matches within this exact target only (${group.highlightedComparisonIds.length} highlighted). Equal saved scores share the same competition rank.`
  return group.additionalCutoffTies ? `${prefix} The highlight list is capped at ${group.highlightLimit ?? REPORT_LIMITS.maxHighlights}; ${group.additionalCutoffTies} additional candidates tied at ${group.cutoffScore} / 100 appear in the full details. Original order determines display order within a tie, not an evidence advantage.` : prefix
}

export function summaryExcerpt(summary: string, maxCharacters = 240): { text: string; shortened: boolean } {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 16) throw new Error('An excerpt needs at least 16 characters.')
  const characters = Array.from(summary)
  if (characters.length <= maxCharacters) return { text: summary, shortened: false }
  const suffix = '… [excerpt]'
  return { text: `${characters.slice(0, maxCharacters - suffix.length).join('').trimEnd()}${suffix}`, shortened: true }
}

export function safeReportFilename(name: string, format: AnalysisReportFormat): string {
  let stem = name.normalize('NFKC').replace(/[<>:"/\\|?*]/g, '-').replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '')
  stem = Array.from(stem).slice(0, 96).join('').replace(/[. ]+$/g, '') || 'Analysis report'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `Report ${stem}`
  return `${stem}.${REPORT_FORMATS[format].extension}`
}

export function assertXmlText(text: string, context = 'Report text'): void {
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)) continue
    throw new Error(`${context} contains an XML-invalid character (U+${code.toString(16).toUpperCase().padStart(4, '0')}). The report cannot be generated safely.`)
  }
}

export function assertReportXmlText(report: AnalysisReport): void {
  const pending: unknown[] = [report]
  const seen = new WeakSet<object>()
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string') assertXmlText(value)
    else if (value !== null && typeof value === 'object' && !seen.has(value)) {
      seen.add(value)
      pending.push(...Object.values(value))
    }
  }
}

export interface ReportTextBlock {
  kind: 'heading' | 'paragraph' | 'citation'
  text: string
}

export function buildComparisonDetailBlocks(target: ReportTarget, comparison: ReportComparison): ReportTextBlock[] {
  const blocks: ReportTextBlock[] = []
  const add = (text: string, kind: ReportTextBlock['kind'] = 'paragraph') => { blocks.push({ kind, text }) }
  const cite = (label: string, citations: ReportCitation[]) => {
    for (const citation of citations) add(`${label}: “${citation.quote}”\n${citation.locator}`, 'citation')
  }
  add(`${candidateName(comparison.candidate)} — ${targetName(target)}`, 'heading')
  if (comparison.candidate.displayName) add(`Source-stated name: ${comparison.candidate.name ?? 'Not stated'}`)
  if (target.displayName) add(`Source target title: ${target.label}`)
  add(`Candidate ID: ${comparison.candidate.id}\nRole: ${comparison.candidate.role ?? 'Not recorded'}\nComparison ID: ${comparison.id}`)
  add(`Target: ${target.id}\n${target.kind === 'grade' ? 'Grade' : 'Job'} · ${target.sublabel}\n${target.versionLabel}\nRubric: ${target.rubricId} · version ${target.rubricVersion}`)
  add(`Resume: ${comparison.candidate.sourceLabel}\nDocument: ${comparison.candidate.documentId} · version ${comparison.candidate.documentVersion}`)
  for (const fact of target.facts) add(`${fact.label}: ${fact.value}`)
  if (target.snapshot) add(`Target snapshot: ${target.snapshot.snapshotId} · SHA-256 ${target.snapshot.sha256}`)
  if (comparison.candidate.snapshot) add(`Resume snapshot: ${comparison.candidate.snapshot.snapshotId} · SHA-256 ${comparison.candidate.snapshot.sha256}`)
  if (comparison.candidate.documentSha256) add(`Resume document SHA-256: ${comparison.candidate.documentSha256}`)
  add(`Status: ${comparisonStatusLabel(comparison.status)}\nOverall score: ${overallScoreLabel(comparison.overall)}`)
  if (comparison.error) add(`Processing error (${comparison.error.code}): ${comparison.error.message}`)
  if (comparison.status === 'complete') {
    add(`Completion: ${comparison.completion}\nAnalyzed: ${comparison.analyzedAt ?? 'Timestamp not recorded in saved sample'}`)
    if (comparison.resultSha256) add(`Saved result SHA-256: ${comparison.resultSha256}`)
    add(comparison.summary!)
    if (comparison.coverage) {
      const coverage = comparison.coverage
      add(`Evidence coverage: ${coverage.totalCriteria} criteria; ${coverage.supported} supported; ${coverage.partial} partial; ${coverage.missing} missing; ${coverage.notAssessed} not assessed; ${coverage.notApplicable} not applicable. Assessed weight: ${coverage.assessedWeight} / ${coverage.totalWeight}.`)
    }
    for (const definition of target.criteria) {
      const assessment = comparison.criteria.find(criterion => criterion.criterionId === definition.id)
      if (!assessment) throw new Error(`Missing saved assessment for criterion ${definition.id}.`)
      add(definition.label, 'heading')
      add(`Criterion: ${definition.id}\n${definition.description}`)
      add(`Weight: ${formatReportWeight(definition.weight)} · Requirement: ${definition.requirementType ?? 'Not specified'}\nScore: ${criterionScoreLabel(assessment)} · ${evidenceStatusLabel(assessment.evidenceStatus)}`)
      add(`Saved guidance: ${definition.guidance}`)
      add(assessment.rationale)
      if (assessment.limitation) add(`Limitation (${assessment.limitation.code}): ${assessment.limitation.message}`)
      cite('Resume evidence', assessment.citations)
      cite('Requirement evidence', assessment.requirementCitations)
    }
    if (comparison.qualifications.length) add('GS qualifications — separate, unscored human review', 'heading')
    for (const qualification of comparison.qualifications) {
      add(qualification.text, 'heading')
      add(`Qualification: ${qualification.qualificationId} · ${evidenceStatusLabel(qualification.evidenceStatus)}\nSource support: ${qualification.support}\n${qualification.interpretation}`)
      add(qualification.rationale)
      if (qualification.limitation) add(`Limitation (${qualification.limitation.code}): ${qualification.limitation.message}`)
      cite('Resume evidence', qualification.citations)
      cite('Requirement evidence', qualification.requirementCitations)
    }
    for (const limitation of comparison.limitations) add(`Limitation (${limitation.code}): ${limitation.message}`)
  }
  for (const fact of comparison.provenance) add(`${fact.label}: ${fact.value}`)
  return blocks
}
