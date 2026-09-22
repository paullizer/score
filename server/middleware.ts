import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { AuthError, parseDevHeaderPrincipal, parseEasyAuthPrincipal } from './auth'
import type { Config } from './config'
import { forbidden, unauthorized } from './errors'
import type { PrincipalRequest } from './request-context'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const CSRF_HEADER_NAME = 'x-score-request'
const CSRF_HEADER_VALUE = 'workspace'
export const APPLICATION_ADMISSION_VERSION = 'entra-roles-v1'

/**
 * Validates the caller's identity on every request it guards and attaches it to `req.principal`.
 * In `easyauth` mode (the only mode allowed in production/App Service) this trusts App Service Easy
 * Auth to have authenticated the request at the ingress edge, and independently validates the
 * platform-injected `x-ms-client-principal` header's content (tenant, user ID, application roles).
 */
export function createAuthMiddleware(config: Config): RequestHandler {
  if (config.authMode === 'dev-header' && (config.isProduction || config.isAppService)) {
    throw new Error('Developer authentication is prohibited in production or on App Service.')
  }
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal =
        config.authMode === 'dev-header'
          ? parseDevHeaderPrincipal(req.header('x-score-dev-principal'), config)
          : parseEasyAuthPrincipal(req.header('x-ms-client-principal'), req.header('x-ms-client-principal-id'), config)
      ;(req as PrincipalRequest).principal = principal
      res.setHeader('X-Score-Admission-Version', APPLICATION_ADMISSION_VERSION)
      res.setHeader('X-Score-Application-Roles', principal.applicationRoles!.join(','))
      next()
    } catch (error) {
      if (error instanceof AuthError) {
        next(error.kind === 'forbidden' ? forbidden(error.message) : unauthorized(error.message))
        return
      }
      next(error)
    }
  }
}

/**
 * Blocks cross-site request forgery on mutating API calls: the browser-set `Origin` header must
 * match this deployment's origin exactly, and a custom header (unreachable from a simple
 * cross-origin form/image/script request without triggering CORS preflight) must be present. GET
 * requests are unaffected since they must not have side effects.
 */
export function createCsrfMiddleware(config: Config): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!MUTATING_METHODS.has(req.method)) {
      next()
      return
    }
    const origin = req.header('origin')
    if (origin !== config.appOrigin) {
      next(forbidden('This request is not permitted from this origin.'))
      return
    }
    if (req.header(CSRF_HEADER_NAME) !== CSRF_HEADER_VALUE) {
      next(forbidden(`This request must include the ${CSRF_HEADER_NAME}: ${CSRF_HEADER_VALUE} header.`))
      return
    }
    next()
  }
}
