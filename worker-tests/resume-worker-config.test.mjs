import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['worker\\resumes\\config.ts'],
  bundle: true, write: false, packages: 'external', format: 'cjs',
  platform: 'node', target: 'node24', logLevel: 'silent',
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports,
)
const { loadResumeWorkerConfig } = module.exports

let dependencyFactory
async function createDependencies(config) {
  if (!dependencyFactory) {
    const result = await build({
      entryPoints: ['worker\\resume-index.ts'],
      bundle: true, write: false, packages: 'external', format: 'cjs',
      platform: 'node', target: 'node24', logLevel: 'silent',
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('worker-tests\\resume-config-tests-not-main.mjs')).href) },
    })
    const entry = { exports: {} }
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(
      createRequire(import.meta.url), entry, entry.exports,
    )
    dependencyFactory = entry.exports.createResumeWorkerDependencies
  }
  return dependencyFactory(config, { getToken: async () => { throw new Error('No Azure tokens belong in renderer requests') } })
}

function environment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    AZURE_TENANT_ID: '228db43d-371a-49d8-864e-fa202d181ea5',
    AZURE_CLIENT_ID: '700d5ad1-709c-425f-be9e-b44982bcb173',
    COSMOS_ENDPOINT: 'https://score.documents.azure.com/',
    STORAGE_ACCOUNT_URL: 'https://score.blob.core.windows.net/',
    DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://score.cognitiveservices.azure.com/',
    RUBRIC_MODEL_ENDPOINT: 'https://score.openai.azure.com/',
    RUBRIC_MODEL_DEPLOYMENT: 'existing-rubric-deployment',
    RUBRIC_MODEL_NAME: 'gpt-5-mini',
    RUBRIC_MODEL_REASONING_EFFORT: 'low',
    JOB_RENDERER_URL: 'https://render.internal.example.northcentralus.azurecontainerapps.io/',
    ...overrides,
  }
}

test('resume worker defaults are bounded and use only its dedicated stores and managed identity', () => {
  const config = loadResumeWorkerConfig(environment())
  assert.deepEqual(config.stores, {
    cosmosEndpoint: 'https://score.documents.azure.com', database: 'score', container: 'resume-records',
    storageAccountUrl: 'https://score.blob.core.windows.net', blobContainer: 'resume-sources',
  })
  assert.equal(config.clientId, environment().AZURE_CLIENT_ID)
  assert.equal(config.tenantId, environment().AZURE_TENANT_ID)
  assert.equal(config.localDevelopment, false)
  assert.equal(config.maxItems, 5)
  assert.equal(config.budgetMilliseconds, 660_000)
  assert.equal(config.modelDeployment, 'existing-rubric-deployment')
  assert.equal(config.reasoningEffort, 'low')
  assert.equal(config.rendererUrl, 'https://render.internal.example.northcentralus.azurecontainerapps.io')
})

test('resume configuration accepts the dedicated settings reader without widening its processing stores', () => {
  const shared = { SCORE_SETTINGS_CONTAINER: 'application-settings' }
  assert.equal(loadResumeWorkerConfig(environment(shared)).settingsContainer, 'application-settings')
  for (const value of ['', 'resume-records', 'analysis-records', 'workspace-state']) {
    assert.throws(() => loadResumeWorkerConfig(environment({ SCORE_SETTINGS_CONTAINER: value })), /dedicated application-settings/)
  }
  assert.throws(() => loadResumeWorkerConfig(environment({ ...shared, JOB_RECORDS_CONTAINER: 'job-records' })), /must not be configured/)
})

test('resume identity cannot be pointed at job, grade, analysis, legacy, or arbitrary stores', () => {
  for (const key of ['RESUME_RECORDS_CONTAINER', 'RESUME_SOURCE_CONTAINER']) {
    for (const name of ['job-records', 'grade-sources', 'analysis-records', 'workspace-state', 'alternate']) {
      assert.throws(() => loadResumeWorkerConfig(environment({ [key]: name })), /dedicated/)
    }
  }
  for (const key of [
    'JOB_RECORDS_CONTAINER', 'JOB_SOURCE_CONTAINER', 'GRADE_RECORDS_CONTAINER', 'GRADE_SOURCE_CONTAINER',
    'ANALYSIS_RECORDS_CONTAINER', 'ANALYSIS_SOURCE_CONTAINER', 'WORKSPACE_BLOB_CONTAINER',
  ]) {
    for (const value of ['other', '']) {
      assert.throws(() => loadResumeWorkerConfig(environment({ [key]: value })), /must not be configured/)
    }
  }
})

test('hosted credential configuration fails closed, without a CLI or default-chain fallback', () => {
  for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID']) {
    for (const value of ['', 'not-a-guid', 'https://identity.example/']) {
      assert.throws(() => loadResumeWorkerConfig(environment({ [key]: value })), new RegExp(key))
    }
  }
  assert.throws(() => loadResumeWorkerConfig(environment({ WORKER_AUTH_MODE: 'default' })), /explicit local/)
  assert.throws(() => loadResumeWorkerConfig(environment({ WORKER_AUTH_MODE: 'azure-cli' })), /hosted runtime/)
  for (const marker of ['IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET',
    'CONTAINER_APP_JOB_NAME', 'CONTAINER_APP_NAME', 'WEBSITE_INSTANCE_ID', 'WEBSITE_HOSTNAME']) {
    assert.throws(() => loadResumeWorkerConfig(environment({
      NODE_ENV: 'development', WORKER_AUTH_MODE: 'azure-cli', [marker]: 'present',
    })), /hosted runtime/)
  }
})

test('only explicit local CLI mode accepts loopback renderers', () => {
  for (const url of ['http://127.0.0.1:5188', 'http://[::1]:5188', 'https://localhost:5188']) {
    const config = loadResumeWorkerConfig(environment({
      NODE_ENV: 'development', WORKER_AUTH_MODE: 'azure-cli', AZURE_CLIENT_ID: '', JOB_RENDERER_URL: url,
    }))
    assert.equal(config.localDevelopment, true)
    assert.equal(config.clientId, undefined)
    assert.equal(config.rendererUrl, url)
    assert.throws(() => loadResumeWorkerConfig(environment({ JOB_RENDERER_URL: url })), /private internal/)
  }
  for (const url of [
    'https://public.example.com', 'https://renderer.azurecontainerapps.io',
    'http://render.internal.example.azurecontainerapps.io', 'https://render.internal.example.azurecontainerapps.io:444',
    'https://render.internal.example.azurecontainerapps.io/path', 'https://render.internal.example.azurecontainerapps.io/?q=1',
    'https://render.internal.example.azurecontainerapps.io/#x',
    'https://user:secret@render.internal.example.azurecontainerapps.io',
  ]) {
    assert.throws(() => loadResumeWorkerConfig(environment({ JOB_RENDERER_URL: url })), /private internal/)
  }
})

test('Azure token destinations must be HTTPS service roots, without credentials, paths, queries, or fragments', () => {
  for (const key of ['COSMOS_ENDPOINT', 'STORAGE_ACCOUNT_URL', 'DOCUMENT_INTELLIGENCE_ENDPOINT', 'RUBRIC_MODEL_ENDPOINT']) {
    const good = environment()[key]
    for (const bad of [
      'not-url', 'https://external.example.com', good.replace('https:', 'http:'), `${good}path`,
      `${good}?q=secret`, `${good}#fragment`, good.replace('https://', 'https://user:secret@'),
      good.replace('.com/', '.com:444/'), good.replace('.net/', '.net:444/'),
    ].filter(value => value !== good)) {
      assert.throws(() => loadResumeWorkerConfig(environment({ [key]: bad })), new RegExp(key))
    }
  }
  assert.throws(() => loadResumeWorkerConfig(environment({ COSMOS_DATABASE: '../other' })), /COSMOS_DATABASE/)
})

test('execution limits and model reasoning must be explicit supported values', () => {
  for (const value of ['0', '21', '1.5', 'NaN', 'Infinity']) {
    assert.throws(() => loadResumeWorkerConfig(environment({ RESUME_WORKER_MAX_ITEMS: value })), /between 1 and 20/)
  }
  for (const value of ['0', '999', '660001', '-1', 'bad']) {
    assert.throws(() => loadResumeWorkerConfig(environment({ RESUME_WORKER_BUDGET_MS: value })), /between 1000 and 660000/)
  }
  assert.equal(loadResumeWorkerConfig(environment({ RESUME_WORKER_MAX_ITEMS: '20', RESUME_WORKER_BUDGET_MS: '1000' })).maxItems, 20)
  assert.throws(() => loadResumeWorkerConfig(environment({ RUBRIC_MODEL_REASONING_EFFORT: 'unsupported' })), /not supported/)
  assert.throws(() => loadResumeWorkerConfig(environment({ RUBRIC_MODEL_NAME: 'other-model' })), /supported structured-output/)
  assert.throws(() => loadResumeWorkerConfig(environment({ RUBRIC_MODEL_REASONING_EFFORT: '', RUBRIC_MODEL_NAME: 'other-model' })), /supported structured-output/)
  assert.equal(loadResumeWorkerConfig(environment({ RUBRIC_MODEL_REASONING_EFFORT: '', RUBRIC_MODEL_NAME: 'gpt-4.1' })).reasoningEffort, undefined)
  for (const key of ['RUBRIC_MODEL_NAME', 'RUBRIC_MODEL_DEPLOYMENT', 'JOB_RENDERER_URL']) {
    assert.throws(() => loadResumeWorkerConfig(environment({ [key]: '' })), new RegExp(key))
  }
})

test('explicit local HTTP uses a bounded credential-free renderer client without weakening hosted HTTPS defaults', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), init })
    return Response.json({ html: '<main>Public profile content</main>', finalUrl: 'https://profiles.example/jordan' })
  })
  const config = loadResumeWorkerConfig(environment({
    NODE_ENV: 'development', WORKER_AUTH_MODE: 'azure-cli', JOB_RENDERER_URL: 'http://127.0.0.1:5188',
  }))
  const dependencies = await createDependencies(config)
  const result = await dependencies.browser.render('https://profiles.example/jordan', {})
  assert.equal(result.finalUrl, 'https://profiles.example/jordan')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://127.0.0.1:5188/render')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.redirect, 'error')
  assert.equal(requests[0].init.headers.authorization, undefined)
  assert.equal(requests[0].init.headers.cookie, undefined)
  assert.equal(requests[0].init.headers['x-score-worker'], 'job-ingestion')
  assert.deepEqual(JSON.parse(requests[0].init.body), { url: 'https://profiles.example/jordan' })
  assert.ok(requests[0].init.signal instanceof AbortSignal)
  const hosted = await createDependencies(loadResumeWorkerConfig(environment()))
  await hosted.browser.render('https://profiles.example/jordan', {})
  assert.equal(requests[1].url, 'https://render.internal.example.northcentralus.azurecontainerapps.io/render')
  assert.equal(requests[1].init.headers.authorization, undefined)
})

test('local renderer responses reject private destinations, malformed payloads, outages, and oversized output', async t => {
  let response
  t.mock.method(globalThis, 'fetch', async () => response)
  const dependencies = await createDependencies(loadResumeWorkerConfig(environment({
    NODE_ENV: 'development', WORKER_AUTH_MODE: 'azure-cli', JOB_RENDERER_URL: 'http://127.0.0.1:5188',
  })))
  for (const [value, code] of [
    [Response.json({ html: 'private-marker', finalUrl: 'http://127.0.0.1/private' }), 'renderer-invalid-response'],
    [Response.json({ unexpected: 'private-marker' }), 'renderer-invalid-response'],
    [new Response('private-marker', { status: 503 }), 'renderer-unavailable'],
    [new Response('private-marker'), 'renderer-invalid-response'],
    [Response.json({ html: 'x'.repeat(2 * 1024 * 1024), finalUrl: 'https://profiles.example/jordan' }), 'source-too-large'],
  ]) {
    response = value
    await assert.rejects(dependencies.browser.render('https://profiles.example/jordan', {}), error => {
      assert.equal(error.code, code)
      assert.doesNotMatch(error.message, /private-marker|profiles\.example/)
      return true
    })
  }
})

test('dedicated entry point constructs actual private clients and logs only counts or a safe error code', async () => {
  const source = await readFile('worker\\resume-index.ts', 'utf8')
  assert.match(source, /new ManagedIdentityCredential\(\{ clientId: config\.clientId \}\)/)
  assert.match(source, /if \(config\.localDevelopment\) credential = new AzureCliCredential/)
  assert.match(source, /createAzureResumeStore\(config\.stores, credential\)/)
  assert.match(source, /createAzureResumeBlobStore\(config\.stores, credential\)/)
  assert.match(source, /createRemoteRenderer\(config\.rendererUrl/)
  assert.doesNotMatch(source, /DefaultAzureCredential|createPlaywrightRenderer|launch\(|createAzure(?:Job|Grade|Analysis)|console\.(?:error|log)\([^)]*(?:message|stack|source|profile)/)
  assert.match(source, /process\.exitCode = 1/)
  assert.match(source, /signal: stopping\.signal/)
})
