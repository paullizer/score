import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { build } from 'esbuild'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsSnapshot } from './runtime-settings-test-support.mjs'

const workers = [
  { kind: 'job', entry: 'index.ts', loader: 'loadWorkerConfig', name: 'rubricModelName', deployment: 'rubricModelDeployment', effort: 'rubricModelReasoningEffort', code: 'job-worker-failed' },
  { kind: 'grade', entry: 'grade-index.ts', loader: 'loadGradeWorkerConfig', code: 'grade-worker-failed' },
  { kind: 'resume', entry: 'resume-index.ts', loader: 'loadResumeWorkerConfig', code: 'startup-failed' },
  { kind: 'analysis', entry: 'analysis-index.ts', loader: 'loadAnalysisWorkerConfig', code: 'analysis-worker-failed' },
]
const directory = resolve('dist-worker', `startup-tests-${randomUUID()}`)
after(() => rm(directory, { recursive: true, force: true }))
await build({
  entryPoints: Object.fromEntries(workers.map(worker => [worker.kind, join('worker', worker.entry)])),
  outdir: directory, outExtension: { '.js': '.mjs' }, bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external', logLevel: 'silent',
})
for (const worker of workers) {
  worker.bundle = join(directory, `${worker.kind}.mjs`)
  worker.load = (await import(pathToFileURL(worker.bundle).href))[worker.loader]
}
const { workerFailureDiagnostic, workerStartupFailure, withWorkerSettingsDiagnostics } = await loadWorker('../worker/startup.ts')

function environment(worker, overrides = {}) {
  return {
    NODE_ENV: 'production',
    AZURE_TENANT_ID: '228db43d-371a-49d8-864e-fa202d181ea5',
    AZURE_CLIENT_ID: '700d5ad1-709c-425f-be9e-b44982bcb173',
    COSMOS_ENDPOINT: 'https://score.documents.azure.com/',
    STORAGE_ACCOUNT_URL: 'https://score.blob.core.windows.net/',
    RUBRIC_MODEL_ENDPOINT: 'https://score.openai.azure.com/',
    RUBRIC_MODEL_DEPLOYMENT: 'job-rubric', RUBRIC_MODEL_NAME: 'gpt-5-mini', RUBRIC_MODEL_REASONING_EFFORT: 'low',
    ...(worker.kind === 'analysis' ? {} : {
      DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://score.cognitiveservices.azure.com/',
      JOB_RENDERER_URL: 'https://render.internal.example.northcentralus.azurecontainerapps.io/',
    }),
    ...overrides,
  }
}

for (const worker of workers) {
  const name = worker.name ?? 'modelName'
  const deployment = worker.deployment ?? 'modelDeployment'
  const effort = worker.effort ?? 'reasoningEffort'

  test(`${worker.kind} accepts supported GPT-5 efforts and retains the existing low bootstrap`, () => {
    const defaults = worker.load(environment(worker))
    assert.equal(defaults[name], 'gpt-5-mini')
    assert.equal(defaults[deployment], 'job-rubric')
    assert.equal(defaults[effort], 'low')
    for (const value of ['minimal', 'low', 'medium', 'high']) {
      assert.equal(worker.load(environment(worker, { RUBRIC_MODEL_REASONING_EFFORT: value }))[effort], value)
    }
  })

  test(`${worker.kind} accepts Luna/medium without changing the declared deployment`, () => {
    const luna = worker.load(environment(worker, {
      RUBRIC_MODEL_NAME: ' gpt-5.6-luna ', RUBRIC_MODEL_DEPLOYMENT: ' gpt-5.6-luna ',
      RUBRIC_MODEL_REASONING_EFFORT: ' medium ', SCORE_SETTINGS_CONTAINER: 'application-settings',
    }))
    assert.equal(luna[name], 'gpt-5.6-luna')
    assert.equal(luna[deployment], 'gpt-5.6-luna')
    assert.equal(luna[effort], 'medium')
    assert.equal(luna.settingsContainer, 'application-settings')
    for (const value of ['low', 'medium', 'high']) {
      assert.equal(worker.load(environment(worker, {
        RUBRIC_MODEL_NAME: 'gpt-5.6-luna', RUBRIC_MODEL_REASONING_EFFORT: value,
      }))[effort], value)
    }
    for (const value of ['minimal', 'none', 'xhigh', 'max']) {
      assert.throws(() => worker.load(environment(worker, {
        RUBRIC_MODEL_NAME: 'gpt-5.6-luna', RUBRIC_MODEL_REASONING_EFFORT: value,
      })), error => error.field === 'RUBRIC_MODEL_REASONING_EFFORT' && error.reason === 'unsupported-reasoning')
    }
  })

  test(`${worker.kind} omits unset reasoning and accepts supported non-reasoning models`, () => {
    for (const model of ['gpt-5-mini', 'gpt-5.6-luna', 'gpt-4.1', 'gpt-4o']) {
      for (const value of [undefined, '', '  ']) {
        const loaded = worker.load(environment(worker, { RUBRIC_MODEL_NAME: model, RUBRIC_MODEL_REASONING_EFFORT: value }))
        assert.equal(loaded[name], model)
        assert.equal(loaded[effort], undefined)
        assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(loaded)), effort), false)
      }
    }
  })

  test(`${worker.kind} rejects unsupported combinations and unbounded bootstrap identifiers`, () => {
    for (const overrides of [
      { RUBRIC_MODEL_REASONING_EFFORT: 'unsupported' },
      { RUBRIC_MODEL_REASONING_EFFORT: 'xhigh' },
      { RUBRIC_MODEL_REASONING_EFFORT: 'MEDIUM' },
      { RUBRIC_MODEL_NAME: 'gpt-4.1', RUBRIC_MODEL_REASONING_EFFORT: 'medium' },
      { RUBRIC_MODEL_NAME: 'gpt-5-not-an-adapter' },
      { RUBRIC_MODEL_NAME: 'unknown-model', RUBRIC_MODEL_REASONING_EFFORT: undefined },
      { RUBRIC_MODEL_NAME: '' }, { RUBRIC_MODEL_NAME: 'model/private?token=secret' },
      { RUBRIC_MODEL_NAME: 'x'.repeat(301) },
      { RUBRIC_MODEL_DEPLOYMENT: '' }, { RUBRIC_MODEL_DEPLOYMENT: 'deployment?token=secret' },
      { RUBRIC_MODEL_DEPLOYMENT: 'x'.repeat(301) },
    ]) assert.throws(() => worker.load(environment(worker, overrides)), error =>
      error.name === 'WorkerConfigurationError' && error.field.startsWith('RUBRIC_MODEL_'))
    assert.equal(worker.load(environment(worker, { RUBRIC_MODEL_DEPLOYMENT: 'x'.repeat(300) }))[deployment].length, 300)
  })

  test(`${worker.kind} exits nonzero with allowlisted startup metadata, not private configuration values`, () => {
    for (const [field, value, reason] of [
      ['RUBRIC_MODEL_REASONING_EFFORT', 'PRIVATE-STARTUP-SENTINEL', 'unsupported-reasoning'],
      ['RUBRIC_MODEL_NAME', 'PRIVATE-STARTUP-SENTINEL', 'unsupported-model'],
      ['SCORE_SETTINGS_CONTAINER', 'PRIVATE-STARTUP-SENTINEL', 'store-isolation'],
      ['AZURE_TENANT_ID', '', 'missing'],
    ]) {
      const child = spawnSync(process.execPath, [worker.bundle], {
        env: { ...process.env, ...environment(worker, { [field]: value, UNUSED_PRIVATE_VALUE: 'PRIVATE-ENVIRONMENT-SENTINEL' }) },
        encoding: 'utf8', timeout: 15000,
      })
      assert.equal(child.error, undefined)
      assert.equal(child.status, 1)
      const failures = child.stderr.split(/\r?\n/).filter(line => line.includes('"event":"worker-failed"'))
      assert.equal(failures.length, 1, 'Startup diagnostics must remain one queryable JSON event.')
      assert.deepEqual(JSON.parse(failures[0]), {
        component: `score-${worker.kind}-worker`, event: 'worker-failed',
        code: worker.code, phase: 'configuration', field, reason,
      })
      assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE-STARTUP-SENTINEL|PRIVATE-ENVIRONMENT-SENTINEL/)
    }
  })
}

test('unknown startup failures expose only their bounded phase, never arbitrary exception metadata', () => {
  const privateError = Object.assign(new Error('PRIVATE-MESSAGE-SENTINEL'), {
    name: 'PRIVATE-NAME-SENTINEL', code: 'PRIVATE-CODE-SENTINEL',
    field: 'PRIVATE-FIELD-SENTINEL', reason: 'PRIVATE-REASON-SENTINEL',
  })
  for (const phase of ['configuration', 'identity', 'dependencies', 'processing']) {
    assert.deepEqual(workerFailureDiagnostic(workerStartupFailure(phase, privateError)), {
      phase, reason: 'unexpected-error',
    })
  }
  for (const error of [privateError, 'PRIVATE-THROWN-SENTINEL', { message: 'PRIVATE-OBJECT-SENTINEL' }, undefined]) {
    assert.deepEqual(workerFailureDiagnostic(error), { phase: 'processing', reason: 'unexpected-error' })
  }
})

test('settings read and snapshot validation failures remain distinct from processing and never fall back', async () => {
  for (const [current, reason] of [
    [async () => { throw new Error('PRIVATE-SETTINGS-SENTINEL') }, 'settings-read-failed'],
    [async () => ({ settings: { private: 'PRIVATE-SNAPSHOT-SENTINEL' } }), 'invalid-settings'],
  ]) {
    let reads = 0
    const reader = withWorkerSettingsDiagnostics({
      mode: 'configured',
      get legacy() { assert.fail('A failing configured read must not access or substitute legacy settings') },
      current: async () => { reads++; return current() },
    })
    await assert.rejects(reader.current(), error => {
      assert.deepEqual(workerFailureDiagnostic(workerStartupFailure('processing', error)), {
        phase: 'settings-read', reason,
      })
      return true
    })
    assert.equal(reads, 1)
  }
  const legacy = settingsSnapshot(() => {}, 'legacy-v1')
  const current = settingsSnapshot(() => {}, 'saved-current')
  let reads = 0
  const reader = withWorkerSettingsDiagnostics({
    mode: 'configured', legacy, current: async () => { reads++; return current },
  })
  assert.equal(reads, 0)
  assert.equal(reader.legacy, legacy)
  assert.deepEqual(await reader.current(), current)
  assert.equal(reader.legacy, legacy)
  assert.equal(reads, 1)
})
