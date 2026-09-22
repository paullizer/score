import type { AnalysisGroundingIssue, RealCriterionResult } from './real-analyses'
import type { Citation } from './types'

export { ANALYSIS_CORRECTION_POLICY_VERSION as ANALYSIS_EVIDENCE_POLICY_VERSION } from './analysis-corrections'

export const ANALYSIS_CRITERION_BLOCKER_CODES = [
  'unusable-source', 'ambiguous-guidance', 'restricted-personal-characteristic',
] as const
export type AnalysisCriterionBlockerCode = typeof ANALYSIS_CRITERION_BLOCKER_CODES[number]

export type AnalysisEvidenceGapDecision = { criterionId: string; message: string } & (
  | { outcome: 'confirmed-missing'; citations: [] }
  | { outcome: 'evidence-found'; citations: [Citation, ...Citation[]] }
  | { outcome: 'blocked'; blockerCode: AnalysisCriterionBlockerCode; citations: Citation[] }
)

export interface AnalysisEvidenceGapReviewScope {
  kind: 'evidence-gaps'
  baseAssessmentSha256: string
  criterionIds: string[]
  decisions: AnalysisEvidenceGapDecision[]
}

export function evidenceGapReviewIssues(decisions: readonly AnalysisEvidenceGapDecision[]): AnalysisGroundingIssue[] {
  return decisions.flatMap((decision): AnalysisGroundingIssue[] => decision.outcome === 'confirmed-missing' ? [] : [{
    code: decision.outcome === 'evidence-found' ? 'omitted-evidence'
      : decision.blockerCode === 'restricted-personal-characteristic' ? 'prohibited-inference' : 'insufficient-context',
    criterionId: decision.criterionId, message: decision.message, citations: decision.citations,
  }])
}

export function missingEvidenceCriterion(row: RealCriterionResult): RealCriterionResult {
  return {
    criterionId: row.criterionId, weight: row.weight, evidenceStatus: 'missing', score: 0, citations: [],
    requirementCitations: structuredClone(row.requirementCitations),
    rationale: 'No supporting evidence for this criterion was identified in the successfully reviewed source. Missing evidence is scored 0/5; this does not establish a lack of ability or experience.',
  }
}

// An obvious-trait guard, not a substitute for independent semantic review.
export function isPersonalTraitCriterion(label: string, description: string): boolean {
  const traits = 'age|race|racial background|ethnicity|religion|sex|gender|pregnancy|disability status|genetic information|marital status|national origin|sexual orientation|citizenship|veteran status'
  return new RegExp(`^(?:(?:applicant|candidate|personal)\\s+)?(?:${traits})(?:\\s+(?:preference|score|matching))?[.!]?\\s*$`, 'i').test(label.trim()) ||
    new RegExp(`\\b(?:score|rank|reward|prefer|evaluate|assess)(?:s|d|ing)?\\s+(?:(?:the|an?)\\s+)?(?:applicants?|candidates?)(?:['’]s?)?\\s+(?:${traits})\\b`, 'i').test(description)
}
