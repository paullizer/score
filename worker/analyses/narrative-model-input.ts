import { z } from 'zod'
import {
  analysisHash, analysisRequirementEvidenceForInput,
} from '../../server/analyses/deterministic'
import { parseAnalysisResult } from '../../server/analyses/validation'
import {
  ANALYSIS_NARRATIVE_LIMITS, analysisTargetNarrativeCanGenerate,
  type AnalysisCandidateNarrativeInputBinding, type AnalysisCandidateNarrativeModelInput,
  type AnalysisNarrativeEvidenceReference, type AnalysisTargetNarrativeModelInput, type AnalysisTargetNarrativeModelOutput,
} from '../../src/domain/analysis-narratives'
import {
  narrativeEvidenceContext, narrativeReferenceKey, narrativeRequiredReferences, narrativeSentences, validateNarrativeProse,
  type AnalysisNarrativeEvidenceContext,
} from '../../src/domain/analysis-narrative-validation'
import type { RealAnalysisAssessmentInput, RealAnalysisResult } from '../../src/domain/real-analyses'
import type { Citation } from '../../src/domain/types'
import { assessmentInputSchema } from './model-schema'
import { ANALYSIS_WEIGHT_TOLERANCE, AnalysisModelError, validateAnalysisAssessmentInput } from './validation'
import { NARRATIVE_MODEL_LIMITS } from './narrative-model-schema'

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const snapshot = z.strictObject({ snapshotId: identifier, sha256: hash })
const bindingBase = {
  workspaceId: identifier, runId: identifier, manifestSha256: hash,
  targetId: identifier, targetSnapshot: snapshot,
}
const candidateBindingSchema = z.strictObject({
  kind: z.literal('candidate'), ...bindingBase,
  comparisonId: identifier, resumeSnapshot: snapshot, resultSha256: hash,
})
const publication = z.strictObject({
  revision: hash, inputFingerprint: hash, generationId: identifier, publishedAt: z.iso.datetime(),
})
const targetBindingSchema = z.strictObject({
  kind: z.literal('target'), ...bindingBase,
  comparisons: z.array(z.strictObject({
    comparisonId: identifier, status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']),
    resumeSnapshot: snapshot, resultSha256: hash.nullable(), candidateInputFingerprint: hash.nullable(),
    narrative: z.strictObject({
      status: z.enum(['waiting', 'queued', 'running', 'ready', 'failed', 'cancelled', 'missing', 'stale', 'not-required']),
      generationId: identifier.nullable(), inputFingerprint: hash.nullable(),
      published: publication.nullable().optional(),
    }).nullable(),
  })).min(1).max(ANALYSIS_NARRATIVE_LIMITS.maxComparisons),
})
const publishedCandidate = publication.extend({
  dataKind: z.literal('real'),
  text: z.string().min(1).max(ANALYSIS_NARRATIVE_LIMITS.candidateMaxCharacters),
  overview: z.string().min(1).max(ANALYSIS_NARRATIVE_LIMITS.overviewMaxCharacters),
})

export class NarrativeInputError extends Error {
  constructor(readonly code: 'invalid-input' | 'stale-input' | 'context-limit', message: string) {
    super(message)
    this.name = 'NarrativeInputError'
  }
}

function invalid(message: string, stale = false): never {
  throw new NarrativeInputError(stale ? 'stale-input' : 'invalid-input', message)
}

export function narrativeJsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) invalid('Narrative inputs must be complete JSON values.')
    return Buffer.byteLength(serialized, 'utf8')
  } catch (error) {
    if (error instanceof NarrativeInputError) throw error
    invalid('Narrative inputs must be bounded JSON without cycles or unsupported values.')
  }
}

function boundCorpus(value: unknown): void {
  if (narrativeJsonBytes(value) > NARRATIVE_MODEL_LIMITS.maxCorpusBytes) {
    throw new NarrativeInputError('context-limit', 'The complete narrative corpus exceeds the supported byte budget; no comparisons were omitted.')
  }
}

function checkFingerprint(value: string, binding: object): void {
  if (!hash.safeParse(value).success || analysisHash(binding) !== value) {
    invalid('The narrative fingerprint does not match the exact frozen input binding.', true)
  }
}

function validateTarget(value: unknown): Omit<RealAnalysisAssessmentInput, 'resume'> {
  const parsed = assessmentInputSchema.omit({ resume: true }).safeParse(value)
  if (!parsed.success) invalid('Narratives require the complete exact saved rubric and requirement evidence.')
  const target = parsed.data
  const criteria = target.rubric.criteria
  if (new Set(criteria.map(row => row.id)).size !== criteria.length ||
    new Set(target.qualifications.map(row => row.id)).size !== target.qualifications.length ||
    Math.abs(criteria.reduce((total, row) => total + row.weight, 0) - 100) > ANALYSIS_WEIGHT_TOLERANCE ||
    !Number.isFinite(Date.parse(target.rubric.createdAt)) ||
    target.rubric.kind === 'job' && target.qualifications.length ||
    target.rubric.kind === 'grade' && (target.rubric.criteria.some(row =>
      row.support === 'gap' || row.support === 'not-applicable' && (row.weight !== 0 || row.gradeBasis.length !== 0)) ||
      target.qualifications.some(row => row.support === 'gap'))) {
    invalid('Narratives require an unchanged valid rubric with complete, unique, approved requirements.')
  }
  const expected = analysisRequirementEvidenceForInput(target)
  if (expected.some(row => !row.citations.length) || analysisHash(expected) !== analysisHash(target.requirementEvidence)) {
    invalid('Narratives require every exact frozen criterion and qualification citation.')
  }
  return target
}

function citationIsExact(citation: Citation, source: RealAnalysisAssessmentInput): boolean {
  const paragraph = source.resume.paragraphs.find(row => row.id === citation.paragraphId)
  return citation.documentId === source.resume.id && citation.documentVersion === source.resume.version &&
    Boolean(paragraph && paragraph.page === citation.page && paragraph.heading === citation.heading &&
      citation.quote.trim() && paragraph.text.includes(citation.quote))
}

function validateResult(
  value: unknown, binding: AnalysisCandidateNarrativeInputBinding,
  target: Omit<RealAnalysisAssessmentInput, 'resume'>, source?: RealAnalysisAssessmentInput,
): RealAnalysisResult {
  let result: RealAnalysisResult
  try {
    result = parseAnalysisResult(value)
  } catch {
    invalid('A narrative requires an intact completed assessment with supported independent review and unchanged calculations.')
  }
  const provenance = result.provenance
  if (result.workspaceId !== binding.workspaceId || result.runId !== binding.runId || result.comparisonId !== binding.comparisonId ||
    provenance.manifestSha256 !== binding.manifestSha256 ||
    analysisHash(provenance.resumeSnapshot) !== analysisHash(binding.resumeSnapshot) ||
    analysisHash(provenance.targetSnapshot) !== analysisHash(binding.targetSnapshot)) {
    invalid('The completed assessment belongs to different frozen narrative inputs.', true)
  }
  if (result.criteria.length !== target.rubric.criteria.length || result.qualifications.length !== target.qualifications.length ||
    result.criteria.some(row => !target.rubric.criteria.some(criterion =>
      criterion.id === row.criterionId && criterion.weight === row.weight &&
      (row.evidenceStatus === 'not-applicable') === ('support' in criterion && criterion.support === 'not-applicable'))) ||
    result.qualifications.some(row => !target.qualifications.some(qualification => qualification.id === row.qualificationId))) {
    invalid('The completed assessment does not preserve the exact saved requirements and exclusions.', true)
  }
  for (const row of [...result.criteria, ...result.qualifications]) {
    const requirement = target.requirementEvidence.find(requirement => 'criterionId' in row
      ? requirement.kind === 'criterion' && requirement.criterionId === row.criterionId
      : requirement.kind === 'qualification' && requirement.qualificationId === row.qualificationId)
    if (!requirement || analysisHash(row.requirementCitations) !== analysisHash(requirement.citations) ||
      source && row.citations.some(citation => !citationIsExact(citation, source)) ||
      row.evidenceStatus === 'not-assessed' && (!row.limitation ||
        ('criterionId' in row ? row.limitation.criterionId !== row.criterionId : row.limitation.qualificationId !== row.qualificationId))) {
      invalid('Narrative evidence must remain bound to its exact saved source passages and requirements.', true)
    }
  }
  if (result.limitations.some(limitation =>
    limitation.criterionId && !result.criteria.some(row => row.criterionId === limitation.criterionId) ||
    limitation.qualificationId && !result.qualifications.some(row => row.qualificationId === limitation.qualificationId))) {
    invalid('A saved limitation belongs to an unknown narrative requirement.', true)
  }
  return result
}

export function validateCandidateNarrativeInput(value: AnalysisCandidateNarrativeModelInput): AnalysisCandidateNarrativeModelInput {
  boundCorpus(value)
  const binding = candidateBindingSchema.safeParse(value?.binding)
  if (!binding.success) invalid('The candidate narrative requires its exact immutable snapshot and result bindings.')
  checkFingerprint(value.inputFingerprint, binding.data)
  let source: RealAnalysisAssessmentInput
  try {
    source = validateAnalysisAssessmentInput(value.source)
  } catch (error) {
    if (error instanceof AnalysisModelError && error.code === 'context-limit') {
      throw new NarrativeInputError('context-limit', 'The complete frozen source exceeds the supported narrative context; no source sections were omitted.')
    }
    invalid('The candidate narrative requires the complete validated frozen resume, rubric, and requirement evidence.')
  }
  return {
    binding: binding.data, inputFingerprint: value.inputFingerprint, source,
    result: validateResult(value.result, binding.data, source, source),
  }
}

export function validateTargetNarrativeInput(value: AnalysisTargetNarrativeModelInput): AnalysisTargetNarrativeModelInput {
  boundCorpus(value)
  const binding = targetBindingSchema.safeParse(value?.binding)
  if (!binding.success || !Array.isArray(value?.candidates)) invalid('The target narrative requires a complete bounded comparison manifest.')
  checkFingerprint(value.inputFingerprint, binding.data)
  const comparisons = binding.data.comparisons
  if (comparisons.some((row, index) => index > 0 && comparisons[index - 1].comparisonId >= row.comparisonId) ||
    !analysisTargetNarrativeCanGenerate(binding.data, comparisons.map(row => row.comparisonId))) {
    invalid('Every target comparison must be unique, sorted, settled, and bound to its current ready candidate generation.', true)
  }
  const target = validateTarget(value.target)
  const completed = new Map(comparisons.filter(row => row.status === 'complete').map(row => [row.comparisonId, row]))
  if (value.candidates.length !== completed.size) invalid('Target synthesis requires every completed comparison exactly once.', true)
  const seen = new Set<string>()
  const candidates = value.candidates.map(candidate => {
    const parsed = candidateBindingSchema.safeParse(candidate?.binding)
    const narrative = publishedCandidate.safeParse(candidate?.narrative)
    if (!parsed.success || !narrative.success) invalid('A target candidate is missing its exact saved narrative publication.', true)
    const candidateBinding = parsed.data
    const member = completed.get(candidateBinding.comparisonId)
    if (!member || seen.has(candidateBinding.comparisonId)) invalid('Target synthesis contains a duplicate or foreign candidate.', true)
    seen.add(candidateBinding.comparisonId)
    const expected = {
      kind: 'candidate' as const, ...bindingBaseValues(binding.data),
      comparisonId: member.comparisonId, resumeSnapshot: member.resumeSnapshot, resultSha256: member.resultSha256,
    }
    const published = member.narrative!.published!
    try {
      const sentences = narrativeSentences(validateNarrativeProse(narrative.data.text))
      if (sentences.length < ANALYSIS_NARRATIVE_LIMITS.candidateMinSentences ||
        sentences.length > ANALYSIS_NARRATIVE_LIMITS.candidateMaxSentences ||
        narrativeSentences(validateNarrativeProse(narrative.data.overview)).length !== 1) {
        invalid('A saved candidate narrative does not contain complete bounded narrative prose.', true)
      }
    } catch {
      invalid('A saved candidate narrative does not contain complete bounded narrative prose.', true)
    }
    if (analysisHash(candidateBinding) !== analysisHash(expected) ||
      analysisHash(candidateBinding) !== member.candidateInputFingerprint ||
      narrative.data.inputFingerprint !== member.candidateInputFingerprint ||
      narrative.data.generationId !== member.narrative!.generationId ||
      narrative.data.revision !== published.revision || narrative.data.publishedAt !== published.publishedAt) {
      invalid('A candidate narrative revision, fingerprint, or current generation changed before target synthesis.', true)
    }
    return {
      binding: candidateBinding, narrative: narrative.data,
      result: validateResult(candidate.result, candidateBinding, target),
    }
  })
  const ordered = new Map(candidates.map(candidate => [candidate.binding.comparisonId, candidate]))
  return {
    binding: binding.data, inputFingerprint: value.inputFingerprint, target,
    candidates: comparisons.filter(row => row.status === 'complete').map(row => ordered.get(row.comparisonId)!),
  }
}

function bindingBaseValues(binding: AnalysisTargetNarrativeModelInput['binding']) {
  return {
    workspaceId: binding.workspaceId, runId: binding.runId, manifestSha256: binding.manifestSha256,
    targetId: binding.targetId, targetSnapshot: binding.targetSnapshot,
  }
}

export interface NarrativeEvidenceCatalog {
  context: AnalysisNarrativeEvidenceContext
  entries: { id: number; reference: AnalysisNarrativeEvidenceReference }[]
  byKey: Map<string, number>
  requiredIds: number[]
}

export function createNarrativeEvidenceCatalog(
  input: AnalysisCandidateNarrativeModelInput | AnalysisTargetNarrativeModelInput,
): NarrativeEvidenceCatalog {
  const context = narrativeEvidenceContext(input)
  const entries: NarrativeEvidenceCatalog['entries'] = []
  for (const { comparisonId, result } of context.comparisons) {
    const add = (reference: AnalysisNarrativeEvidenceReference) => entries.push({ id: entries.length + 1, reference })
    add({ kind: 'status', comparisonId })
    if (!result) continue
    for (const row of result.criteria) add({ kind: 'criterion', comparisonId, criterionId: row.criterionId })
    for (const row of result.qualifications) add({ kind: 'qualification', comparisonId, qualificationId: row.qualificationId })
    result.limitations.forEach((_, limitationIndex) => add({ kind: 'limitation', comparisonId, limitationIndex }))
    add({ kind: 'coverage', comparisonId })
    add({ kind: 'overall', comparisonId })
  }
  const byKey = new Map(entries.map(entry => [narrativeReferenceKey(entry.reference), entry.id]))
  return {
    context, entries, byKey,
    requiredIds: narrativeRequiredReferences(context).map(reference => byKey.get(narrativeReferenceKey(reference))!),
  }
}

export function narrativeAssessmentView(result: RealAnalysisResult, catalog: NarrativeEvidenceCatalog) {
  const id = (reference: AnalysisNarrativeEvidenceReference) => catalog.byKey.get(narrativeReferenceKey(reference))!
  const comparisonId = result.comparisonId
  return {
    criteria: result.criteria.map(row => ({
      referenceId: id({ kind: 'criterion', comparisonId, criterionId: row.criterionId }), ...row,
    })),
    qualifications: result.qualifications.map(row => ({
      referenceId: id({ kind: 'qualification', comparisonId, qualificationId: row.qualificationId }), ...row,
    })),
    limitations: result.limitations.map((limitation, limitationIndex) => ({
      referenceId: id({ kind: 'limitation', comparisonId, limitationIndex }), ...limitation,
    })),
    coverage: { referenceId: id({ kind: 'coverage', comparisonId }), value: result.coverage },
    overall: { referenceId: id({ kind: 'overall', comparisonId }), value: result.overall },
    completion: result.completion,
  }
}

export function targetNarrativeReviewView(output: AnalysisTargetNarrativeModelOutput, catalog: NarrativeEvidenceCatalog) {
  const kinds = ['status', 'criterion', 'qualification', 'limitation', 'coverage', 'overall'] as const
  const comparisons = catalog.context.comparisons.map(row => row.comparisonId)
  const criterionIds = [...new Set(catalog.entries.flatMap(entry => entry.reference.kind === 'criterion' ? [entry.reference.criterionId] : []))]
  const qualificationIds = [...new Set(catalog.entries.flatMap(entry => entry.reference.kind === 'qualification' ? [entry.reference.qualificationId] : []))]
  const selectedIds = new Set<number>()
  const claims = output.claims.map(claim => ({
    id: claim.id, location: claim.location,
    referenceIds: claim.references.map(reference => {
      const id = catalog.byKey.get(narrativeReferenceKey(reference))
      if (id === undefined) invalid('The exact reviewed narrative references could not be encoded without loss.')
      selectedIds.add(id)
      return id
    }),
  }))
  const references: [number, number, number, number | null][] = [...selectedIds].map(id => {
    const reference = catalog.entries[id - 1].reference
    return [
      id, comparisons.indexOf(reference.comparisonId), kinds.indexOf(reference.kind),
      reference.kind === 'criterion' ? criterionIds.indexOf(reference.criterionId)
        : reference.kind === 'qualification' ? qualificationIds.indexOf(reference.qualificationId)
          : reference.kind === 'limitation' ? reference.limitationIndex : null,
    ]
  })
  return {
    output: { paragraphs: output.paragraphs, claims },
    referenceEncoding: {
      kind: 'lossless-reference-catalog-v1', comparisons, kinds, criterionIds, qualificationIds, references,
    },
  }
}
