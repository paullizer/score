import {
  RUBRIC_EXPORT_FORMATS, isRubricExportFormat, type RubricExportWorkerRequest, type RubricExportWorkerResponse,
} from '../../domain/rubric-exports'
import { prepareRubricExport } from './rubric-export'

Object.defineProperty(globalThis, 'fetch', { value: () => Promise.reject(new Error('Network access is disabled during rubric export.')) })
Object.defineProperty(globalThis, 'XMLHttpRequest', { value: () => { throw new Error('Network access is disabled during rubric export.') } })
Object.defineProperty(globalThis, 'WebSocket', { value: () => { throw new Error('Network access is disabled during rubric export.') } })

function handleRubricExportMessage(event: MessageEvent<RubricExportWorkerRequest>) {
  // Dedicated worker messages from the owning page use an empty origin; allow the worker origin if a browser supplies it.
  if (event.origin !== '' && event.origin !== self.location.origin) return
  self.removeEventListener('message', handleRubricExportMessage)
  const request = event.data
  const send = (message: RubricExportWorkerResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer })
  void (async () => {
    const startedAt = Date.now()
    if (!request || request.type !== 'generate' || typeof request.requestId !== 'string' || !isRubricExportFormat(request.format)
      || !request.links || typeof request.links.origin !== 'string') {
      throw new Error('The rubric export request is invalid.')
    }
    const prepared = prepareRubricExport(request.payload, request.format, request.links, startedAt)
    send({ type: 'progress', requestId: request.requestId, message: `Generating ${RUBRIC_EXPORT_FORMATS[request.format].label} from the saved rubric` })
    let output: Uint8Array
    switch (prepared.format) {
      case 'pdf': output = await (await import('./rubric-pdf')).generateRubricPdf(prepared, request.fonts); break
      case 'docx': output = await (await import('./rubric-docx')).generateRubricDocx(prepared, request.fonts); break
      case 'pptx': output = await (await import('./rubric-pptx')).generateRubricPptx(prepared); break
      case 'markdown': output = (await import('./rubric-markdown')).generateRubricMarkdown(prepared.document, prepared); break
      case 'csv': output = (await import('./rubric-csv')).generateRubricCsv([prepared.document], prepared); break
    }
    if (!(output instanceof Uint8Array) || !output.byteLength || output.byteLength > prepared.limits.maxOutputBytes) {
      throw new Error('The generated rubric export is empty or exceeds the download limit. No file was downloaded.')
    }
    const bytes = Uint8Array.from(output).buffer
    if (Date.now() - startedAt > prepared.limits.maxGenerationMilliseconds) {
      throw new Error('Rubric export exceeded its time limit. No file was generated.')
    }
    send({ type: 'complete', requestId: request.requestId, bytes }, [bytes])
  })().catch((error: unknown) => send({
    type: 'error', requestId: typeof request?.requestId === 'string' ? request.requestId : '',
    message: error instanceof Error ? error.message : 'The rubric could not be exported. No file was downloaded.',
  }))
}

self.addEventListener('message', handleRubricExportMessage)
