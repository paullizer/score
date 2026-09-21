import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsSnapshot } from './runtime-settings-test-support.mjs'
const { fetchSettings } = await loadWorker('../worker/settings.ts')
const {
  createPlaywrightRenderer,
  createRemoteRenderer,
  isPublicAddress,
  safeFetch,
  sanitizedBrowserEnvironment,
  validatePublicUrl,
} = await loadWorker('../worker/runtime.ts')

test('public URL validation rejects credentials, nonstandard ports, and non-public address classes', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '100.64.1.1',
    '169.254.169.254', '168.63.129.16', '224.0.0.1', '::1', 'fe80::1', '::ffff:127.0.0.1',
  ]) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress('93.184.216.34'), true)
  assert.equal(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946'), true)
  assert.throws(() => validatePublicUrl('https://user:pass@example.com/job'), /credentials/)
  assert.throws(() => validatePublicUrl('https://example.com:8443/job'), /standard/)
  assert.throws(() => validatePublicUrl('file:///etc/passwd'), /HTTP/)
})

test('safe fetch rejects every mixed DNS answer before transport and pins the accepted address', async () => {
  let transportCalls = 0
  await assert.rejects(
    safeFetch('https://jobs.example/job', {
      resolver: async () => ['93.184.216.34', '10.0.0.2'],
      transport: async () => {
        transportCalls += 1
        throw new Error('must not connect')
      },
    }),
    error => error.code === 'unsafe-url',
  )
  assert.equal(transportCalls, 0)

  let resolverCalls = 0
  let request
  const response = await safeFetch('https://jobs.example/job', {
    resolver: async () => {
      resolverCalls += 1
      return resolverCalls === 1 ? ['93.184.216.34'] : ['127.0.0.1']
    },
    headers: { authorization: 'Bearer cloud-token', cookie: 'session=secret', accept: 'text/html' },
    transport: async value => {
      request = value
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Job</main>') }
    },
  })
  assert.equal(response.status, 200)
  assert.equal(resolverCalls, 1)
  assert.equal(request.address, '93.184.216.34')
  assert.equal(request.headers.authorization, undefined)
  assert.equal(request.headers.cookie, undefined)
})

test('redirect destinations are independently resolved and unsafe redirects never connect', async () => {
  const connected = []
  await assert.rejects(
    safeFetch('https://public.example/job', {
      resolver: async hostname => hostname === 'public.example' ? ['93.184.216.34'] : ['169.254.169.254'],
      transport: async request => {
        connected.push(request.url.hostname)
        return {
          status: 302,
          headers: { location: 'http://metadata.example/latest' },
          body: new Uint8Array(),
        }
      },
    }),
    error => error.code === 'unsafe-url',
  )
  assert.deepEqual(connected, ['public.example'])
})

test('pinned transport preserves bounded POST requests without forwarding credentials', async () => {
  let request
  await safeFetch('https://api.example/graphql', {
    method: 'POST',
    body: Buffer.from('{"query":"job"}'),
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret', cookie: 'secret=true' },
    resolver: async () => ['93.184.216.34'],
    transport: async value => {
      request = value
      return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }
    },
  })
  assert.equal(request.method, 'POST')
  assert.equal(Buffer.from(request.body).toString('utf8'), '{"query":"job"}')
  assert.equal(request.headers.authorization, undefined)
  assert.equal(request.headers.cookie, undefined)
})

test('remote renderer client uses only the fixed worker interface and validates output', async () => {
  let request
  const renderer = createRemoteRenderer('https://renderer.internal', async (url, init) => {
    request = { url, init }
    return new Response(JSON.stringify({
      html: '<html><main>Rendered job</main></html>',
      finalUrl: 'https://jobs.example/final',
    }), { status: 200 })
  })
  const rendered = await renderer.render('https://jobs.example/start', {})
  assert.deepEqual(rendered, {
    html: '<html><main>Rendered job</main></html>',
    finalUrl: 'https://jobs.example/final',
  })
  assert.equal(request.url, 'https://renderer.internal/render')
  assert.deepEqual(request.init.headers, {
    'content-type': 'application/json',
    'x-score-worker': 'job-ingestion',
  })
  assert.equal(JSON.parse(request.init.body).url, 'https://jobs.example/start')
})

test('only local rendering without a captured policy preserves the separate 24 MiB legacy ceiling', async () => {
  const html = 'x'.repeat(3 * 1024 * 1024)
  const waits = []
  const context = {
    route: async () => {}, routeWebSocket: async () => {}, on: () => {}, close: async () => {},
    newPage: async () => ({
      goto: async () => {}, url: () => 'https://jobs.example/role',
      content: async () => html, waitForLoadState: async (_state, options) => { waits.push(options.timeout) },
    }),
  }
  const renderer = await createPlaywrightRenderer(async () => ({ newContext: async () => context, close: async () => {} }), {})
  assert.equal((await renderer.render('https://jobs.example/role', {})).html.length, html.length)
  for (const revision of ['legacy-v1', 'current-policy']) {
    const captured = fetchSettings({}, settingsSnapshot(() => {}, revision), 'jobs')
    await assert.rejects(renderer.render('https://jobs.example/role', captured), error => error.code === 'source-too-large')
  }
  assert.deepEqual(waits, [10_000, 2000, 2000])
})

test('a legacy-v1 pin enforces its recorded local DOM, settle and navigation budgets', async () => {
  const waits = [], navigation = []
  const context = {
    route: async () => {}, routeWebSocket: async () => {}, on: () => {}, close: async () => {},
    newPage: async () => ({
      goto: async (_url, options) => { navigation.push(options.timeout) },
      url: () => 'https://jobs.example/role',
      content: async () => 'x'.repeat(1025),
      waitForLoadState: async (_state, options) => { waits.push(options.timeout) },
    }),
  }
  const snapshot = settingsSnapshot(settings => {
    settings.rendering.maxDomBytes = 1024
    settings.rendering.settleMilliseconds = 0
    settings.rendering.timeoutMilliseconds = 1000
  }, 'legacy-v1')
  const renderer = await createPlaywrightRenderer(async () => ({ newContext: async () => context, close: async () => {} }), {})
  await assert.rejects(renderer.render('https://jobs.example/role', fetchSettings({}, snapshot, 'jobs')),
    error => error.code === 'source-too-large')
  assert.deepEqual(waits, [])
  assert.deepEqual(navigation, [1000])
})

test('a legacy-v1 pin enforces its aggregate local subresource budget', async () => {
  let routeHandler
  const limits = []
  const route = suffix => ({
    request: () => ({
      url: () => `https://jobs.example/${suffix}`, method: () => 'GET',
      postDataBuffer: () => null, headers: () => ({}),
    }),
    fulfill: async () => {}, abort: async () => {},
  })
  const context = {
    route: async (_pattern, handler) => { routeHandler = handler },
    routeWebSocket: async () => {}, on: () => {}, close: async () => {},
    newPage: async () => ({
      goto: async () => {
        await routeHandler(route('role'))
        await routeHandler(route('asset'))
      },
      url: () => 'https://jobs.example/role',
      content: async () => '<main>Document</main>',
      waitForLoadState: async () => assert.fail('A zero settle budget must be honored.'),
    }),
  }
  const snapshot = settingsSnapshot(settings => {
    settings.rendering.maxAggregateBytes = 64 * 1024
    settings.rendering.maxDomBytes = 32 * 1024
    settings.rendering.settleMilliseconds = 0
  }, 'legacy-v1')
  const options = fetchSettings({
    resolver: async () => ['93.184.216.34'],
    transport: async request => {
      limits.push(request.maxBytes)
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.alloc(40 * 1024, 0x20) }
    },
  }, snapshot, 'jobs')
  const renderer = await createPlaywrightRenderer(async () => ({ newContext: async () => context, close: async () => {} }), {})
  await assert.rejects(renderer.render('https://jobs.example/role', options), error => error.code === 'source-too-large')
  assert.deepEqual(limits, [64 * 1024, 24 * 1024])
})

test('browser traffic, including subresources, uses the same pinned safe transport', async () => {
  let routeHandler
  const events = []
  const routeFor = url => ({
    request: () => ({
      url: () => url,
      method: () => 'GET',
      postDataBuffer: () => null,
      headers: () => ({ accept: 'text/html', authorization: 'Bearer browser-secret', cookie: 'x=y' }),
    }),
    fulfill: async response => events.push(['fulfill', url, response.status]),
    abort: async () => events.push(['abort', url]),
  })

  const context = {
    route: async (_pattern, handler) => { routeHandler = handler },
    routeWebSocket: async () => {},
    on: () => {},
    newPage: async () => ({
      goto: async () => {
        await routeHandler(routeFor('https://jobs.example/job'))
        await routeHandler(routeFor('http://metadata.example/token'))
      },
      waitForLoadState: async () => {},
      content: async () => '<html><main><h1>Engineer</h1></main></html>',
      url: () => 'https://jobs.example/job',
    }),
    close: async () => {},
  }
  const browser = { newContext: async () => context, close: async () => {} }
  const connected = []
  const renderer = await createPlaywrightRenderer(async options => {
    assert.equal(options.chromiumSandbox, true)
    return browser
  }, { PATH: 'safe', AZURE_CLIENT_ID: 'must-not-pass', IDENTITY_HEADER: 'must-not-pass' })
  await assert.rejects(renderer.render('https://jobs.example/job', {
    resolver: async hostname => hostname === 'jobs.example' ? ['93.184.216.34'] : ['169.254.169.254'],
    transport: async request => {
      connected.push([request.url.hostname, request.address, request.headers.authorization, request.headers.cookie])
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>ok</html>') }
    },
  }), error => error.code === 'unsafe-url')
  assert.deepEqual(connected, [['jobs.example', '93.184.216.34', undefined, undefined]])
  assert.deepEqual(events, [
    ['fulfill', 'https://jobs.example/job', 200],
    ['abort', 'http://metadata.example/token'],
  ])
  assert.deepEqual(sanitizedBrowserEnvironment({ PATH: 'safe', AZURE_TENANT_ID: 'secret', HOME: 'home' }), { PATH: 'safe', HOME: 'home' })
})
