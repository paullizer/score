import { z } from 'zod'
import { calculateAnalysisSummary, validateAnalysisAssessmentForReview } from '../analyses/validation'
import { analysisAssessmentHash } from '../../server/analyses/deterministic'
import { scoringSuiteSchema } from './contracts'
import { evaluationHash, validateObservations } from './statistics'
import { validateEvaluationCaseInput } from './production'
import { evidenceDetectionStatistics } from './metrics'

const id = z.string().min(1).max(160)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const annotationSchema = z.strictObject({
  caseId: id, criterionId: id, inputSha256: hash,
  origin: z.enum(['planted', 'human-reviewed']), author: id, revision: id,
  independent: z.boolean(), reason: z.string().trim().min(1).max(2000),
  facts: z.array(z.strictObject({
    id, role: z.enum(['supporting', 'non-supporting', 'contrary']),
    alternatives: z.array(z.strictObject({
      paragraphId: id, text: z.string().min(1).max(12_000).refine(text => text.trim().length > 0),
    })).min(1).max(20),
  })).min(1).max(100),
})
const artifactSchema = z.strictObject({
  caseId: id, configurationId: id, repetition: z.number().int().min(1).max(12),
  assessmentSha256: hash, assessment: z.unknown(),
})

export function summarizeEvidenceSelections(
  rawSuite: unknown, rawObservations: unknown, rawInputs: unknown, rawAnnotations: unknown, rawArtifacts: unknown,
) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  const observations = validateObservations(suite, rawObservations)
  const inputRows = z.array(z.strictObject({ id, input: z.unknown() })).min(1).max(500).parse(rawInputs)
  if (inputRows.length !== suite.cases.length || new Set(inputRows.map(row => row.id)).size !== inputRows.length) {
    throw new Error('Evidence measurement requires each exact frozen suite input once.')
  }
  const inputs = new Map(inputRows.map(row => {
    const item = suite.cases.find(item => item.id === row.id)
    if (!item) throw new Error('Evidence input does not belong to the frozen suite.')
    return [row.id, validateEvaluationCaseInput(item, row.input)]
  }))
  const annotations = annotationSchema.array().min(1).max(10_000).parse(rawAnnotations)
  const annotationKeys = new Set<string>()
  for (const annotation of annotations) {
    const item = suite.cases.find(item => item.id === annotation.caseId)
    const input = inputs.get(annotation.caseId)
    const key = JSON.stringify([annotation.caseId, annotation.criterionId, annotation.origin])
    if (!item || !input || item.inputSha256 !== annotation.inputSha256 ||
      !item.criterionIds.includes(annotation.criterionId) || item.excludedCriterionIds?.includes(annotation.criterionId) ||
      annotationKeys.has(key)) {
      throw new Error('Evidence annotations require one effective source-bound criterion revision per origin.')
    }
    annotationKeys.add(key)
    if (new Set(annotation.facts.map(fact => fact.id)).size !== annotation.facts.length) {
      throw new Error('Annotated fact group IDs must be unique within a criterion.')
    }
    const spans = new Set<string>()
    for (const fact of annotation.facts) for (const alternative of fact.alternatives) {
      const paragraph = input.resume.paragraphs.find(row => row.id === alternative.paragraphId)
      const span = JSON.stringify([alternative.paragraphId, alternative.text])
      if (!paragraph?.text.includes(alternative.text) || spans.has(span)) {
        throw new Error('Annotated alternatives must bind distinct literal text in exact source paragraphs.')
      }
      spans.add(span)
    }
  }
  const key = (row: { caseId: string; configurationId: string; repetition: number }) =>
    JSON.stringify([row.caseId, row.configurationId, row.repetition])
  const observed = new Map(observations.map(row => [key(row), row]))
  const artifacts = new Map<string, ReturnType<typeof validateAnalysisAssessmentForReview>>()
  for (const row of artifactSchema.array().max(60_000).parse(rawArtifacts)) {
    const observation = observed.get(key(row)), input = inputs.get(row.caseId)
    if (!input || observation?.result.status !== 'complete' || artifacts.has(key(row))) {
      throw new Error('Private assessments must bind unique completed suite observations.')
    }
    const assessment = validateAnalysisAssessmentForReview(row.assessment, input)
    const summary = calculateAnalysisSummary(input.rubric, assessment)
    if (analysisAssessmentHash(assessment) !== row.assessmentSha256 ||
      observation.result.assessmentSha256 !== undefined && observation.result.assessmentSha256 !== row.assessmentSha256 ||
      (summary.overall.status === 'available' ? summary.overall.score : null) !== observation.result.overall ||
      assessment.criteria.some(criterion =>
        observation.result.status !== 'complete' ||
        observation.result.criteria.find(item => item.criterionId === criterion.criterionId)?.score !== criterion.score)) {
      throw new Error('Evidence measurement requires the exact final assessment hash and observed scores.')
    }
    artifacts.set(key(row), assessment)
  }
  const items = annotations.flatMap(annotation => {
    const item = suite.cases.find(item => item.id === annotation.caseId)!
    return suite.configurations.flatMap(configuration =>
      Array.from({ length: suite.repetitions }, (_, index) => {
        const repetition = index + 1
        const identity = { caseId: item.id, configurationId: configuration.id, repetition }
        const observation = observed.get(key(identity))
        const assessment = artifacts.get(key(identity))
        const criterion = assessment?.criteria.find(row => row.criterionId === annotation.criterionId)
        const status = !observation ? 'missing-observation' : observation.result.status === 'failed'
          ? 'processing-failed' : !criterion ? 'missing-assessment' : 'available'
        const selected = criterion ? annotation.facts.filter(fact => fact.alternatives.some(alternative =>
          criterion.citations.some(citation => citation.paragraphId === alternative.paragraphId &&
            citation.quote.includes(alternative.text)))) : []
        const detection = {
          id: JSON.stringify([item.id, annotation.criterionId]),
          expectedSupportingFacts: annotation.facts.filter(fact => fact.role === 'supporting').map(fact => fact.id),
          knownNonSupportingFacts: annotation.facts.filter(fact => fact.role === 'non-supporting').map(fact => fact.id),
          retrievedFacts: selected.filter(fact => fact.role !== 'contrary').map(fact => fact.id),
        }
        return {
          ...identity, familyId: item.familyId, jobId: item.jobId, split: item.split,
          criterionId: annotation.criterionId, inputSha256: item.inputSha256,
          origin: annotation.origin, author: annotation.author, revision: annotation.revision, independent: annotation.independent,
          status, failureCode: observation?.result.status === 'failed' ? observation.result.code : null,
          bindingStatus: !assessment ? null : observation?.result.status === 'complete' &&
            observation.result.assessmentSha256 !== undefined ? 'assessment-hash-bound' : 'legacy-score-only',
          assessmentSha256: assessment ? analysisAssessmentHash(assessment) : null,
          evidenceStatus: criterion?.evidenceStatus ?? null, score: criterion?.score ?? null,
          selectedFactIds: criterion ? selected.map(fact => fact.id) : null,
          contraryExpected: annotation.facts.filter(fact => fact.role === 'contrary').length,
          contrarySelected: criterion ? selected.filter(fact => fact.role === 'contrary').length : null,
          unannotatedCitations: criterion ? criterion.citations.filter(citation =>
            !annotation.facts.some(fact => fact.alternatives.some(alternative =>
              citation.paragraphId === alternative.paragraphId && citation.quote.includes(alternative.text)))).length : null,
          detection: criterion ? detection : null,
          statistics: criterion ? evidenceDetectionStatistics([detection]) : null,
        }
      }))
  })
  const reports = suite.configurations.flatMap(configuration =>
    (['development', 'calibration', 'holdout'] as const).flatMap(split =>
      (['planted', 'human-reviewed'] as const).flatMap(origin =>
        [true, false].flatMap(independent => Array.from({ length: suite.repetitions }, (_, index) => {
          const repetition = index + 1
          const selected = items.filter(row => row.configurationId === configuration.id && row.split === split &&
            row.origin === origin && row.independent === independent && row.repetition === repetition)
          const available = selected.filter(row => row.status === 'available')
          return {
            configurationId: configuration.id, split, origin, independent, repetition,
            expected: selected.length, available: available.length,
            missingObservations: selected.filter(row => row.status === 'missing-observation').length,
            processingFailed: selected.filter(row => row.status === 'processing-failed').length,
            missingAssessments: selected.filter(row => row.status === 'missing-assessment').length,
            hashBoundAssessments: available.filter(row => row.bindingStatus === 'assessment-hash-bound').length,
            legacyScoreOnlyAssessments: available.filter(row => row.bindingStatus === 'legacy-score-only').length,
            unscoredCriteria: available.filter(row => row.score === null).length,
            contraryExpectedOnAvailable: available.reduce((sum, row) => sum + row.contraryExpected, 0),
            contrarySelected: available.reduce((sum, row) => sum + (row.contrarySelected ?? 0), 0),
            unannotatedCitations: available.reduce((sum, row) => sum + (row.unannotatedCitations ?? 0), 0),
            statistics: available.length ? evidenceDetectionStatistics(available.map(row => row.detection)) : null,
          }
        })))))
  return {
    schemaVersion: 1 as const, suiteSha256: evaluationHash(suite), annotationsSha256: evaluationHash(annotations),
    items, reports, eligibleForRelease: false,
    limitations: [
      'Literal fact-group coverage of final criterion citations, not semantic retrieval recall, rationale correctness or ordinal accuracy.',
      'A fact group counts once if any annotated alternative is fully quoted within its exact source paragraph; partial quotes and paraphrased rationales do not count.',
      'Selection precision is conditional on annotated supporting/non-supporting groups. Other evidence remains unknown; contrary facts are reported separately.',
      'Selecting annotated non-supporting context is a diagnostic, not necessarily an unsupported factual assertion or scoring error.',
      'Missing observations, processing failures and missing private assessments are not empty evidence sets or recall failures.',
      'New observations bind the canonical final assessment hash. Legacy observations without it are only score-matched; no final-content binding is inferred or retroactively fabricated.',
      'Origins, exposure, splits and repetitions remain separate. Repeats and shared jobs are not independent people; no population fairness or release approval is inferred.',
    ],
  }
}
