import { useCallback, useEffect, useRef, useState } from 'react'
import { assistantReplayText, recentAssistTurns, type AssistConversationTurn, type AssistOutcome } from '../../domain/assist'

export interface AssistAppliedChange {
  key: string
  label: string
  detail?: string
  quote?: string
}

export interface AssistConversationUiTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  status: 'pending' | 'done' | 'error' | 'cancelled'
  outcome?: AssistOutcome
  changes?: AssistAppliedChange[]
  warnings?: string[]
  error?: { message: string; retryable: boolean; retryAfterSeconds?: number }
  undone?: { reverted: number; skipped: number }
  focusId?: string | null
  focusLabel?: string
  instruction?: string
  replaySummary?: string
}

export interface UseAssistConversationOptions<TResponse> {
  send: (input: {
    instruction: string
    focusId: string | null
    conversation: AssistConversationTurn[]
    signal: AbortSignal
  }) => Promise<TResponse>
  onResponse: (response: TResponse, turn: { id: string; instruction: string; focusId: string | null }) => {
    outcome: AssistOutcome
    reply: string
    changes: AssistAppliedChange[]
    warnings: string[]
    replaySummary: string
  }
  describeError?: (error: unknown) => { message: string; retryable: boolean; retryAfterSeconds?: number }
  now?: () => number
  newId?: () => string
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError'
}

function defaultDescribeError(error: unknown): { message: string; retryable: boolean; retryAfterSeconds?: number } {
  const value = error && typeof error === 'object' ? error as { kind?: unknown; message?: unknown; retryAfterSeconds?: unknown } : {}
  const kind = typeof value.kind === 'string' ? value.kind : undefined
  return {
    message: typeof value.message === 'string' && value.message ? value.message : 'AI assist is unavailable. Your draft is unchanged.',
    retryable: kind === 'timeout' || kind === 'rate-limited' || kind === 'unavailable',
    retryAfterSeconds: typeof value.retryAfterSeconds === 'number' ? value.retryAfterSeconds : undefined,
  }
}

function replayFromTurns(turns: readonly AssistConversationUiTurn[]): AssistConversationTurn[] {
  // Only completed exchanges are context; a failed or cancelled request never happened for the model.
  const replay: AssistConversationTurn[] = []
  turns.forEach((turn, index) => {
    if (turn.role !== 'user') return
    const reply = turns[index + 1]
    if (reply?.role !== 'assistant' || reply.status !== 'done') return
    replay.push({ role: 'user', text: turn.text }, { role: 'assistant', text: assistantReplayText(reply.text, reply.replaySummary ?? '') })
  })
  return recentAssistTurns(replay)
}

export function useAssistConversation<TResponse>({
  send: sendRequest,
  onResponse,
  describeError = defaultDescribeError,
  now = () => Date.now(),
  newId = () => crypto.randomUUID(),
}: UseAssistConversationOptions<TResponse>) {
  const [turns, setTurns] = useState<AssistConversationUiTurn[]>([])
  const [pending, setPending] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const pendingTurnIdRef = useRef<string | null>(null)
  const startedAtRef = useRef(0)
  const turnsRef = useRef<AssistConversationUiTurn[]>([])
  const mountedRef = useRef(true)

  useEffect(() => { turnsRef.current = turns }, [turns])

  useEffect(() => {
    if (!pending) { setElapsedSeconds(0); return undefined }
    const timer = window.setInterval(() => setElapsedSeconds(Math.max(0, Math.floor((now() - startedAtRef.current) / 1000))), 1000)
    return () => window.clearInterval(timer)
  }, [now, pending])

  useEffect(() => {
    // Set on every mount: React StrictMode unmounts and remounts effects once in development.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const runSend = useCallback(async (instruction: string, focusId: string | null = null, retryOf?: AssistConversationUiTurn) => {
    const trimmed = instruction.trim()
    if (!trimmed || abortRef.current) return
    const requestConversation = replayFromTurns(turnsRef.current)
    const userTurn: AssistConversationUiTurn = {
      id: retryOf?.id ? `${retryOf.id}-retry-user-${newId()}` : newId(),
      role: 'user',
      text: trimmed,
      at: now(),
      status: 'done',
      focusId,
      focusLabel: retryOf?.focusLabel,
    }
    const assistantTurn: AssistConversationUiTurn = {
      id: retryOf ? newId() : newId(),
      role: 'assistant',
      text: '',
      at: now(),
      status: 'pending',
      focusId,
      focusLabel: retryOf?.focusLabel,
      instruction: trimmed,
    }
    const controller = new AbortController()
    abortRef.current = controller
    pendingTurnIdRef.current = assistantTurn.id
    startedAtRef.current = now()
    setPending(true)
    setTurns(current => [...current, userTurn, assistantTurn])
    try {
      const response = await sendRequest({ instruction: trimmed, focusId, conversation: requestConversation, signal: controller.signal })
      if (!mountedRef.current) return
      if (controller.signal.aborted) {
        setTurns(current => current.map(turn => turn.id === assistantTurn.id ? { ...turn, status: 'cancelled', text: 'Cancelled. Your draft is unchanged.' } : turn))
        return
      }
      try {
        const applied = onResponse(response, { id: assistantTurn.id, instruction: trimmed, focusId })
        setTurns(current => current.map(turn => turn.id === assistantTurn.id ? {
          ...turn,
          status: 'done',
          text: applied.reply,
          outcome: applied.outcome,
          changes: applied.changes,
          warnings: applied.warnings,
          replaySummary: applied.replaySummary,
        } : turn))
      } catch (error) {
        const described = describeError(error)
        setTurns(current => current.map(turn => turn.id === assistantTurn.id ? {
          ...turn,
          status: 'error',
          text: described.message,
          error: described,
        } : turn))
      }
    } catch (error) {
      if (!mountedRef.current) return
      if (controller.signal.aborted || isAbortError(error)) {
        setTurns(current => current.map(turn => turn.id === assistantTurn.id ? { ...turn, status: 'cancelled', text: 'Cancelled. Your draft is unchanged.' } : turn))
      } else {
        const described = describeError(error)
        setTurns(current => current.map(turn => turn.id === assistantTurn.id ? {
          ...turn,
          status: 'error',
          text: described.message,
          error: described,
        } : turn))
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      if (pendingTurnIdRef.current === assistantTurn.id) pendingTurnIdRef.current = null
      if (mountedRef.current) setPending(false)
    }
  }, [describeError, newId, now, onResponse, sendRequest])

  const cancel = useCallback(() => {
    const turnId = pendingTurnIdRef.current
    abortRef.current?.abort()
    abortRef.current = null
    pendingTurnIdRef.current = null
    setPending(false)
    if (turnId) {
      setTurns(current => current.map(turn => turn.id === turnId ? { ...turn, status: 'cancelled', text: 'Cancelled. Your draft is unchanged.' } : turn))
    }
  }, [])

  const retry = useCallback((turnId: string) => {
    const failed = turnsRef.current.find(turn => turn.id === turnId && turn.role === 'assistant' && turn.status === 'error')
    if (!failed?.instruction) return
    return runSend(failed.instruction, failed.focusId ?? null, failed)
  }, [runSend])

  const markUndone = useCallback((turnId: string, result: { reverted: number; skipped: number }) => {
    setTurns(current => current.map(turn => turn.id === turnId ? { ...turn, undone: result } : turn))
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setTurns([])
  }, [])

  return { turns, pending, elapsedSeconds, send: runSend, cancel, retry, markUndone, reset }
}
