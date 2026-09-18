import {
  REPORT_FORMATS, REPORT_LIMITS, type AnalysisReportWriter, type ReportWorkerRequest, type ReportWorkerResponse,
} from '../../domain/analysis-reports'
import { assertReportResourceLimits } from './model'

Object.defineProperty(globalThis, 'fetch', { value: () => Promise.reject(new Error('Network access is disabled during report generation.')) })
Object.defineProperty(globalThis, 'XMLHttpRequest', { value: () => { throw new Error('Network access is disabled during report generation.') } })
Object.defineProperty(globalThis, 'WebSocket', { value: () => { throw new Error('Network access is disabled during report generation.') } })

self.addEventListener('message', (event: MessageEvent<ReportWorkerRequest>) => {
  const request = event.data
  const send = (message: ReportWorkerResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer })
  void (async () => {
    if (!request || request.type !== 'generate' || typeof request.requestId !== 'string' || !Object.hasOwn(REPORT_FORMATS, request.format)) {
      throw new Error('The report generation request is invalid.')
    }
    assertReportResourceLimits(request.report)
    send({ type: 'progress', requestId: request.requestId, message: `Generating ${REPORT_FORMATS[request.format].label} from saved evidence` })
    let generate: AnalysisReportWriter
    switch (request.format) {
      case 'csv': generate = (await import('./csv')).generateCsvReport; break
      case 'pdf': generate = (await import('./pdf')).generatePdfReport; break
      case 'docx': generate = (await import('./docx')).generateDocxReport; break
      case 'pptx': generate = (await import('./pptx')).generatePptxReport; break
    }
    const output = await generate(request.report, request.options)
    if (!(output instanceof Uint8Array) || !output.byteLength || output.byteLength > REPORT_LIMITS.maxOutputBytes) {
      throw new Error('The generated report is empty or exceeds the download limit. Export one job or grade at a time.')
    }
    const bytes = Uint8Array.from(output).buffer
    send({ type: 'complete', requestId: request.requestId, bytes }, [bytes])
  })().catch((error: unknown) => send({
    type: 'error', requestId: typeof request?.requestId === 'string' ? request.requestId : '',
    message: error instanceof Error ? error.message : 'The report could not be generated. No file was downloaded.',
  }))
}, { once: true })
