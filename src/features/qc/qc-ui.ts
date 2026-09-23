import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { CloudApiError, CloudAuthError } from '../../services/cloudWorkspace'
import type { QcComparisonRef } from '../../domain/quality-control'

export function qcError(error: unknown): string {
  return error instanceof Error ? error.message : 'This QC request could not be acknowledged. Keep your draft and retry.'
}
export function qcAccessLost(error: unknown): boolean {
  return error instanceof CloudAuthError || error instanceof CloudApiError && [401, 403, 404].includes(error.status)
}

export const QcPrivacyContext = createContext<{ signal: AbortSignal; revoke: () => void } | null>(null)

export function qcReviewLink(scope: QcComparisonRef): string {
  return `/qc/reviews/${encodeURIComponent(scope.runId)}/${encodeURIComponent(scope.comparisonId)}?${new URLSearchParams({
    resultRevision: scope.resultRevision, resultSha256: scope.resultSha256,
  })}`
}

export function useQcResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const privacy = useContext(QcPrivacyContext)
  const privacySignal = privacy?.signal
  const revoke = privacy?.revoke
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration(current => current + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    const signal = privacySignal ? AbortSignal.any([controller.signal, privacySignal]) : controller.signal
    setValue(null)
    setLoading(true)
    setError('')
    void load(signal).then(result => {
      if (!signal.aborted) { setValue(result); setLoading(false) }
    }).catch((caught: unknown) => {
      if (!signal.aborted) {
        setValue(null); setError(qcError(caught)); setLoading(false)
        if (qcAccessLost(caught)) revoke?.()
      }
    })
    return () => controller.abort()
  }, [generation, load, privacySignal, revoke])
  return { value, setValue, error, loading, reload }
}

export function useQcRequest() {
  const privacy = useContext(QcPrivacyContext)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [accessLost, setAccessLost] = useState(false)
  const [unresolved, setUnresolved] = useState(false)
  const inFlight = useRef(false)
  const retained = useRef<{ signature: string; key: string; retry: () => Promise<boolean> } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; controller.current?.abort(); retained.current = null
  } }, [])
  async function run<T>(signature: string, operation: (key: string, signal: AbortSignal) => Promise<T>, acknowledge: (result: T) => void): Promise<boolean> {
    if (inFlight.current || privacy?.signal.aborted) return false
    if (retained.current && retained.current.signature !== signature) {
      setError('The previous request has not been acknowledged. Retry that exact request before starting another action.')
      return false
    }
    const key = retained.current?.key ?? crypto.randomUUID()
    retained.current = { signature, key, retry: () => run(signature, operation, acknowledge) }
    controller.current = new AbortController()
    const signal = privacy ? AbortSignal.any([controller.current.signal, privacy.signal]) : controller.current.signal
    inFlight.current = true
    setPending(true)
    setError('')
    try {
      const result = await operation(key, signal)
      signal.throwIfAborted()
      if (mounted.current) acknowledge(result)
      retained.current = null
      if (mounted.current) setUnresolved(false)
      return true
    } catch (caught) {
      if (mounted.current && !signal.aborted) {
        const lost = qcAccessLost(caught)
        const ambiguous = !lost && (!(caught instanceof CloudApiError) || caught.status >= 500 || caught.status === 408)
        if (!ambiguous) retained.current = null
        setUnresolved(ambiguous); setError(qcError(caught)); setAccessLost(lost)
        if (lost) privacy?.revoke()
      }
      return false
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }
  return { pending, error, accessLost, unresolved, run, retry: () => retained.current?.retry() }
}

export function useQcPolling<T>(enabled: boolean, load: (signal: AbortSignal) => Promise<T>, receive: (value: T) => void, milliseconds = 5000) {
  const privacy = useContext(QcPrivacyContext)
  const signal = privacy?.signal
  const revoke = privacy?.revoke
  const latest = useRef({ load, receive })
  latest.current = { load, receive }
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const value = await latest.current.load(requestSignal)
        if (!requestSignal.aborted) { setError(''); latest.current.receive(value) }
      } catch (caught) {
        if (!requestSignal.aborted) {
          setError(qcError(caught))
          if (qcAccessLost(caught)) revoke?.()
        }
      } finally {
        if (!requestSignal.aborted) timer = setTimeout(() => void poll(), milliseconds)
      }
    }
    timer = setTimeout(() => void poll(), milliseconds)
    return () => { clearTimeout(timer); controller.abort() }
  }, [enabled, milliseconds, revoke, signal])
  return error
}
