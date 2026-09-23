export type SavedReviewView = 'resume' | 'target'

/** Legacy `data=real|samples` parameters from older links and exported reports are ignored. */
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
  workspaceId, runId, comparisonId, view,
}: {
  workspaceId: string
  runId: string
  comparisonId: string
  view?: SavedReviewView
}): string {
  if (workspaceId === undefined) throw new Error('A workspace is required for saved review links.')
  if (view !== undefined && view !== 'resume' && view !== 'target') throw new Error('The saved source view must be resume or target.')
  const prefix = `/workspaces/${identity(workspaceId, 'workspace')}`
  identity(comparisonId, 'comparison')
  const params = new URLSearchParams({ result: comparisonId })
  if (view) params.set('view', view)
  return `${prefix}/analyses/${identity(runId, 'analysis')}?${params}`
}
