import { useWorkspace } from '../../app/workspace-context'
import { getEntityLifecycle, isEntityArchived, isEntityRemoved, normalizeLifecycleTarget, type LifecycleTarget } from '../../domain/lifecycle'
import { workspaceCanEdit } from '../../domain/workspace-permissions'

export function useLifecycleAccess(target?: LifecycleTarget) {
  const { workspace, cloud, lifecycleOperations = [] } = useWorkspace()
  const summary = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)
  const workspaceTarget: LifecycleTarget = { kind: 'workspace', id: cloud.currentWorkspaceId }
  const actual = target ?? workspaceTarget
  const archived = isEntityArchived(workspace, actual)
  const normalized = normalizeLifecycleTarget(workspace, actual)
  const rubric = normalized.kind === 'rubric' ? workspace.rubrics.find((item) => item.groupId === normalized.id) : undefined
  const metadata = getEntityLifecycle(workspace, normalized)
  const parentKey = metadata?.parentKey ?? (rubric?.jobId ? `job:${rubric.jobId}` : undefined)
  const separator = parentKey?.indexOf(':') ?? -1
  const parent = parentKey && separator > 0 ? { kind: parentKey.slice(0, separator), id: parentKey.slice(separator + 1) } as LifecycleTarget : undefined
  const inherited = normalized.kind !== 'workspace' && Boolean(workspace.lifecycle?.archivedAt || (parent && isEntityArchived(workspace, parent)))
  const deleting = Boolean(metadata?.deletingAt || (parent && getEntityLifecycle(workspace, parent)?.deletingAt) ||
    (summary?.lifecycleOperation?.action === 'delete' && summary.lifecycleOperation.status !== 'complete'))
  // Real bridges project every server record (including ladders) as a `kind:id` lifecycle entity.
  const exists = normalized.kind === 'workspace' || Boolean(workspace.lifecycle?.entities[`${normalized.kind}:${normalized.id}`]) ||
    (normalized.kind === 'job' ? workspace.jobs.some((item) => item.id === normalized.id) :
      normalized.kind === 'rubric' ? workspace.rubrics.some((item) => item.groupId === normalized.id) : false)
  const removed = !summary || Boolean(summary.deletedAt) || !exists || isEntityRemoved(workspace, actual)
  const managing = Boolean(summary && !summary.deletedAt && (actual.kind === 'workspace' ? summary.role === 'owner' : workspaceCanEdit(summary.role)))
  const editing = workspaceCanEdit(summary?.role)
  const transitioning = Boolean(summary?.lifecycleOperation && summary.lifecycleOperation.status !== 'complete') ||
    lifecycleOperations.some((item) => item.operation.status !== 'complete' &&
      ((item.target.kind === normalized.kind && item.target.id === normalized.id) || (parent && item.target.kind === parent.kind && item.target.id === parent.id)))
  const canRestoreEmptyGrade = managing && normalized.kind === 'rubric' && normalized.id.startsWith('grade-head-') &&
    Boolean(metadata?.deletedAt && metadata.archivedAt && parent?.kind === 'ladder') &&
    !deleting && !transitioning && Boolean(parent && !isEntityRemoved(workspace, parent))
  return { archived, inherited, deleting, removed, canManage: managing && !removed && !deleting && !transitioning,
    canRestoreEmptyGrade, canEdit: editing && !archived && !removed && !deleting && !transitioning, transitioning }
}