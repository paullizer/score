import { allowedRegistries } from '../policy/review.mjs'

export const MINIMUM_RELEASE_AGE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_METADATA_BYTES = 64 * 1024 * 1024

export function releaseAgeDays(value = MINIMUM_RELEASE_AGE_DAYS) {
  const days = Number(value)
  if (!Number.isSafeInteger(days) || days < MINIMUM_RELEASE_AGE_DAYS) {
    throw new Error(`Release age must be an integer of at least ${MINIMUM_RELEASE_AGE_DAYS} days.`)
  }
  return days
}

export function publicationStatus(published, now = new Date(), days = MINIMUM_RELEASE_AGE_DAYS) {
  const minimum = releaseAgeDays(days)
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid release-age clock.')
  if (typeof published !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(published)) {
    return 'unverified'
  }
  const timestamp = Date.parse(published)
  if (!Number.isFinite(timestamp)) return 'unverified'
  const date = published.slice(0, 10)
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return 'unverified'
  return timestamp <= now.getTime() - minimum * DAY_MS ? 'old' : 'fresh'
}

export async function fetchMetadata(url, { fetchImpl = globalThis.fetch, headers = {} } = {}) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new Error('Release metadata requires a credential-free HTTPS URL on the standard port.')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'application/json', ...headers },
    })
    if (!response.ok) throw new Error(`metadata source returned HTTP ${response.status}`)
    const chunks = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > MAX_METADATA_BYTES) throw new Error('metadata response exceeded size limit')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    clearTimeout(timer)
  }
}

export async function mapLimit(items, limit, fn) {
  const result = new Map()
  let index = 0
  async function worker() {
    for (;;) {
      const current = index++
      if (current >= items.length) return
      const item = items[current]
      result.set(item, await fn(item))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return result
}

export async function verifyNpmReleaseAges({ candidates, fetchImpl = globalThis.fetch, now = new Date(), days = MINIMUM_RELEASE_AGE_DAYS }) {
  releaseAgeDays(days)
  const names = [...new Set(candidates.map(item => item.name))]
  let connectionFailure
  let useMirror = false
  const mirror = allowedRegistries[1].prefix
  const metadata = await mapLimit(names, 4, async name => {
    if (connectionFailure) return { error: connectionFailure }
    try {
      const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
      let packument
      if (useMirror) packument = await fetchMetadata(`${mirror}${encoded}`, { fetchImpl })
      else {
        try {
          packument = await fetchMetadata(`https://registry.npmjs.org/${encoded}`, { fetchImpl })
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          if (!useMirror) console.warn('Canonical npm metadata transport failed; checking publication evidence through the approved public 1ES npm mirror.')
          useMirror = true
          packument = await fetchMetadata(`${mirror}${encoded}`, { fetchImpl })
        }
      }
      return { packument }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof TypeError || error?.name === 'AbortError') connectionFailure = `Registry connection failed; remaining ages are unverified: ${message}`
      return { error: message }
    }
  })
  return candidates.map(item => {
    const entry = metadata.get(item.name)
    if (entry.error) return { ...item, status: 'unverified', reason: entry.error }
    const published = entry.packument?.time?.[item.version]
    return { ...item, published, status: publicationStatus(published, now, days), reason: 'publish time was missing or invalid' }
  })
}
