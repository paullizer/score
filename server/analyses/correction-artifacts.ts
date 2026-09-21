import type { AnalysisCorrectionHistoryEntry, AnalysisCorrectionHistoryReference } from '../../src/domain/analysis-corrections'
import { parseAnalysisCorrectionHistoryEntry } from './correction-validation'
import { parseAnalysisJson, readAnalysisBlob } from './snapshots'
import type { AnalysisBlobStore } from './store'
import { analysisCorrectionHistoryBlobName, assertAnalysis } from './validation'

export async function readAnalysisCorrectionHistoryEntry(
  blobs: Pick<AnalysisBlobStore, 'read'>, workspaceId: string, runId: string, comparisonId: string,
  reference: AnalysisCorrectionHistoryReference, signal?: AbortSignal,
): Promise<AnalysisCorrectionHistoryEntry> {
  const parts = reference.blob.blobName.split('/')
  assertAnalysis(reference.blob.blobName === analysisCorrectionHistoryBlobName(workspaceId, runId, comparisonId, parts[4], reference.id),
    'Correction history belongs to another comparison.')
  const entry = parseAnalysisCorrectionHistoryEntry(parseAnalysisJson(await readAnalysisBlob(blobs, reference.blob, workspaceId, runId, signal)))
  assertAnalysis(entry.id === reference.id && entry.createdAt === reference.createdAt && entry.workspaceId === workspaceId &&
    entry.runId === runId && entry.comparisonId === comparisonId && entry.requestId === parts[4],
  'Correction history ownership or checkpoint binding mismatch.')
  return entry
}
