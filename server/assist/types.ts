import type { AssistConversationTurn, AssistOutcome } from '../../src/domain/assist'
import type { ModelTaskId, ProcessingSettingsSnapshot } from '../../src/domain/admin-settings'

/**
 * Server-side assisted-editing contracts. `runner.ts` owns the generic request lifecycle;
 * each editable kind supplies an {@link AssistProfile} (the job rubric first, in
 * `profiles/job-rubric.ts`). Adding a kind is adding a profile, as in SimpleChat's
 * `_BLOCK_ASSIST_PROFILES`.
 */

/** One structured model call. Production wraps `worker/model-transport.ts`'s `invokeStructuredModel`. */
export interface AssistModelRequest {
  /** Existing task binding reused for deployment, reasoning, completion and input budgets. */
  taskId: ModelTaskId
  /** Strict JSON-schema name. */
  name: string
  schema: Record<string, unknown>
  system: string
  user: string
  /** The evidence portion checked against the task's input budget. It is never truncated. */
  source: string
  maxCompletionTokens: number
  /** Pinned admission settings when runtime settings are enabled; undefined in unconfigured legacy mode. */
  processingSettings?: ProcessingSettingsSnapshot
  /** Absolute epoch milliseconds shared by authentication, attempts and backoff. */
  deadlineAt: number
}

export interface AssistModelResult {
  content: string
  model: string
}

export type AssistModelInvoker = (request: AssistModelRequest, signal: AbortSignal) => Promise<AssistModelResult>

export interface AssistPromptParts {
  /** Stable, code-owned instructions. */
  system: string
  /** Stable evidence first, then the draft, conversation and instruction, for provider prompt caching. */
  user: string
  /** The evidence included in `user`, for the input budget. */
  source: string
}

export interface AssistPromptInput<TContext> {
  context: TContext
  instruction: string
  conversation: readonly AssistConversationTurn[]
  /** Validation errors from the previous attempt. Raw invalid model output is never echoed back. */
  correction?: readonly string[]
}

export interface AssistValidatedOutput<TOperation> {
  outcome: AssistOutcome
  reply: string
  operations: TOperation[]
  warnings: string[]
}

export type AssistValidation<TOperation> =
  | { ok: true; value: AssistValidatedOutput<TOperation> }
  | { ok: false; errors: string[] }

export interface AssistProfile<TContext, TOperation> {
  /** Stable kind label for telemetry and limits, e.g. `jobRubric`. */
  readonly kind: string
  readonly taskId: ModelTaskId
  /** Code-owned prompt template version returned to the browser and recorded in telemetry. */
  readonly promptVersion: string
  readonly schemaName: string
  readonly maxCompletionTokens: number
  jsonSchema(context: TContext): Record<string, unknown>
  buildPrompt(input: AssistPromptInput<TContext>): AssistPromptParts
  /** Validates untrusted model output. Errors trigger at most the configured correction rounds. */
  validate(output: unknown, context: TContext): AssistValidation<TOperation>
}

export interface AssistRunInput<TContext, TOperation> {
  profile: AssistProfile<TContext, TOperation>
  context: TContext
  instruction: string
  conversation: readonly AssistConversationTurn[]
  invoke: AssistModelInvoker
  processingSettings?: ProcessingSettingsSnapshot
  /** Correction rounds after the first attempt, e.g. `settings.ai.jobRubric.maxOutputCorrections`. */
  maxCorrections: number
  /** Aborted when the browser cancels or disconnects. */
  signal: AbortSignal
  now?: () => number
  /** Defaults to `ASSIST_LIMITS.serverDeadlineMilliseconds`. */
  deadlineMilliseconds?: number
}
