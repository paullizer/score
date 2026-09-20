const emptyWorkspace = () => ({ schemaVersion: 1, jobs: [], resumes: [], rubrics: [], documents: [], runs: [] })
const unused = () => { throw new Error('Unexpected mutation in a read-only frontend fixture.') }
const noop = () => {}
const acknowledged = async () => {}

export function frontendWorkspaceContext(value = {}, { resumes = [], analyses = [] } = {}) {
  const workspace = value.workspace ?? emptyWorkspace()
  const result = {
    storageError: null, notice: null, clearNotice: noop, notify: noop,
    addJobs: unused, addResumes: unused, cancelJob: unused, retryJob: unused, saveRubric: unused,
    startAnalysis: unused, cancelRun: unused, retryRun: unused, resetDemo: unused, retrySave: noop,
    getLifecycleImpact: unused, changeLifecycle: unused, renameEntity: unused, lifecycleOperations: [],
    ...value,
    workspace: {
      ...workspace,
      lifecycle: {
        ...workspace.lifecycle,
        entities: {
          ...workspace.lifecycle?.entities,
          ...Object.fromEntries(resumes.map((item) => [`resume:${item.resume.id}`, item.lifecycle ?? {}])),
          ...Object.fromEntries(analyses.map((item) => [`analysis:${item.run.id}`, item.lifecycle ?? item.run.lifecycle ?? {}])),
        },
      },
    },
  }
  if (value.cloud) {
    const id = value.cloud.currentWorkspaceId ?? 'workspace-one'
    result.cloud = {
      user: { id: 'reviewer', tenantId: 'tenant', name: 'Fixture reviewer', email: 'reviewer@example.test' },
      currentWorkspaceId: id, workspaces: [{ id, name: 'Fixture workspace', role: 'owner', etag: '"workspace"' }],
      saveState: 'saved', saveError: null, conflict: null, syncingState: false,
      retrySave: noop, reloadFromServer: acknowledged, keepMineAndOverwrite: acknowledged,
      refreshWorkspaces: acknowledged, flushSave: acknowledged, signOut: acknowledged,
      switchWorkspace: unused, createWorkspace: unused, renameWorkspace: unused,
      getWorkspaceLifecycleImpact: unused, changeWorkspaceLifecycle: unused, leaveUnavailableWorkspace: unused,
      ...value.cloud,
      realJobs: {
        phase: 'ready', features: null, summaries: [], error: null, detail: () => ({ state: 'idle' }), source: () => undefined,
        ensureDetail: acknowledged, refresh: acknowledged, importPdf: unused, importMarkdown: unused,
        importFile: unused, importUrl: unused, originalUrl: unused, ...value.cloud.realJobs,
      },
    }
  }
  return result
}
