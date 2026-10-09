import type { AnalysisReportFormat, ReportFontData, ReportPolicy, ReportSettingsCapture } from './analysis-reports'
import type { DocumentPagination } from './document-formats'
import type { RubricVersionStatus } from './rubric-approval'

export const RUBRIC_EXPORT_SCHEMA_VERSION = 1 as const

/** Markdown isn't an analysis report format, so Report formats doesn't restrict it. */
export const RUBRIC_EXPORT_FORMATS = {
  pdf: {
    extension: 'pdf', mimeType: 'application/pdf', label: 'PDF', reportFormat: 'pdf',
    description: 'A formatted document for reading, printing and sharing.',
  },
  docx: {
    extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word (.docx)', reportFormat: 'docx', description: 'An editable document with the same content as the PDF.',
  },
  pptx: {
    extension: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PowerPoint (.pptx)', reportFormat: 'pptx', description: 'Slides for walking a panel through the criteria.',
  },
  markdown: {
    extension: 'md', mimeType: 'text/markdown;charset=utf-8', label: 'Markdown (.md)', reportFormat: null,
    description: 'Plain text for wikis, tickets and version control.',
  },
  csv: {
    extension: 'csv', mimeType: 'text/csv;charset=utf-8', label: 'CSV', reportFormat: 'csv',
    description: 'One row per criterion, for spreadsheets.',
  },
} as const satisfies Record<string, {
  extension: string
  mimeType: string
  label: string
  reportFormat: AnalysisReportFormat | null
  description: string
}>

export type RubricExportFormat = keyof typeof RUBRIC_EXPORT_FORMATS

export const RUBRIC_EXPORT_FORMAT_ORDER: readonly RubricExportFormat[] = ['pdf', 'docx', 'pptx', 'markdown', 'csv']

export function isRubricExportFormat(value: unknown): value is RubricExportFormat {
  return typeof value === 'string' && Object.hasOwn(RUBRIC_EXPORT_FORMATS, value)
}

export function rubricExportFormatAllowed(policy: Pick<ReportPolicy, 'enabledFormats'>, format: RubricExportFormat): boolean {
  const reportFormat = RUBRIC_EXPORT_FORMATS[format].reportFormat
  return reportFormat === null || policy.enabledFormats.includes(reportFormat)
}

/** The 0–5 per-criterion scale shared by rubric pages, rubric exports and report rubric details. */
export const SCORE_LEGEND = [
  { value: 0, label: 'No support' },
  { value: 1, label: 'Introductory' },
  { value: 2, label: 'Limited' },
  { value: 3, label: 'Independent' },
  { value: 4, label: 'Substantial' },
  { value: 5, label: 'Sustained' },
] as const

export interface RubricExportCitation {
  page: number
  heading: string
  quote: string
}

export interface RubricExportCriterion {
  label: string
  description: string
  weight: number
  guidance: string
  requirementType: 'required' | 'preferred'
  citations: RubricExportCitation[]
}

export interface RubricExportJob {
  id: string
  title: string
  displayName?: string
  organization: string
  location: string
  arrangement: string
  employmentType: string
  grade: string
  series: string
  sourceLabel: string
  pagination: DocumentPagination
}

export interface RubricExportRubric {
  id: string
  version: number
  latestVersion: number
  name: string
  description: string
  createdAt: string
  provenance: 'generated' | 'edited'
  /** Approval status of this exact version when it was exported. Absent from payloads made before rubric approval. */
  approval?: RubricVersionStatus
  criteria: RubricExportCriterion[]
}

/** One saved job rubric version, captured by the server for a browser-side rubric export. */
export interface RubricExportPayload {
  schemaVersion: typeof RUBRIC_EXPORT_SCHEMA_VERSION
  dataKind: 'real'
  workspaceId: string
  generatedAt: string
  settings: ReportSettingsCapture
  job: RubricExportJob
  rubric: RubricExportRubric
}

export interface RubricExportWorkerRequest {
  type: 'generate'
  requestId: string
  format: RubricExportFormat
  payload: RubricExportPayload
  links: { origin: string }
  fonts?: ReportFontData
}

export type RubricExportWorkerResponse =
  | { type: 'progress'; requestId: string; message: string }
  | { type: 'complete'; requestId: string; bytes: ArrayBuffer }
  | { type: 'error'; requestId: string; message: string }
