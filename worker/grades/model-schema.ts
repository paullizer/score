import { z } from 'zod'
import { GRADE_LADDER_LIMITS } from '../../src/domain/real-grades'

const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
const text = z.string().min(1).max(8_000)

export const citationSchema = z.strictObject({
  documentId: identifier,
  documentVersion: z.number().int().min(1),
  paragraphId: identifier,
  page: z.number().int().min(1),
  heading: z.string().max(2_000),
  quote: z.string().min(1).max(32_000),
})

const citations = z.array(citationSchema).max(24)

export const issueSchema = z.strictObject({
  code: z.string().min(1).max(100).regex(/^[a-z][a-z0-9-]*$/),
  severity: z.enum(['blocker', 'warning']),
  scope: z.enum(['context', 'source', 'grade', 'criterion', 'qualification']),
  message: text,
  sourceId: identifier.nullable(),
  grade: z.number().int().min(1).max(15).nullable(),
  criterionId: identifier.nullable(),
  citations,
})

export const competencySchema = z.strictObject({
  id: identifier,
  label: z.string().min(1).max(300),
  description: text,
  seedCriterionIds: z.array(identifier).max(GRADE_LADDER_LIMITS.maxCriteria),
  citations,
})

export const planSchema = z.strictObject({
  competencies: z.array(competencySchema).min(1).max(GRADE_LADDER_LIMITS.maxCriteria),
  issues: z.array(issueSchema).max(80),
})

export const draftCriterionSchema = z.strictObject({
  competencyId: identifier,
  key: z.enum(['technical', 'delivery', 'analysis', 'communication', 'leadership', 'policy', 'custom']),
  description: text,
  weight: z.number().min(0).max(100),
  guidance: z.string().min(1).max(12_000),
  support: z.enum(['direct', 'derived', 'gap', 'not-applicable']),
  sourceCitations: citations,
  gradeBasis: citations,
  interpretation: text,
})

export const qualificationSchema = z.strictObject({
  id: identifier,
  text: z.string().min(1).max(32_000),
  citations,
  interpretation: text,
  support: z.enum(['direct', 'derived', 'gap']),
})

export const savedQualificationSchema = qualificationSchema.extend({
  interpretation: z.string().min(1).max(12_000),
})

export const draftSchema = z.strictObject({
  description: text,
  criteria: z.array(draftCriterionSchema).min(1).max(GRADE_LADDER_LIMITS.maxCriteria),
  qualifications: z.array(qualificationSchema).max(40),
  issues: z.array(issueSchema).max(80),
})

interface IssueScope {
  sourceIds: string[]
  criterionIds: string[]
  grade: number
}

function scopedIssueSchema(scope: IssueScope) {
  return issueSchema.extend({
    sourceId: scope.sourceIds.length ? z.enum(scope.sourceIds).nullable() : z.null(),
    criterionId: scope.criterionIds.length ? z.enum(scope.criterionIds).nullable() : z.null(),
    grade: z.literal(scope.grade).nullable(),
  })
}

export function draftSchemaForDocuments(documentIds: string[], scope: IssueScope) {
  const gradeBasis = documentIds.length
    ? z.array(citationSchema.extend({ documentId: z.enum(documentIds) })).max(24)
    : z.array(citationSchema).max(0)
  return draftSchema.extend({
    criteria: z.array(draftCriterionSchema.extend({ gradeBasis })).min(1).max(GRADE_LADDER_LIMITS.maxCriteria),
    issues: z.array(scopedIssueSchema(scope)).max(80),
  })
}

export const reviewSchema = z.strictObject({
  outcome: z.enum(['supported', 'needs-sources']),
  issues: z.array(issueSchema).max(80),
})

export function reviewSchemaForScope(scope: IssueScope) {
  return reviewSchema.extend({ issues: z.array(scopedIssueSchema(scope)).max(80) })
}

export const savedRubricSchema = z.strictObject({
  id: identifier,
  groupId: identifier,
  kind: z.literal('grade'),
  dataKind: z.literal('real'),
  ladder: z.string().min(1).max(300),
  grade: z.string().min(1).max(10),
  name: z.string().min(1).max(400),
  description: z.string().min(1).max(12_000),
  version: z.number().int().min(1),
  createdAt: z.string().min(1).max(100),
  provenance: z.strictObject({
    kind: z.enum(['generated', 'edited']),
    model: z.string().min(1).max(300),
    promptVersion: z.string().min(1).max(200),
    prompt: promptExecutionProvenanceSchema.optional(),
  }).optional(),
  criteria: z.array(draftCriterionSchema.extend({
    id: identifier,
    label: z.string().min(1).max(300),
    interpretation: z.string().min(1).max(12_000),
    sourceParagraphId: identifier.optional(),
    requirementType: z.enum(['required', 'preferred']).optional(),
  })).min(1).max(GRADE_LADDER_LIMITS.maxCriteria),
})

export type ModelIssue = z.infer<typeof issueSchema>
export type ModelPlan = z.infer<typeof planSchema>
export type ModelDraft = z.infer<typeof draftSchema>
export type ModelCriterion = z.infer<typeof draftCriterionSchema>
export type ModelQualification = z.infer<typeof qualificationSchema>
export type ModelReview = z.infer<typeof reviewSchema>

export function structuredSchema(schema: z.ZodType): Record<string, unknown> {
  return strictStructuredOutputSchema(schema)
}
import { promptExecutionProvenanceSchema } from '../../src/domain/prompt-versions'
import { strictStructuredOutputSchema } from '../structured-output-schema'
