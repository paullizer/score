import type { Config } from './config'
import { GUID_PATTERN, principalKeyFor } from './ids'
import type { ApplicationRole } from '../src/domain/access'

/** A validated caller identity: immutable tenant + object ID, plus best-effort display fields. */
export interface AuthenticatedPrincipal {
  readonly tenantId: string
  readonly oid: string
  readonly principalKey: string
  readonly name: string
  readonly email: string
  readonly applicationRoles?: readonly ApplicationRole[]
}

/** Application designation is tenant-scoped and independent of every workspace role. */
export function isApplicationAdmin(principal: AuthenticatedPrincipal, config?: Pick<Config, 'tenantId'>): boolean {
  return (!config || principal.tenantId === config.tenantId) &&
    principal.applicationRoles?.includes('Score.Admin') === true
}

export type AuthErrorKind = 'unauthenticated' | 'forbidden'

export class AuthError extends Error {
  readonly kind: AuthErrorKind

  constructor(message: string, kind: AuthErrorKind = 'unauthenticated') {
    super(message)
    this.name = 'AuthError'
    this.kind = kind
  }
}

interface EasyAuthClaim {
  readonly typ: string
  readonly val: string
}

interface EasyAuthPrincipal {
  readonly auth_typ?: unknown
  readonly claims?: unknown
}

// Easy Auth's x-ms-client-principal is small (a handful of AAD claims). Anything larger is not a
// legitimate platform-issued token and is rejected outright rather than parsed.
const MAX_HEADER_LENGTH = 32 * 1024
const MAX_CLAIMS = 200

const TENANT_CLAIM_TYPES = ['tid', 'http://schemas.microsoft.com/identity/claims/tenantid']
const OBJECT_ID_CLAIM_TYPES = ['oid', 'http://schemas.microsoft.com/identity/claims/objectidentifier']
const ROLE_CLAIM_TYPES = ['roles', 'role', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role']
const IDENTITY_TYPE_CLAIM_TYPES = ['idtyp', 'http://schemas.microsoft.com/identity/claims/identitytype']
const NAME_CLAIM_TYPES = ['name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']
const EMAIL_CLAIM_TYPES = [
  'preferred_username',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
]

function firstClaimValue(claims: EasyAuthClaim[], types: string[]): string | undefined {
  for (const type of types) {
    const claim = claims.find((candidate) => candidate.typ === type)
    if (claim && claim.val.length > 0) return claim.val
  }
  return undefined
}

function identityClaim(claims: EasyAuthClaim[], types: string[], label: string): string {
  const values = claims.filter(claim => types.includes(claim.typ)).map(claim => claim.val.toLowerCase())
  if (!values.length || values.some(value => !GUID_PATTERN.test(value)) || new Set(values).size !== 1) {
    throw new AuthError(`Identity header has missing or inconsistent ${label} claims.`)
  }
  return values[0]
}

function decodeBase64Strict(value: string): string {
  // Buffer.from(..., 'base64') silently ignores invalid characters instead of throwing, so a
  // round trip is required to catch malformed/garbage input (e.g. non-base64, truncated padding).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new AuthError('Identity header is not valid base64.')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) throw new AuthError('Identity header is not valid base64.')
  return decoded.toString('utf8')
}

function parseEasyAuthClaims(principal: EasyAuthPrincipal): EasyAuthClaim[] {
  if (!Array.isArray(principal.claims)) throw new AuthError('Identity header is missing claims.')
  if (principal.claims.length > MAX_CLAIMS) throw new AuthError('Identity header has too many claims.')
  const claims: EasyAuthClaim[] = []
  for (const entry of principal.claims) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new AuthError('Identity header has a malformed claim.')
    const { typ, val } = entry as Record<string, unknown>
    if (typeof typ !== 'string' || typeof val !== 'string') throw new AuthError('Identity header has a malformed claim.')
    claims.push({ typ, val })
  }
  return claims
}

/**
 * Validates the platform-injected `x-ms-client-principal` header from Azure App Service Easy Auth.
 * Easy Auth strips any client-supplied copy of this header at the ingress edge and replaces it with
 * the platform's own validated token claims, so this function trusts the header's presence but still
 * fully validates its *content*: well-formed base64 JSON, `auth_typ === 'aad'`, an immutable tenant ID
 * claim matching the configured tenant, an immutable object ID, and a recognized application role.
 * Display fields (name/email/UPN) are extracted for UI purposes only and are never used to authorize.
 */
export function parseEasyAuthPrincipal(
  clientPrincipalHeader: string | undefined,
  clientPrincipalIdHeader: string | undefined,
  config: Config,
): AuthenticatedPrincipal {
  if (!clientPrincipalHeader) throw new AuthError('Missing identity header.')
  if (clientPrincipalHeader.length > MAX_HEADER_LENGTH) throw new AuthError('Identity header is too large.')

  const decoded = decodeBase64Strict(clientPrincipalHeader)
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    throw new AuthError('Identity header is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new AuthError('Identity header has an unexpected shape.')
  const principal = parsed as EasyAuthPrincipal
  if (principal.auth_typ !== 'aad') throw new AuthError('Identity header is not an Azure AD principal.')

  const claims = parseEasyAuthClaims(principal)
  const tenantId = identityClaim(claims, TENANT_CLAIM_TYPES, 'tenant ID')
  const oid = identityClaim(claims, OBJECT_ID_CLAIM_TYPES, 'object ID')

  // x-ms-client-principal-id, when present, is Easy Auth's own summary of the principal's ID.
  // A mismatch against the token claim indicates a tampered or inconsistent request; refuse it.
  if (clientPrincipalIdHeader !== undefined && clientPrincipalIdHeader.toLowerCase() !== oid) {
    throw new AuthError('Identity header claims are inconsistent.')
  }

  if (tenantId !== config.tenantId) throw new AuthError('This tenant is not authorized for this deployment.', 'forbidden')
  if (claims.some(claim => IDENTITY_TYPE_CLAIM_TYPES.includes(claim.typ) && claim.val !== 'user')) {
    throw new AuthError('Only user identities can access this application.', 'forbidden')
  }
  const applicationRoles = (['Score.Admin', 'Score.User'] as const).filter(role =>
    claims.some(claim => ROLE_CLAIM_TYPES.includes(claim.typ) && claim.val === role))
  if (!applicationRoles.length) throw new AuthError('A Score.User or Score.Admin application role is required.', 'forbidden')

  return {
    tenantId,
    oid,
    principalKey: principalKeyFor(tenantId, oid),
    name: firstClaimValue(claims, NAME_CLAIM_TYPES) ?? 'Signed-in user',
    email: firstClaimValue(claims, EMAIL_CLAIM_TYPES) ?? '',
    applicationRoles,
  }
}

/**
 * Explicit local-developer identity, used only when SCORE_AUTH_MODE=dev-header. Config loading
 * already prohibits this mode in production or on App Service, so this path can never run there.
 * The header format (`tenantId:oid`) is intentionally different from the real Easy Auth header so
 * the two cannot be confused with each other.
 */
export function parseDevHeaderPrincipal(devPrincipalHeader: string | undefined, config: Config): AuthenticatedPrincipal {
  if (config.authMode !== 'dev-header' || config.isProduction || config.isAppService) {
    throw new AuthError('Developer authentication is only available in explicit local development mode.', 'forbidden')
  }
  if (!devPrincipalHeader) throw new AuthError('Missing identity header.')
  const parts = devPrincipalHeader.split(':').map((value) => value.trim().toLowerCase())
  const [tenantId, oid] = parts
  if (parts.length !== 2 || !tenantId || !oid || !GUID_PATTERN.test(tenantId) || !GUID_PATTERN.test(oid)) {
    throw new AuthError('X-Score-Dev-Principal must be "<tenantId>:<objectId>" with GUID values.')
  }
  if (tenantId !== config.tenantId) throw new AuthError('This tenant is not authorized for this deployment.', 'forbidden')
  const applicationRoles = config.devUserRoles?.get(oid)
  if (!applicationRoles?.length || applicationRoles.some(role => role !== 'Score.User' && role !== 'Score.Admin')) {
    throw new AuthError('This developer identity has no configured Score application role.', 'forbidden')
  }
  return {
    tenantId,
    oid,
    principalKey: principalKeyFor(tenantId, oid),
    name: 'Local developer',
    email: '',
    applicationRoles: [...applicationRoles],
  }
}
