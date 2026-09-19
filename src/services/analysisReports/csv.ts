import { REPORT_LIMITS, type AnalysisReport, type RankedReportComparison, type ReportGroup } from '../../domain/analysis-reports'
import { candidateSourceName, comparisonStatusLabel, evidenceStatusLabel, REPORT_HUMAN_REVIEW_NOTICE, targetName } from './presentation'

type Cell = string | number | null

function csvCell(value: Cell): string {
  if (value === null || value === '') return ''
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('The CSV report contains an invalid numeric value.')
    return String(value)
  }
  const formula = /^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u.test(value) || /^[\t\r\n]/u.test(value)
  return `"${(formula ? `'${value}` : value).replace(/"/g, '""')}"`
}

function assessmentNotes(group: ReportGroup, comparison: RankedReportComparison): string {
  return comparison.criteria.map((assessment) => {
    const definition = group.target.criteria.find((criterion) => criterion.id === assessment.criterionId)
    if (!definition) throw new Error('The CSV assessment does not match its saved rubric.')
    return `${definition.label} [${definition.id}]: ${evidenceStatusLabel(assessment.evidenceStatus)}`
  }).join('\n')
}

function limitations(comparison: RankedReportComparison): string {
  const entries = [
    ...comparison.limitations,
    ...comparison.criteria.flatMap((criterion) => criterion.limitation ? [criterion.limitation] : []),
    ...comparison.qualifications.flatMap((qualification) => qualification.limitation ? [qualification.limitation] : []),
  ]
  return [...new Set(entries.map((entry) =>
    `${entry.criterionId ?? entry.qualificationId ?? entry.code}: ${entry.message}`,
  ))].join('\n')
}

export function generateCsvReport(report: AnalysisReport): Uint8Array {
  const displayLabels = report.groups.some(group => group.target.displayName || group.comparisons.some(comparison => comparison.candidate.displayName))
  const columns = report.groups.flatMap(({ target }, targetIndex) => target.criteria.map((criterion, criterionIndex) => ({
    targetId: target.id,
    criterionId: criterion.id,
    header: `[T${targetIndex + 1} C${criterionIndex + 1}] ${targetName(target)} | ${target.versionLabel} | ${criterion.label} [${criterion.id}] (${criterion.weight}% weight; 0-5)`,
  })))
  const header: Cell[] = [
    'Candidate name', 'Job/grade title', ...columns.map((column) => column.header), 'Overall score', 'Overall assessment',
    'Evidence-match rank within target', 'Highlighted evidence match', 'Highlight cutoff score', 'Additional candidates tied at cutoff',
    'Comparison status', 'Assessment completion',
    'Overall score availability', 'Overall score reason', 'Criterion evidence statuses',
    'Supported criteria', 'Partially supported criteria', 'Missing evidence criteria', 'Not assessed criteria',
    'Not applicable criteria', 'Total criteria', 'Assessed weight (%)', 'Total weight (%)',
    'Limitations', 'Processing error', 'Unscored GS qualifications',
    'Target kind', 'Target ID', 'Saved target version', 'Rubric ID', 'Rubric version',
    'Candidate ID', 'Candidate role', 'Resume source label', 'Resume document ID', 'Resume document version',
    'Resume document SHA-256', 'Resume snapshot ID', 'Target snapshot ID', 'Saved result SHA-256',
    'Run name', 'Run ID', 'Comparison ID', 'Analysis created at', 'Comparison assessed at',
    'Capture started at', 'Capture completed at', 'Report generated at', 'Report data', 'Report status', 'Human review notice',
    ...(displayLabels ? ['Candidate display label', 'Job/grade display title'] : []),
  ]
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = [Uint8Array.of(0xef, 0xbb, 0xbf)]
  let bytes = 3
  function append(cells: Cell[]) {
    const chunk = encoder.encode(`${cells.map(csvCell).join(',')}\r\n`)
    bytes += chunk.byteLength
    if (bytes > REPORT_LIMITS.maxOutputBytes) {
      throw new Error('This CSV exceeds the report download size limit. Export one job or grade at a time; no rows were omitted.')
    }
    chunks.push(chunk)
  }
  append(header)
  let rows = 0
  for (const group of report.groups) {
    const { target } = group
    for (const comparison of group.comparisons) {
      const scores = columns.map((column): Cell => {
        if (column.targetId !== target.id) return null
        if (comparison.status !== 'complete') return 'Not assessed'
        const assessment = comparison.criteria.find((criterion) => criterion.criterionId === column.criterionId)
        if (!assessment) throw new Error('A saved criterion assessment is missing. No incomplete CSV was downloaded.')
        return assessment.score ?? (assessment.evidenceStatus === 'not-applicable' ? 'N/A' : 'Not assessed')
      })
      const coverage = comparison.coverage
      append([
        candidateSourceName(comparison.candidate), target.label, ...scores,
        comparison.overall.score, comparison.summary,
        comparison.rank, comparison.highlighted ? 'Yes' : 'No', group.cutoffScore, group.additionalCutoffTies, comparisonStatusLabel(comparison.status),
        comparison.completion, comparison.overall.status, comparison.overall.status === 'available' ? null : comparison.overall.message,
        assessmentNotes(group, comparison),
        coverage?.supported ?? null, coverage?.partial ?? null, coverage?.missing ?? null, coverage?.notAssessed ?? null,
        coverage?.notApplicable ?? null, coverage?.totalCriteria ?? null, coverage?.assessedWeight ?? null, coverage?.totalWeight ?? null,
        limitations(comparison),
        comparison.error ? `${comparison.error.code}: ${comparison.error.message}` : null,
        comparison.qualifications.map((qualification) =>
          `${qualification.text} [${qualification.qualificationId}]: ${evidenceStatusLabel(qualification.evidenceStatus)}; ${qualification.rationale}`,
        ).join('\n'),
        target.kind, target.id, target.versionLabel, target.rubricId, target.rubricVersion,
        comparison.candidate.id, comparison.candidate.role, comparison.candidate.sourceLabel,
        comparison.candidate.documentId, comparison.candidate.documentVersion, comparison.candidate.documentSha256,
        comparison.candidate.snapshot?.snapshotId ?? null, target.snapshot?.snapshotId ?? null, comparison.resultSha256,
        report.run.name, report.run.id, comparison.id, report.run.createdAt, comparison.analyzedAt,
        report.capture.startedAt, report.capture.completedAt, report.generatedAt,
        report.dataKind === 'sample' ? 'Fictional sample' : 'Real saved evidence', report.partial ? 'Partial' : 'Complete',
        REPORT_HUMAN_REVIEW_NOTICE,
        ...(displayLabels ? [comparison.candidate.displayName ?? null, target.displayName ?? null] : []),
      ])
      rows++
    }
  }
  if (rows !== report.counts.total) throw new Error('The CSV rows do not match the captured analysis. No incomplete report was downloaded.')
  const result = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}
