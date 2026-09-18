import { MAX_MARKDOWN_BYTES } from '../../src/domain/source-files'

export class MarkdownInputError extends Error {
  constructor(readonly code: 'markdown-too-large' | 'invalid-markdown', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MarkdownInputError'
  }
}

export function decodeMarkdown(bytes: Uint8Array, maxBytes = MAX_MARKDOWN_BYTES): string {
  if (bytes.byteLength > maxBytes) {
    throw new MarkdownInputError('markdown-too-large', `Markdown files may not exceed ${maxBytes / 1024 / 1024} MiB.`)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new MarkdownInputError('invalid-markdown', 'This Markdown file is not valid UTF-8. Save it as UTF-8 and import it again.', { cause })
  }
  if (!text.trim()) throw new MarkdownInputError('invalid-markdown', 'This Markdown file is empty. Choose a file containing readable text.')
  let binary = text.trimStart().startsWith('%PDF-')
  for (const character of text) {
    const code = character.codePointAt(0)!
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) {
      binary = true
      break
    }
  }
  if (binary) {
    throw new MarkdownInputError('invalid-markdown', 'This file contains binary or unsupported control characters. Upload a UTF-8 Markdown document.')
  }
  return text
}
