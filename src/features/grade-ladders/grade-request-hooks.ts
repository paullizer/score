import { useCallback, useRef } from 'react'

export function useGradeRequestKey() {
  const keys = useRef(new Map<string, string>())
  return useCallback((action: string, input: unknown) => {
    const fingerprint = JSON.stringify([action, input])
    let key = keys.current.get(fingerprint)
    if (!key) { key = crypto.randomUUID(); keys.current.set(fingerprint, key) }
    return key
  }, [])
}
