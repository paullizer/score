import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api'
import type { RequestHandler } from 'express'
import {
  categoryForStatus, errorCategory, safeMethod, safeRequestName, safeRoute, TELEMETRY_SCOPE,
} from './telemetry-schema'
import { traceOperation } from './telemetry-operations'

const meter = metrics.getMeter(TELEMETRY_SCOPE)
const requestCount = meter.createCounter('score.api.http.request.count', { description: 'Completed HTTP requests, including unsampled requests' })
const requestDuration = meter.createHistogram('score.api.http.request.duration', { unit: 'ms', description: 'HTTP request duration, including unsampled requests' })

export const telemetryRequests: RequestHandler = (req, res, next) => {
  const started = performance.now()
  const method = safeMethod(req.method)
  const route = safeRoute(req.originalUrl)
  const span = trace.getSpan(context.active())
  span?.updateName(safeRequestName(method, route))
  span?.setAttributes({ 'http.method': method, 'http.route': route })
  let completed = false
  const finish = () => {
    if (completed) return
    completed = true
    const status = res.writableFinished ? res.statusCode : 499
    const category = categoryForStatus(status)
    const dimensions = {
      'http.method': method, 'http.route': route, 'http.status_code': status,
      ...(category ? { 'score.error.category': category } : {}),
    }
    requestCount.add(1, dimensions)
    requestDuration.record(performance.now() - started, dimensions)
    res.off('finish', finish)
    res.off('close', finish)
  }
  res.once('finish', finish)
  res.once('close', finish)
  next()
}

export function recordRequestError(error: unknown): void {
  const span = trace.getSpan(context.active())
  if (!span) return
  const category = errorCategory(error)
  span.setAttribute('score.error.category', category)
  span.setStatus({ code: SpanStatusCode.ERROR })
  span.recordException({ name: category, message: category })
}

export function telemetryMiddleware(name: 'score.auth' | 'score.csrf', handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void traceOperation(name, { 'score.operation.phase': 'auth' }, () => new Promise<void>((resolve, reject) => {
      handler(req, res, (error?: unknown) => error ? reject(error) : resolve())
    })).then(() => next(), next)
  }
}
