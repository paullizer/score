import type { GradeIssue } from '../../src/domain/real-grades'

export type GradeModelErrorCode =
  | 'invalid-input'
  | 'source-integrity'
  | 'model-context-limit'
  | 'invalid-model-output'
  | 'invalid-model-response'
  | 'model-invocation-failed'
  | 'cancelled'

export class GradeModelError extends Error {
  readonly code: GradeModelErrorCode
  readonly retryable: boolean
  readonly details: readonly string[]
  readonly issues: readonly GradeIssue[]
  readonly upstreamCode?: string

  constructor(
    code: GradeModelErrorCode,
    message: string,
    options: {
      retryable?: boolean
      details?: readonly string[]
      issues?: readonly GradeIssue[]
      upstreamCode?: string
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'GradeModelError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details ?? []
    this.issues = options.issues ?? []
    this.upstreamCode = options.upstreamCode
  }
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new GradeModelError('cancelled', 'Grade model processing was cancelled.', { cause: signal.reason })
  }
}
