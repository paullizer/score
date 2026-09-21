import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'

const fixtureDir = path.resolve(`.telemetry-tests-${process.pid}`)
const testKey = '00000000-0000-4000-8000-000000000001'
const connectionString = `InstrumentationKey=${testKey}`
const SENTINEL = 'PRIVATE-SENTINEL'
const activeChildren = new Set()
let telemetryExports

before(async () => {
  await mkdir(fixtureDir, { recursive: true })
  const common = { bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' }
  await Promise.all([
    build({
      ...common, stdin: {
        contents: [
          "import { parentPort } from 'node:worker_threads'",
          "import { telemetryPreloaded } from './server/telemetry-lifecycle.ts'",
          "import { traceOperation } from './server/telemetry-operations.ts'",
          "const value = await traceOperation('score.analysis.validation', {}, async () => 42)",
          'parentPort.postMessage({ preloaded: telemetryPreloaded(), value })',
        ].join('\n'),
        resolveDir: process.cwd(), loader: 'ts',
      }, outfile: path.join(fixtureDir, 'worker.mjs'),
    }),
    build({
      ...common, entryPoints: ['server/telemetry.ts'], outfile: path.join(fixtureDir, 'telemetry.mjs'),
      plugins: [{
        name: 'inject-local-exporter',
        setup(build) {
          build.onResolve({ filter: /^\.\/telemetry-runtime$/ }, () => ({ path: path.resolve('server-tests/telemetry-fixture-preload.mjs') }))
        },
      }],
    }),
    build({ ...common, entryPoints: ['server/telemetry.ts'], outfile: path.join(fixtureDir, 'production-telemetry.mjs') }),
    build({
      ...common, entryPoints: ['server-tests/telemetry-fixture.mjs'], outfile: path.join(fixtureDir, 'fixture.mjs'),
      plugins: [{
        name: 'isolate-app-test-import',
        setup(build) {
          build.onResolve({ filter: /dist-server[/\\]app\.mjs$/ }, () => ({ path: path.resolve('server/app.ts') }))
        },
      }],
    }),
    build({
      ...common, stdin: {
        contents: [
          "export * from './server/telemetry-runtime.ts'",
          "export * from './server/telemetry-schema.ts'",
          "export * from './server/telemetry-export.ts'",
          "export * from './server/telemetry-warnings.ts'",
          "export * from './server/telemetry-operations.ts'",
        ].join('\n'),
        resolveDir: process.cwd(), loader: 'ts',
      }, outfile: path.join(fixtureDir, 'telemetry-exports.mjs'),
    }),
  ])
  telemetryExports = await import(pathToFileURL(path.join(fixtureDir, 'telemetry-exports.mjs')).href)
})

after(async () => {
  for (const child of activeChildren) child.kill()
  await rm(fixtureDir, { recursive: true, force: true })
})

function environment(overrides = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(?:APPLICATIONINSIGHTS|APPLICATION_INSIGHTS|OTEL_|AZURE_MONITOR|NODE_OPTIONS)/i.test(key)) delete env[key]
  }
  return { ...env, NODE_ENV: 'test', APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString, ...overrides }
}

async function childProcess(preload, entry, env, args = []) {
  const child = spawn(process.execPath, [
    '--import', '@azure/monitor-opentelemetry/loader', '--import', pathToFileURL(path.join(fixtureDir, preload)).href, ...args, entry,
  ], { env: environment(env), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  activeChildren.add(child)
  let stdout = ''
  let stderr = ''
  const messages = []
  const waiters = new Set()
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('message', message => { messages.push(message); for (const waiter of waiters) waiter() })
  const exited = once(child, 'exit').then(([code, signal]) => {
    activeChildren.delete(child)
    for (const waiter of waiters) waiter()
    return { code, signal }
  })
  const waitFor = async (type, timeout = 40_000) => {
    const deadline = Date.now() + timeout
    while (!messages.some(message => message.type === type)) {
      if (child.exitCode !== null || child.signalCode) throw new Error(`Fixture exited before ${type}: ${stderr} ${stdout}`)
      if (Date.now() >= deadline) throw new Error(`Fixture timed out waiting for ${type}: ${stderr} ${stdout}`)
      await new Promise(resolve => {
        const onMessage = () => { clearTimeout(timer); waiters.delete(onMessage); resolve() }
        const timer = setTimeout(onMessage, 100)
        waiters.add(onMessage)
      })
    }
    return messages.find(message => message.type === type)
  }
  return {
    child, messages, waitFor, exited, output: () => stdout + stderr,
    envelopes: () => messages.filter(message => message.type === 'export').flatMap(message => message.envelopes),
  }
}

async function startFixture(env = {}) {
  const fixture = await childProcess('telemetry.mjs', path.join(fixtureDir, 'fixture.mjs'), env)
  return { ...fixture, ready: await fixture.waitFor('ready') }
}

async function stopFixture(fixture) {
  fixture.child.send({ type: 'stop' })
  const shutdown = await fixture.waitFor('shutdown')
  assert.equal((await fixture.exited).code, 0, fixture.output())
  return shutdown
}

function data(envelopes, type) {
  return envelopes.filter(item => item.data.baseType === type).map(item => ({ ...item.data.baseData, tags: item.tags, sampleRate: item.sampleRate }))
}

function sumMetrics(envelopes, name) {
  return data(envelopes, 'MetricData').flatMap(item => item.metrics).filter(metric => metric.name === name)
    .reduce((sum, metric) => sum + metric.value, 0)
}

test('Node 24 packaged preload captures one correlated request per HTTP call and real Azure SDK dependencies', { timeout: 90_000 }, async () => {
  const fixture = await startFixture({
    SCORE_TELEMETRY_FIXTURE_CONSOLE: 'true',
    SCORE_TELEMETRY_FIXTURE_WORKER: 'true',
    AZURE_LOG_LEVEL: 'verbose',
    APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL: 'ALL',
    OTEL_RESOURCE_ATTRIBUTES: `service.name=${SENTINEL},host.name=${SENTINEL},user.name=${SENTINEL}`,
    WEBSITE_SITE_NAME: `${SENTINEL}-app`, WEBSITE_INSTANCE_ID: `${SENTINEL}-instance`,
    APPLICATIONINSIGHTS_CONFIGURATION_CONTENT: JSON.stringify({
      enableLiveMetrics: true, enableStandardMetrics: true,
      browserSdkLoaderOptions: { enabled: true },
      instrumentationOptions: { console: { enabled: true } },
    }),
  })
  assert.match(fixture.ready.node, /^24\./)
  assert.equal(fixture.ready.preloaded, true)
  assert.deepEqual(fixture.ready.workerState, { preloaded: false, value: 42 })
  const route = `/api/workspaces/${SENTINEL}-workspace/analyses/${SENTINEL}-run/comparisons/${SENTINEL}-comparison`
  const headers = { cookie: `${SENTINEL}-cookie`, authorization: `Bearer ${SENTINEL}-token` }
  const successful = await fetch(`${fixture.ready.url}${route}?name=${SENTINEL}&text=${SENTINEL}`, { headers })
  assert.equal(successful.status, 200, JSON.stringify(fixture.messages.filter(item => item.type === 'fixture-error')))
  await successful.text()
  const failed = await fetch(`${fixture.ready.url}${route}?fail=1&token=${SENTINEL}`, { headers })
  assert.equal(failed.status, 503)
  await failed.text()
  assert.equal((await fetch(`${fixture.ready.apiUrl}/api/features?private=${SENTINEL}`)).status, 401)
  assert.equal((await fetch(`${fixture.ready.apiUrl}/api/features`, { headers: fixture.ready.auth })).status, 200)
  const invalid = await fetch(`${fixture.ready.apiUrl}/api/workspaces`, {
    method: 'POST', headers: { ...fixture.ready.auth, 'content-type': 'application/json' }, body: `{"private":"${SENTINEL}"`,
  })
  assert.equal(invalid.status, 400)
  assert.equal((await fetch(`${fixture.ready.apiUrl}/api/${SENTINEL}-unknown`, { headers: fixture.ready.auth })).status, 404)
  const html = await (await fetch(`${fixture.ready.apiUrl}/workspaces/${SENTINEL}`, { headers: fixture.ready.auth })).text()
  assert.match(html, /Score test fixture shell/)
  assert.doesNotMatch(html, /js\.monitor\.azure|applicationinsights/i)
  const abort = new AbortController()
  const pending = fetch(`${fixture.ready.url}/api/workspaces/${SENTINEL}/analyses/${SENTINEL}/summaries`, { signal: abort.signal })
    .then(() => 'unexpected response', error => error.name)
  await fixture.waitFor('slow-started')
  abort.abort()
  assert.equal(await pending, 'AbortError')
  const shutdown = await stopFixture(fixture)
  assert.equal(shutdown.result, 'flushed', fixture.output())
  assert.ok(shutdown.duration < 3_500)
  assert.ok(!fixture.output().includes(testKey), fixture.output())
  assert.doesNotMatch(fixture.output().replace(`${SENTINEL}-console-must-not-be-harvested`, ''), /PRIVATE-SENTINEL/i)
  const envelopes = fixture.envelopes()
  assert.ok(envelopes.length > 0, fixture.output())
  assert.ok(!JSON.stringify(envelopes).toLowerCase().includes(SENTINEL.toLowerCase()), JSON.stringify(envelopes))
  const requests = data(envelopes, 'RequestData')
  assert.equal(requests.length, 8, JSON.stringify(requests))
  assert.deepEqual(requests.map(item => Number(item.responseCode)).sort(), [200, 200, 200, 400, 401, 404, 499, 503])
  assert.equal(sumMetrics(envelopes, 'score.http.request.count'), 8)
  const comparisonRequests = requests.filter(item => item.name.includes('/comparisons/'))
  assert.equal(comparisonRequests.length, 2)
  assert.ok(comparisonRequests.every(item => item.name === 'GET /api/workspaces/:workspaceId/analyses/:runId/comparisons/:comparisonId'))
  assert.ok(comparisonRequests.every(item => item.duration !== '00:00:00.0000000'))
  assert.ok(fixture.messages.filter(item => item.type === 'request-context').every(item => item.recording))
  const dependencies = data(envelopes, 'RemoteDependencyData')
  for (const request of comparisonRequests) {
    const operation = dependencies.find(item => item.name === 'score.analysis.comparison' && item.tags['ai.operation.parentId'] === request.id)
    assert.ok(operation, JSON.stringify(dependencies))
    assert.equal(operation.tags['ai.operation.id'], request.tags['ai.operation.id'])
    assert.ok(dependencies.some(item => item.type === 'Azure blob' && item.tags['ai.operation.id'] === request.tags['ai.operation.id']))
    assert.ok(dependencies.some(item => item.type === 'Azure Cosmos DB' && item.tags['ai.operation.id'] === request.tags['ai.operation.id']), JSON.stringify(dependencies))
  }
  assert.ok(dependencies.some(item => item.name === 'score.auth'))
  assert.ok(dependencies.some(item => item.name === 'score.analysis.validation'))
  assert.ok(data(envelopes, 'ExceptionData').some(item => item.exceptions[0].message === 'dependency'))
  assert.ok(envelopes.every(item => item.tags['ai.cloud.role'] === 'score-api' && item.tags['ai.cloud.roleInstance'] === 'score-api'))
  assert.ok(envelopes.every(item => !('url' in item.data.baseData) && !('data' in item.data.baseData)))
  const durations = data(envelopes, 'MetricData').filter(item => item.metrics.some(metric => metric.name === 'score.http.request.duration'))
  assert.equal(durations.reduce((sum, item) => sum + item.metrics[0].count, 0), 8)
  assert.ok(durations.every(item => item.metrics[0].value >= 0))
})

test('exporter failure never fails a healthy API and diagnostics remain bounded and sanitized', { timeout: 45_000 }, async () => {
  const fixture = await startFixture({ SCORE_TELEMETRY_FIXTURE_MODE: 'fail' })
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await fetch(`${fixture.ready.apiUrl}/api/features`, { headers: fixture.ready.auth })).status, 200)
  }
  await fixture.waitFor('export')
  assert.equal((await fetch(`${fixture.ready.apiUrl}/api/features`, { headers: fixture.ready.auth })).status, 200)
  const shutdown = await stopFixture(fixture)
  assert.equal(shutdown.result, 'failed')
  assert.match(fixture.output(), /\[score\.telemetry\] export_failed/)
  assert.equal((fixture.output().match(/export_failed/g) ?? []).length, 1)
  assert.ok(!fixture.output().includes(SENTINEL))
  assert.ok(!fixture.output().includes(testKey))
})

test('hanging exporters have bounded shutdown without blocking API requests', { timeout: 45_000 }, async () => {
  const fixture = await startFixture({ SCORE_TELEMETRY_FIXTURE_MODE: 'hang' })
  assert.equal((await fetch(`${fixture.ready.apiUrl}/api/features`, { headers: fixture.ready.auth })).status, 200)
  await fixture.waitFor('export')
  assert.equal((await fetch(`${fixture.ready.apiUrl}/api/features`, { headers: fixture.ready.auth })).status, 200)
  const shutdown = await stopFixture(fixture)
  assert.equal(shutdown.result, 'timed_out')
  assert.ok(shutdown.duration < 750, String(shutdown.duration))
  assert.match(fixture.output(), /shutdown_timeout/)
  assert.ok(!fixture.output().includes(SENTINEL))
})

test('25 percent trace sampling keeps parent correlation and counts every request in bounded metrics', { timeout: 60_000 }, async () => {
  const fixture = await startFixture({ SCORE_TELEMETRY_FIXTURE_SAMPLING: 'partial' })
  for (let index = 0; index < 64; index += 1) {
    const traceId = createHash('sha256').update(`score-telemetry-fixture-${index}`).digest('hex').slice(0, 32)
    const response = await fetch(`${fixture.ready.apiUrl}/api/features`, {
      headers: { ...fixture.ready.auth, traceparent: `00-${traceId}-1234567890abcdef-01` },
    })
    assert.equal(response.status, 200)
    await response.text()
  }
  assert.equal((await stopFixture(fixture)).result, 'flushed', fixture.output())
  const envelopes = fixture.envelopes()
  const requests = data(envelopes, 'RequestData')
  assert.ok(requests.length > 0 && requests.length < 64, String(requests.length))
  assert.ok(requests.every(item => item.sampleRate === 25))
  assert.equal(sumMetrics(envelopes, 'score.http.request.count'), 64)
  const dependencies = data(envelopes, 'RemoteDependencyData')
  for (const dependency of dependencies) {
    assert.equal(dependency.sampleRate, 25)
    assert.ok(requests.some(request =>
      request.tags['ai.operation.id'] === dependency.tags['ai.operation.id'] && request.id === dependency.tags['ai.operation.parentId']))
  }
})

test('production preload intentionally disables telemetry when the connection string is missing', { timeout: 30_000 }, async () => {
  const fixture = await childProcess('production-telemetry.mjs', "console.log('ENTRY_REACHED')", {
    APPLICATIONINSIGHTS_CONNECTION_STRING: '',
  }, ['--input-type=module', '--eval'])
  assert.equal((await fixture.exited).code, 0, fixture.output())
  assert.match(fixture.output(), /disabled: no connection string configured/)
  assert.match(fixture.output(), /ENTRY_REACHED/)
  assert.equal(fixture.envelopes().length, 0)
})

test('invalid configured telemetry fails before the application entry and does not disclose configuration', { timeout: 30_000 }, async () => {
  const fixture = await childProcess('production-telemetry.mjs', "console.log('ENTRY_REACHED')", {
    APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=${SENTINEL};IngestionEndpoint=https://example.test/?token=${SENTINEL}`,
  }, ['--input-type=module', '--eval'])
  assert.notEqual((await fixture.exited).code, 0)
  assert.match(fixture.output(), /configuration_invalid/)
  assert.ok(!fixture.output().includes(SENTINEL))
  assert.ok(!fixture.output().includes('ENTRY_REACHED'))
})

test('strict export boundary rebuilds spans, metrics and exceptions with no user/resource/event payloads', () => {
  const { sanitizeExportBody } = telemetryExports
  const common = {
    name: SENTINEL, time: '2026-09-21T12:00:00.000Z', iKey: SENTINEL, seq: SENTINEL, sampleRate: 25,
    tags: {
      'ai.cloud.role': SENTINEL, 'ai.cloud.roleInstance': SENTINEL, 'ai.user.id': SENTINEL, 'ai.location.ip': SENTINEL,
      'ai.operation.id': 'a'.repeat(32), 'ai.operation.parentId': 'b'.repeat(16),
    },
  }
  const properties = {
    'http.method': 'GET', 'http.route': `/api/workspaces/${SENTINEL}/analyses/${SENTINEL}/comparisons/${SENTINEL}?private=${SENTINEL}`,
    'score.error.category': 'dependency', 'score.read.count': '4', 'score.read.bytes': SENTINEL,
    'private.name': SENTINEL, 'resource.host': SENTINEL, 'exception.message': SENTINEL,
  }
  const payload = [
    { ...common, data: { baseType: 'RequestData', baseData: {
      name: `GET /api/workspaces/${SENTINEL}/analyses/${SENTINEL}/comparisons/${SENTINEL}`, id: 'c'.repeat(16),
      duration: '00:00:00.1230000', responseCode: '503', success: false, url: SENTINEL, properties, measurements: { [SENTINEL]: 1 },
    } } },
    { ...common, data: { baseType: 'RemoteDependencyData', baseData: {
      name: SENTINEL, id: 'd'.repeat(16), data: SENTINEL, target: SENTINEL, type: SENTINEL,
      duration: '00:00:00.0010000', resultCode: '500', success: false, properties,
    } } },
    { ...common, data: { baseType: 'ExceptionData', baseData: {
      exceptions: [{ typeName: SENTINEL, message: SENTINEL, stack: SENTINEL }], problemId: SENTINEL, properties,
    } } },
    { ...common, data: { baseType: 'MessageData', baseData: { message: SENTINEL, properties } } },
    { ...common, data: { baseType: 'MetricData', baseData: {
      metrics: [{ name: 'score.operation.count', value: 4, count: 4, custom: SENTINEL }, { name: SENTINEL, value: 99 }], properties,
    } } },
  ]
  const safe = sanitizeExportBody(JSON.stringify(payload), testKey)
  assert.ok(!safe.includes(SENTINEL), safe)
  const parsed = JSON.parse(safe)
  assert.equal(parsed.length, 4)
  assert.ok(parsed.every(item => item.iKey === testKey && item.sampleRate === 25))
  assert.ok(parsed.every(item => Object.values(item.data.baseData.properties).every(value => typeof value === 'string')))
  assert.equal(parsed[0].data.baseData.duration, '00:00:00.1230000')
  assert.equal(parsed[0].data.baseData.properties['score.read.count'], '4')
  assert.equal(parsed[0].tags['ai.operation.id'], 'a'.repeat(32))
  assert.throws(() => sanitizeExportBody('invalid json', testKey))
  assert.throws(() => sanitizeExportBody('x'.repeat(2_000_001), testKey))
})

test('operation helper preserves values and errors with telemetry disabled, with bounded names and categories', async () => {
  const { traceOperation, safeOperationName, errorCategory, safeAttributes, readTelemetryConfiguration, createTelemetryWarnings } = telemetryExports
  assert.equal(await traceOperation('score.analysis.validation', {}, async () => 42), 42)
  const failure = Object.assign(new Error(SENTINEL), { status: 403 })
  await assert.rejects(traceOperation(SENTINEL, { private: SENTINEL }, async () => { throw failure }), error => error === failure)
  assert.equal(safeOperationName(SENTINEL), 'score.operation.other')
  assert.equal(errorCategory(failure), 'forbidden')
  assert.deepEqual(safeAttributes({ 'score.read.count': 1e9, 'private': SENTINEL, 'score.summary.kind': SENTINEL }), { 'score.read.count': 1_000_000 })
  assert.equal(readTelemetryConfiguration(undefined), undefined)
  for (const value of [
    SENTINEL, `InstrumentationKey=${testKey};IngestionEndpoint=http://example.test`,
    `InstrumentationKey=${testKey};IngestionEndpoint=https://dc.services.visualstudio.com/${SENTINEL}`,
    `InstrumentationKey=${testKey};InstrumentationKey=${testKey}`,
    `InstrumentationKey=${testKey};Secret=${SENTINEL}`,
  ]) assert.throws(() => readTelemetryConfiguration(value), error => !error.message.includes(SENTINEL))
  const warnings = []
  const warn = createTelemetryWarnings(code => warnings.push(code))
  for (let index = 0; index < 100; index += 1) warn('export_failed')
  assert.deepEqual(warnings, ['export_failed'])
})

test('Docker and npm use the same separate preload and ESM loader before the packaged server', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(pkg.scripts.start, 'node --import @azure/monitor-opentelemetry/loader --import ./dist-server/telemetry.mjs dist-server/server.mjs')
  const dockerfile = await readFile('Dockerfile', 'utf8')
  assert.match(dockerfile, /CMD \["node", "--import", "@azure\/monitor-opentelemetry\/loader", "--import", "\.\/dist-server\/telemetry\.mjs", "dist-server\/server\.mjs"\]/)
  assert.match(await readFile('scripts/build-server.mjs', 'utf8'), /entryPoints: \['server\/telemetry\.ts'\]/)
})
