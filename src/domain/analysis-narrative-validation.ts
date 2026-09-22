import { z } from 'zod'
import {
  ANALYSIS_NARRATIVE_LIMITS,
  type AnalysisCandidateNarrativeModelInput,
  type AnalysisCandidateNarrativeModelOutput,
  type AnalysisNarrativeClaim,
  type AnalysisNarrativeClaimLocation,
  type AnalysisNarrativeEvidenceReference,
  type AnalysisNarrativeGroundingReviewOutput,
  type AnalysisNarrativeWorkHealth,
  type AnalysisTargetNarrativeModelInput,
  type AnalysisTargetNarrativeModelOutput,
} from './analysis-narratives'
import type { RealAnalysisComparisonStatus, RealAnalysisResult } from './real-analyses'

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
const claimId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/)
const text = (maximum: number) => z.string().min(1).max(maximum).regex(/\S/)
const index = z.number().int().min(0)
const workHealthTimestamp = z.iso.datetime({ offset: true }).max(40)

export const analysisNarrativeWorkHealthSchema: z.ZodType<AnalysisNarrativeWorkHealth> = z.strictObject({
  state: z.enum(['waiting-prerequisites', 'awaiting-worker', 'retry-scheduled', 'throttled', 'running', 'interrupted', 'failed', 'inactive']),
  requestedAt: workHealthTimestamp,
  lastActivityAt: workHealthTimestamp,
  leaseExpiresAt: workHealthTimestamp.nullable(),
  attempt: z.number().int().min(0).max(ANALYSIS_NARRATIVE_LIMITS.maxAutomaticAttempts),
  nextEligibleAt: workHealthTimestamp.nullable(),
  capturedSettings: z.strictObject({
    revision: identifier,
    modelName: text(200).nullable(),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).nullable(),
  }),
}).refine(value => !['running', 'interrupted'].includes(value.state) ||
  value.leaseExpiresAt !== null && value.attempt > 0, 'Claimed work requires its lease and attempt.')
  .refine(value => !['awaiting-worker', 'retry-scheduled', 'throttled'].includes(value.state) ||
    value.nextEligibleAt !== null, 'Queued work requires its eligibility time.')

export const narrativeEvidenceReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('criterion'), comparisonId: identifier, criterionId: identifier }),
  z.strictObject({ kind: z.literal('qualification'), comparisonId: identifier, qualificationId: identifier }),
  z.strictObject({ kind: z.literal('limitation'), comparisonId: identifier, limitationIndex: index }),
  z.strictObject({ kind: z.literal('coverage'), comparisonId: identifier }),
  z.strictObject({ kind: z.literal('overall'), comparisonId: identifier }),
  z.strictObject({ kind: z.literal('status'), comparisonId: identifier }),
])

const references = z.array(narrativeEvidenceReferenceSchema).min(1).max(ANALYSIS_NARRATIVE_LIMITS.maxReferencesPerClaim)
const candidateLocation = z.strictObject({ field: z.enum(['text', 'overview']), sentenceIndex: index })
const targetLocation = z.strictObject({ field: z.literal('paragraphs'), paragraphIndex: index, sentenceIndex: index })
const claim = z.strictObject({
  id: claimId,
  location: z.union([candidateLocation, targetLocation]),
  references,
})

export const candidateNarrativeOutputSchema = z.strictObject({
  text: text(ANALYSIS_NARRATIVE_LIMITS.candidateMaxCharacters),
  overview: text(ANALYSIS_NARRATIVE_LIMITS.overviewMaxCharacters),
  claims: z.array(claim.extend({ location: candidateLocation })).min(4).max(5),
})

export const targetNarrativeOutputSchema = z.strictObject({
  paragraphs: z.array(text(ANALYSIS_NARRATIVE_LIMITS.targetParagraphMaxCharacters))
    .min(ANALYSIS_NARRATIVE_LIMITS.targetMinParagraphs).max(ANALYSIS_NARRATIVE_LIMITS.targetMaxParagraphs),
  claims: z.array(claim.extend({ location: targetLocation })).min(1).max(ANALYSIS_NARRATIVE_LIMITS.maxClaims),
})

export const NARRATIVE_GROUNDING_ISSUE_CODES = [
  'unsupported-claim', 'omitted-evidence', 'misleading-status', 'prohibited-judgment',
  'unsupported-number', 'invalid-reference', 'insufficient-context', 'prompt-injection',
  'incomplete-coverage', 'unjustified-limitation',
] as const

export const narrativeGroundingReviewOutputSchema = z.strictObject({
  outcome: z.enum(['supported', 'needs-correction', 'unsupported']),
  issues: z.array(z.strictObject({
    code: z.enum(NARRATIVE_GROUNDING_ISSUE_CODES),
    message: text(1_200),
    claimId: claimId.optional(),
    references: references.min(0),
  })).max(32),
})

export class AnalysisNarrativeValidationError extends Error {
  constructor(readonly code: 'invalid-model-output' | 'invalid-citation', message: string) {
    super(message)
    this.name = 'AnalysisNarrativeValidationError'
  }
}

export interface AnalysisNarrativeEvidenceContext {
  comparisons: readonly {
    comparisonId: string
    status: RealAnalysisComparisonStatus
    result: RealAnalysisResult | null
  }[]
  grade?: string
}

export function narrativeEvidenceContext(
  input: AnalysisCandidateNarrativeModelInput | AnalysisTargetNarrativeModelInput,
): AnalysisNarrativeEvidenceContext {
  if ('source' in input) return {
    comparisons: [{ comparisonId: input.binding.comparisonId, status: 'complete', result: input.result }],
    ...(input.source.rubric.kind === 'grade' ? { grade: input.source.rubric.grade } : {}),
  }
  const candidates = new Map(input.candidates.map(candidate => [candidate.binding.comparisonId, candidate.result]))
  return {
    comparisons: input.binding.comparisons.map(comparison => ({
      comparisonId: comparison.comparisonId, status: comparison.status,
      result: candidates.get(comparison.comparisonId) ?? null,
    })),
    ...(input.target.rubric.kind === 'grade' ? { grade: input.target.rubric.grade } : {}),
  }
}

function invalid(message: string, citation = false): never {
  throw new AnalysisNarrativeValidationError(citation ? 'invalid-citation' : 'invalid-model-output', message)
}

export function narrativeReferenceKey(reference: AnalysisNarrativeEvidenceReference): string {
  return JSON.stringify([
    reference.comparisonId, reference.kind,
    reference.kind === 'criterion' ? reference.criterionId :
      reference.kind === 'qualification' ? reference.qualificationId :
        reference.kind === 'limitation' ? reference.limitationIndex : null,
  ])
}

export function validateNarrativeEvidenceReferences(
  value: unknown, context: AnalysisNarrativeEvidenceContext,
): AnalysisNarrativeEvidenceReference[] {
  const parsed = references.min(0).safeParse(value)
  if (!parsed.success) invalid('Narrative references must use the bounded saved-evidence schema.', true)
  const comparisons = new Map(context.comparisons.map(comparison => [comparison.comparisonId, comparison]))
  if (comparisons.size !== context.comparisons.length) invalid('Narrative evidence contains duplicate comparison identities.', true)
  const seen = new Set<string>()
  for (const reference of parsed.data) {
    const key = narrativeReferenceKey(reference)
    if (seen.has(key)) invalid('A narrative claim cannot repeat an evidence reference.', true)
    seen.add(key)
    const comparison = comparisons.get(reference.comparisonId)
    if (!comparison) invalid('A narrative reference belongs to an unknown comparison.', true)
    if (reference.kind === 'status') continue
    const result = comparison.result
    if (comparison.status !== 'complete' || !result) {
      invalid('An unassessed comparison permits only status references, never evidence or scores.', true)
    }
    if (reference.kind === 'criterion' && !result.criteria.some(row => row.criterionId === reference.criterionId) ||
      reference.kind === 'qualification' && !result.qualifications.some(row => row.qualificationId === reference.qualificationId) ||
      reference.kind === 'limitation' && reference.limitationIndex >= result.limitations.length) {
      invalid('A narrative reference is outside the exact saved assessment evidence.', true)
    }
  }
  return parsed.data
}

export function normalizeNarrativeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

// A deterministic English prose boundary is shared by generation, persistence and presentation.
export function narrativeSentences(value: string): string[] {
  const normalized = normalizeNarrativeText(value)
  if (!normalized) return []
  const sentences: string[] = []
  let start = 0
  for (let at = 0; at < normalized.length; at++) {
    if (!/[.!?]/.test(normalized[at])) continue
    let end = at + 1
    while (end < normalized.length && /["'\u2019\u201d)]/.test(normalized[end])) end++
    if (end < normalized.length && normalized[end] !== ' ') continue
    if (normalized[at] === '.' && end < normalized.length) {
      const before = normalized.slice(start, at + 1)
      if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|approx|e\.g|i\.e)\.$/i.test(before) ||
        /\b(?:[A-Za-z]\.){2,}$/.test(before)) continue
    }
    sentences.push(normalized.slice(start, end))
    start = end
    while (normalized[start] === ' ') start++
    at = start - 1
  }
  if (start < normalized.length) sentences.push(normalized.slice(start))
  return sentences
}

export function validateNarrativeProse(value: string): string {
  if ([...value].some(character => /\p{Cc}/u.test(character) && !['\t', '\r', '\n'].includes(character)) ||
    /[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value)) {
    invalid('Narrative prose contains hidden controls instead of plain readable text.')
  }
  const normalized = normalizeNarrativeText(value)
  if (/\.\s*\.\s*\.|\u2026|[<>{}`]|https?:\/\//iu.test(normalized)) {
    invalid('Narratives must be complete plain prose, without ellipses, markup, instructions, or URLs.')
  }
  if (/\b(?:ignore|override|disregard)\b.{0,60}\b(?:instructions?|policy|prompt|schema)\b/i.test(normalized) ||
    /\b(?:system prompt|developer message|tool calls?|as an AI|browse the web)\b/i.test(normalized)) {
    invalid('Source instructions cannot become narrative content.')
  }
  if (/\b\d+(?:\.\d+)?\s*(?:\/|out of)\s*(?:5|100)\b/i.test(normalized) ||
    /\b(?:score[sd]?|rating|rated|points?|percentile)\b.{0,30}\b\d/i.test(normalized) ||
    /\b\d+(?:\.\d+)?\s*(?:points?|percentile|\/\s*100)\b/i.test(normalized) ||
    /\b(?:zero|one|two|three|four|five)\s+(?:out of five|points?)\b/i.test(normalized) ||
    /\b(?:criterion|criteria|evidence)\s*:\s*/i.test(normalized) ||
    /\b(?:\d+|zero|one|two|three|four|five)\s+(?:supported|partial|missing|not assessed|unassessed)\b/i.test(normalized)) {
    invalid('Narratives must explain evidence rather than recite scores or criterion-count boilerplate.')
  }
  if (/\b(?:recommend|recommendation)\b.{0,60}\b(?:hiring|hire|reject|shortlist)\b/i.test(normalized) ||
    /\b(?:hire|reject|shortlist)\s+(?:this|the)\s+(?:candidate|applicant|person)\b/i.test(normalized) ||
    /\b(?:should|must)\s+(?:be\s+)?(?:hired|rejected|shortlisted)\b/i.test(normalized) ||
    /\b(?:candidate|applicant|person|they|he|she)\s+(?:lacks?|cannot|can't|is unable|is incapable)\b/i.test(normalized) ||
    /\b(?:candidate|applicant|person|they|he|she)\s+(?:is|are|meets?)\s+(?:(?:officially|all|the|minimum)\s+)*(?:eligible|ineligible|qualified|unqualified|qualifications|eligibility)\b/i.test(normalized) ||
    /\b(?:best|top|worst|strongest|weakest)\s+(?:candidate|applicant|person)\b/i.test(normalized) ||
    /\b(?:rank(?:ed|ing|s)?|better|worse)\b.{0,60}\b(?:across|other|different|multiple)\s+(?:jobs?|targets?|roles?|grades?)\b/i.test(normalized) ||
    /\b(?:candidate|applicant|person|they|he|she)\s+(?:is|are|appears?|seems?)\s+(?:a\s+)?(?:male|female|pregnant|disabled|young|old|married|single|white|black|Asian|Christian|Muslim|Jewish|gay|straight)\b/i.test(normalized) ||
    /\b(?:context (?:window|limit)|token (?:budget|limit)|model refusal|service unavailable|processing failed)\b/i.test(normalized)) {
    invalid('Narratives describe document evidence, not personal traits, hiring judgments, eligibility, or processing fallbacks.')
  }
  for (const sentence of narrativeSentences(normalized)) {
    if (!/[.!?]["'\u2019\u201d)]*$/u.test(sentence) || (sentence.match(/\p{L}[\p{L}\p{N}'\u2019-]*/gu)?.length ?? 0) < 3) {
      invalid('Each narrative sentence must be complete, meaningful prose with terminal punctuation.')
    }
  }
  return normalized
}

function locationKey(location: AnalysisNarrativeClaimLocation): string {
  return location.field === 'paragraphs'
    ? `paragraphs:${location.paragraphIndex}:${location.sentenceIndex}`
    : `${location.field}:${location.sentenceIndex}`
}

function referenceText(reference: AnalysisNarrativeEvidenceReference, context: AnalysisNarrativeEvidenceContext): string {
  const comparison = context.comparisons.find(row => row.comparisonId === reference.comparisonId)!
  const result = comparison.result
  if (reference.kind === 'status') {
    return String(context.comparisons.filter(row => row.status === comparison.status).length)
  }
  if (!result) return ''
  if (reference.kind === 'limitation') return result.limitations[reference.limitationIndex].message
  if (reference.kind === 'criterion' || reference.kind === 'qualification') {
    const row = reference.kind === 'criterion'
      ? result.criteria.find(row => row.criterionId === reference.criterionId)!
      : result.qualifications.find(row => row.qualificationId === reference.qualificationId)!
    return [row.rationale, ...row.citations.map(citation => citation.quote)].join(' ')
  }
  return reference.kind === 'overall' && result.overall.status === 'withheld' ? result.overall.message : ''
}

export function validateNarrativeClaims(
  claims: readonly AnalysisNarrativeClaim[],
  sentences: readonly { location: AnalysisNarrativeClaimLocation; text: string }[],
  context: AnalysisNarrativeEvidenceContext,
): void {
  if (claims.length !== sentences.length) invalid('Every narrative sentence needs exactly one traceable claim.')
  const locations = new Map(sentences.map(sentence => [locationKey(sentence.location), sentence.text]))
  const seenIds = new Set<string>()
  const seenLocations = new Set<string>()
  for (const claim of claims) {
    const key = locationKey(claim.location)
    if (seenIds.has(claim.id) || seenLocations.has(key) || !locations.has(key)) {
      invalid('Narrative claim identities and sentence locations must be unique and in bounds.')
    }
    seenIds.add(claim.id)
    seenLocations.add(key)
    if (!claim.references.length) invalid('Every narrative sentence needs saved-evidence references.', true)
    validateNarrativeEvidenceReferences(claim.references, context)
    const permittedNumbers = new Set(
      [context.grade ?? '', ...claim.references.map(reference => referenceText(reference, context))]
        .join(' ').match(/\d+(?:\.\d+)?/g) ?? [],
    )
    if ((locations.get(key)!.match(/\d+(?:\.\d+)?/g) ?? []).some(number => !permittedNumbers.has(number))) {
      invalid('A numerical narrative assertion is not present in its referenced document evidence.')
    }
  }
}

export function narrativeRequiredReferences(context: AnalysisNarrativeEvidenceContext): AnalysisNarrativeEvidenceReference[] {
  return context.comparisons.flatMap<AnalysisNarrativeEvidenceReference>(({ comparisonId, status, result }) => {
    if (status !== 'complete' || !result) return [{ kind: 'status' as const, comparisonId }]
    return [
      ...result.criteria.filter(row => row.evidenceStatus !== 'supported').map(row => ({
        kind: 'criterion' as const, comparisonId, criterionId: row.criterionId,
      })),
      ...result.qualifications.map(row => ({
        kind: 'qualification' as const, comparisonId, qualificationId: row.qualificationId,
      })),
      ...result.limitations.map((_, limitationIndex) => ({ kind: 'limitation' as const, comparisonId, limitationIndex })),
      ...(result.overall.status === 'withheld' ? [{ kind: 'overall' as const, comparisonId }] : []),
    ]
  })
}

function requireMaterialEvidence(claims: readonly AnalysisNarrativeClaim[], context: AnalysisNarrativeEvidenceContext): void {
  const included = new Set(claims.flatMap(claim => claim.references.map(narrativeReferenceKey)))
  if (narrativeRequiredReferences(context).some(reference => !included.has(narrativeReferenceKey(reference)))) {
    invalid('The narrative must retain all partial, missing, unassessed and excluded evidence, qualifications, and material limitations.', true)
  }
  for (const comparison of context.comparisons) {
    const references = claims.flatMap(claim => claim.references).filter(reference => reference.comparisonId === comparison.comparisonId)
    if (!references.length) invalid('The target narrative must account for every exact comparison, including unassessed pairs.', true)
    if (comparison.result?.criteria.some(row => row.evidenceStatus === 'supported') &&
      !references.some(reference => reference.kind === 'criterion' &&
        comparison.result?.criteria.some(row => row.criterionId === reference.criterionId && row.evidenceStatus === 'supported'))) {
      invalid('Documented strengths cannot all be replaced by generic coverage statements.', true)
    }
  }
}

export function validateCandidateNarrativeOutput(
  value: unknown, input: AnalysisCandidateNarrativeModelInput,
): AnalysisCandidateNarrativeModelOutput {
  const parsed = candidateNarrativeOutputSchema.safeParse(value)
  if (!parsed.success) invalid('The candidate narrative does not match its strict bounded content and claim schema.')
  const output = {
    ...parsed.data, text: validateNarrativeProse(parsed.data.text), overview: validateNarrativeProse(parsed.data.overview),
  }
  const sentences = narrativeSentences(output.text)
  if (sentences.length < ANALYSIS_NARRATIVE_LIMITS.candidateMinSentences ||
    sentences.length > ANALYSIS_NARRATIVE_LIMITS.candidateMaxSentences ||
    narrativeSentences(output.overview).length !== ANALYSIS_NARRATIVE_LIMITS.overviewSentences) {
    invalid('A candidate narrative needs three or four sentences and a separate single complete overview sentence.')
  }
  const context = narrativeEvidenceContext(input)
  validateNarrativeClaims(output.claims, [
    ...sentences.map((text, sentenceIndex) => ({ text, location: { field: 'text' as const, sentenceIndex } })),
    { text: output.overview, location: { field: 'overview', sentenceIndex: 0 } },
  ], context)
  requireMaterialEvidence(output.claims.filter(claim => claim.location.field === 'text'), context)
  return output
}

export function validateTargetNarrativeOutput(
  value: unknown, input: AnalysisTargetNarrativeModelInput,
): AnalysisTargetNarrativeModelOutput {
  const parsed = targetNarrativeOutputSchema.safeParse(value)
  if (!parsed.success) invalid('The target narrative does not match its strict bounded paragraph and claim schema.')
  const output = { ...parsed.data, paragraphs: parsed.data.paragraphs.map(validateNarrativeProse) }
  if (output.paragraphs.join('\n\n').length > ANALYSIS_NARRATIVE_LIMITS.targetMaxCharacters) {
    invalid('The complete target narrative exceeds its total character budget; text must be rewritten, not clipped.')
  }
  const context = narrativeEvidenceContext(input)
  validateNarrativeClaims(output.claims, output.paragraphs.flatMap((paragraph, paragraphIndex) =>
    narrativeSentences(paragraph).map((text, sentenceIndex) => ({
      text, location: { field: 'paragraphs' as const, paragraphIndex, sentenceIndex },
    }))), context)
  requireMaterialEvidence(output.claims, context)
  return output
}

export function validateNarrativeGroundingReviewOutput(
  value: unknown,
  context: AnalysisNarrativeEvidenceContext,
  output: { claims: readonly Pick<AnalysisNarrativeClaim, 'id'>[] },
): AnalysisNarrativeGroundingReviewOutput {
  const parsed = narrativeGroundingReviewOutputSchema.safeParse(value)
  if (!parsed.success) invalid('The independent narrative review does not match its strict bounded schema.')
  const review = parsed.data
  if (review.outcome === 'supported' ? review.issues.length !== 0 : review.issues.length === 0) {
    invalid('A supported review must have no issues; an unsupported review must explain its findings.')
  }
  const claimIds = new Set(output.claims.map(claim => claim.id))
  const seen = new Set<string>()
  for (const issue of review.issues) {
    if (issue.claimId !== undefined && !claimIds.has(issue.claimId)) invalid('A review issue names an unknown narrative claim.', true)
    validateNarrativeEvidenceReferences(issue.references, context)
    const key = JSON.stringify([issue.code, issue.claimId ?? null, issue.references.map(narrativeReferenceKey).sort()])
    if (seen.has(key)) invalid('The independent review contains duplicate issues.')
    seen.add(key)
  }
  return review
}
