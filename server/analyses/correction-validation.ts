import { z } from 'zod'
import { processingSettingsSnapshotSchema } from '../../src/domain/admin-settings-schema'
import { assertAcceptedPromptBinding } from '../settings/prompt-integrity'
import { preservesProcessingSettings } from '../jobs/policy'
import {
  ANALYSIS_CORRECTION_POLICY_VERSION, ANALYSIS_LEGACY_CORRECTION_POLICY_VERSION, ANALYSIS_REASSESSMENT_POLICY_VERSION,
  type AnalysisCorrectionHistoryEntry, type AnalysisCorrectionInput,
  type AnalysisCorrectionPolicyVersion, type AnalysisCorrectionProposal, type RealAnalysisCorrectionRecord,
} from '../../src/domain/analysis-corrections'
import { isPersonalTraitCriterion, missingEvidenceCriterion } from '../../src/domain/analysis-evidence-policy'
import type {
  FrozenRealAnalysisTargetSnapshot, RealAnalysisAssessmentOutput, RealAnalysisGroundingReview, RealAnalysisResult,
  RealAnalysisResultSummary, RealCriterionResult,
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
  provenance: analysisCorrectionProvenanceSchema, assessment: analysisAssessmentOutputSchema.optional(),
  summary: analysisResultSummarySchema.optional(),
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
  const reassessment = parsed.provenance.policyVersion === ANALYSIS_REASSESSMENT_POLICY_VERSION
  assertAnalysis(reassessment ? !parsed.assessment && !parsed.summary : Boolean(parsed.assessment && parsed.summary),
    'A missing-evidence correction must carry its deterministic proposal; a full re-score must not.')
  const { assessment: proposed, ...fields } = parsed
  const proposal: AnalysisCorrectionProposal = {
    ...fields, ...(proposed ? { assessment: parseAnalysisAssessmentOutput(proposed) } : {}),
  }
  assertAnalysis(proposal.requestId === proposal.provenance.requestId &&
    proposal.createdAt === proposal.provenance.requestedAt &&
    proposal.originalResultSha256 === proposal.provenance.originalResultSha256 &&
    proposal.baseResult.sha256 === proposal.provenance.baseResultSha256 &&
    proposal.requestFingerprint === analysisCorrectionFingerprint(proposal.workspaceId, proposal.runId, proposal.comparisonId, {
      policyVersion: proposal.provenance.policyVersion,
      resultSha256: proposal.baseResult.sha256, criterionIds: proposal.provenance.criterionIds, reason: proposal.provenance.reason,
    }, proposal.provenance.requestedBy), 'Correction proposal has inconsistent request bindings.')
  if (!reassessment) {
    const { assessment, summary } = correctionProposalAssessment(proposal)
    assertAnalysis(analysisHash(summary) === analysisHash(calculateAnalysisSummary(
      assessment.criteria, assessment.qualifications, assessment.limitations,
    )), 'Correction preview was not calculated from the exact proposed assessment.')
  }
  return proposal
}

/** The deterministic assessment and total of a missing-evidence correction; full re-scores have none. */
export function correctionProposalAssessment(
  proposal: AnalysisCorrectionProposal,
): { assessment: RealAnalysisAssessmentOutput; summary: RealAnalysisResultSummary } {
  assertAnalysis(proposal.provenance.policyVersion !== ANALYSIS_REASSESSMENT_POLICY_VERSION && proposal.assessment && proposal.summary,
    'Only a missing-evidence correction has a deterministic proposed assessment.')
  return { assessment: proposal.assessment, summary: proposal.summary }
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
  review: RealAnalysisGroundingReview, proposal: AnalysisCorrectionProposal, reassessedAssessmentSha256?: string,
): void {
  analysisGroundingReviewSchema.parse(review)
  const policyVersion = proposal.provenance.policyVersion
  const reassessment = policyVersion === ANALYSIS_REASSESSMENT_POLICY_VERSION
  assertAcceptedPromptBinding(review.provenance.prompt, proposal.processingSettings?.promptBundle,
    policyVersion === ANALYSIS_CORRECTION_POLICY_VERSION ? 'evidenceGapReview' : 'assessmentGrounding')
  const assessmentSha256 = reassessment
    ? reassessedAssessmentSha256
    : analysisHash(correctionProposalAssessment(proposal).assessment)
  assertAnalysis(Boolean(assessmentSha256) && review.assessmentSha256 === assessmentSha256 &&
    review.resumeSnapshotSha256 === proposal.resumeSnapshot.sha256 &&
    review.targetSnapshotSha256 === proposal.targetSnapshot.sha256,
  'Correction review does not bind the exact proposed assessment and frozen inputs.')
  assertAnalysis(policyVersion === ANALYSIS_CORRECTION_POLICY_VERSION
    ? Boolean(review.scope && review.scope.baseAssessmentSha256 === proposal.provenance.baseAssessmentSha256 &&
      analysisHash([...review.scope.criterionIds].sort()) === analysisHash([...proposal.provenance.criterionIds].sort()))
    : !review.scope, 'Correction review scope differs from the explicitly requested policy, base, or criteria.')
}

/** The positively weighted criteria that left this total withheld; a full re-score is requested for exactly these. */
export function reassessmentCriterionIds(result: RealAnalysisAssessmentOutput): string[] {
  return result.criteria.filter(row => row.evidenceStatus === 'not-assessed' && row.weight > 0).map(row => row.criterionId)
}

export function reassessmentBlockedReason(
  result: RealAnalysisAssessmentOutput & Pick<RealAnalysisResult, 'overall'>, target: FrozenRealAnalysisTargetSnapshot,
): string | null {
  if (result.overall.score !== null) return 'Only a comparison whose total is withheld can be re-scored in place.'
  const criterionIds = reassessmentCriterionIds(result)
  if (!criterionIds.length) return 'No weighted criterion is waiting for a score; the total is withheld for another reason.'
  const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
  const traits = criterionIds.every(id => {
    const definition = rubric.criteria.find(row => row.id === id)
    assertAnalysis(definition, 'Re-score criterion is absent from its frozen rubric.')
    return isPersonalTraitCriterion(definition.label, definition.description)
  })
  return traits ? 'Only personal-trait safeguards withhold this total; Score does not infer those from a resume.' : null
}

/** Binds a full re-score request to the exact withheld result it replaces. */
export function assertReassessmentProposal(
  proposal: AnalysisCorrectionProposal, base: RealAnalysisResult, target: FrozenRealAnalysisTargetSnapshot,
): void {
  assertAnalysis(proposal.provenance.policyVersion === ANALYSIS_REASSESSMENT_POLICY_VERSION && !proposal.assessment &&
    !proposal.summary && proposal.provenance.baseAssessmentSha256 === base.provenance.assessmentSha256 &&
    reassessmentBlockedReason(base, target) === null &&
    analysisHash(proposal.provenance.criterionIds) === analysisHash(reassessmentCriterionIds(base)),
  'Re-score request no longer matches the withheld criteria of its base result.')
}

/** A re-scored result must be a fresh, supported full-pipeline result produced with the request's captured rules. */
export function assertReassessmentResult(result: RealAnalysisResult, proposal: AnalysisCorrectionProposal): void {
  const { provenance } = result
  const supported = provenance.groundingReviews.at(-1)
  assertAnalysis(proposal.provenance.policyVersion === ANALYSIS_REASSESSMENT_POLICY_VERSION && provenance.correction &&
    analysisHash(provenance.correction) === analysisHash(proposal.provenance) &&
    result.comparisonId === proposal.comparisonId && result.runId === proposal.runId &&
    result.workspaceId === proposal.workspaceId && provenance.manifestSha256 === proposal.manifestSha256 &&
    analysisHash(provenance.resumeSnapshot) === analysisHash(proposal.resumeSnapshot) &&
    analysisHash(provenance.targetSnapshot) === analysisHash(proposal.targetSnapshot) &&
    provenance.assessment.startedAt >= proposal.createdAt &&
    provenance.groundingReviews.every(review => !review.scope && review.provenance.startedAt >= proposal.createdAt &&
      review.provenance.completedAt <= result.createdAt) &&
    supported?.outcome === 'supported' && supported.issues.length === 0,
  'Re-scored result is not a fresh, supported assessment of the exact frozen inputs.')
  assertAcceptedPromptBinding(provenance.assessment.prompt, proposal.processingSettings?.promptBundle, 'assessment')
  for (const review of provenance.groundingReviews) {
    assertAcceptedPromptBinding(review.provenance.prompt, proposal.processingSettings?.promptBundle, 'assessmentGrounding')
  }
  assertCorrectionReviewBinding(supported, proposal, provenance.assessmentSha256)
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
  const { assessment } = correctionProposalAssessment(proposal)
  assertAnalysis(proposal.provenance.baseAssessmentSha256 === base.provenance.assessmentSha256 &&
    analysisHash(assessment) === analysisHash(buildEvidenceCorrectionAssessment(
      base, target, proposal.provenance.criterionIds,
      proposal.provenance.policyVersion,
    )), 'Correction changed an unrelated score, weight, qualification, evidence citation, or limitation.')
}
