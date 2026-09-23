const emptyWorkspace = () => ({ jobs: [], rubrics: [], documents: [], lifecycle: { entities: {} } })
const unused = () => { throw new Error('Unexpected mutation in a read-only frontend fixture.') }
const noop = () => {}
const acknowledged = async () => {}

export function frontendWorkspaceContext(value = {}, { resumes = [], analyses = [] } = {}) {
  const workspace = value.workspace ?? emptyWorkspace()
  const id = value.cloud?.currentWorkspaceId ?? 'workspace-one'
  const result = {
    notice: null, clearNotice: noop, notify: noop,
    cancelJob: unused, retryJob: unused, saveRubric: unused,
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
    cloud: {
      user: { id: 'reviewer', tenantId: 'tenant', name: 'Fixture reviewer', email: 'reviewer@example.test' },
      currentWorkspaceId: id, workspaces: [{ id, name: 'Fixture workspace', role: 'owner', etag: '"workspace"' }], canCreateWorkspaces: false,
      refreshWorkspaces: acknowledged, signOut: acknowledged,
      switchWorkspace: unused, createWorkspace: unused, renameWorkspace: unused,
      getWorkspaceLifecycleImpact: unused, changeWorkspaceLifecycle: unused, leaveUnavailableWorkspace: unused,
      ...value.cloud,
      realJobs: {
        phase: 'ready', features: null, summaries: [], error: null, detail: () => ({ state: 'idle' }), source: () => undefined,
        ensureDetail: acknowledged, refresh: acknowledged, importPdf: unused, importMarkdown: unused,
        importFile: unused, importUrl: unused, originalUrl: unused, ...value.cloud?.realJobs,
      },
    },
  }
  return result
}