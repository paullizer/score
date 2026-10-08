import { z } from 'zod'
import type { ModelTaskId } from '../src/domain/admin-settings'

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const usageSchema = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  prompt_tokens_details: z.object({ cached_tokens: tokenCount.optional(), cache_write_tokens: tokenCount.optional() }).optional(),
  completion_tokens_details: z.object({ reasoning_tokens: tokenCount.optional() }).optional(),
})

export interface ModelTokenUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number | null
  reasoningTokens: number | null
  cacheWriteInputTokens: number | null
}

export interface ModelAttemptUsage {
  id: string
  taskId: ModelTaskId | null
  deployment: string
  configuredModel: string
  actualModel: string | null
  requestSha256: string
  attempt: number
  httpStatus: number | null
  startedAt: string
  durationMilliseconds: number
  usage: ModelTokenUsage | null
}

export function parseModelTokenUsage(payload: unknown): ModelTokenUsage | null {
  const envelope = z.object({ usage: usageSchema }).safeParse(payload)
  if (!envelope.success) return null
  const usage = envelope.data.usage
  const cached = usage.prompt_tokens_details?.cached_tokens ?? null
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? null
  const writes = usage.prompt_tokens_details?.cache_write_tokens ?? null
  if (cached !== null && cached > usage.prompt_tokens || reasoning !== null && reasoning > usage.completion_tokens ||
    writes !== null && (writes > usage.prompt_tokens || cached !== null && writes + cached > usage.prompt_tokens)) return null
  return {
    inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
    cachedInputTokens: cached, reasoningTokens: reasoning, cacheWriteInputTokens: writes,
  }
}
