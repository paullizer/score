import { setTimeout as delay } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { client, environment, identifier, request, required, setEnvironment } from './azure-common.mjs'

async function configureScheduledWorker(env, credential, { idKey, imageKey, containerName, image, entryPoint, verifyExecution }) {
  const workerId = required(env, idKey)
  const endpoint = `https://management.azure.com${workerId}?api-version=2024-03-01`
  const existing = await request(credential, 'https://management.azure.com', endpoint)
  const containers = existing.properties.template.containers
  if (containers.length !== 1 || containers[0].name !== containerName) {
    throw new Error(`The ${containerName} template has an unexpected container layout.`)
  }
  const identityIds = Object.keys(existing.identity?.userAssignedIdentities ?? {})
  if (identityIds.length !== 1) throw new Error(`The ${containerName} must have exactly its dedicated managed identity.`)
  const container = containers[0]
  if (containerName === 'grade-worker') {
    const settings = new Map(container.env.map(setting => [setting.name, setting.value]))
    if (settings.get('GRADE_RECORDS_CONTAINER') !== 'grade-records' || settings.get('GRADE_SOURCE_CONTAINER') !== 'grade-sources' ||
      settings.has('JOB_RECORDS_CONTAINER') || settings.has('WORKSPACE_BLOB_CONTAINER')) {
      throw new Error('The grade worker must use only its separately provisioned grade stores.')
    }
  }
  await request(credential, 'https://management.azure.com', endpoint, 'PUT', {
    location: existing.location,
    tags: existing.tags,
    identity: { type: 'UserAssigned', userAssignedIdentities: { [identityIds[0]]: {} } },
    properties: {
      environmentId: existing.properties.environmentId,
      workloadProfileName: 'Consumption',
      configuration: {
        registries: existing.properties.configuration.registries,
        replicaTimeout: 900,
        replicaRetryLimit: 0,
        triggerType: 'Schedule',
        scheduleTriggerConfig: { cronExpression: '* * * * *', parallelism: 1, replicaCompletionCount: 1 },
      },
      template: {
        containers: [{
          name: containerName, image, resources: container.resources, env: container.env,
          ...(entryPoint ? { command: ['node'], args: [entryPoint] } : {}),
        }],
      },
    },
  })
  let configured = false
  for (let attempt = 0; attempt < 36; attempt++) {
    const current = await request(credential, 'https://management.azure.com', endpoint)
    if (current.properties.provisioningState === 'Failed') throw new Error(`${containerName} configuration failed in Azure.`)
    if (current.properties.provisioningState === 'Succeeded' && current.properties.template.containers[0].image === image) {
      configured = true
      break
    }
    await delay(5000)
  }
  if (!configured) throw new Error(`The ${containerName} update did not finish.`)
  const execution = await request(credential, 'https://management.azure.com',
    `https://management.azure.com${workerId}/start?api-version=2024-03-01`, 'POST')
  if (verifyExecution) {
    if (!execution?.name) throw new Error(`The ${containerName} did not return an execution identifier.`)
    const executionUrl = `https://management.azure.com${workerId}/executions/${encodeURIComponent(execution.name)}?api-version=2024-03-01`
    let completed = false
    for (let attempt = 0; attempt < 90; attempt++) {
      const current = await request(credential, 'https://management.azure.com', executionUrl)
      const status = current.properties?.status
      if (status === 'Succeeded') { completed = true; break }
      if (['Failed', 'Stopped', 'Cancelled', 'Canceled'].includes(status)) {
        throw new Error(`The ${containerName} initial execution ${execution.name} ended as ${status}. The grade API has not been enabled by this deployment.`)
      }
      await delay(10000)
    }
    if (!completed) throw new Error(`The ${containerName} did not finish its initial execution; grade API enablement was stopped.`)
  }
  setEnvironment(imageKey, image)
  console.log(`${containerName} deployed; processing scheduled every minute. Initial execution: ${execution?.name ?? 'requested'}.`)
}

async function enableGradeFeature(env, credential) {
  const subscription = identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')
  const siteId = `/subscriptions/${subscription}/resourceGroups/${required(env, 'AZURE_RESOURCE_GROUP')}/providers/Microsoft.Web/sites/${required(env, 'AZURE_APP_SERVICE_NAME')}`
  const endpoint = `https://management.azure.com${siteId}/config/appsettings`
  const settings = await request(credential, 'https://management.azure.com', `${endpoint}/list?api-version=2024-11-01`, 'POST')
  if (settings.properties?.GRADE_RECORDS_CONTAINER !== 'grade-records' || settings.properties?.GRADE_SOURCE_CONTAINER !== 'grade-sources') {
    throw new Error('The grade API stores are not provisioned in App Service. Run provisioning before deployment.')
  }
  if (settings.properties.REAL_GRADE_LADDERS_ENABLED !== 'true') {
    await request(credential, 'https://management.azure.com', `${endpoint}?api-version=2024-11-01`, 'PUT', {
      properties: { ...settings.properties, REAL_GRADE_LADDERS_ENABLED: 'true' },
    })
  }
  console.log('The grade worker completed its initial execution; real grade-ladder APIs are enabled.')
}

async function main() {
  const env = environment()
  const mode = process.argv[2]
  if (mode === 'context') {
    const tag = `job-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`
    const relativeImage = `score-worker:${tag}`
    const rendererRelativeImage = `score-renderer:${tag}`
    console.log(JSON.stringify({
      registry: required(env, 'AZURE_CONTAINER_REGISTRY_NAME'),
      subscription: required(env, 'AZURE_SUBSCRIPTION_ID'),
      relativeImage,
      image: `${required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT')}/${relativeImage}`,
      rendererRelativeImage,
      rendererImage: `${required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT')}/${rendererRelativeImage}`,
    }))
    return
  }
  if (mode !== 'configure' && mode !== 'configure-renderer') throw new Error('Usage: node scripts\\azure-worker.mjs context|configure <worker-image> <renderer-image>|configure-renderer <renderer-image>')
  const image = process.argv[3]
  const rendererImage = mode === 'configure-renderer' ? process.argv[3] : process.argv[4]
  const expectedPrefix = `${required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT')}/score-worker:`
  if (mode === 'configure' && (!image?.startsWith(expectedPrefix) || !/^[a-zA-Z0-9_.-]+$/.test(image.slice(expectedPrefix.length)))) {
    throw new Error('The worker image must be a tagged image in the Score registry.')
  }
  const rendererPrefix = `${required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT')}/score-renderer:`
  if (!rendererImage?.startsWith(rendererPrefix) || !/^[a-zA-Z0-9_.-]+$/.test(rendererImage.slice(rendererPrefix.length))) {
    throw new Error('The renderer image must be tagged in the Score registry.')
  }
  if (mode === 'configure') {
    required(env, 'AZURE_GRADE_WORKER_ID')
    execFileSync(process.execPath, [fileURLToPath(new URL('./azure-before-deploy.mjs', import.meta.url))], { stdio: 'inherit' })
  }
  const credential = client(env)
  const rendererEndpoint = `https://management.azure.com${required(env, 'AZURE_JOB_RENDERER_ID')}?api-version=2025-07-01`
  const renderer = await request(credential, 'https://management.azure.com', rendererEndpoint)
  const renderConfiguration = renderer.properties.configuration
  const pullIdentities = Object.keys(renderer.identity?.userAssignedIdentities ?? {})
  if (pullIdentities.length !== 1 || renderConfiguration.ingress.external !== false ||
    !renderConfiguration.identitySettings?.some(setting => setting.identity === pullIdentities[0] && setting.lifecycle === 'None')) {
    throw new Error('Renderer isolation is not active: internal ingress and a runtime-disabled pull-only identity are required.')
  }
  const pullClientId = renderer.identity.userAssignedIdentities[pullIdentities[0]].clientId
  if (typeof pullClientId !== 'string') throw new Error('The registry pull identity client ID is unavailable.')
  await request(credential, 'https://management.azure.com', rendererEndpoint, 'PUT', {
    location: renderer.location,
    tags: renderer.tags,
    identity: { type: 'UserAssigned', userAssignedIdentities: { [pullIdentities[0]]: {} } },
    properties: {
      environmentId: renderer.properties.environmentId,
      workloadProfileName: 'Consumption',
      configuration: {
        activeRevisionsMode: 'Single',
        registries: renderConfiguration.registries,
        identitySettings: [{ identity: pullIdentities[0], lifecycle: 'None' }],
        ingress: {
          external: false, targetPort: 8080, transport: 'auto', allowInsecure: false,
          traffic: [{ latestRevision: true, weight: 100 }],
        },
      },
      template: {
        containers: [{
          name: 'renderer', image: rendererImage, resources: { cpu: 1, memory: '2Gi' },
          env: [
            { name: 'NODE_ENV', value: 'production' }, { name: 'PORT', value: '8080' },
            { name: 'RENDERER_PULL_CLIENT_ID', value: pullClientId },
          ],
        }],
        scale: { minReplicas: 0, maxReplicas: 1, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '1' } } }] },
      },
    },
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await request(credential, 'https://management.azure.com', rendererEndpoint)
    if (current.properties.provisioningState === 'Failed') throw new Error('The isolated renderer failed to deploy.')
    if (current.properties.provisioningState === 'Succeeded' &&
      current.properties.template.containers[0].image === rendererImage &&
      current.properties.latestRevisionName === current.properties.latestReadyRevisionName) {
      setEnvironment('AZURE_JOB_RENDERER_IMAGE', rendererImage)
      break
    }
    if (attempt === 59) throw new Error('The isolated renderer did not finish deploying.')
    await delay(5000)
  }
  if (mode === 'configure-renderer') {
    console.log('The isolated renderer is deployed; the scheduled worker configuration was not changed.')
    return
  }
  await configureScheduledWorker(env, credential, {
    idKey: 'AZURE_JOB_WORKER_ID', imageKey: 'AZURE_WORKER_CONTAINER_IMAGE',
    containerName: 'worker', image,
  })
  await configureScheduledWorker(env, credential, {
    idKey: 'AZURE_GRADE_WORKER_ID', imageKey: 'AZURE_GRADE_WORKER_CONTAINER_IMAGE',
    containerName: 'grade-worker', image, entryPoint: 'dist-worker/grade-worker.mjs', verifyExecution: true,
  })
  await enableGradeFeature(env, credential)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Worker deployment failed.')
  process.exitCode = 1
})
