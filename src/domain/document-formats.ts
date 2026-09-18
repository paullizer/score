export const UPLOAD_FORMATS = ['pdf', 'markdown', 'docx', 'doc'] as const
export type UploadFormat = typeof UPLOAD_FORMATS[number]
export type WordFormat = 'docx' | 'doc'

export const UPLOAD_CONTENT_TYPES = {
  pdf: 'application/pdf',
  markdown: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
} as const

export type UploadContentType = typeof UPLOAD_CONTENT_TYPES[UploadFormat]
export type WordContentType = typeof UPLOAD_CONTENT_TYPES[WordFormat]
export type OriginalContentType = UploadContentType | 'text/html'
export type DocumentPagination = 'pdf-pages' | 'html-sections' | 'markdown-sections' | 'captured-sections'
export type OriginalFileExtension = 'pdf' | 'md' | 'docx' | 'doc' | 'html'
export const ORIGINAL_CONTENT_TYPES = [UPLOAD_CONTENT_TYPES.pdf, UPLOAD_CONTENT_TYPES.markdown, UPLOAD_CONTENT_TYPES.docx, UPLOAD_CONTENT_TYPES.doc, 'text/html'] as const
export const DOCUMENT_BLOB_CONTENT_TYPES = [...ORIGINAL_CONTENT_TYPES, 'application/json'] as const

export const WORD_DOCUMENT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
  maxEntries: 2048,
  parserTimeoutMilliseconds: 15_000,
  parserMemoryMb: 256,
  maxConcurrentParsers: 2,
  maxQueuedParsers: 16,
} as const

export interface WordImportFeatures {
  wordDocumentImports?: boolean
  markdownJobImports?: boolean
  markdownResumeImports?: boolean
}

export function supportedUploadFormats(features: WordImportFeatures | null | undefined): readonly UploadFormat[] {
  return UPLOAD_FORMATS.filter(format => format === 'pdf' ||
    (format === 'markdown' ? features?.markdownJobImports === true || features?.markdownResumeImports === true
      : features?.wordDocumentImports === true))
}

export function uploadAccept(formats: readonly UploadFormat[]): string {
  return formats.flatMap(format => format === 'markdown'
    ? ['.md', '.markdown', UPLOAD_CONTENT_TYPES.markdown] : [`.${format}`, UPLOAD_CONTENT_TYPES[format]]).join(',')
}

export function uploadFormatFromFilename(filename: string): UploadFormat | undefined {
  const separator = filename.lastIndexOf('.')
  if (separator < 0) return undefined
  const extension = filename.slice(separator + 1).toLowerCase()
  if (extension === 'md') return 'markdown'
  return UPLOAD_FORMATS.find(format => format === extension)
}

export function isUploadFormat(value: unknown): value is UploadFormat {
  return value === 'pdf' || value === 'markdown' || value === 'docx' || value === 'doc'
}

export function uploadFormatFromContentType(contentType: string): UploadFormat | undefined {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase()
  return UPLOAD_FORMATS.find(format => UPLOAD_CONTENT_TYPES[format] === mime)
}

export function isWordContentType(value: unknown): value is WordContentType {
  return value === UPLOAD_CONTENT_TYPES.docx || value === UPLOAD_CONTENT_TYPES.doc
}

export function isOriginalContentType(value: unknown): value is OriginalContentType {
  return value === 'text/html' || value === UPLOAD_CONTENT_TYPES.pdf || value === UPLOAD_CONTENT_TYPES.markdown || isWordContentType(value)
}

export function originalExtension(contentType: OriginalContentType): OriginalFileExtension {
  switch (contentType) {
    case 'application/pdf': return 'pdf'
    case 'text/markdown': return 'md'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx'
    case 'application/msword': return 'doc'
    case 'text/html': return 'html'
  }
}

export function storedDocumentContentType(name: string): OriginalContentType | 'application/json' | undefined {
  const separator = name.lastIndexOf('.')
  if (separator < 0) return undefined
  const extension = name.slice(separator + 1)
  if (extension === 'json') return 'application/json'
  if (extension === 'html') return 'text/html'
  if (extension === 'md') return UPLOAD_CONTENT_TYPES.markdown
  const format = UPLOAD_FORMATS.find(format => format === extension)
  return format === undefined ? undefined : UPLOAD_CONTENT_TYPES[format]
}

export function documentPagination(contentType: OriginalContentType | undefined): DocumentPagination {
  if (contentType === 'application/pdf') return 'pdf-pages'
  if (contentType === 'text/markdown') return 'markdown-sections'
  return contentType === 'text/html' ? 'html-sections' : 'captured-sections'
}
