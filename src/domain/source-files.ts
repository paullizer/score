import { uploadFormatFromFilename, type UploadFormat } from './document-formats'

export const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024

export type UploadedSourceKind = UploadFormat
export type { OriginalContentType, DocumentPagination } from './document-formats'
export { isOriginalContentType, originalExtension as originalFileExtension, documentPagination } from './document-formats'

export function uploadedFileKind(file: Pick<File, 'name' | 'type'>): UploadedSourceKind | undefined {
  return uploadFormatFromFilename(file.name)
}

export function isSafeUploadedFilename(value: string, kind: UploadedSourceKind): boolean {
  return value.length > 0 && value.length <= 255 && value.trim() === value && uploadFormatFromFilename(value) === kind &&
    !/[:*?"<>|/\\]/.test(value) && ![...value].some(character => {
      const code = character.charCodeAt(0)
      return code < 32 || (code >= 127 && code <= 159) || (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
    }) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
}
