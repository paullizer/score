export type SavedReviewView = 'resume' | 'target'

export function savedReviewView(params: URLSearchParams): SavedReviewView | null {
  const views = params.getAll('view')
  const results = params.getAll('result')
  return results.length === 1 && Boolean(results[0]) && views.length === 1
    && (views[0] === 'resume' || views[0] === 'target') ? views[0] : null
}

function identity(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..'
    || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error(`A valid saved ${name} identity is required for review links.`)
  }
  return encodeURIComponent(value)
}

export function savedReviewPath({
  workspaceId, runId, comparisonId, dataKind, view,
}: {
  workspaceId?: string
  runId: string
  comparisonId: string
  dataKind: 'real' | 'sample'
  view?: SavedReviewView
}): string {
  if (dataKind !== 'real' && dataKind !== 'sample') throw new Error('A real or sample data mode is required for saved review links.')
  if (dataKind === 'real' && workspaceId === undefined) throw new Error('A workspace is required for real saved review links.')
  if (view !== undefined && view !== 'resume' && view !== 'target') throw new Error('The saved source view must be resume or target.')
  const prefix = workspaceId === undefined ? '' : `/workspaces/${identity(workspaceId, 'workspace')}`
  identity(comparisonId, 'comparison')
  const params = new URLSearchParams({ data: dataKind === 'sample' ? 'samples' : 'real', result: comparisonId })
  if (view) params.set('view', view)
  return `${prefix}/analyses/${identity(runId, 'analysis')}?${params}`
}
