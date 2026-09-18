import type { DiscoveryOptions, ReferenceOriginal } from './contracts'
import { GRADE_LADDER_LIMITS } from '../../src/domain/real-grades'
import { safePublicFetch } from '../public-http'
import { validatePublicUrl, WorkerError } from '../runtime'

export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkerError('cancelled', 'Reference processing was cancelled.', false, 'parsing')
}

export function referenceUrl(value: string, base?: string, opmOnly = false): URL {
  if (value.length > GRADE_LADDER_LIMITS.maxUrlLength) {
    throw new WorkerError('invalid-url', 'The reference URL exceeds its length limit.', false, 'download')
  }
  let resolved: string
  try {
    resolved = base ? new URL(value, base).href : value
  } catch {
    throw new WorkerError('invalid-url', 'The reference URL is invalid.', false, 'download')
  }
  if (resolved.length > GRADE_LADDER_LIMITS.maxUrlLength) {
    throw new WorkerError('invalid-url', 'The resolved reference URL exceeds its length limit.', false, 'download')
  }
  const url = validatePublicUrl(resolved)
  if (opmOnly && !isOpmUrl(url.href)) {
    throw new WorkerError('opm-out-of-scope', 'Automatic discovery can only follow public OPM links; supply other sources for explicit review.', false, 'download')
  }
  return url
}

export function isOpmUrl(value: string): boolean {
  try {
    const url = validatePublicUrl(value)
    return url.hostname === 'opm.gov' || url.hostname.endsWith('.opm.gov')
  } catch {
    return false
  }
}

export function header(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

export function pdfSignature(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-'
}

export async function fetchOriginalUrl(
  input: string,
  options: DiscoveryOptions = {},
  opmOnly = false,
): Promise<ReferenceOriginal> {
  const fetcher = options.fetcher ?? safePublicFetch
  let url = referenceUrl(input, undefined, opmOnly)
  url.hash = ''
  const redirects: string[] = []
  const visited = new Set<string>()
  let remainingBytes = GRADE_LADDER_LIMITS.maxPdfBytes
  for (let hop = 0; hop <= 5; hop += 1) {
    checkCancellation(options.signal)
    if (visited.has(url.href)) throw new WorkerError('reference-redirect-loop', 'The reference returned a redirect loop.', false, 'download')
    visited.add(url.href)
    const response = await fetcher(url.href, {
      signal: options.signal,
      followRedirects: false,
      maxBytes: remainingBytes,
      headers: { accept: 'text/html,application/xhtml+xml,application/pdf', 'user-agent': 'ScoreReferenceImporter/1.0' },
    })
    checkCancellation(options.signal)
    remainingBytes -= response.body.byteLength
    if (remainingBytes < 0) throw new WorkerError('reference-too-large', 'Reference downloads exceed the 20 MiB per-document limit.', false, 'download')
    const responseUrl = referenceUrl(response.url || url.href, undefined, opmOnly)
    if (responseUrl.href !== url.href) {
      throw new WorkerError('reference-opaque-redirect', 'The reference transport followed an unrecorded redirect.', false, 'download')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = header(response.headers, 'location')
      if (!location) throw new WorkerError('invalid-redirect', 'The reference redirect has no destination.', false, 'download')
      if (hop === 5) throw new WorkerError('too-many-redirects', 'The reference exceeded five redirects.', false, 'download')
      const destination = referenceUrl(location, url.href, opmOnly)
      redirects.push(destination.href)
      destination.hash = ''
      url = destination
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw new WorkerError('reference-fetch-failed', `Reference retrieval returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500, 'download')
    }
    const mime = (header(response.headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (pdfSignature(response.body)) {
      return { bytes: response.body, contentType: 'application/pdf', finalUrl: url.href, redirects }
    }
    if (mime === 'application/pdf') throw new WorkerError('invalid-pdf', 'The reference is labeled PDF but has no PDF signature.', false, 'parsing')
    if (!['text/html', 'application/xhtml+xml'].includes(mime)) {
      throw new WorkerError('unsupported-reference-type', 'References must be PDF documents or public HTML pages.', false, 'download')
    }
    return { bytes: response.body, contentType: 'text/html', finalUrl: url.href, redirects }
  }
  throw new WorkerError('too-many-redirects', 'The reference exceeded five redirects.', false, 'download')
}
