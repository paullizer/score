import { MAPPING_LIMITS, type MappingWorkbook } from './applicant-mapping'

export async function readLocalMapping(file: File, signal: AbortSignal): Promise<MappingWorkbook> {
  signal.throwIfAborted()
  if (!/\.(?:xlsx|csv)$/i.test(file.name) || !file.size || file.size > MAPPING_LIMITS.fileBytes) {
    throw new Error('Choose a nonempty .xlsx or UTF-8 .csv mapping no larger than 5 MiB.')
  }
  const bytes = await file.arrayBuffer()
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mapping.worker.ts', import.meta.url), { type: 'module', name: 'local-applicant-mapping' })
    let settled = false
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null
      worker.terminate()
    }
    const fail = (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error) } }
    const abort = () => fail(signal.reason)
    const timer = setTimeout(() => fail(new Error('The mapping took too long to read. Choose a smaller workbook or a CSV file.')), MAPPING_LIMITS.milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = event => { event.preventDefault(); fail(new Error('The local mapping reader could not run. Remove the mapping or reload Score.')) }
    worker.onmessageerror = () => fail(new Error('The local mapping reader returned an unreadable result.'))
    worker.onmessage = ({ data }: MessageEvent<{ workbook?: MappingWorkbook; error?: string }>) => {
      if (settled) return
      if (signal.aborted) { abort(); return }
      if (data && typeof data.error === 'string' && data.error.length <= 1000) { fail(new Error(data.error)); return }
      if (!data?.workbook || !Array.isArray(data.workbook.sheets)) { fail(new Error('The local mapping reader returned an invalid workbook.')); return }
      settled = true; cleanup(); resolve(data.workbook)
    }
    try { signal.throwIfAborted(); worker.postMessage({ name: file.name, bytes }, [bytes]) }
    catch (error) { fail(error) }
  })
}
