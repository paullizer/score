import { z } from 'zod'
import { reviewAnalysisAssessment, hashAnalysisAssessment, AnalysisModelError, validateAnalysisAssessmentInput } from '../analyses/model'
import { validateAnalysisAssessmentForReview } from '../analyses/validation'
import type { RubricModelOptions } from '../runtime'
import { executeBoundedEvaluationJobs, type ScoringEvaluationJob } from './executor'
import { validateEvaluationCaseInput, validateEvaluationModelSettings } from './production'
import { evaluationAttemptRecorder, type EvaluationAttemptOptions } from './model-attempts'
import { evaluationHash, ordinalRepeatStatistics } from './statistics'
import { scoringSuiteSchema, type ScoringSuite } from './contracts'
import { fixedJudgeStatistics } from './metrics'
import { parseAnalysisAssessmentOutput } from '../../server/analyses/validation'

export const FIXED_JUDGE_VERSION = 'score-fixed-judge-v1'
export const fixedJudgeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('complete'), issueFound: z.boolean(),
    outcome: z.enum(['supported', 'needs-correction', 'unsupported']),
    assessmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ status: z.literal('failed'), code: z.string().min(1).max(160) }),
])
export type FixedJudgeResult = z.infer<typeof fixedJudgeResultSchema>

export const fixedJudgeProposalSchema = z.strictObject({
  id: z.string().min(1).max(160),
  assessmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  assessment: z.unknown(),
})
export type FixedJudgeProposal = z.infer<typeof fixedJudgeProposalSchema>
export const fixedJudgeObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  suiteSha256: z.string().regex(/^[a-f0-9]{64}$/),
  caseId: z.string().min(1).max(160), configurationId: z.string().min(1).max(160),
  repetition: z.number().int().min(1).max(12),
  assessmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationMilliseconds: z.number().finite().nonnegative(),
  result: fixedJudgeResultSchema,
})
export type FixedJudgeObservation = z.infer<typeof fixedJudgeObservationSchema>
export const fixedJudgeLabelSchema = z.strictObject({
  caseId: z.string().min(1).max(160),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  assessmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.enum(['planted', 'human-reviewed']),
  author: z.string().min(1).max(160), revision: z.string().min(1).max(160),
  independent: z.boolean(),
  expectedIssue: z.enum(['none', 'over-credit', 'under-credit', 'unsupported-fact']),
  reason: z.string().trim().min(1).max(2000),
})

export function summarizeFixedJudgeSuite(rawSuite: unknown, rawProposals: unknown, rawObservations: unknown, rawLabels: unknown) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  const proposals = validateFixedJudgeProposals(suite, rawProposals)
  const observations = validateFixedJudgeObservations(suite, proposals, rawObservations)
  const labels = fixedJudgeLabelSchema.array().max(1000).parse(rawLabels)
  const keys = new Set<string>()
  for (const label of labels) {
    if (suite.cases.find(row => row.id === label.caseId)?.inputSha256 !== label.inputSha256 ||
      proposals.get(label.caseId)?.assessmentSha256 !== label.assessmentSha256) {
      throw new Error('Judge label differs from its frozen source/proposal.')
    }
    const key = JSON.stringify([label.caseId, label.origin])
    if (keys.has(key)) throw new Error('Select one effective judge label per case and origin; retain revisions separately.')
    keys.add(key)
  }
  const reports = suite.configurations.flatMap(configuration => (['development', 'calibration', 'holdout'] as const)
    .flatMap(split => (['planted', 'human-reviewed'] as const).flatMap(origin =>
      Array.from({ length: suite.repetitions }, (_, index) => {
        const repetition = index + 1
        const selected = labels.filter(row => row.origin === origin && row.independent &&
          suite.cases.some(item => item.id === row.caseId && item.split === split))
        const rows = observations.filter(row => row.configurationId === configuration.id && row.repetition === repetition)
        const trials = selected.map(label => {
          const item = suite.cases.find(row => row.id === label.caseId)!
          const result = rows.find(row => row.caseId === label.caseId)?.result
          return {
            id: label.caseId, familyId: item.familyId, expectedIssue: label.expectedIssue,
            result: result?.status === 'complete'
              ? { status: 'complete' as const, issueFound: result.issueFound }
              : { status: 'failed' as const, code: result?.code ?? 'missing-observation' },
          }
        })
        return {
          configurationId: configuration.id, split, origin, repetition,
          referenceItems: selected.length,
          excludedExposedLabels: labels.filter(row => row.origin === origin && !row.independent &&
            suite.cases.some(item => item.id === row.caseId && item.split === split)).length,
          missing: selected.filter(label => !rows.some(row => row.caseId === label.caseId)).length,
          processingFailed: rows.filter(row => row.result.status === 'failed' && selected.some(label => label.caseId === row.caseId)).length,
          statistics: trials.length ? fixedJudgeStatistics(trials) : null,
        }
      }))))
  const indexed = new Map(observations.map(row => [
    JSON.stringify([row.caseId, row.configurationId, row.repetition]), row,
  ]))
  const panel = (caseId: string, configurationId: string) =>
    Array.from({ length: suite.repetitions }, (_, index) =>
      indexed.get(JSON.stringify([caseId, configurationId, index + 1])))
  const verdictStability = suite.configurations.flatMap(configuration => suite.cases.map(item => {
    const rows = panel(item.id, configuration.id)
    const completed = rows.flatMap(row => row?.result.status === 'complete' ? [row.result] : [])
    const binary = ordinalRepeatStatistics(rows.map(row =>
      row?.result.status === 'complete' ? Number(row.result.issueFound) : null))
    let outcomeDisagreements = 0
    for (let left = 0; left < completed.length; left++) for (let right = left + 1; right < completed.length; right++) {
      if (completed[left].outcome !== completed[right].outcome) outcomeDisagreements++
    }
    return {
      caseId: item.id, familyId: item.familyId, jobId: item.jobId, split: item.split,
      configurationId: configuration.id, assessmentSha256: proposals.get(item.id)!.assessmentSha256,
      expected: suite.repetitions, completed: completed.length,
      missing: rows.filter(row => row === undefined).length,
      processingFailed: rows.filter(row => row?.result.status === 'failed').length,
      complete: completed.length === suite.repetitions,
      pairs: binary.pairs, issueDisagreements: binary.disagreements,
      issueDisagreementRate: binary.pairwiseDisagreement,
      outcomeDisagreements, outcomeDisagreementRate: binary.pairs ? outcomeDisagreements / binary.pairs : null,
    }
  }))
  const configurationComparisons = suite.configurations.flatMap((left, index) =>
    suite.configurations.slice(index + 1).flatMap(right => suite.cases.map(item => {
      const leftRows = panel(item.id, left.id), rightRows = panel(item.id, right.id)
      let pairedReviews = 0, issueDisagreements = 0, outcomeDisagreements = 0
      for (let repetition = 0; repetition < suite.repetitions; repetition++) {
        const leftResult = leftRows[repetition]?.result, rightResult = rightRows[repetition]?.result
        if (leftResult?.status !== 'complete' || rightResult?.status !== 'complete') continue
        pairedReviews++
        if (leftResult.issueFound !== rightResult.issueFound) issueDisagreements++
        if (leftResult.outcome !== rightResult.outcome) outcomeDisagreements++
      }
      return {
        caseId: item.id, familyId: item.familyId, jobId: item.jobId, split: item.split,
        assessmentSha256: proposals.get(item.id)!.assessmentSha256,
        leftConfigurationId: left.id, rightConfigurationId: right.id,
        expectedPairs: suite.repetitions, pairedReviews, unpairedReviews: suite.repetitions - pairedReviews,
        complete: pairedReviews === suite.repetitions,
        issueDisagreements, issueDisagreementRate: pairedReviews ? issueDisagreements / pairedReviews : null,
        outcomeDisagreements, outcomeDisagreementRate: pairedReviews ? outcomeDisagreements / pairedReviews : null,
      }
    })))
  return {
    schemaVersion: 1 as const, suiteSha256: evaluationHash(suite), reports,
    verdictStability, configurationComparisons, eligibleForRelease: false,
    limitations: [
      'Labels are separate frozen planted or human judgments, not inferred from reviewer/scorer agreement.',
      'Origins, dataset splits and repetitions are reported separately; repeats are not extra independent labels.',
      'Missing observations and processing failures remain indeterminate and are counted separately.',
      'Model-exposed labels are retained but excluded from independent accuracy counts.',
      'Issue detection is not issue-type classification accuracy, population validity or automatic judge qualification.',
      'Label-free verdict stability and same-repetition configuration disagreement are descriptive, not correctness or harshness. Incomplete panels retain missing and failed counts.',
    ],
  }
}

export function validateFixedJudgeProposals(suite: ScoringSuite, raw: unknown) {
  if (suite.configurations.some(row => row.algorithmVersion !== FIXED_JUDGE_VERSION)) {
    throw new Error('A fixed judge suite cannot mix scoring and reviewing algorithms.')
  }
  const proposals = fixedJudgeProposalSchema.array().min(1).max(500).parse(raw)
  if (new Set(proposals.map(row => row.id)).size !== proposals.length ||
    proposals.length !== suite.cases.length || proposals.some(row => !suite.cases.some(item => item.id === row.id))) {
    throw new Error('Fixed judge proposals must cover every exact case once.')
  }
  return new Map(proposals.map(row => {
    const assessment = parseAnalysisAssessmentOutput(row.assessment)
    if (hashAnalysisAssessment(assessment) !== row.assessmentSha256) {
      throw new Error('Fixed judge proposal contents differ from the frozen assessment proposal hash.')
    }
    return [row.id, { ...row, assessment }]
  }))
}

export function validateFixedJudgeObservations(
  suite: ScoringSuite, proposals: Map<string, FixedJudgeProposal>, raw: unknown,
) {
  const observations = fixedJudgeObservationSchema.array().max(48_000).parse(raw)
  const keys = new Set<string>()
  for (const row of observations) {
    if (row.suiteSha256 !== evaluationHash(suite) ||
      row.assessmentSha256 !== proposals.get(row.caseId)?.assessmentSha256 ||
      !suite.configurations.some(config => config.id === row.configurationId) || row.repetition > suite.repetitions ||
      row.result.status === 'complete' && (row.result.assessmentSha256 !== row.assessmentSha256 ||
        row.result.issueFound !== (row.result.outcome !== 'supported'))) {
      throw new Error('Fixed judge observation differs from the exact frozen suite/proposal or verdict.')
    }
    const key = JSON.stringify([row.caseId, row.configurationId, row.repetition])
    if (keys.has(key)) throw new Error('Duplicate fixed judge observation.')
    keys.add(key)
  }
  return observations
}

export async function executeFixedJudgeSuite(rawSuite: unknown, options: {
  proposals: unknown
  concurrency: number
  signal?: AbortSignal
  priorObservations?: unknown
  execute: (job: ScoringEvaluationJob, signal?: AbortSignal) => Promise<FixedJudgeResult>
  checkpoint: (observation: FixedJudgeObservation) => Promise<void>
  now?: () => number
}) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  const proposals = validateFixedJudgeProposals(suite, options.proposals)
  const observations = validateFixedJudgeObservations(suite, proposals, options.priorObservations ?? [])
  const keys = new Set(observations.map(row => JSON.stringify([row.caseId, row.configurationId, row.repetition])))
  const suiteSha256 = evaluationHash(suite), now = options.now ?? Date.now
  const jobs: ScoringEvaluationJob[] = []
  for (const item of suite.cases) for (const configuration of suite.configurations) {
    for (let repetition = 1; repetition <= suite.repetitions; repetition++) {
      if (!keys.has(JSON.stringify([item.id, configuration.id, repetition]))) {
        jobs.push({ suiteSha256, case: item, configuration, repetition })
      }
    }
  }
  await executeBoundedEvaluationJobs(jobs, {
    concurrency: options.concurrency, signal: options.signal,
    execute: async job => {
      const started = now(), proposal = proposals.get(job.case.id)!
      const result = await options.execute(job, options.signal)
      options.signal?.throwIfAborted()
      const observation = fixedJudgeObservationSchema.parse({
        schemaVersion: 1, suiteSha256, caseId: job.case.id, configurationId: job.configuration.id,
        repetition: job.repetition, assessmentSha256: proposal.assessmentSha256,
        durationMilliseconds: now() - started, result,
      })
      validateFixedJudgeObservations(suite, proposals, [observation])
      await options.checkpoint(observation)
      observations.push(observation)
    },
  })
  return observations
}

export interface FixedJudgeEvaluationOptions extends EvaluationAttemptOptions {
  input: unknown
  assessment: unknown
  assessmentSha256: string
  processingSettings: unknown
  prices: Record<string, unknown>
  model: RubricModelOptions
  admitPaidWork: (job: ScoringEvaluationJob) => Promise<void>
  recordPrivateReview: (result: Awaited<ReturnType<typeof reviewAnalysisAssessment>>) => Promise<void>
  recordPrivateFailure?: (failure: { code: string; stage: string; reason: string | null }) => Promise<void>
}

export function freezeFixedJudgeProposal(id: string, rawInput: unknown, rawAssessment: unknown) {
  const input = validateAnalysisAssessmentInput(rawInput)
  const assessment = validateAnalysisAssessmentForReview(rawAssessment, input)
  return fixedJudgeProposalSchema.parse({ id, assessment, assessmentSha256: hashAnalysisAssessment(assessment) })
}

export function validateFixedJudgeEvaluation(
  job: ScoringEvaluationJob,
  options: Pick<FixedJudgeEvaluationOptions, 'input' | 'assessment' | 'assessmentSha256' | 'processingSettings' | 'prices'>,
) {
  if (job.configuration.algorithmVersion !== FIXED_JUDGE_VERSION) {
    throw new Error('Fixed judge evaluation cannot impersonate a scoring algorithm.')
  }
  const input = validateEvaluationCaseInput(job.case, options.input)
  const assessment = validateAnalysisAssessmentForReview(options.assessment, input)
  if (hashAnalysisAssessment(assessment) !== options.assessmentSha256) {
    throw new Error('Fixed judge requires the exact frozen assessment proposal hash.')
  }
  const { processingSettings, prices } = validateEvaluationModelSettings(job.configuration, options, ['assessmentReview'])
  return { input, assessment, processingSettings, prices }
}

export async function executeFixedJudgeEvaluation(
  job: ScoringEvaluationJob, options: FixedJudgeEvaluationOptions, signal?: AbortSignal,
): Promise<FixedJudgeResult> {
  const { input, assessment, processingSettings, prices } = validateFixedJudgeEvaluation(job, options)
  signal?.throwIfAborted()
  await options.admitPaidWork(job)
  signal?.throwIfAborted()
  const attempts = evaluationAttemptRecorder(processingSettings, prices, options)
  try {
    const result = await reviewAnalysisAssessment(input, assessment, {
      signal, resumeSnapshotSha256: evaluationHash(input.resume),
      targetSnapshotSha256: evaluationHash({ rubric: input.rubric, qualifications: input.qualifications }),
      model: { ...options.model, processingSettings, onModelAttempt: attempts.onModelAttempt },
    })
    if (result.assessmentSha256 !== options.assessmentSha256) {
      throw new Error('Fixed judge changed the proposal identity during review.')
    }
    await options.recordPrivateReview(structuredClone(result))
    signal?.throwIfAborted()
    return fixedJudgeResultSchema.parse({
      status: 'complete', issueFound: result.review.outcome !== 'supported',
      outcome: result.review.outcome, assessmentSha256: result.assessmentSha256,
    })
  } catch (error) {
    attempts.rethrowRecordingFailure()
    if (!(error instanceof AnalysisModelError) || error.cancelled || signal?.aborted) throw error
    await options.recordPrivateFailure?.({ code: error.code, stage: error.stage, reason: error.reason ?? null })
    return { status: 'failed', code: error.code }
  } finally {
    signal?.throwIfAborted()
  }
}
