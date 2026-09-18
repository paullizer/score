import type { GradeEntity, GradeWorkRecord, VersionedGradeEntity } from '../../src/domain/real-grades'

export interface GradeListOptions {
  recordType: GradeEntity['recordType']
  ladderId?: string
  grade?: number
  generationId?: string
  status?: string
  continuationToken?: string
  limit?: number
}

export type GradeTransaction =
  | { kind: 'create'; record: GradeEntity }
  | { kind: 'replace'; record: GradeEntity; etag: string }

export interface GradeStore {
  get(workspaceId: string, id: string): Promise<VersionedGradeEntity | undefined>
  list(workspaceId: string, options: GradeListOptions): Promise<{ items: VersionedGradeEntity[]; continuationToken?: string }>
  create(record: GradeEntity): Promise<{ created: boolean; value: VersionedGradeEntity }>
  replace(record: GradeEntity, etag: string): Promise<VersionedGradeEntity>
  transact(workspaceId: string, operations: GradeTransaction[]): Promise<void>
  listPending(now: string, limit: number): Promise<VersionedGradeEntity<GradeWorkRecord>[]>
}

export interface GradeBlob {
  bytes: Uint8Array
  contentType: string
  sha256: string
  etag: string
}

export interface GradeBlobStore {
  read(name: string): Promise<GradeBlob | undefined>
  putImmutable(name: string, bytes: Uint8Array, contentType: string): Promise<{ created: boolean; blob: GradeBlob }>
}

export interface RealGradesConfig {
  cosmosEndpoint: string
  database: string
  container: string
  storageAccountUrl: string
  blobContainer: string
}
