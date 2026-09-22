import type { WorkspaceCount, WorkspaceCounts } from '../domain/workspace-summary'
import { CloudApiError, cloudJsonRequest } from './cloudWorkspace'

function isCount(value: unknown): value is WorkspaceCount {
  if (!value || typeof value !== 'object' || !('status' in value)) return false
  if (value.status === 'ready') return 'count' in value && typeof value.count === 'number' && Number.isSafeInteger(value.count) && value.count >= 0
  return value.status === 'unavailable' && 'message' in value && typeof value.message === 'string' && value.message.trim().length > 0
}

export async function fetchWorkspaceCounts(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceCounts> {
  const value: unknown = await cloudJsonRequest(`/workspaces/${encodeURIComponent(workspaceId)}/summary`, { signal })
  if (!value || typeof value !== 'object' || !('workspaceId' in value) || value.workspaceId !== workspaceId ||
    !('jobs' in value) || !isCount(value.jobs) || !('resumes' in value) || !isCount(value.resumes) ||
    !('analyses' in value) || !isCount(value.analyses)) {
    throw new CloudApiError('unavailable', 'The service returned invalid workspace counts. Open the workspace to inspect its saved work, or retry the counts.', 502)
  }
  return { workspaceId, jobs: value.jobs, resumes: value.resumes, analyses: value.analyses }
}
