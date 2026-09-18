import { convertDocxPreview } from './docxPreviewConversion'

const blocked = () => { throw new Error('External access is disabled in the private document preview.') }
Object.defineProperty(globalThis, 'fetch', { value: () => Promise.reject(new Error('External fetches are disabled in the private document preview.')) })
Object.defineProperty(globalThis, 'XMLHttpRequest', { value: blocked })
Object.defineProperty(globalThis, 'WebSocket', { value: blocked })
Object.defineProperty(globalThis, 'EventSource', { value: blocked })
Object.defineProperty(globalThis, 'importScripts', { value: blocked })

self.addEventListener('message', (event: MessageEvent<{ bytes: ArrayBuffer }>) => {
  void convertDocxPreview(event.data.bytes).then(
    (result) => self.postMessage({ ok: true, ...result }),
    (error: unknown) => self.postMessage({ ok: false, error: error instanceof Error ? error.message.slice(0, 400) : 'The Word document could not be converted.' }),
  )
}, { once: true })
