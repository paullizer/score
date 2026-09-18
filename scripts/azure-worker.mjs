import { setTimeout as delay } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { client, environment, identifier, request, required, setEnvironment } from './azure-common.mjs'

export const WORD_WORKER_CAPABILITY = 'word-document-imports-v1'
export const WORD_WORKER_EXTRACTION_VERSION = 'score-word-extraction-v1'
export const WORD_WORKER_ARTIFACTS = [
  'worker.mjs', 'runtime.mjs', 'grade-worker.mjs', 'grade-runtime.mjs',
  'resume-worker.mjs', 'resume-runtime.mjs', 'analysis-worker.mjs', 'analysis-runtime.mjs', 'word-parser.mjs',
]

export const WORKER_DEFINITIONS = [
  {
    kind: 'job', idKey: 'AZURE_JOB_WORKER_ID', imageKey: 'AZURE_WORKER_CONTAINER_IMAGE',
    containerName: 'worker', entryPoint: 'dist-worker/worker.mjs',
    recordsSetting: 'JOB_RECORDS_CONTAINER', sourcesSetting: 'JOB_SOURCE_CONTAINER',
    records: 'job-records', sources: 'job-sources', maxItemsSetting: 'WORKER_MAX_JOBS', usesExtraction: true,
  },
  {
    kind: 'grade', idKey: 'AZURE_GRADE_WORKER_ID', imageKey: 'AZURE_GRADE_WORKER_CONTAINER_IMAGE',
    containerName: 'grade-worker', entryPoint: 'dist-worker/grade-worker.mjs',
    recordsSetting: 'GRADE_RECORDS_CONTAINER', sourcesSetting: 'GRADE_SOURCE_CONTAINER',
    records: 'grade-records', sources: 'grade-sources', maxItemsSetting: 'GRADE_WORKER_MAX_ITEMS', usesExtraction: true,
    feature: 'REAL_GRADE_LADDERS_ENABLED',
  },
  {
    kind: 'resume', idKey: 'AZURE_RESUME_WORKER_ID', imageKey: 'AZURE_RESUME_WORKER_CONTAINER_IMAGE',
    containerName: 'resume-worker', entryPoint: 'dist-worker/resume-worker.mjs',
    recordsSetting: 'RESUME_RECORDS_CONTAINER', sourcesSetting: 'RESUME_SOURCE_CONTAINER',
    records: 'resume-records', sources: 'resume-sources', maxItemsSetting: 'RESUME_WORKER_MAX_ITEMS', usesExtraction: true,
    feature: 'REAL_RESUME_IMPORTS_ENABLED',
  },
  {
    kind: 'analysis', idKey: 'AZURE_ANALYSIS_WORKER_ID', imageKey: 'AZURE_ANALYSIS_WORKER_CONTAINER_IMAGE',
    containerName: 'analysis-worker', entryPoint: 'dist-worker/analysis-worker.mjs',
    recordsSetting: 'ANALYSIS_RECORDS_CONTAINER', sourcesSetting: 'ANALYSIS_SOURCE_CONTAINER',
    records: 'analysis-records', sources: 'analysis-sources', maxItemsSetting: 'ANALYSIS_WORKER_MAX_ITEMS', usesExtraction: false,
    feature: 'REAL_ANALYSES_ENABLED',
  },
]

export function validateWorkerImage(env, image) {
  const prefix = `${required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT')}/score-worker:resume-analysis-word-v1-`
  if (!image?.startsWith(prefix) || !/^[a-zA-Z0-9_.-]+$/.test(image.slice(prefix.length))) {
    throw new Error('Build a tagged score-worker:resume-analysis-word-v1-* image in the Score registry; older worker images do not provide verified Word support.')
  }
}

export function wordWorkerVerificationArgs(definition) {
  if (!WORKER_DEFINITIONS.includes(definition)) throw new Error('Unknown worker definition.')
  // The manifest is produced by this Dockerfile's packaging check, not inferred from a tag.
  const script = [
    "import { readFileSync } from 'node:fs';",
    "import { createHash } from 'node:crypto';",
    "import { spawn } from 'node:child_process';",
    "const manifest = JSON.parse(readFileSync('dist-worker/word-imports.json', 'utf8'));",
    `const names = ${JSON.stringify(WORD_WORKER_ARTIFACTS)};`,
    `if (manifest.schemaVersion !== 1 || manifest.capability !== ${JSON.stringify(WORD_WORKER_CAPABILITY)} ||`,
    "typeof manifest.artifacts !== 'object' || manifest.artifacts === null ||",
    "Object.keys(manifest.artifacts).length !== names.length) throw new Error('Word worker build readiness check failed.');",
    'for (const name of names) {',
    "const hash = createHash('sha256').update(readFileSync('dist-worker/' + name)).digest('hex');",
    "if (manifest.artifacts[name] !== hash) throw new Error('Word worker artifact verification failed: ' + name);",
    '}',
    "const runtime = await import('./dist-worker/runtime.mjs');",
    `if (runtime.WORD_EXTRACTION_VERSION !== ${JSON.stringify(WORD_WORKER_EXTRACTION_VERSION)})`,
    "throw new Error('The worker extraction runtime does not provide the required Word extraction version.');",
    // A normal child invocation preserves entry-point guards and parser-thread execArgv.
    `const child = spawn(process.execPath, [${JSON.stringify(definition.entryPoint)}], { stdio: 'inherit' });`,
    "for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));",
    'process.exitCode = await new Promise((resolve, reject) => {',
    "child.once('error', reject);",
    "child.once('exit', code => resolve(code ?? 1));",
    '});',
  ].join('\n')
  return ['--input-type=module', '--eval', script]
}

function hasNodeArgs(container, args) {
  return container.command?.length === 1 && container.command[0] === 'node' &&
    JSON.stringify(container.args) === JSON.stringify(args)
}

export function validateWorkerTemplate(env, existing, definition) {
  const { kind, containerName, recordsSetting, sourcesSetting, records, sources, maxItemsSetting, usesExtraction, entryPoint } = definition
  const containers = existing.properties?.template?.containers
  if (containers?.length !== 1 || containers[0].name !== containerName) {
    throw new Error(`The ${containerName} template has an unexpected container layout. Run provisioning before deployment.`)
  }
  const identities = existing.identity?.userAssignedIdentities ?? {}
  const identityIds = Object.keys(identities)
  const identityId = identityIds[0]
  if (existing.identity?.type !== 'UserAssigned' || identityIds.length !== 1 ||
    !identityId.toLowerCase().includes(`/providers/microsoft.managedidentity/userassignedidentities/id-${kind}-worker-`)) {
    throw new Error(`The ${containerName} must have exactly its dedicated managed identity.`)
  }
  const container = containers[0]
  const settings = new Map((container.env ?? []).map(setting => [setting.name, setting.value]))
  const expected = {
    NODE_ENV: 'production',
    AZURE_CLIENT_ID: identities[identityId].clientId,
    AZURE_TENANT_ID: required(env, 'AZURE_TENANT_ID'),
    COSMOS_ENDPOINT: required(env, 'AZURE_COSMOS_ENDPOINT'),
    COSMOS_DATABASE: 'score',
    STORAGE_ACCOUNT_URL: required(env, 'AZURE_STORAGE_ACCOUNT_URL'),
    [recordsSetting]: records,
    [sourcesSetting]: sources,
    RUBRIC_MODEL_ENDPOINT: required(env, 'AZURE_RUBRIC_MODEL_ENDPOINT'),
    RUBRIC_MODEL_DEPLOYMENT: required(env, 'AZURE_RUBRIC_MODEL_DEPLOYMENT'),
    RUBRIC_MODEL_NAME: 'gpt-5-mini',
    RUBRIC_MODEL_REASONING_EFFORT: 'low',
    ...(usesExtraction ? {
      DOCUMENT_INTELLIGENCE_ENDPOINT: required(env, 'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT'),
      JOB_RENDERER_URL: required(env, 'AZURE_JOB_RENDERER_URL'),
    } : {}),
  }
  const allowed = new Set([...Object.keys(expected), maxItemsSetting])
  if (settings.size !== container.env?.length ||
    container.env.some(setting => !allowed.has(setting.name) || typeof setting.value !== 'string' || setting.secretRef) ||
    Object.entries(expected).some(([name, value]) => !value || settings.get(name) !== value)) {
    throw new Error(`The ${containerName} must use only its dedicated ${records}/${sources} stores, identity, and configured processing services.`)
  }
  const maxItems = Number(settings.get(maxItemsSetting))
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) {
    throw new Error(`${maxItemsSetting} must bound each execution to 1-100 items.`)
  }
  const registries = existing.properties.configuration?.registries
  if (registries?.length !== 1 || registries[0].server !== required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT') ||
    typeof registries[0].identity !== 'string' || registries[0].identity.toLowerCase() !== identityId.toLowerCase() ||
    registries[0].username || registries[0].passwordSecretRef) {
    throw new Error(`The ${containerName} must pull from the Score registry using its dedicated identity.`)
  }
  const defaultJobEntry = kind === 'job' && !container.command?.length && !container.args?.length
  const verifyingBuild = existing.properties.configuration.triggerType === 'Manual' &&
    hasNodeArgs(container, wordWorkerVerificationArgs(definition))
  if (!defaultJobEntry && !verifyingBuild && !hasNodeArgs(container, [entryPoint])) {
    throw new Error(`The ${containerName} must use its ${entryPoint} entry point.`)
  }
  return { identityId, container }
}

function validateWordExecution(execution, definition, image, initial = false) {
  const containers = execution.properties?.template?.containers
  const container = containers?.[0]
  if (containers?.length !== 1 || container.name !== definition.containerName || container.image !== image ||
    (!hasNodeArgs(container, wordWorkerVerificationArgs(definition)) &&
      (initial || !hasNodeArgs(container, [definition.entryPoint])))) {
    throw new Error(`The ${definition.containerName} execution is not bound to the verified Word image and entry point; keep Word admission disabled until older executions have finished.`)
  }
}

export function validateRendererTemplate(renderer, workerIdentities = new Set(), workerEnvironments) {
  const configuration = renderer.properties?.configuration
  const identities = renderer.identity?.userAssignedIdentities ?? {}
  const identityIds = Object.keys(identities)
  const identityId = identityIds[0]
  if (identityIds.length !== 1 || configuration?.ingress?.external !== false ||
    !configuration.identitySettings?.some(setting => typeof setting.identity === 'string' &&
      setting.identity.toLowerCase() === identityId.toLowerCase() && setting.lifecycle === 'None')) {
    throw new Error('Renderer isolation is not active: internal ingress and a runtime-disabled pull-only identity are required.')
  }
  if (workerIdentities.has(identityId.toLowerCase()) ||
    (workerEnvironments && (workerEnvironments.size !== 1 || typeof renderer.properties.environmentId !== 'string' ||
      !workerEnvironments.has(renderer.properties.environmentId.toLowerCase())))) {
    throw new Error('Workers must share the internal renderer environment, never its registry-pull identity.')
  }
  const clientId = identities[identityId].clientId
  if (typeof clientId !== 'string') throw new Error('The registry pull identity client ID is unavailable.')
  return { identityId, clientId }
}

export function validateFeatureSettings(settings, definition) {
  if (settings?.[definition.recordsSetting] !== definition.records || settings?.[definition.sourcesSetting] !== definition.sources) {
    throw new Error(`The ${definition.kind} API stores are not provisioned in App Service. Run provisioning before deployment.`)
  }
  const records = ['COSMOS_CONTAINER', ...WORKER_DEFINITIONS.map(worker => worker.recordsSetting)].map(name => settings[name])
  const sources = ['WORKSPACE_BLOB_CONTAINER', ...WORKER_DEFINITIONS.map(worker => worker.sourcesSetting)].map(name => settings[name])
  if (records.some(value => !value) || sources.some(value => !value) ||
    new Set(records).size !== records.length || new Set(sources).size !== sources.length) {
    throw new Error('App Service must have separately provisioned workspace, job, grade, resume, and analysis stores.')
  }
}

export async function configureScheduledWorker(env, credential, definition, image, hooks = {}) {
  const send = hooks.request ?? request
  const wait = hooks.delay ?? delay
  const save = hooks.setEnvironment ?? setEnvironment
  const { idKey, imageKey, containerName, entryPoint } = definition
  validateWorkerImage(env, image)
  const workerId = required(env, idKey)
  const endpoint = `https://management.azure.com${workerId}?api-version=2024-03-01`
  const existing = await send(credential, 'https://management.azure.com', endpoint)
  const { identityId, container } = validateWorkerTemplate(env, existing, definition)
  const payload = {
    location: existing.location,
    tags: existing.tags,
    identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId]: {} } },
    properties: {
      environmentId: existing.properties.environmentId,
      workloadProfileName: 'Consumption',
      configuration: {
        registries: existing.properties.configuration.registries,
        replicaTimeout: 900,
        replicaRetryLimit: 0,
        triggerType: 'Manual',
        manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
      },
      template: {
        containers: [{
          name: containerName, image, resources: container.resources, env: container.env,
          command: ['node'], args: wordWorkerVerificationArgs(definition),
        }],
      },
    },
  }
  async function update() {
    await send(credential, 'https://management.azure.com', endpoint, 'PUT', payload)
    for (let attempt = 0; attempt < 36; attempt++) {
      const current = await send(credential, 'https://management.azure.com', endpoint)
      if (current.properties.provisioningState === 'Failed') throw new Error(`${containerName} configuration failed in Azure.`)
      if (current.properties.provisioningState === 'Succeeded' &&
        current.properties.template.containers[0].image === image &&
        current.properties.configuration.triggerType === payload.properties.configuration.triggerType) {
        validateWorkerTemplate(env, current, definition)
        return
      }
      await wait(5000)
    }
    throw new Error(`The ${containerName} update did not finish.`)
  }
  await update()
  const execution = await send(credential, 'https://management.azure.com',
    `https://management.azure.com${workerId}/start?api-version=2024-03-01`, 'POST')
  if (!execution?.name) throw new Error(`The ${containerName} did not return an execution identifier.`)
  const executionUrl = `https://management.azure.com${workerId}/executions/${encodeURIComponent(execution.name)}?api-version=2024-03-01`
  let completed = false
  for (let attempt = 0; attempt < 90; attempt++) {
    const current = await send(credential, 'https://management.azure.com', executionUrl)
    const status = current.properties?.status
    if (status === 'Succeeded') {
      validateWordExecution(current, definition, image, true)
      completed = true
      break
    }
    if (['Failed', 'Stopped', 'Cancelled', 'Canceled'].includes(status)) {
      throw new Error(`The ${containerName} initial execution ${execution.name} ended as ${status}; its schedule and image pin have not been enabled by this deployment.`)
    }
    await wait(10000)
  }
  if (!completed) throw new Error(`The ${containerName} did not finish its initial execution; feature enablement was stopped.`)
  const { manualTriggerConfig: _manual, ...configuration } = payload.properties.configuration
  payload.properties.configuration = {
    ...configuration, triggerType: 'Schedule',
    scheduleTriggerConfig: { cronExpression: '* * * * *', parallelism: 1, replicaCompletionCount: 1 },
  }
  payload.properties.template.containers[0].args = [entryPoint]
  await update()
  save(imageKey, image)
  console.log(`${containerName} verified and scheduled every minute. Initial execution: ${execution.name}.`)
  return { kind: definition.kind, image, executionName: execution.name }
}

function appSettingsEndpoint(env) {
  const subscription = identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')
  const siteId = `/subscriptions/${subscription}/resourceGroups/${required(env, 'AZURE_RESOURCE_GROUP')}/providers/Microsoft.Web/sites/${required(env, 'AZURE_APP_SERVICE_NAME')}`
  return `https://management.azure.com${siteId}/config/appsettings`
}

async function updateFeatures(env, credential, definitions, enabled, hooks) {
  const send = hooks.request ?? request
  const endpoint = appSettingsEndpoint(env)
  const settings = await send(credential, 'https://management.azure.com', `${endpoint}/list?api-version=2024-11-01`, 'POST')
  const properties = { ...settings.properties }
  for (const definition of definitions) {
    if (enabled) validateFeatureSettings(properties, definition)
    properties[definition.feature] = enabled ? 'true' : 'false'
  }
  if (definitions.some(definition => settings.properties?.[definition.feature] !== properties[definition.feature])) {
    await send(credential, 'https://management.azure.com', `${endpoint}?api-version=2024-11-01`, 'PUT', {
      properties,
    })
  }
  if (enabled) console.log(`${definitions.map(definition => definition.kind).join(', ')} APIs enabled after successful initial worker execution.`)
}

async function updateWordAdmission(env, credential, enabled, hooks) {
  const send = hooks.request ?? request
  const endpoint = appSettingsEndpoint(env)
  const listUrl = `${endpoint}/list?api-version=2024-11-01`
  const settings = await send(credential, 'https://management.azure.com', listUrl, 'POST')
  if (!settings?.properties) throw new Error('App Service settings are unavailable; Word rollout is blocked.')
  const properties = { ...settings.properties }
  if (enabled) {
    for (const definition of WORKER_DEFINITIONS) validateFeatureSettings(properties, definition)
  }
  properties.WORD_DOCUMENT_IMPORTS_ENABLED = enabled ? 'true' : 'false'
  if (settings.properties.WORD_DOCUMENT_IMPORTS_ENABLED !== properties.WORD_DOCUMENT_IMPORTS_ENABLED) {
    await send(credential, 'https://management.azure.com', `${endpoint}?api-version=2024-11-01`, 'PUT', { properties })
  }
  const saved = await send(credential, 'https://management.azure.com', listUrl, 'POST')
  if (saved?.properties?.WORD_DOCUMENT_IMPORTS_ENABLED !== properties.WORD_DOCUMENT_IMPORTS_ENABLED) {
    throw new Error(`App Service did not confirm Word admission ${enabled ? 'enabled' : 'disabled'}; rollout is blocked.`)
  }
}

export async function disableWordAdmission(env, credential, hooks = {}) {
  await updateWordAdmission(env, credential, false, hooks)
}

export async function verifyWordWorkerReadiness(env, credential, image, verified, hooks = {}) {
  const send = hooks.request ?? request
  validateWorkerImage(env, image)
  if (verified.length !== WORKER_DEFINITIONS.length ||
    WORKER_DEFINITIONS.some(definition => verified.filter(result =>
      result.kind === definition.kind && result.image === image && typeof result.executionName === 'string' && result.executionName.length > 0,
    ).length !== 1)) {
    throw new Error('All four workers must pass Word build verification in this deployment before Word admission is enabled.')
  }
  for (const definition of WORKER_DEFINITIONS) {
    const workerBase = `https://management.azure.com${required(env, definition.idKey)}`
    const current = await send(credential, 'https://management.azure.com', `${workerBase}?api-version=2024-03-01`)
    const { container } = validateWorkerTemplate(env, current, definition)
    if (current.properties.provisioningState !== 'Succeeded' ||
      current.properties.configuration.triggerType !== 'Schedule' || container.image !== image ||
      !hasNodeArgs(container, [definition.entryPoint])) {
      throw new Error(`The ${definition.containerName} no longer uses the verified scheduled Word build; Word admission stays disabled.`)
    }
    const result = verified.find(item => item.kind === definition.kind)
    const execution = await send(credential, 'https://management.azure.com',
      `${workerBase}/executions/${encodeURIComponent(result.executionName)}?api-version=2024-03-01`)
    if (execution.properties?.status !== 'Succeeded') throw new Error(`The ${definition.containerName} Word verification is not successful.`)
    validateWordExecution(execution, definition, image, true)

    // Updating a template does not stop a previous image's in-flight execution.
    let next = `${workerBase}/executions?api-version=2024-03-01`
    for (let page = 0; next && page < 100; page++) {
      const executions = await send(credential, 'https://management.azure.com', next)
      if (!Array.isArray(executions?.value)) throw new Error('Worker execution history is unavailable; Word admission stays disabled.')
      for (const active of executions.value) {
        if (!['Succeeded', 'Failed', 'Stopped', 'Cancelled', 'Canceled'].includes(active.properties?.status)) {
          validateWordExecution(active, definition, image)
        }
      }
      next = executions.nextLink
      if (next && (typeof next !== 'string' ||
        new URL(next).origin !== 'https://management.azure.com' ||
        new URL(next).pathname.toLowerCase() !== new URL(`${workerBase}/executions`).pathname.toLowerCase())) {
        throw new Error('Unexpected worker execution continuation; Word admission stays disabled.')
      }
    }
    if (next) throw new Error('Worker execution history exceeded the bounded readiness check; Word admission stays disabled.')
  }
}

function requireProvisionedWorkers(env) {
  for (const definition of WORKER_DEFINITIONS) {
    if (!env[definition.idKey]) {
      throw new Error(`Missing ${definition.idKey}. Run scripts\\deploy.ps1 -ProvisionOnly before deploying; older environments do not have the new stores and worker identities.`)
    }
  }
}

async function validatePrivateServices(env, credential, hooks) {
  const send = hooks.request ?? request
  const subscription = identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')
  const group = required(env, 'AZURE_RESOURCE_GROUP')
  const base = `https://management.azure.com/subscriptions/${subscription}/resourceGroups/${group}/providers`
  const cosmos = `${base}/Microsoft.DocumentDB/databaseAccounts/${required(env, 'AZURE_COSMOS_ACCOUNT_NAME')}`
  const storage = `${base}/Microsoft.Storage/storageAccounts/${required(env, 'AZURE_STORAGE_ACCOUNT_NAME')}`
  for (const definition of WORKER_DEFINITIONS.filter(worker => worker.kind === 'resume' || worker.kind === 'analysis')) {
    const records = await send(credential, 'https://management.azure.com',
      `${cosmos}/sqlDatabases/score/containers/${definition.records}?api-version=2024-11-15`)
    if (records.properties?.resource?.id !== definition.records ||
      JSON.stringify(records.properties.resource.partitionKey?.paths) !== JSON.stringify(['/workspaceId'])) {
      throw new Error(`Provision ${definition.records} with the /workspaceId partition before deploying.`)
    }
    const sources = await send(credential, 'https://management.azure.com',
      `${storage}/blobServices/default/containers/${definition.sources}?api-version=2023-05-01`)
    if (!sources.properties || (sources.properties.publicAccess !== undefined && sources.properties.publicAccess !== 'None')) {
      throw new Error(`Provision ${definition.sources} as a private Blob container before deploying.`)
    }
  }
  const model = await send(credential, 'https://management.azure.com',
    `${base}/Microsoft.CognitiveServices/accounts/${required(env, 'AZURE_AI_ACCOUNT_NAME')}/deployments/${required(env, 'AZURE_RUBRIC_MODEL_DEPLOYMENT')}?api-version=2025-06-01`)
  const extraction = await send(credential, 'https://management.azure.com',
    `${base}/Microsoft.CognitiveServices/accounts/${required(env, 'AZURE_DOCUMENT_INTELLIGENCE_NAME')}?api-version=2025-06-01`)
  if (model.properties?.provisioningState !== 'Succeeded' || extraction.properties?.provisioningState !== 'Succeeded') {
    throw new Error('The existing Foundry model and Document Intelligence services must finish provisioning before deploying workers.')
  }
}

async function configureRenderer(env, credential, rendererImage, workerIdentities, workerEnvironments, hooks) {
  const send = hooks.request ?? request
  const wait = hooks.delay ?? delay
  const save = hooks.setEnvironment ?? setEnvironment
  const rendererEndpoint = `https://management.azure.com${required(env, 'AZURE_JOB_RENDERER_ID')}?api-version=2025-07-01`
  const renderer = await send(credential, 'https://management.azure.com', rendererEndpoint)
  const renderConfiguration = renderer.properties.configuration
  const { identityId: pullIdentityId, clientId: pullClientId } = validateRendererTemplate(
    renderer, workerIdentities, workerEnvironments,
  )
  await send(credential, 'https://management.azure.com', rendererEndpoint, 'PUT', {
    location: renderer.location,
    tags: renderer.tags,
    identity: { type: 'UserAssigned', userAssignedIdentities: { [pullIdentityId]: {} } },
    properties: {
      environmentId: renderer.properties.environmentId,
      workloadProfileName: 'Consumption',
      configuration: {
        activeRevisionsMode: 'Single',
        registries: renderConfiguration.registries,
        identitySettings: [{ identity: pullIdentityId, lifecycle: 'None' }],
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
    const current = await send(credential, 'https://management.azure.com', rendererEndpoint)
    if (current.properties.provisioningState === 'Failed') throw new Error('The isolated renderer failed to deploy.')
    if (current.properties.provisioningState === 'Succeeded' &&
      current.properties.template.containers[0].image === rendererImage &&
      current.properties.latestRevisionName === current.properties.latestReadyRevisionName) {
      save('AZURE_JOB_RENDERER_IMAGE', rendererImage)
      return
    }
    if (attempt === 59) throw new Error('The isolated renderer did not finish deploying.')
    await wait(5000)
  }
}

export async function configureWorkerDeployment(env, credential, { image, rendererImage, rendererOnly = false }, hooks = {}) {
  const send = hooks.request ?? request
  if (!rendererOnly) {
    validateWorkerImage(env, image)
    requireProvisionedWorkers(env)
  }
  const rendererPrefix = `${required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT')}/score-renderer:`
  if (!rendererImage?.startsWith(rendererPrefix) || !/^[a-zA-Z0-9_.-]+$/.test(rendererImage.slice(rendererPrefix.length))) {
    throw new Error('The renderer image must be tagged in the Score registry.')
  }

  // This also covers renderer-only/failed rollouts: no shared consumer changes while Word is admitted.
  await disableWordAdmission(env, credential, hooks)
  try {
    const workerIdentities = new Set()
    const workerEnvironments = new Set()
    if (!rendererOnly) {
      for (const definition of WORKER_DEFINITIONS) {
        const existing = await send(credential, 'https://management.azure.com',
          `https://management.azure.com${required(env, definition.idKey)}?api-version=2024-03-01`)
        const { identityId } = validateWorkerTemplate(env, existing, definition)
        if (workerIdentities.has(identityId.toLowerCase())) throw new Error('Each scheduled worker must have an independent identity.')
        workerIdentities.add(identityId.toLowerCase())
        workerEnvironments.add(existing.properties.environmentId.toLowerCase())
      }
      await validatePrivateServices(env, credential, hooks)
    }
    await configureRenderer(env, credential, rendererImage, workerIdentities, rendererOnly ? undefined : workerEnvironments, hooks)
    if (rendererOnly) {
      console.log('The isolated renderer is deployed; worker configuration is unchanged and Word admission remains disabled.')
      return
    }
    const privateWorkers = WORKER_DEFINITIONS.filter(worker => worker.kind === 'resume' || worker.kind === 'analysis')
    await updateFeatures(env, credential, privateWorkers, false, hooks)
    const verified = []
    for (const definition of WORKER_DEFINITIONS) {
      verified.push(await configureScheduledWorker(env, credential, definition, image, hooks))
      if (definition.feature) await updateFeatures(env, credential, [definition], true, hooks)
    }
    await verifyWordWorkerReadiness(env, credential, image, verified, hooks)
    await updateWordAdmission(env, credential, true, hooks)
    console.log('Word admission enabled after all four workers verified the same Word-capable build and older executions drained.')
  } catch (error) {
    try {
      await updateWordAdmission(env, credential, false, hooks)
    } catch (disableError) {
      throw new AggregateError([error, disableError], 'Worker rollout failed and Word admission could not be confirmed disabled. Check App Service settings before retrying.')
    }
    throw error
  }
}

async function main() {
  const env = environment()
  const mode = process.argv[2]
  if (mode === 'disable-word') {
    if (process.argv[3] === '--if-provisioned' && !env.AZURE_APP_SERVICE_NAME) {
      console.log('No provisioned App Service is recorded; new infrastructure keeps Word admission disabled.')
      return
    }
    if (process.argv[3] && process.argv[3] !== '--if-provisioned') throw new Error('Usage: node scripts\\azure-worker.mjs disable-word [--if-provisioned]')
    await disableWordAdmission(env, client(env))
    console.log('Word admission is disabled before updating shared application and processing consumers.')
    return
  }
  if (mode === 'context') {
    requireProvisionedWorkers(env)
    const tag = `resume-analysis-word-v1-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`
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
  if (mode !== 'configure' && mode !== 'configure-renderer') throw new Error('Usage: node scripts\\azure-worker.mjs context|disable-word [--if-provisioned]|configure <worker-image> <renderer-image>|configure-renderer <renderer-image>')
  const rendererOnly = mode === 'configure-renderer'
  const image = rendererOnly ? undefined : process.argv[3]
  if (!rendererOnly) {
    validateWorkerImage(env, image)
    requireProvisionedWorkers(env)
    execFileSync(process.execPath, [fileURLToPath(new URL('./azure-before-deploy.mjs', import.meta.url))], { stdio: 'inherit' })
  }
  await configureWorkerDeployment(env, client(env), {
    image, rendererImage: rendererOnly ? process.argv[3] : process.argv[4], rendererOnly,
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Worker deployment failed.')
    process.exitCode = 1
  })
}
