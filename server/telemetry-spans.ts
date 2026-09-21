import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import {
  categoryForStatus, safeAttributes, safeErrorCategory, safeMethod, safeOperationName,
  safeRequestName, safeRoute, type SafeAttributes,
} from './telemetry-schema'

export type DependencyKind = 'cosmos' | 'blob' | 'identity' | 'http' | 'internal'

function dependencyKind(span: Span): DependencyKind {
  const storage = span.attributes['score.storage.kind']
  if (span.instrumentationScope.name === 'score.api' && (storage === 'cosmos' || storage === 'blob')) return storage
  const namespace = span.attributes['az.namespace']
  const system = span.attributes['db.system'] ?? span.attributes['db.system.name']
  if (namespace === 'Microsoft.DocumentDB' || namespace === 'Azure.Cosmos' || system === 'cosmosdb') return 'cosmos'
  if (namespace === 'Microsoft.Storage') return 'blob'
  if (namespace === 'Microsoft.AAD' || namespace === 'Microsoft.Entra') return 'identity'
  const address = span.attributes['server.address'] ?? span.attributes['net.peer.name'] ??
    span.attributes['http.url'] ?? span.attributes['url.full']
  if (typeof address === 'string') {
    try {
      const host = new URL(address.includes('://') ? address : `https://${address}`).hostname
      if (host.endsWith('.documents.azure.com')) return 'cosmos'
      if (host.endsWith('.blob.core.windows.net')) return 'blob'
      if (host === 'login.microsoftonline.com' || host === '169.254.169.254') return 'identity'
    } catch {
      // Invalid or non-URL dependency identifiers are never retained.
    }
  }
  return span.kind === SpanKind.CLIENT ? 'http' : 'internal'
}

function safeDependencyName(span: Span, kind: DependencyKind): string {
  if (span.instrumentationScope.name === 'score.api') return safeOperationName(span.name)
  if (kind === 'internal') return 'dependency.internal'
  const operation = ['query', 'read', 'download', 'upload', 'create', 'replace', 'delete', 'upsert', 'patch', 'list']
    .find((candidate) => new RegExp(`(?:^|[. _-])${candidate}(?:$|[. _-])`, 'i').test(span.name))
  return `azure.${kind}.${operation ?? 'request'}`
}

export class PrivacySpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
    const attributes: SafeAttributes = safeAttributes(span.attributes)
    const status = span.attributes['http.response.status_code'] ?? span.attributes['http.status_code']
    const statusCode = typeof status === 'number' && status >= 100 && status <= 599 ? Math.floor(status) : undefined
    const method = span.attributes['http.request.method'] ?? span.attributes['http.method']
    const sampleRate = span.attributes['microsoft.sample_rate']
    if (typeof sampleRate === 'number' && sampleRate > 0 && sampleRate <= 100) attributes['microsoft.sample_rate'] = sampleRate
    if (statusCode !== undefined) attributes['http.status_code'] = statusCode
    if (method !== undefined) attributes['http.method'] = safeMethod(method)
    const category = attributes['score.error.category'] ?? (statusCode ? categoryForStatus(statusCode) : undefined)
    const failed = category !== undefined || span.status.code === SpanStatusCode.ERROR
    if (failed) attributes['score.error.category'] = safeErrorCategory(category)

    if (span.kind === SpanKind.SERVER) {
      const route = safeRoute(span.attributes['http.route'] ?? span.attributes['http.target'] ?? span.attributes['url.path'])
      attributes['http.route'] = route
      span.updateName(safeRequestName(method, route))
    } else {
      const kind = dependencyKind(span)
      attributes['score.dependency.kind'] = kind
      span.updateName(safeDependencyName(span, kind))
      if (kind === 'cosmos') attributes['db.system'] = 'cosmosdb'
      if (kind !== 'internal') attributes['server.address'] = `azure.${kind}`
    }

    for (const key of Object.keys(span.attributes)) delete span.attributes[key]
    Object.assign(span.attributes, attributes)
    delete span.status.message
    span.events.splice(0)
    span.links.splice(0)
    if (failed) {
      span.setStatus({ code: SpanStatusCode.ERROR })
      const category = safeErrorCategory(attributes['score.error.category'])
      span.addEvent('exception', { 'exception.type': category, 'exception.message': category, 'score.error.category': category })
    }
  }

  onEnd(): void {}
  forceFlush(): Promise<void> { return Promise.resolve() }
  shutdown(): Promise<void> { return Promise.resolve() }
}
