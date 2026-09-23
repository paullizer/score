import type { TokenCredential } from '@azure/core-auth'
import type { Clock } from '../../worker/clock'
import { invokeStructuredModel } from '../../worker/model-transport'
import type { RubricModelOptions, StructuredModelRequest } from '../../worker/runtime'
import type { AssistModelInvoker, AssistModelRequest } from './types'

export interface AzureAssistModelInvokerOptions {
  endpoint: string
  deploymentName: string
  modelName: string
  reasoningEffort?: string
  credential: TokenCredential
  fetch?: typeof fetch
  clock?: Clock
}

export function createAzureAssistModelInvoker(options: AzureAssistModelInvokerOptions): AssistModelInvoker {
  const model: RubricModelOptions = {
    endpoint: options.endpoint,
    deployment: options.deploymentName,
    modelName: options.modelName,
    reasoningEffort: options.reasoningEffort,
    fetch: options.fetch,
    clock: options.clock,
    getToken: async scope => {
      const token = await options.credential.getToken(scope)
      if (!token?.token) throw new Error('The assistant model credential did not return an access token.')
      return token.token
    },
  }

  return async (request: AssistModelRequest, signal: AbortSignal) => {
    const structured: StructuredModelRequest = {
      name: request.name,
      schema: request.schema,
      system: request.system,
      user: request.user,
      source: request.source,
      maxCompletionTokens: request.maxCompletionTokens,
      operation: 'rubric',
      taskId: request.taskId,
      processingSettings: request.processingSettings,
      deadlineAt: request.deadlineAt,
    }
    return invokeStructuredModel(model, structured, signal)
  }
}
