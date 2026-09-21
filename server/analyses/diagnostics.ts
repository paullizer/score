import type { RealAnalysisDiagnosticsPage } from '../../src/domain/analysis-diagnostics'
import type { RealAnalysisComparisonRecord, RealAnalysisRunRecord } from '../../src/domain/real-analyses'
import { invalidRequest } from '../errors'
import { analysisPageCursor, analysisPageToken } from './paging'
import { parseAnalysisJson, readAnalysisBlob, readAnalysisSnapshots } from './snapshots'
import type { AnalysisBlobStore } from './store'
import {
  analysisFailureDiagnosticReferenceSchema, assertAnalysis, assertAnalysisFailureDiagnosticBinding,
  assertAnalysisFailureDiagnosticReference, parseAnalysisFailureDiagnostic,
} from './validation'

export async function readAnalysisFailureDiagnostics(
  blobs: AnalysisBlobStore, run: RealAnalysisRunRecord, comparison: RealAnalysisComparisonRecord, continuationToken?: string,
  signal?: AbortSignal,
): Promise<RealAnalysisDiagnosticsPage> {
  signal?.throwIfAborted()
  const scope = { workspaceId: run.workspaceId, runId: run.id, comparisonId: comparison.id, kind: 'diagnostics' as const }
  const cursor = analysisPageCursor(scope, continuationToken)
  let reference = comparison.failureDiagnostic
  if (cursor) {
    if (!reference) throw invalidRequest('This comparison has no recorded diagnostic history.')
    try {
      reference = analysisFailureDiagnosticReferenceSchema.parse(JSON.parse(cursor))
      assertAnalysisFailureDiagnosticReference(reference, run.workspaceId, run.id, comparison.id)
    } catch {
      throw invalidRequest('The diagnostic history cursor is invalid or belongs to another comparison.')
    }
  }
  if (!reference) return { attempts: [] }
  assertAnalysisFailureDiagnosticReference(reference, run.workspaceId, run.id, comparison.id)
  const diagnostic = parseAnalysisFailureDiagnostic(parseAnalysisJson(
    await readAnalysisBlob(blobs, reference.blob, run.workspaceId, run.id, signal),
  ))
  assertAnalysis(diagnostic.attemptId === reference.attemptId && diagnostic.createdAt === reference.createdAt,
    'Diagnostic history reference does not identify this attempt.')
  const snapshots = diagnostic.assessments.length ? await readAnalysisSnapshots(blobs, run, comparison, signal) : undefined
  assertAnalysisFailureDiagnosticBinding(diagnostic, run, comparison, snapshots)
  const next = diagnostic.previous ? analysisPageToken(scope, JSON.stringify(diagnostic.previous)) : undefined
  return { attempts: [diagnostic], ...(next ? { continuationToken: next } : {}) }
}
