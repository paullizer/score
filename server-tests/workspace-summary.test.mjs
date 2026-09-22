import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createJobStoreFromContainer, createResumeStoreFromContainer, createAnalysisStoreFromContainer, StoreConflictError,
} from '../dist-server/app.mjs'
import {
  ALLOWED_OID, NOT_ALLOWED_OID, OTHER_ALLOWED_OID, OTHER_TENANT_ID, TENANT_ID,
  authHeaders, baseConfig, createFakeDirectoryStore, membershipFor, principalKeyFor, startTestServer,
} from './helpers.mjs'

const WORKSPACE = 'workspace-one'
const OTHER_WORKSPACE = 'workspace-two'
const NOW = '2026-09-22T12:00:00.000Z'
const PRIVATE = 'private-source-name-and-storage-failure-detail'
const metrics = [
  { key: 'jobs', type: 'job', control: 'workspace-lifecycle', create: createJobStoreFromContainer },
  { key: 'resumes', type: 'resume', control: 'resume-lifecycle', entityId: 'resumeId', create: createResumeStoreFromContainer },
  { key: 'analyses', type: 'analysis-run', control: 'analysis-lifecycle', entityId: 'runId', create: createAnalysisStoreFromContainer },
]
const ready = count => ({ status: 'ready', count })

function record(metric, index, workspaceId = WORKSPACE) {
  return {
    id: `${metric.type}-${index}`, workspaceId, recordType: metric.type, dataKind: 'real',
    job: { dataKind: 'real', status: ['queued', 'parsing', 'generating', 'ready', 'error', 'cancelled'][index % 6] },
    resume: { dataKind: 'real', status: ['queued', 'parsing', 'profiling', 'ready', 'error', 'cancelled'][index % 6] },
    status: ['initializing', 'queued', 'running', 'complete', 'partial', 'failed', 'cancelled'][index % 7],
    source: { displayName: PRIVATE },
  }
}

function control(metric, overrides = {}) {
  return { id: `${metric.control}-workspace`, workspaceId: WORKSPACE, recordType: metric.control, state: 'active', updatedAt: NOW, ...overrides }
}

function mixedRecords(metric, count = 137) {
  const active = Array.from({ length: count }, (_, index) => record(metric, index))
  if (metric.key === 'jobs' && count >= 3) {
    active[0].rubricLifecycle = { archivedAt: NOW }
    active[1].rubricLifecycle = { deletedAt: NOW }
    active[2].job.rubricDeletedAt = NOW
  }
  const excluded = ['archivedAt', 'deletingAt', 'deletedAt'].map((field, index) => ({
    ...record(metric, `removed-${index}`), lifecycle: { [field]: NOW },
  }))
  const sample = record(metric, 'sample')
  sample.dataKind = sample.job.dataKind = sample.resume.dataKind = 'sample'
  const unmarked = record(metric, 'unmarked')
  delete unmarked.dataKind
  delete unmarked.job.dataKind
  delete unmarked.resume.dataKind
  const otherTypes = [
    'rubric-version', 'job-batch', 'job-tombstone', 'blob-writer', 'resume-batch',
    'analysis-comparison', 'analysis-candidate-narrative', 'analysis-target-narrative',
    'analysis-narrative-request', 'analysis-correction',
  ].map(recordType => ({ ...record(metric, recordType), recordType }))
  return [
    ...active, ...excluded, sample, unmarked, ...otherTypes, control(metric),
    ...Array.from({ length: 201 }, (_, index) => record(metric, index, OTHER_WORKSPACE)),
  ]
}

function aggregateContainer(records = [], pagesForQuery) {
  const queries = []
  const reads = []
  return {
    queries, reads,
    item() { reads.push('item'); assert.fail('Summary counts must not download document records.') },
    items: {
      query(spec, options) {
        queries.push({ spec, options })
        assert.match(spec.query, /^SELECT VALUE COUNT\(1\) FROM c WHERE /)
        assert.match(spec.query, /c\.workspaceId = @workspaceId/)
        assert.match(spec.query, /c\.recordType = @recordType/)
        assert.doesNotMatch(spec.query, /SELECT \*|ORDER BY|TOP /)
        const parameters = Object.fromEntries(spec.parameters.map(parameter => [parameter.name, parameter.value]))
        assert.equal(options.partitionKey, parameters['@workspaceId'])
        let values = records.filter(value => value.workspaceId === parameters['@workspaceId'] &&
          value.recordType === parameters['@recordType'])
        if (spec.query.includes("c.state != 'active'")) {
          const entityId = parameters['@recordType'] === 'resume-lifecycle' ? 'resumeId'
            : parameters['@recordType'] === 'analysis-lifecycle' ? 'runId' : undefined
          if (entityId) {
            assert.ok(spec.query.includes(`NOT IS_DEFINED(c.${entityId})`))
            assert.ok(spec.query.includes("c.operation.status != 'complete'"))
          }
          values = values.filter(value => (!entityId || value[entityId] === undefined) && value.state !== 'active' ||
            entityId && value.operation !== undefined && value.operation.status !== 'complete')
        }
        for (const [path, value] of [
          ['dataKind', value => value.dataKind],
          ['job.dataKind', value => value.job?.dataKind],
          ['resume.dataKind', value => value.resume?.dataKind],
        ]) if (spec.query.includes(`c.${path} = 'real'`)) values = values.filter(record => value(record) === 'real')
        for (const field of ['archivedAt', 'deletingAt', 'deletedAt']) {
          if (spec.query.includes(`NOT IS_DEFINED(c.lifecycle.${field})`)) values = values.filter(value => value.lifecycle?.[field] === undefined)
        }
        const pages = pagesForQuery?.(parameters['@recordType']) ?? [{ resources: [values.length], hasMoreResults: false }]
        let cursor = 0
        return {
          async fetchNext() {
            assert.ok(cursor < pages.length, 'An aggregate must stop at its terminal scalar.')
            const page = pages[cursor++]
            if (page instanceof Error) throw page
            return page
          },
          async fetchAll() { assert.fail('Summary counts must use bounded aggregate iteration.') },
        }
      },
    },
  }
}

for (const metric of metrics) {
  test(`${metric.key} aggregates count all active real records beyond 100, not samples or auxiliary records`, async () => {
    const container = aggregateContainer(mixedRecords(metric))
    assert.equal(await metric.create(container).countActive(WORKSPACE), 137)
    assert.equal(container.queries.length, 2)
    assert.equal(container.reads.length, 0)
    const query = container.queries[1].spec.query
    for (const field of ['archivedAt', 'deletingAt', 'deletedAt']) assert.ok(query.includes(`NOT IS_DEFINED(c.lifecycle.${field})`))
    assert.ok(query.includes(metric.key === 'jobs' ? "c.job.dataKind = 'real'" : "c.dataKind = 'real'"))
    if (metric.key === 'resumes') assert.ok(query.includes("c.resume.dataKind = 'real'"))
    assert.doesNotMatch(query, /rubricLifecycle|c\.status|c\.job\.status|c\.resume\.status/)
    assert.equal(await metric.create(aggregateContainer()).countActive(WORKSPACE), 0)
  })

  test(`${metric.key} aggregate scopes reject invalid workspaces before any storage access`, async () => {
    const container = aggregateContainer()
    for (const id of ['', '../escape', 'workspace one']) await assert.rejects(metric.create(container).countActive(id))
    assert.equal(container.queries.length, 0)
    assert.equal(container.reads.length, 0)
  })

  test(`${metric.key} archived or removed library guards block active counts before querying content`, async () => {
    for (const state of ['archived', 'deleting', 'deleted']) {
      const container = aggregateContainer([record(metric, 1), control(metric, { state })])
      await assert.rejects(metric.create(container).countActive(WORKSPACE), StoreConflictError)
      assert.equal(container.queries.length, 1)
      assert.equal(container.queries[0].spec.parameters.find(item => item.name === '@recordType').value, metric.control)
    }
  })

  test(`${metric.key} aggregate adapters fail explicitly on malformed control or content counts`, async () => {
    for (const broken of [metric.control, metric.type]) {
      const container = aggregateContainer([], type => type === broken ? [{ resources: [] }] : undefined)
      await assert.rejects(metric.create(container).countActive(WORKSPACE), /invalid aggregate count/)
      assert.equal(container.queries.length, broken === metric.control ? 1 : 2)
    }
    const container = aggregateContainer([], () => [
      { resources: undefined, hasMoreResults: true },
      { resources: [], hasMoreResults: true, continuationToken: 'progress' },
      { resources: [0], hasMoreResults: false },
    ])
    assert.equal(await metric.create(container).countActive(WORKSPACE), 0)
  })
}

for (const metric of metrics.filter(value => value.entityId)) {
  test(`${metric.key} counts cannot bypass pending or failed entity lifecycle operations`, async () => {
    for (const status of ['pending', 'running', 'failed']) {
      const container = aggregateContainer([
        record(metric, 1),
        control(metric, {
          [metric.entityId]: `${metric.type}-1`,
          operation: { id: 'lifecycle-operation', action: 'unarchive', status, updatedAt: NOW },
        }),
      ])
      await assert.rejects(metric.create(container).countActive(WORKSPACE), StoreConflictError)
      assert.equal(container.queries.length, 1)
    }
    const container = aggregateContainer([
      record(metric, 1),
      control(metric, {
        [metric.entityId]: `${metric.type}-1`,
        operation: { id: 'lifecycle-operation', action: 'unarchive', status: 'complete', updatedAt: NOW },
      }),
      control(metric, { [metric.entityId]: `${metric.type}-archived`, state: 'archived' }),
      control(metric, { [metric.entityId]: `${metric.type}-deleted`, state: 'deleted' }),
      control(metric, { workspaceId: OTHER_WORKSPACE, state: 'deleting' }),
    ])
    assert.equal(await metric.create(container).countActive(WORKSPACE), 1)
  })
}

async function summaryFixture(t, options = {}) {
  const directory = createFakeDirectoryStore()
  const metadata = {
    id: 'workspace', workspaceId: WORKSPACE, name: 'Test workspace', kind: 'personal',
    ownerId: principalKeyFor(TENANT_ID, ALLOWED_OID), tenantId: TENANT_ID, createdAt: NOW, updatedAt: NOW,
    ...options.metadata,
  }
  await directory.createWorkspace(metadata, membershipFor(WORKSPACE, { oid: ALLOWED_OID, role: 'owner' }))
  const privateReads = []
  const forbidden = kind => async () => { privateReads.push(kind); assert.fail(`Summary must not read ${kind}.`) }
  const state = Object.fromEntries([
    'getState', 'createState', 'putState', 'deleteState', 'acquireMutationLease', 'checkAccess',
  ].map(name => [name, forbidden(`sample state ${name}`)]))
  const blobs = Object.fromEntries([
    'read', 'list', 'listFamilies', 'listPage', 'putImmutable', 'putFenced', 'delete',
  ].map(name => [name, forbidden(`private blobs ${name}`)]))
  const containers = Object.fromEntries(metrics.map(metric => [
    metric.key, aggregateContainer(options.records?.[metric.key] ?? mixedRecords(metric)),
  ]))
  const dependencies = Object.fromEntries(metrics.map(metric => [
    metric.key, { store: metric.create(containers[metric.key]), blobs },
  ]))
  const server = await startTestServer({
    ...dependencies, ...options.dependencies, directory, state,
    config: options.config ?? baseConfig(), settings: options.settings,
  })
  t.after(() => server.close())
  return {
    ...server, containers, privateReads, dependencies,
    request: (headers = authHeaders(), workspaceId = WORKSPACE) =>
      fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/summary`, { headers }),
    async updateMetadata(changes) {
      const current = await directory.getMetadata(WORKSPACE)
      return directory.replaceMetadata({ ...current.metadata, ...changes }, current.etag)
    },
  }
}

function assertNoFeatureReads(fixture) {
  assert.deepEqual(fixture.privateReads, [])
  for (const container of Object.values(fixture.containers)) {
    assert.deepEqual(container.queries, [])
    assert.deepEqual(container.reads, [])
  }
}

function assertUnavailable(body) {
  assert.equal(body.workspaceId, WORKSPACE)
  for (const key of ['jobs', 'resumes', 'analyses']) {
    assert.equal(body[key].status, 'unavailable')
    assert.equal(typeof body[key].message, 'string')
    assert.ok(body[key].message.length > 0)
    assert.equal('count' in body[key], false)
  }
}

test('GET workspace summary returns direct no-store counts using only aggregates and directory metadata', async t => {
  const fixture = await summaryFixture(t)
  const response = await fixture.request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.deepEqual(body, { workspaceId: WORKSPACE, jobs: ready(137), resumes: ready(137), analyses: ready(137) })
  assert.equal(JSON.stringify(body).includes(PRIVATE), false)
  assert.deepEqual(fixture.privateReads, [])
  for (const container of Object.values(fixture.containers)) {
    assert.equal(container.queries.length, 2)
    assert.deepEqual(container.reads, [])
  }
})

test('summary authentication, allow-list, tenant and actual membership checks run before every feature read', async t => {
  const fixture = await summaryFixture(t)
  for (const [headers, expected] of [
    [{}, 401], [authHeaders({ oid: NOT_ALLOWED_OID }), 403],
    [authHeaders({ tenantId: OTHER_TENANT_ID }), 403], [authHeaders({ oid: OTHER_ALLOWED_OID }), 404],
  ]) {
    const response = await fixture.request(headers)
    assert.equal(response.status, expected)
    assert.ok((await response.json()).error.code)
  }
  assert.equal((await fixture.request(authHeaders(), OTHER_WORKSPACE)).status, 404)
  assert.equal((await fixture.request(authHeaders(), 'bad%20workspace')).status, 404)
  assertNoFeatureReads(fixture)
  await fixture.updateMetadata({ tenantId: OTHER_TENANT_ID })
  assert.equal((await fixture.request()).status, 404, 'A matching membership cannot bypass the stored tenant.')
  assertNoFeatureReads(fixture)
})

test('workspace viewers can read summaries but never another workspace partition', async t => {
  const fixture = await summaryFixture(t)
  fixture.directory._addMembership(WORKSPACE, membershipFor(WORKSPACE, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
  const response = await fixture.request(authHeaders({ oid: OTHER_ALLOWED_OID }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).analyses.count, 137, 'The other partition contains another 201 runs.')
  for (const container of Object.values(fixture.containers)) {
    assert.ok(container.queries.every(query => query.options.partitionKey === WORKSPACE))
  }
  assert.equal((await fixture.request(authHeaders({ oid: OTHER_ALLOWED_OID }), OTHER_WORKSPACE)).status, 404)
})

test('archived workspaces return unavailable metrics without querying any content or lifecycle impact', async t => {
  const fixture = await summaryFixture(t, { metadata: { archivedAt: NOW } })
  const response = await fixture.request()
  assert.equal(response.status, 200)
  const body = await response.json()
  assertUnavailable(body)
  assert.match(body.jobs.message, /archived/)
  assertNoFeatureReads(fixture)
})

test('pending, running and failed workspace lifecycle actions never claim active counts', async t => {
  const fixture = await summaryFixture(t)
  for (const action of ['archive', 'unarchive', 'delete']) {
    for (const status of ['pending', 'running', 'failed']) {
      await fixture.updateMetadata({ lifecycleOperation: { id: 'operation', action, status, updatedAt: NOW, error: PRIVATE } })
      const response = await fixture.request()
      assert.equal(response.status, 200)
      const body = await response.json()
      assertUnavailable(body)
      assert.equal(JSON.stringify(body).includes(PRIVATE), false)
      assertNoFeatureReads(fixture)
    }
  }
  await fixture.updateMetadata({ lifecycleOperation: { id: 'operation', action: 'unarchive', status: 'complete', updatedAt: NOW } })
  assert.deepEqual((await (await fixture.request()).json()).jobs, ready(137))
})

test('deleted workspaces retain the standard not-found error and perform no feature reads', async t => {
  const fixture = await summaryFixture(t, { metadata: { deletedAt: NOW } })
  const response = await fixture.request()
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, 'not_found')
  assertNoFeatureReads(fixture)
})

test('unconfigured stores report unavailable, while a configured empty library reports a real zero', async t => {
  const fixture = await summaryFixture(t, {
    dependencies: { jobs: undefined, analyses: undefined }, records: { resumes: [] },
    config: baseConfig({ realJobs: {}, realAnalyses: {} }),
  })
  const response = await fixture.request()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.jobs.status, 'unavailable')
  assert.match(body.jobs.message, /not configured/)
  assert.equal(body.analyses.status, 'unavailable')
  assert.deepEqual(body.resumes, ready(0))
  assert.equal(fixture.containers.jobs.queries.length, 0)
  assert.equal(fixture.containers.analyses.queries.length, 0)
})

test('disabled admissions and an unavailable settings service cannot disable saved-work counts', async t => {
  let settingsReads = 0
  const fail = async () => { settingsReads++; throw new Error(PRIVATE) }
  const fixture = await summaryFixture(t, {
    config: baseConfig({ settings: { runtimeEnabled: false }, jobLifecycleStore: {}, resumeLifecycleStore: {}, analysisLifecycleStore: {} }),
    settings: { capture: fail, current: fail },
  })
  for (const runtimeEnabled of [false, true]) {
    fixture.config.settings.runtimeEnabled = runtimeEnabled
    const response = await fixture.request()
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).jobs, ready(137))
  }
  assert.equal(settingsReads, 0)
  assert.deepEqual(fixture.privateReads, [])
})

test('feature errors and invalid store counts are isolated, logged safely, and never disguised as zero', async t => {
  const logs = []
  t.mock.method(console, 'error', (...args) => { logs.push(args) })
  const fixture = await summaryFixture(t, {
    dependencies: {
      jobs: { store: { async countActive() { throw Object.assign(new Error(PRIVATE), { statusCode: 429 }) } } },
      analyses: { store: { async countActive() { return NaN } } },
    },
  })
  const response = await fixture.request()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.jobs.status, 'unavailable')
  assert.equal(body.analyses.status, 'unavailable')
  assert.deepEqual(body.resumes, ready(137))
  assert.equal('count' in body.jobs, false)
  assert.equal('count' in body.analyses, false)
  assert.equal(logs.length, 2)
  assert.deepEqual(logs.map(([, data]) => data), [
    { metric: 'jobs', category: 'throttled' }, { metric: 'analyses', category: 'unexpected' },
  ])
  assert.equal(JSON.stringify({ logs, body }).includes(PRIVATE), false)
})

test('feature lifecycle fences return explicit per-metric unavailability without source reads', async t => {
  const logs = []
  t.mock.method(console, 'error', (...args) => { logs.push(args) })
  const fixture = await summaryFixture(t, {
    records: {
      jobs: [control(metrics[0], { state: 'archived' })],
      resumes: [control(metrics[1], { resumeId: 'resume-one', operation: { status: 'failed' } })],
    },
  })
  const body = await (await fixture.request()).json()
  assert.equal(body.jobs.status, 'unavailable')
  assert.match(body.jobs.message, /archived|lifecycle/)
  assert.equal(body.resumes.status, 'unavailable')
  assert.deepEqual(body.analyses, ready(137))
  assert.equal(fixture.containers.jobs.queries.length, 1)
  assert.equal(fixture.containers.resumes.queries.length, 1)
  assert.equal(logs.length, 2)
  assert.deepEqual(fixture.privateReads, [])
})

test('directory failures remain HTTP errors rather than partial or zero workspace counts', async t => {
  t.mock.method(console, 'error', () => {})
  const fixture = await summaryFixture(t)
  fixture.directory.getMetadata = async () => { throw new Error(PRIVATE) }
  const response = await fixture.request()
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.ok(body.error.code)
  assert.equal(JSON.stringify(body).includes(PRIVATE), false)
  assertNoFeatureReads(fixture)
})

test('a lifecycle operation started during aggregation suppresses the now-stale counts', async t => {
  let fixture
  fixture = await summaryFixture(t, {
    dependencies: { jobs: { store: { async countActive() {
      await fixture.updateMetadata({ lifecycleOperation: { id: 'operation', action: 'delete', status: 'pending', updatedAt: NOW } })
      return 137
    } } } },
  })
  const response = await fixture.request()
  assert.equal(response.status, 200)
  assertUnavailable(await response.json())
  assert.deepEqual(fixture.privateReads, [])
})

test('membership revoked during aggregation still returns the standard not-found error', async t => {
  let fixture
  fixture = await summaryFixture(t, {
    dependencies: { jobs: { store: { async countActive() {
      fixture.directory._addMembership(WORKSPACE, membershipFor(WORKSPACE, { oid: ALLOWED_OID, role: 'revoked' }))
      return 137
    } } } },
  })
  const response = await fixture.request()
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, 'not_found')
})
