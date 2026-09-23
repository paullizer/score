import type { Rubric, Workspace } from './types'
import { isEntityRemoved } from './lifecycle'

export function latestRubrics(workspace: Workspace): Rubric[] {
  const latest = new Map<string, Rubric>()
  for (const rubric of workspace.rubrics) {
    if ((latest.get(rubric.groupId)?.version ?? 0) < rubric.version) latest.set(rubric.groupId, rubric)
  }
  return [...latest.values()].filter((rubric) => !isEntityRemoved(workspace, { kind: 'rubric', id: rubric.groupId }))
}

export function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value))
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
}
