import type { RealJobRecord, VersionedRealJob } from '../../src/domain/real-jobs'
import type { Rubric } from '../../src/domain/types'

export interface RealJobStore {
  get(workspaceId: string, jobId: string): Promise<VersionedRealJob | undefined>
  list(workspaceId: string, continuationToken?: string): Promise<{ jobs: VersionedRealJob[]; continuationToken?: string }>
  create(record: RealJobRecord): Promise<{ created: boolean; value: VersionedRealJob }>
  replace(record: RealJobRecord, expectedEtag: string): Promise<VersionedRealJob>
  listPending(now: string, limit: number): Promise<VersionedRealJob[]>
  getRubric(workspaceId: string, rubricId: string): Promise<Rubric | undefined>
  listRubrics(workspaceId: string, jobId: string): Promise<Rubric[]>
  publish(record: RealJobRecord, expectedEtag: string, rubric: Rubric): Promise<VersionedRealJob>
}

export interface JobBlob {
  bytes: Uint8Array
  contentType: string
  sha256: string
  etag: string
}

export interface JobBlobStore {
  read(blobName: string): Promise<JobBlob | undefined>
  putImmutable(blobName: string, bytes: Uint8Array, contentType: string): Promise<{ created: boolean; blob: JobBlob }>
}

export interface RealJobsConfig {
  cosmosEndpoint: string
  database: string
  container: string
  storageAccountUrl: string
  blobContainer: string
}
