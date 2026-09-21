import type { Request } from 'express'
import type { AuthenticatedPrincipal } from './auth'
export {
  getAdmissionSettings as getRequestSettings, getCurrentSettings, getPinnedAdmissionSettings,
  getSettingsForAcceptedWork, runtimeSettingsEnabled, assertNewProcessingAllowed, getProcessingAdmissionSettings,
  getRuntimeSettingsReadiness,
} from './settings/request-context'

/** Augments Express's Request with the principal the auth middleware attaches after validation. */
export interface PrincipalRequest extends Request {
  principal?: AuthenticatedPrincipal
}

/**
 * Reads the authenticated principal off a request that has already passed the auth middleware.
 * Throwing here (rather than returning undefined) signals a real programming error — a route
 * reached without going through auth — rather than a normal "not signed in" condition, which the
 * central error handler reports as an opaque failure instead of a success-shaped response.
 */
export function getPrincipal(req: Request): AuthenticatedPrincipal {
  const principal = (req as PrincipalRequest).principal
  if (!principal) throw new Error('Route reached without an authenticated principal.')
  return principal
}
