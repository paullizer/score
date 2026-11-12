import { z } from 'zod'
import { QC_LIMITS, qcComparisonRefSchema, qcHash, qcIdentifier, qcScopeKey } from './quality-control'
import { QC_PROMPT_FAMILIES } from './quality-improvement'

export const pipelinePlanSchema = z.strictObject({
  workspaceId: qcIdentifier,
  id: qcIdentifier,
  name: z.string().min(1).max(160),
  revision: z.number().int().positive(),
  status: z.enum(['draft', 'planning', 'evaluating', 'ready', 'failed', 'cancelled', 'activated', 'invalidated']),
  updatedAt: z.iso.datetime(),
})
export type PipelinePlan = z.infer<typeof pipelinePlanSchema>

export const pipelinePlansSchema = z.strictObject({
  workspaceId: qcIdentifier,
  items: z.array(pipelinePlanSchema).max(QC_LIMITS.pageSize),
  continuationToken: z.string().min(1).max(24 * 1024).optional(),
})

const bundlePin = z.strictObject({ id: qcIdentifier, sha256: qcHash.nullable() })
export const pipelineDetailSchema = z.strictObject({
  plan: pipelinePlanSchema,
  casePackSha256: qcHash,
  cases: z.array(z.strictObject({
    scope: qcComparisonRefSchema,
    purpose: z.enum(['drafting', 'holdout']),
    includedReviews: z.number().int().min(0).max(QC_LIMITS.selectedReviews),
  })).max(QC_LIMITS.planCases),
  excludedReviews: z.number().int().min(0).max(QC_LIMITS.selectedReviews),
  changedFamilies: z.array(z.enum(QC_PROMPT_FAMILIES)).max(QC_PROMPT_FAMILIES.length),
  tasks: z.array(z.strictObject({
    family: z.enum(QC_PROMPT_FAMILIES),
    deployment: z.string().min(1),
    model: z.string().min(1),
    modelVersion: z.string().nullable(),
  })).length(QC_PROMPT_FAMILIES.length),
  settings: z.strictObject({ revision: z.string().min(1), capturedAt: z.iso.datetime() }),
  baseline: bundlePin,
  candidate: bundlePin.nullable(),
  evaluation: z.strictObject({
    sha256: qcHash,
    completedAt: z.iso.datetime(),
    eligibleAtCompletion: z.boolean(),
    trials: z.number().int().min(0).max(QC_LIMITS.planCases * QC_PROMPT_FAMILIES.length),
    holdoutTrials: z.number().int().min(0),
    failedBaselineTrials: z.number().int().min(0),
    failedCandidateTrials: z.number().int().min(0),
  }).nullable(),
  work: z.strictObject({
    kind: z.enum(['plan', 'evaluation']),
    status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']),
    attempts: z.number().int().min(0),
    nextAttemptAt: z.iso.datetime().nullable(),
  }).nullable(),
  activatedBundleId: qcIdentifier.nullable(),
}).superRefine((value, context) => {
  if (new Set(value.changedFamilies).size !== value.changedFamilies.length ||
    new Set(value.tasks.map(task => task.family)).size !== QC_PROMPT_FAMILIES.length ||
    new Set(value.cases.map(item => qcScopeKey(item.scope))).size !== value.cases.length ||
    value.cases.reduce((count, item) => count + item.includedReviews, 0) > QC_LIMITS.selectedReviews) {
    context.addIssue({ code: 'custom', message: 'Pipeline metadata contains duplicate or excessive selections.' })
  }
  if (Boolean(value.candidate) !== Boolean(value.evaluation) || value.evaluation &&
    (value.evaluation.holdoutTrials > value.evaluation.trials ||
      value.evaluation.failedBaselineTrials > value.evaluation.trials || value.evaluation.failedCandidateTrials > value.evaluation.trials ||
      value.evaluation.eligibleAtCompletion && (value.evaluation.failedBaselineTrials > 0 || value.evaluation.failedCandidateTrials > 0))) {
    context.addIssue({ code: 'custom', message: 'Pipeline evaluation metadata is inconsistent.' })
  }
})
export type PipelinePlans = z.infer<typeof pipelinePlansSchema>
export type PipelineDetail = z.infer<typeof pipelineDetailSchema>
