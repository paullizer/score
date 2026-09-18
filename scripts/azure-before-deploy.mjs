import { setTimeout as delay } from 'node:timers/promises'
import { client, environment, identifier, request, required } from './azure-common.mjs'

async function main() {
  const env = environment()
  const credential = client(env)
  const subscription = identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')
  const tenant = identifier(required(env, 'AZURE_TENANT_ID'), 'Tenant')
  const allowedUser = identifier(required(env, 'AZURE_ALLOWED_USER_ID'), 'Allowed user')
  const clientId = identifier(required(env, 'AZURE_AUTH_CLIENT_ID'), 'Application')
  const siteId = `/subscriptions/${subscription}/resourceGroups/${required(env, 'AZURE_RESOURCE_GROUP')}/providers/Microsoft.Web/sites/${required(env, 'AZURE_APP_SERVICE_NAME')}`
  const base = `https://management.azure.com${siteId}`
  const auth = await request(credential, 'https://management.azure.com', `${base}/config/authsettingsV2?api-version=2024-11-01`)
  const settings = auth.properties
  const provider = settings?.identityProviders?.azureActiveDirectory
  const principals = provider?.validation?.defaultAuthorizationPolicy?.allowedPrincipals
  if (settings?.platform?.enabled !== true || settings?.globalValidation?.requireAuthentication !== true ||
    settings?.httpSettings?.requireHttps !== true || provider?.enabled !== true ||
    provider?.registration?.clientId !== clientId ||
    provider?.registration?.openIdIssuer?.replace(/\/$/, '') !== `https://login.microsoftonline.com/${tenant}/v2.0` ||
    provider?.registration?.clientSecretSettingName !== 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET' ||
    principals?.identities?.length !== 1 || principals.identities[0].toLowerCase() !== allowedUser.toLowerCase() ||
    (principals?.groups?.length ?? 0) > 0) {
    throw new Error('Refusing to publish the application: the required tenant-specific Easy Auth/user allowlist configuration is not active.')
  }
  const exclusions = settings.globalValidation.excludedPaths ?? []
  if (exclusions.length !== 1 || exclusions[0] !== '/healthz') {
    throw new Error('Refusing to deploy with unexpected unauthenticated paths. Only /healthz may bypass Easy Auth.')
  }
  for (let attempt = 0; attempt < 25; attempt++) {
    const references = await request(credential, 'https://management.azure.com',
      `${base}/config/configreferences/appsettings?api-version=2024-11-01`)
    const reference = references.value?.find(item =>
      item.name === 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET' ||
      item.id?.endsWith('/MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'))
    if (reference?.properties?.status === 'Resolved') {
      console.log('Deployment gate passed: Easy Auth is required, the intended user is allowed, and the Key Vault authentication secret resolves.')
      return
    }
    if (attempt === 24) throw new Error(`The Easy Auth Key Vault reference is not resolved (${reference?.properties?.status ?? 'missing status'}). Application deployment is blocked.`)
    if (attempt === 0) console.log('Waiting for App Service to resolve the Key Vault authentication reference...')
    await delay(10000)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'The deployment authentication gate failed.')
  process.exitCode = 1
})
