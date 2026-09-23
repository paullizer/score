import type { CloudApiError } from '../src/domain/cloud'

export type CloudErrorCode = CloudApiError['error']['code']

/**
 * An error with an explicit HTTP status and a {@link CloudErrorCode}, safe to serialize directly
 * to the client as a {@link CloudApiError}. Route handlers throw this for expected conditions
 * (bad auth, missing workspace, stale etag, oversized body, ...); anything else is an unexpected
 * failure and must not be shaped like a success or leak internal detail to the client.
 */
export class HttpError extends Error {
  readonly status: number
  readonly code: CloudErrorCode
  readonly retryAfterSeconds?: number

  constructor(status: number, code: CloudErrorCode, message: string, options?: { retryAfterSeconds?: number }) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = options?.retryAfterSeconds
  }
}

export function unauthorized(message = 'Sign-in is required.'): HttpError {
  return new HttpError(401, 'unauthorized', message)
}

export function forbidden(message = 'You do not have access to this workspace.'): HttpError {
  return new HttpError(403, 'forbidden', message)
}

export function notFound(message = 'The requested workspace was not found.'): HttpError {
  return new HttpError(404, 'not_found', message)
}

/** A retired endpoint that existed in older releases. */
export function gone(message: string): HttpError {
  return new HttpError(410, 'not_found', message)
}

export function conflict(message = 'This workspace changed since you last loaded it.'): HttpError {
  return new HttpError(409, 'conflict', message)
}

export function preconditionRequired(message = 'An If-Match header with the current version is required.'): HttpError {
  return new HttpError(428, 'precondition_required', message)
}

export function invalidRequest(message: string): HttpError {
  return new HttpError(400, 'invalid_request', message)
}

export function unavailable(message = 'This service is temporarily unavailable. Try again shortly.'): HttpError {
  return new HttpError(503, 'unavailable', message)
}

export function tooManyRequests(message: string, retryAfterSeconds: number): HttpError {
  return new HttpError(429, 'unavailable', message, { retryAfterSeconds })
}

export function toCloudApiError(error: HttpError): CloudApiError {
  return { error: { code: error.code, message: error.message } }
}
