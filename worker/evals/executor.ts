import {
  scoringObservationSchema, scoringSuiteSchema, type ScoringObservation, type ScoringSuite,
} from './contracts'
import { evaluationHash, validateObservations } from './statistics'

export interface ScoringEvaluationJob {
  suiteSha256: string
  case: ScoringSuite['cases'][number]
  configuration: ScoringSuite['configurations'][number]
  repetition: number
}

export interface ScoringEvaluationExecutor {
  concurrency: number
  signal?: AbortSignal
  priorObservations?: unknown
  execute: (job: ScoringEvaluationJob, signal?: AbortSignal) => Promise<ScoringObservation['result']>
  checkpoint: (observation: ScoringObservation) => Promise<void>
  now?: () => number
}

export async function executeBoundedEvaluationJobs<T>(
  jobs: T[],
  options: { concurrency: number; signal?: AbortSignal; execute: (job: T, signal?: AbortSignal) => Promise<void> },
) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error('Evaluation concurrency must be an integer from one through eight.')
  }
  let index = 0, stopped = false
  const workers = Array.from({ length: Math.min(options.concurrency, jobs.length) }, async () => {
    try {
      while (!stopped && index < jobs.length) {
        options.signal?.throwIfAborted()
        await options.execute(jobs[index++], options.signal)
      }
    } catch (error) {
      stopped = true
      throw error
    }
  })
  const settled = await Promise.allSettled(workers)
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
}

export async function executeScoringSuite(rawSuite: unknown, options: ScoringEvaluationExecutor) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error('Evaluation concurrency must be an integer from one through eight.')
  }
  const observations = validateObservations(suite, options.priorObservations ?? [])
  const keys = new Set(observations.map(row => JSON.stringify([row.caseId, row.configurationId, row.repetition])))
  const suiteSha256 = evaluationHash(suite)
  const jobs: ScoringEvaluationJob[] = []
  for (const item of suite.cases) for (const configuration of suite.configurations) {
    for (let repetition = 1; repetition <= suite.repetitions; repetition++) {
      if (!keys.has(JSON.stringify([item.id, configuration.id, repetition]))) {
        jobs.push({ suiteSha256, case: item, configuration, repetition })
      }
    }
  }
  const now = options.now ?? Date.now
  await executeBoundedEvaluationJobs(jobs, {
    concurrency: options.concurrency, signal: options.signal,
    execute: async job => {
        const started = now()
        const result = await options.execute(job, options.signal)
        options.signal?.throwIfAborted()
        const observation = scoringObservationSchema.parse({
          schemaVersion: 1, suiteSha256, caseId: job.case.id, configurationId: job.configuration.id,
          repetition: job.repetition, durationMilliseconds: now() - started, result,
        })
        validateObservations(suite, [observation])
        await options.checkpoint(observation)
        observations.push(observation)
    },
  })
  return observations
}
