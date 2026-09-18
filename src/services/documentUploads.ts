import {
  UPLOAD_FORMATS,
  WORD_DOCUMENT_LIMITS,
  uploadFormatFromContentType,
  uploadFormatFromFilename,
  type UploadFormat,
} from '../domain/document-formats'
import { isSafeUploadedFilename } from '../domain/source-files'

export function selectedUploadFormat(file: Pick<File, 'name' | 'type'>): UploadFormat | undefined {
  return uploadFormatFromFilename(file.name)
}

export function uploadFormatNames(formats: readonly UploadFormat[]): string {
  return formats.map((format) => format === 'markdown' ? 'Markdown' : format.toUpperCase()).join(', ')
}

export function uploadPickerLabel(formats: readonly UploadFormat[], separator = ' / '): string {
  return ['PDF', ...(formats.includes('markdown') ? ['Markdown'] : []),
    ...(formats.some((format) => format === 'docx' || format === 'doc') ? ['Word'] : [])].join(separator)
}

export function uploadFileByteLimit(format: UploadFormat, limits: {
  maxFileBytes?: number; maxPdfBytes?: number; maxMarkdownBytes?: number
} = {}): number {
  const formatLimit = format === 'pdf' ? limits.maxPdfBytes : format === 'markdown' ? limits.maxMarkdownBytes : undefined
  return Math.min(WORD_DOCUMENT_LIMITS.maxFileBytes, limits.maxFileBytes ?? WORD_DOCUMENT_LIMITS.maxFileBytes,
    formatLimit ?? WORD_DOCUMENT_LIMITS.maxFileBytes)
}

export function validateUploadFile(
  file: File,
  formats: readonly UploadFormat[] = ['pdf'],
  maxBytes: number = WORD_DOCUMENT_LIMITS.maxFileBytes,
): string | undefined {
  const format = selectedUploadFormat(file)
  if (!file.name.trim() || !format) return `Choose a supported file: ${uploadFormatNames(formats)}. Other formats cannot be processed.`
  if (!formats.includes(format)) return `${uploadFormatNames([format])} uploads are not enabled in this deployment. Choose ${uploadFormatNames(formats)} files.`
  if (format !== 'pdf' && !isSafeUploadedFilename(file.name, format)) return 'Choose a file with a safe filename without reserved names, path separators, or control characters.'
  const mimeFormat = uploadFormatFromContentType(file.type)
  if (format !== 'markdown' && mimeFormat && mimeFormat !== format) return 'The filename and document type disagree. Choose the original file with its correct extension.'
  if (!file.size) return 'This file is empty and could not be processed. Choose a readable document.'
  if (file.size > maxBytes) return `This file exceeds ${maxBytes / 1024 / 1024} MiB and could not be processed. Choose a smaller document.`
  return undefined
}

export function requireUploadFile(file: File, formats: readonly UploadFormat[] = UPLOAD_FORMATS): UploadFormat {
  const error = validateUploadFile(file, formats)
  if (error) throw new Error(error)
  return selectedUploadFormat(file)!
}
