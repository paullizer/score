import type { RealJobRecord, VersionedRealJob } from '../../src/domain/real-jobs'
import type { Rubric } from '../../src/domain/types'
import type { LifecycleAction } from '../../src/domain/lifecycle'
import type { RubricApprovalRecord, RubricQaRecord } from '../../src/domain/rubric-approval'
import type { WorkspaceLifecycleControl, WorkspaceLifecycleState } from '../lifecycle/contracts'

export type JobLifecycleScope = 'job' | 'rubric'

export interface JobBlobWriter {
  id: string
  workspaceId: string
  jobId: string
  blobName: string
  expiresAt: string
  owner?: string
}

export interface JobBlobWriteFence {
  writer: JobBlobWriter
  assertActive(): Promise<void>
  signal?: AbortSignal
}

export interface RealJobStore {
  get(workspaceId: string, jobId: string): Promise<VersionedRealJob | undefined>
  list(workspaceId: string, continuationToken?: string): Promise<{ jobs: VersionedRealJob[]; continuationToken?: string }>
  /** Metadata aggregate only; fails while the workspace's job lifecycle is not active. */
  countActive(workspaceId: string): Promise<number>
  create(record: RealJobRecord): Promise<{ created: boolean; value: VersionedRealJob }>
  replace(record: RealJobRecord, expectedEtag: string): Promise<VersionedRealJob>
  listPending(now: string, limit: number): Promise<VersionedRealJob[]>
  pendingLifecycleWorkspaces(limit: number): Promise<string[]>
  listLifecyclePending(workspaceId: string, continuationToken?: string): Promise<{ jobs: VersionedRealJob[]; continuationToken?: string }>
  getRubric(workspaceId: string, rubricId: string): Promise<Rubric | undefined>
  listRubrics(workspaceId: string, jobId: string): Promise<Rubric[]>
  /** Generation publishes the rubric and its completed QA in the same transaction; edits await on-demand checks. */
  publish(record: RealJobRecord, expectedEtag: string, rubric: Rubric, checks?: RubricQaRecord): Promise<VersionedRealJob>
  /** The rubric check results for one exact saved version, if they have run. */
  getRubricQa(workspaceId: string, jobId: string, rubricId: string, version: number): Promise<RubricQaRecord | undefined>
  /** Create-only; returns the stored record when one already exists for the version. */
  createRubricQa(record: RubricQaRecord): Promise<RubricQaRecord>
  /** Atomically creates the approval record and moves the job's approval pointer to it. */
  approveRubric(record: RealJobRecord, expectedEtag: string, approval: RubricApprovalRecord): Promise<VersionedRealJob>
  getWorkspaceLifecycle(workspaceId: string): Promise<WorkspaceLifecycleControl>
  setWorkspaceLifecycle(workspaceId: string, state: WorkspaceLifecycleState, timestamp: string): Promise<void>
  cancelWorkspace(workspaceId: string, timestamp: string): Promise<void>
  transitionLifecycle(
    workspaceId: string, jobId: string, expectedEtag: string,
    scope: JobLifecycleScope, action: LifecycleAction, timestamp: string,
  ): Promise<VersionedRealJob>
  completeRubricDeletion(workspaceId: string, jobId: string, expectedEtag: string, timestamp: string): Promise<VersionedRealJob>
  purgeRubrics(workspaceId: string, jobId: string): Promise<void>
  purgeJobRecords(workspaceId: string, jobId: string, timestamp: string): Promise<void>
  purgeWorkspaceRecords(workspaceId: string, timestamp: string): Promise<void>
  beginBlobWrite(workspaceId: string, jobId: string, blobName: string, owner?: string): Promise<JobBlobWriter>
  assertBlobWrite(writer: JobBlobWriter): Promise<void>
  finishBlobWrite(writer: JobBlobWriter): Promise<void>
  listBlobWriters(workspaceId: string, jobId?: string): Promise<JobBlobWriter[]>
}

export interface JobBlob {
  bytes: Uint8Array
  contentType: string
  sha256: string
  etag: string
}

export interface JobBlobStore {
  read(blobName: string): Promise<JobBlob | undefined>
  putImmutable(blobName: string, bytes: Uint8Array, contentType: string, fence?: JobBlobWriteFence): Promise<{ created: boolean; blob: JobBlob }>
  putFenced(blobName: string, bytes: Uint8Array, contentType: string, fence: JobBlobWriteFence): Promise<{ created: boolean; blob: JobBlob }>
  list(workspaceId: string, jobId?: string, continuationToken?: string): Promise<{ names: string[]; continuationToken?: string }>
  delete(workspaceId: string, jobId: string, blobName: string): Promise<void>
}

export interface RealJobsConfig {
  cosmosEndpoint: string
  database: string
  container: string
  storageAccountUrl: string
  blobContainer: string
}
