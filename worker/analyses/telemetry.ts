import type { AnalysisProcessingError, AnalysisProcessingErrorCode } from '../../src/domain/real-analyses'
import type { AnalysisCitationDiagnostics } from './citation-diagnostics'

export interface AnalysisTelemetryEvent {
  event: 'evidence-catalog' | 'model-response' | 'model-transport-failed' | 'model-failed' | 'validation-failed' | 'correction' | 'citations-resolved' | 'comparison-outcome'
  timestamp: string
  stage: AnalysisProcessingError['stage']
  workspaceId?: string
  runId?: string
  comparisonId?: string
  attemptId?: string
  modelCallId?: string
  deployment?: string
  model?: string
  promptVersion?: string
  schemaVersion?: string
  correctionCount?: number
  transportAttempt?: number
  httpStatus?: number
  requestId?: string
  durationMilliseconds?: number
  code?: AnalysisProcessingErrorCode
  retryable?: boolean
  cancelled?: boolean
  citationDiagnostics?: AnalysisCitationDiagnostics
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

export type AnalysisTelemetrySink = (event: AnalysisTelemetryEvent) => void

export function analysisResponseRequestId(headers: Headers): string | undefined {
  for (const name of ['apim-request-id', 'x-ms-request-id', 'x-request-id', 'request-id']) {
    const value = headers.get(name)
    if (value && (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ||
      /^req_[a-zA-Z0-9]{16,64}$/.test(value))) return value
  }
  return undefined
}

export function emitAnalysisTelemetry(sink: AnalysisTelemetrySink | undefined, event: AnalysisTelemetryEvent): void {
  if (!sink) return
  const safe: AnalysisTelemetryEvent = {
    event: event.event, timestamp: event.timestamp, stage: event.stage,
    workspaceId: event.workspaceId, runId: event.runId, comparisonId: event.comparisonId, attemptId: event.attemptId,
    modelCallId: event.modelCallId, deployment: event.deployment, model: event.model,
    promptVersion: event.promptVersion, schemaVersion: event.schemaVersion, correctionCount: event.correctionCount,
    transportAttempt: event.transportAttempt, httpStatus: event.httpStatus, requestId: event.requestId,
    durationMilliseconds: event.durationMilliseconds, code: event.code, retryable: event.retryable,
    cancelled: event.cancelled, reviewIssueCount: event.reviewIssueCount, outcome: event.outcome,
    citationCount: event.citationCount, catalogVersion: event.catalogVersion,
    resumeDocumentSha256: event.resumeDocumentSha256, resumeSnapshotSha256: event.resumeSnapshotSha256,
    targetSnapshotSha256: event.targetSnapshotSha256, sourceCharacters: event.sourceCharacters,
    paragraphCount: event.paragraphCount, passageCount: event.passageCount,
    ...(event.citationDiagnostics ? {
      citationDiagnostics: {
        findings: event.citationDiagnostics.findings.map(finding => ({
          reason: finding.reason, scope: finding.scope, rowIndex: finding.rowIndex,
          criterionId: finding.criterionId, qualificationId: finding.qualificationId,
          citationIndex: finding.citationIndex, paragraphId: finding.paragraphId,
          matchingParagraphId: finding.matchingParagraphId, quoteLength: finding.quoteLength, paragraphLength: finding.paragraphLength,
          passageId: finding.passageId, passageCount: finding.passageCount, startOffset: finding.startOffset, endOffset: finding.endOffset,
        })),
        omittedFindings: event.citationDiagnostics.omittedFindings,
      },
    } : {}),
  }
  try { sink(safe) } catch {
    console.error('Score analysis telemetry failed:', { code: 'analysis-telemetry-failed' })
  }
}

export function logAnalysisTelemetry(event: AnalysisTelemetryEvent): void {
  emitAnalysisTelemetry(safe => console.log(JSON.stringify({ component: 'score-analysis', ...safe })), event)
}
