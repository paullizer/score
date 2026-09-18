import {
  GRADE_LADDER_LIMITS,
  type AddGradeSourceUrlInput,
  type ApproveGradeInput,
  type ConfirmGradeSourcesInput,
  type CreateGradeLadderInput,
  type EditGradeDraftInput,
  type GradeActionInput,
  type GradeLadderDetail,
  type GradeLaddersPage,
  type GradeLadderSummary,
  type GradeMutationResponse,
  type GradeProcessingFeatures,
  type GradeRubricVersionRecord,
  type GradeSourceSetRecord,
  type GradeVersionsPage,
  type ReferenceDocument,
  type UpdateGradeLadderInput,
  type UpdateGradeSourceInput,
} from '../domain/real-grades'
import { cloudJsonRequest } from './cloudWorkspace'

// Real job rubric IDs survive edits; selecting a seed requires its saved version as well.
export type GradeLadderCreationRequest = CreateGradeLadderInput

function base(workspaceId: string, ladderId?: string): string {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/grade-ladders`
  return ladderId ? `${path}/${encodeURIComponent(ladderId)}` : path
}

function concurrency(etag: string): Record<string, string> {
  if (!etag) throw new Error('Reload the current server version before changing this ladder.')
  return { 'If-Match': etag }
}

function idempotency(key: string): Record<string, string> {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(key)) {
    throw new Error('This operation needs a stable UUID idempotency key.')
  }
  return { 'Idempotency-Key': key }
}

async function mutate(path: string, method: string, body: unknown, headers: Record<string, string> = {}): Promise<GradeLadderDetail> {
  const result = await cloudJsonRequest<GradeMutationResponse>(path, { method, headers, body: JSON.stringify(body) })
  if (!result.ladder?.ladder || !Array.isArray(result.ladder.levels)) throw new Error('The grade service returned an invalid mutation response. Reload before retrying.')
  return result.ladder
}

export async function fetchGradeProcessingFeatures(signal?: AbortSignal): Promise<GradeProcessingFeatures> {
  const result = await cloudJsonRequest<Partial<GradeProcessingFeatures>>('/features', { method: 'GET', signal })
  return { realGradeLadders: result.realGradeLadders === true, gradeLimits: result.gradeLimits ?? GRADE_LADDER_LIMITS }
}

async function collectPages<T>(path: string, field: 'ladders' | 'versions', signal?: AbortSignal): Promise<T[]> {
  const items: T[] = []
  const seen = new Set<string>()
  let continuationToken: string | undefined
  do {
    const query = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : ''
    const page = await cloudJsonRequest<GradeLaddersPage | GradeVersionsPage>(`${path}${query}`, { method: 'GET', signal })
    const values = field === 'ladders' && 'ladders' in page ? page.ladders : field === 'versions' && 'versions' in page ? page.versions : null
    if (!Array.isArray(values)) throw new Error(`The grade service returned an invalid ${field} page.`)
    items.push(...values as T[])
    continuationToken = page.continuationToken
    if (continuationToken) {
      if (seen.has(continuationToken)) throw new Error('The grade service returned a repeated continuation token.')
      seen.add(continuationToken)
    }
  } while (continuationToken)
  return items
}

export function listAllGradeLadders(workspaceId: string, signal?: AbortSignal): Promise<GradeLadderSummary[]> {
  return collectPages(base(workspaceId), 'ladders', signal)
}

export function getGradeLadder(workspaceId: string, ladderId: string, signal?: AbortSignal): Promise<GradeLadderDetail> {
  return cloudJsonRequest(base(workspaceId, ladderId), { method: 'GET', signal })
}

export function createGradeLadder(workspaceId: string, input: GradeLadderCreationRequest, key: string): Promise<GradeLadderDetail> {
  return mutate(base(workspaceId), 'POST', input, idempotency(key))
}

export function updateGradeLadder(workspaceId: string, ladderId: string, input: UpdateGradeLadderInput, etag: string): Promise<GradeLadderDetail> {
  return mutate(base(workspaceId, ladderId), 'PATCH', input, concurrency(etag))
}

export function discoverGradeSources(workspaceId: string, ladderId: string, etag: string, key: string): Promise<GradeLadderDetail> {
  return mutate(`${base(workspaceId, ladderId)}/discover`, 'POST', {}, { ...concurrency(etag), ...idempotency(key) })
}

export async function uploadGradeSourcePdf(workspaceId: string, ladderId: string, file: File, key: string, selectedPages: number[] = []): Promise<GradeLadderDetail> {
  if (!file.size || file.size > GRADE_LADDER_LIMITS.maxPdfBytes) throw new Error('Choose a nonempty PDF no larger than 20 MiB.')
  const headers = {
    ...idempotency(key),
    'Content-Type': 'application/pdf',
    'X-File-Name': encodeURIComponent(file.name),
    ...(selectedPages.length ? { 'X-Source-Pages': selectedPages.join(',') } : {}),
  }
  const bytes = await file.arrayBuffer()
  const result = await cloudJsonRequest<GradeMutationResponse>(`${base(workspaceId, ladderId)}/sources/pdf`, { method: 'POST', headers, body: bytes })
  return result.ladder
}

export function addGradeSourceUrl(workspaceId: string, ladderId: string, input: AddGradeSourceUrlInput, key: string): Promise<GradeLadderDetail> {
  return mutate(`${base(workspaceId, ladderId)}/sources/url`, 'POST', input, idempotency(key))
}

export function updateGradeSource(workspaceId: string, ladderId: string, sourceId: string, input: UpdateGradeSourceInput, etag: string): Promise<GradeLadderDetail> {
  return mutate(`${base(workspaceId, ladderId)}/sources/${encodeURIComponent(sourceId)}`, 'PATCH', input, concurrency(etag))
}

export function confirmGradeSources(workspaceId: string, ladderId: string, input: ConfirmGradeSourcesInput, etag: string, key: string): Promise<GradeLadderDetail> {
  return mutate(`${base(workspaceId, ladderId)}/source-set`, 'POST', input, { ...concurrency(etag), ...idempotency(key) })
}

export function generateGradeLadder(workspaceId: string, ladderId: string, etag: string, key: string): Promise<GradeLadderDetail> {
  return mutate(`${base(workspaceId, ladderId)}/generate`, 'POST', {}, { ...concurrency(etag), ...idempotency(key) })
}

export function retryGradeWork(workspaceId: string, ladderId: string, input: GradeActionInput, etag: string): Promise<GradeLadderDetail> {
  return mutate(`${base(workspaceId, ladderId)}/retry`, 'POST', input, concurrency(etag))
}

export function cancelGradeWork(workspaceId: string, ladderId: string, input: GradeActionInput, etag: string): Promise<GradeLadderDetail> {
  return mutate(`${base(workspaceId, ladderId)}/cancel`, 'POST', input, concurrency(etag))
}

export function saveGradeDraft(workspaceId: string, ladderId: string, grade: number, input: EditGradeDraftInput, headEtag: string): Promise<GradeLadderDetail> {
  const rubric = { ...input.rubric }
  delete rubric.provenance
  return mutate(`${base(workspaceId, ladderId)}/grades/${grade}/draft`, 'PUT', { rubric, qualifications: input.qualifications }, concurrency(headEtag))
}

export function approveGrade(workspaceId: string, ladderId: string, grade: number, input: ApproveGradeInput, headEtag: string): Promise<GradeLadderDetail> {
  return mutate(`${base(workspaceId, ladderId)}/grades/${grade}/approve`, 'POST', input, concurrency(headEtag))
}

export function listAllGradeVersions(workspaceId: string, ladderId: string, grade: number, signal?: AbortSignal): Promise<GradeRubricVersionRecord[]> {
  return collectPages(`${base(workspaceId, ladderId)}/grades/${grade}/versions`, 'versions', signal)
}

export function getGradeSourceSet(workspaceId: string, ladderId: string, sourceSetId: string, signal?: AbortSignal): Promise<GradeSourceSetRecord> {
  return cloudJsonRequest(`${base(workspaceId, ladderId)}/source-sets/${encodeURIComponent(sourceSetId)}`, { method: 'GET', signal })
}

function sourcePath(workspaceId: string, ladderId: string, sourceId: string, kind: 'document' | 'original', sourceSetId?: string): string {
  return `${base(workspaceId, ladderId)}/sources/${encodeURIComponent(sourceId)}/${kind}${sourceSetId ? `?sourceSetId=${encodeURIComponent(sourceSetId)}` : ''}`
}

export function getGradeSourceDocument(workspaceId: string, ladderId: string, sourceId: string, sourceSetId?: string, signal?: AbortSignal): Promise<ReferenceDocument> {
  return cloudJsonRequest(sourcePath(workspaceId, ladderId, sourceId, 'document', sourceSetId), { method: 'GET', signal })
}

export function gradeSourceOriginalUrl(workspaceId: string, ladderId: string, sourceId: string, sourceSetId?: string): string {
  return `/api${sourcePath(workspaceId, ladderId, sourceId, 'original', sourceSetId)}`
}
