import type { QcComparisonRef } from '../../src/domain/quality-control'
import type { RealAnalysisComparisonDetail } from '../../src/domain/real-analyses'
import { conflict, notFound } from '../errors'
import { loadAnalysisComparison, loadAnalysisRun } from '../analyses/lifecycle'
import { resolveAnalysisComparison, resolveAnalysisComparisonRevision } from '../analyses/current-results'
import { readAnalysisReferenceDocuments, readAnalysisResult, readAnalysisSnapshots } from '../analyses/snapshots'
import type { RealAnalysesDeps, StoredAnalysisControl } from '../analyses/store'
import { isAnalysisId } from '../analyses/validation'
import { qcValueHash } from './validation'

export function qcAnalysisControlWritable(value: StoredAnalysisControl | undefined): boolean {
  return !value || value.record.state === 'active' && (!value.record.operation || value.record.operation.status === 'complete')
}

export async function readQcEvidence(
  analyses: RealAnalysesDeps, workspaceId: string, runId: string, comparisonId: string, revision?: string,
) {
  if (!isAnalysisId(runId, 'run') || !isAnalysisId(comparisonId, 'comparison')) throw notFound('Select a saved real analysis comparison.')
  const [run, original, workspaceControl, runControl] = await Promise.all([
    loadAnalysisRun(analyses.store, workspaceId, runId),
    loadAnalysisComparison(analyses.store, workspaceId, runId, comparisonId),
    analyses.store.getControl(workspaceId), analyses.store.getControl(workspaceId, runId),
  ])
  if (!run || !original || run.record.lifecycle?.deletingAt || run.record.lifecycle?.deletedAt ||
    [workspaceControl, runControl].some(value => value && ['deleting', 'deleted'].includes(value.record.state))) {
    throw notFound('The saved comparison is unavailable or being removed.')
  }
  const selected = revision === undefined
    ? await resolveAnalysisComparison(analyses.store, run.record, original)
    : await resolveAnalysisComparisonRevision(analyses, run.record, original, revision)
  if (selected.record.status !== 'complete' || !selected.record.result) {
    throw conflict('QC requires one completed comparison. Other comparisons in the run need not be complete.')
  }
  const snapshots = await readAnalysisSnapshots(analyses.blobs, run.record, selected.record)
  const result = await readAnalysisResult(analyses.blobs, run.record, selected.record, snapshots)
  if (!result) throw notFound('This completed result is unavailable.')
  const references = snapshots.targetSnapshot.kind === 'grade'
    ? await readAnalysisReferenceDocuments(analyses.blobs, run.record, snapshots.targetSnapshot) : []
  const scope: QcComparisonRef = {
    runId, comparisonId, resultRevision: selected.record.resultRevision?.id ?? 'original',
    resultSha256: selected.record.result.sha256,
  }
  const analysis: RealAnalysisComparisonDetail = {
    comparison: selected.record, etag: selected.etag, ...snapshots, result,
  }
  return {
    scope, analysis, references, run: run.record, original: original.record,
    writable: !run.record.lifecycle?.archivedAt && [workspaceControl, runControl].every(qcAnalysisControlWritable) &&
      (!run.record.cancellation || Boolean(run.record.cancellation.completedAt)),
  }
}

export async function readExactQcEvidence(analyses: RealAnalysesDeps, workspaceId: string, scope: QcComparisonRef) {
  const value = await readQcEvidence(analyses, workspaceId, scope.runId, scope.comparisonId, scope.resultRevision)
  if (qcValueHash(value.scope) !== qcValueHash(scope)) throw conflict('The selected result hash does not match that exact saved revision.')
  return value
}
