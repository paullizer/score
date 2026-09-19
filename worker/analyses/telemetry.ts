import {
  ANALYSIS_DIAGNOSTIC_LIMITS, ANALYSIS_REVIEW_ISSUE_CODES, type AnalysisTelemetryEvent,
} from '../../src/domain/analysis-diagnostics'
import { analysisSchemaDiagnostics } from './diagnostics'

export type { AnalysisTelemetryEvent } from '../../src/domain/analysis-diagnostics'

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
    pipelineVersion: event.pipelineVersion,
    modelCallId: event.modelCallId, deployment: event.deployment, model: event.model,
    promptVersion: event.promptVersion, schemaVersion: event.schemaVersion, correctionCount: event.correctionCount,
    transportAttempt: event.transportAttempt, httpStatus: event.httpStatus, requestId: event.requestId,
    durationMilliseconds: event.durationMilliseconds, code: event.code, reason: event.reason, retryable: event.retryable,
    inputCharacters: event.inputCharacters, contextCharacterLimit: event.contextCharacterLimit,
    completionTokenLimit: event.completionTokenLimit, finishReason: event.finishReason,
    cancelled: event.cancelled, reviewIssueCount: event.reviewIssueCount, outcome: event.outcome,
    citationCount: event.citationCount, catalogVersion: event.catalogVersion,
    resumeDocumentSha256: event.resumeDocumentSha256, resumeSnapshotSha256: event.resumeSnapshotSha256,
    targetSnapshotSha256: event.targetSnapshotSha256, sourceCharacters: event.sourceCharacters,
    paragraphCount: event.paragraphCount, passageCount: event.passageCount,
    reviewOutcome: event.reviewOutcome,
    ...(event.reviewIssues ? {
      reviewIssues: event.reviewIssues.filter(issue => ANALYSIS_REVIEW_ISSUE_CODES.some(code => code === issue.code))
        .slice(0, 64).map(issue => ({
          code: issue.code, criterionId: issue.criterionId, qualificationId: issue.qualificationId,
        })),
    } : {}),
    ...(event.schemaDiagnostics ? {
      schemaDiagnostics: {
        ...analysisSchemaDiagnostics(event.schemaDiagnostics.findings),
        omittedFindings: event.schemaDiagnostics.omittedFindings +
          Math.max(0, event.schemaDiagnostics.findings.length - ANALYSIS_DIAGNOSTIC_LIMITS.maxFindings),
      },
    } : {}),
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
