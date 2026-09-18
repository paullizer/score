import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  WORKER_DEFINITIONS, configureScheduledWorker, validateFeatureSettings, validateWorkerImage, validateWorkerTemplate,
} from '../scripts/azure-worker.mjs'

const group = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/score-test'
const env = {
  AZURE_TENANT_ID: '00000000-0000-4000-8000-000000000002',
  AZURE_CONTAINER_REGISTRY_ENDPOINT: 'scoretest.azurecr.io',
  AZURE_COSMOS_ENDPOINT: 'https://cosmos.example.com:443/',
  AZURE_STORAGE_ACCOUNT_URL: 'https://storage.example.com/',
  AZURE_RUBRIC_MODEL_ENDPOINT: 'https://foundry.example.com',
  AZURE_RUBRIC_MODEL_DEPLOYMENT: 'job-rubric',
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://ocr.example.com',
  AZURE_JOB_RENDERER_URL: 'https://renderer.internal.example.com',
  ...Object.fromEntries(WORKER_DEFINITIONS.map(worker => [worker.idKey, `${group}/providers/Microsoft.App/jobs/${worker.kind}`])),
}
const image = `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-worker:resume-analysis-20260918000000`

function template(definition) {
  const identityId = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-${definition.kind}-worker-test`
  const settings = {
    NODE_ENV: 'production', AZURE_CLIENT_ID: `${definition.kind}-client`, AZURE_TENANT_ID: env.AZURE_TENANT_ID,
    COSMOS_ENDPOINT: env.AZURE_COSMOS_ENDPOINT, COSMOS_DATABASE: 'score',
    STORAGE_ACCOUNT_URL: env.AZURE_STORAGE_ACCOUNT_URL,
    [definition.recordsSetting]: definition.records, [definition.sourcesSetting]: definition.sources,
    RUBRIC_MODEL_ENDPOINT: env.AZURE_RUBRIC_MODEL_ENDPOINT, RUBRIC_MODEL_DEPLOYMENT: env.AZURE_RUBRIC_MODEL_DEPLOYMENT,
    RUBRIC_MODEL_NAME: 'gpt-5-mini', RUBRIC_MODEL_REASONING_EFFORT: 'low',
    [definition.maxItemsSetting]: definition.kind === 'analysis' ? '2' : '5',
    ...(definition.usesExtraction ? {
      DOCUMENT_INTELLIGENCE_ENDPOINT: env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
      JOB_RENDERER_URL: env.AZURE_JOB_RENDERER_URL,
    } : {}),
  }
  return {
    id: env[definition.idKey], location: 'northcentralus', tags: {},
    identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId]: { clientId: settings.AZURE_CLIENT_ID } } },
    properties: {
      provisioningState: 'Succeeded', environmentId: `${group}/providers/Microsoft.App/managedEnvironments/workers`,
      configuration: {
        triggerType: 'Manual',
        registries: [{ server: env.AZURE_CONTAINER_REGISTRY_ENDPOINT, identity: identityId }],
      },
      template: { containers: [{
        name: definition.containerName, image: 'mcr.microsoft.com/k8se/quickstart-jobs:latest',
        command: ['node'], args: [definition.entryPoint], resources: { cpu: 1, memory: '2Gi' },
        env: Object.entries(settings).map(([name, value]) => ({ name, value })),
      }] },
    },
  }
}

function appSettings() {
  return {
    COSMOS_CONTAINER: 'workspaces', WORKSPACE_BLOB_CONTAINER: 'workspace-state',
    REAL_JOB_IMPORTS_ENABLED: 'true', REAL_GRADE_LADDERS_ENABLED: 'false', REAL_RESUME_IMPORTS_ENABLED: 'true',
    ...Object.fromEntries(WORKER_DEFINITIONS.flatMap(worker => [
      [worker.recordsSetting, worker.records], [worker.sourcesSetting, worker.sources],
    ])),
  }
}

test('deployment accepts only the new shared entry-point image family in the deployment registry', () => {
  validateWorkerImage(env, image)
  for (const invalid of [
    undefined, 'mcr.microsoft.com/k8se/quickstart-jobs:latest',
    `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-worker:job-old`,
    'other.azurecr.io/score-worker:resume-analysis-20260918',
    `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-worker:resume-analysis-`,
    `${image}/unexpected`,
  ]) assert.throws(() => validateWorkerImage(env, invalid), /older worker images/)
})

test('each worker keeps its own identity, entry point, stores, registry, and processing services', () => {
  for (const definition of WORKER_DEFINITIONS) validateWorkerTemplate(env, template(definition), definition)
  for (const definition of WORKER_DEFINITIONS.filter(worker => worker.kind === 'resume' || worker.kind === 'analysis')) {
    const changes = [
      value => { value.identity.type = 'SystemAssigned, UserAssigned' },
      value => { value.identity.userAssignedIdentities = { [`${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-job-worker-test`]: { clientId: 'job-client' } } },
      value => { value.properties.template.containers[0].args = ['dist-worker/worker.mjs'] },
      value => { value.properties.configuration.registries[0].server = 'other.azurecr.io' },
      value => { value.properties.configuration.registries[0].identity = 'another-identity' },
      value => { value.properties.template.containers[0].env.find(setting => setting.name === definition.recordsSetting).value = 'job-records' },
      value => { value.properties.template.containers[0].env.find(setting => setting.name === definition.sourcesSetting).value = 'workspace-state' },
      value => { value.properties.template.containers[0].env.find(setting => setting.name === 'AZURE_CLIENT_ID').value = 'app-client' },
      value => { value.properties.template.containers[0].env.find(setting => setting.name === definition.maxItemsSetting).value = '0' },
      value => { value.properties.template.containers[0].env.push({ name: 'JOB_RECORDS_CONTAINER', value: 'job-records' }) },
      value => { value.properties.template.containers[0].env.push({ name: 'WORKSPACE_BLOB_CONTAINER', value: 'workspace-state' }) },
      value => { value.properties.template.containers[0].env.push({ name: 'AZURE_AI_SEARCH_ENDPOINT', value: 'https://search.example.com' }) },
      value => { value.properties.template.containers[0].env.push({ name: 'AZURE_CLIENT_SECRET', secretRef: 'secret' }) },
    ]
    if (definition.kind === 'analysis') {
      for (const name of ['RESUME_RECORDS_CONTAINER', 'DOCUMENT_INTELLIGENCE_ENDPOINT', 'JOB_RENDERER_URL']) {
        changes.push(value => { value.properties.template.containers[0].env.push({ name, value: 'not-permitted' }) })
      }
    }
    for (const change of changes) {
      const value = template(definition)
      change(value)
      assert.throws(() => validateWorkerTemplate(env, value, definition))
    }
  }
})

test('API enablement requires separate provisioned stores but not enabled mutable input services', () => {
  const resume = WORKER_DEFINITIONS.find(worker => worker.kind === 'resume')
  const analysis = WORKER_DEFINITIONS.find(worker => worker.kind === 'analysis')
  validateFeatureSettings(appSettings(), resume)
  validateFeatureSettings(appSettings(), analysis)
  assert.throws(() => validateFeatureSettings({ ...appSettings(), RESUME_RECORDS_CONTAINER: undefined }, resume), /provision/)
  assert.throws(() => validateFeatureSettings({ ...appSettings(), GRADE_SOURCE_CONTAINER: 'resume-sources' }, resume), /separately/)
  assert.throws(() => validateFeatureSettings({ ...appSettings(), ANALYSIS_RECORDS_CONTAINER: undefined }, analysis), /provision/)
  validateFeatureSettings({
    ...appSettings(), REAL_RESUME_IMPORTS_ENABLED: 'false',
    REAL_JOB_IMPORTS_ENABLED: 'false', REAL_GRADE_LADDERS_ENABLED: 'false',
  }, analysis)
  validateFeatureSettings({ ...appSettings(), REAL_JOB_IMPORTS_ENABLED: 'false', REAL_GRADE_LADDERS_ENABLED: 'true' }, analysis)
})

function deploymentHarness(definition, status = 'Succeeded') {
  let current = template(definition)
  const identity = current.identity
  const operations = []
  return {
    operations,
    hooks: {
      delay: async () => {},
      setEnvironment: (key, value) => { operations.push({ action: 'pin', key, value }) },
      request: async (_credential, _audience, url, method = 'GET', body) => {
        if (method === 'PUT') {
          operations.push({ action: body.properties.configuration.triggerType, payload: structuredClone(body) })
          current = { ...structuredClone(body), identity, properties: { ...structuredClone(body.properties), provisioningState: 'Succeeded' } }
          return current
        }
        if (url.includes('/start?')) { operations.push({ action: 'start' }); return { name: 'initial-test' } }
        if (url.includes('/executions/')) { operations.push({ action: status }); return { properties: { status } } }
        return structuredClone(current)
      },
    },
  }
}

test('each new worker remains manual until successful execution, then schedules and saves only its own pin', async () => {
  for (const definition of WORKER_DEFINITIONS.filter(worker => worker.kind === 'resume' || worker.kind === 'analysis')) {
    const { hooks, operations } = deploymentHarness(definition)
    await configureScheduledWorker(env, {}, definition, image, hooks)
    assert.deepEqual(operations.map(operation => operation.action), ['Manual', 'start', 'Succeeded', 'Schedule', 'pin'])
    assert.equal(operations.at(-1).key, definition.imageKey)
    assert.equal(operations.at(-1).value, image)
    const payload = operations.find(operation => operation.action === 'Schedule').payload
    assert.equal(payload.properties.configuration.replicaTimeout, 900)
    assert.equal(payload.properties.configuration.replicaRetryLimit, 0)
    assert.equal(payload.properties.configuration.manualTriggerConfig, undefined)
    assert.equal(payload.properties.configuration.scheduleTriggerConfig.parallelism, 1)
    assert.deepEqual(payload.properties.template.containers[0].args, [definition.entryPoint])
  }
})

test('failed initial execution never schedules or saves an unverified image pin', async () => {
  for (const definition of WORKER_DEFINITIONS.filter(worker => worker.kind === 'resume' || worker.kind === 'analysis')) {
    const { hooks, operations } = deploymentHarness(definition, 'Failed')
    await assert.rejects(configureScheduledWorker(env, {}, definition, image, hooks), /initial execution.*Failed/)
    assert.deepEqual(operations.map(operation => operation.action), ['Manual', 'start', 'Failed'])
  }
})

test('initial execution timeout is bounded and never publishes a schedule or image pin', async () => {
  const definition = WORKER_DEFINITIONS.find(worker => worker.kind === 'analysis')
  const { hooks, operations } = deploymentHarness(definition, 'Running')
  await assert.rejects(configureScheduledWorker(env, {}, definition, image, hooks), /did not finish its initial execution/)
  assert.equal(operations.filter(operation => operation.action === 'Running').length, 90)
  assert.ok(operations.every(operation => !['Schedule', 'pin'].includes(operation.action)))
})

test('infrastructure composes private stores and identities without new model/search or legacy access', () => {
  const module = readFileSync(new URL('../infra/private-processing.bicep', import.meta.url), 'utf8')
  const resources = readFileSync(new URL('../infra/resources.bicep', import.meta.url), 'utf8')
  const parameters = JSON.parse(readFileSync(new URL('../infra/main.parameters.json', import.meta.url), 'utf8')).parameters
  assert.match(module, /@allowed\(\['resume', 'analysis'\]\)/)
  assert.match(module, /paths: \['\/workspaceId'\]/)
  assert.match(module, /publicAccess: 'None'/)
  assert.ok(module.includes("scope: '${cosmos.id}/dbs/score/colls/${recordContainer}'"))
  assert.match(module, /resource sourceAccess[\s\S]*?scope: sources/)
  assert.match(module, /name: 'id-\$\{kind\}-worker-\$\{token\}'/)
  assert.match(module, /resource extractionAccess[^\n]* = if \(isResume\)/)
  assert.match(module, /triggerType: deployed \? 'Schedule' : 'Manual'/)
  assert.match(module, /score-worker:resume-analysis-/)
  assert.ok(module.includes("args: ['dist-worker/${kind}-worker.mjs']"))
  assert.match(module, /isResume \? \[[\s\S]*?DOCUMENT_INTELLIGENCE_ENDPOINT[\s\S]*?JOB_RENDERER_URL[\s\S]*?\] : \[\]/)
  assert.doesNotMatch(module, /(?:JOB|GRADE|WORKSPACE)_(?:RECORDS|SOURCE|BLOB)_CONTAINER/)
  assert.doesNotMatch(module, /Microsoft\.Search|Microsoft\.CognitiveServices\/accounts\/deployments/)
  for (const [kind, stem] of [['resume', 'resumes'], ['analysis', 'analyses']]) {
    assert.equal(parameters[`${kind}WorkerImage`].value, `\${AZURE_${kind.toUpperCase()}_WORKER_CONTAINER_IMAGE}`)
    assert.match(resources, new RegExp(`module ${stem} 'private-processing.bicep'`))
    assert.ok(resources.includes(`workerImage: ${kind}WorkerImage`))
  }
  assert.match(resources, /REAL_RESUME_IMPORTS_ENABLED: resumes\.outputs\.isDeployed \? 'true' : 'false'/)
  assert.match(resources, /REAL_ANALYSES_ENABLED: analyses\.outputs\.isDeployed \? 'true' : 'false'/)
})

test('worker build and shared container packaging include both new entry points and runtime bundles', () => {
  const build = readFileSync(new URL('../scripts/build-worker.mjs', import.meta.url), 'utf8')
  const docker = readFileSync(new URL('../Dockerfile.worker', import.meta.url), 'utf8')
  const provision = readFileSync(new URL('../scripts/deploy.ps1', import.meta.url), 'utf8')
  for (const [source, output] of [
    ['worker/resume-index.ts', 'resume-worker'], ['worker/resumes/runtime.ts', 'resume-runtime'],
    ['worker/analysis-index.ts', 'analysis-worker'], ['worker/analyses/runtime.ts', 'analysis-runtime'],
  ]) {
    assert.ok(build.includes(`['${source}', 'dist-worker/${output}.mjs']`))
    assert.ok(docker.includes(`'${output}'`))
  }
  for (const kind of ['RESUME', 'ANALYSIS']) {
    assert.ok(provision.includes(`Set-EnvironmentValue 'AZURE_${kind}_WORKER_CONTAINER_IMAGE' 'mcr.microsoft.com/k8se/quickstart-jobs:latest'`))
  }
})
