import { metrics, SpanStatusCode, trace } from '@opentelemetry/api'
import { errorCategory, safeAttributes, safeOperationName, TELEMETRY_SCOPE } from './telemetry-schema'

const meter = metrics.getMeter(TELEMETRY_SCOPE)
const operationCount = meter.createCounter('score.api.operation.count', { description: 'Completed API operations' })
const operationDuration = meter.createHistogram('score.api.operation.duration', { unit: 'ms', description: 'API operation duration' })

export function traceOperation<T>(
  name: string,
  attributes: Readonly<Record<string, string | number | boolean>>,
  operation: () => Promise<T>,
): Promise<T> {
  const safeName = safeOperationName(name)
  const safe = { ...safeAttributes(attributes), 'score.operation': safeName }
  return trace.getTracer(TELEMETRY_SCOPE).startActiveSpan(safeName, { attributes: safe }, async (span) => {
    const started = performance.now()
    let outcome = 'success'
    let category: string | undefined
    try {
      return await operation()
    } catch (error) {
      category = errorCategory(error)
      outcome = category === 'cancelled' ? 'cancelled' : 'failure'
      span.setAttribute('score.error.category', category)
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.recordException({ name: category, message: category })
      throw error
    } finally {
      const dimensions = {
        'score.operation': safeName,
        'score.outcome': outcome,
        ...(category ? { 'score.error.category': category } : {}),
      }
      operationCount.add(1, dimensions)
      operationDuration.record(performance.now() - started, dimensions)
      span.end()
    }
  })
}
