import { z } from 'zod'
import { processingSettingsSnapshotSchema } from '../../src/domain/admin-settings-schema'
import { preservesProcessingSettings } from '../jobs/policy'
import {
  ANALYSIS_CORRECTION_POLICY_VERSION, ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION, type AnalysisCorrectionHistoryEntry, type AnalysisCorrectionInput,
  type AnalysisCorrectionPolicyVersion, type AnalysisCorrectionProposal, type RealAnalysisCorrectionRecord,
} from '../../src/domain/analysis-corrections'
import { isPersonalTraitCriterion, missingEvidenceCriterion } from '../../src/domain/analysis-evidence-policy'
import type {
  FrozenRealAnalysisTargetSnapshot, RealAnalysisAssessmentOutput, RealAnalysisGroundingReview, RealAnalysisResult, RealCriterionResult,
} from '../../src/domain/real-analyses'
import { WORKSPACE_ID_PATTERN } from '../ids'
import {
  analysisAssessmentOutputSchema, analysisCorrectionCriterionIdsSchema, analysisCorrectionHistoryBlobName,
  analysisCorrectionHistoryReferenceSchema, analysisCorrectionPolicySchema, analysisCorrectionProvenanceSchema, analysisGroundingReviewSchema,
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
  policyVersion: analysisCorrectionPolicySchema.optional(),
  resultSha256: hash, criterionIds: analysisCorrectionCriterionIdsSchema, reason: text(1000),
})
const proposalSchema = z.strictObject({
  processingSettings: processingSettingsSnapshotSchema.optional(),
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
  const { policyVersion = ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION, ...request } = input
  return analysisHash({
    workspaceId, runId, comparisonId, actor, policyVersion,
    input: { ...request, criterionIds: [...request.criterionIds].sort() },
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
      policyVersion: proposal.provenance.policyVersion,
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
    preservesProcessingSettings(proposal.processingSettings, record.processingSettings) &&
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

export function assertCorrectionReviewBinding(
  review: RealAnalysisGroundingReview, proposal: AnalysisCorrectionProposal,
): void {
  analysisGroundingReviewSchema.parse(review)
  assertAnalysis(review.assessmentSha256 === analysisHash(proposal.assessment) &&
    review.resumeSnapshotSha256 === proposal.resumeSnapshot.sha256 &&
    review.targetSnapshotSha256 === proposal.targetSnapshot.sha256,
  'Correction review does not bind the exact proposed assessment and frozen inputs.')
  assertAnalysis(proposal.provenance.policyVersion === ANALYSIS_CORRECTION_POLICY_VERSION
    ? Boolean(review.scope && review.scope.baseAssessmentSha256 === proposal.provenance.baseAssessmentSha256 &&
      analysisHash([...review.scope.criterionIds].sort()) === analysisHash([...proposal.provenance.criterionIds].sort()))
    : !review.scope, 'Correction review scope differs from the explicitly requested policy, base, or criteria.')
}

export function correctionBlockedReason(
  result: RealAnalysisAssessmentOutput, target: FrozenRealAnalysisTargetSnapshot, criterion: RealCriterionResult,
  policyVersion: AnalysisCorrectionPolicyVersion = ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION,
): string | null {
  if (criterion.evidenceStatus !== 'not-assessed' || criterion.weight <= 0) return 'Only unassessed, positively weighted criteria can be proposed.'
  const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
  const definition = rubric.criteria.find(row => row.id === criterion.criterionId)
  assertAnalysis(definition, 'Correction criterion is absent from its frozen rubric.')
  if (isPersonalTraitCriterion(definition.label, definition.description)) return 'Personal-trait safeguards cannot be replaced with a zero score.'
  if (criterion.limitation.code === 'context-limit' || criterion.limitation.blockerCode === 'unusable-source' ||
    policyVersion === ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION && criterion.limitation.code === 'source-quality' ||
    result.limitations.some(item => ['source-quality', 'context-limit'].includes(item.code) &&
      (!item.criterionId && !item.qualificationId || item.criterionId === criterion.criterionId &&
        (item.code === 'context-limit' || item.blockerCode === 'unusable-source' ||
          policyVersion === ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION)))) {
    return 'A source-quality or processing limitation must be resolved; missing evidence cannot be assumed.'
  }
  return null
}

export function buildEvidenceCorrectionAssessment(
  base: RealAnalysisAssessmentOutput, target: FrozenRealAnalysisTargetSnapshot, criterionIds: string[],
  policyVersion: AnalysisCorrectionPolicyVersion = ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION,
): RealAnalysisAssessmentOutput {
  analysisCorrectionCriterionIdsSchema.parse(criterionIds)
  const selected = new Set(criterionIds)
  assertAnalysis(criterionIds.every(id => base.criteria.some(row => row.criterionId === id &&
    correctionBlockedReason(base, target, row, policyVersion) === null)), 'Correction contains an ineligible criterion.')
  const criteria = base.criteria.map(row => selected.has(row.criterionId) ? missingEvidenceCriterion(row) : structuredClone(row))
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
      proposal.provenance.policyVersion,
    )), 'Correction changed an unrelated score, weight, qualification, evidence citation, or limitation.')
}
