import { z } from 'zod'
import {
  ANALYSIS_QC_DIAGNOSTICS_VERSION, ANALYSIS_QC_DIAGNOSTIC_LIMITS, criterionQcDiagnosticSchema,
  analysisQcDiagnosticsReferenceSchema,
  type AcceptedAssessmentQcDiagnostics, type AnalysisQcDiagnosticsContext, type AnalysisQcDiagnosticsReference,
  type AnalysisQcDiagnosticsSidecar, type CriterionQcDiagnosticContext,
} from '../../src/domain/analysis-qc-diagnostics'
import {
  PINNED_ASSESSMENT_SCHEMA_VERSION, promptExecutionProvenanceSchema, promptHashSchema,
} from '../../src/domain/prompt-versions'
import type { RealAnalysisComparisonRecord, RealAnalysisResult, RealAnalysisRunRecord } from '../../src/domain/real-analyses'
import type { AnalysisBlobStore } from './store'
import { parseAnalysisJson, readAnalysisBlob, type AnalysisSnapshots } from './snapshots'
import {
  analysisHash, analysisModelProvenanceSchema, analysisQcDiagnosticsBlobName,
  assertAnalysis, assertAnalysisResultBinding, isAnalysisId, parseAnalysisEntity, parseAnalysisResult,
} from './validation'
import { WORKSPACE_ID_PATTERN } from '../ids'

const identity = z.strictObject({ snapshotId: z.string().refine(value => isAnalysisId(value, 'snapshot')), sha256: promptHashSchema })
const schema: z.ZodType<AnalysisQcDiagnosticsSidecar> = z.strictObject({
  schemaVersion: z.literal(1), version: z.literal(ANALYSIS_QC_DIAGNOSTICS_VERSION), dataKind: z.literal('real'),
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  runId: z.string().refine(value => isAnalysisId(value, 'run')),
  comparisonId: z.string().refine(value => isAnalysisId(value, 'comparison')),
  attemptId: z.uuid(), createdAt: z.iso.datetime(), resultSha256: promptHashSchema,
  assessmentSha256: promptHashSchema, modelAssessmentSha256: promptHashSchema, manifestSha256: promptHashSchema,
  resumeSnapshot: identity, targetSnapshot: identity,
  rubric: z.strictObject({ id: z.string().min(1).max(200), version: z.number().int().min(1), sha256: promptHashSchema }),
  assessmentProvenance: analysisModelProvenanceSchema.extend({
    prompt: promptExecutionProvenanceSchema, modelCallId: z.uuid(),
  }),
  // Rows the model reported inconsistently are not recorded, so a sidecar can cover only some criteria.
  criteria: z.array(criterionQcDiagnosticSchema).max(ANALYSIS_QC_DIAGNOSTIC_LIMITS.maxCriteria),
})
export interface AnalysisQcDiagnosticsReadContext extends AnalysisSnapshots {
  run: RealAnalysisRunRecord
  /** The exact original or historical/current projection selected through current-results.ts. */
  comparison: RealAnalysisComparisonRecord
  result: RealAnalysisResult
}

export function parseAnalysisQcDiagnostics(value: unknown): AnalysisQcDiagnosticsSidecar {
  const parsed = schema.parse(value)
  const provenance = parsed.assessmentProvenance
  assertAnalysis(new Set(parsed.criteria.map(row => row.criterionId)).size === parsed.criteria.length &&
    provenance.prompt.family === 'assessment' && provenance.schemaVersion === PINNED_ASSESSMENT_SCHEMA_VERSION &&
    provenance.prompt.outputSchemaVersion === provenance.schemaVersion &&
    provenance.prompt.revisionId === provenance.promptVersion && provenance.task === 'assessment' &&
    provenance.completedAt >= provenance.startedAt && provenance.completedAt <= parsed.createdAt,
  'Original-assessment QC diagnostic coverage or prompt/model provenance is invalid.')
  return parsed
}

export function assertAnalysisQcDiagnosticsBinding(
  value: AnalysisQcDiagnosticsSidecar, context: AnalysisQcDiagnosticsReadContext,
  reference?: AnalysisQcDiagnosticsReference,
): void {
  const sidecar = parseAnalysisQcDiagnostics(value)
  const { run, comparison, result, resumeSnapshot, targetSnapshot } = context
  parseAnalysisResult(result)
  assertAnalysisResultBinding(result, run, comparison, resumeSnapshot, targetSnapshot)
  const rubric = targetSnapshot.kind === 'job' ? targetSnapshot.rubric : targetSnapshot.version.rubric
  assertAnalysis(!result.provenance.correction && !comparison.resultRevision && comparison.result &&
    sidecar.workspaceId === run.workspaceId && sidecar.runId === run.id && sidecar.comparisonId === comparison.id &&
    sidecar.attemptId === comparison.attemptId && sidecar.resultSha256 === comparison.result.sha256 &&
    sidecar.assessmentSha256 === result.provenance.assessmentSha256 && sidecar.manifestSha256 === run.manifest.sha256 &&
    sidecar.createdAt === result.createdAt &&
    analysisHash(sidecar.resumeSnapshot) === analysisHash(result.provenance.resumeSnapshot) &&
    analysisHash(sidecar.targetSnapshot) === analysisHash(result.provenance.targetSnapshot) &&
    analysisHash(sidecar.assessmentProvenance) === analysisHash(result.provenance.assessment) &&
    sidecar.rubric.id === rubric.id && sidecar.rubric.version === rubric.version && sidecar.rubric.sha256 === analysisHash(rubric) &&
    sidecar.criteria.every(item => result.criteria.some(row => row.criterionId === item.criterionId)),
  'QC diagnostics are not bound to this exact original result, assessment, frozen rubric/source, and producing model call.')
  for (const row of result.criteria) {
    const diagnostic = sidecar.criteria.find(item => item.criterionId === row.criterionId)
    if (!diagnostic) continue
    assertAnalysis(diagnostic.assessedScore === row.score && diagnostic.assessedEvidenceStatus === row.evidenceStatus ||
      diagnostic.assessedScore === null && diagnostic.assessedEvidenceStatus === 'not-assessed' &&
      row.score === 0 && row.evidenceStatus === 'missing' && sidecar.modelAssessmentSha256 !== sidecar.assessmentSha256,
    'QC confidence targets a foreign criterion or a rating not produced by the accepted assessment.')
  }
  if (reference) {
    analysisQcDiagnosticsReferenceSchema.parse(reference)
    assertAnalysis(reference.resultSha256 === sidecar.resultSha256 && reference.assessmentSha256 === sidecar.assessmentSha256 &&
      reference.attemptId === sidecar.attemptId && reference.modelCallId === sidecar.assessmentProvenance.modelCallId &&
      reference.blob.blobName === analysisQcDiagnosticsBlobName(sidecar.workspaceId, sidecar.runId, sidecar.comparisonId, sidecar.attemptId),
    'QC diagnostic reference does not identify the exact original result and model call.')
  }
}

export function createAnalysisQcDiagnosticsSidecar(
  context: AnalysisQcDiagnosticsReadContext, captured: AcceptedAssessmentQcDiagnostics,
): AnalysisQcDiagnosticsSidecar {
  const { result, comparison, targetSnapshot } = context
  const rubric = targetSnapshot.kind === 'job' ? targetSnapshot.rubric : targetSnapshot.version.rubric
  assertAnalysis(comparison.result && result.provenance.assessment.prompt &&
    result.provenance.assessment.modelCallId === captured.modelCallId, 'QC diagnostics must come from the final accepted producing call.')
  const value = parseAnalysisQcDiagnostics({
    schemaVersion: 1, version: ANALYSIS_QC_DIAGNOSTICS_VERSION, dataKind: 'real',
    workspaceId: result.workspaceId, runId: result.runId, comparisonId: result.comparisonId,
    attemptId: result.provenance.attemptId, createdAt: result.createdAt,
    resultSha256: comparison.result.sha256, assessmentSha256: result.provenance.assessmentSha256,
    modelAssessmentSha256: captured.modelAssessmentSha256, manifestSha256: result.provenance.manifestSha256,
    resumeSnapshot: result.provenance.resumeSnapshot, targetSnapshot: result.provenance.targetSnapshot,
    rubric: { id: rubric.id, version: rubric.version, sha256: analysisHash(rubric) },
    assessmentProvenance: result.provenance.assessment, criteria: captured.criteria,
  })
  assertAnalysisQcDiagnosticsBinding(value, context)
  return value
}

/** Read only. No model calls, current-prompt lookup, rehash/backfill, or inference for historical results. */
export async function readAnalysisQcDiagnostics(
  blobs: Pick<AnalysisBlobStore, 'read'>, context: AnalysisQcDiagnosticsReadContext, signal?: AbortSignal,
): Promise<AnalysisQcDiagnosticsContext> {
  const { comparison, result, run } = context
  signal?.throwIfAborted()
  parseAnalysisEntity(run)
  parseAnalysisEntity(comparison)
  parseAnalysisResult(result)
  assertAnalysis(comparison.status === 'complete' && comparison.result, 'QC diagnostics require a selected completed result.')
  assertAnalysisResultBinding(result, run, comparison, context.resumeSnapshot, context.targetSnapshot)
  const reference = comparison.qcDiagnostics
  if (!reference || reference.resultSha256 !== comparison.result.sha256) {
    if (reference) assertAnalysis(comparison.resultRevision &&
      reference.resultSha256 === comparison.resultRevision.originalResultSha256,
    'A mismatched QC reference is not an original-result reference on a corrected projection.')
    return {
      status: 'not-recorded', label: 'Not recorded', resultSha256: comparison.result.sha256,
      criteria: result.criteria.map(row => ({
        criterionId: row.criterionId, status: 'not-recorded', reason: reference ? 'different-result' : 'not-captured',
      })),
    }
  }
  analysisQcDiagnosticsReferenceSchema.parse(reference)
  assertAnalysis(reference.attemptId === result.provenance.attemptId &&
    reference.modelCallId === result.provenance.assessment.modelCallId &&
    reference.assessmentSha256 === result.provenance.assessmentSha256 &&
    reference.blob.blobName === analysisQcDiagnosticsBlobName(run.workspaceId, run.id, comparison.id, reference.attemptId),
  'QC reference must identify this exact selected result before any private artifact is read.')
  const sidecar = parseAnalysisQcDiagnostics(parseAnalysisJson(await readAnalysisBlob(
    blobs, reference.blob, run.workspaceId, run.id, signal,
  )))
  assertAnalysisQcDiagnosticsBinding(sidecar, context, reference)
  const criteria: CriterionQcDiagnosticContext[] = result.criteria.map(row => {
    const diagnostic = sidecar.criteria.find(item => item.criterionId === row.criterionId)
    if (!diagnostic) return { criterionId: row.criterionId, status: 'not-recorded', reason: 'invalid-diagnostic' }
    if (diagnostic.assessedScore !== row.score) return { criterionId: row.criterionId, status: 'not-recorded', reason: 'rating-normalized' }
    return { criterionId: row.criterionId, status: row.score === null ? 'unscored' : 'recorded', diagnostic }
  })
  return { status: 'recorded', resultSha256: comparison.result.sha256, sidecar, criteria }
}
