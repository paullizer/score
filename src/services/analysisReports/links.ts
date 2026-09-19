import type { AnalysisReport, ReportComparison, ReportGenerationOptions, ReportLinkContext } from '../../domain/analysis-reports'
import { savedReviewPath } from '../../app/saved-review-navigation'

export function validatedReportLinkContext(report: AnalysisReport, options?: ReportGenerationOptions): ReportLinkContext {
  const context = options?.links
  if (!context) throw new Error('Report review links require the trusted application origin. Open the analysis in Score and export again.')
  const invalidOrigin = 'Report review links require a valid HTTP(S) application origin without credentials, a path, a query, or a fragment.'
  if (typeof context.origin !== 'string' || !/^https?:\/\/[^/?#\\\s@]+\/?$/i.test(context.origin)) throw new Error(invalidOrigin)
  let origin: URL
  try { origin = new URL(context.origin) } catch { throw new Error(invalidOrigin) }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error(invalidOrigin)
  }
  if (context.workspaceId !== undefined && (typeof context.workspaceId !== 'string' || !context.workspaceId.trim())) {
    throw new Error('Report review links require a valid workspace identity when a workspace is supplied.')
  }
  if (report.dataKind === 'real' && (!report.workspaceId || (context.workspaceId !== undefined && context.workspaceId !== report.workspaceId))) {
    throw new Error('The report review link workspace must match the saved real analysis workspace.')
  }
  const workspaceId = report.dataKind === 'real' ? report.workspaceId : context.workspaceId
  // Validate route identities even when an export has no featured candidates.
  savedReviewPath({ workspaceId, runId: report.run.id, comparisonId: 'validation', dataKind: report.dataKind })
  return { origin: origin.origin, ...(workspaceId === undefined ? {} : { workspaceId }) }
}

export function reportReviewLinks(
  report: AnalysisReport, comparison: ReportComparison, options?: ReportGenerationOptions,
): { analysis: string; resume: string; target: string } {
  const context = validatedReportLinkContext(report, options)
  if (comparison.dataKind !== report.dataKind || !report.groups.some((group) => group.target.id === comparison.targetId
    && group.comparisons.some((saved) => saved.id === comparison.id))) {
    throw new Error('Report review links must refer to a comparison in this saved analysis.')
  }
  const route = { workspaceId: context.workspaceId, runId: report.run.id, comparisonId: comparison.id, dataKind: report.dataKind }
  return {
    analysis: context.origin + savedReviewPath(route),
    resume: context.origin + savedReviewPath({ ...route, view: 'resume' }),
    target: context.origin + savedReviewPath({ ...route, view: 'target' }),
  }
}
