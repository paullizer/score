import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let loadGradeWorkerConfig
let directory
before(async () => {
  directory = await mkdtemp(path.join(process.cwd(), 'node_modules', '.tmp', 'grade-config-'))
  const outfile = path.join(directory, 'config.mjs')
  await build({ entryPoints: ['worker/grades/config.ts'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  ;({ loadGradeWorkerConfig } = await import(pathToFileURL(outfile)))
})
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

function config(overrides = {}) {
  return {
    NODE_ENV: 'production',
    AZURE_TENANT_ID: '228db43d-371a-49d8-864e-fa202d181ea5',
    AZURE_CLIENT_ID: '700d5ad1-709c-425f-be9e-b44982bcb173',
    COSMOS_ENDPOINT: 'https://score.documents.azure.com/',
    STORAGE_ACCOUNT_URL: 'https://score.blob.core.windows.net/',
    DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://score.cognitiveservices.azure.com/',
    RUBRIC_MODEL_ENDPOINT: 'https://score.openai.azure.com/',
    RUBRIC_MODEL_DEPLOYMENT: 'job-rubric',
    RUBRIC_MODEL_NAME: 'gpt-5-mini',
    RUBRIC_MODEL_REASONING_EFFORT: 'low',
    JOB_RENDERER_URL: 'https://render.internal.example.northcentralus.azurecontainerapps.io',
    ...overrides,
  }
}

test('hosted grade worker uses dedicated stores and private renderer', () => {
  const result = loadGradeWorkerConfig(config())
  assert.equal(result.stores.container, 'grade-records')
  assert.equal(result.stores.blobContainer, 'grade-sources')
  assert.equal(result.maxItems, 5)
  assert.equal(result.localDevelopment, false)
  assert.equal(result.budgetMilliseconds, 660000)
})

test('grade identity configuration cannot be pointed at legacy or job stores', () => {
  for (const overrides of [
    { GRADE_RECORDS_CONTAINER: 'job-records' }, { GRADE_SOURCE_CONTAINER: 'workspace-state' },
    { JOB_RECORDS_CONTAINER: 'job-records' }, { JOB_SOURCE_CONTAINER: 'job-sources' },
    { WORKSPACE_BLOB_CONTAINER: 'workspace-state' },
  ]) assert.throws(() => loadGradeWorkerConfig(config(overrides)), /grade-records|must not be configured/)
})

test('hosted runs require managed identity and reject Azure CLI fallback', () => {
  assert.throws(() => loadGradeWorkerConfig(config({ AZURE_CLIENT_ID: '' })), /AZURE_CLIENT_ID/)
  assert.throws(() => loadGradeWorkerConfig(config({ WORKER_AUTH_MODE: 'azure-cli' })), /not allowed in a hosted runtime/)
  assert.throws(() => loadGradeWorkerConfig(config({ WORKER_AUTH_MODE: 'default' })), /explicit local/)
})

test('local mode must be explicit and may use only a loopback or private renderer', () => {
  const local = loadGradeWorkerConfig(config({ NODE_ENV: 'development', WORKER_AUTH_MODE: 'azure-cli', JOB_RENDERER_URL: 'http://127.0.0.1:5188' }))
  assert.equal(local.localDevelopment, true)
  assert.equal(local.clientId, undefined)
  assert.throws(() => loadGradeWorkerConfig(config({ JOB_RENDERER_URL: 'https://public.example.com' })), /private internal/)
  assert.throws(() => loadGradeWorkerConfig(config({ JOB_RENDERER_URL: 'http://127.0.0.1:5188' })), /private internal/)
})

test('Azure token endpoints cannot be redirected to arbitrary hosts or paths', () => {
  assert.throws(() => loadGradeWorkerConfig(config({ RUBRIC_MODEL_ENDPOINT: 'https://external.example.com' })), /Azure service root/)
  assert.throws(() => loadGradeWorkerConfig(config({ DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://score.cognitiveservices.azure.com/other' })), /Azure service root/)
  assert.throws(() => loadGradeWorkerConfig(config({ STORAGE_ACCOUNT_URL: 'https://user:password@score.blob.core.windows.net' })), /Azure service root/)
})

test('worker duration and item count are bounded', () => {
  assert.throws(() => loadGradeWorkerConfig(config({ GRADE_WORKER_MAX_ITEMS: '21' })), /between 1 and 20/)
  assert.throws(() => loadGradeWorkerConfig(config({ GRADE_WORKER_BUDGET_MS: '900000' })), /between 1000 and 660000/)
  assert.throws(() => loadGradeWorkerConfig(config({ GRADE_WORKER_BUDGET_MS: 'bad' })), /integer/)
})
