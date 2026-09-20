import {
  ANALYSIS_DIAGNOSTIC_FIELDS, ANALYSIS_DIAGNOSTIC_LIMITS, ANALYSIS_SCHEMA_ISSUE_CODES,
  type AnalysisSchemaDiagnostics,
} from '../../src/domain/analysis-diagnostics'

export function analysisSchemaDiagnostics(
  issues: readonly { code: string; path: readonly PropertyKey[] }[],
): AnalysisSchemaDiagnostics {
  return {
    findings: issues.slice(0, ANALYSIS_DIAGNOSTIC_LIMITS.maxFindings).map(issue => ({
      code: ANALYSIS_SCHEMA_ISSUE_CODES.find(code => code === issue.code) ?? 'custom',
      path: issue.path.slice(0, ANALYSIS_DIAGNOSTIC_LIMITS.maxPathSegments).map(segment =>
        typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0 && segment <= 1_000_000
          ? segment : ANALYSIS_DIAGNOSTIC_FIELDS.find(field => field === segment) ?? 'unknown-field'),
    })),
    omittedFindings: Math.max(0, issues.length - ANALYSIS_DIAGNOSTIC_LIMITS.maxFindings),
  }
}
