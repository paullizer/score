import { setTimeout as delay } from 'node:timers/promises'
import { client, environment, identifier, request, required, setEnvironment } from './azure-common.mjs'

async function main() {
  const env = environment()
  const credential = client(env)
  const subscription = identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')
  const resourceGroup = required(env, 'AZURE_RESOURCE_GROUP')
  const siteName = required(env, 'AZURE_APP_SERVICE_NAME')
  const siteId = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${siteName}`
  const config = await request(credential, 'https://management.azure.com',
    `https://management.azure.com${siteId}/config/web?api-version=2024-11-01`)
  const image = config.properties?.linuxFxVersion
  if (typeof image !== 'string' || !image.startsWith(`DOCKER|${required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT')}/`)) {
    throw new Error('App Service has not been configured with the image in the Score container registry.')
  }
  setEnvironment('AZURE_CONTAINER_IMAGE', image.slice('DOCKER|'.length))
  const url = required(env, 'AZURE_APP_SERVICE_URL').replace(/\/$/, '')
  for (let attempt = 0; attempt < 60; attempt++) {
    let response
    try { response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(10000) }) } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error
      if (attempt === 59) throw new Error(`The application did not become reachable at ${url}. Inspect its App Service logs.`)
    }
    if (response?.ok) {
      const health = await response.json()
      if (health.status === 'ok' || health.status === 'ready') {
        console.log(`Score is running at ${url}; cloud storage readiness succeeded.`)
        return
      }
    }
    if (attempt === 59) throw new Error(`The deployed application is not ready at ${url}/healthz. Inspect its managed-identity permissions and App Service logs.`)
    if (attempt === 0) console.log('Waiting for the container and managed-identity storage access to become ready...')
    await delay(10000)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Deployment validation failed.')
  process.exitCode = 1
})
