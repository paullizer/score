import { setTimeout as delay } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { client, environment, identifier, request, required, setEnvironment } from './azure-common.mjs'

export const WORD_WORKER_CAPABILITY = 'word-document-imports-v1'
export const WORD_WORKER_EXTRACTION_VERSION = 'score-word-extraction-v1'
export const RUNTIME_SETTINGS_VERSION = 'score-runtime-settings-v1'
export const SETTINGS_WORKER_RUNTIMES = ['runtime.mjs', 'grade-runtime.mjs', 'resume-runtime.mjs', 'analysis-runtime.mjs']
export const WORD_WORKER_ARTIFACTS = [
  'worker.mjs', 'runtime.mjs', 'grade-worker.mjs', 'grade-runtime.mjs',
  'resume-worker.mjs', 'resume-runtime.mjs', 'analysis-worker.mjs', 'analysis-runtime.mjs', 'word-parser.mjs',
]
const TERMINAL_EXECUTION_STATUSES = new Set(['Succeeded', 'Failed', 'Stopped', 'Cancelled', 'Canceled'])

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

const ANALYSIS_WORKER = WORKER_DEFINITIONS.find(worker => worker.kind === 'analysis')

function analysisCorrectionEnvironment(container, enabled) {
  const name = 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED'
  return [...container.env.filter(setting => setting.name !== name), { name, value: enabled ? 'true' : 'false' }]
}

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
    `if (manifest.runtimeSettingsVersion !== ${JSON.stringify(RUNTIME_SETTINGS_VERSION)})`,
    "throw new Error('The worker manifest does not certify runtime settings support.');",
    `for (const name of ${JSON.stringify(SETTINGS_WORKER_RUNTIMES)}) {`,
    "const reader = await import('./dist-worker/' + name);",
    `if (reader.RUNTIME_SETTINGS_VERSION !== ${JSON.stringify(RUNTIME_SETTINGS_VERSION)})`,
    "throw new Error('The worker does not provide the required runtime settings reader: ' + name);",
    '}',
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
    SCORE_SETTINGS_CONTAINER: 'application-settings',
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
  const allowed = new Set([...Object.keys(expected), maxItemsSetting,
    ...(kind === 'analysis' ? ['ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED'] : [])])
  if (settings.size !== container.env?.length ||
    container.env.some(setting => !allowed.has(setting.name) || typeof setting.value !== 'string' || setting.secretRef) ||
    Object.entries(expected).some(([name, value]) => !value || settings.get(name) !== value)) {
    throw new Error(`The ${containerName} must use only its dedicated ${records}/${sources} stores, identity, and configured processing services.`)
  }
  if (settings.has('ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED') &&
    !['false', 'true'].includes(settings.get('ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED'))) {
    throw new Error('ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED must be explicitly true or false.')
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
  if (initial && definition.kind === 'analysis' &&
    container.env?.find(setting => setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED')?.value !== 'false') {
    throw new Error('The analysis-worker initial execution must keep evidence correction claims disabled until reader verification completes.')
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
          name: containerName, image, resources: container.resources,
          env: definition.kind === 'analysis' ? analysisCorrectionEnvironment(container, false) : container.env,
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
        current.properties.configuration.triggerType === payload.properties.configuration.triggerType &&
        (definition.kind !== 'analysis' || current.properties.template.containers[0].env?.find(setting =>
          setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED')?.value === 'false')) {
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

async function updateRuntimeSettingsAdmission(env, credential, enabled, hooks, verifiedImage) {
  const send = hooks.request ?? request
  const endpoint = appSettingsEndpoint(env)
  const listUrl = `${endpoint}/list?api-version=2024-11-01`
  const settings = await send(credential, 'https://management.azure.com', listUrl, 'POST')
  if (!settings?.properties) throw new Error('App Service settings are unavailable; runtime settings activation is blocked.')
  if (enabled && (settings.properties.SCORE_SETTINGS_CONTAINER !== 'application-settings' || !verifiedImage)) {
    throw new Error('Runtime settings require the isolated settings store and four verified worker readers.')
  }
  const properties = {
    ...settings.properties,
    SCORE_RUNTIME_SETTINGS_ENABLED: enabled ? 'true' : 'false',
    SCORE_RUNTIME_SETTINGS_WORKER_VERSION: enabled ? RUNTIME_SETTINGS_VERSION : '',
    SCORE_RUNTIME_SETTINGS_VERIFIED_IMAGE: enabled ? verifiedImage : '',
    SCORE_RUNTIME_SETTINGS_VERIFIED_AT: enabled ? new Date().toISOString() : '',
  }
  if (Object.keys(properties).some(key => settings.properties[key] !== properties[key])) {
    await send(credential, 'https://management.azure.com', `${endpoint}?api-version=2024-11-01`, 'PUT', { properties })
  }
  const saved = await send(credential, 'https://management.azure.com', listUrl, 'POST')
  for (const name of ['SCORE_RUNTIME_SETTINGS_ENABLED', 'SCORE_RUNTIME_SETTINGS_WORKER_VERSION', 'SCORE_RUNTIME_SETTINGS_VERIFIED_IMAGE', 'SCORE_RUNTIME_SETTINGS_VERIFIED_AT']) {
    if (saved?.properties?.[name] !== properties[name]) {
      throw new Error(`App Service did not confirm runtime settings ${enabled ? 'enabled' : 'disabled'}; rollout is blocked.`)
    }
  }
}

export async function disableRuntimeSettingsAdmission(env, credential, hooks = {}) {
  await updateRuntimeSettingsAdmission(env, credential, false, hooks)
}

async function updateEvidenceCorrectionAdmission(env, credential, enabled, hooks, force = false) {
  const send = hooks.request ?? request
  const endpoint = appSettingsEndpoint(env)
  const listUrl = `${endpoint}/list?api-version=2024-11-01`
  const settings = await send(credential, 'https://management.azure.com', listUrl, 'POST')
  if (!settings?.properties) throw new Error('App Service settings are unavailable; evidence correction rollout is blocked.')
  if (enabled) {
    validateFeatureSettings(settings.properties, ANALYSIS_WORKER)
    if (settings.properties.REAL_ANALYSES_ENABLED !== 'true' ||
      settings.properties.SCORE_SETTINGS_CONTAINER !== 'application-settings' ||
      settings.properties.SCORE_RUNTIME_SETTINGS_ENABLED !== 'false') {
      throw new Error('Evidence correction activation requires the configured analysis API and paused runtime-settings admission.')
    }
  }
  const properties = { ...settings.properties, ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED: enabled ? 'true' : 'false' }
  if (force || settings.properties.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED !== properties.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED) {
    await send(credential, 'https://management.azure.com', `${endpoint}?api-version=2024-11-01`, 'PUT', { properties })
  }
  const saved = await send(credential, 'https://management.azure.com', listUrl, 'POST')
  if (saved?.properties?.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED !== properties.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED) {
    throw new Error(`App Service did not confirm evidence correction admission ${enabled ? 'enabled' : 'disabled'}; rollout is blocked.`)
  }
}

export async function disableEvidenceCorrectionAdmission(env, credential, hooks = {}) {
  await updateEvidenceCorrectionAdmission(env, credential, false, hooks)
}

async function updateEvidenceCorrectionClaims(env, credential, enabled, hooks, { verifiedImage, force = false } = {}) {
  const send = hooks.request ?? request
  const wait = hooks.delay ?? delay
  const endpoint = `https://management.azure.com${required(env, ANALYSIS_WORKER.idKey)}?api-version=2024-03-01`
  const existing = await send(credential, 'https://management.azure.com', endpoint)
  const { identityId, container } = validateWorkerTemplate(env, existing, ANALYSIS_WORKER)
  if (enabled && (existing.properties.provisioningState !== 'Succeeded' ||
    existing.properties.configuration.triggerType !== 'Schedule' || container.image !== verifiedImage ||
    !hasNodeArgs(container, [ANALYSIS_WORKER.entryPoint]))) {
    throw new Error('The analysis worker no longer uses the verified scheduled build; evidence corrections remain disabled.')
  }
  const template = {
    ...existing.properties.template,
    containers: [{ ...container, env: analysisCorrectionEnvironment(container, enabled) }],
  }
  if (force || !isDeepStrictEqual(existing.properties.template, template)) {
    await send(credential, 'https://management.azure.com', endpoint, 'PUT', {
      location: existing.location, tags: existing.tags,
      identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId]: {} } },
      properties: {
        environmentId: existing.properties.environmentId,
        ...(existing.properties.workloadProfileName ? { workloadProfileName: existing.properties.workloadProfileName } : {}),
        configuration: existing.properties.configuration,
        template,
      },
    })
  }
  for (let attempt = 0; attempt < 36; attempt++) {
    const current = await send(credential, 'https://management.azure.com', endpoint)
    if (current.properties?.provisioningState === 'Failed') throw new Error('Analysis-worker evidence correction configuration failed in Azure.')
    if (current.properties?.provisioningState === 'Succeeded') {
      const { identityId: currentIdentityId } = validateWorkerTemplate(env, current, ANALYSIS_WORKER)
      if (currentIdentityId.toLowerCase() === identityId.toLowerCase() &&
        current.properties.environmentId?.toLowerCase() === existing.properties.environmentId?.toLowerCase() &&
        current.properties.workloadProfileName === existing.properties.workloadProfileName &&
        isDeepStrictEqual(current.properties.configuration, existing.properties.configuration) &&
        isDeepStrictEqual(current.properties.template, template)) return
    }
    await wait(5000)
  }
  throw new Error(`The analysis worker did not confirm evidence correction claims ${enabled ? 'enabled' : 'disabled'}; rollout is blocked.`)
}

async function visitActiveWorkerExecutions(credential, workerBase, send, visit) {
  let next = `${workerBase}/executions?api-version=2024-03-01`
  for (let page = 0; next && page < 100; page++) {
    const executions = await send(credential, 'https://management.azure.com', next)
    if (!Array.isArray(executions?.value)) throw new Error('Worker execution history is unavailable; rollout is blocked.')
    for (const execution of executions.value) {
      if (!TERMINAL_EXECUTION_STATUSES.has(execution?.properties?.status)) visit(execution)
    }
    next = executions.nextLink
    if (next) {
      if (typeof next !== 'string' || !URL.canParse(next)) throw new Error('Unexpected worker execution continuation; rollout is blocked.')
      const continuation = new URL(next)
      if (continuation.origin !== 'https://management.azure.com' || continuation.username || continuation.password ||
        continuation.hash || continuation.pathname.toLowerCase() !== new URL(`${workerBase}/executions`).pathname.toLowerCase()) {
        throw new Error('Unexpected worker execution continuation; rollout is blocked.')
      }
    }
  }
  if (next) throw new Error('Worker execution history exceeded the bounded readiness check; rollout is blocked.')
}

export async function prepareWebDeployment(env, credential, hooks = {}) {
  requireProvisionedWorkers(env)
  const send = hooks.request ?? request
  const wait = hooks.delay ?? delay
  await disableWordAdmission(env, credential, hooks)
  await disableRuntimeSettingsAdmission(env, credential, hooks)
  await disableEvidenceCorrectionAdmission(env, credential, hooks)
  const workers = []
  for (const definition of WORKER_DEFINITIONS) {
    const workerBase = `https://management.azure.com${required(env, definition.idKey)}`
    const endpoint = `${workerBase}?api-version=2024-03-01`
    const existing = await send(credential, 'https://management.azure.com', endpoint)
    const { identityId } = validateWorkerTemplate(env, existing, definition)
    if (existing.properties.provisioningState !== 'Succeeded' ||
      !['Manual', 'Schedule'].includes(existing.properties.configuration.triggerType)) {
      throw new Error(`The ${definition.containerName} is not ready to pause; web deployment is blocked.`)
    }
    workers.push({ definition, workerBase, endpoint, existing, identityId })
  }
  function verifyPaused(worker, current) {
    const { identityId } = validateWorkerTemplate(env, current, worker.definition)
    if (current.properties.provisioningState !== 'Succeeded' ||
      current.properties.configuration.triggerType !== 'Manual' ||
      identityId.toLowerCase() !== worker.identityId.toLowerCase() ||
      current.properties.environmentId?.toLowerCase() !== worker.existing.properties.environmentId?.toLowerCase() ||
      !isDeepStrictEqual(current.properties.template, worker.existing.properties.template)) {
      throw new Error(`The ${worker.definition.containerName} pause or unchanged reader template could not be verified; web deployment is blocked.`)
    }
  }
  for (const worker of workers) {
    const { existing, identityId, endpoint, definition } = worker
    if (existing.properties.configuration.triggerType === 'Manual') continue
    const { scheduleTriggerConfig: _schedule, eventTriggerConfig: _event, ...configuration } = existing.properties.configuration
    await send(credential, 'https://management.azure.com', endpoint, 'PUT', {
      location: existing.location, tags: existing.tags,
      identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId]: {} } },
      properties: {
        environmentId: existing.properties.environmentId,
        ...(existing.properties.workloadProfileName ? { workloadProfileName: existing.properties.workloadProfileName } : {}),
        configuration: { ...configuration, triggerType: 'Manual', manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 } },
        template: existing.properties.template,
      },
    })
    let paused = false
    for (let attempt = 0; attempt < 36; attempt++) {
      const current = await send(credential, 'https://management.azure.com', endpoint)
      if (current.properties?.provisioningState === 'Failed') throw new Error(`The ${definition.containerName} pause failed; web deployment is blocked.`)
      if (current.properties?.provisioningState === 'Succeeded') {
        verifyPaused(worker, current)
        paused = true
        break
      }
      await wait(5000)
    }
    if (!paused) throw new Error(`The ${definition.containerName} pause did not finish; web deployment is blocked.`)
  }
  // Legacy retries can add reader fields even while admission is closed.
  for (const worker of workers) {
    await visitActiveWorkerExecutions(credential, worker.workerBase, send, execution => {
      throw new Error(`The ${worker.definition.containerName} still has an execution with status ${execution?.properties?.status ?? 'unknown'}. Let it finish, then retry web deployment; no execution was cancelled.`)
    })
  }
  for (const worker of workers) {
    verifyPaused(worker, await send(credential, 'https://management.azure.com', worker.endpoint))
  }
  console.log('All four worker schedules are paused and executions drained before replacing the API; verified worker rollout must restore processing.')
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
    await visitActiveWorkerExecutions(credential, workerBase, send, active => validateWordExecution(active, definition, image))
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
  const settings = await send(credential, 'https://management.azure.com',
    `${cosmos}/sqlDatabases/score/containers/application-settings?api-version=2024-11-15`)
  if (settings.properties?.resource?.id !== 'application-settings' ||
    JSON.stringify(settings.properties.resource.partitionKey?.paths) !== JSON.stringify(['/applicationId'])) {
    throw new Error('Provision application-settings with the /applicationId partition before deploying workers.')
  }
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

  // Admission stays closed through renderer-only and failed rollouts as well.
  await disableWordAdmission(env, credential, hooks)
  await disableRuntimeSettingsAdmission(env, credential, hooks)
  await disableEvidenceCorrectionAdmission(env, credential, hooks)
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
      console.log('The isolated renderer is deployed; worker configuration is unchanged and Word/runtime-settings/evidence-correction admission remains disabled.')
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
    await updateEvidenceCorrectionClaims(env, credential, true, hooks, { verifiedImage: image })
    await updateEvidenceCorrectionAdmission(env, credential, true, hooks)
    await updateRuntimeSettingsAdmission(env, credential, true, hooks, image)
    await updateWordAdmission(env, credential, true, hooks)
    console.log('Word, runtime-settings, and evidence-correction admission enabled after all four worker readers verified the same build and older executions drained.')
  } catch (error) {
    const failures = [error]
    // A stale read after ambiguous activation must not suppress the closing write.
    for (const disable of [
      () => updateEvidenceCorrectionAdmission(env, credential, false, hooks, true),
      () => disableRuntimeSettingsAdmission(env, credential, hooks),
      () => disableWordAdmission(env, credential, hooks),
      ...(!rendererOnly ? [() => updateEvidenceCorrectionClaims(env, credential, false, hooks, { force: true })] : []),
    ]) {
      try {
        await disable()
      } catch (disableError) {
        failures.push(disableError)
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Worker rollout failed and admission or correction-claim gates could not be confirmed disabled. Check App Service and analysis-worker settings before retrying.')
    }
    throw error
  }
}

async function main() {
  const env = environment()
  const mode = process.argv[2]
  if (mode === 'prepare-web-deploy') {
    if (process.argv[3]) throw new Error('Usage: node scripts\\azure-worker.mjs prepare-web-deploy')
    await prepareWebDeployment(env, client(env))
    return
  }
  if (mode === 'disable-word' || mode === 'disable-admission') {
    if (process.argv[3] === '--if-provisioned' && !env.AZURE_APP_SERVICE_NAME) {
      console.log('No provisioned App Service is recorded; new infrastructure keeps admission gates disabled.')
      return
    }
    if (process.argv[3] && process.argv[3] !== '--if-provisioned') throw new Error('Usage: node scripts\\azure-worker.mjs disable-admission [--if-provisioned]')
    await disableWordAdmission(env, client(env))
    if (mode === 'disable-admission') {
      await disableRuntimeSettingsAdmission(env, client(env))
      await disableEvidenceCorrectionAdmission(env, client(env))
    }
    console.log('Requested admission gates are disabled before updating shared application and processing consumers.')
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
  if (mode !== 'configure' && mode !== 'configure-renderer') throw new Error('Usage: node scripts\\azure-worker.mjs context|prepare-web-deploy|disable-admission [--if-provisioned]|configure <worker-image> <renderer-image>|configure-renderer <renderer-image>')
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
