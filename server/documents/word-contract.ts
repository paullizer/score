import { z } from 'zod'
import { WORD_DOCUMENT_LIMITS } from '../../src/domain/document-formats'

export const WORD_ERROR_MESSAGES = {
  'invalid-word': 'The Word file could not be read. Upload a genuine DOCX or Word 97-2003 DOC file, or export a readable PDF.',
  'encrypted-word': 'Password-protected Word files are not supported. Remove protection or export an unencrypted DOCX or PDF.',
  'word-too-large': 'Word files may not exceed 10 MiB.',
  'word-expansion-limit': 'The Word file exceeds the supported package or parsing limits. Simplify the document or export a readable PDF.',
  'word-timeout': 'The Word file could not be processed within the parsing limit. Save a new DOCX or export a readable PDF.',
  'word-parser-unavailable': 'The Word parser is unavailable. Please retry when the processing service is available.',
  'word-cancelled': 'Word document processing was cancelled.',
} as const

export type WordErrorCode = keyof typeof WORD_ERROR_MESSAGES

export class WordDocumentError extends Error {
  readonly retryable: boolean
  constructor(readonly code: WordErrorCode) {
    super(WORD_ERROR_MESSAGES[code])
    this.name = 'WordDocumentError'
    this.retryable = code === 'word-parser-unavailable'
  }
}

export const wordParserResultSchema = z.strictObject({
  sections: z.array(z.strictObject({
    heading: z.string().max(100),
    text: z.string().max(WORD_DOCUMENT_LIMITS.maxExpandedBytes),
  })).max(6),
  containsImages: z.boolean(),
})

export type WordParserResult = z.infer<typeof wordParserResultSchema>

export const wordParserReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: wordParserResultSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum([
    'invalid-word', 'encrypted-word', 'word-too-large', 'word-expansion-limit',
    'word-timeout', 'word-parser-unavailable', 'word-cancelled',
  ]) }),
])

export function hasOleSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
}

export function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4
}
