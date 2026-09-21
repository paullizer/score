import { systemClock } from './clock'
import { WorkerError } from './errors'
import { assertModelBudget, safeSettingsMetadata, taskForRequest, validateProcessingSettings } from './settings'
import type { RubricModelOptions, StructuredModelRequest } from './runtime'

const COGNITIVE_SCOPE = 'https://cognitiveservices.azure.com/.default'
const TRANSIENT_STATUSES = [429, 502, 503, 504]

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      Promise.resolve().then(() => {
        if (signal.aborted) throw signal.reason
        return operation()
      }).then(resolve, reject)
    })
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Shared Azure-only structured transport; contains no renderer, OCR, or private-store dependencies. */
export async function invokeStructuredModel(
  options: RubricModelOptions, request: StructuredModelRequest, signal?: AbortSignal,
): Promise<{ content: string; model: string }> {
  const cancelled = () => new WorkerError('cancelled', 'Operation was cancelled.', false, 'rubric')
  if (signal?.aborted) throw cancelled()
  const captured = request.processingSettings !== undefined ? request.processingSettings : options.processingSettings
  const settings = captured !== undefined ? validateProcessingSettings(captured) : undefined
  const task = taskForRequest(options, { ...request, processingSettings: settings })
  const reasoning = task ? task.reasoningEffort : options.reasoningEffort
  const body = {
    model: task?.deploymentName ?? options.deployment,
    messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
    response_format: { type: 'json_schema', json_schema: { name: request.name, strict: true, schema: request.schema } },
    max_completion_tokens: task?.completionTokenLimit ?? request.maxCompletionTokens ?? 8_192,
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
    ...(task?.temperature !== undefined && task.temperature !== null ? { temperature: task.temperature } : {}),
    ...(task?.topP !== undefined && task.topP !== null ? { top_p: task.topP } : {}),
  }
  assertModelBudget(task, request, body)
  if (settings?.settings.logging.detail === 'diagnostic-metadata') console.info('Score model settings:', safeSettingsMetadata(settings, request.taskId))
  const context = {
    rubric: { action: 'Rubric generation', result: 'a rubric', noun: 'rubric' },
    resume: { action: 'Resume profiling', result: 'a resume profile', noun: 'resume profile' },
    analysis: { action: 'Resume analysis', result: 'an analysis', noun: 'analysis' },
  }[request.operation ?? 'rubric']
  const clock = options.clock ?? systemClock
  const endpoint = `${options.endpoint.replace(/\/+$/, '')}/openai/v1/chat/completions`
  const fetchImpl = options.fetch ?? fetch
  const attempts = settings?.settings.ai.transport.maxAttempts ?? 2
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new WorkerError('request-timeout', 'An Azure processing request timed out.', true, 'rubric')),
      settings?.settings.ai.requestTimeoutMilliseconds ?? 60_000)
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    let authenticated = false
    try {
      return await abortable(async () => {
        const token = await options.getToken(COGNITIVE_SCOPE)
        authenticated = true
        if (combined.aborted) throw combined.reason
        const response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal: combined,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (TRANSIENT_STATUSES.includes(response.status)) throw response
        if (!response.ok) throw new WorkerError('model-request-failed', `${context.action} returned HTTP ${response.status}.`,
          response.status >= 500 || response.status === 429, 'rubric')
        let payload: {
          model?: string
          choices?: Array<{ finish_reason?: string; message?: { content?: string; refusal?: string; tool_calls?: unknown; function_call?: unknown } }>
        }
        try { payload = await response.json() } catch (error) {
          if (combined.aborted) throw combined.reason
          if (error instanceof SyntaxError) throw new WorkerError('model-invalid-response', 'The model returned invalid JSON.', false, 'rubric')
          throw error
        }
        const choice = payload?.choices?.[0]
        if (choice?.message?.refusal) throw new WorkerError('model-refused', `The model could not produce ${context.result} for this source.`, false, 'rubric')
        const content = choice?.message?.content
        if (!content) throw new WorkerError('model-empty-response', `The model returned no ${context.noun}.`, true, 'rubric')
        if (choice?.finish_reason === 'length') throw new WorkerError('model-context-limit', 'The model exhausted its completion budget; no partial result was used.', false, 'rubric')
        if (payload.choices?.length !== 1 || choice?.message?.tool_calls || choice?.message?.function_call ||
          (choice?.finish_reason !== undefined && choice.finish_reason !== 'stop') ||
          typeof payload.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/.test(payload.model)) {
          throw new WorkerError('model-invalid-response', 'The model response is incomplete or does not identify its actual model. No configured identity was substituted.', false, 'rubric')
        }
        return { content, model: payload.model }
      }, combined)
    } catch (error) {
      if (signal?.aborted) throw cancelled()
      if (!authenticated && !timeout.signal.aborted) throw error
      const failure = timeout.signal.aborted ? timeout.signal.reason
        : error instanceof WorkerError || error instanceof Response ? error
          : new WorkerError('request-failed', 'An Azure processing request failed.', true, 'rubric', { cause: error })
      const transient = failure instanceof Response ? TRANSIENT_STATUSES.includes(failure.status)
        : failure instanceof WorkerError && ['request-failed', 'request-timeout'].includes(failure.code)
      if (!transient || attempt + 1 === attempts) throw failure
    } finally { clearTimeout(timer) }
    await clock.sleep(500 * 2 ** attempt, signal)
  }
  throw new WorkerError('model-request-failed', 'The model transport exhausted its captured attempt budget.', false, 'rubric')
}
