import { z } from 'zod'
import {
  assistConversationSchema, assistInstructionSchema, assistPlainText, assistResponseSchema, assistSubmissionIdSchema,
  type AssistResponse,
} from './assist'
import { JOB_IMPORT_LIMITS } from './real-jobs'
import type { Citation, Criterion, Rubric } from './types'

/**
 * Wire contract for the job-rubric assistant (the first assisted-editing adapter).
 *
 * The browser sends its unsaved draft; the API returns validated operations with server-built
 * citations. Operations are applied with {@link applyRubricAssistOperations} on both sides so the
 * preview, the highlights and any server-side checks agree on the resulting draft.
 */
export const RUBRIC_ASSIST_KIND = 'jobRubric' as const
export const RUBRIC_ASSIST_PROMPT_VERSION = 'score-rubric-assist-v1'

export const RUBRIC_ASSIST_LIMITS = Object.freeze({
  maxCriteria: JOB_IMPORT_LIMITS.maxCriteria,
  maxIdCharacters: 200,
  // Draft bounds accept any saved rubric; assistant-written text is held to tighter bounds.
  maxDraftNameCharacters: 500,
  maxDraftDescriptionCharacters: 10_000,
  maxDraftLabelCharacters: 1_000,
  maxDraftCriterionDescriptionCharacters: 10_000,
  maxDraftGuidanceCharacters: 20_000,
  maxDraftQuoteCharacters: 10_000,
  maxDraftSerializedCharacters: 200_000,
  maxWrittenNameCharacters: 200,
  maxWrittenDescriptionCharacters: 2_000,
  maxWrittenLabelCharacters: 200,
  maxWrittenCriterionDescriptionCharacters: 1_500,
  maxWrittenGuidanceCharacters: 4_000,
  maxWrittenQuoteCharacters: 4_000,
})
const L = RUBRIC_ASSIST_LIMITS

const identifier = z.string().min(1).max(L.maxIdCharacters)
const requirementType = z.enum(['required', 'preferred'])
/** Assistant-written text: bounded, plain, nonblank and already trimmed by the server. */
const writtenText = (max: number) => assistPlainText(max)
  .refine(value => value.trim().length > 0 && value === value.trim(), 'Text must be nonblank and trimmed.')

// ---------------------------------------------------------------------------------------------
// Request: the browser's unsaved draft plus the scoped conversation.

export const rubricAssistDraftCitationSchema = z.strictObject({
  paragraphId: identifier,
  quote: z.string().max(L.maxDraftQuoteCharacters),
})

/** A draft criterion may be incomplete; the reviewer can be mid-edit. */
export const rubricAssistDraftCriterionSchema = z.strictObject({
  id: identifier,
  label: z.string().max(L.maxDraftLabelCharacters),
  description: z.string().max(L.maxDraftCriterionDescriptionCharacters),
  guidance: z.string().max(L.maxDraftGuidanceCharacters),
  /** Null when the weight input is empty or not a number. */
  weight: z.number().nullable(),
  requirementType: requirementType.nullable(),
  /** The primary citation only; additional saved citations are preserved by the browser. */
  citation: rubricAssistDraftCitationSchema.nullable(),
})
export type RubricAssistDraftCriterion = z.infer<typeof rubricAssistDraftCriterionSchema>

export const rubricAssistDraftSchema = z.strictObject({
  name: z.string().max(L.maxDraftNameCharacters),
  description: z.string().max(L.maxDraftDescriptionCharacters),
  criteria: z.array(rubricAssistDraftCriterionSchema).max(L.maxCriteria),
}).superRefine((draft, ctx) => {
  const ids = new Set<string>()
  draft.criteria.forEach((criterion, index) => {
    if (ids.has(criterion.id)) ctx.addIssue({ code: 'custom', path: ['criteria', index, 'id'], message: 'Draft criterion IDs must be unique.' })
    ids.add(criterion.id)
  })
  if (JSON.stringify(draft).length > L.maxDraftSerializedCharacters) {
    ctx.addIssue({ code: 'custom', path: [], message: 'This draft is too large for the assistant. Nothing was truncated.' })
  }
})
export type RubricAssistDraft = z.infer<typeof rubricAssistDraftSchema>

export const rubricAssistRequestSchema = z.strictObject({
  submissionId: assistSubmissionIdSchema,
  /** The saved version the editor opened. A newer saved version returns 409. */
  base: z.strictObject({ rubricId: identifier, version: z.number().int().min(1) }),
  instruction: assistInstructionSchema,
  conversation: assistConversationSchema,
  focusCriterionId: identifier.nullable(),
  draft: rubricAssistDraftSchema,
}).superRefine((request, ctx) => {
  if (request.focusCriterionId !== null && !request.draft.criteria.some(criterion => criterion.id === request.focusCriterionId)) {
    ctx.addIssue({ code: 'custom', path: ['focusCriterionId'], message: 'The focused criterion is not in the draft.' })
  }
})
export type RubricAssistRequest = z.infer<typeof rubricAssistRequestSchema>

// ---------------------------------------------------------------------------------------------
// Response: validated operations. Citations are always built by the server from the parsed
// source paragraph; the model never supplies document identities, pages or headings.

export const rubricAssistCitationSchema = z.strictObject({
  documentId: identifier,
  documentVersion: z.number().int().min(1),
  paragraphId: identifier,
  page: z.number().int().min(0),
  heading: z.string().max(2_000),
  quote: writtenText(L.maxWrittenQuoteCharacters),
})

export const rubricCriterionChangesSchema = z.strictObject({
  label: writtenText(L.maxWrittenLabelCharacters).optional(),
  description: writtenText(L.maxWrittenCriterionDescriptionCharacters).optional(),
  guidance: writtenText(L.maxWrittenGuidanceCharacters).optional(),
  weight: z.number().int().min(1).max(100).optional(),
  requirementType: requirementType.optional(),
  citation: rubricAssistCitationSchema.optional(),
}).refine(changes => Object.values(changes).some(value => value !== undefined), 'An update must change at least one field.')
export type RubricCriterionChanges = z.infer<typeof rubricCriterionChangesSchema>

export const rubricAssistAddedCriterionSchema = z.strictObject({
  id: z.uuid(),
  key: z.literal('custom'),
  label: writtenText(L.maxWrittenLabelCharacters),
  description: writtenText(L.maxWrittenCriterionDescriptionCharacters),
  guidance: writtenText(L.maxWrittenGuidanceCharacters),
  weight: z.number().int().min(1).max(100),
  requirementType,
  sourceParagraphId: identifier,
  sourceCitations: z.array(rubricAssistCitationSchema).length(1),
}).refine(criterion => criterion.sourceCitations[0]?.paragraphId === criterion.sourceParagraphId,
  'The source paragraph must match the criterion citation.')

export const rubricAssistOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('updateRubric'),
    name: writtenText(L.maxWrittenNameCharacters).optional(),
    description: writtenText(L.maxWrittenDescriptionCharacters).optional(),
  }),
  z.strictObject({ type: z.literal('updateCriterion'), criterionId: identifier, changes: rubricCriterionChangesSchema }),
  /** `afterCriterionId: null` appends the new criterion at the end. */
  z.strictObject({ type: z.literal('addCriterion'), afterCriterionId: identifier.nullable(), criterion: rubricAssistAddedCriterionSchema }),
  z.strictObject({ type: z.literal('removeCriterion'), criterionId: identifier }),
]).superRefine((operation, ctx) => {
  if (operation.type === 'updateRubric' && operation.name === undefined && operation.description === undefined) {
    ctx.addIssue({ code: 'custom', path: [], message: 'A rubric update must change its name or description.' })
  }
})
export type RubricAssistOperation = z.infer<typeof rubricAssistOperationSchema>

export const rubricAssistResponseSchema = assistResponseSchema(rubricAssistOperationSchema)
export type RubricAssistResponse = AssistResponse<RubricAssistOperation>

// ---------------------------------------------------------------------------------------------
// Field keys shared by change tracking, attribution and highlighting.

export const RUBRIC_CRITERION_FIELDS = ['label', 'description', 'guidance', 'weight', 'requirementType', 'citation'] as const
export type RubricCriterionField = typeof RUBRIC_CRITERION_FIELDS[number]
export const RUBRIC_NAME_KEY = 'rubric.name'
export const RUBRIC_DESCRIPTION_KEY = 'rubric.description'

/** Key for one editable field of one criterion. */
export function criterionFieldKey(criterionId: string, field: RubricCriterionField): string {
  return `criterion:${criterionId}:${field}`
}

/** Key for a criterion's presence (added or removed). */
export function criterionPresenceKey(criterionId: string): string {
  return `criterion:${criterionId}`
}

/** Every field key an operation writes, for attribution. */
export function rubricAssistOperationFieldKeys(operation: RubricAssistOperation): string[] {
  switch (operation.type) {
    case 'updateRubric':
      return [
        ...(operation.name !== undefined ? [RUBRIC_NAME_KEY] : []),
        ...(operation.description !== undefined ? [RUBRIC_DESCRIPTION_KEY] : []),
      ]
    case 'updateCriterion':
      return RUBRIC_CRITERION_FIELDS.filter(field => operation.changes[field] !== undefined)
        .map(field => criterionFieldKey(operation.criterionId, field))
    case 'addCriterion':
      return [criterionPresenceKey(operation.criterion.id), ...RUBRIC_CRITERION_FIELDS.map(field => criterionFieldKey(operation.criterion.id, field))]
    case 'removeCriterion':
      return [criterionPresenceKey(operation.criterionId)]
  }
}

// ---------------------------------------------------------------------------------------------
// Conversions.

/** The draft wire shape for an editor draft. Non-finite weights become null. */
export function toRubricAssistDraft(rubric: Pick<Rubric, 'name' | 'description' | 'criteria'>): RubricAssistDraft {
  return {
    name: rubric.name,
    description: rubric.description,
    criteria: rubric.criteria.map(criterion => {
      const citation = criterion.sourceCitations?.[0]
      return {
        id: criterion.id,
        label: criterion.label,
        description: criterion.description,
        guidance: criterion.guidance,
        weight: Number.isFinite(criterion.weight) ? criterion.weight : null,
        requirementType: criterion.requirementType ?? null,
        citation: citation ? { paragraphId: citation.paragraphId, quote: citation.quote } : null,
      }
    }),
  }
}

export interface RubricAssistTarget {
  name: string
  description: string
  criteria: Criterion[]
}

export class RubricAssistApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RubricAssistApplyError'
  }
}

function cloneCitation(citation: Citation): Citation {
  return { ...citation }
}

/**
 * Applies validated operations in order and returns a new draft. Throws, applying nothing, when
 * an operation targets a criterion the draft no longer has, so a stale response is never merged.
 * The criterion's primary citation is replaced; any additional citations are preserved.
 */
export function applyRubricAssistOperations<T extends RubricAssistTarget>(target: T, operations: readonly RubricAssistOperation[]): T {
  let name = target.name
  let description = target.description
  const criteria: Criterion[] = target.criteria.map(criterion => ({
    ...criterion,
    ...(criterion.sourceCitations ? { sourceCitations: criterion.sourceCitations.map(cloneCitation) } : {}),
  }))
  const indexOf = (id: string) => {
    const index = criteria.findIndex(criterion => criterion.id === id)
    if (index < 0) throw new RubricAssistApplyError('The draft changed since the assistant read it. No changes were applied.')
    return index
  }
  for (const operation of operations) {
    switch (operation.type) {
      case 'updateRubric':
        if (operation.name !== undefined) name = operation.name
        if (operation.description !== undefined) description = operation.description
        break
      case 'updateCriterion': {
        const index = indexOf(operation.criterionId)
        const current = criteria[index]
        const { citation, ...fields } = operation.changes
        const next: Criterion = { ...current }
        for (const [field, value] of Object.entries(fields) as [keyof typeof fields, unknown][]) {
          if (value !== undefined) (next as unknown as Record<string, unknown>)[field] = value
        }
        if (citation) {
          next.sourceParagraphId = citation.paragraphId
          next.sourceCitations = [cloneCitation(citation), ...(current.sourceCitations ?? []).slice(1)]
        }
        criteria[index] = next
        break
      }
      case 'addCriterion': {
        if (criteria.some(criterion => criterion.id === operation.criterion.id)) {
          throw new RubricAssistApplyError('The assistant proposed a duplicate criterion. No changes were applied.')
        }
        const position = operation.afterCriterionId === null ? criteria.length : indexOf(operation.afterCriterionId) + 1
        criteria.splice(position, 0, { ...operation.criterion, sourceCitations: operation.criterion.sourceCitations.map(cloneCitation) })
        break
      }
      case 'removeCriterion':
        criteria.splice(indexOf(operation.criterionId), 1)
        break
    }
  }
  return { ...target, name, description, criteria }
}
