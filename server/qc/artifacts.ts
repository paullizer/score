import { z } from 'zod'
import { QC_LIMITS, qcHash, qcIdentifier, type QcBlobReference } from '../../src/domain/quality-control'
import {
  QC_PROMPT_FAMILIES, qcPlanProposalSchema, type QcCasePack, type QcEvaluation, type QcPlanRecord, type QcPromptFamily, type QcTrialResult, type QcTrialScope,
} from '../../src/domain/quality-improvement'
import { promptBundleSnapshotSchema, type PromptBundleSnapshot } from '../../src/domain/prompt-versions'
import { validatePromptSnapshot } from '../settings/prompt-integrity'
import { invalidRequest } from '../errors'
import type { QcBlobStore } from './store'
import {
  parseQcCasePack, parseQcEvaluation, qcAssert, qcBlobScope, qcBytesHash, qcCandidateGuidance,
  qcEvaluationCaseSchema, qcPlanHash, qcSettingsHash, qcTrialResultSchema, qcValueHash,
} from './validation'

export const qcPlannerProvenanceSchema = z.strictObject({
  schemaVersion: z.literal(1), taskId: qcIdentifier, actualModel: z.string().min(1).max(300),
  promptVersion: qcIdentifier, promptSha256: qcHash, outputSchemaVersion: qcIdentifier, outputSchemaSha256: qcHash,
  inputSha256: qcHash, proposalSha256: qcHash, settingsSha256: qcHash, completedAt: z.iso.datetime(),
})
export type QcPlannerProvenance = z.infer<typeof qcPlannerProvenanceSchema>
export const qcPlanCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1), workId: qcIdentifier, planHash: qcHash,
  proposal: qcPlanProposalSchema, provenance: qcPlannerProvenanceSchema,
})
export function parseQcPlanCheckpoint(value: unknown, plan: QcPlanRecord, workId: string) {
  const parsed = qcPlanCheckpointSchema.parse(value)
  qcAssert(parsed.workId === workId && parsed.planHash === qcPlanHash(plan) &&
    parsed.provenance.proposalSha256 === qcValueHash(parsed.proposal) &&
    parsed.provenance.settingsSha256 === qcSettingsHash(plan.processingSettings),
  'QC planner checkpoint belongs to different work.')
  return parsed
}

export interface QcTrialExecution {
  scopeHash: string
  familyId: QcPromptFamily
  baselineModels: Record<string, string>
  candidateModels: Record<string, string>
}
export function qcTrialModelsMatch(value: QcTrialExecution): boolean {
  const required: Record<QcPromptFamily, string[]> = {
    assessment: ['assessment', 'assessmentReview'],
    jobRubric: ['jobRubric'],
    gradeDraft: ['gradeDraft', 'gradeReview'],
    gradeCompetencies: ['gradeCompetencies', 'gradeDraft', 'gradeReview'],
  }
  const tasks = required[value.familyId]
  return [value.baselineModels, value.candidateModels].every(models => Object.keys(models).length === tasks.length &&
    tasks.every(task => typeof models[task] === 'string' && models[task].trim().length > 0)) &&
    qcValueHash(value.baselineModels) === qcValueHash(value.candidateModels)
}
export interface QcEvaluationArtifact {
  schemaVersion: 1
  evaluation: QcEvaluation
  candidate: PromptBundleSnapshot
  executions: QcTrialExecution[]
}
export interface QcEvaluationCheckpoint {
  schemaVersion: 1
  workId: string
  planHash: string
  startedAt: string
  candidate: PromptBundleSnapshot
  cases: QcEvaluation['cases']
  executions: QcTrialExecution[]
  pendingTrial?: {
    scopeHash: string
    familyId: QcPromptFamily
    baseline: QcTrialResult
    models: Record<string, string>
  }
}
const models = z.record(qcIdentifier, z.string().min(1).max(300))
const execution = z.strictObject({
  scopeHash: qcHash, familyId: z.enum(QC_PROMPT_FAMILIES), baselineModels: models, candidateModels: models,
})
export async function readQcJson(blobs: QcBlobStore, reference: QcBlobReference, workspaceId: string, ownerId: string): Promise<unknown> {
  qcBlobScope(reference, workspaceId, ownerId)
  const bytes = await blobs.read(reference)
  qcAssert(bytes.length === reference.bytes && bytes.length <= QC_LIMITS.artifactBytes && qcBytesHash(bytes) === reference.sha256,
    'QC artifact content does not match its immutable digest.')
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { throw new Error('QC artifact JSON is invalid.') }
}
export async function putQcJson(
  blobs: QcBlobStore, workspaceId: string, ownerId: string, value: unknown,
  fence: NonNullable<Parameters<QcBlobStore['put']>[3]>,
): Promise<QcBlobReference> {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length > QC_LIMITS.artifactBytes) throw invalidRequest('The complete QC artifact exceeds 16 MiB. Narrow or partition the selected cases; no evidence was truncated.')
  await fence.assertActive()
  const result = await blobs.put(workspaceId, ownerId, bytes, fence)
  qcBlobScope(result, workspaceId, ownerId)
  qcAssert(result.sha256 === qcBytesHash(bytes) && result.bytes === bytes.length)
  await fence.assertActive()
  return result
}
export async function readQcCasePack(blobs: QcBlobStore, record: QcPlanRecord): Promise<QcCasePack> {
  const pack = parseQcCasePack(await readQcJson(blobs, record.casePack, record.workspaceId, record.id), record.workspaceId, record.id)
  qcAssert(qcValueHash(pack.cases.map(item => item.selection)) === qcValueHash(record.cases) &&
    pack.createdBy.principalId === record.createdBy.principalId, 'QC case pack selection or creator changed.')
  return pack
}
export function qcFamilyApplies(familyId: QcPromptFamily, kind: 'job' | 'grade'): boolean {
  return familyId === 'assessment' || familyId === 'jobRubric' && kind === 'job' ||
    (familyId === 'gradeCompetencies' || familyId === 'gradeDraft') && kind === 'grade'
}
export function qcPlannedTrials(plan: QcPlanRecord, pack: QcCasePack) {
  return pack.cases.flatMap(entry => (plan.proposal?.changes ?? []).filter(change =>
    qcFamilyApplies(change.familyId, entry.analysis.targetSnapshot.kind)).map(change => ({ entry, familyId: change.familyId })))
}
export function qcTrialScope(plan: QcPlanRecord, pack: QcCasePack): QcTrialScope {
  const pairs = qcPlannedTrials(plan, pack).map(({ entry, familyId }) => ({
    scope: entry.selection.scope, purpose: entry.selection.purpose, familyId,
  }))
  return {
    pairs, baselineTrials: pairs.length, candidateTrials: pairs.length,
    unsupportedFamilies: (plan.proposal?.changes ?? []).map(change => change.familyId)
      .filter(familyId => !pairs.some(pair => pair.familyId === familyId)),
  }
}
export function assertQcEvaluationCoverage(evaluation: QcEvaluation, plan: QcPlanRecord, pack: QcCasePack): void {
  const expected = qcTrialScope(plan, pack).pairs
  qcAssert(expected.length > 0 && expected.length === evaluation.cases.length &&
    expected.every(item => evaluation.cases.some(result => qcValueHash(item) === qcValueHash({
      scope: result.scope, familyId: result.familyId, purpose: result.purpose,
    }))), 'The evaluation did not cover every compatible selected case and changed prompt family.')
  qcAssert(plan.proposal?.changes.every(change => expected.some(item => item.familyId === change.familyId)),
    'Every changed prompt family needs a compatible frozen trial.')
  for (const item of evaluation.cases) {
    const entry = pack.cases.find(value => qcValueHash(value.selection.scope) === qcValueHash(item.scope))!
    for (const result of [item.baseline, item.candidate]) {
      qcAssert(result.exactAgreements <= result.reviewedCriteria && (result.status !== 'complete' || result.error === null))
      if (result.status === 'failed') qcAssert(!result.assessment && !result.summary && !result.rubric &&
        result.reviewedCriteria === 0 && result.exactAgreements === 0 && result.absoluteDifference === 0,
      'Failed trials cannot retain invalid output or numeric metrics.')
      if (item.familyId === 'assessment' && result.status === 'complete') {
        qcAssert(result.assessment && result.summary && !result.rubric &&
          result.assessment.criteria.length === entry.analysis.result!.criteria.length &&
          result.assessment.criteria.every(row => entry.analysis.result!.criteria.some(saved => row.criterionId === saved.criterionId &&
            row.weight === saved.weight)), 'Assessment trials must retain the exact saved criteria and weights.')
        const expectedMetrics = entry.selection.referenceDecisions.reduce((metrics, reference) => {
          const row = result.assessment!.criteria.find(criterion => criterion.criterionId === reference.criterionId)
          if (reference.score !== null && row?.score !== null && row?.score !== undefined) {
            metrics.reviewedCriteria++
            metrics.exactAgreements += row.score === reference.score ? 1 : 0
            metrics.absoluteDifference += Math.abs(row.score - reference.score)
          }
          return metrics
        }, { reviewedCriteria: 0, exactAgreements: 0, absoluteDifference: 0 })
        qcAssert(expectedMetrics.reviewedCriteria === result.reviewedCriteria &&
          expectedMetrics.exactAgreements === result.exactAgreements && expectedMetrics.absoluteDifference === result.absoluteDifference,
        'Trial metrics must use only comparable explicit curator references.')
      }
      if (item.familyId !== 'assessment') {
        qcAssert(result.reviewedCriteria === 0 && result.exactAgreements === 0 && result.absoluteDifference === 0 &&
          !result.assessment && !result.summary && (result.status !== 'complete' || result.rubric),
        'New rubric meanings cannot be scored against old criterion numbers.')
        if (result.rubric) qcAssert(new Set(result.rubric.criteria.map(row => row.id)).size === result.rubric.criteria.length &&
          Math.abs(result.rubric.criteria.reduce((total, row) => total + row.weight, 0) - 100) <= 0.0001 &&
          result.rubric.criteria.every(row => 'sourceCitations' in row && Array.isArray(row.sourceCitations) && row.sourceCitations.length > 0),
        'Successful generated rubric drafts must retain unique criteria, complete weights, and exact source citations.')
      }
    }
  }
}
export function parseQcEvaluationArtifact(value: unknown, plan: QcPlanRecord, pack?: QcCasePack): QcEvaluationArtifact {
  const parsed = z.strictObject({
    schemaVersion: z.literal(1), evaluation: z.unknown(), candidate: promptBundleSnapshotSchema,
    executions: z.array(execution).min(1).max(QC_LIMITS.planCases * QC_PROMPT_FAMILIES.length),
  }).parse(value)
  const evaluation = parseQcEvaluation(parsed.evaluation, plan)
  const candidate = validatePromptSnapshot(parsed.candidate)
  assertQcCandidate(candidate, plan)
  qcAssert(parsed.executions.length === evaluation.cases.length && parsed.executions.every((item, index) =>
    item.scopeHash === qcValueHash(evaluation.cases[index].scope) && item.familyId === evaluation.cases[index].familyId),
  'QC trial provenance is incomplete.')
  if (evaluation.eligible) qcAssert(parsed.executions.every(qcTrialModelsMatch),
  'Model drift prevents activation of this evaluation.')
  if (pack) assertQcEvaluationCoverage(evaluation, plan, pack)
  return { schemaVersion: 1, evaluation, candidate, executions: parsed.executions }
}
export function assertQcCandidate(candidate: PromptBundleSnapshot, plan: QcPlanRecord): void {
  validatePromptSnapshot(candidate)
  const baseline = plan.processingSettings.promptBundle
  qcAssert(baseline && candidate.bundle.parentBundleId === baseline.bundle.bundleId &&
    baseline.bundle.bundleId === plan.baseline.revision &&
    qcValueHash(qcCandidateGuidance(plan)) === qcValueHash(Object.fromEntries(QC_PROMPT_FAMILIES.map(family =>
      [family, candidate.revisions[family].guidance]))), 'QC evaluated prompt content differs from the candidate.')
  for (const family of ['gradeReview', 'assessmentGrounding', 'evidenceGapReview'] as const) {
    qcAssert(qcValueHash(candidate.revisions[family]) === qcValueHash(baseline.revisions[family]), 'Fixed grounding prompts cannot be calibrated.')
  }
}
export async function readQcEvaluation(blobs: QcBlobStore, plan: QcPlanRecord, pack?: QcCasePack): Promise<QcEvaluationArtifact | null> {
  return plan.evaluation ? parseQcEvaluationArtifact(await readQcJson(blobs, plan.evaluation, plan.workspaceId, plan.id), plan, pack) : null
}
export function qcCheckpointBinding(value: QcEvaluationCheckpoint, plan: QcPlanRecord, workId: string): void {
  z.strictObject({
    schemaVersion: z.literal(1), workId: qcIdentifier, planHash: qcHash, startedAt: z.iso.datetime(),
    candidate: promptBundleSnapshotSchema,
    cases: z.array(qcEvaluationCaseSchema).max(QC_LIMITS.planCases * QC_PROMPT_FAMILIES.length),
    executions: z.array(execution).max(QC_LIMITS.planCases * QC_PROMPT_FAMILIES.length),
    pendingTrial: z.strictObject({
      scopeHash: qcHash, familyId: z.enum(QC_PROMPT_FAMILIES), baseline: qcTrialResultSchema, models,
    }).optional(),
  }).parse(value)
  qcAssert(value.schemaVersion === 1 && value.workId === workId && value.planHash === qcPlanHash(plan) &&
    Number.isFinite(Date.parse(value.startedAt)) && Array.isArray(value.cases) &&
    value.cases.length <= QC_LIMITS.planCases * QC_PROMPT_FAMILIES.length, 'QC checkpoint belongs to different work.')
  validatePromptSnapshot(value.candidate)
  assertQcCandidate(value.candidate, plan)
  qcAssert(value.cases.length === value.executions.length)
}
