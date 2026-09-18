import type { LifecycleImpact } from '../../src/domain/lifecycle'
import type { VersionedRealJob } from '../../src/domain/real-jobs'
import type { LifecycleDependencies, WorkspaceLifecycleParticipant } from '../lifecycle/contracts'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { unavailable } from '../errors'
import { StoreConflictError } from '../store'
import type { RealJobsDeps } from './routes'
import type { JobLifecycleScope } from './store'
import { isJobBlobInScope } from './validation'

export class JobCleanupPendingError extends Error {
  readonly retryAt: string

  constructor(retryAt: string) {
    super('Job source writers are draining. Retry deletion after outstanding uploads have stopped.')
    this.name = 'JobCleanupPendingError'
    this.retryAt = retryAt
  }
}

export function requireJobLifecycle(jobs: RealJobsDeps): void {
  const methods = [
    'getWorkspaceLifecycle', 'setWorkspaceLifecycle', 'cancelWorkspace', 'transitionLifecycle',
    'completeRubricDeletion', 'purgeRubrics', 'purgeJobRecords', 'purgeWorkspaceRecords',
    'beginBlobWrite', 'assertBlobWrite', 'finishBlobWrite', 'listBlobWriters',
  ] as const
  if (methods.some(method => typeof jobs.store[method] !== 'function') ||
    typeof jobs.blobs.list !== 'function' || typeof jobs.blobs.delete !== 'function' ||
    typeof jobs.blobs.putFenced !== 'function') {
    throw unavailable('Job lifecycle storage is unavailable. No cleanup was reported as complete.')
  }
}

async function sourceCount(jobs: RealJobsDeps, workspaceId: string, jobId?: string): Promise<number> {
  let count = 0
  let continuationToken: string | undefined
  do {
    const page = await jobs.blobs.list(workspaceId, jobId, continuationToken)
    if (page.names.some(name => !isJobBlobInScope(name, workspaceId, jobId))) {
      throw new Error('Job source listing crossed its ownership scope.')
    }
    count += page.names.length
    continuationToken = page.continuationToken
  } while (continuationToken)
  return count
}

export async function jobLifecycleImpact(
  jobs: RealJobsDeps,
  value: VersionedRealJob,
  scope: JobLifecycleScope,
  dependencies: LifecycleDependencies | undefined,
): Promise<LifecycleImpact> {
  requireJobLifecycle(jobs)
  if (!dependencies) throw unavailable('Job lifecycle dependency checks are unavailable.')
  const { record } = value
  const versions = await jobs.store.listRubrics(record.workspaceId, record.id)
  const latest = versions.findLast(rubric => rubric.id === record.job.rubricId) ?? versions.at(-1)
  const target: LifecycleImpact['target'] = scope === 'job'
    ? { kind: 'job', id: record.id }
    : { kind: 'rubric', id: latest?.groupId ?? record.job.rubricId ?? `rubric-${record.id}` }
  return {
    target,
    name: scope === 'job' ? record.job.title : latest?.name ?? `${record.job.title} rubric`,
    counts: {
      ...(scope === 'job' ? { jobs: 1, sourceArtifacts: await sourceCount(jobs, record.workspaceId, record.id) } : {}),
      rubrics: versions.length ? 1 : 0,
      rubricVersions: versions.length,
    },
    blockers: await dependencies.impact(record.workspaceId, target),
  }
}

async function waitForWriters(jobs: RealJobsDeps, workspaceId: string, jobId?: string): Promise<void> {
  const writers = await jobs.store.listBlobWriters(workspaceId, jobId)
  const active = writers.filter(writer => Date.parse(writer.expiresAt) > Date.now())
  if (active.length) {
    throw new JobCleanupPendingError(active.map(writer => writer.expiresAt).sort().at(-1) as string)
  }
}

async function purgeSources(jobs: RealJobsDeps, workspaceId: string, jobId?: string): Promise<void> {
  // Repeat from the beginning after paginated deletion; continuation tokens need not be stable under deletes.
  for (let sweep = 0; sweep < 4; sweep += 1) {
    let removed = 0
    let continuationToken: string | undefined
    do {
      const page = await jobs.blobs.list(workspaceId, jobId, continuationToken)
      for (const name of page.names) {
        if (!isJobBlobInScope(name, workspaceId, jobId)) throw new Error('Refusing to purge a job source outside its ownership scope.')
        assertWorkspaceMutationLease(workspaceId)
        await jobs.blobs.delete(workspaceId, name.split('/')[1], name)
        removed += 1
      }
      continuationToken = page.continuationToken
    } while (continuationToken)
    if (removed === 0) return
  }
  if (await sourceCount(jobs, workspaceId, jobId)) throw new Error('Job source cleanup has not drained.')
}

export async function purgeJob(
  jobs: RealJobsDeps,
  value: VersionedRealJob,
  timestamp: string,
): Promise<void> {
  requireJobLifecycle(jobs)
  const { record } = value
  if (!record.lifecycle?.deletingAt) throw new StoreConflictError('Job deletion has not been fenced.')
  await waitForWriters(jobs, record.workspaceId, record.id)
  await purgeSources(jobs, record.workspaceId, record.id)
  assertWorkspaceMutationLease(record.workspaceId)
  await jobs.store.purgeJobRecords(record.workspaceId, record.id, timestamp)
}

export async function purgeJobRubric(
  jobs: RealJobsDeps,
  value: VersionedRealJob,
  timestamp: string,
): Promise<VersionedRealJob> {
  requireJobLifecycle(jobs)
  if (!value.record.rubricLifecycle?.deletingAt) throw new StoreConflictError('Rubric deletion has not been fenced.')
  assertWorkspaceMutationLease(value.record.workspaceId)
  await jobs.store.purgeRubrics(value.record.workspaceId, value.record.id)
  assertWorkspaceMutationLease(value.record.workspaceId)
  return jobs.store.completeRubricDeletion(value.record.workspaceId, value.record.id, value.etag, timestamp)
}

export function createJobLifecycleParticipant(jobs: RealJobsDeps): WorkspaceLifecycleParticipant {
  return {
    async pendingWorkspaces(limit) {
      if (typeof jobs.store.pendingLifecycleWorkspaces !== 'function') {
        throw unavailable('Job lifecycle recovery discovery is unavailable.')
      }
      return jobs.store.pendingLifecycleWorkspaces(limit)
    },
    async resume(workspaceId, timestamp) {
      requireJobLifecycle(jobs)
      if (typeof jobs.store.listLifecyclePending !== 'function') {
        throw unavailable('Job lifecycle recovery storage is unavailable.')
      }
      const control = await jobs.store.getWorkspaceLifecycle(workspaceId)
      if (control.state === 'deleting' || control.state === 'deleted') {
        throw new StoreConflictError('Finish workspace cleanup before resuming individual job deletion.')
      }
      // One bounded page per reconciliation pass; completed records leave this query immediately.
      let page = await jobs.store.listLifecyclePending(workspaceId)
      const tokens = new Set<string>()
      while (!page.jobs.length && page.continuationToken) {
        assertWorkspaceMutationLease(workspaceId)
        if (tokens.has(page.continuationToken)) throw unavailable('Job lifecycle recovery pagination did not advance.')
        tokens.add(page.continuationToken)
        page = await jobs.store.listLifecyclePending(workspaceId, page.continuationToken)
      }
      let failure: unknown
      for (const value of page.jobs) {
        assertWorkspaceMutationLease(workspaceId)
        try {
          if (value.record.lifecycle?.deletingAt) await purgeJob(jobs, value, timestamp)
          else if (value.record.rubricLifecycle?.deletingAt) await purgeJobRubric(jobs, value, timestamp)
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error('Job lifecycle cleanup did not complete.')
        }
      }
      if (failure) throw failure
    },
    async setState(workspaceId, state, timestamp) {
      requireJobLifecycle(jobs)
      assertWorkspaceMutationLease(workspaceId)
      // Root finalization may retry after this store has already reached its terminal fence.
      if (state === 'deleting' && (await jobs.store.getWorkspaceLifecycle(workspaceId)).state === 'deleted') return
      await jobs.store.setWorkspaceLifecycle(workspaceId, state, timestamp)
    },
    async cancel(workspaceId, timestamp) {
      requireJobLifecycle(jobs)
      assertWorkspaceMutationLease(workspaceId)
      await jobs.store.cancelWorkspace(workspaceId, timestamp)
    },
    async purge(workspaceId, timestamp) {
      requireJobLifecycle(jobs)
      const control = await jobs.store.getWorkspaceLifecycle(workspaceId)
      if (!['deleting', 'deleted'].includes(control.state)) throw new StoreConflictError('Workspace deletion has not been fenced.')
      await waitForWriters(jobs, workspaceId)
      await purgeSources(jobs, workspaceId)
      assertWorkspaceMutationLease(workspaceId)
      await jobs.store.purgeWorkspaceRecords(workspaceId, timestamp)
    },
    async counts(workspaceId) {
      requireJobLifecycle(jobs)
      let jobsCount = 0
      let rubricCount = 0
      let rubricVersions = 0
      let continuationToken: string | undefined
      do {
        const page = await jobs.store.list(workspaceId, continuationToken)
        for (const value of page.jobs) {
          jobsCount += 1
          const versions = await jobs.store.listRubrics(workspaceId, value.record.id)
          if (versions.length) rubricCount += 1
          rubricVersions += versions.length
        }
        continuationToken = page.continuationToken
      } while (continuationToken)
      return { jobs: jobsCount, rubrics: rubricCount, rubricVersions, sourceArtifacts: await sourceCount(jobs, workspaceId) }
    },
  }
}
