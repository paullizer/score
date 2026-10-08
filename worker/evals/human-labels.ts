import { z } from 'zod'
import { prepareBlindSpotChecks } from './spot-checks'
import { scoringSuiteSchema, validateReferenceSet } from './contracts'
import { evaluationHash } from './statistics'

const responseSchema = z.strictObject({
  cardId: z.string().min(1).max(320),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  score: z.number().int().min(0).max(5).nullable(),
  unableToJudge: z.boolean(),
  reason: z.string().trim().min(1).max(2000),
  supportingPassageIds: z.array(z.number().int().positive()).max(100),
  exposure: z.enum(['blind', 'model-output-seen']),
}).superRefine((response, context) => {
  if (response.unableToJudge !== (response.score === null) ||
    response.score !== null && response.score > 0 && !response.supportingPassageIds.length ||
    new Set(response.supportingPassageIds).size !== response.supportingPassageIds.length) {
    context.addIssue({ code: 'custom', message: 'Human labels require explicit unresolved status, unique passages and evidence for positive scores.' })
  }
})

export function importBlindHumanLabels(raw: {
  suite: unknown; targets: unknown; inputs: unknown; seed: string; packSha256: string;
  author: string; revision: string; submittedAt: string; responses: unknown;
}) {
  const author = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).parse(raw.author)
  const revision = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).parse(raw.revision)
  z.string().datetime().parse(raw.submittedAt)
  const suite = scoringSuiteSchema.parse(raw.suite)
  const pack = prepareBlindSpotChecks(suite, raw.targets, raw.inputs, raw.seed)
  if (evaluationHash(pack) !== raw.packSha256) throw new Error('Human submissions must bind the unchanged blind pack.')
  const responses = responseSchema.array().min(1).max(30).parse(raw.responses)
  if (new Set(responses.map(row => row.cardId)).size !== responses.length) throw new Error('Human card responses must be unique within a revision.')
  const selections = responses.map(response => {
    const card = pack.cards.find(card => card.id === response.cardId)
    if (!card || card.inputSha256 !== response.inputSha256) throw new Error('Human response does not match its exact blind card.')
    const passages = card.source.paragraphs.flatMap(paragraph => paragraph.passages.map(passage => ({
      ...passage, paragraphId: paragraph.id,
    })))
    const citations = response.supportingPassageIds.map(id => {
      const passage = passages.find(passage => passage.passageId === id)
      if (!passage) throw new Error('Human evidence selection is outside the frozen source.')
      return { passageId: id, paragraphId: passage.paragraphId, quote: passage.text }
    })
    return { response, card, citations }
  })
  const references = validateReferenceSet(suite, selections.map(({ response, card }) => ({
    schemaVersion: 1 as const, id: `human-${evaluationHash([revision, card.id])}`,
    caseId: card.caseId, criterionId: card.criterionId, inputSha256: card.inputSha256,
    origin: 'human-reviewed' as const, author, independent: response.exposure === 'blind',
    score: response.score, reason: response.reason, evidenceFactIds: [],
    inclusionProbability: card.inclusionProbability,
  })))
  return {
    schemaVersion: 1 as const, revision, author, submittedAt: raw.submittedAt,
    packSha256: raw.packSha256, suiteSha256: evaluationHash(suite), references,
    evidence: selections.map(({ response, card, citations }) => ({
      cardId: card.id, split: card.split, stratum: card.stratum, exposure: response.exposure, citations,
    })),
    limitations: [
      'Original model-assisted labels are not overwritten; select a human revision explicitly.',
      'Holdout responses must remain sealed from tuning.',
      'Thirty spot checks cannot establish population fairness or reliable subgroup error rates.',
    ],
  }
}
