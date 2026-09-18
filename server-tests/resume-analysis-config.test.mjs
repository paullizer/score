import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { ConfigError, createApp, loadConfig } from '../dist-server/app.mjs'
import {
  ALLOWED_OID, OTHER_ALLOWED_OID, APP_ORIGIN, TENANT_ID, FIXTURE_DIST_DIR, authHeaders, baseConfig,
  createFakeDirectoryStore, createFakeStateStore,
} from './helpers.mjs'

function environment(overrides = {}) {
  return {
    SCORE_ALLOWED_USER_IDS: ALLOWED_OID, AZURE_TENANT_ID: TENANT_ID,
    COSMOS_ENDPOINT: 'https://cosmos.example.com/', COSMOS_DATABASE: 'score', COSMOS_CONTAINER: 'workspaces',
    STORAGE_ACCOUNT_URL: 'https://storage.example.com/', WORKSPACE_BLOB_CONTAINER: 'workspace-state',
    APP_ORIGIN, ...overrides,
  }
}

test('resume and analysis features are opt-in with strict boolean flags', () => {
  for (const [flag, property] of [
    ['REAL_RESUME_IMPORTS_ENABLED', 'realResumes'], ['REAL_ANALYSES_ENABLED', 'realAnalyses'],
  ]) {
    for (const value of [undefined, '', 'false']) {
      assert.equal(loadConfig(environment({ [flag]: value }))[property], undefined)
    }
    for (const value of ['TRUE', 'False', '1', '0', 'yes']) {
      assert.throws(() => loadConfig(environment({ [flag]: value })), error =>
        error instanceof ConfigError && error.message.includes(flag))
    }
  }
})

test('resume and analysis configuration maps only their own default or explicit stores', () => {
  for (const [flag, property, prefix, kind] of [
    ['REAL_RESUME_IMPORTS_ENABLED', 'realResumes', 'RESUME', 'resume'],
    ['REAL_ANALYSES_ENABLED', 'realAnalyses', 'ANALYSIS', 'analysis'],
  ]) {
    for (const custom of [false, true]) {
      const records = custom ? `custom-${kind}-records` : `${kind}-records`
      const sources = custom ? `custom-${kind}-sources` : `${kind}-sources`
      const config = loadConfig(environment({
        [flag]: 'true',
        ...(custom ? { [`${prefix}_RECORDS_CONTAINER`]: records, [`${prefix}_SOURCE_CONTAINER`]: sources } : {}),
      }))
      assert.deepEqual(config[property], {
        cosmosEndpoint: 'https://cosmos.example.com/', database: 'score', container: records,
        storageAccountUrl: 'https://storage.example.com/', blobContainer: sources,
      })
    }
  }
})

test('all workspace/job/grade/resume/analysis containers are pairwise distinct even while disabled', () => {
  for (const settings of [
    ['COSMOS_CONTAINER', 'JOB_RECORDS_CONTAINER', 'GRADE_RECORDS_CONTAINER', 'RESUME_RECORDS_CONTAINER', 'ANALYSIS_RECORDS_CONTAINER'],
    ['WORKSPACE_BLOB_CONTAINER', 'JOB_SOURCE_CONTAINER', 'GRADE_SOURCE_CONTAINER', 'RESUME_SOURCE_CONTAINER', 'ANALYSIS_SOURCE_CONTAINER'],
  ]) {
    for (let first = 0; first < settings.length; first++) {
      for (let second = first + 1; second < settings.length; second++) {
        assert.throws(() => loadConfig(environment({
          [settings[first]]: 'aliased-container', [settings[second]]: 'aliased-container',
        })), /must be separate/, `${settings[first]} must not alias ${settings[second]}`)
      }
    }
  }
})

async function featureServer(t, config, dependencies = {}) {
  const app = createApp({
    config: baseConfig(config), directory: createFakeDirectoryStore(), state: createFakeStateStore(),
    distDir: FIXTURE_DIST_DIR, ...dependencies,
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}/api/features`
}

const configured = { container: 'test-records', blobContainer: 'test-sources' }
const dependencies = { store: {}, blobs: {} }

test('feature discovery keeps existing fields, authenticated privacy, and authoritative limits', async t => {
  const url = await featureServer(t, {})
  assert.equal((await fetch(url)).status, 401)
  const response = await fetch(url, { headers: authHeaders() })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const features = await response.json()
  assert.equal(features.realJobImports, false)
  assert.equal(features.markdownJobImports, false)
  assert.equal(features.realGradeLadders, false)
  assert.equal(features.realResumeImports, false)
  assert.equal(features.markdownResumeImports, false)
  assert.equal(features.realAnalyses, false)
  assert.equal(features.limits.maxPdfBytes, 10 * 1024 * 1024)
  assert.equal(features.limits.maxMarkdownBytes, 10 * 1024 * 1024)
  assert.ok(features.gradeLimits)
  assert.deepEqual(features.resumeLimits, {
    maxPdfBytes: 10 * 1024 * 1024, maxMarkdownBytes: 10 * 1024 * 1024, maxPdfPages: 50, maxSourceCharacters: 180_000,
    maxBatchItems: 10, maxUrlLength: 4096, maxAutomaticAttempts: 3,
  })
  assert.deepEqual(features.analysisLimits, {
    maxComparisons: 500, initializationChunkSize: 25, maxAutomaticAttempts: 3, maxOutputCorrections: 1,
  })
})

test('resume availability requires both explicit configuration and constructed dependencies', async t => {
  for (const [config, deps, expected] of [
    [{}, { resumes: dependencies }, false],
    [{ realResumes: configured }, {}, false],
    [{ realResumes: configured }, { resumes: { store: {} } }, false],
    [{ realResumes: configured }, { resumes: { blobs: {} } }, false],
    [{ realResumes: configured }, { resumes: dependencies }, true],
  ]) {
    const url = await featureServer(t, config, deps)
    const features = await (await fetch(url, { headers: authHeaders() })).json()
    assert.equal(features.realResumeImports, expected)
    assert.equal(features.markdownResumeImports, expected)
    assert.equal(features.realAnalyses, false)
  }
})

test('analysis availability requires its own, resume, and at least one real target service', async t => {
  const fullConfig = { realResumes: configured, realAnalyses: configured, realJobs: configured, realGrades: configured }
  const fullDeps = { resumes: dependencies, analyses: dependencies, jobs: dependencies, grades: dependencies }
  for (const [config, deps, expected] of [
    [fullConfig, fullDeps, true],
    [{ ...fullConfig, realAnalyses: undefined }, fullDeps, false],
    [fullConfig, { ...fullDeps, analyses: undefined }, false],
    [fullConfig, { ...fullDeps, analyses: { store: {} } }, false],
    [fullConfig, { ...fullDeps, analyses: { blobs: {} } }, false],
    [{ ...fullConfig, realResumes: undefined }, fullDeps, false],
    [fullConfig, { ...fullDeps, resumes: undefined }, false],
    [{ ...fullConfig, realJobs: undefined, realGrades: undefined }, fullDeps, false],
    [fullConfig, { ...fullDeps, jobs: undefined, grades: undefined }, false],
    [fullConfig, { ...fullDeps, jobs: undefined }, true],
    [fullConfig, { ...fullDeps, grades: undefined }, true],
  ]) {
    const url = await featureServer(t, config, deps)
    const features = await (await fetch(url, { headers: authHeaders() })).json()
    assert.equal(features.realAnalyses, expected)
  }
})

test('analysis history remains authorized and available when source services disable new runs', async t => {
  const reads = []
  const analyses = {
    store: { list: async workspaceId => { reads.push(workspaceId); return { items: [] } } },
    blobs: {},
  }
  const url = await featureServer(t, { realAnalyses: configured }, { analyses })
  const features = await (await fetch(url, { headers: authHeaders() })).json()
  assert.equal(features.realAnalyses, false)
  assert.deepEqual(reads, [], 'feature readiness must not scan workspace records')
  const session = await (await fetch(url.replace(/features$/, 'session'), { headers: authHeaders() })).json()
  const workspaceId = session.workspaces[0].id
  const historyUrl = url.replace(/features$/, `workspaces/${workspaceId}/analyses`)
  const response = await fetch(historyUrl, { headers: authHeaders() })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { runs: [] })
  assert.deepEqual(reads, [workspaceId])
  assert.equal((await fetch(historyUrl)).status, 401)
  assert.equal((await fetch(historyUrl, { headers: authHeaders({ oid: OTHER_ALLOWED_OID }) })).status, 404)
  assert.deepEqual(reads, [workspaceId], 'unauthorized callers must never reach analysis storage')
})

test('analysis history still requires its own configured store and blob dependencies', async t => {
  let reads = 0
  const store = { list: async () => { reads++; return { items: [] } } }
  for (const [config, analyses] of [
    [{}, { store, blobs: {} }],
    [{ realAnalyses: configured }, { store }],
    [{ realAnalyses: configured }, { blobs: {} }],
  ]) {
    const url = await featureServer(t, config, { analyses })
    const session = await (await fetch(url.replace(/features$/, 'session'), { headers: authHeaders() })).json()
    const historyUrl = url.replace(/features$/, `workspaces/${session.workspaces[0].id}/analyses`)
    assert.equal((await fetch(historyUrl, { headers: authHeaders() })).status, 503)
  }
  assert.equal(reads, 0)
})
