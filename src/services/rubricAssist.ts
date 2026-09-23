import { ASSIST_LIMITS } from '../domain/assist'
import {
  rubricAssistRequestSchema,
  rubricAssistResponseSchema,
  type RubricAssistRequest,
  type RubricAssistResponse,
} from '../domain/rubric-assist'
import { CloudApiError, CloudTimeoutError, cloudJsonResponse } from './cloudWorkspace'

export type AssistRequestErrorKind = 'timeout' | 'rate-limited' | 'conflict' | 'invalid-response' | 'unavailable'

/** Typed wrapper for assistant-only failures the UI can render without string matching. */
export class AssistRequestError extends Error {
  readonly kind: AssistRequestErrorKind
  readonly retryAfterSeconds: number | undefined
  readonly status: number | undefined
  constructor(kind: AssistRequestErrorKind, message: string, options: { retryAfterSeconds?: number; status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'AssistRequestError'
    this.kind = kind
    this.retryAfterSeconds = options.retryAfterSeconds
    this.status = options.status
  }
}

export function isAssistRequestError(error: unknown): error is AssistRequestError {
  return error instanceof AssistRequestError
}

export function isAssistRateLimit(error: unknown): error is AssistRequestError & { kind: 'rate-limited' } {
  return error instanceof AssistRequestError && error.kind === 'rate-limited'
}

function validationMessage(error: unknown, fallback: string): string {
  const issues = error && typeof error === 'object' && 'issues' in error ? error.issues : undefined
  if (Array.isArray(issues) && issues[0] && typeof issues[0] === 'object' && 'message' in issues[0] && typeof issues[0].message === 'string') {
    return issues[0].message
  }
  return fallback
}

function mapAssistError(error: unknown): never {
  if (error instanceof CloudTimeoutError) {
    throw new AssistRequestError('timeout', 'The assistant took too long to respond. Your draft is unchanged.', { cause: error, status: error.status })
  }
  if (error instanceof CloudApiError && error.status === 429) {
    throw new AssistRequestError('rate-limited', error.message, { cause: error, retryAfterSeconds: error.retryAfterSeconds, status: error.status })
  }
  throw error
}

export async function requestRubricAssist(
  workspaceId: string,
  jobId: string,
  request: RubricAssistRequest,
  signal?: AbortSignal,
): Promise<RubricAssistResponse> {
  const parsedRequest = rubricAssistRequestSchema.safeParse(request)
  if (!parsedRequest.success) {
    throw new Error(validationMessage(parsedRequest.error, 'The assistant request is invalid. Your draft is unchanged.'))
  }
  try {
    const { value, status } = await cloudJsonResponse<unknown>(
      `/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobId)}/rubric/assist`,
      {
        method: 'POST',
        body: JSON.stringify(parsedRequest.data),
        signal,
        timeoutMilliseconds: ASSIST_LIMITS.clientTimeoutMilliseconds,
      },
    )
    const parsedResponse = rubricAssistResponseSchema.safeParse(value)
    if (!parsedResponse.success) {
      throw new CloudApiError('unavailable', 'The assistant returned an unexpected response. Your draft is unchanged.', status)
    }
    return parsedResponse.data
  } catch (error) {
    mapAssistError(error)
  }
}
