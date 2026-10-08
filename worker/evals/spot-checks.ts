import { z } from 'zod'
import { scoringSuiteSchema } from './contracts'
import { evaluationHash } from './statistics'
import { validateAnalysisAssessmentInput } from '../analyses/validation'
import { createAnalysisEvidenceCatalog } from '../analyses/evidence-passages'

const targetSchema = z.strictObject({
  id: z.string().min(1).max(320),
  caseId: z.string().min(1).max(160), criterionId: z.string().min(1).max(160),
  priority: z.number().finite().nonnegative(),
})

export function prepareBlindSpotChecks(rawSuite: unknown, rawTargets: unknown, rawInputs: unknown, seed: string) {
  z.string().min(1).max(160).parse(seed)
  const suite = scoringSuiteSchema.parse(rawSuite)
  const targets = targetSchema.array().min(30).max(10_000).parse(rawTargets)
  const inputs = z.array(z.strictObject({ id: z.string(), input: z.unknown() })).max(500).parse(rawInputs)
  if (new Set(inputs.map(row => row.id)).size !== inputs.length || new Set(targets.map(row => row.id)).size !== targets.length ||
    new Set(targets.map(row => JSON.stringify([row.caseId, row.criterionId]))).size !== targets.length) {
    throw new Error('Spot-check inputs and target criteria must be unique.')
  }
  const cases = new Map(suite.cases.map(item => [item.id, item]))
  const jobs = [...new Set(suite.cases.map(item => item.jobId))].sort()
  if (jobs.length !== 4) throw new Error('The initial blind batch requires exactly four jobs.')
  for (const target of targets) {
    const item = cases.get(target.caseId)
    if (!item || !item.criterionIds.includes(target.criterionId)) throw new Error('Spot-check target is outside its frozen suite.')
  }
  const chosen = (['development', 'calibration', 'holdout'] as const).flatMap(split => {
    const pool = targets.filter(target => cases.get(target.caseId)?.split === split)
    const randomCount = split === 'development' ? 12 : 4
    const targetedCount = split === 'development' ? 6 : 2
    if (pool.length < randomCount + targetedCount) throw new Error('Not enough references to prepare the requested split allocation.')
    const random = jobs.flatMap(jobId => {
      const jobPool = pool.filter(target => cases.get(target.caseId)?.jobId === jobId)
      const count = randomCount / jobs.length
      if (jobPool.length < count) throw new Error('Every job needs probability-sampled references in each split.')
      return [...jobPool]
        .sort((a, b) => evaluationHash([seed, a.id]).localeCompare(evaluationHash([seed, b.id])))
        .slice(0, count)
        .map(row => ({ row, stratum: 'probability-sample' as const, probability: count / jobPool.length }))
    })
    const targeted = pool.filter(row => !random.some(item => item.row.id === row.id))
      .sort((a, b) => b.priority - a.priority || evaluationHash([seed, a.id]).localeCompare(evaluationHash([seed, b.id])))
      .slice(0, targetedCount)
    return [
      ...random,
      ...targeted.map(row => ({ row, stratum: 'targeted-uncertainty' as const, probability: null })),
    ]
  })
  return {
    schemaVersion: 1, suiteSha256: evaluationHash(suite), seed,
    cards: chosen.map(({ row, stratum, probability }) => {
      const item = cases.get(row.caseId)
      if (!item) throw new Error('Frozen case disappeared.')
      const input = validateAnalysisAssessmentInput(inputs.find(value => value.id === item.id)?.input)
      if (evaluationHash(input) !== item.inputSha256) throw new Error('Spot-check source hash does not match the frozen case.')
      const criterion = input.rubric.criteria.find(value => value.id === row.criterionId)
      if (!criterion) throw new Error('Spot-check criterion is not in the frozen rubric.')
      const catalog = createAnalysisEvidenceCatalog(input.resume)
      return {
        id: row.id, caseId: item.id, familyId: item.familyId, jobId: item.jobId, split: item.split,
        criterionId: row.criterionId, inputSha256: item.inputSha256, stratum, inclusionProbability: probability,
        criterion, source: catalog.resume,
        response: { score: null, unableToJudge: null, reason: '', supportingPassageIds: [] },
      }
    }),
    limitations: [
      'Blind cards contain no model scores, rationales, findings or priorities.',
      'Targeted uncertainty cards do not estimate population error prevalence.',
      'Human responses and label revisions remain separate from model-assisted references.',
    ],
  }
}
