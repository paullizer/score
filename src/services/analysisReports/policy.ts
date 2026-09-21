import { z } from 'zod'
import { createDefaultAdminSettings, LEGACY_SETTINGS_REVISION } from '../../domain/admin-settings-defaults'
import { reportSettingsSchema } from '../../domain/admin-settings-schema'
import {
  ANALYSIS_REPORT_SCHEMA_VERSION, REPORT_FORMATS, REPORT_LIMITS,
  type AnalysisReport, type AnalysisReportFormat, type RealReportCaptureResponse, type ReportPolicy, type ReportSettingsCapture,
} from '../../domain/analysis-reports'

const id = z.string().min(1).max(1024).refine(value => value === value.trim())
export const reportSettingsCaptureSchema: z.ZodType<ReportSettingsCapture> = z.strictObject({
  revision: id,
  policy: reportSettingsSchema,
})

export const realReportCaptureResponseSchema: z.ZodType<RealReportCaptureResponse> = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_REPORT_SCHEMA_VERSION), dataKind: z.literal('real'),
  workspaceId: id, runId: id, format: z.enum(['csv', 'pdf', 'docx', 'pptx']), settings: reportSettingsCaptureSchema,
  captureToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export function captureReportSettings(value?: ReportSettingsCapture): ReportSettingsCapture {
  const captured = reportSettingsCaptureSchema.parse(value ?? {
    revision: LEGACY_SETTINGS_REVISION, policy: createDefaultAdminSettings().reports,
  })
  Object.freeze(captured.policy.enabledFormats)
  Object.freeze(captured.policy.allowedRoles)
  Object.freeze(captured.policy)
  return Object.freeze(captured)
}

export function snapshotReportPolicy(report: AnalysisReport): AnalysisReport {
  return { ...report, capture: { ...report.capture, settings: captureReportSettings(report.capture.settings) } }
}

/** Safety ceilings remain independent of the settings revision captured for this export. */
export function reportLimits(policy: ReportPolicy) {
  return {
    maxComparisons: Math.min(policy.maxComparisons, REPORT_LIMITS.maxComparisons),
    batchComparisons: Math.min(policy.batchComparisons, REPORT_LIMITS.batchComparisons),
    maxConcurrentBatches: Math.min(policy.maxConcurrentBatches, REPORT_LIMITS.maxConcurrentBatches),
    maxInputBytes: Math.min(policy.maxInputBytes, REPORT_LIMITS.maxInputBytes),
    maxOutputBytes: Math.min(policy.maxOutputBytes, REPORT_LIMITS.maxOutputBytes),
    maxGenerationMilliseconds: Math.min(policy.maxGenerationMilliseconds, REPORT_LIMITS.maxGenerationMilliseconds),
    maxPages: Math.min(policy.maxPages, REPORT_LIMITS.maxPages),
    maxSlides: Math.min(policy.maxSlides, REPORT_LIMITS.maxSlides),
  }
}

export function assertReportFormat(policy: ReportPolicy, format: AnalysisReportFormat): void {
  if (!Object.hasOwn(REPORT_FORMATS, format)) throw new Error('The report format is invalid.')
  if (!policy.enabledFormats.includes(format)) {
    throw new Error(`${REPORT_FORMATS[format].label} export is disabled by application policy. No file was generated.`)
  }
  if (!policy.allowedRoles.length) throw new Error('Official exports are disabled for every workspace role. No file was generated.')
}

export function reportGenerationPolicy(report: AnalysisReport, format?: AnalysisReportFormat): ReportPolicy {
  const { policy } = captureReportSettings(report.capture.settings)
  if (format !== undefined) assertReportFormat(policy, format)
  const comparisons = report.groups.reduce((sum, group) => sum + group.comparisons.length, 0)
  if (comparisons > reportLimits(policy).maxComparisons) {
    throw new Error(`This export exceeds the ${policy.maxComparisons}-comparison report limit. Narrow the export to one exact job/grade target; no comparisons have been omitted.`)
  }
  return policy
}

export function reportPolicyTitle(report: AnalysisReport): string {
  return report.capture.settings.policy.title
}
