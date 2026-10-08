import { z } from 'zod'
import { scoringSuiteSchema } from './contracts'
import { evaluationHash, validateObservations } from './statistics'
import { validateEvaluationCaseInput } from './production'
import { pairedFamilyBootstrap } from './metrics'

const id = z.string().min(1).max(160)
const pairsSchema = z.array(z.strictObject({
  id, baselineCaseId: id, variantCaseId: id,
  kind: z.enum(['identity-only', 'irrelevant-detail', 'paraphrase', 'format']),
})).min(1).max(500)

function differences(left: number[], right: number[]) {
  const deltas = left.flatMap(a => right.map(b => b - a))
  return {
    pairs: deltas.length,
    signedDelta: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null,
    meanAbsoluteDelta: deltas.length ? deltas.reduce((sum, value) => sum + Math.abs(value), 0) / deltas.length : null,
    disagreement: deltas.length ? deltas.filter(value => value !== 0).length / deltas.length : null,
    greaterThanOne: deltas.length ? deltas.filter(value => Math.abs(value) > 1).length / deltas.length : null,
  }
}

function noise(scores: number[]) {
  const deltas = scores.flatMap((value, index) => scores.slice(index + 1).map(other => other - value))
  return {
    pairs: deltas.length,
    meanAbsoluteDelta: deltas.length ? deltas.reduce((sum, value) => sum + Math.abs(value), 0) / deltas.length : null,
    disagreement: deltas.length ? deltas.filter(value => value !== 0).length / deltas.length : null,
    greaterThanOne: deltas.length ? deltas.filter(value => Math.abs(value) > 1).length / deltas.length : null,
  }
}

function summarizeContrasts(
  rows: Array<{ id: string; familyId: string; baseline: number; candidate: number }>, seed: string,
) {
  const families = new Map<string, typeof rows>()
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const family = families.get(row.familyId) ?? []
    family.push(row)
    families.set(row.familyId, family)
  }
  const means = [...families.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, family]) => ({
    candidate: family.reduce((sum, row) => sum + row.candidate, 0) / family.length,
    baseline: family.reduce((sum, row) => sum + row.baseline, 0) / family.length,
  }))
  const baseline = means.length ? means.reduce((sum, row) => sum + row.baseline, 0) / means.length : null
  const candidate = means.length ? means.reduce((sum, row) => sum + row.candidate, 0) / means.length : null
  return {
    familyMeanBaseline: baseline, familyMeanCandidate: candidate,
    familyMeanDifference: baseline !== null && candidate !== null ? candidate - baseline : null,
    uncertainty: families.size >= 2 ? pairedFamilyBootstrap(rows, { seed, repetitions: 1000 }) : null,
    uncertaintyUnavailable: families.size < 2 ? 'fewer-than-two-complete-families' : null,
  }
}

export function summarizePairedInvariance(rawSuite: unknown, rawObservations: unknown, rawPairs: unknown, rawInputs: unknown) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  const observations = validateObservations(suite, rawObservations)
  const pairs = pairsSchema.parse(rawPairs)
  const inputRows = z.array(z.strictObject({ id, input: z.unknown() })).min(1).max(500).parse(rawInputs)
  if (new Set(inputRows.map(row => row.id)).size !== inputRows.length) throw new Error('Frozen input IDs must be unique.')
  const inputs = new Map(inputRows.map(row => {
    const item = suite.cases.find(item => item.id === row.id)
    if (!item) throw new Error('Invariance input does not belong to the frozen suite.')
    const input = validateEvaluationCaseInput(item, row.input)
    return [row.id, input]
  }))
  if (suite.repetitions < 2) throw new Error('Invariance requires repeated unchanged inputs to measure the noise floor.')
  if (new Set(pairs.map(pair => pair.id)).size !== pairs.length ||
    new Set(pairs.map(pair => JSON.stringify([pair.baselineCaseId, pair.variantCaseId]))).size !== pairs.length) {
    throw new Error('Invariance pair IDs and case pairs must be unique.')
  }
  const items = pairs.flatMap(pair => {
    const baseline = suite.cases.find(row => row.id === pair.baselineCaseId)
    const variant = suite.cases.find(row => row.id === pair.variantCaseId)
    if (!baseline || !variant || baseline.id === variant.id || baseline.familyId !== variant.familyId ||
      baseline.jobId !== variant.jobId || baseline.split !== variant.split ||
      baseline.criterionIds.length !== variant.criterionIds.length ||
      baseline.criterionIds.some(criterion => !variant.criterionIds.includes(criterion)) ||
      (baseline.excludedCriterionIds ?? []).length !== (variant.excludedCriterionIds ?? []).length ||
      baseline.excludedCriterionIds?.some(criterion => !variant.excludedCriterionIds?.includes(criterion))) {
      throw new Error('Invariance pairs require distinct exact cases in one family/job/split with matching saved criteria and exclusions.')
    }
    const leftInput = inputs.get(baseline.id), rightInput = inputs.get(variant.id)
    if (!leftInput || !rightInput) throw new Error('Both exact frozen inputs are required for every invariance pair.')
    const targetHash = (input: typeof leftInput) => evaluationHash({
      rubric: input.rubric, qualifications: input.qualifications, requirementEvidence: input.requirementEvidence,
    })
    if (targetHash(leftInput) !== targetHash(rightInput)) {
      throw new Error('Invariance pairs cannot change saved rubric definitions, weights, qualifications or requirement evidence.')
    }
    return suite.configurations.map(configuration => {
      const left = observations.filter(row => row.caseId === baseline.id && row.configurationId === configuration.id)
      const right = observations.filter(row => row.caseId === variant.id && row.configurationId === configuration.id)
      const criteria = baseline.criterionIds.filter(criterion => !baseline.excludedCriterionIds?.includes(criterion))
        .map(criterionId => {
          const scores = (rows: typeof observations) => rows.flatMap(row => {
            if (row.result.status !== 'complete') return []
            const score = row.result.criteria.find(criterion => criterion.criterionId === criterionId)?.score
            return score === undefined || score === null ? [] : [score]
          })
          const original = scores(left), changed = scores(right)
          return {
            criterionId, baselineScored: original.length, variantScored: changed.length,
            missingBaseline: suite.repetitions - original.length,
            missingVariant: suite.repetitions - changed.length,
            crossInput: differences(original, changed),
            unchangedBaseline: noise(original), unchangedVariant: noise(changed),
          }
        })
      return {
        pairId: pair.id, kind: pair.kind, familyId: baseline.familyId, jobId: baseline.jobId,
        split: baseline.split, configurationId: configuration.id,
        baselineCaseId: baseline.id, variantCaseId: variant.id,
        expectedPerInput: suite.repetitions,
        baselineFailed: left.filter(row => row.result.status === 'failed').length,
        variantFailed: right.filter(row => row.result.status === 'failed').length,
        baselineMissing: suite.repetitions - left.length, variantMissing: suite.repetitions - right.length,
        complete: left.length === suite.repetitions && right.length === suite.repetitions &&
          left.every(row => row.result.status === 'complete') && right.every(row => row.result.status === 'complete') &&
          criteria.every(row => row.missingBaseline === 0 && row.missingVariant === 0),
        criteria,
      }
    })
  })
  const metrics = ['disagreement', 'greaterThanOne', 'meanAbsoluteDelta'] as const
  const strata = [...new Map(items.map(item => [
    JSON.stringify([item.split, item.kind]), { split: item.split, kind: item.kind },
  ])).values()]
  const completeCriterionRows = (selected: typeof items) => selected.flatMap(item =>
    item.criteria.filter(criterion => criterion.missingBaseline === 0 && criterion.missingVariant === 0)
      .map(criterion => ({
        id: JSON.stringify([item.pairId, criterion.criterionId]), familyId: item.familyId,
        cross: criterion.crossInput,
        baseline: criterion.unchangedBaseline, variant: criterion.unchangedVariant,
      })))
  const noiseFloor = suite.configurations.flatMap(configuration => strata.map(stratum => {
    const selected = items.filter(item => item.configurationId === configuration.id &&
      item.split === stratum.split && item.kind === stratum.kind)
    const rows = completeCriterionRows(selected)
    const families = new Set(rows.map(row => row.familyId)).size
    return {
      configurationId: configuration.id, ...stratum,
      expectedPanels: selected.length, completePanels: selected.filter(item => item.complete).length,
      expectedCriterionItems: selected.reduce((sum, item) => sum + item.criteria.length, 0),
      completeCriterionItems: rows.length, incompleteCriterionItems: selected.reduce(
        (sum, item) => sum + item.criteria.length, 0) - rows.length,
      completeFamilies: families,
      metrics: metrics.map(metric => {
        const contrasts = rows.map(row => ({
          id: row.id, familyId: row.familyId,
          baseline: (row.baseline[metric]! + row.variant[metric]!) / 2,
          candidate: row.cross[metric]!,
        }))
        const summary = summarizeContrasts(contrasts,
          evaluationHash([suite, pairs, configuration.id, stratum, metric, 'noise-floor-v1']))
        return {
          metric, familyMeanCrossInput: summary.familyMeanCandidate,
          familyMeanUnchangedNoise: summary.familyMeanBaseline,
          familyMeanExcess: summary.familyMeanDifference,
          uncertainty: summary.uncertainty, uncertaintyUnavailable: summary.uncertaintyUnavailable,
        }
      }),
    }
  }))
  const configurationComparisons = suite.configurations.flatMap((left, index) =>
    suite.configurations.slice(index + 1).flatMap(right => strata.map(stratum => {
      const selected = (configurationId: string) => items.filter(item => item.configurationId === configurationId &&
        item.split === stratum.split && item.kind === stratum.kind)
      const leftRows = completeCriterionRows(selected(left.id)), rightRows = completeCriterionRows(selected(right.id))
      const rightIndex = new Map(rightRows.map(row => [row.id, row]))
      const matched = leftRows.flatMap(row => {
        const other = rightIndex.get(row.id)
        return other ? [{ left: row, right: other }] : []
      })
      const families = new Set(matched.map(row => row.left.familyId)).size
      const expected = selected(left.id).reduce((sum, item) => sum + item.criteria.length, 0)
      return {
        leftConfigurationId: left.id, rightConfigurationId: right.id, ...stratum,
        expectedCriterionItems: expected, matchedCompleteCriterionItems: matched.length,
        unmatchedCriterionItems: expected - matched.length, matchedFamilies: families,
        metrics: metrics.map(metric => {
          const contrasts = matched.map(row => ({
            id: row.left.id, familyId: row.left.familyId,
            baseline: row.left.cross[metric]! - (row.left.baseline[metric]! + row.left.variant[metric]!) / 2,
            candidate: row.right.cross[metric]! - (row.right.baseline[metric]! + row.right.variant[metric]!) / 2,
          }))
          return {
            metric,
            ...summarizeContrasts(contrasts,
              evaluationHash([suite, pairs, left.id, right.id, stratum, metric, 'paired-noise-floor-v1'])),
          }
        }),
      }
    })))
  return {
    schemaVersion: 1 as const, suiteSha256: evaluationHash(suite), pairsSha256: evaluationHash(pairs),
    eligibleForRelease: false,
    expectedPanels: pairs.length * suite.configurations.length,
    completePanels: items.filter(row => row.complete).length,
    items, noiseFloor, configurationComparisons,
    limitations: [
      'Pair kinds are caller-declared; hashes bind supplied inputs, not semantic evidence equivalence.',
      'Cross-input comparisons include all scored baseline/variant pairs; unchanged-input pairs measure noise separately.',
      'Failed, missing and null scores remain absent, not zero; incomplete panels cannot establish invariance.',
      'Pair counts are not independent samples. Family-clustered uncertainty and human evidence checks remain required.',
      'Noise-floor summaries use complete criterion panels only, average the two unchanged-source noise estimates, then weight each family equally. Negative excess is retained, not clamped to zero.',
      'Seeded family-cluster percentile intervals use 1000 resamples. They are descriptive small-corpus estimates, not significance tests, multiplicity-adjusted guarantees or release gates.',
      'Configuration comparisons use the exact same available pair/criterion set in both arms; completion-conditioned subsets can remain selection-biased.',
      'No model winner, population fairness, causal attribution or release eligibility is inferred.',
    ],
  }
}
