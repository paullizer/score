import { z } from 'zod'

export const EDITABLE_PROMPT_FAMILIES = ['jobRubric', 'gradeCompetencies', 'gradeDraft', 'assessment'] as const
export const FIXED_PROMPT_FAMILIES = ['gradeReview', 'assessmentGrounding', 'evidenceGapReview'] as const
export const PROMPT_FAMILIES = [...EDITABLE_PROMPT_FAMILIES, ...FIXED_PROMPT_FAMILIES] as const
export type EditablePromptFamily = typeof EDITABLE_PROMPT_FAMILIES[number]
export type PromptFamily = typeof PROMPT_FAMILIES[number]
export const PROMPT_RENDERER_VERSION = 'score-prompt-renderer-v1' as const
export const PINNED_ASSESSMENT_SCHEMA_VERSION = 'score-analysis-assessment-qc-v1' as const
export const PROMPT_REGISTRY_LIMITS = { guidanceCharacters: 4_000, reasonCharacters: 1_000, snapshotBytes: 64 * 1024 } as const

export const promptIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
export const promptHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const nonblank = (max: number) => z.string().min(1).max(max).regex(/\S/)
export const promptActorSchema = z.union([
  z.strictObject({ tenantId: z.uuid(), oid: z.uuid() }),
  z.strictObject({ system: z.literal('initialization') }),
])
export const promptGuidanceSchema = nonblank(PROMPT_REGISTRY_LIMITS.guidanceCharacters).refine(
  value => !/\{\{|\}\}|\$\{|<%|%>|\{[A-Za-z_][A-Za-z0-9_.-]*\}/.test(value) &&
    [...value].every(character => character === '\n' || character === '\t' || character.charCodeAt(0) >= 32),
  'Guidance must be complete plain text, without control characters or unresolved template placeholders.',
)

export const promptRevisionReferenceSchema = z.strictObject({
  revisionId: promptIdentifierSchema,
  contentSha256: promptHashSchema,
  templateVersion: promptIdentifierSchema,
  templateSha256: promptHashSchema,
  outputSchemaVersion: promptIdentifierSchema,
  rendererVersion: z.literal(PROMPT_RENDERER_VERSION),
})
export const promptRevisionSchema = promptRevisionReferenceSchema.extend({
  schemaVersion: z.literal(1),
  family: z.enum(PROMPT_FAMILIES),
  createdAt: z.iso.datetime(),
  actor: promptActorSchema,
  parentRevisionId: promptIdentifierSchema.nullable(),
  guidance: promptGuidanceSchema.nullable(),
  guidanceSha256: promptHashSchema,
}).superRefine((revision, ctx) => {
  const editable = (EDITABLE_PROMPT_FAMILIES as readonly string[]).includes(revision.family)
  if (editable !== (revision.guidance !== null)) {
    ctx.addIssue({ code: 'custom', path: ['guidance'], message: 'Only the four task-guidance families are editable; fixed review templates have no guidance.' })
  }
})
export type PromptRevisionReference = z.infer<typeof promptRevisionReferenceSchema>
export type PromptRevision = z.infer<typeof promptRevisionSchema>
export type PromptActor = z.infer<typeof promptActorSchema>

function families<T extends z.ZodType>(value: T) {
  return z.strictObject(Object.fromEntries(PROMPT_FAMILIES.map(family => [family, value])) as Record<PromptFamily, T>)
}
export const promptBundleRevisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bundleId: promptIdentifierSchema,
  bundleSha256: promptHashSchema,
  parentBundleId: promptIdentifierSchema.nullable(),
  createdAt: z.iso.datetime(),
  actor: promptActorSchema,
  revisions: families(promptRevisionReferenceSchema),
})
export type PromptBundleRevision = z.infer<typeof promptBundleRevisionSchema>

/** A complete retained copy of immutable guidance, not a mutable-current lookup or private evidence. */
export const promptBundleSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bundle: promptBundleRevisionSchema,
  revisions: families(promptRevisionSchema),
}).superRefine((snapshot, ctx) => {
  for (const family of PROMPT_FAMILIES) {
    const revision = snapshot.revisions[family]
    const reference = snapshot.bundle.revisions[family]
    if (revision.family !== family || Object.keys(reference).some(key =>
      reference[key as keyof PromptRevisionReference] !== revision[key as keyof PromptRevisionReference])) {
      ctx.addIssue({ code: 'custom', path: ['revisions', family], message: 'The retained revision must exactly match its bundle pin and family.' })
    }
  }
})
export type PromptBundleSnapshot = z.infer<typeof promptBundleSnapshotSchema>

export const promptExecutionProvenanceSchema = promptRevisionReferenceSchema.extend({
  bundleId: promptIdentifierSchema,
  bundleSha256: promptHashSchema,
  family: z.enum(PROMPT_FAMILIES),
  systemSha256: promptHashSchema,
})
export type PromptExecutionProvenance = z.infer<typeof promptExecutionProvenanceSchema>

export const promptEvaluationReferenceSchema = z.strictObject({
  workspaceId: promptIdentifierSchema,
  planId: promptIdentifierSchema,
  planRevisionId: promptIdentifierSchema,
  planSha256: promptHashSchema,
  evaluationId: promptIdentifierSchema,
  evaluationSha256: promptHashSchema,
  baselineBundleId: promptIdentifierSchema,
  baselineBundleSha256: promptHashSchema,
  evaluatedBundleId: promptIdentifierSchema,
  evaluatedBundleSha256: promptHashSchema,
})
export type PromptEvaluationReference = z.infer<typeof promptEvaluationReferenceSchema>
export const promptRestorationReferenceSchema = z.strictObject({
  requestId: promptIdentifierSchema,
  sourceActivationId: promptIdentifierSchema,
  expectedEtag: z.string().min(1).max(256).refine(value =>
    value !== '*' && !value.startsWith('W/') && !value.includes(',') && value.trim() === value),
})
export const promptActivationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  activationId: promptIdentifierSchema,
  bundleId: promptIdentifierSchema,
  bundleSha256: promptHashSchema,
  parentBundleId: promptIdentifierSchema.nullable(),
  parentBundleSha256: promptHashSchema.nullable(),
  createdAt: z.iso.datetime(),
  actor: promptActorSchema,
  reason: nonblank(PROMPT_REGISTRY_LIMITS.reasonCharacters),
  evaluation: promptEvaluationReferenceSchema.nullable(),
  restoration: promptRestorationReferenceSchema.optional(),
}).superRefine((activation, ctx) => {
  const initialized = 'system' in activation.actor
  const invalid = initialized
    ? activation.parentBundleId !== null || activation.parentBundleSha256 !== null || activation.evaluation !== null || activation.restoration !== undefined
    : activation.parentBundleId === null || activation.parentBundleSha256 === null ||
      ((activation.evaluation === null) === (activation.restoration === undefined))
  if (invalid) ctx.addIssue({ code: 'custom', message: 'An activation must be initialization, an evaluated release, or an explicitly audited restoration.' })
  if (activation.evaluation && (
    activation.evaluation.evaluatedBundleId !== activation.bundleId || activation.evaluation.evaluatedBundleSha256 !== activation.bundleSha256 ||
    activation.evaluation.baselineBundleId !== activation.parentBundleId || activation.evaluation.baselineBundleSha256 !== activation.parentBundleSha256
  )) ctx.addIssue({ code: 'custom', path: ['evaluation'], message: 'The evaluated release must retain its exact candidate and parent baseline.' })
})
export type PromptActivation = z.infer<typeof promptActivationSchema>
export type PromptRestorationReference = z.infer<typeof promptRestorationReferenceSchema>
export interface PromptHistoryPage { activations: PromptActivation[]; nextBefore?: string }
export interface CurrentPromptBundle { bundle: PromptBundleRevision; activation: PromptActivation; etag: string }
export interface PublishedPromptBundle { snapshot: PromptBundleSnapshot; activation: PromptActivation }
export type PromptGuidanceDraft = Partial<Record<EditablePromptFamily, string>>

export const promptGuidanceDraftSchema = z.strictObject(Object.fromEntries(
  EDITABLE_PROMPT_FAMILIES.map(family => [family, promptGuidanceSchema.optional()]),
) as Record<EditablePromptFamily, z.ZodOptional<typeof promptGuidanceSchema>>).refine(value => Object.keys(value).length > 0,
  'Provide at least one editable task-guidance family.')

/** These are contracts, not editable guidance. Old unpinned operations never receive this addition. */
export const ASSESSMENT_QC_DIAGNOSTIC_INSTRUCTIONS = `
In this version only, return qcDiagnostics={"criteria":[...]} with exactly one row for every saved criterionId, independently of unscored qualification notes. Each row contains criterionId, confidence, explanation, ambiguity and alternativeScores.
Confidence is your stated certainty applying this exact saved rubric to this submitted document, NOT a probability of correctness, a claim about personal ability, or a substitute for evidence. A numeric criterion score requires confidence low, medium, or high and a concise document/rubric-scoped explanation. Missing evidence can justify a confident zero: evidence coverage and scoring certainty are different.
For score=null use confidence=null, explain the unscored or excluded state, and return alternativeScores=[]. Do not manufacture numeric confidence for unassessed rows or saved zero-weight exclusions.
ambiguity is a bounded list of specific {category, explanation} objects. Categories are rubric-anchors, evidence-scope, contradictory-evidence, source-clarity, or criterion-scope. Use [] when there is no genuine ambiguity; explain only uncertainty relevant to applying this rubric, never protected traits or speculation about the person.
alternativeScores is a bounded list of distinct defensible integer ratings from 0 through 5, excluding the chosen score. Include only alternatives genuinely supported by the same document and saved anchors and explain that ambiguity; it is not a statistical confidence interval. Never invent support or use alternatives to evade a blocker.
Diagnostics do not change scores, citation requirements, independent grounding authority, or the shared correction budget. Do not return diagnostics for qualifications.`
export const PROMPT_RUNTIME_VERSION = 'score-prompt-runtime-v1'
