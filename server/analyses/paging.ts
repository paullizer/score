import { z } from 'zod'
import { invalidRequest } from '../errors'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { isAnalysisId } from './validation'

const tokenSchema = z.strictObject({
  version: z.literal(1), workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  kind: z.enum(['targets', 'runs', 'comparisons']),
  runId: z.string().refine(value => isAnalysisId(value, 'run')).optional(),
  cursor: z.string().min(1).max(12 * 1024),
})
type Scope = Pick<z.infer<typeof tokenSchema>, 'workspaceId' | 'kind' | 'runId'>

export function validateAnalysisPage(limit = 50, continuationToken?: string): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidRequest('limit must be an integer between 1 and 100.')
  if (continuationToken !== undefined && (typeof continuationToken !== 'string' || !continuationToken ||
    continuationToken.length > 16 * 1024 || !/^[A-Za-z0-9_-]+$/.test(continuationToken))) {
    throw invalidRequest('continuationToken must be one valid analysis page token.')
  }
}
export function analysisPageToken(scope: Scope, cursor: string | undefined): string | undefined {
  if (!cursor) return undefined
  return Buffer.from(JSON.stringify(tokenSchema.parse({ version: 1, ...scope, cursor }))).toString('base64url')
}
export function analysisPageCursor(scope: Scope, token?: string): string | undefined {
  if (token === undefined) return undefined
  validateAnalysisPage(50, token)
  try {
    const value = tokenSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')))
    if (value.workspaceId !== scope.workspaceId || value.kind !== scope.kind || value.runId !== scope.runId) throw new Error('scope')
    return value.cursor
  } catch { throw invalidRequest('This analysis page token is invalid or belongs to another list.') }
}
