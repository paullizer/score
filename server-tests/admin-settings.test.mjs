import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  ADMIN_SETTINGS_STORAGE_LIMITS, AdminSettingsService, MODEL_TASK_IDS, RUNTIME_SETTINGS_VERSION,
  StoreConflictError, attachSettingsContext, captureProcessingSettings, createApp,
  createDefaultAdminSettings, effectiveFeatures, loadConfig, mergeAdminSettings, modelCapabilitiesFor,
  assertNewProcessingAllowed, getCurrentSettings, getPinnedAdmissionSettings, getProcessingAdmissionSettings,
  getRuntimeSettingsReadiness, getSettingsForAcceptedWork, parseAdminSettings, processingSettingsSnapshotSchema,
  projectPublicSettings, resolveTaskModel, settingsJsonBytes, urlAllowedBySettings,
} from '../dist-server/app.mjs'
import {
  ALLOWED_OID, APP_ORIGIN, CSRF_HEADER, FIXTURE_DIST_DIR, OTHER_ALLOWED_OID, TENANT_ID, authHeaders,
  baseConfig, createFakeAccessStore, createFakeDirectoryStore, createFakeStateStore, membershipFor, seedWorkspace,
} from './helpers.mjs'

const now = () => new Date('2026-09-21T12:00:00.000Z')
const principal = { tenantId: TENANT_ID, oid: ALLOWED_OID, principalKey: `${TENANT_ID}:${ALLOWED_OID}`, name: 'Admin', email: '', applicationRoles: ['Score.Admin'] }

function fakeStore() {
  let current
  let counter = 0
  let readError
  let writeError
  const revisions = new Map()
  const audits = new Map()
  const counters = { reads: 0, initializations: 0, publications: 0 }
  return {
    counters, revisions, audits,
    failRead(error) { readError = error },
    failWrite(error) { writeError = error },
    async getCurrent() {
      counters.reads++
      if (readError) throw readError
      return current && structuredClone(current)
    },
    async getRevision(revision) {
      if (readError) throw readError
      return structuredClone(revisions.get(revision))
    },
    async initialize(revision) {
      counters.initializations++
      if (writeError) throw writeError
      if (current) return false
      current = { revision: structuredClone(revision), etag: `"settings-${++counter}"` }
      revisions.set(revision.revision, structuredClone(revision))
      const { settings, ...audit } = revision
      audits.set(revision.revision, structuredClone(audit))
      return true
    },
    async publish(revision, etag) {
      if (writeError) throw writeError
      if (current?.etag !== etag) throw new StoreConflictError()
      if (revisions.has(revision.revision)) throw new Error('Immutable revision collision.')
      counters.publications++
      current = { revision: structuredClone(revision), etag: `"settings-${++counter}"` }
      revisions.set(revision.revision, structuredClone(revision))
      const { settings, ...audit } = revision
      audits.set(revision.revision, structuredClone(audit))
      return structuredClone(current)
    },
    async history(limit, before) {
      const values = [...audits.values()].sort((a, b) => b.revision.localeCompare(a.revision))
        .filter(item => !before || item.revision < before)
      return { revisions: structuredClone(values.slice(0, limit)), ...(values.length > limit ? { nextBefore: values[limit - 1].revision } : {}) }
    },
  }
}
function settingsConfig(runtimeEnabled = true) {
  return baseConfig({
    settings: {
      cosmosEndpoint: 'https://example.documents.azure.com', database: 'score', container: 'application-settings',
      applicationId: 'score', runtimeEnabled, defaults: createDefaultAdminSettings(),
      model: { endpoint: 'https://example.openai.azure.com', deploymentName: 'job-rubric', modelName: 'gpt-5-mini' },
    },
  })
}
async function start(options = {}) {
  const store = options.store ?? fakeStore()
  const config = options.config ?? settingsConfig()
  const directory = options.directory ?? createFakeDirectoryStore()
  const state = options.state ?? createFakeStateStore()
  let id = 0
  const settings = new AdminSettingsService({ config, store, now, newId: () => `test-${++id}`, models: options.models })
  const app = createApp({ config, directory, state, settings, accessStore: createFakeAccessStore(), jobs: options.jobs, distDir: FIXTURE_DIST_DIR, now })
  const server = createServer(app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (path, options = {}) => {
    const { oid = ALLOWED_OID, roles = oid === ALLOWED_OID ? ['Score.Admin'] : ['Score.User'], headers, body, ...init } = options
    const response = await fetch(`${base}${path}`, {
      ...init, headers: { ...authHeaders({ oid, roles }), ...CSRF_HEADER, Origin: APP_ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { response, body: await response.json() }
  }
  return {
    app, store, settings, config, directory, state, request,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}

test('settings defaults cover all twelve tasks and reject literal-type, unknown-key, and cross-field mistakes', () => {
  const defaults = parseAdminSettings(createDefaultAdminSettings())
  assert.equal(MODEL_TASK_IDS.length, 12)
  assert.equal(RUNTIME_SETTINGS_VERSION, 'score-runtime-settings-v2')
  assert.deepEqual(Object.keys(defaults.ai.tasks), [...MODEL_TASK_IDS])
  assert.equal(defaults.workers.jobs.maxItemsPerExecution, 4)
  assert.equal(defaults.imports.urls.maxResponseBytes, 12 * 1024 * 1024)
  assert.equal(defaults.grades.references.maxPdfBytes, 20 * 1024 * 1024)
  assert.equal(createDefaultAdminSettings({ workers: { jobs: { maxItemsPerExecution: 5 } } }).workers.jobs.maxItemsPerExecution, 5)
  const lowered = mergeAdminSettings(defaults, {
    imports: { jobs: { maxBatchItems: 2 }, urls: { maxResponseBytes: 1024 } }, reports: { highlightCount: 3 },
  })
  assert.equal(lowered.imports.jobs.maxBatchItems, 2)
  assert.equal(lowered.imports.urls.maxResponseBytes, 1024)
  assert.equal(lowered.grades.references.maxPdfBytes, 20 * 1024 * 1024)
  assert.equal(defaults.imports.jobs.maxBatchItems, 10)
  assert.throws(() => mergeAdminSettings(defaults, { endpoint: 'https://secret.example' }), /Unknown setting/)
  assert.throws(() => mergeAdminSettings(defaults, { imports: { jobs: { maxBatchItems: 11, secret: 'do-not-echo' } } }), /Unknown setting/)
  assert.throws(() => mergeAdminSettings(defaults, JSON.parse('{"__proto__":{"admin":true}}')), /Unknown setting/)
  assert.throws(() => mergeAdminSettings(defaults, { reports: { enabledFormats: ['csv'] } }), /enabled format/)
  assert.throws(() => mergeAdminSettings(defaults, { grades: { allowedLevels: [1], defaults: { levels: [2] } } }), /subset/)
  assert.equal(mergeAdminSettings(defaults, { grades: { defaults: { agency: 'a'.repeat(300) } } }).grades.defaults.agency.length, 300)
  assert.throws(() => mergeAdminSettings(defaults, { grades: { defaults: { agency: 'a'.repeat(301) } } }))
  assert.equal(mergeAdminSettings(defaults, { grades: { defaults: { specialty: 's'.repeat(1000) } } }).grades.defaults.specialty.length, 1000)
  assert.throws(() => mergeAdminSettings(defaults, { grades: { defaults: { specialty: 's'.repeat(1001) } } }))
  assert.throws(() => mergeAdminSettings(defaults, { reports: { highlightCount: 9, maxHighlights: 8 } }), /highlight/)
  assert.throws(() => mergeAdminSettings(defaults, { summaries: { operationTimeoutMilliseconds: 600_000 }, workers: { analyses: { budgetMilliseconds: 600_000 } } }), /cleanup/)
  assert.equal(mergeAdminSettings(defaults, { reports: { enabledFormats: [], defaultFormat: null } }).reports.defaultFormat, null)
})

test('API bootstrap initializes settings before activation, is create-only, and propagates failures without blocking identity', async () => {
  const server = await start({ config: settingsConfig(false) })
  try {
    assert.equal(server.store.counters.initializations, 0)
    const initialized = await server.app.locals.bootstrapSettings()
    assert.equal(initialized.revision.revision, 'legacy-v1')
    assert.equal(server.store.counters.initializations, 1)
    await server.app.locals.bootstrapSettings()
    assert.equal(server.store.counters.initializations, 1)
    const current = await server.request('/api/admin/settings')
    assert.equal(current.body.environment.runtimeSettingsVersion, RUNTIME_SETTINGS_VERSION)
    assert.equal(current.body.environment.runtimeEnabled, false)
    assert.equal(current.body.fields.find(field => field.path === 'grades.defaults.agency').max, 300)
    assert.equal(current.body.fields.find(field => field.path === 'grades.defaults.specialty').max, 1000)
    for (const path of ['ai.deployments', 'imports.urls.agencyReferences.allowedHosts']) {
      const description = current.body.fields.find(field => field.path === path).description
      assert.match(description, /16384 serialized UTF-8 bytes/)
      assert.match(description, /32768 bytes/)
    }
    server.store.failRead(new Error('settings-offline'))
    await assert.rejects(server.app.locals.bootstrapSettings(), /settings-offline/)
    assert.equal(server.store.counters.initializations, 1)
    assert.equal((await server.request('/api/session/identity')).response.status, 200)
  } finally { await server.close() }
})

test('models reject unsupported parameters, units, capabilities, and input/output budgets without fallback', () => {
  const defaults = createDefaultAdminSettings()
  for (const patch of [
    { ai: { tasks: { assessment: { deploymentId: 'missing' } } } },
    { ai: { tasks: { assessment: { temperature: 0 } } } },
    { ai: { tasks: { assessment: { topP: 0.7 } } } },
    { ai: { tasks: { jobRubric: { completionTokenLimit: 8193 } } } },
    { ai: { tasks: { resumeProfile: { inputBudget: { unit: 'characters' } } } } },
  ]) assert.throws(() => mergeAdminSettings(defaults, patch))
  const unknown = createDefaultAdminSettings({ model: { deploymentName: 'unknown', modelName: 'not-supported' } })
  assert.throws(() => parseAdminSettings(unknown), /structured output/)
  const disabled = structuredClone(defaults)
  disabled.ai.deployments[0].enabled = false
  assert.throws(() => resolveTaskModel(disabled, 'assessment'), /no substitute/)
  assert.deepEqual(modelCapabilitiesFor('gpt-5-mini').reasoningEfforts, ['minimal', 'low', 'medium', 'high'])
  assert.equal(modelCapabilitiesFor('gpt-4o', '2024-05-13').structuredOutputs, false)
})

test('Luna medium uses an explicit model/version adapter without changing the default bootstrap or admitting unknown versions', () => {
  const capabilities = modelCapabilitiesFor('gpt-5.6-luna', '2026-07-09')
  assert.deepEqual(capabilities, {
    structuredOutputs: true, contextTokens: 1_050_000, maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high'], temperature: false, topP: false,
  })
  assert.deepEqual(modelCapabilitiesFor('gpt-5.6-luna'), capabilities)
  assert.deepEqual(modelCapabilitiesFor('gpt-5.6-luna', null), capabilities)
  for (const [name, version] of [
    ['gpt-5.6-luna', '2025-08-07'], ['gpt-5.6-luna', '2026-06-25'], ['gpt-5.6-luna', '2026-07-10'], ['gpt-5.6-luna', ''],
    ['gpt-5.6-luna-preview', '2026-07-09'], ['gpt-5.6', '2026-07-09'], ['GPT-5.6-LUNA', '2026-07-09'],
    ['gpt-5-mini', '2026-07-09'], ['gpt-5-unknown', null],
  ]) assert.deepEqual(modelCapabilitiesFor(name, version), modelCapabilitiesFor('unsupported'))

  const luna = parseAdminSettings(createDefaultAdminSettings({
    model: { deploymentName: 'gpt-5.6-luna', modelName: 'gpt-5.6-luna', reasoningEffort: 'medium' },
  }))
  for (const reasoningEffort of ['minimal', 'none', 'xhigh', 'max']) {
    assert.throws(() => mergeAdminSettings(luna, { ai: { tasks: { targetSummary: { reasoningEffort } } } }))
  }
  for (const parameter of ['temperature', 'topP']) {
    assert.throws(() => mergeAdminSettings(luna, { ai: { tasks: { targetSummary: { [parameter]: 0.5 } } } }))
  }
  luna.ai.deployments[0].modelVersion = '2026-07-09'
  const snapshot = captureProcessingSettings(luna, 'luna-medium', now().toISOString())
  const defaults = createDefaultAdminSettings()
  for (const task of MODEL_TASK_IDS) {
    assert.equal(snapshot.tasks[task].modelName, 'gpt-5.6-luna')
    assert.equal(snapshot.tasks[task].modelVersion, '2026-07-09')
    assert.equal(snapshot.tasks[task].deploymentName, 'gpt-5.6-luna')
    assert.equal(snapshot.tasks[task].reasoningEffort, 'medium')
    assert.deepEqual(snapshot.tasks[task].capabilities, capabilities)
    assert.equal(snapshot.tasks[task].completionTokenLimit, defaults.ai.tasks[task].completionTokenLimit)
    assert.deepEqual(snapshot.tasks[task].inputBudget, defaults.ai.tasks[task].inputBudget)
  }
  assert.equal(defaults.ai.deployments[0].deploymentName, 'job-rubric')
  assert.equal(defaults.ai.deployments[0].modelName, 'gpt-5-mini')
  assert.ok(Object.values(defaults.ai.tasks).every(task => task.reasoningEffort === 'low'))
})

test('frozen snapshot resolves every task, contains no resource secrets, and is independent of later defaults', () => {
  const defaults = createDefaultAdminSettings()
  const captured = captureProcessingSettings(defaults, 'revision-1', now().toISOString())
  assert.equal(processingSettingsSnapshotSchema.safeParse(captured).success, true)
  assert.equal(Object.isFrozen(captured.settings.imports.jobs), true)
  defaults.ai.deployments[0].deploymentName = 'changed'
  assert.equal(resolveTaskModel(captured, 'summaryReview').deploymentName, 'job-rubric')
  assert.equal(resolveTaskModel(captured, 'summaryReview').completionTokenLimit, 8192)
  const tampered = structuredClone(captured)
  tampered.tasks.summaryReview.deploymentName = 'substituted'
  assert.equal(processingSettingsSnapshotSchema.safeParse(tampered).success, false)
  const publicSettings = projectPublicSettings(captured)
  assert.equal('ai' in publicSettings, false)
  assert.equal('diagnostics' in publicSettings, false)
  assert.equal('logging' in publicSettings, false)
  assert.doesNotMatch(JSON.stringify(publicSettings), /job-rubric|endpoint|credential|administratorUserIds/)
})

test('complete snapshots accommodate twelve independent deployment bindings and their version metadata', () => {
  const settings = createDefaultAdminSettings()
  const deployment = settings.ai.deployments[0]
  settings.ai.deployments = MODEL_TASK_IDS.map((task, index) => ({
    ...structuredClone(deployment), id: `model-${index}`, deploymentName: `score-production-eastus-${task}`,
    label: task, description: `Production deployment for ${task}.`, modelVersion: '2025-08-07',
  }))
  settings.ai.defaultDeploymentId = settings.ai.deployments[0].id
  for (const [index, task] of MODEL_TASK_IDS.entries()) settings.ai.tasks[task].deploymentId = settings.ai.deployments[index].id
  const snapshot = captureProcessingSettings(settings, 'twelve-deployments', now().toISOString())
  assert.equal(new Set(Object.values(snapshot.tasks).map(task => task.deploymentId)).size, 12)
  for (const task of MODEL_TASK_IDS) {
    assert.equal(snapshot.tasks[task].deploymentName, `score-production-eastus-${task}`)
    assert.equal(snapshot.tasks[task].modelVersion, '2025-08-07')
  }
  assert.ok(settingsJsonBytes(settings) <= ADMIN_SETTINGS_STORAGE_LIMITS.maxSettingsBytes)
  assert.ok(settingsJsonBytes(snapshot) <= ADMIN_SETTINGS_STORAGE_LIMITS.maxSnapshotBytes)
})

test('serialized settings and complete snapshot ceilings count UTF-8 bytes without clipping values', async () => {
  const defaults = createDefaultAdminSettings()
  const snapshot = captureProcessingSettings(defaults, 'size-baseline', now().toISOString())
  assert.ok(settingsJsonBytes(defaults) < ADMIN_SETTINGS_STORAGE_LIMITS.maxSettingsBytes)
  assert.ok(settingsJsonBytes(snapshot) < ADMIN_SETTINGS_STORAGE_LIMITS.maxSnapshotBytes)
  const oversized = structuredClone(defaults)
  oversized.appearance.announcement.text = '界'.repeat(2000)
  oversized.reports.additionalFooter = '界'.repeat(2000)
  assert.ok(JSON.stringify(oversized).length < ADMIN_SETTINGS_STORAGE_LIMITS.maxSettingsBytes)
  assert.ok(settingsJsonBytes(oversized) > ADMIN_SETTINGS_STORAGE_LIMITS.maxSettingsBytes)
  assert.throws(() => parseAdminSettings(oversized), /16384 serialized UTF-8 bytes/)
  const oversizedSnapshot = structuredClone(snapshot)
  oversizedSnapshot.capturedAt = `2026-09-21T12:00:00.${'0'.repeat(ADMIN_SETTINGS_STORAGE_LIMITS.maxSnapshotBytes)}Z`
  const parsed = processingSettingsSnapshotSchema.safeParse(oversizedSnapshot)
  assert.equal(parsed.success, false)
  assert.ok(parsed.error.issues.some(issue => issue.message.includes('32768 serialized UTF-8 bytes')))
  const server = await start()
  try {
    const initial = await server.request('/api/admin/settings')
    const rejected = await server.request('/api/admin/settings', {
      method: 'PATCH', headers: { 'If-Match': initial.body.etag }, body: {
        appearance: { announcement: { text: oversized.appearance.announcement.text } },
        reports: { additionalFooter: oversized.reports.additionalFooter },
      },
    })
    assert.equal(rejected.response.status, 400)
    assert.match(rejected.body.error.message, /16384 serialized UTF-8 bytes/)
    assert.equal(rejected.body.error.fields[0].path, '')
    assert.doesNotMatch(JSON.stringify(rejected.body), /界/)
    assert.equal(server.store.counters.publications, 0)
    assert.equal((await server.settings.read()).etag, initial.body.etag)
    assert.equal(oversized.reports.additionalFooter.length, 2000)
  } finally { await server.close() }
})

test('URL policies normalize hosts, give blocks priority, and never allow credentials or alternate schemes', () => {
  const settings = mergeAdminSettings(createDefaultAdminSettings(), { imports: { urls: {
    requireHttps: true, jobs: {
      allowedHosts: [{ hostname: 'EXAMPLE.COM.', includeSubdomains: true }],
      blockedHosts: [{ hostname: 'private.example.com', includeSubdomains: true }],
    },
  } } })
  assert.equal(settings.imports.urls.jobs.allowedHosts[0].hostname, 'example.com')
  assert.equal(urlAllowedBySettings('https://www.example.com/a', settings, 'jobs'), true)
  for (const url of ['http://example.com', 'https://private.example.com', 'https://x.private.example.com', 'https://example.com.evil.test', 'https://user:pass@example.com', 'file:///example.com', 'https://example.com:444']) {
    assert.equal(urlAllowedBySettings(url, settings, 'jobs'), false)
  }
})

test('designated admins are separate from workspace owners and identity access needs no workspace bootstrap', async () => {
  const directory = createFakeDirectoryStore()
  directory.listMembershipsForPrincipal = async () => { throw new Error('Directory unavailable') }
  const server = await start({ directory })
  try {
    const identity = await server.request('/api/session/identity')
    assert.equal(identity.response.status, 200)
    assert.equal(identity.body.capabilities.applicationAdmin, true)
    assert.equal(server.directory._workspaceCount(), 0)
    const ordinary = await server.request('/api/session/identity', { oid: OTHER_ALLOWED_OID })
    assert.equal(ordinary.body.capabilities.applicationAdmin, false)
    const denied = await server.request('/api/admin/settings', { oid: OTHER_ALLOWED_OID })
    assert.equal(denied.response.status, 403)
    assert.equal(server.store.counters.reads, 0)
    const admin = await server.request('/api/admin/settings')
    assert.equal(admin.response.status, 200)
    assert.equal(admin.response.headers.get('cache-control'), 'no-store')
    assert.equal(admin.response.headers.get('etag'), admin.body.etag)
    assert.equal(admin.body.environment.model.workerIdentityVerified, false)
    assert.equal(admin.body.fields.find(field => field.path === 'workers.jobs.maxItemsPerExecution').defaultSource, 'compiled-default')
    assert.equal(server.directory._workspaceCount(), 0)
  } finally { await server.close() }
})

test('settings updates require exact ETags, publish atomic audit/history, and preserve stale drafts through conflicts', async () => {
  const server = await start()
  try {
    const first = await server.request('/api/admin/settings')
    assert.equal(first.body.revision, 'legacy-v1')
    const missing = await server.request('/api/admin/settings', { method: 'PATCH', body: { appearance: { applicationTitle: 'Renamed' } } })
    assert.equal(missing.response.status, 428)
    for (const etag of ['*', `W/${first.body.etag}`, `${first.body.etag}, "other"`]) {
      const result = await server.request('/api/admin/settings', { method: 'PATCH', headers: { 'If-Match': etag }, body: {} })
      assert.equal(result.response.status, 400)
    }
    const changed = await server.request('/api/admin/settings', { method: 'PATCH', headers: { 'If-Match': first.body.etag }, body: { appearance: { applicationTitle: 'Admin title' } } })
    assert.equal(changed.response.status, 200)
    assert.equal(changed.body.settings.appearance.applicationTitle, 'Admin title')
    const stale = await server.request('/api/admin/settings', { method: 'PATCH', headers: { 'If-Match': first.body.etag }, body: { appearance: { applicationTitle: 'Stale title' } } })
    assert.equal(stale.response.status, 409)
    assert.equal(server.store.counters.publications, 1)
    assert.equal(server.store.revisions.size, 2)
    assert.equal(server.store.audits.size, 2)
    const history = await server.request('/api/admin/settings/history?limit=1')
    assert.equal(history.body.revisions.length, 1)
    assert.equal(history.body.revisions[0].reason, 'patch')
    assert.deepEqual(history.body.revisions[0].actor, { tenantId: TENANT_ID, oid: ALLOWED_OID })
    assert.equal(history.body.revisions[0].changes[0].path, 'appearance.applicationTitle')
    const next = await server.request(`/api/admin/settings/history?limit=1&before=${history.body.nextBefore}`)
    assert.equal(next.body.revisions[0].reason, 'initialize')
    const old = await server.request('/api/admin/settings/revisions/legacy-v1')
    assert.equal(old.body.settings.appearance.applicationTitle, 'Score')
    const restored = await server.request('/api/admin/settings/restore', { method: 'POST', headers: { 'If-Match': changed.body.etag }, body: { revision: first.body.revision } })
    assert.equal(restored.response.status, 200)
    assert.notEqual(restored.body.revision, first.body.revision)
    assert.equal(restored.body.settings.appearance.applicationTitle, 'Score')
    assert.equal(server.store.revisions.get(first.body.revision).settings.appearance.applicationTitle, 'Score')
  } finally { await server.close() }
})

test('workspace ownership never grants settings access and admin mutations keep the existing CSRF boundary', async () => {
  const server = await start()
  try {
    await seedWorkspace(server, { oid: OTHER_ALLOWED_OID })
    const owner = await server.request('/api/session', { oid: OTHER_ALLOWED_OID })
    assert.equal(owner.body.workspaces[0].role, 'owner')
    for (const path of ['/api/admin/settings', '/api/admin/settings/history', '/api/admin/deployments']) {
      assert.equal((await server.request(path, { oid: OTHER_ALLOWED_OID })).response.status, 403)
    }
    const current = await server.request('/api/admin/settings')
    const blocked = await server.request('/api/admin/settings', {
      method: 'PATCH', headers: { Origin: 'https://other.example', 'If-Match': current.body.etag }, body: { appearance: { applicationTitle: 'Blocked' } },
    })
    assert.equal(blocked.response.status, 403)
    assert.equal(server.store.counters.publications, 0)
  } finally { await server.close() }
})

test('initialization read failures are not treated as absence; store errors are never acknowledged as saves', async () => {
  const store = fakeStore()
  const server = await start({ store })
  try {
    store.failRead(new Error('do-not-expose-storage-credential'))
    const failed = await server.request('/api/admin/settings')
    assert.equal(failed.response.status, 503)
    assert.equal(store.counters.initializations, 0)
    assert.doesNotMatch(JSON.stringify(failed.body), /do-not-expose/)
    store.failRead(undefined)
    const current = await server.request('/api/admin/settings')
    store.failWrite(new Error('do-not-expose-storage-key'))
    const save = await server.request('/api/admin/settings', { method: 'PATCH', headers: { 'If-Match': current.body.etag }, body: { appearance: { applicationTitle: 'Unsaved' } } })
    assert.equal(save.response.status, 503)
    assert.equal(store.counters.publications, 0)
    assert.equal(store.audits.size, 1)
    assert.doesNotMatch(JSON.stringify(save.body), /do-not-expose/)
  } finally { await server.close() }
})

test('strict API field errors do not echo submitted secret values or trust forged deployment capabilities', async () => {
  const server = await start()
  try {
    const first = await server.request('/api/admin/settings')
    const result = await server.request('/api/admin/settings', { method: 'PATCH', headers: { 'If-Match': first.body.etag }, body: { ai: { apiKey: 'sk-do-not-expose-this' } } })
    assert.equal(result.response.status, 400)
    assert.deepEqual(result.body.error.fields, [{ path: 'ai.apiKey', message: 'Unknown setting.' }])
    assert.doesNotMatch(JSON.stringify(result.body), /sk-do-not-expose/)
    const spoofed = structuredClone(first.body.settings.ai.deployments)
    spoofed[0].capabilities.temperature = true
    const forge = await server.request('/api/admin/settings', {
      method: 'PATCH', headers: { 'If-Match': first.body.etag }, body: { ai: { deployments: spoofed, tasks: { assessment: { temperature: 0.5 } } } },
    })
    assert.equal(forge.response.status, 503)
    assert.equal(server.store.counters.publications, 0)
  } finally { await server.close() }
})

test('nonsecret portable export imports require preview ETag and explicit apply confirmation', async () => {
  const server = await start()
  try {
    const current = await server.request('/api/admin/settings')
    const exported = await server.request('/api/admin/settings/export')
    assert.equal(exported.body.format, 'score-admin-settings')
    const deployment = exported.body.settings.ai.deployments[0]
    assert.deepEqual(Object.keys(deployment).sort(), ['deploymentName', 'description', 'enabled', 'id', 'label'])
    assert.doesNotMatch(JSON.stringify(exported.body), /endpoint|resourceId|administratorUserIds|authentication|capabilities|verifiedAt/)
    exported.body.settings.appearance.applicationTitle = 'Imported title'
    const preview = await server.request('/api/admin/settings/import-preview', { method: 'POST', headers: { 'If-Match': current.body.etag }, body: { document: exported.body } })
    assert.equal(preview.response.status, 200)
    assert.equal(preview.body.changes[0].path, 'appearance.applicationTitle')
    assert.equal(server.store.counters.publications, 0)
    const unconfirmed = await server.request('/api/admin/settings/import-apply', { method: 'POST', headers: { 'If-Match': current.body.etag }, body: { document: exported.body, confirm: false } })
    assert.equal(unconfirmed.response.status, 400)
    const apply = await server.request('/api/admin/settings/import-apply', { method: 'POST', headers: { 'If-Match': current.body.etag }, body: { document: exported.body, confirm: true } })
    assert.equal(apply.response.status, 200)
    assert.equal(apply.body.settings.appearance.applicationTitle, 'Imported title')
    const injected = structuredClone(exported.body)
    injected.settings.ai.deployments[0].capabilities = { structuredOutputs: true }
    const denied = await server.request('/api/admin/settings/import-preview', { method: 'POST', headers: { 'If-Match': apply.body.etag }, body: { document: injected } })
    assert.equal(denied.response.status, 400)
  } finally { await server.close() }
})

test('runtime activation is separate from admin editing; accepted snapshots and historical reads survive store outages', async () => {
  const store = fakeStore()
  const server = await start({ store })
  try {
    await seedWorkspace(server)
    const session = await server.request('/api/session')
    assert.equal(session.response.status, 200)
    const saved = await server.request('/api/admin/settings')
    const snapshot = await server.settings.capture()
    const edit = await server.request('/api/admin/settings', { method: 'PATCH', headers: { 'If-Match': saved.body.etag }, body: { imports: { jobs: { maxBatchItems: 1 } } } })
    assert.equal(edit.response.status, 200)
    assert.equal(snapshot.settings.imports.jobs.maxBatchItems, 10)
    assert.equal((await server.settings.capture()).settings.imports.jobs.maxBatchItems, 1)
    store.failRead(new Error('offline'))
    assert.equal((await server.request('/api/features')).response.status, 503)
    assert.equal((await server.request('/api/session')).response.status, 200)
    assert.equal((await server.request(`/api/workspaces/${session.body.workspaces[0].id}/lifecycle`)).response.status, 200)
    assert.equal((await server.request('/api/workspaces', { method: 'POST', body: { name: 'No unsafe default' } })).response.status, 503)
    assert.equal(processingSettingsSnapshotSchema.safeParse(snapshot).success, true)
  } finally { await server.close() }
})

test('configured rollout pause closes new processing without reverting access, intake, export, or workspace policy', async () => {
  const store = fakeStore()
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  let sourceReads = 0
  const jobs = { store: { async get() { sourceReads++; return undefined } }, blobs: {} }
  const config = settingsConfig()
  config.realJobs = {
    cosmosEndpoint: config.cosmos.endpoint, database: 'score', container: 'job-records',
    storageAccountUrl: config.storage.accountUrl, blobContainer: 'job-sources',
  }
  const active = await start({ store, directory, state, config, jobs })
  let workspaceId
  let revision
  try {
    await seedWorkspace(active)
    const session = await active.request('/api/session')
    workspaceId = session.body.workspaces[0].id
    directory._addMembership(workspaceId, membershipFor(workspaceId, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
    const saved = await active.request('/api/admin/settings')
    const edit = await active.request('/api/admin/settings', {
      method: 'PATCH', headers: { 'If-Match': saved.body.etag }, body: {
        documents: { originalDownloadRoles: ['owner'] },
        reports: { allowedRoles: ['owner'], enabledFormats: ['csv'], defaultFormat: 'csv' },
        imports: { jobs: { maxBatchItems: 1, maxFileBytes: 1024 } },
        workspaces: { allowCreation: false }, appearance: { applicationTitle: 'Saved restrictive policy' },
      },
    })
    assert.equal(edit.response.status, 200)
    revision = edit.body.revision
  } finally { await active.close() }
  const disabledConfig = { ...config, settings: { ...config.settings, runtimeEnabled: false } }
  const disabled = await start({ store, directory, state, config: disabledConfig, jobs })
  try {
    const features = await disabled.request('/api/features')
    assert.equal(features.response.status, 200)
    assert.equal(features.body.settingsRevision, revision)
    assert.equal(features.body.limits.maxBatchFiles, 1)
    assert.equal(features.body.limits.maxFileBytes, 1024)
    assert.equal(features.body.realJobImports, false)
    assert.equal(features.body.deploymentCapabilities.realJobImports, true)
    assert.deepEqual(features.body.publicSettings.documents.originalDownloadRoles, ['owner'])
    assert.deepEqual(features.body.publicSettings.reports.allowedRoles, ['owner'])
    assert.deepEqual(features.body.publicSettings.reports.enabledFormats, ['csv'])
    assert.equal(features.body.publicSettings.appearance.applicationTitle, 'Saved restrictive policy')
    assert.equal(features.body.runtimeReadiness.configured, true)
    assert.equal(features.body.runtimeReadiness.newProcessingAllowed, false)
    assert.equal(features.body.runtimeReadiness.reason, 'worker-verification-required')
    const admin = await disabled.request('/api/admin/settings')
    assert.equal(admin.body.environment.runtimeReadiness.newProcessingAllowed, false)
    assert.equal(admin.body.settings.workspaces.allowCreation, false)
    const context = {}
    attachSettingsContext(disabledConfig, disabled.settings)(context, {}, () => {})
    assert.deepEqual((await getCurrentSettings(context)).documents.originalDownloadRoles, ['owner'])
    await assert.rejects(getProcessingAdmissionSettings(context), error => error.status === 503 && /worker readers/.test(error.message))
    await assert.rejects(getPinnedAdmissionSettings(context), error => error.status === 503)
    const original = `/api/workspaces/${workspaceId}/jobs/job-${ALLOWED_OID}/original`
    const denied = await disabled.request(original, { oid: OTHER_ALLOWED_OID })
    assert.equal(denied.response.status, 403)
    assert.equal(sourceReads, 0)
    // Owner access reaches the existing source lookup, not the new-processing rollout gate.
    assert.equal((await disabled.request(original)).response.status, 404)
    assert.equal(sourceReads, 1)
    assert.equal((await disabled.request('/api/workspaces', { method: 'POST', body: { name: 'Still blocked' } })).response.status, 403)
    store.failRead(new Error('offline'))
    assert.equal((await disabled.request('/api/features')).response.status, 503)
    assert.equal((await disabled.request(original, { oid: OTHER_ALLOWED_OID })).response.status, 503)
    assert.equal(sourceReads, 1)
    assert.equal((await disabled.request('/api/session/identity')).response.status, 200)
    assert.equal((await disabled.request('/api/session')).response.status, 200)
    assert.equal((await disabled.request(`/api/workspaces/${workspaceId}/members`, { oid: OTHER_ALLOWED_OID })).response.status, 403)
    assert.equal(store.counters.initializations, 1)
  } finally { await disabled.close() }
})

test('configured new pins require activation while accepted work retains its pin or immutable legacy baseline', async () => {
  const store = fakeStore()
  let id = 0
  const config = settingsConfig()
  const service = new AdminSettingsService({ config, store, now, newId: () => `admission-${++id}` })
  const current = await service.read()
  await service.patch(principal, { imports: { jobs: { maxBatchItems: 1 } } }, current.etag)
  const activeRequest = {}
  attachSettingsContext(config, service)(activeRequest, {}, () => {})
  const pinned = await getPinnedAdmissionSettings(activeRequest)
  assert.equal(pinned.settings.imports.jobs.maxBatchItems, 1)
  const legacy = await getSettingsForAcceptedWork(activeRequest)
  assert.equal(legacy.revision, 'legacy-v1')
  assert.equal(legacy.settings.imports.jobs.maxBatchItems, 10)
  const disabledRequest = {}
  attachSettingsContext(settingsConfig(false), service)(disabledRequest, {}, () => {})
  store.failRead(new Error('settings-offline'))
  const reads = store.counters.reads
  await assert.rejects(getPinnedAdmissionSettings(disabledRequest), error => error.status === 503)
  await assert.rejects(getProcessingAdmissionSettings(disabledRequest), error => error.status === 503)
  assert.equal(store.counters.reads, reads)
  const accepted = await getSettingsForAcceptedWork(disabledRequest, pinned)
  assert.deepEqual(accepted, pinned)
  assert.equal(Object.isFrozen(accepted.settings), true)
  await assert.rejects(getSettingsForAcceptedWork(activeRequest), /settings-offline/)
  const corrupt = structuredClone(pinned)
  corrupt.tasks.assessment.deploymentName = 'substituted'
  await assert.rejects(getSettingsForAcceptedWork(disabledRequest, corrupt), error => error.status === 503)
  store.failRead(undefined)
  store.revisions.delete('legacy-v1')
  await assert.rejects(getSettingsForAcceptedWork(activeRequest), /immutable legacy settings baseline is unavailable/)
  assert.equal(store.counters.initializations, 1)
})

test('legacy capture bootstraps on the API when necessary and uses stable immutable revision time', async () => {
  const store = fakeStore()
  let timestamp = '2026-09-21T12:00:00.000Z'
  const config = settingsConfig(false)
  config.settings.defaults = createDefaultAdminSettings({
    model: { deploymentName: 'deployed-legacy-model', modelName: 'gpt-5-mini', reasoningEffort: 'low' },
    workers: { jobs: { maxItemsPerExecution: 5 } },
  })
  const service = new AdminSettingsService({ config, store, now: () => new Date(timestamp) })
  const first = await service.captureLegacy()
  assert.equal(first.capturedAt, timestamp)
  assert.equal(first.tasks.assessment.deploymentName, 'deployed-legacy-model')
  assert.equal(first.settings.workers.jobs.maxItemsPerExecution, 5)
  assert.equal(store.counters.initializations, 1)
  const reads = store.counters.reads
  timestamp = '2026-09-22T19:30:00.000Z'
  const second = await service.captureLegacy()
  assert.deepEqual(second, first)
  assert.equal(store.counters.reads, reads, 'Existing legacy resolution must not read the current policy pointer.')
  assert.equal(store.counters.initializations, 1)
  const legacyRequest = {}
  attachSettingsContext(baseConfig())(legacyRequest, {}, () => {})
  const fallback = await getSettingsForAcceptedWork(legacyRequest)
  assert.equal(fallback.capturedAt, '1970-01-01T00:00:00.000Z')
  assert.deepEqual(await getSettingsForAcceptedWork(legacyRequest), fallback)
  const failedStore = fakeStore()
  failedStore.failRead(new Error('baseline-read-failed'))
  const unavailable = new AdminSettingsService({ config, store: failedStore, now })
  await assert.rejects(unavailable.captureLegacy(), /baseline-read-failed/)
  assert.equal(failedStore.counters.initializations, 0)
})

test('only truly unconfigured legacy mode admits without pins; configured missing service never supplies defaults', async () => {
  const legacy = {}
  attachSettingsContext(baseConfig())(legacy, {}, () => {})
  assert.doesNotThrow(() => assertNewProcessingAllowed(legacy))
  assert.equal((await getProcessingAdmissionSettings(legacy)).settings.imports.jobs.maxBatchItems, 10)
  assert.equal(await getPinnedAdmissionSettings(legacy), undefined)
  const missingService = {}
  attachSettingsContext(settingsConfig(false))(missingService, {}, () => {})
  await assert.rejects(getCurrentSettings(missingService), error => error.status === 503)
  await assert.rejects(getProcessingAdmissionSettings(missingService), error => error.status === 503)
})

test('request rollout readiness is immutable and synchronous without settings I/O or permission-policy substitution', () => {
  const store = fakeStore()
  store.failRead(new Error('readiness must not access the store'))
  const service = new AdminSettingsService({ config: settingsConfig(false), store, now })
  for (const [config, settings, configured, allowed] of [
    [baseConfig(), undefined, false, true],
    [settingsConfig(false), service, true, false],
    [settingsConfig(true), service, true, true],
    [settingsConfig(false), undefined, true, false],
    [baseConfig(), service, true, false],
  ]) {
    const request = {}
    attachSettingsContext(config, settings)(request, {}, () => {})
    const readiness = getRuntimeSettingsReadiness(request)
    assert.equal(readiness.configured, configured)
    assert.equal(readiness.newProcessingAllowed, allowed)
    assert.equal(readiness.reason, allowed ? null : 'worker-verification-required')
    assert.equal(Object.isFrozen(readiness), true)
    assert.throws(() => { readiness.newProcessingAllowed = !allowed }, TypeError)
    if (allowed) assert.doesNotThrow(() => assertNewProcessingAllowed(request))
    else assert.throws(() => assertNewProcessingAllowed(request), error => error.status === 503)
  }
  assert.equal(store.counters.reads, 0)
  assert.equal(store.counters.initializations, 0)
})

test('workspace creation policy blocks explicit admin creation while first-session reads stay empty', async () => {
  const server = await start()
  try {
    const current = await server.request('/api/admin/settings')
    await server.request('/api/admin/settings', { method: 'PATCH', headers: { 'If-Match': current.body.etag }, body: { workspaces: { allowCreation: false } } })
    const session = await server.request('/api/session')
    assert.equal(session.response.status, 200)
    assert.deepEqual(session.body.workspaces, [])
    assert.equal(session.body.capabilities.applicationAdmin, true)
    assert.equal(server.directory._workspaceCount(), 0)
    assert.equal((await server.request('/api/workspaces', { method: 'POST', body: { name: 'Blocked' } })).response.status, 403)
    assert.equal((await server.request('/api/admin/settings')).response.status, 200)
  } finally { await server.close() }
})

test('public capability composition never overrides service or Word deployment gates', () => {
  const snapshot = captureProcessingSettings(createDefaultAdminSettings(), 'revision-1', now().toISOString())
  const absent = effectiveFeatures({
    realJobImports: false, realResumeImports: false, realGradeLadders: false, realAnalyses: false,
    analysisSummaryGeneration: false, wordDocumentImports: false,
  }, snapshot, true)
  assert.equal(absent.realJobImports, false)
  assert.equal(absent.wordDocumentImports, false)
  assert.equal(absent.realAnalyses, false)
  assert.equal(absent.analysisEvidenceCorrections, false)
  assert.equal(absent.publicSettings.features.jobImports, false)
  assert.deepEqual(absent.publicSettings.imports.jobs.allowedFormats, [])
  const noWord = effectiveFeatures({
    realJobImports: true, realResumeImports: true, realGradeLadders: true, realAnalyses: true,
    analysisSummaryGeneration: true, wordDocumentImports: false,
  }, snapshot, true)
  assert.deepEqual(noWord.publicSettings.imports.jobs.allowedFormats, ['pdf', 'markdown'])
  const paused = mergeAdminSettings(snapshot.settings, { maintenance: { pauseNewWork: true } })
  const result = effectiveFeatures({
    realJobImports: true, realResumeImports: true, realGradeLadders: true, realAnalyses: true,
    analysisSummaryGeneration: true, analysisEvidenceCorrections: true, wordDocumentImports: true,
  }, captureProcessingSettings(paused, 'revision-2', now().toISOString()), true)
  assert.equal(result.realAnalyses, false)
  assert.equal(result.analysisSummaryGeneration, false)
  assert.equal(result.analysisEvidenceCorrections, false)
  assert.equal(result.deploymentCapabilities.analysisEvidenceCorrections, true)
  assert.equal(result.deploymentCapabilities.realAnalyses, true)
  assert.doesNotMatch(JSON.stringify(result), /administratorUserIds|job-rubric|modelName|credential/)
  const capabilities = {
    realJobImports: true, realResumeImports: true, realGradeLadders: true, realAnalyses: true,
    analysisSummaryGeneration: true, analysisEvidenceCorrections: true, wordDocumentImports: true,
  }
  const inactive = effectiveFeatures(capabilities, snapshot, false, true)
  assert.equal(inactive.realJobImports, false)
  assert.equal(inactive.realResumeImports, false)
  assert.equal(inactive.realGradeLadders, false)
  assert.equal(inactive.realAnalyses, false)
  assert.equal(inactive.analysisSummaryGeneration, false)
  assert.equal(inactive.analysisEvidenceCorrections, false)
  assert.equal(inactive.deploymentCapabilities.realJobImports, true)
  assert.equal(inactive.publicSettings.runtimeReadiness.newProcessingAllowed, false)
  const legacy = effectiveFeatures(capabilities, snapshot, false, false)
  assert.equal(legacy.realJobImports, true)
  assert.equal(legacy.realAnalyses, true)
  assert.equal(legacy.analysisEvidenceCorrections, true)
  assert.equal(legacy.publicSettings.runtimeReadiness.configured, false)
  const noNewRuns = captureProcessingSettings(
    mergeAdminSettings(snapshot.settings, { features: { newAnalyses: false } }), 'revision-3', now().toISOString(),
  )
  const frozenOnly = effectiveFeatures({ ...capabilities, realAnalyses: false, realResumeImports: false }, noNewRuns, true)
  assert.equal(frozenOnly.realAnalyses, false)
  assert.equal(frozenOnly.analysisEvidenceCorrections, true)
})

test('configuration never designates runtime admins through legacy IDs and keeps model endpoints deployment-owned', () => {
  const env = {
    AZURE_TENANT_ID: TENANT_ID, SCORE_ALLOWED_USER_IDS: `${ALLOWED_OID},${OTHER_ALLOWED_OID}`,
    COSMOS_ENDPOINT: 'https://example.documents.azure.com', STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net',
    APP_ORIGIN, SCORE_AUTH_MODE: 'easyauth',
  }
  const base = loadConfig(env)
  assert.equal(base.adminUserIds, undefined)
  assert.equal(base.settings, undefined)
  assert.equal(loadConfig({ ...env, SCORE_ADMIN_USER_IDS: 'not-a-guid' }).adminUserIds, undefined)
  assert.equal(loadConfig({ ...env, SCORE_ADMIN_USER_IDS: '00000000-0000-0000-0000-000000000000' }).adminUserIds, undefined)
  assert.throws(() => loadConfig({ ...env, SCORE_RUNTIME_SETTINGS_ENABLED: 'true' }), /SCORE_SETTINGS_CONTAINER/)
  assert.throws(() => loadConfig({ ...env, SCORE_SETTINGS_CONTAINER: 'workspaces' }), /separate/)
  const configured = {
    ...env, SCORE_ADMIN_USER_IDS: ALLOWED_OID.toUpperCase(), SCORE_SETTINGS_CONTAINER: 'application-settings',
    RUBRIC_MODEL_ENDPOINT: 'https://example.openai.azure.com', RUBRIC_MODEL_DEPLOYMENT: 'job-rubric',
    RUBRIC_MODEL_NAME: 'gpt-5-mini', RUBRIC_MODEL_REASONING_EFFORT: 'low', WORKER_MAX_JOBS: '5',
  }
  const config = loadConfig(configured)
  assert.equal(config.settings.runtimeEnabled, false)
  assert.equal(config.settings.defaults.workers.jobs.maxItemsPerExecution, 5)
  assert.equal(config.settings.defaultSources['workers.jobs.maxItemsPerExecution'], 'WORKER_MAX_JOBS')
  assert.equal(config.adminUserIds, undefined)
  for (const endpoint of ['https://example.com', 'http://example.openai.azure.com', 'https://user:secret@example.openai.azure.com', 'https://example.openai.azure.com/path', 'https://example.openai.azure.com?key=secret']) {
    assert.throws(() => loadConfig({ ...configured, RUBRIC_MODEL_ENDPOINT: endpoint }), /endpoint/)
  }
  const evidence = {
    SCORE_RUNTIME_SETTINGS_WORKER_VERSION: RUNTIME_SETTINGS_VERSION,
    SCORE_PROMPT_RUNTIME_WORKER_VERSION: 'score-prompt-runtime-v1',
    SCORE_RUNTIME_SETTINGS_VERIFIED_IMAGE: 'exampleregistry.azurecr.io/score-worker:verified-build',
    SCORE_RUNTIME_SETTINGS_VERIFIED_AT: '2026-09-21T12:00:00.000Z',
  }
  assert.deepEqual(loadConfig({ ...configured, ...evidence }).settings.workerVerification, {
    workerVersion: evidence.SCORE_RUNTIME_SETTINGS_WORKER_VERSION,
    image: evidence.SCORE_RUNTIME_SETTINGS_VERIFIED_IMAGE,
    verifiedAt: evidence.SCORE_RUNTIME_SETTINGS_VERIFIED_AT,
    verificationTimeOnly: true, liveHealth: false,
  })
  assert.equal(loadConfig(configured).settings.workerVerification, undefined)
  assert.throws(() => loadConfig({ ...configured, SCORE_RUNTIME_SETTINGS_WORKER_VERSION: RUNTIME_SETTINGS_VERSION }), /together/)
  assert.throws(() => loadConfig({ ...configured, ...evidence, SCORE_RUNTIME_SETTINGS_WORKER_VERSION: 'unverified' }), /contract/)
  assert.throws(() => loadConfig({ ...configured, ...evidence, SCORE_RUNTIME_SETTINGS_VERIFIED_AT: 'yesterday' }), /ISO/)
  assert.throws(() => loadConfig({ ...configured, ...evidence, SCORE_RUNTIME_SETTINGS_VERIFIED_IMAGE: 'https://user:secret@registry.example/image' }), /nonsecret/)
})

test('worker adoption evidence is admin-only, read-only and explicitly not live health', async () => {
  const config = settingsConfig(false)
  const verification = {
    workerVersion: RUNTIME_SETTINGS_VERSION, image: 'exampleregistry.azurecr.io/score-worker:verified-build',
    verifiedAt: '2026-09-21T12:00:00.000Z', verificationTimeOnly: true, liveHealth: false,
  }
  config.settings.workerVerification = { ...verification, internalToken: 'do-not-expose-unrelated-config' }
  const server = await start({ config })
  try {
    const admin = await server.request('/api/admin/settings')
    assert.deepEqual(admin.body.environment.workerVerification, verification)
    assert.doesNotMatch(JSON.stringify(admin.body), /do-not-expose-unrelated-config/)
    assert.equal(admin.body.environment.model.workerIdentityVerified, false)
    assert.equal((await server.request('/api/admin/settings', { oid: OTHER_ALLOWED_OID })).response.status, 403)
    assert.doesNotMatch(JSON.stringify((await server.request('/api/features')).body), /verified-build|workerVerification|verifiedAt/)
    assert.doesNotMatch(JSON.stringify((await server.request('/api/admin/settings/export')).body), /verified-build|workerVerification|verifiedAt/)
    const update = await server.request('/api/admin/settings', {
      method: 'PATCH', headers: { 'If-Match': admin.body.etag }, body: { workerVerification: config.settings.workerVerification },
    })
    assert.equal(update.response.status, 400)
    assert.equal(server.store.counters.publications, 0)
  } finally { await server.close() }
})

test('deployment worker defaults seed once while local job default and saved revisions remain independent', async () => {
  const environment = {
    AZURE_TENANT_ID: TENANT_ID, SCORE_ALLOWED_USER_IDS: ALLOWED_OID, SCORE_ADMIN_USER_IDS: ALLOWED_OID,
    COSMOS_ENDPOINT: 'https://example.documents.azure.com', STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net',
    APP_ORIGIN, SCORE_SETTINGS_CONTAINER: 'application-settings',
  }
  const deployed = {
    ...environment, WORKER_MAX_JOBS: '5', GRADE_WORKER_MAX_ITEMS: '5',
    RESUME_WORKER_MAX_ITEMS: '5', ANALYSIS_WORKER_MAX_ITEMS: '2',
  }
  const config = loadConfig(deployed)
  assert.equal(loadConfig(environment).settings.defaults.workers.jobs.maxItemsPerExecution, 4)
  assert.deepEqual(Object.fromEntries(Object.entries(config.settings.defaults.workers).map(([kind, worker]) => [kind, worker.maxItemsPerExecution])), {
    jobs: 5, grades: 5, resumes: 5, analyses: 2, qc: 2,
  })
  for (const [name, value] of [
    ['WORKER_MAX_JOBS', '0'], ['GRADE_WORKER_MAX_ITEMS', '21'],
    ['RESUME_WORKER_MAX_ITEMS', '1.5'], ['ANALYSIS_WORKER_MAX_ITEMS', '101'],
  ]) assert.throws(() => loadConfig({ ...deployed, [name]: value }), /integer/)
  const store = fakeStore()
  const service = new AdminSettingsService({ config, store, now, newId: () => 'worker-defaults-edit' })
  const initial = await service.read()
  const edited = await service.patch(principal, {
    workers: {
      jobs: { maxItemsPerExecution: 2 }, grades: { maxItemsPerExecution: 4 },
      resumes: { maxItemsPerExecution: 3 }, analyses: { maxItemsPerExecution: 1 },
    },
  }, initial.etag)
  const restarted = new AdminSettingsService({
    config: loadConfig({
      ...deployed, WORKER_MAX_JOBS: '7', GRADE_WORKER_MAX_ITEMS: '8',
      RESUME_WORKER_MAX_ITEMS: '9', ANALYSIS_WORKER_MAX_ITEMS: '10',
    }), store, now,
  })
  const afterRestart = await restarted.read()
  assert.equal(afterRestart.revision, edited.revision)
  assert.equal(afterRestart.etag, edited.etag)
  assert.deepEqual(Object.fromEntries(Object.entries(afterRestart.settings.workers).map(([kind, worker]) => [kind, worker.maxItemsPerExecution])), {
    jobs: 2, grades: 4, resumes: 3, analyses: 1, qc: 2,
  })
  assert.equal(afterRestart.defaults.workers.jobs.maxItemsPerExecution, 7)
  assert.equal(afterRestart.fields.find(field => field.path === 'workers.jobs.maxItemsPerExecution').defaultSource, 'WORKER_MAX_JOBS')
  assert.equal((await restarted.captureLegacy()).settings.workers.jobs.maxItemsPerExecution, 5)
  assert.equal(store.counters.initializations, 1)
  assert.equal(store.counters.publications, 1)
  assert.equal(store.revisions.size, 2)
})

test('concurrent CAS publication produces one winner and initialization never overwrites that winner', async () => {
  const store = fakeStore()
  let id = 0
  const service = new AdminSettingsService({ config: settingsConfig(), store, now, newId: () => `concurrent-${++id}` })
  const [a, b] = await Promise.all([service.read(), service.read()])
  assert.equal(a.etag, b.etag)
  const results = await Promise.allSettled([
    service.patch(principal, { appearance: { applicationTitle: 'First' } }, a.etag),
    service.patch(principal, { appearance: { applicationTitle: 'Second' } }, b.etag),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(rejected.reason.status, 409)
  assert.equal(store.revisions.size, 2)
  assert.equal(store.audits.size, 2)
  assert.equal((await service.read()).revision, [...store.revisions.keys()][1])
})
