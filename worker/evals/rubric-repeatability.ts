import { z } from 'zod'
import { generateGroundedRubric, WorkerError, type RubricModelOptions } from '../runtime'
import { isValidJobId, validateRealRubric, validateRealSourceDocument } from '../../server/jobs/validation'
import { isOriginalContentType, type OriginalContentType } from '../../src/domain/document-formats'
import type { Criterion, Rubric, SourceDocument } from '../../src/domain/types'
import { evaluationAttemptRecorder, type EvaluationAttemptOptions } from './model-attempts'
import { validateEvaluationModelSettings } from './production'
import { executeBoundedEvaluationJobs } from './executor'
import { evaluationHash } from './statistics'

export const RUBRIC_GENERATION_VERSION = 'score-rubric-generation-v1'
const id = z.string().min(1).max(160)
const hash = z.string().regex(/^[a-f0-9]{64}$/)

export const rubricRepeatabilitySuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  purpose: z.enum(['screening', 'stability']),
  repetitions: z.number().int().min(2).max(12),
  configurations: z.array(z.strictObject({
    id, settingsSha256: hash, algorithmVersion: z.literal(RUBRIC_GENERATION_VERSION),
  })).min(1).max(8),
  sources: z.array(z.strictObject({
    id,
    jobId: z.string().refine(isValidJobId, 'Rubric sources need a real job id.'),
    sourceDocumentSha256: hash,
    contentType: z.string().refine(isOriginalContentType, 'Unsupported original content type.'),
  })).min(1).max(20),
}).superRefine((suite, context) => {
  if (new Set(suite.configurations.map(row => row.id)).size !== suite.configurations.length ||
    new Set(suite.sources.map(row => row.id)).size !== suite.sources.length) {
    context.addIssue({ code: 'custom', message: 'Rubric suite configuration and source IDs must be unique.' })
  }
})
export type RubricRepeatabilitySuite = z.infer<typeof rubricRepeatabilitySuiteSchema>

export const rubricGenerationObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  suiteSha256: hash,
  sourceId: id,
  configurationId: id,
  repetition: z.number().int().min(1).max(12),
  durationMilliseconds: z.number().finite().nonnegative(),
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('complete'), rubricSha256: hash, criteria: z.number().int().min(1).max(100) }),
    z.strictObject({ status: z.literal('failed'), code: id }),
  ]),
})
export type RubricGenerationObservation = z.infer<typeof rubricGenerationObservationSchema>

export interface RubricGenerationJob {
  suiteSha256: string
  source: RubricRepeatabilitySuite['sources'][number]
  configuration: RubricRepeatabilitySuite['configurations'][number]
  repetition: number
}

export interface RubricGenerationOptions extends EvaluationAttemptOptions {
  model: RubricModelOptions
  document: unknown
  processingSettings: unknown
  prices: Record<string, unknown>
  createdAt: string
  admitPaidWork: (job: RubricGenerationJob) => Promise<void>
  recordPrivateRubric: (generated: { rubric: Rubric; metadata: unknown; warnings: string[] }) => Promise<void>
  recordPrivateFailure?: (failure: { code: string; stage: string; reason: string | null }) => Promise<void>
}

export function validateRubricGenerationObservations(suite: RubricRepeatabilitySuite, raw: unknown) {
  const rows = rubricGenerationObservationSchema.array().max(2000).parse(raw)
  const suiteSha256 = evaluationHash(suite), keys = new Set<string>()
  for (const row of rows) {
    const key = JSON.stringify([row.sourceId, row.configurationId, row.repetition])
    if (row.suiteSha256 !== suiteSha256 || keys.has(key) || row.repetition > suite.repetitions ||
      !suite.sources.some(item => item.id === row.sourceId) ||
      !suite.configurations.some(item => item.id === row.configurationId)) {
      throw new Error('Rubric observations must bind one unique frozen source, configuration and repetition.')
    }
    keys.add(key)
  }
  return rows
}

export function validateRubricGenerationSource(source: RubricRepeatabilitySuite['sources'][number], raw: unknown): SourceDocument {
  if (validateRealSourceDocument(raw, source.contentType as OriginalContentType).length ||
    evaluationHash(raw) !== source.sourceDocumentSha256) {
    throw new Error('Rubric source does not match its exact frozen job document.')
  }
  return structuredClone(raw) as SourceDocument
}

export function validateRubricGeneration(
  job: RubricGenerationJob, options: Pick<RubricGenerationOptions, 'document' | 'processingSettings' | 'prices'>,
) {
  if (job.configuration.algorithmVersion !== RUBRIC_GENERATION_VERSION) {
    throw new Error('The rubric adapter cannot impersonate a different generation algorithm.')
  }
  const { processingSettings, prices } = validateEvaluationModelSettings(job.configuration, options, ['jobRubric'])
  return { document: validateRubricGenerationSource(job.source, options.document), processingSettings, prices }
}

export async function executeRubricGeneration(
  job: RubricGenerationJob, options: RubricGenerationOptions, signal?: AbortSignal,
): Promise<RubricGenerationObservation['result']> {
  const { document, processingSettings, prices } = validateRubricGeneration(job, options)
  if (!Number.isFinite(Date.parse(options.createdAt))) throw new Error('Rubric generation requires an explicit timestamp.')
  signal?.throwIfAborted()
  await options.admitPaidWork(job)
  signal?.throwIfAborted()
  const attempts = evaluationAttemptRecorder(processingSettings, prices, options)
  try {
    const generated = await generateGroundedRubric(document, {
      ...options.model, processingSettings, onModelAttempt: attempts.onModelAttempt,
    }, (rubric, source) => validateRealRubric(rubric, source, job.source.contentType as OriginalContentType),
    job.source.jobId, options.createdAt, signal)
    await options.recordPrivateRubric(structuredClone(generated))
    signal?.throwIfAborted()
    return { status: 'complete', rubricSha256: evaluationHash(generated.rubric), criteria: generated.rubric.criteria.length }
  } catch (error) {
    attempts.rethrowRecordingFailure()
    if (!(error instanceof WorkerError) || error.cancelled || signal?.aborted) throw error
    // Validation messages name schema/citation problems in the public job source; keep them bounded for private diagnosis.
    await options.recordPrivateFailure?.({ code: error.code, stage: error.stage, reason: error.message.slice(0, 2000) || null })
    return { status: 'failed', code: error.code }
  }
}

export async function executeRubricRepeatabilitySuite(rawSuite: unknown, options: {
  concurrency: number
  signal?: AbortSignal
  priorObservations?: unknown
  execute: (job: RubricGenerationJob, signal?: AbortSignal) => Promise<RubricGenerationObservation['result']>
  checkpoint: (observation: RubricGenerationObservation) => Promise<void>
  now?: () => number
}) {
  const suite = rubricRepeatabilitySuiteSchema.parse(rawSuite)
  const prior = validateRubricGenerationObservations(suite, options.priorObservations ?? [])
  const done = new Set(prior.map(row => JSON.stringify([row.sourceId, row.configurationId, row.repetition])))
  const suiteSha256 = evaluationHash(suite), now = options.now ?? Date.now
  const jobs: RubricGenerationJob[] = []
  // Repetition-major order keeps partial runs balanced across sources and configurations.
  for (let repetition = 1; repetition <= suite.repetitions; repetition++) {
    for (const source of suite.sources) for (const configuration of suite.configurations) {
      if (!done.has(JSON.stringify([source.id, configuration.id, repetition]))) {
        jobs.push({ suiteSha256, source, configuration, repetition })
      }
    }
  }
  await executeBoundedEvaluationJobs(jobs, {
    concurrency: options.concurrency, signal: options.signal,
    execute: async (job, signal) => {
      const started = now()
      const result = await options.execute(job, signal)
      await options.checkpoint(rubricGenerationObservationSchema.parse({
        schemaVersion: 1, suiteSha256, sourceId: job.source.id, configurationId: job.configuration.id,
        repetition: job.repetition, durationMilliseconds: Math.max(0, now() - started), result,
      }))
    },
  })
}

const PERFORMANCE_QUALIFIER = /\b(?:independent(?:ly)?|consistent(?:ly)?|regular(?:ly)?|routine(?:ly)?|frequent(?:ly)?|occasional(?:ly)?|supervis\w*|oversight|errors?|lapses?|quality|acceptable|edits?|reminders?|generally|expert)\b/i
const DOCUMENTARY_EVIDENCE = /\b(?:documents?|documented|documentary|resume|résumé|evidence|describes?|described|states?|stated)\b/i

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const words = (text: string) => new Set(text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [])
function jaccard<T>(left: Set<T>, right: Set<T>) {
  if (!left.size && !right.size) return 1
  let shared = 0
  for (const value of left) if (right.has(value)) shared++
  return shared / (left.size + right.size - shared)
}
const citationsOf = (criterion: Criterion) => criterion.sourceCitations ?? []
const citedParagraphs = (rubric: Rubric) => new Set(rubric.criteria.flatMap(row => citationsOf(row).map(citation => citation.paragraphId)))
function requirementSimilarity(left: Criterion, right: Criterion) {
  const paragraphs = new Set(citationsOf(left).map(row => row.paragraphId))
  if (!citationsOf(right).some(row => paragraphs.has(row.paragraphId))) return 0
  const leftQuote = citationsOf(left).map(row => row.quote).join(' ')
  const rightQuote = citationsOf(right).map(row => row.quote).join(' ')
  if (leftQuote.includes(rightQuote) || rightQuote.includes(leftQuote)) return 1
  return jaccard(words(leftQuote), words(rightQuote))
}

/** Source-bound lexical alignment: criteria align only when they cite overlapping job text, not when labels sound alike. */
export function compareGeneratedRubrics(left: Rubric, right: Rubric) {
  const candidates = left.criteria.flatMap((a, leftIndex) => right.criteria.map((b, rightIndex) => ({
    leftIndex, rightIndex, similarity: requirementSimilarity(a, b),
  }))).filter(row => row.similarity >= 0.5)
    .sort((a, b) => b.similarity - a.similarity || a.leftIndex - b.leftIndex || a.rightIndex - b.rightIndex)
  const usedLeft = new Set<number>(), usedRight = new Set<number>(), matches: typeof candidates = []
  for (const row of candidates) {
    if (usedLeft.has(row.leftIndex) || usedRight.has(row.rightIndex)) continue
    usedLeft.add(row.leftIndex)
    usedRight.add(row.rightIndex)
    matches.push(row)
  }
  return {
    leftCriteria: left.criteria.length, rightCriteria: right.criteria.length, alignedCriteria: matches.length,
    alignmentRate: matches.length / Math.max(left.criteria.length, right.criteria.length),
    meanAbsoluteAlignedWeightDifference: mean(matches.map(row =>
      Math.abs(left.criteria[row.leftIndex].weight - right.criteria[row.rightIndex].weight))),
    citedParagraphJaccard: jaccard(citedParagraphs(left), citedParagraphs(right)),
  }
}

function pairwise(rubrics: Rubric[], others?: Rubric[]) {
  const rows: ReturnType<typeof compareGeneratedRubrics>[] = []
  if (others) for (const left of rubrics) for (const right of others) rows.push(compareGeneratedRubrics(left, right))
  else for (let left = 0; left < rubrics.length; left++) {
    for (let right = left + 1; right < rubrics.length; right++) rows.push(compareGeneratedRubrics(rubrics[left], rubrics[right]))
  }
  const alignment = rows.map(row => row.alignmentRate)
  return {
    pairs: rows.length, meanAlignmentRate: mean(alignment), minimumAlignmentRate: alignment.length ? Math.min(...alignment) : null,
    meanCitedParagraphJaccard: mean(rows.map(row => row.citedParagraphJaccard)),
    meanAbsoluteAlignedWeightDifference: mean(rows.flatMap(row =>
      row.meanAbsoluteAlignedWeightDifference === null ? [] : [row.meanAbsoluteAlignedWeightDifference])),
  }
}

const rubricArtifactSchema = z.strictObject({
  sourceId: id, configurationId: id, repetition: z.number().int().min(1).max(12), rubric: z.unknown(),
})

export function summarizeRubricRepeatability(
  rawSuite: unknown, rawDocuments: unknown, rawObservations: unknown, rawRubrics: unknown, rawReferences: unknown = [],
) {
  const suite = rubricRepeatabilitySuiteSchema.parse(rawSuite)
  const observations = validateRubricGenerationObservations(suite, rawObservations)
  const documentRows = z.array(z.strictObject({ sourceId: id, document: z.unknown() })).max(20).parse(rawDocuments)
  const documents = new Map(suite.sources.map(source => {
    const rows = documentRows.filter(row => row.sourceId === source.id)
    if (rows.length !== 1) throw new Error('Supply exactly one frozen job document for every rubric source.')
    return [source.id, validateRubricGenerationSource(source, rows[0].document)]
  }))
  const contentType = (sourceId: string) => suite.sources.find(row => row.id === sourceId)!.contentType as OriginalContentType
  const artifacts = rubricArtifactSchema.array().max(2000).parse(rawRubrics)
  const rubrics = new Map<string, Rubric>()
  for (const artifact of artifacts) {
    const key = JSON.stringify([artifact.sourceId, artifact.configurationId, artifact.repetition])
    const observation = observations.find(row =>
      JSON.stringify([row.sourceId, row.configurationId, row.repetition]) === key)
    if (rubrics.has(key) || observation?.result.status !== 'complete' ||
      evaluationHash(artifact.rubric) !== observation.result.rubricSha256 ||
      validateRealRubric(artifact.rubric as Rubric, documents.get(artifact.sourceId)!, contentType(artifact.sourceId)).length) {
      throw new Error('Each rubric artifact must exactly match one completed, source-valid observation.')
    }
    rubrics.set(key, artifact.rubric as Rubric)
  }
  if (observations.some(row => row.result.status === 'complete' &&
    !rubrics.has(JSON.stringify([row.sourceId, row.configurationId, row.repetition])))) {
    throw new Error('Every completed rubric observation requires its private rubric artifact.')
  }
  const references = new Map(z.array(z.strictObject({ sourceId: id, rubric: z.unknown() })).max(20).parse(rawReferences)
    .map(row => {
      if (!documents.has(row.sourceId) ||
        validateRealRubric(row.rubric as Rubric, documents.get(row.sourceId)!, contentType(row.sourceId)).length) {
        throw new Error('Reference rubrics must be valid against the same frozen job document.')
      }
      return [row.sourceId, row.rubric as Rubric] as const
    }))
  const generated = (sourceId: string, configurationId: string) =>
    Array.from({ length: suite.repetitions }, (_, index) =>
      rubrics.get(JSON.stringify([sourceId, configurationId, index + 1]))).filter((row): row is Rubric => row !== undefined)
  const markers = (rubric: Rubric) => ({
    criteria: rubric.criteria.length,
    performanceQualifierCriteria: rubric.criteria.filter(row => PERFORMANCE_QUALIFIER.test(row.guidance)).length,
    documentaryEvidenceCriteria: rubric.criteria.filter(row => DOCUMENTARY_EVIDENCE.test(row.guidance)).length,
  })
  const cells = suite.sources.flatMap(source => suite.configurations.map(configuration => {
    const rows = observations.filter(row => row.sourceId === source.id && row.configurationId === configuration.id)
    const completed = generated(source.id, configuration.id)
    const counts = completed.map(row => row.criteria.length)
    const reference = references.get(source.id)
    return {
      sourceId: source.id, configurationId: configuration.id, expected: suite.repetitions, completed: completed.length,
      failed: rows.filter(row => row.result.status === 'failed').length, missing: suite.repetitions - rows.length,
      failureCodes: rows.flatMap(row => row.result.status === 'failed' ? [row.result.code] : []),
      criteriaCounts: counts, criteriaCountRange: counts.length ? Math.max(...counts) - Math.min(...counts) : null,
      repeats: pairwise(completed),
      referenceAgreement: reference ? pairwise(completed, [reference]) : null,
      markers: completed.map(markers),
    }
  }))
  const crossConfiguration = suite.sources.flatMap(source => suite.configurations.flatMap((left, index) =>
    suite.configurations.slice(index + 1).map(right => ({
      sourceId: source.id, leftConfigurationId: left.id, rightConfigurationId: right.id,
      ...pairwise(generated(source.id, left.id), generated(source.id, right.id)),
    }))))
  return {
    schemaVersion: 1 as const, suiteSha256: evaluationHash(suite),
    expectedGenerations: suite.sources.length * suite.configurations.length * suite.repetitions,
    completed: observations.filter(row => row.result.status === 'complete').length,
    failed: observations.filter(row => row.result.status === 'failed').length,
    cells, crossConfiguration,
    referenceMarkers: [...references].map(([sourceId, rubric]) => ({ sourceId, ...markers(rubric) })),
    eligibleForRelease: false,
    limitations: [
      'Alignment is lexical source-citation overlap, not semantic equivalence, requirement coverage accuracy or rubric approval.',
      'Saved reference rubrics are prior production artifacts, not human-approved truth.',
      'Anchor markers are lexical counts of performance-quality and documentary-evidence wording; they do not prove an anchor is valid or invalid.',
      'Failures and missing generations are reported separately and never treated as empty rubrics.',
      'Repeats of the same four job documents are correlated observations, not independent jobs.',
    ],
  }
}
