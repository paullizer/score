import type { RealJobRecord } from '../src/domain/real-jobs'
import type { ProcessingSettingsSnapshot } from '../src/domain/admin-settings'

export type JobOutcome = 'ready' | 'failed' | 'queued' | 'abandoned'
export type JobStage = 'download' | 'parsing' | 'rubric' | 'review' | 'publication'

const ERROR_CODES = new Set([
  'not-a-job-posting', 'invalid-rubric', 'invalid-extraction-cache', 'invalid-source-type',
  'source-blob-missing', 'source-too-large', 'source-too-long', 'source-policy-limit', 'empty-source',
  'invalid-pdf', 'pdf-too-large', 'pdf-too-many-pages', 'unsupported-content', 'invalid-source',
  'password-protected-pdf', 'ocr-rejected', 'invalid-markdown', 'markdown-too-large',
  'invalid-word', 'encrypted-word', 'word-too-large', 'word-expansion-limit',
  'word-timeout', 'word-parser-unavailable', 'word-cancelled', 'rubric-review-invalid-output',
  'ocr-invalid-response', 'ocr-invalid-page', 'ocr-invalid-operation', 'ocr-operation-expired',
  'ocr-timeout', 'ocr-poll-failed', 'ocr-failed', 'request-timeout', 'request-failed',
  'model-request-failed', 'model-invalid-response', 'model-empty-response', 'model-context-limit',
  'model-refused', 'model-schema-invalid', 'settings-invalid', 'prompt-pin-invalid',
  'storage-conflict', 'worker-failed', 'cancelled', 'source-fetch-failed', 'source-timeout',
  'source-access-denied', 'source-unavailable', 'invalid-url', 'unsafe-url', 'dns-failed',
  'invalid-redirect', 'too-many-redirects', 'renderer-unavailable', 'browser-render-failed',
  'renderer-invalid-response', 'javascript-source', 'run-budget-exhausted',
])

function identifier(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) ? value : undefined
}

export function logJobEvent(
  record: RealJobRecord,
  snapshot: ProcessingSettingsSnapshot,
  templateVersion: string,
  event: {
    stage: JobStage; outcome?: JobOutcome; code?: string; retryable?: boolean; httpStatus?: number
    failureWriteUnconfirmed?: boolean
  },
): void {
  const prompt = snapshot.promptBundle?.revisions.jobRubric
  console.log(JSON.stringify({
    component: 'score-job', event: event.outcome ? 'job-outcome' : 'job-stage',
    workspaceId: identifier(record.workspaceId), jobId: identifier(record.id),
    attempt: record.attempts, stage: event.stage, outcome: event.outcome,
    code: event.code ? ERROR_CODES.has(event.code) ? event.code : 'processing-error' : undefined,
    retryable: event.retryable,
    failureWriteUnconfirmed: event.failureWriteUnconfirmed,
    httpStatus: event.httpStatus && Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599
      ? event.httpStatus : undefined,
    deployment: identifier(snapshot.tasks.jobRubric?.deploymentName),
    model: identifier(snapshot.tasks.jobRubric?.modelName),
    promptVersion: identifier(prompt?.revisionId ?? templateVersion),
    templateVersion: identifier(prompt?.templateVersion ?? templateVersion),
  }))
}
