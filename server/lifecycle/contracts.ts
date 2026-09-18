import type { LifecycleImpact } from '../../src/domain/lifecycle'

export type WorkspaceLifecycleState = 'active' | 'archived' | 'deleting' | 'deleted'

export interface WorkspaceLifecycleControl {
  state: WorkspaceLifecycleState
  updatedAt: string
}

export interface WorkspaceLifecycleParticipant {
  setState(workspaceId: string, state: WorkspaceLifecycleState, timestamp: string): Promise<void>
  cancel(workspaceId: string, timestamp: string): Promise<void>
  purge(workspaceId: string, timestamp: string): Promise<void>
  counts(workspaceId: string): Promise<Record<string, number>>
  pendingWorkspaces(limit: number): Promise<string[]>
  resume(workspaceId: string, timestamp: string): Promise<void>
}

export interface LifecycleDependencies {
  impact(workspaceId: string, target: LifecycleImpact['target']): Promise<LifecycleImpact['blockers']>
}
