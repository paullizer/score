import { z } from 'zod'
import type { RealAnalysisAssessmentInput } from '../../src/domain/real-analyses'

export const ANALYSIS_MODEL_LIMITS = {
  maxContextCharacters: 240_000,
  maxOutputCharacters: 64_000,
  maxResponseBytes: 512_000,
  assessmentCompletionTokens: 16_384,
  reviewCompletionTokens: 12_288,
  maxCriteria: 20,
  maxQualifications: 50,
  maxRequirementCitations: 60,
  maxCitations: 8,
  maxQuoteCharacters: 4_000,
  maxRationaleCharacters: 2_000,
  maxLimitationCharacters: 1_200,
  maxReviewIssues: 64,
  maxCitationFindings: 32,
  maxCorrectionSources: 8,
  maxCorrectionSourceCharacters: 8_000,
} as const

export const ANALYSIS_MODEL_SCHEMA_VERSIONS = {
  assessment: 'score-analysis-assessment-v2',
  grounding: 'score-analysis-grounding-v2',
} as const

const identifier = z.string().min(1).max(200).regex(/\S/)
const nonblank = (max: number) => z.string().min(1).max(max).regex(/\S/)

export const savedCitationSchema = z.strictObject({
  documentId: identifier,
  documentVersion: z.number().int().min(1),
  paragraphId: identifier,
  page: z.number().int().min(1),
  heading: z.string().max(2_000),
  quote: nonblank(32_000),
})

const savedCitations = z.array(savedCitationSchema).max(ANALYSIS_MODEL_LIMITS.maxRequirementCitations)
const savedCriterion = z.strictObject({
  id: identifier,
  key: z.enum(['technical', 'delivery', 'analysis', 'communication', 'leadership', 'policy', 'custom']),
  label: nonblank(300),
  description: nonblank(12_000),
  weight: z.number().min(0).max(100),
  guidance: nonblank(12_000),
  sourceParagraphId: identifier.optional(),
  requirementType: z.enum(['required', 'preferred']).optional(),
  sourceCitations: savedCitations.optional(),
})
const savedRubric = z.strictObject({
  id: identifier,
  groupId: identifier,
  dataKind: z.literal('real'),
  name: nonblank(400),
  description: nonblank(12_000),
  version: z.number().int().min(1),
  createdAt: nonblank(100),
  provenance: z.strictObject({
    kind: z.enum(['generated', 'edited']),
    model: nonblank(300),
    promptVersion: nonblank(200),
  }).optional(),
})

export const assessmentInputSchema = z.strictObject({
  resume: z.strictObject({
    id: identifier,
    version: z.number().int().min(1),
    kind: z.literal('resume'),
    title: nonblank(2_000),
    sample: z.literal(false),
    paragraphs: z.array(z.strictObject({
      id: identifier,
      page: z.number().int().min(1),
      heading: z.string().max(2_000),
      text: z.string().min(1).regex(/\S/),
    })).min(1).max(30_000),
  }),
  rubric: z.discriminatedUnion('kind', [
    savedRubric.extend({
      kind: z.literal('job'),
      jobId: identifier,
      criteria: z.array(savedCriterion).min(1).max(ANALYSIS_MODEL_LIMITS.maxCriteria),
    }),
    savedRubric.extend({
      kind: z.literal('grade'),
      jobId: identifier.optional(),
      ladder: nonblank(300),
      grade: nonblank(20),
      criteria: z.array(savedCriterion.extend({
        competencyId: identifier,
        support: z.enum(['direct', 'derived', 'gap', 'not-applicable']),
        gradeBasis: savedCitations,
        interpretation: nonblank(12_000),
      })).min(1).max(ANALYSIS_MODEL_LIMITS.maxCriteria),
    }),
  ]),
  qualifications: z.array(z.strictObject({
    id: identifier,
    text: nonblank(32_000),
    citations: savedCitations,
    interpretation: nonblank(12_000),
    support: z.enum(['direct', 'derived', 'gap']),
  })).max(ANALYSIS_MODEL_LIMITS.maxQualifications),
  requirementEvidence: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('criterion'), criterionId: identifier, citations: savedCitations }),
    z.strictObject({ kind: z.literal('qualification'), qualificationId: identifier, citations: savedCitations }),
  ])).max(ANALYSIS_MODEL_LIMITS.maxCriteria + ANALYSIS_MODEL_LIMITS.maxQualifications),
})

// Canonical quote validation is separate from the model-facing passage selections.
const resumeQuote = z.strictObject({
  paragraphId: identifier,
  quote: nonblank(ANALYSIS_MODEL_LIMITS.maxQuoteCharacters),
})
const limitation = z.strictObject({
  code: z.enum(['sparse-source', 'not-assessable', 'source-quality']),
  message: nonblank(ANALYSIS_MODEL_LIMITS.maxLimitationCharacters),
})
const criterionResult = z.strictObject({
  criterionId: identifier,
  evidenceStatus: z.enum(['supported', 'partial', 'missing', 'not-assessed', 'not-applicable']),
  score: z.number().int().min(0).max(5).nullable(),
  rationale: nonblank(ANALYSIS_MODEL_LIMITS.maxRationaleCharacters),
  citations: z.array(resumeQuote).max(ANALYSIS_MODEL_LIMITS.maxCitations),
  limitation: limitation.nullable(),
})
const qualificationResult = z.strictObject({
  qualificationId: identifier,
  evidenceStatus: z.enum(['supported', 'partial', 'missing', 'not-assessed']),
  rationale: nonblank(ANALYSIS_MODEL_LIMITS.maxRationaleCharacters),
  citations: z.array(resumeQuote).max(ANALYSIS_MODEL_LIMITS.maxCitations),
  limitation: limitation.nullable(),
})

export const assessmentSchema = z.strictObject({
  criteria: z.array(criterionResult).min(1).max(ANALYSIS_MODEL_LIMITS.maxCriteria),
  qualifications: z.array(qualificationResult).max(ANALYSIS_MODEL_LIMITS.maxQualifications),
})

export const groundingSchema = z.strictObject({
  outcome: z.enum(['supported', 'needs-correction', 'unsupported']),
  issues: z.array(z.strictObject({
    code: z.enum([
      'unsupported-score', 'unsupported-rationale', 'irrelevant-evidence', 'omitted-evidence',
      'unjustified-limitation', 'invalid-exclusion', 'qualification-judgment',
      'prohibited-inference', 'insufficient-context',
    ]),
    message: nonblank(ANALYSIS_MODEL_LIMITS.maxRationaleCharacters),
    criterionId: identifier.nullable(),
    qualificationId: identifier.nullable(),
    citations: z.array(resumeQuote).max(ANALYSIS_MODEL_LIMITS.maxCitations),
  })).max(ANALYSIS_MODEL_LIMITS.maxReviewIssues),
})

export type ModelResumeQuote = z.infer<typeof resumeQuote>
export type ModelAnalysisAssessment = z.infer<typeof assessmentSchema>
export type ModelAnalysisGroundingReview = z.infer<typeof groundingSchema>

export function assessmentSchemaForInput(input: RealAnalysisAssessmentInput) {
  const citations = scopedQuotes(input)
  return assessmentSchema.extend({
    criteria: z.array(criterionResult.extend({
      criterionId: z.enum(input.rubric.criteria.map(value => value.id)),
      citations,
    })).length(input.rubric.criteria.length),
    qualifications: z.array(qualificationResult.extend({
      qualificationId: input.qualifications.length ? z.enum(input.qualifications.map(value => value.id)) : identifier,
      citations,
    })).length(input.qualifications.length),
  })
}

export function groundingSchemaForInput(input: RealAnalysisAssessmentInput) {
  return groundingSchema.extend({
    issues: z.array(groundingSchema.shape.issues.element.extend({
      criterionId: z.enum(input.rubric.criteria.map(value => value.id)).nullable(),
      qualificationId: input.qualifications.length ? z.enum(input.qualifications.map(value => value.id)).nullable() : z.null(),
      citations: scopedQuotes(input),
    })).max(ANALYSIS_MODEL_LIMITS.maxReviewIssues),
  })
}

function scopedQuotes(input: RealAnalysisAssessmentInput) {
  return z.array(resumeQuote.extend({
    paragraphId: z.enum(input.resume.paragraphs.map(value => value.id)),
  })).max(ANALYSIS_MODEL_LIMITS.maxCitations)
}

function passageSelections(passageCount: number) {
  return z.array(z.strictObject({
    passageId: z.number().int().min(1).max(passageCount),
  })).max(ANALYSIS_MODEL_LIMITS.maxCitations)
}

export function assessmentSelectionSchemaForInput(input: RealAnalysisAssessmentInput, passageCount: number) {
  const citations = passageSelections(passageCount)
  return assessmentSchema.extend({
    criteria: z.array(criterionResult.extend({
      criterionId: z.enum(input.rubric.criteria.map(value => value.id)), citations,
    })).length(input.rubric.criteria.length),
    qualifications: z.array(qualificationResult.extend({
      qualificationId: input.qualifications.length ? z.enum(input.qualifications.map(value => value.id)) : identifier,
      citations,
    })).length(input.qualifications.length),
  })
}

export function groundingSelectionSchemaForInput(input: RealAnalysisAssessmentInput, passageCount: number) {
  return groundingSchema.extend({
    issues: z.array(groundingSchema.shape.issues.element.extend({
      criterionId: z.enum(input.rubric.criteria.map(value => value.id)).nullable(),
      qualificationId: input.qualifications.length ? z.enum(input.qualifications.map(value => value.id)).nullable() : z.null(),
      citations: passageSelections(passageCount),
    })).max(ANALYSIS_MODEL_LIMITS.maxReviewIssues),
  })
}

export function analysisStructuredSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema)
  delete result.$schema
  return result
}
