import { scoringSuiteSchema, validateReferenceSet } from './contracts'
import { summarizeScoringSuite, validateObservations, evaluationHash } from './statistics'
import { pairedFamilyBootstrap } from './metrics'

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

export function evaluateScoringEngineeringGates(
  rawSuite: unknown, rawObservations: unknown, rawReferences: unknown,
  baselineId: string, candidateId: string,
) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  if (baselineId === candidateId || ![baselineId, candidateId].every(id => suite.configurations.some(row => row.id === id))) {
    throw new Error('Engineering gates require two distinct frozen configurations.')
  }
  const observations = validateObservations(suite, rawObservations)
  const references = validateReferenceSet(suite, rawReferences)
  const report = summarizeScoringSuite(suite, observations)
  const candidate = report.reports.find(row => row.configurationId === candidateId && row.split === 'all')!
  const targets = SCORING_ENGINEERING_TARGETS
  const checks: Array<{ id: string; status: 'passed' | 'failed' | 'insufficient'; actual: number | null; required: number }> = []
  const maximum = (id: string, actual: number | null, required: number) => {
    checks.push({ id, actual, required, status: actual === null ? 'insufficient' : actual <= required ? 'passed' : 'failed' })
  }
  const minimum = (id: string, actual: number, required: number) => {
    checks.push({ id, actual, required, status: actual >= required ? 'passed' : 'insufficient' })
  }
  minimum('repetitions', suite.repetitions, targets.minimumRepeats)
  minimum('resume-families', new Set(suite.cases.map(row => row.familyId)).size, targets.minimumFamilies)
  minimum('jobs', new Set(suite.cases.map(row => row.jobId)).size, 4)
  minimum('saved-observations', candidate.observed, candidate.expected)
  maximum('completion-failure-rate', candidate.completionRate === null ? null : 1 - candidate.completionRate, 1 - targets.completionRate)
  maximum('criterion-pairwise-disagreement', candidate.pairwiseDisagreement, targets.pairwiseDisagreement)
  maximum('criterion-large-disagreement', candidate.pairwiseGreaterThanOne, targets.pairwiseGreaterThanOne)
  maximum('median-overall-sd', candidate.medianOverallSd, targets.medianOverallSd)
  maximum('p95-overall-range', candidate.p95OverallRange, targets.p95OverallRange)
  // Null criterion outcomes must not make an incomplete panel look more stable.
  maximum('incomplete-criterion-items', candidate.incompleteItems, 0)
  const human = references.filter(row => row.origin === 'human-reviewed' && row.independent && row.score !== null)
  minimum('blind-determinate-human-items', human.length, targets.minimumHumanItems)
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
  minimum('paired-human-items', pairs.length, human.length || targets.minimumHumanItems)
  maximum('human-anchor-mae', pairs.length ? pairs.reduce((sum, row) => sum + row.candidate, 0) / pairs.length : null, targets.humanMeanAbsoluteError)
  const interval = pairs.length >= 2 && new Set(pairs.map(row => row.familyId)).size >= 2
    ? pairedFamilyBootstrap(pairs, { seed: `${evaluationHash(suite)}-human-errors`, repetitions: 2000 }) : null
  maximum('human-error-increase-upper95', interval?.upper95 ?? null, 0)
  const byJob = [...new Set(suite.cases.map(row => row.jobId))].sort().map(jobId => {
    const cases = suite.cases.filter(row => row.jobId === jobId)
    const selected = observations.filter(row => row.configurationId === candidateId && cases.some(item => item.id === row.caseId))
    return {
      jobId, expected: cases.length * suite.repetitions, observed: selected.length,
      complete: selected.filter(row => row.result.status === 'complete').length,
      blindHumanItems: human.filter(row => cases.some(item => item.id === row.caseId)).length,
    }
  })
  return {
    schemaVersion: 1 as const, suiteSha256: evaluationHash(suite), targets, baselineId, candidateId,
    checks, byJob, humanErrorDifference: interval,
    measuredTargetsMet: checks.every(row => row.status === 'passed'),
    eligibleForRelease: false,
    requiredExternalGates: [
      'Four exact reference-rubric versions signed off before scored conclusions.',
      'Independent AI references and fixed-assessment judge calibration, including accepted and rejected cases.',
      'Planted critical-evidence recovery, format preservation and identity perturbation versus identical-run noise.',
      'Candidate frozen before holdout; holdout outcomes not used for tuning.',
      'Compatible API/worker readers, Admin admission, security and explicit production promotion.',
    ],
    limitations: [
      'Engineering checks never activate a configuration or certify employment validity or population fairness.',
      'Model-assisted and model-exposed human labels cannot satisfy blind-human gates.',
      'Paired human error intervals cluster by resume family; repeats are not independent labels.',
      'A lower rejection rate or a higher mean score is not a quality gate.',
    ],
  }
}
