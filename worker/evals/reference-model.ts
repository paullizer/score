import { z } from 'zod'
import {
  ANALYSIS_COMPILED_PROMPTS, invokeAnalysisModel, type AnalysisAssessmentOptions,
} from '../analyses/model'
import {
  validateAnalysisAssessmentInput, validateAnalysisAssessmentSelections,
  calculateAnalysisSummary, hashAnalysisAssessment,
  AnalysisModelError,
} from '../analyses/validation'
import { createAnalysisEvidenceCatalog } from '../analyses/evidence-passages'
import { assessmentSelectionSchemaForInput, analysisStructuredSchema } from '../analyses/model-schema'
import { resolveAcceptedPrompt } from '../prompts'
import { systemClock } from '../clock'
import { evaluationHash } from './statistics'
import { scoringSuiteSchema, validateReferenceSet } from './contracts'

export const SOURCE_REFERENCE_VERSION = 'score-source-reference-v1'

export async function assessSourceOnlyReference(rawInput: unknown, options: AnalysisAssessmentOptions) {
  const input = validateAnalysisAssessmentInput(rawInput)
  const settings = options.model.processingSettings
  if (!settings) throw new Error('Reference generation requires frozen settings.')
  const catalog = createAnalysisEvidenceCatalog(input.resume)
  const source = { ...input, resume: catalog.resume }
  const policy = resolveAcceptedPrompt(settings, 'assessment', ANALYSIS_COMPILED_PROMPTS.assessment).system
  const response = await invokeAnalysisModel({
    name: 'source_only_reference', schema: analysisStructuredSchema(assessmentSelectionSchemaForInput(input, catalog.passages.length)),
    system: `${policy}
This is a separately prompted reference-labeling experiment, not a production assessment or review.
No other model scores, rationales, human labels or review verdicts are supplied. Read the complete source independently.
For each saved criterion, identify direct, partial, absent and contradictory evidence before assigning its saved anchor.
Check both under-credit and over-credit; do not prefer a midpoint, a higher score or a harsher score.
Keep ambiguous documentary interpretations explicitly unresolved when the saved anchors cannot safely distinguish them.
Return only the strict supplied schema. The result is a provisional model reference, not human ground truth.`,
    user: JSON.stringify({ input: source }), source: JSON.stringify(source),
    taskId: 'assessmentReview', operation: 'analysis',
  }, 'assessment', options, options.clock ?? systemClock, 0, {
    promptVersion: SOURCE_REFERENCE_VERSION, schemaVersion: SOURCE_REFERENCE_VERSION,
  })
  let raw: unknown
  try { raw = JSON.parse(response.content) } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new AnalysisModelError('invalid-model-output', 'The reference model returned invalid JSON.', { stage: 'assessment' })
  }
  const assessment = validateAnalysisAssessmentSelections(raw, input, catalog)
  options.signal?.throwIfAborted()
  return {
    assessment, summary: calculateAnalysisSummary(input.rubric, assessment),
    assessmentProvenance: response.provenance, groundingReviews: [], correctionCount: 0,
    assessmentSha256: hashAnalysisAssessment(assessment),
    referenceExposure: {
      version: SOURCE_REFERENCE_VERSION, inputSha256: evaluationHash(input),
      sourceOnly: true as const, modelOpinionsSupplied: false as const,
    },
  }
}

export function exportSourceOnlyReferences(
  rawSuite: unknown, rawTargets: unknown, configurationId: string, rawResults: unknown,
) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  const configuration = suite.configurations.find(row => row.id === configurationId)
  if (configuration?.algorithmVersion !== SOURCE_REFERENCE_VERSION || suite.repetitions !== 1) {
    throw new Error('Source-only references require a single, prespecified frozen generation per case.')
  }
  const targets = z.array(z.strictObject({
    id: z.string().min(1).max(320), caseId: z.string().min(1).max(160), criterionId: z.string().min(1).max(160),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/), inclusionProbability: z.number().positive().max(1).nullable(),
  })).min(1).max(10_000).parse(rawTargets)
  const results = z.array(z.strictObject({
    caseId: z.string().min(1).max(160),
    result: z.object({
      referenceExposure: z.strictObject({
        version: z.literal(SOURCE_REFERENCE_VERSION), inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sourceOnly: z.literal(true), modelOpinionsSupplied: z.literal(false),
      }),
      assessment: z.object({
        criteria: z.array(z.object({
          criterionId: z.string(), score: z.number().int().min(0).max(5).nullable(),
          rationale: z.string().min(1).max(2000), citations: z.array(z.unknown()).max(8),
        })),
      }),
      assessmentProvenance: z.object({
        model: z.string().min(1).max(300),
        promptVersion: z.literal(SOURCE_REFERENCE_VERSION),
        schemaVersion: z.literal(SOURCE_REFERENCE_VERSION),
      }),
    }),
  })).max(500).parse(rawResults)
  if (new Set(results.map(row => row.caseId)).size !== results.length ||
    new Set(targets.map(row => row.id)).size !== targets.length) throw new Error('Reference results and targets must be unique.')
  for (const row of results) {
    const item = suite.cases.find(item => item.id === row.caseId)
    if (!item || item.inputSha256 !== row.result.referenceExposure.inputSha256 ||
      row.result.assessment.criteria.length !== item.criterionIds.length ||
      new Set(row.result.assessment.criteria.map(row => row.criterionId)).size !== item.criterionIds.length ||
      row.result.assessment.criteria.some(row => !item.criterionIds.includes(row.criterionId))) {
      throw new Error('Source-only result must match its exact frozen source and criterion coverage.')
    }
  }
  const references = validateReferenceSet(suite, targets.map(target => {
    const saved = results.find(row => row.caseId === target.caseId)?.result
    const row = saved?.assessment.criteria.find(row => row.criterionId === target.criterionId)
    return {
      schemaVersion: 1 as const, id: `source-ref-${evaluationHash(target.id)}`, caseId: target.caseId,
      criterionId: target.criterionId, inputSha256: target.inputSha256, origin: 'model-assisted' as const,
      author: `source-producer-${evaluationHash(configuration)}`, independent: true,
      score: row?.score ?? null,
      reason: row?.rationale ?? 'Unresolved: no valid source-only reference result.',
      evidenceFactIds: [], inclusionProbability: target.inclusionProbability,
    }
  }))
  return {
    schemaVersion: 1 as const, references, configuration, suiteSha256: evaluationHash(suite),
    rawResultsSha256: evaluationHash(rawResults),
    provenance: results.map(row => ({
      caseId: row.caseId, parsedReferenceSha256: evaluationHash(row.result),
      actualModel: row.result.assessmentProvenance.model,
      exposure: row.result.referenceExposure,
    })),
    limitations: [
      'Independent means no scorer/human outputs were supplied; it does not imply statistical independence between models.',
      'These are provisional AI references, not human truth or judge qualification.',
      'Missing/failed cases remain unresolved; inspect frozen private results for exact evidence and rationale.',
    ],
  }
}
