export const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024

export type UploadedSourceKind = 'pdf' | 'markdown'
export type OriginalContentType = 'application/pdf' | 'text/html' | 'text/markdown'
export type DocumentPagination = 'pdf-pages' | 'html-sections' | 'markdown-sections' | 'captured-sections'

export function uploadedFileKind(file: Pick<File, 'name' | 'type'>): UploadedSourceKind | undefined {
  if (/\.(?:md|markdown)$/i.test(file.name)) return 'markdown'
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return 'pdf'
  return undefined
}

export function isSafeUploadedFilename(value: string, kind: UploadedSourceKind): boolean {
  const extension = kind === 'markdown' ? /\.(?:md|markdown)$/i : /\.pdf$/i
  return value.length > 0 && value.length <= 255 && value.trim() === value && extension.test(value) &&
    !/[:*?"<>|/\\]/.test(value) && ![...value].some(character => {
      const code = character.charCodeAt(0)
      return code < 32 || (code >= 127 && code <= 159) || (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
    }) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
}

export function isOriginalContentType(value: string): value is OriginalContentType {
  return value === 'application/pdf' || value === 'text/html' || value === 'text/markdown'
}

export function originalFileExtension(contentType: OriginalContentType): 'pdf' | 'html' | 'md' {
  switch (contentType) {
    case 'application/pdf': return 'pdf'
    case 'text/html': return 'html'
    case 'text/markdown': return 'md'
  }
}

export function documentPagination(contentType: OriginalContentType | undefined): DocumentPagination {
  switch (contentType) {
    case 'application/pdf': return 'pdf-pages'
    case 'text/html': return 'html-sections'
    case 'text/markdown': return 'markdown-sections'
    case undefined: return 'captured-sections'
  }
}
