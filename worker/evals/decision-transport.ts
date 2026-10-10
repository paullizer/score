import { z } from 'zod'
import { evaluationHash } from './statistics'
import { estimateModelUsdMicros } from './costs'
import { setTimeout as delay } from 'node:timers/promises'

export const DECISION_CONTRACT = {
  version: 'score-decision-choice-v1',
  source: 'https://ai.azure.com/catalog/models/Microsoft-Decision-1',
  verification: 'Deployed Foundry Playground choice sample, deployment-details endpoint, and synthetic native HTTP observations.',
  verifiedAt: '2026-10-09',
  path: '/providers/microsoft/v1/systemone',
  scope: 'https://cognitiveservices.azure.com/.default',
  actualModel: 'microsoft-decision-1',
  modelVersion: '1',
  endpoint: 'https://aif-score-3ser24tdznnh6.services.ai.azure.com',
  deployment: 'Decision-1',
} as const

export const DECISION_PRICE = {
  version: 'decision-1-announced-2026-10-09', currency: 'USD',
  inputUsdPerMillion: 0.042, cachedInputUsdPerMillion: 0.042,
  outputUsdPerMillion: 0, cacheWriteBilling: 'included-in-input',
} as const

const probability = z.number().finite().min(0).max(1)
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const responseSchema = z.strictObject({
  model: z.literal(DECISION_CONTRACT.actualModel),
  answers: z.strictObject({
    evidence: z.strictObject({
      type: z.literal('choice'), choice: z.string().min(1),
      confidence: probability, probabilities: z.record(z.string(), probability),
    }),
  }),
  usage: z.strictObject({ input_tokens: tokenCount, output_tokens: tokenCount }),
})

export class DecisionError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number | null = null) {
    super(`Offline decision inference failed: ${code}${httpStatus === null ? '' : ` (HTTP ${httpStatus})`}.`)
    this.name = 'DecisionError'
  }
}

export function validateDecisionResponse(raw: unknown, optionIds: readonly string[]) {
  if (raw !== null && typeof raw === 'object' && 'model' in raw && raw.model !== DECISION_CONTRACT.actualModel) {
    throw new DecisionError('unexpected-model')
  }
  const parsed = responseSchema.safeParse(raw)
  if (!parsed.success) throw new DecisionError('invalid-response')
  const value = parsed.data, answer = value.answers.evidence
  const keys = Object.keys(answer.probabilities)
  if (new Set(optionIds).size !== optionIds.length || optionIds.length < 2 ||
    keys.length !== optionIds.length || keys.some(key => !optionIds.includes(key)) ||
    !optionIds.includes(answer.choice) ||
    Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.000001 ||
    answer.probabilities[answer.choice] + 1e-9 < Math.max(...Object.values(answer.probabilities))) {
    throw new DecisionError('invalid-option-probabilities')
  }
  return value
}

export interface DecisionAttempt {
  attempt: number
  requestSha256: string
  startedAt: string
  durationMilliseconds: number
  httpStatus: number | null
  code: string | null
  actualModel: string | null
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: null } | null
  amountUsdMicros: number | null
}

export interface DecisionTransportOptions {
  getToken: (scope: string) => Promise<string>
  fetch?: typeof fetch
  timeoutMilliseconds: number
  maxAttempts: number
  maxRequestBytes: number
  maxInputTokensPerAttempt: number
  onStart: (attempt: Pick<DecisionAttempt, 'attempt' | 'requestSha256' | 'startedAt'>) => Promise<void>
  onFinish: (attempt: DecisionAttempt) => Promise<void>
}

async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let listener: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      listener = () => reject(signal.reason)
      signal.addEventListener('abort', listener, { once: true })
      if (signal.aborted) { listener(); return }
      Promise.resolve().then(operation).then(resolve, reject)
    })
  } finally {
    if (listener) signal.removeEventListener('abort', listener)
  }
}

export async function invokeDecisionChoice(
  state: string, instructions: string, criteria: Record<string, string>,
  options: DecisionTransportOptions, parent?: AbortSignal,
) {
  if (!state.trim() || !instructions.trim() || Object.keys(criteria).length !== 5 ||
    Object.values(criteria).some(value => typeof value !== 'string' || !value.trim()) ||
    !Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 2 ||
    !Number.isInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 1 || options.timeoutMilliseconds > 60_000 ||
    !Number.isInteger(options.maxRequestBytes) || options.maxRequestBytes < 1 || options.maxRequestBytes > 64_000 ||
    !Number.isInteger(options.maxInputTokensPerAttempt) ||
    options.maxInputTokensPerAttempt < options.maxRequestBytes + 4096 || options.maxInputTokensPerAttempt > 100_000) {
    throw new DecisionError('invalid-request-limits')
  }
  const body = JSON.stringify({
    model: DECISION_CONTRACT.deployment, state,
    questions: { evidence: { type: 'choice', instructions, criteria } },
  })
  const { maxAttempts, timeoutMilliseconds, maxRequestBytes, maxInputTokensPerAttempt } = options
  const optionIds = Object.keys(criteria)
  if (Buffer.byteLength(body) > maxRequestBytes) throw new DecisionError('local-context-limit')
  const requestSha256 = evaluationHash(JSON.parse(body))
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    parent?.throwIfAborted()
    const started = Date.now(), startedAt = new Date(started).toISOString()
    await options.onStart({ attempt, requestSha256, startedAt })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DecisionError('timeout')), timeoutMilliseconds)
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
    let httpStatus: number | null = null, code: string | null = null
    let actualModel: string | null = null, usage: DecisionAttempt['usage'] = null
    let retryDelay = 1000
    let result: ReturnType<typeof validateDecisionResponse> | undefined
    try {
      result = await bounded(async () => {
        let token: string
        try { token = await options.getToken(DECISION_CONTRACT.scope) } catch {
          throw new DecisionError('authentication')
        }
        signal.throwIfAborted()
        if (!token) throw new DecisionError('authentication')
        const response = await (options.fetch ?? fetch)(`${DECISION_CONTRACT.endpoint}${DECISION_CONTRACT.path}`, {
          method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body,
        })
        signal.throwIfAborted()
        httpStatus = response.status
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after')
          if (retryAfter !== null) {
            const seconds = Number(retryAfter)
            retryDelay = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000)
              : Math.max(0, Date.parse(retryAfter) - Date.now())
            if (!Number.isFinite(retryDelay)) retryDelay = 1000
          }
          await response.body?.cancel()
          throw new DecisionError(response.status === 401 || response.status === 403 ? 'authentication'
            : response.status === 429 ? 'rate-limit'
              : response.status === 400 || response.status === 413 || response.status === 422 ? 'context-or-request-rejected'
                : 'http-failure', response.status)
        }
        const reader = response.body?.getReader()
        if (!reader) throw new DecisionError('empty-response')
        const chunks: Uint8Array[] = []
        let bytes = 0
        for (;;) {
          signal.throwIfAborted()
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 32_000) { await reader.cancel(); throw new DecisionError('response-size-limit') }
          chunks.push(chunk.value)
        }
        let raw: unknown
        signal.throwIfAborted()
        try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new DecisionError('invalid-json') }
        // Account valid metering even when the decision envelope fails validation.
        const metered = z.object({ model: z.string(), usage: responseSchema.shape.usage }).safeParse(raw)
        if (metered.success) {
          actualModel = /^[a-zA-Z0-9._-]{1,160}$/.test(metered.data.model) ? metered.data.model : null
          usage = {
            inputTokens: metered.data.usage.input_tokens, cachedInputTokens: 0,
            outputTokens: metered.data.usage.output_tokens, reasoningTokens: null,
          }
          if (usage.inputTokens > maxInputTokensPerAttempt) throw new DecisionError('metering-bound-exceeded')
        }
        const value = validateDecisionResponse(raw, optionIds)
        return value
      }, signal)
    } catch (error) {
      code = signal.aborted ? parent?.aborted ? 'cancelled' : 'timeout'
        : error instanceof DecisionError ? error.code : 'network-failure'
    } finally {
      clearTimeout(timer)
      await options.onFinish({
        attempt, requestSha256, startedAt, durationMilliseconds: Date.now() - started,
        httpStatus, code, actualModel, usage, amountUsdMicros: estimateModelUsdMicros(usage, DECISION_PRICE),
      })
    }
    if (result) return result
    const retryable = code === 'network-failure' || code === 'timeout' ||
      httpStatus !== null && [429, 502, 503, 504].includes(httpStatus)
    if (!retryable || attempt === maxAttempts || retryDelay > 5000) throw new DecisionError(code ?? 'unknown', httpStatus)
    await delay(retryDelay, undefined, { signal: parent })
  }
  throw new DecisionError('exhausted')
}

export async function verifyDecisionDeployment(getToken: DecisionTransportOptions['getToken'], fetchImpl: typeof fetch = fetch) {
  const signal = AbortSignal.timeout(30_000)
  const url = 'https://management.azure.com/subscriptions/9698dd71-9367-49c2-bede-fd0deecfad62/' +
    'resourceGroups/rg-score-demo-ncus/providers/Microsoft.CognitiveServices/accounts/' +
    'aif-score-3ser24tdznnh6/deployments/Decision-1?api-version=2025-06-01'
  return bounded(async () => {
    const token = await getToken('https://management.azure.com/.default')
    signal.throwIfAborted()
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', signal, headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    })
    if (!response.ok) { await response.body?.cancel(); throw new DecisionError('deployment-discovery', response.status) }
    const schema = z.object({
      name: z.literal('Decision-1'),
      sku: z.object({ name: z.literal('GlobalStandard') }),
      properties: z.object({
        provisioningState: z.literal('Succeeded'),
        model: z.object({ format: z.literal('Microsoft'), name: z.literal('Microsoft-Decision-1'), version: z.literal('1') }),
        capabilities: z.object({ decision: z.literal('true'), chatCompletion: z.literal('false') }),
      }),
    })
    const raw: unknown = await response.json()
    signal.throwIfAborted()
    if (!schema.safeParse(raw).success) throw new DecisionError('deployment-contract-mismatch')
    return { observedAt: new Date().toISOString(), url, configuration: schema.parse(raw) }
  }, signal)
}
