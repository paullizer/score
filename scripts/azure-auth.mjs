import { setTimeout as delay } from 'node:timers/promises'
import { SecretClient } from '@azure/keyvault-secrets'
import { client, environment, graph, identifier, request, required, setEnvironment } from './azure-common.mjs'

const applicationRoleId = 'e859daa1-e9fa-426a-b79d-6d136d459222'
const secretName = 'easyauth-client-secret'
const credentialName = 'score-easyauth'
const ownershipTag = 'github:paullizer/score'

async function ensureSignInConsent(credential, app, principalId, allowedUserId) {
  const graphApplications = await graph(credential,
    `/servicePrincipals?$filter=${encodeURIComponent("appId eq '00000003-0000-0000-c000-000000000000'")}&$select=id,oauth2PermissionScopes`)
  if (graphApplications.value.length !== 1) throw new Error('The tenant Microsoft Graph service principal could not be resolved uniquely.')
  const graphApplication = graphApplications.value[0]
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
    await graph(credential, `/applications/${app.id}`, 'PATCH', { requiredResourceAccess: permissions })
  }
  const grants = await graph(credential, `/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${principalId}'`)}`)
  const existing = grants.value.find(grant => grant.resourceId === graphApplication.id &&
    grant.consentType === 'Principal' && grant.principalId === allowedUserId)
  if (existing) {
    const scopes = [...new Set([...existing.scope.split(' ').filter(Boolean), ...scopeNames])]
    if (scopes.join(' ') !== existing.scope) await graph(credential, `/oauth2PermissionGrants/${existing.id}`, 'PATCH', { scope: scopes.join(' ') })
  } else {
    await graph(credential, '/oauth2PermissionGrants', 'POST', {
      clientId: principalId,
      consentType: 'Principal',
      principalId: allowedUserId,
      resourceId: graphApplication.id,
      scope: scopeNames.join(' '),
    })
  }
}

async function prepare(env) {
  const envName = required(env, 'AZURE_ENV_NAME')
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(envName)) throw new Error('Use a lowercase alphanumeric/hyphen environment name, 3-32 characters.')
  const allowedUserId = identifier(required(env, 'AZURE_ALLOWED_USER_ID'), 'Allowed user')
  const operatorId = identifier(required(env, 'AZURE_PRINCIPAL_ID'), 'Deployment principal')
  const credential = client(env)
  const me = await graph(credential, '/me?$select=id')
  if (me.id !== operatorId) throw new Error('The Azure CLI identity does not match the configured deployment principal.')
  const displayName = `Score (${envName})`
  const filter = encodeURIComponent(`displayName eq '${displayName}'`)
  const applications = await graph(credential, `/applications?$filter=${filter}&$select=id,appId,displayName,tags,appRoles,requiredResourceAccess`)
  if (applications.value.length > 1) throw new Error(`Multiple registrations named ${displayName} exist. Resolve the duplicate registrations before deploying.`)
  let app = applications.value[0]
  if (app && !app.tags?.includes(ownershipTag)) throw new Error('An existing registration has the same name but is not tagged as this Score application. It has not been modified.')
  if (app && !app.appRoles.some(role => role.id === applicationRoleId && role.value === 'Score.User' && role.isEnabled)) {
    throw new Error('The existing Score registration has an unexpected application-role configuration. Review it before redeploying.')
  }
  if (!app) {
    app = await graph(credential, '/applications', 'POST', {
      displayName,
      signInAudience: 'AzureADMyOrg',
      tags: [ownershipTag, `azd:${envName}`],
      appRoles: [{
        id: applicationRoleId,
        allowedMemberTypes: ['User'],
        description: 'Sign in to the Score application. Workspace permissions are enforced separately.',
        displayName: 'Score user',
        isEnabled: true,
        value: 'Score.User',
      }],
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
  }
  const principals = await graph(credential, `/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${app.appId}'`)}&$select=id,appId,appRoleAssignmentRequired`)
  if (principals.value.length > 1) throw new Error('Multiple service principals unexpectedly reference this application.')
  let principal = principals.value[0]
  if (!principal) principal = await graph(credential, '/servicePrincipals', 'POST', { appId: app.appId, appRoleAssignmentRequired: true })
  await graph(credential, `/servicePrincipals/${principal.id}`, 'PATCH', { appRoleAssignmentRequired: true })
  const assignments = await graph(credential, `/servicePrincipals/${principal.id}/appRoleAssignedTo`)
  if (!assignments.value.some(assignment => assignment.principalId === allowedUserId && assignment.appRoleId === applicationRoleId)) {
    await graph(credential, `/servicePrincipals/${principal.id}/appRoleAssignedTo`, 'POST', {
      principalId: allowedUserId, resourceId: principal.id, appRoleId: applicationRoleId,
    })
  }
  await ensureSignInConsent(credential, app, principal.id, allowedUserId)
  setEnvironment('AZURE_AUTH_CLIENT_ID', app.appId)
  setEnvironment('AZURE_AUTH_APP_OBJECT_ID', app.id)
  setEnvironment('AZURE_AUTH_SP_OBJECT_ID', principal.id)
  console.log(`Entra registration prepared: ${displayName}. User assignment is required and the configured user has Score.User access.`)
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
  if (mode !== 'prepare' && mode !== 'configure') throw new Error('Usage: node scripts\\azure-auth.mjs prepare|configure [--rotate]')
  const env = environment()
  if (mode === 'prepare') await prepare(env)
  else await configure(env)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Azure authentication setup failed.')
  process.exitCode = 1
})
