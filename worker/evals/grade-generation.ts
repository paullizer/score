import { z } from 'zod'
import { invokeStructuredModel, WorkerError, type RubricModelOptions } from '../runtime'
import { draftGradeRubric, GradeModelError, planGradeCompetencies, reviewGradeRubric } from '../grades/model'
import type { GradeModelInvoker, GradeDraftModelResult, GradeReviewModelResult } from '../grades/contracts'
import type {
  GradeCompetency, GradeLadderRecord, GradeRubric, GradeRubricVersionRecord, GradeSeedSnapshot, GradeSourceSetRecord,
  ReferenceDocument,
} from '../../src/domain/real-grades'
import { evaluationAttemptRecorder, type EvaluationAttemptOptions } from './model-attempts'
import { validateEvaluationModelSettings } from './production'
import { executeBoundedEvaluationJobs } from './executor'
import { evaluationHash } from './statistics'
import { compareGeneratedRubrics } from './rubric-repeatability'

export const GRADE_GENERATION_VERSION = 'score-grade-generation-v1'
const id = z.string().min(1).max(160)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const gradeNumber = z.number().int().min(1).max(15)
const unique = (values: unknown[]) => new Set(values).size === values.length

export const gradeGenerationSuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  purpose: z.enum(['screening', 'stability']),
  repetitions: z.number().int().min(2).max(12),
  configurations: z.array(z.strictObject({
    id, settingsSha256: hash, algorithmVersion: z.literal(GRADE_GENERATION_VERSION),
  })).min(1).max(8),
  sources: z.array(z.strictObject({
    id, fixtureSha256: hash, grades: z.array(gradeNumber).min(1).max(15),
  })).min(1).max(20),
}).superRefine((suite, context) => {
  if (!unique(suite.configurations.map(row => row.id)) || !unique(suite.sources.map(row => row.id)) ||
    suite.sources.some(row => !unique(row.grades))) {
    context.addIssue({ code: 'custom', message: 'Grade suite configuration IDs, source IDs and each source\'s grades must be unique.' })
  }
})
export type GradeGenerationSuite = z.infer<typeof gradeGenerationSuiteSchema>

const gradeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    grade: gradeNumber, status: z.literal('complete'), rubricSha256: hash, criteria: z.number().int().min(1).max(100),
    reviewOutcome: z.enum(['supported', 'needs-sources']),
  }),
  z.strictObject({ grade: gradeNumber, status: z.literal('failed'), stage: z.enum(['draft', 'review']), code: id }),
])
export const gradeGenerationObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  suiteSha256: hash,
  sourceId: id,
  configurationId: id,
  repetition: z.number().int().min(1).max(12),
  durationMilliseconds: z.number().finite().nonnegative(),
  result: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('complete'), competencies: z.number().int().min(1).max(100), grades: z.array(gradeResultSchema).min(1).max(15),
    }),
    z.strictObject({ status: z.literal('failed'), stage: z.literal('plan'), code: id }),
  ]),
})
export type GradeGenerationObservation = z.infer<typeof gradeGenerationObservationSchema>

/** A frozen ladder: the seed job and rubric, confirmed source set and extracted reference documents. */
export interface GradeGenerationFixture {
  ladder: GradeLadderRecord
  seed: GradeSeedSnapshot
  sourceSet: GradeSourceSetRecord
  documents: ReferenceDocument[]
}

export interface GradeGenerationJob {
  suiteSha256: string
  source: GradeGenerationSuite['sources'][number]
  configuration: GradeGenerationSuite['configurations'][number]
  repetition: number
}

export interface GradeGenerationArtifact {
  competencies: GradeCompetency[]
  grades: Array<{ grade: number; draft: GradeDraftModelResult; review: GradeReviewModelResult }>
}

export interface GradeGenerationOptions extends EvaluationAttemptOptions {
  model: RubricModelOptions
  fixture: unknown
  processingSettings: unknown
  prices: Record<string, unknown>
  createdAt: string
  admitPaidWork: (job: GradeGenerationJob) => Promise<void>
  recordPrivateGeneration: (generated: GradeGenerationArtifact) => Promise<void>
  recordPrivateFailure?: (failure: { grade: number | null; code: string; stage: string; reason: string | null }) => Promise<void>
}

export function validateGradeGenerationObservations(suite: GradeGenerationSuite, raw: unknown) {
  const rows = gradeGenerationObservationSchema.array().max(2000).parse(raw)
  const suiteSha256 = evaluationHash(suite), keys = new Set<string>()
  for (const row of rows) {
    const key = JSON.stringify([row.sourceId, row.configurationId, row.repetition])
    const source = suite.sources.find(item => item.id === row.sourceId)
    if (row.suiteSha256 !== suiteSha256 || keys.has(key) || row.repetition > suite.repetitions || !source ||
      !suite.configurations.some(item => item.id === row.configurationId) ||
      row.result.status === 'complete' && (row.result.grades.length !== source.grades.length ||
        row.result.grades.some((item, index) => item.grade !== source.grades[index]))) {
      throw new Error('Grade observations must bind one unique frozen source, configuration and repetition, with every requested grade in order.')
    }
    keys.add(key)
  }
  return rows
}

const fixtureShape = z.object({
  ladder: z.looseObject({ recordType: z.literal('grade-ladder'), id, workspaceId: id, grades: z.array(gradeNumber) }),
  seed: z.looseObject({}),
  sourceSet: z.looseObject({ recordType: z.literal('grade-source-set'), id, ladderId: id, workspaceId: id, grades: z.array(gradeNumber) }),
  documents: z.array(z.looseObject({ id, version: z.number().int().min(1) })).min(1).max(50),
})

export function validateGradeGenerationFixture(source: GradeGenerationSuite['sources'][number], raw: unknown): GradeGenerationFixture {
  const shape = fixtureShape.safeParse(raw)
  if (!shape.success || evaluationHash(raw) !== source.fixtureSha256 || shape.data.sourceSet.ladderId !== shape.data.ladder.id ||
    shape.data.sourceSet.workspaceId !== shape.data.ladder.workspaceId ||
    source.grades.some(grade => !shape.data.ladder.grades.includes(grade) || !shape.data.sourceSet.grades.includes(grade))) {
    throw new Error('Grade source does not match its exact frozen ladder fixture and requested grades.')
  }
  return structuredClone(raw) as GradeGenerationFixture
}

export function validateGradeGeneration(
  job: GradeGenerationJob, options: Pick<GradeGenerationOptions, 'fixture' | 'processingSettings' | 'prices'>,
) {
  if (job.configuration.algorithmVersion !== GRADE_GENERATION_VERSION) {
    throw new Error('The grade adapter cannot impersonate a different generation algorithm.')
  }
  const { processingSettings, prices } = validateEvaluationModelSettings(job.configuration, options,
    ['gradeCompetencies', 'gradeDraft', 'gradeReview'])
  return { fixture: validateGradeGenerationFixture(job.source, options.fixture), processingSettings, prices }
}

function generationFailure(error: unknown, signal?: AbortSignal): { code: string; reason: string | null } {
  // A broken frozen fixture is a harness error, never a model failure.
  if (error instanceof GradeModelError && error.code !== 'invalid-input' && !signal?.aborted) {
    return { code: error.code, reason: error.message.slice(0, 2000) || null }
  }
  if (error instanceof WorkerError && !error.cancelled && !signal?.aborted) return { code: error.code, reason: error.message.slice(0, 2000) || null }
  throw error
}

/** Plans one common competency set, then drafts and independently reviews every requested grade from it. */
export async function executeGradeGeneration(
  job: GradeGenerationJob, options: GradeGenerationOptions, signal?: AbortSignal,
): Promise<GradeGenerationObservation['result']> {
  const { fixture, processingSettings, prices } = validateGradeGeneration(job, options)
  if (!Number.isFinite(Date.parse(options.createdAt))) throw new Error('Grade generation requires an explicit timestamp.')
  signal?.throwIfAborted()
  await options.admitPaidWork(job)
  signal?.throwIfAborted()
  const attempts = evaluationAttemptRecorder(processingSettings, prices, options)
  const invoke: GradeModelInvoker = (request, requestSignal) => invokeStructuredModel({
    ...options.model, processingSettings, onModelAttempt: attempts.onModelAttempt,
  }, request, requestSignal)
  const failed = async (grade: number | null, stage: string, error: unknown) => {
    attempts.rethrowRecordingFailure()
    const failure = generationFailure(error, signal)
    await options.recordPrivateFailure?.({ grade, stage, ...failure })
    return failure.code
  }
  let competencies: GradeCompetency[]
  try {
    competencies = (await planGradeCompetencies({
      processingSettings, seed: fixture.seed, sourceSet: fixture.sourceSet, documents: fixture.documents,
    }, invoke, signal)).competencies
  } catch (error) {
    return { status: 'failed', stage: 'plan', code: await failed(null, 'plan', error) }
  }
  const results: Extract<GradeGenerationObservation['result'], { status: 'complete' }>['grades'] = []
  const artifact: GradeGenerationArtifact = { competencies, grades: [] }
  const generationId = `evaluation-${evaluationHash([job.suiteSha256, job.source.id, job.configuration.id, job.repetition]).slice(0, 32)}`
  for (const grade of job.source.grades) {
    const versionId = `grade-version-${evaluationHash([generationId, grade]).slice(0, 32)}`
    let draft: GradeDraftModelResult
    try {
      draft = await draftGradeRubric({
        processingSettings, ladder: fixture.ladder, sourceSet: fixture.sourceSet, documents: fixture.documents,
        competencies, grade, versionId, version: 1, createdAt: options.createdAt,
      }, invoke, signal)
    } catch (error) {
      results.push({ grade, status: 'failed', stage: 'draft', code: await failed(grade, 'draft', error) })
      continue
    }
    const version: GradeRubricVersionRecord = {
      id: versionId, workspaceId: fixture.sourceSet.workspaceId, createdAt: options.createdAt, updatedAt: options.createdAt,
      recordType: 'grade-version', ladderId: fixture.ladder.id, grade, version: 1, generationId, sourceSetId: fixture.sourceSet.id,
      rubric: draft.rubric, qualifications: draft.qualifications, issues: draft.issues, createdBy: 'score-evaluation',
      contentHash: evaluationHash({ rubric: draft.rubric, qualifications: draft.qualifications }),
    }
    let review: GradeReviewModelResult
    try {
      review = await reviewGradeRubric({ processingSettings, version, sourceSet: fixture.sourceSet, documents: fixture.documents }, invoke, signal)
    } catch (error) {
      results.push({ grade, status: 'failed', stage: 'review', code: await failed(grade, 'review', error) })
      continue
    }
    results.push({
      grade, status: 'complete', rubricSha256: evaluationHash(draft.rubric), criteria: draft.rubric.criteria.length,
      reviewOutcome: review.outcome,
    })
    artifact.grades.push({ grade, draft, review })
  }
  attempts.rethrowRecordingFailure()
  await options.recordPrivateGeneration(structuredClone(artifact))
  signal?.throwIfAborted()
  return { status: 'complete', competencies: competencies.length, grades: results }
}

export async function executeGradeGenerationSuite(rawSuite: unknown, options: {
  concurrency: number
  signal?: AbortSignal
  priorObservations?: unknown
  execute: (job: GradeGenerationJob, signal?: AbortSignal) => Promise<GradeGenerationObservation['result']>
  checkpoint: (observation: GradeGenerationObservation) => Promise<void>
  now?: () => number
}) {
  const suite = gradeGenerationSuiteSchema.parse(rawSuite)
  const prior = validateGradeGenerationObservations(suite, options.priorObservations ?? [])
  const done = new Set(prior.map(row => JSON.stringify([row.sourceId, row.configurationId, row.repetition])))
  const suiteSha256 = evaluationHash(suite), now = options.now ?? Date.now
  const jobs: GradeGenerationJob[] = []
  // Repetition-major order keeps partial runs balanced across ladders and configurations.
  for (let repetition = 1; repetition <= suite.repetitions; repetition++) {
    for (const source of suite.sources) for (const configuration of suite.configurations) {
      if (!done.has(JSON.stringify([source.id, configuration.id, repetition]))) jobs.push({ suiteSha256, source, configuration, repetition })
    }
  }
  await executeBoundedEvaluationJobs(jobs, {
    concurrency: options.concurrency, signal: options.signal,
    execute: async (job, signal) => {
      const started = now()
      const result = await options.execute(job, signal)
      await options.checkpoint(gradeGenerationObservationSchema.parse({
        schemaVersion: 1, suiteSha256, sourceId: job.source.id, configurationId: job.configuration.id,
        repetition: job.repetition, durationMilliseconds: Math.max(0, now() - started), result,
      }))
    },
  })
}

const gradeArtifactSchema = z.strictObject({
  sourceId: id, configurationId: id, repetition: z.number().int().min(1).max(12),
  grades: z.array(z.strictObject({ grade: gradeNumber, rubric: z.unknown() })).max(15),
})
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

/** One cell per ladder grade and configuration; `completed` counts drafts that also passed independent review. */
export function summarizeGradeGeneration(rawSuite: unknown, rawObservations: unknown, rawArtifacts: unknown) {
  const suite = gradeGenerationSuiteSchema.parse(rawSuite)
  const observations = validateGradeGenerationObservations(suite, rawObservations)
  const rubrics = new Map<string, GradeRubric>()
  for (const artifact of gradeArtifactSchema.array().max(2000).parse(rawArtifacts)) {
    const observation = observations.find(row => row.sourceId === artifact.sourceId &&
      row.configurationId === artifact.configurationId && row.repetition === artifact.repetition)
    if (observation?.result.status !== 'complete') throw new Error('Each grade artifact must match one completed grade observation.')
    for (const row of artifact.grades) {
      const key = JSON.stringify([artifact.sourceId, artifact.configurationId, artifact.repetition, row.grade])
      const result = observation.result.grades.find(item => item.grade === row.grade)
      if (rubrics.has(key) || result?.status !== 'complete' || evaluationHash(row.rubric) !== result.rubricSha256) {
        throw new Error('Each grade artifact rubric must exactly match one completed grade result.')
      }
      rubrics.set(key, row.rubric as GradeRubric)
    }
  }
  for (const observation of observations) {
    if (observation.result.status !== 'complete') continue
    for (const row of observation.result.grades) {
      if (row.status === 'complete' &&
        !rubrics.has(JSON.stringify([observation.sourceId, observation.configurationId, observation.repetition, row.grade]))) {
        throw new Error('Every completed grade result requires its private rubric artifact.')
      }
    }
  }
  const cells = suite.sources.flatMap(source => source.grades.flatMap(grade => suite.configurations.map(configuration => {
    const rows = observations.filter(row => row.sourceId === source.id && row.configurationId === configuration.id)
    const results = rows.map(row => row.result.status === 'complete'
      ? row.result.grades.find(item => item.grade === grade)! : { grade, status: 'failed' as const, stage: 'plan' as const, code: row.result.code })
    const generated = rows.flatMap(row => {
      const rubric = rubrics.get(JSON.stringify([row.sourceId, row.configurationId, row.repetition, grade]))
      return rubric ? [rubric] : []
    })
    const alignment: number[] = []
    for (let left = 0; left < generated.length; left++) {
      for (let right = left + 1; right < generated.length; right++) alignment.push(compareGeneratedRubrics(generated[left], generated[right]).alignmentRate)
    }
    const counts = generated.map(row => row.criteria.length)
    return {
      sourceId: `${source.id}:gs-${grade}`, ladderSourceId: source.id, grade, configurationId: configuration.id,
      expected: suite.repetitions,
      completed: results.filter(row => row.status === 'complete' && row.reviewOutcome === 'supported').length,
      drafted: results.filter(row => row.status === 'complete').length,
      needsSources: results.filter(row => row.status === 'complete' && row.reviewOutcome === 'needs-sources').length,
      failed: results.filter(row => row.status === 'failed').length,
      missing: suite.repetitions - rows.length,
      failureCodes: results.flatMap(row => row.status === 'failed' ? [`${row.stage}:${row.code}`] : []),
      criteriaCounts: counts, criteriaCountRange: counts.length ? Math.max(...counts) - Math.min(...counts) : null,
      repeatPairs: alignment.length, meanRepeatAlignmentRate: mean(alignment),
      minimumRepeatAlignmentRate: alignment.length ? Math.min(...alignment) : null,
    }
  })))
  return {
    schemaVersion: 1 as const, suiteSha256: evaluationHash(suite),
    expectedGenerations: cells.length * suite.repetitions,
    completed: cells.reduce((sum, row) => sum + row.completed, 0),
    failed: cells.reduce((sum, row) => sum + row.failed, 0),
    cells, eligibleForRelease: false,
    limitations: [
      'A completed grade generation is a valid draft that independent review supported; needs-sources outcomes are counted separately.',
      'Alignment is lexical source-citation overlap between repeated drafts, not semantic equivalence or approval.',
      'Grades of one ladder share each repetition\'s competency plan, so they are not independent generations.',
      'Failures and missing generations are reported separately and never treated as empty rubrics.',
    ],
  }
}
