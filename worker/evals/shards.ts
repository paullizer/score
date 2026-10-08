import { z } from 'zod'
import { QC_LIMITS } from '../../src/domain/quality-control'
import { scoringSuiteSchema, type ScoringSuite, type ScoringObservation } from './contracts'
import { evaluationHash, validateObservations } from './statistics'
import { validateEvaluationCaseInput } from './production'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identifier = z.string().min(1).max(160)
const inputRowsSchema = z.array(z.strictObject({ id: identifier, input: z.unknown() })).min(1).max(500)
export const scoringShardIndexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  parentSuite: scoringSuiteSchema,
  parentSuiteSha256: hash,
  shards: z.array(z.strictObject({
    id: identifier, suiteSha256: hash,
    caseIds: z.array(identifier).min(1).max(QC_LIMITS.planCases),
  })).min(1).max(500),
})

function shardSuite(parent: ScoringSuite, id: string, caseIds: string[]) {
  const cases = new Map(parent.cases.map(item => [item.id, item]))
  return scoringSuiteSchema.parse({ ...parent, id, cases: caseIds.map(id => {
    const item = cases.get(id)
    if (!item) throw new Error('Shard contains a case outside its exact parent suite.')
    return item
  }) })
}

export function validateScoringShardIndex(raw: unknown) {
  const index = scoringShardIndexSchema.parse(raw)
  if (evaluationHash(index.parentSuite) !== index.parentSuiteSha256) {
    throw new Error('Scoring shard index differs from its frozen parent suite.')
  }
  const ids = new Set<string>(), seen = new Set<string>(), familyShards = new Map<string, string>()
  for (const shard of index.shards) {
    if (ids.has(shard.id)) throw new Error('Duplicate scoring shard ID.')
    ids.add(shard.id)
    if (evaluationHash(shardSuite(index.parentSuite, shard.id, shard.caseIds)) !== shard.suiteSha256) {
      throw new Error('Scoring shard cases or configuration differ from their exact suite hash.')
    }
    for (const id of shard.caseIds) {
      if (seen.has(id)) throw new Error('Scoring shards cannot duplicate a parent case.')
      seen.add(id)
      const family = index.parentSuite.cases.find(row => row.id === id)!.familyId
      const previous = familyShards.get(family)
      if (previous !== undefined && previous !== shard.id) throw new Error('A resume family cannot cross execution shards.')
      familyShards.set(family, shard.id)
    }
  }
  if (seen.size !== index.parentSuite.cases.length) throw new Error('Scoring shards must cover every parent case exactly once.')
  return index
}

export function prepareScoringShards(rawSuite: unknown, rawInputs: unknown) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  const rows = inputRowsSchema.parse(rawInputs)
  const inputs = new Map(rows.map(row => [row.id, row.input]))
  if (inputs.size !== rows.length || rows.length !== suite.cases.length ||
    rows.some(row => !suite.cases.some(item => item.id === row.id))) {
    throw new Error('Sharding requires every exact parent source once, without extra or duplicate inputs.')
  }
  for (const item of suite.cases) validateEvaluationCaseInput(item, inputs.get(item.id))
  const families = new Map<string, string[]>()
  for (const item of suite.cases) {
    const cases = families.get(item.familyId) ?? []
    cases.push(item.id)
    families.set(item.familyId, cases)
  }
  const groups: string[][] = []
  let current: string[] = []
  for (const cases of families.values()) {
    if (cases.length > QC_LIMITS.planCases) {
      throw new Error('One resume family exceeds the bounded shard case limit; narrow the suite explicitly rather than split its family.')
    }
    if (current.length + cases.length > QC_LIMITS.planCases) { groups.push(current); current = [] }
    current.push(...cases)
  }
  if (current.length) groups.push(current)
  const parentSuiteSha256 = evaluationHash(suite)
  const shards = groups.map((caseIds, index) => {
    const id = `score-shard-${parentSuiteSha256.slice(0, 16)}-${index + 1}`
    const shard = shardSuite(suite, id, caseIds)
    return {
      suite: shard, inputs: caseIds.map(id => ({ id, input: inputs.get(id) })),
    }
  })
  const index = validateScoringShardIndex({
    schemaVersion: 1, parentSuite: suite, parentSuiteSha256,
    shards: shards.map(row => ({
      id: row.suite.id, suiteSha256: evaluationHash(row.suite), caseIds: row.suite.cases.map(item => item.id),
    })),
  })
  return { index, shards }
}

export function mergeScoringShardObservations(rawIndex: unknown, rawResults: unknown) {
  const index = validateScoringShardIndex(rawIndex)
  const results = z.array(z.strictObject({
    shardId: identifier, suiteSha256: hash, observations: z.unknown(),
  })).max(500).parse(rawResults)
  const ids = new Set<string>()
  const observations: ScoringObservation[] = []
  const coverage = index.shards.map(shard => {
    const matches = results.filter(row => row.shardId === shard.id)
    if (matches.length > 1) throw new Error('Duplicate shard result; select one exact checkpoint prefix.')
    const result = matches[0]
    if (!result) return {
      shardId: shard.id, expected: shard.caseIds.length * index.parentSuite.configurations.length * index.parentSuite.repetitions,
      observed: 0, complete: 0, failed: 0, missingShard: true,
    }
    ids.add(result.shardId)
    if (result.suiteSha256 !== shard.suiteSha256) throw new Error('Shard result differs from its exact frozen binding.')
    const suite = shardSuite(index.parentSuite, shard.id, shard.caseIds)
    const rows = validateObservations(suite, result.observations)
    observations.push(...rows.map(row => ({ ...row, suiteSha256: index.parentSuiteSha256 })))
    return {
      shardId: shard.id, expected: suite.cases.length * suite.configurations.length * suite.repetitions,
      observed: rows.length, complete: rows.filter(row => row.result.status === 'complete').length,
      failed: rows.filter(row => row.result.status === 'failed').length, missingShard: false,
    }
  })
  if (ids.size !== results.length) throw new Error('Result names a shard outside the frozen index.')
  return {
    schemaVersion: 1 as const, parentSuiteSha256: index.parentSuiteSha256,
    observations: validateObservations(index.parentSuite, observations), coverage,
    expected: coverage.reduce((sum, row) => sum + row.expected, 0),
    observed: observations.length, complete: coverage.every(row => row.observed === row.expected),
    eligibleForRelease: false,
    limitations: [
      'Execution partitions reuse QC case limits but are not admitted QC plans, case packs or distributed leases.',
      'Family ownership stays within one execution shard; grouping does not make shared-job results statistically independent.',
      'Only exactly validated shard observations are rebound to the parent hash. Missing, failed and null outcomes remain explicit.',
      'Complete means every expected observation is recorded, not that every comparison succeeded or release gates passed.',
    ],
  }
}
