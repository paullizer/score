import { isEntityArchived, isEntityRemoved, type LifecycleMetadata, type LifecycleOperation, type LifecycleTarget } from '../domain/lifecycle'
import type { Workspace } from '../domain/types'
import type { PendingLifecycleChange, WorkspaceContextValue } from './workspace-context'
import { workspaceCanEdit } from '../domain/workspace-permissions'

export function realWorkspaceWritable(parent: WorkspaceContextValue, workspaceId: string): boolean {
  const metadata = parent.cloud?.workspaces.find((item) => item.id === workspaceId)
  return Boolean(metadata && workspaceCanEdit(metadata.role) && !metadata.archivedAt && !metadata.deletedAt
    && (!metadata.lifecycleOperation || metadata.lifecycleOperation.status === 'complete') && !parent.cloud?.syncingState
    && !isEntityArchived(parent.workspace, { kind: 'workspace', id: workspaceId })
    && !isEntityRemoved(parent.workspace, { kind: 'workspace', id: workspaceId }))
}

export function assertRealLifecyclePermission(parent: WorkspaceContextValue, workspaceId: string) {
  const metadata = parent.cloud?.workspaces.find((item) => item.id === workspaceId)
  if (!metadata || !workspaceCanEdit(metadata.role) || metadata.deletedAt) throw new Error('This workspace is read-only or unavailable.')
  if (metadata.lifecycleOperation && metadata.lifecycleOperation.status !== 'complete') throw new Error('Finish the workspace lifecycle operation before changing individual records.')
}

export function projectRealLifecycle(
  workspace: Workspace, kind: 'resume' | 'analysis', entries: { id: string; lifecycle?: LifecycleMetadata }[],
): Workspace {
  return {
    ...workspace,
    lifecycle: {
      ...workspace.lifecycle,
      entities: { ...workspace.lifecycle?.entities, ...Object.fromEntries(entries.map((item) => [`${kind}:${item.id}`, item.lifecycle ?? {}])) },
    },
  }
}

export function discoveredLifecycle(
  target: LifecycleTarget, name: string, metadata?: LifecycleMetadata, operation?: LifecycleOperation,
): PendingLifecycleChange | undefined {
  if (operation) return { target, name, operation }
  if (metadata?.deletingAt && !metadata.deletedAt) return {
    target, name, operation: { id: `${target.kind}-delete:${target.id}`, action: 'delete', status: 'pending', updatedAt: metadata.deletingAt },
  }
}

export function reconcileLifecycleOperations(
  current: PendingLifecycleChange[], discovered: (PendingLifecycleChange | undefined)[],
): PendingLifecycleChange[] {
  const next = new Map(current.map((item) => [`${item.target.kind}:${item.target.id}`, item]))
  for (const item of discovered) if (item) {
    const key = `${item.target.kind}:${item.target.id}`
    if (item.operation.status !== 'complete') next.set(key, item)
    else if (next.get(key)?.operation.id === item.operation.id && next.get(key)?.operation.action === item.operation.action) next.delete(key)
  }
  return [...next.values()]
}
