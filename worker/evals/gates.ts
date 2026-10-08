import { z } from 'zod'
import {
  scoringSuiteSchema, validateReferenceSet, type ScoringObservation, type ScoringReference, type ScoringSuite,
} from './contracts'
import { summarizeScoringSuite, validateObservations, evaluationHash } from './statistics'
import { pairedFamilyBootstrap } from './metrics'
import { costEntrySchema } from './costs'

export const SCORING_ENGINEERING_TARGETS = Object.freeze({
  version: 'score-engineering-targets-v1',
  minimumRepeats: 6,
  minimumFamilies: 20,
  minimumHumanItems: 30,
  completionRate: 0.99,
  pairwiseDisagreement: 0.15,
  pairwiseGreaterThanOne: 0.02,
  medianOverallSd: 2,
  p95OverallRange: 5,
  humanMeanAbsoluteError: 0.5,
})

export type ScoringTargetKind = 'job' | 'grade'
const INVARIANCE_KINDS = ['identity-only', 'irrelevant-detail', 'paraphrase', 'format'] as const
type InvarianceKind = typeof INVARIANCE_KINDS[number]

export interface ScoringEngineeringTargetsV2 {
  readonly version: 'score-engineering-targets-v2'
  /** A draft never meets the targets: the baseline sets every null threshold before any candidate runs. */
  readonly status: 'draft' | 'frozen'
  readonly inherits: typeof SCORING_ENGINEERING_TARGETS.version
  readonly minimumRepeats: number
  readonly minimumFamilies: number
  readonly minimumTargets: number
  readonly minimumHumanItems: number
  readonly completionRate: number
  readonly pairwiseDisagreement: number
  readonly pairwiseGreaterThanOne: number
  readonly medianOverallSd: number
  readonly p95OverallRange: number
  readonly humanMeanAbsoluteError: number
  /** Stability checks apply separately to every listed rubric kind. */
  readonly targetKinds: readonly ScoringTargetKind[]
  readonly rubricGeneration: { readonly minimumRepeats: number; readonly minimumSources: number; readonly validRate: number }
  readonly reviewer: {
    readonly maximumVerdictFlipRate: number
    readonly minimumPlantedRecall: number
    readonly maximumDirectionGap: number | null
  }
  readonly monotonicity: { readonly maximumNegativeMeanCriteria: number; readonly maximumLargeDecreases: number }
  readonly invariance: { readonly kinds: readonly InvarianceKind[]; readonly maximumExcessDisagreement: number | null }
  readonly crossModel: { readonly maximumMeanCriterionGap: number | null; readonly maximumMeanOverallGap: number | null }
  readonly costLatency: {
    readonly maximumMeanUsdMicrosPerAnalysis: number | null
    readonly maximumP95AnalysisMilliseconds: number | null
  }
}

const fraction = z.number().finite().min(0).max(1)
const count = z.number().int().nonnegative()
export const scoringTargetsV2Schema = z.strictObject({
  version: z.literal('score-engineering-targets-v2'),
  status: z.enum(['draft', 'frozen']),
  inherits: z.literal(SCORING_ENGINEERING_TARGETS.version),
  minimumRepeats: z.number().int().min(2).max(12),
  minimumFamilies: z.number().int().positive(),
  minimumTargets: z.number().int().positive(),
  minimumHumanItems: z.number().int().positive(),
  completionRate: fraction,
  pairwiseDisagreement: fraction,
  pairwiseGreaterThanOne: fraction,
  medianOverallSd: z.number().finite().nonnegative(),
  p95OverallRange: z.number().finite().nonnegative(),
  humanMeanAbsoluteError: z.number().finite().nonnegative(),
  targetKinds: z.array(z.enum(['job', 'grade'])).min(1).max(2),
  rubricGeneration: z.strictObject({
    minimumRepeats: z.number().int().min(1).max(12), minimumSources: z.number().int().positive(), validRate: fraction,
  }),
  reviewer: z.strictObject({
    maximumVerdictFlipRate: fraction, minimumPlantedRecall: fraction, maximumDirectionGap: fraction.nullable(),
  }),
  monotonicity: z.strictObject({ maximumNegativeMeanCriteria: count, maximumLargeDecreases: count }),
  invariance: z.strictObject({ kinds: z.array(z.enum(INVARIANCE_KINDS)).min(1).max(4), maximumExcessDisagreement: fraction.nullable() }),
  crossModel: z.strictObject({
    maximumMeanCriterionGap: z.number().finite().min(0).max(5).nullable(),
    maximumMeanOverallGap: z.number().finite().min(0).max(100).nullable(),
  }),
  costLatency: z.strictObject({
    maximumMeanUsdMicrosPerAnalysis: count.nullable(), maximumP95AnalysisMilliseconds: z.number().int().positive().nullable(),
  }),
}).superRefine((targets, context) => {
  const unset = [
    targets.reviewer.maximumDirectionGap, targets.invariance.maximumExcessDisagreement,
    targets.crossModel.maximumMeanCriterionGap, targets.crossModel.maximumMeanOverallGap,
    targets.costLatency.maximumMeanUsdMicrosPerAnalysis, targets.costLatency.maximumP95AnalysisMilliseconds,
  ].some(value => value === null)
  if (targets.status === 'frozen' && unset) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Frozen targets cannot leave a threshold unset.' })
  }
  if (new Set(targets.targetKinds).size !== targets.targetKinds.length || new Set(targets.invariance.kinds).size !== targets.invariance.kinds.length) {
    context.addIssue({ code: 'custom', message: 'Target and invariance kinds must be unique.' })
  }
})

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/**
 * Brief section 4 additions, applied to job and GS grade rubrics. It stays a draft until the recorded baseline
 * fills the noise-dependent thresholds (direction gap, invariance excess, cross-model gap, cost and latency).
 */
export const SCORING_ENGINEERING_TARGETS_V2: ScoringEngineeringTargetsV2 = deepFreeze({
  version: 'score-engineering-targets-v2',
  status: 'draft',
  inherits: SCORING_ENGINEERING_TARGETS.version,
  minimumRepeats: 6,
  minimumFamilies: 20,
  minimumTargets: 4,
  minimumHumanItems: 30,
  completionRate: 0.99,
  pairwiseDisagreement: 0.15,
  pairwiseGreaterThanOne: 0.02,
  medianOverallSd: 2,
  p95OverallRange: 5,
  humanMeanAbsoluteError: 0.5,
  targetKinds: ['job', 'grade'],
  rubricGeneration: { minimumRepeats: 6, minimumSources: 4, validRate: 1 },
  reviewer: { maximumVerdictFlipRate: 0.1, minimumPlantedRecall: 1, maximumDirectionGap: null },
  monotonicity: { maximumNegativeMeanCriteria: 0, maximumLargeDecreases: 0 },
  invariance: { kinds: ['identity-only', 'format', 'irrelevant-detail'], maximumExcessDisagreement: null },
  crossModel: { maximumMeanCriterionGap: null, maximumMeanOverallGap: null },
  costLatency: { maximumMeanUsdMicrosPerAnalysis: null, maximumP95AnalysisMilliseconds: null },
})

export const SCORING_ENGINEERING_TARGET_SETS = Object.freeze({
  [SCORING_ENGINEERING_TARGETS.version]: SCORING_ENGINEERING_TARGETS,
  [SCORING_ENGINEERING_TARGETS_V2.version]: SCORING_ENGINEERING_TARGETS_V2,
})
export type ScoringEngineeringTargetsVersion = keyof typeof SCORING_ENGINEERING_TARGET_SETS

export function scoringEngineeringTargets(version: string) {
  if (!Object.hasOwn(SCORING_ENGINEERING_TARGET_SETS, version)) throw new Error(`Unknown engineering targets version "${version}".`)
  return SCORING_ENGINEERING_TARGET_SETS[version as ScoringEngineeringTargetsVersion]
}

type GateCheckStatus = 'passed' | 'failed' | 'insufficient'
export interface ScoringGateCheck {
  id: string
  actual: number | null
  required: number | null
  status: GateCheckStatus
  /** Why a check is undecided, such as an unset draft threshold or a panel that wasn't supplied. */
  note?: string
}

function gateChecks() {
  const checks: ScoringGateCheck[] = []
  const add = (id: string, actual: number | null, required: number | null, status: GateCheckStatus, note?: string) => {
    checks.push({ id, actual, required, status, ...(note === undefined ? {} : { note }) })
  }
  return {
    checks,
    /** Unknown measurements and unset thresholds are insufficient; exceeding the limit fails. */
    maximum(id: string, actual: number | null, required: number | null, note?: string) {
      add(id, actual, required, required === null || actual === null ? 'insufficient' : actual <= required ? 'passed' : 'failed',
        required === null ? note ?? 'target-not-frozen' : note)
    },
    /** Sample-size floors: too little evidence can't pass, but isn't evidence of failure. */
    minimum(id: string, actual: number, required: number, note?: string) {
      add(id, actual, required, actual >= required ? 'passed' : 'insufficient', note)
    },
    /** Quality floors: falling short fails. */
    atLeast(id: string, actual: number | null, required: number | null, note?: string) {
      add(id, actual, required, required === null || actual === null ? 'insufficient' : actual >= required ? 'passed' : 'failed',
        required === null ? note ?? 'target-not-frozen' : note)
    },
  }
}
type GateBuilder = ReturnType<typeof gateChecks>

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
function quantile(values: number[], percentile: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * percentile
  const lower = Math.floor(position)
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
}

const panelId = z.string().min(1).max(160)
const attemptCostSchema = z.strictObject({
  caseId: panelId, configurationId: panelId, repetition: z.number().int().min(1).max(12),
  amountUsdMicros: count.nullable(),
})
export type ScoringAttemptCost = z.infer<typeof attemptCostSchema>

/** Joins the runner's model-attempts.jsonl rows with the program cost ledger; unpriced attempts stay null. */
export function joinAttemptCosts(rawAttempts: unknown, rawLedger: unknown): ScoringAttemptCost[] {
  const attempts = z.array(z.object({
    id: z.string().min(1).max(200),
    evaluation: z.object({ caseId: panelId, configurationId: panelId, repetition: z.number().int().min(1).max(12) }),
  })).max(200_000).parse(rawAttempts)
  const amounts = new Map<string, number | null>()
  for (const entry of costEntrySchema.array().max(200_000).parse(rawLedger)) {
    if (amounts.has(entry.id)) throw new Error('Cost-ledger entry IDs must be unique.')
    amounts.set(entry.id, entry.amountUsdMicros)
  }
  const seen = new Set<string>()
  return attempts.map(attempt => {
    const amountUsdMicros = amounts.get(attempt.id)
    if (amountUsdMicros === undefined || seen.has(attempt.id)) throw new Error('Every model attempt needs exactly one cost-ledger entry.')
    seen.add(attempt.id)
    return attemptCostSchema.parse({ ...attempt.evaluation, amountUsdMicros })
  })
}

const judgeTally = z.object({ failed: count, truePositive: count, falseNegative: count, falsePositive: count, trueNegative: count })
const rubricGenerationReportSchema = z.object({
  schemaVersion: z.literal(1),
  cells: z.array(z.object({
    sourceId: panelId, configurationId: panelId, expected: count, completed: count, failed: count, missing: count,
  })).min(1),
})
const fixedJudgeReportSchema = z.object({
  schemaVersion: z.literal(1),
  reports: z.array(z.object({
    configurationId: panelId, origin: z.enum(['planted', 'human-reviewed']),
    statistics: z.object({
      all: judgeTally,
      byExpectedIssue: z.object({
        none: judgeTally, 'over-credit': judgeTally, 'under-credit': judgeTally, 'unsupported-fact': judgeTally,
      }),
    }).nullable(),
  })),
  verdictStability: z.array(z.object({
    configurationId: panelId, complete: z.boolean(), pairs: count, issueDisagreements: count, outcomeDisagreements: count,
  })),
})
const monotonicityReportSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(z.object({
    configurationId: panelId, complete: z.boolean(), independent: z.boolean(),
    criteria: z.array(z.object({
      eligibleForIndependentDiagnostic: z.boolean(), meanSignedDelta: z.number().finite().nullable(), decreasesGreaterThanOne: count,
    })),
  })),
})
const invarianceReportSchema = z.object({
  schemaVersion: z.literal(1),
  noiseFloor: z.array(z.object({
    configurationId: panelId, kind: z.enum(INVARIANCE_KINDS), completePanels: count,
    metrics: z.array(z.object({ metric: z.string(), familyMeanExcess: z.number().finite().nullable() })),
  })),
})
const panelsSchema = z.strictObject({
  rubricGeneration: z.array(z.strictObject({
    targetKind: z.enum(['job', 'grade']), configurationId: panelId, report: z.unknown(),
  })).max(2).optional(),
  fixedJudge: z.strictObject({ configurationId: panelId, report: z.unknown() }).optional(),
  monotonicity: z.strictObject({ configurationId: panelId, report: z.unknown() }).optional(),
  invariance: z.strictObject({ configurationId: panelId, report: z.unknown() }).optional(),
  crossModel: z.strictObject({ leftConfigurationId: panelId, rightConfigurationId: panelId }).optional(),
  attemptCosts: attemptCostSchema.array().max(200_000).optional(),
})
type ScoringGatePanels = z.infer<typeof panelsSchema>

const EXTERNAL_GATES = [
  'Four exact reference-rubric versions signed off before scored conclusions.',
  'Independent AI references and fixed-assessment judge calibration, including accepted and rejected cases.',
  'Planted critical-evidence recovery, format preservation and identity perturbation versus identical-run noise.',
  'Candidate frozen before holdout; holdout outcomes not used for tuning.',
  'Compatible API/worker readers, Admin admission, security and explicit production promotion.',
]
const LIMITATIONS = [
  'Engineering checks never activate a configuration or certify employment validity or population fairness.',
  'Model-assisted and model-exposed human labels cannot satisfy blind-human gates.',
  'Paired human error intervals cluster by resume family; repeats are not independent labels.',
  'A lower rejection rate or a higher mean score is not a quality gate.',
]

function humanErrorChecks(
  suite: ScoringSuite, observations: ScoringObservation[], references: ScoringReference[],
  baselineId: string, candidateId: string, targets: { minimumHumanItems: number; humanMeanAbsoluteError: number }, gate: GateBuilder,
) {
  const human = references.filter(row => row.origin === 'human-reviewed' && row.independent && row.score !== null)
  gate.minimum('blind-determinate-human-items', human.length, targets.minimumHumanItems)
  const pairs = human.flatMap(reference => {
    const meanError = (configurationId: string) => {
      const selected = observations.filter(row => row.configurationId === configurationId && row.caseId === reference.caseId)
      if (selected.length !== suite.repetitions) return null
      const scores = selected.flatMap(row => row.result.status === 'complete'
        ? row.result.criteria.filter(row => row.criterionId === reference.criterionId && row.score !== null).map(row => row.score!)
        : [])
      return scores.length === suite.repetitions
        ? scores.reduce((sum, score) => sum + Math.abs(score - reference.score!), 0) / scores.length : null
    }
    const baseline = meanError(baselineId), value = meanError(candidateId)
    const item = suite.cases.find(row => row.id === reference.caseId)!
    return baseline === null || value === null ? [] : [{
      id: reference.id, familyId: item.familyId, baseline, candidate: value,
    }]
  })
  gate.minimum('paired-human-items', pairs.length, human.length || targets.minimumHumanItems)
  gate.maximum('human-anchor-mae', pairs.length ? pairs.reduce((sum, row) => sum + row.candidate, 0) / pairs.length : null, targets.humanMeanAbsoluteError)
  const interval = pairs.length >= 2 && new Set(pairs.map(row => row.familyId)).size >= 2
    ? pairedFamilyBootstrap(pairs, { seed: `${evaluationHash(suite)}-human-errors`, repetitions: 2000 }) : null
  gate.maximum('human-error-increase-upper95', interval?.upper95 ?? null, 0)
  return { human, interval }
}

function jobCoverage(suite: ScoringSuite, observations: ScoringObservation[], candidateId: string, human: ScoringReference[]) {
  return [...new Set(suite.cases.map(row => row.jobId))].sort().map(jobId => {
    const cases = suite.cases.filter(row => row.jobId === jobId)
    const selected = observations.filter(row => row.configurationId === candidateId && cases.some(item => item.id === row.caseId))
    return {
      jobId, expected: cases.length * suite.repetitions, observed: selected.length,
      complete: selected.filter(row => row.result.status === 'complete').length,
      blindHumanItems: human.filter(row => cases.some(item => item.id === row.caseId)).length,
    }
  })
}

export interface ScoringGateOptions {
  /** A registered targets version. Omitted means score-engineering-targets-v1. */
  targetsVersion?: string
  /** What-if thresholds for setting the frozen values; changed targets can never meet the measured targets. */
  targets?: unknown
  /** Separately produced panel reports and their configuration bindings (v2 and later). */
  panels?: unknown
}

export function evaluateScoringEngineeringGates(
  rawSuite: unknown, rawObservations: unknown, rawReferences: unknown,
  baselineId: string, candidateId: string, options: ScoringGateOptions = {},
) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  if (baselineId === candidateId || ![baselineId, candidateId].every(id => suite.configurations.some(row => row.id === id))) {
    throw new Error('Engineering gates require two distinct frozen configurations.')
  }
  const observations = validateObservations(suite, rawObservations)
  const references = validateReferenceSet(suite, rawReferences)
  const registered = scoringEngineeringTargets(options.targetsVersion ?? SCORING_ENGINEERING_TARGETS.version)
  if (registered.version === SCORING_ENGINEERING_TARGETS.version) {
    if (options.panels !== undefined || options.targets !== undefined) {
      throw new Error('Panel reports and what-if targets need score-engineering-targets-v2 or later.')
    }
    return evaluateTargetsV1(suite, observations, references, baselineId, candidateId)
  }
  const normalizedRegistered = scoringTargetsV2Schema.parse(registered)
  const targets = options.targets === undefined ? normalizedRegistered : scoringTargetsV2Schema.parse(options.targets)
  if (targets.version !== registered.version) throw new Error('What-if targets must keep the selected targets version.')
  const exact = evaluationHash(targets) === evaluationHash(normalizedRegistered)
  return evaluateTargetsV2(suite, observations, references, baselineId, candidateId, targets, exact, panelsSchema.parse(options.panels ?? {}))
}

function evaluateTargetsV1(
  suite: ScoringSuite, observations: ScoringObservation[], references: ScoringReference[], baselineId: string, candidateId: string,
) {
  const report = summarizeScoringSuite(suite, observations)
  const candidate = report.reports.find(row => row.configurationId === candidateId && row.split === 'all')!
  const targets = SCORING_ENGINEERING_TARGETS
  const gate = gateChecks()
  gate.minimum('repetitions', suite.repetitions, targets.minimumRepeats)
  gate.minimum('resume-families', new Set(suite.cases.map(row => row.familyId)).size, targets.minimumFamilies)
  gate.minimum('jobs', new Set(suite.cases.map(row => row.jobId)).size, 4)
  gate.minimum('saved-observations', candidate.observed, candidate.expected)
  gate.maximum('completion-failure-rate', candidate.completionRate === null ? null : 1 - candidate.completionRate, 1 - targets.completionRate)
  gate.maximum('criterion-pairwise-disagreement', candidate.pairwiseDisagreement, targets.pairwiseDisagreement)
  gate.maximum('criterion-large-disagreement', candidate.pairwiseGreaterThanOne, targets.pairwiseGreaterThanOne)
  gate.maximum('median-overall-sd', candidate.medianOverallSd, targets.medianOverallSd)
  gate.maximum('p95-overall-range', candidate.p95OverallRange, targets.p95OverallRange)
  // Null criterion outcomes must not make an incomplete panel look more stable.
  gate.maximum('incomplete-criterion-items', candidate.incompleteItems, 0)
  const { human, interval } = humanErrorChecks(suite, observations, references, baselineId, candidateId, targets, gate)
  return {
    schemaVersion: 1 as const, suiteSha256: evaluationHash(suite), targets, baselineId, candidateId,
    checks: gate.checks, byJob: jobCoverage(suite, observations, candidateId, human), humanErrorDifference: interval,
    measuredTargetsMet: gate.checks.every(row => row.status === 'passed'),
    eligibleForRelease: false,
    requiredExternalGates: [...EXTERNAL_GATES],
    limitations: [...LIMITATIONS],
  }
}

type SuiteReport = ReturnType<typeof summarizeScoringSuite>['reports'][number]
const targetKindOf = (item: ScoringSuite['cases'][number]): ScoringTargetKind => item.targetKind ?? 'job'

function targetKindStability(
  suite: ScoringSuite, report: SuiteReport, observations: ScoringObservation[], candidateId: string, targetKind: ScoringTargetKind,
) {
  const cases = suite.cases.filter(item => targetKindOf(item) === targetKind)
  const ids = new Set(cases.map(item => item.id))
  const items = report.items.filter(item => ids.has(item.caseId))
  const overall = report.overall.filter(item => ids.has(item.caseId))
  const selected = observations.filter(row => row.configurationId === candidateId && ids.has(row.caseId))
  const expected = cases.length * suite.repetitions
  const complete = selected.filter(row => row.result.status === 'complete').length
  return {
    targetKind, cases: cases.length,
    families: new Set(cases.map(item => item.familyId)).size, targets: new Set(cases.map(item => item.jobId)).size,
    expected, observed: selected.length, complete, completionRate: expected ? complete / expected : null,
    pairwiseDisagreement: mean(items.flatMap(item => item.pairwiseDisagreement === null ? [] : [item.pairwiseDisagreement])),
    pairwiseGreaterThanOne: mean(items.flatMap(item => item.pairwiseGreaterThanOne === null ? [] : [item.pairwiseGreaterThanOne])),
    incompleteItems: items.filter(item => !item.excluded && item.scoredRepetitions < suite.repetitions).length,
    medianOverallSd: quantile(overall.flatMap(item => item.sd === null ? [] : [item.sd]), 0.5),
    p95OverallRange: quantile(overall.flatMap(item => item.range === null ? [] : [item.range]), 0.95),
  }
}

/** Same locked rubric and inputs, two model configurations: complete repeats only, never averaged into a score. */
function crossModelGap(
  suite: ScoringSuite, observations: ScoringObservation[], leftConfigurationId: string, rightConfigurationId: string,
) {
  let incompleteItems = 0
  const absolute: number[] = [], signed: number[] = [], overall: number[] = []
  const completed = (configurationId: string, caseId: string) => observations.flatMap(row =>
    row.configurationId === configurationId && row.caseId === caseId && row.result.status === 'complete' ? [row.result] : [])
  for (const item of suite.cases) {
    const left = completed(leftConfigurationId, item.id), right = completed(rightConfigurationId, item.id)
    for (const criterionId of item.criterionIds) {
      if (item.excludedCriterionIds?.includes(criterionId)) continue
      const scores = (results: typeof left) => results.flatMap(result => {
        const score = result.criteria.find(row => row.criterionId === criterionId)?.score
        return score === null || score === undefined ? [] : [score]
      })
      const a = scores(left), b = scores(right)
      if (a.length !== suite.repetitions || b.length !== suite.repetitions) { incompleteItems++; continue }
      const difference = mean(a)! - mean(b)!
      absolute.push(Math.abs(difference))
      signed.push(difference)
    }
    const totals = (results: typeof left) => results.flatMap(result => result.overall === null ? [] : [result.overall])
    const a = totals(left), b = totals(right)
    if (a.length === suite.repetitions && b.length === suite.repetitions) overall.push(Math.abs(mean(a)! - mean(b)!))
  }
  return {
    leftConfigurationId, rightConfigurationId, comparedCriterionItems: absolute.length, incompleteItems,
    meanCriterionGap: mean(absolute), meanSignedCriterionDifference: mean(signed),
    comparedCases: overall.length, meanOverallGap: mean(overall),
  }
}

function analysisCosts(observations: ScoringObservation[], candidateId: string, attemptCosts: ScoringAttemptCost[]) {
  const totals = new Map<string, number | null>()
  for (const row of attemptCosts) {
    if (row.configurationId !== candidateId) continue
    const key = JSON.stringify([row.caseId, row.repetition])
    const previous = totals.get(key)
    totals.set(key, previous === null || row.amountUsdMicros === null ? null : (previous ?? 0) + row.amountUsdMicros)
  }
  const analyses = observations.filter(row => row.configurationId === candidateId)
  const values = analyses.map(row => totals.get(JSON.stringify([row.caseId, row.repetition])))
  const priced = values.filter((value): value is number => typeof value === 'number')
  const unpriced = values.filter(value => value === null).length
  const withoutAttempts = values.filter(value => value === undefined).length
  return {
    analyses: analyses.length, priced: priced.length, unpriced, withoutAttempts,
    meanUsdMicros: unpriced || withoutAttempts ? null : mean(priced),
  }
}

function rubricGenerationChecks(targets: ScoringEngineeringTargetsV2, panels: NonNullable<ScoringGatePanels['rubricGeneration']>, gate: GateBuilder) {
  for (const targetKind of targets.targetKinds) {
    const selected = panels.filter(row => row.targetKind === targetKind)
    if (selected.length > 1) throw new Error('Supply at most one rubric-generation report per target kind.')
    const panel = selected[0]
    if (!panel) {
      gate.atLeast(`rubric-generation-valid-rate:${targetKind}`, null, targets.rubricGeneration.validRate, 'panel-not-supplied')
      continue
    }
    const cells = rubricGenerationReportSchema.parse(panel.report).cells.filter(row => row.configurationId === panel.configurationId)
    if (!cells.length) throw new Error('The rubric-generation report lacks the candidate generator configuration.')
    const expected = cells.reduce((sum, row) => sum + row.expected, 0)
    const completed = cells.reduce((sum, row) => sum + row.completed, 0)
    const missing = cells.reduce((sum, row) => sum + row.missing, 0)
    gate.minimum(`rubric-generation-repeats:${targetKind}`, Math.min(...cells.map(row => row.expected)), targets.rubricGeneration.minimumRepeats)
    gate.minimum(`rubric-generation-sources:${targetKind}`, new Set(cells.map(row => row.sourceId)).size, targets.rubricGeneration.minimumSources)
    gate.atLeast(`rubric-generation-valid-rate:${targetKind}`, missing || !expected ? null : completed / expected,
      targets.rubricGeneration.validRate, missing ? 'missing-generations' : undefined)
  }
}

function reviewerChecks(
  targets: ScoringEngineeringTargetsV2, panel: ScoringGatePanels['fixedJudge'], gate: GateBuilder,
  reported: Array<{ id: string; value: number | null }>,
) {
  if (!panel) {
    gate.maximum('reviewer-verdict-flip-rate', null, targets.reviewer.maximumVerdictFlipRate, 'panel-not-supplied')
    gate.atLeast('reviewer-planted-recall', null, targets.reviewer.minimumPlantedRecall, 'panel-not-supplied')
    gate.maximum('reviewer-direction-gap', null, targets.reviewer.maximumDirectionGap, 'panel-not-supplied')
    return
  }
  const report = fixedJudgeReportSchema.parse(panel.report)
  const stability = report.verdictStability.filter(row => row.configurationId === panel.configurationId)
  if (!stability.length) throw new Error('The fixed-judge report lacks the candidate reviewer configuration.')
  const pairs = stability.reduce((sum, row) => sum + row.pairs, 0)
  const complete = stability.every(row => row.complete)
  // A flip is a repeat that disagrees about whether the identical proposal has an issue.
  gate.maximum('reviewer-verdict-flip-rate', complete && pairs ? stability.reduce((sum, row) => sum + row.issueDisagreements, 0) / pairs : null,
    targets.reviewer.maximumVerdictFlipRate, complete ? undefined : 'incomplete-panels')
  reported.push({
    id: 'reviewer-outcome-flip-rate',
    value: complete && pairs ? stability.reduce((sum, row) => sum + row.outcomeDisagreements, 0) / pairs : null,
  })
  type Statistics = NonNullable<z.infer<typeof fixedJudgeReportSchema>['reports'][number]['statistics']>
  const planted = report.reports.flatMap(row =>
    row.configurationId === panel.configurationId && row.origin === 'planted' && row.statistics ? [row.statistics] : [])
  const recall = (select: (statistics: Statistics) => z.infer<typeof judgeTally>) => {
    const tally = planted.map(select).reduce((sum, row) => ({
      failed: sum.failed + row.failed, found: sum.found + row.truePositive, missed: sum.missed + row.falseNegative,
    }), { failed: 0, found: 0, missed: 0 })
    // Failed or missing reviews are indeterminate, never silent misses or detections.
    return tally.failed || !(tally.found + tally.missed) ? null : tally.found / (tally.found + tally.missed)
  }
  const failed = planted.reduce((sum, row) => sum + row.all.failed, 0)
  gate.atLeast('reviewer-planted-recall', recall(row => row.all), targets.reviewer.minimumPlantedRecall,
    !planted.length ? 'no-planted-labels' : failed ? 'failed-or-missing-reviews' : undefined)
  const over = recall(row => row.byExpectedIssue['over-credit']), under = recall(row => row.byExpectedIssue['under-credit'])
  gate.maximum('reviewer-direction-gap', over === null || under === null ? null : Math.abs(over - under), targets.reviewer.maximumDirectionGap)
  const valid = report.reports.flatMap(row => row.configurationId === panel.configurationId && row.statistics ? [row.statistics.byExpectedIssue.none] : [])
  const falseCorrections = valid.reduce((sum, row) => sum + row.falsePositive, 0)
  const validReviews = falseCorrections + valid.reduce((sum, row) => sum + row.trueNegative, 0)
  reported.push(
    { id: 'reviewer-recall-over-credit', value: over },
    { id: 'reviewer-recall-under-credit', value: under },
    { id: 'reviewer-recall-unsupported-fact', value: recall(row => row.byExpectedIssue['unsupported-fact']) },
    { id: 'reviewer-false-correction-rate', value: validReviews ? falseCorrections / validReviews : null },
  )
}

function monotonicityChecks(targets: ScoringEngineeringTargetsV2, panel: ScoringGatePanels['monotonicity'], gate: GateBuilder) {
  if (!panel) {
    gate.maximum('monotonicity-negative-mean-criteria', null, targets.monotonicity.maximumNegativeMeanCriteria, 'panel-not-supplied')
    gate.maximum('monotonicity-large-decreases', null, targets.monotonicity.maximumLargeDecreases, 'panel-not-supplied')
    return
  }
  const items = monotonicityReportSchema.parse(panel.report).items.filter(row => row.configurationId === panel.configurationId)
  if (!items.length) throw new Error('The monotonicity report lacks the candidate configuration.')
  const eligible = items.filter(row => row.complete && row.independent)
    .flatMap(row => row.criteria.filter(criterion => criterion.eligibleForIndependentDiagnostic))
  const note = eligible.length ? undefined : 'no-complete-independent-pairs'
  gate.maximum('monotonicity-negative-mean-criteria',
    eligible.length ? eligible.filter(row => row.meanSignedDelta !== null && row.meanSignedDelta < 0).length : null,
    targets.monotonicity.maximumNegativeMeanCriteria, note)
  gate.maximum('monotonicity-large-decreases',
    eligible.length ? eligible.reduce((sum, row) => sum + row.decreasesGreaterThanOne, 0) : null,
    targets.monotonicity.maximumLargeDecreases, note)
}

function invarianceChecks(targets: ScoringEngineeringTargetsV2, panel: ScoringGatePanels['invariance'], gate: GateBuilder) {
  if (!panel) {
    gate.maximum('invariance-excess-disagreement', null, targets.invariance.maximumExcessDisagreement, 'panel-not-supplied')
    return
  }
  const rows = invarianceReportSchema.parse(panel.report).noiseFloor.filter(row => row.configurationId === panel.configurationId)
  if (!rows.length) throw new Error('The invariance report lacks the candidate configuration.')
  const complete = rows.filter(row => targets.invariance.kinds.includes(row.kind) && row.completePanels > 0)
  const missingKinds = targets.invariance.kinds.filter(kind => !complete.some(row => row.kind === kind))
  const excess = complete.flatMap(row => row.metrics.flatMap(metric =>
    metric.metric === 'disagreement' && metric.familyMeanExcess !== null ? [metric.familyMeanExcess] : []))
  gate.maximum('invariance-excess-disagreement', missingKinds.length || !excess.length ? null : Math.max(...excess),
    targets.invariance.maximumExcessDisagreement, missingKinds.length ? `missing-kinds:${missingKinds.join(',')}` : undefined)
}

function evaluateTargetsV2(
  suite: ScoringSuite, observations: ScoringObservation[], references: ScoringReference[], baselineId: string, candidateId: string,
  targets: ScoringEngineeringTargetsV2, targetsRegistered: boolean, panels: ScoringGatePanels,
) {
  const report = summarizeScoringSuite(suite, observations)
  const candidate = report.reports.find(row => row.configurationId === candidateId && row.split === 'all')!
  const gate = gateChecks()
  const reportedMetrics: Array<{ id: string; value: number | null }> = []
  gate.minimum('repetitions', suite.repetitions, targets.minimumRepeats)
  gate.minimum('saved-observations', candidate.observed, candidate.expected)
  const byTargetKind = targets.targetKinds.map(kind => targetKindStability(suite, candidate, observations, candidateId, kind))
  for (const row of byTargetKind) {
    const kind = row.targetKind
    gate.minimum(`target-cases:${kind}`, row.cases, 1)
    gate.minimum(`resume-families:${kind}`, row.families, targets.minimumFamilies)
    gate.minimum(`targets:${kind}`, row.targets, targets.minimumTargets)
    gate.maximum(`completion-failure-rate:${kind}`, row.completionRate === null ? null : 1 - row.completionRate, 1 - targets.completionRate)
    gate.maximum(`criterion-pairwise-disagreement:${kind}`, row.pairwiseDisagreement, targets.pairwiseDisagreement)
    gate.maximum(`criterion-large-disagreement:${kind}`, row.pairwiseGreaterThanOne, targets.pairwiseGreaterThanOne)
    gate.maximum(`median-overall-sd:${kind}`, row.medianOverallSd, targets.medianOverallSd)
    gate.maximum(`p95-overall-range:${kind}`, row.p95OverallRange, targets.p95OverallRange)
    // Null criterion outcomes must not make an incomplete panel look more stable.
    gate.maximum(`incomplete-criterion-items:${kind}`, row.cases ? row.incompleteItems : null, 0)
  }
  const { human, interval } = humanErrorChecks(suite, observations, references, baselineId, candidateId, targets, gate)
  rubricGenerationChecks(targets, panels.rubricGeneration ?? [], gate)
  reviewerChecks(targets, panels.fixedJudge, gate, reportedMetrics)
  monotonicityChecks(targets, panels.monotonicity, gate)
  invarianceChecks(targets, panels.invariance, gate)
  let crossModel: ReturnType<typeof crossModelGap> | null = null
  if (panels.crossModel) {
    const { leftConfigurationId, rightConfigurationId } = panels.crossModel
    if (leftConfigurationId === rightConfigurationId ||
      ![leftConfigurationId, rightConfigurationId].every(id => suite.configurations.some(row => row.id === id))) {
      throw new Error('The cross-model gap compares two distinct frozen configurations of the same suite.')
    }
    crossModel = crossModelGap(suite, observations, leftConfigurationId, rightConfigurationId)
  }
  const crossModelNote = crossModel ? crossModel.incompleteItems ? 'incomplete-items' : undefined : 'panel-not-supplied'
  gate.maximum('cross-model-criterion-gap', crossModel && !crossModel.incompleteItems ? crossModel.meanCriterionGap : null,
    targets.crossModel.maximumMeanCriterionGap, crossModelNote)
  gate.maximum('cross-model-overall-gap', crossModel && !crossModel.incompleteItems ? crossModel.meanOverallGap : null,
    targets.crossModel.maximumMeanOverallGap, crossModelNote)
  gate.maximum('analysis-p95-milliseconds', candidate.p95Milliseconds, targets.costLatency.maximumP95AnalysisMilliseconds)
  const costs = panels.attemptCosts ? analysisCosts(observations, candidateId, panels.attemptCosts) : null
  gate.maximum('analysis-mean-usd-micros', costs?.meanUsdMicros ?? null, targets.costLatency.maximumMeanUsdMicrosPerAnalysis,
    costs ? costs.meanUsdMicros === null ? 'unpriced-or-unmatched-analyses' : undefined : 'panel-not-supplied')
  reportedMetrics.push({ id: 'analysis-p50-milliseconds', value: candidate.p50Milliseconds })
  return {
    schemaVersion: 2 as const, suiteSha256: evaluationHash(suite), targets, targetsStatus: targets.status, targetsRegistered,
    baselineId, candidateId, checks: gate.checks, byJob: jobCoverage(suite, observations, candidateId, human), byTargetKind,
    crossModel, costs, reportedMetrics, humanErrorDifference: interval,
    // Draft or changed thresholds can describe a run, never qualify it.
    measuredTargetsMet: targets.status === 'frozen' && targetsRegistered && gate.checks.every(row => row.status === 'passed'),
    eligibleForRelease: false,
    requiredExternalGates: [
      ...EXTERNAL_GATES,
      'Registered, frozen v2 thresholds set from the recorded baseline before any candidate run.',
    ],
    limitations: [
      ...LIMITATIONS,
      'Rubric-generation, reviewer, monotonicity and invariance checks read separately produced panel reports bound by configuration ID.',
      'Reviewer direction balance compares planted over-credit and under-credit recall; it does not classify realistic review findings.',
    ],
  }
}

