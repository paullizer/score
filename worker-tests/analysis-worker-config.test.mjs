import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const bundle = path.resolve('dist-worker', `analysis-config-test-${process.pid}.mjs`)
await mkdir(path.dirname(bundle), { recursive: true })
await build({
  entryPoints: [path.join('worker', 'analysis-index.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
})
const { loadAnalysisWorkerConfig, createAnalysisWorkerDependencies } = await import(pathToFileURL(bundle).href)
after(async () => { await unlink(bundle) })

function config(overrides = {}) {
  return {
    NODE_ENV: 'production',
    AZURE_TENANT_ID: '228db43d-371a-49d8-864e-fa202d181ea5',
    AZURE_CLIENT_ID: '700d5ad1-709c-425f-be9e-b44982bcb173',
    COSMOS_ENDPOINT: 'https://score.documents.azure.com/',
    STORAGE_ACCOUNT_URL: 'https://score.blob.core.windows.net/',
    RUBRIC_MODEL_ENDPOINT: 'https://score.openai.azure.com/',
    RUBRIC_MODEL_DEPLOYMENT: 'job-rubric',
    RUBRIC_MODEL_NAME: 'gpt-5-mini',
    RUBRIC_MODEL_REASONING_EFFORT: 'low',
    ...overrides,
  }
}

test('analysis configuration requires only its dedicated stores, identity, and model', () => {
  const result = loadAnalysisWorkerConfig(config())
  assert.deepEqual(result.stores, {
    cosmosEndpoint: 'https://score.documents.azure.com', database: 'score', container: 'analysis-records',
    storageAccountUrl: 'https://score.blob.core.windows.net', blobContainer: 'analysis-sources',
  })
  assert.equal(result.maxItems, 2)
  assert.equal(result.budgetMilliseconds, 660000)
  assert.equal(result.localDevelopment, false)
  for (const key of ['rendererUrl', 'documentIntelligenceEndpoint', 'jobs', 'resumes', 'grades']) assert.equal(result[key], undefined)
  const deps = createAnalysisWorkerDependencies(result, { getToken: async () => ({ token: 'test-token', expiresOnTimestamp: 0 }) })
  assert.deepEqual(Object.keys(deps).sort(), ['blobs', 'model', 'onEvent', 'store'])
  assert.equal(typeof deps.onEvent, 'function')
  assert.equal(deps.model.endpoint, result.modelEndpoint)
})

test('analysis stores cannot alias job, grade, resume, or legacy containers', () => {
  for (const other of ['job-records', 'grade-records', 'resume-records', 'workspaces']) {
    assert.throws(() => loadAnalysisWorkerConfig(config({ ANALYSIS_RECORDS_CONTAINER: other })), /dedicated analysis-records/)
  }
  for (const other of ['job-sources', 'grade-sources', 'resume-sources', 'workspace-state']) {
    assert.throws(() => loadAnalysisWorkerConfig(config({ ANALYSIS_SOURCE_CONTAINER: other })), /dedicated analysis-records/)
  }
  for (const key of [
    'JOB_RECORDS_CONTAINER', 'JOB_SOURCE_CONTAINER', 'GRADE_RECORDS_CONTAINER', 'GRADE_SOURCE_CONTAINER',
    'RESUME_RECORDS_CONTAINER', 'RESUME_SOURCE_CONTAINER', 'WORKSPACE_BLOB_CONTAINER', 'COSMOS_CONTAINER',
    'DOCUMENT_INTELLIGENCE_ENDPOINT', 'JOB_RENDERER_URL',
  ]) {
    assert.throws(() => loadAnalysisWorkerConfig(config({ [key]: 'not-permitted' })), /must not be configured/)
  }
})

test('hosted analysis identity is explicit, managed, and UUID-bound', () => {
  for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID']) {
    assert.throws(() => loadAnalysisWorkerConfig(config({ [key]: '' })), new RegExp(`${key} is required`))
    assert.throws(() => loadAnalysisWorkerConfig(config({ [key]: 'name-not-an-id' })), /directory identifier/)
  }
  for (const mode of ['default', 'managed-identity', 'environment']) {
    assert.throws(() => loadAnalysisWorkerConfig(config({ WORKER_AUTH_MODE: mode })), /explicit local development/)
  }
})

test('Azure CLI authentication is local-only even when NODE_ENV is not production', () => {
  const local = config({ NODE_ENV: 'development', WORKER_AUTH_MODE: 'azure-cli', AZURE_CLIENT_ID: undefined })
  const result = loadAnalysisWorkerConfig(local)
  assert.equal(result.localDevelopment, true)
  assert.equal(result.clientId, undefined)
  for (const hosted of [
    { NODE_ENV: 'production' }, { IDENTITY_ENDPOINT: 'http://identity' }, { MSI_ENDPOINT: 'http://identity' },
    { CONTAINER_APP_JOB_NAME: 'worker' }, { CONTAINER_APP_NAME: 'worker' }, { WEBSITE_INSTANCE_ID: 'worker' },
  ]) {
    assert.throws(() => loadAnalysisWorkerConfig({ ...local, ...hosted }), /not allowed in a hosted runtime/)
  }
})

test('analysis token destinations must be exact trusted Azure root origins', () => {
  for (const [key, domain] of [
    ['COSMOS_ENDPOINT', 'documents.azure.com'],
    ['STORAGE_ACCOUNT_URL', 'blob.core.windows.net'],
    ['RUBRIC_MODEL_ENDPOINT', 'openai.azure.com'],
  ]) {
    for (const value of [
      `http://score.${domain}`, `https://score.${domain}.example.test`, `https://score.${domain}:8443`,
      `https://name:secret@score.${domain}`, `https://score.${domain}/other`, `https://score.${domain}/?token=secret`,
      `https://score.${domain}/#fragment`, `https://nested.score.${domain}`, `https://${domain}`, 'not-a-url',
    ]) assert.throws(() => loadAnalysisWorkerConfig(config({ [key]: value })), /Azure/)
    assert.equal(loadAnalysisWorkerConfig(config({ [key]: `https://score.${domain}:443/` })).localDevelopment, false)
  }
})

test('model configuration and analysis work budgets fail closed', () => {
  for (const key of ['RUBRIC_MODEL_ENDPOINT', 'RUBRIC_MODEL_DEPLOYMENT', 'RUBRIC_MODEL_NAME']) {
    assert.throws(() => loadAnalysisWorkerConfig(config({ [key]: '' })), /required|Azure/)
  }
  for (const overrides of [
    { RUBRIC_MODEL_REASONING_EFFORT: 'high' }, { RUBRIC_MODEL_REASONING_EFFORT: 'low', RUBRIC_MODEL_NAME: 'gpt-4.1' },
    { RUBRIC_MODEL_DEPLOYMENT: 'deployment?token=private' }, { RUBRIC_MODEL_NAME: 'raw private text' },
    { COSMOS_DATABASE: 'database/path' },
  ]) assert.throws(() => loadAnalysisWorkerConfig(config(overrides)), /RUBRIC_MODEL|identifiers|COSMOS_DATABASE/)
  for (const value of ['0', '101', '1.5', 'NaN', '-1']) {
    assert.throws(() => loadAnalysisWorkerConfig(config({ ANALYSIS_WORKER_MAX_ITEMS: value })), /between 1 and 100/)
  }
  for (const value of ['999', '660001', 'NaN', '1.5']) {
    assert.throws(() => loadAnalysisWorkerConfig(config({ ANALYSIS_WORKER_BUDGET_MS: value })), /between 1000 and 660000/)
  }
  assert.equal(loadAnalysisWorkerConfig(config({ ANALYSIS_WORKER_MAX_ITEMS: '100' })).maxItems, 100)
  assert.equal(loadAnalysisWorkerConfig(config({ ANALYSIS_WORKER_BUDGET_MS: '1000' })).budgetMilliseconds, 1000)
})

test('entrypoint exits nonzero on misconfiguration without exposing configuration values', () => {
  const child = spawnSync(process.execPath, [bundle], {
    env: { ...process.env, ...config({ AZURE_CLIENT_ID: 'PRIVATE-CONFIG-SENTINEL' }) },
    encoding: 'utf8', timeout: 15000,
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 1)
  assert.match(child.stderr, /analysis-worker-failed/)
  assert.doesNotMatch(child.stderr + child.stdout, /PRIVATE-CONFIG-SENTINEL|test-token/)
})
