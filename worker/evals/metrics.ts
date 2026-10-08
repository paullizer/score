import { z } from 'zod'
import { evaluationHash } from './statistics'

const id = z.string().min(1).max(160)
const evidenceCaseSchema = z.strictObject({
  id,
  expectedSupportingFacts: z.array(id),
  knownNonSupportingFacts: z.array(id),
  retrievedFacts: z.array(id),
})

export function evidenceDetectionStatistics(value: unknown) {
  const cases = evidenceCaseSchema.array().max(10_000).parse(value)
  const ids = new Set<string>()
  let truePositive = 0, falsePositive = 0, missedSupporting = 0, unknownRetrieved = 0
  const items = cases.map(item => {
    if (ids.has(item.id)) throw new Error('Evidence case IDs must be unique.')
    ids.add(item.id)
    const positive = new Set(item.expectedSupportingFacts)
    const negative = new Set(item.knownNonSupportingFacts)
    const retrieved = new Set(item.retrievedFacts)
    if (positive.size !== item.expectedSupportingFacts.length || negative.size !== item.knownNonSupportingFacts.length ||
      retrieved.size !== item.retrievedFacts.length || [...positive].some(fact => negative.has(fact))) {
      throw new Error('Fact references must be unique with disjoint supporting and non-supporting sets.')
    }
    const tp = [...retrieved].filter(fact => positive.has(fact)).length
    const fp = [...retrieved].filter(fact => negative.has(fact)).length
    const missed = [...positive].filter(fact => !retrieved.has(fact)).length
    const unknown = [...retrieved].filter(fact => !positive.has(fact) && !negative.has(fact)).length
    truePositive += tp; falsePositive += fp; missedSupporting += missed; unknownRetrieved += unknown
    return { id: item.id, truePositive: tp, falsePositive: fp, missedSupporting: missed, unknownRetrieved: unknown }
  })
  return {
    items, truePositive, falsePositive, missedSupporting, unknownRetrieved,
    precisionOnAnnotatedFacts: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null,
    recallOnExpectedFacts: truePositive + missedSupporting ? truePositive / (truePositive + missedSupporting) : null,
    limitation: 'Only explicit fact references contribute. Unannotated evidence is unknown, not automatically wrong or correct.',
  }
}

const pairSchema = z.strictObject({
  id, familyId: id, baseline: z.number().finite(), candidate: z.number().finite(),
})

export function pairedFamilyBootstrap(raw: unknown, options: { seed: string; repetitions: number }) {
  const pairs = pairSchema.array().min(2).max(10_000).parse(raw)
  if (!options.seed || !Number.isInteger(options.repetitions) || options.repetitions < 100 || options.repetitions > 10_000) {
    throw new Error('Bootstrap requires an explicit seed and 100-10000 resamples.')
  }

  if (new Set(pairs.map(pair => pair.id)).size !== pairs.length) throw new Error('Paired item IDs must be unique.')
  const families = new Map<string, number[]>()
  for (const pair of [...pairs].sort((left, right) => left.id.localeCompare(right.id))) {
    const values = families.get(pair.familyId) ?? []
    values.push(pair.candidate - pair.baseline)
    families.set(pair.familyId, values)
  }
  if (families.size < 2) throw new Error('Clustered uncertainty requires at least two independent resume families.')
  const clusters = [...families].sort(([a], [b]) => a.localeCompare(b)).map(([, values]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length)
  let state = Number.parseInt(evaluationHash(options.seed).slice(0, 8), 16) || 1
  const randomIndex = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return Math.floor((state >>> 0) / 4_294_967_296 * clusters.length)
  }
  const samples = Array.from({ length: options.repetitions }, () => {
    let sum = 0
    for (let index = 0; index < clusters.length; index++) sum += clusters[randomIndex()]
    return sum / clusters.length
  }).sort((a, b) => a - b)
  return {
    items: pairs.length, families: clusters.length,
    familyMeanDifference: clusters.reduce((sum, value) => sum + value, 0) / clusters.length,
    lower95: samples[Math.floor((samples.length - 1) * 0.025)],
    upper95: samples[Math.ceil((samples.length - 1) * 0.975)],
    seed: options.seed, resamples: options.repetitions,
    limitation: 'Family-cluster percentile interval for this four-job corpus, not unseen-job or population fairness.',
  }
}

const judgeTrialSchema = z.strictObject({
  id, familyId: id,
  expectedIssue: z.enum(['none', 'over-credit', 'under-credit', 'unsupported-fact']),
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('complete'), issueFound: z.boolean() }),
    z.strictObject({ status: z.literal('failed'), code: id }),
  ]),
})

export function fixedJudgeStatistics(raw: unknown) {
  const trials = judgeTrialSchema.array().min(1).max(10_000).parse(raw)
  if (new Set(trials.map(row => row.id)).size !== trials.length) throw new Error('Fixed judge trial IDs must be unique.')
  const summarize = (selected: typeof trials) => {
    let truePositive = 0, falsePositive = 0, trueNegative = 0, falseNegative = 0, failed = 0
    for (const trial of selected) {
      if (trial.result.status === 'failed') { failed++; continue }
      const defective = trial.expectedIssue !== 'none'
      if (defective && trial.result.issueFound) truePositive++
      else if (defective) falseNegative++
      else if (trial.result.issueFound) falsePositive++
      else trueNegative++
    }
    return {
      expected: selected.length, completed: selected.length - failed, failed,
      truePositive, falsePositive, trueNegative, falseNegative,
      precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null,
      recallOnCompleted: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null,
      falseCorrectionRateOnCompletedValid: falsePositive + trueNegative ? falsePositive / (falsePositive + trueNegative) : null,
    }
  }
  return {
    all: summarize(trials),
    byExpectedIssue: Object.fromEntries(['none', 'over-credit', 'under-credit', 'unsupported-fact'].map(kind =>
      [kind, summarize(trials.filter(row => row.expectedIssue === kind))])),
    failures: trials.filter(row => row.result.status === 'failed').map(row => ({ id: row.id, familyId: row.familyId, result: row.result })),
    limitation: 'Known planted/human-verified defect labels are required. Failed reviews are indeterminate, not approvals or true negatives; recall is conditional on completed reviews.',
  }
}
