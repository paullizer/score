import type { LifecycleMetadata } from '../../src/domain/lifecycle'
import type { RealJobRecord } from '../../src/domain/real-jobs'
import { StoreConflictError } from '../store'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import type { JobBlobStore, RealJobStore } from './store'
import { isBlobInJobPrefix } from './validation'

export function isJobLifecycleLocked(value: LifecycleMetadata | undefined): boolean {
  return Boolean(value?.archivedAt || value?.deletingAt || value?.deletedAt)
}

export function isJobReadOnly(record: RealJobRecord): boolean {
  return isJobLifecycleLocked(record.lifecycle) || isJobLifecycleLocked(record.rubricLifecycle) ||
    Boolean(record.job.rubricDeletedAt)
}

export function assertJobWritable(record: RealJobRecord): void {
  if (isJobReadOnly(record)) throw new StoreConflictError('This job or its rubric is archived or removed.')
}

export function cancelJobWork(record: RealJobRecord, timestamp: string): RealJobRecord {
  const active = ['queued', 'parsing', 'generating'].includes(record.job.status)
  return {
    ...record,
    updatedAt: timestamp,
    lease: undefined,
    nextAttemptAt: undefined,
    ...(active ? {
      job: { ...record.job, status: 'cancelled' as const, errorStage: undefined, error: 'Cancelled by lifecycle change.' },
      error: { code: 'cancelled', message: 'Cancelled by lifecycle change.', retryable: false },
    } : {}),
  }
}

export async function putJobBlob(
  store: RealJobStore,
  blobs: JobBlobStore,
  workspaceId: string,
  jobId: string,
  blobName: string,
  bytes: Uint8Array,
  contentType: string,
  options: { owner?: string; signal?: AbortSignal } = {},
) {
  if (!isBlobInJobPrefix(blobName, workspaceId, jobId)) throw new Error('Invalid job blob ownership.')
  if (!store.beginBlobWrite || !store.assertBlobWrite || !store.finishBlobWrite || !blobs.putFenced) {
    throw new Error('Job Blob writer fencing is unavailable.')
  }
  options.signal?.throwIfAborted()
  assertWorkspaceMutationLease(workspaceId)
  const writer = await store.beginBlobWrite(workspaceId, jobId, blobName, options.owner)
  // A failed/uncertain upload retains its bounded reservation until cleanup can safely drain it.
  const result = await blobs.putFenced(blobName, bytes, contentType, {
    writer,
    signal: options.signal,
    assertActive: async () => {
      options.signal?.throwIfAborted()
      assertWorkspaceMutationLease(workspaceId)
      await store.assertBlobWrite(writer)
      assertWorkspaceMutationLease(workspaceId)
    },
  })
  await store.finishBlobWrite(writer)
  return result
}
