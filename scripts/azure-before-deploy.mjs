import { setTimeout as delay } from 'node:timers/promises'
import { client, environment, graph, identifier, request, required } from './azure-common.mjs'
import { admissionStage, validateEasyAuth, validateRuntimeAccessSettings, verifyRoleAwareDeployment } from './azure-access.mjs'
import { verifyEntraProvisioning } from './azure-auth.mjs'
import { verifyAdmissionCode } from './verify-admission.mjs'

async function main() {
  const env = environment()
  const credential = client(env)
  const subscription = identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')
  const stage = admissionStage(env)
  const siteId = `/subscriptions/${subscription}/resourceGroups/${required(env, 'AZURE_RESOURCE_GROUP')}/providers/Microsoft.Web/sites/${required(env, 'AZURE_APP_SERVICE_NAME')}`
  const base = `https://management.azure.com${siteId}`
  const auth = await request(credential, 'https://management.azure.com', `${base}/config/authsettingsV2?api-version=2024-11-01`)
  validateEasyAuth(env, auth.properties)
  const appSettings = await request(credential, 'https://management.azure.com', `${base}/config/appsettings/list?api-version=2024-11-01`, 'POST')
  validateRuntimeAccessSettings(env, appSettings.properties)
  await verifyEntraProvisioning(env, path => graph(credential, path))
  const container = await request(credential, 'https://management.azure.com',
    `https://management.azure.com/subscriptions/${subscription}/resourceGroups/${encodeURIComponent(required(env, 'AZURE_RESOURCE_GROUP'))}/providers/Microsoft.DocumentDB/databaseAccounts/${encodeURIComponent(required(env, 'AZURE_COSMOS_ACCOUNT_NAME'))}/sqlDatabases/score/containers/application-access?api-version=2024-11-15`)
  const partition = container.properties?.resource?.partitionKey?.paths
  if (!Array.isArray(partition) || partition.length !== 1 || partition[0] !== '/tenantId') {
    throw new Error('The dedicated application-access container must be provisioned with /tenantId partitioning.')
  }
  await verifyAdmissionCode()
  if (stage === 'roles') {
    const web = await request(credential, 'https://management.azure.com', `${base}/config/web?api-version=2024-11-01`)
    const image = web.properties?.linuxFxVersion?.replace(/^DOCKER\|/, '')
    if (image !== env.AZURE_SCORE_ROLE_VERIFIED_IMAGE) {
      throw new Error('The released deployment image changed without verification. Verify that deployment or restore the ingress guard before proceeding.')
    }
    await verifyRoleAwareDeployment(env, image)
  }
  for (let attempt = 0; attempt < 25; attempt++) {
    const references = await request(credential, 'https://management.azure.com',
      `${base}/config/configreferences/appsettings?api-version=2024-11-01`)
    const reference = references.value?.find(item =>
      item.name === 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET' ||
      item.id?.endsWith('/MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'))
    if (reference?.properties?.status === 'Resolved') {
      console.log(`Deployment gate passed: ${stage} ingress, assignment-required Entra roles, read-only API Graph consent, tenant-partitioned access storage, and the Key Vault secret are verified.`)
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
