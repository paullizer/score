import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigError, loadConfig } from '../dist-server/app.mjs'
import { ALLOWED_OID, APP_ORIGIN, TENANT_ID } from './helpers.mjs'

function environment(overrides = {}) {
  return {
    SCORE_ALLOWED_USER_IDS: ALLOWED_OID,
    AZURE_TENANT_ID: TENANT_ID,
    COSMOS_ENDPOINT: 'https://cosmos.example.com',
    COSMOS_DATABASE: 'score',
    COSMOS_CONTAINER: 'workspaces',
    STORAGE_ACCOUNT_URL: 'https://storage.example.com',
    WORKSPACE_BLOB_CONTAINER: 'workspace-state',
    APP_ORIGIN,
    ...overrides,
  }
}

test('real job imports are disabled without the explicit feature environment setting', () => {
  assert.equal(loadConfig(environment()).realJobs, undefined)
})

test('enabling real job imports requires and maps dedicated Cosmos and Blob containers', () => {
  assert.throws(
    () => loadConfig(environment({ REAL_JOB_IMPORTS_ENABLED: 'true' })),
    (error) => error instanceof ConfigError && /JOB_RECORDS_CONTAINER/.test(error.message),
  )
  const config = loadConfig(environment({
    REAL_JOB_IMPORTS_ENABLED: 'true',
    JOB_RECORDS_CONTAINER: 'job-records',
    JOB_SOURCE_CONTAINER: 'job-sources',
  }))
  assert.deepEqual(config.realJobs, {
    cosmosEndpoint: new URL('https://cosmos.example.com').toString(),
    database: 'score',
    container: 'job-records',
    storageAccountUrl: new URL('https://storage.example.com').toString(),
    blobContainer: 'job-sources',
  })
})

test('real job stores cannot alias legacy workspace containers', () => {
  assert.throws(
    () => loadConfig(environment({
      REAL_JOB_IMPORTS_ENABLED: 'true',
      JOB_RECORDS_CONTAINER: 'workspaces',
      JOB_SOURCE_CONTAINER: 'job-sources',
    })),
    /must be separate from COSMOS_CONTAINER/,
  )
  assert.throws(
    () => loadConfig(environment({
      REAL_JOB_IMPORTS_ENABLED: 'true',
      JOB_RECORDS_CONTAINER: 'job-records',
      JOB_SOURCE_CONTAINER: 'workspace-state',
    })),
    /must be separate from WORKSPACE_BLOB_CONTAINER/,
  )
})

test('rubric assistant config is opt-in and requires real jobs plus model settings', () => {
  assert.equal(loadConfig(environment()).rubricAssistant, undefined)
  const message = /RUBRIC_ASSISTANT_ENABLED requires REAL_JOB_IMPORTS_ENABLED=true and RUBRIC_MODEL_ENDPOINT, RUBRIC_MODEL_DEPLOYMENT and RUBRIC_MODEL_NAME/
  assert.throws(() => loadConfig(environment({ RUBRIC_ASSISTANT_ENABLED: 'true' })), message)
  assert.throws(() => loadConfig(environment({
    RUBRIC_ASSISTANT_ENABLED: 'true',
    RUBRIC_MODEL_ENDPOINT: 'https://score-test.openai.azure.com',
    RUBRIC_MODEL_DEPLOYMENT: 'gpt-test',
    RUBRIC_MODEL_NAME: 'gpt-test',
  })), message)
  assert.throws(() => loadConfig(environment({
    REAL_JOB_IMPORTS_ENABLED: 'true',
    JOB_RECORDS_CONTAINER: 'job-records',
    JOB_SOURCE_CONTAINER: 'job-sources',
    RUBRIC_ASSISTANT_ENABLED: 'true',
    RUBRIC_MODEL_ENDPOINT: 'https://score-test.openai.azure.com',
    RUBRIC_MODEL_DEPLOYMENT: '../bad',
    RUBRIC_MODEL_NAME: 'gpt-test',
  })), /RUBRIC_MODEL_DEPLOYMENT must be an exact Azure deployment identifier/)
  assert.throws(() => loadConfig(environment({
    REAL_JOB_IMPORTS_ENABLED: 'true',
    JOB_RECORDS_CONTAINER: 'job-records',
    JOB_SOURCE_CONTAINER: 'job-sources',
    RUBRIC_ASSISTANT_ENABLED: 'true',
    RUBRIC_MODEL_ENDPOINT: 'https://example.com',
    RUBRIC_MODEL_DEPLOYMENT: 'gpt-test',
    RUBRIC_MODEL_NAME: 'gpt-test',
  })), /RUBRIC_MODEL_ENDPOINT must be/)
  assert.throws(() => loadConfig(environment({
    REAL_JOB_IMPORTS_ENABLED: 'true',
    JOB_RECORDS_CONTAINER: 'job-records',
    JOB_SOURCE_CONTAINER: 'job-sources',
    RUBRIC_ASSISTANT_ENABLED: 'true',
    RUBRIC_MODEL_ENDPOINT: 'https://score-test.openai.azure.com',
    RUBRIC_MODEL_DEPLOYMENT: 'gpt-test',
    RUBRIC_MODEL_NAME: 'gpt-test',
    RUBRIC_MODEL_REASONING_EFFORT: 'extreme',
  })), /RUBRIC_MODEL_REASONING_EFFORT is unsupported/)
  const config = loadConfig(environment({
    REAL_JOB_IMPORTS_ENABLED: 'true',
    JOB_RECORDS_CONTAINER: 'job-records',
    JOB_SOURCE_CONTAINER: 'job-sources',
    RUBRIC_ASSISTANT_ENABLED: 'true',
    RUBRIC_MODEL_ENDPOINT: 'https://score-test.openai.azure.com',
    RUBRIC_MODEL_DEPLOYMENT: 'gpt-test',
    RUBRIC_MODEL_NAME: 'gpt-test',
    RUBRIC_MODEL_REASONING_EFFORT: 'low',
  }))
  assert.deepEqual(config.rubricAssistant, {
    model: {
      endpoint: 'https://score-test.openai.azure.com',
      deploymentName: 'gpt-test',
      modelName: 'gpt-test',
      reasoningEffort: 'low',
    },
  })
})
