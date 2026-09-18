export interface PublicFetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: Uint8Array
  signal?: AbortSignal
  maxBytes?: number
  followRedirects?: boolean
}

export interface PublicFetchedResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
  url: string
}

export type PublicFetcher = (url: string, options?: PublicFetchOptions) => Promise<PublicFetchedResponse>

export interface RenderedJobPage {
  html: string
  finalUrl: string
}
