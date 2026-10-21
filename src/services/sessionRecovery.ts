import { authLoginUrl } from './cloudWorkspace'

export const SESSION_RECOVERY_PATH = '/auth/recovery'
export const SESSION_RECOVERY_TIMEOUT_MS = 5 * 60_000
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COMPLETE = 'score-session-recovery-complete'

export function sessionRecoveryAttemptId(url: URL): string | null {
  const id = url.searchParams.get('attempt')
  return url.pathname === SESSION_RECOVERY_PATH && id && ATTEMPT_ID.test(id) ? id : null
}

export function sessionRecoveryLoginUrl(id: string): string {
  if (!ATTEMPT_ID.test(id)) throw new Error('Invalid sign-in recovery attempt.')
  return authLoginUrl(`${SESSION_RECOVERY_PATH}?attempt=${encodeURIComponent(id)}`)
}

function completionChannel(id: string): BroadcastChannel | null {
  if (typeof window.BroadcastChannel === 'undefined') return null
  return new window.BroadcastChannel(`score-session-recovery:${id}`)
}

export function notifySessionRecoveryComplete(id: string): void {
  if (!ATTEMPT_ID.test(id)) throw new Error('Invalid sign-in recovery attempt.')
  const channel = completionChannel(id)
  if (!channel) return
  try { channel.postMessage({ type: COMPLETE, attempt: id }) } finally { channel.close() }
}

export function createSessionRecoveryAttempt(onComplete: () => void, onTimeout: () => void) {
  const id = window.crypto.randomUUID()
  const loginUrl = sessionRecoveryLoginUrl(id)
  let channel: BroadcastChannel | null = null
  let notificationError = ''
  try { channel = completionChannel(id) } catch (caught) {
    notificationError = caught instanceof Error ? caught.message : 'Sign-in completion notifications are unavailable.'
  }
  let active = true
  const dispose = () => {
    active = false
    window.clearTimeout(timer)
    channel?.close()
  }
  const timer = window.setTimeout(() => { if (active) { dispose(); onTimeout() } }, SESSION_RECOVERY_TIMEOUT_MS)
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data
    if (!active || !data || typeof data !== 'object' || !('type' in data) || data.type !== COMPLETE ||
      !('attempt' in data) || data.attempt !== id) return
    dispose()
    onComplete()
  }
  return {
    loginUrl,
    notificationError,
    dispose,
    open: () => {
      if (!active) throw new Error('This sign-in attempt ended. Start sign-in again.')
      const popup = window.open(loginUrl, '_blank', 'popup,width=600,height=760')
      // Completion uses a same-origin channel, not an opener that Entra navigation may sever.
      if (popup) popup.opener = null
      return popup !== null
    },
  }
}
