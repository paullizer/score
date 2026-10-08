import { z } from 'zod'
import { processingSettingsSnapshotSchema } from '../../src/domain/admin-settings-schema'
import { scoringSuiteSchema, validateReferenceSet } from './contracts'
import { evaluationHash, validateObservations } from './statistics'

const targetSchema = z.strictObject({
  id: z.string().min(1).max(320),
  caseId: z.string().min(1).max(160),
  criterionId: z.string().min(1).max(160),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  inclusionProbability: z.number().finite().positive().max(1).nullable(),
})

export function exportScorerDerivedReferences(
  rawSuite: unknown, rawTargets: unknown, rawObservations: unknown,
  configurationId: string, repetition: number, rawSnapshot: unknown,
) {
  const suite = scoringSuiteSchema.parse(rawSuite)
  const targets = targetSchema.array().min(1).max(10_000).parse(rawTargets)
  const observations = validateObservations(suite, rawObservations)
  const snapshot = processingSettingsSnapshotSchema.parse(rawSnapshot)
  const configuration = suite.configurations.find(row => row.id === configurationId)
  if (!configuration || evaluationHash(snapshot) !== configuration.settingsSha256 ||
    !Number.isInteger(repetition) || repetition < 1 || repetition > suite.repetitions) {
    throw new Error('Reference producer must match its frozen configuration and repetition.')
  }
  if (new Set(targets.map(row => row.id)).size !== targets.length ||
    new Set(targets.map(row => JSON.stringify([row.caseId, row.criterionId]))).size !== targets.length) {
    throw new Error('Reference targets must be unique.')
  }
  const selected = new Map(observations
    .filter(row => row.configurationId === configurationId && row.repetition === repetition)
    .map(row => [row.caseId, row]))
  const references = validateReferenceSet(suite, targets.map(target => {
    const observation = selected.get(target.caseId)
    const result = observation?.result
    const score = result?.status === 'complete'
      ? result.criteria.find(row => row.criterionId === target.criterionId)?.score ?? null : null
    return {
      schemaVersion: 1 as const, id: `silver-${evaluationHash(target.id)}`,
      caseId: target.caseId, criterionId: target.criterionId, inputSha256: target.inputSha256,
      origin: 'model-assisted' as const, author: `producer-${evaluationHash(configuration)}`, independent: false,
      score,
      reason: !result ? 'Pending: no saved producer observation.'
        : result.status === 'failed' ? `Unresolved: producer failed (${result.code}).`
          : score === null ? 'Unresolved: producer could not assign an anchor.'
            : 'Provisional scorer-derived anchor, not an independent reference or human truth.',
      evidenceFactIds: [], inclusionProbability: target.inclusionProbability,
    }
  }))
  return {
    schemaVersion: 1 as const,
    references,
    provenance: {
      suiteSha256: evaluationHash(suite), configuration, repetition,
      taskBindings: { assessment: snapshot.tasks.assessment, assessmentReview: snapshot.tasks.assessmentReview },
      exposure: 'scorer-output-derived' as const,
      items: targets.map(target => ({
        referenceId: `silver-${evaluationHash(target.id)}`, targetId: target.id,
        observationSha256: selected.has(target.caseId) ? evaluationHash(selected.get(target.caseId)) : null,
      })),
    },
    limitations: [
      'Scorer-derived labels are not independent judgments, even when the deployment name differs.',
      'Do not use same-producer agreement as accuracy, judge qualification or release evidence.',
      'No annotated evidence facts or human labels are inferred from numeric model scores.',
      'Failures, pending observations and unresolved anchors remain null, never zero.',
    ],
  }
}
