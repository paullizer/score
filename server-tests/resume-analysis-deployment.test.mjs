import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  WORD_WORKER_ARTIFACTS, WORD_WORKER_CAPABILITY, WORD_WORKER_EXTRACTION_VERSION, RUNTIME_SETTINGS_VERSION, SETTINGS_WORKER_RUNTIMES, WORKER_DEFINITIONS, configureScheduledWorker, configureWorkerDeployment,
  disableEvidenceCorrectionAdmission, disableRuntimeSettingsAdmission, disableWordAdmission, prepareWebDeployment, validateFeatureSettings, validateRendererTemplate, validateWorkerImage, validateWorkerModelDeployment, validateWorkerTemplate, verifyWordWorkerReadiness,
  wordWorkerVerificationArgs,
} from '../scripts/azure-worker.mjs'

const group = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/score-test'
const env = {
  AZURE_SUBSCRIPTION_ID: '00000000-0000-4000-8000-000000000001',
  AZURE_RESOURCE_GROUP: 'score-test', AZURE_APP_SERVICE_NAME: 'score-web',
  AZURE_COSMOS_ACCOUNT_NAME: 'score-cosmos', AZURE_STORAGE_ACCOUNT_NAME: 'scorestorage',
  AZURE_AI_ACCOUNT_NAME: 'score-ai', AZURE_DOCUMENT_INTELLIGENCE_NAME: 'score-ocr',
  AZURE_TENANT_ID: '00000000-0000-4000-8000-000000000002',
  AZURE_CONTAINER_REGISTRY_ENDPOINT: 'scoretest.azurecr.io',
  AZURE_COSMOS_ENDPOINT: 'https://cosmos.example.com:443/',
  AZURE_STORAGE_ACCOUNT_URL: 'https://storage.example.com/',
  AZURE_RUBRIC_MODEL_ENDPOINT: 'https://foundry.example.com',
  AZURE_RUBRIC_MODEL_DEPLOYMENT: 'job-rubric',
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://ocr.example.com',
  AZURE_JOB_RENDERER_URL: 'https://renderer.internal.example.com',
  AZURE_JOB_RENDERER_ID: `${group}/providers/Microsoft.App/containerApps/renderer`,
  ...Object.fromEntries(WORKER_DEFINITIONS.map(worker => [worker.idKey, `${group}/providers/Microsoft.App/jobs/${worker.kind}`])),
}
const image = `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-worker:resume-analysis-word-v1-20260918000000`
const rendererImage = `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-renderer:resume-analysis-word-v1-20260918000000`

function template(definition) {
  const identityId = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-${definition.kind}-worker-test`
  const settings = {
    NODE_ENV: 'production', AZURE_CLIENT_ID: `${definition.kind}-client`, AZURE_TENANT_ID: env.AZURE_TENANT_ID,
    COSMOS_ENDPOINT: env.AZURE_COSMOS_ENDPOINT, COSMOS_DATABASE: 'score',
    SCORE_SETTINGS_CONTAINER: 'application-settings',
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
    REAL_ANALYSES_ENABLED: 'true', WORD_DOCUMENT_IMPORTS_ENABLED: 'true',
    ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED: 'true',
    SCORE_SETTINGS_CONTAINER: 'application-settings', SCORE_RUNTIME_SETTINGS_ENABLED: 'true',
    ...Object.fromEntries(WORKER_DEFINITIONS.flatMap(worker => [
      [worker.recordsSetting, worker.records], [worker.sourcesSetting, worker.sources],
    ])),
  }
}

test('deployment requires the versioned Word image family, not an arbitrary older resume-analysis image', () => {
  validateWorkerImage(env, image)
  for (const invalid of [
    undefined, 'mcr.microsoft.com/k8se/quickstart-jobs:latest',
    `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-worker:job-old`,
    `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-worker:resume-analysis-20260918`,
    'other.azurecr.io/score-worker:resume-analysis-20260918',
    `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-worker:resume-analysis-`,
    `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-worker:resume-analysis-word-v1-`,
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

test('Azure resource-ID casing does not change worker identity ownership', () => {
  for (const definition of WORKER_DEFINITIONS) {
    const value = template(definition)
    const identity = Object.keys(value.identity.userAssignedIdentities)[0]
    value.identity.userAssignedIdentities = { [identity.toLowerCase()]: value.identity.userAssignedIdentities[identity] }
    validateWorkerTemplate(env, value, definition)
    value.properties.configuration.registries[0].identity = identity.toUpperCase()
    validateWorkerTemplate(env, value, definition)
    value.properties.configuration.registries[0].identity = identity.replace('/score-test/', '/another-group/')
    assert.throws(() => validateWorkerTemplate(env, value, definition), /dedicated identity/)
  }
})

test('bootstrap model drift is not reported as dedicated store or identity drift and never rewrites the template', () => {
  for (const definition of WORKER_DEFINITIONS) {
    for (const field of ['RUBRIC_MODEL_ENDPOINT', 'RUBRIC_MODEL_DEPLOYMENT', 'RUBRIC_MODEL_NAME', 'RUBRIC_MODEL_REASONING_EFFORT']) {
      for (const change of [
        entries => { entries.find(setting => setting.name === field).value = 'PRIVATE-BOOTSTRAP-SENTINEL' },
        entries => { entries.find(setting => setting.name === field).value = 12 },
        entries => { entries.find(setting => setting.name === field).secretRef = 'PRIVATE-BOOTSTRAP-SENTINEL' },
        entries => { entries.push({ ...entries.find(setting => setting.name === field) }) },
        entries => { entries.splice(entries.findIndex(setting => setting.name === field), 1) },
      ]) {
        const value = template(definition)
        change(value.properties.template.containers[0].env)
        const before = structuredClone(value)
        assert.throws(() => validateWorkerTemplate(env, value, definition), error => {
          assert.match(error.message, /model\/bootstrap drift/)
          assert.ok(error.message.includes(field))
          assert.match(error.message, /declared infrastructure bootstrap.*Admin settings/)
          assert.doesNotMatch(error.message, /PRIVATE-BOOTSTRAP-SENTINEL/)
          return true
        })
        assert.deepEqual(value, before)
      }
    }
    for (const field of [definition.recordsSetting, definition.sourcesSetting, 'AZURE_CLIENT_ID']) {
      const value = template(definition)
      value.properties.template.containers[0].env.find(setting => setting.name === field).value = 'PRIVATE-BOUNDARY-SENTINEL'
      assert.throws(() => validateWorkerTemplate(env, value, definition), error => {
        assert.match(error.message, /dedicated .* stores, identity/)
        assert.doesNotMatch(error.message, /model\/bootstrap drift|PRIVATE-BOUNDARY-SENTINEL/)
        return true
      })
    }
  }
})

test('ARM deployment metadata must match both the declared bootstrap deployment and actual model', () => {
  const deployment = {
    name: 'job-rubric',
    properties: { provisioningState: 'Succeeded', model: { name: 'gpt-5-mini', version: '2025-08-07' } },
  }
  validateWorkerModelDeployment(env, deployment)
  for (const value of [
    { ...deployment, name: 'gpt-5.6-luna' },
    { ...deployment, properties: { ...deployment.properties, model: { name: 'gpt-5.6-luna' } } },
    { ...deployment, properties: { ...deployment.properties, model: undefined } },
    { ...deployment, properties: { ...deployment.properties, model: { name: 'PRIVATE-MODEL-SENTINEL' } } },
  ]) {
    assert.throws(() => validateWorkerModelDeployment(env, value), error => {
      assert.match(error.message, /bootstrap deployment\/model pairing/)
      assert.match(error.message, /descriptive model name does not select another deployment/)
      assert.match(error.message, /Admin settings/)
      assert.doesNotMatch(error.message, /PRIVATE-MODEL-SENTINEL/)
      return true
    })
  }
  assert.throws(() => validateWorkerModelDeployment({ ...env, AZURE_RUBRIC_MODEL_DEPLOYMENT: 'another-deployment' }, deployment),
    /bootstrap deployment\/model pairing/)
  for (const value of [undefined, {}, { ...deployment, properties: { ...deployment.properties, provisioningState: 'Updating' } }]) {
    assert.throws(() => validateWorkerModelDeployment(env, value), /bootstrap model deployment must finish provisioning/)
  }
})

test('only the analysis worker accepts the explicit correction gate, while legacy unset templates remain valid', () => {
  for (const definition of WORKER_DEFINITIONS) {
    validateWorkerTemplate(env, template(definition), definition)
    for (const setting of ['false', 'true', 'yes', '', 'TRUE']) {
      const value = template(definition)
      value.properties.template.containers[0].env.push({ name: 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED', value: setting })
      if (definition.kind === 'analysis' && ['true', 'false'].includes(setting)) {
        const result = validateWorkerTemplate(env, value, definition)
        assert.equal(result.container.env.find(item => item.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value, setting)
      } else assert.throws(() => validateWorkerTemplate(env, value, definition))
    }
  }
})

test('renderer isolation compares complete Azure IDs case-insensitively without accepting different identities', () => {
  const identityId = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-render-pull-test`
  const environmentId = `${group}/providers/Microsoft.App/managedEnvironments/workers`
  const renderer = {
    identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId.toLowerCase()]: { clientId: 'pull-client' } } },
    properties: {
      environmentId,
      configuration: { ingress: { external: false }, identitySettings: [{ identity: identityId, lifecycle: 'None' }] },
    },
  }
  assert.deepEqual(validateRendererTemplate(renderer, new Set(), new Set([environmentId.toLowerCase()])), {
    identityId: identityId.toLowerCase(), clientId: 'pull-client',
  })
  const wrongIdentity = structuredClone(renderer)
  wrongIdentity.properties.configuration.identitySettings[0].identity = identityId.replace('id-render-pull-test', 'id-other-pull-test')
  assert.throws(() => validateRendererTemplate(wrongIdentity), /Renderer isolation/)
  const enabledIdentity = structuredClone(renderer)
  enabledIdentity.properties.configuration.identitySettings[0].lifecycle = 'All'
  assert.throws(() => validateRendererTemplate(enabledIdentity), /Renderer isolation/)
  const external = structuredClone(renderer)
  external.properties.configuration.ingress.external = true
  assert.throws(() => validateRendererTemplate(external), /Renderer isolation/)
  assert.throws(() => validateRendererTemplate(renderer, new Set([identityId.toLowerCase()])), /never its registry-pull identity/)
  assert.throws(() => validateRendererTemplate(renderer, new Set(), new Set([`${environmentId}-other`.toLowerCase()])), /share the internal renderer/)
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

function deploymentHarness(definition, status = 'Succeeded', correctionFlag) {
  let current = template(definition)
  if (correctionFlag !== undefined) {
    current.properties.template.containers[0].env.push({ name: 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED', value: correctionFlag })
  }
  let executionTemplate
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
        if (url.includes('/start?')) {
          operations.push({ action: 'start' })
          executionTemplate = structuredClone(current.properties.template)
          return { name: 'initial-test' }
        }
        if (url.includes('/executions/')) {
          operations.push({ action: status })
          return { properties: { status, template: executionTemplate } }
        }
        return structuredClone(current)
      },
    },
  }
}

test('each worker verifies Word artifacts before its initial execution, then schedules and saves only its own pin', async () => {
  for (const definition of WORKER_DEFINITIONS) {
    const { hooks, operations } = deploymentHarness(definition)
    const verified = await configureScheduledWorker(env, {}, definition, image, hooks)
    assert.deepEqual(verified, { kind: definition.kind, image, executionName: 'initial-test' })
    assert.deepEqual(operations.map(operation => operation.action), ['Manual', 'start', 'Succeeded', 'Schedule', 'pin'])
    assert.equal(operations.at(-1).key, definition.imageKey)
    assert.equal(operations.at(-1).value, image)
    const payload = operations.find(operation => operation.action === 'Schedule').payload
    assert.equal(payload.properties.configuration.replicaTimeout, 900)
    assert.equal(payload.properties.configuration.replicaRetryLimit, 0)
    assert.equal(payload.properties.configuration.manualTriggerConfig, undefined)
    assert.equal(payload.properties.configuration.scheduleTriggerConfig.parallelism, 1)
    assert.deepEqual(payload.properties.template.containers[0].args, [definition.entryPoint])
    assert.deepEqual(operations[0].payload.properties.template.containers[0].args, wordWorkerVerificationArgs(definition))
    for (const operation of operations.filter(value => value.payload)) {
      assert.equal(operation.payload.properties.template.containers[0].env.find(setting =>
        setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED')?.value, definition.kind === 'analysis' ? 'false' : undefined)
    }
  }
})

test('analysis-worker verification closes missing, disabled, or previously enabled correction gates', async () => {
  const definition = WORKER_DEFINITIONS.find(worker => worker.kind === 'analysis')
  for (const flag of [undefined, 'false', 'true']) {
    const { hooks, operations } = deploymentHarness(definition, 'Succeeded', flag)
    await configureScheduledWorker(env, {}, definition, image, hooks)
    for (const operation of operations.filter(value => value.payload)) {
      const gates = operation.payload.properties.template.containers[0].env.filter(setting =>
        setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED')
      assert.deepEqual(gates, [{ name: 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED', value: 'false' }])
    }
  }
})

test('unconfirmed analysis-worker gate closure cannot start a verification execution', async () => {
  const definition = WORKER_DEFINITIONS.find(worker => worker.kind === 'analysis')
  const { hooks, operations } = deploymentHarness(definition, 'Succeeded', 'true')
  const send = hooks.request
  let waits = 0
  hooks.delay = async milliseconds => { assert.equal(milliseconds, 5000); waits++ }
  hooks.request = async (...args) => {
    const response = await send(...args)
    if (args[3] === undefined && operations.some(operation => operation.action === 'Manual')) {
      response.properties.template.containers[0].env.find(setting =>
        setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value = 'true'
    }
    return response
  }
  await assert.rejects(configureScheduledWorker(env, {}, definition, image, hooks), /analysis-worker update did not finish/)
  assert.equal(waits, 36)
  assert.deepEqual(operations.map(operation => operation.action), ['Manual'])
})

test('analysis verification cannot certify an execution that admitted correction work', async () => {
  const definition = WORKER_DEFINITIONS.find(worker => worker.kind === 'analysis')
  const { hooks, operations } = deploymentHarness(definition)
  const send = hooks.request
  hooks.request = async (...args) => {
    const response = await send(...args)
    if (args[2].includes('/executions/')) {
      response.properties.template.containers[0].env.find(setting =>
        setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value = 'true'
    }
    return response
  }
  await assert.rejects(configureScheduledWorker(env, {}, definition, image, hooks), /claims disabled until reader verification/)
  assert.ok(operations.every(operation => !['Schedule', 'pin'].includes(operation.action)))
})

test('failed initial execution never schedules or saves an unverified image pin', async () => {
  for (const definition of WORKER_DEFINITIONS) {
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

test('a successful but stale execution cannot verify another image or bypass the artifact probe', async () => {
  const definition = WORKER_DEFINITIONS[0]
  for (const change of [
    container => { container.image = image.replace('20260918000000', 'older') },
    container => { container.args = [definition.entryPoint] },
  ]) {
    const { hooks, operations } = deploymentHarness(definition)
    const send = hooks.request
    hooks.request = async (...args) => {
      const response = await send(...args)
      if (args[2].includes('/executions/')) change(response.properties.template.containers[0])
      return response
    }
    await assert.rejects(configureScheduledWorker(env, {}, definition, image, hooks), /not bound to the verified Word image/)
    assert.ok(operations.every(operation => !['Schedule', 'pin'].includes(operation.action)))
  }
})

test('the in-container probe rejects old, incomplete, or modified artifacts before starting a worker', t => {
  const root = join(process.cwd(), 'server-tests', `.word-readiness-${randomUUID()}`)
  mkdirSync(join(root, 'dist-worker'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const definition = WORKER_DEFINITIONS[0]
  const files = Object.fromEntries(WORD_WORKER_ARTIFACTS.map(name => [
    name,
    WORKER_DEFINITIONS.some(worker => worker.entryPoint === `dist-worker/${name}`)
      ? [
        "import { resolve } from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        'if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {',
        "if (process.execArgv.length) throw new Error('Parser threads must not inherit probe arguments.');",
        "console.log('worker-entry-started');",
        '}',
      ].join('\n')
      : SETTINGS_WORKER_RUNTIMES.includes(name)
        ? `${name === 'runtime.mjs' ? `export const WORD_EXTRACTION_VERSION = ${JSON.stringify(WORD_WORKER_EXTRACTION_VERSION)};\n` : ''}export const RUNTIME_SETTINGS_VERSION = ${JSON.stringify(RUNTIME_SETTINGS_VERSION)};\n`
        : `// ${name}\n`,
  ]))
  const manifest = {
    schemaVersion: 1, capability: WORD_WORKER_CAPABILITY,
    runtimeSettingsVersion: RUNTIME_SETTINGS_VERSION,
    artifacts: Object.fromEntries(Object.entries(files).map(([name, contents]) =>
      [name, createHash('sha256').update(contents).digest('hex')])),
  }
  const writeManifest = value => writeFileSync(join(root, 'dist-worker', 'word-imports.json'), JSON.stringify(value))
  function reset() {
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, 'dist-worker', name), contents)
    writeManifest(manifest)
  }
  function probe() {
    return spawnSync(process.execPath, wordWorkerVerificationArgs(definition), { cwd: root, encoding: 'utf8', timeout: 10_000 })
  }
  reset()
  const docker = readFileSync(new URL('../Dockerfile.worker', import.meta.url), 'utf8')
  const packaging = docker.split('\n').find(line => line.includes('word-imports.json')).match(/-e "(.*)"/)[1]
  const packaged = spawnSync(process.execPath, ['--input-type=module', '--eval', packaging], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(packaged.status, 0, packaged.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'dist-worker', 'word-imports.json'), 'utf8')), manifest)
  for (const worker of WORKER_DEFINITIONS) {
    const ready = spawnSync(process.execPath, wordWorkerVerificationArgs(worker), { cwd: root, encoding: 'utf8', timeout: 10_000 })
    assert.equal(ready.status, 0, ready.stderr)
    assert.match(ready.stdout, /worker-entry-started/, `${worker.kind} must actually run its guarded entry point`)
  }
  for (const damage of [
    () => rmSync(join(root, 'dist-worker', 'word-imports.json')),
    () => writeManifest({ ...manifest, schemaVersion: 0 }),
    () => writeManifest({ ...manifest, capability: 'resume-analysis-only' }),
    () => writeManifest({ ...manifest, runtimeSettingsVersion: undefined }),
    () => writeManifest({ ...manifest, runtimeSettingsVersion: 'unsupported-settings' }),
    () => writeManifest({ ...manifest, artifacts: {} }),
    () => writeFileSync(join(root, 'dist-worker', 'word-parser.mjs'), '// modified parser\n'),
    () => rmSync(join(root, 'dist-worker', 'grade-worker.mjs')),
  ]) {
    reset()
    damage()
    const result = probe()
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /worker-entry-started/)
  }
  for (const olderRuntime of [
    '// Historical PDF/HTML runtime without a Word capability export.\n',
    "export const WORD_EXTRACTION_VERSION = 'older-word-extraction';\n",
  ]) {
    reset()
    writeFileSync(join(root, 'dist-worker', 'runtime.mjs'), olderRuntime)
    writeManifest({
      ...manifest, artifacts: { ...manifest.artifacts, 'runtime.mjs': createHash('sha256').update(olderRuntime).digest('hex') },
    })
    const result = probe()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /required Word extraction version/)
    assert.doesNotMatch(result.stdout, /worker-entry-started/, 'a valid hash manifest cannot certify an old extraction runtime')
  }
  for (const name of SETTINGS_WORKER_RUNTIMES) {
    reset()
    const oldReader = files[name].replace(RUNTIME_SETTINGS_VERSION, 'old-settings-reader')
    writeFileSync(join(root, 'dist-worker', name), oldReader)
    writeManifest({
      ...manifest, artifacts: { ...manifest.artifacts, [name]: createHash('sha256').update(oldReader).digest('hex') },
    })
    const result = probe()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /required runtime settings reader/)
    assert.doesNotMatch(result.stdout, /worker-entry-started/)
  }
  reset()
  const failingWorker = 'process.exitCode = 7\n'
  writeFileSync(join(root, 'dist-worker', 'worker.mjs'), failingWorker)
  writeManifest({
    ...manifest, artifacts: { ...manifest.artifacts, 'worker.mjs': createHash('sha256').update(failingWorker).digest('hex') },
  })
  assert.equal(probe().status, 7, 'the probe must propagate an ordinary worker startup/execution failure')
})

function rolloutHarness(options = {}) {
  let settings = { ...appSettings(), CUSTOM_EXISTING_SETTING: 'unchanged' }
  const workers = new Map(WORKER_DEFINITIONS.map(definition => [definition.kind, template(definition)]))
  if (Object.hasOwn(options, 'correctionFlag')) {
    if (options.correctionFlag === undefined) delete settings.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED
    else {
      settings.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED = options.correctionFlag
      workers.get('analysis').properties.template.containers[0].env.push({
        name: 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED', value: options.correctionFlag,
      })
    }
  }
  const executions = new Map()
  const operations = []
  const pins = new Map(WORKER_DEFINITIONS.map(definition => [definition.imageKey, `${definition.kind}-previous-pin`]))
  const pullId = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-render-pull-test`
  let renderer = {
    location: 'northcentralus', tags: {},
    identity: { type: 'UserAssigned', userAssignedIdentities: { [pullId]: { clientId: 'renderer-client' } } },
    properties: {
      environmentId: `${group}/providers/Microsoft.App/managedEnvironments/workers`,
      configuration: {
        ingress: { external: false }, identitySettings: [{ identity: pullId, lifecycle: 'None' }],
        registries: [{ server: env.AZURE_CONTAINER_REGISTRY_ENDPOINT, identity: pullId }],
      },
    },
  }
  let enableFailed = false
  let runtimeEnableFailed = false
  const hooks = {
    delay: async () => {},
    setEnvironment: (key, value) => { pins.set(key, value); operations.push({ action: 'pin', key, value }) },
    request: async (_credential, _audience, url, method = 'GET', body) => {
      const path = new URL(url).pathname
      if (path.includes('/config/appsettings')) {
        if (method === 'PUT') {
          if (options.denyDisable && body.properties.WORD_DOCUMENT_IMPORTS_ENABLED === 'false') throw new Error('Settings update denied.')
          settings = structuredClone(body.properties)
          operations.push({ action: 'settings', settings: structuredClone(settings) })
          if (options.failEnable && settings.WORD_DOCUMENT_IMPORTS_ENABLED === 'true' && !enableFailed) {
            enableFailed = true
            throw new Error('Ambiguous feature enablement response.')
          }
          if (options.failRuntimeEnable && settings.SCORE_RUNTIME_SETTINGS_ENABLED === 'true' &&
            settings.SCORE_RUNTIME_SETTINGS_WORKER_VERSION === RUNTIME_SETTINGS_VERSION && !runtimeEnableFailed) {
            runtimeEnableFailed = true
            throw new Error('Ambiguous runtime settings activation response.')
          }
        }
        return { properties: structuredClone(settings) }
      }
      if (path === env.AZURE_JOB_RENDERER_ID) {
        if (method === 'PUT') {
          assert.equal(settings.WORD_DOCUMENT_IMPORTS_ENABLED, 'false', 'Word must be off before renderer mutation')
          assert.equal(settings.SCORE_RUNTIME_SETTINGS_ENABLED, 'false', 'Settings admission must be off before renderer mutation')
          assert.equal(settings.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false', 'Corrections must be off before renderer mutation')
          operations.push({ action: 'renderer' })
          renderer = {
            ...structuredClone(body), identity: renderer.identity,
            properties: {
              ...structuredClone(body.properties), provisioningState: options.failRenderer ? 'Failed' : 'Succeeded',
              latestRevisionName: 'new-revision', latestReadyRevisionName: 'new-revision',
            },
          }
        }
        return structuredClone(renderer)
      }
      const definition = WORKER_DEFINITIONS.find(worker =>
        path === env[worker.idKey] || path.startsWith(`${env[worker.idKey]}/`))
      if (definition) {
        const current = workers.get(definition.kind)
        const suffix = path.slice(env[definition.idKey].length)
        if (suffix === '') {
          if (method === 'PUT') {
            assert.equal(settings.WORD_DOCUMENT_IMPORTS_ENABLED, 'false', 'Word must be off before worker mutation')
            assert.equal(settings.SCORE_RUNTIME_SETTINGS_ENABLED, 'false', 'Settings admission must be off before worker mutation')
            operations.push({
              action: 'worker', kind: definition.kind, trigger: body.properties.configuration.triggerType,
              corrections: body.properties.template.containers[0].env.find(setting =>
                setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED')?.value,
            })
            workers.set(definition.kind, {
              ...structuredClone(body), identity: current.identity,
              properties: { ...structuredClone(body.properties), provisioningState: 'Succeeded' },
            })
          }
          const response = structuredClone(workers.get(definition.kind))
          if (options.driftKind === definition.kind &&
            [...workers.values()].every(worker => worker.properties.configuration.triggerType === 'Schedule')) {
            response.properties.template.containers[0].image = image.replace('20260918000000', 'other-build')
          }
          return response
        }
        if (suffix === '/start') {
          const status = options.failedKind === definition.kind ? 'Failed' : 'Succeeded'
          executions.set(definition.kind, { properties: { status, template: structuredClone(current.properties.template) } })
          operations.push({ action: 'execution', kind: definition.kind, status })
          return { name: `verified-${definition.kind}` }
        }
        if (suffix.startsWith('/executions/')) return structuredClone(executions.get(definition.kind))
        if (suffix === '/executions') {
          operations.push({ action: 'history', kind: definition.kind })
          if (options.oldExecutionKind === definition.kind) {
            if (options.secondPage && !new URL(url).searchParams.has('skiptoken')) {
              return { value: [], nextLink: `${url}&skiptoken=older` }
            }
            return { value: [{ properties: { status: 'Running', template: template(definition).properties.template } }] }
          }
          return { value: executions.has(definition.kind) ? [structuredClone(executions.get(definition.kind))] : [] }
        }
      }
      if (path.includes('/Microsoft.DocumentDB/')) {
        const id = path.split('/').at(-1)
        const partition = id === 'application-settings' && !options.invalidSettingsPartition ? '/applicationId' : '/workspaceId'
        return { properties: { resource: { id, partitionKey: { paths: [partition] } } } }
      }
      if (path.includes('/Microsoft.Storage/')) return { properties: { publicAccess: 'None' } }
      if (path.includes('/Microsoft.CognitiveServices/')) return {
        ...(path.includes('/deployments/') ? { name: env.AZURE_RUBRIC_MODEL_DEPLOYMENT } : {}),
        properties: {
          provisioningState: 'Succeeded',
          ...(path.includes('/deployments/') ? { model: { name: 'gpt-5-mini', version: '2025-08-07' } } : {}),
        },
      }
      throw new Error(`Unexpected mocked management request: ${method} ${path}`)
    },
  }
  return { hooks, operations, pins, workers, executions, settings: () => settings }
}

test('Word is disabled before any shared consumer changes and enabled only after all four verified workers', async () => {
  const { hooks, operations, pins, settings } = rolloutHarness()
  await configureWorkerDeployment(env, {}, { image, rendererImage }, hooks)
  assert.equal(operations[0].action, 'settings')
  assert.equal(operations[0].settings.WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
  const last = operations.at(-1)
  assert.equal(last.action, 'settings')
  assert.equal(last.settings.WORD_DOCUMENT_IMPORTS_ENABLED, 'true')
  for (const operation of operations.filter(operation => operation.action === 'settings').slice(0, -1)) {
    assert.equal(operation.settings.WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
  }
  assert.deepEqual(operations.filter(operation => operation.action === 'history').map(operation => operation.kind), ['job', 'grade', 'resume', 'analysis'])
  for (const definition of WORKER_DEFINITIONS) {
    assert.equal(pins.get(definition.imageKey), image)
    if (definition.feature) assert.equal(settings()[definition.feature], 'true')
  }
  assert.equal(settings().REAL_JOB_IMPORTS_ENABLED, 'true')
  assert.equal(settings().CUSTOM_EXISTING_SETTING, 'unchanged')
})

test('ARM bootstrap mismatch blocks image changes while preserving correction-gate cleanup', async () => {
  for (const metadata of [
    { name: 'job-rubric', properties: { provisioningState: 'Succeeded', model: { name: 'gpt-5.6-luna' } } },
    { name: 'gpt-5.6-luna', properties: { provisioningState: 'Succeeded', model: { name: 'gpt-5-mini' } } },
    { name: 'job-rubric', properties: { provisioningState: 'Succeeded' } },
  ]) {
    const { hooks, operations, pins, workers, settings } = rolloutHarness()
    const originals = new Map([...workers].map(([kind, worker]) => [kind, structuredClone(worker)]))
    const send = hooks.request
    let reads = 0
    hooks.request = async (...args) => {
      const url = new URL(args[2])
      if (url.pathname.includes('/Microsoft.CognitiveServices/accounts/score-ai/deployments/')) {
        assert.equal(args[3] ?? 'GET', 'GET')
        assert.equal(url.pathname.split('/').at(-1), env.AZURE_RUBRIC_MODEL_DEPLOYMENT)
        assert.equal(url.searchParams.get('api-version'), '2025-06-01')
        reads++
        return metadata
      }
      return send(...args)
    }
    await assert.rejects(configureWorkerDeployment(env, {}, { image, rendererImage }, hooks), /bootstrap deployment\/model pairing/)
    assert.equal(reads, 1)
    assert.ok(operations.every(operation => operation.action === 'settings' ||
      (operation.action === 'worker' && operation.kind === 'analysis' && operation.corrections === 'false')))
    assert.equal(settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
    assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
    assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false')
    assert.equal(settings().CUSTOM_EXISTING_SETTING, 'unchanged')
    for (const definition of WORKER_DEFINITIONS) {
      assert.equal(pins.get(definition.imageKey), `${definition.kind}-previous-pin`)
      const current = structuredClone(workers.get(definition.kind))
      const original = originals.get(definition.kind)
      if (definition.kind === 'analysis') {
        assert.equal(current.properties.template.containers[0].env.find(setting =>
          setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED')?.value, 'false')
        for (const worker of [current, original]) {
          worker.properties.template.containers[0].env = worker.properties.template.containers[0].env.filter(setting =>
            setting.name !== 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED')
        }
      }
      assert.deepEqual(current.properties, original.properties)
      assert.deepEqual(current.identity, original.identity)
      assert.equal(current.location, original.location)
      assert.deepEqual(current.tags, original.tags)
    }
  }
})

test('complete deployment always enables both correction gates, ignoring saved false opt-ins', async () => {
  const definition = WORKER_DEFINITIONS.find(worker => worker.kind === 'analysis')
  for (const correctionFlag of [undefined, 'false', 'true']) {
    const { hooks, operations, workers, executions, settings } = rolloutHarness({ correctionFlag })
    const saved = { ...env, ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED: 'false' }
    await configureWorkerDeployment(saved, {}, { image, rendererImage }, hooks)
    assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'true')
    assert.equal(settings().CUSTOM_EXISTING_SETTING, 'unchanged')
    const worker = workers.get('analysis')
    const container = worker.properties.template.containers[0]
    assert.equal(container.env.find(setting => setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value, 'true')
    assert.deepEqual(container.env.filter(setting => setting.name !== 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED'),
      template(definition).properties.template.containers[0].env)
    assert.deepEqual(worker.identity, template(definition).identity)
    assert.deepEqual(container.args, [definition.entryPoint])
    assert.equal(container.image, image)
    assert.equal(executions.get('analysis').properties.template.containers[0].env.find(setting =>
      setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value, 'false')
    const claimActivation = operations.findIndex(operation => operation.action === 'worker' && operation.corrections === 'true')
    assert.deepEqual(operations.slice(0, claimActivation).filter(operation => operation.action === 'history').map(operation =>
      operation.kind), WORKER_DEFINITIONS.map(worker => worker.kind))
    const apiActivation = operations.findIndex((operation, index) => index > claimActivation && operation.action === 'settings' &&
      operation.settings.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED === 'true')
    assert.ok(apiActivation > claimActivation)
    assert.equal(operations[apiActivation].settings.SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
    assert.ok(operations.slice(claimActivation, apiActivation).every(operation => operation.action !== 'settings' ||
      operation.settings.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED === 'false'))
    for (const other of WORKER_DEFINITIONS.filter(worker => worker.kind !== 'analysis')) {
      assert.equal(workers.get(other.kind).properties.template.containers[0].env.some(setting =>
        setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED'), false)
    }
    await configureWorkerDeployment(saved, {}, { image, rendererImage }, hooks)
    assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'true', 'another deployment must not restore the saved false value')
    assert.equal(workers.get('analysis').properties.template.containers[0].env.find(setting =>
      setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value, 'true')
  }
})

test('correction admission disablement is confirmed, idempotent, and preserves historical services', async () => {
  const { hooks, operations, settings } = rolloutHarness()
  await disableEvidenceCorrectionAdmission(env, {}, hooks)
  await disableEvidenceCorrectionAdmission(env, {}, hooks)
  assert.equal(operations.length, 1)
  assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false')
  for (const [name, value] of Object.entries(appSettings())) {
    if (name !== 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED') assert.equal(settings()[name], value)
  }
  for (const response of [undefined, {}]) {
    await assert.rejects(disableEvidenceCorrectionAdmission(env, {}, {
      request: async (_credential, _audience, _url, method) => {
        assert.equal(method, 'POST')
        return response
      },
    }), /settings are unavailable/)
  }
})

test('unconfirmed correction admission closure blocks both web and worker deployment', async () => {
  for (const prepare of [
    hooks => prepareWebDeployment(env, {}, hooks),
    hooks => configureWorkerDeployment(env, {}, { image, rendererImage }, hooks),
  ]) {
    const { hooks, operations } = rolloutHarness()
    const send = hooks.request
    hooks.request = async (...args) => {
      const response = await send(...args)
      if (args[2].includes('/config/appsettings/list')) response.properties.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED = 'true'
      return response
    }
    await assert.rejects(prepare(hooks), /did not confirm evidence correction admission disabled/)
    assert.ok(operations.every(operation => !['renderer', 'worker', 'execution', 'pin'].includes(operation.action)))
  }
})

test('correction worker activation requires confirmed flags and the unchanged verified template', async () => {
  for (const failure of ['denied', 'ignored', 'ambiguous', 'stale', 'updating', 'failed', 'drift']) {
    const { hooks, operations, workers, settings, pins } = rolloutHarness()
    const send = hooks.request
    let attempted = false
    let closing = false
    let activationStart
    let waits = 0
    hooks.delay = async milliseconds => { assert.equal(milliseconds, 5000); waits++ }
    hooks.request = async (...args) => {
      const [, , url, method, body] = args
      const analysis = new URL(url).pathname === env.AZURE_ANALYSIS_WORKER_ID
      if (analysis && method === 'PUT') {
        const enabled = body.properties.template.containers[0].env.find(setting =>
          setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED')?.value === 'true'
        if (enabled) {
          attempted = true
          activationStart = operations.length
          if (failure === 'denied') throw new Error('Correction worker activation denied.')
          if (failure === 'ignored') return undefined
        } else if (attempted) closing = true
        const response = await send(...args)
        if (enabled && failure === 'ambiguous') throw new Error('Ambiguous correction worker activation response.')
        if (enabled && failure === 'drift') workers.get('analysis').properties.template.containers[0].image = `${image}-drift`
        return response
      }
      const response = await send(...args)
      if (analysis && method === undefined && attempted && !closing) {
        if (failure === 'stale') response.properties.template.containers[0].env.find(setting =>
          setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value = 'false'
        if (failure === 'updating') response.properties.provisioningState = 'Updating'
        if (failure === 'failed') response.properties.provisioningState = 'Failed'
      }
      return response
    }
    await assert.rejects(configureWorkerDeployment(env, {}, { image, rendererImage }, hooks), /correction/i)
    assert.equal(attempted, true)
    assert.equal(closing, true, 'rollback must write the closed flag even when activation reads look disabled')
    assert.equal(waits, ['ignored', 'stale', 'updating', 'drift'].includes(failure) ? 36 : 0)
    assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false')
    assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
    const container = workers.get('analysis').properties.template.containers[0]
    assert.equal(container.env.find(setting => setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value, 'false')
    assert.equal(container.image, failure === 'drift' ? `${image}-drift` : image, 'closing must not restore a stale image')
    assert.ok(operations.slice(activationStart).every(operation => operation.action !== 'settings' ||
      operation.settings.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED === 'false'))
    for (const definition of WORKER_DEFINITIONS) assert.equal(pins.get(definition.imageKey), image)
  }
})

test('failed or unconfirmed correction API activation closes both flags even after stale reads', async () => {
  for (const failure of ['denied', 'ignored', 'ambiguous', 'stale']) {
    const { hooks, operations, workers, settings } = rolloutHarness()
    const send = hooks.request
    let attempted = false
    let closing = false
    hooks.request = async (...args) => {
      const [, , url, method, body] = args
      if (url.includes('/config/appsettings') && method === 'PUT') {
        const enabled = body.properties.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED === 'true' &&
          operations.some(operation => operation.action === 'worker' && operation.corrections === 'true')
        if (enabled) {
          attempted = true
          if (failure === 'denied') throw new Error('Correction API activation denied.')
          if (failure === 'ignored') return undefined
        } else if (attempted) closing = true
        const response = await send(...args)
        if (enabled && failure === 'ambiguous') throw new Error('Ambiguous correction API activation response.')
        return response
      }
      const response = await send(...args)
      if (failure === 'stale' && url.includes('/config/appsettings/list') && attempted && !closing) {
        response.properties.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED = 'false'
      }
      return response
    }
    await assert.rejects(configureWorkerDeployment(env, {}, { image, rendererImage }, hooks), /correction/i)
    assert.equal(attempted, true)
    assert.equal(closing, true)
    assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false')
    assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
    assert.equal(workers.get('analysis').properties.template.containers[0].env.find(setting =>
      setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value, 'false')
  }
})

test('failed correction cleanup reports every unconfirmed surface without rolling back verified images', async () => {
  const { hooks, operations, settings, pins } = rolloutHarness({ failEnable: true })
  const send = hooks.request
  let activated = false
  hooks.request = async (...args) => {
    const [, , url, method, body] = args
    if (url.includes('/config/appsettings') && method === 'PUT') {
      if (activated && body.properties.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED === 'false') {
        throw new Error('Correction API disablement denied.')
      }
      if (body.properties.ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED === 'true' &&
        operations.some(operation => operation.action === 'worker' && operation.corrections === 'true')) activated = true
    }
    if (activated && new URL(url).pathname === env.AZURE_ANALYSIS_WORKER_ID && method === 'PUT' &&
      body.properties.template.containers[0].env.find(setting => setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value === 'false') {
      throw new Error('Correction worker disablement denied.')
    }
    return send(...args)
  }
  await assert.rejects(configureWorkerDeployment(env, {}, { image, rendererImage }, hooks), error => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /App Service and analysis-worker settings/)
    assert.deepEqual(error.errors.map(failure => failure.message), [
      'Ambiguous feature enablement response.', 'Correction API disablement denied.', 'Correction worker disablement denied.',
    ])
    return true
  })
  assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
  assert.equal(settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
  for (const definition of WORKER_DEFINITIONS) assert.equal(pins.get(definition.imageKey), image)
})

test('legacy Word disablement preserves other flags and deployment hooks enforce reader preparation', async () => {
  const { hooks, operations, settings } = rolloutHarness()
  await disableWordAdmission(env, {}, hooks)
  await disableWordAdmission(env, {}, hooks)
  assert.deepEqual(operations.map(operation => operation.action), ['settings'], 'repeated disablement is idempotent')
  assert.equal(settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
  for (const [key, value] of Object.entries(appSettings())) {
    if (key !== 'WORD_DOCUMENT_IMPORTS_ENABLED') assert.equal(settings()[key], value)
  }
  const yaml = readFileSync(new URL('../azure.yaml', import.meta.url), 'utf8')
  assert.match(yaml, /predeploy:[\s\S]*?azure-before-deploy\.mjs[\s\S]*?azure-worker\.mjs prepare-web-deploy\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/)
  assert.match(yaml, /preprovision:[\s\S]*?azure-worker\.mjs disable-admission --if-provisioned\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/)
})

function webPreparationHarness(options) {
  const harness = rolloutHarness(options)
  for (const definition of WORKER_DEFINITIONS) {
    const worker = harness.workers.get(definition.kind)
    worker.properties.configuration = {
      ...worker.properties.configuration, triggerType: 'Schedule', replicaTimeout: 900, replicaRetryLimit: 0,
      scheduleTriggerConfig: { cronExpression: '* * * * *', parallelism: 1, replicaCompletionCount: 1 },
    }
    worker.properties.template.containers[0].image = `${env.AZURE_CONTAINER_REGISTRY_ENDPOINT}/score-worker:pre-settings-${definition.kind}`
  }
  return harness
}

test('pre-web preparation pauses and drains all old readers without changing their images, identities, stores, or pins', async () => {
  const harness = webPreparationHarness()
  const { hooks, operations, pins, workers, settings } = harness
  const original = structuredClone(workers)
  const send = hooks.request
  hooks.request = async (...args) => {
    if (new URL(args[2]).pathname.endsWith('/executions')) {
      assert.ok([...workers.values()].every(worker => worker.properties.configuration.triggerType === 'Manual'),
        'every schedule must be paused before checking for active old executions')
      const result = await send(...args)
      result.value = ['Succeeded', 'Failed', 'Stopped', 'Cancelled', 'Canceled'].map(status => ({ properties: { status } }))
      return result
    }
    return send(...args)
  }
  await prepareWebDeployment(env, {}, hooks)
  assert.equal(settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
  assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
  assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false')
  assert.equal(settings().CUSTOM_EXISTING_SETTING, 'unchanged')
  for (const key of ['REAL_JOB_IMPORTS_ENABLED', 'REAL_GRADE_LADDERS_ENABLED', 'REAL_RESUME_IMPORTS_ENABLED', 'REAL_ANALYSES_ENABLED']) {
    assert.equal(settings()[key], appSettings()[key], 'historical API capability must not be disabled to pause readers')
  }
  for (const definition of WORKER_DEFINITIONS) {
    const current = workers.get(definition.kind)
    const previous = original.get(definition.kind)
    assert.deepEqual(current.properties.template, previous.properties.template)
    assert.deepEqual(current.identity, previous.identity)
    assert.deepEqual(current.properties.configuration.registries, previous.properties.configuration.registries)
    assert.equal(current.properties.configuration.replicaTimeout, 900)
    assert.equal(current.properties.configuration.replicaRetryLimit, 0)
    assert.equal(current.properties.configuration.triggerType, 'Manual')
    assert.equal(current.properties.configuration.scheduleTriggerConfig, undefined)
    assert.equal(pins.get(definition.imageKey), `${definition.kind}-previous-pin`)
  }
  assert.ok(operations.every(operation => !['renderer', 'execution', 'pin'].includes(operation.action)))
  assert.equal(operations.filter(operation => operation.action === 'worker').length, 4)
  await prepareWebDeployment(env, {}, hooks)
  assert.equal(operations.filter(operation => operation.action === 'worker').length, 4, 'retrying an already paused deployment is idempotent')
})

test('an active old reader on any history page blocks web replacement without cancelling accepted work', async () => {
  for (const definition of WORKER_DEFINITIONS) {
    const { hooks, operations, workers, settings } = webPreparationHarness({ oldExecutionKind: definition.kind, secondPage: true })
    let webPublished = false
    await assert.rejects(async () => {
      await prepareWebDeployment(env, {}, hooks)
      webPublished = true
    }, /still has an execution.*Let it finish.*no execution was cancelled/)
    assert.equal(webPublished, false)
    assert.ok([...workers.values()].every(worker => worker.properties.configuration.triggerType === 'Manual'))
    assert.equal(settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
    assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
    assert.ok(operations.every(operation => !['renderer', 'execution', 'pin'].includes(operation.action)))
    assert.equal(operations.filter(operation => operation.action === 'history' && operation.kind === definition.kind).length, 2)
  }
})

test('queued, running, and unknown execution states are never treated as drained', async () => {
  for (const status of ['Running', 'Processing', 'Pending', 'Unknown', undefined]) {
    const { hooks } = webPreparationHarness()
    const send = hooks.request
    hooks.request = async (...args) => {
      const response = await send(...args)
      return new URL(args[2]).pathname.endsWith('/executions') ? { value: [{ properties: { status } }] } : response
    }
    await assert.rejects(prepareWebDeployment(env, {}, hooks), /still has an execution/)
  }
})

test('unreadable, malformed, cross-resource, or unbounded history cannot certify a drained reader', async () => {
  const root = `https://management.azure.com${env.AZURE_JOB_WORKER_ID}/executions?api-version=2024-03-01`
  for (const response of [
    undefined, {}, { value: null },
    { value: [], nextLink: 'https://other.example.test/executions' },
    { value: [], nextLink: root.replace('/jobs/job/', '/jobs/grade/') },
    { value: [], nextLink: 'not-a-url' },
    { value: [], nextLink: `${root}#unexpected` },
    { value: [], nextLink: root },
  ]) {
    const { hooks } = webPreparationHarness()
    const send = hooks.request
    let reads = 0
    hooks.request = async (...args) => {
      if (new URL(args[2]).pathname.endsWith('/executions')) {
        reads++
        return structuredClone(response)
      }
      return send(...args)
    }
    await assert.rejects(prepareWebDeployment(env, {}, hooks), /execution history|execution continuation/)
    assert.ok(reads >= 1 && reads <= 100)
  }
  const { hooks } = webPreparationHarness()
  const send = hooks.request
  hooks.request = (...args) => {
    if (new URL(args[2]).pathname.endsWith('/executions')) throw new Error('Execution listing unavailable.')
    return send(...args)
  }
  await assert.rejects(prepareWebDeployment(env, {}, hooks), /Execution listing unavailable/)
})

test('failed, unconfirmed, or drifting worker pauses block the API upgrade', async () => {
  for (const failure of ['Failed', 'Schedule', 'image', 'late-schedule']) {
    const { hooks, operations } = webPreparationHarness()
    const send = hooks.request
    hooks.request = async (...args) => {
      const response = await send(...args)
      if (args[3] === undefined && new URL(args[2]).pathname === env.AZURE_JOB_WORKER_ID &&
        operations.some(operation => operation.action === 'worker' && operation.kind === 'job')) {
        if (failure === 'Failed') response.properties.provisioningState = 'Failed'
        if (failure === 'Schedule' || failure === 'late-schedule' && operations.some(operation => operation.action === 'history')) {
          response.properties.configuration.triggerType = 'Schedule'
        }
        if (failure === 'image') response.properties.template.containers[0].image = `${image}-concurrent-change`
      }
      return response
    }
    await assert.rejects(prepareWebDeployment(env, {}, hooks), /pause.*blocked/)
    assert.ok(operations.every(operation => !['renderer', 'execution', 'pin'].includes(operation.action)))
  }
})

test('worker pause polling is bounded and partial pauses never permit a web deployment', async () => {
  const { hooks, operations } = webPreparationHarness()
  const send = hooks.request
  let waits = 0
  hooks.delay = async milliseconds => { assert.equal(milliseconds, 5000); waits++ }
  hooks.request = async (...args) => {
    const response = await send(...args)
    if (args[3] === undefined && new URL(args[2]).pathname === env.AZURE_JOB_WORKER_ID &&
      operations.some(operation => operation.action === 'worker')) response.properties.provisioningState = 'Updating'
    return response
  }
  await assert.rejects(prepareWebDeployment(env, {}, hooks), /pause did not finish/)
  assert.equal(waits, 36)
  assert.equal(operations.filter(operation => operation.action === 'worker').length, 1)
  assert.ok(operations.every(operation => operation.action !== 'history'))
})

test('missing worker outputs or failed gate closure cannot change any reader schedule', async () => {
  const denied = webPreparationHarness({ denyDisable: true })
  await assert.rejects(prepareWebDeployment(env, {}, denied.hooks), /Settings update denied/)
  assert.ok(denied.operations.every(operation => operation.action !== 'worker'))
  for (const definition of WORKER_DEFINITIONS) {
    await assert.rejects(prepareWebDeployment({ ...env, [definition.idKey]: undefined }, {}, {
      request: async () => { assert.fail('Missing workers must fail before management calls') },
    }), /ProvisionOnly/)
  }
})

test('a failure in any worker leaves Word off while preserving only independently verified pins', async () => {
  for (const [index, definition] of WORKER_DEFINITIONS.entries()) {
    const { hooks, operations, pins, workers, settings } = rolloutHarness({ failedKind: definition.kind })
    await assert.rejects(configureWorkerDeployment(env, {}, { image, rendererImage }, hooks), /initial execution.*Failed/)
    assert.equal(settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
    assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false')
    assert.equal(workers.get('analysis').properties.template.containers[0].env.find(setting =>
      setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value, 'false')
    for (const [otherIndex, other] of WORKER_DEFINITIONS.entries()) {
      assert.equal(pins.get(other.imageKey), otherIndex < index ? image : `${other.kind}-previous-pin`)
    }
    assert.ok(operations.filter(operation => operation.action === 'settings').every(operation =>
      operation.settings.WORD_DOCUMENT_IMPORTS_ENABLED === 'false'))
  }
})

test('renderer failures and renderer-only rollouts cannot enable Word or change worker pins', async () => {
  for (const failRenderer of [false, true]) {
    const { hooks, operations, pins, settings } = rolloutHarness({ failRenderer })
    const result = configureWorkerDeployment(env, {}, { rendererImage, rendererOnly: true }, hooks)
    if (failRenderer) await assert.rejects(result, /renderer failed/)
    else await result
    assert.equal(settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
    assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false')
    assert.equal(settings().REAL_RESUME_IMPORTS_ENABLED, 'true')
    assert.equal(settings().REAL_ANALYSES_ENABLED, 'true')
    assert.ok(operations.every(operation => operation.action !== 'worker'))
    for (const definition of WORKER_DEFINITIONS) assert.equal(pins.get(definition.imageKey), `${definition.kind}-previous-pin`)
  }
})

test('unconfirmed gate disablement blocks all consumer changes and ambiguous enablement is closed again', async () => {
  const blocked = rolloutHarness({ denyDisable: true })
  await assert.rejects(configureWorkerDeployment(env, {}, { image, rendererImage }, blocked.hooks), /Settings update denied/)
  assert.ok(blocked.operations.every(operation => !['renderer', 'worker', 'pin'].includes(operation.action)))
  const ambiguous = rolloutHarness({ failEnable: true })
  await assert.rejects(configureWorkerDeployment(env, {}, { image, rendererImage }, ambiguous.hooks), /Ambiguous feature enablement/)
  assert.equal(ambiguous.settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
})

test('current image drift or an older in-flight execution blocks Word even after successful smoke executions', async () => {
  for (const options of [
    { driftKind: 'job' },
    { oldExecutionKind: 'grade' },
    { oldExecutionKind: 'resume', secondPage: true },
    { oldExecutionKind: 'analysis' },
  ]) {
    const { hooks, settings } = rolloutHarness(options)
    await assert.rejects(configureWorkerDeployment(env, {}, { image, rendererImage }, hooks), /verified scheduled Word build|not bound to the verified Word image/)
    assert.equal(settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
    assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false')
  }
})

test('saved image pins or an incomplete verification set cannot reopen Word admission', async () => {
  const verified = WORKER_DEFINITIONS.map(definition => ({ kind: definition.kind, image, executionName: 'verified' }))
  for (const results of [[], verified.slice(1), [...verified.slice(1), verified[1]], verified.map(value => ({ ...value, image: `${image}-older` }))]) {
    await assert.rejects(verifyWordWorkerReadiness(env, {}, image, results, {
      request: async () => { assert.fail('Incomplete readiness must fail before any management request') },
    }), /All four workers must pass/)
  }
})

test('infrastructure composes private stores and identities without new model/search or legacy access', () => {
  const module = readFileSync(new URL('../infra/private-processing.bicep', import.meta.url), 'utf8')
  const resources = readFileSync(new URL('../infra/resources.bicep', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../infra/main.bicep', import.meta.url), 'utf8')
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
  const branches = module.match(/isResume \? \[([\s\S]*?DOCUMENT_INTELLIGENCE_ENDPOINT[\s\S]*?JOB_RENDERER_URL[\s\S]*?)\] : \[([\s\S]*?)\]/)
  assert.ok(branches, 'Resume extraction endpoints must remain in the resume-only environment branch.')
  assert.match(branches[2], /name: 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED', value: 'false'/)
  assert.doesNotMatch(branches[2], /DOCUMENT_INTELLIGENCE_ENDPOINT|JOB_RENDERER_URL/)
  assert.doesNotMatch(module, /(?:JOB|GRADE|WORKSPACE)_(?:RECORDS|SOURCE|BLOB)_CONTAINER/)
  assert.doesNotMatch(module, /Microsoft\.Search|Microsoft\.CognitiveServices\/accounts\/deployments/)
  for (const [kind, stem] of [['resume', 'resumes'], ['analysis', 'analyses']]) {
    assert.equal(parameters[`${kind}WorkerImage`].value, `\${AZURE_${kind.toUpperCase()}_WORKER_CONTAINER_IMAGE}`)
    assert.match(resources, new RegExp(`module ${stem} 'private-processing.bicep'`))
    assert.ok(resources.includes(`workerImage: ${kind}WorkerImage`))
  }
  assert.match(resources, /REAL_RESUME_IMPORTS_ENABLED: resumes\.outputs\.isDeployed \? 'true' : 'false'/)
  assert.match(resources, /REAL_ANALYSES_ENABLED: analyses\.outputs\.isDeployed \? 'true' : 'false'/)
  assert.match(resources, /WORD_DOCUMENT_IMPORTS_ENABLED: 'false'/)
  assert.match(resources, /ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED: 'false'/)
  assert.equal(Object.hasOwn(parameters, 'analysisEvidenceCorrectionsEnabled'), false)
  for (const source of [main, resources, module]) assert.doesNotMatch(source, /analysisEvidenceCorrectionsEnabled/)
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
  assert.ok(docker.includes("'word-parser'"))
  assert.ok(docker.includes('word-imports.json'))
  assert.ok(docker.includes(WORD_WORKER_CAPABILITY))
  const serverDocker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const requiredBundles = serverDocker.match(/for \(const file of (\[[^\]]+\])\) accessSync\('dist-server\/' \+ file\)/)?.[1]
  assert.ok(requiredBundles?.includes("'word-parser.mjs'"))
  assert.ok(requiredBundles?.includes("'telemetry.mjs'"))
  assert.ok(serverDocker.includes('/app/dist-server ./dist-server'))
})

test('runtime settings activate only after every reader and active execution has been verified', async () => {
  const { hooks, operations, settings } = rolloutHarness()
  await configureWorkerDeployment(env, {}, { image, rendererImage }, hooks)
  assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'true')
  assert.equal(settings().SCORE_RUNTIME_SETTINGS_WORKER_VERSION, RUNTIME_SETTINGS_VERSION)
  assert.equal(settings().SCORE_RUNTIME_SETTINGS_VERIFIED_IMAGE, image)
  assert.ok(Number.isFinite(Date.parse(settings().SCORE_RUNTIME_SETTINGS_VERIFIED_AT)))
  const activation = operations.findIndex(operation => operation.action === 'settings' &&
    operation.settings.SCORE_RUNTIME_SETTINGS_ENABLED === 'true' &&
    operation.settings.SCORE_RUNTIME_SETTINGS_WORKER_VERSION === RUNTIME_SETTINGS_VERSION)
  assert.ok(activation > 0)
  for (const action of ['execution', 'history']) {
    assert.deepEqual(
      operations.slice(0, activation).filter(operation => operation.action === action).map(operation => operation.kind).sort(),
      WORKER_DEFINITIONS.map(worker => worker.kind).sort(),
    )
  }
})

test('runtime settings failure and renderer-only paths keep admission disabled', async () => {
  for (const options of [
    { failedKind: 'job' }, { failedKind: 'grade' }, { failedKind: 'resume' }, { failedKind: 'analysis' },
    { oldExecutionKind: 'resume', secondPage: true }, { failRuntimeEnable: true }, { invalidSettingsPartition: true },
  ]) {
    const { hooks, workers, settings } = rolloutHarness(options)
    await assert.rejects(configureWorkerDeployment(env, {}, { image, rendererImage }, hooks))
    assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
    assert.equal(settings().SCORE_RUNTIME_SETTINGS_WORKER_VERSION, '')
    assert.equal(settings().WORD_DOCUMENT_IMPORTS_ENABLED, 'false')
    assert.equal(settings().ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED, 'false')
    assert.equal(workers.get('analysis').properties.template.containers[0].env.find(setting =>
      setting.name === 'ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED').value, 'false')
  }
  const { hooks, settings } = rolloutHarness()
  await configureWorkerDeployment(env, {}, { rendererImage, rendererOnly: true }, hooks)
  assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
})

test('runtime settings pause is verified, idempotent, and preserves unrelated configuration', async () => {
  const { hooks, operations, settings } = rolloutHarness()
  await disableRuntimeSettingsAdmission(env, {}, hooks)
  await disableRuntimeSettingsAdmission(env, {}, hooks)
  assert.equal(operations.filter(operation => operation.action === 'settings').length, 1)
  assert.equal(settings().SCORE_RUNTIME_SETTINGS_ENABLED, 'false')
  for (const [key, value] of Object.entries(appSettings())) {
    if (key !== 'SCORE_RUNTIME_SETTINGS_ENABLED') assert.equal(settings()[key], value)
  }
  assert.equal(settings().CUSTOM_EXISTING_SETTING, 'unchanged')
})

test('settings infrastructure separates administrator grants, four read-only consumers, and renderer isolation', () => {
  const resources = readFileSync(new URL('../infra/resources.bicep', import.meta.url), 'utf8')
  const ai = readFileSync(new URL('../infra/ai.bicep', import.meta.url), 'utf8')
  const ingestion = readFileSync(new URL('../infra/ingestion.bicep', import.meta.url), 'utf8')
  const provision = readFileSync(new URL('../scripts/deploy.ps1', import.meta.url), 'utf8')
  assert.match(resources, /name: 'application-settings'[\s\S]*?paths: \['\/applicationId'\]/)
  assert.match(resources, /settingsReaderKinds = \['job', 'grade', 'resume', 'analysis'\]/)
  assert.match(resources, /settingsReadAccess[\s\S]*?00000000-0000-0000-0000-000000000001[\s\S]*?colls\/\$\{settingsContainer\.name\}/)
  assert.match(resources, /SCORE_ADMIN_USER_IDS: adminUserIds/)
  assert.match(resources, /SCORE_RUNTIME_SETTINGS_ENABLED: 'false'/)
  assert.match(ai, /'Microsoft\.CognitiveServices\/accounts\/deployments\/read'/)
  assert.doesNotMatch(ai, /'Microsoft\.CognitiveServices\/accounts\/(?:listKeys\/action|\*)'/)
  const renderer = ingestion.slice(ingestion.indexOf("resource renderer '"), ingestion.indexOf("resource worker '"))
  assert.doesNotMatch(renderer, /SCORE_SETTINGS_CONTAINER|settingsReadAccess/)
  assert.match(provision, /PSBoundParameters\.ContainsKey\('AdminUserIds'\)/)
  assert.match(provision, /get-values --environment \$EnvironmentName/)
  assert.match(provision, /ContainsKey\('ids'\)/)
})
