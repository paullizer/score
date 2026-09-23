import { systemClock } from './clock'
import { WorkerError } from './errors'
import { MAX_MODEL_RETRY_DELAY_MS, MAX_MODEL_RETRY_TIMESTAMP, modelRetryFallback, providerRetryAt } from './model-retry'
import { assertModelBudget, safeSettingsMetadata, taskForRequest, validateProcessingSettings } from './settings'
import { assertStrictStructuredOutputSchema, StructuredOutputSchemaError } from './structured-output-schema'
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
  const cancelled = () => new WorkerError('cancelled', 'Operation was cancelled.', false, 'rubric', { cancelled: true })
  if (signal?.aborted) throw cancelled()
  try {
    assertStrictStructuredOutputSchema(request.schema)
  } catch (error) {
    if (!(error instanceof StructuredOutputSchemaError)) throw error
    throw new WorkerError('model-schema-invalid',
      `Score built a response schema for ${request.name} that the AI service would reject, so the request was not sent. ` +
      `This is a Score software problem; retrying will not help until it is fixed. ${error.message}`,
      false, 'rubric', { cause: error })
  }
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
  const requestBody = JSON.stringify(body)
  if (settings?.settings.logging.detail === 'diagnostic-metadata') console.info('Score model settings:', safeSettingsMetadata(settings, request.taskId))
  const context = {
    rubric: { action: 'Rubric generation', result: 'a rubric', noun: 'rubric' },
    resume: { action: 'Resume profiling', result: 'a resume profile', noun: 'resume profile' },
    analysis: { action: 'Resume analysis', result: 'an analysis', noun: 'analysis' },
  }[request.operation ?? 'rubric']
  const clock = options.clock ?? systemClock
  const endpoint = `${options.endpoint.replace(/\/+$/, '')}/openai/v1/chat/completions`
  const fetchImpl = options.fetch ?? fetch
  const getToken = options.getToken
  const random = options.retryRandom ?? Math.random
  const onRetry = request.onRetry
  const attempts = settings?.settings.ai.transport.maxAttempts ?? 2
  const requestTimeout = settings?.settings.ai.requestTimeoutMilliseconds ?? 60_000
  if (request.deadlineAt !== undefined && (!Number.isSafeInteger(request.deadlineAt) ||
    request.deadlineAt < 0 || request.deadlineAt > MAX_MODEL_RETRY_TIMESTAMP)) {
    throw new WorkerError('settings-invalid', 'The model request deadline is invalid.', false, 'rubric')
  }
  const deadlineAt = Math.min(request.deadlineAt ?? Infinity,
    clock.now().getTime() + attempts * requestTimeout + (attempts - 1) * MAX_MODEL_RETRY_DELAY_MS)
  const timedOut = () => new WorkerError('request-timeout', 'The bounded model request window ended.', true, 'rubric')
  const window = new AbortController()
  const remaining = () => Math.max(0, deadlineAt - clock.now().getTime())
  if (!remaining()) throw timedOut()
  const windowTimer = setTimeout(() => window.abort(timedOut()), remaining())
  const parent = signal ? AbortSignal.any([signal, window.signal]) : window.signal
  let pendingFailure: WorkerError | undefined
  const check = () => {
    if (!remaining()) window.abort(timedOut())
    parent.throwIfAborted()
  }
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      check()
      pendingFailure = undefined
      const timeout = new AbortController()
      const attemptDeadline = Math.min(deadlineAt, clock.now().getTime() + requestTimeout)
      const timer = setTimeout(() => timeout.abort(timedOut()), Math.max(1, attemptDeadline - clock.now().getTime()))
      const combined = AbortSignal.any([parent, timeout.signal])
      const checkAttempt = () => {
        if (clock.now().getTime() >= attemptDeadline) timeout.abort(timedOut())
        combined.throwIfAborted()
      }
      let authenticated = false
      let failure: WorkerError
      let providerNotBefore: number | undefined
      try {
        const result = await abortable(async () => {
          const token = await getToken(COGNITIVE_SCOPE)
          authenticated = true
          checkAttempt()
          const response = await fetchImpl(endpoint, {
            method: 'POST', redirect: 'error', signal: combined,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: requestBody,
          })
          if (!response.ok) {
            const now = clock.now().getTime()
            const retryable = response.status >= 500 || response.status === 429
            providerNotBefore = retryable ? providerRetryAt(response.headers, now) : undefined
            const rejected = new WorkerError('model-request-failed',
              response.status === 429 ? `${context.action} is rate limited (HTTP 429); wait for the provider cooldown.`
                : response.status === 401 || response.status === 403
                  ? 'The configured model service rejected authentication or access; check its identity and permissions.'
                  : `${context.action} ${retryable ? 'is unavailable' : 'was rejected'} (HTTP ${response.status}).`,
              retryable, 'rubric', {
                httpStatus: response.status,
                ...(retryable ? { retryAt: new Date(providerNotBefore ?? now + modelRetryFallback(attempt, random)).toISOString() } : {}),
              })
            if (retryable) pendingFailure = rejected
            void response.body?.cancel().catch(() => {})
            throw rejected
          }
          checkAttempt()
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
        checkAttempt()
        check()
        return result
      } catch (error) {
        if (parent.aborted) throw error
        if (!authenticated && !timeout.signal.aborted) throw error
        failure = timeout.signal.aborted ? timedOut()
          : error instanceof WorkerError ? error
            : new WorkerError('request-failed', 'An Azure processing request failed.', true, 'rubric', { cause: error })
        const transient = failure.httpStatus !== undefined ? TRANSIENT_STATUSES.includes(failure.httpStatus)
          : ['request-failed', 'request-timeout'].includes(failure.code)
        if (!transient) throw failure
        if (!failure.retryAt) failure = new WorkerError(failure.code, failure.message, failure.retryable, failure.stage, {
          httpStatus: failure.httpStatus,
          retryAt: new Date(clock.now().getTime() + modelRetryFallback(attempt, random)).toISOString(),
        })
      } finally { clearTimeout(timer) }
      pendingFailure = failure
      await abortable(async () => { await onRetry?.(failure) }, parent)
      check()
      if (attempt + 1 === attempts) throw failure
      const delay = Math.max(0, Date.parse(failure.retryAt!) - clock.now().getTime())
      if (delay >= remaining()) throw failure
      await abortable(() => clock.sleep(delay, parent), parent)
      check()
      if (providerNotBefore !== undefined && clock.now().getTime() < providerNotBefore) throw failure
    }
    throw new WorkerError('model-request-failed', 'The model transport exhausted its captured attempt budget.', false, 'rubric')
  } catch (error) {
    if (parent.aborted) {
      if (pendingFailure?.httpStatus !== undefined) throw new WorkerError(
        pendingFailure.code, pendingFailure.message, pendingFailure.retryable, pendingFailure.stage,
        { httpStatus: pendingFailure.httpStatus, retryAt: pendingFailure.retryAt, cancelled: Boolean(signal?.aborted) },
      )
      throw signal?.aborted ? cancelled() : timedOut()
    }
    throw error
  } finally {
    clearTimeout(windowTimer)
  }
}
