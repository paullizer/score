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
