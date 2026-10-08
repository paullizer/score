import { createHash } from 'node:crypto'
import {
  scoringObservationSchema, scoringSuiteSchema, validateReferenceSet,
  type ScoringObservation, type ScoringReference, type ScoringSuite,
} from './contracts'

export function evaluationHash(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('An evaluation artifact must be JSON serializable.')
  return createHash('sha256').update(serialized).digest('hex')
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function quantile(values: number[], percentile: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * percentile
  const lower = Math.floor(position)
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
}

export function ordinalRepeatStatistics(scores: (number | null)[]) {
  const values = scores.filter((value): value is number => value !== null)
  if (values.some(value => !Number.isInteger(value) || value < 0 || value > 5)) {
    throw new Error('Repeat scores must be integer anchors from zero through five or null.')
  }
  let pairs = 0, disagreements = 0, greaterThanOne = 0
  for (let left = 0; left < values.length; left++) for (let right = left + 1; right < values.length; right++) {
    pairs++
    const difference = Math.abs(values[left] - values[right])
    if (difference > 0) disagreements++
    if (difference > 1) greaterThanOne++
  }
  return {
    repetitions: scores.length, scoredRepetitions: values.length, missingRepetitions: scores.length - values.length,
    pairs, disagreements, greaterThanOne,
    pairwiseDisagreement: pairs ? disagreements / pairs : null,
    pairwiseGreaterThanOne: pairs ? greaterThanOne / pairs : null,
    anyChange: pairs ? disagreements > 0 : null,
  }
}

export function validateObservations(suite: ScoringSuite, input: unknown): ScoringObservation[] {
  const observations = scoringObservationSchema.array().max(48_000).parse(input)
  const suiteSha256 = evaluationHash(suite)
  const keys = new Set<string>()
  for (const observation of observations) {
    const item = suite.cases.find(candidate => candidate.id === observation.caseId)
    if (observation.suiteSha256 !== suiteSha256 || !item ||
      !suite.configurations.some(configuration => configuration.id === observation.configurationId) ||
      observation.repetition > suite.repetitions) {
      throw new Error('Observation does not belong to this frozen suite.')
    }
    const key = JSON.stringify([observation.caseId, observation.configurationId, observation.repetition])
    if (keys.has(key)) throw new Error('Duplicate observation; repetitions cannot be silently overwritten.')
    keys.add(key)
    if (observation.result.status === 'complete') {
      const ids = observation.result.criteria.map(row => row.criterionId)
      if (new Set(ids).size !== ids.length || ids.length !== item.criterionIds.length ||
        ids.some(id => !item.criterionIds.includes(id))) {
        throw new Error('Completed observations must cover each exact saved criterion once.')
      }
      if (observation.result.criteria.some(row => item.excludedCriterionIds?.includes(row.criterionId) && row.score !== null)) {
        throw new Error('Saved grade exclusions must remain unscored.')
      }
    }
  }
  return observations
}

function referenceStatistics(references: ScoringReference[], observations: ScoringObservation[]) {
  return ['human-reviewed', 'adjudicated', 'planted', 'model-assisted'].map(origin => {
    const selected = references.filter(reference => reference.origin === origin && reference.score !== null)
    const errors: number[] = [], biases: number[] = [], exact: number[] = [], withinOne: number[] = []
    const observedMarginal = Array<number>(6).fill(0), referenceMarginal = Array<number>(6).fill(0)
    let weightedDisagreement = 0
    let scoredItems = 0, unscoredRuns = 0
    for (const reference of selected) {
      const referenceScore = reference.score
      if (referenceScore === null) continue
      const scores = observations.filter(row => row.caseId === reference.caseId).flatMap(row => {
        if (row.result.status !== 'complete') { unscoredRuns++; return [] }
        const criterion = row.result.criteria.find(item => item.criterionId === reference.criterionId)
        if (criterion?.score === null || criterion === undefined) { unscoredRuns++; return [] }
        return [criterion.score]
      })
      if (!scores.length) continue
      scoredItems++
      errors.push(scores.reduce((sum, score) => sum + Math.abs(score - referenceScore), 0) / scores.length)
      biases.push(scores.reduce((sum, score) => sum + score - referenceScore, 0) / scores.length)
      exact.push(scores.filter(score => score === referenceScore).length / scores.length)
      withinOne.push(scores.filter(score => Math.abs(score - referenceScore) <= 1).length / scores.length)
      referenceMarginal[referenceScore]++
      for (const score of scores) {
        observedMarginal[score] += 1 / scores.length
        weightedDisagreement += (score - referenceScore) ** 2 / (25 * scores.length)
      }
    }
    let expectedWeightedDisagreement = 0
    if (scoredItems) for (let reference = 0; reference < 6; reference++) for (let observed = 0; observed < 6; observed++) {
      expectedWeightedDisagreement += referenceMarginal[reference] * observedMarginal[observed] *
        (reference - observed) ** 2 / (25 * scoredItems ** 2)
    }
    return {
      origin, referenceItems: selected.length, scoredItems, unscoredRuns,
      meanAbsoluteError: mean(errors), signedBias: mean(biases),
      exactAgreement: mean(exact), withinOneAgreement: mean(withinOne),
      quadraticWeightedKappa: expectedWeightedDisagreement > 0
        ? 1 - weightedDisagreement / (scoredItems * expectedWeightedDisagreement) : null,
      limitation: 'Per-item descriptive statistics; repeats are not independent human labels. No judge qualification claim.',
    }
  })
}

export function summarizeScoringSuite(rawSuite: unknown, rawObservations: unknown, rawReferences: unknown = []) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  const observations = validateObservations(suite, rawObservations)
  const references = validateReferenceSet(suite, rawReferences)
  const strata = ['all', 'development', 'calibration', 'holdout'] as const
  const reports = suite.configurations.flatMap(configuration => strata.map(split => {
    const cases = suite.cases.filter(item => split === 'all' || item.split === split)
    const selected = observations.filter(row => row.configurationId === configuration.id &&
      cases.some(item => item.id === row.caseId))
    const expected = cases.length * suite.repetitions
    const complete = selected.filter(row => row.result.status === 'complete').length
    const items = cases.flatMap(item => item.criterionIds.map(criterionId => {
      const scores = Array.from({ length: suite.repetitions }, (_, index) => {
        const observation = selected.find(row => row.caseId === item.id && row.repetition === index + 1)
        return observation?.result.status === 'complete'
          ? observation.result.criteria.find(row => row.criterionId === criterionId)?.score ?? null : null
      })
      return { caseId: item.id, familyId: item.familyId, jobId: item.jobId, criterionId,
        excluded: item.excludedCriterionIds?.includes(criterionId) ?? false, ...ordinalRepeatStatistics(scores) }
    }))
    const overall = cases.map(item => {
      const values = selected.filter(row => row.caseId === item.id).flatMap(row =>
        row.result.status === 'complete' && row.result.overall !== null ? [row.result.overall] : [])
      const average = mean(values)
      const sd = values.length >= 2 && average !== null
        ? Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)) : null
      return {
        caseId: item.id, familyId: item.familyId, jobId: item.jobId, scoredRepetitions: values.length, sd,
        range: values.length >= 2 ? Math.max(...values) - Math.min(...values) : null,
      }
    })
    const rates = items.flatMap(item => item.pairwiseDisagreement === null ? [] : [item.pairwiseDisagreement])
    const largeRates = items.flatMap(item => item.pairwiseGreaterThanOne === null ? [] : [item.pairwiseGreaterThanOne])
    return {
      configurationId: configuration.id, split, expected, observed: selected.length,
      complete, failed: selected.length - complete, missing: expected - selected.length,
      completionRate: expected ? complete / expected : null,
      pairwiseDisagreement: mean(rates), pairwiseGreaterThanOne: mean(largeRates),
      anyChangeFraction: mean(items.flatMap(item => item.anyChange === null ? [] : [Number(item.anyChange)])),
      repeatableItems: rates.length,
      excludedItems: items.filter(item => item.excluded).length,
      incompleteItems: items.filter(item => !item.excluded && item.scoredRepetitions < suite.repetitions).length,
      medianOverallSd: quantile(overall.flatMap(item => item.sd === null ? [] : [item.sd]), 0.5),
      p95OverallRange: quantile(overall.flatMap(item => item.range === null ? [] : [item.range]), 0.95),
      p50Milliseconds: quantile(selected.map(row => row.durationMilliseconds), 0.5),
      p95Milliseconds: quantile(selected.map(row => row.durationMilliseconds), 0.95),
      references: referenceStatistics(references.filter(reference => cases.some(item => item.id === reference.caseId)), selected),
      items, overall,
    }
  }))
  return {
    schemaVersion: 1, suiteSha256: evaluationHash(suite), reports,
    eligibleForRelease: false,
    limitations: [
      'Descriptive report only; no automated activation or inferred production fairness.',
      'Missing, failed and null outcomes are explicit and are never scored as zero.',
      'Item means are not population estimates; families, jobs and repeats are correlated.',
      'Confidence intervals, paired family-level noise-floor tests and final release gates require separate analysis.',
    ],
  }
}
