import type {
  AnalysisEntity,
  VersionedAnalysisEntity,
} from '../../src/domain/real-analyses'
import type { LifecycleOperation, LifecycleTarget } from '../../src/domain/lifecycle'
import type { WorkspaceLifecycleState } from '../lifecycle/contracts'

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
  | { kind: 'delete'; record: T; etag: string }

export interface AnalysisLifecycleControl {
  id: string
  recordType: 'analysis-lifecycle'
  workspaceId: string
  runId?: string
  state: WorkspaceLifecycleState
  updatedAt: string
  operation?: LifecycleOperation
  // Retained only while deletion is incomplete, before the immutable manifest can disappear.
  dependencies?: { manifestSha256: string; targets: LifecycleTarget[] }
  writers?: Record<string, { blobName: string; expiresAt: string }>
}

export interface StoredAnalysisControl {
  record: AnalysisLifecycleControl
  etag: string
}

export interface AnalysisTransactionOptions {
  lifecycle?: boolean
  controls?: { record: AnalysisLifecycleControl; etag?: string }[]
}

export interface AnalysisStore {
  get(workspaceId: string, id: string): Promise<VersionedAnalysisEntity | undefined>
  list<K extends AnalysisEntity['recordType']>(
    workspaceId: string,
    options: AnalysisListOptions<K>,
  ): Promise<{ items: VersionedAnalysisEntity<Extract<AnalysisEntity, { recordType: K }>>[]; continuationToken?: string }>
  create<T extends AnalysisEntity>(record: T): Promise<{ created: boolean; value: VersionedAnalysisEntity<T> }>
  replace<T extends AnalysisEntity>(record: T, etag: string): Promise<VersionedAnalysisEntity<T>>
  // Pair comparison writes with an ETag-fenced run replacement; initialization uses bounded chunks.
  transact(workspaceId: string, operations: AnalysisTransaction[], options?: AnalysisTransactionOptions): Promise<void>
  getControl(workspaceId: string, runId?: string): Promise<StoredAnalysisControl | undefined>
  listControls(workspaceId: string, continuationToken?: string): Promise<{ items: StoredAnalysisControl[]; continuationToken?: string }>
  pendingLifecycleWorkspaces(limit: number): Promise<string[]>
  // Includes bounded narrative scheduling and due/lease-expired sidecar work.
  listPending(
    now: string,
    limit: number,
  ): Promise<VersionedAnalysisEntity[]>
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
  putFenced(name: string, bytes: Uint8Array, contentType: string, fence: AnalysisBlobWriteFence): Promise<{ created: boolean; blob: AnalysisBlob }>
  list(workspaceId: string, runId?: string, continuationToken?: string): Promise<{
    items: { name: string; etag: string }[]
    continuationToken?: string
  }>
  delete(workspaceId: string, runId: string, name: string, etag: string): Promise<void>
}

export interface AnalysisBlobWriteFence {
  id: string
  workspaceId: string
  runId: string
  blobName: string
  expiresAt: string
  signal?: AbortSignal
  assertActive(): Promise<void>
}

export interface RealAnalysesDeps {
  readonly store: AnalysisStore
  readonly blobs: AnalysisBlobStore
  readonly evidenceCorrectionsEnabled?: boolean
}

export interface RealAnalysesConfig {
  cosmosEndpoint: string
  database: string
  container: string
  storageAccountUrl: string
  blobContainer: string
  evidenceCorrectionsEnabled?: boolean
}
