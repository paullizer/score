import { useWorkspace } from '../../app/workspace-context'
import { getEntityLifecycle, isEntityArchived, isEntityRemoved, normalizeLifecycleTarget, sampleLifecycleTargets, type LifecycleTarget } from '../../domain/lifecycle'

export function useLifecycleAccess(target?: LifecycleTarget) {
  const { workspace, cloud, lifecycleOperations = [] } = useWorkspace()
  const summary = cloud?.workspaces.find((item) => item.id === cloud.currentWorkspaceId)
  const workspaceTarget: LifecycleTarget = { kind: 'workspace', id: cloud?.currentWorkspaceId ?? 'workspace' }
  const actual = target ?? workspaceTarget
  const archived = isEntityArchived(workspace, actual)
  const normalized = normalizeLifecycleTarget(workspace, actual)
  const rubric = normalized.kind === 'rubric' ? workspace.rubrics.find((item) => item.groupId === normalized.id) : undefined
  const metadata = getEntityLifecycle(workspace, normalized)
  const parentKey = metadata?.parentKey ?? (rubric?.jobId ? `job:${rubric.jobId}` : rubric?.ladder ? `ladder:${rubric.ladder}` : undefined)
  const separator = parentKey?.indexOf(':') ?? -1
  const parent = parentKey && separator > 0 ? { kind: parentKey.slice(0, separator), id: parentKey.slice(separator + 1) } as LifecycleTarget : undefined
  const inherited = normalized.kind !== 'workspace' && Boolean(workspace.lifecycle?.archivedAt || (parent && isEntityArchived(workspace, parent)))
  const deleting = Boolean(metadata?.deletingAt || (parent && getEntityLifecycle(workspace, parent)?.deletingAt) ||
    (summary?.lifecycleOperation?.action === 'delete' && summary.lifecycleOperation.status !== 'complete'))
  const exists = normalized.kind === 'workspace' || Boolean(workspace.lifecycle?.entities[`${normalized.kind}:${normalized.id}`]) ||
    (normalized.kind === 'job' ? workspace.jobs.some((item) => item.id === normalized.id) :
      normalized.kind === 'resume' ? workspace.resumes.some((item) => item.id === normalized.id) :
        normalized.kind === 'analysis' ? workspace.runs.some((item) => item.id === normalized.id) :
          normalized.kind === 'rubric' ? workspace.rubrics.some((item) => item.groupId === normalized.id) :
            sampleLifecycleTargets(workspace).some((item) => item.kind === 'ladder' && item.id === normalized.id))
  const removed = Boolean(cloud && !summary) || Boolean(summary?.deletedAt) || !exists || isEntityRemoved(workspace, actual)
  const managing = !cloud || Boolean(summary && !summary.deletedAt && (target?.kind === 'workspace' ? summary.role === 'owner' : summary.role !== 'viewer'))
  const editing = !cloud || Boolean(summary && summary.role !== 'viewer')
  const transitioning = Boolean(summary?.lifecycleOperation && summary.lifecycleOperation.status !== 'complete') ||
    lifecycleOperations.some((item) => item.operation.status !== 'complete' &&
      ((item.target.kind === normalized.kind && item.target.id === normalized.id) || (parent && item.target.kind === parent.kind && item.target.id === parent.id)))
  const canRestoreEmptyGrade = managing && normalized.kind === 'rubric' && normalized.id.startsWith('grade-head-') &&
    Boolean(metadata?.deletedAt && metadata.archivedAt && parent?.kind === 'ladder') &&
    !deleting && !transitioning && !cloud?.syncingState && Boolean(parent && !isEntityRemoved(workspace, parent))
  return { archived, inherited, deleting, removed, syncing: Boolean(cloud?.syncingState), canManage: managing && !removed && !deleting && !transitioning,
    canRestoreEmptyGrade, canEdit: editing && !archived && !removed && !deleting && !transitioning && !cloud?.syncingState, transitioning }
}
