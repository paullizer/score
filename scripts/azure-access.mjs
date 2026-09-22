import { identifier, required } from './azure-common.mjs'

export const APPLICATION_ADMISSION_VERSION = 'entra-roles-v1'
export const SCORE_USER_ROLE_ID = 'e859daa1-e9fa-426a-b79d-6d136d459222'
export const SCORE_ADMIN_ROLE_ID = '156757cb-0797-409c-931b-c711ccc8bdde'
export const GRAPH_APPLICATION_ID = '00000003-0000-0000-c000-000000000000'
export const DIRECTORY_PERMISSIONS = ['Application.Read.All', 'GroupMember.ReadBasic.All', 'User.Read.All']
export const SCORE_ROLES = [
  { id: SCORE_USER_ROLE_ID, allowedMemberTypes: ['User'], description: 'Sign in to Score. Workspace access and creation grants are separate.', displayName: 'Score user', isEnabled: true, value: 'Score.User' },
  { id: SCORE_ADMIN_ROLE_ID, allowedMemberTypes: ['User'], description: 'Administer Score and access every workspace in this tenant as an owner.', displayName: 'Score administrator', isEnabled: true, value: 'Score.Admin' },
]

export function identifiers(value, name, requireAny = false) {
  const values = value?.trim() ? value.split(',').map(item => identifier(item.trim(), name).toLowerCase()) : []
  if (requireAny && !values.length) throw new Error(`${name} requires explicit Entra object IDs. No deployment operator or previous allowlist entry is inferred as an administrator.`)
  return [...new Set(values)]
}

export function bootstrapAdministrators(env) {
  return identifiers(env.AZURE_BOOTSTRAP_ADMIN_USER_IDS, 'AZURE_BOOTSTRAP_ADMIN_USER_IDS', true)
}

export function admissionStage(env) {
  const stage = env.AZURE_SCORE_ADMISSION_STAGE || 'guarded'
  if (!['guarded', 'roles'].includes(stage)) throw new Error('AZURE_SCORE_ADMISSION_STAGE must be guarded or roles.')
  if (stage === 'roles' && (!env.AZURE_SCORE_ROLE_VERIFIED_IMAGE || !env.AZURE_SCORE_ROLE_VERIFIED_AT ||
    !Number.isFinite(Date.parse(env.AZURE_SCORE_ROLE_VERIFIED_AT)))) {
    throw new Error('Role-based ingress requires a verified deployment. Use azure-auth.mjs release-ingress; do not set the stage manually.')
  }
  return stage
}

export function mergeApplicationRoles(existing) {
  if (!Array.isArray(existing)) throw new Error('The existing application-role configuration could not be read safely.')
  const roles = structuredClone(existing)
  for (const expected of SCORE_ROLES) {
    const matches = roles.filter(role => role.id?.toLowerCase() === expected.id || role.value === expected.value)
    if (matches.length > 1 || (matches.length === 1 && (matches[0].id?.toLowerCase() !== expected.id ||
      matches[0].value !== expected.value || matches[0].isEnabled !== true ||
      matches[0].allowedMemberTypes?.length !== 1 || matches[0].allowedMemberTypes[0] !== 'User'))) {
      throw new Error(`Existing ${expected.value} role has an incompatible ID or definition. Existing assignments have not been replaced.`)
    }
    if (!matches.length) roles.push(structuredClone(expected))
  }
  return roles
}

export async function graphValues(callGraph, path) {
  const values = []
  const expectedPath = new URL(`https://graph.microsoft.com/v1.0${path}`).pathname
  const visited = new Set()
  let next = path
  while (next) {
    if (visited.has(next)) throw new Error('Graph repeated a continuation; no incomplete provisioning result is accepted.')
    visited.add(next)
    const result = await callGraph(next)
    if (!Array.isArray(result?.value)) throw new Error('Graph returned an invalid collection.')
    values.push(...result.value)
    const link = result['@odata.nextLink']
    if (link === undefined) break
    if (typeof link !== 'string') throw new Error('Graph returned an invalid continuation.')
    const url = new URL(link)
    if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash || url.pathname !== expectedPath) {
      throw new Error('Graph returned an unsafe continuation.')
    }
    next = `${url.pathname.slice('/v1.0'.length)}${url.search}`
  }
  return values
}

export function directoryPermissionDefinitions(graphPrincipal, consentHiddenMembership = false) {
  const names = [...DIRECTORY_PERMISSIONS, ...(consentHiddenMembership ? ['Member.Read.Hidden'] : [])]
  return names.map(name => {
    const matches = graphPrincipal.appRoles?.filter(role =>
      role.value === name && role.isEnabled === true && role.allowedMemberTypes?.includes('Application')) ?? []
    if (matches.length !== 1) throw new Error(`Required Graph application permission ${name} is unavailable or ambiguous. No broader permission will be substituted.`)
    return { name, id: identifier(matches[0].id, `${name} permission ID`).toLowerCase() }
  })
}

export function validateEasyAuth(env, settings, stage = admissionStage(env)) {
  const tenant = identifier(required(env, 'AZURE_TENANT_ID'), 'Tenant').toLowerCase()
  const clientId = identifier(required(env, 'AZURE_AUTH_CLIENT_ID'), 'Application').toLowerCase()
  const provider = settings?.identityProviders?.azureActiveDirectory
  const principals = provider?.validation?.defaultAuthorizationPolicy?.allowedPrincipals
  const audiences = provider?.validation?.allowedAudiences
  const exclusions = settings?.globalValidation?.excludedPaths ?? []
  if (settings?.platform?.enabled !== true || settings?.globalValidation?.requireAuthentication !== true ||
    settings?.httpSettings?.requireHttps !== true || provider?.enabled !== true ||
    provider?.registration?.clientId?.toLowerCase() !== clientId ||
    provider?.registration?.openIdIssuer?.replace(/\/$/, '').toLowerCase() !== `https://login.microsoftonline.com/${tenant}/v2.0` ||
    provider?.registration?.clientSecretSettingName !== 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET' ||
    !Array.isArray(audiences) || audiences.length !== 2 || !audiences.includes(clientId) || !audiences.includes(`api://${clientId}`) ||
    settings?.login?.tokenStore?.enabled !== false ||
    exclusions.length !== 1 || exclusions[0] !== '/healthz' ||
    Object.entries(settings?.identityProviders ?? {}).some(([name, value]) => name !== 'azureActiveDirectory' && value?.enabled === true)) {
    throw new Error('Deployment requires tenant-specific, audience-restricted HTTPS Easy Auth, no browser token store, and only the /healthz exemption.')
  }
  const identities = principals?.identities ?? []
  if (!Array.isArray(identities) || (principals?.groups?.length ?? 0) > 0 ||
    (stage === 'guarded' ? identities.length !== 1 ||
      identities[0].toLowerCase() !== identifier(required(env, 'AZURE_ALLOWED_USER_ID'), 'Guarded user').toLowerCase() : identities.length !== 0)) {
    throw new Error(`Easy Auth ingress does not match the explicit ${stage} migration stage. No gate was silently changed.`)
  }
}

export function validateRuntimeAccessSettings(env, settings) {
  if (settings.SCORE_AUTH_MODE !== 'easyauth' ||
    settings.AZURE_TENANT_ID?.toLowerCase() !== required(env, 'AZURE_TENANT_ID').toLowerCase() ||
    settings.SCORE_ENTRA_SERVICE_PRINCIPAL_ID?.toLowerCase() !== required(env, 'AZURE_AUTH_SP_OBJECT_ID').toLowerCase() ||
    settings.SCORE_ACCESS_CONTAINER !== 'application-access' ||
    settings.AZURE_CLIENT_ID?.toLowerCase() !== required(env, 'AZURE_MANAGED_IDENTITY_CLIENT_ID').toLowerCase()) {
    throw new Error('API role-aware authentication, dedicated access store, or managed identity settings are not provisioned.')
  }
  const stores = [settings.COSMOS_CONTAINER, settings.SCORE_SETTINGS_CONTAINER, settings.JOB_RECORDS_CONTAINER,
    settings.GRADE_RECORDS_CONTAINER, settings.RESUME_RECORDS_CONTAINER, settings.ANALYSIS_RECORDS_CONTAINER]
  if (stores.includes(settings.SCORE_ACCESS_CONTAINER)) throw new Error('Application grants must use an isolated access container.')
  if (settings.SCORE_DEV_USER_ROLES || settings.SCORE_ADMIN_USER_IDS) throw new Error('Remove developer identities and the retired production administrator-ID setting before deployment.')
}

export async function verifyRoleAwareDeployment(env, image, { fetch: fetchProof = fetch, cookie = process.env.SCORE_ROLE_VERIFICATION_COOKIE } = {}) {
  if (!cookie || /[\r\n]/.test(cookie)) throw new Error('Set SCORE_ROLE_VERIFICATION_COOKIE only in this operator process to a current Easy Auth session cookie; never save it in azd.')
  const origin = new URL(required(env, 'AZURE_APP_SERVICE_URL'))
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.azurewebsites.net') || origin.username || origin.password ||
    origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Role verification requires the deployed HTTPS App Service origin.')
  if (!image?.startsWith(`${required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT')}/`)) throw new Error('Role verification requires the current deployed Score registry image.')
  const readiness = await fetchProof(`${origin.origin}/healthz`, {
    redirect: 'manual', signal: AbortSignal.timeout(20_000),
  })
  if (readiness.status !== 200 || readiness.headers.get('x-score-access-control') !== APPLICATION_ADMISSION_VERSION) {
    await readiness.body?.cancel()
    throw new Error('The live API must report ready with the role-aware access-control health marker before deployment verification can succeed.')
  }
  const health = await readiness.json()
  if (health?.status !== 'ok' && health?.status !== 'ready') throw new Error('The role-aware API has not passed live readiness checks.')
  for (const path of ['/api/session', '/']) {
    const response = await fetchProof(`${origin.origin}${path}`, {
      headers: { Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(20_000),
    })
    const roles = response.headers.get('x-score-application-roles')?.split(',') ?? []
    if (!response.ok || response.headers.get('x-score-admission-version') !== APPLICATION_ADMISSION_VERSION ||
      !roles.length || roles.some(role => !['Score.User', 'Score.Admin'].includes(role))) {
      await response.body?.cancel()
      throw new Error('The deployed API and SPA must both demonstrate trusted Score role enforcement with a fresh real Easy Auth session before ingress can be released.')
    }
    if (path === '/api/session') {
      const session = await response.json()
      if (session?.user?.tenantId?.toLowerCase() !== required(env, 'AZURE_TENANT_ID').toLowerCase() ||
        !/^[a-f0-9-]{36}$/i.test(session?.user?.id ?? '')) throw new Error('The verification session does not belong to the configured tenant.')
    } else await response.body?.cancel()
  }
  return { image, verifiedAt: new Date().toISOString(), version: APPLICATION_ADMISSION_VERSION }
}
