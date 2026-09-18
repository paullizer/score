import { randomUUID } from 'node:crypto'
import type { LifecycleAction, LifecycleImpact, LifecycleOperation } from '../../src/domain/lifecycle'
import { setWorkspaceArchive } from '../../src/domain/lifecycle'
import type { WorkspaceSummary } from '../../src/domain/cloud'
import type { AuthenticatedPrincipal } from '../auth'
import { conflict, forbidden, HttpError, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { isValidWorkspaceId } from '../ids'
import { decodeWorkspace, toSummary, type WorkspaceRepository } from '../repository'
import { StoreConflictError, type DirectoryStore, type StateStore, type StoredMetadata } from '../store'
import type { WorkspaceLifecycleParticipant } from './contracts'
import { assertWorkspaceMutationLease, withWorkspaceMutationLease } from './lease'

interface Dependencies {
  repository: WorkspaceRepository
  directory: DirectoryStore
  state: StateStore
  participants: WorkspaceLifecycleParticipant[]
  now?: () => Date
}

export interface WorkspaceLifecycleResponse {
  workspace?: WorkspaceSummary
  operation?: LifecycleOperation
  deleted?: true
}

export class WorkspaceLifecycleService {
  private readonly clock: () => Date

  constructor(private readonly deps: Dependencies) {
    this.clock = deps.now ?? (() => new Date())
  }

  private timestamp(): string { return this.clock().toISOString() }

  private async metadata(principal: AuthenticatedPrincipal, id: string, owner: boolean): Promise<StoredMetadata> {
    if (!isValidWorkspaceId(id)) throw notFound()
    const stored = await this.deps.directory.getMetadata(id)
    if (!stored || stored.metadata.tenantId !== principal.tenantId) throw notFound()
    const pendingDelete = stored.metadata.lifecycleOperation?.action === 'delete' &&
      stored.metadata.lifecycleOperation.status !== 'complete'
    if (pendingDelete && stored.metadata.lifecycleStage === 'memberships' &&
      stored.metadata.ownerId === principal.principalKey) return stored
    const role = await this.deps.repository.authorizeWorkspace(principal, id, 'read')
    if (owner && role !== 'owner') throw forbidden('Only the workspace owner can archive, unarchive, or delete it.')
    return stored
  }

  private async savedImpact(stored: StoredMetadata): Promise<LifecycleImpact> {
    const id = stored.metadata.workspaceId
    const entry = await this.deps.state.getState(id)
    if (!entry) {
      if (stored.metadata.lifecycleOperation?.action === 'delete' && stored.metadata.lifecycleOperation.status !== 'complete') {
        return { target: { kind: 'workspace', id }, name: stored.metadata.name, counts: {}, blockers: [] }
      }
      throw unavailable('The saved workspace could not be checked. Nothing has been deleted.')
    }
    const workspace = decodeWorkspace(entry.content)
    const counts: Record<string, number> = {
      jobs: workspace.jobs.length, resumes: workspace.resumes.length,
      rubrics: new Set(workspace.rubrics.map(rubric => rubric.groupId)).size,
      analyses: workspace.runs.length,
    }
    for (const participant of this.deps.participants) {
      for (const [kind, count] of Object.entries(await participant.counts(id))) counts[kind] = (counts[kind] ?? 0) + count
    }
    return {
      target: { kind: 'workspace', id }, name: stored.metadata.name, counts,
      blockers: workspace.runs.map(run => ({
        kind: 'analysis', id: run.id, name: run.name, href: `/analyses/${encodeURIComponent(run.id)}`,
      })),
    }
  }

  async impact(principal: AuthenticatedPrincipal, id: string) {
    const stored = await this.metadata(principal, id, false)
    const role = stored.metadata.ownerId === principal.principalKey ? 'owner' :
      await this.deps.repository.authorizeWorkspace(principal, id, 'read')
    return { impact: await this.savedImpact(stored), workspace: toSummary(stored.metadata, stored.etag, role) }
  }

  async change(
    principal: AuthenticatedPrincipal,
    id: string,
    action: unknown,
    etag: string | undefined,
  ): Promise<WorkspaceLifecycleResponse> {
    if (action !== 'archive' && action !== 'unarchive' && action !== 'delete') throw invalidRequest('Unknown workspace lifecycle action.')
    if (!etag) throw preconditionRequired()
    if (etag === '*') throw invalidRequest('Wildcard If-Match is not accepted.')
    await this.metadata(principal, id, true)
    try {
      return await withWorkspaceMutationLease(this.deps.state, id, async () => {
        let stored = await this.metadata(principal, id, true)
        if (stored.etag !== etag) throw conflict()
        const previous = stored.metadata.lifecycleOperation
        if (previous && previous.status !== 'complete') {
          if (previous.action !== action) throw conflict('Retry the unfinished workspace lifecycle operation before choosing another action.')
          return this.execute(stored)
        }
        if ((action === 'archive' && stored.metadata.archivedAt) || (action === 'unarchive' && !stored.metadata.archivedAt)) {
          return { workspace: toSummary(stored.metadata, stored.etag, 'owner') }
        }
        if (action === 'delete') {
          const impact = await this.savedImpact(stored)
          if (impact.blockers.length) throw conflict(`Delete ${impact.blockers.length} associated ${impact.blockers.length === 1 ? 'analysis' : 'analyses'} first, including archived analyses.`)
        }
        const timestamp = this.timestamp()
        const operation: LifecycleOperation = { id: randomUUID(), action, status: 'pending', updatedAt: timestamp }
        assertWorkspaceMutationLease(id)
        stored = await this.deps.directory.replaceMetadata({
          ...stored.metadata, updatedAt: timestamp, lifecycleOperation: operation,
          ...(action === 'archive' ? { archivedAt: timestamp } : {}),
        }, stored.etag)
        return this.execute(stored)
      })
    } catch (error) {
      if (error instanceof StoreConflictError) throw conflict(error.message)
      throw error
    }
  }

  private async execute(initial: StoredMetadata): Promise<WorkspaceLifecycleResponse> {
    let stored = initial
    const id = stored.metadata.workspaceId
    const operation = stored.metadata.lifecycleOperation
    if (!operation || operation.status === 'complete') throw new Error('No unfinished workspace lifecycle operation exists.')
    const action: LifecycleAction = operation.action
    try {
      const startedAt = this.timestamp()
      stored = await this.deps.directory.replaceMetadata({
        ...stored.metadata, updatedAt: startedAt,
        lifecycleOperation: { ...operation, status: 'running', updatedAt: startedAt, error: undefined },
      }, stored.etag)

      const membershipsOnly = action === 'delete' && stored.metadata.lifecycleStage === 'memberships'
      if (action !== 'unarchive' && !membershipsOnly) {
        for (const participant of this.deps.participants) await participant.setState(id, action === 'delete' ? 'deleting' : 'archived', startedAt)
        for (const participant of this.deps.participants) await participant.cancel(id, startedAt)
      }
      const entry = await this.deps.state.getState(id)
      if (action === 'delete') {
        if (entry && decodeWorkspace(entry.content).runs.length) {
          throw conflict('An associated analysis remains. Workspace cleanup has stopped without deleting its saved state.')
        }
        if (!membershipsOnly) {
          // Participants are ordered with grade families before their seed jobs.
          for (const participant of this.deps.participants) await participant.purge(id, startedAt)
          for (const participant of this.deps.participants) await participant.setState(id, 'deleted', startedAt)
          assertWorkspaceMutationLease(id)
          if (entry) await this.deps.state.deleteState(id, entry.etag)
          stored = await this.deps.directory.replaceMetadata({
            ...stored.metadata, lifecycleStage: 'memberships',
          }, stored.etag)
        } else if (entry) {
          assertWorkspaceMutationLease(id)
          await this.deps.state.deleteState(id, entry.etag)
        }
        await this.deps.directory.deleteMemberships(id)
      } else {
        if (!entry) throw unavailable('The saved workspace is unavailable. The lifecycle operation has not completed.')
        const next = setWorkspaceArchive(decodeWorkspace(entry.content), action === 'archive', stored.metadata.archivedAt ?? startedAt)
        assertWorkspaceMutationLease(id)
        await this.deps.state.putState(id, JSON.stringify(next), entry.etag)
        if (action === 'unarchive') {
          for (const participant of this.deps.participants) await participant.setState(id, 'active', startedAt)
        }
      }
      const completedAt = this.timestamp()
      const complete: LifecycleOperation = { ...operation, status: 'complete', updatedAt: completedAt, error: undefined }
      const metadata = { ...stored.metadata, updatedAt: completedAt, lifecycleOperation: complete }
      delete metadata.lifecycleStage
      if (action === 'unarchive') delete metadata.archivedAt
      if (action === 'delete') {
        metadata.deletedAt = completedAt
        metadata.name = 'Deleted workspace'
        delete metadata.archivedAt
      }
      assertWorkspaceMutationLease(id)
      stored = await this.deps.directory.replaceMetadata(metadata, stored.etag)
      return action === 'delete' ? { deleted: true, operation: complete } :
        { workspace: toSummary(stored.metadata, stored.etag, 'owner'), operation: complete }
    } catch (error) {
      console.error('Workspace lifecycle operation incomplete:', {
        workspaceId: id, operationId: operation.id, action, name: error instanceof Error ? error.name : 'UnknownError',
      })
      const latest = await this.deps.directory.getMetadata(id)
      if (!latest || latest.metadata.lifecycleOperation?.id !== operation.id) {
        throw unavailable('Workspace lifecycle progress could not be confirmed. Reload the workspace list before retrying.')
      }
      if (latest.metadata.lifecycleOperation.status === 'complete') {
        return latest.metadata.deletedAt ? { deleted: true, operation: latest.metadata.lifecycleOperation } :
          { workspace: toSummary(latest.metadata, latest.etag, 'owner'), operation: latest.metadata.lifecycleOperation }
      }
      const timestamp = this.timestamp()
      const failed: LifecycleOperation = {
        ...operation, status: 'failed', updatedAt: timestamp,
        error: error instanceof HttpError ? error.message :
          'Workspace cleanup is incomplete. The workspace remains protected; retry to finish without restoring deleted content.',
      }
      stored = await this.deps.directory.replaceMetadata({
        ...latest.metadata, updatedAt: timestamp, lifecycleOperation: failed,
      }, latest.etag)
      return { workspace: toSummary(stored.metadata, stored.etag, 'owner'), operation: failed }
    }
  }

  async reconcile(): Promise<void> {
    const pending = await this.deps.directory.listLifecycleOperations(20)
    for (const candidate of pending) {
      const operation = candidate.metadata.lifecycleOperation
      if (!operation || operation.status === 'complete') continue
      if (this.clock().getTime() - Date.parse(operation.updatedAt) < 30_000) continue
      try {
        await withWorkspaceMutationLease(this.deps.state, candidate.metadata.workspaceId, async () => {
          const current = await this.deps.directory.getMetadata(candidate.metadata.workspaceId)
          if (current?.metadata.lifecycleOperation?.id === operation.id && current.metadata.lifecycleOperation.status !== 'complete') {
            await this.execute(current)
          }
        })
      } catch (error) {
        if (error instanceof StoreConflictError) continue
        console.error('Workspace lifecycle recovery failed:', {
          workspaceId: candidate.metadata.workspaceId, name: error instanceof Error ? error.name : 'UnknownError',
        })
      }
    }
    const scopes = new Map<string, WorkspaceLifecycleParticipant[]>()
    for (const participant of this.deps.participants) {
      try {
        const ids = await participant.pendingWorkspaces(20)
        if (ids.length > 20 || ids.some(id => !isValidWorkspaceId(id))) {
          throw new Error('Entity cleanup returned invalid workspace scopes.')
        }
        for (const id of new Set(ids)) scopes.set(id, [...(scopes.get(id) ?? []), participant])
      } catch (error) {
        console.error('Entity lifecycle recovery discovery failed:', {
          name: error instanceof Error ? error.name : 'UnknownError',
        })
      }
    }
    for (const [id, participants] of scopes) {
      try {
        await withWorkspaceMutationLease(this.deps.state, id, async () => {
          const current = await this.deps.directory.getMetadata(id)
          if (!current) throw unavailable('Entity cleanup has no owning workspace metadata.')
          if (current.metadata.lifecycleOperation && current.metadata.lifecycleOperation.status !== 'complete') return
          for (const participant of participants) {
            if (current.metadata.deletedAt) await participant.purge(id, this.timestamp())
            else await participant.resume(id, this.timestamp())
          }
        })
      } catch (error) {
        if (error instanceof StoreConflictError) continue
        console.error('Entity lifecycle recovery remains incomplete:', {
          workspaceId: id, name: error instanceof Error ? error.name : 'UnknownError',
        })
      }
    }
  }
}
