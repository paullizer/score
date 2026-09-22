import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsDomain, settingsSnapshot } from './runtime-settings-test-support.mjs'

const stores = await loadWorker('../worker/settings-store.ts')
const configuration = await loadWorker('../worker/configuration.ts')
const policies = await loadWorker('../worker/settings.ts')
const { withWorkerSettingsDiagnostics } = await loadWorker('../worker/startup.ts')
const config = { stores: { cosmosEndpoint: 'https://cosmos.example.test:443/', database: 'score' } }
const model = { deployment: 'unused-environment-model', modelName: 'gpt-5-mini', reasoningEffort: 'low' }
const credential = { getToken: async () => assert.fail('Constructing a reader must not call Azure') }

function stored(snapshot) {
  return { revision: snapshot.revision, settings: snapshot.settings, createdAt: snapshot.capturedAt }
}

test('configured Azure readers never inspect unused environment bootstrap inputs', () => {
  const unused = {
    ...model,
    get deployment() { throw new Error('Environment bootstrap was inspected.') },
  }
  assert.throws(() => stores.createAzureWorkerSettings(config, credential, unused), /Environment bootstrap was inspected/)
  const reader = stores.createAzureWorkerSettings({ ...config, settingsContainer: 'application-settings' }, credential, unused)
  assert.equal(reader.mode, 'configured')
  assert.throws(() => reader.legacy, /must be loaded/)
})

test('configured readers load valid stored current and legacy policies without any environment bootstrap', async () => {
  const legacy = settingsSnapshot(settings => {
    settings.workers.analyses.budgetMilliseconds = 300_000
    settings.summaries.operationTimeoutMilliseconds = 250_000
  }, settingsDomain.LEGACY_SETTINGS_REVISION)
  let current = settingsSnapshot(settings => {
    settings.workers.analyses.budgetMilliseconds = 240_000
    settings.summaries.operationTimeoutMilliseconds = 180_000
  }, 'saved-current')
  let legacyReads = 0
  const store = {
    getCurrent: async () => ({ etag: 'saved', revision: stored(current) }),
    getRevision: async revision => {
      assert.equal(revision, settingsDomain.LEGACY_SETTINGS_REVISION)
      legacyReads++
      return stored(legacy)
    },
  }
  const reader = stores.createWorkerSettingsReader(undefined, store)
  assert.throws(() => reader.legacy, /must be loaded/)
  assert.deepEqual(await reader.current(), current)
  assert.deepEqual(reader.legacy, legacy)
  current = settingsSnapshot(() => {}, 'later-current')
  assert.deepEqual(await reader.current(), current)
  assert.deepEqual(reader.legacy, legacy)
  assert.equal(legacyReads, 1)
  assert.ok(Object.isFrozen(reader.legacy.settings))

  const invalidBootstrap = structuredClone(legacy)
  invalidBootstrap.settings.summaries.operationTimeoutMilliseconds = 600_000
  const ignored = stores.createWorkerSettingsReader(invalidBootstrap, store)
  assert.deepEqual(await ignored.current(), current)
  assert.deepEqual(ignored.legacy, legacy)
  assert.throws(() => stores.createWorkerSettingsReader(invalidBootstrap), /invalid/)
})

test('an initial saved legacy revision is authoritative without a second revision lookup', async () => {
  const legacy = settingsSnapshot(() => {}, settingsDomain.LEGACY_SETTINGS_REVISION)
  const reader = stores.createWorkerSettingsReader(undefined, {
    getCurrent: async () => ({ etag: 'initial', revision: stored(legacy) }),
    getRevision: async () => assert.fail('The current immutable legacy revision is already available'),
  })
  assert.deepEqual(await reader.current(), legacy)
  assert.deepEqual(reader.legacy, legacy)
})

test('Luna/medium bootstrap validation does not rebind saved current, accepted, or immutable legacy task policies', async () => {
  const bootstrap = configuration.loadWorkerModelConfig({
    RUBRIC_MODEL_DEPLOYMENT: 'gpt-5.6-luna', RUBRIC_MODEL_NAME: 'gpt-5.6-luna', RUBRIC_MODEL_REASONING_EFFORT: 'medium',
  })
  const legacy = settingsSnapshot(() => {}, settingsDomain.LEGACY_SETTINGS_REVISION)
  const accepted = settingsSnapshot(settings => { settings.ai.tasks.targetSummary.reasoningEffort = 'high' }, 'accepted-policy')
  const current = settingsSnapshot(settings => { settings.ai.tasks.targetSummary.deploymentId = 'summaryReview' }, 'saved-current')
  const unchanged = structuredClone({ legacy, accepted, current })
  const reader = withWorkerSettingsDiagnostics(stores.createWorkerSettingsReader(
    policies.createLegacyWorkerSettings({
      deployment: bootstrap.modelDeployment, modelName: bootstrap.modelName, reasoningEffort: bootstrap.reasoningEffort,
    }),
    {
      getCurrent: async () => ({ etag: 'saved', revision: stored(current) }),
      getRevision: async revision => {
        assert.equal(revision, settingsDomain.LEGACY_SETTINGS_REVISION)
        return stored(legacy)
      },
      initialize: async () => assert.fail('Worker startup must never write saved settings'),
    },
  ))
  assert.deepEqual(await reader.current(), current)
  assert.deepEqual(policies.operationSettings({ processingSettings: accepted }, { settings: reader }), accepted)
  assert.deepEqual(policies.operationSettings({}, { settings: reader }), legacy)
  assert.equal(reader.legacy.tasks.targetSummary.modelName, 'gpt-5-mini')
  assert.equal(accepted.tasks.targetSummary.reasoningEffort, 'high')
  assert.equal(current.tasks.targetSummary.deploymentName, 'deployment-summaryReview')
  assert.deepEqual({ legacy, accepted, current }, unchanged)
})

test('omitting unused bootstrap never turns missing, corrupt, or unavailable configured policies into defaults', async () => {
  const current = settingsSnapshot(() => {}, 'saved-current')
  for (const store of [
    { getCurrent: async () => undefined, getRevision: async () => undefined },
    { getCurrent: async () => { throw new Error('Settings unavailable') }, getRevision: async () => undefined },
    { getCurrent: async () => ({ revision: stored(current) }), getRevision: async () => undefined },
    { getCurrent: async () => ({ revision: stored(current) }), getRevision: async () => ({ revision: 'legacy-v1', settings: {} }) },
  ]) {
    const reader = stores.createWorkerSettingsReader(undefined, store)
    await assert.rejects(reader.current())
    assert.throws(() => reader.legacy, /must be loaded/)
  }
  assert.throws(() => stores.createWorkerSettingsReader(undefined), /invalid|bootstrap/i)
})
