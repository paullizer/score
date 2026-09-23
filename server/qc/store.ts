import type { QcBatchRecord, QcBlobReference, QcControl, QcPage, QcRecordBase, QcReviewHead, QcReviewSubmission, VersionedQc } from '../../src/domain/quality-control'
import type { QcPlanRecord, QcPlanRevision, QcWorkRecord } from '../../src/domain/quality-improvement'

export interface QcLifecycleControl extends QcControl {
  generation?: number
  cleanupPending?: boolean
  cancellationPending?: boolean
}
export interface QcControlFence {
  controlId: string
  generation: number
}
export interface QcRequestReceipt extends QcRecordBase {
  recordType: 'qc-request'
  actorId: string
  requestId: string
  requestHash: string
  action: string
  targetId: string
  runIds: string[]
  controlFences?: QcControlFence[]
}
export interface QcBlobWriter extends QcRecordBase {
  recordType: 'qc-writer'
  ownerId: string
  runIds: string[]
  expiresAt: string
}
export interface QcArtifactOwner extends QcRecordBase {
  recordType: 'qc-artifacts'
  ownerId: string
  runIds: string[]
}
export type QcRecord = QcReviewHead | QcReviewSubmission | QcBatchRecord | QcLifecycleControl |
  QcPlanRecord | QcPlanRevision | QcWorkRecord | QcRequestReceipt | QcBlobWriter | QcArtifactOwner
export type QcTransaction =
  | { kind: 'create'; record: QcRecord }
  | { kind: 'replace'; record: QcRecord; etag: string }
  | { kind: 'delete'; record: QcRecord; etag: string }
export interface QcListOptions {
  recordType?: QcRecord['recordType']
  runId?: string
  comparisonId?: string
  resultSha256?: string
  resultRevision?: string
  planId?: string
  authorId?: string
  ownerId?: string
  limit?: number
  continuationToken?: string
}
export interface QcTransactionOptions {
  lifecycle?: boolean
  exposure?: boolean
  assertActive?: () => void
}
export interface QcStore {
  get(workspaceId: string, id: string): Promise<VersionedQc<QcRecord> | undefined>
  list(workspaceId: string, options: QcListOptions): Promise<QcPage<QcRecord>>
  transact(workspaceId: string, operations: QcTransaction[], options?: QcTransactionOptions): Promise<void>
  pending(now: string, limit: number): Promise<VersionedQc<QcWorkRecord>[]>
  pendingLifecycle(limit: number): Promise<string[]>
}
export interface QcBlobStore {
  read(reference: QcBlobReference): Promise<Uint8Array>
  put(workspaceId: string, ownerId: string, bytes: Uint8Array, fence?: {
    runIds: string[]
    assertActive(): Promise<void>
  }): Promise<QcBlobReference>
  list(workspaceId: string, ownerId?: string, continuationToken?: string): Promise<{
    items: { name: string; etag: string }[]; continuationToken?: string
  }>
  delete(workspaceId: string, name: string, etag: string): Promise<void>
}
export interface QcConfig {
  cosmosEndpoint: string
  database: string
  container: string
  storageAccountUrl: string
  blobContainer: string
  workerEnabled: boolean
}
export interface QcDeps {
  store: QcStore
  blobs: QcBlobStore
  workerEnabled: boolean
}
