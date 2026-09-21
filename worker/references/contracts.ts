import type { GradeContext, OpmDiscoveryResult, ReferenceDocument, ReferenceLink, ReferenceSourceRecord } from '../../src/domain/real-grades'
import type { GradeBlob } from '../../server/grades/store'
import type { BrowserRenderer, DocumentIntelligenceClientOptions } from '../runtime'
import type { PublicFetcher } from '../../src/domain/rendering'
import type { ProcessingSettingsSnapshot } from '../../src/domain/admin-settings'

export interface DiscoveryOptions {
  processingSettings?: ProcessingSettingsSnapshot
  fetcher?: PublicFetcher
  browser?: BrowserRenderer
  signal?: AbortSignal
}

export type DiscoverOpmSources = (context: GradeContext, options?: DiscoveryOptions) => Promise<OpmDiscoveryResult>

export interface ReferenceOriginal {
  bytes: Uint8Array
  contentType: 'application/pdf' | 'text/html'
  finalUrl?: string
  redirects: string[]
}

export interface ReferenceExtractionOptions extends DiscoveryOptions {
  documentIntelligence: Omit<DocumentIntelligenceClientOptions, 'signal'>
  readChunk?: (key: string) => Promise<GradeBlob | undefined>
  writeChunk?: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>
}

export interface ReferenceExtraction {
  document: ReferenceDocument
  method: 'document-intelligence' | 'html' | 'browser'
  extractionVersion: string
  links: ReferenceLink[]
  warnings: string[]
}

export type FetchReferenceOriginal = (source: ReferenceSourceRecord, options?: DiscoveryOptions) => Promise<ReferenceOriginal>
export type ExtractReferenceDocument = (
  source: ReferenceSourceRecord,
  original: ReferenceOriginal,
  options: ReferenceExtractionOptions,
) => Promise<ReferenceExtraction>
