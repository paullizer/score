import { parseMappingFile } from './mapping-parser'
import { MappingInputError } from './applicant-mapping'

Object.defineProperty(globalThis, 'fetch', { value: () => Promise.reject(new Error('Mapping parsing has no network access.')) })
Object.defineProperty(globalThis, 'XMLHttpRequest', { value: () => { throw new Error('Mapping parsing has no network access.') } })
Object.defineProperty(globalThis, 'WebSocket', { value: () => { throw new Error('Mapping parsing has no network access.') } })

self.onmessage = async ({ data, origin }: MessageEvent<{ name: string; bytes: ArrayBuffer }>) => {
  if (origin !== '' && origin !== self.location.origin) return
  self.onmessage = null
  try {
    if (!data || typeof data.name !== 'string' || !(data.bytes instanceof ArrayBuffer)) throw new MappingInputError('The mapping request is invalid.')
    const workbook = await parseMappingFile(data.name, data.bytes)
    self.postMessage({ workbook })
  } catch (error) {
    // Never forward parser exceptions: third-party messages may contain spreadsheet values.
    self.postMessage({ error: error instanceof MappingInputError
      ? error.message : 'The mapping could not be read safely. Use a plain-value .xlsx workbook or UTF-8 CSV within the displayed limits.' })
  }
}
