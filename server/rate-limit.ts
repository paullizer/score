import type { Request } from 'express'
import type { Options, RateLimitInfo } from 'express-rate-limit'
import { formatRetryAfter } from './assist/limits'
import { tooManyRequests } from './errors'
import { getPrincipal } from './request-context'

/** How many requests each signed-in user may make in one window, counted separately by each API instance. */
export interface UserRateLimit {
  readonly limit: number
  readonly windowMilliseconds: number
  /** First sentence of the 429 message, for example `Rubric export limit reached.` */
  readonly message: string
}

interface RateLimitedRequest extends Request {
  rateLimit?: RateLimitInfo
}

function retryAfterSeconds(req: Request, fallbackMilliseconds: number): number {
  const resetTime = (req as RateLimitedRequest).rateLimit?.resetTime
  const milliseconds = resetTime instanceof Date ? resetTime.getTime() - Date.now() : fallbackMilliseconds
  return Math.max(1, Math.ceil(milliseconds / 1000))
}

/**
 * Options for an `express-rate-limit` middleware that counts requests per signed-in user in this
 * API instance's memory. Mount the limiter after authentication. Excess requests get Score's
 * standard 429 error with `Retry-After`.
 */
export function userRateLimitOptions(policy: UserRateLimit): Partial<Options> {
  return {
    windowMs: policy.windowMilliseconds,
    limit: policy.limit,
    keyGenerator: req => getPrincipal(req).principalKey,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, _res, next) => {
      const retryAfter = retryAfterSeconds(req, policy.windowMilliseconds)
      next(tooManyRequests(`${policy.message} Try again in about ${formatRetryAfter(retryAfter)}.`, retryAfter))
    },
  }
}
