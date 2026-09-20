import type { AnalysisTelemetryEvent } from '../../src/domain/analysis-diagnostics'
import type { AnalysisNarrativeProcessingError } from '../../src/domain/analysis-narratives'
import { SUMMARY_PIPELINE_VERSION, summaryDiagnosticSchema, type AnalysisSummaryDiagnostic } from '../../src/domain/analysis-summary-history'
import { emitAnalysisTelemetry } from './telemetry'

export interface SummaryTelemetryEvent extends Omit<AnalysisTelemetryEvent, 'event' | 'stage' | 'outcome' | 'code' | 'reason'> {
  event: 'narrative-started' | 'narrative-outcome' | 'model-response' | 'model-transport-failed' | 'model-failed'
    | 'summary-generated' | 'summary-reviewed' | 'summary-revision' | 'summary-checkpoint' | 'validation-failed'
  stage: AnalysisNarrativeProcessingError['stage']
  targetId?: string
  generationId?: string
  scopeId?: string
  round?: number
  requestBytes?: number
  outcome?: 'ready' | 'failed' | 'queued' | 'abandoned'
  code?: AnalysisNarrativeProcessingError['code']
  reason?: AnalysisSummaryDiagnostic['reason']
  issueCodes?: string[]
}

export type SummaryTelemetrySink = (event: SummaryTelemetryEvent) => void

export function emitSummaryTelemetry(sink: SummaryTelemetrySink | undefined, event: SummaryTelemetryEvent): void {
  if (!sink) return
  const diagnostic = summaryDiagnosticSchema.safeParse({
    reason: event.reason, round: event.round, modelCallId: event.modelCallId,
  })
  const safe: SummaryTelemetryEvent = {
    event: event.event, timestamp: event.timestamp, stage: event.stage,
    workspaceId: event.workspaceId, runId: event.runId, targetId: event.targetId,
    comparisonId: event.comparisonId, generationId: event.generationId, attemptId: event.attemptId,
    pipelineVersion: SUMMARY_PIPELINE_VERSION,
    scopeId: event.scopeId && /^(?:final|reduction-[a-f0-9]{64})$/.test(event.scopeId) ? event.scopeId : undefined,
    ...(diagnostic.success ? diagnostic.data : {}),
    deployment: event.deployment, model: event.model, promptVersion: event.promptVersion, schemaVersion: event.schemaVersion,
    transportAttempt: event.transportAttempt, httpStatus: event.httpStatus, requestId: event.requestId,
    durationMilliseconds: event.durationMilliseconds, inputCharacters: event.inputCharacters,
    requestBytes: event.requestBytes,
    contextCharacterLimit: event.contextCharacterLimit, completionTokenLimit: event.completionTokenLimit,
    finishReason: event.finishReason, code: event.code, retryable: event.retryable, cancelled: event.cancelled,
    correctionCount: event.correctionCount, reviewOutcome: event.reviewOutcome, reviewIssueCount: event.reviewIssueCount,
    outcome: event.outcome,
    ...(event.issueCodes ? {
      issueCodes: event.issueCodes.filter(code =>
        ['unsupported-claim', 'unsupported-number', 'misleading-status', 'prohibited-judgment'].includes(code)).slice(0, 16),
    } : {}),
  }
  try { sink(safe) } catch {
    console.error('Score summary telemetry failed:', { code: 'summary-telemetry-failed' })
  }
}

export function logSummaryTelemetry(event: SummaryTelemetryEvent): void {
  emitSummaryTelemetry(safe => console.log(JSON.stringify({ component: 'score-analysis-narrative', ...safe })), event)
}

export function summaryTransportTelemetry(
  sink: SummaryTelemetrySink | undefined,
  context: Pick<SummaryTelemetryEvent, 'stage' | 'round' | 'scopeId'>,
): (event: AnalysisTelemetryEvent) => void {
  return event => {
    if (!['model-response', 'model-transport-failed', 'model-failed'].includes(event.event)) return
    emitAnalysisTelemetry(safe => {
      if (safe.event === 'model-response' || safe.event === 'model-transport-failed' || safe.event === 'model-failed') {
        emitSummaryTelemetry(sink, { ...safe, event: safe.event, outcome: undefined, ...context })
      }
    }, event)
  }
}
