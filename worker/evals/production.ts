import { processingSettingsSnapshotSchema } from '../../src/domain/admin-settings-schema'
import { AnalysisModelError, assessResumeAgainstTarget, validateAnalysisAssessmentInput } from '../analyses/model'
import type { RubricModelOptions } from '../runtime'
import type { ModelAttemptUsage } from '../model-usage'
import { evaluationHash } from './statistics'
import type { ScoringEvaluationJob } from './executor'
import type { ScoringObservation, ScoringSuite } from './contracts'
import { modelPriceSchema } from './costs'
import { createDefaultAdminSettings, modelCapabilitiesFor } from '../../src/domain/admin-settings-defaults'
import { captureProcessingSettings } from '../../src/domain/admin-settings-resolver'
import { createCompiledPromptBaseline } from '../../server/settings/prompts'
import { z } from 'zod'
import { extractMarkdown } from '../runtime'
import { assessmentInputSchema } from '../analyses/model-schema'
import { analysisAssessmentHash, analysisRequirementEvidenceForInput } from '../../server/analyses/deterministic'
import { assessEvidenceFirst, EVIDENCE_FIRST_VERSION } from './evidence-first'
import { assessSourceOnlyReference, SOURCE_REFERENCE_VERSION } from './reference-model'
import type { AnalysisAssessmentDiagnostic } from '../../src/domain/analysis-diagnostics'
import { evaluationAttemptRecorder } from './model-attempts'
import type { ModelTaskId } from '../../src/domain/admin-settings'

const evaluationBindingSchema = z.strictObject({
  deploymentName: z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  modelName: z.string().min(1).max(160),
  modelVersion: z.string().min(1).max(160),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']),
})

export function createEvaluationSettings(raw: unknown) {
  const value = z.strictObject({
    revision: z.string().min(1).max(160),
    capturedAt: z.string().datetime(),
    assessor: evaluationBindingSchema,
    reviewer: evaluationBindingSchema,
  }).parse(raw)
  const settings = createDefaultAdminSettings({
    model: {
      deploymentName: value.assessor.deploymentName,
      modelName: value.assessor.modelName,
      reasoningEffort: value.assessor.reasoningEffort,
    },
  })
  const bindings = [value.assessor]
  if (value.reviewer.deploymentName !== value.assessor.deploymentName) bindings.push(value.reviewer)
  else if (value.reviewer.modelName !== value.assessor.modelName || value.reviewer.modelVersion !== value.assessor.modelVersion) {
    throw new Error('One deployment cannot represent two different model identities.')
  }
  settings.ai.deployments = bindings.map((binding, index) => {
    const capabilities = modelCapabilitiesFor(binding.modelName, binding.modelVersion)
    if (!capabilities.structuredOutputs || !capabilities.reasoningEfforts.includes(binding.reasoningEffort)) {
      throw new Error('Evaluation model/version/effort has no verified application adapter.')
    }
    return {
      id: `evaluation-${index}`, label: binding.deploymentName, description: 'Explicit offline evaluation binding.',
      enabled: true, deploymentName: binding.deploymentName, modelName: binding.modelName,
      modelVersion: binding.modelVersion, capabilities,
      verification: 'deployment-config' as const, verifiedAt: null,
    }
  })
  settings.ai.defaultDeploymentId = 'evaluation-0'
  settings.ai.tasks.assessment.deploymentId = 'evaluation-0'
  settings.ai.tasks.assessment.reasoningEffort = value.assessor.reasoningEffort
  settings.ai.tasks.assessmentReview.deploymentId = bindings.length === 1 ? 'evaluation-0' : 'evaluation-1'
  settings.ai.tasks.assessmentReview.reasoningEffort = value.reviewer.reasoningEffort
  return captureProcessingSettings(settings, value.revision, value.capturedAt, createCompiledPromptBaseline(value.capturedAt))
}

export function freezeEvaluationInput(value: unknown) {
  return validateAnalysisAssessmentInput(value)
}

export function prepareResumeJobEvaluation(text: string, familyId: string, rawRubric: unknown) {
  const rubric = assessmentInputSchema.shape.rubric.parse(rawRubric)
  const extracted = extractMarkdown(new TextEncoder().encode(text), {
    defaultHeading: 'Resume', maxCharacters: 180_000,
  })
  return validateAnalysisAssessmentInput({
    resume: {
      id: `document-${familyId}`, kind: 'resume', sample: false, version: 1,
      title: extracted.title?.slice(0, 500) ?? 'Simulated professional profile',
      paragraphs: extracted.paragraphs,
    },
    rubric, qualifications: [],
    requirementEvidence: analysisRequirementEvidenceForInput({ rubric, qualifications: [] }),
  })
}

export interface ProductionEvaluationOptions {
  model: RubricModelOptions
  input: unknown
  processingSettings: unknown
  prices: Record<string, unknown>
  admitPaidWork: (job: ScoringEvaluationJob) => Promise<void>
  recordAttempt: (attempt: ModelAttemptUsage, amountUsdMicros: number | null, priceVersion: string) => Promise<void>
  recordPrivateResult: (result: Awaited<ReturnType<typeof assessResumeAgainstTarget>>) => Promise<void>
  recordPrivateDiagnostics?: (diagnostics: AnalysisAssessmentDiagnostic[]) => Promise<void>
  recordPrivateFailure?: (failure: { code: string; stage: string; reason: string | null }) => Promise<void>
}

export function validateEvaluationCaseInput(item: ScoringSuite['cases'][number], rawInput: unknown) {
  const input = validateAnalysisAssessmentInput(rawInput)
  const exclusions = input.rubric.kind === 'grade'
    ? input.rubric.criteria.filter(row => row.support === 'not-applicable').map(row => row.id) : []
  const capturedExclusions = item.excludedCriterionIds ?? []
  if (exclusions.length !== capturedExclusions.length || exclusions.some(id => !capturedExclusions.includes(id))) {
    throw new Error('Evaluation case must capture exactly its saved grade exclusions.')
  }
  if (evaluationHash(input) !== item.inputSha256 ||
    input.rubric.criteria.length !== item.criterionIds.length ||
    input.rubric.criteria.some(row => !item.criterionIds.includes(row.id))) {
    throw new Error('Evaluation input does not match its exact saved case.')
  }
  return input
}

export function validateProductionEvaluation(
  job: ScoringEvaluationJob, options: Pick<ProductionEvaluationOptions, 'input' | 'processingSettings' | 'prices'>,
) {
  if (!['score-production-v1', EVIDENCE_FIRST_VERSION, SOURCE_REFERENCE_VERSION].includes(job.configuration.algorithmVersion)) {
    throw new Error('The production adapter cannot impersonate a different scoring algorithm.')
  }
  const { processingSettings, prices } = validateEvaluationModelSettings(job.configuration, options,
    ['assessment', 'assessmentReview'])
  const input = validateEvaluationCaseInput(job.case, options.input)
  return { input, processingSettings, prices }
}

export function validateEvaluationModelSettings(
  configuration: ScoringEvaluationJob['configuration'],
  options: Pick<ProductionEvaluationOptions, 'processingSettings' | 'prices'>,
  tasks: ModelTaskId[],
) {
  const processingSettings = processingSettingsSnapshotSchema.parse(options.processingSettings)
  if (evaluationHash(processingSettings) !== configuration.settingsSha256) {
    throw new Error('Evaluation settings do not match the frozen configuration.')
  }
  const prices = new Map<string, ReturnType<typeof modelPriceSchema.parse>>()
  for (const taskId of tasks) {
    const binding = processingSettings.tasks[taskId]
    if (!binding) throw new Error('Evaluation requires each frozen task binding.')
    if (binding.modelVersion === null) throw new Error('Paid evaluation requires an explicit frozen model version.')
    const rawPrice = options.prices[binding.deploymentName]
    if (rawPrice === undefined) throw new Error('Verified deployment prices are required before paid inference.')
    prices.set(binding.deploymentName, modelPriceSchema.parse(rawPrice))
  }
  return { processingSettings, prices }
}

export async function executeProductionEvaluation(
  job: ScoringEvaluationJob, options: ProductionEvaluationOptions, signal?: AbortSignal,
): Promise<ScoringObservation['result']> {
  const { input, processingSettings, prices } = validateProductionEvaluation(job, options)
  signal?.throwIfAborted()
  await options.admitPaidWork(job)
  signal?.throwIfAborted()
  const attempts = evaluationAttemptRecorder(processingSettings, prices, options)
  const diagnostics: AnalysisAssessmentDiagnostic[] = []
  try {
    const assessor = job.configuration.algorithmVersion === SOURCE_REFERENCE_VERSION ? assessSourceOnlyReference
      : job.configuration.algorithmVersion === EVIDENCE_FIRST_VERSION ? assessEvidenceFirst : assessResumeAgainstTarget
    const result = await assessor(input, {
      signal,
      onDiagnostic: diagnostic => { diagnostics.push(structuredClone(diagnostic)) },
      resumeSnapshotSha256: evaluationHash(input.resume),
      targetSnapshotSha256: evaluationHash({ rubric: input.rubric, qualifications: input.qualifications }),
      model: {
        ...options.model, processingSettings,
        onModelAttempt: attempts.onModelAttempt,
      },
    })
    await options.recordPrivateResult(structuredClone(result))
    signal?.throwIfAborted()
    return {
      status: 'complete',
      assessmentSha256: analysisAssessmentHash(result.assessment),
      overall: result.summary.overall.status === 'available' ? result.summary.overall.score : null,
      criteria: result.assessment.criteria.map(row => ({ criterionId: row.criterionId, score: row.score })),
    }
  } catch (error) {
    attempts.rethrowRecordingFailure()
    if (!(error instanceof AnalysisModelError) || error.cancelled || signal?.aborted) throw error
    await options.recordPrivateFailure?.({ code: error.code, stage: error.stage, reason: error.reason ?? null })
    return { status: 'failed', code: error.code }
  } finally {
    if (diagnostics.length && options.recordPrivateDiagnostics) {
      await options.recordPrivateDiagnostics(diagnostics)
    }
    signal?.throwIfAborted()
  }
}
