import { createHash } from 'node:crypto'
import process from 'node:process'
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Route } from 'playwright'
import type {
  PublicFetchedResponse,
  PublicFetcher,
  PublicFetchOptions,
  RenderedJobPage,
} from '../src/domain/rendering'

const DEFAULT_RENDER_TIMEOUT_MS = 30_000
const DEFAULT_SETTLE_TIMEOUT_MS = 2_000
const DEFAULT_MAX_NETWORK_REQUESTS = 80
const DEFAULT_MAX_AGGREGATE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_DOM_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 10
const RENDERER_USER_AGENT = 'ScoreJobRenderer/1.0'

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'origin',
  'referer',
  'x-requested-with',
])
const FORWARDED_RESPONSE_HEADERS = new Set([
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'cache-control',
  'content-language',
  'content-security-policy',
  'content-type',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'etag',
  'expires',
  'last-modified',
  'location',
  'permissions-policy',
  'referrer-policy',
  'x-content-type-options',
  'x-frame-options',
])

export type RendererErrorCode =
  | 'aborted'
  | 'invalid_url'
  | 'limit_exceeded'
  | 'render_failed'
  | 'render_timeout'
  | 'unsafe_url'

export class RendererError extends Error {
  readonly code: RendererErrorCode

  constructor(code: RendererErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RendererError'
    this.code = code
  }
}

export interface RenderLimits {
  readonly timeoutMs: number
  readonly settleTimeoutMs: number
  readonly maxNetworkRequests: number
  readonly maxAggregateBytes: number
  readonly maxDomBytes: number
}

export interface RenderJobPageOptions {
  readonly fetcher: PublicFetcher
  readonly launchBrowser?: () => Promise<Browser>
  readonly limits?: Partial<RenderLimits>
}

interface CachedResponse {
  readonly response: PublicFetchedResponse
  readonly method: 'GET' | 'POST'
  readonly url: string
  readonly body?: Uint8Array
}

interface PrimedResponse {
  readonly response: PublicFetchedResponse
  readonly finalUrl: string
}

function parseHttpUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new RendererError('invalid_url', 'The URL must be an absolute HTTP or HTTPS URL.')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') {
    throw new RendererError('unsafe_url', 'The URL is not permitted.')
  }
  return parsed
}

function cacheKey(method: 'GET' | 'POST', url: string, body?: Uint8Array): string {
  const digest = body === undefined ? '' : createHash('sha256').update(body).digest('hex')
  return `${method}\n${url}\n${digest}`
}

function pickRequestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': RENDERER_USER_AGENT }
  for (const [name, value] of Object.entries(request.headers())) {
    const normalized = name.toLowerCase()
    if (FORWARDED_REQUEST_HEADERS.has(normalized)) headers[normalized] = value
  }
  return headers
}

function pickResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (FORWARDED_RESPONSE_HEADERS.has(normalized)) picked[normalized] = value
  }
  return picked
}

function redirectMethod(
  method: 'GET' | 'POST',
  status: number,
): { method: 'GET' | 'POST'; preserveBody: boolean } {
  if (method === 'POST' && (status === 301 || status === 302 || status === 303)) {
    return { method: 'GET', preserveBody: false }
  }
  return { method, preserveBody: method === 'POST' }
}

function errorProperty(error: unknown, property: string): unknown {
  return typeof error === 'object' && error !== null && property in error
    ? (error as Record<string, unknown>)[property]
    : undefined
}

function isUnsafeFetchError(error: unknown): boolean {
  const code = errorProperty(error, 'code')
  const status = errorProperty(error, 'status') ?? errorProperty(error, 'statusCode')
  const name = errorProperty(error, 'name')
  return status === 400
    || code === 'UNSAFE_URL'
    || code === 'unsafe_url'
    || code === 'unsafe-url'
    || code === 'invalid-url'
    || code === 'BLOCKED_ADDRESS'
    || code === 'SSRF_BLOCKED'
    || name === 'UnsafeUrlError'
    || name === 'PublicFetchSafetyError'
}

function isLimitFetchError(error: unknown): boolean {
  const code = errorProperty(error, 'code')
  return code === 'limit_exceeded'
    || code === 'MAX_BYTES_EXCEEDED'
    || code === 'response-too-large'
    || code === 'source-too-large'
}

function isTimeoutFetchError(error: unknown): boolean {
  const code = errorProperty(error, 'code')
  return code === 'ETIMEDOUT'
    || code === 'request-timeout'
    || code === 'source-timeout'
}

function throwForAbort(signal: AbortSignal, timedOut: boolean): never {
  if (timedOut) throw new RendererError('render_timeout', 'The page render timed out.')
  throw new RendererError('aborted', 'The page render was aborted.', { cause: signal.reason })
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal, timedOut: () => boolean): Promise<T> {
  if (signal.aborted) throwForAbort(signal, timedOut())

  let listener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => {
      try {
        throwForAbort(signal, timedOut())
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener('abort', listener, { once: true })
  })

  try {
    return await Promise.race([operation, aborted])
  } finally {
    if (listener) signal.removeEventListener('abort', listener)
  }
}

class PublicRouteBroker {
  readonly #fetcher: PublicFetcher
  readonly #signal: AbortSignal
  readonly #limits: RenderLimits
  readonly #cache = new Map<string, CachedResponse>()
  #requestCount = 0
  #aggregateBytes = 0

  constructor(fetcher: PublicFetcher, signal: AbortSignal, limits: RenderLimits) {
    this.#fetcher = fetcher
    this.#signal = signal
    this.#limits = limits
  }

  async prime(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string> = {},
    body?: Uint8Array,
    redirectDepth = 0,
    seen = new Set<string>(),
  ): Promise<PrimedResponse> {
    const parsed = parseHttpUrl(url)
    const normalizedUrl = parsed.href
    const key = cacheKey(method, normalizedUrl, body)
    const cached = this.#cache.get(key)
    if (cached) return { response: cached.response, finalUrl: normalizedUrl }

    if (redirectDepth > MAX_REDIRECTS || seen.has(key)) {
      throw new RendererError('render_failed', 'The page returned an invalid redirect chain.')
    }
    seen.add(key)

    if (this.#requestCount >= this.#limits.maxNetworkRequests) {
      throw new RendererError('limit_exceeded', 'The page exceeded the network request limit.')
    }
    const bodyBytes = body?.byteLength ?? 0
    const remainingBytes = this.#limits.maxAggregateBytes - this.#aggregateBytes - bodyBytes
    if (remainingBytes <= 0) {
      throw new RendererError('limit_exceeded', 'The page exceeded the network byte limit.')
    }

    this.#requestCount += 1
    this.#aggregateBytes += bodyBytes
    const fetchOptions: PublicFetchOptions = {
      method,
      headers,
      signal: this.#signal,
      maxBytes: remainingBytes,
      followRedirects: false,
    }
    if (body !== undefined) fetchOptions.body = body

    let response: PublicFetchedResponse
    try {
      response = await this.#fetcher(normalizedUrl, fetchOptions)
    } catch (error) {
      if (this.#signal.aborted) throw error
      if (isUnsafeFetchError(error)) {
        throw new RendererError('unsafe_url', 'The URL is not permitted.', { cause: error })
      }
      if (isLimitFetchError(error)) {
        throw new RendererError('limit_exceeded', 'The page exceeded the network byte limit.', { cause: error })
      }
      if (isTimeoutFetchError(error)) {
        throw new RendererError('render_timeout', 'The public page request timed out.', { cause: error })
      }
      throw new RendererError('render_failed', 'The public page could not be fetched.', { cause: error })
    }

    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      throw new RendererError('render_failed', 'The public fetch transport returned an invalid response.')
    }
    if (parseHttpUrl(response.url).href !== normalizedUrl) {
      throw new RendererError('render_failed', 'The public fetch transport followed a redirect unexpectedly.')
    }
    if (response.body.byteLength > remainingBytes) {
      throw new RendererError('limit_exceeded', 'The page exceeded the network byte limit.')
    }
    this.#aggregateBytes += response.body.byteLength
    this.#cache.set(key, { response, method, url: normalizedUrl, body })

    const location = Object.entries(response.headers)
      .find(([name]) => name.toLowerCase() === 'location')?.[1]
    if (!REDIRECT_STATUSES.has(response.status) || location === undefined) {
      return { response, finalUrl: normalizedUrl }
    }

    const nextUrl = new URL(location, normalizedUrl).href
    parseHttpUrl(nextUrl)
    const next = redirectMethod(method, response.status)
    if (next.method === 'POST' && next.preserveBody) {
      throw new RendererError('render_failed', 'Redirects that replay POST bodies are not permitted.')
    }
    const primed = await this.prime(
      next.method,
      nextUrl,
      headers,
      next.preserveBody ? body : undefined,
      redirectDepth + 1,
      seen,
    )
    return { response, finalUrl: primed.finalUrl }
  }

  async handle(route: Route): Promise<void> {
    const request = route.request()
    const resourceType = request.resourceType()
    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      await route.abort('blockedbyclient')
      return
    }

    const rawMethod = request.method().toUpperCase()
    if (rawMethod !== 'GET' && rawMethod !== 'POST') {
      await route.abort('blockedbyclient')
      return
    }

    let url: string
    try {
      url = parseHttpUrl(request.url()).href
    } catch {
      await route.abort('blockedbyclient')
      return
    }

    const method = rawMethod
    const bodyBuffer = method === 'POST' ? request.postDataBuffer() ?? undefined : undefined
    const body = bodyBuffer === undefined ? undefined : new Uint8Array(bodyBuffer)
    const key = cacheKey(method, url, body)
    let cached = this.#cache.get(key)
    if (cached) {
      this.#cache.delete(key)
    } else {
      await this.prime(method, url, pickRequestHeaders(request), body)
      cached = this.#cache.get(key)
      this.#cache.delete(key)
    }
    if (!cached) throw new RendererError('render_failed', 'The page response was not available.')

    await route.fulfill({
      status: cached.response.status,
      headers: pickResponseHeaders(cached.response.headers),
      body: Buffer.from(cached.response.body),
    })
  }
}

async function closeQuietly(resource: { close(options?: { reason?: string }): Promise<void> } | undefined): Promise<void> {
  if (!resource) return
  try {
    await resource.close({ reason: 'renderer request complete' })
  } catch {
    // Cleanup is best-effort after the browser operation has already reached a terminal state.
  }
}

function defaultLaunchBrowser(): Promise<Browser> {
  const browserEnvironment: Record<string, string> = {}
  for (const name of [
    'FONTCONFIG_PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'PLAYWRIGHT_BROWSERS_PATH',
    'TEMP',
    'TMP',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
  ]) {
    const value = process.env[name]
    if (value !== undefined) browserEnvironment[name] = value
  }

  return chromium.launch({
    headless: true,
    chromiumSandbox: false,
    env: browserEnvironment,
    args: [
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-dns-prefetch',
      '--disable-domain-reliability',
      '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter',
      '--disable-pings',
      '--disable-sync',
      '--disable-webrtc',
      '--enforce-webrtc-ip-permission-check',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-sandbox',
    ],
  })
}

/**
 * Renders one public page with a fresh, non-persistent browser context. Chromium has no direct
 * network path: every HTTP(S) response is supplied by the injected DNS-pinned public fetcher.
 */
export async function renderJobPage(
  rawUrl: string,
  signal: AbortSignal,
  options: RenderJobPageOptions,
): Promise<RenderedJobPage> {
  const limits: RenderLimits = {
    timeoutMs: options.limits?.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
    settleTimeoutMs: options.limits?.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
    maxNetworkRequests: options.limits?.maxNetworkRequests ?? DEFAULT_MAX_NETWORK_REQUESTS,
    maxAggregateBytes: options.limits?.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES,
    maxDomBytes: options.limits?.maxDomBytes ?? DEFAULT_MAX_DOM_BYTES,
  }
  if (
    !Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1
    || !Number.isInteger(limits.settleTimeoutMs) || limits.settleTimeoutMs < 0
    || !Number.isInteger(limits.maxNetworkRequests) || limits.maxNetworkRequests < 1
    || !Number.isInteger(limits.maxAggregateBytes) || limits.maxAggregateBytes < 1
    || !Number.isInteger(limits.maxDomBytes) || limits.maxDomBytes < 1
  ) {
    throw new RendererError('render_failed', 'Renderer limits are invalid.')
  }
  const initialUrl = parseHttpUrl(rawUrl).href
  const timeoutController = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    timeoutController.abort()
  }, limits.timeoutMs)
  timeout.unref()
  const combinedSignal = AbortSignal.any([signal, timeoutController.signal])
  const broker = new PublicRouteBroker(options.fetcher, combinedSignal, limits)

  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined
  try {
    const initial = await raceWithAbort(
      broker.prime('GET', initialUrl, {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.8',
        'user-agent': RENDERER_USER_AGENT,
      }),
      combinedSignal,
      () => timedOut,
    )
    const browserLaunch = (options.launchBrowser ?? defaultLaunchBrowser)()
    void browserLaunch.then(async (launchedBrowser) => {
      if (combinedSignal.aborted && browser !== launchedBrowser) await closeQuietly(launchedBrowser)
    }).catch(() => undefined)
    browser = await raceWithAbort(
      browserLaunch,
      combinedSignal,
      () => timedOut,
    )
    context = await raceWithAbort(
      browser.newContext({
        acceptDownloads: false,
        bypassCSP: false,
        javaScriptEnabled: true,
        locale: 'en-US',
        serviceWorkers: 'block',
        userAgent: RENDERER_USER_AGENT,
      }),
      combinedSignal,
      () => timedOut,
    )
    await raceWithAbort(
      context.route('**/*', (route) => broker.handle(route)),
      combinedSignal,
      () => timedOut,
    )
    await raceWithAbort(
      context.routeWebSocket('**/*', (webSocket) => webSocket.close({
        code: 1008,
        reason: 'WebSockets are disabled',
      })),
      combinedSignal,
      () => timedOut,
    )

    context.on('page', (openedPage) => {
      if (page !== undefined && openedPage !== page) void openedPage.close()
    })
    page = await raceWithAbort(context.newPage(), combinedSignal, () => timedOut)
    page.on('popup', (popup) => void popup.close())
    page.on('dialog', (dialog) => void dialog.dismiss())
    page.on('download', (download) => void download.cancel())

    await raceWithAbort(
      page.goto(initial.finalUrl, { waitUntil: 'domcontentloaded', timeout: limits.timeoutMs }),
      combinedSignal,
      () => timedOut,
    )
    try {
      await raceWithAbort(
        page.waitForLoadState('load', { timeout: limits.settleTimeoutMs }),
        combinedSignal,
        () => timedOut,
      )
    } catch (error) {
      if (error instanceof RendererError) throw error
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error
    }
    await raceWithAbort(
      page.waitForTimeout(Math.min(500, limits.settleTimeoutMs)),
      combinedSignal,
      () => timedOut,
    )

    const html = await raceWithAbort(page.content(), combinedSignal, () => timedOut)
    if (Buffer.byteLength(html, 'utf8') > limits.maxDomBytes) {
      throw new RendererError('limit_exceeded', 'The rendered DOM exceeded the output limit.')
    }
    return { html, finalUrl: parseHttpUrl(page.url()).href }
  } catch (error) {
    if (combinedSignal.aborted) throwForAbort(combinedSignal, timedOut)
    if (error instanceof RendererError) throw error
    throw new RendererError('render_failed', 'The page could not be rendered.', { cause: error })
  } finally {
    clearTimeout(timeout)
    await closeQuietly(context)
    await closeQuietly(browser)
  }
}
