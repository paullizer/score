import { z } from 'zod'

/**
 * Generic contracts for AI-assisted editing. An adapter (the job rubric first) supplies its own
 * draft and operation shapes; everything here is shared by the browser and the API.
 *
 * The assistant never saves. It returns validated operations that the editor applies to an
 * unsaved draft; the adapter's existing save path remains the only way to persist a change.
 */
export const ASSIST_LIMITS = Object.freeze({
  /** Longer instructions are rejected, never truncated. */
  maxInstructionCharacters: 2_000,
  /** Earlier turns replayed as context; the browser drops the oldest first. */
  maxConversationTurns: 20,
  maxTurnCharacters: 4_000,
  maxReplyCharacters: 1_500,
  maxWarnings: 20,
  maxWarningCharacters: 500,
  maxOperations: 64,
  /** One deadline shared by every model attempt and correction, below App Service's 230 s limit. */
  serverDeadlineMilliseconds: 150_000,
  /** The browser waits slightly longer than the server so a server error is still readable. */
  clientTimeoutMilliseconds: 170_000,
  /** Session-local edit history retained by an assisted editor. */
  maxHistoryEntries: 100,
})

export const ASSIST_OUTCOMES = ['changed', 'explained', 'clarify'] as const
/** `changed` applies operations; `explained` and `clarify` never carry operations. */
export type AssistOutcome = typeof ASSIST_OUTCOMES[number]

// Tab, line feed and carriage return are allowed; other C0 controls and DEL are not.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const ALL_CONTROL_CHARACTERS = new RegExp(CONTROL_CHARACTERS.source, 'g')

export function hasAssistControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value)
}

/** Bounded plain text without control characters. */
export function assistPlainText(max: number, message?: string) {
  return z.string()
    .max(max, message ?? `Text is limited to ${max.toLocaleString('en-US')} characters.`)
    .refine(value => !hasAssistControlCharacters(value), 'Use plain text without control characters.')
}

export const assistInstructionSchema = assistPlainText(
  ASSIST_LIMITS.maxInstructionCharacters,
  `Instructions are limited to ${ASSIST_LIMITS.maxInstructionCharacters.toLocaleString('en-US')} characters. Shorten it; nothing was truncated.`,
).refine(value => value.trim().length > 0, 'Describe the change you want.')

export const assistConversationTurnSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  text: assistPlainText(ASSIST_LIMITS.maxTurnCharacters).refine(value => value.trim().length > 0, 'Conversation turns cannot be blank.'),
})
export type AssistConversationTurn = z.infer<typeof assistConversationTurnSchema>

export const assistConversationSchema = z.array(assistConversationTurnSchema).max(
  ASSIST_LIMITS.maxConversationTurns,
  `Send at most ${ASSIST_LIMITS.maxConversationTurns} earlier conversation turns.`,
)

export const assistSubmissionIdSchema = z.uuid()

export interface AssistServiceMetadata {
  /** Code-owned assistant prompt template version; not a prompt-registry revision. */
  promptVersion: string
  /** Model identity reported by the provider. */
  model: string
}

export interface AssistResponse<TOperation> {
  outcome: AssistOutcome
  /** Plain text. Never render it as HTML or Markdown. */
  reply: string
  operations: TOperation[]
  warnings: string[]
  assistant: AssistServiceMetadata
}

/** Strict response parser so the browser never applies a malformed or foreign response. */
export function assistResponseSchema<T extends z.ZodType>(operation: T) {
  return z.strictObject({
    outcome: z.enum(ASSIST_OUTCOMES),
    reply: assistPlainText(ASSIST_LIMITS.maxReplyCharacters),
    operations: z.array(operation).max(ASSIST_LIMITS.maxOperations),
    warnings: z.array(assistPlainText(ASSIST_LIMITS.maxWarningCharacters)).max(ASSIST_LIMITS.maxWarnings),
    assistant: z.strictObject({ promptVersion: z.string().min(1).max(200), model: z.string().min(1).max(300) }),
  }).superRefine((value, ctx) => {
    if (value.outcome === 'changed' ? value.operations.length === 0 : value.operations.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['operations'], message: 'Only a changed outcome carries operations, and it carries at least one.' })
    }
  })
}

/** Bounds one replayed turn. Conversation replay is context, not evidence, so shortening it is safe. */
export function boundAssistTurnText(text: string): string {
  const cleaned = text.replace(ALL_CONTROL_CHARACTERS, ' ').trim()
  if (cleaned.length <= ASSIST_LIMITS.maxTurnCharacters) return cleaned
  return `${cleaned.slice(0, ASSIST_LIMITS.maxTurnCharacters - 1).trimEnd()}…`
}

/**
 * Replays an assistant turn as what it changed rather than as prose, following the same rule
 * SimpleChat's assisted editors use: what the draft became matters more than what was said.
 */
export function assistantReplayText(reply: string, changeSummary: string): string {
  const summary = changeSummary.trim()
  return boundAssistTurnText(summary ? `${reply.trim()}\n\nChanges applied: ${summary}` : reply)
}

/** Keeps the newest turns within the replay limit. */
export function recentAssistTurns(turns: readonly AssistConversationTurn[]): AssistConversationTurn[] {
  return turns.slice(-ASSIST_LIMITS.maxConversationTurns).map(turn => ({ role: turn.role, text: boundAssistTurnText(turn.text) }))
    .filter(turn => turn.text.length > 0)
}
