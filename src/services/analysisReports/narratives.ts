import type {
  AnalysisNarrativeRevision, ReadyAnalysisCandidateNarrative, ReadyAnalysisTargetNarrative,
} from '../../domain/analysis-narratives'
import {
  ANALYSIS_REPORT_SCHEMA_VERSION, REPORT_LIMITS,
  type AnalysisReport, type ReportComparison, type ReportTarget, type ReportTargetPresentation,
} from '../../domain/analysis-reports'
import {
  reportCandidateNarrativeSchema, reportNarrativeCaptureSchema, reportTargetNarrativeSchema,
  reportTargetPresentationSchema,
} from './narrative-schemas'
import { summaryIssueDisclosures } from '../../domain/analysis-summary-history'

function requireSaved(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`${message} No PDF, Word, or PowerPoint report was produced. Reload the analysis, open Manage summaries, and retry when the selected summaries are ready.`)
}

function candidateNarrative(comparison: ReportComparison): ReadyAnalysisCandidateNarrative {
  const parsed = reportCandidateNarrativeSchema.safeParse(comparison.narrative)
  requireSaved(comparison.status === 'complete' && parsed.success && parsed.data.dataKind === comparison.dataKind,
    'A completed review is missing a valid saved candidate narrative.')
  return parsed.data
}

function targetNarrative(target: ReportTarget): ReadyAnalysisTargetNarrative {
  const parsed = reportTargetNarrativeSchema.safeParse(target.narrative)
  requireSaved(parsed.success && parsed.data.dataKind === target.dataKind, 'A target is missing a valid saved analysis overview.')
  return parsed.data
}

export function candidateNarrativeText(comparison: ReportComparison): string {
  return candidateNarrative(comparison).text
}

export function candidateNarrativeOverview(comparison: ReportComparison): string {
  return candidateNarrative(comparison).overview
}

export function targetNarrativeParagraphs(target: ReportTarget): string[] {
  return targetNarrative(target).paragraphs
}

export function candidateNarrativeDisclosures(comparison: ReportComparison): string[] {
  return summaryIssueDisclosures(candidateNarrative(comparison))
}

export function targetNarrativeDisclosures(target: ReportTarget): string[] {
  return summaryIssueDisclosures(targetNarrative(target))
}

export function reportTargetPresentation(target: ReportTarget): ReportTargetPresentation {
  requireSaved(target.presentation !== undefined, 'Frozen job title and organization metadata is missing; legacy labels cannot substitute for it.')
  const parsed = reportTargetPresentationSchema.safeParse(target.presentation)
  requireSaved(parsed.success, 'Frozen target presentation metadata is invalid.')
  return parsed.data
}

function matchesRevision(narrative: AnalysisNarrativeRevision | undefined, pin: AnalysisNarrativeRevision | null): boolean {
  return pin === null ? narrative === undefined :
    narrative !== undefined && narrative.revision === pin.revision && narrative.inputFingerprint === pin.inputFingerprint
}

// Validate the original capture, before a writer removes unassessed comparisons or empty target sections.
export function requireReportNarratives(report: AnalysisReport): void {
  requireSaved(report?.schemaVersion === ANALYSIS_REPORT_SCHEMA_VERSION &&
    report.dataKind === 'real' && Boolean(report.workspaceId?.trim()) &&
    Boolean(report.run?.id?.trim()) && report.scope &&
    (report.scope.targetId === null || (typeof report.scope.targetId === 'string' && report.scope.targetId.trim().length > 0)),
  'The narrative report identity or selected scope is invalid.')
  const parsed = reportNarrativeCaptureSchema.safeParse(report.capture?.summaries)
  requireSaved(parsed.success && parsed.data.ready && parsed.data.dataKind === report.dataKind,
    'A current, ready narrative capture is required.')
  const capture = parsed.data
  requireSaved(capture.scope.targetId === report.scope.targetId, 'The saved summaries were captured for a different export scope.')
  requireSaved(Array.isArray(report.groups) && report.groups.length > 0 && report.groups.length <= REPORT_LIMITS.maxTargets,
    'The narrative capture has no valid target groups.')
  const targets = new Map<string, ReportTarget>()
  const comparisons = new Map<string, ReportComparison>()
  const indexes = new Set<number>()
  const pairs = new Set<string>()
  let complete = 0
  for (const group of report.groups) {
    const target = group.target
    requireSaved(target && typeof target.id === 'string' && target.id.trim() && target.dataKind === report.dataKind &&
      !targets.has(target.id) && (report.scope.targetId === null || target.id === report.scope.targetId),
    'The report contains a duplicate, foreign, or out-of-scope target.')
    targets.set(target.id, target)
    reportTargetPresentation(target)
    requireSaved(Array.isArray(group.comparisons) && group.comparisons.length > 0, 'A target is missing its captured comparisons.')
    let targetComplete = 0
    for (const comparison of group.comparisons) {
      const pair = JSON.stringify([comparison.candidate?.id, comparison.targetId])
      requireSaved(comparison.targetId === target.id && comparison.dataKind === report.dataKind &&
        typeof comparison.id === 'string' && comparison.id.trim() && !comparisons.has(comparison.id) &&
        Number.isInteger(comparison.index) && comparison.index >= 0 && comparison.index < REPORT_LIMITS.maxComparisons &&
        !indexes.has(comparison.index) && !pairs.has(pair),
      'The report contains duplicate, foreign, or out-of-scope candidate reviews.')
      comparisons.set(comparison.id, comparison)
      indexes.add(comparison.index)
      pairs.add(pair)
      if (comparison.status === 'complete') {
        candidateNarrative(comparison)
        targetComplete++
        complete++
      } else {
        requireSaved(comparison.narrative === undefined, 'An unassessed comparison cannot carry a completed candidate narrative.')
      }
    }
    if (targetComplete) {
      targetNarrative(target)
    } else requireSaved(target.narrative === undefined, 'A target without completed reviews must not carry an assessment overview.')
  }
  requireSaved(complete > 0 && comparisons.size <= REPORT_LIMITS.maxComparisons &&
    report.counts?.total === comparisons.size && report.counts.complete === complete,
  'The narrative report is missing captured reviews or has inconsistent completion counts.')
  requireSaved(capture.targets.length === targets.size && capture.comparisons.length === comparisons.size,
    'The report omits or adds target/comparison pins from the authoritative selected scope.')
  for (const pin of capture.targets) {
    const target = targets.get(pin.targetId)
    requireSaved(target && matchesRevision(target.narrative, pin.narrative), 'A saved target overview does not match its current capture revision.')
  }
  for (const pin of capture.comparisons) {
    const comparison = comparisons.get(pin.comparisonId)
    requireSaved(comparison && comparison.targetId === pin.targetId && comparison.status === pin.status &&
      comparison.resultSha256 === pin.resultSha256 && matchesRevision(comparison.narrative, pin.narrative),
    'A saved review status, result hash, or candidate narrative does not match its current capture revision.')
  }
}
