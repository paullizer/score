import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const tenant = '00000000-0000-4000-8000-000000000001'
const user = '00000000-0000-4000-8000-000000000002'
const output = join(process.cwd(), 'dist-server', `word-config-tests-${randomUUID()}.mjs`)
let api

before(async () => {
  await build({
    entryPoints: ['server/app.ts'], outfile: output,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  })
  api = await import(pathToFileURL(output).href)
})
after(async () => { await rm(output, { force: true }) })

function environment(overrides = {}) {
  return {
    AZURE_TENANT_ID: tenant, SCORE_ALLOWED_USER_IDS: user,
    COSMOS_ENDPOINT: 'https://cosmos.example.test/', STORAGE_ACCOUNT_URL: 'https://storage.example.test/',
    APP_ORIGIN: 'https://score.example.test', ...overrides,
  }
}

test('Word admission defaults off and requires the strict explicit boolean environment setting', () => {
  for (const value of [undefined, '', ' ', 'false', ' false ']) {
    assert.equal(api.loadConfig(environment({ WORD_DOCUMENT_IMPORTS_ENABLED: value })).wordDocumentImports, false)
  }
  for (const value of ['true', ' true ']) {
    assert.equal(api.loadConfig(environment({ WORD_DOCUMENT_IMPORTS_ENABLED: value })).wordDocumentImports, true)
  }
  for (const value of ['TRUE', 'False', '1', '0', 'yes', 'on']) {
    assert.throws(() => api.loadConfig(environment({ WORD_DOCUMENT_IMPORTS_ENABLED: value })), error =>
      error instanceof api.ConfigError && /WORD_DOCUMENT_IMPORTS_ENABLED must be true or false/.test(error.message))
  }
})

async function features(t, config, dependencies) {
  const app = api.createApp({
    config: { ...api.loadConfig(environment()), ...config },
    directory: {}, state: {}, ...dependencies,
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}/api/features`
}

const headers = {
  'x-ms-client-principal': Buffer.from(JSON.stringify({
    auth_typ: 'aad', claims: [{ typ: 'tid', val: tenant }, { typ: 'oid', val: user }],
  })).toString('base64'),
}
const configured = { container: 'records', blobContainer: 'sources' }
const available = { store: {}, blobs: {} }

test('Word capabilities require both explicit enablement and an available real job or resume service', async t => {
  for (const [config, dependencies, expected] of [
    [{}, { jobs: available, resumes: available }, false],
    [{ wordDocumentImports: true }, { jobs: available, resumes: available }, false],
    [{ wordDocumentImports: true, realJobs: configured, realResumes: configured }, {}, false],
    [{ wordDocumentImports: true, realJobs: configured }, { jobs: { store: {} } }, false],
    [{ wordDocumentImports: true, realResumes: configured }, { resumes: { blobs: {} } }, false],
    [{ wordDocumentImports: true, realGrades: configured, realAnalyses: configured }, { grades: available, analyses: available }, false],
    [{ realJobs: configured, realResumes: configured }, { jobs: available, resumes: available }, false],
    [{ wordDocumentImports: false, realJobs: configured }, { jobs: available }, false],
    [{ wordDocumentImports: undefined, realResumes: configured }, { resumes: available }, false],
    [{ wordDocumentImports: 'true', realJobs: configured }, { jobs: available }, false],
    [{ wordDocumentImports: true, realJobs: configured }, { jobs: available }, true],
    [{ wordDocumentImports: true, realResumes: configured }, { resumes: available }, true],
    [{ wordDocumentImports: true, realJobs: configured, realResumes: configured }, { jobs: available, resumes: available }, true],
  ]) {
    const url = await features(t, config, dependencies)
    const response = await fetch(url, { headers })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const result = await response.json()
    assert.equal(result.wordDocumentImports, expected)
    assert.equal(result.realJobImports, Boolean(config.realJobs && dependencies.jobs?.store && dependencies.jobs.blobs))
    assert.equal(result.realResumeImports, Boolean(config.realResumes && dependencies.resumes?.store && dependencies.resumes.blobs))
    assert.equal(result.limits.maxPdfPages, 50)
    assert.equal(result.resumeLimits.maxPdfPages, 50)
    assert.equal(result.limits.maxFileBytes, 10 * 1024 * 1024)
    assert.equal(result.resumeLimits.maxFileBytes, 10 * 1024 * 1024)
  }
})

test('Word capability discovery remains authenticated and does not expose workspace data', async t => {
  const url = await features(t, { wordDocumentImports: true, realJobs: configured }, { jobs: available })
  const response = await fetch(url)
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await fetch(url, { headers })).status, 200)
})
