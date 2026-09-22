import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig, RUNTIME_SETTINGS_VERSION } from '../dist-server/app.mjs'
import { ALLOWED_OID, APP_ORIGIN, TENANT_ID } from './helpers.mjs'

function environment(overrides = {}) {
  return {
    SCORE_ALLOWED_USER_IDS: ALLOWED_OID, AZURE_TENANT_ID: TENANT_ID,
    COSMOS_ENDPOINT: 'https://cosmos.example.com/', STORAGE_ACCOUNT_URL: 'https://storage.example.com/',
    APP_ORIGIN, ...overrides,
  }
}

test('QC defaults closed and requires complete independent stores for admission', () => {
  assert.equal(loadConfig(environment()).qc, undefined)
  assert.equal(loadConfig(environment()).qcEnabled, false)
  for (const flag of ['QC_ENABLED', 'QC_WORKER_ENABLED']) {
    for (const value of ['TRUE', '1', 'yes']) {
      assert.throws(() => loadConfig(environment({ [flag]: value })), /must be true or false/)
    }
    assert.throws(() => loadConfig(environment({ [flag]: 'true' })), /dedicated records and private source/)
  }
  assert.throws(() => loadConfig(environment({ QC_RECORDS_CONTAINER: 'qc-records' })), /Both QC storage/)
  assert.throws(() => loadConfig(environment({ QC_SOURCE_CONTAINER: 'qc-sources' })), /Both QC storage/)
  assert.throws(() => loadConfig(environment({
    QC_RECORDS_CONTAINER: 'custom-records', QC_SOURCE_CONTAINER: 'custom-sources',
  })), /dedicated qc-records and qc-sources/)
})

test('QC history and cleanup retain configured stores when new admissions stop', () => {
  for (const enabled of ['false', 'true']) {
    const config = loadConfig(environment({
      QC_ENABLED: enabled, QC_RECORDS_CONTAINER: 'qc-records', QC_SOURCE_CONTAINER: 'qc-sources',
    }))
    assert.equal(config.qcEnabled, enabled === 'true')
    assert.deepEqual(config.qc, {
      cosmosEndpoint: 'https://cosmos.example.com/', database: 'score', container: 'qc-records',
      storageAccountUrl: 'https://storage.example.com/', blobContainer: 'qc-sources', workerEnabled: false,
    })
  }
})

test('QC paid work requires explicit admission and verified model settings', () => {
  assert.throws(() => loadConfig(environment({
    QC_ENABLED: 'true', QC_WORKER_ENABLED: 'true',
    QC_RECORDS_CONTAINER: 'qc-records', QC_SOURCE_CONTAINER: 'qc-sources',
  })), /verified runtime model settings/)
  const configured = environment({
    QC_ENABLED: 'true', QC_WORKER_ENABLED: 'true',
    QC_RECORDS_CONTAINER: 'qc-records', QC_SOURCE_CONTAINER: 'qc-sources',
    SCORE_SETTINGS_CONTAINER: 'application-settings', SCORE_RUNTIME_SETTINGS_ENABLED: 'true',
    RUBRIC_MODEL_ENDPOINT: 'https://model.openai.azure.com/', RUBRIC_MODEL_DEPLOYMENT: 'job-rubric',
    RUBRIC_MODEL_NAME: 'gpt-5-mini', RUBRIC_MODEL_REASONING_EFFORT: 'low',
  })
  assert.throws(() => loadConfig(configured), /verified prompt-aware worker/)
  const proof = {
    SCORE_RUNTIME_SETTINGS_WORKER_VERSION: RUNTIME_SETTINGS_VERSION,
    SCORE_PROMPT_RUNTIME_WORKER_VERSION: 'score-prompt-runtime-v1',
    SCORE_RUNTIME_SETTINGS_VERIFIED_IMAGE: 'exampleregistry.azurecr.io/score-worker:verified-build',
    SCORE_RUNTIME_SETTINGS_VERIFIED_AT: '2026-09-21T12:00:00.000Z',
  }
  assert.throws(() => loadConfig({
    ...configured, ...proof, SCORE_PROMPT_RUNTIME_WORKER_VERSION: undefined,
  }), /supplied together/)
  assert.throws(() => loadConfig({
    ...configured, ...proof, SCORE_PROMPT_RUNTIME_WORKER_VERSION: 'old-prompts',
  }), /prompt-version contract/)
  assert.equal(loadConfig({ ...configured, ...proof }).qc.workerEnabled, true)
  assert.throws(() => loadConfig({
    ...configured, ...proof, QC_ENABLED: 'false',
  }), /verified runtime model settings/)
})

test('QC storage cannot alias private evidence, membership, or settings containers', () => {
  for (const name of ['workspaces', 'job-records', 'resume-records', 'analysis-records', 'grade-records', 'application-settings']) {
    assert.throws(() => loadConfig(environment({
      QC_RECORDS_CONTAINER: name, QC_SOURCE_CONTAINER: 'qc-sources',
    })), /must be separate/)
  }
  for (const name of ['workspace-state', 'job-sources', 'resume-sources', 'analysis-sources', 'grade-sources']) {
    assert.throws(() => loadConfig(environment({
      QC_RECORDS_CONTAINER: 'qc-records', QC_SOURCE_CONTAINER: name,
    })), /must be separate/)
  }
})

test('QC deployment limits seed their own settings defaults within the worker hard bounds', () => {
  const configured = environment({
    SCORE_SETTINGS_CONTAINER: 'application-settings',
    QC_WORKER_MAX_ITEMS: '7', QC_WORKER_BUDGET_MS: '240000',
  })
  const config = loadConfig(configured)
  assert.equal(config.settings.defaults.workers.qc.maxItemsPerExecution, 7)
  assert.equal(config.settings.defaults.workers.qc.budgetMilliseconds, 240_000)
  assert.equal(config.settings.defaultSources['workers.qc.maxItemsPerExecution'], 'QC_WORKER_MAX_ITEMS')
  assert.equal(config.settings.defaultSources['workers.qc.budgetMilliseconds'], 'QC_WORKER_BUDGET_MS')
  for (const invalid of [{ QC_WORKER_MAX_ITEMS: '11' }, { QC_WORKER_BUDGET_MS: '660001' }]) {
    assert.throws(() => loadConfig({ ...configured, ...invalid }), /must be an integer/)
  }
})
