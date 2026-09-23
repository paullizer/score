import type { Rubric, Workspace } from './types'

export type LifecycleKind = 'workspace' | 'job' | 'resume' | 'rubric' | 'ladder' | 'analysis'
export type LifecycleAction = 'archive' | 'unarchive' | 'delete'
export type ArchiveFilter = 'default' | 'active' | 'archived' | 'all'

export interface LifecycleTarget {
  kind: LifecycleKind
  id: string
}

export interface LifecycleMetadata {
  archivedAt?: string
  deletingAt?: string
  deletedAt?: string
  parentKey?: string
}

/** In-memory projection of server-owned lifecycle state; never persisted by the browser. */
export interface WorkspaceLifecycle {
  archivedAt?: string
  entities: Record<string, LifecycleMetadata>
}

export interface LifecycleBlocker {
  kind: 'analysis' | 'ladder'
  id: string
  name: string
  href: string
}

export interface LifecycleImpact {
  target: LifecycleTarget
  name: string
  counts: Record<string, number>
  blockers: LifecycleBlocker[]
}

export interface LifecycleOperation {
  id: string
  action: LifecycleAction
  status: 'pending' | 'running' | 'failed' | 'complete'
  updatedAt: string
  error?: string
}

export function lifecycleKey(target: LifecycleTarget): string {
  return `${target.kind}:${target.id}`
}

export function lifecycleIsRemoved(value: LifecycleMetadata | undefined): boolean {
  return Boolean(value?.deletingAt || value?.deletedAt)
}

/** Rubric versions share the lifecycle of their logical rubric group. */
export function normalizeLifecycleTarget(workspace: Workspace, target: LifecycleTarget): LifecycleTarget {
  if (target.kind === 'rubric') {
    const rubric = workspace.rubrics.find((item) => item.id === target.id)
    if (rubric) return { kind: 'rubric', id: rubric.groupId }
  }
  return target
}

export function getEntityLifecycle(workspace: Workspace, target: LifecycleTarget): LifecycleMetadata | undefined {
  const metadata = workspace.lifecycle?.entities[lifecycleKey(normalizeLifecycleTarget(workspace, target))]
  if (target.kind === 'workspace' && workspace.lifecycle?.archivedAt) {
    return { ...metadata, archivedAt: workspace.lifecycle.archivedAt }
  }
  return metadata
}

function targetFromKey(key: string): LifecycleTarget {
  const separator = key.indexOf(':')
  return { kind: key.slice(0, separator) as LifecycleKind, id: key.slice(separator + 1) }
}

function rubricParent(workspace: Workspace, rubric: Rubric): string | undefined {
  if (rubric.kind === 'job' && rubric.jobId) return `job:${rubric.jobId}`
  return workspace.lifecycle?.entities[`rubric:${rubric.groupId}`]?.parentKey
}

function parentKey(workspace: Workspace, target: LifecycleTarget): string | undefined {
  if (target.kind !== 'rubric') return undefined
  const rubric = workspace.rubrics.find((item) => item.groupId === target.id)
  return rubric ? rubricParent(workspace, rubric) : getEntityLifecycle(workspace, target)?.parentKey
}

export function isEntityRemoved(workspace: Workspace, target: LifecycleTarget): boolean {
  const normalized = normalizeLifecycleTarget(workspace, target)
  if (lifecycleIsRemoved(getEntityLifecycle(workspace, normalized))) return true
  const parent = parentKey(workspace, normalized)
  return Boolean(parent && lifecycleIsRemoved(getEntityLifecycle(workspace, targetFromKey(parent))))
}

export function isEntityArchived(workspace: Workspace, target: LifecycleTarget): boolean {
  if (workspace.lifecycle?.archivedAt) return true
  const normalized = normalizeLifecycleTarget(workspace, target)
  if (getEntityLifecycle(workspace, normalized)?.archivedAt) return true
  const parent = parentKey(workspace, normalized)
  return Boolean(parent && getEntityLifecycle(workspace, targetFromKey(parent))?.archivedAt)
}

export function matchesArchiveFilter(archived: boolean, query: string, filter: ArchiveFilter): boolean {
  if (filter === 'all' || (filter === 'default' && query.trim())) return true
  return filter === 'archived' ? archived : !archived
}