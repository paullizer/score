import type { GradeEntity, GradeWorkRecord, VersionedGradeEntity } from '../../src/domain/real-grades'
import type { WorkspaceLifecycleState } from '../lifecycle/contracts'
import type { LifecycleAction } from '../../src/domain/lifecycle'

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
  | { kind: 'delete'; record: GradeEntity; etag: string }

export interface GradeLifecycleControl {
  id: string
  recordType: 'grade-lifecycle'
  workspaceId: string
  ladderId?: string
  state: WorkspaceLifecycleState
  updatedAt: string
  writers?: Record<string, { expiresAt: string }>
  pending?: { action: LifecycleAction; grade?: number; updatedAt: string }[]
  preparation?: { inputFingerprint: string; expiresAt: string }
}

export interface StoredGradeControl {
  record: GradeLifecycleControl
  etag: string
}

export interface GradeTransactionOptions {
  lifecycle?: boolean
  controls?: { record: GradeLifecycleControl; etag?: string }[]
  reviveGrades?: number[]
}

export interface GradeScopeOptions {
  ladderId?: string
  grade?: number
  continuationToken?: string
  limit?: number
}

export interface GradeStore {
  get(workspaceId: string, id: string): Promise<VersionedGradeEntity | undefined>
  list(workspaceId: string, options: GradeListOptions): Promise<{ items: VersionedGradeEntity[]; continuationToken?: string }>
  create(record: GradeEntity): Promise<{ created: boolean; value: VersionedGradeEntity }>
  replace(record: GradeEntity, etag: string): Promise<VersionedGradeEntity>
  transact(workspaceId: string, operations: GradeTransaction[], options?: GradeTransactionOptions): Promise<void>
  getControl(workspaceId: string, ladderId?: string): Promise<StoredGradeControl | undefined>
  listControls(workspaceId: string, continuationToken?: string): Promise<{ items: StoredGradeControl[]; continuationToken?: string }>
  listScope(workspaceId: string, options: GradeScopeOptions): Promise<{ items: VersionedGradeEntity[]; continuationToken?: string }>
  pendingLifecycleWorkspaces(limit: number): Promise<string[]>
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
  putImmutable(name: string, bytes: Uint8Array, contentType: string, options?: { signal?: AbortSignal }): Promise<{ created: boolean; blob: GradeBlob }>
  listFamilies(workspaceId: string, continuationToken?: string): Promise<{ ladderIds: string[]; continuationToken?: string }>
  listPage(workspaceId: string, ladderId: string, continuationToken?: string): Promise<{ names: string[]; continuationToken?: string }>
  delete(name: string): Promise<void>
}

export interface RealGradesConfig {
  cosmosEndpoint: string
  database: string
  container: string
  storageAccountUrl: string
  blobContainer: string
}
