import { z } from 'zod'
import {
  ANALYSIS_NARRATIVE_LIMITS, type AnalysisCandidateNarrativeModelInput, type AnalysisNarrativePublicationReference,
  type AnalysisTargetNarrativeModelInput, type RealAnalysisCandidateNarrativeArtifact,
  type RealAnalysisNarrativeArtifact, type RealAnalysisNarrativeRecord, type RealAnalysisTargetNarrativeArtifact,
} from '../../src/domain/analysis-narratives'
import {
  candidateNarrativeOutputSchema, narrativeGroundingReviewOutputSchema, narrativeSentences, targetNarrativeOutputSchema,
  validateCandidateNarrativeOutput, validateNarrativeProse, validateTargetNarrativeOutput,
} from '../../src/domain/analysis-narrative-validation'
import type { AnalysisBlobStore } from './store'
import { parseAnalysisJson, readAnalysisBlob } from './snapshots'
import {
  analysisHash, analysisNarrativeBlobName, analysisNarrativeTargetIdSchema, assertAnalysis, isAnalysisId, MAX_ANALYSIS_JSON_BYTES,
} from './validation'
import { WORKSPACE_ID_PATTERN } from '../ids'

const timestamp = z.iso.datetime({ precision: 3 })
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().min(1).max(200)
const snapshot = z.strictObject({ snapshotId: z.string().refine(value => isAnalysisId(value, 'snapshot')), sha256: hash })
const publication = z.strictObject({
  revision: hash, inputFingerprint: hash, generationId: z.string().uuid(), publishedAt: timestamp,
  blob: z.strictObject({
    blobName: z.string().max(700), contentType: z.literal('application/json'), sha256: hash,
    bytes: z.number().int().min(1).max(MAX_ANALYSIS_JSON_BYTES),
  }),
})
const binding = {
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN), runId: z.string().refine(value => isAnalysisId(value, 'run')),
  manifestSha256: hash, targetId: analysisNarrativeTargetIdSchema, targetSnapshot: snapshot,
}
const candidateBinding = z.strictObject({
  ...binding, kind: z.literal('candidate'), comparisonId: z.string().refine(value => isAnalysisId(value, 'comparison')),
  resumeSnapshot: snapshot, resultSha256: hash,
})
const targetBinding = z.strictObject({
  ...binding, kind: z.literal('target'), comparisons: z.array(z.strictObject({
    comparisonId: z.string().refine(value => isAnalysisId(value, 'comparison')),
    status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']), resumeSnapshot: snapshot,
    resultSha256: hash.nullable(), candidateInputFingerprint: hash.nullable(),
    narrative: z.strictObject({
      status: z.enum(['waiting', 'queued', 'running', 'ready', 'failed', 'cancelled', 'missing', 'stale', 'not-required']),
      generationId: z.string().uuid().nullable(), inputFingerprint: hash.nullable(),
      published: publication.omit({ blob: true }).nullable().optional(),
    }).nullable(),
  })).min(1).max(ANALYSIS_NARRATIVE_LIMITS.maxComparisons),
})
const modelProvenance = z.strictObject({
  model: text, deployment: text, promptVersion: text, schemaVersion: text,
  startedAt: timestamp, completedAt: timestamp, inputCharacters: z.number().int().min(0),
})
const provenance = z.strictObject({
  attemptId: z.string().uuid(), outputSha256: hash, generation: modelProvenance,
  groundingReviews: z.array(narrativeGroundingReviewOutputSchema.extend({
    id: text, inputFingerprint: hash, outputSha256: hash, provenance: modelProvenance,
  })).min(1).max(ANALYSIS_NARRATIVE_LIMITS.maxComparisons * 2 + ANALYSIS_NARRATIVE_LIMITS.maxOutputCorrections + 1),
  correctionCount: z.number().int().min(0).max(ANALYSIS_NARRATIVE_LIMITS.maxOutputCorrections),
  synthesis: z.array(z.strictObject({
    comparisonIds: z.array(z.string().refine(value => isAnalysisId(value, 'comparison'))).min(1).max(ANALYSIS_NARRATIVE_LIMITS.maxComparisons),
    inputFingerprint: hash, outputSha256: hash, provenance: modelProvenance,
  })).max(ANALYSIS_NARRATIVE_LIMITS.maxComparisons * 2 + ANALYSIS_NARRATIVE_LIMITS.maxOutputCorrections).optional(),
})
const artifactBase = {
  schemaVersion: z.literal(1), dataKind: z.literal('real'), createdAt: timestamp,
  generationId: z.string().uuid(), requestId: z.string().uuid(), inputFingerprint: hash,
  humanReviewRequired: z.literal(true), provenance, previousPublication: publication.optional(),
}
const artifactSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...artifactBase, kind: z.literal('candidate'), binding: candidateBinding, ...candidateNarrativeOutputSchema.shape }),
  z.strictObject({ ...artifactBase, kind: z.literal('target'), binding: targetBinding, ...targetNarrativeOutputSchema.shape }),
])

export function parseAnalysisNarrativeArtifact(value: unknown): RealAnalysisNarrativeArtifact {
  assertAnalysis(Buffer.byteLength(JSON.stringify(value)) <= MAX_ANALYSIS_JSON_BYTES, 'Narrative artifact exceeds its byte budget.')
  const artifact = artifactSchema.parse(value) as RealAnalysisNarrativeArtifact
  const output = artifact.kind === 'candidate'
    ? { text: artifact.text, overview: artifact.overview, claims: artifact.claims }
    : { paragraphs: artifact.paragraphs, claims: artifact.claims }
  assertAnalysis(artifact.inputFingerprint === analysisHash(artifact.binding) &&
    artifact.provenance.outputSha256 === analysisHash(output), 'Narrative content or frozen input hash mismatch.')
  const finalReview = artifact.provenance.groundingReviews.at(-1)!
  const synthesis = artifact.provenance.synthesis ?? []
  const reviewKey = (item: { inputFingerprint: string; outputSha256: string }) => `${item.inputFingerprint}:${item.outputSha256}`
  const synthesisPairs = new Set(synthesis.map(reviewKey))
  const reviewedPairs = new Set(artifact.provenance.groundingReviews.map(reviewKey))
  const comparisonIds = new Set(artifact.kind === 'candidate' ? [artifact.binding.comparisonId]
    : artifact.binding.comparisons.map(pair => pair.comparisonId))
  assertAnalysis(finalReview.outcome === 'supported' && finalReview.issues.length === 0 &&
    finalReview.inputFingerprint === artifact.inputFingerprint && finalReview.outputSha256 === artifact.provenance.outputSha256 &&
    artifact.provenance.groundingReviews.every(review => review.inputFingerprint === artifact.inputFingerprint ||
      synthesisPairs.has(reviewKey(review))) &&
    synthesis.every(step => reviewedPairs.has(reviewKey(step)) &&
      new Set(step.comparisonIds).size === step.comparisonIds.length && step.comparisonIds.every(id => comparisonIds.has(id)) &&
      step.provenance.startedAt <= step.provenance.completedAt && step.provenance.completedAt <= artifact.createdAt) &&
    artifact.provenance.generation.startedAt <= artifact.provenance.generation.completedAt &&
    artifact.provenance.generation.completedAt <= artifact.createdAt &&
    artifact.provenance.groundingReviews.every(review => review.provenance.startedAt <= review.provenance.completedAt &&
      review.provenance.completedAt <= artifact.createdAt), 'Narrative grounding does not support this exact publication.')
  if (artifact.kind === 'candidate') {
    assertAnalysis(validateNarrativeProse(artifact.text) === artifact.text &&
      validateNarrativeProse(artifact.overview) === artifact.overview &&
      narrativeSentences(artifact.text).length >= ANALYSIS_NARRATIVE_LIMITS.candidateMinSentences &&
      narrativeSentences(artifact.text).length <= ANALYSIS_NARRATIVE_LIMITS.candidateMaxSentences &&
      narrativeSentences(artifact.overview).length === ANALYSIS_NARRATIVE_LIMITS.overviewSentences,
    'Candidate narrative must retain complete bounded prose.')
  } else {
    assertAnalysis(artifact.paragraphs.every(paragraph => validateNarrativeProse(paragraph) === paragraph) &&
      artifact.paragraphs.join('\n\n').length <= ANALYSIS_NARRATIVE_LIMITS.targetMaxCharacters &&
      new Set(artifact.binding.comparisons.map(pair => pair.comparisonId)).size === artifact.binding.comparisons.length,
    'Target narrative has invalid prose or repeated comparison identities.')
  }
  return artifact
}

export function validateAnalysisNarrativeArtifactInput(
  artifact: RealAnalysisCandidateNarrativeArtifact, input: AnalysisCandidateNarrativeModelInput,
): void
export function validateAnalysisNarrativeArtifactInput(
  artifact: RealAnalysisTargetNarrativeArtifact, input: AnalysisTargetNarrativeModelInput,
): void
export function validateAnalysisNarrativeArtifactInput(
  artifact: RealAnalysisNarrativeArtifact, input: AnalysisCandidateNarrativeModelInput | AnalysisTargetNarrativeModelInput,
): void {
  parseAnalysisNarrativeArtifact(artifact)
  assertAnalysis(analysisHash(artifact.binding) === analysisHash(input.binding) && artifact.inputFingerprint === input.inputFingerprint,
    'Narrative artifact is not bound to the claimed model input.')
  if (artifact.kind === 'candidate' && 'source' in input) {
    validateCandidateNarrativeOutput({ text: artifact.text, overview: artifact.overview, claims: artifact.claims }, input)
  } else if (artifact.kind === 'target' && 'candidates' in input) {
    validateTargetNarrativeOutput({ paragraphs: artifact.paragraphs, claims: artifact.claims }, input)
  } else assertAnalysis(false, 'Narrative input and output kinds do not match.')
}

export async function readAnalysisNarrativePublication(
  blobs: Pick<AnalysisBlobStore, 'read'>, record: RealAnalysisNarrativeRecord, published = record.published,
): Promise<RealAnalysisNarrativeArtifact | undefined> {
  if (!published) return undefined
  const artifact = parseAnalysisNarrativeArtifact(parseAnalysisJson(await readAnalysisBlob(blobs, published.blob, record.workspaceId, record.runId)))
  const kind = record.recordType === 'analysis-candidate-narrative' ? 'candidate' : 'target'
  const subject = record.recordType === 'analysis-candidate-narrative' ? record.comparisonId : record.targetId
  const referenceMatches = (reference: AnalysisNarrativePublicationReference) =>
    reference.revision === reference.blob.sha256 && reference.blob.blobName === analysisNarrativeBlobName(
      record.workspaceId, record.runId, kind, subject, reference.generationId,
      reference.blob.blobName.split('/')[6]?.replace(/\.json$/, ''))
  assertAnalysis(referenceMatches(published) && artifact.kind === kind &&
    artifact.generationId === published.generationId && artifact.inputFingerprint === published.inputFingerprint &&
    artifact.createdAt === published.publishedAt && artifact.binding.workspaceId === record.workspaceId &&
    artifact.binding.runId === record.runId && artifact.binding.manifestSha256 === record.manifestSha256 &&
    artifact.binding.targetId === record.targetId && analysisHash(artifact.binding.targetSnapshot) === analysisHash(record.targetSnapshot) &&
    published.blob.blobName === analysisNarrativeBlobName(record.workspaceId, record.runId, kind, subject,
      artifact.generationId, artifact.provenance.attemptId) &&
    (!artifact.previousPublication || referenceMatches(artifact.previousPublication) &&
      artifact.previousPublication.generationId !== artifact.generationId && artifact.previousPublication.publishedAt <= artifact.createdAt),
  'Narrative publication crossed its frozen identity or generation.')
  if (record.recordType === 'analysis-candidate-narrative') assertAnalysis(artifact.kind === 'candidate' &&
    artifact.binding.comparisonId === record.comparisonId && artifact.binding.resultSha256 === record.resultSha256 &&
    analysisHash(artifact.binding.resumeSnapshot) === analysisHash(record.resumeSnapshot), 'Narrative publication has a different candidate result.')
  return artifact
}
