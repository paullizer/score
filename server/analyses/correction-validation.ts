import { z } from 'zod'
import {
  ANALYSIS_CORRECTION_POLICY_VERSION, type AnalysisCorrectionHistoryEntry, type AnalysisCorrectionInput,
  type AnalysisCorrectionProposal, type RealAnalysisCorrectionRecord,
} from '../../src/domain/analysis-corrections'
import { isPersonalTraitCriterion } from '../../src/domain/analysis-evidence-policy'
import type {
  FrozenRealAnalysisTargetSnapshot, RealAnalysisAssessmentOutput, RealAnalysisResult, RealCriterionResult,
} from '../../src/domain/real-analyses'
import { WORKSPACE_ID_PATTERN } from '../ids'
import {
  analysisAssessmentOutputSchema, analysisCorrectionCriterionIdsSchema, analysisCorrectionHistoryBlobName,
  analysisCorrectionHistoryReferenceSchema, analysisCorrectionProvenanceSchema, analysisGroundingReviewSchema,
  analysisHash, analysisJsonReferenceSchema, analysisProcessingErrorSchema, analysisResultRevisionSchema,
  analysisResultSummarySchema, analysisSnapshotIdentitySchema, assertAnalysis, calculateAnalysisSummary,
  isAnalysisId, MAX_ANALYSIS_JSON_BYTES, parseAnalysisAssessmentOutput,
} from './validation'
import { describeAnalysisSummary } from './deterministic'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.iso.datetime({ precision: 3 })
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0)
const identity = {
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  runId: z.string().refine(value => isAnalysisId(value, 'run')),
  comparisonId: z.string().refine(value => isAnalysisId(value, 'comparison')),
  createdAt: timestamp, requestId: z.string().uuid(),
}
export const analysisCorrectionInputSchema = z.strictObject({
  resultSha256: hash, criterionIds: analysisCorrectionCriterionIdsSchema, reason: text(1000),
})
const proposalSchema = z.strictObject({
  ...identity, requestFingerprint: hash, manifestSha256: hash, expectedEtag: text(1024),
  originalResultSha256: hash, baseResult: analysisJsonReferenceSchema, baseAttemptId: z.string().uuid(),
  baseRevision: analysisResultRevisionSchema.optional(),
  resumeSnapshot: analysisSnapshotIdentitySchema, targetSnapshot: analysisSnapshotIdentitySchema,
  provenance: analysisCorrectionProvenanceSchema, assessment: analysisAssessmentOutputSchema,
  summary: analysisResultSummarySchema,
})
const historySchema = z.strictObject({
  ...identity, id: z.string().uuid(), attemptId: z.string().uuid().optional(),
  outcome: z.enum(['ready', 'failed', 'cancelled']), proposal: analysisJsonReferenceSchema,
  review: analysisGroundingReviewSchema.optional(), result: analysisJsonReferenceSchema.optional(),
  error: analysisProcessingErrorSchema.optional(), previous: analysisCorrectionHistoryReferenceSchema.optional(),
})

export function analysisCorrectionFingerprint(
  workspaceId: string, runId: string, comparisonId: string, input: AnalysisCorrectionInput, actor: string,
): string {
  return analysisHash({
    workspaceId, runId, comparisonId, actor, policyVersion: ANALYSIS_CORRECTION_POLICY_VERSION,
    input: { ...input, criterionIds: [...input.criterionIds].sort() },
  })
}

export function parseAnalysisCorrectionProposal(value: unknown): AnalysisCorrectionProposal {
  assertAnalysis(Buffer.byteLength(JSON.stringify(value) ?? '') <= MAX_ANALYSIS_JSON_BYTES, 'Correction proposal exceeds its limit.')
  const parsed = proposalSchema.parse(value)
  const proposal: AnalysisCorrectionProposal = { ...parsed, assessment: parseAnalysisAssessmentOutput(parsed.assessment) }
  assertAnalysis(proposal.requestId === proposal.provenance.requestId &&
    proposal.createdAt === proposal.provenance.requestedAt &&
    proposal.originalResultSha256 === proposal.provenance.originalResultSha256 &&
    proposal.baseResult.sha256 === proposal.provenance.baseResultSha256 &&
    proposal.requestFingerprint === analysisCorrectionFingerprint(proposal.workspaceId, proposal.runId, proposal.comparisonId, {
      resultSha256: proposal.baseResult.sha256, criterionIds: proposal.provenance.criterionIds, reason: proposal.provenance.reason,
    }, proposal.provenance.requestedBy), 'Correction proposal has inconsistent request bindings.')
  assertAnalysis(analysisHash(proposal.summary) === analysisHash(calculateAnalysisSummary(
    proposal.assessment.criteria, proposal.assessment.qualifications, proposal.assessment.limitations,
  )), 'Correction preview was not calculated from the exact proposed assessment.')
  return proposal
}

export function assertAnalysisCorrectionProposalBinding(
  proposal: AnalysisCorrectionProposal, record: RealAnalysisCorrectionRecord,
): void {
  assertAnalysis(proposal.workspaceId === record.workspaceId && proposal.runId === record.runId &&
    proposal.comparisonId === record.comparisonId && proposal.requestId === record.requestId &&
    proposal.requestFingerprint === record.requestFingerprint && proposal.manifestSha256 === record.manifestSha256 &&
    proposal.originalResultSha256 === record.originalResult.sha256 && proposal.createdAt === record.requestedAt &&
    proposal.baseAttemptId === record.baseAttemptId && analysisHash(proposal.baseResult) === analysisHash(record.baseResult) &&
    analysisHash(proposal.baseRevision ?? null) === analysisHash(record.baseRevision ?? null) &&
    analysisHash(proposal.resumeSnapshot) === analysisHash(record.resumeSnapshot) &&
    analysisHash(proposal.targetSnapshot) === analysisHash(record.targetSnapshot) &&
    proposal.provenance.requestedBy === record.requestedBy && proposal.provenance.reason === record.reason &&
    proposal.provenance.policyVersion === record.policyVersion &&
    analysisHash(proposal.provenance.criterionIds) === analysisHash(record.criterionIds),
  'Correction proposal does not match the accepted work.')
}

export function parseAnalysisCorrectionHistoryEntry(value: unknown): AnalysisCorrectionHistoryEntry {
  assertAnalysis(Buffer.byteLength(JSON.stringify(value) ?? '') <= MAX_ANALYSIS_JSON_BYTES, 'Correction history exceeds its limit.')
  const entry = historySchema.parse(value)
  assertAnalysis(entry.outcome === 'ready' ? Boolean(entry.result && entry.review?.outcome === 'supported' &&
    entry.review.issues.length === 0 && !entry.error && entry.attemptId) : !entry.result,
  'Only supported, completed corrections may publish a result in history.')
  if (entry.outcome === 'failed') assertAnalysis(entry.error, 'Failed correction history must retain its safe error.')
  if (entry.previous) {
    const parts = entry.previous.blob.blobName.split('/')
    assertAnalysis(entry.previous.blob.blobName === analysisCorrectionHistoryBlobName(
      entry.workspaceId, entry.runId, entry.comparisonId, parts[4], entry.previous.id,
    ) && entry.previous.createdAt <= entry.createdAt && entry.previous.id !== entry.id,
    'Correction history has an invalid predecessor.')
  }
  return entry
}

export function correctionBlockedReason(
  result: RealAnalysisAssessmentOutput, target: FrozenRealAnalysisTargetSnapshot, criterion: RealCriterionResult,
): string | null {
  if (criterion.evidenceStatus !== 'not-assessed' || criterion.weight <= 0) return 'Only unassessed, positively weighted criteria can be proposed.'
  const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
  const definition = rubric.criteria.find(row => row.id === criterion.criterionId)
  assertAnalysis(definition, 'Correction criterion is absent from its frozen rubric.')
  if (isPersonalTraitCriterion(definition.label, definition.description)) return 'Personal-trait safeguards cannot be replaced with a zero score.'
  if (['source-quality', 'context-limit'].includes(criterion.limitation.code) ||
    result.limitations.some(item => ['source-quality', 'context-limit'].includes(item.code) &&
      (!item.criterionId && !item.qualificationId || item.criterionId === criterion.criterionId))) {
    return 'A source-quality or processing limitation must be resolved; missing evidence cannot be assumed.'
  }
  return null
}

export function buildEvidenceCorrectionAssessment(
  base: RealAnalysisAssessmentOutput, target: FrozenRealAnalysisTargetSnapshot, criterionIds: string[],
): RealAnalysisAssessmentOutput {
  analysisCorrectionCriterionIdsSchema.parse(criterionIds)
  const selected = new Set(criterionIds)
  assertAnalysis(criterionIds.every(id => base.criteria.some(row => row.criterionId === id &&
    correctionBlockedReason(base, target, row) === null)), 'Correction contains an ineligible criterion.')
  const criteria = base.criteria.map((row): RealCriterionResult => selected.has(row.criterionId) ? {
    criterionId: row.criterionId, weight: row.weight, evidenceStatus: 'missing', score: 0, citations: [],
    requirementCitations: structuredClone(row.requirementCitations),
    rationale: 'No supporting evidence for this criterion was identified in the successfully reviewed source. Missing evidence is scored 0/5; this does not establish a lack of ability or experience.',
  } : structuredClone(row))
  const qualifications = structuredClone(base.qualifications)
  const limitations = base.limitations.filter(item => !item.criterionId || !selected.has(item.criterionId) || item.qualificationId)
    .map(item => structuredClone(item))
  return parseAnalysisAssessmentOutput({
    criteria, qualifications, limitations,
    summary: describeAnalysisSummary(calculateAnalysisSummary(criteria, qualifications, limitations), qualifications.length),
  })
}

export function assertEvidenceCorrectionAssessment(
  proposal: AnalysisCorrectionProposal, base: RealAnalysisResult, target: FrozenRealAnalysisTargetSnapshot,
): void {
  assertAnalysis(proposal.provenance.baseAssessmentSha256 === base.provenance.assessmentSha256 &&
    analysisHash(proposal.assessment) === analysisHash(buildEvidenceCorrectionAssessment(
      base, target, proposal.provenance.criterionIds,
    )), 'Correction changed an unrelated score, weight, qualification, evidence citation, or limitation.')
}
