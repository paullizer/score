import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadWorker } from '../worker-tests/shared-model-loader.mjs'
import { settingsSnapshot } from '../worker-tests/runtime-settings-test-support.mjs'
const { renderJobPage } = await loadWorker('../renderer/browser.ts')

function renderPolicy(change = () => {}) {
  const { settings } = settingsSnapshot(change)
  return {
    rendering: settings.rendering,
    urls: { ...settings.imports.urls.jobs, requireHttps: settings.imports.urls.requireHttps,
      timeoutMilliseconds: settings.imports.urls.timeoutMilliseconds,
      maxResponseBytes: settings.imports.urls.maxResponseBytes, maxRedirects: settings.imports.urls.maxRedirects },
  }
}

function response(url, body, status = 200, headers = { 'content-type': 'text/html' }) {
  return {
    status,
    headers,
    body: new TextEncoder().encode(body),
    url,
  }
}

function createFakeBrowser(options = {}) {
  const state = {
    browserClosed: 0,
    contextClosed: 0,
    contextOptions: undefined,
    continued: 0,
    fetchCalled: 0,
    requests: [],
    webSocketsClosed: 0,
  }
  let routeHandler
  let currentUrl = 'about:blank'
  let html = ''
  const pageListeners = new Map()
  const contextListeners = new Map()

  async function dispatch(url, resourceType = 'script', method = 'GET', headers = {}, body) {
    const result = { aborted: false, fulfilled: false }
    const request = {
      headers: () => headers,
      method: () => method,
      postDataBuffer: () => body === undefined ? null : Buffer.from(body),
      resourceType: () => resourceType,
      url: () => url,
    }
    const route = {
      request: () => request,
      abort: async () => {
        result.aborted = true
        state.requests.push({ event: 'abort', url })
      },
      fulfill: async (fulfilled) => {
        result.fulfilled = true
        state.requests.push({ event: 'fulfill', url, response: fulfilled })
        if (resourceType === 'document') html = Buffer.from(fulfilled.body).toString('utf8')
      },
      continue: async () => {
        state.continued += 1
      },
      fetch: async () => {
        state.fetchCalled += 1
      },
    }
    await routeHandler(route)
    return result
  }

  const page = {
    close: async () => {},
    content: async () => html,
    goto: async (url) => {
      currentUrl = url
      const document = await dispatch(url, 'document')
      if (!document.fulfilled) throw new Error('document was not fulfilled')
      if (options.onGoto) await options.onGoto({ dispatch, state })
    },
    on: (event, listener) => {
      pageListeners.set(event, listener)
      return page
    },
    url: () => currentUrl,
    waitForLoadState: async () => {
      if (options.waitForLoadState) await options.waitForLoadState()
    },
    waitForTimeout: async () => {},
  }

  const context = {
    close: async () => {
      state.contextClosed += 1
    },
    newPage: async () => {
      contextListeners.get('page')?.(page)
      return page
    },
    on: (event, listener) => {
      contextListeners.set(event, listener)
      return context
    },
    route: async (_pattern, handler) => {
      routeHandler = handler
    },
    routeWebSocket: async (_pattern, handler) => {
      handler({
        close: () => {
          state.webSocketsClosed += 1
        },
      })
    },
  }

  const browser = {
    close: async () => {
      state.browserClosed += 1
    },
    newContext: async (contextOptions) => {
      state.contextOptions = contextOptions
      return context
    },
  }

  return { browser, dispatch, state }
}

test('all HTTP traffic is fulfilled by the injected fetcher with sensitive headers stripped', async () => {
  const fetches = []
  const fake = createFakeBrowser({
    onGoto: async ({ dispatch }) => {
      const image = await dispatch('https://jobs.example/logo.png', 'image')
      assert.equal(image.aborted, true)
      const unsupported = await dispatch('https://jobs.example/update', 'fetch', 'PATCH')
      assert.equal(unsupported.aborted, true)
      await dispatch(
        'https://cdn.example/app.js',
        'script',
        'GET',
        {
          accept: 'text/javascript',
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'proxy-authorization': 'Basic secret',
        },
      )
      await dispatch(
        'https://api.example/search',
        'fetch',
        'POST',
        {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
          cookie: 'session=secret',
        },
        '{"query":"engineer"}',
      )
    },
  })
  const fetcher = async (url, options) => {
    fetches.push({ url, options })
    if (url.endsWith('.js')) return response(url, 'document.title = "loaded"', 200, { 'content-type': 'text/javascript' })
    if (url === 'https://api.example/search') {
      return response(url, '{"jobs":[]}', 200, {
        'content-type': 'application/json',
        'set-cookie': 'session=must-not-reach-browser',
      })
    }
    return response(url, '<html><body>Job</body></html>', 200, {
      'content-type': 'text/html',
      'set-cookie': 'session=must-not-reach-browser',
    })
  }

  const rendered = await renderJobPage(
    'https://jobs.example/role',
    new AbortController().signal,
    { fetcher, launchBrowser: async () => fake.browser },
  )

  assert.match(rendered.html, /Job/)
  assert.equal(rendered.finalUrl, 'https://jobs.example/role')
  assert.deepEqual(fetches.map(({ url }) => url), [
    'https://jobs.example/role',
    'https://cdn.example/app.js',
    'https://api.example/search',
  ])
  assert.equal(fetches.every(({ options }) => options.followRedirects === false), true)
  assert.deepEqual(fetches[1].options.headers, {
    accept: 'text/javascript',
    'user-agent': 'ScoreJobRenderer/1.0',
  })
  assert.deepEqual(fetches[2].options.headers, {
    'content-type': 'application/json',
    'user-agent': 'ScoreJobRenderer/1.0',
  })
  assert.equal(new TextDecoder().decode(fetches[2].options.body), '{"query":"engineer"}')
  assert.equal(
    fake.state.requests.some(({ response: fulfilled }) => fulfilled?.headers?.['set-cookie'] !== undefined),
    false,
  )
  assert.equal(fake.state.continued, 0)
  assert.equal(fake.state.fetchCalled, 0)
  assert.equal(fake.state.contextOptions.serviceWorkers, 'block')
  assert.equal(fake.state.contextOptions.acceptDownloads, false)
  assert.equal(fake.state.webSocketsClosed, 1)
  assert.equal(fake.state.contextClosed, 1)
  assert.equal(fake.state.browserClosed, 1)
})

test('redirect targets are fetched and validated before a redirect response is fulfilled', async () => {
  const events = []
  const fake = createFakeBrowser({
    onGoto: async ({ dispatch }) => {
      await dispatch('https://cdn.example/start.js')
      await dispatch('https://static.example/final.js')
    },
  })
  const fetcher = async (url) => {
    events.push(`fetch ${url}`)
    if (url === 'https://cdn.example/start.js') {
      return response(url, '', 302, { location: 'https://static.example/final.js' })
    }
    if (url.endsWith('.js')) return response(url, 'window.jobLoaded = true', 200, { 'content-type': 'text/javascript' })
    return response(url, '<html></html>')
  }

  await renderJobPage(
    'https://jobs.example/role',
    new AbortController().signal,
    {
      fetcher,
      launchBrowser: async () => fake.browser,
    },
  )
  for (const request of fake.state.requests) events.push(`${request.event} ${request.url}`)

  assert.ok(
    events.indexOf('fetch https://static.example/final.js')
      < events.indexOf('fulfill https://cdn.example/start.js'),
  )
  assert.equal(fake.state.continued, 0)
})

test('captured URL rules apply to subresources and every redirect, including HTTPS and blocked subdomains', async () => {
  const policy = renderPolicy(settings => {
    settings.imports.urls.requireHttps = true
    settings.imports.urls.jobs.allowedHosts = [{ hostname: 'example.com', includeSubdomains: true }]
    settings.imports.urls.jobs.blockedHosts = [{ hostname: 'blocked.example.com', includeSubdomains: true }]
  })
  for (const forbidden of ['https://external.example/app.js', 'https://child.blocked.example.com/app.js', 'http://cdn.example.com/app.js']) {
    const fetched = []
    const fake = createFakeBrowser({ onGoto: ({ dispatch }) => dispatch(forbidden) })
    await assert.rejects(renderJobPage('https://jobs.example.com/role', new AbortController().signal, {
      policy, launchBrowser: async () => fake.browser,
      fetcher: async url => { fetched.push(url); return response(url, '<html>Job</html>') },
    }), error => error.code === 'unsafe_url')
    assert.deepEqual(fetched, ['https://jobs.example.com/role'])
    assert.equal(fake.state.browserClosed, 1)
  }
  let requests = 0
  await assert.rejects(renderJobPage('https://jobs.example.com/role', new AbortController().signal, {
    policy, launchBrowser: async () => assert.fail('forbidden redirects cannot launch the browser'),
    fetcher: async url => { requests++; return response(url, '', 302, { location: 'https://blocked.example.com/role' }) },
  }), error => error.code === 'unsafe_url')
  assert.equal(requests, 1)
})

test('lower captured request, response, aggregate and DOM budgets fail without returning partial evidence', async () => {
  for (const [change, html, onGoto] of [
    [settings => { settings.rendering.maxRequests = 1 }, '<html></html>', ({ dispatch }) => dispatch('https://jobs.example/extra.js')],
    [settings => { settings.imports.urls.maxResponseBytes = 8 }, '<html>too large</html>'],
    [settings => { settings.rendering.maxAggregateBytes = 8; settings.rendering.maxDomBytes = 8 }, '<html>too large</html>'],
    [settings => { settings.rendering.maxDomBytes = 8 }, '<html>too large</html>'],
  ]) {
    const fake = createFakeBrowser({ onGoto })
    await assert.rejects(renderJobPage('https://jobs.example/role', new AbortController().signal, {
      policy: renderPolicy(change), launchBrowser: async () => fake.browser,
      fetcher: async url => response(url, html),
    }), error => error.code === 'limit_exceeded')
  }
})

test('concurrent subresources cannot reuse the same captured aggregate-byte allowance', async () => {
  const budgets = []
  const fake = createFakeBrowser({
    onGoto: ({ dispatch }) => Promise.all([dispatch('https://jobs.example/one.js'), dispatch('https://jobs.example/two.js')]),
  })
  await assert.rejects(renderJobPage('https://jobs.example/role', new AbortController().signal, {
    policy: renderPolicy(settings => {
      settings.rendering.maxAggregateBytes = 10
      settings.rendering.maxDomBytes = 10
    }),
    launchBrowser: async () => fake.browser,
    fetcher: async (url, options) => {
      if (!url.endsWith('.js')) return response(url, 'x')
      budgets.push(options.maxBytes)
      await new Promise(resolve => setTimeout(resolve, 1))
      return response(url, '123456')
    },
  }), error => error.code === 'limit_exceeded')
  assert.deepEqual(budgets, [9, 3])
})

test('zero settle is bounded and never disables the websocket guard', async () => {
  const fake = createFakeBrowser({ waitForLoadState: async () => assert.fail('zero settle cannot become an infinite Playwright timeout') })
  await renderJobPage('https://jobs.example/role', new AbortController().signal, {
    policy: renderPolicy(settings => { settings.rendering.settleMilliseconds = 0 }),
    launchBrowser: async () => fake.browser, fetcher: async url => response(url, '<html>Job</html>'),
  })
  assert.equal(fake.state.webSocketsClosed, 1)
})

test('a captured zero redirect allowance rejects before contacting the destination', async () => {
  const fetched = []
  await assert.rejects(renderJobPage('https://jobs.example/role', new AbortController().signal, {
    policy: renderPolicy(settings => { settings.imports.urls.maxRedirects = 0 }),
    launchBrowser: async () => assert.fail('redirect budget was exhausted before browser launch'),
    fetcher: async url => { fetched.push(url); return response(url, '', 302, { location: '/next' }) },
  }), error => error.code === 'render_failed')
  assert.deepEqual(fetched, ['https://jobs.example/role'])
})

test('network and DOM limits fail closed and always clean up the browser', async () => {
  const networkFake = createFakeBrowser({
    onGoto: ({ dispatch }) => dispatch('https://cdn.example/extra.js'),
  })
  const fetcher = async (url) => response(url, url.endsWith('.js') ? 'script' : '<html></html>')

  await assert.rejects(
    renderJobPage(
      'https://jobs.example/role',
      new AbortController().signal,
      {
        fetcher,
        launchBrowser: async () => networkFake.browser,
        limits: { maxNetworkRequests: 1 },
      },
    ),
    (error) => error.code === 'limit_exceeded',
  )
  assert.equal(networkFake.state.contextClosed, 1)
  assert.equal(networkFake.state.browserClosed, 1)

  const domFake = createFakeBrowser()
  await assert.rejects(
    renderJobPage(
      'https://jobs.example/role',
      new AbortController().signal,
      {
        fetcher: async (url) => response(url, '<html>too large</html>'),
        launchBrowser: async () => domFake.browser,
        limits: { maxDomBytes: 8 },
      },
    ),
    (error) => error.code === 'limit_exceeded',
  )
  assert.equal(domFake.state.contextClosed, 1)
  assert.equal(domFake.state.browserClosed, 1)
})

test('client abort closes the fresh context and browser', async () => {
  let loading
  const loadStarted = new Promise((resolve) => {
    loading = resolve
  })
  const fake = createFakeBrowser({
    waitForLoadState: () => {
      loading()
      return new Promise(() => {})
    },
  })
  const controller = new AbortController()
  const rendering = renderJobPage(
    'https://jobs.example/role',
    controller.signal,
    {
      fetcher: async (url) => response(url, '<html></html>'),
      launchBrowser: async () => fake.browser,
    },
  )

  await loadStarted
  controller.abort()
  await assert.rejects(rendering, (error) => error.code === 'aborted')
  assert.equal(fake.state.contextClosed, 1)
  assert.equal(fake.state.browserClosed, 1)
})

test('unsafe initial URLs are rejected before browser launch', async () => {
  let launched = false
  await assert.rejects(
    renderJobPage(
      'http://127.0.0.1/admin',
      new AbortController().signal,
      {
        fetcher: async () => {
          const error = new Error('blocked private address')
          error.code = 'UNSAFE_URL'
          throw error
        },
        launchBrowser: async () => {
          launched = true
          return createFakeBrowser().browser
        },
      },
    ),
    (error) => error.code === 'unsafe_url',
  )
  assert.equal(launched, false)
})
