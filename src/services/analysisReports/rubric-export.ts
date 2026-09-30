import { getDisplayName } from '../../domain/displayNames'
import {
  RUBRIC_EXPORT_FORMATS, isRubricExportFormat, rubricExportFormatAllowed,
  type RubricExportFormat, type RubricExportPayload,
} from '../../domain/rubric-exports'
import { captureReportSettings, reportLimits } from './policy'
import { assertXmlTextTree, safeDownloadFilename } from './presentation'
import { rubricExportPayloadSchema } from './rubric-export-schema'
import { rubricDocumentFromPayload, type RubricExportDocument } from './rubric-model'

/** A validated rubric, the captured policy limits and the administrator notice, ready for one writer. */
export interface PreparedRubricExport {
  format: RubricExportFormat
  document: RubricExportDocument
  notice: string
  limits: ReturnType<typeof reportLimits>
  startedAt: number
  generatedAt: string
}

export const RUBRIC_EXPORT_SUBJECT = 'Job rubric for human review'

export function parseRubricExportPayload(value: unknown): RubricExportPayload {
  const parsed = rubricExportPayloadSchema.safeParse(value)
  if (!parsed.success) throw new Error('The saved rubric could not be read for export. Reload the page and try again. No file was generated.')
  return parsed.data
}

/** Re-checks the captured policy so a stale page can't export a format or role that was turned off. */
export function assertRubricExportPolicy(payload: RubricExportPayload, format: RubricExportFormat): ReturnType<typeof reportLimits> {
  const { policy } = captureReportSettings(payload.settings)
  if (!policy.allowedRoles.length) throw new Error('Official exports are disabled for every workspace role. No file was generated.')
  if (!rubricExportFormatAllowed(policy, format)) {
    throw new Error(`${RUBRIC_EXPORT_FORMATS[format].label} export is disabled by application policy. No file was generated.`)
  }
  return reportLimits(policy)
}

export function prepareRubricExport(
  value: unknown, format: unknown, links: { origin: string }, startedAt = Date.now(),
): PreparedRubricExport {
  if (!isRubricExportFormat(format)) throw new Error('The rubric export format is invalid.')
  const payload = parseRubricExportPayload(value)
  const limits = assertRubricExportPolicy(payload, format)
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > limits.maxInputBytes) {
    throw new Error('This rubric exceeds the export input size limit. No file was generated.')
  }
  const document = rubricDocumentFromPayload(payload, links)
  if (format === 'docx' || format === 'pptx') assertXmlTextTree(document, 'Rubric text')
  return { format, document, notice: payload.settings.policy.additionalFooter, limits, startedAt, generatedAt: payload.generatedAt }
}

export function rubricExportFilename(payload: Pick<RubricExportPayload, 'job' | 'rubric'>, format: RubricExportFormat): string {
  return safeDownloadFilename(`${getDisplayName(payload.job, payload.job.title)} - rubric v${payload.rubric.version}`,
    RUBRIC_EXPORT_FORMATS[format].extension, 'Job rubric')
}

export function rubricExportDocumentTitle(document: Pick<RubricExportDocument, 'title' | 'version'>): string {
  return `${document.title} — job rubric (version ${document.version})`
}
