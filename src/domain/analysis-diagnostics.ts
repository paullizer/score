import type {
  AnalysisModelProvenance, AnalysisProcessingError, AnalysisProcessingErrorCode,
  RealAnalysisAssessmentOutput, RealAnalysisGroundingReview,
} from './real-analyses'
import type { ImmutableJsonBlobReference } from './real-resumes'

export const ANALYSIS_PIPELINE_VERSION = 'score-analysis-passages-diagnostics-v1'
export const ANALYSIS_DIAGNOSTIC_LIMITS = { maxEvents: 64, maxFindings: 32, maxPathSegments: 12 } as const
export const ANALYSIS_REVIEW_ISSUE_CODES = [
  'unsupported-score', 'unsupported-rationale', 'irrelevant-evidence', 'omitted-evidence',
  'unjustified-limitation', 'invalid-exclusion', 'qualification-judgment',
  'prohibited-inference', 'insufficient-context',
] as const
export const ANALYSIS_DIAGNOSTIC_REASONS = [
  'input-contract', 'source-limit', 'context-budget', 'response-size', 'completion-token-limit',
  'model-refusal', 'content-filter', 'invalid-envelope', 'incomplete-response', 'invalid-model-identity',
  'invalid-json', 'schema-mismatch', 'citation-mismatch', 'assessment-contract', 'policy-language',
  'grounding-disagreement',
] as const
export type AnalysisDiagnosticReason = typeof ANALYSIS_DIAGNOSTIC_REASONS[number]
export const ANALYSIS_SCHEMA_ISSUE_CODES = [
  'invalid_type', 'too_big', 'too_small', 'invalid_format', 'invalid_value', 'unrecognized_keys',
  'invalid_union', 'invalid_key', 'invalid_element', 'not_multiple_of', 'custom',
] as const
export const ANALYSIS_DIAGNOSTIC_FIELDS = [
  'criteria', 'qualifications', 'criterionId', 'qualificationId', 'evidenceStatus', 'score', 'rationale',
  'citations', 'limitation', 'code', 'message', 'paragraphId', 'passageId', 'quote', 'outcome', 'issues',
  'resume', 'rubric', 'requirementEvidence', 'paragraphs', 'id', 'version', 'kind', 'title', 'sample',
  'page', 'heading', 'text', 'dataKind', 'groupId', 'name', 'description', 'createdAt', 'provenance',
  'model', 'promptVersion', 'jobId', 'weight', 'key', 'label', 'guidance', 'sourceParagraphId',
  'requirementType', 'sourceCitations', 'ladder', 'grade', 'competencyId', 'support', 'gradeBasis',
  'interpretation', 'documentId', 'documentVersion', 'unknown-field',
] as const

export interface AnalysisSchemaDiagnostics {
  findings: {
    code: typeof ANALYSIS_SCHEMA_ISSUE_CODES[number]
    path: (typeof ANALYSIS_DIAGNOSTIC_FIELDS[number] | number)[]
  }[]
  omittedFindings: number
}

export type AnalysisModelStage = 'assessment' | 'grounding'
export const ANALYSIS_CITATION_REASONS = [
  'invalid-shape', 'too-many-citations', 'unknown-paragraph', 'empty-quote', 'quote-too-long',
  'quote-not-found', 'whitespace-mismatch', 'wrong-paragraph', 'duplicate-citation',
  'invalid-selection', 'unknown-passage',
] as const
export type AnalysisCitationReason = typeof ANALYSIS_CITATION_REASONS[number]

export interface AnalysisCitationLocation {
  scope: 'criteria' | 'qualifications' | 'issues' | 'citations'
  rowIndex?: number
  criterionId?: string
  qualificationId?: string
}

export interface AnalysisCitationFinding extends AnalysisCitationLocation {
  reason: AnalysisCitationReason
  citationIndex?: number
  paragraphId?: string
  matchingParagraphId?: string
  quoteLength?: number
  paragraphLength?: number
  passageId?: number
  passageCount?: number
  startOffset?: number
  endOffset?: number
}

export interface AnalysisCitationDiagnostics {
  findings: AnalysisCitationFinding[]
  omittedFindings: number
}

export const ANALYSIS_TELEMETRY_EVENTS = [
  'comparison-started', 'evidence-catalog', 'model-response', 'model-transport-failed', 'model-failed',
  'validation-failed', 'correction', 'citations-resolved', 'comparison-outcome', 'diagnostic-write-failed',
] as const

export interface AnalysisTelemetryEvent {
  event: typeof ANALYSIS_TELEMETRY_EVENTS[number]
  timestamp: string
  stage: AnalysisProcessingError['stage']
  workspaceId?: string
  runId?: string
  comparisonId?: string
  attemptId?: string
  modelCallId?: string
  pipelineVersion?: string
  deployment?: string
  model?: string
  promptVersion?: string
  schemaVersion?: string
  correctionCount?: number
  transportAttempt?: number
  httpStatus?: number
  requestId?: string
  durationMilliseconds?: number
  inputCharacters?: number
  contextCharacterLimit?: number
  completionTokenLimit?: number
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call'
  code?: AnalysisProcessingErrorCode
  reason?: AnalysisDiagnosticReason
  retryable?: boolean
  cancelled?: boolean
  citationDiagnostics?: AnalysisCitationDiagnostics
  schemaDiagnostics?: AnalysisSchemaDiagnostics
  reviewOutcome?: RealAnalysisGroundingReview['outcome']
  reviewIssues?: {
    code: typeof ANALYSIS_REVIEW_ISSUE_CODES[number]
    criterionId?: string
    qualificationId?: string
  }[]
  reviewIssueCount?: number
  citationCount?: number
  catalogVersion?: string
  resumeDocumentSha256?: string
  resumeSnapshotSha256?: string
  targetSnapshotSha256?: string
  sourceCharacters?: number
  paragraphCount?: number
  passageCount?: number
  outcome?: 'complete' | 'failed' | 'queued' | 'abandoned'
}

export interface AnalysisAssessmentDiagnostic {
  modelCallId: string
  correctionCount: number
  assessmentSha256: string
  assessment: RealAnalysisAssessmentOutput
  provenance: AnalysisModelProvenance
  review?: RealAnalysisGroundingReview
}

export interface AnalysisFailureDiagnosticReference {
  attemptId: string
  createdAt: string
  blob: ImmutableJsonBlobReference
}

export interface AnalysisDiagnosticCapture {
  attemptId: string
  status: 'saved' | 'unavailable'
  pipelineVersion: string
}

export interface AnalysisFailureDiagnostic {
  schemaVersion: 1
  dataKind: 'real'
  workspaceId: string
  runId: string
  comparisonId: string
  attemptId: string
  createdAt: string
  pipelineVersion: string
  manifestSha256: string
  resumeSnapshot: { snapshotId: string; sha256: string }
  targetSnapshot: { snapshotId: string; sha256: string }
  processingAttempt: number
  retryCount: number
  correctionCount: number
  error: AnalysisProcessingError
  reason?: AnalysisDiagnosticReason
  citationDiagnostics?: AnalysisCitationDiagnostics
  schemaDiagnostics?: AnalysisSchemaDiagnostics
  events: AnalysisTelemetryEvent[]
  omittedEvents: number
  assessments: AnalysisAssessmentDiagnostic[]
  previous?: AnalysisFailureDiagnosticReference
}

export interface RealAnalysisDiagnosticsPage {
  attempts: AnalysisFailureDiagnostic[]
  continuationToken?: string
}
