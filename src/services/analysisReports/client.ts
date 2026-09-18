import {
  REPORT_FORMATS, REPORT_LIMITS, type AnalysisReport, type AnalysisReportFormat,
  type ReportFontData, type ReportWorkerRequest, type ReportWorkerResponse,
} from '../../domain/analysis-reports'
import { assertReportResourceLimits } from './model'
import { safeReportFilename } from './presentation'

const MAX_FONT_BYTES = 4 * 1024 * 1024

async function fontBytes(url: URL, signal: AbortSignal): Promise<ArrayBuffer> {
  if (url.origin !== window.location.origin) throw new Error('Report fonts must come from this application, not an external service.')
  const response = await fetch(url, { signal, credentials: 'same-origin', redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('The bundled report fonts could not be loaded. Reload Score and try again.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_FONT_BYTES) throw new Error('The report font response exceeded its expected size. Reload Score before retrying.')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch((error: unknown) => {
      if (!(error instanceof Error && error.name === 'AbortError')) console.warn('Report font response cleanup failed.')
    })
    reader.releaseLock()
  }
  signal.throwIfAborted()
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  if (size < 4 || bytes[0] !== 0 || bytes[1] !== 1 || bytes[2] !== 0 || bytes[3] !== 0) {
    throw new Error('Score did not receive its bundled TrueType report font. Check your session and reload before retrying.')
  }
  return bytes.buffer
}

async function reportFonts(signal: AbortSignal): Promise<ReportFontData> {
  const [regular, bold] = await Promise.all([
    fontBytes(new URL('../../assets/report-fonts/NotoSans-Regular.ttf', import.meta.url), signal),
    fontBytes(new URL('../../assets/report-fonts/NotoSans-Bold.ttf', import.meta.url), signal),
  ])
  return { regular, bold }
}

export function assertReportFile(bytes: ArrayBuffer, format: AnalysisReportFormat): void {
  if (!bytes.byteLength || bytes.byteLength > REPORT_LIMITS.maxOutputBytes) {
    throw new Error('The generated report is empty or too large. Export one job or grade at a time; no partial file was downloaded.')
  }
  const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 5))
  const valid = format === 'csv' ? prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf
    : format === 'pdf' ? [0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, index) => prefix[index] === byte)
      : [0x50, 0x4b, 0x03, 0x04].every((byte, index) => prefix[index] === byte)
  if (!valid) throw new Error('The report generator returned an invalid file. No download was started.')
}

export async function generateReportInWorker(
  report: AnalysisReport,
  format: AnalysisReportFormat,
  options: { signal: AbortSignal; onProgress?: (message: string) => void },
): Promise<ArrayBuffer> {
  options.signal.throwIfAborted()
  assertReportResourceLimits(report)
  const lifetime = new AbortController()
  const signal = AbortSignal.any([options.signal, lifetime.signal])
  const timer = setTimeout(() => lifetime.abort(new DOMException('Report generation timed out', 'TimeoutError')), REPORT_LIMITS.maxGenerationMilliseconds)
  try {
    let fonts: ReportFontData | undefined
    if (format === 'pdf') {
      options.onProgress?.('Loading locally bundled PDF fonts')
      fonts = await reportFonts(signal)
    }
    signal.throwIfAborted()
    return await runWorker(report, format, signal, options.onProgress, fonts)
  } finally {
    clearTimeout(timer)
    lifetime.abort()
  }
}

function runWorker(
  report: AnalysisReport, format: AnalysisReportFormat, signal: AbortSignal,
  onProgress?: (message: string) => void, fonts?: ReportFontData,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const worker = new Worker(new URL('./report.worker.ts', import.meta.url), { type: 'module', name: 'analysis-report-export' })
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
    const abort = () => fail(signal.reason ?? new DOMException('Report export cancelled', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => { event.preventDefault(); fail(new Error('The report generator could not run. Reload Score and try again.')) }
    worker.onmessageerror = () => fail(new Error('The report generator returned an unreadable response.'))
    worker.onmessage = ({ data }: MessageEvent<ReportWorkerResponse>) => {
      if (signal.aborted) { abort(); return }
      try {
        if (!data || data.requestId !== requestId) throw new Error('The report generator returned a response for a different request.')
        if (data.type === 'progress' && typeof data.message === 'string' && data.message.length <= 500) {
          onProgress?.(data.message)
        } else if (data.type === 'error' && typeof data.message === 'string' && data.message.length > 0) {
          fail(new Error(data.message))
        } else if (data.type === 'complete' && data.bytes instanceof ArrayBuffer) {
          assertReportFile(data.bytes, format)
          settled = true
          cleanup()
          resolve(data.bytes)
        } else throw new Error('The report generator returned an invalid response.')
      } catch (error) { fail(error) }
    }
    const request: ReportWorkerRequest = { type: 'generate', requestId, format, report, ...(fonts ? { options: { fonts } } : {}) }
    try {
      signal.throwIfAborted()
      worker.postMessage(request, fonts ? [fonts.regular, fonts.bold] : [])
    } catch (error) { fail(error) }
  })
}

export function downloadAnalysisReport(bytes: ArrayBuffer, report: AnalysisReport, format: AnalysisReportFormat, signal: AbortSignal): string {
  signal.throwIfAborted()
  assertReportFile(bytes, format)
  const filename = safeReportFilename(`${report.dataKind === 'sample' ? 'Sample - ' : ''}${report.run.name}${report.partial ? ' - partial' : ''}`, format)
  const url = URL.createObjectURL(new Blob([bytes], { type: REPORT_FORMATS[format].mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.hidden = true
  let started = false
  try {
    document.body.append(anchor)
    signal.throwIfAborted()
    anchor.click()
    started = true
  } finally {
    anchor.remove()
    if (started) window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    else URL.revokeObjectURL(url)
  }
  return filename
}
