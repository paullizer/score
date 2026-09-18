import type {
  RealResumeRecord,
  RealResumeStatus,
  ResumeEntity,
  VersionedResumeEntity,
} from '../../src/domain/real-resumes'

export interface ResumeListOptions<K extends ResumeEntity['recordType'] = ResumeEntity['recordType']> {
  recordType: K
  batchId?: string
  status?: K extends 'resume' ? RealResumeStatus : never
  continuationToken?: string
  limit?: number
}

export type ResumeTransaction<T extends ResumeEntity = ResumeEntity> =
  | { kind: 'create'; record: T }
  | { kind: 'replace'; record: T; etag: string }

export interface ResumeStore {
  get(workspaceId: string, id: string): Promise<VersionedResumeEntity | undefined>
  list<K extends ResumeEntity['recordType']>(
    workspaceId: string,
    options: ResumeListOptions<K>,
  ): Promise<{ items: VersionedResumeEntity<Extract<ResumeEntity, { recordType: K }>>[]; continuationToken?: string }>
  create<T extends ResumeEntity>(record: T): Promise<{ created: boolean; value: VersionedResumeEntity<T> }>
  replace<T extends ResumeEntity>(record: T, etag: string): Promise<VersionedResumeEntity<T>>
  // Atomic within one workspace: a create conflict or stale ETag fails every operation.
  transact(workspaceId: string, operations: ResumeTransaction[]): Promise<void>
  // Due queued records and reclaimable parsing/profiling leases; never terminal records.
  listPending(now: string, limit: number): Promise<VersionedResumeEntity<RealResumeRecord>[]>
}

export interface ResumeBlob {
  bytes: Uint8Array
  contentType: string
  sha256: string
  etag: string
}

export interface ResumeBlobStore {
  read(name: string): Promise<ResumeBlob | undefined>
  // On an existing name, return the winning stored bytes and metadata without overwriting them.
  putImmutable(name: string, bytes: Uint8Array, contentType: string): Promise<{ created: boolean; blob: ResumeBlob }>
}

export interface RealResumesDeps {
  readonly store: ResumeStore
  readonly blobs: ResumeBlobStore
}

export interface RealResumesConfig {
  cosmosEndpoint: string
  database: string
  container: string
  storageAccountUrl: string
  blobContainer: string
}
