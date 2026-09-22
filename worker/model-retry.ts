import type { ModelRetryMetadata } from './errors'

// Persist only four-digit ISO years; long valid hints are deferred, never clamped to a shorter delay.
export const MAX_MODEL_RETRY_TIMESTAMP = Date.parse('9999-12-31T23:59:59.999Z')
export const MAX_MODEL_RETRY_DELAY_MS = 5_000

function numericDelay(value: string, unit: number, now: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const delay = Number(value) * unit
  return Number.isSafeInteger(delay) && delay >= 0 && delay <= MAX_MODEL_RETRY_TIMESTAMP - now
    ? now + delay : undefined
}

function httpDate(value: string, now: number): number | undefined {
  const obsolete = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(value)
  const asctime = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(value)
  if (obsolete) {
    const currentYear = new Date(now).getUTCFullYear()
    let year = Math.floor(currentYear / 100) * 100 + Number(obsolete[4])
    if (year > currentYear + 50) year -= 100
    value = `${obsolete[1].slice(0, 3)}, ${obsolete[2]} ${obsolete[3]} ${String(year).padStart(4, '0')} ${obsolete[5]} GMT`
  } else if (asctime) {
    value = `${asctime[1]}, ${asctime[3].trim().padStart(2, '0')} ${asctime[2]} ${asctime[5]} ${asctime[4]} GMT`
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    return undefined
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= MAX_MODEL_RETRY_TIMESTAMP &&
    new Date(timestamp).toUTCString() === value ? timestamp : undefined
}

export function providerRetryAt(headers: Headers, now: number): number | undefined {
  let latest: number | undefined
  for (const name of ['retry-after', 'retry-after-ms', 'x-ms-retry-after-ms']) {
    const value = headers.get(name)?.trim()
    if (!value || value.length > 64) continue
    const timestamp = numericDelay(value, name === 'retry-after' ? 1_000 : 1, now) ??
      (name === 'retry-after' ? httpDate(value, now) : undefined)
    if (timestamp !== undefined) latest = Math.max(latest ?? now, timestamp, now)
  }
  return latest
}

export function modelRetryFallback(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_MODEL_RETRY_DELAY_MS, 500 * 2 ** attempt)
  return Math.ceil(ceiling / 2 + ceiling / 2 * random())
}

export function safeModelRetryMetadata(value: unknown): ModelRetryMetadata {
  if (!value || typeof value !== 'object') return {}
  const status = 'httpStatus' in value ? value.httpStatus : 'status' in value ? value.status : undefined
  const retryAt = 'retryAt' in value ? value.retryAt : undefined
  return {
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    ...(typeof retryAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(retryAt) &&
      Number.isFinite(Date.parse(retryAt)) && new Date(retryAt).toISOString() === retryAt ? { retryAt } : {}),
  }
}
