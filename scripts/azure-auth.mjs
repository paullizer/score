import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { SecretClient } from '@azure/keyvault-secrets'
import { client, environment, graph, identifier, request, required, setEnvironment } from './azure-common.mjs'
import {
  GRAPH_APPLICATION_ID, SCORE_ADMIN_ROLE_ID, SCORE_USER_ROLE_ID, admissionStage,
  bootstrapAdministrators, directoryPermissionDefinitions, graphValues, identifiers, mergeApplicationRoles,
  validateEasyAuth, validateRuntimeAccessSettings, verifyRoleAwareDeployment,
} from './azure-access.mjs'

const secretName = 'easyauth-client-secret'
const credentialName = 'score-easyauth'
const ownershipTag = 'github:paullizer/score'

export async function ensureSignInConsent(callGraph, app, principalId) {
  const graphApplications = await graphValues(callGraph,
    `/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${GRAPH_APPLICATION_ID}'`)}&$select=id,oauth2PermissionScopes`)
  if (graphApplications.length !== 1) throw new Error('The tenant Microsoft Graph service principal could not be resolved uniquely.')
  const graphApplication = graphApplications[0]
  const scopeNames = ['openid', 'profile', 'email']
  const scopeIds = scopeNames.map(name => {
    const definition = graphApplication.oauth2PermissionScopes.find(scope => scope.value === name && scope.isEnabled)
    if (!definition) throw new Error(`The required ${name} sign-in scope is unavailable in this tenant.`)
    return definition.id
  })
  if (!Array.isArray(app.requiredResourceAccess)) throw new Error('The application permission configuration could not be read safely.')
  const permissions = structuredClone(app.requiredResourceAccess)
  let entry = permissions.find(item => item.resourceAppId === '00000003-0000-0000-c000-000000000000')
  if (!entry) {
    entry = { resourceAppId: '00000003-0000-0000-c000-000000000000', resourceAccess: [] }
    permissions.push(entry)
  }
  for (const id of scopeIds) {
    if (!entry.resourceAccess.some(item => item.id === id && item.type === 'Scope')) entry.resourceAccess.push({ id, type: 'Scope' })
  }
  if (JSON.stringify(permissions) !== JSON.stringify(app.requiredResourceAccess)) {
    await callGraph(`/applications/${app.id}`, 'PATCH', { requiredResourceAccess: permissions })
  }
  const grants = await graphValues(callGraph, `/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${principalId}'`)}`)
  const existing = grants.find(grant => grant.resourceId === graphApplication.id && grant.consentType === 'AllPrincipals')
  if (existing) {
    const scopes = [...new Set([...existing.scope.split(' ').filter(Boolean), ...scopeNames])]
    if (scopes.join(' ') !== existing.scope) await callGraph(`/oauth2PermissionGrants/${existing.id}`, 'PATCH', { scope: scopes.join(' ') })
  } else {
    await callGraph('/oauth2PermissionGrants', 'POST', {
      clientId: principalId,
      consentType: 'AllPrincipals',
      resourceId: graphApplication.id,
      scope: scopeNames.join(' '),
    })
  }
}

export async function ensureRoleAssignments(env, principalId, callGraph) {
  const admins = bootstrapAdministrators(env)
  const targets = [
    ...identifiers(env.AZURE_SCORE_USER_IDS || required(env, 'AZURE_ALLOWED_USER_ID'), 'Score user IDs', true)
      .map(id => ({ id, type: 'User', roleId: SCORE_USER_ROLE_ID })),
    ...admins.map(id => ({ id, type: 'User', roleId: SCORE_ADMIN_ROLE_ID })),
    ...identifiers(env.AZURE_SCORE_USER_GROUP_IDS, 'Score user group IDs').map(id => ({ id, type: 'Group', roleId: SCORE_USER_ROLE_ID })),
    ...identifiers(env.AZURE_SCORE_ADMIN_GROUP_IDS, 'Score admin group IDs').map(id => ({ id, type: 'Group', roleId: SCORE_ADMIN_ROLE_ID })),
  ]
  const assignments = await graphValues(callGraph, `/servicePrincipals/${principalId}/appRoleAssignedTo`)
  for (const target of targets) {
    const directoryObject = await callGraph(`/${target.type === 'User' ? 'users' : 'groups'}/${target.id}?$select=id`)
    if (directoryObject?.id?.toLowerCase() !== target.id) throw new Error('An explicitly requested role-assignment recipient could not be verified.')
    if (!assignments.some(assignment => assignment.principalId?.toLowerCase() === target.id &&
      assignment.resourceId?.toLowerCase() === principalId.toLowerCase() && assignment.appRoleId?.toLowerCase() === target.roleId)) {
      assignments.push(await callGraph(`/servicePrincipals/${principalId}/appRoleAssignedTo`, 'POST', {
        principalId: target.id, resourceId: principalId, appRoleId: target.roleId,
      }))
    }
  }
}

export async function ensureDirectoryConsent(env, callGraph) {
  const principalId = identifier(required(env, 'AZURE_MANAGED_IDENTITY_PRINCIPAL_ID'), 'API managed identity principal').toLowerCase()
  for (const key of ['AZURE_JOB_WORKER_PRINCIPAL_ID', 'AZURE_GRADE_WORKER_PRINCIPAL_ID',
    'AZURE_RESUME_WORKER_PRINCIPAL_ID', 'AZURE_ANALYSIS_WORKER_PRINCIPAL_ID']) {
    if (env[key]?.toLowerCase() === principalId) throw new Error('Graph consent belongs only to the API managed identity, never a document worker.')
  }
  const hidden = env.AZURE_SCORE_CONSENT_HIDDEN_MEMBERSHIP ?? 'false'
  if (!['true', 'false'].includes(hidden)) throw new Error('AZURE_SCORE_CONSENT_HIDDEN_MEMBERSHIP must be explicitly true or false.')
  const principal = await callGraph(`/servicePrincipals/${principalId}?$select=id,appId,servicePrincipalType`)
  if (principal?.id?.toLowerCase() !== principalId || principal.servicePrincipalType !== 'ManagedIdentity' ||
    principal.appId?.toLowerCase() !== identifier(required(env, 'AZURE_MANAGED_IDENTITY_CLIENT_ID'), 'API managed identity client').toLowerCase()) {
    throw new Error('The Graph consent target is not the configured API managed identity.')
  }
  const graphPrincipals = await graphValues(callGraph,
    `/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${GRAPH_APPLICATION_ID}'`)}&$select=id,appRoles`)
  if (graphPrincipals.length !== 1) throw new Error('The tenant Microsoft Graph service principal could not be resolved uniquely.')
  const resource = graphPrincipals[0]
  const permissions = directoryPermissionDefinitions(resource, hidden === 'true')
  const assignments = await graphValues(callGraph, `/servicePrincipals/${principalId}/appRoleAssignments`)
  if (assignments.some(item => item.resourceId?.toLowerCase() === resource.id.toLowerCase() &&
    !permissions.some(permission => permission.id === item.appRoleId?.toLowerCase()))) {
    throw new Error('The API identity has unapproved Graph permissions. Review and remove them explicitly; provisioning will not retain a write/broad-directory fallback.')
  }
  for (const permission of permissions) {
    if (!assignments.some(item => item.resourceId?.toLowerCase() === resource.id.toLowerCase() && item.appRoleId?.toLowerCase() === permission.id)) {
      await callGraph(`/servicePrincipals/${principalId}/appRoleAssignments`, 'POST', {
        principalId, resourceId: resource.id, appRoleId: permission.id,
      })
    }
  }
}

async function prepare(env) {
  const envName = required(env, 'AZURE_ENV_NAME')
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(envName)) throw new Error('Use a lowercase alphanumeric/hyphen environment name, 3-32 characters.')
  const allowedUserId = identifier(required(env, 'AZURE_ALLOWED_USER_ID'), 'Allowed user')
  const operatorId = identifier(required(env, 'AZURE_PRINCIPAL_ID'), 'Deployment principal')
  bootstrapAdministrators(env)
  const stage = admissionStage(env)
  if (stage === 'roles' && env.AZURE_CONTAINER_IMAGE !== env.AZURE_SCORE_ROLE_VERIFIED_IMAGE) {
    throw new Error('Provisioning would replace a released deployment with an unverified image. Verify the deployed image or restore guarded ingress first.')
  }
  const credential = client(env)
  if (env.AZURE_APP_SERVICE_NAME) {
    const base = `https://management.azure.com/subscriptions/${identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')}/resourceGroups/${encodeURIComponent(required(env, 'AZURE_RESOURCE_GROUP'))}/providers/Microsoft.Web/sites/${encodeURIComponent(env.AZURE_APP_SERVICE_NAME)}`
    const currentAuth = await request(credential, 'https://management.azure.com', `${base}/config/authsettingsV2?api-version=2024-11-01`)
    validateEasyAuth(env, currentAuth.properties, stage)
    if (stage === 'roles') {
      const web = await request(credential, 'https://management.azure.com', `${base}/config/web?api-version=2024-11-01`)
      const image = web.properties?.linuxFxVersion?.replace(/^DOCKER\|/, '')
      if (image !== env.AZURE_SCORE_ROLE_VERIFIED_IMAGE) throw new Error('The live image does not match the verified role-aware deployment. Restore guarded ingress or verify it before provisioning.')
      await verifyRoleAwareDeployment(env, image)
    }
  }
  const me = await graph(credential, '/me?$select=id')
  if (me.id !== operatorId) throw new Error('The Azure CLI identity does not match the configured deployment principal.')
  const displayName = `Score (${envName})`
  const filter = encodeURIComponent(`displayName eq '${displayName}'`)
  const applications = await graph(credential, `/applications?$filter=${filter}&$select=id,appId,displayName,tags,appRoles,requiredResourceAccess`)
  if (applications.value.length > 1) throw new Error(`Multiple registrations named ${displayName} exist. Resolve the duplicate registrations before deploying.`)
  let app = applications.value[0]
  if (app && !app.tags?.includes(ownershipTag)) throw new Error('An existing registration has the same name but is not tagged as this Score application. It has not been modified.')
  const roles = mergeApplicationRoles(app?.appRoles ?? [])
  if (!app) {
    app = await graph(credential, '/applications', 'POST', {
      displayName,
      signInAudience: 'AzureADMyOrg',
      tags: [ownershipTag, `azd:${envName}`],
      appRoles: roles,
      web: { redirectUris: [], implicitGrantSettings: { enableIdTokenIssuance: true, enableAccessTokenIssuance: false } },
      requiredResourceAccess: [],
    })
    const owners = await graph(credential, `/applications/${app.id}/owners?$select=id`)
    if (!owners.value.some(owner => owner.id === operatorId)) {
      await graph(credential, `/applications/${app.id}/owners/$ref`, 'POST', {
        '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${operatorId}`,
      })
    }
    await graph(credential, `/applications/${app.id}`, 'PATCH', { identifierUris: [`api://${app.appId}`] })
  } else if (JSON.stringify(app.appRoles) !== JSON.stringify(roles)) {
    await graph(credential, `/applications/${app.id}`, 'PATCH', { appRoles: roles })
  }
  const principals = await graph(credential, `/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${app.appId}'`)}&$select=id,appId,appRoleAssignmentRequired`)
  if (principals.value.length > 1) throw new Error('Multiple service principals unexpectedly reference this application.')
  let principal = principals.value[0]
  if (!principal) principal = await graph(credential, '/servicePrincipals', 'POST', { appId: app.appId, appRoleAssignmentRequired: true })
  await graph(credential, `/servicePrincipals/${principal.id}`, 'PATCH', { appRoleAssignmentRequired: true })
  const callGraph = (path, method, body) => graph(credential, path, method, body)
  await ensureRoleAssignments({ ...env, AZURE_ALLOWED_USER_ID: allowedUserId }, principal.id, callGraph)
  await ensureSignInConsent(callGraph, app, principal.id)
  setEnvironment('AZURE_AUTH_CLIENT_ID', app.appId)
  setEnvironment('AZURE_AUTH_APP_OBJECT_ID', app.id)
  setEnvironment('AZURE_AUTH_SP_OBJECT_ID', principal.id)
  setEnvironment('AZURE_SCORE_ADMISSION_STAGE', stage)
  setEnvironment('AZURE_SCORE_ROLE_VERIFIED_IMAGE', env.AZURE_SCORE_ROLE_VERIFIED_IMAGE || '')
  setEnvironment('AZURE_SCORE_ROLE_VERIFIED_AT', env.AZURE_SCORE_ROLE_VERIFIED_AT || '')
  console.log(`Entra registration prepared: ${displayName}. Assignment is required; explicit users/groups have their requested roles. Ingress remains ${stage}.`)
}

export async function verifyEntraProvisioning(env, callGraph) {
  const principalId = identifier(required(env, 'AZURE_AUTH_SP_OBJECT_ID'), 'Score service principal').toLowerCase()
  const principal = await callGraph(`/servicePrincipals/${principalId}?$select=id,appId,appRoles,appRoleAssignmentRequired`)
  if (principal?.id?.toLowerCase() !== principalId ||
    principal.appId?.toLowerCase() !== required(env, 'AZURE_AUTH_CLIENT_ID').toLowerCase() ||
    principal.appRoleAssignmentRequired !== true || mergeApplicationRoles(principal.appRoles).length !== principal.appRoles.length) {
    throw new Error('The Score Enterprise Application must require assignment and expose both stable user-only application roles.')
  }
  const assignments = await graphValues(callGraph, `/servicePrincipals/${principalId}/appRoleAssignedTo`)
  for (const id of bootstrapAdministrators(env)) {
    if (!assignments.some(item => item.principalType === 'User' && item.principalId?.toLowerCase() === id &&
      item.resourceId?.toLowerCase() === principalId && item.appRoleId?.toLowerCase() === SCORE_ADMIN_ROLE_ID)) {
      throw new Error('Every explicit bootstrap administrator must have a verified direct Score.Admin assignment before deployment.')
    }
  }
  const graphPrincipals = await graphValues(callGraph,
    `/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${GRAPH_APPLICATION_ID}'`)}&$select=id,appRoles`)
  if (graphPrincipals.length !== 1) throw new Error('Microsoft Graph could not be resolved uniquely.')
  const permissions = directoryPermissionDefinitions(graphPrincipals[0], env.AZURE_SCORE_CONSENT_HIDDEN_MEMBERSHIP === 'true')
  const runtimeId = identifier(required(env, 'AZURE_MANAGED_IDENTITY_PRINCIPAL_ID'), 'API managed identity')
  const consent = (await graphValues(callGraph, `/servicePrincipals/${runtimeId}/appRoleAssignments`))
    .filter(item => item.resourceId?.toLowerCase() === graphPrincipals[0].id.toLowerCase())
  if (permissions.some(permission => !consent.some(item => item.appRoleId?.toLowerCase() === permission.id)) ||
    consent.some(item => !permissions.some(permission => permission.id === item.appRoleId?.toLowerCase()))) {
    throw new Error('The API managed identity must have exactly the approved read-only Graph application permissions. Consent/propagation is not yet verified.')
  }
}

export async function transitionIngress(env, mode, dependencies = {}) {
  const credential = dependencies.credential ?? client(env)
  const callArm = dependencies.arm ?? ((url, method, body) => request(credential, 'https://management.azure.com', url, method, body))
  const callGraph = dependencies.graph ?? ((path, method, body) => graph(credential, path, method, body))
  const save = dependencies.save ?? setEnvironment
  const base = `https://management.azure.com/subscriptions/${identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')}/resourceGroups/${encodeURIComponent(required(env, 'AZURE_RESOURCE_GROUP'))}/providers/Microsoft.Web/sites/${encodeURIComponent(required(env, 'AZURE_APP_SERVICE_NAME'))}`
  const authUrl = `${base}/config/authsettingsV2?api-version=2024-11-01`
  const auth = await callArm(authUrl)
  const existingIdentities = auth.properties?.identityProviders?.azureActiveDirectory?.validation?.defaultAuthorizationPolicy?.allowedPrincipals?.identities
  validateEasyAuth(env, auth.properties, existingIdentities?.length ? 'guarded' : 'roles')
  if (mode === 'restore-guard') {
    const properties = structuredClone(auth.properties)
    properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy = {
      allowedPrincipals: { identities: [identifier(required(env, 'AZURE_ALLOWED_USER_ID'), 'Guarded user')] },
    }
    await callArm(authUrl, 'PUT', { properties })
    validateEasyAuth(env, (await callArm(authUrl)).properties, 'guarded')
    save('AZURE_SCORE_ADMISSION_STAGE', 'guarded')
    save('AZURE_SCORE_ROLE_VERIFIED_IMAGE', '')
    save('AZURE_SCORE_ROLE_VERIFIED_AT', '')
    return
  }
  if (mode !== 'release-ingress') throw new Error('Unsupported ingress transition.')
  await verifyEntraProvisioning(env, callGraph)
  const appSettings = await callArm(`${base}/config/appsettings/list?api-version=2024-11-01`, 'POST')
  validateRuntimeAccessSettings(env, appSettings.properties)
  const web = await callArm(`${base}/config/web?api-version=2024-11-01`)
  const image = web.properties?.linuxFxVersion?.replace(/^DOCKER\|/, '')
  const proof = await verifyRoleAwareDeployment(env, image, dependencies)
  const properties = structuredClone(auth.properties)
  delete properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy
  await callArm(authUrl, 'PUT', { properties })
  validateEasyAuth(env, (await callArm(authUrl)).properties, 'roles')
  // Persist proof before the released stage so an interrupted local save cannot claim verification.
  save('AZURE_CONTAINER_IMAGE', image)
  save('AZURE_SCORE_ROLE_VERIFIED_IMAGE', proof.image)
  save('AZURE_SCORE_ROLE_VERIFIED_AT', proof.verifiedAt)
  save('AZURE_SCORE_ADMISSION_STAGE', 'roles')
}

async function waitForVault(action) {
  for (let attempt = 0; attempt < 25; attempt++) {
    try { return await action() } catch (error) {
      if (!(error instanceof Error) || error.statusCode !== 403 || attempt === 24) throw error
      if (attempt === 0) console.log('Waiting for the Key Vault data-plane role assignment to propagate...')
      await delay(10000)
    }
  }
  throw new Error('Key Vault access did not become available.')
}

async function configure(env) {
  const credential = client(env)
  const appId = identifier(required(env, 'AZURE_AUTH_CLIENT_ID'), 'Application client ID')
  const objectId = identifier(required(env, 'AZURE_AUTH_APP_OBJECT_ID'), 'Application object ID')
  const appUrl = new URL(required(env, 'AZURE_APP_SERVICE_URL'))
  if (appUrl.protocol !== 'https:' || !appUrl.hostname.endsWith('.azurewebsites.net')) throw new Error('Expected the deployed HTTPS App Service hostname.')
  const redirect = `${appUrl.origin}/.auth/login/aad/callback`
  const app = await graph(credential, `/applications/${objectId}?$select=id,appId,tags,web,passwordCredentials`)
  if (app.appId !== appId || !app.tags?.includes(ownershipTag)) throw new Error('The configured registration is not this Score application.')
  if (!app.web.redirectUris.includes(redirect)) {
    await graph(credential, `/applications/${objectId}`, 'PATCH', {
      web: { ...app.web, redirectUris: [...new Set([...app.web.redirectUris, redirect])] },
    })
  }
  const vault = new SecretClient(required(env, 'AZURE_KEY_VAULT_ENDPOINT'), credential)
  const existing = await waitForVault(async () => {
    for await (const properties of vault.listPropertiesOfSecrets()) {
      if (properties.name === secretName) return properties
    }
    return undefined
  })
  if (existing && existing.tags?.appClientId !== appId) {
    throw new Error('The Easy Auth secret exists without the expected application ownership tag. It has not been replaced.')
  }
  const rotateBefore = Date.now() + 30 * 24 * 60 * 60 * 1000
  const matchingCredential = app.passwordCredentials.find(item => item.keyId === existing?.tags?.credentialKeyId)
  const reusable = existing?.enabled !== false && existing?.expiresOn?.getTime() > rotateBefore &&
    matchingCredential && Date.parse(matchingCredential.endDateTime) > rotateBefore
  if (!reusable || process.argv.includes('--rotate')) {
    const expiresOn = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)
    const created = await graph(credential, `/applications/${objectId}/addPassword`, 'POST', {
      passwordCredential: { displayName: credentialName, endDateTime: expiresOn.toISOString() },
    })
    if (typeof created.secretText !== 'string' || !created.secretText || !created.keyId) throw new Error('Entra did not return a usable application credential.')
    try {
      await waitForVault(() => vault.setSecret(secretName, created.secretText, {
        expiresOn,
        contentType: 'application/x-score-easyauth',
        tags: { appClientId: appId, credentialKeyId: created.keyId },
      }))
    } catch (error) {
      await graph(credential, `/applications/${objectId}/removePassword`, 'POST', { keyId: created.keyId })
      throw error
    }
    created.secretText = undefined
    console.log(`Easy Auth credential stored directly in Key Vault; expires ${expiresOn.toISOString().slice(0, 10)}. No credential was written to disk or azd environment values.`)
  } else {
    console.log('Reusing the valid Key Vault-backed Easy Auth credential.')
  }
  const subscription = identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')
  const resourceGroup = required(env, 'AZURE_RESOURCE_GROUP')
  const siteName = required(env, 'AZURE_APP_SERVICE_NAME')
  const siteId = `/subscriptions/${subscription}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}`
  await request(credential, 'https://management.azure.com',
    `https://management.azure.com${siteId}/config/configreferences/appsettings/refresh?api-version=2024-11-01`, 'POST')
  for (const item of app.passwordCredentials.filter(item => item.displayName === credentialName && Date.parse(item.endDateTime) < Date.now())) {
    await graph(credential, `/applications/${objectId}/removePassword`, 'POST', { keyId: item.keyId })
  }
  console.log(`Easy Auth redirect configured for ${appUrl.origin}.`)
}

async function main() {
  const mode = process.argv[2]
  if (!['prepare', 'configure', 'consent-directory', 'release-ingress', 'restore-guard'].includes(mode)) {
    throw new Error('Usage: node scripts\\azure-auth.mjs prepare|configure|consent-directory|release-ingress --verified-role-claims|restore-guard')
  }
  const env = environment()
  if (mode === 'prepare') await prepare(env)
  else if (mode === 'configure') await configure(env)
  else if (mode === 'consent-directory') {
    const credential = client(env)
    await ensureDirectoryConsent(env, (path, method, body) => graph(credential, path, method, body))
    console.log('Only the API managed identity has been provisioned with the explicitly approved read-only Graph permissions.')
  } else {
    if (mode === 'release-ingress' && !process.argv.includes('--verified-role-claims')) {
      throw new Error('Release requires --verified-role-claims after testing real Easy Auth roles and the guarded role-aware deployment. Read the README migration checklist.')
    }
    await transitionIngress(env, mode)
    console.log(mode === 'release-ingress' ? 'Verified role-based ingress released; future provisions preserve this explicit stage.' :
      'Guarded ingress restored and verified. Restore legacy runtime settings before deploying a legacy image.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Azure authentication setup failed.')
  process.exitCode = 1
})
