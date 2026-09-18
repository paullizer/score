import { UPLOAD_CONTENT_TYPES, type OriginalContentType } from '../../domain/document-formats'
import { DOCX_PREVIEW_LIMITS, type DocxPreviewResult } from './docxPreviewSafety'

export interface PrivateOriginalMetadata {
  contentType?: OriginalContentType
  bytes?: number
  sha256?: string
}

export function privateOriginalUrl(value: string): string {
  const url = new URL(value, window.location.href)
  if (url.origin !== window.location.origin || url.username || url.password || url.search || url.hash
    || !/^\/api\/workspaces\/[^/]+\/(?:jobs|resumes)\/[^/]+\/original$/.test(url.pathname)) {
    throw new Error('The formatted preview requires this workspace’s private, same-origin original endpoint.')
  }
  return url.href
}

function reportCleanupFailure(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') return
  console.warn('Private Word preview response cleanup failed.')
}

export async function fetchPrivateDocx(value: string, metadata: PrivateOriginalMetadata, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  const maxBytes = DOCX_PREVIEW_LIMITS.maxFileBytes
  if (metadata.contentType !== undefined && metadata.contentType !== UPLOAD_CONTENT_TYPES.docx) throw new Error('The saved original is not a DOCX document.')
  if (metadata.bytes !== undefined && (!Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes > maxBytes)) {
    throw new Error('The saved original size is outside the 10 MiB preview limit.')
  }
  if (metadata.sha256 !== undefined && !/^[a-f\d]{64}$/i.test(metadata.sha256)) throw new Error('The saved original hash cannot be verified.')
  const response = await fetch(privateOriginalUrl(value), {
    credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    headers: { Accept: UPLOAD_CONTENT_TYPES.docx, 'X-Score-Request': 'workspace' },
  })
  const reject = (message: string): never => {
    void response.body?.cancel().catch(reportCleanupFailure)
    throw new Error(message)
  }
  if (!response.ok || response.redirected) reject('The private original could not be loaded. Check your access or session, then retry.')
  if (response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== UPLOAD_CONTENT_TYPES.docx) {
    reject('The original endpoint did not return a DOCX document. Sign in again if your session has expired.')
  }
  const lengthHeader = response.headers.get('Content-Length')
  const declared = lengthHeader === null ? undefined : Number(lengthHeader)
  if (declared !== undefined && (!/^\d+$/.test(lengthHeader!) || !Number.isSafeInteger(declared) || declared <= 0 || declared > maxBytes)) {
    reject('The original response exceeds the 10 MiB preview limit or has an invalid size.')
  }
  if (declared !== undefined && metadata.bytes !== undefined && declared !== metadata.bytes) reject('The original response does not match the saved file size.')
  if (!response.body) reject('The original response was empty.')
  const reader = response.body!.getReader()
  const cancel = () => { void reader.cancel().catch(reportCleanupFailure) }
  signal.addEventListener('abort', cancel, { once: true })
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes || (metadata.bytes !== undefined && size > metadata.bytes)) throw new Error('The original response exceeded its bounded preview size.')
      chunks.push(part.value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(reportCleanupFailure)
    reader.releaseLock()
  }
  if (!size || (declared !== undefined && size !== declared) || (metadata.bytes !== undefined && size !== metadata.bytes)) {
    throw new Error('The downloaded original does not match the saved file size.')
  }
  const buffer = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length }
  chunks.length = 0
  if (metadata.sha256) {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    signal.throwIfAborted()
    const hash = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')
    if (hash !== metadata.sha256.toLowerCase()) throw new Error('The downloaded original does not match its saved SHA-256 hash. No preview was displayed.')
  }
  signal.throwIfAborted()
  return buffer.buffer
}

export function convertDocxInWorker(bytes: ArrayBuffer, signal: AbortSignal): Promise<DocxPreviewResult> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./docxPreview.worker.ts', import.meta.url), { type: 'module', name: 'private-docx-preview' })
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker.terminate()
    }
    const fail = (error: unknown) => { cleanup(); reject(error) }
    const abort = () => fail(signal.reason ?? new DOMException('Preview cancelled', 'AbortError'))
    const timer = setTimeout(() => fail(new Error('The formatted preview timed out. Retry, use the extracted text, or download the original.')), DOCX_PREVIEW_LIMITS.parserTimeoutMilliseconds)
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => { event.preventDefault(); fail(new Error('The private Word converter could not run. Retry or use the extracted text.')) }
    worker.onmessageerror = () => fail(new Error('The Word converter returned an unreadable response.'))
    worker.onmessage = ({ data }: MessageEvent) => {
      if (signal.aborted) { abort(); return }
      if (data?.ok !== true) { fail(new Error(typeof data?.error === 'string' ? data.error : 'The Word document could not be converted.')); return }
      if (typeof data.html !== 'string' || data.html.length > DOCX_PREVIEW_LIMITS.maxHtmlCharacters || !Array.isArray(data.warnings)) {
        fail(new Error('The Word converter returned an invalid or oversized preview.'))
        return
      }
      cleanup()
      resolve({ html: data.html, warnings: data.warnings.filter((warning: unknown): warning is string => typeof warning === 'string').slice(0, 30) })
    }
    try { signal.throwIfAborted(); worker.postMessage({ bytes }, [bytes]) } catch (error) { fail(error) }
  })
}
