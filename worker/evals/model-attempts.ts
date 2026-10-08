import type { ProcessingSettingsSnapshot } from '../../src/domain/admin-settings'
import type { ModelAttemptUsage } from '../model-usage'
import { estimateModelUsdMicros, modelPriceSchema } from './costs'

export interface EvaluationAttemptOptions {
  recordAttempt: (attempt: ModelAttemptUsage, amountUsdMicros: number | null, priceVersion: string) => Promise<void>
}

export function evaluationAttemptRecorder(
  settings: ProcessingSettingsSnapshot,
  prices: Map<string, ReturnType<typeof modelPriceSchema.parse>>,
  options: EvaluationAttemptOptions,
) {
  let recordingError: { error: unknown } | undefined
  return {
    rethrowRecordingFailure() {
      if (recordingError) throw recordingError.error
    },
    async onModelAttempt(attempt: ModelAttemptUsage) {
      try {
        const price = prices.get(attempt.deployment)
        if (!price) {
          await options.recordAttempt(attempt, null, 'unverified-deployment')
          throw new Error('Unexpected deployment in a captured evaluation request.')
        }
        const binding = attempt.taskId === null ? undefined : settings.tasks[attempt.taskId]
        const expectedModel = binding?.deploymentName === attempt.deployment
          ? `${binding.modelName}-${binding.modelVersion}` : null
        const successfulResponse = attempt.httpStatus !== null && attempt.httpStatus >= 200 && attempt.httpStatus < 300
        const modelChanged = (successfulResponse || attempt.actualModel !== null) &&
          (expectedModel === null || attempt.actualModel !== expectedModel)
        const usage = attempt.usage
        const amount = !modelChanged && usage && usage.cachedInputTokens !== null
          ? estimateModelUsdMicros(usage, price) : null
        await options.recordAttempt(attempt, amount, price.version)
        if (modelChanged) throw new Error('The responding model differs from the frozen evaluation deployment/version; its cost remains unknown.')
      } catch (error) {
        recordingError = { error }
        throw error
      }
    },
  }
}
