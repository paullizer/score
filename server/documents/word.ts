import { Worker } from 'node:worker_threads'
import { WORD_DOCUMENT_LIMITS, type WordFormat } from '../../src/domain/document-formats'
import { WordDocumentError, wordParserReplySchema, type WordParserResult } from './word-contract'

export { WordDocumentError, hasOleSignature, hasZipSignature } from './word-contract'

let activeParsers = 0
const waiting: Array<{ start: () => void }> = []

function releaseParser(): void {
  activeParsers -= 1
  waiting.shift()?.start()
}

function acquireParser(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(new WordDocumentError('word-cancelled'))
  if (activeParsers < WORD_DOCUMENT_LIMITS.maxConcurrentParsers) {
    activeParsers += 1
    return Promise.resolve(releaseParser)
  }
  if (waiting.length >= WORD_DOCUMENT_LIMITS.maxQueuedParsers) {
    return Promise.reject(new WordDocumentError('word-parser-unavailable'))
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
    const remove = (error: WordDocumentError) => {
      const index = waiting.indexOf(entry)
      if (index < 0) return
      waiting.splice(index, 1)
      cleanup()
      reject(error)
    }
    const abort = () => remove(new WordDocumentError('word-cancelled'))
    const entry = { start() { cleanup(); activeParsers += 1; resolve(releaseParser) } }
    const timeout = setTimeout(() => remove(new WordDocumentError('word-parser-unavailable')), WORD_DOCUMENT_LIMITS.parserTimeoutMilliseconds)
    waiting.push(entry)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export async function parseWordFile(bytes: Uint8Array, format: WordFormat, signal?: AbortSignal): Promise<WordParserResult> {
  if (!bytes.byteLength) throw new WordDocumentError('invalid-word')
  if (bytes.byteLength > WORD_DOCUMENT_LIMITS.maxFileBytes) throw new WordDocumentError('word-too-large')
  const release = await acquireParser(signal)
  try {
    return await runParser(bytes, format, signal)
  } finally {
    release()
  }
}

async function runParser(bytes: Uint8Array, format: WordFormat, signal?: AbortSignal): Promise<WordParserResult> {
  if (signal?.aborted) throw new WordDocumentError('word-cancelled')
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./word-parser.mjs', import.meta.url), {
      workerData: { bytes, format },
      env: {},
      resourceLimits: {
        maxOldGenerationSizeMb: WORD_DOCUMENT_LIMITS.parserMemoryMb,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
      stdout: true,
      stderr: true,
    })
    worker.stdout.resume()
    worker.stderr.resume()
    let finished = false
    const finish = (error?: WordDocumentError, result?: WordParserResult) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      void worker.terminate().then(() => {
        if (error) reject(error)
        else if (result) resolve(result)
        else reject(new WordDocumentError('word-parser-unavailable'))
      }, () => {
        console.error('Word parser cleanup failed.')
        reject(new WordDocumentError('word-parser-unavailable'))
      })
    }
    const abort = () => finish(new WordDocumentError('word-cancelled'))
    const timeout = setTimeout(() => finish(new WordDocumentError('word-timeout')), WORD_DOCUMENT_LIMITS.parserTimeoutMilliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    worker.once('message', (message: unknown) => {
      const reply = wordParserReplySchema.safeParse(message)
      if (!reply.success) finish(new WordDocumentError('word-parser-unavailable'))
      else if (!reply.data.ok) finish(new WordDocumentError(reply.data.code))
      else finish(undefined, reply.data.result)
    })
    worker.once('error', (error: Error & { code?: string }) => {
      finish(new WordDocumentError(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'word-expansion-limit' : 'word-parser-unavailable'))
    })
    worker.once('exit', () => finish(new WordDocumentError('word-parser-unavailable')))
  })
}
