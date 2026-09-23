import { tooManyRequests } from '../errors'

export interface AssistLimiter {
  acquire(key: string): () => void
}

export interface AssistLimiterOptions {
  perUserInFlight?: number
  perUserMaxRequests?: number
  perUserWindowMilliseconds?: number
  globalInFlight?: number
  now?: () => number
}

interface UserState {
  inFlight: number
  requests: number[]
}

/**
 * Per-process limiter. Counts are approximate when the API is scaled out across instances.
 */
export function createAssistLimiter(options: AssistLimiterOptions = {}): AssistLimiter {
  const perUserInFlight = options.perUserInFlight ?? 1
  const perUserMaxRequests = options.perUserMaxRequests ?? 20
  const perUserWindowMilliseconds = options.perUserWindowMilliseconds ?? 600_000
  const globalInFlight = options.globalInFlight ?? 8
  const now = options.now ?? Date.now
  const users = new Map<string, UserState>()
  let globalActive = 0

  const prune = (current: number) => {
    for (const [key, state] of users) {
      state.requests = state.requests.filter(time => current - time < perUserWindowMilliseconds)
      if (state.inFlight === 0 && state.requests.length === 0) users.delete(key)
    }
  }

  return {
    acquire(key: string) {
      const current = now()
      prune(current)
      const state = users.get(key) ?? { inFlight: 0, requests: [] }
      if (state.inFlight >= perUserInFlight) {
        throw tooManyRequests('You already have an assistant request in progress. Wait for it to finish or cancel it.', 1)
      }
      if (state.requests.length >= perUserMaxRequests) {
        const retryAfter = Math.max(1, Math.ceil((state.requests[0] + perUserWindowMilliseconds - current) / 1000))
        throw tooManyRequests(`Assistant limit reached. Try again in about ${formatRetryAfter(retryAfter)}.`, retryAfter)
      }
      if (globalActive >= globalInFlight) {
        throw tooManyRequests('The assistant is busy. Try again in a few seconds.', 5)
      }
      state.inFlight += 1
      state.requests.push(current)
      users.set(key, state)
      globalActive += 1
      let released = false
      return () => {
        if (released) return
        released = true
        globalActive = Math.max(0, globalActive - 1)
        state.inFlight = Math.max(0, state.inFlight - 1)
        prune(now())
      }
    },
  }
}

function formatRetryAfter(seconds: number): string {
  if (seconds < 90) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}
