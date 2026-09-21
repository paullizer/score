import { once } from 'node:events'
import { createServer } from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import express from 'express'
import { BlobClient } from '@azure/storage-blob'
import { CosmosClient } from '@azure/cosmos'
import { createHttpHeaders } from '@azure/core-rest-pipeline'
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { createApp } from '../server/app.ts'
import { telemetryRequests, recordRequestError } from '../server/telemetry-http.ts'
import { traceOperation } from '../server/telemetry-operations.ts'
import { shutdownTelemetry, telemetryPreloaded } from '../server/telemetry-lifecycle.ts'
import { authHeaders, baseConfig, createFakeDirectoryStore, createFakeStateStore } from './helpers.mjs'

const SENTINEL = 'PRIVATE-SENTINEL'
const source = `${SENTINEL}-Resume-and-narrative`
if (process.env.SCORE_TELEMETRY_FIXTURE_CONSOLE === 'true') console.info(`${SENTINEL}-console-must-not-be-harvested`)
const blob = new BlobClient(`https://${SENTINEL.toLowerCase()}.blob.core.windows.net/${SENTINEL}-container/${SENTINEL}-blob?sig=${SENTINEL}-token`, undefined, {
  retryOptions: { maxTries: 1 },
  httpClient: {
    async sendRequest(request) {
      await delay(5)
      const headers = createHttpHeaders({
        'content-length': String(Buffer.byteLength(source)), 'content-type': 'application/octet-stream',
        'last-modified': 'Tue, 01 Sep 2026 12:00:00 GMT', etag: `"${SENTINEL}-etag"`,
      })
      return {
        request, status: 200, headers: Object.assign(headers, { toJson: options => headers.toJSON(options) }),
        readableStreamBody: Readable.from([Buffer.from(source)]),
      }
    },
  },
})
const cosmos = new CosmosClient({
  endpoint: `https://${SENTINEL.toLowerCase()}.documents.azure.com`,
  key: Buffer.from(`${SENTINEL}-key`).toString('base64'),
  connectionPolicy: { enableEndpointDiscovery: false, retryOptions: { maxRetryAttemptCount: 0 } },
  httpClient: {
    async sendRequest(request) {
      await delay(5)
      return {
        request, status: 200, headers: createHttpHeaders({
          'content-type': 'application/json', 'x-ms-request-charge': '2', 'x-ms-item-count': '1',
          'x-ms-activity-id': `${SENTINEL}-activity`,
        }),
        bodyAsText: JSON.stringify({ Documents: [{ id: `${SENTINEL}-id`, text: source }], _count: 1 }),
      }
    },
  },
})

const app = express()
app.use(telemetryRequests)
app.get('/healthz', (_req, res) => { res.json({ status: 'ready' }) })
app.get('/api/workspaces/:workspaceId/analyses/:runId/summaries', async (_req, res) => {
  process.send?.({ type: 'slow-started' })
  await delay(150)
  if (!res.destroyed) res.json({ ok: true })
})
app.get('/api/workspaces/:workspaceId/analyses/:runId/comparisons/:comparisonId', async (req, res) => {
  const parent = trace.getSpan(context.active())
  process.send?.({ type: 'request-context', recording: parent?.isRecording() ?? false })
  await traceOperation('score.analysis.comparison', { 'score.operation.count': 1, 'private.text': source }, async () => {
    await traceOperation('score.storage.blob.read', { 'score.storage.kind': 'blob' }, async () => {
      const downloaded = await blob.download()
      for await (const chunk of downloaded.readableStreamBody) void chunk
    })
    await traceOperation('score.storage.query', { 'score.storage.kind': 'cosmos' }, async () => {
      await cosmos.database(`${SENTINEL}-database`).container(`${SENTINEL}-container`).items.query({
        query: `SELECT * FROM c WHERE c.name = '${SENTINEL}-person'`, parameters: [],
      }).fetchAll()
    })
    await traceOperation('score.analysis.validation', { 'score.operation.phase': 'validation', 'score.read.bytes': 123 }, async () => {
      await delay(10)
    })
    const raw = trace.getTracer(`${SENTINEL}-scope`).startSpan(`${SENTINEL}-span-name`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'az.namespace': 'Microsoft.Storage', 'http.method': 'GET', 'http.status_code': 502,
        'http.url': `https://${SENTINEL}-host/private/${SENTINEL}?token=${SENTINEL}`,
        'http.request.header.authorization': `Bearer ${SENTINEL}`, 'db.statement': source,
        'enduser.id': `${SENTINEL}-user`, 'score.operation.phase': source,
      },
    })
    raw.setStatus({ code: SpanStatusCode.ERROR, message: `${SENTINEL}-status-error` })
    raw.recordException(new Error(`${SENTINEL}-exception-body`))
    raw.addEvent(`${SENTINEL}-event`, { 'exception.stacktrace': source })
    raw.addLink({ context: { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }, attributes: { private: source } })
    raw.end()
    if (req.query.fail) throw Object.assign(new Error(`${SENTINEL}-request-error`), { status: 503 })
  })
  res.json({ ok: true })
})
app.use((error, _req, res, _next) => {
  process.send?.({ type: 'fixture-error', message: error.message, stack: error.stack })
  recordRequestError(error)
  res.status(503).json({ error: 'unavailable' })
})

const api = createApp({
  config: baseConfig(), directory: createFakeDirectoryStore(), state: createFakeStateStore(),
  distDir: path.resolve('server-tests', 'fixtures', 'dist'),
})
const server = createServer(app)
const apiServer = createServer(api)
server.listen(0, '127.0.0.1')
apiServer.listen(0, '127.0.0.1')
await Promise.all([once(server, 'listening'), once(apiServer, 'listening')])
let workerState
if (process.env.SCORE_TELEMETRY_FIXTURE_WORKER === 'true') {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url))
  const exited = once(worker, 'exit')
  ;[workerState] = await once(worker, 'message')
  await exited
}
process.send?.({
  type: 'ready', preloaded: telemetryPreloaded(), node: process.versions.node,
  workerState,
  url: `http://127.0.0.1:${server.address().port}`, apiUrl: `http://127.0.0.1:${apiServer.address().port}`,
  auth: authHeaders({ name: `${SENTINEL}-person`, email: `${SENTINEL}@example.test` }),
})
process.on('message', async (message) => {
  if (message?.type !== 'stop') return
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => apiServer.close(resolve)),
  ])
  cosmos.dispose()
  const started = performance.now()
  const result = await shutdownTelemetry()
  process.send?.({ type: 'shutdown', result, duration: performance.now() - started })
  process.disconnect()
})
