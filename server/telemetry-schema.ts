export const TELEMETRY_ROLE = 'score-api'
export const TELEMETRY_SCOPE = 'score.api'

const operationNames = new Set([
  'score.auth',
  'score.csrf',
  'score.analysis.authorize',
  'score.analysis.comparison',
  'score.analysis.summary.inventory',
  'score.analysis.summary.candidate',
  'score.analysis.summary.target',
  'score.analysis.publication.read',
  'score.analysis.manifest.read',
  'score.analysis.snapshot.read',
  'score.analysis.result.read',
  'score.analysis.validation',
  'score.storage.query',
  'score.storage.blob.read',
  'score.operation.other',
])

export function safeOperationName(name: unknown): string {
  return typeof name === 'string' && operationNames.has(name) ? name : 'score.operation.other'
}

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

export function safeMethod(method: unknown): string {
  return typeof method === 'string' && methods.has(method) ? method : 'OTHER'
}

const workspace = '/api/workspaces/:workspaceId'
const analyses = `${workspace}/analyses`
const run = `${analyses}/:runId`
const comparison = `${run}/comparisons/:comparisonId`
const summary = `${run}/summaries/:kind/:subjectId`
const jobs = `${workspace}/jobs`
const resumes = `${workspace}/resumes`
const grades = `${workspace}/grade-ladders`
const ladder = `${grades}/:ladderId`
const routeTemplates = [
  '/healthz', '/api/features', '/api/session', '/api/session/identity', '/api/workspaces', workspace,
  '/api/admin/users', '/api/admin/users/:userId/workspace-creation',
  `${workspace}/members`, `${workspace}/members/:userId`, `${workspace}/share-candidates`,
  `${workspace}/state`, `${workspace}/lifecycle`,
  analyses, `${analyses}/targets`, run, `${run}/metadata`, `${run}/lifecycle`,
  `${run}/comparisons`, `${run}/summaries`, summary, `${summary}/history`,
  `${summary}/publish`, `${summary}/retry`, `${run}/report-comparisons`,
  `${run}/retry`, `${run}/cancel`, comparison, `${comparison}/diagnostics`,
  `${comparison}/documents/:documentId`, `${comparison}/retry`, `${comparison}/cancel`,
  ...[jobs, resumes].flatMap((base) => [
    base, ...['pdf', 'markdown', 'file', 'url'].map((suffix) => `${base}/${suffix}`),
    `${base}/:documentId`, `${base}/:documentId/metadata`, `${base}/:documentId/lifecycle`,
    `${base}/:documentId/original`, `${base}/:documentId/retry`, `${base}/:documentId/cancel`,
  ]),
  `${jobs}/:documentId/rubric`, grades, ladder, `${ladder}/lifecycle`,
  `${ladder}/discover`, `${ladder}/sources/pdf`, `${ladder}/sources/url`,
  `${ladder}/sources/:sourceId`, `${ladder}/source-set`, `${ladder}/generate`,
  `${ladder}/retry`, `${ladder}/cancel`, `${ladder}/grades/:grade/draft`,
  `${ladder}/grades/:grade/approve`, `${ladder}/grades/:grade/versions`,
  `${ladder}/source-sets/:sourceSetId`, `${ladder}/sources/:sourceId/document`,
  `${ladder}/sources/:sourceId/original`,
]
const routes = routeTemplates.map((template) => ({
  template, pattern: new RegExp(`^${template.replace(/:[a-zA-Z]+/g, '[^/]+')}/?$`),
}))

export function safeRoute(value: unknown): string {
  if (typeof value !== 'string') return '/unmatched'
  const pathname = value.split(/[?#]/, 1)[0]
  if (pathname === '/api/unmatched' || pathname === '/app' || pathname === '/assets/:asset') return pathname
  const route = routes.find(({ pattern }) => pattern.test(pathname))
  if (route) return route.template
  if (pathname === '/api' || pathname.startsWith('/api/')) return '/api/unmatched'
  if (pathname.startsWith('/assets/')) return '/assets/:asset'
  return '/app'
}

export function safeRequestName(method: unknown, route: unknown): string {
  return `${safeMethod(method)} ${safeRoute(route)}`
}

export type ErrorCategory =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'validation'
  | 'throttled' | 'dependency' | 'cancelled' | 'timeout' | 'unexpected'

const errorCategories = new Set<ErrorCategory>([
  'unauthorized', 'forbidden', 'not_found', 'conflict', 'validation',
  'throttled', 'dependency', 'cancelled', 'timeout', 'unexpected',
])

export function safeErrorCategory(category: unknown): ErrorCategory {
  return typeof category === 'string' && errorCategories.has(category as ErrorCategory)
    ? category as ErrorCategory : 'unexpected'
}

export function categoryForStatus(status: number): ErrorCategory | undefined {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409 || status === 412) return 'conflict'
  if (status === 429) return 'throttled'
  if (status === 499) return 'cancelled'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 502 || status === 503) return 'dependency'
  if (status >= 400 && status < 500) return 'validation'
  if (status >= 500) return 'unexpected'
  return undefined
}

export function errorCategory(error: unknown): ErrorCategory {
  if (typeof error !== 'object' || error === null) return 'unexpected'
  if ('name' in error) {
    if (error.name === 'AbortError' || error.name === 'CanceledError') return 'cancelled'
    if (error.name === 'TimeoutError') return 'timeout'
  }
  for (const key of ['status', 'statusCode', 'code'] as const) {
    const value = key in error ? error[key as keyof typeof error] : undefined
    if (typeof value === 'number') return categoryForStatus(value) ?? 'unexpected'
  }
  return 'unexpected'
}

export type SafeAttributes = Record<string, string | number | boolean>

const enumAttributes: Readonly<Record<string, readonly string[]>> = {
  'score.summary.kind': ['candidate', 'target'],
  'score.storage.kind': ['cosmos', 'blob'],
  'score.operation.phase': ['auth', 'query', 'blob', 'validation', 'inventory', 'publication', 'snapshot', 'result', 'manifest'],
  'score.outcome': ['success', 'failure', 'cancelled'],
  'score.dependency.kind': ['cosmos', 'blob', 'identity', 'http', 'internal'],
}

const numericAttributes: Readonly<Record<string, number>> = {
  'score.operation.count': 1_000_000,
  'score.operation.bytes': 100_000_000,
  'score.read.count': 1_000_000,
  'score.read.bytes': 100_000_000,
  'score.comparison.count': 500,
  'score.publication.count': 500,
  'score.concurrency': 32,
}

export function safeAttributes(attributes: Readonly<Record<string, unknown>>): SafeAttributes {
  const result: SafeAttributes = {}
  for (const [key, values] of Object.entries(enumAttributes)) {
    const value = attributes[key]
    if (typeof value === 'string' && values.includes(value)) result[key] = value
  }
  for (const [key, max] of Object.entries(numericAttributes)) {
    const value = attributes[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = Math.min(max, Math.floor(value))
  }
  if (attributes['score.operation'] !== undefined) result['score.operation'] = safeOperationName(attributes['score.operation'])
  if (attributes['score.error.category'] !== undefined) result['score.error.category'] = safeErrorCategory(attributes['score.error.category'])
  if (attributes['http.method'] !== undefined) result['http.method'] = safeMethod(attributes['http.method'])
  if (attributes['http.route'] !== undefined) result['http.route'] = safeRoute(attributes['http.route'])
  const status = attributes['http.status_code']
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result['http.status_code'] = status
  if (attributes['otel.metric.overflow'] === true || attributes['otel.metric.overflow'] === 'true') result['score.metrics.overflow'] = true
  return result
}
