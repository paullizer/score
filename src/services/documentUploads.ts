import {
  UPLOAD_FORMATS,
  WORD_DOCUMENT_LIMITS,
  uploadFormatFromContentType,
  uploadFormatFromFilename,
  type UploadFormat,
} from '../domain/document-formats'

export function selectedUploadFormat(file: Pick<File, 'name' | 'type'>): UploadFormat | undefined {
  return uploadFormatFromFilename(file.name)
}

export function uploadFormatNames(formats: readonly UploadFormat[]): string {
  return formats.map((format) => format.toUpperCase()).join(', ')
}

export function validateUploadFile(
  file: File,
  formats: readonly UploadFormat[] = ['pdf'],
  maxBytes: number = WORD_DOCUMENT_LIMITS.maxFileBytes,
): string | undefined {
  const format = selectedUploadFormat(file)
  if (!file.name.trim() || !format) return `Choose a supported file: ${uploadFormatNames(formats)}. Other formats cannot be processed.`
  if (!formats.includes(format)) return `${format.toUpperCase()} uploads are not enabled in this deployment. Choose ${uploadFormatNames(formats)} files.`
  const mimeFormat = uploadFormatFromContentType(file.type)
  if (mimeFormat && mimeFormat !== format) return 'The filename and document type disagree. Choose the original file with its correct extension.'
  if (!file.size) return 'This file is empty and could not be processed. Choose a readable document.'
  if (file.size > maxBytes) return `This file exceeds ${maxBytes / 1024 / 1024} MiB and could not be processed. Choose a smaller document.`
  return undefined
}

export function requireUploadFile(file: File, formats: readonly UploadFormat[] = UPLOAD_FORMATS): UploadFormat {
  const error = validateUploadFile(file, formats)
  if (error) throw new Error(error)
  return selectedUploadFormat(file)!
}
