import type {
  AnalysisEntity,
  RealAnalysisComparisonRecord,
  RealAnalysisRunRecord,
  VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'

export interface AnalysisListOptions<K extends AnalysisEntity['recordType'] = AnalysisEntity['recordType']> {
  recordType: K
  runId?: string
  status?: Extract<AnalysisEntity, { recordType: K }>['status']
  continuationToken?: string
  limit?: number
}

export type AnalysisTransaction<T extends AnalysisEntity = AnalysisEntity> =
  | { kind: 'create'; record: T }
  | { kind: 'replace'; record: T; etag: string }

export interface AnalysisStore {
  get(workspaceId: string, id: string): Promise<VersionedAnalysisEntity | undefined>
  list<K extends AnalysisEntity['recordType']>(
    workspaceId: string,
    options: AnalysisListOptions<K>,
  ): Promise<{ items: VersionedAnalysisEntity<Extract<AnalysisEntity, { recordType: K }>>[]; continuationToken?: string }>
  create<T extends AnalysisEntity>(record: T): Promise<{ created: boolean; value: VersionedAnalysisEntity<T> }>
  replace<T extends AnalysisEntity>(record: T, etag: string): Promise<VersionedAnalysisEntity<T>>
  // Pair comparison writes with an ETag-fenced run replacement; initialization uses bounded chunks.
  transact(workspaceId: string, operations: AnalysisTransaction[]): Promise<void>
  // Includes due/lease-expired initialization, unfinished cancellation, and eligible comparison work.
  listPending(
    now: string,
    limit: number,
  ): Promise<VersionedAnalysisEntity<RealAnalysisRunRecord | RealAnalysisComparisonRecord>[]>
}

export interface AnalysisBlob {
  bytes: Uint8Array
  contentType: string
  sha256: string
  etag: string
}

export interface AnalysisBlobStore {
  read(name: string): Promise<AnalysisBlob | undefined>
  // On an existing name, return the winning stored bytes and metadata without overwriting them.
  putImmutable(name: string, bytes: Uint8Array, contentType: string): Promise<{ created: boolean; blob: AnalysisBlob }>
}

export interface RealAnalysesDeps {
  readonly store: AnalysisStore
  readonly blobs: AnalysisBlobStore
}

export interface RealAnalysesConfig {
  cosmosEndpoint: string
  database: string
  container: string
  storageAccountUrl: string
  blobContainer: string
}
