import { z } from 'zod'
import { scoringSuiteSchema } from './contracts'
import { evaluationHash, validateObservations, ordinalRepeatStatistics } from './statistics'
import { validateEvaluationCaseInput } from './production'

const id = z.string().min(1).max(160)
const pairSchema = z.strictObject({
  id, weakerCaseId: id, strongerCaseId: id,
  expectedCriterionIds: z.array(id).min(1).max(20),
  addedFacts: z.array(z.strictObject({
    id, paragraphId: id, text: z.string().min(1).max(12_000).refine(text => text.trim().length > 0),
  })).min(1).max(100),
  origin: z.enum(['planted', 'human-reviewed']), author: id, revision: id,
  independent: z.boolean(),
  reason: z.string().trim().min(1).max(2000),
})

export function summarizeEvidenceMonotonicity(
  rawSuite: unknown, rawObservations: unknown, rawPairs: unknown, rawInputs: unknown,
) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  const observations = validateObservations(suite, rawObservations)
  const pairs = z.array(pairSchema).min(1).max(500).parse(rawPairs)
  const inputRows = z.array(z.strictObject({ id, input: z.unknown() })).min(1).max(500).parse(rawInputs)
  if (suite.repetitions < 2) throw new Error('Evidence monotonicity requires repeated unchanged inputs to measure noise.')
  if (new Set(inputRows.map(row => row.id)).size !== inputRows.length) throw new Error('Frozen input IDs must be unique.')
  const inputs = new Map(inputRows.map(row => {
    const item = suite.cases.find(item => item.id === row.id)
    if (!item) throw new Error('Monotonicity input does not belong to the frozen suite.')
    return [row.id, validateEvaluationCaseInput(item, row.input)]
  }))
  if (new Set(pairs.map(row => row.id)).size !== pairs.length ||
    new Set(pairs.map(row => JSON.stringify([row.weakerCaseId, row.strongerCaseId]))).size !== pairs.length) {
    throw new Error('Monotonicity pair IDs and directional case pairs must be unique.')
  }
  const items = pairs.flatMap(pair => {
    const weaker = suite.cases.find(row => row.id === pair.weakerCaseId)
    const stronger = suite.cases.find(row => row.id === pair.strongerCaseId)
    const weakInput = inputs.get(pair.weakerCaseId), strongInput = inputs.get(pair.strongerCaseId)
    if (!weaker || !stronger || !weakInput || !strongInput || weaker.id === stronger.id ||
      weaker.familyId !== stronger.familyId || weaker.jobId !== stronger.jobId || weaker.split !== stronger.split ||
      evaluationHash(weaker.criterionIds) !== evaluationHash(stronger.criterionIds) ||
      evaluationHash(weaker.excludedCriterionIds ?? []) !== evaluationHash(stronger.excludedCriterionIds ?? [])) {
      throw new Error('Evidence pairs require distinct exact sources in one family/job/split with unchanged criteria and exclusions.')
    }
    const targetHash = (input: typeof weakInput) => evaluationHash({
      rubric: input.rubric, qualifications: input.qualifications, requirementEvidence: input.requirementEvidence,
    })
    if (targetHash(weakInput) !== targetHash(strongInput)) throw new Error('Evidence pairs cannot change the frozen scoring target.')
    const resumeMetadata = (input: typeof weakInput) =>
      Object.fromEntries(Object.entries(input.resume).filter(([key]) => key !== 'paragraphs'))
    if (evaluationHash(resumeMetadata(weakInput)) !== evaluationHash(resumeMetadata(strongInput))) {
      throw new Error('Evidence pairs cannot change resume identity, title or document metadata.')
    }
    if (new Set(pair.expectedCriterionIds).size !== pair.expectedCriterionIds.length ||
      pair.expectedCriterionIds.some(id => !weaker.criterionIds.includes(id) || weaker.excludedCriterionIds?.includes(id))) {
      throw new Error('Expected supporting criteria must be distinct scored criteria in the frozen target.')
    }
    if (new Set(pair.addedFacts.map(row => row.id)).size !== pair.addedFacts.length ||
      new Set(pair.addedFacts.map(row => row.paragraphId)).size !== pair.addedFacts.length ||
      new Set(pair.addedFacts.map(row => row.text)).size !== pair.addedFacts.length) {
      throw new Error('Added fact identities, source paragraphs and texts must be unique.')
    }
    const added = new Set(pair.addedFacts.map(row => row.paragraphId))
    for (const fact of pair.addedFacts) {
      const paragraph = strongInput.resume.paragraphs.find(row => row.id === fact.paragraphId)
      if (!paragraph || paragraph.text !== fact.text ||
        weakInput.resume.paragraphs.some(row => row.text === fact.text)) {
        throw new Error('Each added fact must bind one complete newly inserted source paragraph.')
      }
    }
    // Paragraph IDs can be renumbered by extraction; text, heading, page and order may not change.
    const retained = strongInput.resume.paragraphs.filter(row => !added.has(row.id))
    const context = (rows: typeof retained) => rows.map(row => ({ text: row.text, heading: row.heading, page: row.page }))
    if (evaluationHash(context(retained)) !== evaluationHash(context(weakInput.resume.paragraphs))) {
      throw new Error('Removing declared added paragraphs must recover every original paragraph and its exact context in order.')
    }
    return suite.configurations.map(configuration => {
      const weakRows = observations.filter(row => row.caseId === weaker.id && row.configurationId === configuration.id)
      const strongRows = observations.filter(row => row.caseId === stronger.id && row.configurationId === configuration.id)
      const coverage = (rows: typeof observations) => ({
        observed: rows.length, failed: rows.filter(row => row.result.status === 'failed').length,
        missing: suite.repetitions - rows.length,
      })
      const criteria = weaker.criterionIds.filter(id => !weaker.excludedCriterionIds?.includes(id)).map(criterionId => {
        const scores = (rows: typeof observations) => rows.flatMap(row => {
          const score = row.result.status === 'complete'
            ? row.result.criteria.find(row => row.criterionId === criterionId)?.score : null
          return score === null || score === undefined ? [] : [score]
        })
        const weakScores = scores(weakRows), strongScores = scores(strongRows)
        const deltas = weakScores.flatMap(score => strongScores.map(other => other - score))
        const complete = weakScores.length === suite.repetitions && strongScores.length === suite.repetitions
        return {
          criterionId, expectedSupporting: pair.expectedCriterionIds.includes(criterionId),
          weakerScored: weakScores.length, strongerScored: strongScores.length, complete,
          crossPairs: deltas.length,
          meanSignedDelta: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null,
          decreases: deltas.filter(value => value < 0).length,
          decreasesGreaterThanOne: deltas.filter(value => value < -1).length,
          decreaseRate: deltas.length ? deltas.filter(value => value < 0).length / deltas.length : null,
          decreaseGreaterThanOneRate: deltas.length ? deltas.filter(value => value < -1).length / deltas.length : null,
          increases: deltas.filter(value => value > 0).length,
          unchanged: deltas.filter(value => value === 0).length,
          weakerNoise: ordinalRepeatStatistics([...weakScores, ...Array<null>(suite.repetitions - weakScores.length).fill(null)]),
          strongerNoise: ordinalRepeatStatistics([...strongScores, ...Array<null>(suite.repetitions - strongScores.length).fill(null)]),
          eligibleForIndependentDiagnostic: complete && pair.independent && pair.expectedCriterionIds.includes(criterionId),
        }
      })
      return {
        pairId: pair.id, familyId: weaker.familyId, jobId: weaker.jobId, split: weaker.split,
        configurationId: configuration.id, weakerCaseId: weaker.id, strongerCaseId: stronger.id,
        weakerInputSha256: weaker.inputSha256, strongerInputSha256: stronger.inputSha256,
        origin: pair.origin, author: pair.author, revision: pair.revision, independent: pair.independent,
        addedFactIds: pair.addedFacts.map(row => row.id),
        expectedPerInput: suite.repetitions, weakerCoverage: coverage(weakRows), strongerCoverage: coverage(strongRows),
        complete: weakRows.length === suite.repetitions && strongRows.length === suite.repetitions &&
          weakRows.every(row => row.result.status === 'complete') &&
          strongRows.every(row => row.result.status === 'complete') && criteria.every(row => row.complete), criteria,
      }
    })
  })
  return {
    schemaVersion: 1 as const, suiteSha256: evaluationHash(suite), pairsSha256: evaluationHash(pairs),
    expectedPanels: items.length, completePanels: items.filter(row => row.complete).length,
    independentCompletePanels: items.filter(row => row.complete && row.independent).length,
    items, eligibleForRelease: false,
    limitations: [
      'Supporting-fact labels are separate planted or human judgments; exact insertion validation does not prove semantic relevance or an ordinal answer.',
      'All-pairs directional changes include unchanged-run noise. A decrease is a diagnostic, not automatically a scorer error.',
      'Insertion and removal are the same bound contrast oriented weaker-to-stronger; they are not independent experiments.',
      'Unrelated criteria are reported for spillover, not assumed invariant when new evidence may legitimately affect them.',
      'Missing, failed and null scores cannot establish monotonicity. Exposed labels do not count as independent diagnostics.',
      'Repeats, overlapping facts and shared jobs are correlated; family-clustered analysis and human calibration remain required.',
    ],
  }
}
