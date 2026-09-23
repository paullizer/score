import { trace } from '@opentelemetry/api'
import { ASSIST_LIMITS, type AssistResponse } from '../../src/domain/assist'
import { resolveTaskModel, type ProcessingSettingsSnapshot, type ResolvedTaskModel } from '../../src/domain/admin-settings'
import { WorkerError } from '../../worker/errors'
import { inputSize, RuntimeSettingsError, validateProcessingSettings } from '../../worker/settings'
import { HttpError, invalidRequest, tooManyRequests, unavailable } from '../errors'
import { traceOperation } from '../telemetry-operations'
import { safeAttributes } from '../telemetry-schema'
import type { AssistConversationTurn } from '../../src/domain/assist'
import type { AssistProfile, AssistPromptParts, AssistRunInput } from './types'

const REQUEST_OVERHEAD_ALLOWANCE = 1024
const MAX_VALIDATION_ERRORS = 20
const MAX_VALIDATION_ERROR_CHARACTERS = 300

export class AssistCancelledError extends Error {
  constructor() {
    super('Assistant request was cancelled.')
    this.name = 'AssistCancelledError'
  }
}

interface PromptBuild {
  parts: AssistPromptParts
  conversation: AssistConversationTurn[]
  turnsDropped: number
}

export async function runAssist<TContext, TOperation>(
  input: AssistRunInput<TContext, TOperation>,
): Promise<AssistResponse<TOperation>> {
  const started = input.now?.() ?? Date.now()
  const deadlineAt = started + (input.deadlineMilliseconds ?? ASSIST_LIMITS.serverDeadlineMilliseconds)
  const telemetry = {
    correctionCount: 0,
    operationCount: 0,
    turnsSent: input.conversation.length,
    turnsDropped: 0,
  }

  return traceOperation('score.assist.run', {
    'score.assist.kind': input.profile.kind,
    'score.assist.turns_sent': telemetry.turnsSent,
  }, async () => {
    try {
      return await runAssistInner(input, deadlineAt, telemetry)
    } finally {
      // Counts are only known at the end; record them on the active span (metadata only, never content).
      trace.getActiveSpan()?.setAttributes(safeAttributes({
        'score.assist.kind': input.profile.kind,
        'score.assist.correction_count': telemetry.correctionCount,
        'score.assist.operation_count': telemetry.operationCount,
        'score.assist.turns_sent': telemetry.turnsSent,
        'score.assist.turns_dropped': telemetry.turnsDropped,
      }))
    }
  })
}

async function runAssistInner<TContext, TOperation>(
  input: AssistRunInput<TContext, TOperation>,
  deadlineAt: number,
  telemetry: { correctionCount: number; operationCount: number; turnsSent: number; turnsDropped: number },
): Promise<AssistResponse<TOperation>> {
  const now = input.now ?? Date.now
  const maxCorrections = clampCorrections(input.maxCorrections)
  let correction: string[] | undefined
  for (let attempt = 0; attempt <= maxCorrections; attempt += 1) {
    throwIfCancelled(input.signal)
    if (now() >= deadlineAt) throw tookTooLong()
    let prompt: PromptBuild
    try {
      prompt = buildFittingPrompt(input.profile, input.context, input.instruction, input.conversation, correction, input.processingSettings)
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw mapProviderError(error, now)
    }
    telemetry.turnsSent = prompt.conversation.length
    telemetry.turnsDropped = prompt.turnsDropped
    let content: string
    let model: string
    try {
      const result = await input.invoke({
        taskId: input.profile.taskId,
        name: input.profile.schemaName,
        schema: input.profile.jsonSchema(input.context),
        system: prompt.parts.system,
        user: prompt.parts.user,
        source: prompt.parts.source,
        maxCompletionTokens: input.profile.maxCompletionTokens,
        processingSettings: input.processingSettings,
        deadlineAt,
      }, input.signal)
      content = result.content
      model = result.model
    } catch (error) {
      throw mapProviderError(error, now)
    }
    throwIfCancelled(input.signal)
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      correction = ['Response was not valid JSON.']
      telemetry.correctionCount = attempt + 1
      if (attempt === maxCorrections) throw invalidModelResponse(correction)
      continue
    }
    const validation = input.profile.validate(parsed, input.context)
    if (validation.ok) {
      telemetry.operationCount = validation.value.operations.length
      return {
        outcome: validation.value.outcome,
        reply: validation.value.reply,
        operations: validation.value.operations,
        warnings: validation.value.warnings,
        assistant: { promptVersion: input.profile.promptVersion, model },
      }
    }
    correction = cleanValidationErrors(validation.errors)
    telemetry.correctionCount = attempt + 1
    if (attempt === maxCorrections) throw invalidModelResponse(correction)
  }
  throw invalidModelResponse(correction ?? ['Response was invalid.'])
}

function buildFittingPrompt<TContext>(
  profile: AssistProfile<TContext, unknown>,
  context: TContext,
  instruction: string,
  conversation: readonly AssistConversationTurn[],
  correction: readonly string[] | undefined,
  processingSettings: ProcessingSettingsSnapshot | undefined,
): PromptBuild {
  const task = resolvedTask(processingSettings, profile.taskId)
  let candidate = [...conversation]
  for (;;) {
    const parts = profile.buildPrompt({ context, instruction, conversation: candidate, correction })
    if (!task) return { parts, conversation: candidate, turnsDropped: conversation.length - candidate.length }
    assertSourceFits(task, parts.source)
    if (requestFits(task, profile, context, parts)) return { parts, conversation: candidate, turnsDropped: conversation.length - candidate.length }
    if (candidate.length === 0) throw promptTooLarge()
    candidate = candidate.slice(1)
  }
}

function resolvedTask(processingSettings: ProcessingSettingsSnapshot | undefined, taskId: ResolvedTaskModel['taskId']): ResolvedTaskModel | undefined {
  if (!processingSettings) return undefined
  return resolveTaskModel(validateProcessingSettings(processingSettings), taskId)
}

function assertSourceFits(task: ResolvedTaskModel, source: string): void {
  if (inputSize(source, task.inputBudget.unit) > task.inputBudget.maxInput) {
    throw invalidRequest('This job source exceeds the assistant\'s model input budget. Nothing was truncated.')
  }
}

function requestFits<TContext>(task: ResolvedTaskModel, profile: AssistProfile<TContext, unknown>, context: TContext, parts: AssistPromptParts): boolean {
  const body = {
    model: task.deploymentName,
    messages: [{ role: 'system', content: parts.system }, { role: 'user', content: parts.user }],
    response_format: { type: 'json_schema', json_schema: { name: profile.schemaName, strict: true, schema: profile.jsonSchema(context) } },
    max_completion_tokens: task.completionTokenLimit,
    ...(task.reasoningEffort ? { reasoning_effort: task.reasoningEffort } : {}),
    ...(task.temperature !== null ? { temperature: task.temperature } : {}),
    ...(task.topP !== null ? { top_p: task.topP } : {}),
  }
  const serialized = JSON.stringify(body)
  return inputSize(serialized, task.inputBudget.unit) + REQUEST_OVERHEAD_ALLOWANCE <= task.inputBudget.maxRequest &&
    Buffer.byteLength(serialized, 'utf8') + task.completionTokenLimit + task.inputBudget.reservedTokens + REQUEST_OVERHEAD_ALLOWANCE <=
      task.capabilities.contextTokens
}

function promptTooLarge(): HttpError {
  return invalidRequest('The job source and draft are too large for the assistant with the current model budget. Nothing was truncated.')
}

function cleanValidationErrors(errors: readonly string[]): string[] {
  return [...new Set(errors.map(error => error.trim()).filter(Boolean))]
    .slice(0, MAX_VALIDATION_ERRORS)
    .map(error => error.length > MAX_VALIDATION_ERROR_CHARACTERS ? `${error.slice(0, MAX_VALIDATION_ERROR_CHARACTERS - 1).trimEnd()}…` : error)
}

function invalidModelResponse(errors: readonly string[]): HttpError {
  const summary = cleanValidationErrors(errors).slice(0, 3).join('; ') || 'Response was invalid.'
  return new HttpError(502, 'unavailable', `The assistant could not produce a valid change (${summary}). Your draft is unchanged; try rephrasing.`)
}

function tookTooLong(): HttpError {
  return unavailable('The assistant took too long to respond. Your draft is unchanged; try again or simplify the request.')
}

function mapProviderError(error: unknown, now: () => number): Error {
  if (isAbortLike(error)) return new AssistCancelledError()
  if (error instanceof RuntimeSettingsError) {
    if (error.code === 'model-context-limit') return promptTooLarge()
    return unavailable('The assistant is temporarily unavailable. Your draft is unchanged.')
  }
  if (error instanceof WorkerError || isWorkerErrorLike(error)) {
    const provider = error as WorkerError
    if (provider.cancelled) return new AssistCancelledError()
    if (provider.httpStatus === 429) {
      const retryAfter = retryAfterSeconds(provider.retryAt, now(), 30)
      return tooManyRequests(`The model is busy right now (rate limited). Try again in about ${retryAfter} seconds. Your draft is unchanged.`, retryAfter)
    }
    if (provider.httpStatus === 401 || provider.httpStatus === 403) {
      return unavailable('The assistant\'s model access is misconfigured. Contact an administrator.')
    }
    if (provider.code === 'request-timeout') return tookTooLong()
    if (provider.code === 'model-refused') return new HttpError(502, 'unavailable', 'The model declined this request. Your draft is unchanged.')
    if (provider.code === 'model-context-limit') return promptTooLarge()
  }
  return unavailable('The assistant is temporarily unavailable. Your draft is unchanged.')
}

function retryAfterSeconds(retryAt: string | undefined, current: number, fallback: number): number {
  const parsed = retryAt ? Date.parse(retryAt) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.ceil((parsed - current) / 1000))
}

function isWorkerErrorLike(error: unknown): error is Pick<WorkerError, 'code' | 'httpStatus' | 'retryAt' | 'cancelled'> {
  return typeof error === 'object' && error !== null && 'code' in error &&
    ('httpStatus' in error || 'retryAt' in error || 'cancelled' in error)
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AssistCancelledError()
}

function clampCorrections(value: number): number {
  return Math.max(0, Math.min(2, Number.isFinite(value) ? Math.floor(value) : 0))
}
