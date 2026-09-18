import type { WordFormat } from '../../src/domain/document-formats'
import { invalidRequest, unavailable } from '../errors'
import { parseWordFile, WordDocumentError } from './word'

export async function validateWordUpload(bytes: Uint8Array, format: WordFormat): Promise<void> {
  try {
    await parseWordFile(bytes, format)
  } catch (error) {
    if (!(error instanceof WordDocumentError)) throw error
    throw error.retryable ? unavailable(error.message) : invalidRequest(error.message)
  }
}
