import type { AnalysisReport, ReportGenerationOptions } from '../../domain/analysis-reports'
import { reportReviewLinks } from './links'
import { assertReportResourceLimits } from './model'
import { assessmentSummary, readableAnalysisDate, readableCandidateSourceName, readableTargetSourceLabel } from './readable'
import { reportGenerationPolicy, reportLimits, snapshotReportPolicy } from './policy'
import { buildReportNotices, REPORT_TITLE, reportTitle } from './presentation'

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

export function generateCsvReport(report: AnalysisReport, options?: ReportGenerationOptions): Uint8Array {
  const startedAt = Date.now()
  report = snapshotReportPolicy(report)
  const policy = reportGenerationPolicy(report, 'csv')
  const limits = reportLimits(policy)
  assertReportResourceLimits(report, limits.maxInputBytes)
  const customized = policy.title !== REPORT_TITLE || policy.additionalFooter !== ''
  const displayLabels = report.groups.some(group => group.target.displayName || group.comparisons.some(comparison => comparison.candidate.displayName))
  const criterionCount = Math.max(0, ...report.groups.map(group => group.target.criteria.length))
  const header: Cell[] = [
    'Candidate name',
    'Job/grade', 'Overall score', 'Overall assessment',
    ...Array.from({ length: criterionCount }, (_, index) => `C${index + 1}`),
    'Analysis date', 'Source', 'Analysis link', 'Resume link', 'Job/grade link',
    ...(displayLabels ? ['Candidate display label', 'Job/grade display title'] : []),
    ...(customized ? ['Report title', 'Report disclosures'] : []),
  ]
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = [Uint8Array.of(0xef, 0xbb, 0xbf)]
  let bytes = 3
  function checkTime() {
    if (Date.now() - startedAt > limits.maxGenerationMilliseconds) {
      throw new Error('CSV generation exceeded its time limit. Export one job or grade at a time; no file was downloaded.')
    }
  }
  function append(cells: Cell[]) {
    checkTime()
    const chunk = encoder.encode(`${cells.map(csvCell).join(',')}\r\n`)
    bytes += chunk.byteLength
    if (bytes > limits.maxOutputBytes) {
      throw new Error('This CSV exceeds the report download size limit. Export one job or grade at a time; no rows were omitted.')
    }
    chunks.push(chunk)
  }
  append(header)
  let rows = 0
  let comparisons = 0
  for (const group of report.groups) {
    const { target } = group
    const targetLabel = readableTargetSourceLabel(report, group)
    let completed = 0
    for (const comparison of group.comparisons) {
      comparisons++
      if (comparison.status !== 'complete') continue
      const assessments = new Map(comparison.criteria.map(criterion => [criterion.criterionId, criterion]))
      const scores = Array.from({ length: criterionCount }, (_, index): Cell => {
        const definition = target.criteria[index]
        if (!definition) return null
        const assessment = assessments.get(definition.id)
        if (!assessment) throw new Error('A saved criterion assessment is missing. No incomplete CSV was downloaded.')
        return assessment.score ?? (assessment.evidenceStatus === 'not-applicable' ? 'N/A' : 'Not assessed')
      })
      const links = reportReviewLinks(report, comparison, options)
      append([
        readableCandidateSourceName(comparison.candidate), targetLabel, comparison.overall.score,
        assessmentSummary(target, comparison, 300), ...scores,
        readableAnalysisDate(comparison.analyzedAt), comparison.candidate.sourceLabel,
        links.analysis, links.resume, links.target,
        ...(displayLabels ? [comparison.candidate.displayName ?? null, target.displayName ?? null] : []),
        ...(customized ? [reportTitle(report), buildReportNotices(report.counts, policy.additionalFooter).join('\n\n')] : []),
      ])
      rows++
      completed++
    }
    if (completed !== group.counts.complete || group.comparisons.length !== group.counts.total) {
      throw new Error('The CSV rows do not match the completed assessments. No incomplete report was downloaded.')
    }
  }
  if (!rows || rows !== report.counts.complete || comparisons !== report.counts.total) {
    throw new Error('The CSV rows do not match the completed assessments. No incomplete report was downloaded.')
  }
  const result = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  checkTime()
  return result
}
