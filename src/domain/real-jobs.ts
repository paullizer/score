import type { Job, Rubric, SourceDocument } from './types'
import type { LifecycleMetadata } from './lifecycle'
import type { OriginalContentType, UploadFormat, WordImportFeatures } from './document-formats'
import { MAX_MARKDOWN_BYTES } from './source-files'
import type { ProcessingSettingsSnapshot } from './admin-settings'

export const JOB_IMPORT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxPdfBytes: 10 * 1024 * 1024,
  maxMarkdownBytes: MAX_MARKDOWN_BYTES,
  maxPdfPages: 50,
  maxSourceCharacters: 180_000,
  maxBatchFiles: 10,
  maxUrlLength: 4096,
  maxCriteria: 20,
} as const

export interface JobImportError {
  code: string
  message: string
  retryable: boolean
}

export interface RealJobSource {
  kind: UploadFormat | 'url'
  displayName: string
  url?: string
  finalUrl?: string
  originalBlobName?: string
  originalContentType?: OriginalContentType
  sha256?: string
  bytes?: number
  capturedAt?: string
  extractionMethod?: 'document-intelligence' | 'html' | 'browser' | 'markdown' | 'legacy-word'
}

export interface RealJobRecord {
  id: string
  workspaceId: string
  recordType: 'job'
  displayName?: string
  job: Job & { dataKind: 'real' }
  source: RealJobSource
  inputFingerprint: string
  createdBy: string
  updatedAt: string
  attempts: number
  nextAttemptAt?: string
  lease?: { owner: string; expiresAt: string }
  extractedBlobName?: string
  error?: JobImportError
  warnings: string[]
  lifecycle?: LifecycleMetadata
  rubricLifecycle?: LifecycleMetadata
  processingSettings?: ProcessingSettingsSnapshot
}

export interface VersionedRealJob {
  record: RealJobRecord
  etag: string
}

export interface RealJobSummary {
  displayName?: string
  job: Job & { dataKind: 'real' }
  source: RealJobSource
  rubric: Rubric | null
  etag: string
  updatedAt: string
  attempts: number
  error?: JobImportError
  warnings: string[]
  lifecycle?: LifecycleMetadata
  rubricLifecycle?: LifecycleMetadata
}

export interface RealJobDetail extends RealJobSummary {
  document: SourceDocument | null
  rubricVersions: Rubric[]
}

export interface RealJobsPage {
  jobs: RealJobSummary[]
  continuationToken?: string
}

export interface JobProcessingFeatures extends WordImportFeatures {
  realJobImports: boolean
  markdownJobImports: boolean
  rubricAssistant: boolean
  limits: { [K in keyof typeof JOB_IMPORT_LIMITS]: number }
}

export function isRealJob(job: Job): boolean {
  return job.dataKind === 'real'
}

export function isRealRubric(rubric: Rubric): boolean {
  return rubric.dataKind === 'real'
}
