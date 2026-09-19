import type { DocumentPagination } from './document-formats'
import type { RealAnalysisTargetSelection } from './real-analyses'

export const ANALYSIS_REPORT_SCHEMA_VERSION = 1 as const

export const REPORT_FORMATS = {
  csv: { extension: 'csv', mimeType: 'text/csv;charset=utf-8', label: 'CSV' },
  pdf: { extension: 'pdf', mimeType: 'application/pdf', label: 'PDF' },
  docx: { extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word (.docx)' },
  pptx: { extension: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint (.pptx)' },
} as const

export const REPORT_LIMITS = {
  maxComparisons: 500,
  batchComparisons: 25,
  maxConcurrentBatches: 3,
  maxTargets: 500,
  maxCriteriaPerTarget: 100,
  maxQualificationsPerComparison: 100,
  maxCitationsPerAssessment: 100,
  maxFacts: 128,
  maxLimitations: 200,
  maxTextCharacters: 100_000,
  maxBatchBytes: 8 * 1024 * 1024,
  maxInputBytes: 32 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxGenerationMilliseconds: 180_000,
  maxPages: 10_000,
  maxSlides: 10_000,
  highlightCount: 5,
  maxHighlights: 10,
} as const

export type AnalysisReportFormat = keyof typeof REPORT_FORMATS
export type ReportDataKind = 'real' | 'sample'
export type ReportComparisonStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'
export type ReportCompletion = 'assessed' | 'limited'
export type ReportEvidenceStatus = 'supported' | 'partial' | 'missing' | 'not-assessed' | 'not-applicable'
export type ReportQualificationEvidenceStatus = Exclude<ReportEvidenceStatus, 'not-applicable'>
export type ReportRequirementType = 'required' | 'preferred' | null

export interface ReportFact {
  label: string
  value: string
}

export interface ReportSnapshotIdentity {
  snapshotId: string
  sha256: string
}

export interface ReportCitation {
  documentId: string
  documentVersion: number
  paragraphId: string
  // A section number, not a printed page, unless pagination is pdf-pages.
  page: number
  heading: string
  quote: string
  sourceTitle: string
  pagination: DocumentPagination
  locator: string
}

export interface ReportCitationSource {
  id: string
  version: number
  title: string
  pagination: DocumentPagination
}

export interface ReportCriterionDefinition {
  id: string
  label: string
  description: string
  weight: number
  guidance: string
  requirementType: ReportRequirementType
}

export interface ReportTarget {
  id: string
  dataKind: ReportDataKind
  kind: 'job' | 'grade'
  label: string
  sublabel: string
  versionLabel: string
  rubricId: string
  rubricVersion: number
  selection: RealAnalysisTargetSelection | null
  snapshot: ReportSnapshotIdentity | null
  criteria: ReportCriterionDefinition[]
  facts: ReportFact[]
}

export interface RealReportTarget extends ReportTarget {
  dataKind: 'real'
  selection: RealAnalysisTargetSelection
  snapshot: ReportSnapshotIdentity
}

export interface ReportCandidate {
  id: string
  name: string | null
  role: string | null
  sourceLabel: string
  documentId: string
  documentVersion: number
  documentSha256: string | null
  snapshot: ReportSnapshotIdentity | null
}

export interface RealReportCandidate extends ReportCandidate {
  documentSha256: string
  snapshot: ReportSnapshotIdentity
}

export interface ReportLimitation {
  code: string
  message: string
  criterionId?: string
  qualificationId?: string
}

export interface ReportProcessingError {
  code: string
  message: string
  stage: string | null
  retryable: boolean | null
}

export interface ReportCriterionAssessment {
  criterionId: string
  weight: number
  score: number | null
  evidenceStatus: ReportEvidenceStatus
  rationale: string
  citations: ReportCitation[]
  requirementCitations: ReportCitation[]
  limitation: ReportLimitation | null
}

export interface ReportQualificationAssessment {
  qualificationId: string
  text: string
  interpretation: string
  support: 'direct' | 'derived' | 'gap'
  evidenceStatus: ReportQualificationEvidenceStatus
  rationale: string
  citations: ReportCitation[]
  requirementCitations: ReportCitation[]
  limitation: ReportLimitation | null
}

export interface ReportEvidenceCoverage {
  totalCriteria: number
  supported: number
  partial: number
  missing: number
  notAssessed: number
  notApplicable: number
  assessedWeight: number
  totalWeight: number
}

export type ReportOverallScore =
  | { status: 'available'; score: number }
  | { status: 'withheld'; score: null; reason: string; message: string }
  | { status: 'unavailable'; score: null; reason: 'not-complete'; message: string }

export interface ReportComparison {
  id: string
  index: number
  dataKind: ReportDataKind
  targetId: string
  candidate: ReportCandidate
  status: ReportComparisonStatus
  completion: ReportCompletion | null
  overall: ReportOverallScore
  summary: string | null
  coverage: ReportEvidenceCoverage | null
  criteria: ReportCriterionAssessment[]
  qualifications: ReportQualificationAssessment[]
  limitations: ReportLimitation[]
  error: ReportProcessingError | null
  analyzedAt: string | null
  resultSha256: string | null
  provenance: ReportFact[]
}

export interface RealReportComparison extends ReportComparison {
  dataKind: 'real'
  candidate: RealReportCandidate
}

export interface RankedReportComparison extends ReportComparison {
  rank: number | null
  highlighted: boolean
}

export interface ReportStatusCounts {
  total: number
  queued: number
  running: number
  complete: number
  failed: number
  cancelled: number
  scored: number
  withheld: number
}

export interface ReportGroup {
  target: ReportTarget
  comparisons: RankedReportComparison[]
  counts: ReportStatusCounts
  highlightedComparisonIds: string[]
  cutoffScore: number | null
  additionalCutoffTies: number
}

export interface ReportRun {
  id: string
  name: string
  createdAt: string
}

export interface ReportCaptureInterval {
  startedAt: string
  completedAt: string
}

export interface AnalysisReportInput {
  dataKind: ReportDataKind
  workspaceId?: string
  run: ReportRun
  capture: ReportCaptureInterval
  generatedAt: string
  targets: ReportTarget[]
  comparisons: ReportComparison[]
}

export interface AnalysisReportBuildOptions {
  targetId?: string
}

export interface SampleAnalysisReportOptions extends AnalysisReportBuildOptions {
  capture?: ReportCaptureInterval
  generatedAt?: string
}

export interface AnalysisReport {
  schemaVersion: typeof ANALYSIS_REPORT_SCHEMA_VERSION
  dataKind: ReportDataKind
  workspaceId?: string
  run: ReportRun
  capture: ReportCaptureInterval
  generatedAt: string
  scope: { targetId: string | null }
  candidateCount: number
  counts: ReportStatusCounts
  partial: boolean
  notices: string[]
  groups: ReportGroup[]
}

export interface RealReportBatchResponse {
  schemaVersion: typeof ANALYSIS_REPORT_SCHEMA_VERSION
  dataKind: 'real'
  workspaceId: string
  runId: string
  targets: RealReportTarget[]
  comparisons: RealReportComparison[]
}

export interface ReportFontData {
  regular: ArrayBuffer
  bold: ArrayBuffer
}

export interface ReportLinkContext {
  origin: string
  workspaceId?: string
}

export interface ReportGenerationOptions {
  fonts?: ReportFontData
  links?: ReportLinkContext
}

export type AnalysisReportWriter = (report: AnalysisReport, options?: ReportGenerationOptions) => Uint8Array | Promise<Uint8Array>

export interface ReportWorkerRequest {
  type: 'generate'
  requestId: string
  format: AnalysisReportFormat
  report: AnalysisReport
  options?: ReportGenerationOptions
}

export type ReportWorkerResponse =
  | { type: 'progress'; requestId: string; message: string }
  | { type: 'complete'; requestId: string; bytes: ArrayBuffer }
  | { type: 'error'; requestId: string; message: string }
