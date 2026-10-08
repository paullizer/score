import { z } from 'zod'

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const split = z.enum(['development', 'calibration', 'holdout'])
const unique = (values: string[]) => new Set(values).size === values.length

export const scoringSuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  purpose: z.enum(['smoke', 'screening', 'stability', 'gate']),
  sourceVersion: id,
  repetitions: z.number().int().min(1).max(12),
  configurations: z.array(z.strictObject({
    id, settingsSha256: hash, algorithmVersion: id,
  })).min(1).max(8),
  cases: z.array(z.strictObject({
    id, familyId: id, jobId: id, split, inputSha256: hash,
    criterionIds: z.array(id).min(1).max(20).refine(unique, 'Criterion IDs must be unique.'),
    excludedCriterionIds: z.array(id).max(20).refine(unique, 'Excluded criterion IDs must be unique.').optional(),
  })).min(1).max(500),
}).superRefine((suite, context) => {
  if (!unique(suite.cases.map(item => item.id))) {
    context.addIssue({ code: 'custom', path: ['cases'], message: 'Case IDs must be unique.' })
  }
  if (!unique(suite.configurations.map(item => item.id))) {
    context.addIssue({ code: 'custom', path: ['configurations'], message: 'Configuration IDs must be unique.' })
  }
  const families = new Map<string, string>()
  for (const item of suite.cases) {
    if (item.excludedCriterionIds?.some(id => !item.criterionIds.includes(id))) {
      context.addIssue({ code: 'custom', path: ['cases'], message: 'Excluded criteria must belong to the exact case.' })
    }
    const previous = families.get(item.familyId)
    if (previous !== undefined && previous !== item.split) {
      context.addIssue({ code: 'custom', path: ['cases'], message: 'A resume family cannot cross dataset splits.' })
    }
    families.set(item.familyId, item.split)
  }
  if (suite.purpose === 'stability' && suite.repetitions < 6) {
    context.addIssue({ code: 'custom', path: ['repetitions'], message: 'Stability suites require at least six repetitions.' })
  }
})
export type ScoringSuite = z.infer<typeof scoringSuiteSchema>

export const scoringObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  suiteSha256: hash,
  caseId: id,
  configurationId: id,
  repetition: z.number().int().min(1).max(12),
  durationMilliseconds: z.number().finite().nonnegative(),
  result: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('complete'),
      assessmentSha256: hash.optional(),
      overall: z.number().finite().min(0).max(100).nullable(),
      criteria: z.array(z.strictObject({
        criterionId: id,
        score: z.number().int().min(0).max(5).nullable(),
      })).min(1).max(20),
    }),
    z.strictObject({ status: z.literal('failed'), code: id }),
  ]),
})
export type ScoringObservation = z.infer<typeof scoringObservationSchema>

export const scoringReferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id, caseId: id, criterionId: id, inputSha256: hash,
  origin: z.enum(['model-assisted', 'planted', 'human-reviewed', 'adjudicated']),
  author: id,
  independent: z.boolean(),
  score: z.number().int().min(0).max(5).nullable(),
  reason: z.string().min(1).max(2000),
  evidenceFactIds: z.array(id).max(100).refine(unique),
  inclusionProbability: z.number().finite().positive().max(1).nullable(),
})
export type ScoringReference = z.infer<typeof scoringReferenceSchema>

export function validateReferenceSet(suite: ScoringSuite, values: unknown): ScoringReference[] {
  const references = z.array(scoringReferenceSchema).max(10_000).parse(values)
  if (!unique(references.map(item => item.id))) throw new Error('Reference IDs must be unique.')
  const selected = new Set<string>()
  for (const reference of references) {
    const item = suite.cases.find(candidate => candidate.id === reference.caseId)
    if (!item || item.inputSha256 !== reference.inputSha256 || !item.criterionIds.includes(reference.criterionId)) {
      throw new Error('Reference does not match its exact frozen case and criterion.')
    }
    if (reference.score !== null && item.excludedCriterionIds?.includes(reference.criterionId)) {
      throw new Error('Saved grade exclusions cannot acquire scored reference labels.')
    }
    const key = JSON.stringify([reference.caseId, reference.criterionId, reference.origin])
    if (selected.has(key)) throw new Error('Select one effective reference per origin and criterion; retain revisions separately.')
    selected.add(key)
  }
  return references
}
