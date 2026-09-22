export type WorkspaceCount =
  | { status: 'ready'; count: number }
  | { status: 'unavailable'; message: string }

export type WorkspaceCounts = {
  workspaceId: string
  jobs: WorkspaceCount
  resumes: WorkspaceCount
  analyses: WorkspaceCount
}
