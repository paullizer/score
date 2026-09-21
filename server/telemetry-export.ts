import type { HttpClient, PipelineRequest, PipelineResponse } from '@azure/core-rest-pipeline'
import {
  safeAttributes, safeErrorCategory, safeOperationName, safeRequestName, TELEMETRY_ROLE,
} from './telemetry-schema'
import type { TelemetryWarning } from './telemetry-warnings'

const MAX_EXPORT_BYTES = 2_000_000
const EXPORT_TIMEOUT_MS = 2_000
const MAX_CONCURRENT_EXPORTS = 3
const metricNames = new Set([
  'score.http.request.count', 'score.http.request.duration', 'score.operation.count', 'score.operation.duration',
])
const dependencyNames = new Set([
  'dependency.internal',
  ...['cosmos', 'blob', 'identity', 'http'].flatMap((kind) =>
    ['query', 'read', 'download', 'upload', 'create', 'replace', 'delete', 'upsert', 'patch', 'list', 'request']
      .map((operation) => `azure.${kind}.${operation}`)),
])

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function number(value: unknown, maximum = 1_000_000_000_000): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined
}

function status(value: unknown): string {
  return typeof value === 'string' && /^(?:0|[1-5]\d{2})$/.test(value) ? value : '0'
}

function duration(value: unknown): string {
  return typeof value === 'string' && /^(?:\d{1,3}\.)?\d{2}:\d{2}:\d{2}\.\d{1,7}$/.test(value)
    ? value : '00:00:00.0000000'
}

function identifier(value: unknown, length: number): string | undefined {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : undefined
}

function properties(value: unknown): Record<string, string> {
  const attributes = record(value)
  const numericKeys = [
    'http.status_code', 'score.operation.count', 'score.operation.bytes', 'score.read.count', 'score.read.bytes',
    'score.comparison.count', 'score.publication.count', 'score.concurrency',
  ]
  for (const key of numericKeys) {
    if (typeof attributes[key] === 'string' && /^\d{1,12}$/.test(attributes[key])) attributes[key] = Number(attributes[key])
  }
  return Object.fromEntries(Object.entries(safeAttributes(attributes)).map(([key, value]) => [key, String(value)]))
}

function requestName(value: unknown, attributes: Record<string, unknown>): string {
  if (typeof value === 'string') {
    const separator = value.indexOf(' ')
    if (separator > 0) return safeRequestName(value.slice(0, separator), value.slice(separator + 1))
  }
  return safeRequestName(attributes['http.method'], attributes['http.route'])
}

function safeEnvelope(value: unknown, instrumentationKey: string): Record<string, unknown> | undefined {
  const input = record(value)
  const data = record(input.data)
  const source = record(data.baseData)
  const attributes = properties(source.properties)
  const sourceTags = record(input.tags)
  const tags: Record<string, string | undefined> = {
    'ai.cloud.role': TELEMETRY_ROLE,
    'ai.cloud.roleInstance': TELEMETRY_ROLE,
    'ai.operation.id': identifier(sourceTags['ai.operation.id'], 32),
    'ai.operation.parentId': identifier(sourceTags['ai.operation.parentId'], 16),
  }
  let suffix: string
  let baseData: Record<string, unknown>
  switch (data.baseType) {
    case 'RequestData': {
      suffix = 'Request'
      const name = requestName(source.name ?? sourceTags['ai.operation.name'], attributes)
      tags['ai.operation.name'] = name
      baseData = {
        ver: 2, id: identifier(source.id, 16), name, duration: duration(source.duration),
        responseCode: status(source.responseCode), success: source.success === true, properties: attributes,
      }
      break
    }
    case 'RemoteDependencyData': {
      suffix = 'RemoteDependency'
      const name = typeof source.name === 'string' && dependencyNames.has(source.name)
        ? source.name : safeOperationName(source.name)
      const kind = attributes['score.dependency.kind']
      const type = kind === 'cosmos' ? 'Azure Cosmos DB' : kind === 'blob' ? 'Azure blob' :
        kind === 'identity' ? 'Azure identity' : kind === 'http' ? 'HTTP' : 'InProc'
      baseData = {
        ver: 2, id: identifier(source.id, 16), name, duration: duration(source.duration),
        resultCode: status(source.resultCode), success: source.success === true, type,
        target: kind === 'cosmos' || kind === 'blob' || kind === 'identity' ? `azure.${kind}` : undefined,
        properties: attributes,
      }
      break
    }
    case 'ExceptionData': {
      suffix = 'Exception'
      const firstException = Array.isArray(source.exceptions) ? record(source.exceptions[0]) : {}
      const category = safeErrorCategory(attributes['score.error.category'] ?? firstException.typeName)
      baseData = {
        ver: 2, severityLevel: 3, problemId: category,
        exceptions: [{ typeName: category, message: category, hasFullStack: false }],
        properties: { ...attributes, 'score.error.category': category },
      }
      break
    }
    case 'MetricData': {
      suffix = 'Metric'
      const samples = Array.isArray(source.metrics) ? source.metrics : []
      const safeMetrics = samples.flatMap((sample) => {
        const metric = record(sample)
        if (typeof metric.name !== 'string' || !metricNames.has(metric.name) || number(metric.value) === undefined) return []
        return [{
          name: metric.name, kind: 'Aggregation', value: number(metric.value),
          count: number(metric.count), min: number(metric.min), max: number(metric.max),
        }]
      })
      if (safeMetrics.length === 0) return undefined
      baseData = { ver: 2, metrics: safeMetrics, properties: attributes }
      break
    }
    default:
      return undefined
  }
  const time = typeof input.time === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(input.time) ? input.time : undefined
  if (!time || !Number.isFinite(Date.parse(time))) return undefined
  return {
    ver: 1, name: `Microsoft.ApplicationInsights.${suffix}`, time, iKey: instrumentationKey,
    sampleRate: number(input.sampleRate, 100) || 100, tags, data: { baseType: data.baseType, baseData },
  }
}

export function sanitizeExportBody(body: unknown, instrumentationKey: string): string {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_EXPORT_BYTES) throw new Error('Telemetry payload rejected.')
  const parsed: unknown = JSON.parse(body)
  if (!Array.isArray(parsed) || parsed.length > 2_048) throw new Error('Telemetry payload rejected.')
  const envelopes = parsed.flatMap((item) => {
    const envelope = safeEnvelope(item, instrumentationKey)
    return envelope ? [envelope] : []
  })
  if (envelopes.length === 0) throw new Error('Telemetry payload rejected.')
  return JSON.stringify(envelopes)
}

export interface PrivacyTransport {
  readonly client: HttpClient
  readonly failed: () => boolean
  readonly close: () => void
}

export function createPrivacyTransport(
  delegate: HttpClient,
  instrumentationKey: string,
  warn: (code: TelemetryWarning) => void,
): PrivacyTransport {
  const active = new Set<AbortController>()
  let closed = false
  let failed = false
  return {
    failed: () => failed,
    close: () => {
      closed = true
      for (const controller of active) controller.abort()
    },
    client: {
      async sendRequest(request: PipelineRequest): Promise<PipelineResponse> {
        if (closed || active.size >= MAX_CONCURRENT_EXPORTS) {
          failed = true
          warn('export_rejected')
          throw new Error('Telemetry export unavailable.')
        }
        try {
          request.body = sanitizeExportBody(request.body, instrumentationKey)
          request.headers.delete('content-length')
          request.headers.delete('content-encoding')
          request.headers.set('content-type', 'application/json')
          request.timeout = EXPORT_TIMEOUT_MS
          request.disableKeepAlive = true
        } catch {
          failed = true
          warn('export_rejected')
          throw new Error('Telemetry payload rejected.')
        }
        const controller = new AbortController()
        const upstream = request.abortSignal
        const abort = () => controller.abort()
        upstream?.addEventListener('abort', abort, { once: true })
        if (upstream?.aborted) controller.abort()
        request.abortSignal = controller.signal
        active.add(controller)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              warn('export_timeout')
              controller.abort()
              reject(new Error('Telemetry export timed out.'))
            }, EXPORT_TIMEOUT_MS)
          })
          const response = await Promise.race([delegate.sendRequest(request), deadline])
          if (response.status !== 200) {
            failed = true
            warn('export_failed')
          }
          return response
        } catch {
          failed = true
          warn('export_failed')
          throw new Error('Telemetry export failed.')
        } finally {
          if (timer) clearTimeout(timer)
          active.delete(controller)
          upstream?.removeEventListener('abort', abort)
        }
      },
    },
  }
}

export const telemetryMetricAttributeKeys = [
  'http.method', 'http.route', 'http.status_code', 'score.operation', 'score.outcome', 'score.error.category',
]

export function sanitizeMetricAttributes(attributes: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  return safeAttributes(attributes)
}
