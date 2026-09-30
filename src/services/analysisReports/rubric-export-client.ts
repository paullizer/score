import type { ReportFontData } from '../../domain/analysis-reports'
import {
  RUBRIC_EXPORT_FORMATS, type RubricExportFormat, type RubricExportPayload,
  type RubricExportWorkerRequest, type RubricExportWorkerResponse,
} from '../../domain/rubric-exports'
import { cloudJsonRequest } from '../cloudWorkspace'
import { reportFonts, saveDownload } from './client'
import { assertRubricExportPolicy, parseRubricExportPayload, rubricExportFilename } from './rubric-export'

export interface RubricExportTarget {
  workspaceId: string
  jobId: string
  rubricId: string
  version: number
}

function timeout(): DOMException {
  return new DOMException('Rubric export timed out', 'TimeoutError')
}

/** Asks the server for one saved job rubric version and the export policy in force right now. */
export async function loadRubricExport(
  target: RubricExportTarget, format: RubricExportFormat, signal?: AbortSignal,
): Promise<RubricExportPayload> {
  const query = new URLSearchParams({ rubricId: target.rubricId, version: String(target.version), format })
  const raw = await cloudJsonRequest<unknown>(
    `/workspaces/${encodeURIComponent(target.workspaceId)}/jobs/${encodeURIComponent(target.jobId)}/rubric-export?${query}`,
    { method: 'GET', ...(signal ? { signal } : {}) },
  )
  signal?.throwIfAborted()
  const payload = parseRubricExportPayload(raw)
  if (payload.workspaceId !== target.workspaceId || payload.job.id !== target.jobId
    || payload.rubric.id !== target.rubricId || payload.rubric.version !== target.version) {
    throw new Error('The saved rubric belongs to a different workspace, job or version. No file was generated.')
  }
  assertRubricExportPolicy(payload, format)
  return payload
}

export function assertRubricExportFile(bytes: ArrayBuffer, format: RubricExportFormat, maxOutputBytes: number): void {
  if (!bytes.byteLength || bytes.byteLength > maxOutputBytes) {
    throw new Error('The generated rubric export is empty or too large. No file was downloaded.')
  }
  const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 5))
  const starts = (...magic: number[]) => magic.every((byte, index) => prefix[index] === byte)
  let valid: boolean
  switch (format) {
    case 'pdf': valid = starts(0x25, 0x50, 0x44, 0x46, 0x2d); break
    case 'docx':
    case 'pptx': valid = starts(0x50, 0x4b, 0x03, 0x04); break
    case 'csv': valid = starts(0xef, 0xbb, 0xbf); break
    case 'markdown':
      try { valid = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().length > 0 } catch { valid = false }
      break
  }
  if (!valid) throw new Error('The rubric exporter returned an invalid file. No download was started.')
}

export async function generateRubricExportInWorker(
  payload: RubricExportPayload,
  format: RubricExportFormat,
  options: { signal: AbortSignal; onProgress?: (message: string) => void; origin?: string },
): Promise<ArrayBuffer> {
  options.signal.throwIfAborted()
  const startedAt = Date.now()
  const limits = assertRubricExportPolicy(payload, format)
  const lifetime = new AbortController()
  const signal = AbortSignal.any([options.signal, lifetime.signal])
  const timer = setTimeout(() => lifetime.abort(timeout()), limits.maxGenerationMilliseconds)
  try {
    let fonts: ReportFontData | undefined
    if (format === 'pdf' || format === 'docx') {
      options.onProgress?.('Loading locally bundled document fonts')
      fonts = await reportFonts(signal)
    }
    signal.throwIfAborted()
    const bytes = await runRubricWorker({
      type: 'generate', requestId: crypto.randomUUID(), format, payload,
      links: { origin: options.origin ?? window.location.origin }, ...(fonts ? { fonts } : {}),
    }, signal, limits.maxOutputBytes, options.onProgress)
    signal.throwIfAborted()
    if (Date.now() - startedAt > limits.maxGenerationMilliseconds) throw timeout()
    return bytes
  } finally {
    clearTimeout(timer)
    lifetime.abort()
  }
}

function runRubricWorker(
  request: RubricExportWorkerRequest, signal: AbortSignal, maxOutputBytes: number, onProgress?: (message: string) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./rubric-export.worker.ts', import.meta.url), { type: 'module', name: 'rubric-export' })
    let settled = false
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = () => fail(signal.reason ?? new DOMException('Rubric export cancelled', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => { event.preventDefault(); fail(new Error('The rubric exporter could not run. Reload Score and try again.')) }
    worker.onmessageerror = () => fail(new Error('The rubric exporter returned an unreadable response.'))
    worker.onmessage = ({ data }: MessageEvent<RubricExportWorkerResponse>) => {
      if (signal.aborted) { abort(); return }
      try {
        if (!data || data.requestId !== request.requestId) throw new Error('The rubric exporter returned a response for a different request.')
        if (data.type === 'progress' && typeof data.message === 'string' && data.message.length <= 500) {
          onProgress?.(data.message)
        } else if (data.type === 'error' && typeof data.message === 'string' && data.message.length > 0) {
          fail(new Error(data.message))
        } else if (data.type === 'complete' && data.bytes instanceof ArrayBuffer) {
          assertRubricExportFile(data.bytes, request.format, maxOutputBytes)
          settled = true
          cleanup()
          resolve(data.bytes)
        } else throw new Error('The rubric exporter returned an invalid response.')
      } catch (error) { fail(error) }
    }
    try {
      signal.throwIfAborted()
      worker.postMessage(request, request.fonts ? [request.fonts.regular, request.fonts.bold] : [])
    } catch (error) { fail(error) }
  })
}

export function downloadRubricExport(
  bytes: ArrayBuffer, payload: RubricExportPayload, format: RubricExportFormat, signal: AbortSignal,
): string {
  const limits = assertRubricExportPolicy(payload, format)
  assertRubricExportFile(bytes, format, limits.maxOutputBytes)
  return saveDownload(bytes, rubricExportFilename(payload, format), RUBRIC_EXPORT_FORMATS[format].mimeType, signal)
}

/** Loads the saved rubric, generates the file in a network-isolated worker and starts the download. Returns the file name. */
export async function exportRubric(
  target: RubricExportTarget, format: RubricExportFormat,
  options: { signal: AbortSignal; onProgress?: (message: string) => void },
): Promise<string> {
  options.onProgress?.('Loading the saved rubric')
  const payload = await loadRubricExport(target, format, options.signal)
  const bytes = await generateRubricExportInWorker(payload, format, options)
  return downloadRubricExport(bytes, payload, format, options.signal)
}
