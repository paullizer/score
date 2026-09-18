import type { Job, Rubric, SourceDocument } from './types'
import type { LifecycleMetadata } from './lifecycle'

export const JOB_IMPORT_LIMITS = {
  maxPdfBytes: 10 * 1024 * 1024,
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
  kind: 'pdf' | 'url'
  displayName: string
  url?: string
  finalUrl?: string
  originalBlobName?: string
  originalContentType?: 'application/pdf' | 'text/html'
  sha256?: string
  bytes?: number
  capturedAt?: string
  extractionMethod?: 'document-intelligence' | 'html' | 'browser'
}

export interface RealJobRecord {
  id: string
  workspaceId: string
  recordType: 'job'
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
}

export interface VersionedRealJob {
  record: RealJobRecord
  etag: string
}

export interface RealJobSummary {
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

export interface JobProcessingFeatures {
  realJobImports: boolean
  limits: typeof JOB_IMPORT_LIMITS
}

export function isRealJob(job: Job): boolean {
  return job.dataKind === 'real'
}

export function isRealRubric(rubric: Rubric): boolean {
  return rubric.dataKind === 'real'
}
