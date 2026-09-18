import type { PublicFetcher } from '../src/domain/rendering'
import { safeFetch, WorkerError } from './runtime'

export class PublicFetchSafetyError extends Error {
  readonly code = 'UNSAFE_URL'
  readonly status = 400

  constructor(cause: WorkerError) {
    super('The URL is not permitted.', { cause })
    this.name = 'PublicFetchSafetyError'
  }
}

export const safePublicFetch: PublicFetcher = async (url, options = {}) => {
  try {
    return await safeFetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      maxBytes: options.maxBytes,
      followRedirects: options.followRedirects,
    })
  } catch (error) {
    if (error instanceof WorkerError && ['invalid-url', 'unsafe-url'].includes(error.code)) {
      throw new PublicFetchSafetyError(error)
    }
    throw error
  }
}
