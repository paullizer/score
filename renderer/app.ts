import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { renderJobPage, RendererError } from './browser'
import type { PublicFetcher, RenderedJobPage } from '../src/domain/rendering'
import { renderRequestPolicySchema, type RenderRequestPolicy } from './request-policy'

const MAX_JSON_BODY = '64kb'
const DEFAULT_MAX_CONCURRENCY = 1
const DEFAULT_MAX_QUEUE = 1
const WORKER_HEADER = 'job-ingestion'

const FORBIDDEN_CREDENTIAL_ENV_NAMES = [
  'AZURE_AUTHORITY_HOST',
  'AZURE_CLIENT_CERTIFICATE_PASSWORD',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_FEDERATED_TOKEN_FILE',
  'AZURE_PASSWORD',
  'AZURE_POD_IDENTITY_AUTHORITY_HOST',
  'AZURE_TENANT_ID',
  'AZURE_TOKEN_CREDENTIALS',
  'AZURE_USERNAME',
  'IDENTITY_ENDPOINT',
  'IDENTITY_HEADER',
  'IDENTITY_SERVER_THUMBPRINT',
  'IMDS_ENDPOINT',
  'MSI_ENDPOINT',
  'MSI_SECRET',
] as const

type RenderFunction = (url: string, signal: AbortSignal, policy?: RenderRequestPolicy) => Promise<RenderedJobPage>

export interface RendererAppDeps {
  readonly fetcher: PublicFetcher
  readonly render?: RenderFunction
  readonly maxConcurrency?: 1 | 2
  readonly maxQueue?: number
}

interface ErrorEnvelope {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

interface BodyParserError {
  readonly type?: string
}

class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

interface QueueEntry {
  readonly resolve: (release: () => void) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

class RenderGate {
  readonly #maxConcurrency: number
  readonly #maxQueue: number
  readonly #queue: QueueEntry[] = []
  #running = 0

  constructor(maxConcurrency: number, maxQueue: number) {
    this.#maxConcurrency = maxConcurrency
    this.#maxQueue = maxQueue
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new RendererError('aborted', 'The request was aborted.'))
    if (this.#running < this.#maxConcurrency) {
      this.#running += 1
      return Promise.resolve(this.#createRelease())
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new HttpError(429, 'busy', 'The renderer is busy.'))
    }

    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#queue.indexOf(entry)
          if (index >= 0) this.#queue.splice(index, 1)
          reject(new RendererError('aborted', 'The request was aborted.'))
        },
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
      this.#queue.push(entry)
    })
  }

  #createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#queue.shift()
      if (next) {
        next.signal.removeEventListener('abort', next.onAbort)
        next.resolve(this.#createRelease())
        return
      }
      this.#running -= 1
    }
  }
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return typeof error === 'object' && error !== null && 'type' in error
}

function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } }
}

function validateRenderBody(body: unknown): { url: string; policy?: RenderRequestPolicy } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'The request body must be a JSON object.')
  }
  const record = body as Record<string, unknown>
  if (Object.keys(record).some(key => !['url', 'policy'].includes(key)) || !Object.hasOwn(record, 'url')) {
    throw new HttpError(400, 'invalid_request', 'The request body must contain url and optional bounded policy.')
  }
  if (typeof record.url !== 'string' || record.url.trim() === '' || record.url.length > 4096) {
    throw new HttpError(400, 'invalid_request', 'url must be a non-empty string of at most 4096 characters.')
  }
  if (record.policy !== undefined) {
    const policy = renderRequestPolicySchema.safeParse(record.policy)
    if (!policy.success) throw new HttpError(400, 'invalid_request', 'The render policy must contain valid lower budgets and URL rules.')
    return { url: record.url, policy: policy.data }
  }
  return { url: record.url }
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store')
  next()
}

function rendererErrorToHttp(error: RendererError): HttpError {
  switch (error.code) {
    case 'invalid_url':
    case 'unsafe_url':
      return new HttpError(400, 'unsafe_url', 'The URL is not permitted.')
    case 'limit_exceeded':
      return new HttpError(413, 'limit_exceeded', 'The page exceeded a renderer limit.')
    case 'render_timeout':
      return new HttpError(504, 'render_timeout', 'The page render timed out.')
    case 'aborted':
      return new HttpError(502, 'render_aborted', 'The page render was aborted.')
    case 'render_failed':
      return new HttpError(502, 'render_failed', 'The page could not be rendered.')
  }
}

export function credentialEnvironmentNames(env: NodeJS.ProcessEnv): string[] {
  return FORBIDDEN_CREDENTIAL_ENV_NAMES.filter((name) => Object.hasOwn(env, name))
}

export function assertCredentialFreeEnvironment(env: NodeJS.ProcessEnv): void {
  const present = credentialEnvironmentNames(env)
  if (present.length > 0) {
    throw new Error(`Renderer refuses Azure credential or identity environment variables: ${present.join(', ')}`)
  }
}

/**
 * Creates the internal-only renderer API without binding a port. The worker header is an
 * interface/CSRF guard; deployment network isolation remains the authentication boundary.
 */
export function createRendererApp(deps: RendererAppDeps): Express {
  const maxConcurrency = deps.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
  const maxQueue = deps.maxQueue ?? DEFAULT_MAX_QUEUE
  if ((maxConcurrency !== 1 && maxConcurrency !== 2) || !Number.isInteger(maxQueue) || maxQueue < 0) {
    throw new Error('Renderer concurrency must be 1 or 2 and maxQueue must be a non-negative integer.')
  }
  const gate = new RenderGate(maxConcurrency, maxQueue)
  const render: RenderFunction = deps.render ?? ((url, signal, policy) => renderJobPage(url, signal, { fetcher: deps.fetcher, policy }))
  const app = express()
  app.disable('x-powered-by')
  app.use(noStore)
  app.use(express.json({ limit: MAX_JSON_BODY, strict: true }))

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ready' })
  })

  app.post('/render', async (req, res, next) => {
    if (req.header('origin') !== undefined) {
      next(new HttpError(403, 'browser_request_rejected', 'Browser-originated requests are not permitted.'))
      return
    }
    if (req.header('x-score-worker') !== WORKER_HEADER) {
      next(new HttpError(403, 'worker_header_required', 'The required worker interface header is missing.'))
      return
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', () => {
      if (!res.writableEnded) abort()
    })

    let release: (() => void) | undefined
    try {
      const { url, policy } = validateRenderBody(req.body)
      release = await gate.acquire(controller.signal)
      const rendered = await render(url, controller.signal, policy)
      if (!controller.signal.aborted) res.json(rendered)
    } catch (error) {
      next(error)
    } finally {
      req.removeListener('aborted', abort)
      release?.()
    }
  })

  app.use((_req, res) => {
    res.status(404).json(errorEnvelope('not_found', 'Not found.'))
  })

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error)
      return
    }

    let httpError: HttpError
    if (error instanceof HttpError) {
      httpError = error
    } else if (error instanceof RendererError) {
      httpError = rendererErrorToHttp(error)
    } else if (isBodyParserError(error) && error.type === 'entity.too.large') {
      httpError = new HttpError(413, 'request_too_large', 'The request body exceeds 16 KB.')
    } else if (isBodyParserError(error)) {
      httpError = new HttpError(400, 'invalid_json', 'The request body is not valid JSON.')
    } else {
      httpError = new HttpError(502, 'render_failed', 'The page could not be rendered.')
    }

    console.warn(JSON.stringify({
      event: 'renderer_request_failed',
      code: httpError.code,
      method: req.method,
      route: req.path,
    }))
    res.status(httpError.status).json(errorEnvelope(httpError.code, httpError.message))
  })

  return app
}

export { renderJobPage, RendererError } from './browser'
export type { PublicFetcher, PublicFetchedResponse, PublicFetchOptions, RenderedJobPage } from '../src/domain/rendering'
