import { z } from 'zod'
import { ANALYSIS_NARRATIVE_LIMITS } from '../../src/domain/analysis-narratives'
import {
  candidateNarrativeOutputSchema, targetNarrativeOutputSchema, narrativeGroundingReviewOutputSchema,
} from '../../src/domain/analysis-narrative-validation'

export const NARRATIVE_MODEL_LIMITS = {
  maxRequestBytes: 288_000,
  maxContextBytes: 96_000,
  maxCorpusBytes: 64 * 1024 * 1024,
  maxSynthesisOutputBytes: 32_000,
  maxSynthesisFindings: 256,
  maxFindingCharacters: 600,
  maxSynthesisLevels: 10,
  maxModelCalls: 2_006,
  requestTimeoutMilliseconds: 125_000,
  operationTimeoutMilliseconds: 10 * 60_000,
  candidateCompletionTokens: 4_096,
  targetCompletionTokens: 12_288,
  synthesisCompletionTokens: 16_384,
  reviewCompletionTokens: 8_192,
} as const

export const NARRATIVE_SYNTHESIS_PROMPT_VERSION = 'score-analysis-narrative-synthesis-v1'
export const NARRATIVE_SYNTHESIS_SCHEMA_VERSION = 'analysis-narrative-synthesis-v1'

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/)
const referenceIds = (count: number) =>
  z.array(z.number().int().min(1).max(count)).min(1).max(ANALYSIS_NARRATIVE_LIMITS.maxReferencesPerClaim)

export function candidateNarrativeSelectionSchema(referenceCount: number) {
  return candidateNarrativeOutputSchema.extend({
    claims: z.array(z.strictObject({
      id, location: candidateNarrativeOutputSchema.shape.claims.element.shape.location,
      referenceIds: referenceIds(referenceCount),
    })).min(4).max(5),
  })
}

export function targetNarrativeSelectionSchema(referenceCount: number) {
  return targetNarrativeOutputSchema.extend({
    claims: z.array(z.strictObject({
      id, location: targetNarrativeOutputSchema.shape.claims.element.shape.location,
      referenceIds: referenceIds(referenceCount),
    })).min(1).max(ANALYSIS_NARRATIVE_LIMITS.maxClaims),
  })
}

export function narrativeReviewSelectionSchema(referenceCount: number) {
  return narrativeGroundingReviewOutputSchema.extend({
    issues: z.array(z.strictObject({
      code: narrativeGroundingReviewOutputSchema.shape.issues.element.shape.code,
      message: narrativeGroundingReviewOutputSchema.shape.issues.element.shape.message,
      claimId: id.nullable(),
      referenceIds: referenceIds(referenceCount).min(0),
    })).max(32),
  })
}

export function narrativeSynthesisSelectionSchema(referenceCount: number, memberCount: number) {
  return z.strictObject({
    members: z.array(z.number().int().min(1).max(ANALYSIS_NARRATIVE_LIMITS.maxComparisons)).length(memberCount),
    findings: z.array(z.strictObject({
      id,
      text: z.string().min(1).max(NARRATIVE_MODEL_LIMITS.maxFindingCharacters),
      referenceIds: referenceIds(referenceCount),
    })).min(1).max(NARRATIVE_MODEL_LIMITS.maxSynthesisFindings),
  })
}

export type NarrativeSelectionClaim = z.infer<ReturnType<typeof candidateNarrativeSelectionSchema>>['claims'][number] |
  z.infer<ReturnType<typeof targetNarrativeSelectionSchema>>['claims'][number]
export type NarrativeSynthesisOutput = z.infer<ReturnType<typeof narrativeSynthesisSelectionSchema>>
